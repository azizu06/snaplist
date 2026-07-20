import Charts
import SwiftUI
import UIKit

@MainActor
struct PricingRouteView: View {
    let itemID: UUID
    let repository: any PricingRepository
    let navigate: (FutureBoundary) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var loadState = PricingRouteLoadState.loading
    @StateObject private var draftState = PricingRouteDraftState()

    var body: some View {
        Group {
            switch loadState {
            case .loading:
                ProgressView("Finding recent sold listings for this item…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityIdentifier("pricing.loading")
            case .loaded(let model):
                PricingFeatureView(
                    model: model,
                    actions: PricingRouteActionComposition.make(
                        draftState: draftState,
                        openSource: { _ = openURL($0) },
                        navigate: navigate,
                        retry: { Task { await load() } },
                        dismiss: { dismiss() }
                    )
                )
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("pricing.route.loaded")
            case .failed:
                VStack(spacing: 16) {
                    Text("Couldn’t load pricing evidence")
                        .snapListTypography(.displayTitle)
                    Text("Your price, cost, and any edits are saved. This didn’t change anything — try again.")
                        .snapListTypography(.body)
                        .foregroundStyle(SnapListColorToken.textSecondary.color)
                        .multilineTextAlignment(.center)
                    Button("Try again") {
                        Task { await load() }
                    }
                    .buttonStyle(.borderedProminent)
                    .frame(minHeight: SnapListMetrics.minimumTouchTarget)
                }
                .padding(SnapListMetrics.screenGutter)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityIdentifier("pricing.load-failed")
            }
        }
        .background(SnapListColorToken.canvas.color.ignoresSafeArea())
        .task(id: itemID) { await load() }
    }

    private func load() async {
        loadState = .loading
        do {
            loadState = .loaded(try await repository.fetchPricing(itemID: itemID))
        } catch {
            loadState = .failed
        }
    }
}

private enum PricingRouteLoadState {
    case loading
    case loaded(PricingFeatureModel)
    case failed
}

@MainActor
struct PricingFeatureView: View {
    @StateObject private var store: PricingFeatureStore
    private let forceReducedMotion: Bool

    init(
        model: PricingFeatureModel,
        actions: PricingFeatureActions = .init(),
        initialRoute: PricingFeatureRoute = .overview,
        forceReducedMotion: Bool = false
    ) {
        let store = PricingFeatureStore(model: model, actions: actions)
        store.navigationPath = initialRoute == .overview ? [] : [initialRoute]
        _store = StateObject(wrappedValue: store)
        self.forceReducedMotion = forceReducedMotion
    }

    var body: some View {
        NavigationStack(path: $store.navigationPath) {
            PricingOverviewView(
                store: store,
                forceReducedMotion: forceReducedMotion
            )
            .navigationDestination(for: PricingFeatureRoute.self) { route in
                switch route {
                case .overview:
                    PricingOverviewView(
                        store: store,
                        forceReducedMotion: forceReducedMotion
                    )
                case .allComparables:
                    PricingAllComparablesView(store: store)
                case .selectedComparable(let id):
                    PricingSelectedComparableView(store: store, comparableID: id)
                case .providerBoundary(let id):
                    PricingProviderBoundaryView(store: store, comparableID: id)
                }
            }
        }
        .background(SnapListColorToken.canvas.color.ignoresSafeArea())
        .tint(SnapListColorToken.action.color)
        .sheet(item: $store.presentedSheet) { sheet in
            switch sheet {
            case .manualPrice:
                PricingMoneyEntrySheet(store: store, mode: .manualPrice)
            case .costBasis:
                PricingMoneyEntrySheet(store: store, mode: .costBasis)
            }
        }
    }

}

private struct PricingOverviewView: View {
    @ObservedObject var store: PricingFeatureStore
    let forceReducedMotion: Bool

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                PricingProductSummary(model: store.model)

                if case .current = store.model.refreshState {
                    EmptyView()
                } else {
                    PricingRefreshBanner(store: store)
                }

                PricingRecommendationSummary(store: store)

                PricingEvidenceChart(store: store)

                PricingWindowSelector(store: store)

                Text(evidenceExplanation)
                    .snapListTypography(.metadata)
                    .foregroundStyle(SnapListColorToken.textTertiary.color)
                    .fixedSize(horizontal: false, vertical: true)

                ForEach(Array(store.snapshot.comparables.prefix(2))) { comparable in
                    PricingComparableRow(
                        comparable: comparable,
                        isSelected: store.selectedComparable?.id == comparable.id,
                        action: { store.selectComparable(id: comparable.id) }
                    )
                }

