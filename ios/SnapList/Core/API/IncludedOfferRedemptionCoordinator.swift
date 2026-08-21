import Foundation

/**
 Issue #848. What one account's included-offer redemption settled to.

 The distinction that matters is not which answer arrived but whether the fence
 answered at all. Only a server answer is durable truth about the promotion; a
 phone with no signal has proved nothing, and recording it as an answer would
 spend an included run the seller never received.
 */
enum IncludedOfferRedemptionDisposition: String, Codable, Equatable, Sendable {
    /// The fence reserved the included run. The account can submit its item.
    case granted
    /// Apple's lifetime bit is already set for this hardware.
    case deviceConsumed
    /// This account already spent its included run.
    case accountConsumed
    /// The fence gave up on Apple for this claim. It carries a support appeal
    /// rather than a client retry, so asking again with the same key only
    /// replays it.
    case appleUnavailable
    /// `DCDevice.isSupported` is false. No claim was opened and none can be.
    case unsupportedDevice
    /// Nothing was proved either way. The account keeps its offer.
    case retryable

    /// Whether this answer ends the question for this account.
    ///
    /// Exactly the four answers the fence itself produced. `retryable` covers
    /// every failure that never reached the fence, and `unsupportedDevice` is
    /// re-checked because it costs one local boolean and a device that gains
    /// the capability must not stay locked out of a promotion it never spent.
    var isSettled: Bool {
        switch self {
        case .granted, .deviceConsumed, .accountConsumed, .appleUnavailable:
            true
        case .unsupportedDevice, .retryable:
            false
        }
    }
}

/// What this device durably knows about one account's redemption.
struct IncludedOfferRedemptionRecord: Equatable, Sendable {
    /// Minted once per account and reused forever.
    ///
    /// The server collapses a repeat by `unique (user_id, idempotency_key)`, so
    /// reuse is what turns a second attempt into a replay of the first claim
    /// rather than a second claim.
    let idempotencyKey: String
    /// Absent until the fence answers.
    let disposition: IncludedOfferRedemptionDisposition?
}

/**
 The durable per-account half of exactly-once.

 Keyed by the Clerk subject the way `AccountErasureKeyStore` is, so two accounts
 on one device never share a key and switching accounts cannot inherit the other
 one's settled answer.
 */
struct IncludedOfferRedemptionStore: Sendable {
    /// `UserDefaults` is thread-safe but not marked `Sendable`. This store only
    /// reads and writes two small values, and the alternative is giving up
    /// injection and hard-coding `.standard`.
    private nonisolated(unsafe) let defaults: UserDefaults
    private let keyStorageKey: String
    private let dispositionStorageKey: String

    init(userID: String, defaults: UserDefaults = .standard) {
        self.defaults = defaults
        keyStorageKey = "dev.snaplist.ios.included-offer-redemption-key.\(userID)"
        dispositionStorageKey =
            "dev.snaplist.ios.included-offer-redemption-disposition.\(userID)"
    }

    func load() -> IncludedOfferRedemptionRecord? {
        guard let key = defaults.string(forKey: keyStorageKey) else { return nil }
        return IncludedOfferRedemptionRecord(
            idempotencyKey: key,
            disposition: defaults.string(forKey: dispositionStorageKey)
                .flatMap(IncludedOfferRedemptionDisposition.init(rawValue:))
        )
    }

    func rememberKey(_ key: String) {
        defaults.set(key, forKey: keyStorageKey)
    }

    func settle(_ disposition: IncludedOfferRedemptionDisposition) {
        defaults.set(disposition.rawValue, forKey: dispositionStorageKey)
    }

    /// Issue #854 item 3. Takes both keys back when the account is gone.
    ///
    /// Modelled on `AccountErasureKeyStore.forget()`, and needed for the same
    /// reason: these values are scoped by the Clerk subject, so a deleted
    /// account's id survives erasure unless the device clear names this store.
    /// The disposition goes with the key, or a later key minted for a reused
    /// subject would inherit an answer it never earned.
    func forget() {
        defaults.removeObject(forKey: keyStorageKey)
        defaults.removeObject(forKey: dispositionStorageKey)
    }
}

/**
 Issue #854 item 1. What one completed drive of `redeem()` is worth telling the
 operator.

 The disposition alone cannot separate the two failures that matter. An account
 that reached the fence and was refused looks identical, at the seller, to one
 whose claim never settled inside its follow-up budget — and only the second is
 the shape of a seller who can never reach their included run. `followUps`
 carries that difference: `nil` when the durable record answered with no
 request at all, otherwise how many follow-ups this drive spent.

 Deliberately no subject, claim id, or idempotency key. This is a health signal
 about whether the free listing is reachable, not a record of who asked.
 */
