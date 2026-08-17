import SwiftUI

enum EbayResultThumbnailSource {
    case authoritative(URL)
    case neutral
#if DEBUG
    case approvedFixtureAsset(String)
#endif
}

enum GuestClaimAccountEntryPresentation {
    case supported
#if DEBUG
    case fixture
#endif
}

@MainActor
struct EbayPublishJourneyHost: View {
    let listingID: UUID
    let listingTitle: String
    let coverPhotoURL: URL?
    let listingSnapshot: ListingReviewResult
    let listingDraft: ListingReviewDraft
    let listingIsDirty: Bool
    let dependencies: AppDependencies
    let forceReducedMotion: Bool
    let backToListing: () -> Void
    let goToTrophyWall: () -> Void
    let startNewItem: () -> Void

    @State private var flowStore: EbayPublishFlowStore
    @State private var claimStore: GuestClaimStore?
    @State private var claimProjection: GuestClaimListingProjection?
    @State private var claimEntryRejected = false
    @State private var authorityResolved = false

    init(
        listingID: UUID,
        listingTitle: String,
        coverPhotoURL: URL?,
        listingSnapshot: ListingReviewResult,
        listingDraft: ListingReviewDraft,
        listingIsDirty: Bool,
        dependencies: AppDependencies,
        forceReducedMotion: Bool,
        backToListing: @escaping () -> Void,
        goToTrophyWall: @escaping () -> Void,
        startNewItem: @escaping () -> Void
    ) {
        self.listingID = listingID
        self.listingTitle = listingTitle
        self.coverPhotoURL = coverPhotoURL
        self.listingSnapshot = listingSnapshot
        self.listingDraft = listingDraft
        self.listingIsDirty = listingIsDirty
        self.dependencies = dependencies
        self.forceReducedMotion = forceReducedMotion
        self.backToListing = backToListing
        self.goToTrophyWall = goToTrophyWall
        self.startNewItem = startNewItem
        _flowStore = State(
            initialValue: EbayPublishFlowStore(
                listingID: listingID,
                service: dependencies.ebayPublishService,
                oauth: AppleEbayOAuthRunner(
                    callbackURL: dependencies.ebayOAuthCallbackURL
                ),
                funnelAnalytics: dependencies.funnelAnalytics
            )
        )
    }

    var body: some View {
        Group {
            if !authorityResolved {
                ProgressView("Checking your saved listing…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if claimEntryRejected {
                GuestClaimEntryRejectedView(backToListing: backToListing)
            } else if let claimStore, let claimProjection {
                GuestClaimView(
                    store: claimStore,
                    sessionSource: dependencies.accountEntrySessionSource,
                    listingProjection: claimProjection,
                    accountEntryPresentation: .supported,
                    forceReducedMotion: forceReducedMotion,
                    backToDraft: backToListing,
                    continueToItem: { _ in backToListing() },
                    startNewItem: startNewItem
                )
            } else {
                EbayPublishView(
                    store: flowStore,
                    forceReducedMotion: forceReducedMotion,
                    listingTitle: listingTitle,
                    resultThumbnailSource: coverPhotoURL.map {
                        .authoritative($0)
                    } ?? .neutral,
                    backToListing: backToListing,
                    goToTrophyWall: goToTrophyWall
                )
            }
        }
        .task(id: listingID) {
            guard !authorityResolved else { return }
            defer { authorityResolved = true }
            let resolution = await GuestClaimEntryResolver(
                authorityStore: dependencies.guestClaimAuthorityStore,
                credentialStore: KeychainGuestRecoveryCredentialStore()
            ).resolve(
                listingID: listingID,
                snapshot: listingSnapshot,
                draft: listingDraft,
                isDirty: listingIsDirty
            )
            guard case .claim(let authority, let projection) = resolution else {
                if resolution == .rejectedAuthority {
                    claimEntryRejected = true
                }
                return
            }
            claimProjection = projection
            let store = GuestClaimStore(
                authority: authority,
                authenticator: dependencies.guestAccountAuthenticator,
                service: dependencies.guestClaimService,
                authorityStore: dependencies.guestClaimAuthorityStore,
                credentialStore: KeychainGuestRecoveryCredentialStore(),
                funnelAnalytics: dependencies.funnelAnalytics,
                authenticatedUserID: ClerkAuthenticationComposition.currentUserID
            )
            claimStore = store
            await store.resumeClaim()
        }
    }
}

@MainActor
struct EbayPublishView: View {
    @Bindable var store: EbayPublishFlowStore
    let forceReducedMotion: Bool
    let listingTitle: String
    let resultThumbnailSource: EbayResultThumbnailSource
    let backToListing: () -> Void
    let goToTrophyWall: () -> Void

    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.openURL) private var openURL
    @State private var showsOutboundDetails = false

    var body: some View {
        Group {
            switch store.screen {
            case .connection(let state): connection(state)
            case .confirmation(let state): confirmation(state)
            case .result(let state): result(state)
            case .account: account
            }
        }
        .background(SnapListColorToken.canvas.color)
        .navigationTitle(usesApprovedConnectVisuals ? "" : navigationTitle)
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(true)
        .toolbar {
            if showsBackButton && usesApprovedConnectVisuals {
                if #available(iOS 26.0, *) {
                    ToolbarItem(placement: .topBarLeading) {
                        approvedConnectBackButton
                    }
                    .sharedBackgroundVisibility(.hidden)
                } else {
                    ToolbarItem(placement: .topBarLeading) {
                        approvedConnectBackButton
                    }
                }
            } else if showsBackButton {
                ToolbarItem(placement: .topBarLeading) {
                    // A minimum target on a toolbar button has to be inside the
                    // button's own label, and the toolbar's own button style has
                    // to be off. Measured on iPhone 17 Pro / iOS 26.5 (#926):
                    // this button wrapped in `.frame(min…: 44)` reported a
                    // 36x36 hit rect, because the toolbar's button style draws
                    // its own 36pt capsule; adding `.buttonStyle(.plain)` while
                    // the frame stayed outside dropped it to 22.67, the bare
                    // chevron, because a frame around a `ToolbarItem`'s button
                    // never reaches that button's hit rect at all. Sizing the
                    // label from inside, with the toolbar style off, is the one
                    // arrangement that actually produces 44x44.
                    Button(action: backToListing) {
                        Label("Back", systemImage: "chevron.left")
                            .frame(
                                minWidth: SnapListMetrics.minimumTouchTarget,
                                minHeight: SnapListMetrics.minimumTouchTarget
                            )
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    // `.buttonStyle(.plain)` drops the toolbar's tint along with
                    // its capsule, so the chevron keeps its accent colour here
                    // rather than turning into body text.
                    .foregroundStyle(.tint)
                    .accessibilityLabel("Back to my listing")
                    .accessibilityIdentifier("ebay-publish.back")
                }
            }
            if usesApprovedConnectVisuals {
                ToolbarItem(placement: .principal) {
                    Text("Connect eBay")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(SnapListColorToken.textSecondary.color)
                }
            }
        }
        .task { await store.load() }
    }