                if !store.snapshot.comparables.isEmpty {
                    Button {
                        store.showAllComparables()
                    } label: {
                        HStack {
                            Text("View all \(store.snapshot.soldCount) sold comps")
                                .snapListTypography(.rowTitle)
                            Spacer()
                            Image(systemName: "chevron.right")
                        }
                        .foregroundStyle(SnapListColorToken.action.color)
                        .frame(maxWidth: .infinity)
                        .frame(minHeight: SnapListMetrics.minimumTouchTarget)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("pricing.view-all-comps")
                }

                if store.model.evidenceLevel == .limited {
                    PricingScoutGuidance(store: store)
                }
            }
            .padding(.horizontal, SnapListMetrics.screenGutter)
            .padding(.top, 12)
            .padding(.bottom, 16)
        }
        .background(SnapListColorToken.canvas.color.ignoresSafeArea())
        .safeAreaInset(edge: .bottom, spacing: 0) {
            PricingActionTray(
                store: store,
                forceReducedMotion: forceReducedMotion
            )
        }
        .navigationTitle("Pricing")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(true)
        .toolbarBackground(SnapListColorToken.canvas.color, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button(action: store.actions.dismissPricing) {
                    Label("Back", systemImage: "chevron.left")
                        .labelStyle(.titleAndIcon)
                        .frame(minHeight: SnapListMetrics.minimumTouchTarget)
                }
                .accessibilityIdentifier("pricing.back")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button(action: store.actions.showPricingHelp) {
                    Image(systemName: "questionmark.circle")
                        .font(.title3)
                        .frame(
                            minWidth: SnapListMetrics.minimumTouchTarget,
                            minHeight: SnapListMetrics.minimumTouchTarget
                        )
                }
                .accessibilityLabel("Pricing help")
                .accessibilityIdentifier("pricing.help")
            }
        }
    }

    private var evidenceExplanation: String {
        guard store.snapshot.soldCount > 0 else {
            return "No disclosed sold prices fall in this window. Try a wider range."
        }
        let missingDateCount = store.snapshot.soldCount - store.snapshot.chartPoints.count
        let missingDateCopy = missingDateCount > 0
            ? " \(missingDateCount) sold record\(missingDateCount == 1 ? " has" : "s have") no sold date, so \(missingDateCount == 1 ? "it is" : "they are") listed below but not plotted."
            : ""
        if store.model.evidenceLevel == .limited {
            return "Range is wide because sales are sparse — only \(store.snapshot.soldCount) found. Drag the chart to inspect a dated sale, or tap one below.\(missingDateCopy)"
        }
        return "Each point is one real eBay sold price. Drag the chart to inspect a dated sale, or tap one below.\(missingDateCopy)"
    }
}

private struct PricingProductSummary: View {
    let model: PricingFeatureModel

    var body: some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 10)
                .fill(SnapListColorToken.groupingFill.color)
                .frame(width: 56, height: 56)
                .overlay {
                    Image(systemName: model.evidenceLevel == .limited ? "paintpalette" : "tshirt")
                        .font(.title2)
                        .foregroundStyle(SnapListColorToken.textTertiary.color)
                }
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 3) {
                Text(model.item.title)
                    .snapListTypography(.rowTitle)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .fixedSize(horizontal: false, vertical: true)

                Text(model.item.condition)
                    .snapListTypography(.status)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("pricing.item-summary")
    }
}

private struct PricingRecommendationSummary: View {
    @ObservedObject var store: PricingFeatureStore

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(heading.uppercased())
                .font(.caption.weight(.semibold))
                .tracking(1.1)
                .foregroundStyle(SnapListColorToken.textSecondary.color)

