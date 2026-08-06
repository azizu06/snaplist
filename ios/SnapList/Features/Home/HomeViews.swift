import SwiftUI
import UIKit

@MainActor
struct HomeFeatureView: View {
    @Bindable var store: HomeStore
    let visualState: ApprovedVisualStateID?
    let openActivity: () -> Void
    let openAccount: () -> Void
    let openCapture: () -> Void
    let openRoute: (HomeRoute) -> Void

    @State private var isSearchPresented: Bool
    @State private var query = ""
    @State private var filter: HomeFilter = .all
    @State private var recentSearches: [String] = []
    @FocusState private var isSearchFocused: Bool

    init(
        store: HomeStore,
        visualState: ApprovedVisualStateID?,
        openActivity: @escaping () -> Void,
        openAccount: @escaping () -> Void,
        openCapture: @escaping () -> Void,
        openRoute: @escaping (HomeRoute) -> Void
    ) {
        self.store = store
        self.visualState = visualState
        self.openActivity = openActivity
        self.openAccount = openAccount
        self.openCapture = openCapture
        self.openRoute = openRoute
        _isSearchPresented = State(initialValue: visualState == .homeSearch)
    }

    var body: some View {
        Group {
            if isSearchPresented, let model = store.model {
                searchView(model)
            } else {
                standardHome
            }
        }
        .background(SnapListColorToken.canvas.color)
        .task(id: store.model?.revision) {
            guard let model = store.model else { return }
            if recentSearches.isEmpty {
                recentSearches = model.recentSearches
            }
            if isSearchPresented {
                await Task.yield()
                isSearchFocused = true
            }
        }
        .task(id: isSearchPresented) {
            if isSearchPresented {
                await Task.yield()
                isSearchFocused = true
            }
        }
    }

    private var standardHome: some View {
        VStack(spacing: 0) {
            AppHeader(
                activityCount: store.model?.unreadNotificationCount ?? 0,
                openActivity: openActivity,
                openAccount: openAccount
            )
            .padding(.horizontal, SnapListMetrics.screenGutter)
            .padding(.vertical, 5)

            if let model = store.model {
                if store.freshness == .serverRefresh {
                    realtimeFallbackBanner
                }
                if model.sellerState == .newSeller {
                    newSellerView
                } else {
                    activeSellerView(model)
                }
            } else {
                loadBoundary
            }
        }
    }

