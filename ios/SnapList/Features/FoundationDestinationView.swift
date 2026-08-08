import SwiftUI

struct FoundationDestinationView: View {
    let destination: FutureBoundary

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .snapListTypography(.displayTitle)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("route.\(destination.rawValue).title")
            Text("This typed route is wired; its approved screen is owned by a later issue.")
                .snapListTypography(.body)
                .foregroundStyle(SnapListColorToken.textSecondary.color)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(SnapListMetrics.screenGutter)
        .background(SnapListColorToken.canvas.color)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
    }

    private var title: String {
        switch destination {
        case .account: "Account"
        case .run: "Run"
        case .draft: "Draft"
        }
    }
}

struct VisualStateBoundaryPlaceholder: View {
    let state: ApprovedVisualStateID

    var body: some View {
        VStack(spacing: 16) {
            SnapListChip("Approved fixture", systemImage: "snowflake", variant: .info)
            Text(state.rawValue)
                .snapListTypography(.displayTitle)
            Text("Rendering boundary reserved for issue #\(state.ownerIssue).")
                .snapListTypography(.body)
                .foregroundStyle(SnapListColorToken.textSecondary.color)
                .multilineTextAlignment(.center)
        }
        .padding(SnapListMetrics.screenGutter)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(SnapListColorToken.canvas.color)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("visual-state.\(state.rawValue)")
    }
}
