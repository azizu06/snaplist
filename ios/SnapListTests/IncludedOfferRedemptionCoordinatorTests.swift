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

    /// #854 item 5. Every suite this class mints, so `tearDown` can take them
    /// back. `UserDefaults(suiteName:)` writes a plist under the test host's
    /// preferences the moment anything is set, and a suite named by a fresh
    /// `UUID` is never reused, so without this every invocation of this file
    /// leaves one more domain behind on the machine that ran it.
    private var mintedSuiteNames: [String] = []

    override func tearDown() {
        for name in mintedSuiteNames {
            UserDefaults(suiteName: name)?.removePersistentDomain(forName: name)
        }
        mintedSuiteNames = []
        super.tearDown()
    }

    // MARK: Criterion 1 — a never-redeemed account reaches its included run

    func testASignedInPrincipalWithNoClaimReachesASettledIncludedRun() async {
        let server = IncludedOfferFenceStub(
            redeemOutcome: .queued(claimID: Self.claimID, retryAfterMs: 1),
            claimReads: [.reserved(claimID: Self.claimID)]
        )
        let store = makeStore()
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
        let store = makeStore()
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
        let store = makeStore()

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
        let store = makeStore()
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
        let store = makeStore()

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
        let store = makeStore()
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
        let store = makeStore()

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
        let store = makeStore()

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
        let store = makeStore()

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

    // MARK: #854 — a signed-in installation that missed enrollment recovers

    /**
     The parent commit's exact answer for the stuck population, quoted.

     One failed first launch leaves no App Attest key behind. Guest enrollment
     never runs again once an account exists, so this is what every later
     redemption attempt asks for and receives, forever.
     */
    func testAnInstallationWithNoVerifiedKeyCannotProveItselfToTheFence() async {
        let keys = AppAttestKeyStoreSpy()

        let outcome = await Self.makeAppAttestClient(keyStore: keys)
            .assertionProof(requestBody: Data("included-offer.redeem".utf8))

        XCTAssertEqual(outcome, .invalid(.missingVerifiedKey))
    }

    /// And what the coordinator makes of that answer: a retry that can only
    /// ever produce the same one.
    func testThatUnprovableInstallationIsWhatStrandsTheAccountOnRetryable() async {
        let server = IncludedOfferFenceStub(
            redeemOutcome: .reserved(claimID: Self.claimID)
        )

        let disposition = await Self.makeCoordinator(
            server: server,
            store: makeStore(),
            proof: .invalid(.missingVerifiedKey)
        ).redeem()

        XCTAssertEqual(disposition, .retryable)
        XCTAssertEqual(server.redeemCallCount, 0)
    }

    /**
     The load-bearing one: the same installation, now signed in, reaches its
     included run.

     The gate is `.invalid(.missingVerifiedKey)` — no verified key exists —
     rather than "signed in", so recovery is demand-driven and self-limiting.
     */
    func testASellerWhoSignsInAfterAFailedEnrollmentReachesTheirIncludedRun() async {
        let keys = AppAttestKeyStoreSpy()
        let service = AppAttestServiceSpy()
        let client = Self.makeAppAttestClient(keyStore: keys, service: service)
        let server = IncludedOfferFenceStub(
            redeemOutcome: .reserved(claimID: Self.claimID)
        )

        let disposition = await Self.makeCoordinator(
            server: server,
            store: makeStore(),
            attest: Self.makeRecoveringProofProvider(client: client)
        ).redeem()

        // One key, earned once, and the fence answered the proof it produced.
        XCTAssertEqual(disposition, .granted)
        XCTAssertEqual(keys.key, AppAttestStoredKey(id: "native-fixed-key-id", state: .verified))
        XCTAssertEqual(service.generateKeyCallCount, 1)
        XCTAssertEqual(server.redeemCallCount, 1)
    }

    /**
     The other stuck shape: an attestation the server verified whose local
     `.verified` flip failed, leaving a pending key behind.

     Recovery resumes that key rather than minting a second one — every extra
     App Attest key is an extra guest tenant, because the server derives the
     guest tenant from `sha256(appId‖keyId)` — and declines custody of the
     capability the resumed assertion earns, so the account path never writes
     the guest store it shares with the signed-out composition.
     */
    func testRecoveryResumesAPendingKeyAndDeclinesTheCapabilityItEarns() async {
        let keys = AppAttestKeyStoreSpy(
            key: AppAttestStoredKey(id: "native-fixed-key-id", state: .pending)
        )
        let guestCapabilities = GuestCapabilityStoreSpy()
        let service = AppAttestServiceSpy()
        let client = Self.makeAppAttestClient(
            keyStore: keys,
            guestCapabilityStore: guestCapabilities,
            service: service,
            server: AppAttestServerSpy(
                assertionTruth: .verified(.init(
                    counter: 1,
                    environment: .production,
                    guestCapability: GuestCapabilityBearer(
                        expiresAt: Date(timeIntervalSince1970: 1_800_001_800),
                        token: "guestcap_\(String(repeating: "a", count: 43))"
                    ),
                    keyID: "native-fixed-key-id",
                    kind: .assertion
                ))
            )
        )

        let disposition = await Self.makeCoordinator(
            server: IncludedOfferFenceStub(
                redeemOutcome: .reserved(claimID: Self.claimID)
            ),
            store: makeStore(),
            attest: Self.makeRecoveringProofProvider(client: client)
        ).redeem()

        XCTAssertEqual(disposition, .granted)
        XCTAssertEqual(keys.key, AppAttestStoredKey(id: "native-fixed-key-id", state: .verified))
        // No second key, so no second guest tenant.
        XCTAssertEqual(service.generateKeyCallCount, 0)
        // And no guest bearer written over the signed-out seller's own.
        XCTAssertEqual(guestCapabilities.saved, [])
    }

    /**
     An installation that already holds a verified key never re-attests.

     `.missingVerifiedKey` is the only trigger, and a verified key cannot
     produce it, so the key this installation presents to the fence is the one
     it has always presented. Rotation here would silently retire the guest
     tenant the seller's own allowance is filed under.
     */
    func testAnInstallationThatAlreadyHasAVerifiedKeyIsNeverReAttested() async {
        let keys = AppAttestKeyStoreSpy(
            key: AppAttestStoredKey(id: "native-fixed-key-id", state: .verified)
        )
        let service = AppAttestServiceSpy()
        let recoveries = CallCounter()
        let client = Self.makeAppAttestClient(keyStore: keys, service: service)

        let disposition = await Self.makeCoordinator(
            server: IncludedOfferFenceStub(
                redeemOutcome: .reserved(claimID: Self.claimID)
            ),
            store: makeStore(),
            attest: Self.makeRecoveringProofProvider(
                client: client,
                onRecover: { recoveries.increment() }
            )
        ).redeem()

        XCTAssertEqual(disposition, .granted)
        XCTAssertEqual(recoveries.count, 0)
        XCTAssertEqual(service.generateKeyCallCount, 0)
        XCTAssertEqual(keys.savedKeys, [])
    }

    /**
     At most one attestation per process, however many proofs are asked for.

     One `redeem()` can ask for two — the claim and the token rendezvous — and
     a launch can drive more than one principal. Each extra attestation on a
     launch whose first one failed is another Apple key generation, and every
     key that survives is another guest tenant.
     */
    func testRecoveryAttestsAtMostOncePerProcess() async {
        let keys = AppAttestKeyStoreSpy()
        let recoveries = CallCounter()
        let client = Self.makeAppAttestClient(
            keyStore: keys,
            // Nothing reaches the server, so the key store is still empty when
            // the second proof is asked for.
            server: AppAttestServerSpy(challengeError: URLError(.notConnectedToInternet))
        )
        let provider = Self.makeRecoveringProofProvider(
            client: client,
            onRecover: { recoveries.increment() }
        )

        let first = await provider.assertionProof(requestBody: Data("claim".utf8))
        let second = await provider.assertionProof(requestBody: Data("token".utf8))

        XCTAssertEqual(first, .invalid(.missingVerifiedKey))
        XCTAssertEqual(second, .invalid(.missingVerifiedKey))
        XCTAssertEqual(recoveries.count, 1)
    }

    /// A recovery that cannot produce a verified key returns the installation's
    /// own answer rather than inventing a different one.
    func testARecoveryThatFailsLeavesTheOriginalOutcomeUntouched() async {
        let client = Self.makeAppAttestClient(
            keyStore: AppAttestKeyStoreSpy(),
            service: AppAttestServiceSpy(isSupported: false)
        )

        let outcome = await Self.makeRecoveringProofProvider(client: client)
            .assertionProof(requestBody: Data("claim".utf8))

        XCTAssertEqual(outcome, .unavailable(.unsupportedDevice))
    }

    // MARK: #854 item 1 — the disposition reaches an operator

    func testASettledRedemptionReportsItsDispositionAndFollowUpCount() async {
        let reports = RecordedReports()

        let disposition = await Self.makeCoordinator(
            server: IncludedOfferFenceStub(
                redeemOutcome: .queued(claimID: Self.claimID, retryAfterMs: 1),
                claimReads: [.reserved(claimID: Self.claimID)]
            ),
            store: makeStore(),
            report: { reports.record($0) }
        ).redeem()

        XCTAssertEqual(disposition, .granted)
        XCTAssertEqual(
            reports.all,
            [IncludedOfferRedemptionReport(disposition: .granted, followUps: 1)]
        )
    }

    /// The shape a permanently stuck seller makes: the whole follow-up budget
    /// spent and still nothing settled. Without this the one path that decides
    /// whether the free listing is reachable produces no signal at all.
    func testARedemptionThatNeverSettlesReportsItsExhaustedFollowUps() async {
        let reports = RecordedReports()

        let disposition = await Self.makeCoordinator(
            server: IncludedOfferFenceStub(
                redeemOutcome: .queued(claimID: Self.claimID, retryAfterMs: 1)
            ),
            store: makeStore(),
            report: { reports.record($0) }
        ).redeem()

        XCTAssertEqual(disposition, .retryable)
        XCTAssertEqual(
            reports.all,
            [IncludedOfferRedemptionReport(disposition: .retryable, followUps: 4)]
        )
    }

    /// An answer that came from the durable record carries no follow-up count,
    /// because no request was made.
    func testAnAlreadySettledRedemptionReportsWithoutAFollowUpCount() async {
        let reports = RecordedReports()
        let store = makeStore()
        store.rememberKey("3f2504e0-4f89-41d3-9a0c-0305e82c3301")
        store.settle(.deviceConsumed)

        let disposition = await Self.makeCoordinator(
            server: IncludedOfferFenceStub(
                redeemOutcome: .reserved(claimID: Self.claimID)
            ),
            store: store,
            report: { reports.record($0) }
        ).redeem()

        XCTAssertEqual(disposition, .deviceConsumed)
        XCTAssertEqual(
            reports.all,
            [IncludedOfferRedemptionReport(disposition: .deviceConsumed, followUps: nil)]
        )
    }

    // MARK: #854 item 2 — the server's delay cannot trap

    func testTheFollowUpDelayIsClampedBeforeTheMultiply() {
        let perMillisecond: UInt64 = 1_000_000
        let clamp = IncludedOfferRedemptionCoordinator.followUpNanoseconds(forRetryAfterMs:)

        // What the fence actually sends.
        XCTAssertEqual(clamp(2_000), 2_000 * perMillisecond)
        // A negative delay is not a delay.
        XCTAssertEqual(clamp(-1), 0)
        // One below the ceiling still scales.
        XCTAssertEqual(clamp(59_999), 59_999 * perMillisecond)
        // At the ceiling, and above it, the multiply never sees the raw value.
        // `retryAfterMs` decodes as an unbounded `Int`, so `Int.max` is the
        // value that traps without this.
        XCTAssertEqual(clamp(60_000), 60_000 * perMillisecond)
        XCTAssertEqual(clamp(.max), 60_000 * perMillisecond)
    }

    // MARK: #854 item 3 — a deleted account leaves nothing behind

    func testForgettingARedemptionLeavesNothingForTheDeletedSubject() {
        let store = makeStore()
        store.rememberKey("3f2504e0-4f89-41d3-9a0c-0305e82c3301")
        store.settle(.granted)

        store.forget()

        XCTAssertNil(store.load())
        // Both keys, not just the one `load()` gates on: a disposition left
        // behind would rejoin the next key minted for this subject.
        store.rememberKey("3f2504e0-4f89-41d3-9a0c-0305e82c3301")
        XCTAssertNil(store.load()?.disposition)
    }

    // MARK: #854 item 4 — one drive per process

    @MainActor
    func testASecondStartJoinsTheDriveAlreadyRunningRatherThanOpeningAnother()
        async {
        let drives = CallCounter()
        let launch = IncludedOfferRedemptionDrive()

        let first = launch.start { drives.increment() }
        let second = launch.start { drives.increment() }
        await first.value
        await second.value

        // Two drives would each carry their own in-memory `handled` set, so
        // both would redeem for the same principal, mint two idempotency keys
        // and open two claims that `unique (user_id, idempotency_key)` cannot
        // collapse.
        XCTAssertEqual(drives.count, 1)
        XCTAssertEqual(first, second)
    }

    // MARK: Helpers


    /// The shipped `AppAttestClient`, wired to spies. Only Apple and the
    /// server are stood in for; the key custody and enrollment decisions under
    /// test are the real ones.
    private static func makeAppAttestClient(
        keyStore: AppAttestKeyStoreSpy,
        guestCapabilityStore: GuestCapabilityStoreSpy = GuestCapabilityStoreSpy(),
        service: AppAttestServiceSpy = AppAttestServiceSpy(),
        server: any AppAttestServerClient = AppAttestServerSpy()
    ) -> AppAttestClient {
        AppAttestClient(
            appID: AppAttestGuestCapabilityComposition.appID,
            environment: .production,
            guestCapabilityStore: guestCapabilityStore,
            keyStore: keyStore,
            server: server,
            service: service
        )
    }

    /// Exactly the composition `ClerkAuthenticationComposition` wires for the
    /// redemption drive, including the declined custody.
    private static func makeRecoveringProofProvider(
        client: AppAttestClient,
        onRecover: @escaping @Sendable () -> Void = {}
    ) -> AppAttestKeyRecoveringProofProvider {
        AppAttestKeyRecoveringProofProvider(
            base: client,
            recoverVerifiedKey: {
                onRecover()
                return await client.attestInstallation(
                    guestCapabilityCustody: .decline
                )
            }
        )
    }

    private func makeStore(
        userID: String = IncludedOfferRedemptionCoordinatorTests.userID
    ) -> IncludedOfferRedemptionStore {
        let suiteName = "dev.snaplist.tests.included-offer.\(UUID().uuidString)"
        mintedSuiteNames.append(suiteName)
        return IncludedOfferRedemptionStore(
            userID: userID,
            defaults: UserDefaults(suiteName: suiteName)!
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
        attest: (any AppAttestProofProviding)? = nil,
        report: @escaping @Sendable (IncludedOfferRedemptionReport) -> Void = { _ in },
        newIdempotencyKey: @escaping @Sendable () -> String = {
            "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
        },
        userID: String = userID
    ) -> IncludedOfferRedemptionCoordinator {
        IncludedOfferRedemptionCoordinator(
            redemption: IncludedOfferRedemption(
                attest: attest ?? FixedAppAttestProofProvider(outcome: proof),
                client: server,
                deviceCheck: FixedDeviceCheckTokenProvider(
                    isSupported: isDeviceCheckSupported,
                    token: deviceToken
                ),
                userID: userID
            ),
            store: store,
            report: report,
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

// MARK: - #854 doubles

private final class CallCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var calls = 0

    var count: Int { lock.withLock { calls } }

    func increment() { lock.withLock { calls += 1 } }
}

private final class RecordedReports: @unchecked Sendable {
    private let lock = NSLock()
    private var reports: [IncludedOfferRedemptionReport] = []

    var all: [IncludedOfferRedemptionReport] { lock.withLock { reports } }

    func record(_ report: IncludedOfferRedemptionReport) {
        lock.withLock { reports.append(report) }
    }
}

private final class AppAttestKeyStoreSpy: AppAttestKeyIDStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var stored: AppAttestStoredKey?
    private var saves: [AppAttestStoredKey] = []
    private var removals = 0

    var key: AppAttestStoredKey? { lock.withLock { stored } }
    var savedKeys: [AppAttestStoredKey] { lock.withLock { saves } }
    var removeCallCount: Int { lock.withLock { removals } }

    init(key: AppAttestStoredKey? = nil) {
        stored = key
    }

    func load() throws -> AppAttestStoredKey? { lock.withLock { stored } }

    func save(_ key: AppAttestStoredKey) throws {
        lock.withLock {
            stored = key
            saves.append(key)
        }
    }

    func remove() throws {
        lock.withLock {
            stored = nil
            removals += 1
        }
    }
}

private final class GuestCapabilityStoreSpy: GuestCapabilityBearerStoring,
    @unchecked Sendable {
    private let lock = NSLock()
    private var bearers: [GuestCapabilityBearer] = []

    var saved: [GuestCapabilityBearer] { lock.withLock { bearers } }

    func load() throws -> GuestCapabilityBearer? { lock.withLock { bearers.last } }

    func save(_ bearer: GuestCapabilityBearer) throws {
        lock.withLock { bearers.append(bearer) }
    }
}

private final class AppAttestServiceSpy: AppAttestServicing, @unchecked Sendable {
    let isSupported: Bool
    private let lock = NSLock()
    private var generatedKeys = 0

    var generateKeyCallCount: Int { lock.withLock { generatedKeys } }

    init(isSupported: Bool = true) {
        self.isSupported = isSupported
    }

    func generateKey() async throws -> String {
        lock.withLock { generatedKeys += 1 }
        return "native-fixed-key-id"
    }

    func attestKey(_ keyID: String, clientDataHash: Data) async throws -> Data {
        Data("fixed-attestation".utf8)
    }

    func generateAssertion(_ keyID: String, clientDataHash: Data) async throws -> Data {
        Data("fixed-assertion".utf8)
    }
}

private struct AppAttestServerSpy: AppAttestServerClient {
    var assertionTruth: AppAttestTruth = .verified(.init(
        counter: 1,
        environment: .production,
        keyID: "native-fixed-key-id",
        kind: .assertion
    ))
    var challengeError: (any Error)?

    func issueChallenge(
        kind: AppAttestChallenge.Kind,
        keyID: String?
    ) async throws -> AppAttestChallenge {
        if let challengeError { throw challengeError }
        return AppAttestChallenge(
            bytes: Data("challenge".utf8),
            expiresAt: Date(timeIntervalSince1970: 1_800_000_300),
            id: UUID(uuidString: "00000000-0000-4000-8000-000000000331")!,
            kind: kind
        )
    }

    func verifyAttestation(
        challengeID: UUID,
        keyID: String,
        attestationObject: Data
    ) async throws -> AppAttestTruth {
        .verified(.init(
            counter: 0,
            environment: .production,
            keyID: keyID,
            kind: .attestation
        ))
    }

    func verifyAssertion(
        challengeID: UUID,
        clientData: Data,
        keyID: String,
        assertionObject: Data,
        requestBody: Data
    ) async throws -> AppAttestTruth {
        assertionTruth
    }
}
