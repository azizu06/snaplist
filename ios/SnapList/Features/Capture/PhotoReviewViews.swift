import PhotosUI
import SwiftUI
import UIKit
#if DEBUG
import ImageIO
#endif

@MainActor
@Observable
final class PhotoReviewActionPresentation {
    private(set) var focusedPhotoID: StagedCapturePhoto.ID?

    @discardableResult
    func dismissOutside(
        store: PhotoReviewStore
    ) -> StagedCapturePhoto.ID? {
        guard let photoID = store.dismissActions() else {
            return nil
        }
        focusedPhotoID = photoID
        return photoID
    }
}

@MainActor
@Observable
final class PhotoReviewAccessibilityActionPresentation {
    private(set) var focusedPhotoID: StagedCapturePhoto.ID?
    private(set) var pendingAnnouncement: String?

    func availableActions(
        for photoID: StagedCapturePhoto.ID,
        in store: PhotoReviewStore
    ) -> [PhotoReviewReorderAction] {
        guard let index = store.photos.firstIndex(where: { $0.id == photoID }),
              store.photos.count > 1 else {
            return []
        }

        var actions: [PhotoReviewReorderAction] = []
        if index > 0 {
            actions.append(.moveEarlier)
        }
        if index < store.photos.index(before: store.photos.endIndex) {
            actions.append(.moveLater)
        }
        if index > 0 {
            actions.append(.makeCover)
        }
        return actions
    }

    @discardableResult
    func perform(
        _ action: PhotoReviewReorderAction,
        photoID: StagedCapturePhoto.ID,
        store: PhotoReviewStore
    ) -> PhotoReviewReorderResult? {
        guard availableActions(for: photoID, in: store).contains(action),
              let result = store.performAccessibilityReorder(
                photoID: photoID,
                action: action
              ) else {
            return nil
        }
        focusedPhotoID = result.photoID
        pendingAnnouncement = result.announcement
        return result
    }

    func consumeAnnouncement() -> String? {
        defer { pendingAnnouncement = nil }
        return pendingAnnouncement
    }
}

/// Photo Review v1.1/v1.2 REV-03. One to five ordered photos, and at five the Add tile
/// stays visible but stops being an action.
enum PhotoReviewCapacityPolicy {
    static let photoLimit = 5

    static func remainingCapacity(photoCount: Int) -> Int {
        max(0, photoLimit - photoCount)
    }

    static func isAddEnabled(photoCount: Int) -> Bool {
        remainingCapacity(photoCount: photoCount) > 0
    }

    /// v1.1/v1.2 accessibility_copy.add and .add_at_cap, without the trailing role word
    /// the system already speaks for a button.
    static func addAccessibilityLabel(photoCount: Int) -> String {
        isAddEnabled(photoCount: photoCount)
            ? "Add photos"
            : "Add photos, unavailable at five photo limit"
    }
}

/// Says the five-photo limit once per arrival at it.
@MainActor
@Observable
final class PhotoReviewCapacityAnnouncer {
    private(set) var hasAnnouncedLimit = false

    func consumeAnnouncement(photoCount: Int) -> String? {
        guard !PhotoReviewCapacityPolicy.isAddEnabled(photoCount: photoCount) else {
            // Below the limit again, so the next arrival is a real transition and not a
            // repeat of one the seller already heard.
            hasAnnouncedLimit = false
            return nil
        }
        guard !hasAnnouncedLimit else {
            return nil
        }
        hasAnnouncedLimit = true
        // Photo Review v1.1/v1.2 REV-03 five-photo limit announcement.
        return "Five photos added. Five photo limit reached."
    }
}

@MainActor
@Observable
final class PhotoReviewPickerPresentation {
    private(set) var isPresented = false
    private(set) var cancellationFocus: PhotoReviewPickerOpener?

