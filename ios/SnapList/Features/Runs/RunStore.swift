import Foundation
import Observation

enum RunDetailLoadState: Equatable, Sendable {
    case idle
    case loading
    case loaded(DurableRun)
    case unavailable
}

@MainActor
@Observable
final class RunDetailStore {
    private(set) var state: RunDetailLoadState = .idle

    private let service: any RunServing
    private let bearerToken: @Sendable () async throws -> String
    private var requestedRunID: UUID?
    private var requestGeneration = 0

    init(
        service: any RunServing,
        bearerToken: @escaping @Sendable () async throws -> String
    ) {
        self.service = service
        self.bearerToken = bearerToken
    }

    func load(runID: UUID) async {
        requestedRunID = runID
        await startFetch(runID: runID)
    }

    func refresh() async {
        guard let requestedRunID else { return }
        await startFetch(runID: requestedRunID)
    }

    private func startFetch(runID: UUID) async {
        requestGeneration += 1
        let generation = requestGeneration
        state = .loading
        do {
            let token = try await bearerToken()
            let run = try await service.fetchRun(id: runID, bearerToken: token)
            guard generation == requestGeneration, requestedRunID == runID else { return }
            guard run.id == runID else { throw RunAPIError.invalidResponse }
            state = .loaded(run)
        } catch is CancellationError {
            guard generation == requestGeneration else { return }
            state = .idle
        } catch {
            guard generation == requestGeneration else { return }
            state = .unavailable
        }
    }
}

@MainActor
enum RunDetailStoreFactory {
    static func make(
        configuration: LaunchConfiguration,
        apiOrigin: URL?,
        authentication: any HomeAuthenticationProviding,
        session: URLSession
    ) -> RunDetailStore {
#if DEBUG
        if configuration.usesZeroNetworkFixtures {
            let service: any RunServing = switch configuration.runDetailFixture {
            case .loaded:
                FixtureRunService(runs: [.loadedDetail])
            case .refresh:
                FixtureRunService(runs: [.loadedDetail, .refreshedDetail])
            case .unavailable, .none:
                UnavailableRunService()
            }
            return RunDetailStore(
                service: service,
                bearerToken: { "fixture-bearer" }
            )
        }
#endif
        let service: any RunServing = apiOrigin.map {
            RunAPIClient(baseURL: $0, session: session)
        } ?? UnavailableRunService()
        return RunDetailStore(
            service: service,
            bearerToken: { try await authentication.bearerToken() }
        )
    }
}

#if DEBUG
private actor FixtureRunService: RunServing {
    private var runs: [DurableRun]

    init(runs: [DurableRun]) {
        self.runs = runs
    }

    func fetchRun(id: UUID, bearerToken: String) async throws -> DurableRun {
        guard let run = runs.first else { throw RunAPIError.unavailable }
        guard id == run.id else { throw RunAPIError.unavailable }
        if runs.count > 1 {
            runs.removeFirst()
        }
        return run
    }
}

private extension DurableRun {
    static let loadedDetail = fixture(stage: .pricing)
    static let refreshedDetail = fixture(stage: .generating)

    static func fixture(stage: DurableRunStage) -> DurableRun {
        DurableRun(
            id: UUID(uuidString: "20800000-0000-4000-8000-000000000020")!,
            itemID: UUID(uuidString: "20800000-0000-4000-8000-000000000021")!,
            listingID: nil,
            status: .running,
            stage: stage,
            attemptCount: 1,
            maxAttempts: 3,
            schemaVersion: 1,
            timestamps: RunTimestamps(
                createdAt: "2026-07-20T12:00:00.000Z",
                updatedAt: "2026-07-20T12:01:00.000Z",
                enqueuedAt: "2026-07-20T12:00:01.000Z",
                startedAt: "2026-07-20T12:00:02.000Z",
                lastAttemptedAt: "2026-07-20T12:00:02.000Z",
                nextAttemptAt: nil,
                completedAt: nil,
                retentionCleanedAt: nil
            ),
            item: RunItemTruth(title: "Canon AE-1 film camera", photoCount: 3),
            requiredInput: nil,
            terminalOutcome: nil,
            safeFailure: nil,
            allowance: .reserved,
            legalActions: RunActionTruth(
                canRetry: false,
                canCancel: false,
                canOpenReview: false,
                canStartNewCapture: false
            ),
            lastMeaningfulUpdateAt: "2026-07-20T12:01:00.000Z",
            retentionCleanedAt: nil
        )
    }
}
#endif
