import SwiftUI
import UIKit

enum ProGateCopy {
    static let offerTitle = "This item needs SnapList Pro"
    static let offerStatement = "You made one AI listing for free."
    static let whatProDoes = "What Pro does"
    static let allowance =
        "AI listings every month, counted from your billing date"
    static let allowanceUnknown =
        "SnapList sets the monthly amount."
    static let keepsWork =
        "Your drafts and listings stay yours if you cancel"
    static let reassuranceTitle = "What happens if you don’t subscribe"
    static let reassuranceSaved =
        "This item stays saved with its photos, their order, and your voice note. You can subscribe later and pick it back up."
    static let reassuranceUnused =
        "No AI listing was used and nothing was charged."
    static let purchaseFailed =
        "That purchase did not go through. Nothing was charged. You can try again or restore a purchase."
    static let nothingToRestore =
        "No SnapList Pro subscription was found on this Apple Account. If you bought it with a different Apple Account, sign in with that one and try again."
    static let confirmingTitle = "Confirming your subscription"
    static let confirmingStatement =
        "SnapList is waiting for the App Store, then checking your account. This is usually quick."
    static let confirmingSubline =
        "Your item is still saved. Nothing has been used."
    static let purchaseReadyTitle = "SnapList Pro is on"
    static let purchaseReadyStatement =
        "Your subscription is confirmed on this account. This item can go through AI now."
    static let restoreReadyTitle = "SnapList Pro is already on"
    static let restoreReadyStatement =
        "Your SnapList Pro subscription is active on this Apple Account. This item can go through AI now."
    static let readySubline =
        "Your monthly amount is in Settings under Subscription."
    static let intakeNeedsPro =
        "This item is saved. It needs SnapList Pro to go through AI."
}

struct ProGateListingSummary {
    let title: String
    let condition: String
    let price: String
    let image: UIImage?
}

@MainActor
struct ProGateSheet: View {
    static let presentationDetentHeight: CGFloat = 504

    private static let contentGutter: CGFloat = 12

