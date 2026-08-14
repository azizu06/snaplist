import XCTest

@testable import SnapList

/**
 Issue #848. The account's own included run.

 Every test here drives the shipped `IncludedOfferRedemption` composition — the
 real canonical request bytes, the real DeviceCheck gate, the real outcome
 decoding — against a stubbed `IncludedOfferRedeeming` standing in for the three
 live routes. Only the server's answer is supplied.
 */
final class IncludedOfferRedemptionCoordinatorTests: XCTestCase {
    private static let claimID = "8c7f0b16-0a4e-4d21-9c2a-6b0f4a1d5e33"
    private static let userID = "user_848"

    // MARK: Criterion 1 — a never-redeemed account reaches its included run

    func testASignedInPrincipalWithNoClaimReachesASettledIncludedRun() async {
        let server = IncludedOfferFenceStub(
            redeemOutcome: .queued(claimID: Self.claimID, retryAfterMs: 1),
            claimReads: [.reserved(claimID: Self.claimID)]
        )
        let store = Self.makeStore()
        let coordinator = Self.makeCoordinator(server: server, store: store)

        let disposition = await coordinator.redeem()

        // The fence reserved the run, so the account can submit its item. The
        // claim was opened once and followed to a durable answer rather than
        // left queued.
        XCTAssertEqual(disposition, .granted)
        XCTAssertEqual(server.redeemCallCount, 1)
        XCTAssertEqual(store.load()?.disposition, .granted)
    }

    // MARK: Criterion 2 — a device that already redeemed stays denied

    func testADeviceThatAlreadyRedeemedSettlesDeniedAndIsNeverAskedAgain() async {
        let server = IncludedOfferFenceStub(
            redeemOutcome: .deniedDeviceConsumed(claimID: Self.claimID)
        )
        let store = Self.makeStore()
        let coordinator = Self.makeCoordinator(server: server, store: store)

        let first = await coordinator.redeem()
        let second = await coordinator.redeem()

        // Apple's lifetime bit is durable truth about this hardware, so the
        // answer is recorded and the seller keeps the paid path #845 already
        // routes `device-fence-required` to. Asking a second time could only
        // produce the same refusal.
        XCTAssertEqual(first, .deviceConsumed)
        XCTAssertEqual(second, .deviceConsumed)
        XCTAssertEqual(server.redeemCallCount, 1)
    }

    func testAnAccountThatAlreadySpentItsIncludedRunSettlesDenied() async {
        let server = IncludedOfferFenceStub(
            redeemOutcome: .deniedAccountConsumed
        )
        let store = Self.makeStore()

        let disposition = await Self.makeCoordinator(
            server: server,
            store: store
        ).redeem()

        XCTAssertEqual(disposition, .accountConsumed)
        XCTAssertEqual(store.load()?.disposition, .accountConsumed)
    }

    // MARK: Criterion 4 — hardware with no DeviceCheck states its outcome

    func testADeviceWithoutDeviceCheckStatesItsOutcomeWithoutOpeningAClaim() async {
        let server = IncludedOfferFenceStub(
            redeemOutcome: .reserved(claimID: Self.claimID)
        )
        let store = Self.makeStore()
        let coordinator = Self.makeCoordinator(
            server: server,
            store: store,
            isDeviceCheckSupported: false
        )

        let disposition = await coordinator.redeem()

        // Every Simulator lands here. The answer arrives immediately and from
        // the device, so there is no hang and no silent failure: no claim is
        // opened, nothing is settled, and the seller's next AI item run meets
        // the unchanged fence denial.
        XCTAssertEqual(disposition, .unsupportedDevice)
        XCTAssertEqual(server.redeemCallCount, 0)

        // Not settled on purpose. Hardware that gains the capability, or a
        // build moving from Simulator to device, must not inherit a permanent
        // denial for a promotion it never spent.
        XCTAssertNil(store.load()?.disposition)
    }

    // MARK: Criterion 3 — a transient failure leaves the seller retryable

    func testAPhoneWithNoSignalKeepsTheOfferAndAsksAgainLater() async {
        let offline = IncludedOfferFenceStub(
            redeemFailure: URLError(.notConnectedToInternet)
        )
        let store = Self.makeStore()

        let first = await Self.makeCoordinator(server: offline, store: store)
            .redeem()

        // A network error is not the fence answering. Nothing may be recorded,
        // because a recorded answer here would cost this seller the included
        // run they are owed and send them to buy a subscription instead.
        XCTAssertEqual(first, .retryable)
        XCTAssertNil(store.load()?.disposition)

        // The seller regains signal. The same durable key reaches the fence and
        // the account gets its run.
        let online = IncludedOfferFenceStub(
            redeemOutcome: .reserved(claimID: Self.claimID)
        )
        let second = await Self.makeCoordinator(server: online, store: store)
            .redeem()

        XCTAssertEqual(second, .granted)
        XCTAssertEqual(online.redeemCallCount, 1)
    }

    // MARK: Criterion 5 — exactly once per account

