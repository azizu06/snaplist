import Foundation

/**
 Issue #385. The client half of account deletion.

 The server half already exists at `POST /v1/account/erasure`
 (`src/app/v1/account/erasure/route.ts`). Nothing here decides whether an
 account is gone. The server's durable status decides, and this file's whole job
 is to refuse to say anything the server did not say.
 */

/// A record the erasure finished without removing, because SnapList never owned
/// it. Mirrors `accountErasureRetainedRecordSchema` in
/// `src/lib/account-erasure/service.ts`.
enum AccountErasureRetainedRecord: String, Equatable, Sendable {
    case hostedTranscriptionProviderCopy = "hosted-transcription-provider-copy"
    case ebayLiveListing = "ebay-live-listing"
}

/// Why one erasure request produced no durable answer. Every case here means
/// the same thing to the device: nothing has been cleared and nothing is known.
enum AccountErasureRefusal: Equatable, Sendable {
    /// Clerk answered the strict reverification challenge rather than the
    /// handler. The seller must confirm identity again.
    case reverificationRequired
    /// The key is already bound to a different erasure.
    case idempotencyKeyConflict
    /// The handler could not confirm erasure. Its own message says to retry
    /// with the same key, so the key is never rotated on this.
    case serverUnavailable
    /// The request did not produce a readable answer at all.
    case transport
    /// This build never supplied a way to reach the erasure endpoint, so no
    /// request was made. Kept separate from `transport` because a build that
    /// cannot delete an account is a defect to fix, not a network to retry.
    case clientNotConfigured
}

/// Why a deletion stopped short of finishing. Whether another request can move
/// it differs per case, so read `allowsAnotherRequest` rather than assuming a
/// stall is a dead end.
enum AccountDeletionStall: Equatable, Sendable {
    /// `deletion_needs_attention`. The erasure began and stopped partway.
    case needsAttention
    /// The server has this account bound to a different Idempotency-Key, so the
    /// erasure this device can ask about is not the one that exists.
    case keyConflict
    /// The app itself has no route to the erasure endpoint.
    case appNotConfigured

    /// Whether asking the server again can still change this answer.
    ///
    /// `needsAttention` can. `deletion_needs_attention` is not in the server's
    /// `TERMINAL_STATUSES`, so a request carrying the same key re-walks storage
    /// and re-runs the identity delete rather than returning the stored state.
    /// The common way to land here is a transient Clerk failure, which
    /// `deleteClerkIdentity` reports as unproved absence, and one more request
    /// is exactly what finishes it. Removing the retry here would leave a seller
    /// whose data is gone and whose login survives with no way to finish.
    ///
    /// The other two cannot. A key conflict means the erasure this device can
    /// ask about is not the one the server has, and an unconfigured build has
    /// nowhere to send the request.
    var allowsAnotherRequest: Bool {
        switch self {
        case .needsAttention: true
        case .keyConflict, .appNotConfigured: false
        }
    }
}

/**
 What one erasure request reported.

 `completed` is the only case that means deleted, and it is derived from the
 durable `status` field rather than from the HTTP status: the handler answers
 `202` to `deletion_needs_attention` exactly as it does to
 `deletion_in_progress`, so a client keyed on `2xx` would read a deletion that
 needs a person as a deletion that succeeded.
 */
enum AccountErasureOutcome: Equatable, Sendable {
    /// `deletion_completed` or `deletion_completed_with_retained_records`.
    case completed(retainedRecords: [AccountErasureRetainedRecord])
    /// Accepted and not finished. Asking again with the same key resumes it.
    case pending
    /// `deletion_needs_attention`. Not terminal. The erasure stopped partway,
    /// and because the server does not treat this status as terminal, asking
    /// again with the same key resumes the work rather than replaying a stored
    /// answer.
    case needsAttention
    /// No durable answer. Nothing on this device may be touched.
    case notConfirmed(AccountErasureRefusal)
}

