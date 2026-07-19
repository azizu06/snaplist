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
}

struct HomeListing: Identifiable, Hashable, Sendable {
    let id: UUID
    let title: String
    let lifecycle: HomeListingLifecycle
    let statusLabel: String
    let detail: String
    let price: String?
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
