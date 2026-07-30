import Foundation
import Observation

struct VoiceNoteAsset: Equatable, Sendable {
    let url: URL
    let duration: TimeInterval
}

enum VoiceNoteMicrophonePermission: Equatable {
    case undetermined
    case allowed
    case denied
    case restricted

    var canOpenSettings: Bool {
        self == .denied
    }
}

struct VoiceNoteRecordingSnapshot: Equatable {
    let elapsed: TimeInterval
    let averagePower: Float
}

enum VoiceNoteRecordingCompletion: Equatable {
    case timeLimitReached
    case failed
}

enum VoiceNotePhase: Equatable {
    case ready
    case recording(elapsed: TimeInterval, level: Double)
    case takeReady(duration: TimeInterval)
    case saved(isPlaying: Bool)
    case accessOff(permission: VoiceNoteMicrophonePermission)
    case interrupted
    case saveFailed
}

enum VoiceNoteFocusRequest: Equatable {
    case voiceNoteOpener
    case savedNoteSummary
}

enum VoiceNoteRecordingAccessibilityElement: Equatable {
    case cancel
    case elapsed
    case save

    var sortPriority: Double {
        switch self {
        case .cancel:
            return 3
        case .elapsed:
            return 2
        case .save:
            return 1
        }
    }
}

enum VoiceNotePresentation {
    static let maximumDuration: TimeInterval = 15
    static let sheetHeight: CGFloat = 220
    static let minimumTarget: CGFloat = 44
    // Compact card sheets render through a width transform (386 / 402 on
    // iPhone 17 Pro). 46 is the smallest whole-point layout target whose
    // public accessibility frame remains at least 44 points.
    static let compactSheetControlLayoutTarget: CGFloat = 46
    static let emptyRowHelper = "Add details the photos might miss"
    static let sheetContext = "Add details the photos might miss."
    static let emptyRowAccessibilityLabel =
        "Voice note, optional, collapsed"
    static let recordingAccessibilityOrder:
        [VoiceNoteRecordingAccessibilityElement] = [
            .cancel,
            .elapsed,
            .save
        ]
    static let savedWaveformIsAccessibilityHidden = true
    static let savedWaveformIsInteractive = false

    static func elapsedText(_ elapsed: TimeInterval) -> String {
        "0:\(String(format: "%02d", Int(max(elapsed, 0))))"
    }

    static func recordingAccessibilityLabel(
        elapsed: TimeInterval
    ) -> String {
        "Recording, \(Int(max(elapsed, 0))) seconds of 15"
    }

    static func playbackAccessibilityLabel(isPlaying: Bool) -> String {
        isPlaying ? "Pause voice note" : "Play voice note"
    }
}

@MainActor
protocol VoiceNoteAudioClient: AnyObject {
    var permission: VoiceNoteMicrophonePermission { get }
    var recordingSnapshot: VoiceNoteRecordingSnapshot { get }
    var interruptionHandler: (() -> Void)? { get set }
    var routeChangeHandler: (() -> Void)? { get set }
    var playbackFinishedHandler: (() -> Void)? { get set }
    var recordingFinishedHandler: ((VoiceNoteRecordingCompletion) -> Void)? {
        get set
    }

    func requestPermission() async -> VoiceNoteMicrophonePermission
    func startRecording(to url: URL) throws
    func stopRecording()
    func startPlaying(_ url: URL) throws
    func pausePlaying()
    func stopPlaying()
}

protocol VoiceNoteFileStoring: AnyObject {
    func makeProvisionalURL() throws -> URL
    func commit(
        provisionalURL: URL,
        duration: TimeInterval,
        replacing priorNote: VoiceNoteAsset?
    ) throws -> VoiceNoteAsset
    func discardProvisional(at url: URL) throws
    func delete(_ note: VoiceNoteAsset) throws
}

enum VoiceNoteFileStoreError: Error {
    case invalidDuration
    case invalidFile
    case fileTooLarge
}

@MainActor
struct VoiceNoteCommitAuthority {
    let save:
        (
            URL,
            TimeInterval,
            @escaping @MainActor @Sendable () -> Bool
        ) async -> VoiceNoteAsset?
    let delete:
        (
            @escaping @MainActor @Sendable () -> Bool
        ) async -> Bool
}

final class VoiceNoteLocalFileStore: VoiceNoteFileStoring {
    static let maximumBytes = 524_288
    static let recoveryCeiling: TimeInterval = 24 * 60 * 60

