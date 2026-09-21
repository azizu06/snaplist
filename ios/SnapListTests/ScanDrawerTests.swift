import XCTest
@testable import SnapList

/// #1129. Trophy Wall is the app's home surface and Scan rises over it as a
/// drawer, so "is Scan on screen?" stopped being a tab selection and became a
/// presentation question. This reducer is the one place that answers it, and
/// the camera session's start/stop rides the same answer so the two can never
/// disagree.
final class ScanDrawerPolicyTests: XCTestCase {
    func testTheScanEntryControlOpensTheDrawerAndStartsTheCamera() {
        let reduction = ScanDrawerPolicy.reduce(
            ScanDrawerState(),
            .scanEntryControlTapped
        )

        XCTAssertTrue(reduction.state.isPresented)
        XCTAssertEqual(reduction.cameraCommand, .start)
    }

    /// A system sheet can be dismissed by an interactive swipe the shell never
    /// initiated, and the seller can do it while an item is being submitted.
    /// That is a presentation change and nothing else: the staged intake and
    /// the in-flight submission both outlive it.
    func testDismissingMidSubmissionClosesTheDrawerWithoutSettlingTheIntake() {
        let reduction = ScanDrawerPolicy.reduce(
            ScanDrawerState(isPresented: true),
            .dismissed,
            context: ScanDrawerContext(
                hasUnfinishedIntake: true,
                isSubmissionInFlight: true
            )
        )

        XCTAssertFalse(reduction.state.isPresented)
        XCTAssertEqual(reduction.cameraCommand, .stop)
        XCTAssertEqual(reduction.intakeDisposition, .preserve)
    }

    /// Done is the seller acknowledging an item the server already accepted.
    /// That is the one exit where there is nothing left in the drawer to
    /// protect, and the only one that puts them back on the wall by itself.
    func testDoneAfterDurableAcceptanceClosesTheDrawerAndSettlesTheIntake() {
        let reduction = ScanDrawerPolicy.reduce(
            ScanDrawerState(isPresented: true),
            .submissionCompleted,
            context: ScanDrawerContext(hasUnfinishedIntake: false)
        )

        XCTAssertFalse(reduction.state.isPresented)
        XCTAssertEqual(reduction.cameraCommand, .stop)
        XCTAssertEqual(reduction.intakeDisposition, .alreadySettled)
    }

    /// The drawer's events arrive from several places at once — the entry
    /// control, a restoration, the system's own dismissal — so a reduction
    /// that does not move the presentation must not move the camera either.
    /// Restarting a live session drops the seller's framing; stopping one
    /// nobody started tears down a session the drawer does not own.
    func testEventsThatDoNotMoveThePresentationLeaveTheCameraAlone() {
        let reopened = ScanDrawerPolicy.reduce(
            ScanDrawerState(isPresented: true),
            .scanEntryControlTapped
        )
        XCTAssertTrue(reopened.state.isPresented)
        XCTAssertNil(reopened.cameraCommand)

        let redundantDismissal = ScanDrawerPolicy.reduce(
            ScanDrawerState(isPresented: false),
            .dismissed
        )
        XCTAssertFalse(redundantDismissal.state.isPresented)
        XCTAssertNil(redundantDismissal.cameraCommand)
    }

    /// A relaunch that recovered a draft, and a pending card reopened from the
    /// wall, both put Scan back in front of the seller with their photos still
    /// staged. The drawer has to come up and the camera has to come back with
    /// it, or the seller lands on a dead surface holding their own work.
    func testRestoringScanOverAnUnfinishedIntakePresentsTheDrawerAndTheCamera() {
        let reduction = ScanDrawerPolicy.reduce(
            ScanDrawerState(),
            .scanSurfaceRestored,
            context: ScanDrawerContext(hasUnfinishedIntake: true)
        )

        XCTAssertTrue(reduction.state.isPresented)
        XCTAssertEqual(reduction.cameraCommand, .start)
        XCTAssertEqual(reduction.intakeDisposition, .preserve)
    }
}

