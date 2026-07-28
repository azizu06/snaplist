import SwiftUI
import UIKit

@MainActor
struct VoiceNoteSheet: View {
    @Bindable var store: VoiceNoteStore
    var forceReducedMotion = false

    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.scenePhase) private var scenePhase
    @AccessibilityFocusState private var focusedControl: FocusTarget?
    @State private var selectedDetent: PresentationDetent = .height(
        VoiceNotePresentation.sheetHeight
    )

    private enum FocusTarget: Hashable {
        case savedSummary
        case permissionRecovery
    }

    private var reduceMotion: Bool {
        systemReduceMotion || forceReducedMotion
    }

    var body: some View {
        ScrollView {
            content
                .frame(maxWidth: .infinity)
                .padding(.horizontal, SnapListMetrics.screenGutter)
                .padding(.bottom, 16)
        }
        .scrollIndicators(.hidden)
        .background(SnapListColorToken.canvas.color)
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(SnapListMetrics.sheetRadius)
        .presentationDetents(
            [.height(VoiceNotePresentation.sheetHeight), .medium],
            selection: $selectedDetent
        )
        .interactiveDismissDisabled(true)
        .onAppear {
            if dynamicTypeSize.isAccessibilitySize {
                selectedDetent = .medium
            }
        }
        .onChange(of: dynamicTypeSize) { _, size in
            selectedDetent = size.isAccessibilitySize
                ? .medium
                : .height(VoiceNotePresentation.sheetHeight)
        }
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
        }
        .task(id: isRecording) {
            guard isRecording else {
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
                canSave: elapsed > 0
            )
        case .takeReady(let duration):
            recordingControls(
                elapsed: duration,
                level: 0.64,
                canSave: true
            )
        case .ready:
            standardHeader
            Text(VoiceNotePresentation.sheetContext)
                .snapListTypography(.body)
                .foregroundStyle(SnapListColorToken.textSecondary.color)
                .padding(.top, 12)
                .accessibilityIdentifier("voice-note.helper")
            recordButton
                .padding(.top, 10)
        case .saved(let isPlaying):
            standardHeader
            savedPlayback(isPlaying: isPlaying)
                .padding(.top, 8)
        case .accessOff(let permission):
            standardHeader
            accessOff(permission: permission)
                .padding(.top, 8)
        case .interrupted:
            standardHeader
            interrupted
                .padding(.top, 8)
        case .saveFailed:
            standardHeader
            saveFailed
                .padding(.top, 8)
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
                if store.dismiss() {
                    dismiss()
                }
            } label: {
                Image(systemName: "xmark")
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
        canSave: Bool
    ) -> some View {
        VStack(spacing: 4) {
            HStack(spacing: 14) {
                Button {
                    store.cancelRecording()
                } label: {
                    Image(systemName: "xmark")
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
                    reduceMotion: reduceMotion
                )
                .frame(maxWidth: .infinity, minHeight: 52)

                Button {
                    store.save()
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
                .snapListTypography(.metadata)
                .foregroundStyle(SnapListColorToken.textSecondary.color)
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
        .padding(.top, 16)
    }

    private func savedPlayback(isPlaying: Bool) -> some View {
        VStack(spacing: 6) {
            HStack(spacing: 12) {
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
                    reduceMotion: true
                )
                .frame(maxWidth: .infinity, minHeight: 44)
                .accessibilityHidden(
                    VoiceNotePresentation
                        .savedWaveformIsAccessibilityHidden
                )
                .allowsHitTesting(
                    VoiceNotePresentation.savedWaveformIsInteractive
                )

                Text(
                    VoiceNotePresentation.elapsedText(
                        store.savedNote?.duration ?? 0
                    )
                )
                .snapListTypography(.status)
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .accessibilityIdentifier("voice-note.duration")
            }

            HStack(spacing: 34) {
                Button {
                    Task {
                        await store.rerecord()
                    }
                } label: {
                    Image(systemName: "arrow.counterclockwise")
                        .frame(
                            width: VoiceNotePresentation.compactSheetControlLayoutTarget,
                            height: VoiceNotePresentation.compactSheetControlLayoutTarget
                        )
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Rerecord")
                .accessibilityIdentifier("voice-note.rerecord")

                Button(role: .destructive) {
                    store.deleteSavedNote()
                } label: {
                    Image(systemName: "trash")
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
}

private struct VoiceNoteWaveform: View {
    let level: Double
    let isLive: Bool
    let reduceMotion: Bool

    private let pattern: [Double] = [
        0.70, 1.00, 0.54, 0.82, 0.64, 1.00,
        0.42, 0.34, 0.30, 0.38, 0.80, 1.00,
        0.62, 0.88, 0.52, 0.98, 0.70, 0.46,
        0.34, 0.30, 0.72, 0.92, 0.60, 0.78
    ]

    var body: some View {
        HStack(alignment: .center, spacing: 3) {
            ForEach(pattern.indices, id: \.self) { index in
                Capsule()
                    .fill(
                        isLive
                            ? SnapListColorToken.inkPrimary.color
                            : Color(hex: "#B4B8BF")
                    )
                    .frame(
                        width: 3,
                        height: barHeight(at: index)
                    )
            }
        }
        .animation(
            reduceMotion ? nil : .linear(duration: 0.1),
            value: level
        )
        .accessibilityHidden(true)
        .allowsHitTesting(false)
    }

    private func barHeight(at index: Int) -> CGFloat {
        let visibleLevel = max(level, 0.12)
        return 4 + (28 * pattern[index] * visibleLevel)
    }
}
