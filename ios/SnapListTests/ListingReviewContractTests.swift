import Foundation
import XCTest
@testable import SnapList

@MainActor
final class ListingReviewContractTests: XCTestCase {
    func testZeroMatchCanonicalResultBuildsEditableReviewAndPreservesItOnRefreshFailure() async {
        let itemID = UUID(uuidString: "37600000-0000-4000-8000-000000000002")!
        let otherItemID = UUID(uuidString: "37600000-0000-4000-8000-000000000006")!
        let payloads = ListingReviewPayloadTable(rows: [
            .success(Data(Self.zeroMatchCanonicalResult.utf8)),
            .failure(ListingReviewPayloadError.unavailable),
            .failure(ListingReviewPayloadError.unavailable)
        ])
        let store = ListingReviewStore(payloads: payloads)

        await store.load(itemID: itemID)

        XCTAssertEqual(store.state, .loaded)
        XCTAssertEqual(store.review?.binding.runID.uuidString.lowercased(), "37600000-0000-4000-8000-000000000001")
        XCTAssertEqual(store.review?.binding.itemID, itemID)
        XCTAssertEqual(store.review?.binding.listingID.uuidString.lowercased(), "37600000-0000-4000-8000-000000000003")
        XCTAssertEqual(store.review?.binding.reviewRevision.uuidString.lowercased(), "37600000-0000-4000-8000-000000000004")
        XCTAssertEqual(store.review?.identity.label, "Sony WH-1000XM4")
        XCTAssertEqual(store.draft?.title, "Sony WH-1000XM4 Noise-Canceling Headphones")
        XCTAssertEqual(
            store.draft?.description,
            "Clean, fully working headphones with case and charging cable."
        )
        XCTAssertEqual(store.draft?.condition, "Used - Excellent")
        XCTAssertEqual(
            store.draft?.specifics,
            [
                ListingReviewSpecific(name: "Brand", value: "Sony"),
                ListingReviewSpecific(name: "Model", value: "WH-1000XM4")
            ]
        )
        XCTAssertEqual(store.review?.pricing.suggestedPrice, 145)
        XCTAssertEqual(
            store.review?.pricing.range,
            ListingReviewPriceRange(minimum: 130, maximum: 160)
        )
        XCTAssertEqual(store.review?.pricing.confidence, 0.72)
        XCTAssertEqual(store.review?.pricing.effectivePrice, 149.99)
        XCTAssertEqual(store.review?.verifiedSoldMatches, [])
        XCTAssertEqual(store.review?.startingPriceCopy, "Starting price estimate")
        XCTAssertEqual(
            store.review?.soldEvidenceCopy,
            "No verified sold matches found."
        )

        store.editTitle("Sony WH-1000XM4 Headphones — Seller Checked")
        store.editDescription("Seller checked every control and accessory.")
        store.editCondition("Used - Good")
        store.editSpecifics([
            ListingReviewSpecific(name: "Brand", value: "Sony"),
            ListingReviewSpecific(name: "Color", value: "Black")
        ])
        store.editSellerPriceOverride(155)
        await store.refresh()

        XCTAssertEqual(store.state, .unavailable)
        XCTAssertEqual(
            store.draft?.title,
            "Sony WH-1000XM4 Headphones — Seller Checked"
        )
        XCTAssertEqual(
            store.draft?.description,
            "Seller checked every control and accessory."
        )
        XCTAssertEqual(store.draft?.condition, "Used - Good")
        XCTAssertEqual(
            store.draft?.specifics,
            [
                ListingReviewSpecific(name: "Brand", value: "Sony"),
                ListingReviewSpecific(name: "Color", value: "Black")
            ]
        )
        XCTAssertEqual(store.draft?.sellerPriceOverride, 155)
        XCTAssertEqual(
            store.draft?.sourceReviewRevision,
            UUID(uuidString: "37600000-0000-4000-8000-000000000004")
        )

        await store.load(itemID: otherItemID)

        XCTAssertEqual(store.state, .unavailable)
        XCTAssertNil(store.review)
        XCTAssertNil(store.draft)
        let requestedItemIDs = await payloads.requestedItemIDs
        XCTAssertEqual(requestedItemIDs, [itemID, itemID, otherItemID])
    }

    func testIncoherentEffectivePriceFailsClosed() async {
        let itemID = UUID(uuidString: "37600000-0000-4000-8000-000000000002")!
        let incoherent = Self.zeroMatchCanonicalResult.replacingOccurrences(
            of: #""effectivePrice": 149.99"#,
            with: #""effectivePrice": 145"#
        )
        let payloads = ListingReviewPayloadTable(rows: [
            .success(Data(incoherent.utf8))
        ])
        let store = ListingReviewStore(payloads: payloads)

        await store.load(itemID: itemID)

        XCTAssertEqual(store.state, .unavailable)
        XCTAssertNil(store.review)
        XCTAssertNil(store.draft)
    }