    @Bindable var store: ProGateStore
    let listingSummary: ProGateListingSummary?
    let startListing: () -> Void
    let fallbackToPhotoReview: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @AccessibilityFocusState private var headingFocused: Bool
    @ScaledMetric(relativeTo: .title2) private var titleSize: CGFloat = 26
    @ScaledMetric(relativeTo: .body) private var bodySize: CGFloat = 16
    @ScaledMetric(relativeTo: .footnote) private var detailSize: CGFloat = 13
    @ScaledMetric(relativeTo: .caption) private var labelSize: CGFloat = 12
    @ScaledMetric(relativeTo: .body) private var valueSize: CGFloat = 15
    @ScaledMetric(relativeTo: .footnote) private var proseSize: CGFloat = 13.5
    @ScaledMetric(relativeTo: .title3) private var listingPriceSize: CGFloat = 20
    @ScaledMetric(relativeTo: .headline) private var actionSize: CGFloat = 17
    @ScaledMetric(relativeTo: .subheadline) private var plainActionSize: CGFloat = 15

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 15) {
                heading
                stateBody
            }
            .padding(.horizontal, contentHorizontalPadding)
            .padding(.top, contentTopPadding)
            .padding(.bottom, 6)
            .frame(maxWidth: .infinity, alignment: .leading)

            if dynamicTypeSize.isAccessibilitySize {
                if case .offer = store.state {
                    Divider()
                        .foregroundStyle(SnapListColorToken.divider.color)
                }
                actionStack
                    .padding(.horizontal, contentHorizontalPadding)
                    .padding(.top, 12)
                    .padding(.bottom, 20)
            }
        }
        .scrollIndicators(.visible)
        // The footer pins via `safeAreaInset`, the same primitive
        // `floatingDock(...)` uses for the app-wide dock: it both floats the
        // footer over the scroll view and reserves that exact height as
        // scroll-content safe area, so the content stops above it instead of
        // sitting beside it in a shrunk VStack sibling.
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if !dynamicTypeSize.isAccessibilitySize {
                pinnedFooter
            }
        }
        .background(SnapListColorToken.canvas.color)
        .ignoresSafeArea(.container, edges: .bottom)
        .presentationDetents([.height(Self.presentationDetentHeight)])
        .presentationContentInteraction(.scrolls)
        .presentationCornerRadius(SnapListMetrics.sheetRadius)
        .presentationDragIndicator(store.isDismissible ? .visible : .hidden)
        .interactiveDismissDisabled(!store.isDismissible)
        .onAppear(perform: focusHeading)
        .onChange(of: store.state) { _, _ in focusHeading() }
    }

    private var pinnedFooter: some View {
        VStack(spacing: 0) {
            if case .offer = store.state {
                Divider()
                    .foregroundStyle(SnapListColorToken.divider.color)
            }
            actionStack
                .padding(.horizontal, contentHorizontalPadding)
                .padding(.top, 12)
                .padding(.bottom, 20)
        }
        .background(SnapListColorToken.canvas.color)
    }

    private var heading: some View {
        Text(title)
            .font(.system(size: titleSize, weight: .bold))
            .tracking(-0.5)
            .foregroundStyle(SnapListColorToken.inkPrimary.color)
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("pro-gate.title")
            .accessibilityFocused($headingFocused)
    }

    @ViewBuilder
    private var stateBody: some View {
        switch store.state {
        case .offer(_, let advisory, _):
            if let advisory {
                advisoryCard(advisory)
            }
            Text(ProGateCopy.offerStatement)
                .font(.system(size: bodySize))
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .accessibilityIdentifier("pro-gate.statement")
            if let listingSummary {
                listingCard(listingSummary)
            }
            offerValues
            reassurance
        case .confirming:
            Text(ProGateCopy.confirmingStatement)
                .font(.system(size: bodySize))
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
            Text(ProGateCopy.confirmingSubline)
                .font(.system(size: detailSize))
                .foregroundStyle(SnapListColorToken.textSecondary.color)
        case .ready(let source):
            Text(readyStatement(source))
                .font(.system(size: bodySize))
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
            Text(ProGateCopy.readySubline)
                .font(.system(size: detailSize))
                .foregroundStyle(SnapListColorToken.textSecondary.color)
        case .hidden:
            EmptyView()
        }
    }

    private var offerValues: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(ProGateCopy.whatProDoes)
                .font(.system(size: labelSize, weight: .bold))
                .tracking(1.08)
                .textCase(.uppercase)
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .accessibilityLabel(ProGateCopy.whatProDoes)
                .accessibilityIdentifier("pro-gate.what-pro-does")

            VStack(spacing: 8) {
                valueCard(
                    title: ProGateCopy.allowance,
                    detail: ProGateCopy.allowanceUnknown,
                    identifier: "pro-gate.allowance-row"
                )
                valueCard(title: ProGateCopy.keepsWork, detail: nil)
            }
        }
    }

    private var reassurance: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(ProGateCopy.reassuranceTitle)
                .font(.system(size: labelSize, weight: .bold))
                .tracking(1.08)
                .textCase(.uppercase)
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .accessibilityLabel(ProGateCopy.reassuranceTitle)

            VStack(spacing: 0) {
                Text(ProGateCopy.reassuranceSaved)
                    .padding(.vertical, 12)
                Divider().foregroundStyle(
                    SnapListColorToken.proGateReassuranceDivider.color
                )
                Text(ProGateCopy.reassuranceUnused)
                    .padding(.vertical, 12)
            }
            .font(.system(size: proseSize))
            .foregroundStyle(SnapListColorToken.textSecondary.color)
            .padding(.horizontal, 15)
            .background(SnapListColorToken.groupingFill.color)
            .clipShape(.rect(cornerRadius: 14))
        }
    }

    private func listingCard(_ listing: ProGateListingSummary) -> some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 10) {
                    listingImage(listing.image)
                    listingText(listing)
                }
            } else {
                HStack(spacing: 13) {
                    listingImage(listing.image)
                    listingText(listing)
                }
            }
        }
        .padding(8)
        .overlay {
            RoundedRectangle(cornerRadius: 16)
                .stroke(SnapListColorToken.hairline.color, lineWidth: 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "Your AI listing, \(listing.title), \(listing.condition), \(listing.price)"
        )
    }

    @ViewBuilder
    private func listingImage(_ image: UIImage?) -> some View {
        if let image {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
                .frame(
                    width: dynamicTypeSize.isAccessibilitySize ? 118 : 92,
                    height: dynamicTypeSize.isAccessibilitySize ? 118 : 92
                )
                .clipShape(.rect(cornerRadius: 10))
                .accessibilityLabel("Photo from your AI listing")
        }
    }

    private func listingText(
        _ listing: ProGateListingSummary
    ) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(listing.title)
                .font(.system(size: bodySize, weight: .semibold))
            Text(listing.condition)
                .font(.system(size: detailSize))
                .foregroundStyle(SnapListColorToken.textSecondary.color)
            Text(listing.price)
                .font(.system(size: listingPriceSize, weight: .bold))
                .monospacedDigit()
                .padding(.top, 2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func valueCard(
        title: String,
        detail: String?,
        identifier: String? = nil
    ) -> some View {
        Group {
            if let identifier {
                valueCardBody(title: title, detail: detail)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier(identifier)
            } else {
                valueCardBody(title: title, detail: detail)
            }
        }
    }

    private func valueCardBody(title: String, detail: String?) -> some View {
        HStack(alignment: .top, spacing: 11) {
            Image(systemName: "checkmark")
                .font(.system(size: 15, weight: .bold))
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .frame(width: 34, height: 34)
                .background(SnapListColorToken.quietFill.color)
                .clipShape(.rect(cornerRadius: 10))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: valueSize))
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                if let detail {
                    Text(detail)
                        .font(.system(size: detailSize))
                        .foregroundStyle(SnapListColorToken.textSecondary.color)
                }
            }
            .padding(.top, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 13)
        .padding(.vertical, 12)
        .overlay {
            RoundedRectangle(cornerRadius: 14)
                .stroke(SnapListColorToken.hairline.color, lineWidth: 1)
        }
    }

    private func advisoryCard(_ advisory: ProGateStore.Advisory) -> some View {
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: "info.circle")
                .font(.system(size: 17))
                .foregroundStyle(SnapListColorToken.textSecondary.color)
                .accessibilityHidden(true)
            Text(advisory == .purchaseDidNotComplete
                 ? ProGateCopy.purchaseFailed
                 : ProGateCopy.nothingToRestore)
                .font(.system(size: proseSize))
                .foregroundStyle(SnapListColorToken.textSecondary.color)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 13)
        .background(SnapListColorToken.mutedSurface.color)
        .clipShape(.rect(cornerRadius: 14))
        .accessibilityIdentifier("pro-gate.advisory")
    }

    @ViewBuilder
    private var actionStack: some View {
        switch store.state {
        case .offer(let product, _, let isRestoring):
            VStack(spacing: 0) {
                VStack(spacing: 2) {
                    Text(product.proGatePriceDisplay)
                        .font(.system(size: actionSize, weight: .semibold))
                        .monospacedDigit()
                        .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    Text(product.proGateRenewalStatement)
                        .font(.system(size: detailSize))
                        .foregroundStyle(SnapListColorToken.textSecondary.color)
                        .multilineTextAlignment(.center)
                }
                .padding(.bottom, 13)
                proGatePrimaryButton("Subscribe") {
                    Task { await store.purchase() }
                }
                .padding(.bottom, 8)
                if dynamicTypeSize.isAccessibilitySize {
                    VStack(spacing: 6) {
                        restoreControl(isRestoring: isRestoring)
                        declineControl
                    }
                } else {
                    HStack(spacing: 12) {
                        restoreControl(isRestoring: isRestoring)
                        declineControl
                    }
                }
                ProGateLegalFooter()
                    .padding(.top, 10)
            }
            .padding(.bottom, -5)
        case .confirming:
            busyLabel("Confirming", size: bodySize)
                .frame(maxWidth: .infinity, minHeight: 52)
                .background(SnapListColorToken.mutedSurface.color)
                .clipShape(.rect(cornerRadius: 15))
                .accessibilityIdentifier("pro-gate.confirming")
        case .ready:
            proGatePrimaryButton("Start this listing", action: startListing)
        case .hidden:
            EmptyView()
        }
    }

    private func proGatePrimaryButton(
        _ label: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: actionSize, weight: .semibold))
                .foregroundStyle(SnapListColorToken.onDarkSurface.color)
                .frame(maxWidth: .infinity, minHeight: 52)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .background(SnapListColorToken.action.color)
        .clipShape(.rect(cornerRadius: 15))
        .accessibilityIdentifier("pro-gate.primary")
    }

    private func plainButton(
        _ label: String,
        identifier: String,
        color: ProGateActionColor,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: plainActionSize, weight: .semibold))
                .foregroundStyle(color.value)
                .frame(maxWidth: .infinity, minHeight: 46)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(identifier)
    }

    @ViewBuilder
    private func restoreControl(isRestoring: Bool) -> some View {
        if isRestoring {
            busyLabel("Checking", size: plainActionSize)
                .frame(maxWidth: .infinity)
        } else {
            plainButton(
                "Restore purchase",
                identifier: "pro-gate.restore-purchase",
                color: .action
            ) {
                Task {
                    if await store.restore() == .fallbackToPhotoReview {
                        fallbackToPhotoReview()
                    }
                }
            }
        }
    }

    private var declineControl: some View {
        plainButton(
            "Not now",
            identifier: "pro-gate.not-now",
            color: .action
        ) {
            store.dismiss()
        }
    }

    private func busyLabel(_ label: String, size: CGFloat) -> some View {
        HStack(spacing: 9) {
            if !reduceMotion {
                ProgressView().controlSize(.small)
            }
            Text(label)
                .font(.system(size: size, weight: .semibold))
        }
        .foregroundStyle(SnapListColorToken.textSecondary.color)
        .frame(minHeight: SnapListMetrics.minimumTouchTarget)
        .accessibilityElement(children: .combine)
    }

    private var title: String {
        switch store.state {
        case .offer: ProGateCopy.offerTitle
        case .confirming: ProGateCopy.confirmingTitle
        case .ready(let source):
            source == .purchase
                ? ProGateCopy.purchaseReadyTitle
                : ProGateCopy.restoreReadyTitle
        case .hidden: ""
        }
    }

    private var contentTopPadding: CGFloat {
        if case .confirming = store.state { 12 } else { 32 }
    }

    private var contentHorizontalPadding: CGFloat {
        if case .confirming = store.state {
            SnapListMetrics.screenGutter
        } else {
            Self.contentGutter
        }
    }

    private func readyStatement(_ source: ProGateStore.ReadySource) -> String {
        source == .purchase
            ? ProGateCopy.purchaseReadyStatement
            : ProGateCopy.restoreReadyStatement
    }

    private func focusHeading() {
        Task { @MainActor in
            await Task.yield()
            headingFocused = true
        }
    }
}

