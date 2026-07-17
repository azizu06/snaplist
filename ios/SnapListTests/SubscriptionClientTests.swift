import XCTest
@testable import SnapList

final class SubscriptionClientTests: XCTestCase {
    private let product = SubscriptionProductMetadata(
        id: "fixture-monthly",
        localizedTitle: "SnapList Pro",
        localizedDescription: "Fixture metadata",
        localizedPrice: "$4.99",
        billingPeriod: .init(value: 1, unit: .month)
    )

    func testPricePeriodAndTermsComeFromLocalizedProductMetadata() {
        XCTAssertEqual(product.localizedPrice, "$4.99")
        XCTAssertEqual(product.localizedBillingPeriod(locale: Locale(identifier: "en_US")), "1 month")
        XCTAssertEqual(product.localizedPurchaseTerms(locale: Locale(identifier: "en_US")), "$4.99 / 1 month")
    }

    @MainActor
    func testUnconfiguredStatePerformsNoRevenueCatWork() async {
        let client = FixtureSubscriptionClient(products: [product])
        let store = SubscriptionStore(client: client)

        await store.load(configuration: .unconfigured(appUserID: "user_fixture"))

        XCTAssertEqual(store.state, .unconfigured)
        let counts = await client.callCounts()
        XCTAssertEqual(counts.configure, 0)
    }

    @MainActor
    func testPurchaseIsAdvisoryUntilServerVerificationArrives() async {
        let client = FixtureSubscriptionClient(products: [product])
        let store = SubscriptionStore(client: client)
        await store.load(configuration: configured())

        await store.purchase(productID: product.id)

        XCTAssertEqual(store.state, .awaitingServerVerification(action: .purchase))
        let counts = await client.callCounts()
        XCTAssertEqual(counts.purchase, 1)
    }

    @MainActor
    func testRestoreIsAdvisoryUntilServerVerificationArrives() async {
        let client = FixtureSubscriptionClient(products: [product])
        let store = SubscriptionStore(client: client)
        await store.load(configuration: configured())

        await store.restore()

        XCTAssertEqual(store.state, .awaitingServerVerification(action: .restore))
        let counts = await client.callCounts()
        XCTAssertEqual(counts.restore, 1)
    }

    @MainActor
    func testPendingStoreKitPurchaseDoesNotPromoteEntitlement() async {
        let client = FixtureSubscriptionClient(
            products: [product],
            purchaseOutcome: .pending
        )
        let store = SubscriptionStore(client: client)
        await store.load(configuration: configured())

        await store.purchase(productID: product.id)

        XCTAssertEqual(store.state, .pending(productID: product.id))
    }

    @MainActor
    func testOnlyServerStatePromotesTheStoreAndKeepsLegacyStripeVisible() async {
        let client = FixtureSubscriptionClient(products: [product])
        let store = SubscriptionStore(client: client)
        await store.load(configuration: configured())
        await store.purchase(productID: product.id)
        let verified = ServerVerifiedSubscription(
            source: .storeKit,
            status: .grace,
            remainingItems: 7,
            periodStart: Date(timeIntervalSince1970: 1),
            periodEnd: Date(timeIntervalSince1970: 2),
            gracePeriodEnd: Date(timeIntervalSince1970: 3),
            transitionState: .reconciled,
            legacyStripeStatus: "active"
        )

        store.applyServerVerification(verified)

        XCTAssertEqual(store.state, .verified(verified))
        XCTAssertEqual(verified.legacyStripeStatus, "active")
        XCTAssertEqual(verified.source, .storeKit)
    }

    private func configured() -> NativeSubscriptionConfiguration {
        .init(
            configured: true,
            appUserID: "user_fixture",
            publicSDKKey: "appl_public_fixture",
            entitlementID: "pro",
            monthlyProductID: "fixture-monthly",
            offeringID: "current",
            transitionState: .notRequired,
            legacyStripeStatus: nil
        )
    }
}