    private var navigationTitle: String {
        switch store.screen {
        case .connection(.connected): "Review before posting"
        case .connection: "Connect eBay"
        case .confirmation: "Review before posting"
        case .result(.publishing): "Posting to eBay"
        case .result(.published): "Posted to eBay"
        case .result(.outcomeNotYetKnown): "Checking with eBay"
        case .result: "Not posted"
        case .account: "eBay account"
        }
    }

    private var showsBackButton: Bool {
        switch store.screen {
        case .result(.published), .result(.outcomeNotYetKnown): false
        default: true
        }
    }

    private var usesApprovedConnectVisuals: Bool {
        if case .connection(.notConnected) = store.screen {
            true
        } else {
            false
        }
    }

    // Same toolbar hit-rect rule as the plain back button above: the minimum
    // target only counts from inside the label (#926).
    private var approvedConnectBackButton: some View {
        Button(action: backToListing) {
            Image(systemName: "chevron.left")
                .font(.system(size: 21, weight: .medium))
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .frame(
                    minWidth: SnapListMetrics.minimumTouchTarget,
                    minHeight: SnapListMetrics.minimumTouchTarget
                )
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .offset(x: -8)
        .accessibilityLabel("Back to my listing")
        .accessibilityIdentifier("ebay-publish.back")
    }

    private var reduceMotion: Bool {
        systemReduceMotion || forceReducedMotion
    }

    private var accountName: String {
        store.connectedUsername ?? "your account"
    }

    private func connection(_ state: EbayConnectionViewState) -> some View {
        let copy = EbayConnectionCopy(state: state)
        return EbayCenteredActionScreen(
            headingFocusTarget: EbayPublishHeadingFocusTarget(
                screen: .connection(state)
            ),
            headline: copy.headline,
            detail: copy.body,
            statements: state == .notConnected ? [
                "SnapList prepares the listing. You confirm before anything posts.",
                "You sign in on eBay’s own page. SnapList never sees your eBay password.",
                "You can remove this connection at any time.",
            ] : [],
            systemImage: state == .notConnected
                ? nil
                : state == .connected ? "checkmark.circle.fill" : "link",
            primary: copy.primary,
            secondary: copy.secondary,
            forceReducedMotion: reduceMotion,
            usesApprovedConnectVisuals: state == .notConnected,
            primaryAction: {
                switch state {
                case .connected: store.reviewBeforePosting()
                default: Task { await store.connect() }
                }
            },
            secondaryAction: {
                switch state {
                case .connecting: store.cancelConnection()
                case .connected: store.manageConnection()
                default: backToListing()
                }
            }
        )
    }

    private func confirmation(
        _ state: EbayConfirmationViewState
    ) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if let banner = confirmationBanner(state) {
                    EbayNoticeCard(
                        title: banner.title,
                        detail: banner.body,
                        caution: true
                    )
                    .accessibilityIdentifier("ebay-publish.confirmation.banner")
                }

                EbayPublishFocusedHeading(
                    text: confirmationHeading(state),
                    target: EbayPublishHeadingFocusTarget(
                        screen: .confirmation(state)
                    )
                )
                    .snapListTypography(.displayTitle)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)

