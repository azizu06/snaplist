import XCTest
@testable import SnapList

@MainActor
final class ProGateStoreTests: XCTestCase {
    private let product = SubscriptionProductMetadata(
        id: "fixture-monthly",
        localizedTitle: "SnapList Pro",
        localizedDescription: "Fixture metadata",
        localizedPrice: "$9.99",
        billingPeriod: .init(value: 1, unit: .month)
    )

    func testNotEntitledServerTruthLoadsTheLocalizedOffer() async {
        let api = ProGateMobileAPIStub(
            entitlements: [.includedUsed],
            configuration: .configured
        )
        let subscriptions = FixtureSubscriptionClient(products: [product])
        let store = makeStore(api: api, subscriptions: subscriptions)

        let outcome = await store.prepare()

        XCTAssertEqual(outcome, .presented)
        XCTAssertEqual(
            store.state,
            .offer(product: product, advisory: nil, isRestoring: false)
        )
        let calls = await api.calls()
        XCTAssertEqual(calls.entitlement, 1)
        XCTAssertEqual(calls.configuration, 1)
    }

    func testVerifiedServerTruthNeverShowsAnOfferAndResumesOnce() async {
        let api = ProGateMobileAPIStub(
            entitlements: [.activeStoreKit],
            configuration: .configured
        )
        let subscriptions = FixtureSubscriptionClient(products: [product])
        let store = makeStore(api: api, subscriptions: subscriptions)

        let preparation = await store.prepare()
        XCTAssertEqual(preparation, .presented)
        XCTAssertEqual(store.state, .ready(source: .existingSubscription))
        XCTAssertTrue(store.consumeResumeIntent())
        XCTAssertFalse(store.consumeResumeIntent())
        XCTAssertEqual(store.state, .hidden)

        let subscriptionCalls = await subscriptions.callCounts()
        XCTAssertEqual(subscriptionCalls.configure, 0)
    }

    func testGraceAndBillingRetryServerTruthResumeWithoutAnOffer() async {
        for entitlement in [
            ProGateMobileAPIStub.EntitlementResult.graceStoreKit,
            .billingRetryStoreKit,
        ] {
            let api = ProGateMobileAPIStub(
                entitlements: [entitlement],
                configuration: .configured
            )
            let subscriptions = FixtureSubscriptionClient(products: [product])
            let store = makeStore(api: api, subscriptions: subscriptions)

            let preparation = await store.prepare()

            XCTAssertEqual(preparation, .presented)
            XCTAssertEqual(store.state, .ready(source: .existingSubscription))
            XCTAssertTrue(store.consumeResumeIntent())
            XCTAssertFalse(store.consumeResumeIntent())
            let subscriptionCalls = await subscriptions.callCounts()
            XCTAssertEqual(subscriptionCalls.configure, 0)
        }
    }

    func testExpiredServerTruthLoadsTheLocalizedOffer() async {
        let api = ProGateMobileAPIStub(
            entitlements: [.expiredStoreKit],
            configuration: .configured
        )
        let subscriptions = FixtureSubscriptionClient(products: [product])
        let store = makeStore(api: api, subscriptions: subscriptions)

        let preparation = await store.prepare()

        XCTAssertEqual(preparation, .presented)
        XCTAssertEqual(
            store.state,
            .offer(product: product, advisory: nil, isRestoring: false)
        )
    }

    func testPurchaseWaitsForServerTruthThenResumesTheBlockedIntentOnce() async {
        let api = ProGateMobileAPIStub(
            entitlements: [.includedUsed, .activeStoreKit],
            configuration: .configured
        )
        let subscriptions = FixtureSubscriptionClient(products: [product])
        let store = makeStore(api: api, subscriptions: subscriptions)
        let preparation = await store.prepare()
        XCTAssertEqual(preparation, .presented)

        await store.purchase()

        XCTAssertEqual(store.state, .ready(source: .purchase))
        XCTAssertTrue(store.consumeResumeIntent())
        XCTAssertFalse(store.consumeResumeIntent())
        let calls = await api.calls()
        XCTAssertEqual(calls.entitlement, 2)
        let subscriptionCalls = await subscriptions.callCounts()
        XCTAssertEqual(subscriptionCalls.purchase, 1)
    }

