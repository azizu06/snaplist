import SwiftUI

enum SnapListColorToken: String, CaseIterable {
    case action = "#3665F3"
    case inkPrimary = "#16181B"
    case textSecondary = "#55585C"
    case textTertiary = "#8A8D92"
    case canvas = "#FFFFFF"
    case groupingFill = "#F7F7F7"
    case hairline = "#ECEDEF"
    case divider = "#F1F2F4"
    case durableSuccess = "#1B7A43"
    case caution = "#9A6A1B"
    case cautionFill = "#FBF3E7"
    case infoChipFill = "#E4ECFF"
    case primerBubbleFill = "#EEF3FE"
    case inProgressFill = "#F7F9FC"
    case inProgressBorder = "#E3E8F2"

    var color: Color {
        Color(hex: rawValue)
    }
}

extension Color {
    init(hex: String) {
        let value = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        let number = UInt64(value, radix: 16) ?? 0
        let red = Double((number >> 16) & 0xFF) / 255
        let green = Double((number >> 8) & 0xFF) / 255
        let blue = Double(number & 0xFF) / 255
        self.init(red: red, green: green, blue: blue)
    }
}

enum SnapListTypographyToken: CaseIterable {
    case displayTitle
    case onboardingHeadline
    case sectionHeader
    case cardTitle
    case rowTitle
    case body
    case status
    case metadata
    case wordmark

    var baseSize: CGFloat {
        switch self {
        case .displayTitle: 28
        case .onboardingHeadline: 27
        case .sectionHeader: 19
        case .cardTitle: 18
        case .rowTitle: 15
        case .body: 15
        case .status: 13
        case .metadata: 12
        case .wordmark: 23
        }
    }

    var weight: Font.Weight {
        switch self {
        case .displayTitle, .onboardingHeadline, .sectionHeader, .cardTitle, .wordmark:
            .bold
        case .rowTitle:
            .semibold
        case .body, .status, .metadata:
            .regular
        }
    }

    var relativeTextStyle: Font.TextStyle {
        switch self {
        case .displayTitle: .title
        case .onboardingHeadline: .title2
        case .sectionHeader, .cardTitle: .headline
        case .rowTitle, .body: .body
        case .status: .callout
        case .metadata: .caption
        case .wordmark: .title2
        }
    }
}

private struct SnapListTypographyModifier: ViewModifier {
    @ScaledMetric private var scaledSize: CGFloat
    private let token: SnapListTypographyToken

    init(_ token: SnapListTypographyToken) {
        self.token = token
        _scaledSize = ScaledMetric(
            wrappedValue: token.baseSize,
            relativeTo: token.relativeTextStyle
        )
    }

    func body(content: Content) -> some View {
        content
            .font(.system(size: scaledSize, weight: token.weight, design: .default))
            .tracking(tracking)
    }

    private var tracking: CGFloat {
        switch token {
        case .displayTitle: -0.7
        case .onboardingHeadline: -0.6
        case .sectionHeader: -0.3
        case .rowTitle: -0.2
        default: 0
        }
    }
}

extension View {
    func snapListTypography(_ token: SnapListTypographyToken) -> some View {
        modifier(SnapListTypographyModifier(token))
    }
}

enum SnapListMetrics {
    static let minimumTouchTarget: CGFloat = 44
    static let screenGutter: CGFloat = 20
    static let dockSideInset: CGFloat = 14
    static let dockBottomInset: CGFloat = 12
    static let dockHeight: CGFloat = 66
    static let dockRadius: CGFloat = 26
    static let captureWidth: CGFloat = 52
    static let primaryButtonHeight: CGFloat = 54
    static let primaryButtonRadius: CGFloat = 27
    static let sheetRadius: CGFloat = 26
}
