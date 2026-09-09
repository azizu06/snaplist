import SwiftUI
import UIKit

/// The one track both the recording countdown and the saved note's playback
/// row draw: a fixed bar count spanning the 15 s cap, so the two never
/// disagree about how many bars represent a full take.
enum VoiceNoteWaveformGeometry {
    static let trackBarCount = VoiceWaveformBarPolicy.barCount(
        duration: VoiceNotePresentation.maximumDuration
    )

    static var emptyLiveMeterSamples: [Double] {
        Array(repeating: 0, count: trackBarCount)
    }

    /// Writes the loudest level in `levels` into the bar slot `elapsed` has
    /// reached, leaving every other slot untouched. Slots ahead of `elapsed`
    /// stay at their initial `0`, which the view draws as the unrecorded
    /// remainder — the fill doubles as a countdown.
    static func updatingLiveMeterSamples(
        with levels: [Double],
        elapsed: TimeInterval,
        secondsPerBar: TimeInterval = VoiceWaveformBarPolicy.secondsPerBar,
        in samples: [Double]
    ) -> [Double] {
        guard !levels.isEmpty, !samples.isEmpty, secondsPerBar > 0 else {
            return samples
        }
        let index = min(
            max(Int(elapsed / secondsPerBar), 0),
            samples.count - 1
        )
        let peak = levels.reduce(Double(0)) { max($0, min(max($1, 0), 1)) }
        var updated = samples
        updated[index] = max(updated[index], peak)
        return updated
    }

    /// How many of the track's bars recording has reached, `0...barCount`.
    static func filledBarCount(elapsed: TimeInterval, barCount: Int) -> Int {
        VoiceWaveformPlayhead.playedBarCount(
            progress: VoiceWaveformPlayhead.progress(
                currentTime: elapsed,
                duration: VoiceNotePresentation.maximumDuration
            ),
            barCount: barCount
        )
    }
}

enum VoiceNoteSensoryFeedbackPolicy {
    static func recordingFeedback(
        previousPhase: VoiceNotePhase,
        currentPhase: VoiceNotePhase
    ) -> SensoryFeedback? {
        let wasRecording = isRecording(previousPhase)
        let isRecordingNow = isRecording(currentPhase)
        if !wasRecording && isRecordingNow { return .start }
        if wasRecording && !isRecordingNow { return .stop }
        return nil
    }

    private static func isRecording(_ phase: VoiceNotePhase) -> Bool {
        if case .recording = phase { return true }
        return false
    }
}

@MainActor
struct VoiceNoteSheet: View {
    @Bindable var store: VoiceNoteStore
    var forceReducedMotion = false
    var dismissPresentation: (() -> Void)?

    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @Environment(\.dismiss) private var systemDismiss
    @Environment(\.scenePhase) private var scenePhase
    @AccessibilityFocusState private var focusedControl: FocusTarget?
    @State private var dismissAfterSuccessfulSave = false

    private enum FocusTarget: Hashable {
        case savedSummary
        case permissionRecovery
    }

    private var reduceMotion: Bool {
        systemReduceMotion || forceReducedMotion
    }

