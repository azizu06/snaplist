import Observation
import UIKit
import XCTest
@testable import SnapList

@MainActor
final class ItemRunSubmissionTests: XCTestCase {
    func testTypedRejectionOutcomesMapToTheirPresentationFamilies() {
        let eventID = UUID(
            uuidString: "50300000-0000-4000-8000-000000000071"
        )!
        let cases: [(
            retention: ItemRunSubmissionRetention,
            family: PhotoReviewSubmissionRejectionFamily,
            label: String,
            message: String,
            action: PhotoReviewBoundaryEvent
        )] = [
            (
                .rateLimited(reason: "opaque"),
                .tryAgain,
                "Try again",
                "This didn't go through. Your item is still saved on this phone.",
                .startListing
            ),
            (
                .attemptNotPersisted,
                .tryAgain,
                "Try again",
                "This didn't go through. Your item is still saved on this phone.",
                .startListing
            ),
            (
                .submissionUnavailable,
                .tryAgain,
                "Try again",
                "This didn't go through. Your item is still saved on this phone.",
                .startListing
            ),
            (
                .rejected,
                .review,
                "Review",
                "This item can't be sent as it is.",
                .reviewSubmission(eventID: eventID)
            ),
            (
                .intakeUnavailable,
                .review,
                "Review",
                "This item can't be sent as it is.",
                .reviewSubmission(eventID: eventID)
            ),
        ]

        for testCase in cases {
            let family = PhotoReviewSubmissionRejectionFamily(
                retention: testCase.retention
            )
            XCTAssertEqual(family, testCase.family)
            XCTAssertEqual(family?.primaryActionLabel, testCase.label)
            XCTAssertEqual(family?.message, testCase.message)
            XCTAssertEqual(
                family?.primaryActionEvent(eventID: eventID),
                testCase.action
            )
        }
    }

    func testEveryRetentionProducesOneExhaustiveTypedDestinationDecision() {
        let cases: [(
            retention: ItemRunSubmissionRetention,
            decision: ItemRunSubmissionDestinationDecision
        )] = [
            (.ambiguous, .photoReview(.sub03)),
            (.conflict, .photoReview(.sub04)),
            (.rateLimited(reason: "opaque"), .photoReview(.sub06)),
            (.submissionUnavailable, .photoReview(.sub06)),
            (.attemptNotPersisted, .photoReview(.sub06)),
            (.rejected, .photoReview(.sub07)),
            (.intakeUnavailable, .photoReview(.sub07)),
            (.creditDenied(reason: "opaque"), .handoff(.pay01)),
            (.receiptMismatch, .handoff(.pay08)),
            (.authenticationRequired, .handoff(.accountClaim12aThrough12c)),
        ]

        XCTAssertEqual(cases.count, 10)

        for testCase in cases {
            XCTAssertEqual(
                ItemRunSubmissionDestinationDecision(
                    retention: testCase.retention
                ),
                testCase.decision,
                "Unexpected destination for \(testCase.retention)"
            )
        }

        XCTAssertEqual(
            ItemRunSubmissionDestinationDecision(
                retention: .rateLimited(reason: nil)
            ),
            .photoReview(.sub06)
        )
        XCTAssertEqual(
            ItemRunSubmissionDestinationDecision(
                retention: .creditDenied(reason: nil)
            ),
            .handoff(.pay01)
        )

        let handoffs = cases.compactMap {
            testCase -> ItemRunSubmissionDestinationDecision.Handoff? in
            guard case let .handoff(handoff) = testCase.decision else {
                return nil
            }
            return handoff
        }
        XCTAssertEqual(
            handoffs,
            [.pay01, .pay08, .accountClaim12aThrough12c]
        )
    }

    func testExternalRetentionsPublishOneTypedHandoffAndConsumeOnlyMatchingEvent() async throws {
        let cases: [(
            seed: String,
            retention: ItemRunSubmissionRetention,
            handoff: ItemRunSubmissionDestinationDecision.Handoff,
            outcome: (SubmissionIntakeFixture) -> ItemRunSubmissionTransportOutcome
        )] = [
            (
                "pay-01",
                .creditDenied(reason: "opaque-not-presentation-authority"),
                .pay01,
                { _ in .creditDenied(reason: "opaque-not-presentation-authority") }
            ),
            (
                "pay-08",
                .receiptMismatch,
                .pay08,
                { intake in
                    var mismatchedPhotos = intake.expectedReceiptPhotos
                    mismatchedPhotos[0] = .init(
                        ordinal: 0,
                        contentSha256: String(repeating: "f", count: 64),
                        byteLength: mismatchedPhotos[0].byteLength,
                        mediaType: mismatchedPhotos[0].mediaType
                    )
                    return .created(Self.receipt(photos: mismatchedPhotos))
                }
            ),
            (
                "account-claim",
                .authenticationRequired,
                .accountClaim12aThrough12c,
                { _ in .authenticationRequired }
            ),
        ]
        let staleEventID = UUID(
            uuidString: "50300000-0000-4000-8000-000000000081"
        )!
        var observedEventIDs: [UUID] = []

        for testCase in cases {
            let intake = SubmissionIntakeFixture(
                photoCount: 2,
                seed: testCase.seed
            )
            let attemptStore = InMemoryItemRunSubmissionAttemptStore()
            let draftStore = RecordingCaptureDraftStore(photos: intake.photos)
            let submitter = RecordingItemRunSubmitter(
                outcomes: [testCase.outcome(intake)]
            )
            let host = ItemRunSubmissionHost(
                coordinator: makeCoordinator(
                    intake: intake,
                    attemptStore: attemptStore,
                    submitter: submitter,
                    draftStore: draftStore,
                    keys: [Self.firstKey]
                )
            )

            await host.startListing(photos: intake.photos)

            XCTAssertEqual(host.retention, testCase.retention)
            XCTAssertNil(host.acceptedRun)
            XCTAssertFalse(host.clearedIntake)
            XCTAssertFalse(host.isSubmitting)
            guard case .destinationHandoff(
                eventID: let eventID,
                handoff: let handoff
            )? = host.pendingPresentationEvent else {
                XCTFail("Expected one typed destination handoff.")
                continue
            }
            observedEventIDs.append(eventID)
            XCTAssertEqual(handoff, testCase.handoff)
            XCTAssertEqual(
                ItemRunSubmissionDestinationDecision(
                    retention: testCase.retention
                ),
                .handoff(testCase.handoff)
            )

            let attemptBeforeConsumption = try await attemptStore.loadAttempt()
            let photosBeforeConsumption = try await draftStore.loadPhotos()
            let payloadsBeforeConsumption = await submitter.payloads
            let discardCountBeforeConsumption = await draftStore.discardCount
            XCTAssertEqual(
                attemptBeforeConsumption?.idempotencyKey,
                Self.firstKey
            )
            XCTAssertEqual(photosBeforeConsumption, intake.photos)
            XCTAssertEqual(payloadsBeforeConsumption.count, 1)
            XCTAssertEqual(discardCountBeforeConsumption, 0)

            XCTAssertNil(
                host.consumeDestinationHandoff(eventID: staleEventID)
            )
            XCTAssertEqual(
                host.pendingPresentationEvent,
                .destinationHandoff(
                    eventID: eventID,
                    handoff: testCase.handoff
                )
            )
            XCTAssertEqual(
                host.consumeDestinationHandoff(eventID: eventID),
                testCase.handoff
            )
            XCTAssertNil(host.pendingPresentationEvent)
            XCTAssertNil(
                host.consumeDestinationHandoff(eventID: eventID),
                "A consumed handoff cannot navigate or fire twice."
            )

            let attemptAfterConsumption = try await attemptStore.loadAttempt()
            let photosAfterConsumption = try await draftStore.loadPhotos()
            let payloadsAfterConsumption = await submitter.payloads
            let discardCountAfterConsumption = await draftStore.discardCount
            XCTAssertEqual(attemptAfterConsumption, attemptBeforeConsumption)
            XCTAssertEqual(photosAfterConsumption, photosBeforeConsumption)
            XCTAssertEqual(payloadsAfterConsumption, payloadsBeforeConsumption)
            XCTAssertEqual(
                discardCountAfterConsumption,
                discardCountBeforeConsumption
            )
        }

        XCTAssertEqual(Set(observedEventIDs).count, cases.count)
    }

    // MARK: Persisted attempt identity

    func testPersistsOneKeyAndTheOrderedSnapshotBeforeAnyNetworkActivity() async {
        let intake = SubmissionIntakeFixture(photoCount: 3)
        let attemptStore = InMemoryItemRunSubmissionAttemptStore()
        let submitter = RecordingItemRunSubmitter(
            outcomes: [.ambiguous],
            attemptStore: attemptStore
        )
        let coordinator = makeCoordinator(
            intake: intake,
            attemptStore: attemptStore,
            submitter: submitter,
            keys: [Self.firstKey]
        )

        _ = await coordinator.submit(photos: intake.photos)

        let persisted = await submitter.attemptVisibleAtFirstCall
        XCTAssertEqual(persisted?.idempotencyKey, Self.firstKey)
        XCTAssertEqual(persisted?.photos.map(\.ordinal), [0, 1, 2])
        XCTAssertEqual(persisted?.photos.map(\.photoID), intake.photos.map(\.id))
        XCTAssertEqual(
            persisted?.photos.map(\.contentSha256),
            intake.expectedDigests
        )
        XCTAssertEqual(persisted?.photos.map(\.byteLength), intake.expectedByteLengths)
        XCTAssertEqual(
            persisted?.photos.map(\.mediaType),
            [.jpeg, .jpeg, .jpeg]
        )
    }

    func testNeverReachesTheNetworkWhenTheAttemptCannotBePersisted() async {
        let intake = SubmissionIntakeFixture(photoCount: 2)
        let attemptStore = InMemoryItemRunSubmissionAttemptStore(failsToSave: true)
        let submitter = RecordingItemRunSubmitter(outcomes: [.created(Self.receipt())])
        let coordinator = makeCoordinator(
            intake: intake,
            attemptStore: attemptStore,
            submitter: submitter,
            keys: [Self.firstKey]
        )

        let outcome = await coordinator.submit(photos: intake.photos)

        XCTAssertEqual(outcome, .retained(.attemptNotPersisted))
        let payloads = await submitter.payloads
        XCTAssertTrue(payloads.isEmpty)
    }

    // MARK: Intake that cannot be submitted

    /// Submitting commits the displayed photos to the durable draft first, and the store
    /// accepts only a reorder or a removal of photos it already holds. A rejected commit
    /// means the screen and the draft disagree in a way this submission cannot resolve,
    /// so the exact clear would refuse the run afterwards. Sending anyway would spend an
    /// AI-item credit on a run the seller could never see, which is why the request has
    /// to stop here rather than at the receipt.
    func testAnIntakeTheDurableDraftRejectsIsNeverSubmitted() async {
        let staged = SubmissionIntakeFixture(photoCount: 2)
        let unstaged = SubmissionIntakeFixture(photoCount: 1, seed: "never-staged")
        // A photo on screen that the durable draft never received.
        let displayed = staged.photos + unstaged.photos
        let draftStore = RecordingCaptureDraftStore(photos: staged.photos)
        let attemptStore = InMemoryItemRunSubmissionAttemptStore()
        let submitter = RecordingItemRunSubmitter(outcomes: [.created(Self.receipt())])
        let coordinator = makeCoordinator(
            intake: staged,
            attemptStore: attemptStore,
            submitter: submitter,
            draftStore: draftStore,
            keys: [Self.firstKey],
            readData: SubmissionIntakeFixture.merging(staged, unstaged)
        )

        let outcome = await coordinator.submit(photos: displayed)

        XCTAssertEqual(outcome, .retained(.intakeUnavailable))
        // The whole point of refusing here: no request, so no AI-item credit.
        let payloads = await submitter.payloads
        XCTAssertTrue(payloads.isEmpty)
        // No key is minted for a submission that never happened, so the next attempt is
        // not a replay of a run the server never made.
        let storedAttempt = await attemptStore.attempt
        XCTAssertNil(storedAttempt)
        let remaining = await draftStore.photos
        XCTAssertEqual(remaining, staged.photos)
        let discardCount = await draftStore.discardCount
        XCTAssertEqual(discardCount, 0)
    }

    /// The photos are gone from disk. This is what a second Start listing tap hits after
    /// an accepted run already cleared the intake, so it has to stay a refusal rather
    /// than becoming a second submission.
    func testPhotosThatCannotBeReadAreNeverSubmitted() async {
        let intake = SubmissionIntakeFixture(photoCount: 2)
        let draftStore = RecordingCaptureDraftStore(photos: intake.photos)
        let attemptStore = InMemoryItemRunSubmissionAttemptStore()
        let submitter = RecordingItemRunSubmitter(outcomes: [.created(Self.receipt())])
        let coordinator = makeCoordinator(
            intake: intake,
            attemptStore: attemptStore,
            submitter: submitter,
            draftStore: draftStore,
            keys: [Self.firstKey],
            readData: { (_: URL) throws -> Data in
                throw CocoaError(.fileNoSuchFile)
            }
        )

        let outcome = await coordinator.submit(photos: intake.photos)

        XCTAssertEqual(outcome, .retained(.intakeUnavailable))
        let payloads = await submitter.payloads
        XCTAssertTrue(payloads.isEmpty)
        let storedAttempt = await attemptStore.attempt
        XCTAssertNil(storedAttempt)
        let remaining = await draftStore.photos
        XCTAssertEqual(remaining, intake.photos)
    }

    func testUnreadableOrUnsupportedVoiceFailsOpenToTheExactPhotoPayload()
        throws {
        let intake = SubmissionIntakeFixture(photoCount: 2)
        let voiceURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("unavailable-voice.wav")
        let voice = NativeIntake.Voice(
            id: UUID(),
            mediaURL: voiceURL,
            duration: 1
        )
        let readPhoto = intake.read

        for unsupportedVoice in [false, true] {
            let snapshot = try ItemRunSubmissionSnapshot.make(
                for: intake.photos,
                voice: voice,
                localeHint: "en-US",
                readData: { url in
                    guard url == voiceURL else {
                        return try readPhoto(url)
                    }
                    if unsupportedVoice {
                        return Data("not a wave file".utf8)
                    }
                    throw CocoaError(.fileNoSuchFile)
                }
            )

            XCTAssertEqual(
                snapshot.photos.map(\.contentSha256),
                intake.expectedDigests
            )
            XCTAssertEqual(snapshot.photoData, intake.expectedBytes)
            XCTAssertNil(snapshot.voiceContext)
            XCTAssertNil(snapshot.voiceData)
        }
    }

    /// An intake outside the one-to-five photo contract never becomes a request. The
    /// server would reject it, and the seller would have paid the round trip to find out.
    func testAnIntakeOutsideOneToFivePhotosIsNeverSubmitted() async {
        for photoCount in [0, 6] {
            let intake = SubmissionIntakeFixture(photoCount: photoCount)
            let draftStore = RecordingCaptureDraftStore(photos: intake.photos)
            let attemptStore = InMemoryItemRunSubmissionAttemptStore()
            let submitter = RecordingItemRunSubmitter(
                outcomes: [.created(Self.receipt())]
            )
            let coordinator = makeCoordinator(
                intake: intake,
                attemptStore: attemptStore,
                submitter: submitter,
                draftStore: draftStore,
                keys: [Self.firstKey]
            )

            let outcome = await coordinator.submit(photos: intake.photos)

            XCTAssertEqual(
                outcome,
                .retained(.intakeUnavailable),
                "\(photoCount) photos is outside the submittable intake"
            )
            let payloads = await submitter.payloads
            XCTAssertTrue(payloads.isEmpty, "\(photoCount) photos reached the network")
            let storedAttempt = await attemptStore.attempt
            XCTAssertNil(storedAttempt)
            let remaining = await draftStore.photos
            XCTAssertEqual(remaining, intake.photos)
        }
    }

    /// The live boundary keeps the same refusal typed rather than swallowing it, so the
    /// seller-visible surface #503 owns has something truthful to read.
    func testStartListingSurfacesAnUnsubmittableIntakeWithoutARun() async {
        let staged = SubmissionIntakeFixture(photoCount: 1)
        let unstaged = SubmissionIntakeFixture(photoCount: 1, seed: "never-staged")
        let submitter = RecordingItemRunSubmitter(outcomes: [.created(Self.receipt())])
        let host = ItemRunSubmissionHost(
            coordinator: makeCoordinator(
                intake: staged,
                attemptStore: InMemoryItemRunSubmissionAttemptStore(),
                submitter: submitter,
                draftStore: RecordingCaptureDraftStore(photos: staged.photos),
                keys: [Self.firstKey],
                readData: SubmissionIntakeFixture.merging(staged, unstaged)
            )
        )

        await host.startListing(photos: staged.photos + unstaged.photos)

        XCTAssertEqual(host.retention, .intakeUnavailable)
        XCTAssertNil(host.acceptedRun)
        XCTAssertFalse(host.clearedIntake)
        let payloads = await submitter.payloads
        XCTAssertTrue(payloads.isEmpty)
    }

    // MARK: Ambiguous outcome and exact retry

    func testSubmissionNeverCombinesPriorPrincipalPayloadWithCurrentPrincipalBearer()
        async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(
            "snaplist-principal-generation-fence-\(UUID().uuidString)",
            isDirectory: true
        )
        defer { try? FileManager.default.removeItem(at: root) }
        let pair = PrincipalGenerationPair(
            caseRoot: root,
            aSeed: "principal-a",
            bSeed: "principal-b"
        )
        let principalA = pair.principalA
        let principalB = pair.principalB
        let reader = PrincipalPhotoReadRecorder(
            fixtures: [principalA, principalB]
        )
        let attemptA = ItemRunSubmissionAttempt(
            idempotencyKey: Self.firstKey,
            photos: try ItemRunSubmissionSnapshot.make(
                for: principalA.photos,
                readData: reader.read
            ).photos
        )
        let attemptStoreA = LocalItemRunSubmissionAttemptStore(
            principalRootDirectory: principalA.root
        )
        let attemptStoreB = LocalItemRunSubmissionAttemptStore(
            principalRootDirectory: principalB.root
        )
        try await attemptStoreA.saveAttempt(attemptA)
        reader.reset()

        let bearerGate = SubmissionResponseGate()
        let submitter = RecordingItemRunSubmitter(outcomes: [.ambiguous])
        let coordinator = ItemRunSubmissionCoordinator(
            submitter: submitter,
            attemptStore: InMemoryItemRunSubmissionAttemptStore(),
            draftStore: RecordingCaptureDraftStore(
                photos: principalA.photos
            ),
            tokenProvider: TestBearerTokenProvider(
                principalScopeProof:
                    ItemRunSubmissionPrincipalScopeProof(
                        filesystemRoot: principalB.root
                    )
            ) {
                await bearerGate.hold()
                return "current-session-bearer"
            },
            readData: reader.read,
            newIdempotencyKey: { Self.secondKey }
        )
        let host = ItemRunSubmissionHost(coordinator: coordinator)
        host.synchronizePrincipal(
            snapshot: principalA.snapshot,
            intake: pair.intake
        )