struct IncludedOfferRedemptionReport: Equatable, Sendable {
    let disposition: IncludedOfferRedemptionDisposition
    let followUps: Int?
}

/**
 Where redemption is driven from.

 It keys on the verified Clerk principal, not on any sign-in screen, because a
 seller reaches a signed-in state by more than one route and a screen-shaped
 trigger silently misses the others:

 - the account entry inside the eBay publish flow, which is the only path
   `AccountEntrySessionResolver` covers;
 - `AccountEntryView`, presented as a sheet whenever a guest opens the account
   row in Settings, which never touches the guest-claim state machine at all;
 - a launch on which Clerk restored a session from its own Keychain, where no
   sign-in happens and no event is emitted.

 The last one is what makes a launch-only or sign-in-only hook wrong. A seller
 whose first redemption failed while they had no signal is signed in on every
 later launch and would never be asked again.

 Redemption is therefore attempted for whoever is signed in now, and again
 whenever the verified principal becomes a different one. Everything that makes
 that safe to repeat lives in `IncludedOfferRedemptionCoordinator`: a settled
 account returns from the durable record without a request, and an unsettled one
 re-presents the same idempotency key so the fence replays its claim.
 */
enum IncludedOfferRedemptionComposition {
    /// Drives one redemption per distinct signed-in principal.
    ///
    /// A `nil` or blank element is a guest, which has no account to redeem for
    /// and is fenced by its own App Attest allowance instead. A repeat of the
    /// principal already handled is an auth event, not a second sign-in.
    static func drive(
        principals: AsyncStream<String?>,
        redeem: @Sendable (String) async -> Void
    ) async {
        var handled: String?
        for await principal in principals {
            guard let principal = principal?.trimmingCharacters(
                in: .whitespacesAndNewlines
            ), !principal.isEmpty, principal != handled else {
                continue
            }
            handled = principal
            await redeem(principal)
        }
    }
}

/**
 Issue #854 item 4. One redemption drive per process.

 `IncludedOfferRedemptionComposition.drive` carries its `handled` set in
 memory, so a second drive is a second set: both would redeem for the same
 principal, mint two idempotency keys, and open two claims that
 `unique (user_id, idempotency_key)` cannot collapse into one.

 A latch rather than per-account serialization because the second caller is
 unreachable today — `UIApplicationSupportsMultipleScenes` is true, but
 `TARGETED_DEVICE_FAMILY = 1` means there is no second scene on iPhone to fire
 a second `.task` from. This closes the shape without building for a caller
 that does not exist.

 `@MainActor` is the mutual exclusion: `start` is only ever reached from the
 scene body, so the check and the store cannot interleave.
 */
@MainActor
final class IncludedOfferRedemptionDrive {
    private var drive: Task<Void, Never>?

    init() {}

    /// The running drive, started now if there is not one already.
    @discardableResult
    func start(
        _ work: @escaping @Sendable () async -> Void
    ) -> Task<Void, Never> {
        if let drive { return drive }
        let started = Task { await work() }
        drive = started
        return started
    }
}

/**
 Drives one account's included-offer redemption to a durable answer.

 Nothing here decides whether the promotion is owed. It produces the evidence
 the fence has always required from a client and follows the claim the fence
 opens, which is the piece that was missing: the three routes and the two Apple
 primitives were both already built, and no feature code ever called them, so
 every authenticated seller was device-denied by construction.
 */
struct IncludedOfferRedemptionCoordinator: Sendable {
    private let redemption: IncludedOfferRedemption
    private let store: IncludedOfferRedemptionStore
    private let newIdempotencyKey: @Sendable () -> String
    private let waitBeforeFollowUp: @Sendable (_ milliseconds: Int) async -> Void
    private let maximumFollowUps: Int
    private let report: @Sendable (IncludedOfferRedemptionReport) -> Void

    /// The longest this client will wait between follow-ups.
    ///
    /// The fence sends 2000. A minute is far enough above that to be no
    /// constraint on it, and near enough to keep a launch from parking on a
    /// value nobody meant to send.
    static let maximumFollowUpDelayMilliseconds = 60_000

    /**
     Issue #854 item 2. Turns the server's `retryAfterMs` into a sleep.

     `retryAfterMs` decodes as an unbounded `Int`
     (`MobileAPIModels.swift`), and `UInt64(milliseconds) * 1_000_000` traps
     above roughly 1.8e13. Only SnapList's own fence feeds this and it only
     sends 2000, so there is no live path — but the clamp is one expression and
     the alternative is a crash on a value the client never validated.
     */
    static func followUpNanoseconds(forRetryAfterMs milliseconds: Int) -> UInt64 {
        let bounded = min(
            max(0, milliseconds),
            maximumFollowUpDelayMilliseconds
        )
        return UInt64(bounded) * 1_000_000
    }

