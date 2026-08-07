import Foundation
import Observation

protocol TrophyWallRunHistoryRepository: Sendable {
    func fetchPage(limit: Int, cursor: String?) async throws -> TrophyWallRunHistoryPage
}

struct AuthenticatedTrophyWallRunHistoryRepository: TrophyWallRunHistoryRepository {
    let service: any TrophyWallRunHistoryServing
    let tokenProvider: any BearerTokenProviding

    func fetchPage(limit: Int, cursor: String?) async throws -> TrophyWallRunHistoryPage {
        let bearerToken = try await tokenProvider.bearerToken()
        return try await service.fetchRunHistoryPage(
            limit: limit,
            cursor: cursor,
            bearerToken: bearerToken
        )
    }
}

struct UnavailableTrophyWallRunHistoryRepository: TrophyWallRunHistoryRepository {
    func fetchPage(limit: Int, cursor: String?) async throws -> TrophyWallRunHistoryPage {
        throw HomeRepositoryError.operationUnavailable
    }
}

#if DEBUG
private struct FixtureTrophyWallRunHistoryRepository: TrophyWallRunHistoryRepository {
    func fetchPage(limit: Int, cursor: String?) async throws -> TrophyWallRunHistoryPage {
        TrophyWallRunHistoryPage(entries: [], nextCursor: nil)
    }
}
#endif

enum TrophyWallRunHistoryRepositoryFactory {
    static func make(
        configuration: LaunchConfiguration,
        apiOrigin: URL?,
        tokenProvider: any BearerTokenProviding,
        session: URLSession
    ) -> any TrophyWallRunHistoryRepository {
#if DEBUG
        if configuration.usesZeroNetworkFixtures {
            return FixtureTrophyWallRunHistoryRepository()
        }
#endif
        guard let apiOrigin else {
            return UnavailableTrophyWallRunHistoryRepository()
        }
        return AuthenticatedTrophyWallRunHistoryRepository(
            service: RunAPIClient(baseURL: apiOrigin, session: session),
            tokenProvider: tokenProvider
        )
    }
}

private struct TrophyWallInitialRepository: TrophyWallRepository {
    let cards: [TrophyWallCard]

    func initialCards(for principalScope: TrophyWallPrincipalScope) -> [TrophyWallCard] {
        cards.filter { $0.principalScope == principalScope }
    }
}

@MainActor
enum TrophyWallStoreFactory {
    static func make(
        configuration: LaunchConfiguration,
        principalScope: TrophyWallPrincipalScope
    ) -> TrophyWallStore {
#if DEBUG
        // HOME-01 is the settled wall and HOME-02 is the empty wall, so only the
        // first one gets seed cards. Both reach `.loaded` through the zero-network
        // history repository.
        if configuration.fixture == .trophyWall
            || configuration.visualState == .trophyWallSettled {
            return TrophyWallStore(
                principalScope: principalScope,
                repository: TrophyWallInitialRepository(
                    cards: fixtureCards(principalScope: principalScope)
                )
            )
        }
#endif
        return TrophyWallStore(
            principalScope: principalScope,
            repository: TrophyWallInitialRepository(cards: [])
        )
    }

#if DEBUG
    /// A settled wall taller than any supported viewport. The count is load
    /// bearing: the grid's dock-sized bottom padding can only be proved by a
    /// last tile that starts below the fold, and the two-column gutter only
    /// shows in a capture across several rows.
    private static func fixtureCards(
        principalScope: TrophyWallPrincipalScope
    ) -> [TrophyWallCard] {
        [
            .accepted(
                principalScope: principalScope,
                runID: UUID(uuidString: "37500000-0000-4000-8000-000000000021")!,
                state: .publishedToEbay,
                itemName: "Vintage Pyrex bowl set",
                lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 40)
            ),
            .accepted(
                principalScope: principalScope,
                runID: UUID(uuidString: "37500000-0000-4000-8000-000000000022")!,
                state: .exportPrepared,
                itemName: "Canon AE-1 film camera",
                lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 38)
            ),
            .accepted(
                principalScope: principalScope,
                runID: UUID(uuidString: "37500000-0000-4000-8000-000000000023")!,
                state: .workingPricing,
                itemName: "Nintendo Game Boy",
                lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 36)
            ),
            .accepted(
                principalScope: principalScope,
                runID: UUID(uuidString: "37500000-0000-4000-8000-000000000024")!,
                state: .publishedToEbay,
                itemName: "Sony WH-1000XM4 headphones",
                lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 34)
            ),
            .accepted(
                principalScope: principalScope,
                runID: UUID(uuidString: "37500000-0000-4000-8000-000000000025")!,
                state: .exportPrepared,
                itemName: "Catan board game",
                lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 32)
            ),
            .accepted(
                principalScope: principalScope,
                runID: UUID(uuidString: "37500000-0000-4000-8000-000000000026")!,
                state: .publishedToEbay,
                itemName: "Levi's 501 denim jacket",
                lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 30)
            ),
            .accepted(
                principalScope: principalScope,
                runID: UUID(uuidString: "37500000-0000-4000-8000-000000000027")!,
                state: .exportPrepared,
                itemName: "KitchenAid stand mixer",
                lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 28)
            ),
            .accepted(
                principalScope: principalScope,
                runID: UUID(uuidString: "37500000-0000-4000-8000-000000000028")!,
                state: .publishedToEbay,
                itemName: "Nikon 50mm f/1.8 lens",
                lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 26)
            ),
            .accepted(
                principalScope: principalScope,
                runID: UUID(uuidString: "37500000-0000-4000-8000-000000000029")!,
                state: .exportPrepared,
                itemName: "Le Creuset dutch oven",
                lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 24)
            ),
            .accepted(
                principalScope: principalScope,
                runID: UUID(uuidString: "37500000-0000-4000-8000-00000000002a")!,
                state: .publishedToEbay,
                itemName: "Technics SL-1200 turntable",
                lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 22)
            ),
            .accepted(
                principalScope: principalScope,
                runID: UUID(uuidString: "37500000-0000-4000-8000-00000000002b")!,
                state: .exportPrepared,
                itemName: "Patagonia fleece pullover",
                lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 20)
            ),
            .accepted(
                principalScope: principalScope,
                runID: UUID(uuidString: "37500000-0000-4000-8000-00000000002c")!,
                state: .publishedToEbay,
                itemName: "Herman Miller desk chair",
                lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 18)
            ),
            .accepted(
                principalScope: principalScope,
                runID: UUID(uuidString: "37500000-0000-4000-8000-00000000002d")!,
                state: .exportPrepared,
                itemName: "Craftsman socket set",
                lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 16)
            ),
        ]
    }
#endif
}

/// Resolves the app's API origin. The seller-operations repository this type
/// used to build is gone with the rest of that surface; the name stays because
/// `ClerkAuthentication`, `MobileAPIClient`, and `SnapListApp` resolve their
/// origin through it, and renaming it here would edit files this issue does not
/// own.
enum HomeRepositoryFactory {
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
