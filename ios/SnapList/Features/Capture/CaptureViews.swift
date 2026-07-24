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
                .fill(Color(hex: "#C7C9CD"))
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
        .background(.white)
        .presentationDragIndicator(.hidden)
        .presentationCornerRadius(SnapListMetrics.sheetRadius)
        .presentationDetents([.height(640)])
        .onChange(of: libraryItem) { _, item in
            guard let item else { return }
            Task {
                guard let data = try? await item.loadTransferable(type: Data.self) else {
                    return
                }
                if await flow.stageLibraryPhoto(data) {
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

            Label(
                "This photo stays on this device for up to 24 hours.",
                systemImage: "clock"
            )
            .font(.caption)
            .foregroundStyle(SnapListColorToken.textTertiary.color)
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, SnapListMetrics.screenGutter)
        .padding(.top, 18)
        .padding(.bottom, 24)
    }

    private var freshCaptureOptions: some View {
        VStack(alignment: .leading, spacing: 14) {
            Button(action: takeOneItem) {
                CaptureOptionRow(
                    title: "Take one item",
                    subtitle: "Snap one thing and get help listing it.",
                    systemImage: "camera",
                    isPrimary: true,
                    badge: "Recommended",
                    showsChevron: true
                )
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Take one item, recommended")
            .accessibilityHint("Opens the guided camera")
            .accessibilityIdentifier("capture.take-one-item")

            Text("Other ways to add")
                .font(.caption2.weight(.semibold))
                .textCase(.uppercase)
                .tracking(0.5)
                .foregroundStyle(SnapListColorToken.textTertiary.color)

            VStack(spacing: 0) {
                CaptureOptionRow(
                    title: "Photograph a haul",
                    subtitle: "Stage several items, one after another.",
                    systemImage: "shippingbox",
                    showsChevron: false
                )
                .accessibilityHint("Not available in this capture slice")

                Divider().padding(.leading, 58)

                PhotosPicker(selection: $libraryItem, matching: .images) {
                    CaptureOptionRow(
                        title: "Choose from library",
                        subtitle: "Use photos you already have.",
                        systemImage: "photo",
                        showsChevron: true
                    )
                }
                .buttonStyle(.plain)
                .frame(maxWidth: .infinity, minHeight: 60)
                .contentShape(.rect)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Choose from library")
                .accessibilityIdentifier("capture.choose-library")

                Divider().padding(.leading, 58)

                CaptureOptionRow(
                    title: "Scan barcode or ISBN",
                    subtitle: "First for books, games, and sealed goods.",
                    systemImage: "barcode.viewfinder",
                    showsChevron: false
                )
                .accessibilityHint("Owned by a later approved slice")
            }

            Label(
                "Capture and organize photos before choosing what to list.",
                systemImage: "info.circle"
            )
            .font(.caption)
            .foregroundStyle(SnapListColorToken.textTertiary.color)
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, SnapListMetrics.screenGutter)
        .padding(.top, 10)
        .padding(.bottom, 18)
    }
}

private struct CaptureOptionRow: View {
    let title: String
    let subtitle: String
    let systemImage: String
    var isPrimary = false
    var badge: String?
    var showsChevron = true

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: systemImage)
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(
                    isPrimary ? .white : SnapListColorToken.textSecondary.color
                )
                .frame(width: 42, height: 42)
                .background(
                    isPrimary
                        ? SnapListColorToken.action.color
                        : SnapListColorToken.groupingFill.color
                )
                .clipShape(.rect(cornerRadius: 11))

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 7) {
                    Text(title)
                        .snapListTypography(.rowTitle)
                        .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    if let badge {
                        Text(badge.uppercased())
                            .font(.system(size: 9, weight: .bold))
                            .tracking(0.4)
                            .foregroundStyle(SnapListColorToken.action.color)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(SnapListColorToken.infoChipFill.color)
                            .clipShape(.capsule)
                    }
                }
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .multilineTextAlignment(.leading)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if showsChevron {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(SnapListColorToken.textTertiary.color)
            }
        }
        .padding(.horizontal, isPrimary ? 10 : 8)
        .frame(minHeight: isPrimary ? 64 : 60)
        .background(isPrimary ? Color(hex: "#F5F8FF") : .white)
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
    let openBoundary: (
        CaptureBoundaryDestination,
        [StagedCapturePhoto],
        CaptureBoundaryOpener
    ) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
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
                    Color(hex: "#0B0C0E").ignoresSafeArea()
                    ProgressView()
                        .tint(.white)
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
            isShutterEnabled: flow.canTakePhoto,
            isLibraryEnabled: !flow.isAddingPhotos,
            isFlashAvailable: flow.isFlashAvailable,
            flashMode: flow.flashMode,
            reduceMotion: reduceMotion,
            motionStateIdentifier: nil,
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
            returnFocus: $returnFocus,
            review: { open(.photoReview, opener: .reviewButton) },
            openTrophyWall: { open(.trophyWall, opener: .trophyWallTab) }
        )
    }

    private func recoverySurface(mode: ScanCameraRecoveryMode) -> some View {
        RecoveryScanCameraSurface(
            mode: mode,
            thumbnailURLs: flow.stagedPhotos.map { Optional($0.thumbnailURL) },
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
            openTrophyWall: { open(.trophyWall, opener: .trophyWallTab) }
        )
    }

    private func libraryPicker(labelStyle: ScanLibraryLabelStyle) -> some View {
        PhotosPicker(
            selection: $libraryItems,
            maxSelectionCount: max(1, 5 - flow.stagedPhotos.count),
            selectionBehavior: .ordered,
            matching: .images
        ) {
            ScanLibraryLabel(style: labelStyle)
        }
        .disabled(flow.isAddingPhotos)
        .accessibilityLabel("Library")
        .accessibilityIdentifier(
            labelStyle == .icon ? "scan.library" : "scan.choose-library"
        )
        .accessibilitySortPriority(60)
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

private enum ScanLibraryLabelStyle {
    case icon
    case recovery
}

private struct ScanLibraryLabel: View {
    let style: ScanLibraryLabelStyle

    var body: some View {
        Group {
            switch style {
            case .icon:
                Image(systemName: "photo.on.rectangle")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 48, height: 48)
                    .background(Color(hex: "#14161A").opacity(0.66))
                    .overlay { Circle().stroke(.white.opacity(0.12), lineWidth: 1) }
                    .clipShape(.circle)
            case .recovery:
                Text("Choose from library")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 22)
                    .frame(minWidth: 210, minHeight: 48)
                    .background(Color(hex: "#3665F3"))
                    .clipShape(.rect(cornerRadius: 14))
            }
        }
        .accessibilityLabel(style == .icon ? "Library" : "Choose from library")
        .accessibilityIdentifier(style == .icon ? "scan.library" : "scan.choose-library")
    }
}

