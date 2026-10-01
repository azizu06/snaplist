import SwiftUI

/// The contextual export drawer. The July v1 family supplies the handoff
/// contract; the September sharing revamp keeps selection and guide together.
///
/// Every seller-facing string on this screen comes from `AssistedExportCopy`,
/// never from a literal here. That is what keeps the vocabulary sweep in the
/// domain tests able to see this screen: a word like `Published` added to a view
/// would otherwise be invisible to it.

struct AssistedExportItemSummary: Equatable, Sendable {
    let title: String
    let priceText: String
    let preparedAtText: String
}

@MainActor
struct AssistedExportHostView: View {
    @State private var store: AssistedExportStore
    @State private var observedListingRevision: UUID
    let summary: AssistedExportItemSummary
    let pack: AssistedExportPack
    let refreshPack: @MainActor () async -> AssistedExportPack?

    init(
        pack: AssistedExportPack,
        summary: AssistedExportItemSummary,
        service: any AssistedExportServing,
        funnelAnalytics: any FunnelAnalyticsEventSinking = NoOpFunnelAnalyticsEventSink(),
        refreshPack: @escaping @MainActor () async -> AssistedExportPack?
    ) {
        self.pack = pack
        self.summary = summary
        self.refreshPack = refreshPack
        _observedListingRevision = State(initialValue: pack.reviewRevision)
        _store = State(
            initialValue: AssistedExportStore(
                pack: pack,
                service: service,
                funnelAnalytics: funnelAnalytics,
                // Only the product persists progress. Tests and fixtures take
                // the in-memory default so nothing leaks between launches.
                progress: AssistedExportUserDefaultsProgress(
                    userID: ClerkAuthenticationComposition.currentUserID()
                )
            )
        )
    }

    var body: some View {
        AssistedExportView(
            store: store,
            summary: summary,
            listingRevision: observedListingRevision,
            onUpdatePack: updatePack
        )
        .task {
            // The projection is the existing source of truth for the current
            // review revision. Refresh once on entry so XPORT-05 can detect an
            // edit made outside this mounted export screen without adding a
            // polling or export endpoint.
            guard let current = await refreshPack() else { return }
            observe(current)
        }
        .onChange(of: pack) { _, replacement in
            // A parent refresh prepares a candidate pack. It only marks this
            // screen stale; the seller's Update pack action remains the sole
            // path that replaces what they were shown.
            observe(replacement)
        }
    }

    private func observe(_ replacement: AssistedExportPack) {
        observedListingRevision = replacement.reviewRevision
        guard replacement != store.domain.pack else {
            store.listingRevisionChanged(to: replacement.reviewRevision)
            return
        }
        store.listingRevisionChanged(to: replacement.reviewRevision)
    }

    private func updatePack() {
        Task {
            // Only the successful projection fetched for this tap is current
            // enough to replace the seller's pack. An earlier observed pack is
            // not a safe fallback after a failed refresh.
            guard let replacement = await refreshPack() else {
                store.reportActionFailure()
                return
            }
            observe(replacement)
            await store.updatePack(to: replacement)
            if store.domain.pack == replacement {
                observedListingRevision = replacement.reviewRevision
            }
        }
    }
}

