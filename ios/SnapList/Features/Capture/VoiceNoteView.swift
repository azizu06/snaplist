import SwiftUI
import UIKit

/// The one track both the recording countdown and the saved note's playback
/// row draw: a fixed bar count spanning the 45 s cap, so the two never
/// disagree about how many bars represent a full take.
enum VoiceNoteWaveformGeometry {
    // Preserve the approved panel's density as the time allowance grows.
    static let trackBarCount = 75

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
        secondsPerBar: TimeInterval = VoiceNotePresentation.maximumDuration / Double(trackBarCount),
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

    /// The part of the recorded trail a stopped take drew, so review can
    /// spread the take's own shape across the whole track instead of leaving
    /// the unrecorded remainder empty.
    static func reviewSamples(
        trail: [Double],
        duration: TimeInterval
    ) -> [Double] {
        guard !trail.isEmpty else {
            return []
        }
        let recorded = filledBarCount(
            elapsed: duration,
            barCount: trail.count
        )
        return Array(trail.prefix(max(recorded, 1)))
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

/// #1136: stopping lands on review. The announcement is the only thing that
/// tells a VoiceOver seller the take ended; it never moves focus.
enum VoiceNoteReviewPolicy {
    static let stopAnnouncement =
        "Recording stopped. Review your voice note."

    static func announcesStop(
        from previous: VoiceNotePhase,
        to current: VoiceNotePhase
    ) -> Bool {
        guard case .recording = previous, case .takeReady = current else {
            return false
        }
        return true
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
    /// How far the seller has pulled the panel down. Only the panel moves:
    /// Photo Review yields its own drag while the voice note is open.
    @State private var dragTranslation: CGFloat = 0

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
            // Content that fits does not rubber-band under the panel's drag.
            .scrollBounceBehavior(.basedOnSize)

            Button(action: {}) {
                Capsule()
                    .fill(SnapListColorToken.dragHandleMuted.color)
                    .frame(width: 36, height: 5)
                    .frame(width: 80, height: 32, alignment: .top)
                    .padding(.top, 20)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Sheet Grabber")
            .modifier(VoiceNoteGrabberDrag(
                isEnabled: swipeCanMovePanel,
                changed: { dragTranslation = $0 },
                ended: finishSwipe
            ))
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
        .offset(y: ScanDrawerDragPolicy.offset(forTranslation: dragTranslation))
        .modifier(DownwardDragPanModifier(
            isEnabled: swipeCanMovePanel,
            changed: { dragTranslation = $0 },
            ended: finishSwipe
        ))
        // VoiceOver's escape gesture is the swipe's twin: it closes the voice
        // note on the same terms and never reaches the page underneath.
        .accessibilityAction(.escape) {
            performSwipeDismissal()
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                store.refreshPermissionTruth()
            case .inactive:
                store.handleSceneInactive()
            case .background:
                // A take under review is already held by the intake, so
                // leaving the app keeps it without saving it (#1136).
                store.handleSceneInactive()
            @unknown default:
                store.handleSceneInactive()
            }
        }
        .onChange(of: store.phase) { previous, current in
            if VoiceNoteReviewPolicy.announcesStop(
                from: previous,
                to: current
            ) {
                UIAccessibility.post(
                    notification: .announcement,
                    argument: VoiceNoteReviewPolicy.stopAnnouncement
                )
            }
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
        .task(id: isPlayingAnything) {
            guard isPlayingAnything, !usesStaticVoiceNoteFixture else {
                return
            }
            while !Task.isCancelled, isPlayingAnything {
                store.refreshPlayback()
                try? await Task.sleep(for: .milliseconds(60))
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch store.phase {
        case .recording(let elapsed, _):
            recordingSlots(elapsed: elapsed, canSave: elapsed > 0)
        case .takeReady(let duration):
            takeReview(duration: duration)
        case .ready:
            readySlots
        case .saved(let isPlaying):
            savedSlots(isPlaying: isPlaying)
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
            sheetTitle
            Spacer()
            closeButton
        }
        .padding(.trailing, -8)
    }

    private var sheetTitle: some View {
        Text("Voice note")
            .snapListTypography(.sectionHeader)
            .foregroundStyle(SnapListColorToken.inkPrimary.color)
            .accessibilityIdentifier("voice-note.title")
            .accessibilitySortPriority(VoiceNoteSheetLayout.titleSortPriority)
    }

    private var closeButton: some View {
        Button {
            closePresentationIfPossible()
        } label: {
            headerGlyph("xmark", size: 20)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Close")
        .accessibilityIdentifier("voice-note.close")
    }

    private func headerGlyph(_ systemName: String, size: CGFloat) -> some View {
        Image(systemName: systemName)
            .font(.system(size: size, weight: .regular))
            .foregroundStyle(SnapListColorToken.textSecondary.color)
            .frame(
                width: VoiceNotePresentation.compactSheetControlLayoutTarget,
                height: VoiceNotePresentation.compactSheetControlLayoutTarget
            )
            .contentShape(.rect)
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

    /// Voice Note A1 (captain pick, 2026-09-30): the empty recorder, a live
    /// take, a stopped take and a saved note share one header, one transport
    /// row, one reserved line and one action row. Stopping swaps what sits in
    /// each slot and moves nothing around it, so Save recording lands in the
    /// exact frame Stop used.
    private func steadySheet(
        headerControl: some View,
        leadingSlot: some View,
        waveform: some View,
        trailingSlot: some View,
        line: some View,
        lineAlignment: Alignment,
        action: some View
    ) -> some View {
        VStack(spacing: VoiceNoteSheetLayout.rowSpacing) {
            HStack {
                sheetTitle
                Spacer()
                headerControl
            }
            .padding(.trailing, -8)

            HStack(spacing: 14) {
                leadingSlot
                    .frame(
                        width: VoiceNotePresentation.compactSheetControlLayoutTarget,
                        height: VoiceNotePresentation.compactSheetControlLayoutTarget
                    )
                waveform
                    .frame(
                        maxWidth: .infinity,
                        minHeight: VoiceNoteSheetLayout.waveformHeight,
                        maxHeight: VoiceNoteSheetLayout.waveformHeight
                    )
                trailingSlot
                    .frame(
                        minWidth: VoiceNoteSheetLayout.timeSlotWidth,
                        alignment: .trailing
                    )
            }
            .frame(minHeight: VoiceNoteSheetLayout.transportHeight)

            line
                .frame(
                    maxWidth: .infinity,
                    minHeight: VoiceNoteSheetLayout.reservedLineHeight,
                    alignment: lineAlignment
                )

            action
        }
        .padding(.top, 18)
    }

    private var readySlots: some View {
        steadySheet(
            headerControl: closeButton,
            leadingSlot: micGlyph(isLive: false),
            waveform: VoiceNoteWaveform(
                isLive: true,
                reduceMotion: reduceMotion,
                samples: VoiceNoteWaveformGeometry.emptyLiveMeterSamples,
                elapsed: 0
            ),
            trailingSlot: timeText(
                VoiceNotePresentation.maximumDuration,
                isMuted: true
            )
            .accessibilityHidden(true),
            line: Text(VoiceNotePresentation.sheetContext)
                .snapListTypography(.body)
                .foregroundStyle(SnapListColorToken.textSecondary.color)
                .accessibilityIdentifier("voice-note.helper"),
            lineAlignment: .leading,
            action: Button {
                Task {
                    await store.startRecording()
                }
            } label: {
                actionLabel("Record", systemImage: "mic.fill")
            }
            .buttonStyle(VoiceNoteSheetActionStyle(kind: .ink))
            .accessibilityLabel("Start recording")
            .accessibilityIdentifier("voice-note.record")
        )
    }

    private func recordingSlots(
        elapsed: TimeInterval,
        canSave: Bool
    ) -> some View {
        steadySheet(
            headerControl: Button {
                if store.cancelRecording() {
                    closePresentationIfPossible()
                }
            } label: {
                headerGlyph("xmark", size: 20)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Cancel recording")
            .accessibilityIdentifier("voice-note.cancel")
            .accessibilitySortPriority(
                VoiceNoteRecordingAccessibilityElement
                    .cancel
                    .sortPriority
            ),
            leadingSlot: micGlyph(isLive: true),
            waveform: VoiceNoteWaveform(
                isLive: true,
                reduceMotion: reduceMotion,
                samples: usesStaticLiveFixtureSamples
                    ? Self.staticLiveFixtureSamples
                    : store.liveMeterSamples,
                elapsed: elapsed
            ),
            trailingSlot: timeText(elapsed, isMuted: true)
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
                ),
            line: Text(VoiceNotePresentation.recordingHint)
                .snapListTypography(.status)
                .foregroundStyle(SnapListColorToken.textTertiary.color),
            lineAlignment: .leading,
            action: Button {
                store.stopRecording()
            } label: {
                actionLabel("Stop", systemImage: "stop.fill")
            }
            .buttonStyle(VoiceNoteSheetActionStyle(kind: .ink))
            .disabled(!canSave)
            .accessibilityLabel("Stop recording")
            .accessibilityIdentifier("voice-note.save")
            .accessibilitySortPriority(
                VoiceNoteRecordingAccessibilityElement
                    .save
                    .sortPriority
            )
        )
    }

    /// A stopped take waiting on the seller. The chevron keeps the take and
    /// Save recording saves it; either closes the panel. Delete and Re-record
    /// keep it open.
    private func takeReview(duration: TimeInterval) -> some View {
        steadySheet(
            headerControl: Button {
                saveAndDismissWhenCommitted()
            } label: {
                headerGlyph("chevron.down", size: 18)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Collapse and keep voice note")
            .accessibilityIdentifier("voice-note.collapse"),
            leadingSlot: playbackButton(isPlaying: store.isPlayingTake) {
                toggleTakePlayback()
            },
            waveform: VoiceNoteWaveform(
                isLive: false,
                reduceMotion: true,
                samples: VoiceNoteWaveformGeometry.reviewSamples(
                    trail: usesStaticLiveFixtureSamples
                        ? Self.staticLiveFixtureSamples
                        : store.liveMeterSamples,
                    duration: duration
                ),
                playbackProgress: store.playbackProgress
            ),
            trailingSlot: timeText(duration, isMuted: false)
                .accessibilityIdentifier("voice-note.elapsed"),
            line: takeActions(
                rerecord: {
                    Task {
                        await store.rerecord()
                    }
                },
                delete: discardReviewedTake
            ),
            lineAlignment: .bottom,
            action: Button {
                saveAndDismissWhenCommitted()
            } label: {
                actionLabel("Save recording")
            }
            .buttonStyle(VoiceNoteSheetActionStyle(kind: .action))
            .accessibilityIdentifier("voice-note.save-recording")
        )
    }

    private func savedSlots(isPlaying: Bool) -> some View {
        steadySheet(
            headerControl: closeButton,
            leadingSlot: playbackButton(isPlaying: isPlaying) {
                store.togglePlayback()
            }
            .accessibilityFocused(
                $focusedControl,
                equals: .savedSummary
            ),
            waveform: VoiceNoteWaveform(
                isLive: false,
                reduceMotion: true,
                samples: usesStaticVoiceNoteFixture
                    ? Self.staticSavedFixtureSamples
                    : store.savedNoteWaveform,
                playbackProgress: store.playbackProgress
            )
            .accessibilityHidden(
                VoiceNotePresentation
                    .savedWaveformIsAccessibilityHidden
            )
            .allowsHitTesting(
                VoiceNotePresentation.savedWaveformIsInteractive
            ),
            trailingSlot: timeText(
                store.savedNote?.duration ?? 0,
                isMuted: false
            )
            .accessibilityIdentifier("voice-note.duration"),
            line: takeActions(
                rerecord: {
                    Task {
                        await store.rerecord()
                    }
                },
                delete: {
                    Task {
                        await store.deleteSavedNote()
                    }
                }
            ),
            lineAlignment: .bottom,
            action: Button {
                closePresentationIfPossible()
            } label: {
                actionLabel("Done")
            }
            .buttonStyle(VoiceNoteSheetActionStyle(kind: .outline))
            .accessibilityIdentifier("voice-note.done")
        )
    }

    private func micGlyph(isLive: Bool) -> some View {
        Image(systemName: "mic")
            .font(.system(size: 18, weight: .medium))
            .foregroundStyle(
                isLive
                    ? SnapListColorToken.inkPrimary.color
                    : SnapListColorToken.textTertiary.color
            )
            .frame(
                width: VoiceNotePresentation.compactSheetControlLayoutTarget,
                height: VoiceNotePresentation.compactSheetControlLayoutTarget
            )
            .background(SnapListColorToken.quietFill.color)
            .clipShape(.circle)
            .accessibilityHidden(true)
    }

    private func playbackButton(
        isPlaying: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: isPlaying ? "pause.fill" : "play.fill")
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
    }

    /// One text style for the transport's time slot, so the running timer and
    /// the take length occupy the same frame; only the color says which.
    private func timeText(
        _ seconds: TimeInterval,
        isMuted: Bool
    ) -> some View {
        Text(VoiceNotePresentation.elapsedText(seconds))
            .monospacedDigit()
            .snapListTypography(.rowTitle)
            .foregroundStyle(
                isMuted
                    ? SnapListColorToken.textTertiary.color
                    : SnapListColorToken.inkPrimary.color
            )
    }

    /// Re-record and Delete as an equal pair above the action row.
    private func takeActions(
        rerecord: @escaping () -> Void,
        delete: @escaping () -> Void
    ) -> some View {
        HStack(spacing: VoiceNoteSheetLayout.rowSpacing) {
            Button(action: rerecord) {
                actionLabel(
                    "Re-record",
                    systemImage: "arrow.counterclockwise",
                    height: VoiceNoteSheetLayout.takeActionHeight
                )
            }
            .buttonStyle(VoiceNoteSheetActionStyle(kind: .outline))
            .accessibilityIdentifier("voice-note.rerecord")

            Button(role: .destructive, action: delete) {
                actionLabel(
                    "Delete",
                    systemImage: "trash",
                    height: VoiceNoteSheetLayout.takeActionHeight
                )
            }
            .buttonStyle(VoiceNoteSheetActionStyle(kind: .outlineDestructive))
            .accessibilityIdentifier("voice-note.delete")
        }
    }

    private func actionLabel(
        _ title: String,
        systemImage: String? = nil,
        height: CGFloat = VoiceNoteSheetLayout.actionHeight
    ) -> some View {
        HStack(spacing: 7) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: 15, weight: .semibold))
                    .accessibilityHidden(true)
            }
            Text(title)
                .snapListTypography(.rowTitle)
                .snapListFitsFixedSlot()
        }
        .frame(maxWidth: .infinity, minHeight: height)
        .contentShape(.rect)
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

    private var isPlayingAnything: Bool {
        isPlayingSavedNote || store.isPlayingTake
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

    private func toggleTakePlayback() {
#if DEBUG
        if usesStaticVoiceNoteFixture {
            store.toggleFixtureTakePlayback()
            return
        }
#endif
        store.toggleTakePlayback()
    }

    /// A live take holds the panel still; every other phase lets it follow
    /// the finger and decides on release.
    private var swipeCanMovePanel: Bool {
        VoiceNoteSwipePolicy.dismissal(for: store.phase) != .blocked
    }

    private func finishSwipe(translation: CGFloat, velocity: CGFloat) {
        let outcome = ScanDrawerDragPolicy.outcome(
            translation: translation,
            velocity: velocity,
            drawerHeight: VoiceNotePresentation.sheetHeight
        )
        guard outcome == .dismiss else {
            settleSwipe()
            return
        }
        performSwipeDismissal()
    }

    /// The panel keeps the finger's offset while it leaves; anything that
    /// leaves it up springs it back.
    private func performSwipeDismissal() {
        switch VoiceNoteSwipePolicy.dismissal(for: store.phase) {
        case .blocked:
            settleSwipe()
        case .keepTakeAndClose:
            saveAndDismissWhenCommitted()
        case .close:
            closePresentationIfPossible()
        }
    }

    private func settleSwipe() {
        guard dragTranslation != 0 else { return }
        withAnimation(ScanDrawerMotionPolicy.presentationAnimation(
            reduceMotion: reduceMotion
        )) { dragTranslation = 0 }
    }

    /// Delete on review keeps the panel open, on the state it fell back to:
    /// the empty recorder, or the prior saved note.
    private func discardReviewedTake() {
#if DEBUG
        if usesStaticVoiceNoteFixture, store.discardFixtureTake() {
            return
        }
#endif
        store.discardTake()
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
            settleSwipe()
        }
    }

    private func closePresentationIfPossible() {
        guard store.dismiss() else {
            settleSwipe()
            return
        }
        if let dismissPresentation {
            dismissPresentation()
        } else {
            systemDismiss()
        }
    }
}

/// Voice Note A1 geometry. With the 18 pt top inset these rows fill
/// `VoiceNotePresentation.sheetHeight` above the home indicator.
enum VoiceNoteSheetLayout {
    static let rowSpacing: CGFloat = 10
    static let transportHeight: CGFloat = 52
    static let waveformHeight: CGFloat = 48
    static let timeSlotWidth: CGFloat = 40
    /// Holds helper copy while recording and the Re-record and Delete pair
    /// after stop. The pair sits at its bottom, so it keeps 22 pt clear of the
    /// waveform row (captain: "not too cramped to the actual voice note").
    static let reservedLineHeight: CGFloat = 56
    static let takeActionHeight: CGFloat = 44
    static let actionHeight: CGFloat = 52
    static let actionRadius: CGFloat = 15
    /// The title reads first even while recording, ahead of Cancel, the
    /// timer and Stop (`VoiceNoteRecordingAccessibilityElement`).
    static let titleSortPriority: Double = 4
}

/// Before iOS 18 there is no UIKit pan bridge, so the grabber carries the
/// panel's drag on its own, as the Scan drawer's grabber does.
private struct VoiceNoteGrabberDrag: ViewModifier {
    let isEnabled: Bool
    let changed: (CGFloat) -> Void
    let ended: (CGFloat, CGFloat) -> Void

    func body(content: Content) -> some View {
        if #available(iOS 18, *) {
            content
        } else {
            content.gesture(
                DragGesture(minimumDistance: 4)
                    .onChanged {
                        changed(ScanDrawerDragPolicy.offset(
                            forTranslation: $0.translation.height
                        ))
                    }
                    .onEnded {
                        ended($0.translation.height, $0.velocity.height)
                    },
                including: isEnabled ? .all : .subviews
            )
        }
    }
}

private struct VoiceNoteSheetActionStyle: ButtonStyle {
    enum Kind {
        case ink
        case action
        case outline
        case outlineDestructive
    }

    let kind: Kind
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(foreground)
            .background(fill.opacity(isEnabled ? 1 : 0.45))
            .clipShape(
                .rect(cornerRadius: VoiceNoteSheetLayout.actionRadius)
            )
            .overlay {
                RoundedRectangle(
                    cornerRadius: VoiceNoteSheetLayout.actionRadius
                )
                .stroke(
                    SnapListColorToken.neutralOutline.color,
                    lineWidth: isOutlined ? 1 : 0
                )
            }
            .opacity(configuration.isPressed ? 0.88 : 1)
    }

    private var isOutlined: Bool {
        kind == .outline || kind == .outlineDestructive
    }

    private var fill: Color {
        switch kind {
        case .ink:
            SnapListColorToken.inkPrimary.color
        case .action:
            SnapListColorToken.action.color
        case .outline, .outlineDestructive:
            SnapListColorToken.canvas.color
        }
    }

    private var foreground: Color {
        switch kind {
        case .ink, .action:
            SnapListColorToken.onDarkSurface.color
        case .outline:
            SnapListColorToken.inkPrimary.color
        case .outlineDestructive:
            SnapListColorToken.deleteIconTint.color
        }
    }
}

/// One fixed-width track, drawn once, for both the recording countdown and
/// the saved note's playback row. While recording, bars fill left to right at
/// a fixed pitch and the unrecorded remainder draws as dim placeholder dots —
/// the fill doubles as a countdown against the 45 s cap. During playback the
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
