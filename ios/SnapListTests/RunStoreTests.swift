import Foundation
import XCTest
@testable import SnapList

@MainActor
final class RunStoreTests: XCTestCase {
    func testLoaderUsesFreshBearerForTheExactRun() async {
        let run = Self.makeRun()
        let service = RecordingRunService(results: [.success(run)])
        let tokens = FreshTokenSource(tokens: ["fresh-token-1"])
        let store = RunDetailStore(
            service: service,
            bearerToken: { try await tokens.next() }
        )

        await store.load(runID: run.id)

        XCTAssertEqual(store.state, .loaded(run))
        let requests = await service.requests
        XCTAssertEqual(requests, [.init(runID: run.id, bearerToken: "fresh-token-1")])
    }

    func testLoaderFailsClosedWhenTheServiceReturnsAnotherRun() async {
        let requestedID = UUID(uuidString: "31700000-0000-4000-8000-000000000020")!
        let service = RecordingRunService(results: [.success(Self.makeRun())])
        let store = RunDetailStore(
            service: service,
            bearerToken: { "fresh-token" }
        )

        await store.load(runID: requestedID)

        XCTAssertEqual(store.state, .unavailable)
    }

    func testRefreshUsesAnotherFreshBearerAndReplacesOnlyServerTruth() async {
        let initial = Self.makeRun()
        let refreshed = Self.makeRun(
            status: .succeeded,
            stage: .completed,
            canOpenReview: true
        )
        let service = RecordingRunService(results: [.success(initial), .success(refreshed)])
        let tokens = FreshTokenSource(tokens: ["fresh-token-1", "fresh-token-2"])
        let store = RunDetailStore(
            service: service,
            bearerToken: { try await tokens.next() }
        )

        await store.load(runID: initial.id)
        await store.refresh()

        XCTAssertEqual(store.state, .loaded(refreshed))
        let requests = await service.requests
        XCTAssertEqual(
            requests,
            [
                .init(runID: initial.id, bearerToken: "fresh-token-1"),
                .init(runID: initial.id, bearerToken: "fresh-token-2")
            ]
        )
    }

    func testNewExactLoadCannotPublishThePreviousRun() async {
        let first = Self.makeRun()
        let second = Self.makeRun(
            id: UUID(uuidString: "31700000-0000-4000-8000-000000000021")!
        )
        let service = OverlappingRunService(first: first, second: second)
        let store = RunDetailStore(
            service: service,
            bearerToken: { "fresh-token" }
        )

        let firstLoad = Task { await store.load(runID: first.id) }
        await service.waitForFirstRequest()
        await store.load(runID: second.id)
        await service.resumeFirstRequest()
        await firstLoad.value

        XCTAssertEqual(store.state, .loaded(second))
        let requests = await service.requests
        XCTAssertEqual(requests.map(\.runID), [first.id, second.id])
    }

    private static func makeRun(
        id: UUID = UUID(uuidString: "31700000-0000-4000-8000-000000000010")!,
        status: DurableRunStatus = .running,
        stage: DurableRunStage = .generating,
        canOpenReview: Bool = false
    ) -> DurableRun {
        DurableRun(
            id: id,
            itemID: UUID(uuidString: "31700000-0000-4000-8000-000000000011")!,
            listingID: nil,
            status: status,
            stage: stage,
            attemptCount: 1,
            maxAttempts: 3,
            schemaVersion: 1,
            timestamps: RunTimestamps(
                createdAt: "2026-07-20T12:00:00.000Z",
                updatedAt: "2026-07-20T12:01:00.000Z",
                enqueuedAt: "2026-07-20T12:00:01.000Z",
                startedAt: "2026-07-20T12:00:02.000Z",
                lastAttemptedAt: "2026-07-20T12:00:02.000Z",
                nextAttemptAt: nil,
                completedAt: nil,
                retentionCleanedAt: nil
            ),
            item: RunItemTruth(title: "Canon AE-1 film camera", photoCount: 3),
            requiredInput: nil,
            terminalOutcome: nil,
            safeFailure: nil,
            allowance: .reserved,
            legalActions: RunActionTruth(
                canRetry: false,
                canCancel: false,
                canOpenReview: canOpenReview,
                canStartNewCapture: false
            ),
            lastMeaningfulUpdateAt: "2026-07-20T12:01:00.000Z",
            retentionCleanedAt: nil
        )
    }
}

private actor OverlappingRunService: RunServing {
    private let first: DurableRun
    private let second: DurableRun
    private var firstRequestStarted = false
    private var firstRequestWaiters: [CheckedContinuation<Void, Never>] = []
    private var firstResponse: CheckedContinuation<Void, Never>?
    private(set) var requests: [RecordingRunService.Request] = []

    init(first: DurableRun, second: DurableRun) {
        self.first = first
        self.second = second
    }

    func waitForFirstRequest() async {
        guard !firstRequestStarted else { return }
        await withCheckedContinuation { firstRequestWaiters.append($0) }
    }

    func resumeFirstRequest() {
        firstResponse?.resume()
        firstResponse = nil
    }

    func fetchRun(id: UUID, bearerToken: String) async throws -> DurableRun {
        requests.append(.init(runID: id, bearerToken: bearerToken))
        guard id == first.id else { return second }

        firstRequestStarted = true
        let waiters = firstRequestWaiters
        firstRequestWaiters.removeAll()
        waiters.forEach { $0.resume() }
        await withCheckedContinuation { firstResponse = $0 }
        return first
    }
}

private actor FreshTokenSource {
    private var tokens: [String]

    init(tokens: [String]) {
        self.tokens = tokens
    }

    func next() throws -> String {
        guard !tokens.isEmpty else { throw RunAPIError.authenticationRequired }
        return tokens.removeFirst()
    }
}

private actor RecordingRunService: RunServing {
    struct Request: Equatable {
        let runID: UUID
        let bearerToken: String
    }

    private var results: [Result<DurableRun, Error>]
    private(set) var requests: [Request] = []

    init(results: [Result<DurableRun, Error>]) {
        self.results = results
    }

    func fetchRun(id: UUID, bearerToken: String) async throws -> DurableRun {
        requests.append(.init(runID: id, bearerToken: bearerToken))
        guard !results.isEmpty else { throw RunAPIError.unavailable }
        return try results.removeFirst().get()
    }
}
