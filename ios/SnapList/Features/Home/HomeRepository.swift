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

protocol HomeAuthenticationProviding: Sendable {
    /// Returns a fresh opaque Clerk bearer. Authentication integrations own
    /// refresh and storage; Home never persists or inspects the credential.
    func bearerToken() async throws -> String
}

enum HomeRepositoryFactory {
    static func make(
        configuration: LaunchConfiguration,
        apiOrigin: URL? = defaultAPIOrigin,
        authentication: any HomeAuthenticationProviding,
        session: URLSession = .shared
    ) -> any HomeRepository {
#if DEBUG
        if configuration.usesZeroNetworkFixtures {
            return HomeFixtureRepository(
                model: HomeFixtures.model(for: configuration.visualState)
            )
        }
#endif
        guard let apiOrigin else {
            return UnavailableHomeRepository()
        }
        return AuthenticatedServerHomeRepository(
            apiOrigin: apiOrigin,
            authentication: authentication,
            session: session
        )
    }

    static var defaultAPIOrigin: URL? {
        resolveAPIOrigin(
            environment: ProcessInfo.processInfo.environment,
            bundleValue: Bundle.main.object(forInfoDictionaryKey: "SnapListAPIOrigin") as? String,
            allowsLocalDevelopment: allowsLocalDevelopment
        )
    }

    static func resolveAPIOrigin(
        environment: [String: String],
        bundleValue: String?,
        allowsLocalDevelopment: Bool
    ) -> URL? {
        let environmentValue = environment["SNAPLIST_API_ORIGIN"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let bundleValue = bundleValue?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let rawValue = [environmentValue, bundleValue]
            .compactMap({ $0 })
            .first(where: { !$0.isEmpty }),
              let components = URLComponents(string: rawValue),
              let scheme = components.scheme?.lowercased(),
              let host = components.host?.lowercased(),
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil,
              components.path.isEmpty || components.path == "/",
              let url = components.url else {
            return nil
        }
        if scheme == "https" {
            return url
        }
        let localHosts = ["localhost", "127.0.0.1", "::1"]
        guard allowsLocalDevelopment, scheme == "http", localHosts.contains(host) else {
            return nil
        }
        return url
    }

    private static var allowsLocalDevelopment: Bool {
#if DEBUG
        true
#else
        false
#endif
    }
}

enum HomeRepositoryError: Error, Equatable {
    case operationUnavailable
    case invalidResponse
    case httpStatus(Int)
}

private struct AuthenticatedServerHomeRepository: HomeRepository {
    let apiOrigin: URL
    let authentication: any HomeAuthenticationProviding
    let session: URLSession

    func fetchHome() async throws -> HomeModel {
        let token = try await authentication.bearerToken()
        var request = URLRequest(url: apiOrigin.appending(path: "/v1/home"))
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else {
            throw HomeRepositoryError.invalidResponse
        }
        guard (200..<300).contains(response.statusCode) else {
            if response.statusCode == 404 {
                throw HomeRepositoryError.operationUnavailable
            }
            throw HomeRepositoryError.httpStatus(response.statusCode)
        }
        do {
            return try JSONDecoder().decode(HomeEnvelope.self, from: data).data.model
        } catch {
            throw HomeRepositoryError.invalidResponse
        }
    }

    func updates() async -> AsyncThrowingStream<HomeModel, Error> {
        // #161's HTTP projection is the durable fallback. Realtime transport is
        // intentionally injected later; a completed stream asks HomeStore to
        // refresh this same authenticated server record with bounded backoff.
        AsyncThrowingStream { continuation in
            continuation.finish()
        }
    }
}

private struct HomeEnvelope: Decodable {
    let data: HomeProjectionPayload
}

private struct HomeProjectionPayload: Decodable {
    let revision: Int
    let sellerState: SellerState
    let unreadNotificationCount: Int
    let summary: Summary
    let attention: [Attention]
    let currentRun: CurrentRun?
    let readyToFinish: [FinishItem]
    let listings: [Listing]
    let recentSearches: [String]

    enum SellerState: String, Decodable {
        case active
        case newSeller
    }

