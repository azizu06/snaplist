import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers
#if DEBUG
import ImageIO
#endif

@MainActor
@Observable
final class PhotoReviewDragPresentation {
    private(set) var draggedPhotoID: StagedCapturePhoto.ID?
    private(set) var insertionIndex: Int?
    private(set) var pendingFocusPhotoID: StagedCapturePhoto.ID?
    private(set) var pendingAnnouncement: String?
    @ObservationIgnored private var cancellationTask: Task<Void, Never>?

    func begin(
        photoID: StagedCapturePhoto.ID,
        store: PhotoReviewStore
    ) -> Bool {
        guard store.photos.count > 1,
              store.photos.contains(where: { $0.id == photoID }) else {
            return false
        }
        cancellationTask?.cancel()
        pendingFocusPhotoID = nil
        pendingAnnouncement = nil
        draggedPhotoID = photoID
        insertionIndex = store.photos.firstIndex(where: { $0.id == photoID })
        return true
    }

    func updateInsertion(
        to destinationIndex: Int,
        store: PhotoReviewStore,
        reduceMotion: Bool
    ) {
        guard draggedPhotoID != nil,
              store.photos.indices.contains(destinationIndex) else {
            return
        }
        cancellationTask?.cancel()
        guard insertionIndex != destinationIndex else {
            return
        }
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.16)) {
            insertionIndex = destinationIndex
        }
    }

    @discardableResult
    func commit(
        to destinationIndex: Int,
        store: PhotoReviewStore,
        reduceMotion: Bool
    ) -> PhotoReviewReorderResult? {
        guard let photoID = draggedPhotoID else {
            return nil
        }
        cancellationTask?.cancel()
        let result = store.performDragReorder(
            photoID: photoID,
            to: destinationIndex
        )
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.16)) {
            draggedPhotoID = nil
            insertionIndex = nil
        }
        pendingFocusPhotoID = photoID
        pendingAnnouncement = result?.announcement
        return result
    }

    func scheduleCancellation(reduceMotion: Bool) {
        guard draggedPhotoID != nil else {
            return
        }
        cancellationTask?.cancel()
        cancellationTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else {
                return
            }
            self?.cancel(reduceMotion: reduceMotion)
        }
    }

    func cancel(reduceMotion: Bool) {
        guard let photoID = draggedPhotoID else {
            return
        }
        cancellationTask?.cancel()
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.16)) {
            draggedPhotoID = nil
            insertionIndex = nil
        }
        pendingFocusPhotoID = photoID
        pendingAnnouncement = nil
    }

    func consumeFocusPhotoID() -> StagedCapturePhoto.ID? {
        defer { pendingFocusPhotoID = nil }
        return pendingFocusPhotoID
    }

    func consumeAnnouncement() -> String? {
        defer { pendingAnnouncement = nil }
        return pendingAnnouncement
    }
}

@MainActor
private struct PhotoReviewThumbnailDropDelegate: DropDelegate {
    let destinationIndex: Int
    let store: PhotoReviewStore
    let presentation: PhotoReviewDragPresentation
    let reduceMotion: Bool
    var autoScroll: (() -> Void)? = nil

    func validateDrop(info: DropInfo) -> Bool {
        guard presentation.draggedPhotoID != nil else {
            return false
        }
        return info.hasItemsConforming(to: [UTType.plainText])
    }

    func dropEntered(info: DropInfo) {
        guard info.hasItemsConforming(to: [UTType.plainText]) else {
            return
        }
        presentation.updateInsertion(
            to: destinationIndex,
            store: store,
            reduceMotion: reduceMotion
        )
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        guard validateDrop(info: info) else {
            return DropProposal(operation: .cancel)
        }
        autoScroll?()
        return DropProposal(operation: .move)
    }

    func dropExited(info: DropInfo) {
        presentation.scheduleCancellation(reduceMotion: reduceMotion)
    }

    func performDrop(info: DropInfo) -> Bool {
        guard info.hasItemsConforming(to: [UTType.plainText]),
              presentation.draggedPhotoID != nil else {
            presentation.cancel(reduceMotion: reduceMotion)
            return false
        }
        presentation.commit(
            to: destinationIndex,
            store: store,
            reduceMotion: reduceMotion
        )
        return true
    }
}

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