        let submission = Task {
            await host.startListing(photos: principalA.photos)
        }
        defer { submission.cancel() }
        await bearerGate.waitUntilHeld()

        XCTAssertEqual(
            reader.readCount,
            0,
            "Principal-sensitive photo or attempt work started before bearer acquisition."
        )

        // Authentication has already changed to B, but the separate NativeIntake
        // event is deliberately delayed. Cached UI generation still says A.
        await bearerGate.release()
        await submission.value

        let payloads = await submitter.payloads
        XCTAssertTrue(
            payloads.isEmpty,
            "Principal A payload reached transport with B's atomic bearer authority."
        )
        let storedAttemptA = try await attemptStoreA.loadAttempt()
        let storedAttemptB = try await attemptStoreB.loadAttempt()
        XCTAssertEqual(storedAttemptA, attemptA)
        XCTAssertNil(storedAttemptB)
        XCTAssertEqual(reader.readCount, 0)

        host.synchronizePrincipal(
            snapshot: principalB.snapshot,
            intake: pair.intake
        )
        XCTAssertFalse(host.isSubmitting)
        XCTAssertNil(host.acceptedRun)
        XCTAssertNil(host.retention)
        XCTAssertNil(host.pendingPresentationEvent)
    }

    func testPrincipalSwitchAfterHashingStopsBeforeAttemptOrDispatch()
        async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(
            "submission-principal-post-hash-fence-\(UUID().uuidString)",
            isDirectory: true
        )
        defer { try? FileManager.default.removeItem(at: root) }
        let pair = PrincipalGenerationPair(
            caseRoot: root,
            aSeed: "post-hash-a",
            bSeed: "post-hash-b"
        )
        let principalA = pair.principalA
        let principalB = pair.principalB
        let attemptURL = principalA.root
            .appendingPathComponent(
                "ItemRunSubmission",
                isDirectory: true
            )
            .appendingPathComponent("attempt.json")
        try FileManager.default.createDirectory(
            at: attemptURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let sentinelAttemptBytes = Data("departed-attempt".utf8)
        try sentinelAttemptBytes.write(to: attemptURL)

        let bearerGate = SubmissionResponseGate()
        let reader = PrincipalPhotoReadRecorder(
            fixtures: [principalA, principalB]
        )
        let submitter = RecordingItemRunSubmitter(outcomes: [.ambiguous])
        let host = ItemRunSubmissionHost(
            coordinator: ItemRunSubmissionCoordinator(
                submitter: submitter,
                attemptStore: InMemoryItemRunSubmissionAttemptStore(),
                draftStore: RecordingCaptureDraftStore(
                    photos: principalA.photos
                ),
                tokenProvider: TestBearerTokenProvider(
                    principalScopeProof:
                        ItemRunSubmissionPrincipalScopeProof(
                            filesystemRoot: principalA.root
                        )
                ) {
                    await bearerGate.hold(onCall: 2)
                    return "principal-a-bearer"
                },
                readData: reader.read,
                newIdempotencyKey: { Self.firstKey }
            )
        )
        host.synchronizePrincipal(
            snapshot: principalA.snapshot,
            intake: pair.intake
        )

        let submission = Task {
            await host.startListing(photos: principalA.photos)
        }
        defer { submission.cancel() }
        await bearerGate.waitUntilHeld()

        host.synchronizePrincipal(
            snapshot: principalB.snapshot,
            intake: pair.intake
        )
        await bearerGate.release()
        await submission.value

        XCTAssertEqual(
            try Data(contentsOf: attemptURL),
            sentinelAttemptBytes,
            "A departed generation read, discarded, or overwrote its attempt."
        )
        XCTAssertEqual(reader.readCount, 1)
        let payloads = await submitter.payloads
        XCTAssertTrue(payloads.isEmpty)
        XCTAssertFalse(host.isSubmitting)
        XCTAssertNil(host.acceptedRun)
        XCTAssertNil(host.retention)
        XCTAssertNil(host.pendingPresentationEvent)
    }

    func testPrincipalSwitchDuringTransportPreservesAttemptAndSuppressesResult()
        async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(
            "submission-principal-transport-fence-\(UUID().uuidString)",
            isDirectory: true
        )
        defer { try? FileManager.default.removeItem(at: root) }
        let pair = PrincipalGenerationPair(
            caseRoot: root,
            aSeed: "transport-a",
            bSeed: "transport-b"
        )
        let principalA = pair.principalA
        let principalB = pair.principalB
        let reader = PrincipalPhotoReadRecorder(
            fixtures: [principalA, principalB]
        )
        let attemptA = ItemRunSubmissionAttempt(
            idempotencyKey: Self.firstKey,
            photos: try ItemRunSubmissionSnapshot.make(
                for: principalA.photos,
                readData: reader.read
            ).photos
        )
        let attemptB = ItemRunSubmissionAttempt(
            idempotencyKey: Self.secondKey,
            photos: try ItemRunSubmissionSnapshot.make(
                for: principalB.photos,
                readData: reader.read
            ).photos
        )
        let attemptStoreA = LocalItemRunSubmissionAttemptStore(
            principalRootDirectory: principalA.root
        )
        let attemptStoreB = LocalItemRunSubmissionAttemptStore(
            principalRootDirectory: principalB.root
        )
        try await attemptStoreA.saveAttempt(attemptA)
        try await attemptStoreB.saveAttempt(attemptB)
        reader.reset()

        let transportGate = SubmissionResponseGate()
        let submitter = RecordingItemRunSubmitter(
            outcomes: [.conflict],
            beforeResponse: {
                await transportGate.hold()
            }
        )
        let host = ItemRunSubmissionHost(
            coordinator: ItemRunSubmissionCoordinator(
                submitter: submitter,
                attemptStore: InMemoryItemRunSubmissionAttemptStore(),
                draftStore: RecordingCaptureDraftStore(
                    photos: principalA.photos
                ),
                tokenProvider: TestBearerTokenProvider(
                    principalScopeProof:
                        ItemRunSubmissionPrincipalScopeProof(
                            filesystemRoot: principalA.root
                        )
                ) {
                    "principal-a-bearer"
                },
                readData: reader.read,
                newIdempotencyKey: { Self.firstKey }
            )
        )
        host.synchronizePrincipal(
            snapshot: principalA.snapshot,
            intake: pair.intake
        )

        let submission = Task {
            await host.startListing(photos: principalA.photos)
        }
        defer { submission.cancel() }
        await transportGate.waitUntilHeld()

        host.synchronizePrincipal(
            snapshot: principalB.snapshot,
            intake: pair.intake
        )
        await transportGate.release()
        await submission.value

        let payloads = await submitter.payloads
        let storedAttemptA = try await attemptStoreA.loadAttempt()
        let storedAttemptB = try await attemptStoreB.loadAttempt()
        XCTAssertEqual(payloads.count, 1)
        XCTAssertEqual(storedAttemptA, attemptA)
        XCTAssertEqual(storedAttemptB, attemptB)
        XCTAssertFalse(host.isSubmitting)
        XCTAssertNil(host.acceptedRun)
        XCTAssertNil(host.retention)
        XCTAssertNil(host.pendingPresentationEvent)
        XCTAssertFalse(host.retryAmbiguousSubmission(eventID: UUID()))
    }

    func testPrincipalAmbiguousReplayAndAcceptedCleanupStayInCapturedScope()
        async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(
            "submission-principal-replay-\(UUID().uuidString)",
            isDirectory: true
        )
        defer { try? FileManager.default.removeItem(at: root) }
        let subject = "user_submission_principal_replay"
        let photoData = SubmissionIntakeFixture.jpeg(
            filling: "principal-replay",
            repeated: 1
        )
        let native = try await makeNativePrincipalIntake(
            applicationSupport: root,
            verifiedClerkSubject: subject,
            photoData: photoData,
            voiceData: Self.fixedVoiceWAV()
        )
        let scopeRoot = native.snapshot.photos[0].photoURL
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let scopeProof = try XCTUnwrap(
            ItemRunSubmissionPrincipalScopeProof(
                filesystemRoot: scopeRoot
            )
        )
        let foreignRoot = root
            .appendingPathComponent(
                "ForeignApplicationSupport",
                isDirectory: true
            )
            .appendingPathComponent("SnapList", isDirectory: true)
            .appendingPathComponent("NativeIntake", isDirectory: true)
            .appendingPathComponent(
                "v1-\(String(repeating: "f", count: 64))",
                isDirectory: true
            )
        let foreignStore = LocalItemRunSubmissionAttemptStore(
            principalRootDirectory: foreignRoot
        )
        let foreignAttempt = ItemRunSubmissionAttempt(
            idempotencyKey: Self.secondKey,
            photos: try ItemRunSubmissionSnapshot.make(
                for: native.snapshot.photos,
                readData: { _ in photoData }
            ).photos
        )
        try await foreignStore.saveAttempt(foreignAttempt)

        let receipt = Self.receipt(
            photos: Self.receiptPhotos(for: [photoData])
        )
        let submitter = RecordingItemRunSubmitter(
            outcomes: [.ambiguous, .replayed(receipt)]
        )
        let tokens = TokenSequence(
            tokens: ["principal-token", "principal-token-refreshed"]
        )
        let host = ItemRunSubmissionHost(
            coordinator: ItemRunSubmissionCoordinator(
                submitter: submitter,
                attemptStore: InMemoryItemRunSubmissionAttemptStore(),
                draftStore: RecordingCaptureDraftStore(
                    photos: native.snapshot.photos
                ),
                tokenProvider: TestBearerTokenProvider(
                    principalScopeProof: scopeProof
                ) {
                    tokens.next()
                },
                newIdempotencyKey: { Self.firstKey }
            )
        )
        host.synchronizePrincipal(
            snapshot: native.snapshot,
            intake: native.intake
        )

        await host.startListing(photos: native.snapshot.photos)

        guard case .submissionRejected(
            eventID: let eventID,
            retention: .ambiguous
        )? = host.pendingPresentationEvent else {
            return XCTFail("Expected one principal-scoped ambiguous retry.")
        }
        XCTAssertTrue(host.retryAmbiguousSubmission(eventID: eventID))

        let replay = Task {
            await host.startListing(photos: native.snapshot.photos)
        }
        defer { replay.cancel() }
        guard let savedEvent = await waitForPendingItemSavedEvent(on: host)
        else {
            return
        }
        host.acknowledgePresentation(eventID: savedEvent.eventID)
        await replay.value

        let payloads = await submitter.payloads
        XCTAssertEqual(payloads.count, 2)
        XCTAssertEqual(
            payloads.map(\.attempt.idempotencyKey),
            [Self.firstKey, Self.firstKey]
        )
        XCTAssertEqual(payloads[0].photoData, payloads[1].photoData)
        XCTAssertEqual(payloads[1].photoData, [photoData])
        let principalStore = LocalItemRunSubmissionAttemptStore(
            principalRootDirectory: scopeRoot
        )
        let remainingPrincipalAttempt =
            try await principalStore.loadAttempt()
        let remainingForeignAttempt =
            try await foreignStore.loadAttempt()
        let bearerTokenLengths = await submitter.bearerTokenLengths
        XCTAssertNil(remainingPrincipalAttempt)
        XCTAssertEqual(remainingForeignAttempt, foreignAttempt)
        XCTAssertTrue(host.clearedIntake)
        XCTAssertEqual(bearerTokenLengths.count, 2)
        let submittedVoice = try XCTUnwrap(native.snapshot.voice)
        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: native.snapshot.photos[0].photoURL.path
            )
        )
        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: submittedVoice.mediaURL.path
            )
        )
        let deferredVoiceURL = scopeRoot
            .appendingPathComponent(
                "DeferredUnmatchedVoices",
                isDirectory: true
            )
            .appendingPathComponent(
                submittedVoice.id.uuidString.lowercased(),
                isDirectory: true
            )
            .appendingPathComponent(
                "voice-\(submittedVoice.id.uuidString).wav"
            )
        XCTAssertEqual(try Data(contentsOf: deferredVoiceURL), Self.fixedVoiceWAV())
    }

    func testAbsentSessionStopsBeforeRunSubmissionTransport() async {
        let intake = SubmissionIntakeFixture(photoCount: 1)
        let submitter = RecordingItemRunSubmitter(outcomes: [.ambiguous])
        let firstKey = Self.firstKey
        let coordinator = ItemRunSubmissionCoordinator(
            submitter: submitter,
            attemptStore: InMemoryItemRunSubmissionAttemptStore(),
            draftStore: RecordingCaptureDraftStore(photos: intake.photos),
            tokenProvider: TestBearerTokenProvider {
                throw BearerTokenProviderError.sessionAbsent
            },
            readData: intake.read,
            newIdempotencyKey: { firstKey }
        )

        let outcome = await coordinator.submit(photos: intake.photos)

        XCTAssertEqual(outcome, .retained(.authenticationRequired))
        let payloads = await submitter.payloads
        XCTAssertTrue(payloads.isEmpty)
    }

    func testAmbiguousResponseRetriesTheIdenticalBytesUnderTheSameKey() async {
        let intake = SubmissionIntakeFixture(photoCount: 3)
        let attemptStore = InMemoryItemRunSubmissionAttemptStore()
        let submitter = RecordingItemRunSubmitter(
            outcomes: [.ambiguous, .replayed(Self.receipt(for: intake))]
        )
        // Each call hands back a different token, and the double records only how long
        // each one was. Distinct lengths are enough to tell a freshly fetched bearer from
        // the first one being replayed, without recording or asserting a token value.
        let tokens = TokenSequence(
            tokens: ["clerk-session-token", "clerk-session-token-renewed"]
        )
        let coordinator = makeCoordinator(
            intake: intake,
            attemptStore: attemptStore,
            submitter: submitter,
            keys: [Self.firstKey, Self.secondKey],
            tokenProvider: TestBearerTokenProvider { tokens.next() }
        )

        let first = await coordinator.submit(photos: intake.photos)
        let second = await coordinator.submit(photos: intake.photos)

        XCTAssertEqual(first, .retained(.ambiguous))
        let payloads = await submitter.payloads
        XCTAssertEqual(payloads.count, 2)
        XCTAssertEqual(payloads.map(\.attempt.idempotencyKey), [Self.firstKey, Self.firstKey])
        XCTAssertEqual(payloads[0].attempt.photos, payloads[1].attempt.photos)
        XCTAssertEqual(payloads[0].photoData, payloads[1].photoData)
        XCTAssertEqual(payloads[1].photoData, intake.expectedBytes)
        // The key is reused; the token is not. Clerk bearers are short lived, so each
        // attempt has to ask for one rather than replay whatever the first one got.
        let tokenLengths = await submitter.bearerTokenLengths
        XCTAssertEqual(tokenLengths.count, 2)
        XCTAssertNotEqual(
            tokenLengths[0],
            tokenLengths[1],
            "The retry sent the first attempt's bearer instead of a fresh one"
        )
        guard case .accepted(let acceptance) = second else {
            return XCTFail("Expected the exact retry to resolve to one canonical run.")
        }
        XCTAssertEqual(acceptance.run.runID, Self.canonicalRunID)
    }

    func testRelaunchReusesStoredVoiceLocaleAndKeyWhenLocalePreferenceDrifts()
        async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(
            "submission-voice-locale-relaunch-\(UUID().uuidString)",
            isDirectory: true
        )
        defer { try? FileManager.default.removeItem(at: root) }
        let photoData = SubmissionIntakeFixture.jpeg(
            filling: "voice-locale-relaunch",
            repeated: 1
        )
        let native = try await makeNativePrincipalIntake(
            applicationSupport: root,
            verifiedClerkSubject: "user_voice_locale_relaunch",
            photoData: photoData,
            voiceData: Self.fixedVoiceWAV()
        )
        let scopeRoot = native.snapshot.photos[0].photoURL
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let scopeProof = try XCTUnwrap(
            ItemRunSubmissionPrincipalScopeProof(
                filesystemRoot: scopeRoot
            )
        )
        let submitter = RecordingItemRunSubmitter(
            outcomes: [.ambiguous, .ambiguous]
        )
        let firstHost = ItemRunSubmissionHost(
            coordinator: ItemRunSubmissionCoordinator(
                submitter: submitter,
                attemptStore: InMemoryItemRunSubmissionAttemptStore(),
                draftStore: RecordingCaptureDraftStore(
                    photos: native.snapshot.photos
                ),
                tokenProvider: TestBearerTokenProvider(
                    principalScopeProof: scopeProof
                ) {
                    "clerk-session-token"
                },
                voiceLocaleHint: { "en-US" },
                newIdempotencyKey: { Self.firstKey }
            )
        )
        firstHost.synchronizePrincipal(
            snapshot: native.snapshot,
            intake: native.intake
        )
        await firstHost.startListing(photos: native.snapshot.photos)

        let relaunchedHost = ItemRunSubmissionHost(
            coordinator: ItemRunSubmissionCoordinator(
                submitter: submitter,
                attemptStore: InMemoryItemRunSubmissionAttemptStore(),
                draftStore: RecordingCaptureDraftStore(
                    photos: native.snapshot.photos
                ),
                tokenProvider: TestBearerTokenProvider(
                    principalScopeProof: scopeProof
                ) {
                    "clerk-session-token-refreshed"
                },
                voiceLocaleHint: { "EN-us" },
                newIdempotencyKey: { Self.secondKey }
            )
        )
        relaunchedHost.synchronizePrincipal(
            snapshot: native.snapshot,
            intake: native.intake
        )
        await relaunchedHost.startListing(photos: native.snapshot.photos)

        let payloads = await submitter.payloads
        XCTAssertEqual(payloads.count, 2)
        XCTAssertEqual(
            payloads.map(\.attempt.idempotencyKey),
            [Self.firstKey, Self.firstKey]
        )
        XCTAssertEqual(
            payloads.map(\.attempt.voiceContext?.localeHint),
            ["en-US", "en-US"]
        )
        XCTAssertEqual(payloads[0].voiceData, payloads[1].voiceData)
    }

    func testUnreadableDurableVoiceAttemptKeepsItsKeyAndStopsBeforeTransport()
        async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(
            "submission-unreadable-durable-voice-\(UUID().uuidString)",
            isDirectory: true
        )
        defer { try? FileManager.default.removeItem(at: root) }
        let photoData = SubmissionIntakeFixture.jpeg(
            filling: "unreadable-durable-voice",
            repeated: 1
        )
        let native = try await makeNativePrincipalIntake(
            applicationSupport: root,
            verifiedClerkSubject: "user_unreadable_durable_voice",
            photoData: photoData,
            voiceData: Self.fixedVoiceWAV()
        )
        let voiceURL = try XCTUnwrap(native.snapshot.voice?.mediaURL)
        let scopeRoot = native.snapshot.photos[0].photoURL
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let scopeProof = try XCTUnwrap(
            ItemRunSubmissionPrincipalScopeProof(
                filesystemRoot: scopeRoot
            )
        )
        let submitter = RecordingItemRunSubmitter(outcomes: [.ambiguous])
        let firstHost = ItemRunSubmissionHost(
            coordinator: ItemRunSubmissionCoordinator(
                submitter: submitter,
                attemptStore: InMemoryItemRunSubmissionAttemptStore(),
                draftStore: RecordingCaptureDraftStore(
                    photos: native.snapshot.photos
                ),
                tokenProvider: TestBearerTokenProvider(
                    principalScopeProof: scopeProof
                ) {
                    "clerk-session-token"
                },
                voiceLocaleHint: { "en-US" },
                newIdempotencyKey: { Self.firstKey }
            )
        )
        firstHost.synchronizePrincipal(
            snapshot: native.snapshot,
            intake: native.intake
        )
        await firstHost.startListing(photos: native.snapshot.photos)

        let relaunchedHost = ItemRunSubmissionHost(
            coordinator: ItemRunSubmissionCoordinator(
                submitter: submitter,
                attemptStore: InMemoryItemRunSubmissionAttemptStore(),
                draftStore: RecordingCaptureDraftStore(
                    photos: native.snapshot.photos
                ),
                tokenProvider: TestBearerTokenProvider(
                    principalScopeProof: scopeProof
                ) {
                    "clerk-session-token-refreshed"
                },
                readData: { url in
                    if url == voiceURL {
                        throw CocoaError(.fileReadNoSuchFile)
                    }
                    return try Data(contentsOf: url)
                },
                voiceLocaleHint: { "en-US" },
                newIdempotencyKey: { Self.secondKey }
            )
        )
        relaunchedHost.synchronizePrincipal(
            snapshot: native.snapshot,
            intake: native.intake
        )
        await relaunchedHost.startListing(photos: native.snapshot.photos)

        XCTAssertEqual(relaunchedHost.retention, .intakeUnavailable)
        let payloads = await submitter.payloads
        XCTAssertEqual(payloads.count, 1)
        XCTAssertEqual(payloads.first?.attempt.idempotencyKey, Self.firstKey)
        let stored = try await LocalItemRunSubmissionAttemptStore(
            principalRootDirectory: scopeRoot
        ).loadAttempt()
        XCTAssertEqual(stored?.idempotencyKey, Self.firstKey)
        XCTAssertNotNil(stored?.voiceContext)
    }

    func testADifferentIntakeNeverInheritsTheStoredKey() async {
        let submitted = SubmissionIntakeFixture(photoCount: 2, seed: "first")
        let replaced = SubmissionIntakeFixture(photoCount: 2, seed: "second")
        let attemptStore = InMemoryItemRunSubmissionAttemptStore()
        let submitter = RecordingItemRunSubmitter(outcomes: [.ambiguous, .ambiguous])
        let keys = KeySequence(keys: [Self.firstKey, Self.secondKey])
        let firstCoordinator = ItemRunSubmissionCoordinator(
            submitter: submitter,
            attemptStore: attemptStore,
            draftStore: RecordingCaptureDraftStore(photos: submitted.photos),
            tokenProvider: TestBearerTokenProvider { "clerk-session-token" },
            readData: submitted.read,
            newIdempotencyKey: { keys.next() }
        )
        let secondCoordinator = ItemRunSubmissionCoordinator(
            submitter: submitter,
            attemptStore: attemptStore,
            draftStore: RecordingCaptureDraftStore(photos: replaced.photos),
            tokenProvider: TestBearerTokenProvider { "clerk-session-token" },
            readData: replaced.read,
            newIdempotencyKey: { keys.next() }
        )

        _ = await firstCoordinator.submit(photos: submitted.photos)
        _ = await secondCoordinator.submit(photos: replaced.photos)

        let payloads = await submitter.payloads
        XCTAssertEqual(
            payloads.map(\.attempt.idempotencyKey),
            [Self.firstKey, Self.secondKey]
        )
    }

    // MARK: Exact-clear transaction

    func testValidatedReceiptClearsTheExactIntakeOnce() async {
        let intake = SubmissionIntakeFixture(photoCount: 4)
        let attemptStore = InMemoryItemRunSubmissionAttemptStore()
        let draftStore = RecordingCaptureDraftStore(photos: intake.photos)
        let submitter = RecordingItemRunSubmitter(
            outcomes: [.created(Self.receipt(for: intake))]
        )
        let coordinator = makeCoordinator(
            intake: intake,
            attemptStore: attemptStore,
            submitter: submitter,
            draftStore: draftStore,
            keys: [Self.firstKey]
        )

        let outcome = await coordinator.submit(photos: intake.photos)

        XCTAssertEqual(
            outcome,
            .accepted(
                ItemRunAcceptance(
                    run: AcceptedItemRun(
                        runID: Self.canonicalRunID,
                        itemID: Self.canonicalItemID,
                        status: "queued",
                        stage: "queued"
                    ),
                    clearedIntake: true
                )
            )
        )
        let remaining = await draftStore.photos
        let discardCount = await draftStore.discardCount
        let storedAttempt = await attemptStore.attempt
        let tokenLengths = await submitter.bearerTokenLengths
        XCTAssertTrue(remaining.isEmpty)
        XCTAssertEqual(discardCount, 1)
        XCTAssertNil(storedAttempt)
        // Presence and shape only. A test that knows the token value is a test that leaks it.
        XCTAssertEqual(tokenLengths.count, 1)
        XCTAssertGreaterThan(tokenLengths.first ?? 0, 0)
    }

    func testNullVoiceReceiptRetiresAcceptedPhotosAndAttemptWhileDeferringVoice()
        async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(
            "submission-null-voice-receipt-\(UUID().uuidString)",
            isDirectory: true
        )
        defer { try? FileManager.default.removeItem(at: root) }
        let photoData = SubmissionIntakeFixture.jpeg(
            filling: "null-voice-receipt",
            repeated: 1
        )
        let native = try await makeNativePrincipalIntake(
            applicationSupport: root,
            verifiedClerkSubject: "user_null_voice_receipt",
            photoData: photoData,
            voiceData: Self.fixedVoiceWAV()
        )
        let scopeRoot = native.snapshot.photos[0].photoURL
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let scopeProof = try XCTUnwrap(
            ItemRunSubmissionPrincipalScopeProof(
                filesystemRoot: scopeRoot
            )
        )
        let submitter = RecordingItemRunSubmitter(
            outcomes: [
                .created(
                    Self.receipt(
                        photos: Self.receiptPhotos(for: [photoData])
                    )
                )
            ]
        )
        let host = ItemRunSubmissionHost(
            coordinator: ItemRunSubmissionCoordinator(
                submitter: submitter,
                attemptStore: InMemoryItemRunSubmissionAttemptStore(),
                draftStore: RecordingCaptureDraftStore(
                    photos: native.snapshot.photos
                ),
                tokenProvider: TestBearerTokenProvider(
                    principalScopeProof: scopeProof
                ) {
                    "clerk-session-token"
                },
                voiceLocaleHint: { "en-US" },
                newIdempotencyKey: { Self.firstKey }
            )
        )
        host.synchronizePrincipal(
            snapshot: native.snapshot,
            intake: native.intake
        )

        let submission = Task {
            await host.startListing(photos: native.snapshot.photos)
        }
        let pendingSavedEvent = await waitForPendingItemSavedEvent(on: host)
        let savedEvent = try XCTUnwrap(pendingSavedEvent)
        host.acknowledgePresentation(eventID: savedEvent.eventID)
        await submission.value

        XCTAssertEqual(host.acceptedRun?.runID, Self.canonicalRunID)
        XCTAssertTrue(host.clearedIntake)
        let storedAttempt = try await LocalItemRunSubmissionAttemptStore(
            principalRootDirectory: scopeRoot
        ).loadAttempt()
        XCTAssertNil(storedAttempt)
        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: native.snapshot.photos[0].photoURL.path
            )
        )
        let submittedVoice = try XCTUnwrap(native.snapshot.voice)
        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: submittedVoice.mediaURL.path
            )
        )
        let deferredVoiceURL = scopeRoot
            .appendingPathComponent(
                "DeferredUnmatchedVoices",
                isDirectory: true
            )
            .appendingPathComponent(
                submittedVoice.id.uuidString.lowercased(),
                isDirectory: true
            )
            .appendingPathComponent(
                "voice-\(submittedVoice.id.uuidString).wav"
            )
        XCTAssertEqual(try Data(contentsOf: deferredVoiceURL), Self.fixedVoiceWAV())
        var current = await native.intake.events().makeAsyncIterator()
        guard let currentEvent = await current.next(),
              case .snapshot(let currentSnapshot) = currentEvent else {
            return XCTFail("Expected the active principal snapshot.")
        }
        XCTAssertTrue(currentSnapshot.photos.isEmpty)
        XCTAssertNil(currentSnapshot.voice)
    }

    func testExactVoiceReceiptStillClearsTheWholePrincipalBundle()
        async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(
            "submission-exact-voice-receipt-\(UUID().uuidString)",
            isDirectory: true
        )
        defer { try? FileManager.default.removeItem(at: root) }
        let photoData = SubmissionIntakeFixture.jpeg(
            filling: "exact-voice-receipt",
            repeated: 1
        )
        let voiceData = Self.fixedVoiceWAV()
        let native = try await makeNativePrincipalIntake(
            applicationSupport: root,
            verifiedClerkSubject: "user_exact_voice_receipt",
            photoData: photoData,
            voiceData: voiceData
        )
        let scopeRoot = native.snapshot.photos[0].photoURL
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let scopeProof = try XCTUnwrap(
            ItemRunSubmissionPrincipalScopeProof(filesystemRoot: scopeRoot)
        )
        let receipt = Self.receipt(
            photos: Self.receiptPhotos(for: [photoData]),
            voiceContext: .init(
                version: 1,
                contentSha256: LocalPhotoFingerprint.digest(of: voiceData),
                byteLength: voiceData.count,
                durationMs: 1,
                mediaType: ItemRunSubmissionVoice.mediaType
            )
        )
        let host = ItemRunSubmissionHost(
            coordinator: ItemRunSubmissionCoordinator(
                submitter: RecordingItemRunSubmitter(
                    outcomes: [.created(receipt)]
                ),
                attemptStore: InMemoryItemRunSubmissionAttemptStore(),
                draftStore: RecordingCaptureDraftStore(
                    photos: native.snapshot.photos
                ),
                tokenProvider: TestBearerTokenProvider(
                    principalScopeProof: scopeProof
                ) {
                    "clerk-session-token"
                },
                voiceLocaleHint: { "en-US" },
                newIdempotencyKey: { Self.firstKey }
            )
        )
        host.synchronizePrincipal(
            snapshot: native.snapshot,
            intake: native.intake
        )

        let submission = Task {
            await host.startListing(photos: native.snapshot.photos)
        }
        let pendingSavedEvent = await waitForPendingItemSavedEvent(on: host)
        let savedEvent = try XCTUnwrap(pendingSavedEvent)
        host.acknowledgePresentation(eventID: savedEvent.eventID)
        await submission.value

        XCTAssertTrue(host.clearedIntake)
        XCTAssertFalse(FileManager.default.fileExists(atPath: scopeRoot.path))
        let storedAttempt = try await LocalItemRunSubmissionAttemptStore(
            principalRootDirectory: scopeRoot
        ).loadAttempt()
        XCTAssertNil(storedAttempt)
    }

    func testNullVoiceReceiptPreservesActiveIntakeAndAttemptWhenPhotoRetirementFails()
        async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(
            "submission-failed-photo-retirement-\(UUID().uuidString)",
            isDirectory: true
        )
        defer { try? FileManager.default.removeItem(at: root) }
        let photoData = SubmissionIntakeFixture.jpeg(
            filling: "failed-photo-retirement",
            repeated: 1
        )
        let guardedFiles = FailingAcceptedPhotoRetirementFileManager()
        let native = try await makeNativePrincipalIntake(
            applicationSupport: root,
            verifiedClerkSubject: "user_failed_photo_retirement",
            photoData: photoData,
            voiceData: Self.fixedVoiceWAV(),
            fileManager: guardedFiles
        )
        let scopeRoot = native.snapshot.photos[0].photoURL
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let scopeProof = try XCTUnwrap(
            ItemRunSubmissionPrincipalScopeProof(filesystemRoot: scopeRoot)
        )
        let submitter = RecordingItemRunSubmitter(
            outcomes: [
                .created(
                    Self.receipt(
                        photos: Self.receiptPhotos(for: [photoData])
                    )
                ),
            ]
        )
        let host = ItemRunSubmissionHost(
            coordinator: ItemRunSubmissionCoordinator(
                submitter: submitter,
                attemptStore: InMemoryItemRunSubmissionAttemptStore(),
                draftStore: RecordingCaptureDraftStore(
                    photos: native.snapshot.photos
                ),
                tokenProvider: TestBearerTokenProvider(
                    principalScopeProof: scopeProof
                ) {
                    "clerk-session-token"
                },
                voiceLocaleHint: { "en-US" },
                newIdempotencyKey: { Self.firstKey }
            )
        )
        host.synchronizePrincipal(
            snapshot: native.snapshot,
            intake: native.intake
        )
        guardedFiles.rejectNextCurrentRemoval = true

        let submission = Task {
            await host.startListing(photos: native.snapshot.photos)
        }
        let pendingSavedEvent = await waitForPendingItemSavedEvent(on: host)
        let savedEvent = try XCTUnwrap(pendingSavedEvent)
        host.acknowledgePresentation(eventID: savedEvent.eventID)
        await submission.value

        XCTAssertEqual(host.acceptedRun?.runID, Self.canonicalRunID)
        XCTAssertFalse(host.clearedIntake)
        let storedAttempt = try await LocalItemRunSubmissionAttemptStore(
            principalRootDirectory: scopeRoot
        ).loadAttempt()
        XCTAssertEqual(storedAttempt?.idempotencyKey, Self.firstKey)
        XCTAssertNotNil(storedAttempt?.voiceContext)
        XCTAssertTrue(
            FileManager.default.fileExists(
                atPath: native.snapshot.photos[0].photoURL.path
            )
        )
        XCTAssertTrue(
            FileManager.default.fileExists(
                atPath: try XCTUnwrap(native.snapshot.voice).mediaURL.path
            )
        )
        var current = await native.intake.events().makeAsyncIterator()
        guard let currentEvent = await current.next(),
              case .snapshot(let currentSnapshot) = currentEvent else {
            return XCTFail("Expected the unchanged active snapshot.")
        }
        XCTAssertEqual(currentSnapshot.photos, native.snapshot.photos)
        XCTAssertEqual(currentSnapshot.voice, native.snapshot.voice)
    }

    /// Photo Review's non-final delete is memory-only: the edited set reaches disk
    /// through the Back exit. Submitting is a third exit, so it has to commit that
    /// pending delete the same way, or the receipt validates against photos the durable
    /// draft still holds and the clear silently declines. The seller would then be
    /// charged for a run with nothing on screen to show for it.
    func testPendingDeleteIsCommittedSoTheAcceptedRunStillClearsTheIntake() async {
        let intake = SubmissionIntakeFixture(photoCount: 3)
        let displayed = [intake.photos[0], intake.photos[2]]
        let displayedBytes = displayed.map(intake.bytes(for:))
        let attemptStore = InMemoryItemRunSubmissionAttemptStore()
        // The durable draft still holds all three. Only the screen knows about the delete.
        let draftStore = RecordingCaptureDraftStore(photos: intake.photos)
        let submitter = RecordingItemRunSubmitter(
            outcomes: [
                .created(
                    Self.receipt(photos: Self.receiptPhotos(for: displayedBytes))
                )
            ]
        )
        let coordinator = makeCoordinator(
            intake: intake,
            attemptStore: attemptStore,
            submitter: submitter,
            draftStore: draftStore,
            keys: [Self.firstKey]
        )

        let outcome = await coordinator.submit(photos: displayed)

        XCTAssertEqual(
            outcome,
            .accepted(
                ItemRunAcceptance(
                    run: AcceptedItemRun(
                        runID: Self.canonicalRunID,
                        itemID: Self.canonicalItemID,
                        status: "queued",
                        stage: "queued"
                    ),
                    clearedIntake: true
                )
            )
        )
        let remaining = await draftStore.photos
        XCTAssertTrue(remaining.isEmpty)
        // The deleted photo is not resurrected into the submission.
        let sentDigests = await submitter.payloads.first?.attempt.photos
            .map(\.contentSha256)
        XCTAssertEqual(
            sentDigests,
            displayedBytes.map(LocalPhotoFingerprint.digest(of:))
        )
    }

    func testIntakeChangedDuringFlightSurvivesTheAcceptedRun() async {
        let submitted = SubmissionIntakeFixture(photoCount: 2, seed: "submitted")
        let edited = SubmissionIntakeFixture(photoCount: 3, seed: "edited")
        let attemptStore = InMemoryItemRunSubmissionAttemptStore()
        let draftStore = RecordingCaptureDraftStore(photos: submitted.photos)
        let submitter = RecordingItemRunSubmitter(
            outcomes: [.created(Self.receipt(for: submitted))],
            beforeResponse: { await draftStore.replacePhotosForTest(edited.photos) }
        )
        let coordinator = makeCoordinator(
            intake: submitted,
            attemptStore: attemptStore,
            submitter: submitter,
            draftStore: draftStore,
            keys: [Self.firstKey]
        )

        let outcome = await coordinator.submit(photos: submitted.photos)

        guard case .accepted(let acceptance) = outcome else {
            return XCTFail("The canonical run is still the truth about the server.")
        }
        XCTAssertEqual(acceptance.run.runID, Self.canonicalRunID)
        XCTAssertFalse(acceptance.clearedIntake)
        let remaining = await draftStore.photos
        let discardCount = await draftStore.discardCount
        XCTAssertEqual(remaining, edited.photos)
        XCTAssertEqual(discardCount, 0)
    }

    // MARK: Typed recovery without acceptance

    func testReceiptDescribingAnotherSubmissionNeverClearsIntake() async {
        let intake = SubmissionIntakeFixture(photoCount: 3)
        var spoiled = intake.expectedReceiptPhotos
        spoiled[1] = .init(
            ordinal: 1,
            contentSha256: String(repeating: "f", count: 64),
            byteLength: spoiled[1].byteLength,
            mediaType: spoiled[1].mediaType
        )
        let attemptStore = InMemoryItemRunSubmissionAttemptStore()
        let draftStore = RecordingCaptureDraftStore(photos: intake.photos)
        let submitter = RecordingItemRunSubmitter(
            outcomes: [.created(Self.receipt(photos: spoiled))]
        )
        let coordinator = makeCoordinator(
            intake: intake,
            attemptStore: attemptStore,
            submitter: submitter,
            draftStore: draftStore,
            keys: [Self.firstKey]
        )

        let outcome = await coordinator.submit(photos: intake.photos)

        let remaining = await draftStore.photos
        let discardCount = await draftStore.discardCount
        XCTAssertEqual(outcome, .retained(.receiptMismatch))
        XCTAssertEqual(remaining, intake.photos)
        XCTAssertEqual(discardCount, 0)
    }

    func testConflictRetainsIntakeAndReleasesTheWedgedKey() async {
        let intake = SubmissionIntakeFixture(photoCount: 2)
        let attemptStore = InMemoryItemRunSubmissionAttemptStore()
        let draftStore = RecordingCaptureDraftStore(photos: intake.photos)
        let submitter = RecordingItemRunSubmitter(outcomes: [.conflict])
        let coordinator = makeCoordinator(
            intake: intake,
            attemptStore: attemptStore,
            submitter: submitter,
            draftStore: draftStore,
            keys: [Self.firstKey]
        )

        let outcome = await coordinator.submit(photos: intake.photos)

        let remaining = await draftStore.photos
        let storedAttempt = await attemptStore.attempt
        XCTAssertEqual(outcome, .retained(.conflict))
        XCTAssertEqual(remaining, intake.photos)
        // A key already bound to other bytes can never accept these, so the seller is
        // left free to retry under a fresh one rather than wedged on this one.
        XCTAssertNil(storedAttempt)
    }

    func testDeniedAndRateLimitedSubmissionsKeepTheirKeyAndIntake() async {
        for transport in [
            ItemRunSubmissionTransportOutcome.creditDenied(reason: "allowance_exhausted"),
            .rateLimited(reason: "daily_capacity"),
            .rejected,
            .authenticationRequired
        ] {
            let intake = SubmissionIntakeFixture(photoCount: 1)
            let attemptStore = InMemoryItemRunSubmissionAttemptStore()
            let draftStore = RecordingCaptureDraftStore(photos: intake.photos)
            let submitter = RecordingItemRunSubmitter(outcomes: [transport])
            let coordinator = makeCoordinator(
                intake: intake,
                attemptStore: attemptStore,
                submitter: submitter,
                draftStore: draftStore,
                keys: [Self.firstKey]
            )

            let outcome = await coordinator.submit(photos: intake.photos)

            let remaining = await draftStore.photos
            let storedAttempt = await attemptStore.attempt
            XCTAssertEqual(outcome, .retained(Self.retention(for: transport)))
            XCTAssertEqual(remaining, intake.photos)
            XCTAssertEqual(storedAttempt?.idempotencyKey, Self.firstKey)
        }
    }

    private static func retention(
        for transport: ItemRunSubmissionTransportOutcome
    ) -> ItemRunSubmissionRetention {
        switch transport {
        case .creditDenied(let reason): .creditDenied(reason: reason)
        case .rateLimited(let reason): .rateLimited(reason: reason)
        case .rejected: .rejected
        case .authenticationRequired: .authenticationRequired
        case .conflict: .conflict
        case .ambiguous, .created, .replayed: .ambiguous
        }
    }

    // MARK: Reorder and repeat-submission billing

    func testReorderedIntakeSubmitsAndClearsInTheDisplayedOrder() async {
        let intake = SubmissionIntakeFixture(photoCount: 3)
        let displayed = [intake.photos[2], intake.photos[0], intake.photos[1]]
        // Reordering inside Photo Review only moves photos in memory, so the durable
        // draft is still holding the order the seller started with.
        let draftStore = RecordingCaptureDraftStore(photos: intake.photos)
        let attemptStore = InMemoryItemRunSubmissionAttemptStore()
        let reorderedBytes = displayed.map { intake.bytes(for: $0) }
        let submitter = RecordingItemRunSubmitter(
            outcomes: [
                .created(Self.receipt(photos: Self.receiptPhotos(for: reorderedBytes)))
            ]
        )
        let coordinator = makeCoordinator(
            intake: intake,
            attemptStore: attemptStore,
            submitter: submitter,
            draftStore: draftStore,
            keys: [Self.firstKey]
        )

        let outcome = await coordinator.submit(photos: displayed)

        let payloads = await submitter.payloads
        XCTAssertEqual(payloads.first?.photoData, reorderedBytes)
        guard case .accepted(let acceptance) = outcome else {
            return XCTFail("Expected the reordered submission to be accepted")
        }
        XCTAssertTrue(acceptance.clearedIntake)
        let remaining = await draftStore.photos
        XCTAssertTrue(remaining.isEmpty)
    }

    func testARefusedClearKeepsTheKeySoRetryReplaysInsteadOfBuyingASecondRun() async {
        let intake = SubmissionIntakeFixture(photoCount: 2)
        let added = SubmissionIntakeFixture(photoCount: 1, seed: "added")
        let draftStore = RecordingCaptureDraftStore(photos: intake.photos)
        let attemptStore = InMemoryItemRunSubmissionAttemptStore()
        let submitter = RecordingItemRunSubmitter(
            outcomes: [.created(Self.receipt(for: intake))],
            beforeResponse: {
                await draftStore.replacePhotosForTest(intake.photos + added.photos)
            }
        )
        let coordinator = makeCoordinator(
            intake: intake,
            attemptStore: attemptStore,
            submitter: submitter,
            draftStore: draftStore,
            keys: [Self.firstKey, Self.secondKey]
        )

        _ = await coordinator.submit(photos: intake.photos)

        // Nothing was cleared, so the seller can still submit these exact bytes. Keeping
        // the key makes that an idempotent replay of the run the server already made.
        // Retiring it would mint a second key, and the server would build a second run
        // and reserve a second AI-item credit for one item.
        let storedAttempt = await attemptStore.attempt
        XCTAssertEqual(storedAttempt?.idempotencyKey, Self.firstKey)
    }

    func testIdenticalBytesReuseTheKeyAfterAPhotoIsRemovedAndReAdded() async {
        let first = SubmissionIntakeFixture(photoCount: 2)
        // Same bytes in the same order, but the re-added photo is a new local staging
        // record. Only the bytes decide whether the server treats this as the same
        // submission, so the key has to survive the seller redoing their own photo.
        let reAdded = SubmissionIntakeFixture(photoCount: 2)
        let attemptStore = InMemoryItemRunSubmissionAttemptStore()
        let submitter = RecordingItemRunSubmitter(outcomes: [.ambiguous])
        let merged = SubmissionIntakeFixture.merging(first, reAdded)

        _ = await makeCoordinator(
            intake: first,
            attemptStore: attemptStore,
            submitter: submitter,
            draftStore: RecordingCaptureDraftStore(photos: first.photos),
            keys: [Self.firstKey],
            readData: merged
        ).submit(photos: first.photos)

        _ = await makeCoordinator(
            intake: reAdded,
            attemptStore: attemptStore,
            submitter: RecordingItemRunSubmitter(outcomes: [.ambiguous]),
            draftStore: RecordingCaptureDraftStore(photos: reAdded.photos),
            keys: [Self.secondKey],
            readData: merged
        ).submit(photos: reAdded.photos)

        let storedAttempt = await attemptStore.attempt
        XCTAssertEqual(storedAttempt?.idempotencyKey, Self.firstKey)
    }

    // MARK: Durable attempt identity

    func testStoredAttemptSurvivesRelaunchAndClearsOnlyItself() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("submission-attempt-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let intake = SubmissionIntakeFixture(photoCount: 2)
        let attempt = ItemRunSubmissionAttempt(
            idempotencyKey: Self.firstKey,
            photos: try ItemRunSubmissionSnapshot.make(
                for: intake.photos,
                readData: intake.read
            ).photos
        )

        try await LocalItemRunSubmissionAttemptStore(rootDirectory: root)
            .saveAttempt(attempt)
        let relaunched = LocalItemRunSubmissionAttemptStore(rootDirectory: root)
        let restored = try await relaunched.loadAttempt()

        XCTAssertEqual(restored, attempt)

        let other = ItemRunSubmissionAttempt(
            idempotencyKey: Self.secondKey,
            photos: attempt.photos
        )
        try await relaunched.clearAttempt(other)
        let survived = try await relaunched.loadAttempt()
        XCTAssertEqual(survived, attempt)

        try await relaunched.clearAttempt(attempt)
        let cleared = try await relaunched.loadAttempt()
        XCTAssertNil(cleared)
    }

    func testStoredVoiceAttemptSurvivesRelaunchAndOnlyAnExactReceiptMatches()
        async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("voice-attempt-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let intake = SubmissionIntakeFixture(photoCount: 1)
        let photoSnapshot = try ItemRunSubmissionSnapshot.make(
            for: intake.photos,
            readData: intake.read
        ).photos
        let voice = ItemRunSubmissionVoice(
            assetID: UUID(
                uuidString: "54160000-0000-4000-8000-000000000004"
            )!,
            mediaURL: root
                .appendingPathComponent("Current/Assets/voice.wav"),
            contentSha256: String(repeating: "d", count: 64),
            byteLength: 364,
            durationMilliseconds: 10,
            localeHint: "en-US"
        )
        let attempt = ItemRunSubmissionAttempt(
            idempotencyKey: Self.firstKey,
            photos: photoSnapshot,
            voiceContext: voice
        )

        try await LocalItemRunSubmissionAttemptStore(rootDirectory: root)
            .saveAttempt(attempt)
        let restored = try await LocalItemRunSubmissionAttemptStore(
            rootDirectory: root
        ).loadAttempt()

        XCTAssertEqual(restored, attempt)
        XCTAssertEqual(restored?.voiceContext?.mediaURL, voice.mediaURL)
        XCTAssertEqual(restored?.voiceContext?.localeHint, "en-US")

        let photo = try XCTUnwrap(photoSnapshot.first)
        func receipt(
            voiceReceipt: MobileItemSubmissionEnvelope.VoiceReceipt?
        ) -> MobileItemSubmissionEnvelope.DataPayload {
            .init(
                itemId: UUID(),
                runId: UUID(),
                status: "queued",
                stage: "queued",
                photoIdentity: .init(
                    kind: "content_sha256_set_v1",
                    fingerprint: String(repeating: "a", count: 64)
                ),
                photos: [
                    .init(
                        ordinal: photo.ordinal,
                        contentSha256: photo.contentSha256,
                        byteLength: photo.byteLength,
                        mediaType: photo.mediaType.rawValue
                    )
                ],
                voiceContext: voiceReceipt
            )
        }
        let exact = MobileItemSubmissionEnvelope.VoiceReceipt(
            version: 1,
            contentSha256: voice.contentSha256,
            byteLength: voice.byteLength,
            durationMs: voice.durationMilliseconds,
            mediaType: ItemRunSubmissionVoice.mediaType
        )

        XCTAssertTrue(
            attempt.matchesPhotos(receipt: receipt(voiceReceipt: exact))
        )
        XCTAssertTrue(
            attempt.permitsWholeIntakeCleanup(
                receipt: receipt(voiceReceipt: exact)
            )
        )
        XCTAssertFalse(
            attempt.permitsWholeIntakeCleanup(
                receipt: receipt(voiceReceipt: nil)
            )
        )
        XCTAssertFalse(
            attempt.permitsWholeIntakeCleanup(
                receipt: receipt(
                    voiceReceipt: .init(
                        version: exact.version,
                        contentSha256: String(repeating: "e", count: 64),
                        byteLength: exact.byteLength,
                        durationMs: exact.durationMs,
                        mediaType: exact.mediaType
                    )
                )
            )
        )
    }

    func testPrincipalAttemptStoreRejectsEverySymlinkEscapeIntoForeignScope()
        async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(
            "submission-attempt-symlink-\(UUID().uuidString)",
            isDirectory: true
        )
        defer { try? FileManager.default.removeItem(at: root) }
        let intake = SubmissionIntakeFixture(photoCount: 1)
        let snapshot = try ItemRunSubmissionSnapshot.make(
            for: intake.photos,
            readData: intake.read
        ).photos
        let attemptA = ItemRunSubmissionAttempt(
            idempotencyKey: Self.firstKey,
            photos: snapshot
        )
        let attemptB = ItemRunSubmissionAttempt(
            idempotencyKey: Self.secondKey,
            photos: snapshot
        )
        enum Escape: Equatable {
            case nativeIntakeAncestor
            case principalRoot
            case childStore
        }
        let cases: [(name: String, escape: Escape)] = [
            ("native-intake-ancestor", .nativeIntakeAncestor),
            ("principal-root", .principalRoot),
            ("child-store", .childStore),
        ]

        for testCase in cases {
            let caseRoot = root.appendingPathComponent(
                testCase.name,
                isDirectory: true
            )
            let trustedAnchor = caseRoot.appendingPathComponent(
                "ApplicationSupport",
                isDirectory: true
            )
            let nativeIntakeRoot = trustedAnchor
                .appendingPathComponent("SnapList", isDirectory: true)
                .appendingPathComponent("NativeIntake", isDirectory: true)
            let principalARoot = nativeIntakeRoot.appendingPathComponent(
                "v1-\(String(repeating: "a", count: 64))",
                isDirectory: true
            )
            let foreignAnchor = caseRoot.appendingPathComponent(
                "ForeignApplicationSupport",
                isDirectory: true
            )
            let foreignNativeIntakeRoot = foreignAnchor
                .appendingPathComponent("SnapList", isDirectory: true)
                .appendingPathComponent("NativeIntake", isDirectory: true)
            let foreignPrincipalRoot = foreignNativeIntakeRoot
                .appendingPathComponent(
                    testCase.escape == .nativeIntakeAncestor
                        ? "v1-\(String(repeating: "a", count: 64))"
                        : "v1-\(String(repeating: "b", count: 64))",
                    isDirectory: true
                )
            let foreignStore = LocalItemRunSubmissionAttemptStore(
                principalRootDirectory: foreignPrincipalRoot
            )
            try await foreignStore.saveAttempt(attemptB)

            switch testCase.escape {
            case .nativeIntakeAncestor:
                try FileManager.default.createDirectory(
                    at: trustedAnchor.appendingPathComponent(
                        "SnapList",
                        isDirectory: true
                    ),
                    withIntermediateDirectories: true
                )
                try FileManager.default.createSymbolicLink(
                    at: nativeIntakeRoot,
                    withDestinationURL: foreignNativeIntakeRoot
                )
            case .principalRoot:
                try FileManager.default.createDirectory(
                    at: nativeIntakeRoot,
                    withIntermediateDirectories: true
                )
                try FileManager.default.createSymbolicLink(
                    at: principalARoot,
                    withDestinationURL: foreignPrincipalRoot
                )
            case .childStore:
                try FileManager.default.createDirectory(
                    at: principalARoot,
                    withIntermediateDirectories: true
                )
                try FileManager.default.createSymbolicLink(
                    at: principalARoot.appendingPathComponent(
                        "ItemRunSubmission",
                        isDirectory: true
                    ),
                    withDestinationURL:
                        foreignPrincipalRoot.appendingPathComponent(
                            "ItemRunSubmission",
                            isDirectory: true
                        )
                )
            }

            let storeA = LocalItemRunSubmissionAttemptStore(
                principalRootDirectory: principalARoot
            )
            do {
                _ = try await storeA.loadAttempt()
                XCTFail(
                    "\(testCase.name) let A read foreign attempt bytes."
                )
            } catch {}
            do {
                try await storeA.saveAttempt(attemptA)
                XCTFail(
                    "\(testCase.name) let A overwrite foreign attempt bytes."
                )
            } catch {}
            do {
                try await storeA.clearAttempt(attemptB)
                XCTFail(
                    "\(testCase.name) let A delete foreign attempt bytes."
                )
            } catch {}

            let principalA = PrincipalSubmissionFixture(
                root: principalARoot,
                seed: testCase.name
            )
            let reader = PrincipalPhotoReadRecorder(
                fixtures: [principalA]
            )
            let submitter = RecordingItemRunSubmitter(
                outcomes: [.ambiguous]
            )
            let host = ItemRunSubmissionHost(
                coordinator: ItemRunSubmissionCoordinator(
                    submitter: submitter,
                    attemptStore:
                        InMemoryItemRunSubmissionAttemptStore(),
                    draftStore: RecordingCaptureDraftStore(
                        photos: principalA.photos
                    ),
                    tokenProvider: TestBearerTokenProvider(
                        principalScopeProof:
                            ItemRunSubmissionPrincipalScopeProof(
                                filesystemRoot: principalARoot
                            )
                    ) {
                        "principal-a-bearer"
                    },
                    readData: reader.read,
                    newIdempotencyKey: { Self.firstKey }
                )
            )
            host.synchronizePrincipal(
                snapshot: principalA.snapshot,
                intake: NativeIntake(
                    applicationSupportDirectory: caseRoot,
                    identitySource: .processPrivate
                )
            )

            await host.startListing(photos: principalA.photos)

            let payloads = await submitter.payloads
            let survivingAttemptB =
                try await foreignStore.loadAttempt()
            XCTAssertTrue(payloads.isEmpty, testCase.name)
            XCTAssertEqual(reader.readCount, 0, testCase.name)
            XCTAssertEqual(
                host.retention,
                .attemptNotPersisted,
                testCase.name
            )
            XCTAssertEqual(
                survivingAttemptB,
                attemptB,
                testCase.name
            )
        }
    }

    func testUnreadableStoredAttemptIsDiscardedSoStartListingCannotDieForever() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("submission-attempt-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(
            at: root,
            withIntermediateDirectories: true
        )
        try Data("not json".utf8).write(
            to: root.appendingPathComponent("attempt.json")
        )

        // Refusing forever would be worse than the duplicate it prevents: nothing else
        // clears this file, so one unreadable record would end the seller's ability to
        // list anything. It is removed instead, and the next submission starts clean.
        let restored = try await LocalItemRunSubmissionAttemptStore(
            rootDirectory: root
        ).loadAttempt()

        XCTAssertNil(restored)
        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: root.appendingPathComponent("attempt.json").path
            )
        )
    }

    /// A record whose bytes cannot be read is not a record that is absent. Reporting it
    /// as absent would mint a second key for photos the first submission may already have
    /// committed, and the seller would pay for a second run of one item.
    func testAnAttemptThatCannotBeReadIsNotReportedAsAbsent() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("submission-attempt-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(
            at: root,
            withIntermediateDirectories: true
        )
        // A real live attempt, written by the store itself, whose bytes then cannot be
        // read. Anything less than a regular file would be provably not a submission and
        // is a different case.
        let attemptURL = root.appendingPathComponent("attempt.json")
        let intake = SubmissionIntakeFixture(photoCount: 2)
        let attempt = try ItemRunSubmissionAttempt(
            idempotencyKey: Self.firstKey,
            photos: ItemRunSubmissionSnapshot.make(
                for: intake.photos,
                readData: intake.read
            ).photos
        )
        try await LocalItemRunSubmissionAttemptStore(rootDirectory: root)
            .saveAttempt(attempt)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0],
            ofItemAtPath: attemptURL.path
        )
        defer {
            try? FileManager.default.setAttributes(
                [.posixPermissions: 0o600],
                ofItemAtPath: attemptURL.path
            )
        }

        let store = LocalItemRunSubmissionAttemptStore(rootDirectory: root)

        do {
            let restored = try await store.loadAttempt()
            XCTFail("Expected an unreadable record to fail closed, got \(String(describing: restored))")
        } catch {
            // Failing closed is the point; the caller decides what to do about it.
        }
        // Unlike a record that was read and could not be interpreted, this one survives,
        // because it may still be the only copy of a live key.
        XCTAssertTrue(
            FileManager.default.fileExists(
                atPath: root.appendingPathComponent("attempt.json").path
            )
        )
    }

    /// The same rule one step earlier. `fileExists` answers false both for a path that is
    /// absent and for one it cannot stat, and returning nil for the second mints a fresh
    /// key for photos the first submission may already have committed. Existence has to
    /// come from the same read that fails closed, not from a pre-check that cannot tell
    /// the two apart.
    func testAnAttemptThatCannotBeStattedIsNotReportedAsAbsent() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("submission-attempt-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let intake = SubmissionIntakeFixture(photoCount: 2)
        let attempt = try ItemRunSubmissionAttempt(
            idempotencyKey: Self.firstKey,
            photos: ItemRunSubmissionSnapshot.make(
                for: intake.photos,
                readData: intake.read
            ).photos
        )
        try await LocalItemRunSubmissionAttemptStore(rootDirectory: root)
            .saveAttempt(attempt)
        // An unsearchable containing directory leaves the record in place and writable
        // while every stat of it fails, which is exactly the state the pre-check reported
        // as "no attempt".
        try FileManager.default.setAttributes(
            [.posixPermissions: 0],
            ofItemAtPath: root.path
        )
        defer {
            try? FileManager.default.setAttributes(
                [.posixPermissions: 0o700],
                ofItemAtPath: root.path
            )
        }

        let store = LocalItemRunSubmissionAttemptStore(rootDirectory: root)

        do {
            let restored = try await store.loadAttempt()
            XCTFail(
                "Expected a record that cannot be statted to fail closed, got \(String(describing: restored))"
            )
        } catch {
            // Failing closed is the point; the caller decides what to do about it.
        }
    }

    /// The metadata answer no filesystem will produce: the read succeeds and says nothing
    /// about what is there. An unknown type is not proof that the path holds something
    /// other than a record, so the record is honored instead of deleted. Tightening the
    /// branch to `isRegularFile == true` would delete a live key here.
    func testARecordWhoseTypeCannotBeDeterminedIsHonoredRatherThanDeleted() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("submission-attempt-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let intake = SubmissionIntakeFixture(photoCount: 2)
        let attempt = try ItemRunSubmissionAttempt(
            idempotencyKey: Self.firstKey,
            photos: ItemRunSubmissionSnapshot.make(
                for: intake.photos,
                readData: intake.read
            ).photos
        )
        try await LocalItemRunSubmissionAttemptStore(rootDirectory: root)
            .saveAttempt(attempt)

        let restored = try await LocalItemRunSubmissionAttemptStore(
            rootDirectory: root,
            fileManager: StubbedMetadataFileManager(metadata: .withoutType)
        ).loadAttempt()

        XCTAssertEqual(restored, attempt)
        XCTAssertTrue(
            FileManager.default.fileExists(
                atPath: root.appendingPathComponent("attempt.json").path
            )
        )
    }

    /// A metadata read that fails for any reason other than absence leaves the question
    /// open, and an open question is treated as a live attempt rather than as nothing.
    func testAFailedMetadataReadFailsClosedAndKeepsTheRecord() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("submission-attempt-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let intake = SubmissionIntakeFixture(photoCount: 2)
        let attempt = try ItemRunSubmissionAttempt(
            idempotencyKey: Self.firstKey,
            photos: ItemRunSubmissionSnapshot.make(
                for: intake.photos,
                readData: intake.read
            ).photos
        )
        try await LocalItemRunSubmissionAttemptStore(rootDirectory: root)
            .saveAttempt(attempt)

        let store = LocalItemRunSubmissionAttemptStore(
            rootDirectory: root,
            fileManager: StubbedMetadataFileManager(
                metadata: .failure(CocoaError(.fileReadNoPermission))
            )
        )

        do {
            let restored = try await store.loadAttempt()
            XCTFail(
                "Expected a failed metadata read to fail closed, got \(String(describing: restored))"
            )
        } catch {
            // Failing closed is the point; the caller decides what to do about it.
        }
        XCTAssertTrue(
            FileManager.default.fileExists(
                atPath: root.appendingPathComponent("attempt.json").path
            )
        )
    }

    /// Failing closed on an unreadable record has a cost: nothing can remove it, so while
    /// the read keeps failing every submission refuses. That has to be reserved for
    /// something that could actually be a live attempt. `saveAttempt` only ever writes a
    /// regular file, so anything else at that path is cleared instead of blocking the
    /// seller forever.
    func testSomethingOtherThanARecordIsClearedRatherThanBlockingEverySubmission() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("submission-attempt-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let attemptURL = root.appendingPathComponent("attempt.json")
        try FileManager.default.createDirectory(
            at: attemptURL,
            withIntermediateDirectories: true
        )

        let restored = try await LocalItemRunSubmissionAttemptStore(
            rootDirectory: root
        ).loadAttempt()

        XCTAssertNil(restored)
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: attemptURL.path),
            "A path that was never a submission stayed behind and will refuse every tap"
        )
    }

    /// The coordinator's half of the same rule: a store that cannot answer stops the
    /// submission instead of taking the "no stored attempt" branch.
    func testAStoreThatCannotBeReadStopsBeforeTheNetwork() async {
        let intake = SubmissionIntakeFixture(photoCount: 2)
        let draftStore = RecordingCaptureDraftStore(photos: intake.photos)
        let submitter = RecordingItemRunSubmitter(outcomes: [.created(Self.receipt())])
        let firstKey = Self.firstKey
        let coordinator = ItemRunSubmissionCoordinator(
            submitter: submitter,
            attemptStore: UnreadableItemRunSubmissionAttemptStore(),
            draftStore: draftStore,
            tokenProvider: TestBearerTokenProvider { "clerk-session-token" },
            readData: intake.read,
            newIdempotencyKey: { firstKey }
        )

        let outcome = await coordinator.submit(photos: intake.photos)

        XCTAssertEqual(outcome, .retained(.attemptNotPersisted))
        // Treating the unreadable store as empty would mint a fresh key here and send it,
        // which is the second run the persisted key exists to prevent.
        let payloads = await submitter.payloads
        XCTAssertTrue(payloads.isEmpty)
        let remaining = await draftStore.photos
        XCTAssertEqual(remaining, intake.photos)
    }

    func testAnAttemptWrittenBeforeVersioningIsDiscardedRatherThanBlocking() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("submission-attempt-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(
            at: root,
            withIntermediateDirectories: true
        )
        // Exactly what an earlier build wrote: no schemaVersion key at all. A missing
        // version is stale, not corrupt, so it must not fail closed and strand the
        // seller behind a record that no longer guards anything.
        let legacy = """
        {"idempotencyKey":"\(Self.firstKey.uuidString)","photos":[]}
        """
        try Data(legacy.utf8).write(to: root.appendingPathComponent("attempt.json"))

        let restored = try await LocalItemRunSubmissionAttemptStore(
            rootDirectory: root
        ).loadAttempt()

        XCTAssertNil(restored)
    }

    func testSchemaOnePhotoOnlyAttemptKeepsItsOriginalKeyOnRetry()
        async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("submission-attempt-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(
            at: root,
            withIntermediateDirectories: true
        )
        let intake = SubmissionIntakeFixture(photoCount: 1)
        let legacy = ItemRunSubmissionAttempt(
            idempotencyKey: Self.firstKey,
            photos: try ItemRunSubmissionSnapshot.make(
                for: intake.photos,
                readData: intake.read
            ).photos,
            schemaVersion: 1
        )
        try Data(JSONEncoder().encode(legacy)).write(
            to: root.appendingPathComponent("attempt.json")
        )
        let store = LocalItemRunSubmissionAttemptStore(rootDirectory: root)
        let restored = try await store.loadAttempt()

        XCTAssertEqual(restored?.idempotencyKey, Self.firstKey)
        XCTAssertEqual(restored?.schemaVersion, 1)
        XCTAssertNil(restored?.voiceContext)

        let submitter = RecordingItemRunSubmitter(outcomes: [.ambiguous])
        let coordinator = ItemRunSubmissionCoordinator(
            submitter: submitter,
            attemptStore: store,
            draftStore: RecordingCaptureDraftStore(photos: intake.photos),
            tokenProvider: TestBearerTokenProvider {
                "clerk-session-token"
            },
            readData: intake.read,
            newIdempotencyKey: { Self.secondKey }
        )

        _ = await coordinator.submit(photos: intake.photos)

        let payloads = await submitter.payloads
        XCTAssertEqual(payloads.first?.attempt.idempotencyKey, Self.firstKey)
        XCTAssertEqual(payloads.first?.attempt.schemaVersion, 1)
    }

    func testAnAttemptFromAnotherSchemaVersionIsDiscardedRatherThanBlocking() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("submission-attempt-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(
            at: root,
            withIntermediateDirectories: true
        )
        let intake = SubmissionIntakeFixture(photoCount: 1)
        var stale = ItemRunSubmissionAttempt(
            idempotencyKey: Self.firstKey,
            photos: try ItemRunSubmissionSnapshot.make(
                for: intake.photos,
                readData: intake.read
            ).photos
        )
        stale.schemaVersion = ItemRunSubmissionAttempt.currentSchemaVersion + 1
        try Data(JSONEncoder().encode(stale)).write(
            to: root.appendingPathComponent("attempt.json")
        )

        // Attempts only live while one submission is unresolved, so one written by
        // another version no longer guards anything.
        let restored = try await LocalItemRunSubmissionAttemptStore(
            rootDirectory: root
        ).loadAttempt()

        XCTAssertNil(restored)
    }

    // MARK: Live Start listing boundary

    func testAcceptedPresentationEventCarriesPersistedLogicalIdentityAndCanonicalRun() async throws {
        let cases: [(
            name: String,
            outcome: (
                MobileItemSubmissionEnvelope.DataPayload
            ) -> ItemRunSubmissionTransportOutcome
        )] = [
            ("created", { .created($0) }),
            ("replayed", { .replayed($0) }),
        ]

        for testCase in cases {
            let intake = SubmissionIntakeFixture(
                photoCount: 2,
                seed: testCase.name
            )
            let attemptStore = InMemoryItemRunSubmissionAttemptStore()
            let draftStore = RecordingCaptureDraftStore(photos: intake.photos)
            let receipt = Self.receipt(for: intake)
            let submitter = RecordingItemRunSubmitter(
                outcomes: [testCase.outcome(receipt)],
                attemptStore: attemptStore
            )
            let keySequence = KeySequence(keys: [Self.firstKey])
            let submissionHost = ItemRunSubmissionHost(
                coordinator: ItemRunSubmissionCoordinator(
                    submitter: submitter,
                    attemptStore: attemptStore,
                    draftStore: draftStore,
                    tokenProvider: TestBearerTokenProvider {
                        "clerk-session-token"
                    },
                    readData: intake.read,
                    newIdempotencyKey: { keySequence.next() }
                )
            )

            let submission = Task {
                await submissionHost.startListing(photos: intake.photos)
            }
            guard let savedEvent =
                await waitForPendingAcceptedItemRunHandoff(on: submissionHost)
            else {
                submission.cancel()
                continue
            }
            let expectedRun = AcceptedItemRun(
                runID: receipt.runId,
                itemID: receipt.itemId,
                status: receipt.status,
                stage: receipt.stage
            )

            XCTAssertEqual(
                savedEvent.handoff,
                AcceptedItemRunHandoff(
                    idempotencyKey: Self.firstKey,
                    acceptedRun: expectedRun
                ),
                testCase.name
            )
            XCTAssertEqual(submissionHost.acceptedRun, expectedRun)
            let visibleAttempt = await submitter.attemptVisibleAtFirstCall
            let persistedAttemptBeforeAcknowledgment =
                try await attemptStore.loadAttempt()
            let durablePhotosBeforeAcknowledgment =
                try await draftStore.loadPhotos()
            XCTAssertEqual(
                visibleAttempt?.idempotencyKey,
                Self.firstKey,
                testCase.name
            )
            XCTAssertEqual(
                persistedAttemptBeforeAcknowledgment?.idempotencyKey,
                Self.firstKey,
                testCase.name
            )
            XCTAssertEqual(
                durablePhotosBeforeAcknowledgment,
                intake.photos,
                testCase.name
            )
            XCTAssertFalse(submissionHost.clearedIntake, testCase.name)

            submissionHost.acknowledgePresentation(
                eventID: savedEvent.eventID
            )
            await submission.value

            let persistedAttemptAfterAcknowledgment =
                try await attemptStore.loadAttempt()
            let durablePhotosAfterAcknowledgment =
                try await draftStore.loadPhotos()
            XCTAssertTrue(submissionHost.clearedIntake, testCase.name)
            XCTAssertNil(
                persistedAttemptAfterAcknowledgment,
                testCase.name
            )
            XCTAssertTrue(
                durablePhotosAfterAcknowledgment.isEmpty,
                testCase.name
            )
            if case .itemSaved(
                let eventID,
                let handoff
            )? = submissionHost.pendingPresentationEvent {
                XCTAssertEqual(eventID, savedEvent.eventID, testCase.name)
                XCTAssertEqual(handoff, savedEvent.handoff, testCase.name)
            } else {
                XCTFail(
                    "The accepted \(testCase.name) handoff retired before routing."
                )
            }
        }
    }

    func testValidatedAcceptanceWaitsForMatchingSavedPresentationAcknowledgmentBeforeExactClear() async {
        let intake = SubmissionIntakeFixture(photoCount: 2)
        let eventRecorder = AcceptedPathEventRecorder()
        let attemptStore = AcknowledgedAcceptanceAttemptStore(
            eventRecorder: eventRecorder
        )
        let draftStore = AcknowledgedAcceptanceDraftStore(
            photos: intake.photos,
            eventRecorder: eventRecorder
        )
        let submitter = RecordingItemRunSubmitter(
            outcomes: [.created(Self.receipt(for: intake))],
            beforeResponse: {
                await eventRecorder.record(.canonicalReceiptReturned)
            }
        )
        let keySequence = KeySequence(keys: [Self.firstKey])
        let submissionHost = ItemRunSubmissionHost(
            coordinator: ItemRunSubmissionCoordinator(
                submitter: submitter,
                attemptStore: attemptStore,
                draftStore: draftStore,
                tokenProvider: TestBearerTokenProvider {
                    "clerk-session-token"
                },
                readData: intake.read,
                newIdempotencyKey: { keySequence.next() }
            )
        )
        let transactionHost = PhotoReviewLiveHost()

        let submission = Task {
            guard transactionHost.beginCommit() else {
                return false
            }
            defer { transactionHost.endCommit() }
            await submissionHost.startListing(photos: intake.photos)
            return true
        }
        defer { submission.cancel() }
        guard let savedEvent = await waitForPendingItemSavedEvent(
            on: submissionHost
        ) else {
            return
        }
        let eventID = savedEvent.eventID

        XCTAssertEqual(
            savedEvent.acceptedRun,
            AcceptedItemRun(
                runID: Self.canonicalRunID,
                itemID: Self.canonicalItemID,
                status: "queued",
                stage: "queued"
            )
        )
        XCTAssertEqual(submissionHost.acceptedRun, savedEvent.acceptedRun)
        await eventRecorder.record(.itemSavedObserved(eventID))

        var discardExactlyCount = await draftStore.discardExactlyCount
        var matchingClearCount = await attemptStore.matchingClearCount
        var durablePhotos = await draftStore.photos
        var persistedAttempt = await attemptStore.attempt
        XCTAssertEqual(discardExactlyCount, 0)
        XCTAssertEqual(matchingClearCount, 0)
        XCTAssertEqual(durablePhotos, intake.photos)
        XCTAssertEqual(persistedAttempt?.idempotencyKey, Self.firstKey)
        XCTAssertEqual(
            persistedAttempt?.photos.map(\.photoID),
            intake.photos.map(\.id)
        )
        let persistedAttemptBeforeAcknowledgment = persistedAttempt
        XCTAssertTrue(transactionHost.isCommitting)

        let staleEventID = UUID(
            uuidString: "50300000-0000-4000-8000-0000000000ff"
        )!
        submissionHost.acknowledgePresentation(eventID: staleEventID)

        discardExactlyCount = await draftStore.discardExactlyCount
        matchingClearCount = await attemptStore.matchingClearCount
        durablePhotos = await draftStore.photos
        persistedAttempt = await attemptStore.attempt
        XCTAssertEqual(discardExactlyCount, 0)
        XCTAssertEqual(matchingClearCount, 0)
        XCTAssertEqual(durablePhotos, intake.photos)
        XCTAssertEqual(persistedAttempt?.idempotencyKey, Self.firstKey)
        XCTAssertEqual(
            persistedAttempt?.photos.map(\.photoID),
            intake.photos.map(\.id)
        )
        XCTAssertEqual(persistedAttempt, persistedAttemptBeforeAcknowledgment)
        if case .itemSaved(
            let stillPendingEventID,
            let stillPendingHandoff
        )? =
            submissionHost.pendingPresentationEvent {
            XCTAssertEqual(stillPendingEventID, eventID)
            XCTAssertEqual(
                stillPendingHandoff.acceptedRun,
                savedEvent.acceptedRun
            )
        } else {
            XCTFail("A stale acknowledgment removed the pending saved event.")
        }
        XCTAssertEqual(submissionHost.acceptedRun?.runID, Self.canonicalRunID)
        XCTAssertTrue(transactionHost.isCommitting)

        await eventRecorder.record(.matchingAcknowledgment(eventID))
        submissionHost.acknowledgePresentation(eventID: eventID)
        let transactionLockAcquired = await submission.value

        discardExactlyCount = await draftStore.discardExactlyCount
        matchingClearCount = await attemptStore.matchingClearCount
        durablePhotos = await draftStore.photos
        persistedAttempt = await attemptStore.attempt
        XCTAssertEqual(discardExactlyCount, 1)
        XCTAssertEqual(matchingClearCount, 1)
        XCTAssertTrue(durablePhotos.isEmpty)
        XCTAssertNil(persistedAttempt)
        XCTAssertTrue(transactionLockAcquired)
        XCTAssertFalse(transactionHost.isCommitting)

        submissionHost.acknowledgePresentation(eventID: eventID)

        discardExactlyCount = await draftStore.discardExactlyCount
        matchingClearCount = await attemptStore.matchingClearCount
        XCTAssertEqual(discardExactlyCount, 1)
        XCTAssertEqual(matchingClearCount, 1)

        let events = await eventRecorder.events
        XCTAssertEqual(
            events,
            [
                .canonicalReceiptReturned,
                .itemSavedObserved(eventID),
                .matchingAcknowledgment(eventID),
                .durableExactClearCompleted,
                .conditionalAttemptRetirement,
            ]
        )
    }

    func testCancelledAcceptedPresentationReusesExactAttemptOnlyOnExplicitReplay() async throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory.appendingPathComponent(
            "snaplist-cancelled-accepted-replay-\(UUID().uuidString)",
            isDirectory: true
        )
        let draftRoot = root.appendingPathComponent(
            "draft",
            isDirectory: true
        )
        let attemptRoot = root.appendingPathComponent(
            "attempt",
            isDirectory: true
        )
        let attemptURL = attemptRoot.appendingPathComponent("attempt.json")
        defer { try? fileManager.removeItem(at: root) }

        let renderer = UIGraphicsImageRenderer(
            size: CGSize(width: 400, height: 200)
        )
        let imageData = renderer.jpegData(
            withCompressionQuality: 0.95
        ) { context in
            UIColor.systemBlue.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 200, height: 200))
            UIColor.systemOrange.setFill()
            context.fill(CGRect(x: 200, y: 0, width: 200, height: 200))
        }
        let localDraftStore = LocalCaptureDraftStore(
            rootDirectory: draftRoot
        )
        let staged = try await localDraftStore.append(
            imageData: imageData,
            libraryTransferReceipt: nil
        ).appendedPhoto
        let draftStore = CancellationReplayDraftStore(
            base: localDraftStore
        )
        let attemptStore = CancellationReplayAttemptStore(
            base: LocalItemRunSubmissionAttemptStore(
                rootDirectory: attemptRoot
            )
        )
        let intake = SubmissionIntakeFixture(stagedPhotos: [staged])
        let receipt = Self.receipt(for: intake)
        let submitter = RecordingItemRunSubmitter(
            outcomes: [
                .created(receipt),
                .replayed(receipt),
            ]
        )
        let keySequence = KeySequence(
            keys: [Self.firstKey, Self.secondKey]
        )
        let submissionHost = ItemRunSubmissionHost(
            coordinator: ItemRunSubmissionCoordinator(
                submitter: submitter,
                attemptStore: attemptStore,
                draftStore: draftStore,
                tokenProvider: TestBearerTokenProvider {
                    "clerk-session-token"
                },
                readData: intake.read,
                newIdempotencyKey: { keySequence.next() }
            )
        )
        let transactionHost = PhotoReviewLiveHost()

        let firstSubmission = Task {
            guard transactionHost.beginCommit() else {
                return false
            }
            defer { transactionHost.endCommit() }
            await submissionHost.startListing(photos: intake.photos)
            return true
        }
        defer { firstSubmission.cancel() }
        guard let firstSavedEvent = await waitForPendingItemSavedEvent(
            on: submissionHost
        ) else {
            return
        }
        let expectedRun = AcceptedItemRun(
            runID: receipt.runId,
            itemID: receipt.itemId,
            status: receipt.status,
            stage: receipt.stage
        )
        XCTAssertEqual(firstSavedEvent.acceptedRun, expectedRun)
        XCTAssertEqual(submissionHost.acceptedRun, expectedRun)
        XCTAssertTrue(submissionHost.isSubmitting)
        XCTAssertTrue(transactionHost.isCommitting)
        let discardCountWhilePending =
            await draftStore.discardExactlyCount
        let clearCountWhilePending =
            await attemptStore.matchingClearCount
        let payloadsWhilePending = await submitter.payloads
        XCTAssertEqual(discardCountWhilePending, 0)
        XCTAssertEqual(clearCountWhilePending, 0)
        XCTAssertEqual(payloadsWhilePending.count, 1)

        firstSubmission.cancel()
        let firstLockAcquired = await firstSubmission.value

        XCTAssertTrue(firstLockAcquired)
        XCTAssertFalse(submissionHost.isSubmitting)
        XCTAssertFalse(transactionHost.isCommitting)
        XCTAssertNil(submissionHost.pendingPresentationEvent)
        XCTAssertFalse(submissionHost.clearedIntake)
        XCTAssertNil(submissionHost.retention)

        let storedAttemptAfterCancellation =
            try await attemptStore.loadAttempt()
        let attemptAfterCancellation = try XCTUnwrap(
            storedAttemptAfterCancellation
        )
        let draftAfterCancellation = try await draftStore.loadPhotos()
        let firstDiscardCount = await draftStore.discardExactlyCount
        let firstAttemptClearCount = await attemptStore.matchingClearCount
        let firstPayloads = await submitter.payloads

        XCTAssertEqual(firstPayloads.count, 1)
        let firstPayload = try XCTUnwrap(firstPayloads.first)
        XCTAssertEqual(attemptAfterCancellation.idempotencyKey, Self.firstKey)
        XCTAssertEqual(
            attemptAfterCancellation.photos,
            firstPayload.attempt.photos
        )
        XCTAssertEqual(draftAfterCancellation, intake.photos)
        XCTAssertEqual(firstDiscardCount, 0)
        XCTAssertEqual(firstAttemptClearCount, 0)
        XCTAssertEqual(firstPayload.photoData, intake.expectedBytes)
        XCTAssertTrue(fileManager.fileExists(atPath: attemptURL.path))
        XCTAssertTrue(fileManager.fileExists(atPath: staged.photoURL.path))
        XCTAssertTrue(
            fileManager.fileExists(atPath: staged.thumbnailURL.path)
        )

        submissionHost.acknowledgePresentation(
            eventID: firstSavedEvent.eventID
        )
        let discardCountAfterStaleAcknowledgment =
            await draftStore.discardExactlyCount
        let clearCountAfterStaleAcknowledgment =
            await attemptStore.matchingClearCount
        let payloadsAfterStaleAcknowledgment = await submitter.payloads
        XCTAssertEqual(discardCountAfterStaleAcknowledgment, 0)
        XCTAssertEqual(clearCountAfterStaleAcknowledgment, 0)
        XCTAssertEqual(payloadsAfterStaleAcknowledgment.count, 1)

        let secondSubmission = Task {
            guard transactionHost.beginCommit() else {
                return false
            }
            defer { transactionHost.endCommit() }
            await submissionHost.startListing(photos: intake.photos)
            return true
        }
        defer { secondSubmission.cancel() }
        guard let secondSavedEvent = await waitForPendingItemSavedEvent(
            on: submissionHost
        ) else {
            return
        }

        XCTAssertNotEqual(
            secondSavedEvent.eventID,
            firstSavedEvent.eventID
        )
        XCTAssertEqual(secondSavedEvent.acceptedRun, expectedRun)
        XCTAssertTrue(submissionHost.isSubmitting)
        XCTAssertTrue(transactionHost.isCommitting)

        let replayPresentation = PhotoReviewSubmissionPresentation(
            host: submissionHost
        )
        var announcements: [String] = []
        var acknowledgedEventIDs: [UUID] = []
        var effectConsumer = PhotoReviewSubmissionEffectConsumer()
        effectConsumer.consume(
            replayPresentation,
            postAnnouncement: { announcements.append($0) },
            acknowledgePresentation: { eventID in
                acknowledgedEventIDs.append(eventID)
                submissionHost.acknowledgePresentation(eventID: eventID)
            }
        )
        effectConsumer.consume(
            PhotoReviewSubmissionPresentation(host: submissionHost),
            postAnnouncement: { announcements.append($0) },
            acknowledgePresentation: { eventID in
                acknowledgedEventIDs.append(eventID)
                submissionHost.acknowledgePresentation(eventID: eventID)
            }
        )
        let secondLockAcquired = await secondSubmission.value

        XCTAssertTrue(secondLockAcquired)
        XCTAssertFalse(submissionHost.isSubmitting)
        XCTAssertFalse(transactionHost.isCommitting)
        XCTAssertEqual(announcements, ["Item saved."])
        XCTAssertEqual(
            acknowledgedEventIDs,
            [secondSavedEvent.eventID]
        )
        XCTAssertTrue(submissionHost.clearedIntake)
        if case .itemSaved(
            let pendingEventID,
            let pendingHandoff
        )? = submissionHost.pendingPresentationEvent {
            XCTAssertEqual(pendingEventID, secondSavedEvent.eventID)
            XCTAssertEqual(pendingHandoff.acceptedRun, expectedRun)
        } else {
            XCTFail("The shell-owned saved presentation retired before routing.")
        }

        let finalPayloads = await submitter.payloads
        XCTAssertEqual(finalPayloads.count, 2)
        XCTAssertEqual(
            finalPayloads.map(\.attempt.idempotencyKey),
            [Self.firstKey, Self.firstKey]
        )
        XCTAssertEqual(
            finalPayloads[0].attempt.photos,
            finalPayloads[1].attempt.photos
        )
        XCTAssertEqual(finalPayloads[0].photoData, finalPayloads[1].photoData)
        XCTAssertEqual(finalPayloads[1].photoData, intake.expectedBytes)
        let finalDiscardCount = await draftStore.discardExactlyCount
        let finalAttemptClearCount = await attemptStore.matchingClearCount
        let finalAttempt = try await attemptStore.loadAttempt()
        let finalDraftPhotos = try await draftStore.loadPhotos()
        XCTAssertEqual(finalDiscardCount, 1)
        XCTAssertEqual(finalAttemptClearCount, 1)
        XCTAssertNil(finalAttempt)
        XCTAssertTrue(finalDraftPhotos.isEmpty)
        XCTAssertFalse(fileManager.fileExists(atPath: attemptURL.path))
        XCTAssertFalse(fileManager.fileExists(atPath: staged.photoURL.path))
        XCTAssertFalse(
            fileManager.fileExists(atPath: staged.thumbnailURL.path)
        )

        submissionHost.acknowledgePresentation(
            eventID: secondSavedEvent.eventID
        )
        let discardCountAfterDuplicate =
            await draftStore.discardExactlyCount
        let clearCountAfterDuplicate =
            await attemptStore.matchingClearCount
        let payloadsAfterDuplicate = await submitter.payloads
        XCTAssertEqual(discardCountAfterDuplicate, 1)
        XCTAssertEqual(clearCountAfterDuplicate, 1)
        XCTAssertEqual(payloadsAfterDuplicate.count, 2)
    }

    func testSavedPresentationEffectsAndFinalizationOccurExactlyOncePerEvent() async {
        let firstIntake = SubmissionIntakeFixture(photoCount: 2)
        let firstEventRecorder = AcceptedPathEventRecorder()
        let firstAttemptStore = AcknowledgedAcceptanceAttemptStore(
            eventRecorder: firstEventRecorder
        )
        let firstDraftStore = AcknowledgedAcceptanceDraftStore(
            photos: firstIntake.photos,
            eventRecorder: firstEventRecorder
        )
        let firstSubmitter = RecordingItemRunSubmitter(
            outcomes: [.created(Self.receipt(for: firstIntake))]
        )
        let firstKey = Self.firstKey
        let firstHost = ItemRunSubmissionHost(
            coordinator: ItemRunSubmissionCoordinator(
                submitter: firstSubmitter,
                attemptStore: firstAttemptStore,
                draftStore: firstDraftStore,
                tokenProvider: TestBearerTokenProvider {
                    "clerk-session-token"
                },
                readData: firstIntake.read,
                newIdempotencyKey: { firstKey }
            )
        )

        let firstSubmission = Task {
            await firstHost.startListing(photos: firstIntake.photos)
        }
        defer { firstSubmission.cancel() }
        guard let firstSavedEvent = await waitForPendingItemSavedEvent(
            on: firstHost
        ) else {
            return
        }
        let firstPresentation = PhotoReviewSubmissionPresentation(
            host: firstHost
        )

        XCTAssertEqual(firstPresentation.primaryActionLabel, "Item saved")
        XCTAssertEqual(
            firstPresentation.announcementEvent,
            .itemSaved(eventID: firstSavedEvent.eventID)
        )
        XCTAssertEqual(
            firstPresentation.accessibilityAnnouncement,
            "Item saved."
        )
        XCTAssertFalse(firstPresentation.rendersSubmittedMedia)
        XCTAssertEqual(firstHost.acceptedRun, firstSavedEvent.acceptedRun)

        let wrongEventID = UUID(
            uuidString: "50300000-0000-4000-8000-0000000000ef"
        )!
        firstHost.acknowledgePresentation(eventID: wrongEventID)

        var firstDiscardCount = await firstDraftStore.discardExactlyCount
        var firstAttemptClearCount =
            await firstAttemptStore.matchingClearCount
        var firstPayloads = await firstSubmitter.payloads
        XCTAssertEqual(firstDiscardCount, 0)
        XCTAssertEqual(firstAttemptClearCount, 0)
        XCTAssertEqual(firstPayloads.count, 1)
        XCTAssertTrue(firstHost.isSubmitting)
        if case .itemSaved(let eventID, let handoff)? =
            firstHost.pendingPresentationEvent {
            XCTAssertEqual(eventID, firstSavedEvent.eventID)
            XCTAssertEqual(
                handoff.acceptedRun,
                firstSavedEvent.acceptedRun
            )
        } else {
            XCTFail("A wrong acknowledgment consumed the saved event.")
        }

        var observedEffects: [SavedPresentationEffectObservation] = []
        var effectConsumer = PhotoReviewSubmissionEffectConsumer()
        let consumeFirstPresentation = {
            effectConsumer.consume(
                PhotoReviewSubmissionPresentation(host: firstHost),
                postAnnouncement: { announcement in
                    observedEffects.append(
                        .announcement(
                            announcement,
                            eventID: firstSavedEvent.eventID
                        )
                    )
                },
                acknowledgePresentation: { eventID in
                    observedEffects.append(.acknowledgment(eventID))
                    firstHost.acknowledgePresentation(eventID: eventID)
                }
            )
        }

        consumeFirstPresentation()
        consumeFirstPresentation()
        consumeFirstPresentation()
        firstHost.acknowledgePresentation(
            eventID: firstSavedEvent.eventID
        )
        firstHost.acknowledgePresentation(eventID: wrongEventID)
        await firstSubmission.value

        XCTAssertEqual(
            observedEffects,
            [
                .announcement(
                    "Item saved.",
                    eventID: firstSavedEvent.eventID
                ),
                .acknowledgment(firstSavedEvent.eventID),
            ]
        )
        firstDiscardCount = await firstDraftStore.discardExactlyCount
        firstAttemptClearCount =
            await firstAttemptStore.matchingClearCount
        firstPayloads = await firstSubmitter.payloads
        let firstFinalizationEvents = await firstEventRecorder.events
        XCTAssertEqual(firstDiscardCount, 1)
        XCTAssertEqual(firstAttemptClearCount, 1)
        XCTAssertEqual(firstPayloads.count, 1)
        XCTAssertEqual(
            firstFinalizationEvents,
            [
                .durableExactClearCompleted,
                .conditionalAttemptRetirement,
            ]
        )

        consumeFirstPresentation()
        firstHost.acknowledgePresentation(
            eventID: firstSavedEvent.eventID
        )
        firstHost.acknowledgePresentation(eventID: wrongEventID)

        firstDiscardCount = await firstDraftStore.discardExactlyCount
        firstAttemptClearCount =
            await firstAttemptStore.matchingClearCount
        firstPayloads = await firstSubmitter.payloads
        XCTAssertEqual(
            observedEffects,
            [
                .announcement(
                    "Item saved.",
                    eventID: firstSavedEvent.eventID
                ),
                .acknowledgment(firstSavedEvent.eventID),
            ]
        )
        XCTAssertEqual(firstDiscardCount, 1)
        XCTAssertEqual(firstAttemptClearCount, 1)
        XCTAssertEqual(firstPayloads.count, 1)
        firstHost.completeClearedIntakePresentation()
        XCTAssertNil(firstHost.pendingPresentationEvent)

        let secondIntake = SubmissionIntakeFixture(
            photoCount: 1,
            seed: "genuinely-new-event"
        )
        let secondEventRecorder = AcceptedPathEventRecorder()
        let secondAttemptStore = AcknowledgedAcceptanceAttemptStore(
            eventRecorder: secondEventRecorder
        )
        let secondDraftStore = AcknowledgedAcceptanceDraftStore(
            photos: secondIntake.photos,
            eventRecorder: secondEventRecorder
        )
        let secondSubmitter = RecordingItemRunSubmitter(
            outcomes: [.created(Self.receipt(for: secondIntake))]
        )
        let secondKey = Self.secondKey
        let secondHost = ItemRunSubmissionHost(
            coordinator: ItemRunSubmissionCoordinator(
                submitter: secondSubmitter,
                attemptStore: secondAttemptStore,
                draftStore: secondDraftStore,
                tokenProvider: TestBearerTokenProvider {
                    "clerk-session-token"
                },
                readData: secondIntake.read,
                newIdempotencyKey: { secondKey }
            )
        )

        let secondSubmission = Task {
            await secondHost.startListing(photos: secondIntake.photos)
        }
        defer { secondSubmission.cancel() }
        guard let secondSavedEvent = await waitForPendingItemSavedEvent(
            on: secondHost
        ) else {
            return
        }
        XCTAssertNotEqual(
            secondSavedEvent.eventID,
            firstSavedEvent.eventID
        )

        let consumeSecondPresentation = {
            effectConsumer.consume(
                PhotoReviewSubmissionPresentation(host: secondHost),
                postAnnouncement: { announcement in
                    observedEffects.append(
                        .announcement(
                            announcement,
                            eventID: secondSavedEvent.eventID
                        )
                    )
                },
                acknowledgePresentation: { eventID in
                    observedEffects.append(.acknowledgment(eventID))
                    secondHost.acknowledgePresentation(eventID: eventID)
                }
            )
        }
        consumeSecondPresentation()
        consumeSecondPresentation()
        await secondSubmission.value
        let secondDiscardCount =
            await secondDraftStore.discardExactlyCount
        let secondAttemptClearCount =
            await secondAttemptStore.matchingClearCount
        let secondPayloads = await secondSubmitter.payloads
        let secondFinalizationEvents = await secondEventRecorder.events

        XCTAssertEqual(
            observedEffects,
            [
                .announcement(
                    "Item saved.",
                    eventID: firstSavedEvent.eventID
                ),
                .acknowledgment(firstSavedEvent.eventID),
                .announcement(
                    "Item saved.",
                    eventID: secondSavedEvent.eventID
                ),
                .acknowledgment(secondSavedEvent.eventID),
            ]
        )
        XCTAssertEqual(secondDiscardCount, 1)
        XCTAssertEqual(secondAttemptClearCount, 1)
        XCTAssertEqual(secondPayloads.count, 1)
        XCTAssertEqual(
            secondFinalizationEvents,
            [
                .durableExactClearCompleted,
                .conditionalAttemptRetirement,
            ]
        )
    }

    func testLivePhotoReviewPresentationShowsSavingStateOnceDuringOneRequest() async {
        let intake = SubmissionIntakeFixture(photoCount: 2)
        let responseGate = SubmissionResponseGate()
        let submitter = RecordingItemRunSubmitter(
            outcomes: [.created(Self.receipt(for: intake))],
            beforeResponse: {
                await responseGate.hold()
            }
        )
        let host = ItemRunSubmissionHost(
            coordinator: makeCoordinator(
                intake: intake,
                attemptStore: InMemoryItemRunSubmissionAttemptStore(),
                submitter: submitter,
                keys: [Self.firstKey]
            )
        )
        var announcementTracker = PhotoReviewSubmissionAnnouncementTracker()

        let idle = PhotoReviewSubmissionPresentation(host: host)
        XCTAssertEqual(idle.primaryActionLabel, "Start listing")
        XCTAssertFalse(idle.mutationControlsLocked)
        XCTAssertNil(announcementTracker.consume(idle))

        let submission = Task {
            await host.startListing(photos: intake.photos)
        }
        await responseGate.waitUntilHeld()

        let saving = PhotoReviewSubmissionPresentation(host: host)
        XCTAssertEqual(saving.primaryActionLabel, "Saving your item")
        XCTAssertTrue(saving.mutationControlsLocked)
        XCTAssertEqual(
            announcementTracker.consume(saving),
            "Saving your item."
        )
        XCTAssertNil(
            announcementTracker.consume(
                PhotoReviewSubmissionPresentation(host: host)
            ),
            "Re-rendering the same in-flight state must not announce it twice."
        )

        let savedStateObserved = expectation(
            description: "Accepted submission publishes its pending saved event"
        )
        withObservationTracking {
            _ = host.pendingPresentationEvent
        } onChange: {
            savedStateObserved.fulfill()
        }

        await responseGate.release()
        await fulfillment(of: [savedStateObserved], timeout: 3)
        guard case .itemSaved(let eventID, _)? =
            host.pendingPresentationEvent else {
            return XCTFail("Expected the pending saved presentation event.")
        }
        host.acknowledgePresentation(eventID: eventID)
        await submission.value
        host.completeClearedIntakePresentation()

        let completed = PhotoReviewSubmissionPresentation(host: host)
        XCTAssertEqual(completed.primaryActionLabel, "Start listing")
        XCTAssertFalse(completed.mutationControlsLocked)
        let payloads = await submitter.payloads
        XCTAssertEqual(payloads.count, 1)
    }

    func testStartListingEmitsTheReceiptRunAsTheCanonicalHandoff() async {
        let intake = SubmissionIntakeFixture(photoCount: 5)
        let attemptStore = InMemoryItemRunSubmissionAttemptStore()
        let submitter = RecordingItemRunSubmitter(
            outcomes: [.created(Self.receipt(for: intake))]
        )
        let host = ItemRunSubmissionHost(
            coordinator: makeCoordinator(
                intake: intake,
                attemptStore: attemptStore,
                submitter: submitter,
                keys: [Self.firstKey]
            )
        )

        let submission = Task {
            await host.startListing(photos: intake.photos)
        }
        defer { submission.cancel() }
        guard let savedEvent = await waitForPendingItemSavedEvent(
            on: host
        ) else {
            return
        }

        XCTAssertEqual(savedEvent.acceptedRun.runID, Self.canonicalRunID)
        XCTAssertEqual(
            host.pendingPresentationEvent,
            .itemSaved(
                eventID: savedEvent.eventID,
                handoff: savedEvent.handoff
            )
        )
        XCTAssertTrue(host.isSubmitting)
        XCTAssertFalse(host.clearedIntake)
        host.acknowledgePresentation(eventID: savedEvent.eventID)
        await submission.value
        host.completeClearedIntakePresentation()

        XCTAssertEqual(host.acceptedRun?.runID, Self.canonicalRunID)
        XCTAssertNil(host.retention)
        XCTAssertFalse(host.isSubmitting)
        XCTAssertNil(host.pendingPresentationEvent)
    }

    func testStartListingTappedTwiceSubmitsOnce() async {
        let intake = SubmissionIntakeFixture(photoCount: 2)
        let attemptStore = InMemoryItemRunSubmissionAttemptStore()
        let inFlight = RecordingItemRunSubmitter(
            outcomes: [.created(Self.receipt(for: intake))]
        )
        let host = ItemRunSubmissionHost(
            coordinator: makeCoordinator(
                intake: intake,
                attemptStore: attemptStore,
                submitter: inFlight,
                keys: [Self.firstKey]
            )
        )

        let firstSubmission = Task {
            await host.startListing(photos: intake.photos)
        }
        defer { firstSubmission.cancel() }
        guard let savedEvent = await waitForPendingItemSavedEvent(
            on: host
        ) else {
            return
        }

        XCTAssertTrue(host.isSubmitting)
        XCTAssertFalse(host.clearedIntake)
        XCTAssertEqual(
            host.pendingPresentationEvent,
            .itemSaved(
                eventID: savedEvent.eventID,
                handoff: savedEvent.handoff
            )
        )

        // The second tap lands while the first request is still open.
        await host.startListing(photos: intake.photos)

        var payloads = await inFlight.payloads
        XCTAssertEqual(payloads.count, 1)
        XCTAssertEqual(
            host.pendingPresentationEvent,
            .itemSaved(
                eventID: savedEvent.eventID,
                handoff: savedEvent.handoff
            )
        )

        host.acknowledgePresentation(eventID: savedEvent.eventID)
        await firstSubmission.value
        host.completeClearedIntakePresentation()

        payloads = await inFlight.payloads
        XCTAssertEqual(payloads.count, 1)
        XCTAssertEqual(
            host.acceptedRun?.runID,
            Self.canonicalRunID
        )
        XCTAssertFalse(host.isSubmitting)
        XCTAssertNil(host.pendingPresentationEvent)
    }

    /// `403`, `429`, and `409` each reach the live boundary as their own typed value,
    /// and none of them leaves anything behind that reads as acceptance.
    func testStartListingSurfacesTypedRecoveryWithoutARun() async {
        for transport in [
            ItemRunSubmissionTransportOutcome.creditDenied(reason: "allowance_exhausted"),
            .rateLimited(reason: "daily_capacity"),
            .conflict
        ] {
            let intake = SubmissionIntakeFixture(photoCount: 2)
            let attemptStore = InMemoryItemRunSubmissionAttemptStore()
            let draftStore = RecordingCaptureDraftStore(photos: intake.photos)
            let submitter = RecordingItemRunSubmitter(outcomes: [transport])
            let host = ItemRunSubmissionHost(
                coordinator: makeCoordinator(
                    intake: intake,
                    attemptStore: attemptStore,
                    submitter: submitter,
                    draftStore: draftStore,
                    keys: [Self.firstKey]
                )
            )

            await host.startListing(photos: intake.photos)

            XCTAssertEqual(host.retention, Self.retention(for: transport))
            XCTAssertNil(host.acceptedRun, "\(transport) left a run behind")
            XCTAssertFalse(host.clearedIntake, "\(transport) read as acceptance")
            XCTAssertFalse(host.isSubmitting)
            let remaining = await draftStore.photos
            XCTAssertEqual(remaining, intake.photos, "\(transport) lost the intake")
        }
    }

    // MARK: Helpers

    private static let firstKey = UUID(
        uuidString: "45700000-0000-4000-8000-000000000001"
    )!
    private static let secondKey = UUID(
        uuidString: "45700000-0000-4000-8000-000000000002"
    )!
    private static let canonicalRunID = UUID(
        uuidString: "45700000-0000-4000-8000-00000000000a"
    )!
    private static let canonicalItemID = UUID(
        uuidString: "45700000-0000-4000-8000-00000000000b"
    )!

    /// What a truthful server receipt looks like for exactly these ordered bytes.
    static func receiptPhotos(
        for bytes: [Data]
    ) -> [MobileItemSubmissionEnvelope.PhotoReceipt] {
        bytes.enumerated().map { ordinal, data in
            .init(
                ordinal: ordinal,
                contentSha256: LocalPhotoFingerprint.digest(of: data),
                byteLength: data.count,
                mediaType: "image/jpeg"
            )
        }
    }

    /// A receipt that echoes `intake` exactly, unless a field is deliberately spoiled.
    static func receipt(
        for intake: SubmissionIntakeFixture? = nil,
        runID: UUID? = nil,
        photos: [MobileItemSubmissionEnvelope.PhotoReceipt]? = nil,
        voiceContext: MobileItemSubmissionEnvelope.VoiceReceipt? = nil
    ) -> MobileItemSubmissionEnvelope.DataPayload {
        let echoed = photos ?? (intake?.expectedReceiptPhotos ?? [])
        return MobileItemSubmissionEnvelope.DataPayload(
            itemId: canonicalItemID,
            runId: runID ?? canonicalRunID,
            status: "queued",
            stage: "queued",
            photoIdentity: .init(
                kind: "content_sha256_set_v1",
                fingerprint: String(repeating: "a", count: 64)
            ),
            photos: echoed,
            voiceContext: voiceContext
        )
    }

    private static func fixedVoiceWAV() -> Data {
        Data([
            0x52, 0x49, 0x46, 0x46, 0x26, 0x00, 0x00, 0x00,
            0x57, 0x41, 0x56, 0x45, 0x66, 0x6D, 0x74, 0x20,
            0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
            0x80, 0x3E, 0x00, 0x00, 0x00, 0x7D, 0x00, 0x00,
            0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61,
            0x02, 0x00, 0x00, 0x00, 0x00, 0x00,
        ])
    }

    private func makeNativePrincipalIntake(
        applicationSupport: URL,
        verifiedClerkSubject: String,
        photoData: Data,
        voiceData: Data? = nil,
        fileManager: FileManager = .default
    ) async throws -> (
        intake: NativeIntake,
        snapshot: NativeIntake.Snapshot
    ) {
        let intake = NativeIntake(
            applicationSupportDirectory: applicationSupport,
            identitySource: NativeIntake.IdentitySource(
                current: {
                    NativeIntake.Identity(
                        verifiedClerkSubject: verifiedClerkSubject,
                        persistedAppAttestKeyID: nil
                    )
                },
                changes: { AsyncStream { _ in } }
            ),
            fileManager: fileManager
        )
        let events = await intake.events()
        var iterator = events.makeAsyncIterator()
        guard let initialEvent = await iterator.next(),
              case .snapshot(_) = initialEvent else {
            throw CocoaError(.fileReadUnknown)
        }
        let outcome = await intake.perform(
            .addPhotos([
                NativeIntake.PhotoInput {
                    photoData
                },
            ])
        )
        guard outcome == .committed else {
            throw CocoaError(.fileWriteUnknown)
        }
        if let voiceData {
            let voiceOutcome = await intake.perform(
                .setVoice(
                    NativeIntake.VoiceInput(
                        duration: 0.001,
                        loadData: { voiceData }
                    )
                )
            )
            guard voiceOutcome == .committed else {
                throw CocoaError(.fileWriteUnknown)
            }
        }
        while let event = await iterator.next() {
            if case .snapshot(let snapshot) = event,
               snapshot.photos.count == 1,
               snapshot.voice != nil || voiceData == nil {
                return (intake, snapshot)
            }
        }
        throw CocoaError(.fileReadUnknown)
    }

    private func makeCoordinator(
        intake: SubmissionIntakeFixture,
        attemptStore: InMemoryItemRunSubmissionAttemptStore,
        submitter: RecordingItemRunSubmitter,
        draftStore: RecordingCaptureDraftStore? = nil,
        keys: [UUID],
        readData: (@Sendable (URL) throws -> Data)? = nil,
        tokenProvider: any BearerTokenProviding = TestBearerTokenProvider {
            "clerk-session-token"
        }
    ) -> ItemRunSubmissionCoordinator {
        if let readData {
            let keySequence = KeySequence(keys: keys)
            return ItemRunSubmissionCoordinator(
                submitter: submitter,
                attemptStore: attemptStore,
                draftStore: draftStore ?? RecordingCaptureDraftStore(
                    photos: intake.photos
                ),
                tokenProvider: tokenProvider,
                readData: readData,
                newIdempotencyKey: { keySequence.next() }
            )
        }
        let keySequence = KeySequence(keys: keys)
        return ItemRunSubmissionCoordinator(
            submitter: submitter,
            attemptStore: attemptStore,
            draftStore: draftStore ?? RecordingCaptureDraftStore(
                photos: intake.photos
            ),
            tokenProvider: tokenProvider,
            readData: intake.read,
            newIdempotencyKey: { keySequence.next() }
        )
    }

    private func waitForPendingItemSavedEvent(
        on host: ItemRunSubmissionHost
    ) async -> (
        eventID: UUID,
        handoff: AcceptedItemRunHandoff,
        acceptedRun: AcceptedItemRun
    )? {
        guard let savedEvent =
            await waitForPendingAcceptedItemRunHandoff(on: host)
        else {
            return nil
        }
        return (
            savedEvent.eventID,
            savedEvent.handoff,
            savedEvent.handoff.acceptedRun
        )
    }

    private func waitForPendingAcceptedItemRunHandoff(
        on host: ItemRunSubmissionHost
    ) async -> (eventID: UUID, handoff: AcceptedItemRunHandoff)? {
        if case .itemSaved(let eventID, let handoff)? =
            host.pendingPresentationEvent {
            return (eventID, handoff)
        }
        let handoffPublished = expectation(
            description: "Accepted item-run handoff published"
        )
        withObservationTracking {
            _ = host.pendingPresentationEvent
        } onChange: {
            handoffPublished.fulfill()
        }
        await fulfillment(of: [handoffPublished], timeout: 3)
        guard case .itemSaved(let eventID, let handoff)? =
            host.pendingPresentationEvent else {
            XCTFail("Expected one pending accepted item-run handoff.")
            return nil
        }
        return (eventID, handoff)
    }
}

