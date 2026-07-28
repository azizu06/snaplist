import Foundation
import XCTest
@testable import SnapList

@MainActor
final class VoiceNoteTests: XCTestCase {
    func testFifteenSecondBoundaryWaitsForExplicitSaveBeforeCommitting() async throws {
        let audio = VoiceNoteAudioClientStub(permission: .allowed)
        let files = VoiceNoteFileStoreStub()
        let store = VoiceNoteStore(audio: audio, files: files)

        await store.startRecording()
        audio.recordingSnapshot = VoiceNoteRecordingSnapshot(
            elapsed: 14.9,
            averagePower: -24
        )
        store.refreshRecording()

        XCTAssertEqual(
            store.phase,
            .recording(elapsed: 14.9, level: 0.6)
        )
        XCTAssertNil(store.savedNote)
        XCTAssertEqual(files.committedURLs, [])

        audio.recordingSnapshot = VoiceNoteRecordingSnapshot(
            elapsed: 15,
            averagePower: -12
        )
        store.refreshRecording()

        XCTAssertEqual(store.phase, .takeReady(duration: 15))
        XCTAssertNil(store.savedNote)
        XCTAssertEqual(files.committedURLs, [])

        store.save()

        XCTAssertEqual(store.savedNote?.duration, 15)
        XCTAssertEqual(files.committedURLs, [audio.provisionalURL])
        XCTAssertEqual(store.phase, .saved(isPlaying: false))
    }

    func testRerecordCancelInterruptionAndSaveFailurePreservePriorNote() async {
        let prior = VoiceNoteAsset(
            url: URL(fileURLWithPath: "/tmp/original.wav"),
            duration: 8
        )
        let audio = VoiceNoteAudioClientStub(permission: .allowed)
        let files = VoiceNoteFileStoreStub()
        let store = VoiceNoteStore(
            savedNote: prior,
            audio: audio,
            files: files
        )

        await store.rerecord()
        store.cancelRecording()

        XCTAssertEqual(store.savedNote, prior)
        XCTAssertEqual(store.phase, .saved(isPlaying: false))
        XCTAssertEqual(files.discardedURLs, [audio.provisionalURL])

        await store.rerecord()
        store.handleInterruption()

        XCTAssertEqual(store.savedNote, prior)
        XCTAssertEqual(store.phase, .saved(isPlaying: false))
        XCTAssertEqual(
            files.discardedURLs,
            [audio.provisionalURL, audio.provisionalURL]
        )

        files.commitError = .writeFailed
        await store.rerecord()
        audio.recordingSnapshot = VoiceNoteRecordingSnapshot(
            elapsed: 4,
            averagePower: -20
        )
        store.save()

        XCTAssertEqual(store.savedNote, prior)
        XCTAssertEqual(store.phase, .saveFailed)

        store.dismiss()
        XCTAssertEqual(store.consumeFocusRequest(), .voiceNoteOpener)
        XCTAssertNil(store.consumeFocusRequest())
    }

    func testSavedReplacementUsesDiscretePlaybackAndDeleteRemovesOnlyVoiceAsset() async throws {
        let prior = VoiceNoteAsset(
            url: URL(fileURLWithPath: "/tmp/original.wav"),
            duration: 8
        )
        let audio = VoiceNoteAudioClientStub(permission: .allowed)
        let files = VoiceNoteFileStoreStub()
        let store = VoiceNoteStore(
            savedNote: prior,
            audio: audio,
            files: files
        )

        await store.rerecord()
        audio.recordingSnapshot = VoiceNoteRecordingSnapshot(
            elapsed: 3,
            averagePower: -18
        )
        store.save()
        let replacement = try XCTUnwrap(store.savedNote)

        XCTAssertEqual(files.replacedNotes, [prior])
        XCTAssertEqual(files.authoritativeAssets, [replacement])

        store.togglePlayback()
        XCTAssertEqual(store.phase, .saved(isPlaying: true))
        XCTAssertEqual(audio.playedURLs, [replacement.url])

        store.togglePlayback()
        XCTAssertEqual(store.phase, .saved(isPlaying: false))
        XCTAssertEqual(audio.pauseCount, 1)

        store.deleteSavedNote()
        XCTAssertNil(store.savedNote)
        XCTAssertEqual(store.phase, .ready)
        XCTAssertEqual(files.deletedAssets, [replacement])
    }

    func testDeniedPermissionAndInactiveOrRouteChangesNeverReplacePriorNote() async {
        let prior = VoiceNoteAsset(
            url: URL(fileURLWithPath: "/tmp/original.wav"),
            duration: 8
        )
        let deniedAudio = VoiceNoteAudioClientStub(permission: .denied)
        let deniedStore = VoiceNoteStore(
            savedNote: prior,
            audio: deniedAudio,
            files: VoiceNoteFileStoreStub()
        )

        await deniedStore.rerecord()

        XCTAssertEqual(deniedStore.phase, .accessOff)
        XCTAssertEqual(deniedStore.savedNote, prior)

        let audio = VoiceNoteAudioClientStub(permission: .allowed)
        let files = VoiceNoteFileStoreStub()
        let store = VoiceNoteStore(
            savedNote: prior,
            audio: audio,
            files: files
        )

        await store.rerecord()
        store.handleSceneInactive()
        XCTAssertEqual(store.phase, .saved(isPlaying: false))
        XCTAssertEqual(store.savedNote, prior)

        await store.rerecord()
        store.handleRouteChange()
        XCTAssertEqual(store.phase, .saved(isPlaying: false))
        XCTAssertEqual(store.savedNote, prior)
        XCTAssertEqual(
            files.discardedURLs,
            [audio.provisionalURL, audio.provisionalURL]
        )
    }

