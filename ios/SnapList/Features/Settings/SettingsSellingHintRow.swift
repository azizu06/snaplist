import SwiftUI

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
                Link(SettingsSellingHintPolicyAction.label, destination: helpURL)
                    .font(.footnote)
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
    static let label = "Open business policies on eBay"

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