// MARK: - Fixtures

private enum SavedPresentationEffectObservation: Equatable {
    case announcement(String, eventID: UUID)
    case acknowledgment(UUID)
}

private struct TestBearerTokenProvider: BearerTokenProviding {
    let principalScopeProof: ItemRunSubmissionPrincipalScopeProof?
    let resolve: @Sendable () async throws -> String

    init(
        principalScopeProof:
            ItemRunSubmissionPrincipalScopeProof? = nil,
        resolve: @escaping @Sendable () async throws -> String
    ) {
        self.principalScopeProof = principalScopeProof
        self.resolve = resolve
    }

    func bearerToken() async throws -> String {
        try await resolve()
    }

    func principalBoundBearer() async throws -> PrincipalBoundBearer {
        guard let principalScopeProof else {
            throw BearerTokenProviderError.principalBindingUnavailable
        }
        return PrincipalBoundBearer(
            bearerToken: try await resolve(),
            scopeProof: principalScopeProof
        )
    }
}

private struct PrincipalSubmissionFixture: Sendable {
    let root: URL
    let photos: [StagedCapturePhoto]
    let bytesByPath: [String: Data]
    let snapshot: NativeIntake.Snapshot

    init(root: URL, seed: String) {
        self.root = root.standardizedFileURL
        let assetsRoot = root
            .appendingPathComponent("Current", isDirectory: true)
            .appendingPathComponent("Assets", isDirectory: true)
        let photoID = UUID()
        let photo = StagedCapturePhoto(
            id: photoID,
            photoURL: assetsRoot.appendingPathComponent(
                "photo-\(photoID.uuidString).jpg"
            ),
            thumbnailURL: assetsRoot.appendingPathComponent(
                "thumbnail-\(photoID.uuidString).jpg"
            ),
            createdAt: Date(timeIntervalSince1970: 1_760_000_000)
        )
        let bytes = SubmissionIntakeFixture.jpeg(
            filling: seed,
            repeated: 1
        )
        photos = [photo]
        bytesByPath = [photo.photoURL.path: bytes]
        snapshot = NativeIntake.Snapshot(
            version: NativeIntake.Version(
                activationID: UUID(),
                revision: 1
            ),
            photos: [photo],
            voice: nil,
            recovery: .ready
        )
    }
}

