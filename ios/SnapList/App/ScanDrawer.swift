import SwiftUI
import UIKit

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
    /// Space for the grabber above the drawer's content.
    static let grabHandleBandHeight: CGFloat = 32
    /// Photo Review fills the screen, so its grabber sits in a slimmer band
    /// under the status bar rather than above a card edge.
    static let expandedGrabHandleBandHeight: CGFloat = 14
}

/// Where the drawer sits, derived from what a GeometryReader reports: the
/// safe-area size and the insets around it. Pure so the device geometry the
/// drawer has to honour is assertable without rendering one.
///
/// The camera is a popup over the wall; Photo Review, once there are photos
/// to review, is `isExpanded`: the full screen, with the status bar handed to
/// its content as an inset (owner-approved recommendation, #1156 follow-up).
struct ScanDrawerLayout: Equatable {
    let drawerHeight: CGFloat
    let contentInsets: EdgeInsets
    let cornerRadius: CGFloat
    /// The visible strip the grabber is centred in, below any status bar.
    let grabberBandHeight: CGFloat

    init(
        safeAreaSize: CGSize,
        safeAreaInsets: EdgeInsets,
        isExpanded: Bool = false
    ) {
        let screenHeight = safeAreaSize.height
            + safeAreaInsets.top
            + safeAreaInsets.bottom
        drawerHeight = isExpanded
            ? screenHeight
            : screenHeight * ScanDrawerMetrics.heightFraction
        grabberBandHeight = isExpanded
            ? ScanDrawerMetrics.expandedGrabHandleBandHeight
            : ScanDrawerMetrics.grabHandleBandHeight
        contentInsets = EdgeInsets(
            top: isExpanded
                ? safeAreaInsets.top + grabberBandHeight
                : grabberBandHeight,
            leading: safeAreaInsets.leading,
            bottom: safeAreaInsets.bottom,
            trailing: safeAreaInsets.trailing
        )
        cornerRadius = isExpanded ? 0 : ScanDrawerMetrics.cornerRadius
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
    static let announcement = "Item added to To list. Analysing."
}

/// Raised by drawer content while a drawer of its own is open over it, such
/// as the voice note over Photo Review. The open child is the active drawer:
/// its swipe moves only it, so the Scan drawer stops answering drags, its
/// grabber and its scrim until the child closes.
struct ScanDrawerNestedDrawerKey: PreferenceKey {
    static let defaultValue = false

    static func reduce(value: inout Bool, nextValue: () -> Bool) {
        value = value || nextValue()
    }
}

extension View {
    func scanDrawerYieldsDrag(to nestedDrawerIsOpen: Bool) -> some View {
        preference(key: ScanDrawerNestedDrawerKey.self, value: nestedDrawerIsOpen)
    }
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
    /// Photo Review rather than the camera: the drawer fills the screen.
    var isExpanded = false
    let reduceMotion: Bool
    let dismiss: () -> Void
    @ViewBuilder let content: () -> Content

    @State private var dragTranslation: CGFloat = 0
    @State private var revealProgress: CGFloat = 0
    @State private var nestedDrawerIsOpen = false
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
                safeAreaInsets: safeArea.safeAreaInsets,
                isExpanded: isExpanded
            )

