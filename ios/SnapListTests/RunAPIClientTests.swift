import Foundation
import XCTest
@testable import SnapList

final class RunAPIClientTests: XCTestCase {
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