    @discardableResult
    func present(
        _ request: PhotoReviewPickerRequest,
        store: PhotoReviewStore
    ) -> Bool {
        // Add is capacity work and Replace is not, so only Add can be refused here.
        if case .add = request,
           !PhotoReviewCapacityPolicy.isAddEnabled(photoCount: store.photos.count) {
            return false
        }
        cancellationFocus = nil
        store.beginPickerRequest(request)
        isPresented = true
        return true
    }

    @discardableResult
    func dismiss(
        hasConfirmedSelection: Bool,
        store: PhotoReviewStore
    ) -> PhotoReviewPickerOpener? {
        guard isPresented else {
            return nil
        }

        isPresented = false
        guard !hasConfirmedSelection else {
            cancellationFocus = nil
            return nil
        }

        guard let opener = store.cancelPickerRequest() else {
            return nil
        }
        cancellationFocus = opener
        return opener
    }
}

/// What one bounded system-picker transaction did to the live Photo Review store.
enum PhotoReviewIntakeOutcome: Equatable {
    /// Nothing changed. No active picker request matched this delivery.
    case inert
    case applied(appliedPhotos: [StagedCapturePhoto])
}

/// Loads the seller's chosen picker items and stages each one through the durable
/// #438 seam before it reaches the live store, so what Photo Review shows and what
/// Scan can recover never disagree.
@MainActor
final class PhotoReviewIntake {
    private let draftStore: any CaptureDraftStoring

    init(draftStore: any CaptureDraftStoring) {
        self.draftStore = draftStore
    }

    @discardableResult
    func apply<Item: CaptureLibraryPhotoLoading>(
        _ items: [Item],
        to store: PhotoReviewStore
    ) async -> PhotoReviewIntakeOutcome {
        guard let request = store.activePickerRequest, let firstItem = items.first else {
            return .inert
        }

        switch request {
        case .add:
            let stagedPhotos = await stageAdditions(items)
            guard !stagedPhotos.isEmpty,
                  store.confirmPickerResult(.additions(stagedPhotos)) != nil else {
                // The request has to end either way. Leaving it open would keep Start
                // listing disabled behind a picker that is no longer on screen.
                store.cancelPickerRequest()
                return .inert
            }
            return .applied(appliedPhotos: stagedPhotos)

        case .replace(let photoID):
            guard let staged = await stageReplacement(firstItem, for: photoID),
                  store.confirmPickerResult(.replacement(staged)) != nil else {
                store.cancelPickerRequest()
                return .inert
            }
            return .applied(appliedPhotos: [staged])
        }
    }

    private func stageAdditions<Item: CaptureLibraryPhotoLoading>(
        _ items: [Item]
    ) async -> [StagedCapturePhoto] {
        var stagedPhotos: [StagedCapturePhoto] = []
        for item in items {
            // One item at a time: read, make it durable, then read the next. Holding the
            // whole selection in memory would stake every chosen photo on the last write.
            guard let imageData = try? await item.loadPhotoData(),
                  let staged = try? await draftStore.append(
                    imageData: imageData,
                    libraryTransferReceipt: nil
                  ).appendedPhoto else {
                break
            }
            stagedPhotos.append(staged)
        }
        return stagedPhotos
    }

    private func stageReplacement<Item: CaptureLibraryPhotoLoading>(
        _ item: Item,
        for photoID: StagedCapturePhoto.ID
    ) async -> StagedCapturePhoto? {
        guard let imageData = try? await item.loadPhotoData() else {
            return nil
        }
        return try? await draftStore.replace(
            photoID: photoID,
            imageData: imageData,
            libraryTransferReceipt: nil
        ).replacementPhoto
    }
}

#if DEBUG
@MainActor
struct PhotoReviewFixtureView: View {
    @State private var store: PhotoReviewStore

    init(state: PhotoReviewVisualStateID) {
        _store = State(
            initialValue: PhotoReviewStore(
                photos: Self.photos(for: state)
            )
        )
    }

