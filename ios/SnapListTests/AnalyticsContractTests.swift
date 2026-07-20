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

    func testPostHogConfigurationRejectsInvalidMetadataBeforeTransportCreation() throws {
        let invalidMetadata = [
            AnalyticsMetadata(
                environment: .testFlight,
                appVersion: "private-version",
                build: "306"
            ),
            AnalyticsMetadata(
                environment: .testFlight,
                appVersion: "1.2.3",
                build: String(repeating: "9", count: 13)
            ),
            AnalyticsMetadata(
                environment: .testFlight,
                appVersion: "1.2.3",
                build: "306A"
            ),
        ]
        let factory = RecordingRealPostHogTransportFactory()
        var clients: [PostHogAnalyticsClient] = []

        for (index, metadata) in invalidMetadata.enumerated() {
            let configuration = AnalyticsPostHogConfiguration(
                metadata: metadata,
                projectToken: "phc_issue306_metadata_\(index)",
                host: URL(string: "https://127.0.0.1:1")!
            )
            XCTAssertNil(configuration)
            guard let configuration else { continue }
            let client = PostHogAnalyticsClient(
                configuration: configuration,
                consentStore: InMemoryAnalyticsConsentStore(consent: .granted),
                dedupeStore: InMemoryAnalyticsDedupeStore(),
                identityStore: InMemoryAnalyticsIdentityStore(),
                lifecycleStore: InMemoryAnalyticsTransportLifecycleStore(),
                dataPurger: try XCTUnwrap(FileSystemPostHogDataPurger()),
                transportFactory: factory
            )
            client.identify(clerkUserID: "user_issue306")
            client.finishPendingWorkForTesting()
            clients.append(client)
        }
        defer {
            for client in clients {
                try? client.setConsent(.denied)
            }
        }

        XCTAssertEqual(factory.creationCount, 0)
        XCTAssertTrue(factory.transports.isEmpty)
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
        client.finishPendingWorkForTesting()
        XCTAssertTrue(sink.records.isEmpty)
        XCTAssertNil(identity.identity.clerkUserID)

        client.setConsent(.denied)
        client.capture(.correctionCompleted(eventID: UUID()))
        client.screen(.capture)
        client.identify(clerkUserID: "user_private270")
        client.flush()
        client.finishPendingWorkForTesting()
        XCTAssertEqual(consent.consent, .denied)
        XCTAssertTrue(sink.records.isEmpty)
        XCTAssertNil(identity.identity.clerkUserID)
    }

    func testDeniedDebugActionCannotReplayAfterConcurrentConsentGrant() {
        let consent = DelayedAnalyticsConsentStore(consent: .denied)
        let sink = RecordingAnalyticsDebugSink()
        let grantDidSubmitConsentTransition = DispatchSemaphore(value: 0)
        let grantDidEnterConsentTransition = DispatchSemaphore(value: 0)
        let client = DebugAnalyticsClient(
            metadata: metadata,
            consentStore: consent,
            dedupeStore: InMemoryAnalyticsDedupeStore(),
            identityStore: InMemoryAnalyticsIdentityStore(),
            sink: sink,
            consentTransitionDidSubmit: { consent in
                if consent == .granted {
                    grantDidSubmitConsentTransition.signal()
                }
            },
            consentTransitionDidEnterSerializedBoundary: { consent in
                if consent == .granted {
                    grantDidEnterConsentTransition.signal()
                }
            }
        )
        client.capture(
            .correctionCompleted(
                eventID: UUID(uuidString: "27000000-0000-4000-8000-000000000021")!
            )
        )
        consent.readDidStart.wait()

        let grantReturned = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            client.setConsent(.granted)
            grantReturned.signal()
        }
        grantDidSubmitConsentTransition.wait()
        consent.allowReadToReturn.signal()
        grantDidEnterConsentTransition.wait()
        grantReturned.wait()
        client.finishPendingWorkForTesting()

        XCTAssertEqual(consent.consent, .granted)
        XCTAssertTrue(sink.records.isEmpty)
    }

    func testConsentDenialWaitsForAlreadyStartedDebugWorkToFinish() {
        let consent = InMemoryAnalyticsConsentStore(consent: .granted)
        let ordering = ConsentOrderingRecorder()
        let sink = BlockingAnalyticsDebugSink {
            ordering.append(.debugWorkFinished)
        }
        let denialDidSubmitConsentTransition = DispatchSemaphore(value: 0)
        let denialDidEnterConsentTransition = DispatchSemaphore(value: 0)
        let client = DebugAnalyticsClient(
            metadata: metadata,
            consentStore: consent,
            dedupeStore: InMemoryAnalyticsDedupeStore(),
            identityStore: InMemoryAnalyticsIdentityStore(),
            sink: sink,
            consentTransitionDidSubmit: { consent in
                if consent == .denied {
                    denialDidSubmitConsentTransition.signal()
                }
            },
            consentTransitionDidEnterSerializedBoundary: { consent in
                if consent == .denied {
                    ordering.append(.consentBoundaryEntered)
                    denialDidEnterConsentTransition.signal()
                }
            }
        )
        client.capture(
            .correctionCompleted(
                eventID: UUID(uuidString: "27000000-0000-4000-8000-000000000022")!
            )
        )
        sink.recordDidStart.wait()

        let denialReturned = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            client.setConsent(.denied)
            ordering.append(.consentReturned)
            denialReturned.signal()
        }
        denialDidSubmitConsentTransition.wait()
        sink.allowRecordToReturn.signal()
        denialDidEnterConsentTransition.wait()
        denialReturned.wait()
        client.finishPendingWorkForTesting()

        XCTAssertEqual(consent.consent, .denied)
        XCTAssertEqual(
            ordering.milestones,
            [.debugWorkFinished, .consentBoundaryEntered, .consentReturned]
        )
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
        client.finishPendingWorkForTesting()

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
        client.finishPendingWorkForTesting()

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
        client.finishPendingWorkForTesting()

        XCTAssertEqual(sink.attempts, 2)
        XCTAssertFalse(dedupe.contains(eventID))
    }

    func testThrowingDurablePurgeFailsClosedAcrossRegrantAndRelaunch() throws {
        let configuration = try XCTUnwrap(
            AnalyticsPostHogConfiguration(
                metadata: metadata,
                projectToken: "phc_issue271",
                host: URL(string: "https://us.i.posthog.com")!
            )
        )
        let consent = InMemoryAnalyticsConsentStore(consent: .granted)
        let lifecycle = InMemoryAnalyticsTransportLifecycleStore()
        let purger = ThrowingPostHogDataPurger()
        let factory = RecordingPostHogTransportFactory()
        let client = PostHogAnalyticsClient(
            configuration: configuration,
            consentStore: consent,
            dedupeStore: InMemoryAnalyticsDedupeStore(),
            identityStore: InMemoryAnalyticsIdentityStore(),
            lifecycleStore: lifecycle,
            dataPurger: purger,
            transportFactory: factory
        )

        XCTAssertEqual(factory.creationCount, 1)
        XCTAssertThrowsError(try client.setConsent(.denied))
        XCTAssertEqual(consent.consent, .denied)
        XCTAssertTrue(lifecycle.requiresPurge(for: configuration))
        XCTAssertEqual(factory.creationCount, 1)

        XCTAssertThrowsError(try client.setConsent(.granted))
        XCTAssertEqual(consent.consent, .denied)
        XCTAssertEqual(factory.creationCount, 1)

        _ = PostHogAnalyticsClient(
            configuration: configuration,
            consentStore: consent,
            dedupeStore: InMemoryAnalyticsDedupeStore(),
            identityStore: InMemoryAnalyticsIdentityStore(),
            lifecycleStore: lifecycle,
            dataPurger: purger,
            transportFactory: factory
        )
        XCTAssertEqual(factory.creationCount, 1)
    }

    func testMarkerWriteFailureStillPurgesResetsAndBlocksSameTokenRegrant() throws {
        let configuration = try postHogConfiguration(token: "phc_issue292_marker_failure")
        let consent = InMemoryAnalyticsConsentStore(consent: .granted)
        let lifecycle = ThrowingAnalyticsTransportLifecycleStore()
        let originalAnonymousID = UUID(
            uuidString: "29200000-0000-4000-8000-000000000001"
        )!
        let identity = InMemoryAnalyticsIdentityStore(
            identity: AnalyticsIdentity(
                anonymousID: originalAnonymousID,
                clerkUserID: "user_issue292"
            )
        )
        let purger = FailingFirstRecordingPostHogDataPurger()
        let factory = RecordingPostHogTransportFactory()
        let client = PostHogAnalyticsClient(
            configuration: configuration,
            consentStore: consent,
            dedupeStore: InMemoryAnalyticsDedupeStore(),
            identityStore: identity,
            lifecycleStore: lifecycle,
            dataPurger: purger,
            transportFactory: factory
        )

        XCTAssertThrowsError(try client.setConsent(.denied)) { error in
            XCTAssertEqual(
                error as? ThrowingAnalyticsTransportLifecycleStore.Failure,
                .markerWrite
            )
        }
        XCTAssertEqual(consent.consent, .denied)
        XCTAssertEqual(purger.attempts, 1)
        XCTAssertNotEqual(identity.identity.anonymousID, originalAnonymousID)
        XCTAssertNil(identity.identity.clerkUserID)
        XCTAssertTrue(try XCTUnwrap(factory.transports.first).isClosed)
        XCTAssertEqual(factory.creationCount, 1)

        XCTAssertThrowsError(try client.setConsent(.granted)) { error in
            XCTAssertEqual(
                error as? ThrowingAnalyticsTransportLifecycleStore.Failure,
                .cleanupProofWrite
            )
        }
        XCTAssertEqual(consent.consent, .denied)
        XCTAssertEqual(purger.attempts, 2)
        XCTAssertEqual(factory.creationCount, 1)
    }

    func testSuccessfulRevokePurgesBeforeReturningAndRegrantUsesFreshState() throws {
        let configuration = try postHogConfiguration(token: "phc_issue271_success")
        let consent = InMemoryAnalyticsConsentStore(consent: .granted)
        let lifecycle = InMemoryAnalyticsTransportLifecycleStore()
        let originalAnonymousID = UUID(uuidString: "27100000-0000-4000-8000-000000000001")!
        let identity = InMemoryAnalyticsIdentityStore(
            identity: AnalyticsIdentity(
                anonymousID: originalAnonymousID,
                clerkUserID: "user_issue271"
            )
        )
        let purger = RecordingPostHogDataPurger()
        let factory = RecordingPostHogTransportFactory()
        let client = PostHogAnalyticsClient(
            configuration: configuration,
            consentStore: consent,
            dedupeStore: InMemoryAnalyticsDedupeStore(),
            identityStore: identity,
            lifecycleStore: lifecycle,
            dataPurger: purger,
            transportFactory: factory
        )
        let preRevocationEventID = UUID(
            uuidString: "27100000-0000-4000-8000-000000000002"
        )!

        client.capture(.correctionCompleted(eventID: preRevocationEventID))
        client.finishPendingWorkForTesting()
        let firstTransport = try XCTUnwrap(factory.transports.first)
        XCTAssertEqual(firstTransport.captures.map(\.payload.name), ["correction completed"])

        try client.setConsent(.denied)

        XCTAssertEqual(consent.consent, .denied)
        XCTAssertEqual(purger.attempts, 1)
        XCTAssertFalse(lifecycle.requiresPurge(for: configuration))
        XCTAssertTrue(firstTransport.isClosed)
        XCTAssertNotEqual(identity.identity.anonymousID, originalAnonymousID)
        XCTAssertNil(identity.identity.clerkUserID)

        try client.setConsent(.granted)
        let secondTransport = try XCTUnwrap(factory.transports.last)
        XCTAssertEqual(consent.consent, .granted)
        XCTAssertEqual(purger.attempts, 2)
        XCTAssertEqual(factory.creationCount, 2)
        XCTAssertFalse(secondTransport === firstTransport)
        XCTAssertTrue(secondTransport.captures.isEmpty)
    }

    func testConcurrentDenyThenGrantSerializesPurgeBeforeRecreation() throws {
        let configuration = try postHogConfiguration(token: "phc_issue271_concurrent")
        let consent = InMemoryAnalyticsConsentStore(consent: .granted)
        let filesystemPurger = try XCTUnwrap(FileSystemPostHogDataPurger())
        try filesystemPurger.purge(configuration: configuration)
        let purger = BlockingFirstPostHogDataPurger(
            underlying: filesystemPurger
        )
        let factory = RecordingRealPostHogTransportFactory()
        let grantSubmitted = DispatchSemaphore(value: 0)
        let client = PostHogAnalyticsClient(
            configuration: configuration,
            consentStore: consent,
            dedupeStore: InMemoryAnalyticsDedupeStore(),
            identityStore: InMemoryAnalyticsIdentityStore(),
            lifecycleStore: InMemoryAnalyticsTransportLifecycleStore(),
            dataPurger: purger,
            transportFactory: factory,
            consentTransitionDidSubmit: { transition in
                if transition == .granted {
                    grantSubmitted.signal()
                }
            }
        )
        defer { try? client.setConsent(.denied) }
        let denialReturned = DispatchSemaphore(value: 0)
        let grantReturned = DispatchSemaphore(value: 0)

        DispatchQueue.global().async {
            try? client.setConsent(.denied)
            denialReturned.signal()
        }
        purger.firstAttemptDidStart.wait()
        DispatchQueue.global().async {
            try? client.setConsent(.granted)
            grantReturned.signal()
        }
        grantSubmitted.wait()
        XCTAssertEqual(factory.creationCount, 1)

        purger.allowFirstAttemptToReturn.signal()
        denialReturned.wait()
        grantReturned.wait()

        XCTAssertEqual(consent.consent, .granted)
        XCTAssertEqual(purger.attempts, 2)
        XCTAssertEqual(factory.creationCount, 2)
        XCTAssertTrue(factory.transports[0].isClosed)
        XCTAssertFalse(factory.transports[1].isClosed)
    }

    func testPendingDenialPreventsOlderGrantFromReopeningTransport() throws {
        let configuration = try postHogConfiguration(token: "phc_issue271_grant_deny")
        let consent = InMemoryAnalyticsConsentStore(consent: .denied)
        let filesystemPurger = try XCTUnwrap(FileSystemPostHogDataPurger())
        try filesystemPurger.purge(configuration: configuration)
        let purger = BlockingFirstPostHogDataPurger(
            underlying: filesystemPurger
        )
        let factory = RecordingRealPostHogTransportFactory()
        let denialSubmitted = DispatchSemaphore(value: 0)
        let grantErrors = ThreadSafeErrorRecorder()
        let client = PostHogAnalyticsClient(
            configuration: configuration,
            consentStore: consent,
            dedupeStore: InMemoryAnalyticsDedupeStore(),
            identityStore: InMemoryAnalyticsIdentityStore(),
            lifecycleStore: InMemoryAnalyticsTransportLifecycleStore(),
            dataPurger: purger,
            transportFactory: factory,
            consentTransitionDidSubmit: { transition in
                if transition == .denied {
                    denialSubmitted.signal()
                }
            }
        )
        let grantReturned = DispatchSemaphore(value: 0)
        let denialReturned = DispatchSemaphore(value: 0)

        DispatchQueue.global().async {
            do {
                try client.setConsent(.granted)
            } catch {
                grantErrors.append(error)
            }
            grantReturned.signal()
        }
        purger.firstAttemptDidStart.wait()
        DispatchQueue.global().async {
            try? client.setConsent(.denied)
            denialReturned.signal()
        }
        denialSubmitted.wait()
        purger.allowFirstAttemptToReturn.signal()
        grantReturned.wait()
        denialReturned.wait()

        XCTAssertEqual(consent.consent, .denied)
        XCTAssertEqual(purger.attempts, 2)
        XCTAssertEqual(factory.creationCount, 0)
        XCTAssertEqual(grantErrors.count, 1)
        XCTAssertTrue(grantErrors.first is AnalyticsConsentTransitionError)
    }

    func testSupersededDenialCannotPurgeAfterNewerGrantCommitsFirst() throws {
        let token = "phc_issue271_deny_inversion_\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))"
        let configuration = try postHogConfiguration(token: token)
        let consent = InMemoryAnalyticsConsentStore(consent: .granted)
        let purger = try XCTUnwrap(FileSystemPostHogDataPurger())
        try purger.purge(configuration: configuration)
        let factory = RecordingRealPostHogTransportFactory()
        let registrationBlocker = OneShotConsentRegistrationBlocker(consent: .denied)
        let client = PostHogAnalyticsClient(
            configuration: configuration,
            consentStore: consent,
            dedupeStore: InMemoryAnalyticsDedupeStore(),
            identityStore: InMemoryAnalyticsIdentityStore(),
            lifecycleStore: InMemoryAnalyticsTransportLifecycleStore(),
            dataPurger: purger,
            transportFactory: factory,
            consentTransitionDidRegisterBeforeGateMutation: { transition in
                registrationBlocker.handle(transition)
            }
        )
        defer { try? client.setConsent(.denied) }
        let denialReturned = DispatchSemaphore(value: 0)

        DispatchQueue.global().async {
            try? client.setConsent(.denied)
            denialReturned.signal()
        }
        registrationBlocker.didBlock.wait()

        try client.setConsent(.granted)
        registrationBlocker.allowReturn.signal()
        denialReturned.wait()

        XCTAssertEqual(consent.consent, .granted)
        XCTAssertEqual(factory.creationCount, 1)
        XCTAssertFalse(try XCTUnwrap(factory.transports.first).isClosed)
    }

    func testSupersededDenialCannotRevokeGateAfterNewerGrantCommits() throws {
        let configuration = try postHogConfiguration(token: "phc_issue271_gate_inversion")
        let consent = InMemoryAnalyticsConsentStore(consent: .granted)
        let factory = RecordingPostHogTransportFactory()
        let registrationBlocker = OneShotConsentRegistrationBlocker(consent: .denied)
        let client = PostHogAnalyticsClient(
            configuration: configuration,
            consentStore: consent,
            dedupeStore: InMemoryAnalyticsDedupeStore(),
            identityStore: InMemoryAnalyticsIdentityStore(),
            lifecycleStore: InMemoryAnalyticsTransportLifecycleStore(),
            dataPurger: RecordingPostHogDataPurger(),
            transportFactory: factory,
            consentTransitionDidRegisterBeforeGateMutation: { transition in
                registrationBlocker.handle(transition)
            }
        )
        let denialReturned = DispatchSemaphore(value: 0)

        DispatchQueue.global().async {
            try? client.setConsent(.denied)
            denialReturned.signal()
        }
        registrationBlocker.didBlock.wait()

        try client.setConsent(.granted)
        registrationBlocker.allowReturn.signal()
        denialReturned.wait()

        let eventID = UUID(uuidString: "27100000-0000-4000-8000-000000000009")!
        client.capture(.correctionCompleted(eventID: eventID))
        client.finishPendingWorkForTesting()

        XCTAssertEqual(consent.consent, .granted)
        XCTAssertTrue(factory.canRegisterNetworkTask())
        XCTAssertEqual(factory.transports.flatMap(\.captures).map(\.payload.name), [
            "correction completed",
        ])
    }

    func testDurablePurgeMarkerBlocksSameTokenAcrossEnvironmentAndRelaunch() throws {
        let lifecycleRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("AnalyticsContractTests-lifecycle-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: lifecycleRoot) }
        let testFlightConfiguration = try postHogConfiguration(
            token: "phc_issue271_relaunch",
            environment: .testFlight
        )
        let productionConfiguration = try postHogConfiguration(
            token: "phc_issue271_relaunch",
            environment: .production
        )
        let firstLifecycle = FileAnalyticsTransportLifecycleStore(rootURL: lifecycleRoot)
        try firstLifecycle.markPurgeRequired(for: testFlightConfiguration)
        let restoredLifecycle = FileAnalyticsTransportLifecycleStore(rootURL: lifecycleRoot)
        let factory = RecordingRealPostHogTransportFactory()

        _ = PostHogAnalyticsClient(
            configuration: productionConfiguration,
            consentStore: InMemoryAnalyticsConsentStore(consent: .granted),
            dedupeStore: InMemoryAnalyticsDedupeStore(),
            identityStore: InMemoryAnalyticsIdentityStore(),
            lifecycleStore: restoredLifecycle,
            dataPurger: ThrowingPostHogDataPurger(),
            transportFactory: factory
        )

        XCTAssertEqual(
            testFlightConfiguration.lifecycleIdentifier,
            productionConfiguration.lifecycleIdentifier
        )
        XCTAssertTrue(restoredLifecycle.requiresPurge(for: productionConfiguration))
        XCTAssertEqual(factory.creationCount, 0)
    }

    func testPostHogSDKConfigurationAllowsOnlyApprovedBatchTransport() throws {
        let configuration = try postHogConfiguration(
            token: "phc_issue271_configuration",
            maxQueueSize: 10_000
        )
        let sdkConfiguration = PostHogSDKTransportFactory().makeSDKConfiguration(
            configuration: configuration,
            gateIdentifier: "issue-271-gate"
        )

        XCTAssertEqual(configuration.maxQueueSize, 256)
        XCTAssertEqual(sdkConfiguration.maxQueueSize, 256)
        XCTAssertFalse(sdkConfiguration.captureApplicationLifecycleEvents)
        XCTAssertFalse(sdkConfiguration.captureScreenViews)
        XCTAssertFalse(sdkConfiguration.enableSwizzling)
        XCTAssertFalse(sdkConfiguration.sendFeatureFlagEvent)
        XCTAssertFalse(sdkConfiguration.preloadFeatureFlags)
        XCTAssertFalse(sdkConfiguration.setDefaultPersonProperties)
        XCTAssertFalse(sdkConfiguration.sessionReplay)
        XCTAssertFalse(sdkConfiguration.sessionReplayConfig.captureNetworkTelemetry)
        XCTAssertFalse(sdkConfiguration.sessionReplayConfig.captureLogs)
        XCTAssertFalse(sdkConfiguration.errorTrackingConfig.autoCapture)
        XCTAssertFalse(sdkConfiguration.errorTrackingConfig.exceptionSteps.enabled)
        XCTAssertFalse(sdkConfiguration.captureElementInteractions)
        XCTAssertFalse(sdkConfiguration.rageClickConfig.enabled)
        XCTAssertFalse(sdkConfiguration.surveys)
        XCTAssertNil(sdkConfiguration.tracingHeaders)
        XCTAssertNil(sdkConfiguration.requestHeaders)
        XCTAssertEqual(
            sdkConfiguration.urlSessionConfiguration?
                .httpAdditionalHeaders?[PostHogBatchOnlyURLProtocol.gateHeader] as? String,
            "issue-271-gate"
        )
        XCTAssertTrue(
            sdkConfiguration.urlSessionConfiguration?.protocolClasses?.contains {
                ObjectIdentifier($0) == ObjectIdentifier(PostHogBatchOnlyURLProtocol.self)
            } == true
        )

        let allowedRequest = URLRequest(url: URL(string: "https://us.i.posthog.com/batch")!)
        XCTAssertTrue(PostHogBatchOnlyURLProtocol.allowsNetworkRequest(allowedRequest))
        let productionOrigin = URL(string: "https://us.i.posthog.com")!
        let productionGate = PostHogNetworkGate(allowedOrigin: productionOrigin)
        XCTAssertTrue(productionGate.allowsDestination(allowedRequest))
        let assetsBatchRequest = URLRequest(
            url: URL(string: "https://us-assets.i.posthog.com/batch")!
        )
        XCTAssertTrue(PostHogBatchOnlyURLProtocol.allowsNetworkRequest(assetsBatchRequest))
        XCTAssertFalse(productionGate.allowsDestination(assetsBatchRequest))
        for path in [
            "/array/phc_issue271_configuration/config",
            "/flags",
            "/s/",
            "/i/v1/logs",
            "/e/",
        ] {
            let request = URLRequest(url: URL(string: "https://us.i.posthog.com\(path)")!)
            XCTAssertFalse(
                PostHogBatchOnlyURLProtocol.allowsNetworkRequest(request),
                "Expected \(path) to stay blocked"
            )
        }
        XCTAssertEqual(
            PostHogSDKTransportFactory.approvedEventNames,
            Set(AnalyticsSanitizer.approvedEventNames).union(["$identify"])
        )
    }

    func testRealPostHogAdapterBoundsOfflineQueueThenRevokePurgesQueueAndIdentity() throws {
        let token = "phc_issue271_real_\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))"
        let configuration = try postHogConfiguration(token: token, maxQueueSize: 2)
        let applicationSupport = try XCTUnwrap(
            FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        )
        let bundleIdentifier = Bundle.main.bundleIdentifier ?? "com.snaplist.app"
        let tokenRoot = applicationSupport
            .appendingPathComponent(bundleIdentifier, isDirectory: true)
            .appendingPathComponent(token, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tokenRoot) }
        let identity = InMemoryAnalyticsIdentityStore(
            identity: AnalyticsIdentity(
                anonymousID: UUID(uuidString: "27100000-0000-4000-8000-000000000010")!,
                clerkUserID: nil
            )
        )
        let purger = try XCTUnwrap(FileSystemPostHogDataPurger())
        let client = PostHogAnalyticsClient(
            configuration: configuration,
            consentStore: InMemoryAnalyticsConsentStore(consent: .granted),
            dedupeStore: InMemoryAnalyticsDedupeStore(),
            identityStore: identity,
            lifecycleStore: InMemoryAnalyticsTransportLifecycleStore(),
            dataPurger: purger
        )
        defer { try? client.setConsent(.denied) }
        let originalAnonymousID = identity.identity.anonymousID

        for suffix in 11 ... 13 {
            client.capture(
                .correctionCompleted(
                    eventID: UUID(
                        uuidString: "27100000-0000-4000-8000-0000000000\(suffix)"
                    )!
                )
            )
        }
        client.identify(clerkUserID: "user_issue271real")
        client.finishPendingWorkForTesting()

        let queueURL = tokenRoot.appendingPathComponent("posthog.queueFolder.uuid")
        let queuedEvents = try decodedPostHogEvents(in: queueURL)
        XCTAssertEqual(queuedEvents.count, 2)
        XCTAssertTrue(queuedEvents.contains { $0["event"] as? String == "$identify" })
        XCTAssertFalse(queuedEvents.contains { $0["event"] as? String == "$feature_flag_called" })
        for event in queuedEvents {
            let eventName = try XCTUnwrap(event["event"] as? String)
            let properties = try XCTUnwrap(event["properties"] as? [String: Any])
            XCTAssertEqual(
                Set(properties.keys),
                PostHogSDKTransportFactory.approvedPropertyNamesByEvent[eventName]
            )
            XCTAssertNil(properties["$session_id"])
            XCTAssertNil(properties["$device_id"])
            XCTAssertNil(properties["$network_type"])
        }

        try client.setConsent(.denied)

        XCTAssertFalse(FileManager.default.fileExists(atPath: tokenRoot.path))
        XCTAssertNotEqual(identity.identity.anonymousID, originalAnonymousID)
        XCTAssertNil(identity.identity.clerkUserID)
    }

    func testRealPostHogAdapterDedupeResetDenyGrantAndQueueIsolation() throws {
        let token = "phc_issue271_matrix_\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))"
        let configuration = try postHogConfiguration(token: token, maxQueueSize: 16)
        let applicationSupport = try XCTUnwrap(
            FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        )
        let bundleIdentifier = Bundle.main.bundleIdentifier ?? "com.snaplist.app"
        let tokenRoot = applicationSupport
            .appendingPathComponent(bundleIdentifier, isDirectory: true)
            .appendingPathComponent(token, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tokenRoot) }
        let consent = InMemoryAnalyticsConsentStore(consent: .denied)
        let identity = InMemoryAnalyticsIdentityStore(
            identity: AnalyticsIdentity(
                anonymousID: UUID(uuidString: "27100000-0000-4000-8000-000000000030")!,
                clerkUserID: nil
            )
        )
        let lifecycle = InMemoryAnalyticsTransportLifecycleStore()
        let purger = try XCTUnwrap(FileSystemPostHogDataPurger())
        let factory = RecordingRealPostHogTransportFactory()
        let client = PostHogAnalyticsClient(
            configuration: configuration,
            consentStore: consent,
            dedupeStore: InMemoryAnalyticsDedupeStore(),
            identityStore: identity,
            lifecycleStore: lifecycle,
            dataPurger: purger,
            transportFactory: factory
        )
        defer { try? client.setConsent(.denied) }
        let firstEventID = UUID(uuidString: "27100000-0000-4000-8000-000000000031")!
        let secondEventID = UUID(uuidString: "27100000-0000-4000-8000-000000000032")!
        let preGrantAnonymousID = identity.identity.anonymousID

        try client.setConsent(.granted)
        let grantedAnonymousID = identity.identity.anonymousID
        XCTAssertNotEqual(grantedAnonymousID, preGrantAnonymousID)
        client.capture(.correctionCompleted(eventID: firstEventID))
        client.capture(.correctionCompleted(eventID: firstEventID))
        client.reset()
        client.identify(clerkUserID: "user_issue271matrix")
        client.capture(.paywallViewed(eventID: secondEventID, trigger: .publish))
        client.finishPendingWorkForTesting()

        let queueURL = tokenRoot.appendingPathComponent("posthog.queueFolder.uuid")
        let beforeRevoke = try decodedPostHogEvents(in: queueURL)
        XCTAssertEqual(beforeRevoke.count, 3)
        XCTAssertEqual(factory.creationCount, 1)
        XCTAssertEqual(factory.transports.first?.sessionResets, 1)
        XCTAssertEqual(
            beforeRevoke.first { $0["event"] as? String == "correction completed" }?["distinct_id"] as? String,
            grantedAnonymousID.uuidString.lowercased()
        )
        XCTAssertEqual(
            beforeRevoke.first { $0["event"] as? String == "paywall viewed" }?["distinct_id"] as? String,
            "user_issue271matrix"
        )
        XCTAssertEqual(
            beforeRevoke.filter {
                (($0["properties"] as? [String: Any])?["event_id"] as? String)
                    == firstEventID.uuidString.lowercased()
            }.count,
            1
        )
        for event in beforeRevoke {
            let eventName = try XCTUnwrap(event["event"] as? String)
            let properties = try XCTUnwrap(event["properties"] as? [String: Any])
            XCTAssertEqual(
                Set(properties.keys),
                PostHogSDKTransportFactory.approvedPropertyNamesByEvent[eventName]
            )
            XCTAssertNil(properties["$session_id"])
        }

        try client.setConsent(.denied)
        XCTAssertFalse(FileManager.default.fileExists(atPath: tokenRoot.path))
        try client.setConsent(.granted)
        XCTAssertEqual(factory.creationCount, 2)
        XCTAssertTrue(try decodedPostHogEvents(in: queueURL).isEmpty)

        let postRegrantEventID = UUID(
            uuidString: "27100000-0000-4000-8000-000000000033"
        )!
        client.capture(.correctionCompleted(eventID: postRegrantEventID))
        client.finishPendingWorkForTesting()
        let afterRegrant = try decodedPostHogEvents(in: queueURL)
        XCTAssertEqual(afterRegrant.count, 1)
        let serializedAfterRegrant = try JSONSerialization.data(
            withJSONObject: afterRegrant,
            options: [.sortedKeys]
        )
        let afterRegrantText = String(decoding: serializedAfterRegrant, as: UTF8.self)
        XCTAssertTrue(afterRegrantText.contains(postRegrantEventID.uuidString.lowercased()))
        XCTAssertFalse(afterRegrantText.contains(firstEventID.uuidString.lowercased()))
        XCTAssertFalse(afterRegrantText.contains(secondEventID.uuidString.lowercased()))
    }

    func testProviderDedupeResetAndTransportFailureStayBestEffort() throws {
        let configuration = try postHogConfiguration(token: "phc_issue271_behavior")
        let consent = InMemoryAnalyticsConsentStore(consent: .granted)
        let dedupe = InMemoryAnalyticsDedupeStore()
        let originalAnonymousID = UUID(uuidString: "27100000-0000-4000-8000-000000000020")!
        let identity = InMemoryAnalyticsIdentityStore(
            identity: AnalyticsIdentity(anonymousID: originalAnonymousID, clerkUserID: nil)
        )
        let factory = RecordingPostHogTransportFactory()
        let client = PostHogAnalyticsClient(
            configuration: configuration,
            consentStore: consent,
            dedupeStore: dedupe,
            identityStore: identity,
            lifecycleStore: InMemoryAnalyticsTransportLifecycleStore(),
            dataPurger: RecordingPostHogDataPurger(),
            transportFactory: factory
        )
        let eventID = UUID(uuidString: "27100000-0000-4000-8000-000000000021")!

        client.capture(.correctionCompleted(eventID: eventID))
        client.capture(.correctionCompleted(eventID: eventID))
        client.identify(clerkUserID: "user_issue271first")
        client.reset()
        client.identify(clerkUserID: "user_issue271second")
        client.capture(.paywallViewed(eventID: UUID(), trigger: .publish))
        client.finishPendingWorkForTesting()

        let transport = try XCTUnwrap(factory.transports.first)
        XCTAssertEqual(transport.captures.count, 2)
        XCTAssertEqual(transport.sessionResets, 1)
        XCTAssertEqual(transport.captures.first?.distinctID, originalAnonymousID.uuidString.lowercased())
        XCTAssertNotEqual(transport.captures.last?.distinctID, originalAnonymousID.uuidString.lowercased())
        XCTAssertEqual(
            transport.identifications.map(\.clerkUserID),
            ["user_issue271first", "user_issue271second"]
        )

        transport.shouldThrowOnCapture = true
        let failedEventID = UUID(uuidString: "27100000-0000-4000-8000-000000000022")!
        client.capture(.correctionCompleted(eventID: failedEventID))
        client.capture(.correctionCompleted(eventID: failedEventID))
        client.finishPendingWorkForTesting()
        XCTAssertEqual(transport.failedCaptureAttempts, 2)
        XCTAssertFalse(dedupe.contains(failedEventID))
    }

    func testFilePurgerDeletesOnlyExactTokenRoot() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("AnalyticsContractTests-purge-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let configuration = try postHogConfiguration(token: "phc_issue271_exact")
        let tokenRoot = root.appendingPathComponent(configuration.projectToken)
        let siblingRoot = root.appendingPathComponent("phc_issue271_sibling")
        try FileManager.default.createDirectory(at: tokenRoot, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: siblingRoot, withIntermediateDirectories: true)
        try Data("queued identity".utf8).write(
            to: tokenRoot.appendingPathComponent("posthog.queueFolder.uuid")
        )
        try Data("preserve".utf8).write(to: siblingRoot.appendingPathComponent("queue"))

        try XCTUnwrap(FileSystemPostHogDataPurger(storageRoot: root))
            .purge(configuration: configuration)

        XCTAssertFalse(FileManager.default.fileExists(atPath: tokenRoot.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: siblingRoot.path))
    }

    private func postHogConfiguration(
        token: String,
        environment: AnalyticsEnvironment = .testFlight,
        maxQueueSize: Int = 64
    ) throws -> AnalyticsPostHogConfiguration {
        try XCTUnwrap(
            AnalyticsPostHogConfiguration(
                metadata: AnalyticsMetadata(
                    environment: environment,
                    appVersion: "0.1.0",
                    build: "271"
                ),
                projectToken: token,
                host: URL(string: "https://127.0.0.1:1")!,
                maxQueueSize: maxQueueSize
            )
        )
    }

    private func decodedPostHogEvents(in queueURL: URL) throws -> [[String: Any]] {
        try FileManager.default.contentsOfDirectory(
            at: queueURL,
            includingPropertiesForKeys: nil
        ).map { url in
            let object = try JSONSerialization.jsonObject(with: Data(contentsOf: url))
            return try XCTUnwrap(object as? [String: Any])
        }
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
    private let recordDidFinish: @Sendable () -> Void

    init(recordDidFinish: @escaping @Sendable () -> Void) {
        self.recordDidFinish = recordDidFinish
    }

    func record(_ record: AnalyticsDebugRecord) throws {
        recordDidStart.signal()
        allowRecordToReturn.wait()
        recordDidFinish()
    }
}

