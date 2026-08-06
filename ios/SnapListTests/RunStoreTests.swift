import Foundation
import XCTest
@testable import SnapList

private struct RunStoreBearerTokenProvider: BearerTokenProviding {
    let resolve: @Sendable () async throws -> String

    init(resolve: @escaping @Sendable () async throws -> String) {
        self.resolve = resolve
    }

    func bearerToken() async throws -> String {
        try await resolve()
    }
}

@MainActor
final class RunStoreTests: XCTestCase {
    func testLoaderUsesFreshBearerForTheExactRun() async {
        let run = Self.makeRun()
        let service = RecordingRunService(results: [.success(run)])
        let tokens = FreshTokenSource(tokens: ["fresh-token-1"])
        let store = RunDetailStore(
            service: service,
            tokenProvider: RunStoreBearerTokenProvider {
                try await tokens.next()
            }
        )

        await store.load(runID: run.id)

        XCTAssertEqual(store.state, .loaded(run))
        let requests = await service.requests
        XCTAssertEqual(requests, [.init(runID: run.id, bearerToken: "fresh-token-1")])
    }

    func testLoaderFailsClosedWhenTheServiceReturnsAnotherRun() async {
        let requestedID = UUID(uuidString: "31700000-0000-4000-8000-000000000020")!
        let service = RecordingRunService(results: [.success(Self.makeRun())])
        let store = RunDetailStore(
            service: service,
            tokenProvider: RunStoreBearerTokenProvider { "fresh-token" }
        )

        await store.load(runID: requestedID)

        XCTAssertEqual(store.state, .unavailable)
    }

    func testRefreshUsesAnotherFreshBearerAndReplacesOnlyServerTruth() async {
        let initial = Self.makeRun()
        let refreshed = Self.makeRun(
            status: .succeeded,
            stage: .completed,
            canOpenReview: true
        )
        let service = RecordingRunService(results: [.success(initial), .success(refreshed)])
        let tokens = FreshTokenSource(tokens: ["fresh-token-1", "fresh-token-2"])
        let store = RunDetailStore(
            service: service,
            tokenProvider: RunStoreBearerTokenProvider {
                try await tokens.next()
            }
        )

        await store.load(runID: initial.id)
        await store.refresh()

        XCTAssertEqual(store.state, .loaded(refreshed))
        let requests = await service.requests
        XCTAssertEqual(
            requests,
            [
                .init(runID: initial.id, bearerToken: "fresh-token-1"),
                .init(runID: initial.id, bearerToken: "fresh-token-2")
            ]
        )
    }

    func testRetryReusesOneIdentityAfterFailureAndKeepsPreservedRunLoaded()
        async throws {
        let safeFailure = try JSONDecoder().decode(
            RunSafeFailure.self,
            from: JSONSerialization.data(withJSONObject: [
                "reason": "This run couldn’t finish",
                "detail": "Upload didn't finish.",
                "retryable": true,
                "workPreserved": true,
            ])
        )
        let failed = Self.makeRun(
            status: .failed,
            stage: .completed,
            safeFailure: safeFailure
        )
        let retrying = Self.makeRun(status: .retrying, stage: .queued)
        let service = RetryRunService(
            initial: failed,
            retryResults: [
                .failure(RunAPIError.unavailable),
                .success(retrying),
            ]
        )
        let tokens = FreshTokenSource(tokens: [
            "fresh-load-token",
            "fresh-retry-token-1",
            "fresh-retry-token-2",
        ])
        let store = RunDetailStore(
            service: service,
            tokenProvider: RunStoreBearerTokenProvider {
                try await tokens.next()
            }
        )

        await store.load(runID: failed.id)
        await store.retry()

        XCTAssertEqual(store.state, .loaded(failed))
        XCTAssertFalse(store.isRetrying)

        await store.retry()

        XCTAssertEqual(store.state, .loaded(retrying))
        XCTAssertFalse(store.isRetrying)
        let retryRequests = await service.retryRequests
        XCTAssertEqual(retryRequests.count, 2)
        XCTAssertEqual(
            retryRequests.map(\.idempotencyKey),
            [retryRequests[0].idempotencyKey, retryRequests[0].idempotencyKey]
        )
        XCTAssertEqual(
            retryRequests.map(\.bearerToken),
            ["fresh-retry-token-1", "fresh-retry-token-2"]
        )
    }

