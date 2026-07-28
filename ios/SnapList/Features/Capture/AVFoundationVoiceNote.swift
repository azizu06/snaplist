import AVFoundation
import Foundation

enum AVFoundationVoiceNoteError: Error {
    case recordingCouldNotStart
    case playbackCouldNotStart
}

@MainActor
protocol VoiceNoteAudioSessionControlling: AnyObject {
    func setCategory(
        _ category: AVAudioSession.Category,
        mode: AVAudioSession.Mode,
        options: AVAudioSession.CategoryOptions
    ) throws
    func setActive(
        _ active: Bool,
        options: AVAudioSession.SetActiveOptions
    ) throws
}

extension AVAudioSession: VoiceNoteAudioSessionControlling {}

@MainActor
protocol VoiceNoteRecording: AnyObject {
    var delegate: AVAudioRecorderDelegate? { get set }
    var isMeteringEnabled: Bool { get set }
    var currentTime: TimeInterval { get }

    @discardableResult
    func prepareToRecord() -> Bool
    func record(forDuration duration: TimeInterval) -> Bool
    func stop()
    func updateMeters()
    func averagePower(forChannel channelNumber: Int) -> Float
}

extension AVAudioRecorder: VoiceNoteRecording {}

@MainActor
final class AVFoundationVoiceNoteAudioClient:
    NSObject,
    VoiceNoteAudioClient,
    AVAudioRecorderDelegate,
    AVAudioPlayerDelegate
{
    var interruptionHandler: (() -> Void)?
    var routeChangeHandler: (() -> Void)?
    var playbackFinishedHandler: (() -> Void)?
    var recordingFinishedHandler: ((VoiceNoteRecordingCompletion) -> Void)?

    private let audioSession: VoiceNoteAudioSessionControlling
    private let notificationCenter: NotificationCenter
    private let recorderFactory:
        (URL, [String: Any]) throws -> VoiceNoteRecording
    private var recorder: VoiceNoteRecording?
    private var player: AVAudioPlayer?
    private var interruptionObserver: NSObjectProtocol?
    private var routeChangeObserver: NSObjectProtocol?

    init(
        audioSession: VoiceNoteAudioSessionControlling =
            AVAudioSession.sharedInstance(),
        notificationCenter: NotificationCenter = .default,
        recorderFactory: @escaping
            (URL, [String: Any]) throws -> VoiceNoteRecording = {
                try AVAudioRecorder(url: $0, settings: $1)
            }
    ) {
        self.audioSession = audioSession
        self.notificationCenter = notificationCenter
        self.recorderFactory = recorderFactory
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
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            return .allowed
        case .denied:
            return .denied
        case .restricted:
            return .restricted
        case .notDetermined:
            return .undetermined
        @unknown default:
            return .restricted
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
        return granted ? .allowed : permission
    }

    func startRecording(to url: URL) throws {
        stopPlaying()
        try audioSession.setCategory(
            .record,
            mode: .default,
            options: []
        )
        try audioSession.setActive(true, options: [])

        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsFloatKey: false
        ]
        let recorder = try recorderFactory(url, settings)
        recorder.delegate = self
        recorder.isMeteringEnabled = true
        recorder.prepareToRecord()
        guard recorder.record(
            forDuration: VoiceNotePresentation.maximumDuration
        ) else {
            recorder.delegate = nil
            try? audioSession.setActive(
                false,
                options: .notifyOthersOnDeactivation
            )
            throw AVFoundationVoiceNoteError.recordingCouldNotStart
        }
        self.recorder = recorder
    }

    func stopRecording() {
        recorder?.delegate = nil
        recorder?.stop()
        recorder = nil
        deactivateSessionIfIdle()
    }

    func startPlaying(_ url: URL) throws {
        stopRecording()
        try audioSession.setCategory(
            .playback,
            mode: .default,
            options: []
        )
        try audioSession.setActive(true, options: [])
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

    nonisolated func audioRecorderDidFinishRecording(
        _: AVAudioRecorder,
        successfully flag: Bool
    ) {
        Task { @MainActor [weak self] in
            self?.recorder = nil
            self?.deactivateSessionIfIdle()
            self?.recordingFinishedHandler?(
                flag ? .timeLimitReached : .failed
            )
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
