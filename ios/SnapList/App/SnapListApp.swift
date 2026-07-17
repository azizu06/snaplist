import Foundation
import SwiftUI

@main
struct SnapListApp: App {
    @State private var router: AppRouter
    @State private var onboardingModel: OnboardingFlowModel
    private let configuration: LaunchConfiguration
    private let dependencies: AppDependencies

    init() {
        let configuration = LaunchConfiguration.parse(
            arguments: ProcessInfo.processInfo.arguments
        )
        self.configuration = configuration
        self.dependencies = AppDependencies.make(configuration: configuration)
        _router = State(
            initialValue: AppRouter(
                initialTab: configuration.fixture.initialTab,
                initialRoute: configuration.fixture.initialRoute,
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
    }

    var body: some Scene {
        WindowGroup {
            AppShellView(
                router: router,
                onboardingModel: onboardingModel,
                configuration: configuration
            )
                .environment(\.appDependencies, dependencies)
        }
    }
}
