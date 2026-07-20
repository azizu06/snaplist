import Foundation
import SwiftUI

@main
struct SnapListApp: App {
    @State private var router: AppRouter
    @State private var onboardingModel: OnboardingFlowModel
    @State private var captureFlow: CaptureFlowModel
    @State private(set) var homeStore: HomeStore
    @State private var runStore: RunDetailStore
    private let pricingRepository: any PricingRepository
    private let configuration: LaunchConfiguration
    private let dependencies: AppDependencies

    init() {
        self.init(
            configuration: LaunchConfiguration.parse(
                arguments: ProcessInfo.processInfo.arguments
            ),
            homeAuthentication: HomeAuthenticationComposition.make()
        )
    }

    init(homeAuthentication: any HomeAuthenticationProviding) {
        self.init(
            configuration: LaunchConfiguration.parse(
                arguments: ProcessInfo.processInfo.arguments
            ),
            homeAuthentication: homeAuthentication
        )
    }

    init(
        configuration: LaunchConfiguration,
        homeAuthentication: any HomeAuthenticationProviding,
        homeAPIOrigin: URL? = HomeRepositoryFactory.defaultAPIOrigin,
        homeURLSession: URLSession = .shared
    ) {
        self.configuration = configuration
        self.dependencies = AppDependencies.make(configuration: configuration)
        self.pricingRepository = PricingRepositoryFactory.make(
            configuration: configuration,
            apiOrigin: homeAPIOrigin,
            authentication: homeAuthentication,
            session: homeURLSession
        )
        _router = State(
            initialValue: AppRouter(
                initialTab: configuration.fixture.initialTab,
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
                store: dependencies.captureDraftStore
            )
        )
        _homeStore = State(
            initialValue: HomeStore(
                repository: HomeRepositoryFactory.make(
                    configuration: configuration,
                    apiOrigin: homeAPIOrigin,
                    authentication: homeAuthentication,
                    session: homeURLSession
                )
            )
        )
        _runStore = State(
            initialValue: RunDetailStoreFactory.make(
                configuration: configuration,
                apiOrigin: homeAPIOrigin,
                authentication: homeAuthentication,
                session: homeURLSession
            )
        )
    }

    var body: some Scene {
        WindowGroup {
            AppShellView(
                router: router,
                onboardingModel: onboardingModel,
                captureFlow: captureFlow,
                homeStore: homeStore,
                runStore: runStore,
                pricingRepository: pricingRepository,
                configuration: configuration
            )
                .environment(\.appDependencies, dependencies)
                .task {
                    async let restoration = captureFlow.restore()
                    async let homeLoad: Void = homeStore.load()
                    router.handleCaptureRestoration(await restoration)
                    await homeLoad
                }
        }
    }
}
