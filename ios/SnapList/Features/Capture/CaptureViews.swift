import ImageIO
import PhotosUI
import SwiftUI
import UIKit

extension PhotosPickerItem: CaptureLibraryPhotoLoading {
    func loadPhotoData() async throws -> Data? {
        try await loadTransferable(type: Data.self)
    }
}

struct CaptureLauncherSheet: View {
    @Bindable var flow: CaptureFlowModel
    let takeOneItem: () -> Void
    let showCapturedPhoto: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var libraryItem: PhotosPickerItem?

    var body: some View {
        VStack(spacing: 0) {
            Capsule()
                .fill(SnapListColorToken.dragHandle.color)
                .frame(width: 38, height: 5)
                .padding(.top, 8)

            HStack {
                Spacer()
                Text("Add an item")
                    .snapListTypography(.sectionHeader)
                    .accessibilityIdentifier("sheet.capture.title")
                Spacer()
            }
            .overlay(alignment: .leading) {
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 15, weight: .semibold))
                        .frame(
                            width: 48,
                            height: 48
                        )
                        .background(SnapListColorToken.groupingFill.color)
                        .clipShape(.circle)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close add item sheet")
                .accessibilityIdentifier("capture.close")
            }
            .padding(.horizontal, SnapListMetrics.screenGutter)
            .padding(.top, 6)

            ScrollView {
                if flow.stagedPhoto != nil {
                    restoredDraft
                } else {
                    freshCaptureOptions
                }
            }
            .scrollIndicators(.hidden)
        }
        .background(SnapListColorToken.canvas.color)
        .presentationDragIndicator(.hidden)
        .presentationCornerRadius(SnapListMetrics.sheetRadius)
        .presentationDetents([.height(640)])
        .onChange(of: libraryItem) { _, item in
            guard let item else { return }
            Task {
                if await flow.stageLibraryPhotos([item]) == 1 {
                    showCapturedPhoto()
                    dismiss()
                }
            }
        }
    }

    private var restoredDraft: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 12) {
                LocalCaptureImage(
                    url: flow.stagedPhoto?.thumbnailURL,
                    maximumPixelSize: 240
                )
                .scaledToFill()
                .frame(width: 64, height: 64)
                .clipShape(.rect(cornerRadius: 14))

                VStack(alignment: .leading, spacing: 4) {
                    Text("\(flow.stagedPhotos.count) of 5 photos saved")
                        .snapListTypography(.rowTitle)
                    Text("Your staged photo is ready to continue.")
                        .font(.caption)
                        .foregroundStyle(SnapListColorToken.textSecondary.color)
                }
            }

            SnapListPrimaryButton(title: "Resume captured photo") {
                showCapturedPhoto()
                dismiss()
            }
            .accessibilityHint("Returns to the staged photo without replacing it")

            CaptureIconCaption(
                systemImage: "clock",
                text: "This photo stays on this device for up to 24 hours."
            )
        }
        .padding(.horizontal, SnapListMetrics.screenGutter)
        .padding(.top, 18)
        .padding(.bottom, 24)
    }

    private var freshCaptureOptions: some View {
        VStack(alignment: .leading, spacing: 14) {
            Button(action: takeOneItem) {
                CaptureOptionRow(entryPoint: .takeOneItem, isPrimary: true)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Take one item, recommended")
            .accessibilityHint("Opens the guided camera")
            .accessibilityIdentifier(CaptureEntryPoint.takeOneItem.identifier)

            Text("Other ways to add")
                .font(.caption2.weight(.semibold))
                .textCase(.uppercase)
                .tracking(0.5)
                .foregroundStyle(SnapListColorToken.textTertiary.color)

            VStack(spacing: 0) {
                PhotosPicker(selection: $libraryItem, matching: .images) {
                    CaptureOptionRow(entryPoint: .chooseFromLibrary)
                }
                .buttonStyle(.plain)
                .frame(maxWidth: .infinity, minHeight: 60)
                .contentShape(.rect)
                .accessibilityElement(children: .combine)
                .accessibilityLabel(CaptureEntryPoint.chooseFromLibrary.title)
                .accessibilityIdentifier(CaptureEntryPoint.chooseFromLibrary.identifier)
            }

            CaptureIconCaption(
                systemImage: "info.circle",
                text: "Capture and organize photos before choosing what to list."
            )
        }
        .padding(.horizontal, SnapListMetrics.screenGutter)
        .padding(.top, 10)
        .padding(.bottom, 18)
    }
}

/// Every way the capture surface lets a seller start an item. The lean MVP offers
/// exactly one primary path and one alternate; anything else is a destination the
/// product decided not to ship, so the set is asserted rather than left implicit.
enum CaptureEntryPoint: String, CaseIterable, Identifiable {
    case takeOneItem
    case chooseFromLibrary

    var id: String { rawValue }

    var identifier: String {
        switch self {
        case .takeOneItem: "capture.take-one-item"
        case .chooseFromLibrary: "capture.choose-library"
        }
    }

    var title: String {
        switch self {
        case .takeOneItem: "Take one item"
        case .chooseFromLibrary: "Choose from library"
        }
    }

    var subtitle: String {
        switch self {
        case .takeOneItem: "Snap one thing and get help listing it."
        case .chooseFromLibrary: "Use photos you already have."
        }
    }

    var systemImage: String {
        switch self {
        case .takeOneItem: "camera"
        case .chooseFromLibrary: "photo"
        }
    }
}

/// An icon and a caption, composed by hand rather than through
/// `Label(_:systemImage:)`.
///
/// `Label`'s internal composition truncated the caption to a single ellipsized
/// line at AX5 even with `.frame(maxWidth: .infinity)` and `.fixedSize` applied
/// — a plain `Text` wraps correctly at the identical width in the identical
/// `ScrollView`, so the constraint is internal to `Label` rather than the
/// surrounding layout (#831). Three sites had their own copy of the
/// replacement and the CAP-01 fixture still had the `Label` (#839).
struct CaptureIconCaption: View {
    let systemImage: String
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: systemImage)
            Text(text)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.caption)
        .foregroundStyle(SnapListColorToken.textTertiary.color)
    }
}

private struct CaptureOptionRow: View {
    let entryPoint: CaptureEntryPoint
    var isPrimary = false

