import Foundation
import Observation

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
    case readyToReview
    case readyToReviewLocked
    case needsRetryLocked(detail: String)
    case publishedToEbay
    case exportPrepared
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
    fileprivate let coverPhotoURL: URL?
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
            coverPhotoURL: nil,
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
        coverPhotoURL: URL? = nil,
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
            coverPhotoURL: coverPhotoURL,
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
            destination = .localRecovery
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
             .workingPersisting,
             .readyToReview,
             .readyToReviewLocked,
             .needsRetryLocked,
             .publishedToEbay,
             .exportPrepared:
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
            case .readyToReview:
                stateLabel = "Ready to review"
                accessibilityLabel = "\(itemName), ready to review."
            case .readyToReviewLocked:
                stateLabel = "Ready to review"
                accessibilityLabel =
                    "\(itemName), ready to review. Review is not available yet."
            case .needsRetryLocked(let detail):
                stateLabel = "Needs retry · \(detail)"
                accessibilityLabel = "\(itemName), needs retry. \(detail)"
            case .pendingUpload, .publishedToEbay, .exportPrepared:
                return nil
            }
        }
    }
}

struct TrophyWallSettledTile: Identifiable, Hashable {
    let id: TrophyWallCardIdentity
    let itemName: String
    let stateLabel: String
    let coverPhotoURL: URL?
    let historyOrderAt: Date

    init(
        id: TrophyWallCardIdentity,
        itemName: String,
        stateLabel: String,
        coverPhotoURL: URL? = nil,
        historyOrderAt: Date
    ) {
        self.id = id
        self.itemName = itemName
        self.stateLabel = stateLabel
        self.coverPhotoURL = coverPhotoURL
        self.historyOrderAt = historyOrderAt
    }

