import XCTest

final class HomeUITests: XCTestCase {
    // The UI-test target cannot import the app's internal design tokens.
    private let sellerHomeV15DockHeight: CGFloat = 66

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
        XCTAssertTrue(app.staticTexts["Run unavailable"].waitForExistence(timeout: 2))
    }

    func testRunDetailUsesSystemBackAndReturnsToExactHomeOpener() {
        let app = launch("HOME-01")
        let opener = app.buttons["home.run.20800000-0000-4000-8000-000000000020"]

        XCTAssertTrue(opener.waitForExistence(timeout: 3))
        opener.tap()

        XCTAssertTrue(app.otherElements["run.detail"].waitForExistence(timeout: 2))
        let back = app.buttons["Back"]
        XCTAssertTrue(back.exists)
        back.tap()

        XCTAssertTrue(opener.waitForExistence(timeout: 2))
        XCTAssertTrue(opener.isHittable)
    }

    func testRunDetailShowsFactualUnavailableState() {
        let app = launch("HOME-01", extraArguments: ["--run-detail-fixture=unavailable"])
        app.buttons["home.run.20800000-0000-4000-8000-000000000020"].tap()

        XCTAssertTrue(app.staticTexts["Run unavailable"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["We couldn’t load this run."].exists)
    }

    func testRunDetailShowsLoadedItemAndStageTruth() {
        let app = launch("HOME-01", extraArguments: ["--run-detail-fixture=loaded"])
        app.buttons["home.run.20800000-0000-4000-8000-000000000020"].tap()

        XCTAssertTrue(app.staticTexts["Canon AE-1 film camera"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Processing"].exists)
        XCTAssertTrue(app.staticTexts["Researching pricing evidence"].exists)
        XCTAssertFalse(app.staticTexts["Finding recent sold comps"].exists)
    }

    func testTerminalRunStatusDominatesStaleActiveStageCopy() {
        let expectations = [
            (fixture: "failed", heading: "Run failed", status: "Failed"),
            (fixture: "canceled", heading: "Run canceled", status: "Canceled")
        ]

        for expectation in expectations {
            let app = launch(
                "HOME-01",
                extraArguments: ["--run-detail-fixture=\(expectation.fixture)"]
            )
            app.buttons["home.run.20800000-0000-4000-8000-000000000020"].tap()

            XCTAssertTrue(app.staticTexts[expectation.heading].waitForExistence(timeout: 3))
            XCTAssertTrue(app.staticTexts[expectation.status].exists)
            XCTAssertFalse(app.staticTexts["Working on your item"].exists)
            XCTAssertFalse(app.staticTexts["Researching pricing evidence"].exists)
            if expectation.fixture == "canceled" {
                XCTAssertTrue(app.staticTexts["Processing stopped"].exists)
                XCTAssertFalse(app.staticTexts["You canceled this run"].exists)
            }
            XCTAssertTrue(
                UIProcessTerminationBoundary().terminate(app),
                "Run-detail fixture app did not reach a safe terminated state."
            )
        }
    }

    func testFailedRunDetailKeepsMaximumSellerSafeFailureReachableAtAccessibilityType() {
        let app = launch(
            "HOME-01",
            extraArguments: [
                "--run-detail-fixture=failed",
                "--dynamic-type=accessibility5",
            ]
        )
        let opener = app.buttons["home.run.20800000-0000-4000-8000-000000000020"]
        XCTAssertTrue(opener.waitForExistence(timeout: 3))
        opener.tap()

        XCTAssertTrue(app.otherElements["run.detail"].waitForExistence(timeout: 3))
        let scroll = app.scrollViews["run.detail.scroll"]
        XCTAssertTrue(
            scroll.waitForExistence(timeout: 3),
            "Run Detail must expose vertically reachable content."
        )

        let detail = app.staticTexts.matching(
            NSPredicate(
                format: "label BEGINSWITH %@ AND label ENDSWITH %@",
                "Keep your photos",
                "All retry guidance is shown."
            )
        ).firstMatch
        XCTAssertTrue(detail.waitForExistence(timeout: 3))
        XCTAssertEqual(detail.label.count, 500)

        let initialMaximumY = detail.frame.maxY
        let viewport = app.windows.firstMatch.frame.insetBy(dx: 0, dy: 8)
        for _ in 0..<12 where detail.frame.maxY > viewport.maxY {
            scroll.swipeUp()
        }

        XCTAssertLessThan(
            detail.frame.maxY,
            initialMaximumY,
            "Maximum-length detail must move through the Run Detail viewport."
        )
        XCTAssertGreaterThan(detail.frame.maxY, viewport.minY)
        XCTAssertLessThanOrEqual(
            detail.frame.maxY,
            viewport.maxY,
            "The final line of the complete seller-safe detail must be reachable."
        )

        app.buttons["Back"].tap()
        XCTAssertTrue(opener.waitForExistence(timeout: 2))
        XCTAssertTrue(opener.isHittable)
    }

    func testCompletedRunOffersReviewCopyOnlyWhenServerAllowsIt() {
        let unavailable = launch(
            "HOME-01",
            extraArguments: ["--run-detail-fixture=completed"]
        )
        unavailable.buttons["home.run.20800000-0000-4000-8000-000000000020"].tap()

        XCTAssertTrue(unavailable.staticTexts["Run completed"].waitForExistence(timeout: 3))
        XCTAssertTrue(unavailable.staticTexts["Review unavailable"].exists)
        XCTAssertFalse(unavailable.staticTexts["Ready to review"].exists)
        XCTAssertFalse(unavailable.staticTexts["Working on your item"].exists)
        unavailable.terminate()

        let reviewable = launch(
            "HOME-01",
            extraArguments: ["--run-detail-fixture=reviewable"]
        )
        reviewable.buttons["home.run.20800000-0000-4000-8000-000000000020"].tap()

        XCTAssertTrue(reviewable.staticTexts["Run completed"].waitForExistence(timeout: 3))
        XCTAssertTrue(reviewable.staticTexts["Ready to review"].exists)
        XCTAssertFalse(reviewable.staticTexts["Review unavailable"].exists)
    }

    func testRunDetailRefreshIsAccessibleAndReplacesServerTruth() {
        let app = launch("HOME-01", extraArguments: ["--run-detail-fixture=refresh"])
        app.buttons["home.run.20800000-0000-4000-8000-000000000020"].tap()
        XCTAssertTrue(app.staticTexts["Researching pricing evidence"].waitForExistence(timeout: 3))

        let refresh = app.buttons["Refresh"]
        XCTAssertTrue(refresh.exists)
        XCTAssertTrue(refresh.isHittable)
        XCTAssertGreaterThanOrEqual(refresh.frame.width, 44)
        XCTAssertGreaterThanOrEqual(refresh.frame.height, 44)
        refresh.tap()

        XCTAssertTrue(app.staticTexts["Writing your listing"].waitForExistence(timeout: 3))
    }

    func testExactCustomRunDeepLinkOpensDetailAndBackReturnsHome() {
        let app = launch("HOME-01", extraArguments: ["--run-detail-fixture=loaded"])
        let opener = app.buttons["home.run.20800000-0000-4000-8000-000000000020"]
        XCTAssertTrue(opener.waitForExistence(timeout: 3))

        app.open(
            URL(string: "snaplist://runs/20800000-0000-4000-8000-000000000020")!
        )

        XCTAssertTrue(app.staticTexts["Canon AE-1 film camera"].waitForExistence(timeout: 3))
        app.buttons["Back"].tap()
        XCTAssertTrue(opener.waitForExistence(timeout: 2))
    }

    func testRun02VisualStateUsesTheCanonicalDetailRouteShell() {
        let app = launch("RUN-02")

        XCTAssertTrue(app.otherElements["run.detail"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Canon AE-1 film camera"].exists)
        XCTAssertTrue(app.buttons["Refresh"].isHittable)
    }

    func testRun02RouteShellReflowsAtAccessibility3WithReducedMotion() {
        let app = launch(
            "RUN-02",
            extraArguments: ["--dynamic-type=accessibility3", "--reduced-motion"]
        )

        XCTAssertTrue(app.otherElements["run.detail"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Canon AE-1 film camera"].exists)

        let refresh = app.buttons["Refresh"]
        XCTAssertTrue(refresh.isHittable)
        XCTAssertGreaterThanOrEqual(refresh.frame.width, 44)
        XCTAssertGreaterThanOrEqual(refresh.frame.height, 44)
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
        XCTAssertFalse(app.buttons["dock.scan"].exists)

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
            "--fixture=trophy-wall",
            "--zero-network-fixtures",
            "--reset-onboarding-progress"
        ]
        app.launchAfterRetiringPriorInstance()

        let openSearch = app.buttons["home.search.open"]
        XCTAssertTrue(openSearch.waitForExistence(timeout: 3))
        openSearch.tap()

        XCTAssertTrue(app.textFields["home.search.field"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 2))
        XCTAssertFalse(app.buttons["dock.scan"].exists)
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

    func testProcessingDisclosureExpandsAndCollapsesWithoutRouting() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--fixture=trophy-processing",
            "--zero-network-fixtures",
            "--reset-onboarding-progress",
        ]
        app.launchAfterRetiringPriorInstance()

        let rowIdentifiers = [
            "trophy.processing.row.run.37500000-0000-4000-8000-000000000003",
            "trophy.processing.row.local.37500000-0000-4000-8000-000000000002",
            "trophy.processing.row.run.37500000-0000-4000-8000-000000000004",
            "trophy.processing.row.run.37500000-0000-4000-8000-000000000005",
            "trophy.processing.row.local.37500000-0000-4000-8000-000000000006",
        ]
        let rows = rowIdentifiers.map {
            app.descendants(matching: .any)[$0]
        }
        XCTAssertTrue(rows[0].waitForExistence(timeout: 3))
        XCTAssertTrue(rows[1].exists)
        XCTAssertTrue(rows[2].exists)
        XCTAssertFalse(rows[3].exists)
        XCTAssertFalse(rows[4].exists)

        let disclosure = app.buttons["trophy.processing.disclosure"]
        XCTAssertTrue(disclosure.waitForExistence(timeout: 3))
        XCTAssertEqual(disclosure.label, "Show 2 more items")
        XCTAssertEqual(disclosure.value as? String, "Collapsed")
        XCTAssertGreaterThanOrEqual(disclosure.frame.height, 44)
        disclosure.tap()

        XCTAssertTrue(rows[3].waitForExistence(timeout: 3))
        XCTAssertTrue(rows[4].waitForExistence(timeout: 3))
        for (earlier, later) in zip(rows, rows.dropFirst()) {
            XCTAssertLessThan(earlier.frame.minY, later.frame.minY)
        }

        let expandedDisclosure = app.buttons["trophy.processing.disclosure"]
        XCTAssertEqual(expandedDisclosure.label, "Show fewer items")
        XCTAssertEqual(expandedDisclosure.value as? String, "Expanded")
        XCTAssertFalse(app.otherElements["run.detail"].exists)
        expandedDisclosure.tap()

        XCTAssertTrue(rows[3].waitForNonExistence(timeout: 3))
        XCTAssertTrue(rows[4].waitForNonExistence(timeout: 3))
        XCTAssertTrue(rows[0].exists)
        XCTAssertTrue(rows[1].exists)
        XCTAssertTrue(rows[2].exists)
        XCTAssertEqual(
            app.buttons["trophy.processing.disclosure"].value as? String,
            "Collapsed"
        )
        XCTAssertFalse(app.otherElements["run.detail"].exists)
    }

    func testFinalListingRowClearsTheFloatingDockWhenScrolled() {
        let app = launch("HOME-01")
        let scroll = app.scrollViews["home.active"]
        let finalListing = app.buttons[
            "home.listing.20800000-0000-4000-8000-000000000041"
        ]

        XCTAssertTrue(scroll.waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["dock.capture"].waitForExistence(timeout: 3))
        scrollUntilFullyVisible(
            scroll,
            element: finalListing,
            in: app,
            maximumSwipes: 16
        )

        let viewport = unobscuredScrollViewport(scroll, in: app)
        XCTAssertTrue(finalListing.isHittable)
        XCTAssertTrue(
            isFullyVisible(finalListing.frame, within: viewport),
            "Final listing frame \(finalListing.frame) must fit within the unobscured scroll viewport \(viewport)."
        )
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
        app.launchAfterRetiringPriorInstance()
        return app
    }

    private func scrollUntilFullyVisible(
        _ scrollView: XCUIElement,
        element: XCUIElement,
        in app: XCUIApplication,
        maximumSwipes: Int,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertTrue(scrollView.waitForExistence(timeout: 3), file: file, line: line)
        let viewport = unobscuredScrollViewport(scrollView, in: app)

        for _ in 0..<maximumSwipes {
            if element.exists {
                let frame = element.frame
                if isFullyVisible(frame, within: viewport), element.isHittable {
                    return
                }
                if frame.minY < viewport.minY {
                    nudge(scrollView, upward: false)
                    continue
                }
            }
            nudge(scrollView, upward: true)
        }

        XCTAssertTrue(element.exists, "Final listing never appeared.", file: file, line: line)
        XCTAssertTrue(element.isHittable, "Final listing never became hittable.", file: file, line: line)
        XCTAssertTrue(
            isFullyVisible(element.frame, within: viewport),
            "Final listing never became fully visible after \(maximumSwipes) swipes. Frame: \(element.frame), viewport: \(viewport)",
            file: file,
            line: line
        )
    }

    private func nudge(_ scrollView: XCUIElement, upward: Bool) {
        let startY = upward ? 0.68 : 0.32
        let endY = upward ? 0.48 : 0.52
        let start = scrollView.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: startY))
        let end = scrollView.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: endY))
        start.press(forDuration: 0.05, thenDragTo: end)
    }

    private func unobscuredScrollViewport(
        _ scrollView: XCUIElement,
        in app: XCUIApplication
    ) -> CGRect {
        let scrollViewport = scrollView.frame.intersection(app.windows.firstMatch.frame)
        let dock = app.buttons["dock.capture"]
        let dockTop = dock.exists
            ? dock.frame.midY - (sellerHomeV15DockHeight / 2)
            : scrollViewport.maxY
        let unobscuredMaxY = dock.exists
            ? min(scrollViewport.maxY, dockTop)
            : scrollViewport.maxY

        return CGRect(
            x: scrollViewport.minX,
            y: scrollViewport.minY,
            width: scrollViewport.width,
            height: max(0, unobscuredMaxY - scrollViewport.minY)
        )
    }

    private func isFullyVisible(_ frame: CGRect, within viewport: CGRect) -> Bool {
        frame.minX >= viewport.minX
            && frame.maxX <= viewport.maxX
            && frame.minY >= viewport.minY
            && frame.maxY <= viewport.maxY
    }
}
