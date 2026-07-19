import XCTest
@testable import SnapList

final class AnalyticsContractTests: XCTestCase {
    private let metadata = AnalyticsMetadata(
        environment: .testFlight,
        appVersion: "0.1.0",
        build: "229"
    )

    func testTypedActivationEventProducesOnlyItsApprovedBoundedProperties() throws {
        let eventID = UUID(uuidString: "22900000-0000-4000-8000-000000000001")!

        let payload = try XCTUnwrap(
            AnalyticsSanitizer().sanitize(
                event: .guestRunStarted(
                    eventID: eventID,
                    entryPoint: .onboarding
                ),
                metadata: metadata
            )
        )

        XCTAssertEqual(payload.name, "guest run started")
        XCTAssertEqual(
            payload.properties,
            [
                "event_id": eventID.uuidString.lowercased(),
                "entry_point": "onboarding",
                "environment": "testflight",
                "app_version": "0.1.0",
                "app_build": "229",
            ]
        )
    }

    func testRawSanitizerRejectsUnknownEventsPropertiesAndUnboundedValues() {
        let sanitizer = AnalyticsSanitizer()

        XCTAssertNil(
            sanitizer.sanitize(
                eventName: "listing title copied",
                properties: ["event_id": .string(UUID().uuidString)],
                metadata: metadata
            )
        )
        XCTAssertNil(
            sanitizer.sanitize(
                eventName: "guest run started",
                properties: [
                    "event_id": .string(UUID().uuidString),
                    "email": .string("seller@example.com"),
                ],
                metadata: metadata
            )
        )
        XCTAssertNil(
            sanitizer.sanitize(
                eventName: "guest run started",
                properties: [
                    "event_id": .string(UUID().uuidString),
                    "entry_point": .string(String(repeating: "x", count: 65)),
                ],
                metadata: metadata
            )
        )
    }

    func testApprovedActivationTaxonomyHasNoAdHocEventNamesOrProperties() throws {
        let eventID = UUID(uuidString: "22900000-0000-4000-8000-000000000002")!
        let cases: [(AnalyticsEvent, String, Set<String>)] = [
            (
                .guestRunStarted(eventID: eventID, entryPoint: .capture),
                "guest run started",
                ["event_id", "entry_point"]
            ),
            (
                .durableDraftViewed(eventID: eventID, accountState: .guest),
                "durable draft viewed",
                ["event_id", "account_state"]
            ),
            (
                .correctionOpened(eventID: eventID, entryPoint: .draftReview),
                "correction opened",
                ["event_id", "entry_point"]
            ),
            (
                .correctionCompleted(eventID: eventID),
                "correction completed",
                ["event_id"]
            ),
            (
                .paywallViewed(eventID: eventID, trigger: .secondAIItem),
                "paywall viewed",
                ["event_id", "trigger"]
            ),
            (
                .checkoutFlowStarted(eventID: eventID, flow: .trial, cadence: .monthly),
                "trial/purchase flow started",
                ["event_id", "flow", "cadence"]
            ),
            (
                .publishIntent(eventID: eventID, accountState: .authenticated),
                "publish intent",
                ["event_id", "account_state"]
            ),
        ]
        let metadataKeys: Set<String> = ["environment", "app_version", "app_build"]

        for (event, name, eventKeys) in cases {
            let payload = try XCTUnwrap(
                AnalyticsSanitizer().sanitize(event: event, metadata: metadata)
            )
            XCTAssertEqual(payload.name, name)
            XCTAssertEqual(Set(payload.properties.keys), eventKeys.union(metadataKeys))
        }
    }

    func testAbsentConsentDropsCaptureWithoutTouchingTheTransport() {
        let consentStore = InMemoryAnalyticsConsentStore()
        let transport = RecordingAnalyticsTransport()
        let client = PostHogAnalyticsClient(
            metadata: metadata,
            consentStore: consentStore,
            dedupeStore: InMemoryAnalyticsDedupeStore(),
            transport: transport
        )

        client.capture(
            .guestRunStarted(
                eventID: UUID(uuidString: "22900000-0000-4000-8000-000000000003")!,
                entryPoint: .onboarding
            )
        )

        XCTAssertEqual(consentStore.consent, .notDetermined)
        XCTAssertTrue(transport.calls.isEmpty)
    }

