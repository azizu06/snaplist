import Foundation

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
