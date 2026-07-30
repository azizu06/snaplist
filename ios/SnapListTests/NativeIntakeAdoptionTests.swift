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
        let removalResult = await capture.removePhotoReviewPhoto(id: removedID)
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
            duration: 4
        )
        let committedVoice = try XCTUnwrap(voiceResult)
        guard case .snapshot(let voicedA)? = await iterator.next() else {
            return XCTFail("A committed voice note must publish one snapshot.")
        }
        XCTAssertEqual(committedVoice, voicedA.voice)
        session.publishCommittedSnapshot(voicedA)
        XCTAssertEqual(session.voiceNoteStore.savedNote?.url, committedVoice.mediaURL)

        let suspended = NativeIntakeAdoptionSuspendedPhoto(
            data: try makeJPEG(seed: 7)
        )
        let stalePicker = Task {
            await capture.stageLibraryPhotos([suspended])
        }
        await suspended.waitUntilRequested()
        identity.set(
            .init(
                verifiedClerkSubject: "user_native_intake_adoption_b",
                persistedAppAttestKeyID: nil
            )
        )
        guard case .snapshot(let returnedB)? = await iterator.next() else {
            return XCTFail("The principal change must publish B before picker completion.")
        }
        suspended.resume()
        let staleAdded = await stalePicker.value
        XCTAssertEqual(staleAdded, 0)
        await waitUntil { capture.intakeSnapshot?.version == returnedB.version }
        XCTAssertEqual(
            capture.stagedPhotos,
            populatedB.photos,
            "A stale picker completion cannot publish into principal B."
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
