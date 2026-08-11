import Foundation
import Observation

enum ItemRunSubmissionPresentationEvent: Equatable, Sendable {
    case itemSaved(eventID: UUID, handoff: AcceptedItemRunHandoff)
    case submissionRejected(
        eventID: UUID,
        retention: ItemRunSubmissionRetention
    )
    case destinationHandoff(
        eventID: UUID,
        handoff: ItemRunSubmissionDestinationDecision.Handoff
    )
}

enum ItemRunSubmissionDestinationDecision: Equatable, Sendable {
    enum PhotoReview: Equatable, Sendable {
        case sub01Cancelled
        case sub02
        case sub03
        case sub04
        case sub06
        case sub07
    }

    enum Handoff: Equatable, Sendable {
        case pay01
        case pay08
        case accountClaim12aThrough12c
    }

    case photoReview(PhotoReview)
    case handoff(Handoff)

    init(retention: ItemRunSubmissionRetention) {
        switch retention {
        case .cancelled:
            self = .photoReview(.sub01Cancelled)
        case .offline:
            self = .photoReview(.sub02)
        case .ambiguous:
            self = .photoReview(.sub03)
        case .conflict:
            self = .photoReview(.sub04)
        case .creditDenied(reason: "snaplist-pro-required"):
            self = .handoff(.pay01)
        case .creditDenied:
            // Only the canonical first-paid-run denial proves this seller owes
            // the Pro gate. Expired, ambiguous, exhausted, or untyped server
            // truth must not become an offer to buy again.
            self = .photoReview(.sub06)
        case .rateLimited(reason: _):
            self = .photoReview(.sub06)
        case .rejected:
            self = .photoReview(.sub07)
        case .authenticationRequired:
            self = .handoff(.accountClaim12aThrough12c)
        case .receiptMismatch:
            self = .handoff(.pay08)
        case .intakeUnavailable:
            self = .photoReview(.sub07)
        case .attemptNotPersisted:
            self = .photoReview(.sub06)
        case .submissionUnavailable:
            self = .photoReview(.sub06)
        }
    }
}

enum PhotoReviewSubmissionRejectionFamily: Equatable {
    case cancelled
    case offline
    case ambiguity
    case conflict
    case tryAgain
    case review

    init?(retention: ItemRunSubmissionRetention) {
        switch ItemRunSubmissionDestinationDecision(retention: retention) {
        case .photoReview(.sub01Cancelled):
            self = .cancelled
        case .photoReview(.sub02):
            self = .offline
        case .photoReview(.sub03):
            self = .ambiguity
        case .photoReview(.sub04):
            self = .conflict
        case .photoReview(.sub06):
            self = .tryAgain
        case .photoReview(.sub07):
            self = .review
        case .handoff(_):
            return nil
        }
    }

    var primaryActionLabel: String {
        switch self {
        case .offline, .ambiguity, .tryAgain:
            "Try again"
        case .cancelled, .conflict:
            "Start listing"
        case .review:
            "Review"
        }
    }

    var message: String {
        switch self {
        case .cancelled:
            "Not sent yet. Your item is saved on this phone."
        case .offline:
            "You're offline. Your item is saved on this phone."
        case .ambiguity:
            "We couldn't confirm this went through. Your item is still saved on this phone."
        case .conflict:
            "Something changed since your last try. Review your item, then start again."
        case .tryAgain:
            "This didn't go through. Your item is still saved on this phone."
        case .review:
            "This item can't be sent as it is."
        }
    }

    var accessibilityAnnouncement: String {
        switch self {
        case .conflict:
            "Something changed since your last try."
        case .cancelled, .offline, .ambiguity, .tryAgain, .review:
            message
        }
    }

    var statusKind: PhotoReviewSubmissionPresentation.StatusKind {
        switch self {
        case .offline:
            .offline
        case .cancelled, .ambiguity, .conflict, .tryAgain, .review:
            .warning
        }
    }

    var actionStyle: PhotoReviewSubmissionPresentation.ActionStyle {
        switch self {
        case .cancelled, .conflict:
            .filled
        case .offline, .ambiguity, .tryAgain, .review:
            .outlined
        }
    }

    func primaryActionEvent(eventID: UUID) -> PhotoReviewBoundaryEvent {
        switch self {
        case .cancelled:
            // The same durable attempt remains stored after local cancellation,
            // so a fresh Start listing transaction safely reloads its exact key.
            .startListing
        case .offline, .ambiguity:
            .retryAmbiguousSubmission(eventID: eventID)
        case .conflict:
            .reviewConflictedSubmission(eventID: eventID)
        case .tryAgain:
            .startListing
        case .review:
            .reviewSubmission(eventID: eventID)
        }
    }
}

/// One presentation event owns one acknowledgment. The lock lets cancellation close
/// the gate without scheduling work back onto the main actor, while the host keeps the
/// public acknowledgment itself synchronous.
private final class ItemRunSubmissionPresentationAcknowledgmentGate:
    @unchecked Sendable {
    private enum State {
        case pending
        case waiting(CheckedContinuation<Bool, Never>)
        case resolved(Bool)
    }

    let eventID: UUID

    private let lock = NSLock()
    private var state: State = .pending

    init(eventID: UUID) {
        self.eventID = eventID
    }

    func wait() async -> Bool {
        await withTaskCancellationHandler {
            if Task.isCancelled {
                resolve(false)
            }
            return await withCheckedContinuation { continuation in
                lock.lock()
                switch state {
                case .pending:
                    state = .waiting(continuation)
                    lock.unlock()
                case .resolved(let acknowledged):
                    lock.unlock()
                    continuation.resume(returning: acknowledged)
                case .waiting:
                    lock.unlock()
                    continuation.resume(returning: false)
                }
            }
        } onCancel: {
            self.resolve(false)
        }
    }

    func acknowledge(eventID: UUID) {
        guard eventID == self.eventID else {
            return
        }
        resolve(true)
    }

    func cancel() {
        resolve(false)
    }

    private func resolve(_ acknowledged: Bool) {
        let continuation: CheckedContinuation<Bool, Never>?
        lock.lock()
        switch state {
        case .pending:
            state = .resolved(acknowledged)
            continuation = nil
        case .waiting(let waiting):
            state = .resolved(acknowledged)
            continuation = waiting
        case .resolved:
            continuation = nil
        }
        lock.unlock()
        continuation?.resume(returning: acknowledged)
    }
}

/// What the live Photo Review Start listing boundary resolves to. It holds the last
/// canonical run for #375 to consume and the last typed recovery, and it makes no
/// claim about analysis, pricing, review, or delivery.
@MainActor
@Observable
final class ItemRunSubmissionHost {
    private(set) var isSubmitting = false
    private(set) var acceptedRun: AcceptedItemRun?
    /// Whether the accepted run also took the seller's photos with it. False means the
    /// intake changed while the request was open and those photos are still theirs.
    private(set) var clearedIntake = false
    private(set) var retention: ItemRunSubmissionRetention?
    private(set) var pendingPresentationEvent: ItemRunSubmissionPresentationEvent?

