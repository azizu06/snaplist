import AuthenticationServices
import ClerkKit
import StoreKit
import SwiftUI

@MainActor
struct SettingsView: View {
    private let profile: SettingsProfile
    private let mobileAPIClient: any MobileAPIClient
    private let removeLocalData: () async -> Bool
    private let deletionOutstanding: Bool
    private let analyticsClient: any AnalyticsClient
    private let ebayPublishService: any EbayPublishFeatureServing
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
        hasLocalData: Bool,
        removeLocalData: @escaping () async -> Bool,
        deletionOutstanding: Bool = false
    ) {
        profile = .current(configuration: configuration)
        self.mobileAPIClient = mobileAPIClient
        self.removeLocalData = removeLocalData
        self.deletionOutstanding = deletionOutstanding
        self.analyticsClient = analyticsClient
        self.ebayPublishService = ebayPublishService
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
        List {
            profileCard
            Section("Account") {
                if profile.isGuest {
                    Button("Create an account") {}
                } else {
                    valueRow("Sign-in method", profile.methodLabel)
                }
            }
            Section("Selling") {
                valueRow(
                    "Connected marketplaces",
                    sellingPresentation.marketplaceValue,
                    chevron: true
                )
                if let hint = sellingPresentation.hint {
                    sellingHintRow(hint)
                }
                valueRow("Photos", "Selected photos", chevron: true)
                valueRow("Notifications", "On", chevron: true)
            }
            Section("Privacy") {
                Toggle("Share usage analytics", isOn: analyticsConsentBinding)
                    .accessibilityIdentifier("settings.share-usage-analytics")
            }
            if SettingsSubscriptionVisibility(
                identity: profile.identity,
                deletionOutstanding: deletionOutstanding
            ).isVisible {
                subscriptionSection
            }
            Section("About") {
                navigationRow("Help")
                navigationRow("Privacy Policy")
                navigationRow("Terms of Service")
            }
            Section {
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
            } header: {
                Text("This iPhone")
            } footer: {
                Text("This covers the copies SnapList keeps on this iPhone. It does not reach anything the server holds.")
            }
            if !profile.isGuest {
                Section("Account management") {
                    NavigationLink {
                        SettingsDeletionConsequencesView(
                            profile: profile,
                            subscriptionTruth: SettingsDeletionSubscriptionTruth(
                                state: subscriptionStore.state,
                                loadPhase: subscriptionLoadPhase
                            )
                        )
                    } label: {
                        Text("Delete account")
                    }
                    .accessibilityIdentifier("settings.delete-account")
                    .accessibilityHint("Opens a screen that explains what deletion does")
                }
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    Text(SettingsGuestBoundaryCopy.title)
                        .font(.subheadline.weight(.semibold))
                    Text(SettingsGuestBoundaryCopy.body)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("settings.guest-boundary")
            }
            Text(
                "SnapList \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0") · \(Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1")"
            )
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .listRowBackground(Color.clear)
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .scrollContentBackground(.hidden)
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
        .task { await loadEbayConnection() }
        .task {
            guard !profile.isGuest else { return }
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
        .padding(.vertical, 8)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var subscriptionSection: some View {
        let presentation = SettingsSubscriptionPresentation(
            state: subscriptionStore.state,
            loadPhase: subscriptionLoadPhase
        )
        Section {
            valueRow("SnapList Pro", presentation.status)
            ForEach(Array(presentation.facts.enumerated()), id: \.offset) { _, fact in
                valueRow(fact.label, fact.value)
            }
            ForEach(presentation.actions, id: \.self) { action in
                switch action {
                case .manage:
                    Button("Manage subscription in the App Store") {
                        managesSubscription = true
                    }
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
        } header: {
            Text("Subscription")
        } footer: {
            VStack(alignment: .leading, spacing: 6) {
                if let note = presentation.note { Text(note) }
                if presentation.showsOwnershipNote {
                    Text("Apple bills and cancels SnapList Pro. SnapList cannot cancel it for you.")
                }
            }
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
        SettingsSellingPresentation(
            connection: ebayConnection,
            loadPhase: ebayConnectionLoadPhase
        )
    }

    @ViewBuilder
    private func sellingHintRow(
        _ hint: SettingsSellingPresentation.Hint
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(hint.message, systemImage: "exclamationmark.triangle")
                .font(.footnote)
                .labelStyle(.titleAndIcon)
            if let helpURL = hint.helpURL {
                Link("Open business policies on eBay", destination: helpURL)
                    .font(.footnote)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("settings.ebay-policy-hint")
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

    private func valueRow(_ label: String, _ value: String, chevron: Bool = false) -> some View {
        HStack {
            Text(label)
            Spacer()
            Text(value).foregroundStyle(.secondary)
            if chevron { Image(systemName: "chevron.right").foregroundStyle(.tertiary) }
        }
        .accessibilityElement(children: .combine)
    }

    private func navigationRow(_ label: String) -> some View {
        HStack { Text(label); Spacer(); Image(systemName: "chevron.right").foregroundStyle(.tertiary) }
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

private struct SettingsDeletionConsequencesView: View {
    @Environment(\.dismiss) private var dismiss
    let profile: SettingsProfile
    let subscriptionTruth: SettingsDeletionSubscriptionTruth
    @State private var managesSubscription = false

    var body: some View {
        SettingsExplanationPage(
            title: "Delete your SnapList account",
            lead: "Read what this does before you continue. You can still stop at every step."
        ) {
            SettingsFactSection(
                title: "What is deleted",
                bullets: [
                    "Your SnapList account and how you sign in",
                    "Your items, photos, drafts, voice notes and runs",
                    "Your price research and anything SnapList generated for you",
                    "Your eBay connection, removed from SnapList"
                ],
                bulletColor: Color(hex: "#B42318")
            )
            SettingsFactSection(title: "What this does not do", bullets: [
                "It does not end your eBay listings\nListings you already published stay on eBay and keep selling. Deleting this account removes the eBay connection from SnapList, so SnapList can no longer see or change them. Ending a listing is done in eBay.",
                "It does not cancel SnapList Pro\n\(subscriptionTruth.longCopy)"
            ], usesBullets: false)
            Button("Manage subscription in the App Store") { managesSubscription = true }
            Text("Nothing is deleted yet. The next step confirms it is you.")
                .font(.footnote).foregroundStyle(.secondary)
        }
        .navigationTitle("Delete account")
        .navigationBarTitleDisplayMode(.inline)
        .manageSubscriptionsSheet(isPresented: $managesSubscription)
        .safeAreaInset(edge: .bottom) {
            SettingsActionTray(
                primary: "Continue to delete my account",
                secondary: "Keep my account",
                destructive: true,
                note: "One more step after this, and it is not the deletion.",
                primaryAction: {},
                secondaryAction: { dismiss() },
                destination: SettingsReauthenticationView(
                    profile: profile,
                    subscriptionTruth: subscriptionTruth,
                    keepAccount: { dismiss() }
                )
            )
        }
        .accessibilityIdentifier("settings.state.del-01")
    }
}

private struct SettingsReauthenticationView: View {
    @Environment(\.dismiss) private var dismiss
    let profile: SettingsProfile
    let subscriptionTruth: SettingsDeletionSubscriptionTruth
    let keepAccount: () -> Void
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
        }
        .navigationDestination(isPresented: $confirmed) {
            SettingsDeletionConfirmationView(
                subscriptionTruth: subscriptionTruth,
                keepAccount: keepAccount
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
        dismiss()
    }
}

private struct SettingsDeletionConfirmationView: View {
    let subscriptionTruth: SettingsDeletionSubscriptionTruth
    let keepAccount: () -> Void

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
        }
        .accessibilityIdentifier("settings.state.del-03")
    }
}

private struct SettingsConfirmationOnlyTray: View {
    let keepAccount: () -> Void

    var body: some View {
        Button("Keep my account", action: keepAccount)
            .font(.headline)
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, minHeight: 52)
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
    @ViewBuilder let content: Content
    @AccessibilityFocusState private var headingFocused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                Text(title)
                    .font(.title.bold())
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityFocused($headingFocused)
                if let lead { Text(lead).font(.body) }
                content
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(20)
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

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !title.isEmpty {
                Text(title.uppercased()).font(.caption.weight(.semibold))
                    .tracking(1).foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(bullets.enumerated()), id: \.offset) { index, text in
                    HStack(alignment: .top, spacing: 10) {
                        if usesBullets { Text("•").foregroundStyle(bulletColor) }
                        Text(text).fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.vertical, 13)
                    if index < bullets.count - 1 { Divider() }
                }
            }
            .padding(.horizontal, 14)
            .background(.white, in: RoundedRectangle(cornerRadius: 14))
            .overlay { RoundedRectangle(cornerRadius: 14).stroke(Color(hex: "#E3E5E8")) }
        }
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
            Button(secondary, action: secondaryAction)
                .font(.headline).foregroundStyle(.primary)
                .frame(maxWidth: .infinity, minHeight: 52)
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