struct ScanShutterAccessibility {
    let isEnabled: Bool
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

private struct LiveScanCameraSurface<Preview: View, LibraryControl: View>: View {
    let thumbnailURLs: [URL?]
    let isShutterEnabled: Bool
    let isLibraryEnabled: Bool
    let isFlashAvailable: Bool
    let flashMode: CaptureFlashMode
    let reduceMotion: Bool
    let motionStateIdentifier: String?
    @ViewBuilder let preview: () -> Preview
    @ViewBuilder let libraryControl: () -> LibraryControl
    let toggleFlash: () -> Void
    let takePhoto: () -> Void
    @Binding var returnFocus: PhotoReviewScanFocus?
    let review: () -> Void
    let openTrophyWall: () -> Void

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @AccessibilityFocusState private var focusedScanControl: ScanReviewFocusTarget?

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

            ResponsiveFramingCorners()
                .ignoresSafeArea()
                .accessibilityHidden(true)

            VStack(spacing: 0) {
                HStack {
                    flashButton
                    Spacer()
                }
                .padding(.horizontal, 18)
                .padding(.top, 8)

                Spacer(minLength: 20)

                if !thumbnailURLs.isEmpty {
                    photoProgress
                        .padding(.bottom, dynamicTypeSize.isAccessibilitySize ? 22 : 12)
                        .transition(
                            reduceMotion
                                ? .identity
                                : .opacity.combined(with: .offset(y: 10))
                        )
                }

                cameraControls
                    .frame(height: dynamicTypeSize.isAccessibilitySize ? 96 : 80)

                ScanDestinationDock(
                    selectedScan: true,
                    openTrophyWall: openTrophyWall
                )
                .padding(.top, 5)
                .padding(.bottom, 8)
                .offset(y: 20)
            }
            .safeAreaPadding(.top, 2)
            .safeAreaPadding(.bottom, 2)
        }
        .background(Color(hex: "#0B0C0E").ignoresSafeArea())
        .animation(
            reduceMotion ? nil : .easeOut(duration: 0.18),
            value: thumbnailURLs.count
        )
    }

    private var flashButton: some View {
        Button(action: toggleFlash) {
            Image(systemName: flashMode == .on ? "bolt.fill" : "bolt.slash.fill")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 44, height: 44)
                .background(Color(hex: "#14161A").opacity(0.66))
                .overlay { Circle().stroke(.white.opacity(0.12), lineWidth: 1) }
                .clipShape(.circle)
                .accessibilityHidden(true)
        }
        .buttonStyle(.plain)
        .frame(width: 44, height: 44)
        .contentShape(.circle)
        .disabled(!isFlashAvailable)
        .accessibilityLabel(flashMode == .on ? "Flash on" : "Flash off")
        .accessibilityHint(isFlashAvailable ? "Toggles the camera flash" : "Flash is not available")
        .accessibilityIdentifier("scan.flash")
        .accessibilitySortPriority(80)
    }

    private var photoProgress: some View {
        ScanPhotoProgressRow(thumbnailURLs: thumbnailURLs)
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
                        .stroke(.white, lineWidth: 3)
                        .frame(width: 72, height: 72)
                    Circle()
                        .fill(.white)
                        .frame(width: 56, height: 56)
                }
                .frame(width: 72, height: 72)
            }
            .buttonStyle(.plain)
            .disabled(!isShutterEnabled)
            .opacity(isShutterEnabled ? 1 : 0.38)
            .accessibilityLabel(
                ScanShutterAccessibility(
                    isEnabled: isShutterEnabled,
                    durablePhotoCount: thumbnailURLs.count
                ).label
            )
            .accessibilityIdentifier("scan.shutter")
            .accessibilitySortPriority(50)
        }
    }

    private var reviewButton: some View {
        Button("Review", action: review)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 18)
            .frame(minHeight: 48)
            .background(Color(hex: "#3665F3"))
            .clipShape(.capsule)
            .accessibilityLabel(
                thumbnailURLs.count == 1
                    ? "Review 1 photo"
                    : "Review \(thumbnailURLs.count) photos"
            )
            .accessibilityIdentifier("scan.review")
            .accessibilitySortPriority(ScanReviewAccessibilityPriority.live.value)
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
        guard returnFocus == .reviewButton,
              !thumbnailURLs.isEmpty else {
            return
        }
        focusedScanControl = .reviewButton
        returnFocus = nil
    }
}

