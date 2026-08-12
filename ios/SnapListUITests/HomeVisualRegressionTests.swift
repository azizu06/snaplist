import XCTest

/// Budgets a UI test spends observing a simulator process through a lifecycle
/// transition.
///
/// Every wait built on this budget returns the instant its condition is
/// observed, so a healthy run never pays it — only a genuinely slow transition
/// does. It therefore has to clear the worst contended CoreSimulator fleet
/// rather than a typical transition. Three seconds was the value observed
/// failing under contention across two independent runs (#708); thirty is the
/// budget #702 already proved sufficient for the same class of wait, and is
/// reused here rather than introducing a second competing number.
enum UIProcessLifecycleBudget {
    static let transition: TimeInterval = 30
}

/// Budget a UI test spends waiting for a view that a navigation it drove must
/// bring back on screen.
///
/// Same shape as `UIProcessLifecycleBudget.transition`, and for the same reason:
/// the wait returns the instant the view exists, so a healthy run never pays it
/// and only a genuinely slow runner does. A small budget here is not a stricter
/// assertion, it is a bet that the runner is fast — and on ui-2 that bet lost
/// (#710). Thirty is the value `UIProcessLifecycleBudget.transition` already
/// carries for the same class of wait, reused rather than competed with.
enum UINavigationBudget {
    static let restoredView: TimeInterval = 30
}

/// The one thing a restored-view wait needs from `XCUIElement`, named so the
/// budget can be observed against a view whose delay the test chooses.
protocol UIViewAppearance {
    func waitForExistence(timeout: TimeInterval) -> Bool
}

extension XCUIElement: UIViewAppearance {}

/// Waits for a view a navigation must restore, through a single budget rather
/// than a number repeated at each call site.
struct UINavigationReturnBoundary {
    let budget: TimeInterval

    init(budget: TimeInterval = UINavigationBudget.restoredView) {
        self.budget = budget
    }

    /// Reports whether `view` came back within the budget.
    func restored(_ view: any UIViewAppearance) -> Bool {
        view.waitForExistence(timeout: budget)
    }
}

extension XCUIApplication.State {
    /// `XCUIApplication.State` has no readable description, so a lifecycle wait
    /// that fails can only name the state it wanted, never the one it saw.
    var reportedName: String {
        switch self {
        case .unknown: return "unknown"
        case .notRunning: return "notRunning"
        case .runningBackgroundSuspended: return "runningBackgroundSuspended"
        case .runningBackground: return "runningBackground"
        case .runningForeground: return "runningForeground"
        @unknown default: return "unrecognized(\(rawValue))"
        }
    }
}

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
    func witnessForegroundExit(timeout: TimeInterval) -> Bool
}

extension UIProcessLifecycle {
    var monotonicUptime: TimeInterval {
        ProcessInfo.processInfo.systemUptime
    }

    /// A plain lifecycle process has no corroborating observer; its own state is
    /// the only thing to witness, and it is already authoritative.
    func witnessForegroundExit(timeout: TimeInterval) -> Bool {
        true
    }

