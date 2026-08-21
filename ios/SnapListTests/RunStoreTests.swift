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
    func testProcessingReviewRequiresExactServerRunAndBinding() async throws {
        let requestedRunID = UUID(
            uuidString: "31700000-0000-4000-8000-000000000030"
        )!
        let itemID = UUID(
            uuidString: "31700000-0000-4000-8000-000000000031"
        )!
        let listingID = UUID(
            uuidString: "31700000-0000-4000-8000-000000000032"
        )!
        let exactReview = try Self.makeReview(
            runID: requestedRunID,
            itemID: itemID,
            listingID: listingID
        )
        let exactRun = Self.makeRun(
            id: requestedRunID,
            itemID: itemID,
            status: .succeeded,
            stage: .completed,
            canOpenReview: true,
            listingID: listingID,
            review: exactReview
        )
        let cases: [(name: String, run: DurableRun, expected: ListingReviewResult?)] = [
            ("accepts the exact binding", exactRun, exactReview),
            (
                "rejects a returned run mismatch",
                Self.makeRun(
                    id: UUID(
                        uuidString: "31700000-0000-4000-8000-000000000033"
                    )!,
                    itemID: itemID,
                    status: .succeeded,
                    stage: .completed,
                    canOpenReview: true,
                    listingID: listingID,
                    review: exactReview
                ),
                nil
            ),
            (
                "rejects an unauthorized review",
                Self.makeRun(
                    id: requestedRunID,
                    itemID: itemID,
                    status: .succeeded,
                    stage: .completed,
                    listingID: listingID,
                    review: exactReview
                ),
                nil
            ),
            (
                "rejects a missing review binding",
                Self.makeRun(
                    id: requestedRunID,
                    itemID: itemID,
                    status: .succeeded,
                    stage: .completed,
                    canOpenReview: true,
                    listingID: listingID
                ),
                nil
            ),
            (
                "rejects a review run mismatch",
                Self.makeRun(
                    id: requestedRunID,
                    itemID: itemID,
                    status: .succeeded,
                    stage: .completed,
                    canOpenReview: true,
                    listingID: listingID,
                    review: try Self.makeReview(
                        runID: UUID(
                            uuidString: "31700000-0000-4000-8000-000000000034"
                        )!,
                        itemID: itemID,
                        listingID: listingID
                    )
                ),
                nil
            ),
            (
                "rejects a review item mismatch",
                Self.makeRun(
                    id: requestedRunID,
                    itemID: itemID,
                    status: .succeeded,
                    stage: .completed,
                    canOpenReview: true,
                    listingID: listingID,
                    review: try Self.makeReview(
                        runID: requestedRunID,
                        itemID: UUID(
                            uuidString: "31700000-0000-4000-8000-000000000035"
                        )!,
                        listingID: listingID
                    )
                ),
                nil
            ),
            (
                "rejects a missing run listing",
                Self.makeRun(
                    id: requestedRunID,
                    itemID: itemID,
                    status: .succeeded,
                    stage: .completed,
                    canOpenReview: true,
                    review: exactReview
                ),
                nil
            ),
            (
                "rejects a review listing mismatch",
                Self.makeRun(
                    id: requestedRunID,
                    itemID: itemID,
                    status: .succeeded,
                    stage: .completed,
                    canOpenReview: true,
                    listingID: listingID,
                    review: try Self.makeReview(
                        runID: requestedRunID,
                        itemID: itemID,
                        listingID: UUID(
                            uuidString: "31700000-0000-4000-8000-000000000036"
                        )!
                    )
                ),
                nil
            ),
        ]

        for testCase in cases {
            let service = RecordingRunService(results: [.success(testCase.run)])
            let store = RunDetailStore(
                service: service,
                tokenProvider: RunStoreBearerTokenProvider { "fresh-token" }
            )

            let review = await store.processingReview(for: requestedRunID)

            XCTAssertEqual(review, testCase.expected, testCase.name)
            let requests = await service.requests
            XCTAssertEqual(
                requests,
                [.init(runID: requestedRunID, bearerToken: "fresh-token")],
                testCase.name
            )
        }
    }

    func testReadySignedOutGuestReviewActionPresentsClaimBeforeListingReview()
        async throws {
        let review = try Self.makeReview()
        let run = Self.makeRun(
            status: .succeeded,
            stage: .completed,
            canOpenReview: true,
            listingID: review.binding.listingID,
            review: review
        )
        let recoveryToken = "raw-token-only-in-keychain"
        let credential = GuestRecoveryCredential(
            recoveryID: UUID(
                uuidString: "77000000-0000-4000-8000-000000000001"
            )!,
            recoveryToken: recoveryToken,
            recoveryTokenHash: GuestClaimListingProjection.tokenHash(
                recoveryToken
            ),
            itemID: review.binding.itemID,
            runID: review.binding.runID,
            photoIdentity: GuestPhotoIdentity(
                kind: "content_sha256_set_v1",
                fingerprint: String(repeating: "7", count: 64)
            )
        )
        let credentials = RunStoreGuestRecoveryCredentials(
            credential: credential
        )
        let authorities = RunStoreGuestClaimAuthorities()
        let tokenProvider = RunStoreBearerTokenProvider {
            "guestcap_\(String(repeating: "G", count: 43))"
        }
        let runStore = RunDetailStore(
            service: RecordingRunService(results: [.success(run)]),
            tokenProvider: tokenProvider,
            guestRecoveryCredentials: credentials,
            guestClaimAuthorities: authorities,
            now: {
                ISO8601DateFormatter.snapListDate(
                    from: "2026-08-04T13:00:00.000Z"
                )!
            }
        )
        let listingReviewStore = ListingReviewStore(
            service: ListingReviewAPIClient(
                baseURL: URL(string: "https://snaplist.test")!
            ),
            persistence: MemoryListingReviewDraftPersistence(),
            tokenProvider: tokenProvider
        )
        let guestClaimPresentation = ProcessingGuestClaimPresentationHost()
        let listingReviewPresentation = ListingReviewPresentationHost()
        let executor = ProcessingActionExecutor(
            runStore: runStore,
            listingReviewStore: listingReviewStore,
            guestClaimPresentation: guestClaimPresentation,
            listingReviewPresentation: listingReviewPresentation,
            applyRetryResult: { _ in false },
            selectScan: {}
        )

        let outcome = await executor.execute(.review(runID: run.id))
        let savedAuthority = await authorities.savedAuthority(
            listingID: review.binding.listingID
        )
        let expiry = await credentials.recordedExpiry(
            recoveryID: credential.recoveryID
        )
        let expectedAuthority = GuestClaimAuthority(
            recoveryID: credential.recoveryID,
            recoveryToken: credential.recoveryToken,
            itemID: review.binding.itemID,
            runID: review.binding.runID,
            draftID: review.binding.listingID,
            reviewRevision: review.binding.reviewRevision,
            photoIdentity: credential.photoIdentity!
        )
        let enteredGuestClaimBeforeReview =
            outcome != .selectedScan
                && outcome != .presentedReview
                && outcome != .projectedRetry
                && outcome != .rejected
                && !listingReviewPresentation.isPresented
                && listingReviewStore.phase == .idle
                && savedAuthority == expectedAuthority
                && expiry
                    == ISO8601DateFormatter.snapListDate(
                        from: run.timestamps.completedAt!
                    )!.addingTimeInterval(24 * 60 * 60)

        XCTAssertTrue(
            enteredGuestClaimBeforeReview,
            "PROC-04A Review must present Guest Claim for the exact guest tuple before opening Listing Review."
        )
    }

    func testProcessingGuestClaimPresentationConsumesOnlyMatchingTupleOnce()
        throws {
        let review = try Self.makeReview()
        let authority = GuestClaimAuthority(
            recoveryID: UUID(
                uuidString: "77000000-0000-4000-8000-000000000010"
            )!,
            recoveryToken: "recovery_v1.presentation",
            itemID: review.binding.itemID,
            runID: review.binding.runID,
            draftID: review.binding.listingID,
            reviewRevision: review.binding.reviewRevision,
            photoIdentity: GuestPhotoIdentity(
                kind: "content_sha256_set_v1",
                fingerprint: String(repeating: "8", count: 64)
            )
        )
        let context = ProcessingGuestClaimContext(
            authority: authority,
            projection: GuestClaimListingProjection(
                title: review.listing.title,
                effectivePrice: review.pricing.suggestedPrice,
                thumbnail: .neutral,
                expiresAt: Date(timeIntervalSince1970: 1_800_000_000)
            ),
            review: review
        )
        let exact = ClaimedGuestListing(
            itemID: authority.itemID,
            runID: authority.runID,
            draftID: authority.draftID
        )
        let mismatches: [(String, ClaimedGuestListing)] = [
            (
                "item",
                ClaimedGuestListing(
                    itemID: UUID(),
                    runID: exact.runID,
                    draftID: exact.draftID
                )
            ),
            (
                "run",
                ClaimedGuestListing(
                    itemID: exact.itemID,
                    runID: UUID(),
                    draftID: exact.draftID
                )
            ),
            (
                "draft",
                ClaimedGuestListing(
                    itemID: exact.itemID,
                    runID: exact.runID,
                    draftID: UUID()
                )
            ),
        ]
        let host = ProcessingGuestClaimPresentationHost()
        XCTAssertTrue(host.present(context))

        for (name, mismatch) in mismatches {
            XCTAssertNil(host.takeClaimed(mismatch), name)
            XCTAssertEqual(host.context, context, name)
        }

        XCTAssertEqual(host.takeClaimed(exact), context)
        XCTAssertFalse(host.isPresented)
        XCTAssertNil(host.takeClaimed(exact), "replay")
    }

    func testGuestProcessingReviewRouteRehydratesOnlyExactUnexpiredRecoveryAuthority()
        async throws {
        let review = try Self.makeReview()
        let run = Self.makeRun(
            status: .succeeded,
            stage: .completed,
            canOpenReview: true,
            listingID: review.binding.listingID,
            review: review
        )
        let recoveryID = UUID(
            uuidString: "77000000-0000-4000-8000-000000000020"
        )!
        let recoveryToken = "recovery_v1.route"
        let photoIdentity = GuestPhotoIdentity(
            kind: "content_sha256_set_v1",
            fingerprint: String(repeating: "9", count: 64)
        )
        let credential: (UUID?, UUID?) -> GuestRecoveryCredential = {
            itemID, runID in
            GuestRecoveryCredential(
                recoveryID: recoveryID,
                recoveryToken: recoveryToken,
                recoveryTokenHash: GuestClaimListingProjection.tokenHash(
                    recoveryToken
                ),
                itemID: itemID,
                runID: runID,
                photoIdentity: photoIdentity
            )
        }
        let unexpiredNow = ISO8601DateFormatter.snapListDate(
            from: "2026-08-04T13:00:00.000Z"
        )!
        let invalidCases: [(String, GuestRecoveryCredential, Date, Bool)] = [
            (
                "missing",
                credential(review.binding.itemID, nil),
                unexpiredNow,
                false
            ),
            (
                "item mismatch",
                credential(UUID(), review.binding.runID),
                unexpiredNow,
                false
            ),
            (
                "run mismatch",
                credential(review.binding.itemID, UUID()),
                unexpiredNow,
                false
            ),
            (
                "expired",
                credential(review.binding.itemID, review.binding.runID),
                ISO8601DateFormatter.snapListDate(
                    from: "2026-08-06T13:00:00.000Z"
                )!,
                true
            ),
        ]

        for (name, invalidCredential, now, expectsPurge) in invalidCases {
            let credentials = RunStoreGuestRecoveryCredentials(
                credential: invalidCredential
            )
            let authorities = RunStoreGuestClaimAuthorities()
            let store = RunDetailStore(
                service: RecordingRunService(results: [.success(run)]),
                tokenProvider: RunStoreBearerTokenProvider {
                    "guestcap_\(String(repeating: "G", count: 43))"
                },
                guestRecoveryCredentials: credentials,
                guestClaimAuthorities: authorities,
                now: { now }
            )

            let invalidRoute = await store.processingReviewRoute(
                for: run.id
            )
            XCTAssertNil(invalidRoute, name)
            let credentialPurges = await credentials.purgedRecoveryIDs()
            let authorityPurges = await authorities.purgedRecoveryIDs()
            XCTAssertEqual(
                credentialPurges == [recoveryID],
                expectsPurge,
                name
            )
            XCTAssertEqual(
                authorityPurges == [recoveryID],
                expectsPurge || name == "item mismatch",
                name
            )
        }

        let exactCredential = credential(
            review.binding.itemID,
            review.binding.runID
        )
        let credentials = RunStoreGuestRecoveryCredentials(
            credential: exactCredential
        )
        let authorities = RunStoreGuestClaimAuthorities()
        let services = [
            RecordingRunService(results: [.success(run)]),
            RecordingRunService(results: [.success(run)]),
        ]
        var routes: [ProcessingReviewRoute] = []
        for service in services {
            let relaunchedStore = RunDetailStore(
                service: service,
                tokenProvider: RunStoreBearerTokenProvider {
                    "guestcap_\(String(repeating: "G", count: 43))"
                },
                guestRecoveryCredentials: credentials,
                guestClaimAuthorities: authorities,
                now: { unexpiredNow }
            )
            let resolved = await relaunchedStore.processingReviewRoute(
                for: run.id
            )
            let route = try XCTUnwrap(resolved)
            routes.append(route)
            let requests = await service.requests
            XCTAssertEqual(
                requests,
                [
                    .init(
                        runID: run.id,
                        bearerToken: "guestcap_\(String(repeating: "G", count: 43))"
                    ),
                ]
            )
        }

        XCTAssertEqual(routes.count, 2)
        XCTAssertEqual(routes[0], routes[1])
    }

    func testProcessingRetryProjectsOnlyExactServerAcceptedTruth() async throws {
        let runID = UUID(uuidString: "31700000-0000-4000-8000-000000000040")!
        let unrelatedRunID = UUID(
            uuidString: "31700000-0000-4000-8000-000000000041"
        )!
        let retryableFailure = try Self.makeRetryableFailure()
        let original = Self.makeRun(
            id: runID,
            status: .failed,
            stage: .completed,
            safeFailure: retryableFailure
        )
        let retrying = Self.makeRun(
            id: runID,
            status: .retrying,
            stage: .queued
        )
        let queued = Self.makeRun(
            id: runID,
            status: .queued,
            stage: .queued
        )
        let wrongID = Self.makeRun(
            id: UUID(uuidString: "31700000-0000-4000-8000-000000000042")!,
            status: .retrying,
            stage: .queued
        )
        let illegalState = Self.makeRun(
            id: runID,
            status: .running,
            stage: .generating
        )

        struct TestCase {
            let name: String
            let responses: [Result<DurableRun, Error>]
            let expectedStateLabel: String?
        }

        let cases: [TestCase] = [
            TestCase(
                name: "accepts queued server truth",
                responses: [.success(queued)],
                expectedStateLabel: "Accepted"
            ),
            TestCase(
                name: "accepts retrying server truth",
                responses: [.success(retrying)],
                expectedStateLabel: "Retrying"
            ),
            TestCase(
                name: "rejects another run",
                responses: [.success(wrongID)],
                expectedStateLabel: nil
            ),
            TestCase(
                name: "rejects an illegal response state",
                responses: [.success(illegalState)],
                expectedStateLabel: nil
            ),
            TestCase(
                name: "rejects a server refusal",
                responses: [.failure(RunAPIError.authenticationRequired)],
                expectedStateLabel: nil
            ),
            TestCase(
                name: "rejects a network failure",
                responses: [.failure(RunAPIError.unavailable)],
                expectedStateLabel: nil
            ),
            TestCase(
                name: "rejects a decode failure",
                responses: [.failure(RunAPIError.invalidResponse)],
                expectedStateLabel: nil
            ),
            TestCase(
                name: "retains its key after a refusal before retrying",
                responses: [.failure(RunAPIError.unavailable), .success(retrying)],
                expectedStateLabel: "Retrying"
            ),
        ]

        for testCase in cases {
            let service = RetryRunService(
                initial: original,
                retryResults: testCase.responses
            )
            let store = RunDetailStore(
                service: service,
                tokenProvider: RunStoreBearerTokenProvider { "fresh-token" }
            )
            let principal = TrophyWallPrincipalScope(
                opaqueValue: "processing-retry-\(testCase.name)"
            )
            let wall = TrophyWallStore(
                principalScope: principal,
                repository: ProcessingRetryRepository(
                    cards: [
                        .accepted(
                            principalScope: principal,
                            runID: unrelatedRunID,
                            state: .readyToReview,
                            itemName: "Unrelated item",
                            lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 20)
                        ),
                        .accepted(
                            principalScope: principal,
                            runID: runID,
                            state: .needsRetryLocked(
                                detail: retryableFailure.detail
                            ),
                            itemName: "Canon AE-1 film camera",
                            lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 10)
                        ),
                    ]
                )
            )
            let originalCards = wall.cards
            let originalRows = wall.processingRows

            var retried = await store.processingRetry(for: runID)
            if testCase.responses.count == 2 {
                XCTAssertNil(retried, testCase.name)
                XCTAssertEqual(wall.cards, originalCards, testCase.name)
                XCTAssertEqual(wall.processingRows, originalRows, testCase.name)
                retried = await store.processingRetry(for: runID)
            }

            let didProject = retried.map(wall.applyRetryResult) ?? false
            XCTAssertEqual(didProject, testCase.expectedStateLabel != nil, testCase.name)

            let requests = await service.retryRequests
            XCTAssertEqual(requests.count, testCase.responses.count, testCase.name)
            XCTAssertEqual(
                requests.map(\.runID),
                Array(repeating: runID, count: testCase.responses.count),
                testCase.name
            )
            XCTAssertTrue(
                requests.allSatisfy { $0.bearerToken == "fresh-token" },
                testCase.name
            )
            XCTAssertEqual(
                Set(requests.map(\.idempotencyKey)).count,
                1,
                testCase.name
            )

            guard let expectedStateLabel = testCase.expectedStateLabel else {
                XCTAssertEqual(wall.cards, originalCards, testCase.name)
                XCTAssertEqual(wall.processingRows, originalRows, testCase.name)
                continue
            }

            XCTAssertEqual(
                wall.cards.map(\.identity),
                originalCards.map(\.identity),
                testCase.name
            )
            XCTAssertEqual(
                wall.cards.map(\.orderKey),
                originalCards.map(\.orderKey),
                testCase.name
            )
            XCTAssertEqual(
                wall.processingRows.first { $0.id == .run(runID) }?.stateLabel,
                expectedStateLabel,
                testCase.name
            )
            XCTAssertEqual(
                wall.processingRows.first { $0.id == .run(runID) }?.activation,
                TrophyWallProcessingRowActivation.none,
                testCase.name
            )
            XCTAssertNil(
                wall.processingRows.first { $0.id == .run(runID) }?.action,
                testCase.name
            )
            XCTAssertEqual(
                wall.processingRows.first { $0.id == .run(unrelatedRunID) },
                originalRows.first { $0.id == .run(unrelatedRunID) },
                testCase.name
            )
        }

        let inFlightService = LateRetryRunService(
            failed: original,
            opened: original,
            retryResult: .success(retrying)
        )
        let inFlightStore = RunDetailStore(
            service: inFlightService,
            tokenProvider: RunStoreBearerTokenProvider { "fresh-token" }
        )
        let firstRetry = Task {
            await inFlightStore.processingRetry(for: runID)
        }
        await inFlightService.waitForRetryRequest()

        let duplicateRetry = await inFlightStore.processingRetry(for: runID)
        let inFlightRequests = await inFlightService.retryRequests
        XCTAssertNil(duplicateRetry)
        XCTAssertEqual(inFlightRequests, [runID])

        await inFlightService.resumeRetryRequest()
        let firstRetryResult = await firstRetry.value
        XCTAssertEqual(firstRetryResult, retrying)
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
            recoveryTokenHash:
                "0cecceae54c12297ada48aa3075cad038a48411439cadc2cc90bb82977de9d25",
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

        _ = await store.processingReviewRoute(for: run.id)
        _ = await store.processingReviewRoute(for: run.id)

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
        itemID: UUID = UUID(
            uuidString: "31700000-0000-4000-8000-000000000011"
        )!,
        status: DurableRunStatus = .running,
        stage: DurableRunStage = .generating,
        safeFailure: RunSafeFailure? = nil,
        canOpenReview: Bool = false,
        listingID: UUID? = nil,
        review: ListingReviewResult? = nil
    ) -> DurableRun {
        DurableRun(
            id: id,
            itemID: itemID,
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

    private static func makeReview(
        runID: UUID = UUID(
            uuidString: "31700000-0000-4000-8000-000000000010"
        )!,
        itemID: UUID = UUID(
            uuidString: "31700000-0000-4000-8000-000000000011"
        )!,
        listingID: UUID = UUID(
            uuidString: "63860000-0000-4000-8000-000000000002"
        )!
    ) throws -> ListingReviewResult {
        try JSONDecoder().decode(
            ListingReviewResult.self,
            from: Data(
                """
                {
                  "schemaVersion":1,
                  "binding":{
                    "runId":"\(runID.uuidString.lowercased())",
                    "itemId":"\(itemID.uuidString.lowercased())",
                    "listingId":"\(listingID.uuidString.lowercased())",
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

private struct ProcessingRetryRepository: TrophyWallRepository {
    let cards: [TrophyWallCard]

    func initialCards(
        for principalScope: TrophyWallPrincipalScope
    ) -> [TrophyWallCard] {
        cards
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
