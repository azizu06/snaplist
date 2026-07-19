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

protocol AnalyticsTransport: AnyObject {
    func setConsent(granted: Bool) throws
    func capture(_ payload: AnalyticsPayload) throws
    func identify(clerkUserID: String) throws
    func flush() throws
    func reset() throws
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

final class PostHogAnalyticsClient: AnalyticsClient, @unchecked Sendable {
    private let metadata: AnalyticsMetadata
    private let consentStore: any AnalyticsConsentStoring
    private let dedupeStore: any AnalyticsDedupeStoring
    private let transportFactory: @Sendable () -> (any AnalyticsTransport)?
    private let executor = DispatchQueue(
        label: "com.snaplist.analytics.client",
        qos: .utility
    )
    private let sanitizer = AnalyticsSanitizer()
    private var currentConsent: AnalyticsConsent
    private var transport: (any AnalyticsTransport)?
    private var identifiedClerkUserID: String?

    init(
        metadata: AnalyticsMetadata,
        consentStore: any AnalyticsConsentStoring,
        dedupeStore: any AnalyticsDedupeStoring,
        transportFactory: @escaping @Sendable () -> (any AnalyticsTransport)?
    ) {
        self.metadata = metadata
        self.consentStore = consentStore
        self.dedupeStore = dedupeStore
        self.transportFactory = transportFactory
        currentConsent = consentStore.consent
        if currentConsent == .granted {
            executor.async { [self] in
                _ = activatedTransport()
            }
        }
    }

    func capture(_ event: AnalyticsEvent) {
        executor.async { [self] in
            guard currentConsent == .granted,
                  !dedupeStore.contains(event.eventID),
                  let payload = sanitizer.sanitize(event: event, metadata: metadata),
                  let transport = activatedTransport() else {
                return
            }

            do {
                try transport.capture(payload)
                dedupeStore.insert(event.eventID)
            } catch {
                // Analytics is best-effort and must never change a domain result.
            }
        }
    }

    func screen(_ screen: AnalyticsScreen) {
        executor.async { [self] in
            guard currentConsent == .granted,
                  let payload = sanitizer.sanitize(screen: screen, metadata: metadata),
                  let transport = activatedTransport() else {
                return
            }
            try? transport.capture(payload)
        }
    }

    func identify(clerkUserID: String) {
        executor.async { [self] in
            guard currentConsent == .granted,
                  identifiedClerkUserID == nil,
                  Self.isValidClerkUserID(clerkUserID),
                  let transport = activatedTransport() else {
                return
            }
            do {
                try transport.identify(clerkUserID: clerkUserID)
                identifiedClerkUserID = clerkUserID
            } catch {
                // Identity telemetry failure cannot affect account claim.
            }
        }
    }

    func reset() {
        executor.async { [self] in
            if currentConsent == .granted {
                try? transport?.flush()
            }
            try? transport?.reset()
            identifiedClerkUserID = nil
        }
    }

    func setConsent(_ consent: AnalyticsConsent) {
        // The user choice must survive an immediate relaunch even though all SDK work is deferred.
        consentStore.setConsent(consent)
        executor.async { [self] in
            currentConsent = consent
            switch consent {
            case .granted:
                _ = activatedTransport()
            case .denied, .notDetermined:
                try? transport?.setConsent(granted: false)
                try? transport?.reset()
                identifiedClerkUserID = nil
            }
        }
    }

    func flush() {
        executor.async { [self] in
            guard currentConsent == .granted else { return }
            try? transport?.flush()
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

    private func activatedTransport() -> (any AnalyticsTransport)? {
        guard currentConsent == .granted else { return nil }
        if transport == nil {
            transport = transportFactory()
            try? transport?.setConsent(granted: true)
        }
        return transport
    }

    private static func isValidClerkUserID(_ value: String) -> Bool {
        value.range(of: #"^user_[A-Za-z0-9]+$"#, options: .regularExpression) != nil
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
