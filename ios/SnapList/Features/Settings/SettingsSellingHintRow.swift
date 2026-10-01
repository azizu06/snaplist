import SwiftUI

/// The eBay account row at the top of Settings' Selling section: the
/// marketplace mark, the account, and one quiet status line. Status stays
/// secondary grey in every state, so the section's only color is the red
/// Disconnect control beneath it.
struct SettingsEbayAccountRow: View {
    let presentation: SettingsSellingPresentation

    var body: some View {
        HStack(spacing: 12) {
            Image("MarketplaceMarkEbay")
                .resizable()
                .scaledToFit()
                .frame(width: 30)
                .frame(width: 44, height: 44)
                .background(
                    SnapListColorToken.quietFill.color,
                    in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                )
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(presentation.accountTitle)
                    .snapListTypography(.rowTitle)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                if let status = presentation.status {
                    Text(status)
                        .snapListTypography(.status)
                        .foregroundStyle(SnapListColorToken.textSecondary.color)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 10)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
    }

    private var accessibilityLabel: String {
        let account = "eBay, \(presentation.accountTitle)"
        guard let status = presentation.status else { return account }
        return "\(account), \(status)"
    }
}

/// The Selling section's eBay policy hint row (issue #694).
///
/// The row combines its children so VoiceOver reads the warning and its link as
/// one sentence rather than two unrelated stops. Combining also removes the
/// `Link` from the accessibility tree, which would leave a VoiceOver seller able
/// to hear about the eBay page and unable to open it. The same destination is
/// therefore re-attached to the combined element as an accessibility action.
struct SettingsSellingHintRow: View {
    let hint: SettingsSellingPresentation.Hint

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(hint.message, systemImage: "exclamationmark.triangle")
                .font(.footnote)
                .labelStyle(.titleAndIcon)
            if let helpURL = hint.helpURL {
                // Footnote text is roughly 13pt, so the link needs its own
                // minimum height to stay tappable for a sighted seller. The
                // VoiceOver path reaches the same destination through the
                // action below, which does not depend on the hit area.
                Link(SettingsSellingHintPolicyAction.label, destination: helpURL)
                    .font(.footnote)
                    .frame(minHeight: 44, alignment: .leading)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("settings.ebay-policy-hint")
        .modifier(SettingsSellingHintPolicyAction(helpURL: hint.helpURL))
    }
}

/// Re-exposes the hint's eBay link as an action on the combined element, so it
/// reaches VoiceOver through the actions rotor.
///
/// This is a named `ViewModifier` rather than a bare `.accessibilityAction`
/// call because every accessibility modifier erases to the same
/// `AccessibilityAttachmentModifier`. A bare call would leave nothing in the
/// rendered body type that a test could tell apart from the `.combine` and
/// identifier modifiers already there, and the assertion guarding this could
/// never fail.
struct SettingsSellingHintPolicyAction: ViewModifier {
    /// One string for the visible link and the VoiceOver action, so a sighted
    /// seller and a VoiceOver seller are told about the same destination.
    static let label = "Open shipping and return policies on eBay"

    let helpURL: URL?
    @Environment(\.openURL) private var openURL

    @ViewBuilder
    func body(content: Content) -> some View {
        if let helpURL {
            content.accessibilityAction(named: Self.label) { openURL(helpURL) }
        } else {
            content
        }
    }
}
