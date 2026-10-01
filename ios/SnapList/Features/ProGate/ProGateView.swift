import SwiftUI
import UIKit

enum ProGateCopy {
    static let offerTitle = "Keep listing with Pro"
    static let plansTitle = "SnapList Pro"
    static let offerSaved = "Saved."
    static let wantMore = "Want more AI listings?"
    static let slipIncludes = "AI listings every month"
    static let purchaseFailedLead = "Didn’t go through."
    static let purchaseFailed = "Nothing was charged."
    static let nothingToRestore = "No Pro subscription on this Apple Account."
    static let confirmingTitle = "Confirming"
    static let confirmingBubble = "Checking your account."
    static let pendingTitle = "Not confirmed yet"
    static let pendingBubble = "Still checking."
    static let pendingStatement = "Don’t buy again. Check again or restore."
    static let purchaseReadyTitle = "SnapList Pro is on"
    static let restoreReadyTitle = "SnapList Pro is already on"
    static let intakeNeedsPro =
        "This item is saved. It needs SnapList Pro to go through AI."
}

/// Where the paywall was opened from. The item gate interrupts a second AI
/// run for an item that is already saved; Settings opens the same offer on
/// purpose, so it has no item to reassure about or resume.
enum ProGateSheetContext: Equatable {
    case itemGate
    case settingsPlans
}

/// The paywall as a packing scene: Scout on a seller's counter with one short
/// line, and the plan as a taped packing slip whose stamp shows the purchase
/// state. Text stays minimal on purpose: one title, at most one line, and the
/// actions. The slip's Renews row carries the App Review 3.1.2 renewal terms.
@MainActor
struct ProGateSheet: View {
    @Bindable var store: ProGateStore
    let startListing: () -> Void
    let fallbackToPhotoReview: () -> Void
    var context: ProGateSheetContext = .itemGate

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @AccessibilityFocusState private var headingFocused: Bool
    @ScaledMetric(relativeTo: .title2) private var titleSize: CGFloat = 24
    @ScaledMetric(relativeTo: .body) private var bodySize: CGFloat = 15
    @ScaledMetric(relativeTo: .subheadline) private var bubbleSize: CGFloat = 14
    @ScaledMetric(relativeTo: .footnote) private var slipSize: CGFloat = 12
    @ScaledMetric(relativeTo: .caption) private var slipHeaderSize: CGFloat = 10
    @ScaledMetric(relativeTo: .title3) private var slipPriceSize: CGFloat = 19
    @ScaledMetric(relativeTo: .footnote) private var stampSize: CGFloat = 14
    @ScaledMetric(relativeTo: .headline) private var actionSize: CGFloat = 17
    @ScaledMetric(relativeTo: .subheadline) private var plainActionSize: CGFloat = 15
    @ScaledMetric(relativeTo: .footnote) private var quietActionSize: CGFloat = 13

    private static let heroHeight: CGFloat = 224
    private static let slipOverlap: CGFloat = 34

    /// Measured so the drawer fits its content at standard text sizes instead
    /// of opening to an empty full-height sheet.
    @State private var contentHeight: CGFloat = 0
    @State private var footerHeight: CGFloat = 0

    var body: some View {
        Group {
            if isAccessibilitySize {
                ScrollView {
                    sheetContent
                    actionStack
                        .padding(.horizontal, SnapListMetrics.screenGutter)
                        .padding(.top, 8)
                        .padding(.bottom, 20)
                }
                .scrollIndicators(.visible)
            } else {
                // The drawer fits this content exactly, so there is nothing
                // to scroll and a downward drag belongs to the drawer itself.
                sheetContent
                    .frame(maxHeight: .infinity, alignment: .top)
            }
        }
        // The footer pins via `safeAreaInset`, the same primitive
        // `floatingDock(...)` uses for the app-wide dock: it floats the footer
        // over the content and reserves that exact height as safe area, so
        // the content stops above it instead of behind it.
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if !isAccessibilitySize {
                actionStack
                    .padding(.horizontal, SnapListMetrics.screenGutter)
                    .padding(.top, 10)
                    .background(SnapListColorToken.canvas.color)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: {
                        footerHeight = $0
                    }
            }
        }
        .overlay(alignment: .topTrailing) {
            if case .offer = store.state {
                closeControl
            }
        }
        .background(SnapListColorToken.canvas.color)
        .animation(reduceMotion ? nil : .spring(response: 0.42, dampingFraction: 0.62), value: store.state)
        .presentationDetents([detent])
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

