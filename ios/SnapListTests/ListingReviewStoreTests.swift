import Foundation
import XCTest
@testable import SnapList

@MainActor
final class ListingReviewStoreTests: XCTestCase {
    func testCleanDoneDoesNotWriteAndDirtyRetryReusesOneLogicalSave() async throws {
        let snapshot = try Self.makeSnapshot()
        let service = ListingReviewRecordingService(
            saves: [
                .failure(ListingReviewClientError.unavailable),
                .success(Self.receipt(for: snapshot)),
            ],
            reloads: [.success(snapshot)]
        )
        let store = makeStore(service: service)

        let opened = await store.open(snapshot)
        let cleanOutcome = await store.done()
        let cleanRequests = await service.recordedSaveRequests()

        XCTAssertTrue(opened)
        XCTAssertEqual(cleanOutcome, .dismissedWithoutWrite)
        XCTAssertEqual(cleanRequests.count, 0)
        await store.setSpecific(name: "Condition", value: "poor")
        XCTAssertEqual(
            store.draft?.specifics.first(where: {
                $0.name == "Condition"
            })?.value,
            "very-good"
        )

        await store.setTitle("Sony WH-1000XM4 headphones with case")
        let failedOutcome = await store.done()
        XCTAssertEqual(failedOutcome, .stayed)
        XCTAssertEqual(store.phase, .failed)

        let result = await store.retrySave()

        XCTAssertEqual(result, .saved(Self.receipt(for: snapshot)))
        let requests = await service.recordedSaveRequests()
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[0].idempotencyKey, requests[1].idempotencyKey)
        XCTAssertEqual(requests[0].expectedRevision, snapshot.binding.reviewRevision)

        var invalidDraft = ListingReviewDraft(snapshot: snapshot)
        invalidDraft.specifics = []
        XCTAssertFalse(invalidDraft.hasRequiredCopy)
        invalidDraft.specifics = (0...50).map {
            ListingReviewSpecific(name: "Field \($0)", value: "Value")
        }
        XCTAssertFalse(invalidDraft.hasRequiredCopy)
        invalidDraft.specifics = [
            ListingReviewSpecific(
                name: String(repeating: "N", count: 66),
                value: "Value"
            ),
        ]
        XCTAssertFalse(invalidDraft.hasRequiredCopy)
        invalidDraft.specifics = [
            ListingReviewSpecific(
                name: "Field",
                value: String(repeating: "V", count: 501)
            ),
        ]
        XCTAssertFalse(invalidDraft.hasRequiredCopy)
        invalidDraft.specifics = [
            ListingReviewSpecific(name: "Type", value: "Headphones"),
            ListingReviewSpecific(name: "Category", value: "Audio"),
        ]
        XCTAssertFalse(invalidDraft.hasRequiredCopy)

        let failingPersistence = ListingReviewTogglePersistence()
        let durabilityService = ListingReviewRecordingService(
            saves: [.success(Self.receipt(for: snapshot))],
            reloads: [.success(snapshot)]
        )
        let durabilityStore = makeStore(
            service: durabilityService,
            persistence: failingPersistence
        )
        let durabilityOpened = await durabilityStore.open(snapshot)
        XCTAssertTrue(durabilityOpened)
        await durabilityStore.setTitle("Durably staged title")
        await failingPersistence.failSaves()

        let durabilityOutcome = await durabilityStore.done()
        let durabilityRequests =
            await durabilityService.recordedSaveRequests()

        XCTAssertEqual(durabilityOutcome, .stayed)
        XCTAssertEqual(durabilityStore.phase, .failed)
        XCTAssertEqual(durabilityRequests.count, 0)

