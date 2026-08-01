import SwiftUI

struct SoldMatchDetailView: View {
    let match: ListingReviewSoldMatch

    @Environment(\.locale) private var locale

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                ZStack {
                    SnapListColorToken.quietFill.color
                    Image(systemName: "shippingbox")
                        .font(.title2)
                        .foregroundStyle(SnapListColorToken.textTertiary.color)
                }
                .frame(maxWidth: .infinity)
                .aspectRatio(4 / 3, contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: 14))
                .accessibilityHidden(true)

                Text(
                    ListingReviewCurrency.string(
                        match.soldPrice,
                        currencyCode: match.currency
                    )
                )
                .font(.title.weight(.bold).monospacedDigit())
                .foregroundStyle(SnapListColorToken.inkPrimary.color)

                // The approved v2.2.1 pass cut Source and Evidence from this
                // sheet and replaced them with the facts that explain the
                // price, "since a free-shipping Buy It Now and a nine-bid
                // auction are not the same $54". Any of the last three may be
                // absent on a real record; `fact` drops the row rather than
                // rendering a labelled blank.
                VStack(spacing: 0) {
                    fact("Seller title", match.title)
                    fact("Date sold", match.soldDateLabel)
                    fact("Condition", match.condition)
                    fact("Size", match.size)
                    fact("Format", match.formatLabel)
                    fact("Shipping", match.shippingLabel(locale: locale))
                }
            }
            .padding(18)
        }
        .navigationTitle("Sold comp")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("listing-review.sold-detail")
    }

    @ViewBuilder
    private func fact(_ title: String, _ value: String?) -> some View {
        if let value,
           !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            VStack(alignment: .leading, spacing: 3) {
                Text(title.uppercased())
                    .font(.caption2.weight(.bold))
                    .tracking(0.4)
                    .foregroundStyle(SnapListColorToken.textTertiary.color)
                Text(value)
                    .font(.body)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.vertical, 11)
            .overlay(alignment: .bottom) {
                Divider()
            }
        }
    }
}
