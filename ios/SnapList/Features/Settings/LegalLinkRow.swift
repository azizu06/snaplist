import SwiftUI

/// One ABOUT row that opens a legal or support document (issue #812).
///
/// A standalone view rather than a `SettingsView` method, so a unit test can
/// render it alone and inspect its type-erased body — the same technique
/// `SettingsSellingHintRow` uses — without instantiating `SettingsView`'s
/// profile, stores, and other dependencies just to prove the row is wired to
/// a URL instead of the bare `HStack` it regressed to before.
struct LegalLinkRow: View {
    let destination: LegalDestination
    let accessibilityIdentifier: String

    @Environment(\.openURL) private var openURL

    var body: some View {
        Button {
            openURL(destination.url)
        } label: {
            HStack {
                Text(destination.label)
                Spacer()
                Image(systemName: "chevron.right").foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.primary)
        .accessibilityIdentifier(accessibilityIdentifier)
    }
}