    private let coordinator: ItemRunSubmissionCoordinator?
    private let funnelAnalytics: any FunnelAnalyticsEventSinking
    private var presentationAcknowledgmentGate:
        ItemRunSubmissionPresentationAcknowledgmentGate?
    private var pendingAmbiguousRetry:
        ItemRunSubmissionCoordinator.AmbiguousRetry?
    private var admittedAmbiguousRetry:
        ItemRunSubmissionCoordinator.AmbiguousRetry?
    private var activePrincipalGeneration: UUID?
    private var activePrincipalContext: ItemRunSubmissionPrincipalContext?
    private(set) var trophyWallPrincipalScopeProof:
        ItemRunSubmissionPrincipalScopeProof? = nil
    private var activeSubmissionID: UUID?
    private var cancellationRequestedSubmissionID: UUID?
    private var preparationTask:
        Task<ItemRunSubmissionCoordinator.Preparation, Never>?
    /// Fixture launches render approved states with no server behind them, so Start
    /// listing is inert by design there rather than unavailable.
    private let isInert: Bool
#if DEBUG
    private let acknowledgmentNotificationGate:
        ItemRunSubmissionAcknowledgmentNotificationGate?
#endif

    init(
        coordinator: ItemRunSubmissionCoordinator?,
        isInert: Bool = false,
        funnelAnalytics: any FunnelAnalyticsEventSinking = NoOpFunnelAnalyticsEventSink()
    ) {
        self.coordinator = coordinator
        self.isInert = isInert
        self.funnelAnalytics = funnelAnalytics
#if DEBUG
        acknowledgmentNotificationGate = nil
#endif
    }

#if DEBUG
    init(
        coordinator: ItemRunSubmissionCoordinator,
        acknowledgmentNotification:
            SubmissionAcknowledgmentNotificationName
    ) {
        self.coordinator = coordinator
        isInert = false
        funnelAnalytics = NoOpFunnelAnalyticsEventSink()
        acknowledgmentNotificationGate =
            ItemRunSubmissionAcknowledgmentNotificationGate(
                notificationName: acknowledgmentNotification
            )
    }
#endif

    /// #545 calls this from the committed NativeIntake snapshot event block. A new
    /// activation ID is a principal transition even when the seller later returns to
    /// the same opaque filesystem scope.
    func synchronizePrincipal(
        snapshot: NativeIntake.Snapshot,
        intake: NativeIntake
    ) {
        let nextGeneration = snapshot.version.activationID
        if activePrincipalGeneration != nextGeneration {
            cancelAndResetDepartingSubmission()
            activePrincipalGeneration = nextGeneration
        }
        activePrincipalContext = ItemRunSubmissionPrincipalContext(
            snapshot: snapshot,
            intake: intake
        )
        trophyWallPrincipalScopeProof = activePrincipalContext?.scopeProof
    }

    func recoverableTrophyWallPendingCard(
        principalScope: TrophyWallPrincipalScope
    ) async -> TrophyWallCard? {
        guard let context = activePrincipalContext,
              !context.photos.isEmpty,
              let coordinator,
              let attempt = await coordinator.recoverableAttempt(
                  for: context
              ),
              activePrincipalContext?.generation == context.generation else {
            return nil
        }
        return TrophyWallCard.pending(
            principalScope: principalScope,
            logicalIdentity: TrophyWallLogicalIdentity(
                idempotencyKey: attempt.idempotencyKey
            ),
            itemName: "Local item",
            lastMeaningfulUpdateAt: context.photos.map(\.createdAt).max() ?? Date()
        )
    }

    private func cancelAndResetDepartingSubmission() {
        preparationTask?.cancel()
        preparationTask = nil
        activeSubmissionID = nil
        cancellationRequestedSubmissionID = nil
        presentationAcknowledgmentGate?.cancel()
        presentationAcknowledgmentGate = nil
        pendingAmbiguousRetry = nil
        admittedAmbiguousRetry = nil
        isSubmitting = false
        acceptedRun = nil
        clearedIntake = false
        retention = nil
        pendingPresentationEvent = nil
    }

    /// One tap, one submission. A second tap while a request is open would build a
    /// second attempt from the same photos and could buy the seller a second run.
    func startListing(photos: [StagedCapturePhoto]) async {
        guard !isSubmitting, !isInert else {
            return
        }
        // A destination handoff owns this exact attempt until AppShell consumes it.
        // Photo Review remains visible while Pro eligibility loads, so another tap
        // must not replace the handoff with a new event identity mid-presentation.
        if case .destinationHandoff? = pendingPresentationEvent {
            return
        }
        guard let coordinator else {
            // A build with no API origin has nowhere to submit. Saying so beats a
            // button that silently does nothing.
            acceptedRun = nil
            clearedIntake = false
            retention = .submissionUnavailable
            return
        }
        if case .submissionRejected(_, _)? = pendingPresentationEvent {
            pendingPresentationEvent = nil
        }
        let capturedPrincipalContext =
            activePrincipalContext?.photos == photos
                ? activePrincipalContext
                : nil
        // Once live NativeIntake composition has supplied a principal generation,
        // falling back to the old global attempt/draft path would cross scopes.
        guard activePrincipalGeneration == nil
                || capturedPrincipalContext != nil else {
            publish(retention: .intakeUnavailable)
            return
        }
        let expectedPrincipalGeneration =
            capturedPrincipalContext?.generation
        let submissionID = UUID()
        activeSubmissionID = submissionID
        isSubmitting = true
        defer {
            if activeSubmissionID == submissionID {
                preparationTask = nil
                activeSubmissionID = nil
                isSubmitting = false
            }
        }

        let isCurrent: @MainActor () -> Bool = { [weak self] in
            guard let self else {
                return false
            }
            if let expectedPrincipalGeneration {
                return self.activePrincipalGeneration
                    == expectedPrincipalGeneration
            }
            return self.activePrincipalGeneration == nil
        }

        let task: Task<ItemRunSubmissionCoordinator.Preparation, Never>
        if let retry = admittedAmbiguousRetry {
            admittedAmbiguousRetry = nil
            task = Task {
                await coordinator.retryAmbiguousSubmission(
                    retry,
                    currentPhotos: photos,
                    isCurrent: isCurrent
                )
            }
        } else if let capturedPrincipalContext {
            task = Task {
                await coordinator.prepareSubmission(
                    principalContext: capturedPrincipalContext,
                    isCurrent: isCurrent
                )
            }
        } else {
            task = Task {
                await coordinator.prepareSubmission(photos: photos)
            }
        }
        preparationTask = task
        let preparation = await withTaskCancellationHandler {
            await task.value
        } onCancel: {
            task.cancel()
        }
        if cancellationRequestedSubmissionID == submissionID {
            cancellationRequestedSubmissionID = nil
            preparationTask = nil
            if case .ambiguous(let retry) = preparation {
                pendingAmbiguousRetry = retry
            } else {
                pendingAmbiguousRetry = nil
            }
            publish(retention: .cancelled)
            return
        }
        guard activeSubmissionID == submissionID,
              isCurrent(),
              !Task.isCancelled else {
            return
        }
        preparationTask = nil

        switch preparation {
        case .accepted(let submission):
            pendingAmbiguousRetry = nil
            retention = nil
            acceptedRun = submission.acceptedRun
            funnelAnalytics.record(
                .intakeSubmitted,
                eventID: submission.acceptedRun.runID
            )
            clearedIntake = false

            let eventID = UUID()
            let handoff = AcceptedItemRunHandoff(
                idempotencyKey: submission.attempt.idempotencyKey,
                acceptedRun: submission.acceptedRun
            )
            let gate = ItemRunSubmissionPresentationAcknowledgmentGate(
                eventID: eventID
            )
            presentationAcknowledgmentGate = gate
            pendingPresentationEvent = .itemSaved(
                eventID: eventID,
                handoff: handoff
            )

            let acknowledged = await gate.wait()
            if presentationAcknowledgmentGate === gate {
                presentationAcknowledgmentGate = nil
            }
            guard acknowledged,
                  activeSubmissionID == submissionID,
                  isCurrent(),
                  !Task.isCancelled else {
                if pendingPresentationEvent == .itemSaved(
                    eventID: eventID,
                    handoff: handoff
                ) {
                    pendingPresentationEvent = nil
                }
                return
            }

            let acceptance = await coordinator.finalize(submission)
            guard activeSubmissionID == submissionID,
                  isCurrent(),
                  !Task.isCancelled else {
                return
            }
            clearedIntake = acceptance.clearedIntake
            if !acceptance.clearedIntake,
               pendingPresentationEvent == .itemSaved(
                   eventID: eventID,
                   handoff: handoff
               ) {
                pendingPresentationEvent = nil
            }
        case .ambiguous(let retry):
            pendingAmbiguousRetry = retry
            switch retry.reason {
            case .cancelled:
                publish(retention: .cancelled)
            case .offline:
                publish(retention: .offline)
            case .unknown:
                publish(retention: .ambiguous)
            }
        case .retained(let retention):
            pendingAmbiguousRetry = nil
            publish(retention: retention)
        }
    }