                if let preflight = store.preflight {
                    destinationCard(preflight)
                    fieldsCard(preflight)
                    consent(state)
                }
            }
            .padding(.horizontal, SnapListMetrics.screenGutter)
            .padding(.vertical, 20)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 8) {
                if state == .refreshFailed {
                    SnapListPrimaryButton(
                        title: "Try loading current details",
                        forceReducedMotion: reduceMotion
                    ) { Task { await store.retryPreflight() } }
                } else if state == .missingFields {
                    SnapListPrimaryButton(
                        title: "Finish this listing",
                        forceReducedMotion: reduceMotion,
                        action: backToListing
                    )
                } else if state == .connectionLost {
                    SnapListPrimaryButton(
                        title: "Reconnect eBay",
                        forceReducedMotion: reduceMotion
                    ) { Task { await store.connect() } }
                } else {
                    if state == .ready {
                        EbayConfirmationPrimaryButton(
                            title: "Post to eBay"
                        ) { Task { await store.confirmPublish() } }
                    } else {
                        SnapListPrimaryButton(
                            title: "Post to eBay as \(accountName)",
                            forceReducedMotion: reduceMotion
                        ) { Task { await store.confirmPublish() } }
                    }
                }
            }
            .padding(.horizontal, SnapListMetrics.screenGutter)
            .padding(.vertical, 10)
            .background(SnapListColorToken.canvas.color)
            .overlay(alignment: .top) { Divider() }
        }
    }

    private func destinationCard(
        _ preflight: EbayPublishPreflight
    ) -> some View {
        HStack(spacing: 12) {
            confirmationThumbnail
                .frame(width: 52, height: 52)
                .clipShape(RoundedRectangle(cornerRadius: 12))
            VStack(alignment: .leading, spacing: 3) {
                Text(
                    "\(EbayPublishPresentation.marketplace(preflight.marketplace)), as \(accountName)"
                )
                .snapListTypography(.rowTitle)
                .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .ebayCard()
    }

    @ViewBuilder
    private var confirmationThumbnail: some View {
        switch resultThumbnailSource {
        case .authoritative(let url):
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image
                        .resizable()
                        .scaledToFill()
                        .accessibilityLabel("Listing photo for \(listingTitle)")
                        .accessibilityIdentifier(
                            "ebay-publish.confirmation.listing-thumbnail"
                        )
                case .empty, .failure:
                    neutralConfirmationThumbnail
                @unknown default:
                    neutralConfirmationThumbnail
                }
            }
        case .neutral:
            neutralConfirmationThumbnail
#if DEBUG
        case .approvedFixtureAsset(let name):
            Image(name)
                .resizable()
                .scaledToFill()
                .accessibilityLabel("Listing photo for \(listingTitle)")
                .accessibilityIdentifier(
                    "ebay-publish.confirmation.listing-thumbnail"
                )
#endif
        }
    }

    private var neutralConfirmationThumbnail: some View {
        ZStack {
            SnapListColorToken.quietFill.color
            Image(systemName: "photo")
                .foregroundStyle(SnapListColorToken.textTertiary.color)
        }
        .accessibilityHidden(true)
    }

    private func fieldsCard(_ preflight: EbayPublishPreflight) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("WHAT EBAY RECEIVES")
                .snapListTypography(.metadata)
                .foregroundStyle(SnapListColorToken.textTertiary.color)
                .padding(.bottom, 10)
            EbayValueRow(label: "Title", value: preflight.title)
            Divider()
            EbayValueRow(
                label: "Condition",
                value: EbayPublishPresentation.condition(
                    preflight.ebayCondition
                )
            )
            Divider()
            EbayValueRow(
                label: "Photos",
                value: "\(preflight.photoCount) photos, in this order"
            )
            Divider()
            EbayValueRow(
                label: "Price to list",
                value: EbayPublishCurrency.string(
                    preflight.effectivePrice.amount
                )
            )
            Divider()
            EbayDisclosureRow(
                title: "Item specifics and description",
                summary: nil,
                expanded: $showsOutboundDetails
            ) {
                Text("ITEM SPECIFICS")
                    .snapListTypography(.metadata)
                    .foregroundStyle(SnapListColorToken.textTertiary.color)
                if preflight.itemSpecifics.isEmpty {
                    Text("Not added")
                } else {
                    ForEach(preflight.itemSpecifics.keys.sorted(), id: \.self) { key in
                        EbayValueRow(
                            label: key,
                            value: preflight.itemSpecifics[key]?.joined(separator: ", ") ?? ""
                        )
                    }
                }
                Text("DESCRIPTION")
                    .snapListTypography(.metadata)
                    .foregroundStyle(SnapListColorToken.textTertiary.color)
                    .padding(.top, 24)
                Text(preflight.description)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .textSelection(.enabled)
            }
        }
        .ebayCard()
    }

    @ViewBuilder
    private func consent(_ state: EbayConfirmationViewState) -> some View {
        if state == .missingFields {
            consentText("Nothing is posted from this screen.")
        } else if state == .accountChanged {
            consentText(
                "This posts a live listing to eBay under \(accountName), not \(store.preparedUsername ?? "the previous account")."
            )
        }
    }

    private func consentText(_ text: String) -> some View {
        Text(text)
            .snapListTypography(.status)
            .foregroundStyle(SnapListColorToken.textSecondary.color)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("ebay-publish.confirmation.consent")
    }

    private func result(_ state: EbayResultViewState) -> some View {
        let copy = EbayResultCopy(state: state)
        return EbayResultActionScreen(
            headingFocusTarget: EbayPublishHeadingFocusTarget(
                screen: .result(state)
            ),
            listingTitle: listingTitle,
            thumbnailSource: resultThumbnailSource,
            status: copy.chip,
            statusColor: state == .outcomeNotYetKnown
                ? SnapListColorToken.caution.color
                : state == .published || state == .publishing
                    ? SnapListColorToken.action.color
                    : SnapListColorToken.textTertiary.color,
            headline: copy.headline,
            detail: copy.body,
            note: copy.note,
            primary: copy.primary,
            secondary: copy.secondary,
            forceReducedMotion: reduceMotion,
            primaryAction: {
                switch state {
                case .unavailable: Task { await store.retryPublish() }
                case .ebaySideChanged: Task { await store.checkConnection() }
                default: goToTrophyWall()
                }
            },
            secondaryAction: {
                if state == .published,
                   let url = store.publishedListing?.listingURL {
                    openURL(url)
                } else {
                    goToTrophyWall()
                }
            }
        )
    }

    private var account: some View {
        EbayAccountScreenView(
            connectedUsername: store.connectedUsername,
            disconnect: { await store.disconnect() }
        )
    }

    private func confirmationBanner(
        _ state: EbayConfirmationViewState
    ) -> (title: String, body: String)? {
        switch state {
        case .ready: nil
        case .listingChanged: (
            "This listing changed since you reviewed it",
            "Nothing was sent to eBay. The details below are the current version. Confirm again to post it."
        )
        case .refreshFailed: (
            "Current listing details could not be loaded",
            "Nothing was sent to eBay. Posting stays blocked until SnapList can load and confirm the latest version."
        )
        case .missingFields: (
            "This listing is not ready to post",
            "eBay needs a title before this listing can go up. Add what is missing on the listing, then come back here."
        )
        case .connectionLost: (
            "This connection no longer works",
            "Reconnect to post this listing. Your listing and these details are saved, and you will come back to this screen."
        )
        case .accountChanged: (
            "A different eBay account is connected",
            "This listing was prepared for \(store.preparedUsername ?? "the previous account"). Confirm again to post it to \(accountName) instead."
        )
        }
    }

    private func confirmationHeading(
        _ state: EbayConfirmationViewState
    ) -> String {
        switch state {
        case .refreshFailed: "Current listing details are unavailable."
        case .missingFields: "This listing is not ready to post."
        default: "Post this to eBay?"
        }
    }

}

/// The connected-account screen, extracted so it can be reached from a
/// second entry point (Settings, #865) without duplicating it. The item
/// publish journey (`EbayPublishView.account`) and the Settings-scoped
/// eBay connection screen both instantiate this directly; behavior,
/// copy, and accessibility identifiers are identical from either entry
/// point. `disconnect` is listing-independent on both callers'
/// underlying stores, so this view carries no listing context.
@MainActor
struct EbayAccountScreenView: View {
    let connectedUsername: String?
    let disconnect: () async -> Void

    @State private var showsDisconnectConfirmation = false

    private var accountName: String {
        connectedUsername ?? "your account"
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("Your eBay account")
                    .snapListTypography(.displayTitle)
                    .accessibilityAddTraits(.isHeader)
                EbayNoticeCard(
                    title: "Connected as \(accountName)",
                    detail: "SnapList can post listings to this account.",
                    caution: false
                )
                Text("Payment, shipping and returns are set on your eBay account.")
                    .snapListTypography(.body)
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(SnapListColorToken.actionTint.color)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
                SnapListDestructiveButton(title: "Disconnect eBay account") {
                    showsDisconnectConfirmation = true
                }
                .accessibilityIdentifier("ebay-account.disconnect")
            }
            .padding(SnapListMetrics.screenGutter)
        }
        .accessibilityIdentifier("ebay-publish.account")
        // This exact wording (including the "does not revoke on eBay's
        // side" disclosure) is the one text the issue requires stays
        // verbatim at every entry point (#865).
        .confirmationDialog(
            "Disconnect eBay account \(accountName)?",
            isPresented: $showsDisconnectConfirmation,
            titleVisibility: .visible
        ) {
            Button("Disconnect", role: .destructive) {
                Task { await disconnect() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                "Listings already on eBay stay there and keep selling, but SnapList will not be able to see or change them.\n\nTo review which apps can use your eBay account, open your eBay account settings."
            )
        }
    }
}

