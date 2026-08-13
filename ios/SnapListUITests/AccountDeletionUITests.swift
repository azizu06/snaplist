import XCTest

/**
 Issue #385. The one test that runs the shipped wiring instead of injecting past
 it.

 Every other test in this family builds `AccountDeletionCoordinator.Dependencies`
 by hand. That proves the coordinator's ordering and proves nothing about whether
 the settings route actually hands those dependencies to the screen: the tail
 host reads them from the environment through three nested
 `navigationDestination` hops, and if that value is lost the app falls back to a
 default that deletes nothing. Every attempt would report a failure state and the
 unit suite would stay green, which is the shape of the defect that reopened this
 issue.

 Only the server's answer is a fixture here. The environment value, the tray, the
 host, the coordinator, the ordering and the state the seller reads are all the
 shipped code.
 */
final class AccountDeletionUITests: XCTestCase {
    func testTheShippedRouteReachesTheDeletionTheServerReported() {
        let app = launch(fixture: "completed")

        app.buttons["Delete account"].tap()

        // DEL-08 is the only state permitted to report a deletion, and it is
        // reachable only after the device was cleared and the sign-out actually
        // happened. Before this issue the tray here had no destructive control
        // at all, so this tap did not exist.
        XCTAssertTrue(
            app.descendants(matching: .any)["settings.state.del-08"]
                .waitForExistence(timeout: 10),
            "The confirmed deletion never reached its terminal state, which means the route never reached a real client."
        )
    }

    func testAServerThatConfirmedNothingReportsNoDeletionAndKeepsRetry() {
        let app = launch(fixture: "unavailable")

        app.buttons["Delete account"].tap()

        XCTAssertTrue(
            app.descendants(matching: .any)["settings.state.del-06"]
                .waitForExistence(timeout: 10)
        )
        // The handler's 503 says to retry with the same key, so the screen has
        // to offer that and must not claim anything finished.
        XCTAssertTrue(app.buttons["Try again"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["settings.state.del-08"].exists)
    }

    func testADeletionWaitingOnAPersonIsNotOfferedARetryThatCannotWork() {
        let app = launch(fixture: "needs-attention")

        app.buttons["Delete account"].tap()

        // `deletion_needs_attention` rides the same 202 as
        // `deletion_in_progress`. It is waiting on a person, so the one control
        // that must not be here is the one that asks again.
        XCTAssertTrue(
            app.descendants(matching: .any)["settings.state.del-05a"]
                .waitForExistence(timeout: 10)
        )
        XCTAssertFalse(app.buttons["Try again"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["settings.state.del-08"].exists)
    }

    func testAnExpiredIdentityConfirmationRoutesBackToConfirmingIdentity() {
        let app = launch(fixture: "reverification-expired")

        app.buttons["Delete account"].tap()

        XCTAssertTrue(
            app.descendants(matching: .any)["settings.state.del-06r"]
                .waitForExistence(timeout: 10)
        )
        // Retrying re-sends the same stale factor verification age and earns the
        // same refusal. The exit has to be verification, not repetition.
        XCTAssertFalse(app.buttons["Try again"].exists)
        app.buttons["Confirm it is you"].tap()
        XCTAssertTrue(
            app.descendants(matching: .any)["settings.state.del-02"]
                .waitForExistence(timeout: 10)
        )
    }

    private func launch(fixture: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "--settings-proof=DEL-03",
            "--account-erasure-fixture=\(fixture)",
        ]
        app.launchAfterRetiringPriorInstance()
        XCTAssertTrue(
            app.descendants(matching: .any)["settings.state.del-03"]
                .waitForExistence(timeout: 10)
        )
        return app
    }
}
