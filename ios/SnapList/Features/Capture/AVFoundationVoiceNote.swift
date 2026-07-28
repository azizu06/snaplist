import AVFoundation
import Foundation

enum AVFoundationVoiceNoteError: Error {
    case recordingCouldNotStart
    case playbackCouldNotStart
}

@MainActor
final class AVFoundationVoiceNoteAudioClient:
    NSObject,
    VoiceNoteAudioClient,
    AVAudioPlayerDelegate
{
    var interruptionHandler: (() -> Void)?
    var routeChangeHandler: (() -> Void)?
    var playbackFinishedHandler: (() -> Void)?

    private let audioSession: AVAudioSession
    private let notificationCenter: NotificationCenter
    private var recorder: AVAudioRecorder?
    private var player: AVAudioPlayer?
    private var interruptionObserver: NSObjectProtocol?
    private var routeChangeObserver: NSObjectProtocol?

    init(
        audioSession: AVAudioSession = .sharedInstance(),
        notificationCenter: NotificationCenter = .default
    ) {
        self.audioSession = audioSession
        self.notificationCenter = notificationCenter
        super.init()
        interruptionObserver = notificationCenter.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: audioSession,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.interruptionHandler?()
            }
        }
        routeChangeObserver = notificationCenter.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: audioSession,
            queue: .main
        ) { [weak self] notification in
            if
                let rawReason = notification.userInfo?[
                    AVAudioSessionRouteChangeReasonKey
                ] as? UInt,
                AVAudioSession.RouteChangeReason(
                    rawValue: rawReason
                ) == .categoryChange
            {
                return
            }
            Task { @MainActor in
                self?.routeChangeHandler?()
            }
        }
    }

    deinit {
        if let interruptionObserver {
            notificationCenter.removeObserver(interruptionObserver)
        }
        if let routeChangeObserver {
            notificationCenter.removeObserver(routeChangeObserver)
        }
    }

    var permission: VoiceNoteMicrophonePermission {
        switch AVAudioApplication.shared.recordPermission {
        case .granted:
            return .allowed
        case .denied:
            return .denied
        case .undetermined:
            return .undetermined
        @unknown default:
            return .denied
        }
    }

    var recordingSnapshot: VoiceNoteRecordingSnapshot {
        guard let recorder else {
            return VoiceNoteRecordingSnapshot(
                elapsed: 0,
                averagePower: -160
            )
        }
        recorder.updateMeters()
        return VoiceNoteRecordingSnapshot(
            elapsed: recorder.currentTime,
            averagePower: recorder.averagePower(forChannel: 0)
        )
    }

    func requestPermission() async -> VoiceNoteMicrophonePermission {
        let granted = await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { granted in
                continuation.resume(returning: granted)
            }
        }
        return granted ? .allowed : .denied
    }

    func startRecording(to url: URL) throws {
        stopPlaying()
        try audioSession.setCategory(.record, mode: .default)
        try audioSession.setActive(true)

        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsFloatKey: false
        ]
        let recorder = try AVAudioRecorder(url: url, settings: settings)
        recorder.isMeteringEnabled = true
        recorder.prepareToRecord()
        guard recorder.record(
            forDuration: VoiceNotePresentation.maximumDuration
        ) else {
            try? audioSession.setActive(
                false,
                options: .notifyOthersOnDeactivation
            )
            throw AVFoundationVoiceNoteError.recordingCouldNotStart
        }
        self.recorder = recorder
    }

    func stopRecording() {
        recorder?.stop()
        recorder = nil
        deactivateSessionIfIdle()
    }

    func startPlaying(_ url: URL) throws {
        stopRecording()
        try audioSession.setCategory(.playback, mode: .default)
        try audioSession.setActive(true)
        let player = try AVAudioPlayer(contentsOf: url)
        player.delegate = self
        player.prepareToPlay()
        guard player.play() else {
            try? audioSession.setActive(
                false,
                options: .notifyOthersOnDeactivation
            )
            throw AVFoundationVoiceNoteError.playbackCouldNotStart
        }
        self.player = player
    }

    func pausePlaying() {
        player?.pause()
    }

    func stopPlaying() {
        player?.stop()
        player = nil
        deactivateSessionIfIdle()
    }

    nonisolated func audioPlayerDidFinishPlaying(
        _: AVAudioPlayer,
        successfully _: Bool
    ) {
        Task { @MainActor [weak self] in
            self?.player = nil
            self?.deactivateSessionIfIdle()
            self?.playbackFinishedHandler?()
        }
    }

    private func deactivateSessionIfIdle() {
        guard recorder == nil, player == nil else {
            return
        }
        try? audioSession.setActive(
            false,
            options: .notifyOthersOnDeactivation
        )
    }
}