    private var title: String { entryPoint.title }
    private var subtitle: String { entryPoint.subtitle }
    private var systemImage: String { entryPoint.systemImage }
    private var badge: String? { isPrimary ? "Recommended" : nil }

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: systemImage)
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(
                    isPrimary ? SnapListColorToken.onDarkSurface.color : SnapListColorToken.textSecondary.color
                )
                .frame(width: 42, height: 42)
                .background(
                    isPrimary
                        ? SnapListColorToken.action.color
                        : SnapListColorToken.groupingFill.color
                )
                .clipShape(.rect(cornerRadius: 11))

            VStack(alignment: .leading, spacing: 3) {
                // Without `.fixedSize(horizontal: false, vertical: true)`, this
                // HStack's width negotiation against its icon and chevron
                // siblings truncates the title to a single ellipsized line at
                // the largest accessibility Dynamic Type sizes instead of
                // wrapping — the same fix `restoredDraft` and the info `Label`
                // below already apply to their own multi-line text (#831).
                HStack(spacing: 7) {
                    Text(title)
                        .snapListTypography(.rowTitle)
                        .foregroundStyle(SnapListColorToken.inkPrimary.color)
                        .fixedSize(horizontal: false, vertical: true)
                    if let badge {
                        Text(badge.uppercased())
                            .font(.system(size: 9, weight: .bold))
                            .tracking(0.4)
                            .foregroundStyle(SnapListColorToken.action.color)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(SnapListColorToken.infoChipFill.color)
                            .clipShape(.capsule)
                            .fixedSize()
                    }
                }
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(SnapListColorToken.textTertiary.color)
        }
        .padding(.horizontal, isPrimary ? 10 : 8)
        .frame(minHeight: isPrimary ? 64 : 60)
        .background(isPrimary ? SnapListColorToken.subtleActionFill.color : SnapListColorToken.canvas.color)
        .clipShape(.rect(cornerRadius: isPrimary ? 14 : 0))
        .overlay {
            if isPrimary {
                RoundedRectangle(cornerRadius: 14)
                    .stroke(SnapListColorToken.action.color.opacity(0.65), lineWidth: 1)
            }
        }
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }
}


struct ScanCameraView: View {
    @Bindable var flow: CaptureFlowModel
    @Binding var returnFocus: PhotoReviewScanFocus?
    let closeCapture: () -> Void
    let openBoundary: (
        CaptureBoundaryDestination,
        [StagedCapturePhoto],
        CaptureBoundaryOpener
    ) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @AccessibilityFocusState private var focusedLibraryControl:
        ScanLibraryFocusConsumer.MountedLibraryControl?
    @State private var libraryItems: [PhotosPickerItem] = []

    var body: some View {
        Group {
            switch flow.phase {
            case .camera, .captured, .reviewHandoff:
                liveSurface
            case .unavailable:
                recoverySurface(mode: .unavailable)
            case .denied:
                recoverySurface(mode: .denied)
            case .failed:
                liveSurface
            case .idle, .requestingPermission:
                ZStack {
                    SnapListColorToken.cameraSurface.color.ignoresSafeArea()
                    ProgressView()
                        .tint(SnapListColorToken.onDarkSurface.color)
                        .accessibilityLabel("Preparing camera")
                }
            }
        }
        .onChange(of: scenePhase) { _, next in
            flow.handleScenePhase(next)
            if next == .active {
                Task { await flow.handleSceneBecameActive() }
            }
        }
        .onChange(of: libraryItems) { _, items in
            guard !items.isEmpty else { return }
            guard let intakeID = flow.reserveLibraryIntake() else {
                libraryItems = []
                return
            }
            Task {
                _ = await flow.stageLibraryPhotos(items, reservation: intakeID)
                libraryItems = []
            }
        }
        .onChange(of: flow.stagedPhotos.count) { _, _ in
            guard let announcement = flow.consumePhotoLimitAnnouncement() else { return }
            UIAccessibility.post(notification: .announcement, argument: announcement)
        }
    }

    private var liveSurface: some View {
        LiveScanCameraSurface(
            thumbnailURLs: flow.stagedPhotos.map { Optional($0.thumbnailURL) },
            photoIDs: flow.stagedPhotos.map(\.id),
            isShutterEnabled: flow.canTakePhoto,
            isLibraryEnabled: flow.canOpenLibrary,
            isFlashAvailable: flow.isFlashAvailable,
            flashMode: flow.flashMode,
            reduceMotion: reduceMotion,
            motionStateIdentifier: nil,
            fixturePreviewDescription: nil,
            preview: {
                CameraPreviewView(
                    session: flow.previewSession,
                    device: flow.captureDevice
                )
            },
            libraryControl: { libraryPicker(labelStyle: .icon) },
            toggleFlash: flow.toggleFlash,
            takePhoto: {
                guard let captureID = flow.reservePhotoCapture() else { return }
                Task { await flow.takePhoto(reservation: captureID) }
            },
            close: closeLiveCameraPreview,
            returnFocus: $returnFocus,
            review: { open(.photoReview, opener: .reviewButton) },
            removePhoto: { id in Task { await flow.removeStagedPhoto(id: id) } }
        )
    }

    private func closeLiveCameraPreview() {
        flow.cancelCamera()
        closeCapture()
    }

    private func recoverySurface(mode: ScanCameraRecoveryMode) -> some View {
        RecoveryScanCameraSurface(
            mode: mode,
            thumbnailURLs: flow.stagedPhotos.map { Optional($0.thumbnailURL) },
            photoIDs: flow.stagedPhotos.map(\.id),
            reduceMotion: reduceMotion,
            libraryControl: { libraryPicker(labelStyle: .recovery) },
            returnFocus: $returnFocus,
            review: { open(.photoReview, opener: .reviewButton) },
            openSettings: {
                guard let settingsURL = URL(string: UIApplication.openSettingsURLString) else {
                    return
                }
                openURL(settingsURL)
            },
            removePhoto: { id in Task { await flow.removeStagedPhoto(id: id) } }
        )
    }

    private func libraryPicker(labelStyle: ScanLibraryLabelStyle) -> some View {
        let isLibraryEnabled = flow.canOpenLibrary
        let mountedControl: ScanLibraryFocusConsumer.MountedLibraryControl =
            switch labelStyle {
            case .icon:
                .liveLibrary
            case .recovery:
                .recoveryLibrary
            }

        return ScanLibraryPicker(
            style: labelStyle,
            selection: $libraryItems,
            maxSelectionCount: max(1, 5 - flow.stagedPhotos.count),
            isEnabled: isLibraryEnabled
        )
        .accessibilitySortPriority(60)
        .accessibilityFocused(
            $focusedLibraryControl,
            equals: mountedControl
        )
        .onAppear {
            consumeLibraryFocusIfPossible(mountedControl)
        }
        .onChange(of: returnFocus) { _, _ in
            consumeLibraryFocusIfPossible(mountedControl)
        }
    }