    private func publish(retention: ItemRunSubmissionRetention) {
        acceptedRun = nil
        clearedIntake = false
        self.retention = retention
        switch ItemRunSubmissionDestinationDecision(
            retention: retention
        ) {
        case .photoReview:
            if PhotoReviewSubmissionRejectionFamily(
                retention: retention
            ) != nil {
                pendingPresentationEvent = .submissionRejected(
                    eventID: UUID(),
                    retention: retention
                )
            }
        case .handoff(let handoff):
            pendingPresentationEvent = .destinationHandoff(
                eventID: UUID(),
                handoff: handoff
            )
        }
    }

    func acknowledgePresentation(eventID: UUID) {
#if DEBUG
        if presentationAcknowledgmentGate?.eventID == eventID,
           let acknowledgmentNotificationGate {
            acknowledgmentNotificationGate.withhold(
                eventID: eventID
            ) { [weak self] acknowledgedEventID in
                self?.presentationAcknowledgmentGate?.acknowledge(
                    eventID: acknowledgedEventID
                )
            }
            return
        }
#endif
        presentationAcknowledgmentGate?.acknowledge(eventID: eventID)
    }

    func canRetryAmbiguousSubmission(eventID: UUID) -> Bool {
        guard !isSubmitting,
              case .submissionRejected(
                  eventID: let pendingEventID,
                  retention: let retention
              )? = pendingPresentationEvent,
              pendingEventID == eventID else {
            return false
        }
        switch retention {
        case .ambiguous, .offline, .cancelled:
            return true
        case .conflict, .creditDenied, .rateLimited, .rejected,
             .authenticationRequired, .receiptMismatch, .intakeUnavailable,
             .attemptNotPersisted, .submissionUnavailable:
            return false
        }
    }

    @discardableResult
    func cancelSubmission() -> Bool {
        guard isSubmitting,
              let activeSubmissionID,
              let preparationTask else {
            return false
        }
        // Cancelling stops the local wait only. The transport resolves this as an
        // uncertain outcome, preserving the exact durable bytes and idempotency key
        // for the next Start listing tap.
        cancellationRequestedSubmissionID = activeSubmissionID
        preparationTask.cancel()
        return true
    }

    @discardableResult
    func retryAmbiguousSubmission(eventID: UUID) -> Bool {
        guard canRetryAmbiguousSubmission(eventID: eventID),
              let pendingAmbiguousRetry else {
            return false
        }
        admittedAmbiguousRetry = pendingAmbiguousRetry
        self.pendingAmbiguousRetry = nil
        pendingPresentationEvent = nil
        return true
    }

    @discardableResult
    func reviewRejectedSubmission(eventID: UUID) -> Bool {
        guard case .submissionRejected(
            eventID: let pendingEventID,
            retention: let retention
        )? = pendingPresentationEvent,
              PhotoReviewSubmissionRejectionFamily(
                  retention: retention
              ) == .review,
              pendingEventID == eventID else {
            return false
        }
        pendingPresentationEvent = nil
        return true
    }

    @discardableResult
    func reviewConflictedSubmission(eventID: UUID) -> Bool {
        guard case .submissionRejected(
            eventID: let pendingEventID,
            retention: .conflict
        )? = pendingPresentationEvent,
              pendingEventID == eventID else {
            return false
        }
        pendingPresentationEvent = nil
        return true
    }

    func consumeDestinationHandoff(
        eventID: UUID
    ) -> ItemRunSubmissionDestinationDecision.Handoff? {
        guard case .destinationHandoff(
            eventID: let pendingEventID,
            handoff: let handoff
        )? = pendingPresentationEvent,
              pendingEventID == eventID else {
            return nil
        }
        pendingPresentationEvent = nil
        return handoff
    }

    @discardableResult
    func replaceProGateHandoffWithPhotoReviewFallback(
        eventID: UUID
    ) -> Bool {
        guard case .destinationHandoff(
            eventID: let pendingEventID,
            handoff: .pay01
        )? = pendingPresentationEvent,
              pendingEventID == eventID else {
            return false
        }
        publish(retention: .submissionUnavailable)
        return true
    }

    func publishProGatePhotoReviewFallback() {
        publish(retention: .submissionUnavailable)
    }

    func completeClearedIntakePresentation() {
        guard clearedIntake,
              case .itemSaved(_, _)? = pendingPresentationEvent else {
            return
        }
        pendingPresentationEvent = nil
    }
}

/// Seller-facing Photo Review state derived from the live submission boundary.
///
/// Keep this value type-driven: transport reason strings are server diagnostics,
/// never presentation authority.
struct PhotoReviewSubmissionPresentation: Equatable {
    enum StatusKind: Equatable {
        case saving
        case offline
        case warning
        case success
    }

    enum ActionStyle: Equatable {
        case filled
        case outlined
    }

    enum AnnouncementEvent: Equatable {
        case saving
        case itemSaved(eventID: UUID)
        case submissionRejected(eventID: UUID)
    }

