#if DEBUG
import Foundation
import SwiftUI

enum EbayPublishFixtureData {
    static let listingTitle =
        "Medium wash denim trucker jacket, size M"
}

/// Fixed context carried by the DEBUG-only eBay v5 fixture adapter.
///
/// `principalID` names the deterministic signed-in persona; production identity
/// enforcement remains in the production bearer-token adapter. This fixture
/// rejects foreign listing IDs and stale revisions at the same feature seam.
struct EbayPublishFixtureAuthority: Equatable, Sendable {
    let principalID: String
    let listingID: UUID
    let reviewRevision: UUID
}

/// Zero-network eBay adapter for the four approved v5 projections.
///
/// This deliberately conforms to `EbayPublishFeatureServing` instead of
/// teaching the view about fixture states. The real flow store remains the sole
/// state projector, and every provider-shaped action stays behind its adapter.
actor EbayPublishFixtureAdapter: EbayPublishFeatureServing {
    let authority: EbayPublishFixtureAuthority
    let fixture: EbayPublishFixtureState

    init(
        authority: EbayPublishFixtureAuthority,
        fixture: EbayPublishFixtureState
    ) {
        self.authority = authority
        self.fixture = fixture
    }

    func createOAuthSession(
        idempotencyKey: UUID
    ) throws -> EbayOAuthSession {
        EbayOAuthSession(
            sessionID: UUID(
                uuidString: "74200000-0000-4000-8000-000000000004"
            )!,
            authorizationURL: URL(
                string: "https://signin.ebay.example/fixture"
            )!,
            expiresAt: Date(timeIntervalSince1970: 1_800_000_000)
        )
    }

    func connection() -> EbayConnectionStatus {
        connectionStatus
    }

    func disconnect() -> EbayConnectionStatus {
        EbayConnectionStatus(connected: false, ebayUsername: nil)
    }

    func preflight(listingID: UUID) throws -> EbayPublishPreflight {
        try requireOwned(listingID)
        return EbayPublishPreflight(
            listingID: authority.listingID,
            title: EbayPublishFixtureData.listingTitle,
            description: "A medium wash denim trucker jacket in good used condition. Clean seams and hardware. Review the photos for the exact wear shown.",
            effectivePrice: .init(amount: 58, label: "Seller price"),
            photoCount: 4,
            marketplace: "EBAY_US",
            ebayCondition: "USED_GOOD",
            itemSpecifics: [
                "Brand": ["Levi’s"],
                "Size": ["M"],
                "Color": ["Blue"],
            ],
            reviewRevision: authority.reviewRevision,
            connection: connectionStatus,
            publishEligibility: .init(enabled: true, eligible: true)
        )
    }

    func status(listingID: UUID) throws -> EbayPublishStatus {
        try requireOwned(listingID)
        switch fixture {
        case .published:
            return EbayPublishStatus(
                listingID: authority.listingID,
                outcome: .published,
                ebayListingID: "742000000001",
                ebayOfferID: "742-OFFER-1",
                alreadyPublished: true,
                listingURL: URL(
                    string: "https://www.ebay.com/itm/742000000001"
                ),
                environment: .production
            )
        case .outcomeUnknown:
            return EbayPublishStatus(
                listingID: authority.listingID,
                outcome: .outcomeNotYetKnown,
                ebayListingID: nil,
                ebayOfferID: nil,
                alreadyPublished: false
            )
        case .notConnected, .confirmation:
            return EbayPublishStatus(
                listingID: authority.listingID,
                outcome: .notPublished,
                ebayListingID: nil,
                ebayOfferID: nil,
                alreadyPublished: false
            )
        }
    }

    func publish(
        listingID: UUID,
        expectedReviewRevision: UUID,
        idempotencyKey: UUID
    ) throws -> EbayPublishTransportOutcome {
        try requireOwned(listingID)
        guard expectedReviewRevision == authority.reviewRevision else {
            return .staleRevision
        }
        switch fixture {
        case .published:
            return .published(
                EbayPublishedListing(
                    ebayListingID: "742000000001",
                    listingURL: URL(
                        string: "https://www.ebay.com/itm/742000000001"
                    )!
                )
            )
        case .outcomeUnknown:
            return .outcomeNotYetKnown
        case .notConnected, .confirmation:
            return .failed
        }
    }

    private var connectionStatus: EbayConnectionStatus {
        switch fixture {
        case .notConnected:
            EbayConnectionStatus(connected: false, ebayUsername: nil)
        case .confirmation, .published, .outcomeUnknown:
            EbayConnectionStatus(connected: true, ebayUsername: "azizu")
        }
    }

    private func requireOwned(_ listingID: UUID) throws {
        guard listingID == authority.listingID else {
            throw EbayPublishClientError.invalidResponse
        }
    }
}

@MainActor
final class EbayPublishFixtureOAuthRunner: EbayOAuthRunning,
    @unchecked Sendable {
    func authenticate(_ session: EbayOAuthSession) async -> EbayOAuthResult {
        .connected
    }

    func cancel() {}
}

/// DEBUG-only host for the four eBay v5 delivery states.
///
/// The fixed signed-in persona, listing, and in-memory attempt store make every
/// launch deterministic. In particular, the unknown fixture has no durable
/// client attempt to replay, so the real store stays honestly terminal while
/// server reconciliation remains authoritative outside this fixture.
@MainActor
struct EbayPublishFixtureHostView: View {
    private static let authority = EbayPublishFixtureAuthority(
        principalID: "user_742_signed_in_fixture",
        listingID: UUID(
            uuidString: "74200000-0000-4000-8000-000000000001"
        )!,
        reviewRevision: UUID(
            uuidString: "74200000-0000-4000-8000-000000000002"
        )!
    )

    let fixture: EbayPublishFixtureState
    let forceReducedMotion: Bool
    @State private var store: EbayPublishFlowStore

    init(
        fixture: EbayPublishFixtureState,
        forceReducedMotion: Bool
    ) {
        self.fixture = fixture
        self.forceReducedMotion = forceReducedMotion
        let adapter = EbayPublishFixtureAdapter(
            authority: Self.authority,
            fixture: fixture
        )
        _store = State(
            initialValue: EbayPublishFlowStore(
                listingID: Self.authority.listingID,
                service: adapter,
                oauth: EbayPublishFixtureOAuthRunner(),
                attemptStore: MemoryEbayPublishAttemptStore()
            )
        )
    }

    var body: some View {
        NavigationStack {
            EbayPublishView(
                store: store,
                forceReducedMotion: forceReducedMotion,
                listingTitle: EbayPublishFixtureData.listingTitle,
                resultThumbnailSource: .approvedFixtureAsset(
                    "FirstValueJacket"
                ),
                backToListing: {},
                goToTrophyWall: {}
            )
        }
        .environment(\.openURL, OpenURLAction { _ in .discarded })
    }
}
#endif
