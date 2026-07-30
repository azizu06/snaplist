import Foundation
import UIKit
import XCTest
@testable import SnapList

@MainActor
final class NativeIntakeAdoptionTests: XCTestCase {
    func testProductionAnonymousIntakeRestoresPhotoAndVoiceAcrossRelaunch()
        async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let committedSnapshot: NativeIntake.Snapshot
        do {
            let firstDependencies = AppDependencies.make(
                configuration: .preview,
                nativeIntakeIdentitySource: productionAnonymousIdentitySource(),
                nativeIntakeApplicationSupportDirectory: root
            )
            let firstCapture = CaptureFlowModel(
                camera: firstDependencies.captureCamera,
                evaluator: firstDependencies.framingEvaluator,
                intake: firstDependencies.nativeIntake
            )
            let initialRestoration = await firstCapture.restore()
            XCTAssertEqual(initialRestoration, .noDraft)
            let addedPhotoCount = await firstCapture.stageLibraryPhotos([
                NativeIntakeAdoptionPhoto(data: try makeJPEG(seed: 10))
            ])
            XCTAssertEqual(addedPhotoCount, 1)
            let activationID = try XCTUnwrap(
                firstCapture.intakeSnapshot?.version.activationID
            )
            let provisionalVoiceURL = root.appendingPathComponent(
                "anonymous-relaunch.wav"
            )
            try Data("anonymous relaunch voice".utf8).write(
                to: provisionalVoiceURL
            )
            let savedVoice = await firstCapture.saveVoiceNote(
                provisionalURL: provisionalVoiceURL,
                duration: 4,
                expectedActivationID: activationID
            )
            let committedVoice = try XCTUnwrap(savedVoice)
            await waitUntil {
                firstCapture.intakeSnapshot?.voice == committedVoice
            }
            committedSnapshot = try XCTUnwrap(firstCapture.intakeSnapshot)
        }

