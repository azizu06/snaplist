import Foundation

/// Launch-funnel vocabulary. This is the only place native funnel event names
/// and property names are defined; transition call sites use typed cases only.
enum FunnelAnalyticsConstants {
    enum EventName {
        static let scanStarted = "scan started"
        static let intakeSubmitted = "intake submitted"
        static let listingReadyToReview = "listing ready to review"
        static let accountClaimed = "account claimed"
        static let ebayPublishConfirmed = "ebay publish confirmed"
        static let exportPackShared = "export pack shared"
    }

    enum PropertyName {
        static let eventID = "event_id"
    }
}

enum FunnelAnalyticsEvent: Equatable, Sendable, CaseIterable {
    case scanStarted
    case intakeSubmitted
    case listingReadyToReview
    case accountClaimed
    case ebayPublishConfirmed
    case exportPackShared

    var name: String {
        switch self {
        case .scanStarted: FunnelAnalyticsConstants.EventName.scanStarted
        case .intakeSubmitted: FunnelAnalyticsConstants.EventName.intakeSubmitted
        case .listingReadyToReview: FunnelAnalyticsConstants.EventName.listingReadyToReview
        case .accountClaimed: FunnelAnalyticsConstants.EventName.accountClaimed
        case .ebayPublishConfirmed: FunnelAnalyticsConstants.EventName.ebayPublishConfirmed
        case .exportPackShared: FunnelAnalyticsConstants.EventName.exportPackShared
        }
    }

    static var allCases: [FunnelAnalyticsEvent] {
        [
            .scanStarted,
            .intakeSubmitted,
            .listingReadyToReview,
            .accountClaimed,
            .ebayPublishConfirmed,
            .exportPackShared,
        ]
    }
}

protocol FunnelAnalyticsEventSinking: AnyObject {
    func record(_ event: FunnelAnalyticsEvent, eventID: UUID)
    func alias(clerkUserID: String)
}

final class AnalyticsFunnelEventSink: FunnelAnalyticsEventSinking {
    private let client: any AnalyticsClient

    init(client: any AnalyticsClient) {
        self.client = client
    }

    func record(_ event: FunnelAnalyticsEvent, eventID: UUID) {
        client.capture(.funnel(eventID: eventID, event: event))
    }

    func alias(clerkUserID: String) {
        client.identify(clerkUserID: clerkUserID)
    }
}

final class NoOpFunnelAnalyticsEventSink: FunnelAnalyticsEventSinking {
    func record(_ event: FunnelAnalyticsEvent, eventID: UUID) {}
    func alias(clerkUserID: String) {}
}
