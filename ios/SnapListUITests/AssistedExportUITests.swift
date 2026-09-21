import XCTest

/// Issue #581, seller-visible assisted-export behavior a unit test cannot reach.
///
/// `AssistedExportDomainTests` already proves that replacing a pack clears
/// `confirmSheet`. What it cannot prove is that SwiftUI takes the presented
/// sheet down through `updatePack(to:)`, and a sheet left standing over a stale
/// pack asks the seller to confirm a pack they were never shown. That is the
/// gap the first test closes. The other cases prove the Listing Review entry
/// point and the Prepared/Shared vocabulary in the rendered hierarchy.
final class AssistedExportUITests: XCTestCase {
    /// Budget for every wait that happens after a destination row has been
    /// tapped open. The initial row lookups keep their own budgets: those run
    /// against a cheap tree and are not at risk.
    ///
    /// This encodes the cost of *observing* the app, not the time the app needs
    /// to act. In the `serial` job on run 31151896079, a query against this
    /// screen cost 0.18s before the workspace rendered and about 4s after it,
    /// and `waitForExistence(timeout:)` budgets are wall clock rather than
    /// sample counts. A 5s budget therefore bought three samples, two of them at
    /// the same timestamp, and the step before the failing one needed 8.6s of
    /// wall clock to satisfy its own 5s budget. Nothing in the app is slow:
    /// `AssistedExportDomain.updatePack(to:)` clears `confirmSheet`
    /// synchronously on its first line.
    private let loadedTreeTimeout: TimeInterval = 30

