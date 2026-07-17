import SwiftUI

enum ApprovedVisualStateID: String, CaseIterable, Codable, Identifiable {
    case onboardingLaunch = "ONB-00"
    case onboardingPromise = "ONB-01"
    case onboardingMarketplace = "ONB-05"
    case onboardingAllowance = "ONB-06"
    case onboardingPhotoPrimer = "ONB-07"
    case nativeCameraPermission = "native-camera-permission"
    case onboardingDenied = "ONB-08"
    case settingsHandoff = "settings-handoff"
    case onboardingCameraHandoff = "ONB-09-camera"
    case onboardingLibraryHandoff = "ONB-09-library"
    case returningSignIn = "returning-sign-in"
    case captureLauncher = "CAP-01"
    case captureCoaching = "CAP-02a"
    case captureMoveCloser = "CAP-02b1"
    case captureAccepted = "CAP-02b2"
    case captureOnePhoto = "CAP-02c"
    case captureReviewHandoff = "CAP-03-handoff"
    case pricingStrong = "S1"
    case pricingAllComps = "S1b"
    case pricingSelectedComp = "S2"
    case pricingLimited = "S3"
    case homeActive = "HOME-01"
    case homeEmpty = "HOME-02"
    case homeAttention = "HOME-03"
    case homeSearch = "HOME-04"
    case runList = "RUN-01"
    case runDetail = "RUN-02"
    case runCompact = "RUN-03"
    case runInterrupted = "RUN-04"
    case runFailed = "RUN-05"
    case runRefreshRecovery = "RUN-06"
    case runCancelConfirmation = "RUN-07"
    case runHaulProgress = "RUN-08"
    case reviewIdentity = "REV-01"
    case reviewCorrectionInput = "REV-02a"
    case reviewCorrectionCandidates = "REV-02b"
    case reviewCorrectionImpact = "REV-02c"
    case reviewCorrectionApplying = "REV-02d"
    case reviewCorrectionRetry = "REV-02d-retry"
    case reviewCorrectionApplied = "REV-02e"
    case reviewPricingEvidence = "REV-07"
    case reviewLowEvidence = "REV-08"

    var id: String { rawValue }

    var ownerIssue: Int {
        switch self {
        case .onboardingLaunch, .onboardingPromise, .onboardingMarketplace,
             .onboardingAllowance, .onboardingPhotoPrimer, .nativeCameraPermission,
             .onboardingDenied, .settingsHandoff, .onboardingCameraHandoff,
             .onboardingLibraryHandoff, .returningSignIn:
            206
        case .captureLauncher, .captureCoaching, .captureMoveCloser, .captureAccepted,
             .captureOnePhoto, .captureReviewHandoff:
            207
        case .homeActive, .homeEmpty, .homeAttention, .homeSearch:
            208
        case .pricingStrong, .pricingAllComps, .pricingSelectedComp, .pricingLimited:
            209
        case .runList, .runDetail, .runCompact, .runInterrupted, .runFailed,
             .runRefreshRecovery, .runCancelConfirmation, .runHaulProgress:
            211
        case .reviewIdentity, .reviewCorrectionInput, .reviewCorrectionCandidates,
             .reviewCorrectionImpact, .reviewCorrectionApplying, .reviewCorrectionRetry,
             .reviewCorrectionApplied, .reviewPricingEvidence, .reviewLowEvidence:
            212
        }
    }
}

enum FoundationFixture: String, CaseIterable {
    case home
    case listings
    case inbox
    case insights
    case account
    case activity
    case capture

    var initialTab: PrimaryTab {
        switch self {
        case .home, .account, .activity, .capture: .home
        case .listings: .listings
        case .inbox: .inbox
        case .insights: .insights
        }
    }

    var initialRoute: AppRoute? {
        switch self {
        case .account: .account
        case .activity: .activity
        case .home, .listings, .inbox, .insights, .capture: nil
        }
    }

    var initialSheet: AppSheet? {
        self == .capture ? .capture : nil
    }
}

struct LaunchConfiguration: Equatable {
    var fixture: FoundationFixture
    var visualState: ApprovedVisualStateID?
    var forceReducedMotion: Bool
    var keyboardProbe: Bool
    var dynamicTypeSize: DynamicTypeSize?
    var usesZeroNetworkFixtures: Bool

    static let standard = LaunchConfiguration(
        fixture: .home,
        visualState: nil,
        forceReducedMotion: false,
        keyboardProbe: false,
        dynamicTypeSize: nil,
        usesZeroNetworkFixtures: false
    )

    static let preview = LaunchConfiguration(
        fixture: .home,
        visualState: nil,
        forceReducedMotion: false,
        keyboardProbe: false,
        dynamicTypeSize: nil,
        usesZeroNetworkFixtures: true
    )

    static func parse(arguments: [String]) -> LaunchConfiguration {
        var configuration = standard

        for argument in arguments {
            if argument == "--reduced-motion" {
                configuration.forceReducedMotion = true
            } else if argument == "--keyboard-probe" {
                configuration.keyboardProbe = true
            } else if argument == "--zero-network-fixtures" {
                configuration.usesZeroNetworkFixtures = true
            } else if argument.hasPrefix("--fixture=") {
                let value = String(argument.dropFirst("--fixture=".count))
                configuration.fixture = FoundationFixture(rawValue: value) ?? .home
            } else if argument.hasPrefix("--visual-state=") {
                let value = String(argument.dropFirst("--visual-state=".count))
                configuration.visualState = ApprovedVisualStateID(rawValue: value)
                configuration.usesZeroNetworkFixtures = true
            } else if argument == "--dynamic-type=accessibility3" {
                configuration.dynamicTypeSize = .accessibility3
            }
        }

        return configuration
    }
}