    var body: some View {
        // REV-02 is a fixture-only state: it stages no live session, so delete is inert.
        PhotoReviewView(
            store: store,
            delete: { nil }
        )
    }

    static func photos(
        for state: PhotoReviewVisualStateID,
        rootDirectory: URL = FileManager.default.temporaryDirectory,
        beforePhotoConstruction: () -> Void = {}
    ) -> [StagedCapturePhoto] {
        do {
            try FileManager.default.createDirectory(
                at: rootDirectory,
                withIntermediateDirectories: true
            )
        } catch {
            preconditionFailure(
                "REV-02 fixture directory could not be created at \(rootDirectory.path): \(error)"
            )
        }

        switch state {
        case .resting:
            let descriptors = (1...3).map { index in
                (
                    id: UUID(
                        uuidString: "45500000-0000-4000-8000-\(String(format: "%012d", index))"
                    )!,
                    photoURL: rootDirectory.appendingPathComponent(
                        "photo-review-\(index).jpg"
                    ),
                    thumbnailURL: rootDirectory.appendingPathComponent(
                        "photo-review-thumb-\(index).jpg"
                    ),
                    createdAt: Date(timeIntervalSinceReferenceDate: Double(index))
                )
            }
            for (offset, descriptor) in descriptors.enumerated() {
                materializeImages(
                    at: [descriptor.photoURL, descriptor.thumbnailURL],
                    ordinal: offset + 1
                )
            }
            return descriptors.map { descriptor in
                beforePhotoConstruction()
                return StagedCapturePhoto(
                    id: descriptor.id,
                    photoURL: descriptor.photoURL,
                    thumbnailURL: descriptor.thumbnailURL,
                    createdAt: descriptor.createdAt
                )
            }
        }
    }

    private static func materializeImages(
        at urls: [URL],
        ordinal: Int
    ) {
        guard urls.contains(where: { !isValidFixtureImage(at: $0) }) else {
            return
        }

        let colors = [
            UIColor(red: 0.86, green: 0.72, blue: 0.55, alpha: 1),
            UIColor(red: 0.52, green: 0.68, blue: 0.72, alpha: 1),
            UIColor(red: 0.74, green: 0.66, blue: 0.78, alpha: 1)
        ]
        let size = CGSize(width: 1_200, height: 900)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.preferredRange = .standard
        let data = UIGraphicsImageRenderer(size: size, format: format).jpegData(
            withCompressionQuality: 0.92
        ) { context in
            colors[ordinal - 1].setFill()
            context.fill(CGRect(origin: .zero, size: size))
            UIColor.black.withAlphaComponent(0.55).setFill()
            context.fill(
                CGRect(
                    x: size.width * 0.24,
                    y: size.height * 0.18,
                    width: size.width * 0.52,
                    height: size.height * 0.64
                )
            )
        }

        for url in urls where !isValidFixtureImage(at: url) {
            do {
                try data.write(to: url, options: .atomic)
            } catch {
                preconditionFailure(
                    "REV-02 fixture image could not be written at \(url.path): \(error)"
                )
            }
            precondition(
                isValidFixtureImage(at: url),
                "REV-02 fixture image is invalid at \(url.path)"
            )
        }
    }

    private static func isValidFixtureImage(at url: URL) -> Bool {
        guard
            let source = CGImageSourceCreateWithURL(url as CFURL, nil),
            CGImageSourceGetType(source) as String? == "public.jpeg",
            let properties = CGImageSourceCopyPropertiesAtIndex(
                source,
                0,
                nil
            ) as? [CFString: Any],
            (properties[kCGImagePropertyPixelWidth] as? NSNumber)?
                .intValue == 1_200,
            (properties[kCGImagePropertyPixelHeight] as? NSNumber)?
                .intValue == 900
        else {
            return false
        }
        return CGImageSourceCreateThumbnailAtIndex(
            source,
            0,
            [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 1_200
            ] as CFDictionary
        ) != nil
    }
}
#endif

