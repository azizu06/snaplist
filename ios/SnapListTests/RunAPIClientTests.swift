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
