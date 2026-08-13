import SwiftUI

struct SnapListPrimaryButton: View {
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion

    let title: String
    var forceReducedMotion = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .snapListTypography(.rowTitle)
                .foregroundStyle(SnapListColorToken.onDarkSurface.color)
                .frame(maxWidth: .infinity)
                .frame(minHeight: SnapListMetrics.primaryButtonHeight)
                .contentShape(.rect)
        }
        .buttonStyle(
            SnapListPrimaryButtonStyle(
                reduceMotion: systemReduceMotion || forceReducedMotion
            )
        )
        .accessibilityIdentifier("button.primary.\(title.accessibilitySlug)")
    }
}

private struct SnapListPrimaryButtonStyle: ButtonStyle {
    let reduceMotion: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(SnapListColorToken.action.color)
            .clipShape(.rect(cornerRadius: SnapListMetrics.primaryButtonRadius))
            .shadow(
                color: SnapListColorToken.action.color.opacity(0.36),
                radius: 10,
                y: 8
            )
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.99 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

struct SnapListSecondaryButton: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .snapListTypography(.rowTitle)
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .frame(maxWidth: .infinity)
                .frame(minHeight: 50)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .background(SnapListColorToken.canvas.color)
        .clipShape(.rect(cornerRadius: 25))
        .overlay {
            RoundedRectangle(cornerRadius: 25)
                .stroke(SnapListColorToken.inputBorder.color, lineWidth: 1)
        }
        .accessibilityIdentifier("button.secondary.\(title.accessibilitySlug)")
    }
}

enum SnapListChipVariant {
    case info
    case evidenceStrong
    case caution
    case neutral

    var foreground: Color {
        switch self {
        case .info, .evidenceStrong: SnapListColorToken.action.color
        case .caution: SnapListColorToken.caution.color
        case .neutral: SnapListColorToken.textSecondary.color
        }
    }

    var background: Color {
        switch self {
        case .info: SnapListColorToken.infoChipFill.color
        case .evidenceStrong: SnapListColorToken.evidenceChipFill.color
        case .caution: SnapListColorToken.cautionFill.color
        case .neutral: SnapListColorToken.neutralFill.color
        }
    }
}

struct SnapListChip: View {
    let title: String
    let systemImage: String?
    let variant: SnapListChipVariant

    init(
        _ title: String,
        systemImage: String? = nil,
        variant: SnapListChipVariant = .neutral
    ) {
        self.title = title
        self.systemImage = systemImage
        self.variant = variant
    }

    var body: some View {
        HStack(spacing: 4) {
            if let systemImage {
                Image(systemName: systemImage)
            }
            Text(title)
        }
        .snapListTypography(.metadata)
        .fontWeight(.semibold)
        .foregroundStyle(variant.foreground)
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(variant.background)
        .clipShape(.capsule)
        .accessibilityElement(children: .combine)
    }
}

struct SnapListSellerRow: View {
    let title: String
    let status: String
    let metadata: String
    let statusSystemImage: String
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 12)
                .fill(SnapListColorToken.groupingFill.color)
                .frame(width: 56, height: 56)
                .overlay {
                    Image(systemName: "shippingbox")
                        .foregroundStyle(SnapListColorToken.textTertiary.color)
                }
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .snapListTypography(.rowTitle)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)

                Label(status, systemImage: statusSystemImage)
                    .snapListTypography(.status)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)

                Text(metadata)
                    .snapListTypography(.metadata)
                    .foregroundStyle(SnapListColorToken.textTertiary.color)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .snapListTypography(.status)
                    .fontWeight(.semibold)
                    .frame(minWidth: SnapListMetrics.minimumTouchTarget)
                    .frame(minHeight: SnapListMetrics.minimumTouchTarget)
                    .buttonStyle(.bordered)
            }
        }
        .padding(12)
        .background(SnapListColorToken.canvas.color)
        .clipShape(.rect(cornerRadius: 16))
        .overlay {
            RoundedRectangle(cornerRadius: 16)
                .stroke(SnapListColorToken.hairline.color, lineWidth: 1)
        }
        .accessibilityElement(children: .contain)
    }
}

struct SnapListPinnedActionTray<Content: View>: View {
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        content
            .padding(.horizontal, SnapListMetrics.screenGutter)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity)
            .background(.ultraThinMaterial)
            .overlay(alignment: .top) {
                Divider().foregroundStyle(SnapListColorToken.hairline.color)
            }
    }
}

struct SnapListSheetContainer<Content: View>: View {
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        content
            .presentationDragIndicator(.visible)
            .presentationCornerRadius(SnapListMetrics.sheetRadius)
    }
}

/// The only shared destructive styling approved by the resolved contracts.
/// Family screens must use the platform role instead of introducing a permanent red token.
struct SnapListDestructiveConfirmationButton: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(title, role: .destructive, action: action)
            .frame(minHeight: SnapListMetrics.minimumTouchTarget)
            .accessibilityIdentifier("button.destructive.\(title.accessibilitySlug)")
    }
}

private extension String {
    var accessibilitySlug: String {
        lowercased()
            .replacingOccurrences(of: " ", with: "-")
            .replacingOccurrences(of: ".", with: "")
    }
}
