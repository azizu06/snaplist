import XCTest
@testable import SnapList

final class AnalyticsContractTests: XCTestCase {
    private let metadata = AnalyticsMetadata(
        environment: .testFlight,
        appVersion: "0.1.0",
        build: "270"
    )

    func testTypedActivationEventProducesOnlyItsApprovedBoundedProperties() throws {
        let eventID = UUID(uuidString: "27000000-0000-4000-8000-000000000001")!

        let payload = try XCTUnwrap(
            AnalyticsSanitizer().sanitize(
                event: .guestRunStarted(eventID: eventID, entryPoint: .onboarding),
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
                "app_build": "270",
            ]
        )
    }

    func testApprovedActivationTaxonomyHasNoAdHocEventNamesOrProperties() throws {
        let eventID = UUID(uuidString: "27000000-0000-4000-8000-000000000002")!
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

    func testRawSanitizerRejectsUnknownPIIContentIdentifiersErrorsAndUnboundedValues() {
        let sanitizer = AnalyticsSanitizer()
        let eventID = AnalyticsPropertyValue.string(UUID().uuidString)
        let forbiddenProperties = [
            "email": "seller@example.com",
            "listing_title": "private listing content",
            "provider_id": "ebay-123",
            "internal_item_id": "item-123",
            "error": "raw provider failure with credentials",
        ]

        XCTAssertNil(
            sanitizer.sanitize(
                eventName: "listing title copied",
                properties: ["event_id": eventID],
                metadata: metadata
            )
        )
        for (key, value) in forbiddenProperties {
            XCTAssertNil(
                sanitizer.sanitize(
                    eventName: "guest run started",
                    properties: [
                        "event_id": eventID,
                        "entry_point": .string("onboarding"),
                        key: .string(value),
                    ],
                    metadata: metadata
                ),
                "Expected \(key) to be rejected"
            )
        }
        XCTAssertNil(
            sanitizer.sanitize(
                eventName: "guest run started",
                properties: [
                    "event_id": eventID,
                    "entry_point": .string(String(repeating: "x", count: 65)),
                ],
                metadata: metadata
            )
        )
        XCTAssertNil(
            sanitizer.sanitize(
                eventName: "guest run started",
                properties: [
                    "event_id": .string("not-a-uuid"),
                    "entry_point": .string("onboarding"),
                ],
                metadata: metadata
            )
        )
    }

    func testScreenPayloadUsesProviderNeutralContract() throws {
        let payload = try XCTUnwrap(
            AnalyticsSanitizer().sanitize(screen: .draftReview, metadata: metadata)
        )

        XCTAssertEqual(payload.name, "screen viewed")
        XCTAssertEqual(
            payload.properties,
            [
                "screen": "draft_review",
                "environment": "testflight",
                "app_version": "0.1.0",
                "app_build": "270",
            ]
        )
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
        XCTAssertNil(
            AnalyticsSanitizer().sanitize(
                event: .correctionCompleted(eventID: UUID()),
                metadata: AnalyticsMetadata(
                    environment: .production,
                    appVersion: "private-version",
                    build: "raw-build"
                )
            )
        )
    }

    func testRuntimeConfigurationRejectsCrossEnvironmentMetadata() throws {
        XCTAssertNil(
            AnalyticsRuntimeConfiguration(
                environment: .production,
                metadata: metadata,
                mode: .debug
            )
        )

        let productionMetadata = AnalyticsMetadata(
            environment: .production,
            appVersion: "1.0.0",
            build: "270"
        )
        let configuration = try XCTUnwrap(
            AnalyticsRuntimeConfiguration(
                environment: .production,
                metadata: productionMetadata,
                mode: .disabled
            )
        )

        XCTAssertEqual(configuration.metadata, productionMetadata)
        XCTAssertEqual(configuration.mode, .disabled)
    }

    func testConsentDefaultsAbsentAndPersistsOnlyTheProviderNeutralState() throws {
        let suiteName = "AnalyticsContractTests-consent-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let first = UserDefaultsAnalyticsConsentStore(defaults: defaults)
        XCTAssertEqual(first.consent, .notDetermined)
        first.setConsent(.denied)

        XCTAssertEqual(UserDefaultsAnalyticsConsentStore(defaults: defaults).consent, .denied)
        first.setConsent(.granted)
        XCTAssertEqual(UserDefaultsAnalyticsConsentStore(defaults: defaults).consent, .granted)
    }

    func testAnonymousIdentityPersistsUntilResetThenRotates() throws {
        let suiteName = "AnalyticsContractTests-identity-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let first = UserDefaultsAnalyticsIdentityStore(defaults: defaults)
        let anonymousID = first.identity.anonymousID
        XCTAssertNil(first.identity.clerkUserID)
        XCTAssertFalse(first.identify(clerkUserID: "seller@example.com"))
        XCTAssertTrue(first.identify(clerkUserID: "user_abc123"))
        XCTAssertFalse(first.identify(clerkUserID: "user_other456"))

        let restored = UserDefaultsAnalyticsIdentityStore(defaults: defaults)
        XCTAssertEqual(restored.identity.anonymousID, anonymousID)
        XCTAssertEqual(restored.identity.clerkUserID, "user_abc123")
        restored.reset()

        XCTAssertNotEqual(restored.identity.anonymousID, anonymousID)
        XCTAssertNil(restored.identity.clerkUserID)
    }

    func testDedupePersistenceIsStableAcrossRelaunchAndBounded() throws {
        let suiteName = "AnalyticsContractTests-dedupe-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let firstID = UUID(uuidString: "27000000-0000-4000-8000-000000000010")!
        let secondID = UUID(uuidString: "27000000-0000-4000-8000-000000000011")!
        let thirdID = UUID(uuidString: "27000000-0000-4000-8000-000000000012")!

        let first = UserDefaultsAnalyticsDedupeStore(defaults: defaults, capacity: 2)
        first.insert(firstID)
        XCTAssertTrue(UserDefaultsAnalyticsDedupeStore(defaults: defaults).contains(firstID))

        first.insert(secondID)
        first.insert(thirdID)

        XCTAssertFalse(first.contains(firstID))
        XCTAssertTrue(first.contains(secondID))
        XCTAssertTrue(first.contains(thirdID))
        XCTAssertEqual(first.persistedEventCount, 2)
    }

    func testDefaultProductionAndFixtureCompositionRemainNoOp() {
        XCTAssertTrue(AppDependencies.make(configuration: .standard).analyticsClient is NoOpAnalyticsClient)
        XCTAssertTrue(AppDependencies.make(configuration: .preview).analyticsClient is NoOpAnalyticsClient)
    }

    func testDebugRuntimeDropsAbsentAndDeniedConsentWithoutRecording() {
        let consent = InMemoryAnalyticsConsentStore()
        let identity = InMemoryAnalyticsIdentityStore()
        let sink = RecordingAnalyticsDebugSink()
        let client = DebugAnalyticsClient(
            metadata: metadata,
            consentStore: consent,
            dedupeStore: InMemoryAnalyticsDedupeStore(),
            identityStore: identity,
            sink: sink
        )

        client.capture(.correctionCompleted(eventID: UUID()))
        client.screen(.capture)
        client.identify(clerkUserID: "user_private270")
        client.flush()
        XCTAssertTrue(client.waitUntilIdleForTesting())
        XCTAssertTrue(sink.records.isEmpty)
        XCTAssertNil(identity.identity.clerkUserID)

        client.setConsent(.denied)
        client.capture(.correctionCompleted(eventID: UUID()))
        client.screen(.capture)
        client.identify(clerkUserID: "user_private270")
        client.flush()
        XCTAssertTrue(client.waitUntilIdleForTesting())
        XCTAssertEqual(consent.consent, .denied)
        XCTAssertTrue(sink.records.isEmpty)
        XCTAssertNil(identity.identity.clerkUserID)
    }

    func testDeniedDebugActionCannotReplayAfterConcurrentConsentGrant() {
        let consent = DelayedAnalyticsConsentStore(consent: .denied)
        let sink = RecordingAnalyticsDebugSink()
        let client = DebugAnalyticsClient(
            metadata: metadata,
            consentStore: consent,
            dedupeStore: InMemoryAnalyticsDedupeStore(),
            identityStore: InMemoryAnalyticsIdentityStore(),
            sink: sink
        )
        client.capture(
            .correctionCompleted(
                eventID: UUID(uuidString: "27000000-0000-4000-8000-000000000021")!
            )
        )
        XCTAssertEqual(consent.readDidStart.wait(timeout: .now() + 1), .success)

        let grantAttemptStarted = DispatchSemaphore(value: 0)
        let grantReturned = expectation(description: "consent grant returned")
        DispatchQueue.global().async {
            grantAttemptStarted.signal()
            client.setConsent(.granted)
            grantReturned.fulfill()
        }
        XCTAssertEqual(grantAttemptStarted.wait(timeout: .now() + 1), .success)
        XCTAssertEqual(consent.grantDidPersist.wait(timeout: .now() + 0.1), .timedOut)
        consent.allowReadToReturn.signal()
        wait(for: [grantReturned], timeout: 1)
        XCTAssertTrue(client.waitUntilIdleForTesting())

        XCTAssertEqual(consent.consent, .granted)
        XCTAssertTrue(sink.records.isEmpty)
    }

    func testConsentDenialWaitsForAlreadyStartedDebugWorkToFinish() {
        let consent = InMemoryAnalyticsConsentStore(consent: .granted)
        let sink = BlockingAnalyticsDebugSink()
        let client = DebugAnalyticsClient(
            metadata: metadata,
            consentStore: consent,
            dedupeStore: InMemoryAnalyticsDedupeStore(),
            identityStore: InMemoryAnalyticsIdentityStore(),
            sink: sink
        )
        client.capture(
            .correctionCompleted(
                eventID: UUID(uuidString: "27000000-0000-4000-8000-000000000022")!
            )
        )
        XCTAssertEqual(sink.recordDidStart.wait(timeout: .now() + 1), .success)

        let denialAttemptStarted = DispatchSemaphore(value: 0)
        let denialReturned = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            denialAttemptStarted.signal()
            client.setConsent(.denied)
            denialReturned.signal()
        }
        XCTAssertEqual(denialAttemptStarted.wait(timeout: .now() + 1), .success)
        XCTAssertEqual(denialReturned.wait(timeout: .now() + 0.1), .timedOut)
        sink.allowRecordToReturn.signal()
        XCTAssertEqual(denialReturned.wait(timeout: .now() + 1), .success)
        XCTAssertTrue(client.waitUntilIdleForTesting())

        XCTAssertEqual(consent.consent, .denied)
    }