    private var realtimeFallbackBanner: some View {
        HStack(spacing: 8) {
            Image(systemName: "arrow.clockwise.circle")
                .accessibilityHidden(true)
            Text("Live updates are unavailable. Showing the latest server refresh.")
                .font(.footnote)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("Refresh") {
                Task { await store.refresh() }
            }
            .font(.footnote.weight(.semibold))
            .frame(minHeight: SnapListMetrics.minimumTouchTarget)
            .accessibilityIdentifier("home.refresh")
        }
        .foregroundStyle(SnapListColorToken.textSecondary.color)
        .padding(.horizontal, SnapListMetrics.screenGutter)
        .background(SnapListColorToken.groupingFill.color)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private var loadBoundary: some View {
        switch store.loadState {
        case .idle, .loading:
            VStack(spacing: 12) {
                ProgressView()
                Text("Loading your seller home…")
                    .snapListTypography(.body)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityIdentifier("home.loading")
        case .failed(let failure):
            ContentUnavailableView {
                Label(failure.title, systemImage: failure.systemImage)
            } description: {
                Text(failure.message)
            } actions: {
                if failure != .operationUnavailable {
                    Button("Refresh") {
                        Task { await store.refresh() }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(SnapListColorToken.action.color)
                    .accessibilityIdentifier("home.refresh")
                }
            }
            .accessibilityIdentifier("home.unavailable")
        case .loaded:
            ContentUnavailableView(
                "No seller data returned",
                systemImage: "arrow.clockwise.circle",
                description: Text("Refresh to check the latest server state.")
            )
        }
    }

    private var newSellerView: some View {
        GeometryReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Text("Welcome to SnapList")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(SnapListColorToken.textSecondary.color)

                    Text("Photograph an item. Get real comps and a listing you control.")
                        .snapListTypography(.onboardingHeadline)
                        .foregroundStyle(SnapListColorToken.inkPrimary.color)
                        .padding(.top, 8)

                    Text("SnapList identifies the item, researches recent eBay sold listings when available, and prepares a draft for you to review.")
                        .snapListTypography(.body)
                        .foregroundStyle(SnapListColorToken.textSecondary.color)
                        .lineSpacing(3)
                        .padding(.top, 14)

                    Button(action: openCapture) {
                        Label("Snap your first item", systemImage: "camera")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(maxWidth: .infinity)
                            .frame(minHeight: 52)
                    }
                    .buttonStyle(.plain)
                    .background(SnapListColorToken.action.color)
                    .clipShape(.rect(cornerRadius: 14))
                    .padding(.top, 26)
                    .accessibilityIdentifier("home.first-item")

                    Text("Your first item is on us — no account needed to try it.")
                        .snapListTypography(.metadata)
                        .foregroundStyle(SnapListColorToken.textTertiary.color)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 11)

                    Divider()
                        .padding(.vertical, 27)

                    Text("How it works")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(SnapListColorToken.inkPrimary.color)

                    HomeHowItWorksStep(number: 1, text: "Snap a photo of your item")
                    HomeHowItWorksStep(number: 2, text: "SnapList researches recent sold comps and drafts a listing")
                    HomeHowItWorksStep(number: 3, text: "Review your draft and publish to eBay when you’re ready")
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 24)
                .frame(minHeight: proxy.size.height, alignment: .center)
                .offset(y: -20)
                .padding(.bottom, 20)
            }
            .scrollIndicators(.hidden)
        }
        .accessibilityIdentifier("home.empty")
    }

    private func activeSellerView(_ model: HomeModel) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                HomeHero(model: model) {
                    isSearchPresented = true
                }

                if model.attention.count <= 3 {
                    HomeSummaryCards(summary: model.summary, openRoute: openRoute)
                        .padding(.top, 16)
                }

                if !model.attention.isEmpty {
                    HomeSectionHeader(title: "Needs your attention", count: model.attention.count)
                    HomeAttentionCard(tasks: model.attention, openRoute: openRoute)
                }

                if let run = model.currentRun {
                    HomeSectionHeader(title: "In progress")
                    HomeCurrentRunCard(run: run) {
                        openRoute(.run(run.id))
                    }
                }

                if !model.readyToFinish.isEmpty {
                    HomeSectionHeader(title: "Ready to finish", actionTitle: "See all") {
                        openRoute(.listings(.drafts))
                    }
                    HomeFinishList(items: model.readyToFinish, openRoute: openRoute)
                }

                if !model.recentListings.isEmpty {
                    HomeSectionHeader(title: "Recent listings", actionTitle: "All listings") {
                        openRoute(.listings(.all))
                    }
                    HomeListingList(listings: model.recentListings, openRoute: openRoute)
                }

                Color.clear.frame(
                    height: SnapListMetrics.dockHeight + SnapListMetrics.dockBottomInset
                )
            }
        }
        .scrollIndicators(.hidden)
        .accessibilityIdentifier("home.active")
    }

    private func searchView(_ model: HomeModel) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(SnapListColorToken.textTertiary.color)
                        .accessibilityHidden(true)
                    TextField("Search your listings", text: $query)
                        .focused($isSearchFocused)
                        .submitLabel(.search)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onSubmit(saveCurrentSearch)
                        .accessibilityIdentifier("home.search.field")
                    if !query.isEmpty {
                        Button {
                            query = ""
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(SnapListColorToken.textTertiary.color)
                        .frame(minWidth: SnapListMetrics.minimumTouchTarget, minHeight: SnapListMetrics.minimumTouchTarget)
                        .accessibilityLabel("Clear search")
                    }
                }
                .padding(.leading, 13)
                .frame(minHeight: SnapListMetrics.minimumTouchTarget)
                .background(Color(hex: "#F0F1F3"))
                .clipShape(.rect(cornerRadius: 12))

                Button("Cancel") {
                    query = ""
                    filter = .all
                    isSearchFocused = false
                    isSearchPresented = false
                }
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(SnapListColorToken.action.color)
                .frame(minHeight: SnapListMetrics.minimumTouchTarget)
                .accessibilityIdentifier("home.search.cancel")
            }
            .padding(.horizontal, SnapListMetrics.screenGutter)
            .padding(.top, 6)

            ScrollView(.horizontal) {
                HStack(spacing: 8) {
                    ForEach(HomeFilter.allCases) { choice in
                        Button(choice.title) {
                            filter = choice
                        }
                        .font(.system(size: 13, weight: filter == choice ? .semibold : .regular))
                        .foregroundStyle(filter == choice ? .white : SnapListColorToken.inkPrimary.color)
                        .padding(.horizontal, 16)
                        .frame(minHeight: SnapListMetrics.minimumTouchTarget)
                        .background(filter == choice ? SnapListColorToken.inkPrimary.color : Color(hex: "#F0F1F3"))
                        .clipShape(.capsule)
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(filter == choice ? .isSelected : [])
                        .accessibilityIdentifier("home.search.filter.\(choice.rawValue)")
                    }
                }
                .padding(.horizontal, SnapListMetrics.screenGutter)
            }
            .scrollIndicators(.hidden)
            .padding(.top, 12)

            if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, filter == .all {
                recentSearchList
            } else {
                searchResults(model)
            }
        }
    }

    private var recentSearchList: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text("Recent searches")
                    .snapListTypography(.status)
                    .foregroundStyle(SnapListColorToken.textTertiary.color)
                    .padding(.bottom, 8)

                if recentSearches.isEmpty {
                    Text("No recent searches")
                        .snapListTypography(.body)
                        .foregroundStyle(SnapListColorToken.textSecondary.color)
                        .padding(.vertical, 12)
                } else {
                    ForEach(recentSearches, id: \.self) { search in
                        HStack(spacing: 10) {
                            Button {
                                query = search
                            } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: "clock")
                                        .font(.system(size: 13))
                                        .foregroundStyle(SnapListColorToken.textTertiary.color)
                                    Text(search)
                                        .snapListTypography(.body)
                                        .foregroundStyle(SnapListColorToken.inkPrimary.color)
                                    Spacer()
                                }
                                .contentShape(.rect)
                            }
                            .buttonStyle(.plain)
                            .frame(minHeight: SnapListMetrics.minimumTouchTarget)

                            Button {
                                recentSearches.removeAll { $0 == search }
                            } label: {
                                Image(systemName: "xmark")
                                    .foregroundStyle(SnapListColorToken.textTertiary.color)
                                    .frame(width: SnapListMetrics.minimumTouchTarget, height: SnapListMetrics.minimumTouchTarget)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Remove recent search")
                        }
                    }
                }
            }
            .padding(.horizontal, SnapListMetrics.screenGutter)
            .padding(.top, 22)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    private func searchResults(_ model: HomeModel) -> some View {
        let matches = model.listings(matching: query, filter: filter)
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text("\(matches.count) result\(matches.count == 1 ? "" : "s") for “\(query.trimmingCharacters(in: .whitespacesAndNewlines))”")
                        .snapListTypography(.status)
                        .foregroundStyle(SnapListColorToken.textTertiary.color)
                        .padding(.bottom, 8)
                }

                if matches.isEmpty {
                    ContentUnavailableView(
                        "No matching listings",
                        systemImage: "magnifyingglass",
                        description: Text("Try another search or clear the selected filter.")
                    )
                    .frame(maxWidth: .infinity)
                    .padding(.top, 60)
                } else {
                    HomeListingList(listings: matches, openRoute: openRoute, horizontalPadding: 0)
                }
            }
            .padding(.horizontal, SnapListMetrics.screenGutter)
            .padding(.top, 16)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    private func saveCurrentSearch() {
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return }
        recentSearches.removeAll { $0.localizedCaseInsensitiveCompare(normalized) == .orderedSame }
        recentSearches.insert(normalized, at: 0)
        recentSearches = Array(recentSearches.prefix(5))
    }
}

