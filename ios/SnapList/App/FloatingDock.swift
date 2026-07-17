import SwiftUI

struct FloatingDock: View {
    let selectedTab: PrimaryTab
    let select: (DockDestination) -> Void

    var body: some View {
        HStack(spacing: 0) {
            ForEach(DockDestination.allCases) { destination in
                if destination == .capture {
                    captureButton
                } else {
                    tabButton(destination)
                }
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

    private var captureButton: some View {
        Button {
            select(.capture)
        } label: {
            Image(systemName: DockDestination.capture.systemImage)
                .font(.system(size: 25, weight: .semibold))
                .foregroundStyle(.white)
                .frame(
                    width: SnapListMetrics.captureWidth,
                    height: SnapListMetrics.minimumTouchTarget
                )
                .background(SnapListColorToken.action.color)
                .clipShape(.rect(cornerRadius: 15))
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity)
        .accessibilityLabel("Capture a new item")
        .accessibilityIdentifier("dock.capture")
    }

    private func tabButton(_ destination: DockDestination) -> some View {
        let isSelected = destination.tab == selectedTab

        return Button {
            select(destination)
        } label: {
            VStack(spacing: 3) {
                Image(systemName: destination.systemImage)
                    .font(.system(size: 20, weight: isSelected ? .semibold : .regular))
                Text(destination.title)
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
        .accessibilityLabel(destination.title)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier("dock.\(destination.rawValue)")
    }
}
