import Foundation
import SwiftUI
#if DEBUG
import UIKit
#endif

@main
struct SnapListApp: App {
    @State private var router: AppRouter
    @State private var onboardingModel: OnboardingFlowModel
    @State private var firstValueOnboardingModel: FirstValueOnboardingModel
    @State private var captureFlow: CaptureFlowModel
    @State private var trophyWallStore: TrophyWallStore
    @State private var runStore: RunDetailStore
    @State private var listingReviewStore: ListingReviewStore
    @State private var submissionHost: ItemRunSubmissionHost
    private let configuration: LaunchConfiguration
    private let dependencies: AppDependencies
    private let guestCapabilityComposition:
        AppAttestGuestCapabilityComposition?
    private let trophyWallHistoryRepository: any TrophyWallRunHistoryRepository
    private let startIncludedOfferRedemption: @MainActor @Sendable () -> Void

    init() {
        // First statement in the real app entry point so a crash while the
        // dependency graph is still being built is still reported.
        CrashReporting.start()
        let environment = ProcessInfo.processInfo.environment
        let nativeConfiguration: NativeAppConfiguration
        do {
            nativeConfiguration = try NativeAppConfiguration.resolve(
                environment: environment,
                apiOriginBundleValue: Bundle.main.object(
                    forInfoDictionaryKey: "SnapListAPIOrigin"
                ) as? String,
                clerkPublishableKeyBundleValue: Bundle.main.object(
                    forInfoDictionaryKey: "SnapListClerkPublishableKey"
                ) as? String,
                allowsLocalDevelopment: Self.allowsLocalDevelopment
            )
        } catch {
            fatalError("Invalid SnapList native configuration: \(error)")
        }
        let baseTokenProvider = ClerkAuthenticationComposition.make(
            publishableKey: nativeConfiguration.clerkPublishableKey
        )
        let configuration = LaunchConfiguration.parse(
            arguments: ProcessInfo.processInfo.arguments
        )
        let guestCapabilityComposition = configuration.usesZeroNetworkFixtures
            ? nil
            : AppAttestGuestCapabilityComposition.makeLive(
                apiOrigin: nativeConfiguration.apiOrigin,
                baseTokenProvider: baseTokenProvider
            )
        self.init(
            configuration: configuration,
            tokenProvider: guestCapabilityComposition?.tokenProvider
                ?? baseTokenProvider,
            apiOrigin: nativeConfiguration.apiOrigin,
            guestCapabilityComposition: guestCapabilityComposition
        )
    }

    init(tokenProvider: any BearerTokenProviding) {
        self.init(
            configuration: LaunchConfiguration.parse(
                arguments: ProcessInfo.processInfo.arguments
            ),
            tokenProvider: tokenProvider
        )
    }

