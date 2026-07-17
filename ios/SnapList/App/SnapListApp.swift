import SwiftUI

@main
struct SnapListApp: App {
    @State private var router: AppRouter
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
    }

    var body: some Scene {
        WindowGroup {
            AppShellView(router: router, configuration: configuration)
                .environment(\.appDependencies, dependencies)
        }
    }
}
