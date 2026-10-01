import Foundation

/// The pure assisted-export state machine (issue #581, design authority
/// `Assisted Export + Share Handoff v1`, XPORT-01 through XPORT-05).
///
/// Facebook Marketplace, Mercari, and Depop are assisted destinations. SnapList
/// prepares the text and photos, the seller finishes the form. SnapList cannot
/// observe any of them, so opening the app, dismissing the share sheet, copying
/// the text, and saving the photos all prove nothing. Only the explicit confirm
/// sheet writes `shared`.
///
/// Deliberately Foundation-only, with no SwiftUI or UIKit import, so the whole
/// state machine is exercisable without a simulator.

/// The three destinations, in the order the approved package lists them.
enum AssistedExportDestination: String, CaseIterable, Identifiable, Hashable, Sendable {
    case facebookMarketplace = "facebook"
    case mercari
    case depop

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .facebookMarketplace:
            return "Facebook Marketplace"
        case .mercari:
            return "Mercari"
        case .depop:
            return "Depop"
        }
    }
}

/// What SnapList is willing to say about one destination. Two values, because
/// two is all SnapList can know: it prepared the pack, and the seller may have
/// told it they posted the listing. `published`, `listed`, `sold`, `synced`,
/// and `verified` are not knowable here and so are not representable.
enum AssistedExportHandoffState: Equatable, Sendable {
    case prepared
    case shared(at: Date)
}

/// One prepared pack, identified by the two revisions the server guards on.
struct AssistedExportPack: Equatable, Sendable {
    let itemID: UUID
    /// `source_review_revision`: the content revision the pack text was built at.
    let contentRevision: UUID
    /// The full `review_revision` the seller was looking at when it was built.
    let reviewRevision: UUID
    let title: String
    let description: String
    /// Server-resolved price: valid seller override, else recommendation.
    let effectivePrice: Decimal
    /// Ordered, authenticated photo references supplied by the mobile listing
    /// review projection. The client resolves all of them before offering a
    /// share sheet, so a failed fetch can never become an empty handoff.
    let photoReferences: [URL]

    var photoCount: Int { photoReferences.count }

    func replacingEffectivePrice(_ price: Decimal) -> AssistedExportPack {
        AssistedExportPack(
            itemID: itemID,
            contentRevision: contentRevision,
            reviewRevision: reviewRevision,
            title: title,
            description: description,
            effectivePrice: price,
            photoReferences: photoReferences
        )
    }

    func listingText(for destination: AssistedExportDestination) -> String {
        let price = Self.priceText(effectivePrice)
        switch destination {
        case .facebookMarketplace, .mercari:
            return "\(title)\n\n\(description)\n\nPrice: \(price)"
        case .depop:
            return "\(description)\n\nPrice: \(price)"
        }
    }

    private static func priceText(_ price: Decimal) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        formatter.currencySymbol = "$"
        formatter.minimumFractionDigits = 2
        formatter.maximumFractionDigits = 2
        return formatter.string(from: price as NSDecimalNumber) ?? "$\(price)"
    }
}

/// The durable server read model. `handedOffAt` proves a device handoff was
/// recorded; `sharedAt` exists only after the seller's explicit confirmation.
struct AssistedExportReceipt: Equatable, Sendable {
    let destination: AssistedExportDestination
    let handedOffAt: Date?
    let sharedAt: Date?
}

/// The four ways a seller can hand the pack over. Every one of them touches
/// only this device: the clipboard, the photo library, or another app being
/// brought forward. None of them observes the destination, so none of them is
/// evidence that a listing exists. What they earn is the right to be *asked*.
enum AssistedExportHandoffAction: String, Equatable, CaseIterable, Sendable {
    case openedDestination
    case copiedListingText
    case savedPhotos
    case sharedAnotherWay
}

