import SwiftUI

private struct ListingReviewIdentityDrawerTarget: Hashable, Identifiable {
    let name: String
    let value: String

    var id: String { name }
}

struct ItemSpecificsEditorView: View {
    @Bindable var store: ListingReviewStore
    let correctionAvailability: ListingReviewCorrectionAvailability
    /// Owned by the review screen. This one is pushed, so anything it held
    /// itself would be gone before the seller ever reached Done.
    let inlineEdits: ListingReviewInlineEdits
    @State private var drawer: ListingReviewIdentityDrawerTarget?
    @State private var correctionPresented = false
    @State private var returnFocusName: String?
    // Ordinary state, not `@FocusState`. Every typed row here is a
    // `UITextView` behind a representable since #918, and SwiftUI's focus
    // system cannot move a responder it does not own.
    @State private var focusedField: String?
    @AccessibilityFocusState private var focusedName: String?

    var body: some View {
        ScrollView { fields }
        .background(SnapListColorToken.canvas.color)
        .navigationTitle("Item specifics")
        .navigationBarTitleDisplayMode(.inline)
        // No keyboard toolbar here. Every control on this screen that raises a
        // keyboard is a `UITextView` behind a representable, which carries its
        // own Done as an input accessory; a SwiftUI keyboard toolbar reaches
        // SwiftUI's own responders and would either never appear or publish a
        // second control under the same identifier.
        .sheet(item: $drawer) { target in
            identityDrawer(target)
                .presentationDetents([.height(340), .large])
        }
        .navigationDestination(isPresented: $correctionPresented) {
            ListingReviewCorrectionBoundaryView()
        }
        .onChange(of: focusedField) { previous, _ in
            guard previous != nil else { return }
            Task { await inlineEdits.flush(into: store) }
        }
        .onChange(of: correctionPresented) { previous, current in
            guard previous, !current else { return }
            focusedName = returnFocusName
        }
        .onAppear {
            focusedName = returnFocusName
        }
        .accessibilityIdentifier("listing-review.specifics")
    }

    private var fields: some View {
        VStack(spacing: 12) {
            ForEach(store.draft?.specifics ?? [], id: \.name) { specific in
                specificRow(specific)
            }

            if let spentIdentityLine {
                Text(spentIdentityLine)
                    .font(.callout)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier(
                        "listing-review.specifics.correction-spent"
                    )
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 14)
    }

    @ViewBuilder
    private func specificRow(
        _ specific: ListingReviewSpecific
    ) -> some View {
        let pending = baseline(for: specific.name) != specific.value
        let identifier =
            "listing-review.specific.\(specific.name.accessibilityKey)"

        switch ListingReviewSpecificEditing.mode(
            forSpecificNamed: specific.name,
            correctionAvailability: correctionAvailability
        ) {
        case .inPlace:
            ListingReviewInlineTextField(
                label: specific.name,
                value: specific.value,
                pending: pending,
                identifier: identifier,
                field: .specific(specific.name),
                edits: inlineEdits,
                focusValue: specific.name,
                focus: $focusedField
            )
            .accessibilityFocused($focusedName, equals: specific.name)
        case .guidedCorrection, .spent:
            ListingReviewChoiceField(
                label: specific.name,
                value: specific.value,
                identifier: identifier,
                hint: correctionAvailability == .offered
                    ? "Opens guided correction"
                    : "Guided correction unavailable",
                accessory: .identity,
                pending: pending,
                enabled: correctionAvailability == .offered
            ) {
                returnFocusName = specific.name
                drawer = ListingReviewIdentityDrawerTarget(
                    name: specific.name,
                    value: specific.value
                )
            }
            .accessibilityFocused($focusedName, equals: specific.name)
        }
    }

    private func identityDrawer(
        _ target: ListingReviewIdentityDrawerTarget
    ) -> some View {
        ListingReviewDrawer(
            title: target.name,
            commitLabel: "Continue to guided correction",
            commitIdentifier: "listing-review.specific.correction",
            close: { drawer = nil },
            commit: {
                drawer = nil
                ListingReviewAnnouncement.post(
                    "Opened guided correction. Your photos and edits are kept.",
                    assertive: false
                )
                correctionPresented = true
            }
        ) {
            VStack(alignment: .leading, spacing: 12) {
                Text(target.value)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .frame(maxWidth: .infinity, alignment: .leading)

                // The consequence is stated here, before the commit, because
                // this is the last screen where backing out costs nothing.
                Text(ListingReviewCopy.identityRerunWarning)
                    .font(.callout)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                Text(ListingReviewCopy.identityCorrectionCost)
                    .font(.callout)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("listing-review.specific.identity-drawer")
        }
    }

    private var spentIdentityLine: String? {
        guard correctionAvailability == .spent else { return nil }
        let names = (store.draft?.specifics ?? [])
            .map(\.name)
            .filter(store.isIdentitySpecific)
        guard !names.isEmpty else { return nil }
        return "\(names.sentenceList) \(names.count == 1 ? "needs" : "need") guided correction, and you have used yours."
    }

    private func baseline(for name: String) -> String? {
        store.snapshot?.listing.specifics.first {
            $0.name.caseInsensitiveCompare(name) == .orderedSame
        }?.value
    }
}

private extension String {
    var accessibilityKey: String {
        lowercased()
            .replacingOccurrences(of: " ", with: "-")
            .filter { $0.isLetter || $0.isNumber || $0 == "-" }
    }
}

private extension [String] {
    /// "Brand", "Brand and Type", "Brand, Type, and Model".
    var sentenceList: String {
        switch count {
        case 0: ""
        case 1: self[0]
        case 2: "\(self[0]) and \(self[1])"
        default: dropLast().joined(separator: ", ")
            + ", and \(self[count - 1])"
        }
    }
}