/// #1129. The drawer's layout and motion contract, stated as values so the
/// acceptance numbers are assertable without measuring a rendered sheet.
final class ScanDrawerPresentationTests: XCTestCase {
    /// The owner asked for a drawer that stops short of the top so the Trophy
    /// Wall edge stays visible behind it — 80 to 90 percent of the screen.
    func testTheDrawerLeavesTheTrophyWallEdgeVisibleAboveIt() {
        XCTAssertGreaterThanOrEqual(ScanDrawerMetrics.heightFraction, 0.8)
        XCTAssertLessThanOrEqual(ScanDrawerMetrics.heightFraction, 0.9)
    }

    /// Reduced Motion drops the drawer's spring travel. The sheet's own
    /// presentation animation is UIKit's, so the shell disables it through a
    /// transaction and this is the seam that decides.
    func testReducedMotionPresentsTheDrawerWithoutSpringTravel() {
        XCTAssertTrue(
            ScanDrawerMotionPolicy.shouldAnimatePresentation(reduceMotion: false)
        )
        XCTAssertFalse(
            ScanDrawerMotionPolicy.shouldAnimatePresentation(reduceMotion: true)
        )
    }
}

final class AppShellSubmissionCompletionCopyTests: XCTestCase {
    /// #1129: the exact line VoiceOver hears when a saved item drops the
    /// drawer. Pinned because it is the only thing that tells a seller who
    /// cannot see the wall that their item went somewhere, and because the
    /// seller-facing vocabulary may never name a queue, worker or lease.
    func testTheCompletionAnnouncementNamesWhereTheItemWentAndWhatItIsDoing() {
        XCTAssertEqual(
            AppShellSubmissionCompletionCopy.announcement,
            "Item added to Trophy Wall. Analysing."
        )
    }
}

final class ScanDrawerDragPolicyTests: XCTestCase {
    private let drawerHeight: CGFloat = 700

    /// A short tug that the seller lets go of is not a dismissal. The drawer
    /// holds an unfinished intake, so the cheap mistake has to be the one that
    /// keeps it open.
    func testAShortSlowDragSettlesBackInsteadOfDismissing() {
        XCTAssertEqual(
            ScanDrawerDragPolicy.outcome(
                translation: drawerHeight * 0.2,
                velocity: 0,
                drawerHeight: drawerHeight
            ),
            .settle
        )
    }

    func testDraggingPastAQuarterOfTheDrawerDismissesIt() {
        XCTAssertEqual(
            ScanDrawerDragPolicy.outcome(
                translation: drawerHeight * 0.26,
                velocity: 0,
                drawerHeight: drawerHeight
            ),
            .dismiss
        )
    }

    /// A flick is an intention even when the finger barely moved.
    func testAFastFlickDismissesFromAnyDistance() {
        XCTAssertEqual(
            ScanDrawerDragPolicy.outcome(
                translation: 12,
                velocity: ScanDrawerDragPolicy.dismissVelocity,
                drawerHeight: drawerHeight
            ),
            .dismiss
        )
    }

    /// Dragging up is not a dismissal however hard it is thrown; the drawer is
    /// already at its full height.
    func testAnUpwardDragNeverDismisses() {
        XCTAssertEqual(
            ScanDrawerDragPolicy.outcome(
                translation: -400,
                velocity: -4000,
                drawerHeight: drawerHeight
            ),
            .settle
        )
    }

    func testDownwardDragFollowsTheFingerExactly() {
        XCTAssertEqual(
            ScanDrawerDragPolicy.offset(forTranslation: 120, drawerHeight: drawerHeight),
            120,
            accuracy: 0.001
        )
    }

    /// Upward, the drawer gives a little and resists: some travel, always less
    /// than the finger, and never more than the drawer's own height however
    /// far the drag goes.
    func testUpwardDragIsRubberBandedRatherThanFollowedOrFrozen() {
        let modest = ScanDrawerDragPolicy.offset(
            forTranslation: -100,
            drawerHeight: drawerHeight
        )
        XCTAssertLessThan(modest, 0, "The drawer has to give something.")
        XCTAssertGreaterThan(modest, -100, "It must not follow the finger.")

        let extreme = ScanDrawerDragPolicy.offset(
            forTranslation: -100_000,
            drawerHeight: drawerHeight
        )
        XCTAssertGreaterThan(
            extreme,
            -drawerHeight,
            "However hard it is pulled, the give stays bounded."
        )
        XCTAssertLessThan(extreme, modest, "Pulling harder still gives more.")
    }
}

