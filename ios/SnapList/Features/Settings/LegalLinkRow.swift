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
            // `settingsCardRow` proposes its full `minHeight: 52` down to
            // this label, but a plain-button label otherwise reports back
            // only its own intrinsic text height and centers within that
            // taller row (#831). That leaves a real tappable and
            // accessibility-frame area of roughly 20pt — under the 44pt
            // floor at every Dynamic Type size, not only the smallest one —
            // with the row's remaining height acting as untappable padding.
            // Claiming the full proposed height here, before `contentShape`
            // captures it, is what makes the button's actual hit area match
            // its visually full-height row.
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.primary)
        .accessibilityIdentifier(accessibilityIdentifier)
    }
}
