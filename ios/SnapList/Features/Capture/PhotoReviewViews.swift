import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers
#if DEBUG
import ImageIO
#endif

enum PhotoReviewV5VisualContract {
    static let contentGutter: CGFloat = 18
    static let heroHeight: CGFloat = 300
    static let heroRadius: CGFloat = 16
    static let thumbnailSize: CGFloat = 64
    static let thumbnailRadius: CGFloat = 12
    static let thumbnailGap: CGFloat = 10
    static let thumbnailStripTopPadding: CGFloat = 16
    static let actionRowHeight: CGFloat = 44
    static let actionRowGap: CGFloat = 8
    static let voiceRowHeight: CGFloat = 56
    static let voiceRowTopPadding: CGFloat = 16
    static let voiceRowRadius: CGFloat = 14
    static let footerVerticalPadding: CGFloat = 12
    static let primaryActionHeight: CGFloat = 52
    static let primaryActionRadius: CGFloat = 15
    static let headerMinimumHeight: CGFloat = 56
    static let backTargetSize: CGFloat = 44
    static let countFillHex = SnapListColorToken.quietFill.rawValue
    static let countRadius: CGFloat = 8
    static let coverFillHex = SnapListColorToken.canvas.rawValue
    static let coverColumnGap: CGFloat = 6
    static let coverRadius: CGFloat = 5
    static let coverVerticalPadding: CGFloat = 1
    static let coverHorizontalPadding: CGFloat = 7
    static let coverHasOutline = true
}

private struct PhotoReviewStartListingButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                SnapListColorToken.action.color.opacity(isEnabled ? 1 : 0.45)
            )
            .clipShape(
                .rect(
                    cornerRadius:
                        PhotoReviewV5VisualContract.primaryActionRadius
                )
            )
            .opacity(configuration.isPressed ? 0.88 : 1)
    }
}

private struct PhotoReviewSecondaryActionButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(SnapListColorToken.canvas.color)
            .overlay {
                RoundedRectangle(
                    cornerRadius: PhotoReviewV5VisualContract.primaryActionRadius
                )
                .stroke(
                    SnapListColorToken.divider.color,
                    lineWidth: 1
                )
            }
            .clipShape(
                .rect(
                    cornerRadius:
                        PhotoReviewV5VisualContract.primaryActionRadius
                )
            )
            .opacity(isEnabled ? (configuration.isPressed ? 0.72 : 1) : 0.45)
    }
}

enum PhotoReviewLayoutLandmark: Hashable {
    case header
    case back
    case title
    case countPill
    case hero
    case thumbnailStrip
    case thumbnail(Int)
    case addPhoto
    case coverPill
    case actionRow
    case voiceNote
    case footer
    case startListing
}

struct PhotoReviewLayoutObservation: Equatable {
    let frames: [PhotoReviewLayoutLandmark: CGRect]

    func frame(for landmark: PhotoReviewLayoutLandmark) -> CGRect {
        frames[landmark] ?? .zero
    }
}

private struct PhotoReviewLayoutPreferenceKey: PreferenceKey {
    static let defaultValue: [PhotoReviewLayoutLandmark: CGRect] = [:]

    static func reduce(
        value: inout [PhotoReviewLayoutLandmark: CGRect],
        nextValue: () -> [PhotoReviewLayoutLandmark: CGRect]
    ) {
        value.merge(nextValue(), uniquingKeysWith: { _, latest in latest })
    }
}

private extension View {
    func photoReviewLayoutLandmark(
        _ landmark: PhotoReviewLayoutLandmark
    ) -> some View {
        background {
            GeometryReader { geometry in
                Color.clear.preference(
                    key: PhotoReviewLayoutPreferenceKey.self,
                    value: [
                        landmark: geometry.frame(in: .global)
                    ]
                )
            }
        }
    }
}

extension PhotoReviewReorderAction {
    var accessibilityLabel: String {
        switch self {
        case .moveEarlier:
            "Move earlier"
        case .moveLater:
            "Move later"
        case .makeCover:
            "Make cover"
        }
    }
}

enum PhotoReviewNativeDragContract {
    static let contentType = UTType(
        exportedAs: "dev.snaplist.photo-review-photo"
    )

    static func itemProvider(
        photoID: StagedCapturePhoto.ID
    ) -> NSItemProvider {
        let identity = photoID.uuidString
        let provider = NSItemProvider()
        provider.suggestedName = identity
        provider.registerDataRepresentation(
            forTypeIdentifier: contentType.identifier,
            visibility: .ownProcess
        ) { completion in
            completion(Data(identity.utf8), nil)
            return nil
        }
        return provider
    }

    static func photoID(
        from provider: NSItemProvider
    ) -> StagedCapturePhoto.ID? {
        guard provider.hasItemConformingToTypeIdentifier(
            contentType.identifier
        ) else {
            return nil
        }
        return provider.suggestedName.flatMap(
            StagedCapturePhoto.ID.init(uuidString:)
        )
    }
}

struct PhotoReviewNativeDragSource: Equatable {
    let photoID: StagedCapturePhoto.ID
    let thumbnailURL: URL
    let frame: CGRect
}

enum PhotoReviewNativeDragSourceGeometry {
    static func source(
        at location: CGPoint,
        photos: [StagedCapturePhoto],
        frames: [StagedCapturePhoto.ID: CGRect]
    ) -> PhotoReviewNativeDragSource? {
        photos.lazy.compactMap { photo in
            guard let frame = frames[photo.id],
                  frame.contains(location) else {
                return nil
            }
            return PhotoReviewNativeDragSource(
                photoID: photo.id,
                thumbnailURL: photo.thumbnailURL,
                frame: frame
            )
        }
        .first
    }
}

enum PhotoReviewStripDropGeometry {
    static func destinationIndex(
        at location: CGPoint,
        photos: [StagedCapturePhoto],
        frames: [StagedCapturePhoto.ID: CGRect]
    ) -> Int? {
        photos.enumerated()
            .compactMap { index, photo -> (index: Int, distance: CGFloat)? in
                guard let frame = frames[photo.id] else {
                    return nil
                }
                return (index, abs(frame.midX - location.x))
            }
            .min { lhs, rhs in
                if lhs.distance == rhs.distance {
                    return lhs.index < rhs.index
                }
                return lhs.distance < rhs.distance
            }?
            .index
    }

    static func maximumPositiveWidthGrowth(
        from baseline: [StagedCapturePhoto.ID: CGRect],
        to current: [StagedCapturePhoto.ID: CGRect]
    ) -> CGFloat {
        baseline.compactMap { photoID, baselineFrame in
            current[photoID].map {
                max(0, $0.width - baselineFrame.width)
            }
        }
        .max() ?? 0
    }
}

#if DEBUG
struct PhotoReviewRenderedInsertionGapObservation {
    private(set) var maximumRenderedInsertionGap: CGFloat = 0
    private var restingFrames: [StagedCapturePhoto.ID: CGRect] = [:]

    mutating func observe(
        frames: [StagedCapturePhoto.ID: CGRect],
        isDragActive: Bool
    ) {
        // Preference delivery can trail performDrop, which clears drag identity.
        // Latch rendered growth before an inactive delivery refreshes the baseline.
        if !restingFrames.isEmpty {
            maximumRenderedInsertionGap = max(
                maximumRenderedInsertionGap,
                PhotoReviewStripDropGeometry.maximumPositiveWidthGrowth(
                    from: restingFrames,
                    to: frames
                )
            )
        }
        if !isDragActive, !frames.isEmpty {
            restingFrames = frames
        }
    }
}
#endif

enum PhotoReviewDragTransitionDecision: String, Equatable {
    case animated
    case suppressed
}

enum PhotoReviewDragAnimationPolicy {
    static func decision(
        reduceMotion: Bool
    ) -> PhotoReviewDragTransitionDecision {
        reduceMotion ? .suppressed : .animated
    }

    static func animation(
        for decision: PhotoReviewDragTransitionDecision
    ) -> Animation? {
        switch decision {
        case .animated:
            .easeInOut(duration: 0.16)
        case .suppressed:
            nil
        }
    }
}

enum PhotoReviewInsertionEdge: Equatable {
    case leading
    case trailing
}

enum PhotoReviewDragLayout {
    static let insertionGap: CGFloat = 62
    static let edgeAutoScrollThreshold: CGFloat = 28
}

enum PhotoReviewNativeInteractionPolicy {
    static func isEnabled(
        isCommitting: Bool,
        mutationControlsLocked: Bool
    ) -> Bool {
        !isCommitting && !mutationControlsLocked
    }
}

enum PhotoReviewNativeDragSourceEvent: Equatable {
    case attached(isEnabled: Bool)
    case detached
    case enabled(Bool)
    case beginRequested(
        hostBounds: CGRect,
        hostContentSize: CGSize,
        isEnabled: Bool
    )
    case resolving(frameCount: Int)
    case rejectedMissingView
    case rejectedDisabled
    case rejectedNoSource
    case rejectedPresentation
    case provided(photoID: StagedCapturePhoto.ID)
    case willAnimateLift(
        location: CGPoint?,
        scrollPanState: UIGestureRecognizer.State?
    )
    case liftAnimationCompleted(
        position: UIViewAnimatingPosition,
        scrollPanState: UIGestureRecognizer.State?
    )
    case sessionWillBegin(
        location: CGPoint?,
        scrollPanState: UIGestureRecognizer.State?
    )
    case willEnd(
        operation: UIDropOperation,
        location: CGPoint?,
        sessionDidMoveCount: Int,
        lastSessionDidMoveLocation: CGPoint?
    )
    case ended(
        operation: UIDropOperation,
        location: CGPoint?,
        sessionDidMoveCount: Int,
        lastSessionDidMoveLocation: CGPoint?
    )
}

struct PhotoReviewNativeDragSourceObservation: Equatable {
    private(set) var isAttached = false
    private(set) var isEnabled = false
    private(set) var frameCount = 0
    private(set) var hostBounds = CGRect.zero
    private(set) var hostContentSize = CGSize.zero
    private(set) var beginOutcome = "not-called"
    private(set) var photoID: StagedCapturePhoto.ID?
    private(set) var didWillAnimateLift = false
    private(set) var willAnimateLiftLocation: CGPoint?
    private(set) var willAnimateLiftPanState: UIGestureRecognizer.State?
    private(set) var liftAnimationCompletionPosition: UIViewAnimatingPosition?
    private(set) var liftAnimationCompletionPanState: UIGestureRecognizer.State?
    private(set) var didSessionWillBegin = false
    private(set) var sessionWillBeginLocation: CGPoint?
    private(set) var sessionWillBeginPanState: UIGestureRecognizer.State?
    private(set) var sessionDidMoveCount = 0
    private(set) var lastSessionDidMoveLocation: CGPoint?
    private(set) var willEndOperation: UIDropOperation?
    private(set) var willEndLocation: CGPoint?
    private(set) var didEnd = false
    private(set) var didEndOperation: UIDropOperation?
    private(set) var didEndLocation: CGPoint?

    var hasActivity: Bool {
        isAttached || beginOutcome != "not-called"
    }

    var label: String {
        let bounds = [
            hostBounds.minX,
            hostBounds.minY,
            hostBounds.width,
            hostBounds.height
        ]
        .map { Int($0.rounded()) }
        .map(String.init)
        .joined(separator: ",")
        let content = [
            hostContentSize.width,
            hostContentSize.height
        ]
        .map { Int($0.rounded()) }
        .map(String.init)
        .joined(separator: ",")
        return [
            "attached:\(isAttached)",
            "enabled:\(isEnabled)",
            "frames:\(frameCount)",
            "begin:\(beginOutcome)",
            "photo:\(photoID?.uuidString ?? "none")",
            "host:\(bounds)",
            "content:\(content)",
            "willAnimateLift:\(didWillAnimateLift)",
            "willAnimateLiftLocation:\(Self.pointLabel(willAnimateLiftLocation))",
            "willAnimateLiftPan:\(Self.gestureStateLabel(willAnimateLiftPanState))",
            "liftCompletion:\(Self.animatingPositionLabel(liftAnimationCompletionPosition))",
            "liftCompletionPan:\(Self.gestureStateLabel(liftAnimationCompletionPanState))",
            "willBegin:\(didSessionWillBegin)",
            "willBeginLocation:\(Self.pointLabel(sessionWillBeginLocation))",
            "willBeginPan:\(Self.gestureStateLabel(sessionWillBeginPanState))",
            "moves:\(sessionDidMoveCount)",
            "lastMove:\(Self.pointLabel(lastSessionDidMoveLocation))",
            "willEnd:\(Self.operationLabel(willEndOperation))",
            "willEndLocation:\(Self.pointLabel(willEndLocation))",
            "ended:\(didEnd)",
            "endOperation:\(Self.operationLabel(didEndOperation))",
            "endLocation:\(Self.pointLabel(didEndLocation))"
        ]
        .joined(separator: ",")
    }

    mutating func observe(_ event: PhotoReviewNativeDragSourceEvent) {
        switch event {
        case .attached(let isEnabled):
            isAttached = true
            self.isEnabled = isEnabled
        case .detached:
            isAttached = false
        case .enabled(let isEnabled):
            self.isEnabled = isEnabled
        case .beginRequested(
            let hostBounds,
            let hostContentSize,
            let isEnabled
        ):
            self.hostBounds = hostBounds
            self.hostContentSize = hostContentSize
            self.isEnabled = isEnabled
            beginOutcome = "requested"
            photoID = nil
            didWillAnimateLift = false
            willAnimateLiftLocation = nil
            willAnimateLiftPanState = nil
            liftAnimationCompletionPosition = nil
            liftAnimationCompletionPanState = nil
            didSessionWillBegin = false
            sessionWillBeginLocation = nil
            sessionWillBeginPanState = nil
            sessionDidMoveCount = 0
            lastSessionDidMoveLocation = nil
            willEndOperation = nil
            willEndLocation = nil
            didEnd = false
            didEndOperation = nil
            didEndLocation = nil
        case .resolving(let frameCount):
            self.frameCount = frameCount
        case .rejectedMissingView:
            beginOutcome = "rejected-missing-view"
        case .rejectedDisabled:
            beginOutcome = "rejected-disabled"
        case .rejectedNoSource:
            beginOutcome = "rejected-no-source"
        case .rejectedPresentation:
            beginOutcome = "rejected-presentation"
        case .provided(let photoID):
            beginOutcome = "provided"
            self.photoID = photoID
        case .willAnimateLift(let location, let scrollPanState):
            didWillAnimateLift = true
            willAnimateLiftLocation = location
            willAnimateLiftPanState = scrollPanState
        case .liftAnimationCompleted(let position, let scrollPanState):
            liftAnimationCompletionPosition = position
            liftAnimationCompletionPanState = scrollPanState
        case .sessionWillBegin(let location, let scrollPanState):
            didSessionWillBegin = true
            sessionWillBeginLocation = location
            sessionWillBeginPanState = scrollPanState
        case .willEnd(
            let operation,
            let location,
            let sessionDidMoveCount,
            let lastSessionDidMoveLocation
        ):
            willEndOperation = operation
            willEndLocation = location
            self.sessionDidMoveCount = sessionDidMoveCount
            self.lastSessionDidMoveLocation = lastSessionDidMoveLocation
        case .ended(
            let operation,
            let location,
            let sessionDidMoveCount,
            let lastSessionDidMoveLocation
        ):
            didEnd = true
            didEndOperation = operation
            didEndLocation = location
            self.sessionDidMoveCount = sessionDidMoveCount
            self.lastSessionDidMoveLocation = lastSessionDidMoveLocation
        }
    }

