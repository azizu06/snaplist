import Foundation
import SwiftUI

enum SettingsAuthenticationMethod: Equatable {
    case apple
    case emailCode
}

enum SettingsIdentity: Equatable {
    case guest
    case member(method: SettingsAuthenticationMethod, email: String)
}

enum SettingsReauthenticationResolution: Equatable {
    case succeeded
    case failed
    case cancelled
}

enum SettingsGuestBoundaryCopy {
    static let title = "Guest Settings stops here"
    static let body = "A guest cannot read entitlements and has no account record, so the Subscription group and the account management group are both absent rather than empty. Server held guest data deletes itself within 24 hours of acceptance, which is a guarantee in the retention contract rather than a hope. Removing it sooner, or managing it at all, requires claiming the account first."
}

enum SettingsAccountEntryPolicy {
    static func destination(for identity: SettingsIdentity) -> AppRoute? {
        switch identity {
        case .guest: .future(.account)
        case .member: nil
        }
    }
}

/// Issue #844. Everything the sign-out screens say, kept out of the view so
/// the wording is assertable rather than only screenshot-able — the same reason
/// `SettingsGuestBoundaryCopy` exists.
///
/// The risk this copy carries is that a seller reads `Sign out` as the end of
/// their account. So the screen states the opposite in as many words, and the
/// unsent work it does take is named before the seller commits to it.
enum SettingsSignOutCopy {
    static let rowLabel = "Sign out"
    static let title = "Sign out"
    static let confirm = "Sign out"
    static let cancel = "Stay signed in"

    static let effectTitle = "What happens on this iPhone"
    static let effects = [
        "Photos and a voice note you have not submitted yet are removed from this iPhone.",
        "Trophy Wall goes back to the guest view, and your items stop showing here.",
    ]

    static let unchangedTitle = "What this does not change"
    static let unchanged = [
        "Your account stays. This is not account deletion.",
        "Items you have already sent stay on your account, and signing back in brings them back.",
        "Your subscription is unchanged.",
    ]

    static let deletionIsElsewhere =
        "Deleting your account is a separate action in Settings."
    /// Shown only when Clerk refused. Says the session survived, because it did.
    static let failed =
        "Signing out didn’t finish, so you are still signed in. Try again."

    /// Every string the sign-out screens can put in front of a seller, so a
    /// wording rule can be applied to all of them instead of to a list someone
    /// has to remember to extend.
    static var everyString: [String] {
        [rowLabel, title, confirm, cancel, effectTitle, unchangedTitle,
         deletionIsElsewhere, failed] + effects + unchanged
    }
}

/// Issue #844. Whether the ACCOUNT card offers a way out of the session.
///
/// The mirror of `SettingsAccountEntryPolicy`: a guest is offered the account
/// they do not have, a member the end of the session they do. Sign-out is not a
/// route, so this answers with availability rather than an `AppRoute`.
enum SettingsSignOutPolicy {
    static func isAvailable(for identity: SettingsIdentity) -> Bool {
        if case .member = identity { true } else { false }
    }
}

enum SettingsSignOutOutcome: Equatable {
    case signedOut
    /// Nothing was removed and nothing was ended. The seller is where they
    /// started.
    case localDataNotRemoved
    /// This device's copies are gone, and Clerk still holds the session. Never
    /// reported as a sign-out: the credential is still on the device.
    case sessionNotEnded
}

/// Issue #844. Ends a member's session and takes this device's copies with it.
///
/// The removal runs first. `CaptureDraft/` and `ListingReview/` carry no
/// principal in their paths, unlike the intake root, so the guest shell a
/// sign-out lands in can read whatever is still there. Removing first makes
/// "signed out" imply "removed" rather than leaving a window where it does not.
enum SettingsSignOutTransaction {
    static func perform(
        removeLocalData: () async -> Bool,
        endSession: () async throws -> Void
    ) async -> SettingsSignOutOutcome {
        guard await removeLocalData() else { return .localDataNotRemoved }
        do {
            try await endSession()
        } catch {
            return .sessionNotEnded
        }
        return .signedOut
    }
}

struct SettingsFlow: Equatable {
    enum Screen: Equatable {
        case settings
        case localRemoval
        case deletionConsequences
        case reauthentication(failed: Bool)
        case deletionConfirmation
    }

    let identity: SettingsIdentity
    private(set) var hasLocalData: Bool
    private(set) var screen: Screen = .settings

    init(identity: SettingsIdentity, hasLocalData: Bool) {
        self.identity = identity
        self.hasLocalData = hasLocalData
    }