    private var isAccessibilitySize: Bool { dynamicTypeSize.isAccessibilitySize }

    private var sheetContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            hero
            if isAccessibilitySize, let bubble = bubbleContent {
                scoutBubble(bubble)
                    .padding(.horizontal, SnapListMetrics.screenGutter)
                    .padding(.top, 12)
            }
            if let product = store.offeredProduct {
                slip(product)
                    .padding(.horizontal, 18)
                    .padding(.top, isAccessibilitySize ? 16 : -Self.slipOverlap)
            }
            heading
                .padding(.horizontal, SnapListMetrics.screenGutter)
                .padding(.top, 20)
                .padding(.bottom, 8)
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: {
            contentHeight = $0
        }
    }

    /// Accessibility sizes keep the full-height sheet so nothing is cut off;
    /// otherwise the drawer is exactly as tall as the scene, slip, title and
    /// actions, plus the home-indicator inset the footer sits above.
    private var detent: PresentationDetent {
        guard !isAccessibilitySize, contentHeight > 0, footerHeight > 0 else {
            return .large
        }
        return .height(contentHeight + footerHeight + 34)
    }

    // MARK: - Hero

    private var hero: some View {
        ZStack(alignment: .bottomLeading) {
            Image(scene.assetName)
                .resizable()
                .scaledToFill()
                .frame(maxWidth: .infinity)
                .frame(height: heroHeight)
                .clipped()
                .accessibilityHidden(true)
            Image(scoutPose)
                .resizable()
                .scaledToFit()
                .frame(height: isAccessibilitySize ? 132 : 150)
                .padding(.leading, 16)
                .padding(.bottom, isAccessibilitySize ? 8 : Self.slipOverlap + 6)
                .id(scoutPose)
                .transition(reduceMotion ? .opacity : .scale(scale: 0.85).combined(with: .opacity))
                .accessibilityHidden(true)
        }
        .frame(height: heroHeight)
        .frame(maxWidth: .infinity)
        .clipped()
        .overlay(alignment: .topTrailing) {
            if !isAccessibilitySize, let bubble = bubbleContent {
                scoutBubble(bubble)
                    .frame(maxWidth: 196, alignment: .leading)
                    .padding(.top, 58)
                    .padding(.trailing, 16)
            }
        }
    }

    private var heroHeight: CGFloat {
        isAccessibilitySize ? 176 : Self.heroHeight
    }

    private func scoutBubble(_ bubble: BubbleContent) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(bubble.lead)
                .font(.system(size: bubbleSize + 1, weight: .semibold))
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
            if let detail = bubble.detail {
                Text(detail)
                    .font(.system(size: bubbleSize))
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, 13)
        .padding(.vertical, 10)
        .background(
            SnapListColorToken.canvas.color,
            in: RoundedRectangle(cornerRadius: 18, style: .continuous)
        )
        .shadow(
            color: SnapListColorToken.inkPrimary.color.opacity(0.14),
            radius: 12,
            y: 6
        )
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(bubble.identifier)
    }

    // MARK: - Packing slip

    private func slip(_ product: SubscriptionProductMetadata) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(verbatim: "\(product.localizedTitle) · \(product.proGatePlanName)".uppercased())
                .font(.system(size: slipHeaderSize, weight: .bold, design: .monospaced))
                .tracking(1)
                .foregroundStyle(SnapListColorToken.proGateSlipLabel.color)
                .padding(.bottom, 4)
            slipRow("Price") {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(verbatim: product.localizedPrice)
                        .font(.system(size: slipPriceSize, weight: .bold))
                        .monospacedDigit()
                        .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    if let unit = product.proGatePerUnit {
                        Text(unit)
                            .font(.system(size: slipSize, weight: .medium))
                            .foregroundStyle(SnapListColorToken.proGateSlipLabel.color)
                    }
                }
            }
            slipRule
            slipRow("Includes") { slipValue(ProGateCopy.slipIncludes) }
            slipRule
            slipRow("Renews") { slipValue(product.proGateRenewsLine) }
            ProGateBarcode()
                .frame(width: 112, height: 20)
                .padding(.top, 10)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, 14)
        .padding(.top, 16)
        .padding(.bottom, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            SnapListColorToken.canvas.color,
            in: RoundedRectangle(cornerRadius: 6, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .stroke(SnapListColorToken.proGateSlipEdge.color, lineWidth: 1)
        }
        .shadow(
            color: SnapListColorToken.proGateSlipInk.color.opacity(0.2),
            radius: 14,
            y: 10
        )
        .overlay(alignment: .top) {
            RoundedRectangle(cornerRadius: 2, style: .continuous)
                .fill(SnapListColorToken.action.color.opacity(0.82))
                .frame(width: 64, height: 18)
                .rotationEffect(.degrees(-3))
                .offset(y: -9)
                .accessibilityHidden(true)
        }
        .overlay(alignment: .bottomTrailing) { stamp }
        .rotationEffect(.degrees(isAccessibilitySize ? 0 : 1.2))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            "\(product.localizedTitle), \(product.proGatePlanName), \(product.proGatePriceDisplay)"
        )
        .accessibilityValue("\(ProGateCopy.slipIncludes). Renews \(product.proGateRenewsLine).")
        .accessibilityIdentifier("pro-gate.plan")
    }

    @ViewBuilder
    private func slipRow<Value: View>(
        _ label: String,
        @ViewBuilder value: () -> Value
    ) -> some View {
        let caption = Text(label)
            .font(.system(size: slipSize, design: .monospaced))
            .foregroundStyle(SnapListColorToken.proGateSlipLabel.color)
        if isAccessibilitySize {
            VStack(alignment: .leading, spacing: 2) {
                caption
                value()
            }
            .padding(.vertical, 6)
        } else {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                caption.frame(width: 72, alignment: .leading)
                value()
                Spacer(minLength: 0)
            }
            .padding(.vertical, 6)
        }
    }

    private func slipValue(_ text: String) -> some View {
        Text(text)
            .font(.system(size: slipSize, design: .monospaced))
            .foregroundStyle(SnapListColorToken.proGateSlipInk.color)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var slipRule: some View {
        Line()
            .stroke(
                SnapListColorToken.proGateSlipRule.color,
                style: StrokeStyle(lineWidth: 1, dash: [3, 3])
            )
            .frame(height: 1)
            .accessibilityHidden(true)
    }

    @ViewBuilder
    private var stamp: some View {
        if let stamp = stampContent {
            Text(stamp.text)
                .font(.system(size: stampSize, weight: .heavy))
                .tracking(1.4)
                .foregroundStyle(stamp.color)
                .padding(.horizontal, 9)
                .padding(.vertical, 5)
                .background(
                    SnapListColorToken.canvas.color.opacity(0.85),
                    in: RoundedRectangle(cornerRadius: 7, style: .continuous)
                )
                .overlay {
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                        .stroke(
                            stamp.color,
                            style: StrokeStyle(lineWidth: 2.5, dash: stamp.dashed ? [5, 3] : [])
                        )
                }
                .rotationEffect(.degrees(-14))
                .padding(12)
                .id(stamp.text)
                .transition(
                    reduceMotion ? .opacity : .scale(scale: 1.8).combined(with: .opacity)
                )
                .accessibilityHidden(true)
        }
    }

    // MARK: - Heading

    private var heading: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.system(size: titleSize, weight: .bold))
                .tracking(-0.4)
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("pro-gate.title")
                .accessibilityFocused($headingFocused)
            if store.state == .verificationPending {
                Text(ProGateCopy.pendingStatement)
                    .font(.system(size: bodySize))
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("pro-gate.statement")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Actions

    @ViewBuilder
    private var actionStack: some View {
        switch store.state {
        case .offer(_, _, let isRestoring):
            VStack(spacing: 2) {
                proGatePrimaryButton("Subscribe") {
                    Task { await store.purchase() }
                }
                quietRow(isRestoring: isRestoring)
            }
        case .confirming:
            busyLabel("Checking", size: plainActionSize)
                .frame(maxWidth: .infinity, minHeight: SnapListMetrics.primaryButtonHeight)
                .background(
                    SnapListColorToken.mutedSurface.color,
                    in: Capsule()
                )
                .padding(.bottom, 16)
                .accessibilityIdentifier("pro-gate.confirming")
        case .verificationPending:
            VStack(spacing: 2) {
                proGatePrimaryButton("Check again") {
                    Task { await store.refreshPendingVerification() }
                }
                .accessibilityIdentifier("pro-gate.check-again")
                HStack(spacing: 12) {
                    plainButton("Restore purchase", identifier: "pro-gate.restore-purchase") {
                        restore()
                    }
                    plainButton("Close", identifier: "pro-gate.close") {
                        store.dismiss()
                    }
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

    /// Restore and the two legal documents share one quiet row under
    /// Subscribe, so the decision is the only thing that reads loudly.
    @ViewBuilder
    private func quietRow(isRestoring: Bool) -> some View {
        let restoreControl = Group {
            if isRestoring {
                busyLabel("Checking", size: quietActionSize)
            } else {
                Button(action: restore) {
                    Text("Restore")
                        .font(.system(size: quietActionSize, weight: .medium))
                        .frame(
                            minWidth: ProGateLegalFooter.minimumTarget,
                            minHeight: ProGateLegalFooter.minimumTarget
                        )
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .foregroundStyle(SnapListColorToken.textSecondary.color)
                .accessibilityLabel("Restore purchase")
                .accessibilityIdentifier("pro-gate.restore-purchase")
            }
        }
        if isAccessibilitySize {
            VStack(spacing: 0) {
                restoreControl
                ProGateLegalFooter()
            }
        } else {
            HStack(spacing: 2) {
                restoreControl
                ProGateLegalFooter.separator(size: quietActionSize)
                ProGateLegalFooter()
            }
        }
    }

    private var closeControl: some View {
        Button {
            store.dismiss()
        } label: {
            Image(systemName: "xmark")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(SnapListColorToken.textSecondary.color)
                .frame(width: 30, height: 30)
                .background(SnapListColorToken.canvas.color.opacity(0.9), in: Circle())
                .frame(
                    width: ProGateLegalFooter.minimumTarget,
                    height: ProGateLegalFooter.minimumTarget
                )
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .padding(.top, 10)
        .padding(.trailing, 10)
        .accessibilityLabel("Not now")
        .accessibilityIdentifier("pro-gate.not-now")
    }

    private func restore() {
        Task {
            if await store.restore() == .fallbackToPhotoReview {
                fallbackToPhotoReview()
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
                .frame(maxWidth: .infinity, minHeight: ProGateLegalFooter.minimumTarget)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(identifier)
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

    // MARK: - State presentation

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

    private enum Scene {
        case counter, pending, success

        var assetName: String {
            switch self {
            case .counter: "ProGateCounterScene"
            case .pending: "ProGatePendingScene"
            case .success: "ProGateSuccessScene"
            }
        }
    }

    private var scene: Scene {
        switch store.state {
        case .offer, .hidden: .counter
        case .confirming, .verificationPending: .pending
        case .ready: .success
        }
    }

    private var scoutPose: String {
        switch store.state {
        case .offer(_, .some, _), .verificationPending: "ScoutUncertain"
        case .offer, .hidden: "FirstValueScoutONB03"
        case .confirming: "ScoutAnalyzing"
        case .ready: "ActivationScoutACT04"
        }
    }

    private struct BubbleContent {
        let lead: String
        var detail: String?
        var identifier = "pro-gate.scout-bubble"
    }

    private var bubbleContent: BubbleContent? {
        switch store.state {
        case .offer(_, .purchaseDidNotComplete, _):
            BubbleContent(
                lead: ProGateCopy.purchaseFailedLead,
                detail: ProGateCopy.purchaseFailed,
                identifier: "pro-gate.advisory"
            )
        case .offer(_, .nothingToRestore, _):
            BubbleContent(lead: ProGateCopy.nothingToRestore, identifier: "pro-gate.advisory")
        case .offer:
            context == .itemGate
                ? BubbleContent(lead: ProGateCopy.offerSaved, detail: ProGateCopy.wantMore)
                : BubbleContent(lead: ProGateCopy.wantMore)
        case .confirming: BubbleContent(lead: ProGateCopy.confirmingBubble)
        case .verificationPending: BubbleContent(lead: ProGateCopy.pendingBubble)
        case .ready, .hidden: nil
        }
    }

    private struct StampContent {
        let text: String
        let color: Color
        let dashed: Bool
    }

    private var stampContent: StampContent? {
        switch store.state {
        case .confirming:
            StampContent(
                text: "CHECKING",
                color: SnapListColorToken.proGateSlipLabel.color,
                dashed: true
            )
        case .verificationPending:
            StampContent(
                text: "NOT CONFIRMED",
                color: SnapListColorToken.proGateSlipLabel.color,
                dashed: true
            )
        case .ready:
            StampContent(text: "PRO ON", color: SnapListColorToken.action.color, dashed: false)
        case .offer, .hidden:
            nil
        }
    }

    private func focusHeading() {
        Task { @MainActor in
            await Task.yield()
            headingFocused = true
        }
    }
}

private struct Line: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.midY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
        return path
    }
}

/// Decorative bars at the foot of the packing slip.
private struct ProGateBarcode: View {
    private static let bars: [CGFloat] = [2, 1, 1, 3, 1, 2, 2, 1, 3, 1, 1, 2, 1, 3, 2, 1, 1, 2, 3, 1, 2, 1, 1, 3]

    var body: some View {
        Canvas { context, size in
            let unit = size.width / Self.bars.reduce(0) { $0 + $1 + 1 }
            var x: CGFloat = 0
            for (index, bar) in Self.bars.enumerated() {
                let width = bar * unit
                if index.isMultiple(of: 2) {
                    context.fill(
                        Path(CGRect(x: x, y: 0, width: width, height: size.height)),
                        with: .color(SnapListColorToken.proGateSlipInk.color.opacity(0.75))
                    )
                }
                x += width + unit
            }
        }
    }
}

/// The paywall's Terms/Privacy links (issue #812). App Review 3.1.2 requires
/// both documents reachable wherever the auto-renewing subscription is
/// offered, and `.offer` is the only `ProGateStore.State` that offers one.
struct ProGateLegalFooter: View {
    @Environment(\.openURL) private var openURL
    @ScaledMetric(relativeTo: .footnote) private var footerSize: CGFloat = 13

    /// Pads past the 44pt floor because a fitted (non-full) sheet floats
    /// inset from the screen edges and draws its content slightly scaled, so
    /// the measured on-screen target, not just the requested frame, must
    /// clear 44pt; see `testProGateOfferLegalFooterOpensTermsAndPrivacy`.
    static let minimumTarget = SnapListMetrics.minimumTouchTarget + 4

    var body: some View {
        HStack(spacing: 2) {
            link("Terms", destination: .termsOfService, identifier: "pro-gate.terms-of-service")
            Self.separator(size: footerSize)
            link("Privacy", destination: .privacyPolicy, identifier: "pro-gate.privacy-policy")
        }
    }

    static func separator(size: CGFloat) -> some View {
        Text("·")
            .font(.system(size: size))
            .foregroundStyle(SnapListColorToken.textTertiary.color)
            .accessibilityHidden(true)
    }

    /// `.frame` alone only grows layout space, not the hit-tested region for a
    /// `.buttonStyle(.plain)` button; `.contentShape(.rect)` makes that region
    /// cover the frame at every Dynamic Type size.
    private func link(
        _ label: String,
        destination: LegalDestination,
        identifier: String
    ) -> some View {
        Button {
            openURL(destination.url)
        } label: {
            Text(label)
                .font(.system(size: footerSize, weight: .medium))
                .frame(minWidth: Self.minimumTarget, minHeight: Self.minimumTarget)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .foregroundStyle(SnapListColorToken.textSecondary.color)
        .accessibilityLabel(destination.label)
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

    /// The short unit drawn beside the price ("a month"); nil when the period
    /// is not a single unit, where the slip header already carries it.
    var proGatePerUnit: String? {
        guard billingPeriod.value == 1 else { return nil }
        switch billingPeriod.unit {
        case .day: return "a day"
        case .week: return "a week"
        case .month: return "a month"
        case .year: return "a year"
        }
    }

    /// App Review Guideline 3.1.2 requires the auto-renewing subscription's
    /// billing period and its renew-until-canceled terms beside the purchase
    /// action. The slip's Renews row carries them, keyed off the live
    /// `billingPeriod` rather than a hardcoded "month".
    var proGateRenewsLine: String {
        switch (billingPeriod.value, billingPeriod.unit) {
        case (1, .day): "Daily until canceled, via Apple"
        case (1, .week): "Weekly until canceled, via Apple"
        case (1, .month): "Monthly until canceled, via Apple"
        case (1, .year): "Yearly until canceled, via Apple"
        default:
            localizedBillingPeriod().map { "Every \($0) until canceled, via Apple" }
                ?? "Until canceled, via Apple"
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

#endif