    func testNewExactLoadCannotPublishThePreviousRun() async {
        let first = Self.makeRun()
        let second = Self.makeRun(
            id: UUID(uuidString: "31700000-0000-4000-8000-000000000021")!
        )
        let service = OverlappingRunService(first: first, second: second)
        let store = RunDetailStore(
            service: service,
            tokenProvider: RunStoreBearerTokenProvider { "fresh-token" }
        )

        let firstLoad = Task { await store.load(runID: first.id) }
        await service.waitForFirstRequest()
        await store.load(runID: second.id)
        await service.resumeFirstRequest()
        await firstLoad.value

        XCTAssertEqual(store.state, .loaded(second))
        let requests = await service.requests
        XCTAssertEqual(requests.map(\.runID), [first.id, second.id])
    }

    func testLateSuccessfulRetryCannotOverwriteAnotherOpenedRun() async throws {
        let state = try await stateAfterLateRetry(
            retryResult: .success(
                Self.makeRun(status: .retrying, stage: .queued)
            )
        )

        XCTAssertEqual(state, .loaded(Self.makeRun(id: Self.openedRunID)))
    }

    func testLateFailedRetryCannotRepublishThePreviousRun() async throws {
        let state = try await stateAfterLateRetry(
            retryResult: .failure(RunAPIError.unavailable)
        )

        XCTAssertEqual(state, .loaded(Self.makeRun(id: Self.openedRunID)))
    }

    private func stateAfterLateRetry(
        retryResult: Result<DurableRun, Error>
    ) async throws -> RunDetailLoadState {
        let failed = Self.makeRun(
            status: .failed,
            stage: .completed,
            safeFailure: try Self.makeRetryableFailure()
        )
        let opened = Self.makeRun(id: Self.openedRunID)
        let service = LateRetryRunService(
            failed: failed,
            opened: opened,
            retryResult: retryResult
        )
        let store = RunDetailStore(
            service: service,
            tokenProvider: RunStoreBearerTokenProvider { "fresh-token" }
        )

        await store.load(runID: failed.id)
        let lateRetry = Task { await store.retry() }
        await service.waitForRetryRequest()
        await store.load(runID: opened.id)
        await service.resumeRetryRequest()
        await lateRetry.value

        let retryRequests = await service.retryRequests
        XCTAssertEqual(retryRequests, [failed.id])
        return store.state
    }

    func testReadyGuestRunPersistsLocallyAssembledClaimAuthority()
        async throws {
        let review = try Self.makeReview()
        let run = Self.makeRun(
            status: .succeeded,
            stage: .completed,
            canOpenReview: true,
            listingID: review.binding.listingID,
            review: review
        )
        let credential = GuestRecoveryCredential(
            recoveryID: UUID(
                uuidString: "63860000-0000-4000-8000-000000000001"
            )!,
            recoveryToken: "raw-token-only-in-keychain",
            recoveryTokenHash: String(repeating: "a", count: 64),
            itemID: review.binding.itemID,
            runID: review.binding.runID,
            photoIdentity: GuestPhotoIdentity(
                kind: "content_sha256_set_v1",
                fingerprint: String(repeating: "b", count: 64)
            )
        )
        let credentials = RunStoreGuestRecoveryCredentials(
            credential: credential
        )
        let authorities = RunStoreGuestClaimAuthorities()
        let funnelAnalytics = FunnelAnalyticsEventSinkSpy()
        let store = RunDetailStore(
            service: RecordingRunService(results: [.success(run), .success(run)]),
            tokenProvider: RunStoreBearerTokenProvider { "guestcap_token" },
            guestRecoveryCredentials: credentials,
            guestClaimAuthorities: authorities,
            now: {
                ISO8601DateFormatter.snapListDate(
                    from: "2026-08-04T13:00:00.000Z"
                )!
            },
            funnelAnalytics: funnelAnalytics
        )

        await store.load(runID: run.id)
        await store.refresh()

        XCTAssertEqual(store.state, .loaded(run))
        XCTAssertEqual(funnelAnalytics.events, [.listingReadyToReview])
        let saved = await authorities.savedAuthority(
            listingID: review.binding.listingID
        )
        XCTAssertEqual(
            saved,
            GuestClaimAuthority(
                recoveryID: credential.recoveryID,
                recoveryToken: credential.recoveryToken,
                itemID: review.binding.itemID,
                runID: review.binding.runID,
                draftID: review.binding.listingID,
                reviewRevision: review.binding.reviewRevision,
                photoIdentity: credential.photoIdentity!
            )
        )
        let recordedExpiry = await credentials.recordedExpiry(
            recoveryID: credential.recoveryID
        )
        XCTAssertEqual(
            recordedExpiry,
            ISO8601DateFormatter.snapListDate(
                from: run.timestamps.completedAt!
            )!.addingTimeInterval(24 * 60 * 60)
        )
    }