            ViewThatFits(in: .horizontal) {
                HStack(alignment: .lastTextBaseline, spacing: 10) {
                    priceText
                    Text(bandCopy)
                        .snapListTypography(.body)
                        .foregroundStyle(SnapListColorToken.textSecondary.color)
                }

                VStack(alignment: .leading, spacing: 4) {
                    priceText
                    Text(bandCopy)
                        .snapListTypography(.body)
                        .foregroundStyle(SnapListColorToken.textSecondary.color)
                }
            }

            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { badges }
                VStack(alignment: .leading, spacing: 6) { badges }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilitySummary)
        .accessibilityIdentifier("pricing.recommendation-summary")
    }

    private var priceText: some View {
        Text(PricingMoney.whole(store.effectivePrice))
            .font(.system(.largeTitle, design: .default, weight: .bold))
            .monospacedDigit()
            .foregroundStyle(SnapListColorToken.inkPrimary.color)
    }

    @ViewBuilder
    private var badges: some View {
        SnapListChip(
            evidenceTitle,
            systemImage: store.model.evidenceLevel == .strong
                ? "checkmark"
                : "exclamationmark.triangle",
            variant: store.model.evidenceLevel == .strong ? .evidenceStrong : .caution
        )

        SnapListChip(soldSummary, variant: .neutral)

        if store.model.evidenceLevel == .limited,
           let lastSaleAt = store.snapshot.lastSaleAt {
            SnapListChip(
                "Last sale · \(PricingDate.short(lastSaleAt))",
                variant: .neutral
            )
        }
    }

    private var heading: String {
        if store.usesManualPriceOverride { return "Your price" }
        return store.model.evidenceLevel == .strong ? "Suggested price" : "Rough estimate"
    }

    private var evidenceTitle: String {
        store.model.evidenceLevel == .strong ? "Strong evidence" : "Limited evidence"
    }

    private var bandCopy: String {
        let range = store.model.priceResult.range
        let formatted = "\(PricingMoney.whole(range.min))–\(PricingMoney.whole(range.max))"
        if store.usesManualPriceOverride {
            return "sold evidence · \(formatted)"
        }
        return store.model.evidenceLevel == .strong
            ? "most sell for \(formatted)"
            : "wide range · \(formatted)"
    }

    private var soldSummary: String {
        guard let days = store.selectedWindow.dayCount else {
            return "\(store.snapshot.soldCount) sold · all dates"
        }
        if store.snapshot.chartPoints.count != store.snapshot.soldCount {
            return "\(store.snapshot.soldCount) sold · \(store.snapshot.chartPoints.count) dated in \(days) days"
        }
        let suffix = store.model.evidenceLevel == .strong ? " · not asking" : ""
        return "\(store.snapshot.soldCount) sold · \(days) days\(suffix)"
    }

    private var accessibilitySummary: String {
        "\(heading), \(PricingMoney.spoken(store.effectivePrice)). \(bandCopy). \(evidenceTitle). \(soldSummary)."
    }
}

private struct PricingEvidenceChart: View {
    @ObservedObject var store: PricingFeatureStore
    @ScaledMetric(relativeTo: .caption) private var pointSize = 5.0

    @ViewBuilder
    var body: some View {
        if points.isEmpty {
            VStack(spacing: 8) {
                Image(systemName: "chart.xyaxis.line")
                    .font(.title2)
                    .foregroundStyle(SnapListColorToken.textTertiary.color)
                Text("No sold evidence in this window")
                    .snapListTypography(.rowTitle)
                Text("Choose a wider time range to check the available sold records.")
                    .snapListTypography(.status)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity, minHeight: 170)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("pricing.sold-chart.empty")
        } else {
            chart
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Sold price chart")
                .accessibilityValue(accessibilitySummary)
                .accessibilityHint("The sold listings below expose every plotted sale.")
                .accessibilityIdentifier("pricing.sold-chart")
        }
    }