    var body: some View {
        ZStack(alignment: .top) {
            ScrollView {
                content
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, SnapListMetrics.screenGutter)
            }
            .scrollIndicators(.hidden)

            Button(action: {}) {
                Capsule()
                    .fill(SnapListColorToken.dragHandleMuted.color)
                    .frame(width: 36, height: 5)
                    .frame(width: 80, height: 32, alignment: .top)
                    .padding(.top, 20)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Sheet Grabber")
        }
        .frame(
            maxWidth: .infinity,
            minHeight: VoiceNotePresentation.sheetHeight,
            maxHeight: VoiceNotePresentation.sheetHeight,
            alignment: .top
        )
        .background(SnapListColorToken.canvas.color)
        .clipShape(
            UnevenRoundedRectangle(
                cornerRadii: RectangleCornerRadii(
                    topLeading: SnapListMetrics.sheetRadius,
                    bottomLeading: 0,
                    bottomTrailing: 0,
                    topTrailing: SnapListMetrics.sheetRadius
                ),
                style: .continuous
            )
        )
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                store.refreshPermissionTruth()
            case .inactive, .background:
                store.handleSceneInactive()
            @unknown default:
                store.handleSceneInactive()
            }
        }
        .onChange(of: store.phase) { _, _ in
            switch store.consumeFocusRequest() {
            case .savedNoteSummary:
                focusedControl = .savedSummary
            case .voiceNoteOpener, nil:
                break
            }
            resolvePendingSaveDismissal()
        }
        .sensoryFeedback(trigger: store.phase) { previous, current in
            VoiceNoteSensoryFeedbackPolicy.recordingFeedback(
                previousPhase: previous,
                currentPhase: current
            )
        }
        .task(id: isRecording) {
            guard isRecording, !usesStaticRecordingFixture else {
                return
            }
            while !Task.isCancelled, isRecording {
                store.refreshRecording()
                try? await Task.sleep(
                    for: reduceMotion
                        ? .seconds(1)
                        : .milliseconds(100)
                )
            }
        }
        // The playhead is progress, not decoration, so Reduced Motion keeps
        // the same cadence instead of slowing it down.
        .task(id: isPlayingSavedNote) {
            guard isPlayingSavedNote, !usesStaticVoiceNoteFixture else {
                return
            }
            while !Task.isCancelled, isPlayingSavedNote {
                store.refreshPlayback()
                try? await Task.sleep(for: .milliseconds(60))
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch store.phase {
        case .recording(let elapsed, _):
            recordingControls(elapsed: elapsed, canSave: elapsed > 0)
        case .takeReady(let duration):
            recordingControls(elapsed: duration, canSave: true)
        case .ready:
            VStack(spacing: 0) {
                standardHeader
                Text(VoiceNotePresentation.sheetContext)
                    .snapListTypography(.body)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .padding(.top, 22)
                    .accessibilityIdentifier("voice-note.helper")
                recordButton
                    .padding(.top, 20)
            }
            .padding(.top, 18)
        case .saved(let isPlaying):
            VStack(spacing: 0) {
                standardHeader
                savedPlayback(isPlaying: isPlaying)
                    .padding(.top, 24)
            }
            .padding(.top, 18)
        case .accessOff(let permission):
            VStack(spacing: 0) {
                standardHeader
                accessOff(permission: permission)
                    .padding(.top, 12)
            }
            .padding(.top, 18)
        case .interrupted:
            VStack(spacing: 0) {
                standardHeader
                interrupted
                    .padding(.top, 12)
            }
            .padding(.top, 18)
        case .saveFailed:
            VStack(spacing: 0) {
                standardHeader
                saveFailed
                    .padding(.top, 12)
            }
            .padding(.top, 18)
        }
    }

    private var standardHeader: some View {
        HStack {
            Text("Voice note")
                .snapListTypography(.sectionHeader)
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .accessibilityIdentifier("voice-note.title")
            Spacer()
            Button {
                closePresentationIfPossible()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 20, weight: .regular))
                    .foregroundStyle(
                        SnapListColorToken.textSecondary.color
                    )
            }
            .buttonStyle(.plain)
            .frame(
                width: VoiceNotePresentation.compactSheetControlLayoutTarget,
                height: VoiceNotePresentation.compactSheetControlLayoutTarget
            )
            .contentShape(.rect)
            .accessibilityLabel("Close")
            .accessibilityIdentifier("voice-note.close")
        }
        .padding(.trailing, -8)
    }

    private var recordButton: some View {
        Button {
            Task {
                await store.startRecording()
            }
        } label: {
            Image(systemName: "mic.fill")
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(SnapListColorToken.onDarkSurface.color)
                .frame(
                    width: 52,
                    height: 52
                )
                .background(SnapListColorToken.inkPrimary.color)
                .clipShape(.circle)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Start recording")
        .accessibilityIdentifier("voice-note.record")
    }

    private func recordingControls(
        elapsed: TimeInterval,
        canSave: Bool
    ) -> some View {
        VStack(spacing: 15) {
            HStack(spacing: 14) {
                Button {
                    if store.cancelRecording() {
                        closePresentationIfPossible()
                    }
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 18, weight: .regular))
                        .foregroundStyle(
                            SnapListColorToken.textTertiary.color
                        )
                        .frame(
                            width: VoiceNotePresentation.compactSheetControlLayoutTarget,
                            height: VoiceNotePresentation.compactSheetControlLayoutTarget
                        )
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Cancel recording")
                .accessibilityIdentifier("voice-note.cancel")
                .accessibilitySortPriority(
                    VoiceNoteRecordingAccessibilityElement
                        .cancel
                        .sortPriority
                )

                VoiceNoteWaveform(
                    isLive: true,
                    reduceMotion: reduceMotion,
                    samples: usesStaticLiveFixtureSamples
                        ? Self.staticLiveFixtureSamples
                        : store.liveMeterSamples,
                    elapsed: elapsed
                )
                .frame(maxWidth: .infinity, minHeight: 52)

                Button {
                    saveAndDismissWhenCommitted()
                } label: {
                    Image(systemName: "checkmark")
                        .font(.system(size: 18, weight: .bold))
                        .foregroundStyle(SnapListColorToken.onDarkSurface.color)
                        .frame(
                            width: 52,
                            height: 52
                        )
                        .background(SnapListColorToken.inkPrimary.color)
                        .clipShape(.circle)
                }
                .buttonStyle(.plain)
                .disabled(!canSave)
                .accessibilityLabel("Save voice note")
                .accessibilityIdentifier("voice-note.save")
                .accessibilitySortPriority(
                    VoiceNoteRecordingAccessibilityElement
                        .save
                        .sortPriority
                )
            }

            Text(VoiceNotePresentation.elapsedText(elapsed))
                .snapListTypography(.status)
                .foregroundStyle(SnapListColorToken.textTertiary.color)
                .accessibilityLabel(
                    VoiceNotePresentation.recordingAccessibilityLabel(
                        elapsed: elapsed
                    )
                )
                .accessibilityIdentifier("voice-note.elapsed")
                .accessibilitySortPriority(
                    VoiceNoteRecordingAccessibilityElement
                        .elapsed
                        .sortPriority
                )
        }
        .padding(.top, 71)
    }

    private func savedPlayback(isPlaying: Bool) -> some View {
        VStack(spacing: 19) {
            HStack(spacing: 14) {
                Button {
                    store.togglePlayback()
                } label: {
                    Image(
                        systemName: isPlaying
                            ? "pause.fill"
                            : "play.fill"
                    )
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(SnapListColorToken.onDarkSurface.color)
                    .frame(
                        width: VoiceNotePresentation.compactSheetControlLayoutTarget,
                        height: VoiceNotePresentation.compactSheetControlLayoutTarget
                    )
                    .background(SnapListColorToken.inkPrimary.color)
                    .clipShape(.circle)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(
                    VoiceNotePresentation.playbackAccessibilityLabel(
                        isPlaying: isPlaying
                    )
                )
                .accessibilityIdentifier("voice-note.playback")
                .accessibilityFocused(
                    $focusedControl,
                    equals: .savedSummary
                )

                VoiceNoteWaveform(
                    isLive: false,
                    reduceMotion: true,
                    samples: usesStaticVoiceNoteFixture
                        ? Self.staticSavedFixtureSamples
                        : store.savedNoteWaveform,
                    playbackProgress: store.playbackProgress
                )
                .frame(maxWidth: .infinity, minHeight: 44)
                .accessibilityHidden(
                    VoiceNotePresentation
                        .savedWaveformIsAccessibilityHidden
                )
                .allowsHitTesting(
                    VoiceNotePresentation.savedWaveformIsInteractive
                )
                .padding(.trailing, 18)

                Text(
                    VoiceNotePresentation.elapsedText(
                        store.savedNote?.duration ?? 0
                    )
                )
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .accessibilityIdentifier("voice-note.duration")
            }

            HStack(spacing: 40) {
                Button {
                    Task {
                        await store.rerecord()
                    }
                } label: {
                    Image(systemName: "arrow.counterclockwise")
                        .font(.system(size: 22, weight: .regular))
                        .frame(
                            width: VoiceNotePresentation.compactSheetControlLayoutTarget,
                            height: VoiceNotePresentation.compactSheetControlLayoutTarget
                        )
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Rerecord")
                .accessibilityIdentifier("voice-note.rerecord")

                Button(role: .destructive) {
                    Task {
                        await store.deleteSavedNote()
                    }
                } label: {
                    Image(systemName: "trash")
                        .font(.system(size: 24, weight: .regular))
                        .foregroundStyle(SnapListColorToken.deleteIconTint.color)
                        .frame(
                            width: VoiceNotePresentation.compactSheetControlLayoutTarget,
                            height: VoiceNotePresentation.compactSheetControlLayoutTarget
                        )
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Delete")
                .accessibilityIdentifier("voice-note.delete")
            }
        }
    }

    private func accessOff(
        permission: VoiceNoteMicrophonePermission
    ) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Microphone access is required to record a voice note.")
                .snapListTypography(.body)
                .foregroundStyle(SnapListColorToken.textSecondary.color)
            if permission.canOpenSettings {
                SnapListSecondaryButton(title: "Open Settings") {
                    guard let url = URL(
                        string: UIApplication.openSettingsURLString
                    ) else {
                        return
                    }
                    UIApplication.shared.open(url)
                }
                .accessibilityFocused(
                    $focusedControl,
                    equals: .permissionRecovery
                )
            }
        }
    }

    private var interrupted: some View {
        VStack(spacing: 8) {
            Text("Recording stopped. Nothing was saved.")
                .snapListTypography(.body)
                .foregroundStyle(SnapListColorToken.textSecondary.color)
            recordButton
        }
    }

    private var saveFailed: some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle")
                .accessibilityHidden(true)
            Text("Voice note couldn't be saved. Try again.")
                .snapListTypography(.rowTitle)
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
            SnapListSecondaryButton(title: "Try again") {
                store.save()
            }
        }
    }

    private var isRecording: Bool {
        if case .recording = store.phase {
            return true
        }
        return false
    }

    /// The launch-argument fixtures replace the microphone and the player, so
    /// they also replace the shapes those would have produced. Debug only.
    private var usesStaticVoiceNoteFixture: Bool {
#if DEBUG
        ProcessInfo.processInfo.arguments.contains {
            $0.hasPrefix("--voice-note-")
        }
#else
        false
#endif
    }

    private static let liveFixturePattern: [Double] = [
        0.72, 0.86, 0.92, 0.80, 0.74, 0.66,
        0.14, 0.12, 0.42, 0.72, 0.88, 0.96,
        1.00, 0.82, 0.68, 0.78, 0.92, 0.70,
        0.56, 0.42, 0.34, 0.12, 0.46, 0.82,
        0.98, 0.14, 0.10
    ]

    private static let savedFixturePattern: [Double] = [
        0.72, 0.64, 0.16, 0.48, 0.82, 0.78,
        0.36, 0.14, 0.76, 0.18, 0.14, 0.12,
        0.10, 0.12, 0.66, 0.18, 0.36, 0.90,
        1.00, 0.72, 0.54, 0.16, 0.70, 0.68
    ]

    /// The fixed track has more bars than the hand-authored fixture shapes
    /// above, so each pattern repeats to fill it. Trailing indices beyond
    /// whatever is "filled" for a given fixture phase are never drawn — the
    /// view shows a placeholder dot there instead — so the repetition only
    /// needs to look plausible, not be unique per bar.
    private static let staticLiveFixtureSamples: [Double] =
        tiled(liveFixturePattern)
    private static let staticSavedFixtureSamples: [Double] =
        tiled(savedFixturePattern)

    private static func tiled(_ pattern: [Double]) -> [Double] {
        guard !pattern.isEmpty else {
            return []
        }
        var extended: [Double] = []
        extended.reserveCapacity(VoiceNoteWaveformGeometry.trackBarCount)
        while extended.count < VoiceNoteWaveformGeometry.trackBarCount {
            extended.append(contentsOf: pattern)
        }
        return Array(extended.prefix(VoiceNoteWaveformGeometry.trackBarCount))
    }

    private var isPlayingSavedNote: Bool {
        store.phase == .saved(isPlaying: true)
    }

    private var usesStaticRecordingFixture: Bool {
#if DEBUG
        ProcessInfo.processInfo.arguments.contains(
            "--voice-note-recording-fixture"
        )
#else
        false
#endif
    }

    private var usesStaticTakeReadyFixture: Bool {
#if DEBUG
        ProcessInfo.processInfo.arguments.contains(
            "--voice-note-take-ready-fixture"
        )
#else
        false
#endif
    }

    /// Both the live-recording fixture and the take-ready fixture replace the
    /// microphone, so neither drives `store.liveMeterSamples` — they draw the
    /// same static shape instead.
    private var usesStaticLiveFixtureSamples: Bool {
        usesStaticRecordingFixture || usesStaticTakeReadyFixture
    }

    private func saveAndDismissWhenCommitted() {
        dismissAfterSuccessfulSave = true
#if DEBUG
        if store.commitLaunchFixtureRecordingIfNeeded() {
            resolvePendingSaveDismissal()
            return
        }
#endif
        store.save()
        resolvePendingSaveDismissal()
    }

    private func resolvePendingSaveDismissal() {
        guard dismissAfterSuccessfulSave else {
            return
        }
        switch store.phase {
        case .saved:
            dismissAfterSuccessfulSave = false
            closePresentationIfPossible()
        case .recording, .takeReady:
            break
        case .ready, .accessOff, .interrupted, .saveFailed:
            dismissAfterSuccessfulSave = false
        }
    }

    private func closePresentationIfPossible() {
        guard store.dismiss() else {
            return
        }
        if let dismissPresentation {
            dismissPresentation()
        } else {
            systemDismiss()
        }
    }
}

