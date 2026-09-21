import XCTest

/// #1129's device-pass evidence, driven rather than staged: the real flow,
/// photographed at each beat, plus one submission fixture to show the REV
/// and SUB fixtures now render inside the drawer rather than as roots.
final class ScanDrawerScreenshotTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
    }

    func testScanDrawerDevicePass() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--visual-state=HOME-01",
            "--zero-network-fixtures",
            "--reset-onboarding-progress"
        ]
        app.launchAfterRetiringPriorInstance()

        XCTAssertTrue(
            app.otherElements["trophy.wall"].waitForExistence(timeout: 5),
            app.debugDescription
        )
        capture("01-trophy-wall-home")

        app.buttons["dock.scan"].tap()
        let drawer = app.descendants(matching: .any)["scan.drawer"]
        XCTAssertTrue(drawer.waitForExistence(timeout: 5), app.debugDescription)
        capture("02-scan-drawer-over-wall")

        app.buttons["scan.close"].tap()
        // The wall never left, so wait out the drawer instead.
        XCTAssertTrue(drawer.waitForNonExistence(timeout: 5))
        capture("03-back-on-the-wall")
        app.terminate()

        // An intake the seller already started, so the drawer holds photos
        // and Review is live.
        let staged = XCUIApplication()
        staged.launchArguments = [
            "--restored-capture-fixture",
            "--zero-network-fixtures"
        ]
        staged.launchAfterRetiringPriorInstance()
        XCTAssertTrue(
            staged.descendants(matching: .any)["scan.drawer"]
                .waitForExistence(timeout: 5),
            staged.debugDescription
        )
        capture("04-scan-drawer-with-a-staged-photo")

        let review = staged.buttons["scan.review"]
        XCTAssertTrue(review.waitForExistence(timeout: 5), staged.debugDescription)
        XCTAssertTrue(review.isEnabled, staged.debugDescription)
        review.tap()
        XCTAssertTrue(
            staged.buttons["photo-review.start-listing"]
                .waitForExistence(timeout: 8),
            staged.debugDescription
        )
        // The point of the shot: Photo Review inside the drawer, with the
        // wall still behind it.
        XCTAssertTrue(
            staged.descendants(matching: .any)["scan.drawer"].exists,
            staged.debugDescription
        )
        capture("05-photo-review-inside-the-drawer")
        staged.terminate()

        // A submission fixture, which used to render as its own root.
        let saving = XCUIApplication()
        saving.launchArguments = [
            "--photo-review-state=REV-02",
            "--submission-visual-state=SUB-01",
            "--zero-network-fixtures"
        ]
        saving.launchAfterRetiringPriorInstance()
        XCTAssertTrue(
            saving.descendants(matching: .any)["photo-review.start-listing"]
                .waitForExistence(timeout: 5),
            saving.debugDescription
        )
        XCTAssertTrue(
            saving.descendants(matching: .any)["scan.drawer"].exists,
            saving.debugDescription
        )
        capture("06-submission-saving-inside-the-drawer")
        saving.terminate()

        // The empty wall, which is where a first-time seller starts.
        let empty = XCUIApplication()
        empty.launchArguments = [
            "--visual-state=HOME-02",
            "--zero-network-fixtures",
            "--reset-onboarding-progress"
        ]
        empty.launchAfterRetiringPriorInstance()
        XCTAssertTrue(
            empty.otherElements["trophy.wall"].waitForExistence(timeout: 5),
            empty.debugDescription
        )
        capture("07-empty-trophy-wall")
    }

    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