@MainActor
struct GuestClaimView: View {
    @Bindable var store: GuestClaimStore
    let sessionSource: any AccountEntrySessionSourcing
    let listingProjection: GuestClaimListingProjection
    let accountEntryPresentation: GuestClaimAccountEntryPresentation
    let forceReducedMotion: Bool
    let backToDraft: () -> Void
    let continueToItem: (ClaimedGuestListing) -> Void
    let startNewItem: () -> Void

    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @State private var email = ""
    @State private var code = ""
    @State private var accountEntryBaseline: AccountEntrySessionSnapshot?
    @State private var presentsAccountEntry = false

    var body: some View {
        content
        .background(SnapListColorToken.canvas.color)
        .navigationTitle(navigationTitle)
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(true)
        .toolbar {
            if showsAuthenticationBack {
                ToolbarItem(placement: .topBarLeading) {
                    // Same toolbar hit-rect rule as `ebay-publish.back` (#926).
                    Button {
                        store.cancelAuthentication()
                    } label: {
                        Label("Back", systemImage: "chevron.left")
                            .frame(
                                minWidth: SnapListMetrics.minimumTouchTarget,
                                minHeight: SnapListMetrics.minimumTouchTarget
                            )
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.tint)
                    .accessibilityLabel(authenticationBackLabel)
                    .accessibilityIdentifier("guest-claim.auth-back")
                }
            }
        }
        .sheet(
            isPresented: $presentsAccountEntry,
            onDismiss: resolveSupportedAuthenticationDismissal
        ) {
            switch accountEntryPresentation {
            case .supported:
                AccountEntryView()
#if DEBUG
            case .fixture:
                GuestClaimFixtureAccountEntryView()
#endif
            }
        }
        .accessibilityIdentifier("guest-claim")
    }

