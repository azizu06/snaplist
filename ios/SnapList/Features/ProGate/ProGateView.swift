import SwiftUI
import UIKit

enum ProGateCopy {
    static let offerTitle = "This item needs SnapList Pro"
    static let offerStatement = "You made one AI listing for free."
    static let plansTitle = "SnapList Pro"
    static let plansStatement = "Pro gives you AI listings every month."
    static let whatProDoes = "What Pro does"
    static let allowance = "AI listings every month"
    static let allowanceUnknown =
        "Counted from your billing date. SnapList sets the monthly amount."
    static let keepsWork = "Your work stays yours"
    static let keepsWorkDetail = "Drafts and listings stay if you cancel."
    static let cancelAnytime = "Cancel anytime"
    static let cancelAnytimeDetail = "Manage it in your Apple Account settings."
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
    static let pendingTitle = "Subscription not confirmed yet"
    static let pendingStatement =
        "SnapList hasn’t confirmed Pro on this account yet. Check again or restore your purchase. You can close this screen safely."
    static let confirmingStatement =
        "SnapList turns Pro on after the App Store and your SnapList account both confirm the purchase."
    static let confirmingSubline =
        "Your item is still saved. Nothing has been used."
    static let plansConfirmingSubline = "Nothing has been used yet."
    static let purchaseReadyTitle = "SnapList Pro is on"
    static let purchaseReadyStatement =
        "Your subscription is confirmed on this account. This item can go through AI now."
    static let restoreReadyTitle = "SnapList Pro is already on"
    static let restoreReadyStatement =
        "Your SnapList Pro subscription is active on this Apple Account. This item can go through AI now."
    static let plansPurchaseReadyStatement =
        "Your subscription is confirmed on this account."
    static let plansRestoreReadyStatement =
        "Your SnapList Pro subscription is active on this Apple Account."
    static let readySubline =
        "Your monthly amount is in Settings under Subscription."
    static let plansReadySubline =
        "Your monthly amount appears under Subscription."
    static let intakeNeedsPro =
        "This item is saved. It needs SnapList Pro to go through AI."
}

/// Where the paywall was opened from. The item gate interrupts a second AI
/// run and talks about that saved item; Settings opens the same offer on
/// purpose, so it has no item to reassure about or resume.
enum ProGateSheetContext: Equatable {
    case itemGate
    case settingsPlans
}

struct ProGateListingSummary {
    let title: String
    let condition: String
    let price: String
    let image: UIImage?
}

