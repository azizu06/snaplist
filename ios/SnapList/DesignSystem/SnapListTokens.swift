import SwiftUI

enum SnapListColorToken: String, CaseIterable {
    case action = "#3665F3"
    /// Action blue's deeper tone, used for action text on `actionTint`.
    case actionDeep = "#2B51C4"
    case actionTint = "#EEF3FF"
    case inkPrimary = "#16181B"
    case textSecondary = "#55585C"
    case textTertiary = "#8A8D92"
    case canvas = "#FFFFFF"
    case quietFill = "#F3F4F6"
    case groupingFill = "#F7F7F7"
    case hairline = "#ECEDEF"
    case proGateReassuranceDivider = "#E6E7EA"
    case divider = "#F1F2F4"
    case durableSuccess = "#1B7A43"
    case caution = "#9A6A1B"
    case cautionFill = "#FBF3E7"
    case infoChipFill = "#E4ECFF"
    case primerBubbleFill = "#EEF3FE"
    case inProgressFill = "#F7F9FC"
    case inProgressBorder = "#E3E8F2"

    // MARK: - Routed bypass tokens (#830)
    //
    // Each of these matches a hex value that was already hardcoded at one or more call
    // sites before #830 routed every color through this enum. None of them introduce a
    // new visual value; they only give an existing value a name and a chokepoint.
    case mutedSurface = "#F5F6F7"
    case avatarBackground = "#E7E9EC"
    case debugProofText = "#8A6D3B"
    case destructiveText = "#B42318"
    case destructiveBorder = "#E4B9B4"
    case otpInactiveBorder = "#D6D8DC"
    case bulletNeutral = "#8A8E94"
    case neutralOutline = "#E3E5E8"
    case neutralFill = "#F2F3F5"
    case inputBorder = "#D3D6DB"
    case evidenceChipFill = "#EDF1FD"
    case dragHandle = "#C7C9CD"
    case dragHandleMuted = "#D4D6DB"
    case subtleActionFill = "#F5F8FF"
    case cameraSurface = "#0B0C0E"
    case cameraControlFill = "#14161A"
    case imagePlaceholderFill = "#E9EAEC"
    case placeholderStripe = "#CCD0D5"
    case cameraFixturePreview = "#282B31"
    case scrimOverlay = "#101214"
    case fixtureSceneGradientEnd = "#D4D5D8"
    case fixtureSubjectFill = "#25272A"
    case fixtureSubjectOutline = "#A7A9AD"
    case fixtureSubjectShadow = "#303236"
    case deleteIconTint = "#A63224"
    case waveformInactive = "#B5B7BC"
    case priceErrorBorder = "#D68A8A"
    case infoBannerFill = "#F4F7FF"
    case infoBannerDivider = "#E3EAFC"
    case actionOnDark = "#7CA0FF"
    case coachMarkDarkFill = "#1A1B20"
    case coachMarkDarkTail = "#24262A"
    case ebayAccent = "#4C63ED"
    case progressTrackInactive = "#E2E4E8"
    case cardHairline = "#ECEDF0"
    case onboardingHighlightFill = "#F8FAFF"
    case mutedHeadlineText = "#3F4246"
    case summaryCardFill = "#F5F7FB"
    case accentDotLight = "#85A8FF"
    case settingsLinkOnDark = "#8FB2FF"
    /// Content (text, icons, thin strokes) drawn on a dark or saturated fill — the
    /// camera overlay, a coach mark's dark variant, or the action-color button label —
    /// where it must stay light regardless of what `canvas` resolves to. Its raw value
    /// is lowercase only because Swift forbids two enum cases from sharing one raw
    /// value literal; `Color(hex:)` parses hex digits case-insensitively, so this
    /// resolves to the exact same white as `canvas`.
    case onDarkSurface = "#ffffff"

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
    static let primaryButtonHeight: CGFloat = 54
    static let primaryButtonRadius: CGFloat = 27
    static let sheetRadius: CGFloat = 26
}