/// One fixed-width track, drawn once, for both the recording countdown and
/// the saved note's playback row. While recording, bars fill left to right at
/// a fixed pitch and the unrecorded remainder draws as dim placeholder dots —
/// the fill doubles as a countdown against the 15 s cap. During playback the
/// same bars split into an accent-tinted run behind the head and a dim run
/// ahead of it.
private struct VoiceNoteWaveform: View {
    let isLive: Bool
    let reduceMotion: Bool
    /// The shape to draw: the whole-track live-meter trail while recording
    /// (zeros ahead of what has been recorded), or the file-derived shape for
    /// a saved note.
    var samples: [Double] = []
    /// How far recording has reached. Only meaningful while `isLive`; drives
    /// the fill-to-cap boundary.
    var elapsed: TimeInterval = 0
    /// How far playback has reached, `0...1`. Only meaningful while not
    /// `isLive`; drives the tinted/dim boundary.
    var playbackProgress: Double = 0

    private static let barWidth: CGFloat = 2.5
    private static let placeholderDotDiameter: CGFloat = 1.5

    var body: some View {
        Canvas { context, size in
            let barCount = samples.count
            guard barCount > 0 else {
                return
            }
            let step = size.width / CGFloat(barCount)
            let centerY = size.height / 2
            let filledBarCount = isLive
                ? VoiceNoteWaveformGeometry.filledBarCount(
                    elapsed: elapsed,
                    barCount: barCount
                )
                : barCount
            let tintedBarCount = isLive
                ? filledBarCount
                : VoiceWaveformPlayhead.playedBarCount(
                    progress: playbackProgress,
                    barCount: barCount
                )

            for index in 0..<barCount {
                let x = CGFloat(index) * step + (step - Self.barWidth) / 2
                guard !isLive || index < filledBarCount else {
                    let diameter = Self.placeholderDotDiameter
                    let dotRect = CGRect(
                        x: x + (Self.barWidth - diameter) / 2,
                        y: centerY - diameter / 2,
                        width: diameter,
                        height: diameter
                    )
                    context.fill(
                        Path(ellipseIn: dotRect),
                        with: .color(SnapListColorToken.waveformInactive.color)
                    )
                    continue
                }

                let height = VoiceWaveformBarPolicy.barHeight(
                    amplitude: samples[index],
                    maximumHeight: size.height
                )
                let rect = CGRect(
                    x: x,
                    y: centerY - height / 2,
                    width: Self.barWidth,
                    height: height
                )
                context.fill(
                    Path(roundedRect: rect, cornerRadius: Self.barWidth / 2),
                    with: .color(
                        index < tintedBarCount
                            ? SnapListColorToken.action.color
                            : SnapListColorToken.waveformInactive.color
                    )
                )
            }
        }
        .animation(
            reduceMotion ? nil : .linear(duration: 0.1),
            value: samples
        )
        .accessibilityHidden(true)
        .allowsHitTesting(false)
    }
}
