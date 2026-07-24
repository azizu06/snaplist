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
    var monotonicUptime: TimeInterval { get }

    func terminate()
    func wait(for state: XCUIApplication.State, timeout: TimeInterval) -> Bool
    func waitUntilSafeToTerminate(timeout: TimeInterval) -> Bool
}

extension UIProcessLifecycle {
    var monotonicUptime: TimeInterval {
        ProcessInfo.processInfo.systemUptime
    }

    func waitUntilSafeToTerminate(timeout: TimeInterval) -> Bool {
        let safeStates: [XCUIApplication.State] = [
            .runningBackground,
            .runningBackgroundSuspended,
            .notRunning
        ]
        let deadline = monotonicUptime + timeout
        let probeDuration = min(0.1, timeout / 6)
        var safeStateIndex = 0

        while true {
            if state.isSafeToTerminate {
                return true
            }

            let remaining = deadline - monotonicUptime
            guard remaining > 0 else {
                return state.isSafeToTerminate
            }
            let safeState = safeStates[safeStateIndex]
            if wait(for: safeState, timeout: min(remaining, probeDuration)) {
                return true
            }
            safeStateIndex = (safeStateIndex + 1) % safeStates.count
        }
    }
}

extension XCUIApplication: UIProcessLifecycle {
    func waitUntilSafeToTerminate(timeout: TimeInterval) -> Bool {
        XCUIApplication(bundleIdentifier: "com.apple.springboard")
            .wait(for: .runningForeground, timeout: timeout)
    }
}

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
        var foregroundExitWitnessed = false
        if process.state == .runningForeground {
            pressHome()
            foregroundExitWitnessed = process.waitUntilSafeToTerminate(timeout: timeout)
        }

        switch process.state {
        case .runningBackground, .runningBackgroundSuspended:
            break
        case .runningForeground:
            guard foregroundExitWitnessed else {
                return false
            }
        case .notRunning:
            return true
        case .unknown:
            return false
        @unknown default:
            return false
        }

        process.terminate()
        return process.wait(for: .notRunning, timeout: timeout)
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
        XCTAssertEqual(process.waitTimeouts, [4, 4])
    }

    func testForegroundProcessDoesNotTerminateWhenBackgroundTransitionTimesOut() {
        let process = FakeUIProcess(backgroundTransitionSucceeds: false)
        let boundary = UIProcessTerminationBoundary {
            process.pressHome()
        }

        XCTAssertFalse(boundary.terminate(process, timeout: 4))
        XCTAssertEqual(process.events, ["press-home", "wait-safe-to-terminate"])
        XCTAssertEqual(process.waitTimeouts, [4])
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
        XCTAssertEqual(process.waitTimeouts, [4, 4])
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

    func testForegroundProcessUsesNativeWaitToObserveSuspensionBeforeTermination() {
        let process = NativeWaitObservedUIProcess()
        let boundary = UIProcessTerminationBoundary {
            process.pressHome()
        }

        XCTAssertTrue(boundary.terminate(process, timeout: 4))
        XCTAssertEqual(
            process.events,
            [
                "press-home",
                "wait-running-background",
                "wait-running-background-suspended",
                "terminate",
                "wait-not-running"
            ]
        )
        XCTAssertEqual(process.state, .notRunning)
    }

    func testPositiveForegroundExitWitnessAllowsStaleForegroundTargetTermination() {
        let process = PositiveForegroundExitWitnessUIProcess()
        let boundary = UIProcessTerminationBoundary {
            process.pressHome()
        }

        XCTAssertTrue(boundary.terminate(process, timeout: 4))
        XCTAssertEqual(
            process.events,
            [
                "press-home",
                "wait-foreground-exit-witness",
                "terminate",
                "wait-not-running"
            ]
        )
        XCTAssertEqual(process.waitTimeouts, [4, 4])
        XCTAssertEqual(process.terminateCount, 1)
        XCTAssertEqual(process.state, .notRunning)
    }

    func testLateSafeTransitionPreservesTheCompleteSeparateExitVerificationWindow() {
        let process = LateNativeWaitObservedUIProcess(
            safeStateAvailableAfter: 0.24
        )
        let boundary = UIProcessTerminationBoundary {
            process.pressHome()
        }

        XCTAssertTrue(boundary.terminate(process, timeout: 0.3))
        XCTAssertGreaterThanOrEqual(process.safeWaitElapsed, 0.24)
        XCTAssertLessThanOrEqual(process.safeWaitElapsed, 0.3)
        XCTAssertEqual(
            Array(process.events.suffix(3)),
            ["witness-suspended", "terminate", "wait-not-running-after-terminate"]
        )
        XCTAssertEqual(process.terminateCount, 1)
        XCTAssertEqual(process.exitWaitTimeouts.count, 1)
        if let exitWaitTimeout = process.exitWaitTimeouts.first {
            XCTAssertEqual(exitWaitTimeout, 0.3, accuracy: 0.001)
        } else {
            XCTFail("Exit verification did not receive its separate timeout")
        }
        XCTAssertEqual(process.state, .notRunning)
    }
}