    private func consumeLibraryFocusIfPossible(
        _ mountedControl: ScanLibraryFocusConsumer.MountedLibraryControl
    ) {
        ScanLibraryFocusConsumer().consume(
            pendingFocus: returnFocus,
            mountedControl: mountedControl,
            applyAccessibilityFocus: { focusedLibraryControl = $0 },
            consumePendingFocus: { returnFocus = nil }
        )
    }

    private func open(
        _ destination: CaptureBoundaryDestination,
        opener: CaptureBoundaryOpener
    ) {
        guard flow.canOpenBoundary else { return }
        let photos = flow.stagedPhotos
        flow.cancelCamera()
        openBoundary(destination, photos, opener)
    }
}

struct ScanLibraryFocusConsumer {
    enum MountedLibraryControl: Hashable {
        case liveLibrary
        case recoveryLibrary
    }

    func consume(
        pendingFocus: PhotoReviewScanFocus?,
        mountedControl: MountedLibraryControl?,
        applyAccessibilityFocus: (MountedLibraryControl) -> Void,
        consumePendingFocus: () -> Void
    ) {
        guard pendingFocus == .addPhotoButton, let mountedControl else {
            return
        }
        applyAccessibilityFocus(mountedControl)
        consumePendingFocus()
    }
}

private enum ScanCameraRecoveryMode: Equatable {
    case unavailable
    case denied

    var title: String {
        switch self {
        case .unavailable: "Camera is not available"
        case .denied: "SnapList cannot use the camera"
        }
    }

    var body: String {
        switch self {
        case .unavailable: "Add photos from your library instead."
        case .denied: "Allow camera access in Settings, or add photos from your library."
        }
    }
}

enum ScanLibraryLabelStyle {
    case icon
    case recovery
}

/// The library opener, isolated from `ScanCameraView`'s focus/state wiring so a unit test
/// can render it alone and inspect its resolved button style (#856), the same technique
/// `LegalLinkRow` uses.
struct ScanLibraryPicker: View {
    let style: ScanLibraryLabelStyle
    @Binding var selection: [PhotosPickerItem]
    let maxSelectionCount: Int
    let isEnabled: Bool

    var body: some View {
        PhotosPicker(
            selection: $selection,
            maxSelectionCount: maxSelectionCount,
            selectionBehavior: .ordered,
            matching: .images
        ) {
            ScanLibraryLabel(style: style)
        }
        // `PhotosPicker` resolves a button style the same way `Button` does, so
        // an `.automatic` picker gets a filled shape under Button Shapes on top
        // of the circle or capsule `ScanLibraryLabel` already draws (#856).
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .accessibilityLabel(style == .icon ? "Library" : "Choose from library")
        .accessibilityIdentifier(
            style == .icon ? "scan.library" : "scan.choose-library"
        )
    }
}

private struct ScanLibraryLabel: View {
    let style: ScanLibraryLabelStyle

    var body: some View {
        Group {
            switch style {
            case .icon:
                Image(systemName: "photo")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(SnapListColorToken.onDarkSurface.color)
                    .frame(width: 48, height: 48)
                    .background(SnapListColorToken.cameraControlFill.color.opacity(0.66))
                    .overlay { Circle().stroke(SnapListColorToken.onDarkSurface.color.opacity(0.12), lineWidth: 1) }
                    .clipShape(.circle)
            case .recovery:
                Text("Choose from library")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(SnapListColorToken.onDarkSurface.color)
                    .padding(.horizontal, 22)
                    .frame(minWidth: 210, minHeight: 48)
                    .background(SnapListColorToken.action.color)
                    .clipShape(.rect(cornerRadius: 14))
            }
        }
        .accessibilityLabel(style == .icon ? "Library" : "Choose from library")
        .accessibilityIdentifier(style == .icon ? "scan.library" : "scan.choose-library")
    }
}

struct ScanShutterAccessibility {
    let durablePhotoCount: Int

    var label: String {
        durablePhotoCount >= 5
            ? "Take photo, unavailable at five photo limit"
            : "Take photo"
    }
}

enum ScanReviewAccessibilityPriority: String, CaseIterable {
    case live
    case recovery

    var value: Double {
        switch self {
        case .live, .recovery:
            40
        }
    }
}

private enum ScanReviewFocusTarget: Hashable {
    case reviewButton
}

/// The Review opener, expressed once for both Scan camera surfaces.
///
/// The live and recovery surfaces show the same control with the same styling, the same
/// count-sensitive name, the same identifier, and the same accessibility-focus handoff back
/// from Photo Review. Each surface still supplies its own sort-priority case, which is the one
/// input that is allowed to differ, even though `.live` and `.recovery` both resolve to 40 today.
///
/// Not `private`: a unit test renders it alone to inspect its resolved button style (#856).
struct ScanReviewButton: View {
    let photoCount: Int
    let priority: ScanReviewAccessibilityPriority
    @Binding var returnFocus: PhotoReviewScanFocus?
    let review: () -> Void

    @AccessibilityFocusState private var focusedScanControl: ScanReviewFocusTarget?

    var body: some View {
        Button("Review", action: review)
            // The capsule below is this control's whole affordance. Left on
            // `.automatic`, iOS paints a second filled shape behind it for a
            // seller with Button Shapes on, which reads as an overlay sitting
            // on the label (#856).
            .buttonStyle(.plain)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(SnapListColorToken.onDarkSurface.color)
            .padding(.horizontal, 18)
            .frame(minHeight: 48)
            .background(SnapListColorToken.action.color)
            .clipShape(.capsule)
            .shadow(color: SnapListColorToken.action.color.opacity(0.28), radius: 12, y: 6)
            .accessibilityLabel(
                photoCount == 1
                    ? "Review 1 photo"
                    : "Review \(photoCount) photos"
            )
            .accessibilityIdentifier("scan.review")
            .accessibilitySortPriority(priority.value)
            .accessibilityFocused(
                $focusedScanControl,
                equals: .reviewButton
            )
            .onAppear(perform: consumeReviewFocusIfPossible)
            .onChange(of: returnFocus) { _, _ in
                consumeReviewFocusIfPossible()
            }
    }