    func testEveryAttemptForOneAccountCarriesTheSameIdempotencyKey() async {
        let store = Self.makeStore()
        // Mints a different key each call, so a coordinator that failed to
        // reuse the stored one would be visible as two keys at the server.
        let mint = SequentialIdempotencyKeys(
            ["first-key-3f2504e0", "second-key-9b1de2f4"]
        )

        let offline = IncludedOfferFenceStub(redeemFailure: URLError(.timedOut))
        _ = await Self.makeCoordinator(
            server: offline,
            store: store,
            newIdempotencyKey: mint.next
        ).redeem()

        let online = IncludedOfferFenceStub(
            redeemOutcome: .reserved(claimID: Self.claimID)
        )
        _ = await Self.makeCoordinator(
            server: online,
            store: store,
            newIdempotencyKey: mint.next
        ).redeem()

        // One key across both attempts. The server collapses a repeat by
        // `unique (user_id, idempotency_key)` and replays the first claim, so
        // reuse is what makes a retry a replay instead of a second claim.
        XCTAssertEqual(offline.idempotencyKeys, ["first-key-3f2504e0"])
        XCTAssertEqual(online.idempotencyKeys, ["first-key-3f2504e0"])
    }

    // MARK: The bounded Apple rendezvous

    func testAClaimAwaitingADeviceTokenIsAnsweredAndFollowedToItsGrant() async {
        let server = IncludedOfferFenceStub(
            redeemOutcome: .deviceTokenRequired(
                claimID: Self.claimID,
                tokenDeadlineAt: "2026-08-15T00:00:00.000Z"
            ),
            deviceTokenOutcome: .reserved(claimID: Self.claimID)
        )
        let store = Self.makeStore()

        let disposition = await Self.makeCoordinator(
            server: server,
            store: store
        ).redeem()

        XCTAssertEqual(disposition, .granted)
        XCTAssertEqual(server.deviceTokenCallCount, 1)
    }

    func testAFenceThatGaveUpOnAppleIsRecordedRatherThanAskedForever() async {
        let server = IncludedOfferFenceStub(
            redeemOutcome: .deniedAppleUnavailable(claimID: Self.claimID)
        )
        let store = Self.makeStore()

        let disposition = await Self.makeCoordinator(
            server: server,
            store: store
        ).redeem()

        // This one carries `appealPath: "support-override"`, and the claim it
        // names is already terminal. Re-asking under the same durable key only
        // replays it, so the honest move is to stop and leave the seller the
        // paid path the fence itself offers.
        XCTAssertEqual(disposition, .appleUnavailable)
        XCTAssertEqual(store.load()?.disposition, .appleUnavailable)
    }

    func testAClaimThatNeverSettlesStopsFollowingAndKeepsTheOffer() async {
        // The stub runs out of scripted reads and reports queued forever.
        let server = IncludedOfferFenceStub(
            redeemOutcome: .queued(claimID: Self.claimID, retryAfterMs: 1)
        )
        let store = Self.makeStore()

        let disposition = await Self.makeCoordinator(
            server: server,
            store: store
        ).redeem()

        // Bounded, because the app is not the thing doing the work. Stopping
        // records nothing, so the next sign-in or launch picks the same claim
        // back up under the same key.
        XCTAssertEqual(disposition, .retryable)
        XCTAssertEqual(server.claimReadCallCount, 4)
        XCTAssertNil(store.load()?.disposition)
    }

    // MARK: The call site — one redemption per signed-in principal

    func testRedemptionFollowsTheVerifiedPrincipalRatherThanAnySignInScreen() async {
        let redeemed = RecordedPrincipals()

        await IncludedOfferRedemptionComposition.drive(
            principals: AsyncStream { continuation in
                // A guest launch, then a sign-in, then two more auth events for
                // the same account, then a different account on this device.
                continuation.yield(nil)
                continuation.yield("user_a")
                continuation.yield("user_a")
                continuation.yield("  ")
                continuation.yield("user_b")
                continuation.finish()
            },
            redeem: { await redeemed.record($0) }
        )

        // A guest has no account to redeem for, a repeated auth event for the
        // account already handled is not a second sign-in, and a blank subject
        // is not a principal. A genuinely different account gets its own run.
        let principals = await redeemed.principals
        XCTAssertEqual(principals, ["user_a", "user_b"])
    }

    // MARK: Helpers

    private static func makeStore(
        userID: String = userID
    ) -> IncludedOfferRedemptionStore {
        IncludedOfferRedemptionStore(
            userID: userID,
            defaults: UserDefaults(
                suiteName: "dev.snaplist.tests.included-offer.\(UUID().uuidString)"
            )!
        )
    }

