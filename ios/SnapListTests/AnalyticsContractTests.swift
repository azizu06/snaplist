import XCTest
import PostHog
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
            transportFactory: { transport }
        )

        client.capture(
            .guestRunStarted(
                eventID: UUID(uuidString: "22900000-0000-4000-8000-000000000003")!,
                entryPoint: .onboarding
            )
        )
        XCTAssertTrue(client.waitUntilIdleForTesting())

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
            transportFactory: { transport }
        )
        client.capture(
            .correctionCompleted(
                eventID: UUID(uuidString: "22900000-0000-4000-8000-000000000004")!
            )
        )
        XCTAssertTrue(client.waitUntilIdleForTesting())

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
            transportFactory: { transport }
        )

        client.identify(clerkUserID: "seller@example.com")
        client.identify(clerkUserID: "user_abc123")
        client.identify(clerkUserID: "user_other456")
        client.reset()
        client.identify(clerkUserID: "user_other456")
        XCTAssertTrue(client.waitUntilIdleForTesting())

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
            transportFactory: { transport }
        )
        client.identify(clerkUserID: "user_abc123")
        client.setConsent(.denied)

        client.reset()
        XCTAssertTrue(client.waitUntilIdleForTesting())

        XCTAssertEqual(transport.calls.suffix(3), [.consent(false), .reset, .reset])
    }

    func testDeniedConsentNeverConstructsOrWakesTheProviderAcrossRelaunch() {
        let consent = InMemoryAnalyticsConsentStore(consent: .denied)
        let factory = RecordingAnalyticsTransportFactory()

        let firstLaunch = PostHogAnalyticsClient(
            metadata: metadata,
            consentStore: consent,
            dedupeStore: InMemoryAnalyticsDedupeStore(),
            transportFactory: { factory.make() }
        )
        firstLaunch.capture(
            .correctionCompleted(
                eventID: UUID(uuidString: "22900000-0000-4000-8000-00000000000a")!
            )
        )
        firstLaunch.flush()
        XCTAssertTrue(firstLaunch.waitUntilIdleForTesting())

        let relaunched = PostHogAnalyticsClient(
            metadata: metadata,
            consentStore: consent,
            dedupeStore: InMemoryAnalyticsDedupeStore(),
            transportFactory: { factory.make() }
        )
        relaunched.flush()
        XCTAssertTrue(relaunched.waitUntilIdleForTesting())

        XCTAssertEqual(factory.makeCount, 0)
    }

    func testConsentPersistenceIsDurableBeforeDeferredSDKWorkCompletes() {
        let consent = InMemoryAnalyticsConsentStore(consent: .granted)
        let transport = BlockingAnalyticsTransport()
        let client = PostHogAnalyticsClient(
            metadata: metadata,
            consentStore: consent,
            dedupeStore: InMemoryAnalyticsDedupeStore(),
            transportFactory: { transport }
        )
        XCTAssertTrue(client.waitUntilIdleForTesting())
        client.capture(
            .correctionCompleted(
                eventID: UUID(uuidString: "22900000-0000-4000-8000-00000000000c")!
            )
        )
        XCTAssertTrue(transport.captureStarted.wait(timeout: .now() + 1) == .success)

        client.setConsent(.denied)

        XCTAssertEqual(consent.consent, .denied)
        transport.allowCaptureToFinish.signal()
        XCTAssertTrue(client.waitUntilIdleForTesting())
    }

    func testLifecycleIsSerializedOffCallerAndConcurrentStableIDsEnqueueOnce() {
        let transport = BlockingAnalyticsTransport()
        let client = PostHogAnalyticsClient(
            metadata: metadata,
            consentStore: InMemoryAnalyticsConsentStore(consent: .granted),
            dedupeStore: InMemoryAnalyticsDedupeStore(),
            transportFactory: { transport }
        )
        XCTAssertTrue(client.waitUntilIdleForTesting())
        let event = AnalyticsEvent.correctionCompleted(
            eventID: UUID(uuidString: "22900000-0000-4000-8000-00000000000b")!
        )

        let callerReturned = expectation(description: "capture returns without SDK persistence")
        DispatchQueue.main.async {
            client.capture(event)
            callerReturned.fulfill()
        }
        wait(for: [callerReturned], timeout: 0.25)
        XCTAssertTrue(transport.captureStarted.wait(timeout: .now() + 1) == .success)

        DispatchQueue.concurrentPerform(iterations: 64) { _ in
            client.capture(event)
        }
        client.identify(clerkUserID: "user_serialized229")
        client.reset()
        transport.allowCaptureToFinish.signal()

        XCTAssertTrue(client.waitUntilIdleForTesting(timeout: 5))
        XCTAssertEqual(transport.captureCount, 1)
        XCTAssertEqual(transport.maximumConcurrentCalls, 1)
        XCTAssertEqual(transport.calls.suffix(3), [.identify, .flush, .reset])
    }

    func testRelaunchDedupeIsBoundedAndPreventsOfflineQueueDuplicates() throws {
        let suiteName = "AnalyticsContractTests-dedupe-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let eventID = UUID(uuidString: "22900000-0000-4000-8000-000000000005")!
        let transport = RecordingAnalyticsTransport()
        let consent = InMemoryAnalyticsConsentStore(consent: .granted)

        let firstClient = PostHogAnalyticsClient(
            metadata: metadata,
            consentStore: consent,
            dedupeStore: UserDefaultsAnalyticsDedupeStore(defaults: defaults, capacity: 2),
            transportFactory: { transport }
        )
        firstClient.capture(.paywallViewed(eventID: eventID, trigger: .secondAIItem))
        XCTAssertTrue(firstClient.waitUntilIdleForTesting())
        let restoredClient = PostHogAnalyticsClient(
            metadata: metadata,
            consentStore: consent,
            dedupeStore: UserDefaultsAnalyticsDedupeStore(defaults: defaults, capacity: 2),
            transportFactory: { transport }
        )
        restoredClient.capture(.paywallViewed(eventID: eventID, trigger: .secondAIItem))
        restoredClient.flush()
        XCTAssertTrue(restoredClient.waitUntilIdleForTesting())

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

    func testRealSDKQueueIsBoundedPersistsOfflineAndDrainsExactlyOnceAfterRelaunch() throws {
        let token = "phc_queue_contract_\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))"
        let route = try XCTUnwrap(
            AnalyticsProviderRoute(
                environment: .testFlight,
                projectToken: token,
                host: URL(string: "https://analytics.invalid")!
            )
        )
        let storageURL = postHogStorageURL(projectToken: token)
        defer { try? FileManager.default.removeItem(at: storageURL) }
        try? FileManager.default.removeItem(at: storageURL)
        QueueContractURLProtocol.reset(online: false)
        let sessionConfiguration = URLSessionConfiguration.ephemeral
        sessionConfiguration.protocolClasses = [QueueContractURLProtocol.self]

        let offline = try XCTUnwrap(
            PostHogSDKTransport(
                route: route,
                metadata: metadata,
                urlSessionConfiguration: sessionConfiguration
            )
        )
        try offline.setConsent(granted: true)
        for index in 0 ... 256 {
            try offline.capture(
                try XCTUnwrap(
                    AnalyticsSanitizer().sanitize(
                        event: .correctionCompleted(eventID: deterministicEventID(index)),
                        metadata: metadata
                    )
                )
            )
        }

        let queueURL = storageURL.appendingPathComponent("posthog.queueFolder.uuid")
        XCTAssertEqual(queueDepth(at: queueURL), 256)
        try offline.flush()
        XCTAssertTrue(waitUntil { QueueContractURLProtocol.failedRequestCount > 0 })
        XCTAssertEqual(queueDepth(at: queueURL), 256)
        offline.close()

        QueueContractURLProtocol.setOnline(true)
        let restored = try XCTUnwrap(
            PostHogSDKTransport(
                route: route,
                metadata: metadata,
                urlSessionConfiguration: sessionConfiguration
            )
        )
        try restored.setConsent(granted: true)
        try restored.flush()
        XCTAssertTrue(
            waitUntil(timeout: 10) {
                try? restored.flush()
                return queueDepth(at: queueURL) == 0
            }
        )
        let successfulRequests = QueueContractURLProtocol.successfulRequestCount
        XCTAssertEqual(successfulRequests, 13)

        try restored.flush()
        RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        XCTAssertEqual(QueueContractURLProtocol.successfulRequestCount, successfulRequests)
        restored.close()
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
        XCTAssertTrue(client.waitUntilIdleForTesting())

        XCTAssertFalse(logs.joined().contains("user_private123"))
    }

    func testTransportFailureFailsOpenAndDoesNotMarkTheEventDelivered() {
        let transport = FailingAnalyticsTransport()
        let client = PostHogAnalyticsClient(
            metadata: metadata,
            consentStore: InMemoryAnalyticsConsentStore(consent: .granted),
            dedupeStore: InMemoryAnalyticsDedupeStore(),
            transportFactory: { transport }
        )
        let event = AnalyticsEvent.correctionCompleted(
            eventID: UUID(uuidString: "22900000-0000-4000-8000-000000000009")!
        )

        client.capture(event)
        client.capture(event)
        XCTAssertTrue(client.waitUntilIdleForTesting())

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

private extension AnalyticsContractTests {
    func deterministicEventID(_ index: Int) -> UUID {
        UUID(uuidString: String(format: "22900000-0000-4000-8000-%012x", index))!
    }

    func postHogStorageURL(projectToken: String) -> URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(Bundle.main.bundleIdentifier ?? "com.posthog.unknown")
            .appendingPathComponent(projectToken)
    }

    func queueDepth(at url: URL) -> Int {
        (try? FileManager.default.contentsOfDirectory(atPath: url.path).count) ?? 0
    }

    func waitUntil(timeout: TimeInterval = 3, condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.02))
        }
        return condition()
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

