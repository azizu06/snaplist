import Foundation
import UserNotifications
import XCTest
@testable import SnapList

/// Issue #1137. A notification tap opens the exact item it announced.
///
/// iOS delivers every tap to one delegate callback, whether the app was open,
/// backgrounded, or not running, so the parity requirement is structural: there
/// is one entry (`PushTapRouter.receive`) and one opener (`PushTapOpener`). What
/// these tests hold is what each moment, and each way the identity can be
/// missing or stale, does with it.
@MainActor
final class PushTapRoutingTests: XCTestCase {
    private let runID = UUID(uuidString: "33333333-3333-4333-8333-333333333333")!
    private let defaultAction = UNNotificationDefaultActionIdentifier

    private func payload(
        moment: String? = "listingReady",
        runID: Any? = "33333333-3333-4333-8333-333333333333"
    ) -> [AnyHashable: Any] {
        var info: [AnyHashable: Any] = [
            "aps": ["alert": ["title": "Ready", "body": "Open SnapList."]],
        ]
        if let moment { info["moment"] = moment }
        if let runID { info["runId"] = runID }
        return info
    }

    private func router(now: @escaping () -> Date = Date.init) -> PushTapRouter {
        PushTapRouter(now: now)
    }

    // MARK: Reading the payload

    func testAReadyTapCarriesTheRunItAnnounced() {
        let router = router()

        XCTAssertTrue(router.receive(userInfo: payload(), actionIdentifier: defaultAction))

        XCTAssertEqual(router.take(), SellerPushTap(moment: .listingReady, runID: runID))
    }

    func testAPublishedTapCarriesTheRunItAnnounced() {
        let router = router()

        router.receive(
            userInfo: payload(moment: "listingPublished"),
            actionIdentifier: defaultAction
        )

        XCTAssertEqual(router.take(), SellerPushTap(moment: .listingPublished, runID: runID))
    }

    func testAPayloadWithoutAnIdentityStillLandsOnTheWallWithoutAnItem() {
        // A push sent before this build knew about run ids, or for a listing
        // that predates its run link. The seller still tapped a SnapList
        // notification, so the app opens where the wall is, not on nothing.
        let router = router()

        router.receive(userInfo: payload(runID: nil), actionIdentifier: defaultAction)

        XCTAssertEqual(router.take(), SellerPushTap(moment: .listingReady, runID: nil))
    }

    func testAnIdentityThatIsNotAUUIDIsTreatedAsMissing() {
        for bad: Any in ["run-1", "", 42, ["x": 1]] as [Any] {
            let router = router()

            router.receive(userInfo: payload(runID: bad), actionIdentifier: defaultAction)

            XCTAssertEqual(
                router.take(),
                SellerPushTap(moment: .listingReady, runID: nil),
                "\(bad)"
            )
        }
    }

    func testAPayloadThatIsNotOursIsIgnored() {
        let router = router()

        XCTAssertFalse(router.receive(
            userInfo: payload(moment: nil),
            actionIdentifier: defaultAction
        ))
        XCTAssertFalse(router.receive(
            userInfo: payload(moment: "somethingElse"),
            actionIdentifier: defaultAction
        ))

        XCTAssertNil(router.take())
    }

    func testDismissingANotificationIsNotATapOnIt() {
        let router = router()

        XCTAssertFalse(router.receive(
            userInfo: payload(),
            actionIdentifier: UNNotificationDismissActionIdentifier
        ))

        XCTAssertNil(router.take())
    }

    // MARK: One tap, one open

    func testATapIsTakenOnce() {
        let router = router()
        router.receive(userInfo: payload(), actionIdentifier: defaultAction)

        XCTAssertNotNil(router.take())
        XCTAssertNil(router.take())
    }

    func testANewerTapReplacesAnUnhandledOne() {
        let router = router()
        let newer = UUID(uuidString: "44444444-4444-4444-8444-444444444444")!
        router.receive(userInfo: payload(), actionIdentifier: defaultAction)

        router.receive(
            userInfo: payload(moment: "listingPublished", runID: newer.uuidString),
            actionIdentifier: defaultAction
        )

        XCTAssertEqual(router.take(), SellerPushTap(moment: .listingPublished, runID: newer))
    }

