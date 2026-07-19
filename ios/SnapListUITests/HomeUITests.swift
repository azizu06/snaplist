import XCTest

final class HomeUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
    }

    func testApprovedSellerStatesRenderTheirDurableTruth() {
        let expectations = [
            ("HOME-01", "Finding recent sold comps"),
            ("HOME-02", "Photograph an item. Get real comps and a listing you control."),
            ("HOME-03", "Writing your listing"),
            ("HOME-04", "Recent searches")
        ]

        for (state, expectedText) in expectations {
            let app = launch(state)
            XCTAssertTrue(
                app.staticTexts[expectedText].waitForExistence(timeout: 3),
                "Missing approved content for \(state)"
            )
            app.terminate()
        }
    }

    func testAttentionAndCurrentRunUseTypedFutureRoutes() {
        let app = launch("HOME-01")

        let order = app.buttons["home.attention.20800000-0000-4000-8000-000000000011"]
        XCTAssertTrue(order.waitForExistence(timeout: 3))
        order.tap()
        XCTAssertTrue(app.staticTexts["home.route.order.title"].waitForExistence(timeout: 2))

        app.navigationBars.buttons.firstMatch.tap()
        let run = app.buttons.matching(
            NSPredicate(format: "label CONTAINS %@", "Finding recent sold comps")
        ).firstMatch
        XCTAssertTrue(run.waitForExistence(timeout: 2))
        run.tap()
        XCTAssertTrue(app.staticTexts["route.run.title"].waitForExistence(timeout: 2))
    }

    func testNewSellerStartsTheExistingCaptureFlow() {
        let app = launch("HOME-02")
        let firstItem = app.buttons["home.first-item"]

        XCTAssertTrue(firstItem.waitForExistence(timeout: 3))
        XCTAssertGreaterThanOrEqual(firstItem.frame.height, 44)
        firstItem.tap()

        XCTAssertTrue(app.staticTexts["sheet.capture.title"].waitForExistence(timeout: 3))
    }

    func testFocusedSearchFiltersRealListingModelsAndHidesDockForKeyboard() {
        let app = launch("HOME-04")
        let search = app.textFields["home.search.field"]

        XCTAssertTrue(search.waitForExistence(timeout: 3))
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["dock.home"].exists)

        search.typeText("camera")
        XCTAssertTrue(app.staticTexts["1 result for “camera”"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.staticTexts["Canon AE-1 film camera"].exists)
        XCTAssertFalse(app.staticTexts["Bose QC earbuds headset"].exists)

        app.buttons["Clear search"].tap()
        app.buttons["home.search.filter.active"].tap()
        XCTAssertTrue(
            app.buttons["home.listing.20800000-0000-4000-8000-000000000041"]
                .waitForExistence(timeout: 2)
        )
        XCTAssertTrue(app.buttons["home.listing.20800000-0000-4000-8000-000000000042"].exists)
        XCTAssertFalse(app.buttons["home.listing.20800000-0000-4000-8000-000000000044"].exists)
    }

    func testStandardHomeCanReachFocusedSearchWithoutAVisualStateFixture() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--fixture=home",
            "--zero-network-fixtures",
            "--reset-onboarding-progress"
        ]
        app.launch()

        let openSearch = app.buttons["home.search.open"]
        XCTAssertTrue(openSearch.waitForExistence(timeout: 3))
        openSearch.tap()

        XCTAssertTrue(app.textFields["home.search.field"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 2))
        XCTAssertFalse(app.buttons["dock.home"].exists)
    }

    func testHomeRemainsReachableAtAccessibilityTypeWithReducedMotion() {
        let app = launch(
            "HOME-02",
            extraArguments: ["--dynamic-type=accessibility3", "--reduced-motion"]
        )
        let firstItem = app.buttons["home.first-item"]

        XCTAssertTrue(firstItem.waitForExistence(timeout: 3))
        XCTAssertGreaterThanOrEqual(firstItem.frame.height, 44)
        XCTAssertTrue(app.buttons["header.activity"].exists)
        XCTAssertTrue(app.buttons["header.account"].exists)
    }

    func testHomeContentClearsTheFloatingDockWhenScrolled() {
        let app = launch("HOME-01")
        let scroll = app.scrollViews.firstMatch

        XCTAssertTrue(scroll.waitForExistence(timeout: 3))
        scroll.swipeUp()
        scroll.swipeUp()

        let recent = app.staticTexts["Recent listings"]
        XCTAssertTrue(recent.waitForExistence(timeout: 2))
        XCTAssertLessThan(recent.frame.maxY, app.buttons["dock.capture"].frame.minY)
    }

    private func launch(
        _ state: String,
        extraArguments: [String] = []
    ) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "--visual-state=\(state)",
            "--zero-network-fixtures",
            "--reset-onboarding-progress"
        ] + extraArguments
        app.launch()
        return app
    }
}
