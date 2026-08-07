import SwiftUI

/// The one approved dock: exactly the two primary destinations, rendered the
/// same way on every screen that shows it. It iterates `PrimaryTab` rather than
/// a parallel dock enum so a destination cannot exist in one list and not the
/// other.
struct FloatingDock: View {
    let selectedTab: PrimaryTab
    let select: (PrimaryTab) -> Void

    var body: some View {
        HStack(spacing: 0) {
            ForEach(PrimaryTab.allCases) { tab in
                tabButton(tab)
            }
        }
        .frame(height: SnapListMetrics.dockHeight)
        .padding(.horizontal, 8)
        .background(.ultraThinMaterial)
        .clipShape(.rect(cornerRadius: SnapListMetrics.dockRadius))
        .overlay {
            RoundedRectangle(cornerRadius: SnapListMetrics.dockRadius)
                .stroke(SnapListColorToken.inkPrimary.color.opacity(0.08), lineWidth: 1)
        }
        .shadow(color: .black.opacity(0.14), radius: 14, y: 8)
    }

    private func tabButton(_ tab: PrimaryTab) -> some View {
        let isSelected = tab == selectedTab

        return Button {
            select(tab)
        } label: {
            VStack(spacing: 3) {
                Image(systemName: tab.systemImage)
                    .font(.system(size: 20, weight: isSelected ? .semibold : .regular))
                Text(tab.title)
                    .snapListTypography(.metadata)
                    .fontWeight(isSelected ? .semibold : .regular)
                    .lineLimit(1)
            }
            .foregroundStyle(
                isSelected
                    ? SnapListColorToken.action.color
                    : SnapListColorToken.textTertiary.color
            )
            .frame(maxWidth: .infinity)
            .frame(minHeight: SnapListMetrics.minimumTouchTarget)
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
                    .padding(.horizontal, SnapListMetrics.dockSideInset)
                    .padding(.bottom, SnapListMetrics.dockBottomInset)
                    .transition(.opacity)
            }
        }
    }
}
