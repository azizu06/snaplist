import Foundation
import XCTest
@testable import SnapList

final class ItemRunSubmissionClientTests: XCTestCase {
    func testSendsTheMultipartBodyWithTheKeyAndAFreshBearer() async throws {
        let payload = Self.payload(photoCount: 3)
        var observed: URLRequest?
        let session = makeSession { request in
            observed = request
            return (Self.response(200, for: request), Data(Self.receiptJSON.utf8))
        }
        let client = ItemRunSubmissionClient(
            baseURL: URL(string: "https://api.snaplist.dev")!,
            session: session,
            boundary: { "snaplist-boundary" }
        )

        _ = await client.submit(payload, bearerToken: "fresh-opaque-clerk-token")

        let request = try XCTUnwrap(observed)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/v1/items/runs")
        XCTAssertEqual(
            request.value(forHTTPHeaderField: "Idempotency-Key"),
            payload.attempt.idempotencyKey.uuidString.lowercased()
        )
        XCTAssertEqual(
            request.value(forHTTPHeaderField: "Content-Type"),
            "multipart/form-data; boundary=snaplist-boundary"
        )
        // The token here is a fixture literal rather than a credential, so the header is
        // compared whole. A prefix and a length would also pass for any other token of
        // the same size, which is not what the criterion asks for.
        XCTAssertEqual(
            request.value(forHTTPHeaderField: "Authorization"),
            "Bearer fresh-opaque-clerk-token"
        )
        // URLSession hands the body to the protocol as a stream, so this is the only
        // place a test can prove the parts actually left the client.
        XCTAssertEqual(
            try Self.bodyBytes(of: request),
            ItemRunSubmissionMultipart.body(
                for: payload,
                boundary: "snaplist-boundary"
            )
        )
    }

