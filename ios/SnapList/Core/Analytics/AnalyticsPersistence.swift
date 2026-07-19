import Foundation

struct AnalyticsIdentity: Equatable, Sendable {
    let anonymousID: UUID
    let clerkUserID: String?

    static func accepts(clerkUserID: String) -> Bool {
        clerkUserID.range(
            of: #"^user_[A-Za-z0-9]+$"#,
            options: .regularExpression
        ) != nil
    }
}

protocol AnalyticsIdentityStoring: AnyObject {
    var identity: AnalyticsIdentity { get }
    @discardableResult func identify(clerkUserID: String) -> Bool
    func reset()
}

final class InMemoryAnalyticsIdentityStore: AnalyticsIdentityStoring {
    private let lock = NSLock()
    private var value: AnalyticsIdentity

    init(identity: AnalyticsIdentity = AnalyticsIdentity(anonymousID: UUID(), clerkUserID: nil)) {
        value = identity
    }

    var identity: AnalyticsIdentity { lock.withLock { value } }

    @discardableResult
    func identify(clerkUserID: String) -> Bool {
        guard AnalyticsIdentity.accepts(clerkUserID: clerkUserID) else { return false }
        return lock.withLock {
            guard value.clerkUserID == nil else { return false }
            value = AnalyticsIdentity(anonymousID: value.anonymousID, clerkUserID: clerkUserID)
            return true
        }
    }

    func reset() {
        lock.withLock {
            value = AnalyticsIdentity(anonymousID: UUID(), clerkUserID: nil)
        }
    }
}

final class UserDefaultsAnalyticsIdentityStore: AnalyticsIdentityStoring {
    private let defaults: UserDefaults
    private let anonymousIDKey: String
    private let clerkUserIDKey: String
    private let lock = NSLock()

    init(
        defaults: UserDefaults = .standard,
        anonymousIDKey: String = "snaplist.analytics.anonymous_id.v1",
        clerkUserIDKey: String = "snaplist.analytics.clerk_user_id.v1"
    ) {
        self.defaults = defaults
        self.anonymousIDKey = anonymousIDKey
        self.clerkUserIDKey = clerkUserIDKey
        lock.withLock {
            if storedAnonymousID() == nil {
                defaults.set(UUID().uuidString.lowercased(), forKey: anonymousIDKey)
            }
        }
    }

    var identity: AnalyticsIdentity {
        lock.withLock {
            let anonymousID = storedAnonymousID() ?? UUID()
            return AnalyticsIdentity(
                anonymousID: anonymousID,
                clerkUserID: defaults.string(forKey: clerkUserIDKey)
            )
        }
    }

    @discardableResult
    func identify(clerkUserID: String) -> Bool {
        guard AnalyticsIdentity.accepts(clerkUserID: clerkUserID) else { return false }
        return lock.withLock {
            guard defaults.string(forKey: clerkUserIDKey) == nil else { return false }
            defaults.set(clerkUserID, forKey: clerkUserIDKey)
            return true
        }
    }

    func reset() {
        lock.withLock {
            defaults.set(UUID().uuidString.lowercased(), forKey: anonymousIDKey)
            defaults.removeObject(forKey: clerkUserIDKey)
        }
    }

    private func storedAnonymousID() -> UUID? {
        defaults.string(forKey: anonymousIDKey).flatMap(UUID.init(uuidString:))
    }
}

final class UserDefaultsAnalyticsConsentStore: AnalyticsConsentStoring {
    private let defaults: UserDefaults
    private let key: String

    init(
        defaults: UserDefaults = .standard,
        key: String = "snaplist.analytics.consent.v1"
    ) {
        self.defaults = defaults
        self.key = key
    }

    var consent: AnalyticsConsent {
        guard let rawValue = defaults.string(forKey: key),
              let consent = AnalyticsConsent(rawValue: rawValue) else {
            return .notDetermined
        }
        return consent
    }

    func setConsent(_ consent: AnalyticsConsent) {
        defaults.set(consent.rawValue, forKey: key)
    }
}

final class UserDefaultsAnalyticsDedupeStore: AnalyticsDedupeStoring {
    private let defaults: UserDefaults
    private let key: String
    private let capacity: Int
    private let lock = NSLock()

    init(
        defaults: UserDefaults = .standard,
        key: String = "snaplist.analytics.accepted_event_ids.v1",
        capacity: Int = 256
    ) {
        self.defaults = defaults
        self.key = key
        self.capacity = min(max(capacity, 1), 512)
    }

    var persistedEventCount: Int {
        lock.withLock { storedIDs().count }
    }

    func contains(_ eventID: UUID) -> Bool {
        lock.withLock {
            storedIDs().contains(eventID.uuidString.lowercased())
        }
    }

    func insert(_ eventID: UUID) {
        lock.withLock {
            let value = eventID.uuidString.lowercased()
            var values = storedIDs().filter { $0 != value }
            values.append(value)
            defaults.set(Array(values.suffix(capacity)), forKey: key)
        }
    }

    private func storedIDs() -> [String] {
        defaults.stringArray(forKey: key) ?? []
    }
}
