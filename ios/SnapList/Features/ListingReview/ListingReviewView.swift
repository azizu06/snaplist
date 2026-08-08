import SwiftUI

private enum ListingReviewDestination: Identifiable, Hashable {
    case title
    case description
    case condition
    case specifics
    case sold(Int)
    case correction
    case ebayPublish
    case assistedExport

    var id: String {
        switch self {
        case .title: "title"
        case .description: "description"
        case .condition: "condition"
        case .specifics: "specifics"
        case .sold(let index): "sold-\(index)"
        case .correction: "correction"
        case .ebayPublish: "ebay-publish"
        case .assistedExport: "assisted-export"
        }
    }
}

@MainActor
struct ListingReviewView: View {
    @Bindable var store: ListingReviewStore
    let correctionAvailable: Bool
    let forceReducedMotion: Bool
    let dismissReview: () -> Void
    let goToTrophyWall: () -> Void
    let startNewItem: () -> Void
    var activationInteraction: () -> Void = {}

    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.locale) private var locale
    @Environment(\.appDependencies) private var dependencies
    @State private var destination: ListingReviewDestination?
    @State private var returnFocus: ListingReviewFocus = .back
    @State private var hasAppeared = false
    @State private var priceEditing = false
    @State private var priceText = ""
    @State private var priceInvalid = false
    @FocusState private var priceFieldFocused: Bool
    @AccessibilityFocusState private var focusedElement:
        ListingReviewFocus?

    var body: some View {
        Group {
            if let snapshot = store.snapshot, let draft = store.draft {
                review(snapshot: snapshot, draft: draft)
            } else {
                ProgressView("Loading review…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(SnapListColorToken.canvas.color)
        .navigationTitle("Listing review")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(true)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    dismissReview()
                } label: {
                    Label("Back", systemImage: "chevron.left")
                }
                .frame(
                    minWidth: SnapListMetrics.minimumTouchTarget,
                    minHeight: SnapListMetrics.minimumTouchTarget
                )
                .accessibilityLabel("Back to Processing review")
                .accessibilityFocused($focusedElement, equals: .back)
                .accessibilityIdentifier("listing-review.back")
            }
        }
        .navigationDestination(item: $destination) { destination in
            destinationView(destination)
        }
        .alert(
            ListingReviewCopy.staleReview,
            isPresented: phaseBinding(.conflict)
        ) {
            Button(ListingReviewCopy.reload) {
                Task { await store.requestReload() }
            }
        }
        .alert(
            "Discard changes and reload?",
            isPresented: phaseBinding(.reloadConfirmation)
        ) {
            Button("Keep editing", role: .cancel) {
                store.keepEditing()
            }
            Button("Discard changes and reload", role: .destructive) {
                Task { await store.discardChangesAndReload() }
            }
        } message: {
            Text("Your unsaved changes would be lost.")
        }
        .alert(
            ListingReviewCopy.reloadFailed,
            isPresented: phaseBinding(.reloadFailed)
        ) {
            Button(ListingReviewCopy.keepEditing, role: .cancel) {
                store.keepEditing()
            }
            Button(ListingReviewCopy.retry) {
                Task { await store.discardChangesAndReload() }
            }
        } message: {
            Text(
                "The review is out of date and saving will need a reload first."
            )
        }
        .onAppear {
            if hasAppeared {
                focusedElement = returnFocus
            } else {
                hasAppeared = true
                focusedElement = .back
                priceText = store.draft?.sellerPriceOverride.map {
                    ListingReviewCurrency.string($0, locale: locale)
                } ?? ""
            }
        }
        .onChange(of: destination?.id) { previous, current in
            guard previous != nil, current == nil else { return }
            focusedElement = returnFocus
        }
        .onChange(of: store.announcement) { _, announcement in
            let assertive = store.phase == .failed
                || store.phase == .conflict
                || store.phase == .reloadFailed
            ListingReviewAnnouncement.post(
                announcement,
                assertive: assertive
            )
        }
        // Without the container, the identifier is not bound to an element of
        // its own and propagates down instead. Children inside the footer's
        // safe-area inset do not override it, so `listing-review.done`,
        // `listing-review.secondary` and the pending strip were all published
        // as `listing-review`.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("listing-review")
        .accessibilityValue(
            store.snapshot?.binding.accessibilityIdentifier ?? ""
        )
        .overlay(alignment: .topLeading) {
#if DEBUG
            // A simulator with the system setting off leaves
            // `accessibilityReduceMotion` false for the whole run, so a
            // screenshot taken under `--reduced-motion` proves nothing on its
            // own. This publishes the resolved value the surface actually
            // used, the way Photo Review and Scan Camera already do.
            if reduceMotion {
                Color.clear
                    .frame(width: 1, height: 1)
                    .accessibilityElement()
                    .accessibilityLabel("Reduced motion")
                    .accessibilityIdentifier("listing-review.motion-reduced")
            }
#endif
        }
    }

    private var reduceMotion: Bool {
        systemReduceMotion || forceReducedMotion
    }

    private func review(
        snapshot: ListingReviewResult,
        draft: ListingReviewDraft
    ) -> some View {
        ScrollView {
            // Four bounded children, not a feed. A lazy stack would leave the
            // ones below the fold out of the accessibility tree until the
            // seller scrolls them into view, which at the largest Dynamic Type
            // sizes is most of the review — including the title control that
            // Voice Control and the rotor need to be able to name.
            VStack(alignment: .leading, spacing: 18) {
                ListingReviewPhotoPager(photos: snapshot.photos)

                stateBanner

                identityAndPricing(snapshot: snapshot, draft: draft)

                details(snapshot: snapshot, draft: draft)

                ebayPublishEntry

                assistedExportEntry
            }
            .padding(.horizontal, 18)
            .padding(.top, 12)
            .padding(.bottom, 20)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                if store.isDirty {
                    ListingReviewPendingStrip()
                }
                footer
            }
            .background(SnapListColorToken.canvas.color)
        }
    }

    @ViewBuilder
    private var stateBanner: some View {
        if store.isStale,
           store.phase != .conflict,
           store.phase != .reloadConfirmation,
           store.phase != .reloadFailed {
            ListingReviewStatusBanner(
                text: ListingReviewCopy.staleReview,
                systemImage: "arrow.clockwise.circle",
                retry: {
                    Task { await store.requestReload() }
                },
                retryLabel: ListingReviewCopy.reload,
                retryIdentifier: "listing-review.reload"
            )
        } else if store.phase == .offline {
            ListingReviewStatusBanner(
                text: "You're offline. Your changes are saved on this phone.",
                systemImage: "wifi.slash"
            )
        } else if store.phase == .failed {
            ListingReviewStatusBanner(
                text: store.announcement.isEmpty
                    ? ListingReviewCopy.saveFailed
                    : store.announcement,
                systemImage: "exclamationmark.circle",
                retry: {
                    Task { _ = await finish(retry: true) }
                }
            )
        } else {
            EmptyView()
        }
    }

    private func identityAndPricing(
        snapshot: ListingReviewResult,
        draft: ListingReviewDraft
    ) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                if snapshot.identity.confident {
                    Image(systemName: "sparkles")
                        .foregroundStyle(SnapListColorToken.action.color)
                        .accessibilityHidden(true)
                }
                Text(snapshot.identity.label)
                    .font(.headline)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 14)
            .padding(.top, 14)

            price(snapshot: snapshot, draft: draft)
                .padding(14)

            if !snapshot.verifiedSoldMatches.isEmpty {
                Divider()
                    .padding(.horizontal, 14)
                soldMatches(snapshot.verifiedSoldMatches)
                    .padding(.vertical, 14)
            }
        }
        .background(SnapListColorToken.canvas.color)
        .clipShape(RoundedRectangle(cornerRadius: 18))
        .overlay {
            RoundedRectangle(cornerRadius: 18)
                .stroke(SnapListColorToken.hairline.color)
        }
        .accessibilityElement(children: .contain)
    }

    private func price(
        snapshot: ListingReviewResult,
        draft: ListingReviewDraft
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if snapshot.verifiedSoldMatches.isEmpty {
                Text(ListingReviewCopy.startingPriceEstimate)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(SnapListColorToken.textTertiary.color)
            }

            if priceEditing {
                HStack(spacing: 10) {
                    TextField("Price", text: $priceText)
                        .focused($priceFieldFocused)
                        .keyboardType(.decimalPad)
                        .font(.title.weight(.bold).monospacedDigit())
                        .foregroundStyle(SnapListColorToken.inkPrimary.color)
                        .padding(.horizontal, 12)
                        .frame(minHeight: 48)
                        .overlay {
                            RoundedRectangle(cornerRadius: 12)
                                .stroke(
                                    priceInvalid
                                        ? Color(hex: "#D68A8A")
                                        : SnapListColorToken.hairline.color
                                )
                        }
                        .accessibilityLabel("Price")
                        .accessibilityValue(priceText)
                        .accessibilityIdentifier("listing-review.price.field")
                    Button {
                        Task { await commitPrice() }
                    } label: {
                        Text("Apply")
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(SnapListColorToken.action.color)
                            .padding(.horizontal, 12)
                            .frame(
                                minHeight: SnapListMetrics.minimumTouchTarget
                            )
                    }
                    .accessibilityLabel("Apply price, keeps it on this phone")
                    .accessibilityIdentifier("listing-review.price.apply")
                }
                // The seller already aimed at the price to change it, so the
                // field takes the keyboard on arrival rather than waiting for
                // a second tap. Focus is requested here rather than in the
                // opening action because the field does not exist yet at the
                // moment `priceEditing` flips.
                .onAppear { priceFieldFocused = true }
                if priceInvalid {
                    Text(ListingReviewCopy.invalidPrice)
                        .font(.callout)
                        .foregroundStyle(
                            ListingReviewPriceStyle.invalidMessage.color
                        )
                        .accessibilityIdentifier("listing-review.price.error")
                }
            } else {
                Button {
                    activationInteraction()
                    priceText = draft.sellerPriceOverride.map {
                        ListingReviewCurrency.string($0, locale: locale)
                    } ?? ""
                    priceInvalid = false
                    priceEditing = true
                } label: {
                    HStack(spacing: 8) {
                        Text(
                            ListingReviewCurrency.string(
                                store.effectivePrice
                                    ?? snapshot.pricing.effectivePrice,
                                locale: locale
                            )
                        )
                        .font(.largeTitle.weight(.bold).monospacedDigit())
                        .foregroundStyle(SnapListColorToken.inkPrimary.color)
                        Image(systemName: "pencil")
                            .font(.body.weight(.semibold))
                            .foregroundStyle(SnapListColorToken.action.color)
                            .accessibilityHidden(true)
                    }
                    .frame(minHeight: SnapListMetrics.minimumTouchTarget)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(
                    draft.sellerPriceOverride == nil
                        ? "Suggested price"
                        : "Your price"
                )
                .accessibilityValue(
                    ListingReviewCurrency.string(
                        store.effectivePrice
                            ?? snapshot.pricing.effectivePrice,
                        locale: locale
                    )
                )
                .accessibilityHint("Edit")
                .accessibilityFocused($focusedElement, equals: .price)
                .accessibilityIdentifier("listing-review.price")
            }

            if snapshot.verifiedSoldMatches.isEmpty {
                Text(ListingReviewCopy.noVerifiedSoldMatches)
                    .font(.callout)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
            } else if draft.sellerPriceOverride != nil {
                Text(
                    "Suggested \(ListingReviewCurrency.string(snapshot.pricing.suggestedPrice, locale: locale))"
                )
                .font(.callout)
                .foregroundStyle(SnapListColorToken.textSecondary.color)
            }
        }
    }

    private func soldMatches(
        _ matches: [ListingReviewSoldMatch]
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("VERIFIED SOLD MATCHES")
                    .font(.caption2.weight(.bold))
                    .tracking(0.5)
                    .foregroundStyle(SnapListColorToken.textTertiary.color)
                Spacer()
                Text(ListingReviewSoldSummary.text(for: matches, locale: locale))
                    .font(.caption)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
            }
            .padding(.horizontal, 14)

            ScrollView(.horizontal) {
                LazyHStack(spacing: 12) {
                    ForEach(Array(matches.enumerated()), id: \.element.id) {
                        index,
                        match in
                        ListingReviewSoldCard(
                            match: match,
                            index: index,
                            total: matches.count
                        ) {
                            returnFocus = .soldMatch(index)
                            destination = .sold(index)
                        }
                        .accessibilityFocused(
                            $focusedElement,
                            equals: .soldMatch(index)
                        )
                    }
                }
                .scrollTargetLayout()
            }
            .contentMargins(.horizontal, 14, for: .scrollContent)
            .scrollTargetBehavior(.viewAligned)

            Text("Sold prices, not asking prices.")
                .font(.caption)
                .foregroundStyle(SnapListColorToken.textTertiary.color)
                .padding(.horizontal, 14)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(
            "Verified sold matches, \(matches.count) \(matches.count == 1 ? "sold item" : "sold items")"
        )
    }

    private func details(
        snapshot: ListingReviewResult,
        draft: ListingReviewDraft
    ) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("LISTING DETAILS")
                .font(.caption2.weight(.bold))
                .tracking(0.5)
                .foregroundStyle(SnapListColorToken.textTertiary.color)
                .padding(.horizontal, 14)
                .padding(.top, 14)
                .padding(.bottom, 5)

            detailRow(
                title: "Title",
                value: draft.title,
                focus: .title,
                destination: .title,
                pending: draft.title != snapshot.listing.title
            )
            Divider().padding(.leading, 14)
            detailRow(
                title: "Description",
                value: draft.description,
                focus: .description,
                destination: .description,
                pending: draft.description != snapshot.listing.description
            )
            Divider().padding(.leading, 14)
            detailRow(
                title: "Condition",
                value: draft.condition.sellerLabel,
                focus: .condition,
                destination: .condition,
                pending: draft.condition != snapshot.listing.condition
            )
            Divider().padding(.leading, 14)
            detailRow(
                title: "Item specifics",
                value: specificsSummary(draft.specifics),
                focus: .specifics,
                destination: .specifics,
                pending: draft.specifics != snapshot.listing.specifics
            )
        }
        .background(SnapListColorToken.canvas.color)
        .clipShape(RoundedRectangle(cornerRadius: 18))
        .overlay {
            RoundedRectangle(cornerRadius: 18)
                .stroke(SnapListColorToken.hairline.color)
        }
    }

    private func detailRow(
        title: String,
        value: String,
        focus: ListingReviewFocus,
        destination: ListingReviewDestination,
        pending: Bool
    ) -> some View {
        ListingReviewDisclosureRow(
            title: title,
            value: value,
            identifier: "listing-review.\(destination.id)",
            pending: pending
        ) {
            activationInteraction()
            returnFocus = focus
            self.destination = destination
        }
        .accessibilityFocused($focusedElement, equals: focus)
    }

    private var assistedExportEntry: some View {
        Button {
            guard !store.isDirty else {
                ListingReviewAnnouncement.post(
                    AssistedExportCopy.saveBeforeSharing,
                    assertive: true
                )
                return
            }
            returnFocus = .assistedExport
            destination = .assistedExport
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "square.and.arrow.up")
                    .font(.headline)
                    .foregroundStyle(SnapListColorToken.action.color)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(AssistedExportCopy.entryTitle)
                        .font(.headline)
                        .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    Text(AssistedExportCopy.entryDetail)
                        .font(.caption)
                        .foregroundStyle(SnapListColorToken.textSecondary.color)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .accessibilityHidden(true)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(SnapListColorToken.canvas.color)
        .clipShape(RoundedRectangle(cornerRadius: 18))
        .overlay {
            RoundedRectangle(cornerRadius: 18)
                .stroke(SnapListColorToken.hairline.color)
        }
        .accessibilityHint(
            store.isDirty
                ? AssistedExportCopy.saveBeforeSharing
                : "Opens the prepared sharing pack"
        )
        .accessibilityFocused($focusedElement, equals: .assistedExport)
        .accessibilityIdentifier("listing-review.assisted-export")
    }

    private var ebayPublishEntry: some View {
        Button {
            guard !store.isDirty else {
                ListingReviewAnnouncement.post(
                    "Save your changes before publishing to eBay.",
                    assertive: true
                )
                return
            }
            returnFocus = .ebayPublish
            destination = .ebayPublish
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "shippingbox")
                    .font(.headline)
                    .foregroundStyle(SnapListColorToken.action.color)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Publish to eBay")
                        .font(.headline)
                        .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    Text("Connect, review, and post when you are ready.")
                        .font(.caption)
                        .foregroundStyle(SnapListColorToken.textSecondary.color)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .accessibilityHidden(true)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(SnapListColorToken.canvas.color)
        .clipShape(RoundedRectangle(cornerRadius: 18))
        .overlay {
            RoundedRectangle(cornerRadius: 18)
                .stroke(SnapListColorToken.hairline.color)
        }
        .accessibilityHint(
            store.isDirty
                ? "Save your changes before publishing to eBay."
                : "Opens eBay connection and publish review"
        )
        .accessibilityFocused($focusedElement, equals: .ebayPublish)
        .accessibilityIdentifier("listing-review.ebay-publish")
    }

    private var footer: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(spacing: 10) {
                    secondaryButton
                    doneButton
                }
            } else {
                HStack(spacing: 12) {
                    secondaryButton
                    doneButton
                }
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
        .padding(.bottom, SnapListMetrics.dockHeight + SnapListMetrics.dockBottomInset)
        .background(SnapListColorToken.canvas.color)
        .overlay(alignment: .top) {
            Divider()
        }
    }

    @ViewBuilder
    private func destinationView(
        _ destination: ListingReviewDestination
    ) -> some View {
        switch destination {
        case .title:
            ListingReviewEditorView(store: store, field: .title)
        case .description:
            ListingReviewEditorView(store: store, field: .description)
        case .condition:
            ListingReviewConditionEditorView(store: store)
        case .specifics:
            ItemSpecificsEditorView(
                store: store,
                correctionAvailable: correctionAvailable
            )
        case .sold(let index):
            if let matches = store.snapshot?.verifiedSoldMatches,
               matches.indices.contains(index) {
                SoldMatchDetailView(match: matches[index])
            }
        case .correction:
            ListingReviewCorrectionBoundaryView()
        case .ebayPublish:
            if let snapshot = store.snapshot,
               let draft = store.draft,
               !store.isDirty {
                EbayPublishJourneyHost(
                    listingID: snapshot.binding.listingID,
                    listingTitle: draft.title,
                    coverPhotoURL: snapshot.photos.first?.url,
                    dependencies: dependencies,
                    forceReducedMotion: forceReducedMotion,
                    backToListing: { self.destination = nil },
                    goToTrophyWall: goToTrophyWall,
                    startNewItem: startNewItem
                )
            }
        case .assistedExport:
            if let pack = assistedExportPack,
               let summary = assistedExportSummary {
                AssistedExportHostView(
                    pack: pack,
                    summary: summary,
                    service: dependencies.assistedExportService,
                    funnelAnalytics: dependencies.funnelAnalytics,
                    refreshPack: refreshAssistedExportPack
                )
            }
        }
    }

    private var assistedExportPack: AssistedExportPack? {
        guard let snapshot = store.snapshot,
              let draft = store.draft,
              !store.isDirty else { return nil }
        return AssistedExportPack(
            itemID: snapshot.binding.itemID,
            contentRevision: snapshot.binding.reviewContentRevision,
            reviewRevision: snapshot.binding.reviewRevision,
            title: draft.title,
            description: draft.description,
            effectivePrice: snapshot.pricing.effectivePrice,
            photoReferences: snapshot.photos.sorted { $0.ordinal < $1.ordinal }
                .map(\.url)
        )
    }

    private var assistedExportSummary: AssistedExportItemSummary? {
        guard let snapshot = store.snapshot,
              let draft = store.draft,
              let price = store.effectivePrice else { return nil }
        return AssistedExportItemSummary(
            title: draft.title,
            priceText: ListingReviewCurrency.string(price, locale: locale),
            preparedAtText: Self.preparedAtText(snapshot.evidenceAsOf)
        )
    }

    private func refreshAssistedExportPack() async -> AssistedExportPack? {
        // Reuse the existing Listing Review projection. It carries both the
        // current full review revision and the content-scoped export revision,
        // so this adds no endpoint or mutation surface.
        await store.requestReload()
        guard store.phase == .ready else { return nil }
        return assistedExportPack
    }

    private static func preparedAtText(_ value: String) -> String {
        let input = ISO8601DateFormatter()
        input.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = input.date(from: value) else { return "now" }
        return date.formatted(date: .omitted, time: .shortened)
    }

    private var secondaryButton: some View {
        Button {
            if correctionAvailable {
                ListingReviewAnnouncement.post(
                    "Opened guided correction. Your photos and edits are kept.",
                    assertive: false
                )
                returnFocus = .secondary
                destination = .correction
            } else {
                ListingReviewAnnouncement.post(
                    "Edit any detail below.",
                    assertive: false
                )
                focusedElement = .title
            }
        } label: {
            Label(
                correctionAvailable
                    ? ListingReviewCopy.fixItem
                    : ListingReviewCopy.editDetails,
                systemImage: correctionAvailable
                    ? "sparkles"
                    : "pencil"
            )
            .font(.headline)
            .foregroundStyle(SnapListColorToken.inkPrimary.color)
            .frame(maxWidth: .infinity)
            .frame(minHeight: 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay {
            RoundedRectangle(cornerRadius: 15)
                .stroke(Color(hex: "#D3D6DB"))
        }
        .accessibilityHint(
            correctionAvailable
                ? "Opens guided correction"
                : "Focuses Title"
        )
        .accessibilityFocused($focusedElement, equals: .secondary)
        .accessibilityIdentifier("listing-review.secondary")
    }

    private var doneButton: some View {
        Button {
            Task { _ = await finish(retry: false) }
        } label: {
            HStack(spacing: 8) {
                if store.phase == .saving {
                    if reduceMotion {
                        Image(systemName: "hourglass")
                            .accessibilityHidden(true)
                    } else {
                        ProgressView()
                            .tint(.white)
                            .accessibilityHidden(true)
                    }
                }
                Text(
                    store.phase == .saving
                        ? "Saving…"
                        : ListingReviewCopy.done
                )
                .font(.headline)
            }
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .frame(minHeight: 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(SnapListColorToken.action.color)
        .clipShape(RoundedRectangle(cornerRadius: 15))
        .disabled(store.phase == .saving)
        .accessibilityLabel(
            store.phase == .saving
                ? "Saving, please wait"
                : ListingReviewCopy.done
        )
        .accessibilityFocused($focusedElement, equals: .done)
        .accessibilityIdentifier("listing-review.done")
    }

    private func finish(retry: Bool) async -> ListingReviewDoneOutcome {
        if priceEditing {
            guard await commitPrice() else { return .stayed }
        }
        let outcome = retry
            ? await store.retrySave()
            : await store.done()
        switch outcome {
        case .dismissedWithoutWrite, .saved:
            dismissReview()
        case .stayed:
            break
        }
        return outcome
    }

    @discardableResult
    private func commitPrice() async -> Bool {
        let trimmed = priceText.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            await store.setSellerPriceOverride(nil)
            priceInvalid = false
            priceEditing = false
            focusedElement = .price
            return true
        }
        let amount = ListingReviewCurrency.decimal(
            from: trimmed,
            locale: locale
        )
        guard ListingReviewCurrency.isValid(amount) else {
            priceInvalid = true
            ListingReviewAnnouncement.post(
                ListingReviewCopy.invalidPrice,
                assertive: true
            )
            return false
        }
        await store.setSellerPriceOverride(amount)
        priceText = ListingReviewCurrency.string(
            amount!,
            locale: locale
        )
        priceInvalid = false
        priceEditing = false
        focusedElement = .price
        return true
    }

    private func phaseBinding(
        _ phase: ListingReviewPhase
    ) -> Binding<Bool> {
        Binding(
            get: { store.phase == phase },
            set: { presented in
                if !presented, store.phase == phase {
                    store.keepEditing()
                }
            }
        )
    }

    private func specificsSummary(
        _ specifics: [ListingReviewSpecific]
    ) -> String {
        guard !specifics.isEmpty else { return "No item specifics" }
        let visible = specifics.prefix(3).map(\.value)
        let remainder = max(specifics.count - visible.count, 0)
        return visible.joined(separator: " · ")
            + (remainder > 0 ? " · +\(remainder) more" : "")
    }
}