    private func consumeReviewFocusIfPossible() {
        guard ScanReturnFocusPolicy.outcome(
            pendingFocus: returnFocus,
            stagedPhotoCount: photoCount
        ) == .focusReviewOpener else {
            return
        }
        focusedScanControl = .reviewButton
        returnFocus = nil
    }
}

/// What a Scan camera surface should do with a pending Photo Review focus request.
///
/// Scan restores the accessibility cursor, not UIKit first-responder focus, so the
/// decision is kept separate from the view that applies it and is asserted directly.
enum ScanReturnFocusOutcome: Equatable {
    /// Nothing to restore on this surface; leave the pending request untouched.
    case none
    /// Move the accessibility cursor to the Review opener and consume the request.
    case focusReviewOpener
}

enum ScanReturnFocusPolicy {
    static func outcome(
        pendingFocus: PhotoReviewScanFocus?,
        stagedPhotoCount: Int
    ) -> ScanReturnFocusOutcome {
        guard pendingFocus == .reviewButton, stagedPhotoCount > 0 else {
            return .none
        }
        return .focusReviewOpener
    }
}

private struct LiveScanCameraSurface<Preview: View, LibraryControl: View>: View {
    let thumbnailURLs: [URL?]
    let photoIDs: [StagedCapturePhoto.ID]
    let isShutterEnabled: Bool
    let isLibraryEnabled: Bool
    let isFlashAvailable: Bool
    let flashMode: CaptureFlashMode
    let reduceMotion: Bool
    let motionStateIdentifier: String?
    let fixturePreviewDescription: String?
    @ViewBuilder let preview: () -> Preview
    @ViewBuilder let libraryControl: () -> LibraryControl
    let toggleFlash: () -> Void
    let takePhoto: () -> Void
    let close: () -> Void
    @Binding var returnFocus: PhotoReviewScanFocus?
    let review: () -> Void
    let removePhoto: (StagedCapturePhoto.ID) -> Void

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        ZStack {
            preview()
                .ignoresSafeArea()
                .accessibilityHidden(true)

            if let motionStateIdentifier {
                Rectangle()
                    .fill(.clear)
                    .frame(width: 1, height: 1)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Reduced motion active")
                    .accessibilityIdentifier(motionStateIdentifier)
            }

            if let fixturePreviewDescription {
                Color.clear
                    .frame(width: 1, height: 1)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(fixturePreviewDescription)
                    .accessibilityIdentifier("scan.fixture-preview")
                    .accessibilitySortPriority(10)
            }

            VStack(spacing: 0) {
                HStack {
                    closeButton
                    Spacer()
                    flashButton
                }
                .padding(.horizontal, 18)
                .padding(.top, 8)

                Spacer(minLength: 20)

                if !thumbnailURLs.isEmpty {
                    photoProgress
                        .padding(.bottom, dynamicTypeSize.isAccessibilitySize ? 38 : 28)
                        .transition(
                            reduceMotion
                                ? .identity
                                : .opacity.combined(with: .offset(y: 10))
                        )
                }

                cameraControls
                    .frame(height: dynamicTypeSize.isAccessibilitySize ? 96 : 80)
            }
            .safeAreaPadding(.top, 2)
            .safeAreaPadding(.bottom, 30)
        }
        .background(SnapListColorToken.cameraSurface.color.ignoresSafeArea())
        .animation(
            reduceMotion ? nil : .easeOut(duration: 0.18),
            value: thumbnailURLs.count
        )
    }

    private var closeButton: some View {
        Button(action: close) {
            Image(systemName: "xmark")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(SnapListColorToken.onDarkSurface.color)
                .frame(width: 44, height: 44)
                .background(SnapListColorToken.cameraControlFill.color.opacity(0.66))
                .overlay { Circle().stroke(SnapListColorToken.onDarkSurface.color.opacity(0.12), lineWidth: 1) }
                .clipShape(.circle)
                .accessibilityHidden(true)
        }
        .buttonStyle(.plain)
        .frame(width: 48, height: 48)
        .contentShape(.circle)
        .accessibilityLabel("Close camera")
        .accessibilityHint("Leaves capture and returns to Home")
        .accessibilityIdentifier("scan.close")
        .accessibilitySortPriority(80)
    }

    private var flashButton: some View {
        Button(action: toggleFlash) {
            Image(systemName: flashMode == .on ? "bolt.fill" : "bolt.slash")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(SnapListColorToken.onDarkSurface.color)
                .frame(width: 44, height: 44)
                .background(SnapListColorToken.cameraControlFill.color.opacity(0.66))
                .overlay { Circle().stroke(SnapListColorToken.onDarkSurface.color.opacity(0.12), lineWidth: 1) }
                .clipShape(.circle)
                .accessibilityHidden(true)
        }
        .buttonStyle(.plain)
        .frame(width: 48, height: 48)
        .contentShape(.circle)
        .disabled(!isFlashAvailable)
        .accessibilityLabel(flashMode == .on ? "Flash on" : "Flash off")
        .accessibilityHint(isFlashAvailable ? "Toggles the camera flash" : "Flash is not available")
        .accessibilityIdentifier("scan.flash")
        .accessibilitySortPriority(80)
    }

    private var photoProgress: some View {
        ScanPhotoProgressRow(
            thumbnailURLs: thumbnailURLs,
            photoIDs: photoIDs,
            removePhoto: removePhoto
        )
    }

    private var cameraControls: some View {
        ZStack {
            HStack {
                libraryControl()
                    .disabled(!isLibraryEnabled)
                Spacer()
                if !thumbnailURLs.isEmpty {
                    reviewButton
                        .transition(reduceMotion ? .identity : .opacity)
                } else {
                    Color.clear
                        .frame(width: 82, height: 48)
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, 18)

            Button(action: takePhoto) {
                ZStack {
                    Circle()
                        .stroke(SnapListColorToken.onDarkSurface.color, lineWidth: 3)
                        .frame(width: 72, height: 72)
                    Circle()
                        .fill(SnapListColorToken.onDarkSurface.color)
                        .frame(width: 56, height: 56)
                }
                .frame(width: 72, height: 72)
            }
            .buttonStyle(.plain)
            .disabled(!isShutterEnabled)
            .opacity(isShutterEnabled ? 1 : 0.5)
            .accessibilityLabel(
                ScanShutterAccessibility(
                    durablePhotoCount: thumbnailURLs.count
                ).label
            )
            .accessibilityIdentifier("scan.shutter")
            .accessibilitySortPriority(50)
        }
    }

    private var reviewButton: some View {
        ScanReviewButton(
            photoCount: thumbnailURLs.count,
            priority: .live,
            returnFocus: $returnFocus,
            review: review
        )
    }
}

