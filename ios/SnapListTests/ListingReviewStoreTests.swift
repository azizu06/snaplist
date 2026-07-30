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
            reloads: []
        )
        let store = makeStore(service: service)

        let opened = await store.open(snapshot)
        let cleanOutcome = await store.done()
        let cleanRequests = await service.recordedSaveRequests()

        XCTAssertTrue(opened)
        XCTAssertEqual(cleanOutcome, .dismissedWithoutWrite)
        XCTAssertEqual(cleanRequests.count, 0)

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
    }

    func testSemanticRevertBecomesCleanAndRelaunchRestoresDirtyDraft() async throws {
        let snapshot = try Self.makeSnapshot()
        let persistence = MemoryListingReviewDraftPersistence()
        let service = ListingReviewRecordingService(saves: [], reloads: [])
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

        await relaunched.setDescription(snapshot.listing.description)
        let revertedOutcome = await relaunched.done()
        let saveRequests = await service.recordedSaveRequests()
        XCTAssertFalse(relaunched.isDirty)
        XCTAssertEqual(revertedOutcome, .dismissedWithoutWrite)
        XCTAssertEqual(saveRequests.count, 0)
    }

    func testConflictKeepsDraftUntilExplicitDiscardReloadSucceeds() async throws {
        let snapshot = try Self.makeSnapshot()
        let current = try Self.makeSnapshot(
            revision: "55000000-0000-4000-8000-000000000099",
            title: "Current server title"
        )
        let service = ListingReviewRecordingService(
            saves: [.failure(ListingReviewClientError.conflict)],
            reloads: [.success(current)]
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

        await store.requestReload()
        await store.discardChangesAndReload()

        XCTAssertEqual(store.phase, .ready)
        XCTAssertEqual(store.draft?.title, "Current server title")
        XCTAssertFalse(store.isDirty)
    }

    private func makeStore(
        service: ListingReviewRecordingService,
        persistence: any ListingReviewDraftPersisting =
            MemoryListingReviewDraftPersistence()
    ) -> ListingReviewStore {
        ListingReviewStore(
            service: service,
            persistence: persistence,
            tokenProvider: ListingReviewTestBearerProvider(),
            now: { Date(timeIntervalSince1970: 1_800_000_000) },
            makeID: {
                UUID(uuidString: "55000000-0000-4000-8000-000000000050")!
            }
        )
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
        title: String = "Sony WH-1000XM4 Noise-Canceling Headphones"
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
                "url": "https://media.snaplist.dev/items/550-cover.jpg",
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

private struct ListingReviewTestBearerProvider: BearerTokenProviding {
    func bearerToken() async throws -> String {
        "listing-review-test-bearer"
    }

    func principalBoundBearer() async throws -> PrincipalBoundBearer {
        PrincipalBoundBearer(
            bearerToken: "listing-review-test-bearer",
            scopeProof: ItemRunSubmissionPrincipalScopeProof(
                verifiedClerkSubject: "listing-review-test-user"
            )!
        )
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