    private let fileManager: FileManager
    private let rootDirectory: URL

    init(
        rootDirectory: URL = VoiceNoteLocalFileStore.defaultRootDirectory(),
        fileManager: FileManager = .default
    ) {
        self.rootDirectory = rootDirectory
        self.fileManager = fileManager
        removeExpiredSiblingDirectories()
    }

    func makeProvisionalURL() throws -> URL {
        try prepareRootDirectory()
        return rootDirectory.appendingPathComponent(
            "take-\(UUID().uuidString).wav",
            isDirectory: false
        )
    }

    func commit(
        provisionalURL: URL,
        duration: TimeInterval,
        replacing _: VoiceNoteAsset?
    ) throws -> VoiceNoteAsset {
        guard
            duration > 0,
            duration <= VoiceNotePresentation.maximumDuration
        else {
            throw VoiceNoteFileStoreError.invalidDuration
        }
        let attributes = try fileManager.attributesOfItem(
            atPath: provisionalURL.path
        )
        guard let fileSize = attributes[.size] as? NSNumber else {
            throw VoiceNoteFileStoreError.invalidFile
        }
        guard fileSize.intValue > 0 else {
            throw VoiceNoteFileStoreError.invalidFile
        }
        guard fileSize.intValue < Self.maximumBytes else {
            throw VoiceNoteFileStoreError.fileTooLarge
        }

        try protectAndExcludeFromBackup(provisionalURL)
        let destination = rootDirectory.appendingPathComponent("voice-note.wav")
        if fileManager.fileExists(atPath: destination.path) {
            _ = try fileManager.replaceItemAt(
                destination,
                withItemAt: provisionalURL
            )
        } else {
            try fileManager.moveItem(at: provisionalURL, to: destination)
        }
        return VoiceNoteAsset(url: destination, duration: duration)
    }

    func discardProvisional(at url: URL) throws {
        guard fileManager.fileExists(atPath: url.path) else {
            return
        }
        try fileManager.removeItem(at: url)
    }

    func delete(_ note: VoiceNoteAsset) throws {
        guard fileManager.fileExists(atPath: note.url.path) else {
            return
        }
        try fileManager.removeItem(at: note.url)
    }

    private func prepareRootDirectory() throws {
        try fileManager.createDirectory(
            at: rootDirectory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.complete]
        )
        try protectAndExcludeFromBackup(rootDirectory)
    }

    private func protectAndExcludeFromBackup(_ url: URL) throws {
        try fileManager.setAttributes(
            [.protectionKey: FileProtectionType.complete],
            ofItemAtPath: url.path
        )
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var protectedURL = url
        try protectedURL.setResourceValues(values)
    }

    private func removeExpiredSiblingDirectories() {
        let parent = rootDirectory.deletingLastPathComponent()
        guard let siblings = try? fileManager.contentsOfDirectory(
            at: parent,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ) else {
            return
        }
        let cutoff = Date().addingTimeInterval(-Self.recoveryCeiling)
        for sibling in siblings where sibling != rootDirectory {
            guard
                let modified = try? sibling.resourceValues(
                    forKeys: [.contentModificationDateKey]
                ).contentModificationDate,
                modified < cutoff
            else {
                continue
            }
            try? fileManager.removeItem(at: sibling)
        }
    }

    private static func defaultRootDirectory() -> URL {
        let base = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? FileManager.default.temporaryDirectory
        return base
            .appendingPathComponent("VoiceNotes", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
    }
}

@MainActor
@Observable
final class VoiceNoteStore {
    nonisolated static let maximumDuration =
        VoiceNotePresentation.maximumDuration

    private(set) var phase: VoiceNotePhase
    private(set) var savedNote: VoiceNoteAsset?

    private let audio: VoiceNoteAudioClient
    private let files: VoiceNoteFileStoring
    private let authority: VoiceNoteCommitAuthority?
    private var provisionalURL: URL?
    private var provisionalDuration: TimeInterval?
    private var pendingFocusRequest: VoiceNoteFocusRequest?
    private var authorityMutationID: UUID?