/// The live states. XPORT-06, 07A, 07B, 08, and 09 are proof-only fixtures in
/// the approved package and are deliberately absent here.
enum AssistedExportState: Equatable, Sendable {
    /// XPORT-01. Pack prepared, no workspace open.
    case destinationList
    /// XPORT-02. One workspace open, before any handoff action.
    case workspaceOpen(AssistedExportDestination)
    /// XPORT-03. The seller performed a handoff action for the open destination.
    case handedOff(AssistedExportDestination)
    /// XPORT-04. The open destination carries the seller's own shared record.
    case shared(AssistedExportDestination)
    /// XPORT-05. The listing moved on, so the pack no longer matches it.
    case packOutOfDate
}

/// What the confirm sheet did. A refusal is never silent: the caller has to see
/// that no receipt exists so it cannot paint `Shared` over a write that never
/// happened.
enum AssistedExportConfirmOutcome: Equatable, Sendable {
    case recorded
    case refused
}

/// The one-step-at-a-time guide inside a destination's sheet (issue #1128).
///
/// The steps are the existing export-pack actions in the order a seller uses
/// them. Nothing here is new domain behavior: the guide only reads which of
/// those actions the seller has already performed on this device.
enum AssistedExportGuideStep: Int, CaseIterable, Sendable {
    case copyText
    case savePhotos
    case openDestination
    case confirmPosted
}

struct AssistedExportGuideProgress: Equatable, Sendable {
    /// The step to show, or nil once the seller has made the Shared claim.
    let current: AssistedExportGuideStep?
    let completed: [AssistedExportGuideStep]

    var total: Int { AssistedExportGuideStep.allCases.count }

    /// One-based position of the current step.
    var position: Int { (current?.rawValue ?? total - 1) + 1 }

    var positionText: String { AssistedExportCopy.stepPosition(position, of: total) }
}

enum AssistedExportGuide {
    static func progress(
        performed: Set<AssistedExportHandoffAction>,
        isShared: Bool
    ) -> AssistedExportGuideProgress {
        let all = AssistedExportGuideStep.allCases
        // Each device step requires its own successful action record. A share
        // sheet handoff enables the seller's claim, but neither that handoff
        // nor the claim proves a clipboard write, photo save, or app open.
        let done: [AssistedExportGuideStep] = all.filter { step in
            switch step {
            case .copyText:
                return performed.contains(.copiedListingText)
            case .savePhotos:
                return performed.contains(.savedPhotos)
            case .openDestination:
                return performed.contains(.openedDestination)
            case .confirmPosted:
                return isShared
            }
        }
        let current = isShared ? nil : all.first { !done.contains($0) }
        return AssistedExportGuideProgress(current: current, completed: done)
    }
}

struct AssistedExportDomain: Equatable, Sendable {
    private(set) var pack: AssistedExportPack
    private(set) var confirmSheet: AssistedExportDestination?
    private(set) var openDestination: AssistedExportDestination?
    private var handedOff: Set<AssistedExportDestination> = []
    /// Which handoff actions the seller performed on this device, per
    /// destination. The server receipt only says a handoff happened, so this is
    /// what lets the guided sheet resume on the step after the last one done.
    private var performed: [AssistedExportDestination: Set<AssistedExportHandoffAction>] = [:]
    private var sharedAt: [AssistedExportDestination: Date] = [:]
    /// The newest listing revision this client knows about. It starts equal to
    /// the revision the pack was built against and moves ahead of it the moment
    /// the listing is edited.
    private var currentReviewRevision: UUID
    /// The destination whose transient `Undo` control is on screen, if any.
    private(set) var undoWindow: AssistedExportDestination?
    /// Destinations whose open attempt visibly did nothing. A transient client
    /// observation, never persisted: the receipt schema deliberately carries no
    /// destination-availability field, because that is not a fact SnapList has.
    private var didNotOpen: Set<AssistedExportDestination> = []

    init(pack: AssistedExportPack) {
        self.pack = pack
        currentReviewRevision = pack.reviewRevision
    }

    /// The pack describes a listing that has since moved on. Mirrors the
    /// `mark_export_shared` guard, which compares the same two revisions.
    var isPackOutOfDate: Bool {
        pack.reviewRevision != currentReviewRevision
    }