    private var chart: some View {
        Chart {
            ForEach(points) { point in
                    AreaMark(
                        x: .value("Sold date", point.soldAt),
                        yStart: .value("Chart floor", lowerBound),
                        yEnd: .value("Sold price", point.price.doubleValue)
                    )
                    .interpolationMethod(.linear)
                    .foregroundStyle(
                        LinearGradient(
                            colors: [
                                SnapListColorToken.action.color.opacity(0.16),
                                SnapListColorToken.action.color.opacity(0.01)
                            ],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )

                    LineMark(
                        x: .value("Sold date", point.soldAt),
                        y: .value("Sold price", point.price.doubleValue)
                    )
                    .interpolationMethod(.linear)
                    .lineStyle(StrokeStyle(lineWidth: 2))
                    .foregroundStyle(SnapListColorToken.action.color)

                    PointMark(
                        x: .value("Sold date", point.soldAt),
                        y: .value("Sold price", point.price.doubleValue)
                    )
                    .symbolSize(pointSize * pointSize)
                    .foregroundStyle(SnapListColorToken.action.color)
            }

            RuleMark(y: .value("Recommendation", store.model.priceResult.suggested.doubleValue))
                .lineStyle(StrokeStyle(lineWidth: 1, dash: [5, 5]))
                .foregroundStyle(SnapListColorToken.action.color.opacity(0.55))
                .annotation(position: .leading, alignment: .center) {
                    Text(recommendationRuleLabel)
                        .font(.caption.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(SnapListColorToken.action.color)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 2)
                        .background(SnapListColorToken.infoChipFill.color)
                        .clipShape(.capsule)
                }

            if let selected = store.selectedComparable,
               let soldAt = selected.soldAt {
                RuleMark(x: .value("Selected sold date", soldAt))
                    .foregroundStyle(SnapListColorToken.textTertiary.color.opacity(0.7))

                PointMark(
                    x: .value("Selected sold date", soldAt),
                    y: .value("Selected sold price", selected.price.doubleValue)
                )
                .symbolSize(pointSize * pointSize * 3)
                .foregroundStyle(SnapListColorToken.action.color)
                .annotation(position: .top, spacing: 8) {
                    PricingSelectedComparableCallout(
                        comparable: selected,
                        openSource: store.showProviderBoundary
                    )
                }
            }
        }
        .chartXScale(domain: xDomain)
        .chartYScale(domain: lowerBound...upperBound)
        .chartXAxis(.hidden)
        .chartYAxis {
            AxisMarks(position: .leading, values: [lowerBound, upperBound]) { value in
                AxisValueLabel {
                    if let amount = value.as(Double.self) {
                        Text(PricingMoney.whole(Decimal(amount)))
                            .font(.caption)
                            .foregroundStyle(Color(hex: "#6B6E73"))
                            .monospacedDigit()
                    }
                }
                AxisGridLine().foregroundStyle(.clear)
                AxisTick().foregroundStyle(.clear)
            }
        }
        .chartOverlay { proxy in
            GeometryReader { geometry in
                if let plotFrame = proxy.plotFrame {
                    let frame = geometry[plotFrame]
                    Color.clear
                        .contentShape(.rect)
                        .frame(width: frame.width, height: frame.height)
                        .position(x: frame.midX, y: frame.midY)
                        .gesture(
                            DragGesture(minimumDistance: 0)
                                .onChanged { value in
                                    let x = value.location.x - frame.minX
                                    guard let date = proxy.value(atX: x, as: Date.self),
                                          let nearest = nearestComparable(to: date) else {
                                        return
                                    }
                                    store.selectComparable(id: nearest.id)
                                }
                        )
                }
            }
        }
        .frame(height: 150)
    }

    private var points: [PricingChartPoint] {
        store.snapshot.chartPoints.sorted { $0.soldAt < $1.soldAt }
    }

    private var chartBounds: PricingPriceRange {
        if let bounds = store.model.chartBounds { return bounds }
        if let range = store.snapshot.soldRange, range.min < range.max { return range }
        let price = store.model.priceResult.suggested
        return PricingPriceRange(min: max(0, price - 1), max: price + 1)
    }

    private var lowerBound: Double { chartBounds.min.doubleValue }
    private var upperBound: Double { chartBounds.max.doubleValue }

    private var xDomain: ClosedRange<Date> {
        guard let first = points.first?.soldAt, let last = points.last?.soldAt else {
            return store.model.evidenceAsOf.addingTimeInterval(-86_400)...store.model.evidenceAsOf
        }
        if first == last {
            return first.addingTimeInterval(-43_200)...last.addingTimeInterval(43_200)
        }
        return first...last
    }

    private var recommendationRuleLabel: String {
        let suffix = store.model.evidenceLevel == .limited ? " est." : ""
        return "\(PricingMoney.whole(store.model.priceResult.suggested))\(suffix)"
    }

    private func nearestComparable(to date: Date) -> PricingSoldComparable? {
        guard let point = points.min(by: {
            abs($0.soldAt.timeIntervalSince(date)) < abs($1.soldAt.timeIntervalSince(date))
        }) else { return nil }
        return store.model.comparable(id: point.comparableID)
    }

    private var accessibilitySummary: String {
        PricingAccessibility.chartSummary(
            snapshot: store.snapshot,
            selectedComparable: store.selectedComparable
        )
    }
}

private struct PricingSelectedComparableCallout: View {
    let comparable: PricingSoldComparable
    let openSource: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(PricingMoney.exact(comparable.price))
                .snapListTypography(.rowTitle)
                .monospacedDigit()
            Text("Sold \(PricingDate.short(comparable.soldAt)) · \(comparable.condition)")
                .snapListTypography(.metadata)
                .foregroundStyle(SnapListColorToken.textSecondary.color)
            Button("View original listing", action: openSource)
                .font(.caption.weight(.semibold))
                .frame(minHeight: SnapListMetrics.minimumTouchTarget)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(.white)
        .clipShape(.rect(cornerRadius: 10))
        .shadow(color: .black.opacity(0.12), radius: 8, y: 3)
        .accessibilityElement(children: .contain)
    }
}