private struct PrincipalGenerationPair {
    let principalA: PrincipalSubmissionFixture
    let principalB: PrincipalSubmissionFixture
    let intake: NativeIntake

    init(caseRoot: URL, aSeed: String, bSeed: String) {
        let applicationSupport = caseRoot.appendingPathComponent(
            "ApplicationSupport",
            isDirectory: true
        )
        let nativeIntakeRoot = applicationSupport
            .appendingPathComponent("SnapList", isDirectory: true)
            .appendingPathComponent("NativeIntake", isDirectory: true)
        principalA = PrincipalSubmissionFixture(
            root: nativeIntakeRoot.appendingPathComponent(
                "v1-\(String(repeating: "a", count: 64))",
                isDirectory: true
            ),
            seed: aSeed
        )
        principalB = PrincipalSubmissionFixture(
            root: nativeIntakeRoot.appendingPathComponent(
                "v1-\(String(repeating: "b", count: 64))",
                isDirectory: true
            ),
            seed: bSeed
        )
        intake = NativeIntake(
            applicationSupportDirectory: applicationSupport,
            identitySource: .processPrivate
        )
    }
}

private final class PrincipalPhotoReadRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private let bytesByPath: [String: Data]
    private var count = 0

    init(fixtures: [PrincipalSubmissionFixture]) {
        bytesByPath = fixtures.reduce(into: [:]) { result, fixture in
            result.merge(fixture.bytesByPath) { _, new in new }
        }
    }

    var read: @Sendable (URL) throws -> Data {
        { [self] url in
            lock.lock()
            count += 1
            let bytes = bytesByPath[url.path]
            lock.unlock()
            guard let bytes else {
                throw CocoaError(.fileNoSuchFile)
            }
            return bytes
        }
    }

    var readCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }

    func reset() {
        lock.lock()
        count = 0
        lock.unlock()
    }
}

