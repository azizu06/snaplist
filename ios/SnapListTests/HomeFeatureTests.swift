import Foundation
import SwiftUI
import UIKit
import XCTest
@testable import SnapList

@MainActor
final class HomeFeatureTests: XCTestCase {
    func testTypedHomeModelDrivesTruthfulSearchAndLifecycleFilters() {
        let activeCamera = HomeListing(
            id: UUID(uuidString: "20800000-0000-0000-0000-000000000001")!,
            title: "Canon AE-1 film camera",
            lifecycle: .active,
            statusLabel: "Live",
            detail: "eBay · Listed 2d ago",
            price: "$210"
        )
        let draftCamera = HomeListing(
            id: UUID(uuidString: "20800000-0000-0000-0000-000000000002")!,
            title: "Polaroid instant camera",
            lifecycle: .draft,
            statusLabel: "Draft",
            detail: "Draft · No price yet",
            price: nil
        )
        let headphones = HomeListing(
            id: UUID(uuidString: "20800000-0000-0000-0000-000000000003")!,
            title: "Sony WH-1000XM4 headphones",
            lifecycle: .needsAttention,
            statusLabel: "Needs attention",
            detail: "eBay · Ship by tomorrow",
            price: "$188"
        )
        let model = HomeModel(
            revision: 7,
            unreadNotificationCount: 3,
            summary: HomeSummary(active: 2, drafts: 1, orders: 1),
            attention: [],
            currentRun: nil,
            readyToFinish: [],
            listings: [activeCamera, draftCamera, headphones]
        )

        XCTAssertEqual(
            model.listings(matching: "camera", filter: .all).map(\.id),
            [activeCamera.id, draftCamera.id]
        )
        XCTAssertEqual(
            model.listings(matching: "camera", filter: .active).map(\.id),
            [activeCamera.id]
        )
        XCTAssertEqual(
            model.listings(matching: "", filter: .needsAttention).map(\.id),
            [headphones.id]
        )
        XCTAssertEqual(activeCamera.route, .listing(activeCamera.id))
    }

    func testStoreReconnectsWithBoundedBackoffAfterRealtimeFailures() async {
        let initial = makeModel(revision: 1, unreadCount: 1)
        let firstRefresh = makeModel(revision: 2, unreadCount: 2)
        let secondRefresh = makeModel(revision: 3, unreadCount: 3)
        let thirdRefresh = makeModel(revision: 4, unreadCount: 4)
        let recoveredRealtime = makeModel(revision: 5, unreadCount: 5)
        let repository = TestHomeRepository(
            fetchResults: [
                .success(initial),
                .success(firstRefresh),
                .success(secondRefresh),
                .success(thirdRefresh)
            ],
            updateStreamCount: 5
        )
        let sleeper = RecordingHomeReconnectSleeper()
        let store = HomeStore(
            repository: repository,
            reconnectPolicy: HomeRealtimeReconnectPolicy(
                initialDelayNanoseconds: 2,
                maximumDelayNanoseconds: 4
            ),
            sleep: { delay in await sleeper.record(delay) }
        )

        await store.load()
        XCTAssertEqual(store.model?.revision, 1)

        await repository.finish(stream: 0, throwing: TestHomeRepositoryError.realtimeUnavailable)
        await waitUntil { await repository.currentSubscriptionCount() == 2 }
        XCTAssertEqual(store.model?.revision, 2)

        await repository.finish(stream: 1, throwing: TestHomeRepositoryError.realtimeUnavailable)
        await waitUntil { await repository.currentSubscriptionCount() == 3 }
        XCTAssertEqual(store.model?.revision, 3)

        await repository.finish(stream: 2, throwing: TestHomeRepositoryError.realtimeUnavailable)
        await waitUntil { await repository.currentSubscriptionCount() == 4 }
        XCTAssertEqual(store.model?.revision, 4)
        let recordedDelays = await sleeper.recordedDelays()
        XCTAssertEqual(recordedDelays, [2, 4, 4])

        await repository.yield(recoveredRealtime, to: 3)
        await waitUntil { store.model?.revision == 5 }
        XCTAssertEqual(store.freshness, .realtime)

        store.suspendUpdates()
        let suspendedSubscriptionCount = await repository.currentSubscriptionCount()
        await Task.yield()
        let subscriptionCountAfterSuspension = await repository.currentSubscriptionCount()
        XCTAssertEqual(subscriptionCountAfterSuspension, suspendedSubscriptionCount)

        store.resumeUpdates()
        await waitUntil {
            await repository.currentSubscriptionCount() == suspendedSubscriptionCount + 1
        }
    }

    func testUnavailableProductionSeamNeverPretendsFixturesAreLiveData() async {
        let store = HomeStore(repository: UnavailableHomeRepository())

        await store.load()

        XCTAssertNil(store.model)
        XCTAssertEqual(store.loadState, .failed(.operationUnavailable))
        XCTAssertEqual(store.freshness, .unavailable)
    }

    func testStandardSnapListAppCompositionReachesAuthenticatedHomeRoute() async throws {
        let session = makeHomeURLSession { request in
            XCTAssertEqual(request.url?.path, "/v1/home")
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer signed-jwt")
            return (
                HTTPURLResponse(
                    url: try XCTUnwrap(request.url),
                    statusCode: 200,
                    httpVersion: nil,
                    headerFields: ["Content-Type": "application/json"]
                )!,
                Data(Self.releaseHomeEnvelope.utf8)
            )
        }
        let app = SnapListApp(
            configuration: .standard,
            tokenProvider: ClerkBearerTokenProvider(
                session: TestClerkSessionToken(token: "signed-jwt")
            ),
            apiOrigin: URL(string: "http://127.0.0.1:3001")!,
            urlSession: session
        )

        await app.homeStore.load()
        app.homeStore.stopUpdates()

        XCTAssertEqual(app.homeStore.loadState, .loaded)
        XCTAssertEqual(app.homeStore.model?.revision, 41)
        XCTAssertEqual(app.homeStore.model?.listings.first?.title, "Canon AE-1 film camera")
    }

    func testAbsentClerkSessionPreservesTheSignedOutHomeState() async {
        let session = makeHomeURLSession { _ in
            XCTFail("An absent Clerk session must stop before Home transport.")
            throw HomeRepositoryError.operationUnavailable
        }
        let app = SnapListApp(
            configuration: .standard,
            tokenProvider: ClerkBearerTokenProvider(
                session: TestClerkSessionToken(token: nil)
            ),
            apiOrigin: URL(string: "http://127.0.0.1:3001")!,
            urlSession: session
        )

        await app.homeStore.load()

        XCTAssertNil(app.homeStore.model)
        XCTAssertEqual(app.homeStore.loadState, .failed(.operationUnavailable))
        XCTAssertEqual(app.homeStore.freshness, .unavailable)
    }