private enum ConsentOrderingMilestone: Equatable {
    case debugWorkFinished
    case consentBoundaryEntered
    case consentReturned
}

private final class ConsentOrderingRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [ConsentOrderingMilestone] = []

    var milestones: [ConsentOrderingMilestone] {
        lock.withLock { values }
    }

    func append(_ milestone: ConsentOrderingMilestone) {
        lock.withLock { values.append(milestone) }
    }
}

private final class DelayedAnalyticsConsentStore: AnalyticsConsentStoring, @unchecked Sendable {
    let readDidStart = DispatchSemaphore(value: 0)
    let allowReadToReturn = DispatchSemaphore(value: 0)
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
            allowReadToReturn.wait()
        }
        return lock.withLock { value }
    }

    func setConsent(_ consent: AnalyticsConsent) {
        lock.withLock { value = consent }
    }
}

private final class ThrowingPostHogDataPurger: PostHogDurableDataPurging {
    enum Failure: Error { case expected }

    func purge(configuration: AnalyticsPostHogConfiguration) throws {
        throw Failure.expected
    }
}

private final class ThrowingAnalyticsTransportLifecycleStore:
    AnalyticsTransportLifecycleStoring
{
    enum Failure: Error, Equatable {
        case markerWrite
        case cleanupProofWrite
    }

    func requiresPurge(for configuration: AnalyticsPostHogConfiguration) -> Bool {
        false
    }

    func markPurgeRequired(for configuration: AnalyticsPostHogConfiguration) throws {
        throw Failure.markerWrite
    }

    func markPurged(for configuration: AnalyticsPostHogConfiguration) throws {
        throw Failure.cleanupProofWrite
    }
}

