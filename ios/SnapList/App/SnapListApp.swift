import Foundation
import SwiftUI

@main
struct SnapListApp: App {
    @State private var router: AppRouter
    @State private var onboardingModel: OnboardingFlowModel
    @State private var captureFlow: CaptureFlowModel
    @State private(set) var homeStore: HomeStore
    @State private var trophyWallStore: TrophyWallStore
    @State private var runStore: RunDetailStore
    @State private var listingReviewStore: ListingReviewStore
    @State private var submissionHost: ItemRunSubmissionHost
    private let configuration: LaunchConfiguration
    private let dependencies: AppDependencies
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
        self.init(
            configuration: LaunchConfiguration.parse(
                arguments: ProcessInfo.processInfo.arguments
            ),
            tokenProvider: ClerkAuthenticationComposition.make(
                publishableKey: nativeConfiguration.clerkPublishableKey
            ),
            apiOrigin: nativeConfiguration.apiOrigin
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
        urlSession: URLSession = .shared
    ) {
        self.configuration = configuration
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
            dependencies.stagedLibraryPhotos.clear()
        }
        if let count = configuration.stagedLibraryPhotoFixtureCount, count > 0 {
            let photos = (0..<count).map { Data("fixture-photo-\($0)".utf8) }
            onboardingModel.didStageLibraryPhotos(photos)
        } else if configuration.visualState == nil && !configuration.usesZeroNetworkFixtures {
            onboardingModel.restorePersistedProgress()
        }
        _onboardingModel = State(initialValue: onboardingModel)
        _captureFlow = State(
            initialValue: CaptureFlowModel(
                camera: dependencies.captureCamera,
                evaluator: dependencies.framingEvaluator,
                intake: dependencies.nativeIntake,
                funnelAnalytics: dependencies.funnelAnalytics
            )
        )
        _homeStore = State(
            initialValue: HomeStore(
                repository: HomeRepositoryFactory.make(
                    configuration: configuration,
                    apiOrigin: apiOrigin,
                    tokenProvider: tokenProvider,
                    session: urlSession
                )
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
                captureFlow: captureFlow,
                homeStore: homeStore,
                trophyWallStore: trophyWallStore,
                runStore: runStore,
                listingReviewStore: listingReviewStore,
                submissionHost: submissionHost,
                trophyWallHistoryRepository: trophyWallHistoryRepository,
                configuration: configuration
            )
                .environment(\.appDependencies, dependencies)
                .task {
#if DEBUG
                    await dependencies
                        .seedRestoredCaptureFixtureIfNeeded(
                            configuration: configuration
                        )
#endif
                    async let restoration = captureFlow.restore()
                    async let homeLoad: Void = loadLegacyHomeFixtureIfNeeded()
                    router.handleCaptureRestoration(await restoration)
                    await homeLoad
                }
        }
    }

    @MainActor
    private func loadLegacyHomeFixtureIfNeeded() async {
#if DEBUG
        guard configuration.visualState?.ownerIssue == 208 else { return }
        await homeStore.load()
#endif
    }
}
