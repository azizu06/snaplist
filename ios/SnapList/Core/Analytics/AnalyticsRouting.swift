import Foundation

struct AnalyticsProviderRoute: Equatable, Sendable {
    let environment: AnalyticsEnvironment
    let projectToken: String
    let host: URL

    init?(
        environment: AnalyticsEnvironment,
        projectToken: String,
        host: URL
    ) {
        let token = projectToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard environment != .local,
              !token.isEmpty,
              host.scheme?.lowercased() == "https",
              host.host?.isEmpty == false,
              host.user == nil,
              host.password == nil,
              host.query == nil,
              host.fragment == nil else {
            return nil
        }
        self.environment = environment
        self.projectToken = token
        self.host = host
    }
}

struct AnalyticsRouteSet: Sendable {
    private let testFlight: AnalyticsProviderRoute
    private let production: AnalyticsProviderRoute

    init?(
        testFlight: AnalyticsProviderRoute,
        production: AnalyticsProviderRoute
    ) {
        guard testFlight.environment == .testFlight,
              production.environment == .production,
              testFlight.projectToken != production.projectToken else {
            return nil
        }
        self.testFlight = testFlight
        self.production = production
    }

    func route(for environment: AnalyticsEnvironment) -> AnalyticsProviderRoute? {
        switch environment {
        case .local: nil
        case .testFlight: testFlight
        case .production: production
        }
    }
}
