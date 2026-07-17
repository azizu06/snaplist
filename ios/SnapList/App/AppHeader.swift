import SwiftUI

struct AppHeader: View {
    var activityCount: Int = 0
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
                ZStack(alignment: .topTrailing) {
                    Image(systemName: "bell")
                        .font(.system(size: 20, weight: .medium))
                        .frame(
                            width: SnapListMetrics.minimumTouchTarget,
                            height: SnapListMetrics.minimumTouchTarget
                        )
                    if activityCount == 1 {
                        Circle()
                            .fill(SnapListColorToken.action.color)
                            .frame(width: 8, height: 8)
                            .overlay { Circle().stroke(.white, lineWidth: 1.5) }
                            .padding(.top, 8)
                            .padding(.trailing, 8)
                            .accessibilityHidden(true)
                    } else if activityCount > 1 {
                        Text(activityCount > 99 ? "99+" : activityCount.formatted())
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 4)
                            .frame(minWidth: 18, minHeight: 18)
                            .background(SnapListColorToken.action.color)
                            .clipShape(.capsule)
                            .overlay { Capsule().stroke(.white, lineWidth: 1.5) }
                            .accessibilityHidden(true)
                    }
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .foregroundStyle(SnapListColorToken.inkPrimary.color)
            .accessibilityLabel("Open activity")
            .accessibilityValue(activityCount > 0 ? "\(activityCount) unread" : "No unread activity")
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
