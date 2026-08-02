import XCTest

/// Issue #581, the one assisted-export behavior a unit test cannot reach.
///
/// `AssistedExportDomainTests` already proves that a listing revision change
/// clears `confirmSheet`. What it cannot prove is that SwiftUI takes the
/// presented sheet down in response, and a sheet left standing over a stale
/// pack asks the seller to confirm a pack they were never shown. That is the
/// gap this test closes, so it is the only test here.
final class AssistedExportUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
    }

    func testAListingChangeTakesDownAConfirmSheetTheSellerIsLookingAt() {
        let app = launch(fixture: "revision-change-while-confirming")

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
            "A listing change must take the confirm sheet down, not leave it "
                + "standing over a pack the seller was never shown."
        )
        // No separate assertion that the confirm button is gone: a negative
        // existence check on an identifier this test never observed present
        // would also pass if the identifier were simply wrong. The sheet is the
        // button's only host, so the assertion above already covers it.

        XCTAssertTrue(
            marker("assisted-export.pack-out-of-date", in: app)
                .waitForExistence(timeout: 5),
            "The screen says the pack is out of date rather than going quiet."
        )
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
        // The workspace came down with the stale pack, so the row must not go
        // on announcing an expanded panel that is not on screen.
        XCTAssertTrue(
            label.localizedCaseInsensitiveContains("closed"),
            "The row announces what is actually on screen. Was: \"\(label)\""
        )
    }

    private func launch(fixture: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "--assisted-export-fixture=\(fixture)",
            "--zero-network-fixtures",
            "--reset-onboarding-progress",
        ]
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
