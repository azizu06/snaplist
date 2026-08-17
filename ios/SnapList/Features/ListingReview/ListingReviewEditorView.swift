import SwiftUI

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
