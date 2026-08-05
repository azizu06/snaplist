import Foundation
import XCTest
@testable import SnapList

@MainActor
final class EbayPublishDeliveryTests: XCTestCase {
    override func tearDown() {
        EbayPublishURLProtocolStub.handler = nil
        super.tearDown()
    }

    func testProductionFlowRelaunchReplaysAmbiguousPublishAndConvergesOnce()
        async throws {
        let listingID = UUID(uuidString: "37700000-0000-4000-8000-000000000020")!
        let reviewRevision = UUID(uuidString: "37700000-0000-4000-8000-000000000002")!
        let root = FileManager.default.temporaryDirectory.appending(
            path: "ebay-publish-relaunch-\(UUID().uuidString)",
            directoryHint: .isDirectory
        )
        let attemptURL = root.appending(path: "attempts.json")
        addTeardownBlock {
            try? FileManager.default.removeItem(at: root)
        }
        let preflight = Self.preflight(
            title: "Saved seller draft",
            revision: reviewRevision
        )
        let service = AmbiguousThenReplayEbayPublishService(preflight: preflight)

        let firstFlow = EbayPublishFlowStore(
            listingID: listingID,
            service: service,
            oauth: EbayOAuthFixtureRunner(result: .connected),
            attemptStore: FileEbayPublishAttemptStore(fileURL: attemptURL)
        )
        await firstFlow.load()
        await firstFlow.confirmPublish()

        XCTAssertEqual(firstFlow.screen, .result(.outcomeNotYetKnown))

        let funnelAnalytics = FunnelAnalyticsEventSinkSpy()
        let relaunchedFlow = EbayPublishFlowStore(
            listingID: listingID,
            service: service,
            oauth: EbayOAuthFixtureRunner(result: .connected),
            attemptStore: FileEbayPublishAttemptStore(fileURL: attemptURL),
            funnelAnalytics: funnelAnalytics
        )
        await relaunchedFlow.load()

        let providerTruth = await service.providerTruth
        XCTAssertEqual(providerTruth.mutationCount, 1)
        XCTAssertEqual(providerTruth.idempotencyKeys.count, 2)
        XCTAssertEqual(
            providerTruth.idempotencyKeys.first,
            providerTruth.idempotencyKeys.last
        )
        XCTAssertEqual(
            relaunchedFlow.publishedListing?.ebayListingID,
            providerTruth.canonicalListing.ebayListingID
        )
        XCTAssertEqual(relaunchedFlow.screen, .result(.published))
        await relaunchedFlow.load()
        XCTAssertEqual(funnelAnalytics.events, [.ebayPublishConfirmed])
    }

    func testIOS170UsesTheOwnedCustomSchemeCallbackBridge() throws {
        let target = try XCTUnwrap(
            EbayOAuthCallbackTarget.resolve(
                httpsCallbackURL: URL(
                    string: "https://snaplist.dev/mobile/ebay/oauth"
                )!,
                supportsHTTPSCallback: false
            )
        )

        XCTAssertEqual(
            target,
            .customScheme(
                scheme: "snaplist",
                expectedURL: URL(string: "snaplist://ebay/oauth")!
            )
        )
    }

    func testIOS174UsesTheAssociatedHTTPSCallback() throws {
        let callbackURL = URL(
            string: "https://snaplist.dev/mobile/ebay/oauth"
        )!
        let target = try XCTUnwrap(
            EbayOAuthCallbackTarget.resolve(
                httpsCallbackURL: callbackURL,
                supportsHTTPSCallback: true
            )
        )

        XCTAssertEqual(
            target,
            .https(host: "snaplist.dev", path: "/mobile/ebay/oauth", expectedURL: callbackURL)
        )
    }