    init(
        savedNote: VoiceNoteAsset? = nil,
        audio: VoiceNoteAudioClient,
        files: VoiceNoteFileStoring,
        authority: VoiceNoteCommitAuthority? = nil
    ) {
        self.savedNote = savedNote
        self.audio = audio
        self.files = files
        self.authority = authority
        phase = savedNote == nil ? .ready : .saved(isPlaying: false)
        audio.interruptionHandler = { [weak self] in
            self?.handleInterruption()
        }
        audio.routeChangeHandler = { [weak self] in
            self?.handleRouteChange()
        }
        audio.playbackFinishedHandler = { [weak self] in
            self?.handlePlaybackFinished()
        }
        audio.recordingFinishedHandler = { [weak self] completion in
            self?.handleRecordingFinished(completion)
        }
    }

    func startRecording() async {
        authorityMutationID = nil
        guard discardPendingProvisionalBeforeRecording() else {
            return
        }

        let permission: VoiceNoteMicrophonePermission
        switch audio.permission {
        case .allowed:
            permission = .allowed
        case .denied:
            permission = .denied
        case .restricted:
            permission = .restricted
        case .undetermined:
            permission = await audio.requestPermission()
        }

        guard permission == .allowed else {
            phase = .accessOff(permission: permission)
            return
        }

        do {
            let url = try files.makeProvisionalURL()
            provisionalURL = url
            provisionalDuration = nil
            do {
                try audio.startRecording(to: url)
            } catch {
                audio.stopRecording()
                if discardPendingProvisional() {
                    phase = savedNote == nil
                        ? .interrupted
                        : .saved(isPlaying: false)
                } else {
                    phase = authoritativePhase
                }
                return
            }
            phase = .recording(elapsed: 0, level: 0)
        } catch {
            phase = .interrupted
        }
    }

    func refreshRecording() {
        guard case .recording = phase else {
            return
        }

        let snapshot = audio.recordingSnapshot
        let elapsed = min(max(snapshot.elapsed, 0), Self.maximumDuration)
        if elapsed >= Self.maximumDuration {
            audio.stopRecording()
            provisionalDuration = Self.maximumDuration
            phase = .takeReady(duration: Self.maximumDuration)
            return
        }

        phase = .recording(
            elapsed: elapsed,
            level: Self.normalizedLevel(from: snapshot.averagePower)
        )
    }

    func handleRecordingFinished(_ completion: VoiceNoteRecordingCompletion) {
        guard case .recording = phase, provisionalURL != nil else {
            return
        }

        switch completion {
        case .timeLimitReached:
            provisionalDuration = Self.maximumDuration
            phase = .takeReady(duration: Self.maximumDuration)
        case .failed:
            handleInterruption()
        }
    }

    func save() {
        if case .recording = phase {
            let snapshot = audio.recordingSnapshot
            audio.stopRecording()
            provisionalDuration = min(
                max(snapshot.elapsed, 0),
                Self.maximumDuration
            )
        }

        guard
            let provisionalURL,
            let provisionalDuration,
            provisionalDuration > 0
        else {
            if self.provisionalURL != nil {
                prepareProvisionalForCleanup()
                if discardPendingProvisional() {
                    phase = savedNote == nil
                        ? .interrupted
                        : .saved(isPlaying: false)
                } else {
                    phase = authoritativePhase
                }
            }
            return
        }

        if let authority {
            let mutationID = UUID()
            authorityMutationID = mutationID
            Task {
                let committed = await authority.save(
                    provisionalURL,
                    provisionalDuration,
                    { [weak self] in
                        self?.authorityMutationID == mutationID
                    }
                )
                guard authorityMutationID == mutationID,
                      self.provisionalURL == provisionalURL else {
                    try? files.discardProvisional(at: provisionalURL)
                    return
                }
                authorityMutationID = nil
                if let committed {
                    self.savedNote = committed
                    self.provisionalURL = nil
                    self.provisionalDuration = nil
                    try? files.discardProvisional(at: provisionalURL)
                    phase = .saved(isPlaying: false)
                    pendingFocusRequest = .savedNoteSummary
                } else {
                    phase = .saveFailed
                }
            }
            return
        }

        do {
            let savedNote = try files.commit(
                provisionalURL: provisionalURL,
                duration: provisionalDuration,
                replacing: savedNote
            )
            self.savedNote = savedNote
            self.provisionalURL = nil
            self.provisionalDuration = nil
            phase = .saved(isPlaying: false)
            pendingFocusRequest = .savedNoteSummary
        } catch {
            phase = .saveFailed
        }
    }

    func rerecord() async {
        audio.stopPlaying()
        await startRecording()
    }