        let overlapPersistence = ListingReviewCommitGatePersistence(
            gate: .save(title: "Older edit")
        )
        let overlapService = ListingReviewRecordingService(
            saves: [],
            reloads: [.success(snapshot)]
        )
        let overlapStore = makeStore(
            service: overlapService,
            persistence: overlapPersistence
        )
        let overlapOpened = await overlapStore.open(snapshot)
        XCTAssertTrue(overlapOpened)
        let olderEdit = Task { @MainActor in
            await overlapStore.setTitle("Older edit")
        }
        await overlapPersistence.waitUntilBlocked()
        let newerOverlapService = ListingReviewRecordingService(
            saves: [],
            reloads: [.success(snapshot)]
        )
        let newerOverlapStore = makeStore(
            service: newerOverlapService,
            persistence: overlapPersistence
        )
        let newerOverlapOpened = await newerOverlapStore.open(snapshot)
        XCTAssertTrue(newerOverlapOpened)
        await newerOverlapStore.setTitle("Newest edit")
        await overlapPersistence.release()
        await olderEdit.value
        let overlapRecord = try await overlapPersistence.loadCurrent(
            runID: snapshot.binding.runID
        )
        XCTAssertEqual(newerOverlapStore.draft?.title, "Newest edit")
        XCTAssertEqual(overlapRecord?.draft.title, "Newest edit")

        let savingProvider = ListingReviewGateBearerProvider(
            blockedCall: 4
        )
        let savingService = ListingReviewRecordingService(
            saves: [.success(Self.receipt(for: snapshot))],
            reloads: [.success(snapshot)]
        )
        let savingStore = makeStore(
            service: savingService,
            persistence: MemoryListingReviewDraftPersistence(),
            tokenProvider: savingProvider
        )
        let savingOpened = await savingStore.open(snapshot)
        XCTAssertTrue(savingOpened)
        await savingStore.setTitle("Frozen save")
        let saveTask = Task { @MainActor in
            await savingStore.done()
        }
        await savingProvider.waitUntilBlocked()
        await savingStore.setDescription("Must not enter the active save")
        await savingProvider.release()
        let frozenOutcome = await saveTask.value
        let frozenRequests = await savingService.recordedSaveRequests()
        XCTAssertEqual(
            frozenOutcome,
            .saved(Self.receipt(for: snapshot))
        )
        XCTAssertEqual(
            frozenRequests.first?.draft.description,
            snapshot.listing.description
        )

        let staleClient = ListingReviewAPIClient(
            baseURL: URL(string: "https://api.snaplist.dev")!,
            session: makeConflictSession(
                message: ListingReviewCopy.staleReview
            )
        )
        do {
            _ = try await staleClient.save(
                runID: snapshot.binding.runID,
                draft: ListingReviewDraft(snapshot: snapshot),
                expectedReviewRevision: snapshot.binding.reviewRevision,
                idempotencyKey: UUID(),
                bearerToken: "listing-review-test-bearer"
            )
            XCTFail("Accepted a stale save conflict")
        } catch {
            XCTAssertEqual(error as? ListingReviewClientError, .conflict)
        }

        let inProgressClient = ListingReviewAPIClient(
            baseURL: URL(string: "https://api.snaplist.dev")!,
            session: makeConflictSession(
                message: "This save is already in progress. Try again."
            )
        )
        do {
            _ = try await inProgressClient.save(
                runID: snapshot.binding.runID,
                draft: ListingReviewDraft(snapshot: snapshot),
                expectedReviewRevision: snapshot.binding.reviewRevision,
                idempotencyKey: UUID(),
                bearerToken: "listing-review-test-bearer"
            )
            XCTFail("Accepted an in-progress save response")
        } catch {
            XCTAssertEqual(error as? ListingReviewClientError, .unavailable)
        }

