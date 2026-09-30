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

    /// Sandbox device finding: after an in-app switch from account A to B,
    /// the SDK stayed bound to A until relaunch, so B could not load the plan
    /// and a checkout could have been attributed to A. B's server-issued ID
    /// now rebinds the SDK with `logIn`, never `logOut`, never a reconfigure.
    func testAccountSwitchRebindsTheSDKToTheCurrentServerIssuedUser() async throws {
        let identity = RecordingRevenueCatIdentity()
        let client = RevenueCatSubscriptionClient(identity: identity)

        try await client.configure(.revenueCatFixture(appUserID: "user_A"))
        try await client.configure(.revenueCatFixture(appUserID: "user_A"))
        XCTAssertEqual(identity.configuredUsers, ["user_A"])
        XCTAssertEqual(identity.loggedInUsers, [])

        try await client.configure(.revenueCatFixture(appUserID: "user_B"))
        XCTAssertEqual(identity.configuredUsers, ["user_A"])
        XCTAssertEqual(identity.loggedInUsers, ["user_B"])
        XCTAssertEqual(identity.appUserID, "user_B")
    }

    /// `logIn` from an anonymous ID aliases it into the new account. SnapList
    /// never configures one, so meeting one refuses instead of merging.
    func testAnonymousSDKIdentityIsNeverMergedIntoTheSignedInAccount() async {
        let identity = RecordingRevenueCatIdentity(
            configuredAs: "$RCAnonymousID:device",
            anonymous: true
        )
        let client = RevenueCatSubscriptionClient(identity: identity)

        do {
            try await client.configure(.revenueCatFixture(appUserID: "user_B"))
            XCTFail("An anonymous SDK identity must not be switched")
        } catch {
            XCTAssertEqual(
                error as? SubscriptionClientError,
                .anonymousIdentityCannotSwitch
            )
        }
        XCTAssertEqual(identity.loggedInUsers, [])
    }

    /// A failed switch leaves nothing a purchase could use for the old user.
    func testFailedAccountSwitchLeavesTheClientUnconfigured() async throws {
        let identity = RecordingRevenueCatIdentity()
        let client = RevenueCatSubscriptionClient(identity: identity)
        try await client.configure(.revenueCatFixture(appUserID: "user_A"))
        identity.logInError = URLError(.notConnectedToInternet)

        do {
            try await client.configure(.revenueCatFixture(appUserID: "user_B"))
            XCTFail("The switch should have failed")
        } catch {}

        do {
            _ = try await client.purchase(productID: "snaplist.pro.monthly")
            XCTFail("A purchase must not run after a failed switch")
        } catch {
            XCTAssertEqual(error as? SubscriptionClientError, .unconfigured)
        }
    }

    func testRevenueCatAppleKeyValidationRejectsTestStoreForRelease() {
        XCTAssertTrue(
            RevenueCatSDKKey.isAccepted(
                "appl_release_fixture",
                for: .release
            )
        )
        XCTAssertFalse(
            RevenueCatSDKKey.isAccepted(
                "test_development_fixture",
                for: .release
            )
        )
        XCTAssertFalse(
            RevenueCatSDKKey.isAccepted(
                "not-an-apple-key",
                for: .release
            )
        )
        XCTAssertTrue(
            RevenueCatSDKKey.isAccepted(
                "test_development_fixture",
                for: .debug
            )
        )
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

private final class RecordingRevenueCatIdentity: RevenueCatIdentity, @unchecked Sendable {
    private(set) var isConfigured: Bool
    private(set) var appUserID: String
    let isAnonymous: Bool
    private(set) var configuredUsers: [String] = []
    private(set) var loggedInUsers: [String] = []
    var logInError: Error?

    init(configuredAs appUserID: String? = nil, anonymous: Bool = false) {
        isConfigured = appUserID != nil
        self.appUserID = appUserID ?? ""
        isAnonymous = anonymous
    }

    func configure(apiKey: String, appUserID: String) {
        isConfigured = true
        self.appUserID = appUserID
        configuredUsers.append(appUserID)
    }

    func logIn(_ appUserID: String) async throws {
        if let logInError { throw logInError }
        self.appUserID = appUserID
        loggedInUsers.append(appUserID)
    }
}

private extension NativeSubscriptionConfiguration {
    static func revenueCatFixture(appUserID: String) -> Self {
        Self(
            configured: true,
            appUserID: appUserID,
            publicSDKKey: "appl_fixture",
            entitlementID: "pro",
            monthlyProductID: "snaplist.pro.monthly",
            offeringID: nil,
            transitionState: nil,
            legacyStripeStatus: nil
        )
    }
}
