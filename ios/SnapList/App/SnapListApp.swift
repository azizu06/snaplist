import Foundation
import SwiftUI

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
                initialRoute: configuration.initialRoute,
                initialSheet: configuration.fixture.initialSheet
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
            let photos = (0..<count).map { Data("fixture-photo-\($0)".utf8) }
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
#if DEBUG
                    await dependencies
                        .seedRestoredCaptureFixtureIfNeeded(
                            configuration: configuration
                        )
#endif
                    let restoration = await captureFlow.restore()
                    if restoration == .stagedPhoto {
                        firstValueOnboardingModel.reconcileExistingProgress()
                    }
                    router.handleCaptureRestoration(restoration)
                }
        }
    }
}
