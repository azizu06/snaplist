import XCTest

final class HomeVisualRegressionTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
    }

    func testAllFourApprovedHomeStatesRenderAtCanonicalViewport() {
        let requiresCanonicalViewport = ProcessInfo.processInfo.environment[
            "SNAPLIST_REQUIRE_CANONICAL_VIEWPORT"
        ] == "1"

        for state in ["HOME-01", "HOME-02", "HOME-03", "HOME-04"] {
            let app = XCUIApplication()
            app.launchArguments = [
                "--visual-state=\(state)",
                "--zero-network-fixtures",
                "--reset-onboarding-progress",
                "--reduced-motion"
            ]
            app.launch()

            XCTAssertTrue(
                app.descendants(matching: .any)[state == "HOME-04" ? "home.search.field" : state == "HOME-02" ? "home.empty" : "home.active"]
                    .waitForExistence(timeout: 3),
                "Missing native Home boundary for \(state)"
            )
            if requiresCanonicalViewport {
                XCTAssertEqual(app.windows.firstMatch.frame.size.width, 393)
                XCTAssertEqual(app.windows.firstMatch.frame.size.height, 852)
            }

            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = "\(state).png"
            attachment.lifetime = .keepAlways
            add(attachment)
            app.terminate()
        }
    }
}