    func testConsentPersistsAndEnablesOnlyApprovedPayloads() throws {
        let suiteName = "AnalyticsContractTests-consent-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let firstStore = UserDefaultsAnalyticsConsentStore(defaults: defaults)
        firstStore.setConsent(.granted)

        let restoredStore = UserDefaultsAnalyticsConsentStore(defaults: defaults)
        let transport = RecordingAnalyticsTransport()
        let client = PostHogAnalyticsClient(
            metadata: metadata,
            consentStore: restoredStore,
            dedupeStore: InMemoryAnalyticsDedupeStore(),
            transport: transport
        )
        client.capture(
            .correctionCompleted(
                eventID: UUID(uuidString: "22900000-0000-4000-8000-000000000004")!
            )
        )

        XCTAssertEqual(restoredStore.consent, .granted)
        XCTAssertEqual(transport.calls.first, .consent(true))
        XCTAssertEqual(transport.calls.compactMap(\.capturedPayload).count, 1)
    }

    func testIdentifyIsClerkOnlyOnceAndResetFlushesBeforeNewAnonymousIdentity() {
        let transport = RecordingAnalyticsTransport()
        let client = PostHogAnalyticsClient(
            metadata: metadata,
            consentStore: InMemoryAnalyticsConsentStore(consent: .granted),
            dedupeStore: InMemoryAnalyticsDedupeStore(),
            transport: transport
        )

        client.identify(clerkUserID: "seller@example.com")
        client.identify(clerkUserID: "user_abc123")
        client.identify(clerkUserID: "user_other456")
        client.reset()
        client.identify(clerkUserID: "user_other456")

        XCTAssertEqual(
            transport.calls,
            [
                .consent(true),
                .identify("user_abc123"),
                .flush,
                .reset,
                .identify("user_other456"),
            ]
        )
    }

    func testLogoutResetsProviderIdentityEvenAfterConsentWasRevoked() {
        let transport = RecordingAnalyticsTransport()
        let client = PostHogAnalyticsClient(
            metadata: metadata,
            consentStore: InMemoryAnalyticsConsentStore(consent: .granted),
            dedupeStore: InMemoryAnalyticsDedupeStore(),
            transport: transport
        )
        client.identify(clerkUserID: "user_abc123")
        client.setConsent(.denied)

        client.reset()

        XCTAssertEqual(transport.calls.suffix(2), [.consent(false), .reset])
    }

    func testRelaunchDedupeIsBoundedAndPreventsOfflineQueueDuplicates() throws {
        let suiteName = "AnalyticsContractTests-dedupe-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let eventID = UUID(uuidString: "22900000-0000-4000-8000-000000000005")!
        let transport = RecordingAnalyticsTransport()
        let consent = InMemoryAnalyticsConsentStore(consent: .granted)

        PostHogAnalyticsClient(
            metadata: metadata,
            consentStore: consent,
            dedupeStore: UserDefaultsAnalyticsDedupeStore(defaults: defaults, capacity: 2),
            transport: transport
        ).capture(.paywallViewed(eventID: eventID, trigger: .secondAIItem))
        let restoredClient = PostHogAnalyticsClient(
            metadata: metadata,
            consentStore: consent,
            dedupeStore: UserDefaultsAnalyticsDedupeStore(defaults: defaults, capacity: 2),
            transport: transport
        )
        restoredClient.capture(.paywallViewed(eventID: eventID, trigger: .secondAIItem))
        restoredClient.flush()

        XCTAssertEqual(transport.calls.compactMap(\.capturedPayload).count, 1)
        XCTAssertEqual(transport.calls.filter { $0 == .flush }.count, 1)

        let store = UserDefaultsAnalyticsDedupeStore(defaults: defaults, capacity: 2)
        store.insert(UUID(uuidString: "22900000-0000-4000-8000-000000000006")!)
        store.insert(UUID(uuidString: "22900000-0000-4000-8000-000000000007")!)
        XCTAssertLessThanOrEqual(store.persistedEventCount, 2)
    }