private struct RecoveryScanCameraSurface<LibraryControl: View>: View {
    let mode: ScanCameraRecoveryMode
    let thumbnailURLs: [URL?]
    let photoIDs: [StagedCapturePhoto.ID]
    let reduceMotion: Bool
    @ViewBuilder let libraryControl: () -> LibraryControl
    @Binding var returnFocus: PhotoReviewScanFocus?
    let review: () -> Void
    let openSettings: () -> Void
    let removePhoto: (StagedCapturePhoto.ID) -> Void

    var body: some View {
        ZStack {
            SnapListColorToken.cameraSurface.color.ignoresSafeArea()

            VStack(spacing: 0) {
                Spacer()
                VStack(spacing: 14) {
                    Image(systemName: "camera.fill")
                        .font(.system(size: 39, weight: .regular))
                        .foregroundStyle(SnapListColorToken.onDarkSurface.color.opacity(0.85))
                        .frame(width: 52, height: 52)
                        .overlay {
                            Capsule()
                                .fill(SnapListColorToken.onDarkSurface.color.opacity(0.85))
                                .frame(width: 2, height: 62)
                                .rotationEffect(.degrees(-45))
                        }
                        .accessibilityHidden(true)
                    Text(mode.title)
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(SnapListColorToken.onDarkSurface.color)
                        .multilineTextAlignment(.center)
                        .accessibilityIdentifier("scan.recovery-title")
                    Text(mode.body)
                        .font(.subheadline)
                        .foregroundStyle(SnapListColorToken.onDarkSurface.color.opacity(0.78))
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                    VStack(spacing: 6) {
                        libraryControl()
                        if mode == .denied {
                            Button("Open Settings", action: openSettings)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(SnapListColorToken.settingsLinkOnDark.color)
                                .padding(.horizontal, 16)
                                .frame(minWidth: 44, minHeight: 44)
                                .accessibilityIdentifier("scan.open-settings")
                        }
                    }
                    .padding(.top, 6)
                }
                .padding(.horizontal, 32)
                Spacer()
                if !thumbnailURLs.isEmpty {
                    VStack(spacing: 10) {
                        ScanPhotoProgressRow(
                            thumbnailURLs: thumbnailURLs,
                            photoIDs: photoIDs,
                            removePhoto: removePhoto
                        )
                        ScanReviewButton(
                            photoCount: thumbnailURLs.count,
                            priority: .recovery,
                            returnFocus: $returnFocus,
                            review: review
                        )
                    }
                    .padding(.bottom, 10)
                    .transition(
                        reduceMotion
                            ? .identity
                            : .opacity.combined(with: .offset(y: 10))
                    )
                }
            }
            .safeAreaPadding(.vertical, 2)
        }
        .animation(
            reduceMotion ? nil : .easeOut(duration: 0.18),
            value: thumbnailURLs.count
        )
    }
}

private struct ScanPhotoProgressRow: View {
    let thumbnailURLs: [URL?]
    let photoIDs: [StagedCapturePhoto.ID]
    let removePhoto: (StagedCapturePhoto.ID) -> Void

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            HStack(spacing: 11) {
                ForEach(Array(thumbnailURLs.enumerated()), id: \.offset) { index, url in
                    ScanPhotoThumbnail(
                        url: url,
                        index: index,
                        count: thumbnailURLs.count,
                        remove: {
                            guard photoIDs.indices.contains(index) else { return }
                            removePhoto(photoIDs[index])
                        }
                    )
                }
            }
            Spacer(minLength: 8)
            Text("\(thumbnailURLs.count) of 5")
                .font(.caption.weight(.semibold))
                .foregroundStyle(SnapListColorToken.onDarkSurface.color)
                .padding(.horizontal, 15)
                .frame(minWidth: 60, minHeight: 34)
                .background(SnapListColorToken.cameraControlFill.color.opacity(0.66))
                .clipShape(.capsule)
                .accessibilityIdentifier("scan.photo-count")
                .accessibilitySortPriority(69)
        }
        .padding(.horizontal, 15)
    }
}

private struct ScanPhotoThumbnail: View {
    let url: URL?
    let index: Int
    let count: Int
    let remove: () -> Void

    var body: some View {
        Group {
            if let url {
                LocalCaptureImage(url: url, maximumPixelSize: 160)
                    .scaledToFill()
            } else {
                ScanPhotoPlaceholder()
            }
        }
        .frame(width: 34, height: 43)
        .clipShape(.rect(cornerRadius: 6))
        .overlay { RoundedRectangle(cornerRadius: 6).stroke(SnapListColorToken.onDarkSurface.color.opacity(0.9), lineWidth: 1) }
        .shadow(color: .black.opacity(0.28), radius: 4, y: 3)
        .accessibilityIdentifier("scan.photo-\(index + 1)")
        .accessibilityLabel("Photo \(index + 1) of \(count)")
        .accessibilitySortPriority(70)
        .overlay(alignment: .topTrailing) {
            removeButton.offset(x: 10, y: -10)
        }
    }

    private var removeButton: some View {
        Button(action: remove) {
            Image(systemName: "xmark")
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(SnapListColorToken.onDarkSurface.color)
                .frame(width: 18, height: 18)
                .background(SnapListColorToken.inkPrimary.color)
                .overlay { Circle().stroke(SnapListColorToken.onDarkSurface.color.opacity(0.9), lineWidth: 1) }
                .clipShape(.circle)
                .accessibilityHidden(true)
        }
        .buttonStyle(.plain)
        .frame(width: 44, height: 44)
        .contentShape(.circle)
        .accessibilityLabel("Remove photo \(index + 1)")
        .accessibilityIdentifier("scan.photo-\(index + 1).remove")
        .accessibilitySortPriority(71)
    }
}

