import Foundation
import Observation

enum RunDetailLoadState: Equatable, Sendable {
    case idle
    case loading
    case loaded(DurableRun)
    case unavailable
}

@MainActor
@Observable
final class RunDetailStore {
    private(set) var state: RunDetailLoadState = .idle
    private(set) var isRetrying = false

    private let service: any RunServing
    private let tokenProvider: any BearerTokenProviding
    private let guestRecoveryCredentials:
        any GuestRecoveryCredentialStoring
    private let guestClaimAuthorities:
        any GuestClaimAuthorityStoring
    private let now: @Sendable () -> Date
    private let funnelAnalytics: any FunnelAnalyticsEventSinking
    private var requestedRunID: UUID?
    private var requestGeneration = 0
    private var emittedListingReadyRunIDs: Set<UUID> = []
    private var retryIdempotencyKeys: [UUID: UUID] = [:]
    private var processingRetryRunIDs: Set<UUID> = []

    init(
        service: any RunServing,
        tokenProvider: any BearerTokenProviding,
        guestRecoveryCredentials:
            any GuestRecoveryCredentialStoring =
                KeychainGuestRecoveryCredentialStore(),
        guestClaimAuthorities:
            any GuestClaimAuthorityStoring =
                KeychainGuestClaimAuthorityStore(),
        now: @escaping @Sendable () -> Date = { Date() },
        funnelAnalytics: any FunnelAnalyticsEventSinking = NoOpFunnelAnalyticsEventSink()
    ) {
        self.service = service
        self.tokenProvider = tokenProvider
        self.guestRecoveryCredentials = guestRecoveryCredentials
        self.guestClaimAuthorities = guestClaimAuthorities
        self.now = now
        self.funnelAnalytics = funnelAnalytics
    }

    func load(runID: UUID) async {
        requestedRunID = runID
        await startFetch(runID: runID)
    }

    func refresh() async {
        guard let requestedRunID else { return }
        await startFetch(runID: requestedRunID)
    }

    /// Resolves only the server-authorized review binding for a Processing
    /// action. Unlike `load`, this deliberately does not change the Run Detail
    /// presentation state: Processing must not navigate through `.run(runID)`
    /// just to determine whether it can open Listing Review.
    func processingReview(for runID: UUID) async -> ListingReviewResult? {
        guard let route = await processingReviewRoute(for: runID) else {
            return nil
        }
        switch route {
        case .guestClaim(let context):
            return context.review
        case .listingReview(let review):
            return review
        }
    }

    /// Selects the exact Processing Review route without adopting Run Detail.
    /// A signed-out guest must preserve the durable recovery tuple and claim it
    /// before the principal-bound Listing Review store is allowed to open.
    func processingReviewRoute(
        for runID: UUID
    ) async -> ProcessingReviewRoute? {
        do {
            let token = try await tokenProvider.bearerToken()
            let run = try await service.fetchRun(id: runID, bearerToken: token)
            guard run.id == runID,
                  run.legalActions.canOpenReview,
                  let review = run.review,
                  review.binding.runID == runID,
                  review.binding.itemID == run.itemID,
                  let listingID = run.listingID,
                  review.binding.listingID == listingID else {
                return nil
            }
            guard token.hasPrefix(GuestCapabilityToken.prefix) else {
                return .listingReview(review)
            }
            guard run.status == .succeeded,
                  run.stage == .completed,
                  let completedAt = run.timestamps.completedAt,
                  let completed = Self.date(from: completedAt),
                  let credential = try await guestRecoveryCredentials
                    .credential(runID: runID) else {
                return nil
            }
            let expiresAt = completed.addingTimeInterval(24 * 60 * 60)
            guard expiresAt > now() else {
                try await guestClaimAuthorities.purge(
                    recoveryID: credential.recoveryID
                )
                try await guestRecoveryCredentials.purge(
                    recoveryID: credential.recoveryID
                )
                return nil
            }
            guard let authority = GuestClaimAuthorityAssembler.assemble(
                credential: credential,
                binding: review.binding
            ) else {
                try await guestClaimAuthorities.purge(
                    recoveryID: credential.recoveryID
                )
                return nil
            }
            var expiringCredential = credential
            expiringCredential.expiresAt = expiresAt
            guard let projection = GuestClaimListingProjection.project(
                snapshot: review,
                draft: ListingReviewDraft(snapshot: review),
                isDirty: false,
                authority: authority,
                credential: expiringCredential,
                now: now()
            ) else {
                try await guestClaimAuthorities.purge(
                    recoveryID: credential.recoveryID
                )
                return nil
            }
            try await guestRecoveryCredentials.setExpiry(
                recoveryID: credential.recoveryID,
                expiresAt: expiresAt
            )
            try await guestClaimAuthorities.save(
                authority,
                listingID: listingID
            )
            return .guestClaim(
                ProcessingGuestClaimContext(
                    authority: authority,
                    projection: projection,
                    review: review
                )
            )
        } catch {
            return nil
        }
    }