    @ViewBuilder
    private var content: some View {
        switch store.state {
        case .gate:
            gateContent
                .toolbar(.hidden, for: .navigationBar)
        default:
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    stateContent
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, SnapListMetrics.screenGutter)
                .padding(.vertical, 24)
            }
        }
    }

    private var gateContent: some View {
        VStack(spacing: 0) {
            HStack {
                Button(action: backToDraft) {
                    Image(systemName: "xmark")
                        .font(.system(size: 18, weight: .regular))
                        .frame(
                            width: SnapListMetrics.minimumTouchTarget,
                            height: SnapListMetrics.minimumTouchTarget
                        )
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .accessibilityLabel("Close and keep my draft")
                .accessibilityIdentifier("guest-claim.close")
                Spacer(minLength: 0)
            }
            .padding(.leading, 16)
            .frame(height: SnapListMetrics.minimumTouchTarget)

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    claimMessage(
                        headline: "Save this listing to your account",
                        statements: [
                            "Your draft is ready. Sign in, or make an account, and it stays exactly as you left it.",
                        ],
                        footnote: nil
                    )
                    GuestClaimListingCard(projection: listingProjection)
                    Text(
                        "Saved for 24 hours, then deleted. Claiming keeps it in your account beyond 24 hours."
                    )
                    .snapListTypography(.metadata)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 24)
                .padding(.top, 12)
                .padding(.bottom, 24)
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            SnapListPrimaryButton(
                title: "Sign in or create account",
                forceReducedMotion: reduceMotion,
                action: beginSupportedAuthentication
            )
            .padding(.horizontal, 24)
            .padding(.vertical, 12)
            .background(SnapListColorToken.canvas.color)
        }
    }

    @ViewBuilder
    private var stateContent: some View {
        switch store.state {
        case .gate:
            EmptyView()
        case .authenticating:
            ProgressView("Opening secure account entry…")
                .frame(maxWidth: .infinity, alignment: .center)
        case .email:
            claimMessage(
                headline: "Continue with email",
                statements: ["Enter your email and we will send you a 6 digit code."],
                footnote: "No password to remember."
            )
            TextField("Email address", text: $email)
                .textContentType(.emailAddress)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(.horizontal, 14)
                .frame(minHeight: 52)
                .background(SnapListColorToken.quietFill.color)
                .clipShape(RoundedRectangle(cornerRadius: 14))
                .accessibilityIdentifier("guest-claim.email")
            SnapListPrimaryButton(
                title: "Send code",
                forceReducedMotion: reduceMotion
            ) { Task { await store.sendCode(to: email) } }
        case .code(let email), .wrongCode(let email):
            claimMessage(
                headline: "Enter your code",
                statements: ["Sent to \(email)"],
                footnote: "Verify stays unavailable until you change the code."
            )
            if case .wrongCode = store.state {
                Text("That code did not work. Check it and try again.")
                    .foregroundStyle(SnapListColorToken.caution.color)
                    .accessibilityIdentifier("guest-claim.code-error")
            }
            TextField("6 digit code", text: $code)
                .textContentType(.oneTimeCode)
                .keyboardType(.numberPad)
                .multilineTextAlignment(.center)
                .font(.title2.monospacedDigit().weight(.semibold))
                .padding(.horizontal, 14)
                .frame(minHeight: 52)
                .background(SnapListColorToken.quietFill.color)
                .clipShape(RoundedRectangle(cornerRadius: 14))
                .onChange(of: code) { _, value in
                    code = String(value.filter(\.isNumber).prefix(6))
                    if case .wrongCode = store.state { store.retryCode() }
                }
                .accessibilityIdentifier("guest-claim.code")
            SnapListPrimaryButton(
                title: "Verify",
                forceReducedMotion: reduceMotion
            ) { Task { await store.verifyAndClaim(code: code) } }
            .disabled(code.count != 6)
        case .copying:
            claimMessage(
                headline: "Copying your photos into your account",
                statements: [],
                footnote: "Starting the copy again will not create a duplicate.",
                progress: true
            )
        case .leaseExpired:
            retryState(
                headline: "The copy ran out of time",
                statements: ["The hold SnapList had on this draft ran out before the copy finished."],
                primary: "Start the copy again"
            )
        case .copyFailed:
            retryState(
                headline: "SnapList stopped the copy",
                statements: [
                    "One of your photos did not arrive complete, so SnapList stopped rather than save part of your item.",
                    "Your draft is still on this device, exactly as you left it.",
                ],
                primary: "Start the copy again",
                footnote: "Starting again copies your photos fresh. It will not create a duplicate."
            )
        case .busy:
            retryState(
                headline: "This draft is being claimed somewhere else",
                statements: ["Another device or session is copying this draft right now. Only one can run at a time."],
                primary: "Try again",
                footnote: "Your draft is unchanged on this device."
            )
        case .allowanceSpent:
            denialState(
                headline: "This account already used its free AI listing",
                statements: [
                    "Nothing has been uploaded.",
                    "You can claim this draft with a different account, and doing that uses up that account’s free AI listing.",
                ],
                footnote: "Your draft is still on this device for the rest of the 24 hours."
            )
        case .allowanceInFlight:
            retryState(
                headline: "Another item is using this account’s free AI listing",
                statements: [
                    "That item is still going. When it finishes, this account may be free again.",
                    "You can also claim this draft with a different account, and doing that uses up that account’s free AI listing.",
                ],
                primary: "Try again",
                footnote: "Nothing has been uploaded. Your draft stays on this device until the 24 hours are up, and that clock keeps running while you wait."
            )
        case .allowanceSpentAfterCopy:
            claimMessage(
                headline: "This account already used its free AI listing",
                statements: [
                    "SnapList copied your photos before learning that this account’s free AI listing was already used.",
                    "Those copied photos are being cleaned up. This claim stays tied to this account.",
                ],
                footnote: "Your draft is still on this device for the rest of the 24 hours. Nothing was posted to eBay."
            )
            SnapListSecondaryButton(
                title: "Back to my draft",
                action: backToDraft
            )
        case .allowanceInFlightAfterCopy:
            retryState(
                headline: "Another item is using this account’s free AI listing",
                statements: [
                    "SnapList copied your photos before learning that another item is still using this account’s free AI listing.",
                    "Those copied photos are being cleaned up. This claim stays tied to this account.",
                ],
                primary: "Try again",
                footnote: "Try again after the other item finishes. Nothing was posted to eBay."
            )
        case .claimed(let listing):
            claimMessage(
                headline: "This item is in your account",
                statements: ["You can find it in your items."],
                footnote: nil
            )
            SnapListPrimaryButton(
                title: "Back to my item",
                forceReducedMotion: reduceMotion
            ) { continueToItem(listing) }
        case .expired:
            claimMessage(
                headline: "This draft is gone",
                statements: ["The 24 hours ran out before it was claimed. SnapList deleted your photos and the price we found."],
                footnote: "This device no longer holds a copy either. A new item starts from new photos."
            )
            SnapListPrimaryButton(
                title: "Start a new item",
                forceReducedMotion: reduceMotion,
                action: startNewItem
            )
        case .noDraft:
            claimMessage(
                headline: "No draft found",
                statements: [],
                footnote: "Nothing was changed."
            )
            SnapListPrimaryButton(
                title: "Start a new item",
                forceReducedMotion: reduceMotion,
                action: startNewItem
            )
        }
    }

    private var reduceMotion: Bool {
        systemReduceMotion || forceReducedMotion
    }

    private func resolveSupportedAuthenticationDismissal() {
        let source = sessionSource
        let handler = GuestClaimQualifiedSessionHandler(store: store)
        let baseline = accountEntryBaseline
        accountEntryBaseline = nil
        Task {
            let current = await source.snapshot()
            let signal = AccountEntryPresentationTransition.signal(
                baseline: baseline,
                current: current
            )
            let resolver = AccountEntrySessionResolver(
                source: source,
                handler: handler
            )
            let resolution = await resolver.resolve(
                signal,
                snapshot: current
            )
            if resolution == .preserved {
                await MainActor.run {
                    store.cancelSupportedAuthentication()
                }
            }
        }
    }

    private func beginSupportedAuthentication() {
        let source = sessionSource
        let handler = GuestClaimQualifiedSessionHandler(store: store)
        Task {
            let baseline = await source.snapshot()
            accountEntryBaseline = baseline
            guard let policy = await store.beginSupportedAuthentication(),
                  store.state == .authenticating else {
                return
            }
            if policy == .requireDifferentPrincipal {
                presentsAccountEntry = true
                return
            }
            let resolver = AccountEntrySessionResolver(
                source: source,
                handler: handler
            )
            let resolution = await resolver.resolveCurrentSession(
                snapshot: baseline
            )
            if resolution != .continued {
                presentsAccountEntry = true
            }
        }
    }

    private var navigationTitle: String {
        switch store.state {
        case .email: "Continue with email"
        case .code, .wrongCode: "Enter your code"
        default: ""
        }
    }

    private var showsAuthenticationBack: Bool {
        switch store.state {
        case .email, .code, .wrongCode: true
        default: false
        }
    }

    private var authenticationBackLabel: String {
        switch store.state {
        case .email: "Back to the account gate"
        case .code, .wrongCode: "Edit your email address"
        default: "Back"
        }
    }

    private func claimMessage(
        headline: String,
        statements: [String],
        footnote: String?,
        progress: Bool = false
    ) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            if progress && !reduceMotion {
                ProgressView()
                    .tint(SnapListColorToken.action.color)
                    .accessibilityLabel("Copying")
            }
            Text(headline)
                .snapListTypography(.displayTitle)
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("guest-claim.heading")
            ForEach(statements, id: \.self) { statement in
                Text(statement)
                    .snapListTypography(.body)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let footnote {
                Text(footnote)
                    .snapListTypography(.metadata)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func retryState(
        headline: String,
        statements: [String],
        primary: String,
        footnote: String? = nil
    ) -> some View {
        Group {
            claimMessage(
                headline: headline,
                statements: statements,
                footnote: footnote
            )
            SnapListPrimaryButton(
                title: primary,
                forceReducedMotion: reduceMotion
            ) { Task { await store.retryClaim() } }
            SnapListSecondaryButton(
                title: "Back to my draft",
                action: backToDraft
            )
        }
    }

    private func denialState(
        headline: String,
        statements: [String],
        footnote: String
    ) -> some View {
        Group {
            claimMessage(
                headline: headline,
                statements: statements,
                footnote: footnote
            )
            SnapListPrimaryButton(
                title: "Use a different account",
                forceReducedMotion: reduceMotion,
                action: beginSupportedAuthentication
            )
            SnapListSecondaryButton(
                title: "Back to my draft",
                action: backToDraft
            )
        }
    }
}

private struct GuestClaimEntryRejectedView: View {
    let backToListing: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Refresh your listing before continuing")
                .snapListTypography(.displayTitle)
                .accessibilityAddTraits(.isHeader)
            Text(
                "SnapList could not match this saved listing to the exact guest draft on this phone. Nothing was claimed."
            )
            .snapListTypography(.body)
            .foregroundStyle(SnapListColorToken.textSecondary.color)
            SnapListPrimaryButton(
                title: "Back to my listing",
                forceReducedMotion: true,
                action: backToListing
            )
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(SnapListMetrics.screenGutter)
        .background(SnapListColorToken.canvas.color)
        .accessibilityIdentifier("guest-claim.entry-rejected")
    }
}