/// The two typed boundaries Photo Review opens. Photo Review owns neither
/// destination: #469 owns the Voice recorder interior and which approved VOX state
/// it resolves to, and #457 owns submission transport. Emitting one of these makes
/// no claim about recording, upload, acceptance, queueing, AI work, or credit use.
enum PhotoReviewBoundaryEvent: Equatable {
    case openVoiceNote
    case startListing
}

/// When the approved Start listing control is offered.
enum PhotoReviewStartListingPolicy {
    static func isEnabled(photoCount: Int, isPickerActive: Bool) -> Bool {
        (1...5).contains(photoCount) && !isPickerActive
    }
}

/// What Photo Review should do after one accepted delete: where the accessibility
/// cursor lands, and the one count sentence the seller hears.
struct PhotoReviewDeleteApplication: Equatable {
    let focus: PhotoReviewDeleteFocus
    let announcement: String
}

struct PhotoReviewLiveDeleteResult: Equatable {
    let focus: PhotoReviewDeleteFocus
    let announcement: String
}

struct PhotoReviewLiveFinalDeleteResult: Equatable {
    let scanReturn: PhotoReviewScanReturn
    let announcement: String
}

@MainActor
final class PhotoReviewLiveSession {
    let store: PhotoReviewStore
    private(set) var focusedPhotoID: StagedCapturePhoto.ID?
    private var pendingDeleteAnnouncement: String?

    private init(store: PhotoReviewStore) {
        self.store = store
    }

    static func start(
        from request: CaptureBoundaryRequest?
    ) -> PhotoReviewLiveSession? {
        guard let request,
              request.destination == .photoReview,
              request.opener == .reviewButton,
              (1...5).contains(request.photos.count) else {
            return nil
        }
        return PhotoReviewLiveSession(
            store: PhotoReviewStore(photos: request.photos)
        )
    }

    @discardableResult
    func scanReturn() -> PhotoReviewScanReturn {
        PhotoReviewScanReturn(
            photos: store.photos,
            focus: .reviewButton
        )
    }

    @discardableResult
    func deleteNonFinalPhoto(
        id: StagedCapturePhoto.ID
    ) -> PhotoReviewLiveDeleteResult? {
        // Decide before mutating. Folding the store write into the guard list would let
        // a later clause fail with the photo already gone while reporting no delete.
        guard store.photos.count > 1, store.photos.contains(where: { $0.id == id }) else {
            return nil
        }
        guard case .photo(let focusedPhotoID)? =
                store.deletePhotoForReview(id: id) else {
            return nil
        }

        // Photo Review v1.2 accessibility_copy.remove_announcement_template.
        let announcement = "Photo removed. \(store.photos.count) of 5."
        self.focusedPhotoID = focusedPhotoID
        pendingDeleteAnnouncement = announcement
        return PhotoReviewLiveDeleteResult(
            focus: .photo(focusedPhotoID),
            announcement: announcement
        )
    }

    func consumeDeleteAnnouncement() -> String? {
        defer { pendingDeleteAnnouncement = nil }
        return pendingDeleteAnnouncement
    }
}

@MainActor
@Observable
final class PhotoReviewLiveHost {
    private(set) var session: PhotoReviewLiveSession?
    /// True while an exit transaction is between its snapshot and its commit.
    ///
    /// Both exits await durable work, and the screen stays mounted across that await.
    /// Without this the seller could reorder or delete in the gap, hear the edit
    /// announced, and then watch the pre-await snapshot commit over it.
    private(set) var isCommitting = false
    private var activeRequest: CaptureBoundaryRequest?
    private var pendingFinalDeleteAnnouncement: String?

    func beginCommit() -> Bool {
        guard !isCommitting else {
            return false
        }
        isCommitting = true
        return true
    }

    func endCommit() {
        isCommitting = false
    }

