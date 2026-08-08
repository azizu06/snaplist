import AVFoundation
import Foundation
import XCTest
@testable import SnapList

@MainActor
final class VoiceNoteTests: XCTestCase {
    func testRecorderCompletionEventTransitionsAtHardLimitWithoutPostStopPolling() async {
        let audio = VoiceNoteAudioClientStub(permission: .allowed)
        let files = VoiceNoteFileStoreStub()
        let store = VoiceNoteStore(audio: audio, files: files)

        await store.startRecording()
        audio.recordingSnapshot = VoiceNoteRecordingSnapshot(
            elapsed: 14.9,
            averagePower: -24
        )
        store.refreshRecording()

        audio.recordingSnapshot = VoiceNoteRecordingSnapshot(
            elapsed: 0,
            averagePower: -160
        )
        audio.finishRecordingAtTimeLimit()

        XCTAssertEqual(store.phase, .takeReady(duration: 15))
        XCTAssertNil(store.savedNote)
        XCTAssertEqual(files.committedURLs, [])
    }

    func testAVFoundationDelegateRoutesSuccessfulTimeLimitCompletion() async throws {
        let session = VoiceNoteAudioSessionStub()
        let recorderStub = VoiceNoteRecorderStub()
        let adapter = AVFoundationVoiceNoteAudioClient(
            audioSession: session,
            recorderFactory: { _, _ in recorderStub }
        )
        let completion = expectation(description: "time limit completion")
        adapter.recordingFinishedHandler = { event in
            XCTAssertEqual(event, .timeLimitReached)
            completion.fulfill()
        }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(
            "snaplist-recorder-delegate-\(UUID().uuidString).wav"
        )
        defer { try? FileManager.default.removeItem(at: url) }
        let recorder = try AVAudioRecorder(
            url: url,
            settings: [
                AVFormatIDKey: kAudioFormatLinearPCM,
                AVSampleRateKey: 16_000,
                AVNumberOfChannelsKey: 1,
                AVLinearPCMBitDepthKey: 16
            ]
        )

        try adapter.startRecording(to: url)
        XCTAssertTrue(recorderStub.delegate === adapter)
        adapter.audioRecorderDidFinishRecording(
            recorder,
            successfully: true
        )

        await fulfillment(of: [completion], timeout: 1)
    }

    func testAVFoundationPlaybackResumesRetainedPlayerUntilNaturalCompletion() async throws {
        let session = VoiceNoteAudioSessionStub()
        let firstPlayer = VoiceNotePlayerStub()
        let replayPlayer = VoiceNotePlayerStub()
        var availablePlayers = [firstPlayer, replayPlayer]
        var requestedURLs: [URL] = []
        let adapter = AVFoundationVoiceNoteAudioClient(
            audioSession: session,
            playerFactory: { url in
                requestedURLs.append(url)
                return availablePlayers.removeFirst()
            }
        )
        let url = URL(fileURLWithPath: "/tmp/saved.wav")

        try adapter.startPlaying(url)
        adapter.pausePlaying()
        try adapter.startPlaying(url)

        XCTAssertEqual(requestedURLs, [url])
        XCTAssertEqual(firstPlayer.playCount, 2)
        XCTAssertEqual(firstPlayer.pauseCount, 1)

        let completion = expectation(description: "natural playback completion")
        adapter.playbackFinishedHandler = {
            completion.fulfill()
        }
        adapter.audioPlayerDidFinishPlaying(
            AVAudioPlayer(),
            successfully: true
        )
        await fulfillment(of: [completion], timeout: 1)

        try adapter.startPlaying(url)

        XCTAssertEqual(requestedURLs, [url, url])
        XCTAssertEqual(replayPlayer.playCount, 1)
    }

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
        let fixture = makePriorNoteFixture()
        let prior = fixture.prior
        let audio = fixture.audio
        let files = fixture.files
        let store = fixture.store

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

