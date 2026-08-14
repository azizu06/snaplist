import XCTest

final class HomeUITests: XCTestCase {
    // The UI-test target cannot import the app's internal design tokens.
    private let liveV32DockHeight: CGFloat = 56

    override func setUpWithError() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
    }

    /// HOME-01 is the settled wall and HOME-02 is the empty wall. Those are the
    /// two approved Trophy Wall states. HOME-03 and HOME-04 were the attention
    /// feed and the listings search, and both were retired with the
    /// seller-operations surface rather than restyled.
    func testApprovedTrophyWallStatesRenderTheirDurableTruth() {
        let settled = launch("HOME-01")
        XCTAssertTrue(
            settled.scrollViews["trophy.wall.grid"].waitForExistence(timeout: 3)
        )
        XCTAssertTrue(
            settled.images.element(
                matching: NSPredicate(
                    format: "label BEGINSWITH %@ AND NOT label CONTAINS %@",
                    "White leather sneaker",
                    "photo unavailable"
                )
            ).waitForExistence(timeout: 2)
        )
        XCTAssertFalse(settled.otherElements["trophy.wall.empty"].exists)
        settled.terminate()

        let empty = launch("HOME-02")
        XCTAssertTrue(empty.staticTexts["No items yet"].waitForExistence(timeout: 3))
        XCTAssertTrue(empty.buttons["trophy.wall.scan"].exists)
        XCTAssertFalse(empty.scrollViews["trophy.wall.grid"].exists)
        XCTAssertTrue(empty.staticTexts["Trophy Wall"].isHittable)
        XCTAssertTrue(empty.buttons["trophy.wall.processing"].isHittable)
        XCTAssertTrue(empty.buttons["trophy.wall.account"].isHittable)
    }

    /// The seller-Home run row that used to open this screen is gone, so the
    /// route is entered the way it is still reachable in the product. What Back
    /// must restore is the wall itself, which is now the one return destination.
    func testRunDetailUsesSystemBackAndReturnsToTrophyWall() {
        let app = launch("HOME-01")
        let wall = app.otherElements["trophy.wall"]
        XCTAssertTrue(wall.waitForExistence(timeout: 3))

        app.openRunDetail()

        XCTAssertTrue(app.otherElements["run.detail"].waitForExistence(timeout: 3))
        let back = app.buttons["Back"]
        XCTAssertTrue(back.exists)
        back.tap()

        XCTAssertTrue(wall.waitForExistence(timeout: 3))
    }

    func testRunDetailShowsFactualUnavailableState() {
        let app = launch("HOME-01", extraArguments: ["--run-detail-fixture=unavailable"])
        app.openRunDetail()

        XCTAssertTrue(app.staticTexts["Run unavailable"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["We couldn’t load this run."].exists)
    }

    func testRunDetailShowsLoadedItemAndStageTruth() {
        let app = launch("RUN-02", extraArguments: ["--run-detail-fixture=loaded"])

        XCTAssertTrue(app.staticTexts["Canon AE-1 film camera"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Processing"].exists)
        XCTAssertTrue(app.staticTexts["Researching pricing evidence"].exists)
        XCTAssertFalse(app.staticTexts["Finding recent sold comps"].exists)
    }

    func testFailedRunStatusDominatesStaleActiveStageCopy() {
        assertTerminalRunStatus(
            fixture: "failed",
            heading: "Run failed",
            status: "Failed"
        )
    }

    func testCanceledRunStatusDominatesStaleActiveStageCopy() {
        assertTerminalRunStatus(
            fixture: "canceled",
            heading: "Run canceled",
            status: "Canceled",
            expectsStoppedCopy: true
        )
    }

    func testFailedRunDetailKeepsMaximumSellerSafeFailureReachableAtAccessibilityType() {
        let app = launch(
            "HOME-01",
            extraArguments: [
                "--run-detail-fixture=failed",
                "--dynamic-type=accessibility5",
            ]
        )
        let wall = app.otherElements["trophy.wall"]
        XCTAssertTrue(wall.waitForExistence(timeout: 3))
        app.openRunDetail()

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

        let back = app.buttons["Back"]
        XCTAssertTrue(back.waitForExistence(timeout: 3))
        back.tap()
        XCTAssertTrue(
            waitForDisappearance(of: app.otherElements["run.detail"]),
            "System Back must finish dismissing Run Detail before the wall is asserted."
        )
        XCTAssertTrue(wall.waitForExistence(timeout: 3))
    }

    func testCompletedRunOffersReviewCopyOnlyWhenServerAllowsIt() {
        let unavailable = launch(
            "HOME-01",
            extraArguments: ["--run-detail-fixture=completed"]
        )
        unavailable.openRunDetail()

        XCTAssertTrue(unavailable.staticTexts["Run completed"].waitForExistence(timeout: 3))
        XCTAssertTrue(unavailable.staticTexts["Review unavailable"].exists)
        XCTAssertFalse(unavailable.staticTexts["Ready to review"].exists)
        XCTAssertFalse(unavailable.staticTexts["Working on your item"].exists)
        unavailable.terminate()

        let reviewable = launch(
            "HOME-01",
            extraArguments: ["--run-detail-fixture=reviewable"]
        )
        reviewable.openRunDetail()

        XCTAssertTrue(reviewable.staticTexts["Run completed"].waitForExistence(timeout: 3))
        XCTAssertTrue(reviewable.staticTexts["Ready to review"].exists)
        XCTAssertFalse(reviewable.staticTexts["Review unavailable"].exists)
    }

    func testRunDetailRefreshIsAccessibleAndReplacesServerTruth() {
        let app = launch("HOME-01", extraArguments: ["--run-detail-fixture=refresh"])
        app.openRunDetail()
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
        // Every wait here is a view a navigation this test drove has to bring
        // back, so all three go through the shared budget. A literal here is a
        // bet on runner speed, which is what flaked this test on ui-2 (#710).
        let navigation = UINavigationReturnBoundary()
        let app = launch("HOME-01", extraArguments: ["--run-detail-fixture=loaded"])
        let wall = app.otherElements["trophy.wall"]
        XCTAssertTrue(navigation.restored(wall))

        app.openRunDetail()

        XCTAssertTrue(navigation.restored(app.staticTexts["Canon AE-1 film camera"]))
        app.buttons["Back"].tap()
        XCTAssertTrue(navigation.restored(wall))
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

    func testEmptyWallScanActionSelectsTheScanDestination() {
        let app = launch("HOME-02")
        let scan = app.buttons["trophy.wall.scan"]

        XCTAssertTrue(scan.waitForExistence(timeout: 3))
        XCTAssertGreaterThanOrEqual(scan.frame.height, 44)
        scan.tap()

        let dockScan = app.buttons["dock.scan"]
        XCTAssertTrue(dockScan.waitForExistence(timeout: 3))
        XCTAssertTrue(dockScan.isSelected)
    }

    /// One dock, two destinations, on every screen that shows it. The Scan
    /// camera used to draw its own `scan.tab` / `trophy-wall.tab` control; it now
    /// renders the same component, so the identifiers below are the only pair
    /// that exists anywhere in the app.
    func testDockShowsTheTwoApprovedDestinationsOnBothPrimaryScreens() {
        let app = launch("HOME-02")

        XCTAssertTrue(app.buttons["dock.trophy-wall"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["dock.scan"].exists)
        XCTAssertTrue(app.buttons["dock.trophy-wall"].isSelected)
        XCTAssertFalse(app.buttons["dock.capture"].exists)
        XCTAssertFalse(app.buttons["scan.tab"].exists)
        XCTAssertFalse(app.buttons["trophy-wall.tab"].exists)

        app.buttons["dock.scan"].tap()

        XCTAssertTrue(app.buttons["dock.scan"].isSelected)
        XCTAssertTrue(app.buttons["dock.trophy-wall"].exists)
        XCTAssertFalse(app.buttons["dock.capture"].exists)
        XCTAssertFalse(app.buttons["scan.tab"].exists)
        XCTAssertFalse(app.buttons["trophy-wall.tab"].exists)
    }

    func testTrophyWallFixtureUsesValidatedWallAndPushedProcessing() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--fixture=trophy-wall",
            "--zero-network-fixtures",
            "--reset-onboarding-progress"
        ]
        app.launchAfterRetiringPriorInstance()

        let wall = app.otherElements["trophy.wall"]
        XCTAssertTrue(wall.waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Trophy Wall"].exists)
        XCTAssertFalse(app.buttons["home.search.open"].exists)
        XCTAssertFalse(app.staticTexts["Orders"].exists)

        let processing = app.buttons["trophy.wall.processing"]
        XCTAssertTrue(processing.isHittable)
        XCTAssertGreaterThanOrEqual(processing.frame.width, 44)
        XCTAssertGreaterThanOrEqual(processing.frame.height, 44)
        processing.tap()

        XCTAssertTrue(app.otherElements["trophy.processing"].waitForExistence(timeout: 2))
        app.buttons["trophy.processing.back"].tap()
        XCTAssertTrue(wall.waitForExistence(timeout: 2))
        XCTAssertTrue(processing.isHittable)
    }

    func testTrophyWallRemainsReachableAtAccessibilityTypeWithReducedMotion() {
        let app = launch(
            "HOME-02",
            extraArguments: ["--dynamic-type=accessibility3", "--reduced-motion"]
        )
        let scan = app.buttons["trophy.wall.scan"]

        XCTAssertTrue(scan.waitForExistence(timeout: 3))
        XCTAssertGreaterThanOrEqual(scan.frame.height, 44)

        // The trailing account control survives; the notification bell beside it
        // did not, and neither did the header that carried it.
        let account = app.buttons["trophy.wall.account"]
        XCTAssertTrue(account.exists)
        XCTAssertGreaterThanOrEqual(account.frame.width, 44)
        XCTAssertGreaterThanOrEqual(account.frame.height, 44)
        XCTAssertFalse(app.buttons["header.activity"].exists)
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
            "trophy.processing.row.run.37500000-0000-4000-8000-000000000004",
            "trophy.processing.row.run.37500000-0000-4000-8000-000000000005",
            "trophy.processing.row.run.37500000-0000-4000-8000-000000000006",
            "trophy.processing.row.run.37500000-0000-4000-8000-000000000007",
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
        // Six seeded rows, three visible: the sixth is the accepted row that
        // carries a staged photo, so the disclosure counts three hidden items
        // and drops the exact-count wording.
        XCTAssertEqual(disclosure.label, "Show more items")
        XCTAssertEqual(disclosure.value as? String, "Collapsed")
        XCTAssertGreaterThanOrEqual(disclosure.frame.height, 44)
        disclosure.tap()

        XCTAssertTrue(rows[3].waitForExistence(timeout: 3))
        XCTAssertTrue(rows[4].waitForExistence(timeout: 3))
        // The sixth seeded row is the accepted card carrying the seller's own
        // photo. Before it existed no UI run reached a processing row with a
        // photo at all, which is why the empty slot survived every suite.
        XCTAssertTrue(
            app.descendants(matching: .any)[
                "trophy.processing.row.run.37500000-0000-4000-8000-000000000011"
            ].waitForExistence(timeout: 3)
        )
        for (earlier, later) in zip(rows, rows.dropFirst()) {
            XCTAssertLessThan(earlier.frame.minY, later.frame.minY)
        }

        let expandedDisclosure = app.buttons["trophy.processing.disclosure"]
        XCTAssertEqual(expandedDisclosure.label, "Show fewer items")
        XCTAssertEqual(expandedDisclosure.value as? String, "Expanded")
        XCTAssertFalse(app.otherElements["run.detail"].exists)
        expandedDisclosure.tap()

        let collapsedDisclosure = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "value == %@", "Collapsed"),
            object: expandedDisclosure
        )
        XCTAssertEqual(
            XCTWaiter.wait(for: [collapsedDisclosure], timeout: 5),
            .completed
        )

        // XCTest can retain a stale generic accessibility node after SwiftUI
        // removes a ForEach row. Hittability observes what the seller can
        // still reach; HomeFeatureTests separately proves visible-row membership.
        for identifier in rowIdentifiers.suffix(2) {
            XCTAssertFalse(app.descendants(matching: .any)[identifier].isHittable)
        }
        XCTAssertTrue(rows[0].exists)
        XCTAssertTrue(rows[1].exists)
        XCTAssertTrue(rows[2].exists)
        XCTAssertEqual(
            app.buttons["trophy.processing.disclosure"].value as? String,
            "Collapsed"
        )
        XCTAssertFalse(app.otherElements["run.detail"].exists)
    }

    func testProcessingV32ActionsAndTerminalTruthExposeIndependentAccessibility() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--fixture=trophy-processing",
            "--zero-network-fixtures",
            "--reset-onboarding-progress",
        ]
        app.launchAfterRetiringPriorInstance()

        let reviewRunID = "37500000-0000-4000-8000-000000000003"
        let retryRunID = "37500000-0000-4000-8000-000000000004"
        let scanRunID = "37500000-0000-4000-8000-000000000005"
        let retryingRunID = "37500000-0000-4000-8000-000000000006"
        let staticFailureRunID = "37500000-0000-4000-8000-000000000007"

        let reviewAction = app.buttons[
            "trophy.processing.action.review.\(reviewRunID)"
        ]
        XCTAssertTrue(reviewAction.waitForExistence(timeout: 3))
        guard reviewAction.exists else { return }

        let reviewRow = app.buttons["trophy.processing.row.run.\(reviewRunID)"]
        let retryRow = app.buttons["trophy.processing.row.run.\(retryRunID)"]
        let scanRow = app.buttons["trophy.processing.row.run.\(scanRunID)"]
        XCTAssertTrue(reviewRow.waitForExistence(timeout: 3))
        XCTAssertEqual(
            reviewRow.label,
            "Vintage Pyrex bowl set, ready to review."
        )
        XCTAssertEqual(
            retryRow.label,
            "Canon AE-1 film camera, needs retry. The last attempt did not finish."
        )
        XCTAssertEqual(
            scanRow.label,
            "Nintendo Game Boy, needs retry. Add a new photo to try again."
        )

        let retryAction = app.buttons[
            "trophy.processing.action.retry.\(retryRunID)"
        ]
        let scanAction = app.buttons[
            "trophy.processing.action.scan.\(scanRunID)"
        ]
        XCTAssertEqual(reviewAction.label, "Review Vintage Pyrex bowl set")
        XCTAssertEqual(retryAction.label, "Retry Canon AE-1 film camera")
        XCTAssertEqual(scanAction.label, "Scan a new photo for Nintendo Game Boy")
        for action in [reviewAction, retryAction, scanAction] {
            XCTAssertTrue(action.isHittable)
            XCTAssertGreaterThanOrEqual(action.frame.width, 44)
            XCTAssertGreaterThanOrEqual(action.frame.height, 44)
        }

        let actionScreenshot = XCTAttachment(
            screenshot: XCUIScreen.main.screenshot()
        )
        actionScreenshot.name = "PROC-V32-actions"
        actionScreenshot.lifetime = .keepAlways
        add(actionScreenshot)
        let actionsAccessibility = XCTAttachment(string: app.debugDescription)
        actionsAccessibility.name = "PROC-V32-actions-AX"
        actionsAccessibility.lifetime = .keepAlways
        add(actionsAccessibility)

        reviewAction.tap()
        XCTAssertFalse(app.otherElements["run.detail"].exists)

        let disclosure = app.buttons["trophy.processing.disclosure"]
        XCTAssertTrue(disclosure.isHittable)
        disclosure.tap()

        let retryingRow = app.buttons[
            "trophy.processing.row.run.\(retryingRunID)"
        ]
        let staticFailureRow = app.buttons[
            "trophy.processing.row.run.\(staticFailureRunID)"
        ]
        XCTAssertTrue(retryingRow.waitForExistence(timeout: 3))
        XCTAssertEqual(retryingRow.label, "Sony Walkman, retrying.")
        XCTAssertTrue(staticFailureRow.waitForExistence(timeout: 3))
        XCTAssertEqual(
            staticFailureRow.label,
            "Polaroid camera, not listed. This item could not be processed."
        )
        XCTAssertFalse(
            app.buttons["trophy.processing.action.retry.\(retryingRunID)"].exists
        )
        XCTAssertFalse(
            app.buttons[
                "trophy.processing.action.scan.\(staticFailureRunID)"
            ].exists
        )

        let processingRows = app.scrollViews.firstMatch
        scrollUntilFullyVisible(
            processingRows,
            element: staticFailureRow,
            in: app,
            maximumSwipes: 4
        )
        let terminalScreenshot = XCTAttachment(
            screenshot: XCUIScreen.main.screenshot()
        )
        terminalScreenshot.name = "PROC-V32-terminal-recovery"
        terminalScreenshot.lifetime = .keepAlways
        add(terminalScreenshot)
        let terminalAccessibility = XCTAttachment(string: app.debugDescription)
        terminalAccessibility.name = "PROC-V32-terminal-recovery-AX"
        terminalAccessibility.lifetime = .keepAlways
        add(terminalAccessibility)
    }

    func testProcessingScanActionSelectsScanWithoutChangingItsRunRoute() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--fixture=trophy-processing",
            "--zero-network-fixtures",
            "--reset-onboarding-progress",
        ]
        app.launchAfterRetiringPriorInstance()

        let runID = "37500000-0000-4000-8000-000000000005"
        let row = app.buttons["trophy.processing.row.run.\(runID)"]
        let scan = app.buttons["trophy.processing.action.scan.\(runID)"]
        XCTAssertTrue(row.waitForExistence(timeout: 3))
        XCTAssertTrue(scan.waitForExistence(timeout: 3))

        scan.tap()

        let scanDock = app.buttons["dock.scan"]
        XCTAssertTrue(scanDock.waitForExistence(timeout: 3))
        XCTAssertTrue(scanDock.isSelected)
        XCTAssertFalse(app.otherElements["run.detail"].exists)
    }

    func testProcessingReviewActionOpensExactSameRunListingReview() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--fixture=trophy-processing",
            "--zero-network-fixtures",
            "--reset-onboarding-progress",
            "--run-detail-fixture=reviewable",
            "--listing-review-fixture=loaded",
            "--reset-listing-review-draft",
        ]
        app.launchAfterRetiringPriorInstance()

        let runID = "37500000-0000-4000-8000-000000000003"
        let listingID = "37500000-0000-4000-8000-000000000008"
        let review = app.buttons[
            "trophy.processing.action.review.\(runID)"
        ]
        XCTAssertTrue(review.waitForExistence(timeout: 3))

        review.tap()

        XCTAssertTrue(
            app.otherElements["listing-review"].waitForExistence(timeout: 3)
        )
        let listingReview = app.otherElements["listing-review"]
        XCTAssertEqual(
            listingReview.value as? String,
            "listing-review.binding.run.\(runID).listing.\(listingID)"
        )
        XCTAssertFalse(app.otherElements["run.detail"].exists)
    }

    func testProcessingRetryActionProjectsOnlyServerAcceptedRetryTruth() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--fixture=trophy-processing",
            "--zero-network-fixtures",
            "--reset-onboarding-progress",
        ]
        app.launchAfterRetiringPriorInstance()

        let retryRunID = "37500000-0000-4000-8000-000000000004"
        let retryRow = app.buttons["trophy.processing.row.run.\(retryRunID)"]
        let retry = app.buttons["trophy.processing.action.retry.\(retryRunID)"]
        let reviewRow = app.buttons[
            "trophy.processing.row.run.37500000-0000-4000-8000-000000000003"
        ]
        let scanRow = app.buttons[
            "trophy.processing.row.run.37500000-0000-4000-8000-000000000005"
        ]
        XCTAssertTrue(retryRow.waitForExistence(timeout: 3))
        XCTAssertTrue(retry.waitForExistence(timeout: 3))
        XCTAssertTrue(reviewRow.waitForExistence(timeout: 3))
        XCTAssertTrue(scanRow.waitForExistence(timeout: 3))
        XCTAssertEqual(
            retryRow.label,
            "Canon AE-1 film camera, needs retry. The last attempt did not finish."
        )

        retry.tap()

        let projectsRetryingTruth = XCTNSPredicateExpectation(
            predicate: NSPredicate(
                format: "label == %@",
                "Canon AE-1 film camera, retrying."
            ),
            object: retryRow
        )
        XCTAssertEqual(
            XCTWaiter().wait(for: [projectsRetryingTruth], timeout: 3),
            .completed
        )
        XCTAssertTrue(retryRow.exists)
        XCTAssertFalse(retry.exists)
        XCTAssertEqual(
            reviewRow.label,
            "Vintage Pyrex bowl set, ready to review."
        )
        XCTAssertEqual(
            scanRow.label,
            "Nintendo Game Boy, needs retry. Add a new photo to try again."
        )
        XCTAssertFalse(app.otherElements["run.detail"].exists)
    }

    /// Trophy Wall's processing-state label used to hard-truncate to one
    /// line (`.lineLimit(1)`) regardless of Dynamic Type, so a
    /// sentence-length processing state silently lost its ending at the
    /// largest accessibility size (#831, `HomeViews.swift` state-label
    /// site). The fix switches it to
    /// `dynamicTypeSize.isAccessibilitySize ? nil : 1`, matching the
    /// `isAccessibilitySize` idiom already used elsewhere in this codebase
    /// (`ListingReviewView.footer`/`priceEditing`, `ProGateView`,
    /// `FirstValueOnboardingView`).
    ///
    /// This proves it structurally, not by a hardcoded bound. The
    /// trophy-processing fixture's terminal "Polaroid camera" row carries
    /// the full sentence "This item could not be processed.", while its
    /// "Sony Walkman" row sits right beside it carrying only the single
    /// word "Retrying" — a word that cannot wrap onto a second line at any
    /// font size. Both labels share the identical `.status` typography and
    /// identical row layout, so at the largest accessibility size a
    /// `lineLimit(1)` label would render both at the same single-line
    /// height; only a wrapped, unbounded label can make the sentence
    /// measurably taller than the single word beside it. (Measured against
    /// this head: "Retrying" renders at 44.3pt, the sentence at 88.3pt —
    /// almost exactly double, consistent with a two-line wrap.)
    ///
    /// The disclosure label (`HomeViews.swift:527`, same class of fix) is
    /// not covered by an equivalent geometric assertion here: on this
    /// fixture and device, "Show fewer items" / "Show 2 more items" both
    /// measured a single-line 48pt regardless of the fix, because the
    /// trophy-processing fixture never produces a disclosure string long
    /// enough to wrap at this row width. Growing that fixture's row count
    /// to force a longer count string would still only add one digit, not
    /// enough width to wrap, and would also break several other tests that
    /// assert this fixture's exact row set and disclosure copy. Widening it
    /// honestly needs its own fixture, which is out of this delta's scope.
    func testTrophyWallProcessingStateLabelStopsTruncatingAtLargestAccessibilitySize() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--fixture=trophy-processing",
            "--zero-network-fixtures",
            "--reset-onboarding-progress",
            "--dynamic-type=accessibility5",
        ]
        app.launchAfterRetiringPriorInstance()

        let firstRow = app.buttons[
            "trophy.processing.row.run.37500000-0000-4000-8000-000000000003"
        ]
        XCTAssertTrue(firstRow.waitForExistence(timeout: 10))

        let disclosure = app.buttons["trophy.processing.disclosure"]
        XCTAssertTrue(disclosure.waitForExistence(timeout: 10))
        disclosure.tap()

        let retryingLabel = app.staticTexts["Retrying"]
        let notListedLabel = app.staticTexts["This item could not be processed."]
        XCTAssertTrue(retryingLabel.waitForExistence(timeout: 10))
        XCTAssertTrue(notListedLabel.waitForExistence(timeout: 10))

        let receipt =
            "retryingLabel.frame=\(retryingLabel.frame), "
            + "notListedLabel.frame=\(notListedLabel.frame)"
        // A single word ("Retrying") cannot wrap, so its height is this
        // font scale's true single-line floor. The six-word sentence must
        // clear that floor by a wide margin — a lineLimit(1) truncation
        // defect would instead hold both to the same single-line height.
        XCTAssertGreaterThan(
            notListedLabel.frame.height,
            retryingLabel.frame.height + 20,
            receipt
        )
    }

    /// Trophy Wall's processing-row item name was capped at `.lineLimit(2)`
    /// unconditionally, with no accessibility-size guard, so at the largest
    /// accessibility Dynamic Type size a long item name still ellipsized: the
    /// two-line cap holds roughly 30 characters at the default size but only
    /// roughly 12 at accessibility5, so a title this size cannot fit within
    /// two lines and is silently cut (#831 acceptance: "no label truncates"
    /// at the largest accessibility size). The fix switches it to
    /// `dynamicTypeSize.isAccessibilitySize ? nil : 2`, the same idiom used
    /// at the state-label site above.
    ///
    /// This proves it structurally. "Sony Walkman" (two words, 12
    /// characters) fits on a single line at accessibility5 whether the
    /// title's line limit is 2 or unbounded, so its height is unaffected by
    /// the fix and serves as this font scale's true baseline. "Vintage
    /// Pyrex bowl set" (23 characters) does not fit within two lines at this
    /// scale: unfixed, `.lineLimit(2)` caps it at a two-line height
    /// (ellipsizing); fixed, it wraps to as many lines as it needs. A flat
    /// margin over the baseline would not discriminate here, because even
    /// the *unfixed* two-line cap is already taller than a one-line title —
    /// so the assertion instead requires the long title to clear a multiple
    /// of the short title's height, calibrated so the two-line unfixed
    /// height fails it and the fixed multi-line height clears it. (Measured
    /// against this head: "Sony Walkman" renders at 50.7pt; "Vintage Pyrex
    /// bowl set" renders at 123.3pt unfixed — its two-line-capped height,
    /// which does not clear the 2.5x-plus-margin threshold — and 224.3pt
    /// fixed, roughly 4.4x the baseline, consistent with a four-line wrap.)
    func testTrophyWallProcessingItemNameStopsTruncatingAtLargestAccessibilitySize() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--fixture=trophy-processing",
            "--zero-network-fixtures",
            "--reset-onboarding-progress",
            "--dynamic-type=accessibility5",
        ]
        app.launchAfterRetiringPriorInstance()

        let firstRow = app.buttons[
            "trophy.processing.row.run.37500000-0000-4000-8000-000000000003"
        ]
        XCTAssertTrue(firstRow.waitForExistence(timeout: 10))

        let disclosure = app.buttons["trophy.processing.disclosure"]
        XCTAssertTrue(disclosure.waitForExistence(timeout: 10))
        disclosure.tap()

        let shortTitle = app.staticTexts["Sony Walkman"]
        let longTitle = app.staticTexts["Vintage Pyrex bowl set"]
        XCTAssertTrue(shortTitle.waitForExistence(timeout: 10))
        XCTAssertTrue(longTitle.waitForExistence(timeout: 10))

        let receipt =
            "shortTitle.frame=\(shortTitle.frame), longTitle.frame=\(longTitle.frame)"
        // The unfixed two-line cap already renders taller than one line, so
        // a flat margin over the short title would pass on both sides of
        // the fix. Requiring more than 2.5x the one-line baseline instead
        // fails against the unfixed two-line-capped height and only clears
        // once the title is free to wrap past two lines.
        XCTAssertGreaterThan(
            longTitle.frame.height,
            (shortTitle.frame.height * 2.5) + 10,
            receipt
        )
    }

    /// Proves the last settled tile remains reachable above the floating dock.
    /// The approved six-tile fixture can fit on taller viewports, so scrolling
    /// is conditional rather than part of the behavior contract.
    func testFinalWallTileClearsTheFloatingDockWhenScrolled() {
        let app = launch("HOME-01")
        let scroll = app.scrollViews["trophy.wall.grid"]
        let finalTile = app.images.element(
            matching: NSPredicate(
                format: "label BEGINSWITH %@",
                "White desk lamp, second item"
            )
        )

        XCTAssertTrue(scroll.waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["dock.scan"].waitForExistence(timeout: 3))
        let initialViewport = unobscuredScrollViewport(scroll, in: app)
        if !isVerticallyClear(finalTile.frame, within: initialViewport) {
            scrollUntilFullyVisible(
                scroll,
                element: finalTile,
                in: app,
                maximumSwipes: 16
            )
        }

        let viewport = unobscuredScrollViewport(scroll, in: app)
        XCTAssertTrue(finalTile.isHittable)
        XCTAssertTrue(
            isVerticallyClear(finalTile.frame, within: viewport),
            "Final tile frame \(finalTile.frame) must fit within the unobscured scroll viewport \(viewport)."
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

    private func waitForDisappearance(
        of element: XCUIElement,
        timeout: TimeInterval = 5
    ) -> Bool {
        let gone = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"),
            object: element
        )
        return XCTWaiter().wait(for: [gone], timeout: timeout) == .completed
    }

    private func assertTerminalRunStatus(
        fixture: String,
        heading: String,
        status: String,
        expectsStoppedCopy: Bool = false
    ) {
        let app = launch(
            "HOME-01",
            extraArguments: ["--run-detail-fixture=\(fixture)"]
        )
        app.openRunDetail()

        XCTAssertTrue(app.staticTexts[heading].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts[status].exists)
        XCTAssertFalse(app.staticTexts["Working on your item"].exists)
        XCTAssertFalse(app.staticTexts["Researching pricing evidence"].exists)
        if expectsStoppedCopy {
            XCTAssertTrue(app.staticTexts["Processing stopped"].exists)
            XCTAssertFalse(app.staticTexts["You canceled this run"].exists)
        }
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
                if isVerticallyClear(frame, within: viewport), element.isHittable {
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
            isVerticallyClear(element.frame, within: viewport),
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
        let dock = app.buttons["dock.scan"]
        // Compact SwiftUI buttons inside a safe-area inset report their frame
        // in the content coordinate space on iOS 26. Translate that local frame
        // by the wall header origin before comparing it with screen-space tiles.
        let dockTop = dock.exists
            ? dock.frame.midY - (liveV32DockHeight / 2) + scrollViewport.minY
            : app.windows.firstMatch.frame.maxY
        let unobscuredMaxY = dock.exists
            ? min(app.windows.firstMatch.frame.maxY, dockTop)
            : app.windows.firstMatch.frame.maxY

        return CGRect(
            x: scrollViewport.minX,
            y: scrollViewport.minY,
            width: scrollViewport.width,
            height: max(0, unobscuredMaxY - scrollViewport.minY)
        )
    }

    private func isVerticallyClear(_ frame: CGRect, within viewport: CGRect) -> Bool {
        frame.minY >= viewport.minY
            && frame.maxY <= viewport.maxY
    }
}

private extension XCUIApplication {
    /// Run Detail used to be entered by tapping a seller-Home run row. That row
    /// went with the retired surface, so the tests enter through the route the
    /// product still exposes. The identifier is the run the detail fixtures
    /// resolve against.
    func openRunDetail() {
        open(URL(string: "snaplist://runs/20800000-0000-4000-8000-000000000020")!)
    }
}
