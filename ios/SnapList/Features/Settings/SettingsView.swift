import AuthenticationServices
import ClerkKit
import StoreKit
import SwiftUI

@MainActor
struct SettingsView: View {
    private let profile: SettingsProfile
    private let mobileAPIClient: any MobileAPIClient
    private let removeLocalData: () async -> Bool
    private let deletionBoundary: () -> Void
    @State private var hasLocalData: Bool
    @State private var subscriptionStore: SubscriptionStore
    @State private var subscriptionLoadPhase =
        SettingsSubscriptionPresentation.LoadPhase.loading
    @State private var managesSubscription = false

    init(
        configuration: LaunchConfiguration,
        mobileAPIClient: any MobileAPIClient,
        subscriptionClient: any SubscriptionClient,
        hasLocalData: Bool,
        removeLocalData: @escaping () async -> Bool,
        deletionBoundary: @escaping () -> Void = {}
    ) {
        profile = .current(configuration: configuration)
        self.mobileAPIClient = mobileAPIClient
        self.removeLocalData = removeLocalData
        self.deletionBoundary = deletionBoundary
        _hasLocalData = State(initialValue: hasLocalData)
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
                valueRow("Connected marketplaces", profile.isGuest ? "Not connected" : "eBay", chevron: true)
                valueRow("Photos", "Selected photos", chevron: true)
                valueRow("Notifications", "On", chevron: true)
            }
            if !profile.isGuest { subscriptionSection }
            Section("About") {
                navigationRow("Help")
                navigationRow("Privacy Policy")
                navigationRow("Terms of Service")
            }
            Section("This iPhone") {
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
            } footer: {
                Text("This covers the copies SnapList keeps on this iPhone. It does not reach anything the server holds.")
            }
            if !profile.isGuest {
                Section("Account management") {
                    Button("Sign out") {
                        Task { try? await Clerk.shared.auth.signOut() }
                    }
                    .accessibilityLabel("Sign out of SnapList")
                    NavigationLink {
                        SettingsDeletionConsequencesView(
                            profile: profile,
                            subscriptionState: subscriptionStore.state,
                            deletionBoundary: deletionBoundary
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
        .manageSubscriptionsSheet(isPresented: $managesSubscription)
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
        Section("Subscription") {
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
                        Task { await subscriptionStore.restore() }
                    }
                case .retry:
                    Button("Try again") { Task { await loadSubscription() } }
                }
            }
        } footer: {
            VStack(alignment: .leading, spacing: 6) {
                if let note = presentation.note { Text(note) }
                if presentation.showsOwnershipNote {
                    Text("Apple bills and cancels SnapList Pro. SnapList cannot cancel it for you.")
                }
            }
        }
        .accessibilityIdentifier("settings.subscription.\(presentation.stateID.lowercased())")
    }

