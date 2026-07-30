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
    case scanCameraFirstUse = "CAM-01"
    case scanCameraReturning = "CAM-02"
    case scanCameraPhotos = "CAM-03"
    case scanCameraCapped = "CAM-04"
    case scanCameraUnavailable = "CAM-V1"
    case scanCameraDenied = "CAM-V2"
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
        case .scanCameraFirstUse, .scanCameraReturning, .scanCameraPhotos,
             .scanCameraCapped, .scanCameraUnavailable, .scanCameraDenied:
            424
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
    case onboarding
    case home
    case trophyProcessing = "trophy-processing"
    case listings
    case inbox
    case insights
    case account
    case activity
    case capture

    var initialTab: PrimaryTab {
        switch self {
        case .onboarding, .home, .trophyProcessing, .account, .activity, .capture: .home
        case .listings: .listings
        case .inbox: .inbox
        case .insights: .insights
        }
    }

    var initialRoute: AppRoute? {
        switch self {
        case .account: .account
        case .activity: .activity
        case .onboarding, .home, .trophyProcessing,
             .listings, .inbox, .insights, .capture:
            nil
        }
    }

    var initialSheet: AppSheet? {
        self == .capture ? .capture : nil
    }
}

enum RunDetailFixture: String, Equatable {
    case unavailable
    case loaded
    case refresh
    case failed
    case canceled
    case completed
    case reviewable
}

enum ListingReviewFixture: String, Equatable {
    case loaded
    case zeroEvidence = "zero-evidence"
    case fiveEvidence = "five-evidence"
    case saveFailure = "save-failure"
    case offline
    case conflict
    case correctionUnavailable = "correction-unavailable"
    case longText = "long-text"
}

enum SubmissionFixture: String, Equatable {
    case delayed
    case acceptedPresentationGated = "accepted-presentation-gated"
    case rateLimited = "rate-limited"
}

struct SubmissionAcknowledgmentNotificationName: Equatable {
    static let prefix = "dev.snaplist.ios.test.submission-ack."

    let rawValue: String

    init?(rawValue: String) {
        guard rawValue.hasPrefix(Self.prefix),
              rawValue.count > Self.prefix.count else {
            return nil
        }
        self.rawValue = rawValue
    }
}

enum PhotoReviewVisualStateID: String, Equatable {
    case onePhoto = "REV-01"
    case resting = "REV-02"
    case fivePhotos = "REV-03"
    case actionsOpen = "REV-04"

    var photoCount: Int {
        switch self {
        case .onePhoto:
            1
        case .resting, .actionsOpen:
            3
        case .fivePhotos:
            PhotoReviewCapacityPolicy.photoLimit
        }
    }

    var selectedPhotoIndex: Int {
        switch self {
        case .resting, .actionsOpen:
            1
        case .onePhoto, .fivePhotos:
            0
        }
    }

    var presentsActions: Bool {
        self == .actionsOpen
    }
}

struct LaunchConfiguration: Equatable {
    static let runDetailFixtureID = UUID(
        uuidString: "20800000-0000-4000-8000-000000000020"
    )!

    var fixture: FoundationFixture
    var visualState: ApprovedVisualStateID?
    var photoReviewState: PhotoReviewVisualStateID?
    var forceReducedMotion: Bool
    var keyboardProbe: Bool
    var dynamicTypeSize: DynamicTypeSize?
    var usesZeroNetworkFixtures: Bool
    var cameraAuthorizationFixture: CameraAuthorizationStatus?
    var resetOnboardingProgress: Bool
    var stagedLibraryPhotoFixtureCount: Int?
    var usesRestoredCaptureFixture: Bool
    var submissionFixture: SubmissionFixture?
    var submissionAcknowledgmentNotification:
        SubmissionAcknowledgmentNotificationName?
    var runDetailFixture: RunDetailFixture?
    var listingReviewFixture: ListingReviewFixture?
    var resetListingReviewDraft: Bool

    static let standard = LaunchConfiguration(
        fixture: .onboarding,
        visualState: nil,
        photoReviewState: nil,
        forceReducedMotion: false,
        keyboardProbe: false,
        dynamicTypeSize: nil,
        usesZeroNetworkFixtures: false,
        cameraAuthorizationFixture: nil,
        resetOnboardingProgress: false,
        stagedLibraryPhotoFixtureCount: nil,
        usesRestoredCaptureFixture: false,
        submissionFixture: nil,
        submissionAcknowledgmentNotification: nil,
        runDetailFixture: nil,
        listingReviewFixture: nil,
        resetListingReviewDraft: false
    )