private struct HomeHero: View {
    let model: HomeModel
    let openSearch: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .snapListTypography(.displayTitle)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .accessibilityAddTraits(.isHeader)
                Text(subtitle)
                    .snapListTypography(.body)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
            }

            Spacer(minLength: 8)

            Button(action: openSearch) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 17, weight: .semibold))
                    .frame(
                        width: SnapListMetrics.minimumTouchTarget,
                        height: SnapListMetrics.minimumTouchTarget
                    )
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .foregroundStyle(SnapListColorToken.inkPrimary.color)
            .accessibilityLabel("Search listings")
            .accessibilityIdentifier("home.search.open")
        }
        .padding(.horizontal, SnapListMetrics.screenGutter)
        .padding(.top, 8)
    }

    private var title: String {
        if model.attention.isEmpty { return "You’re all caught up" }
        return "\(model.attention.count) thing\(model.attention.count == 1 ? "" : "s") need you"
    }

    private var subtitle: String {
        switch model.attention.count {
        case 0: "Your latest listings and runs are below."
        case 3: "Ship an order, answer a buyer, fix a listing."
        case 6: "A busy day — here’s what matters, in order."
        default: "Start with the most time-sensitive task."
        }
    }
}

private struct HomeSummaryCards: View {
    let summary: HomeSummary
    let openRoute: (HomeRoute) -> Void

    var body: some View {
        HStack(spacing: 8) {
            card(value: summary.active, label: "Active") { openRoute(.listings(.active)) }
            card(value: summary.drafts, label: "Drafts") { openRoute(.listings(.drafts)) }
            card(value: summary.orders, label: summary.orders == 1 ? "Order" : "Orders") {
                guard summary.orders != nil else { return }
                openRoute(.orders)
            }
        }
        .padding(.horizontal, SnapListMetrics.screenGutter)
    }

    private func card(value: Int?, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 2) {
                Text(value?.formatted() ?? "—")
                    .font(.system(size: 18, weight: .bold))
                    .monospacedDigit()
                Text(label)
                    .snapListTypography(.metadata)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
            }
            .foregroundStyle(SnapListColorToken.inkPrimary.color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(value == nil)
        .background(.white)
        .clipShape(.rect(cornerRadius: 12))
        .overlay {
            RoundedRectangle(cornerRadius: 12)
                .stroke(SnapListColorToken.hairline.color, lineWidth: 1)
        }
        .accessibilityLabel(value.map { "\($0) \(label)" } ?? "\(label) unavailable")
    }
}

private struct HomeSectionHeader: View {
    let title: String
    var count: Int?
    var actionTitle: String?
    var action: (() -> Void)?

    init(
        title: String,
        count: Int? = nil,
        actionTitle: String? = nil,
        action: (() -> Void)? = nil
    ) {
        self.title = title
        self.count = count
        self.actionTitle = actionTitle
        self.action = action
    }

    var body: some View {
        HStack(alignment: .center) {
            Text(title)
                .snapListTypography(.sectionHeader)
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .accessibilityAddTraits(.isHeader)
            Spacer()
            if let count {
                Text(count.formatted())
                    .snapListTypography(.status)
                    .fontWeight(.semibold)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .monospacedDigit()
            } else if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(SnapListColorToken.action.color)
                    .frame(minHeight: SnapListMetrics.minimumTouchTarget)
            }
        }
        .padding(.horizontal, SnapListMetrics.screenGutter)
        .padding(.top, 20)
        .padding(.bottom, 8)
    }
}

private struct HomeAttentionCard: View {
    let tasks: [HomeAttentionTask]
    let openRoute: (HomeRoute) -> Void

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(tasks.enumerated()), id: \.element.id) { index, task in
                HomeAttentionRow(task: task) {
                    openRoute(task.destination.route)
                }
                if index < tasks.count - 1 {
                    Divider().padding(.leading, 78)
                }
            }
        }
        .background(.white)
        .clipShape(.rect(cornerRadius: 16))
        .overlay {
            RoundedRectangle(cornerRadius: 16)
                .stroke(SnapListColorToken.hairline.color, lineWidth: 1)
        }
        .padding(.horizontal, SnapListMetrics.screenGutter)
    }
}

private struct HomeAttentionRow: View {
    let task: HomeAttentionTask
    let action: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            HomeProductPlaceholder(systemImage: task.kind.productSystemImage, size: 56)

