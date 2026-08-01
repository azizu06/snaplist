import SwiftUI

enum ListingReviewTextField: String {
    case title = "Title"
    case description = "Description"

    var minimumHeight: CGFloat {
        self == .title ? 96 : 220
    }
}

struct ListingReviewEditorView: View {
    @Bindable var store: ListingReviewStore
    let field: ListingReviewTextField
    @State private var value: String
    @FocusState private var fieldFocused: Bool
    @Environment(\.dismiss) private var dismiss

    init(
        store: ListingReviewStore,
        field: ListingReviewTextField
    ) {
        self.store = store
        self.field = field
        _value = State(
            initialValue: field == .title
                ? (store.draft?.title ?? "")
                : (store.draft?.description ?? "")
        )
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                TextEditor(text: $value)
                    .focused($fieldFocused)
                    .font(.body)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: field.minimumHeight)
                    .padding(10)
                    .background(SnapListColorToken.canvas.color)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
                    .overlay {
                        RoundedRectangle(cornerRadius: 14)
                            .stroke(SnapListColorToken.hairline.color)
                    }
                    .accessibilityLabel(field.rawValue)
                    .accessibilityIdentifier(
                        "listing-review.editor.\(field.rawValue.lowercased())"
                    )
                    .onChange(of: value) { _, changed in
                        Task {
                            switch field {
                            case .title:
                                await store.setTitle(changed)
                            case .description:
                                await store.setDescription(changed)
                            }
                        }
                    }

                Text(
                    "Edits stay on this phone until you tap Done on the review. Same-photo edits don’t spend another AI item."
                )
                .font(.callout)
                .foregroundStyle(SnapListColorToken.textTertiary.color)
            }
            .padding(18)
        }
        .background(SnapListColorToken.canvas.color)
        .navigationTitle(field.rawValue)
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(true)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    dismiss()
                } label: {
                    Label("Back", systemImage: "chevron.left")
                }
                .frame(
                    minWidth: SnapListMetrics.minimumTouchTarget,
                    minHeight: SnapListMetrics.minimumTouchTarget
                )
                .accessibilityIdentifier("listing-review.editor.back")
            }
        }
        .onAppear {
            fieldFocused = true
        }
    }
}

struct ListingReviewConditionEditorView: View {
    @Bindable var store: ListingReviewStore
    @Environment(\.dismiss) private var dismiss
    @AccessibilityFocusState private var focusedCondition:
        ListingReviewCondition?

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                ForEach(ListingReviewCondition.allCases, id: \.self) { condition in
                    Button {
                        Task {
                            await store.setCondition(condition)
                            dismiss()
                        }
                    } label: {
                        HStack {
                            Text(condition.sellerLabel)
                                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                            Spacer()
                            if store.draft?.condition == condition {
                                Image(systemName: "checkmark")
                                    .fontWeight(.semibold)
                                    .foregroundStyle(SnapListColorToken.action.color)
                                    .accessibilityHidden(true)
                            }
                        }
                        .frame(minHeight: 56)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(.isButton)
                    .accessibilityValue(
                        store.draft?.condition == condition ? "Selected" : ""
                    )
                    .accessibilityFocused(
                        $focusedCondition,
                        equals: condition
                    )
                    .accessibilityIdentifier(
                        "listing-review.condition.\(condition.rawValue)"
                    )
                    if condition != ListingReviewCondition.allCases.last {
                        Divider()
                    }
                }
            }
            .padding(.horizontal, 18)

            Text(
                "Choose one. Your selection is kept on this phone until you tap Done on the review."
            )
            .font(.callout)
            .foregroundStyle(SnapListColorToken.textTertiary.color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18)
        }
        .navigationTitle("Condition")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            focusedCondition = store.draft?.condition
        }
    }
}

struct ListingReviewCorrectionBoundaryView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                Text("Typed boundary · #212")
                    .font(.caption2.weight(.bold))
                    .tracking(1)
                    .textCase(.uppercase)
                    .foregroundStyle(SnapListColorToken.textTertiary.color)

                Text(
                    "Guided correction runs on your existing photos—never a rescan. Cancelling keeps your photos and edits and consumes nothing; a coherent commit is consumed once."
                )
                .font(.body)
                .foregroundStyle(SnapListColorToken.inkPrimary.color)

                Text(
                    "Back restores focus to Fix item. Changed photos would require a new run."
                )
                .font(.callout)
                .foregroundStyle(SnapListColorToken.textTertiary.color)
            }
            .padding(16)
            .background(SnapListColorToken.canvas.color)
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .overlay {
                RoundedRectangle(cornerRadius: 14)
                    .stroke(
                        SnapListColorToken.textTertiary.color,
                        style: StrokeStyle(lineWidth: 1, dash: [5])
                    )
            }
            .padding(18)
        }
        .navigationTitle("Fix item")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("listing-review.correction-boundary")
    }
}
