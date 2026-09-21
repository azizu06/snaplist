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
    /// 0.85 of the screen, inside the 85-90% the owner asked for. It is the
    /// share that clears Trophy Wall's title rather than cutting it in half:
    /// at 0.9 the drawer's top edge lands in the middle of the header, which
    /// reads as a rendering fault rather than as a wall behind a drawer.
    static let heightFraction: CGFloat = 0.85
    static let cornerRadius: CGFloat = 28
    /// How far the wall behind the drawer is dimmed.
    static let scrimOpacity: Double = 0.32
    /// The band at the drawer's top edge that owns the downward drag. The
    /// gesture lives here and nowhere else, so it can never take a swipe
    /// meant for the photo pager or the thumbnail reorder underneath it.
    static let grabHandleBandHeight: CGFloat = 32
}

/// What a finished drag does.
enum ScanDrawerDragOutcome: Equatable {
    case dismiss
    case settle
}

/// The drawer's drag, as arithmetic. A pure seam because the alternative is
/// asserting a fling through the UI, which is exactly the kind of test that
/// passes for the wrong reason.
enum ScanDrawerDragPolicy {
    /// How far down the drawer has to be dragged, as a share of its own
    /// height, for a slow release to dismiss it.
    static let dismissDistanceFraction: CGFloat = 0.25
    /// The downward speed, in points per second, that dismisses regardless of
    /// distance — a flick.
    static let dismissVelocity: CGFloat = 800
    /// How much of an upward drag the drawer gives before it stops. It has
    /// nowhere to go up, so the give is resistance, not travel.
    static let upwardResistance: CGFloat = 0.55

    static func offset(
        forTranslation translation: CGFloat,
        drawerHeight: CGFloat
    ) -> CGFloat {
        // Downward, the drawer is going where the finger is going.
        guard translation < 0 else { return translation }
        // Upward it is already at its full height, so the travel is squeezed
        // into an asymptote: always some give, always less than the finger,
        // never more than the drawer's own height however hard it is pulled.
        let limit = max(drawerHeight, 1)
        let pull = -translation
        return -limit * (1 - 1 / (pull / limit * upwardResistance + 1))
    }

    static func outcome(
        translation: CGFloat,
        velocity: CGFloat,
        drawerHeight: CGFloat
    ) -> ScanDrawerDragOutcome {
        // An upward drag is not a dismissal however fast it is thrown.
        guard translation > 0 else { return .settle }
        if velocity >= dismissVelocity { return .dismiss }
        return translation >= drawerHeight * dismissDistanceFraction
            ? .dismiss
            : .settle
    }
}

/// Whether the drawer springs up or simply appears. The sheet's presentation
/// animation belongs to UIKit, so the shell suppresses it with a transaction
/// rather than a SwiftUI `.animation`; this is the pure seam that decides,
/// and the seam Reduced Motion is asserted against.
enum ScanDrawerMotionPolicy {
    static func shouldAnimatePresentation(reduceMotion: Bool) -> Bool {
        !reduceMotion
    }

    /// Reduced Motion gets a cross-fade rather than travel: the drawer still
    /// announces itself as arriving, without sliding the height of the screen.
    static func transition(reduceMotion: Bool) -> AnyTransition {
        shouldAnimatePresentation(reduceMotion: reduceMotion)
            ? .move(edge: .bottom)
            : .opacity
    }