    var stateID: String {
        switch screen {
        case .settings: "SET-01"
        case .localRemoval: identity == .guest ? "SET-05" : "SET-06"
        case .deletionConsequences: "DEL-01"
        case .reauthentication(let failed): failed ? "DEL-02f" : "DEL-02"
        case .deletionConfirmation: "DEL-03"
        }
    }

    var localGroupStateID: String { hasLocalData ? "SET-03" : "SET-04" }
    var isMember: Bool {
        if case .member = identity { true } else { false }
    }

    var localRemovalUnchangedFacts: [String] {
        let common = [
            "An item you already submitted keeps being worked on.",
            identity == .guest
                ? "A free item you have used stays used."
                : "An AI item you have spent stays spent and does not return to your allowance."
        ]
        guard identity == .guest else { return common }
        return common + [
            "A finished result stays recoverable until it expires, and after that it is gone whether or not you use this."
        ]
    }

    mutating func openLocalRemoval() {
        guard hasLocalData else { return }
        screen = .localRemoval
    }

    mutating func completeLocalRemoval() {
        guard screen == .localRemoval else { return }
        hasLocalData = false
        screen = .settings
    }

    mutating func keepLocalData() { screen = .settings }

    mutating func openDeletion() {
        guard isMember else { return }
        screen = .deletionConsequences
    }

    mutating func continueToReauthentication() {
        guard screen == .deletionConsequences else { return }
        screen = .reauthentication(failed: false)
    }

    mutating func resolveReauthentication(
        _ resolution: SettingsReauthenticationResolution
    ) {
        guard case .reauthentication = screen else { return }
        switch resolution {
        case .succeeded: screen = .deletionConfirmation
        case .failed: screen = .reauthentication(failed: true)
        case .cancelled: screen = .reauthentication(failed: false)
        }
    }

    mutating func cancelReauthentication() {
        guard case .reauthentication = screen else { return }
        screen = .deletionConsequences
    }

    mutating func keepAccount() { screen = .settings }

    mutating func returnFromDeletionConfirmation() {
        guard screen == .deletionConfirmation else { return }
        screen = .reauthentication(failed: false)
    }
}

struct SettingsLocalCachedDataStore {
    private let applicationSupportDirectory: URL
    private let fileManager: FileManager

    init(
        applicationSupportDirectory: URL? = nil,
        fileManager: FileManager = .default
    ) {
        self.fileManager = fileManager
        self.applicationSupportDirectory = applicationSupportDirectory
            ?? fileManager.urls(
                for: .applicationSupportDirectory,
                in: .userDomainMask
            )[0]
    }

    var hasData: Bool {
        ownedRoots.contains { fileManager.fileExists(atPath: $0.path) }
    }

    func removeAll() -> Bool {
        var removedEveryRoot = true
        for root in ownedRoots where fileManager.fileExists(atPath: root.path) {
            do { try fileManager.removeItem(at: root) }
            catch { removedEveryRoot = false }
        }
        return removedEveryRoot
    }

    private var ownedRoots: [URL] {
        let snapList = applicationSupportDirectory
            .appendingPathComponent("SnapList", isDirectory: true)
        return [
            snapList.appendingPathComponent("CaptureDraft", isDirectory: true),
            snapList.appendingPathComponent("ListingReview", isDirectory: true),
        ]
    }
}

enum SettingsLocalRemovalTransaction {
    static func perform(
        removeIntake: () async -> Bool,
        removeCachedItems: () async -> Bool
    ) async -> Bool {
        guard await removeIntake() else { return false }
        return await removeCachedItems()
    }
}

struct SettingsEmailCodePresentation: Equatable {
    let digits: [String]

    init(code: String) {
        digits = code.filter(\.isNumber).prefix(6).map(String.init)
    }

    var focusedBoxIndex: Int { min(digits.count, 5) }
    var accessibilityValue: String { "\(digits.count) of 6 digits entered" }
}

enum SettingsReauthenticationGate {
    static func isSameAccount(
        originalUserID: String,
        verifiedUserID: String?
    ) -> Bool {
        verifiedUserID == originalUserID
    }

    static func emailAddressID(
        displayedPrimaryAddressID: String?,
        supportedEmailAddressIDs: [String]
    ) -> String? {
        guard let displayedPrimaryAddressID,
              supportedEmailAddressIDs.contains(displayedPrimaryAddressID) else {
            return nil
        }
        return displayedPrimaryAddressID
    }
}