private enum ProGateActionColor {
    case action
    case ink

    var value: Color {
        switch self {
        case .action: SnapListColorToken.action.color
        case .ink: SnapListColorToken.inkPrimary.color
        }
    }
}

/// The paywall's Terms/Privacy disclosure (issue #812). App Review 3.1.2
/// requires both documents reachable wherever the auto-renewing subscription
/// is offered, and `.offer` is the only `ProGateStore.State` that offers one.
struct ProGateLegalFooter: View {
    @Environment(\.openURL) private var openURL
    @ScaledMetric(relativeTo: .caption) private var footerSize: CGFloat = 12

    var body: some View {
        HStack(spacing: 6) {
            link(.termsOfService, identifier: "pro-gate.terms-of-service")
            Text("·")
                .font(.system(size: footerSize))
                .foregroundStyle(SnapListColorToken.textSecondary.color)
            link(.privacyPolicy, identifier: "pro-gate.privacy-policy")
        }
    }

    /// Matches `HomeViews.swift`'s trophy-wall header buttons: `.frame` alone
    /// only grows layout space, not the hit-tested/accessibility region for a
    /// `.buttonStyle(.plain)` button — `.contentShape(.rect)` is what makes
    /// that region actually cover the frame. Not padding sized to add up to
    /// 44 at the base font either, since that stops summing to 44 once
    /// `footerSize` scales for Dynamic Type.
    ///
    /// The requested height measures a few points short of what it asks for
    /// here specifically (verified via `testProGateOfferLegalFooterOpensTermsAndPrivacy`
    /// against the real measured frame, not the requested one) — this sheet
    /// sits on `.ignoresSafeArea(.container, edges: .bottom)`, and rendering
    /// that close to the sheet's own edge loses a small, consistent amount
    /// off the requested frame. `minimumLegalLinkHeight` pads past that loss
    /// so the actual on-screen target still clears the 44pt floor.
    private static let minimumLegalLinkHeight = SnapListMetrics.minimumTouchTarget + 4

