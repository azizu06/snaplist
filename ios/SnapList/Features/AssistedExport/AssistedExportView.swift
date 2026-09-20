import SwiftUI

/// The assisted-export screen (issue #581, design authority
/// `Assisted Export + Share Handoff v1`, XPORT-01 through XPORT-05).
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
                funnelAnalytics: funnelAnalytics
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

    @Bindable private var store: AssistedExportStore
    @State private var sharePayload: AssistedExportSharePayload?
    private let summary: AssistedExportItemSummary
    /// The listing's current revision. It originates outside this screen — the
    /// seller can edit the listing from the review surface — so this screen
    /// observes it rather than owning it.
    private let listingRevision: UUID
    private let deviceActions: AssistedExportDeviceActions
    /// The seller asking for a pack that matches the current listing. No
    /// default: a screen that cannot honour it should not offer the action.
    private let onUpdatePack: () -> Void
    /// Called when the confirm sheet is actually on screen, so a parent can
    /// coordinate around a presented modal.
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
        Group {
            switch store.phase {
            case .loading:
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
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
            case .ready:
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        itemIdentity
                        if domain.isPackOutOfDate {
                            packOutOfDate
                        } else {
                            packMeta
                        }
                        destinationRows
                        Color.clear.frame(height: 40)
                    }
                }
            }
        }
        .background(SnapListColorToken.canvas.color)
        .navigationTitle(AssistedExportCopy.screenTitle)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: guideBinding) { destination in
            guideSheet(destination)
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

    // MARK: - Identity

    private var itemIdentity: some View {
        HStack(spacing: 12) {
            AsyncImage(url: domain.pack.photoReferences.first) { image in
                image.resizable().scaledToFill()
            } placeholder: {
                SnapListColorToken.quietFill.color
            }
            .frame(width: 64, height: 64)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(summary.title)
                    .snapListTypography(.cardTitle)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                Text(summary.priceText)
                    .snapListTypography(.body)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .monospacedDigit()
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, SnapListMetrics.screenGutter)
        .padding(.top, 16)
        .padding(.bottom, 14)
    }

    private var packMeta: some View {
        Text(
            AssistedExportCopy.packMeta(
                photoCount: domain.pack.photoCount,
                preparedAt: summary.preparedAtText
            )
        )
        .snapListTypography(.status)
        .foregroundStyle(SnapListColorToken.textSecondary.color)
        .monospacedDigit()
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, SnapListMetrics.screenGutter)
        .padding(.bottom, 14)
        .accessibilityIdentifier("assisted-export.pack-meta")
    }

    // MARK: - XPORT-05

    private var packOutOfDate: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 9) {
                Image(systemName: "exclamationmark.circle")
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 5) {
                    // On the title rather than the banner, so it cannot
                    // overwrite the identifier of the Update pack button
                    // inside it. See the note in `workspace`.
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
        .background(SnapListColorToken.groupingFill.color)
        .padding(.horizontal, SnapListMetrics.screenGutter)
        .padding(.bottom, 16)
    }

    // MARK: - Rows

    private var destinationRows: some View {
        VStack(spacing: 0) {
            Divider().overlay(SnapListColorToken.hairline.color)
            ForEach(domain.destinations) { destination in
                destinationRow(destination)
            }
        }
    }

    /// A row opens that destination's guide sheet. The trailing chevron points
    /// up because that is where the sheet rises from; nothing expands inline.
    private func destinationRow(_ destination: AssistedExportDestination) -> some View {
        Button {
            withMotion { store.toggle(destination) }
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    // #1116: the wordmark is the name. The full name stays the
                    // row's accessibility label; printing it beside its own
                    // logo said everything twice (Facebook Marketplace worst).
                    destinationMark(destination)
                    stateLine(destination)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.up")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, SnapListMetrics.screenGutter)
            .padding(.vertical, 11)
            .frame(minHeight: 60)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .background(SnapListColorToken.canvas.color)
        .overlay(alignment: .bottom) {
            Divider().overlay(SnapListColorToken.hairline.color)
        }
        .accessibilityLabel(domain.accessibilityLabel(for: destination))
        .accessibilityHint(AssistedExportCopy.rowHint)
        .accessibilityIdentifier("assisted-export.row.\(destination.rawValue)")
    }

    /// The destination's own wordmark, standing in for its name (#1116; #977
    /// had printed the name beside it). The row's accessibility label still
    /// carries the full name, so VoiceOver and Voice Control are unaffected.
    /// Facebook Marketplace has no wordmark
    /// of its own that also carries Facebook's identity, so its mark is a
    /// composite lockup of the Facebook icon asset and the Marketplace
    /// wordmark asset, both sized to this row's 20pt convention; Mercari and
    /// Depop render their own single wordmark asset at that same height. See
    /// `docs/demo-asset-provenance.md`.
    @ViewBuilder
    private func destinationMark(_ destination: AssistedExportDestination) -> some View {
        switch destination {
        case .facebookMarketplace:
            HStack(spacing: 6) {
                Image("MarketplaceMarkFacebookIcon")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 20, height: 20)
                Image("MarketplaceMarkFacebook")
                    .resizable()
                    .scaledToFit()
                    .frame(height: 20)
            }
        case .mercari:
            Image("MarketplaceMarkMercari")
                .resizable()
                .scaledToFit()
                .frame(height: 20)
        case .depop:
            Image("MarketplaceMarkDepop")
                .resizable()
                .scaledToFit()
                .frame(height: 22)
        }
    }

    /// One line: Not started, Prepared, or the seller's own Shared claim. A
    /// confirmed destination is set apart by a checkmark, the wording, and
    /// text weight. The approved package is explicit that this difference
    /// carries no colour, badge, or banner: the seller's own note about their
    /// own listing is not an achievement SnapList celebrates.
    @ViewBuilder
    private func stateLine(_ destination: AssistedExportDestination) -> some View {
        let text = domain.rowStateText(for: destination)
        switch domain.handoff(for: destination) {
        case .prepared:
            Text(text)
                .snapListTypography(.status)
                .foregroundStyle(SnapListColorToken.textSecondary.color)
        case .shared:
            HStack(spacing: 5) {
                Image(systemName: "checkmark")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .accessibilityHidden(true)
                Text(text)
                    .snapListTypography(.status)
                    .fontWeight(.semibold)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .monospacedDigit()
            }
        }
    }

    // MARK: - Guide sheet

    /// The sheet is presented exactly while the store says one destination's
    /// workspace is on screen. A stale pack takes it down without forgetting
    /// the destination, so the setter only closes a sheet that was showing.
    private var guideBinding: Binding<AssistedExportDestination?> {
        Binding(
            get: {
                domain.destinations.first { domain.isWorkspaceOpen($0) }
            },
            set: { presented in
                guard presented == nil,
                      let open = domain.destinations.first(where: {
                          domain.isWorkspaceOpen($0)
                      }) else { return }
                withMotion { store.toggle(open) }
            }
        )
    }

    private func guideSheet(_ destination: AssistedExportDestination) -> some View {
        let progress = domain.guide(for: destination)
        return ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                guideHeader(destination)

                if progress.current != nil {
                    Text(progress.positionText)
                        .snapListTypography(.status)
                        .foregroundStyle(SnapListColorToken.textSecondary.color)
                        .monospacedDigit()
                        .accessibilityIdentifier("assisted-export.guide.position")
                }

                VStack(alignment: .leading, spacing: 12) {
                    ForEach(AssistedExportGuideStep.allCases, id: \.self) { step in
                        guideStepRow(
                            step,
                            progress: progress,
                            destination: destination
                        )
                    }
                }
                .animation(
                    reduceMotion ? nil : .easeOut(duration: 0.2),
                    value: progress
                )

                if progress.current == nil {
                    sharedNote(destination)
                }

                if let advisory = domain.advisory(for: destination) {
                    advisoryRow(advisory)
                }

                if progress.current != nil {
                    shareAnotherWay(destination)
                }

                if let message = store.actionMessage {
                    Text(message)
                        .snapListTypography(.status)
                        .foregroundStyle(SnapListColorToken.textSecondary.color)
                        .accessibilityIdentifier("assisted-export.action-message")
                }
            }
            .padding(.horizontal, SnapListMetrics.screenGutter)
            .padding(.top, 12)
            .padding(.bottom, 24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(SnapListColorToken.canvas.color)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
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
    }

    private func guideHeader(_ destination: AssistedExportDestination) -> some View {
        HStack {
            destinationMark(destination)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(destination.displayName)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier(
                    "assisted-export.workspace.\(destination.rawValue)"
                )
            Spacer(minLength: 0)
            Button {
                withMotion { store.toggle(destination) }
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .frame(
                        width: SnapListMetrics.minimumTouchTarget,
                        height: SnapListMetrics.minimumTouchTarget
                    )
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(AssistedExportCopy.closeGuide)
            .accessibilityIdentifier("assisted-export.guide.close")
        }
        .padding(.top, 8)
    }

    @ViewBuilder
    private func guideStepRow(
        _ step: AssistedExportGuideStep,
        progress: AssistedExportGuideProgress,
        destination: AssistedExportDestination
    ) -> some View {
        if progress.completed.contains(step) {
            HStack(spacing: 10) {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .accessibilityHidden(true)
                Text(AssistedExportCopy.completedStepSummary(step))
                    .snapListTypography(.status)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(
                AssistedExportCopy.completedStepSummary(step)
            )
            .accessibilityValue(AssistedExportCopy.stepDone)
        } else if step == progress.current {
            currentStep(step, progress: progress, destination: destination)
                .transition(
                    reduceMotion
                        ? .identity
                        : .asymmetric(
                            insertion: .move(edge: .trailing).combined(with: .opacity),
                            removal: .opacity
                        )
                )
        } else {
            Text(AssistedExportCopy.upcomingStepTitle(step, for: destination))
                .snapListTypography(.status)
                .foregroundStyle(SnapListColorToken.textSecondary.color.opacity(0.7))
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityLabel(
                    AssistedExportCopy.upcomingStepTitle(step, for: destination)
                )
                .accessibilityValue(AssistedExportCopy.stepUpcoming)
        }
    }

    private func currentStep(
        _ step: AssistedExportGuideStep,
        progress: AssistedExportGuideProgress,
        destination: AssistedExportDestination
    ) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(AssistedExportCopy.guideInstruction(step, for: destination))
                .snapListTypography(step == .confirmPosted ? .sectionHeader : .body)
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                // On the instruction rather than the step stack, so the
                // controls below keep their own identifiers. The confirm
                // step's question doubles as the marker that the confirm
                // question is on screen.
                .accessibilityIdentifier(
                    step == .confirmPosted
                        ? "assisted-export.confirm-sheet"
                        : "assisted-export.guide.instruction"
                )
                .accessibilityLabel(
                    "\(progress.positionText). "
                        + AssistedExportCopy.guideInstruction(step, for: destination)
                )
            switch step {
            case .copyText:
                SnapListPrimaryButton(title: AssistedExportCopy.copyListingText) {
                    copyListingText(for: destination)
                }
                .disabled(store.isWriting)
            case .savePhotos:
                SnapListPrimaryButton(
                    title: AssistedExportCopy.savePhotos(count: domain.pack.photoCount)
                ) {
                    Task { await savePhotos(for: destination) }
                }
                .disabled(store.isWriting)
            case .openDestination:
                // `SnapListPrimaryButton` derives its own accessibility
                // identifier from its title. It is addressed as
                // `button.primary.open-<destination>`.
                SnapListPrimaryButton(
                    title: domain.primaryActionLabel(for: destination)
                ) {
                    // Attempt first, then report. A pre-flight availability
                    // check would state something about the seller's device
                    // that this screen has no business asserting.
                    Task { await openDestination(destination) }
                }
                .disabled(store.isWriting)
            case .confirmPosted:
                confirmControls(destination)
            }
        }
    }

    /// The only writer of `Shared` on this screen. The question being on screen
    /// is what the domain calls the confirm sheet, so it is asked for when the
    /// step appears and withdrawn when it goes, which keeps a swipe, `Not yet`,
    /// and a pack update the same full cancel they were before the guide.
    private func confirmControls(
        _ destination: AssistedExportDestination
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SnapListPrimaryButton(title: AssistedExportCopy.confirmShared) {
                Task { await store.confirmShared() }
            }
            .disabled(store.isWriting)
            SnapListSecondaryButton(title: AssistedExportCopy.confirmNotYet) {
                withMotion { store.toggle(destination) }
            }
            .disabled(store.isWriting)
            Text(AssistedExportCopy.markAsSharedSupport)
                .snapListTypography(.metadata)
                .foregroundStyle(SnapListColorToken.textSecondary.color)
        }
        .onAppear {
            store.presentConfirmSheet(for: destination)
            onConfirmSheetPresented?()
        }
        .onDisappear { store.dismissConfirmSheet() }
    }

    private func sharedNote(_ destination: AssistedExportDestination) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(domain.rowStateText(for: destination))
                .snapListTypography(.rowTitle)
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .monospacedDigit()
                .accessibilityIdentifier("assisted-export.guide.shared")
            if domain.undoWindow == destination {
                undoRow()
            }
        }
    }

    private func advisoryRow(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: "info.circle")
                .foregroundStyle(SnapListColorToken.textSecondary.color)
                .accessibilityHidden(true)
            Text(text)
                .snapListTypography(.status)
                .foregroundStyle(SnapListColorToken.textSecondary.color)
                .accessibilityIdentifier("assisted-export.advisory")
        }
        .padding(.horizontal, 13)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(SnapListColorToken.quietFill.color)
    }

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

    private func shareAnotherWay(_ destination: AssistedExportDestination) -> some View {
        Button {
            Task { await prepareShareSheet(for: destination) }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "square.and.arrow.up")
                    .foregroundStyle(SnapListColorToken.action.color)
                    .accessibilityHidden(true)
                Text(AssistedExportCopy.shareAnotherWay)
                    .snapListTypography(.rowTitle)
                    .foregroundStyle(SnapListColorToken.action.color)
                Spacer(minLength: 0)
            }
            .frame(minHeight: SnapListMetrics.minimumTouchTarget)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("assisted-export.share-another-way.\(destination.rawValue)")
        .disabled(store.isWriting)
    }

    private func undoRow() -> some View {
        HStack(spacing: 8) {
            Text(AssistedExportCopy.markedAsShared)
                .snapListTypography(.status)
                .foregroundStyle(SnapListColorToken.textSecondary.color)
            Button {
                Task { await store.undoShared() }
            } label: {
                Text(AssistedExportCopy.undo)
                    .snapListTypography(.status)
                    .fontWeight(.semibold)
                    .foregroundStyle(SnapListColorToken.action.color)
                    .frame(
                        minWidth: SnapListMetrics.minimumTouchTarget,
                        minHeight: SnapListMetrics.minimumTouchTarget
                    )
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("assisted-export.undo")
            .disabled(store.isWriting)
            Spacer(minLength: 0)
        }
        .frame(minHeight: SnapListMetrics.minimumTouchTarget)
    }

    // MARK: - Device handoff

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
        // true, and the sheet's `onPresented` receipt is refused in that window
        // (`AssistedExportStore.swift:103`). Today no suspension point separates
        // the two, so nothing can render in between — hoisting the assignment
        // makes that structural instead of an argument about the current code.
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