private struct RecoveryScanCameraSurface<LibraryControl: View>: View {
    let mode: ScanCameraRecoveryMode
    let thumbnailURLs: [URL?]
    let reduceMotion: Bool
    @ViewBuilder let libraryControl: () -> LibraryControl
    @Binding var returnFocus: PhotoReviewScanFocus?
    let review: () -> Void
    let openSettings: () -> Void
    let openTrophyWall: () -> Void
    @AccessibilityFocusState private var focusedScanControl: ScanReviewFocusTarget?

    var body: some View {
        ZStack {
            Color(hex: "#0B0C0E").ignoresSafeArea()

            VStack(spacing: 0) {
                Spacer()
                VStack(spacing: 14) {
                    Image(systemName: "camera.fill")
                        .font(.system(size: 39, weight: .regular))
                        .foregroundStyle(.white.opacity(0.85))
                        .frame(width: 52, height: 52)
                        .overlay {
                            Capsule()
                                .fill(.white.opacity(0.85))
                                .frame(width: 2, height: 62)
                                .rotationEffect(.degrees(-45))
                        }
                        .accessibilityHidden(true)
                    Text(mode.title)
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(.white)
                        .multilineTextAlignment(.center)
                        .accessibilityIdentifier("scan.recovery-title")
                    Text(mode.body)
                        .font(.subheadline)
                        .foregroundStyle(.white.opacity(0.78))
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                    VStack(spacing: 6) {
                        libraryControl()
                        if mode == .denied {
                            Button("Open Settings", action: openSettings)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(Color(hex: "#8FB2FF"))
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
                        ScanPhotoProgressRow(thumbnailURLs: thumbnailURLs)
                        Button("Review", action: review)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 18)
                            .frame(minHeight: 48)
                            .background(Color(hex: "#3665F3"))
                            .clipShape(.capsule)
                            .accessibilityLabel(
                                thumbnailURLs.count == 1
                                    ? "Review 1 photo"
                                    : "Review \(thumbnailURLs.count) photos"
                            )
                            .accessibilityIdentifier("scan.review")
                            .accessibilitySortPriority(
                                ScanReviewAccessibilityPriority.recovery.value
                            )
                            .accessibilityFocused(
                                $focusedScanControl,
                                equals: .reviewButton
                            )
                            .onAppear(perform: consumeReviewFocusIfPossible)
                            .onChange(of: returnFocus) { _, _ in
                                consumeReviewFocusIfPossible()
                            }
                    }
                    .padding(.bottom, 10)
                    .transition(
                        reduceMotion
                            ? .identity
                            : .opacity.combined(with: .offset(y: 10))
                    )
                }
                ScanDestinationDock(
                    selectedScan: true,
                    openTrophyWall: openTrophyWall
                )
                .padding(.bottom, 8)
                .offset(y: 20)
            }
            .safeAreaPadding(.vertical, 2)
        }
        .animation(
            reduceMotion ? nil : .easeOut(duration: 0.18),
            value: thumbnailURLs.count
        )
    }

