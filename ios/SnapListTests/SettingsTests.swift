import XCTest
@testable import SnapList

final class SettingsTests: XCTestCase {
    func testShareUsageAnalyticsPreferenceDefaultsOnAndPersistsAcrossRelaunch() throws {
        let suiteName = "SettingsTests-analytics-consent-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let first = UserDefaultsAnalyticsConsentStore(defaults: defaults)
        XCTAssertEqual(first.consent, .granted)

        first.setConsent(.denied)
        XCTAssertEqual(
            UserDefaultsAnalyticsConsentStore(defaults: defaults).consent,
            .denied
        )

        first.setConsent(.granted)
        XCTAssertEqual(
            UserDefaultsAnalyticsConsentStore(defaults: defaults).consent,
            .granted
        )
    }

    func testNoOpAnalyticsClientPersistsTheSettingsToggle() throws {
        let suiteName = "SettingsTests-noop-analytics-consent-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = UserDefaultsAnalyticsConsentStore(defaults: defaults)
        let client = NoOpAnalyticsClient(consentStore: store)

        try client.setConsent(.denied)
        XCTAssertEqual(store.consent, .denied)

        try client.setConsent(.granted)
        XCTAssertEqual(store.consent, .granted)
    }

    func testAnalyticsToggleRetainsActualConsentAndReportsFailure() {
        let client = FailingSettingsAnalyticsClient()
        var state = SettingsAnalyticsConsentState(consent: .denied)

        state.request(true, using: client)

        XCTAssertFalse(state.isEnabled)
        XCTAssertTrue(state.showsError)
        XCTAssertEqual(client.requestedConsents, [.granted])
    }

    @MainActor
    func testSettingsEntryUsesTheTrophyWallProfileRoute() {
        let router = AppRouter(initialTab: .trophyWall)

        router.navigate(to: .settings)

        XCTAssertEqual(router.selectedTab, .trophyWall)
        XCTAssertEqual(
            router.pathBinding(for: .trophyWall).wrappedValue,
            [.settings]
        )
        XCTAssertEqual(FoundationFixture.account.initialTab, .trophyWall)
        XCTAssertEqual(FoundationFixture.account.initialRoute, .settings)
    }

    func testMemberAccountEntryDestinationDefaultsToNil() {
        let destination = SettingsAccountEntryPolicy.destination(
            for: .member(method: .apple, email: "seller@example.com")
        )

        XCTAssertNil(destination)
    }

    func testGuestAccountEntryUsesTypedAccountRoute() {
        XCTAssertEqual(
            SettingsAccountEntryPolicy.destination(for: .guest),
            .future(.account)
        )
    }

    func testSettingsProofStateDefaultsOff() {
        XCTAssertNil(LaunchConfiguration.standard.settingsProofState)
        XCTAssertNil(
            LaunchConfiguration.parse(arguments: []).settingsProofState
        )
    }

    func testSettingsProofFixturesAreExactAndDefaultDeny() {
        let approvedFixtureIDs = [
            "SET-01",
            "DEL-01",
            "DEL-02",
            "DEL-03",
        ]

        for fixtureID in approvedFixtureIDs {
            let configuration = LaunchConfiguration.parse(
                arguments: ["--settings-proof=\(fixtureID)"]
            )

            XCTAssertEqual(configuration.settingsProofState?.rawValue, fixtureID)
            XCTAssertEqual(configuration.fixture, .account)
            XCTAssertTrue(configuration.usesZeroNetworkFixtures)
        }

        for unrecognizedArgument in [
            "--settings-proof",
            "--settings-proof=SET-00",
            "--settings-proof=DEL-02f",
            "--settings-proof=DEL-04",
            "--settings-proof=SET-01-extra",
            "--settings-proof=production",
        ] {
            let configuration = LaunchConfiguration.parse(
                arguments: [unrecognizedArgument]
            )

            XCTAssertNil(configuration.settingsProofState)
            XCTAssertEqual(configuration, .standard)
        }
    }