@MainActor
struct AssistedExportView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.dismiss) private var dismiss

    @Bindable private var store: AssistedExportStore
    @State private var sharePayload: AssistedExportSharePayload?
    /// The drawer is only as tall as what it holds. Both parts are measured,
    /// so a failure line or the out-of-date notice grows the drawer instead of
    /// pushing the last step under the home indicator.
    @State private var headerHeight: CGFloat = 66
    @State private var contentHeight: CGFloat = 470
    private let summary: AssistedExportItemSummary
    /// The listing's current revision. It originates outside this screen — the
    /// seller can edit the listing from the review surface — so this screen
    /// observes it rather than owning it.
    private let listingRevision: UUID
    private let deviceActions: AssistedExportDeviceActions
    /// The seller asking for a pack that matches the current listing. No
    /// default: a screen that cannot honour it should not offer the action.
    private let onUpdatePack: () -> Void
    /// Called when the Posted it? step becomes answerable on screen, so a
    /// parent can coordinate around the confirm question.
    private let onConfirmSheetPresented: (() -> Void)?

    init(
        store: AssistedExportStore,
        summary: AssistedExportItemSummary,
        listingRevision: UUID,
        deviceActions: AssistedExportDeviceActions? = nil,
        onUpdatePack: @escaping () -> Void,
        onConfirmSheetPresented: (() -> Void)? = nil
    ) {
        self.store = store
        self.summary = summary
        self.listingRevision = listingRevision
        self.deviceActions = deviceActions ?? .live
        self.onUpdatePack = onUpdatePack
        self.onConfirmSheetPresented = onConfirmSheetPresented
    }

    var body: some View {
        VStack(spacing: 0) {
            drawerHeader
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: {
                    headerHeight = $0
                }
            Group {
                switch store.phase {
                case .loading:
                    ProgressView()
                        .frame(maxWidth: .infinity, minHeight: 240)
                        .accessibilityLabel("Loading sharing pack")
                case .failed:
                    ContentUnavailableView {
                        Label(
                            AssistedExportCopy.loadFailedTitle,
                            systemImage: "exclamationmark.circle"
                        )
                    } description: {
                        Text(AssistedExportCopy.loadFailedDetail)
                    } actions: {
                        Button(AssistedExportCopy.retry) {
                            Task { await store.load() }
                        }
                        .accessibilityIdentifier("assisted-export.retry")
                    }
                    .frame(minHeight: 240)
                case .ready:
                    ScrollView {
                        drawerContent
                            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: {
                                contentHeight = $0
                            }
                    }
                    .scrollBounceBehavior(.basedOnSize)
                }
            }
            .frame(maxHeight: .infinity, alignment: .top)
        }
        .background(SnapListColorToken.canvas.color)
        .presentationDetents(detents)
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(28)
        .presentationContentInteraction(.scrolls)
        .interactiveDismissDisabled(store.isWriting)
        .sheet(item: $sharePayload) { payload in
            AssistedExportActivitySheet(items: payload.items) {
                Task {
                    await store.recordHandoff(
                        .sharedAnotherWay,
                        for: payload.destination,
                        pack: payload.pack
                    )
                }
            }
        }
        .task {
            store.listingRevisionChanged(to: listingRevision)
            await store.load()
        }
        .onChange(of: listingRevision) { _, revision in
            withMotion { store.listingRevisionChanged(to: revision) }
        }
    }

    private var domain: AssistedExportDomain { store.domain }

    /// Fits the content. Accessibility sizes get the full height, where the
    /// content scrolls.
    private var detents: Set<PresentationDetent> {
        if dynamicTypeSize.isAccessibilitySize { return [.large] }
        guard store.phase == .ready else { return [.medium] }
        return [.height(headerHeight + contentHeight)]
    }

    /// The marketplace whose steps are on screen. Tabs always show one, so an
    /// untouched drawer shows the first rather than an empty list.
    private var selectedDestination: AssistedExportDestination {
        domain.openDestination ?? domain.destinations[0]
    }

    private func select(_ destination: AssistedExportDestination) {
        guard destination != selectedDestination else { return }
        withMotion { store.toggle(destination) }
    }

    // MARK: - Header

    /// Title and close share one centre line: equal 44pt slots on both sides
    /// keep the title centred, and the 30pt close circle sits centred in its
    /// slot.
    private var drawerHeader: some View {
        HStack(spacing: 0) {
            Color.clear
                .frame(
                    width: SnapListMetrics.minimumTouchTarget,
                    height: SnapListMetrics.minimumTouchTarget
                )
                .accessibilityHidden(true)
            Text(AssistedExportCopy.screenTitle)
                .snapListTypography(.cardTitle)
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("assisted-export.drawer")
            Button { dismiss() } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .frame(width: 30, height: 30)
                    .background(SnapListColorToken.quietFill.color, in: Circle())
                    .frame(
                        width: SnapListMetrics.minimumTouchTarget,
                        height: SnapListMetrics.minimumTouchTarget
                    )
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .disabled(store.isWriting)
            .accessibilityLabel(AssistedExportCopy.closeGuide)
            .accessibilityIdentifier("assisted-export.drawer.close")
        }
        .frame(minHeight: 52)
        .padding(.horizontal, 13)
        .padding(.top, 14)
    }

    // MARK: - Content

    private var drawerContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            itemRow
            if domain.isPackOutOfDate {
                packOutOfDate
            }
            marketplaceTabs
            if !domain.isPackOutOfDate {
                checklist(selectedDestination)
                    .id(selectedDestination)
                feedback(selectedDestination)
                shareAnotherWay(selectedDestination)
            }
        }
        .padding(.horizontal, SnapListMetrics.screenGutter)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var itemRow: some View {
        HStack(spacing: 12) {
            AssistedExportPhoto(url: domain.pack.photoReferences.first)
                .frame(width: 40, height: 40)
                .background(SnapListColorToken.quietFill.color)
                .clipShape(.rect(cornerRadius: 9))
                .accessibilityHidden(true)
            Text(summary.title)
                .snapListTypography(.rowTitle)
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 1)
            Spacer(minLength: 0)
            Text(summary.priceText)
                .snapListTypography(.rowTitle)
                .fontWeight(.bold)
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .monospacedDigit()
        }
        .padding(.top, 6)
        .padding(.bottom, 14)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("assisted-export.item")
    }

    // MARK: - XPORT-05

    private var packOutOfDate: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 9) {
                Image(systemName: "exclamationmark.circle")
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    // On the title rather than the banner, so it cannot
                    // overwrite the identifier of the Update pack button
                    // inside it.
                    Text(AssistedExportCopy.packOutOfDateTitle)
                        .snapListTypography(.rowTitle)
                        .foregroundStyle(SnapListColorToken.inkPrimary.color)
                        .accessibilityIdentifier("assisted-export.pack-out-of-date")
                    Text(AssistedExportCopy.packOutOfDateDetail)
                        .snapListTypography(.status)
                        .foregroundStyle(SnapListColorToken.textSecondary.color)
                }
            }
            // The one primary action of this state. Updating is the seller's
            // call: SnapList will not quietly rebuild a pack underneath them.
            // Addressed as `button.primary.update-pack`.
            SnapListPrimaryButton(title: AssistedExportCopy.updatePack) {
                onUpdatePack()
            }
            .padding(.top, 4)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            SnapListColorToken.groupingFill.color,
            in: .rect(cornerRadius: 14)
        )
        .padding(.bottom, 12)
    }

    // MARK: - Tabs

    private var marketplaceTabs: some View {
        HStack(spacing: 0) {
            ForEach(domain.destinations) { destination in
                marketplaceTab(destination)
            }
        }
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(SnapListColorToken.hairline.color)
                .frame(height: 1)
        }
        .padding(.bottom, 6)
    }

    /// The selected marketplace shows its own colours and an underline; the
    /// others sit back in grey. The full name stays the tab's spoken label.
    private func marketplaceTab(_ destination: AssistedExportDestination) -> some View {
        let isSelected = destination == selectedDestination
        return Button {
            select(destination)
        } label: {
            VStack(spacing: 8) {
                destinationMark(destination)
                    .grayscale(isSelected ? 0 : 1)
                    .opacity(isSelected ? 1 : 0.55)
                tabStatus(destination, isSelected: isSelected)
            }
            .frame(maxWidth: .infinity, minHeight: 64)
            .padding(.vertical, 4)
            .overlay(alignment: .bottom) {
                if isSelected {
                    Capsule()
                        .fill(SnapListColorToken.inkPrimary.color)
                        .frame(height: 2.5)
                        .padding(.horizontal, 18)
                }
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(domain.accessibilityLabel(for: destination))
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier("assisted-export.tab.\(destination.rawValue)")
    }

    @ViewBuilder
    private func tabStatus(
        _ destination: AssistedExportDestination,
        isSelected: Bool
    ) -> some View {
        let text = domain.tabStatusText(for: destination)
        switch domain.handoff(for: destination) {
        case .shared:
            HStack(spacing: 3) {
                Image(systemName: "checkmark")
                    .font(.system(size: 9, weight: .bold))
                    .accessibilityHidden(true)
                Text(text)
                    .snapListTypography(.metadata)
                    .fontWeight(.semibold)
            }
            .foregroundStyle(SnapListColorToken.inkPrimary.color)
        case .prepared:
            Text(text)
                .snapListTypography(.metadata)
                .foregroundStyle(
                    isSelected
                        ? SnapListColorToken.textSecondary.color
                        : SnapListColorToken.textTertiary.color
                )
                .monospacedDigit()
        }
    }

    /// The destination's own wordmark, standing in for its name (#1116). The
    /// tab's accessibility label still carries the full name. Facebook
    /// Marketplace has no wordmark of its own that also carries Facebook's
    /// identity, so its mark is the Facebook icon beside the Marketplace
    /// wordmark, sized down so the pair fits a third of the drawer. See
    /// `docs/demo-asset-provenance.md`.
    @ViewBuilder
    private func destinationMark(_ destination: AssistedExportDestination) -> some View {
        switch destination {
        case .facebookMarketplace:
            HStack(spacing: 5) {
                Image("MarketplaceMarkFacebookIcon")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 15, height: 15)
                Image("MarketplaceMarkFacebook")
                    .resizable()
                    .scaledToFit()
                    .frame(height: 13)
            }
            .frame(height: 18)
        case .mercari:
            Image("MarketplaceMarkMercari")
                .resizable()
                .scaledToFit()
                .frame(height: 16)
                .frame(height: 18)
        case .depop:
            Image("MarketplaceMarkDepop")
                .resizable()
                .scaledToFit()
                .frame(height: 18)
        }
    }

    // MARK: - Checklist

    /// Every step on one page, each with its own button, in the order a
    /// seller uses them. Nothing is locked behind an earlier step: the steps
    /// only touch this device, so their order is advice, not a rule.
    private func checklist(_ destination: AssistedExportDestination) -> some View {
        let completed = domain.guide(for: destination).completed
        return VStack(spacing: 0) {
            checklistRow(
                number: 1,
                title: AssistedExportCopy.copyRowTitle,
                detail: AssistedExportCopy.copyRowDetail(for: destination),
                isDone: completed.contains(.copyText),
                button: ChecklistButton(
                    title: AssistedExportCopy.copyAction,
                    doneTitle: AssistedExportCopy.copiedAction,
                    identifier: "copy"
                ) {
                    copyListingText(for: destination)
                }
            )
            checklistRow(
                number: 2,
                title: AssistedExportCopy.photosRowTitle(count: domain.pack.photoCount),
                detail: AssistedExportCopy.photosRowDetail,
                isDone: completed.contains(.savePhotos),
                button: ChecklistButton(
                    title: AssistedExportCopy.saveAction,
                    doneTitle: AssistedExportCopy.savedAction,
                    identifier: "save"
                ) {
                    Task { await savePhotos(for: destination) }
                }
            )
            checklistRow(
                number: 3,
                title: AssistedExportCopy.openRowTitle(destination),
                detail: AssistedExportCopy.openRowDetail,
                isDone: completed.contains(.openDestination),
                button: ChecklistButton(
                    title: AssistedExportCopy.openAction,
                    doneTitle: AssistedExportCopy.openedAction,
                    identifier: "open"
                ) {
                    // Attempt first, then report. A pre-flight availability
                    // check would state something about the seller's device
                    // that this screen has no business asserting.
                    Task { await openDestination(destination) }
                }
            )
            postedRow(destination)
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: completed)
    }

    private struct ChecklistButton {
        let title: String
        let doneTitle: String
        let identifier: String
        let action: () -> Void
    }

    private func checklistRow(
        number: Int,
        title: String,
        detail: String?,
        isDone: Bool,
        button: ChecklistButton
    ) -> some View {
        rowLayout(
            marker: stepMarker(number: number, isDone: isDone),
            text: rowText(title: title, detail: detail),
            control: Button(action: button.action) {
                // A done step stays tappable: copying again or reopening the
                // app is ordinary, and the server receipt is idempotent.
                pillLabel(
                    isDone ? button.doneTitle : button.title,
                    style: isDone ? .done : .action
                )
            }
            .buttonStyle(.plain)
            .disabled(store.isWriting)
            .accessibilityLabel(isDone ? button.doneTitle : button.title)
            .accessibilityHint(title)
            .accessibilityIdentifier("assisted-export.step.\(button.identifier)")
        )
    }

    /// The fourth step. It becomes answerable only after a handoff on this
    /// device, and the seller's tap here is the only writer of `Shared`.
    @ViewBuilder
    private func postedRow(_ destination: AssistedExportDestination) -> some View {
        if case let .shared(at: date) = domain.handoff(for: destination) {
            rowLayout(
                marker: stepMarker(number: 4, isDone: true),
                text: Text(AssistedExportCopy.sharedStatus(on: date))
                    .snapListTypography(.rowTitle)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .monospacedDigit()
                    .accessibilityIdentifier("assisted-export.shared"),
                control: Group {
                    if domain.undoWindow == destination {
                        Button {
                            Task { await store.undoShared() }
                        } label: {
                            pillLabel(AssistedExportCopy.undo, style: .action)
                        }
                        .buttonStyle(.plain)
                        .disabled(store.isWriting)
                        .accessibilityIdentifier("assisted-export.undo")
                    }
                }
            )
        } else if domain.offersMarkAsShared(for: destination) {
            rowLayout(
                marker: stepMarker(number: 4, isDone: false),
                text: rowText(
                    title: AssistedExportCopy.postedRowTitle,
                    detail: AssistedExportCopy.postedRowDetailReady,
                    identifier: "assisted-export.confirm-sheet"
                ),
                control: Button {
                    Task { await store.confirmShared(for: destination) }
                } label: {
                    pillLabel(AssistedExportCopy.markShared, style: .ink)
                }
                .buttonStyle(.plain)
                .disabled(store.isWriting)
                .accessibilityIdentifier("assisted-export.step.mark-shared")
            )
            // The question being answerable is what the domain calls the
            // confirm sheet, so it is asked for when the row can answer and
            // withdrawn when it cannot, which keeps a tab switch, a swipe, and
            // a pack update the same full cancel they always were.
            .onAppear {
                store.presentConfirmSheet(for: destination)
                onConfirmSheetPresented?()
            }
            .onDisappear { store.dismissConfirmSheet() }
        } else {
            rowLayout(
                marker: stepMarker(number: 4, isDone: false),
                text: rowText(
                    title: AssistedExportCopy.postedRowTitle,
                    detail: AssistedExportCopy.postedRowDetailBefore
                ),
                // Withheld until the seller hands the pack over: asking
                // earlier would invite a claim about a marketplace they
                // never visited.
                control: Button {} label: {
                    pillLabel(AssistedExportCopy.markShared, style: .unavailable)
                }
                .buttonStyle(.plain)
                .disabled(true)
                .accessibilityIdentifier("assisted-export.step.mark-shared")
            )
        }
    }

    @ViewBuilder
    private func rowLayout(
        marker: some View,
        text: some View,
        control: some View
    ) -> some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(alignment: .top, spacing: 14) {
                        marker
                        text
                    }
                    control
                }
                .padding(.vertical, 12)
            } else {
                HStack(spacing: 14) {
                    marker
                    text
                    Spacer(minLength: 0)
                    control
                }
                .padding(.vertical, 8)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 62, alignment: .leading)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(SnapListColorToken.hairline.color)
                .frame(height: 1)
        }
    }

    private func rowText(
        title: String,
        detail: String?,
        identifier: String? = nil
    ) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .snapListTypography(.rowTitle)
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
            if let detail {
                Text(detail)
                    .snapListTypography(.metadata)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(identifier ?? "assisted-export.step-text")
    }

    private func stepMarker(number: Int, isDone: Bool) -> some View {
        ZStack {
            Circle()
                .fill(
                    isDone
                        ? SnapListColorToken.inkPrimary.color
                        : SnapListColorToken.quietFill.color
                )
            if isDone {
                Image(systemName: "checkmark")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(SnapListColorToken.onDarkSurface.color)
            } else {
                Text("\(number)")
                    .font(.system(size: 12.5, weight: .bold))
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
            }
        }
        .frame(width: 26, height: 26)
        .accessibilityHidden(true)
    }

    private enum PillStyle {
        case action
        case done
        case ink
        case unavailable
    }

    private func pillLabel(_ title: String, style: PillStyle) -> some View {
        let foreground: Color
        let background: Color
        switch style {
        case .action:
            foreground = SnapListColorToken.action.color
            background = SnapListColorToken.actionTint.color
        case .done:
            foreground = SnapListColorToken.textSecondary.color
            background = .clear
        case .ink:
            foreground = SnapListColorToken.onDarkSurface.color
            background = SnapListColorToken.inkPrimary.color
        case .unavailable:
            foreground = SnapListColorToken.textTertiary.color
            background = SnapListColorToken.quietFill.color
        }
        return Text(title)
            .snapListTypography(.status)
            .fontWeight(.semibold)
            .snapListFitsFixedSlot(minimumScale: 0.7)
            .foregroundStyle(foreground)
            .padding(.horizontal, 12)
            .frame(minWidth: 92, minHeight: 36)
            .background(background, in: Capsule())
            .frame(minHeight: SnapListMetrics.minimumTouchTarget)
            .contentShape(.rect)
    }

    // MARK: - Feedback

    @ViewBuilder
    private func feedback(_ destination: AssistedExportDestination) -> some View {
        if let advisory = domain.advisory(for: destination) {
            feedbackLine(advisory, systemImage: "info.circle", identifier: "assisted-export.advisory")
        }
        if let message = store.actionMessage {
            feedbackLine(
                message,
                systemImage: "exclamationmark.circle",
                identifier: "assisted-export.action-message"
            )
        }
    }

    private func feedbackLine(
        _ text: String,
        systemImage: String,
        identifier: String
    ) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: systemImage)
                .foregroundStyle(SnapListColorToken.caution.color)
                .accessibilityHidden(true)
            Text(text)
                .snapListTypography(.status)
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .accessibilityIdentifier(identifier)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            SnapListColorToken.cautionFill.color,
            in: .rect(cornerRadius: 12)
        )
        .padding(.top, 10)
    }

    private func shareAnotherWay(_ destination: AssistedExportDestination) -> some View {
        Button {
            Task { await prepareShareSheet(for: destination) }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "square.and.arrow.up")
                    .accessibilityHidden(true)
                Text(AssistedExportCopy.shareAnotherWay)
                    .snapListTypography(.rowTitle)
                Spacer(minLength: 0)
            }
            .foregroundStyle(SnapListColorToken.action.color)
            .frame(minHeight: 50)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("assisted-export.share-another-way.\(destination.rawValue)")
        .disabled(store.isWriting)
    }

    // MARK: - Device handoff

    private func copyListingText(for destination: AssistedExportDestination) {
        let requestedPack = domain.pack
        Task {
            // The copy itself happens inside `deliver`, on the pack the server
            // resolved there and then. Copying first and reconciling
            // afterwards would put a replaced price in the pasteboard.
            await store.deliver(
                .copiedListingText,
                for: destination,
                pack: requestedPack
            ) { currentPack in
                deviceActions.copy(currentPack.listingText(for: destination))
            }
        }
    }

    private func openDestination(
        _ destination: AssistedExportDestination
    ) async {
        let requestedPack = domain.pack
        let didOpen = await deviceActions.open(destination)
        guard didOpen else {
            withMotion { store.destinationDidNotOpen(destination) }
            return
        }
        await store.recordHandoff(
            .openedDestination,
            for: destination,
            pack: requestedPack
        )
    }

    private func savePhotos(
        for destination: AssistedExportDestination
    ) async {
        let requestedPack = domain.pack
        await store.savePhotos(for: destination, pack: requestedPack) {
            let images = try await deviceActions.loadPhotos(
                requestedPack.photoReferences
            )
            try await deviceActions.savePhotos(images)
        }
    }

    private func prepareShareSheet(
        for destination: AssistedExportDestination
    ) async {
        // Same rule as Copy: the pack is resolved against the server before its
        // text and photos are handed to another app. The receipt is not written
        // here — the share sheet records its handoff once it is on screen.
        var payload: AssistedExportSharePayload?
        await store.prepareDelivery(pack: domain.pack) { currentPack in
            let images = try await deviceActions.loadPhotos(
                currentPack.photoReferences
            )
            guard domain.pack == currentPack,
                  !domain.isPackOutOfDate else { return }
            payload = AssistedExportSharePayload(
                destination: destination,
                pack: currentPack,
                items: [currentPack.listingText(for: destination)] + images
            )
        }
        // Mount the sheet only once `prepareDelivery` has released the write
        // lock. Assigning inside the closure happens while `isWriting` is still
        // true, and the sheet's `onPresented` receipt is refused in that window.
        sharePayload = payload
    }

    // MARK: - Motion

    /// Every state on this screen is legible without animation, so Reduced
    /// Motion drops the transition rather than substituting one.
    private func withMotion(_ change: () -> Void) {
        if reduceMotion {
            change()
        } else {
            withAnimation(.easeOut(duration: 0.18), change)
        }
    }
}


/// Shares the Listing Review fixture photograph without changing real-media
/// fetching or any of the export payload's ordered photo references.
private struct AssistedExportPhoto: View {
    let url: URL?

    var body: some View {
#if DEBUG
        if url?.host == "example.com" {
            Image("FirstValueController")
                .resizable()
                .scaledToFill()
        } else {
            remotePhoto
        }
#else
        remotePhoto
#endif
    }

    private var remotePhoto: some View {
        AsyncImage(url: url) { phase in
            switch phase {
            case .success(let image):
                image.resizable().scaledToFill()
            case .empty:
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            default:
                Image(systemName: "photo")
                    .font(.title2)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }
}