private final class RecordingPostHogDataPurger: PostHogDurableDataPurging {
    private let lock = NSLock()
    private var attemptCount = 0

    var attempts: Int { lock.withLock { attemptCount } }

    func purge(configuration: AnalyticsPostHogConfiguration) throws {
        lock.withLock { attemptCount += 1 }
    }
}

private final class FailingFirstRecordingPostHogDataPurger: PostHogDurableDataPurging {
    enum Failure: Error { case expected }

    private let lock = NSLock()
    private var attemptCount = 0

    var attempts: Int { lock.withLock { attemptCount } }

    func purge(configuration: AnalyticsPostHogConfiguration) throws {
        let attempt = lock.withLock {
            attemptCount += 1
            return attemptCount
        }
        if attempt == 1 {
            throw Failure.expected
        }
    }
}

private final class BlockingFirstPostHogDataPurger: PostHogDurableDataPurging {
    let firstAttemptDidStart = DispatchSemaphore(value: 0)
    let allowFirstAttemptToReturn = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var attemptCount = 0
    private let underlying: (any PostHogDurableDataPurging)?

    init(underlying: (any PostHogDurableDataPurging)? = nil) {
        self.underlying = underlying
    }

    var attempts: Int { lock.withLock { attemptCount } }

    func purge(configuration: AnalyticsPostHogConfiguration) throws {
        let attempt = lock.withLock {
            attemptCount += 1
            return attemptCount
        }
        if attempt == 1 {
            firstAttemptDidStart.signal()
            allowFirstAttemptToReturn.wait()
        }
        try underlying?.purge(configuration: configuration)
    }
}