private final class RecordingAnalyticsTransportFactory: @unchecked Sendable {
    private let lock = NSLock()
    private let transport = RecordingAnalyticsTransport()
    private(set) var makeCount = 0

    func make() -> (any AnalyticsTransport)? {
        lock.withLock { makeCount += 1 }
        return transport
    }
}

private final class BlockingAnalyticsTransport: AnalyticsTransport, @unchecked Sendable {
    enum Call: Equatable { case consent, capture, identify, flush, reset }

    let captureStarted = DispatchSemaphore(value: 0)
    let allowCaptureToFinish = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var activeCalls = 0
    private(set) var maximumConcurrentCalls = 0
    private(set) var captureCount = 0
    private(set) var calls: [Call] = []

    func setConsent(granted: Bool) throws { record(.consent) }

    func capture(_ payload: AnalyticsPayload) throws {
        begin(.capture)
        captureStarted.signal()
        _ = allowCaptureToFinish.wait(timeout: .now() + 5)
        lock.withLock { captureCount += 1 }
        end()
    }

    func identify(clerkUserID: String) throws { record(.identify) }
    func flush() throws { record(.flush) }
    func reset() throws { record(.reset) }

    private func record(_ call: Call) {
        begin(call)
        Thread.sleep(forTimeInterval: 0.001)
        end()
    }