    var destinations: [AssistedExportDestination] {
        AssistedExportDestination.allCases
    }

    var state: AssistedExportState {
        if isPackOutOfDate { return .packOutOfDate }
        guard let open = openDestination else { return .destinationList }
        if sharedAt[open] != nil { return .shared(open) }
        if handedOff.contains(open) { return .handedOff(open) }
        return .workspaceOpen(open)
    }

    /// Whether the seller performed a handoff action for this destination. This
    /// is not the shared claim and is never rendered as one.
    func hasHandedOff(to destination: AssistedExportDestination) -> Bool {
        handedOff.contains(destination)
    }

    func handoff(for destination: AssistedExportDestination) -> AssistedExportHandoffState {
        guard let date = sharedAt[destination] else { return .prepared }
        return .shared(at: date)
    }

    /// Restores the three server-backed receipts for this exact pack. Invalid
    /// combinations fail closed to Prepared; the transport rejects malformed
    /// arrays before they reach this seam.
    mutating func synchronize(with receipts: [AssistedExportReceipt]) {
        handedOff = Set(
            receipts.compactMap { receipt in
                receipt.handedOffAt == nil ? nil : receipt.destination
            }
        )
        sharedAt = Dictionary(
            uniqueKeysWithValues: receipts.compactMap { receipt in
                guard receipt.handedOffAt != nil, let shared = receipt.sharedAt else {
                    return nil
                }
                return (receipt.destination, shared)
            }
        )
    }

    /// The single primary action of an open workspace. Only one destination's
    /// workspace is open at a time, and reopening a row restores it as it was.
    func primaryActionLabel(for destination: AssistedExportDestination) -> String {
        AssistedExportCopy.openDestination(destination)
    }

    /// `Mark as shared` is withheld until the seller has actually handed the
    /// pack over. Offering it earlier would invite a claim about a destination
    /// the seller never visited.
    func offersMarkAsShared(for destination: AssistedExportDestination) -> Bool {
        guard !isPackOutOfDate else { return false }
        return handedOff.contains(destination) && handoff(for: destination) == .prepared
    }

    /// Opening or closing a workspace is navigation, not evidence. It records
    /// nothing about any destination.
    mutating func toggle(_ destination: AssistedExportDestination) {
        undoWindow = nil
        openDestination = openDestination == destination ? nil : destination
    }

    /// Note what the seller did on this device. The only consequences are that
    /// `Mark as shared` becomes reachable for that destination and the guided
    /// sheet moves past the step that action completes.
    mutating func recordHandoff(
        _ action: AssistedExportHandoffAction,
        for destination: AssistedExportDestination
    ) {
        handedOff.insert(destination)
        performed[destination, default: []].insert(action)
    }

    /// The per-destination actions the seller performed, for the store to keep
    /// across a relaunch.
    var performedActions: [AssistedExportDestination: Set<AssistedExportHandoffAction>] {
        performed
    }

    /// Puts back what an earlier launch recorded for this pack text.
    mutating func restorePerformed(
        _ restored: [AssistedExportDestination: Set<AssistedExportHandoffAction>]
    ) {
        performed = restored
    }

    /// Where the destination's guided sheet stands. Derived on every read from
    /// the handoff state above, so closing and reopening the sheet cannot lose
    /// or invent progress.
    func guide(for destination: AssistedExportDestination) -> AssistedExportGuideProgress {
        AssistedExportGuide.progress(
            performed: performed[destination] ?? [],
            isShared: sharedAt[destination] != nil
        )
    }

    /// The seller tapped Open and nothing happened. Attempt first, then report,
    /// rather than guessing beforehand with `canOpenURL`. The advisory inserts
    /// in flow and takes nothing away: a destination SnapList could not open is
    /// still one the seller may have posted to by hand.
    mutating func recordDestinationDidNotOpen(_ destination: AssistedExportDestination) {
        didNotOpen.insert(destination)
    }

