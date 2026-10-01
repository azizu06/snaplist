import SwiftUI

private enum ListingReviewDestination: Identifiable, Hashable {
    case specifics
    case correction
    case ebayPublish

    var id: String {
        switch self {
        case .specifics: "specifics"
        case .correction: "correction"
        case .ebayPublish: "ebay-publish"
        }
    }
}

private struct OwnEbayPostingLookup: Equatable {
    let listingID: UUID?
    let reviewIsFrontmost: Bool
}

private struct ListingReviewSharingPresentation: Identifiable {
    let pack: AssistedExportPack
    let summary: AssistedExportItemSummary
    var id: UUID { pack.itemID }
}

/// The fields the seller types into directly on this screen.
private enum ListingReviewInlineFocus: Hashable {
    case price
    case title
    case description
    case type
}

@MainActor
struct ListingReviewView: View {
    @Bindable var store: ListingReviewStore
    let correctionAvailability: ListingReviewCorrectionAvailability
    let forceReducedMotion: Bool
    let dismissReview: () -> Void
    let goToTrophyWall: () -> Void
    let startNewItem: () -> Void
    var activationInteraction: () -> Void = {}

    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.locale) private var locale
    @Environment(\.openURL) private var openURL
    @Environment(\.appDependencies) private var dependencies
    @Environment(\.scenePhase) private var scenePhase
    @State private var destination: ListingReviewDestination?
    @State private var typeCorrectionPresented = false
    @State private var sharingPresentation: ListingReviewSharingPresentation?
    @State private var returnFocus: ListingReviewFocus = .back
    @State private var hasAppeared = false
    @State private var priceText = ""
    @State private var priceInvalid = false
    // The seller's own live eBay posting, once eBay has confirmed it. Nil
    // until then, and for every draft, so the row stays Publish to eBay.
    @State private var ownEbayPostingURL: URL?
    // Owned here rather than by the fields, because Item specifics is pushed
    // and its fields would otherwise take their pending text down with them.
    @State private var inlineEdits = ListingReviewInlineEdits()
    // The price is a SwiftUI control and keeps SwiftUI's focus system. Title
    // and Description are `UITextView`s behind a representable since #918, and
    // SwiftUI's focus system cannot move a responder it does not own — writing
    // a `@FocusState` value nothing claims makes it resign whatever is
    // editing. They get ordinary state, and UIKit's one-first-responder rule
    // keeps the two channels from both believing they hold focus.
    @FocusState private var focusedField: ListingReviewInlineFocus?
    @State private var inlineFocus: ListingReviewInlineFocus?
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
                    // Leaving is not discarding. Whatever is sitting in a
                    // field goes to the draft, then autosave flushes that
                    // draft to the server, before the screen goes away.
                    Task {
                        await inlineEdits.flush(into: store)
                        await commitPrice()
                        await store.flushPendingAutosave()
                        dismissReview()
                    }
                } label: {
                    // The minimum target has to sit inside the button's own
                    // label to reach its hit rect. Wrapped around a
                    // `ToolbarItem`'s button it does nothing at all: measured
                    // here at 16.0 x 22.67, the bare chevron, which is what
                    // that modifier was worth (#928, same rule and the same
                    // four-arrangement measurement as #926/#929). This button
                    // already carries `.buttonStyle(.plain)` below, so moving
                    // the frame is the whole fix — 44.0 x 44.0 after.
                    Label("Back", systemImage: "chevron.left")
                        .frame(
                            minWidth: SnapListMetrics.minimumTouchTarget,
                            minHeight: SnapListMetrics.minimumTouchTarget
                        )
                        .contentShape(.rect)
                }
                .accessibilityLabel("Back to To list")
                .accessibilityFocused($focusedElement, equals: .back)
                .accessibilityIdentifier("listing-review.back")
                .buttonStyle(.plain)
            }
        }
        .navigationDestination(isPresented: $typeCorrectionPresented) {
            ListingReviewCorrectionBoundaryView()
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
        .sheet(item: $sharingPresentation, onDismiss: {
            focusedElement = .assistedExport
        }) { presentation in
            sharingDrawer(presentation)
        }
        .onAppear {
            if hasAppeared {
                focusedElement = returnFocus
            } else {
                hasAppeared = true
                focusedElement = .back
                priceText = displayedPrice
            }
        }
        .onChange(of: displayedPrice) { _, updated in
            guard focusedField != .price else { return }
            priceText = updated
        }
        .onChange(of: focusedField) { previous, current in
            reactToFocusChange(previous: previous, current: current)
        }
        .onChange(of: inlineFocus) { previous, current in
            reactToFocusChange(previous: previous, current: current)
        }
        // Re-read on return from the publish journey too, so a listing the
        // seller just posted offers its eBay page without reopening review.
        .task(id: OwnEbayPostingLookup(
            listingID: store.snapshot?.binding.listingID,
            reviewIsFrontmost: destination == nil
        )) {
            guard let listingID = store.snapshot?.binding.listingID,
                  destination == nil else { return }
            let resolved = await EbayOwnListingDestination.resolve(
                listingID: listingID,
                service: dependencies.ebayPublishService
            )
            guard !Task.isCancelled else { return }
            ownEbayPostingURL = resolved
        }
        .onChange(of: destination?.id) { previous, current in
            guard previous != nil, current == nil else { return }
            focusedElement = returnFocus
        }
        .onChange(of: scenePhase) { _, phase in
            // Backgrounding is a form of leaving the screen too: whatever is
            // sitting in a field must reach the server before iOS can
            // suspend or terminate the process out from under it.
            guard phase == .background else { return }
            Task {
                await inlineEdits.flush(into: store)
                await commitPrice()
                await store.flushPendingAutosave()
            }
        }
        .onChange(of: store.announcement) { _, announcement in
            let assertive = store.phase == .failed
                || store.phase == .refused
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
        ScrollViewReader { proxy in
            ScrollView {
                // Four bounded children, not a feed. A lazy stack would leave the
                // ones below the fold out of the accessibility tree until the
                // seller scrolls them into view, which at the largest Dynamic Type
                // sizes is most of the review — including the title control that
                // Voice Control and the rotor need to be able to name.
                VStack(alignment: .leading, spacing: 0) {
                    ListingReviewPhotoPager(photos: snapshot.photos)

                    VStack(alignment: .leading, spacing: 18) {
                        stateBanner

                        identityAndPricing(snapshot: snapshot, draft: draft)

                        details(snapshot: snapshot, draft: draft)

                        if let ownEbayPostingURL {
                            viewOnEbayEntry(ownEbayPostingURL)
                        } else {
                            ebayPublishEntry
                        }

                        assistedExportEntry
                    }
                    .padding(.horizontal, 18)
                    .padding(.top, 14)
                    .padding(.bottom, 20)
                }
                .padding(.top, 9)
            }
            .onChange(of: focusedField) { _, current in
                if let current { proxy.scrollTo(current, anchor: .top) }
            }
            .onChange(of: inlineFocus) { _, current in
                if let current { proxy.scrollTo(current, anchor: .top) }
            }
            .onReceive(NotificationCenter.default.publisher(
                for: UIResponder.keyboardDidShowNotification
            )) { _ in
                // The keyboard and root dock change the viewport after focus.
                // Position the actual editor again once that layout settles.
                if let editing = focusedField ?? inlineFocus {
                    proxy.scrollTo(editing, anchor: .top)
                }
            }
        }
        // #1056. ACT-04's line names every field rather than one control, so
        // the editable body is the spotlight's hole: the back button and the
        // dock stay behind the scrim, the fields stay usable.
        .activationSpotlightTarget(.listingReviewForm)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if focusedField == nil && inlineFocus == nil {
                footer
                    .background(SnapListColorToken.canvas.color)
            } else {
                editingDoneBar
            }
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
        } else if store.phase == .refused {
            // #951. No retry button: the server refused this save for good and
            // the sentence it sent is the remedy. Done stays live because the
            // remedy can be an edit the seller makes right here -- undoing the
            // condition change that asked for the reprice -- and that is a
            // different save, not a repeat of the refused one.
            ListingReviewStatusBanner(
                text: store.announcement,
                systemImage: "exclamationmark.triangle"
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
            Text(snapshot.identity.label)
                .font(.title2.weight(.semibold))
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityAddTraits(.isHeader)

            price(snapshot: snapshot, draft: draft)
                .id(ListingReviewInlineFocus.price)
                .padding(.top, 12)

            if !snapshot.verifiedSoldMatches.isEmpty {
                Divider()
                    .padding(.top, 18)
                soldMatches(snapshot.verifiedSoldMatches)
                    .padding(.top, 14)
                    .padding(.horizontal, -18)
            }
        }
        .accessibilityElement(children: .contain)
    }

    private func price(
        snapshot: ListingReviewResult,
        draft: ListingReviewDraft
    ) -> some View {
        // #896 dropped the "Starting price estimate" line that used to open
        // this stack: it cost a full line to say what the formatted number
        // under it already said. `ListingReviewCopy.startingPriceEstimate`
        // survives the deletion because the read contract still carries
        // `startingPriceCopy` and `ListingReviewResult`'s decoder still checks
        // the wire value against that exact string.
        VStack(alignment: .leading, spacing: 6) {
            // The box is the affordance now. The pencil it replaces was a
            // 12pt glyph next to the number, which is not a touch target.
            priceField(snapshot: snapshot, draft: draft)
                .accessibilityFocused($focusedElement, equals: .price)

            if priceInvalid {
                Text(ListingReviewCopy.invalidPrice)
                    .font(.callout)
                    .foregroundStyle(
                        ListingReviewPriceStyle.invalidMessage.color
                    )
                    .accessibilityIdentifier("listing-review.price.error")
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

    private var displayedPrice: String {
        guard let price = store.effectivePrice
            ?? store.snapshot?.pricing.effectivePrice else { return "" }
        return ListingReviewCurrency.string(price, locale: locale)
    }

    private func priceField(
        snapshot: ListingReviewResult,
        draft: ListingReviewDraft
    ) -> some View {
        let pending = draft.sellerPriceOverride != snapshot.pricing.sellerPriceOverride
        return ListingReviewInlineField(
            label: "Price",
            pending: pending,
            centeredPrice: true
        ) {
            // #1060: the issue names ListingReviewComponents.swift for this
            // control, but the editable price field itself lives here — a
            // small correction recorded in the PR body rather than a
            // relocation. `ListingReviewPriceValueText` isolates the
            // digit-rolling styling so it stays reflectable the same way
            // `PhotoReviewCountPill` and `ListingReviewSoldCard` are.
            ListingReviewPriceValueText(priceText: $priceText)
                .focused($focusedField, equals: .price)
                .keyboardType(.decimalPad)
                .multilineTextAlignment(.leading)
                .textFieldStyle(.plain)
                // #989: the box now spans the row like Title/Description, so
                // the field stretches with it instead of hugging its content.
                // Fixing only the vertical axis keeps the box from taking
                // more height than one line needs — that unclaimed room read
                // as the value floating in an oversized box.
                .fixedSize(horizontal: false, vertical: true)
                // The retired price button carried this floor and the
                // replacement field did not, which no compiler and no
                // identifier grep would have caught.
                .frame(
                    maxWidth: .infinity,
                    minHeight: SnapListMetrics.minimumTouchTarget,
                    alignment: .leading
                )
                .contentShape(Rectangle())
                .accessibilityLabel(
                    draft.sellerPriceOverride == nil
                        ? "Suggested price"
                        : "Your price"
                )
                .accessibilityValue(
                    priceText + (pending ? ", edited, not saved yet" : "")
                )
                .accessibilityIdentifier("listing-review.price")
        }
        .overlay {
            if priceInvalid {
                RoundedRectangle(cornerRadius: 12)
                    .stroke(SnapListColorToken.priceErrorBorder.color)
            }
        }
        // The field's own hit area is the glyphs; this makes the rest of the
        // box focus it too, which is the point of drawing the box. It sits
        // behind the field rather than over it, so a tap on the number still
        // reaches the field and puts the caret under the finger.
        .background {
            Color.clear
                .contentShape(Rectangle())
                .onTapGesture { focusedField = .price }
        }
    }

    private func soldMatches(
        _ matches: [ListingReviewSoldMatch]
    ) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("VERIFIED SOLD MATCHES")
                .font(.caption2.weight(.bold))
                .tracking(0.5)
                .foregroundStyle(SnapListColorToken.textTertiary.color)
                .padding(.horizontal, 18)

            Text(ListingReviewSoldSummary.text(for: matches, locale: locale))
                .font(.caption)
                .foregroundStyle(SnapListColorToken.textSecondary.color)
                .padding(.horizontal, 18)
                .padding(.top, 3)

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
                            activationInteraction()
                            if let url = match.ebayListingURL { openURL(url) }
                        }
                        .accessibilityFocused(
                            $focusedElement,
                            equals: .soldMatch(index)
                        )
                    }
                }
                .scrollTargetLayout()
            }
            .accessibilityIdentifier("listing-review.sold-matches")
            .contentMargins(.horizontal, 18, for: .scrollContent)
            .scrollTargetBehavior(.viewAligned)
            .padding(.top, 10)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(
            "Verified sold matches, \(matches.count) \(matches.count == 1 ? "sold item" : "sold items")"
        )
    }

    /// One reaction for both focus channels, because losing focus means the
    /// same thing whichever control held it.
    private func reactToFocusChange(
        previous: ListingReviewInlineFocus?,
        current: ListingReviewInlineFocus?
    ) {
        // Typing into any of these fields is a real interaction, and the
        // fields are reached by focus rather than by a button now, so the
        // activation hook has to hang off focus instead.
        if current != nil { activationInteraction() }
        // Losing focus is the ordinary commit point for every field, so the
        // draft stays off the keystroke path. Done and Back run the same
        // flush, so nothing depends on this having fired first.
        guard previous != nil else { return }
        Task {
            await inlineEdits.flush(into: store)
            if previous == .price { await commitPrice() }
        }
    }

    private func details(
        snapshot: ListingReviewResult,
        draft: ListingReviewDraft
    ) -> some View {
        // Bordered boxes rather than pushed rows. The card keeps its shape so
        // the group still reads as one block, but it drops its own outline:
        // a border around a stack of bordered fields is two frames deep.
        VStack(alignment: .leading, spacing: 12) {
            Text("LISTING DETAILS")
                .font(.caption2.weight(.bold))
                .tracking(0.5)
                .foregroundStyle(SnapListColorToken.textTertiary.color)
                .padding(.top, 4)

            ListingReviewInlineTextField(
                label: "Title",
                value: draft.title,
                pending: draft.title != snapshot.listing.title,
                identifier: "listing-review.title",
                field: .title,
                edits: inlineEdits,
                focusValue: ListingReviewInlineFocus.title,
                focus: $inlineFocus,
                lineLimit: 1...3
            )
            .id(ListingReviewInlineFocus.title)
            .accessibilityFocused($focusedElement, equals: .title)

            ListingReviewInlineTextField(
                label: "Description",
                value: draft.description,
                pending: draft.description != snapshot.listing.description,
                identifier: "listing-review.description",
                field: .description,
                edits: inlineEdits,
                focusValue: ListingReviewInlineFocus.description,
                focus: $inlineFocus,
                lineLimit: 1...10
            )
            .id(ListingReviewInlineFocus.description)
            .accessibilityFocused($focusedElement, equals: .description)

            Menu {
                ForEach(ListingReviewCondition.allCases, id: \.self) { condition in
                    Button {
                        activationInteraction()
                        focusedField = nil
                        inlineFocus = nil
                        Task {
                            await inlineEdits.flush(into: store)
                            await commitPrice()
                            await store.setCondition(condition)
                        }
                    } label: {
                        if draft.condition == condition {
                            Label(condition.sellerLabel, systemImage: "checkmark")
                        } else {
                            Text(condition.sellerLabel)
                        }
                    }
                    .accessibilityIdentifier("listing-review.condition.\(condition.rawValue)")
                }
            } label: {
                ListingReviewInlineField(
                    label: "Condition",
                    pending: draft.condition != snapshot.listing.condition
                ) {
                    HStack {
                        Text(draft.condition.sellerLabel)
                        Spacer()
                        Image(systemName: "chevron.up.chevron.down")
                            .foregroundStyle(SnapListColorToken.textSecondary.color)
                    }
                }
            }
            .foregroundStyle(SnapListColorToken.inkPrimary.color)
            .accessibilityLabel("Condition")
            .accessibilityValue(draft.condition.sellerLabel)
            .accessibilityIdentifier("listing-review.condition")
            .accessibilityFocused($focusedElement, equals: .condition)

            if let type = draft.specifics.first(where: {
                $0.name.trimmingCharacters(in: .whitespacesAndNewlines)
                    .caseInsensitiveCompare("Type") == .orderedSame
            }) {
                inlineType(type, snapshot: snapshot)
                    .id(ListingReviewInlineFocus.type)
            }

            ListingReviewChoiceField(
                label: "Item specifics",
                value: specificsSummary(draft.specifics),
                identifier: "listing-review.specifics",
                hint: "Edit",
                accessory: .push,
                pending: draft.specifics != snapshot.listing.specifics
            ) {
                activationInteraction()
                returnFocus = .specifics
                Task {
                    await inlineEdits.flush(into: store)
                    await commitPrice()
                    await store.flushPendingAutosave()
                    destination = .specifics
                }
            }
            .accessibilityFocused($focusedElement, equals: .specifics)
        }
    }

    @ViewBuilder
    private func inlineType(
        _ type: ListingReviewSpecific, snapshot: ListingReviewResult
    ) -> some View {
        let pending = snapshot.listing.specifics.first(where: {
            $0.name == type.name
        })?.value != type.value
        switch ListingReviewSpecificEditing.mode(
            forSpecificNamed: type.name,
            correctionAvailability: correctionAvailability
        ) {
        case .inPlace:
            ListingReviewInlineTextField(
                label: type.name, value: type.value, pending: pending,
                identifier: "listing-review.specific.type",
                field: .fallbackIdentitySpecific(type.name),
                edits: inlineEdits,
                focusValue: ListingReviewInlineFocus.type,
                focus: $inlineFocus, lineLimit: 1...3
            )
        case .guidedCorrection, .spent:
            Menu {
                Section {
                    Button("Continue to guided correction") {
                        Task {
                            await inlineEdits.flush(into: store)
                            await commitPrice()
                            await store.flushPendingAutosave()
                            typeCorrectionPresented = true
                        }
                    }
                } header: {
                    Text(ListingReviewCopy.identityRerunWarning)
                    Text(ListingReviewCopy.identityCorrectionCost)
                }
            } label: {
                ListingReviewInlineField(label: type.name, pending: pending) {
                    HStack {
                        Text(type.value)
                        Spacer()
                        Image(systemName: "chevron.up.chevron.down")
                    }
                }
            }
            .foregroundStyle(SnapListColorToken.inkPrimary.color)
            .disabled(correctionAvailability == .spent)
            .accessibilityLabel(type.name)
            .accessibilityValue(type.value)
            .accessibilityHint(correctionAvailability == .offered
                ? "Opens guided correction" : "Guided correction unavailable")
            .accessibilityIdentifier("listing-review.specific.type")
        }
    }

    /// The editing-state Done. A `.keyboard` toolbar item rendered as a bare
    /// word floating in a corner whenever the software keyboard was absent
    /// (hardware keyboard, simulator). This bar sits in the bottom inset, so
    /// it rides above the keyboard when there is one and stays put when there
    /// is not, in the same filled style as the footer's Done. It only ends
    /// editing; the footer's Done is what saves and leaves.
    private var editingDoneBar: some View {
        Button {
            focusedField = nil
            inlineFocus = nil
        } label: {
            Text("Done")
                .font(.headline)
                .foregroundStyle(SnapListColorToken.onDarkSurface.color)
                .frame(maxWidth: .infinity)
                .frame(minHeight: 52)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(SnapListColorToken.action.color)
        .clipShape(RoundedRectangle(cornerRadius: 15))
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
        .background(SnapListColorToken.canvas.color)
        .overlay(alignment: .top) {
            Divider()
        }
        .accessibilityLabel("Done editing, keeps it on this phone")
        .accessibilityIdentifier("listing-review.keyboard-done")
    }

    private var assistedExportEntry: some View {
        Button {
            // A tap here does not resign a focused field, so what was typed is
            // still uncommitted and `isDirty` would answer against the pre-edit
            // draft. Two things hold typed text, not one: the holder owns
            // title/description/specifics and `priceText` owns the price, so
            // this runs the same pair Done and Back run, in their order, before
            // the guard reads. `commitPrice` announces its own invalid-price
            // refusal, so a false returns without posting a second one. If
            // settling is what makes the screen dirty, this takes the
            // already-dirty path.
            Task {
                await inlineEdits.flush(into: store)
                guard await commitPrice() else { return }
                await store.flushPendingAutosave()
                guard !store.isDirty else {
                    ListingReviewAnnouncement.post(
                        AssistedExportCopy.saveBeforeSharing,
                        assertive: true
                    )
                    return
                }
                returnFocus = .assistedExport
                guard let pack = assistedExportPack,
                      let summary = assistedExportSummary else { return }
                focusedField = nil
                inlineFocus = nil
                sharingPresentation = ListingReviewSharingPresentation(
                    pack: pack, summary: summary
                )
            }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "square.and.arrow.up")
                    .font(.headline)
                    .foregroundStyle(SnapListColorToken.action.color)
                    .accessibilityHidden(true)
                Text(AssistedExportCopy.entryTitle)
                    .font(.headline)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                Spacer(minLength: 0)
                Image(systemName: "chevron.up")
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

    /// Replaces Publish to eBay once eBay confirmed this listing, because the
    /// seller's next move on a live posting is to look at it, not post again.
    private func viewOnEbayEntry(_ url: URL) -> some View {
        Button {
            openURL(url)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "shippingbox")
                    .font(.headline)
                    .foregroundStyle(SnapListColorToken.action.color)
                    .accessibilityHidden(true)
                Text("View on eBay")
                    .font(.headline)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                Spacer(minLength: 0)
                Image(systemName: "arrow.up.right")
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
        .accessibilityHint("Opens your published listing on eBay")
        .accessibilityFocused($focusedElement, equals: .ebayPublish)
        .accessibilityIdentifier("listing-review.view-on-ebay")
    }

    private var ebayPublishEntry: some View {
        Button {
            // Same as the sharing row above, and this one reaches a real
            // marketplace: without settling both holders the guard passed on a
            // stale `isDirty` and eBay was handed the pre-edit draft as a value
            // copy — including a price the seller had typed but not committed.
            Task {
                await inlineEdits.flush(into: store)
                guard await commitPrice() else { return }
                await store.flushPendingAutosave()
                guard !store.isDirty else {
                    ListingReviewAnnouncement.post(
                        "Couldn’t save your changes. Check your connection and try again.",
                        assertive: true
                    )
                    return
                }
                returnFocus = .ebayPublish
                destination = .ebayPublish
            }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "shippingbox")
                    .font(.headline)
                    .foregroundStyle(SnapListColorToken.action.color)
                    .accessibilityHidden(true)
                // #896: same as the sharing row above — the screen behind this
                // one explains the connect-and-post sequence in full.
                Text("Publish to eBay")
                    .font(.headline)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
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
                ? "Couldn’t save your changes. Check your connection and try again."
                : "Opens eBay connection and publish review"
        )
        .accessibilityFocused($focusedElement, equals: .ebayPublish)
        .accessibilityIdentifier("listing-review.ebay-publish")
    }

    private var footer: some View {
        Group {
            // #989: editing every field is already inline-editing-and-saving,
            // so Edit details added a second control for a save Done already
            // did. Fix item stays — it opens guided correction, a materially
            // different action from typing in place — but without it Done is
            // the only thing left for the footer to offer.
            if correctionAvailability == .offered {
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
            } else {
                doneButton
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
        .padding(.bottom, 8)
        .background(SnapListColorToken.canvas.color)
        .overlay(alignment: .top) {
            Divider()
        }
        .offset(y: 8)
    }

    @ViewBuilder
    private func destinationView(
        _ destination: ListingReviewDestination
    ) -> some View {
        switch destination {
        case .specifics:
            ItemSpecificsEditorView(
                store: store,
                correctionAvailability: correctionAvailability,
                inlineEdits: inlineEdits
            )
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
                    listingSnapshot: snapshot,
                    listingDraft: draft,
                    listingIsDirty: store.isDirty,
                    dependencies: dependencies,
                    forceReducedMotion: forceReducedMotion,
                    backToListing: { self.destination = nil },
                    goToTrophyWall: goToTrophyWall,
                    startNewItem: startNewItem
                )
            }
        }
    }

    private func sharingDrawer(
        _ presentation: ListingReviewSharingPresentation
    ) -> some View {
        AssistedExportHostView(
            pack: assistedExportPack ?? presentation.pack,
            summary: assistedExportSummary ?? presentation.summary,
            service: dependencies.assistedExportService,
            funnelAnalytics: dependencies.funnelAnalytics,
            refreshPack: refreshAssistedExportPack
        )
        .dynamicTypeSize(dynamicTypeSize)
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

    // #989: only reachable when `correctionAvailability == .offered`, so the footer that
    // builds this never has to choose between Fix item and Edit details —
    // Edit details is gone and Done alone covers everywhere it applied.
    private var secondaryButton: some View {
        Button {
            ListingReviewAnnouncement.post(
                "Opened guided correction. Your photos and edits are kept.",
                assertive: false
            )
            returnFocus = .secondary
            Task {
                await inlineEdits.flush(into: store)
                await commitPrice()
                await store.flushPendingAutosave()
                destination = .correction
            }
        } label: {
            Label {
                Text(ListingReviewCopy.fixItem)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
            } icon: {
                Image(systemName: "sparkles")
                    .foregroundStyle(SnapListColorToken.action.color)
            }
            .font(.headline)
            .frame(maxWidth: .infinity)
            .frame(minHeight: 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // #896: measured in the simulator, this button and Done are already the
        // same width — 407pt against 403pt — so the complaint that Done "takes
        // twice the width" is about weight, not geometry. A hairline outline on
        // the same white as the footer behind it left this reading as empty
        // canvas next to a saturated blue block. A quiet fill gives it a body
        // to be seen against; it keeps the outlined treatment the criterion
        // asks for rather than becoming a second filled button.
        .background(SnapListColorToken.quietFill.color)
        .clipShape(RoundedRectangle(cornerRadius: 15))
        .overlay {
            RoundedRectangle(cornerRadius: 15)
                .stroke(SnapListColorToken.inputBorder.color)
        }
        .accessibilityHint("Opens guided correction")
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
                            .tint(SnapListColorToken.onDarkSurface.color)
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
            .foregroundStyle(SnapListColorToken.onDarkSurface.color)
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
        // Every field is always live now, so Done flushes whatever is in them
        // rather than relying on an editing flag being set, and it waits for
        // the write before reading the draft. Focus is left alone: resigning
        // it here would race this flush against the blur handler's.
        await inlineEdits.flush(into: store)
        guard await commitPrice() else { return .stayed }
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
        // `displayedPrice` is derived from the draft, so an untouched field
        // matches it. Writing anyway would turn the suggested price into a
        // seller override the seller never typed.
        guard priceText != displayedPrice else {
            priceInvalid = false
            return true
        }
        let trimmed = priceText.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            await store.setSellerPriceOverride(nil)
            priceText = displayedPrice
            priceInvalid = false
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

/// Isolated so the digit-rolling transition on the editable price can be
/// proven with a body-reflection test the same way `PhotoReviewCountPill`
/// and `ListingReviewSoldCard` are (#1060).
struct ListingReviewPriceValueText: View {
    @Binding var priceText: String

    var body: some View {
        TextField("Price", text: $priceText)
            .font(.title3.weight(.bold).monospacedDigit())
            .foregroundStyle(SnapListColorToken.inkPrimary.color)
            .contentTransition(.numericText())
    }
}