enum SettingsEmailCodeDeliveryState: Equatable {
    case sending
    case sent
    case failed

    func lead(email: String) -> String {
        switch self {
        case .sending:
            "Deleting an account is permanent, so SnapList is sending a 6-digit code to \(email) to confirm it is you."
        case .sent:
            "Deleting an account is permanent, so SnapList sent a 6-digit code to \(email). Enter it to confirm it is you."
        case .failed:
            "Deleting an account is permanent, so SnapList needs a 6-digit code sent to \(email) to confirm it is you."
        }
    }

    func failureCopy(email: String) -> String? {
        guard self == .failed else { return nil }
        return "SnapList could not send a code to \(email). Nothing has been deleted. You can try again."
    }
}

enum SettingsEmailCodeChallenge {
    static func send(
        displayedPrimaryAddressID: String?,
        supportedEmailAddressIDs: [String],
        sender: (String) async throws -> Void
    ) async -> SettingsEmailCodeDeliveryState {
        guard let emailAddressID = SettingsReauthenticationGate.emailAddressID(
            displayedPrimaryAddressID: displayedPrimaryAddressID,
            supportedEmailAddressIDs: supportedEmailAddressIDs
        ) else { return .failed }
        do {
            try await sender(emailAddressID)
            return .sent
        } catch {
            return .failed
        }
    }
}

enum SettingsEntitlementRefreshPlan: Equatable {
    case stop
    case requestServerTruth

    static func afterInitialLoad(_ state: SubscriptionStore.State) -> Self {
        if case .available = state { return .requestServerTruth }
        return .stop
    }

    static func afterRestore(_ state: SubscriptionStore.State) -> Self {
        switch state {
        case .restoreNotFound, .awaitingServerVerification:
            .requestServerTruth
        default:
            .stop
        }
    }

    var deletionDisclosureLoadPhase:
        SettingsSubscriptionPresentation.LoadPhase {
        switch self {
        case .stop: .loaded
        case .requestServerTruth: .loading
        }
    }
}

enum SettingsEntitlementServerRefresh {
    @MainActor
    static func perform<Value>(
        fetch: () async throws -> Value,
        apply: (Value) -> Void,
        setLoadPhase: (SettingsSubscriptionPresentation.LoadPhase) -> Void
    ) async {
        setLoadPhase(.loading)
        do {
            let value = try await fetch()
            apply(value)
            setLoadPhase(.loaded)
        } catch {
            setLoadPhase(.failed)
        }
    }
}

/// The Selling section's eBay reading (issue #694).
///
/// A connected seller whose eBay account cannot produce usable business
/// policies learns it here rather than at publish. The client makes exactly one
/// decision, whether a hint is owed; the wording and the link are server truth,
/// so this build cannot drift from what publish would refuse with.
struct SettingsSellingPresentation: Equatable {
    enum LoadPhase: Equatable {
        case loading
        case loaded
        case failed
    }

    struct Hint: Equatable {
        let message: String
        let helpURL: URL?
    }

    let marketplaceValue: String
    let hint: Hint?

    init(connection: EbayConnectionStatus?, loadPhase: LoadPhase) {
        switch loadPhase {
        case .loading:
            marketplaceValue = "Checking"
            hint = nil
            return
        case .failed:
            // The connection was not readable. Saying "Not connected" would
            // claim something SnapList does not know.
            marketplaceValue = "Not available"
            hint = nil
            return
        case .loaded:
            break
        }
        guard let connection, connection.connected else {
            marketplaceValue = "Not connected"
            hint = nil
            return
        }
        marketplaceValue = "eBay"
        // `ready` and any state this build does not recognise both stay silent.
        // A hint with no message would be a warning the seller cannot act on.
        guard
            let setup = connection.policySetup,
            setup.state != "ready",
            let message = setup.message,
            !message.isEmpty
        else {
            hint = nil
            return
        }
        hint = Hint(message: message, helpURL: setup.helpURL)
    }
}

/// Whether a Settings label/value row lays its two halves side by side.
///
/// Side by side, the row's width is split between them, and a word wider than
/// its share is broken mid-word instead of wrapped — `Connected marketplaces`
/// rendered as `Con-nected` (#839). The threshold is the accessibility one
/// because that is where a label long enough to need the whole row first
/// appears; below it, every shipped label still fits its share.
enum SettingsValueRowLayout {
    static func stacks(at size: DynamicTypeSize) -> Bool {
        size.isAccessibilitySize
    }
}

