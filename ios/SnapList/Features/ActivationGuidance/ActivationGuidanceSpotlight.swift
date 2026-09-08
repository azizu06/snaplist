import SwiftUI
import UIKit

// MARK: - Targets

/// The one control each coach mark names. #1056 turns activation guidance from
/// a floating bubble into a spotlight: the surface is dimmed, the named control
/// keeps working, and everything else — including tab switches and pushes — is
/// swallowed until the seller acts or taps Got it.
enum ActivationSpotlightTarget: String, Equatable, Hashable, CaseIterable {
    case scanShutter
    case photoReviewThumbnailStrip
    case photoReviewVoiceNote
    case trophyWallProcessing
    case settingsMarketplaces
    /// The editable body of Listing Review. ACT-04's line names every field
    /// rather than one control, so the whole form is the target: the scrim
    /// still swallows the back button and the dock, and the fields the line
    /// invites the seller to change keep working.
    case listingReviewForm

    /// What VoiceOver reads for the spotlit control. While a mark is up the rest
    /// of the screen leaves the accessibility tree, so this element stands in
    /// for the control underneath and performs its action when one is
    /// registered.
    var accessibilityLabel: String {
        switch self {
        case .scanShutter: "Take photo"
        case .photoReviewThumbnailStrip: "Photos"
        case .photoReviewVoiceNote: "Voice note"
        case .trophyWallProcessing: "Processing"
        case .settingsMarketplaces: "Connected marketplaces"
        case .listingReviewForm: "Listing details"
        }
    }

    /// Whether one accessibility element can stand in for everything inside the
    /// cutout. It can for a single control; it cannot for Listing Review's
    /// form, where the hole holds every editable field. That difference decides
    /// whether the surface behind the mark leaves the accessibility tree: a
    /// stand-in replaces one button honestly, but nothing can replace a form.
    var standsInForOneControl: Bool {
        switch self {
        case .scanShutter, .photoReviewThumbnailStrip, .photoReviewVoiceNote,
             .trophyWallProcessing, .settingsMarketplaces:
            true
        case .listingReviewForm:
            false
        }
    }
}

/// How much of the surface a mark takes over.
enum ActivationSpotlightMode: Equatable {
    /// Dim the surface and cut a hole over one named control.
    case spotlight(ActivationSpotlightTarget)
    /// Dim the surface with no hole. For a mark that states something rather
    /// than asking for an action, so Got it is the only way on.
    case dim

    /// Whether the bubble has a control to point at. The approved composition
    /// gives every bubble a tail, but a `.dim` mark names no control, so its
    /// tail aims at empty surface and reads as a rendering fault (#1056
    /// review). Only that mode drops it; every spotlight keeps its tail.
    var pointsAtAControl: Bool {
        if case .dim = self { return false }
        return true
    }
}

enum ActivationSpotlightTargetPolicy {
    static func mode(for coachMark: ActivationCoachMark) -> ActivationSpotlightMode {
        switch coachMark {
        case .act01, .act06: .spotlight(.scanShutter)
        case .act02: .spotlight(.photoReviewThumbnailStrip)
        case .act02B: .spotlight(.photoReviewVoiceNote)
        // "Work continues after you leave" names no control.
        case .act03: .dim
        // "Every field here is yours to change" names all of them, so the
        // whole editable form is the hole.
        case .act04: .spotlight(.listingReviewForm)
        case .act08: .spotlight(.trophyWallProcessing)
        case .act09: .spotlight(.settingsMarketplaces)
        }
    }

    static func target(
        for coachMark: ActivationCoachMark
    ) -> ActivationSpotlightTarget? {
        guard case .spotlight(let target) = mode(for: coachMark) else {
            return nil
        }
        return target
    }
}

// MARK: - Geometry

enum ActivationSpotlightGeometry {
    /// The breathing room between the control and the edge of the cutout.
    static let cutoutPadding: CGFloat = 8
    static let maximumCornerRadius: CGFloat = 14

    static func cutout(
        around frame: CGRect,
        padding: CGFloat = cutoutPadding,
        in bounds: CGRect
    ) -> CGRect? {
        guard !frame.isEmpty, !bounds.isEmpty else { return nil }
        let clamped = frame.insetBy(dx: -padding, dy: -padding)
            .intersection(bounds)
        guard !clamped.isNull, !clamped.isEmpty else { return nil }
        return clamped
    }

