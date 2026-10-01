import Foundation
import RevenueCat

enum RevenueCatSDKKey {
    enum Build: Sendable {
        case debug
        case release

        static let current: Self = {
#if DEBUG
            .debug
#else
            .release
#endif
        }()
    }

    static func isAccepted(_ key: String, for build: Build) -> Bool {
        switch build {
        case .debug:
            key.hasPrefix("test_") || key.hasPrefix("appl_")
        case .release:
            key.hasPrefix("appl_")
        }
    }
}

/// The part of the `Purchases` singleton that decides which app user the SDK
/// speaks for, so an in-app account switch is provable without the SDK.
protocol RevenueCatIdentity: Sendable {
    var isConfigured: Bool { get }
    var appUserID: String { get }
    var isAnonymous: Bool { get }
    func configure(apiKey: String, appUserID: String)
    func logIn(_ appUserID: String) async throws
}

struct LiveRevenueCatIdentity: RevenueCatIdentity {
    var isConfigured: Bool { Purchases.isConfigured }
    var appUserID: String { Purchases.shared.appUserID }
    var isAnonymous: Bool { Purchases.shared.isAnonymous }

    func configure(apiKey: String, appUserID: String) {
        Purchases.configure(withAPIKey: apiKey, appUserID: appUserID)
    }

    func logIn(_ appUserID: String) async throws {
        _ = try await Purchases.shared.logIn(appUserID)
    }
}

actor RevenueCatSubscriptionClient: SubscriptionClient {
    private let identity: any RevenueCatIdentity
    private var configuration: NativeSubscriptionConfiguration?
    private var packagesByProductID: [String: Package] = [:]
    private var configurationID = UUID()

    init(identity: any RevenueCatIdentity = LiveRevenueCatIdentity()) {
        self.identity = identity
    }

    func configure(_ configuration: NativeSubscriptionConfiguration) async throws {
        let id = UUID()
        configurationID = id
        guard configuration.configured,
              let publicSDKKey = configuration.publicSDKKey,
              !publicSDKKey.isEmpty,
              RevenueCatSDKKey.isAccepted(
                publicSDKKey,
                for: .current
              ),
              configuration.entitlementID?.isEmpty == false,
              configuration.monthlyProductID?.isEmpty == false else {
            throw SubscriptionClientError.unconfigured
        }
        if !identity.isConfigured {
            identity.configure(
                apiKey: publicSDKKey,
                appUserID: configuration.appUserID
            )
        } else if identity.appUserID != configuration.appUserID {
            // An in-app sign-out and sign-in lands here with the SDK still
            // bound to the previous account. The server-issued app user ID is
            // the binding, so the SDK follows it with `logIn`, which switches
            // between identified users without aliasing them. Leaving an
            // anonymous ID through `logIn` would merge it into this account,
            // and SnapList never configures one, so that case fails closed.
            guard !identity.isAnonymous else {
                throw SubscriptionClientError.anonymousIdentityCannotSwitch
            }
            self.configuration = nil
            packagesByProductID = [:]
            try await identity.logIn(configuration.appUserID)
        }
        guard configurationID == id, identity.appUserID == configuration.appUserID else {
            throw SubscriptionClientError.unconfigured
        }
        self.configuration = configuration
    }

    func loadProducts() async throws -> [SubscriptionProductMetadata] {
        guard let configuration else { throw SubscriptionClientError.unconfigured }
        let offerings = try await Purchases.shared.offerings()
        guard self.configuration == configuration, identity.appUserID == configuration.appUserID else {
            throw SubscriptionClientError.unconfigured
        }
        let offering = configuration.offeringID.flatMap(offerings.offering(identifier:))
            ?? offerings.current
        guard let offering else { throw SubscriptionClientError.offeringUnavailable }
        let monthlyPackages = offering.availablePackages.filter {
            $0.storeProduct.productIdentifier == configuration.monthlyProductID
        }
        guard !monthlyPackages.isEmpty else {
            throw SubscriptionClientError.productUnavailable
        }
        packagesByProductID = Dictionary(
            uniqueKeysWithValues: monthlyPackages.map {
                ($0.storeProduct.productIdentifier, $0)
            }
        )
        return monthlyPackages.compactMap { package in
            let product = package.storeProduct
            guard let period = product.subscriptionPeriod,
                  let unit = SubscriptionPeriodUnit(period.unit) else {
                return nil
            }
            return SubscriptionProductMetadata(
                id: product.productIdentifier,
                localizedTitle: product.localizedTitle,
                localizedDescription: product.localizedDescription,
                localizedPrice: product.localizedPriceString,
                billingPeriod: SubscriptionBillingPeriod(value: period.value, unit: unit)
            )
        }
    }

    func purchase(productID: String) async throws -> SubscriptionAdvisoryOutcome {
        guard let configuration else { throw SubscriptionClientError.unconfigured }
        return try await purchase(productID: productID, appUserID: configuration.appUserID)
    }

    func purchase(productID: String, appUserID: String) async throws -> SubscriptionAdvisoryOutcome {
        try requireIdentity(appUserID)
        guard let package = packagesByProductID[productID] else {
            throw SubscriptionClientError.productUnavailable
        }
        do {
            let result = try await Purchases.shared.purchase(package: package)
            return result.userCancelled ? .cancelled : .awaitingServerVerification
        } catch let error as RevenueCat.ErrorCode {
            switch error {
            case .purchaseCancelledError:
                return .cancelled
            case .paymentPendingError:
                return .pending
            default:
                throw error
            }
        }
    }

    func restore() async throws -> SubscriptionAdvisoryOutcome {
        guard let configuration else { throw SubscriptionClientError.unconfigured }
        return try await restore(appUserID: configuration.appUserID)
    }

    func restore(appUserID: String) async throws -> SubscriptionAdvisoryOutcome {
        try requireIdentity(appUserID)
        guard let configuration,
              let entitlementID = configuration.entitlementID else {
            throw SubscriptionClientError.unconfigured
        }
        let customerInfo = try await Purchases.shared.restorePurchases()
        try requireIdentity(appUserID)
        guard customerInfo.entitlements[entitlementID]?.isActive == true else {
            return .nothingToRestore
        }
        return .awaitingServerVerification
    }

    private func requireIdentity(_ appUserID: String) throws {
        guard configuration?.appUserID == appUserID, identity.appUserID == appUserID else {
            throw SubscriptionClientError.unconfigured
        }
    }
}

private extension SubscriptionPeriodUnit {
    init?(_ unit: RevenueCat.SubscriptionPeriod.Unit) {
        switch unit {
        case .day: self = .day
        case .week: self = .week
        case .month: self = .month
        case .year: self = .year
        @unknown default: return nil
        }
    }
}
