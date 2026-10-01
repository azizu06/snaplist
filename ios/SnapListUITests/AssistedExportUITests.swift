import XCTest

/// Issue #581, seller-visible assisted-export behavior a unit test cannot reach.
///
/// `AssistedExportDomainTests` already proves that replacing a pack clears
/// `confirmSheet`. What it cannot prove is that SwiftUI takes the answerable
/// Posted it? step down through `updatePack(to:)`; a question left standing
/// over a stale pack asks the seller to confirm a pack they were never shown.
/// The other cases prove the one-page tabs and checklist, the Listing Review
/// entry point, and the Prepared/Shared vocabulary in the rendered hierarchy.
final class AssistedExportUITests: XCTestCase {
    /// Budget for every wait that happens after the drawer has loaded. The
    /// initial tab lookups keep their own budgets: those run against a cheap
    /// tree and are not at risk.
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

    // MARK: - Tabs and checklist

    func testEveryStepIsOnOnePageAndEachTapCompletesOnlyItsOwnRow() {
        let app = launch(fixture: "prepared")
        let facebook = app.buttons["assisted-export.tab.facebook"]
        XCTAssertTrue(facebook.waitForExistence(timeout: 10))
        XCTAssertTrue(facebook.isSelected, "An untouched drawer shows the first marketplace.")

        let title = marker("assisted-export.drawer", in: app)
        let close = app.buttons["assisted-export.drawer.close"]
        XCTAssertEqual(title.frame.midX, app.frame.midX, accuracy: 1,
                       "The title stays centred between equal side slots.")
        XCTAssertEqual(title.frame.midY, close.frame.midY, accuracy: 1,
                       "The title and close control share one centre line.")
        for slug in ["mercari", "depop"] {
            XCTAssertEqual(
                facebook.frame.width,
                app.buttons["assisted-export.tab.\(slug)"].frame.width,
                accuracy: 1,
                "Marketplace tabs have equal room."
            )
        }

        let copy = step(app, "copy")
        let save = step(app, "save")
        let open = step(app, "open")
        XCTAssertEqual(copy.label, "Copy")
        XCTAssertEqual(save.label, "Save")
        XCTAssertEqual(open.label, "Open")

        copy.tap()
        XCTAssertTrue(
            waitForLabel("Copied", on: copy, timeout: loadedTreeTimeout),
            "One tap completes its own step."
        )
        XCTAssertEqual(save.label, "Save", "and no other.")
        XCTAssertEqual(facebook.label, "Facebook Marketplace, 1 of 3 done")

        save.tap()
        XCTAssertTrue(waitForLabel("Saved", on: save, timeout: loadedTreeTimeout))
        XCTAssertEqual(facebook.label, "Facebook Marketplace, 2 of 3 done")
        XCTAssertEqual(open.label, "Open")
    }

    func testSwitchingTabsShowsThatMarketplacesOwnSteps() {
        let app = launch(fixture: "prepared")
        let facebook = app.buttons["assisted-export.tab.facebook"]
        let depop = app.buttons["assisted-export.tab.depop"]
        XCTAssertTrue(facebook.waitForExistence(timeout: 10))
        step(app, "copy").tap()
        XCTAssertTrue(
            waitForLabel("Copied", on: step(app, "copy"), timeout: loadedTreeTimeout)
        )

        depop.tap()
        XCTAssertTrue(waitForSelection(of: depop, timeout: loadedTreeTimeout))
        XCTAssertEqual(
            step(app, "copy").label,
            "Copy",
            "Facebook's progress is not Depop's."
        )
        XCTAssertTrue(
            marker("assisted-export.step.open", in: app).exists
        )

        facebook.tap()
        XCTAssertTrue(waitForSelection(of: facebook, timeout: loadedTreeTimeout))
        XCTAssertEqual(step(app, "copy").label, "Copied")
    }

    func testClosingAndReopeningKeepsTheStepsTheSellerDid() {
        let app = launch(fixture: "prepared")
        XCTAssertTrue(app.buttons["assisted-export.tab.facebook"].waitForExistence(timeout: 10))
        step(app, "copy").tap()
        XCTAssertTrue(
            waitForLabel("Copied", on: step(app, "copy"), timeout: loadedTreeTimeout)
        )

        app.buttons["assisted-export.drawer.close"].tap()
        let reopen = app.buttons["assisted-export.fixture.open"]
        XCTAssertTrue(reopen.waitForExistence(timeout: loadedTreeTimeout))
        reopen.tap()

        XCTAssertTrue(
            waitForLabel("Copied", on: step(app, "copy"), timeout: loadedTreeTimeout),
            "Closing the drawer is navigation; it forgets nothing."
        )
    }

