import SwiftUI

/// Semantic subscription content for a future approved screen composition.
/// This intentionally contains no paywall layout, purchase CTA, or visual
/// direction; it only renders truthful provider metadata and server state.
struct SubscriptionStatusView: View {
    let state: SubscriptionStore.State

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            switch state {
            case .unconfigured:
                Text("Subscriptions are not configured.")
                    .accessibilityIdentifier("subscription.unconfigured")
            case .loading:
                ProgressView("Loading subscription status")
            case .available(let products):
                if products.isEmpty {
                    Text("Subscription product unavailable.")
                        .accessibilityIdentifier("subscription.product-unavailable")
                } else {
                    ForEach(products) { product in
                        productMetadata(product)
                    }
                }
            case .purchasing:
                ProgressView("Confirming purchase")
            case .pending:
                Text("Purchase pending")
                    .accessibilityIdentifier("subscription.pending")
            case .restoring:
                ProgressView("Restoring purchases")
            case .awaitingServerVerification:
                Text("Awaiting server verification")
                    .accessibilityIdentifier("subscription.awaiting-server")
            case .verified(let entitlement):
                verifiedStatus(entitlement)
            case .failed:
                Text("Subscription status unavailable.")
                    .accessibilityIdentifier("subscription.unavailable")
            }
        }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private func productMetadata(_ product: SubscriptionProductMetadata) -> some View {
        Text(verbatim: product.localizedTitle)
            .accessibilityIdentifier("subscription.product.title")
        Text(verbatim: product.localizedDescription)
            .accessibilityIdentifier("subscription.product.description")
        Text(verbatim: product.localizedPrice)
            .accessibilityIdentifier("subscription.product.price")
        if let period = product.localizedBillingPeriod() {
            Text(verbatim: period)
                .accessibilityIdentifier("subscription.product.period")
        }
        if let terms = product.localizedPurchaseTerms() {
            Text(verbatim: terms)
                .accessibilityIdentifier("subscription.product.terms")
        }
    }

    @ViewBuilder
    private func verifiedStatus(_ entitlement: ServerVerifiedSubscription) -> some View {
        Text(entitlement.status.localizedLabel)
            .accessibilityIdentifier("subscription.verified.status")
        Text("\(entitlement.remainingItems) AI items remaining")
            .accessibilityIdentifier("subscription.verified.remaining")
        if entitlement.transitionState == .required {
            Text("Billing source verification required")
                .accessibilityIdentifier("subscription.billing-source-verification")
        }
        if let legacyStripeStatus = entitlement.legacyStripeStatus {
            Text("Legacy Stripe: \(legacyStripeStatus)")
                .accessibilityIdentifier("subscription.legacy-stripe")
        }
    }
}

private extension VerifiedSubscriptionStatus {
    var localizedLabel: String {
        switch self {
        case .included: String(localized: "Included allowance")
        case .active: String(localized: "Active")
        case .grace: String(localized: "Billing grace period")
        case .billingRetry: String(localized: "Payment retry")
        case .expired: String(localized: "Expired")
        case .revoked: String(localized: "Revoked")
        case .refunded: String(localized: "Refunded")
        case .ambiguous: String(localized: "Verification required")
        case .unconfigured: String(localized: "Not configured")
        }
    }
}