    func testAuthenticatedHomeDecodesActionableBuyerConversationDestination() async throws {
        let conversationID = UUID(
            uuidString: "29600000-0000-4000-8000-000000000063"
        )!
        let session = makeHomeURLSession { request in
            (
                HTTPURLResponse(
                    url: try XCTUnwrap(request.url),
                    statusCode: 200,
                    httpVersion: nil,
                    headerFields: ["Content-Type": "application/json"]
                )!,
                Data(#"""
                {
                  "data": {
                    "revision": 63,
                    "sellerState": "active",
                    "unreadNotificationCount": 1,
                    "summary": { "active": 1, "drafts": 0, "orders": null },
                    "attention": [],
                    "currentRun": null,
                    "readyToFinish": [],
                    "listings": [{
                      "id": "29600000-0000-4000-8000-000000000063",
                      "title": "Keychron K4 Mechanical Keyboard",
                      "lifecycle": "needsAttention",
                      "statusLabel": "Buyer question",
                      "detail": "eBay · “Does it work on Mac?”",
                      "price": "$96",
                      "destination": {
                        "kind": "conversation",
                        "id": "29600000-0000-4000-8000-000000000063"
                      }
                    }],
                    "recentSearches": []
                  },
                  "meta": { "requestId": "req_home_buyer" }
                }
                """#.utf8)
            )
        }
        let app = SnapListApp(
            configuration: .standard,
            tokenProvider: ClerkBearerTokenProvider(
                session: TestClerkSessionToken(token: "signed-jwt")
            ),
            apiOrigin: URL(string: "http://127.0.0.1:3001")!,
            urlSession: session
        )

        await app.homeStore.load()
        app.homeStore.stopUpdates()

        let result = try XCTUnwrap(app.homeStore.model?.listings.first)
        XCTAssertEqual(result.lifecycle, .needsAttention)
        XCTAssertEqual(result.route, .conversation(conversationID))
        XCTAssertEqual(
            app.homeStore.model?.listings(matching: "keychron", filter: .needsAttention),
            [result]
        )
    }

    func testAuthenticatedHomeKeepsResolvedBuyerConversationInAllOnly() async throws {
        let conversationID = UUID(
            uuidString: "29600000-0000-4000-8000-000000000064"
        )!
        let session = makeHomeURLSession { request in
            (
                HTTPURLResponse(
                    url: try XCTUnwrap(request.url),
                    statusCode: 200,
                    httpVersion: nil,
                    headerFields: ["Content-Type": "application/json"]
                )!,
                Data(#"""
                {
                  "data": {
                    "revision": 64,
                    "sellerState": "active",
                    "unreadNotificationCount": 0,
                    "summary": { "active": 1, "drafts": 0, "orders": null },
                    "attention": [],
                    "currentRun": null,
                    "readyToFinish": [],
                    "listings": [{
                      "id": "29600000-0000-4000-8000-000000000064",
                      "title": "Keychron K4 Mechanical Keyboard",
                      "lifecycle": "resolvedConversation",
                      "statusLabel": "Replied",
                      "detail": "eBay · You replied 1h ago",
                      "price": "$96",
                      "destination": {
                        "kind": "conversation",
                        "id": "29600000-0000-4000-8000-000000000064"
                      }
                    }],
                    "recentSearches": []
                  },
                  "meta": { "requestId": "req_home_resolved_buyer" }
                }
                """#.utf8)
            )
        }
        let app = SnapListApp(
            configuration: .standard,
            tokenProvider: ClerkBearerTokenProvider(
                session: TestClerkSessionToken(token: "signed-jwt")
            ),
            apiOrigin: URL(string: "http://127.0.0.1:3001")!,
            urlSession: session
        )

        await app.homeStore.load()
        app.homeStore.stopUpdates()

        let result = try XCTUnwrap(app.homeStore.model?.listings.first)
        XCTAssertEqual(result.lifecycle, .resolvedConversation)
        XCTAssertEqual(result.route, .conversation(conversationID))
        XCTAssertEqual(app.homeStore.model?.listings(matching: "keychron", filter: .all), [result])
        XCTAssertEqual(
            app.homeStore.model?.listings(matching: "keychron", filter: .needsAttention),
            []
        )
    }

    func testAuthenticatedHomeRejectsListingWithoutRequiredNullableDestination() async {
        let payload = Self.releaseHomeEnvelope.replacingOccurrences(
            of: ",\n        \"destination\": null",
            with: ""
        )
        XCTAssertFalse(payload.contains("\"destination\""))
        let session = makeHomeURLSession { request in
            (
                HTTPURLResponse(
                    url: request.url!,
                    statusCode: 200,
                    httpVersion: nil,
                    headerFields: ["Content-Type": "application/json"]
                )!,
                Data(payload.utf8)
            )
        }
        let app = SnapListApp(
            configuration: .standard,
            tokenProvider: ClerkBearerTokenProvider(
                session: TestClerkSessionToken(token: "signed-jwt")
            ),
            apiOrigin: URL(string: "http://127.0.0.1:3001")!,
            urlSession: session
        )

        await app.homeStore.load()
        app.homeStore.stopUpdates()

        XCTAssertNil(app.homeStore.model)
        XCTAssertEqual(app.homeStore.loadState, .failed(.temporarilyUnavailable))
    }

    func testStandardSnapListAppCompositionKeepsServerFailureHonest() async {
        let session = makeHomeURLSession { request in
            (
                HTTPURLResponse(
                    url: request.url!,
                    statusCode: 503,
                    httpVersion: nil,
                    headerFields: ["Content-Type": "application/json"]
                )!,
                Data(#"{"error":{"code":"internal_error","message":"Home is temporarily unavailable.","requestId":"req_home"}}"#.utf8)
            )
        }
        let app = SnapListApp(
            configuration: .standard,
            tokenProvider: ClerkBearerTokenProvider(
                session: TestClerkSessionToken(token: "signed-jwt")
            ),
            apiOrigin: URL(string: "http://127.0.0.1:3001")!,
            urlSession: session
        )

        await app.homeStore.load()

        XCTAssertNil(app.homeStore.model)
        XCTAssertEqual(app.homeStore.loadState, .failed(.temporarilyUnavailable))
        XCTAssertEqual(app.homeStore.freshness, .serverRefresh)
    }

    func testReleaseAPIOriginUsesHTTPSInfoValueAndFailsClosedWithoutOne() {
        XCTAssertNil(
            HomeRepositoryFactory.resolveAPIOrigin(
                environment: [:],
                bundleValue: nil,
                allowsLocalDevelopment: false
            )
        )
        XCTAssertNil(
            HomeRepositoryFactory.resolveAPIOrigin(
                environment: ["SNAPLIST_API_ORIGIN": "http://127.0.0.1:3001"],
                bundleValue: nil,
                allowsLocalDevelopment: false
            )
        )
        XCTAssertEqual(
            HomeRepositoryFactory.resolveAPIOrigin(
                environment: [:],
                bundleValue: "https://api.snaplist.example",
                allowsLocalDevelopment: false
            ),
            URL(string: "https://api.snaplist.example")
        )
    }

    func testLocalhostAPIOriginRequiresExplicitLocalDevelopmentConfiguration() {
        XCTAssertNil(
            HomeRepositoryFactory.resolveAPIOrigin(
                environment: [:],
                bundleValue: nil,
                allowsLocalDevelopment: true
            )
        )
        XCTAssertEqual(
            HomeRepositoryFactory.resolveAPIOrigin(
                environment: ["SNAPLIST_API_ORIGIN": "http://127.0.0.1:3001"],
                bundleValue: nil,
                allowsLocalDevelopment: true
            ),
            URL(string: "http://127.0.0.1:3001")
        )
        XCTAssertNil(
            HomeRepositoryFactory.resolveAPIOrigin(
                environment: ["SNAPLIST_API_ORIGIN": "http://api.snaplist.example"],
                bundleValue: nil,
                allowsLocalDevelopment: true
            )
        )
    }

    func testStandardCompositionFailsClosedBeforeTransportWithoutConfiguredOrigin() async {
        let session = makeHomeURLSession { _ in
            XCTFail("A missing Release API origin must not attempt transport.")
            throw HomeRepositoryError.operationUnavailable
        }
        let app = SnapListApp(
            configuration: .standard,
            tokenProvider: ClerkBearerTokenProvider(
                session: TestClerkSessionToken(token: "signed-jwt")
            ),
            apiOrigin: nil,
            urlSession: session
        )

        await app.homeStore.load()

        XCTAssertNil(app.homeStore.model)
        XCTAssertEqual(app.homeStore.loadState, .failed(.operationUnavailable))
    }

    func testHomeActionsRouteToTypedFutureDestinations() {
        let runID = UUID(uuidString: "20800000-0000-0000-0000-000000000010")!
        let orderID = UUID(uuidString: "20800000-0000-0000-0000-000000000011")!
        let conversationID = UUID(uuidString: "20800000-0000-0000-0000-000000000012")!
        let issueID = UUID(uuidString: "20800000-0000-0000-0000-000000000013")!

        XCTAssertEqual(AppRoute.home(.run(runID)), .home(.run(runID)))
        XCTAssertEqual(HomeAttentionDestination.order(orderID).route, .order(orderID))
        XCTAssertEqual(
            HomeAttentionDestination.conversation(conversationID).route,
            .conversation(conversationID)
        )
        XCTAssertEqual(
            HomeAttentionDestination.publishIssue(issueID).route,
            .publishIssue(issueID)
        )
    }

    private func makeModel(revision: Int, unreadCount: Int) -> HomeModel {
        HomeModel(
            revision: revision,
            unreadNotificationCount: unreadCount,
            summary: HomeSummary(active: 0, drafts: 0, orders: 0),
            attention: [],
            currentRun: nil,
            readyToFinish: [],
            listings: []
        )
    }

    private func waitUntil(
        _ predicate: @escaping @MainActor () async -> Bool,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        for _ in 0..<200 where !(await predicate()) {
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        let didSatisfyPredicate = await predicate()
        XCTAssertTrue(didSatisfyPredicate, file: file, line: line)
    }

    private func makeHomeURLSession(
        handler: @escaping @Sendable (URLRequest) throws -> (HTTPURLResponse, Data)
    ) -> URLSession {
        HomeURLProtocolStub.handler = handler
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [HomeURLProtocolStub.self]
        return URLSession(configuration: configuration)
    }

    private static let releaseHomeEnvelope = #"""
    {
      "data": {
        "revision": 41,
        "sellerState": "active",
        "unreadNotificationCount": 1,
        "summary": { "active": 1, "drafts": 0, "orders": 0 },
        "attention": [],
        "currentRun": null,
        "readyToFinish": [],
        "listings": [
          {
            "id": "20800000-0000-4000-8000-000000000040",
            "title": "Canon AE-1 film camera",
            "lifecycle": "active",
            "statusLabel": "Live",
            "detail": "eBay · Listed",
            "price": "$210",
            "destination": null
          }
        ],
        "recentSearches": []
      },
      "meta": { "requestId": "req_home_release" }
    }
    """#
}

private struct TestClerkSessionToken: ClerkSessionTokenProviding {
    let token: String?

    func sessionToken() async throws -> String? { token }
}

private final class HomeURLProtocolStub: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: HomeRepositoryError.operationUnavailable)
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

    override func stopLoading() {}
}

private enum TestHomeRepositoryError: Error {
    case realtimeUnavailable
}

private actor TestHomeRepository: HomeRepository {
    private var fetchResults: [Result<HomeModel, Error>]
    private let updateStreams: [AsyncThrowingStream<HomeModel, Error>]
    private let continuations: [AsyncThrowingStream<HomeModel, Error>.Continuation]
    private(set) var fetchCount = 0
    private(set) var subscriptionCount = 0

    init(fetchResults: [Result<HomeModel, Error>], updateStreamCount: Int = 1) {
        self.fetchResults = fetchResults
        let pairs = (0..<max(1, updateStreamCount)).map { _ in
            AsyncThrowingStream<HomeModel, Error>.makeStream()
        }
        updateStreams = pairs.map(\.stream)
        continuations = pairs.map(\.continuation)
    }

    func fetchHome() async throws -> HomeModel {
        fetchCount += 1
        guard !fetchResults.isEmpty else {
            throw TestHomeRepositoryError.realtimeUnavailable
        }
        return try fetchResults.removeFirst().get()
    }

    func updates() async -> AsyncThrowingStream<HomeModel, Error> {
        let index = min(subscriptionCount, updateStreams.count - 1)
        subscriptionCount += 1
        return updateStreams[index]
    }

    func yield(_ model: HomeModel, to stream: Int = 0) {
        continuations[stream].yield(model)
    }

    func finish(stream: Int = 0, throwing error: any Error) {
        continuations[stream].finish(throwing: error)
    }

    func currentFetchCount() -> Int {
        fetchCount
    }

    func currentSubscriptionCount() -> Int {
        subscriptionCount
    }
}

private actor RecordingHomeReconnectSleeper {
    private var delays: [UInt64] = []

    func record(_ delay: UInt64) {
        delays.append(delay)
    }

    func recordedDelays() -> [UInt64] {
        delays
    }
}

// MARK: - Trophy Wall domain convergence

@MainActor
final class TrophyWallDomainTests: XCTestCase {
    func testStoreConvergesOnlyExactPrincipalScopedLogicalIdentity() {
        let fixture = TrophyWallTestFixture()
        let cases = [
            TrophyWallConvergenceCase(
                name: "exact principal and logical identity",
                acceptedRun: TrophyWallCanonicalAcceptedRun(
                    principalScope: fixture.principal,
                    runID: fixture.runID,
                    linkedLogicalIdentity: fixture.logicalID,
                    lastMeaningfulUpdateAt: fixture.acceptedUpdate
                ),
                expectedCards: [
                    .accepted(
                        principalScope: fixture.principal,
                        runID: fixture.runID,
                        itemName: fixture.matchedItemName,
                        lastMeaningfulUpdateAt: fixture.acceptedUpdate
                    ),
                    .pending(
                        principalScope: fixture.principal,
                        logicalIdentity: fixture.unrelatedLogicalID,
                        itemName: fixture.unrelatedItemName,
                        lastMeaningfulUpdateAt: fixture.unrelatedUpdate
                    ),
                ]
            ),
            TrophyWallConvergenceCase(
                name: "wrong principal",
                acceptedRun: TrophyWallCanonicalAcceptedRun(
                    principalScope: fixture.otherPrincipal,
                    runID: fixture.runID,
                    linkedLogicalIdentity: fixture.logicalID,
                    lastMeaningfulUpdateAt: fixture.acceptedUpdate
                ),
                expectedCards: fixture.initialCards
            ),
            TrophyWallConvergenceCase(
                name: "missing logical link",
                acceptedRun: TrophyWallCanonicalAcceptedRun(
                    principalScope: fixture.principal,
                    runID: fixture.runID,
                    linkedLogicalIdentity: nil,
                    lastMeaningfulUpdateAt: fixture.acceptedUpdate
                ),
                expectedCards: [
                    .accepted(
                        principalScope: fixture.principal,
                        runID: fixture.runID,
                        lastMeaningfulUpdateAt: fixture.acceptedUpdate
                    ),
                    fixture.initialCards[0],
                    fixture.initialCards[1],
                ]
            ),
        ]

        for testCase in cases {
            let store = fixture.makeStore()

            store.ingest(testCase.acceptedRun)

            XCTAssertEqual(store.principalScope, fixture.principal, testCase.name)
            XCTAssertEqual(store.cards, testCase.expectedCards, testCase.name)
        }
    }

    func testStoreConvergesAcceptedHandoffOnlyWithExactPrincipalScopedRunDetail() throws {
        let fixture = TrophyWallTestFixture()
        let acceptedCard = TrophyWallCard.accepted(
            principalScope: fixture.principal,
            runID: fixture.runID,
            itemName: fixture.matchedItemName,
            lastMeaningfulUpdateAt: fixture.runDetailUpdate
        )
        let exactCards = [
            fixture.initialCards[1],
            acceptedCard,
        ]
        let cases = [
            TrophyWallRunDetailConvergenceCase(
                name: "exact principal, run, and item",
                principalScope: fixture.principal,
                runDetail: try fixture.decodedRunDetail(
                    runID: fixture.runID,
                    itemID: fixture.itemID
                ),
                expectedCards: exactCards,
                expectedDestinations: [nil, .run(fixture.runID)]
            ),
            TrophyWallRunDetailConvergenceCase(
                name: "wrong principal",
                principalScope: fixture.otherPrincipal,
                runDetail: try fixture.decodedRunDetail(
                    runID: fixture.runID,
                    itemID: fixture.itemID
                ),
                expectedCards: fixture.initialCards,
                expectedDestinations: [nil, nil]
            ),
            TrophyWallRunDetailConvergenceCase(
                name: "wrong run",
                principalScope: fixture.principal,
                runDetail: try fixture.decodedRunDetail(
                    runID: fixture.thirdRunID,
                    itemID: fixture.itemID
                ),
                expectedCards: fixture.initialCards,
                expectedDestinations: [nil, nil]
            ),
            TrophyWallRunDetailConvergenceCase(
                name: "wrong item",
                principalScope: fixture.principal,
                runDetail: try fixture.decodedRunDetail(
                    runID: fixture.runID,
                    itemID: fixture.otherItemID
                ),
                expectedCards: fixture.initialCards,
                expectedDestinations: [nil, nil]
            ),
        ]

        for testCase in cases {
            let store = fixture.makeStore()

            store.ingest(
                acceptedHandoff: fixture.acceptedHandoff,
                runDetail: testCase.runDetail,
                principalScope: testCase.principalScope
            )

            XCTAssertEqual(store.principalScope, fixture.principal, testCase.name)
            XCTAssertEqual(store.cards, testCase.expectedCards, testCase.name)
            XCTAssertEqual(store.cards.count, 2, testCase.name)
            XCTAssertEqual(
                store.processingRows.map(\.destination),
                testCase.expectedDestinations,
                testCase.name
            )
        }
    }

    func testStoreProjectsLaterCanonicalWorkingStageFromAcceptedHandoffRunDetail() throws {
        let fixture = TrophyWallTestFixture()
        let laterRunDetail = try fixture.decodedRunDetail(
            runID: fixture.runID,
            itemID: fixture.itemID,
            status: .running,
            stage: .pricing
        )
        let store = fixture.makeStore()

        for _ in 0..<2 {
            store.ingest(
                acceptedHandoff: fixture.acceptedHandoff,
                runDetail: laterRunDetail,
                principalScope: fixture.principal
            )
        }

        XCTAssertEqual(store.cards.count, 2)
        XCTAssertEqual(store.cards.first, fixture.initialCards[1])
        XCTAssertEqual(
            store.processingRows.map(\.id),
            [.local(fixture.unrelatedLogicalID), .run(fixture.runID)]
        )
        XCTAssertEqual(
            store.processingRows.map(\.itemName),
            [fixture.unrelatedItemName, fixture.matchedItemName]
        )
        XCTAssertEqual(
            store.processingRows.map(\.stateLabel),
            ["Pending upload", "Pricing"]
        )
        XCTAssertEqual(
            store.processingRows.map(\.accessibilityLabel),
            [
                "\(fixture.unrelatedItemName), pending upload. Local item, not sent yet.",
                "\(fixture.matchedItemName), working, pricing.",
            ]
        )
        XCTAssertEqual(
            store.processingRows.map(\.destination),
            [nil, .run(fixture.runID)]
        )
    }

    func testStoreProjectsRemainingCanonicalWorkingStagesFromAcceptedHandoffRunDetail() throws {
        let fixture = TrophyWallTestFixture()
        let cases = fixture.workingStageCases.filter { $0.stage != .pricing }

        for testCase in cases {
            let store = fixture.makeStore()
            let laterRunDetail = try fixture.decodedRunDetail(
                runID: fixture.runID,
                itemID: fixture.itemID,
                status: .running,
                stage: testCase.stage
            )

            for _ in 0..<2 {
                store.ingest(
                    acceptedHandoff: fixture.acceptedHandoff,
                    runDetail: laterRunDetail,
                    principalScope: fixture.principal
                )
            }

            XCTAssertEqual(store.cards.count, 2, testCase.name)
            XCTAssertEqual(store.cards.first, fixture.initialCards[1], testCase.name)
            XCTAssertEqual(
                store.cards.map(\.identity),
                [.local(fixture.unrelatedLogicalID), .run(fixture.runID)],
                testCase.name
            )
            XCTAssertEqual(
                store.cards.last?.orderKey.lastMeaningfulUpdateAt,
                fixture.runDetailUpdate,
                testCase.name
            )
            XCTAssertEqual(
                store.processingRows.map(\.itemName),
                [fixture.unrelatedItemName, fixture.matchedItemName],
                testCase.name
            )
            XCTAssertEqual(
                store.processingRows.map(\.stateLabel),
                ["Pending upload", testCase.stateLabel],
                testCase.name
            )
            XCTAssertEqual(
                store.processingRows.map(\.accessibilityLabel),
                [
                    "\(fixture.unrelatedItemName), pending upload. Local item, not sent yet.",
                    "\(fixture.matchedItemName), working, \(testCase.accessibilityFact).",
                ],
                testCase.name
            )
            XCTAssertEqual(
                store.processingRows.map(\.destination),
                [nil, .run(fixture.runID)],
                testCase.name
            )
        }
    }

    func testStoreProjectsRetryingCanonicalWorkingStagesFromRunHistoryPage() throws {
        let fixture = TrophyWallTestFixture()

        for testCase in fixture.workingStageCases {
            let store = fixture.makeStore()
            let page = TrophyWallRunHistoryPage(
                entries: [
                    TrophyWallRunHistoryEntry(
                        logicalIdentity: fixture.logicalID,
                        orderKey: TrophyWallOrderKey(
                            lastMeaningfulUpdateAt: fixture.runDetailUpdate,
                            stableIdentity: fixture.runID.uuidString.lowercased()
                        ),
                        run: try fixture.decodedRunDetail(
                            runID: fixture.runID,
                            itemID: fixture.itemID,
                            status: .retrying,
                            stage: testCase.stage
                        )
                    ),
                ],
                nextCursor: nil
            )

            for _ in 0..<2 {
                store.ingest(
                    historyPage: page,
                    principalScope: fixture.principal
                )
            }

            XCTAssertEqual(store.cards.count, 2, testCase.name)
            XCTAssertEqual(store.cards.first, fixture.initialCards[1], testCase.name)
            XCTAssertEqual(store.processingRows.count, 2, testCase.name)
            let canonicalRow = store.processingRows.last
            XCTAssertEqual(canonicalRow?.id, .run(fixture.runID), testCase.name)
            XCTAssertEqual(canonicalRow?.itemName, fixture.matchedItemName, testCase.name)
            XCTAssertEqual(canonicalRow?.stateLabel, testCase.stateLabel, testCase.name)
            XCTAssertEqual(canonicalRow?.accessibilityLabel,
                           "\(fixture.matchedItemName), working, \(testCase.accessibilityFact).",
                           testCase.name)
            XCTAssertEqual(canonicalRow?.destination, .run(fixture.runID), testCase.name)
        }
    }

    func testStoreProjectsSucceededRunWithoutReviewActionAsLockedReadyCard() throws {
        try assertLockedCanonicalProjection(.readyToReview)
    }

    func testStoreProjectsFailedRunWithoutRetryClientAsLockedNeedsRetryCard() throws {
        try assertLockedCanonicalProjection(.needsRetry)
    }

    func testStoreTombstonesNewerRetryCleanupAgainstOlderRetryableReplay() throws {
        let fixture = TrophyWallTestFixture()
        let store = fixture.makeStore()
        let retryablePage = try fixture.historyPage(
            status: .failed,
            stage: .pricing,
            terminalOutcome: .failed,
            retryTruth: (canRetry: true, workPreserved: true),
            historyOrderAt: Date(timeIntervalSince1970: 5),
            lastMeaningfulUpdateAt: "1970-01-01T00:00:05.000Z"
        )
        let retentionCleanedPage = try fixture.historyPage(
            status: .failed,
            stage: .pricing,
            terminalOutcome: .failed,
            retryTruth: (canRetry: false, workPreserved: false),
            canStartNewCapture: true,
            historyOrderAt: Date(timeIntervalSince1970: 6),
            lastMeaningfulUpdateAt: "1970-01-01T00:00:06.000Z",
            retentionCleanedAt: "1970-01-01T00:00:06.000Z"
        )

        store.ingest(historyPage: retryablePage, principalScope: fixture.principal)
        XCTAssertEqual(
            store.processingRows.map(\.stateLabel),
            ["Pending upload", "Needs retry · Upload didn't finish."]
        )

        store.ingest(historyPage: retentionCleanedPage, principalScope: fixture.principal)
        store.ingest(historyPage: retryablePage, principalScope: fixture.principal)
        store.ingest(
            acceptedHandoff: fixture.acceptedHandoff,
            runDetail: try fixture.decodedRunDetail(
                runID: fixture.runID,
                itemID: fixture.itemID
            ),
            principalScope: fixture.principal
        )

        XCTAssertEqual(store.cards, [fixture.initialCards[1]])
        XCTAssertEqual(
            store.processingRows.map(\.id),
            [.local(fixture.unrelatedLogicalID)]
        )
        XCTAssertEqual(store.processingRows.map(\.stateLabel), ["Pending upload"])
        XCTAssertEqual(store.processingRows.map(\.destination), [nil])
    }

    func testStoreKeepsValidNeedsRetryCardForMalformedNewerCanonicalTruth() throws {
        let fixture = TrophyWallTestFixture()
        let store = fixture.makeStore()
        let initialOrderKey = TrophyWallOrderKey(
            lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 5),
            stableIdentity: fixture.runID.uuidString.lowercased()
        )
        let olderRetryablePage = try fixture.historyPage(
            status: .failed,
            stage: .pricing,
            terminalOutcome: .failed,
            retryTruth: (canRetry: true, workPreserved: true),
            historyOrderAt: Date(timeIntervalSince1970: 4),
            lastMeaningfulUpdateAt: "1970-01-01T00:00:04.000Z"
        )
        let malformedPage = try fixture.historyPage(
            status: .failed,
            stage: .pricing,
            terminalOutcome: .canceled,
            retryTruth: (canRetry: true, workPreserved: true),
            historyOrderAt: Date(timeIntervalSince1970: 6),
            lastMeaningfulUpdateAt: "1970-01-01T00:00:06.000Z"
        )

        store.ingest(
            TrophyWallCanonicalAcceptedRun(
                principalScope: fixture.principal,
                runID: fixture.runID,
                linkedLogicalIdentity: fixture.logicalID,
                state: .needsRetryLocked(detail: "Upload didn't finish."),
                lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 5),
                historyOrderKey: initialOrderKey,
                itemName: nil
            )
        )
        let validCards = store.cards
        let validRows = store.processingRows

        store.ingest(historyPage: malformedPage, principalScope: fixture.principal)
        store.ingest(historyPage: malformedPage, principalScope: fixture.principal)
        store.ingest(historyPage: olderRetryablePage, principalScope: fixture.principal)

        XCTAssertEqual(store.cards, validCards)
        XCTAssertEqual(store.processingRows, validRows)
        XCTAssertEqual(
            store.cards.map(\.identity),
            [.local(fixture.unrelatedLogicalID), .run(fixture.runID)]
        )
        XCTAssertEqual(
            store.cards.map(\.orderKey.lastMeaningfulUpdateAt),
            [fixture.unrelatedUpdate, Date(timeIntervalSince1970: 5)]
        )
    }

    func testStoreConvergesRelaunchedPendingFromFrozenRunHistoryPageWithoutMutableReordering()
        throws {
        let fixture = TrophyWallTestFixture()
        let mutableRun = try fixture.decodedRunDetail(
            runID: fixture.runID,
            itemID: fixture.itemID,
            status: .running,
            stage: .pricing,
            lastMeaningfulUpdateAt: "1970-01-01T00:00:50.000Z"
        )
        let page = TrophyWallRunHistoryPage(
            entries: [
                TrophyWallRunHistoryEntry(
                    logicalIdentity: fixture.logicalID,
                    orderKey: TrophyWallOrderKey(
                        lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 5),
                        stableIdentity: fixture.runID.uuidString.lowercased()
                    ),
                    run: mutableRun
                ),
            ],
            nextCursor: nil
        )
        let store = fixture.makeStore()

        for _ in 0..<2 {
            store.ingest(
                historyPage: page,
                principalScope: fixture.principal
            )
        }

        XCTAssertEqual(store.cards.count, 2)
        XCTAssertEqual(
            store.cards.map(\.identity),
            [.local(fixture.unrelatedLogicalID), .run(fixture.runID)]
        )
        XCTAssertEqual(
            store.cards.map(\.orderKey.lastMeaningfulUpdateAt),
            [fixture.unrelatedUpdate, Date(timeIntervalSince1970: 5)]
        )
        XCTAssertEqual(
            store.processingRows.map(\.itemName),
            [fixture.unrelatedItemName, fixture.matchedItemName]
        )
        XCTAssertEqual(
            store.processingRows.map(\.stateLabel),
            ["Pending upload", "Pricing"]
        )
        XCTAssertEqual(
            store.processingRows.map(\.destination),
            [nil, .run(fixture.runID)]
        )
        XCTAssertEqual(
            page.entries.first?.run.lastMeaningfulUpdateAt,
            "1970-01-01T00:00:50.000Z"
        )
    }

    func testProcessingProjectionPreservesExactMergeTruthAndRunDestination() {
        let fixture = TrophyWallTestFixture()
        let acceptedRun = TrophyWallCanonicalAcceptedRun(
            principalScope: fixture.principal,
            runID: fixture.runID,
            linkedLogicalIdentity: fixture.logicalID,
            lastMeaningfulUpdateAt: fixture.acceptedUpdate
        )
        let store = fixture.makeStore()

        store.ingest(acceptedRun)

        XCTAssertEqual(
            store.processingRows.map(\.id),
            [.run(fixture.runID), .local(fixture.unrelatedLogicalID)]
        )
        XCTAssertEqual(
            store.processingRows.map(\.itemName),
            [fixture.matchedItemName, fixture.unrelatedItemName]
        )
        XCTAssertEqual(
            store.processingRows.map(\.stateLabel),
            ["Accepted", "Pending upload"]
        )
        XCTAssertEqual(
            store.processingRows.map(\.destination),
            [.run(fixture.runID), nil]
        )
        XCTAssertEqual(
            store.processingRows.map(\.accessibilityLabel),
            [
                "\(fixture.matchedItemName), accepted.",
                "\(fixture.unrelatedItemName), pending upload. Local item, not sent yet.",
            ]
        )
        XCTAssertEqual(
            store.processingRows.map(\.accessibilityIdentifier),
            [
                "trophy.processing.row.run.\(fixture.runID.uuidString.lowercased())",
                "trophy.processing.row.local."
                    + "37500000-0000-4000-8000-000000000002",
            ]
        )

        let firstProjection = store.processingRows
        store.ingest(acceptedRun)
        XCTAssertEqual(store.processingRows, firstProjection)
    }

    func testStoreProjectsConfirmedEbayPublicationIntoTheSettledTrophyWall() throws {
        let fixture = TrophyWallTestFixture()
        let store = fixture.makeStore()
        let historyPage = try fixture.historyPage(
            listingID: fixture.listingID,
            status: .succeeded,
            stage: .completed,
            terminalOutcome: .succeeded
        )

        store.ingest(historyPage: historyPage, principalScope: fixture.principal)
        store.applyEbayPublishStatus(
            EbayPublishStatus(
                listingID: fixture.listingID,
                outcome: .published,
                ebayListingID: "123456789012",
                ebayOfferID: "offer-375",
                alreadyPublished: true
            )
        )

        XCTAssertEqual(store.processingRows.map(\.id), [.local(fixture.unrelatedLogicalID)])
        XCTAssertEqual(
            store.settledTiles,
            [
                TrophyWallSettledTile(
                    id: .run(fixture.runID),
                    itemName: fixture.matchedItemName,
                    stateLabel: "Published to eBay",
                    completedAt: fixture.runDetailUpdate
                ),
            ]
        )
    }

    func testProcessingViewDisclosesClampedRowsWithoutRouting() {
        let fixture = TrophyWallTestFixture()
        let store = fixture.makeStore(cards: fixture.processingInitialCards)
        store.ingest(
            TrophyWallCanonicalAcceptedRun(
                principalScope: fixture.principal,
                runID: fixture.runID,
                linkedLogicalIdentity: fixture.logicalID,
                lastMeaningfulUpdateAt: fixture.acceptedUpdate
            )
        )
        let allRowIdentifiers = store.processingRows.map(\.accessibilityIdentifier)
        let scenarios = [
            (
                name: "standard",
                size: CGSize(width: 390, height: 844),
                collapsedVisualLabel: "Show 2 more",
                collapsedLabel: "Show 2 more items",
                collapsedRowIdentifiers: Array(allRowIdentifiers.prefix(3))
            ),
            (
                name: "smallest",
                size: CGSize(width: 375, height: 667),
                collapsedVisualLabel: "Show more",
                collapsedLabel: "Show more items",
                collapsedRowIdentifiers: Array(allRowIdentifiers.prefix(2))
            ),
        ]

        for scenario in scenarios {
            let collapsed = TrophyWallProcessingView.presentation(
                from: store.processingRows,
                availableHeight: scenario.size.height,
                isExpanded: false
            )
            XCTAssertEqual(collapsed.disclosureLabel, scenario.collapsedVisualLabel)
            XCTAssertEqual(
                collapsed.disclosureAccessibilityLabel,
                scenario.collapsedLabel
            )
            XCTAssertEqual(
                collapsed.visibleRows.map(\.accessibilityIdentifier),
                scenario.collapsedRowIdentifiers
            )

            let expansion = TrophyWallProcessingView.disclosureTransition(
                from: false
            )
            XCTAssertTrue(expansion.isExpanded)
            XCTAssertEqual(expansion.announcement, "Expanded")
            let expanded = TrophyWallProcessingView.presentation(
                from: store.processingRows,
                availableHeight: scenario.size.height,
                isExpanded: expansion.isExpanded
            )
            XCTAssertEqual(expanded.disclosureLabel, "Show less")
            XCTAssertEqual(
                expanded.disclosureAccessibilityLabel,
                "Show fewer items"
            )
            XCTAssertEqual(
                expanded.visibleRows.map(\.accessibilityIdentifier),
                allRowIdentifiers
            )

            let collapse = TrophyWallProcessingView.disclosureTransition(
                from: expansion.isExpanded
            )
            XCTAssertFalse(collapse.isExpanded)
            XCTAssertEqual(collapse.announcement, "Collapsed")
            let recollapsed = TrophyWallProcessingView.presentation(
                from: store.processingRows,
                availableHeight: scenario.size.height,
                isExpanded: collapse.isExpanded
            )
            XCTAssertEqual(
                recollapsed.visibleRows.map(\.accessibilityIdentifier),
                scenario.collapsedRowIdentifiers
            )
        }
    }

    func testProcessingViewRendersApprovedMergedRowsAtPhoneWidth() async {
        let fixture = TrophyWallTestFixture()
        let store = fixture.makeStore(cards: fixture.processingInitialCards)
        store.ingest(
            TrophyWallCanonicalAcceptedRun(
                principalScope: fixture.principal,
                runID: fixture.runID,
                linkedLogicalIdentity: fixture.logicalID,
                lastMeaningfulUpdateAt: fixture.acceptedUpdate
            )
        )
        var openedRoutes: [HomeRoute] = []
        XCTAssertEqual(store.processingRows.count, 5)
        let standardRows = TrophyWallProcessingView.visibleRows(
            from: store.processingRows,
            availableHeight: 844
        )
        let smallestHeightRows = TrophyWallProcessingView.visibleRows(
            from: store.processingRows,
            availableHeight: 667
        )
        XCTAssertEqual(
            standardRows.map(\.id),
            [
                .run(fixture.runID),
                .local(fixture.unrelatedLogicalID),
                .run(fixture.thirdRunID),
            ]
        )
        XCTAssertEqual(
            standardRows.map(\.destination),
            [.run(fixture.runID), nil, .run(fixture.thirdRunID)]
        )
        XCTAssertEqual(
            smallestHeightRows.map(\.id),
            [
                .run(fixture.runID),
                .local(fixture.unrelatedLogicalID),
            ]
        )
        XCTAssertEqual(
            smallestHeightRows.map(\.destination),
            [.run(fixture.runID), nil]
        )
        let standardImage = await captureHostedTrophyWallProcessingView(
            rows: store.processingRows,
            size: CGSize(width: 390, height: 844),
            dynamicTypeSize: .large,
            openRoute: { openedRoutes.append($0) }
        )
        let accessibilityImage = await captureHostedTrophyWallProcessingView(
            rows: store.processingRows,
            size: CGSize(width: 375, height: 667),
            dynamicTypeSize: .accessibility2,
            openRoute: { openedRoutes.append($0) }
        )

        XCTAssertEqual(standardImage.size, CGSize(width: 390, height: 844))
        XCTAssertEqual(accessibilityImage.size, CGSize(width: 375, height: 667))
        for image in [standardImage, accessibilityImage] {
            XCTAssertGreaterThan(
                image.opaqueDarkPixelCount(
                    in: CGRect(x: 0, y: 80, width: image.size.width, height: 160)
                ),
                100,
                "A header-only blank render must not satisfy MERGE-01 visual proof."
            )
        }
        XCTAssertTrue(openedRoutes.isEmpty)
        for (name, image) in [
            ("MERGE-01 Processing exact K-to-R convergence", standardImage),
            ("MERGE-01 Processing accessibility type", accessibilityImage),
        ] {
            let attachment = XCTAttachment(image: image)
            attachment.name = name
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }

    func testProcessingViewWithholdsEmptySuccessWithoutCollectionTruth() async {
        var openedRoutes: [HomeRoute] = []
        let image = await captureHostedTrophyWallProcessingView(
            rows: [],
            size: CGSize(width: 390, height: 844),
            dynamicTypeSize: .large,
            openRoute: { openedRoutes.append($0) }
        )

        XCTAssertEqual(image.size, CGSize(width: 390, height: 844))
        XCTAssertEqual(
            image.opaqueDarkPixelCount(
                in: CGRect(x: 0, y: 160, width: image.size.width, height: 500)
            ),
            0,
            "Unproven collection state must not render empty-success copy or actions."
        )
        XCTAssertTrue(openedRoutes.isEmpty)
    }

    func testOfflineRefreshKeepsOwnerScopedSavedTrophyCardsWithoutInventingServerTruth() async {
        let fixture = TrophyWallTestFixture()
        let store = fixture.makeStore(cards: fixture.processingInitialCards)
        let savedCards = store.cards
        let savedRows = store.processingRows
        let repository = ScriptedTrophyWallRunHistoryRepository(
            results: [.failure(URLError(.notConnectedToInternet))]
        )

        await store.refreshCollection(using: repository)

        XCTAssertEqual(store.collectionOutcome, .offline)
        XCTAssertEqual(store.cards, savedCards)
        XCTAssertEqual(store.processingRows, savedRows)
        XCTAssertEqual(repository.requestedPages.map(\.limit), [20])
        XCTAssertEqual(repository.requestedPages.map(\.cursor), [nil])

        let presentation = TrophyWallProcessingView.presentation(
            from: store.processingRows,
            collectionOutcome: store.collectionOutcome,
            availableHeight: 844,
            isExpanded: false
        )

        XCTAssertEqual(
            presentation.offlineNotice,
            "You're offline. Showing saved items."
        )
        XCTAssertNil(presentation.collectionMessage)
        XCTAssertEqual(
            presentation.visibleRows.map(\.accessibilityIdentifier),
            savedRows.prefix(3).map(\.accessibilityIdentifier)
        )
        XCTAssertEqual(
            presentation.visibleRows.map(\.stateLabel),
            ["Pending upload", "Pending upload", "Accepted"]
        )
    }

    func testEmptyProcessingStateAppearsOnlyAfterSuccessfulCollectionTruth() async {
        let fixture = TrophyWallTestFixture()
        let store = fixture.makeStore(cards: [])

        XCTAssertEqual(store.collectionOutcome, .unknown)
        let withheld = TrophyWallProcessingView.presentation(
            from: store.processingRows,
            collectionOutcome: store.collectionOutcome,
            availableHeight: 844,
            isExpanded: false
        )
        XCTAssertNil(withheld.collectionMessage)
        XCTAssertNil(withheld.offlineNotice)

        let repository = ScriptedTrophyWallRunHistoryRepository(
            results: [
                .page(TrophyWallRunHistoryPage(entries: [], nextCursor: nil)),
            ]
        )
        await store.refreshCollection(using: repository)

        XCTAssertEqual(store.collectionOutcome, .loaded)
        XCTAssertTrue(store.cards.isEmpty)

        let loaded = TrophyWallProcessingView.presentation(
            from: store.processingRows,
            collectionOutcome: store.collectionOutcome,
            availableHeight: 844,
            isExpanded: false
        )
        XCTAssertEqual(
            loaded.collectionMessage,
            TrophyWallProcessingView.CollectionMessage(
                heading: "Nothing is processing.",
                action: .scan(label: "Scan an item"),
                scoutImageName: "ScoutUncertain",
                scoutAccessibilityLabel: "Scout, the SnapList camera helper"
            )
        )
        XCTAssertNil(loaded.offlineNotice)
        XCTAssertTrue(loaded.visibleRows.isEmpty)
        XCTAssertNil(loaded.disclosureLabel)
    }

    func testUnavailableCollectionOffersTryAgainAndNeverClaimsEmptyOrSavedTruth() async throws {
        let fixture = TrophyWallTestFixture()
        let store = fixture.makeStore(cards: [])
        let repository = ScriptedTrophyWallRunHistoryRepository(
            results: [
                .failure(RunAPIError.unavailable),
                .failure(URLError(.notConnectedToInternet)),
                .page(
                    try fixture.historyPage(
                        status: .queued,
                        stage: .queued,
                        terminalOutcome: nil
                    )
                ),
            ]
        )
        let expectedMessage = TrophyWallProcessingView.CollectionMessage(
            heading: "Processing unavailable",
            action: .tryAgain(label: "Try again"),
            scoutImageName: "ScoutRetryReview",
            scoutAccessibilityLabel: "Scout, the SnapList camera helper"
        )

        await store.refreshCollection(using: repository)

        XCTAssertEqual(store.collectionOutcome, .unavailable)
        let unavailable = TrophyWallProcessingView.presentation(
            from: store.processingRows,
            collectionOutcome: store.collectionOutcome,
            availableHeight: 844,
            isExpanded: false
        )
        XCTAssertEqual(unavailable.collectionMessage, expectedMessage)
        XCTAssertNil(unavailable.offlineNotice)

        await store.refreshCollection(using: repository)

        XCTAssertEqual(store.collectionOutcome, .offline)
        let offlineWithoutCache = TrophyWallProcessingView.presentation(
            from: store.processingRows,
            collectionOutcome: store.collectionOutcome,
            availableHeight: 844,
            isExpanded: false
        )
        XCTAssertEqual(offlineWithoutCache.collectionMessage, expectedMessage)
        XCTAssertNil(
            offlineWithoutCache.offlineNotice,
            "Offline without saved items must not claim it is showing saved items."
        )

        await store.refreshCollection(using: repository)

        XCTAssertEqual(store.collectionOutcome, .loaded)
        XCTAssertEqual(store.cards.map(\.identity), [.run(fixture.runID)])
        let recovered = TrophyWallProcessingView.presentation(
            from: store.processingRows,
            collectionOutcome: store.collectionOutcome,
            availableHeight: 844,
            isExpanded: false
        )
        XCTAssertNil(recovered.collectionMessage)
        XCTAssertNil(recovered.offlineNotice)
        XCTAssertEqual(recovered.visibleRows.map(\.stateLabel), ["Accepted"])
        XCTAssertEqual(repository.requestedPages.count, 3)
    }

    func testOnlyGenuineReachabilityFailuresMayClaimTheSellerIsOffline() async {
        let fixture = TrophyWallTestFixture()
        let cases: [(code: URLError.Code, outcome: TrophyWallCollectionOutcome)] = [
            (.notConnectedToInternet, .offline),
            (.networkConnectionLost, .offline),
            (.dataNotAllowed, .offline),
            (.timedOut, .unavailable),
            (.badServerResponse, .unavailable),
            (.secureConnectionFailed, .unavailable),
            (.cannotFindHost, .unavailable),
        ]

        for testCase in cases {
            let store = fixture.makeStore(cards: fixture.processingInitialCards)
            let repository = ScriptedTrophyWallRunHistoryRepository(
                results: [.failure(URLError(testCase.code))]
            )

            await store.refreshCollection(using: repository)

            XCTAssertEqual(
                store.collectionOutcome,
                testCase.outcome,
                "URLError.\(testCase.code) must not be described as \(store.collectionOutcome)."
            )
        }
    }

    func testOverlappingCollectionRefreshCannotDowngradeNewerServerTruth() async {
        let fixture = TrophyWallTestFixture()
        let store = fixture.makeStore(cards: [])
        let repository = GatedTrophyWallRunHistoryRepository()

        async let inFlight: Void = store.refreshCollection(using: repository)
        await repository.entered.wait()
        await store.refreshCollection(using: repository)

        XCTAssertEqual(repository.requestCount, 1)
        XCTAssertEqual(store.collectionOutcome, .unknown)

        await repository.release.open()
        await inFlight

        XCTAssertEqual(store.collectionOutcome, .loaded)
        XCTAssertEqual(repository.requestCount, 1)
    }

    func testCollectionStatesRenderTheirApprovedGroupAtBothDynamicTypeRoots() async {
        let fixture = TrophyWallTestFixture()
        let savedRows = fixture.makeStore(cards: fixture.processingInitialCards)
            .processingRows
        let cases: [(name: String, rows: [TrophyWallProcessingRow], outcome: TrophyWallCollectionOutcome)] = [
            ("PROC offline with saved items", savedRows, .offline),
            ("PROC empty after proved collection", [], .loaded),
            ("PROC unavailable without cached truth", [], .unavailable),
        ]
        let roots: [(label: String, size: CGSize, dynamicTypeSize: DynamicTypeSize)] = [
            ("standard", CGSize(width: 390, height: 844), .large),
            ("accessibility", CGSize(width: 375, height: 667), .accessibility2),
        ]

        for testCase in cases {
            for root in roots {
                var openedRoutes: [HomeRoute] = []
                let image = await captureHostedTrophyWallProcessingView(
                    rows: testCase.rows,
                    collectionOutcome: testCase.outcome,
                    size: root.size,
                    dynamicTypeSize: root.dynamicTypeSize,
                    openRoute: { openedRoutes.append($0) }
                )

                XCTAssertEqual(image.size, root.size)
                XCTAssertTrue(openedRoutes.isEmpty, "\(testCase.name) must not route on render.")
                XCTAssertGreaterThan(
                    image.opaqueDarkPixelCount(
                        in: CGRect(
                            x: 0,
                            y: 80,
                            width: image.size.width,
                            height: root.size.height - 80
                        )
                    ),
                    100,
                    "\(testCase.name) at \(root.label) type must draw its approved group."
                )

                let attachment = XCTAttachment(image: image)
                attachment.name = "\(testCase.name) · \(root.label)"
                attachment.lifetime = .keepAlways
                add(attachment)
            }
        }
    }

    private func assertLockedCanonicalProjection(
        _ scenario: TrophyWallLockedProjectionScenario
    ) throws {
        let fixture = TrophyWallTestFixture()
        let page: TrophyWallRunHistoryPage
        let expectedStateLabel: String
        let expectedAccessibilityLabel: String
        let inconsistentCases: [(name: String, page: TrophyWallRunHistoryPage)]

        switch scenario {
        case .readyToReview:
            page = try fixture.historyPage(
                listingID: fixture.listingID,
                status: .succeeded,
                stage: .completed,
                terminalOutcome: .succeeded
            )
            expectedStateLabel = "Ready to review"
            expectedAccessibilityLabel =
                "\(fixture.matchedItemName), ready to review. Review is not available yet."
            let outcomes: [(String, RunTerminalOutcome?)] = [
                ("missing terminal outcome", nil),
                ("failed terminal outcome", .failed),
                ("canceled terminal outcome", .canceled),
            ]
            inconsistentCases = try outcomes.map { name, outcome in
                (
                    name,
                    try fixture.historyPage(
                        listingID: fixture.listingID,
                        status: .succeeded,
                        stage: .completed,
                        terminalOutcome: outcome
                    )
                )
            }
        case .needsRetry:
            page = try fixture.historyPage(
                status: .failed,
                stage: .pricing,
                terminalOutcome: .failed,
                retryTruth: (canRetry: true, workPreserved: true),
                canStartNewCapture: true
            )
            expectedStateLabel = "Needs retry · Upload didn't finish."
            expectedAccessibilityLabel =
                "\(fixture.matchedItemName), needs retry. Upload didn't finish."
            inconsistentCases = [
                (
                    "nonretryable failure",
                    try fixture.historyPage(
                        status: .failed,
                        stage: .pricing,
                        terminalOutcome: .failed,
                        retryTruth: (canRetry: false, workPreserved: true)
                    )
                ),
                (
                    "work not preserved",
                    try fixture.historyPage(
                        status: .failed,
                        stage: .pricing,
                        terminalOutcome: .failed,
                        retryTruth: (canRetry: true, workPreserved: false)
                    )
                ),
                (
                    "inconsistent terminal outcome",
                    try fixture.historyPage(
                        status: .failed,
                        stage: .pricing,
                        terminalOutcome: .canceled,
                        retryTruth: (canRetry: true, workPreserved: true)
                    )
                ),
            ]
        }

        let store = fixture.makeStore()
        store.ingest(historyPage: page, principalScope: fixture.principal)
        let firstCards = store.cards
        let firstRows = store.processingRows
        store.ingest(historyPage: page, principalScope: fixture.principal)

        XCTAssertEqual(
            store.cards.map(\.identity),
            [.local(fixture.unrelatedLogicalID), .run(fixture.runID)]
        )
        XCTAssertEqual(
            store.cards.map(\.orderKey.lastMeaningfulUpdateAt),
            [fixture.unrelatedUpdate, fixture.runDetailUpdate]
        )
        XCTAssertEqual(
            store.processingRows.map(\.stateLabel),
            ["Pending upload", expectedStateLabel]
        )
        XCTAssertEqual(
            store.processingRows.map(\.accessibilityLabel),
            [
                "\(fixture.unrelatedItemName), pending upload. Local item, not sent yet.",
                expectedAccessibilityLabel,
            ]
        )
        XCTAssertEqual(
            store.processingRows.map(\.destination),
            [nil, .run(fixture.runID)]
        )
        XCTAssertEqual(store.cards, firstCards)
        XCTAssertEqual(store.processingRows, firstRows)

        for testCase in inconsistentCases {
            let inconsistentStore = fixture.makeStore()
            let initialCards = inconsistentStore.cards
            inconsistentStore.ingest(
                historyPage: testCase.page,
                principalScope: fixture.principal
            )
            XCTAssertEqual(inconsistentStore.cards, initialCards, testCase.name)
        }
    }
}

@MainActor
private func captureHostedTrophyWallProcessingView(
    rows: [TrophyWallProcessingRow],
    collectionOutcome: TrophyWallCollectionOutcome = .unknown,
    size: CGSize,
    dynamicTypeSize: DynamicTypeSize,
    openRoute: @escaping (HomeRoute) -> Void
) async -> UIImage {
    let host = TrophyWallProcessingTestHost(
        rows: rows,
        collectionOutcome: collectionOutcome,
        size: size,
        dynamicTypeSize: dynamicTypeSize,
        openRoute: openRoute
    )
    await host.settle()
    let image = host.captureImage()
    host.close()
    return image
}

@MainActor
private final class TrophyWallProcessingTestHost {
    private let hostingController: UIHostingController<AnyView>
    private let window: UIWindow
    private let size: CGSize

    init(
        rows: [TrophyWallProcessingRow],
        collectionOutcome: TrophyWallCollectionOutcome,
        size: CGSize,
        dynamicTypeSize: DynamicTypeSize,
        openRoute: @escaping (HomeRoute) -> Void
    ) {
        self.size = size
        hostingController = UIHostingController(
            rootView: AnyView(
                TrophyWallProcessingView(
                    rows: rows,
                    collectionOutcome: collectionOutcome,
                    onBack: {},
                    openRoute: openRoute,
                    onScan: {},
                    onTryAgain: {}
                )
                .dynamicTypeSize(dynamicTypeSize)
                .background(Color.white)
            )
        )
        window = UIWindow(frame: CGRect(origin: .zero, size: size))
        window.backgroundColor = .white
        window.isOpaque = true
        window.rootViewController = hostingController
        hostingController.loadViewIfNeeded()
        hostingController.view.frame = window.bounds
        hostingController.view.backgroundColor = .white
        hostingController.view.isOpaque = true
        window.makeKeyAndVisible()
    }

    func settle() async {
        for _ in 0..<2 {
            await Task.yield()
            window.setNeedsLayout()
            window.layoutIfNeeded()
            hostingController.view.setNeedsLayout()
            hostingController.view.layoutIfNeeded()
        }
        hostingController.view.setNeedsDisplay()
        hostingController.view.layer.displayIfNeeded()
    }

    func captureImage() -> UIImage {
        renderOpaqueRGBA8(view: hostingController.view, size: size)
    }

    func close() {
        window.isHidden = true
        withExtendedLifetime(window) {}
    }
}

private func renderOpaqueRGBA8(view: UIView, size: CGSize) -> UIImage {
    let width = Int(size.width.rounded(.toNearestOrAwayFromZero))
    let height = Int(size.height.rounded(.toNearestOrAwayFromZero))
    let bytesPerRow = width * 4
    let bitmapInfo = CGBitmapInfo.byteOrder32Big.rawValue
        | CGImageAlphaInfo.premultipliedLast.rawValue
    guard let context = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: bytesPerRow,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: bitmapInfo
    ) else {
        preconditionFailure("Unable to create an RGBA8 Trophy Wall render context.")
    }

    context.setFillColor(UIColor.white.cgColor)
    context.fill(CGRect(origin: .zero, size: size))
    context.translateBy(x: 0, y: CGFloat(height))
    context.scaleBy(x: 1, y: -1)
    view.layer.render(in: context)

    guard let image = context.makeImage() else {
        preconditionFailure("Unable to make the Trophy Wall render image.")
    }
    return UIImage(cgImage: image, scale: 1, orientation: .up)
}

private extension UIImage {
    func opaqueDarkPixelCount(in pointRect: CGRect) -> Int {
        guard let cgImage else {
            return 0
        }

        let bytesPerPixel = 4
        let bytesPerRow = cgImage.width * bytesPerPixel
        let bitmapInfo = CGBitmapInfo.byteOrder32Big.rawValue
            | CGImageAlphaInfo.premultipliedLast.rawValue
        var pixels = [UInt8](repeating: 0, count: bytesPerRow * cgImage.height)
        let minX = max(0, Int(pointRect.minX * scale))
        let maxX = min(cgImage.width, Int(pointRect.maxX * scale))
        let minY = max(0, Int(pointRect.minY * scale))
        let maxY = min(cgImage.height, Int(pointRect.maxY * scale))

        return pixels.withUnsafeMutableBytes { buffer in
            guard let context = CGContext(
                data: buffer.baseAddress,
                width: cgImage.width,
                height: cgImage.height,
                bitsPerComponent: 8,
                bytesPerRow: bytesPerRow,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: bitmapInfo
            ) else {
                return 0
            }
            context.translateBy(x: 0, y: CGFloat(cgImage.height))
            context.scaleBy(x: 1, y: -1)
            context.draw(
                cgImage,
                in: CGRect(
                    x: 0,
                    y: 0,
                    width: CGFloat(cgImage.width),
                    height: CGFloat(cgImage.height)
                )
            )

            var count = 0
            for y in minY..<maxY {
                for x in minX..<maxX {
                    let bufferY = cgImage.height - 1 - y
                    let offset = bufferY * bytesPerRow + x * bytesPerPixel
                    let red = buffer[offset]
                    let green = buffer[offset + 1]
                    let blue = buffer[offset + 2]
                    let alpha = buffer[offset + 3]
                    if alpha > 200, red < 180, green < 180, blue < 180 {
                        count += 1
                    }
                }
            }
            return count
        }
    }
}

private struct TrophyWallConvergenceCase {
    let name: String
    let acceptedRun: TrophyWallCanonicalAcceptedRun
    let expectedCards: [TrophyWallCard]
}

private struct TrophyWallRunDetailConvergenceCase {
    let name: String
    let principalScope: TrophyWallPrincipalScope
    let runDetail: DurableRun
    let expectedCards: [TrophyWallCard]
    let expectedDestinations: [HomeRoute?]
}

private struct TrophyWallWorkingStageCase {
    let name: String
    let stage: DurableRunStage
    let stateLabel: String
    let accessibilityFact: String
}

private enum TrophyWallLockedProjectionScenario {
    case readyToReview
    case needsRetry
}

private struct TrophyWallTestFixture {
    let principal = TrophyWallPrincipalScope(opaqueValue: "principal-a")
    let otherPrincipal = TrophyWallPrincipalScope(opaqueValue: "principal-b")
    let idempotencyKey = UUID(uuidString: "37500000-0000-4000-8000-000000000001")!
    let unrelatedLogicalID = TrophyWallLogicalIdentity(
        idempotencyKey: UUID(uuidString: "37500000-0000-4000-8000-000000000002")!
    )
    let runID = UUID(uuidString: "37500000-0000-4000-8000-000000000003")!
    let thirdRunID = UUID(uuidString: "37500000-0000-4000-8000-000000000004")!
    let hiddenRunID = UUID(uuidString: "37500000-0000-4000-8000-000000000005")!
    let hiddenLogicalID = TrophyWallLogicalIdentity(
        idempotencyKey: UUID(uuidString: "37500000-0000-4000-8000-000000000006")!
    )
    let matchedItemName = "Vintage Pyrex bowl set"
    let unrelatedItemName = "Nintendo Game Boy"
    let pendingUpdate = Date(timeIntervalSince1970: 20)
    let unrelatedUpdate = Date(timeIntervalSince1970: 10)
    let acceptedUpdate = Date(timeIntervalSince1970: 30)
    let runDetailUpdate = Date(timeIntervalSince1970: 5)
    let itemID = UUID(uuidString: "37500000-0000-4000-8000-000000000007")!
    let otherItemID = UUID(uuidString: "37500000-0000-4000-8000-000000000008")!
    let listingID = UUID(uuidString: "37500000-0000-4000-8000-000000000009")!

    var logicalID: TrophyWallLogicalIdentity {
        TrophyWallLogicalIdentity(idempotencyKey: idempotencyKey)
    }

    var acceptedHandoff: AcceptedItemRunHandoff {
        AcceptedItemRunHandoff(
            idempotencyKey: idempotencyKey,
            acceptedRun: AcceptedItemRun(
                runID: runID,
                itemID: itemID,
                status: "queued",
                stage: "queued"
            )
        )
    }

    var workingStageCases: [TrophyWallWorkingStageCase] {
        [
            .init(name: "identifying", stage: .identifying, stateLabel: "Identifying", accessibilityFact: "identifying"),
            .init(name: "pricing", stage: .pricing, stateLabel: "Pricing", accessibilityFact: "pricing"),
            .init(name: "generating", stage: .generating, stateLabel: "Writing listing",
                  accessibilityFact: "writing listing"),
            .init(name: "persisting", stage: .persisting, stateLabel: "Saving", accessibilityFact: "saving"),
        ]
    }

    var initialCards: [TrophyWallCard] {
        [
            .pending(
                principalScope: principal,
                logicalIdentity: logicalID,
                itemName: matchedItemName,
                lastMeaningfulUpdateAt: pendingUpdate
            ),
            .pending(
                principalScope: principal,
                logicalIdentity: unrelatedLogicalID,
                itemName: unrelatedItemName,
                lastMeaningfulUpdateAt: unrelatedUpdate
            ),
        ]
    }

    var processingInitialCards: [TrophyWallCard] {
        initialCards + [
            .accepted(
                principalScope: principal,
                runID: thirdRunID,
                itemName: "Canon AE-1 film camera",
                lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 9)
            ),
            .accepted(
                principalScope: principal,
                runID: hiddenRunID,
                itemName: "Hidden accepted row",
                lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 8)
            ),
            .pending(
                principalScope: principal,
                logicalIdentity: hiddenLogicalID,
                itemName: "Hidden pending row",
                lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 7)
            ),
        ]
    }

    @MainActor
    func makeStore(cards: [TrophyWallCard]? = nil) -> TrophyWallStore {
        TrophyWallStore(
            principalScope: principal,
            repository: StaticTrophyWallRepository(cards: cards ?? initialCards)
        )
    }

    func historyPage(
        listingID: UUID? = nil,
        status: DurableRunStatus,
        stage: DurableRunStage,
        terminalOutcome: RunTerminalOutcome?,
        retryTruth: (canRetry: Bool, workPreserved: Bool)? = nil,
        canStartNewCapture: Bool = false,
        historyOrderAt: Date? = nil,
        lastMeaningfulUpdateAt: String = "1970-01-01T00:00:05.000Z",
        retentionCleanedAt: String? = nil
    ) throws -> TrophyWallRunHistoryPage {
        let run = try decodedRunDetail(
            runID: runID,
            itemID: itemID,
            listingID: listingID,
            status: status,
            stage: stage,
            terminalOutcome: terminalOutcome,
            retryTruth: retryTruth,
            canStartNewCapture: canStartNewCapture,
            lastMeaningfulUpdateAt: lastMeaningfulUpdateAt,
            retentionCleanedAt: retentionCleanedAt
        )
        return TrophyWallRunHistoryPage(
            entries: [
                TrophyWallRunHistoryEntry(
                    logicalIdentity: logicalID,
                    orderKey: TrophyWallOrderKey(
                        lastMeaningfulUpdateAt: historyOrderAt ?? runDetailUpdate,
                        stableIdentity: run.id.uuidString.lowercased()
                    ),
                    run: run
                ),
            ],
            nextCursor: nil
        )
    }

    func decodedRunDetail(
        runID: UUID,
        itemID: UUID,
        listingID: UUID? = nil,
        status: DurableRunStatus = .queued,
        stage: DurableRunStage = .queued,
        terminalOutcome: RunTerminalOutcome? = nil,
        retryTruth: (canRetry: Bool, workPreserved: Bool)? = nil,
        canStartNewCapture: Bool = false,
        canOpenReview: Bool = false,
        lastMeaningfulUpdateAt: String = "1970-01-01T00:00:05.000Z",
        retentionCleanedAt: String? = nil
    ) throws -> DurableRun {
        let listingIDJSON = listingID.map { "\"\($0.uuidString.lowercased())\"" } ?? "null"
        let terminalOutcomeJSON = terminalOutcome.map { "\"\($0.rawValue)\"" } ?? "null"
        let retentionCleanedAtJSON =
            retentionCleanedAt.map { "\"\($0)\"" } ?? "null"
        let canRetry = retryTruth?.canRetry ?? false
        let safeFailureJSON = retryTruth.map {
            return """
            {"reason":"This run couldn’t finish","detail":"Upload didn't finish.",\
            "retryable":\(canRetry),"workPreserved":\($0.workPreserved)}
            """
        } ?? "null"
        let json = """
        {
          "id": "\(runID.uuidString.lowercased())",
          "itemId": "\(itemID.uuidString.lowercased())",
          "listingId": \(listingIDJSON),
          "status": "\(status.rawValue)",
          "stage": "\(stage.rawValue)",
          "attemptCount": 0,
          "maxAttempts": 3,
          "schemaVersion": 1,
          "timestamps": {
            "createdAt": "1970-01-01T00:00:01.000Z",
            "updatedAt": "1970-01-01T00:00:05.000Z",
            "enqueuedAt": "1970-01-01T00:00:02.000Z",
            "startedAt": null,
            "lastAttemptedAt": null,
            "nextAttemptAt": null,
            "completedAt": null,
            "retentionCleanedAt": \(retentionCleanedAtJSON)
          },
          "item": { "title": "Server canonical title", "photoCount": 3 },
          "requiredInput": null,
          "terminalOutcome": \(terminalOutcomeJSON),
          "safeFailure": \(safeFailureJSON),
          "allowance": "reserved",
          "legalActions": {
            "canRetry": \(canRetry),
            "canCancel": false,
            "canOpenReview": \(canOpenReview),
            "canStartNewCapture": \(canStartNewCapture)
          },
          "lastMeaningfulUpdateAt": "\(lastMeaningfulUpdateAt)",
          "retentionCleanedAt": \(retentionCleanedAtJSON)
        }
        """
        return try JSONDecoder().decode(DurableRun.self, from: Data(json.utf8))
    }
}

private final class ScriptedTrophyWallRunHistoryRepository:
    TrophyWallRunHistoryRepository, @unchecked Sendable {
    enum Result {
        case page(TrophyWallRunHistoryPage)
        case failure(any Error)
    }

    struct Request: Equatable {
        let limit: Int
        let cursor: String?
    }

    private let lock = NSLock()
    private let results: [Result]
    private var deliveredCount = 0
    private var recordedRequests: [Request] = []

    init(results: [Result]) {
        precondition(!results.isEmpty)
        self.results = results
    }

    var requestedPages: [Request] {
        lock.withLock { recordedRequests }
    }

    func fetchPage(limit: Int, cursor: String?) async throws -> TrophyWallRunHistoryPage {
        let result: Result = lock.withLock {
            recordedRequests.append(Request(limit: limit, cursor: cursor))
            let next = results[min(deliveredCount, results.count - 1)]
            deliveredCount += 1
            return next
        }

        switch result {
        case .page(let page):
            return page
        case .failure(let error):
            throw error
        }
    }
}

/// A one-way latch two tasks can rendezvous on, so an overlapping-refresh test
/// proves ordering instead of racing on `Task.yield()`.
private actor RefreshGate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func open() {
        guard !isOpen else { return }
        isOpen = true
        let resumable = waiters
        waiters.removeAll()
        for waiter in resumable { waiter.resume() }
    }

    func wait() async {
        guard !isOpen else { return }
        await withCheckedContinuation { waiters.append($0) }
    }
}

private final class GatedTrophyWallRunHistoryRepository:
    TrophyWallRunHistoryRepository, @unchecked Sendable {
    let entered = RefreshGate()
    let release = RefreshGate()

    private let lock = NSLock()
    private var count = 0

    var requestCount: Int {
        lock.withLock { count }
    }

    func fetchPage(limit: Int, cursor: String?) async throws -> TrophyWallRunHistoryPage {
        lock.withLock { count += 1 }
        await entered.open()
        await release.wait()
        return TrophyWallRunHistoryPage(entries: [], nextCursor: nil)
    }
}

private struct StaticTrophyWallRepository: TrophyWallRepository {
    let cards: [TrophyWallCard]

    func initialCards(for principalScope: TrophyWallPrincipalScope) -> [TrophyWallCard] {
        cards.filter { $0.principalScope == principalScope }
    }
}
