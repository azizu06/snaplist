import SwiftUI

struct FoundationPlaceholderView: View {
    let tab: PrimaryTab
    let configuration: LaunchConfiguration
    let openActivity: () -> Void
    let openAccount: () -> Void

    @State private var keyboardProbeText = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                AppHeader(openActivity: openActivity, openAccount: openAccount)

                VStack(alignment: .leading, spacing: 10) {
                    Text(tab.title)
                        .snapListTypography(.displayTitle)
                        .foregroundStyle(SnapListColorToken.inkPrimary.color)
                        .accessibilityIdentifier("screen.title")

                    Text("The native foundation is ready for this approved screen family.")
                        .snapListTypography(.body)
                        .foregroundStyle(SnapListColorToken.textSecondary.color)
                        .fixedSize(horizontal: false, vertical: true)

                    SnapListChip(
                        "Foundation only",
                        systemImage: "checkmark.seal",
                        variant: .info
                    )
                }

                if configuration.keyboardProbe {
                    TextField("Fixture keyboard probe", text: $keyboardProbeText)
                        .textFieldStyle(.roundedBorder)
                        .frame(minHeight: SnapListMetrics.minimumTouchTarget)
                        .accessibilityIdentifier("fixture.keyboard-probe")
                }

                Spacer(minLength: 260)
            }
            .padding(.horizontal, SnapListMetrics.screenGutter)
            .padding(.top, 8)
        }
        .background(SnapListColorToken.canvas.color)
        .navigationBarBackButtonHidden()
        .accessibilityIdentifier("screen.\(tab.rawValue)")
    }
}

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
        case .activity: "Activity"
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
