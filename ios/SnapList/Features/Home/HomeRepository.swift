import Foundation
import Observation

protocol HomeRepository: Sendable {
    /// Returns one tenant-scoped projection of durable pipeline, notification,
    /// listing, and order truth from the server.
    func fetchHome() async throws -> HomeModel

    /// Delivers tenant-scoped Realtime projections. A terminated stream is a
    /// signal to refresh the existing server record, never to create a run.
    func updates() async -> AsyncThrowingStream<HomeModel, Error>
}

enum HomeRepositoryFactory {
    static func make(configuration: LaunchConfiguration) -> any HomeRepository {
#if DEBUG
        if configuration.usesZeroNetworkFixtures {
            return HomeFixtureRepository(
                model: HomeFixtures.model(for: configuration.visualState)
            )
        }
#endif
        return UnavailableHomeRepository()
    }
}

enum HomeRepositoryError: Error, Equatable {
    case operationUnavailable
}

struct UnavailableHomeRepository: HomeRepository {
    func fetchHome() async throws -> HomeModel {
        throw HomeRepositoryError.operationUnavailable
    }

    func updates() async -> AsyncThrowingStream<HomeModel, Error> {
        AsyncThrowingStream { continuation in
            continuation.finish(throwing: HomeRepositoryError.operationUnavailable)
        }
    }
}

enum HomeLoadFailure: Equatable {
    case operationUnavailable
    case offline
    case temporarilyUnavailable
}

enum HomeLoadState: Equatable {
    case idle
    case loading
    case loaded
    case failed(HomeLoadFailure)
}

enum HomeFreshness: Equatable {
    case connecting
    case realtime
    case serverRefresh
    case unavailable
}

struct HomeRealtimeReconnectPolicy: Equatable, Sendable {
    let initialDelayNanoseconds: UInt64
    let maximumDelayNanoseconds: UInt64

    static let production = HomeRealtimeReconnectPolicy(
        initialDelayNanoseconds: 1_000_000_000,
        maximumDelayNanoseconds: 30_000_000_000
    )

    init(initialDelayNanoseconds: UInt64, maximumDelayNanoseconds: UInt64) {
        let boundedInitialDelay = max(1, initialDelayNanoseconds)
        self.initialDelayNanoseconds = boundedInitialDelay
        self.maximumDelayNanoseconds = max(boundedInitialDelay, maximumDelayNanoseconds)
    }

    func delay(afterFailureCount failureCount: Int) -> UInt64 {
        let exponent = min(max(failureCount - 1, 0), 10)
        let multiplier = UInt64(1 << exponent)
        let product = initialDelayNanoseconds.multipliedReportingOverflow(by: multiplier)
        return min(maximumDelayNanoseconds, product.overflow ? maximumDelayNanoseconds : product.partialValue)
    }
}

@MainActor
@Observable
final class HomeStore {
    private(set) var model: HomeModel?
    private(set) var loadState: HomeLoadState = .idle
    private(set) var freshness: HomeFreshness = .connecting
    private(set) var isRefreshing = false

    @ObservationIgnored private let repository: any HomeRepository
    @ObservationIgnored private let reconnectPolicy: HomeRealtimeReconnectPolicy
    @ObservationIgnored private let sleep: @Sendable (UInt64) async throws -> Void
    @ObservationIgnored private var updateTask: Task<Void, Never>?

    init(
        repository: any HomeRepository,
        reconnectPolicy: HomeRealtimeReconnectPolicy = .production,
        sleep: @escaping @Sendable (UInt64) async throws -> Void = {
            try await Task.sleep(nanoseconds: $0)
        }
    ) {
        self.repository = repository
        self.reconnectPolicy = reconnectPolicy
        self.sleep = sleep
    }

    func load() async {
        guard loadState == .idle else { return }
        loadState = .loading

        do {
            apply(try await repository.fetchHome())
            loadState = .loaded
            freshness = .connecting
            startUpdates()
        } catch {
            let failure = Self.failure(for: error)
            loadState = .failed(failure)
            freshness = failure == .operationUnavailable ? .unavailable : .serverRefresh
        }
    }

    func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }

        do {
            apply(try await repository.fetchHome())
            loadState = .loaded
            if freshness != .realtime {
                freshness = .serverRefresh
            }
        } catch {
            if model == nil {
                let failure = Self.failure(for: error)
                loadState = .failed(failure)
                freshness = failure == .operationUnavailable ? .unavailable : .serverRefresh
            } else {
                freshness = .serverRefresh
            }
        }
    }

    func stopUpdates() {
        updateTask?.cancel()
        updateTask = nil
    }

    func suspendUpdates() {
        stopUpdates()
    }

    func resumeUpdates() {
        guard model != nil, loadState == .loaded, updateTask == nil else { return }
        startUpdates()
    }

    private func startUpdates() {
        stopUpdates()
        updateTask = Task { [weak self] in
            await self?.consumeUpdates()
        }
    }

    private func consumeUpdates() async {
        var consecutiveFailures = 0

        while !Task.isCancelled {
            let stream = await repository.updates()
            do {
                for try await update in stream {
                    guard !Task.isCancelled else { return }
                    consecutiveFailures = 0
                    apply(update)
                    freshness = .realtime
                }
            } catch {
                guard !Task.isCancelled else { return }
            }

            guard !Task.isCancelled else { return }
            freshness = .serverRefresh
            await refresh()
            guard !Task.isCancelled else { return }

            consecutiveFailures += 1
            let delay = reconnectPolicy.delay(afterFailureCount: consecutiveFailures)
            do {
                try await sleep(delay)
            } catch {
                return
            }
        }
    }

    private func apply(_ update: HomeModel) {
        guard update.revision >= (model?.revision ?? Int.min) else { return }
        model = update
    }

    private static func failure(for error: any Error) -> HomeLoadFailure {
        if error as? HomeRepositoryError == .operationUnavailable {
            return .operationUnavailable
        }
        if error is URLError {
            return .offline
        }
        return .temporarilyUnavailable
    }
}
