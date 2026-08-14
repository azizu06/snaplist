import AuthenticationServices
import ClerkKit
import StoreKit
import SwiftUI

@MainActor
struct SettingsView: View {
    private let profile: SettingsProfile
    private let settingsProofState: SettingsProofState?
    private let settingsSellingFixture: SettingsSellingFixtureState?
    private let settingsSubscriptionFixture: SettingsSubscriptionFixtureState?
    private let settingsProofSafeExit: (() -> Void)?
    private let deletionFlowPresentationChanged: (Bool) -> Void
    private let mobileAPIClient: any MobileAPIClient
    private let removeLocalData: () async -> Bool
    private let deletionOutstanding: Bool
    private let analyticsClient: any AnalyticsClient
    private let ebayPublishService: any EbayPublishFeatureServing
    private let navigate: (AppRoute) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var hasLocalData: Bool
    @State private var ebayConnection: EbayConnectionStatus?
    @State private var ebayConnectionLoadPhase =
        SettingsSellingPresentation.LoadPhase.loading
    @State private var analyticsConsentState: SettingsAnalyticsConsentState
    @State private var subscriptionStore: SubscriptionStore
    @State private var subscriptionLoadPhase =
        SettingsSubscriptionPresentation.LoadPhase.loading
    @State private var managesSubscription = false

    init(
        configuration: LaunchConfiguration,
        mobileAPIClient: any MobileAPIClient,
        subscriptionClient: any SubscriptionClient,
        analyticsClient: any AnalyticsClient,
        ebayPublishService: any EbayPublishFeatureServing,
        navigate: @escaping (AppRoute) -> Void,
        hasLocalData: Bool,
        removeLocalData: @escaping () async -> Bool,
        deletionOutstanding: Bool = false,
        settingsProofSafeExit: (() -> Void)? = nil,
        deletionFlowPresentationChanged: @escaping (Bool) -> Void = { _ in }
    ) {
        profile = .current(configuration: configuration)
        settingsProofState = configuration.settingsProofState
        settingsSellingFixture = configuration.settingsSellingFixture
        settingsSubscriptionFixture = configuration.settingsSubscriptionFixture
        self.settingsProofSafeExit = settingsProofSafeExit
        self.deletionFlowPresentationChanged = deletionFlowPresentationChanged
        self.mobileAPIClient = mobileAPIClient
        self.removeLocalData = removeLocalData
        self.deletionOutstanding = deletionOutstanding
        self.analyticsClient = analyticsClient
        self.ebayPublishService = ebayPublishService
        self.navigate = navigate
        _hasLocalData = State(initialValue: hasLocalData)
        _analyticsConsentState = State(
            initialValue: SettingsAnalyticsConsentState(
                consent: UserDefaultsAnalyticsConsentStore().consent
            )
        )
        _subscriptionStore = State(
            initialValue: SubscriptionStore(client: subscriptionClient)
        )
    }

    var body: some View {
        if let settingsProofState,
           settingsProofState != .settingsHub,
           let settingsProofSafeExit {
            SettingsProofStateView(
                state: settingsProofState,
                profile: profile,
                onSafeExit: settingsProofSafeExit,
                deletionFlowPresentationChanged: deletionFlowPresentationChanged
            )
        } else {
            settingsHub
        }
    }

    private var settingsHub: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
            profileCard
                settingsSectionHeader("ACCOUNT")
                settingsCard {
                    settingsCardRow {
                        if let accountEntry = SettingsAccountEntryPolicy.destination(
                            for: profile.identity
                        ) {
                            // Routed rather than pushed: the account boundary opens
                            // modally, and a NavigationLink would push it (#799).
                            Button {
                                navigate(accountEntry)
                            } label: {
                                Text("Create an account")
                                    // `maxHeight: .infinity` claims the full
                                    // row `settingsCardRow` proposes, not
                                    // just this text's own line height, the
                                    // same fix `LegalLinkRow` needed (#831).
                                    .frame(
                                        maxWidth: .infinity,
                                        maxHeight: .infinity,
                                        alignment: .leading
                                    )
                                    .contentShape(Rectangle())
                            }
                            .accessibilityIdentifier("settings.create-account")
                            .accessibilityHint("Opens the account entry screen")
                        } else {
                            valueRow("Sign-in method", profile.methodLabel)
                        }
                    }
                    // #844. A member's ACCOUNT card used to hold nothing but a
                    // static `Sign-in method` value, so the only way to stop
                    // being signed in on this iPhone was to delete the account.
                    if SettingsSignOutPolicy.isAvailable(for: profile.identity) {
                        settingsCardDivider
                        settingsCardRow {
                            NavigationLink {
                                SettingsSignOutView(signOut: signOut)
                            } label: {
                                Text(SettingsSignOutCopy.rowLabel)
                                    // Same `settingsCardRow` fixed-height
                                    // touch-target gap `LegalLinkRow` and
                                    // "Create an account" needed (#831).
                                    .frame(
                                        maxWidth: .infinity,
                                        maxHeight: .infinity,
                                        alignment: .leading
                                    )
                                    .contentShape(Rectangle())
                            }
                            .accessibilityIdentifier("settings.sign-out")
                            .accessibilityHint("Explains what signing out does before it runs")
                        }
                    }
                }

                settingsSectionHeader("SELLING")
                settingsCard {
                    settingsCardRow {
                        valueRow(
                            "Connected marketplaces",
                            sellingPresentation.marketplaceValue
                        )
                        .accessibilityIdentifier("settings.selling.marketplaces")
                    }
                    settingsCardDivider
                    if let hint = sellingPresentation.hint {
                        settingsCardRow {
                            SettingsSellingHintRow(hint: hint)
                        }
                        settingsCardDivider
                    }
                    settingsCardRow {
                        valueRow("Photos", "Selected photos")
                            .accessibilityIdentifier("settings.selling.photos")
                    }
                    settingsCardDivider
                    settingsCardRow {
                        valueRow("Notifications", "On")
                            .accessibilityIdentifier("settings.selling.notifications")
                    }
                }

                if SettingsSubscriptionVisibility(
                    identity: profile.identity,
                    deletionOutstanding: deletionOutstanding
                ).isVisible {
                    subscriptionSection
                }

                settingsSectionHeader("PRIVACY")
                settingsCard {
                    settingsCardRow {
                        Toggle("Share usage analytics", isOn: analyticsConsentBinding)
                            .accessibilityIdentifier("settings.share-usage-analytics")
                    }
                }

                settingsSectionHeader("ABOUT")
                settingsCard {
                    settingsCardRow {
                        LegalLinkRow(
                            destination: .help,
                            accessibilityIdentifier: "settings.about.help"
                        )
                    }
                    settingsCardDivider
                    settingsCardRow {
                        LegalLinkRow(
                            destination: .privacyPolicy,
                            accessibilityIdentifier: "settings.about.privacy-policy"
                        )
                    }
                    settingsCardDivider
                    settingsCardRow {
                        LegalLinkRow(
                            destination: .termsOfService,
                            accessibilityIdentifier: "settings.about.terms-of-service"
                        )
                    }
                }

                settingsSectionHeader("THIS IPHONE")
                settingsCard {
                    settingsCardRow {
                        if hasLocalData {
                            NavigationLink {
                                SettingsLocalRemovalView(
                                    isGuest: profile.isGuest,
                                    remove: {
                                        guard await removeLocalData() else { return false }
                                        hasLocalData = false
                                        return true
                                    }
                                )
                            } label: {
                                Text("Remove unsent photos and voice notes")
                            }
                            .accessibilityIdentifier("settings.local-removal")
                            .accessibilityHint("Explains what SnapList removes from this iPhone")
                        } else {
                            Text("No unsent photos or voice notes")
                                .foregroundStyle(.secondary)
                                .accessibilityIdentifier("settings.local-empty")
                        }
                    }
                }

