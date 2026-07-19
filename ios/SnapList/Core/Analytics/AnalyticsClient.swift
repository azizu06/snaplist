import Foundation

enum AnalyticsConsent: String, Codable, Equatable, Sendable {
    case notDetermined = "not_determined"
    case denied
    case granted
}

enum AnalyticsScreen: String, CaseIterable, Sendable {
    case onboarding
    case capture
    case draftReview = "draft_review"
    case paywall
    case publishReview = "publish_review"
}

protocol AnalyticsClient {
    func capture(_ event: AnalyticsEvent)
    func screen(_ screen: AnalyticsScreen)
    func identify(clerkUserID: String)
    func reset()
    func setConsent(_ consent: AnalyticsConsent)
    func flush()
}

protocol AnalyticsConsentStoring: AnyObject {
    var consent: AnalyticsConsent { get }
    func setConsent(_ consent: AnalyticsConsent)
}

protocol AnalyticsDedupeStoring: AnyObject {
    func contains(_ eventID: UUID) -> Bool
    func insert(_ eventID: UUID)
}

final class InMemoryAnalyticsConsentStore: AnalyticsConsentStoring {
    private(set) var consent: AnalyticsConsent

    init(consent: AnalyticsConsent = .notDetermined) {
        self.consent = consent
    }

    func setConsent(_ consent: AnalyticsConsent) {
        self.consent = consent
    }
}

final class InMemoryAnalyticsDedupeStore: AnalyticsDedupeStoring {
    private var eventIDs: Set<UUID>

    init(eventIDs: Set<UUID> = []) {
        self.eventIDs = eventIDs
    }

    func contains(_ eventID: UUID) -> Bool {
        eventIDs.contains(eventID)
    }

    func insert(_ eventID: UUID) {
        eventIDs.insert(eventID)
    }
}

struct NoOpAnalyticsClient: AnalyticsClient {
    func capture(_ event: AnalyticsEvent) {}
    func screen(_ screen: AnalyticsScreen) {}
    func identify(clerkUserID: String) {}
    func reset() {}
    func setConsent(_ consent: AnalyticsConsent) {}
    func flush() {}
}

enum AnalyticsDebugRecord: Equatable, Sendable {
    case payload(AnalyticsPayload)
    case identify
    case reset
    case flush
}

protocol AnalyticsDebugSinking: AnyObject {
    func record(_ record: AnalyticsDebugRecord) throws
}

final class DebugAnalyticsClient: AnalyticsClient, @unchecked Sendable {
    private let metadata: AnalyticsMetadata
    private let consentStore: any AnalyticsConsentStoring
    private let dedupeStore: any AnalyticsDedupeStoring
    private let identityStore: any AnalyticsIdentityStoring
    private let sink: any AnalyticsDebugSinking
    private let sanitizer = AnalyticsSanitizer()
    private let executor = DispatchQueue(
        label: "com.snaplist.analytics.debug",
        qos: .utility
    )

    init(
        metadata: AnalyticsMetadata,
        consentStore: any AnalyticsConsentStoring,
        dedupeStore: any AnalyticsDedupeStoring,
        identityStore: any AnalyticsIdentityStoring,
        sink: any AnalyticsDebugSinking
    ) {
        self.metadata = metadata
        self.consentStore = consentStore
        self.dedupeStore = dedupeStore
        self.identityStore = identityStore
        self.sink = sink
    }

    convenience init(
        metadata: AnalyticsMetadata,
        consentStore: any AnalyticsConsentStoring,
        dedupeStore: any AnalyticsDedupeStoring,
        log: @escaping (String) -> Void = { print($0) }
    ) {
        self.init(
            metadata: metadata,
            consentStore: consentStore,
            dedupeStore: dedupeStore,
            identityStore: InMemoryAnalyticsIdentityStore(),
            sink: ClosureAnalyticsDebugSink(log: log)
        )
    }

    func capture(_ event: AnalyticsEvent) {
        executor.async { [self] in
            guard consentStore.consent == .granted,
                  !dedupeStore.contains(event.eventID),
                  let payload = sanitizer.sanitize(event: event, metadata: metadata) else {
                return
            }
            do {
                try sink.record(.payload(payload))
                dedupeStore.insert(event.eventID)
            } catch {
                // Debug analytics stays best-effort and cannot change a domain result.
            }
        }
    }

    func screen(_ screen: AnalyticsScreen) {
        executor.async { [self] in
            guard consentStore.consent == .granted,
                  let payload = sanitizer.sanitize(screen: screen, metadata: metadata) else {
                return
            }
            try? sink.record(.payload(payload))
        }
    }

    func identify(clerkUserID: String) {
        executor.async { [self] in
            guard consentStore.consent == .granted,
                  identityStore.identity.clerkUserID == nil,
                  AnalyticsIdentity.accepts(clerkUserID: clerkUserID) else {
                return
            }
            do {
                try sink.record(.identify)
                identityStore.identify(clerkUserID: clerkUserID)
            } catch {
                // Debug analytics stays best-effort and cannot change account claim.
            }
        }
    }

    func reset() {
        executor.async { [self] in
            identityStore.reset()
            try? sink.record(.reset)
        }
    }

    func setConsent(_ consent: AnalyticsConsent) {
        consentStore.setConsent(consent)
    }

    func flush() {
        executor.async { [self] in
            guard consentStore.consent == .granted else { return }
            try? sink.record(.flush)
        }
    }

    @discardableResult
    func waitUntilIdleForTesting(timeout: TimeInterval = 2) -> Bool {
        let lock = NSLock()
        var isIdle = false
        executor.async {
            lock.withLock { isIdle = true }
        }
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if lock.withLock({ isIdle }) { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.005))
        }
        return lock.withLock { isIdle }
    }
}

private final class ClosureAnalyticsDebugSink: AnalyticsDebugSinking {
    private let log: (String) -> Void

    init(log: @escaping (String) -> Void) {
        self.log = log
    }

    func record(_ record: AnalyticsDebugRecord) throws {
        switch record {
        case let .payload(payload):
            log("analytics \(payload.name) keys=\(payload.properties.keys.sorted())")
        case .identify:
            log("analytics identify accepted")
        case .reset:
            log("analytics reset")
        case .flush:
            log("analytics flush")
        }
    }
}

private extension AnalyticsEvent {
    var eventID: UUID {
        switch self {
        case let .guestRunStarted(eventID, _),
             let .durableDraftViewed(eventID, _),
             let .correctionOpened(eventID, _),
             let .correctionCompleted(eventID),
             let .paywallViewed(eventID, _),
             let .checkoutFlowStarted(eventID, _, _),
             let .publishIntent(eventID, _):
            eventID
        }
    }
}