    override func setUpWithError() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
    }

    // MARK: - Guide sheet (#1128)

    func testRowTapOpensTheSheetAndThePrimaryActionAdvancesOneStep() {
        let app = launch(fixture: "prepared")
        let row = app.buttons["assisted-export.row.facebook"]
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        openRow(row, in: app)

        XCTAssertEqual(position(in: app), "Step 1 of 4")

        primary(app, "copy-listing-text").tap()
        XCTAssertTrue(
            waitForLabel("Step 2 of 4", on: positionElement(in: app), timeout: loadedTreeTimeout),
            "One tap completes one step and no more."
        )

        primary(app, "save-8-photos").tap()
        XCTAssertTrue(
            waitForLabel("Step 3 of 4", on: positionElement(in: app), timeout: loadedTreeTimeout)
        )
    }

    func testClosingAndReopeningTheSheetResumesOnTheRightStep() {
        let app = launch(fixture: "prepared")
        let row = app.buttons["assisted-export.row.facebook"]
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        openRow(row, in: app)
        primary(app, "copy-listing-text").tap()
        XCTAssertTrue(
            waitForLabel("Step 2 of 4", on: positionElement(in: app), timeout: loadedTreeTimeout)
        )

        app.buttons["assisted-export.guide.close"].tap()
        XCTAssertTrue(
            waitForDisappearance(
                of: marker("assisted-export.guide.position", in: app),
                timeout: loadedTreeTimeout
            )
        )
        XCTAssertTrue(
            row.label.localizedCaseInsensitiveContains("prepared"),
            "Was: \"\(row.label)\""
        )

        openRow(row, in: app)
        XCTAssertEqual(position(in: app), "Step 2 of 4")
    }

    func testAPackUpdateTakesDownAConfirmQuestionTheSellerIsLookingAt() {
        let app = launch(fixture: "pack-update-while-confirming")

        let row = app.buttons["assisted-export.row.facebook"]
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        openRow(row, in: app)

        // Opening the row is navigation, so it is asserted apart from the
        // actions inside the sheet.
        primary(app, "copy-listing-text").tap()
        primary(app, "save-8-photos").tap()
        primary(app, "open-facebook-marketplace").tap()

        // The question is dismissed in the same breath it appears, so polling
        // for it would be a race. The fixture records the presentation durably
        // instead, which is what makes the dismissal assertion below mean
        // something.
        XCTAssertTrue(
            marker("assisted-export.fixture.sheet-was-presented", in: app)
                .waitForExistence(timeout: loadedTreeTimeout),
            "The confirm question must actually reach the screen first."
        )

        let question = marker("assisted-export.confirm-sheet", in: app)
        XCTAssertTrue(
            waitForDisappearance(of: question, timeout: loadedTreeTimeout),
            "A pack update must take the confirm question down, not leave it "
                + "asking about a pack the seller was never shown."
        )

        // The replacement pack carries a new content revision, which retires
        // the earlier handoff along with the claim, so the guide starts over.
        XCTAssertTrue(
            waitForLabel("Step 1 of 4", on: positionElement(in: app), timeout: loadedTreeTimeout)
        )
        let label = row.label
        XCTAssertFalse(
            label.localizedCaseInsensitiveContains("shared"),
            "Nothing was confirmed and the new pack retired the earlier "
                + "handoff too, so the row must not claim any share state. "
                + "Was: \"\(label)\""
        )
    }

    func testFailedDestinationOpenShowsAdviceWithoutRecordingAHandoff() {
        let app = launch(fixture: "destination-open-failure")
        let row = app.buttons["assisted-export.row.facebook"]
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        openRow(row, in: app)
        primary(app, "copy-listing-text").tap()
        primary(app, "save-8-photos").tap()

        primary(app, "open-facebook-marketplace").tap()

        XCTAssertTrue(
            marker("assisted-export.advisory", in: app)
                .waitForExistence(timeout: loadedTreeTimeout)
        )
        XCTAssertEqual(
            position(in: app),
            "Step 3 of 4",
            "A failed open attempt is not a handoff, so the guide stays on it."
        )
        XCTAssertFalse(
            app.buttons["button.primary.yes,-mark-as-shared"].exists,
            "A failed open attempt must not offer the confirm question."
        )
    }

    func testRepeatedSaveTapsWritePhotosOnce() {
        let app = launch(fixture: "save-deduplication")
        let row = app.buttons["assisted-export.row.facebook"]
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        openRow(row, in: app)
        primary(app, "copy-listing-text").tap()

        // One synthesized double tap, so both land before the fixture's slow
        // save finishes and the step moves on.
        primary(app, "save-8-photos").doubleTap()

        XCTAssertTrue(
            waitForLabel(
                "Step 3 of 4",
                on: positionElement(in: app),
                timeout: loadedTreeTimeout
            ),
            "Saving completes the step once."
        )
        // The counters live behind the sheet, which hides them from
        // accessibility while it is up.
        app.buttons["assisted-export.guide.close"].tap()
        XCTAssertTrue(
            marker("assisted-export.fixture.photo-write-count", in: app)
                .waitForExistence(timeout: loadedTreeTimeout)
        )
        XCTAssertEqual(
            marker("assisted-export.fixture.photo-write-count", in: app).label,
            "1"
        )
        XCTAssertEqual(
            marker("assisted-export.fixture.handoff-write-count", in: app).label,
            "1",
            "Copy wrote the one durable receipt; saving must not write another."
        )
    }

    func testConfirmationControlsRemainReachableAtAccessibilityFive() {
        let app = launch(
            fixture: "guide-step-4",
            extraArguments: ["--dynamic-type=accessibility5"]
        )
        let confirm = app.buttons["button.primary.yes,-mark-as-shared"]
        let cancel = app.buttons["button.secondary.not-yet"]
        XCTAssertTrue(confirm.waitForExistence(timeout: loadedTreeTimeout))
        scrollUntilHittable(confirm, in: app)
        XCTAssertTrue(confirm.isHittable)
        XCTAssertTrue(cancel.waitForExistence(timeout: loadedTreeTimeout))
        scrollUntilHittable(cancel, in: app)
        XCTAssertTrue(cancel.isHittable)
    }

    /// A swipe down is the same full cancel as `Not yet`: nothing is written and
    /// the row is still there to open again.
    func testSlidingTheSheetDownIsAFullCancel() {
        let app = launch(fixture: "guide-step-4")
        let question = app.staticTexts["assisted-export.confirm-sheet"]
        XCTAssertTrue(question.waitForExistence(timeout: loadedTreeTimeout))

        let start = question.coordinate(
            withNormalizedOffset: CGVector(dx: 0.5, dy: 0)
        )
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 1))
        start.press(forDuration: 0.05, thenDragTo: end)

        XCTAssertTrue(
            waitForDisappearance(of: question, timeout: loadedTreeTimeout),
            "A swipe-down must dismiss the sheet before any write starts."
        )
        let row = app.buttons["assisted-export.row.facebook"]
        XCTAssertTrue(row.waitForExistence(timeout: 3))
        XCTAssertFalse(
            row.label.localizedCaseInsensitiveContains("shared"),
            "Cancelling writes nothing. Was: \"\(row.label)\""
        )
    }

    func testGuideSheetCompletesToTheSellersOwnSharedClaim() {
        let app = launch(fixture: "guide-step-4")
        let yes = app.buttons["button.primary.yes,-mark-as-shared"]
        XCTAssertTrue(yes.waitForExistence(timeout: loadedTreeTimeout))
        yes.tap()

        XCTAssertTrue(
            marker("assisted-export.guide.shared", in: app)
                .waitForExistence(timeout: loadedTreeTimeout)
        )
        XCTAssertTrue(
            marker("assisted-export.guide.shared", in: app)
                .label.hasPrefix("Shared ")
        )
    }

    func testPreparedHandedOffAndSharedStatesUseOnlyHonestWording() {
        let app = launch(fixture: "honest-wording")

        let facebook = app.buttons["assisted-export.row.facebook"]
        let mercari = app.buttons["assisted-export.row.mercari"]
        let depop = app.buttons["assisted-export.row.depop"]
        XCTAssertTrue(facebook.waitForExistence(timeout: 10))
        XCTAssertTrue(mercari.exists)
        XCTAssertTrue(depop.exists)

        XCTAssertTrue(facebook.label.localizedCaseInsensitiveContains("shared"))
        XCTAssertTrue(mercari.label.localizedCaseInsensitiveContains("prepared"))
        XCTAssertTrue(depop.label.localizedCaseInsensitiveContains("not started"))

        openRow(mercari, in: app)
        XCTAssertEqual(
            position(in: app),
            "Step 1 of 4",
            "A receipt alone says some handoff happened, not which, so the "
                + "guide resumes at the first device step."
        )

        let reachable = [facebook.label, mercari.label, depop.label,
                         marker("assisted-export.guide.instruction", in: app).label]
            .joined(separator: " ")
            .lowercased()
        for forbidden in ["published", "listed", "sold", "synced", "received", "verified"] {
            XCTAssertFalse(
                reachable.contains(forbidden),
                "Assisted destinations must stay Prepared/Shared only."
            )
        }
    }

    /// #977: an untouched destination row rendered only its brand mark, which
    /// is a fixed-size image and never grows with Dynamic Type. The row now
    /// carries its one-line state at a text token, so it grows. Depop is
    /// untouched in the `prepared` fixture (no receipt).
    func testUntouchedDestinationRowGrowsWithDynamicType() {
        let mediumApp = XCUIApplication()
        mediumApp.launchArguments = [
            "--assisted-export-fixture=prepared",
            "--zero-network-fixtures",
            "--reset-onboarding-progress",
            "--dynamic-type=medium",
        ]
        mediumApp.launchAfterRetiringPriorInstance()
        let mediumRow = mediumApp.buttons["assisted-export.row.depop"]
        XCTAssertTrue(mediumRow.waitForExistence(timeout: 10))
        let mediumHeight = mediumRow.frame.height

        let a11yApp = XCUIApplication()
        a11yApp.launchArguments = [
            "--assisted-export-fixture=prepared",
            "--zero-network-fixtures",
            "--reset-onboarding-progress",
            "--dynamic-type=accessibility5",
        ]
        a11yApp.launchAfterRetiringPriorInstance()
        let a11yRow = a11yApp.buttons["assisted-export.row.depop"]
        XCTAssertTrue(a11yRow.waitForExistence(timeout: 10))

        XCTAssertGreaterThan(
            a11yRow.frame.height,
            mediumHeight,
            "The row's state line scales with Dynamic Type, so the row grows."
        )
    }

    func testListingReviewOpensThePreparedAssistedExportScreen() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--visual-state=HOME-01",
            "--zero-network-fixtures",
            "--reset-onboarding-progress",
            "--run-detail-fixture=reviewable",
            "--listing-review-fixture=loaded",
            "--reset-listing-review-draft",
        ]
        app.launchAfterRetiringPriorInstance()

        XCTAssertTrue(
            app.otherElements["trophy.wall"].waitForExistence(timeout: 10)
        )
        // #963 removed the run-status screen this used to open through; a
        // settled Trophy Wall tile now opens the same listing directly.
        let tile = app.buttons[
            "trophy.wall.tile.run.37500000-0000-4000-8000-000000000021"
        ]
        XCTAssertTrue(tile.waitForExistence(timeout: 5))
        tile.tap()

        let entry = app.buttons["listing-review.assisted-export"]
        let scrollView = app.scrollViews.firstMatch
        XCTAssertTrue(scrollView.waitForExistence(timeout: 5))
        for _ in 0..<6 where !entry.exists || !entry.isHittable {
            scrollView.swipeUp()
        }
        XCTAssertTrue(entry.exists, app.debugDescription)
        XCTAssertTrue(entry.isHittable, app.debugDescription)
        entry.tap()

        XCTAssertTrue(
            app.navigationBars["Share to other marketplaces"]
                .waitForExistence(timeout: loadedTreeTimeout)
        )
        XCTAssertTrue(
            app.buttons["assisted-export.row.facebook"]
                .waitForExistence(timeout: loadedTreeTimeout)
        )
    }

    /// Opens a destination row and does not return until its guide sheet is
    /// on screen.
    ///
    /// A tap the system accepts is not a tap the app acted on: a tap can be
    /// acknowledged and dropped, and waiting longer buys nothing. The state is
    /// re-read before every attempt and a tap is sent only while the sheet is
    /// absent, so a sheet that opens slowly is never toggled back closed. Each
    /// retry is recorded as its own activity, so a green run that needed one
    /// still says so in the log.
    private func openRow(
        _ row: XCUIElement,
        in app: XCUIApplication,
        attempts: Int = 2,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let sheet = positionElement(in: app)
        for attempt in 1...attempts {
            if sheet.exists { return }

            if attempt > 1 {
                XCTContext.runActivity(
                    named: "Re-tapping a row that ignored tap \(attempt - 1)"
                ) { _ in }
            }

            row.tap()

            if sheet.waitForExistence(timeout: loadedTreeTimeout) { return }
        }

        XCTFail(
            "The guide sheet stayed shut through \(attempts) taps, each given "
                + "\(Int(loadedTreeTimeout))s to take. Was: \"\(row.label)\"",
            file: file,
            line: line
        )
    }

    private func positionElement(in app: XCUIApplication) -> XCUIElement {
        marker("assisted-export.guide.position", in: app)
    }

    private func position(in app: XCUIApplication) -> String {
        positionElement(in: app).label
    }

    /// `SnapListPrimaryButton` derives its identifier from its own title.
    private func primary(_ app: XCUIApplication, _ slug: String) -> XCUIElement {
        let button = app.buttons["button.primary.\(slug)"]
        XCTAssertTrue(
            button.waitForExistence(timeout: loadedTreeTimeout),
            "The current step offers \(slug).\n\(app.debugDescription)"
        )
        return button
    }

    private func scrollUntilHittable(_ element: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<6 where !element.isHittable {
            app.swipeUp()
        }
    }

    private func launch(
        fixture: String,
        extraArguments: [String] = []
    ) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "--assisted-export-fixture=\(fixture)",
            "--zero-network-fixtures",
            "--reset-onboarding-progress",
        ] + extraArguments
        app.launchAfterRetiringPriorInstance()
        return app
    }

    /// Identifier lookup that does not depend on guessing the element type an
    /// accessibility container reports as.
    private func marker(
        _ identifier: String,
        in app: XCUIApplication
    ) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier)
            .firstMatch
    }

    /// `XCTNSPredicateExpectation` rather than `expectation(for:)`, because the
    /// latter registers with the test case and would have to be drained by
    /// `waitForExpectations`; an undrained one fails the test on its own.
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

    private func waitForLabel(
        _ label: String,
        on element: XCUIElement,
        timeout: TimeInterval = 5
    ) -> Bool {
        let matches = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label == %@", label),
            object: element
        )
        return XCTWaiter().wait(for: [matches], timeout: timeout) == .completed
    }
}
