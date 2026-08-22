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
        // A settled tile is a control now that it opens its run (#866), so it is
        // published as a button. Its spoken label is unchanged.
        XCTAssertTrue(
            settled.buttons.element(
                matching: NSPredicate(
                    format: "label BEGINSWITH %@ AND NOT label CONTAINS %@",
                    "DualSense controller",
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

    /// Trophy Wall is the seller's one return destination, and the tile is how
    /// they reach the listing their photos produced. #963 removed the
    /// intermediate run-status card the tile used to push: a tap now opens
    /// Listing Review directly, and dismissing it returns to the same wall.
    func testSettledTileOpensListingReviewDirectlyAndReturnsToTrophyWall() {
        let app = launch(
            "HOME-01",
            extraArguments: ["--run-detail-fixture=reviewable"]
        )
        let wall = app.otherElements["trophy.wall"]
        XCTAssertTrue(wall.waitForExistence(timeout: 3))

        let tile = app.firstSettledWallTile
        XCTAssertTrue(tile.waitForExistence(timeout: 3))
        // Measured rather than asked: `isHittable` answers true for a control
        // sitting under an overlay, and the whole tile has to be the target.
        XCTAssertGreaterThanOrEqual(tile.frame.width, 44)
        XCTAssertGreaterThanOrEqual(tile.frame.height, 44)
        tile.tap()

        XCTAssertTrue(app.otherElements["listing-review"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.otherElements["run.detail"].exists)

        app.buttons["listing-review.back"].tap()
        XCTAssertTrue(wall.waitForExistence(timeout: 3))
    }

    /// The tile is one cell of the grid at every text size, so the target it
    /// offers is the cell rather than a label that grows or shrinks inside it.
    func testWallTilesStayTappableAtTheLargestAccessibilitySize() {
        let app = launch(
            "HOME-01",
            extraArguments: [
                "--run-detail-fixture=reviewable",
                "--dynamic-type=accessibility5",
            ]
        )
        let grid = app.scrollViews["trophy.wall.grid"]
        XCTAssertTrue(grid.waitForExistence(timeout: 5))

        let tile = app.firstSettledWallTile
        XCTAssertTrue(tile.waitForExistence(timeout: 5))
        XCTAssertGreaterThanOrEqual(tile.frame.width, 44)
        XCTAssertGreaterThanOrEqual(tile.frame.height, 44)
        tile.tap()

        XCTAssertTrue(app.otherElements["listing-review"].waitForExistence(timeout: 5))
    }

    /// A ready item whose draft the server refuses to load must say so where
    /// the seller already is, never by resurrecting an intermediate screen.
    func testSettledTileSurfacesUnavailableInlineWhenTheDraftCannotLoad() {
        let app = launch(
            "HOME-01",
            extraArguments: ["--run-detail-fixture=unavailable"]
        )
        let wall = app.otherElements["trophy.wall"]
        XCTAssertTrue(wall.waitForExistence(timeout: 3))

        let tile = app.firstSettledWallTile
        XCTAssertTrue(tile.waitForExistence(timeout: 3))
        tile.tap()

        let becameUnavailable = XCTNSPredicateExpectation(
            predicate: NSPredicate(
                format: "label CONTAINS %@",
                "Listing unavailable. Try again."
            ),
            object: tile
        )
        XCTAssertEqual(XCTWaiter.wait(for: [becameUnavailable], timeout: 3), .completed)
        XCTAssertFalse(app.otherElements["listing-review"].exists)
        XCTAssertFalse(app.otherElements["run.detail"].exists)
        XCTAssertTrue(wall.waitForExistence(timeout: 2))
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

        // Type-agnostic: retrying/not-listed rows are plain accessibility
        // elements, not buttons — they have nowhere direct to go (#963).
        let retryingRow = app.descendants(matching: .any)[
            "trophy.processing.row.run.\(retryingRunID)"
        ]
        let staticFailureRow = app.descendants(matching: .any)[
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

    /// The pill was one tap to the listing and the rest of the row was two,
    /// through a Run Detail screen that only repeated what the row already said
    /// and offered the same Review button again (#897). Tapping the body now
    /// lands on the same listing the pill reaches.
    func testProcessingReadyRowBodyOpensListingReviewAndNeverRunDetail() {
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
        let row = app.buttons["trophy.processing.row.run.\(runID)"]
        XCTAssertTrue(row.waitForExistence(timeout: 3))

        // Off to the leading side, where the item name is, so this is the row
        // body and not the trailing pill the other test already taps.
        row.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.5)).tap()

        let listingReview = app.otherElements["listing-review"]
        XCTAssertTrue(listingReview.waitForExistence(timeout: 3))
        XCTAssertEqual(
            listingReview.value as? String,
            "listing-review.binding.run.\(runID).listing.\(listingID)"
        )
        XCTAssertFalse(app.otherElements["run.detail"].exists)
    }

    /// #963: a needs-retry row acts inline. The row's whole body is the same
    /// control as its trailing Retry pill, not a push to an intermediate
    /// screen, so a tap anywhere on it retries in place.
    func testProcessingUnreadyRowBodyRetriesInlineAndNeverOpensRunDetail() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--fixture=trophy-processing",
            "--zero-network-fixtures",
            "--reset-onboarding-progress",
        ]
        app.launchAfterRetiringPriorInstance()

        let runID = "37500000-0000-4000-8000-000000000004"
        // Type-agnostic: the row is a button while needs-retry, then a plain
        // accessibility element once retrying (#963 rows are not controls
        // outside an actionable state).
        let row = app.descendants(matching: .any)[
            "trophy.processing.row.run.\(runID)"
        ]
        XCTAssertTrue(row.waitForExistence(timeout: 3))
        XCTAssertEqual(
            row.label,
            "Canon AE-1 film camera, needs retry. The last attempt did not finish."
        )

        row.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.5)).tap()

        let projectsRetryingTruth = XCTNSPredicateExpectation(
            predicate: NSPredicate(
                format: "label == %@",
                "Canon AE-1 film camera, retrying."
            ),
            object: row
        )
        XCTAssertEqual(
            XCTWaiter().wait(for: [projectsRetryingTruth], timeout: 3),
            .completed
        )
        XCTAssertFalse(app.otherElements["run.detail"].exists)
        XCTAssertFalse(app.otherElements["listing-review"].exists)
    }

    /// Processing had no way to ask the server for fresh status short of
    /// leaving the screen and coming back (#897). Nothing polls, so the control
    /// has to be here, and it has to say when it is working.
    func testProcessingRefreshControlRunsAndReportsWhileItWorks() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--fixture=trophy-processing",
            "--zero-network-fixtures",
            "--reset-onboarding-progress",
        ]
        app.launchAfterRetiringPriorInstance()

        let refresh = app.buttons["trophy.processing.refresh"]
        XCTAssertTrue(refresh.waitForExistence(timeout: 3))
        XCTAssertEqual(refresh.value as? String, "")

        refresh.tap()

        assertValueIsReached("Refreshing", on: refresh, timeout: 3)
        assertValueIsReached("", on: refresh, timeout: 5)

        // The seller asked for status, not for a different screen.
        XCTAssertTrue(app.buttons["trophy.processing.row.run.37500000-0000-4000-8000-000000000003"].exists)
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
        // Type-agnostic: retries leave the row a plain accessibility element,
        // not a button (#963).
        let retryRow = app.descendants(matching: .any)[
            "trophy.processing.row.run.\(retryRunID)"
        ]
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
    /// This used to be proved by height alone: the name shared its line with
    /// the action pill, so at accessibility5 it had barely a third of the row
    /// to wrap in, needed four lines, and a two-line cap visibly cut it. The
    /// threshold was calibrated against that narrow column — clear 2.5x the
    /// one-line baseline and the title must have wrapped past two lines.
    ///
    /// #897 moved the action onto its own line at accessibility sizes, so the
    /// name now owns the full row. The same title fits inside two lines there,
    /// and the old threshold no longer discriminates: measured against this
    /// head, "Vintage Pyrex bowl set" renders at 123.3pt with the line limit
    /// unbounded and at 123.3pt with `.lineLimit(2)` forced, because two lines
    /// is all it asks for. Height cannot tell the two apart anymore.
    ///
    /// What the wider column can still prove is the condition that made
    /// truncation possible in the first place. "Sony Walkman" (12 characters)
    /// fits one line at this scale and shares its row with a pill, so it is
    /// the squeezed-column baseline. The long title must be given more width
    /// than that, must wrap past a single line, and must be drawn complete
    /// inside its own row rather than clipped against it.
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
        // Wider than the column a pill leaves beside it: this is the #897 fix,
        // and it is what keeps the title inside two lines at this scale.
        XCTAssertGreaterThan(
            longTitle.frame.width,
            shortTitle.frame.width,
            receipt
        )
        // Still wrapping rather than collapsing onto one clipped line.
        XCTAssertGreaterThan(
            longTitle.frame.height,
            shortTitle.frame.height,
            receipt
        )
        // Drawn complete inside its row. A row that failed to grow for the
        // name would cut it here even though the name itself is unbounded.
        XCTAssertTrue(
            firstRow.frame.contains(longTitle.frame),
            receipt + ", firstRow.frame=\(firstRow.frame)"
        )
    }

    /// Proves the last settled tile remains reachable above the floating dock.
    /// The approved six-tile fixture can fit on taller viewports, so scrolling
    /// is conditional rather than part of the behavior contract.
    func testFinalWallTileClearsTheFloatingDockWhenScrolled() {
        let app = launch("HOME-01")
        let scroll = app.scrollViews["trophy.wall.grid"]
        let finalTile = app.buttons.element(
            matching: NSPredicate(
                format: "label BEGINSWITH %@",
                "Charizard card, second copy"
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

    /// Waits for an element's accessibility `value` to be exactly `expected`,
    /// sampling the element itself rather than handing the question to
    /// `XCTNSPredicateExpectation`.
    ///
    /// #926. The refresh control's `Refreshing` state lives about a second, and
    /// a predicate expectation could not be relied on to sample inside it: over
    /// six probe taps on iPhone 17 Pro / iOS 26.5, reading `value` directly the
    /// instant `tap()` returned saw `Refreshing` 6 times out of 6, while
    /// `XCTNSPredicateExpectation(value == "Refreshing")` reported `.completed`
    /// only once. Raising the timeout cannot fix that — by the time the
    /// expectation's next sample lands the state is over — and widening what
    /// counts as in-flight would assert nothing. Sampling as fast as a snapshot
    /// allows keeps the claim exact and stops it from missing a state the app
    /// really did show.
    ///
    /// `value` is `Any?`, so it is unwrapped through `as? String` rather than
    /// interpolated; a `String(describing:)` comparison would be measuring
    /// `Optional(Refreshing)`.
    private func assertValueIsReached(
        _ expected: String,
        on element: XCUIElement,
        timeout: TimeInterval,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let deadline = Date().addingTimeInterval(timeout)
        var observed = element.value as? String
        while observed != expected, Date() < deadline {
            observed = element.value as? String
        }
        XCTAssertEqual(
            observed,
            expected,
            "\(element) never reached value \(expected) within \(timeout)s.",
            file: file,
            line: line
        )
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
    /// The first HOME-01 tile. Its run id comes from the fixture wall, so a
    /// missing element here means the tile carries no run destination at all.
    var firstSettledWallTile: XCUIElement {
        buttons["trophy.wall.tile.run.37500000-0000-4000-8000-000000000021"]
    }
}
