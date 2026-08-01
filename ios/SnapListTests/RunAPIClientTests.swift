import Foundation
import XCTest
@testable import SnapList

final class RunAPIClientTests: XCTestCase {
    func testRunHistoryRepositoryPreservesFrozenOrderAndLogicalIdentity() async throws {
        let expectedRunID = UUID(
            uuidString: "37500000-0000-4000-8000-000000000031"
        )!
        let expectedLogicalKey = "37500000-0000-4000-8000-000000000032"
        let session = makeSession { request in
            XCTAssertEqual(request.url?.path, "/v1/runs")
            XCTAssertEqual(
                URLComponents(
                    url: try XCTUnwrap(request.url),
                    resolvingAgainstBaseURL: false
                )?.queryItems,
                [
                    URLQueryItem(name: "limit", value: "2"),
                    URLQueryItem(name: "cursor", value: "opaque-page"),
                ]
            )
            XCTAssertEqual(
                request.value(forHTTPHeaderField: "Authorization"),
                "Bearer exact-clerk-token"
            )
            return (
                HTTPURLResponse(
                    url: try XCTUnwrap(request.url),
                    statusCode: 200,
                    httpVersion: nil,
                    headerFields: ["Content-Type": "application/json"]
                )!,
                Data(Self.runHistoryEnvelope.utf8)
            )
        }
        let repository = AuthenticatedTrophyWallRunHistoryRepository(
            service: RunAPIClient(
                baseURL: URL(string: "https://api.snaplist.dev")!,
                session: session
            ),
            tokenProvider: RunHistoryBearerTokenProvider(
                token: "exact-clerk-token"
            )
        )

        let page = try await repository.fetchPage(
            limit: 2,
            cursor: "opaque-page"
        )

        XCTAssertEqual(page.entries.map(\.run.id), [expectedRunID])
        XCTAssertEqual(
            page.entries.map(\.logicalIdentity),
            [TrophyWallLogicalIdentity(persistedKey: expectedLogicalKey)]
        )
        XCTAssertEqual(
            page.entries.map(\.orderKey),
            [
                TrophyWallOrderKey(
                    lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 5),
                    stableIdentity: expectedRunID.uuidString.lowercased()
                ),
            ]
        )
        XCTAssertEqual(
            page.entries.first?.run.lastMeaningfulUpdateAt,
            "1970-01-01T00:00:50.000Z"
        )
        XCTAssertEqual(page.nextCursor, "opaque-next")
    }

    func testServerLegalActionsOverrideClientStatusInference() async throws {
        let runID = UUID(uuidString: "31700000-0000-4000-8000-000000000001")!
        let session = makeSession { request in
            XCTAssertEqual(request.url?.path, "/v1/runs/\(runID.uuidString.lowercased())")
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(
                request.value(forHTTPHeaderField: "Authorization"),
                "Bearer fresh-opaque-clerk-token"
            )
            return (
                HTTPURLResponse(
                    url: try XCTUnwrap(request.url),
                    statusCode: 200,
                    httpVersion: nil,
                    headerFields: ["Content-Type": "application/json"]
                )!,
                Data(Self.runningEnvelope.utf8)
            )
        }
        let client = RunAPIClient(
            baseURL: URL(string: "https://api.snaplist.dev")!,
            session: session
        )

        let run = try await client.fetchRun(
            id: runID,
            bearerToken: "fresh-opaque-clerk-token"
        )

        XCTAssertEqual(run.id, runID)
        XCTAssertEqual(run.status, .running)
        XCTAssertFalse(run.legalActions.canCancel)
    }

    func testRunDetailDecodesCanonicalRunBoundListingReview() async throws {
        let runID = UUID(uuidString: "37600000-0000-4000-8000-000000000001")!
        let client = RunAPIClient(
            baseURL: URL(string: "https://api.snaplist.dev")!,
            session: makeSession { request in
                XCTAssertEqual(
                    request.url?.path,
                    "/v1/runs/\(runID.uuidString.lowercased())"
                )
                return (
                    HTTPURLResponse(
                        url: try XCTUnwrap(request.url),
                        statusCode: 200,
                        httpVersion: nil,
                        headerFields: ["Content-Type": "application/json"]
                    )!,
                    Data(Self.reviewEnvelope.utf8)
                )
            }
        )

        let run = try await client.fetchRun(id: runID, bearerToken: "review-token")
        let review = try XCTUnwrap(run.review)

        XCTAssertEqual(review.binding.runID, run.id)
        XCTAssertEqual(review.binding.itemID, run.itemID)
        XCTAssertEqual(review.binding.listingID, run.listingID)
        XCTAssertEqual(
            review.binding.reviewRevision,
            UUID(uuidString: "37600000-0000-4000-8000-000000000004")
        )
        XCTAssertEqual(review.photos.map(\.ordinal), [0])
        XCTAssertEqual(review.identity.label, "Sony WH-1000XM4")
        XCTAssertEqual(review.listing.condition, .veryGood)
        XCTAssertEqual(review.listing.condition.sellerLabel, "Very Good")
        XCTAssertEqual(
            review.listing.specifics,
            [
                ListingReviewSpecific(name: "Brand", value: "Sony"),
                ListingReviewSpecific(name: "Model", value: "WH-1000XM4")
            ]
        )
        XCTAssertEqual(review.pricing.suggestedPrice, 145)
        XCTAssertEqual(review.pricing.effectivePrice, 149.99)
        XCTAssertEqual(review.verifiedSoldMatches, [])
        XCTAssertEqual(review.startingPriceCopy, "Starting price estimate")
        XCTAssertEqual(
            review.soldEvidenceCopy,
            "No verified sold matches found."
        )
        XCTAssertTrue(run.legalActions.canOpenReview)
    }

    func testMalformedListingReviewContractFailsClosed() async throws {
        let runID = UUID(uuidString: "37600000-0000-4000-8000-000000000001")!
        let malformedPayloads = [
            (
                "cross-run binding",
                Self.reviewEnvelope.replacingOccurrences(
                    of: "\"binding\": {\n        \"runId\": \"37600000-0000-4000-8000-000000000001\",",
                    with: "\"binding\": {\n        \"runId\": \"37600000-0000-4000-8000-000000000099\","
                )
            ),
            (
                "incoherent effective price",
                Self.reviewEnvelope.replacingOccurrences(
                    of: #""effectivePrice": 149.99"#,
                    with: #""effectivePrice": 145"#
                )
            ),
            (
                "noncontiguous photo ordinal",
                Self.reviewEnvelope.replacingOccurrences(
                    of: #""ordinal": 0"#,
                    with: #""ordinal": 1"#
                )
            ),
            (
                "incorrect zero-match copy",
                Self.reviewEnvelope.replacingOccurrences(
                    of: "No verified sold matches found.",
                    with: "No sold evidence."
                )
            ),
            (
                "overlong listing title",
                Self.reviewEnvelope.replacingOccurrences(
                    of: "Sony WH-1000XM4 Noise-Canceling Headphones",
                    with: String(repeating: "x", count: 81)
                )
            )
        ]

        for (name, payload) in malformedPayloads {
            let client = RunAPIClient(
                baseURL: URL(string: "https://api.snaplist.dev")!,
                session: makeSession { request in
                    (
                        HTTPURLResponse(
                            url: try XCTUnwrap(request.url),
                            statusCode: 200,
                            httpVersion: nil,
                            headerFields: ["Content-Type": "application/json"]
                        )!,
                        Data(payload.utf8)
                    )
                }
            )

            do {
                _ = try await client.fetchRun(id: runID, bearerToken: "review-token")
                XCTFail("Accepted malformed Listing Review contract: \(name)")
            } catch {
                XCTAssertEqual(error as? RunAPIError, .invalidResponse, name)
            }
        }
    }

    func testRunDetailDecodesOneVerifiedSoldMatch() async throws {
        let runID = UUID(uuidString: "37600000-0000-4000-8000-000000000001")!
        let payload = Self.reviewEnvelope.replacingOccurrences(
            of: #"""
                "verifiedSoldMatches": [],
                "startingPriceCopy": "Starting price estimate",
                "soldEvidenceCopy": "No verified sold matches found."
          """#,
            with: #"""
                "verifiedSoldMatches": [
                  {
                    "id": "ebay-sold-376",
                    "sourceURL": "https://www.ebay.com/itm/376",
                    "title": "Sony WH-1000XM4 Headphones",
                    "soldPrice": 142.5,
                    "currency": "USD",
                    "condition": "Used",
                    "soldAt": 1785283200,
                    "photoURL": "https://i.ebayimg.com/images/g/376/s-l500.jpg",
                    "size": "One size",
                    "format": "buy-it-now",
                    "shipping": {
                      "type": "paid",
                      "price": 8.95,
                      "currency": "USD"
                    }
                  }
                ],
                "startingPriceCopy": "Starting price estimate",
                "soldEvidenceCopy": null
          """#
        )
        XCTAssertNotEqual(
            payload,
            Self.reviewEnvelope,
            "Positive sold-match fixture must replace the zero-match review."
        )
        let client = RunAPIClient(
            baseURL: URL(string: "https://api.snaplist.dev")!,
            session: makeSession { request in
                (
                    HTTPURLResponse(
                        url: try XCTUnwrap(request.url),
                        statusCode: 200,
                        httpVersion: nil,
                        headerFields: ["Content-Type": "application/json"]
                    )!,
                    Data(payload.utf8)
                )
            }
        )

        let run = try await client.fetchRun(id: runID, bearerToken: "review-token")
        let review = try XCTUnwrap(run.review)
        let match = try XCTUnwrap(review.verifiedSoldMatches.first)
        XCTAssertEqual(match.id, "ebay-sold-376")
        XCTAssertEqual(match.soldPrice, 142.5)
        XCTAssertEqual(
            match.photoURL,
            URL(string: "https://i.ebayimg.com/images/g/376/s-l500.jpg")
        )
        XCTAssertEqual(match.size, "One size")
        XCTAssertEqual(match.format, .buyItNow)
        XCTAssertEqual(
            match.shipping,
            .paid(price: 8.95, currency: "USD")
        )
        XCTAssertNil(review.soldEvidenceCopy)
    }

    func testRunDetailDecodesSparseVerifiedSoldMatch() async throws {
        let runID = UUID(uuidString: "37600000-0000-4000-8000-000000000001")!
        let payload = Self.reviewEnvelope.replacingOccurrences(
            of: #"""
                "verifiedSoldMatches": [],
                "startingPriceCopy": "Starting price estimate",
                "soldEvidenceCopy": "No verified sold matches found."
          """#,
            with: #"""
                "verifiedSoldMatches": [
                  {
                    "id": "ebay-sold-sparse-376",
                    "sourceURL": "https://www.ebay.com/itm/sparse-376",
                    "title": null,
                    "soldPrice": 90,
                    "currency": "USD",
                    "condition": null,
                    "soldAt": null
                  }
                ],
                "startingPriceCopy": "Starting price estimate",
                "soldEvidenceCopy": null
          """#
        )
        let client = RunAPIClient(
            baseURL: URL(string: "https://api.snaplist.dev")!,
            session: makeSession { request in
                (
                    HTTPURLResponse(
                        url: try XCTUnwrap(request.url),
                        statusCode: 200,
                        httpVersion: nil,
                        headerFields: ["Content-Type": "application/json"]
                    )!,
                    Data(payload.utf8)
                )
            }
        )

        let run = try await client.fetchRun(id: runID, bearerToken: "review-token")
        let match = try XCTUnwrap(run.review?.verifiedSoldMatches.first)
        XCTAssertEqual(match.id, "ebay-sold-sparse-376")
        XCTAssertNil(match.photoURL)
        XCTAssertNil(match.size)
        XCTAssertNil(match.format)
        XCTAssertNil(match.shipping)
    }

    func testMalformedRunContractFailsClosed() async throws {
        let runID = UUID(uuidString: "31700000-0000-4000-8000-000000000001")!
        let malformedPayloads = [
            (
                "missing required nullable listingId",
                Self.runningEnvelope.replacingOccurrences(
                    of: "\"listingId\": null,\n",
                    with: ""
                )
            ),
            (
                "unknown run property",
                Self.runningEnvelope.replacingOccurrences(
                    of: "\"itemId\":",
                    with: "\"unexpected\": true, \"itemId\":"
                )
            ),
            (
                "invalid date-time",
                Self.runningEnvelope.replacingOccurrences(
                    of: "2026-07-20T12:00:00.000Z",
                    with: "not-a-date"
                )
            ),
            (
                "negative attempt count",
                Self.runningEnvelope.replacingOccurrences(
                    of: "\"attemptCount\": 1",
                    with: "\"attemptCount\": -1"
                )
            ),
            (
                "negative photo count",
                Self.runningEnvelope.replacingOccurrences(
                    of: "\"photoCount\": 3",
                    with: "\"photoCount\": -1"
                )
            ),
            (
                "zero max attempts",
                Self.runningEnvelope.replacingOccurrences(
                    of: "\"maxAttempts\": 3",
                    with: "\"maxAttempts\": 0"
                )
            ),
            (
                "empty required title",
                Self.runningEnvelope.replacingOccurrences(
                    of: "Canon AE-1 film camera",
                    with: ""
                )
            )
        ]

        for (name, payload) in malformedPayloads {
            let client = RunAPIClient(
                baseURL: URL(string: "https://api.snaplist.dev")!,
                session: makeSession { request in
                    (
                        HTTPURLResponse(
                            url: try XCTUnwrap(request.url),
                            statusCode: 200,
                            httpVersion: nil,
                            headerFields: ["Content-Type": "application/json"]
                        )!,
                        Data(payload.utf8)
                    )
                }
            )

            do {
                _ = try await client.fetchRun(id: runID, bearerToken: "fresh-token")
                XCTFail("Accepted malformed contract: \(name)")
            } catch {
                XCTAssertEqual(error as? RunAPIError, .invalidResponse, name)
            }
        }
    }

    private func makeSession(
        handler: @escaping @Sendable (URLRequest) throws -> (HTTPURLResponse, Data)
    ) -> URLSession {
        RunURLProtocolStub.handler = handler
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RunURLProtocolStub.self]
        return URLSession(configuration: configuration)
    }

    private static let runningEnvelope = #"""
    {
      "data": {
        "id": "31700000-0000-4000-8000-000000000001",
        "itemId": "31700000-0000-4000-8000-000000000002",
        "listingId": null,
        "status": "running",
        "stage": "pricing",
        "attemptCount": 1,
        "maxAttempts": 3,
        "schemaVersion": 1,
        "timestamps": {
          "createdAt": "2026-07-20T12:00:00.000Z",
          "updatedAt": "2026-07-20T12:01:00.000Z",
          "enqueuedAt": "2026-07-20T12:00:01.000Z",
          "startedAt": "2026-07-20T12:00:02.000Z",
          "lastAttemptedAt": "2026-07-20T12:00:02.000Z",
          "nextAttemptAt": null,
          "completedAt": null,
          "retentionCleanedAt": null
        },
        "item": { "title": "Canon AE-1 film camera", "photoCount": 3 },
        "requiredInput": null,
        "terminalOutcome": null,
        "safeFailure": null,
        "allowance": "reserved",
        "legalActions": {
          "canRetry": false,
          "canCancel": false,
          "canOpenReview": false,
          "canStartNewCapture": false
        },
        "lastMeaningfulUpdateAt": "2026-07-20T12:01:00.000Z",
        "retentionCleanedAt": null
      },
      "meta": { "requestId": "req_317_running" }
    }
    """#

    private static let runHistoryEnvelope = #"""
    {
      "data": {
        "entries": [
          {
            "run": {
              "id": "37500000-0000-4000-8000-000000000031",
              "itemId": "37500000-0000-4000-8000-000000000033",
              "listingId": null,
              "status": "running",
              "stage": "pricing",
              "attemptCount": 1,
              "maxAttempts": 3,
              "schemaVersion": 1,
              "timestamps": {
                "createdAt": "1970-01-01T00:00:01.000Z",
                "updatedAt": "1970-01-01T00:00:50.000Z",
                "enqueuedAt": "1970-01-01T00:00:02.000Z",
                "startedAt": "1970-01-01T00:00:03.000Z",
                "lastAttemptedAt": "1970-01-01T00:00:04.000Z",
                "nextAttemptAt": null,
                "completedAt": null,
                "retentionCleanedAt": null
              },
              "item": { "title": "Server mutable title", "photoCount": 3 },
              "requiredInput": null,
              "terminalOutcome": null,
              "safeFailure": null,
              "allowance": "reserved",
              "legalActions": {
                "canRetry": false,
                "canCancel": false,
                "canOpenReview": false,
                "canStartNewCapture": false
              },
              "lastMeaningfulUpdateAt": "1970-01-01T00:00:50.000Z",
              "retentionCleanedAt": null
            },
            "logicalIdentity": {
              "idempotencyKey": "37500000-0000-4000-8000-000000000032"
            },
            "orderKey": {
              "lastMeaningfulUpdateAt": "1970-01-01T00:00:05.000Z",
              "runId": "37500000-0000-4000-8000-000000000031"
            }
          }
        ],
        "nextCursor": "opaque-next"
      },
      "meta": { "requestId": "req_375_history" }
    }
    """#

    private static let reviewEnvelope = #"""
    {
      "data": {
        "id": "37600000-0000-4000-8000-000000000001",
        "itemId": "37600000-0000-4000-8000-000000000002",
        "listingId": "37600000-0000-4000-8000-000000000003",
        "status": "succeeded",
        "stage": "completed",
        "attemptCount": 1,
        "maxAttempts": 3,
        "schemaVersion": 1,
        "timestamps": {
          "createdAt": "2026-07-29T12:00:00.000Z",
          "updatedAt": "2026-07-29T12:04:00.000Z",
          "enqueuedAt": "2026-07-29T12:00:01.000Z",
          "startedAt": "2026-07-29T12:00:02.000Z",
          "lastAttemptedAt": "2026-07-29T12:00:02.000Z",
          "nextAttemptAt": null,
          "completedAt": "2026-07-29T12:04:00.000Z",
          "retentionCleanedAt": null
        },
        "item": { "title": "Sony WH-1000XM4", "photoCount": 1 },
        "requiredInput": null,
        "terminalOutcome": "succeeded",
        "safeFailure": null,
        "allowance": "settled",
        "legalActions": {
          "canRetry": false,
          "canCancel": false,
          "canOpenReview": true,
          "canStartNewCapture": false
        },
        "review": {
          "schemaVersion": 1,
          "binding": {
            "runId": "37600000-0000-4000-8000-000000000001",
            "itemId": "37600000-0000-4000-8000-000000000002",
            "listingId": "37600000-0000-4000-8000-000000000003",
            "reviewRevision": "37600000-0000-4000-8000-000000000004"
          },
          "photos": [
            {
              "ordinal": 0,
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
            "condition": "very-good",
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
          "evidenceAsOf": "2026-07-29T12:03:00.000Z",
          "verifiedSoldMatches": [],
          "startingPriceCopy": "Starting price estimate",
          "soldEvidenceCopy": "No verified sold matches found."
        },
        "lastMeaningfulUpdateAt": "2026-07-29T12:04:00.000Z",
        "retentionCleanedAt": null
      },
      "meta": { "requestId": "req_376_review" }
    }
    """#
}

private struct RunHistoryBearerTokenProvider: BearerTokenProviding {
    let token: String

    func bearerToken() async throws -> String {
        token
    }
}

private final class RunURLProtocolStub: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler:
        (@Sendable (URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: RunAPIError.unavailable)
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