    private func loadSubscription() async {
        subscriptionLoadPhase = .loading
        do {
            let configuration = try await mobileAPIClient
                .getRevenueCatConfiguration().data.subscriptionConfiguration
            await subscriptionStore.load(configuration: configuration)
            let verified = try await mobileAPIClient
                .getAiItemEntitlement().data.serverVerifiedSubscription
            subscriptionStore.applyServerVerification(verified)
            subscriptionLoadPhase = .loaded
        } catch {
            subscriptionLoadPhase = .failed
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
    let subscriptionState: SubscriptionStore.State
    let deletionBoundary: () -> Void
    @State private var managesSubscription = false

    var body: some View {
        let truth = SettingsDeletionSubscriptionTruth(state: subscriptionState)
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
                "It does not cancel SnapList Pro\n\(truth.longCopy)"
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
                    subscriptionTruth: truth,
                    deletionBoundary: deletionBoundary,
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
    let deletionBoundary: () -> Void
    let keepAccount: () -> Void
    @State private var code = ""
    @State private var failed = false
    @State private var confirmed = false
    @State private var working = false
    @AccessibilityFocusState private var errorFocused: Bool

    var body: some View {
        SettingsExplanationPage(
            title: "Confirm it’s you",
            lead: profile.method == .apple
                ? "Deleting an account is permanent, so SnapList asks the system to confirm you before it sends anything."
                : "Deleting an account is permanent, so SnapList sent a 6-digit code to \(profile.email). Enter it to confirm it is you."
        ) {
            if failed {
                Text("That did not confirm it was you. Nothing has been deleted. You can try again.")
                    .padding().background(Color(hex: "#F2F3F5"), in: RoundedRectangle(cornerRadius: 14))
                    .accessibilityFocused($errorFocused)
            }
            if profile.method == .apple {
                SettingsFactSection(title: "Signed in with Apple", bullets: [
                    "Apple asks you to confirm. SnapList never sees a password, and this step alone deletes nothing."
                ], usesBullets: false)
            } else {
                TextField("6-digit code", text: $code)
                    .keyboardType(.numberPad)
                    .textContentType(.oneTimeCode)
                    .onChange(of: code) { _, value in
                        code = String(value.filter(\.isNumber).prefix(6))
                    }
                    .textFieldStyle(.roundedBorder)
            }
            Text("Nothing has been deleted. Leaving this screen keeps your account exactly as it is.")
                .foregroundStyle(.secondary)
        }
        .navigationTitle("Confirm it’s you")
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            SettingsActionTray(
                primary: profile.method == .apple ? "Verify with Apple" : "Verify",
                secondary: "Cancel",
                destructive: false,
                disabled: working || (profile.method == .emailCode && code.count != 6),
                primaryAction: verify,
                secondaryAction: { dismiss() }
            )
        }
        .navigationDestination(isPresented: $confirmed) {
            SettingsDeletionConfirmationView(
                subscriptionTruth: subscriptionTruth,
                deletionBoundary: deletionBoundary,
                keepAccount: keepAccount
            )
        }
        .task {
            guard profile.method == .emailCode else { return }
            do { try await SettingsReauthentication.prepareEmailCode() }
            catch { showFailure() }
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
            } catch {
                showFailure()
            }
            working = false
        }
    }

    private func showFailure() {
        code = ""
        failed = true
        errorFocused = true
    }
}

private struct SettingsDeletionConfirmationView: View {
    let subscriptionTruth: SettingsDeletionSubscriptionTruth
    let deletionBoundary: () -> Void
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
            Text("It’s you, confirmed a moment ago. Nothing is sent until you tap Delete account.")
                .foregroundStyle(.secondary)
        }
        .navigationTitle("Delete account")
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            SettingsActionTray(
                primary: "Delete account",
                secondary: "Keep my account",
                destructive: true,
                note: "Keep my account is the safe way out and it works right up to the tap.",
                primaryAction: deletionBoundary,
                secondaryAction: keepAccount
            )
        }
        .accessibilityIdentifier("settings.state.del-03")
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
                    .font(.system(size: 28, weight: .bold))
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
    let initials: String
    let method: SettingsAuthenticationMethod
    var methodLabel: String { method == .apple ? "Apple" : "Email code" }

    static func current(configuration: LaunchConfiguration) -> Self {
#if DEBUG
        if configuration.usesZeroNetworkFixtures && configuration.fixture == .account {
            return Self(isGuest: false, name: "Jordan Hale", email: "jordan.hale@icloud.com", initials: "JH", method: .apple)
        }
#endif
        guard let user = Clerk.shared.user else {
            return Self(isGuest: true, name: "Guest", email: "Not signed in", initials: "G", method: .emailCode)
        }
        let name = [user.firstName, user.lastName].compactMap { $0 }.joined(separator: " ")
        let apple = user.verifiedExternalAccounts.contains { $0.provider == "oauth_apple" }
        return Self(
            isGuest: false,
            name: name.isEmpty ? "SnapList seller" : name,
            email: user.primaryEmailAddress?.emailAddress ?? "Signed in",
            initials: [user.firstName?.first, user.lastName?.first].compactMap { $0 }.map(String.init).joined().uppercased().nonEmpty ?? "S",
            method: apple ? .apple : .emailCode
        )
    }
}

@MainActor
private enum SettingsReauthentication {
    static func prepareEmailCode() async throws {
        guard let session = Clerk.shared.session else { throw SettingsReauthenticationError.unavailable }
        let verification = try await session.startVerification(level: .firstFactor)
        guard let emailID = verification.supportedFirstFactors?
            .first(where: { $0.strategy == .emailCode })?.emailAddressId else {
            throw SettingsReauthenticationError.unavailable
        }
        try await session.sendEmailCode(emailAddressId: emailID)
    }

    static func verify(method: SettingsAuthenticationMethod, code: String) async throws -> Bool {
        switch method {
        case .emailCode:
            guard let session = Clerk.shared.session else { return false }
            return try await session.verifyWithEmailCode(code: code).status == .complete
        case .apple:
            guard let originalUserID = Clerk.shared.user?.id else { return false }
            let result = try await Clerk.shared.auth.signInWithApple(requestedScopes: [], transferable: false)
            guard case .signIn(let signIn) = result,
                  signIn.status == .complete,
                  let sessionID = signIn.createdSessionId,
                  let fresh = Clerk.shared.client?.sessions.first(where: { $0.id == sessionID }),
                  fresh.user?.id == originalUserID else { return false }
            try await Clerk.shared.auth.setActive(sessionId: sessionID)
            return true
        }
    }
}

private enum SettingsReauthenticationError: Error { case unavailable }

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