    func testPublishClientSendsOneExplicitConfirmationAndMapsCanonicalProviderTruth() async throws {
        let listingID = UUID(uuidString: "37700000-0000-4000-8000-000000000011")!
        let reviewRevision = UUID(uuidString: "37700000-0000-4000-8000-000000000012")!
        let idempotencyKey = UUID(uuidString: "37700000-0000-4000-8000-000000000013")!
        let session = makeSession { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(
                request.value(forHTTPHeaderField: "Authorization"),
                "Bearer account-token"
            )
            XCTAssertEqual(
                request.value(forHTTPHeaderField: "Idempotency-Key"),
                idempotencyKey.uuidString.lowercased()
            )
            let bodyData = try Self.bodyData(from: request)
            let body = try XCTUnwrap(
                JSONSerialization.jsonObject(with: bodyData)
                    as? [String: Any]
            )
            XCTAssertEqual(
                body["confirmation"] as? String,
                "publish_to_ebay"
            )
            XCTAssertEqual(
                body["expectedReviewRevision"] as? String,
                reviewRevision.uuidString.lowercased()
            )
            return Self.response(
                status: 200,
                json: """
                {
                  "data": {
                    "listingId": "\(listingID.uuidString.lowercased())",
                    "outcome": "published",
                    "ebayListingId": "110377000011",
                    "ebayOfferId": "offer-377",
                    "alreadyPublished": false,
                    "listingUrl": "https://www.sandbox.ebay.com/itm/110377000011",
                    "ebayEnvironment": "sandbox"
                  },
                  "meta": { "requestId": "req-377" }
                }
                """
            )
        }
        let client = EbayPublishAPIClient(
            baseURL: URL(string: "https://snaplist.dev")!,
            tokenProvider: EbayPublishTestBearer(),
            session: session
        )

        let result = try await client.publish(
            listingID: listingID,
            expectedReviewRevision: reviewRevision,
            idempotencyKey: idempotencyKey
        )

        XCTAssertEqual(
            result,
            .published(
                EbayPublishedListing(
                    ebayListingID: "110377000011",
                    listingURL: URL(
                        string: "https://www.sandbox.ebay.com/itm/110377000011"
                    )!
                )
            )
        )
    }

    func testPublishedListingURLPrefersProviderTruthThenMapsBothOfficialHosts() {
        let providerURL = URL(string: "https://www.ebay.com/itm/provider-truth")!

        XCTAssertEqual(
            EbayListingURL.resolve(
                providerURL: providerURL,
                listingID: "110377000011",
                environment: .sandbox
            ),
            providerURL
        )
        XCTAssertEqual(
            EbayListingURL.resolve(
                providerURL: nil,
                listingID: "110377000011",
                environment: .sandbox
            ),
            URL(string: "https://www.sandbox.ebay.com/itm/110377000011")
        )
        XCTAssertEqual(
            EbayListingURL.resolve(
                providerURL: nil,
                listingID: "110377000011",
                environment: .production
            ),
            URL(string: "https://www.ebay.com/itm/110377000011")
        )
    }

    func testPublishedListingURLNeverGuessesWithoutProviderURLOrEnvironment() {
        XCTAssertNil(
            EbayListingURL.resolve(
                providerURL: nil,
                listingID: "110377000011",
                environment: nil
            )
        )
    }

    func testPreflightCarriesTheServerEffectivePriceAndMappedListingTruth() async throws {
        let listingID = UUID(
            uuidString: "37700000-0000-4000-8000-000000000014"
        )!
        let revision = UUID(
            uuidString: "37700000-0000-4000-8000-000000000015"
        )!
        let session = makeSession { request in
            XCTAssertEqual(request.httpMethod, "GET")
            return Self.response(
                status: 200,
                json: """
                {
                  "data": {
                    "listingId": "\(listingID.uuidString.lowercased())",
                    "title": "Seller edited title",
                    "description": "Current server description.",
                    "effectivePrice": {
                      "amount": 58.25,
                      "label": "What will be listed"
                    },
                    "photoCount": 4,
                    "marketplace": "EBAY_US",
                    "ebayCondition": "USED_VERY_GOOD",
                    "itemSpecifics": { "Brand": ["Sony"] },
                    "reviewRevision": "\(revision.uuidString.lowercased())",
                    "connection": {
                      "connected": true,
                      "ebayUsername": "sandbox-seller"
                    },
                    "publishEligibility": {
                      "enabled": false,
                      "eligible": false
                    }
                  },
                  "meta": { "requestId": "req-377" }
                }
                """
            )
        }
        let client = EbayPublishAPIClient(
            baseURL: URL(string: "https://snaplist.dev")!,
            tokenProvider: EbayPublishTestBearer(),
            session: session
        )

        let preflight = try await client.preflight(listingID: listingID)

        XCTAssertEqual(preflight.effectivePrice.amount, Decimal(string: "58.25"))
        XCTAssertEqual(preflight.effectivePrice.label, "What will be listed")
        XCTAssertEqual(preflight.title, "Seller edited title")
        XCTAssertEqual(preflight.description, "Current server description.")
        XCTAssertEqual(preflight.photoCount, 4)
        XCTAssertEqual(preflight.marketplace, "EBAY_US")
        XCTAssertEqual(preflight.ebayCondition, "USED_VERY_GOOD")
        XCTAssertEqual(preflight.itemSpecifics, ["Brand": ["Sony"]])
        XCTAssertEqual(preflight.reviewRevision, revision)
    }