    func testGuestAndMemberLocalRemovalAreSeparateFrozenScreens() {
        var guest = SettingsFlow(identity: .guest, hasLocalData: true)
        var member = SettingsFlow(
            identity: .member(method: .apple, email: "seller@example.com"),
            hasLocalData: true
        )

        XCTAssertEqual(guest.localGroupStateID, "SET-03")
        XCTAssertEqual(member.localGroupStateID, "SET-03")

        guest.openLocalRemoval()
        member.openLocalRemoval()

        XCTAssertEqual(guest.stateID, "SET-05")
        XCTAssertEqual(member.stateID, "SET-06")
        XCTAssertEqual(guest.localRemovalUnchangedFacts.count, 3)
        XCTAssertEqual(member.localRemovalUnchangedFacts.count, 2)

        guest.completeLocalRemoval()
        member.completeLocalRemoval()
        XCTAssertEqual(guest.stateID, "SET-01")
        XCTAssertEqual(member.stateID, "SET-01")
        XCTAssertFalse(guest.hasLocalData)
        XCTAssertFalse(member.hasLocalData)
        XCTAssertEqual(guest.localGroupStateID, "SET-04")
        XCTAssertEqual(member.localGroupStateID, "SET-04")
    }

    func testLocalRemovalClearsEveryOwnedDeviceCacheBeforeReportingEmpty() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(
            "settings-local-removal-\(UUID().uuidString)",
            isDirectory: true
        )
        defer { try? FileManager.default.removeItem(at: root) }
        let listingReview = root
            .appendingPathComponent("SnapList", isDirectory: true)
            .appendingPathComponent("ListingReview", isDirectory: true)
        let captureDraft = root
            .appendingPathComponent("SnapList", isDirectory: true)
            .appendingPathComponent("CaptureDraft", isDirectory: true)
        try FileManager.default.createDirectory(
            at: listingReview,
            withIntermediateDirectories: true
        )
        try FileManager.default.createDirectory(
            at: captureDraft,
            withIntermediateDirectories: true
        )
        let snapshot = ListingReviewLaunchFixture.review()
        let persistence = LocalListingReviewDraftPersistence(
            rootDirectory: listingReview
        )
        let token = ListingReviewDraftPersistenceToken(
            sessionID: UUID(),
            generation: 0
        )
        let activated = await persistence.activate(
            token,
            runID: snapshot.binding.runID
        )
        XCTAssertTrue(activated)
        let saved = try await persistence.save(
            PersistedListingReviewDraft(
                snapshot: snapshot,
                draft: ListingReviewDraft(snapshot: snapshot),
                pendingSave: nil,
                expiresAt: Date().addingTimeInterval(3_600)
            ),
            runID: snapshot.binding.runID,
            token: token
        )
        XCTAssertTrue(saved)
        try Data("unsent capture".utf8).write(
            to: captureDraft.appendingPathComponent("manifest.json")
        )

        let cachedData = SettingsLocalCachedDataStore(
            applicationSupportDirectory: root
        )
        var intakeRemovalCalled = false
        XCTAssertTrue(cachedData.hasData)

        let removed = await SettingsLocalRemovalTransaction.perform(
            removeIntake: {
                intakeRemovalCalled = true
                return true
            },
            removeCachedItems: { cachedData.removeAll() }
        )