    private func consumeReviewFocusIfPossible() {
        guard returnFocus == .reviewButton,
              !thumbnailURLs.isEmpty else {
            return
        }
        focusedScanControl = .reviewButton
        returnFocus = nil
    }
}

private struct ScanPhotoProgressRow: View {
    let thumbnailURLs: [URL?]

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            HStack(spacing: 6) {
                ForEach(Array(thumbnailURLs.enumerated()), id: \.offset) { index, url in
                    ScanPhotoThumbnail(url: url, index: index, count: thumbnailURLs.count)
                }
            }
            Spacer(minLength: 8)
            Text("\(thumbnailURLs.count) of 5")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 11)
                .frame(minHeight: 34)
                .background(Color(hex: "#14161A").opacity(0.66))
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

    var body: some View {
        Group {
            if let url {
                LocalCaptureImage(url: url, maximumPixelSize: 160)
                    .scaledToFill()
            } else {
                LinearGradient(
                    colors: fixtureColors,
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            }
        }
        .frame(width: 34, height: 43)
        .clipShape(.rect(cornerRadius: 6))
        .overlay { RoundedRectangle(cornerRadius: 6).stroke(.white.opacity(0.9), lineWidth: 1) }
        .accessibilityIdentifier("scan.photo-\(index + 1)")
        .accessibilityLabel("Photo \(index + 1) of \(count)")
        .accessibilitySortPriority(70)
    }

    private var fixtureColors: [Color] {
        let palettes: [[Color]] = [
            [.orange, .brown], [.blue, .cyan], [.purple, .pink], [.green, .mint], [.yellow, .orange]
        ]
        return palettes[index % palettes.count]
    }
}

private struct ScanDestinationDock: View {
    let selectedScan: Bool
    let openTrophyWall: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            Button(action: {}) {
                Image(systemName: "camera.fill")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Color(hex: "#3665F3"))
                    .frame(width: 48, height: 48)
                    .background(Color(hex: "#EEF3FF"))
                    .clipShape(.rect(cornerRadius: 16))
                    .accessibilityHidden(true)
            }
            .buttonStyle(.plain)
            .frame(width: 48, height: 48)
            .contentShape(.rect)
            .accessibilityLabel("Scan, tab, selected")
            .accessibilityAddTraits(.isSelected)
            .accessibilityIdentifier("scan.tab")
            .accessibilitySortPriority(30)

            Button(action: openTrophyWall) {
                Image(systemName: "trophy")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Color(hex: "#4A4D54"))
                    .frame(width: 48, height: 48)
                    .accessibilityHidden(true)
            }
            .buttonStyle(.plain)
            .frame(width: 48, height: 48)
            .contentShape(.rect)
            .accessibilityLabel("Trophy Wall, tab")
            .accessibilityIdentifier("trophy-wall.tab")
            .accessibilitySortPriority(20)
        }
        .padding(5)
        .background(.white)
        .overlay { Capsule().stroke(Color(hex: "#ECEDF0"), lineWidth: 1) }
        .clipShape(.capsule)
    }
}

