import SwiftUI

/// What moved the Scan drawer. Every presentation change goes through one of
/// these, so the camera session's lifetime is decided in one place instead of
/// being re-derived at each call site.
enum ScanDrawerEvent: Equatable {
    /// The one Scan entry control on Trophy Wall, whatever chrome hosts it.
    case scanEntryControlTapped
    /// The header's downward drag, the drawer's own close control, a tap on
    /// the dock's Trophy Wall slot, or the accessibility escape gesture. They
    /// are the same event because they mean the same thing to the seller's
    /// work.
    case dismissed
    /// Scan goes back on screen without the seller touching the entry
    /// control: a relaunch that restored an unfinished intake, a Trophy Wall
    /// pending card reopened, or a hand-off that starts the next item.
    case scanSurfaceRestored
    /// The seller acknowledged a durable acceptance from inside the drawer.
    case submissionCompleted
}

/// What the drawer holds when an event arrives, as far as the camera session
/// is concerned. Staged photos and an in-flight submission are deliberately
/// not here: no event may touch them, so the reducer has no use for them.
struct ScanDrawerContext: Equatable {
    /// Photo Review, not the camera, is what the drawer shows.
    var isPhotoReviewOpen = false
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
/// what it does to the seller's intake. It holds no reference to an intake or
/// a submission, so the reducer itself cannot cancel an item. Neither
/// disposition asks the shell to act; the shell keeps its half of the promise
/// by touching only the camera, which the mid-submission dismissal UI test
/// pins.
struct ScanDrawerReduction: Equatable {
    let state: ScanDrawerState
    let cameraCommand: ScanDrawerCameraCommand?
    let intakeDisposition: ScanDrawerIntakeDisposition
}

/// The drawer's layout contract. A fraction rather than full height because
/// the owner asked for the Trophy Wall edge to stay visible above the drawer:
/// the wall is the home surface and the camera is a layer over it, so the
/// seller should be able to see what they are coming back to.
enum ScanDrawerMetrics {
    /// The accepted phase-1 height, as a share of the physical screen.
    static let heightFraction: CGFloat = 0.9
    static let cornerRadius: CGFloat = 28
    /// How far the wall behind the drawer is dimmed.
    static let scrimOpacity: Double = 0.32
    /// The band at the drawer's top edge that owns the downward drag. The
    /// gesture lives here and nowhere else, so it can never take a swipe
    /// meant for the photo pager or the thumbnail reorder underneath it.
    static let grabHandleBandHeight: CGFloat = 32
}

/// Where the drawer sits, derived from what a GeometryReader reports: the
/// safe-area size and the insets around it. Pure so the device geometry the
/// drawer has to honour is assertable without rendering one.
struct ScanDrawerLayout: Equatable {
    let drawerHeight: CGFloat
    let contentInsets: EdgeInsets

    init(safeAreaSize: CGSize, safeAreaInsets: EdgeInsets) {
        let screenHeight = safeAreaSize.height
            + safeAreaInsets.top
            + safeAreaInsets.bottom
        drawerHeight = screenHeight * ScanDrawerMetrics.heightFraction
        contentInsets = EdgeInsets(
            top: ScanDrawerMetrics.grabHandleBandHeight,
            leading: safeAreaInsets.leading,
            bottom: safeAreaInsets.bottom,
            trailing: safeAreaInsets.trailing
        )
    }
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

