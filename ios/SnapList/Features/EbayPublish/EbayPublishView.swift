import SwiftUI

@MainActor
struct EbayPublishJourneyHost: View {
    let listingID: UUID
    let dependencies: AppDependencies
    let forceReducedMotion: Bool
    let backToListing: () -> Void
    let goToTrophyWall: () -> Void
    let startNewItem: () -> Void

    @State private var flowStore: EbayPublishFlowStore
    @State private var claimStore: GuestClaimStore?
    @State private var authorityResolved = false

    init(
        listingID: UUID,
        dependencies: AppDependencies,
        forceReducedMotion: Bool,
        backToListing: @escaping () -> Void,
        goToTrophyWall: @escaping () -> Void,
        startNewItem: @escaping () -> Void
    ) {
        self.listingID = listingID
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
            } else if let claimStore {
                GuestClaimView(
                    store: claimStore,
                    forceReducedMotion: forceReducedMotion,
                    backToDraft: backToListing,
                    continueToItem: { _ in self.claimStore = nil },
                    startNewItem: startNewItem
                )
            } else {
                EbayPublishView(
                    store: flowStore,
                    forceReducedMotion: forceReducedMotion,
                    backToListing: backToListing,
                    goToTrophyWall: goToTrophyWall
                )
            }
        }
        .task(id: listingID) {
            guard !authorityResolved else { return }
            defer { authorityResolved = true }
            guard let authority = try? await dependencies
                .guestClaimAuthorityStore.authority(listingID: listingID),
                  authority.draftID == listingID else {
                return
            }
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
    let backToListing: () -> Void
    let goToTrophyWall: () -> Void

    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.openURL) private var openURL
    @State private var showsDisconnectConfirmation = false
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
        .navigationTitle(navigationTitle)
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(true)
        .toolbar {
            if showsBackButton {
                ToolbarItem(placement: .topBarLeading) {
                    Button(action: backToListing) {
                        Label("Back", systemImage: "chevron.left")
                    }
                    .frame(
                        minWidth: SnapListMetrics.minimumTouchTarget,
                        minHeight: SnapListMetrics.minimumTouchTarget
                    )
                    .accessibilityLabel("Back to my listing")
                    .accessibilityIdentifier("ebay-publish.back")
                }
            }
        }
        .confirmationDialog(
            "Disconnect eBay account \(accountName)?",
            isPresented: $showsDisconnectConfirmation,
            titleVisibility: .visible
        ) {
            Button("Disconnect", role: .destructive) {
                Task { await store.disconnect() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                "Listings already on eBay stay there and keep selling, but SnapList will not be able to see or change them.\n\nTo review which apps can use your eBay account, open your eBay account settings."
            )
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

    private var reduceMotion: Bool {
        systemReduceMotion || forceReducedMotion
    }

    private var accountName: String {
        store.connectedUsername ?? "your account"
    }

    private func connection(_ state: EbayConnectionViewState) -> some View {
        let copy = EbayConnectionCopy(state: state)
        return EbayCenteredActionScreen(
            headline: copy.headline,
            detail: copy.body,
            systemImage: state == .connected ? "checkmark.circle.fill" : "link",
            primary: copy.primary,
            secondary: copy.secondary,
            forceReducedMotion: reduceMotion,
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
        .accessibilityIdentifier("ebay-publish.connection.\(copy.identifier)")
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

                Text(confirmationHeading(state))
                .snapListTypography(.displayTitle)
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("ebay-publish.confirmation.heading")

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
                    SnapListPrimaryButton(
                        title: state == .accountChanged
                            ? "Post to eBay as \(accountName)"
                            : "Post to eBay",
                        forceReducedMotion: reduceMotion
                    ) { Task { await store.confirmPublish() } }
                }
                SnapListSecondaryButton(
                    title: "Back to my listing",
                    action: backToListing
                )
            }
            .padding(.horizontal, SnapListMetrics.screenGutter)
            .padding(.vertical, 10)
            .background(SnapListColorToken.canvas.color)
            .overlay(alignment: .top) { Divider() }
        }
        .accessibilityIdentifier("ebay-publish.confirmation")
    }

    private func destinationCard(
        _ preflight: EbayPublishPreflight
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("GOES TO")
                .snapListTypography(.metadata)
                .foregroundStyle(SnapListColorToken.textTertiary.color)
            Text(
                "\(EbayPublishPresentation.marketplace(preflight.marketplace)), as \(accountName)"
            )
            .snapListTypography(.rowTitle)
            .fixedSize(horizontal: false, vertical: true)
        }
        .ebayCard()
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
                Text(preflight.description)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .textSelection(.enabled)
            }
        }
        .ebayCard()
    }

    private func consent(_ state: EbayConfirmationViewState) -> some View {
        Text(
            state == .missingFields
                ? "Nothing is posted from this screen."
                : state == .accountChanged
                    ? "This posts a live listing to eBay under \(accountName), not \(store.preparedUsername ?? "the previous account")."
                    : "This posts a live listing to eBay under your account, \(accountName)."
        )
        .snapListTypography(.status)
        .foregroundStyle(SnapListColorToken.textSecondary.color)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("ebay-publish.confirmation.consent")
    }

    private func result(_ state: EbayResultViewState) -> some View {
        let copy = EbayResultCopy(state: state)
        return EbayCenteredActionScreen(
            headline: copy.headline,
            detail: copy.body,
            chip: copy.chip,
            chipVariant: copy.chipVariant,
            systemImage: state == .published ? "checkmark.circle.fill" : "shippingbox",
            primary: copy.primary,
            secondary: copy.secondary,
            forceReducedMotion: reduceMotion,
            primaryAction: {
                switch state {
                case .unavailable: Task { await store.retryPublish() }
                case .outcomeNotYetKnown:
                    Task { await store.reconcileAmbiguousPublish() }
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
        .accessibilityIdentifier("ebay-publish.result.\(copy.identifier)")
    }

    private var account: some View {
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
                    .ebayCard()
                SnapListSecondaryButton(title: "Disconnect eBay account") {
                    showsDisconnectConfirmation = true
                }
            }
            .padding(SnapListMetrics.screenGutter)
        }
        .accessibilityIdentifier("ebay-publish.account")
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

@MainActor
struct GuestClaimView: View {
    @Bindable var store: GuestClaimStore
    let forceReducedMotion: Bool
    let backToDraft: () -> Void
    let continueToItem: (ClaimedGuestListing) -> Void
    let startNewItem: () -> Void

    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @State private var email = ""
    @State private var code = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                stateContent
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, SnapListMetrics.screenGutter)
            .padding(.vertical, 24)
        }
        .background(SnapListColorToken.canvas.color)
        .navigationTitle(navigationTitle)
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(true)
        .toolbar {
            if showsAuthenticationBack {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        store.cancelAuthentication()
                    } label: {
                        Label("Back", systemImage: "chevron.left")
                    }
                    .frame(
                        minWidth: SnapListMetrics.minimumTouchTarget,
                        minHeight: SnapListMetrics.minimumTouchTarget
                    )
                    .accessibilityLabel(authenticationBackLabel)
                    .accessibilityIdentifier("guest-claim.auth-back")
                }
            }
        }
        .accessibilityIdentifier("guest-claim")
    }

    @ViewBuilder
    private var stateContent: some View {
        switch store.state {
        case .gate:
            claimMessage(
                headline: "Save this listing to your account",
                statements: [
                    "Your draft is ready. Sign in, or make an account, and it stays exactly as you left it.",
                ],
                footnote: "Saved for 24 hours, then deleted. Claiming keeps it in your account beyond 24 hours."
            )
            SnapListPrimaryButton(
                title: "Continue with email",
                forceReducedMotion: reduceMotion,
                            action: { Task { await store.showEmailEntry() } }
            )
            SnapListSecondaryButton(
                title: "Not now",
                action: backToDraft
            )
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
                action: { Task { await store.showEmailEntry() } }
            )
            SnapListSecondaryButton(
                title: "Back to my draft",
                action: backToDraft
            )
        }
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