    static let preview = LaunchConfiguration(
        fixture: .home,
        visualState: nil,
        photoReviewState: nil,
        forceReducedMotion: false,
        keyboardProbe: false,
        dynamicTypeSize: nil,
        usesZeroNetworkFixtures: true,
        cameraAuthorizationFixture: .authorized,
        resetOnboardingProgress: false,
        stagedLibraryPhotoFixtureCount: nil,
        usesRestoredCaptureFixture: false,
        submissionFixture: nil,
        submissionAcknowledgmentNotification: nil,
        runDetailFixture: .loaded,
        listingReviewFixture: nil,
        resetListingReviewDraft: false
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
            } else if argument == "--reset-onboarding-progress" {
                configuration.resetOnboardingProgress = true
            } else if argument.hasPrefix("--fixture-staged-library-photos=") {
                let value = String(
                    argument.dropFirst("--fixture-staged-library-photos=".count)
                )
                configuration.stagedLibraryPhotoFixtureCount = Int(value).map { min(max($0, 0), 4) }
            } else if argument == "--restored-capture-fixture" {
                configuration.usesRestoredCaptureFixture = true
                configuration.usesZeroNetworkFixtures = true
            } else if argument.hasPrefix("--submission-fixture=") {
                let value = String(
                    argument.dropFirst("--submission-fixture=".count)
                )
                configuration.submissionFixture = SubmissionFixture(rawValue: value)
#if DEBUG
                if configuration.submissionFixture != nil {
                    configuration.usesZeroNetworkFixtures = true
                }
#endif
            } else if argument.hasPrefix(
                "--submission-acknowledgment-notification="
            ) {
                let value = String(
                    argument.dropFirst(
                        "--submission-acknowledgment-notification=".count
                    )
                )
                configuration.submissionAcknowledgmentNotification =
                    SubmissionAcknowledgmentNotificationName(rawValue: value)
            } else if argument.hasPrefix("--fixture=") {
                let value = String(argument.dropFirst("--fixture=".count))
                configuration.fixture = FoundationFixture(rawValue: value) ?? .home
            } else if argument.hasPrefix("--visual-state=") {
                let value = String(argument.dropFirst("--visual-state=".count))
                configuration.visualState = ApprovedVisualStateID(rawValue: value)
                configuration.usesZeroNetworkFixtures = true
                if configuration.visualState == .runDetail {
                    configuration.runDetailFixture = .loaded
                }
            } else if argument.hasPrefix("--photo-review-state=") {
                let value = String(argument.dropFirst("--photo-review-state=".count))
                configuration.photoReviewState = PhotoReviewVisualStateID(rawValue: value)
                configuration.usesZeroNetworkFixtures = true
            } else if argument.hasPrefix("--camera-status=") {
                let value = String(argument.dropFirst("--camera-status=".count))
                configuration.cameraAuthorizationFixture = CameraAuthorizationStatus(rawValue: value)
            } else if argument == "--dynamic-type=accessibility5" {
                // The largest supported size. Photo Review's hero and thumbnail strip are
                // fixed, so text is the only thing that lengthens the page; a scroll proof
                // there needs the widest text metrics available.
                configuration.dynamicTypeSize = .accessibility5
            } else if argument == "--dynamic-type=accessibility3" {
                configuration.dynamicTypeSize = .accessibility3
            } else if argument == "--dynamic-type=xSmall" {
                // The smallest supported size is where a touch target derived from text
                // height, rather than from the 44pt floor, is thinnest.
                configuration.dynamicTypeSize = .xSmall
            } else if argument == "--dynamic-type=medium" {
                configuration.dynamicTypeSize = .medium
            } else if argument.hasPrefix("--run-detail-fixture=") {
                let value = String(argument.dropFirst("--run-detail-fixture=".count))
                configuration.runDetailFixture = RunDetailFixture(rawValue: value)
            } else if argument.hasPrefix("--listing-review-fixture=") {
                let value = String(
                    argument.dropFirst("--listing-review-fixture=".count)
                )
                configuration.listingReviewFixture =
                    ListingReviewFixture(rawValue: value)
            } else if argument == "--reset-listing-review-draft" {
                configuration.resetListingReviewDraft = true
            }
        }

        return configuration
    }

    var usesOnboarding: Bool {
        if photoReviewState != nil {
            return false
        }
        if let visualState {
            return visualState.ownerIssue == 206
        }
        return fixture == .onboarding
    }

    var initialRoute: AppRoute? {
        if visualState == .runDetail {
            return .home(.run(Self.runDetailFixtureID))
        }
        return fixture.initialRoute
    }

    var initialOnboardingState: OnboardingFlowState {
        guard let visualState,
              let screen = OnboardingScreen(visualState: visualState) else {
            return .init()
        }

        let overlay: OnboardingOverlay?
        switch visualState {
        case .onboardingMarketplace:
            overlay = .marketplace
        case .returningSignIn:
            overlay = .returningSignIn
        default:
            overlay = nil
        }

        return OnboardingFlowState(
            screen: screen,
            overlay: overlay,
            stagedPhotoCount: visualState == .onboardingLibraryHandoff ? 1 : 0
        )
    }

    var shouldRequestCameraOnLaunch: Bool {
        visualState == .nativeCameraPermission
    }

    var shouldOpenSettingsOnLaunch: Bool {
        visualState == .settingsHandoff
    }
}