private final class PositiveForegroundExitWitnessUIProcess: UIProcessLifecycle {
    private(set) var state = XCUIApplication.State.runningForeground
    private(set) var events: [String] = []
    private(set) var waitTimeouts: [TimeInterval] = []
    private(set) var terminateCount = 0

    func pressHome() {
        events.append("press-home")
    }

    func terminate() {
        events.append("terminate")
        terminateCount += 1
        state = .notRunning
    }

    func wait(for state: XCUIApplication.State, timeout: TimeInterval) -> Bool {
        guard state == .notRunning else {
            XCTFail("Unexpected post-termination wait target \(state)")
            return false
        }
        events.append("wait-not-running")
        waitTimeouts.append(timeout)
        return self.state == .notRunning
    }

    func waitUntilSafeToTerminate(timeout: TimeInterval) -> Bool {
        events.append("wait-foreground-exit-witness")
        waitTimeouts.append(timeout)
        return true
    }
}

private final class LateNativeWaitObservedUIProcess: UIProcessLifecycle {
    private(set) var state = XCUIApplication.State.runningForeground
    private(set) var events: [String] = []
    private(set) var monotonicUptime: TimeInterval = 0
    private(set) var terminateCount = 0
    private(set) var exitWaitTimeouts: [TimeInterval] = []
    private let safeStateAvailableAfter: TimeInterval
    private let safeObservationDeadline: TimeInterval = 0.3
    private let callOverhead: TimeInterval = 0.005

    var safeWaitElapsed: TimeInterval {
        monotonicUptime
    }

    init(safeStateAvailableAfter: TimeInterval) {
        self.safeStateAvailableAfter = safeStateAvailableAfter
    }

    func pressHome() {
        events.append("press-home")
    }

    func terminate() {
        events.append("terminate")
        terminateCount += 1
    }

    func wait(for state: XCUIApplication.State, timeout: TimeInterval) -> Bool {
        if state == .notRunning, terminateCount == 1 {
            events.append("wait-not-running-after-terminate")
            exitWaitTimeouts.append(timeout)
            self.state = .notRunning
            return true
        }

        let event: String
        switch state {
        case .runningBackground:
            event = "probe-running-background"
        case .runningBackgroundSuspended:
            event = "probe-running-background-suspended"
        case .notRunning:
            event = "probe-not-running"
        case .runningForeground, .unknown:
            XCTFail("Unexpected native wait target \(state)")
            return false
        @unknown default:
            XCTFail("Unexpected native wait target \(state)")
            return false
        }

        events.append(event)
        let waitEnd = monotonicUptime + timeout
        if state == .runningBackgroundSuspended,
           safeStateAvailableAfter <= waitEnd {
            events.append("witness-suspended")
            monotonicUptime = max(monotonicUptime, safeStateAvailableAfter)
            self.state = .runningBackgroundSuspended
            return true
        }
        monotonicUptime = min(
            waitEnd + callOverhead,
            safeObservationDeadline
        )
        return false
    }
}

private final class NativeWaitObservedUIProcess: UIProcessLifecycle {
    private(set) var state = XCUIApplication.State.runningForeground
    private(set) var events: [String] = []

    func pressHome() {
        events.append("press-home")
    }

    func terminate() {
        events.append("terminate")
        state = .notRunning
    }

    func wait(for state: XCUIApplication.State, timeout: TimeInterval) -> Bool {
        switch state {
        case .runningBackground:
            events.append("wait-running-background")
            return false
        case .runningBackgroundSuspended:
            events.append("wait-running-background-suspended")
            self.state = .runningBackgroundSuspended
            return true
        case .notRunning:
            events.append("wait-not-running")
            return self.state == .notRunning
        case .runningForeground, .unknown:
            XCTFail("Unexpected native wait target \(state)")
            return false
        @unknown default:
            XCTFail("Unexpected native wait target \(state)")
            return false
        }
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