        let removePersistence = ListingReviewCommitGatePersistence(
            gate: .remove
        )
        let removeService = ListingReviewRecordingService(
            saves: [.success(Self.receipt(for: snapshot))],
            reloads: [.success(snapshot)]
        )
        let removeStore = makeStore(
            service: removeService,
            persistence: removePersistence
        )
        let removeOpened = await removeStore.open(snapshot)
        XCTAssertTrue(removeOpened)
        await removeStore.setTitle("Old saved draft")
        let removeTask = Task { @MainActor in
            await removeStore.done()
        }
        await removePersistence.waitUntilBlocked()
        let newerRemoveService = ListingReviewRecordingService(
            saves: [],
            reloads: [.success(snapshot)]
        )
        let newerRemoveStore = makeStore(
            service: newerRemoveService,
            persistence: removePersistence
        )
        let removeReopened = await newerRemoveStore.open(snapshot)
        XCTAssertTrue(removeReopened)
        await newerRemoveStore.setTitle("Newest draft after reopen")
        await removePersistence.release()
        let staleRemoveOutcome = await removeTask.value
        let newestRecord = try await removePersistence.loadCurrent(
            runID: snapshot.binding.runID
        )
        XCTAssertEqual(staleRemoveOutcome, .stayed)
        XCTAssertEqual(newerRemoveStore.phase, .ready)
        XCTAssertEqual(
            newerRemoveStore.draft?.title,
            "Newest draft after reopen"
        )
        XCTAssertEqual(
            newestRecord?.draft.title,
            "Newest draft after reopen"
        )
    }

    func testSemanticRevertBecomesCleanAndRelaunchRestoresDirtyDraft() async throws {
        let snapshot = try Self.makeSnapshot(
            photoURL: "https://media.snaplist.dev/items/expired-550-cover.jpg"
        )
        let refreshed = try Self.makeSnapshot(
            photoURL: "https://media.snaplist.dev/items/fresh-550-cover.jpg"
        )
        let persistence = MemoryListingReviewDraftPersistence()
        let service = ListingReviewRecordingService(
            saves: [],
            reloads: [.success(snapshot), .success(refreshed)]
        )
        let first = makeStore(service: service, persistence: persistence)

        let firstOpened = await first.open(snapshot)
        XCTAssertTrue(firstOpened)
        await first.setDescription("Locally staged description")
        XCTAssertTrue(first.isDirty)

        let relaunched = makeStore(service: service, persistence: persistence)
        let relaunchedOpened = await relaunched.open(snapshot)
        XCTAssertTrue(relaunchedOpened)
        XCTAssertEqual(relaunched.draft?.description, "Locally staged description")
        XCTAssertTrue(relaunched.isDirty)
        XCTAssertEqual(
            relaunched.snapshot?.photos.first?.url,
            refreshed.photos.first?.url
        )

        await relaunched.setDescription(snapshot.listing.description)
        let revertedOutcome = await relaunched.done()
        let saveRequests = await service.recordedSaveRequests()
        XCTAssertFalse(relaunched.isDirty)
        XCTAssertEqual(revertedOutcome, .dismissedWithoutWrite)
        XCTAssertEqual(saveRequests.count, 0)

        XCTAssertTrue(
            LocalListingReviewDraftPersistence.writingOptions
                .contains(.atomic)
        )
        XCTAssertTrue(
            LocalListingReviewDraftPersistence.writingOptions
                .contains(.completeFileProtection)
        )
        let localRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: localRoot) }
        let local = LocalListingReviewDraftPersistence(
            rootDirectory: localRoot
        )
        let localToken = ListingReviewDraftPersistenceToken(
            sessionID: UUID(),
            generation: 1
        )
        let localActivated = await local.activate(
            localToken,
            runID: snapshot.binding.runID
        )
        XCTAssertTrue(localActivated)
        let missingRecord = try await local.load(
            runID: snapshot.binding.runID,
            token: localToken
        )
        XCTAssertNil(missingRecord)
        let record = PersistedListingReviewDraft(
            snapshot: snapshot,
            draft: ListingReviewDraft(snapshot: snapshot),
            pendingSave: nil,
            expiresAt: Date(timeIntervalSince1970: 1_800_086_400)
        )
        let localSaved = try await local.save(
            record,
            runID: snapshot.binding.runID,
            token: localToken
        )
        XCTAssertTrue(localSaved)
        let recordURL = localRoot.appendingPathComponent(
            snapshot.binding.runID.uuidString.lowercased() + ".json"
        )
        try Data("{".utf8).write(to: recordURL, options: .atomic)

        let corruptRecord = try await local.load(
            runID: snapshot.binding.runID,
            token: localToken
        )
        XCTAssertNil(corruptRecord)
        XCTAssertFalse(FileManager.default.fileExists(atPath: recordURL.path))

        let principalProvider = ListingReviewTestBearerProvider(
            subject: "listing-review-principal-a"
        )
        let principalPersistence = MemoryListingReviewDraftPersistence()
        let principalService = ListingReviewRecordingService(
            saves: [],
            reloads: [
                .success(snapshot),
                .failure(ListingReviewClientError.unavailable),
            ]
        )
        let principalStore = makeStore(
            service: principalService,
            persistence: principalPersistence,
            tokenProvider: principalProvider
        )
        let principalOpened = await principalStore.open(snapshot)
        XCTAssertTrue(principalOpened)
        await principalStore.setTitle("Principal A draft")
        await principalProvider.setSubject("listing-review-principal-b")
        let switchedStore = makeStore(
            service: principalService,
            persistence: principalPersistence,
            tokenProvider: principalProvider
        )

        let switchedOpened = await switchedStore.open(snapshot)
        XCTAssertFalse(switchedOpened)
        XCTAssertNil(switchedStore.snapshot)
        XCTAssertNil(switchedStore.draft)

        let newer = try Self.makeSnapshot(
            revision: "55000000-0000-4000-8000-000000000088",
            title: "Newer concurrent open"
        )
        let openService = ListingReviewOpenGateService(
            first: snapshot,
            second: newer
        )
        let openStore = makeStore(service: openService)
        let olderOpen = Task { @MainActor in
            await openStore.open(snapshot)
        }
        await openService.waitUntilFirstFetchBlocked()
        let newerOpened = await openStore.open(newer)
        await openService.releaseFirstFetch()
        let olderOpened = await olderOpen.value

        XCTAssertTrue(newerOpened)
        XCTAssertFalse(olderOpened)
        XCTAssertEqual(openStore.snapshot?.listing.title, newer.listing.title)
    }

    func testConflictKeepsDraftUntilExplicitDiscardReloadSucceeds() async throws {
        let snapshot = try Self.makeSnapshot()
        let current = try Self.makeSnapshot(
            revision: "55000000-0000-4000-8000-000000000099",
            title: "Current server title"
        )
        let service = ListingReviewRecordingService(
            saves: [.failure(ListingReviewClientError.conflict)],
            reloads: [.success(snapshot), .success(current)]
        )
        let store = makeStore(service: service)

        let opened = await store.open(snapshot)
        XCTAssertTrue(opened)
        await store.setTitle("My local title")
        let saveOutcome = await store.done()
        XCTAssertEqual(saveOutcome, .stayed)
        XCTAssertEqual(store.phase, .conflict)

        await store.requestReload()
        XCTAssertEqual(store.phase, .reloadConfirmation)
        store.keepEditing()
        XCTAssertEqual(store.draft?.title, "My local title")
        XCTAssertTrue(store.isDirty)
        let requestsBeforeStaleDone =
            await service.recordedSaveRequests()
        let staleOutcome = await store.done()
        let requestsAfterStaleDone =
            await service.recordedSaveRequests()
        XCTAssertEqual(staleOutcome, .stayed)
        XCTAssertEqual(
            requestsAfterStaleDone.count,
            requestsBeforeStaleDone.count
        )

        await store.requestReload()
        await store.discardChangesAndReload()

        XCTAssertEqual(store.phase, .ready)
        XCTAssertEqual(store.draft?.title, "Current server title")
        XCTAssertFalse(store.isDirty)
    }

    private func makeStore(
        service: any ListingReviewServing,
        persistence: any ListingReviewDraftPersisting =
            MemoryListingReviewDraftPersistence(),
        tokenProvider: any BearerTokenProviding =
            ListingReviewTestBearerProvider()
    ) -> ListingReviewStore {
        ListingReviewStore(
            service: service,
            persistence: persistence,
            tokenProvider: tokenProvider,
            now: { Date(timeIntervalSince1970: 1_800_000_000) },
            makeID: {
                UUID(uuidString: "55000000-0000-4000-8000-000000000050")!
            }
        )
    }

    private func makeConflictSession(message: String) -> URLSession {
        ListingReviewURLProtocolStub.handler = { request in
            (
                HTTPURLResponse(
                    url: try XCTUnwrap(request.url),
                    statusCode: 409,
                    httpVersion: nil,
                    headerFields: ["Content-Type": "application/json"]
                )!,
                Data(
                    """
                    {
                      "error": {
                        "code": "conflict",
                        "message": "\(message)",
                        "requestId": "listing-review-request"
                      }
                    }
                    """.utf8
                )
            )
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ListingReviewURLProtocolStub.self]
        return URLSession(configuration: configuration)
    }

    private static func receipt(
        for snapshot: ListingReviewResult
    ) -> ListingReviewSaveReceipt {
        ListingReviewSaveReceipt(
            schemaVersion: 1,
            runID: snapshot.binding.runID,
            itemID: snapshot.binding.itemID,
            listingID: snapshot.binding.listingID,
            reviewRevision: UUID(
                uuidString: "55000000-0000-4000-8000-000000000051"
            )!
        )
    }

    private static func makeSnapshot(
        revision: String = "55000000-0000-4000-8000-000000000004",
        title: String = "Sony WH-1000XM4 Noise-Canceling Headphones",
        photoURL: String =
            "https://media.snaplist.dev/items/550-cover.jpg"
    ) throws -> ListingReviewResult {
        let object: [String: Any] = [
            "schemaVersion": 1,
            "binding": [
                "runId": "55000000-0000-4000-8000-000000000001",
                "itemId": "55000000-0000-4000-8000-000000000002",
                "listingId": "55000000-0000-4000-8000-000000000003",
                "reviewRevision": revision,
            ],
            "photos": [[
                "ordinal": 0,
                "url": photoURL,
            ]],
            "identity": [
                "label": "Sony WH-1000XM4",
                "confident": true,
            ],
            "listing": [
                "title": title,
                "description": "Clean, fully working headphones with case and charging cable.",
                "condition": "very-good",
                "specifics": [
                    ["name": "Brand", "value": "Sony"],
                    ["name": "Model", "value": "WH-1000XM4"],
                    ["name": "Condition", "value": "very-good"],
                    ["name": "Color", "value": "Black"],
                ],
            ],
            "pricing": [
                "suggestedPrice": 145,
                "range": ["minimum": 130, "maximum": 160],
                "confidence": 0.72,
                "sellerPriceOverride": NSNull(),
                "effectivePrice": 145,
            ],
            "evidenceAsOf": "2026-07-29T12:03:00.000Z",
            "verifiedSoldMatches": [],
            "startingPriceCopy": "Starting price estimate",
            "soldEvidenceCopy": "No verified sold matches found.",
        ]
        return try JSONDecoder().decode(
            ListingReviewResult.self,
            from: JSONSerialization.data(withJSONObject: object)
        )
    }
}

