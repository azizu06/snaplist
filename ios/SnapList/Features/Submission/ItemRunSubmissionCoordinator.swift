import Foundation
import Observation
#if DEBUG
import CoreFoundation
#endif

#if DEBUG
struct DelayedItemRunSubmissionFixture {
    func complete() async {
        try? await Task.sleep(for: .seconds(2))
    }
}

private struct AcceptedPresentationGatedItemRunSubmitter: ItemRunSubmitting {
    private static let restoredPhotoPath = "/fixture/capture-photo.jpg"
    private static let restoredPhotoData = Data([
        0xFF, 0xD8, 0xFF, 0xD9,
    ])

    static func readRestoredPhoto(at url: URL) throws -> Data {
        guard url.isFileURL, url.path == restoredPhotoPath else {
            throw CocoaError(.fileReadNoSuchFile)
        }
        return restoredPhotoData
    }

    func submit(
        _ payload: ItemRunSubmissionPayload,
        bearerToken: String
    ) async -> ItemRunSubmissionTransportOutcome {
        guard let firstPhoto = payload.attempt.photos.first,
              payload.attempt.photos.count == payload.photoData.count else {
            return .rejected
        }
        let fingerprintBytes = Data(
            payload.attempt.photos
                .map(\.contentSha256)
                .joined(separator: ":")
                .utf8
        )
        return .created(
            MobileItemSubmissionEnvelope.DataPayload(
                itemId: firstPhoto.photoID,
                runId: payload.attempt.idempotencyKey,
                status: "queued",
                stage: "queued",
                photoIdentity: .init(
                    kind: "content_sha256_set_v1",
                    fingerprint: LocalPhotoFingerprint.digest(
                        of: fingerprintBytes
                    )
                ),
                photos: payload.attempt.photos.map { photo in
                    MobileItemSubmissionEnvelope.PhotoReceipt(
                        ordinal: photo.ordinal,
                        contentSha256: photo.contentSha256,
                        byteLength: photo.byteLength,
                        mediaType: photo.mediaType.rawValue
                    )
                }
            )
        )
    }
}

private struct AcceptedPresentationGatedBearerTokenProvider:
    BearerTokenProviding {
    func bearerToken() async throws -> String {
        "accepted-presentation-gated-fixture"
    }
}

private struct RateLimitedItemRunSubmitter: ItemRunSubmitting {
    func submit(
        _ payload: ItemRunSubmissionPayload,
        bearerToken: String
    ) async -> ItemRunSubmissionTransportOutcome {
        .rateLimited(reason: nil)
    }
}

@MainActor
private final class ItemRunSubmissionAcknowledgmentNotificationGate {
    private typealias PendingAcknowledgment = (
        eventID: UUID,
        forward: (UUID) -> Void
    )

    private let notificationName: CFNotificationName
    private var pendingAcknowledgment: PendingAcknowledgment?
    private var didReceiveSignal = false
    private var didForwardAcknowledgment = false

    init(notificationName: SubmissionAcknowledgmentNotificationName) {
        self.notificationName = CFNotificationName(
            rawValue: notificationName.rawValue as CFString
        )
        CFNotificationCenterAddObserver(
            CFNotificationCenterGetDarwinNotifyCenter(),
            Unmanaged.passUnretained(self).toOpaque(),
            { _, observer, _, _, _ in
                guard let observer else { return }
                let gate = Unmanaged<
                    ItemRunSubmissionAcknowledgmentNotificationGate
                >
                    .fromOpaque(observer)
                    .takeUnretainedValue()
                Task { @MainActor in
                    gate.receiveSignal()
                }
            },
            self.notificationName.rawValue,
            nil,
            .deliverImmediately
        )
    }

    deinit {
        CFNotificationCenterRemoveObserver(
            CFNotificationCenterGetDarwinNotifyCenter(),
            Unmanaged.passUnretained(self).toOpaque(),
            notificationName,
            nil
        )
    }

    func withhold(
        eventID: UUID,
        forward: @escaping (UUID) -> Void
    ) {
        guard !didForwardAcknowledgment else {
            return
        }
        if didReceiveSignal {
            didForwardAcknowledgment = true
            forward(eventID)
            return
        }
        guard pendingAcknowledgment == nil else {
            return
        }
        pendingAcknowledgment = (eventID, forward)
    }

