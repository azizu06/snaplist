import Foundation
import Observation

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

    private let coordinator: ItemRunSubmissionCoordinator?
    /// Fixture launches render approved states with no server behind them, so Start
    /// listing is inert by design there rather than unavailable.
    private let isInert: Bool

    init(coordinator: ItemRunSubmissionCoordinator?, isInert: Bool = false) {
        self.coordinator = coordinator
        self.isInert = isInert
    }

    /// One tap, one submission. A second tap while a request is open would build a
    /// second attempt from the same photos and could buy the seller a second run.
    func startListing(photos: [StagedCapturePhoto]) async {
        guard !isSubmitting, !isInert else {
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
        isSubmitting = true
        defer { isSubmitting = false }

        switch await coordinator.submit(photos: photos) {
        case .accepted(let acceptance):
            retention = nil
            acceptedRun = acceptance.run
            clearedIntake = acceptance.clearedIntake
        case .retained(let retention):
            acceptedRun = nil
            clearedIntake = false
            self.retention = retention
        }
    }
}

@MainActor
enum ItemRunSubmissionHostFactory {
    static func make(
        configuration: LaunchConfiguration,
        apiOrigin: URL?,
        authentication: any HomeAuthenticationProviding,
        session: URLSession,
        draftStore: any CaptureDraftStoring
    ) -> ItemRunSubmissionHost {
        guard !configuration.usesZeroNetworkFixtures else {
            return ItemRunSubmissionHost(coordinator: nil, isInert: true)
        }
        guard let apiOrigin else {
            return ItemRunSubmissionHost(coordinator: nil)
        }
        return ItemRunSubmissionHost(
            coordinator: ItemRunSubmissionCoordinator(
                submitter: ItemRunSubmissionClient(
                    baseURL: apiOrigin,
                    session: session
                ),
                attemptStore: LocalItemRunSubmissionAttemptStore(),
                draftStore: draftStore,
                bearerToken: { try await authentication.bearerToken() }
            )
        )
    }
}

/// Turns the seller's ordered Photo Review intake into one canonical durable run.
@MainActor
final class ItemRunSubmissionCoordinator {
    private let submitter: any ItemRunSubmitting
    private let attemptStore: any ItemRunSubmissionAttemptStoring
    private let draftStore: any CaptureDraftStoring
    private let bearerToken: @Sendable () async throws -> String
    private let readData: @Sendable (URL) throws -> Data
    private let newIdempotencyKey: @Sendable () -> UUID

    init(
        submitter: any ItemRunSubmitting,
        attemptStore: any ItemRunSubmissionAttemptStoring,
        draftStore: any CaptureDraftStoring,
        bearerToken: @escaping @Sendable () async throws -> String,
        readData: @escaping @Sendable (URL) throws -> Data = {
            try Data(contentsOf: $0)
        },
        newIdempotencyKey: @escaping @Sendable () -> UUID = { UUID() }
    ) {
        self.submitter = submitter
        self.attemptStore = attemptStore
        self.draftStore = draftStore
        self.bearerToken = bearerToken
        self.readData = readData
        self.newIdempotencyKey = newIdempotencyKey
    }

    func submit(photos: [StagedCapturePhoto]) async -> ItemRunSubmissionOutcome {
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

        let token: String
        do {
            token = try await bearerToken()
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
            let clearedIntake = (try? await draftStore.discardExactly(photos)) ?? false
            // The key is only retired once the photos it stands for are gone. If they
            // survived, the seller can still submit these exact bytes, and keeping the
            // key makes that an idempotent replay of the run the server already made
            // rather than a second run on a second AI-item credit.
            if clearedIntake {
                try? await attemptStore.clearAttempt(attempt)
            }
            return .accepted(
                ItemRunAcceptance(
                    run: AcceptedItemRun(
                        runID: receipt.runId,
                        itemID: receipt.itemId,
                        status: receipt.status,
                        stage: receipt.stage
                    ),
                    clearedIntake: clearedIntake
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
}
