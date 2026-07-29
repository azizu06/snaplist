import UIKit
import XCTest
@testable import SnapList
@MainActor
final class NativeIntakeTests: XCTestCase {
    private let files = FileManager.default
    func testRelaunchRestoresFivePhotosVoiceOnlyForMatchingNativePrincipalScope() async throws {
        let identity = NativeIntake.Identity(
            verifiedClerkSubject: "user_native_intake_a",
            persistedAppAttestKeyID: "guest-key-that-must-not-win"
        )
        let (harness, first) = try await makeSession(identity)
        assertEmpty(first.snapshot)
        let photoInputs = try (0..<5).map(harness.photoInput(seed:))
        let photos = try await first.commit(.addPhotos(photoInputs))
        XCTAssertEqual(photos.photos.count, 5)
        let voiceBytes = Data("bounded native intake voice".utf8)
        let voice = NativeIntake.VoiceInput(duration: 8.25, loadData: { voiceBytes })
        let complete = try await first.commit(.setVoice(voice))
        XCTAssertEqual(complete.photos.map(\.id), photos.photos.map(\.id))
        XCTAssertEqual(complete.voice?.duration, 8.25)
        let relaunched = try await harness.makeSession()
        XCTAssertEqual(relaunched.snapshot.photos, complete.photos)
        XCTAssertEqual(relaunched.snapshot.voice, complete.voice)
        await harness.identity.set(.init(
            verifiedClerkSubject: "user_native_intake_b",
            persistedAppAttestKeyID: "guest-key-that-must-not-win"
        ))
        assertEmpty(try await relaunched.nextSnapshot())
        await harness.identity.set(.init(
            verifiedClerkSubject: "user_native_intake_a",
            persistedAppAttestKeyID: "guest-key-that-must-not-win"
        ))
        let returned = try await relaunched.nextSnapshot()
        XCTAssertEqual(returned.photos, complete.photos)
        XCTAssertEqual(returned.voice, complete.voice)
    }
    func testIdentityAdapterUsesClerkBeforePendingOrVerifiedAppAttestKey() async throws {
        let harness = NativeIntakeHarness(identity: .clerk("user_native_intake_gap_a"))
        let inputs = harness.identity
        addTeardownBlock { harness.cleanUp() }
        let firstRead = SuspendedNativeIntakeValue<String?>("user_native_intake_gap_a")
        let source = ClerkAuthenticationComposition.makeNativeIntakeIdentitySource(
            keyStore: inputs,
            verifiedClerkSubject: {
                await firstRead.loadOnce(or: inputs.clerkSubject)
            },
            clerkChanges: inputs.changes,
            appAttestChanges: inputs.changes
        )
        XCTAssertEqual(inputs.subscriptionCount, 2)
        let intake = NativeIntake(applicationSupportDirectory: harness.applicationSupport, identitySource: source)
        let sessionTask = Task { try await NativeIntakeTestSession(intake) }
        await firstRead.waitUntilRequested()
        await inputs.set(clerkSubject: "user_native_intake_gap_b",
            appAttestKey: .init(id: "guest-principal-key", state: .pending)
        )
        await firstRead.resume()
        let session = try await sessionTask.value
        assertEmpty(session.snapshot)
        assertEmpty(try await session.nextSnapshot())
        _ = try await session.commit(.addPhotos([harness.photoInput(seed: 0)]))
        await inputs.set(clerkSubject: nil,
            appAttestKey: .init(id: "guest-principal-key", state: .pending)
        )
        assertEmpty(try await session.nextSnapshot())
        _ = try await session.commit(.addPhotos([harness.photoInput(seed: 1)]))
        await inputs.set(clerkSubject: nil,
            appAttestKey: .init(id: "guest-principal-key", state: .verified)
        )
        let guest = try await session.commit(.addPhotos([harness.photoInput(seed: 2)]))
        XCTAssertEqual(guest.photos.count, 2)
        await inputs.set(clerkSubject: "user_native_intake_gap_b",
            appAttestKey: .init(id: "guest-principal-key", state: .verified)
        )
        let returnedAuthenticated = try await session.nextSnapshot()
        XCTAssertEqual(returnedAuthenticated.photos.count, 1)
    }
    func testFivePhotoSelectionCommitsAllOrNone() async throws {
        let harness = NativeIntakeHarness(identity: .clerk("user_native_intake_batch"))
        let guardedFiles = NativeIntakeTestFileManager()
        let session = try await harness.makeSession(fileManager: guardedFiles)
        addTeardownBlock { harness.cleanUp() }
        let photoData = try (0..<5).map(harness.makeJPEG)
        var failedInputs = photoData.map { data in
            NativeIntake.PhotoInput(loadData: { data })
        }
        failedInputs[2] = NativeIntake.PhotoInput {
            throw NativeIntakeTestFailure.unavailableSource
        }
        let failed = await session.perform(.addPhotos(failedInputs))
        XCTAssertEqual(failed, .rejected(.sourceUnavailable))
        assertEmpty(try await session.inspect())
        let inputs = photoData.map { data in
            NativeIntake.PhotoInput(loadData: { data })
        }
        guardedFiles.failNextFileOperation = .assetProtection
        let assetFailure = await session.perform(.addPhotos(inputs))
        XCTAssertEqual(assetFailure, .rejected(.storageFailure))
        assertEmpty(try await session.inspect())
        XCTAssertTrue(harness.regularFileNames().isEmpty)
        guardedFiles.failNextFileOperation = .generationPublication
        let publicationFailure = await session.perform(.addPhotos(inputs))
        XCTAssertEqual(publicationFailure, .rejected(.storageFailure))
        assertEmpty(try await session.inspect())
        XCTAssertTrue(harness.regularFileNames().isEmpty)
        let initial = try await session.commit(.addPhotos([inputs[0]]))
        let priorFiles = harness.regularFileNames()
        try assertProtectedAndBackupExcluded(harness.regularFileURLs())
        guardedFiles.failNextFileOperation = .manifestProtection
        let outcome = await session.perform(.addPhotos(Array(inputs.dropFirst())))
        XCTAssertEqual(outcome, .rejected(.storageFailure))
        let surviving = try await session.inspect()
        XCTAssertEqual(surviving, initial)
        XCTAssertEqual(harness.regularFileNames(), priorFiles)
        let recoveredPrior = try await harness.makeSession(fileManager: guardedFiles)
        XCTAssertEqual(recoveredPrior.snapshot, initial)
        let committed = try await session.commit(.addPhotos(Array(inputs.dropFirst())))
        XCTAssertEqual(committed.photos.count, 5)
        XCTAssertEqual(Set(committed.photos.map(\.id)).count, 5)
        let recovered = try await harness.makeSession()
        XCTAssertEqual(recovered.snapshot.photos, committed.photos)
    }
    func testPrincipalRoundTripSupersedesSuspendedMutationWithoutPublication() async throws {
        try await assertPrincipalRoundTripSupersedes(.beforeSourceLoad)
    }
    func testPrincipalRoundTripSupersedesPostStagingMutationWithoutPublication() async throws {
        try await assertPrincipalRoundTripSupersedes(.afterStaging)
    }
    func testConcurrentSameRevisionKeepsFirstCommitAndSupersedesSecond() async throws {
        let (harness, session) = try await makeSession(.clerk("user_native_intake_concurrent"))
        let firstSource = SuspendedNativeIntakeValue(try harness.makeJPEG(seed: 1))
        let secondSource = SuspendedNativeIntakeValue(try harness.makeJPEG(seed: 2))
        let firstOperation = Task {
            await session.perform(
                .addPhotos([.init(loadData: { await firstSource.load() })])
            )
        }
        let secondOperation = Task {
            await session.perform(
                .addPhotos([.init(loadData: { await secondSource.load() })])
            )
        }
        await firstSource.waitUntilRequested()
        await secondSource.waitUntilRequested()
        await firstSource.resume()
        let firstOutcome = await firstOperation.value
        XCTAssertEqual(firstOutcome, .committed)
        let firstSnapshot = try await session.nextSnapshot()
        XCTAssertEqual(firstSnapshot.photos.count, 1)
        await secondSource.resume()
        let secondOutcome = await secondOperation.value
        XCTAssertEqual(secondOutcome, .superseded)
        let surviving = try await session.inspect()
        XCTAssertEqual(surviving.photos, firstSnapshot.photos)
    }
    func testExactDiscardIncludesVoiceAndCannotDeleteLaterRevision() async throws {
        let (harness, session) = try await makeSession(.clerk("user_native_intake_discard"))
        _ = try await session.commit(.addPhotos([harness.photoInput(seed: 1)]))
        let prior = try await session.commit(.setVoice(voice("voice", duration: 4)))
        let later = try await session.commit(.addPhotos([harness.photoInput(seed: 2)]))
        let staleDiscard = await session.perform(.discard(expected: prior.version))
        XCTAssertEqual(staleDiscard, .superseded)
        XCTAssertTrue(files.fileExists(atPath: later.photos[1].photoURL.path))
        XCTAssertTrue(files.fileExists(atPath: later.voice!.mediaURL.path))
        let exactDiscard = await session.perform(.discard(expected: later.version))
        XCTAssertEqual(exactDiscard, .committed)
        assertEmpty(try await session.nextSnapshot())
        XCTAssertFalse(files.fileExists(atPath: later.photos[1].photoURL.path))
        XCTAssertFalse(files.fileExists(atPath: later.voice!.mediaURL.path))
    }
    func testClosedMutationsPublishAndRecoverOneCompleteBundleRevision() async throws {
        let (harness, session) = try await makeSession(.clerk("user_native_intake_mutations"))
        let inputs = try (0..<3).map(harness.photoInput(seed:))
        let added = try await session.commit(.addPhotos(inputs))
        let voiced = try await session.commit(.setVoice(voice("mutation voice", duration: 5)))
        let replaced = try await session.commit(
            .replacePhoto(
                id: added.photos[1].id,
                with: harness.photoInput(seed: 4)
            )
        )
        XCTAssertNotEqual(replaced.photos[1].id, added.photos[1].id)
        XCTAssertEqual(replaced.voice, voiced.voice)
        let reversedIDs = replaced.photos.map(\.id).reversed()
        let reordered = try await session.commit(
            .reorderPhotos(Array(reversedIDs))
        )
        XCTAssertEqual(reordered.photos.map(\.id), Array(reversedIDs))
        let removedID = reordered.photos[1].id
        let removed = try await session.commit(.removePhoto(id: removedID))
        XCTAssertFalse(removed.photos.contains { $0.id == removedID })
        XCTAssertEqual(removed.photos.count, 2)
        let voiceURL = try XCTUnwrap(removed.voice?.mediaURL)
        let deletedVoice = await session.perform(.deleteVoice)
        XCTAssertEqual(deletedVoice, .committed)
        let final = try await session.nextSnapshot()
        XCTAssertNil(final.voice)
        XCTAssertFalse(files.fileExists(atPath: voiceURL.path))
        let recovered = try await harness.makeSession()
        XCTAssertEqual(recovered.snapshot, final)
    }
    func testTransitionDismissesOnlyAnActivePhotoReview() async throws {
        let (harness, session) = try await makeSession(.clerk("user_native_intake_review_a"))
        await harness.identity.set(.clerk("user_native_intake_review_b"))
        _ = try await session.nextSnapshot()
        await harness.identity.set(.clerk("user_native_intake_review_a"))
        _ = try await session.nextSnapshot()
        let entered = await session.perform(.photoReviewEntered)
        XCTAssertEqual(entered, .committed)
        await harness.identity.set(.clerk("user_native_intake_review_b"))
        let dismissal = await session.nextEvent()
        XCTAssertEqual(dismissal, .dismissActivePhotoReview)
        _ = try await session.nextSnapshot()
    }
    func testNoIdentityUsesProcessPrivateTemporaryStateThatReconstructionCannotRecover() async throws {
        let (harness, first) = try await makeSession(.none)
        _ = try await first.commit(.addPhotos([harness.photoInput(seed: 4)]))
        let privateSnapshot = try await first.commit(
            .setVoice(voice("temporary voice", duration: 3))
        )
        let privatePhotoURL = privateSnapshot.photos[0].photoURL
        XCTAssertTrue(privatePhotoURL.path.hasPrefix(files.temporaryDirectory.path))
        XCTAssertFalse(files.fileExists(atPath: harness.applicationSupport.path))
        let reconstructed = try await harness.makeSession()
        assertEmpty(reconstructed.snapshot)
        XCTAssertTrue(files.fileExists(atPath: privatePhotoURL.path))
    }
    func testScheduledExpiryDeletesDurableAndEphemeralStateButRetriesUnreadableMetadata() async throws {
        let start = Date(timeIntervalSince1970: 2_000_000_000)
        let clock = NativeIntakeTestClock(now: start)
        let durableHarness = NativeIntakeHarness(identity: .clerk("user_native_intake_retention_a"))
        let ephemeralHarness = NativeIntakeHarness(identity: .none)
        addTeardownBlock { durableHarness.cleanUp() }
        addTeardownBlock { ephemeralHarness.cleanUp() }
        let uppercaseScope = durableHarness.applicationSupport
            .appendingPathComponent("SnapList/NativeIntake", isDirectory: true)
            .appendingPathComponent("v1-\(String(repeating: "A", count: 64))", isDirectory: true)
        try files.createDirectory(at: uppercaseScope, withIntermediateDirectories: true)
        let uppercaseSentinel = uppercaseScope.appendingPathComponent("foreign")
        try Data("foreign".utf8).write(to: uppercaseSentinel)
        let guardedFiles = NativeIntakeTestFileManager()
        let durable = try await durableHarness.makeSession(
            fileManager: guardedFiles, now: clock.now, sleepUntil: clock.sleep
        )
        let ephemeral = try await ephemeralHarness.makeSession(
            fileManager: guardedFiles, now: clock.now, sleepUntil: clock.sleep
        )
        let durableSnapshot = try await durable.commit(
            .addPhotos([durableHarness.photoInput(seed: 1)])
        )
        let ephemeralSnapshot = try await ephemeral.commit(
            .addPhotos([ephemeralHarness.photoInput(seed: 2)])
        )
        await ephemeralHarness.identity.set(.clerk("user_native_intake_ephemeral_durable"))
        assertEmpty(try await ephemeral.nextSnapshot())
        guardedFiles.failNextFileOperation = .rootDeletions(2)
        let removalBaseline = guardedFiles.rootRemovalAttemptCount
        clock.advance(by: NativeIntake.recoveryWindow + 1)
        for _ in 0..<100 where guardedFiles.rootRemovalAttemptCount < removalBaseline + 2 {
            await Task.yield()
        }
        XCTAssertEqual(guardedFiles.rootRemovalAttemptCount, removalBaseline + 2)
        for _ in 0..<20 { await Task.yield() }
        XCTAssertEqual(guardedFiles.rootRemovalAttemptCount, removalBaseline + 2)
        XCTAssertTrue(files.fileExists(atPath: ephemeralSnapshot.photos[0].photoURL.path))
        XCTAssertTrue(files.fileExists(atPath: durableSnapshot.photos[0].photoURL.path))
        let discard = await durable.perform(.discard(expected: durableSnapshot.version))
        XCTAssertEqual(discard, .committed)
        assertEmpty(try await durable.nextSnapshot())
        let renewed = try await durable.commit(.addPhotos([durableHarness.photoInput(seed: 3)]))
        let renewedDeadline = clock.now().addingTimeInterval(NativeIntake.recoveryWindow)
        clock.advance(by: NativeIntake.retentionRetryInterval)
        await ephemeralHarness.waitForRemoval(of: ephemeralSnapshot.photos[0].photoURL)
        XCTAssertEqual(clock.nextDeadline, renewedDeadline)
        XCTAssertTrue(files.fileExists(atPath: renewed.photos[0].photoURL.path))
        XCTAssertTrue(files.fileExists(atPath: uppercaseSentinel.path))
        await durableHarness.identity.set(.clerk("user_native_intake_retention_b"))
        assertEmpty(try await durable.nextSnapshot())
        guardedFiles.rejectManifestMetadataReads = true
        clock.advance(by: NativeIntake.recoveryWindow + 1)
        XCTAssertTrue(files.fileExists(atPath: renewed.photos[0].photoURL.path))
        await durableHarness.identity.set(.clerk("user_native_intake_retention_a"))
        let pending = try await durable.nextSnapshot()
        XCTAssertEqual(pending.recovery, .pending)
        guardedFiles.rejectManifestMetadataReads = false
        clock.advance(by: NativeIntake.retentionRetryInterval)
        let retried = try await durable.nextSnapshot()
        XCTAssertEqual(retried.recovery, .ready)
        XCTAssertTrue(retried.photos.isEmpty)
        XCTAssertFalse(files.fileExists(atPath: renewed.photos[0].photoURL.path))
        for location in NativeIntakeSymlinkLocation.allCases {
            try await assertSymlinkFence(location)
        }
    }
    private func assertSymlinkFence(_ location: NativeIntakeSymlinkLocation) async throws {
        let harness = NativeIntakeHarness(
            identity: .clerk("user_native_intake_symlink_\(location)")
        )
        let session = try await harness.makeSession()
        let initial = try await session.commit(
            .addPhotos([harness.photoInput(seed: 3)])
        )
        let assetsRoot = try XCTUnwrap(
            initial.photos.first?.photoURL.deletingLastPathComponent()
        )
        let principalRoot = assetsRoot
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let target: URL
        switch location {
        case .ancestor:
            target = principalRoot.deletingLastPathComponent()
        case .principal:
            target = principalRoot
        case .assets:
            target = assetsRoot
        }
        let outside = files.temporaryDirectory.appendingPathComponent(
            "snaplist-native-intake-outside-\(UUID().uuidString)",
            isDirectory: true
        )
        let parked = files.temporaryDirectory.appendingPathComponent(
            "snaplist-native-intake-parked-\(UUID().uuidString)",
            isDirectory: true
        )
        addTeardownBlock {
            harness.cleanUp()
            try? self.files.removeItem(at: outside)
            try? self.files.removeItem(at: parked)
        }
        try files.createDirectory(at: outside, withIntermediateDirectories: true)
        let sentinel = outside.appendingPathComponent("foreign-media")
        try Data("foreign".utf8).write(to: sentinel)
        try files.moveItem(at: target, to: parked)
        try files.createSymbolicLink(
            at: target,
            withDestinationURL: outside
        )
        let write = await session.perform(
            .addPhotos([try harness.photoInput(seed: 4)])
        )
        XCTAssertEqual(write, .rejected(.storageFailure))
        let surviving = try await session.inspect()
        XCTAssertEqual(surviving, initial)
        let recovered = try await harness.makeSession()
        XCTAssertEqual(recovered.snapshot.recovery, .pending)
        let discard = await session.perform(
            .discard(expected: initial.version)
        )
        XCTAssertEqual(discard, .rejected(.storageFailure))
        XCTAssertEqual(try Data(contentsOf: sentinel), Data("foreign".utf8))
    }
    private func assertPrincipalRoundTripSupersedes(
        _ suspension: NativeIntakeSuspensionPoint
    ) async throws {
        let (harness, _) = try await makeSession(
            .clerk("user_native_intake_race_a")
        )
        let fileManager: FileManager
        let input: NativeIntake.PhotoInput
        let waitForSuspension: () async -> Void
        let resume: () async -> Void
        switch suspension {
        case .beforeSourceLoad:
            let source = SuspendedNativeIntakeValue(
                try harness.makeJPEG(seed: 1)
            )
            fileManager = .default
            input = .init(loadData: { await source.load() })
            waitForSuspension = { await source.waitUntilRequested() }
            resume = { await source.resume() }
        case .afterStaging:
            let manager = SuspendedNativeIntakeFileManager()
            fileManager = manager
            input = try harness.photoInput(seed: 3)
            waitForSuspension = {
                await manager.waitUntilPhotoAssetsAreWritten()
            }
            resume = { manager.resumeStaging() }
        }
        let session = try await harness.makeSession(fileManager: fileManager)
        let operation = Task {
            await session.perform(.addPhotos([input]))
        }
        await waitForSuspension()
        await harness.identity.set(.clerk("user_native_intake_race_b"))
        assertEmpty(try await session.nextSnapshot())
        await harness.identity.set(.clerk("user_native_intake_race_a"))
        assertEmpty(try await session.nextSnapshot())
        await resume()
        let outcome = await operation.value
        XCTAssertEqual(outcome, .superseded)
        assertEmpty(try await session.inspect())
    }
    private func assertEmpty(
        _ snapshot: NativeIntake.Snapshot,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        XCTAssertTrue(snapshot.photos.isEmpty, file: file, line: line)
        XCTAssertNil(snapshot.voice, file: file, line: line)
    }
    private func assertProtectedAndBackupExcluded(
        _ urls: [URL],
        file: StaticString = #filePath, line: UInt = #line
    ) throws {
        for url in urls {
            let attributes = try files.attributesOfItem(atPath: url.path)
            XCTAssertEqual(
                attributes[.protectionKey] as? FileProtectionType,
                .complete,
                file: file,
                line: line
            )
            XCTAssertEqual(
                try url.resourceValues(
                    forKeys: [.isExcludedFromBackupKey]
                ).isExcludedFromBackup,
                true,
                file: file,
                line: line
            )
        }
    }
    private func voice(_ text: String, duration: TimeInterval) -> NativeIntake.VoiceInput {
        .init(duration: duration, loadData: { Data(text.utf8) })
    }
    private func makeSession(_ identity: NativeIntake.Identity) async throws
        -> (NativeIntakeHarness, NativeIntakeTestSession) {
        let harness = NativeIntakeHarness(identity: identity)
        addTeardownBlock { harness.cleanUp() }
        return (harness, try await harness.makeSession())
    }
}
private enum NativeIntakeTestFailure: Error { case unavailableSource }
private enum NativeIntakeSuspensionPoint {
    case beforeSourceLoad
    case afterStaging
}
private enum NativeIntakeSymlinkLocation: String, CaseIterable {
    case ancestor
    case principal
    case assets
}
extension NativeIntake.Identity {
    static func clerk(_ subject: String) -> Self {
        .init(verifiedClerkSubject: subject, persistedAppAttestKeyID: nil)
    }