    /// Waits until the process is observed in a state it can be terminated from.
    ///
    /// The process' own state is the condition under test and owns the whole
    /// budget. A corroborating witness (see `witnessForegroundExit`) is
    /// consulted first but is strictly advisory, because before #708 it held
    /// both powers it must not have:
    ///
    /// - **Veto.** A witness that never resolved failed the wait even when the
    ///   target had demonstrably already left the foreground. SpringBoard is
    ///   legitimately not foreground whenever another app owns the screen — the
    ///   golden-states walker's `settings-handoff` step is exactly that case.
    /// - **Budget.** The witness was given the *full* timeout while the
    ///   deadline was pinned before it ran, so a slow witness could leave no
    ///   time at all to observe the target.
    ///
    /// The witness now gets a bounded share of the budget and its result is
    /// discarded, so it can only ever cost time, never a verdict.
    func waitUntilSafeToTerminate(timeout: TimeInterval) -> Bool {
        let deadline = monotonicUptime + timeout
        if state.isSafeToTerminate {
            return true
        }

        _ = witnessForegroundExit(timeout: min(timeout / 3, 2))

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

extension XCUIApplication: UIProcessLifecycle {
    /// SpringBoard returning to the foreground corroborates that a home press
    /// was actually delivered. Advisory only — see `waitUntilSafeToTerminate`.
    func witnessForegroundExit(timeout: TimeInterval) -> Bool {
        XCUIApplication(bundleIdentifier: "com.apple.springboard")
            .wait(for: .runningForeground, timeout: timeout)
    }
}

/// The outcome of retiring a process, carrying enough to diagnose a failure
/// from a CI log alone.
enum UIProcessRetirement {
    case retired
    case stuck(observed: XCUIApplication.State, waited: TimeInterval)

    var isRetired: Bool {
        if case .retired = self {
            return true
        }
        return false
    }

    /// A lifecycle failure that only says a process "did not terminate" cannot
    /// be triaged: the reader cannot tell a wedged app from a budget that was
    /// simply too small for a contended fleet. Name both the state still
    /// observed and how long it was waited for.
    ///
    /// `nil` when the process retired — a successful retirement has no failure
    /// to describe, and callers branch on that rather than on an empty string.
    func failureDescription(_ subject: String) -> String? {
        guard case let .stuck(observed, waited) = self else {
            return nil
        }
        return """
            \(subject) did not retire: waited \(Int(waited.rounded()))s for \
            runningBackground, runningBackgroundSuspended, or notRunning and \
            still observed \(observed.reportedName)
            """
    }
}

struct UIProcessTerminationBoundary {
    private let pressHome: () -> Void

    init(pressHome: @escaping () -> Void = {
        XCUIDevice.shared.press(.home)
    }) {
        self.pressHome = pressHome
    }

    func retire(
        _ process: any UIProcessLifecycle,
        timeout: TimeInterval = UIProcessLifecycleBudget.transition
    ) -> UIProcessRetirement {
        let started = process.monotonicUptime
        func stuck() -> UIProcessRetirement {
            .stuck(
                observed: process.state,
                waited: process.monotonicUptime - started
            )
        }

        if process.state == .runningForeground {
            pressHome()
            guard process.waitUntilSafeToTerminate(timeout: timeout) else {
                return stuck()
            }
        }

        guard process.state.isSafeToTerminate else {
            return stuck()
        }
        guard process.state != .notRunning else {
            return .retired
        }

        process.terminate()
        return process.wait(for: .notRunning, timeout: timeout)
            ? .retired
            : stuck()
    }

    func terminate(
        _ process: any UIProcessLifecycle,
        timeout: TimeInterval = UIProcessLifecycleBudget.transition
    ) -> Bool {
        retire(process, timeout: timeout).isRetired
    }

    /// Retires `process`, failing the calling test with a message that names the
    /// state still observed and the budget waited for.
    func assertRetired(
        _ process: any UIProcessLifecycle,
        _ subject: String,
        timeout: TimeInterval = UIProcessLifecycleBudget.transition,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let outcome = retire(process, timeout: timeout)
        if let failure = outcome.failureDescription(subject) {
            XCTFail(failure, file: file, line: line)
        }
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
    private let report: (String) -> Void

    init(
        terminationBoundary: UIProcessTerminationBoundary = UIProcessTerminationBoundary(),
        report: @escaping (String) -> Void = { message in
            // An activity alone lands only in the result bundle, and the CI
            // shard jobs keep just the console log — the one artifact that
            // survives is the one that would not have carried this line. Emit
            // it to both: the activity keeps the report readable in Xcode, and
            // NSLog puts it where a shard failure is actually triaged from.
            NSLog("%@", message)
            XCTContext.runActivity(named: message) { _ in }
        }
    ) {
        self.terminationBoundary = terminationBoundary
        self.report = report
    }

    @discardableResult
    func launch(
        _ process: any UIProcessLifecycle,
        timeout: TimeInterval = UIProcessLifecycleBudget.transition,
        issueLaunch: () -> Void
    ) -> Bool {
        let retirement = terminationBoundary.retire(process, timeout: timeout)
        if let failure = retirement.failureDescription("The prior instance") {
            // The launch still goes ahead — skipping it would convert a flake
            // into a silent hole — but XCTest will now terminate the live
            // instance implicitly inside its own launch budget, and reports
            // only "Timed out while launching application via Xcode" with
            // nothing naming the cause. Record what was observed so the next
            // occurrence distinguishes an unretired prior instance from runner
            // starvation.
            report(failure)
        }
        issueLaunch()
        return retirement.isRetired
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

    // MARK: - #708 contended-fleet lifecycle races

    func testTargetOutOfForegroundRetiresEvenWhenTheWitnessNeverResolves() {
        let process = ContendedFleetUIProcess(
            backgroundsAt: 0.5,
            witnessResolvesAt: nil
        )
        let boundary = UIProcessTerminationBoundary {}

        XCTAssertTrue(
            boundary.terminate(process, timeout: 3),
            "A witness that never resolves must not veto a target that has"
                + " already left the foreground: SpringBoard is corroboration,"
                + " not the condition under test."
        )
        XCTAssertEqual(process.state, .notRunning)
    }

    func testWitnessCannotConsumeTheBudgetTheTargetNeedsToBeObserved() {
        let process = ContendedFleetUIProcess(
            backgroundsAt: 2.8,
            witnessResolvesAt: nil
        )
        let boundary = UIProcessTerminationBoundary {}

        XCTAssertTrue(
            boundary.terminate(process, timeout: 3),
            "A witness given the full budget leaves no time to observe the"
                + " target, which is the transition actually being waited on."
        )
        XCTAssertEqual(
            process.witnessBudgets,
            [1],
            "The witness may spend at most a third of the budget."
        )
    }

    func testWitnessShareStaysCappedAtTwoSecondsOnTheFullTransitionBudget() {
        let process = ContendedFleetUIProcess(
            backgroundsAt: 2.5,
            witnessResolvesAt: nil
        )
        let boundary = UIProcessTerminationBoundary {}

        XCTAssertTrue(
            boundary.terminate(
                process,
                timeout: UIProcessLifecycleBudget.transition
            )
        )
        XCTAssertEqual(
            process.witnessBudgets,
            [2],
            "The witness share is min(timeout / 3, 2). At the real transition"
                + " budget the two-second cap has to bind, or a thirty-second"
                + " budget would hand ten of them to advisory corroboration."
        )
    }

    func testContendedForegroundExitNeedsMoreThanTheOldThreeSecondBudget() {
        func retire(within timeout: TimeInterval) -> Bool {
            UIProcessTerminationBoundary {}.terminate(
                ContendedFleetUIProcess(
                    backgroundsAt: 4.2,
                    witnessResolvesAt: 0.4
                ),
                timeout: timeout
            )
        }

        XCTAssertFalse(
            retire(within: 3),
            "Three seconds is the budget observed failing under fleet"
                + " contention across two independent CI runs (#708)."
        )
        XCTAssertTrue(retire(within: UIProcessLifecycleBudget.transition))
    }

    func testStuckRetirementNamesTheObservedStateAndTheBudgetItWaited() {
        let process = ContendedFleetUIProcess(
            backgroundsAt: 9,
            witnessResolvesAt: 0.1
        )
        let outcome = UIProcessTerminationBoundary {}.retire(
            process,
            timeout: 3
        )

        XCTAssertFalse(outcome.isRetired)
        guard let description = outcome.failureDescription(
            "SnapList after ONB-09-camera"
        ) else {
            return XCTFail("A stuck retirement must describe its failure.")
        }
        XCTAssertTrue(
            description.contains("SnapList after ONB-09-camera"),
            "Unexpected failure description: \(description)"
        )
        XCTAssertTrue(
            description.contains("waited 3s"),
            "Unexpected failure description: \(description)"
        )
        XCTAssertTrue(
            description.contains("still observed runningForeground"),
            "Unexpected failure description: \(description)"
        )
    }
}

final class UINavigationReturnBoundaryTests: XCTestCase {
    /// The ui-2 timeline that flaked `testExactCustomRunDeepLinkOpensDetail…`
    /// (#710), replayed. That runner needed 36.59s to bring the deep-linked
    /// detail to idle (23.10s to 59.69s), Back landed at 63.65s, and the wall
    /// had still not come back when the budget expired at 70.669s — 7.02s of
    /// waiting. The budget has to clear that second number on a runner capable
    /// of producing the first, or the assertion is measuring the runner.
    func testTheRestoredWallSurvivesTheSlowRunnerTimelineThatFlakedTheDeepLink() {
        let wall = DelayedView(appearsAfter: 7.02)

        XCTAssertTrue(UINavigationReturnBoundary().restored(wall))
        XCTAssertEqual(wall.requestedBudgets, [UINavigationBudget.restoredView])
    }

    /// Pins the delay, not the fake: the same view on the budget this test was
    /// written against is still reported absent, so a `restored` that answered
    /// `true` unconditionally could not pass both tests.
    func testTheThreeSecondBudgetStillMissesThatSameRestoredWall() {
        let wall = DelayedView(appearsAfter: 7.02)

        XCTAssertFalse(UINavigationReturnBoundary(budget: 3).restored(wall))
        XCTAssertEqual(wall.requestedBudgets, [3])
    }
}

/// A view that only becomes observable `appearsAfter` seconds into the runner's
/// wall clock. `waitForExistence` answers what XCUITest answers: true only when
/// the budget it was handed covers that delay.
private final class DelayedView: UIViewAppearance {
    private let appearsAfter: TimeInterval
    private(set) var requestedBudgets: [TimeInterval] = []

    init(appearsAfter: TimeInterval) {
        self.appearsAfter = appearsAfter
    }

    func waitForExistence(timeout: TimeInterval) -> Bool {
        requestedBudgets.append(timeout)
        return timeout >= appearsAfter
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

    func testUnverifiableRetirementIsReportedBeforeTheLaunchIsIssued() {
        let process = FakeUIProcess(initialState: .unknown)
        var order: [String] = []
        var reported: [String] = []
        let boundary = UILaunchBoundary(report: {
            reported.append($0)
            order.append("report")
        })

        XCTAssertFalse(
            boundary.launch(process, timeout: 4) {
                order.append("launch")
                process.recordLaunch()
            }
        )
        XCTAssertEqual(
            order,
            ["report", "launch"],
            "An implicit terminate inside the launch budget reports only a"
                + " launch timeout, so the observed prior state has to be"
                + " recorded before the launch is issued."
        )
        XCTAssertEqual(
            reported.first?.contains("still observed unknown"),
            true,
            "Unexpected report: \(reported)"
        )
    }
}

/// A target whose foreground exit and corroborating witness resolve at
/// independent, controllable times on a simulated clock — the shape #708
/// observed on a contended CoreSimulator fleet.
private final class ContendedFleetUIProcess: UIProcessLifecycle {
    private(set) var state = XCUIApplication.State.runningForeground
    private(set) var monotonicUptime: TimeInterval = 0
    private(set) var witnessBudgets: [TimeInterval] = []
    private let backgroundsAt: TimeInterval
    private let witnessResolvesAt: TimeInterval?

    init(backgroundsAt: TimeInterval, witnessResolvesAt: TimeInterval?) {
        self.backgroundsAt = backgroundsAt
        self.witnessResolvesAt = witnessResolvesAt
    }

    func terminate() {
        state = .notRunning
    }

    func wait(for target: XCUIApplication.State, timeout: TimeInterval) -> Bool {
        let deadline = monotonicUptime + timeout
        if state == .notRunning {
            return target == .notRunning
        }
        if target == .runningBackgroundSuspended, backgroundsAt <= deadline {
            monotonicUptime = max(monotonicUptime, backgroundsAt)
            state = .runningBackgroundSuspended
            return true
        }
        monotonicUptime = deadline
        return false
    }

    func witnessForegroundExit(timeout: TimeInterval) -> Bool {
        witnessBudgets.append(timeout)
        let deadline = monotonicUptime + timeout
        guard let witnessResolvesAt, witnessResolvesAt <= deadline else {
            monotonicUptime = deadline
            return false
        }
        monotonicUptime = max(monotonicUptime, witnessResolvesAt)
        return true
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

    /// HOME-03 and HOME-04 were the attention feed and the listings search. Both
    /// were retired with the seller-operations surface, so the approved Trophy
    /// Wall has exactly two visual states left to capture.
    func testBothApprovedTrophyWallStatesRenderAtCanonicalViewport() {
        let requiresCanonicalViewport = ProcessInfo.processInfo.environment[
            "SNAPLIST_REQUIRE_CANONICAL_VIEWPORT"
        ] == "1"
        let processTermination = UIProcessTerminationBoundary()
        let boundaries = ["HOME-01": "trophy.wall.grid", "HOME-02": "trophy.wall.empty"]

        for (state, boundary) in boundaries.sorted(by: { $0.key < $1.key }) {
            let app = XCUIApplication()
            app.launchArguments = [
                "--visual-state=\(state)",
                "--zero-network-fixtures",
                "--reset-onboarding-progress",
                "--reduced-motion"
            ]
            app.launchAfterRetiringPriorInstance()

            XCTAssertTrue(
                app.descendants(matching: .any)[boundary]
                    .waitForExistence(timeout: 3),
                "Missing Trophy Wall boundary for \(state)"
            )
            if requiresCanonicalViewport {
                XCTAssertEqual(app.windows.firstMatch.frame.size.width, 393)
                XCTAssertEqual(app.windows.firstMatch.frame.size.height, 852)
            }

            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = "\(state).png"
            attachment.lifetime = .keepAlways
            add(attachment)
            processTermination.assertRetired(app, "SnapList after \(state)")
        }
    }
}
