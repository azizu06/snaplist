import ImageIO
import UIKit
import XCTest
@testable import SnapList
@MainActor
final class NativeIntakeTests: XCTestCase {
    private let files = FileManager.default
    func testRelaunchRestoresFivePhotosVoiceOnlyForMatchingNativePrincipalScope() async throws {
        let identity = NativeIntake.Identity(verifiedClerkSubject: "user_native_intake_a",
            persistedAppAttestKeyID: "guest-key-that-must-not-win")
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
        await harness.identity.set(.init(verifiedClerkSubject: "user_native_intake_b",
            persistedAppAttestKeyID: "guest-key-that-must-not-win"))
        assertEmpty(try await relaunched.nextSnapshot())
        await harness.identity.set(.init(verifiedClerkSubject: "user_native_intake_a",
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
            verifiedClerkSubject: { await firstRead.loadOnce(or: inputs.clerkSubject) },
            clerkChanges: inputs.changes,
            appAttestChanges: inputs.changes)
        XCTAssertEqual(inputs.subscriptionCount, 2)
        let intake = NativeIntake(applicationSupportDirectory: harness.applicationSupport, identitySource: source)
        let sessionTask = Task { try await NativeIntakeTestSession(intake) }
        await firstRead.waitUntilRequested()
        await inputs.set(clerkSubject: "user_native_intake_gap_b",
            appAttestKey: .init(id: "guest-principal-key", state: .pending))
        await firstRead.resume()
        let session = try await sessionTask.value
        assertEmpty(session.snapshot)
        assertEmpty(try await session.nextSnapshot())
        _ = try await session.commit(.addPhotos([harness.photoInput(seed: 0)]))
        await inputs.set(clerkSubject: nil,
            appAttestKey: .init(id: "guest-principal-key", state: .pending))
        assertEmpty(try await session.nextSnapshot())
        _ = try await session.commit(.addPhotos([harness.photoInput(seed: 1)]))
        await inputs.set(clerkSubject: nil,
            appAttestKey: .init(id: "guest-principal-key", state: .verified))
        let guest = try await session.commit(.addPhotos([harness.photoInput(seed: 2)]))
        XCTAssertEqual(guest.photos.count, 2)
        await inputs.set(clerkSubject: "user_native_intake_gap_b",
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
        let fingerprints = photoData.map(LocalPhotoFingerprint.digest)
        let receipts = fingerprints.indices.map {
            LibraryPhotoTransferReceipt(sourcePhotoFingerprints: fingerprints, sourceIndex: $0)
        }
        let mismatched = NativeIntake.PhotoInput(
            libraryTransferReceipt: receipts[0], loadData: { photoData[1] })
        let mismatchedAdd = await session.perform(.addPhotos([mismatched]))
        XCTAssertEqual(mismatchedAdd, .rejected(.sourceUnavailable))
        assertEmpty(try await session.inspect())
        let inputs = photoData.indices.map { index in
            NativeIntake.PhotoInput(
                libraryTransferReceipt: receipts[index], loadData: { photoData[index] })
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
        XCTAssertEqual(committed.photos.map(\.libraryTransferReceipt), receipts)
        let mismatchedReplace = await session.perform(.replacePhoto(id: committed.photos[0].id, with: mismatched))
        XCTAssertEqual(mismatchedReplace, .rejected(.sourceUnavailable))
        let unchangedAfterMismatch = try await session.inspect()
        XCTAssertEqual(unchangedAfterMismatch, committed)
        let replaced = try await session.commit(.replacePhoto(id: committed.photos[0].id, with: inputs[0]))
        XCTAssertEqual(replaced.photos[0].libraryTransferReceipt, receipts[0])
        let recovered = try await harness.makeSession()
        assertRecovered(recovered.snapshot, from: replaced)
    }
    func testPrincipalRoundTripSupersedesSuspendedMutationWithoutPublication() async throws {
        try await assertPrincipalRoundTripSupersedes(.beforeSourceLoad)
    }
    func testPrincipalRoundTripSupersedesPostStagingMutationWithoutPublication() async throws {
        try await assertPrincipalRoundTripSupersedes(.afterStaging)
    }
    func testCancellationAfterDetachedStagingSupersedesPhotoAndVoicePublication()
        async throws {
        let photoHarness = NativeIntakeHarness(
            identity: .clerk("user_native_intake_cancel_photo")
        )
        addTeardownBlock { photoHarness.cleanUp() }
        let photoFiles = SuspendedNativeIntakeFileManager()
        let photoActivity = NativeIntakeOperationActivity()
        let photoSession = try await photoHarness.makeSession(
            fileManager: photoFiles
        )
        let photoData = try photoHarness.makeJPEG(seed: 4)
        let photoInput = NativeIntake.PhotoInput(
            isActive: { photoActivity.isActive },
            loadData: { photoData }
        )
        let photoOperation = Task {
            await photoSession.perform(.addPhotos([photoInput]))
        }
        await photoFiles.waitUntilTargetAssetsAreWritten()
        photoActivity.cancel()
        photoFiles.resumeStaging()
        let photoOutcome = await photoOperation.value
        XCTAssertEqual(photoOutcome, .superseded)
        assertEmpty(try await photoSession.inspect())

        let voiceHarness = NativeIntakeHarness(
            identity: .clerk("user_native_intake_cancel_voice")
        )
        addTeardownBlock { voiceHarness.cleanUp() }
        let voiceFiles = SuspendedNativeIntakeFileManager(
            assetExtension: "wav",
            writesBeforeSuspension: 1
        )
        let voiceActivity = NativeIntakeOperationActivity()
        let voiceSession = try await voiceHarness.makeSession(
            fileManager: voiceFiles
        )
        let voiceInput = NativeIntake.VoiceInput(
            duration: 4,
            isActive: { voiceActivity.isActive },
            loadData: { Data("cancelled voice".utf8) }
        )
        let voiceOperation = Task {
            await voiceSession.perform(.setVoice(voiceInput))
        }
        await voiceFiles.waitUntilTargetAssetsAreWritten()
        voiceActivity.cancel()
        voiceFiles.resumeStaging()
        let voiceOutcome = await voiceOperation.value
        XCTAssertEqual(voiceOutcome, .superseded)
        assertEmpty(try await voiceSession.inspect())
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
        let replaced = try await session.commit(
            .replacePhoto(id: added.photos[1].id, with: harness.photoInput(seed: 4)))
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
        let entered = await session.perform(
            .photoReviewEntered(
                activationID: session.snapshot.version.activationID
            )
        )
        XCTAssertEqual(entered, .committed)
        await harness.identity.set(.clerk("user_native_intake_review_b"))
        let dismissal = await session.nextEvent()
        XCTAssertEqual(dismissal, .dismissActivePhotoReview)
        _ = try await session.nextSnapshot()
    }
    func testNoIdentityUsesProcessPrivateTemporaryStateThatReconstructionCannotRecover() async throws {
        let start = Date(timeIntervalSince1970: 2_000_000_000)
        let invalidMarkers: [Data?] = [nil, Data("corrupt marker".utf8)]
        for marker in invalidMarkers {
            let originalClock = NativeIntakeTestClock(now: start)
            let cleanupClock = NativeIntakeTestClock(now: start)
            let guardedFiles = NativeIntakeTestFileManager()
            let harness = NativeIntakeHarness(identity: .none)
            addTeardownBlock { harness.cleanUp() }
            let first = try await harness.makeSession(fileManager: guardedFiles, now: originalClock.now, sleepUntil: originalClock.sleep)
            _ = try await first.commit(.addPhotos([harness.photoInput(seed: 4)]))
            let privateSnapshot = try await first.commit(.setVoice(voice("temporary voice", duration: 3)))
            let privatePhotoURL = privateSnapshot.photos[0].photoURL
            let privateRoot = intakeRoot(containing: privatePhotoURL)
            let siblingRoot = privateRoot.deletingLastPathComponent().appendingPathComponent(
                "v1-\(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased())")
            try files.copyItem(at: privateRoot, to: siblingRoot)
            addTeardownBlock { try? self.files.removeItem(at: siblingRoot) }
            let siblingPhotoURL = siblingRoot.appendingPathComponent("Current/Assets/\(privatePhotoURL.lastPathComponent)")
            let markerURL = privateRoot.appendingPathComponent(".native-intake-v1")
            if let marker {
                try marker.write(to: markerURL, options: .atomic)
            } else {
                try files.removeItem(at: markerURL)
            }
            XCTAssertTrue(privatePhotoURL.path.hasPrefix(files.temporaryDirectory.path))
            XCTAssertFalse(files.fileExists(atPath: harness.applicationSupport.path))
            let removalTarget = guardedFiles.successfulRootRemovalCount + 1
            let reconstructed = try await harness.makeSession(
                fileManager: guardedFiles, now: cleanupClock.now, sleepUntil: cleanupClock.sleep)
            assertEmpty(reconstructed.snapshot)
            XCTAssertTrue(files.fileExists(atPath: privatePhotoURL.path))
            await guardedFiles.waitForRootRemovals(removalTarget, successful: true)
            XCTAssertFalse(files.fileExists(atPath: privatePhotoURL.path))
            XCTAssertTrue(files.fileExists(atPath: siblingPhotoURL.path))
            withExtendedLifetime(first) {}
        }
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
        let durableFiles = NativeIntakeTestFileManager()
        let ephemeralFiles = NativeIntakeTestFileManager()
        let durable = try await durableHarness.makeSession(fileManager: durableFiles, now: durableClock.now, sleepUntil: durableClock.sleep)
        let ephemeral = try await ephemeralHarness.makeSession(
            fileManager: ephemeralFiles, now: ephemeralClock.now, sleepUntil: ephemeralClock.sleep)
        let durableRegistration = durableClock.latestRegistration
        let durableSnapshot = try await durable.commit(.addPhotos([durableHarness.photoInput(seed: 1)]))
        await durableClock.waitUntilLiveSleeper(after: durableRegistration, deadline: initialDeadline)
        let ephemeralRegistration = ephemeralClock.latestRegistration
        let ephemeralSnapshot = try await ephemeral.commit(.addPhotos([ephemeralHarness.photoInput(seed: 2)]))
        await ephemeralClock.waitUntilLiveSleeper(after: ephemeralRegistration, deadline: initialDeadline)
        let durableRoot = intakeRoot(containing: durableSnapshot.photos[0].photoURL)
        let ephemeralRoot = intakeRoot(containing: ephemeralSnapshot.photos[0].photoURL)
        let transitionRegistration = ephemeralClock.latestRegistration
        await ephemeralHarness.identity.set(.clerk("user_native_intake_ephemeral_durable"))
        assertEmpty(try await ephemeral.nextSnapshot())
        await ephemeralClock.waitUntilLiveSleeper(after: transitionRegistration, deadline: initialDeadline)
        let durableFailureBaseline = durableFiles.rootDeletionFailureCount(at: durableRoot)
        let ephemeralFailureBaseline = ephemeralFiles.rootDeletionFailureCount(at: ephemeralRoot)
        durableFiles.failNextFileOperation = .rootDeletions([durableRoot.standardizedFileURL.path])
        ephemeralFiles.failNextFileOperation = .rootDeletions([ephemeralRoot.standardizedFileURL.path])
        let durableRetryRegistration = durableClock.latestRegistration
        let ephemeralRetryRegistration = ephemeralClock.latestRegistration
        durableClock.advance(by: NativeIntake.recoveryWindow + 1)
        ephemeralClock.advance(by: NativeIntake.recoveryWindow + 1)
        let durableRetryDeadline = durableClock.now()
            .addingTimeInterval(NativeIntake.retentionRetryInterval)
        let ephemeralRetryDeadline = ephemeralClock.now()
            .addingTimeInterval(NativeIntake.retentionRetryInterval)
        await durableClock.waitUntilLiveSleeper(after: durableRetryRegistration, deadline: durableRetryDeadline)
        await ephemeralClock.waitUntilLiveSleeper(after: ephemeralRetryRegistration, deadline: ephemeralRetryDeadline)
        XCTAssertEqual(durableFiles.rootDeletionFailureCount(at: durableRoot), durableFailureBaseline + 1)
        XCTAssertEqual(ephemeralFiles.rootDeletionFailureCount(at: ephemeralRoot), ephemeralFailureBaseline + 1)
        XCTAssertTrue(files.fileExists(atPath: ephemeralSnapshot.photos[0].photoURL.path))
        XCTAssertTrue(files.fileExists(atPath: durableSnapshot.photos[0].photoURL.path))
        durableFiles.failNextFileOperation = nil
        let discard = await durable.perform(.discard(expected: durableSnapshot.version))
        XCTAssertEqual(discard, .committed)
        assertEmpty(try await durable.nextSnapshot())
        let renewedRegistration = durableClock.latestRegistration
        let renewed = try await durable.commit(.addPhotos([durableHarness.photoInput(seed: 3)]))
        let renewedDeadline = durableClock.now().addingTimeInterval(NativeIntake.recoveryWindow)
        await durableClock.waitUntilLiveSleeper(after: renewedRegistration, deadline: renewedDeadline)
        XCTAssertTrue(files.fileExists(atPath: ephemeralSnapshot.photos[0].photoURL.path))
        let retryRemoval = ephemeralFiles.successfulRootRemovalCount + 1
        ephemeralFiles.failNextFileOperation = nil
        ephemeralClock.advance(by: NativeIntake.retentionRetryInterval)
        await ephemeralFiles.waitForRootRemovals(retryRemoval, successful: true)
        XCTAssertFalse(files.fileExists(atPath: ephemeralSnapshot.photos[0].photoURL.path))
        XCTAssertEqual(durableClock.nextDeadline, renewedDeadline)
        XCTAssertTrue(files.fileExists(atPath: renewed.photos[0].photoURL.path))
        XCTAssertTrue(files.fileExists(atPath: uppercaseSentinel.path))
        let durableTransitionRegistration = durableClock.latestRegistration
        await durableHarness.identity.set(.clerk("user_native_intake_retention_b"))
        assertEmpty(try await durable.nextSnapshot())
        await durableClock.waitUntilLiveSleeper(after: durableTransitionRegistration, deadline: renewedDeadline)
        durableFiles.rejectManifestMetadataReads = true
        let unreadableRetryRegistration = durableClock.latestRegistration
        durableClock.advance(by: NativeIntake.recoveryWindow + 1)
        let unreadableRetryDeadline = durableClock.now()
            .addingTimeInterval(NativeIntake.retentionRetryInterval)
        await durableClock.waitUntilLiveSleeper(after: unreadableRetryRegistration, deadline: unreadableRetryDeadline)
        XCTAssertTrue(files.fileExists(atPath: renewed.photos[0].photoURL.path))
        let recoveryRetryRegistration = durableClock.latestRegistration
        await durableHarness.identity.set(.clerk("user_native_intake_retention_a"))
        let pending = try await durable.nextSnapshot()
        XCTAssertEqual(pending.recovery, .pending)
        await durableClock.waitUntilLiveSleeper(after: recoveryRetryRegistration, deadline: unreadableRetryDeadline)
        XCTAssertEqual(durableClock.nextDeadline, unreadableRetryDeadline)
        durableFiles.rejectManifestMetadataReads = false
        durableClock.advance(by: NativeIntake.retentionRetryInterval)
        let retried = try await durable.nextSnapshot()
        XCTAssertEqual(retried.recovery, .ready)
        XCTAssertTrue(retried.photos.isEmpty)
        XCTAssertFalse(files.fileExists(atPath: renewed.photos[0].photoURL.path))
        for location in NativeIntakeSymlinkLocation.allCases {
            try await assertSymlinkFence(location)
        }
    }
    func testDeferredUnmatchedVoiceExpiresAtItsOriginalDeadlineWithoutDeletingNewIntake() async throws {
        let start = Date(timeIntervalSince1970: 2_100_000_000)
        let originalDeadline = start.addingTimeInterval(
            NativeIntake.recoveryWindow
        )
        let clock = NativeIntakeTestClock(now: start)
        let harness = NativeIntakeHarness(
            identity: .clerk("user_native_intake_deferred_expiry")
        )
        addTeardownBlock { harness.cleanUp() }
        let session = try await harness.makeSession(
            now: clock.now,
            sleepUntil: clock.sleep
        )
        _ = try await session.commit(
            .addPhotos([harness.photoInput(seed: 1)])
        )
        let submitted = try await session.commit(
            .setVoice(voice("original unmatched voice", duration: 3))
        )
        let submittedVoice = try XCTUnwrap(submitted.voice)
        let principalRoot = intakeRoot(
            containing: submitted.photos[0].photoURL
        )
        let deferredVoiceURL = principalRoot
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
        let retirementRegistration = clock.latestRegistration
        let retirement = await session.perform(
            .retireAcceptedPhotos(
                expected: submitted.version,
                photoIDs: submitted.photos.map(\.id),
                preservingUnmatchedVoiceID: submittedVoice.id
            )
        )
        XCTAssertEqual(retirement, .committed)
        assertEmpty(try await session.nextSnapshot())
        await clock.waitUntilLiveSleeper(
            after: retirementRegistration,
            deadline: originalDeadline
        )
        XCTAssertTrue(files.fileExists(atPath: deferredVoiceURL.path))

        clock.advance(by: 60 * 60)
        let newPhoto = try await session.commit(
            .addPhotos([harness.photoInput(seed: 2)])
        )
        let newDeadline = clock.now().addingTimeInterval(
            NativeIntake.recoveryWindow
        )
        let cleanupRegistration = clock.latestRegistration
        clock.advance(by: NativeIntake.recoveryWindow - (60 * 60) + 1)
        await clock.waitUntilLiveSleeper(
            after: cleanupRegistration,
            deadline: newDeadline
        )

        XCTAssertFalse(files.fileExists(atPath: deferredVoiceURL.path))
        XCTAssertTrue(
            files.fileExists(atPath: newPhoto.photos[0].photoURL.path)
        )
        let surviving = try await session.inspect()
        XCTAssertEqual(surviving.photos, newPhoto.photos)
        XCTAssertNil(surviving.voice)
    }
    func testDeferredUnmatchedVoiceNeverCrossesPrincipalOrReentersActiveSnapshots() async throws {
        let principalA = "user_native_intake_deferred_a"
        let principalB = "user_native_intake_deferred_b"
        let harness = NativeIntakeHarness(identity: .clerk(principalA))
        addTeardownBlock { harness.cleanUp() }
        let session = try await harness.makeSession()
        _ = try await session.commit(
            .addPhotos([harness.photoInput(seed: 1)])
        )
        let submitted = try await session.commit(
            .setVoice(voice("principal A unmatched voice", duration: 3))
        )
        let submittedVoice = try XCTUnwrap(submitted.voice)
        let principalARoot = intakeRoot(
            containing: submitted.photos[0].photoURL
        )
        let deferredVoiceURL = principalARoot
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
        let retirement = await session.perform(
            .retireAcceptedPhotos(
                expected: submitted.version,
                photoIDs: submitted.photos.map(\.id),
                preservingUnmatchedVoiceID: submittedVoice.id
            )
        )
        XCTAssertEqual(retirement, .committed)
        assertEmpty(try await session.nextSnapshot())
        XCTAssertTrue(files.fileExists(atPath: deferredVoiceURL.path))

        await harness.identity.set(.clerk(principalB))
        assertEmpty(try await session.nextSnapshot())
        let principalBPhoto = try await session.commit(
            .addPhotos([harness.photoInput(seed: 2)])
        )
        XCTAssertEqual(principalBPhoto.photos.count, 1)
        XCTAssertNil(principalBPhoto.voice)
        XCTAssertTrue(files.fileExists(atPath: deferredVoiceURL.path))

        await harness.identity.set(.clerk(principalA))
        let returnedA = try await session.nextSnapshot()
        assertEmpty(returnedA)
        XCTAssertTrue(files.fileExists(atPath: deferredVoiceURL.path))
        let principalANewPhoto = try await session.commit(
            .addPhotos([harness.photoInput(seed: 3)])
        )
        XCTAssertEqual(principalANewPhoto.photos.count, 1)
        XCTAssertNil(principalANewPhoto.voice)
        XCTAssertTrue(files.fileExists(atPath: deferredVoiceURL.path))

        await harness.identity.set(.clerk(principalB))
        let returnedB = try await session.nextSnapshot()
        XCTAssertEqual(returnedB.photos, principalBPhoto.photos)
        XCTAssertNil(returnedB.voice)
    }
    func testUnreadableDeferredUnmatchedVoiceStoreNeverDestroysTheResidualRoot() async throws {
        let start = Date(timeIntervalSince1970: 2_100_000_000)
        let retryDeadline = start.addingTimeInterval(
            NativeIntake.retentionRetryInterval
        )
        let clock = NativeIntakeTestClock(now: start)
        let principalA = "user_native_intake_deferred_unreadable_a"
        let principalB = "user_native_intake_deferred_unreadable_b"
        let harness = NativeIntakeHarness(identity: .clerk(principalA))
        addTeardownBlock { harness.cleanUp() }
        let guardedFiles = NativeIntakeTestFileManager()
        let session = try await harness.makeSession(
            fileManager: guardedFiles,
            now: clock.now,
            sleepUntil: clock.sleep
        )
        _ = try await session.commit(
            .addPhotos([harness.photoInput(seed: 1)])
        )
        let submitted = try await session.commit(
            .setVoice(voice("unreadable unmatched voice", duration: 3))
        )
        let submittedVoice = try XCTUnwrap(submitted.voice)
        let principalARoot = intakeRoot(
            containing: submitted.photos[0].photoURL
        )
        let deferredVoiceURL = principalARoot
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
        let retirement = await session.perform(
            .retireAcceptedPhotos(
                expected: submitted.version,
                photoIDs: submitted.photos.map(\.id),
                preservingUnmatchedVoiceID: submittedVoice.id
            )
        )
        XCTAssertEqual(retirement, .committed)
        assertEmpty(try await session.nextSnapshot())
        XCTAssertTrue(files.fileExists(atPath: deferredVoiceURL.path))

        guardedFiles.failNextFileOperation = .rootDeletions([
            principalARoot.standardizedFileURL.path
        ])
        guardedFiles.rejectDeferredUnmatchedVoiceReads = true
        let switchRegistration = clock.latestRegistration
        await harness.identity.set(.clerk(principalB))
        assertEmpty(try await session.nextSnapshot())
        await clock.waitUntilLiveSleeper(
            after: switchRegistration,
            deadline: retryDeadline
        )

        XCTAssertEqual(
            guardedFiles.rootDeletionFailureCount(at: principalARoot),
            0
        )
        XCTAssertTrue(files.fileExists(atPath: deferredVoiceURL.path))
    }

    func testReturningToAResidualRootKeepsVoicesWhenTheStoreCannotBeRead()
        async throws {
        let start = Date(timeIntervalSince1970: 2_100_000_000)
        let clock = NativeIntakeTestClock(now: start)
        let principalA = "user_native_intake_reopen_unreadable_a"
        let principalB = "user_native_intake_reopen_unreadable_b"
        let harness = NativeIntakeHarness(identity: .clerk(principalA))
        addTeardownBlock { harness.cleanUp() }
        let guardedFiles = NativeIntakeTestFileManager()
        let session = try await harness.makeSession(
            fileManager: guardedFiles,
            now: clock.now,
            sleepUntil: clock.sleep
        )
        _ = try await session.commit(
            .addPhotos([harness.photoInput(seed: 1)])
        )
        let submitted = try await session.commit(
            .setVoice(voice("reopened unmatched voice", duration: 3))
        )
        let submittedVoice = try XCTUnwrap(submitted.voice)
        let principalARoot = intakeRoot(
            containing: submitted.photos[0].photoURL
        )
        let deferredVoiceURL = principalARoot
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
        let retirement = await session.perform(
            .retireAcceptedPhotos(
                expected: submitted.version,
                photoIDs: submitted.photos.map(\.id),
                preservingUnmatchedVoiceID: submittedVoice.id
            )
        )
        XCTAssertEqual(retirement, .committed)
        assertEmpty(try await session.nextSnapshot())
        XCTAssertTrue(files.fileExists(atPath: deferredVoiceURL.path))

        // Reopening the residual root reads its torn manifest and asks whether
        // the root is a voice-only residual. An unreadable store cannot answer,
        // and the fallback for "no" destroys the root, so uncertainty there has
        // to stop short of that rather than resolve to it.
        guardedFiles.rejectDeferredUnmatchedVoiceReads = true
        await harness.identity.set(.clerk(principalB))
        _ = try await session.nextSnapshot()
        await harness.identity.set(.clerk(principalA))
        _ = try await session.nextSnapshot()

        XCTAssertTrue(files.fileExists(atPath: deferredVoiceURL.path))
        XCTAssertTrue(files.fileExists(atPath: principalARoot.path))
    }

    func testResidualRootWithoutAnyDeferredVoiceStoreIsStillExpired() async throws {
        let start = Date(timeIntervalSince1970: 2_100_000_000)
        let clock = NativeIntakeTestClock(now: start)
        let principalA = "user_native_intake_residual_a"
        let principalB = "user_native_intake_residual_b"
        let harness = NativeIntakeHarness(identity: .clerk(principalA))
        addTeardownBlock { harness.cleanUp() }
        let guardedFiles = NativeIntakeTestFileManager()
        let session = try await harness.makeSession(
            fileManager: guardedFiles,
            now: clock.now,
            sleepUntil: clock.sleep
        )
        let staged = try await session.commit(
            .addPhotos([harness.photoInput(seed: 1)])
        )
        let principalARoot = intakeRoot(
            containing: staged.photos[0].photoURL
        )
        try guardedFiles.removeItem(
            at: principalARoot.appendingPathComponent(
                "Current",
                isDirectory: true
            )
        )
        XCTAssertFalse(
            files.fileExists(
                atPath: principalARoot
                    .appendingPathComponent("DeferredUnmatchedVoices")
                    .path
            )
        )

        let switchRegistration = clock.latestRegistration
        await harness.identity.set(.clerk(principalB))
        assertEmpty(try await session.nextSnapshot())
        _ = try await session.commit(
            .addPhotos([harness.photoInput(seed: 2)])
        )
        await clock.waitUntilLiveSleeper(
            after: switchRegistration,
            deadline: clock.now().addingTimeInterval(
                NativeIntake.recoveryWindow
            )
        )

        XCTAssertFalse(files.fileExists(atPath: principalARoot.path))
    }
    func testResidualRootKeepsDeferredVoicesWhenItsManifestIsUnreadable() async throws {
        let start = Date(timeIntervalSince1970: 2_100_000_000)
        let clock = NativeIntakeTestClock(now: start)
        let principalA = "user_native_intake_torn_manifest_a"
        let principalB = "user_native_intake_torn_manifest_b"
        // Principal B commits first so its bundle deadline is the earliest one
        // on disk. Retaining or removing principal A's root then converges on
        // the same wake-up, which keeps the verdict deterministic either way.
        let harness = NativeIntakeHarness(identity: .clerk(principalB))
        addTeardownBlock { harness.cleanUp() }
        let guardedFiles = NativeIntakeTestFileManager()
        let session = try await harness.makeSession(
            fileManager: guardedFiles,
            now: clock.now,
            sleepUntil: clock.sleep
        )
        _ = try await session.commit(
            .addPhotos([harness.photoInput(seed: 1)])
        )
        let principalBDeadline = clock.now().addingTimeInterval(
            NativeIntake.recoveryWindow
        )

        await harness.identity.set(.clerk(principalA))
        assertEmpty(try await session.nextSnapshot())
        clock.advance(by: 2 * 60 * 60)
        _ = try await session.commit(
            .addPhotos([harness.photoInput(seed: 2)])
        )
        let submitted = try await session.commit(
            .setVoice(voice("torn manifest unmatched voice", duration: 3))
        )
        let submittedVoice = try XCTUnwrap(submitted.voice)
        let principalARoot = intakeRoot(
            containing: submitted.photos[0].photoURL
        )
        let deferredVoiceURL = principalARoot
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
        let retirement = await session.perform(
            .retireAcceptedPhotos(
                expected: submitted.version,
                photoIDs: submitted.photos.map(\.id),
                preservingUnmatchedVoiceID: submittedVoice.id
            )
        )
        XCTAssertEqual(retirement, .committed)
        assertEmpty(try await session.nextSnapshot())
        _ = try await session.commit(
            .addPhotos([harness.photoInput(seed: 3)])
        )
        let manifestURL = principalARoot
            .appendingPathComponent("Current", isDirectory: true)
            .appendingPathComponent("bundle.json")
        try Data("{".utf8).write(to: manifestURL)

        let switchRegistration = clock.latestRegistration
        await harness.identity.set(.clerk(principalB))
        _ = try await session.nextSnapshot()
        await clock.waitUntilLiveSleeper(
            after: switchRegistration,
            deadline: principalBDeadline
        )

        XCTAssertTrue(files.fileExists(atPath: deferredVoiceURL.path))
    }
    func testVanishedDeferredUnmatchedVoiceEntryStillExpiresItsSiblings() async throws {
        let start = Date(timeIntervalSince1970: 2_100_000_000)
        let clock = NativeIntakeTestClock(now: start)
        let harness = NativeIntakeHarness(
            identity: .clerk("user_native_intake_deferred_siblings")
        )
        addTeardownBlock { harness.cleanUp() }
        let guardedFiles = NativeIntakeTestFileManager()
        let session = try await harness.makeSession(
            fileManager: guardedFiles,
            now: clock.now,
            sleepUntil: clock.sleep
        )
        _ = try await session.commit(
            .addPhotos([harness.photoInput(seed: 1)])
        )
        let first = try await session.commit(
            .setVoice(voice("first unmatched voice", duration: 3))
        )
        let firstVoice = try XCTUnwrap(first.voice)
        let principalRoot = intakeRoot(
            containing: first.photos[0].photoURL
        )
        let firstRetirement = await session.perform(
            .retireAcceptedPhotos(
                expected: first.version,
                photoIDs: first.photos.map(\.id),
                preservingUnmatchedVoiceID: firstVoice.id
            )
        )
        XCTAssertEqual(firstRetirement, .committed)
        assertEmpty(try await session.nextSnapshot())

        clock.advance(by: 60 * 60)
        _ = try await session.commit(
            .addPhotos([harness.photoInput(seed: 2)])
        )
        let second = try await session.commit(
            .setVoice(voice("second unmatched voice", duration: 3))
        )
        let secondVoice = try XCTUnwrap(second.voice)
        let secondRetirement = await session.perform(
            .retireAcceptedPhotos(
                expected: second.version,
                photoIDs: second.photos.map(\.id),
                preservingUnmatchedVoiceID: secondVoice.id
            )
        )
        XCTAssertEqual(secondRetirement, .committed)
        assertEmpty(try await session.nextSnapshot())

        let deferredRoot = principalRoot.appendingPathComponent(
            "DeferredUnmatchedVoices",
            isDirectory: true
        )
        let firstEntryRoot = deferredRoot.appendingPathComponent(
            firstVoice.id.uuidString.lowercased(),
            isDirectory: true
        )
        let secondEntryRoot = deferredRoot.appendingPathComponent(
            secondVoice.id.uuidString.lowercased(),
            isDirectory: true
        )
        XCTAssertTrue(files.fileExists(atPath: secondEntryRoot.path))

        guardedFiles.reportMissing(firstEntryRoot)
        guardedFiles.failNextFileOperation = .rootDeletions([
            secondEntryRoot.standardizedFileURL.path
        ])
        let expiryRegistration = clock.latestRegistration
        clock.advance(by: NativeIntake.recoveryWindow)
        let retryDeadline = clock.now().addingTimeInterval(
            NativeIntake.retentionRetryInterval
        )
        await clock.waitUntilLiveSleeper(
            after: expiryRegistration,
            deadline: retryDeadline
        )

        // The sweep is blocked from completing the removal so that a freed and
        // a frozen store both settle on the same retry deadline, which is what
        // keeps this deterministic instead of hanging one of them.
        guard guardedFiles.rootDeletionFailureCount(at: secondEntryRoot) == 1
        else {
            return XCTFail(
                "A missing sibling entry froze the expiry of a readable one."
            )
        }
        let removalBaseline = guardedFiles.successfulRootRemovalCount
        guardedFiles.failNextFileOperation = nil
        clock.advance(by: NativeIntake.retentionRetryInterval)
        await guardedFiles.waitForRootRemovals(
            removalBaseline + 1,
            successful: true
        )

        XCTAssertFalse(files.fileExists(atPath: secondEntryRoot.path))
        XCTAssertTrue(files.fileExists(atPath: firstEntryRoot.path))
    }
    func testUnreadableDeferredUnmatchedVoiceEntryStillExpiresItsSiblings() async throws {
        try await assertUnreadableDeferredUnmatchedVoiceEntryExpiresItsSiblings(
            corruptManifest: false
        )
        try await assertUnreadableDeferredUnmatchedVoiceEntryExpiresItsSiblings(
            corruptManifest: true
        )
    }
    private func assertUnreadableDeferredUnmatchedVoiceEntryExpiresItsSiblings(
        corruptManifest: Bool
    ) async throws {
        let start = Date(timeIntervalSince1970: 2_100_000_000)
        let clock = NativeIntakeTestClock(now: start)
        let harness = NativeIntakeHarness(
            identity: .clerk(
                "user_native_intake_deferred_unreadable_sibling_\(corruptManifest)"
            )
        )
        addTeardownBlock { harness.cleanUp() }
        let guardedFiles = NativeIntakeTestFileManager()
        let session = try await harness.makeSession(
            fileManager: guardedFiles,
            now: clock.now,
            sleepUntil: clock.sleep
        )
        var entryRoots: [URL] = []
        var principalRoot: URL?
        for seed in 1...3 {
            if seed > 1 {
                clock.advance(by: 60 * 60)
            }
            _ = try await session.commit(
                .addPhotos([harness.photoInput(seed: seed)])
            )
            let staged = try await session.commit(
                .setVoice(voice("unmatched voice \(seed)", duration: 3))
            )
            let stagedVoice = try XCTUnwrap(staged.voice)
            let root = intakeRoot(containing: staged.photos[0].photoURL)
            principalRoot = root
            let retirement = await session.perform(
                .retireAcceptedPhotos(
                    expected: staged.version,
                    photoIDs: staged.photos.map(\.id),
                    preservingUnmatchedVoiceID: stagedVoice.id
                )
            )
            XCTAssertEqual(retirement, .committed)
            assertEmpty(try await session.nextSnapshot())
            entryRoots.append(
                root
                    .appendingPathComponent(
                        "DeferredUnmatchedVoices",
                        isDirectory: true
                    )
                    .appendingPathComponent(
                        stagedVoice.id.uuidString.lowercased(),
                        isDirectory: true
                    )
            )
        }
        _ = try XCTUnwrap(principalRoot)
        let unreadableEntryRoot = entryRoots[0]
        let freedEntryRoot = entryRoots[1]
        let blockedEntryRoot = entryRoots[2]

        let manifestURL = unreadableEntryRoot.appendingPathComponent("entry.json")
        let originalManifest = try Data(contentsOf: manifestURL)
        if corruptManifest {
            try Data("{".utf8).write(to: manifestURL)
        } else {
            try files.removeItem(at: manifestURL)
        }
        XCTAssertTrue(files.fileExists(atPath: unreadableEntryRoot.path))
        XCTAssertTrue(files.fileExists(atPath: freedEntryRoot.path))

        // One sibling's removal is blocked so that a working and a stalled
        // sweep both settle on the same retry deadline, which keeps this
        // assertion deterministic instead of hanging one of them.
        let retryEntryRoot = corruptManifest
            ? unreadableEntryRoot
            : blockedEntryRoot
        guardedFiles.failNextFileOperation = .rootDeletions([
            retryEntryRoot.standardizedFileURL.path
        ])
        let expiryRegistration = clock.latestRegistration
        clock.advance(by: NativeIntake.recoveryWindow)
        let retryDeadline = clock.now().addingTimeInterval(
            NativeIntake.retentionRetryInterval
        )
        await clock.waitUntilLiveSleeper(
            after: expiryRegistration,
            deadline: retryDeadline
        )

        guard guardedFiles.rootDeletionFailureCount(at: retryEntryRoot) == 1
        else {
            return XCTFail(
                "An unreadable entry froze the expiry of its readable siblings."
            )
        }
        XCTAssertFalse(files.fileExists(atPath: freedEntryRoot.path))

        let removalBaseline = guardedFiles.successfulRootRemovalCount
        guardedFiles.failNextFileOperation = nil
        if corruptManifest {
            var recoveredManifest = try XCTUnwrap(
                JSONSerialization.jsonObject(with: originalManifest)
                    as? [String: Any]
            )
            recoveredManifest["expiresAt"] = clock.now()
                .addingTimeInterval(NativeIntake.recoveryWindow)
                .timeIntervalSinceReferenceDate
            try JSONSerialization.data(
                withJSONObject: recoveredManifest
            ).write(to: manifestURL)
        }
        clock.advance(by: NativeIntake.retentionRetryInterval)
        await guardedFiles.waitForRootRemovals(
            removalBaseline + 1,
            successful: true
        )

        XCTAssertFalse(files.fileExists(atPath: retryEntryRoot.path))
        XCTAssertFalse(files.fileExists(atPath: unreadableEntryRoot.path))
        XCTAssertFalse(files.fileExists(atPath: blockedEntryRoot.path))
    }
    func testRootHoldingOnlyAnUnreadableDeferredVoiceStillSweepsIt() async throws {
        let start = Date(timeIntervalSince1970: 2_100_000_000)
        let clock = NativeIntakeTestClock(now: start)
        let principalA = "user_native_intake_only_unreadable_a"
        let principalB = "user_native_intake_only_unreadable_b"
        let harness = NativeIntakeHarness(identity: .clerk(principalA))
        addTeardownBlock { harness.cleanUp() }
        let guardedFiles = NativeIntakeTestFileManager()
        let session = try await harness.makeSession(
            fileManager: guardedFiles,
            now: clock.now,
            sleepUntil: clock.sleep
        )
        _ = try await session.commit(
            .addPhotos([harness.photoInput(seed: 1)])
        )
        let submitted = try await session.commit(
            .setVoice(voice("solitary unmatched voice", duration: 3))
        )
        let submittedVoice = try XCTUnwrap(submitted.voice)
        let principalARoot = intakeRoot(
            containing: submitted.photos[0].photoURL
        )
        let retirement = await session.perform(
            .retireAcceptedPhotos(
                expected: submitted.version,
                photoIDs: submitted.photos.map(\.id),
                preservingUnmatchedVoiceID: submittedVoice.id
            )
        )
        XCTAssertEqual(retirement, .committed)
        assertEmpty(try await session.nextSnapshot())

        let deferredRoot = principalARoot.appendingPathComponent(
            "DeferredUnmatchedVoices",
            isDirectory: true
        )
        let entryRoot = deferredRoot.appendingPathComponent(
            submittedVoice.id.uuidString.lowercased(),
            isDirectory: true
        )
        let deferredVoiceURL = entryRoot.appendingPathComponent(
            "voice-\(submittedVoice.id.uuidString).wav"
        )
        let currentRoot = principalARoot.appendingPathComponent(
            "Current",
            isDirectory: true
        )

        // The root has to hold nothing but the unreadable entry. The leak is
        // that an empty deadline list cancels the retention task outright, so
        // any surviving bundle would contribute its own deadline and schedule
        // the very wake this case exists to demand.
        try? guardedFiles.removeItem(at: currentRoot)
        try files.removeItem(
            at: entryRoot.appendingPathComponent("entry.json")
        )
        XCTAssertFalse(files.fileExists(atPath: currentRoot.path))
        XCTAssertEqual(
            try files.contentsOfDirectory(atPath: deferredRoot.path).count,
            1
        )
        XCTAssertTrue(files.fileExists(atPath: deferredVoiceURL.path))

        await harness.identity.set(.clerk(principalB))
        assertEmpty(try await session.nextSnapshot())

        // An unreadable entry is due immediately, so its wake resumes without
        // ever registering a sleeper and the sweep runs without the clock
        // advancing. Polling for the effect keeps a cancelled retention task
        // an assertion failure rather than a hang.
        var swept = false
        for _ in 0..<500 {
            if !files.fileExists(atPath: entryRoot.path) {
                swept = true
                break
            }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertTrue(
            swept,
            "A root holding only an unreadable entry never woke to sweep it."
        )
        XCTAssertFalse(files.fileExists(atPath: deferredVoiceURL.path))
    }
    private func intakeRoot(containing asset: URL) -> URL {
        asset.deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
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
    private func assertPrincipalRoundTripSupersedes(_ suspension: NativeIntakeSuspensionPoint) async throws {
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

    /// The platform rejects a request body above roughly 4.5 MB with `413` before
    /// the route handler runs, so a full-resolution capture set has to be bounded
    /// before it is staged rather than negotiated with afterwards.
    func testStagesAFullResolutionCaptureInsideTheTransportBudget() async throws {
        let harness = NativeIntakeHarness(identity: .clerk("user_native_intake_budget"))
        let session = try await harness.makeSession()
        addTeardownBlock { harness.cleanUp() }

        let capture = try harness.makeCaptureJPEG(seed: 0)
        XCTAssertGreaterThan(
            capture.count,
            CapturePhotoBudget.maximumPhotoBytes,
            "the fixture has to start over budget or it proves nothing"
        )

        let staged = try await session.commit(
            .addPhotos([.init(loadData: { capture })])
        )

        let stagedBytes = try Data(contentsOf: XCTUnwrap(staged.photos.first).photoURL)
        XCTAssertLessThanOrEqual(
            stagedBytes.count,
            CapturePhotoBudget.maximumPhotoBytes
        )
        assertStillAPhoto(stagedBytes)
    }

    /// Every size assertion in this file is one-sided — `<=` a ceiling, `!=` the
    /// capture — and empty bytes satisfy both. So a `bound` that returned nothing
    /// for an over-budget photo would ship green while destroying the seller's
    /// capture. The product property is that what was staged is still a photo, and
    /// only this asserts it. Found by mutation: seeding the ladder's `smallest`
    /// with empty `Data` passes three of the five bounding tests without this.
    private func assertStillAPhoto(
        _ bytes: Data,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        guard let source = CGImageSourceCreateWithData(bytes as CFData, nil) else {
            XCTFail(
                "staged \(bytes.count) bytes ImageIO cannot open at all",
                file: file,
                line: line
            )
            return
        }
        XCTAssertGreaterThan(
            CGImageSourceGetCount(source),
            0,
            "staged \(bytes.count) bytes carry no image",
            file: file,
            line: line
        )
    }

    /// The budget shrinks photos; it does not decide which bytes are a photo.
    /// `isJPEG` ahead of it and the server behind it own that, so bytes no
    /// encoder can read have to survive staging exactly as they arrived rather
    /// than becoming a new way to lose a capture.
    ///
    /// This covers the ladder-failure passthrough specifically. ImageIO accepts
    /// any `FF D8 FF` prefix as a source, so `bound`'s decode guard is not what
    /// catches this fixture — every ladder step fails to produce an image and the
    /// original bytes fall through. Verified by mutation: replacing the loop's
    /// `smallest` seed with empty `Data` fails this test, while changing the
    /// decode guard's return does not, because that guard is never reached.
    func testStagesUndecodableBytesWithoutChangingThem() async throws {
        let harness = NativeIntakeHarness(identity: .clerk("user_native_intake_opaque"))
        let session = try await harness.makeSession()
        addTeardownBlock { harness.cleanUp() }

        // A JPEG magic number in front of bytes ImageIO cannot decode. It has to
        // exceed the ceiling, or the budget returns at its size guard and the
        // decode path this test exists to cover never runs.
        let opaque = Data([0xFF, 0xD8, 0xFF])
            + Data(repeating: 0x5A, count: CapturePhotoBudget.maximumPhotoBytes)
        XCTAssertGreaterThan(opaque.count, CapturePhotoBudget.maximumPhotoBytes)

        let staged = try await session.commit(
            .addPhotos([.init(loadData: { opaque })])
        )

        let stagedBytes = try Data(contentsOf: XCTUnwrap(staged.photos.first).photoURL)
        XCTAssertEqual(stagedBytes, opaque)
    }

    /// Five photos and a full-length voice note share one multipart body, so the
    /// worst realistic request is the one this has to fit.
    func testStagesFivePhotosThatFitOneRequestBodyAlongsideVoice() async throws {
        let harness = NativeIntakeHarness(identity: .clerk("user_native_intake_budget_set"))
        let session = try await harness.makeSession()
        addTeardownBlock { harness.cleanUp() }

        let captures = try (0..<5).map(harness.makeCaptureJPEG(seed:))
        let staged = try await session.commit(
            .addPhotos(captures.map { capture in .init(loadData: { capture }) })
        )
        XCTAssertEqual(staged.photos.count, 5)

        let stagedTotal = try staged.photos
            .map { photo -> Int in
                let bytes = try Data(contentsOf: photo.photoURL)
                assertStillAPhoto(bytes)
                return bytes.count
            }
            .reduce(0, +)
        let worstCaseBody = stagedTotal
            + ItemRunSubmissionVoice.maximumByteLength
            + CapturePhotoBudget.multipartEnvelopeAllowanceBytes

        XCTAssertLessThanOrEqual(
            worstCaseBody,
            CapturePhotoBudget.maximumRequestBodyBytes
        )
    }

    /// The photo-set fingerprint is computed over these bytes, and it governs guest
    /// allowance, guided correction, and AI-item credit settlement. A capture that
    /// staged to different bytes on a retry would read as a different submission and
    /// spend a second credit, so the bounding has to be deterministic.
    func testStagesOneCaptureToTheSameBytesEveryTime() async throws {
        let capture = try NativeIntakeHarness(identity: .clerk("seed"))
            .makeCaptureJPEG(seed: 3)

        var digests: Set<String> = []
        for attempt in 0..<3 {
            let harness = NativeIntakeHarness(
                identity: .clerk("user_native_intake_determinism_\(attempt)")
            )
            let session = try await harness.makeSession()
            addTeardownBlock { harness.cleanUp() }
            let staged = try await session.commit(
                .addPhotos([.init(loadData: { capture })])
            )
            let bytes = try Data(contentsOf: XCTUnwrap(staged.photos.first).photoURL)
            // Staging the same `Data` three times matches trivially if nothing
            // re-encodes it, so the bytes have to be shown to have changed first.
            // Without this the digest agreement proves nothing about bounding.
            XCTAssertNotEqual(bytes, capture)
            XCTAssertLessThanOrEqual(bytes.count, CapturePhotoBudget.maximumPhotoBytes)
            assertStillAPhoto(bytes)
            digests.insert(LocalPhotoFingerprint.digest(of: bytes))
        }

        XCTAssertEqual(digests.count, 1)
    }

    /// The other half of the fingerprint contract: bounding must not collapse
    /// distinct captures onto identical bytes, or replacing a photo would settle as
    /// a replay of the submission it replaced.
    func testStagesDistinctCapturesToDistinctBytes() async throws {
        let harness = NativeIntakeHarness(identity: .clerk("user_native_intake_distinct"))
        let session = try await harness.makeSession()
        addTeardownBlock { harness.cleanUp() }

        let captures = try (0..<3).map(harness.makeCaptureJPEG(seed:))
        let staged = try await session.commit(
            .addPhotos(captures.map { capture in .init(loadData: { capture }) })
        )

        let stagedBytes = try staged.photos.map { photo in
            try Data(contentsOf: photo.photoURL)
        }
        // These seeds already differ before bounding, so distinctness alone would
        // hold with no re-encoding at all. Pinning each staged photo against the
        // capture it came from is what makes the distinctness claim about bounding.
        for (bytes, capture) in zip(stagedBytes, captures) {
            XCTAssertNotEqual(bytes, capture)
            XCTAssertLessThanOrEqual(bytes.count, CapturePhotoBudget.maximumPhotoBytes)
            assertStillAPhoto(bytes)
        }
        XCTAssertEqual(Set(stagedBytes.map(LocalPhotoFingerprint.digest(of:))).count, 3)
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
private enum NativeIntakeSymlinkLocation: String, CaseIterable { case ancestor, principal, assets }
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
    /// A 12 MP JPEG the size of a real phone capture.
    ///
    /// The content is seeded incompressible noise rather than a photograph on
    /// purpose: it guarantees the fixture starts well over budget, and it is the
    /// hardest input the bounding can be handed, so a set that fits with this
    /// fits with anything a camera produces.
    func makeCaptureJPEG(seed: Int) throws -> Data {
        let width = 4032
        let height = 3024
        var state = (UInt64(bitPattern: Int64(seed)) &* 0x9E37_79B9_7F4A_7C15) | 1
        var pixels = [UInt8](repeating: 255, count: width * height * 4)
        for index in stride(from: 0, to: pixels.count, by: 4) {
            state ^= state << 13
            state ^= state >> 7
            state ^= state << 17
            pixels[index] = UInt8(truncatingIfNeeded: state)
            pixels[index + 1] = UInt8(truncatingIfNeeded: state >> 8)
            pixels[index + 2] = UInt8(truncatingIfNeeded: state >> 16)
        }
        let provider = try XCTUnwrap(CGDataProvider(data: Data(pixels) as CFData))
        let image = try XCTUnwrap(
            CGImage(
                width: width,
                height: height,
                bitsPerComponent: 8,
                bitsPerPixel: 32,
                bytesPerRow: width * 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGBitmapInfo(
                    rawValue: CGImageAlphaInfo.noneSkipLast.rawValue
                ),
                provider: provider,
                decode: nil,
                shouldInterpolate: false,
                intent: .defaultIntent
            )
        )
        return try XCTUnwrap(UIImage(cgImage: image).jpegData(compressionQuality: 0.95))
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
    case rootDeletions(Set<String>)
}
final class NativeIntakeTestFileManager: FileManager, @unchecked Sendable {
    private let lock = NSLock()
    private let isolatedTemporaryDirectory = FileManager.default.temporaryDirectory
        .appendingPathComponent("snaplist-native-intake-\(UUID().uuidString)", isDirectory: true)
    override var temporaryDirectory: URL { isolatedTemporaryDirectory }
    private var rejectsReads = false
    private var rejectsDeferredUnmatchedVoiceReads = false
    private var pathsReportingMissing = Set<String>()
    private var nextFailure: NativeIntakeFileFailure?
    private var failedRootDeletionPaths = Set<String>()
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
    var rejectDeferredUnmatchedVoiceReads: Bool {
        get { lock.synchronized { rejectsDeferredUnmatchedVoiceReads } }
        set { lock.synchronized { rejectsDeferredUnmatchedVoiceReads = newValue } }
    }
    /// Makes metadata reads of `url` report it as missing while it is still
    /// listed by its parent directory, matching a removal that raced the
    /// retention sweep or only partly succeeded.
    func reportMissing(_ url: URL) {
        lock.synchronized {
            _ = pathsReportingMissing.insert(url.standardizedFileURL.path)
        }
    }
    fileprivate func rootDeletionFailureCount(at root: URL) -> Int {
        lock.synchronized { failedRootDeletionPaths.contains(root.standardizedFileURL.path) ? 1 : 0 }
    }
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
        let standardized = URL(fileURLWithPath: path).standardizedFileURL.path
        if lock.synchronized({ pathsReportingMissing.contains(standardized) }) {
            throw CocoaError(.fileNoSuchFile)
        }
        return try super.attributesOfItem(atPath: path)
    }
    override func contentsOfDirectory(
        at url: URL,
        includingPropertiesForKeys keys: [URLResourceKey]?,
        options mask: FileManager.DirectoryEnumerationOptions
    ) throws -> [URL] {
        if url.lastPathComponent == "DeferredUnmatchedVoices" {
            if lock.synchronized({ rejectsDeferredUnmatchedVoiceReads }) {
                throw CocoaError(.fileReadNoPermission)
            }
        }
        return try super.contentsOfDirectory(
            at: url,
            includingPropertiesForKeys: keys,
            options: mask
        )
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
        let path = URL.standardizedFileURL.path
        let fail = lock.synchronized {
            guard case .rootDeletions(let paths) = nextFailure else { return false }
            guard paths.contains(path) else { return false }
            failedRootDeletionPaths.insert(path)
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
                    wake: CheckedContinuation<Void, Never>?,
                    live: [(CheckedContinuation<LiveSleeperMatch, Never>, LiveSleeperMatch)]
                ) in
                    pendingSleeperIDs.remove(id)
                    let cancelled = cancelledSleeperIDs.remove(id) != nil
                    guard current < deadline, !cancelled, !Task.isCancelled else {
                        return (continuation, [])
                    }
                    scheduleRegistrations += 1
                    let registration = scheduleRegistrations
                    sleepers.append((id, registration, deadline, continuation))
                    let live = liveSleeperWaiters.filter {
                        $0.after < registration && $0.deadline == deadline
                    }
                    liveSleeperWaiters.removeAll {
                        $0.after < registration && $0.deadline == deadline
                    }
                    let match = LiveSleeperMatch(id: id, registration: registration)
                    return (
                        nil,
                        live.map { ($0.continuation, match) }
                    )
                }
                ready.wake?.resume()
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
    private let assetExtension: String
    private let writesBeforeSuspension: Int
    private var assetWriteCount = 0
    private var writeWaiters: [CheckedContinuation<Void, Never>] = []
    private var didSuspend = false

    init(
        assetExtension: String = "jpg",
        writesBeforeSuspension: Int = 2
    ) {
        self.assetExtension = assetExtension
        self.writesBeforeSuspension = writesBeforeSuspension
        super.init()
    }

    override func setAttributes(
        _ attributes: [FileAttributeKey: Any],
        ofItemAtPath path: String
    ) throws {
        try super.setAttributes(attributes, ofItemAtPath: path)
        guard path.contains("/Assets/"),
              path.hasSuffix(".\(assetExtension)") else {
            return
        }
        let shouldSuspend = lock.synchronized {
            assetWriteCount += 1
            guard assetWriteCount == writesBeforeSuspension else {
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

    func waitUntilTargetAssetsAreWritten() async {
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

    func waitUntilPhotoAssetsAreWritten() async {
        await waitUntilTargetAssetsAreWritten()
    }

    func resumeStaging() { release.signal() }
}

@MainActor
private final class NativeIntakeOperationActivity {
    private(set) var isActive = true

    func cancel() {
        isActive = false
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
