import SwiftUI

private struct AppDependenciesKey: EnvironmentKey {
    static let defaultValue = AppDependencies.make(configuration: .preview)
}

extension EnvironmentValues {
    var appDependencies: AppDependencies {
        get { self[AppDependenciesKey.self] }
        set { self[AppDependenciesKey.self] = newValue }
    }
}