    private func link(_ destination: LegalDestination, identifier: String) -> some View {
        Button {
            openURL(destination.url)
        } label: {
            Text(destination.label)
                .underline()
                .font(.system(size: footerSize))
                .frame(
                    minWidth: SnapListMetrics.minimumTouchTarget,
                    minHeight: Self.minimumLegalLinkHeight
                )
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .foregroundStyle(SnapListColorToken.textSecondary.color)
        .accessibilityIdentifier(identifier)
    }
}

private extension SubscriptionProductMetadata {
    var proGatePriceDisplay: String {
        switch (billingPeriod.value, billingPeriod.unit) {
        case (1, .day): "\(localizedPrice) per day"
        case (1, .week): "\(localizedPrice) per week"
        case (1, .month): "\(localizedPrice) per month"
        case (1, .year): "\(localizedPrice) per year"
        default:
            localizedPurchaseTerms() ?? localizedPrice
        }
    }

    /// App Review Guideline 3.1.2 requires the auto-renewing subscription's
    /// billing period be stated next to the purchase action, along with the
    /// fact that it renews until canceled. SnapList's only configured product
    /// is monthly (`NativeSubscriptionConfiguration.monthlyProductID`); this
    /// stays keyed off the live `billingPeriod` instead of hardcoding "month"
    /// so it stays correct if a different period is ever configured.
    var proGateRenewalStatement: String {
        switch (billingPeriod.value, billingPeriod.unit) {
        case (1, .day): "Renews automatically every day until canceled · Billed by Apple"
        case (1, .week): "Renews automatically every week until canceled · Billed by Apple"
        case (1, .month): "Renews automatically every month until canceled · Billed by Apple"
        case (1, .year): "Renews automatically every year until canceled · Billed by Apple"
        default:
            localizedBillingPeriod().map {
                "Renews automatically every \($0) until canceled · Billed by Apple"
            } ?? "Renews automatically until canceled · Billed by Apple"
        }
    }
}

#if DEBUG
@MainActor
struct ProGateFixtureHostView: View {
    @State private var store: ProGateStore
    private let fixture: ProGateFixtureState
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    init(fixture: ProGateFixtureState) {
        self.fixture = fixture
        _store = State(initialValue: ProGateStore.fixture(fixture))
    }

    var body: some View {
        PhotoReviewFixtureView(
            state: .resting,
            submissionPresentation: fixture == .pay10
                ? PhotoReviewSubmissionPresentation(
                    proGateIntakeAdvisory: .needsPro(eventID: UUID())
                )
                : .idle
        )
        .sheet(isPresented: fixtureBinding) {
            ProGateSheet(
                store: store,
                listingSummary: .fixture,
                startListing: {},
                fallbackToPhotoReview: {}
            )
            .dynamicTypeSize(dynamicTypeSize)
        }
    }

    private var fixtureBinding: Binding<Bool> {
        Binding(
            get: { fixture != .pay10 && store.isPresented },
            // Ignoring the system's dismiss instruction here (as the
            // fixture harness previously did) makes an interactive
            // swipe-down silently re-present the sheet instead of
            // closing it — mirror AppShellView's real binding and
            // forward it to the store.
            set: { presented in
                guard !presented else { return }
                store.dismiss()
            }
        )
    }
}

private extension ProGateListingSummary {
    static let fixture = ProGateListingSummary(
        title: "Tan leather tote bag, medium",
        condition: "Good condition",
        price: "$48",
        image: UIImage(systemName: "bag.fill")
    )
}
#endif