    func testDebugRuntimeRecordsSanitizedEventsOnceWithoutIdentityValues() throws {
        let suiteName = "AnalyticsContractTests-debug-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let sink = RecordingAnalyticsDebugSink()
        let eventID = UUID(uuidString: "27000000-0000-4000-8000-000000000020")!
        let client = DebugAnalyticsClient(
            metadata: metadata,
            consentStore: InMemoryAnalyticsConsentStore(consent: .granted),
            dedupeStore: UserDefaultsAnalyticsDedupeStore(defaults: defaults),
            identityStore: UserDefaultsAnalyticsIdentityStore(defaults: defaults),
            sink: sink
        )

        client.capture(.correctionCompleted(eventID: eventID))
        client.capture(.correctionCompleted(eventID: eventID))
        client.identify(clerkUserID: "seller@example.com")
        client.identify(clerkUserID: "user_private270")
        client.identify(clerkUserID: "user_other270")
        XCTAssertTrue(client.waitUntilIdleForTesting())

        XCTAssertEqual(
            sink.records,
            [
                .payload(
                    try XCTUnwrap(
                        AnalyticsSanitizer().sanitize(
                            event: .correctionCompleted(eventID: eventID),
                            metadata: metadata
                        )
                    )
                ),
                .identify,
            ]
        )
        XCTAssertFalse(String(describing: sink.records).contains("user_private270"))
    }

