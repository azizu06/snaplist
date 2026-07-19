import Foundation

struct AnalyticsSanitizer: Sendable {
    func sanitize(
        screen: AnalyticsScreen,
        metadata: AnalyticsMetadata
    ) -> AnalyticsPayload? {
        guard isValidMetadata(metadata) else { return nil }
        return AnalyticsPayload(
            name: "$screen",
            properties: [
                "$screen_name": screen.rawValue,
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

    func sanitizeProviderEvent(
        name: String,
        distinctID: String,
        properties: [String: Any],
        metadata: AnalyticsMetadata
    ) -> [String: Any]? {
        let metadataProperties: [String: String] = [
            "environment": metadata.environment.rawValue,
            "app_version": metadata.appVersion,
            "app_build": metadata.build,
        ]
        if name == "$identify" {
            let allowedKeys = Set(["distinct_id"] + metadataProperties.keys)
            guard properties.keys.allSatisfy({ $0.hasPrefix("$") || allowedKeys.contains($0) }) else {
                return nil
            }
            guard distinctID.range(
                of: #"^user_[A-Za-z0-9]+$"#,
                options: .regularExpression
            ) != nil,
            let anonymousID = properties["$anon_distinct_id"] as? String,
            UUID(uuidString: anonymousID) != nil else {
                return nil
            }
            var sanitized: [String: Any] = metadataProperties
            sanitized["distinct_id"] = distinctID
            sanitized["$anon_distinct_id"] = anonymousID
            sanitized["$process_person_profile"] = true
            return sanitized
        }

        if name == "$screen" {
            let allowedKeys = Set(metadataProperties.keys)
            guard metadataProperties.allSatisfy({ properties[$0.key] as? String == $0.value }),
                  properties.keys.allSatisfy({ $0.hasPrefix("$") || allowedKeys.contains($0) }) else {
                return nil
            }
            guard let screenName = properties["$screen_name"] as? String,
                  AnalyticsScreen(rawValue: screenName) != nil else {
                return nil
            }
            var sanitized: [String: Any] = metadataProperties
            sanitized["distinct_id"] = distinctID
            sanitized["$screen_name"] = screenName
            sanitized["$process_person_profile"] = properties["$process_person_profile"] as? Bool ?? false
            return sanitized
        }

        guard let schema = EventSchema.approved[name] else { return nil }
        let allowedKeys = Set(schema.keys + ["distinct_id"] + metadataProperties.keys)
        guard metadataProperties.allSatisfy({ properties[$0.key] as? String == $0.value }),
              properties.keys.allSatisfy({ $0.hasPrefix("$") || allowedKeys.contains($0) }) else {
            return nil
        }
        var rawProperties: [String: AnalyticsPropertyValue] = [:]
        for key in schema.keys {
            guard let value = properties[key] as? String else { return nil }
            rawProperties[key] = .string(value)
        }
        guard let payload = sanitize(
            eventName: name,
            properties: rawProperties,
            metadata: metadata
        ) else {
            return nil
        }
        var sanitized: [String: Any] = payload.properties
        sanitized["distinct_id"] = distinctID
        sanitized["$process_person_profile"] = properties["$process_person_profile"] as? Bool ?? false
        return sanitized
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