        XCTAssertTrue(removed)
        XCTAssertTrue(intakeRemovalCalled)
        XCTAssertFalse(cachedData.hasData)
        XCTAssertFalse(FileManager.default.fileExists(atPath: listingReview.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: captureDraft.path))
        let persisted = try await persistence.load(
            runID: snapshot.binding.runID,
            token: token
        )
        XCTAssertNil(persisted)
    }

    func testLocalRemovalStopsBeforeCachesWhenVersionFencedIntakeRejects() async {
        var cachedRemovalCalled = false

        let removed = await SettingsLocalRemovalTransaction.perform(
            removeIntake: { false },
            removeCachedItems: {
                cachedRemovalCalled = true
                return true
            }
        )

        XCTAssertFalse(removed)
        XCTAssertFalse(cachedRemovalCalled)
    }

    func testGuestSettingsStopsBeforeEntitlementsAndAccountManagement() {
        var flow = SettingsFlow(identity: .guest, hasLocalData: false)

        flow.openDeletion()

        XCTAssertEqual(flow.stateID, "SET-01")
        XCTAssertFalse(flow.isMember)
        XCTAssertEqual(SettingsGuestBoundaryCopy.title, "Guest Settings stops here")
        XCTAssertTrue(SettingsGuestBoundaryCopy.body.contains("both absent rather than empty"))
        XCTAssertTrue(SettingsGuestBoundaryCopy.body.contains("within 24 hours of acceptance"))
    }

    func testDeletionRouteStopsAtTheApprovedFinalConfirm() {
        var flow = SettingsFlow(
            identity: .member(method: .apple, email: "seller@example.com"),
            hasLocalData: false
        )

        flow.openDeletion()
        XCTAssertEqual(flow.stateID, "DEL-01")
        flow.continueToReauthentication()
        XCTAssertEqual(flow.stateID, "DEL-02")

        flow.resolveReauthentication(.failed)
        XCTAssertEqual(flow.stateID, "DEL-02f")
        flow.resolveReauthentication(.cancelled)
        XCTAssertEqual(flow.stateID, "DEL-02")
        flow.cancelReauthentication()
        XCTAssertEqual(flow.stateID, "DEL-01")
        flow.continueToReauthentication()
        flow.resolveReauthentication(.succeeded)

        XCTAssertEqual(flow.stateID, "DEL-03")
        XCTAssertFalse(flow.isServerTailState)

        flow.keepAccount()
        XCTAssertEqual(flow.stateID, "SET-01")

        flow.openDeletion()
        flow.continueToReauthentication()
        flow.resolveReauthentication(.succeeded)
        flow.returnFromDeletionConfirmation()
        XCTAssertEqual(flow.stateID, "DEL-02")
    }

    func testSubscriptionPresentationKeepsEveryFrozenReadingDistinct() {
        let periodEnd = Date(timeIntervalSince1970: 1_786_406_400)
        let graceEnd = Date(timeIntervalSince1970: 1_784_937_600)
        let verified: [(VerifiedSubscriptionStatus, String, String, Bool, SettingsDeletionSubscriptionTruth)] = [
            (.included, "SUB-06", "Included", true, .included),
            (.active, "SUB-07", "Active", true, .billing),
            (.grace, "SUB-08", "Payment problem", true, .billing),
            (.billingRetry, "SUB-09", "Retrying payment", true, .billing),
            (.expired, "SUB-10", "Ended", false, .ended),
            (.revoked, "SUB-11", "Revoked", false, .ended),
            (.refunded, "SUB-12", "Refunded", false, .ended),
            (.ambiguous, "SUB-13", "Details not updated", true, .ambiguous),
            (.unconfigured, "SUB-01", "", false, .unknown)
        ]

        for (status, stateID, statusText, showsRemaining, deletionTruth) in verified {
            let serverValue = ServerVerifiedSubscription(
                source: status == .included ? .included : .storeKit,
                status: status,
                remainingItems: 12,
                periodStart: nil,
                periodEnd: periodEnd,
                gracePeriodEnd: graceEnd,
                transitionState: .reconciled,
                legacyStripeStatus: nil
            )
            let presentation = SettingsSubscriptionPresentation(
                state: .verified(serverValue)
            )

            XCTAssertEqual(
                SettingsDeletionSubscriptionTruth(state: .verified(serverValue)),
                deletionTruth
            )

            XCTAssertEqual(presentation.stateID, stateID)
            XCTAssertEqual(presentation.status, statusText)
            XCTAssertEqual(presentation.remainingItems != nil, showsRemaining)
        }

        XCTAssertEqual(
            SettingsSubscriptionPresentation(state: .loading).stateID,
            "SUB-02"
        )
        XCTAssertEqual(
            SettingsSubscriptionPresentation(state: .available([])).stateID,
            "SUB-03"
        )
        XCTAssertEqual(
            SettingsSubscriptionPresentation(state: .restoring).stateID,
            "SUB-04"
        )
        XCTAssertEqual(
            SettingsSubscriptionPresentation(
                state: .awaitingServerVerification(action: .purchase)
            ).stateID,
            "SUB-05"
        )
        XCTAssertEqual(
            SettingsSubscriptionPresentation(
                state: .awaitingServerVerification(action: .restore)
            ).stateID,
            "SUB-05"
        )
        XCTAssertEqual(
            SettingsSubscriptionPresentation(state: .failed("offline")).stateID,
            "SUB-15"
        )
    }

    func testSubscriptionFirstPaintAndConfigurationFailureAreHonest() {
        let unresolved = SettingsSubscriptionPresentation(
            state: .unconfigured,
            loadPhase: .loading
        )
        let failed = SettingsSubscriptionPresentation(
            state: .unconfigured,
            loadPhase: .failed
        )

        XCTAssertEqual(unresolved.stateID, "SUB-02")
        XCTAssertEqual(unresolved.status, "Checking")
        XCTAssertEqual(failed.stateID, "SUB-15")
        XCTAssertEqual(failed.actions, [.retry, .manage])
    }

    func testPurchaseOnlyTransientsNeverRenderAsNotSubscribedInSettings() {
        let purchasing = SettingsSubscriptionPresentation(
            state: .purchasing(productID: "snaplist.pro.monthly")
        )
        let pending = SettingsSubscriptionPresentation(
            state: .pending(productID: "snaplist.pro.monthly")
        )

        XCTAssertEqual(purchasing.stateID, "SUB-02")
        XCTAssertEqual(pending.stateID, "SUB-02")
        XCTAssertEqual(purchasing.status, "Checking")
        XCTAssertEqual(pending.status, "Checking")
        XCTAssertTrue(purchasing.facts.isEmpty)
        XCTAssertTrue(pending.facts.isEmpty)
    }

    func testDeletionCopyNeverClaimsAStoreKitTransientMeansNoSubscription() {
        XCTAssertEqual(
            SettingsDeletionSubscriptionTruth(
                state: .purchasing(productID: "snaplist.pro.monthly")
            ),
            .unknown
        )
        XCTAssertEqual(
            SettingsDeletionSubscriptionTruth(
                state: .pending(productID: "snaplist.pro.monthly")
            ),
            .unknown
        )
        XCTAssertEqual(
            SettingsDeletionSubscriptionTruth(
                state: .awaitingServerVerification(action: .purchase)
            ),
            .billing
        )
        XCTAssertEqual(
            SettingsDeletionSubscriptionTruth(state: .available([])),
            .none
        )
        XCTAssertEqual(
            SettingsDeletionSubscriptionTruth(
                state: .restoreNotFound,
                loadPhase: .failed
            ),
            .unknown
        )
    }

    func testEntitlementRefreshPlanPreservesServerTruthAcrossLoadAndRestore() {
        XCTAssertEqual(
            SettingsEntitlementRefreshPlan.afterInitialLoad(.unconfigured),
            .stop
        )
        XCTAssertEqual(
            SettingsEntitlementRefreshPlan.afterInitialLoad(.available([])),
            .requestServerTruth
        )
        XCTAssertEqual(
            SettingsEntitlementRefreshPlan.afterInitialLoad(.failed("offline")),
            .stop
        )
        XCTAssertEqual(
            SettingsEntitlementRefreshPlan.afterRestore(.restoreNotFound),
            .requestServerTruth
        )
        XCTAssertEqual(
            SettingsEntitlementRefreshPlan.afterRestore(
                .awaitingServerVerification(action: .restore)
            ),
            .requestServerTruth
        )
        XCTAssertEqual(
            SettingsEntitlementRefreshPlan.afterRestore(.failed("offline")),
            .stop
        )
        XCTAssertEqual(
            SettingsEntitlementRefreshPlan
                .afterInitialLoad(.available([]))
                .deletionDisclosureLoadPhase,
            .loading
        )
        XCTAssertEqual(
            SettingsEntitlementRefreshPlan
                .afterInitialLoad(.unconfigured)
                .deletionDisclosureLoadPhase,
            .loaded
        )
    }

    @MainActor
    func testEntitlementServerRefreshKeepsDisclosureUnknownUntilApplyCompletes() async {
        var events: [String] = []

        await SettingsEntitlementServerRefresh.perform(
            fetch: {
                events.append("fetch")
                return "server truth"
            },
            apply: { events.append("apply:\($0)") },
            setLoadPhase: { events.append("phase:\($0)") }
        )

        XCTAssertEqual(
            events,
            ["phase:loading", "fetch", "apply:server truth", "phase:loaded"]
        )
    }

    @MainActor
    func testEntitlementServerRefreshKeepsDisclosureUnknownOnFailure() async {
        enum RefreshError: Error { case unavailable }
        var phases: [SettingsSubscriptionPresentation.LoadPhase] = []

        await SettingsEntitlementServerRefresh.perform(
            fetch: { throw RefreshError.unavailable },
            apply: { (_: String) in XCTFail("Failed refresh must not apply") },
            setLoadPhase: { phases.append($0) }
        )

        XCTAssertEqual(phases, [.loading, .failed])
    }

    func testSubscriptionGroupIsAbsentForGuestAndDeletionOutstanding() {
        XCTAssertFalse(
            SettingsSubscriptionVisibility(
                identity: .guest,
                deletionOutstanding: false
            ).isVisible
        )
        XCTAssertFalse(
            SettingsSubscriptionVisibility(
                identity: .member(method: .apple, email: "seller@example.com"),
                deletionOutstanding: true
            ).isVisible
        )
        XCTAssertTrue(
            SettingsSubscriptionVisibility(
                identity: .member(method: .apple, email: "seller@example.com"),
                deletionOutstanding: false
            ).isVisible
        )
    }

    func testSubscriptionAnnouncementUsesTheVisibleSellerReading() {
        let presentation = SettingsSubscriptionPresentation(state: .restoring)

        XCTAssertEqual(
            presentation.accessibilityAnnouncement,
            "SnapList Pro. Checking for a purchase."
        )
    }

    func testEmailCodePresentationUsesSixBoxesAsOneProgressReading() {
        let empty = SettingsEmailCodePresentation(code: "")
        let partial = SettingsEmailCodePresentation(code: "12a34")
        let complete = SettingsEmailCodePresentation(code: "1234567")

        XCTAssertEqual(empty.digits, [])
        XCTAssertEqual(empty.focusedBoxIndex, 0)
        XCTAssertEqual(empty.accessibilityValue, "0 of 6 digits entered")
        XCTAssertEqual(partial.digits, ["1", "2", "3", "4"])
        XCTAssertEqual(partial.focusedBoxIndex, 4)
        XCTAssertEqual(partial.accessibilityValue, "4 of 6 digits entered")
        XCTAssertEqual(complete.digits, ["1", "2", "3", "4", "5", "6"])
        XCTAssertEqual(complete.focusedBoxIndex, 5)
        XCTAssertEqual(complete.accessibilityValue, "6 of 6 digits entered")
    }

    func testAppleReauthenticationRequiresTheSameClerkAccount() {
        XCTAssertTrue(
            SettingsReauthenticationGate.isSameAccount(
                originalUserID: "user_385",
                verifiedUserID: "user_385"
            )
        )
        XCTAssertFalse(
            SettingsReauthenticationGate.isSameAccount(
                originalUserID: "user_385",
                verifiedUserID: "user_other"
            )
        )
        XCTAssertFalse(
            SettingsReauthenticationGate.isSameAccount(
                originalUserID: "user_385",
                verifiedUserID: nil
            )
        )
    }

    func testEmailReauthenticationSendsOnlyToTheDisplayedPrimaryAddress() async {
        var sentAddressID: String?

        let state = await SettingsEmailCodeChallenge.send(
            displayedPrimaryAddressID: "email_primary",
            supportedEmailAddressIDs: ["email_other", "email_primary"],
            sender: { sentAddressID = $0 }
        )

        XCTAssertEqual(state, .sent)
        XCTAssertEqual(sentAddressID, "email_primary")
        XCTAssertEqual(
            state.lead(email: "seller@example.com"),
            "Deleting an account is permanent, so SnapList sent a 6-digit code to seller@example.com. Enter it to confirm it is you."
        )
    }

    func testEmailReauthenticationDoesNotClaimDeliveryWithoutMatchingFactor() async {
        var senderCalled = false

        let state = await SettingsEmailCodeChallenge.send(
            displayedPrimaryAddressID: "email_primary",
            supportedEmailAddressIDs: ["email_other"],
            sender: { _ in senderCalled = true }
        )

        XCTAssertEqual(state, .failed)
        XCTAssertFalse(senderCalled)
        XCTAssertEqual(
            state.failureCopy(email: "seller@example.com"),
            "SnapList could not send a code to seller@example.com. Nothing has been deleted. You can try again."
        )
        XCTAssertFalse(
            state.lead(email: "seller@example.com").contains("SnapList sent")
        )
    }
}