    func testDebugResetRotatesAnonymousIdentityAndAllowsOneNewClerkIdentity() {
        let originalID = UUID(uuidString: "27000000-0000-4000-8000-000000000030")!
        let identity = InMemoryAnalyticsIdentityStore(
            identity: AnalyticsIdentity(anonymousID: originalID, clerkUserID: nil)
        )
        let sink = RecordingAnalyticsDebugSink()
        let client = DebugAnalyticsClient(
            metadata: metadata,
            consentStore: InMemoryAnalyticsConsentStore(consent: .granted),
            dedupeStore: InMemoryAnalyticsDedupeStore(),
            identityStore: identity,
            sink: sink
        )

        client.identify(clerkUserID: "user_first270")
        client.reset()
        client.identify(clerkUserID: "user_second270")
        XCTAssertTrue(client.waitUntilIdleForTesting())

        XCTAssertNotEqual(identity.identity.anonymousID, originalID)
        XCTAssertEqual(identity.identity.clerkUserID, "user_second270")
        XCTAssertEqual(sink.records, [.identify, .reset, .identify])
    }

    func testDebugSinkFailureIsBestEffortAndDoesNotMarkEventDeduped() {
        let sink = FailingAnalyticsDebugSink()
        let dedupe = InMemoryAnalyticsDedupeStore()
        let eventID = UUID(uuidString: "27000000-0000-4000-8000-000000000040")!
        let client = DebugAnalyticsClient(
            metadata: metadata,
            consentStore: InMemoryAnalyticsConsentStore(consent: .granted),
            dedupeStore: dedupe,
            identityStore: InMemoryAnalyticsIdentityStore(),
            sink: sink
        )

        client.capture(.correctionCompleted(eventID: eventID))
        client.capture(.correctionCompleted(eventID: eventID))
        XCTAssertTrue(client.waitUntilIdleForTesting())

        XCTAssertEqual(sink.attempts, 2)
        XCTAssertFalse(dedupe.contains(eventID))
    }
}