/// What the seller is told, and where the cursor goes, when a picked photo could not be
/// made durable. Every photo that did land is already applied by the time this appears.
struct PhotoReviewIntakeRecovery: Equatable {
    let message: String
    let focus: PhotoReviewPickerOpener
}

/// Loads the seller's chosen picker items and stages each one through the durable
/// #438 seam before it reaches the live store, so what Photo Review shows and what
/// Scan can recover never disagree.
@MainActor
@Observable
final class PhotoReviewIntake {
    private(set) var recovery: PhotoReviewIntakeRecovery?
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
            let (stagedPhotos, stop) = await stageAdditions(
                items,
                for: request,
                in: store
            )
            guard stop != .abandoned else {
                // The seller left this transaction behind while it was still reading.
                // Anything it already wrote belongs to nobody, so take it back off disk.
                await rollBackAdditions(ifAny: stagedPhotos, keeping: store.photos)
                recovery = nil
                return .inert
            }
            guard !stagedPhotos.isEmpty,
                  store.confirmPickerResult(.additions(stagedPhotos)) != nil else {
                // The request has to end either way. Leaving it open would keep Start
                // listing disabled behind a picker that is no longer on screen.
                await rollBackAdditions(ifAny: stagedPhotos, keeping: store.photos)
                store.cancelPickerRequest()
                recovery = PhotoReviewIntakeRecovery(
                    message: Self.additionFailureMessage,
                    focus: .addButton
                )
                return .inert
            }
            recovery = stop == .loadFailed
                ? PhotoReviewIntakeRecovery(
                    message: Self.additionFailureMessage,
                    focus: .addButton
                  )
                : nil
            return .applied(appliedPhotos: stagedPhotos)