        let relaunchedDependencies = AppDependencies.make(
            configuration: .preview,
            nativeIntakeIdentitySource: productionAnonymousIdentitySource(),
            nativeIntakeApplicationSupportDirectory: root
        )
        let relaunchedCapture = CaptureFlowModel(
            camera: relaunchedDependencies.captureCamera,
            evaluator: relaunchedDependencies.framingEvaluator,
            intake: relaunchedDependencies.nativeIntake
        )
        let restoredResult = await relaunchedCapture.restore()
        XCTAssertEqual(restoredResult, .stagedPhoto)
        XCTAssertEqual(
            relaunchedCapture.intakeSnapshot?.photos,
            committedSnapshot.photos
        )
        XCTAssertEqual(
            relaunchedCapture.intakeSnapshot?.voice,
            committedSnapshot.voice
        )
    }

    func testProductionScanAndPhotoReviewPublishOnlyCommittedNativeIntakeSnapshots()
        async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let identity = NativeIntakeAdoptionIdentity(
            .init(
                verifiedClerkSubject: "user_native_intake_adoption_a",
                persistedAppAttestKeyID: nil
            )
        )
        let dependencies = AppDependencies.make(
            configuration: .preview,
            nativeIntakeIdentitySource: identity.source,
            nativeIntakeApplicationSupportDirectory: root
        )
        let capture = CaptureFlowModel(
            camera: dependencies.captureCamera,
            evaluator: dependencies.framingEvaluator,
            intake: dependencies.nativeIntake
        )

        let restoration = await capture.restore()
        XCTAssertEqual(restoration, .noDraft)
        let photos = try (1...5).map {
            NativeIntakeAdoptionPhoto(data: try makeJPEG(seed: $0))
        }
        let added = await capture.stageLibraryPhotos(photos)

        XCTAssertEqual(added, 5)
        XCTAssertEqual(capture.stagedPhotos.count, 5)
        XCTAssertEqual(
            capture.intakeSnapshot?.photos,
            capture.stagedPhotos,
            "Production Scan must publish only its committed NativeIntake snapshot."
        )

        let eventStream = await capture.nativeIntakeEvents()
        let events = try XCTUnwrap(eventStream)
        var iterator = events.makeAsyncIterator()
        guard case .snapshot(let initialSnapshot)? = await iterator.next() else {
            return XCTFail("NativeIntake must replay the committed A snapshot.")
        }
        XCTAssertEqual(initialSnapshot.photos, capture.stagedPhotos)

        let request = CaptureBoundaryRequest(
            destination: .photoReview,
            photos: initialSnapshot.photos,
            opener: .reviewButton
        )
        let session = try XCTUnwrap(
            PhotoReviewLiveSession.start(
                from: request,
                captureFlow: capture
            )
        )
        let didEnterReview = await capture.markPhotoReviewEntered(
            activationID: session.intakeActivationID
        )
        XCTAssertTrue(didEnterReview)

        identity.set(
            .init(
                verifiedClerkSubject: "user_native_intake_adoption_b",
                persistedAppAttestKeyID: nil
            )
        )
        let dismissal = await iterator.next()
        XCTAssertEqual(
            dismissal,
            .dismissActivePhotoReview,
            "Only an active departing Photo Review is dismissed."
        )
        guard case .snapshot(let emptyB)? = await iterator.next() else {
            return XCTFail("Principal B must publish its own committed snapshot.")
        }
        XCTAssertTrue(emptyB.photos.isEmpty)
        await waitUntil { capture.intakeSnapshot?.version == emptyB.version }
        XCTAssertTrue(capture.stagedPhotos.isEmpty)

        let bPhoto = NativeIntakeAdoptionPhoto(data: try makeJPEG(seed: 6))
        let bAdded = await capture.stageLibraryPhotos([bPhoto])
        XCTAssertEqual(bAdded, 1)
        guard case .snapshot(let populatedB)? = await iterator.next() else {
            return XCTFail("Principal B addition must publish one snapshot.")
        }
        XCTAssertEqual(populatedB.photos, capture.stagedPhotos)

        identity.set(
            .init(
                verifiedClerkSubject: "user_native_intake_adoption_a",
                persistedAppAttestKeyID: nil
            )
        )
        guard case .snapshot(let returnedA)? = await iterator.next() else {
            return XCTFail("Returning to A must not dismiss an inactive review.")
        }
        await waitUntil { capture.intakeSnapshot?.version == returnedA.version }
        XCTAssertEqual(returnedA.photos, initialSnapshot.photos)

        let movedID = try XCTUnwrap(session.store.photos.last?.id)
        let reorder = await session.commitReorder(
            photoID: movedID,
            destinationIndex: 0,
            captureFlow: capture
        )
        guard case .snapshot(let reorderedA)? = await iterator.next() else {
            return XCTFail("A committed reorder must publish one snapshot.")
        }
        XCTAssertEqual(reorder?.photoID, movedID)
        XCTAssertEqual(session.store.photos, reorderedA.photos)
        XCTAssertEqual(capture.stagedPhotos, reorderedA.photos)

        let removedID = try XCTUnwrap(session.store.photos.last?.id)
        let activationID = try XCTUnwrap(session.intakeActivationID)
        let removalResult = await capture.removePhotoReviewPhoto(
            id: removedID,
            expectedActivationID: activationID
        )
        let removedA = try XCTUnwrap(removalResult)
        guard case .snapshot(let removalEvent)? = await iterator.next() else {
            return XCTFail("A committed delete must publish one snapshot.")
        }
        XCTAssertEqual(removedA, removalEvent)
        _ = session.publishCommittedDelete(
            id: removedID,
            removedIndex: reorderedA.photos.count - 1,
            snapshot: removedA
        )
        XCTAssertEqual(session.store.photos, removedA.photos)

        let voiceURL = root.appendingPathComponent("provisional.wav")
        try Data("bounded voice".utf8).write(to: voiceURL)
        let voiceResult = await capture.saveVoiceNote(
            provisionalURL: voiceURL,
            duration: 4,
            expectedActivationID: activationID
        )
        let committedVoice = try XCTUnwrap(voiceResult)
        guard case .snapshot(let voicedA)? = await iterator.next() else {
            return XCTFail("A committed voice note must publish one snapshot.")
        }
        XCTAssertEqual(committedVoice, voicedA.voice)
        session.publishCommittedSnapshot(voicedA)
        XCTAssertEqual(session.voiceNoteStore.savedNote?.url, committedVoice.mediaURL)

        let restoredDependencies = AppDependencies.make(
            configuration: .preview,
            nativeIntakeIdentitySource: identity.source,
            nativeIntakeApplicationSupportDirectory: root
        )
        let restoredCapture = CaptureFlowModel(
            camera: restoredDependencies.captureCamera,
            evaluator: restoredDependencies.framingEvaluator,
            intake: restoredDependencies.nativeIntake
        )
        let restoredResult = await restoredCapture.restore()
        XCTAssertEqual(restoredResult, .stagedPhoto)
        XCTAssertEqual(restoredCapture.intakeSnapshot?.photos, voicedA.photos)
        XCTAssertEqual(restoredCapture.intakeSnapshot?.voice, voicedA.voice)

        let photoReviewIntake = PhotoReviewIntake(
            captureFlow: capture,
            expectedActivationID: activationID
        )
        session.store.beginPickerRequest(.add)
        let suspendedPhoto = NativeIntakeAdoptionSuspendedPhoto(
            data: try makeJPEG(seed: 7)
        )
        let stalePicker = Task {
            await photoReviewIntake.apply(
                [suspendedPhoto],
                to: session.store
            )
        }
        await suspendedPhoto.waitUntilRequested()

        let reorderGate = NativeIntakeAdoptionGate()
        let staleReorderPhotoID = try XCTUnwrap(
            session.store.photos.last?.id
        )
        let staleReorder = Task {
            await reorderGate.suspend()
            return await session.commitReorder(
                photoID: staleReorderPhotoID,
                destinationIndex: 0,
                captureFlow: capture
            )
        }
        await reorderGate.waitUntilRequested()

        let voiceGate = NativeIntakeAdoptionGate()
        let voiceFiles = NativeIntakeAdoptionVoiceFiles(root: root)
        let voiceAudio = NativeIntakeAdoptionVoiceAudio()
        let staleVoiceStore = VoiceNoteStore(
            audio: voiceAudio,
            files: voiceFiles,
            authority: VoiceNoteCommitAuthority(
                save: { url, duration, isActive in
                    await voiceGate.suspend()
                    guard let voice = await capture.saveVoiceNote(
                        provisionalURL: url,
                        duration: duration,
                        expectedActivationID: activationID,
                        while: isActive
                    ) else {
                        voiceGate.finish()
                        return nil
                    }
                    voiceGate.finish()
                    return VoiceNoteAsset(
                        url: voice.mediaURL,
                        duration: voice.duration
                    )
                },
                delete: { _ in
                    await capture.deleteVoiceNote(
                        expectedActivationID: activationID
                    )
                }
            )
        )
        await staleVoiceStore.startRecording()
        voiceAudio.recordingSnapshot = .init(
            elapsed: 4,
            averagePower: -20
        )
        staleVoiceStore.save()
        await voiceGate.waitUntilRequested()
        XCTAssertTrue(staleVoiceStore.dismiss())
        voiceGate.resume()
        await voiceGate.waitUntilFinished()
        await Task.yield()
        XCTAssertNil(staleVoiceStore.savedNote)
        XCTAssertEqual(staleVoiceStore.phase, .ready)
        XCTAssertEqual(
            capture.intakeSnapshot?.voice,
            committedVoice,
            "Cancel must invalidate an uncommitted Voice Note save."
        )

        let voiceDeleteGate = NativeIntakeAdoptionGate()
        let staleVoiceDelete = Task {
            await voiceDeleteGate.suspend()
            return await capture.deleteVoiceNote(
                expectedActivationID: activationID
            )
        }
        await voiceDeleteGate.waitUntilRequested()

        identity.set(
            .init(
                verifiedClerkSubject: "user_native_intake_adoption_b",
                persistedAppAttestKeyID: nil
            )
        )
        guard case .snapshot(let returnedB)? = await iterator.next() else {
            return XCTFail(
                "The principal change must publish B before stale completions."
            )
        }
        await waitUntil { capture.intakeSnapshot?.version == returnedB.version }

        let newerRequest = PhotoReviewPickerRequest.replace(
            photoID: try XCTUnwrap(session.store.photos.first?.id)
        )
        session.store.beginPickerRequest(newerRequest)
        suspendedPhoto.resume()
        reorderGate.resume()
        voiceDeleteGate.resume()

        let stalePickerOutcome = await stalePicker.value
        let staleReorderOutcome = await staleReorder.value
        let staleVoiceDeleteOutcome = await staleVoiceDelete.value
        XCTAssertEqual(stalePickerOutcome, .inert)
        XCTAssertNil(staleReorderOutcome)
        XCTAssertFalse(staleVoiceDeleteOutcome)
        XCTAssertEqual(session.store.activePickerRequest, newerRequest)
        XCTAssertNil(photoReviewIntake.recovery)
        XCTAssertEqual(
            capture.stagedPhotos,
            populatedB.photos,
            "Stale Photo Review and Voice Note completions cannot publish into B."
        )
        XCTAssertNil(capture.intakeSnapshot?.voice)
    }

    func testProductionScanReservationCannotPublishAfterPrincipalReconciliation()
        async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let identity = NativeIntakeAdoptionIdentity(
            .init(
                verifiedClerkSubject: "user_native_intake_scan_a",
                persistedAppAttestKeyID: nil
            )
        )
        let dependencies = AppDependencies.make(
            configuration: .preview,
            nativeIntakeIdentitySource: identity.source,
            nativeIntakeApplicationSupportDirectory: root
        )
        let capture = CaptureFlowModel(
            camera: dependencies.captureCamera,
            evaluator: dependencies.framingEvaluator,
            intake: dependencies.nativeIntake
        )
        _ = await capture.restore()
        let activationA = try XCTUnwrap(
            capture.intakeSnapshot?.version.activationID
        )
        let projectionGate = NativeIntakeAdoptionGate()
        var shouldSuspendProjection = true
        capture.setNativeIntakeEventProjectionHook {
            guard shouldSuspendProjection else { return }
            shouldSuspendProjection = false
            await projectionGate.suspend()
        }
        let reservation = try XCTUnwrap(capture.reserveLibraryIntake())
        let photo = NativeIntakeAdoptionObservedPhoto(
            data: try makeJPEG(seed: 8)
        )

        identity.set(
            .init(
                verifiedClerkSubject: "user_native_intake_scan_b",
                persistedAppAttestKeyID: nil
            )
        )
        await projectionGate.waitUntilRequested()
        let staleScan = Task {
            await capture.stageLibraryPhotos(
                [photo],
                reservation: reservation
            )
        }
        for _ in 0..<100 {
            await Task.yield()
        }
        projectionGate.resume()

        let staleScanResult = await staleScan.value
        XCTAssertEqual(staleScanResult, 0)
        let events = await dependencies.nativeIntake.events()
        var iterator = events.makeAsyncIterator()
        guard case .snapshot(let snapshotB)? = await iterator.next() else {
            return XCTFail("Principal B must replay its current intake.")
        }
        XCTAssertNotEqual(snapshotB.version.activationID, activationA)
        XCTAssertTrue(snapshotB.photos.isEmpty)
        XCTAssertEqual(
            photo.loadCount,
            0,
            "A reserved Scan operation must be rejected before loading into B."
        )
    }

    func testAuthorityVoiceDeleteCannotReplaceNewerRerecording()
        async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let identity = NativeIntakeAdoptionIdentity(
            .init(
                verifiedClerkSubject: "user_native_intake_voice_delete",
                persistedAppAttestKeyID: nil
            )
        )
        let dependencies = AppDependencies.make(
            configuration: .preview,
            nativeIntakeIdentitySource: identity.source,
            nativeIntakeApplicationSupportDirectory: root
        )
        let capture = CaptureFlowModel(
            camera: dependencies.captureCamera,
            evaluator: dependencies.framingEvaluator,
            intake: dependencies.nativeIntake
        )
        _ = await capture.restore()
        let stagedPhotoCount = await capture.stageLibraryPhotos([
            NativeIntakeAdoptionPhoto(data: try makeJPEG(seed: 9))
        ])
        XCTAssertEqual(stagedPhotoCount, 1)
        let activationID = try XCTUnwrap(
            capture.intakeSnapshot?.version.activationID
        )
        let provisionalURL = root.appendingPathComponent(
            "delete-rerecord.wav"
        )
        try Data("retained voice".utf8).write(to: provisionalURL)
        let savedVoice = await capture.saveVoiceNote(
            provisionalURL: provisionalURL,
            duration: 4,
            expectedActivationID: activationID
        )
        let voice = try XCTUnwrap(savedVoice)
        await waitUntil { capture.intakeSnapshot?.voice == voice }

        let deleteGate = NativeIntakeAdoptionGate()
        let audio = NativeIntakeAdoptionVoiceAudio()
        let store = VoiceNoteStore(
            savedNote: VoiceNoteAsset(
                url: voice.mediaURL,
                duration: voice.duration
            ),
            audio: audio,
            files: NativeIntakeAdoptionVoiceFiles(root: root),
            authority: VoiceNoteCommitAuthority(
                save: { _, _, _ in nil },
                delete: { isActive in
                    await deleteGate.suspend()
                    return await capture.deleteVoiceNote(
                        expectedActivationID: activationID,
                        while: isActive
                    )
                }
            )
        )
        let staleDelete = Task {
            await store.deleteSavedNote()
        }
        await deleteGate.waitUntilRequested()

        await store.rerecord()
        XCTAssertEqual(store.phase, .recording(elapsed: 0, level: 0))
        XCTAssertEqual(store.savedNote?.url, voice.mediaURL)
        deleteGate.resume()

        let staleDeleteResult = await staleDelete.value
        XCTAssertFalse(staleDeleteResult)
        XCTAssertEqual(store.phase, .recording(elapsed: 0, level: 0))
        XCTAssertEqual(store.savedNote?.url, voice.mediaURL)
        XCTAssertEqual(capture.intakeSnapshot?.voice, voice)
    }

    func testConcurrentPhotoReviewReordersReturnTheirOwnCommittedSnapshots()
        async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let identity = NativeIntakeAdoptionIdentity(
            .init(
                verifiedClerkSubject: "user_native_intake_reorder",
                persistedAppAttestKeyID: nil
            )
        )
        let dependencies = AppDependencies.make(
            configuration: .preview,
            nativeIntakeIdentitySource: identity.source,
            nativeIntakeApplicationSupportDirectory: root
        )
        let capture = CaptureFlowModel(
            camera: dependencies.captureCamera,
            evaluator: dependencies.framingEvaluator,
            intake: dependencies.nativeIntake
        )
        _ = await capture.restore()
        let added = await capture.stageLibraryPhotos(
            try (1...3).map {
                NativeIntakeAdoptionPhoto(data: try makeJPEG(seed: $0))
            }
        )
        XCTAssertEqual(added, 3)
        let activationID = try XCTUnwrap(
            capture.intakeSnapshot?.version.activationID
        )
        let ids = capture.stagedPhotos.map(\.id)
        let session = try XCTUnwrap(
            PhotoReviewLiveSession.start(
                from: CaptureBoundaryRequest(
                    destination: .photoReview,
                    photos: capture.stagedPhotos,
                    opener: .reviewButton
                ),
                captureFlow: capture
            )
        )

        async let first = session.commitReorder(
            photoID: ids[2],
            destinationIndex: 0,
            captureFlow: capture
        )
        async let second = session.commitReorder(
            photoID: ids[0],
            destinationIndex: 2,
            captureFlow: capture
        )
        let (firstResult, secondResult) = await (first, second)
        let finalOrder = [ids[2], ids[1], ids[0]]

        XCTAssertEqual(firstResult?.photoID, ids[2])
        XCTAssertEqual(
            firstResult?.announcement,
            "Moved to photo 1 of 3. Cover."
        )
        XCTAssertEqual(secondResult?.photoID, ids[0])
        XCTAssertEqual(secondResult?.announcement, "Moved to photo 3 of 3.")
        XCTAssertEqual(session.store.photos.map(\.id), finalOrder)
        await waitUntil {
            capture.intakeSnapshot?.photos.map(\.id) == finalOrder
        }
        XCTAssertEqual(
            capture.intakeSnapshot?.version.activationID,
            activationID
        )
    }

    private func makeJPEG(seed: Int) throws -> Data {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8))
        return renderer.jpegData(withCompressionQuality: 0.9) { context in
            UIColor(
                red: CGFloat(seed % 3) / 2,
                green: CGFloat(seed % 5) / 4,
                blue: CGFloat(seed % 7) / 6,
                alpha: 1
            ).setFill()
            context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
        }
    }

    private func waitUntil(
        _ condition: @escaping @MainActor () -> Bool
    ) async {
        for _ in 0..<1_000 where !condition() {
            await Task.yield()
        }
        XCTAssertTrue(condition())
    }

    private func productionAnonymousIdentitySource()
        -> NativeIntake.IdentitySource {
        ClerkAuthenticationComposition.makeNativeIntakeIdentitySource(
            keyStore: NativeIntakeAdoptionEmptyAppAttestKeyStore(),
            verifiedClerkSubject: { nil },
            clerkChanges: {
                AsyncStream { $0.finish() }
            },
            appAttestChanges: {
                AsyncStream { $0.finish() }
            }
        )
    }
}