    /// Retries one Processing run without opening or changing Run Detail.
    /// The response is deliberately returned rather than stored: only the
    /// Trophy Wall's existing exact card may decide whether it can project the
    /// server-authorized state.
    func processingRetry(for runID: UUID) async -> DurableRun? {
        guard processingRetryRunIDs.insert(runID).inserted else {
            return nil
        }
        defer { processingRetryRunIDs.remove(runID) }

        let key = retryIdempotencyKeys[runID] ?? UUID()
        retryIdempotencyKeys[runID] = key
        do {
            let token = try await tokenProvider.bearerToken()
            let retried = try await service.retryRun(
                id: runID,
                idempotencyKey: key,
                bearerToken: token
            )
            guard retried.id == runID,
                  retried.schemaVersion == 1,
                  Self.isCanonicalProcessingRetry(retried) else {
                return nil
            }
            retryIdempotencyKeys[runID] = nil
            return retried
        } catch {
            return nil
        }
    }

    func retry() async {
        guard !isRetrying,
              case .loaded(let run) = state,
              run.legalActions.canRetry else { return }
        isRetrying = true
        defer { isRetrying = false }
        let generation = requestGeneration
        let key = retryIdempotencyKeys[run.id] ?? UUID()
        retryIdempotencyKeys[run.id] = key
        do {
            let token = try await tokenProvider.bearerToken()
            let retried = try await service.retryRun(
                id: run.id,
                idempotencyKey: key,
                bearerToken: token
            )
            guard retried.id == run.id else {
                throw RunAPIError.invalidResponse
            }
            retryIdempotencyKeys[run.id] = nil
            guard generation == requestGeneration,
                  requestedRunID == run.id else { return }
            state = .loaded(retried)
        } catch {
            guard generation == requestGeneration,
                  requestedRunID == run.id else { return }
            state = .loaded(run)
        }
    }

    private static func isCanonicalProcessingRetry(_ run: DurableRun) -> Bool {
        switch (run.status, run.stage) {
        case (.queued, .queued),
             (.retrying, .queued),
             (.retrying, .identifying),
             (.retrying, .generating),
             (.retrying, .pricing),
             (.retrying, .persisting):
            true
        default:
            false
        }
    }

    private func startFetch(runID: UUID) async {
        requestGeneration += 1
        let generation = requestGeneration
        state = .loading
        do {
            let token = try await tokenProvider.bearerToken()
            let run = try await service.fetchRun(id: runID, bearerToken: token)
            guard generation == requestGeneration, requestedRunID == runID else { return }
            guard run.id == runID else { throw RunAPIError.invalidResponse }
            if let credential = try await guestRecoveryCredentials
                .credential(runID: runID) {
                if !token.hasPrefix(GuestCapabilityToken.prefix) {
                    try await guestClaimAuthorities.purge(
                        recoveryID: credential.recoveryID
                    )
                    try await guestRecoveryCredentials.purge(
                        recoveryID: credential.recoveryID
                    )
                } else if run.status == .failed || run.status == .canceled {
                    try await guestClaimAuthorities.purge(
                        recoveryID: credential.recoveryID
                    )
                    try await guestRecoveryCredentials.purge(
                        recoveryID: credential.recoveryID
                    )
                } else if run.status == .succeeded {
                    guard let completedAt = run.timestamps.completedAt,
                          let completed = Self.date(from: completedAt) else {
                        throw RunAPIError.invalidResponse
                    }
                    let expiresAt = completed.addingTimeInterval(24 * 60 * 60)
                    if expiresAt <= now() {
                        try await guestClaimAuthorities.purge(
                            recoveryID: credential.recoveryID
                        )
                        try await guestRecoveryCredentials.purge(
                            recoveryID: credential.recoveryID
                        )
                    } else {
                        try await guestRecoveryCredentials.setExpiry(
                            recoveryID: credential.recoveryID,
                            expiresAt: expiresAt
                        )
                        guard let binding = run.review?.binding else {
                            throw RunAPIError.invalidResponse
                        }
                        guard let authority = GuestClaimAuthorityAssembler
                            .assemble(
                                credential: credential,
                                binding: binding
                            ) else {
                            throw RunAPIError.invalidResponse
                        }
                        try await guestClaimAuthorities.save(
                            authority,
                            listingID: binding.listingID
                        )
                    }
                }
            }
            state = .loaded(run)
            if run.legalActions.canOpenReview,
               run.review != nil,
               emittedListingReadyRunIDs.insert(run.id).inserted {
                funnelAnalytics.record(.listingReadyToReview, eventID: run.id)
            }
        } catch is CancellationError {
            guard generation == requestGeneration else { return }
            state = .idle
        } catch {
            guard generation == requestGeneration else { return }
            state = .unavailable
        }
    }