                if !profile.isGuest {
                    settingsSectionHeader("ACCOUNT MANAGEMENT")
                    settingsCard {
                        settingsCardRow {
                            NavigationLink {
                                SettingsDeletionConsequencesView(
                                    profile: profile,
                                    subscriptionTruth: SettingsDeletionSubscriptionTruth(
                                        state: subscriptionStore.state,
                                        loadPhase: subscriptionLoadPhase
                                    ),
                                    proofSafeExit: nil,
                                    reservesFloatingDock: false,
                                    deletionFlowPresentationChanged:
                                        deletionFlowPresentationChanged
                                )
                            } label: {
                                Text("Delete account")
                                    // Same `settingsCardRow` fixed-height
                                    // touch-target gap `LegalLinkRow` and
                                    // "Create an account" needed (#831).
                                    .frame(
                                        maxWidth: .infinity,
                                        maxHeight: .infinity,
                                        alignment: .leading
                                    )
                                    .contentShape(Rectangle())
                            }
                            .accessibilityIdentifier("settings.delete-account")
                            .accessibilityHint("Opens a screen that explains what deletion does")
                        }
                    }
                } else {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(SettingsGuestBoundaryCopy.title)
                            .font(.subheadline.weight(.semibold))
                        Text(SettingsGuestBoundaryCopy.body)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.top, 24)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("settings.guest-boundary")
                }
                Text(
                    "SnapList \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0") · \(Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1")"
                )
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 24)
            }
            .padding(.horizontal, 21)
            .padding(.top, 16)
            .padding(.bottom, 100)
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .background(SnapListColorToken.mutedSurface.color)
        .alert(
            "Couldn’t update analytics sharing",
            isPresented: analyticsConsentErrorBinding
        ) {
            Button("OK", role: .cancel) {
                analyticsConsentState.dismissError()
            }
        } message: {
            Text("Your preference did not change. Try again.")
        }
        .manageSubscriptionsSheet(isPresented: $managesSubscription)
        .task {
            guard !isSettingsHubProof else { return }
            await loadEbayConnection()
        }
        .task {
            guard !profile.isGuest, !isSettingsHubProof else { return }
            await loadSubscription()
        }
        .accessibilityIdentifier("settings.screen")
    }

    private var profileCard: some View {
        HStack(spacing: 14) {
            Text(profile.initials)
                .font(.headline)
                .foregroundStyle(.secondary)
                .frame(width: 46, height: 46)
                .background(SnapListColorToken.avatarBackground.color, in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text(profile.name).font(.headline)
                Text(profile.email).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 16)
        // Same fixed-height defect as `settingsCardRow` (#831): the name and
        // email column can need more than 74pt once Dynamic Type or Bold
        // Text grows them, so 74pt stays the floor and stops being a
        // ceiling.
        .frame(maxWidth: .infinity, minHeight: 74, alignment: .leading)
        .background(SnapListColorToken.canvas.color, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var subscriptionSection: some View {
        let presentation = subscriptionPresentation
        VStack(alignment: .leading, spacing: 0) {
            settingsSubscriptionHeader(presentation)
            settingsCard {
                settingsCardRow {
                    valueRow("SnapList Pro", presentation.status)
                }
            ForEach(Array(presentation.facts.enumerated()), id: \.offset) { _, fact in
                    settingsCardDivider
                    settingsCardRow {
                        valueRow(fact.label, fact.value)
                    }
            }
            ForEach(presentation.actions, id: \.self) { action in
                    settingsCardDivider
                    settingsCardRow {
                switch action {
                // Each label claims the whole row `settingsCardRow` proposes
                // so the hit target stays at the row height instead of
                // collapsing to one line of text at the smallest Dynamic
                // Type size, the same fix the account rows needed (#831).
                case .manage:
                    Button {
                        managesSubscription = true
                    } label: {
                        HStack {
                            Text("Manage subscription in the App Store")
                            Spacer()
                            Image(systemName: "arrow.up.right.square")
                        }
                        .frame(maxHeight: .infinity)
                        .contentShape(Rectangle())
                    }
                    .foregroundStyle(SnapListColorToken.action.color)
                    .accessibilityIdentifier("settings.subscription.manage")
                    .accessibilityHint("Opens the App Store")
                case .restore:
                    Button {
                        Task { await restoreSubscription() }
                    } label: {
                        Text("Restore purchase")
                            .frame(
                                maxWidth: .infinity,
                                maxHeight: .infinity,
                                alignment: .leading
                            )
                            .contentShape(Rectangle())
                    }
                    .accessibilityIdentifier("settings.subscription.restore")
                    .accessibilityHint("Asks Apple for a purchase on this Apple Account, then waits for the server to confirm it")
                case .retry:
                    Button {
                        Task { await loadSubscription() }
                    } label: {
                        Text("Try again")
                            .frame(
                                maxWidth: .infinity,
                                maxHeight: .infinity,
                                alignment: .leading
                            )
                            .contentShape(Rectangle())
                    }
                    .accessibilityIdentifier("settings.subscription.retry")
                    .accessibilityHint("Loads your subscription details again")
                }
            }
            }
            }
            VStack(alignment: .leading, spacing: 6) {
                if let note = presentation.note { Text(note) }
                if presentation.showsOwnershipNote {
                    Text("Apple bills and cancels SnapList Pro. SnapList cannot cancel it for you.")
                }
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 4)
            .padding(.top, 8)
        }
        .onChange(of: presentation) { _, reading in
            AccessibilityNotification.Announcement(
                reading.accessibilityAnnouncement
            ).post()
        }
    }

    private func loadSubscription() async {
        subscriptionLoadPhase = .loading
        do {
            let configuration = try await mobileAPIClient
                .getRevenueCatConfiguration().data.subscriptionConfiguration
            await subscriptionStore.load(configuration: configuration)
            let refreshPlan = SettingsEntitlementRefreshPlan.afterInitialLoad(
                subscriptionStore.state
            )
            subscriptionLoadPhase = refreshPlan.deletionDisclosureLoadPhase
            guard refreshPlan == .requestServerTruth else { return }
            await refreshServerEntitlement()
        } catch {
            subscriptionLoadPhase = .failed
        }
    }

    private func restoreSubscription() async {
        subscriptionLoadPhase = .loaded
        await subscriptionStore.restore()
        let refreshPlan = SettingsEntitlementRefreshPlan.afterRestore(
            subscriptionStore.state
        )
        subscriptionLoadPhase = refreshPlan.deletionDisclosureLoadPhase
        guard refreshPlan == .requestServerTruth else { return }
        await refreshServerEntitlement()
    }

    private func refreshServerEntitlement() async {
        await SettingsEntitlementServerRefresh.perform(
            fetch: {
                try await mobileAPIClient
                    .getAiItemEntitlement().data.serverVerifiedSubscription
            },
            apply: subscriptionStore.applyServerVerification,
            setLoadPhase: { subscriptionLoadPhase = $0 }
        )
    }

    private var analyticsConsentBinding: Binding<Bool> {
        Binding(
            get: { analyticsConsentState.isEnabled },
            set: { analyticsConsentState.request($0, using: analyticsClient) }
        )
    }

    private var analyticsConsentErrorBinding: Binding<Bool> {
        Binding(
            get: { analyticsConsentState.showsError },
            set: { isPresented in
                guard !isPresented else { return }
                analyticsConsentState.dismissError()
            }
        )
    }

    private var sellingPresentation: SettingsSellingPresentation {
        if let sellingFixturePresentation {
            return sellingFixturePresentation
        }
        if isSettingsHubProof {
            return SettingsSellingPresentation(
                connection: EbayConnectionStatus(
                    connected: true,
                    ebayUsername: "JordanHale",
                    policySetup: nil
                ),
                loadPhase: .loaded
            )
        }
        return SettingsSellingPresentation(
            connection: ebayConnection,
            loadPhase: ebayConnectionLoadPhase
        )
    }

    private var subscriptionPresentation: SettingsSubscriptionPresentation {
        if let subscriptionFixturePresentation {
            return subscriptionFixturePresentation
        }
        if isSettingsHubProof {
            return SettingsSubscriptionPresentation(
                state: .verified(Self.settingsHubProofSubscription),
                loadPhase: .loaded,
                locale: Locale(identifier: "en_US")
            )
        }
        return SettingsSubscriptionPresentation(
            state: subscriptionStore.state,
            loadPhase: subscriptionLoadPhase
        )
    }

    /// The connected-with-a-policy-problem answer, which no other Settings
    /// fixture can produce: `SET-01` always reports a healthy connection, so
    /// the hint row and its policy link are unreachable without this (#836).
    private var sellingFixturePresentation: SettingsSellingPresentation? {
#if DEBUG
        guard let settingsSellingFixture else { return nil }
        switch settingsSellingFixture {
        case .policyProblem:
            return SettingsSellingPresentation(
                connection: EbayConnectionStatus(
                    connected: true,
                    ebayUsername: "JordanHale",
                    policySetup: EbayPolicySetupHint(
                        state: "setupRequired",
                        marketplaceID: "EBAY_US",
                        missing: ["fulfillmentPolicy", "returnPolicy"],
                        ambiguous: [],
                        message: "Your eBay account is missing a shipping policy and a return policy. Add them on eBay before you publish.",
                        helpURL: URL(
                            string: "https://www.bizpolicy.ebay.com/businesspolicy/manage"
                        )
                    )
                ),
                loadPhase: .loaded
            )
        }
#else
        nil
#endif
    }

    /// The failed-load answer, which no other Settings fixture can produce:
    /// `SET-01` reports a verified subscription and short-circuits
    /// `loadSubscription()`, so `SUB-15` — and the `Try again` control that is
    /// the only place `settings.subscription.retry` is drawn — was unreachable
    /// at every Dynamic Type size (#839).
    private var subscriptionFixturePresentation: SettingsSubscriptionPresentation? {
#if DEBUG
        guard let settingsSubscriptionFixture else { return nil }
        switch settingsSubscriptionFixture {
        case .loadFailed:
            return SettingsSubscriptionPresentation(
                state: .unconfigured,
                loadPhase: .failed,
                locale: Locale(identifier: "en_US")
            )
        }
#else
        nil
#endif
    }

    private var isSettingsHubProof: Bool {
#if DEBUG
        settingsProofState == .settingsHub
#else
        false
#endif
    }

    private static let settingsHubProofSubscription: ServerVerifiedSubscription = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York")!
        return ServerVerifiedSubscription(
            source: .storeKit,
            status: .active,
            remainingItems: 12,
            periodStart: nil,
            periodEnd: calendar.date(
                from: DateComponents(year: 2026, month: 8, day: 28, hour: 12)
            )!,
            gracePeriodEnd: nil,
            transitionState: nil,
            legacyStripeStatus: nil
        )
    }()

    private func settingsSectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.subheadline.weight(.medium))
            .foregroundStyle(.secondary)
            // A fixed height proposes 18pt but does not clip: at an
            // accessibility size the label draws ~67pt and the extra glyphs
            // spill into the card below instead of pushing it down (#836).
            .frame(minHeight: 18, alignment: .leading)
            .padding(.top, 19)
            .padding(.bottom, 3)
    }

    private func settingsSubscriptionHeader(
        _ presentation: SettingsSubscriptionPresentation
    ) -> some View {
        HStack {
            Text("SUBSCRIPTION")
            Spacer()
            if isSettingsHubProof {
                Text(presentation.stateID)
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(SnapListColorToken.debugProofText.color)
            }
        }
        .font(.subheadline.weight(.medium))
        .foregroundStyle(.secondary)
        .frame(minHeight: 18)
        .padding(.top, 19)
        .padding(.bottom, 3)
        // The state ID rides the header rather than the section around it: an
        // identifier on the enclosing stack is applied after the ones inside
        // it, so it replaced every action button's own identifier and left
        // them unaddressable (#836).
        //
        // `.contain` makes this stack one addressable container instead of
        // letting the identifier reach each `Text` inside it: without it both
        // leaves answered to `settings.subscription.<state>`, so the query
        // matched two elements and reading a frame from it was ambiguous
        // (#839).
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(
            "settings.subscription.\(presentation.stateID.lowercased())"
        )
    }

    /// #844. Removes this device's copies, then ends the Clerk session, then
    /// pops Settings so the seller lands back in the shell — which reads
    /// `Clerk.shared.user` and is therefore the guest shell by then.
    ///
    /// `removeLocalData` is the same closure the THIS IPHONE row already uses,
    /// and `signOut()` is the same ClerkKit call the deletion tail makes. The
    /// ordering and the failure handling live in `SettingsSignOutTransaction`
    /// so they are provable without a signed-in device.
    private func signOut() async -> SettingsSignOutOutcome {
        let outcome = await SettingsSignOutTransaction.perform(
            removeLocalData: removeLocalData,
            endSession: { try await Clerk.shared.auth.signOut() }
        )
        if outcome == .signedOut {
            hasLocalData = false
            dismiss()
        }
        return outcome
    }

    private func settingsCard<Content: View>(
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(spacing: 0, content: content)
            .background(SnapListColorToken.canvas.color, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    private func settingsCardRow<Content: View>(
        @ViewBuilder content: () -> Content
    ) -> some View {
        content()
            // `maxHeight: 52` used to pin every row to exactly 52pt no
            // matter what it held, which clipped `SettingsSellingHintRow`'s
            // footnote-plus-policy-link content even at the default type
            // size (#831). 52pt is still the floor every row asks for, but
            // nothing here caps how tall a row's own content is allowed to
            // grow.
            .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
            .padding(.horizontal, 16)
    }

    private var settingsCardDivider: some View {
        Color.clear
            .frame(height: 0)
            .overlay {
                Divider()
                    .padding(.horizontal, 16)
            }
            .allowsHitTesting(false)
    }

    /// Settings reads the connection the seller already has. A guest has none,
    /// so this asks the server nothing rather than spending a request to be
    /// told 401.
    private func loadEbayConnection() async {
        guard !profile.isGuest else {
            ebayConnectionLoadPhase = .loaded
            return
        }
        do {
            ebayConnection = try await ebayPublishService.connection()
            ebayConnectionLoadPhase = .loaded
        } catch {
            ebayConnectionLoadPhase = .failed
        }
    }

    /// No `chevron` parameter on purpose (issue #812): a value row here never
    /// navigates, so there is nothing for it to promise. A row that does
    /// navigate should use a real `Button`, as `LegalLinkRow` does.
    private func valueRow(_ label: String, _ value: String) -> some View {
        SettingsValueRow(label: label, value: value)
    }
}

/// A label and the value it reads, side by side until they cannot be.
///
/// The `HStack` splits the row's width between the two, and a single word wider
/// than its share is broken mid-word rather than wrapped: `Connected
/// marketplaces` rendered as `Con-nected` at an accessibility size (#839).
/// Above the accessibility threshold the two take their own lines, where each
/// one has the whole row to lay out in and no word has to be cut in half.
private struct SettingsValueRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let label: String
    let value: String

    var body: some View {
        Group {
            if SettingsValueRowLayout.stacks(at: dynamicTypeSize) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(label)
                    valueText
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                HStack {
                    Text(label)
                    Spacer()
                    valueText
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var valueText: some View {
        Text(value).foregroundStyle(.secondary)
    }
}

private struct SettingsProofStateView: View {
    let state: SettingsProofState
    let profile: SettingsProfile
    let onSafeExit: () -> Void
    let deletionFlowPresentationChanged: (Bool) -> Void

    var body: some View {
        switch state {
        case .settingsHub:
            EmptyView()
        case .deletionConsequences:
            SettingsDeletionConsequencesView(
                profile: profile,
                subscriptionTruth: .billing,
                proofSafeExit: onSafeExit,
                reservesFloatingDock: false,
                deletionFlowPresentationChanged:
                    deletionFlowPresentationChanged
            )
        case .reauthentication:
            SettingsReauthenticationView(
                profile: profile,
                subscriptionTruth: .unknown,
                keepAccount: onSafeExit,
                isPresented: .constant(true),
                proofSafeExit: onSafeExit,
                reservesFloatingDock: true
            )
        case .deletionConfirmation:
            SettingsDeletionConfirmationProofHost(
                profile: profile,
                onSafeExit: onSafeExit
            )
        }
    }
}

/// Issue #385. DEL-03 with somewhere for DEL-06r's exit to land.
///
/// The shipped route reaches DEL-03 from the reauthentication screen, so the
/// tail's "Confirm it is you" pops back onto a screen that is already there. The
/// proof route enters at DEL-03 with nothing behind it, and a route back to
/// verification that had nowhere to go could not be tested at all.
private struct SettingsDeletionConfirmationProofHost: View {
    let profile: SettingsProfile
    let onSafeExit: () -> Void

    @State private var reauthenticating = false

    var body: some View {
        // No stack of its own. The proof route reaches this through the shell's
        // NavigationStack, which is what hosts DEL-03's `navigationDestination`
        // push, and that is why the tail states are reachable here at all. An
        // inner stack suppressed the pushed content and made the shell render
        // its root instead.
        content
    }

    @ViewBuilder private var content: some View {
        if reauthenticating {
            SettingsReauthenticationView(
                profile: profile,
                subscriptionTruth: .unknown,
                keepAccount: onSafeExit,
                isPresented: .constant(true),
                proofSafeExit: onSafeExit,
                reservesFloatingDock: true
            )
        } else {
            SettingsDeletionConfirmationView(
                subscriptionTruth: .unknown,
                keepAccount: onSafeExit,
                returnToReauthentication: { reauthenticating = true },
                reservesFloatingDock: true
            )
        }
    }
}

struct SettingsAnalyticsConsentState {
    private(set) var isEnabled: Bool
    private(set) var showsError = false

    init(consent: AnalyticsConsent) {
        isEnabled = consent == .granted
    }

    mutating func request(
        _ isEnabled: Bool,
        using analyticsClient: any AnalyticsClient
    ) {
        do {
            try analyticsClient.setConsent(isEnabled ? .granted : .denied)
            self.isEnabled = isEnabled
            showsError = false
        } catch {
            showsError = true
        }
    }

    mutating func dismissError() {
        showsError = false
    }
}

private struct SettingsLocalRemovalView: View {
    @Environment(\.dismiss) private var dismiss
    let isGuest: Bool
    let remove: () async -> Bool
    @State private var removing = false

    var body: some View {
        SettingsExplanationPage(title: "Remove unsent photos and voice notes") {
            SettingsFactSection(title: "What is removed from this iPhone", bullets: [
                "Photos and a voice note you have not submitted yet, and this iPhone’s copy of anything it is holding for an item.",
                "Items still waiting to be sent will leave Trophy Wall."
            ])
            SettingsFactSection(
                title: "What this does not change",
                bullets: SettingsFlow(
                    identity: isGuest ? .guest : .member(method: .apple, email: ""),
                    hasLocalData: true
                ).localRemovalUnchangedFacts,
                usesBullets: false
            )
            Text(isGuest
                ? "This covers SnapList’s copies on this iPhone. Claiming an account is what makes anything else manageable."
                : "This covers SnapList’s copies on this iPhone. Deleting your account is a separate action in Settings.")
                .foregroundStyle(.secondary)
        }
        .navigationTitle("This iPhone")
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            SettingsActionTray(
                primary: "Remove from this iPhone",
                secondary: "Keep it",
                destructive: true,
                disabled: removing,
                primaryAction: {
                    removing = true
                    Task {
                        if await remove() { dismiss() }
                        removing = false
                    }
                },
                secondaryAction: { dismiss() }
            )
        }
        .accessibilityIdentifier(isGuest ? "settings.state.set-05" : "settings.state.set-06")
    }
}

/// #844. Sign-out is confirmed before it runs, because it takes this iPhone's
/// unsent work with it and a seller who taps `Sign out` is not expecting that.
///
/// Modelled on `SettingsLocalRemovalView`: the same explanation page, the same
/// bottom tray, the same `destructive` treatment. That treatment is not the
/// account-deletion one — `SettingsActionTray.commitsAccountDeletion` keys on
/// the literal primary label `Delete account`, so nothing here can borrow it.
private struct SettingsSignOutView: View {
    @Environment(\.dismiss) private var dismiss
    let signOut: () async -> SettingsSignOutOutcome
    @State private var signingOut = false
    @State private var showsFailure = false

    var body: some View {
        SettingsExplanationPage(title: SettingsSignOutCopy.title) {
            SettingsFactSection(
                title: SettingsSignOutCopy.effectTitle,
                bullets: SettingsSignOutCopy.effects
            )
            SettingsFactSection(
                title: SettingsSignOutCopy.unchangedTitle,
                bullets: SettingsSignOutCopy.unchanged,
                usesBullets: false
            )
            if showsFailure {
                Text(SettingsSignOutCopy.failed)
                    .foregroundStyle(SnapListColorToken.destructiveText.color)
                    .accessibilityIdentifier("settings.sign-out.failed")
            }
            Text(SettingsSignOutCopy.deletionIsElsewhere)
                .foregroundStyle(.secondary)
        }
        .navigationTitle(SettingsSignOutCopy.title)
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            SettingsActionTray(
                primary: SettingsSignOutCopy.confirm,
                secondary: SettingsSignOutCopy.cancel,
                destructive: true,
                disabled: signingOut,
                primaryAction: {
                    signingOut = true
                    showsFailure = false
                    Task {
                        // Never dismissed on failure: the seller is still
                        // signed in, and returning them to a Settings screen
                        // that says otherwise would be the lie.
                        if await signOut() != .signedOut { showsFailure = true }
                        signingOut = false
                    }
                },
                secondaryAction: { dismiss() }
            )
            // This screen is pushed inside the shell that draws the floating
            // dock, so without the reservation the dock lands on top of
            // `Stay signed in`. `isHittable` still answers true in that state
            // (#812), so the tap goes to the dock and the seller is stuck on a
            // confirmation they cannot back out of. Same reservation the
            // deletion screens take.
            .padding(
                .bottom,
                SnapListMetrics.dockHeight + SnapListMetrics.dockBottomInset
            )
        }
        .accessibilityIdentifier("settings.sign-out.confirm")
    }
}

private struct SettingsDeletionHeader: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let back: () -> Void

    var body: some View {
        Group {
            // A `ZStack` draws the centred title and the leading back control
            // in the same 56pt band, and at an accessibility size neither one
            // gives way: `Delete account` and `Settings` overprinted each other
            // across the whole bar (#839). Above the accessibility threshold
            // the two take their own rows instead, which is also the only
            // layout where the title has the width to stay one readable line.
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 4) {
                    backButton
                    title
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                ZStack {
                    title
                    HStack {
                        backButton
                        Spacer()
                    }
                }
            }
        }
        .padding(.horizontal, 20)
        // Absorbed by the 56pt floor at every non-accessibility size, so this
        // costs the shipped bar nothing; above the threshold it is what keeps
        // the grown title off the divider it would otherwise sit on.
        .padding(.vertical, 6)
        // 56pt is the floor the bar asks for, not a ceiling it clips its own
        // content to: a fixed height proposes a size without clipping, so any
        // content taller than the proposal draws outside the background and
        // the divider that are supposed to contain it (#839).
        .frame(minHeight: 56)
        .background(SnapListColorToken.canvas.color)
        .overlay(alignment: .bottom) { Divider() }
    }

    private var title: some View {
        Text("Delete account")
            .font(.headline)
            .accessibilityAddTraits(.isHeader)
    }

    private var backButton: some View {
        Button(action: back) {
            HStack(spacing: 4) {
                Image(systemName: "chevron.left")
                Text("Settings")
            }
            .frame(minHeight: 44)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .foregroundStyle(SnapListColorToken.action.color)
        .accessibilityLabel("Settings")
    }
}

