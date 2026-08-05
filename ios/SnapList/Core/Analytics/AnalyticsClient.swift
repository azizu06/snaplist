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
    func setConsent(_ consent: AnalyticsConsent) throws
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

    init(consent: AnalyticsConsent = .granted) {
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
    private let consentStore: any AnalyticsConsentStoring

    init(
        consentStore: any AnalyticsConsentStoring = UserDefaultsAnalyticsConsentStore()
    ) {
        self.consentStore = consentStore
    }

    func capture(_ event: AnalyticsEvent) {}
    func screen(_ screen: AnalyticsScreen) {}
    func identify(clerkUserID: String) {}
    func reset() {}
    func setConsent(_ consent: AnalyticsConsent) {
        consentStore.setConsent(consent)
    }
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

final class AnalyticsSerialExecutor: @unchecked Sendable {
    private let consentTransitionDidSubmit: @Sendable (AnalyticsConsent) -> Void
    private let consentTransitionDidEnterSerializedBoundary: @Sendable (AnalyticsConsent) -> Void
    private let key = DispatchSpecificKey<Void>()
    private let queue = DispatchQueue(
        label: "com.snaplist.analytics.debug",
        qos: .utility
    )

    init(
        consentTransitionDidSubmit: @escaping @Sendable (AnalyticsConsent) -> Void,
        consentTransitionDidEnterSerializedBoundary: @escaping @Sendable (AnalyticsConsent) -> Void
    ) {
        self.consentTransitionDidSubmit = consentTransitionDidSubmit
        self.consentTransitionDidEnterSerializedBoundary = consentTransitionDidEnterSerializedBoundary
        queue.setSpecific(key: key, value: ())
    }

    func async(_ operation: @escaping @Sendable () -> Void) {
        queue.async(execute: operation)
    }

    func finishPendingWork() {
        guard DispatchQueue.getSpecific(key: key) == nil else { return }
        queue.sync {}
    }

    func serializeConsentTransition(
        _ consent: AnalyticsConsent,
        operation: @escaping @Sendable () throws -> Void
    ) throws {
        if DispatchQueue.getSpecific(key: key) != nil {
            consentTransitionDidSubmit(consent)
            consentTransitionDidEnterSerializedBoundary(consent)
            try operation()
            return
        }

        consentTransitionDidSubmit(consent)
        try queue.sync { [consentTransitionDidEnterSerializedBoundary] in
            consentTransitionDidEnterSerializedBoundary(consent)
            try operation()
        }
    }
}

final class DebugAnalyticsClient: AnalyticsClient, @unchecked Sendable {
    private let metadata: AnalyticsMetadata
    private let consentStore: any AnalyticsConsentStoring
    private let dedupeStore: any AnalyticsDedupeStoring
    private let identityStore: any AnalyticsIdentityStoring
    private let sink: any AnalyticsDebugSinking
    private let executor: AnalyticsSerialExecutor
    private let sanitizer = AnalyticsSanitizer()

    init(
        metadata: AnalyticsMetadata,
        consentStore: any AnalyticsConsentStoring,
        dedupeStore: any AnalyticsDedupeStoring,
        identityStore: any AnalyticsIdentityStoring,
        sink: any AnalyticsDebugSinking,
        consentTransitionDidSubmit: @escaping @Sendable (AnalyticsConsent) -> Void = { _ in },
        consentTransitionDidEnterSerializedBoundary: @escaping @Sendable (AnalyticsConsent) -> Void = { _ in }
    ) {
        self.metadata = metadata
        self.consentStore = consentStore
        self.dedupeStore = dedupeStore
        self.identityStore = identityStore
        self.sink = sink
        executor = AnalyticsSerialExecutor(
            consentTransitionDidSubmit: consentTransitionDidSubmit,
            consentTransitionDidEnterSerializedBoundary: consentTransitionDidEnterSerializedBoundary
        )
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
        try? executor.serializeConsentTransition(consent) { [self] in
            consentStore.setConsent(consent)
        }
    }

    func flush() {
        executor.async { [self] in
            guard consentStore.consent == .granted else { return }
            try? sink.record(.flush)
        }
    }

    func finishPendingWorkForTesting() {
        executor.finishPendingWork()
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

extension AnalyticsEvent {
    var eventID: UUID {
        switch self {
        case let .guestRunStarted(eventID, _),
             let .durableDraftViewed(eventID, _),
             let .correctionOpened(eventID, _),
             let .correctionCompleted(eventID),
             let .paywallViewed(eventID, _),
             let .checkoutFlowStarted(eventID, _, _),
             let .publishIntent(eventID, _),
             let .funnel(eventID, _):
            eventID
        }
    }
}