    init(
        redemption: IncludedOfferRedemption,
        store: IncludedOfferRedemptionStore,
        report: @escaping @Sendable (IncludedOfferRedemptionReport) -> Void,
        newIdempotencyKey: @escaping @Sendable () -> String = {
            UUID().uuidString.lowercased()
        },
        waitBeforeFollowUp: @escaping @Sendable (Int) async -> Void = { milliseconds in
            try? await Task.sleep(
                nanoseconds: Self.followUpNanoseconds(
                    forRetryAfterMs: milliseconds
                )
            )
        },
        maximumFollowUps: Int = 4
    ) {
        self.redemption = redemption
        self.store = store
        self.report = report
        self.newIdempotencyKey = newIdempotencyKey
        self.waitBeforeFollowUp = waitBeforeFollowUp
        self.maximumFollowUps = maximumFollowUps
    }

    @discardableResult
    func redeem() async -> IncludedOfferRedemptionDisposition {
        let record = store.load()
        if let settled = record?.disposition, settled.isSettled {
            report(.init(disposition: settled, followUps: nil))
            return settled
        }

        // Persist before the first request, not after it. A key minted, spent
        // on a request and then lost to a crash would be replaced on the next
        // attempt, and two different keys are two claims that
        // `unique (user_id, idempotency_key)` cannot collapse into one.
        let idempotencyKey = record?.idempotencyKey ?? newIdempotencyKey()
        store.rememberKey(idempotencyKey)

        var result = await redemption.redeem(idempotencyKey: idempotencyKey)
        var followUps = 0
        while followUps < maximumFollowUps, let next = followUp(after: result) {
            followUps += 1
            switch next {
            case .read(let claimID, let retryAfterMs):
                await waitBeforeFollowUp(retryAfterMs)
                result = await redemption.readClaim(claimID: claimID)
            case .answerRendezvous(let claimID):
                result = await redemption.answerTokenRendezvous(claimID: claimID)
            }
        }

        let disposition = Self.disposition(for: result)
        if disposition.isSettled {
            store.settle(disposition)
        }
        // #854 item 1. Every drive says how it ended, settled or not. Before
        // this the disposition was discarded at the call site and nothing was
        // logged, so a seller permanently stuck on `.retryable` produced no
        // signal at all on the one path that decides whether the free listing
        // is reachable.
        report(.init(disposition: disposition, followUps: followUps))
        return disposition
    }

    private enum FollowUp {
        case read(claimID: String, retryAfterMs: Int)
        case answerRendezvous(claimID: String)
    }

    private func followUp(
        after result: IncludedOfferRedemption.Result
    ) -> FollowUp? {
        guard case .outcome(let outcome) = result else { return nil }
        switch outcome {
        case .queued(let claimID, let retryAfterMs),
             .retryRequired(let claimID, _, let retryAfterMs):
            return .read(claimID: claimID, retryAfterMs: retryAfterMs)
        case .deviceTokenRequired(let claimID, _):
            return .answerRendezvous(claimID: claimID)
        case .reserved, .deniedDeviceConsumed, .deniedAccountConsumed,
             .deniedAppleUnavailable, .invalidProof, .claimNotFound:
            return nil
        }
    }

    /// Listed rather than defaulted on the outcome side: a new fence answer must
    /// be a compile error here, not something that quietly settles the seller's
    /// only included run.
    private static func disposition(
        for result: IncludedOfferRedemption.Result
    ) -> IncludedOfferRedemptionDisposition {
        switch result {
        case .outcome(let outcome):
            switch outcome {
            case .reserved:
                return .granted
            case .deniedDeviceConsumed:
                return .deviceConsumed
            case .deniedAccountConsumed:
                return .accountConsumed
            case .deniedAppleUnavailable:
                return .appleUnavailable
            case .queued, .deviceTokenRequired, .retryRequired,
                 .invalidProof, .claimNotFound:
                // The claim is alive but unsettled, or the fence refused this
                // attempt's evidence. Neither is proof the offer is spent.
                return .retryable
            }
        case .deviceUnsupported:
            return .unsupportedDevice
        case .deviceTokenUnavailable, .transportUnavailable,
             .proofUnavailable, .proofInvalid:
            // Nothing reached the fence, or Apple could not answer right now.
            // The account keeps its offer.
            return .retryable
        }
    }
}