    let primaryActionLabel: String
    let primaryActionEvent: PhotoReviewBoundaryEvent
    let mutationControlsLocked: Bool
    let announcementEvent: AnnouncementEvent?
    let accessibilityAnnouncement: String?
    let visibleMessage: String?
    let rendersSubmittedMedia: Bool
    let statusKind: StatusKind?
    let actionStyle: ActionStyle

    static let idle = PhotoReviewSubmissionPresentation(
        primaryActionLabel: "Start listing",
        primaryActionEvent: .startListing,
        mutationControlsLocked: false,
        announcementEvent: nil,
        accessibilityAnnouncement: nil,
        visibleMessage: nil,
        rendersSubmittedMedia: true,
        statusKind: nil,
        actionStyle: .filled
    )

#if DEBUG
    static func visualState(
        _ state: PhotoReviewSubmissionVisualStateID
    ) -> PhotoReviewSubmissionPresentation {
        let eventID = UUID(
            uuidString: "75500000-0000-4000-8000-000000000001"
        )!
        switch state {
        case .saving:
            return PhotoReviewSubmissionPresentation(
                primaryActionLabel: "Cancel",
                primaryActionEvent: .cancelSubmission,
                mutationControlsLocked: true,
                announcementEvent: .saving,
                accessibilityAnnouncement: "Saving your item.",
                visibleMessage: "Saving your item",
                rendersSubmittedMedia: true,
                statusKind: .saving,
                actionStyle: .outlined
            )
        case .cancelled:
            return rejectionFixture(
                .cancelled,
                eventID: eventID
            )
        case .offline:
            return rejectionFixture(.offline, eventID: eventID)
        case .unknown:
            return rejectionFixture(.ambiguity, eventID: eventID)
        case .conflict:
            return rejectionFixture(.conflict, eventID: eventID)
        case .accepted:
            return PhotoReviewSubmissionPresentation(
                primaryActionLabel: "Done",
                primaryActionEvent: .completeSavedSubmission(eventID: eventID),
                mutationControlsLocked: true,
                announcementEvent: .itemSaved(eventID: eventID),
                accessibilityAnnouncement: "Item saved.",
                visibleMessage: "Item saved",
                rendersSubmittedMedia: true,
                statusKind: .success,
                actionStyle: .outlined
            )
        }
    }

    private static func rejectionFixture(
        _ family: PhotoReviewSubmissionRejectionFamily,
        eventID: UUID
    ) -> PhotoReviewSubmissionPresentation {
        PhotoReviewSubmissionPresentation(
            primaryActionLabel: family.primaryActionLabel,
            primaryActionEvent: family.primaryActionEvent(eventID: eventID),
            mutationControlsLocked: false,
            announcementEvent: .submissionRejected(eventID: eventID),
            accessibilityAnnouncement: family.accessibilityAnnouncement,
            visibleMessage: family.message,
            rendersSubmittedMedia: true,
            statusKind: family.statusKind,
            actionStyle: family.actionStyle
        )
    }
#endif

    private init(
        primaryActionLabel: String,
        primaryActionEvent: PhotoReviewBoundaryEvent,
        mutationControlsLocked: Bool,
        announcementEvent: AnnouncementEvent?,
        accessibilityAnnouncement: String?,
        visibleMessage: String?,
        rendersSubmittedMedia: Bool,
        statusKind: StatusKind? = nil,
        actionStyle: ActionStyle = .filled
    ) {
        self.primaryActionLabel = primaryActionLabel
        self.primaryActionEvent = primaryActionEvent
        self.mutationControlsLocked = mutationControlsLocked
        self.announcementEvent = announcementEvent
        self.accessibilityAnnouncement = accessibilityAnnouncement
        self.visibleMessage = visibleMessage
        self.rendersSubmittedMedia = rendersSubmittedMedia
        self.statusKind = statusKind
        self.actionStyle = actionStyle
    }

    @MainActor
    init(
        host: ItemRunSubmissionHost,
        proGateIntakeAdvisory: ProGateStore.IntakeAdvisory? = nil
    ) {
        if case .itemSaved(let eventID, _)? = host.pendingPresentationEvent {
            self = PhotoReviewSubmissionPresentation(
                primaryActionLabel: "Done",
                primaryActionEvent: .completeSavedSubmission(eventID: eventID),
                mutationControlsLocked: true,
                announcementEvent: .itemSaved(eventID: eventID),
                accessibilityAnnouncement: "Item saved.",
                visibleMessage: "Item saved",
                rendersSubmittedMedia: true,
                statusKind: .success,
                actionStyle: .outlined
            )
        } else if host.isSubmitting {
            self = PhotoReviewSubmissionPresentation(
                primaryActionLabel: "Cancel",
                primaryActionEvent: .cancelSubmission,
                mutationControlsLocked: true,
                announcementEvent: .saving,
                accessibilityAnnouncement: "Saving your item.",
                visibleMessage: "Saving your item",
                rendersSubmittedMedia: true,
                statusKind: .saving,
                actionStyle: .outlined
            )
        } else if case .destinationHandoff(
            eventID: let eventID,
            handoff: let handoff
        )? = host.pendingPresentationEvent {
            self = PhotoReviewSubmissionPresentation(
                handoff: handoff,
                eventID: eventID
            )
        } else if case .submissionRejected(
            eventID: let eventID,
            retention: let retention
        )? = host.pendingPresentationEvent,
                  let family = PhotoReviewSubmissionRejectionFamily(
                      retention: retention
                  ) {
            self = PhotoReviewSubmissionPresentation(
                primaryActionLabel: family.primaryActionLabel,
                primaryActionEvent: family.primaryActionEvent(eventID: eventID),
                mutationControlsLocked: false,
                announcementEvent: .submissionRejected(eventID: eventID),
                accessibilityAnnouncement: family.accessibilityAnnouncement,
                visibleMessage: family.message,
                rendersSubmittedMedia: true,
                statusKind: family.statusKind,
                actionStyle: family.actionStyle
            )
        } else if let proGateIntakeAdvisory {
            self = PhotoReviewSubmissionPresentation(
                proGateIntakeAdvisory: proGateIntakeAdvisory
            )
        } else {
            self = .idle
        }
    }