/// The seller-visible states of the deletion tail, DEL-03 through DEL-08 of the
/// approved Settings Hub + Delete Account family.
enum AccountDeletionPhase: Equatable, Sendable {
    /// DEL-03. The destructive control exists and has not been used.
    case confirming
    /// DEL-04. The request is out and the server has reported nothing.
    case requesting
    /// DEL-07. The server reported completion and the device is being cleared.
    case clearingDevice
    /// DEL-07f. The server reported completion and this iPhone would not give
    /// up its copies. Sign-out waits, because signing out would remove the only
    /// credential that can reach the retry.
    case deviceNotCleared
    /// DEL-08. Terminal. Reached only after the device was actually cleared.
    case deleted(retainedRecords: [AccountErasureRetainedRecord])
    /// DEL-05. A request went out and no completion was reported.
    case unfinished
    /// DEL-05a. The deletion stopped short of finishing. Whether asking again
    /// can move it depends on the reason, so the tray is decided by
    /// `AccountDeletionStall.allowsAnotherRequest` rather than by the state.
    case stalled(AccountDeletionStall)
    /// DEL-06. Completion could not be confirmed and this device is untouched.
    case failed
    /// DEL-06r. Clerk answered the strict reverification challenge instead of
    /// the handler. Retrying re-sends the same stale factor verification age and
    /// earns the identical refusal, so the only exit is confirming identity
    /// again at DEL-02.
    case reverificationExpired

    /// Whether this state tells the seller the deletion finished. Exactly one
    /// state may, and it is the one reached after the device was cleared.
    var reportsDeletion: Bool {
        if case .deleted = self { return true }
        return false
    }

    /// Whether the seller has an explicit way to ask the server again. Only
    /// states where asking again can actually change the answer say yes.
    var offersRetry: Bool {
        switch self {
        case .unfinished, .failed, .deviceNotCleared: true
        // Per reason, never wholesale. Two of the three stalls are dead ends
        // and one is a deletion that stopped partway and can still be finished.
        case .stalled(let stall): stall.allowsAnotherRequest
        case .confirming, .requesting, .clearingDevice, .deleted,
             .reverificationExpired: false
        }
    }

    /// The frozen state id, used by the accessibility identifier so a UI test
    /// reads the state the app believes it is in rather than guessing from copy.
    var stateID: String {
        switch self {
        case .confirming: "DEL-03"
        case .requesting: "DEL-04"
        case .unfinished: "DEL-05"
        case .stalled: "DEL-05a"
        case .failed: "DEL-06"
        case .reverificationExpired: "DEL-06r"
        case .clearingDevice: "DEL-07"
        case .deviceNotCleared: "DEL-07f"
        case .deleted: "DEL-08"
        }
    }
}

/**
 A Keychain item SnapList writes, and therefore one an account deletion has to
 remove. Guideline 5.1.1(v) is about credentials outliving the account they
 belong to, and a credential this list forgets is exactly that.
 */
struct AccountDeletionKeychainItem: Equatable, Sendable {
    let service: String
    let account: String

    /// Every generic-password item the app writes. Keep this in step with the
    /// stores that write them; `AccountDeletionDeviceStateTests` fails when it
    /// drifts, which is the point.
    static let everythingSnapListStores: [AccountDeletionKeychainItem] = [
        // KeychainGuestRecoveryCredentialVault
        .init(
            service: "dev.snaplist.ios.guest-recovery-credential",
            account: "recovery-credentials-v1"
        ),
        // KeychainGuestClaimAuthorityVault
        .init(
            service: "dev.snaplist.ios.guest-claim-authority",
            account: "listing-authorities-v1"
        ),
        // KeychainGuestClaimHandoffStore
        .init(
            service: "dev.snaplist.ios.guest-claim-handoff",
            account: "retained-handoffs-v1"
        ),
        // KeychainAppAttestKeyStore
        .init(
            service: "dev.snaplist.ios.app-attest",
            account: "verified-app-attest-key-id"
        ),
        // KeychainGuestCapabilityBearerStore
        .init(
            service: "dev.snaplist.ios.guest-capability",
            account: "guest-capability-bearer"
        ),
    ]

    /// Removes this item if it is there. A missing item is already the outcome
    /// deletion wants, so `errSecItemNotFound` is success.
    func remove() -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }
}

/**
 Removes this device's copies, one named store at a time.

 Every step is attempted even after one fails. A store that will not give up its
 copies is a reason to tell the seller the device is not clean, not a reason to
 leave the other stores untouched: by this point the account is already gone, so
 there is no later signed-in run that would come back for them.
 */
enum AccountDeletionDeviceState {
    /// Deliberately not `Sendable`: a step is built and run inside one clearing
    /// pass, and requiring `@Sendable` removals would force every caller to hand
    /// its stores across an isolation boundary they do not cross.
    struct Step {
        let name: String
        let remove: () async -> Bool

        init(name: String, remove: @escaping () async -> Bool) {
            self.name = name
            self.remove = remove
        }
    }

