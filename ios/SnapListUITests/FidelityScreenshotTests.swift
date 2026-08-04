import XCTest

final class FidelityScreenshotTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
    }

    func testFoundationShellScreenshot() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--fixture=scan",
            "--zero-network-fixtures",
            "--reduced-motion"
        ]
        app.launchAfterRetiringPriorInstance()
        XCUIDevice.shared.orientation = .portrait

        XCTAssertTrue(app.buttons["dock.scan"].waitForExistence(timeout: 3))

        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "FOUNDATION-HOME.png"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
