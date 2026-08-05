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
                if !token.hasPrefix("guestcap_") {
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
            let service: any RunServing = switch configuration.runDetailFixture {
            case .loaded:
                FixtureRunService(runs: [.loadedDetail])
            case .refresh:
                FixtureRunService(runs: [.loadedDetail, .refreshedDetail])
            case .failed:
                FixtureRunService(runs: [.failedDetail])
            case .canceled:
                FixtureRunService(runs: [.canceledDetail])
            case .completed:
                FixtureRunService(runs: [.completedDetail])
            case .reviewable:
                FixtureRunService(
                    runs: [
                        .reviewableDetail(
                            review:
                                (configuration.listingReviewFixture ?? .loaded)
                                    .review
                        )
                    ]
                )
            case .unavailable, .none:
                UnavailableRunService()
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

    init(runs: [DurableRun]) {
        self.runs = runs
    }

    func fetchRun(id: UUID, bearerToken: String) async throws -> DurableRun {
        guard let run = runs.first else { throw RunAPIError.unavailable }
        guard id == run.id else { throw RunAPIError.unavailable }
        if runs.count > 1 {
            runs.removeFirst()
        }
        return run
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

    static func fixture(
        status: DurableRunStatus,
        stage: DurableRunStage,
        safeFailure: RunSafeFailure? = nil,
        canOpenReview: Bool = false,
        review: ListingReviewResult? = nil
    ) -> DurableRun {
        DurableRun(
            id: UUID(uuidString: "20800000-0000-4000-8000-000000000020")!,
            itemID: UUID(uuidString: "20800000-0000-4000-8000-000000000021")!,
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
            item: RunItemTruth(title: "Canon AE-1 film camera", photoCount: 3),
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