    func testClaimedRunLoadedWithClerkPurgesAndCannotRecreateAuthority()
        async throws {
        let review = try Self.makeReview()
        let run = Self.makeRun(
            status: .succeeded,
            stage: .completed,
            canOpenReview: true,
            listingID: review.binding.listingID,
            review: review
        )
        let credential = GuestRecoveryCredential(
            recoveryID: UUID(
                uuidString: "63860000-0000-4000-8000-000000000011"
            )!,
            recoveryToken: "raw-token-only-in-keychain",
            recoveryTokenHash: String(repeating: "d", count: 64),
            itemID: review.binding.itemID,
            runID: review.binding.runID,
            photoIdentity: GuestPhotoIdentity(
                kind: "content_sha256_set_v1",
                fingerprint: String(repeating: "e", count: 64)
            )
        )
        let credentials = RunStoreGuestRecoveryCredentials(
            credential: credential
        )
        let authorities = RunStoreGuestClaimAuthorities()
        let store = RunDetailStore(
            service: RecordingRunService(results: [.success(run)]),
            tokenProvider: RunStoreBearerTokenProvider { "clerk-session-token" },
            guestRecoveryCredentials: credentials,
            guestClaimAuthorities: authorities
        )

        await store.load(runID: run.id)

        XCTAssertEqual(store.state, .loaded(run))
        let saved = await authorities.savedAuthority(
            listingID: review.binding.listingID
        )
        let purgedCredentials = await credentials.purgedRecoveryIDs()
        let purgedAuthorities = await authorities.purgedRecoveryIDs()
        XCTAssertNil(saved)
        XCTAssertEqual(purgedCredentials, [credential.recoveryID])
        XCTAssertEqual(purgedAuthorities, [credential.recoveryID])
    }

    func testTerminalGuestFailurePurgesUnusedRecoveryAuthority()
        async throws {
        let run = Self.makeRun(status: .failed, stage: .completed)
        let credential = GuestRecoveryCredential(
            recoveryID: UUID(
                uuidString: "63860000-0000-4000-8000-000000000012"
            )!,
            recoveryToken: "raw-token-only-in-keychain",
            recoveryTokenHash: String(repeating: "d", count: 64),
            itemID: run.itemID,
            runID: run.id,
            photoIdentity: GuestPhotoIdentity(
                kind: "content_sha256_set_v1",
                fingerprint: String(repeating: "e", count: 64)
            )
        )
        let credentials = RunStoreGuestRecoveryCredentials(
            credential: credential
        )
        let authorities = RunStoreGuestClaimAuthorities()
        let store = RunDetailStore(
            service: RecordingRunService(results: [.success(run)]),
            tokenProvider: RunStoreBearerTokenProvider {
                "guestcap_\(String(repeating: "A", count: 43))"
            },
            guestRecoveryCredentials: credentials,
            guestClaimAuthorities: authorities
        )

        await store.load(runID: run.id)

        XCTAssertEqual(store.state, .loaded(run))
        let purgedCredentials = await credentials.purgedRecoveryIDs()
        let purgedAuthorities = await authorities.purgedRecoveryIDs()
        XCTAssertEqual(purgedCredentials, [credential.recoveryID])
        XCTAssertEqual(purgedAuthorities, [credential.recoveryID])
    }

    func testFailedRunDetailDisclosesFullSellerSafeFailure() throws {
        let detail = String(String(repeating: "Retry detail remains visible. ", count: 18).prefix(500))
        let safeFailure = try JSONDecoder().decode(
            RunSafeFailure.self,
            from: JSONSerialization.data(withJSONObject: [
                "reason": "This run couldn’t finish",
                "detail": detail,
                "retryable": true,
                "workPreserved": true,
            ])
        )
        let run = Self.makeRun(
            status: .failed,
            stage: .pricing,
            safeFailure: safeFailure
        )

        XCTAssertEqual(run.sellerFacingDetail, detail)
    }

    func testAcceptedRunUsesAcceptedLanguageWithoutQueueTerms() {
        let run = Self.makeRun(status: .queued, stage: .queued)

        XCTAssertEqual(run.status.sellerFacingLabel, "Accepted")
        XCTAssertEqual(run.sellerFacingDetail, "Accepted")
    }

    private static let openedRunID = UUID(
        uuidString: "31700000-0000-4000-8000-000000000022"
    )!