    private static func makeCoordinator(
        server: IncludedOfferFenceStub,
        store: IncludedOfferRedemptionStore,
        isDeviceCheckSupported: Bool = true,
        deviceToken: Data? = Data("device-token".utf8),
        proof: AppAttestProofOutcome = .proof(AppAttestAssertionProof(
            assertionObject: Data("assertion".utf8),
            challengeID: UUID(uuidString: "00000000-0000-4000-8000-000000000331")!,
            keyID: "native-fixed-key-id"
        )),
        newIdempotencyKey: @escaping @Sendable () -> String = {
            "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
        },
        userID: String = userID
    ) -> IncludedOfferRedemptionCoordinator {
        IncludedOfferRedemptionCoordinator(
            redemption: IncludedOfferRedemption(
                attest: FixedAppAttestProofProvider(outcome: proof),
                client: server,
                deviceCheck: FixedDeviceCheckTokenProvider(
                    isSupported: isDeviceCheckSupported,
                    token: deviceToken
                ),
                userID: userID
            ),
            store: store,
            newIdempotencyKey: newIdempotencyKey,
            // The real gap is the server's `retryAfterMs`. Collapsing it keeps
            // the follow-up ordering under test without spending it in wall
            // clock.
            waitBeforeFollowUp: { _ in }
        )
    }
}

/// The three live routes, scripted. `claimReads` is consumed in order so a
/// queued claim can be followed to whatever the fence settles it to.
private final class IncludedOfferFenceStub: IncludedOfferRedeeming, @unchecked Sendable {
    private let lock = NSLock()
    private let redeemOutcome: Result<IncludedOfferOutcome, any Error>
    private let deviceTokenOutcome: Result<IncludedOfferOutcome, any Error>
    private var pendingClaimReads: [Result<IncludedOfferOutcome, any Error>]
    private var redeemCalls = 0
    private var deviceTokenCalls = 0
    private var claimReadCalls = 0
    private var seenIdempotencyKeys: [String] = []

    var redeemCallCount: Int { lock.withLock { redeemCalls } }
    var deviceTokenCallCount: Int { lock.withLock { deviceTokenCalls } }
    var claimReadCallCount: Int { lock.withLock { claimReadCalls } }
    var idempotencyKeys: [String] { lock.withLock { seenIdempotencyKeys } }

    init(
        redeemOutcome: IncludedOfferOutcome,
        claimReads: [IncludedOfferOutcome] = [],
        deviceTokenOutcome: IncludedOfferOutcome = .reserved(
            claimID: "8c7f0b16-0a4e-4d21-9c2a-6b0f4a1d5e33"
        )
    ) {
        self.redeemOutcome = .success(redeemOutcome)
        self.deviceTokenOutcome = .success(deviceTokenOutcome)
        pendingClaimReads = claimReads.map { .success($0) }
    }

    init(
        redeemFailure: any Error,
        claimReads: [IncludedOfferOutcome] = []
    ) {
        redeemOutcome = .failure(redeemFailure)
        deviceTokenOutcome = .failure(redeemFailure)
        pendingClaimReads = claimReads.map { .success($0) }
    }

    func redeemIncludedOffer(
        idempotencyKey: String,
        proof: AppAttestProofPayload
    ) async throws -> IncludedOfferOutcome {
        lock.withLock {
            redeemCalls += 1
            seenIdempotencyKeys.append(idempotencyKey)
        }
        return try redeemOutcome.get()
    }

    func readIncludedOfferClaim(claimID: String) async throws -> IncludedOfferOutcome {
        let next = lock.withLock { () -> Result<IncludedOfferOutcome, any Error>? in
            claimReadCalls += 1
            return pendingClaimReads.isEmpty ? nil : pendingClaimReads.removeFirst()
        }
        // Running out of scripted reads means the claim never settled, which is
        // exactly what a claim still in flight looks like.
        guard let next else {
            return .queued(claimID: claimID, retryAfterMs: 1)
        }
        return try next.get()
    }

    func submitIncludedOfferDeviceToken(
        claimID: String,
        deviceToken: String,
        proof: AppAttestProofPayload
    ) async throws -> IncludedOfferOutcome {
        lock.withLock { deviceTokenCalls += 1 }
        return try deviceTokenOutcome.get()
    }
}

private actor RecordedPrincipals {
    private(set) var principals: [String] = []

    func record(_ principal: String) {
        principals.append(principal)
    }
}

/// Hands out a different key per call, so failing to reuse the stored one shows
/// up as two distinct keys arriving at the server.
private final class SequentialIdempotencyKeys: @unchecked Sendable {
    private let lock = NSLock()
    private var remaining: [String]

    init(_ keys: [String]) {
        remaining = keys
    }

    var next: @Sendable () -> String {
        { [self] in
            lock.withLock {
                remaining.isEmpty ? "exhausted" : remaining.removeFirst()
            }
        }
    }
}

private struct FixedDeviceCheckTokenProvider: DeviceCheckTokenProviding {
    let isSupported: Bool
    var token: Data?

    func generateToken() async throws -> Data {
        guard isSupported else { throw DeviceCheckTokenError.unsupportedDevice }
        guard let token else { throw DeviceCheckTokenError.appleServiceUnavailable }
        return token
    }
}

private struct FixedAppAttestProofProvider: AppAttestProofProviding {
    let outcome: AppAttestProofOutcome

    func assertionProof(requestBody: Data) async -> AppAttestProofOutcome {
        outcome
    }
}