    /// Downward, the drawer goes where the finger goes. Upward it stays put:
    /// the card is pinned to the screen's bottom edge, and lifting it would
    /// open a gap under it that shows the wall through the floor.
    static func offset(forTranslation translation: CGFloat) -> CGFloat {
        max(0, translation)
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

/// Whether the drawer slides up or fades in. The shell takes its transition
/// and animation from here, so this is the seam Reduced Motion is asserted
/// against.
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
        // control, a restoration, and a drag or escape dismissal all
        // arrive independently — and restarting a live session would drop the
        // seller's framing mid-shot. Photo Review owns the drawer's content
        // while it is open, so rising onto it leaves the camera off.
        let cameraCommand: ScanDrawerCameraCommand?
        switch (state.isPresented, presents) {
        case (false, true): cameraCommand = context.isPhotoReviewOpen ? nil : .start
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

extension CaptureFlowModel {
    /// Starts the camera, but only while the Scan drawer is up. The drawer's
    /// own start and the Photo Review exits all run asynchronously and can
    /// begin after the seller has pulled the drawer down; raising the drawer
    /// again starts it through the reducer. A dismissal that lands after this
    /// check is `startCamera()`'s to catch: the dismissal cancels the camera,
    /// and a cancelled start never reports a live session.
    func startCameraIfDrawerIsUp(in router: AppRouter) async {
        guard router.isScanPresented else { return }
        await startCamera()
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
    let isPresented: Bool
    let reduceMotion: Bool
    let dismiss: () -> Void
    @ViewBuilder let content: () -> Content

    @State private var dragTranslation: CGFloat = 0
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        // Mounted whether or not the drawer is up, so neither reader is ever
        // the view that slides. The outer one respects the safe area, the
        // keyboard's included, so its proxy reports the real insets. The
        // inner one ignores them to span the screen edge to edge — a reader,
        // because it takes exactly the size it is offered; a flexible frame
        // holding a card taller than the safe area landed 8.6pt short of the
        // bottom edge. The drawer's content is handed the insets back, which
        // is what the camera at the root gets from the window.
        GeometryReader { safeArea in
            let layout = ScanDrawerLayout(
                safeAreaSize: safeArea.size,
                safeAreaInsets: safeArea.safeAreaInsets
            )

            GeometryReader { _ in
                ZStack(alignment: .bottom) {
                    if isPresented {
                        scrim
                            .transition(.opacity)
                        card(layout)
                            .transition(
                                ScanDrawerMotionPolicy.transition(
                                    reduceMotion: reduceMotion
                                )
                            )
                    }
                }
                .frame(
                    maxWidth: .infinity,
                    maxHeight: .infinity,
                    alignment: .bottom
                )
            }
            .ignoresSafeArea()
        }
        .animation(
            ScanDrawerMotionPolicy.presentationAnimation(reduceMotion: reduceMotion),
            value: isPresented
        )
    }

    private var scrim: some View {
        SnapListColorToken.scrimOverlay.color
            .opacity(ScanDrawerMetrics.scrimOpacity)
            .ignoresSafeArea()
            .contentShape(.rect)
            .onTapGesture(perform: dismiss)
            .accessibilityHidden(true)
    }

    private func card(_ layout: ScanDrawerLayout) -> some View {
        let height = layout.drawerHeight
        return content()
            // Padding for what respects the safe area — the camera's controls,
            // Photo Review's header and action bar — while the preview, which
            // ignores it, still fills the card edge to edge.
            .safeAreaPadding(layout.contentInsets)
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
            // The drawer's own marker, applied outside the clip. A 1x1 point
            // at the card's top-left corner is exactly what a 28pt corner
            // radius clips away, and a clipped view never reaches the
            // accessibility tree — the drawer rendered correctly and was
            // simply unnameable. Centred on the top edge instead, so its
            // frame still reports where the drawer starts.
            .overlay(alignment: .top) {
                Color.clear
                    .frame(width: 1, height: 1)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Scan drawer")
                    .accessibilityIdentifier("scan.drawer")
            }
            .offset(y: ScanDrawerDragPolicy.offset(forTranslation: dragTranslation))
            // No `.isModal` here: the card is not an accessibility element,
            // so the trait lands on every element inside it — each one a
            // modal of its own. The shell takes the wall and the dock out of
            // the tree instead, which leaves the drawer the only thing that
            // answers. VoiceOver's and the keyboard's escape gesture close
            // the drawer, the same promise the close control and the swipe
            // make.
            .accessibilityAction(.escape, dismiss)
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
                // grabber disappears against the first. With Reduce
                // Transparency on it falls back to the opaque drag-handle
                // grey, which still reads against both — the canvas token the
                // dock falls back to is the card itself under Photo Review.
                Group {
                    if reduceTransparency {
                        Capsule().fill(SnapListColorToken.dragHandle.color)
                    } else {
                        Capsule().fill(.regularMaterial)
                    }
                }
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
                    velocity: value.velocity.height,
                    drawerHeight: drawerHeight
                )
                dragTranslation = 0
                guard outcome == .dismiss else { return }
                dismiss()
            }
    }
}