private struct PricingSelectedComparableView: View {
    @ObservedObject var store: PricingFeatureStore
    let comparableID: String

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                PricingProductSummary(model: store.model)

                if let comparable = store.model.comparable(id: comparableID) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Sold \(PricingDate.short(comparable.soldAt)) · \(comparable.condition)")
                            .snapListTypography(.rowTitle)
                            .foregroundStyle(SnapListColorToken.inkPrimary.color)
                        Text(PricingMoney.exact(comparable.price))
                            .font(.system(.largeTitle, design: .default, weight: .bold))
                            .monospacedDigit()
                            .foregroundStyle(SnapListColorToken.inkPrimary.color)
                        Text(comparable.title)
                            .snapListTypography(.body)
                            .foregroundStyle(SnapListColorToken.textSecondary.color)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                    .background(SnapListColorToken.groupingFill.color)
                    .clipShape(.rect(cornerRadius: 14))

                    SnapListPrimaryButton(
                        title: "View original sold listing on eBay",
                        action: store.showProviderBoundary
                    )
                    .accessibilityLabel(
                        "View original sold listing on eBay, sold \(PricingDate.spoken(comparable.soldAt)), \(PricingMoney.spoken(comparable.price))"
                    )
                }
            }
            .padding(SnapListMetrics.screenGutter)
        }
        .background(SnapListColorToken.canvas.color.ignoresSafeArea())
        .navigationTitle("Pricing")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("pricing.selected-comparable")
    }
}

private struct PricingProviderBoundaryView: View {
    @ObservedObject var store: PricingFeatureStore
    let comparableID: String

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("View original on eBay")
                    .snapListTypography(.displayTitle)

                SnapListChip("Leaves SnapList", systemImage: "arrow.up.right", variant: .neutral)

                if let comparable = store.model.comparable(id: comparableID) {
                    Text("Sold \(PricingDate.short(comparable.soldAt)) · \(comparable.condition) · \(PricingMoney.exact(comparable.price))")
                        .snapListTypography(.body)
                        .foregroundStyle(SnapListColorToken.inkPrimary.color)

                    Text("SnapList shows real completed sales. We don’t change the listing — this is a read-only reference.")
                        .snapListTypography(.body)
                        .foregroundStyle(SnapListColorToken.textSecondary.color)

                    SnapListPrimaryButton(
                        title: "Open on eBay",
                        action: store.openSelectedSource
                    )
                }
            }
            .padding(SnapListMetrics.screenGutter)
        }
        .background(SnapListColorToken.canvas.color.ignoresSafeArea())
        .navigationTitle("eBay sold listing")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("pricing.provider-boundary")
    }
}

private struct PricingWindowSelector: View {
    @ObservedObject var store: PricingFeatureStore

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { controls }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) { controls }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Sold evidence time range")
    }

    @ViewBuilder
    private var controls: some View {
        ForEach(PricingEvidenceWindow.allCases) { window in
            let isSelected = store.selectedWindow == window
            Button {
                store.selectWindow(window)
            } label: {
                Text(window.rawValue)
                    .snapListTypography(.status)
                    .foregroundStyle(isSelected ? .white : SnapListColorToken.textSecondary.color)
                    .frame(maxWidth: .infinity)
                    .frame(minWidth: 72, minHeight: SnapListMetrics.minimumTouchTarget)
                    .background(
                        isSelected
                            ? SnapListColorToken.inkPrimary.color
                            : Color(hex: "#F2F3F5")
                    )
                    .clipShape(.rect(cornerRadius: 10))
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(isSelected ? .isSelected : [])
            .accessibilityIdentifier("pricing.window.\(window.rawValue.lowercased())")
        }
    }
}

