#if DEBUG
import CoreFoundation
import Foundation

struct DelayedItemRunSubmissionFixture {
    func complete() async {
        try? await Task.sleep(for: .seconds(8))
    }
}

private struct AcceptedPresentationGatedItemRunSubmitter: ItemRunSubmitting {
    static func readRestoredPhoto(at url: URL) throws -> Data {
        guard url.isFileURL else {
            throw CocoaError(.fileReadNoSuchFile)
        }
        return try Data(contentsOf: url)
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
final class ItemRunSubmissionAcknowledgmentNotificationGate {
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

@MainActor
enum ItemRunSubmissionDebugFixtureFactory {
    static func make(
        configuration: LaunchConfiguration,
        draftStore: any CaptureDraftStoring
    ) -> ItemRunSubmissionHost? {
        guard configuration.usesZeroNetworkFixtures else {
            return nil
        }

        switch configuration.submissionFixture {
        case .acceptedPresentationGated:
            guard let acknowledgmentNotification =
                    configuration.submissionAcknowledgmentNotification else {
                return nil
            }
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
        case .delayed:
            return ItemRunSubmissionHost(
                delayedFixture: DelayedItemRunSubmissionFixture()
            )
        case .rateLimited:
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
        case nil:
            return nil
        }
    }
}
#endif