    private static func makeRetryableFailure() throws -> RunSafeFailure {
        try JSONDecoder().decode(
            RunSafeFailure.self,
            from: JSONSerialization.data(withJSONObject: [
                "reason": "This run couldn’t finish",
                "detail": "Upload didn't finish.",
                "retryable": true,
                "workPreserved": true,
            ])
        )
    }

    private static func makeRun(
        id: UUID = UUID(uuidString: "31700000-0000-4000-8000-000000000010")!,
        status: DurableRunStatus = .running,
        stage: DurableRunStage = .generating,
        safeFailure: RunSafeFailure? = nil,
        canOpenReview: Bool = false,
        listingID: UUID? = nil,
        review: ListingReviewResult? = nil
    ) -> DurableRun {
        DurableRun(
            id: id,
            itemID: UUID(uuidString: "31700000-0000-4000-8000-000000000011")!,
            listingID: listingID,
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
                completedAt: status == .succeeded
                    ? "2026-08-04T12:00:00.000Z"
                    : nil,
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

    private static func makeReview() throws -> ListingReviewResult {
        try JSONDecoder().decode(
            ListingReviewResult.self,
            from: Data(
                """
                {
                  "schemaVersion":1,
                  "binding":{
                    "runId":"31700000-0000-4000-8000-000000000010",
                    "itemId":"31700000-0000-4000-8000-000000000011",
                    "listingId":"63860000-0000-4000-8000-000000000002",
                    "reviewContentRevision":"63860000-0000-4000-8000-000000000003",
                    "reviewRevision":"63860000-0000-4000-8000-000000000004"
                  },
                  "photos":[{"ordinal":0,"url":"https://snaplist.test/photo.jpg"}],
                  "identity":{"label":"Sony headphones","confident":true},
                  "listing":{
                    "title":"Sony headphones",
                    "description":"Used headphones.",
                    "condition":"good",
                    "specifics":[]
                  },
                  "pricing":{
                    "suggestedPrice":50,
                    "range":{"minimum":40,"maximum":60},
                    "confidence":0.5,
                    "sellerPriceOverride":null,
                    "effectivePrice":50
                  },
                  "evidenceAsOf":"2026-08-04T12:00:00.000Z",
                  "verifiedSoldMatches":[],
                  "startingPriceCopy":"Starting price estimate",
                  "soldEvidenceCopy":"No verified sold matches found."
                }
                """.utf8
            )
        )
    }
}

private actor RunStoreGuestRecoveryCredentials:
    GuestRecoveryCredentialStoring {
    private let storedCredential: GuestRecoveryCredential
    private var expiries: [UUID: Date] = [:]
    private var purged: [UUID] = []

    init(credential: GuestRecoveryCredential) {
        storedCredential = credential
    }

    func mintCredential() throws -> GuestRecoverySubmissionIdentity {
        throw CancellationError()
    }

    func contains(_ identity: GuestRecoverySubmissionIdentity) -> Bool {
        identity.recoveryID == storedCredential.recoveryID
    }

    func bind(
        _ identity: GuestRecoverySubmissionIdentity,
        itemID: UUID,
        runID: UUID,
        photoIdentity: GuestPhotoIdentity
    ) throws {
        throw CancellationError()
    }

    func credential(runID: UUID) -> GuestRecoveryCredential? {
        storedCredential.runID == runID ? storedCredential : nil
    }

    func credential(recoveryID: UUID) -> GuestRecoveryCredential? {
        storedCredential.recoveryID == recoveryID ? storedCredential : nil
    }

    func setExpiry(recoveryID: UUID, expiresAt: Date) {
        expiries[recoveryID] = expiresAt
    }

    func purge(recoveryID: UUID) {
        purged.append(recoveryID)
    }

    func recordedExpiry(recoveryID: UUID) -> Date? {
        expiries[recoveryID]
    }

    func purgedRecoveryIDs() -> [UUID] { purged }
}

private actor RunStoreGuestClaimAuthorities: GuestClaimAuthorityStoring {
    private var authorities: [UUID: GuestClaimAuthority] = [:]
    private var purged: [UUID] = []

    func authority(listingID: UUID) -> GuestClaimAuthority? {
        authorities[listingID]
    }

    func save(_ authority: GuestClaimAuthority, listingID: UUID) {
        authorities[listingID] = authority
    }

    func purge(recoveryID: UUID) {
        purged.append(recoveryID)
        authorities = authorities.filter {
            $0.value.recoveryID != recoveryID
        }
    }

    func savedAuthority(listingID: UUID) -> GuestClaimAuthority? {
        authorities[listingID]
    }

    func purgedRecoveryIDs() -> [UUID] { purged }
}

private extension ISO8601DateFormatter {
    static func snapListDate(from value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: value)
    }
}

private actor OverlappingRunService: RunServing {
    private let first: DurableRun
    private let second: DurableRun
    private var firstRequestStarted = false
    private var firstRequestWaiters: [CheckedContinuation<Void, Never>] = []
    private var firstResponse: CheckedContinuation<Void, Never>?
    private(set) var requests: [RecordingRunService.Request] = []

    init(first: DurableRun, second: DurableRun) {
        self.first = first
        self.second = second
    }

    func waitForFirstRequest() async {
        guard !firstRequestStarted else { return }
        await withCheckedContinuation { firstRequestWaiters.append($0) }
    }

    func resumeFirstRequest() {
        firstResponse?.resume()
        firstResponse = nil
    }

    func fetchRun(id: UUID, bearerToken: String) async throws -> DurableRun {
        requests.append(.init(runID: id, bearerToken: bearerToken))
        guard id == first.id else { return second }

        firstRequestStarted = true
        let waiters = firstRequestWaiters
        firstRequestWaiters.removeAll()
        waiters.forEach { $0.resume() }
        await withCheckedContinuation { firstResponse = $0 }
        return first
    }
}

private actor FreshTokenSource {
    private var tokens: [String]

    init(tokens: [String]) {
        self.tokens = tokens
    }

    func next() throws -> String {
        guard !tokens.isEmpty else { throw RunAPIError.authenticationRequired }
        return tokens.removeFirst()
    }
}

private actor RecordingRunService: RunServing {
    struct Request: Equatable {
        let runID: UUID
        let bearerToken: String
    }

    private var results: [Result<DurableRun, Error>]
    private(set) var requests: [Request] = []

    init(results: [Result<DurableRun, Error>]) {
        self.results = results
    }

    func fetchRun(id: UUID, bearerToken: String) async throws -> DurableRun {
        requests.append(.init(runID: id, bearerToken: bearerToken))
        guard !results.isEmpty else { throw RunAPIError.unavailable }
        return try results.removeFirst().get()
    }
}

private actor LateRetryRunService: RunServing {
    private let failed: DurableRun
    private let opened: DurableRun
    private let retryResult: Result<DurableRun, Error>
    private var retryRequested = false
    private var retryRequestWaiters: [CheckedContinuation<Void, Never>] = []
    private var retryResponse: CheckedContinuation<Void, Never>?
    private(set) var retryRequests: [UUID] = []

    init(
        failed: DurableRun,
        opened: DurableRun,
        retryResult: Result<DurableRun, Error>
    ) {
        self.failed = failed
        self.opened = opened
        self.retryResult = retryResult
    }

    func waitForRetryRequest() async {
        guard !retryRequested else { return }
        await withCheckedContinuation { retryRequestWaiters.append($0) }
    }

    func resumeRetryRequest() {
        retryResponse?.resume()
        retryResponse = nil
    }

    func fetchRun(id: UUID, bearerToken: String) async throws -> DurableRun {
        if id == failed.id { return failed }
        guard id == opened.id else { throw RunAPIError.invalidResponse }
        return opened
    }

    func retryRun(
        id: UUID,
        idempotencyKey: UUID,
        bearerToken: String
    ) async throws -> DurableRun {
        retryRequests.append(id)
        retryRequested = true
        let waiters = retryRequestWaiters
        retryRequestWaiters.removeAll()
        waiters.forEach { $0.resume() }
        await withCheckedContinuation { retryResponse = $0 }
        return try retryResult.get()
    }
}

private actor RetryRunService: RunServing {
    struct RetryRequest: Equatable {
        let runID: UUID
        let idempotencyKey: UUID
        let bearerToken: String
    }

    private let initial: DurableRun
    private var retryResults: [Result<DurableRun, Error>]
    private(set) var retryRequests: [RetryRequest] = []

    init(
        initial: DurableRun,
        retryResults: [Result<DurableRun, Error>]
    ) {
        self.initial = initial
        self.retryResults = retryResults
    }

    func fetchRun(id: UUID, bearerToken: String) async throws -> DurableRun {
        guard id == initial.id else { throw RunAPIError.invalidResponse }
        return initial
    }

    func retryRun(
        id: UUID,
        idempotencyKey: UUID,
        bearerToken: String
    ) async throws -> DurableRun {
        retryRequests.append(
            RetryRequest(
                runID: id,
                idempotencyKey: idempotencyKey,
                bearerToken: bearerToken
            )
        )
        guard !retryResults.isEmpty else { throw RunAPIError.unavailable }
        return try retryResults.removeFirst().get()
    }
}