private struct EbayResultCopy {
    let headline: String
    let chip: String
    let body: String
    let primary: String?
    let secondary: String?
    let identifier: String
    let chipVariant: SnapListChipVariant

    init(state: EbayResultViewState) {
        switch state {
        case .publishing:
            (headline, chip, body, primary, secondary, identifier, chipVariant) = (
                "Posting to eBay.", "Posting",
                "This usually takes a few seconds. You can leave this screen and it will keep going.",
                nil, "Go to Trophy Wall", "publishing", .info
            )
        case .published:
            (headline, chip, body, primary, secondary, identifier, chipVariant) = (
                "Your listing is live on eBay.", "Live on eBay",
                "Buyers can find it now. eBay handles the listing from here.",
                "Go to Trophy Wall", "View on eBay", "published", .info
            )
        case .unavailable:
            (headline, chip, body, primary, secondary, identifier, chipVariant) = (
                "eBay is not responding.", "Not posted",
                "Your listing was not posted. It is saved and ready to send when eBay is back.",
                "Try again", "Go to Trophy Wall", "unavailable", .neutral
            )
        case .sellerFixableRefusal(let message):
            (headline, chip, body, primary, secondary, identifier, chipVariant) = (
                "Update your eBay account to post this listing.", "Not posted",
                message,
                "Go to Trophy Wall", nil, "seller-fixable-refusal", .neutral
            )
        case .outcomeNotYetKnown:
            (headline, chip, body, primary, secondary, identifier, chipVariant) = (
                "SnapList does not know yet whether eBay accepted this listing.",
                "Checking with eBay",
                "The connection dropped at the wrong moment. Check again to reuse the saved publish attempt without creating another listing.",
                "Check again", "Go to Trophy Wall", "outcome-unknown", .caution
            )
        case .ebaySideChanged:
            (headline, chip, body, primary, secondary, identifier, chipVariant) = (
                "Your eBay connection changed.", "Not posted",
                "Nothing was sent to eBay. Your listing is exactly as you left it.",
                "Check eBay connection", "Go to Trophy Wall", "ebay-side-changed", .neutral
            )
        }
    }
}