/// Ordered staged photos backed by in-memory JPEG bytes, so the coordinator's file
/// reads stay deterministic without touching the durable draft directory.
struct SubmissionIntakeFixture: Sendable {
    let photos: [StagedCapturePhoto]
    private let dataByPath: [String: Data]

    init(photoCount: Int, seed: String = "a") {
        var photos: [StagedCapturePhoto] = []
        var dataByPath: [String: Data] = [:]
        for index in 0..<photoCount {
            let id = UUID()
            let photoURL = URL(
                fileURLWithPath: "/fixture/photo-\(id.uuidString).jpg"
            )
            photos.append(
                StagedCapturePhoto(
                    id: id,
                    photoURL: photoURL,
                    thumbnailURL: URL(
                        fileURLWithPath: "/fixture/thumbnail-\(id.uuidString).jpg"
                    ),
                    createdAt: Date(timeIntervalSince1970: 1_760_000_000)
                )
            )
            dataByPath[photoURL.path] = Self.jpeg(
                filling: "\(seed)-\(index)",
                repeated: index + 1
            )
        }
        self.photos = photos
        self.dataByPath = dataByPath
    }

    /// Backs the fixture with photos a real draft store staged, so a test can drive the
    /// live transaction against files that actually exist on disk.
    init(stagedPhotos photos: [StagedCapturePhoto]) {
        self.photos = photos
        dataByPath = Dictionary(
            uniqueKeysWithValues: photos.map {
                ($0.photoURL.path, (try? Data(contentsOf: $0.photoURL)) ?? Data())
            }
        )
    }