    func testAPackUpdateTakesDownAConfirmQuestionTheSellerIsLookingAt() {
        let app = launch(fixture: "pack-update-while-confirming")
        let facebook = app.buttons["assisted-export.tab.facebook"]
        XCTAssertTrue(facebook.waitForExistence(timeout: 10))

        step(app, "copy").tap()

        // Posted it? becomes answerable after the first handoff, and the
        // fixture replaces the pack the moment it does. The question is gone in
        // the same breath it appears, so the fixture records the presentation
        // durably instead, which is what makes the dismissal assertion below
        // mean something.
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
        // the earlier handoff along with the claim, so the steps start over.
        XCTAssertTrue(
            waitForLabel("Copy", on: step(app, "copy"), timeout: loadedTreeTimeout)
        )
        XCTAssertFalse(
            facebook.label.localizedCaseInsensitiveContains("shared"),
            "Nothing was confirmed and the new pack retired the earlier "
                + "handoff too, so the tab must not claim any share state. "
                + "Was: \"\(facebook.label)\""
        )
    }

    func testFailedDestinationOpenShowsAdviceWithoutCompletingTheStep() {
        let app = launch(fixture: "destination-open-failure")
        XCTAssertTrue(app.buttons["assisted-export.tab.facebook"].waitForExistence(timeout: 10))

        step(app, "open").tap()

        XCTAssertTrue(
            marker("assisted-export.advisory", in: app)
                .waitForExistence(timeout: loadedTreeTimeout)
        )
        XCTAssertEqual(
            step(app, "open").label,
            "Open",
            "A failed open attempt is not a handoff, so its step stays open."
        )
        XCTAssertFalse(
            app.buttons["assisted-export.step.mark-shared"].isEnabled,
            "A failed open attempt must not make Posted it? answerable."
        )
    }

    func testRepeatedSaveTapsWritePhotosOnce() {
        let app = launch(fixture: "save-deduplication")
        XCTAssertTrue(app.buttons["assisted-export.tab.facebook"].waitForExistence(timeout: 10))
        step(app, "copy").tap()
        XCTAssertTrue(
            waitForLabel("Copied", on: step(app, "copy"), timeout: loadedTreeTimeout)
        )

        // One synthesized double tap, so both land before the fixture's slow
        // save finishes.
        step(app, "save").doubleTap()

        XCTAssertTrue(
            waitForLabel("Saved", on: step(app, "save"), timeout: loadedTreeTimeout),
            "Saving completes the step once."
        )
        // These counters belong to the fixture's outer drawer. There is no
        // nested guide sheet to dismiss in the one-page design.
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

    func testMarkSharedRemainsReachableAtAccessibilityFive() {
        let app = launch(
            fixture: "guide-step-4",
            extraArguments: ["--dynamic-type=accessibility5"]
        )
        let markShared = app.buttons["assisted-export.step.mark-shared"]
        XCTAssertTrue(markShared.waitForExistence(timeout: loadedTreeTimeout))
        scrollUntilHittable(markShared, in: app)
        XCTAssertTrue(markShared.isHittable)
    }

    /// A swipe down is a full cancel: nothing is written and the marketplace
    /// is still there to share to.
    func testSlidingTheDrawerDownIsAFullCancel() {
        let app = launch(fixture: "guide-step-4")
        let question = marker("assisted-export.confirm-sheet", in: app)
        XCTAssertTrue(question.waitForExistence(timeout: loadedTreeTimeout))

        // Drag the drawer's fixed header, rather than its scrollable content.
        let start = marker("assisted-export.drawer", in: app).coordinate(
            withNormalizedOffset: CGVector(dx: 0.5, dy: 0)
        )
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 1))
        start.press(forDuration: 0.05, thenDragTo: end)

