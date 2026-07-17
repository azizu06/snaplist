import Foundation
import RevenueCat

final class RevenueCatSubscriptionClient: SubscriptionClient, @unchecked Sendable {
    private var configuration: NativeSubscriptionConfiguration?
    private var packagesByProductID: [String: Package] = [:]

    func configure(_ configuration: NativeSubscriptionConfiguration) async throws {
        guard configuration.configured,
              let publicSDKKey = configuration.publicSDKKey,
              !publicSDKKey.isEmpty,
              configuration.entitlementID?.isEmpty == false,
              configuration.monthlyProductID?.isEmpty == false else {
            throw SubscriptionClientError.unconfigured
        }
        if Purchases.isConfigured {
            guard Purchases.shared.appUserID == configuration.appUserID else {
                throw SubscriptionClientError.alreadyConfiguredForAnotherAccount
            }
        } else {
            Purchases.configure(
                withAPIKey: publicSDKKey,
                appUserID: configuration.appUserID
            )
        }
        self.configuration = configuration
    }

    func loadProducts() async throws -> [SubscriptionProductMetadata] {
        guard let configuration else { throw SubscriptionClientError.unconfigured }
        let offerings = try await Purchases.shared.offerings()
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
        guard configuration != nil else { throw SubscriptionClientError.unconfigured }
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
        guard configuration != nil else { throw SubscriptionClientError.unconfigured }
        _ = try await Purchases.shared.restorePurchases()
        return .awaitingServerVerification
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