    init(
        configuration: LaunchConfiguration,
        tokenProvider: any BearerTokenProviding,
        apiOrigin: URL? = HomeRepositoryFactory.defaultAPIOrigin,
        urlSession: URLSession = .shared,
        guestCapabilityComposition:
            AppAttestGuestCapabilityComposition? = nil
    ) {
        self.configuration = configuration
        self.guestCapabilityComposition = guestCapabilityComposition
        if let apiOrigin, !configuration.usesZeroNetworkFixtures {
            startIncludedOfferRedemption = {
                ClerkAuthenticationComposition.beginIncludedOfferRedemption(
                    apiOrigin: apiOrigin,
                    tokenProvider: tokenProvider,
                    session: urlSession
                )
            }
        } else {
            // Gated the way the guest-side capability is: a fixture launch has
            // no network to reach the fence with and no real account to redeem
            // for.
            startIncludedOfferRedemption = {}
        }
        self.dependencies = AppDependencies.make(
            configuration: configuration,
            apiOrigin: apiOrigin,
            tokenProvider: tokenProvider,
            nativeIntakeIdentitySource:
                ClerkAuthenticationComposition.makeNativeIntakeIdentitySource(),
            session: urlSession
        )
        let trophyWallPrincipal = TrophyWallPrincipalScope(
            opaqueValue: UUID().uuidString.lowercased()
        )
        _trophyWallStore = State(
            initialValue: TrophyWallStoreFactory.make(
                configuration: configuration,
                principalScope: trophyWallPrincipal
            )
        )
        trophyWallHistoryRepository = TrophyWallRunHistoryRepositoryFactory.make(
            configuration: configuration,
            apiOrigin: apiOrigin,
            tokenProvider: tokenProvider,
            session: urlSession
        )
        _router = State(
            initialValue: AppRouter(
                initialTab: configuration.initialTab,
                initialRoute: configuration.initialRoute
            )
        )
        let onboardingModel = OnboardingFlowModel(
            state: configuration.initialOnboardingState,
            cameraAuthorization: dependencies.cameraAuthorization,
            progressStore: dependencies.onboardingProgressStore,
            stagedLibraryPhotos: dependencies.stagedLibraryPhotos,
            guestAllowance: dependencies.guestAllowance
        )
        if configuration.resetOnboardingProgress {
            dependencies.onboardingProgressStore.clear()
            dependencies.firstValueOnboardingCompletionStore.clear()
            dependencies.stagedLibraryPhotos.clear()
        }
        if configuration.resetActivationGuidance {
            for key in UserDefaults.standard.dictionaryRepresentation().keys
            where key.hasPrefix("snaplist.activation-guidance-completed-v1.")
                || key.hasPrefix("snaplist.activation-guidance-progress-v1.")
                || key == "snaplist.fixture-activation-guidance-completed" {
                UserDefaults.standard.removeObject(forKey: key)
            }
        }
        if let count = configuration.stagedLibraryPhotoFixtureCount, count > 0 {
            // Real, decodable JPEG bytes, not placeholder text (#864): the
            // eventual capture handoff decodes this data as an image
            // (`captureFlow.stageLibraryPhoto`), so non-image bytes silently
            // fail to stage and a relaunch that should land the seller on
            // their staged photo instead reaches an empty camera. Matches the
            // fixture image already generated for `--restored-capture-fixture`
            // in `AppDependencies.seedRestoredCaptureFixtureIfNeeded`.
            let photos = Self.stagedLibraryPhotoFixtureImages(count: count)
            onboardingModel.didStageLibraryPhotos(photos)
        } else if configuration.visualState == nil && !configuration.usesZeroNetworkFixtures {
            onboardingModel.restorePersistedProgress()
        }
        if onboardingModel.state.screen.hasCompletedLegacyIntro,
           dependencies.firstValueOnboardingCompletionStore.outcome == nil {
            // Restored progress already past the retired intro: the six screens were
            // never shown, and the recorded outcome must not claim otherwise.
            dependencies.firstValueOnboardingCompletionStore
                .record(.supersededByExistingProgress)
        }
        let firstValueOnboardingModel = FirstValueOnboardingModel(
            screen: configuration.initialFirstValueOnboardingScreen,
            completionStore: dependencies.firstValueOnboardingCompletionStore
        )
        _firstValueOnboardingModel = State(initialValue: firstValueOnboardingModel)
        _onboardingModel = State(initialValue: onboardingModel)
        _captureFlow = State(
            initialValue: CaptureFlowModel(
                camera: dependencies.captureCamera,
                evaluator: dependencies.framingEvaluator,
                intake: dependencies.nativeIntake,
                funnelAnalytics: dependencies.funnelAnalytics
            )
        )
        _runStore = State(
            initialValue: RunDetailStoreFactory.make(
                configuration: configuration,
                apiOrigin: apiOrigin,
                tokenProvider: tokenProvider,
                session: urlSession,
                funnelAnalytics: dependencies.funnelAnalytics
            )
        )
        _listingReviewStore = State(
            initialValue: ListingReviewStoreFactory.make(
                configuration: configuration,
                apiOrigin: apiOrigin,
                tokenProvider: tokenProvider,
                session: urlSession
            )
        )
        _submissionHost = State(
            initialValue: ItemRunSubmissionHostFactory.make(
                configuration: configuration,
                apiOrigin: apiOrigin,
                tokenProvider: tokenProvider,
                session: urlSession,
                draftStore: dependencies.captureDraftStore,
                funnelAnalytics: dependencies.funnelAnalytics
            )
        )
    }

