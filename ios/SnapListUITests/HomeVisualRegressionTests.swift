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
        var terminationTimeout = timeout
        if process.state == .runningForeground {
            let backgroundTimeout = timeout / 2
            pressHome()
            guard process.wait(for: .runningBackground, timeout: backgroundTimeout) else {
                return false
            }
            terminationTimeout -= backgroundTimeout
        }
        process.terminate()
        return process.wait(for: .notRunning, timeout: terminationTimeout)
    }
}

final class UIProcessTerminationBoundaryTests: XCTestCase {
    func testForegroundProcessWaitsForBackgroundBeforeTerminationAndVerifiesExit() {
        let process = FakeUIProcess()
        let boundary = UIProcessTerminationBoundary {
            process.pressHome()
        }

        XCTAssertTrue(boundary.terminate(process, timeout: 4))
        XCTAssertEqual(
            process.events,
            ["press-home", "wait-running-background", "terminate", "wait-not-running"]
        )
        XCTAssertEqual(process.waitTimeouts, [2, 2])
    }

    func testForegroundProcessDoesNotTerminateWhenBackgroundTransitionTimesOut() {
        let process = FakeUIProcess(backgroundTransitionSucceeds: false)
        let boundary = UIProcessTerminationBoundary {
            process.pressHome()
        }

        XCTAssertFalse(boundary.terminate(process, timeout: 4))
        XCTAssertEqual(process.events, ["press-home", "wait-running-background"])
        XCTAssertEqual(process.waitTimeouts, [2])
        XCTAssertEqual(process.state, .runningForeground)
    }
}

private final class FakeUIProcess: UIProcessLifecycle {
    private(set) var state = XCUIApplication.State.runningForeground
    private(set) var events: [String] = []
    private(set) var waitTimeouts: [TimeInterval] = []
    private let backgroundTransitionSucceeds: Bool

    init(backgroundTransitionSucceeds: Bool = true) {
        self.backgroundTransitionSucceeds = backgroundTransitionSucceeds
    }

    func pressHome() {
        events.append("press-home")
    }

    func terminate() {
        events.append("terminate")
        state = .notRunning
    }

    func wait(for state: XCUIApplication.State, timeout: TimeInterval) -> Bool {
        waitTimeouts.append(timeout)
        if state == .runningBackground {
            events.append("wait-running-background")
            guard backgroundTransitionSucceeds else {
                return false
            }
            self.state = .runningBackground
            return true
        }

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
        let processTermination = UIProcessTerminationBoundary()

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
            XCTAssertTrue(
                processTermination.terminate(app),
                "SnapList did not terminate after \(state)"
            )
        }
    }
}