private struct SettingsDeletionConsequencesView: View {
    @Environment(\.dismiss) private var dismiss
    let profile: SettingsProfile
    let subscriptionTruth: SettingsDeletionSubscriptionTruth
    let proofSafeExit: (() -> Void)?
    var reservesFloatingDock = false
    let deletionFlowPresentationChanged: (Bool) -> Void
    @State private var managesSubscription = false
    @State private var presentsReauthentication = false

    var body: some View {
        VStack(spacing: 0) {
            SettingsDeletionHeader(back: safeExit)
            SettingsExplanationPage(
                title: "Delete your SnapList account",
                lead: "Read what this does before you continue. You can still stop at every step.",
                titleFont: .system(size: 20, weight: .bold),
                leadFont: .system(size: 16),
                horizontalPadding: 25,
                verticalPadding: 30,
                titleToLeadSpacing: 22,
                contentTopSpacing: 18,
                contentSectionSpacing: 15
            ) {
                SettingsFactSection(
                    title: "What is deleted",
                    bullets: [
                        "Your SnapList account and how you sign in",
                        "Your items, photos, drafts, voice notes and runs",
                        "Your price research and anything SnapList generated for you",
                        "Your eBay connection, removed from SnapList"
                    ],
                    bulletColor: SnapListColorToken.destructiveText.color,
                    rowFont: .system(size: 15),
                    rowVerticalPadding: 15.5,
                    rowHorizontalPadding: 12,
                    bulletSpacing: 8,
                    headerToCardSpacing: 5
                )
                SettingsDeletionBoundarySection(
                    subscriptionCopy: subscriptionTruth.longCopy
                )
                Button("Manage subscription in the App Store") { managesSubscription = true }
                Text("Nothing is deleted yet. The next step confirms it is you.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .background(SnapListColorToken.canvas.color.ignoresSafeArea(edges: .top))
        .toolbar(.hidden, for: .navigationBar)
        .manageSubscriptionsSheet(isPresented: $managesSubscription)
        .safeAreaInset(edge: .bottom) {
            SettingsActionTray(
                primary: "Continue to delete my account",
                secondary: "Keep my account",
                destructive: true,
                note: "One more step after this, and it is not the deletion.",
                primaryAction: { presentsReauthentication = true },
                secondaryAction: safeExit
            )
            .offset(y: 16)
            .padding(
                .bottom,
                reservesFloatingDock
                    ? SnapListMetrics.dockHeight + SnapListMetrics.dockBottomInset
                    : 0
            )
        }
        .navigationDestination(isPresented: $presentsReauthentication) {
            SettingsReauthenticationView(
                profile: profile,
                subscriptionTruth: subscriptionTruth,
                keepAccount: safeExit,
                isPresented: $presentsReauthentication,
                proofSafeExit: proofSafeExit,
                reservesFloatingDock: reservesFloatingDock
            )
        }
        .accessibilityIdentifier("settings.state.del-01")
        .onAppear { deletionFlowPresentationChanged(true) }
        .onDisappear {
            guard !presentsReauthentication else { return }
            deletionFlowPresentationChanged(false)
        }
    }

    private func safeExit() {
        deletionFlowPresentationChanged(false)
        if let proofSafeExit {
            proofSafeExit()
        } else {
            dismiss()
        }
    }
}

private struct SettingsReauthenticationView: View {
    let profile: SettingsProfile
    let subscriptionTruth: SettingsDeletionSubscriptionTruth
    let keepAccount: () -> Void
    @Binding var isPresented: Bool
    let proofSafeExit: (() -> Void)?
    var reservesFloatingDock = false
    @State private var code = ""
    @State private var failed = false
    @State private var confirmed = false
    @State private var working = false
    @State private var emailCodeDelivery = SettingsEmailCodeDeliveryState.sending
    @AccessibilityFocusState private var errorFocused: Bool
    @FocusState private var codeFocused: Bool

    var body: some View {
        SettingsExplanationPage(
            title: "Confirm it’s you",
            lead: profile.method == .apple
                ? "Deleting an account is permanent, so SnapList asks the system to confirm you before it sends anything."
                : emailCodeDelivery.lead(email: profile.email)
        ) {
            if let failureCopy = emailCodeDelivery.failureCopy(
                email: profile.email
            ) {
                Text(failureCopy)
                    .padding().background(SnapListColorToken.neutralFill.color, in: RoundedRectangle(cornerRadius: 14))
                    .accessibilityFocused($errorFocused)
            } else if failed {
                Text("That did not confirm it was you. Nothing has been deleted. You can try again.")
                    .padding().background(SnapListColorToken.neutralFill.color, in: RoundedRectangle(cornerRadius: 14))
                    .accessibilityFocused($errorFocused)
            }
            if profile.method == .apple {
                SettingsFactSection(title: "Signed in with Apple", bullets: [
                    "Apple asks you to confirm. SnapList never sees a password, and this step alone deletes nothing."
                ], usesBullets: false)
            } else if emailCodeDelivery == .sent {
                SettingsEmailCodeField(
                    code: $code,
                    isFocused: $codeFocused
                )
                Text("Tap the boxes to enter the code. Resend is available after a minute.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Text("Nothing has been deleted. Leaving this screen keeps your account exactly as it is.")
                .foregroundStyle(.secondary)
        }
        .navigationTitle("Confirm it’s you")
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            SettingsActionTray(
                primary: primaryActionTitle,
                secondary: "Cancel",
                destructive: false,
                disabled: primaryActionDisabled,
                primaryAction: performPrimaryAction,
                secondaryAction: cancelReauthentication
            )
            .padding(
                .bottom,
                reservesFloatingDock
                    ? SnapListMetrics.dockHeight + SnapListMetrics.dockBottomInset
                    : 0
            )
        }
        .navigationDestination(isPresented: $confirmed) {
            SettingsDeletionConfirmationView(
                subscriptionTruth: subscriptionTruth,
                keepAccount: keepAccount,
                // DEL-06r's exit. Dismissing the confirmation lands back on this
                // screen, and `onChange` below already clears the code and sends
                // a fresh one, which is what a second verification needs.
                returnToReauthentication: { confirmed = false },
                reservesFloatingDock: reservesFloatingDock
            )
        }
        .task { await prepareEmailCodeIfNeeded() }
        .onChange(of: confirmed) { wasConfirmed, isConfirmed in
            guard wasConfirmed && !isConfirmed else { return }
            code = ""
            failed = false
            emailCodeDelivery = .sending
            Task { await prepareEmailCodeIfNeeded() }
        }
        .accessibilityIdentifier(failed ? "settings.state.del-02f" : "settings.state.del-02")
    }

    private func verify() {
        working = true
        Task {
            do {
                confirmed = try await SettingsReauthentication.verify(
                    method: profile.method,
                    code: code
                )
                if !confirmed { showFailure() }
            } catch let error as ASAuthorizationError where error.code == .canceled {
                failed = false
                AccessibilityNotification.Announcement(
                    "Cancelled. Nothing has been deleted."
                ).post()
            } catch {
                showFailure()
            }
            working = false
        }
    }

    private var primaryActionTitle: String {
        if profile.method == .apple { return "Verify with Apple" }
        return emailCodeDelivery == .failed ? "Try again" : "Verify"
    }

    private var primaryActionDisabled: Bool {
        guard !working else { return true }
        guard profile.method == .emailCode else { return false }
        switch emailCodeDelivery {
        case .sending: return true
        case .sent: return code.count != 6
        case .failed: return false
        }
    }

    private func performPrimaryAction() {
        if profile.method == .emailCode, emailCodeDelivery == .failed {
            Task { await prepareEmailCodeIfNeeded() }
        } else {
            verify()
        }
    }

    private func showFailure() {
        code = ""
        failed = true
        errorFocused = true
    }

    private func prepareEmailCodeIfNeeded() async {
        guard profile.method == .emailCode else { return }
        emailCodeDelivery = .sending
        failed = false
        emailCodeDelivery = await SettingsReauthentication.prepareEmailCode(
            displayedPrimaryAddressID: profile.emailAddressID
        )
        if emailCodeDelivery == .failed {
            code = ""
            errorFocused = true
        }
    }

    private func cancelReauthentication() {
        AccessibilityNotification.Announcement(
            "Cancelled. Nothing has been deleted."
        ).post()
        if let proofSafeExit {
            proofSafeExit()
        } else {
            isPresented = false
        }
    }
}

/**
 Issue #385. How the deletion route reaches a real server.

 The default deletes nothing and says which kind of nothing. Reporting the same
 refusal a real server produces would make an unwired build indistinguishable
 from a server outage, and an unwired build is exactly how this issue shipped
 the first time: every screen rendered, nothing was deleted, and the suite
 stayed green because the tests injected dependencies directly.

 The assertion is the second half of that. A debug or test run that reaches this
 default has lost the environment somewhere between the settings route and the
 tail, and it should stop there rather than render a plausible failure screen.
 */
private struct AccountDeletionDependenciesKey: EnvironmentKey {
    static let defaultValue = AccountDeletionCoordinator.Dependencies(
        requestErasure: { _ in
            assertionFailure(
                "Account deletion reached the unconfigured default. The settings route did not supply real dependencies."
            )
            return .notConfirmed(.clientNotConfigured)
        },
        clearDeviceState: { false },
        signOut: { false },
        newIdempotencyKey: { UUID().uuidString.lowercased() },
        maximumStatusFollowUps: 0
    )
}

extension EnvironmentValues {
    var accountDeletionDependencies: AccountDeletionCoordinator.Dependencies {
        get { self[AccountDeletionDependenciesKey.self] }
        set { self[AccountDeletionDependenciesKey.self] = newValue }
    }
}

/// Owns one deletion and renders whatever state it is in. The coordinator is
/// created once per host so a redraw cannot start a second erasure.
private struct SettingsDeletionTailHost: View {
    let subscriptionTruth: SettingsDeletionSubscriptionTruth
    let leave: () -> Void
    var confirmIdentityAgain: (() -> Void)?
    var reservesFloatingDock = false

    @Environment(\.accountDeletionDependencies)
    private var dependencies
    @State private var coordinator: AccountDeletionCoordinator?

    var body: some View {
        SettingsDeletionTailView(
            phase: coordinator?.phase ?? .requesting,
            subscriptionTruth: subscriptionTruth,
            retry: { Task { await coordinator?.retry() } },
            leave: leave,
            confirmIdentityAgain: confirmIdentityAgain ?? leave,
            reservesFloatingDock: reservesFloatingDock
        )
        .task {
            guard coordinator == nil else { return }
            let coordinator = AccountDeletionCoordinator(
                dependencies: dependencies
            )
            self.coordinator = coordinator
            await coordinator.deleteAccount()
        }
    }
}

/**
 Issue #385. DEL-04 through DEL-08, plus DEL-07f.

 Copy is the approved package's candidate golden for each state, except DEL-08's
 footnote: the package wrote it for a build that signs out when the seller taps
 Done, and this build signs out before the state is shown, so the packaged
 sentence would be false here. The package names DEL-08's terminal wording as
 #384's to write, which is the authority this change is under.

 DEL-07f has no golden. The package's DEL-07 assumed clearing succeeds, and a
 device that will not give up its copies needs a state that says so rather than
 borrowing DEL-06, whose two bullets ("Nothing on this iPhone has been cleared",
 "could not confirm") would both be false here.
 */
private struct SettingsDeletionTailView: View {
    let phase: AccountDeletionPhase
    let subscriptionTruth: SettingsDeletionSubscriptionTruth
    let retry: () -> Void
    let leave: () -> Void
    let confirmIdentityAgain: () -> Void
    var reservesFloatingDock = false

    var body: some View {
        SettingsExplanationPage(title: heading, lead: lead) {
            SettingsFactSection(title: "", bullets: bullets, usesBullets: false)
        }
        .navigationTitle(phase.reportsDeletion ? "SnapList" : "Delete account")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(true)
        .safeAreaInset(edge: .bottom) {
            tray.padding(
                .bottom,
                reservesFloatingDock
                    ? SnapListMetrics.dockHeight + SnapListMetrics.dockBottomInset
                    : 0
            )
        }
        .accessibilityIdentifier(
            "settings.state.\(phase.stateID.lowercased())"
        )
    }

    private var heading: String {
        switch phase {
        case .confirming, .requesting: "Deleting your account"
        case .unfinished: "This deletion has not finished"
        case .stalled(.needsAttention): "This deletion stopped partway"
        case .stalled(.keyConflict): "SnapList cannot continue this deletion"
        case .stalled(.appNotConfigured): "This build cannot delete accounts"
        case .failed: "The deletion did not finish"
        case .reverificationExpired: "Confirm it is you again"
        case .clearingDevice: "Clearing this iPhone"
        case .deviceNotCleared: "This iPhone was not fully cleared"
        case .deleted: "Your account is deleted"
        }
    }

    private var lead: String {
        switch phase {
        case .confirming, .requesting:
            "SnapList sent the request and is waiting for the server to report."
        case .unfinished:
            "SnapList sent your request and has not been told it finished."
        case .stalled(.needsAttention):
            "Your deletion started and stopped partway. Asking the server again may finish it."
        case .stalled(.keyConflict):
            "The server is already working on a deletion for this account that this iPhone cannot continue."
        case .stalled(.appNotConfigured):
            "This copy of SnapList was built without a way to reach the deletion service, so no request was sent."
        case .failed:
            "SnapList could not confirm that the server finished deleting this account."
        case .reverificationExpired:
            "Too much time passed since you confirmed your identity, so the server would not accept the request."
        case .clearingDevice:
            "The server reported that the deletion finished. SnapList is removing what is stored on this device."
        case .deviceNotCleared:
            "Your account is deleted. Some of what SnapList stored on this iPhone is still here."
        case .deleted:
            "The server reported the deletion as finished and this iPhone has been cleared. You are signed out."
        }
    }

    private var bullets: [String] {
        switch phase {
        case .confirming, .requesting:
            ["Nothing on this iPhone is cleared until the server reports that it finished."]
        case .unfinished:
            [
                "SnapList can ask the server for the current state.",
                "Nothing on this iPhone has been cleared.",
            ]
        case .stalled(.needsAttention):
            [
                "Some of your account may already be deleted, including your sign-in.",
                "Nothing on this iPhone has been cleared.",
            ]
        case .stalled(.keyConflict):
            [
                "Nothing on this iPhone has been cleared.",
                "Your account may still be deleted by the request already running.",
            ]
        case .stalled(.appNotConfigured):
            [
                "Nothing has been deleted and nothing on this iPhone has been cleared.",
                "Your account is unchanged.",
            ]
        case .failed:
            [
                "Nothing on this iPhone has been cleared.",
                "You can try again, or leave and come back to it.",
            ]
        case .reverificationExpired:
            [
                "Nothing has been deleted and nothing on this iPhone has been cleared.",
                "Confirming your identity again returns you to the last step.",
            ]
        case .clearingDevice:
            ["This step begins only after the server reported. It never runs beside the request."]
        case .deviceNotCleared:
            [
                "Your account and its data are gone from SnapList's servers.",
                "You are still signed in on this iPhone so that you can try the removal again.",
            ]
        case .deleted(let retainedRecords):
            // Only what the server actually reported as retained. The packaged
            // eBay line used to be unconditional, which asserted a live listing
            // for a seller who had none and read as a near-duplicate for a
            // seller who did. Its instruction now rides the retained record.
            retainedRecords.map(\.sellerFacingCopy) + [subscriptionTruth.shortCopy]
        }
    }

    @ViewBuilder private var tray: some View {
        switch phase {
        case .confirming, .requesting, .clearingDevice:
            // Nothing the seller can usefully do, so no control pretends they can.
            EmptyView()
        case .unfinished:
            SettingsActionTray(
                primary: "Check the server again",
                secondary: "Not now",
                destructive: false,
                primaryAction: retry,
                secondaryAction: leave
            )
        case .stalled(let stall) where stall.allowsAnotherRequest:
            // DEL-05's tray. The server does not treat this status as terminal,
            // so the same key resumes the erasure rather than replaying an
            // answer, and the seller's data is already gone by the time they
            // read this. Taking the control away would strand them.
            SettingsActionTray(
                primary: "Check the server again",
                secondary: "Not now",
                destructive: false,
                primaryAction: retry,
                secondaryAction: leave
            )
        case .stalled:
            // The remaining stalls answer the same way however many times they
            // are asked, and a control that cannot work is worse than none.
            SettingsActionTray(
                primary: "Back to Settings",
                secondary: nil,
                destructive: false,
                primaryAction: leave,
                secondaryAction: leave
            )
        case .failed:
            SettingsActionTray(
                primary: "Try again",
                secondary: "Back to Settings",
                destructive: false,
                primaryAction: retry,
                secondaryAction: leave
            )
        case .reverificationExpired:
            SettingsActionTray(
                primary: "Confirm it is you",
                secondary: "Back to Settings",
                destructive: false,
                primaryAction: confirmIdentityAgain,
                secondaryAction: leave
            )
        case .deviceNotCleared:
            SettingsActionTray(
                primary: "Try removing it again",
                secondary: "Not now",
                destructive: false,
                note: "Leaving now keeps you signed in so this can be finished later.",
                primaryAction: retry,
                secondaryAction: leave
            )
        case .deleted:
            // One control. Passing an empty secondary label still rendered a
            // 52pt tappable button with no name on it.
            SettingsActionTray(
                primary: "Done",
                secondary: nil,
                destructive: false,
                note: "Done returns to the signed-out entry.",
                primaryAction: leave,
                secondaryAction: leave
            )
        }
    }
}

private extension AccountErasureRetainedRecord {
    /// What survived the erasure, named plainly. The server reports these as
    /// part of a completed deletion, so leaving them unsaid would make a true
    /// completion read as a wider one than it is.
    var sellerFacingCopy: String {
        switch self {
        case .ebayLiveListing:
            "A listing you published is still live on eBay. SnapList does not own it and cannot end it, so end it in eBay."
        case .hostedTranscriptionProviderCopy:
            "A transcription provider still holds its own copy of a voice note. SnapList has asked for its removal and cannot confirm it."
        }
    }
}

private struct SettingsDeletionConfirmationView: View {
    let subscriptionTruth: SettingsDeletionSubscriptionTruth
    let keepAccount: () -> Void
    var returnToReauthentication: (() -> Void)?
    var reservesFloatingDock = false

    @State private var deleting = false

    var body: some View {
        SettingsExplanationPage(
            title: "Delete this account?",
            lead: "This is the last step. It deletes your SnapList account, your items, your photos and your drafts, and removes your eBay connection from SnapList."
        ) {
            SettingsFactSection(title: "", bullets: [
                "It's you, confirmed a moment ago. Nothing is sent until you tap Delete account.",
                "Your eBay listings stay on eBay. End them in eBay if you want them gone.",
                subscriptionTruth.shortCopy
            ], usesBullets: false)
        }
        .navigationTitle("Delete account")
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            // The destructive control the screen's own copy promises. Until
            // #385 this tray offered only "Keep my account", so a seller who
            // read "This is the last step." and reauthenticated with a real
            // credential had no way to finish and nothing happened.
            VStack(spacing: 12) {
                // Packaged DEL-03 footnote, and true of this build: the tap is
                // the only thing that sends the request.
                Text("Keep my account is the safe way out and it works right up to the tap.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, SnapListMetrics.screenGutter)
                SettingsActionTray(
                    primary: "Delete account",
                    secondary: "Keep my account",
                    destructive: true,
                    primaryAction: { deleting = true },
                    secondaryAction: keepAccount
                )
            }
            .padding(
                .bottom,
                reservesFloatingDock
                    ? SnapListMetrics.dockHeight + SnapListMetrics.dockBottomInset
                    : 0
            )
        }
        .navigationDestination(isPresented: $deleting) {
            SettingsDeletionTailHost(
                subscriptionTruth: subscriptionTruth,
                leave: keepAccount,
                confirmIdentityAgain: {
                    deleting = false
                    returnToReauthentication?()
                },
                reservesFloatingDock: reservesFloatingDock
            )
        }
        .accessibilityIdentifier("settings.state.del-03")
    }
}

private struct SettingsEmailCodeField: View {
    @Binding var code: String
    let isFocused: FocusState<Bool>.Binding

    var body: some View {
        let presentation = SettingsEmailCodePresentation(code: code)
        ZStack {
            HStack(spacing: 8) {
                ForEach(0..<6, id: \.self) { index in
                    Text(index < presentation.digits.count
                        ? presentation.digits[index]
                        : "")
                        .font(.title2.bold())
                        .frame(maxWidth: .infinity, minHeight: 56)
                        .background(SnapListColorToken.canvas.color, in: RoundedRectangle(cornerRadius: 12))
                        .overlay {
                            let isActive = isFocused.wrappedValue
                                && presentation.focusedBoxIndex == index
                            RoundedRectangle(cornerRadius: 12).stroke(
                                isActive
                                    ? SnapListColorToken.action.color
                                    : SnapListColorToken.otpInactiveBorder.color,
                                lineWidth: isActive ? 2 : 1
                            )
                        }
                }
            }
            .accessibilityHidden(true)

            TextField("6-digit code", text: $code)
                .keyboardType(.numberPad)
                .textContentType(.oneTimeCode)
                .onChange(of: code) { _, value in
                    code = String(value.filter(\.isNumber).prefix(6))
                }
                .focused(isFocused)
                .foregroundStyle(.clear)
                .tint(.clear)
                .frame(maxWidth: .infinity, minHeight: 56)
                .contentShape(Rectangle())
                .accessibilityValue(presentation.accessibilityValue)
        }
        .accessibilityElement(children: .contain)
    }
}

private struct SettingsExplanationPage<Content: View>: View {
    let title: String
    var lead: String? = nil
    var titleFont: Font = .title.bold()
    var leadFont: Font = .body
    var horizontalPadding: CGFloat = 20
    var verticalPadding: CGFloat = 20
    var titleToLeadSpacing: CGFloat = 22
    var contentTopSpacing: CGFloat = 22
    var contentSectionSpacing: CGFloat = 22
    @ViewBuilder let content: Content
    @AccessibilityFocusState private var headingFocused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text(title)
                    .font(titleFont)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityFocused($headingFocused)
                if let lead {
                    Text(lead)
                        .font(leadFont)
                        .padding(.top, titleToLeadSpacing)
                }
                VStack(alignment: .leading, spacing: contentSectionSpacing) {
                    content
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, contentTopSpacing)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, horizontalPadding)
            .padding(.vertical, verticalPadding)
        }
        .background(SnapListColorToken.mutedSurface.color)
        .onAppear { headingFocused = true }
    }
}

private struct SettingsFactSection: View {
    let title: String
    let bullets: [String]
    var usesBullets = true
    var bulletColor = SnapListColorToken.bulletNeutral.color
    var rowFont: Font = .body
    var rowVerticalPadding: CGFloat = 13
    var rowHorizontalPadding: CGFloat = 14
    var bulletSpacing: CGFloat = 10
    var headerToCardSpacing: CGFloat = 8