    private static func pointLabel(_ point: CGPoint?) -> String {
        guard let point else {
            return "none"
        }
        return [
            point.x,
            point.y
        ]
        .map { Int($0.rounded()) }
        .map(String.init)
        .joined(separator: ",")
    }

    private static func gestureStateLabel(
        _ state: UIGestureRecognizer.State?
    ) -> String {
        switch state {
        case .possible:
            "possible"
        case .began:
            "began"
        case .changed:
            "changed"
        case .ended:
            "ended"
        case .cancelled:
            "cancelled"
        case .failed:
            "failed"
        case nil:
            "none"
        @unknown default:
            "unknown"
        }
    }

    private static func animatingPositionLabel(
        _ position: UIViewAnimatingPosition?
    ) -> String {
        switch position {
        case .start:
            "start"
        case .current:
            "current"
        case .end:
            "end"
        case nil:
            "not-called"
        @unknown default:
            "unknown"
        }
    }

    private static func operationLabel(
        _ operation: UIDropOperation?
    ) -> String {
        guard let operation else {
            return "not-called"
        }
        switch operation {
        case .cancel:
            return "cancel"
        case .forbidden:
            return "forbidden"
        case .copy:
            return "copy"
        case .move:
            return "move"
        @unknown default:
            return "unknown-\(operation.rawValue)"
        }
    }
}

enum PhotoReviewNativeDropEvent: Equatable {
    case attached(
        epoch: Int,
        hostBounds: CGRect,
        hostContentSize: CGSize,
        dragInteractionCount: Int,
        dropInteractionCount: Int
    )
    case detached(epoch: Int)
    case canHandle(
        result: Bool,
        photoID: StagedCapturePhoto.ID?
    )
    case entered
    case updated
    case rejectedDisabled
    case rejectedAdmission
    case rejectedDestination
    case rejectedCommit
    case committed
}

struct PhotoReviewNativeDropObservation: Equatable {
    private(set) var isAttached = false
    private(set) var attachmentEpoch = 0
    private(set) var detachCount = 0
    private(set) var lastDetachedEpoch = 0
    private(set) var hostBounds = CGRect.zero
    private(set) var hostContentSize = CGSize.zero
    private(set) var dragInteractionCount = 0
    private(set) var dropInteractionCount = 0
    private(set) var canHandleCallCount = 0
    private(set) var canHandleOutcome = "not-called"
    private(set) var canHandlePhotoID: StagedCapturePhoto.ID?
    private(set) var didEnter = false
    private(set) var didUpdate = false
    private(set) var performDropOutcome = "not-called"

    var hasActivity: Bool {
        isAttached
            || detachCount > 0
            || canHandleCallCount > 0
            || didEnter
            || didUpdate
            || performDropOutcome != "not-called"
    }

    var label: String {
        let bounds = [
            hostBounds.minX,
            hostBounds.minY,
            hostBounds.width,
            hostBounds.height
        ]
        .map { Int($0.rounded()) }
        .map(String.init)
        .joined(separator: ",")
        let content = [
            hostContentSize.width,
            hostContentSize.height
        ]
        .map { Int($0.rounded()) }
        .map(String.init)
        .joined(separator: ",")
        return [
            "attached:\(isAttached)",
            "epoch:\(attachmentEpoch)",
            "detached:\(detachCount)",
            "detachedEpoch:\(lastDetachedEpoch)",
            "host:\(bounds)",
            "content:\(content)",
            "dragInteractions:\(dragInteractionCount)",
            "dropInteractions:\(dropInteractionCount)",
            "canHandle:\(canHandleOutcome)",
            "canHandleCalls:\(canHandleCallCount)",
            "photo:\(canHandlePhotoID?.uuidString ?? "none")",
            "entered:\(didEnter)",
            "updated:\(didUpdate)",
            "perform:\(performDropOutcome)"
        ]
        .joined(separator: ",")
    }

    mutating func observe(_ event: PhotoReviewNativeDropEvent) {
        switch event {
        case .attached(
            let epoch,
            let hostBounds,
            let hostContentSize,
            let dragInteractionCount,
            let dropInteractionCount
        ):
            isAttached = true
            attachmentEpoch = epoch
            self.hostBounds = hostBounds
            self.hostContentSize = hostContentSize
            self.dragInteractionCount = dragInteractionCount
            self.dropInteractionCount = dropInteractionCount
        case .detached(let epoch):
            isAttached = false
            detachCount += 1
            lastDetachedEpoch = epoch
        case .canHandle(let result, let photoID):
            canHandleCallCount += 1
            canHandleOutcome = result ? "accepted" : "rejected"
            canHandlePhotoID = photoID
        case .entered:
            didEnter = true
        case .updated:
            didUpdate = true
        case .rejectedDisabled:
            performDropOutcome = "rejected-disabled"
        case .rejectedAdmission:
            performDropOutcome = "rejected-admission"
        case .rejectedDestination:
            performDropOutcome = "rejected-destination"
        case .rejectedCommit:
            performDropOutcome = "rejected-commit"
        case .committed:
            performDropOutcome = "committed"
        }
    }
}

private struct PhotoReviewThumbnailFramePreferenceKey: PreferenceKey {
    static var defaultValue: [StagedCapturePhoto.ID: CGRect] = [:]

    static func reduce(
        value: inout [StagedCapturePhoto.ID: CGRect],
        nextValue: () -> [StagedCapturePhoto.ID: CGRect]
    ) {
        value.merge(nextValue(), uniquingKeysWith: { _, next in next })
    }
}

private struct PhotoReviewThumbnailStripWidthPreferenceKey: PreferenceKey {
    static var defaultValue: CGFloat = 0

    static func reduce(
        value: inout CGFloat,
        nextValue: () -> CGFloat
    ) {
        value = nextValue()
    }
}

@MainActor
@Observable
final class PhotoReviewDragPresentation {
    private(set) var draggedPhotoID: StagedCapturePhoto.ID?
    private(set) var insertionIndex: Int?
    private(set) var pendingFocusPhotoID: StagedCapturePhoto.ID?
    private(set) var pendingAnnouncement: String?
    private(set) var lastTransitionDecision:
        PhotoReviewDragTransitionDecision?

    static func canBegin(
        photoID: StagedCapturePhoto.ID,
        photos: [StagedCapturePhoto]
    ) -> Bool {
        photos.count > 1
            && photos.contains(where: { $0.id == photoID })
    }