    static func cornerRadius(for cutout: CGRect) -> CGFloat {
        min(maximumCornerRadius, min(cutout.width, cutout.height) / 2)
    }
}

// MARK: - Presentation

enum ActivationSpotlightPresentation: Equatable {
    /// No mark to draw.
    case hidden
    /// The mark draws its bubble and blocks nothing, because it names a
    /// control that has not reported a frame yet — the view has not laid out,
    /// or the control is off screen. Failing open on a missing frame is
    /// deliberate: a scrim with no hole over the control a seller is being told
    /// to use would strand them.
    case unanchored
    /// Blocking. `cutout` is nil for a mark that names no control.
    case spotlight(cutout: CGRect?)

    var isBlocking: Bool {
        if case .spotlight = self { return true }
        return false
    }

    var cutout: CGRect? {
        guard case .spotlight(let cutout) = self else { return nil }
        return cutout
    }
}

enum ActivationSpotlightPolicy {
    static func presentation(
        for coachMark: ActivationCoachMark?,
        targetFrame: CGRect?,
        bounds: CGRect
    ) -> ActivationSpotlightPresentation {
        guard let coachMark else { return .hidden }
        switch ActivationSpotlightTargetPolicy.mode(for: coachMark) {
        case .dim:
            return .spotlight(cutout: nil)
        case .spotlight:
            guard let targetFrame,
                  let cutout = ActivationSpotlightGeometry.cutout(
                    around: targetFrame,
                    in: bounds
                  ) else { return .unanchored }
            return .spotlight(cutout: cutout)
        }
    }
}

/// Whether the surface behind a mark leaves the accessibility tree.
///
/// Two conditions have to hold together. The mark must actually be blocking —
/// an unanchored mark blocks nothing, so hiding the screen under it would
/// strand VoiceOver on a bubble with no way back. And the cutout must be
/// something a single stand-in element can honestly replace; Listing Review's
/// whole form is not, so that mark leaves the surface reachable.
///
/// The same answer governs the scrim's stand-in element, so the two can never
/// disagree: the surface is hidden exactly when something replaces it.
enum ActivationSpotlightAccessibilityPolicy {
    static func hidesSurface(
        for coachMark: ActivationCoachMark?,
        anchoredTargets: Set<ActivationSpotlightTarget>
    ) -> Bool {
        guard let coachMark else { return false }
        switch ActivationSpotlightTargetPolicy.mode(for: coachMark) {
        case .dim:
            // Nothing to reach through the scrim; Got it is the only way on.
            return true
        case .spotlight(let target):
            guard anchoredTargets.contains(target) else { return false }
            return target.standsInForOneControl
        }
    }
}

// MARK: - Hit testing

enum ActivationSpotlightHitOutcome: Equatable {
    /// The touch reaches whatever is underneath — the real control, or the
    /// coach mark's own Got it button.
    case passesThrough
    /// The touch stops here. This is what blocks tab switches and pushes.
    case swallowed
}

enum ActivationSpotlightHitTestPolicy {
    static func outcome(
        for point: CGPoint,
        cutout: CGRect?,
        dismiss: CGRect?
    ) -> ActivationSpotlightHitOutcome {
        if let cutout, cutout.contains(point) { return .passesThrough }
        if let dismiss, dismiss.contains(point) { return .passesThrough }
        return .swallowed
    }
}

// MARK: - Bubble placement

/// Where the bubble sits when the mark is anchored to a cutout rather than to
/// the bottom of the screen. Exactly one inset is set; the other is nil.
struct ActivationSpotlightBubblePlacement: Equatable {
    let tailEdge: ActivationCoachMarkTailEdge
    let topInset: CGFloat?
    let bottomInset: CGFloat?
    let tailHorizontalOffset: CGFloat
}

enum ActivationSpotlightBubblePlacementPolicy {
    static let cutoutGap: CGFloat = 12
    /// How far the tail stays from the bubble's own rounded corners.
    static let tailCornerInset: CGFloat = 28