            VStack(alignment: .leading, spacing: 2) {
                Text(task.itemTitle)
                    .snapListTypography(.rowTitle)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .lineLimit(1)
                Label(task.status, systemImage: task.kind.statusSystemImage)
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(task.kind == .warning ? Color(hex: "#B23B1E") : SnapListColorToken.inkPrimary.color)
                    .lineLimit(2)
                Text(task.detail)
                    .snapListTypography(.metadata)
                    .foregroundStyle(SnapListColorToken.textTertiary.color)
                    .lineLimit(2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Button(task.actionLabel, action: action)
                .font(.system(size: 12.5, weight: .semibold))
                .foregroundStyle(task.kind == .shipping ? .white : SnapListColorToken.inkPrimary.color)
                .padding(.horizontal, task.kind == .shipping ? 16 : 14)
                .frame(minHeight: SnapListMetrics.minimumTouchTarget)
                .background(task.kind == .shipping ? SnapListColorToken.action.color : .white)
                .clipShape(.capsule)
                .overlay {
                    if task.kind != .shipping {
                        Capsule().stroke(Color(hex: "#C9CCD1"), lineWidth: 1)
                    }
                }
                .buttonStyle(.plain)
                .fixedSize(horizontal: true, vertical: false)
                .accessibilityIdentifier("home.attention.\(task.id.uuidString)")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .accessibilityElement(children: .contain)
    }
}

private struct HomeCurrentRunCard: View {
    let run: HomeCurrentRun
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 12) {
                    HomeProductPlaceholder(systemImage: "camera", size: 44)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(run.stageLabel)
                            .font(.system(size: 14.5, weight: .semibold))
                            .foregroundStyle(SnapListColorToken.inkPrimary.color)
                        Text(run.itemTitle)
                            .font(.system(size: 12.5))
                            .foregroundStyle(SnapListColorToken.textSecondary.color)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Color(hex: "#9AA0A8"))
                }

                if let progress = run.progress {
                    ProgressView(value: progress)
                        .tint(SnapListColorToken.action.color)
                } else {
                    ProgressView()
                        .tint(SnapListColorToken.action.color)
                        .accessibilityLabel("Current stage in progress")
                }

                Text(run.reassurance)
                    .snapListTypography(.metadata)
                    .foregroundStyle(SnapListColorToken.textTertiary.color)
            }
            .padding(14)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .background(SnapListColorToken.inProgressFill.color)
        .clipShape(.rect(cornerRadius: 16))
        .overlay {
            RoundedRectangle(cornerRadius: 16)
                .stroke(SnapListColorToken.inProgressBorder.color, lineWidth: 1)
        }
        .padding(.horizontal, SnapListMetrics.screenGutter)
        .accessibilityLabel("\(run.stageLabel). \(run.itemTitle). \(run.reassurance)")
        .accessibilityHint("Opens this run")
        .accessibilityIdentifier("home.run.\(run.id.uuidString)")
    }
}

private struct HomeFinishList: View {
    let items: [HomeFinishItem]
    let openRoute: (HomeRoute) -> Void

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                HStack(spacing: 12) {
                    HomeProductPlaceholder(systemImage: "shippingbox", size: 52)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.title)
                            .font(.system(size: 14.5, weight: .semibold))
                            .lineLimit(1)
                        Text(item.detail)
                            .font(.system(size: 12.5))
                            .foregroundStyle(SnapListColorToken.textSecondary.color)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    Button(item.detail.contains("price") ? "Review price" : "Add details") {
                        openRoute(.draft(item.id))
                    }
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .padding(.horizontal, 14)
                    .frame(minHeight: SnapListMetrics.minimumTouchTarget)
                    .overlay { Capsule().stroke(Color(hex: "#C9CCD1"), lineWidth: 1) }
                    .buttonStyle(.plain)
                }
                .padding(.vertical, 11)
                if index < items.count - 1 { Divider().padding(.leading, 64) }
            }
        }
        .padding(.horizontal, SnapListMetrics.screenGutter)
    }
}

private struct HomeListingList: View {
    let listings: [HomeListing]
    let openRoute: (HomeRoute) -> Void
    var horizontalPadding: CGFloat = SnapListMetrics.screenGutter

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(listings.enumerated()), id: \.element.id) { index, listing in
                Button {
                    openRoute(listing.route)
                } label: {
                    HStack(spacing: 12) {
                        HomeProductPlaceholder(systemImage: listing.lifecycle.productSystemImage, size: 52)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(listing.title)
                                .font(.system(size: 14.5, weight: .semibold))
                                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                                .lineLimit(1)
                            HStack(spacing: 6) {
                                Text(listing.statusLabel)
                                    .font(.system(size: 12, weight: .semibold))
                                    .foregroundStyle(listing.lifecycle.badgeForeground)
                                    .padding(.horizontal, 7)
                                    .padding(.vertical, 2)
                                    .background(listing.lifecycle.badgeBackground)
                                    .clipShape(.rect(cornerRadius: 6))
                                Text(listing.detail)
                                    .snapListTypography(.metadata)
                                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                                    .lineLimit(1)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        Text(listing.price ?? "—")
                            .font(.system(size: 14.5, weight: .bold))
                            .foregroundStyle(SnapListColorToken.inkPrimary.color)
                            .monospacedDigit()
                    }
                    .padding(.vertical, 11)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("home.listing.\(listing.id.uuidString)")
                if index < listings.count - 1 { Divider().padding(.leading, 64) }
            }
        }
        .padding(.horizontal, horizontalPadding)
    }
}

private struct HomeProductPlaceholder: View {
    let systemImage: String
    let size: CGFloat

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.2)
            .fill(SnapListColorToken.groupingFill.color)
            .frame(width: size, height: size)
            .overlay {
                Image(systemName: systemImage)
                    .font(.system(size: size * 0.34, weight: .medium))
                    .foregroundStyle(SnapListColorToken.textTertiary.color)
            }
            .accessibilityHidden(true)
    }
}

private struct HomeHowItWorksStep: View {
    let number: Int
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Text(number.formatted())
                .font(.system(size: 13, weight: .semibold))
                .frame(width: 30, height: 30)
                .background(SnapListColorToken.groupingFill.color)
                .clipShape(.circle)
            Text(text)
                .snapListTypography(.body)
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .padding(.top, 5)
        }
        .padding(.top, 10)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Trophy Wall

struct TrophyWallView: View {
    /// What the wall body may claim, given the tiles it holds and what the client
    /// actually proved about the collection.
    struct Presentation: Equatable {
        let showsGrid: Bool
        let showsEmptyView: Bool
        let offlineNotice: String?
        let collectionMessage: TrophyWallProcessingView.CollectionMessage?
    }

