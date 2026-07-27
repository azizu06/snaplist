import Foundation

enum HomeSellerState: Hashable, Sendable {
    case active
    case newSeller
}

struct HomeSummary: Hashable, Sendable {
    let active: Int
    let drafts: Int
    let orders: Int?
}

enum HomeAttentionDestination: Hashable, Sendable {
    case order(UUID)
    case conversation(UUID)
    case publishIssue(UUID)
    case draft(UUID)
}

enum HomeAttentionKind: Hashable, Sendable {
    case shipping
    case message
    case offer
    case warning
    case pricing
}

struct HomeAttentionTask: Identifiable, Hashable, Sendable {
    let id: UUID
    let itemTitle: String
    let kind: HomeAttentionKind
    let status: String
    let detail: String
    let actionLabel: String
    let destination: HomeAttentionDestination
}

struct HomeCurrentRun: Identifiable, Hashable, Sendable {
    let id: UUID
    let itemTitle: String
    let stageLabel: String
    let reassurance: String
    let progress: Double?
}

struct HomeFinishItem: Identifiable, Hashable, Sendable {
    let id: UUID
    let title: String
    let detail: String
}

enum HomeListingLifecycle: String, CaseIterable, Hashable, Sendable {
    case active
    case draft
    case sold
    case needsAttention
    case resolvedConversation
}

struct HomeListing: Identifiable, Hashable, Sendable {
    let id: UUID
    let title: String
    let lifecycle: HomeListingLifecycle
    let statusLabel: String
    let detail: String
    let price: String?
    let destination: HomeAttentionDestination?

    init(
        id: UUID,
        title: String,
        lifecycle: HomeListingLifecycle,
        statusLabel: String,
        detail: String,
        price: String?,
        destination: HomeAttentionDestination? = nil
    ) {
        self.id = id
        self.title = title
        self.lifecycle = lifecycle
        self.statusLabel = statusLabel
        self.detail = detail
        self.price = price
        self.destination = destination
    }

    var route: HomeRoute {
        destination?.route ?? .listing(id)
    }
}

enum HomeFilter: String, CaseIterable, Identifiable, Hashable, Sendable {
    case all
    case active
    case drafts
    case sold
    case needsAttention

    var id: String { rawValue }

    var title: String {
        switch self {
        case .all: "All"
        case .active: "Active"
        case .drafts: "Drafts"
        case .sold: "Sold"
        case .needsAttention: "Needs attention"
        }
    }

    fileprivate func includes(_ listing: HomeListing) -> Bool {
        switch self {
        case .all: true
        case .active: listing.lifecycle == .active
        case .drafts: listing.lifecycle == .draft
        case .sold: listing.lifecycle == .sold
        case .needsAttention: listing.lifecycle == .needsAttention
        }
    }
}

struct HomeModel: Hashable, Sendable {
    let revision: Int
    let sellerState: HomeSellerState
    let unreadNotificationCount: Int
    let summary: HomeSummary
    let attention: [HomeAttentionTask]
    let currentRun: HomeCurrentRun?
    let readyToFinish: [HomeFinishItem]
    let listings: [HomeListing]
    let recentSearches: [String]

    var recentListings: [HomeListing] {
        Array(listings.prefix(2))
    }

    init(
        revision: Int,
        sellerState: HomeSellerState = .active,
        unreadNotificationCount: Int,
        summary: HomeSummary,
        attention: [HomeAttentionTask],
        currentRun: HomeCurrentRun?,
        readyToFinish: [HomeFinishItem],
        listings: [HomeListing],
        recentSearches: [String] = []
    ) {
        self.revision = revision
        self.sellerState = sellerState
        self.unreadNotificationCount = max(0, unreadNotificationCount)
        self.summary = summary
        self.attention = attention
        self.currentRun = currentRun
        self.readyToFinish = readyToFinish
        self.listings = listings
        self.recentSearches = recentSearches
    }

    func listings(matching query: String, filter: HomeFilter) -> [HomeListing] {
        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return listings.filter { listing in
            filter.includes(listing)
                && (normalizedQuery.isEmpty
                    || listing.title.localizedCaseInsensitiveContains(normalizedQuery))
        }
    }
}

// MARK: - Trophy Wall domain

struct TrophyWallPrincipalScope: Hashable, Sendable {
    private let opaqueValue: String