    func testCancelledPurchaseReturnsTheUnchangedOffer() async {
        let api = ProGateMobileAPIStub(
            entitlements: [.includedUsed],
            configuration: .configured
        )
        let subscriptions = FixtureSubscriptionClient(
            products: [product],
            purchaseOutcome: .cancelled
        )
        let store = makeStore(api: api, subscriptions: subscriptions)
        _ = await store.prepare()

        await store.purchase()

        XCTAssertEqual(
            store.state,
            .offer(product: product, advisory: nil, isRestoring: false)
        )
    }

    func testFailedPurchaseUsesTheApprovedPAY06Advisory() async {
        let api = ProGateMobileAPIStub(
            entitlements: [.includedUsed],
            configuration: .configured
        )
        let subscriptions = FailingProGateSubscriptionClient(
            product: product,
            failure: .purchase
        )
        let store = makeStore(api: api, subscriptions: subscriptions)
        _ = await store.prepare()

        await store.purchase()

        XCTAssertEqual(
            store.state,
            .offer(
                product: product,
                advisory: .purchaseDidNotComplete,
                isRestoring: false
            )
        )
    }

    func testPendingPurchaseStaysOnApprovedPAY03() async {
        let api = ProGateMobileAPIStub(
            entitlements: [.includedUsed, .includedUsed],
            configuration: .configured
        )
        let subscriptions = FixtureSubscriptionClient(
            products: [product],
            purchaseOutcome: .pending
        )
        let store = makeStore(api: api, subscriptions: subscriptions)
        _ = await store.prepare()

        await store.purchase()

        XCTAssertEqual(store.state, .confirming)
        XCTAssertFalse(store.isDismissible)
        XCTAssertFalse(store.consumeResumeIntent())
    }

    func testRestoreUsesPAY08OnlyWhenStoreKitFoundNothing() async {
        let api = ProGateMobileAPIStub(
            entitlements: [.includedUsed],
            configuration: .configured
        )
        let subscriptions = FixtureSubscriptionClient(
            products: [product],
            restoreOutcome: .nothingToRestore
        )
        let store = makeStore(api: api, subscriptions: subscriptions)
        _ = await store.prepare()

        _ = await store.restore()

        XCTAssertEqual(
            store.state,
            .offer(
                product: product,
                advisory: .nothingToRestore,
                isRestoring: false
            )
        )
    }

    func testRestoredPurchaseStillWaitsForServerBeforeResuming() async {
        let api = ProGateMobileAPIStub(
            entitlements: [.includedUsed, .activeStoreKit],
            configuration: .configured
        )
        let subscriptions = FixtureSubscriptionClient(products: [product])
        let store = makeStore(api: api, subscriptions: subscriptions)
        _ = await store.prepare()

        _ = await store.restore()

        XCTAssertEqual(store.state, .ready(source: .restoredPurchase))
        XCTAssertTrue(store.consumeResumeIntent())
        XCTAssertFalse(store.consumeResumeIntent())
    }

    func testDismissedRestoreCannotReopenTheProGateWhenItFinishes() async {
        let api = ProGateMobileAPIStub(
            entitlements: [.includedUsed],
            configuration: .configured
        )
        let subscriptions = SuspendedRestoreSubscriptionClient(
            product: product
        )
        let store = makeStore(api: api, subscriptions: subscriptions)
        _ = await store.prepare()

        let restore = Task { await store.restore() }
        await subscriptions.waitUntilRestoreStarts()
        store.dismiss()
        await subscriptions.finishRestore(with: .nothingToRestore)
        _ = await restore.value

        XCTAssertEqual(store.state, .hidden)
        guard case .needsPro? = store.intakeAdvisory else {
            return XCTFail("Expected the dismissed intake advisory to remain.")
        }
    }