    @discardableResult
    func consume(
        _ request: CaptureBoundaryRequest?
    ) -> Bool {
        guard let request else {
            return false
        }
        if activeRequest == request, session != nil {
            return false
        }
        guard let session = PhotoReviewLiveSession.start(from: request) else {
            return false
        }
        activeRequest = request
        self.session = session
        return true
    }

    @discardableResult
    func deleteFinalPhoto(
        id: StagedCapturePhoto.ID,
        using router: AppRouter
    ) -> PhotoReviewLiveFinalDeleteResult? {
        guard let session,
              session.store.photos.count == 1,
              case .addButton? =
                session.store.deletePhotoForReview(id: id) else {
            return nil
        }

        let scanReturn = PhotoReviewScanReturn(
            photos: [],
            focus: .addPhotoButton
        )
        // Photo Review v1.2 accessibility_copy.remove_last_announcement. The approved
        // catalog states the outcome and deliberately does not narrate navigation.
        let announcement = "Photo removed. No photos remain."
        router.returnFromPhotoReview(scanReturn)
        self.session = nil
        activeRequest = nil
        pendingFinalDeleteAnnouncement = announcement
        return PhotoReviewLiveFinalDeleteResult(
            scanReturn: scanReturn,
            announcement: announcement
        )
    }

    func consumeFinalDeleteAnnouncement() -> String? {
        defer { pendingFinalDeleteAnnouncement = nil }
        return pendingFinalDeleteAnnouncement
    }

    @discardableResult
    func completeReturnToScan(
        from returningSession: PhotoReviewLiveSession
    ) -> Bool {
        guard session === returningSession else {
            return false
        }
        session = nil
        activeRequest = nil
        return true
    }
}

enum PhotoReviewBackOutcome: Equatable {
    case persistenceRejected
    case sessionChanged
    case completed(PhotoReviewScanReturn)
}

@MainActor
enum PhotoReviewBackCoordinator {
    static func perform(
        session: PhotoReviewLiveSession,
        captureFlow: CaptureFlowModel,
        host: PhotoReviewLiveHost
    ) async -> PhotoReviewBackOutcome {
        let request = session.scanReturn()
        guard let focus = await captureFlow.applyPhotoReviewScanReturn(
            request
        ) else {
            return .persistenceRejected
        }

        await captureFlow.startCamera()
        guard host.completeReturnToScan(from: session) else {
            return .sessionChanged
        }

        return .completed(
            PhotoReviewScanReturn(
                photos: request.photos,
                focus: focus
            )
        )
    }
}

@MainActor
struct PhotoReviewView: View {
    @Bindable var store: PhotoReviewStore
    /// Set while an exit transaction is committing, so the seller cannot make an edit
    /// that the in-flight snapshot would silently discard.
    var isCommitting: Bool = false
    var backToCamera: (() -> Void)? = nil
    let delete: () async -> PhotoReviewDeleteApplication?
    var openBoundary: ((PhotoReviewBoundaryEvent) -> Void)? = nil

    @State private var actionPresentation = PhotoReviewActionPresentation()
    @State private var accessibilityActionPresentation =
        PhotoReviewAccessibilityActionPresentation()
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var pickerPresentation = PhotoReviewPickerPresentation()
    // Outside dismissal focus stays independent from picker cancellation focus.
    @AccessibilityFocusState private var focusedThumbnailID: StagedCapturePhoto.ID?
    @AccessibilityFocusState private var focusedPickerOpener: PickerFocusTarget?

    private enum PickerFocusTarget: Hashable {
        case addButton
        case replaceButton(photoID: StagedCapturePhoto.ID)
    }