private final class ThreadSafeErrorRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [any Error] = []

    var count: Int { lock.withLock { values.count } }
    var first: (any Error)? { lock.withLock { values.first } }

    func append(_ error: any Error) {
        lock.withLock { values.append(error) }
    }
}

private final class OneShotConsentRegistrationBlocker: @unchecked Sendable {
    let didBlock = DispatchSemaphore(value: 0)
    let allowReturn = DispatchSemaphore(value: 0)
    private let consent: AnalyticsConsent
    private let lock = NSLock()
    private var hasBlocked = false

    init(consent: AnalyticsConsent) {
        self.consent = consent
    }

    func handle(_ transition: AnalyticsConsent) {
        let shouldBlock = lock.withLock {
            guard transition == consent, !hasBlocked else { return false }
            hasBlocked = true
            return true
        }
        guard shouldBlock else { return }
        didBlock.signal()
        allowReturn.wait()
    }
}

private final class RecordingPostHogTransportFactory: PostHogTransportBuilding {
    private let lock = NSLock()
    private var values: [RecordingPostHogTransport] = []
    private var networkGates: [PostHogNetworkGate] = []

    var transports: [RecordingPostHogTransport] { lock.withLock { values } }
    var creationCount: Int { lock.withLock { values.count } }

    func makeTransport(
        configuration: AnalyticsPostHogConfiguration,
        networkGate: PostHogNetworkGate
    ) -> any PostHogTransport {
        let transport = RecordingPostHogTransport()
        lock.withLock {
            values.append(transport)
            networkGates.append(networkGate)
        }
        return transport
    }

