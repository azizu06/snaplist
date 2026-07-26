import XCTest
@testable import SnapList

@MainActor
final class ItemRunSubmissionTests: XCTestCase {
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

    func testAmbiguousResponseRetriesTheIdenticalBytesUnderTheSameKey() async {
        let intake = SubmissionIntakeFixture(photoCount: 3)
        let attemptStore = InMemoryItemRunSubmissionAttemptStore()
        let submitter = RecordingItemRunSubmitter(
            outcomes: [.ambiguous, .replayed(Self.receipt(for: intake))]
        )
        // Each call hands back a different token, and the double records only how long
        // each one was. Distinct lengths are enough to tell a freshly fetched bearer from
        // the first one being replayed, without a test ever holding a token value.
        let tokens = TokenSequence(
            tokens: ["clerk-session-token", "clerk-session-token-renewed"]
        )
        let coordinator = makeCoordinator(
            intake: intake,
            attemptStore: attemptStore,
            submitter: submitter,
            keys: [Self.firstKey, Self.secondKey],
            bearerToken: { tokens.next() }
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
            bearerToken: { "clerk-session-token" },
            readData: submitted.read,
            newIdempotencyKey: { keys.next() }
        )
        let secondCoordinator = ItemRunSubmissionCoordinator(
            submitter: submitter,
            attemptStore: attemptStore,
            draftStore: RecordingCaptureDraftStore(photos: replaced.photos),
            bearerToken: { "clerk-session-token" },
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
        // The record exists, so it may well be a live attempt, but its bytes are not
        // readable.
        try FileManager.default.createDirectory(
            at: root.appendingPathComponent("attempt.json"),
            withIntermediateDirectories: true
        )

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

    /// The coordinator's half of the same rule: a store that cannot answer stops the
    /// submission instead of taking the "no stored attempt" branch.
    func testAStoreThatCannotBeReadStopsBeforeTheNetwork() async {
        let intake = SubmissionIntakeFixture(photoCount: 2)
        let draftStore = RecordingCaptureDraftStore(photos: intake.photos)
        let submitter = RecordingItemRunSubmitter(outcomes: [.created(Self.receipt())])
        let coordinator = ItemRunSubmissionCoordinator(
            submitter: submitter,
            attemptStore: UnreadableItemRunSubmissionAttemptStore(),
            draftStore: draftStore,
            bearerToken: { "clerk-session-token" },
            readData: intake.read,
            newIdempotencyKey: { Self.firstKey }
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

        await host.startListing(photos: intake.photos)

        XCTAssertEqual(host.acceptedRun?.runID, Self.canonicalRunID)
        XCTAssertNil(host.retention)
        XCTAssertFalse(host.isSubmitting)
    }

    func testStartListingTappedTwiceSubmitsOnce() async {
        let intake = SubmissionIntakeFixture(photoCount: 2)
        let attemptStore = InMemoryItemRunSubmissionAttemptStore()
        var host: ItemRunSubmissionHost?
        // The second tap lands while the first request is still open.
        let inFlight = RecordingItemRunSubmitter(
            outcomes: [.created(Self.receipt(for: intake))],
            beforeResponse: { [intake] in
                await host?.startListing(photos: intake.photos)
            }
        )
        host = ItemRunSubmissionHost(
            coordinator: makeCoordinator(
                intake: intake,
                attemptStore: attemptStore,
                submitter: inFlight,
                keys: [Self.firstKey]
            )
        )

        await host?.startListing(photos: intake.photos)

        let payloads = await inFlight.payloads
        XCTAssertEqual(payloads.count, 1)
        XCTAssertEqual(host?.acceptedRun?.runID, Self.canonicalRunID)
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
        runID: UUID = canonicalRunID,
        photos: [MobileItemSubmissionEnvelope.PhotoReceipt]? = nil
    ) -> MobileItemSubmissionEnvelope.DataPayload {
        let echoed = photos ?? (intake?.expectedReceiptPhotos ?? [])
        return MobileItemSubmissionEnvelope.DataPayload(
            itemId: canonicalItemID,
            runId: runID,
            status: "queued",
            stage: "queued",
            photoIdentity: .init(
                kind: "content_sha256_set_v1",
                fingerprint: String(repeating: "a", count: 64)
            ),
            photos: echoed
        )
    }

    private func makeCoordinator(
        intake: SubmissionIntakeFixture,
        attemptStore: InMemoryItemRunSubmissionAttemptStore,
        submitter: RecordingItemRunSubmitter,
        draftStore: RecordingCaptureDraftStore? = nil,
        keys: [UUID],
        readData: (@Sendable (URL) throws -> Data)? = nil,
        bearerToken: @escaping @Sendable () async throws -> String = {
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
                bearerToken: bearerToken,
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
            bearerToken: bearerToken,
            readData: intake.read,
            newIdempotencyKey: { keySequence.next() }
        )
    }
}

// MARK: - Fixtures

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
/// lengths without any test holding a token value.
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
        throw CaptureDraftStoreError.invalidManifest
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