    /// The in-flow advisory for a destination that did not open, or nil. It
    /// says what was observed and offers the alternatives, and stops there.
    func advisory(for destination: AssistedExportDestination) -> String? {
        guard didNotOpen.contains(destination) else { return nil }
        return AssistedExportCopy.didNotOpen(destination)
    }

    func confirmQuestion(for destination: AssistedExportDestination) -> String {
        AssistedExportCopy.confirmQuestion(destination)
    }

    /// One combined label per row, so assistive technology hears the identity,
    /// the status, and the disclosure state as a single element rather than
    /// three fragments.
    /// Whether this destination's workspace is on screen. A stale pack takes
    /// every workspace down without forgetting which row the seller had open,
    /// so `openDestination` alone is not the answer. The view and the row's
    /// spoken label both read this, so they cannot disagree about what is
    /// showing.
    func isWorkspaceOpen(_ destination: AssistedExportDestination) -> Bool {
        switch state {
        case let .workspaceOpen(open), let .handedOff(open), let .shared(open):
            return open == destination
        case .destinationList, .packOutOfDate:
            return false
        }
    }

    func accessibilityLabel(for destination: AssistedExportDestination) -> String {
        // Announce the same progress displayed in the marketplace tab.
        "\(destination.displayName), \(tabStatusText(for: destination).lowercased())"
    }

    /// The row's one-line state: Not started, Prepared, or the seller's own
    /// Shared claim. Prepared means the seller handed the pack over on this
    /// device, never that anything reached the destination.
    func rowStateText(for destination: AssistedExportDestination) -> String {
        switch handoff(for: destination) {
        case let .shared(at: date):
            return AssistedExportCopy.sharedStatus(on: date)
        case .prepared:
            return hasHandedOff(to: destination)
                ? AssistedExportCopy.prepared
                : AssistedExportCopy.notStarted
        }
    }

    /// The marketplace tab's one-line status: the seller's own Shared claim,
    /// how many of the three device steps they took on this device, or, for a
    /// handoff known only from its server receipt, Prepared. A receipt says
    /// some handoff happened, not which, so it never counts as a done step.
    func tabStatusText(for destination: AssistedExportDestination) -> String {
        if case .shared = handoff(for: destination) {
            return AssistedExportCopy.tabShared
        }
        let deviceSteps = AssistedExportGuideStep.allCases.filter { $0 != .confirmPosted }
        let done = guide(for: destination).completed.count
        if done > 0 {
            return AssistedExportCopy.stepsDone(done, of: deviceSteps.count)
        }
        return hasHandedOff(to: destination)
            ? AssistedExportCopy.prepared
            : AssistedExportCopy.notStarted
    }

    /// Ask the seller. The sheet only mounts for a row that could legitimately
    /// answer yes, so a row that did nothing is never even asked.
    mutating func presentConfirmSheet(for destination: AssistedExportDestination) {
        guard offersMarkAsShared(for: destination) else { return }
        confirmSheet = destination
    }

    /// Any cancel path: `Not yet`, a swipe, the scrim, Escape. Nothing partial
    /// is written, and the workspace is left exactly as it was.
    mutating func dismissConfirmSheet() {
        confirmSheet = nil
    }

    /// The seller's explicit claim, and the only write of `shared` in the whole
    /// domain. The guard mirrors `mark_export_shared` so the client refuses for
    /// the same reasons the database would rather than discovering them late.
    @discardableResult
    mutating func confirmShared(at date: Date) -> AssistedExportConfirmOutcome {
        guard let destination = confirmSheet,
              offersMarkAsShared(for: destination) else {
            confirmSheet = nil
            return .refused
        }
        sharedAt[destination] = date
        confirmSheet = nil
        undoWindow = destination
        return .recorded
    }

    /// Take the claim back. The recorded handoff stands, matching
    /// `undo_export_shared`: the seller really did hand the pack over, and only
    /// what they said about the destination is withdrawn.
    mutating func undoShared() {
        guard let destination = undoWindow else { return }
        sharedAt[destination] = nil
        undoWindow = nil
    }