    static let none = Self(verifiedClerkSubject: nil, persistedAppAttestKeyID: nil)
}
extension NativeIntake.Event {
    var snapshot: NativeIntake.Snapshot? {
        guard case .snapshot(let snapshot) = self else {
            return nil
        }
        return snapshot
    }
}
@MainActor
final class NativeIntakeTestSession {
    let intake: NativeIntake
    private var events: AsyncStream<NativeIntake.Event>.AsyncIterator
    private(set) var snapshot: NativeIntake.Snapshot
    init(_ intake: NativeIntake) async throws {
        self.intake = intake
        var iterator = await intake.events().makeAsyncIterator()
        let event = await iterator.next()
        events = iterator
        snapshot = try XCTUnwrap(event?.snapshot)
    }
    func perform(
        _ operation: NativeIntake.Operation
    ) async -> NativeIntake.Outcome {
        await intake.perform(operation)
    }
    func commit(
        _ operation: NativeIntake.Operation,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async throws -> NativeIntake.Snapshot {
        let outcome = await perform(operation)
        XCTAssertEqual(outcome, .committed, file: file, line: line)
        return try await nextSnapshot()
    }
    func nextEvent() async -> NativeIntake.Event? {
        var iterator = events
        let event = await iterator.next()
        events = iterator
        return event
    }
    func nextSnapshot() async throws -> NativeIntake.Snapshot {
        let event = await nextEvent()
        snapshot = try XCTUnwrap(event?.snapshot)
        return snapshot
    }
    func inspect() async throws -> NativeIntake.Snapshot {
        var inspection = await intake.events().makeAsyncIterator()
        let event = await inspection.next()
        return try XCTUnwrap(event?.snapshot)
    }
}
@MainActor
final class NativeIntakeHarness {
    let fileManager = FileManager.default
    let applicationSupport: URL
    let identity: TestNativeIntakeIdentity
    init(
        identity: NativeIntake.Identity,
        applicationSupport: URL? = nil
    ) {
        self.applicationSupport = applicationSupport
            ?? fileManager.temporaryDirectory.appendingPathComponent(
                "snaplist-native-intake-\(UUID().uuidString)",
                isDirectory: true
            )
        self.identity = TestNativeIntakeIdentity(identity)
    }
    func makeSession(
        fileManager: FileManager = .default,
        now: @escaping @Sendable () -> Date = { Date() },
        sleepUntil: @escaping @Sendable (Date) async throws -> Void =
            NativeIntake.sleepUntil
    ) async throws -> NativeIntakeTestSession {
        try await NativeIntakeTestSession(
            makeIntake(
                fileManager: fileManager,
                now: now,
                sleepUntil: sleepUntil
            )
        )
    }
    func makeIntake(
        fileManager: FileManager = .default,
        now: @escaping @Sendable () -> Date = { Date() },
        sleepUntil: @escaping @Sendable (Date) async throws -> Void =
            NativeIntake.sleepUntil
    ) -> NativeIntake {
        NativeIntake(
            applicationSupportDirectory: applicationSupport,
            identitySource: identity.source,
            fileManager: fileManager,
            now: now,
            sleepUntil: sleepUntil
        )
    }
    func photoInput(seed: Int) throws -> NativeIntake.PhotoInput {
        let data = try makeJPEG(seed: seed)
        return .init(loadData: { data })
    }
    func makeJPEG(seed: Int) throws -> Data {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 24, height: 16))
        let image = renderer.image { context in
            UIColor(
                red: CGFloat(seed + 1) / 6,
                green: 0.4,
                blue: 0.7,
                alpha: 1
            ).setFill()
            context.cgContext.fill(
                CGRect(x: 0, y: 0, width: 24, height: 16)
            )
        }
        return try XCTUnwrap(image.jpegData(compressionQuality: 0.9))
    }
    func regularFileNames() -> [String] {
        regularFileURLs().map(\.lastPathComponent)
    }
    func regularFileURLs() -> [URL] {
        guard let enumerator = fileManager.enumerator(
            at: applicationSupport,
            includingPropertiesForKeys: [.isRegularFileKey]
        ) else {
            return []
        }
        return enumerator.compactMap { value -> URL? in
            guard let url = value as? URL,
                  (try? url.resourceValues(
                    forKeys: [.isRegularFileKey]
                  ).isRegularFile) == true else {
                return nil
            }
            return url
        }.sorted { $0.path < $1.path }
    }
    func cleanUp() {
        try? fileManager.removeItem(at: applicationSupport)
    }
    func waitForRemoval(of url: URL) async {
        for _ in 0..<100 where fileManager.fileExists(atPath: url.path) {
            await Task.yield()
        }
    }
}
final class TestNativeIntakeIdentity:
    AppAttestKeyIDStoring,
    @unchecked Sendable {
    private let lock = NSLock()
    private var subject: String?
    private var key: AppAttestStoredKey?
    private var continuations: [UUID: AsyncStream<Void>.Continuation] = [:]
    init(_ value: NativeIntake.Identity) {
        subject = value.verifiedClerkSubject
        key = value.persistedAppAttestKeyID.map {
            AppAttestStoredKey(id: $0, state: .verified)
        }
    }
    var source: NativeIntake.IdentitySource {
        NativeIntake.IdentitySource(
            current: { self.currentIdentity() },
            changes: changes
        )
    }
    var clerkSubject: @Sendable () async -> String? {
        { self.lock.synchronized { self.subject } }
    }
    var changes: @Sendable () -> AsyncStream<Void> {
        {
            AsyncStream { continuation in
                self.add(continuation)
            }
        }
    }
    var subscriptionCount: Int {
        lock.synchronized { continuations.count }
    }
    func set(_ value: NativeIntake.Identity) async {
        await set(
            clerkSubject: value.verifiedClerkSubject,
            appAttestKey: value.persistedAppAttestKeyID.map {
                AppAttestStoredKey(id: $0, state: .verified)
            }
        )
    }
    func set(
        clerkSubject: String?,
        appAttestKey: AppAttestStoredKey?
    ) async {
        let continuations = lock.synchronized {
            subject = clerkSubject
            key = appAttestKey
            return Array(self.continuations.values)
        }
        continuations.forEach { $0.yield() }
        await Task.yield()
    }
    func load() throws -> AppAttestStoredKey? {
        lock.synchronized { key }
    }
    func save(_ key: AppAttestStoredKey) throws {
        lock.synchronized { self.key = key }
    }
    func remove() throws {
        lock.synchronized { key = nil }
    }
    private func currentIdentity() -> NativeIntake.Identity {
        lock.synchronized {
            .init(
                verifiedClerkSubject: subject,
                persistedAppAttestKeyID: key?.id
            )
        }
    }
    private func add(_ continuation: AsyncStream<Void>.Continuation) {
        let id = UUID()
        lock.synchronized {
            continuations[id] = continuation
        }
        continuation.onTermination = { [weak self] _ in
            self?.lock.synchronized {
                self?.continuations[id] = nil
            }
        }
    }
}
fileprivate enum NativeIntakeFileFailure: Equatable {
    case assetProtection
    case manifestProtection
    case generationPublication
    case rootDeletions(Int)
}
final class NativeIntakeTestFileManager: FileManager, @unchecked Sendable {
    private let lock = NSLock()
    private var rejectsReads = false
    private var nextFailure: NativeIntakeFileFailure?
    private var manifestReads = 0
    private var removalAttempts = 0
    fileprivate var failNextFileOperation: NativeIntakeFileFailure? {
        get { lock.synchronized { nextFailure } }
        set { lock.synchronized { nextFailure = newValue } }
    }
    var rejectManifestMetadataReads: Bool {
        get { lock.synchronized { rejectsReads } }
        set {
            lock.synchronized {
                rejectsReads = newValue
            }
        }
    }
    var manifestMetadataReadCount: Int {
        lock.synchronized { manifestReads }
    }
    fileprivate var rootRemovalAttemptCount: Int {
        lock.synchronized { removalAttempts }
    }
    override func attributesOfItem(
        atPath path: String
    ) throws -> [FileAttributeKey: Any] {
        if path.hasSuffix("/bundle.json") {
            let reject = lock.synchronized {
                manifestReads += 1
                return rejectsReads
            }
            if reject {
                throw CocoaError(.fileReadNoPermission)
            }
        }
        return try super.attributesOfItem(atPath: path)
    }
    override func setAttributes(
        _ attributes: [FileAttributeKey: Any],
        ofItemAtPath path: String
    ) throws {
        let fail = lock.synchronized {
            let matches: Bool
            switch nextFailure {
            case .assetProtection:
                matches = path.contains("/Assets/")
                    && path.hasSuffix(".jpg")
            case .manifestProtection:
                matches = path.hasSuffix("/bundle.json")
                    || path.contains("/.bundle-")
            case .generationPublication, .rootDeletions, nil:
                matches = false
            }
            guard matches else {
                return false
            }
            nextFailure = nil
            return true
        }
        try reject(fail)
        try super.setAttributes(attributes, ofItemAtPath: path)
    }
    override func moveItem(at sourceURL: URL, to destinationURL: URL) throws {
        let fail = lock.synchronized {
            guard nextFailure == .generationPublication,
                  destinationURL.lastPathComponent == "Current" else {
                return false
            }
            nextFailure = nil
            return true
        }
        try reject(fail)
        try super.moveItem(at: sourceURL, to: destinationURL)
    }
    override func removeItem(at URL: URL) throws {
        let fail = lock.synchronized {
            removalAttempts += 1
            guard case .rootDeletions(let remaining) = nextFailure else {
                return false
            }
            nextFailure = remaining > 1 ? .rootDeletions(remaining - 1) : nil
            return true
        }
        try reject(fail)
        try super.removeItem(at: URL)
    }
    private func reject(_ failure: Bool) throws {
        guard !failure else {
            throw CocoaError(.fileWriteNoPermission)
        }
    }
}
private final class NativeIntakeTestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current: Date
    private var sleepers: [(deadline: Date, continuation: CheckedContinuation<Void, Never>)] = []
    init(now: Date) {
        current = now
    }
    func now() -> Date {
        lock.synchronized { current }
    }
    func sleep(until deadline: Date) async throws {
        let shouldWait = lock.synchronized { current < deadline }
        guard shouldWait else {
            return
        }
        await withCheckedContinuation { continuation in
            lock.synchronized {
                sleepers.append((deadline, continuation))
            }
        }
        try Task.checkCancellation()
    }
    var nextDeadline: Date? {
        lock.synchronized { sleepers.map(\.deadline).min() }
    }
    func advance(by interval: TimeInterval) {
        let due = lock.synchronized {
            current = current.addingTimeInterval(interval)
            let due = sleepers.filter { $0.deadline <= current }
            sleepers.removeAll { $0.deadline <= current }
            return due
        }
        due.forEach { $0.continuation.resume() }
    }
}
private final class SuspendedNativeIntakeFileManager: FileManager, @unchecked Sendable {
    private let lock = NSLock()
    private let release = DispatchSemaphore(value: 0)
    private var photoWriteCount = 0
    private var writeWaiters: [CheckedContinuation<Void, Never>] = []
    private var didSuspend = false
    override func setAttributes(
        _ attributes: [FileAttributeKey: Any],
        ofItemAtPath path: String
    ) throws {
        try super.setAttributes(attributes, ofItemAtPath: path)
        guard path.contains("/Assets/"), path.hasSuffix(".jpg") else {
            return
        }
        let shouldSuspend = lock.synchronized {
            photoWriteCount += 1
            guard photoWriteCount == 2 else {
                return false
            }
            didSuspend = true
            writeWaiters.forEach { $0.resume() }
            writeWaiters = []
            return true
        }
        if shouldSuspend {
            release.wait()
        }
    }
    func waitUntilPhotoAssetsAreWritten() async {
        let alreadyWritten = lock.synchronized { didSuspend }
        guard !alreadyWritten else {
            return
        }
        await withCheckedContinuation { continuation in
            lock.synchronized {
                writeWaiters.append(continuation)
            }
        }
    }
    func resumeStaging() {
        release.signal()
    }
}
private extension NSLock {
    func synchronized<Value>(_ operation: () -> Value) -> Value {
        lock()
        defer { unlock() }
        return operation()
    }
}
private actor SuspendedNativeIntakeValue<Value: Sendable> {
    private let value: Value
    private var isRequested = false
    private var requestWaiters: [CheckedContinuation<Void, Never>] = []
    private var loadWaiters: [CheckedContinuation<Value, Never>] = []
    private var didCompleteFirstLoad = false
    init(_ value: Value) {
        self.value = value
    }
    func load() async -> Value {
        isRequested = true
        requestWaiters.forEach { $0.resume() }
        requestWaiters = []
        return await withCheckedContinuation { continuation in
            loadWaiters.append(continuation)
        }
    }
    func loadOnce(
        or fallback: @Sendable () async -> Value
    ) async -> Value {
        guard !didCompleteFirstLoad else {
            return await fallback()
        }
        let value = await load()
        didCompleteFirstLoad = true
        return value
    }
    func waitUntilRequested() async {
        guard !isRequested else {
            return
        }
        await withCheckedContinuation { continuation in
            requestWaiters.append(continuation)
        }
    }
    func resume() {
        loadWaiters.forEach { $0.resume(returning: value) }
        loadWaiters = []
    }
}
