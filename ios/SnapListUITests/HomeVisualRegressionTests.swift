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
        let deadline = monotonicUptime + timeout
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        guard springboard.wait(for: .runningForeground, timeout: timeout) else {
            return false
        }

        let safeStates: [XCUIApplication.State] = [
            .runningBackground,
            .runningBackgroundSuspended,
            .notRunning
        ]
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
        if process.state == .runningForeground {
            pressHome()
            guard process.waitUntilSafeToTerminate(timeout: timeout) else {
                return false
            }
        }

        guard process.state.isSafeToTerminate else {
            return false
        }
        guard process.state != .notRunning else {
            return true
        }

        process.terminate()
        return process.wait(for: .notRunning, timeout: timeout)
    }
}

/// Retires a live target process *before* a launch is issued.
///
/// `XCUIApplication.launch()` on a still-running instance performs an implicit
/// `Terminate <pid>` inside the launch operation itself, and that implicit
/// termination never observes `.notRunning`. When CoreSimulator is slow to reap
/// the old process the whole launch stalls inside XCTest's launch budget and
/// reports `does not have a process ID` — or acquires a pid whose background
/// assertion then times out. Running the termination here, through a boundary
/// that explicitly waits for `.notRunning`, moves that work out of the launch
/// budget and into a step with its own bounded wait.
///
/// Retirement failure never skips the launch: an unverifiable prior state is
/// reported to the caller, not converted into a silently absent test.
struct UILaunchBoundary {
    private let terminationBoundary: UIProcessTerminationBoundary

    init(
        terminationBoundary: UIProcessTerminationBoundary = UIProcessTerminationBoundary()
    ) {
        self.terminationBoundary = terminationBoundary
    }

    @discardableResult
    func launch(
        _ process: any UIProcessLifecycle,
        timeout: TimeInterval = 3,
        issueLaunch: () -> Void
    ) -> Bool {
        let retired = terminationBoundary.terminate(process, timeout: timeout)
        issueLaunch()
        return retired
    }
}

extension XCUIApplication {
    /// Launches after any live prior instance has been retired and observed
    /// `.notRunning`, so XCTest never has to terminate it implicitly inside the
    /// launch budget. See `UILaunchBoundary`.
    ///
    /// A retirement that cannot be verified is not fatal: the launch is still
    /// issued, leaving behaviour no worse than an unguarded `launch()`.
    ///
    /// Every UI-test launch also opts the Scout illustration out of WebKit. iOS 26.5
    /// automation injects the WebCore/WebKit accessibility bundles the moment a
    /// `WKWebView` exists and then crashes later tests in the same shard, so the runner
    /// renders the accepted clips' static fallbacks. Debug and Release builds still ship
    /// the accepted WebM; `OnboardingFlowTests` covers that path at the pure seam.
    func launchAfterRetiringPriorInstance() {
        if !launchArguments.contains("--static-scout-rendering") {
            launchArguments.append("--static-scout-rendering")
        }
        UILaunchBoundary().launch(self) { self.launch() }
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

    func testForegroundExitWitnessDoesNotTerminateAStillForegroundTarget() {
        let process = PositiveForegroundExitWitnessUIProcess()
        let boundary = UIProcessTerminationBoundary {
            process.pressHome()
        }

        XCTAssertFalse(boundary.terminate(process, timeout: 4))
        XCTAssertEqual(
            process.events,
            [
                "press-home",
                "wait-foreground-exit-witness"
            ]
        )
        XCTAssertEqual(process.waitTimeouts, [4])
        XCTAssertEqual(process.terminateCount, 0)
        XCTAssertEqual(process.state, .runningForeground)
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

final class UILaunchBoundaryTests: XCTestCase {
    func testLaunchIsIssuedOnlyAfterTheProcessIsObservedNotRunning() {
        let process = FakeUIProcess()
        let boundary = UILaunchBoundary(
            terminationBoundary: UIProcessTerminationBoundary {
                process.pressHome()
            }
        )
        var stateWhenLaunchIssued: XCUIApplication.State?

        XCTAssertTrue(
            boundary.launch(process, timeout: 4) {
                stateWhenLaunchIssued = process.state
                process.recordLaunch()
            }
        )

        XCTAssertEqual(
            stateWhenLaunchIssued?.rawValue,
            XCUIApplication.State.notRunning.rawValue,
            "A launch issued while the prior instance is still running makes"
                + " XCTest terminate it implicitly inside the launch budget."
        )
        XCTAssertEqual(
            process.events,
            [
                "press-home",
                "wait-safe-to-terminate",
                "terminate",
                "wait-not-running",
                "launch"
            ]
        )
    }

    func testAlreadyStoppedProcessLaunchesWithoutAnotherTerminateRequest() {
        let process = FakeUIProcess(initialState: .notRunning)
        let boundary = UILaunchBoundary()

        XCTAssertTrue(
            boundary.launch(process, timeout: 4) {
                process.recordLaunch()
            }
        )
        XCTAssertEqual(process.events, ["launch"])
        XCTAssertEqual(process.waitTimeouts, [])
    }

    func testUnverifiableRetirementStillIssuesTheLaunchAndReportsTheFailure() {
        let process = FakeUIProcess(initialState: .unknown)
        let boundary = UILaunchBoundary()

        XCTAssertFalse(
            boundary.launch(process, timeout: 4) {
                process.recordLaunch()
            },
            "Unverified retirement must be reported, never swallowed."
        )
        XCTAssertEqual(
            process.events,
            ["launch"],
            "A test must still run when the prior process cannot be retired;"
                + " skipping it would convert a flake into a silent hole."
        )
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

    func recordLaunch() {
        events.append("launch")
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
            app.launchAfterRetiringPriorInstance()

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