    static func presentationAnimation(reduceMotion: Bool) -> Animation? {
        shouldAnimatePresentation(reduceMotion: reduceMotion)
            ? .snappy(duration: 0.32)
            : .linear(duration: 0.12)
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

/// What VoiceOver hears when a saved item drops the drawer. Stated once, as
/// data, so the announcement and the test that pins it read the same string.
/// "Analysing" rather than a queue or worker word: the seller-facing states
/// never name the machinery.
enum AppShellSubmissionCompletionCopy {
    static let announcement = "Item added to Trophy Wall. Analysing."
}

/// The Scan drawer's presentation.
///
/// Not a system sheet — see the note at its call site: iOS 26 scales the
/// contents of a sheet that does not reach the screen edges, and the 44pt
/// touch-target floor is not something a visual nicety may spend. So the
/// drawer is drawn: a card holding the bottom `heightFraction` of the screen,
/// the wall dimmed behind it, and the swipe, the grabber and the escape
/// gesture implemented rather than inherited.
struct ScanDrawerSurface<Content: View>: View {
    let reduceMotion: Bool
    let dismiss: () -> Void
    @ViewBuilder let content: Content

    @State private var dragTranslation: CGFloat = 0

    var body: some View {
        GeometryReader { geometry in
            let drawerHeight = geometry.size.height * ScanDrawerMetrics.heightFraction

            ZStack(alignment: .bottom) {
                scrim
                card(height: drawerHeight)
            }
            .frame(
                maxWidth: .infinity,
                maxHeight: .infinity,
                alignment: .bottom
            )
        }
        // Measured against the whole screen, so the drawer's own height is
        // what the seller sees and its content reaches the bottom edge the
        // way the camera does at the root. Anything inside that needs an
        // inset already asks for its own.
        .ignoresSafeArea()
        // The wall behind is dimmed, inert and out of the accessibility tree;
        // the drawer is the only thing on screen that answers.
        .accessibilityAddTraits(.isModal)
        // VoiceOver's and the keyboard's escape gesture close the drawer,
        // which is the same promise the close control and the swipe make.
        .accessibilityAction(.escape, dismiss)
    }

    private var scrim: some View {
        Color.black
            .opacity(ScanDrawerMetrics.scrimOpacity)
            .ignoresSafeArea()
            .contentShape(.rect)
            .onTapGesture(perform: dismiss)
            .accessibilityHidden(true)
    }

    private func card(height: CGFloat) -> some View {
        content
            .frame(maxWidth: .infinity)
            .frame(height: height)
            .background(SnapListColorToken.canvas.color)
            .clipShape(
                UnevenRoundedRectangle(
                    topLeadingRadius: ScanDrawerMetrics.cornerRadius,
                    bottomLeadingRadius: 0,
                    bottomTrailingRadius: 0,
                    topTrailingRadius: ScanDrawerMetrics.cornerRadius,
                    style: .continuous
                )
            )
            .overlay(alignment: .top) { grabHandle(drawerHeight: height) }
            .offset(
                y: max(
                    0,
                    ScanDrawerDragPolicy.offset(
                        forTranslation: dragTranslation,
                        drawerHeight: height
                    )
                )
            )
    }

    /// The grabber, and the only place the downward drag starts.
    ///
    /// The gesture is confined to this band on purpose. Photo Review's pager
    /// swipes horizontally and its thumbnail strip drags to reorder; a drag
    /// attached to the whole card would be competing with both of them for
    /// every touch, and the drawer would occasionally win a swipe the seller
    /// meant for their photos.
    private func grabHandle(drawerHeight: CGFloat) -> some View {
        Color.clear
            .frame(height: ScanDrawerMetrics.grabHandleBandHeight)
            .frame(maxWidth: .infinity)
            .contentShape(.rect)
            .overlay {
                // A material rather than a fixed tint: the drawer holds the
                // black camera and the light Photo Review, and an ink-coloured
                // grabber disappears against the first.
                Capsule()
                    .fill(.regularMaterial)
                    .frame(width: 36, height: 5)
            }
            .gesture(dragGesture(drawerHeight: drawerHeight))
            .accessibilityHidden(true)
    }

    private func dragGesture(drawerHeight: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 4)
            .onChanged { value in
                dragTranslation = value.translation.height
            }
            .onEnded { value in
                let outcome = ScanDrawerDragPolicy.outcome(
                    translation: value.translation.height,
                    velocity: value.predictedEndTranslation.height
                        - value.translation.height,
                    drawerHeight: drawerHeight
                )
                dragTranslation = 0
                guard outcome == .dismiss else { return }
                dismiss()
            }
    }
}