        XCTAssertTrue(store.dismiss())
        XCTAssertEqual(store.savedNote, prior)
        XCTAssertEqual(store.phase, .saved(isPlaying: false))
        XCTAssertTrue(store.dismiss())
        XCTAssertEqual(files.discardedURLs.count, 3)
        XCTAssertEqual(store.consumeFocusRequest(), .voiceNoteOpener)
        XCTAssertNil(store.consumeFocusRequest())
    }

    func testCleanupFailuresRetainStateUntilCancelAndDeleteRetrySucceed() async {
        let fixture = makePriorNoteFixture()
        let prior = fixture.prior
        let audio = fixture.audio
        let files = fixture.files
        let store = fixture.store

        await store.rerecord()
        audio.recordingSnapshot = VoiceNoteRecordingSnapshot(
            elapsed: 4,
            averagePower: -20
        )
        store.refreshRecording()
        files.discardError = .removalFailed

        XCTAssertFalse(store.cancelRecording())
        XCTAssertEqual(store.savedNote, prior)
        XCTAssertEqual(store.phase, .saved(isPlaying: false))
        XCTAssertEqual(files.discardedURLs, [])
        XCTAssertEqual(files.discardAttempts, [audio.provisionalURL])

        files.discardError = nil
        XCTAssertTrue(store.cancelRecording())
        XCTAssertEqual(store.savedNote, prior)
        XCTAssertEqual(store.phase, .saved(isPlaying: false))
        XCTAssertEqual(files.discardedURLs, [audio.provisionalURL])
        XCTAssertEqual(
            files.discardAttempts,
            [audio.provisionalURL, audio.provisionalURL]
        )

        await store.rerecord()
        audio.recordingSnapshot = VoiceNoteRecordingSnapshot(
            elapsed: 2,
            averagePower: -20
        )
        files.commitError = .writeFailed
        store.save()
        files.discardError = .removalFailed

        XCTAssertFalse(store.dismiss())
        XCTAssertEqual(store.savedNote, prior)
        XCTAssertEqual(store.phase, .saved(isPlaying: false))

        files.discardError = nil
        XCTAssertTrue(store.dismiss())
        XCTAssertEqual(store.savedNote, prior)
        XCTAssertEqual(store.phase, .saved(isPlaying: false))

        files.deleteError = .removalFailed
        let firstDelete = await store.deleteSavedNote()
        XCTAssertFalse(firstDelete)
        XCTAssertEqual(store.savedNote, prior)
        XCTAssertEqual(store.phase, .saved(isPlaying: false))
        XCTAssertEqual(files.deletedAssets, [])

        files.deleteError = nil
        let secondDelete = await store.deleteSavedNote()
        XCTAssertTrue(secondDelete)
        XCTAssertNil(store.savedNote)
        XCTAssertEqual(store.phase, .ready)
        XCTAssertEqual(files.deletedAssets, [prior])
    }

    func testCanceledAndInterruptedCleanupDebtNeverBecomesSaveable() async {
        let emptyAudio = VoiceNoteAudioClientStub(permission: .allowed)
        let emptyFiles = VoiceNoteFileStoreStub()
        let emptyStore = VoiceNoteStore(
            audio: emptyAudio,
            files: emptyFiles
        )
        await emptyStore.startRecording()
        emptyAudio.recordingSnapshot = VoiceNoteRecordingSnapshot(
            elapsed: 4,
            averagePower: -20
        )
        emptyFiles.discardError = .removalFailed

        XCTAssertFalse(emptyStore.cancelRecording())
        XCTAssertEqual(emptyStore.phase, .ready)
        XCTAssertNil(emptyStore.savedNote)
        XCTAssertEqual(
            emptyFiles.discardAttempts,
            [emptyAudio.provisionalURL]
        )

        emptyFiles.discardError = nil
        XCTAssertTrue(emptyStore.dismiss())
        XCTAssertEqual(emptyStore.phase, .ready)
        XCTAssertEqual(
            emptyFiles.discardAttempts,
            [emptyAudio.provisionalURL, emptyAudio.provisionalURL]
        )
        XCTAssertEqual(
            emptyFiles.discardedURLs,
            [emptyAudio.provisionalURL]
        )
        XCTAssertTrue(emptyStore.dismiss())
        XCTAssertEqual(emptyFiles.discardAttempts.count, 2)

        let priorFixture = makePriorNoteFixture()
        await priorFixture.store.rerecord()
        priorFixture.audio.recordingSnapshot = VoiceNoteRecordingSnapshot(
            elapsed: 3,
            averagePower: -20
        )
        priorFixture.files.discardError = .removalFailed

        priorFixture.store.handleInterruption()

        XCTAssertEqual(priorFixture.store.savedNote, priorFixture.prior)
        XCTAssertEqual(
            priorFixture.store.phase,
            .saved(isPlaying: false)
        )
        XCTAssertEqual(
            priorFixture.files.discardAttempts,
            [priorFixture.audio.provisionalURL]
        )

        priorFixture.files.discardError = nil
        XCTAssertTrue(priorFixture.store.dismiss())
        XCTAssertEqual(priorFixture.store.savedNote, priorFixture.prior)
        XCTAssertEqual(
            priorFixture.store.phase,
            .saved(isPlaying: false)
        )
        XCTAssertEqual(
            priorFixture.files.discardAttempts,
            [
                priorFixture.audio.provisionalURL,
                priorFixture.audio.provisionalURL
            ]
        )
        XCTAssertTrue(priorFixture.store.dismiss())
        XCTAssertEqual(priorFixture.files.discardAttempts.count, 2)
    }

    func testCloseStopsPlaybackAndRestoresStableSavedTruth() {
        let fixture = makePriorNoteFixture()
        fixture.store.togglePlayback()
        XCTAssertEqual(fixture.store.phase, .saved(isPlaying: true))

        XCTAssertTrue(fixture.store.dismiss())

        XCTAssertEqual(
            fixture.store.phase,
            .saved(isPlaying: false)
        )
        XCTAssertEqual(fixture.store.savedNote, fixture.prior)
        XCTAssertEqual(fixture.audio.stopPlayingCount, 1)
    }

    func testPlaybackInterruptionStopsPlayerAndRestoresSavedTruth() {
        let fixture = makePriorNoteFixture()
        fixture.store.togglePlayback()
        XCTAssertEqual(fixture.store.phase, .saved(isPlaying: true))

        fixture.audio.interruptionHandler?()

        XCTAssertEqual(fixture.store.phase, .saved(isPlaying: false))
        XCTAssertEqual(fixture.store.savedNote, fixture.prior)
        XCTAssertEqual(fixture.audio.playedURLs, [fixture.prior.url])
        XCTAssertEqual(fixture.audio.stopPlayingCount, 1)
    }

    func testSavedReplacementUsesDiscretePlaybackAndDeleteRemovesOnlyVoiceAsset() async throws {
        let fixture = makePriorNoteFixture()
        let prior = fixture.prior
        let audio = fixture.audio
        let files = fixture.files
        let store = fixture.store

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

        await store.deleteSavedNote()
        XCTAssertNil(store.savedNote)
        XCTAssertEqual(store.phase, .ready)
        XCTAssertEqual(files.deletedAssets, [replacement])
    }

    func testDeniedPermissionAndInactiveOrRouteChangesNeverReplacePriorNote() async {
        let deniedFixture = makePriorNoteFixture(permission: .denied)
        let prior = deniedFixture.prior
        let deniedStore = deniedFixture.store

        await deniedStore.rerecord()

        XCTAssertEqual(
            deniedStore.phase,
            .accessOff(permission: .denied)
        )
        XCTAssertEqual(deniedStore.savedNote, prior)

        let fixture = makePriorNoteFixture()
        let audio = fixture.audio
        let files = fixture.files
        let store = fixture.store

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

    func testRestrictedPermissionHasNoSettingsRecoveryWhileDeniedDoes() async {
        let restricted = VoiceNoteAudioClientStub(permission: .restricted)
        let restrictedStore = VoiceNoteStore(
            audio: restricted,
            files: VoiceNoteFileStoreStub()
        )

        await restrictedStore.startRecording()

        XCTAssertEqual(
            restrictedStore.phase,
            .accessOff(permission: .restricted)
        )
        XCTAssertFalse(restricted.permission.canOpenSettings)

        let denied = VoiceNoteAudioClientStub(permission: .denied)
        let deniedStore = VoiceNoteStore(
            audio: denied,
            files: VoiceNoteFileStoreStub()
        )

        await deniedStore.startRecording()

        XCTAssertEqual(
            deniedStore.phase,
            .accessOff(permission: .denied)
        )
        XCTAssertTrue(denied.permission.canOpenSettings)
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
            VoiceNotePresentation.recordingAccessibilityLabel(elapsed: 7.8),
            "Recording, 7 seconds of 15"
        )
        XCTAssertEqual(
            VoiceNotePresentation.recordingAccessibilityOrder,
            [.cancel, .elapsed, .save]
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

    private func makePriorNoteFixture(
        permission: VoiceNoteMicrophonePermission = .allowed
    ) -> PriorNoteFixture {
        let prior = VoiceNoteAsset(
            url: URL(fileURLWithPath: "/tmp/original.wav"),
            duration: 8
        )
        let audio = VoiceNoteAudioClientStub(permission: permission)
        let files = VoiceNoteFileStoreStub()
        return PriorNoteFixture(
            prior: prior,
            audio: audio,
            files: files,
            store: VoiceNoteStore(
                savedNote: prior,
                audio: audio,
                files: files
            )
        )
    }
}

@MainActor
private struct PriorNoteFixture {
    let prior: VoiceNoteAsset
    let audio: VoiceNoteAudioClientStub
    let files: VoiceNoteFileStoreStub
    let store: VoiceNoteStore
}

@MainActor
private final class VoiceNoteAudioSessionStub:
    VoiceNoteAudioSessionControlling
{
    func setCategory(
        _: AVAudioSession.Category,
        mode _: AVAudioSession.Mode,
        options _: AVAudioSession.CategoryOptions
    ) throws {}

    func setActive(
        _: Bool,
        options _: AVAudioSession.SetActiveOptions
    ) throws {}
}

@MainActor
private final class VoiceNoteRecorderStub: VoiceNoteRecording {
    weak var delegate: AVAudioRecorderDelegate?
    var isMeteringEnabled = false
    var currentTime: TimeInterval = 0

    func prepareToRecord() -> Bool {
        true
    }

    func record(forDuration _: TimeInterval) -> Bool {
        true
    }

    func stop() {}
    func updateMeters() {}

    func averagePower(forChannel _: Int) -> Float {
        -160
    }
}

@MainActor
private final class VoiceNotePlayerStub: VoiceNotePlaying {
    weak var delegate: AVAudioPlayerDelegate?
    private(set) var playCount = 0
    private(set) var pauseCount = 0

    func prepareToPlay() -> Bool {
        true
    }

    func play() -> Bool {
        playCount += 1
        return true
    }

    func pause() {
        pauseCount += 1
    }

    func stop() {}
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
    var stopPlayingCount = 0
    var interruptionHandler: (() -> Void)?
    var routeChangeHandler: (() -> Void)?
    var playbackFinishedHandler: (() -> Void)?
    var recordingFinishedHandler: ((VoiceNoteRecordingCompletion) -> Void)?

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
    func stopPlaying() {
        stopPlayingCount += 1
    }

    func finishRecordingAtTimeLimit() {
        recordingFinishedHandler?(.timeLimitReached)
    }
}

private final class VoiceNoteFileStoreStub: VoiceNoteFileStoring {
    enum StubError: Error {
        case writeFailed
        case removalFailed
    }

    var committedURLs: [URL] = []
    var discardedURLs: [URL] = []
    var discardAttempts: [URL] = []
    var commitError: StubError?
    var discardError: StubError?
    var deleteError: StubError?
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

    func discardProvisional(at url: URL) throws {
        discardAttempts.append(url)
        if let discardError {
            throw discardError
        }
        discardedURLs.append(url)
    }
    func delete(_ note: VoiceNoteAsset) throws {
        if let deleteError {
            throw deleteError
        }
        deletedAssets.append(note)
        authoritativeAssets = []
    }
}