    static func clear(steps: [Step]) async -> Bool {
        var clearedEverything = true
        for step in steps where await !step.remove() {
            clearedEverything = false
        }
        return clearedEverything
    }

    /// Everything one deletion removes from this device: the app's own stores
    /// first, then every Keychain item.
    ///
    /// Intake and cached items are separate steps on purpose. Composing them
    /// through `SettingsLocalRemovalTransaction` short-circuits on the first
    /// failure, so a failed intake removal would leave the seller's cached
    /// items untouched and break the invariant this type exists to hold.
    ///
    /// Each removal is a closure rather than a captured value because it has to
    /// read its subject when it runs. The seller can change the draft between
    /// opening the screen and confirming, and a discard aimed at the version
    /// that was current at render time is a discard the store refuses.
    static func steps(
        removeIntake: @escaping () async -> Bool,
        removeCachedItems: @escaping () async -> Bool
    ) -> [Step] {
        [
            Step(name: "intake", remove: removeIntake),
            Step(name: "cached-items", remove: removeCachedItems),
        ] + keychainSteps
    }

    /// The Keychain half, as one step per item so a single stubborn item is
    /// visible rather than hidden behind an all-or-nothing result.
    static var keychainSteps: [Step] {
        AccountDeletionKeychainItem.everythingSnapListStores.map { item in
            Step(name: "keychain:\(item.account)", remove: { item.remove() })
        }
    }
}

/**
 Where the Idempotency-Key outlives the screen that minted it.

 `begin_account_erasure` keeps one erasure generation per account and raises
 `23505` when a second key arrives for it, which the handler returns as 409. A
 key held only in view state dies when the seller backgrounds the app or taps
 "Not now", and every later attempt mints a fresh one the server is then
 obliged to reject. Persisting it is what makes the handler's own instruction,
 retry with the same key, something the client can actually do.

 Scoped per account so a key never outlives the seller it belongs to, and
 removed once the deletion is completely finished.
 */
struct AccountErasureKeyStore: Sendable {
    /// `UserDefaults` is thread-safe but not marked `Sendable`. This store only
    /// reads and writes one string, and the alternative is giving up injection
    /// and hard-coding `.standard`.
    private nonisolated(unsafe) let defaults: UserDefaults
    private let storageKey: String

    init(userID: String, defaults: UserDefaults = .standard) {
        self.defaults = defaults
        storageKey = "dev.snaplist.ios.account-erasure-key.\(userID)"
    }

    func load() -> String? { defaults.string(forKey: storageKey) }
    func remember(_ key: String) { defaults.set(key, forKey: storageKey) }
    func forget() { defaults.removeObject(forKey: storageKey) }
}

/**
 Orders one account deletion.

 The ordering is the contract: request, wait for a durable terminal status,
 clear the device, then sign out. Clearing before the server confirms would
 leave a seller holding an intact account with no credential left to reach it,
 which is worse than the defect this replaces.
 */
@MainActor
@Observable
final class AccountDeletionCoordinator {
    struct Dependencies: Sendable {
        var requestErasure: @Sendable (String) async -> AccountErasureOutcome
        var clearDeviceState: @Sendable () async -> Bool
        /// Reports whether the session was actually ended. A swallowed failure
        /// here leaves a live credential on a device whose account is gone,
        /// which is the thing Guideline 5.1.1(v) exists to prevent.
        var signOut: @Sendable () async -> Bool
        var newIdempotencyKey: @Sendable () -> String
        /// Reads the key an earlier attempt left behind. Without this, a seller
        /// who leaves the tail and comes back mints a key the server must
        /// reject, and the account becomes undeletable from the app.
        var loadIdempotencyKey: @Sendable () -> String?
        var rememberIdempotencyKey: @Sendable (String) -> Void
        var forgetIdempotencyKey: @Sendable () -> Void
        /// Waits before asking again. Each request re-runs the server's whole
        /// erase pipeline, provider calls included, so back-to-back follow-ups
        /// would multiply that work for no extra information.
        var waitBeforeFollowUp: @Sendable (Int) async -> Void
        /// How many times one deletion attempt will re-ask before it stops and
        /// hands the seller the asking. Bounded because the app is not the
        /// thing doing the work and an unbounded loop would be a promise.
        var maximumStatusFollowUps: Int