    struct Summary: Decodable {
        let active: Int
        let drafts: Int
        let orders: Int?
    }

    struct Destination: Decodable {
        enum Kind: String, Decodable {
            case order
            case conversation
            case publishIssue
            case draft
        }

        let kind: Kind
        let id: UUID

        var domain: HomeAttentionDestination {
            switch kind {
            case .order: .order(id)
            case .conversation: .conversation(id)
            case .publishIssue: .publishIssue(id)
            case .draft: .draft(id)
            }
        }
    }

    struct Attention: Decodable {
        enum Kind: String, Decodable {
            case shipping
            case message
            case offer
            case warning
            case pricing

            var domain: HomeAttentionKind {
                switch self {
                case .shipping: .shipping
                case .message: .message
                case .offer: .offer
                case .warning: .warning
                case .pricing: .pricing
                }
            }
        }

        let id: UUID
        let itemTitle: String
        let kind: Kind
        let status: String
        let detail: String
        let actionLabel: String
        let destination: Destination
    }

    struct CurrentRun: Decodable {
        let id: UUID
        let itemTitle: String
        let stageLabel: String
        let reassurance: String
        let progress: Double?
    }

    struct FinishItem: Decodable {
        let id: UUID
        let title: String
        let detail: String
    }

    struct Listing: Decodable {
        enum Lifecycle: String, Decodable {
            case active
            case draft
            case sold
            case needsAttention
            case resolvedConversation

            var domain: HomeListingLifecycle {
                switch self {
                case .active: .active
                case .draft: .draft
                case .sold: .sold
                case .needsAttention: .needsAttention
                case .resolvedConversation: .resolvedConversation
                }
            }
        }

        let id: UUID
        let title: String
        let lifecycle: Lifecycle
        let statusLabel: String
        let detail: String
        let price: String?
        let destination: Destination?

        private enum CodingKeys: String, CodingKey {
            case id, title, lifecycle, statusLabel, detail, price, destination
        }

        init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            guard container.contains(.destination) else {
                throw DecodingError.keyNotFound(
                    CodingKeys.destination,
                    .init(
                        codingPath: decoder.codingPath,
                        debugDescription: "Home listing destination must be present, even when null."
                    )
                )
            }
            id = try container.decode(UUID.self, forKey: .id)
            title = try container.decode(String.self, forKey: .title)
            lifecycle = try container.decode(Lifecycle.self, forKey: .lifecycle)
            statusLabel = try container.decode(String.self, forKey: .statusLabel)
            detail = try container.decode(String.self, forKey: .detail)
            price = try container.decodeIfPresent(String.self, forKey: .price)
            destination = try container.decodeIfPresent(Destination.self, forKey: .destination)
        }
    }

    var model: HomeModel {
        HomeModel(
            revision: revision,
            sellerState: sellerState == .active ? .active : .newSeller,
            unreadNotificationCount: unreadNotificationCount,
            summary: HomeSummary(
                active: summary.active,
                drafts: summary.drafts,
                orders: summary.orders
            ),
            attention: attention.map {
                HomeAttentionTask(
                    id: $0.id,
                    itemTitle: $0.itemTitle,
                    kind: $0.kind.domain,
                    status: $0.status,
                    detail: $0.detail,
                    actionLabel: $0.actionLabel,
                    destination: $0.destination.domain
                )
            },
            currentRun: currentRun.map {
                HomeCurrentRun(
                    id: $0.id,
                    itemTitle: $0.itemTitle,
                    stageLabel: $0.stageLabel,
                    reassurance: $0.reassurance,
                    progress: $0.progress
                )
            },
            readyToFinish: readyToFinish.map {
                HomeFinishItem(id: $0.id, title: $0.title, detail: $0.detail)
            },
            listings: listings.map {
                HomeListing(
                    id: $0.id,
                    title: $0.title,
                    lifecycle: $0.lifecycle.domain,
                    statusLabel: $0.statusLabel,
                    detail: $0.detail,
                    price: $0.price,
                    destination: $0.destination?.domain
                )
            },
            recentSearches: recentSearches
        )
    }
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