    /// Every handoff the coordinator can decide gets a visible outcome here. The
    /// switch is exhaustive with no `default` on purpose: a fourth `Handoff` case has
    /// to break the build rather than fall through to `.idle`, which is how the
    /// account and receipt handoffs became dead ends behind a `.pay01` pattern filter.
    init(
        handoff: ItemRunSubmissionDestinationDecision.Handoff,
        eventID: UUID
    ) {
        switch handoff {
        case .pay01:
            // The Pro sheet is the visible outcome and the shell owns presenting it,
            // so Photo Review only holds its controls while it comes up.
            self = PhotoReviewSubmissionPresentation(
                primaryActionLabel: "Start listing",
                primaryActionEvent: .startListing,
                mutationControlsLocked: true,
                announcementEvent: nil,
                accessibilityAnnouncement: nil,
                visibleMessage: nil,
                rendersSubmittedMedia: true
            )
        case .pay08:
            // A receipt that doesn't describe what was sent cannot confirm whether
            // this attempt landed. Reuse the established ambiguity wording while
            // keeping the receipt-specific retry route typed to this handoff.
            let family = PhotoReviewSubmissionRejectionFamily.ambiguity
            self = PhotoReviewSubmissionPresentation(
                primaryActionLabel: family.primaryActionLabel,
                primaryActionEvent: .retryReceiptMismatch(eventID: eventID),
                mutationControlsLocked: false,
                announcementEvent: .submissionRejected(eventID: eventID),
                accessibilityAnnouncement: family.accessibilityAnnouncement,
                visibleMessage: family.message,
                rendersSubmittedMedia: true
            )
        case .accountClaim12aThrough12c:
            // The seller keeps their photos either way, so say that before asking for
            // the account. The label is the route: the shell opens Settings, where
            // account creation lives.
            let message = """
                You need a SnapList account to send this item. Your item is still \
                saved on this phone.
                """
            self = PhotoReviewSubmissionPresentation(
                primaryActionLabel: "Create an account",
                primaryActionEvent: .createAccount(eventID: eventID),
                mutationControlsLocked: false,
                announcementEvent: .submissionRejected(eventID: eventID),
                accessibilityAnnouncement: message,
                visibleMessage: message,
                rendersSubmittedMedia: true
            )
        }
    }

    init(proGateIntakeAdvisory: ProGateStore.IntakeAdvisory) {
        switch proGateIntakeAdvisory {
        case .needsPro(let eventID):
            self = PhotoReviewSubmissionPresentation(
                primaryActionLabel: "Start listing",
                primaryActionEvent: .startListing,
                mutationControlsLocked: false,
                announcementEvent: .submissionRejected(eventID: eventID),
                accessibilityAnnouncement: ProGateCopy.intakeNeedsPro,
                visibleMessage: ProGateCopy.intakeNeedsPro,
                rendersSubmittedMedia: true
            )
        }
    }
}

/// Consumes one announcement when Photo Review enters a new visible submission state.
/// Re-reading the same still-visible presentation is a render, not a new event.
struct PhotoReviewSubmissionAnnouncementTracker {
    private var lastEvent: PhotoReviewSubmissionPresentation.AnnouncementEvent?

    mutating func consume(
        _ presentation: PhotoReviewSubmissionPresentation
    ) -> String? {
        guard let event = presentation.announcementEvent else {
            lastEvent = nil
            return nil
        }
        guard event != lastEvent else {
            return nil
        }
        lastEvent = event
        return presentation.accessibilityAnnouncement
    }
}

/// Delivers the side effects for a newly visible submission state in presentation
/// order. The announcement tracker owns once-only identity, and saved presentation
/// acknowledgment follows its announcement rather than creating a second event path.
struct PhotoReviewSubmissionEffectConsumer {
    private var announcementTracker = PhotoReviewSubmissionAnnouncementTracker()

    mutating func consume(
        _ presentation: PhotoReviewSubmissionPresentation,
        postAnnouncement: (String) -> Void,
        acknowledgePresentation: (UUID) -> Void
    ) {
        guard let announcement = announcementTracker.consume(presentation) else {
            return
        }

        postAnnouncement(announcement)
        // Acceptance stays visible until the seller taps Done. Announcing the state
        // is not consent to leave Photo Review or clear its matched local intake.
        _ = acknowledgePresentation
    }
}

@MainActor
enum PhotoReviewSubmissionPrimaryActionConsumer {
    @discardableResult
    static func consume(
        _ event: PhotoReviewBoundaryEvent,
        submissionHost: ItemRunSubmissionHost
    ) -> Bool {
        switch event {
        case .cancelSubmission:
            return submissionHost.cancelSubmission()
        case .completeSavedSubmission(let eventID):
            submissionHost.acknowledgePresentation(eventID: eventID)
            return true
        case .reviewSubmission(let eventID):
            return submissionHost.reviewRejectedSubmission(eventID: eventID)
        case .reviewConflictedSubmission(let eventID):
            return submissionHost.reviewConflictedSubmission(eventID: eventID)
        case .openVoiceNote,
             .startListing,
             .createAccount,
             .retryReceiptMismatch,
             .retryAmbiguousSubmission:
            return false
        }
    }
}

@MainActor
enum ItemRunSubmissionHostFactory {
    static func make(
        configuration: LaunchConfiguration,
        apiOrigin: URL?,
        tokenProvider: any BearerTokenProviding,
        session: URLSession,
        draftStore: any CaptureDraftStoring,
        funnelAnalytics: any FunnelAnalyticsEventSinking = NoOpFunnelAnalyticsEventSink()
    ) -> ItemRunSubmissionHost {
#if DEBUG
        if let fixtureHost = ItemRunSubmissionDebugFixtureFactory.make(
            configuration: configuration,
            draftStore: draftStore
        ) {
            return fixtureHost
        }
#endif
        guard !configuration.usesZeroNetworkFixtures else {
            return ItemRunSubmissionHost(
                coordinator: nil,
                isInert: true,
                funnelAnalytics: funnelAnalytics
            )
        }
        let submitter: (any ItemRunSubmitting)? = apiOrigin.map {
            ItemRunSubmissionClient(baseURL: $0, session: session)
        }
        return ItemRunSubmissionHost(
            coordinator: ItemRunSubmissionCoordinator(
                submitter: submitter,
                attemptStore: LocalItemRunSubmissionAttemptStore(),
                draftStore: draftStore,
                tokenProvider: tokenProvider
            ),
            funnelAnalytics: funnelAnalytics
        )
    }
}

/// Turns the seller's ordered Photo Review intake into one canonical durable run.
@MainActor
final class ItemRunSubmissionCoordinator {
    fileprivate struct CapturedContext {
        let photos: [StagedCapturePhoto]
        let voice: NativeIntake.Voice?
        let scopeProof: ItemRunSubmissionPrincipalScopeProof?
        let attemptStore: any ItemRunSubmissionAttemptStoring
        let validateFilesystemContext:
            @MainActor () async -> Bool
        let prepareDurableIntake:
            @MainActor ([StagedCapturePhoto]) async -> Bool
        let discardExactly:
            @MainActor ([StagedCapturePhoto]) async -> Bool
        let retireAcceptedPhotosPreservingUnmatchedVoice:
            @MainActor ([StagedCapturePhoto]) async -> Bool
    }

    private struct CapturedBearer {
        let token: String

        var isGuest: Bool { token.hasPrefix("guestcap_") }
    }

    private enum BearerAcquisition {
        case captured(CapturedBearer)
        case principalMismatch
        /// There is no usable credential: no session, or a session that cannot be
        /// bound to a principal. Only this says anything about the seller's account.
        case credentialAbsent
        /// The credential could not be reached this time — no network, a timeout, a
        /// keychain that would not open. A phone with no signal has told us nothing
        /// about whether the seller has an account, so this must stay retryable.
        case temporarilyUnavailable
    }

