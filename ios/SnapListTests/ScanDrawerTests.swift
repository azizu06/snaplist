import SwiftUI
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

    /// The seller can swipe the drawer away, tap its close control or use the
    /// escape gesture at any point, an item mid-submission included. That is
    /// a presentation change and nothing else: the staged intake and any
    /// in-flight submission outlive it. The UI test
    /// `testDismissingTheDrawerMidSubmissionNeitherCancelsNorDropsTheItem`
    /// proves the shell's half.
    func testDismissingClosesTheDrawerWithoutSettlingTheIntake() {
        let reduction = ScanDrawerPolicy.reduce(
            ScanDrawerState(isPresented: true),
            .dismissed
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
            .submissionCompleted
        )

        XCTAssertFalse(reduction.state.isPresented)
        XCTAssertEqual(reduction.cameraCommand, .stop)
        XCTAssertEqual(reduction.intakeDisposition, .alreadySettled)
    }

    /// The drawer's events arrive from several places at once — the entry
    /// control, a restoration, a drag or close-control dismissal — so a reduction
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
            .scanSurfaceRestored
        )

        XCTAssertTrue(reduction.state.isPresented)
        XCTAssertEqual(reduction.cameraCommand, .start)
        XCTAssertEqual(reduction.intakeDisposition, .preserve)
    }

    /// A seller who swiped the drawer away from Photo Review and opens it
    /// again lands back on Photo Review, not the camera. Starting a capture
    /// session there would run the camera behind a screen that cannot show
    /// it; Photo Review starts it itself when the seller goes back to Scan.
    func testReopeningOntoPhotoReviewLeavesTheCameraOff() {
        let reduction = ScanDrawerPolicy.reduce(
            ScanDrawerState(),
            .scanEntryControlTapped,
            context: ScanDrawerContext(isPhotoReviewOpen: true)
        )

        XCTAssertTrue(reduction.state.isPresented)
        XCTAssertNil(reduction.cameraCommand)
        XCTAssertEqual(reduction.intakeDisposition, .preserve)
    }
}

/// #1129. The drawer's layout and motion contract, stated as values so the
/// acceptance numbers are assertable without measuring a rendered sheet.
final class ScanDrawerPresentationTests: XCTestCase {
    /// The accepted phase-1 height: nine tenths of the physical screen, so the
    /// Trophy Wall edge stays visible above it. Measured from the screen's
    /// edges, not the safe area — an iPhone 17 Pro is 874pt tall, of which a
    /// GeometryReader sees 778pt between its 62pt top and 34pt bottom insets.
    func testTheDrawerCoversNineTenthsOfThePhysicalScreen() {
        let layout = ScanDrawerLayout(
            safeAreaSize: CGSize(width: 402, height: 778),
            safeAreaInsets: EdgeInsets(top: 62, leading: 0, bottom: 34, trailing: 0)
        )

        XCTAssertEqual(layout.drawerHeight, 786.6, accuracy: 0.001)
    }

    /// The drawer reaches the bottom edge, so its content has to be handed
    /// the home indicator's 34pt back; and the grab band owns the top 32pt,
    /// so the camera's close control has to start below it rather than under
    /// a band that swallows its taps.
    func testTheDrawerContentClearsTheGrabBandAndTheHomeIndicator() {
        let layout = ScanDrawerLayout(
            safeAreaSize: CGSize(width: 402, height: 778),
            safeAreaInsets: EdgeInsets(top: 62, leading: 0, bottom: 34, trailing: 0)
        )

        XCTAssertEqual(
            layout.contentInsets,
            EdgeInsets(top: 32, leading: 0, bottom: 34, trailing: 0)
        )
    }

    /// Landscape puts the Dynamic Island and the rounded corners at the sides.
    /// The drawer spans the full width, so its content has to be handed those
    /// side insets back, and the height still comes from the physical screen.
    func testLandscapeHandsTheSideInsetsBackToTheDrawerContent() {
        let layout = ScanDrawerLayout(
            safeAreaSize: CGSize(width: 750, height: 382),
            safeAreaInsets: EdgeInsets(top: 0, leading: 62, bottom: 20, trailing: 62)
        )

        XCTAssertEqual(layout.drawerHeight, 361.8, accuracy: 0.001)
        XCTAssertEqual(
            layout.contentInsets,
            EdgeInsets(top: 32, leading: 62, bottom: 20, trailing: 62)
        )
    }

    /// The keyboard arrives as a taller bottom inset and a shorter safe area.
    /// The drawer keeps its height and hands the keyboard's inset to its
    /// content, so nothing in the drawer ends up underneath the keys.
    func testTheKeyboardInsetsTheDrawerContentWithoutMovingTheDrawer() {
        let layout = ScanDrawerLayout(
            safeAreaSize: CGSize(width: 402, height: 476),
            safeAreaInsets: EdgeInsets(top: 62, leading: 0, bottom: 336, trailing: 0)
        )

        XCTAssertEqual(layout.drawerHeight, 786.6, accuracy: 0.001)
        XCTAssertEqual(layout.contentInsets.bottom, 336)
    }

    /// Reduced Motion drops the drawer's travel for a short cross-fade. The
    /// drawer's transition and animation both derive from this answer, so
    /// this is the seam that decides.
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
            ScanDrawerDragPolicy.offset(forTranslation: 120),
            120,
            accuracy: 0.001
        )
    }

    /// Upward, the drawer stays pinned to the bottom edge: lifting it would
    /// open a gap under the card that shows the wall through the floor.
    func testUpwardDragLeavesTheDrawerPinnedToTheBottomEdge() {
        XCTAssertEqual(ScanDrawerDragPolicy.offset(forTranslation: -100), 0)
        XCTAssertEqual(ScanDrawerDragPolicy.offset(forTranslation: -100_000), 0)
    }
}