    func testUnavailableServerOrProductFallsBackWithoutInventingAState() async {
        let serverUnavailable = ProGateMobileAPIStub(
            entitlements: [.failure(.httpStatus(503))],
            configuration: .configured
        )
        let serverStore = makeStore(
            api: serverUnavailable,
            subscriptions: FixtureSubscriptionClient(products: [product])
        )
        let serverPreparation = await serverStore.prepare()
        XCTAssertEqual(serverPreparation, .fallbackToPhotoReview)
        XCTAssertEqual(serverStore.state, .hidden)

        let productUnavailable = ProGateMobileAPIStub(
            entitlements: [.includedUsed],
            configuration: .configured
        )
        let productStore = makeStore(
            api: productUnavailable,
            subscriptions: FixtureSubscriptionClient(products: [])
        )
        let productPreparation = await productStore.prepare()
        XCTAssertEqual(productPreparation, .fallbackToPhotoReview)
        XCTAssertEqual(productStore.state, .hidden)
    }

    func testExcludedServerStatesFallBackWithoutShowingAnOffer() async {
        for entitlement in [
            ProGateMobileAPIStub.EntitlementResult.ambiguousStoreKit,
            .unconfiguredServer,
            .exhaustedStoreKit,
        ] {
            let api = ProGateMobileAPIStub(
                entitlements: [entitlement],
                configuration: .configured
            )
            let subscriptions = FixtureSubscriptionClient(products: [product])
            let store = makeStore(api: api, subscriptions: subscriptions)

            let preparation = await store.prepare()

            XCTAssertEqual(preparation, .fallbackToPhotoReview)
            XCTAssertEqual(store.state, .hidden)
            let subscriptionCalls = await subscriptions.callCounts()
            XCTAssertEqual(subscriptionCalls.configure, 0)
        }
    }

    func testDeclinePreservesTheApprovedPAY10IntakeAdvisory() async {
        let api = ProGateMobileAPIStub(
            entitlements: [.includedUsed],
            configuration: .configured
        )
        let store = makeStore(
            api: api,
            subscriptions: FixtureSubscriptionClient(products: [product])
        )
        _ = await store.prepare()

        store.dismiss()

        guard case .needsPro(let eventID)? = store.intakeAdvisory else {
            return XCTFail("Expected the approved PAY-10 advisory.")
        }
        XCTAssertNotNil(eventID)
        XCTAssertEqual(store.state, .hidden)
    }

    private func makeStore(
        api: any MobileAPIClient,
        subscriptions: any SubscriptionClient
    ) -> ProGateStore {
        ProGateStore(
            mobileAPIClient: api,
            subscriptionClient: subscriptions,
            verificationAttempts: 1,
            sleep: { _ in }
        )
    }
}

private actor ProGateMobileAPIStub: MobileAPIClient {
    enum EntitlementResult {
        case value(AiItemEntitlementEnvelope)
        case failure(MobileAPIClientError)

        static let includedUsed = value(.proGateFixture(
            source: .included,
            status: .included,
            remaining: 0
        ))
        static let activeStoreKit = value(.proGateFixture(
            source: .storeKit,
            status: .active,
            remaining: 7
        ))
        static let billingRetryStoreKit = value(.proGateFixture(
            source: .storeKit,
            status: .billingRetry,
            remaining: 7
        ))
        static let graceStoreKit = value(.proGateFixture(
            source: .storeKit,
            status: .grace,
            remaining: 7
        ))
        static let expiredStoreKit = value(.proGateFixture(
            source: .storeKit,
            status: .expired,
            remaining: 0
        ))
        static let ambiguousStoreKit = value(.proGateFixture(
            source: .storeKit,
            status: .ambiguous,
            remaining: 0
        ))
        static let unconfiguredServer = value(.proGateFixture(
            source: .none,
            status: .unconfigured,
            remaining: 0
        ))
        static let exhaustedStoreKit = value(.proGateFixture(
            source: .storeKit,
            status: .active,
            remaining: 0
        ))
    }

    private var entitlements: [EntitlementResult]
    private let configuration: RevenueCatConfigurationEnvelope
    private var entitlementCalls = 0
    private var configurationCalls = 0

    init(
        entitlements: [EntitlementResult],
        configuration: RevenueCatConfigurationEnvelope
    ) {
        self.entitlements = entitlements
        self.configuration = configuration
    }

    func getHealth() async throws -> HealthEnvelope {
        throw MobileAPIClientError.httpStatus(500)
    }

    func getSession() async throws -> SessionEnvelope {
        throw MobileAPIClientError.httpStatus(500)
    }

    func getRevenueCatConfiguration() async throws
        -> RevenueCatConfigurationEnvelope {
        configurationCalls += 1
        return configuration
    }

    func getAiItemEntitlement() async throws -> AiItemEntitlementEnvelope {
        entitlementCalls += 1
        let index = min(entitlementCalls - 1, entitlements.count - 1)
        switch entitlements[index] {
        case .value(let value): return value
        case .failure(let error): throw error
        }
    }

    func calls() -> (entitlement: Int, configuration: Int) {
        (entitlementCalls, configurationCalls)
    }
}

