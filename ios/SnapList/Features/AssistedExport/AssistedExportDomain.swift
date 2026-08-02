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
    /// Ordered, authenticated photo references supplied by the mobile listing
    /// review projection. The client resolves all of them before offering a
    /// share sheet, so a failed fetch can never become an empty handoff.
    let photoReferences: [URL]

    var photoCount: Int { photoReferences.count }

    func listingText(for destination: AssistedExportDestination) -> String {
        switch destination {
        case .facebookMarketplace, .mercari:
            return "\(title)\n\n\(description)"
        case .depop:
            return description
        }
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
enum AssistedExportHandoffAction: Equatable, CaseIterable, Sendable {
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

struct AssistedExportDomain: Equatable, Sendable {
    private(set) var pack: AssistedExportPack
    private(set) var confirmSheet: AssistedExportDestination?
    private(set) var openDestination: AssistedExportDestination?
    private var handedOff: Set<AssistedExportDestination> = []
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

    /// Note what the seller did on this device. The only consequence is that
    /// `Mark as shared` becomes reachable for that destination.
    mutating func recordHandoff(
        _: AssistedExportHandoffAction,
        for destination: AssistedExportDestination
    ) {
        handedOff.insert(destination)
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

    /// The one line that opens a workspace. It states the division of labour:
    /// SnapList prepared something, the seller does the posting.
    func leadText(for destination: AssistedExportDestination) -> String {
        AssistedExportCopy.lead(destination)
    }

    func whatHappensNextText(for destination: AssistedExportDestination) -> String {
        AssistedExportCopy.whatHappensNext(destination)
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
        let status: String
        switch handoff(for: destination) {
        case .prepared:
            status = "not shared"
        case let .shared(at: date):
            status = AssistedExportCopy.sharedStatus(on: date).lowercased()
        }
        let disclosure = isWorkspaceOpen(destination) ? "open" : "closed"
        return "\(destination.displayName), \(status), \(disclosure)"
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
            sharedAt = [:]
        }
        self.pack = pack
        currentReviewRevision = pack.reviewRevision
    }

    func statusText(for destination: AssistedExportDestination) -> String {
        switch handoff(for: destination) {
        case .prepared:
            return AssistedExportCopy.notShared
        case let .shared(at: date):
            return AssistedExportCopy.sharedStatus(on: date)
        }
    }
}

/// Seller-facing strings, taken from the approved package rather than written
/// here. Nothing in this namespace may claim a destination received, listed,
/// published, synced, verified, or sold anything.
enum AssistedExportCopy {
    static let notShared = "Not shared"

    static func openDestination(_ destination: AssistedExportDestination) -> String {
        "Open \(destination.displayName)"
    }

    static func didNotOpen(_ destination: AssistedExportDestination) -> String {
        "\(destination.displayName) didn't open. It may not be installed. "
            + "Copy the text or share another way."
    }

    static let screenTitle = "Share to other marketplaces"
    static let copyListingText = "Copy listing text"
    static let copyListingTextDone = "Copied"
    static let savedPhotosDone = "Saved to Photos"
    static let shareAnotherWay = "Share another way"
    static let whatHappensNextTitle = "What happens next"
    static let markAsShared = "Mark as shared"
    static let markAsSharedSupport =
        "Only you can confirm this. SnapList won't mark it for you."
    static let confirmShared = "Yes, mark as shared"
    static let confirmNotYet = "Not yet"
    static let markedAsShared = "Marked as shared."
    static let undo = "Undo"
    static let packOutOfDateTitle = "This pack is out of date"
    static let packOutOfDateDetail =
        "You changed the listing after this pack was prepared. Update the "
            + "pack to match before sharing. Updating replaces the old pack."
    static let updatePack = "Update pack"
    static let loadFailedTitle = "Couldn’t load this sharing pack"
    static let loadFailedDetail = "Check your connection and try again."
    static let retry = "Retry"
    static let actionFailed = "Couldn’t complete that action. Try again."
    static let entryTitle = "Share to other marketplaces"
    static let entryDetail = "Prepared for Facebook Marketplace, Mercari, and Depop"
    static let saveBeforeSharing = "Save your changes before sharing."

    static func savePhotos(count: Int) -> String {
        "Save \(photos(count))"
    }

    /// What the pack holds and when it was built. Not a status line: a prepared
    /// pack is the ordinary state of this screen, so this reports and stops.
    static func packMeta(photoCount: Int, preparedAt: String) -> String {
        "\(photos(photoCount)) · Updated \(preparedAt)"
    }

    private static func photos(_ count: Int) -> String {
        count == 1 ? "1 photo" : "\(count) photos"
    }

    static func lead(_ destination: AssistedExportDestination) -> String {
        "SnapList prepared the listing. You post it in \(destination.displayName)."
    }

    static func whatHappensNext(_ destination: AssistedExportDestination) -> String {
        "Paste the text and add the photos in \(destination.displayName). "
            + "SnapList can't see whether the listing goes up. When you've "
            + "posted it, mark it shared here."
    }

    static func confirmQuestion(_ destination: AssistedExportDestination) -> String {
        "Did you post this on \(destination.displayName)?"
    }

    /// Every fixed string this family can show. The vocabulary sweep in
    /// `AssistedExportDomainTests` reads this, so a new constant is covered the
    /// moment it is added here. Views take their copy from this namespace and
    /// hold no seller-facing literals of their own.
    static let allSellerFacingStrings: [String] = [
        notShared,
        screenTitle,
        copyListingText,
        copyListingTextDone,
        savedPhotosDone,
        shareAnotherWay,
        whatHappensNextTitle,
        markAsShared,
        markAsSharedSupport,
        confirmShared,
        confirmNotYet,
        markedAsShared,
        undo,
        packOutOfDateTitle,
        packOutOfDateDetail,
        updatePack,
        loadFailedTitle,
        loadFailedDetail,
        retry,
        actionFailed,
        entryTitle,
        entryDetail,
        saveBeforeSharing,
        savePhotos(count: 8),
        savePhotos(count: 1),
        packMeta(photoCount: 8, preparedAt: "2:41 PM"),
    ]

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