    func testPublishClientMapsRevisionConflictWithoutRetryingTheMutation() async throws {
        let session = makeSession { _ in
            Self.response(
                status: 409,
                json: """
                {
                  "error": {
                    "code": "conflict",
                    "message": "Conflict.",
                    "requestId": "req-377",
                    "details": { "reason": "ebay_review_revision_changed" }
                  }
                }
                """
            )
        }
        let client = EbayPublishAPIClient(
            baseURL: URL(string: "https://snaplist.dev")!,
            tokenProvider: EbayPublishTestBearer(),
            session: session
        )

        let result = try await client.publish(
            listingID: UUID(),
            expectedReviewRevision: UUID(),
            idempotencyKey: UUID()
        )

        XCTAssertEqual(result, .staleRevision)
    }

    func testPublishClientKeepsChangedProviderAuthorityDistinctFromStaleContent() async throws {
        let session = makeSession { _ in
            Self.response(
                status: 409,
                json: """
                {
                  "error": {
                    "code": "conflict",
                    "message": "Conflict.",
                    "requestId": "req-377",
                    "details": { "reason": "ebay_published_authority_changed" }
                  }
                }
                """
            )
        }
        let client = EbayPublishAPIClient(
            baseURL: URL(string: "https://snaplist.dev")!,
            tokenProvider: EbayPublishTestBearer(),
            session: session
        )

        let result = try await client.publish(
            listingID: UUID(),
            expectedReviewRevision: UUID(),
            idempotencyKey: UUID()
        )

        XCTAssertEqual(result, .providerAuthorityChanged)
    }

    func testStaleRevisionReloadsCurrentPreflightAndRequiresFreshConfirmation() async {
        let original = Self.preflight(
            title: "Original title",
            description: "Original description.",
            revision: UUID(uuidString: "37700000-0000-4000-8000-000000000021")!
        )
        let current = Self.preflight(
            title: "Current title",
            description: "Current description.",
            revision: UUID(uuidString: "37700000-0000-4000-8000-000000000022")!
        )
        let service = StaleRevisionEbayPublishService(
            preflights: [original, current]
        )
        let store = EbayPublishFlowStore(
            listingID: original.listingID,
            service: service,
            oauth: EbayOAuthFixtureRunner(result: .connected),
            attemptStore: MemoryEbayPublishAttemptStore()
        )

        await store.load()
        await store.confirmPublish()

        let publishCount = await service.publishCount
        XCTAssertEqual(store.screen, .confirmation(.listingChanged))
        XCTAssertEqual(store.preflight?.title, "Current title")
        XCTAssertEqual(store.preflight?.description, "Current description.")
        XCTAssertEqual(publishCount, 1)
    }