    static func placement(
        cutout: CGRect,
        bounds: CGRect,
        horizontalPadding: CGFloat
    ) -> ActivationSpotlightBubblePlacement {
        let offsetLimit = max(
            0,
            bounds.width / 2 - horizontalPadding - tailCornerInset
        )
        let tailHorizontalOffset = min(
            max(cutout.midX - bounds.midX, -offsetLimit),
            offsetLimit
        )

        // A control in the top half of the screen has room below it, so the
        // bubble hangs under the cutout and points up at it. A control in the
        // bottom half takes the band above.
        if cutout.midY < bounds.midY {
            return .init(
                tailEdge: .top,
                topInset: max(0, cutout.maxY - bounds.minY + cutoutGap),
                bottomInset: nil,
                tailHorizontalOffset: tailHorizontalOffset
            )
        }
        return .init(
            tailEdge: .bottom,
            topInset: nil,
            bottomInset: max(0, bounds.maxY - cutout.minY + cutoutGap),
            tailHorizontalOffset: tailHorizontalOffset
        )
    }
}

// MARK: - Frame collection

struct ActivationSpotlightTargetPreferenceKey: PreferenceKey {
    static var defaultValue: [ActivationSpotlightTarget: Anchor<CGRect>] { [:] }

    static func reduce(
        value: inout [ActivationSpotlightTarget: Anchor<CGRect>],
        nextValue: () -> [ActivationSpotlightTarget: Anchor<CGRect>]
    ) {
        value.merge(nextValue()) { _, latest in latest }
    }
}

/// Which spotlight targets are on screen and have reported a frame. The anchor
/// preference above cannot be observed with `onPreferenceChange` — `Anchor` is
/// only resolvable inside a `GeometryProxy` — so this plain, comparable set
/// carries the same fact out to the root, where the accessibility decision is
/// made before any geometry is available.
struct ActivationSpotlightAnchoredTargetsKey: PreferenceKey {
    static var defaultValue: Set<ActivationSpotlightTarget> { [] }

    static func reduce(
        value: inout Set<ActivationSpotlightTarget>,
        nextValue: () -> Set<ActivationSpotlightTarget>
    ) {
        value.formUnion(nextValue())
    }
}

/// The bubble's own frame in the overlay's coordinate space. The touch gate
/// needs it so Got it stays reachable through the scrim.
struct ActivationBubbleFramePreferenceKey: PreferenceKey {
    static var defaultValue: CGRect? { nil }

    static func reduce(value: inout CGRect?, nextValue: () -> CGRect?) {
        value = nextValue() ?? value
    }
}

/// Lets a spotlit control publish the action VoiceOver should perform on its
/// behalf while the rest of the screen is out of the accessibility tree. A
/// control with no action of its own (a plain value row) simply registers none.
@MainActor
@Observable
final class ActivationSpotlightActionRegistry {
    private var actions: [ActivationSpotlightTarget: () -> Void] = [:]

    func register(
        _ target: ActivationSpotlightTarget,
        action: @escaping () -> Void
    ) {
        actions[target] = action
    }

    func unregister(_ target: ActivationSpotlightTarget) {
        actions[target] = nil
    }

    @discardableResult
    func perform(_ target: ActivationSpotlightTarget) -> Bool {
        guard let action = actions[target] else { return false }
        action()
        return true
    }
}

private struct ActivationSpotlightActionRegistryKey: EnvironmentKey {
    // The isolation is on the default value, not the key: the registry itself
    // is `@MainActor` because view lifecycle writes to it, and a static let of
    // an isolated type has to be isolated too. The other environment keys in
    // this app default to types with no isolation, so they need none.
    @MainActor
    static let defaultValue = ActivationSpotlightActionRegistry()
}

extension EnvironmentValues {
    var activationSpotlightActions: ActivationSpotlightActionRegistry {
        get { self[ActivationSpotlightActionRegistryKey.self] }
        set { self[ActivationSpotlightActionRegistryKey.self] = newValue }
    }
}

private struct ActivationSpotlightTargetModifier: ViewModifier {
    let target: ActivationSpotlightTarget
    let action: (() -> Void)?
    @Environment(\.activationSpotlightActions)
    private var registry: ActivationSpotlightActionRegistry

    func body(content: Content) -> some View {
        content
            .anchorPreference(
                key: ActivationSpotlightTargetPreferenceKey.self,
                value: .bounds
            ) { [target: $0] }
            .preference(
                key: ActivationSpotlightAnchoredTargetsKey.self,
                value: [target]
            )
            .onAppear {
                guard let action else { return }
                registry.register(target, action: action)
            }
            .onDisappear { registry.unregister(target) }
    }
}