    /// The transient window expiring on its own. Not an undo.
    mutating func closeUndoWindow() {
        undoWindow = nil
    }

    /// The listing moved while the seller was in here.
    ///
    /// Dismissing the confirm sheet is the load-bearing line. `mark_export_shared`
    /// would refuse the write anyway, but a sheet left mounted still asks the
    /// seller to confirm a pack they were never shown, and a refusal arriving
    /// after the tap is a worse experience than never offering the tap. Closing
    /// the workspaces and withholding the handoff actions follows from the same
    /// rule: nothing in here may act on a pack that no longer describes the
    /// listing. The seller's own shared records are untouched, because those are
    /// their claims and editing a listing does not unsay them.
    ///
    /// The open destination is remembered rather than discarded. No workspace
    /// renders while the pack is stale — `state` answers `.packOutOfDate`
    /// whatever is remembered — but updating the pack puts the seller back where
    /// they were instead of at the top of the list, for an edit they may not
    /// have made from this screen at all.
    mutating func listingRevisionChanged(to revision: UUID) {
        currentReviewRevision = revision
        guard isPackOutOfDate else { return }
        confirmSheet = nil
        undoWindow = nil
    }

    /// A freshly prepared pack for the current listing.
    ///
    /// A handoff receipt belongs to the pack text the seller actually handed
    /// over, which is what the content revision identifies — the same asymmetry
    /// the server keeps, where reads key on the content revision alone and the
    /// confirm guard on the full one. A price-only edit advances the review
    /// revision without moving a word of the pack, so the receipt survives it.
    ///
    /// A new content revision is different text, and everything the seller said
    /// about the old text goes with it — the handoff and the `Shared` claim
    /// alike. `loadExportHandoffs` keys on the content revision, so the server
    /// returns no row for the new text and reads `prepared`; a client still
    /// showing `Shared` would be the only thing in the system saying it, about
    /// words the seller never saw. Keeping the claim while retiring the handoff
    /// would be worse than either: `Mark as shared` is withheld from a
    /// destination with no handoff, so the seller could neither correct the
    /// line nor re-confirm it.
    mutating func updatePack(to pack: AssistedExportPack) {
        confirmSheet = nil
        undoWindow = nil
        if pack.contentRevision != self.pack.contentRevision {
            handedOff = []
            performed = [:]
            sharedAt = [:]
        }
        self.pack = pack
        currentReviewRevision = pack.reviewRevision
    }
}

/// Seller-facing strings, taken from the approved package rather than written
/// here. Nothing in this namespace may claim a destination received, listed,
/// published, synced, verified, or sold anything.
enum AssistedExportCopy {
    static let notStarted = "Not started"
    static let prepared = "Prepared"
    static let tabShared = "Shared"
    static let closeGuide = "Close"
    static let screenTitle = "Share to other marketplaces"

    static func stepsDone(_ done: Int, of total: Int) -> String {
        "\(done) of \(total) done"
    }

    static func stepPosition(_ position: Int, of total: Int) -> String {
        "Step \(position) of \(total)"
    }

    // The four checklist rows. Each says what the step hands over in plain
    // words, because the seller finishes the form somewhere SnapList cannot see.
    static let copyRowTitle = "Listing text"

    static func copyRowDetail(for destination: AssistedExportDestination) -> String {
        // Depop takes no title, so its row must not promise one.
        destination == .depop ? "Description and price" : "Title, description, price"
    }

    static func photosRowTitle(count: Int) -> String {
        photos(count)
    }

    static let photosRowDetail = "Saves to Photos"

    static func openRowTitle(_ destination: AssistedExportDestination) -> String {
        "Open \(shortName(destination))"
    }