    var body: some View {
        VStack(alignment: .leading, spacing: headerToCardSpacing) {
            if !title.isEmpty {
                Text(title.uppercased()).font(.caption.weight(.semibold))
                    .tracking(1).foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(bullets.enumerated()), id: \.offset) { index, text in
                    HStack(alignment: .top, spacing: bulletSpacing) {
                        if usesBullets { Text("•").foregroundStyle(bulletColor) }
                        Text(text)
                            .font(rowFont)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.vertical, rowVerticalPadding)
                    if index < bullets.count - 1 { Divider() }
                }
            }
            .padding(.horizontal, rowHorizontalPadding)
            .background(SnapListColorToken.canvas.color, in: RoundedRectangle(cornerRadius: 14))
            .overlay { RoundedRectangle(cornerRadius: 14).stroke(SnapListColorToken.neutralOutline.color) }
        }
    }
}

private struct SettingsDeletionBoundarySection: View {
    let subscriptionCopy: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6.5) {
            Text("WHAT THIS DOES NOT DO")
                .font(.caption.weight(.semibold))
                .tracking(1)
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 0) {
                boundary(
                    title: "It does not end your eBay listings",
                    body: "Listings you already published stay on eBay and keep selling. Deleting this account removes the eBay connection from SnapList, so SnapList can no longer see or change them. Ending a listing is done in eBay."
                )
                Divider()
                boundary(
                    title: "It does not cancel SnapList Pro",
                    body: subscriptionCopy
                )
            }
            .background(SnapListColorToken.canvas.color, in: RoundedRectangle(cornerRadius: 14))
            .overlay {
                RoundedRectangle(cornerRadius: 14)
                    .stroke(SnapListColorToken.neutralOutline.color)
            }
        }
    }

    private func boundary(title: String, body: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.system(size: 16, weight: .semibold))
            Text(body)
                .font(.system(size: 16))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.vertical, 16)
    }
}

