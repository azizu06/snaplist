import Foundation

struct AnalyticsSanitizer: Sendable {
    func sanitize(
        screen: AnalyticsScreen,
        metadata: AnalyticsMetadata
    ) -> AnalyticsPayload? {
        guard isValidMetadata(metadata) else { return nil }
        return AnalyticsPayload(
            name: "screen viewed",
            properties: [
                "screen": screen.rawValue,
                "environment": metadata.environment.rawValue,
                "app_version": metadata.appVersion,
                "app_build": metadata.build,
            ]
        )
    }

    func sanitize(
        event: AnalyticsEvent,
        metadata: AnalyticsMetadata
    ) -> AnalyticsPayload? {
        switch event {
        case let .guestRunStarted(eventID, entryPoint):
            return sanitize(
                eventName: "guest run started",
                properties: [
                    "event_id": .string(eventID.uuidString.lowercased()),
                    "entry_point": .string(entryPoint.rawValue),
                ],
                metadata: metadata
            )
        case let .durableDraftViewed(eventID, accountState):
            return sanitize(
                eventName: "durable draft viewed",
                properties: [
                    "event_id": .string(eventID.uuidString.lowercased()),
                    "account_state": .string(accountState.rawValue),
                ],
                metadata: metadata
            )
        case let .correctionOpened(eventID, entryPoint):
            return sanitize(
                eventName: "correction opened",
                properties: [
                    "event_id": .string(eventID.uuidString.lowercased()),
                    "entry_point": .string(entryPoint.rawValue),
                ],
                metadata: metadata
            )
        case let .correctionCompleted(eventID):
            return sanitize(
                eventName: "correction completed",
                properties: [
                    "event_id": .string(eventID.uuidString.lowercased()),
                ],
                metadata: metadata
            )
        case let .paywallViewed(eventID, trigger):
            return sanitize(
                eventName: "paywall viewed",
                properties: [
                    "event_id": .string(eventID.uuidString.lowercased()),
                    "trigger": .string(trigger.rawValue),
                ],
                metadata: metadata
            )
        case let .checkoutFlowStarted(eventID, flow, cadence):
            return sanitize(
                eventName: "trial/purchase flow started",
                properties: [
                    "event_id": .string(eventID.uuidString.lowercased()),
                    "flow": .string(flow.rawValue),
                    "cadence": .string(cadence.rawValue),
                ],
                metadata: metadata
            )
        case let .publishIntent(eventID, accountState):
            return sanitize(
                eventName: "publish intent",
                properties: [
                    "event_id": .string(eventID.uuidString.lowercased()),
                    "account_state": .string(accountState.rawValue),
                ],
                metadata: metadata
            )
        }
    }

    func sanitize(
        eventName: String,
        properties: [String: AnalyticsPropertyValue],
        metadata: AnalyticsMetadata
    ) -> AnalyticsPayload? {
        guard let schema = EventSchema.approved[eventName],
              Set(properties.keys) == Set(schema.keys),
              case let .string(eventID) = properties["event_id"],
              UUID(uuidString: eventID) != nil,
              schema.allows(properties),
              isValidMetadata(metadata) else {
            return nil
        }

        var sanitized = properties.mapValues { value in
            switch value {
            case let .string(string): string
            }
        }
        sanitized["event_id"] = eventID.lowercased()
        sanitized["environment"] = metadata.environment.rawValue
        sanitized["app_version"] = metadata.appVersion
        sanitized["app_build"] = metadata.build
        return AnalyticsPayload(name: eventName, properties: sanitized)
    }

    private func isValidMetadata(_ metadata: AnalyticsMetadata) -> Bool {
        metadata.appVersion.range(
            of: #"^[0-9]+(?:\.[0-9]+){1,3}$"#,
            options: .regularExpression
        ) != nil && metadata.build.range(
            of: #"^[0-9]{1,12}$"#,
            options: .regularExpression
        ) != nil
    }

}

private struct EventSchema {
    let keys: [String]
    let allowedValues: [String: Set<String>]

    func allows(_ properties: [String: AnalyticsPropertyValue]) -> Bool {
        for (key, allowed) in allowedValues {
            guard case let .string(value) = properties[key], allowed.contains(value) else {
                return false
            }
        }
        return true
    }

    static let approved: [String: EventSchema] = [
        "guest run started": .init(
            keys: ["event_id", "entry_point"],
            allowedValues: ["entry_point": values(AnalyticsEntryPoint.self)]
        ),
        "durable draft viewed": .init(
            keys: ["event_id", "account_state"],
            allowedValues: ["account_state": values(AnalyticsAccountState.self)]
        ),
        "correction opened": .init(
            keys: ["event_id", "entry_point"],
            allowedValues: ["entry_point": values(AnalyticsEntryPoint.self)]
        ),
        "correction completed": .init(
            keys: ["event_id"],
            allowedValues: [:]
        ),
        "paywall viewed": .init(
            keys: ["event_id", "trigger"],
            allowedValues: ["trigger": values(AnalyticsPaywallTrigger.self)]
        ),
        "trial/purchase flow started": .init(
            keys: ["event_id", "flow", "cadence"],
            allowedValues: [
                "flow": values(AnalyticsCheckoutFlow.self),
                "cadence": values(AnalyticsBillingCadence.self),
            ]
        ),
        "publish intent": .init(
            keys: ["event_id", "account_state"],
            allowedValues: ["account_state": values(AnalyticsAccountState.self)]
        ),
    ]

    private static func values<Value>(_ type: Value.Type) -> Set<String>
    where Value: CaseIterable & RawRepresentable, Value.RawValue == String {
        Set(Value.allCases.map(\.rawValue))
    }
}