    private static func bodyBytes(of request: URLRequest) throws -> Data {
        if let body = request.httpBody {
            return body
        }
        let stream = try XCTUnwrap(request.httpBodyStream)
        stream.open()
        defer { stream.close() }
        var body = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            guard read > 0 else { break }
            body.append(contentsOf: buffer[0..<read])
        }
        return body
    }

    func testMultipartBodyRepeatsThePhotoFieldInDisplayedOrder() throws {
        let payload = Self.payload(photoCount: 3)

        let body = ItemRunSubmissionMultipart.body(
            for: payload,
            boundary: "snaplist-boundary"
        )

        let text = try XCTUnwrap(String(data: body, encoding: .isoLatin1))
        XCTAssertEqual(
            text.components(separatedBy: "name=\"photo\"").count - 1,
            3
        )
        XCTAssertFalse(text.contains("name=\"costBasis\""))
        for (ordinal, data) in payload.photoData.enumerated() {
            let marker = try XCTUnwrap(String(data: data, encoding: .isoLatin1))
            XCTAssertTrue(text.contains(marker), "photo \(ordinal) bytes are missing")
        }
        let orderedMarkers = try payload.photoData.compactMap { data in
            try text.range(
                of: XCTUnwrap(String(data: data, encoding: .isoLatin1))
            )?.lowerBound
        }
        XCTAssertEqual(orderedMarkers, orderedMarkers.sorted())
        XCTAssertTrue(text.hasSuffix("--snaplist-boundary--\r\n"))
    }

    func testStatusCodesMapToTheirTypedOutcome() async throws {
        let expectations: [(Int, String, ItemRunSubmissionTransportOutcome)] = [
            (202, Self.receiptJSON, .created(Self.expectedReceipt)),
            (200, Self.receiptJSON, .replayed(Self.expectedReceipt)),
            (400, Self.errorJSON(code: "invalid_request"), .rejected),
            (401, Self.errorJSON(code: "unauthorized"), .authenticationRequired),
            (
                403,
                Self.errorJSON(code: "forbidden", reason: "allowance_exhausted"),
                .creditDenied(reason: "allowance_exhausted")
            ),
            (409, Self.errorJSON(code: "conflict"), .conflict),
            (
                429,
                Self.errorJSON(code: "rate_limited", reason: "daily_capacity"),
                .rateLimited(reason: "daily_capacity")
            ),
            (503, Self.errorJSON(code: "internal_error"), .ambiguous),
            (500, Self.errorJSON(code: "internal_error"), .ambiguous),
            (202, "{ not json", .ambiguous)
        ]

        for (statusCode, body, expected) in expectations {
            let session = makeSession { request in
                (Self.response(statusCode, for: request), Data(body.utf8))
            }
            let client = ItemRunSubmissionClient(
                baseURL: URL(string: "https://api.snaplist.dev")!,
                session: session,
                boundary: { "snaplist-boundary" }
            )

            let outcome = await client.submit(
                Self.payload(photoCount: 1),
                bearerToken: "fresh-opaque-clerk-token"
            )

            XCTAssertEqual(outcome, expected, "status \(statusCode)")
        }
    }

    /// Offline and cancellation are both named by the criterion, and both have to leave
    /// the submission retryable rather than looking like the server refused it.
    func testTransportFailureIsAmbiguousRatherThanARejection() async {
        for failure in [
            URLError(.notConnectedToInternet),
            URLError(.cancelled),
            URLError(.timedOut)
        ] {
            let session = makeSession { _ in
                throw failure
            }
            let client = ItemRunSubmissionClient(
                baseURL: URL(string: "https://api.snaplist.dev")!,
                session: session,
                boundary: { "snaplist-boundary" }
            )

            let outcome = await client.submit(
                Self.payload(photoCount: 2),
                bearerToken: "fresh-opaque-clerk-token"
            )

            XCTAssertEqual(outcome, .ambiguous, "\(failure.code) was not retryable")
        }
    }

    // MARK: Helpers

    private func makeSession(
        handler: @escaping @Sendable (URLRequest) throws -> (HTTPURLResponse, Data)
    ) -> URLSession {
        ItemRunSubmissionURLProtocolStub.handler = handler
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ItemRunSubmissionURLProtocolStub.self]
        return URLSession(configuration: configuration)
    }

    private static func response(
        _ statusCode: Int,
        for request: URLRequest
    ) -> HTTPURLResponse {
        HTTPURLResponse(
            url: request.url!,
            statusCode: statusCode,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
    }

    private static func payload(photoCount: Int) -> ItemRunSubmissionPayload {
        let photoData = (0..<photoCount).map { index in
            var data = Data([0xFF, 0xD8, 0xFF])
            data.append(Data("PHOTOBYTES\(index)".utf8))
            return data
        }
        return ItemRunSubmissionPayload(
            attempt: ItemRunSubmissionAttempt(
                idempotencyKey: UUID(
                    uuidString: "45700000-0000-4000-8000-000000000001"
                )!,
                photos: photoData.enumerated().map { ordinal, data in
                    ItemRunSubmissionPhoto(
                        photoID: UUID(),
                        ordinal: ordinal,
                        contentSha256: LocalPhotoFingerprint.digest(of: data),
                        byteLength: data.count,
                        mediaType: .jpeg
                    )
                }
            ),
            photoData: photoData
        )
    }

    private static let expectedReceipt = MobileItemSubmissionEnvelope.DataPayload(
        itemId: UUID(uuidString: "33450000-0000-4000-8000-000000000002")!,
        runId: UUID(uuidString: "33450000-0000-4000-8000-000000000003")!,
        status: "queued",
        stage: "queued",
        photoIdentity: .init(
            kind: "content_sha256_set_v1",
            fingerprint: String(repeating: "6", count: 64)
        ),
        photos: [
            .init(
                ordinal: 0,
                contentSha256: String(repeating: "b", count: 64),
                byteLength: 4,
                mediaType: "image/jpeg"
            )
        ]
    )

    private static let receiptJSON = #"""
    {
      "data": {
        "itemId": "33450000-0000-4000-8000-000000000002",
        "runId": "33450000-0000-4000-8000-000000000003",
        "status": "queued",
        "stage": "queued",
        "photoIdentity": {
          "kind": "content_sha256_set_v1",
          "fingerprint": "6666666666666666666666666666666666666666666666666666666666666666"
        },
        "photos": [
          {
            "ordinal": 0,
            "contentSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "byteLength": 4,
            "mediaType": "image/jpeg"
          }
        ]
      },
      "meta": { "requestId": "req_test" }
    }
    """#

    private static func errorJSON(code: String, reason: String? = nil) -> String {
        let details = reason.map { #", "details": { "reason": "\#($0)" }"# } ?? ""
        return #"""
        { "error": { "code": "\#(code)", "message": "m", "requestId": "r"\#(details) } }
        """#
    }
}

final class ItemRunSubmissionURLProtocolStub: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler:
        (@Sendable (URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

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

    override func stopLoading() {}
}