private final class FailingSettingsAnalyticsClient: AnalyticsClient {
    enum Failure: Error { case expected }

    private(set) var requestedConsents: [AnalyticsConsent] = []

    func capture(_ event: AnalyticsEvent) {}
    func screen(_ screen: AnalyticsScreen) {}
    func identify(clerkUserID: String) {}
    func reset() {}
    func setConsent(_ consent: AnalyticsConsent) throws {
        requestedConsents.append(consent)
        throw Failure.expected
    }
    func flush() {}
}

// MARK: - Selling section eBay policy hint (#694)

extension SettingsTests {
    private func hint(
        state: String,
        message: String?,
        missing: [String] = [],
        helpURL: URL? = URL(string: "https://www.bizpolicy.ebay.com/businesspolicy/manage")
    ) -> EbayPolicySetupHint {
        EbayPolicySetupHint(
            state: state,
            marketplaceID: "EBAY_US",
            missing: missing,
            ambiguous: [],
            message: message,
            helpURL: helpURL
        )
    }

    func testSellingSectionShowsNoHintUntilTheConnectionIsKnown() {
        let loading = SettingsSellingPresentation(connection: nil, loadPhase: .loading)

        XCTAssertEqual(loading.marketplaceValue, "Checking")
        XCTAssertNil(loading.hint)

        let failed = SettingsSellingPresentation(connection: nil, loadPhase: .failed)

        XCTAssertEqual(failed.marketplaceValue, "Not available")
        XCTAssertNil(failed.hint)
    }

