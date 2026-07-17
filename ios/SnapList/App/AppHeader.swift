import SwiftUI

struct AppHeader: View {
    let openActivity: () -> Void
    let openAccount: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Text("SnapList")
                .snapListTypography(.wordmark)
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .accessibilityAddTraits(.isHeader)

            Spacer()

            Button(action: openActivity) {
                Image(systemName: "bell")
                    .font(.system(size: 20, weight: .medium))
                    .frame(
                        width: SnapListMetrics.minimumTouchTarget,
                        height: SnapListMetrics.minimumTouchTarget
                    )
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .foregroundStyle(SnapListColorToken.inkPrimary.color)
            .accessibilityLabel("Open activity")
            .accessibilityIdentifier("header.activity")

            Button(action: openAccount) {
                Circle()
                    .fill(SnapListColorToken.groupingFill.color)
                    .frame(
                        width: SnapListMetrics.minimumTouchTarget,
                        height: SnapListMetrics.minimumTouchTarget
                    )
                    .overlay {
                        Image(systemName: "person.crop.circle")
                            .font(.system(size: 24, weight: .regular))
                    }
                    .contentShape(.circle)
            }
            .buttonStyle(.plain)
            .foregroundStyle(SnapListColorToken.inkPrimary.color)
            .accessibilityLabel("Open account and settings")
            .accessibilityIdentifier("header.account")
        }
        .frame(minHeight: SnapListMetrics.minimumTouchTarget)
    }
}