    var accessibilityLabel: String {
        let identity = coverPhotoURL == nil
            ? "\(itemName), photo unavailable"
            : itemName
        let relevantDate = historyOrderAt.formatted(
            .dateTime.month(.wide).day()
        )
        return "\(identity), \(stateLabel), \(relevantDate). "
            + "Completed item in your collection."
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
    let listingID: UUID?
    let coverPhotoURL: URL?

    init(
        principalScope: TrophyWallPrincipalScope,
        runID: UUID,
        linkedLogicalIdentity: TrophyWallLogicalIdentity?,
        state: TrophyWallCardState = .accepted,
        lastMeaningfulUpdateAt: Date,
        historyOrderKey: TrophyWallOrderKey? = nil,
        itemName: String? = nil,
        listingID: UUID? = nil,
        coverPhotoURL: URL? = nil
    ) {
        self.principalScope = principalScope
        self.runID = runID
        self.linkedLogicalIdentity = linkedLogicalIdentity
        self.state = state
        self.lastMeaningfulUpdateAt = lastMeaningfulUpdateAt
        self.historyOrderKey = historyOrderKey
        self.itemName = itemName
        self.listingID = listingID
        self.coverPhotoURL = coverPhotoURL
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

/// What the client actually knows about the tenant's server-side collection.
/// Trophy Wall may only describe a collection it has proved, so an unproved
/// collection stays `unknown` and renders nothing rather than an empty success.
enum TrophyWallCollectionOutcome: Equatable, Sendable {
    /// No collection request has completed yet.
    case unknown
    /// A collection page arrived, so an absent card is proved absence.
    case loaded
    /// The request never reached the boundary; saved cards are all we know.
    case offline
    /// The boundary refused the request; saved cards are all we know.
    case unavailable
}

@MainActor
@Observable
final class TrophyWallStore {
    private enum CanonicalHistoryState {
        case visible(TrophyWallOrderKey)
        case tombstone(TrophyWallOrderKey)

        var orderKey: TrophyWallOrderKey {
            switch self {
            case .visible(let orderKey), .tombstone(let orderKey):
                orderKey
            }
        }
    }

    static let collectionPageLimit = 20

    let principalScope: TrophyWallPrincipalScope
    private(set) var cards: [TrophyWallCard]
    private(set) var collectionOutcome: TrophyWallCollectionOutcome = .unknown
    private var canonicalHistoryStates: [UUID: CanonicalHistoryState]
    private var runIDsByListingID: [UUID: UUID]
    private var isRefreshingCollection = false
    private var collectionRequestGeneration = 0

    var processingRows: [TrophyWallProcessingRow] {
        cards.compactMap(TrophyWallProcessingRow.init(card:))
    }

    var settledTiles: [TrophyWallSettledTile] {
        cards.compactMap { card in
            guard let itemName = card.itemName else {
                return nil
            }
            let stateLabel: String
            switch card.state {
            case .publishedToEbay:
                stateLabel = "Published to eBay"
            case .exportPrepared:
                stateLabel = "Export prepared"
            default:
                return nil
            }
            return TrophyWallSettledTile(
                id: card.identity,
                itemName: itemName,
                stateLabel: stateLabel,
                coverPhotoURL: card.coverPhotoURL,
                historyOrderAt: card.orderKey.lastMeaningfulUpdateAt
            )
        }
    }

    init(
        principalScope: TrophyWallPrincipalScope,
        repository: any TrophyWallRepository
    ) {
        self.principalScope = principalScope
        cards = repository.initialCards(for: principalScope)
            .filter { $0.principalScope == principalScope }
            .sorted { $0.orderKey > $1.orderKey }
        canonicalHistoryStates = cards.reduce(into: [:]) { states, card in
            guard case .run(let runID) = card.identity else {
                return
            }
            if let existingState = states[runID],
               existingState.orderKey >= card.orderKey {
                return
            }
            states[runID] = .visible(card.orderKey)
        }
        runIDsByListingID = [:]
    }

    /// Re-requests the tenant's collection page from the existing boundary. A
    /// failure never mutates, drops, or invents a card: it only downgrades what
    /// the client is allowed to claim about the collection.
    ///
    /// Overlapping refreshes are dropped rather than queued, so a slow failure
    /// can never land after, and downgrade, a newer success.
    func refreshCollection(using repository: any TrophyWallRunHistoryRepository) async {
        guard !isRefreshingCollection else {
            return
        }
        isRefreshingCollection = true
        collectionRequestGeneration += 1
        let requestGeneration = collectionRequestGeneration
        defer {
            if collectionRequestGeneration == requestGeneration {
                isRefreshingCollection = false
            }
        }

        do {
            var pages: [TrophyWallRunHistoryPage] = []
            var cursor: String?
            var seenCursors: Set<String> = []
            repeat {
                let page = try await repository.fetchPage(
                    limit: Self.collectionPageLimit,
                    cursor: cursor
                )
                pages.append(page)
                cursor = page.nextCursor
                if let cursor, !seenCursors.insert(cursor).inserted {
                    throw TrophyWallCollectionError.repeatedCursor
                }
            } while cursor != nil

            guard collectionRequestGeneration == requestGeneration else {
                return
            }
            for page in pages {
                ingest(historyPage: page, principalScope: principalScope)
            }
            collectionOutcome = .loaded
        } catch {
            guard collectionRequestGeneration == requestGeneration else {
                return
            }
            collectionOutcome = Self.outcome(forFailure: error)
        }
    }

    func resetForPrincipalTransition() {
        collectionRequestGeneration += 1
        isRefreshingCollection = false
        cards = []
        canonicalHistoryStates = [:]
        runIDsByListingID = [:]
        collectionOutcome = .unknown
    }

    /// A server that answered badly is not the same as a device that could not
    /// reach one, so only genuine reachability codes may claim `offline`. Every
    /// other failure — timeout, TLS, DNS, HTTP status, decode — is `unavailable`.
    private static func outcome(
        forFailure error: any Error
    ) -> TrophyWallCollectionOutcome {
        guard let urlError = error as? URLError else {
            return .unavailable
        }

        switch urlError.code {
        case .notConnectedToInternet,
             .networkConnectionLost,
             .dataNotAllowed,
             .internationalRoamingOff,
             .callIsActive:
            return .offline
        default:
            return .unavailable
        }
    }

    func ingest(_ acceptedRun: TrophyWallCanonicalAcceptedRun) {
        guard acceptedRun.principalScope == principalScope else {
            return
        }
        if let historyOrderKey = acceptedRun.historyOrderKey {
            if let currentState = canonicalHistoryStates[acceptedRun.runID],
               historyOrderKey < currentState.orderKey {
                return
            }
            if let currentState = canonicalHistoryStates[acceptedRun.runID],
               historyOrderKey == currentState.orderKey,
               cards.first(where: {
                   $0.identity == .run(acceptedRun.runID)
               })?.state == acceptedRun.state {
                return
            }
            canonicalHistoryStates[acceptedRun.runID] = .visible(historyOrderKey)
        } else if canonicalHistoryStates[acceptedRun.runID] != nil {
            return
        }

        let linkedItemName = acceptedRun.linkedLogicalIdentity.flatMap {
            linkedLogicalIdentity in
            cards.first {
                $0.identity == .local(linkedLogicalIdentity)
            }?.itemName
        }
        let existingCanonicalCard = cards.first {
            $0.identity == .run(acceptedRun.runID)
        }

        if let linkedLogicalIdentity = acceptedRun.linkedLogicalIdentity {
            cards.removeAll {
                $0.identity == .local(linkedLogicalIdentity)
            }
        }

        let canonicalCard = TrophyWallCard.accepted(
            principalScope: principalScope,
            runID: acceptedRun.runID,
            state: Self.preferredState(
                current: existingCanonicalCard?.state,
                incoming: acceptedRun.state
            ),
            itemName: linkedItemName ?? existingCanonicalCard?.itemName ?? acceptedRun.itemName,
            coverPhotoURL: acceptedRun.coverPhotoURL
                ?? existingCanonicalCard?.coverPhotoURL,
            lastMeaningfulUpdateAt: acceptedRun.lastMeaningfulUpdateAt,
            orderKey: acceptedRun.historyOrderKey
        )
        cards.removeAll { $0.identity == canonicalCard.identity }
        cards.append(canonicalCard)
        cards.sort { $0.orderKey > $1.orderKey }
        if let listingID = acceptedRun.listingID {
            runIDsByListingID[listingID] = acceptedRun.runID
        }
    }

    func ingest(_ localCard: TrophyWallCard) {
        guard localCard.principalScope == principalScope,
              case .local = localCard.identity,
              localCard.state == .pendingUpload else {
            return
        }
        cards.removeAll { $0.identity == localCard.identity }
        cards.append(localCard)
        cards.sort { $0.orderKey > $1.orderKey }
    }

    func applyEbayPublishStatus(_ status: EbayPublishStatus) {
        guard status.isConfirmedPublication,
              let runID = runIDsByListingID[status.listingID],
              let index = cards.firstIndex(where: { $0.identity == .run(runID) })
        else {
            return
        }

        let card = cards[index]
        cards[index] = TrophyWallCard.accepted(
            principalScope: card.principalScope,
            runID: runID,
            state: .publishedToEbay,
            itemName: card.itemName,
            coverPhotoURL: card.coverPhotoURL,
            lastMeaningfulUpdateAt: card.orderKey.lastMeaningfulUpdateAt,
            orderKey: card.orderKey
        )
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
                  let lastMeaningfulUpdateAt = TrophyWallServerDate.parse(
                      runDetail.lastMeaningfulUpdateAt
                  ) else {
                continue
            }
            if let listingID = runDetail.listingID {
                runIDsByListingID[listingID] = runDetail.id
            }
            if let currentState = canonicalHistoryStates[runDetail.id],
               entry.orderKey < currentState.orderKey {
                continue
            }
            guard let state = Self.cardState(for: runDetail) else {
                guard Self.isExplicitRetryCleanup(runDetail) else {
                    continue
                }
                canonicalHistoryStates[runDetail.id] = .tombstone(entry.orderKey)
                cards.removeAll { $0.identity == .run(runDetail.id) }
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
                    itemName: runDetail.item?.title,
                    listingID: runDetail.listingID,
                    coverPhotoURL: runDetail.delivery?.coverPhotoURL
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
                itemName: runDetail.item?.title,
                listingID: runDetail.listingID,
                coverPhotoURL: runDetail.delivery?.coverPhotoURL
            )
        )
    }

    private static func isExplicitRetryCleanup(_ runDetail: DurableRun) -> Bool {
        guard runDetail.status == .failed,
              runDetail.terminalOutcome == .failed,
              runDetail.retentionCleanedAt != nil,
              let safeFailure = runDetail.safeFailure else {
            return false
        }
        return !safeFailure.retryable
            && !safeFailure.workPreserved
            && !runDetail.legalActions.canRetry
            && !runDetail.legalActions.canCancel
            && !runDetail.legalActions.canOpenReview
    }

    private static func cardState(for runDetail: DurableRun) -> TrophyWallCardState? {
        if runDetail.delivery?.state == .publishedToEbay {
            return .publishedToEbay
        }
        if runDetail.delivery?.state == .exportPrepared {
            return .exportPrepared
        }
        switch (runDetail.status, runDetail.stage) {
        case (.queued, .queued):
            return .accepted
        case (.running, .identifying), (.retrying, .identifying):
            return .workingIdentifying
        case (.running, .generating), (.retrying, .generating):
            return .workingGenerating
        case (.running, .pricing), (.retrying, .pricing):
            return .workingPricing
        case (.running, .persisting), (.retrying, .persisting):
            return .workingPersisting
        case (.succeeded, .completed)
            where runDetail.terminalOutcome == .succeeded
                && runDetail.listingID != nil
                && runDetail.legalActions.canOpenReview:
            return .readyToReview
        case (.succeeded, .completed)
            where runDetail.terminalOutcome == .succeeded
                && runDetail.listingID != nil
                && !runDetail.legalActions.canOpenReview:
            return .readyToReviewLocked
        case (.failed, _)
            where runDetail.terminalOutcome == .failed
                && runDetail.safeFailure?.retryable == true
                && runDetail.safeFailure?.workPreserved == true
                && runDetail.legalActions.canRetry
                && !runDetail.legalActions.canCancel
                && !runDetail.legalActions.canOpenReview:
            guard let safeFailure = runDetail.safeFailure else { return nil }
            return .needsRetryLocked(detail: safeFailure.detail)
        default:
            return nil
        }
    }

    private static func preferredState(
        current: TrophyWallCardState?,
        incoming: TrophyWallCardState
    ) -> TrophyWallCardState {
        if current == .publishedToEbay || incoming == .publishedToEbay {
            return .publishedToEbay
        }
        return incoming
    }

}

private enum TrophyWallCollectionError: Error {
    case repeatedCursor
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