    func testFrozenV21CopyGeometryAndAccessibilityTruth() {
        XCTAssertEqual(VoiceNotePresentation.sheetHeight, 220)
        XCTAssertEqual(VoiceNotePresentation.minimumTarget, 44)
        XCTAssertEqual(
            VoiceNotePresentation.emptyRowHelper,
            "Add details the photos might miss"
        )
        XCTAssertEqual(
            VoiceNotePresentation.sheetContext,
            "Add details the photos might miss."
        )
        XCTAssertEqual(
            VoiceNotePresentation.emptyRowAccessibilityLabel,
            "Voice note, optional, collapsed"
        )
        XCTAssertEqual(
            VoiceNotePresentation.recordingAccessibilityLabel(elapsed: 7.8),
            "Recording, 7 seconds of 15"
        )
        XCTAssertEqual(
            VoiceNotePresentation.playbackAccessibilityLabel(isPlaying: false),
            "Play voice note"
        )
        XCTAssertEqual(
            VoiceNotePresentation.playbackAccessibilityLabel(isPlaying: true),
            "Pause voice note"
        )
        XCTAssertTrue(VoiceNotePresentation.savedWaveformIsAccessibilityHidden)
        XCTAssertFalse(VoiceNotePresentation.savedWaveformIsInteractive)
    }

    func testLocalWAVStoreKeepsOneProtectedBackupExcludedAssetWithinLimits() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(
            "snaplist-voice-note-\(UUID().uuidString)",
            isDirectory: true
        )
        defer { try? FileManager.default.removeItem(at: root) }
        let files = VoiceNoteLocalFileStore(rootDirectory: root)

        let firstURL = try files.makeProvisionalURL()
        try Data(repeating: 1, count: 128).write(to: firstURL)
        let first = try files.commit(
            provisionalURL: firstURL,
            duration: 3,
            replacing: nil
        )

        XCTAssertTrue(FileManager.default.fileExists(atPath: first.url.path))
        XCTAssertTrue(
            try first.url.resourceValues(
                forKeys: [.isExcludedFromBackupKey]
            ).isExcludedFromBackup == true
        )

        let replacementURL = try files.makeProvisionalURL()
        try Data(repeating: 2, count: 256).write(to: replacementURL)
        let replacement = try files.commit(
            provisionalURL: replacementURL,
            duration: 4,
            replacing: first
        )

        XCTAssertEqual(replacement.duration, 4)
        XCTAssertEqual(
            try FileManager.default.contentsOfDirectory(
                at: root,
                includingPropertiesForKeys: nil
            ).filter { $0.pathExtension == "wav" },
            [replacement.url]
        )

        let oversizedURL = try files.makeProvisionalURL()
        try Data(repeating: 3, count: 524_288).write(to: oversizedURL)
        XCTAssertThrowsError(
            try files.commit(
                provisionalURL: oversizedURL,
                duration: 1,
                replacing: replacement
            )
        )
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: replacement.url.path),
            "A rejected replacement must leave the prior WAV authoritative."
        )
    }
}

@MainActor
private final class VoiceNoteAudioClientStub: VoiceNoteAudioClient {
    var permission: VoiceNoteMicrophonePermission
    var recordingSnapshot = VoiceNoteRecordingSnapshot(
        elapsed: 0,
        averagePower: -160
    )
    let provisionalURL = URL(fileURLWithPath: "/tmp/provisional.wav")
    var playedURLs: [URL] = []
    var pauseCount = 0
    var interruptionHandler: (() -> Void)?
    var routeChangeHandler: (() -> Void)?
    var playbackFinishedHandler: (() -> Void)?

    init(permission: VoiceNoteMicrophonePermission) {
        self.permission = permission
    }

    func requestPermission() async -> VoiceNoteMicrophonePermission {
        permission
    }

    func startRecording(to _: URL) throws {}
    func stopRecording() {}
    func startPlaying(_ url: URL) throws {
        playedURLs.append(url)
    }
    func pausePlaying() {
        pauseCount += 1
    }
    func stopPlaying() {}
}

private final class VoiceNoteFileStoreStub: VoiceNoteFileStoring {
    enum StubError: Error {
        case writeFailed
    }

    var committedURLs: [URL] = []
    var discardedURLs: [URL] = []
    var commitError: StubError?
    var replacedNotes: [VoiceNoteAsset] = []
    var authoritativeAssets: [VoiceNoteAsset] = []
    var deletedAssets: [VoiceNoteAsset] = []

    func makeProvisionalURL() throws -> URL {
        URL(fileURLWithPath: "/tmp/provisional.wav")
    }

    func commit(
        provisionalURL: URL,
        duration: TimeInterval,
        replacing priorNote: VoiceNoteAsset?
    ) throws -> VoiceNoteAsset {
        if let commitError {
            throw commitError
        }
        committedURLs.append(provisionalURL)
        if let priorNote {
            replacedNotes.append(priorNote)
        }
        let asset = VoiceNoteAsset(url: provisionalURL, duration: duration)
        authoritativeAssets = [asset]
        return asset
    }

    func discardProvisional(at url: URL) {
        discardedURLs.append(url)
    }
    func delete(_ note: VoiceNoteAsset) {
        deletedAssets.append(note)
        authoritativeAssets = []
    }
}
