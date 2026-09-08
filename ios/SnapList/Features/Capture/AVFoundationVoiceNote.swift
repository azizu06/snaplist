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
protocol VoiceNotePlaying: AnyObject {
    var delegate: AVAudioPlayerDelegate? { get set }
    var currentTime: TimeInterval { get set }
    var duration: TimeInterval { get }

    @discardableResult
    func prepareToPlay() -> Bool
    func play() -> Bool
    func pause()
    func stop()
}

extension AVAudioPlayer: VoiceNotePlaying {}

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
    private let playerFactory: (URL) throws -> VoiceNotePlaying
    private var recorder: VoiceNoteRecording?
    private var player: VoiceNotePlaying?
    private var interruptionObserver: NSObjectProtocol?
    private var routeChangeObserver: NSObjectProtocol?
    /// The engine that feeds the live meter. Nil means the input tap could not
    /// run, and the recorder's own meter drives the envelope instead.
    private var meterEngine: AVAudioEngine?
    private var envelope = VoiceMeterEnvelope()
    private var pendingMeterLevels: [Double] = []
    private var savedWaveformCacheKey: SavedWaveformCacheKey?
    private var savedWaveformCache: [Double] = []

    /// A poll that arrives late must not replay a long backlog of bars, so the
    /// trail keeps only about a second and a half of frames.
    private static let maximumPendingMeterLevels = 64
    private static let meterTapBufferSize: AVAudioFrameCount = 1024
    /// `AVAudioRecorder` metering is read once per poll, not once per window.
    private static let fallbackFrameDuration: TimeInterval = 0.1

    /// A saved note commits to a fixed file name, so the URL alone goes stale
    /// after a rerecord. Size and modification date make the key honest.
    private struct SavedWaveformCacheKey: Equatable {
        let url: URL
        let byteCount: Int
        let modifiedAt: Date?
        let barCount: Int
    }

    init(
        audioSession: VoiceNoteAudioSessionControlling =
            AVAudioSession.sharedInstance(),
        notificationCenter: NotificationCenter = .default,
        recorderFactory: @escaping
            (URL, [String: Any]) throws -> VoiceNoteRecording = {
                try AVAudioRecorder(url: $0, settings: $1)
            },
        playerFactory: @escaping
            (URL) throws -> VoiceNotePlaying = {
                try AVAudioPlayer(contentsOf: $0)
            }
    ) {
        self.audioSession = audioSession
        self.notificationCenter = notificationCenter
        self.recorderFactory = recorderFactory
        self.playerFactory = playerFactory
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

    func drainRecordingSnapshot() -> VoiceNoteRecordingSnapshot {
        guard let recorder else {
            pendingMeterLevels = []
            return VoiceNoteRecordingSnapshot(elapsed: 0)
        }
        if meterEngine == nil {
            // Without an input tap there is one reading per poll instead of one
            // per window. Folding it through the same envelope keeps the same
            // adaptive floor and attack/release, only at a coarser rate.
            recorder.updateMeters()
            let decibels = max(
                recorder.averagePower(forChannel: 0),
                VoiceWaveformAnalyzer.silenceDecibels
            )
            pendingMeterLevels.append(
                envelope.ingest(
                    VoiceWaveformFrame(
                        rootMeanSquare: pow(10, decibels / 20),
                        decibels: decibels,
                        brightness: envelope.tuning.brightnessPivot
                    ),
                    frameDuration: Self.fallbackFrameDuration
                )
            )
        }
        let meterLevels = pendingMeterLevels
        pendingMeterLevels = []
        return VoiceNoteRecordingSnapshot(
            elapsed: recorder.currentTime,
            meterLevels: meterLevels
        )
    }

    var playbackSnapshot: VoiceNotePlaybackSnapshot {
        guard let player else {
            return VoiceNotePlaybackSnapshot()
        }
        return VoiceNotePlaybackSnapshot(
            currentTime: player.currentTime,
            duration: player.duration
        )
    }

    func savedWaveform(for url: URL, barCount: Int) -> [Double] {
        let attributes = try? FileManager.default.attributesOfItem(
            atPath: url.path
        )
        let key = SavedWaveformCacheKey(
            url: url,
            byteCount: (attributes?[.size] as? NSNumber)?.intValue ?? -1,
            modifiedAt: attributes?[.modificationDate] as? Date,
            barCount: barCount
        )
        if key == savedWaveformCacheKey {
            return savedWaveformCache
        }
        let bars = Self.readBars(from: url, barCount: barCount)
        savedWaveformCacheKey = key
        savedWaveformCache = bars
        return bars
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
        // A new take will overwrite the saved note in place, and two takes that
        // both reach the 15 s cap write the same byte count, so the file's own
        // metadata cannot be the only thing that retires the cached shape.
        savedWaveformCacheKey = nil
        savedWaveformCache = []
        startMeterTap()
    }

    func stopRecording() {
        stopMeterTap()
        recorder?.delegate = nil
        recorder?.stop()
        recorder = nil
        deactivateSessionIfIdle()
    }

    /// Real amplitude for the live meter: RMS per input window at the engine's
    /// own rate, rather than one averaged power reading per poll.
    private func startMeterTap() {
        envelope.reset()
        pendingMeterLevels = []
        guard permission == .allowed, meterEngine == nil else {
            return
        }
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        let sampleRate = format.sampleRate
        guard sampleRate > 0, format.channelCount > 0 else {
            return
        }
        input.installTap(
            onBus: 0,
            bufferSize: Self.meterTapBufferSize,
            format: format
        ) { [weak self] buffer, _ in
            guard let samples = Self.monoSamples(from: buffer) else {
                return
            }
            let frame = VoiceWaveformAnalyzer.analyze(
                samples,
                sampleRate: sampleRate
            )
            let frameDuration = TimeInterval(samples.count) / sampleRate
            Task { @MainActor in
                self?.ingestMeterFrame(frame, frameDuration: frameDuration)
            }
        }
        do {
            try engine.start()
            meterEngine = engine
        } catch {
            input.removeTap(onBus: 0)
        }
    }

    private func stopMeterTap() {
        guard let meterEngine else {
            return
        }
        meterEngine.inputNode.removeTap(onBus: 0)
        meterEngine.stop()
        self.meterEngine = nil
    }

    private func ingestMeterFrame(
        _ frame: VoiceWaveformFrame,
        frameDuration: TimeInterval
    ) {
        guard recorder != nil else {
            return
        }
        pendingMeterLevels.append(
            envelope.ingest(frame, frameDuration: frameDuration)
        )
        let overflow = pendingMeterLevels.count
            - Self.maximumPendingMeterLevels
        if overflow > 0 {
            pendingMeterLevels.removeFirst(overflow)
        }
    }

    private nonisolated static func readBars(
        from url: URL,
        barCount: Int
    ) -> [Double] {
        guard
            let file = try? AVAudioFile(forReading: url),
            file.length > 0,
            let buffer = AVAudioPCMBuffer(
                pcmFormat: file.processingFormat,
                frameCapacity: AVAudioFrameCount(file.length)
            )
        else {
            return []
        }
        do {
            try file.read(into: buffer)
        } catch {
            return []
        }
        guard let samples = monoSamples(from: buffer) else {
            return []
        }
        return VoiceWaveformBucketing.bars(
            from: samples,
            barCount: barCount
        )
    }

    private nonisolated static func monoSamples(
        from buffer: AVAudioPCMBuffer
    ) -> [Float]? {
        let frameLength = Int(buffer.frameLength)
        guard
            frameLength > 0,
            let channels = buffer.floatChannelData
        else {
            return nil
        }
        let channelCount = Int(buffer.format.channelCount)
        guard channelCount > 1 else {
            return Array(
                UnsafeBufferPointer(start: channels[0], count: frameLength)
            )
        }
        var mixed = [Float](repeating: 0, count: frameLength)
        for channel in 0..<channelCount {
            let source = channels[channel]
            for index in 0..<frameLength {
                mixed[index] += source[index]
            }
        }
        let scale = 1 / Float(channelCount)
        for index in 0..<frameLength {
            mixed[index] *= scale
        }
        return mixed
    }

    func startPlaying(_ url: URL) throws {
        stopRecording()
        try audioSession.setCategory(
            .playback,
            mode: .default,
            options: []
        )
        try audioSession.setActive(true, options: [])
        let player: VoiceNotePlaying
        if let retainedPlayer = self.player {
            player = retainedPlayer
        } else {
            player = try playerFactory(url)
            player.delegate = self
            player.prepareToPlay()
        }
        guard player.play() else {
            player.stop()
            player.delegate = nil
            self.player = nil
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