private struct GuestClaimListingCard: View {
    let projection: GuestClaimListingProjection

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(alignment: .top, spacing: 12) {
                        listingThumbnail
                        listingDetails
                    }
                    expiryLabel
                }
            } else {
                HStack(alignment: .center, spacing: 12) {
                    listingThumbnail
                    listingDetails
                    Spacer(minLength: 4)
                    expiryLabel
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 16)
        .background(SnapListColorToken.canvas.color)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay {
            RoundedRectangle(cornerRadius: 14)
                .stroke(SnapListColorToken.hairline.color, lineWidth: 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("guest-claim.listing")
    }

    private var listingThumbnail: some View {
        thumbnail
            .frame(width: 48, height: 48)
            .clipShape(RoundedRectangle(cornerRadius: 9))
            .accessibilityHidden(true)
    }

    private var listingDetails: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(projection.title)
                .snapListTypography(.rowTitle)
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .fixedSize(horizontal: false, vertical: true)
            Text(
                "Draft · \(EbayPublishCurrency.string(projection.effectivePrice))"
            )
            .snapListTypography(.status)
            .foregroundStyle(SnapListColorToken.textSecondary.color)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var expiryLabel: some View {
        Label(expiryText, systemImage: "clock")
            .snapListTypography(.metadata)
            .foregroundStyle(SnapListColorToken.textSecondary.color)
            .accessibilityLabel(expiryAccessibilityLabel)
    }

    private var expiryText: String {
        "\(expiryHours)h"
    }

    private var expiryHours: Int {
        let remaining = projection.expiresAt.timeIntervalSinceNow / 3_600
        return min(24, max(1, Int(remaining.rounded(.up))))
    }

    private var expiryAccessibilityLabel: String {
        let unit = expiryHours == 1 ? "hour" : "hours"
        return "Saved for \(expiryHours) \(unit)"
    }

    @ViewBuilder
    private var thumbnail: some View {
        switch projection.thumbnail {
        case .authoritative(let url):
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFill()
                case .empty, .failure:
                    neutralThumbnail
                @unknown default:
                    neutralThumbnail
                }
            }
        case .neutral:
            neutralThumbnail
        }
    }

    private var neutralThumbnail: some View {
        ZStack {
            SnapListColorToken.canvas.color
            Image(systemName: "photo")
                .foregroundStyle(SnapListColorToken.textTertiary.color)
        }
    }
}

private actor GuestClaimQualifiedSessionHandler:
    AccountEntryQualifiedSessionHandling {
    private let action: @MainActor @Sendable (
        AccountEntryQualifiedSession
    ) async -> Void

    init(store: GuestClaimStore) {
        action = { session in
            await store.qualifiedSession(session)
        }
    }

    func handle(_ session: AccountEntryQualifiedSession) async {
        await action(session)
    }
}

private struct EbayConnectionCopy {
    let headline: String
    let body: String
    let primary: String?
    let secondary: String?
    let identifier: String

    init(state: EbayConnectionViewState) {
        switch state {
        case .notConnected:
            (headline, body, primary, secondary, identifier) = (
                "Connect your eBay account.",
                "SnapList needs your permission before it can put a listing on eBay for you.",
                "Continue to eBay", nil, "not-connected"
            )
        case .connecting:
            (headline, body, primary, secondary, identifier) = (
                "Finish signing in on eBay.",
                "SnapList is waiting for eBay to confirm. Nothing has been connected yet.",
                nil, "Cancel", "connecting"
            )
        case .connected:
            (headline, body, primary, secondary, identifier) = (
                "Your eBay account is connected.",
                "Your listing is ready to review before it goes to eBay.",
                "Review before posting", "Manage connection", "connected"
            )
        case .reconnectNeeded:
            (headline, body, primary, secondary, identifier) = (
                "This connection no longer works.",
                "Reconnect your eBay account to publish this listing. Your listing is saved and nothing was posted.",
                "Reconnect eBay", "Back to my listing", "reconnect-needed"
            )
        case .declined:
            (headline, body, primary, secondary, identifier) = (
                "You did not grant access.",
                "Your listing is saved and nothing was posted. You can connect later, and the listing stays on your Trophy Wall until you do.",
                "Continue to eBay", "Back to my listing", "declined"
            )
        case .cancelled:
            (headline, body, primary, secondary, identifier) = (
                "The connection was not finished.",
                "Your listing is saved and nothing was sent to eBay. Pick this up whenever you want.",
                "Continue to eBay", "Back to my listing", "cancelled"
            )
        case .timedOut:
            (headline, body, primary, secondary, identifier) = (
                "That sign in took too long.",
                "No account was connected and your listing is saved. Start the sign in again and finish it on eBay’s page.",
                "Continue to eBay", "Back to my listing", "timed-out"
            )
        case .failed:
            (headline, body, primary, secondary, identifier) = (
                "Something went wrong connecting.",
                "Your listing is saved and nothing was posted. This is usually temporary, so try again in a moment.",
                "Continue to eBay", "Back to my listing", "failed"
            )
        }
    }
}

struct EbayPublishHeadingFocusTarget: Hashable {
    let identifier: String
    let isLiveRegion: Bool
    private let transitionIdentity: String

    init(screen: EbayPublishScreen) {
        switch screen {
        case .connection(let state):
            let copy = EbayConnectionCopy(state: state)
            identifier = "ebay-publish.connection.\(copy.identifier)"
            isLiveRegion = false
            transitionIdentity = "connection.\(copy.identifier)"
        case .confirmation(let state):
            identifier = "ebay-publish.confirmation"
            isLiveRegion = false
            transitionIdentity = "confirmation.\(Self.identity(for: state))"
        case .result(let state):
            let copy = EbayResultCopy(state: state)
            identifier = "ebay-publish.result.\(copy.identifier)"
            isLiveRegion = true
            transitionIdentity = "result.\(copy.identifier)"
        case .account:
            identifier = "ebay-publish.account"
            isLiveRegion = false
            transitionIdentity = "account"
        }
    }

    private static func identity(
        for state: EbayConfirmationViewState
    ) -> String {
        switch state {
        case .ready: "ready"
        case .listingChanged: "listing-changed"
        case .refreshFailed: "refresh-failed"
        case .missingFields: "missing-fields"
        case .connectionLost: "connection-lost"
        case .accountChanged: "account-changed"
        }
    }
}

struct EbayPublishFocusedHeading: View {
    let text: String
    let target: EbayPublishHeadingFocusTarget

    var body: some View {
        Text(text)
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier(target.identifier)
            .modifier(EbayPublishHeadingAccessibilityFocus(target: target))
    }
}

struct EbayPublishHeadingFocusBehavior {
    let target: EbayPublishHeadingFocusTarget

