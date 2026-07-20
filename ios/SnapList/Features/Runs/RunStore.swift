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