    func begin(
        photoID: StagedCapturePhoto.ID,
        store: PhotoReviewStore
    ) -> Bool {
        guard Self.canBegin(
            photoID: photoID,
            photos: store.photos
        ) else {
            return false
        }
        pendingFocusPhotoID = nil
        pendingAnnouncement = nil
        draggedPhotoID = photoID
        insertionIndex = store.photos.firstIndex(where: { $0.id == photoID })
        lastTransitionDecision = nil
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
        guard insertionIndex != destinationIndex else {
            return
        }
        withAnimation(transitionAnimation(reduceMotion: reduceMotion)) {
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
        let result = store.performDragReorder(
            photoID: photoID,
            to: destinationIndex
        )
        withAnimation(transitionAnimation(reduceMotion: reduceMotion)) {
            draggedPhotoID = nil
            insertionIndex = nil
        }
        pendingFocusPhotoID = photoID
        pendingAnnouncement = result?.announcement
        return result
    }

    func beginCommittedReorder(
        to destinationIndex: Int,
        store: PhotoReviewStore,
        reduceMotion: Bool
    ) -> StagedCapturePhoto.ID? {
        guard let photoID = draggedPhotoID,
              store.proposedPhotoOrder(
                moving: photoID,
                to: destinationIndex
              ) != nil else {
            return nil
        }
        withAnimation(transitionAnimation(reduceMotion: reduceMotion)) {
            draggedPhotoID = nil
            insertionIndex = nil
        }
        pendingFocusPhotoID = nil
        pendingAnnouncement = nil
        return photoID
    }

    func publishCommittedReorder(_ result: PhotoReviewReorderResult) {
        pendingFocusPhotoID = result.photoID
        pendingAnnouncement = result.announcement
    }

    func endNativeDragSession(reduceMotion: Bool) {
        cancel(reduceMotion: reduceMotion)
    }

    func suspendNativeDragSessionForInteractionLock(
        reduceMotion: Bool
    ) {
        guard draggedPhotoID != nil else {
            return
        }
        withAnimation(transitionAnimation(reduceMotion: reduceMotion)) {
            draggedPhotoID = nil
            insertionIndex = nil
        }
        pendingFocusPhotoID = nil
        pendingAnnouncement = nil
    }

    func cancel(reduceMotion: Bool) {
        guard let photoID = draggedPhotoID else {
            return
        }
        withAnimation(transitionAnimation(reduceMotion: reduceMotion)) {
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

    func insertionEdge(
        for photoID: StagedCapturePhoto.ID,
        at index: Int,
        store: PhotoReviewStore
    ) -> PhotoReviewInsertionEdge? {
        guard insertionIndex == index,
              let draggedPhotoID,
              draggedPhotoID != photoID,
              let sourceIndex = store.photos.firstIndex(
                where: { $0.id == draggedPhotoID }
              ) else {
            return nil
        }
        return sourceIndex > index ? .leading : .trailing
    }

    private func transitionAnimation(
        reduceMotion: Bool
    ) -> Animation? {
        let decision = PhotoReviewDragAnimationPolicy.decision(
            reduceMotion: reduceMotion
        )
        lastTransitionDecision = decision
        return PhotoReviewDragAnimationPolicy.animation(for: decision)
    }
}

@MainActor
final class PhotoReviewNativeDragSourceDelegate: NSObject,
    UIDragInteractionDelegate {
    private static let previewSize = CGSize(
        width: PhotoReviewV5VisualContract.thumbnailSize,
        height: PhotoReviewV5VisualContract.thumbnailSize
    )
    private static let previewCornerRadius: CGFloat = 12

    private var store: PhotoReviewStore
    private var presentation: PhotoReviewDragPresentation
    private var reduceMotion: Bool
    private(set) var isEnabled: Bool
    private var sourceAtLocation:
        (CGPoint) -> PhotoReviewNativeDragSource?
    private var observeSource:
        (PhotoReviewNativeDragSourceEvent) -> Void
    private var activeSource: PhotoReviewNativeDragSource?
    private var sessionDidMoveCount = 0
    private var lastSessionDidMoveLocation: CGPoint?
    private weak var attachedView: UIView?
    private var dragInteraction: UIDragInteraction?

    init(
        store: PhotoReviewStore,
        presentation: PhotoReviewDragPresentation,
        reduceMotion: Bool,
        isEnabled: Bool,
        sourceAtLocation: @escaping
            (CGPoint) -> PhotoReviewNativeDragSource?,
        observeSource: @escaping
            (PhotoReviewNativeDragSourceEvent) -> Void = { _ in }
    ) {
        self.store = store
        self.presentation = presentation
        self.reduceMotion = reduceMotion
        self.isEnabled = isEnabled
        self.sourceAtLocation = sourceAtLocation
        self.observeSource = observeSource
        if !isEnabled {
            presentation.suspendNativeDragSessionForInteractionLock(
                reduceMotion: reduceMotion
            )
        }
    }

    func update(
        store: PhotoReviewStore,
        presentation: PhotoReviewDragPresentation,
        reduceMotion: Bool,
        isEnabled: Bool,
        sourceAtLocation: @escaping
            (CGPoint) -> PhotoReviewNativeDragSource?,
        observeSource: @escaping
            (PhotoReviewNativeDragSourceEvent) -> Void = { _ in }
    ) {
        let enabledChanged = self.isEnabled != isEnabled
        self.store = store
        self.presentation = presentation
        self.reduceMotion = reduceMotion
        self.isEnabled = isEnabled
        self.sourceAtLocation = sourceAtLocation
        self.observeSource = observeSource
        if enabledChanged {
            observeSource(.enabled(isEnabled))
        }
        dragInteraction?.isEnabled = isEnabled
        if !isEnabled {
            presentation.suspendNativeDragSessionForInteractionLock(
                reduceMotion: reduceMotion
            )
            activeSource = nil
        }
    }

    func attach(to view: UIView) {
        guard attachedView !== view else {
            dragInteraction?.isEnabled = isEnabled
            return
        }
        detach()
        let interaction = UIDragInteraction(delegate: self)
        interaction.isEnabled = isEnabled
        view.addInteraction(interaction)
        attachedView = view
        dragInteraction = interaction
        observeSource(.attached(isEnabled: isEnabled))
    }

    func detach() {
        let wasAttached = attachedView != nil
        if let dragInteraction {
            attachedView?.removeInteraction(dragInteraction)
        }
        dragInteraction = nil
        attachedView = nil
        if wasAttached {
            observeSource(.detached)
        }
    }

    func dragInteraction(
        _ interaction: UIDragInteraction,
        itemsForBeginning session: UIDragSession
    ) -> [UIDragItem] {
        guard let sourceView = interaction.view else {
            observeSource(.rejectedMissingView)
            return []
        }
        sessionDidMoveCount = 0
        lastSessionDidMoveLocation = nil
        observeSource(
            .beginRequested(
                hostBounds: sourceView.bounds,
                hostContentSize:
                    (sourceView as? UIScrollView)?.contentSize ?? .zero,
                isEnabled: isEnabled
            )
        )
        guard isEnabled else {
            observeSource(.rejectedDisabled)
            return []
        }
        let sourceLocation = session.location(in: sourceView)
        let location = CGPoint(
            x: sourceLocation.x - sourceView.bounds.minX,
            y: sourceLocation.y - sourceView.bounds.minY
        )
        guard let source = sourceAtLocation(location) else {
            observeSource(.rejectedNoSource)
            return []
        }
        guard PhotoReviewDragPresentation.canBegin(
            photoID: source.photoID,
            photos: store.photos
        ) else {
            observeSource(.rejectedPresentation)
            return []
        }
        activeSource = source
        observeSource(.provided(photoID: source.photoID))
        return [
            UIDragItem(
                itemProvider: PhotoReviewNativeDragContract.itemProvider(
                    photoID: source.photoID
                )
            )
        ]
    }

    func dragInteraction(
        _ interaction: UIDragInteraction,
        previewForLifting item: UIDragItem,
        session: UIDragSession
    ) -> UITargetedDragPreview? {
        guard let sourceView = interaction.view,
              let activeSource,
              let image = UIImage(
                contentsOfFile: activeSource.thumbnailURL.path
              ) else {
            return nil
        }
        let previewView = UIImageView(image: image)
        previewView.bounds = CGRect(
            origin: .zero,
            size: Self.previewSize
        )
        previewView.contentMode = .scaleAspectFill
        previewView.clipsToBounds = true
        previewView.layer.cornerRadius = Self.previewCornerRadius

        let parameters = UIDragPreviewParameters()
        parameters.backgroundColor = .clear
        parameters.visiblePath = UIBezierPath(
            roundedRect: previewView.bounds,
            cornerRadius: Self.previewCornerRadius
        )
        parameters.shadowPath = UIBezierPath()
        let target = UIDragPreviewTarget(
            container: sourceView,
            center: CGPoint(
                x: activeSource.frame.midX + sourceView.bounds.minX,
                y: activeSource.frame.minY
                    + Self.previewSize.height / 2
                    + sourceView.bounds.minY
            )
        )
        return UITargetedDragPreview(
            view: previewView,
            parameters: parameters,
            target: target
        )
    }

    func dragInteraction(
        _ interaction: UIDragInteraction,
        willAnimateLiftWith animator: any UIDragAnimating,
        session: UIDragSession
    ) {
        observeSource(
            .willAnimateLift(
                location: hostNormalizedLocation(
                    for: session,
                    interaction: interaction
                ),
                scrollPanState: scrollPanState(for: interaction)
            )
        )
        animator.addCompletion { [weak self, weak interaction] position in
            guard let self else {
                return
            }
            self.observeSource(
                .liftAnimationCompleted(
                    position: position,
                    scrollPanState: self.scrollPanState(for: interaction)
                )
            )
        }
    }

    func dragInteraction(
        _ interaction: UIDragInteraction,
        sessionWillBegin session: UIDragSession
    ) {
        guard let activeSource,
              presentation.begin(
                photoID: activeSource.photoID,
                store: store
              ) else {
            self.activeSource = nil
            observeSource(.rejectedPresentation)
            return
        }
        observeSource(
            .sessionWillBegin(
                location: hostNormalizedLocation(
                    for: session,
                    interaction: interaction
                ),
                scrollPanState: scrollPanState(for: interaction)
            )
        )
    }

    func dragInteraction(
        _ interaction: UIDragInteraction,
        sessionDidMove session: UIDragSession
    ) {
        sessionDidMoveCount += 1
        lastSessionDidMoveLocation = hostNormalizedLocation(
            for: session,
            interaction: interaction
        )
    }

    func dragInteraction(
        _ interaction: UIDragInteraction,
        session: UIDragSession,
        willEndWith operation: UIDropOperation
    ) {
        observeSource(
            .willEnd(
                operation: operation,
                location: hostNormalizedLocation(
                    for: session,
                    interaction: interaction
                ),
                sessionDidMoveCount: sessionDidMoveCount,
                lastSessionDidMoveLocation:
                    lastSessionDidMoveLocation
            )
        )
    }

    func dragInteraction(
        _ interaction: UIDragInteraction,
        session: UIDragSession,
        didEndWith operation: UIDropOperation
    ) {
        let location = hostNormalizedLocation(
            for: session,
            interaction: interaction
        )
        // This source callback is delivered after both accepted and cancelled
        // sessions, even when the drag never reaches this app's drop owner.
        presentation.endNativeDragSession(
            reduceMotion: reduceMotion
        )
        activeSource = nil
        observeSource(
            .ended(
                operation: operation,
                location: location,
                sessionDidMoveCount: sessionDidMoveCount,
                lastSessionDidMoveLocation:
                    lastSessionDidMoveLocation
            )
        )
        sessionDidMoveCount = 0
        lastSessionDidMoveLocation = nil
    }

    private func hostNormalizedLocation(
        for session: UIDragSession,
        interaction: UIDragInteraction
    ) -> CGPoint? {
        guard let sourceView = interaction.view else {
            return nil
        }
        let sourceLocation = session.location(in: sourceView)
        return CGPoint(
            x: sourceLocation.x - sourceView.bounds.minX,
            y: sourceLocation.y - sourceView.bounds.minY
        )
    }

    private func scrollPanState(
        for interaction: UIDragInteraction?
    ) -> UIGestureRecognizer.State? {
        (interaction?.view as? UIScrollView)?.panGestureRecognizer.state
    }
}

enum PhotoReviewNativeStripHostResolver {
    static func resolve(
        from attachmentView: UIView
    ) -> UIScrollView? {
        var ancestor = attachmentView.superview
        while let view = ancestor {
            if let scrollView = view as? UIScrollView {
                return scrollView
            }
            ancestor = view.superview
        }
        return nil
    }
}

@MainActor
final class PhotoReviewNativeStripInteractionAttachmentView: UIView {
    private var shouldAttach = false
    private var attach: ((UIScrollView) -> Void)?
    private var detach: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        isUserInteractionEnabled = false
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        backgroundColor = .clear
        isUserInteractionEnabled = false
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        resolveHostAndAttach()
    }

    func update(
        shouldAttach: Bool,
        attach: @escaping (UIScrollView) -> Void,
        detach: @escaping () -> Void
    ) {
        self.shouldAttach = shouldAttach
        self.attach = attach
        self.detach = detach
        resolveHostAndAttach()
    }

    func resolveHostAndAttach() {
        guard window != nil,
              shouldAttach,
              let host = PhotoReviewNativeStripHostResolver.resolve(
                from: self
              ) else {
            detach?()
            return
        }
        attach?(host)
    }

    func dismantle() {
        detach?()
        attach = nil
        detach = nil
    }
}

@MainActor
private struct PhotoReviewNativeDragSourceAttachment: UIViewRepresentable {
    let store: PhotoReviewStore
    let presentation: PhotoReviewDragPresentation
    let reduceMotion: Bool
    let isEnabled: Bool
    let sourceAtLocation:
        (CGPoint) -> PhotoReviewNativeDragSource?
    let observeSource: (PhotoReviewNativeDragSourceEvent) -> Void

    func makeCoordinator() -> PhotoReviewNativeDragSourceDelegate {
        PhotoReviewNativeDragSourceDelegate(
            store: store,
            presentation: presentation,
            reduceMotion: reduceMotion,
            isEnabled: isEnabled,
            sourceAtLocation: sourceAtLocation,
            observeSource: observeSource
        )
    }

    func makeUIView(
        context: Context
    ) -> PhotoReviewNativeStripInteractionAttachmentView {
        let view = PhotoReviewNativeStripInteractionAttachmentView()
        view.update(
            shouldAttach: true,
            attach: context.coordinator.attach(to:),
            detach: context.coordinator.detach
        )
        return view
    }

    func updateUIView(
        _ uiView: PhotoReviewNativeStripInteractionAttachmentView,
        context: Context
    ) {
        context.coordinator.update(
            store: store,
            presentation: presentation,
            reduceMotion: reduceMotion,
            isEnabled: isEnabled,
            sourceAtLocation: sourceAtLocation,
            observeSource: observeSource
        )
        uiView.update(
            shouldAttach: true,
            attach: context.coordinator.attach(to:),
            detach: context.coordinator.detach
        )
    }

    static func dismantleUIView(
        _ uiView: PhotoReviewNativeStripInteractionAttachmentView,
        coordinator: PhotoReviewNativeDragSourceDelegate
    ) {
        uiView.dismantle()
    }
}

@MainActor
struct PhotoReviewNativeDropAttachment: UIViewRepresentable {
    let store: PhotoReviewStore
    let presentation: PhotoReviewDragPresentation
    let reduceMotion: Bool
    let isEnabled: Bool
    let destinationIndex: (CGPoint) -> Int?
    let autoScroll: (CGPoint) -> Void
    let commitReorder:
        ((StagedCapturePhoto.ID, Int) async -> PhotoReviewReorderResult?)?
    let observeDrop: (PhotoReviewNativeDropEvent) -> Void

    init(
        store: PhotoReviewStore,
        presentation: PhotoReviewDragPresentation,
        reduceMotion: Bool,
        isEnabled: Bool,
        destinationIndex: @escaping (CGPoint) -> Int?,
        autoScroll: @escaping (CGPoint) -> Void,
        commitReorder:
            ((StagedCapturePhoto.ID, Int) async -> PhotoReviewReorderResult?)? = nil,
        observeDrop: @escaping (PhotoReviewNativeDropEvent) -> Void = { _ in }
    ) {
        self.store = store
        self.presentation = presentation
        self.reduceMotion = reduceMotion
        self.isEnabled = isEnabled
        self.destinationIndex = destinationIndex
        self.autoScroll = autoScroll
        self.commitReorder = commitReorder
        self.observeDrop = observeDrop
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(
            store: store,
            presentation: presentation,
            reduceMotion: reduceMotion,
            isEnabled: isEnabled,
            destinationIndex: destinationIndex,
            autoScroll: autoScroll,
            commitReorder: commitReorder,
            observeDrop: observeDrop
        )
    }

    func makeUIView(
        context: Context
    ) -> PhotoReviewNativeStripInteractionAttachmentView {
        let view = PhotoReviewNativeStripInteractionAttachmentView()
        view.update(
            shouldAttach: isEnabled,
            attach: context.coordinator.attach(to:),
            detach: context.coordinator.detach
        )
        return view
    }

    func updateUIView(
        _ uiView: PhotoReviewNativeStripInteractionAttachmentView,
        context: Context
    ) {
        context.coordinator.update(
            store: store,
            presentation: presentation,
            reduceMotion: reduceMotion,
            isEnabled: isEnabled,
            destinationIndex: destinationIndex,
            autoScroll: autoScroll,
            commitReorder: commitReorder,
            observeDrop: observeDrop
        )
        uiView.update(
            shouldAttach: isEnabled,
            attach: context.coordinator.attach(to:),
            detach: context.coordinator.detach
        )
    }

    static func dismantleUIView(
        _ uiView: PhotoReviewNativeStripInteractionAttachmentView,
        coordinator: Coordinator
    ) {
        uiView.dismantle()
    }

    @MainActor
    final class Coordinator: NSObject, UIDropInteractionDelegate {
        private var store: PhotoReviewStore
        private var presentation: PhotoReviewDragPresentation
        private var reduceMotion: Bool
        private(set) var isEnabled: Bool
        private var destinationIndex: (CGPoint) -> Int?
        private var autoScroll: (CGPoint) -> Void
        private var commitReorder:
            ((StagedCapturePhoto.ID, Int) async -> PhotoReviewReorderResult?)?
        private var observeDrop: (PhotoReviewNativeDropEvent) -> Void
        private weak var attachedView: UIView?
        private var dropInteraction: UIDropInteraction?
        private var attachmentEpoch = 0
        private var sessionAllowsAutoScroll = false
        private var autoScrollSessionIdentifier: ObjectIdentifier?
        var isInteractionAttached: Bool {
            dropInteraction != nil
        }

        init(
            store: PhotoReviewStore,
            presentation: PhotoReviewDragPresentation,
            reduceMotion: Bool,
            isEnabled: Bool,
            destinationIndex: @escaping (CGPoint) -> Int?,
            autoScroll: @escaping (CGPoint) -> Void,
            commitReorder:
                ((StagedCapturePhoto.ID, Int) async -> PhotoReviewReorderResult?)? = nil,
            observeDrop: @escaping
                (PhotoReviewNativeDropEvent) -> Void = { _ in }
        ) {
            self.store = store
            self.presentation = presentation
            self.reduceMotion = reduceMotion
            self.isEnabled = isEnabled
            self.destinationIndex = destinationIndex
            self.autoScroll = autoScroll
            self.commitReorder = commitReorder
            self.observeDrop = observeDrop
            if !isEnabled {
                presentation.suspendNativeDragSessionForInteractionLock(
                    reduceMotion: reduceMotion
                )
            }
        }

        func update(
            store: PhotoReviewStore,
            presentation: PhotoReviewDragPresentation,
            reduceMotion: Bool,
            isEnabled: Bool,
            destinationIndex: @escaping (CGPoint) -> Int?,
            autoScroll: @escaping (CGPoint) -> Void,
            commitReorder:
                ((StagedCapturePhoto.ID, Int) async -> PhotoReviewReorderResult?)? = nil,
            observeDrop: @escaping
                (PhotoReviewNativeDropEvent) -> Void = { _ in }
        ) {
            self.store = store
            self.presentation = presentation
            self.reduceMotion = reduceMotion
            self.isEnabled = isEnabled
            self.destinationIndex = destinationIndex
            self.autoScroll = autoScroll
            self.commitReorder = commitReorder
            self.observeDrop = observeDrop
            if !isEnabled {
                presentation.suspendNativeDragSessionForInteractionLock(
                    reduceMotion: reduceMotion
                )
                detach()
            }
        }

        func attach(to view: UIView) {
            guard isEnabled else {
                detach()
                return
            }
            guard attachedView !== view else {
                return
            }
            detach()
            let interaction = UIDropInteraction(delegate: self)
            view.addInteraction(interaction)
            attachedView = view
            dropInteraction = interaction
            attachmentEpoch += 1
            observeDrop(
                .attached(
                    epoch: attachmentEpoch,
                    hostBounds: view.bounds,
                    hostContentSize:
                        (view as? UIScrollView)?.contentSize ?? .zero,
                    dragInteractionCount: view.interactions
                        .compactMap { $0 as? UIDragInteraction }
                        .count,
                    dropInteractionCount: view.interactions
                        .compactMap { $0 as? UIDropInteraction }
                        .count
                )
            )
        }

        func detach() {
            let wasAttached = attachedView != nil
            if let dropInteraction {
                attachedView?.removeInteraction(dropInteraction)
            }
            dropInteraction = nil
            attachedView = nil
            sessionAllowsAutoScroll = false
            autoScrollSessionIdentifier = nil
            if wasAttached {
                observeDrop(.detached(epoch: attachmentEpoch))
            }
        }

        func dropInteraction(
            _ interaction: UIDropInteraction,
            canHandle session: UIDropSession
        ) -> Bool {
            guard isEnabled else {
                observeDrop(.canHandle(result: false, photoID: nil))
                return false
            }
            let photoID = acceptedPhotoID(session: session)
            let result = photoID != nil
            observeDrop(.canHandle(result: result, photoID: photoID))
            return result
        }

        func dropInteraction(
            _ interaction: UIDropInteraction,
            sessionDidEnter session: UIDropSession
        ) {
            guard isEnabled, admit(session: session) else {
                return
            }
            let sessionIdentifier = ObjectIdentifier(session as AnyObject)
            if autoScrollSessionIdentifier != sessionIdentifier {
                autoScrollSessionIdentifier = sessionIdentifier
                sessionAllowsAutoScroll = {
                    guard let scrollView = interaction.view as? UIScrollView else {
                        return false
                    }
                    return scrollView.contentSize.width > scrollView.bounds.width
                }()
            }
            updateDestination(
                at: sessionLocation(
                    session: session,
                    interaction: interaction
                )
            )
            observeDrop(.entered)
        }

        func dropInteraction(
            _ interaction: UIDropInteraction,
            sessionDidUpdate session: UIDropSession
        ) -> UIDropProposal {
            guard isEnabled, admit(session: session) else {
                return UIDropProposal(operation: .cancel)
            }
            let location = sessionLocation(
                session: session,
                interaction: interaction
            )
            updateDestination(at: location)
            if sessionAllowsAutoScroll {
                autoScroll(location)
            }
            observeDrop(.updated)
            return UIDropProposal(operation: .move)
        }

        func dropInteraction(
            _ interaction: UIDropInteraction,
            sessionDidExit session: UIDropSession
        ) {}

        func dropInteraction(
            _ interaction: UIDropInteraction,
            performDrop session: UIDropSession
        ) {
            let location = sessionLocation(
                session: session,
                interaction: interaction
            )
            guard isEnabled else {
                observeDrop(.rejectedDisabled)
                return
            }
            guard admit(session: session) else {
                observeDrop(.rejectedAdmission)
                return
            }
            guard let destinationIndex = destinationIndex(location) else {
                observeDrop(.rejectedDestination)
                return
            }
            if let commitReorder {
                guard let photoID = presentation.beginCommittedReorder(
                    to: destinationIndex,
                    store: store,
                    reduceMotion: reduceMotion
                ) else {
                    observeDrop(.rejectedCommit)
                    return
                }
                Task {
                    guard let result = await commitReorder(
                        photoID,
                        destinationIndex
                    ) else {
                        observeDrop(.rejectedCommit)
                        return
                    }
                    presentation.publishCommittedReorder(result)
                    observeDrop(.committed)
                }
            } else {
                let result = presentation.commit(
                    to: destinationIndex,
                    store: store,
                    reduceMotion: reduceMotion
                )
                observeDrop(result == nil ? .rejectedCommit : .committed)
            }
        }

        func dropInteraction(
            _ interaction: UIDropInteraction,
            sessionDidEnd session: UIDropSession
        ) {
            // UIKit calls this for every session that entered, updated, or exited
            // this one owner, including interruption without performDrop.
            presentation.endNativeDragSession(
                reduceMotion: reduceMotion
            )
            sessionAllowsAutoScroll = false
            autoScrollSessionIdentifier = nil
        }

        private func acceptedPhotoID(
            session: UIDropSession
        ) -> StagedCapturePhoto.ID? {
            guard let photoID = session.items
                .lazy
                .map(\.itemProvider)
                .compactMap(PhotoReviewNativeDragContract.photoID(from:))
                .first(where: { candidate in
                    store.photos.contains(where: { $0.id == candidate })
                }) else {
                return nil
            }
            guard presentation.draggedPhotoID == nil
                    || presentation.draggedPhotoID == photoID else {
                return nil
            }
            return photoID
        }

        private func admit(session: UIDropSession) -> Bool {
            guard let photoID = acceptedPhotoID(session: session) else {
                return false
            }
            if presentation.draggedPhotoID == nil {
                return presentation.begin(photoID: photoID, store: store)
            }
            return true
        }

        private func updateDestination(at location: CGPoint) {
            guard let destinationIndex = destinationIndex(location) else {
                return
            }
            presentation.updateInsertion(
                to: destinationIndex,
                store: store,
                reduceMotion: reduceMotion
            )
        }

        private func sessionLocation(
            session: UIDropSession,
            interaction: UIDropInteraction
        ) -> CGPoint {
            guard let view = interaction.view else {
                return .zero
            }
            let location = session.location(in: view)
            return CGPoint(
                x: location.x - view.bounds.minX,
                y: location.y - view.bounds.minY
            )
        }
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
    private let captureFlow: CaptureFlowModel?
    private let draftStore: (any CaptureDraftStoring)?
    private let expectedActivationID: UUID?

    init(
        captureFlow: CaptureFlowModel,
        expectedActivationID: UUID
    ) {
        self.captureFlow = captureFlow
        self.expectedActivationID = expectedActivationID
        draftStore = nil
    }

#if DEBUG
    init(draftStore: any CaptureDraftStoring) {
        captureFlow = nil
        expectedActivationID = nil
        self.draftStore = draftStore
    }
#endif

    @discardableResult
    func apply<Item: CaptureLibraryPhotoLoading>(
        _ items: [Item],
        to store: PhotoReviewStore
    ) async -> PhotoReviewIntakeOutcome {
        guard let request = store.activePickerRequest, let firstItem = items.first else {
            return .inert
        }
        if let captureFlow, let expectedActivationID {
            return await applyThroughNativeIntake(
                items,
                firstItem: firstItem,
                request: request,
                captureFlow: captureFlow,
                expectedActivationID: expectedActivationID,
                store: store
            )
        }
#if DEBUG
        guard let draftStore else {
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
#else
        return .inert
#endif
    }

    // New seller-facing strings. The approved Photo Review copy catalog covers the
    // resting screen and its announcements but names no intake failure, so these say
    // only what is true: this photo did not land, and nothing the seller already had
    // moved or disappeared.
    fileprivate static let additionFailureMessage =
        "Photo could not be added. Nothing else changed."
    fileprivate static let replacementFailureMessage =
        "Photo could not be replaced. Nothing else changed."

    private func applyThroughNativeIntake<Item: CaptureLibraryPhotoLoading>(
        _ items: [Item],
        firstItem: Item,
        request: PhotoReviewPickerRequest,
        captureFlow: CaptureFlowModel,
        expectedActivationID: UUID,
        store: PhotoReviewStore
    ) async -> PhotoReviewIntakeOutcome {
        let priorPhotos = store.photos
        let snapshot: NativeIntake.Snapshot?
        switch request {
        case .add:
            snapshot = await captureFlow.addPhotoReviewPhotos(
                items,
                expectedActivationID: expectedActivationID,
                while: { store.activePickerRequest == request }
            )
        case .replace(let photoID):
            snapshot = await captureFlow.replacePhotoReviewPhoto(
                id: photoID,
                with: firstItem,
                expectedActivationID: expectedActivationID,
                while: { store.activePickerRequest == request }
            )
        }

        guard let snapshot,
              store.activePickerRequest == request
                || store.photos == snapshot.photos else {
            return reject(request, in: store)
        }

        let priorIDs = Set(priorPhotos.map(\.id))
        switch request {
        case .add:
            let additions = snapshot.photos.filter { !priorIDs.contains($0.id) }
            guard !additions.isEmpty else {
                return reject(request, in: store)
            }
            store.publishCommittedPhotos(
                snapshot.photos,
                preferredSelection: additions.last?.id
            )
            recovery = nil
            return .applied(appliedPhotos: additions)
        case .replace(let photoID):
            guard let priorIndex = priorPhotos.firstIndex(where: { $0.id == photoID }),
                  snapshot.photos.indices.contains(priorIndex) else {
                return reject(request, in: store)
            }
            let replacement = snapshot.photos[priorIndex]
            store.publishCommittedPhotos(
                snapshot.photos,
                replacing: (photoID, replacement.id),
                preferredSelection: replacement.id
            )
            recovery = nil
            return .applied(appliedPhotos: [replacement])
        }
    }

    private func reject(
        _ request: PhotoReviewPickerRequest,
        in store: PhotoReviewStore
    ) -> PhotoReviewIntakeOutcome {
        guard store.activePickerRequest == request else {
            recovery = nil
            return .inert
        }
        store.cancelPickerRequest()
        recovery = PhotoReviewIntakeRecovery(
            message: request.failureMessage,
            focus: request.opener
        )
        return .inert
    }

#if DEBUG
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
            guard let draftStore,
                  let staged = try? await draftStore.append(
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
        try? await draftStore?.replacePhotos(with: photos)
    }
#endif
}

@MainActor
private extension PhotoReviewPickerRequest {
    var opener: PhotoReviewPickerOpener {
        switch self {
        case .add:
            .addButton
        case .replace(let photoID):
            .replaceButton(photoID: photoID)
        }
    }

    var failureMessage: String {
        switch self {
        case .add:
            PhotoReviewIntake.additionFailureMessage
        case .replace:
            PhotoReviewIntake.replacementFailureMessage
        }
    }
}

#if DEBUG
@MainActor
struct PhotoReviewFixtureView: View {
    @State private var store: PhotoReviewStore
    @State private var voiceNoteStore: VoiceNoteStore?
    @State private var observedLayout = PhotoReviewLayoutObservation(frames: [:])
    @State private var submissionPresentation: PhotoReviewSubmissionPresentation
    private let forceReducedMotion: Bool
    private let saveFailure: PhotoReviewSaveFailure?
    private let onLayoutObservation: ((PhotoReviewLayoutObservation) -> Void)?
    private let projectsFixtureOrder: Bool
    private let projectsLayoutProbe: Bool

    init(
        state: PhotoReviewVisualStateID,
        forceReducedMotion: Bool = false,
        submissionPresentation: PhotoReviewSubmissionPresentation = .idle,
        onLayoutObservation:
            ((PhotoReviewLayoutObservation) -> Void)? = nil
    ) {
        let photos = Self.photos(for: state)
        let store = PhotoReviewStore(photos: photos)
        if photos.indices.contains(state.selectedPhotoIndex) {
            store.selectPhotoForActions(
                id: photos[state.selectedPhotoIndex].id
            )
            if !state.presentsActions {
                store.dismissActions()
            }
        }
        _store = State(initialValue: store)
        _voiceNoteStore = State(
            initialValue: Self.makeVoiceNoteFixtureStore()
        )
        self.forceReducedMotion = forceReducedMotion
        saveFailure = state.saveFailure
        _submissionPresentation = State(initialValue: submissionPresentation)
        self.onLayoutObservation = onLayoutObservation
        projectsFixtureOrder = ProcessInfo.processInfo.arguments.contains(
            "--photo-review-fixture-order-probe"
        )
        projectsLayoutProbe = ProcessInfo.processInfo.arguments.contains(
            "--photo-review-layout-probe"
        )
    }

    var body: some View {
        // REV fixtures stage no live session, so delete is inert.
        PhotoReviewView(
            store: store,
            forceReducedMotion: forceReducedMotion,
            submissionPresentation: submissionPresentation,
            backToCamera: {},
            delete: { nil },
            saveFailure: saveFailure,
            retrySave: {},
            discardPhotos: {},
            openBoundary: handleFixtureBoundary,
            voiceNoteStore: voiceNoteStore,
            presentsVoiceNoteOnAppear: voiceNoteStore != nil,
            onLayoutObservation: recordLayoutObservation
        )
        .overlay(alignment: .topLeading) {
            if projectsFixtureOrder {
                Text(store.photos.map(\.id.uuidString).joined(separator: "|"))
                    .font(.system(size: 1))
                    .foregroundStyle(.clear)
                    .frame(width: 1, height: 1)
                    .allowsHitTesting(false)
                    .accessibilityLabel(
                        store.photos.map(\.id.uuidString).joined(separator: "|")
                    )
                    .accessibilityIdentifier("photo-review.fixture-order")
            }
            if projectsLayoutProbe {
                Text("Photo Review visible layout")
                    .font(.system(size: 1))
                    .foregroundStyle(.clear)
                    .frame(width: 1, height: 1)
                    .accessibilityElement()
                    .accessibilityLabel(layoutProbeLabel)
                    .accessibilityIdentifier("photo-review.layout-probe")
            }
        }
    }

    private func handleFixtureBoundary(_ event: PhotoReviewBoundaryEvent) {
        switch event {
        case .cancelSubmission:
            submissionPresentation = .visualState(.cancelled)
        case .completeSavedSubmission:
            submissionPresentation = .idle
        case .startListing, .retryAmbiguousSubmission,
             .retryReceiptMismatch:
            submissionPresentation = .visualState(.saving)
        case .reviewConflictedSubmission, .reviewSubmission:
            submissionPresentation = .idle
        case .openVoiceNote, .createAccount:
            break
        }
    }

    private func recordLayoutObservation(
        _ observation: PhotoReviewLayoutObservation
    ) {
        if observedLayout != observation {
            observedLayout = observation
        }
        onLayoutObservation?(observation)
    }

    private var layoutProbeLabel: String {
        let frames = [
            ("hero", PhotoReviewLayoutLandmark.hero),
            ("strip", .thumbnailStrip),
            ("thumbnail1", .thumbnail(0)),
            ("thumbnail2", .thumbnail(1)),
            ("thumbnail3", .thumbnail(2)),
            ("add", .addPhoto),
            ("voice", .voiceNote),
            ("start", .startListing)
        ]
        .map { name, landmark in
            let frame = observedLayout.frame(for: landmark)
            return String(
                format: "%@=%.1f,%.1f,%.1f,%.1f",
                name,
                frame.minX,
                frame.minY,
                frame.width,
                frame.height
            )
        }
        .joined(separator: ";")
        return "Photo Review visible frames;\(frames)"
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
                "\(state.rawValue) Photo Review fixture directory could not "
                    + "be created at \(rootDirectory.path): \(error)"
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
                state: state,
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
        state: PhotoReviewVisualStateID,
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
                    "\(state.rawValue) Photo Review fixture image could not "
                        + "be written at \(url.path): \(error)"
                )
            }
            precondition(
                isValidFixtureImage(at: url),
                "\(state.rawValue) Photo Review fixture image is invalid at \(url.path)"
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

    private static func makeVoiceNoteFixtureStore() -> VoiceNoteStore? {
        let arguments = ProcessInfo.processInfo.arguments
        guard arguments.contains(where: { $0.hasPrefix("--voice-note-") }) else {
            return nil
        }

        let hasSavedNote = arguments.contains(
            "--voice-note-saved-playing-fixture"
        ) || arguments.contains("--voice-note-save-failed-fixture")
        let savedNote = hasSavedNote
            ? VoiceNoteAsset(
                url: URL(
                    fileURLWithPath: "/tmp/snaplist-voice-note-ui-fixture.wav"
                ),
                duration: 12
            )
            : nil
        let store = VoiceNoteStore(
            savedNote: savedNote,
            audio: AVFoundationVoiceNoteAudioClient(),
            files: VoiceNoteLocalFileStore(
                rootDirectory: FileManager.default.temporaryDirectory
                    .appendingPathComponent(
                        "SnapList/VoiceNoteFixture",
                        isDirectory: true
                    )
            ),
            authority: nil
        )

        if arguments.contains("--voice-note-take-ready-fixture") {
            store.applyLaunchFixturePhase(.takeReady(duration: 15))
        } else if arguments.contains("--voice-note-recording-fixture") {
            store.applyLaunchFixturePhase(.recording(elapsed: 7, level: 0.72))
        } else if arguments.contains("--voice-note-saved-playing-fixture") {
            store.applyLaunchFixturePhase(.saved(isPlaying: true))
        } else if arguments.contains("--voice-note-interrupted-fixture") {
            store.applyLaunchFixturePhase(.interrupted)
        } else if arguments.contains("--voice-note-access-denied-fixture") {
            store.applyLaunchFixturePhase(.accessOff(permission: .denied))
        } else if arguments.contains("--voice-note-access-restricted-fixture") {
            store.applyLaunchFixturePhase(.accessOff(permission: .restricted))
        } else if arguments.contains("--voice-note-save-failed-fixture") {
            store.applyLaunchFixturePhase(.saveFailed)
        }

        return store
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
    case cancelSubmission
    case completeSavedSubmission(eventID: UUID)
    /// The seller was told an account is needed, and asked for the account entry
    /// point. Photo Review covers the shell, so only the shell can honor this.
    case createAccount(eventID: UUID)
    case retryReceiptMismatch(eventID: UUID)
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
    let id = UUID()
    let store: PhotoReviewStore
    let voiceNoteStore: VoiceNoteStore
    let intakeActivationID: UUID?
    private(set) var focusedPhotoID: StagedCapturePhoto.ID?
    private var pendingDeleteAnnouncement: String?
    private var isReorderCommitActive = false
    private var reorderCommitWaiters:
        [CheckedContinuation<Void, Never>] = []

    private init(
        store: PhotoReviewStore,
        voiceNoteStore: VoiceNoteStore,
        intakeActivationID: UUID?
    ) {
        self.store = store
        self.voiceNoteStore = voiceNoteStore
        self.intakeActivationID = intakeActivationID
    }

    static func start(
        from request: CaptureBoundaryRequest?,
        captureFlow: CaptureFlowModel? = nil
    ) -> PhotoReviewLiveSession? {
        guard let request,
              request.destination == .photoReview,
              request.opener == .reviewButton,
              (1...5).contains(request.photos.count) else {
            return nil
        }
        if let captureFlow,
           captureFlow.intakeSnapshot?.photos != request.photos {
            return nil
        }
#if DEBUG
        let launchArguments = ProcessInfo.processInfo.arguments
        let hasFixtureSavedNote = launchArguments.contains(
            "--voice-note-saved-playing-fixture"
        ) || launchArguments.contains(
            "--voice-note-save-failed-fixture"
        )
        let fixtureSavedNote = hasFixtureSavedNote
            ? VoiceNoteAsset(
                url: URL(
                    fileURLWithPath:
                        "/tmp/snaplist-voice-note-ui-fixture.wav"
                ),
                duration: 12
            )
            : nil
#else
        let fixtureSavedNote: VoiceNoteAsset? = nil
#endif
        let committedVoice = captureFlow?.intakeSnapshot?.voice
        let savedNote = committedVoice.map {
            VoiceNoteAsset(url: $0.mediaURL, duration: $0.duration)
        } ?? fixtureSavedNote
        let provisionalRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("SnapList", isDirectory: true)
            .appendingPathComponent("VoiceNoteProvisional", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let intakeActivationID =
            captureFlow?.intakeSnapshot?.version.activationID
        let authority: VoiceNoteCommitAuthority? = captureFlow.flatMap {
            captureFlow -> VoiceNoteCommitAuthority? in
            guard let intakeActivationID else {
                return nil
            }
            return VoiceNoteCommitAuthority(
                save: { [weak captureFlow] url, duration, isActive in
                    guard let voice = await captureFlow?.saveVoiceNote(
                        provisionalURL: url,
                        duration: duration,
                        expectedActivationID: intakeActivationID,
                        while: isActive
                    ) else {
                        return nil
                    }
                    return VoiceNoteAsset(
                        url: voice.mediaURL,
                        duration: voice.duration
                    )
                },
                delete: { [weak captureFlow] isActive in
                    await captureFlow?.deleteVoiceNote(
                        expectedActivationID: intakeActivationID,
                        while: isActive
                    ) ?? false
                }
            )
        }
        let voiceNoteStore = VoiceNoteStore(
            savedNote: savedNote,
            audio: AVFoundationVoiceNoteAudioClient(),
            files: VoiceNoteLocalFileStore(rootDirectory: provisionalRoot),
            authority: authority
        )
#if DEBUG
        if launchArguments.contains(
            "--voice-note-take-ready-fixture"
        ) {
            voiceNoteStore.applyLaunchFixturePhase(
                .takeReady(duration: 15)
            )
        } else if launchArguments.contains(
            "--voice-note-recording-fixture"
        ) {
            voiceNoteStore.applyLaunchFixturePhase(
                .recording(elapsed: 7, level: 0.72)
            )
        } else if launchArguments.contains(
            "--voice-note-saved-playing-fixture"
        ) {
            voiceNoteStore.applyLaunchFixturePhase(
                .saved(isPlaying: true)
            )
        } else if launchArguments.contains(
            "--voice-note-interrupted-fixture"
        ) {
            voiceNoteStore.applyLaunchFixturePhase(.interrupted)
        } else if launchArguments.contains(
            "--voice-note-access-denied-fixture"
        ) {
            voiceNoteStore.applyLaunchFixturePhase(
                .accessOff(permission: .denied)
            )
        } else if launchArguments.contains(
            "--voice-note-access-restricted-fixture"
        ) {
            voiceNoteStore.applyLaunchFixturePhase(
                .accessOff(permission: .restricted)
            )
        } else if launchArguments.contains(
            "--voice-note-save-failed-fixture"
        ) {
            voiceNoteStore.applyLaunchFixturePhase(.saveFailed)
        }
#endif
        let photoStore = PhotoReviewStore(photos: request.photos)
#if DEBUG
        if launchArguments.contains(where: { $0.hasPrefix("--voice-note-") }),
           request.photos.indices.contains(1) {
            photoStore.selectPhotoForActions(id: request.photos[1].id)
            photoStore.dismissActions()
        }
#endif
        return PhotoReviewLiveSession(
            store: photoStore,
            voiceNoteStore: voiceNoteStore,
            intakeActivationID: intakeActivationID
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

    func publishCommittedSnapshot(_ snapshot: NativeIntake.Snapshot) {
        if store.activePickerRequest == nil {
            store.publishCommittedPhotos(snapshot.photos)
        }
        voiceNoteStore.publishCommittedVoice(snapshot.voice)
    }

    func publishCommittedDelete(
        id: StagedCapturePhoto.ID,
        removedIndex: Int,
        snapshot: NativeIntake.Snapshot
    ) -> PhotoReviewLiveDeleteResult? {
        guard !snapshot.photos.contains(where: { $0.id == id }),
              store.photos.contains(where: { $0.id == id })
                || store.photos == snapshot.photos else {
            return nil
        }
        let focusPhotoID = snapshot.photos.indices.contains(removedIndex)
            ? snapshot.photos[removedIndex].id
            : snapshot.photos.last?.id
        store.publishCommittedPhotos(
            snapshot.photos,
            preferredSelection: focusPhotoID
        )
        guard let focusPhotoID else { return nil }
        let announcement = "Photo removed. \(snapshot.photos.count) of 5."
        self.focusedPhotoID = focusPhotoID
        pendingDeleteAnnouncement = announcement
        return PhotoReviewLiveDeleteResult(
            focus: .photo(focusPhotoID),
            announcement: announcement
        )
    }

    func commitReorder(
        photoID: StagedCapturePhoto.ID,
        destinationIndex: Int,
        captureFlow: CaptureFlowModel
    ) async -> PhotoReviewReorderResult? {
        await acquireReorderCommit()
        defer { releaseReorderCommit() }
        guard let intakeActivationID else {
            return nil
        }
        guard let proposedIDs = store.proposedPhotoOrder(
            moving: photoID,
            to: destinationIndex
        ),
        let snapshot = await captureFlow.reorderPhotoReviewPhotos(
            proposedIDs,
            expectedActivationID: intakeActivationID
        ),
        snapshot.photos.map(\.id) == proposedIDs else {
            return nil
        }
        return store.publishCommittedReorder(
            snapshot.photos,
            photoID: photoID,
            destinationIndex: destinationIndex
        )
    }

    private func acquireReorderCommit() async {
        guard isReorderCommitActive else {
            isReorderCommitActive = true
            return
        }
        await withCheckedContinuation { continuation in
            reorderCommitWaiters.append(continuation)
        }
    }

    private func releaseReorderCommit() {
        guard !reorderCommitWaiters.isEmpty else {
            isReorderCommitActive = false
            return
        }
        reorderCommitWaiters.removeFirst().resume()
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
        _ request: CaptureBoundaryRequest?,
        captureFlow: CaptureFlowModel? = nil
    ) -> Bool {
        guard let request else {
            return false
        }
        if activeRequest == request, session != nil {
            return false
        }
        guard let session = PhotoReviewLiveSession.start(
            from: request,
            captureFlow: captureFlow
        ) else {
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

    func completeCommittedFinalDelete(
        from returningSession: PhotoReviewLiveSession,
        using router: AppRouter
    ) -> PhotoReviewLiveFinalDeleteResult? {
        guard session === returningSession,
              returningSession.store.photos.isEmpty else {
            return nil
        }
        let scanReturn = PhotoReviewScanReturn(
            photos: [],
            focus: .addPhotoButton
        )
        let announcement = "Photo removed. No photos remain."
        router.returnFromPhotoReview(scanReturn)
        session = nil
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

    func leaveForDepartedIntake(using router: AppRouter) -> Bool {
        guard session != nil else {
            return false
        }
        router.returnFromPhotoReview(
            PhotoReviewScanReturn(photos: [], focus: .addPhotoButton)
        )
        session = nil
        activeRequest = nil
        return true
    }

    func leaveForDepartedIntake(
        from liveSession: PhotoReviewLiveSession,
        using router: AppRouter
    ) -> Bool {
        guard session === liveSession else {
            return false
        }
        return leaveForDepartedIntake(using: router)
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

enum PhotoReviewSaveFailureState: Hashable {
    case firstRejection
    case rejectedAgain
}

struct PhotoReviewSaveFailureAnnouncementConsumer {
    private var announcedReadings: Set<PhotoReviewSaveFailureAnnouncementKey> = []

    mutating func consume(_ failure: PhotoReviewSaveFailure?) -> String? {
        guard let failure else {
            announcedReadings.removeAll()
            return nil
        }
        let reading = PhotoReviewSaveFailureAnnouncementKey(
            sessionID: failure.sessionID,
            state: failure.state
        )
        guard announcedReadings.insert(reading).inserted else { return nil }
        return failure.liveRegionAnnouncement
    }
}

private struct PhotoReviewSaveFailureAnnouncementKey: Hashable {
    let sessionID: UUID
    let state: PhotoReviewSaveFailureState
}

struct PhotoReviewSaveFailureEvidenceLayout {
    let photoCount: Int
    let isAccessibilitySize: Bool

    private let recognitionFloor: CGFloat = 104
    private let tileAspectRatio: CGFloat = 4 / 5
    private let gap: CGFloat = 10
    private let verticalPadding: CGFloat = 36

    func columnCount(for contentWidth: CGFloat) -> Int {
        guard photoCount > 0 else { return 1 }
        if !isAccessibilitySize {
            return standardColumnCount
        }

        var columns = photoCount
        while columns > 1,
              (contentWidth - CGFloat(columns - 1) * gap) / CGFloat(columns)
                < recognitionFloor {
            columns -= 1
        }
        return columns
    }

    var minimumColumnCount: Int {
        guard photoCount > 0 else { return 1 }
        return isAccessibilitySize ? min(photoCount, 3) : standardColumnCount
    }

    func minimumHeight(for columns: Int) -> CGFloat {
        let rows = rowCount(for: columns)
        return CGFloat(rows) * (recognitionFloor / tileAspectRatio)
            + CGFloat(rows - 1) * gap
            + verticalPadding
    }

    func tileWidth(in availableSize: CGSize, columns: Int) -> CGFloat {
        let rows = rowCount(for: columns)
        let widthCap = max(
            0,
            (availableSize.width - CGFloat(columns - 1) * gap) / CGFloat(columns)
        )
        let heightDerived = max(
            0,
            (availableSize.height - verticalPadding - CGFloat(rows - 1) * gap)
                / CGFloat(rows) * tileAspectRatio
        )
        return min(widthCap, max(recognitionFloor, heightDerived))
    }

    private func rowCount(for columns: Int) -> Int {
        max(1, Int(ceil(Double(max(photoCount, 1)) / Double(columns))))
    }

    private var standardColumnCount: Int {
        switch photoCount {
        case 1...2: photoCount
        case 3...4: 2
        default: 3
        }
    }
}

enum PhotoReviewSaveFailureDiscardButtonStyle: Equatable {
    case outlined
    case filled
}

enum PhotoReviewSaveFailureAction: Equatable {
    case backToCamera
    case delete(StagedCapturePhoto.ID)
}

struct PhotoReviewSaveFailure: Equatable {
    private(set) var state: PhotoReviewSaveFailureState = .firstRejection
    let sessionID: UUID
    let action: PhotoReviewSaveFailureAction

    init(
        sessionID: UUID = UUID(),
        action: PhotoReviewSaveFailureAction
    ) {
        self.sessionID = sessionID
        self.action = action
    }

    var heading: String {
        switch state {
        case .firstRejection:
            "These photos cannot be saved."
        case .rejectedAgain:
            "Saving failed again. These photos cannot be kept."
        }
    }

    var body: String {
        switch state {
        case .firstRejection:
            "SnapList could not save the photos on this screen. This is a problem on this device, not something you did. No credit was used."
        case .rejectedAgain:
            "Nothing more will recover them. Discard them to continue."
        }
    }

    var primaryActionTitle: String? {
        state == .firstRejection ? "Try saving again" : nil
    }

    let secondaryActionTitle = "Discard these photos"

    var discardButtonStyle: PhotoReviewSaveFailureDiscardButtonStyle {
        switch state {
        case .firstRejection:
            .outlined
        case .rejectedAgain:
            .filled
        }
    }

    var liveRegionAnnouncement: String {
        switch state {
        case .firstRejection:
            "These photos cannot be saved. No credit was used. Actions: Try saving again, Discard these photos."
        case .rejectedAgain:
            "Saving failed again. These photos cannot be kept. Actions: Discard these photos."
        }
    }

    mutating func recordAnotherRejection() {
        state = .rejectedAgain
    }
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
            request,
            expectedActivationID: session.intakeActivationID
        ) else {
            return .persistenceRejected
        }

        await captureFlow.startCamera()
        guard host.completeReturnToScan(from: session) else {
            return .sessionChanged
        }
        _ = await captureFlow.markPhotoReviewLeft(
            activationID: session.intakeActivationID
        )

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
    /// Fixture-only override. Live Photo Review always follows the system setting.
    var forceReducedMotion = false
    var submissionPresentation: PhotoReviewSubmissionPresentation = .idle
    var focusStartListingRequest: UUID?
    var postSubmissionAnnouncement: (String) -> Void = {
        UIAccessibility.post(notification: .announcement, argument: $0)
    }
    var acknowledgeSubmissionPresentation: (UUID) -> Void = { _ in }
    var backToCamera: (() -> Void)? = nil
    let delete: () async -> PhotoReviewDeleteApplication?
    var saveFailure: PhotoReviewSaveFailure?
    var retrySave: (() -> Void)? = nil
    var discardPhotos: (() -> Void)? = nil
    var commitReorder:
        ((StagedCapturePhoto.ID, Int) async -> PhotoReviewReorderResult?)? = nil
    var openBoundary: ((PhotoReviewBoundaryEvent) -> Void)? = nil
    var voiceNoteStore: VoiceNoteStore? = nil
    /// DEBUG fixtures can launch directly into an app-owned Voice Note state.
    /// Production leaves this false and presents only after the seller taps the row.
    var presentsVoiceNoteOnAppear = false
    /// Absent in fixtures, which stage no durable session and so cannot apply a picker
    /// result. The picker still opens; nothing lands.
    var intake: PhotoReviewIntake? = nil
    /// Read-only qualification output. Production callers leave this nil.
    var onLayoutObservation:
        ((PhotoReviewLayoutObservation) -> Void)? = nil

    @State private var actionPresentation = PhotoReviewActionPresentation()
    @State private var accessibilityActionPresentation =
        PhotoReviewAccessibilityActionPresentation()
    @State private var dragPresentation = PhotoReviewDragPresentation()
    @State private var thumbnailFrames: [StagedCapturePhoto.ID: CGRect] = [:]
    @State private var thumbnailStripViewportWidth: CGFloat = 0
#if DEBUG
    @State private var renderedInsertionGapObservation =
        PhotoReviewRenderedInsertionGapObservation()
    @State private var nativeDragSourceObservation =
        PhotoReviewNativeDragSourceObservation()
    @State private var nativeDropObservation =
        PhotoReviewNativeDropObservation()
    @State private var observedAutoScrollEdge: String?
#endif
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var pickerPresentation = PhotoReviewPickerPresentation()
    @State private var capacityAnnouncer = PhotoReviewCapacityAnnouncer()
    @State private var isVoiceNotePresented = false
    @State private var submissionEffectConsumer =
        PhotoReviewSubmissionEffectConsumer()
    @State private var saveFailureAnnouncementConsumer =
        PhotoReviewSaveFailureAnnouncementConsumer()
    // Outside dismissal focus stays independent from picker cancellation focus.
    @FocusState private var hardwareFocusedThumbnailID: StagedCapturePhoto.ID?
    @AccessibilityFocusState private var focusedThumbnailID: StagedCapturePhoto.ID?
    @AccessibilityFocusState private var focusedPickerOpener: PickerFocusTarget?
    @AccessibilityFocusState private var focusedVoiceNoteOpener: Bool
    @AccessibilityFocusState private var focusedStartListing: Bool
    @AccessibilityFocusState private var focusedSaveFailureHeading: Bool
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .headline)
    private var reviewTitleSize: CGFloat = 17
    @ScaledMetric(relativeTo: .caption)
    private var reviewCountSize: CGFloat = 13
    @ScaledMetric(relativeTo: .body)
    private var saveFailureActionTitleSize: CGFloat = 16

    private enum PickerFocusTarget: Hashable {
        case addButton
        case replaceButton(photoID: StagedCapturePhoto.ID)
    }

    private var selectedPhoto: StagedCapturePhoto? {
        store.photos.first(where: { $0.id == store.selectedPhotoID })
            ?? store.photos.first
    }

    private var reduceMotion: Bool {
        systemReduceMotion || forceReducedMotion
    }

#if DEBUG
    private var dragObservationLabel: String {
        let gap = Int(
            renderedInsertionGapObservation
                .maximumRenderedInsertionGap
                .rounded()
        )
        let edge = observedAutoScrollEdge ?? "none"
        let transition =
            dragPresentation.lastTransitionDecision?.rawValue ?? "none"
        return [
            "gap=\(gap)",
            "edge=\(edge)",
            "transition=\(transition)",
            "source=\(nativeDragSourceObservation.label)",
            "drop=\(nativeDropObservation.label)"
        ]
        .joined(separator: ";")
    }
#endif

    var body: some View {
        Group {
            if let saveFailure {
                saveFailureContent(saveFailure)
            } else if submissionPresentation.rendersSubmittedMedia {
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
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .containerRelativeFrame(.horizontal)
        .background {
            SnapListColorToken.groupingFill.color
                .contentShape(.rect)
                .onTapGesture(perform: dismissActionsOutside)
        }
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
        .onChange(of: saveFailure, initial: true) { _, failure in
            guard let announcement = saveFailureAnnouncementConsumer.consume(failure) else {
                return
            }
            focusedSaveFailureHeading = true
            postSubmissionAnnouncement(announcement)
        }
        .onChange(of: focusStartListingRequest) { _, request in
            guard request != nil else { return }
            focusedStartListing = true
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
        .overlay(alignment: .topLeading) {
#if DEBUG
            VStack(spacing: 0) {
                if reduceMotion {
                    Color.clear
                        .frame(width: 1, height: 1)
                        .accessibilityElement()
                        .accessibilityLabel("Reduced motion")
                        .accessibilityIdentifier("photo-review.motion-reduced")
                }
                if dragPresentation.draggedPhotoID != nil {
                    Color.clear
                        .frame(width: 1, height: 1)
                        .accessibilityElement()
                        .accessibilityLabel("Drag active")
                        .accessibilityIdentifier("photo-review.drag-active")
                }
                if renderedInsertionGapObservation
                    .maximumRenderedInsertionGap > 0
                    || observedAutoScrollEdge != nil
                    || dragPresentation.lastTransitionDecision != nil
                    || nativeDragSourceObservation.hasActivity
                    || nativeDropObservation.hasActivity {
                    Color.clear
                        .frame(width: 1, height: 1)
                        .accessibilityElement()
                        .accessibilityLabel(dragObservationLabel)
                        .accessibilityIdentifier(
                            "photo-review.drag-observation"
                        )
                }
            }
            .allowsHitTesting(false)
#endif
        }
        .overlay {
            if isVoiceNotePresented, let voiceNoteStore {
                ZStack(alignment: .bottom) {
                    Color.black.opacity(0.32)
                        .contentShape(.rect)
                        .onTapGesture {}
                        .accessibilityHidden(true)

                    VoiceNoteSheet(
                        store: voiceNoteStore,
                        forceReducedMotion: reduceMotion,
                        dismissPresentation: dismissVoiceNotePresentation
                    )
                    .frame(maxWidth: .infinity)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .ignoresSafeArea()
                .transition(.move(edge: .bottom))
                .zIndex(10)
            }
        }
        .animation(
            reduceMotion ? nil : .easeOut(duration: 0.24),
            value: isVoiceNotePresented
        )
        .onAppear {
            if presentsVoiceNoteOnAppear, voiceNoteStore != nil {
                isVoiceNotePresented = true
            }
        }
    }

    private var reviewContent: some View {
        GeometryReader { screen in
            let screenWidth = screen.size.width
            let contentWidth = max(
                0,
                screenWidth
                    - (2 * PhotoReviewV5VisualContract.contentGutter)
            )
            VStack(spacing: 0) {
                topBar
                    .photoReviewLayoutLandmark(.header)
                    .allowsHitTesting(
                        !(isCommitting
                            || submissionPresentation.mutationControlsLocked)
                    )

                GeometryReader { viewport in
                    let heroHeight = PhotoReviewV5VisualContract.heroHeight
                    ScrollView {
                        VStack(spacing: 0) {
                            if submissionPresentation.rendersSubmittedMedia {
                                HStack(spacing: 0) {
                                    Spacer(minLength: 0)
                                    hero(
                                        width: contentWidth,
                                        height: heroHeight
                                    )
                                    Spacer(minLength: 0)
                                }
                                HStack(spacing: 0) {
                                    Spacer(minLength: 0)
                                    thumbnailStrip
                                        .frame(
                                            width: contentWidth,
                                            alignment: .leading
                                        )
                                    Spacer(minLength: 0)
                                }
                                    .padding(
                                        .top,
                                        PhotoReviewV5VisualContract
                                            .thumbnailStripTopPadding
                                    )

                                if let recovery = intake?.recovery {
                                    Text(recovery.message)
                                        .snapListTypography(.metadata)
                                        .foregroundStyle(SnapListColorToken.inkPrimary.color)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .accessibilityIdentifier("photo-review.intake-recovery")
                                }

                                if store.actionsPhotoID != nil {
                                    actionRow
                                        .frame(
                                            width: contentWidth,
                                            height: PhotoReviewV5VisualContract
                                                .actionRowHeight
                                        )
                                        .photoReviewLayoutLandmark(.actionRow)
                                        .padding(
                                            .top,
                                            PhotoReviewV5VisualContract
                                                .voiceRowTopPadding
                                        )
                                }

                                if let openBoundary {
                                    HStack(spacing: 0) {
                                        Spacer(minLength: 0)
                                        voiceRow(openBoundary)
                                            .frame(width: contentWidth)
                                            .photoReviewLayoutLandmark(.voiceNote)
                                        Spacer(minLength: 0)
                                    }
                                    .padding(
                                        .top,
                                        PhotoReviewV5VisualContract
                                            .voiceRowTopPadding
                                    )
                                }
                            }
                        }
                        .padding(.top, 16)
                        .padding(.bottom, 8)
                        // Live Photo Review v5 fixes the hero at 300pt. The scroll viewport
                        // keeps the remaining review content reachable on compact screens
                        // and at larger Dynamic Type sizes.
                        .frame(minHeight: viewport.size.height, alignment: .top)
                    }
                    // The screen identity stays on the scrolling region itself, so the
                    // sticky action below is genuinely outside the scrollable content.
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("photo-review.screen")
                    .allowsHitTesting(
                        !(isCommitting
                            || submissionPresentation.mutationControlsLocked)
                    )
                }

                if let openBoundary {
                    submissionFooter(
                        openBoundary,
                        contentWidth: contentWidth
                    )
                        .photoReviewLayoutLandmark(.footer)
                }
            }
            .frame(width: screenWidth, height: screen.size.height)
        }
        .onPreferenceChange(
            PhotoReviewLayoutPreferenceKey.self
        ) { frames in
            onLayoutObservation?(
                PhotoReviewLayoutObservation(frames: frames)
            )
        }
    }

    private func saveFailureContent(
        _ failure: PhotoReviewSaveFailure
    ) -> some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    saveFailureHeading(failure)
                    saveFailureBody(failure)
                    saveFailureEvidence
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("photo-review.save-failure")

            saveFailureActionBlock(failure)
        }
        .background(SnapListColorToken.quietFill.color)
    }

    private func saveFailureHeading(
        _ failure: PhotoReviewSaveFailure
    ) -> some View {
        Text(failure.heading)
            .font(.title2.weight(.bold))
            .foregroundStyle(SnapListColorToken.inkPrimary.color)
            .padding(.horizontal, SnapListMetrics.screenGutter)
            .padding(.top, 20)
            .padding(.bottom, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(SnapListColorToken.canvas.color)
            .accessibilityAddTraits(.isHeader)
            .accessibilityFocused($focusedSaveFailureHeading)
            .accessibilityIdentifier("photo-review.save-failure.heading")
    }

    private func saveFailureBody(
        _ failure: PhotoReviewSaveFailure
    ) -> some View {
        Text(failure.body)
            .snapListTypography(.body)
            .foregroundStyle(SnapListColorToken.textSecondary.color)
            .padding(.horizontal, SnapListMetrics.screenGutter)
            .padding(.bottom, 22)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(SnapListColorToken.canvas.color)
            .accessibilityIdentifier("photo-review.save-failure.body")
    }

    @ViewBuilder
    private var saveFailureEvidence: some View {
        let layout = PhotoReviewSaveFailureEvidenceLayout(
            photoCount: store.photos.count,
            isAccessibilitySize: dynamicTypeSize.isAccessibilitySize
        )
        GeometryReader { proxy in
            let contentWidth = max(0, proxy.size.width - 36)
            let columns = layout.columnCount(for: contentWidth)
            let tileWidth = layout.tileWidth(
                in: CGSize(width: contentWidth, height: proxy.size.height),
                columns: columns
            )
            LazyVGrid(
                columns: Array(
                    repeating: GridItem(.fixed(tileWidth), spacing: 10),
                    count: columns
                ),
                spacing: 10
            ) {
                ForEach(Array(store.photos.enumerated()), id: \.element.id) {
                    index,
                    photo in
                    LocalCaptureImage(
                        url: photo.thumbnailURL,
                        maximumPixelSize: 360
                    )
                    .scaledToFill()
                    .frame(width: tileWidth, height: tileWidth / (4 / 5))
                    .clipped()
                    .clipShape(.rect(cornerRadius: 12))
                    .accessibilityHidden(true)
                    .accessibilityIdentifier(
                        "photo-review.save-failure.photo.\(index + 1)"
                    )
                }
            }
            .frame(maxWidth: .infinity)
            .padding(18)
        }
        .frame(
            minHeight: layout.minimumHeight(
                for: layout.minimumColumnCount
            )
        )
        .background(SnapListColorToken.quietFill.color)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(SnapListColorToken.hairline.color)
                .frame(height: 1)
                .accessibilityHidden(true)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            "\(store.photos.count) \(store.photos.count == 1 ? "photo" : "photos") on this screen"
        )
        .accessibilityIdentifier("photo-review.save-failure.photos")
    }

    @ViewBuilder
    private func saveFailureActionBlock(
        _ failure: PhotoReviewSaveFailure
    ) -> some View {
        VStack(spacing: 12) {
            if let primaryActionTitle = failure.primaryActionTitle,
               let retrySave {
                Button(action: retrySave) {
                    saveFailureActionLabel(
                        primaryActionTitle,
                        foreground: SnapListColorToken.canvas.color
                    )
                }
                .buttonStyle(.plain)
                .background(SnapListColorToken.action.color)
                .clipShape(.rect(cornerRadius: 15))
                    .accessibilityIdentifier("photo-review.save-failure.retry")
            }

            if let discardPhotos {
                Button(
                    failure.secondaryActionTitle,
                    role: .destructive,
                    action: discardPhotos
                )
                .font(.system(size: saveFailureActionTitleSize, weight: .bold))
                .foregroundStyle(discardButtonForeground(for: failure))
                .frame(maxWidth: .infinity, minHeight: 52)
                .buttonStyle(.plain)
                .background(discardButtonBackground(for: failure))
                .clipShape(.rect(cornerRadius: 15))
                .overlay {
                    RoundedRectangle(cornerRadius: 15)
                        .stroke(
                            SnapListColorToken.inkPrimary.color,
                            lineWidth: 1.5
                        )
                }
                .accessibilityIdentifier("photo-review.save-failure.discard")
            }
        }
        .padding(.horizontal, SnapListMetrics.screenGutter)
        .padding(.vertical, 12)
        .background(SnapListColorToken.canvas.color)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(SnapListColorToken.hairline.color)
                .frame(height: 1)
                .accessibilityHidden(true)
        }
    }

    private func saveFailureActionLabel(
        _ title: String,
        foreground: Color
    ) -> some View {
        Text(title)
            .font(.system(size: saveFailureActionTitleSize, weight: .bold))
            .foregroundStyle(foreground)
            .frame(maxWidth: .infinity, minHeight: 52)
            .contentShape(.rect)
    }

    private func discardButtonBackground(
        for failure: PhotoReviewSaveFailure
    ) -> Color {
        switch failure.discardButtonStyle {
        case .outlined:
            SnapListColorToken.canvas.color
        case .filled:
            SnapListColorToken.inkPrimary.color
        }
    }

    private func discardButtonForeground(
        for failure: PhotoReviewSaveFailure
    ) -> Color {
        switch failure.discardButtonStyle {
        case .outlined:
            SnapListColorToken.inkPrimary.color
        case .filled:
            SnapListColorToken.canvas.color
        }
    }

    @ViewBuilder
    private var topBar: some View {
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 0) {
                    backControl
                    Spacer(minLength: 12)
                    countPill
                }
                reviewTitle
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.top, 6)
            .padding(.trailing, 10)
            .padding(.bottom, 8)
            .padding(.leading, 6)
            .frame(minHeight: 103)
            .background(SnapListColorToken.canvas.color)
            .overlay(alignment: .bottom) {
                Rectangle()
                    .fill(SnapListColorToken.hairline.color)
                    .frame(height: 1)
                    .accessibilityHidden(true)
            }
        } else {
            ZStack {
                reviewTitle
                HStack(spacing: 0) {
                    backControl
                    Spacer(minLength: 12)
                    countPill
                }
                .padding(.leading, 8)
                .padding(.trailing, 12)
            }
            .frame(
                minHeight:
                    PhotoReviewV5VisualContract.headerMinimumHeight
            )
            .background(SnapListColorToken.canvas.color)
            .overlay(alignment: .bottom) {
                Rectangle()
                    .fill(SnapListColorToken.hairline.color)
                    .frame(height: 1)
                    .accessibilityHidden(true)
            }
        }
    }

    @ViewBuilder
    private var backControl: some View {
        if let backToCamera {
            Button(action: backToCamera) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .frame(
                        width:
                            PhotoReviewV5VisualContract.backTargetSize,
                        height:
                            PhotoReviewV5VisualContract.backTargetSize
                    )
                    .contentShape(Rectangle())
                    .accessibilityHidden(true)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Back to camera")
            .accessibilityIdentifier("photo-review.back")
            .photoReviewLayoutLandmark(.back)
        }
    }

    private var reviewTitle: some View {
        Text("Review photos")
            .font(
                .system(
                    size: reviewTitleSize,
                    weight: .bold,
                    design: .default
                )
            )
            .tracking(-0.2)
            .foregroundStyle(SnapListColorToken.inkPrimary.color)
            .photoReviewLayoutLandmark(.title)
    }

    private var countPill: some View {
        Text("\(store.photos.count) of 5")
            .font(
                .system(
                    size: reviewCountSize,
                    weight: .semibold,
                    design: .default
                )
            )
            .foregroundStyle(SnapListColorToken.textSecondary.color)
            .padding(.vertical, 5)
            .padding(.horizontal, 9)
            .background(
                SnapListColorToken.quietFill.color,
                in: RoundedRectangle(
                    cornerRadius:
                        PhotoReviewV5VisualContract.countRadius
                )
            )
            .fixedSize()
            .frame(minWidth: 52, minHeight: 44, alignment: .trailing)
            .accessibilityIdentifier("photo-review.count")
            .photoReviewLayoutLandmark(.countPill)
    }

    @ViewBuilder
    private func hero(width: CGFloat, height: CGFloat) -> some View {
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
                .frame(
                    width: width,
                    height: height
                )
                .clipped()
                .clipShape(
                    .rect(
                        cornerRadius:
                            PhotoReviewV5VisualContract.heroRadius
                    )
                )
                .overlay {
                    RoundedRectangle(
                        cornerRadius:
                            PhotoReviewV5VisualContract.heroRadius
                    )
                    .stroke(
                        SnapListColorToken.hairline.color,
                        lineWidth: 1
                    )
                    .accessibilityHidden(true)
                }
                .accessibilityHidden(true)
            }
            .buttonStyle(.plain)
            .frame(width: width, height: height)
            .accessibilityLabel(
                photoAccessibilityLabel(
                    index: selectedIndex,
                    isSelected: true,
                    includesThumbnailActions: false
                )
            )
            .accessibilityIdentifier("photo-review.hero")
            .photoReviewLayoutLandmark(.hero)
        }
    }

    private var thumbnailStrip: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal) {
                HStack(
                    alignment: .top,
                    spacing: PhotoReviewV5VisualContract.thumbnailGap
                ) {
                    ForEach(Array(store.photos.enumerated()), id: \.element.id) { index, photo in
                        thumbnail(photo, index: index)
                            .id(photo.id)
                            .background {
                                GeometryReader { geometry in
                                    Color.clear.preference(
                                        key: PhotoReviewThumbnailFramePreferenceKey.self,
                                        value: [
                                            photo.id: geometry.frame(
                                                in: .named(
                                                    "photo-review.thumbnail-strip"
                                                )
                                            )
                                        ]
                                    )
                                }
                            }
                    }
                    addButton
                }
                // Keeping both native attachments inside the horizontal
                // content makes its nearest scroll ancestor the strip host,
                // even when Photo Review is nested in the screen scroll view.
                .background {
                    ZStack {
                        PhotoReviewNativeDragSourceAttachment(
                            store: store,
                            presentation: dragPresentation,
                            reduceMotion: reduceMotion,
                            isEnabled: nativeDragInteractionsEnabled,
                            sourceAtLocation: { location in
                                observeNativeDragSource(
                                    .resolving(
                                        frameCount: thumbnailFrames.count
                                    )
                                )
                                return PhotoReviewNativeDragSourceGeometry.source(
                                    at: location,
                                    photos: store.photos,
                                    frames: thumbnailFrames
                                )
                            },
                            observeSource: observeNativeDragSource
                        )
                        PhotoReviewNativeDropAttachment(
                            store: store,
                            presentation: dragPresentation,
                            reduceMotion: reduceMotion,
                            isEnabled: nativeDragInteractionsEnabled,
                            destinationIndex: { location in
                                PhotoReviewStripDropGeometry.destinationIndex(
                                    at: location,
                                    photos: store.photos,
                                    frames: thumbnailFrames
                                )
                            },
                            autoScroll: { location in
                                autoScrollThumbnailStripIfNeeded(
                                    at: location,
                                    proxy: proxy
                                )
                            },
                            commitReorder: commitReorder,
                            observeDrop: observeNativeDrop
                        )
                    }
                }
            }
            .coordinateSpace(name: "photo-review.thumbnail-strip")
            .scrollIndicators(.hidden)
            .background {
                GeometryReader { geometry in
                    Color.clear.preference(
                        key: PhotoReviewThumbnailStripWidthPreferenceKey.self,
                        value: geometry.size.width
                    )
                }
            }
            .onPreferenceChange(
                PhotoReviewThumbnailFramePreferenceKey.self
            ) { frames in
#if DEBUG
                renderedInsertionGapObservation.observe(
                    frames: frames,
                    isDragActive: dragPresentation.draggedPhotoID != nil
                )
#endif
                thumbnailFrames = frames
            }
            .onPreferenceChange(
                PhotoReviewThumbnailStripWidthPreferenceKey.self
            ) { width in
                thumbnailStripViewportWidth = width
            }
            .photoReviewLayoutLandmark(.thumbnailStrip)
        }
    }

    private func thumbnail(
        _ photo: StagedCapturePhoto,
        index: Int
    ) -> some View {
        let isSelected = photo.id == store.selectedPhotoID
        let insertionEdge = dragPresentation.insertionEdge(
            for: photo.id,
            at: index,
            store: store
        )
        return VStack(
            spacing: PhotoReviewV5VisualContract.coverColumnGap
        ) {
            Button {
                store.selectPhotoForActions(id: photo.id)
                hardwareFocusedThumbnailID = photo.id
            } label: {
                LocalCaptureImage(
                    url: photo.thumbnailURL,
                    maximumPixelSize: 180
                )
                .scaledToFill()
                .frame(
                    width: PhotoReviewV5VisualContract.thumbnailSize,
                    height: PhotoReviewV5VisualContract.thumbnailSize
                )
                .clipped()
                .clipShape(
                    .rect(
                        cornerRadius:
                            PhotoReviewV5VisualContract.thumbnailRadius
                    )
                )
                .overlay {
                    RoundedRectangle(
                        cornerRadius:
                            PhotoReviewV5VisualContract.thumbnailRadius
                    )
                        .stroke(
                            isSelected ? SnapListColorToken.action.color : .clear,
                            lineWidth: 3
                        )
                }
                .accessibilityHidden(true)
            }
            .buttonStyle(.plain)
            .photoReviewLayoutLandmark(.thumbnail(index))
            .accessibilityLabel(
                photoAccessibilityLabel(
                    index: index,
                    isSelected: isSelected,
                    includesThumbnailActions: true
                )
            )
            .accessibilityAddTraits(isSelected ? .isSelected : [])
            .accessibilityIdentifier("photo-review.thumbnail.\(index + 1)")
            .focusable()
            .focused(
                $hardwareFocusedThumbnailID,
                equals: photo.id
            )
            .onKeyPress(
                keys: [.leftArrow, .rightArrow],
                phases: .down
            ) { press in
                handleThumbnailKeyPress(press, photoID: photo.id)
            }
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
                    Button(
                        PhotoReviewReorderAction.moveEarlier
                            .accessibilityLabel
                    ) {
                        performAccessibilityAction(.moveEarlier, photoID: photo.id)
                    }
                }
                if actions.contains(.moveLater) {
                    Button(
                        PhotoReviewReorderAction.moveLater
                            .accessibilityLabel
                    ) {
                        performAccessibilityAction(.moveLater, photoID: photo.id)
                    }
                }
                if actions.contains(.makeCover) {
                    Button(
                        PhotoReviewReorderAction.makeCover
                            .accessibilityLabel
                    ) {
                        performAccessibilityAction(.makeCover, photoID: photo.id)
                    }
                }
            }

            if index == 0 {
                Text("Cover")
                    .snapListTypography(.metadata)
                    .fontWeight(.semibold)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .padding(
                        .vertical,
                        PhotoReviewV5VisualContract.coverVerticalPadding
                    )
                    .padding(
                        .horizontal,
                        PhotoReviewV5VisualContract.coverHorizontalPadding
                    )
                    .background(
                        SnapListColorToken.canvas.color,
                        in: RoundedRectangle(
                            cornerRadius:
                                PhotoReviewV5VisualContract.coverRadius
                        )
                    )
                    .overlay {
                        RoundedRectangle(
                            cornerRadius:
                                PhotoReviewV5VisualContract.coverRadius
                        )
                        .stroke(
                            SnapListColorToken.hairline.color,
                            lineWidth: 1
                        )
                    }
                    .fixedSize()
                    .accessibilityHidden(true)
                    .photoReviewLayoutLandmark(.coverPill)
            }
        }
        // v1.2 interaction.drag.insertion_gap_px. This exists only while a native
        // drag is over a different ordinal, so the resting strip gains no control.
        .padding(
            .leading,
            insertionEdge == .leading
                ? PhotoReviewDragLayout.insertionGap
                : 0
        )
        .padding(
            .trailing,
            insertionEdge == .trailing
                ? PhotoReviewDragLayout.insertionGap
                : 0
        )
        .opacity(dragPresentation.draggedPhotoID == photo.id ? 0 : 1)
    }

    private func autoScrollThumbnailStripIfNeeded(
        at location: CGPoint,
        proxy: ScrollViewProxy
    ) {
        guard !store.photos.isEmpty else {
            return
        }
        if location.x <= PhotoReviewDragLayout.edgeAutoScrollThreshold {
#if DEBUG
            observedAutoScrollEdge = "leading"
#endif
            scrollToPhoto(at: 0, proxy: proxy, anchor: .leading)
        } else if location.x >= thumbnailStripViewportWidth
            - PhotoReviewDragLayout.edgeAutoScrollThreshold {
#if DEBUG
            observedAutoScrollEdge = "trailing"
#endif
            scrollToPhoto(
                at: store.photos.index(before: store.photos.endIndex),
                proxy: proxy,
                anchor: .trailing
            )
        }
    }

    private func observeNativeDrop(_ event: PhotoReviewNativeDropEvent) {
#if DEBUG
        nativeDropObservation.observe(event)
#endif
    }

    private func observeNativeDragSource(
        _ event: PhotoReviewNativeDragSourceEvent
    ) {
#if DEBUG
        nativeDragSourceObservation.observe(event)
#endif
    }

    private func scrollToPhoto(
        at destinationIndex: Int,
        proxy: ScrollViewProxy,
        anchor: UnitPoint
    ) {
        guard store.photos.indices.contains(destinationIndex) else {
            return
        }
        let decision = PhotoReviewDragAnimationPolicy.decision(
            reduceMotion: reduceMotion
        )
        if decision == .suppressed {
            proxy.scrollTo(store.photos[destinationIndex].id, anchor: anchor)
        } else {
            withAnimation(
                PhotoReviewDragAnimationPolicy.animation(for: decision)
            ) {
                proxy.scrollTo(store.photos[destinationIndex].id, anchor: anchor)
            }
        }
    }

    private func photoAccessibilityLabel(
        index: Int,
        isSelected: Bool,
        includesThumbnailActions: Bool
    ) -> String {
        var truths = ["Photo \(index + 1) of \(store.photos.count)"]
        if index == 0 {
            truths.append("Cover")
        }
        if isSelected {
            truths.append("selected")
        }

        var actions = ["Replace", "Delete"]
        if includesThumbnailActions,
           store.photos.indices.contains(index) {
            actions.append(
                contentsOf: accessibilityActionPresentation.availableActions(
                    for: store.photos[index].id,
                    in: store
                ).map(\.accessibilityLabel)
            )
        }

        return "\(truths.joined(separator: ", ")). Actions: "
            + "\(actions.joined(separator: ", "))."
    }

    private var isAddEnabled: Bool {
        PhotoReviewCapacityPolicy.isAddEnabled(photoCount: store.photos.count)
    }

    private var nativeDragInteractionsEnabled: Bool {
        PhotoReviewNativeInteractionPolicy.isEnabled(
            isCommitting: isCommitting,
            mutationControlsLocked:
                submissionPresentation.mutationControlsLocked
        )
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
                width: PhotoReviewV5VisualContract.thumbnailSize,
                height: PhotoReviewV5VisualContract.thumbnailSize
            )
            .background(SnapListColorToken.canvas.color)
            .clipShape(
                .rect(
                    cornerRadius:
                        PhotoReviewV5VisualContract.thumbnailRadius
                )
            )
            .overlay {
                RoundedRectangle(
                    cornerRadius:
                        PhotoReviewV5VisualContract.thumbnailRadius
                )
                    .stroke(
                        SnapListColorToken.textTertiary.color,
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
        .disabled(
            !isAddEnabled
                || isCommitting
                || submissionPresentation.mutationControlsLocked
        )
        .accessibilityLabel(
            PhotoReviewCapacityPolicy.addAccessibilityLabel(
                photoCount: store.photos.count
            )
        )
        .accessibilityIdentifier("photo-review.add")
        .photoReviewLayoutLandmark(.addPhoto)
        .accessibilityFocused(
            $focusedPickerOpener,
            equals: .addButton
        )
    }

    @ViewBuilder
    private var actionRow: some View {
        HStack(spacing: PhotoReviewV5VisualContract.actionRowGap) {
            if let photoID = store.actionsPhotoID {
                Button {
                    presentPicker(.replace(photoID: photoID))
                } label: {
                    Text("Replace")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                .frame(
                    maxWidth: .infinity,
                    minHeight: PhotoReviewV5VisualContract.actionRowHeight,
                    maxHeight: PhotoReviewV5VisualContract.actionRowHeight
                )
                .buttonStyle(.bordered)
                .accessibilityLabel("Replace this photo")
                .accessibilityIdentifier("photo-review.replace")
                .accessibilityFocused(
                    $focusedPickerOpener,
                    equals: .replaceButton(photoID: photoID)
                )
            }

            Button(role: .destructive, action: performDelete) {
                Text("Delete")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
                .frame(
                    maxWidth: .infinity,
                    minHeight: PhotoReviewV5VisualContract.actionRowHeight,
                    maxHeight: PhotoReviewV5VisualContract.actionRowHeight
                )
                .buttonStyle(.bordered)
                .accessibilityLabel("Delete this photo")
                .accessibilityIdentifier("photo-review.delete")
        }
    }

    // Live Photo Review v5 owns this collapsed row. Voice Note v8 owns only the
    // recorder sheet it opens, preserving the typed boundary below.
    private func voiceRow(
        _ openBoundary: @escaping (PhotoReviewBoundaryEvent) -> Void
    ) -> some View {
        Button {
            openBoundary(.openVoiceNote)
            if voiceNoteStore != nil {
                presentVoiceNotePresentation()
            }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "mic")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .frame(width: 32, height: 32)
                    .background(SnapListColorToken.quietFill.color)
                    .clipShape(.rect(cornerRadius: 9))
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 1) {
                    Text("Voice note")
                        .snapListTypography(.rowTitle)
                        .foregroundStyle(
                            SnapListColorToken.inkPrimary.color
                        )
                    Text(voiceNoteRowSubtitle)
                        .snapListTypography(.metadata)
                        .foregroundStyle(
                            SnapListColorToken.textSecondary.color
                        )
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                Image(systemName: "chevron.up")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(SnapListColorToken.textTertiary.color)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 14)
            .frame(
                maxWidth: .infinity,
                minHeight: PhotoReviewV5VisualContract.voiceRowHeight,
                maxHeight: PhotoReviewV5VisualContract.voiceRowHeight
            )
            .background(SnapListColorToken.canvas.color)
            .clipShape(
                .rect(
                    cornerRadius:
                        PhotoReviewV5VisualContract.voiceRowRadius
                )
            )
            .overlay {
                RoundedRectangle(
                    cornerRadius:
                        PhotoReviewV5VisualContract.voiceRowRadius
                )
                    .stroke(
                        SnapListColorToken.hairline.color,
                        lineWidth: 1
                    )
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(voiceNoteRowAccessibilityLabel)
        .accessibilityIdentifier("photo-review.voice")
        .accessibilityFocused($focusedVoiceNoteOpener)
    }

    private var voiceNoteRowSubtitle: String {
        guard let note = voiceNoteStore?.savedNote else {
            return VoiceNotePresentation.emptyRowHelper
        }
        return VoiceNotePresentation.elapsedText(note.duration)
    }

    private var voiceNoteRowAccessibilityLabel: String {
        guard let note = voiceNoteStore?.savedNote else {
            return "Voice note, \(VoiceNotePresentation.emptyRowHelper), collapsed"
        }
        return "Voice note, \(VoiceNotePresentation.elapsedText(note.duration)), collapsed"
    }

    private func restoreVoiceNoteOpenerFocus() {
        _ = voiceNoteStore?.consumeFocusRequest()
        focusedVoiceNoteOpener = true
    }

    private func presentVoiceNotePresentation() {
        isVoiceNotePresented = true
    }

    private func dismissVoiceNotePresentation() {
        isVoiceNotePresented = false
        restoreVoiceNoteOpenerFocus()
    }

    private func submissionFooter(
        _ openBoundary: @escaping (PhotoReviewBoundaryEvent) -> Void,
        contentWidth: CGFloat
    ) -> some View {
        VStack(spacing: 10) {
            // The icon is decoration; the sentence is the outcome. Requiring both
            // meant a state that set only `visibleMessage` rendered nothing, and
            // the seller watched a refused upload finish in silence (#803).
            if let message = submissionPresentation.visibleMessage {
                HStack(alignment: .top, spacing: 10) {
                    if let statusKind = submissionPresentation.statusKind {
                        submissionStatusIcon(statusKind)
                            .frame(width: 22, height: 22)
                    }

                    Text(message)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(SnapListColorToken.inkPrimary.color)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(width: contentWidth)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("photo-review.submission-message")
            }

            startListingControl(openBoundary)
                .frame(width: contentWidth)
                .photoReviewLayoutLandmark(.startListing)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, PhotoReviewV5VisualContract.footerVerticalPadding)
        .padding(.bottom, PhotoReviewV5VisualContract.footerVerticalPadding)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(SnapListColorToken.divider.color)
                .frame(height: 1)
        }
        .background(SnapListColorToken.canvas.color)
    }

    @ViewBuilder
    private func submissionStatusIcon(
        _ kind: PhotoReviewSubmissionPresentation.StatusKind
    ) -> some View {
        switch kind {
        case .saving:
            ProgressView()
                .controlSize(.small)
                .tint(SnapListColorToken.textTertiary.color)
                .accessibilityHidden(true)
        case .offline:
            Image(systemName: "wifi.slash")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .accessibilityHidden(true)
        case .warning:
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .accessibilityHidden(true)
        case .success:
            Image(systemName: "checkmark.circle")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .accessibilityHidden(true)
        }
    }

    @ViewBuilder
    private func startListingControl(
        _ openBoundary: @escaping (PhotoReviewBoundaryEvent) -> Void
    ) -> some View {
        let button = Button {
            openBoundary(submissionPresentation.primaryActionEvent)
        } label: {
            Text(submissionPresentation.primaryActionLabel)
                .font(.system(size: 16, weight: .bold))
                .foregroundStyle(
                    submissionPresentation.actionStyle == .filled
                        ? SnapListColorToken.canvas.color
                        : SnapListColorToken.inkPrimary.color
                )
                .frame(
                    maxWidth: .infinity,
                    minHeight:
                        PhotoReviewV5VisualContract.primaryActionHeight,
                    maxHeight:
                        PhotoReviewV5VisualContract.primaryActionHeight
                )
                .contentShape(.rect)
        }
        .disabled(
            !PhotoReviewStartListingPolicy.isEnabled(
                photoCount: store.photos.count,
                isPickerActive: store.activePickerRequest != nil
            )
                || (isCommitting && !allowsPrimaryActionDuringCommit)
        )
        .accessibilityIdentifier("photo-review.start-listing")
        .accessibilityFocused($focusedStartListing)

        if submissionPresentation.actionStyle == .filled {
            button.buttonStyle(PhotoReviewStartListingButtonStyle())
        } else {
            button.buttonStyle(PhotoReviewSecondaryActionButtonStyle())
        }
    }

    private var allowsPrimaryActionDuringCommit: Bool {
        switch submissionPresentation.primaryActionEvent {
        case .cancelSubmission, .completeSavedSubmission:
            true
        case .openVoiceNote, .startListing, .createAccount,
             .retryReceiptMismatch, .retryAmbiguousSubmission,
             .reviewSubmission, .reviewConflictedSubmission:
            false
        }
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
        if let commitReorder,
           let destinationIndex = store.destinationIndex(
               for: photoID,
               action: action
           ) {
            Task {
                guard let result = await commitReorder(
                    photoID,
                    destinationIndex
                ) else {
                    return
                }
                hardwareFocusedThumbnailID = result.photoID
                focusedThumbnailID = result.photoID
                UIAccessibility.post(
                    notification: .announcement,
                    argument: result.announcement
                )
            }
            return
        }
        guard let result = accessibilityActionPresentation.perform(
            action,
            photoID: photoID,
            store: store
        ) else {
            return
        }

        hardwareFocusedThumbnailID = result.photoID
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

    private func handleThumbnailKeyPress(
        _ press: KeyPress,
        photoID: StagedCapturePhoto.ID
    ) -> KeyPress.Result {
        guard press.modifiers == .control else {
            return .ignored
        }

        let action: PhotoReviewReorderAction
        switch press.key {
        case .leftArrow:
            action = .moveEarlier
        case .rightArrow:
            action = .moveLater
        default:
            return .ignored
        }

        guard accessibilityActionPresentation.availableActions(
            for: photoID,
            in: store
        ).contains(action) else {
            return .ignored
        }

        performAccessibilityAction(action, photoID: photoID)
        return .handled
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