    fileprivate struct AmbiguousRetry {
        fileprivate let context: CapturedContext
        fileprivate let submittedPhotos: [StagedCapturePhoto]
        fileprivate let payload: ItemRunSubmissionPayload
        fileprivate let reason: ItemRunSubmissionAmbiguityReason
    }

    fileprivate struct Submission {
        fileprivate enum IntakeCleanup {
            case none
            case wholeBundle
            case photosPreservingUnmatchedVoice
        }

        fileprivate let context: CapturedContext
        fileprivate let acceptedRun: AcceptedItemRun
        fileprivate let submittedPhotos: [StagedCapturePhoto]
        fileprivate let attempt: ItemRunSubmissionAttempt
        fileprivate let intakeCleanup: IntakeCleanup
    }

    fileprivate enum Preparation {
        case accepted(Submission)
        case ambiguous(AmbiguousRetry)
        case retained(ItemRunSubmissionRetention)
    }

    private let submitter: (any ItemRunSubmitting)?
    private let attemptStore: any ItemRunSubmissionAttemptStoring
    private let draftStore: any CaptureDraftStoring
    private let tokenProvider: any BearerTokenProviding
    private let guestRecoveryCredentials:
        any GuestRecoveryCredentialStoring
    private let readData: @Sendable (URL) throws -> Data
    private let voiceLocaleHint: @Sendable () -> String?
    private let newIdempotencyKey: @Sendable () -> UUID

    init(
        submitter: (any ItemRunSubmitting)?,
        attemptStore: any ItemRunSubmissionAttemptStoring,
        draftStore: any CaptureDraftStoring,
        tokenProvider: any BearerTokenProviding,
        guestRecoveryCredentials:
            any GuestRecoveryCredentialStoring =
                KeychainGuestRecoveryCredentialStore(),
        readData: @escaping @Sendable (URL) throws -> Data = {
            try Data(contentsOf: $0)
        },
        voiceLocaleHint: @escaping @Sendable () -> String? = {
            Locale.preferredLanguages.first
        },
        newIdempotencyKey: @escaping @Sendable () -> UUID = { UUID() }
    ) {
        self.submitter = submitter
        self.attemptStore = attemptStore
        self.draftStore = draftStore
        self.tokenProvider = tokenProvider
        self.guestRecoveryCredentials = guestRecoveryCredentials
        self.readData = readData
        self.voiceLocaleHint = voiceLocaleHint
        self.newIdempotencyKey = newIdempotencyKey
    }

    fileprivate func recoverableAttempt(
        for context: ItemRunSubmissionPrincipalContext
    ) async -> ItemRunSubmissionAttempt? {
        guard await context.validatesFilesystemContext() else {
            return nil
        }
        let readData = readData
        let localeHint = voiceLocaleHint()
        let intake: ItemRunSubmissionSnapshot.Result
        do {
            intake = try await Task.detached(priority: .userInitiated) {
                try ItemRunSubmissionSnapshot.make(
                    for: context.photos,
                    voice: context.voice,
                    localeHint: localeHint,
                    readData: readData
                )
            }.value
        } catch {
            return nil
        }
        guard await context.validatesFilesystemContext(),
              let attempt = try? await context.attemptStore.loadAttempt(),
              attempt.standsFor(
                  intake.photos,
                  voiceContext: intake.voiceContext
              ) else {
            return nil
        }
        return attempt
    }

    func submit(photos: [StagedCapturePhoto]) async -> ItemRunSubmissionOutcome {
        switch await prepareSubmission(photos: photos) {
        case .accepted(let submission):
            return .accepted(await finalize(submission))
        case .ambiguous:
            return .retained(.ambiguous)
        case .retained(let retention):
            return .retained(retention)
        }
    }

    fileprivate func prepareSubmission(
        photos: [StagedCapturePhoto]
    ) async -> Preparation {
        let attemptStore = attemptStore
        let draftStore = draftStore
        return await prepareSubmission(
            context: CapturedContext(
                photos: photos,
                voice: nil,
                scopeProof: nil,
                attemptStore: attemptStore,
                validateFilesystemContext: { true },
                prepareDurableIntake: { photos in
                    let durablePhotos = (try? await draftStore.loadPhotos()) ?? []
                    guard durablePhotos != photos else {
                        return true
                    }
                    do {
                        try await draftStore.replacePhotos(with: photos)
                        return true
                    } catch {
                        return false
                    }
                },
                discardExactly: { photos in
                    (try? await draftStore.discardExactly(photos)) ?? false
                },
                retireAcceptedPhotosPreservingUnmatchedVoice: { _ in
                    false
                }
            ),
            isCurrent: { true }
        )
    }

    fileprivate func prepareSubmission(
        principalContext: ItemRunSubmissionPrincipalContext,
        isCurrent: @escaping @MainActor () -> Bool
    ) async -> Preparation {
        await prepareSubmission(
            context: CapturedContext(
                photos: principalContext.photos,
                voice: principalContext.voice,
                scopeProof: principalContext.scopeProof,
                attemptStore: principalContext.attemptStore,
                validateFilesystemContext: {
                    await principalContext
                        .validatesFilesystemContext()
                },
                prepareDurableIntake: { _ in true },
                discardExactly: { _ in
                    await principalContext.discardExactly()
                },
                retireAcceptedPhotosPreservingUnmatchedVoice: { _ in
                    await principalContext
                        .retireAcceptedPhotosPreservingUnmatchedVoice()
                }
            ),
            isCurrent: isCurrent
        )
    }