    @discardableResult
    func cancelRecording() -> Bool {
        guard provisionalURL != nil else {
            return true
        }
        authorityMutationID = nil
        prepareProvisionalForCleanup()
        phase = authoritativePhase
        if savedNote != nil {
            pendingFocusRequest = .savedNoteSummary
        }
        guard discardPendingProvisional() else {
            return false
        }
        phase = savedNote == nil
            ? .interrupted
            : .saved(isPlaying: false)
        return true
    }

    func handleInterruption() {
        if phase == .saved(isPlaying: true) {
            audio.stopPlaying()
            phase = .saved(isPlaying: false)
            return
        }
        cancelRecording()
    }

    func handleSceneInactive() {
        guard case .recording = phase else {
            return
        }
        handleInterruption()
    }

    func handleRouteChange() {
        guard case .recording = phase else {
            return
        }
        handleInterruption()
    }

    func refreshPermissionTruth() {
        guard
            case .accessOff = phase,
            audio.permission == .allowed
        else {
            return
        }
        phase = savedNote == nil ? .ready : .saved(isPlaying: false)
    }

    func togglePlayback() {
        guard let savedNote else {
            return
        }

        if phase == .saved(isPlaying: true) {
            audio.pausePlaying()
            phase = .saved(isPlaying: false)
            return
        }

        do {
            try audio.startPlaying(savedNote.url)
            phase = .saved(isPlaying: true)
        } catch {
            phase = .saved(isPlaying: false)
        }
    }

    func handlePlaybackFinished() {
        guard savedNote != nil else {
            return
        }
        phase = .saved(isPlaying: false)
    }

    @discardableResult
    func deleteSavedNote() async -> Bool {
        guard let savedNote else {
            return true
        }
        audio.stopPlaying()
        if let authority {
            let mutationID = UUID()
            authorityMutationID = mutationID
            let deleted = await authority.delete {
                [weak self] in
                self?.authorityMutationID == mutationID
            }
            guard authorityMutationID == mutationID else {
                return false
            }
            authorityMutationID = nil
            guard deleted else {
                phase = .saved(isPlaying: false)
                return false
            }
            if self.savedNote == savedNote || self.savedNote == nil {
                self.savedNote = nil
                phase = .ready
            } else {
                phase = .saved(isPlaying: false)
            }
            return true
        }
        do {
            try files.delete(savedNote)
            self.savedNote = nil
            phase = .ready
            return true
        } catch {
            phase = .saved(isPlaying: false)
            return false
        }
    }

    @discardableResult
    func dismiss() -> Bool {
        audio.stopPlaying()
        authorityMutationID = nil
        if provisionalURL != nil {
            prepareProvisionalForCleanup()
            phase = authoritativePhase
            guard discardPendingProvisional() else {
                return false
            }
        }
        phase = authoritativePhase
        pendingFocusRequest = .voiceNoteOpener
        return true
    }

    func consumeFocusRequest() -> VoiceNoteFocusRequest? {
        defer { pendingFocusRequest = nil }
        return pendingFocusRequest
    }

    func publishCommittedVoice(_ voice: NativeIntake.Voice?) {
        audio.stopPlaying()
        savedNote = voice.map {
            VoiceNoteAsset(url: $0.mediaURL, duration: $0.duration)
        }
        if case .recording = phase {
            return
        }
        if case .takeReady = phase {
            return
        }
        phase = savedNote == nil ? .ready : .saved(isPlaying: false)
    }

#if DEBUG
    func applyLaunchFixturePhase(_ phase: VoiceNotePhase) {
        self.phase = phase
    }
#endif

    private static func normalizedLevel(from averagePower: Float) -> Double {
        min(max(Double(averagePower + 60) / 60, 0), 1)
    }

    private func discardPendingProvisionalBeforeRecording() -> Bool {
        guard provisionalURL != nil else {
            return true
        }
        authorityMutationID = nil
        prepareProvisionalForCleanup()
        phase = authoritativePhase
        return discardPendingProvisional()
    }

    private func prepareProvisionalForCleanup() {
        audio.stopRecording()
    }

    private var authoritativePhase: VoiceNotePhase {
        savedNote == nil ? .ready : .saved(isPlaying: false)
    }

    private func discardPendingProvisional() -> Bool {
        guard let provisionalURL else {
            return true
        }
        do {
            try files.discardProvisional(at: provisionalURL)
        } catch {
            return false
        }
        self.provisionalURL = nil
        provisionalDuration = nil
        return true
    }
}