private struct PricingComparableRow: View {
    let comparable: PricingSoldComparable
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                RoundedRectangle(cornerRadius: 9)
                    .fill(SnapListColorToken.groupingFill.color)
                    .frame(width: 42, height: 42)
                    .overlay {
                        Image(systemName: "shippingbox")
                            .foregroundStyle(SnapListColorToken.textTertiary.color)
                    }
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 2) {
                    Text("Sold \(PricingDate.short(comparable.soldAt)) · \(comparable.condition)")
                        .font(.system(.subheadline, design: .default, weight: .medium))
                        .foregroundStyle(SnapListColorToken.inkPrimary.color)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("eBay · disclosed sold price")
                        .snapListTypography(.metadata)
                        .foregroundStyle(SnapListColorToken.textTertiary.color)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                Text(PricingMoney.exact(comparable.price))
                    .snapListTypography(.rowTitle)
                    .monospacedDigit()
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)

                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(SnapListColorToken.textTertiary.color)
            }
            .padding(.vertical, 8)
            .padding(.horizontal, isSelected ? 8 : 0)
            .frame(minHeight: 58)
            .background(isSelected ? SnapListColorToken.infoChipFill.color : .clear)
            .clipShape(.rect(cornerRadius: 12))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .overlay(alignment: .bottom) {
            Divider().foregroundStyle(SnapListColorToken.hairline.color)
        }
        .accessibilityLabel(
            "Sold \(PricingDate.spoken(comparable.soldAt)), \(comparable.condition), \(PricingMoney.spoken(comparable.price))"
        )
        .accessibilityHint(
            comparable.soldAt == nil
                ? "Selects this sale. It is not plotted because its sold date is unavailable."
                : "Selects this sale and shows the same record on the chart."
        )
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier("pricing.comp.\(comparable.id)")
    }
}

private struct PricingAllComparablesView: View {
    @ObservedObject var store: PricingFeatureStore

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                PricingProductSummary(model: store.model)

                ViewThatFits(in: .horizontal) {
                    HStack { stats }
                    VStack(alignment: .leading, spacing: 4) { stats }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(SnapListColorToken.groupingFill.color)
                .clipShape(.rect(cornerRadius: 12))

                ForEach(store.snapshot.comparables) { comparable in
                    PricingComparableRow(
                        comparable: comparable,
                        isSelected: store.selectedComparable?.id == comparable.id,
                        action: { store.selectComparable(id: comparable.id) }
                    )
                }

                Text("Actual disclosed sold prices. Select any sale to inspect it, then open the original source.")
                    .snapListTypography(.metadata)
                    .foregroundStyle(SnapListColorToken.textTertiary.color)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.vertical, 8)
            }
            .padding(.horizontal, SnapListMetrics.screenGutter)
            .padding(.vertical, 12)
        }
        .background(SnapListColorToken.canvas.color.ignoresSafeArea())
        .navigationTitle("Sold comps")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(SnapListColorToken.canvas.color, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .accessibilityIdentifier("pricing.all-comps")
    }

    @ViewBuilder
    private var stats: some View {
        Text("\(store.snapshot.soldCount) sold · \(windowDescription)")
            .snapListTypography(.status)
            .foregroundStyle(SnapListColorToken.textSecondary.color)
        Spacer(minLength: 8)
        if let median = store.snapshot.median,
           let range = store.snapshot.soldRange {
            Text(
                "median \(PricingMoney.whole(median)) · range \(PricingMoney.whole(range.min))–\(PricingMoney.whole(range.max))"
            )
            .snapListTypography(.status)
            .fontWeight(.semibold)
            .monospacedDigit()
            .foregroundStyle(SnapListColorToken.inkPrimary.color)
        }
    }

    private var windowDescription: String {
        guard let days = store.selectedWindow.dayCount else { return "all dates" }
        if store.snapshot.chartPoints.count != store.snapshot.soldCount {
            return "\(store.snapshot.chartPoints.count) dated in last \(days) days"
        }
        return "last \(days) days"
    }
}

private struct PricingRefreshBanner: View {
    @ObservedObject var store: PricingFeatureStore

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .foregroundStyle(SnapListColorToken.caution.color)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .snapListTypography(.rowTitle)
                Text(message)
                    .snapListTypography(.status)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Button("Retry", action: store.actions.retryRefresh)
                .font(.callout.weight(.semibold))
                .frame(minHeight: SnapListMetrics.minimumTouchTarget)
        }
        .padding(12)
        .background(SnapListColorToken.cautionFill.color)
        .clipShape(.rect(cornerRadius: 12))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("pricing.refresh-banner")
        .onAppear {
            UIAccessibility.post(
                notification: .announcement,
                argument: "\(title). \(message)"
            )
        }
    }

    private var title: String {
        store.model.refreshState.presentation?.title ?? ""
    }

    private var icon: String {
        store.model.refreshState.presentation?.systemImage ?? ""
    }

    private var message: String {
        store.model.refreshState.presentation?.message ?? ""
    }
}

private struct PricingScoutGuidance: View {
    @ObservedObject var store: PricingFeatureStore

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image("ScoutUncertain")
                .resizable()
                .scaledToFit()
                .frame(width: 72, height: 72)
                .accessibilityLabel("Scout, unsure")

