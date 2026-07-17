import Foundation

struct ResponseMeta: Codable, Equatable {
    let requestId: String
}

struct HealthEnvelope: Codable, Equatable {
    struct DataPayload: Codable, Equatable {
        let apiVersion: String
        let status: String
    }

    let data: DataPayload
    let meta: ResponseMeta
}

struct SessionEnvelope: Codable, Equatable {
    struct DataPayload: Codable, Equatable {
        let userId: String
    }

    let data: DataPayload
    let meta: ResponseMeta
}

struct RevenueCatConfigurationEnvelope: Codable, Equatable {
    struct DataPayload: Codable, Equatable {
        let configured: Bool
        let appUserId: String
        let publicSdkKey: String?
        let entitlementId: String?
        let monthlyProductId: String?
        let offeringId: String?
        let transitionState: BillingSourceTransitionState?
        let legacyStripeStatus: String?

        var subscriptionConfiguration: NativeSubscriptionConfiguration {
            .init(
                configured: configured,
                appUserID: appUserId,
                publicSDKKey: publicSdkKey,
                entitlementID: entitlementId,
                monthlyProductID: monthlyProductId,
                offeringID: offeringId,
                transitionState: transitionState,
                legacyStripeStatus: legacyStripeStatus
            )
        }
    }

    let data: DataPayload
    let meta: ResponseMeta
}

struct AiItemEntitlementEnvelope: Codable, Equatable {
    struct DataPayload: Codable, Equatable {
        let billingSource: VerifiedSubscriptionSource
        let status: VerifiedSubscriptionStatus
        let remainingItems: Int
        let periodStart: String?
        let periodEnd: String?
        let gracePeriodEnd: String?
        let transitionState: BillingSourceTransitionState?
        let legacyStripeStatus: String?

        var serverVerifiedSubscription: ServerVerifiedSubscription {
            return .init(
                source: billingSource,
                status: status,
                remainingItems: remainingItems,
                periodStart: periodStart.flatMap(Self.parseServerDate),
                periodEnd: periodEnd.flatMap(Self.parseServerDate),
                gracePeriodEnd: gracePeriodEnd.flatMap(Self.parseServerDate),
                transitionState: transitionState,
                legacyStripeStatus: legacyStripeStatus
            )
        }

        private static func parseServerDate(_ value: String) -> Date? {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = formatter.date(from: value) { return date }
            formatter.formatOptions = [.withInternetDateTime]
            return formatter.date(from: value)
        }
    }

    let data: DataPayload
    let meta: ResponseMeta
}

enum ContractOnlyOperation: String, CaseIterable, Codable {
    case verifyGuestAttestation
    case createItemRun
    case getRun
    case retryRun
    case cancelRun
    case createEbayOauthSession
    case completeEbayOauthCallback

    var ownerIssue: Int {
        switch self {
        case .verifyGuestAttestation: 174
        case .createItemRun, .getRun: 159
        case .retryRun, .cancelRun: 161
        case .createEbayOauthSession, .completeEbayOauthCallback: 17
        }
    }
}

struct ContractOnlyFixture: Equatable {
    let operation: ContractOnlyOperation
    let ownerIssue: Int
    let note: String

    static func metadata(for operation: ContractOnlyOperation) -> ContractOnlyFixture {
        ContractOnlyFixture(
            operation: operation,
            ownerIssue: operation.ownerIssue,
            note: "Schema fixture only. No server behavior or network request is executed."
        )
    }
}
