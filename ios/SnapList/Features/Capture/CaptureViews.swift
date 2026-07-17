import ImageIO
import PhotosUI
import SwiftUI
import UIKit

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
                    Text("1 of 4 photos saved")
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

struct GuidedCameraView: View {
    @Bindable var flow: CaptureFlowModel
    let close: () -> Void

    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var libraryItem: PhotosPickerItem?

    var body: some View {
        ZStack {
            switch flow.phase {
            case .camera:
                cameraSurface
            case .captured:
                capturedSurface
            case .reviewHandoff:
                reviewHandoff
            case .denied:
                recoverySurface(
                    title: "Camera access is off",
                    message: "Turn on Camera in Settings, or choose a photo from your library instead.",
                    showsSettings: true
                )
            case .unavailable:
                recoverySurface(
                    title: "Camera isn’t available",
                    message: "You can still choose a photo from your library.",
                    showsSettings: false
                )
            case .failed:
                recoverySurface(
                    title: "That photo couldn’t be saved",
                    message: "Try again, or choose a different photo from your library.",
                    showsSettings: false
                )
            case .idle, .requestingPermission:
                ProgressView("Preparing camera…")
                    .tint(.white)
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color.black)
            }
        }
        .background(Color.black.ignoresSafeArea())
        .statusBarHidden(flow.phase == .camera || flow.phase == .captured)
        .onChange(of: scenePhase) { _, next in
            flow.handleScenePhase(next)
            if next == .active {
                Task { await flow.handleSceneBecameActive() }
            }
        }
        .onChange(of: libraryItem) { _, item in
            guard let item else { return }
            Task {
                guard let data = try? await item.loadTransferable(type: Data.self) else {
                    return
                }
                await flow.stageLibraryPhoto(data)
            }
        }
    }

    private var cameraSurface: some View {
        ZStack {
            CameraPreviewView(
                session: flow.previewSession,
                device: flow.captureDevice
            )
            .accessibilityHidden(true)

            LinearGradient(
                colors: [.black.opacity(0.35), .clear, .black.opacity(0.58)],
                startPoint: .top,
                endPoint: .bottom
            )
            .accessibilityHidden(true)

            ResponsiveFramingCorners()
                .accessibilityHidden(true)

            VStack {
                cameraTopBar
                Spacer()
                cameraGuidance
                Text("Tap the scene to update positioning")
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.72))
                    .accessibilityHidden(true)
                cameraControls
                    .padding(.top, 12)
            }
            .safeAreaPadding(.horizontal, 20)
            .safeAreaPadding(.top, 10)
            .safeAreaPadding(.bottom, 12)
        }
        .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 1.01)))
    }

    private var cameraTopBar: some View {
        HStack {
            CameraCircleButton(
                systemImage: "xmark",
                accessibilityLabel: "Close camera",
                identifier: "camera.close"
            ) {
                flow.cancelCamera()
                close()
            }
            Spacer()
            Label("Auto", systemImage: "bolt.slash.fill")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 12)
                .frame(minHeight: SnapListMetrics.minimumTouchTarget)
                .background(.ultraThinMaterial)
                .clipShape(.capsule)
                .accessibilityLabel("Flash automatic")
        }
    }

    @ViewBuilder
    private var cameraGuidance: some View {
        if flow.stagedPhoto != nil {
            Label(
                "1 photo is still saved. This frozen handoff won’t replace it; additional photos aren’t available yet.",
                systemImage: "photo.stack"
            )
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 16)
            .frame(minHeight: SnapListMetrics.minimumTouchTarget)
            .background(SnapListColorToken.action.color.opacity(0.48))
            .background(.ultraThinMaterial)
            .clipShape(.capsule)
            .accessibilityIdentifier("camera.staged-photo-boundary")
        } else if flow.guidance == .coaching {
            HStack(alignment: .bottom, spacing: 8) {
                Image("ScoutCoaching")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 82, height: 82)
                    .accessibilityLabel("Scout, the SnapList camera guide")

                Text("Start with one clear photo. Add angles, labels, or damage for a stronger match.")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(14)
                    .background(.white)
                    .clipShape(.rect(cornerRadius: 16))
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("camera.guidance.coaching")
        } else if let cue = flow.guidance.cue {
            Label(cue, systemImage: flow.guidance.systemImage)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 16)
                .frame(minHeight: SnapListMetrics.minimumTouchTarget)
                .background(SnapListColorToken.action.color.opacity(0.48))
                .background(.ultraThinMaterial)
                .clipShape(.capsule)
                .accessibilityLabel("Camera guidance: \(cue)")
                .accessibilityIdentifier(
                    flow.guidance == .accepted
                        ? "camera.guidance.accepted"
                        : "camera.guidance.move-closer"
                )
        }
    }

    private var cameraControls: some View {
        HStack {
            PhotosPicker(selection: $libraryItem, matching: .images) {
                Image(systemName: "photo")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(
                        width: SnapListMetrics.minimumTouchTarget,
                        height: SnapListMetrics.minimumTouchTarget
                    )
                    .background(.black.opacity(0.36))
                    .clipShape(.rect(cornerRadius: 12))
            }
            .accessibilityLabel("Choose from photo library")
            .accessibilityHint(
                flow.stagedPhoto == nil
                    ? "Selects one photo for this item"
                    : "One photo is already staged; additional photos belong to a later capture slice"
            )
            .accessibilityIdentifier("camera.library")
            .disabled(flow.stagedPhoto != nil)
            .opacity(flow.stagedPhoto == nil ? 1 : 0.52)

            Spacer()

            Button {
                Task { await flow.takePhoto() }
            } label: {
                Circle()
                    .fill(.white)
                    .frame(width: 68, height: 68)
                    .overlay {
                        Circle().stroke(.white.opacity(0.8), lineWidth: 4).padding(-5)
                    }
            }
            .buttonStyle(.plain)
            .disabled(!flow.canTakePhoto)
            .opacity(flow.canTakePhoto ? 1 : 0.52)
            .accessibilityLabel("Take photo")
            .accessibilityHint(
                flow.stagedPhoto != nil
                    ? "One photo is already staged; additional photos belong to a later capture slice"
                    : flow.isCapturingPhoto
                    ? "Capture in progress"
                    : flow.canTakePhoto
                        ? "Captures the item in frame"
                        : "Available when the whole item is in frame"
            )
            .accessibilityIdentifier("camera.shutter")

            Spacer()

            Color.clear
                .frame(
                    width: SnapListMetrics.minimumTouchTarget,
                    height: SnapListMetrics.minimumTouchTarget
                )
                .accessibilityHidden(true)
        }
    }

    private var capturedSurface: some View {
        ZStack {
            GeometryReader { proxy in
                stagedImage(url: flow.stagedPhoto?.photoURL, maximumPixelSize: 1600)
                    .scaledToFill()
                    .frame(width: proxy.size.width, height: proxy.size.height)
                    .clipped()
            }

            LinearGradient(
                colors: [.black.opacity(0.34), .clear, .black.opacity(0.58)],
                startPoint: .top,
                endPoint: .bottom
            )

            VStack {
                HStack {
                    CameraCircleButton(
                        systemImage: "xmark",
                        accessibilityLabel: "Close camera",
                        identifier: "camera.close"
                    ) {
                        flow.cancelCamera()
                        close()
                    }
                    Spacer()
                    Label("1 of 4 photos", systemImage: "photo.stack")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 12)
                        .frame(minHeight: SnapListMetrics.minimumTouchTarget)
                        .background(.ultraThinMaterial)
                        .clipShape(.capsule)
                        .accessibilityIdentifier("capture.photo-count")
                    Spacer()
                    Image(systemName: "bolt.slash.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white)
                        .frame(width: 44, height: 44)
                        .background(.ultraThinMaterial)
                        .clipShape(.circle)
                        .accessibilityLabel("Flash automatic")
                }

                Spacer()

                capturedTray
            }
            .safeAreaPadding(.horizontal, 20)
            .safeAreaPadding(.top, 10)
            .safeAreaPadding(.bottom, 18)
        }
    }

    private var capturedTray: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 10) {
                        capturedThumbnail
                        capturedDetails
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    capturedContinueButton
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
            } else {
                HStack(spacing: 10) {
                    capturedThumbnail
                    capturedDetails
                        .frame(width: 140, alignment: .leading)
                    Spacer(minLength: 0)
                    capturedContinueButton
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(.white)
        .clipShape(.rect(cornerRadius: 16))
    }

    private var capturedThumbnail: some View {
        stagedImage(url: flow.stagedPhoto?.thumbnailURL, maximumPixelSize: 240)
            .scaledToFill()
            .frame(width: 48, height: 48)
            .clipShape(.rect(cornerRadius: 10))
    }

    private var capturedDetails: some View {
        VStack(alignment: .leading, spacing: 2) {
            Label("Photo added", systemImage: "checkmark.circle.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
            Text("Add angles, labels, or damage — or continue.")
                .font(.caption)
                .foregroundStyle(SnapListColorToken.textSecondary.color)
        }
    }

    private var capturedContinueButton: some View {
        Button("Continue") {
            flow.continueToReviewHandoff()
        }
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(.white)
        .padding(.horizontal, 17)
        .frame(minHeight: SnapListMetrics.minimumTouchTarget)
        .background(SnapListColorToken.action.color)
        .clipShape(.capsule)
        .fixedSize(horizontal: true, vertical: false)
        .accessibilityIdentifier("capture.continue")
    }

    private var reviewHandoff: some View {
        VStack(spacing: 0) {
            HStack {
                Button {
                    Task { await flow.reopenCameraFromReviewHandoff() }
                } label: {
                    Image(systemName: "chevron.left")
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel("Back to camera")
                SnapListChip("Handoff · CAP-03", variant: .info)
                Spacer()
            }
            .safeAreaPadding(.horizontal, 12)

            Spacer()

            ZStack(alignment: .bottomTrailing) {
                stagedImage(url: flow.stagedPhoto?.thumbnailURL, maximumPixelSize: 240)
                    .scaledToFill()
                    .frame(width: 82, height: 82)
                    .clipShape(.rect(cornerRadius: 18))
                    .shadow(color: .black.opacity(0.16), radius: 16, y: 8)
                Text("1")
                    .font(.caption2.bold())
                    .foregroundStyle(.white)
                    .frame(width: 22, height: 22)
                    .background(SnapListColorToken.action.color)
                    .clipShape(.circle)
                    .offset(x: 7, y: 7)
            }

            Text(flow.handoffTitle)
                .snapListTypography(.cardTitle)
                .padding(.top, 24)
                .accessibilityIdentifier("capture.handoff.title")
            Text("Your 1 photo is saved. Next you’ll review it and add guidance before pricing — nothing has been analyzed yet.")
                .font(.subheadline)
                .foregroundStyle(SnapListColorToken.textSecondary.color)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 42)
                .padding(.top, 8)

            Label("Open photo review", systemImage: "chevron.right")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 20)
                .frame(minHeight: 50)
                .background(SnapListColorToken.action.color)
                .clipShape(.capsule)
                .padding(.top, 22)
                .accessibilityLabel("Photo review is the next implementation boundary")

            Button("Back to camera") {
                Task { await flow.reopenCameraFromReviewHandoff() }
            }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(SnapListColorToken.action.color)
            .frame(minHeight: 44)
            .accessibilityIdentifier("capture.handoff.back-to-camera")

            Label(
                "Prototype bridge only — CAP-03 photo review remains outside this slice.",
                systemImage: "info.circle"
            )
            .font(.caption)
            .foregroundStyle(SnapListColorToken.textTertiary.color)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 36)
            .padding(.top, 12)

            Spacer()
        }
        .safeAreaPadding(.top, 12)
        .safeAreaPadding(.bottom, 12)
        .background(.white)
        .foregroundStyle(SnapListColorToken.inkPrimary.color)
    }

    private func recoverySurface(
        title: String,
        message: String,
        showsSettings: Bool
    ) -> some View {
        VStack(spacing: 18) {
            Image(systemName: "camera.fill")
                .font(.system(size: 38))
                .foregroundStyle(SnapListColorToken.textTertiary.color)
                .accessibilityHidden(true)
            Text(title)
                .snapListTypography(.cardTitle)
            Text(message)
                .snapListTypography(.body)
                .foregroundStyle(SnapListColorToken.textSecondary.color)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            if showsSettings {
                SnapListPrimaryButton(title: "Open Settings") {
                    guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                    UIApplication.shared.open(url)
                }
            }

            PhotosPicker(selection: $libraryItem, matching: .images) {
                Text("Choose from library instead")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: 50)
                    .overlay {
                        Capsule().stroke(SnapListColorToken.hairline.color)
                    }
            }
            .accessibilityIdentifier("camera.library-recovery")

            Button("Close") {
                flow.cancelCamera()
                close()
            }
            .frame(minHeight: SnapListMetrics.minimumTouchTarget)
        }
        .padding(.horizontal, 28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.white)
        .foregroundStyle(SnapListColorToken.inkPrimary.color)
    }

    private func stagedImage(url: URL?, maximumPixelSize: Int) -> some View {
        LocalCaptureImage(url: url, maximumPixelSize: maximumPixelSize)
    }
}

private struct LocalCaptureImage: View {
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

private struct CameraCircleButton: View {
    let systemImage: String
    let accessibilityLabel: String
    let identifier: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.white)
                .frame(
                    width: SnapListMetrics.minimumTouchTarget,
                    height: SnapListMetrics.minimumTouchTarget
                )
                .background(.black.opacity(0.38))
                .clipShape(.circle)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityIdentifier(identifier)
    }
}

private struct FramingCorners: View {
    var body: some View {
        Canvas { context, size in
            let length: CGFloat = min(24, size.width * 0.08)
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
            FramingCorners()
                .frame(
                    width: max(180, min(proxy.size.width - 112, 560)),
                    height: min(320, proxy.size.height * 0.34)
                )
                .position(
                    x: proxy.size.width / 2,
                    y: proxy.size.height * 0.385
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
