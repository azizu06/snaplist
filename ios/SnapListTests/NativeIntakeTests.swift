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
            persistedAppAttestKeyID: "guest-key-that-must-not-win"))
        assertEmpty(try await relaunched.nextSnapshot())
        await harness.identity.set(.init(
            verifiedClerkSubject: "user_native_intake_a",
            persistedAppAttestKeyID: "guest-key-that-must-not-win"))
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
        await inputs.set(
            clerkSubject: "user_native_intake_gap_b",
            appAttestKey: .init(id: "guest-principal-key", state: .pending))
        await firstRead.resume()
        let session = try await sessionTask.value
        assertEmpty(session.snapshot)
        assertEmpty(try await session.nextSnapshot())
        _ = try await session.commit(.addPhotos([harness.photoInput(seed: 0)]))
        await inputs.set(
            clerkSubject: nil, appAttestKey: .init(id: "guest-principal-key", state: .pending))
        assertEmpty(try await session.nextSnapshot())
        _ = try await session.commit(.addPhotos([harness.photoInput(seed: 1)]))
        await inputs.set(
            clerkSubject: nil, appAttestKey: .init(id: "guest-principal-key", state: .verified))
        let guest = try await session.commit(.addPhotos([harness.photoInput(seed: 2)]))
        XCTAssertEqual(guest.photos.count, 2)
        await inputs.set(
            clerkSubject: "user_native_intake_gap_b",
            appAttestKey: .init(id: "guest-principal-key", state: .verified))
        let returnedAuthenticated = try await session.nextSnapshot()
        XCTAssertEqual(returnedAuthenticated.photos.count, 1)
    }
    func testFivePhotoSelectionCommitsAllOrNone() async throws {
        let harness = NativeIntakeHarness(identity: .clerk("user_native_intake_batch"))
        let guardedFiles = NativeIntakeTestFileManager()
        let session = try await harness.makeSession(fileManager: guardedFiles)
        addTeardownBlock { harness.cleanUp() }
        let photoData = try (0..<5).map(harness.makeJPEG)
        var failedInputs = photoData.map { data in NativeIntake.PhotoInput(loadData: { data }) }
        failedInputs[2] = NativeIntake.PhotoInput {
            throw NativeIntakeTestFailure.unavailableSource
        }
        let failed = await session.perform(.addPhotos(failedInputs))
        XCTAssertEqual(failed, .rejected(.sourceUnavailable))
        assertEmpty(try await session.inspect())
        let inputs = photoData.map { data in NativeIntake.PhotoInput(loadData: { data }) }
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
        _ = try await session.commit(.addPhotos([inputs[0]]))
        let initial = try await session.commit(.setVoice(voice("protected voice", duration: 3)))
        let priorFiles = harness.regularFileNames()
        try assertProtectedAndBackupExcluded(harness.ownedURLs(), recordedBy: guardedFiles)
        guardedFiles.failNextFileOperation = .manifestProtection
        let outcome = await session.perform(.addPhotos(Array(inputs.dropFirst())))
        XCTAssertEqual(outcome, .rejected(.storageFailure))
        let surviving = try await session.inspect()
        XCTAssertEqual(surviving, initial)
        XCTAssertEqual(harness.regularFileNames(), priorFiles)
        let recoveredPrior = try await harness.makeSession(fileManager: guardedFiles)
        assertRecovered(recoveredPrior.snapshot, from: initial)
        try assertProtectedAndBackupExcluded(harness.ownedURLs(), recordedBy: guardedFiles)
        let committed = try await session.commit(.addPhotos(Array(inputs.dropFirst())))
        XCTAssertEqual(committed.photos.count, 5)
        XCTAssertEqual(Set(committed.photos.map(\.id)).count, 5)
        let recovered = try await harness.makeSession()
        assertRecovered(recovered.snapshot, from: committed)
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
            await session.perform(.addPhotos([.init(loadData: { await firstSource.load() })]))
        }
        let secondOperation = Task {
            await session.perform(.addPhotos([.init(loadData: { await secondSource.load() })]))
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
        let replaced = try await session.commit(.replacePhoto(
            id: added.photos[1].id, with: harness.photoInput(seed: 4)
        ))
        XCTAssertNotEqual(replaced.photos[1].id, added.photos[1].id)
        XCTAssertEqual(replaced.voice, voiced.voice)
        let reversedIDs = replaced.photos.map(\.id).reversed()
        let reordered = try await session.commit(.reorderPhotos(Array(reversedIDs)))
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
        assertRecovered(recovered.snapshot, from: final)
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
        let start = Date(timeIntervalSince1970: 2_000_000_000)
        let originalClock = NativeIntakeTestClock(now: start)
        let cleanupClock = NativeIntakeTestClock(now: start)
        let guardedFiles = NativeIntakeTestFileManager()
        let harness = NativeIntakeHarness(identity: .none)
        addTeardownBlock { harness.cleanUp() }
        let first = try await harness.makeSession(
            fileManager: guardedFiles, now: originalClock.now, sleepUntil: originalClock.sleep)
        _ = try await first.commit(.addPhotos([harness.photoInput(seed: 4)]))
        let privateSnapshot = try await first.commit(
            .setVoice(voice("temporary voice", duration: 3))
        )
        let privatePhotoURL = privateSnapshot.photos[0].photoURL
        XCTAssertTrue(privatePhotoURL.path.hasPrefix(files.temporaryDirectory.path))
        XCTAssertFalse(files.fileExists(atPath: harness.applicationSupport.path))
        let reconstructed = try await harness.makeSession(
            fileManager: guardedFiles, now: cleanupClock.now, sleepUntil: cleanupClock.sleep)
        assertEmpty(reconstructed.snapshot)
        XCTAssertTrue(files.fileExists(atPath: privatePhotoURL.path))
        await cleanupClock.waitUntilScheduled(1)
        let removalTarget = guardedFiles.successfulRootRemovalCount + 1
        cleanupClock.advance(by: NativeIntake.recoveryWindow + 1)
        await guardedFiles.waitForRootRemovals(removalTarget, successful: true)
        XCTAssertFalse(files.fileExists(atPath: privatePhotoURL.path))
        withExtendedLifetime(first) {}
    }
    func testScheduledExpiryDeletesDurableAndEphemeralStateButRetriesUnreadableMetadata() async throws {
        let start = Date(timeIntervalSince1970: 2_000_000_000)
        let initialDeadline = start.addingTimeInterval(NativeIntake.recoveryWindow)
        let durableClock = NativeIntakeTestClock(now: start)
        let ephemeralClock = NativeIntakeTestClock(now: start)
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
            fileManager: guardedFiles, now: durableClock.now, sleepUntil: durableClock.sleep)
        let ephemeral = try await ephemeralHarness.makeSession(
            fileManager: guardedFiles, now: ephemeralClock.now, sleepUntil: ephemeralClock.sleep)
        let durableRegistration = durableClock.latestRegistration
        let durableSnapshot = try await durable.commit(.addPhotos([durableHarness.photoInput(seed: 1)]))
        await durableClock.waitUntilLiveSleeper(
            after: durableRegistration, deadline: initialDeadline)
        let ephemeralRegistration = ephemeralClock.latestRegistration
        let ephemeralSnapshot = try await ephemeral.commit(.addPhotos([ephemeralHarness.photoInput(seed: 2)]))
        await ephemeralClock.waitUntilLiveSleeper(
            after: ephemeralRegistration, deadline: initialDeadline)
        let transitionRegistration = ephemeralClock.latestRegistration
        await ephemeralHarness.identity.set(.clerk("user_native_intake_ephemeral_durable"))
        assertEmpty(try await ephemeral.nextSnapshot())
        await ephemeralClock.waitUntilLiveSleeper(
            after: transitionRegistration, deadline: initialDeadline)
        guardedFiles.failNextFileOperation = .rootDeletions(2)
        let removalBaseline = guardedFiles.rootRemovalAttemptCount
        let durableRetryRegistration = durableClock.latestRegistration
        let ephemeralRetryRegistration = ephemeralClock.latestRegistration
        durableClock.advance(by: NativeIntake.recoveryWindow + 1)
        ephemeralClock.advance(by: NativeIntake.recoveryWindow + 1)
        let durableRetryDeadline = durableClock.now()
            .addingTimeInterval(NativeIntake.retentionRetryInterval)
        let ephemeralRetryDeadline = ephemeralClock.now()
            .addingTimeInterval(NativeIntake.retentionRetryInterval)
        await guardedFiles.waitForRootRemovals(removalBaseline + 2)
        await durableClock.waitUntilLiveSleeper(
            after: durableRetryRegistration, deadline: durableRetryDeadline)
        await ephemeralClock.waitUntilLiveSleeper(
            after: ephemeralRetryRegistration, deadline: ephemeralRetryDeadline)
        XCTAssertEqual(guardedFiles.rootRemovalAttemptCount, removalBaseline + 2)
        XCTAssertTrue(files.fileExists(atPath: ephemeralSnapshot.photos[0].photoURL.path))
        XCTAssertTrue(files.fileExists(atPath: durableSnapshot.photos[0].photoURL.path))
        let discard = await durable.perform(.discard(expected: durableSnapshot.version))
        XCTAssertEqual(discard, .committed)
        assertEmpty(try await durable.nextSnapshot())
        let renewedRegistration = durableClock.latestRegistration
        let renewed = try await durable.commit(.addPhotos([durableHarness.photoInput(seed: 3)]))
        let renewedDeadline = durableClock.now().addingTimeInterval(NativeIntake.recoveryWindow)
        await durableClock.waitUntilLiveSleeper(
            after: renewedRegistration, deadline: renewedDeadline)
        let retryRemoval = guardedFiles.successfulRootRemovalCount + 1
        ephemeralClock.advance(by: NativeIntake.retentionRetryInterval)
        await guardedFiles.waitForRootRemovals(retryRemoval, successful: true)
        XCTAssertFalse(files.fileExists(atPath: ephemeralSnapshot.photos[0].photoURL.path))
        XCTAssertEqual(durableClock.nextDeadline, renewedDeadline)
        XCTAssertTrue(files.fileExists(atPath: renewed.photos[0].photoURL.path))
        XCTAssertTrue(files.fileExists(atPath: uppercaseSentinel.path))
        let durableTransitionRegistration = durableClock.latestRegistration
        await durableHarness.identity.set(.clerk("user_native_intake_retention_b"))
        assertEmpty(try await durable.nextSnapshot())
        await durableClock.waitUntilLiveSleeper(
            after: durableTransitionRegistration, deadline: renewedDeadline)
        guardedFiles.rejectManifestMetadataReads = true
        let unreadableRetryRegistration = durableClock.latestRegistration
        durableClock.advance(by: NativeIntake.recoveryWindow + 1)
        let unreadableRetryDeadline = durableClock.now()
            .addingTimeInterval(NativeIntake.retentionRetryInterval)
        await durableClock.waitUntilLiveSleeper(
            after: unreadableRetryRegistration, deadline: unreadableRetryDeadline)
        XCTAssertTrue(files.fileExists(atPath: renewed.photos[0].photoURL.path))
        let recoveryRetryRegistration = durableClock.latestRegistration
        await durableHarness.identity.set(.clerk("user_native_intake_retention_a"))
        let pending = try await durable.nextSnapshot()
        XCTAssertEqual(pending.recovery, .pending)
        await durableClock.waitUntilLiveSleeper(
            after: recoveryRetryRegistration, deadline: unreadableRetryDeadline)
        XCTAssertEqual(durableClock.nextDeadline, unreadableRetryDeadline)
        guardedFiles.rejectManifestMetadataReads = false
        durableClock.advance(by: NativeIntake.retentionRetryInterval)
        let retried = try await durable.nextSnapshot()
        XCTAssertEqual(retried.recovery, .ready)
        XCTAssertTrue(retried.photos.isEmpty)
        XCTAssertFalse(files.fileExists(atPath: renewed.photos[0].photoURL.path))
        for location in NativeIntakeSymlinkLocation.allCases {
            try await assertSymlinkFence(location)
        }
    }
    private func assertSymlinkFence(_ location: NativeIntakeSymlinkLocation) async throws {
        let harness = NativeIntakeHarness(identity: .clerk("user_native_intake_symlink_\(location)"))
        let session = try await harness.makeSession()
        let initial = try await session.commit(.addPhotos([harness.photoInput(seed: 3)]))
        let assetsRoot = try XCTUnwrap(initial.photos.first?.photoURL.deletingLastPathComponent())
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
            "snaplist-native-intake-outside-\(UUID().uuidString)", isDirectory: true)
        let parked = files.temporaryDirectory.appendingPathComponent(
            "snaplist-native-intake-parked-\(UUID().uuidString)", isDirectory: true)
        addTeardownBlock {
            harness.cleanUp()
            try? self.files.removeItem(at: outside)
            try? self.files.removeItem(at: parked)
        }
        try files.createDirectory(at: outside, withIntermediateDirectories: true)
        let sentinel = outside.appendingPathComponent("foreign-media")
        try Data("foreign".utf8).write(to: sentinel)
        try files.moveItem(at: target, to: parked)
        try files.createSymbolicLink(at: target, withDestinationURL: outside)
        let write = await session.perform(.addPhotos([try harness.photoInput(seed: 4)]))
        XCTAssertEqual(write, .rejected(.storageFailure))
        let surviving = try await session.inspect()
        XCTAssertEqual(surviving, initial)
        let recovered = try await harness.makeSession()
        XCTAssertEqual(recovered.snapshot.recovery, .pending)
        let discard = await session.perform(.discard(expected: initial.version))
        XCTAssertEqual(discard, .rejected(.storageFailure))
        XCTAssertEqual(try Data(contentsOf: sentinel), Data("foreign".utf8))
    }
    private func assertPrincipalRoundTripSupersedes(
        _ suspension: NativeIntakeSuspensionPoint
    ) async throws {
        let (harness, _) = try await makeSession(.clerk("user_native_intake_race_a"))
        let fileManager: FileManager
        let input: NativeIntake.PhotoInput
        let waitForSuspension: () async -> Void
        let resume: () async -> Void
        switch suspension {
        case .beforeSourceLoad:
            let source = SuspendedNativeIntakeValue(try harness.makeJPEG(seed: 1))
            fileManager = .default
            input = .init(loadData: { await source.load() })
            waitForSuspension = { await source.waitUntilRequested() }
            resume = { await source.resume() }
        case .afterStaging:
            let manager = SuspendedNativeIntakeFileManager()
            fileManager = manager
            input = try harness.photoInput(seed: 3)
            waitForSuspension = { await manager.waitUntilPhotoAssetsAreWritten() }
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
    private func assertEmpty(_ snapshot: NativeIntake.Snapshot,
                             file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(snapshot.photos.isEmpty, file: file, line: line)
        XCTAssertNil(snapshot.voice, file: file, line: line)
    }
    private func assertProtectedAndBackupExcluded(
        _ urls: [URL], recordedBy fileManager: NativeIntakeTestFileManager,
        file: StaticString = #filePath, line: UInt = #line
    ) throws {
        XCTAssertTrue(NativeIntake.writingOptions.contains(.completeFileProtection),
                      file: file, line: line)
        XCTAssertTrue(fileManager.didRequestCompleteProtection, file: file, line: line)
        for url in urls {
            let attributes = try files.attributesOfItem(atPath: url.path)
            if let observedProtection = attributes[.protectionKey] as? FileProtectionType {
                XCTAssertEqual(observedProtection, .complete, file: file, line: line)
            }
            let excluded = try url.resourceValues(
                forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup
            XCTAssertEqual(excluded, true, file: file, line: line)
        }
    }
    private func assertRecovered(_ recovered: NativeIntake.Snapshot,
                                 from prior: NativeIntake.Snapshot) {
        XCTAssertNotEqual(recovered.version.activationID, prior.version.activationID)
        XCTAssertEqual(recovered.version.revision, prior.version.revision)
        XCTAssertEqual(recovered.photos, prior.photos)
        XCTAssertEqual(recovered.voice, prior.voice)
        XCTAssertEqual(recovered.recovery, prior.recovery)
    }
    private func voice(_ text: String, duration: TimeInterval) -> NativeIntake.VoiceInput {
        .init(duration: duration, loadData: { Data(text.utf8) })
    }
    private func makeSession(_ identity: NativeIntake.Identity) async throws -> (NativeIntakeHarness, NativeIntakeTestSession) {
        let harness = NativeIntakeHarness(identity: identity)
        addTeardownBlock { harness.cleanUp() }
        return (harness, try await harness.makeSession())
    }
}
private enum NativeIntakeTestFailure: Error { case unavailableSource }
private enum NativeIntakeSuspensionPoint { case beforeSourceLoad, afterStaging }
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
    func perform(_ operation: NativeIntake.Operation) async -> NativeIntake.Outcome {
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
    init(identity: NativeIntake.Identity, applicationSupport: URL? = nil) {
        self.applicationSupport = applicationSupport
            ?? fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(
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
        try await NativeIntakeTestSession(NativeIntake(
            applicationSupportDirectory: applicationSupport,
            identitySource: identity.source,
            fileManager: fileManager,
            now: now,
            sleepUntil: sleepUntil
        ))
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
    func regularFileNames() -> [String] { regularFileURLs().map(\.lastPathComponent) }
    func regularFileURLs() -> [URL] {
        ownedURLs().filter {
            (try? $0.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile)
                == true
        }
    }
    func ownedURLs() -> [URL] {
        guard let enumerator = fileManager.enumerator(
            at: applicationSupport,
            includingPropertiesForKeys: nil
        ) else { return [] }
        return enumerator.compactMap { $0 as? URL }.sorted { $0.path < $1.path }
    }
    func cleanUp() { try? fileManager.removeItem(at: applicationSupport) }
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
        .init(current: { self.currentIdentity() }, changes: changes)
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
    var subscriptionCount: Int { lock.synchronized { continuations.count } }
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
    }
    func load() throws -> AppAttestStoredKey? { lock.synchronized { key } }
    func save(_ key: AppAttestStoredKey) throws { lock.synchronized { self.key = key } }
    func remove() throws { lock.synchronized { key = nil } }
    private func currentIdentity() -> NativeIntake.Identity {
        lock.synchronized {
            .init(verifiedClerkSubject: subject, persistedAppAttestKeyID: key?.id)
        }
    }
    private func add(_ continuation: AsyncStream<Void>.Continuation) {
        let id = UUID()
        lock.synchronized { continuations[id] = continuation }
        continuation.onTermination = { [weak self] _ in
            self?.lock.synchronized { self?.continuations[id] = nil }
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
    private var removalAttempts = 0
    private var completedRemovalAttempts = 0
    private var successfulRemovals = 0
    private typealias RemovalWaiter = (expected: Int, successful: Bool,
                                       continuation: CheckedContinuation<Void, Never>)
    private var removalWaiters: [RemovalWaiter] = []
    private var requestedCompleteProtection = false
    fileprivate var failNextFileOperation: NativeIntakeFileFailure? {
        get { lock.synchronized { nextFailure } }
        set { lock.synchronized { nextFailure = newValue } }
    }
    var rejectManifestMetadataReads: Bool {
        get { lock.synchronized { rejectsReads } }
        set { lock.synchronized { rejectsReads = newValue } }
    }
    fileprivate var rootRemovalAttemptCount: Int { lock.synchronized { removalAttempts } }
    fileprivate var successfulRootRemovalCount: Int { lock.synchronized { successfulRemovals } }
    fileprivate var didRequestCompleteProtection: Bool { lock.synchronized { requestedCompleteProtection } }
    func waitForRootRemovals(_ expected: Int, successful: Bool = false) async {
        await withCheckedContinuation { continuation in
            let ready = lock.synchronized {
                let completed = successful
                    ? successfulRemovals
                    : completedRemovalAttempts
                guard completed < expected else { return true }
                removalWaiters.append((expected, successful, continuation))
                return false
            }
            if ready { continuation.resume() }
        }
    }
    override func attributesOfItem(
        atPath path: String
    ) throws -> [FileAttributeKey: Any] {
        if path.hasSuffix("/bundle.json") {
            if lock.synchronized({ rejectsReads }) {
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
        if attributes[.protectionKey] as? FileProtectionType == .complete {
            lock.synchronized {
                requestedCompleteProtection = true
            }
        }
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
        do {
            try reject(fail)
            try super.removeItem(at: URL)
        } catch {
            finishRemovalAttempt(succeeded: false)
            throw error
        }
        finishRemovalAttempt(succeeded: true)
    }
    private func finishRemovalAttempt(succeeded: Bool) {
        let continuations = lock.synchronized {
            completedRemovalAttempts += 1
            if succeeded {
                successfulRemovals += 1
            }
            let ready = removalWaiters.filter {
                $0.expected <= ($0.successful
                    ? successfulRemovals
                    : completedRemovalAttempts)
            }
            removalWaiters.removeAll {
                $0.expected <= ($0.successful
                    ? successfulRemovals
                    : completedRemovalAttempts)
            }
            return ready.map(\.continuation)
        }
        continuations.forEach { $0.resume() }
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
    private typealias Sleeper = (id: UUID, registration: Int, deadline: Date,
                                 continuation: CheckedContinuation<Void, Never>)
    private typealias LiveSleeperMatch = (id: UUID, registration: Int)
    private typealias LiveSleeperWaiter = (
        after: Int,
        deadline: Date,
        continuation: CheckedContinuation<LiveSleeperMatch, Never>
    )
    private var sleepers: [Sleeper] = []
    private var pendingSleeperIDs = Set<UUID>()
    private var cancelledSleeperIDs = Set<UUID>()
    private var scheduleRegistrations = 0
    private var scheduleWaiters: [(Int, CheckedContinuation<Void, Never>)] = []
    private var liveSleeperWaiters: [LiveSleeperWaiter] = []
    init(now: Date) { current = now }
    func now() -> Date { lock.synchronized { current } }
    func sleep(until deadline: Date) async throws {
        let id = UUID()
        _ = lock.synchronized { pendingSleeperIDs.insert(id) }
        try await withTaskCancellationHandler {
            await withCheckedContinuation {
                (continuation: CheckedContinuation<Void, Never>) in
                let ready = lock.synchronized { () -> (
                    scheduled: [CheckedContinuation<Void, Never>],
                    live: [(CheckedContinuation<LiveSleeperMatch, Never>, LiveSleeperMatch)]
                ) in
                    pendingSleeperIDs.remove(id)
                    let cancelled = cancelledSleeperIDs.remove(id) != nil
                    guard current < deadline, !cancelled, !Task.isCancelled else {
                        return ([continuation], [])
                    }
                    scheduleRegistrations += 1
                    let registration = scheduleRegistrations
                    sleepers.append((id, registration, deadline, continuation))
                    let scheduled = scheduleWaiters.filter {
                        $0.0 <= scheduleRegistrations
                    }
                    scheduleWaiters.removeAll {
                        $0.0 <= scheduleRegistrations
                    }
                    let live = liveSleeperWaiters.filter {
                        $0.after < registration && $0.deadline == deadline
                    }
                    liveSleeperWaiters.removeAll {
                        $0.after < registration && $0.deadline == deadline
                    }
                    let match = LiveSleeperMatch(id: id, registration: registration)
                    return (
                        scheduled.map(\.1),
                        live.map { ($0.continuation, match) }
                    )
                }
                ready.scheduled.forEach { $0.resume() }
                ready.live.forEach { $0.0.resume(returning: $0.1) }
            }
            try Task.checkCancellation()
        } onCancel: {
            let continuation: CheckedContinuation<Void, Never>? = self.lock.synchronized {
                guard let index = self.sleepers.firstIndex(
                    where: { $0.id == id }
                ) else {
                    if self.pendingSleeperIDs.contains(id) {
                        self.cancelledSleeperIDs.insert(id)
                    }
                    return nil
                }
                return self.sleepers.remove(at: index).continuation
            }
            continuation?.resume()
        }
    }
    func waitUntilScheduled(_ count: Int) async {
        await withCheckedContinuation { continuation in
            let ready = lock.synchronized {
                guard scheduleRegistrations < count else { return true }
                scheduleWaiters.append((count, continuation))
                return false
            }
            if ready { continuation.resume() }
        }
    }
    func waitUntilLiveSleeper(after registration: Int, deadline: Date) async {
        var minimumRegistration = registration
        while true {
            let match = await withCheckedContinuation { continuation in
                let existing = lock.synchronized { () -> LiveSleeperMatch? in
                    guard let sleeper = sleepers.first(where: {
                        $0.registration > minimumRegistration && $0.deadline == deadline
                    }) else {
                        liveSleeperWaiters.append((
                            minimumRegistration, deadline, continuation
                        ))
                        return nil
                    }
                    return LiveSleeperMatch(
                        id: sleeper.id, registration: sleeper.registration
                    )
                }
                if let existing {
                    continuation.resume(returning: existing)
                }
            }
            let matchedSleeperIsLive = lock.synchronized {
                sleepers.contains {
                    $0.id == match.id
                        && $0.registration == match.registration
                        && $0.deadline == deadline
                }
            }
            if matchedSleeperIsLive {
                return
            }
            minimumRegistration = match.registration
        }
    }
    var nextDeadline: Date? { lock.synchronized { sleepers.map(\.deadline).min() } }
    var scheduledCount: Int { lock.synchronized { scheduleRegistrations } }
    var latestRegistration: Int { lock.synchronized { scheduleRegistrations } }
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
    func resumeStaging() { release.signal() }
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
    init(_ value: Value) { self.value = value }
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
