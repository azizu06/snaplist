import SwiftUI

/// What moved the Scan drawer. Every presentation change goes through one of
/// these, so the camera session's lifetime is decided in one place instead of
/// being re-derived at each call site.
enum ScanDrawerEvent: Equatable {
    /// The one Scan entry control on Trophy Wall, whatever chrome hosts it.
    case scanEntryControlTapped
    /// The grabber's downward swipe, the drawer's own close control, or a
    /// system interactive dismissal the shell never initiated. They are the
    /// same event because they mean the same thing to the seller's work.
    case dismissed
    /// Scan goes back on screen without the seller touching the entry
    /// control: a relaunch that restored an unfinished intake, a Trophy Wall
    /// pending card reopened, or a hand-off that starts the next item.
    case scanSurfaceRestored
    /// The seller acknowledged a durable acceptance from inside the drawer.
    case submissionCompleted
}

/// The work already in flight when an event arrives. The reducer reads it so a
/// dismissal's meaning can be stated against the case that matters — a seller
/// swiping the drawer away while an item is being submitted — rather than only
/// against an empty drawer.
struct ScanDrawerContext: Equatable {
    var hasUnfinishedIntake = false
    var isSubmissionInFlight = false
}

/// Whether the Scan drawer is over Trophy Wall. Deliberately the whole of the
/// shell's Scan presentation state: Trophy Wall is the root, so there is no
/// second thing to be "selected".
struct ScanDrawerState: Equatable {
    var isPresented = false
}

/// The camera session change a reduction asks the shell to make. The drawer's
/// presentation and the capture session are the same decision, so the reducer
/// hands back both halves of it and no screen has to remember to stop a
/// session it did not start.
enum ScanDrawerCameraCommand: Equatable {
    case start
    case stop
}

/// What a reduction does to work the seller has already put in.
enum ScanDrawerIntakeDisposition: Equatable {
    /// The staged photos, the durable draft and any in-flight submission all
    /// outlive the presentation change. Every dismissal is this one.
    case preserve
    /// The server already owns the item and the seller has acknowledged it, so
    /// there is nothing left in the drawer to preserve.
    case alreadySettled
}

/// A reduction carries the next state, the camera session work it implies, and
/// what it does to the seller's intake. It deliberately holds no reference to
/// an intake or a submission, so "dismissing cannot cancel my item" is a fact
/// about the type rather than a promise made by its callers.
struct ScanDrawerReduction: Equatable {
    let state: ScanDrawerState
    let cameraCommand: ScanDrawerCameraCommand?
    let intakeDisposition: ScanDrawerIntakeDisposition
}

/// The drawer's layout contract. A fraction rather than `.large` because the
/// owner asked for the Trophy Wall edge to stay visible above the drawer: the
/// wall is the home surface and the camera is a layer over it, so the seller
/// should be able to see what they are coming back to.
enum ScanDrawerMetrics {
    static let heightFraction: CGFloat = 0.9
}

/// Whether the drawer springs up or simply appears. The sheet's presentation
/// animation belongs to UIKit, so the shell suppresses it with a transaction
/// rather than a SwiftUI `.animation`; this is the pure seam that decides,
/// and the seam Reduced Motion is asserted against.
enum ScanDrawerMotionPolicy {
    static func shouldAnimatePresentation(reduceMotion: Bool) -> Bool {
        !reduceMotion
    }
}

enum ScanDrawerPolicy {
    static func reduce(
        _ state: ScanDrawerState,
        _ event: ScanDrawerEvent,
        context: ScanDrawerContext = ScanDrawerContext()
    ) -> ScanDrawerReduction {
        let presents: Bool
        let intakeDisposition: ScanDrawerIntakeDisposition
        switch event {
        case .scanEntryControlTapped, .scanSurfaceRestored:
            presents = true
            intakeDisposition = .preserve
        case .dismissed:
            presents = false
            intakeDisposition = .preserve
        case .submissionCompleted:
            presents = false
            intakeDisposition = .alreadySettled
        }

        // The camera follows the *transition*, not the event. Several call
        // sites can ask for the same presentation in a row — the entry
        // control, a restoration, and the system's own dismissal notice all
        // arrive independently — and restarting a live session would drop the
        // seller's framing mid-shot.
        let cameraCommand: ScanDrawerCameraCommand?
        switch (state.isPresented, presents) {
        case (false, true): cameraCommand = .start
        case (true, false): cameraCommand = .stop
        case (true, true), (false, false): cameraCommand = nil
        }

        return ScanDrawerReduction(
            state: ScanDrawerState(isPresented: presents),
            cameraCommand: cameraCommand,
            intakeDisposition: intakeDisposition
        )
    }
}
