import AuthenticationServices
import ClerkKit
import StoreKit
import SwiftUI

@MainActor
struct SettingsView: View {
    private let profile: SettingsProfile
    private let settingsProofState: SettingsProofState?
    private let settingsProofSafeExit: (() -> Void)?
    private let deletionFlowPresentationChanged: (Bool) -> Void
    private let mobileAPIClient: any MobileAPIClient
    private let removeLocalData: () async -> Bool
    private let deletionOutstanding: Bool
    private let analyticsClient: any AnalyticsClient
    private let ebayPublishService: any EbayPublishFeatureServing
    private let navigate: (AppRoute) -> Void
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
                                    .frame(
                                        maxWidth: .infinity,
                                        alignment: .leading
                                    )
                            }
                            .accessibilityIdentifier("settings.create-account")
                            .accessibilityHint("Opens the account entry screen")
                        } else {
                            valueRow("Sign-in method", profile.methodLabel)
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
        .background(Color(hex: "#F5F6F7"))
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
                .background(Color(hex: "#E7E9EC"), in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text(profile.name).font(.headline)
                Text(profile.email).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 16)
        .frame(maxWidth: .infinity, minHeight: 74, maxHeight: 74, alignment: .leading)
        .background(Color.white, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
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
                case .manage:
                    Button {
                        managesSubscription = true
                    } label: {
                        HStack {
                            Text("Manage subscription in the App Store")
                            Spacer()
                            Image(systemName: "arrow.up.right.square")
                        }
                    }
                    .foregroundStyle(SnapListColorToken.action.color)
                    .accessibilityHint("Opens the App Store")
                case .restore:
                    Button("Restore purchase") {
                        Task { await restoreSubscription() }
                    }
                    .accessibilityHint("Asks Apple for a purchase on this Apple Account, then waits for the server to confirm it")
                case .retry:
                    Button("Try again") { Task { await loadSubscription() } }
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
        .accessibilityIdentifier("settings.subscription.\(presentation.stateID.lowercased())")
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
            .frame(height: 18, alignment: .leading)
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
                    .foregroundStyle(Color(hex: "#8A6D3B"))
            }
        }
        .font(.subheadline.weight(.medium))
        .foregroundStyle(.secondary)
        .frame(height: 18)
        .padding(.top, 19)
        .padding(.bottom, 3)
    }

    private func settingsCard<Content: View>(
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(spacing: 0, content: content)
            .background(Color.white, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    private func settingsCardRow<Content: View>(
        @ViewBuilder content: () -> Content
    ) -> some View {
        content()
            .frame(maxWidth: .infinity, minHeight: 52, maxHeight: 52, alignment: .leading)
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
        HStack {
            Text(label)
            Spacer()
            Text(value).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
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
            SettingsDeletionConfirmationView(
                subscriptionTruth: .unknown,
                keepAccount: onSafeExit,
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

private struct SettingsDeletionHeader: View {
    let back: () -> Void

    var body: some View {
        ZStack {
            Text("Delete account")
                .font(.headline)
                .accessibilityAddTraits(.isHeader)
            HStack {
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
                Spacer()
            }
        }
        .padding(.horizontal, 20)
        .frame(height: 56)
        .background(Color.white)
        .overlay(alignment: .bottom) { Divider() }
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
                    bulletColor: Color(hex: "#B42318"),
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
        .background(Color.white.ignoresSafeArea(edges: .top))
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
                    .padding().background(Color(hex: "#F2F3F5"), in: RoundedRectangle(cornerRadius: 14))
                    .accessibilityFocused($errorFocused)
            } else if failed {
                Text("That did not confirm it was you. Nothing has been deleted. You can try again.")
                    .padding().background(Color(hex: "#F2F3F5"), in: RoundedRectangle(cornerRadius: 14))
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

private struct SettingsDeletionConfirmationView: View {
    let subscriptionTruth: SettingsDeletionSubscriptionTruth
    let keepAccount: () -> Void
    var reservesFloatingDock = false

    var body: some View {
        SettingsExplanationPage(
            title: "Delete this account?",
            lead: "This is the last step. It deletes your SnapList account, your items, your photos and your drafts, and removes your eBay connection from SnapList."
        ) {
            SettingsFactSection(title: "", bullets: [
                "Your eBay listings stay on eBay. End them in eBay if you want them gone.",
                subscriptionTruth.shortCopy
            ], usesBullets: false)
        }
        .navigationTitle("Delete account")
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            SettingsConfirmationOnlyTray(keepAccount: keepAccount)
                .padding(
                    .bottom,
                    reservesFloatingDock
                        ? SnapListMetrics.dockHeight + SnapListMetrics.dockBottomInset
                        : 0
                )
        }
        .accessibilityIdentifier("settings.state.del-03")
    }
}

private struct SettingsConfirmationOnlyTray: View {
    let keepAccount: () -> Void

    var body: some View {
        Button(action: keepAccount) {
            Text("Keep my account")
                .font(.headline)
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity, minHeight: 52)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .background(
            SnapListColorToken.action.color,
            in: RoundedRectangle(cornerRadius: 18)
        )
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .background(.bar)
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
                        .background(.white, in: RoundedRectangle(cornerRadius: 12))
                        .overlay {
                            let isActive = isFocused.wrappedValue
                                && presentation.focusedBoxIndex == index
                            RoundedRectangle(cornerRadius: 12).stroke(
                                isActive
                                    ? SnapListColorToken.action.color
                                    : Color(hex: "#D6D8DC"),
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
        .background(Color(hex: "#F5F6F7"))
        .onAppear { headingFocused = true }
    }
}

private struct SettingsFactSection: View {
    let title: String
    let bullets: [String]
    var usesBullets = true
    var bulletColor = Color(hex: "#8A8E94")
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
            .background(.white, in: RoundedRectangle(cornerRadius: 14))
            .overlay { RoundedRectangle(cornerRadius: 14).stroke(Color(hex: "#E3E5E8")) }
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
            .background(.white, in: RoundedRectangle(cornerRadius: 14))
            .overlay {
                RoundedRectangle(cornerRadius: 14)
                    .stroke(Color(hex: "#E3E5E8"))
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
    let secondary: String
    let destructive: Bool
    var disabled = false
    var note: String? = nil
    let primaryAction: () -> Void
    let secondaryAction: () -> Void
    var destination: Destination?

    init(
        primary: String, secondary: String, destructive: Bool,
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
            Button(action: secondaryAction) {
                Text(secondary)
                    .font(.headline).foregroundStyle(.primary)
                    .frame(maxWidth: .infinity, minHeight: 52)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .background(destructive && primary == "Delete account" ? SnapListColorToken.action.color : Color(hex: "#F2F3F5"), in: RoundedRectangle(cornerRadius: 18))
            .foregroundStyle(destructive && primary == "Delete account" ? .white : .primary)
            if let note { Text(note).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center) }
        }
        .padding(.horizontal, 20).padding(.vertical, 12)
        .background(.bar)
    }

    private var commitsAccountDeletion: Bool {
        destructive && primary == "Delete account"
    }

    private var primaryLabel: some View {
        Text(primary).font(.headline)
            .foregroundStyle(destructive ? Color(hex: "#B42318") : .white)
            .frame(maxWidth: .infinity, minHeight: 52)
            .background(
                commitsAccountDeletion
                    ? Color.white
                    : destructive ? Color.clear : SnapListColorToken.action.color,
                in: RoundedRectangle(cornerRadius: 18)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 18).stroke(
                    commitsAccountDeletion ? Color(hex: "#E4B9B4") : .clear,
                    lineWidth: 1
                )
            }
    }
}

private extension SettingsActionTray where Destination == EmptyView {
    init(
        primary: String, secondary: String, destructive: Bool,
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