    private static func date(from value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [
            .withInternetDateTime,
            .withFractionalSeconds,
        ]
        if let parsed = fractional.date(from: value) { return parsed }
        let wholeSeconds = ISO8601DateFormatter()
        wholeSeconds.formatOptions = [.withInternetDateTime]
        return wholeSeconds.date(from: value)
    }
}

@MainActor
enum RunDetailStoreFactory {
    static func make(
        configuration: LaunchConfiguration,
        apiOrigin: URL?,
        tokenProvider: any BearerTokenProviding,
        session: URLSession,
        funnelAnalytics: any FunnelAnalyticsEventSinking = NoOpFunnelAnalyticsEventSink()
    ) -> RunDetailStore {
#if DEBUG
        if configuration.usesZeroNetworkFixtures {
            let service: any RunServing
            switch configuration.runDetailFixture {
            case .loaded:
                service = FixtureRunService(runs: [.loadedDetail])
            case .refresh:
                service = FixtureRunService(
                    runs: [.loadedDetail, .refreshedDetail]
                )
            case .failed:
                service = FixtureRunService(runs: [.failedDetail])
            case .canceled:
                service = FixtureRunService(runs: [.canceledDetail])
            case .completed:
                service = FixtureRunService(runs: [.completedDetail])
            case .reviewable:
                let review = configuration.fixture == .trophyProcessing
                    ? ListingReviewLaunchFixture.processingReview()
                    : (configuration.listingReviewFixture ?? .loaded).review
                let run = configuration.fixture == .trophyProcessing
                    ? DurableRun.processingReviewableDetail(review: review)
                    : DurableRun.reviewableDetail(review: review)
                service = FixtureRunService(
                    runs: [run]
                )
            case .unavailable:
                service = UnavailableRunService()
            case .none:
                if configuration.fixture == .trophyProcessing {
                    service = FixtureRunService(
                        runs: [.processingRetryFailureDetail],
                        retryResults: [.success(.processingRetryAccepted)]
                    )
                } else {
                    service = UnavailableRunService()
                }
            }
            return RunDetailStore(
                service: service,
                tokenProvider: FixtureRunBearerTokenProvider()
            )
        }
#endif
        let service: any RunServing = apiOrigin.map {
            RunAPIClient(baseURL: $0, session: session)
        } ?? UnavailableRunService()
        return RunDetailStore(
            service: service,
            tokenProvider: tokenProvider,
            funnelAnalytics: funnelAnalytics
        )
    }
}

#if DEBUG
private struct FixtureRunBearerTokenProvider: BearerTokenProviding {
    func bearerToken() async throws -> String {
        "fixture-bearer"
    }
}

private actor FixtureRunService: RunServing {
    private var runs: [DurableRun]
    private var retryResults: [Result<DurableRun, Error>]

    init(
        runs: [DurableRun],
        retryResults: [Result<DurableRun, Error>] = []
    ) {
        self.runs = runs
        self.retryResults = retryResults
    }

    func fetchRun(id: UUID, bearerToken: String) async throws -> DurableRun {
        guard let run = runs.first else { throw RunAPIError.unavailable }
        guard id == run.id else { throw RunAPIError.unavailable }
        if runs.count > 1 {
            runs.removeFirst()
        }
        return run
    }

    func retryRun(
        id: UUID,
        idempotencyKey: UUID,
        bearerToken: String
    ) async throws -> DurableRun {
        guard runs.contains(where: { $0.id == id }),
              !retryResults.isEmpty else {
            throw RunAPIError.unavailable
        }
        return try retryResults.removeFirst().get()
    }
}