        XCTAssertTrue(
            waitForDisappearance(of: question, timeout: loadedTreeTimeout),
            "A swipe-down must dismiss the drawer before any write starts."
        )
        app.buttons["assisted-export.fixture.open"].tap()
        let facebook = app.buttons["assisted-export.tab.facebook"]
        XCTAssertTrue(facebook.waitForExistence(timeout: 3))
        XCTAssertFalse(
            facebook.label.localizedCaseInsensitiveContains("shared"),
            "Cancelling writes nothing. Was: \"\(facebook.label)\""
        )
    }

    func testMarkSharedRecordsTheSellersOwnClaimWithUndo() {
        let app = launch(fixture: "guide-step-4")
        let markShared = app.buttons["assisted-export.step.mark-shared"]
        XCTAssertTrue(markShared.waitForExistence(timeout: loadedTreeTimeout))
        markShared.tap()

        let shared = marker("assisted-export.shared", in: app)
        XCTAssertTrue(shared.waitForExistence(timeout: loadedTreeTimeout))
        XCTAssertTrue(shared.label.hasPrefix("Shared "), "Was: \"\(shared.label)\"")
        XCTAssertTrue(app.buttons["assisted-export.undo"].exists)
    }

    func testPreparedHandedOffAndSharedStatesUseOnlyHonestWording() {
        let app = launch(fixture: "honest-wording")

        let facebook = app.buttons["assisted-export.tab.facebook"]
        let mercari = app.buttons["assisted-export.tab.mercari"]
        let depop = app.buttons["assisted-export.tab.depop"]
        XCTAssertTrue(facebook.waitForExistence(timeout: 10))
        XCTAssertTrue(mercari.exists)
        XCTAssertTrue(depop.exists)

        XCTAssertTrue(facebook.label.localizedCaseInsensitiveContains("shared"))
        XCTAssertTrue(mercari.label.localizedCaseInsensitiveContains("prepared"))
        XCTAssertTrue(depop.label.localizedCaseInsensitiveContains("not started"))

        mercari.tap()
        XCTAssertTrue(waitForSelection(of: mercari, timeout: loadedTreeTimeout))
        XCTAssertEqual(
            step(app, "copy").label,
            "Copy",
            "A receipt alone says some handoff happened, not which, so no "
                + "step reads done."
        )

        let reachable = app.staticTexts.allElementsBoundByIndex.map(\.label)
            + [facebook.label, mercari.label, depop.label]
        let words = reachable.joined(separator: " ").lowercased()
        for forbidden in ["published", "listed", "sold", "synced", "received", "verified"] {
            XCTAssertFalse(
                words.contains(forbidden),
                "Assisted destinations must stay Prepared/Shared only."
            )
        }
    }

    /// #977: a brand mark is a fixed-size image and never grows with Dynamic
    /// Type. The tab carries its one-line state at a text token, so it grows.
    /// Depop is untouched in the `prepared` fixture (no receipt).
    func testUntouchedMarketplaceTabGrowsWithDynamicType() {
        let mediumApp = XCUIApplication()
        mediumApp.launchArguments = [
            "--assisted-export-fixture=prepared",
            "--zero-network-fixtures",
            "--reset-onboarding-progress",
            "--dynamic-type=medium",
        ]
        mediumApp.launchAfterRetiringPriorInstance()
        let mediumTab = mediumApp.buttons["assisted-export.tab.depop"]
        XCTAssertTrue(mediumTab.waitForExistence(timeout: 10))
        let mediumHeight = mediumTab.frame.height

        let a11yApp = XCUIApplication()
        a11yApp.launchArguments = [
            "--assisted-export-fixture=prepared",
            "--zero-network-fixtures",
            "--reset-onboarding-progress",
            "--dynamic-type=accessibility5",
        ]
        a11yApp.launchAfterRetiringPriorInstance()
        let a11yTab = a11yApp.buttons["assisted-export.tab.depop"]
        XCTAssertTrue(a11yTab.waitForExistence(timeout: 10))

        XCTAssertGreaterThan(
            a11yTab.frame.height,
            mediumHeight,
            "The tab's state line scales with Dynamic Type, so the tab grows."
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
            marker("assisted-export.drawer", in: app)
                .waitForExistence(timeout: loadedTreeTimeout),
            app.debugDescription
        )
        XCTAssertTrue(
            app.buttons["assisted-export.tab.facebook"]
                .waitForExistence(timeout: loadedTreeTimeout)
        )
        XCTAssertFalse(app.navigationBars["Share to other marketplaces"].exists)
        app.buttons["assisted-export.drawer.close"].tap()
        XCTAssertTrue(entry.waitForExistence(timeout: loadedTreeTimeout))
    }

    /// One checklist step's button, addressed by the step it performs.
    private func step(_ app: XCUIApplication, _ slug: String) -> XCUIElement {
        let button = app.buttons["assisted-export.step.\(slug)"]
        XCTAssertTrue(
            button.waitForExistence(timeout: loadedTreeTimeout),
            "The checklist offers \(slug).\n\(app.debugDescription)"
        )
        return button
    }

    private func waitForSelection(
        of element: XCUIElement,
        timeout: TimeInterval
    ) -> Bool {
        let selected = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "isSelected == true"),
            object: element
        )
        return XCTWaiter().wait(for: [selected], timeout: timeout) == .completed
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