private actor FailingProGateSubscriptionClient: SubscriptionClient {
    enum Failure { case purchase }

    private let product: SubscriptionProductMetadata
    private let failure: Failure

    init(product: SubscriptionProductMetadata, failure: Failure) {
        self.product = product
        self.failure = failure
    }

    func configure(_ configuration: NativeSubscriptionConfiguration) async throws {}
    func loadProducts() async throws -> [SubscriptionProductMetadata] { [product] }
    func purchase(productID: String) async throws -> SubscriptionAdvisoryOutcome {
        switch failure {
        case .purchase: throw MobileAPIClientError.httpStatus(500)
        }
    }
    func restore() async throws -> SubscriptionAdvisoryOutcome {
        .awaitingServerVerification
    }
}

private actor SuspendedRestoreSubscriptionClient: SubscriptionClient {
    private let product: SubscriptionProductMetadata
    private var restoreStarted = false
    private var restoreStartWaiters: [CheckedContinuation<Void, Never>] = []
    private var restoreContinuation:
        CheckedContinuation<SubscriptionAdvisoryOutcome, Never>?

    init(product: SubscriptionProductMetadata) {
        self.product = product
    }

    func configure(_ configuration: NativeSubscriptionConfiguration) async throws {}
    func loadProducts() async throws -> [SubscriptionProductMetadata] { [product] }
    func purchase(productID: String) async throws -> SubscriptionAdvisoryOutcome {
        .cancelled
    }

    func restore() async throws -> SubscriptionAdvisoryOutcome {
        restoreStarted = true
        restoreStartWaiters.forEach { $0.resume() }
        restoreStartWaiters.removeAll()
        return await withCheckedContinuation { continuation in
            restoreContinuation = continuation
        }
    }

    func waitUntilRestoreStarts() async {
        guard !restoreStarted else { return }
        await withCheckedContinuation { continuation in
            restoreStartWaiters.append(continuation)
        }
    }

    func finishRestore(with outcome: SubscriptionAdvisoryOutcome) {
        restoreContinuation?.resume(returning: outcome)
        restoreContinuation = nil
    }
}

private extension RevenueCatConfigurationEnvelope {
    static let configured = RevenueCatConfigurationEnvelope(
        data: .init(
            configured: true,
            appUserId: "fixture-user",
            publicSdkKey: "appl_fixture",
            entitlementId: "pro",
            monthlyProductId: "fixture-monthly",
            offeringId: "current",
            transitionState: .notRequired,
            legacyStripeStatus: nil
        ),
        meta: .init(requestId: "fixture-configuration")
    )
}

private extension AiItemEntitlementEnvelope {
    static func proGateFixture(
        source: VerifiedSubscriptionSource,
        status: VerifiedSubscriptionStatus,
        remaining: Int
    ) -> AiItemEntitlementEnvelope {
        AiItemEntitlementEnvelope(
            data: .init(
                billingSource: source,
                status: status,
                remainingItems: remaining,
                periodStart: nil,
                periodEnd: nil,
                gracePeriodEnd: nil,
                transitionState: .notRequired,
                legacyStripeStatus: nil
            ),
            meta: .init(requestId: "fixture-entitlement")
        )
    }
}