    func testEnvironmentRoutesAreExplicitAndCannotCrossProjectTokens() throws {
        let testFlight = try XCTUnwrap(
            AnalyticsProviderRoute(
                environment: .testFlight,
                projectToken: "phc_testflight_fixture",
                host: URL(string: "https://us.i.posthog.com")!
            )
        )
        let production = try XCTUnwrap(
            AnalyticsProviderRoute(
                environment: .production,
                projectToken: "phc_production_fixture",
                host: URL(string: "https://us.i.posthog.com")!
            )
        )
        let routes = try XCTUnwrap(
            AnalyticsRouteSet(testFlight: testFlight, production: production)
        )

        XCTAssertEqual(routes.route(for: .testFlight), testFlight)
        XCTAssertEqual(routes.route(for: .production), production)
        XCTAssertNil(routes.route(for: .local))
        XCTAssertNil(
            AnalyticsRouteSet(
                testFlight: testFlight,
                production: AnalyticsProviderRoute(
                    environment: .production,
                    projectToken: testFlight.projectToken,
                    host: production.host
                )!
            )
        )
        XCTAssertNil(
            AnalyticsProviderRoute(
                environment: .testFlight,
                projectToken: "phc_fixture",
                host: URL(string: "http://us.i.posthog.com")!
            )
        )
    }

    func testPostHogConfigurationIsOptedOutBoundedAndDisablesAutomaticCapture() throws {
        let route = try XCTUnwrap(
            AnalyticsProviderRoute(
                environment: .testFlight,
                projectToken: "phc_testflight_fixture",
                host: URL(string: "https://us.i.posthog.com")!
            )
        )
        let config = PostHogAnalyticsConfiguration.makeConfig(
            route: route,
            metadata: metadata
        )

        XCTAssertTrue(config.optOut)
        XCTAssertEqual(config.maxQueueSize, 256)
        XCTAssertEqual(config.flushAt, 20)
        XCTAssertEqual(config.maxBatchSize, 20)
        XCTAssertFalse(config.captureApplicationLifecycleEvents)
        XCTAssertFalse(config.captureScreenViews)
        XCTAssertFalse(config.enableSwizzling)
        XCTAssertFalse(config.captureElementInteractions)
        XCTAssertFalse(config.sessionReplay)
        XCTAssertFalse(config.sessionReplayConfig.captureNetworkTelemetry)
        XCTAssertFalse(config.sessionReplayConfig.captureLogs)
        XCTAssertFalse(config.sessionReplayConfig.screenshotMode)
        XCTAssertFalse(config.errorTrackingConfig.autoCapture)
        XCTAssertFalse(config.errorTrackingConfig.exceptionSteps.enabled)
        XCTAssertFalse(config.preloadFeatureFlags)
        XCTAssertFalse(config.sendFeatureFlagEvent)
        XCTAssertFalse(config.setDefaultPersonProperties)
        XCTAssertNil(config.tracingHeaders)
        XCTAssertFalse(config.rageClickConfig.enabled)
        XCTAssertFalse(config.surveys)
        XCTAssertFalse(config.debug)
    }