    func testSellingSectionShowsNoHintForASellerWhoIsNotConnected() {
        let presentation = SettingsSellingPresentation(
            connection: EbayConnectionStatus(
                connected: false,
                ebayUsername: nil,
                policySetup: nil
            ),
            loadPhase: .loaded
        )

        XCTAssertEqual(presentation.marketplaceValue, "Not connected")
        XCTAssertNil(presentation.hint)
    }

    func testSellingSectionShowsNoHintForAConnectedSellerWhoIsReadyToPublish() {
        let presentation = SettingsSellingPresentation(
            connection: EbayConnectionStatus(
                connected: true,
                ebayUsername: "sandbox-seller",
                policySetup: hint(state: "ready", message: nil)
            ),
            loadPhase: .loaded
        )

        XCTAssertEqual(presentation.marketplaceValue, "eBay")
        XCTAssertNil(presentation.hint)
    }

    /// A binding exists only once publish-time discovery has written one, so
    /// `notChecked` with no message is every seller between finishing eBay
    /// OAuth and their first publish. Showing them a warning triangle would
    /// report a problem SnapList has not found (issue #694).
    func testSellingSectionShowsNoHintForAConnectedSellerWhoHasNeverPublished() {
        let presentation = SettingsSellingPresentation(
            connection: EbayConnectionStatus(
                connected: true,
                ebayUsername: "sandbox-seller",
                policySetup: hint(state: "notChecked", message: nil)
            ),
            loadPhase: .loaded
        )

        XCTAssertEqual(presentation.marketplaceValue, "eBay")
        XCTAssertNil(presentation.hint)
    }

