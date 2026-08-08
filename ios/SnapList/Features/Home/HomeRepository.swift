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
#if DEBUG
    /// The live canvas's Adobe Stock subjects are proof-only. HOME-01 therefore
    /// uses six distinct full/detail compositions of the three cleared bundled
    /// seller-product photos; crop is presentation metadata on six distinct runs.
    static let fixturePhotoCompositions: [(
        itemName: String,
        assetName: String,
        crop: TrophyWallPhotoCrop
    )] = [
        ("White leather sneaker", "FirstValueSneaker", .full),
        ("Vintage denim jacket", "FirstValueJacket", .full),
        ("White desk lamp", "FirstValueLamp", .full),
        ("White leather sneaker, second pair", "FirstValueSneaker", .detailTrailing),
        ("Vintage denim jacket, second item", "FirstValueJacket", .detailLeading),
        ("White desk lamp, second item", "FirstValueLamp", .detailTop),
    ]
#endif

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
        fixturePhotoCompositions.enumerated().map { index, photo in
            .accepted(
                principalScope: principalScope,
                runID: UUID(
                    uuidString: String(
                        format: "37500000-0000-4000-8000-%012d",
                        21 + index
                    )
                )!,
                state: index.isMultiple(of: 2) ? .publishedToEbay : .exportPrepared,
                itemName: photo.itemName,
                coverPhotoAssetName: photo.assetName,
                coverPhotoCrop: photo.crop,
                lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 40 - Double(index * 2))
            )
        }
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