    private func receiveSignal() {
        guard !didForwardAcknowledgment else {
            return
        }
        didReceiveSignal = true
        guard let pendingAcknowledgment else {
            return
        }
        self.pendingAcknowledgment = nil
        didForwardAcknowledgment = true
        pendingAcknowledgment.forward(pendingAcknowledgment.eventID)
    }
}
#endif

enum ItemRunSubmissionPresentationEvent: Equatable, Sendable {
    case itemSaved(eventID: UUID, acceptedRun: AcceptedItemRun)
    case submissionRejected(
        eventID: UUID,
        retention: ItemRunSubmissionRetention
    )
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
    private var presentationAcknowledgmentGate:
        ItemRunSubmissionPresentationAcknowledgmentGate?
    /// Fixture launches render approved states with no server behind them, so Start
    /// listing is inert by design there rather than unavailable.
    private let isInert: Bool
#if DEBUG
    private let delayedFixture: DelayedItemRunSubmissionFixture?
    private let acknowledgmentNotificationGate:
        ItemRunSubmissionAcknowledgmentNotificationGate?
#endif

    init(coordinator: ItemRunSubmissionCoordinator?, isInert: Bool = false) {
        self.coordinator = coordinator
        self.isInert = isInert
#if DEBUG
        delayedFixture = nil
        acknowledgmentNotificationGate = nil
#endif
    }

#if DEBUG
    init(delayedFixture: DelayedItemRunSubmissionFixture) {
        coordinator = nil
        isInert = false
        self.delayedFixture = delayedFixture
        acknowledgmentNotificationGate = nil
    }

    init(
        coordinator: ItemRunSubmissionCoordinator,
        acknowledgmentNotification:
            SubmissionAcknowledgmentNotificationName
    ) {
        self.coordinator = coordinator
        isInert = false
        delayedFixture = nil
        acknowledgmentNotificationGate =
            ItemRunSubmissionAcknowledgmentNotificationGate(
                notificationName: acknowledgmentNotification
            )
    }
#endif

