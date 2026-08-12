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

/// The one approved dock: exactly the two primary destinations, rendered the
/// same way on every screen that shows it. It iterates `PrimaryTab` rather than
/// a parallel dock enum so a destination cannot exist in one list and not the
/// other.
struct FloatingDock: View {
    let selectedTab: PrimaryTab
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
        select: @escaping (PrimaryTab) -> Void
    ) -> some View {
        safeAreaInset(edge: .bottom, spacing: 0) {
            if isVisible {
                FloatingDock(selectedTab: selectedTab, select: select)
                    .padding(.bottom, FloatingDockMetrics.bottomInset(for: selectedTab))
                    .transition(.opacity)
            }
        }
    }
}
