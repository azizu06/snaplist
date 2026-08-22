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
        ("DualSense controller", "FirstValueController", .full),
        ("AirPods Max", "FirstValueHeadphones", .full),
        ("Charizard card", "FirstValueTradingCard", .full),
        ("DualSense controller, second one", "FirstValueController", .detailTrailing),
        ("AirPods Max, second pair", "FirstValueHeadphones", .detailLeading),
        ("Charizard card, second copy", "FirstValueTradingCard", .detailTop),
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
        // RUN-02. #963 retired the dedicated run-status route in favor of
        // opening the shared Processing surface directly, which reads its rows
        // from `TrophyWallStore` rather than from `RunDetailStore`. The card's
        // identity and stage mirror `DurableRun.loadedDetail` so the two
        // fixtures describe the same run.
        if configuration.visualState == .runDetail {
            return TrophyWallStore(
                principalScope: principalScope,
                repository: TrophyWallInitialRepository(
                    cards: [
                        .accepted(
                            principalScope: principalScope,
                            runID: UUID(
                                uuidString: "20800000-0000-4000-8000-000000000020"
                            )!,
                            state: .workingPricing,
                            itemName: "Canon AE-1 film camera",
                            lastMeaningfulUpdateAt: fixtureNewestUpdate
                        ),
                    ]
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
    /// Fixed, so a capture of this wall is the same image every time. These
    /// dates were seconds either side of the Unix epoch while they were only an
    /// ordering key; the tiles now show them, and a wall of "Dec 31" is not a
    /// wall anyone would recognise (#897). Order is unchanged: still newest
    /// first, one step per tile.
    private static let fixtureNewestUpdate = Date(
        timeIntervalSince1970: 1_753_015_200
    )
    private static let fixtureUpdateStride: TimeInterval = 60 * 60 * 24

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
                lastMeaningfulUpdateAt: fixtureNewestUpdate.addingTimeInterval(
                    -fixtureUpdateStride * Double(index)
                )
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