    func testFailedStaleRevisionRefreshClearsStaleDetailsAndBlocksPost() async {
        let stale = Self.preflight(
            title: "Stale title",
            description: "Stale description.",
            revision: UUID(uuidString: "37700000-0000-4000-8000-000000000026")!
        )
        let service = StaleRevisionEbayPublishService(
            preflights: [stale],
            failAfterPreflights: 1
        )
        let store = EbayPublishFlowStore(
            listingID: stale.listingID,
            service: service,
            oauth: EbayOAuthFixtureRunner(result: .connected),
            attemptStore: MemoryEbayPublishAttemptStore()
        )

        await store.load()
        await store.confirmPublish()

        XCTAssertEqual(store.screen, .confirmation(.refreshFailed))
        XCTAssertNil(store.preflight)

        await store.confirmPublish()

        let publishCount = await service.publishCount
        XCTAssertEqual(publishCount, 1)
        XCTAssertEqual(store.screen, .confirmation(.refreshFailed))
    }

    func testDeclinedConnectionKeepsDraftAndStartsADistinctHostedSessionOnRetry() async {
        let preflight = Self.preflight(
            title: "Saved listing",
            revision: UUID(uuidString: "37700000-0000-4000-8000-000000000023")!
        )
        let service = StaleRevisionEbayPublishService(preflights: [preflight])
        let store = EbayPublishFlowStore(
            listingID: preflight.listingID,
            service: service,
            oauth: EbayOAuthFixtureRunner(result: .declined),
            attemptStore: MemoryEbayPublishAttemptStore()
        )

        await store.connect()
        XCTAssertEqual(store.screen, .connection(.declined))
        await store.connect()

        let keys = await service.oauthIdempotencyKeys
        let publishCount = await service.publishCount
        XCTAssertEqual(keys.count, 2)
        XCTAssertNotEqual(keys.first, keys.last)
        XCTAssertEqual(store.screen, .connection(.declined))
        XCTAssertEqual(publishCount, 0)
    }

    func testDuplicateConfirmationAfterPublishedTruthDoesNotMutateAgain() async {
        let service = CanonicalEbayPublishService()
        let delivery = EbayPublishStore(
            listingID: UUID(),
            expectedReviewRevision: UUID(),
            service: service,
            attemptStore: MemoryEbayPublishAttemptStore()
        )

        await delivery.confirmPublish()
        await delivery.confirmPublish()

        let mutationCount = await service.mutationCount
        XCTAssertEqual(delivery.phase, .published)
        XCTAssertEqual(mutationCount, 1)
    }

    func testFailedPublishKeepsDraftAndRetriesTheSameDurableAttempt() async {
        let preflight = Self.preflight(
            title: "Saved seller draft",
            revision: UUID(uuidString: "37700000-0000-4000-8000-000000000024")!
        )
        let service = FailureThenPublishedEbayService(preflight: preflight)
        let store = EbayPublishFlowStore(
            listingID: preflight.listingID,
            service: service,
            oauth: EbayOAuthFixtureRunner(result: .connected),
            attemptStore: MemoryEbayPublishAttemptStore()
        )

        await store.load()
        let publishCountBeforeConfirmation = await service.publishCount
        XCTAssertEqual(publishCountBeforeConfirmation, 0)
        XCTAssertEqual(store.preflight?.title, "Saved seller draft")

        await store.confirmPublish()
        let listingIDAfterFailure = store.listingID
        let titleAfterFailure = store.preflight?.title

        XCTAssertEqual(store.screen, .result(.unavailable))
        XCTAssertEqual(listingIDAfterFailure, preflight.listingID)
        XCTAssertEqual(titleAfterFailure, "Saved seller draft")

        await store.retryPublish()

        let keys = await service.idempotencyKeys
        XCTAssertEqual(store.screen, .result(.published))
        XCTAssertEqual(keys.count, 2)
        XCTAssertEqual(keys.first, keys.last)
    }

