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

    func testAPackUpdateTakesDownAConfirmSheetTheSellerIsLookingAt() {
        let app = launch(fixture: "pack-update-while-confirming")

        let row = app.buttons["assisted-export.row.facebook"]
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        openRow(row)

        // Opening the row is navigation, so assert it separately from the
        // action inside it. A failure here means the row did not toggle; a
        // failure below means the workspace opened but its action is not
        // reachable. Collapsing the two would leave that ambiguous.
        let workspace = marker("assisted-export.workspace.facebook", in: app)
        XCTAssertTrue(
            workspace.waitForExistence(timeout: loadedTreeTimeout),
            "Tapping the row opens its workspace.\n\(app.debugDescription)"
        )

        // `SnapListPrimaryButton` derives its identifier from its own title, so
        // these are addressed the way the rest of the suite addresses that
        // component rather than by an outer identifier that never reaches it.
        let open = app.buttons["button.primary.open-facebook-marketplace"]
        XCTAssertTrue(
            open.waitForExistence(timeout: loadedTreeTimeout),
            "The workspace offers the open action.\n\(app.debugDescription)"
        )
        open.tap()

        let markAsShared = app.buttons["assisted-export.mark-as-shared.facebook"]
        XCTAssertTrue(
            markAsShared.waitForExistence(timeout: loadedTreeTimeout),
            "Mark as shared follows a recorded handoff.\n\(app.debugDescription)"
        )
        markAsShared.tap()

        // The sheet is dismissed in the same breath it appears, so polling for
        // it would be a race. The fixture records the presentation durably
        // instead, which is what makes the dismissal assertion below mean
        // something: without this, a screen that never presented a sheet at all
        // would pass every remaining assertion.
        XCTAssertTrue(
            marker("assisted-export.fixture.sheet-was-presented", in: app)
                .waitForExistence(timeout: loadedTreeTimeout),
            "The confirm sheet must actually reach the screen first."
        )

        let sheet = marker("assisted-export.confirm-sheet", in: app)
        XCTAssertTrue(
            waitForDisappearance(of: sheet, timeout: loadedTreeTimeout),
            "A pack update must take the confirm sheet down, not leave it "
                + "standing over a pack the seller was never shown."
        )
        // No separate assertion that the confirm button is gone: a negative
        // existence check on an identifier this test never observed present
        // would also pass if the identifier were simply wrong. The sheet is the
        // button's only host, so the assertion above already covers it.

        // The replacement pack carries a new content revision, which retires
        // the earlier handoff along with the claim (the same rule proven in
        // `testANewPackTextRetiresTheSharedClaimThatBelongedToTheOldOne`), so
        // the row goes back to saying nothing rather than "not shared".
        let label = row.label
        XCTAssertFalse(
            label.localizedCaseInsensitiveContains("shared"),
            "Nothing was confirmed and the new pack retired the earlier "
                + "handoff too, so the row must not claim any share state. "
                + "Was: \"\(label)\""
        )
        // The replacement pack restores the workspace only after the stale
        // confirmation sheet has been dismissed.
        XCTAssertTrue(
            marker("assisted-export.workspace.facebook", in: app)
                .waitForExistence(timeout: loadedTreeTimeout),
            "The replacement pack restores the workspace after dismissing its stale sheet."
        )
    }

    func testFailedDestinationOpenShowsAdviceWithoutRecordingAHandoff() {
        let app = launch(fixture: "destination-open-failure")
        let row = app.buttons["assisted-export.row.facebook"]
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        openRow(row)

        let open = app.buttons["button.primary.open-facebook-marketplace"]
        XCTAssertTrue(open.waitForExistence(timeout: loadedTreeTimeout))
        open.tap()

        XCTAssertTrue(
            marker("assisted-export.advisory", in: app)
                .waitForExistence(timeout: loadedTreeTimeout)
        )
        XCTAssertFalse(
            app.buttons["assisted-export.mark-as-shared.facebook"].exists,
            "A failed open attempt is not a handoff receipt."
        )
    }

    func testRepeatedSaveTapsWritePhotosAndReceiptOnce() {
        let app = launch(fixture: "save-deduplication")
        let row = app.buttons["assisted-export.row.facebook"]
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        openRow(row)

        let save = app.buttons["assisted-export.save.facebook"]
        XCTAssertTrue(save.waitForExistence(timeout: loadedTreeTimeout))
        let saveCoordinate = save.coordinate(
            withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)
        )
        saveCoordinate.tap()
        saveCoordinate.tap()

        XCTAssertTrue(
            waitForLabel(
                "1",
                on: marker(
                    "assisted-export.fixture.handoff-write-count",
                    in: app
                ),
                timeout: loadedTreeTimeout
            ),
            "Saving is complete only after exactly one durable handoff receipt."
        )
        XCTAssertEqual(
            marker("assisted-export.fixture.photo-write-count", in: app).label,
            "1"
        )
        XCTAssertEqual(
            marker("assisted-export.fixture.handoff-write-count", in: app).label,
            "1"
        )
    }

    func testConfirmationControlsRemainReachableAtAccessibilityFive() {
        let app = launch(
            fixture: "prepared",
            extraArguments: ["--dynamic-type=accessibility5"]
        )
        let row = app.buttons["assisted-export.row.facebook"]
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        openRow(row)
        app.buttons["button.primary.open-facebook-marketplace"].tap()
        let mark = app.buttons["assisted-export.mark-as-shared.facebook"]
        XCTAssertTrue(mark.waitForExistence(timeout: loadedTreeTimeout))
        mark.tap()

        let confirm = app.buttons["button.primary.yes,-mark-as-shared"]
        let cancel = app.buttons["button.secondary.not-yet"]
        XCTAssertTrue(confirm.waitForExistence(timeout: loadedTreeTimeout))
        XCTAssertTrue(confirm.isHittable)
        XCTAssertTrue(cancel.waitForExistence(timeout: loadedTreeTimeout))
        XCTAssertTrue(cancel.isHittable)
    }

    /// #961: `confirmSheetBinding`'s own setter comment says a swipe-down is
    /// meant to be the same full cancel as "Not yet" — this is the UI proof
    /// of that claim. `interactiveDismissDisabled(store.isWriting)` only
    /// blocks the swipe while the durable "Shared" write is actually in
    /// flight (see the guard comment on `dismissConfirmSheet()`), and no
    /// write has started yet at this point, so the swipe must go through.
    func testConfirmSheetSlidesDownToDismissAsAFullCancel() {
        let app = launch(fixture: "prepared")
        let row = app.buttons["assisted-export.row.facebook"]
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        openRow(row)
        app.buttons["button.primary.open-facebook-marketplace"].tap()
        let mark = app.buttons["assisted-export.mark-as-shared.facebook"]
        XCTAssertTrue(mark.waitForExistence(timeout: loadedTreeTimeout))
        mark.tap()

        let question = app.staticTexts["assisted-export.confirm-sheet"]
        XCTAssertTrue(question.waitForExistence(timeout: loadedTreeTimeout))

        let start = question.coordinate(
            withNormalizedOffset: CGVector(dx: 0.5, dy: 0)
        )
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 1))
        start.press(forDuration: 0.05, thenDragTo: end)

        XCTAssertFalse(
            question.waitForExistence(timeout: 3),
            "A swipe-down must dismiss the confirm sheet before any write "
                + "starts."
        )
        XCTAssertTrue(
            mark.waitForExistence(timeout: 3),
            "A cancelled confirm sheet must leave Mark as shared tappable "
                + "again, the same as 'Not yet' would."
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
        XCTAssertFalse(
            facebook.label.localizedCaseInsensitiveContains("not shared")
        )
        XCTAssertTrue(mercari.label.localizedCaseInsensitiveContains("not shared"))
        // Depop has no receipt at all in this fixture: nobody has handed it
        // off, so the row says nothing about sharing yet, not "not shared".
        XCTAssertFalse(depop.label.localizedCaseInsensitiveContains("not shared"))

        openRow(mercari)
        XCTAssertTrue(
            app.buttons["assisted-export.mark-as-shared.mercari"]
                .waitForExistence(timeout: loadedTreeTimeout),
            "A durable handoff reveals the explicit seller confirmation."
        )
        XCTAssertTrue(
            marker("assisted-export.workspace.mercari", in: app)
                .label.localizedCaseInsensitiveContains(
                    "you finish this in mercari"
                )
        )

        let reachable = [facebook.label, mercari.label, depop.label,
                         marker("assisted-export.workspace.mercari", in: app).label]
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
    /// is a fixed-size image and never grows with Dynamic Type — the row
    /// carried no text at any size. `destinationRow` now pairs the mark with
    /// `destination.displayName` at the `.rowTitle` token, so a row that has
    /// nothing else to say still has a real, scaling text identity. Depop is
    /// untouched in the `prepared` fixture (no receipt), so its row's only
    /// content is the mark plus that name — the exact case the issue named.
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
            "An untouched row's only content used to be a fixed-size mark, so "
                + "the row never grew with Dynamic Type. It must grow now that "
                + "the row carries the destination's own scaling text name."
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
        // The seller-Home run row that used to open this screen was retired with
        // the rest of that surface, so Run Detail is entered through its route.
        app.open(URL(string: "snaplist://runs/20800000-0000-4000-8000-000000000020")!)
        let review = app.buttons["run.review.open"]
        XCTAssertTrue(review.waitForExistence(timeout: 5))
        review.tap()

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

    /// Opens a destination row and does not return until the row itself says
    /// it is open.
    ///
    /// A tap the system accepts is not a tap the app acted on. In job
    /// 95336686008 of run 32012821535 (`ui-1`, head `7408e4c26`) the activity
    /// log for this screen reads `Tap` at t=8.61s, `Synthesize event` at
    /// 8.68s, and `Wait for dev.snaplist.ios to idle` satisfied by 8.98s —
    /// then thirty one-second existence checks, each answered in about 0.1s,
    /// against a row whose own dump still read
    /// `label: 'Facebook Marketplace, closed'`. The app was answering queries
    /// the whole time, so the event was acknowledged and dropped rather than
    /// delayed. Waiting longer on that tap buys nothing. Only another tap can
    /// recover it, which is why the budget above stays where it is.
    ///
    /// The state is re-read before every attempt and a tap is sent only while
    /// the row is still shut, so a row that opens slowly is never toggled back
    /// closed. Each retry is recorded as its own activity, so a green run that
    /// needed one still says so in the log instead of looking clean.
    private func openRow(
        _ row: XCUIElement,
        attempts: Int = 2,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        for attempt in 1...attempts {
            if isDisclosed("open", row) { return }

            if attempt > 1 {
                XCTContext.runActivity(
                    named: "Re-tapping a row that ignored tap \(attempt - 1)"
                ) { _ in }
            }

            row.tap()

            if waitForDisclosedState("open", on: row, timeout: loadedTreeTimeout) {
                return
            }
        }

        XCTFail(
            "The row stayed shut through \(attempts) taps, each given "
                + "\(Int(loadedTreeTimeout))s to take. A row that ignores every "
                + "tap is refusing them, not dropping one. Was: \"\(row.label)\"",
            file: file,
            line: line
        )
    }

    /// The disclosure word is the last comma-separated component of the row's
    /// label; `AssistedExportDomain.accessibilityLabel(for:)` appends it after
    /// the optional status. Matching the suffix therefore cannot be satisfied
    /// by a status that happens to contain the word.
    private func isDisclosed(_ state: String, _ row: XCUIElement) -> Bool {
        row.label.hasSuffix(", \(state)")
    }

    private func waitForDisclosedState(
        _ state: String,
        on row: XCUIElement,
        timeout: TimeInterval
    ) -> Bool {
        let disclosed = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label ENDSWITH %@", ", \(state)"),
            object: row
        )
        return XCTWaiter().wait(for: [disclosed], timeout: timeout) == .completed
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