        case .replace(let photoID):
            guard let imageData = try? await firstItem.loadPhotoData() else {
                store.cancelPickerRequest()
                recovery = PhotoReviewIntakeRecovery(
                    message: Self.replacementFailureMessage,
                    focus: .replaceButton(photoID: photoID)
                )
                return .inert
            }
            // Re-read the request in the moment before the durable write. Replacement is
            // the one transaction that cannot be taken back: committing it retires the
            // photo it stands in for, and an abandoned transaction may not do that.
            guard store.activePickerRequest == request else {
                recovery = nil
                return .inert
            }
            guard let staged = try? await draftStore.replace(
                    photoID: photoID,
                    imageData: imageData,
                    libraryTransferReceipt: nil
                  ).replacementPhoto,
                  store.confirmPickerResult(.replacement(staged)) != nil else {
                store.cancelPickerRequest()
                recovery = PhotoReviewIntakeRecovery(
                    message: Self.replacementFailureMessage,
                    focus: .replaceButton(photoID: photoID)
                )
                return .inert
            }
            recovery = nil
            return .applied(appliedPhotos: [staged])
        }
    }

    // New seller-facing strings. The approved Photo Review copy catalog covers the
    // resting screen and its announcements but names no intake failure, so these say
    // only what is true: this photo did not land, and nothing the seller already had
    // moved or disappeared.
    private static let additionFailureMessage =
        "Photo could not be added. Nothing else changed."
    private static let replacementFailureMessage =
        "Photo could not be replaced. Nothing else changed."

    /// Why a run of additions stopped before it ran out of items.
    private enum AdditionStop {
        case completed
        case loadFailed
        /// The request being served is no longer the store's active one.
        case abandoned
    }

    private func stageAdditions<Item: CaptureLibraryPhotoLoading>(
        _ items: [Item],
        for request: PhotoReviewPickerRequest,
        in store: PhotoReviewStore
    ) async -> ([StagedCapturePhoto], AdditionStop) {
        var stagedPhotos: [StagedCapturePhoto] = []
        for item in items {
            // One item at a time: read, make it durable, then read the next. Holding the
            // whole selection in memory would stake every chosen photo on the last write.
            guard store.activePickerRequest == request else {
                return (stagedPhotos, .abandoned)
            }
            guard let imageData = try? await item.loadPhotoData() else {
                return (stagedPhotos, .loadFailed)
            }
            guard store.activePickerRequest == request else {
                return (stagedPhotos, .abandoned)
            }
            guard let staged = try? await draftStore.append(
                imageData: imageData,
                libraryTransferReceipt: nil
            ).appendedPhoto else {
                return (stagedPhotos, .loadFailed)
            }
            stagedPhotos.append(staged)
        }
        return (stagedPhotos, .completed)
    }

    private func rollBackAdditions(
        ifAny staged: [StagedCapturePhoto],
        keeping photos: [StagedCapturePhoto]
    ) async {
        guard !staged.isEmpty else {
            return
        }
        try? await draftStore.replacePhotos(with: photos)
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

        let descriptors = (1...state.photoCount).map { index in
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
            UIColor(red: 0.74, green: 0.66, blue: 0.78, alpha: 1),
            UIColor(red: 0.62, green: 0.76, blue: 0.60, alpha: 1),
            UIColor(red: 0.82, green: 0.62, blue: 0.60, alpha: 1)
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

/// The typed boundaries Photo Review opens. Photo Review owns neither destination:
/// #469 owns the Voice recorder interior and which approved VOX state it resolves to,
/// and submission stays behind its typed host. Emitting one of these makes no claim
/// about recording, upload, acceptance, queueing, AI work, or credit use.
enum PhotoReviewBoundaryEvent: Equatable {
    case openVoiceNote
    case startListing
    case retryAmbiguousSubmission(eventID: UUID)
    case reviewSubmission(eventID: UUID)
    case reviewConflictedSubmission(eventID: UUID)
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

    /// Leaves Photo Review because the intake it was editing is gone.
    ///
    /// Submission clears the draft on a validated receipt, and the same rule the final
    /// delete follows applies: with no photos left there is nothing to review, and the
    /// screen would otherwise render files that no longer exist.
    ///
    /// Takes the session it expects to leave, so a session replaced while the request
    /// was open is not torn down by an older transaction's result.
    func leaveForClearedIntake(
        from returningSession: PhotoReviewLiveSession,
        using router: AppRouter
    ) -> Bool {
        guard session === returningSession else {
            return false
        }
        router.returnFromPhotoReview(
            PhotoReviewScanReturn(photos: [], focus: .addPhotoButton)
        )
        session = nil
        activeRequest = nil
        return true
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
    var submissionPresentation: PhotoReviewSubmissionPresentation = .idle
    var postSubmissionAnnouncement: (String) -> Void = {
        UIAccessibility.post(notification: .announcement, argument: $0)
    }
    var acknowledgeSubmissionPresentation: (UUID) -> Void = { _ in }
    var backToCamera: (() -> Void)? = nil
    let delete: () async -> PhotoReviewDeleteApplication?
    var openBoundary: ((PhotoReviewBoundaryEvent) -> Void)? = nil
    /// Absent in fixtures, which stage no durable session and so cannot apply a picker
    /// result. The picker still opens; nothing lands.
    var intake: PhotoReviewIntake? = nil

    @State private var actionPresentation = PhotoReviewActionPresentation()
    @State private var accessibilityActionPresentation =
        PhotoReviewAccessibilityActionPresentation()
    @State private var dragPresentation = PhotoReviewDragPresentation()
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var pickerPresentation = PhotoReviewPickerPresentation()
    @State private var capacityAnnouncer = PhotoReviewCapacityAnnouncer()
    @State private var submissionEffectConsumer =
        PhotoReviewSubmissionEffectConsumer()
    // Outside dismissal focus stays independent from picker cancellation focus.
    @AccessibilityFocusState private var focusedThumbnailID: StagedCapturePhoto.ID?
    @AccessibilityFocusState private var focusedPickerOpener: PickerFocusTarget?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private enum PickerFocusTarget: Hashable {
        case addButton
        case replaceButton(photoID: StagedCapturePhoto.ID)
    }

    private var selectedPhoto: StagedCapturePhoto? {
        store.photos.first(where: { $0.id == store.selectedPhotoID })
            ?? store.photos.first
    }

    var body: some View {
        Group {
            if submissionPresentation.rendersSubmittedMedia {
                reviewContent
                    .photosPicker(
                        isPresented: pickerIsPresented,
                        selection: $pickerItems,
                        maxSelectionCount: pickerSelectionLimit,
                        matching: .images
                    )
                    .onChange(of: pickerItems) { _, items in
                        guard !items.isEmpty else { return }
                        // Clear before applying so the next transaction starts from an
                        // empty selection and a redelivered result cannot be read as a
                        // new one.
                        pickerItems = []
                        _ = pickerPresentation.dismiss(
                            hasConfirmedSelection: true,
                            store: store
                        )
                        applyPickerSelection(items)
                    }
            } else {
                reviewContent
            }
        }
        .background {
            SnapListColorToken.groupingFill.color
                .contentShape(.rect)
                .onTapGesture(perform: dismissActionsOutside)
        }
        .disabled(
            isCommitting || submissionPresentation.mutationControlsLocked
        )
        .onChange(
            of: submissionPresentation,
            initial: true
        ) { _, presentation in
            submissionEffectConsumer.consume(
                presentation,
                postAnnouncement: postSubmissionAnnouncement,
                acknowledgePresentation: acknowledgeSubmissionPresentation
            )
        }
        .onChange(of: dragPresentation.pendingFocusPhotoID) { _, photoID in
            guard photoID != nil,
                  let focusPhotoID = dragPresentation.consumeFocusPhotoID() else {
                return
            }
            focusedThumbnailID = focusPhotoID
        }
        .onChange(of: dragPresentation.pendingAnnouncement) { _, announcement in
            guard announcement != nil,
                  let announcement = dragPresentation.consumeAnnouncement() else {
                return
            }
            UIAccessibility.post(
                notification: .announcement,
                argument: announcement
            )
        }
    }

    private var reviewContent: some View {
        ScrollView {
            VStack(spacing: 20) {
                topBar
                if let visibleMessage = submissionPresentation.visibleMessage {
                    Text(visibleMessage)
                        .snapListTypography(.body)
                        .foregroundStyle(SnapListColorToken.inkPrimary.color)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier(
                            "photo-review.submission-message"
                        )
                }
                if submissionPresentation.rendersSubmittedMedia {
                    hero
                    thumbnailStrip

                    if let recovery = intake?.recovery {
                        Text(recovery.message)
                            .snapListTypography(.metadata)
                            .foregroundStyle(SnapListColorToken.inkPrimary.color)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .accessibilityIdentifier("photo-review.intake-recovery")
                    }

                    if store.actionsPhotoID != nil {
                        actionRow
                    }

                    if let openBoundary {
                        voiceRow(openBoundary)
                    }
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
        ScrollViewReader { proxy in
            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: 12) {
                    ForEach(Array(store.photos.enumerated()), id: \.element.id) { index, photo in
                        thumbnail(photo, index: index)
                            .id(photo.id)
                    }
                    addButton
                }
                .padding(.vertical, 3)
            }
            .scrollIndicators(.hidden)
            .overlay {
                if dragPresentation.draggedPhotoID != nil,
                   !store.photos.isEmpty {
                    HStack(spacing: 0) {
                        edgeAutoScrollDropZone(
                            destinationIndex: 0,
                            proxy: proxy,
                            anchor: .leading
                        )
                        Spacer(minLength: 0)
                        edgeAutoScrollDropZone(
                            destinationIndex: store.photos.index(
                                before: store.photos.endIndex
                            ),
                            proxy: proxy,
                            anchor: .trailing
                        )
                    }
                }
            }
        }
    }

    private func thumbnail(
        _ photo: StagedCapturePhoto,
        index: Int
    ) -> some View {
        let isSelected = photo.id == store.selectedPhotoID
        let showsInsertionGap =
            dragPresentation.insertionIndex == index
            && dragPresentation.draggedPhotoID != photo.id
        let draggedSourceIndex = dragPresentation.draggedPhotoID.flatMap { draggedID in
            store.photos.firstIndex(where: { $0.id == draggedID })
        }
        let showsLeadingInsertionGap =
            showsInsertionGap && (draggedSourceIndex ?? index) > index
        let showsTrailingInsertionGap =
            showsInsertionGap && (draggedSourceIndex ?? index) < index
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
        // v1.2 interaction.drag.insertion_gap_px. This exists only while a native
        // drag is over a different ordinal, so the resting strip gains no control.
        .padding(.leading, showsLeadingInsertionGap ? 62 : 0)
        .padding(.trailing, showsTrailingInsertionGap ? 62 : 0)
        .opacity(dragPresentation.draggedPhotoID == photo.id ? 0.97 : 1)
        .onDrag {
            guard dragPresentation.begin(photoID: photo.id, store: store) else {
                return NSItemProvider()
            }
            return NSItemProvider(object: photo.id.uuidString as NSString)
        } preview: {
            LocalCaptureImage(
                url: photo.thumbnailURL,
                maximumPixelSize: 180
            )
            .scaledToFill()
            .frame(width: 76, height: 76)
            .clipped()
            .clipShape(.rect(cornerRadius: 12))
        }
        .onDrop(
            of: [UTType.plainText],
            delegate: PhotoReviewThumbnailDropDelegate(
                destinationIndex: index,
                store: store,
                presentation: dragPresentation,
                reduceMotion: reduceMotion
            )
        )
    }

    private func edgeAutoScrollDropZone(
        destinationIndex: Int,
        proxy: ScrollViewProxy,
        anchor: UnitPoint
    ) -> some View {
        Color.clear
            .frame(width: 28)
            .contentShape(Rectangle())
            .onDrop(
                of: [UTType.plainText],
                delegate: PhotoReviewThumbnailDropDelegate(
                    destinationIndex: destinationIndex,
                    store: store,
                    presentation: dragPresentation,
                    reduceMotion: reduceMotion,
                    autoScroll: {
                        scrollToPhoto(
                            at: destinationIndex,
                            proxy: proxy,
                            anchor: anchor
                        )
                    }
                )
            )
    }

    private func scrollToPhoto(
        at destinationIndex: Int,
        proxy: ScrollViewProxy,
        anchor: UnitPoint
    ) {
        guard store.photos.indices.contains(destinationIndex) else {
            return
        }
        if reduceMotion {
            proxy.scrollTo(store.photos[destinationIndex].id, anchor: anchor)
        } else {
            withAnimation(.easeInOut(duration: 0.16)) {
                proxy.scrollTo(store.photos[destinationIndex].id, anchor: anchor)
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

    private var isAddEnabled: Bool {
        PhotoReviewCapacityPolicy.isAddEnabled(photoCount: store.photos.count)
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
        // REV-03 keeps the tile in place at five photos and takes its action away, so
        // the strip does not reflow and the seller can see why nothing more fits. The
        // `0.5` does not depend on which package governs this attribute, because every
        // approved Photo Review package binds the capped tile to it. v1 and v1.1
        // (c2d84f02) carry `opacity: 0.5` inline on the tile labelled for the five-photo
        // limit, and v1.2 (d166d0c3) parameterises the same value as
        // `addOpacity: capd?0.5:1`. Read the capped instance specifically: v1.1's canvas
        // holds eighteen Add tiles and only one of them is the capped state, so sampling
        // the first one suggests `1` and invites exactly the change this comment exists to
        // prevent. No package binds this attribute in `contracts/`; the canvases are the
        // only record of it.
        .opacity(isAddEnabled ? 1 : 0.5)
        .disabled(!isAddEnabled)
        .accessibilityLabel(
            PhotoReviewCapacityPolicy.addAccessibilityLabel(
                photoCount: store.photos.count
            )
        )
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
            openBoundary(submissionPresentation.primaryActionEvent)
        } label: {
            Text(submissionPresentation.primaryActionLabel)
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
        switch store.activePickerRequest {
        case .replace:
            1
        case .add:
            // The picker itself refuses a sixth photo, so the seller never chooses one
            // and then watches it silently not arrive.
            PhotoReviewCapacityPolicy.remainingCapacity(photoCount: store.photos.count)
        case nil:
            nil
        }
    }

    private func presentPicker(_ request: PhotoReviewPickerRequest) {
        pickerItems = []
        guard pickerPresentation.present(request, store: store) else {
            return
        }
        focusedPickerOpener = nil
    }

    private func applyPickerSelection(_ selection: [PhotosPickerItem]) {
        guard let intake else {
            return
        }
        Task {
            let outcome = await intake.apply(selection, to: store)
            if let recovery = intake.recovery {
                restorePickerCancellationFocus(recovery.focus)
                UIAccessibility.post(
                    notification: .announcement,
                    argument: recovery.message
                )
            }
            guard case .applied = outcome,
                  let announcement = capacityAnnouncer.consumeAnnouncement(
                    photoCount: store.photos.count
                  ) else {
                return
            }
            UIAccessibility.post(
                notification: .announcement,
                argument: announcement
            )
        }
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
            // Leaving the limit re-arms it, so the next arrival at five is a transition
            // the seller has not already heard announced.
            _ = capacityAnnouncer.consumeAnnouncement(photoCount: store.photos.count)
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