    func testDurableFailedPublishRelaunchReloadsPreflightAndRetriesSameAttempt()
        async throws {
        let preflight = Self.preflight(
            title: "Relaunched seller draft",
            revision: UUID(uuidString: "37700000-0000-4000-8000-000000000025")!
        )
        let root = FileManager.default.temporaryDirectory.appending(
            path: "ebay-publish-failed-relaunch-\(UUID().uuidString)",
            directoryHint: .isDirectory
        )
        let attemptURL = root.appending(path: "attempts.json")
        addTeardownBlock {
            try? FileManager.default.removeItem(at: root)
        }
        let service = FailureThenPublishedEbayService(preflight: preflight)
        let firstFlow = EbayPublishFlowStore(
            listingID: preflight.listingID,
            service: service,
            oauth: EbayOAuthFixtureRunner(result: .connected),
            attemptStore: FileEbayPublishAttemptStore(fileURL: attemptURL)
        )

        await firstFlow.load()
        await firstFlow.confirmPublish()
        XCTAssertEqual(firstFlow.screen, .result(.unavailable))

        let relaunchedFlow = EbayPublishFlowStore(
            listingID: preflight.listingID,
            service: service,
            oauth: EbayOAuthFixtureRunner(result: .connected),
            attemptStore: FileEbayPublishAttemptStore(fileURL: attemptURL)
        )
        await relaunchedFlow.load()

        XCTAssertEqual(relaunchedFlow.screen, .result(.unavailable))
        XCTAssertEqual(relaunchedFlow.preflight?.title, "Relaunched seller draft")

        await relaunchedFlow.retryPublish()

        let keys = await service.idempotencyKeys
        XCTAssertEqual(relaunchedFlow.screen, .result(.published))
        XCTAssertEqual(keys.count, 2)
        XCTAssertEqual(keys.first, keys.last)
    }

    func testDurableFailedPublishRelaunchRequiresConfirmationForNewRevision()
        async throws {
        let original = Self.preflight(
            title: "Failed original draft",
            revision: UUID(uuidString: "37700000-0000-4000-8000-000000000026")!
        )
        let current = Self.preflight(
            title: "Current revised draft",
            revision: UUID(uuidString: "37700000-0000-4000-8000-000000000027")!
        )
        let root = FileManager.default.temporaryDirectory.appending(
            path: "ebay-publish-failed-revised-\(UUID().uuidString)",
            directoryHint: .isDirectory
        )
        let attemptURL = root.appending(path: "attempts.json")
        addTeardownBlock {
            try? FileManager.default.removeItem(at: root)
        }
        let service = FailureThenPublishedEbayService(
            preflights: [original, current]
        )
        let firstFlow = EbayPublishFlowStore(
            listingID: original.listingID,
            service: service,
            oauth: EbayOAuthFixtureRunner(result: .connected),
            attemptStore: FileEbayPublishAttemptStore(fileURL: attemptURL)
        )

        await firstFlow.load()
        await firstFlow.confirmPublish()
        XCTAssertEqual(firstFlow.screen, .result(.unavailable))

        let relaunchedFlow = EbayPublishFlowStore(
            listingID: original.listingID,
            service: service,
            oauth: EbayOAuthFixtureRunner(result: .connected),
            attemptStore: FileEbayPublishAttemptStore(fileURL: attemptURL)
        )
        await relaunchedFlow.load()

        XCTAssertEqual(relaunchedFlow.preflight?.title, "Current revised draft")
        XCTAssertEqual(relaunchedFlow.screen, .confirmation(.listingChanged))

        await relaunchedFlow.retryPublish()
        let keysBeforeConfirmation = await service.idempotencyKeys
        XCTAssertEqual(keysBeforeConfirmation.count, 1)

        await relaunchedFlow.confirmPublish()

        let keys = await service.idempotencyKeys
        XCTAssertEqual(relaunchedFlow.screen, .result(.published))
        XCTAssertEqual(keys.count, 2)
        XCTAssertNotEqual(keys.first, keys.last)
    }

    private func makeSession(
        handler: @escaping @Sendable (URLRequest) throws -> (HTTPURLResponse, Data)
    ) -> URLSession {
        EbayPublishURLProtocolStub.handler = handler
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [EbayPublishURLProtocolStub.self]
        return URLSession(configuration: configuration)
    }

    nonisolated private static func response(
        status: Int,
        json: String
    ) -> (HTTPURLResponse, Data) {
        (
            HTTPURLResponse(
                url: URL(string: "https://snaplist.dev")!,
                statusCode: status,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!,
            Data(json.utf8)
        )
    }

    nonisolated private static func bodyData(
        from request: URLRequest
    ) throws -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else {
            throw URLError(.cannotDecodeContentData)
        }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1_024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count < 0 {
                throw stream.streamError ?? URLError(.cannotDecodeContentData)
            }
            if count == 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }

    private static func preflight(
        title: String,
        description: String = "The server-mapped description.",
        revision: UUID
    ) -> EbayPublishPreflight {
        EbayPublishPreflight(
            listingID: UUID(uuidString: "37700000-0000-4000-8000-000000000020")!,
            title: title,
            description: description,
            effectivePrice: .init(amount: 58, label: "What will be listed"),
            photoCount: 3,
            marketplace: "EBAY_US",
            ebayCondition: "USED_VERY_GOOD",
            itemSpecifics: ["Brand": ["Sony"]],
            reviewRevision: revision,
            connection: .init(connected: true, ebayUsername: "sandbox-seller"),
            publishEligibility: .init(enabled: false, eligible: false)
        )
    }
}

private struct EbayPublishTestBearer: BearerTokenProviding {
    func bearerToken() async throws -> String { "account-token" }
}

private final class EbayPublishURLProtocolStub: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler:
        (@Sendable (URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }
}

private actor AmbiguousThenReplayEbayPublishService: EbayPublishFeatureServing {
    private let preflightValue: EbayPublishPreflight
    private(set) var mutationCount = 0
    private(set) var idempotencyKeys: [UUID] = []
    private var receipts: [UUID: EbayPublishedListing] = [:]
    private var statusOutcome: EbayPublishStatus.Outcome = .notPublished

    let canonicalListing = EbayPublishedListing(
        ebayListingID: "110377000001",
        listingURL: URL(string: "https://www.sandbox.ebay.com/itm/110377000001")!
    )

    init(preflight: EbayPublishPreflight) {
        preflightValue = preflight
    }

    var providerTruth: (
        mutationCount: Int,
        idempotencyKeys: [UUID],
        canonicalListing: EbayPublishedListing
    ) {
        (mutationCount, idempotencyKeys, canonicalListing)
    }

    func createOAuthSession(idempotencyKey: UUID) async throws -> EbayOAuthSession {
        EbayOAuthSession(
            sessionID: UUID(),
            authorizationURL: URL(string: "https://auth.sandbox.ebay.com")!,
            expiresAt: Date().addingTimeInterval(300)
        )
    }

    func connection() async throws -> EbayConnectionStatus {
        preflightValue.connection
    }

    func disconnect() async throws -> EbayConnectionStatus {
        .init(connected: false, ebayUsername: nil)
    }

    func preflight(listingID: UUID) async throws -> EbayPublishPreflight {
        preflightValue
    }

    func status(listingID: UUID) async throws -> EbayPublishStatus {
        EbayPublishStatus(
            listingID: listingID,
            outcome: statusOutcome,
            ebayListingID: statusOutcome == .published
                ? canonicalListing.ebayListingID
                : nil,
            ebayOfferID: statusOutcome == .published ? "offer-377" : nil,
            alreadyPublished: statusOutcome == .published
        )
    }

    func publish(
        listingID: UUID,
        expectedReviewRevision: UUID,
        idempotencyKey: UUID
    ) async throws -> EbayPublishTransportOutcome {
        idempotencyKeys.append(idempotencyKey)
        if let receipt = receipts[idempotencyKey] {
            statusOutcome = .published
            return .published(receipt)
        }

        mutationCount += 1
        receipts[idempotencyKey] = canonicalListing
        statusOutcome = .outcomeNotYetKnown
        return .outcomeNotYetKnown
    }
}

private struct EbayOAuthFixtureRunner: EbayOAuthRunning {
    let result: EbayOAuthResult

    func authenticate(_ session: EbayOAuthSession) async -> EbayOAuthResult {
        result
    }

    func cancel() {}
}