@MainActor
private final class NativeIntakeAdoptionGate {
    private var requested = false
    private var finished = false
    private var requestWaiters: [CheckedContinuation<Void, Never>] = []
    private var finishWaiters: [CheckedContinuation<Void, Never>] = []
    private var continuation: CheckedContinuation<Void, Never>?

    func suspend() async {
        requested = true
        requestWaiters.forEach { $0.resume() }
        requestWaiters = []
        await withCheckedContinuation { continuation in
            self.continuation = continuation
        }
    }

    func waitUntilRequested() async {
        if requested { return }
        await withCheckedContinuation { continuation in
            requestWaiters.append(continuation)
        }
    }

    func resume() {
        continuation?.resume()
        continuation = nil
    }

    func finish() {
        finished = true
        finishWaiters.forEach { $0.resume() }
        finishWaiters = []
    }

    func waitUntilFinished() async {
        if finished { return }
        await withCheckedContinuation { continuation in
            finishWaiters.append(continuation)
        }
    }
}

@MainActor
private final class NativeIntakeAdoptionVoiceAudio: VoiceNoteAudioClient {
    var permission: VoiceNoteMicrophonePermission = .allowed
    var recordingSnapshot = VoiceNoteRecordingSnapshot(
        elapsed: 0,
        averagePower: -60
    )
    var interruptionHandler: (() -> Void)?
    var routeChangeHandler: (() -> Void)?
    var playbackFinishedHandler: (() -> Void)?
    var recordingFinishedHandler: ((VoiceNoteRecordingCompletion) -> Void)?

