import SwiftUI

// MARK: - Targets

/// The one control each tour step points at.
///
/// #1056 made this a dimming cutout that swallowed every touch outside it.
/// #1133 retires that: the control now glows where it stands, nothing is
/// dimmed, and every other control on the screen keeps working. What survives
/// is the seam — a control publishes its own frame and its own action, and the
/// shell draws the halo from that frame rather than from a coordinate anyone
/// wrote down.
enum ActivationSpotlightTarget: String, Equatable, Hashable, CaseIterable {
    /// The control that opens Scan, wherever the shell puts it. Named for the
    /// job rather than for the dock, so the tour keeps pointing at the right
    /// thing when the camera entry moves.
    case scanEntry
    case scanShutter
    /// Step three names the voice note but points here: Start listing is the
    /// tap that actually moves the item on.
    case photoReviewStartListing
    case trophyWallReadyItem
    case listingReviewPrice
    case listingReviewPublish

    /// What VoiceOver reads for the control, used by the guidance element when
    /// a control has published an action of its own.
    var accessibilityLabel: String {
        switch self {
        case .scanEntry: "Scan an item"
        case .scanShutter: "Take photo"
        case .photoReviewStartListing: "Start listing"
        case .trophyWallReadyItem: "Ready item"
        case .listingReviewPrice: "Price"
        case .listingReviewPublish: "Publish to eBay"
        }
    }

    /// Whether the control is drawn as a circle. The halo takes the control's
    /// own shape, so a round shutter never gets a rounded-rectangle glow.
    var isRound: Bool {
        switch self {
        case .scanShutter, .scanEntry: true
        case .photoReviewStartListing, .trophyWallReadyItem,
             .listingReviewPrice, .listingReviewPublish: false
        }
    }

    /// Whether the control breathes while it is spotlit. A button can; a text
    /// field the seller may be typing in holds still.
    var breathes: Bool {
        switch self {
        case .scanShutter, .scanEntry, .photoReviewStartListing,
             .trophyWallReadyItem, .listingReviewPublish: true
        case .listingReviewPrice: false
        }
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

/// Lets a spotlit control publish the action VoiceOver should perform on its
/// behalf. A control with no action of its own simply registers none.
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
    // an isolated type has to be isolated too.
    @MainActor
    static let defaultValue = ActivationSpotlightActionRegistry()
}

/// Which control the tour is pointing at right now, published down the tree so
/// the control itself can breathe. The halo is drawn by the shell from this
/// same target's anchor, so the two can never point at different things.
private struct ActivationSpotlightActiveTargetKey: EnvironmentKey {
    static let defaultValue: ActivationSpotlightTarget? = nil
}

extension EnvironmentValues {
    var activationSpotlightActions: ActivationSpotlightActionRegistry {
        get { self[ActivationSpotlightActionRegistryKey.self] }
        set { self[ActivationSpotlightActionRegistryKey.self] = newValue }
    }

    var activationSpotlightActiveTarget: ActivationSpotlightTarget? {
        get { self[ActivationSpotlightActiveTargetKey.self] }
        set { self[ActivationSpotlightActiveTargetKey.self] = newValue }
    }
}

private struct ActivationSpotlightTargetModifier: ViewModifier {
    let target: ActivationSpotlightTarget
    let action: (() -> Void)?
    @Environment(\.activationSpotlightActions)
    private var registry: ActivationSpotlightActionRegistry
    @Environment(\.activationSpotlightActiveTarget)
    private var activeTarget: ActivationSpotlightTarget?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isBreathing = false

    private var isSpotlit: Bool { activeTarget == target }

    func body(content: Content) -> some View {
        content
            // The anchor is read inside the scale, so the frame the halo is
            // drawn from is the control's layout frame rather than one that
            // breathes with it — otherwise the glow would chase itself.
            .anchorPreference(
                key: ActivationSpotlightTargetPreferenceKey.self,
                value: .bounds
            ) { [target: $0] }
            .onAppear {
                if let action { registry.register(target, action: action) }
                updateBreathing()
            }
            .onDisappear { registry.unregister(target) }
            .accessibilityHint(
                isSpotlit ? "The guide is pointing at this." : ""
            )
            .scaleEffect(isBreathing ? 1.03 : 1)
            .onChange(of: isSpotlit) { _, _ in updateBreathing() }
            .onChange(of: reduceMotion) { _, _ in updateBreathing() }
    }

    /// Reduced Motion keeps the halo and drops the breathing.
    private func updateBreathing() {
        guard isSpotlit, target.breathes, !reduceMotion else {
            withAnimation(.easeOut(duration: 0.2)) { isBreathing = false }
            return
        }
        withAnimation(.easeInOut(duration: 1.8).repeatForever(autoreverses: true)) {
            isBreathing = true
        }
    }
}

/// A grid cell or row only carries the anchor when it is *the* one the tour
/// means — the first ready item on the wall, say — so the target arrives
/// optional and an absent one attaches nothing.
private struct ActivationSpotlightOptionalTargetModifier: ViewModifier {
    let target: ActivationSpotlightTarget?
    let action: (() -> Void)?

    @ViewBuilder
    func body(content: Content) -> some View {
        if let target {
            content.modifier(
                ActivationSpotlightTargetModifier(
                    target: target,
                    action: action
                )
            )
        } else {
            content
        }
    }
}

extension View {
    /// Marks this view as the control a tour step points at. `action` is only
    /// read by the accessibility path; direct touches always reach the real
    /// control, because the tour never puts anything in front of it.
    func activationSpotlightTarget(
        _ target: ActivationSpotlightTarget?,
        action: (() -> Void)? = nil
    ) -> some View {
        modifier(
            ActivationSpotlightOptionalTargetModifier(
                target: target,
                action: action
            )
        )
    }
}
