import Foundation
import UIKit
import XCTest
@testable import SnapList

@MainActor
final class NativeIntakeAdoptionTests: XCTestCase {
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
                delete: {
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