    init(opaqueValue: String) {
        precondition(!opaqueValue.isEmpty)
        self.opaqueValue = opaqueValue
    }
}

struct TrophyWallLogicalIdentity: Hashable, Sendable {
    fileprivate let idempotencyKey: UUID

    init(idempotencyKey: UUID) {
        self.idempotencyKey = idempotencyKey
    }
}

enum TrophyWallCardIdentity: Hashable, Sendable {
    case local(TrophyWallLogicalIdentity)
    case run(UUID)
}

enum TrophyWallCardState: Hashable, Sendable {
    case pendingUpload
    case accepted
}

struct TrophyWallOrderKey: Hashable, Comparable, Sendable {
    let lastMeaningfulUpdateAt: Date
    private let stableIdentity: UUID

    fileprivate init(lastMeaningfulUpdateAt: Date, stableIdentity: UUID) {
        self.lastMeaningfulUpdateAt = lastMeaningfulUpdateAt
        self.stableIdentity = stableIdentity
    }

    static func < (lhs: TrophyWallOrderKey, rhs: TrophyWallOrderKey) -> Bool {
        if lhs.lastMeaningfulUpdateAt != rhs.lastMeaningfulUpdateAt {
            return lhs.lastMeaningfulUpdateAt < rhs.lastMeaningfulUpdateAt
        }
        return lhs.stableIdentity.uuidString < rhs.stableIdentity.uuidString
    }
}

struct TrophyWallCard: Hashable, Sendable {
    let principalScope: TrophyWallPrincipalScope
    let identity: TrophyWallCardIdentity
    let state: TrophyWallCardState
    let orderKey: TrophyWallOrderKey

    static func pending(
        principalScope: TrophyWallPrincipalScope,
        logicalIdentity: TrophyWallLogicalIdentity,
        lastMeaningfulUpdateAt: Date
    ) -> TrophyWallCard {
        TrophyWallCard(
            principalScope: principalScope,
            identity: .local(logicalIdentity),
            state: .pendingUpload,
            orderKey: TrophyWallOrderKey(
                lastMeaningfulUpdateAt: lastMeaningfulUpdateAt,
                stableIdentity: logicalIdentity.idempotencyKey
            )
        )
    }

    static func accepted(
        principalScope: TrophyWallPrincipalScope,
        runID: UUID,
        lastMeaningfulUpdateAt: Date
    ) -> TrophyWallCard {
        TrophyWallCard(
            principalScope: principalScope,
            identity: .run(runID),
            state: .accepted,
            orderKey: TrophyWallOrderKey(
                lastMeaningfulUpdateAt: lastMeaningfulUpdateAt,
                stableIdentity: runID
            )
        )
    }
}

struct TrophyWallCanonicalAcceptedRun: Hashable, Sendable {
    let principalScope: TrophyWallPrincipalScope
    let runID: UUID
    let linkedLogicalIdentity: TrophyWallLogicalIdentity?
    let lastMeaningfulUpdateAt: Date
}

protocol TrophyWallRepository: Sendable {
    func initialCards(for principalScope: TrophyWallPrincipalScope) -> [TrophyWallCard]
}

@MainActor
final class TrophyWallStore {
    let principalScope: TrophyWallPrincipalScope
    private(set) var cards: [TrophyWallCard]

    init(
        principalScope: TrophyWallPrincipalScope,
        repository: any TrophyWallRepository
    ) {
        self.principalScope = principalScope
        cards = repository.initialCards(for: principalScope)
            .filter { $0.principalScope == principalScope }
            .sorted { $0.orderKey > $1.orderKey }
    }

    func ingest(_ acceptedRun: TrophyWallCanonicalAcceptedRun) {
        guard acceptedRun.principalScope == principalScope else {
            return
        }

        if let linkedLogicalIdentity = acceptedRun.linkedLogicalIdentity {
            cards.removeAll {
                $0.identity == .local(linkedLogicalIdentity)
            }
        }

        let canonicalCard = TrophyWallCard.accepted(
            principalScope: principalScope,
            runID: acceptedRun.runID,
            lastMeaningfulUpdateAt: acceptedRun.lastMeaningfulUpdateAt
        )
        cards.removeAll { $0.identity == canonicalCard.identity }
        cards.append(canonicalCard)
        cards.sort { $0.orderKey > $1.orderKey }
    }
}