private struct SettingsActionTray<Destination: View>: View {
    let primary: String
    /// `nil` when the state has one control. An empty string still rendered a
    /// full-height unlabelled button, which is a tap target with no name.
    let secondary: String?
    let destructive: Bool
    var disabled = false
    var note: String? = nil
    let primaryAction: () -> Void
    let secondaryAction: () -> Void
    var destination: Destination?

    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    init(
        primary: String, secondary: String?, destructive: Bool,
        disabled: Bool = false, note: String? = nil,
        primaryAction: @escaping () -> Void,
        secondaryAction: @escaping () -> Void,
        destination: Destination? = nil
    ) {
        self.primary = primary; self.secondary = secondary
        self.destructive = destructive; self.disabled = disabled; self.note = note
        self.primaryAction = primaryAction; self.secondaryAction = secondaryAction
        self.destination = destination
    }

    var body: some View {
        VStack(spacing: 10) {
            if let destination {
                NavigationLink(destination: destination) { primaryLabel }
                    .buttonStyle(.plain).disabled(disabled)
            } else {
                Button(action: primaryAction) { primaryLabel }
                    .buttonStyle(.plain).disabled(disabled)
            }
            if let secondary {
                Button(action: secondaryAction) {
                    Text(secondary)
                        .font(.headline).foregroundStyle(.primary)
                        .frame(maxWidth: .infinity, minHeight: 52)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .background(commitsAccountDeletion ? SnapListColorToken.action.color : SnapListColorToken.neutralFill.color, in: RoundedRectangle(cornerRadius: 18))
                .foregroundStyle(commitsAccountDeletion ? SnapListColorToken.onDarkSurface.color : .primary)
            }
            if let note { Text(note).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center) }
        }
        .padding(.horizontal, 20).padding(.vertical, 12)
        // `.bar` is translucent chrome with nothing under it here, so a
        // seller with Reduce Transparency on falls back to the same opaque
        // canvas token `FloatingDock` already uses for its chrome (#831).
        .background {
            if reduceTransparency {
                SnapListColorToken.canvas.color
            } else {
                Rectangle().fill(.bar)
            }
        }
    }