    private func prepareSubmission(
        context: CapturedContext,
        isCurrent: @escaping @MainActor () -> Bool
    ) async -> Preparation {
        // Bearer authority is acquired while only the immutable principal context is
        // captured. Draft, attempt, and photo bytes remain unread until the current
        // principal generation has been revalidated.
        let capturedBearer: CapturedBearer
        switch await acquireBearer(for: context) {
        case .captured(let bearer):
            capturedBearer = bearer
        case .principalMismatch:
            return .retained(.submissionUnavailable)
        case .credentialAbsent:
            return .retained(.authenticationRequired)
        case .temporarilyUnavailable:
            return .retained(.submissionUnavailable)
        }
        guard !Task.isCancelled, isCurrent() else {
            return .retained(.submissionUnavailable)
        }
        guard await context.validateFilesystemContext() else {
            return .retained(.attemptNotPersisted)
        }

        let readData = readData
        let voiceLocaleHint = voiceLocaleHint()
        let intake: ItemRunSubmissionSnapshot.Result
        do {
            // Up to five full-size photos get read and hashed here. Doing that on the
            // main actor stalls the screen the seller is still looking at.
            intake = try await Task.detached(priority: .userInitiated) {
                try ItemRunSubmissionSnapshot.make(
                    for: context.photos,
                    voice: context.voice,
                    localeHint: voiceLocaleHint,
                    readData: readData
                )
            }.value
        } catch {
            return .retained(.intakeUnavailable)
        }
        let snapshot = intake.photos

        // Photo Review defers its edits. Deleting or reordering a photo there only
        // changes what is on screen; the durable draft learns about it when an exit
        // commits. Back is one such exit and writes the displayed set as it leaves.
        // Submitting is a third exit, so it commits the same way before the request.
        //
        // Without this the receipt would validate against photos the durable draft still
        // holds, the exact clear would refuse the run it just accepted, and the seller
        // would be charged for an item with nothing on screen to show for it.
        //
        // The store accepts only a reorder or a removal of photos it already holds, byte
        // for byte. A rejected write means the screen and the draft disagree in a way
        // this submission cannot resolve, and nothing is sent: a request whose clear is
        // already known to refuse would spend an AI-item credit for a run the seller
        // never sees.
        guard await context.prepareDurableIntake(context.photos) else {
            return .retained(.intakeUnavailable)
        }

        // Hashing and the durable-intake handoff both suspend. Authentication can
        // switch while NativeIntake's principal event is still queued, so resolve a
        // fresh same-session bearer/proof pair before touching the captured attempt.
        guard await revalidatedBearer(
            captured: capturedBearer,
            for: context,
            isCurrent: isCurrent
        ) != nil else {
            return .retained(.submissionUnavailable)
        }
        guard await context.validateFilesystemContext() else {
            return .retained(.attemptNotPersisted)
        }

        // A stored attempt standing for these exact photos is the same logical
        // submission, so it keeps its key. Retrying under a new key would ask the server
        // to create a second run and spend a second AI-item credit for one item.
        //
        // A store that cannot answer is not a store with nothing in it. Swallowing the
        // failure here would take the same branch as "no record" and mint exactly the
        // second key this whole path exists to avoid, so it stops before the network.
        let storedAttempt: ItemRunSubmissionAttempt?
        do {
            storedAttempt = try await context.attemptStore.loadAttempt()
        } catch {
            return .retained(.attemptNotPersisted)
        }
        if let storedAttempt,
           storedAttempt.voiceContext != nil,
           intake.voiceContext == nil,
           storedAttempt.photos.map(\.fingerprint)
               == snapshot.map(\.fingerprint),
           storedAttempt.hasSameVoiceReference(as: context.voice) {
            // An ambiguous voice-bearing request may already have committed. If the
            // same local asset can no longer reproduce its exact bytes, replacing its
            // key with a photo-only request could buy a duplicate run. Preserve the
            // attempt and whole intake until the bytes become readable or #545 expiry
            // authority resolves the bundle.
            return .retained(.intakeUnavailable)
        }
        let attempt: ItemRunSubmissionAttempt
        let storedAttemptMatches = storedAttempt?.standsFor(
            snapshot,
            voiceContext: intake.voiceContext
        ) ?? false
        if let storedAttempt,
           storedAttemptMatches,
           (storedAttempt.guestRecoveryIdentity != nil)
                != capturedBearer.isGuest {
            // A response for this exact key may already have committed. Legacy
            // guest attempts did not persist recovery identity, so inventing a
            // new key here could create a second run and spend another credit.
            return .retained(.attemptNotPersisted)
        }
        if let storedAttempt,
           storedAttemptMatches {
            if let identity = storedAttempt.guestRecoveryIdentity {
                do {
                    guard try await guestRecoveryCredentials.contains(identity)
                    else {
                        return .retained(.attemptNotPersisted)
                    }
                } catch {
                    return .retained(.attemptNotPersisted)
                }
            }
            attempt = storedAttempt
        } else {
            let guestRecoveryIdentity: GuestRecoverySubmissionIdentity?
            if capturedBearer.isGuest {
                do {
                    guestRecoveryIdentity = try await guestRecoveryCredentials
                        .mintCredential()
                } catch {
                    return .retained(.attemptNotPersisted)
                }
            } else {
                guestRecoveryIdentity = nil
            }
            attempt = ItemRunSubmissionAttempt(
                idempotencyKey: newIdempotencyKey(),
                photos: snapshot,
                voiceContext: intake.voiceContext,
                guestRecoveryIdentity: guestRecoveryIdentity
            )
        }
        if attempt != storedAttempt {
            do {
                try await context.attemptStore.saveAttempt(attempt)
            } catch {
                if let identity = attempt.guestRecoveryIdentity,
                   storedAttempt?.guestRecoveryIdentity != identity {
                    try? await guestRecoveryCredentials.purge(
                        recoveryID: identity.recoveryID
                    )
                }
                return .retained(.attemptNotPersisted)
            }
        }

        guard let submitter else {
            return .retained(.submissionUnavailable)
        }
        let payload = ItemRunSubmissionPayload(
            attempt: attempt,
            photoData: intake.photoData,
            voiceData: intake.voiceData
        )
        // Resolve again beside dispatch. Comparing only the earlier proof cannot see
        // an authentication switch whose NativeIntake event has not reached AppShell.
        guard let dispatchBearer = await revalidatedBearer(
            captured: capturedBearer,
            for: context,
            isCurrent: isCurrent
        ) else {
            return .retained(.submissionUnavailable)
        }
        guard await context.validateFilesystemContext() else {
            return .retained(.attemptNotPersisted)
        }
        let outcome = await submitter.submit(
            payload,
            bearerToken: dispatchBearer.token
        )
        if Task.isCancelled {
            return await resolve(
                .cancelled,
                context: context,
                payload: payload,
                submittedPhotos: context.photos
            )
        }

        // The server may have committed even if the visible principal departed while
        // the request was open. Suppress that departed result and retain its exact key
        // for an idempotent replay; never infer cancellation or clean up another scope.
        guard await revalidatedBearer(
            captured: dispatchBearer,
            for: context,
            isCurrent: isCurrent
        ) != nil else {
            return .retained(.submissionUnavailable)
        }
        guard await context.validateFilesystemContext() else {
            return .retained(.attemptNotPersisted)
        }
        return await resolve(
            outcome,
            context: context,
            payload: payload,
            submittedPhotos: context.photos
        )
    }