    private var selectedPhoto: StagedCapturePhoto? {
        store.photos.first(where: { $0.id == store.selectedPhotoID })
            ?? store.photos.first
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                topBar
                hero
                thumbnailStrip

                if store.actionsPhotoID != nil {
                    actionRow
                }

                if let openBoundary {
                    voiceRow(openBoundary)
                }
            }
            .padding(.horizontal, SnapListMetrics.screenGutter)
            .padding(.vertical, 16)
        }
        // The screen identity stays on the scrolling region itself, so the sticky action
        // below is genuinely outside the scrollable content rather than merely painted
        // over it.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("photo-review.screen")
        // v1.2 primary_action.position is a sticky bottom action above the home-indicator
        // safe area, and its adaptive-layout contract requires that action never cover the
        // thumbnails, Voice context, or the home indicator. safeAreaInset pins it there and
        // shortens the scrollable region by exactly its height, so it covers nothing.
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if let openBoundary {
                startListingControl(openBoundary)
                    .padding(.horizontal, SnapListMetrics.screenGutter)
                    .padding(.vertical, 12)
            }
        }
        .background {
            SnapListColorToken.groupingFill.color
                .contentShape(.rect)
                .onTapGesture(perform: dismissActionsOutside)
        }
        .disabled(isCommitting)
        .photosPicker(
            isPresented: pickerIsPresented,
            selection: $pickerItems,
            maxSelectionCount: pickerSelectionLimit,
            matching: .images
        )
        .onChange(of: pickerItems) { _, items in
            guard !items.isEmpty else { return }
            _ = pickerPresentation.dismiss(
                hasConfirmedSelection: true,
                store: store
            )
        }
    }

    private var topBar: some View {
        HStack(alignment: .firstTextBaseline) {
            if let backToCamera {
                // v1.2 top_bar requires a 44pt minimum target, and its Dynamic Type rule
                // expects this row to grow rather than clip. A fixed vertical padding
                // cannot hold that floor, because the padded height follows the text: at
                // xSmall it measured 40.33pt. Sizing from the floor itself holds at every
                // type size, and matches every other control on this screen.
                Button(action: backToCamera) {
                    Text("Back to camera")
                        .frame(minHeight: SnapListMetrics.minimumTouchTarget)
                        .contentShape(Rectangle())
                }
                .accessibilityIdentifier("photo-review.back")
            }

            Text("Review photos")
                .snapListTypography(.sectionHeader)
                .foregroundStyle(SnapListColorToken.inkPrimary.color)

            Spacer(minLength: 12)

            Text("\(store.photos.count) of 5")
                .snapListTypography(.metadata)
                .foregroundStyle(SnapListColorToken.textSecondary.color)
                .accessibilityIdentifier("photo-review.count")
        }
    }

    @ViewBuilder
    private var hero: some View {
        if let selectedPhoto,
           let selectedIndex = store.photos.firstIndex(where: { $0.id == selectedPhoto.id }) {
            Button {
                store.selectPhotoForActions(id: selectedPhoto.id)
            } label: {
                LocalCaptureImage(
                    url: selectedPhoto.photoURL,
                    maximumPixelSize: 1_200
                )
                .scaledToFill()
                .frame(maxWidth: .infinity)
                .frame(height: 300)
                .clipped()
                .clipShape(.rect(cornerRadius: 18))
                .accessibilityHidden(true)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(
                thumbnailAccessibilityLabel(index: selectedIndex, isSelected: true)
            )
            .accessibilityIdentifier("photo-review.hero")
        }
    }

    private var thumbnailStrip: some View {
        ScrollView(.horizontal) {
            HStack(alignment: .top, spacing: 12) {
                ForEach(Array(store.photos.enumerated()), id: \.element.id) { index, photo in
                    thumbnail(photo, index: index)
                }
                addButton
            }
            .padding(.vertical, 3)
        }
        .scrollIndicators(.hidden)
    }

    private func thumbnail(
        _ photo: StagedCapturePhoto,
        index: Int
    ) -> some View {
        let isSelected = photo.id == store.selectedPhotoID
        return VStack(spacing: 6) {
            Button {
                store.selectPhotoForActions(id: photo.id)
            } label: {
                LocalCaptureImage(
                    url: photo.thumbnailURL,
                    maximumPixelSize: 180
                )
                .scaledToFill()
                .frame(width: 76, height: 76)
                .clipped()
                .clipShape(.rect(cornerRadius: 12))
                .overlay {
                    RoundedRectangle(cornerRadius: 12)
                        .stroke(
                            isSelected ? SnapListColorToken.action.color : .clear,
                            lineWidth: 3
                        )
                }
                .accessibilityHidden(true)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(
                thumbnailAccessibilityLabel(index: index, isSelected: isSelected)
            )
            .accessibilityAddTraits(isSelected ? .isSelected : [])
            .accessibilityIdentifier("photo-review.thumbnail.\(index + 1)")
            .accessibilityFocused(
                $focusedThumbnailID,
                equals: photo.id
            )
            .accessibilityActions {
                let actions = accessibilityActionPresentation.availableActions(
                    for: photo.id,
                    in: store
                )
                if actions.contains(.moveEarlier) {
                    Button("Move earlier") {
                        performAccessibilityAction(.moveEarlier, photoID: photo.id)
                    }
                }
                if actions.contains(.moveLater) {
                    Button("Move later") {
                        performAccessibilityAction(.moveLater, photoID: photo.id)
                    }
                }
                if actions.contains(.makeCover) {
                    Button("Make cover") {
                        performAccessibilityAction(.makeCover, photoID: photo.id)
                    }
                }
            }

            if index == 0 {
                Text("Cover")
                    .snapListTypography(.metadata)
                    .fontWeight(.semibold)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .accessibilityIdentifier("photo-review.cover")
            }
        }
    }

    private func thumbnailAccessibilityLabel(
        index: Int,
        isSelected: Bool
    ) -> String {
        var truths = ["Photo \(index + 1) of \(store.photos.count)"]
        if index == 0 {
            truths.append("Cover")
        }
        if isSelected {
            truths.append("selected")
        }
        return truths.joined(separator: ", ")
    }

    private var addButton: some View {
        Button {
            presentPicker(.add)
        } label: {
            VStack(spacing: 2) {
                Image(systemName: "plus")
                    .font(.system(size: 20, weight: .semibold))
                Text("Add")
                    .snapListTypography(.metadata)
                    .fontWeight(.semibold)
            }
            .foregroundStyle(SnapListColorToken.textSecondary.color)
            .frame(
                width: 76,
                height: 76
            )
            .background(SnapListColorToken.canvas.color)
            .clipShape(.rect(cornerRadius: 12))
            .overlay {
                RoundedRectangle(cornerRadius: 12)
                    .stroke(
                        SnapListColorToken.textSecondary.color.opacity(0.55),
                        style: StrokeStyle(lineWidth: 1.5, dash: [5])
                    )
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Add photos")
        .accessibilityIdentifier("photo-review.add")
        .accessibilityFocused(
            $focusedPickerOpener,
            equals: .addButton
        )
    }

    @ViewBuilder
    private var actionRow: some View {
        HStack(spacing: 12) {
            if let photoID = store.actionsPhotoID {
                Button("Replace") {
                    presentPicker(.replace(photoID: photoID))
                }
                .frame(maxWidth: .infinity, minHeight: SnapListMetrics.minimumTouchTarget)
                .buttonStyle(.bordered)
                .accessibilityLabel("Replace this photo")
                .accessibilityIdentifier("photo-review.replace")
                .accessibilityFocused(
                    $focusedPickerOpener,
                    equals: .replaceButton(photoID: photoID)
                )
            }

            Button("Delete", role: .destructive, action: performDelete)
                .frame(maxWidth: .infinity, minHeight: SnapListMetrics.minimumTouchTarget)
                .buttonStyle(.bordered)
                .accessibilityLabel("Delete this photo")
                .accessibilityIdentifier("photo-review.delete")
        }
    }

    // Voice context and Start listing are typed boundaries because of scope, not authority.
    // Photo Review v1.2 (d166d0c3) and Voice Note + Start Listing v2 (7fd7bd41) are both
    // packaged and in force, and v1.2 keeps the voice row's interior withheld from its own
    // package. This issue owns the two boundaries and their typed events. The recorder
    // interior is #469, and making Photo Review the single renderer of the collapsed voice
    // row is #490, which is blocked on a design delta that does not exist yet. So this
    // renders the approved control names, the approved enabling rule, and the approved
    // order of the voice row above Start listing, and nothing beyond them.
    private func voiceRow(
        _ openBoundary: @escaping (PhotoReviewBoundaryEvent) -> Void
    ) -> some View {
        Button {
            openBoundary(.openVoiceNote)
        } label: {
            Text("Voice context")
                .frame(
                    maxWidth: .infinity,
                    minHeight: SnapListMetrics.minimumTouchTarget
                )
        }
        .buttonStyle(.bordered)
        // v1.2 owns this screen and names the row "Voice context". Its optional and
        // collapsed state is structural, so a seller who cannot see the row still learns
        // it is skippable and not yet expanded. v2 owns the recorder interior, #469, and
        // does not name this control.
        .accessibilityLabel("Voice context, optional, collapsed")
        .accessibilityIdentifier("photo-review.voice")
    }

    private func startListingControl(
        _ openBoundary: @escaping (PhotoReviewBoundaryEvent) -> Void
    ) -> some View {
        Button {
            openBoundary(.startListing)
        } label: {
            Text("Start listing")
                .frame(
                    maxWidth: .infinity,
                    minHeight: SnapListMetrics.minimumTouchTarget
                )
        }
        .buttonStyle(.borderedProminent)
        .disabled(
            !PhotoReviewStartListingPolicy.isEnabled(
                photoCount: store.photos.count,
                isPickerActive: store.activePickerRequest != nil
            )
        )
        .accessibilityIdentifier("photo-review.start-listing")
    }

    private var pickerIsPresented: Binding<Bool> {
        Binding(
            get: { pickerPresentation.isPresented },
            set: { isPresented in
                guard !isPresented else { return }
                restorePickerCancellationFocus(
                    pickerPresentation.dismiss(
                        hasConfirmedSelection: !pickerItems.isEmpty,
                        store: store
                    )
                )
            }
        )
    }

    private var pickerSelectionLimit: Int? {
        guard case .replace = store.activePickerRequest else {
            return nil
        }
        return 1
    }

    private func presentPicker(_ request: PhotoReviewPickerRequest) {
        pickerItems = []
        focusedPickerOpener = nil
        pickerPresentation.present(request, store: store)
    }

    private func performDelete() {
        Task {
            guard let application = await delete() else { return }
            switch application.focus {
            case .photo(let photoID):
                focusedThumbnailID = photoID
            case .addButton:
                focusedPickerOpener = .addButton
            }
            UIAccessibility.post(
                notification: .announcement,
                argument: application.announcement
            )
        }
    }

    private func dismissActionsOutside() {
        guard let photoID = actionPresentation.dismissOutside(store: store) else {
            return
        }
        focusedThumbnailID = photoID
    }

    private func performAccessibilityAction(
        _ action: PhotoReviewReorderAction,
        photoID: StagedCapturePhoto.ID
    ) {
        guard let result = accessibilityActionPresentation.perform(
            action,
            photoID: photoID,
            store: store
        ) else {
            return
        }

        focusedThumbnailID = result.photoID
        guard let announcement =
                accessibilityActionPresentation.consumeAnnouncement() else {
            return
        }
        UIAccessibility.post(
            notification: .announcement,
            argument: announcement
        )
    }

    private func restorePickerCancellationFocus(
        _ opener: PhotoReviewPickerOpener?
    ) {
        switch opener {
        case .addButton:
            focusedPickerOpener = .addButton
        case .replaceButton(let photoID):
            focusedPickerOpener = .replaceButton(photoID: photoID)
        case nil:
            break
        }
    }
}