    func requestPermission() async -> VoiceNoteMicrophonePermission {
        permission
    }

    func startRecording(to _: URL) throws {}
    func stopRecording() {}
    func startPlaying(_: URL) throws {}
    func pausePlaying() {}
    func stopPlaying() {}
}

private final class NativeIntakeAdoptionVoiceFiles: VoiceNoteFileStoring {
    private let url: URL

    init(root: URL) {
        url = root.appendingPathComponent(
            "stale-voice-\(UUID().uuidString).wav"
        )
    }

    func makeProvisionalURL() throws -> URL {
        try Data("stale voice".utf8).write(to: url)
        return url
    }

    func commit(
        provisionalURL: URL,
        duration: TimeInterval,
        replacing _: VoiceNoteAsset?
    ) throws -> VoiceNoteAsset {
        VoiceNoteAsset(url: provisionalURL, duration: duration)
    }

    func discardProvisional(at url: URL) throws {
        try? FileManager.default.removeItem(at: url)
    }

    func delete(_: VoiceNoteAsset) throws {}
}

private struct NativeIntakeAdoptionPhoto: CaptureLibraryPhotoLoading {
    let data: Data

    func loadPhotoData() async throws -> Data? {
        data
    }
}

private struct NativeIntakeAdoptionEmptyAppAttestKeyStore:
    AppAttestKeyIDStoring {
    func load() throws -> AppAttestStoredKey? { nil }
    func save(_: AppAttestStoredKey) throws {}
    func remove() throws {}
}

