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

    // MARK: Ambiguous outcome and exact retry

    func testAmbiguousResponseRetriesTheIdenticalBytesUnderTheSameKey() async {
        let intake = SubmissionIntakeFixture(photoCount: 3)
        let attemptStore = InMemoryItemRunSubmissionAttemptStore()
        let submitter = RecordingItemRunSubmitter(
            outcomes: [.ambiguous, .replayed(Self.receipt(for: intake))]
        )
        let coordinator = makeCoordinator(
            intake: intake,
            attemptStore: attemptStore,
            submitter: submitter,
            keys: [Self.firstKey, Self.secondKey]
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

    func testStartListingSurfacesTypedRecoveryWithoutARun() async {
        let intake = SubmissionIntakeFixture(photoCount: 2)
        let attemptStore = InMemoryItemRunSubmissionAttemptStore()
        let submitter = RecordingItemRunSubmitter(
            outcomes: [.creditDenied(reason: "allowance_exhausted")]
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

        XCTAssertNil(host.acceptedRun)
        XCTAssertEqual(
            host.retention,
            .creditDenied(reason: "allowance_exhausted")
        )
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
    init(photos: [StagedCapturePhoto], readingFrom _: LocalCaptureDraftStore) {
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

    func replacePhotos(with photos: [StagedCapturePhoto]) async throws {
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