private struct ScanPhotoPlaceholder: View {
    var body: some View {
        Canvas { context, size in
            context.fill(
                Path(CGRect(origin: .zero, size: size)),
                with: .color(SnapListColorToken.neutralOutline.color)
            )

            for offset in stride(from: -size.height, through: size.width, by: 11) {
                var stripe = Path()
                stripe.move(to: CGPoint(x: offset, y: size.height))
                stripe.addLine(to: CGPoint(x: offset + size.height, y: 0))
                context.stroke(
                    stripe,
                    with: .color(SnapListColorToken.placeholderStripe.color.opacity(0.72)),
                    lineWidth: 5
                )
            }
        }
        .accessibilityHidden(true)
    }
}

#if DEBUG
/// A stable visual stand-in for the simulator-only camera route. It intentionally
/// has no subject or image content so it cannot be mistaken for device camera output.
private struct ScanCameraFixturePreview: View {
    var body: some View {
        SnapListColorToken.cameraFixturePreview.color
            .ignoresSafeArea()
            .accessibilityHidden(true)
    }
}

struct ScanCameraVisualStateView: View {
    let state: ApprovedVisualStateID
    let forceReducedMotion: Bool

    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion

    private var reduceMotion: Bool { forceReducedMotion || systemReduceMotion }

    /// The fixture route renders a camera surface without the app shell, so it
    /// floats the approved dock itself. Scan is a primary destination, so a
    /// capture of it that carried no dock would not be the screen the product
    /// ships. Selection is inert here because the fixture has no router, which
    /// is what the retired per-camera dock did in this route too.
    var body: some View {
        surface.floatingDock(selectedTab: .scan, select: { _ in })
    }

    @ViewBuilder
    private var surface: some View {
        switch state {
        case .scanCameraUnavailable:
            RecoveryScanCameraSurface(
                mode: .unavailable,
                thumbnailURLs: [],
                photoIDs: [],
                reduceMotion: reduceMotion,
                libraryControl: {
                    Button(action: {}) { ScanLibraryLabel(style: .recovery) }
                        .buttonStyle(.plain)
                },
                returnFocus: .constant(nil),
                review: {},
                openSettings: {},
                removePhoto: { _ in },
            )
        case .scanCameraDenied:
            RecoveryScanCameraSurface(
                mode: .denied,
                thumbnailURLs: [],
                photoIDs: [],
                reduceMotion: reduceMotion,
                libraryControl: {
                    Button(action: {}) { ScanLibraryLabel(style: .recovery) }
                        .buttonStyle(.plain)
                },
                returnFocus: .constant(nil),
                review: {},
                openSettings: {},
                removePhoto: { _ in },
            )
        default:
            LiveScanCameraSurface(
                thumbnailURLs: Array(repeating: nil, count: fixturePhotoCount),
                photoIDs: [],
                isShutterEnabled: fixturePhotoCount < 5,
                isLibraryEnabled: fixturePhotoCount < 5,
                isFlashAvailable: true,
                flashMode: .off,
                reduceMotion: reduceMotion,
                motionStateIdentifier: reduceMotion ? "scan.motion-reduced" : nil,
                fixturePreviewDescription: "Simulator camera fixture. No live camera feed.",
                preview: { ScanCameraFixturePreview() },
                libraryControl: {
                    Button(action: {}) { ScanLibraryLabel(style: .icon) }
                        .buttonStyle(.plain)
                },
                toggleFlash: {},
                takePhoto: {},
                close: {},
                returnFocus: .constant(nil),
                review: {},
                removePhoto: { _ in },
            )
        }
    }

    private var fixturePhotoCount: Int {
        switch state {
        case .scanCameraPhotos: 3
        case .scanCameraCapped: 5
        default: 0
        }
    }
}
#endif

struct LocalCaptureImage: View {
    let url: URL?
    let maximumPixelSize: Int

    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .accessibilityLabel("Staged item photo")
            } else {
                SnapListColorToken.imagePlaceholderFill.color
                    .overlay {
                        Image(systemName: "photo")
                            .foregroundStyle(SnapListColorToken.textTertiary.color)
                    }
                    .accessibilityLabel("Staged item photo is loading")
            }
        }
        .task(id: url) {
            guard let url else {
                image = nil
                return
            }
            image = await LocalCaptureImageLoader.shared.load(
                url: url,
                maximumPixelSize: maximumPixelSize
            )
        }
    }
}

private actor LocalCaptureImageLoader {
    static let shared = LocalCaptureImageLoader()

    private let cache = NSCache<NSString, UIImage>()

    init() {
        cache.countLimit = 4
        cache.totalCostLimit = 24 * 1024 * 1024
    }

    func load(url: URL, maximumPixelSize: Int) -> UIImage? {
        let key = "\(url.path)#\(maximumPixelSize)" as NSString
        if let cached = cache.object(forKey: key) {
            return cached
        }
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let cgImage = CGImageSourceCreateThumbnailAtIndex(
                  source,
                  0,
                  [
                      kCGImageSourceCreateThumbnailFromImageAlways: true,
                      kCGImageSourceCreateThumbnailWithTransform: true,
                      kCGImageSourceThumbnailMaxPixelSize: maximumPixelSize
                  ] as CFDictionary
              ) else {
            return nil
        }
        let loaded = UIImage(cgImage: cgImage)
        cache.setObject(
            loaded,
            forKey: key,
            cost: cgImage.bytesPerRow * cgImage.height
        )
        return loaded
    }
}

private struct FramingCorners: View {
    let length: CGFloat

    init(length: CGFloat = 24) {
        self.length = length
    }

    var body: some View {
        Canvas { context, size in
            let lineWidth: CGFloat = 2
            let color = SnapListColorToken.onDarkSurface.color.opacity(0.86)
            var path = Path()

            path.move(to: CGPoint(x: 0, y: length))
            path.addLine(to: CGPoint(x: 0, y: 0))
            path.addLine(to: CGPoint(x: length, y: 0))
            path.move(to: CGPoint(x: size.width - length, y: 0))
            path.addLine(to: CGPoint(x: size.width, y: 0))
            path.addLine(to: CGPoint(x: size.width, y: length))
            path.move(to: CGPoint(x: size.width, y: size.height - length))
            path.addLine(to: CGPoint(x: size.width, y: size.height))
            path.addLine(to: CGPoint(x: size.width - length, y: size.height))
            path.move(to: CGPoint(x: length, y: size.height))
            path.addLine(to: CGPoint(x: 0, y: size.height))
            path.addLine(to: CGPoint(x: 0, y: size.height - length))

            context.stroke(path, with: .color(color), lineWidth: lineWidth)
        }
    }
}