        init(
            requestErasure: @escaping @Sendable (String) async
                -> AccountErasureOutcome,
            clearDeviceState: @escaping @Sendable () async -> Bool,
            signOut: @escaping @Sendable () async -> Bool,
            newIdempotencyKey: @escaping @Sendable () -> String,
            loadIdempotencyKey: @escaping @Sendable () -> String? = { nil },
            rememberIdempotencyKey: @escaping @Sendable (String) -> Void = { _ in },
            forgetIdempotencyKey: @escaping @Sendable () -> Void = {},
            waitBeforeFollowUp: @escaping @Sendable (Int) async -> Void = { _ in },
            maximumStatusFollowUps: Int
        ) {
            self.requestErasure = requestErasure
            self.clearDeviceState = clearDeviceState
            self.signOut = signOut
            self.newIdempotencyKey = newIdempotencyKey
            self.loadIdempotencyKey = loadIdempotencyKey
            self.rememberIdempotencyKey = rememberIdempotencyKey
            self.forgetIdempotencyKey = forgetIdempotencyKey
            self.waitBeforeFollowUp = waitBeforeFollowUp
            self.maximumStatusFollowUps = maximumStatusFollowUps
        }
    }

    private(set) var phase: AccountDeletionPhase = .confirming
    private let dependencies: Dependencies

    /// Minted once per deletion and reused by every follow-up and retry.
    /// `begin_account_erasure` resolves a repeated key to the same generation,
    /// so reuse is what makes an interrupted deletion resumable rather than
    /// restartable. A fresh key would either open a second erasure or earn the
    /// 409 the handler raises for a key already bound elsewhere.
    private var idempotencyKey: String?

    /// Set when the server reported a terminal status. Once this holds a value
    /// the deletion is done server-side and only this device's copies remain,
    /// so a retry must not spend another request re-asking about an account
    /// that no longer exists.
    private var confirmedRetainedRecords: [AccountErasureRetainedRecord]?

    init(dependencies: Dependencies) {
        self.dependencies = dependencies
    }

    func deleteAccount() async {
        if let confirmedRetainedRecords {
            await clearDeviceAndFinish(retainedRecords: confirmedRetainedRecords)
            return
        }

        let key = resolvedIdempotencyKey()

        phase = .requesting
        var outcome = await dependencies.requestErasure(key)
        var followUps = 0
        while outcome == .pending, followUps < dependencies.maximumStatusFollowUps {
            followUps += 1
            await dependencies.waitBeforeFollowUp(followUps)
            outcome = await dependencies.requestErasure(key)
        }
        await apply(outcome)
    }

    /// The key this account's erasure is bound to, whichever attempt minted it.
    /// A key is written down before it is ever sent, because a key that reached
    /// the server and was not recorded is exactly the one that causes the 409.
    private func resolvedIdempotencyKey() -> String {
        if let idempotencyKey { return idempotencyKey }
        if let persisted = dependencies.loadIdempotencyKey() {
            idempotencyKey = persisted
            return persisted
        }
        let fresh = dependencies.newIdempotencyKey()
        dependencies.rememberIdempotencyKey(fresh)
        idempotencyKey = fresh
        return fresh
    }

    /// Asks again for the same deletion. Never starts a second one.
    func retry() async {
        await deleteAccount()
    }

    private func apply(_ outcome: AccountErasureOutcome) async {
        switch outcome {
        case .completed(let retainedRecords):
            confirmedRetainedRecords = retainedRecords
            await clearDeviceAndFinish(retainedRecords: retainedRecords)
        case .pending:
            phase = .unfinished
        case .needsAttention:
            phase = .stalled(.needsAttention)
        case .notConfirmed(.reverificationRequired):
            phase = .reverificationExpired
        case .notConfirmed(.idempotencyKeyConflict):
            phase = .stalled(.keyConflict)
        case .notConfirmed(.clientNotConfigured):
            phase = .stalled(.appNotConfigured)
        case .notConfirmed(.serverUnavailable), .notConfirmed(.transport):
            phase = .failed
        }
    }

    private func clearDeviceAndFinish(
        retainedRecords: [AccountErasureRetainedRecord]
    ) async {
        phase = .clearingDevice
        guard await dependencies.clearDeviceState() else {
            phase = .deviceNotCleared
            return
        }
        // Sign-out is last and its result is checked. It is a network call made
        // straight after a sequence that may have just failed over a bad
        // connection, and Clerk keeps its session in its own Keychain item that
        // nothing else here removes. DEL-08 is the one state allowed to claim
        // completion, so it never runs on an unverified sign-out.
        guard await dependencies.signOut() else {
            phase = .deviceNotCleared
            return
        }
        dependencies.forgetIdempotencyKey()
        phase = .deleted(retainedRecords: retainedRecords)
    }
}