private final class ListingReviewURLProtocolStub:
    URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler:
        (@Sendable (URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(
        for request: URLRequest
    ) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(
                self,
                didFailWithError: URLError(.badServerResponse)
            )
            return
        }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(
                self,
                didReceive: response,
                cacheStoragePolicy: .notAllowed
            )
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

private actor ListingReviewTestBearerProvider: BearerTokenProviding {
    private var subject: String

    init(subject: String = "listing-review-test-user") {
        self.subject = subject
    }

    func setSubject(_ value: String) {
        subject = value
    }

    func bearerToken() async throws -> String {
        "listing-review-test-bearer"
    }

    func principalBoundBearer() async throws -> PrincipalBoundBearer {
        PrincipalBoundBearer(
            bearerToken: "listing-review-test-bearer",
            scopeProof: ItemRunSubmissionPrincipalScopeProof(
                verifiedClerkSubject: subject
            )!
        )
    }
}

private actor ListingReviewTogglePersistence:
    ListingReviewDraftPersisting {
    private let base = MemoryListingReviewDraftPersistence()
    private var shouldFailSaves = false

    func failSaves() {
        shouldFailSaves = true
    }

    func activate(
        _ token: ListingReviewDraftPersistenceToken,
        runID: UUID
    ) async -> Bool {
        await base.activate(token, runID: runID)
    }

    func load(
        runID: UUID,
        token: ListingReviewDraftPersistenceToken
    ) async throws -> PersistedListingReviewDraft? {
        try await base.load(runID: runID, token: token)
    }

    func save(
        _ record: PersistedListingReviewDraft,
        runID: UUID,
        token: ListingReviewDraftPersistenceToken
    ) async throws -> Bool {
        if shouldFailSaves {
            throw CocoaError(.fileWriteUnknown)
        }
        return try await base.save(record, runID: runID, token: token)
    }

    func remove(
        runID: UUID,
        token: ListingReviewDraftPersistenceToken
    ) async throws -> Bool {
        try await base.remove(runID: runID, token: token)
    }
}

private actor ListingReviewCommitGatePersistence:
    ListingReviewDraftPersisting {
    enum Gate {
        case save(title: String)
        case remove
    }

    private let gate: Gate
    private let base = MemoryListingReviewDraftPersistence()
    private var didBlock = false
    private var isBlocked = false
    private var blockedWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseContinuation: CheckedContinuation<Void, Never>?

    init(gate: Gate) {
        self.gate = gate
    }

    func activate(
        _ token: ListingReviewDraftPersistenceToken,
        runID: UUID
    ) async -> Bool {
        await base.activate(token, runID: runID)
    }

    func load(
        runID: UUID,
        token: ListingReviewDraftPersistenceToken
    ) async throws -> PersistedListingReviewDraft? {
        try await base.load(runID: runID, token: token)
    }

    func save(
        _ record: PersistedListingReviewDraft,
        runID: UUID,
        token: ListingReviewDraftPersistenceToken
    ) async throws -> Bool {
        if case let .save(title) = gate,
           record.draft.title == title {
            await blockOnce()
        }
        return try await base.save(record, runID: runID, token: token)
    }

    func remove(
        runID: UUID,
        token: ListingReviewDraftPersistenceToken
    ) async throws -> Bool {
        if case .remove = gate {
            await blockOnce()
        }
        return try await base.remove(runID: runID, token: token)
    }

    func waitUntilBlocked() async {
        guard !isBlocked else { return }
        await withCheckedContinuation {
            blockedWaiters.append($0)
        }
    }

    func release() {
        releaseContinuation?.resume()
        releaseContinuation = nil
    }

    func loadCurrent(
        runID: UUID
    ) async throws -> PersistedListingReviewDraft? {
        let token = ListingReviewDraftPersistenceToken(
            sessionID: UUID(),
            generation: 0
        )
        guard await base.activate(token, runID: runID) else { return nil }
        return try await base.load(runID: runID, token: token)
    }

    private func blockOnce() async {
        guard !didBlock else { return }
        didBlock = true
        isBlocked = true
        blockedWaiters.forEach { $0.resume() }
        blockedWaiters.removeAll()
        await withCheckedContinuation {
            releaseContinuation = $0
        }
    }
}

private actor ListingReviewGateBearerProvider: BearerTokenProviding {
    private let blockedCall: Int
    private var callCount = 0
    private var isBlocked = false
    private var blockedWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseContinuation: CheckedContinuation<Void, Never>?

    init(blockedCall: Int) {
        self.blockedCall = blockedCall
    }

    func bearerToken() async throws -> String {
        "listing-review-gate-bearer"
    }

    func principalBoundBearer() async throws -> PrincipalBoundBearer {
        callCount += 1
        if callCount == blockedCall {
            isBlocked = true
            blockedWaiters.forEach { $0.resume() }
            blockedWaiters.removeAll()
            await withCheckedContinuation {
                releaseContinuation = $0
            }
        }
        return PrincipalBoundBearer(
            bearerToken: "listing-review-gate-bearer",
            scopeProof: ItemRunSubmissionPrincipalScopeProof(
                verifiedClerkSubject: "listing-review-gate-user"
            )!
        )
    }

    func waitUntilBlocked() async {
        guard !isBlocked else { return }
        await withCheckedContinuation {
            blockedWaiters.append($0)
        }
    }

    func release() {
        releaseContinuation?.resume()
        releaseContinuation = nil
    }
}

private actor ListingReviewOpenGateService: ListingReviewServing {
    private let first: ListingReviewResult
    private let second: ListingReviewResult
    private var fetchCount = 0
    private var isBlocked = false
    private var blockedWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseContinuation: CheckedContinuation<Void, Never>?

    init(first: ListingReviewResult, second: ListingReviewResult) {
        self.first = first
        self.second = second
    }

    func save(
        runID: UUID,
        draft: ListingReviewDraft,
        expectedReviewRevision: UUID,
        idempotencyKey: UUID,
        bearerToken: String
    ) async throws -> ListingReviewSaveReceipt {
        throw ListingReviewClientError.unavailable
    }

    func fetchReview(
        runID: UUID,
        bearerToken: String
    ) async throws -> ListingReviewResult {
        fetchCount += 1
        if fetchCount == 1 {
            isBlocked = true
            blockedWaiters.forEach { $0.resume() }
            blockedWaiters.removeAll()
            await withCheckedContinuation {
                releaseContinuation = $0
            }
            return first
        }
        return second
    }

    func waitUntilFirstFetchBlocked() async {
        guard !isBlocked else { return }
        await withCheckedContinuation {
            blockedWaiters.append($0)
        }
    }

    func releaseFirstFetch() {
        releaseContinuation?.resume()
        releaseContinuation = nil
    }
}

private actor ListingReviewRecordingService: ListingReviewServing {
    struct SaveRequest: Equatable {
        let idempotencyKey: UUID
        let expectedRevision: UUID
        let draft: ListingReviewDraft
    }

    private var saves: [Result<ListingReviewSaveReceipt, Error>]
    private var reloads: [Result<ListingReviewResult, Error>]
    private(set) var saveRequests: [SaveRequest] = []

    init(
        saves: [Result<ListingReviewSaveReceipt, Error>],
        reloads: [Result<ListingReviewResult, Error>]
    ) {
        self.saves = saves
        self.reloads = reloads
    }

    func save(
        runID: UUID,
        draft: ListingReviewDraft,
        expectedReviewRevision: UUID,
        idempotencyKey: UUID,
        bearerToken: String
    ) async throws -> ListingReviewSaveReceipt {
        saveRequests.append(
            SaveRequest(
                idempotencyKey: idempotencyKey,
                expectedRevision: expectedReviewRevision,
                draft: draft
            )
        )
        guard !saves.isEmpty else { throw ListingReviewClientError.unavailable }
        return try saves.removeFirst().get()
    }

    func fetchReview(
        runID: UUID,
        bearerToken: String
    ) async throws -> ListingReviewResult {
        guard !reloads.isEmpty else { throw ListingReviewClientError.unavailable }
        return try reloads.removeFirst().get()
    }

    func recordedSaveRequests() -> [SaveRequest] {
        saveRequests
    }
}
