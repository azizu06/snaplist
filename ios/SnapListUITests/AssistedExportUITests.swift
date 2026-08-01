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

        let open = app.buttons["assisted-export.open.facebook"]
        XCTAssertTrue(open.waitForExistence(timeout: 5))
        open.tap()

        let markAsShared = app.buttons["assisted-export.mark-as-shared.facebook"]
        XCTAssertTrue(
            markAsShared.waitForExistence(timeout: 5),
            "Mark as shared follows a recorded handoff."
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
        XCTAssertFalse(
            app.buttons["assisted-export.confirm-shared"].exists,
            "The only control that writes Shared must be gone with it."
        )

        XCTAssertTrue(
            marker("assisted-export.pack-out-of-date", in: app)
                .waitForExistence(timeout: 5),
            "The screen says the pack is out of date rather than going quiet."
        )
        XCTAssertFalse(
            row.label.localizedCaseInsensitiveContains("shared"),
            "Nothing was confirmed, so nothing reports Shared."
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