    private var commitsAccountDeletion: Bool {
        destructive && primary == "Delete account"
    }

    private var primaryLabel: some View {
        Text(primary).font(.headline)
            .foregroundStyle(destructive ? SnapListColorToken.destructiveText.color : SnapListColorToken.onDarkSurface.color)
            .frame(maxWidth: .infinity, minHeight: 52)
            .background(
                commitsAccountDeletion
                    ? SnapListColorToken.canvas.color
                    : destructive ? Color.clear : SnapListColorToken.action.color,
                in: RoundedRectangle(cornerRadius: 18)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 18).stroke(
                    commitsAccountDeletion ? SnapListColorToken.destructiveBorder.color : .clear,
                    lineWidth: 1
                )
            }
    }
}

private extension SettingsActionTray where Destination == EmptyView {
    init(
        primary: String, secondary: String?, destructive: Bool,
        disabled: Bool = false, note: String? = nil,
        primaryAction: @escaping () -> Void,
        secondaryAction: @escaping () -> Void
    ) {
        self.init(
            primary: primary, secondary: secondary, destructive: destructive,
            disabled: disabled, note: note, primaryAction: primaryAction,
            secondaryAction: secondaryAction, destination: nil
        )
    }
}

private struct SettingsProfile {
    let isGuest: Bool
    let name: String
    let email: String
    let emailAddressID: String?
    let initials: String
    let method: SettingsAuthenticationMethod
    var methodLabel: String { method == .apple ? "Apple" : "Email code" }
    var identity: SettingsIdentity {
        isGuest ? .guest : .member(method: method, email: email)
    }