    func testProviderFirewallAddsMetadataToIdentifyAndRejectsUnknownAppProperties() throws {
        let sanitizer = AnalyticsSanitizer()
        let anonymousID = "22900000-0000-4000-8000-000000000008"
        let identify = try XCTUnwrap(
            sanitizer.sanitizeProviderEvent(
                name: "$identify",
                distinctID: "user_abc123",
                properties: ["$anon_distinct_id": anonymousID],
                metadata: metadata
            )
        )
        XCTAssertEqual(identify["environment"] as? String, "testflight")
        XCTAssertEqual(identify["$anon_distinct_id"] as? String, anonymousID)

        XCTAssertNil(
            sanitizer.sanitizeProviderEvent(
                name: "guest run started",
                distinctID: anonymousID,
                properties: [
                    "event_id": anonymousID,
                    "entry_point": "onboarding",
                    "environment": "testflight",
                    "app_version": "0.1.0",
                    "app_build": "229",
                    "email": "seller@example.com",
                ],
                metadata: metadata
            )
        )
    }

    func testDefaultCompositionIsNoOpAndDebugAdapterNeverLogsIdentityValues() {
        XCTAssertTrue(AppDependencies.make(configuration: .standard).analyticsClient is NoOpAnalyticsClient)
        XCTAssertTrue(AppDependencies.make(configuration: .preview).analyticsClient is NoOpAnalyticsClient)

        var logs: [String] = []
        let client = DebugAnalyticsClient(
            metadata: metadata,
            consentStore: InMemoryAnalyticsConsentStore(consent: .granted),
            dedupeStore: InMemoryAnalyticsDedupeStore(),
            log: { logs.append($0) }
        )
        client.identify(clerkUserID: "user_private123")

        XCTAssertFalse(logs.joined().contains("user_private123"))
    }

    func testTransportFailureFailsOpenAndDoesNotMarkTheEventDelivered() {
        let transport = FailingAnalyticsTransport()
        let client = PostHogAnalyticsClient(
            metadata: metadata,
            consentStore: InMemoryAnalyticsConsentStore(consent: .granted),
            dedupeStore: InMemoryAnalyticsDedupeStore(),
            transport: transport
        )
        let event = AnalyticsEvent.correctionCompleted(
            eventID: UUID(uuidString: "22900000-0000-4000-8000-000000000009")!
        )

        client.capture(event)
        client.capture(event)

        XCTAssertEqual(transport.captureAttempts, 2)
    }

    func testBundleMetadataRequiresExplicitVersionAndBuild() {
        XCTAssertEqual(
            AnalyticsMetadata.resolve(
                environment: .production,
                infoDictionary: [
                    "CFBundleShortVersionString": "1.2.3",
                    "CFBundleVersion": "456",
                ]
            ),
            AnalyticsMetadata(
                environment: .production,
                appVersion: "1.2.3",
                build: "456"
            )
        )
        XCTAssertNil(
            AnalyticsMetadata.resolve(
                environment: .production,
                infoDictionary: ["CFBundleShortVersionString": "1.2.3"]
            )
        )
    }
}

private final class RecordingAnalyticsTransport: AnalyticsTransport {
    enum Call: Equatable {
        case consent(Bool)
        case capture(AnalyticsPayload)
        case identify(String)
        case flush
        case reset
    }

    private(set) var calls: [Call] = []

    func setConsent(granted: Bool) throws { calls.append(.consent(granted)) }
    func capture(_ payload: AnalyticsPayload) throws { calls.append(.capture(payload)) }
    func identify(clerkUserID: String) throws { calls.append(.identify(clerkUserID)) }
    func flush() throws { calls.append(.flush) }
    func reset() throws { calls.append(.reset) }
}

private extension RecordingAnalyticsTransport.Call {
    var capturedPayload: AnalyticsPayload? {
        guard case let .capture(payload) = self else { return nil }
        return payload
    }
}

private final class FailingAnalyticsTransport: AnalyticsTransport {
    enum Failure: Error { case expected }
    private(set) var captureAttempts = 0

    func setConsent(granted: Bool) throws {}
    func capture(_ payload: AnalyticsPayload) throws {
        captureAttempts += 1
        throw Failure.expected
    }
    func identify(clerkUserID: String) throws { throw Failure.expected }
    func flush() throws { throw Failure.expected }
    func reset() throws { throw Failure.expected }
}