            GeometryReader { _ in
                ZStack(alignment: .bottom) {
                    if isPresented {
                        scrim
                            .transition(.opacity)
                        card(layout)
                            // Animate an already-mounted card. A transition
                            // inside nested geometry readers can insert at its
                            // final position even with an animated transaction.
                            .offset(y: reduceMotion ? 0 : layout.drawerHeight * (1 - revealProgress))
                            .opacity(reduceMotion ? revealProgress : 1)
                            .onAppear {
                                withAnimation(ScanDrawerMotionPolicy.presentationAnimation(
                                    reduceMotion: reduceMotion
                                )) { revealProgress = 1 }
                            }
                            .onDisappear {
                                revealProgress = 0
                                dragTranslation = 0
                            }
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
        .animation(
            ScanDrawerMotionPolicy.presentationAnimation(reduceMotion: reduceMotion),
            value: isExpanded
        )
    }

    private var scrim: some View {
        SnapListColorToken.scrimOverlay.color
            .opacity(ScanDrawerMetrics.scrimOpacity)
            .ignoresSafeArea()
            .contentShape(.rect)
            .onTapGesture {
                guard !nestedDrawerIsOpen else { return }
                dismiss()
            }
            .accessibilityHidden(true)
    }

    private func card(_ layout: ScanDrawerLayout) -> some View {
        let height = layout.drawerHeight
        return content()
            .onPreferenceChange(ScanDrawerNestedDrawerKey.self) { isOpen in
                nestedDrawerIsOpen = isOpen
            }
            // Padding for what respects the safe area — the camera's controls,
            // Photo Review's header and action bar — while the preview, which
            // ignores it, still fills the card edge to edge.
            .safeAreaPadding(layout.contentInsets)
            .frame(maxWidth: .infinity)
            .frame(height: height)
            .background(SnapListColorToken.canvas.color)
            .clipShape(
                UnevenRoundedRectangle(
                    topLeadingRadius: layout.cornerRadius,
                    bottomLeadingRadius: 0,
                    bottomTrailingRadius: 0,
                    topTrailingRadius: layout.cornerRadius,
                    style: .continuous
                )
            )
            .overlay(alignment: .top) { grabHandle(layout) }
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
            .modifier(DownwardDragPanModifier(
                isEnabled: !nestedDrawerIsOpen,
                changed: { dragTranslation = $0 },
                ended: { translation, velocity in
                    let outcome = ScanDrawerDragPolicy.outcome(
                        translation: translation,
                        velocity: velocity,
                        drawerHeight: height
                    )
                    if outcome == .dismiss {
                        // Keep the finger's offset while the removal transition
                        // runs; resetting first makes the card jump back up.
                        dismiss()
                    } else {
                        withAnimation(ScanDrawerMotionPolicy.presentationAnimation(
                            reduceMotion: reduceMotion
                        )) { dragTranslation = 0 }
                    }
                }
            ))
    }

    /// The grabber marks the same downward gesture available on the card.
    /// Expanded, the touch band reaches up through the status bar while the
    /// capsule stays in the visible strip below it.
    @ViewBuilder
    private func grabHandle(_ layout: ScanDrawerLayout) -> some View {
        let drawerHeight = layout.drawerHeight
        let handle = Color.clear
            .frame(height: layout.contentInsets.top)
            .frame(maxWidth: .infinity)
            .contentShape(.rect)
            .overlay(alignment: .bottom) {
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
                .frame(height: layout.grabberBandHeight)
            }
            .accessibilityHidden(true)
            // A nested drawer owns the drag; its scrim takes the touch.
            .allowsHitTesting(!nestedDrawerIsOpen)
        if #available(iOS 18, *) {
            handle
        } else {
            // Older SwiftUI has no native recognizer bridge. Retain the
            // grabber gesture rather than taking a nested scroll's touches.
            handle.gesture(DragGesture(minimumDistance: 4)
                .onChanged { dragTranslation = $0.translation.height }
                .onEnded { value in
                    if ScanDrawerDragPolicy.outcome(
                        translation: value.translation.height,
                        velocity: value.velocity.height,
                        drawerHeight: drawerHeight
                    ) == .dismiss {
                        dismiss()
                    } else {
                        withAnimation(ScanDrawerMotionPolicy.presentationAnimation(
                            reduceMotion: reduceMotion
                        )) { dragTranslation = 0 }
                    }
                })
        }
    }
}

/// The downward drag a drawer follows: the Scan drawer's card and the voice
/// note over Photo Review both take theirs from here. `isEnabled` false
/// leaves the touch to whatever else is under the finger; turning it off
/// mid-drag cancels the drag, which settles the drawer back where it was.
struct DownwardDragPanModifier: ViewModifier {
    var isEnabled = true
    let changed: (CGFloat) -> Void
    let ended: (CGFloat, CGFloat) -> Void

    func body(content: Content) -> some View {
        if #available(iOS 18, *) {
            content.gesture(DownwardDragPan(
                isEnabled: isEnabled,
                changed: changed,
                ended: ended
            ))
        } else {
            content
        }
    }
}

/// UIKit's pan primitive lets nested scrollers and native text editing keep
/// their gestures. Only a downward, vertical drag at a scroller's top can
/// move the drawer; horizontal photo paging and thumbnail reordering retain
/// their existing recognizers.
@available(iOS 18, *)
private struct DownwardDragPan: UIGestureRecognizerRepresentable {
    let isEnabled: Bool
    let changed: (CGFloat) -> Void
    let ended: (CGFloat, CGFloat) -> Void

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator {
        Coordinator()
    }

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let pan = UIPanGestureRecognizer()
        pan.maximumNumberOfTouches = 1
        pan.cancelsTouchesInView = false
        pan.delegate = context.coordinator
        pan.isEnabled = isEnabled
        return pan
    }

    func updateUIGestureRecognizer(_ pan: UIPanGestureRecognizer, context: Context) {
        if pan.isEnabled != isEnabled {
            pan.isEnabled = isEnabled
        }
    }

    func handleUIGestureRecognizerAction(_ pan: UIPanGestureRecognizer, context: Context) {
        let translation = pan.translation(in: pan.view).y
        switch pan.state {
        case .began, .changed:
            changed(ScanDrawerDragPolicy.offset(forTranslation: translation))
        case .ended:
            ended(translation, pan.velocity(in: pan.view).y)
        case .cancelled, .failed:
            ended(0, 0)
        default:
            break
        }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        private var scrollViews: [UIScrollView] = []

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                               shouldReceive touch: UITouch) -> Bool {
            scrollViews = []
            var view = touch.view
            while let current = view {
                // Native text selection/editing and drag-and-drop belong to
                // the touched control, including an unsaved voice-note editor.
                if current is UITextView || current is UIControl
                    || current.interactions.contains(where: { $0 is UIDragInteraction }) {
                    return false
                }
                if let scroll = current as? UIScrollView, scroll.isScrollEnabled {
                    scrollViews.append(scroll)
                }
                view = current.superview
            }
            return true
        }

        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return false }
            let velocity = pan.velocity(in: pan.view)
            guard velocity.y > abs(velocity.x) else { return false }
            return scrollViews.allSatisfy { scroll in
                scroll.contentOffset.y <= -scroll.adjustedContentInset.top + 1
            }
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
            true
        }
    }
}