extension View {
    /// Marks this view as the control a coach mark spotlights. `action` is only
    /// read by the accessibility stand-in; direct touches reach the real
    /// control through the cutout.
    func activationSpotlightTarget(
        _ target: ActivationSpotlightTarget,
        action: (() -> Void)? = nil
    ) -> some View {
        modifier(
            ActivationSpotlightTargetModifier(target: target, action: action)
        )
    }
}

// MARK: - The scrim

/// Swallows every touch except the ones the policy lets through. This is a
/// `UIView` because SwiftUI's hit testing is all-or-nothing per view: the
/// cutout has to fall through to the real control underneath, which only
/// `hitTest` returning nil can do.
private struct ActivationSpotlightTouchGate: UIViewRepresentable {
    let cutout: CGRect?
    let dismiss: CGRect?
    let targetTouched: () -> Void

    func makeUIView(context: Context) -> GateView {
        let view = GateView()
        view.backgroundColor = .clear
        return view
    }

    func updateUIView(_ view: GateView, context: Context) {
        view.cutout = cutout
        view.dismiss = dismiss
        view.targetTouched = targetTouched
    }

    final class GateView: UIView {
        var cutout: CGRect?
        var dismiss: CGRect?
        var targetTouched: () -> Void = {}

        override func hitTest(
            _ point: CGPoint,
            with event: UIEvent?
        ) -> UIView? {
            switch ActivationSpotlightHitTestPolicy.outcome(
                for: point,
                cutout: cutout,
                dismiss: dismiss
            ) {
            case .passesThrough:
                // Reporting on the way down, not on touch-up, because the gate
                // never receives the touch it is letting through. Acknowledging
                // a mark is idempotent, so a repeated hit test costs nothing.
                if let cutout, cutout.contains(point) { targetTouched() }
                return nil
            case .swallowed:
                return self
            }
        }
    }
}

struct ActivationSpotlightScrim: View {
    let coachMark: ActivationCoachMark
    let cutout: CGRect?
    let dismissFrame: CGRect?
    let reduceMotion: Bool
    let targetTouched: () -> Void
    @Environment(\.activationSpotlightActions)
    private var registry: ActivationSpotlightActionRegistry

    private var target: ActivationSpotlightTarget? {
        ActivationSpotlightTargetPolicy.target(for: coachMark)
    }

    var body: some View {
        ZStack {
            scrim
                .accessibilityHidden(true)

            ActivationSpotlightTouchGate(
                cutout: cutout,
                dismiss: dismissFrame,
                targetTouched: targetTouched
            )

            if let cutout, let target, target.standsInForOneControl {
                // The accessibility stand-in for the spotlit control. It exists
                // only when the surface behind it is hidden; a cutout the
                // seller can still reach for real needs no stand-in.
                Color.clear
                    .frame(width: cutout.width, height: cutout.height)
                    .position(x: cutout.midX, y: cutout.midY)
                    .accessibilityElement()
                    .accessibilityLabel(target.accessibilityLabel)
                    .accessibilityAddTraits(.isButton)
                    .accessibilityIdentifier("activation-guidance.spotlight")
                    .accessibilityAction {
                        // A direct touch runs the real control and the mark
                        // reacts to it; VoiceOver cannot reach through the
                        // cutout, so the stand-in runs the registered action
                        // itself. A control with no action — a plain value row
                        // that pushes a destination — still retires the mark,
                        // which returns the real row to the accessibility
                        // tree so it can be opened for real.
                        registry.perform(target)
                        targetTouched()
                    }
            }
        }
    }

    /// `destinationOut` inside a compositing group is what punches the hole:
    /// the cutout shape erases the dim instead of drawing over it, so the real
    /// control underneath is seen at full brightness.
    private var scrim: some View {
        Rectangle()
            .fill(scrimColor)
            .overlay {
                if let cutout {
                    RoundedRectangle(
                        cornerRadius: ActivationSpotlightGeometry
                            .cornerRadius(for: cutout),
                        style: .continuous
                    )
                    .frame(width: cutout.width, height: cutout.height)
                    .position(x: cutout.midX, y: cutout.midY)
                    .blendMode(.destinationOut)
                }
            }
            .compositingGroup()
            .animation(
                reduceMotion ? nil : .easeOut(duration: 0.18),
                value: cutout
            )
    }

    /// The dark camera surfaces are already dark, so they take a lighter dim
    /// than the paper surfaces do.
    private var scrimColor: Color {
        Color.black.opacity(coachMark.isDarkSurface ? 0.42 : 0.55)
    }
}
