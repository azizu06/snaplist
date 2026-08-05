import XCTest
@testable import SnapList

final class SettingsTests: XCTestCase {
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