    func testATapNobodyHandledExpiresInsteadOfOpeningLater() {
        // Cold launch keeps the tap until the shell mounts. A shell that never
        // mounts (a seller stuck in onboarding) must not open an item minutes
        // later, out of nowhere.
        var clock = Date(timeIntervalSince1970: 1_000)
        let router = router(now: { clock })
        router.receive(userInfo: payload(), actionIdentifier: defaultAction)

        clock = clock.addingTimeInterval(PushTapRouter.lifetime + 1)

        XCTAssertNil(router.take())
    }

    // MARK: Opening

    func testOpeningARunTapOpensThatRunOnce() async {
        let router = router()
        router.receive(userInfo: payload(), actionIdentifier: defaultAction)
        var opened: [UUID] = []

        let result = await PushTapOpener.open(from: router) { runID in
            opened.append(runID)
            return .presentedReview
        }

        XCTAssertEqual(opened, [runID])
        XCTAssertEqual(result, .opened)
        XCTAssertNil(router.take())
    }

    func testPublishedAndReadyTapsOpenThroughTheSameOpener() async {
        for moment in ["listingReady", "listingPublished"] {
            let router = router()
            router.receive(userInfo: payload(moment: moment), actionIdentifier: defaultAction)
            var opened: [UUID] = []

            _ = await PushTapOpener.open(from: router) { runID in
                opened.append(runID)
                return .presentedReview
            }

            XCTAssertEqual(opened, [runID], moment)
        }
    }

    func testAGuestsTapOpensTheGuestClaimTheSameWayATileDoes() async {
        let router = router()
        router.receive(userInfo: payload(), actionIdentifier: defaultAction)

        let result = await PushTapOpener.open(from: router) { _ in .presentedGuestClaim }

        XCTAssertEqual(result, .opened)
    }

    func testATapWithNoIdentityOpensNothingAndSaysSo() async {
        let router = router()
        router.receive(userInfo: payload(runID: nil), actionIdentifier: defaultAction)
        var opened = 0

        let result = await PushTapOpener.open(from: router) { _ in
            opened += 1
            return .presentedReview
        }

        XCTAssertEqual(opened, 0)
        XCTAssertEqual(result, .noItem)
    }

    func testARunTheServerRefusesIsReportedNotOpened() async {
        // Deleted since the push was sent, another seller's, or not openable
        // yet. The wall is already showing, which is the safe place to be.
        let router = router()
        router.receive(userInfo: payload(), actionIdentifier: defaultAction)

        let result = await PushTapOpener.open(from: router) { _ in .rejected }

        XCTAssertEqual(result, .unavailable)
        XCTAssertNil(router.take())
    }

    func testNothingPendingOpensNothing() async {
        var opened = 0

        let result = await PushTapOpener.open(from: router()) { _ in
            opened += 1
            return .presentedReview
        }

        XCTAssertEqual(opened, 0)
        XCTAssertEqual(result, .nothingPending)
    }

    // MARK: Where the shell puts the seller

    func testATapBringsTheWallForwardOverWhateverWasOpen() {
        let router = AppRouter()
        router.select(.scan)
        router.navigate(to: .settings)
        router.presentedFullScreen = .guidedCamera
        router.presentedAccountEntry = true

        router.showTrophyWallForPushTap()

        XCTAssertEqual(router.selectedTab, .trophyWall)
        XCTAssertNil(router.presentedFullScreen)
        XCTAssertFalse(router.presentedAccountEntry)
        XCTAssertEqual(router.pathBinding(for: .trophyWall).wrappedValue, [])
    }

    func testATapPopsPushedScreensSoTheWallRootCanPresentTheItem() {
        let router = AppRouter()
        router.select(.trophyWall)
        router.navigate(to: .settings)
        router.navigate(to: .home(.processing))

        router.showTrophyWallForPushTap()

        XCTAssertEqual(router.pathBinding(for: .trophyWall).wrappedValue, [])
    }
}
