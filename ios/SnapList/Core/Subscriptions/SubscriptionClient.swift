import Foundation

enum SubscriptionClientError: Error, Equatable {
    case unconfigured
    case alreadyConfiguredForAnotherAccount
    case offeringUnavailable
    case productUnavailable
}

protocol SubscriptionClient: Sendable {
    func configure(_ configuration: NativeSubscriptionConfiguration) async throws
    func loadProducts() async throws -> [SubscriptionProductMetadata]
    func purchase(productID: String) async throws -> SubscriptionAdvisoryOutcome
    func restore() async throws -> SubscriptionAdvisoryOutcome
}

actor FixtureSubscriptionClient: SubscriptionClient {
    private(set) var configureCount = 0
    private(set) var purchaseCount = 0
    private(set) var restoreCount = 0
    private let products: [SubscriptionProductMetadata]
    private let purchaseOutcome: SubscriptionAdvisoryOutcome
    private let restoreOutcome: SubscriptionAdvisoryOutcome
    private var configured = false

    init(
        products: [SubscriptionProductMetadata] = [],
        purchaseOutcome: SubscriptionAdvisoryOutcome = .awaitingServerVerification,
        restoreOutcome: SubscriptionAdvisoryOutcome = .awaitingServerVerification
    ) {
        self.products = products
        self.purchaseOutcome = purchaseOutcome
        self.restoreOutcome = restoreOutcome
    }

    func configure(_ configuration: NativeSubscriptionConfiguration) throws {
        configureCount += 1
        guard configuration.configured,
              configuration.publicSDKKey?.isEmpty == false,
              configuration.entitlementID?.isEmpty == false,
              configuration.monthlyProductID?.isEmpty == false else {
            throw SubscriptionClientError.unconfigured
        }
        configured = true
    }

    func loadProducts() throws -> [SubscriptionProductMetadata] {
        guard configured else { throw SubscriptionClientError.unconfigured }
        return products
    }

    func purchase(productID: String) throws -> SubscriptionAdvisoryOutcome {
        guard configured else { throw SubscriptionClientError.unconfigured }
        guard products.contains(where: { $0.id == productID }) else {
            throw SubscriptionClientError.productUnavailable
        }
        purchaseCount += 1
        return purchaseOutcome
    }

    func restore() throws -> SubscriptionAdvisoryOutcome {
        guard configured else { throw SubscriptionClientError.unconfigured }
        restoreCount += 1
        return restoreOutcome
    }

    func callCounts() -> (configure: Int, purchase: Int, restore: Int) {
        (configureCount, purchaseCount, restoreCount)
    }
}