    static let openRowDetail = "Paste text, add photos"
    static let postedRowTitle = "Posted it?"
    static let postedRowDetailBefore = "After you post"
    /// The one fact this family must not hide: SnapList cannot see any of
    /// these destinations, so only the seller's own tap here is evidence.
    static let postedRowDetailReady = "Only you can confirm"

    static let copyAction = "Copy"
    static let copiedAction = "Copied"
    static let saveAction = "Save"
    static let savedAction = "Saved"
    static let openAction = "Open"
    static let openedAction = "Opened"
    static let markShared = "Mark shared"
    static let undo = "Undo"
    static let shareAnotherWay = "Share another way"

    static func openDestination(_ destination: AssistedExportDestination) -> String {
        "Open \(destination.displayName)"
    }

    static func didNotOpen(_ destination: AssistedExportDestination) -> String {
        "\(destination.displayName) didn't open. It may not be installed."
    }

    static let packOutOfDateTitle = "This pack is out of date"
    static let packOutOfDateDetail = "You changed the listing. Update the pack before sharing."
    static let updatePack = "Update pack"
    static let loadFailedTitle = "Couldn’t load this sharing pack"
    static let loadFailedDetail = "Check your connection and try again."
    static let retry = "Retry"
    static let actionFailed = "Couldn’t complete that action. Try again."
    // `entryTitle`/`entryDetail` (Listing review's entry-row headline and
    // "Prepared for Facebook Marketplace, Mercari, and Depop" subtitle) are
    // retired by #896, which owns and is actively editing the one call site
    // in `ListingReviewView.swift`. Deleting them here before that lands
    // would break this branch's own build against the current
    // `ListingReviewView.swift`; #896 should drop them from this file in the
    // same change that removes their last render.
    static let entryTitle = "Share to other marketplaces"
    // #962: every edit autosaves, so reaching this guard means the autosave
    // attempt itself failed (offline, conflict, etc.) -- not that the seller
    // forgot a save step that no longer exists.
    static let saveBeforeSharing = "Couldn’t save your changes. Check your connection and try again."

    /// The name a tab or row has room for. The full name stays the spoken
    /// label everywhere it matters.
    private static func shortName(_ destination: AssistedExportDestination) -> String {
        destination == .facebookMarketplace ? "Facebook" : destination.displayName
    }

    private static func photos(_ count: Int) -> String {
        count == 1 ? "1 photo" : "\(count) photos"
    }

    static func confirmQuestion(_ destination: AssistedExportDestination) -> String {
        "Did you post this on \(destination.displayName)?"
    }

    /// Every fixed string this family can show. The vocabulary sweep in
    /// `AssistedExportDomainTests` reads this, so a new constant is covered the
    /// moment it is added here. Views take their copy from this namespace and
    /// hold no seller-facing literals of their own.
    static let allSellerFacingStrings: [String] = [
        notStarted,
        prepared,
        tabShared,
        closeGuide,
        screenTitle,
        stepsDone(2, of: 3),
        stepPosition(2, of: 4),
        copyRowTitle,
        photosRowTitle(count: 8),
        photosRowTitle(count: 1),
        photosRowDetail,
        openRowDetail,
        postedRowTitle,
        postedRowDetailBefore,
        postedRowDetailReady,
        copyAction,
        copiedAction,
        saveAction,
        savedAction,
        openAction,
        openedAction,
        markShared,
        undo,
        shareAnotherWay,
        packOutOfDateTitle,
        packOutOfDateDetail,
        updatePack,
        loadFailedTitle,
        loadFailedDetail,
        retry,
        actionFailed,
        entryTitle,
        saveBeforeSharing,
    ] + AssistedExportDestination.allCases.flatMap { destination in
        [
            copyRowDetail(for: destination),
            openRowTitle(destination),
            openDestination(destination),
            didNotOpen(destination),
            confirmQuestion(destination),
        ]
    }

    static func sharedStatus(on date: Date) -> String {
        "Shared \(sharedDateFormatter.string(from: date))"
    }

    private static let sharedDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.setLocalizedDateFormatFromTemplate("MMMd")
        return formatter
    }()
}