            VStack(alignment: .leading, spacing: 8) {
                Text("I only found \(store.snapshot.soldCount) similar sales, so this range is wide. Want to refine the match on this same item, or set your own price?")
                    .snapListTypography(.status)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .fixedSize(horizontal: false, vertical: true)

                Button("Refine the match", action: store.actions.requestGuidedCorrection)
                    .font(.callout.weight(.semibold))
                    .frame(minHeight: SnapListMetrics.minimumTouchTarget)

                Button("Set price myself") {
                    store.presentedSheet = .manualPrice
                }
                .font(.callout.weight(.semibold))
                .frame(minHeight: SnapListMetrics.minimumTouchTarget)

                Text("Refining reuses your current item and photos.")
                    .snapListTypography(.metadata)
                    .foregroundStyle(SnapListColorToken.textTertiary.color)
            }
            .padding(12)
            .background(SnapListColorToken.primerBubbleFill.color)
            .clipShape(.rect(cornerRadius: 14))
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("pricing.scout-limited-evidence")
    }
}

private struct PricingActionTray: View {
    @ObservedObject var store: PricingFeatureStore
    let forceReducedMotion: Bool

    var body: some View {
        SnapListPinnedActionTray {
            VStack(spacing: 10) {
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(payoutTitle)
                            .snapListTypography(.status)
                            .fontWeight(.semibold)
                            .monospacedDigit()
                            .foregroundStyle(SnapListColorToken.inkPrimary.color)
                        Text(payoutSupport)
                            .snapListTypography(.metadata)
                            .foregroundStyle(SnapListColorToken.textSecondary.color)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)

                    Button(store.costBasis == nil ? "Add cost" : "Edit cost") {
                        store.presentedSheet = .costBasis
                    }
                    .font(.callout.weight(.semibold))
                    .frame(minHeight: SnapListMetrics.minimumTouchTarget)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(SnapListColorToken.groupingFill.color)
                .clipShape(.rect(cornerRadius: 13))

                SnapListPrimaryButton(
                    title: "Use \(PricingMoney.whole(store.effectivePrice)) and continue",
                    forceReducedMotion: forceReducedMotion,
                    action: store.continueToDraft
                )

                SnapListSecondaryButton(title: "Set my own price") {
                    store.presentedSheet = .manualPrice
                }
            }
        }
        .accessibilityIdentifier("pricing.action-tray")
    }

    private var payoutTitle: String {
        if let profit = store.estimatedProfit {
            return "Estimated profit: \(PricingMoney.exact(profit))"
        }
        guard let payout = store.currentEstimatedPayout else {
            return "Payout needs recalculation"
        }
        if store.model.evidenceLevel == .limited {
            return "Est. payout: ~\(PricingMoney.whole(payout))"
        }
        return "Estimated payout: \(PricingMoney.exact(payout))"
    }

    private var payoutSupport: String {
        if store.currentEstimatedPayout == nil {
            return "Your price changed. Estimated payout will return after an authoritative recalculation."
        }
        if let fees = store.model.estimatedFees {
            return "After est. eBay fees (\(PricingMoney.exact(fees))). Add what you paid to see profit."
        }
        return "Add what you paid to see estimated profit."
    }
}

private struct PricingMoneyEntrySheet: View {
    @ObservedObject var store: PricingFeatureStore
    let mode: Mode

    @Environment(\.dismiss) private var dismiss
    @State private var input = ""
    @State private var validationMessage: String?

    enum Mode {
        case manualPrice
        case costBasis

        var title: String {
            switch self {
            case .manualPrice: "Set your price"
            case .costBasis: "Add what you paid"
            }
        }

        var support: String {
            switch self {
            case .manualPrice:
                "Your price stays separate from the sold-evidence recommendation."
            case .costBasis:
                "Cost basis is required before SnapList can show estimated profit."
            }
        }
    }