#if DEBUG
struct ScanCameraVisualStateView: View {
    let state: ApprovedVisualStateID
    let forceReducedMotion: Bool

    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion

    private var reduceMotion: Bool { forceReducedMotion || systemReduceMotion }

    var body: some View {
        switch state {
        case .scanCameraUnavailable:
            RecoveryScanCameraSurface(
                mode: .unavailable,
                thumbnailURLs: [],
                reduceMotion: reduceMotion,
                libraryControl: {
                    Button(action: {}) { ScanLibraryLabel(style: .recovery) }
                        .buttonStyle(.plain)
                },
                review: {},
                openSettings: {},
                openTrophyWall: {}
            )
        case .scanCameraDenied:
            RecoveryScanCameraSurface(
                mode: .denied,
                thumbnailURLs: [],
                reduceMotion: reduceMotion,
                libraryControl: {
                    Button(action: {}) { ScanLibraryLabel(style: .recovery) }
                        .buttonStyle(.plain)
                },
                review: {},
                openSettings: {},
                openTrophyWall: {}
            )
        default:
            LiveScanCameraSurface(
                thumbnailURLs: Array(repeating: nil, count: fixturePhotoCount),
                isShutterEnabled: fixturePhotoCount < 5,
                isLibraryEnabled: true,
                isFlashAvailable: true,
                flashMode: .off,
                reduceMotion: reduceMotion,
                motionStateIdentifier: reduceMotion ? "scan.motion-reduced" : nil,
                preview: { FixtureItemScene(subjectScale: 1.15) },
                libraryControl: {
                    Button(action: {}) { ScanLibraryLabel(style: .icon) }
                        .buttonStyle(.plain)
                },
                toggleFlash: {},
                takePhoto: {},
                review: {},
                openTrophyWall: {}
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
                Color(hex: "#E9EAEC")
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
            let color = Color.white.opacity(0.86)
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
            let topInset: CGFloat = isCompactHeight ? 112 : 132
            let bottomInset: CGFloat = isCompactHeight ? 264 : 288
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
                Color(hex: "#101214").opacity(0.42).ignoresSafeArea()
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
        .background(.white)
        .accessibilityIdentifier("visual.capture.home-preserved")
    }
}

private struct CaptureLauncherFixture: View {
    var body: some View {
        VStack(spacing: 0) {
            Capsule().fill(Color(hex: "#C7C9CD")).frame(width: 38, height: 5).padding(.top, 8)
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
            CaptureOptionRow(
                title: "Take one item",
                subtitle: "Snap one thing and get help listing it.",
                systemImage: "camera",
                isPrimary: true,
                badge: "Recommended"
            )
            .padding(.horizontal, 20)
            Text("Other ways to add")
                .font(.caption2.weight(.semibold))
                .textCase(.uppercase)
                .foregroundStyle(SnapListColorToken.textTertiary.color)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 20)
                .padding(.top, 14)
            ForEach([
                ("Photograph a haul", "Stage several items, one after another.", "shippingbox"),
                ("Choose from library", "Use photos you already have.", "photo"),
                ("Scan barcode or ISBN", "First for books, games, and sealed goods.", "barcode.viewfinder")
            ], id: \.0) { title, subtitle, icon in
                CaptureOptionRow(
                    title: title,
                    subtitle: subtitle,
                    systemImage: icon
                )
                .padding(.horizontal, 20)
            }
            Label(
                "Capture and organize photos before choosing what to list.",
                systemImage: "info.circle"
            )
            .font(.caption)
            .foregroundStyle(SnapListColorToken.textTertiary.color)
            .padding(.horizontal, 20)
            .padding(.top, 6)
            .padding(.bottom, 14)
        }
        .frame(height: 680, alignment: .top)
        .background(.white)
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
                        .foregroundStyle(.white)
                        .frame(width: 44, height: 44)
                        .background(.black.opacity(0.38))
                        .clipShape(.circle)
                    Spacer()
                    Label(captured ? "1 of 4 photos" : "Auto", systemImage: captured ? "photo.stack" : "bolt.slash.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 12)
                        .frame(minHeight: 44)
                        .background(.ultraThinMaterial)
                        .clipShape(.capsule)
                    if captured {
                        Spacer()
                        Image(systemName: "bolt.slash.fill")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.white)
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
                            .padding(14).background(.white).clipShape(.rect(cornerRadius: 16))
                    }
                } else if let cue = guidance.cue {
                    Label(cue, systemImage: guidance.systemImage)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 16)
                        .frame(minHeight: 44)
                        .background(SnapListColorToken.action.color.opacity(0.48))
                        .background(.ultraThinMaterial)
                        .clipShape(.capsule)
                }
                if !captured {
                    Text("Tap the scene to update positioning")
                        .font(.caption).foregroundStyle(.white.opacity(0.7))
                    HStack {
                        Image(systemName: "photo").foregroundStyle(.white).frame(width: 44, height: 44)
                        Spacer()
                        Circle().fill(.white).frame(width: 68, height: 68)
                            .overlay { Circle().stroke(.white.opacity(0.8), lineWidth: 4).padding(-5) }
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
            Text("Continue").font(.subheadline.weight(.semibold)).foregroundStyle(.white)
                .padding(.horizontal, 16).frame(minHeight: 44)
                .background(SnapListColorToken.action.color).clipShape(.capsule)
        }
        .padding(12).background(.white).clipShape(.rect(cornerRadius: 16))
    }
}