    @MainActor
    static func current(configuration: LaunchConfiguration) -> Self {
#if DEBUG
        if configuration.usesZeroNetworkFixtures && configuration.fixture == .account {
            return Self(
                isGuest: false,
                name: "Jordan Hale",
                email: "jordan.hale@icloud.com",
                emailAddressID: "fixture-primary-email",
                initials: "JH",
                method: .apple
            )
        }
#endif
        guard let user = Clerk.shared.user else {
            return Self(
                isGuest: true,
                name: "Guest",
                email: "Not signed in",
                emailAddressID: nil,
                initials: "G",
                method: .emailCode
            )
        }
        let name = [user.firstName, user.lastName].compactMap { $0 }.joined(separator: " ")
        let apple = user.verifiedExternalAccounts.contains { $0.provider == "oauth_apple" }
        return Self(
            isGuest: false,
            name: name.isEmpty ? "SnapList seller" : name,
            email: user.primaryEmailAddress?.emailAddress ?? "Signed in",
            emailAddressID: user.primaryEmailAddress?.id,
            initials: [user.firstName?.first, user.lastName?.first].compactMap { $0 }.map(String.init).joined().uppercased().nonEmpty ?? "S",
            method: apple ? .apple : .emailCode
        )
    }
}

@MainActor
private enum SettingsReauthentication {
    static func prepareEmailCode(
        displayedPrimaryAddressID: String?
    ) async -> SettingsEmailCodeDeliveryState {
        guard let session = Clerk.shared.session else { return .failed }
        do {
            let verification = try await session.startVerification(
                level: .firstFactor
            )
            let supportedEmailAddressIDs = verification.supportedFirstFactors?
                .filter { $0.strategy == .emailCode }
                .compactMap(\.emailAddressId) ?? []
            return await SettingsEmailCodeChallenge.send(
                displayedPrimaryAddressID: displayedPrimaryAddressID,
                supportedEmailAddressIDs: supportedEmailAddressIDs,
                sender: { emailAddressID in
                    try await session.sendEmailCode(
                        emailAddressId: emailAddressID
                    )
                }
            )
        } catch {
            return .failed
        }
    }

    static func verify(method: SettingsAuthenticationMethod, code: String) async throws -> Bool {
        switch method {
        case .emailCode:
            guard let session = Clerk.shared.session else { return false }
            guard try await session.verifyWithEmailCode(code: code).status == .complete else {
                return false
            }
            return try await session.getToken(.init(skipCache: true)) != nil
        case .apple:
            guard let originalUserID = Clerk.shared.user?.id else { return false }
            let result = try await Clerk.shared.auth.signInWithApple(requestedScopes: [], transferable: false)
            guard case .signIn(let signIn) = result,
                  signIn.status == .complete,
                  let sessionID = signIn.createdSessionId,
                  let fresh = Clerk.shared.client?.sessions.first(where: { $0.id == sessionID }),
                  SettingsReauthenticationGate.isSameAccount(
                    originalUserID: originalUserID,
                    verifiedUserID: fresh.user?.id
                  ) else { return false }
            try await Clerk.shared.auth.setActive(sessionId: sessionID)
            return try await fresh.getToken(.init(skipCache: true)) != nil
        }
    }
}

private enum SettingsReauthenticationError: Error { case unavailable }

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
