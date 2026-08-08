import Foundation
import Observation

// MARK: - Trophy Wall domain

/// The approved wall is a two-column, photo-first grid of 4:5 tiles at a
/// 12-point gutter and a 12-point corner radius. The numbers live here rather
/// than as literals inside the view so the layout contract can be asserted as a
/// value instead of measured in pixels through XCUITest, where a passing frame
/// only proves what the current device happened to lay out.
enum TrophyWallGridMetrics {
    static let columnCount = 2
    static let tileAspectRatio: CGFloat = 4.0 / 5.0
    static let gutterPoints: CGFloat = 12
    static let tileCornerRadiusPoints: CGFloat = 12
    static let bottomPaddingPoints: CGFloat = 132
}

/// The approved empty wall uses a small optical overlap below Scout so the
/// visible artwork, rather than the transparent bounds of the asset, owns the
/// twenty-point gap to the heading.
enum TrophyWallEmptyMetrics {
    static let contentSpacing: CGFloat = 20
    static let scoutHeight: CGFloat = 150
    static let scoutOpticalBottomInset: CGFloat = -17
    static let horizontalPadding: CGFloat = 34
    static let bottomPadding: CGFloat = 104
}

/// Presentation-only framing for a cleared bundled fixture photo. It does not
/// alter the run identity or claim a different underlying product.
enum TrophyWallPhotoCrop: String, Hashable, Sendable {
    case full
    case detailLeading
    case detailTrailing
    case detailTop
}

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

    var logicalIdentity: TrophyWallLogicalIdentity? {
        guard case .local(let logicalIdentity) = self else {
            return nil
        }
        return logicalIdentity
    }
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
    fileprivate let coverPhotoAssetName: String?
    fileprivate let coverPhotoCrop: TrophyWallPhotoCrop
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
            coverPhotoAssetName: nil,
            coverPhotoCrop: .full,
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
        coverPhotoAssetName: String? = nil,
        coverPhotoCrop: TrophyWallPhotoCrop = .full,
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
            coverPhotoAssetName: coverPhotoAssetName,
            coverPhotoCrop: coverPhotoCrop,
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
            guard case .local(let logicalIdentity) = card.identity else {
                return nil
            }
            // The destination names this exact local item so recovery can refuse
            // an intake that is no longer the one behind the card.
            destination = .localRecovery(logicalIdentity)
            accessibilityIdentifier =
                "trophy.processing.row.local."
                + logicalIdentity.persistedKey.lowercased()
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
    let coverPhotoAssetName: String?
    let coverPhotoCrop: TrophyWallPhotoCrop
    let historyOrderAt: Date

    init(
        id: TrophyWallCardIdentity,
        itemName: String,
        stateLabel: String,
        coverPhotoURL: URL? = nil,
        coverPhotoAssetName: String? = nil,
        coverPhotoCrop: TrophyWallPhotoCrop = .full,
        historyOrderAt: Date
    ) {
        self.id = id
        self.itemName = itemName
        self.stateLabel = stateLabel
        self.coverPhotoURL = coverPhotoURL
        self.coverPhotoAssetName = coverPhotoAssetName
        self.coverPhotoCrop = coverPhotoCrop
        self.historyOrderAt = historyOrderAt
    }

    var accessibilityLabel: String {
        let identity = coverPhotoURL == nil && coverPhotoAssetName == nil
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

/// How far the client has got through recovering a refused collection refresh
/// on its own initiative. A boundary that answers badly does not heal the way
/// connectivity does, so SnapList retries a bounded number of times before it
/// says anything; one bad answer is not yet a seller-facing failure.
enum TrophyWallCollectionRefreshRecovery: Equatable, Sendable {
    /// Nothing is refused, or a later refresh proved the collection again.
    case idle
    /// A refusal is outstanding and automatic attempts still remain.
    case recovering
    /// The automatic attempts are spent, so the seller may now be told.
    case exhausted
}

/// The bounded automatic-recovery schedule for a refused collection refresh.
/// It is deliberately short: the seller is looking at cached rows the whole
/// time, and a longer silence would be a worse lie than an honest notice.
enum TrophyWallCollectionRecoveryPolicy {
    static let maximumAutomaticAttempts = 3

    /// The wait before the given 1-based attempt. Attempt 1 is the original
    /// request and never waits, so only attempts 2 and up have a backoff.
    static func backoff(beforeAttempt attempt: Int) -> Duration {
        precondition(attempt >= 2)
        return .milliseconds(500 << (attempt - 2))
    }
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
    private(set) var collectionRefreshRecovery: TrophyWallCollectionRefreshRecovery = .idle
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
                coverPhotoAssetName: card.coverPhotoAssetName,
                coverPhotoCrop: card.coverPhotoCrop,
                historyOrderAt: card.orderKey.lastMeaningfulUpdateAt
            )
        }
    }

    init(
        principalScope: TrophyWallPrincipalScope,
        repository: any TrophyWallRepository
    ) {
        let initialCards = repository.initialCards(for: principalScope)
            .filter { $0.principalScope == principalScope }
            .sorted { $0.orderKey > $1.orderKey }
        self.principalScope = principalScope
        cards = initialCards
        canonicalHistoryStates = initialCards.reduce(into: [:]) { states, card in
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
    ///
    /// Returns whether this call actually reached the boundary. A dropped
    /// overlap issued no request, so `recoverCollection` must not spend one of
    /// its bounded attempts on it.
    @discardableResult
    func refreshCollection(
        using repository: any TrophyWallRunHistoryRepository
    ) async -> Bool {
        guard !isRefreshingCollection else {
            return false
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

            // A superseded generation still spent a real request at the
            // boundary; it only lost the right to publish its answer.
            guard collectionRequestGeneration == requestGeneration else {
                return true
            }
            for page in pages {
                ingest(historyPage: page, principalScope: principalScope)
            }
            collectionOutcome = .loaded
            collectionRefreshRecovery = .idle
        } catch {
            guard collectionRequestGeneration == requestGeneration else {
                return true
            }
            collectionOutcome = Self.outcome(forFailure: error)
            // A refusal only ever opens recovery here. Exhaustion is claimed by
            // `recoverCollection`, which is the only thing that knows how many
            // attempts have actually been spent.
            if collectionOutcome != .unavailable {
                collectionRefreshRecovery = .idle
            } else if collectionRefreshRecovery != .exhausted {
                // Re-entering the wall during a persistent outage must not
                // reopen recovery: that would pull the notice the seller has
                // already been shown for the length of another backoff.
                collectionRefreshRecovery = .recovering
            }
        }
        return true
    }

    /// Refreshes the collection and, when the boundary refuses the answer,
    /// keeps trying on the client's own initiative. Only once the bounded
    /// attempts are spent may the wall carry a refresh-unavailable notice, so
    /// the seller is never interrupted by a failure SnapList could fix itself.
    ///
    /// Cancellation leaves recovery open rather than claiming exhaustion: a
    /// seller who navigated away has not been told anything.
    func recoverCollection(
        using repository: any TrophyWallRunHistoryRepository,
        waiting: @MainActor (Duration) async -> Void = {
            try? await Task.sleep(for: $0)
        }
    ) async {
        // An attempt only counts once it has actually reached the boundary. A
        // dropped overlap issued no request, so it may neither spend one of the
        // bounded attempts nor let this run claim the attempts were exhausted:
        // the refresh that owns the flag is still working on the same answer.
        guard await refreshCollection(using: repository) else {
            return
        }

        var attempt = 1
        while collectionOutcome == .unavailable,
              attempt < TrophyWallCollectionRecoveryPolicy.maximumAutomaticAttempts {
            attempt += 1
            await waiting(
                TrophyWallCollectionRecoveryPolicy.backoff(beforeAttempt: attempt)
            )
            guard !Task.isCancelled else {
                return
            }
            guard await refreshCollection(using: repository) else {
                return
            }
        }

        // Cancellation during the final attempt leaves recovery open for the
        // same reason it does mid-loop: a seller who navigated away has not
        // been told anything, so nothing may be claimed on their behalf.
        guard !Task.isCancelled else {
            return
        }

        if collectionOutcome == .unavailable {
            collectionRefreshRecovery = .exhausted
        }
    }

    /// A local pending card is only truthful while the intake behind it is still
    /// staged and recoverable. Once the client proves it is not, the card leaves
    /// the wall instead of sitting there pointing at an item that is gone.
    func withdrawLocalPendingCards(
        keeping recoverableIdentity: TrophyWallLogicalIdentity?
    ) {
        cards.removeAll { card in
            guard let logicalIdentity = card.identity.logicalIdentity else {
                return false
            }
            return logicalIdentity != recoverableIdentity
        }
    }

    func resetForPrincipalTransition() {
        collectionRequestGeneration += 1
        isRefreshingCollection = false
        cards = []
        canonicalHistoryStates = [:]
        runIDsByListingID = [:]
        collectionOutcome = .unknown
        collectionRefreshRecovery = .idle
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