    var accessibilityTraits: AccessibilityTraits {
        target.isLiveRegion ? .updatesFrequently : []
    }

    @MainActor
    func requestFocus(_ setFocused: (Bool) -> Void) async {
        await Task.yield()
        setFocused(true)
    }
}

struct EbayPublishHeadingAccessibilityFocus: ViewModifier {
    let target: EbayPublishHeadingFocusTarget
    @AccessibilityFocusState private var isFocused: Bool

    private var behavior: EbayPublishHeadingFocusBehavior {
        EbayPublishHeadingFocusBehavior(target: target)
    }

    func body(content: Content) -> some View {
        content
            .accessibilityAddTraits(behavior.accessibilityTraits)
            .accessibilityFocused($isFocused)
            .onAppear(perform: focusHeading)
            .onChange(of: target) { _, _ in focusHeading() }
    }

    private func focusHeading() {
        let behavior = behavior
        Task { @MainActor in
            await behavior.requestFocus { isFocused = $0 }
        }
    }
}

struct EbayResultCopy {
    let headline: String
    let chip: String
    let body: String
    let note: String?
    let primary: String?
    let secondary: String?
    let identifier: String
    let chipVariant: SnapListChipVariant

    init(state: EbayResultViewState) {
        switch state {
        case .publishing:
            (headline, chip, body, note, primary, secondary, identifier, chipVariant) = (
                "Posting to eBay.", "Posting",
                "This usually takes a few seconds. You can leave this screen and it will keep going.",
                nil, nil, "Go to Trophy Wall", "publishing", .info
            )
        case .published:
            (headline, chip, body, note, primary, secondary, identifier, chipVariant) = (
                "Your listing is live on eBay.", "Live on eBay",
                "Buyers can find it now. eBay handles the listing from here.",
                "Changes made on eBay will not come back to SnapList.",
                "Go to Trophy Wall", "View on eBay", "published", .info
            )
        case .unavailable:
            (headline, chip, body, note, primary, secondary, identifier, chipVariant) = (
                "eBay is not responding.", "Not posted",
                "Your listing was not posted. It is saved and ready to send when eBay is back.",
                nil, "Try again", "Go to Trophy Wall", "unavailable", .neutral
            )
        case .sellerFixableRefusal(let message):
            (headline, chip, body, note, primary, secondary, identifier, chipVariant) = (
                "This listing was not posted.", "Not posted",
                message,
                nil, "Go to Trophy Wall", nil, "seller-fixable-refusal", .neutral
            )
        case .outcomeNotYetKnown:
            (headline, chip, body, note, primary, secondary, identifier, chipVariant) = (
                "SnapList does not know yet whether eBay accepted this listing.",
                "Checking with eBay",
                "The connection dropped at the wrong moment. SnapList will find out and update your Trophy Wall.",
                "There is nothing for you to do, and nothing will be posted twice.",
                "Go to Trophy Wall", nil, "outcome-unknown", .caution
            )
        case .ebaySideChanged:
            (headline, chip, body, note, primary, secondary, identifier, chipVariant) = (
                "Your eBay connection changed.", "Not posted",
                "Nothing was sent to eBay. Your listing is exactly as you left it.",
                nil, "Check eBay connection", "Go to Trophy Wall", "ebay-side-changed", .neutral
            )
        }
    }
}

private struct EbayCenteredActionScreen: View {
    let headingFocusTarget: EbayPublishHeadingFocusTarget
    let headline: String
    let detail: String
    var statements: [String] = []
    var chip: String?
    var chipVariant: SnapListChipVariant = .neutral
    let systemImage: String?
    let primary: String?
    let secondary: String?
    let forceReducedMotion: Bool
    var usesApprovedConnectVisuals = false
    let primaryAction: () -> Void
    let secondaryAction: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if usesApprovedConnectVisuals {
                    Color.clear
                        .frame(height: 164)
                        .accessibilityHidden(true)
                } else {
                    Spacer(minLength: 16)
                }
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.system(size: 36, weight: .semibold))
                        .foregroundStyle(SnapListColorToken.action.color)
                        .accessibilityHidden(true)
                }
                if let chip {
                    SnapListChip(chip, variant: chipVariant)
                }
                EbayPublishFocusedHeading(
                    text: headline,
                    target: headingFocusTarget
                )
                    .snapListTypography(.displayTitle)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .fixedSize(horizontal: false, vertical: true)
                Text(detail)
                    .snapListTypography(.body)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .fixedSize(horizontal: false, vertical: true)
                if !statements.isEmpty {
                    VStack(spacing: 0) {
                        ForEach(Array(statements.enumerated()), id: \.offset) {
                            index, statement in
                            HStack(alignment: .top, spacing: 12) {
                                if usesApprovedConnectVisuals {
                                    Circle()
                                        .fill(SnapListColorToken.ebayAccent.color)
                                        .frame(width: 5, height: 5)
                                        .padding(.top, 6)
                                        .accessibilityHidden(true)
                                } else {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundStyle(
                                            SnapListColorToken.action.color
                                        )
                                        .accessibilityHidden(true)
                                }
                                Text(statement)
                                    .snapListTypography(.status)
                                    .foregroundStyle(
                                        SnapListColorToken.textSecondary.color
                                    )
                                    .fixedSize(
                                        horizontal: false,
                                        vertical: true
                                    )
                                Spacer(minLength: 0)
                            }
                            .padding(
                                .vertical,
                                usesApprovedConnectVisuals ? 10 : 12
                            )
                            if index < statements.count - 1 {
                                Divider()
                            }
                        }
                    }
                    .ebayCard()
                }
                Spacer(minLength: 16)
            }
            .frame(maxWidth: .infinity, minHeight: 440, alignment: .leading)
            .padding(.horizontal, SnapListMetrics.screenGutter)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 8) {
                if let primary {
                    if usesApprovedConnectVisuals {
                        EbayConnectPrimaryButton(
                            title: primary,
                            action: primaryAction
                        )
                    } else {
                        SnapListPrimaryButton(
                            title: primary,
                            forceReducedMotion: forceReducedMotion,
                            action: primaryAction
                        )
                    }
                }
                if let secondary {
                    SnapListSecondaryButton(
                        title: secondary,
                        action: secondaryAction
                    )
                }
            }
            .padding(.horizontal, SnapListMetrics.screenGutter)
            .padding(.top, usesApprovedConnectVisuals ? 8 : 10)
            .padding(.bottom, usesApprovedConnectVisuals ? 0 : 10)
            .background(SnapListColorToken.canvas.color)
            .overlay(alignment: .top) { Divider() }
        }
    }
}