    func testSellingSectionNamesTheMissingFamilyBeforePublishIsAttempted() {
        let message = "Your eBay account has no payment policy. "
            + "Add it in eBay before you publish."
        let presentation = SettingsSellingPresentation(
            connection: EbayConnectionStatus(
                connected: true,
                ebayUsername: "sandbox-seller",
                policySetup: hint(
                    state: "setupRequired",
                    message: message,
                    missing: ["paymentPolicy"]
                )
            ),
            loadPhase: .loaded
        )

        XCTAssertEqual(presentation.marketplaceValue, "eBay")
        XCTAssertEqual(presentation.hint?.message, message)
        XCTAssertEqual(
            presentation.hint?.helpURL,
            URL(string: "https://www.bizpolicy.ebay.com/businesspolicy/manage")
        )
    }

    func testSellingSectionKeepsTheHintWhenTheServerOffersNoLink() {
        let message = "SnapList has not read your eBay shipping, payment, and "
            + "return policies yet. Check that your eBay account has one of "
            + "each before you publish."
        let presentation = SettingsSellingPresentation(
            connection: EbayConnectionStatus(
                connected: true,
                ebayUsername: "sandbox-seller",
                policySetup: hint(state: "notChecked", message: message, helpURL: nil)
            ),
            loadPhase: .loaded
        )

        XCTAssertEqual(presentation.hint?.message, message)
        XCTAssertNil(presentation.hint?.helpURL)
    }

    func testSellingSectionStaysSilentWhenTheServerSendsNoWordingToShow() {
        let presentation = SettingsSellingPresentation(
            connection: EbayConnectionStatus(
                connected: true,
                ebayUsername: "sandbox-seller",
                policySetup: hint(state: "setupRequired", message: nil)
            ),
            loadPhase: .loaded
        )

        XCTAssertEqual(presentation.marketplaceValue, "eBay")
        XCTAssertNil(presentation.hint)
    }

