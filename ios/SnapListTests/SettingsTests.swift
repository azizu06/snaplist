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
    }
}