private extension DurableRun {
    static let loadedDetail = fixture(status: .running, stage: .pricing)
    static let refreshedDetail = fixture(status: .running, stage: .generating)
    static let failedDetail = fixture(
        status: .failed,
        stage: .pricing,
        safeFailure: .maximumLengthFixture
    )
    static let canceledDetail = fixture(status: .canceled, stage: .generating)
    static let completedDetail = fixture(status: .succeeded, stage: .completed)
    static func reviewableDetail(
        review: ListingReviewResult
    ) -> DurableRun {
        fixture(
            status: .succeeded,
            stage: .completed,
            canOpenReview: true,
            review: review
        )
    }

    static func processingReviewableDetail(
        review: ListingReviewResult
    ) -> DurableRun {
        fixture(
            id: UUID(
                uuidString: "37500000-0000-4000-8000-000000000003"
            )!,
            itemID: UUID(
                uuidString: "37500000-0000-4000-8000-000000000009"
            )!,
            itemName: "Vintage Pyrex bowl set",
            status: .succeeded,
            stage: .completed,
            canOpenReview: true,
            review: review
        )
    }

    static let processingRetryFailureDetail = fixture(
        id: UUID(
            uuidString: "37500000-0000-4000-8000-000000000004"
        )!,
        itemID: UUID(
            uuidString: "37500000-0000-4000-8000-000000000010"
        )!,
        itemName: "Canon AE-1 film camera",
        status: .failed,
        stage: .completed,
        safeFailure: .processingRetryFixture
    )

    static let processingRetryAccepted = fixture(
        id: UUID(
            uuidString: "37500000-0000-4000-8000-000000000004"
        )!,
        itemID: UUID(
            uuidString: "37500000-0000-4000-8000-000000000010"
        )!,
        itemName: "Canon AE-1 film camera",
        status: .retrying,
        stage: .queued
    )

    static func fixture(
        id: UUID = UUID(
            uuidString: "20800000-0000-4000-8000-000000000020"
        )!,
        itemID: UUID = UUID(
            uuidString: "20800000-0000-4000-8000-000000000021"
        )!,
        itemName: String = "Canon AE-1 film camera",
        status: DurableRunStatus,
        stage: DurableRunStage,
        safeFailure: RunSafeFailure? = nil,
        canOpenReview: Bool = false,
        review: ListingReviewResult? = nil
    ) -> DurableRun {
        DurableRun(
            id: id,
            itemID: itemID,
            listingID: review?.binding.listingID,
            status: status,
            stage: stage,
            attemptCount: 1,
            maxAttempts: 3,
            schemaVersion: 1,
            timestamps: RunTimestamps(
                createdAt: "2026-07-20T12:00:00.000Z",
                updatedAt: "2026-07-20T12:01:00.000Z",
                enqueuedAt: "2026-07-20T12:00:01.000Z",
                startedAt: "2026-07-20T12:00:02.000Z",
                lastAttemptedAt: "2026-07-20T12:00:02.000Z",
                nextAttemptAt: nil,
                completedAt: nil,
                retentionCleanedAt: nil
            ),
            item: RunItemTruth(title: itemName, photoCount: 3),
            requiredInput: nil,
            terminalOutcome: nil,
            safeFailure: safeFailure,
            allowance: .reserved,
            legalActions: RunActionTruth(
                canRetry: safeFailure?.retryable ?? false,
                canCancel: false,
                canOpenReview: canOpenReview,
                canStartNewCapture: false
            ),
            lastMeaningfulUpdateAt: "2026-07-20T12:01:00.000Z",
            retentionCleanedAt: nil,
            review: review
        )
    }
}

private extension RunSafeFailure {
    static let processingRetryFixture: RunSafeFailure = {
        do {
            let data = try JSONSerialization.data(withJSONObject: [
                "reason": "This run couldn’t finish",
                "detail": "The last attempt did not finish.",
                "retryable": true,
                "workPreserved": true,
            ])
            return try JSONDecoder().decode(RunSafeFailure.self, from: data)
        } catch {
            preconditionFailure("Invalid processing retry fixture: \(error)")
        }
    }()

    static let maximumLengthFixture: RunSafeFailure = {
        let ending = "All retry guidance is shown."
        let repeatedGuidance = String(
            repeating: "Keep your photos and retry from this saved item after checking your connection. ",
            count: 10
        )
        let detail = String(repeatedGuidance.prefix(500 - ending.count)) + ending
        precondition(detail.count == 500)

        do {
            let data = try JSONSerialization.data(withJSONObject: [
                "reason": "This run couldn’t finish",
                "detail": detail,
                "retryable": true,
                "workPreserved": true,
            ])
            return try JSONDecoder().decode(RunSafeFailure.self, from: data)
        } catch {
            preconditionFailure("Invalid maximum-length safe-failure fixture: \(error)")
        }
    }()
}
#endif