private struct FixtureItemScene: View {
    let subjectScale: CGFloat

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                LinearGradient(
                    colors: [Color(hex: "#F7F7F7"), Color(hex: "#D4D5D8")],
                    startPoint: .top,
                    endPoint: .bottom
                )
                VStack(spacing: 0) {
                    RoundedRectangle(cornerRadius: 10)
                        .fill(Color(hex: "#25272A"))
                        .frame(width: 58, height: 82)
                        .overlay {
                            RoundedRectangle(cornerRadius: 7)
                                .stroke(Color(hex: "#A7A9AD"), lineWidth: 3)
                                .padding(6)
                        }
                    RoundedRectangle(cornerRadius: 8)
                        .fill(Color(hex: "#303236"))
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
                Text("1").font(.caption2.bold()).foregroundStyle(.white).frame(width: 22, height: 22)
                    .background(SnapListColorToken.action.color).clipShape(.circle).offset(x: 7, y: 7)
            }
            Text("Photos ready to review").snapListTypography(.cardTitle).padding(.top, 24)
            Text("Your 1 photo is saved. Next you’ll review it and add guidance before pricing — nothing has been analyzed yet.")
                .font(.subheadline).foregroundStyle(SnapListColorToken.textSecondary.color)
                .multilineTextAlignment(.center).padding(.horizontal, 42).padding(.top, 8)
            Label("Open photo review", systemImage: "chevron.right")
                .font(.subheadline.weight(.semibold)).foregroundStyle(.white)
                .padding(.horizontal, 20).frame(minHeight: 50)
                .background(SnapListColorToken.action.color).clipShape(.capsule).padding(.top, 22)
            Text("Back to camera").font(.subheadline.weight(.semibold))
                .foregroundStyle(SnapListColorToken.action.color).frame(minHeight: 44)
            Label("Prototype bridge only — CAP-03 photo review remains outside this slice.", systemImage: "info.circle")
                .font(.caption).foregroundStyle(SnapListColorToken.textTertiary.color)
                .multilineTextAlignment(.center).padding(.horizontal, 36).padding(.top, 12)
            Spacer()
        }
        .padding(.top, 46).padding(.bottom, 28).background(.white)
        .accessibilityIdentifier("visual-state.CAP-03-handoff")
    }
}
#endif
