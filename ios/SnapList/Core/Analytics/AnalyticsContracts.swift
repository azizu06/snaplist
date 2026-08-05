import Foundation

enum AnalyticsEnvironment: String, Sendable {
    case local
    case testFlight = "testflight"
    case production
}

struct AnalyticsMetadata: Equatable, Sendable {
    let environment: AnalyticsEnvironment
    let appVersion: String
    let build: String

    var isCanonical: Bool {
        appVersion.range(
            of: #"^[0-9]+(?:\.[0-9]+){1,3}$"#,
            options: .regularExpression
        ) != nil && build.range(
            of: #"^[0-9]{1,12}$"#,
            options: .regularExpression
        ) != nil
    }

    static func resolve(
        environment: AnalyticsEnvironment,
        bundle: Bundle = .main
    ) -> AnalyticsMetadata? {
        resolve(environment: environment, infoDictionary: bundle.infoDictionary ?? [:])
    }

    static func resolve(
        environment: AnalyticsEnvironment,
        infoDictionary: [String: Any]
    ) -> AnalyticsMetadata? {
        guard let appVersion = infoDictionary["CFBundleShortVersionString"] as? String,
              let build = infoDictionary["CFBundleVersion"] as? String else {
            return nil
        }
        let metadata = AnalyticsMetadata(
            environment: environment,
            appVersion: appVersion,
            build: build
        )
        return metadata.isCanonical ? metadata : nil
    }
}

enum AnalyticsEntryPoint: String, CaseIterable, Sendable {
    case onboarding
    case capture
    case draftReview = "draft_review"
}

enum AnalyticsAccountState: String, CaseIterable, Sendable {
    case guest
    case authenticated
}

enum AnalyticsPaywallTrigger: String, CaseIterable, Sendable {
    case secondAIItem = "second_ai_item"
    case publish
}

enum AnalyticsCheckoutFlow: String, CaseIterable, Sendable {
    case trial
    case purchase
}

enum AnalyticsBillingCadence: String, CaseIterable, Sendable {
    case monthly
    case annual
}

enum AnalyticsEvent: Equatable, Sendable {
    case guestRunStarted(eventID: UUID, entryPoint: AnalyticsEntryPoint)
    case durableDraftViewed(eventID: UUID, accountState: AnalyticsAccountState)
    case correctionOpened(eventID: UUID, entryPoint: AnalyticsEntryPoint)
    case correctionCompleted(eventID: UUID)
    case paywallViewed(eventID: UUID, trigger: AnalyticsPaywallTrigger)
    case checkoutFlowStarted(
        eventID: UUID,
        flow: AnalyticsCheckoutFlow,
        cadence: AnalyticsBillingCadence
    )
    case publishIntent(eventID: UUID, accountState: AnalyticsAccountState)
    case funnel(eventID: UUID, event: FunnelAnalyticsEvent)
}

enum AnalyticsPropertyValue: Equatable, Sendable {
    case string(String)
}

struct AnalyticsPayload: Equatable, Sendable {
    let name: String
    let properties: [String: String]
}