    @Bindable var store: TrophyWallStore
    let openProcessing: () -> Void
    let openAccount: () -> Void
    let onScan: () -> Void
    let onTryAgain: () -> Void

    @ScaledMetric(relativeTo: .title) private var titleSize = 28

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Text("Trophy Wall")
                    .font(.system(size: titleSize, weight: .bold))
                    .tracking(-0.5)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .accessibilityAddTraits(.isHeader)

                Spacer(minLength: 0)

                Button(action: openProcessing) {
                    Image(systemName: "clock")
                        .font(.system(size: 21, weight: .medium))
                        .frame(
                            width: SnapListMetrics.minimumTouchTarget,
                            height: SnapListMetrics.minimumTouchTarget
                        )
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .accessibilityLabel("Processing")
                .accessibilityIdentifier("trophy.wall.processing")

                Button(action: openAccount) {
                    Text("A")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(SnapListColorToken.textSecondary.color)
                        .frame(width: 36, height: 36)
                        .background(SnapListColorToken.hairline.color)
                        .clipShape(.circle)
                        .frame(
                            width: SnapListMetrics.minimumTouchTarget,
                            height: SnapListMetrics.minimumTouchTarget
                        )
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Account, opens Settings")
                .accessibilityIdentifier("trophy.wall.account")
            }
            .padding(.leading, 18)
            .padding(.trailing, 14)
            .padding(.bottom, 12)

            wallBody
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(SnapListColorToken.canvas.color)
        // On a plain stack the identifier binds to no element of its own and
        // propagates down instead, so the header buttons were all published as
        // `trophy.wall` and `trophy.wall.processing` resolved to nothing.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("trophy.wall")
    }

    /// Trophy Wall is the seller's one return destination, so a collection it
    /// could not load may not render as a blank canvas. The offline notice is a
    /// claim about saved items and stays truthful only while there are saved
    /// items; without them, both reachability failures collapse to the same
    /// recovery group the pushed Processing screen already ships.
    static func presentation(
        hasSettledTiles: Bool,
        collectionOutcome: TrophyWallCollectionOutcome
    ) -> Presentation {
        guard !hasSettledTiles else {
            return Presentation(
                showsGrid: true,
                showsEmptyView: false,
                offlineNotice: collectionOutcome == .offline
                    ? TrophyWallProcessingView.offlineNoticeText
                    : nil,
                collectionMessage: nil
            )
        }

        switch collectionOutcome {
        case .unknown:
            // Nothing has been proved, so no empty success may be claimed.
            return Presentation(
                showsGrid: false,
                showsEmptyView: false,
                offlineNotice: nil,
                collectionMessage: nil
            )
        case .loaded:
            return Presentation(
                showsGrid: false,
                showsEmptyView: true,
                offlineNotice: nil,
                collectionMessage: nil
            )
        case .offline, .unavailable:
            return Presentation(
                showsGrid: false,
                showsEmptyView: false,
                offlineNotice: nil,
                collectionMessage: TrophyWallProcessingView
                    .unavailableCollectionMessage
            )
        }
    }