private struct ResponsiveFramingCorners: View {
    var body: some View {
        GeometryReader { proxy in
            let isCompactHeight = proxy.size.height <= 700
            let horizontalInset: CGFloat = proxy.size.width <= 375 ? 28 : 34
            let topInset: CGFloat = isCompactHeight ? 112 : 140
            let bottomInset: CGFloat = isCompactHeight ? 264 : 300
            FramingCorners(length: isCompactHeight ? 24 : 30)
                .frame(
                    width: max(180, proxy.size.width - (horizontalInset * 2)),
                    height: max(140, proxy.size.height - topInset - bottomInset)
                )
                .position(
                    x: proxy.size.width / 2,
                    y: topInset + ((proxy.size.height - topInset - bottomInset) / 2)
                )
        }
    }
}

#if DEBUG
struct CaptureVisualStateView: View {
    let state: ApprovedVisualStateID

    var body: some View {
        switch state {
        case .captureLauncher:
            ZStack(alignment: .bottom) {
                CaptureFixtureHomeBackdrop()
                SnapListColorToken.scrimOverlay.color.opacity(0.42).ignoresSafeArea()
                CaptureLauncherFixture()
            }
        case .captureCoaching:
            CameraFixtureSurface(guidance: .coaching, captured: false)
        case .captureMoveCloser:
            CameraFixtureSurface(guidance: .moveCloser, captured: false)
        case .captureAccepted:
            CameraFixtureSurface(guidance: .accepted, captured: false)
        case .captureOnePhoto:
            CameraFixtureSurface(guidance: .accepted, captured: true)
        case .captureReviewHandoff:
            CaptureHandoffFixture()
        default:
            VisualStateBoundaryPlaceholder(state: state)
        }
    }
}

private struct CaptureFixtureHomeBackdrop: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("SnapList").snapListTypography(.wordmark)
            Text("3 things need you").snapListTypography(.displayTitle)
            Text("Ship an order, answer a buyer, fix a listing.")
                .snapListTypography(.body)
                .foregroundStyle(SnapListColorToken.textSecondary.color)
            Text("Needs your attention").snapListTypography(.sectionHeader).padding(.top, 12)
            ForEach(["Ship sold headphones", "Reply to buyer", "Fix listing details"], id: \.self) { title in
                HStack {
                    RoundedRectangle(cornerRadius: 11)
                        .fill(SnapListColorToken.groupingFill.color)
                        .frame(width: 52, height: 52)
                    Text(title).snapListTypography(.rowTitle)
                    Spacer()
                    Image(systemName: "chevron.right")
                }
                .padding(12)
                .overlay { RoundedRectangle(cornerRadius: 16).stroke(SnapListColorToken.hairline.color) }
            }
            Spacer()
        }
        .padding(.horizontal, 20)
        .padding(.top, 58)
        .background(SnapListColorToken.canvas.color)
        .accessibilityIdentifier("visual.capture.home-preserved")
    }
}

private struct CaptureLauncherFixture: View {
    var body: some View {
        VStack(spacing: 0) {
            Capsule().fill(SnapListColorToken.dragHandle.color).frame(width: 38, height: 5).padding(.top, 8)
            HStack {
                Image(systemName: "xmark")
                    .frame(width: 44, height: 44)
                    .background(SnapListColorToken.groupingFill.color)
                    .clipShape(.circle)
                Spacer()
                Text("Add an item").snapListTypography(.sectionHeader)
                Spacer()
                Color.clear.frame(width: 44, height: 44)
            }
            .padding(.horizontal, 20)
            CaptureOptionRow(entryPoint: .takeOneItem, isPrimary: true)
                .padding(.horizontal, 20)
            Text("Other ways to add")
                .font(.caption2.weight(.semibold))
                .textCase(.uppercase)
                .foregroundStyle(SnapListColorToken.textTertiary.color)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 20)
                .padding(.top, 14)
            ForEach(CaptureEntryPoint.allCases.filter { $0 != .takeOneItem }) { entryPoint in
                CaptureOptionRow(entryPoint: entryPoint)
                    .padding(.horizontal, 20)
            }
            // The production sheet's own caption, not a `Label` restatement of
            // it: `Label`'s internal icon+text composition truncates to one
            // ellipsized line at an accessibility size, which is exactly the
            // defect #831 removed from the shipped surface and this fixture
            // then kept standing in for it (#839).
            CaptureIconCaption(
                systemImage: "info.circle",
                text: "Capture and organize photos before choosing what to list."
            )
            .padding(.horizontal, 20)
            .padding(.top, 6)
            .padding(.bottom, 14)
        }
        // 680pt is the sheet's resting height, not a box its content is
        // clipped into: a fixed height proposes a size without clipping, so at
        // an accessibility size the rows drew past it and the fixture stopped
        // standing for the row it exists to show (#839).
        .frame(minHeight: 680, alignment: .top)
        .background(SnapListColorToken.canvas.color)
        .clipShape(.rect(topLeadingRadius: 26, topTrailingRadius: 26))
        .accessibilityIdentifier("visual-state.CAP-01")
    }
}

private struct CameraFixtureSurface: View {
    let guidance: FramingGuidance
    let captured: Bool

