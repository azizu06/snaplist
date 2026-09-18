import SwiftUI

enum FloatingDockMetrics {
    static let destinationWidth: CGFloat = 52
    static let destinationSpacing: CGFloat = 6
    static let contentPadding: CGFloat = 6
    static let cornerRadius: CGFloat = 22

    static func destinationHeight(for _: PrimaryTab) -> CGFloat {
        52
    }

    static func bottomInset(for _: PrimaryTab) -> CGFloat {
        0
    }

    static func containerHeight(for selectedTab: PrimaryTab) -> CGFloat {
        destinationHeight(for: selectedTab)
            + (contentPadding * 2)
            + bottomInset(for: selectedTab)
    }
}

/// #1049: how far, and how, downward Trophy Wall scroll shrinks the dock.
/// A pure function of offset (not a direction/velocity state machine) so
/// "scroll up restores" and "scroll-to-top ends at full scale" hold by
/// construction rather than needing separate tracking.
enum DockScrollScalePolicy {
    static let fullScale: CGFloat = 1.0
    /// The issue's illustrative floor (0.72) would shrink the dock's 52pt
    /// destinations to 37.4pt, under Apple's 44pt minimum touch target.
    /// 0.85 keeps both destination dimensions at 44.2pt (52 * 0.85) while
    /// still reading as a clear Instagram-style shrink.
    static let floorScale: CGFloat = 0.85
    static let travelPoints: CGFloat = 120

    /// `downwardOffset` is the scroll surface's content offset measured from
    /// the top: 0 (or negative, during top overscroll) at rest, increasing as
    /// the seller scrolls down.
    static func scale(forDownwardOffset downwardOffset: CGFloat, reduceMotion: Bool) -> CGFloat {
        let clampedOffset = min(max(downwardOffset, 0), travelPoints)
        guard !reduceMotion else {
            return clampedOffset > 0 ? floorScale : fullScale
        }
        let progress = clampedOffset / travelPoints
        return fullScale - progress * (fullScale - floorScale)
    }
}

/// #1059: gates the implicit `.animation` SwiftUI applies to the glass-wrapped
/// dock row's layout/tint changes on selection. That live animation only
/// exists in the iOS 26 view tree, so this pure seam is what the Reduced
/// Motion acceptance criterion actually asserts against.
enum DockGlassMotionPolicy {
    static func shouldAnimateSelectionMorph(reduceMotion: Bool) -> Bool {
        !reduceMotion
    }
}

/// Shared between the Trophy Wall scroll surface (which reports offset) and
/// the dock composition in `AppShellView` (which reads `scale`). Delivered
/// through the environment, defaulted to a standalone instance, so neither
/// side needs threading through every intermediate view's initializer.
@Observable
final class DockScrollScaleModel {
    private(set) var scale: CGFloat = DockScrollScalePolicy.fullScale

    func reportDownwardScrollOffset(_ offset: CGFloat, reduceMotion: Bool) {
        scale = DockScrollScalePolicy.scale(forDownwardOffset: offset, reduceMotion: reduceMotion)
    }
}

private struct DockScrollScaleModelKey: EnvironmentKey {
    static let defaultValue = DockScrollScaleModel()
}

extension EnvironmentValues {
    var dockScrollScale: DockScrollScaleModel {
        get { self[DockScrollScaleModelKey.self] }
        set { self[DockScrollScaleModelKey.self] = newValue }
    }
}

/// The one approved dock: exactly the two primary destinations, rendered the
/// same way on every screen that shows it. It iterates `PrimaryTab` rather than
/// a parallel dock enum so a destination cannot exist in one list and not the
/// other.
struct FloatingDock: View {
    let selectedTab: PrimaryTab
    var scale: CGFloat = DockScrollScalePolicy.fullScale
    let select: (PrimaryTab) -> Void

    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion

