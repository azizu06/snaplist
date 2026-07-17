import XCTest

final class SnapListUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testPrimaryShellNavigationAndTypedDestinations() {
        let app = launch()

        XCTAssertTrue(app.staticTexts["Home"].exists)
        XCTAssertTrue(app.buttons["dock.home"].isSelected)

        app.buttons["dock.listings"].tap()
        XCTAssertTrue(app.staticTexts["Listings"].waitForExistence(timeout: 2))

        app.buttons["dock.inbox"].tap()
        XCTAssertTrue(app.staticTexts["Inbox"].waitForExistence(timeout: 2))

        app.buttons["dock.insights"].tap()
        XCTAssertTrue(app.staticTexts["Insights"].waitForExistence(timeout: 2))

        XCTAssertFalse(app.buttons["Runs"].exists)
        XCTAssertFalse(app.buttons["You"].exists)
    }

    func testCapturePresentsAndDismissesAnItemDrivenSheet() {
        let app = launch()

        app.buttons["dock.capture"].tap()
        XCTAssertTrue(app.staticTexts["sheet.capture.title"].waitForExistence(timeout: 2))
        app.buttons["capture.close"].tap()
        XCTAssertFalse(app.staticTexts["sheet.capture.title"].waitForExistence(timeout: 1))
        XCTAssertTrue(app.staticTexts["Home"].exists)
    }

    func testHeaderRoutesHaveVoiceOverLabelsAndFortyFourPointTargets() {
        let app = launch()
        let activity = app.buttons["header.activity"]
        let account = app.buttons["header.account"]
        let capture = app.buttons["dock.capture"]

        for control in [activity, account, capture] {
            XCTAssertTrue(control.exists)
            XCTAssertGreaterThanOrEqual(control.frame.width, 44)
            XCTAssertGreaterThanOrEqual(control.frame.height, 44)
        }

        XCTAssertEqual(activity.label, "Open activity")
        XCTAssertEqual(account.label, "Open account and settings")
        XCTAssertEqual(capture.label, "Capture a new item")

        activity.tap()
        XCTAssertTrue(app.staticTexts["route.activity.title"].waitForExistence(timeout: 2))
    }

    func testKeyboardHidesTheFloatingDock() {
        let app = launch(extraArguments: ["--keyboard-probe"])
        let probe = app.textFields["fixture.keyboard-probe"]

        probe.tap()

        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 2))
        XCTAssertFalse(app.buttons["dock.home"].exists)
    }

    func testAccessibilityDynamicTypeKeepsFoundationControlsReachable() {
        let app = launch(extraArguments: ["--dynamic-type=accessibility3"])

        XCTAssertTrue(app.staticTexts["Home"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.buttons["header.activity"].exists)
        XCTAssertTrue(app.buttons["header.account"].exists)
        XCTAssertTrue(app.buttons["dock.capture"].exists)
    }

    func testFloatingDockRespectsTheBottomSafeArea() {
        let app = launch()
        let window = app.windows.firstMatch
        let capture = app.buttons["dock.capture"]

        XCTAssertTrue(window.exists)
        XCTAssertTrue(capture.exists)
        XCTAssertGreaterThan(window.frame.maxY - capture.frame.maxY, 8)
    }

    func testApprovedVisualStateLaunchArgumentUsesTypedBoundary() {
        let app = launch(extraArguments: ["--visual-state=RUN-01"])

        XCTAssertTrue(app.otherElements["visual-state.RUN-01"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.staticTexts["RUN-01"].exists)
        XCTAssertTrue(app.staticTexts["Rendering boundary reserved for issue #211."].exists)
    }

    private func launch(extraArguments: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--fixture=home", "--zero-network-fixtures"] + extraArguments
        app.launch()
        return app
    }
}