    func canRegisterNetworkTask() -> Bool {
        guard let networkGate = lock.withLock({ networkGates.last }) else {
            return false
        }
        let task = URLSession.shared.dataTask(with: URL(string: "https://example.invalid")!)
        let accepted = networkGate.register(task)
        if accepted {
            networkGate.finish(task)
        }
        task.cancel()
        return accepted
    }
}

private final class RecordingRealPostHogTransportFactory: PostHogTransportBuilding {
    private let lock = NSLock()
    private let underlying = PostHogSDKTransportFactory()
    private var values: [RecordingDelegatingPostHogTransport] = []

    var transports: [RecordingDelegatingPostHogTransport] { lock.withLock { values } }
    var creationCount: Int { lock.withLock { values.count } }

    func makeTransport(
        configuration: AnalyticsPostHogConfiguration,
        networkGate: PostHogNetworkGate
    ) -> any PostHogTransport {
        let transport = RecordingDelegatingPostHogTransport(
            underlying: underlying.makeTransport(
                configuration: configuration,
                networkGate: networkGate
            )
        )
        lock.withLock { values.append(transport) }
        return transport
    }
}

private final class RecordingDelegatingPostHogTransport: PostHogTransport {
    private let underlying: any PostHogTransport
    private let lock = NSLock()
    private var closed = false
    private var sessionResetCount = 0

