import XCTest

protocol UIProcessLifecycle: AnyObject {
    var state: XCUIApplication.State { get }

    func terminate()
    func wait(for state: XCUIApplication.State, timeout: TimeInterval) -> Bool
}

extension XCUIApplication: UIProcessLifecycle {}

struct UIProcessTerminationBoundary {
    private let pressHome: () -> Void

    init(pressHome: @escaping () -> Void = {
        XCUIDevice.shared.press(.home)
    }) {
        self.pressHome = pressHome
    }

    func terminate(
        _ process: any UIProcessLifecycle,
        timeout: TimeInterval = 3
    ) -> Bool {
        process.terminate()
        return process.wait(for: .notRunning, timeout: timeout)
    }
}

final class UIProcessTerminationBoundaryTests: XCTestCase {
    func testForegroundProcessLeavesForegroundBeforeTerminationAndVerifiesExit() {
        let process = FakeUIProcess()
        let boundary = UIProcessTerminationBoundary {
            process.pressHome()
        }

        XCTAssertTrue(boundary.terminate(process))
        XCTAssertEqual(
            process.events,
            ["press-home", "terminate", "wait-not-running"]
        )
    }
}

private final class FakeUIProcess: UIProcessLifecycle {
    private(set) var state = XCUIApplication.State.runningForeground
    private(set) var events: [String] = []

    func pressHome() {
        events.append("press-home")
        state = .runningBackground
    }

    func terminate() {
        events.append("terminate")
        state = .notRunning
    }

    func wait(for state: XCUIApplication.State, timeout: TimeInterval) -> Bool {
        events.append("wait-not-running")
        return self.state == state
    }
}

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
