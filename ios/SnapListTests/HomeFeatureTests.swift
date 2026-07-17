import Foundation
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