    var body: some View {
        ZStack {
            FixtureItemScene(subjectScale: guidance == .moveCloser ? 0.38 : 1.25)
            LinearGradient(
                colors: [.black.opacity(0.3), .clear, .black.opacity(0.58)],
                startPoint: .top,
                endPoint: .bottom
            )
            ResponsiveFramingCorners()
            VStack {
                HStack {
                    Image(systemName: "xmark")
                        .foregroundStyle(SnapListColorToken.onDarkSurface.color)
                        .frame(width: 44, height: 44)
                        .background(.black.opacity(0.38))
                        .clipShape(.circle)
                    Spacer()
                    Label(captured ? "1 of 4 photos" : "Auto", systemImage: captured ? "photo.stack" : "bolt.slash.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(SnapListColorToken.onDarkSurface.color)
                        .padding(.horizontal, 12)
                        .frame(minHeight: 44)
                        .background(.ultraThinMaterial)
                        .clipShape(.capsule)
                    if captured {
                        Spacer()
                        Image(systemName: "bolt.slash.fill")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(SnapListColorToken.onDarkSurface.color)
                            .frame(width: 44, height: 44)
                            .background(.ultraThinMaterial)
                            .clipShape(.circle)
                    }
                }
                Spacer()
                if captured {
                    capturedFixtureTray
                } else if guidance == .coaching {
                    HStack(alignment: .bottom, spacing: 8) {
                        Image("ScoutCoaching")
                            .resizable().scaledToFit().frame(width: 82, height: 82)
                        Text("Start with one clear photo. Add angles, labels, or damage for a stronger match.")
                            .font(.system(size: 13, weight: .medium))
                            .padding(14).background(SnapListColorToken.onDarkSurface.color).clipShape(.rect(cornerRadius: 16))
                    }
                } else if let cue = guidance.cue {
                    Label(cue, systemImage: guidance.systemImage)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(SnapListColorToken.onDarkSurface.color)
                        .padding(.horizontal, 16)
                        .frame(minHeight: 44)
                        .background(SnapListColorToken.action.color.opacity(0.48))
                        .background(.ultraThinMaterial)
                        .clipShape(.capsule)
                }
                if !captured {
                    Text("Tap the scene to update positioning")
                        .font(.caption).foregroundStyle(SnapListColorToken.onDarkSurface.color.opacity(0.7))
                    HStack {
                        Image(systemName: "photo").foregroundStyle(SnapListColorToken.onDarkSurface.color).frame(width: 44, height: 44)
                        Spacer()
                        Circle().fill(SnapListColorToken.onDarkSurface.color).frame(width: 68, height: 68)
                            .overlay { Circle().stroke(SnapListColorToken.onDarkSurface.color.opacity(0.8), lineWidth: 4).padding(-5) }
                        Spacer()
                        Color.clear.frame(width: 44, height: 44)
                    }
                    .padding(.top, 10)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 58)
            .padding(.bottom, 26)
        }
        .ignoresSafeArea()
        .accessibilityIdentifier("visual-state.\(fixtureID)")
    }

    private var fixtureID: String {
        if captured { return "CAP-02c" }
        return switch guidance {
        case .coaching: "CAP-02a"
        case .moveCloser: "CAP-02b1"
        case .accepted: "CAP-02b2"
        }
    }

    private var capturedFixtureTray: some View {
        HStack(spacing: 10) {
            FixtureItemScene(subjectScale: 0.84)
                .frame(width: 48, height: 48)
                .clipShape(.rect(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 2) {
                Label("Photo added", systemImage: "checkmark.circle.fill")
                    .font(.subheadline.weight(.semibold))
                Text("Add angles, labels, or damage — or continue.").font(.caption)
            }
            Spacer()
            Text("Continue").font(.subheadline.weight(.semibold)).foregroundStyle(SnapListColorToken.onDarkSurface.color)
                .padding(.horizontal, 16).frame(minHeight: 44)
                .background(SnapListColorToken.action.color).clipShape(.capsule)
        }
        .padding(12).background(SnapListColorToken.canvas.color).clipShape(.rect(cornerRadius: 16))
    }
}

private struct FixtureItemScene: View {
    let subjectScale: CGFloat

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                LinearGradient(
                    colors: [SnapListColorToken.groupingFill.color, SnapListColorToken.fixtureSceneGradientEnd.color],
                    startPoint: .top,
                    endPoint: .bottom
                )
                VStack(spacing: 0) {
                    RoundedRectangle(cornerRadius: 10)
                        .fill(SnapListColorToken.fixtureSubjectFill.color)
                        .frame(width: 58, height: 82)
                        .overlay {
                            RoundedRectangle(cornerRadius: 7)
                                .stroke(SnapListColorToken.fixtureSubjectOutline.color, lineWidth: 3)
                                .padding(6)
                        }
                    RoundedRectangle(cornerRadius: 8)
                        .fill(SnapListColorToken.fixtureSubjectShadow.color)
                        .frame(width: 34, height: 74)
                }
                .scaleEffect(subjectScale)
                .position(x: proxy.size.width / 2, y: proxy.size.height * 0.47)
            }
        }
        .accessibilityLabel("Neutral item silhouette in the camera frame")
    }
}

private struct CaptureHandoffFixture: View {
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Image(systemName: "chevron.left").frame(width: 44, height: 44)
                SnapListChip("Handoff · CAP-03", variant: .info)
                Spacer()
            }
                .padding(.horizontal, 12)
            Spacer()
            ZStack(alignment: .bottomTrailing) {
                FixtureItemScene(subjectScale: 0.84)
                    .frame(width: 82, height: 82).clipShape(.rect(cornerRadius: 18))
                    .shadow(color: .black.opacity(0.16), radius: 16, y: 8)
                Text("1").font(.caption2.bold()).foregroundStyle(SnapListColorToken.onDarkSurface.color).frame(width: 22, height: 22)
                    .background(SnapListColorToken.action.color).clipShape(.circle).offset(x: 7, y: 7)
            }
            Text("Photos ready to review").snapListTypography(.cardTitle).padding(.top, 24)
            Text("Your 1 photo is saved. Next you’ll review it and add guidance before pricing — nothing has been analyzed yet.")
                .font(.subheadline).foregroundStyle(SnapListColorToken.textSecondary.color)
                .multilineTextAlignment(.center).padding(.horizontal, 42).padding(.top, 8)
            Label("Open photo review", systemImage: "chevron.right")
                .font(.subheadline.weight(.semibold)).foregroundStyle(SnapListColorToken.onDarkSurface.color)
                .padding(.horizontal, 20).frame(minHeight: 50)
                .background(SnapListColorToken.action.color).clipShape(.capsule).padding(.top, 22)
            Text("Back to camera").font(.subheadline.weight(.semibold))
                .foregroundStyle(SnapListColorToken.action.color).frame(minHeight: 44)
            Label("Prototype bridge only — CAP-03 photo review remains outside this slice.", systemImage: "info.circle")
                .font(.caption).foregroundStyle(SnapListColorToken.textTertiary.color)
                .multilineTextAlignment(.center).padding(.horizontal, 36).padding(.top, 12)
            Spacer()
        }
        .padding(.top, 46).padding(.bottom, 28).background(SnapListColorToken.canvas.color)
        .accessibilityIdentifier("visual-state.CAP-03-handoff")
    }
}
#endif