    /// A truthful server receipt for exactly this fixture.
    var receipt: MobileItemSubmissionEnvelope.DataPayload {
        MobileItemSubmissionEnvelope.DataPayload(
            itemId: UUID(),
            runId: UUID(),
            status: "queued",
            stage: "queued",
            photoIdentity: .init(
                kind: "content_sha256_set_v1",
                fingerprint: String(repeating: "a", count: 64)
            ),
            photos: expectedReceiptPhotos
        )
    }

    var read: @Sendable (URL) throws -> Data {
        let dataByPath = dataByPath
        return { url in
            guard let data = dataByPath[url.path] else {
                throw CocoaError(.fileNoSuchFile)
            }
            return data
        }
    }

    func bytes(for photo: StagedCapturePhoto) -> Data {
        dataByPath[photo.photoURL.path]!
    }

    /// One reader covering both fixtures, for a seller who removed a photo and staged
    /// the same image again under a new local record.
    static func merging(
        _ first: SubmissionIntakeFixture,
        _ second: SubmissionIntakeFixture
    ) -> @Sendable (URL) throws -> Data {
        let dataByPath = first.dataByPath.merging(second.dataByPath) { _, new in new }
        return { url in
            guard let data = dataByPath[url.path] else {
                throw CocoaError(.fileNoSuchFile)
            }
            return data
        }
    }

