import Foundation
import XCTest
@testable import SnapList

/// Issue #385. The transport half, tested against the real contract in
/// `src/lib/account-erasure/http.ts` rather than against a guessed one.
///
/// The single most dangerous thing this client could do is read an HTTP status
/// as an answer. The handler returns 202 for `deletion_needs_attention` exactly
/// as it does for `deletion_in_progress`, so `2xx` says only that the request
/// was received. The durable `status` field is the answer.
final class AccountErasureClientTests: XCTestCase {
    private let idempotencyKey = "38520000-0000-4000-8000-000000000001"

    override func tearDown() {
        AccountErasureURLProtocolStub.reset()
        super.tearDown()
    }

    func testATerminalErasureCarriesTheRecordsTheServerSaidItKept() async {
        AccountErasureURLProtocolStub.responses = [
            .init(
                status: 200,
                body: envelope(
                    status: "deletion_completed_with_retained_records",
                    retainedRecords: ["ebay-live-listing"]
                )
            ),
        ]

        let outcome = await makeClient().requestErasure(
            idempotencyKey: idempotencyKey
        )

        XCTAssertEqual(outcome, .completed(retainedRecords: [.ebayLiveListing]))
        let request = AccountErasureURLProtocolStub.lastRequest
        XCTAssertEqual(request?.httpMethod, "POST")
        XCTAssertEqual(request?.url?.path, "/v1/account/erasure")
        // The handler validates this header before it authenticates, so a
        // missing or non-UUID key is a 400 that never reaches the erasure.
        XCTAssertEqual(
            request?.value(forHTTPHeaderField: "Idempotency-Key"),
            idempotencyKey
        )
        XCTAssertEqual(
            request?.value(forHTTPHeaderField: "Authorization"),
            "Bearer reverified-token"
        )
    }

    func testAnAcceptedRequestIsNeverReadAsADeletionWhateverItSays() async {
        // All three ride HTTP 202. Only the status field tells them apart, and
        // `deletion_needs_attention` is the one that must never resolve itself
        // by being asked again, because it is waiting on a person.
        let expected: [(String, AccountErasureOutcome)] = [
            ("deletion_requested", .pending),
            ("deletion_in_progress", .pending),
            ("deletion_needs_attention", .needsAttention),
        ]

        for (status, outcome) in expected {
            AccountErasureURLProtocolStub.responses = [
                .init(
                    status: 202,
                    body: envelope(
                        status: status,
                        attentionReasons: status == "deletion_needs_attention"
                            ? ["clerk-identity-deletion-unverified"]
                            : []
                    )
                ),
            ]

            let actual = await makeClient().requestErasure(
                idempotencyKey: idempotencyKey
            )

            XCTAssertEqual(actual, outcome, "status \(status)")
        }
    }

    func testTheReverificationChallengeIsAnActionableRefusalNotAFailure() async {
        // The exact body `reverificationErrorResponse("strict")` produces, from
        // @clerk/shared/dist/authorization-errors.mjs. A bare 403 is not this,
        // and must not be mistaken for it: only this one is answerable by the
        // seller confirming their identity again.
        AccountErasureURLProtocolStub.responses = [
            .init(
                status: 403,
                body: """
                {"clerk_error":{"type":"forbidden",\
                "reason":"reverification-error",\
                "metadata":{"reverification":"strict"}}}
                """
            ),
        ]

        let outcome = await makeClient().requestErasure(
            idempotencyKey: idempotencyKey
        )

        XCTAssertEqual(outcome, .notConfirmed(.reverificationRequired))
    }

    func testEveryRefusalIsReportedAsItselfAndNoneOfThemAsSuccess() async {
        let expected: [(Int, String, AccountErasureRefusal)] = [
            (
                409,
                """
                {"error":{"code":"conflict","message":"The Idempotency-Key is \
                already bound to another account erasure.","requestId":"r"}}
                """,
                .idempotencyKeyConflict
            ),
            (
                503,
                """
                {"error":{"code":"internal_error","message":"Account erasure is \
                not yet confirmed. Retry with the same key.","requestId":"r"}}
                """,
                .serverUnavailable
            ),
            (
                401,
                """
                {"error":{"code":"unauthorized","message":"Authentication is \
                required.","requestId":"r"}}
                """,
                .transport
            ),
        ]

        for (status, body, refusal) in expected {
            AccountErasureURLProtocolStub.responses = [
                .init(status: status, body: body),
            ]

            let outcome = await makeClient().requestErasure(
                idempotencyKey: idempotencyKey
            )

            XCTAssertEqual(outcome, .notConfirmed(refusal), "status \(status)")
        }
    }

    func testAConnectionThatNeverAnsweredConfirmsNothing() async {
        AccountErasureURLProtocolStub.responses = []

        let outcome = await makeClient().requestErasure(
            idempotencyKey: idempotencyKey
        )

        XCTAssertEqual(outcome, .notConfirmed(.transport))
    }

    private func makeClient() -> URLSessionAccountErasureClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AccountErasureURLProtocolStub.self]
        return URLSessionAccountErasureClient(
            apiOrigin: URL(string: "https://snaplist.dev")!,
            reverifiedBearerToken: { "reverified-token" },
            session: URLSession(configuration: configuration)
        )
    }

    private func envelope(
        status: String,
        retainedRecords: [String] = [],
        attentionReasons: [String] = []
    ) -> String {
        let records = retainedRecords.map { "\"\($0)\"" }.joined(separator: ",")
        let reasons = attentionReasons.map { "\"\($0)\"" }.joined(separator: ",")
        return """
        {"data":{"generationId":"38520000-0000-4000-8000-000000000002",\
        "status":"\(status)","retainedRecords":[\(records)],\
        "deferrals":[],"attentionReasons":[\(reasons)]},\
        "meta":{"requestId":"request-385"}}
        """
    }
}

private final class AccountErasureURLProtocolStub: URLProtocol, @unchecked Sendable {
    struct StubResponse {
        let status: Int
        let body: String
    }

    nonisolated(unsafe) static var responses: [StubResponse] = []
    nonisolated(unsafe) static var lastRequest: URLRequest?

    static func reset() {
        responses = []
        lastRequest = nil
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lastRequest = request
        guard !Self.responses.isEmpty else {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        let stub = Self.responses.removeFirst()
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: stub.status,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(stub.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