    @ViewBuilder
    private var wallBody: some View {
        let presentation = Self.presentation(
            hasSettledTiles: !store.settledTiles.isEmpty,
            collectionOutcome: store.collectionOutcome
        )

        if let offlineNotice = presentation.offlineNotice {
            TrophyWallOfflineNoticeView(text: offlineNotice)
        }

        if let collectionMessage = presentation.collectionMessage {
            TrophyWallCollectionMessageView(
                message: collectionMessage,
                onScan: onScan,
                onTryAgain: onTryAgain
            )
        }

        if presentation.showsEmptyView {
            TrophyWallEmptyView(onScan: onScan)
        }

        if presentation.showsGrid {
            ScrollView {
                LazyVGrid(
                    columns: [
                        GridItem(.flexible(), spacing: 12),
                        GridItem(.flexible(), spacing: 12),
                    ],
                    spacing: 12
                ) {
                    ForEach(store.settledTiles) { tile in
                        TrophyWallSettledTileView(tile: tile)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(
                    .bottom,
                    SnapListMetrics.dockHeight + SnapListMetrics.dockBottomInset + 48
                )
            }
            .scrollIndicators(.hidden)
            .accessibilityIdentifier("trophy.wall.grid")
        }
    }
}

private struct TrophyWallSettledTileView: View {
    let tile: TrophyWallSettledTile

    var body: some View {
        ZStack {
            SnapListColorToken.quietFill.color
            if let coverPhotoURL = tile.coverPhotoURL {
                AsyncImage(url: coverPhotoURL) { image in
                    image
                        .resizable()
                        .scaledToFill()
                } placeholder: {
                    fallback
                }
            } else {
                fallback
            }
        }
        .aspectRatio(4 / 5, contentMode: .fit)
        .clipShape(.rect(cornerRadius: 12))
        .overlay {
            RoundedRectangle(cornerRadius: 12)
                .stroke(SnapListColorToken.hairline.color, lineWidth: 0.5)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(tile.accessibilityLabel)
        .accessibilityAddTraits(.isImage)
    }

    private var fallback: some View {
        Text(tile.itemName)
            .snapListTypography(.status)
            .fontWeight(.semibold)
            .foregroundStyle(SnapListColorToken.textSecondary.color)
            .multilineTextAlignment(.center)
            .padding(12)
    }
}

private struct TrophyWallEmptyView: View {
    let onScan: () -> Void

    var body: some View {
        VStack(spacing: 20) {
            Image("ScoutUncertain")
                .resizable()
                .scaledToFit()
                .frame(height: 150)
                .accessibilityLabel("Scout, the SnapList camera helper")

            Text("No items yet")
                .snapListTypography(.cardTitle)
                .fontWeight(.bold)
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .multilineTextAlignment(.center)

            Button(action: onScan) {
                Text("Scan an item")
                    .snapListTypography(.rowTitle)
                    .foregroundStyle(SnapListColorToken.canvas.color)
                    .padding(.horizontal, 28)
                    .frame(minHeight: 52)
                    .background(SnapListColorToken.action.color)
                    .clipShape(.rect(cornerRadius: 14))
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("trophy.wall.scan")
        }
        .padding(.horizontal, 34)
        .padding(.bottom, 104)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // Same plain-stack binding as `trophy.wall`: without this the identifier
        // propagates down and overwrites `trophy.wall.scan` on the button above.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("trophy.wall.empty")
    }
}

// MARK: - Trophy Wall Processing

struct TrophyWallProcessingView: View {
    struct Presentation: Equatable {
        let visibleRows: [TrophyWallProcessingRow]
        let disclosureLabel: String?
        let disclosureAccessibilityLabel: String?
        let offlineNotice: String?
        let collectionMessage: CollectionMessage?
    }

    /// The centered group shown when there is no row to show at all. It states
    /// only what the client proved and offers exactly one recovery action.
    struct CollectionMessage: Equatable {
        enum Action: Equatable {
            case scan(label: String)
            case tryAgain(label: String)
        }

        let heading: String
        let action: Action
        let scoutImageName: String
        let scoutAccessibilityLabel: String
    }

    struct DisclosureTransition: Equatable {
        let isExpanded: Bool
        let announcement: String
    }

    private static let smallestSupportedHeight: CGFloat = 667
    private static let compactRowLimit = 3
    private static let smallestHeightRowLimit = 2
    private static let scoutAccessibilityLabel = "Scout, the SnapList camera helper"
    // Trophy Wall and the pushed Processing screen describe the same collection
    // failure, so they share one sentence for it rather than drifting into two.
    static let offlineNoticeText = "You're offline. Showing saved items."
    private static let emptyCollectionMessage = CollectionMessage(
        heading: "Nothing is processing.",
        action: .scan(label: "Scan an item"),
        scoutImageName: "ScoutUncertain",
        scoutAccessibilityLabel: scoutAccessibilityLabel
    )
    static let unavailableCollectionMessage = CollectionMessage(
        heading: "Processing unavailable",
        action: .tryAgain(label: "Try again"),
        scoutImageName: "ScoutRetryReview",
        scoutAccessibilityLabel: scoutAccessibilityLabel
    )

    @ScaledMetric(relativeTo: .title2) private var titleSize = 24
    @ScaledMetric(relativeTo: .callout) private var disclosureSize = 14
    @AccessibilityFocusState private var isDisclosureFocused: Bool
    @State private var isExpanded = false

    let rows: [TrophyWallProcessingRow]
    let collectionOutcome: TrophyWallCollectionOutcome
    let onBack: () -> Void
    let openRoute: (HomeRoute) -> Void
    let onScan: () -> Void
    let onTryAgain: () -> Void

    init(
        rows: [TrophyWallProcessingRow],
        collectionOutcome: TrophyWallCollectionOutcome = .unknown,
        onBack: @escaping () -> Void,
        openRoute: @escaping (HomeRoute) -> Void,
        onScan: @escaping () -> Void,
        onTryAgain: @escaping () -> Void
    ) {
        self.rows = rows
        self.collectionOutcome = collectionOutcome
        self.onBack = onBack
        self.openRoute = openRoute
        self.onScan = onScan
        self.onTryAgain = onTryAgain
    }

    var body: some View {
        GeometryReader { proxy in
            let presentation = Self.presentation(
                from: rows,
                collectionOutcome: collectionOutcome,
                availableHeight: proxy.size.height,
                isExpanded: isExpanded
            )

            VStack(spacing: 0) {
                HStack(spacing: 4) {
                    Button(action: onBack) {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 18, weight: .semibold))
                            .frame(
                                width: SnapListMetrics.minimumTouchTarget,
                                height: SnapListMetrics.minimumTouchTarget
                            )
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .accessibilityLabel("Back to Trophy Wall")
                    .accessibilityIdentifier("trophy.processing.back")

                    Text("Processing")
                        .font(.system(size: titleSize, weight: .bold))
                        .tracking(-0.5)
                        .foregroundStyle(SnapListColorToken.inkPrimary.color)

                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 8)
                .padding(.bottom, 10)

                if let offlineNotice = presentation.offlineNotice {
                    TrophyWallOfflineNoticeView(text: offlineNotice)
                }

                if let collectionMessage = presentation.collectionMessage {
                    TrophyWallCollectionMessageView(
                        message: collectionMessage,
                        onScan: onScan,
                        onTryAgain: onTryAgain
                    )
                }

                if !presentation.visibleRows.isEmpty {
                    ScrollView {
                        VStack(spacing: 0) {
                            ForEach(presentation.visibleRows) { row in
                                TrophyWallProcessingRowView(
                                    row: row,
                                    openRoute: openRoute
                                )

                                if row.id != presentation.visibleRows.last?.id {
                                    Divider()
                                        .foregroundStyle(SnapListColorToken.hairline.color)
                                        .padding(.leading, 69)
                                }
                            }

                            if let disclosureLabel = presentation.disclosureLabel,
                               let disclosureAccessibilityLabel =
                                   presentation.disclosureAccessibilityLabel {
                                Divider()
                                    .foregroundStyle(SnapListColorToken.divider.color)

                                Button {
                                    let transition = Self.disclosureTransition(
                                        from: isExpanded
                                    )
                                    isExpanded = transition.isExpanded
                                    isDisclosureFocused = true
                                    UIAccessibility.post(
                                        notification: .announcement,
                                        argument: transition.announcement
                                    )
                                } label: {
                                    Text(disclosureLabel)
                                        .font(
                                            .system(
                                                size: disclosureSize,
                                                weight: .semibold
                                            )
                                        )
                                        .foregroundStyle(SnapListColorToken.action.color)
                                        .lineLimit(1)
                                        .frame(
                                            maxWidth: .infinity,
                                            minHeight: SnapListMetrics.minimumTouchTarget
                                        )
                                        .contentShape(.rect)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel(disclosureAccessibilityLabel)
                                .accessibilityValue(
                                    isExpanded ? "Expanded" : "Collapsed"
                                )
                                .accessibilityIdentifier(
                                    "trophy.processing.disclosure"
                                )
                                .accessibilityFocused($isDisclosureFocused)
                            }
                        }
                        .background(SnapListColorToken.canvas.color)
                        .clipShape(.rect(cornerRadius: 14))
                        .overlay {
                            RoundedRectangle(cornerRadius: 14)
                                .stroke(SnapListColorToken.hairline.color, lineWidth: 1)
                        }
                        .padding(.horizontal, 14)
                        .padding(.top, 8)
                    }
                    .scrollIndicators(.hidden)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .background(SnapListColorToken.canvas.color)
        // Same plain-stack binding as `trophy.wall`: without this the identifier
        // publishes no element of its own and propagates onto the descendants.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("trophy.processing")
    }

    static func visibleRows(
        from rows: [TrophyWallProcessingRow],
        availableHeight: CGFloat
    ) -> [TrophyWallProcessingRow] {
        let limit = availableHeight <= smallestSupportedHeight
            ? smallestHeightRowLimit
            : compactRowLimit
        return Array(rows.prefix(limit))
    }

    static func presentation(
        from rows: [TrophyWallProcessingRow],
        collectionOutcome: TrophyWallCollectionOutcome = .unknown,
        availableHeight: CGFloat,
        isExpanded: Bool
    ) -> Presentation {
        guard !rows.isEmpty else {
            return Presentation(
                visibleRows: [],
                disclosureLabel: nil,
                disclosureAccessibilityLabel: nil,
                offlineNotice: nil,
                collectionMessage: collectionMessage(for: collectionOutcome)
            )
        }

        // The offline notice is a claim about saved items, so it is only
        // truthful while there are saved items to show.
        let offlineNotice = collectionOutcome == .offline ? offlineNoticeText : nil
        let clampedRows = visibleRows(
            from: rows,
            availableHeight: availableHeight
        )
        let hiddenCount = rows.count - clampedRows.count
        guard hiddenCount > 0 else {
            return Presentation(
                visibleRows: rows,
                disclosureLabel: nil,
                disclosureAccessibilityLabel: nil,
                offlineNotice: offlineNotice,
                collectionMessage: nil
            )
        }

        if isExpanded {
            return Presentation(
                visibleRows: rows,
                disclosureLabel: "Show less",
                disclosureAccessibilityLabel: "Show fewer items",
                offlineNotice: offlineNotice,
                collectionMessage: nil
            )
        }

        return Presentation(
            visibleRows: clampedRows,
            disclosureLabel: hiddenCount == 2 ? "Show 2 more" : "Show more",
            disclosureAccessibilityLabel: hiddenCount == 2
                ? "Show 2 more items"
                : "Show more items",
            offlineNotice: offlineNotice,
            collectionMessage: nil
        )
    }

    private static func collectionMessage(
        for outcome: TrophyWallCollectionOutcome
    ) -> CollectionMessage? {
        switch outcome {
        case .unknown:
            // Nothing has been proved, so no empty success may be claimed.
            nil
        case .loaded:
            emptyCollectionMessage
        case .offline, .unavailable:
            // Without a saved row there is no cached truth to keep, so both
            // reachability failures collapse to the same recovery state.
            unavailableCollectionMessage
        }
    }

    static func disclosureTransition(
        from isExpanded: Bool
    ) -> DisclosureTransition {
        let nextExpanded = !isExpanded
        return DisclosureTransition(
            isExpanded: nextExpanded,
            announcement: nextExpanded ? "Expanded" : "Collapsed"
        )
    }
}

private struct TrophyWallOfflineNoticeView: View {
    let text: String

    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(SnapListColorToken.textTertiary.color)
                .frame(width: 8, height: 8)
                .accessibilityHidden(true)

            Text(text)
                .snapListTypography(.status)
                .foregroundStyle(SnapListColorToken.textSecondary.color)
                .fixedSize(horizontal: false, vertical: true)

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 13)
        .padding(.vertical, 11)
        .background(SnapListColorToken.groupingFill.color)
        .clipShape(.rect(cornerRadius: 12))
        .overlay {
            RoundedRectangle(cornerRadius: 12)
                .stroke(SnapListColorToken.hairline.color, lineWidth: 1)
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("trophy.processing.offline")
    }
}

private struct TrophyWallCollectionMessageView: View {
    // Only the approved static Scout artwork ships today. It is the approved
    // Reduced Motion fallback, so it stays honest under any motion setting.
    private static let scoutHeight: CGFloat = 150

    let message: TrophyWallProcessingView.CollectionMessage
    let onScan: () -> Void
    let onTryAgain: () -> Void

    @ScaledMetric(relativeTo: .title3) private var headingSize = 18

    var body: some View {
        VStack(spacing: 20) {
            Image(message.scoutImageName)
                .resizable()
                .scaledToFit()
                .frame(height: Self.scoutHeight)
                .accessibilityLabel(message.scoutAccessibilityLabel)

            Text(message.heading)
                .font(.system(size: headingSize, weight: .bold))
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("trophy.processing.collection.heading")

            action
        }
        .padding(.horizontal, 34)
        .padding(.top, 24)
        .padding(.bottom, 104)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("trophy.processing.collection")
    }

    @ViewBuilder
    private var action: some View {
        switch message.action {
        case .scan(let label):
            Button(action: onScan) {
                Text(label)
                    .snapListTypography(.rowTitle)
                    .foregroundStyle(SnapListColorToken.canvas.color)
                    .padding(.horizontal, 28)
                    .frame(minHeight: 52)
                    .background(SnapListColorToken.action.color)
                    .clipShape(.rect(cornerRadius: 14))
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(label)
            .accessibilityIdentifier("trophy.processing.collection.scan")
        case .tryAgain(let label):
            Button(action: onTryAgain) {
                Text(label)
                    .snapListTypography(.rowTitle)
                    .foregroundStyle(SnapListColorToken.actionDeep.color)
                    .padding(.horizontal, 22)
                    .frame(minHeight: SnapListMetrics.minimumTouchTarget)
                    .background(SnapListColorToken.actionTint.color)
                    .clipShape(.rect(cornerRadius: 12))
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(label)
            .accessibilityIdentifier("trophy.processing.collection.try-again")
        }
    }
}

private struct TrophyWallProcessingRowView: View {
    let row: TrophyWallProcessingRow
    let openRoute: (HomeRoute) -> Void

    var body: some View {
        Group {
            if let destination = row.destination {
                Button {
                    openRoute(destination)
                } label: {
                    content
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(row.accessibilityLabel)
            } else {
                content
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(row.accessibilityLabel)
            }
        }
        .accessibilityIdentifier(row.accessibilityIdentifier)
    }

    private var content: some View {
        HStack(spacing: 11) {
            RoundedRectangle(cornerRadius: 10)
                .fill(SnapListColorToken.hairline.color)
                .frame(width: 44, height: 44)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text(row.itemName)
                    .snapListTypography(.rowTitle)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)

                Text(row.stateLabel)
                    .snapListTypography(.status)
                    .foregroundStyle(
                        row.destination == nil
                            ? SnapListColorToken.textSecondary.color
                            : SnapListColorToken.inkPrimary.color
                    )
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .frame(minHeight: 66)
        .contentShape(.rect)
    }
}

struct HomeRouteBoundaryView: View {
    let route: HomeRoute

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: route.systemImage)
                .font(.system(size: 30, weight: .semibold))
                .foregroundStyle(SnapListColorToken.action.color)

            Text(route.title)
                .snapListTypography(.displayTitle)
                .accessibilityIdentifier("home.route.\(route.identifier).title")

            Text("This typed destination is connected. Its approved screen belongs to a later issue.")
                .snapListTypography(.body)
                .foregroundStyle(SnapListColorToken.textSecondary.color)
                .multilineTextAlignment(.center)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(SnapListColorToken.canvas.color)
    }
}

private extension HomeRoute {
    var identifier: String {
        switch self {
        case .processing: "processing"
        case .localRecovery: "local-recovery"
        case .run: "run"
        case .order: "order"
        case .conversation: "conversation"
        case .publishIssue: "publish-issue"
        case .draft: "draft"
        case .listing: "listing"
        case .listings: "listings"
        case .orders: "orders"
        }
    }

    var title: String {
        switch self {
        case .processing: "Processing"
        case .localRecovery: "Local item"
        case .run: "Run"
        case .order: "Order"
        case .conversation: "Conversation"
        case .publishIssue: "Publish issue"
        case .draft: "Draft"
        case .listing: "Listing"
        case .listings: "Listings"
        case .orders: "Orders"
        }
    }

    var systemImage: String {
        switch self {
        case .processing: "clock"
        case .localRecovery: "camera.viewfinder"
        case .run: "sparkles"
        case .order, .orders: "shippingbox"
        case .conversation: "bubble.left.and.bubble.right"
        case .publishIssue: "exclamationmark.triangle"
        case .draft: "doc.text"
        case .listing, .listings: "tag"
        }
    }
}

private extension HomeAttentionKind {
    var productSystemImage: String {
        switch self {
        case .shipping: "headphones"
        case .message: "keyboard"
        case .offer: "tshirt"
        case .warning: "lamp.desk"
        case .pricing: "camera"
        }
    }

    var statusSystemImage: String {
        switch self {
        case .shipping: "shippingbox"
        case .message, .pricing: "bubble.left"
        case .offer: "clock"
        case .warning: "exclamationmark.triangle"
        }
    }
}

private extension HomeListingLifecycle {
    var productSystemImage: String {
        switch self {
        case .active: "camera"
        case .draft: "shippingbox"
        case .sold: "tshirt"
        case .needsAttention, .resolvedConversation: "headphones"
        }
    }

    var badgeForeground: Color {
        switch self {
        case .active, .resolvedConversation: SnapListColorToken.durableSuccess.color
        case .draft: Color(hex: "#3B4A66")
        case .sold: SnapListColorToken.textSecondary.color
        case .needsAttention: Color(hex: "#B23B1E")
        }
    }

    var badgeBackground: Color {
        switch self {
        case .active, .resolvedConversation: Color(hex: "#E6F4EC")
        case .draft: Color(hex: "#EAEFFB")
        case .sold: Color(hex: "#F0F1F3")
        case .needsAttention: Color(hex: "#FBEDE9")
        }
    }
}

private extension HomeLoadFailure {
    var title: String {
        switch self {
        case .operationUnavailable: "Seller Home isn’t connected yet"
        case .offline: "You’re offline"
        case .temporarilyUnavailable: "Home couldn’t load"
        }
    }

    var message: String {
        switch self {
        case .operationUnavailable:
            "The native Home API is not available in this build. No sample seller data is shown."
        case .offline:
            "Reconnect, then refresh to load your latest server-confirmed listings and runs."
        case .temporarilyUnavailable:
            "Refresh to request the latest server-confirmed seller state."
        }
    }

    var systemImage: String {
        switch self {
        case .operationUnavailable: "network.slash"
        case .offline: "wifi.slash"
        case .temporarilyUnavailable: "arrow.clockwise.circle"
        }
    }
}