    init(underlying: any PostHogTransport) {
        self.underlying = underlying
    }

    var isClosed: Bool { lock.withLock { closed } }
    var sessionResets: Int { lock.withLock { sessionResetCount } }

    func capture(_ payload: AnalyticsPayload, distinctID: String) throws {
        try underlying.capture(payload, distinctID: distinctID)
    }

    func identify(clerkUserID: String, anonymousID: String) throws {
        try underlying.identify(clerkUserID: clerkUserID, anonymousID: anonymousID)
    }

    func resetSession() {
        lock.withLock { sessionResetCount += 1 }
        underlying.resetSession()
    }

    func flush() {
        underlying.flush()
    }

    func close() {
        lock.withLock { closed = true }
        underlying.close()
    }
}

private final class RecordingPostHogTransport: PostHogTransport {
    struct Capture {
        let payload: AnalyticsPayload
        let distinctID: String
    }

    struct Identification {
        let clerkUserID: String
        let anonymousID: String
    }

    enum Failure: Error { case expected }

    private let lock = NSLock()
    private var captureValues: [Capture] = []
    private var identificationValues: [Identification] = []
    private var closed = false
    private var sessionResetCount = 0
    private var throwOnCapture = false
    private var failedAttempts = 0

    var captures: [Capture] { lock.withLock { captureValues } }
    var identifications: [Identification] { lock.withLock { identificationValues } }
    var isClosed: Bool { lock.withLock { closed } }
    var sessionResets: Int { lock.withLock { sessionResetCount } }
    var failedCaptureAttempts: Int { lock.withLock { failedAttempts } }
    var shouldThrowOnCapture: Bool {
        get { lock.withLock { throwOnCapture } }
        set { lock.withLock { throwOnCapture = newValue } }
    }

    func capture(_ payload: AnalyticsPayload, distinctID: String) throws {
        try lock.withLock {
            if throwOnCapture {
                failedAttempts += 1
                throw Failure.expected
            }
            captureValues.append(Capture(payload: payload, distinctID: distinctID))
        }
    }

    func identify(clerkUserID: String, anonymousID: String) throws {
        lock.withLock {
            identificationValues.append(
                Identification(clerkUserID: clerkUserID, anonymousID: anonymousID)
            )
        }
    }

    func resetSession() {
        lock.withLock { sessionResetCount += 1 }
    }

    func flush() {}
    func close() {
        lock.withLock { closed = true }
    }
}
