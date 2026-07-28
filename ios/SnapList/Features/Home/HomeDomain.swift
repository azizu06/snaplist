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
    fileprivate let persistedKey: String

    init(idempotencyKey: UUID) {
        persistedKey = idempotencyKey.uuidString.lowercased()
    }

    init(persistedKey: String) {
        precondition(!persistedKey.isEmpty && persistedKey.count <= 128)
        self.persistedKey = persistedKey
    }
}

enum TrophyWallCardIdentity: Hashable, Sendable {
    case local(TrophyWallLogicalIdentity)
    case run(UUID)
}

enum TrophyWallCardState: Hashable, Sendable {
    case pendingUpload
    case accepted
    case workingIdentifying
    case workingGenerating
    case workingPricing
    case workingPersisting
}

struct TrophyWallOrderKey: Hashable, Comparable, Sendable {
    let lastMeaningfulUpdateAt: Date
    private let stableIdentity: String

    init(lastMeaningfulUpdateAt: Date, stableIdentity: String) {
        self.lastMeaningfulUpdateAt = lastMeaningfulUpdateAt
        self.stableIdentity = stableIdentity
    }

    init?(serverTimestamp: String, runID: UUID) {
        guard let date = TrophyWallServerDate.parse(serverTimestamp) else {
            return nil
        }
        self.init(
            lastMeaningfulUpdateAt: date,
            stableIdentity: runID.uuidString.lowercased()
        )
    }

    fileprivate func matches(runID: UUID) -> Bool {
        stableIdentity == runID.uuidString.lowercased()
    }

    static func < (lhs: TrophyWallOrderKey, rhs: TrophyWallOrderKey) -> Bool {
        if lhs.lastMeaningfulUpdateAt != rhs.lastMeaningfulUpdateAt {
            return lhs.lastMeaningfulUpdateAt < rhs.lastMeaningfulUpdateAt
        }
        return lhs.stableIdentity < rhs.stableIdentity
    }
}

struct TrophyWallCard: Hashable, Sendable {
    let principalScope: TrophyWallPrincipalScope
    let identity: TrophyWallCardIdentity
    let state: TrophyWallCardState
    fileprivate let itemName: String?
    let orderKey: TrophyWallOrderKey