    /// One tap, one submission. A second tap while a request is open would build a
    /// second attempt from the same photos and could buy the seller a second run.
    func startListing(photos: [StagedCapturePhoto]) async {
        guard !isSubmitting, !isInert else {
            return
        }
#if DEBUG
        if let delayedFixture {
            isSubmitting = true
            defer { isSubmitting = false }
            await delayedFixture.complete()
            return
        }
#endif
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
        isSubmitting = true
        defer { isSubmitting = false }

        switch await coordinator.prepareSubmission(photos: photos) {
        case .accepted(let submission):
            retention = nil
            acceptedRun = submission.acceptedRun
            clearedIntake = false

            let eventID = UUID()
            let gate = ItemRunSubmissionPresentationAcknowledgmentGate(
                eventID: eventID
            )
            presentationAcknowledgmentGate = gate
            pendingPresentationEvent = .itemSaved(
                eventID: eventID,
                acceptedRun: submission.acceptedRun
            )

            let acknowledged = await gate.wait()
            if presentationAcknowledgmentGate === gate {
                presentationAcknowledgmentGate = nil
            }
            guard acknowledged, !Task.isCancelled else {
                if pendingPresentationEvent == .itemSaved(
                    eventID: eventID,
                    acceptedRun: submission.acceptedRun
                ) {
                    pendingPresentationEvent = nil
                }
                return
            }

            let acceptance = await coordinator.finalize(submission)
            clearedIntake = acceptance.clearedIntake
            if !acceptance.clearedIntake,
               pendingPresentationEvent == .itemSaved(
                   eventID: eventID,
                   acceptedRun: submission.acceptedRun
               ) {
                pendingPresentationEvent = nil
            }
        case .retained(let retention):
            acceptedRun = nil
            clearedIntake = false
            self.retention = retention
            switch retention {
            case .rateLimited(reason: _),
                 .attemptNotPersisted,
                 .submissionUnavailable,
                 .rejected,
                 .intakeUnavailable:
                pendingPresentationEvent = .submissionRejected(
                    eventID: UUID(),
                    retention: retention
                )
            default:
                break
            }
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

    @discardableResult
    func reviewRejectedSubmission(eventID: UUID) -> Bool {
        guard case .submissionRejected(
            eventID: let pendingEventID,
            retention: let retention
        )? = pendingPresentationEvent,
              retention == .rejected || retention == .intakeUnavailable,
              pendingEventID == eventID else {
            return false
        }
        pendingPresentationEvent = nil
        return true
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
    private static let retainedMessage =
        "This didn't go through. Your item is still saved on this phone."
    private static let reviewMessage =
        "This item can't be sent as it is."

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

    static let idle = PhotoReviewSubmissionPresentation(
        primaryActionLabel: "Start listing",
        primaryActionEvent: .startListing,
        mutationControlsLocked: false,
        announcementEvent: nil,
        accessibilityAnnouncement: nil,
        visibleMessage: nil,
        rendersSubmittedMedia: true
    )

    private init(
        primaryActionLabel: String,
        primaryActionEvent: PhotoReviewBoundaryEvent,
        mutationControlsLocked: Bool,
        announcementEvent: AnnouncementEvent?,
        accessibilityAnnouncement: String?,
        visibleMessage: String?,
        rendersSubmittedMedia: Bool
    ) {
        self.primaryActionLabel = primaryActionLabel
        self.primaryActionEvent = primaryActionEvent
        self.mutationControlsLocked = mutationControlsLocked
        self.announcementEvent = announcementEvent
        self.accessibilityAnnouncement = accessibilityAnnouncement
        self.visibleMessage = visibleMessage
        self.rendersSubmittedMedia = rendersSubmittedMedia
    }

    @MainActor
    init(host: ItemRunSubmissionHost) {
        if case .itemSaved(let eventID, _)? = host.pendingPresentationEvent {
            self = PhotoReviewSubmissionPresentation(
                primaryActionLabel: "Item saved",
                primaryActionEvent: .startListing,
                mutationControlsLocked: true,
                announcementEvent: .itemSaved(eventID: eventID),
                accessibilityAnnouncement: "Item saved.",
                visibleMessage: nil,
                rendersSubmittedMedia: false
            )
        } else if host.isSubmitting {
            self = PhotoReviewSubmissionPresentation(
                primaryActionLabel: "Saving your item",
                primaryActionEvent: .startListing,
                mutationControlsLocked: true,
                announcementEvent: .saving,
                accessibilityAnnouncement: "Saving your item.",
                visibleMessage: nil,
                rendersSubmittedMedia: true
            )
        } else if case .submissionRejected(
            eventID: let eventID,
            retention: .rateLimited(reason: _)
        )? = host.pendingPresentationEvent {
            self = PhotoReviewSubmissionPresentation(
                primaryActionLabel: "Try again",
                primaryActionEvent: .startListing,
                mutationControlsLocked: false,
                announcementEvent: .submissionRejected(eventID: eventID),
                accessibilityAnnouncement: Self.retainedMessage,
                visibleMessage: Self.retainedMessage,
                rendersSubmittedMedia: true
            )
        } else if case .submissionRejected(
            eventID: let eventID,
            retention: .attemptNotPersisted
        )? = host.pendingPresentationEvent {
            self = PhotoReviewSubmissionPresentation(
                primaryActionLabel: "Try again",
                primaryActionEvent: .startListing,
                mutationControlsLocked: false,
                announcementEvent: .submissionRejected(eventID: eventID),
                accessibilityAnnouncement: Self.retainedMessage,
                visibleMessage: Self.retainedMessage,
                rendersSubmittedMedia: true
            )
        } else if case .submissionRejected(
            eventID: let eventID,
            retention: .submissionUnavailable
        )? = host.pendingPresentationEvent {
            self = PhotoReviewSubmissionPresentation(
                primaryActionLabel: "Try again",
                primaryActionEvent: .startListing,
                mutationControlsLocked: false,
                announcementEvent: .submissionRejected(eventID: eventID),
                accessibilityAnnouncement: Self.retainedMessage,
                visibleMessage: Self.retainedMessage,
                rendersSubmittedMedia: true
            )
        } else if case .submissionRejected(
            eventID: let eventID,
            retention: .rejected
        )? = host.pendingPresentationEvent {
            self = PhotoReviewSubmissionPresentation(
                primaryActionLabel: "Review",
                primaryActionEvent: .reviewSubmission(eventID: eventID),
                mutationControlsLocked: false,
                announcementEvent: .submissionRejected(eventID: eventID),
                accessibilityAnnouncement: Self.reviewMessage,
                visibleMessage: Self.reviewMessage,
                rendersSubmittedMedia: true
            )
        } else if case .submissionRejected(
            eventID: let eventID,
            retention: .intakeUnavailable
        )? = host.pendingPresentationEvent {
            self = PhotoReviewSubmissionPresentation(
                primaryActionLabel: "Review",
                primaryActionEvent: .reviewSubmission(eventID: eventID),
                mutationControlsLocked: false,
                announcementEvent: .submissionRejected(eventID: eventID),
                accessibilityAnnouncement: Self.reviewMessage,
                visibleMessage: Self.reviewMessage,
                rendersSubmittedMedia: true
            )
        } else {
            self = .idle
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
        if case .itemSaved(let eventID)? = presentation.announcementEvent {
            acknowledgePresentation(eventID)
        }
    }
}

@MainActor
enum PhotoReviewSubmissionPrimaryActionConsumer {
    @discardableResult
    static func consume(
        _ event: PhotoReviewBoundaryEvent,
        submissionHost: ItemRunSubmissionHost
    ) -> Bool {
        guard case .reviewSubmission(let eventID) = event else {
            return false
        }
        return submissionHost.reviewRejectedSubmission(eventID: eventID)
    }
}

@MainActor
enum ItemRunSubmissionHostFactory {
    static func make(
        configuration: LaunchConfiguration,
        apiOrigin: URL?,
        tokenProvider: any BearerTokenProviding,
        session: URLSession,
        draftStore: any CaptureDraftStoring
    ) -> ItemRunSubmissionHost {
#if DEBUG
        if configuration.usesZeroNetworkFixtures,
           configuration.submissionFixture == .acceptedPresentationGated,
           let acknowledgmentNotification =
               configuration.submissionAcknowledgmentNotification {
            return ItemRunSubmissionHost(
                coordinator: ItemRunSubmissionCoordinator(
                    submitter: AcceptedPresentationGatedItemRunSubmitter(),
                    attemptStore: LocalItemRunSubmissionAttemptStore(),
                    draftStore: draftStore,
                    tokenProvider:
                        AcceptedPresentationGatedBearerTokenProvider(),
                    readData: { @Sendable url in
                        try AcceptedPresentationGatedItemRunSubmitter
                            .readRestoredPhoto(at: url)
                    }
                ),
                acknowledgmentNotification: acknowledgmentNotification
            )
        }
        if configuration.usesZeroNetworkFixtures,
           configuration.submissionFixture == .delayed {
            return ItemRunSubmissionHost(
                delayedFixture: DelayedItemRunSubmissionFixture()
            )
        }
        if configuration.usesZeroNetworkFixtures,
           configuration.submissionFixture == .rateLimited {
            return ItemRunSubmissionHost(
                coordinator: ItemRunSubmissionCoordinator(
                    submitter: RateLimitedItemRunSubmitter(),
                    attemptStore: LocalItemRunSubmissionAttemptStore(),
                    draftStore: draftStore,
                    tokenProvider:
                        AcceptedPresentationGatedBearerTokenProvider(),
                    readData: { @Sendable url in
                        try AcceptedPresentationGatedItemRunSubmitter
                            .readRestoredPhoto(at: url)
                    }
                )
            )
        }
#endif
        guard !configuration.usesZeroNetworkFixtures else {
            return ItemRunSubmissionHost(coordinator: nil, isInert: true)
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
            )
        )
    }
}

/// Turns the seller's ordered Photo Review intake into one canonical durable run.
@MainActor
final class ItemRunSubmissionCoordinator {
    fileprivate struct Submission {
        fileprivate let acceptedRun: AcceptedItemRun
        fileprivate let submittedPhotos: [StagedCapturePhoto]
        fileprivate let attempt: ItemRunSubmissionAttempt
    }

    fileprivate enum Preparation {
        case accepted(Submission)
        case retained(ItemRunSubmissionRetention)
    }

    private let submitter: (any ItemRunSubmitting)?
    private let attemptStore: any ItemRunSubmissionAttemptStoring
    private let draftStore: any CaptureDraftStoring
    private let tokenProvider: any BearerTokenProviding
    private let readData: @Sendable (URL) throws -> Data
    private let newIdempotencyKey: @Sendable () -> UUID

    init(
        submitter: (any ItemRunSubmitting)?,
        attemptStore: any ItemRunSubmissionAttemptStoring,
        draftStore: any CaptureDraftStoring,
        tokenProvider: any BearerTokenProviding,
        readData: @escaping @Sendable (URL) throws -> Data = {
            try Data(contentsOf: $0)
        },
        newIdempotencyKey: @escaping @Sendable () -> UUID = { UUID() }
    ) {
        self.submitter = submitter
        self.attemptStore = attemptStore
        self.draftStore = draftStore
        self.tokenProvider = tokenProvider
        self.readData = readData
        self.newIdempotencyKey = newIdempotencyKey
    }

    func submit(photos: [StagedCapturePhoto]) async -> ItemRunSubmissionOutcome {
        switch await prepareSubmission(photos: photos) {
        case .accepted(let submission):
            return .accepted(await finalize(submission))
        case .retained(let retention):
            return .retained(retention)
        }
    }

    fileprivate func prepareSubmission(
        photos: [StagedCapturePhoto]
    ) async -> Preparation {
        let readData = readData
        let intake: ItemRunSubmissionSnapshot.Result
        do {
            // Up to five full-size photos get read and hashed here. Doing that on the
            // main actor stalls the screen the seller is still looking at.
            intake = try await Task.detached(priority: .userInitiated) {
                try ItemRunSubmissionSnapshot.make(for: photos, readData: readData)
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
        let durablePhotos = (try? await draftStore.loadPhotos()) ?? []
        if durablePhotos != photos {
            do {
                try await draftStore.replacePhotos(with: photos)
            } catch {
                return .retained(.intakeUnavailable)
            }
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
            storedAttempt = try await attemptStore.loadAttempt()
        } catch {
            return .retained(.attemptNotPersisted)
        }
        let attempt: ItemRunSubmissionAttempt
        if let storedAttempt, storedAttempt.standsFor(snapshot) {
            attempt = storedAttempt
        } else {
            attempt = ItemRunSubmissionAttempt(
                idempotencyKey: newIdempotencyKey(),
                photos: snapshot
            )
        }
        if attempt != storedAttempt {
            do {
                try await attemptStore.saveAttempt(attempt)
            } catch {
                return .retained(.attemptNotPersisted)
            }
        }

        guard let submitter else {
            return .retained(.submissionUnavailable)
        }

        let token: String
        do {
            token = try await tokenProvider.bearerToken()
        } catch {
            return .retained(.authenticationRequired)
        }

        let outcome = await submitter.submit(
            ItemRunSubmissionPayload(attempt: attempt, photoData: intake.photoData),
            bearerToken: token
        )

        switch outcome {
        case .created(let receipt), .replayed(let receipt):
            // The receipt has to account for what was actually sent before any photo is
            // deleted. A receipt describing another submission is not permission to
            // clear this one.
            guard attempt.matches(receipt: receipt) else {
                return .retained(.receiptMismatch)
            }
            return .accepted(
                Submission(
                    acceptedRun: AcceptedItemRun(
                        runID: receipt.runId,
                        itemID: receipt.itemId,
                        status: receipt.status,
                        stage: receipt.stage
                    ),
                    submittedPhotos: photos,
                    attempt: attempt
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
            try? await attemptStore.clearAttempt(attempt)
            return .retained(.conflict)
        case .rateLimited(let reason):
            return .retained(.rateLimited(reason: reason))
        case .ambiguous:
            return .retained(.ambiguous)
        }
    }

    fileprivate func finalize(
        _ submission: Submission
    ) async -> ItemRunAcceptance {
        let clearedIntake = (
            try? await draftStore.discardExactly(submission.submittedPhotos)
        ) ?? false
        // The key is only retired once the photos it stands for are gone. If they
        // survived, the seller can still submit these exact bytes, and keeping the
        // key makes that an idempotent replay of the run the server already made
        // rather than a second run on a second AI-item credit.
        if clearedIntake {
            try? await attemptStore.clearAttempt(submission.attempt)
        }
        return ItemRunAcceptance(
            run: submission.acceptedRun,
            clearedIntake: clearedIntake
        )
    }
}