    fileprivate func retryAmbiguousSubmission(
        _ retry: AmbiguousRetry,
        currentPhotos: [StagedCapturePhoto],
        isCurrent: @escaping @MainActor () -> Bool = { true }
    ) async -> Preparation {
        guard let submitter else {
            return .retained(.submissionUnavailable)
        }

        let capturedBearer: CapturedBearer
        switch await acquireBearer(for: retry.context) {
        case .captured(let bearer):
            capturedBearer = bearer
        case .principalMismatch:
            return .retained(.submissionUnavailable)
        case .credentialAbsent:
            return .retained(.authenticationRequired)
        case .temporarilyUnavailable:
            return .retained(.submissionUnavailable)
        }
        guard !Task.isCancelled, isCurrent() else {
            return .retained(.submissionUnavailable)
        }
        guard await retry.context.validateFilesystemContext() else {
            return .retained(.attemptNotPersisted)
        }

        let storedAttempt: ItemRunSubmissionAttempt?
        do {
            storedAttempt = try await retry.context.attemptStore.loadAttempt()
        } catch {
            return .retained(.attemptNotPersisted)
        }
        guard storedAttempt == retry.payload.attempt else {
            return .retained(.attemptNotPersisted)
        }

        guard let dispatchBearer = await revalidatedBearer(
            captured: capturedBearer,
            for: retry.context,
            isCurrent: isCurrent
        ) else {
            return .retained(.submissionUnavailable)
        }
        guard await retry.context.validateFilesystemContext() else {
            return .retained(.attemptNotPersisted)
        }
        let outcome = await submitter.submit(
            retry.payload,
            bearerToken: dispatchBearer.token
        )
        guard await revalidatedBearer(
            captured: dispatchBearer,
            for: retry.context,
            isCurrent: isCurrent
        ) != nil else {
            return .retained(.submissionUnavailable)
        }
        guard await retry.context.validateFilesystemContext() else {
            return .retained(.attemptNotPersisted)
        }
        return await resolve(
            outcome,
            context: retry.context,
            payload: retry.payload,
            submittedPhotos: retry.submittedPhotos,
            canClearSubmittedIntake:
                currentPhotos == retry.submittedPhotos
        )
    }

    private func acquireBearer(
        for context: CapturedContext
    ) async -> BearerAcquisition {
        do {
            if let expectedScopeProof = context.scopeProof {
                let bound = try await tokenProvider.principalBoundBearer()
                guard bound.scopeProof == expectedScopeProof else {
                    return .principalMismatch
                }
                return .captured(
                    CapturedBearer(
                        token: bound.bearerToken
                    )
                )
            }
            return .captured(
                CapturedBearer(
                    token: try await tokenProvider.bearerToken()
                )
            )
        } catch let error as BearerTokenProviderError {
            switch error {
            case .sessionAbsent:
                return .credentialAbsent
            case .principalBindingUnavailable:
                return .temporarilyUnavailable
            }
        } catch {
            return .temporarilyUnavailable
        }
    }

    private func revalidatedBearer(
        captured: CapturedBearer,
        for context: CapturedContext,
        isCurrent: @escaping @MainActor () -> Bool
    ) async -> CapturedBearer? {
        guard !Task.isCancelled, isCurrent() else {
            return nil
        }
        guard context.scopeProof != nil else {
            return captured
        }
        guard case .captured(let bearer) =
            await acquireBearer(for: context),
              !Task.isCancelled,
              isCurrent() else {
            return nil
        }
        return bearer
    }

    private func resolve(
        _ outcome: ItemRunSubmissionTransportOutcome,
        context: CapturedContext,
        payload: ItemRunSubmissionPayload,
        submittedPhotos: [StagedCapturePhoto],
        canClearSubmittedIntake: Bool = true
    ) async -> Preparation {
        let attempt = payload.attempt
        switch outcome {
        case .created(let receipt), .replayed(let receipt):
            // Exact ordered photos establish the canonical item/run. Optional voice
            // acceptance is narrower cleanup authority. Null or mismatched voice
            // still surfaces and retires the exact photo run, while its local bytes
            // become deletion-only under their original scoped expiry.
            guard attempt.matchesPhotos(receipt: receipt) else {
                return .retained(.receiptMismatch)
            }
            if let recoveryIdentity = attempt.guestRecoveryIdentity {
                guard let photoIdentity = attempt.verifiedGuestPhotoIdentity(
                    receipt: receipt
                ) else {
                    return .retained(.receiptMismatch)
                }
                do {
                    try await guestRecoveryCredentials.bind(
                        recoveryIdentity,
                        itemID: receipt.itemId,
                        runID: receipt.runId,
                        photoIdentity: photoIdentity
                    )
                } catch {
                    // The server may already own the run. Keep the exact attempt
                    // and replay it until its local claim authority is durable.
                    return .retained(.attemptNotPersisted)
                }
            }
            let intakeCleanup: Submission.IntakeCleanup
            if !canClearSubmittedIntake {
                intakeCleanup = .none
            } else if attempt.permitsWholeIntakeCleanup(
                receipt: receipt
            ) {
                intakeCleanup = .wholeBundle
            } else if attempt.voiceContext != nil,
                      context.voice != nil {
                intakeCleanup = .photosPreservingUnmatchedVoice
            } else {
                intakeCleanup = .none
            }
            return .accepted(
                Submission(
                    context: context,
                    acceptedRun: AcceptedItemRun(
                        runID: receipt.runId,
                        itemID: receipt.itemId,
                        status: receipt.status,
                        stage: receipt.stage
                    ),
                    submittedPhotos: submittedPhotos,
                    attempt: attempt,
                    intakeCleanup: intakeCleanup
                )
            )
        case .rejected:
            return .retained(.rejected)
        case .authenticationRequired:
            return .retained(.authenticationRequired)
        case .creditDenied(let reason):
            return .retained(.creditDenied(reason: reason))
        case .conflict:
            // This key is bound to other bytes and can never accept these, so retiring
            // it is the only way the seller's retained photos stay submittable.
            do {
                try await context.attemptStore.clearAttempt(attempt)
                if let identity = attempt.guestRecoveryIdentity {
                    try? await guestRecoveryCredentials.purge(
                        recoveryID: identity.recoveryID
                    )
                }
            } catch {
                return .retained(.attemptNotPersisted)
            }
            return .retained(.conflict)
        case .rateLimited(let reason):
            return .retained(.rateLimited(reason: reason))
        case .cancelled:
            return .ambiguous(
                AmbiguousRetry(
                    context: context,
                    submittedPhotos: submittedPhotos,
                    payload: payload,
                    reason: .cancelled
                )
            )
        case .offline:
            return .ambiguous(
                AmbiguousRetry(
                    context: context,
                    submittedPhotos: submittedPhotos,
                    payload: payload,
                    reason: .offline
                )
            )
        case .ambiguous:
            return .ambiguous(
                AmbiguousRetry(
                    context: context,
                    submittedPhotos: submittedPhotos,
                    payload: payload,
                    reason: .unknown
                )
            )
        }
    }

    fileprivate func finalize(
        _ submission: Submission
    ) async -> ItemRunAcceptance {
        let clearedIntake: Bool
        switch submission.intakeCleanup {
        case .none:
            return ItemRunAcceptance(
                run: submission.acceptedRun,
                clearedIntake: false
            )
        case .wholeBundle:
            clearedIntake = await submission.context.discardExactly(
                submission.submittedPhotos
            )
        case .photosPreservingUnmatchedVoice:
            clearedIntake = await submission.context
                .retireAcceptedPhotosPreservingUnmatchedVoice(
                    submission.submittedPhotos
                )
        }
        // The key is only retired once the photos it stands for are gone. If they
        // survived, the seller can still submit these exact bytes, and keeping the
        // key makes that an idempotent replay of the run the server already made
        // rather than a second run on a second AI-item credit.
        if clearedIntake {
            try? await submission.context.attemptStore.clearAttempt(
                submission.attempt
            )
        }
        return ItemRunAcceptance(
            run: submission.acceptedRun,
            clearedIntake: clearedIntake
        )
    }
}
