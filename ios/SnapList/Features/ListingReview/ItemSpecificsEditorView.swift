import SwiftUI

private struct ListingReviewSpecificDestination: Hashable, Identifiable {
    let id: String
    let value: String
}

struct ItemSpecificsEditorView: View {
    @Bindable var store: ListingReviewStore
    let correctionAvailable: Bool
    @State private var editor: ListingReviewSpecificDestination?
    @State private var correctionPresented = false
    @State private var returnFocusName: String?
    @AccessibilityFocusState private var focusedName: String?

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                ForEach(store.draft?.specifics ?? [], id: \.name) { specific in
                    specificRow(specific)
                    if specific.name != store.draft?.specifics.last?.name {
                        Divider().padding(.leading, 8)
                    }
                }
            }
            .padding(.horizontal, 10)

            Text(
                "Saved on this phone when you tap Done. Editing a specific never spends another AI item."
            )
            .font(.callout)
            .foregroundStyle(SnapListColorToken.textTertiary.color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18)
        }
        .navigationTitle("Item specifics")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(item: $editor) { destination in
            ListingReviewSpecificFieldView(
                name: destination.id,
                value: destination.value
            ) { value in
                Task {
                    await store.setSpecific(
                        name: destination.id,
                        value: value
                    )
                    returnFocusName = destination.id
                    editor = nil
                }
            }
        }
        .navigationDestination(isPresented: $correctionPresented) {
            ListingReviewCorrectionBoundaryView()
        }
        .onChange(of: editor?.id) { previous, current in
            guard previous != nil, current == nil else { return }
            focusedName = returnFocusName
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

    private func specificRow(
        _ specific: ListingReviewSpecific
    ) -> some View {
        let identity = store.isIdentitySpecific(specific.name)
        let baseline = store.snapshot?.listing.specifics.first(where: {
            $0.name.caseInsensitiveCompare(specific.name) == .orderedSame
        })?.value
        let edited = baseline != specific.value
        return Button {
            returnFocusName = specific.name
            if identity, correctionAvailable {
                ListingReviewAnnouncement.post(
                    "Opened guided correction. Your photos and edits are kept.",
                    assertive: false
                )
                correctionPresented = true
            } else if !identity {
                editor = ListingReviewSpecificDestination(
                    id: specific.name,
                    value: specific.value
                )
            }
        } label: {
            HStack(spacing: 12) {
                Text(specific.name)
                    .font(.callout)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                Spacer(minLength: 12)
                if edited {
                    Circle()
                        .fill(SnapListColorToken.action.color)
                        .frame(width: 7, height: 7)
                        .accessibilityHidden(true)
                }
                Text(specific.value)
                    .font(.body)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .multilineTextAlignment(.trailing)
                Image(systemName: identity ? "sparkles" : "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(
                        identity
                            ? SnapListColorToken.action.color
                            : SnapListColorToken.textTertiary.color
                    )
                    .accessibilityHidden(true)
            }
            .frame(minHeight: 56)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(specific.name)
        .accessibilityValue(
            specific.value + (edited ? ", edited, not saved yet" : "")
        )
        .accessibilityHint(
            identity
                ? (
                    correctionAvailable
                        ? "Opens guided correction"
                        : "Guided correction unavailable"
                )
                : "Edit"
        )
        .disabled(identity && !correctionAvailable)
        .accessibilityFocused($focusedName, equals: specific.name)
        .accessibilityIdentifier(
            "listing-review.specific.\(specific.name.accessibilityKey)"
        )
    }
}

private struct ListingReviewSpecificFieldView: View {
    let name: String
    let apply: (String) -> Void
    @State private var value: String
    @FocusState private var isFocused: Bool

    init(
        name: String,
        value: String,
        apply: @escaping (String) -> Void
    ) {
        self.name = name
        self.apply = apply
        _value = State(initialValue: value)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                TextField(name, text: $value)
                    .focused($isFocused)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 14)
                    .frame(minHeight: 48)
                    .background(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
                    .overlay {
                        RoundedRectangle(cornerRadius: 14)
                            .stroke(SnapListColorToken.hairline.color)
                    }
                    .accessibilityIdentifier("listing-review.specific.field")

                Text(
                    "Apply keeps this on your phone and returns to Item specifics; the review then shows Unsaved changes until you tap Done. Back keeps the previous value. Leave it blank to restore the suggested value."
                )
                .font(.callout)
                .foregroundStyle(SnapListColorToken.textTertiary.color)
            }
            .padding(18)
        }
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Apply") {
                    apply(value)
                }
                .fontWeight(.bold)
                .frame(minHeight: SnapListMetrics.minimumTouchTarget)
                .accessibilityLabel(
                    "Apply, keeps it on this phone until Done"
                )
                .accessibilityIdentifier("listing-review.specific.apply")
            }
        }
        .onAppear {
            isFocused = true
        }
    }
}

private extension String {
    var accessibilityKey: String {
        lowercased()
            .replacingOccurrences(of: " ", with: "-")
            .filter { $0.isLetter || $0.isNumber || $0 == "-" }
    }
}