private final class RecordingAnalyticsDebugSink: AnalyticsDebugSinking {
    private(set) var records: [AnalyticsDebugRecord] = []

    func record(_ record: AnalyticsDebugRecord) throws {
        records.append(record)
    }
}

private final class FailingAnalyticsDebugSink: AnalyticsDebugSinking {
    enum Failure: Error { case expected }
    private(set) var attempts = 0

    func record(_ record: AnalyticsDebugRecord) throws {
        attempts += 1
        throw Failure.expected
    }
}

private final class BlockingAnalyticsDebugSink: AnalyticsDebugSinking {
    let recordDidStart = DispatchSemaphore(value: 0)
    let allowRecordToReturn = DispatchSemaphore(value: 0)

    func record(_ record: AnalyticsDebugRecord) throws {
        recordDidStart.signal()
        _ = allowRecordToReturn.wait(timeout: .now() + 2)
    }
}

private final class DelayedAnalyticsConsentStore: AnalyticsConsentStoring, @unchecked Sendable {
    let readDidStart = DispatchSemaphore(value: 0)
    let allowReadToReturn = DispatchSemaphore(value: 0)
    let grantDidPersist = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var value: AnalyticsConsent
    private var shouldDelayRead = true

    init(consent: AnalyticsConsent) {
        value = consent
    }

    var consent: AnalyticsConsent {
        let shouldDelay = lock.withLock {
            defer { shouldDelayRead = false }
            return shouldDelayRead
        }
        if shouldDelay {
            readDidStart.signal()
            _ = allowReadToReturn.wait(timeout: .now() + 2)
        }
        return lock.withLock { value }
    }

    func setConsent(_ consent: AnalyticsConsent) {
        lock.withLock { value = consent }
        if consent == .granted {
            grantDidPersist.signal()
        }
    }
}
