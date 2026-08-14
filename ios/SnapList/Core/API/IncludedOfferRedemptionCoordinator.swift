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

    init(
        redemption: IncludedOfferRedemption,
        store: IncludedOfferRedemptionStore,
        newIdempotencyKey: @escaping @Sendable () -> String = {
            UUID().uuidString.lowercased()
        },
        waitBeforeFollowUp: @escaping @Sendable (Int) async -> Void = { milliseconds in
            try? await Task.sleep(
                nanoseconds: UInt64(max(0, milliseconds)) * 1_000_000
            )
        },
        maximumFollowUps: Int = 4
    ) {
        self.redemption = redemption
        self.store = store
        self.newIdempotencyKey = newIdempotencyKey
        self.waitBeforeFollowUp = waitBeforeFollowUp
        self.maximumFollowUps = maximumFollowUps
    }

    @discardableResult
    func redeem() async -> IncludedOfferRedemptionDisposition {
        let record = store.load()
        if let settled = record?.disposition, settled.isSettled {
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
