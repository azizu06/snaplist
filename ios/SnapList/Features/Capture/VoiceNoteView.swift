import SwiftUI
import UIKit

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
                    .fill(Color(hex: "#D4D6DB"))
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
    }

    @ViewBuilder
    private var content: some View {
        switch store.phase {
        case .recording(let elapsed, let level):
            recordingControls(
                elapsed: elapsed,
                level: level,
                canSave: elapsed > 0,
                isHeldTake: false
            )
        case .takeReady(let duration):
            recordingControls(
                elapsed: duration,
                level: 0.64,
                canSave: true,
                isHeldTake: true
            )
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
                .foregroundStyle(.white)
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
        level: Double,
        canSave: Bool,
        isHeldTake: Bool
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
                    level: level,
                    isLive: true,
                    reduceMotion: reduceMotion,
                    isHeldTake: isHeldTake
                )
                .frame(maxWidth: .infinity, minHeight: 52)

                Button {
                    saveAndDismissWhenCommitted()
                } label: {
                    Image(systemName: "checkmark")
                        .font(.system(size: 18, weight: .bold))
                        .foregroundStyle(.white)
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
                    .foregroundStyle(.white)
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
                    level: 0.72,
                    isLive: false,
                    reduceMotion: true,
                    isHeldTake: false
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
                        .foregroundStyle(Color(hex: "#A63224"))
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
            Text("Voice note couldn’t be saved. Try again.")
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

    private var usesStaticRecordingFixture: Bool {
#if DEBUG
        ProcessInfo.processInfo.arguments.contains(
            "--voice-note-recording-fixture"
        )
#else
        false
#endif
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

private struct VoiceNoteWaveform: View {
    let level: Double
    let isLive: Bool
    let reduceMotion: Bool
    let isHeldTake: Bool

    private let livePattern: [Double] = [
        0.72, 0.86, 0.92, 0.80, 0.74, 0.66,
        0.14, 0.12, 0.42, 0.72, 0.88, 0.96,
        1.00, 0.82, 0.68, 0.78, 0.92, 0.70,
        0.56, 0.42, 0.34, 0.12, 0.46, 0.82,
        0.98, 0.14, 0.10
    ]

    private let savedPattern: [Double] = [
        0.72, 0.64, 0.16, 0.48, 0.82, 0.78,
        0.36, 0.14, 0.76, 0.18, 0.14, 0.12,
        0.10, 0.12, 0.66, 0.18, 0.36, 0.90,
        1.00, 0.72, 0.54, 0.16, 0.70, 0.68
    ]

    var body: some View {
        Group {
            if isHeldTake {
                VoiceNoteHeldTakeWaveform()
            } else {
                Canvas { context, size in
                    let pattern = isLive ? livePattern : savedPattern
                    let color = isLive
                        ? SnapListColorToken.inkPrimary.color
                        : Color(hex: "#B5B7BC")
                    let barWidth: CGFloat = 4
                    let centerY = size.height / 2
                    let step = pattern.count > 1
                        ? (size.width - barWidth)
                            / CGFloat(pattern.count - 1)
                        : 0

                    for (index, value) in pattern.enumerated() {
                        let height = barHeight(
                            value: value,
                            isLive: isLive
                        )
                        let rect = CGRect(
                            x: CGFloat(index) * step,
                            y: centerY - (height / 2),
                            width: barWidth,
                            height: height
                        )
                        context.fill(
                            Path(
                                roundedRect: rect,
                                cornerRadius: barWidth / 2
                            ),
                            with: .color(color)
                        )
                    }
                }
            }
        }
        .animation(
            reduceMotion ? nil : .linear(duration: 0.1),
            value: level
        )
        .accessibilityHidden(true)
        .allowsHitTesting(false)
    }

    private func barHeight(
        value: Double,
        isLive: Bool
    ) -> CGFloat {
        if isLive {
            let visibleLevel = max(level, 0.12)
            return max(
                4,
                32 * value * (0.70 + (visibleLevel * 0.40))
            )
        }
        return max(5, 30 * value)
    }
}

private struct VoiceNoteHeldTakeWaveform: View {
    private let heights: [CGFloat] = [
        24, 32, 37, 31, 24, 20, 25, 22,
        16, 12, 10, 9, 9, 9, 14, 34
    ]

    var body: some View {
        Canvas { context, size in
            let ink = SnapListColorToken.inkPrimary.color
            let centerY = size.height / 2
            let barWidth: CGFloat = 4
            let barStep: CGFloat = 8.5

            for (index, height) in heights.enumerated() {
                let x = CGFloat(index) * barStep
                let rect = CGRect(
                    x: x,
                    y: centerY - (height / 2),
                    width: barWidth,
                    height: height
                )
                context.fill(
                    Path(roundedRect: rect, cornerRadius: barWidth / 2),
                    with: .color(ink)
                )
            }

            let dotSize: CGFloat = 3.5
            var dotX = (CGFloat(heights.count) * barStep) + 2
            while dotX + dotSize <= size.width - 10 {
                context.fill(
                    Path(
                        ellipseIn: CGRect(
                            x: dotX,
                            y: centerY - (dotSize / 2),
                            width: dotSize,
                            height: dotSize
                        )
                    ),
                    with: .color(ink)
                )
                dotX += 8.5
            }
        }
        .accessibilityHidden(true)
        .allowsHitTesting(false)
    }
}
