import XCTest

final class FidelityScreenshotTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testFoundationShellScreenshot() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--fixture=home",
            "--zero-network-fixtures",
            "--reduced-motion"
        ]
        app.launch()

        XCTAssertTrue(app.buttons["dock.home"].waitForExistence(timeout: 3))

        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "FOUNDATION-HOME.png"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
