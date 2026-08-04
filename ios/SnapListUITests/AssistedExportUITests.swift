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
    override func setUpWithError() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
    }

    func testAPackUpdateTakesDownAConfirmSheetTheSellerIsLookingAt() {
        let app = launch(fixture: "pack-update-while-confirming")

        let row = app.buttons["assisted-export.row.facebook"]
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()

        // Opening the row is navigation, so assert it separately from the
        // action inside it. A failure here means the row did not toggle; a
        // failure below means the workspace opened but its action is not
        // reachable. Collapsing the two would leave that ambiguous.
        let workspace = marker("assisted-export.workspace.facebook", in: app)
        XCTAssertTrue(
            workspace.waitForExistence(timeout: 5),
            "Tapping the row opens its workspace.\n\(app.debugDescription)"
        )

        // `SnapListPrimaryButton` derives its identifier from its own title, so
        // these are addressed the way the rest of the suite addresses that
        // component rather than by an outer identifier that never reaches it.
        let open = app.buttons["button.primary.open-facebook-marketplace"]
        XCTAssertTrue(
            open.waitForExistence(timeout: 5),
            "The workspace offers the open action.\n\(app.debugDescription)"
        )
        open.tap()

        let markAsShared = app.buttons["assisted-export.mark-as-shared.facebook"]
        XCTAssertTrue(
            markAsShared.waitForExistence(timeout: 5),
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
                .waitForExistence(timeout: 5),
            "The confirm sheet must actually reach the screen first."
        )

        let sheet = marker("assisted-export.confirm-sheet", in: app)
        XCTAssertTrue(
            waitForDisappearance(of: sheet),
            "A pack update must take the confirm sheet down, not leave it "
                + "standing over a pack the seller was never shown."
        )
        // No separate assertion that the confirm button is gone: a negative
        // existence check on an identifier this test never observed present
        // would also pass if the identifier were simply wrong. The sheet is the
        // button's only host, so the assertion above already covers it.

        // Assert what the row must say, not what it must avoid. `shared` is a
        // substring of `not shared`, so a negative check on it fails against
        // the correct label; and a row that had been confirmed would read
        // `shared jul 25`, which does not contain `not shared`. The positive
        // form is both accurate here and still able to fail.
        let label = row.label
        XCTAssertTrue(
            label.localizedCaseInsensitiveContains("not shared"),
            "Nothing was confirmed, so the row still reads not shared. Was: "
                + "\"\(label)\""
        )
        // The replacement pack restores the workspace only after the stale
        // confirmation sheet has been dismissed.
        XCTAssertTrue(
            marker("assisted-export.workspace.facebook", in: app)
                .waitForExistence(timeout: 5),
            "The replacement pack restores the workspace after dismissing its stale sheet."
        )
    }

    func testFailedDestinationOpenShowsAdviceWithoutRecordingAHandoff() {
        let app = launch(fixture: "destination-open-failure")
        let row = app.buttons["assisted-export.row.facebook"]
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()

        let open = app.buttons["button.primary.open-facebook-marketplace"]
        XCTAssertTrue(open.waitForExistence(timeout: 5))
        open.tap()

        XCTAssertTrue(
            marker("assisted-export.advisory", in: app)
                .waitForExistence(timeout: 5)
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
        row.tap()

        let save = app.buttons["assisted-export.save.facebook"]
        XCTAssertTrue(save.waitForExistence(timeout: 5))
        let saveCoordinate = save.coordinate(
            withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)
        )
        saveCoordinate.tap()
        saveCoordinate.tap()

        let saved = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label == %@", "Saved to Photos"),
            object: save
        )
        XCTAssertEqual(
            XCTWaiter().wait(for: [saved], timeout: 5),
            .completed
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
        row.tap()
        app.buttons["button.primary.open-facebook-marketplace"].tap()
        let mark = app.buttons["assisted-export.mark-as-shared.facebook"]
        XCTAssertTrue(mark.waitForExistence(timeout: 5))
        mark.tap()

        let confirm = app.buttons["button.primary.yes,-mark-as-shared"]
        let cancel = app.buttons["button.secondary.not-yet"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        XCTAssertTrue(confirm.isHittable)
        XCTAssertTrue(cancel.waitForExistence(timeout: 5))
        XCTAssertTrue(cancel.isHittable)
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
        XCTAssertTrue(depop.label.localizedCaseInsensitiveContains("not shared"))

        mercari.tap()
        XCTAssertTrue(
            app.buttons["assisted-export.mark-as-shared.mercari"]
                .waitForExistence(timeout: 5),
            "A durable handoff reveals the explicit seller confirmation."
        )
        XCTAssertTrue(
            marker("assisted-export.workspace.mercari", in: app)
                .label.localizedCaseInsensitiveContains(
                    "you post it in mercari"
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

        let run = app.buttons[
            "home.run.20800000-0000-4000-8000-000000000020"
        ]
        XCTAssertTrue(run.waitForExistence(timeout: 10))
        run.tap()
        let review = app.buttons["run.review.open"]
        XCTAssertTrue(review.waitForExistence(timeout: 5))
        review.tap()

        let entry = app.buttons["listing-review.assisted-export"]
        XCTAssertTrue(entry.waitForExistence(timeout: 5))
        for _ in 0..<4 where !entry.isHittable {
            app.scrollViews.firstMatch.swipeUp()
        }
        XCTAssertTrue(entry.isHittable)
        entry.tap()

        XCTAssertTrue(
            app.navigationBars["Share to other marketplaces"]
                .waitForExistence(timeout: 5)
        )
        XCTAssertTrue(
            app.buttons["assisted-export.row.facebook"]
                .waitForExistence(timeout: 5)
        )
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
}