private struct EbayCenteredActionScreen: View {
    let headline: String
    let detail: String
    var chip: String?
    var chipVariant: SnapListChipVariant = .neutral
    let systemImage: String
    let primary: String?
    let secondary: String?
    let forceReducedMotion: Bool
    let primaryAction: () -> Void
    let secondaryAction: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Spacer(minLength: 16)
                Image(systemName: systemImage)
                    .font(.system(size: 36, weight: .semibold))
                    .foregroundStyle(SnapListColorToken.action.color)
                    .accessibilityHidden(true)
                if let chip {
                    SnapListChip(chip, variant: chipVariant)
                }
                Text(headline)
                    .snapListTypography(.displayTitle)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("ebay-publish.heading")
                Text(detail)
                    .snapListTypography(.body)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .fixedSize(horizontal: false, vertical: true)
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
                }
                if let secondary {
                    SnapListSecondaryButton(
                        title: secondary,
                        action: secondaryAction
                    )
                }
            }
            .padding(.horizontal, SnapListMetrics.screenGutter)
            .padding(.vertical, 10)
            .background(SnapListColorToken.canvas.color)
            .overlay(alignment: .top) { Divider() }
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
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(label)
                .snapListTypography(.status)
                .foregroundStyle(SnapListColorToken.textSecondary.color)
            Spacer(minLength: 8)
            Text(value)
                .snapListTypography(.rowTitle)
                .multilineTextAlignment(.trailing)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 11)
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

private extension View {
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