    var body: some View {
        SnapListSheetContainer {
            NavigationStack {
                VStack(alignment: .leading, spacing: 18) {
                    Text(mode.support)
                        .snapListTypography(.body)
                        .foregroundStyle(SnapListColorToken.textSecondary.color)
                        .fixedSize(horizontal: false, vertical: true)

                    HStack(spacing: 8) {
                        Text("$")
                            .font(.title2.weight(.semibold))
                        TextField("0.00", text: $input)
                            .keyboardType(.decimalPad)
                            .textFieldStyle(.roundedBorder)
                            .font(.title2.monospacedDigit())
                            .frame(minHeight: 50)
                            .accessibilityLabel(mode == .manualPrice ? "Price" : "Cost basis")
                    }

                    if let validationMessage {
                        Text(validationMessage)
                            .font(.callout)
                            .foregroundStyle(SnapListColorToken.caution.color)
                    }

                    Spacer(minLength: 0)

                    SnapListPrimaryButton(title: "Save", action: save)
                }
                .padding(SnapListMetrics.screenGutter)
                .navigationTitle(mode.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close", action: dismiss.callAsFunction)
                    }
                }
            }
            .presentationDetents([.height(330), .medium])
        }
        .onAppear {
            let value = mode == .manualPrice ? store.effectivePrice : store.costBasis
            input = value.map(PricingMoney.input) ?? ""
        }
    }

    private func save() {
        let normalized = input.trimmingCharacters(in: .whitespacesAndNewlines)
        let didSave: Bool
        switch mode {
        case .manualPrice:
            guard let value = Decimal(
                string: normalized,
                locale: Locale(identifier: "en_US_POSIX")
            ) else {
                announceValidation("Enter a valid dollar amount.")
                return
            }
            didSave = store.saveManualPrice(value)
        case .costBasis:
            switch PricingCostBasisInput.parse(input) {
            case .clear:
                didSave = store.saveCostBasis(nil)
            case .value(let value):
                didSave = store.saveCostBasis(value)
            case .invalid:
                announceValidation("Enter a valid dollar amount.")
                return
            }
        }

        if didSave {
            dismiss()
        } else {
            announceValidation(
                mode == .manualPrice
                    ? "Price must be greater than zero."
                    : "Cost cannot be negative."
            )
        }
    }

    private func announceValidation(_ message: String) {
        validationMessage = message
        UIAccessibility.post(notification: .announcement, argument: message)
    }
}

enum PricingAccessibility {
    static func chartSummary(
        snapshot: PricingEvidenceSnapshot,
        selectedComparable: PricingSoldComparable?
    ) -> String {
        guard let median = snapshot.median,
              let range = snapshot.soldRange else {
            return "No disclosed sold prices in the selected window."
        }
        var summary = "\(snapshot.soldCount) disclosed sold prices. \(snapshot.chartPoints.count) dated sales appear on the chart. Median \(PricingMoney.spoken(median)). Range \(PricingMoney.spoken(range.min)) to \(PricingMoney.spoken(range.max))."
        if let selectedComparable {
            summary += " Selected: sold \(PricingDate.spoken(selectedComparable.soldAt)), \(selectedComparable.condition), \(PricingMoney.spoken(selectedComparable.price))."
        }
        return summary
    }
}

enum PricingMoney {
    static func whole(_ value: Decimal) -> String {
        format(value, minimumFractionDigits: 0, maximumFractionDigits: 0)
    }

    static func exact(_ value: Decimal) -> String {
        format(value, minimumFractionDigits: 2, maximumFractionDigits: 2)
    }

    static func spoken(_ value: Decimal) -> String {
        exact(value)
    }

    static func input(_ value: Decimal) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.numberStyle = .decimal
        formatter.minimumFractionDigits = 0
        formatter.maximumFractionDigits = 2
        formatter.usesGroupingSeparator = false
        return formatter.string(from: NSDecimalNumber(decimal: value)) ?? ""
    }

    private static func format(
        _ value: Decimal,
        minimumFractionDigits: Int,
        maximumFractionDigits: Int
    ) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        formatter.minimumFractionDigits = minimumFractionDigits
        formatter.maximumFractionDigits = maximumFractionDigits
        return formatter.string(from: NSDecimalNumber(decimal: value)) ?? "$0"
    }
}

private enum PricingDate {
    static func short(_ date: Date?) -> String {
        guard let date else { return "date unavailable" }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }

    static func spoken(_ date: Date?) -> String {
        guard let date else { return "date unavailable" }
        return date.formatted(.dateTime.month(.wide).day().year())
    }
}

private extension Decimal {
    var doubleValue: Double {
        NSDecimalNumber(decimal: self).doubleValue
    }
}

#Preview("S1 · Strong evidence") {
    PricingFeatureView(model: PricingFeatureFixtures.strong)
}

#Preview("S1b · All sold comps") {
    PricingFeatureView(
        model: PricingFeatureFixtures.strong,
        initialRoute: .allComparables
    )
}

#Preview("S2 · Selected comparable") {
    PricingFeatureView(
        model: PricingFeatureFixtures.strong,
        initialRoute: .selectedComparable(id: "strong-03")
    )
}

#Preview("S3 · Limited evidence") {
    PricingFeatureView(model: PricingFeatureFixtures.limited)
}

#Preview("Offline evidence") {
    PricingFeatureView(model: PricingFeatureFixtures.offline)
}
