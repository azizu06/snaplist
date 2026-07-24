import XCTest

private extension XCUIApplication.State {
    var isSafeToTerminate: Bool {
        switch self {
        case .runningBackground, .runningBackgroundSuspended, .notRunning:
            return true
        case .runningForeground, .unknown:
            return false
        @unknown default:
            return false
        }
    }
}

protocol UIProcessLifecycle: AnyObject {
    var state: XCUIApplication.State { get }

    func terminate()
    func wait(for state: XCUIApplication.State, timeout: TimeInterval) -> Bool
    func waitUntilSafeToTerminate(timeout: TimeInterval) -> Bool
}

extension UIProcessLifecycle {
    func waitUntilSafeToTerminate(timeout: TimeInterval) -> Bool {
        let safeState = NSPredicate { _, _ in
            self.state.isSafeToTerminate
        }
        return XCTWaiter.wait(
            for: [XCTNSPredicateExpectation(predicate: safeState, object: nil)],
            timeout: timeout
        ) == .completed
    }
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
            guard process.waitUntilSafeToTerminate(timeout: backgroundTimeout) else {
                return false
            }
            terminationTimeout -= backgroundTimeout
        }
        guard process.state.isSafeToTerminate else {
            return false
        }
        guard process.state != .notRunning else {
            return true
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
            ["press-home", "wait-safe-to-terminate", "terminate", "wait-not-running"]
        )
        XCTAssertEqual(process.waitTimeouts, [2, 2])
    }

    func testForegroundProcessDoesNotTerminateWhenBackgroundTransitionTimesOut() {
        let process = FakeUIProcess(backgroundTransitionSucceeds: false)
        let boundary = UIProcessTerminationBoundary {
            process.pressHome()
        }

        XCTAssertFalse(boundary.terminate(process, timeout: 4))
        XCTAssertEqual(process.events, ["press-home", "wait-safe-to-terminate"])
        XCTAssertEqual(process.waitTimeouts, [2])
        XCTAssertEqual(process.state, .runningForeground)
    }

    func testForegroundProcessThatSuspendsAfterHomeStillTerminatesAndVerifiesExit() {
        let process = FakeUIProcess(stateAfterPressHome: .runningBackgroundSuspended)
        let boundary = UIProcessTerminationBoundary {
            process.pressHome()
        }

        XCTAssertTrue(boundary.terminate(process, timeout: 4))
        XCTAssertEqual(
            process.events,
            ["press-home", "wait-safe-to-terminate", "terminate", "wait-not-running"]
        )
        XCTAssertEqual(process.waitTimeouts, [2, 2])
    }

    func testAlreadyStoppedProcessSucceedsWithoutAnotherTerminateRequest() {
        let process = FakeUIProcess(initialState: .notRunning)
        let boundary = UIProcessTerminationBoundary()

        XCTAssertTrue(boundary.terminate(process, timeout: 4))
        XCTAssertEqual(process.events, [])
        XCTAssertEqual(process.waitTimeouts, [])
    }

    func testUnknownProcessStateFailsClosedWithoutTerminateRequest() {
        let process = FakeUIProcess(initialState: .unknown)
        let boundary = UIProcessTerminationBoundary()

        XCTAssertFalse(boundary.terminate(process, timeout: 4))
        XCTAssertEqual(process.events, [])
        XCTAssertEqual(process.waitTimeouts, [])
    }
}

private final class FakeUIProcess: UIProcessLifecycle {
    private(set) var state: XCUIApplication.State
    private(set) var events: [String] = []
    private(set) var waitTimeouts: [TimeInterval] = []
    private let backgroundTransitionSucceeds: Bool
    private let stateAfterPressHome: XCUIApplication.State?

    init(
        initialState: XCUIApplication.State = .runningForeground,
        backgroundTransitionSucceeds: Bool = true,
        stateAfterPressHome: XCUIApplication.State? = nil
    ) {
        state = initialState
        self.backgroundTransitionSucceeds = backgroundTransitionSucceeds
        self.stateAfterPressHome = stateAfterPressHome
    }

    func pressHome() {
        events.append("press-home")
        if let stateAfterPressHome {
            state = stateAfterPressHome
        }
    }

    func terminate() {
        events.append("terminate")
        state = .notRunning
    }

    func wait(for state: XCUIApplication.State, timeout: TimeInterval) -> Bool {
        waitTimeouts.append(timeout)
        if state == .runningBackground {
            events.append("wait-running-background")
            guard self.state == .runningForeground else {
                return self.state == state
            }
            guard backgroundTransitionSucceeds else {
                return false
            }
            self.state = .runningBackground
            return true
        }

        events.append("wait-not-running")
        return self.state == state
    }

    func waitUntilSafeToTerminate(timeout: TimeInterval) -> Bool {
        events.append("wait-safe-to-terminate")
        waitTimeouts.append(timeout)
        switch state {
        case .runningBackground, .runningBackgroundSuspended, .notRunning:
            return true
        case .runningForeground:
            guard backgroundTransitionSucceeds else {
                return false
            }
            state = .runningBackground
            return true
        case .unknown:
            return false
        @unknown default:
            return false
        }
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