struct SettingsSubscriptionVisibility: Equatable {
    let isVisible: Bool

    init(identity: SettingsIdentity, deletionOutstanding: Bool) {
        isVisible = identity != .guest && !deletionOutstanding
    }
}

struct SettingsSubscriptionPresentation: Equatable {
    enum LoadPhase: Equatable {
        case loading
        case loaded
        case failed
    }

    enum Action: Equatable {
        case manage
        case restore
        case retry
    }

    struct Fact: Equatable {
        let label: String
        let value: String
    }

    let stateID: String
    let status: String
    let facts: [Fact]
    let note: String?
    let actions: [Action]
    let showsOwnershipNote: Bool

    private init(
        stateID: String,
        status: String,
        facts: [Fact],
        note: String?,
        actions: [Action],
        showsOwnershipNote: Bool
    ) {
        self.stateID = stateID
        self.status = status
        self.facts = facts
        self.note = note
        self.actions = actions
        self.showsOwnershipNote = showsOwnershipNote
    }

    var remainingItems: Int? {
        facts.first { $0.label == "AI listings left" }.flatMap { Int($0.value) }
    }

    var accessibilityAnnouncement: String {
        var parts = ["SnapList Pro"]
        if !status.isEmpty { parts.append(status) }
        parts += facts.map { "\($0.label), \($0.value)" }
        if let note { parts.append(note) }
        let punctuation = CharacterSet(charactersIn: ". ")
        return parts.map { $0.trimmingCharacters(in: punctuation) }
            .joined(separator: ". ") + "."
    }

    init(
        state: SubscriptionStore.State,
        loadPhase: LoadPhase = .loaded,
        locale: Locale = .current
    ) {
        let manage: [Action] = [.manage]
        let manageAndRestore: [Action] = [.manage, .restore]
        switch loadPhase {
        case .loading:
            self.init(
                stateID: "SUB-02", status: "Checking", facts: [], note: nil,
                actions: manage, showsOwnershipNote: true
            )
            return
        case .failed:
            self.init(
                stateID: "SUB-15", status: "", facts: [],
                note: "SnapList could not load your subscription details.",
                actions: [.retry, .manage], showsOwnershipNote: true
            )
            return
        case .loaded:
            break
        }
        switch state {
        case .unconfigured:
            self.init(
                stateID: "SUB-01", status: "", facts: [],
                note: "Subscriptions are not available for this account.",
                actions: [], showsOwnershipNote: false
            )
        case .loading, .purchasing, .pending:
            self.init(
                stateID: "SUB-02", status: "Checking", facts: [], note: nil,
                actions: manage, showsOwnershipNote: true
            )
        case .available, .restoreNotFound:
            self.init(
                stateID: "SUB-03", status: "Not subscribed", facts: [], note: nil,
                actions: manageAndRestore, showsOwnershipNote: true
            )
        case .restoring:
            self.init(
                stateID: "SUB-04", status: "Checking for a purchase", facts: [],
                note: nil, actions: manage, showsOwnershipNote: true
            )
        case .awaitingServerVerification:
            self.init(
                stateID: "SUB-05", status: "Waiting for the server", facts: [],
                note: "Apple confirmed a purchase on this Apple Account. SnapList Pro turns on after the server confirms it.",
                actions: manage, showsOwnershipNote: true
            )
        case .verified(let verified):
            self = Self.verified(verified, locale: locale)
        case .failed:
            self.init(
                stateID: "SUB-15", status: "", facts: [],
                note: "SnapList could not load your subscription details.",
                actions: [.retry, .manage], showsOwnershipNote: true
            )
        }
    }

