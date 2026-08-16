import SwiftUI

private struct ListingReviewIdentityDrawerTarget: Hashable, Identifiable {
    let name: String
    let value: String

    var id: String { name }
}

struct ItemSpecificsEditorView: View {
    @Bindable var store: ListingReviewStore
    let correctionAvailable: Bool
    @State private var drawer: ListingReviewIdentityDrawerTarget?
    @State private var correctionPresented = false
    @State private var returnFocusName: String?
    @FocusState private var focusedField: String?
    @AccessibilityFocusState private var focusedName: String?

    var body: some View {
        ScrollView {
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
        .background(SnapListColorToken.canvas.color)
        .navigationTitle("Item specifics")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") {
                    focusedField = nil
                }
                .fontWeight(.bold)
                .accessibilityLabel("Done editing, keeps it on this phone")
                .accessibilityIdentifier("listing-review.keyboard-done")
            }
        }
        .sheet(item: $drawer) { target in
            identityDrawer(target)
                .presentationDetents([.height(340), .large])
        }
        .navigationDestination(isPresented: $correctionPresented) {
            ListingReviewCorrectionBoundaryView()
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

    @ViewBuilder
    private func specificRow(
        _ specific: ListingReviewSpecific
    ) -> some View {
        let pending = baseline(for: specific.name) != specific.value
        let identifier =
            "listing-review.specific.\(specific.name.accessibilityKey)"

        switch ListingReviewSpecificEditing.mode(
            forSpecificNamed: specific.name,
            correctionAvailable: correctionAvailable
        ) {
        case .inPlace:
            ListingReviewInlineTextField(
                label: specific.name,
                value: specific.value,
                pending: pending,
                identifier: identifier,
                focusValue: specific.name,
                focus: $focusedField
            ) { typed in
                await store.setSpecific(name: specific.name, value: typed)
            }
            .accessibilityFocused($focusedName, equals: specific.name)
        case .guidedCorrection, .spent:
            ListingReviewChoiceField(
                label: specific.name,
                value: specific.value,
                identifier: identifier,
                hint: correctionAvailable
                    ? "Opens guided correction"
                    : "Guided correction unavailable",
                accessory: .identity,
                pending: pending,
                enabled: correctionAvailable
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
        guard !correctionAvailable else { return nil }
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

extension String {
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