@MainActor
struct ProGateSheet: View {
    @Bindable var store: ProGateStore
    let listingSummary: ProGateListingSummary?
    let startListing: () -> Void
    let fallbackToPhotoReview: () -> Void
    var context: ProGateSheetContext = .itemGate

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @AccessibilityFocusState private var headingFocused: Bool
    @ScaledMetric(relativeTo: .title2) private var titleSize: CGFloat = 26
    @ScaledMetric(relativeTo: .body) private var bodySize: CGFloat = 16
    @ScaledMetric(relativeTo: .footnote) private var detailSize: CGFloat = 13
    @ScaledMetric(relativeTo: .subheadline) private var labelSize: CGFloat = 14
    @ScaledMetric(relativeTo: .body) private var valueSize: CGFloat = 15
    @ScaledMetric(relativeTo: .title3) private var listingPriceSize: CGFloat = 20
    @ScaledMetric(relativeTo: .title2) private var planPriceSize: CGFloat = 24
    @ScaledMetric(relativeTo: .headline) private var actionSize: CGFloat = 17
    @ScaledMetric(relativeTo: .subheadline) private var plainActionSize: CGFloat = 15
    @ScaledMetric(relativeTo: .title2) private var badgeSize: CGFloat = 52
    @ScaledMetric(relativeTo: .body) private var benefitIconSize: CGFloat = 32

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header
                stateBody
            }
            .padding(.horizontal, SnapListMetrics.screenGutter)
            .padding(.top, 28)
            .padding(.bottom, 8)
            .frame(maxWidth: .infinity, alignment: .leading)

            if dynamicTypeSize.isAccessibilitySize {
                actionStack
                    .padding(.horizontal, SnapListMetrics.screenGutter)
                    .padding(.top, 8)
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
        .presentationDetents([.large])
        .presentationContentInteraction(.scrolls)
        .presentationCornerRadius(SnapListMetrics.sheetRadius)
        .presentationDragIndicator(store.isDismissible ? .visible : .hidden)
        .interactiveDismissDisabled(!store.isDismissible)
        .onAppear(perform: focusHeading)
        .onChange(of: store.state) { _, _ in focusHeading() }
        .onChange(of: ClerkAuthenticationComposition.currentUserID()) { _, _ in
            store.accountChanged()
        }
    }

    private var pinnedFooter: some View {
        VStack(spacing: 0) {
            Divider()
                .overlay(SnapListColorToken.divider.color)
            actionStack
                .padding(.horizontal, SnapListMetrics.screenGutter)
                .padding(.top, 14)
                .padding(.bottom, 4)
        }
        .background(SnapListColorToken.canvas.color)
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: headerAlignment, spacing: 14) {
            headerBadge
            Text(title)
                .font(.system(size: titleSize, weight: .bold))
                .tracking(-0.4)
                .multilineTextAlignment(headerTextAlignment)
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("pro-gate.title")
                .accessibilityFocused($headingFocused)
        }
        .frame(maxWidth: .infinity, alignment: headerFrameAlignment)
    }

    @ViewBuilder
    private var headerBadge: some View {
        switch store.state {
        case .offer:
            badge(symbol: "sparkles")
        case .verificationPending:
            badge(symbol: "clock")
        case .confirming:
            ZStack {
                Circle().fill(SnapListColorToken.actionTint.color)
                if reduceMotion {
                    Image(systemName: "hourglass")
                        .font(.system(size: badgeSize * 0.4, weight: .semibold))
                        .foregroundStyle(SnapListColorToken.action.color)
                } else {
                    ProgressView()
                        .controlSize(.large)
                        .tint(SnapListColorToken.action.color)
                }
            }
            .frame(width: badgeSize * 1.3, height: badgeSize * 1.3)
            .accessibilityHidden(true)
        case .ready:
            ZStack {
                Circle().fill(SnapListColorToken.actionTint.color)
                Image(systemName: "checkmark")
                    .font(.system(size: badgeSize * 0.5, weight: .bold))
                    .foregroundStyle(SnapListColorToken.action.color)
            }
            .frame(width: badgeSize * 1.3, height: badgeSize * 1.3)
            .accessibilityHidden(true)
        case .hidden:
            EmptyView()
        }
    }

    private func badge(symbol: String) -> some View {
        Image(systemName: symbol)
            .font(.system(size: badgeSize * 0.44, weight: .semibold))
            .foregroundStyle(SnapListColorToken.action.color)
            .frame(width: badgeSize, height: badgeSize)
            .background(
                SnapListColorToken.actionTint.color,
                in: RoundedRectangle(cornerRadius: badgeSize * 0.3, style: .continuous)
            )
            .accessibilityHidden(true)
    }

    // MARK: - State body

    @ViewBuilder
    private var stateBody: some View {
        switch store.state {
        case .offer(_, let advisory, _):
            Text(offerStatement)
                .font(.system(size: bodySize))
                .foregroundStyle(SnapListColorToken.textSecondary.color)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, -8)
                .accessibilityIdentifier("pro-gate.statement")
            if let advisory {
                advisoryCard(advisory)
            }
            if let listingSummary, context == .itemGate {
                listingCard(listingSummary)
            }
            benefits
            if context == .itemGate {
                reassurance
            }
        case .confirming, .verificationPending:
            centeredStatement(
                store.state == .verificationPending
                    ? ProGateCopy.pendingStatement
                    : ProGateCopy.confirmingStatement,
                subline: context == .itemGate
                    ? ProGateCopy.confirmingSubline
                    : ProGateCopy.plansConfirmingSubline
            )
        case .ready(let source):
            centeredStatement(
                readyStatement(source),
                subline: context == .itemGate
                    ? ProGateCopy.readySubline
                    : ProGateCopy.plansReadySubline
            )
        case .hidden:
            EmptyView()
        }
    }

    private func centeredStatement(_ statement: String, subline: String) -> some View {
        VStack(spacing: 8) {
            Text(statement)
                .font(.system(size: bodySize))
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
            Text(subline)
                .font(.system(size: detailSize))
                .foregroundStyle(SnapListColorToken.textSecondary.color)
        }
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity)
        .padding(.top, -6)
    }

    private var benefits: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionLabel(ProGateCopy.whatProDoes)
                .accessibilityIdentifier("pro-gate.what-pro-does")

            VStack(spacing: 0) {
                benefitRow(
                    symbol: "sparkles",
                    title: ProGateCopy.allowance,
                    detail: ProGateCopy.allowanceUnknown
                )
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("pro-gate.allowance-row")
                benefitDivider
                benefitRow(
                    symbol: "tray.full",
                    title: ProGateCopy.keepsWork,
                    detail: ProGateCopy.keepsWorkDetail
                )
                .accessibilityElement(children: .combine)
                benefitDivider
                benefitRow(
                    symbol: "arrow.uturn.backward.circle",
                    title: ProGateCopy.cancelAnytime,
                    detail: ProGateCopy.cancelAnytimeDetail
                )
                .accessibilityElement(children: .combine)
            }
            .background(
                SnapListColorToken.groupingFill.color,
                in: RoundedRectangle(cornerRadius: 18, style: .continuous)
            )
        }
    }

    private var benefitDivider: some View {
        Divider()
            .overlay(SnapListColorToken.proGateReassuranceDivider.color)
            .padding(.leading, 16 + benefitIconSize + 12)
    }

    private func benefitRow(symbol: String, title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol)
                .font(.system(size: benefitIconSize * 0.46, weight: .semibold))
                .foregroundStyle(SnapListColorToken.action.color)
                .frame(width: benefitIconSize, height: benefitIconSize)
                .background(
                    SnapListColorToken.canvas.color,
                    in: RoundedRectangle(cornerRadius: 9, style: .continuous)
                )
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: valueSize, weight: .semibold))
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                Text(detail)
                    .font(.system(size: detailSize))
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
            }
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 13)
    }

    private var reassurance: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionLabel(ProGateCopy.reassuranceTitle)
            VStack(alignment: .leading, spacing: 10) {
                reassuranceLine(symbol: "checkmark.circle", text: ProGateCopy.reassuranceSaved)
                reassuranceLine(symbol: "creditcard", text: ProGateCopy.reassuranceUnused)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(SnapListColorToken.hairline.color, lineWidth: 1)
            }
        }
    }

    private func reassuranceLine(symbol: String, text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: symbol)
                .font(.system(size: detailSize, weight: .semibold))
                .foregroundStyle(SnapListColorToken.textSecondary.color)
                .accessibilityHidden(true)
            Text(text)
                .font(.system(size: detailSize))
                .foregroundStyle(SnapListColorToken.textSecondary.color)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func sectionLabel(_ label: String) -> some View {
        Text(label)
            .font(.system(size: labelSize, weight: .semibold))
            .foregroundStyle(SnapListColorToken.inkPrimary.color)
            .accessibilityAddTraits(.isHeader)
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
            RoundedRectangle(cornerRadius: 16, style: .continuous)
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
                    width: dynamicTypeSize.isAccessibilitySize ? 118 : 72,
                    height: dynamicTypeSize.isAccessibilitySize ? 118 : 72
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

    private func advisoryCard(_ advisory: ProGateStore.Advisory) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: advisory == .purchaseDidNotComplete
                  ? "exclamationmark.circle"
                  : "info.circle")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(SnapListColorToken.caution.color)
                .accessibilityHidden(true)
            Text(advisory == .purchaseDidNotComplete
                 ? ProGateCopy.purchaseFailed
                 : ProGateCopy.nothingToRestore)
                .font(.system(size: detailSize))
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 13)
        .background(
            SnapListColorToken.cautionFill.color,
            in: RoundedRectangle(cornerRadius: 14, style: .continuous)
        )
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("pro-gate.advisory")
    }

    // MARK: - Actions

    @ViewBuilder
    private var actionStack: some View {
        switch store.state {
        case .offer(let product, _, let isRestoring):
            VStack(spacing: 0) {
                planTile(product)
                Text(product.proGateRenewalStatement)
                    .font(.system(size: detailSize))
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 8)
                    .padding(.bottom, 12)
                    .accessibilityIdentifier("pro-gate.renewal")
                proGatePrimaryButton("Subscribe") {
                    Task { await store.purchase() }
                }
                if dynamicTypeSize.isAccessibilitySize {
                    VStack(spacing: 6) {
                        restoreControl(isRestoring: isRestoring)
                        declineControl
                    }
                    .padding(.top, 4)
                } else {
                    HStack(spacing: 12) {
                        restoreControl(isRestoring: isRestoring)
                        declineControl
                    }
                    .padding(.top, 2)
                }
                ProGateLegalFooter()
            }
        case .confirming:
            busyLabel("Confirming", size: bodySize)
                .frame(maxWidth: .infinity, minHeight: SnapListMetrics.primaryButtonHeight)
                .background(
                    SnapListColorToken.mutedSurface.color,
                    in: RoundedRectangle(cornerRadius: 16, style: .continuous)
                )
                .padding(.bottom, 16)
                .accessibilityIdentifier("pro-gate.confirming")
        case .verificationPending:
            VStack(spacing: 8) {
                proGatePrimaryButton("Check again") {
                    Task { await store.refreshPendingVerification() }
                }
                .accessibilityIdentifier("pro-gate.check-again")
                restoreControl(isRestoring: false)
                plainButton("Close", identifier: "pro-gate.close") {
                    store.dismiss()
                }
            }
        case .ready:
            proGatePrimaryButton(
                context == .itemGate ? "Start this listing" : "Done",
                action: startListing
            )
            .padding(.bottom, 16)
        case .hidden:
            EmptyView()
        }
    }

    /// The single plan the store returned, drawn as the selected option so
    /// the price the seller is agreeing to sits directly above `Subscribe`.
    /// Every value here is StoreKit's localized product metadata.
    private func planTile(_ product: SubscriptionProductMetadata) -> some View {
        let tile = Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 8) {
                    planName(product)
                    planPrice(product)
                }
            } else {
                HStack(alignment: .center, spacing: 12) {
                    planName(product)
                    Spacer(minLength: 8)
                    planPrice(product)
                }
            }
        }
        return tile
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                SnapListColorToken.actionTint.color.opacity(0.55),
                in: RoundedRectangle(cornerRadius: 16, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(SnapListColorToken.action.color, lineWidth: 1.5)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(
                "\(product.localizedTitle), \(product.proGatePlanName), \(product.proGatePriceDisplay)"
            )
            .accessibilityIdentifier("pro-gate.plan")
    }

    private func planName(_ product: SubscriptionProductMetadata) -> some View {
        HStack(alignment: .center, spacing: 10) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(SnapListColorToken.action.color)
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: product.localizedTitle)
                    .font(.system(size: valueSize, weight: .semibold))
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                Text(product.proGatePlanName)
                    .font(.system(size: detailSize))
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
            }
        }
    }

    private func planPrice(_ product: SubscriptionProductMetadata) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 3) {
            Text(verbatim: product.localizedPrice)
                .font(.system(size: planPriceSize, weight: .bold))
                .monospacedDigit()
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
            if let unit = product.proGatePerUnit {
                Text(unit)
                    .font(.system(size: detailSize, weight: .medium))
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
            }
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
                .frame(maxWidth: .infinity, minHeight: SnapListMetrics.primaryButtonHeight)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .background(SnapListColorToken.action.color, in: Capsule())
        .accessibilityIdentifier("pro-gate.primary")
    }

    private func plainButton(
        _ label: String,
        identifier: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: plainActionSize, weight: .semibold))
                .foregroundStyle(SnapListColorToken.action.color)
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
                identifier: "pro-gate.restore-purchase"
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
        plainButton("Not now", identifier: "pro-gate.not-now") {
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

    // MARK: - Copy

    private var title: String {
        switch store.state {
        case .offer:
            context == .itemGate ? ProGateCopy.offerTitle : ProGateCopy.plansTitle
        case .confirming: ProGateCopy.confirmingTitle
        case .verificationPending: ProGateCopy.pendingTitle
        case .ready(let source):
            source == .purchase
                ? ProGateCopy.purchaseReadyTitle
                : ProGateCopy.restoreReadyTitle
        case .hidden: ""
        }
    }

    private var offerStatement: String {
        context == .itemGate ? ProGateCopy.offerStatement : ProGateCopy.plansStatement
    }

    /// The offer reads top-down like a document; the confirming and ready
    /// states are a single outcome, so they center on it.
    private var isOutcomeState: Bool {
        switch store.state {
        case .confirming, .verificationPending, .ready: true
        case .offer, .hidden: false
        }
    }

    private var headerAlignment: HorizontalAlignment {
        isOutcomeState ? .center : .leading
    }

    private var headerTextAlignment: TextAlignment {
        isOutcomeState ? .center : .leading
    }

    private var headerFrameAlignment: Alignment {
        isOutcomeState ? .center : .leading
    }

    private func readyStatement(_ source: ProGateStore.ReadySource) -> String {
        switch (context, source) {
        case (.itemGate, .purchase): ProGateCopy.purchaseReadyStatement
        case (.itemGate, _): ProGateCopy.restoreReadyStatement
        case (.settingsPlans, .purchase): ProGateCopy.plansPurchaseReadyStatement
        case (.settingsPlans, _): ProGateCopy.plansRestoreReadyStatement
        }
    }

    private func focusHeading() {
        Task { @MainActor in
            await Task.yield()
            headingFocused = true
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
    /// `minimumLegalLinkHeight` pads a few points past the 44pt floor so the
    /// measured on-screen target (not just the requested frame) clears it
    /// this close to the sheet's bottom edge; see
    /// `testProGateOfferLegalFooterOpensTermsAndPrivacy`.
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

    /// The plan's cadence as a seller reads a plan name ("Monthly").
    var proGatePlanName: String {
        switch (billingPeriod.value, billingPeriod.unit) {
        case (1, .day): "Daily"
        case (1, .week): "Weekly"
        case (1, .month): "Monthly"
        case (1, .year): "Yearly"
        default:
            localizedBillingPeriod().map { "Every \($0)" } ?? "Subscription"
        }
    }

    /// The short unit drawn beside the price ("/ month"); nil when the period
    /// is not a single unit, where the plan name already carries it.
    var proGatePerUnit: String? {
        guard billingPeriod.value == 1 else { return nil }
        switch billingPeriod.unit {
        case .day: return "/ day"
        case .week: return "/ week"
        case .month: return "/ month"
        case .year: return "/ year"
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
        .task {
            if fixture.exercisesPurchase { _ = await store.prepare() }
        }
        .sheet(isPresented: fixtureBinding) {
            ProGateSheet(
                store: store,
                listingSummary: .fixture,
                startListing: { _ = store.consumeResumeIntent() },
                fallbackToPhotoReview: {},
                context: fixture.sheetContext
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

private extension ProGateFixtureState {
    var sheetContext: ProGateSheetContext {
        switch self {
        case .pay01Plans, .pay04aPlans: .settingsPlans
        default: .itemGate
        }
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