    private static func verified(
        _ verified: ServerVerifiedSubscription,
        locale: Locale
    ) -> Self {
        let remaining = Fact(
            label: "AI listings left",
            value: verified.remainingItems.formatted(.number.locale(locale))
        )
        let manageAndRestore: [Action] = [.manage, .restore]
        switch verified.status {
        case .included:
            return Self(
                stateID: "SUB-06", status: "Included", facts: [remaining],
                note: "This allowance comes with your account. There is no subscription on this Apple Account.",
                actions: manageAndRestore, showsOwnershipNote: true
            )
        case .active:
            return Self(
                stateID: "SUB-07", status: "Active",
                facts: [remaining] + dateFact(
                    "Current period ends", verified.periodEnd, locale: locale
                ),
                note: nil, actions: manageAndRestore, showsOwnershipNote: true
            )
        case .grace:
            return Self(
                stateID: "SUB-08", status: "Payment problem",
                facts: [remaining] + dateFact(
                    "Access continues until", verified.gracePeriodEnd, locale: locale
                ),
                note: "Apple could not take the payment. Access continues while Apple retries. Your remaining listings stay as they are during this time.",
                actions: manageAndRestore, showsOwnershipNote: true
            )
        case .billingRetry:
            return Self(
                stateID: "SUB-09", status: "Retrying payment", facts: [remaining],
                note: "Apple is retrying the payment. Access has not ended.",
                actions: manageAndRestore, showsOwnershipNote: true
            )
        case .expired:
            return ended("SUB-10", "Ended", "This subscription ended.")
        case .revoked:
            return ended("SUB-11", "Revoked", "Apple revoked this subscription.")
        case .refunded:
            return ended("SUB-12", "Refunded", "This subscription was refunded.")
        case .ambiguous:
            return Self(
                stateID: "SUB-13", status: "Details not updated",
                facts: [remaining] + dateFact(
                    "Current period ends", verified.periodEnd, locale: locale
                ),
                note: "These are the last details the server confirmed. They are not being updated right now.",
                actions: manageAndRestore, showsOwnershipNote: true
            )
        case .unconfigured:
            return Self(
                stateID: "SUB-01", status: "", facts: [],
                note: "Subscriptions are not available for this account.",
                actions: [], showsOwnershipNote: false
            )
        }
    }

    private static func ended(_ id: String, _ status: String, _ note: String) -> Self {
        Self(
            stateID: id, status: status, facts: [], note: note,
            actions: [.manage, .restore], showsOwnershipNote: true
        )
    }

    private static func dateFact(
        _ label: String,
        _ date: Date?,
        locale: Locale
    ) -> [Fact] {
        guard let date else { return [] }
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.dateStyle = .long
        formatter.timeStyle = .none
        return [Fact(label: label, value: formatter.string(from: date))]
    }
}

enum SettingsDeletionSubscriptionTruth: Equatable {
    case billing
    case ended
    case included
    case none
    case ambiguous
    case unknown

    init(
        state: SubscriptionStore.State,
        loadPhase: SettingsSubscriptionPresentation.LoadPhase = .loaded
    ) {
        guard loadPhase == .loaded else {
            self = .unknown
            return
        }
        switch state {
        case .awaitingServerVerification:
            self = .billing
        case .available, .restoreNotFound:
            self = .none
        case .verified(let value):
            self = switch value.status {
            case .active, .grace, .billingRetry: .billing
            case .expired, .revoked, .refunded: .ended
            case .included: .included
            case .ambiguous: .ambiguous
            case .unconfigured: .unknown
            }
        case .unconfigured, .loading, .purchasing, .pending, .restoring, .failed:
            self = .unknown
        }
    }

    var longCopy: String {
        switch self {
        case .billing:
            "SnapList Pro is billed by Apple, and only Apple can cancel it. Deleting this account does not cancel it and does not refund it. Cancel it in the App Store, before or after you delete."
        case .ended:
            "No subscription is billing on this Apple Account now. Deleting this account does not change that, and there is nothing for Apple to cancel."
        case .included:
            "There is no SnapList Pro subscription on this Apple Account. The allowance belongs to the account and ends with it. If a subscription is ever started, Apple bills and cancels it, and deleting a SnapList account would not cancel it."
        case .none:
            "There is no SnapList Pro subscription on this Apple Account. If one is ever started, Apple bills and cancels it, and deleting a SnapList account would not cancel it."
        case .ambiguous:
            "SnapList cannot read your subscription state right now. If a subscription is billing, Apple keeps billing it until it is cancelled in the App Store. Check it in the App Store, before or after you delete."
        case .unknown:
            "SnapList cannot confirm whether a subscription exists on this Apple Account. Apple bills and cancels SnapList Pro, so check it in the App Store before or after you delete."
        }
    }

    var shortCopy: String {
        switch self {
        case .billing:
            "SnapList Pro keeps billing until you cancel it in the App Store. Deleting this account does not cancel it."
        case .ended:
            "No subscription is billing now, so there is nothing for Apple to cancel."
        case .included, .none:
            "There is no subscription on this Apple Account, so there is nothing for Apple to cancel."
        case .ambiguous:
            "SnapList cannot confirm whether a subscription is billing. Check it in the App Store."
        case .unknown:
            "SnapList cannot confirm whether a subscription exists. Check it in the App Store."
        }
    }
}
