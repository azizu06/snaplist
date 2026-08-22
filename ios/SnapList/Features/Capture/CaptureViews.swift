import ImageIO
import PhotosUI
import SwiftUI
import UIKit

extension PhotosPickerItem: CaptureLibraryPhotoLoading {
    func loadPhotoData() async throws -> Data? {
        try await loadTransferable(type: Data.self)
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
            zoomControl: flow.zoomControl,
            selectedZoomLens: flow.zoomLens,
            selectZoomLens: flow.selectZoomLens,
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
            maxSelectionCount: max(1, CapturePhotoLimits.maxPhotoCount - flow.stagedPhotos.count),
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

/// The `.5x` / `1x` selector the reference puts directly above the bottom row.
///
/// It renders nothing when the hardware cannot reach a second field of view,
/// which is the honest alternative to showing a factor the device will refuse.
/// The whole capsule is one accessibility container carrying the current
/// factor as its value, and each option additionally announces its own factor
/// and whether it is the selected one.
/// The vertical band the zoom row reserves in the control stack when the
/// hardware offers it: the gap `LiveScanCameraSurface` pads above the row
/// plus the row's own rendered height.
///
/// The ACT-01 / ACT-06 coach mark anchor (`AppShellView`) reads this rather
/// than carrying its own copy, so a change to the row's spacing cannot leave it
/// stale. Since #954 the framing corners no longer read it: the capsule floats
/// over the preview, inside the framing box rather than below it, so the box
/// does not clear it. It still occupies this much of the control stack, which
/// is the question the coach mark is asking.
enum ScanZoomRowMetrics {
    static func reservedHeight(isAccessibility: Bool) -> CGFloat {
        isAccessibility ? 22 + 52 : 18 + 44
    }
}

struct ScanZoomControlView: View {
    let control: ScanZoomControl
    let selectedLens: ScanZoomLens
    let selectLens: (ScanZoomLens) -> Void

    var body: some View {
        if control.isOffered {
            // The painted pill and the tappable buttons are sized
            // independently on purpose. Owner device feedback (#987) is that
            // a pill sized to the 44pt touch targets underneath it reads as
            // oversized against the Cal AI reference it is proportioned
            // after, and drifts close to the corner brackets above it. The
            // decorative chips below paint the small pill the reference
            // draws; the invisible buttons layered on top keep every option
            // a real 44pt target without inflating that paint.
            ZStack {
                HStack(spacing: 3) {
                    ForEach(control.lenses, id: \.self) { lens in
                        visualChip(lens)
                    }
                }
                .padding(3)
                .background(SnapListColorToken.cameraControlFill.color.opacity(0.66))
                .overlay {
                    Capsule().stroke(
                        SnapListColorToken.onDarkSurface.color.opacity(0.12),
                        lineWidth: 1
                    )
                }
                .clipShape(.capsule)
                .allowsHitTesting(false)
                .accessibilityHidden(true)

                HStack(spacing: 3) {
                    ForEach(control.lenses, id: \.self) { lens in
                        tapTarget(lens)
                    }
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Zoom")
            .accessibilityValue(control.spokenFactor(for: selectedLens))
            .accessibilityIdentifier("scan.zoom")
            .accessibilitySortPriority(55)
        }
    }

    /// The shared shape both `visualChip` and `tapTarget` size themselves
    /// from, so the invisible tap layer's footprint can never drift smaller
    /// than the painted chip's at large Dynamic Type sizes (#987 round 2) —
    /// they run the exact same layout, not two hand-matched constants.
    private func chipShape(_ lens: ScanZoomLens) -> some View {
        Text(control.label(for: lens))
            .font(.footnote.weight(.semibold))
            // ".5x" is two glyph groups, so a squeezed chip wraps into a
            // stack rather than truncating, and the capsule grows taller
            // than the chrome it sits in. #954 hit this twice, once with
            // the count capsule and once with this one.
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            .padding(.horizontal, 8)
            .frame(minWidth: 32, minHeight: 26)
    }

    /// The small painted pill, purely decorative. VoiceOver reads the
    /// matching `tapTarget` instead.
    private func visualChip(_ lens: ScanZoomLens) -> some View {
        let isSelected = lens == selectedLens

        return chipShape(lens)
            .foregroundStyle(
                isSelected
                    ? SnapListColorToken.inkPrimary.color
                    : SnapListColorToken.onDarkSurface.color
            )
            .background {
                if isSelected {
                    Capsule().fill(SnapListColorToken.onDarkSurface.color)
                }
            }
    }

    /// The real touch target for one lens. Sized from the same `chipShape`
    /// the painted pill uses, floored at 44pt, so it always CONTAINS the
    /// visible chip instead of a fixed 44x44 square that a large Dynamic
    /// Type chip could grow past. Its label carries no visible content —
    /// `visualChip` paints what the seller sees underneath it.
    private func tapTarget(_ lens: ScanZoomLens) -> some View {
        let isSelected = lens == selectedLens

        return Button {
            selectLens(lens)
        } label: {
            // `Color.clear` bakes in zero alpha, and `.opacity()` only
            // multiplies existing alpha (0 × anything is still 0) — so even
            // `Color.clear.opacity(0.001)` stays exactly transparent.
            // SwiftUI excludes exactly-zero-alpha content from real touch
            // delivery regardless of `.contentShape`, so this target went
            // genuinely untappable until given a non-zero, imperceptible
            // fill instead.
            chipShape(lens)
                .frame(minWidth: 44, minHeight: 44)
                .opacity(0.001)
        }
        .buttonStyle(.plain)
        .contentShape(Rectangle())
        .accessibilityLabel(control.accessibilityLabel(for: lens))
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
        .accessibilityIdentifier(
            lens == .ultraWide ? "scan.zoom.ultra-wide" : "scan.zoom.wide"
        )
        .accessibilitySortPriority(55)
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

/// Pure seam for the circle-to-capsule morph's curve, so a plain unit test can assert Reduced
/// Motion drops to an instant swap without rendering `ScanReviewButton` (#1009 owner refinement 2).
enum ScanReviewMorphAnimation {
    static func curve(reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.82)
    }
}

/// The Review opener, expressed once for both Scan camera surfaces.
///
/// The live and recovery surfaces show the same control with the same styling, the same
/// count-sensitive name, the same identifier, and the same accessibility-focus handoff back
/// from Photo Review. Each surface still supplies its own sort-priority case, which is the one
/// input that is allowed to differ, even though `.live` and `.recovery` both resolve to 40 today.
///
/// #1009 reshapes this from a name-driven capsule to a fixed-size circle that mirrors the
/// library opener (48pt) with a photo-count badge, so it can sit beside the shutter and
/// library in one row without a growing label ever contesting that row's width. Owner
/// refinement 2 reopens exactly that width question at the five-photo cap only: Review
/// morphs into a labeled capsule there. It still sits in the row's trailing
/// `.frame(maxWidth: .infinity, alignment: .trailing)` region, so it grows leftward from a
/// pinned trailing edge rather than displacing the shutter — verified at accessibility5 by
/// `testReviewCapsuleAtCapDoesNotDisplaceTheShutterAtAccessibilityFive`.
///
/// Not `private`: a unit test renders it alone to inspect its resolved button style (#856).
struct ScanReviewButton: View {
    let photoCount: Int
    let priority: ScanReviewAccessibilityPriority
    @Binding var returnFocus: PhotoReviewScanFocus?
    let review: () -> Void

    @AccessibilityFocusState private var focusedScanControl: ScanReviewFocusTarget?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Owner refinement to #1009 AC3: the circle only takes the accent fill
    /// once the seller has hit the cap. Below it, Review keeps the same
    /// translucent camera-control fill the gallery circle uses, so the icon
    /// — never itself changing — is the only affordance, and the fill is what
    /// tells the seller they are out of room.
    var isAtPhotoCap: Bool {
        photoCount >= CapturePhotoLimits.maxPhotoCount
    }

    var body: some View {
        Button(action: review) {
            content
                .accessibilityHidden(true)
        }
        // This circle/capsule is the control's whole affordance. Left on
        // `.automatic`, iOS paints a second filled shape behind it for a
        // seller with Button Shapes on, which reads as an overlay sitting on
        // the icon (#856).
        .buttonStyle(.plain)
        .frame(minWidth: 48, minHeight: 48)
        .contentShape(Rectangle())
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
        .animation(
            ScanReviewMorphAnimation.curve(reduceMotion: reduceMotion),
            value: isAtPhotoCap
        )
    }

    /// Owner refinement 2 to #1009: at the five-photo cap Review morphs from
    /// the fixed circle into an accent-filled capsule carrying its own label,
    /// so the control that always meant "go review" reads, at the one moment
    /// nothing else fits, as "you're done — go look."
    ///
    /// The capsule sits in the row's trailing equal-flex region beside the
    /// library opener's leading one (#864); a device screenshot at
    /// `accessibility5` showed that split holding steady width for width —
    /// the shutter never moves — but an uncapped "Review" label past that
    /// share truncated to "R…" rather than growing further. Capping the
    /// label's own Dynamic Type ceiling keeps it legible and whole; letting
    /// the row's own centering guarantee break instead was not the trade.
    @ViewBuilder
    private var content: some View {
        if isAtPhotoCap {
            HStack(spacing: 6) {
                Image(systemName: "chevron.right")
                    .font(.system(size: 17, weight: .semibold))
                Text("Review")
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
            }
            .dynamicTypeSize(...DynamicTypeSize.accessibility1)
            .foregroundStyle(SnapListColorToken.onDarkSurface.color)
            .padding(.horizontal, 18)
            .frame(minHeight: 48)
            .background(SnapListColorToken.action.color)
            .overlay { Capsule().stroke(SnapListColorToken.onDarkSurface.color.opacity(0.12), lineWidth: 1) }
            .clipShape(.capsule)
            .shadow(color: SnapListColorToken.action.color.opacity(0.28), radius: 12, y: 6)
        } else {
            Image(systemName: "chevron.right")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(SnapListColorToken.onDarkSurface.color)
                .frame(width: 48, height: 48)
                .background(SnapListColorToken.cameraControlFill.color.opacity(0.66))
                .overlay { Circle().stroke(SnapListColorToken.onDarkSurface.color.opacity(0.12), lineWidth: 1) }
                .clipShape(.circle)
                .shadow(color: SnapListColorToken.action.color.opacity(0.28), radius: 12, y: 6)
                .overlay(alignment: .topTrailing) { countBadge }
        }
    }

    private var countBadge: some View {
        Text("\(photoCount)")
            .font(.caption2.weight(.bold))
            .foregroundStyle(SnapListColorToken.onDarkSurface.color)
            .frame(minWidth: 20, minHeight: 20)
            .background(SnapListColorToken.inkPrimary.color)
            .overlay { Circle().stroke(SnapListColorToken.onDarkSurface.color.opacity(0.9), lineWidth: 1) }
            .clipShape(.circle)
            .offset(x: 6, y: -6)
            .accessibilityHidden(true)
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

/// Where the bottom control stack starts, in global coordinates.
///
/// The framing corners are drawn in a sibling layer of the same `ZStack`, so
/// they cannot ask the control stack where it ended up. Every row of that stack
/// reports its own top and the lowest value wins, which is the first row
/// whatever occupies it — the staged strip when photos are staged, the shutter
/// row when none are.
///
/// Measured rather than summed because every row's own height varies with
/// Dynamic Type. A constant would be right at the sizes it was read off and
/// wrong at the rest, which is the shape of #954's own defect.
private struct ScanBottomStackTopPreferenceKey: PreferenceKey {
    static let defaultValue: CGFloat = .greatestFiniteMagnitude

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = min(value, nextValue())
    }
}

/// The bottom edge of the surface, in the same global space.
private struct ScanSurfaceBottomPreferenceKey: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

extension View {
    /// Reports this row's top edge as a candidate for the bottom stack's start.
    fileprivate func reportsBottomStackTop() -> some View {
        background {
            GeometryReader { proxy in
                Color.clear.preference(
                    key: ScanBottomStackTopPreferenceKey.self,
                    value: proxy.frame(in: .global).minY
                )
            }
        }
    }
}

private struct LiveScanCameraSurface<Preview: View, LibraryControl: View>: View {
    let thumbnailURLs: [URL?]
    let photoIDs: [StagedCapturePhoto.ID]
    let isShutterEnabled: Bool
    let isLibraryEnabled: Bool
    let isFlashAvailable: Bool
    let flashMode: CaptureFlashMode
    let zoomControl: ScanZoomControl
    let selectedZoomLens: ScanZoomLens
    let selectZoomLens: (ScanZoomLens) -> Void
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
    @State private var bottomStackTopY: CGFloat = .greatestFiniteMagnitude
    @State private var surfaceBottomY: CGFloat = 0

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

            ResponsiveFramingCorners(
                additionalBottomInset: -FloatingDockMetrics.containerHeight(for: .scan),
                bottomEdgeAboveContainerBottom: framingCornersBottomEdge
            )
            .ignoresSafeArea()
            .accessibilityHidden(true)

            VStack(spacing: 0) {
                // #1009 moves flash up beside the close button, so the bottom
                // row can pair the gallery and Review symmetrically around
                // the shutter instead of carrying a third control of its own.
                HStack {
                    closeButton
                    Spacer(minLength: 0)
                    flashButton
                }
                .padding(.horizontal, 18)
                .padding(.top, 8)

                Spacer(minLength: 20)

                // The zoom capsule gets a compact row of its own directly above
                // the staged strip, so it stays next to the shutter it changes
                // rather than drifting up to the close button.
                //
                // It cannot share the staged row: five thumbnails hold 265pt of
                // the 372pt gutter at every text size, which was already most
                // of it before Review moved into the bottom row (#1009). That
                // squeeze is the collision #954 exists to remove, so the
                // capsule keeps its own line and the strip keeps to itself.
                //
                // `fixedSize` because ".5x" is two glyph groups: a squeezed
                // capsule wraps into a stack rather than truncating, and grows
                // taller than the row it sits in.
                ScanZoomControlView(
                    control: zoomControl,
                    selectedLens: selectedZoomLens,
                    selectLens: selectZoomLens
                )
                .fixedSize(horizontal: true, vertical: false)
                .reportsBottomStackTop()

                if !thumbnailURLs.isEmpty {
                    stagedControls
                        .padding(.horizontal, 15)
                        .reportsBottomStackTop()
                        .padding(.top, dynamicTypeSize.isAccessibilitySize ? 14 : 12)
                        .transition(
                            reduceMotion
                                ? .identity
                                : .opacity.combined(with: .offset(y: 10))
                        )
                }

                cameraControls
                    .frame(height: dynamicTypeSize.isAccessibilitySize ? 96 : 80)
                    .reportsBottomStackTop()
                    .padding(.top, dynamicTypeSize.isAccessibilitySize ? 14 : 12)
            }
            .safeAreaPadding(.top, 2)
            .safeAreaPadding(.bottom, 30)
        }
        .background {
            GeometryReader { proxy in
                Color.clear.preference(
                    key: ScanSurfaceBottomPreferenceKey.self,
                    value: proxy.frame(in: .global).maxY
                )
            }
            .ignoresSafeArea()
        }
        .onPreferenceChange(ScanBottomStackTopPreferenceKey.self) { top in
            bottomStackTopY = top
        }
        .onPreferenceChange(ScanSurfaceBottomPreferenceKey.self) { bottom in
            surfaceBottomY = bottom
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

    /// The staged strip, centered in its own row above the shutter row.
    ///
    /// Review used to share this row and drove a `ViewThatFits` single-line/
    /// stacked split, because five thumbnails hold 265pt of the 372pt gutter
    /// at every text size and whether Review's name fit beside them was a
    /// live question. #1009 moves Review into the bottom gallery/shutter/
    /// review row as a fixed-size circle, so nothing here competes with the
    /// strip for width anymore and the split is gone: the strip just centers.
    private var stagedControls: some View {
        photoProgress
    }

    /// How far above the screen's bottom edge the framing corners should end.
    ///
    /// One rule at every text size and every staged count: 18pt of daylight
    /// above whatever row the bottom control stack starts with. That is the
    /// staged strip once photos are staged and the shutter row before then, and
    /// the zoom row's own height varies with Dynamic Type, so the position is
    /// read from the rendered frames rather than summed from constants (#954).
    ///
    /// `nil` until both measurements have landed, which leaves the corners on
    /// their base inset for the first layout pass.
    private var framingCornersBottomEdge: CGFloat? {
        guard surfaceBottomY > 0, bottomStackTopY < .greatestFiniteMagnitude else {
            return nil
        }
        return surfaceBottomY - bottomStackTopY + 18
    }

    // A `ZStack` that absolutely centers the shutter over an independent `HStack` once let
    // an AX5-widened side control extend under the shutter, since nothing in a `ZStack`
    // keeps sibling views from overlapping (#864). A single `HStack` with two equally
    // flexible side regions keeps every control in its own non-overlapping region by
    // construction: SwiftUI splits leftover width evenly between `maxWidth: .infinity`
    // siblings, only yielding more to one side once the other no longer needs its share,
    // so the shutter stays centered at default sizes and the regions simply grow
    // asymmetrically at accessibility sizes instead of colliding.
    //
    // #885 swapped the occupants (flash left, library right, review moved above the row)
    // and kept the technique. #1009 swaps them again — gallery left, Review right, flash
    // moved up beside the close button — and Review is now a fixed-size circle rather than
    // a name-driven capsule, so both side regions stay fixed-size at every Dynamic Type
    // size and the guarantee still costs nothing. Review's region stays flexible even at
    // zero staged photos, when it renders nothing, so the shutter does not drift off center
    // the moment the first photo lands.
    private var cameraControls: some View {
        HStack {
            libraryControl()
                .disabled(!isLibraryEnabled)
                .frame(maxWidth: .infinity, alignment: .leading)

            shutterButton

            Group {
                if !thumbnailURLs.isEmpty {
                    reviewButton
                }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .padding(.horizontal, 18)
    }

    private var shutterButton: some View {
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
                        .padding(.horizontal, 15)
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
        // No trailing `Spacer`: #1009 gives the strip its own row with
        // nothing left to justify against, so its natural width is exactly
        // the thumbnail cluster's, which is what lets the row center it.
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
        .frame(width: 44, height: 56)
        .clipShape(.rect(cornerRadius: 8))
        .overlay { RoundedRectangle(cornerRadius: 8).stroke(SnapListColorToken.onDarkSurface.color.opacity(0.9), lineWidth: 1) }
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
    /// Absent means what it means on a real simulator: no ultra wide, so no
    /// zoom control.
    var zoomFixture: ScanZoomFixtureState? = nil

    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion

    @State private var zoomLens: ScanZoomLens = .wide

    private var reduceMotion: Bool { forceReducedMotion || systemReduceMotion }

    private var zoomControl: ScanZoomControl {
        zoomFixture?.control ?? .wideOnly
    }

    /// The live preview carries no dock. The recovery surfaces still do.
    ///
    /// This route used to float a dock over every state, on the reasoning that
    /// Scan is a primary destination and a capture without a dock would not be
    /// the shipping screen. The owner overruled that for the preview from the
    /// device (#885): the X in the top left already returns the seller where
    /// they came from, so a tab bar underneath is redundant, and the height it
    /// was taking is the height the photo strip and Review need. The real
    /// shell already hides the dock on the live preview, so this also stops
    /// the fixture from diverging from what ships.
    ///
    /// Recovery is not the preview. `AppShellView` gives those surfaces a dock
    /// in the real app, so the fixture keeps giving them one here.
    var body: some View {
        if carriesDock {
            surface.floatingDock(selectedTab: .scan, select: { _ in })
        } else {
            surface
        }
    }

    private var carriesDock: Bool {
        switch state {
        case .scanCameraUnavailable, .scanCameraDenied: true
        default: false
        }
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
                zoomControl: zoomControl,
                selectedZoomLens: zoomLens,
                selectZoomLens: { zoomLens = $0 },
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

/// The four corner brackets that frame the item in the preview.
///
/// Drawn to match the reference the owner supplied: the arms meet in a rounded
/// elbow rather than a sharp right angle, and the stroke is heavy enough to
/// read against a busy photo. Round caps finish the open ends so an arm does
/// not end in a cut edge.
private struct FramingCorners: View {
    let length: CGFloat
    let cornerRadius: CGFloat
    let lineWidth: CGFloat

    init(length: CGFloat = 24, cornerRadius: CGFloat = 14, lineWidth: CGFloat = 3) {
        self.length = length
        self.cornerRadius = cornerRadius
        self.lineWidth = lineWidth
    }

    var body: some View {
        Canvas { context, size in
            let color = SnapListColorToken.onDarkSurface.color.opacity(0.95)
            // A centered stroke would spill half its width past the canvas, so
            // the path runs inside by that much and the bracket stays whole.
            let inset = lineWidth / 2
            let minX = inset
            let minY = inset
            let maxX = size.width - inset
            let maxY = size.height - inset
            // An elbow can never be rounder than the arm it joins, or wider
            // than half the box it corners.
            let radius = min(cornerRadius, length, min(size.width, size.height) / 2)
            var path = Path()

            // Each corner is arm, elbow, arm. The quadratic's control point is
            // the sharp corner the elbow replaces.
            path.move(to: CGPoint(x: minX, y: minY + length))
            path.addLine(to: CGPoint(x: minX, y: minY + radius))
            path.addQuadCurve(
                to: CGPoint(x: minX + radius, y: minY),
                control: CGPoint(x: minX, y: minY)
            )
            path.addLine(to: CGPoint(x: minX + length, y: minY))

            path.move(to: CGPoint(x: maxX - length, y: minY))
            path.addLine(to: CGPoint(x: maxX - radius, y: minY))
            path.addQuadCurve(
                to: CGPoint(x: maxX, y: minY + radius),
                control: CGPoint(x: maxX, y: minY)
            )
            path.addLine(to: CGPoint(x: maxX, y: minY + length))

            path.move(to: CGPoint(x: maxX, y: maxY - length))
            path.addLine(to: CGPoint(x: maxX, y: maxY - radius))
            path.addQuadCurve(
                to: CGPoint(x: maxX - radius, y: maxY),
                control: CGPoint(x: maxX, y: maxY)
            )
            path.addLine(to: CGPoint(x: maxX - length, y: maxY))

            path.move(to: CGPoint(x: minX + length, y: maxY))
            path.addLine(to: CGPoint(x: minX + radius, y: maxY))
            path.addQuadCurve(
                to: CGPoint(x: minX, y: maxY - radius),
                control: CGPoint(x: minX, y: maxY)
            )
            path.addLine(to: CGPoint(x: minX, y: maxY - length))

            context.stroke(
                path,
                with: .color(color),
                style: StrokeStyle(lineWidth: lineWidth, lineCap: .round, lineJoin: .round)
            )
        }
    }
}

private struct ResponsiveFramingCorners: View {
    /// Extra clearance for control rows the caller shows below the preview.
    ///
    /// The base insets were tuned against the control stack as it stood before
    /// #885. Rather than re-tune them for every combination of optional rows,
    /// a caller adds exactly the height of the rows it introduced, so the
    /// margin the corners had is the margin they keep.
    var additionalBottomInset: CGFloat = 0
    /// Where the bottom edge should sit, measured up from the container's
    /// bottom, when the caller knows that exactly.
    ///
    /// A caller that has measured its own control stack can say where the
    /// corners end instead of describing how far its stack drifted from the
    /// stack the base inset was tuned against. Takes precedence over
    /// `additionalBottomInset`.
    var bottomEdgeAboveContainerBottom: CGFloat?

    var body: some View {
        GeometryReader { proxy in
            let isCompactHeight = proxy.size.height <= 700
            let horizontalInset: CGFloat = proxy.size.width <= 375 ? 28 : 34
            let topInset: CGFloat = isCompactHeight ? 112 : 140
            let bottomInset: CGFloat = bottomEdgeAboveContainerBottom
                ?? ((isCompactHeight ? 264 : 300) + additionalBottomInset)
            FramingCorners(
                length: isCompactHeight ? 34 : 42,
                cornerRadius: isCompactHeight ? 12 : 15,
                lineWidth: isCompactHeight ? 2.5 : 3
            )
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
                    Label(captured ? "1 of 5 photos" : "Auto", systemImage: captured ? "photo.stack" : "bolt.slash.fill")
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
