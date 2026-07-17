import Foundation

struct NativeSubscriptionConfiguration: Equatable, Sendable {
    let configured: Bool
    let appUserID: String
    let publicSDKKey: String?
    let entitlementID: String?
    let monthlyProductID: String?
    let offeringID: String?
    let transitionState: BillingSourceTransitionState?
    let legacyStripeStatus: String?

    static func unconfigured(appUserID: String) -> Self {
        Self(
            configured: false,
            appUserID: appUserID,
            publicSDKKey: nil,
            entitlementID: nil,
            monthlyProductID: nil,
            offeringID: nil,
            transitionState: nil,
            legacyStripeStatus: nil
        )
    }
}

enum BillingSourceTransitionState: String, Codable, Equatable, Sendable {
    case notRequired = "not_required"
    case required
    case reconciled
}

enum SubscriptionPeriodUnit: String, Codable, Equatable, Sendable {
    case day
    case week
    case month
    case year
}

struct SubscriptionBillingPeriod: Codable, Equatable, Sendable {
    let value: Int
    let unit: SubscriptionPeriodUnit

    func localizedDescription(locale: Locale = .current) -> String? {
        guard value > 0 else { return nil }
        let formatter = DateComponentsFormatter()
        formatter.unitsStyle = .full
        formatter.maximumUnitCount = 1
        formatter.calendar?.locale = locale
        var components = DateComponents()
        switch unit {
        case .day: components.day = value
        case .week: components.weekOfYear = value
        case .month: components.month = value
        case .year: components.year = value
        }
        return formatter.string(from: components)
    }
}

struct SubscriptionProductMetadata: Identifiable, Equatable, Sendable {
    let id: String
    let localizedTitle: String
    let localizedDescription: String
    let localizedPrice: String
    let billingPeriod: SubscriptionBillingPeriod

    func localizedBillingPeriod(locale: Locale = .current) -> String? {
        billingPeriod.localizedDescription(locale: locale)
    }

    func localizedPurchaseTerms(locale: Locale = .current) -> String? {
        guard let period = localizedBillingPeriod(locale: locale) else { return nil }
        return "\(localizedPrice) / \(period)"
    }
}

enum SubscriptionAdvisoryOutcome: Equatable, Sendable {
    case cancelled
    case pending
    case awaitingServerVerification
}

enum VerifiedSubscriptionSource: String, Codable, Equatable, Sendable {
    case included
    case storeKit = "storekit"
    case none
}

enum VerifiedSubscriptionStatus: String, Codable, Equatable, Sendable {
    case included
    case active
    case grace
    case billingRetry = "billing_retry"
    case expired
    case revoked
    case refunded
    case ambiguous
    case unconfigured
}

struct ServerVerifiedSubscription: Equatable, Sendable {
    let source: VerifiedSubscriptionSource
    let status: VerifiedSubscriptionStatus
    let remainingItems: Int
    let periodStart: Date?
    let periodEnd: Date?
    let gracePeriodEnd: Date?
    let transitionState: BillingSourceTransitionState?
    let legacyStripeStatus: String?
}
