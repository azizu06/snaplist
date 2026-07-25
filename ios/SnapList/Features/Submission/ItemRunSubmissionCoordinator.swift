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
    private(set) var retention: ItemRunSubmissionRetention?

    private let coordinator: ItemRunSubmissionCoordinator?

    init(coordinator: ItemRunSubmissionCoordinator?) {
        self.coordinator = coordinator
    }

    /// One tap, one submission. A second tap while a request is open would build a
    /// second attempt from the same photos and could buy the seller a second run.
    func startListing(photos: [StagedCapturePhoto]) async {
        guard !isSubmitting, let coordinator else {
            return
        }
        isSubmitting = true
        defer { isSubmitting = false }

        switch await coordinator.submit(photos: photos) {
        case .accepted(let acceptance):
            retention = nil
            acceptedRun = acceptance.run
        case .retained(let retention):
            acceptedRun = nil
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
        // Fixture launches render approved states without a server, so they get no
        // submission path at all rather than a stubbed acceptance.
        guard !configuration.usesZeroNetworkFixtures, let apiOrigin else {
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
        let intake: ItemRunSubmissionSnapshot.Result
        do {
            intake = try ItemRunSubmissionSnapshot.make(for: photos, readData: readData)
        } catch {
            return .retained(.intakeUnavailable)
        }
        let snapshot = intake.photos

        // A stored attempt for these exact photos is the same logical submission, so it
        // keeps its key. Retrying under a new key would ask the server to create a
        // second run and spend a second AI-item credit for one item.
        let storedAttempt = try? await attemptStore.loadAttempt()
        let attempt: ItemRunSubmissionAttempt
        if let storedAttempt, storedAttempt.photos == snapshot {
            attempt = storedAttempt
        } else {
            attempt = ItemRunSubmissionAttempt(
                idempotencyKey: newIdempotencyKey(),
                photos: snapshot
            )
        }
        do {
            try await attemptStore.saveAttempt(attempt)
        } catch {
            return .retained(.attemptNotPersisted)
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
            try? await attemptStore.clearAttempt(attempt)
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