    private static var allowsLocalDevelopment: Bool {
#if DEBUG
        true
#else
        false
#endif
    }

    /// `count` real, decodable JPEG images for `--fixture-staged-library-photos=`.
    ///
    /// `stagedLibraryPhotoFixtureCount` only ever comes from a DEBUG-only launch
    /// argument (`LaunchConfiguration.parse` is itself `#if DEBUG`), so this
    /// path never runs in a release build.
    private static func stagedLibraryPhotoFixtureImages(count: Int) -> [Data] {
#if DEBUG
        let fixtureColors: [(background: UIColor, subject: UIColor)] = [
            (
                UIColor(red: 0.91, green: 0.90, blue: 0.88, alpha: 1),
                UIColor(red: 0.76, green: 0.74, blue: 0.70, alpha: 1)
            ),
            (
                UIColor(red: 0.84, green: 0.82, blue: 0.78, alpha: 1),
                UIColor(red: 0.58, green: 0.55, blue: 0.50, alpha: 1)
            ),
            (
                UIColor(red: 0.45, green: 0.56, blue: 0.64, alpha: 1),
                UIColor(red: 0.23, green: 0.31, blue: 0.37, alpha: 1)
            )
        ]
        return (0..<count).compactMap { index -> Data? in
            let renderer = UIGraphicsImageRenderer(
                size: CGSize(width: 16, height: 16)
            )
            let colors = fixtureColors[index % fixtureColors.count]
            return renderer.jpegData(withCompressionQuality: 0.9) { context in
                colors.background.setFill()
                context.fill(CGRect(x: 0, y: 0, width: 16, height: 16))
                colors.subject.setFill()
                context.fill(CGRect(x: 4, y: 3, width: 8, height: 10))
            }
        }
#else
        []
#endif
    }

    var body: some Scene {
        WindowGroup {
            AppShellView(
                router: router,
                onboardingModel: onboardingModel,
                firstValueOnboardingModel: firstValueOnboardingModel,
                captureFlow: captureFlow,
                trophyWallStore: trophyWallStore,
                runStore: runStore,
                listingReviewStore: listingReviewStore,
                submissionHost: submissionHost,
                trophyWallHistoryRepository: trophyWallHistoryRepository,
                configuration: configuration
            )
                .environment(\.appDependencies, dependencies)
                .task {
                    guestCapabilityComposition?.beginLaunchEnrollment()
                    startIncludedOfferRedemption()
#if DEBUG
                    await dependencies
                        .seedRestoredCaptureFixtureIfNeeded(
                            configuration: configuration
                        )
                    if configuration.resetCaptureDraft {
                        // Both `LocalCaptureDraftStore` and `NativeIntake` are
                        // deliberately durable across relaunches (the
                        // seller's staged photo must survive one), so a UI
                        // test that reaches the camera through either real,
                        // file-backed store otherwise inherits whatever an
                        // earlier test in the same shard invocation staged
                        // and never tore down. `CaptureFlowModel.restore()`
                        // reads from `NativeIntake` whenever intake is
                        // non-nil, which it always is outside the isolated
                        // `--restored-capture-fixture` store (#864).
                        try? await dependencies.captureDraftStore.discard()
                        await dependencies.nativeIntake.discardAllForTesting()
                    }
#endif
                    let restoration = await captureFlow.restore()
                    if restoration == .stagedPhoto {
                        firstValueOnboardingModel.reconcileExistingProgress()
                    }
                    router.handleCaptureRestoration(restoration)
                    if restoration == .stagedPhoto {
                        // `restore()` lands a staged photo on `.captured`, not a
                        // live session (there is no more launcher sheet whose
                        // dismiss handler used to start it). Start it here, or a
                        // seller who removes the last photo after relaunching is
                        // stuck on "Preparing camera" with no recovery (#864).
                        await captureFlow.startCamera()
                    }
                }
        }
    }
}