    func testNewerItemLoadCannotPublishAnOlderOverlappingResult() async {
        let firstItemID = UUID(uuidString: "37600000-0000-4000-8000-000000000002")!
        let secondItemID = UUID(uuidString: "37600000-0000-4000-8000-000000000006")!
        let secondPayload = Self.zeroMatchCanonicalResult.replacingOccurrences(
            of: firstItemID.uuidString.lowercased(),
            with: secondItemID.uuidString.lowercased()
        )
        let payloads = ListingReviewPayloadTable(
            rows: [
                .success(Data(Self.zeroMatchCanonicalResult.utf8)),
                .success(Data(secondPayload.utf8))
            ],
            suspendsFirstRequest: true
        )
        let store = ListingReviewStore(payloads: payloads)

        let firstLoad = Task { await store.load(itemID: firstItemID) }
        await payloads.waitForFirstRequest()
        await store.load(itemID: secondItemID)
        await payloads.resumeFirstRequest()
        await firstLoad.value

        XCTAssertEqual(store.state, .loaded)
        XCTAssertEqual(store.review?.binding.itemID, secondItemID)
        XCTAssertEqual(store.draft?.sourceReviewRevision, store.review?.binding.reviewRevision)
        let requestedItemIDs = await payloads.requestedItemIDs
        XCTAssertEqual(requestedItemIDs, [firstItemID, secondItemID])
    }

    private static let zeroMatchCanonicalResult = #"""
    {
      "schemaVersion": 1,
      "binding": {
        "runId": "37600000-0000-4000-8000-000000000001",
        "itemId": "37600000-0000-4000-8000-000000000002",
        "listingId": "37600000-0000-4000-8000-000000000003",
        "reviewRevision": "37600000-0000-4000-8000-000000000004"
      },
      "photos": [
        {
          "id": "37600000-0000-4000-8000-000000000005",
          "url": "https://media.snaplist.dev/items/376-cover.jpg"
        }
      ],
      "identity": {
        "label": "Sony WH-1000XM4",
        "confident": true
      },
      "listing": {
        "title": "Sony WH-1000XM4 Noise-Canceling Headphones",
        "description": "Clean, fully working headphones with case and charging cable.",
        "condition": "Used - Excellent",
        "specifics": [
          { "name": "Brand", "value": "Sony" },
          { "name": "Model", "value": "WH-1000XM4" }
        ]
      },
      "pricing": {
        "suggestedPrice": 145,
        "range": { "minimum": 130, "maximum": 160 },
        "confidence": 0.72,
        "sellerPriceOverride": 149.99,
        "effectivePrice": 149.99
      },
      "evidenceAsOf": "2026-07-27T15:30:00.000Z",
      "verifiedSoldMatches": []
    }
    """#
}

private enum ListingReviewPayloadError: Error {
    case unavailable
}

private actor ListingReviewPayloadTable: ListingReviewPayloadServing {
    private var rows: [Result<Data, Error>]
    private let suspendsFirstRequest: Bool
    private var firstRequestStarted = false
    private var firstRequestWaiters: [CheckedContinuation<Void, Never>] = []
    private var firstResponse: CheckedContinuation<Void, Never>?
    private(set) var requestedItemIDs: [UUID] = []

    init(
        rows: [Result<Data, Error>],
        suspendsFirstRequest: Bool = false
    ) {
        self.rows = rows
        self.suspendsFirstRequest = suspendsFirstRequest
    }

    func waitForFirstRequest() async {
        guard !firstRequestStarted else { return }
        await withCheckedContinuation { firstRequestWaiters.append($0) }
    }

    func resumeFirstRequest() {
        firstResponse?.resume()
        firstResponse = nil
    }

    func fetchListingReviewPayload(itemID: UUID) async throws -> Data {
        requestedItemIDs.append(itemID)
        guard !rows.isEmpty else { throw ListingReviewPayloadError.unavailable }
        let row = rows.removeFirst()
        if suspendsFirstRequest && requestedItemIDs.count == 1 {
            firstRequestStarted = true
            let waiters = firstRequestWaiters
            firstRequestWaiters.removeAll()
            waiters.forEach { $0.resume() }
            await withCheckedContinuation { firstResponse = $0 }
        }
        return try row.get()
    }
}