    func testSellingSectionStillWarnsOnAStateThisBuildDoesNotKnow() {
        let message = "Your eBay account needs attention before you publish."
        let presentation = SettingsSellingPresentation(
            connection: EbayConnectionStatus(
                connected: true,
                ebayUsername: "sandbox-seller",
                policySetup: hint(
                    state: "somethingNewerThanThisBuild",
                    message: message
                )
            ),
            loadPhase: .loaded
        )

        XCTAssertEqual(presentation.hint?.message, message)
    }

    /// The hint row combines its children so VoiceOver reads the warning and
    /// its link as one sentence. Combining also deletes the `Link` from the
    /// accessibility tree, so a VoiceOver seller can no longer activate it. The
    /// row re-exposes the same destination as an action on the combined
    /// element, which reaches VoiceOver through the actions rotor.
    ///
    /// XCUITest cannot observe this: the combined element has no children to
    /// find, and `XCUIElement.hasFocus` reads UIKit focus rather than VoiceOver
    /// focus. The seam is the rendered body type, which names the whole static
    /// subtree including the modifier that attaches the action. That type does
    /// not vary with the hint's data, so one fixture proves the composition;
    /// whether the action fires for a hint with no link is the modifier's own
    /// `if let`, not something this type can show.
    @MainActor
    func testPolicyHintOffersTheEbayLinkAsAnActionOnTheCombinedElement() {
        let row = SettingsSellingHintRow(
            hint: SettingsSellingPresentation.Hint(
                message: "Your eBay account has no payment policy.",
                helpURL: URL(
                    string: "https://www.bizpolicy.ebay.com/businesspolicy/manage"
                )
            )
        )

        let rendered = String(reflecting: type(of: row.body))

        XCTAssertTrue(
            rendered.contains("SettingsSellingHintPolicyAction"),
            "The combined hint element carries no policy action: \(rendered)"
        )
    }

    func testConnectionDecodesAServerAnswerThatCarriesNoPolicySetup() throws {
        let json = Data(#"{"connected":true,"ebayUsername":"sandbox-seller"}"#.utf8)

        let status = try JSONDecoder().decode(EbayConnectionStatus.self, from: json)

        XCTAssertTrue(status.connected)
        XCTAssertNil(status.policySetup)
    }

    func testConnectionDecodesTheStoredPolicyHint() throws {
        let json = Data(#"""
        {
          "connected": true,
          "ebayUsername": "sandbox-seller",
          "policySetup": {
            "state": "setupRequired",
            "marketplaceId": "EBAY_US",
            "missing": ["paymentPolicy", "returnPolicy"],
            "ambiguous": [],
            "message": "Your eBay account has no payment policy or return policy. Add them in eBay before you publish.",
            "helpUrl": "https://www.bizpolicy.ebay.com/businesspolicy/manage"
          }
        }
        """#.utf8)

        let status = try JSONDecoder().decode(EbayConnectionStatus.self, from: json)

        XCTAssertEqual(status.policySetup?.state, "setupRequired")
        XCTAssertEqual(status.policySetup?.missing, ["paymentPolicy", "returnPolicy"])
        XCTAssertEqual(status.policySetup?.marketplaceID, "EBAY_US")
        XCTAssertEqual(
            status.policySetup?.helpURL,
            URL(string: "https://www.bizpolicy.ebay.com/businesspolicy/manage")
        )
    }

    // MARK: - Legal links (issue #812)

    func testLegalDestinationsPointAtTheLiveMarketingSiteDocuments() {
        XCTAssertEqual(
            LegalDestination.privacyPolicy.url,
            URL(string: "https://snaplist.dev/privacy")
        )
        XCTAssertEqual(
            LegalDestination.termsOfService.url,
            URL(string: "https://snaplist.dev/terms")
        )
        XCTAssertEqual(
            LegalDestination.help.url,
            URL(string: "https://snaplist.dev/support")
        )
    }

    /// Same reflection technique as the eBay policy hint row above: it proves
    /// the row's rendered body actually carries a `Button`, not the bare
    /// `HStack` issue #812 found shipped inert with a chevron that promised
    /// navigation the row never performed.
    @MainActor
    func testLegalLinkRowWiresItsRowToAnOpenAction() {
        let row = LegalLinkRow(
            destination: .privacyPolicy,
            accessibilityIdentifier: "settings.about.privacy-policy"
        )

        let rendered = String(reflecting: type(of: row.body))

        XCTAssertTrue(
            rendered.contains("Button"),
            "The legal link row is not wrapped in a Button: \(rendered)"
        )
    }
}