    private func begin(_ call: Call) {
        lock.withLock {
            activeCalls += 1
            maximumConcurrentCalls = max(maximumConcurrentCalls, activeCalls)
            calls.append(call)
        }
    }

    private func end() {
        lock.withLock { activeCalls -= 1 }
    }
}

private final class QueueContractURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var online = false
    private static var failedRequests = 0
    private static var successfulRequests = 0

    static var failedRequestCount: Int { lock.withLock { failedRequests } }
    static var successfulRequestCount: Int { lock.withLock { successfulRequests } }

    static func reset(online: Bool) {
        lock.withLock {
            self.online = online
            failedRequests = 0
            successfulRequests = 0
        }
    }

    static func setOnline(_ value: Bool) {
        lock.withLock { online = value }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let shouldSucceed = Self.lock.withLock { Self.online }
        let isBatchRequest = request.url?.path.hasSuffix("/batch") == true
        if shouldSucceed {
            if isBatchRequest {
                Self.lock.withLock { Self.successfulRequests += 1 }
            }
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data("{}".utf8))
            client?.urlProtocolDidFinishLoading(self)
        } else {
            if isBatchRequest {
                Self.lock.withLock { Self.failedRequests += 1 }
            }
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
        }
    }

    override func stopLoading() {}
}