    var expectedBytes: [Data] {
        photos.map { dataByPath[$0.photoURL.path]! }
    }

    var expectedDigests: [String] {
        expectedBytes.map(LocalPhotoFingerprint.digest(of:))
    }

    var expectedByteLengths: [Int] {
        expectedBytes.map(\.count)
    }

    /// What a truthful server receipt for this intake looks like.
    var expectedReceiptPhotos: [MobileItemSubmissionEnvelope.PhotoReceipt] {
        expectedBytes.enumerated().map { ordinal, data in
            .init(
                ordinal: ordinal,
                contentSha256: LocalPhotoFingerprint.digest(of: data),
                byteLength: data.count,
                mediaType: "image/jpeg"
            )
        }
    }

    static func jpeg(filling body: String, repeated: Int) -> Data {
        var data = Data([0xFF, 0xD8, 0xFF])
        for _ in 0..<repeated {
            data.append(Data(body.utf8))
        }
        return data
    }
}

/// Bearer tokens that differ per call, so a replayed one is visible in the recorded
/// lengths without recording or asserting a token value.
final class TokenSequence: @unchecked Sendable {
    private let lock = NSLock()
    private var tokens: [String]

    init(tokens: [String]) {
        self.tokens = tokens
    }

    func next() -> String {
        lock.lock()
        defer { lock.unlock() }
        guard !tokens.isEmpty else { return "clerk-session-token" }
        return tokens.count == 1 ? tokens[0] : tokens.removeFirst()
    }
}