    static func pending(
        principalScope: TrophyWallPrincipalScope,
        logicalIdentity: TrophyWallLogicalIdentity,
        itemName: String,
        lastMeaningfulUpdateAt: Date
    ) -> TrophyWallCard {
        precondition(!itemName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        return TrophyWallCard(
            principalScope: principalScope,
            identity: .local(logicalIdentity),
            state: .pendingUpload,
            itemName: itemName,
            orderKey: TrophyWallOrderKey(
                lastMeaningfulUpdateAt: lastMeaningfulUpdateAt,
                stableIdentity: logicalIdentity.persistedKey
            )
        )
    }

    static func accepted(
        principalScope: TrophyWallPrincipalScope,
        runID: UUID,
        state: TrophyWallCardState = .accepted,
        itemName: String? = nil,
        lastMeaningfulUpdateAt: Date,
        orderKey: TrophyWallOrderKey? = nil
    ) -> TrophyWallCard {
        if let itemName {
            precondition(!itemName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        return TrophyWallCard(
            principalScope: principalScope,
            identity: .run(runID),
            state: state,
            itemName: itemName,
            orderKey: orderKey ?? TrophyWallOrderKey(
                lastMeaningfulUpdateAt: lastMeaningfulUpdateAt,
                stableIdentity: runID.uuidString.lowercased()
            )
        )
    }
}

struct TrophyWallProcessingRow: Identifiable, Hashable {
    let id: TrophyWallCardIdentity
    let itemName: String
    let stateLabel: String
    let destination: HomeRoute?
    let accessibilityLabel: String
    let accessibilityIdentifier: String

    fileprivate init?(card: TrophyWallCard) {
        guard let itemName = card.itemName else {
            return nil
        }

        id = card.identity
        self.itemName = itemName

        switch card.state {
        case .pendingUpload:
            stateLabel = "Pending upload"
            destination = nil
            if case .local(let logicalIdentity) = card.identity {
                accessibilityIdentifier =
                    "trophy.processing.row.local."
                    + logicalIdentity.persistedKey.lowercased()
            } else {
                return nil
            }
            accessibilityLabel =
                "\(itemName), pending upload. Local item, not sent yet."
        case .accepted,
             .workingIdentifying,
             .workingGenerating,
             .workingPricing,
             .workingPersisting:
            if case .run(let runID) = card.identity {
                destination = .run(runID)
                accessibilityIdentifier =
                    "trophy.processing.row.run.\(runID.uuidString.lowercased())"
            } else {
                return nil
            }

            switch card.state {
            case .accepted:
                stateLabel = "Accepted"
                accessibilityLabel = "\(itemName), accepted."
            case .workingIdentifying:
                stateLabel = "Identifying"
                accessibilityLabel = "\(itemName), working, identifying."
            case .workingGenerating:
                stateLabel = "Writing listing"
                accessibilityLabel = "\(itemName), working, writing listing."
            case .workingPricing:
                stateLabel = "Pricing"
                accessibilityLabel = "\(itemName), working, pricing."
            case .workingPersisting:
                stateLabel = "Saving"
                accessibilityLabel = "\(itemName), working, saving."
            case .pendingUpload:
                return nil
            }
        }
    }
}

struct TrophyWallCanonicalAcceptedRun: Hashable, Sendable {
    let principalScope: TrophyWallPrincipalScope
    let runID: UUID
    let linkedLogicalIdentity: TrophyWallLogicalIdentity?
    let state: TrophyWallCardState
    let lastMeaningfulUpdateAt: Date
    let historyOrderKey: TrophyWallOrderKey?
    let itemName: String?

    init(
        principalScope: TrophyWallPrincipalScope,
        runID: UUID,
        linkedLogicalIdentity: TrophyWallLogicalIdentity?,
        state: TrophyWallCardState = .accepted,
        lastMeaningfulUpdateAt: Date,
        historyOrderKey: TrophyWallOrderKey? = nil,
        itemName: String? = nil
    ) {
        self.principalScope = principalScope
        self.runID = runID
        self.linkedLogicalIdentity = linkedLogicalIdentity
        self.state = state
        self.lastMeaningfulUpdateAt = lastMeaningfulUpdateAt
        self.historyOrderKey = historyOrderKey
        self.itemName = itemName
    }
}

struct TrophyWallRunHistoryEntry: Equatable, Sendable {
    let logicalIdentity: TrophyWallLogicalIdentity
    let orderKey: TrophyWallOrderKey
    let run: DurableRun
}

struct TrophyWallRunHistoryPage: Equatable, Sendable {
    let entries: [TrophyWallRunHistoryEntry]
    let nextCursor: String?
}

protocol TrophyWallRepository: Sendable {
    func initialCards(for principalScope: TrophyWallPrincipalScope) -> [TrophyWallCard]
}

@MainActor
final class TrophyWallStore {
    let principalScope: TrophyWallPrincipalScope
    private(set) var cards: [TrophyWallCard]

    var processingRows: [TrophyWallProcessingRow] {
        cards.compactMap(TrophyWallProcessingRow.init(card:))
    }

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

        let linkedItemName = acceptedRun.linkedLogicalIdentity.flatMap {
            linkedLogicalIdentity in
            cards.first {
                $0.identity == .local(linkedLogicalIdentity)
            }?.itemName
        }
        let existingCanonicalItemName = cards.first {
            $0.identity == .run(acceptedRun.runID)
        }?.itemName

        if let linkedLogicalIdentity = acceptedRun.linkedLogicalIdentity {
            cards.removeAll {
                $0.identity == .local(linkedLogicalIdentity)
            }
        }

        let canonicalCard = TrophyWallCard.accepted(
            principalScope: principalScope,
            runID: acceptedRun.runID,
            state: acceptedRun.state,
            itemName: linkedItemName ?? existingCanonicalItemName ?? acceptedRun.itemName,
            lastMeaningfulUpdateAt: acceptedRun.lastMeaningfulUpdateAt,
            orderKey: acceptedRun.historyOrderKey
        )
        cards.removeAll { $0.identity == canonicalCard.identity }
        cards.append(canonicalCard)
        cards.sort { $0.orderKey > $1.orderKey }
    }

    func ingest(
        historyPage: TrophyWallRunHistoryPage,
        principalScope requestedPrincipalScope: TrophyWallPrincipalScope
    ) {
        guard requestedPrincipalScope == principalScope else {
            return
        }

        for entry in historyPage.entries {
            let runDetail = entry.run
            guard entry.orderKey.matches(runID: runDetail.id),
                  let state = Self.cardState(for: runDetail),
                  let lastMeaningfulUpdateAt = TrophyWallServerDate.parse(
                      runDetail.lastMeaningfulUpdateAt
                  ) else {
                continue
            }
            ingest(
                TrophyWallCanonicalAcceptedRun(
                    principalScope: requestedPrincipalScope,
                    runID: runDetail.id,
                    linkedLogicalIdentity: entry.logicalIdentity,
                    state: state,
                    lastMeaningfulUpdateAt: lastMeaningfulUpdateAt,
                    historyOrderKey: entry.orderKey,
                    itemName: runDetail.item?.title
                )
            )
        }
    }

    func ingest(
        acceptedHandoff: AcceptedItemRunHandoff,
        runDetail: DurableRun,
        principalScope requestedPrincipalScope: TrophyWallPrincipalScope
    ) {
        let acceptedRun = acceptedHandoff.acceptedRun
        guard requestedPrincipalScope == principalScope,
              acceptedRun.runID == runDetail.id,
              acceptedRun.itemID == runDetail.itemID,
              let state = Self.cardState(for: runDetail),
              let lastMeaningfulUpdateAt = TrophyWallServerDate.parse(
                  runDetail.lastMeaningfulUpdateAt
              ) else {
            return
        }

        ingest(
            TrophyWallCanonicalAcceptedRun(
                principalScope: requestedPrincipalScope,
                runID: runDetail.id,
                linkedLogicalIdentity: TrophyWallLogicalIdentity(
                    idempotencyKey: acceptedHandoff.idempotencyKey
                ),
                state: state,
                lastMeaningfulUpdateAt: lastMeaningfulUpdateAt,
                itemName: runDetail.item?.title
            )
        )
    }

    private static func cardState(for runDetail: DurableRun) -> TrophyWallCardState? {
        switch (runDetail.status, runDetail.stage) {
        case (.queued, .queued):
            .accepted
        case (.running, .identifying):
            .workingIdentifying
        case (.running, .generating):
            .workingGenerating
        case (.running, .pricing):
            .workingPricing
        case (.running, .persisting):
            .workingPersisting
        default:
            nil
        }
    }

}

private enum TrophyWallServerDate {
    static func parse(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) {
            return date
        }

        let wholeSeconds = ISO8601DateFormatter()
        wholeSeconds.formatOptions = [.withInternetDateTime]
        return wholeSeconds.date(from: value)
    }
}