@MainActor
private final class NativeIntakeAdoptionObservedPhoto:
    CaptureLibraryPhotoLoading {
    let data: Data
    private(set) var loadCount = 0

    init(data: Data) {
        self.data = data
    }

    func loadPhotoData() async throws -> Data? {
        loadCount += 1
        return data
    }
}

@MainActor
private final class NativeIntakeAdoptionSuspendedPhoto:
    CaptureLibraryPhotoLoading {
    private let data: Data
    private var requested = false
    private var requestWaiters: [CheckedContinuation<Void, Never>] = []
    private var dataWaiter: CheckedContinuation<Data?, Never>?

    init(data: Data) {
        self.data = data
    }

    func loadPhotoData() async throws -> Data? {
        requested = true
        requestWaiters.forEach { $0.resume() }
        requestWaiters = []
        return await withCheckedContinuation { continuation in
            dataWaiter = continuation
        }
    }

    func waitUntilRequested() async {
        if requested { return }
        await withCheckedContinuation { continuation in
            requestWaiters.append(continuation)
        }
    }

    func resume() {
        dataWaiter?.resume(returning: data)
        dataWaiter = nil
    }
}

private final class NativeIntakeAdoptionIdentity: @unchecked Sendable {
    private let lock = NSLock()
    private var identity: NativeIntake.Identity
    private var continuations: [UUID: AsyncStream<Void>.Continuation] = [:]

    init(_ identity: NativeIntake.Identity) {
        self.identity = identity
    }

    var source: NativeIntake.IdentitySource {
        NativeIntake.IdentitySource(
            current: { [weak self] in
                self?.current()
                    ?? .init(
                        verifiedClerkSubject: nil,
                        persistedAppAttestKeyID: nil
                    )
            },
            changes: { [weak self] in
                guard let self else {
                    return AsyncStream { $0.finish() }
                }
                let id = UUID()
                return AsyncStream { continuation in
                    self.lock.withLock {
                        self.continuations[id] = continuation
                    }
                    continuation.onTermination = { [weak self] _ in
                        self?.lock.withLock {
                            self?.continuations[id] = nil
                        }
                    }
                }
            }
        )
    }

    private func current() -> NativeIntake.Identity {
        lock.withLock { identity }
    }

    func set(_ identity: NativeIntake.Identity) {
        let continuations = lock.withLock {
            self.identity = identity
            return Array(self.continuations.values)
        }
        continuations.forEach { $0.yield() }
    }
}