private actor StaleRevisionEbayPublishService: EbayPublishFeatureServing {
    private var preflights: [EbayPublishPreflight]
    private let failAfterPreflights: Int?
    private var preflightCount = 0
    private(set) var publishCount = 0
    private(set) var oauthIdempotencyKeys: [UUID] = []

    init(
        preflights: [EbayPublishPreflight],
        failAfterPreflights: Int? = nil
    ) {
        self.preflights = preflights
        self.failAfterPreflights = failAfterPreflights
    }

    func createOAuthSession(idempotencyKey: UUID) async throws -> EbayOAuthSession {
        oauthIdempotencyKeys.append(idempotencyKey)
        return EbayOAuthSession(
            sessionID: UUID(),
            authorizationURL: URL(string: "https://signin.ebay.com")!,
            expiresAt: Date().addingTimeInterval(300)
        )
    }

    func connection() async throws -> EbayConnectionStatus {
        preflights.last!.connection
    }

    func disconnect() async throws -> EbayConnectionStatus {
        .init(connected: false, ebayUsername: nil)
    }

    func preflight(listingID: UUID) async throws -> EbayPublishPreflight {
        if let failAfterPreflights,
           preflightCount >= failAfterPreflights {
            throw URLError(.cannotLoadFromNetwork)
        }
        preflightCount += 1
        if preflights.count > 1 { return preflights.removeFirst() }
        return preflights[0]
    }

    func status(listingID: UUID) async throws -> EbayPublishStatus {
        EbayPublishStatus(
            listingID: listingID,
            outcome: .notPublished,
            ebayListingID: nil,
            ebayOfferID: nil,
            alreadyPublished: false
        )
    }

    func publish(
        listingID: UUID,
        expectedReviewRevision: UUID,
        idempotencyKey: UUID
    ) async throws -> EbayPublishTransportOutcome {
        publishCount += 1
        return .staleRevision
    }
}

private actor CanonicalEbayPublishService: EbayPublishServing {
    private(set) var mutationCount = 0

    func publish(
        listingID: UUID,
        expectedReviewRevision: UUID,
        idempotencyKey: UUID
    ) async throws -> EbayPublishTransportOutcome {
        mutationCount += 1
        return .published(
            EbayPublishedListing(
                ebayListingID: "110377000099",
                listingURL: URL(
                    string: "https://www.ebay.com/itm/110377000099"
                )!
            )
        )
    }
}

private actor FailureThenPublishedEbayService: EbayPublishFeatureServing {
    private let preflightValues: [EbayPublishPreflight]
    private var preflightCount = 0
    private(set) var idempotencyKeys: [UUID] = []

    init(preflight: EbayPublishPreflight) {
        preflightValues = [preflight]
    }

    init(preflights: [EbayPublishPreflight]) {
        preflightValues = preflights
    }

    var publishCount: Int { idempotencyKeys.count }

    func createOAuthSession(idempotencyKey: UUID) async throws -> EbayOAuthSession {
        EbayOAuthSession(
            sessionID: UUID(),
            authorizationURL: URL(string: "https://signin.ebay.com")!,
            expiresAt: Date().addingTimeInterval(300)
        )
    }

    func connection() async throws -> EbayConnectionStatus {
        preflightValues[0].connection
    }

    func disconnect() async throws -> EbayConnectionStatus {
        .init(connected: false, ebayUsername: nil)
    }

    func preflight(listingID: UUID) async throws -> EbayPublishPreflight {
        let index = min(preflightCount, preflightValues.count - 1)
        preflightCount += 1
        return preflightValues[index]
    }

    func status(listingID: UUID) async throws -> EbayPublishStatus {
        EbayPublishStatus(
            listingID: listingID,
            outcome: idempotencyKeys.count == 1 ? .failed : .notPublished,
            ebayListingID: nil,
            ebayOfferID: nil,
            alreadyPublished: false
        )
    }

    func publish(
        listingID: UUID,
        expectedReviewRevision: UUID,
        idempotencyKey: UUID
    ) async throws -> EbayPublishTransportOutcome {
        idempotencyKeys.append(idempotencyKey)
        if idempotencyKeys.count == 1 { return .failed }
        return .published(
            EbayPublishedListing(
                ebayListingID: "110377000024",
                listingURL: URL(
                    string: "https://www.ebay.com/itm/110377000024"
                )!
            )
        )
    }
}