private struct EbayConnectPrimaryButton: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .snapListTypography(.rowTitle)
                .foregroundStyle(SnapListColorToken.onDarkSurface.color)
                .frame(maxWidth: .infinity)
                .frame(minHeight: 52)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .background(SnapListColorToken.ebayAccent.color)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .accessibilityIdentifier("button.primary.continue-to-ebay")
    }
}

private struct EbayConfirmationPrimaryButton: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .snapListTypography(.rowTitle)
                .foregroundStyle(SnapListColorToken.onDarkSurface.color)
                .frame(maxWidth: .infinity)
                .frame(minHeight: 52)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .background(SnapListColorToken.ebayAccent.color)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .accessibilityIdentifier("button.primary.post-to-ebay")
    }
}

private struct EbayResultActionScreen: View {
    let headingFocusTarget: EbayPublishHeadingFocusTarget
    let listingTitle: String
    let thumbnailSource: EbayResultThumbnailSource
    let status: String
    let statusColor: Color
    let headline: String
    let detail: String
    let note: String?
    let primary: String?
    let secondary: String?
    let forceReducedMotion: Bool
    let primaryAction: () -> Void
    let secondaryAction: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Spacer(minLength: 16)
                EbayPublishFocusedHeading(
                    text: headline,
                    target: headingFocusTarget
                )
                    .snapListTypography(.displayTitle)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilitySortPriority(70)

                HStack(spacing: 12) {
                    thumbnail
                        .frame(width: 54, height: 54)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(listingTitle)
                            .snapListTypography(.rowTitle)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilitySortPriority(60)
                        HStack(spacing: 7) {
                            Circle()
                                .fill(statusColor)
                                .frame(width: 7, height: 7)
                                .accessibilityHidden(true)
                            Text(status)
                                .snapListTypography(.status)
                                .foregroundStyle(
                                    SnapListColorToken.textSecondary.color
                                )
                                .accessibilitySortPriority(50)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .ebayCard()

                Text(detail)
                    .snapListTypography(.body)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilitySortPriority(40)
                if let note {
                    Text(note)
                        .snapListTypography(.status)
                        .foregroundStyle(
                            SnapListColorToken.textSecondary.color
                        )
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(SnapListColorToken.quietFill.color)
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                        .accessibilityIdentifier("ebay-publish.result.note")
                        .accessibilitySortPriority(30)
                }
                Spacer(minLength: 16)
            }
            .frame(maxWidth: .infinity, minHeight: 440, alignment: .leading)
            .padding(.horizontal, SnapListMetrics.screenGutter)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 8) {
                if let primary {
                    SnapListPrimaryButton(
                        title: primary,
                        forceReducedMotion: forceReducedMotion,
                        action: primaryAction
                    )
                    .accessibilitySortPriority(20)
                }
                if let secondary {
                    SnapListSecondaryButton(
                        title: secondary,
                        action: secondaryAction
                    )
                    .accessibilitySortPriority(10)
                }
            }
            .padding(.horizontal, SnapListMetrics.screenGutter)
            .padding(.vertical, 10)
            .background(SnapListColorToken.canvas.color)
            .overlay(alignment: .top) { Divider() }
        }
    }

    @ViewBuilder
    private var thumbnail: some View {
        switch thumbnailSource {
        case .authoritative(let url):
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image
                        .resizable()
                        .scaledToFill()
                case .empty, .failure:
                    neutralThumbnail
                @unknown default:
                    neutralThumbnail
                }
            }
        case .neutral:
            neutralThumbnail
#if DEBUG
        case .approvedFixtureAsset(let name):
            Image(name)
                .resizable()
                .scaledToFill()
#endif
        }
    }

    private var neutralThumbnail: some View {
        ZStack {
            SnapListColorToken.quietFill.color
            Image(systemName: "photo")
                .foregroundStyle(SnapListColorToken.textTertiary.color)
        }
    }
}

private struct EbayNoticeCard: View {
    let title: String
    let detail: String
    let caution: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.headline)
            Text(detail)
                .snapListTypography(.status)
                .foregroundStyle(SnapListColorToken.textSecondary.color)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(
            caution
                ? SnapListColorToken.cautionFill.color
                : SnapListColorToken.actionTint.color
        )
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }
}

private struct EbayValueRow: View {
    let label: String
    let value: String

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                labelText
                Spacer(minLength: 8)
                Text(value)
                    .snapListTypography(.rowTitle)
                    .lineLimit(1)
            }
            VStack(alignment: .leading, spacing: 3) {
                labelText
                Text(value)
                    .snapListTypography(.rowTitle)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.vertical, 11)
    }

    private var labelText: some View {
        Text(label)
            .snapListTypography(.status)
            .foregroundStyle(SnapListColorToken.textSecondary.color)
    }
}

private struct EbayDisclosureRow<Content: View>: View {
    let title: String
    let summary: String?
    @Binding var expanded: Bool
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                expanded.toggle()
            } label: {
                HStack(spacing: 10) {
                    Text(title).snapListTypography(.status)
                    Spacer()
                    if let summary {
                        Text(summary)
                            .snapListTypography(.rowTitle)
                    }
                    Image(systemName: "chevron.down")
                        .rotationEffect(.degrees(expanded ? 180 : 0))
                        .accessibilityHidden(true)
                }
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .frame(minHeight: SnapListMetrics.minimumTouchTarget)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(expanded ? "Expanded" : "Collapsed")
            if expanded { content() }
        }
    }
}

private enum EbayPublishCurrency {
    static func string(_ amount: Decimal) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        formatter.locale = Locale(identifier: "en_US")
        formatter.minimumFractionDigits = 2
        formatter.maximumFractionDigits = 2
        return formatter.string(from: amount as NSDecimalNumber) ?? "$0.00"
    }
}

private enum EbayPublishPresentation {
    static func marketplace(_ value: String) -> String {
        value == "EBAY_US"
            ? "eBay US"
            : value.replacingOccurrences(of: "_", with: " ")
    }

    static func condition(_ value: String) -> String {
        switch value {
        case "NEW": "New"
        case "LIKE_NEW": "Like new"
        case "USED_EXCELLENT": "Used, excellent"
        case "USED_VERY_GOOD": "Used, very good"
        case "USED_GOOD": "Used, good"
        case "USED_ACCEPTABLE": "Used, acceptable"
        case "FOR_PARTS_OR_NOT_WORKING": "For parts or not working"
        default: value.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }
}

// Widened from `private` (#865): `EbayConnectionSettingsView`, in a
// separate file, reuses this same card treatment for Settings' own
// connect screen.
extension View {
    func ebayCard() -> some View {
        self
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(SnapListColorToken.canvas.color)
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .overlay {
                RoundedRectangle(cornerRadius: 14)
                    .stroke(SnapListColorToken.hairline.color)
            }
    }
}