    var body: some View {
        Group {
            if #available(iOS 26.0, *) {
                glassBody
            } else {
                legacyBody
            }
        }
        // `.scaleEffect` stays the outermost modifier, wrapping the whole
        // composed `GlassEffectContainer` rather than an individual glass
        // view inside it: scaling a glass view in place while it is still
        // compositing would have it resample its own already-blurred output
        // every scroll frame. Scaling the finished container instead just
        // resizes the rendered result once per frame.
        .scaleEffect(scale, anchor: .bottom)
    }

    /// `.glassEffect` is applied straight to the icon row's own content
    /// (background is its documented contract: the row's foreground still
    /// renders on top), never to a separately-sized decoy view. A decoy — a
    /// bare `Color.clear` carrying the glass as a `.background`, or a second
    /// glass shape nested per-button for the selection highlight — measurably
    /// breaks that contract on-device: `GlassEffectContainer` composites every
    /// `.glassEffect` descendant into one shared pass, and once two glass
    /// shapes overlap in that pass (the bar's plus a per-button pill), the
    /// icons sitting "on top of" either one get swallowed into the merge
    /// instead of surviving as sharp foreground content. So the selected tab
    /// keeps the pre-#1059 tinted **fill** for its highlight rather than a
    /// second glass shape — the issue names this as an equally acceptable
    /// choice ("whichever reads better"), and it sidesteps the bug entirely.
    @available(iOS 26.0, *)
    private var glassBody: some View {
        GlassEffectContainer(spacing: FloatingDockMetrics.destinationSpacing) {
            HStack(spacing: FloatingDockMetrics.destinationSpacing) {
                ForEach(PrimaryTab.allCases) { tab in
                    tabButton(tab)
                }
            }
            .padding(FloatingDockMetrics.contentPadding)
            .glassEffect(.regular, in: SnapListShape(minimumRadius: FloatingDockMetrics.cornerRadius))
            .animation(
                DockGlassMotionPolicy.shouldAnimateSelectionMorph(reduceMotion: systemReduceMotion)
                    ? .default
                    : nil,
                value: selectedTab
            )
        }
    }

    private var legacyBody: some View {
        HStack(spacing: FloatingDockMetrics.destinationSpacing) {
            ForEach(PrimaryTab.allCases) { tab in
                tabButton(tab)
            }
        }
        .padding(FloatingDockMetrics.contentPadding)
        .background {
            SnapListShape(minimumRadius: FloatingDockMetrics.cornerRadius)
                .fill(SnapListColorToken.canvas.color)
                .shadow(color: .black.opacity(0.12), radius: 22, y: 8)
        }
        .overlay {
            SnapListShape(minimumRadius: FloatingDockMetrics.cornerRadius)
                .stroke(SnapListColorToken.inkPrimary.color.opacity(0.08), lineWidth: 1)
        }
    }

    private func tabButton(_ tab: PrimaryTab) -> some View {
        let isSelected = tab == selectedTab

        return Button {
            select(tab)
        } label: {
            Image(systemName: tab.systemImage(isSelected: isSelected))
                .font(.system(size: 20, weight: isSelected ? .semibold : .regular))
                .foregroundStyle(isSelected ? SnapListColorToken.action.color : SnapListColorToken.textTertiary.color)
                .frame(
                    width: FloatingDockMetrics.destinationWidth,
                    height: FloatingDockMetrics.destinationHeight(for: selectedTab)
                )
                .background(isSelected ? SnapListColorToken.actionTint.color : Color.clear)
                .clipShape(SnapListShape(minimumRadius: 16))
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(tab.title)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier("dock.\(tab.rawValue)")
    }
}

extension View {
    /// Floats the approved dock over a primary surface. Every screen that shows
    /// a dock composes it through here, so placement and identifiers cannot
    /// drift between them the way the Scan camera's own segmented control once
    /// did.
    ///
    /// #1057: `safeAreaBar` (iOS 26) replaces `safeAreaInset` here because
    /// `scrollEdgeEffectStyle` only fades a scroll surface's content under
    /// chrome that is itself declared through `safeAreaBar` — a plain
    /// `safeAreaInset` view is invisible to that coordination, so Trophy
    /// Wall's and Settings' `.snapListScrollEdgeEffect` calls had no floating
    /// bar to fade content under. iOS 17 keeps `safeAreaInset`, its only
    /// option, with today's hard-clip unchanged.
    @ViewBuilder
    func floatingDock(
        selectedTab: PrimaryTab,
        isVisible: Bool = true,
        scale: CGFloat = DockScrollScalePolicy.fullScale,
        select: @escaping (PrimaryTab) -> Void
    ) -> some View {
        if #available(iOS 26.0, *) {
            safeAreaBar(edge: .bottom, spacing: 0) {
                if isVisible {
                    FloatingDock(selectedTab: selectedTab, scale: scale, select: select)
                        .padding(.bottom, FloatingDockMetrics.bottomInset(for: selectedTab))
                        .transition(.opacity)
                }
            }
        } else {
            safeAreaInset(edge: .bottom, spacing: 0) {
                if isVisible {
                    FloatingDock(selectedTab: selectedTab, scale: scale, select: select)
                        .padding(.bottom, FloatingDockMetrics.bottomInset(for: selectedTab))
                        .transition(.opacity)
                }
            }
        }
    }
}
