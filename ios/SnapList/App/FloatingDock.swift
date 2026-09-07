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

    var body: some View {
        HStack(spacing: FloatingDockMetrics.destinationSpacing) {
            ForEach(PrimaryTab.allCases) { tab in
                tabButton(tab)
            }
        }
        .padding(FloatingDockMetrics.contentPadding)
        .background {
            RoundedRectangle(cornerRadius: FloatingDockMetrics.cornerRadius)
                .fill(SnapListColorToken.canvas.color)
                .shadow(color: .black.opacity(0.12), radius: 22, y: 8)
        }
        .overlay {
            RoundedRectangle(cornerRadius: FloatingDockMetrics.cornerRadius)
                .stroke(SnapListColorToken.inkPrimary.color.opacity(0.08), lineWidth: 1)
        }
        .scaleEffect(scale, anchor: .bottom)
    }

    private func tabButton(_ tab: PrimaryTab) -> some View {
        let isSelected = tab == selectedTab

        return Button {
            select(tab)
        } label: {
            Image(systemName: tab.systemImage(isSelected: isSelected))
                .font(.system(size: 20, weight: isSelected ? .semibold : .regular))
            .foregroundStyle(
                isSelected
                    ? SnapListColorToken.action.color
                    : SnapListColorToken.textTertiary.color
            )
            .frame(
                width: FloatingDockMetrics.destinationWidth,
                height: FloatingDockMetrics.destinationHeight(for: selectedTab)
            )
            .background(
                isSelected
                    ? SnapListColorToken.actionTint.color
                    : Color.clear
            )
            .clipShape(.rect(cornerRadius: 16))
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
    func floatingDock(
        selectedTab: PrimaryTab,
        isVisible: Bool = true,
        scale: CGFloat = DockScrollScalePolicy.fullScale,
        select: @escaping (PrimaryTab) -> Void
    ) -> some View {
        safeAreaInset(edge: .bottom, spacing: 0) {
            if isVisible {
                FloatingDock(selectedTab: selectedTab, scale: scale, select: select)
                    .padding(.bottom, FloatingDockMetrics.bottomInset(for: selectedTab))
                    .transition(.opacity)
            }
        }
    }
}