/// Deterministic idempotency keys so a retry can be told from a fresh submission.
final class KeySequence: @unchecked Sendable {
    private let lock = NSLock()
    private var keys: [UUID]

    init(keys: [UUID]) {
        self.keys = keys
    }

    func next() -> UUID {
        lock.lock()
        defer { lock.unlock() }
        guard !keys.isEmpty else { return UUID() }
        return keys.count == 1 ? keys[0] : keys.removeFirst()
    }
}

enum SubmissionAttemptStoreError: Error {
    case unavailable
}

/// A `FileManager` whose metadata read answers the way a real filesystem will not.
///
/// The store's absent, unknown-type, and fail-closed branches turn on what that one read
/// reports. A real file cannot report an unknown type, and only a permission trick reaches
/// the failure, so the store injects the reader and this stands in for it.
private final class StubbedMetadataFileManager: FileManager, @unchecked Sendable {
    enum Metadata {
        /// The read succeeds but carries no file type.
        case withoutType
        /// The read cannot be answered at all.
        case failure(Error)
    }

    private let metadata: Metadata

    init(metadata: Metadata) {
        self.metadata = metadata
        super.init()
    }

    override func attributesOfItem(atPath path: String) throws -> [FileAttributeKey: Any] {
        switch metadata {
        case .withoutType:
            var attributes = try super.attributesOfItem(atPath: path)
            attributes.removeValue(forKey: .type)
            return attributes
        case .failure(let error):
            throw error
        }
    }
}

private final class FailingAcceptedPhotoRetirementFileManager:
    FileManager,
    @unchecked Sendable {
    private let lock = NSLock()
    private var shouldRejectCurrentRemoval = false

    var rejectNextCurrentRemoval: Bool {
        get {
            lock.lock()
            defer { lock.unlock() }
            return shouldRejectCurrentRemoval
        }
        set {
            lock.lock()
            shouldRejectCurrentRemoval = newValue
            lock.unlock()
        }
    }

    override func removeItem(at URL: URL) throws {
        lock.lock()
        let reject = shouldRejectCurrentRemoval
            && URL.lastPathComponent == "Current"
        if reject {
            shouldRejectCurrentRemoval = false
        }
        lock.unlock()
        guard !reject else {
            throw CocoaError(.fileWriteNoPermission)
        }
        try super.removeItem(at: URL)
    }
}

/// A durable store that cannot answer a read, as opposed to one that is empty.
///
/// Writing still works. A store that failed both would reach the same refusal through
/// the save path, which would let a coordinator that ignores the read failure pass.
actor UnreadableItemRunSubmissionAttemptStore: ItemRunSubmissionAttemptStoring {
    private(set) var saved: ItemRunSubmissionAttempt?

    func loadAttempt() async throws -> ItemRunSubmissionAttempt? {
        throw SubmissionAttemptStoreError.unavailable
    }

    func saveAttempt(_ attempt: ItemRunSubmissionAttempt) async throws {
        saved = attempt
    }

    func clearAttempt(_ attempt: ItemRunSubmissionAttempt) async throws {
        guard saved == attempt else { return }
        saved = nil
    }
}

actor InMemoryItemRunSubmissionAttemptStore: ItemRunSubmissionAttemptStoring {
    private(set) var attempt: ItemRunSubmissionAttempt?
    private(set) var saveCount = 0
    private let failsToSave: Bool

    init(attempt: ItemRunSubmissionAttempt? = nil, failsToSave: Bool = false) {
        self.attempt = attempt
        self.failsToSave = failsToSave
    }

    func loadAttempt() async throws -> ItemRunSubmissionAttempt? { attempt }

    func saveAttempt(_ attempt: ItemRunSubmissionAttempt) async throws {
        guard !failsToSave else { throw SubmissionAttemptStoreError.unavailable }
        saveCount += 1
        self.attempt = attempt
    }

    func clearAttempt(_ attempt: ItemRunSubmissionAttempt) async throws {
        guard self.attempt == attempt else { return }
        self.attempt = nil
    }
}

actor RecordingItemRunSubmitter: ItemRunSubmitting {
    private var outcomes: [ItemRunSubmissionTransportOutcome]
    private let attemptStore: InMemoryItemRunSubmissionAttemptStore?
    /// Runs while the request is in flight, so a test can edit the intake underneath it.
    private let beforeResponse: (@Sendable () async -> Void)?
    private(set) var payloads: [ItemRunSubmissionPayload] = []
    private(set) var bearerTokenLengths: [Int] = []
    private(set) var attemptVisibleAtFirstCall: ItemRunSubmissionAttempt?

    init(
        outcomes: [ItemRunSubmissionTransportOutcome],
        attemptStore: InMemoryItemRunSubmissionAttemptStore? = nil,
        beforeResponse: (@Sendable () async -> Void)? = nil
    ) {
        self.outcomes = outcomes
        self.attemptStore = attemptStore
        self.beforeResponse = beforeResponse
    }

    func submit(
        _ payload: ItemRunSubmissionPayload,
        bearerToken: String
    ) async -> ItemRunSubmissionTransportOutcome {
        if payloads.isEmpty {
            attemptVisibleAtFirstCall = try? await attemptStore?.loadAttempt()
        }
        payloads.append(payload)
        await beforeResponse?()
        // Never record the token itself. Its presence and shape are all a test may know.
        bearerTokenLengths.append(bearerToken.count)
        guard !outcomes.isEmpty else { return .ambiguous }
        return outcomes.count == 1 ? outcomes[0] : outcomes.removeFirst()
    }
}

actor SubmissionResponseGate {
    private var isHeld = false
    private var observedCallCount = 0
    private var releasePending = false
    private var heldWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseContinuation: CheckedContinuation<Void, Never>?

    func hold(onCall targetCall: Int) async {
        observedCallCount += 1
        guard observedCallCount == targetCall else {
            return
        }
        await hold()
    }

    func hold() async {
        guard !releasePending else {
            releasePending = false
            return
        }
        isHeld = true
        let waiters = heldWaiters
        heldWaiters.removeAll()
        waiters.forEach { $0.resume() }
        await withCheckedContinuation { continuation in
            releaseContinuation = continuation
        }
    }

    func waitUntilHeld() async {
        guard !isHeld else { return }
        await withCheckedContinuation { continuation in
            heldWaiters.append(continuation)
        }
    }

    func release() {
        guard let releaseContinuation else {
            releasePending = true
            return
        }
        releaseContinuation.resume()
        self.releaseContinuation = nil
    }
}

private actor AcceptedPathEventRecorder {
    enum Event: Equatable {
        case canonicalReceiptReturned
        case itemSavedObserved(UUID)
        case matchingAcknowledgment(UUID)
        case durableExactClearCompleted
        case conditionalAttemptRetirement
    }

    private(set) var events: [Event] = []

    func record(_ event: Event) {
        events.append(event)
    }
}

private actor AcknowledgedAcceptanceAttemptStore: ItemRunSubmissionAttemptStoring {
    private(set) var attempt: ItemRunSubmissionAttempt?
    private(set) var matchingClearCount = 0
    private let eventRecorder: AcceptedPathEventRecorder

    init(eventRecorder: AcceptedPathEventRecorder) {
        self.eventRecorder = eventRecorder
    }

    func loadAttempt() async throws -> ItemRunSubmissionAttempt? {
        attempt
    }

    func saveAttempt(_ attempt: ItemRunSubmissionAttempt) async throws {
        self.attempt = attempt
    }

    func clearAttempt(_ attempt: ItemRunSubmissionAttempt) async throws {
        guard self.attempt == attempt else {
            return
        }
        matchingClearCount += 1
        self.attempt = nil
        await eventRecorder.record(.conditionalAttemptRetirement)
    }
}

private actor AcknowledgedAcceptanceDraftStore: CaptureDraftStoring {
    private(set) var photos: [StagedCapturePhoto]
    private(set) var discardExactlyCount = 0
    private let eventRecorder: AcceptedPathEventRecorder

    init(
        photos: [StagedCapturePhoto],
        eventRecorder: AcceptedPathEventRecorder
    ) {
        self.photos = photos
        self.eventRecorder = eventRecorder
    }

    func load() async throws -> StagedCapturePhoto? {
        photos.first
    }

    func loadPhotos() async throws -> [StagedCapturePhoto] {
        photos
    }

    func stage(
        imageData: Data,
        libraryTransferReceipt: LibraryPhotoTransferReceipt?
    ) async throws -> StagedCapturePhoto {
        throw CaptureDraftStoreError.stagingUnsupported
    }

    func replace(
        photoID: StagedCapturePhoto.ID,
        imageData: Data,
        libraryTransferReceipt: LibraryPhotoTransferReceipt?
    ) async throws -> CaptureDraftReplaceResult {
        throw CaptureDraftStoreError.photoNotStaged
    }

    func replacePhotos(with photos: [StagedCapturePhoto]) async throws {
        let existingByID = Dictionary(
            uniqueKeysWithValues: self.photos.map { ($0.id, $0) }
        )
        guard photos.count <= 5,
              Set(photos.map(\.id)).count == photos.count,
              photos.allSatisfy({ existingByID[$0.id] == $0 }) else {
            throw CaptureDraftStoreError.invalidManifest
        }
        self.photos = photos
    }

    func discard() async throws {
        photos = []
    }

    func discardExactly(_ photos: [StagedCapturePhoto]) async throws -> Bool {
        discardExactlyCount += 1
        guard self.photos == photos else {
            return false
        }
        self.photos = []
        await eventRecorder.record(.durableExactClearCompleted)
        return true
    }
}

private actor CancellationReplayAttemptStore: ItemRunSubmissionAttemptStoring {
    private let base: LocalItemRunSubmissionAttemptStore
    private(set) var matchingClearCount = 0

    init(base: LocalItemRunSubmissionAttemptStore) {
        self.base = base
    }

    func loadAttempt() async throws -> ItemRunSubmissionAttempt? {
        try await base.loadAttempt()
    }

    func saveAttempt(_ attempt: ItemRunSubmissionAttempt) async throws {
        try await base.saveAttempt(attempt)
    }

    func clearAttempt(_ attempt: ItemRunSubmissionAttempt) async throws {
        guard try await base.loadAttempt() == attempt else {
            return
        }
        try await base.clearAttempt(attempt)
        matchingClearCount += 1
    }
}

private actor CancellationReplayDraftStore: CaptureDraftStoring {
    private let base: LocalCaptureDraftStore
    private(set) var discardExactlyCount = 0

    init(base: LocalCaptureDraftStore) {
        self.base = base
    }

    func load() async throws -> StagedCapturePhoto? {
        try await base.load()
    }

    func loadPhotos() async throws -> [StagedCapturePhoto] {
        try await base.loadPhotos()
    }

    func stage(
        imageData: Data,
        libraryTransferReceipt: LibraryPhotoTransferReceipt?
    ) async throws -> StagedCapturePhoto {
        try await base.stage(
            imageData: imageData,
            libraryTransferReceipt: libraryTransferReceipt
        )
    }

    func append(
        imageData: Data,
        libraryTransferReceipt: LibraryPhotoTransferReceipt?
    ) async throws -> CaptureDraftAppendResult {
        try await base.append(
            imageData: imageData,
            libraryTransferReceipt: libraryTransferReceipt
        )
    }

    func replace(
        photoID: StagedCapturePhoto.ID,
        imageData: Data,
        libraryTransferReceipt: LibraryPhotoTransferReceipt?
    ) async throws -> CaptureDraftReplaceResult {
        try await base.replace(
            photoID: photoID,
            imageData: imageData,
            libraryTransferReceipt: libraryTransferReceipt
        )
    }

    func replacePhotos(with photos: [StagedCapturePhoto]) async throws {
        try await base.replacePhotos(with: photos)
    }

    func discard() async throws {
        try await base.discard()
    }

    func discardExactly(_ photos: [StagedCapturePhoto]) async throws -> Bool {
        discardExactlyCount += 1
        return try await base.discardExactly(photos)
    }
}

actor RecordingCaptureDraftStore: CaptureDraftStoring {
    private(set) var photos: [StagedCapturePhoto]
    private(set) var discardCount = 0

    init(photos: [StagedCapturePhoto]) {
        self.photos = photos
    }

    /// Mirrors `LocalCaptureDraftStore`: a replacement may reorder or drop photos the
    /// draft already holds, byte for byte, and nothing else. A permissive double would
    /// let the coordinator commit a set the real store rejects.
    func replacePhotos(with photos: [StagedCapturePhoto]) async throws {
        let existingByID = Dictionary(
            uniqueKeysWithValues: self.photos.map { ($0.id, $0) }
        )
        guard photos.count <= 5,
              Set(photos.map(\.id)).count == photos.count,
              photos.allSatisfy({ existingByID[$0.id] == $0 }) else {
            throw CaptureDraftStoreError.invalidManifest
        }
        self.photos = photos
    }

    /// Stands in for the seller editing their intake while a request is in flight.
    func replacePhotosForTest(_ photos: [StagedCapturePhoto]) {
        self.photos = photos
    }

    func load() async throws -> StagedCapturePhoto? { photos.first }

    func loadPhotos() async throws -> [StagedCapturePhoto] { photos }

    func stage(
        imageData: Data,
        libraryTransferReceipt: LibraryPhotoTransferReceipt?
    ) async throws -> StagedCapturePhoto {
        throw CaptureDraftStoreError.stagingUnsupported
    }

    func replace(
        photoID: StagedCapturePhoto.ID,
        imageData: Data,
        libraryTransferReceipt: LibraryPhotoTransferReceipt?
    ) async throws -> CaptureDraftReplaceResult {
        throw CaptureDraftStoreError.photoNotStaged
    }

    func discard() async throws {
        discardCount += 1
        photos = []
    }

    /// Mirrors `LocalCaptureDraftStore`: the comparison and the deletion happen in one
    /// actor entry, so these tests exercise the real store's guard rather than the
    /// protocol default.
    func discardExactly(_ photos: [StagedCapturePhoto]) async throws -> Bool {
        guard self.photos == photos else { return false }
        try await discard()
        return true
    }
}
