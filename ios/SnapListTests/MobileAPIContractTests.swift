import Foundation
import XCTest
@testable import SnapList

final class MobileAPIContractTests: XCTestCase {
    func testBearerTokenProviderKeepsAbsentSessionTyped() async {
        let provider = ClerkBearerTokenProvider(
            session: StubClerkSessionToken(token: nil)
        )

        do {
            _ = try await provider.bearerToken()
            XCTFail("An absent Clerk session must not become an empty bearer.")
        } catch {
            XCTAssertEqual(
                error as? BearerTokenProviderError,
                .sessionAbsent
            )
        }
    }

    func testPrincipalBoundBearerUsesOneVerifiedClerkSession()
        async throws {
        let subject = "user_principal_a"
        let provider = ClerkBearerTokenProvider(
            session: StubClerkSessionToken(
                token: "opaque-session-bearer",
                scopeProof: ItemRunSubmissionPrincipalScopeProof(
                    verifiedClerkSubject: subject
                )
            )
        )

        let bound = try await provider.principalBoundBearer()

        XCTAssertGreaterThan(bound.bearerToken.count, 0)
        XCTAssertEqual(
            bound.scopeProof,
            ItemRunSubmissionPrincipalScopeProof(
                filesystemRoot: URL(
                    fileURLWithPath:
                        "/fixture/v1-25b0a8ae3094981f87c4359d7478da6097257500d73711ae6e58b27af12d8a75"
                )
            )
        )
        XCTAssertNotEqual(
            bound.scopeProof,
            ItemRunSubmissionPrincipalScopeProof(
                verifiedClerkSubject: "user_principal_b"
            )
        )
    }

    func testAuthenticatedMobileRequestGetsBearerFromTokenProvider() async throws {
        let recorder = MobileAPIRequestRecorder()
        let session = Self.makeSession { request in
            recorder.record(request)
            return (
                HTTPURLResponse(
                    url: request.url!,
                    statusCode: 200,
                    httpVersion: nil,
                    headerFields: ["Content-Type": "application/json"]
                )!,
                Data(
                    #"{"data":{"userId":"user_517"},"meta":{"requestId":"req_517"}}"#.utf8
                )
            )
        }
        let client = URLSessionMobileAPIClient(
            baseURL: URL(string: "https://api.snaplist.dev")!,
            tokenProvider: StubBearerTokenProvider(token: "fixed-clerk-token"),
            session: session
        )

        _ = try await client.getSession()

        XCTAssertEqual(
            recorder.request?.value(forHTTPHeaderField: "Authorization"),
            "Bearer fixed-clerk-token"
        )
    }

    func testAuthenticatedMobileRequestStopsBeforeTransportWithoutSession() async {
        let recorder = MobileAPIRequestRecorder()
        let session = Self.makeSession { request in
            recorder.record(request)
            throw MobileAPIClientError.invalidResponse
        }
        let client = URLSessionMobileAPIClient(
            baseURL: URL(string: "https://api.snaplist.dev")!,
            tokenProvider: StubBearerTokenProvider(token: nil),
            session: session
        )

        do {
            _ = try await client.getSession()
            XCTFail("A missing session must stop before transport.")
        } catch {
            XCTAssertEqual(
                error as? BearerTokenProviderError,
                .sessionAbsent
            )
        }
        XCTAssertNil(recorder.request)
    }

    func testNativeAppConfigurationRejectsUndefinedAPIOrigin() {
        XCTAssertThrowsError(
            try NativeAppConfiguration.resolve(
                environment: [:],
                apiOriginBundleValue: nil,
                clerkPublishableKeyBundleValue: "pk_test_fixture",
                allowsLocalDevelopment: false
            )
        ) { error in
            XCTAssertEqual(
                error as? NativeAppConfigurationError,
                .missingAPIOrigin
            )
        }
    }

    func testNativeAppConfigurationRejectsUndefinedClerkKey() {
        XCTAssertThrowsError(
            try NativeAppConfiguration.resolve(
                environment: [:],
                apiOriginBundleValue: "https://snaplist.dev",
                clerkPublishableKeyBundleValue: nil,
                allowsLocalDevelopment: false
            )
        ) { error in
            XCTAssertEqual(
                error as? NativeAppConfigurationError,
                .missingClerkPublishableKey
            )
        }
    }

    func testNativeAppConfigurationResolvesCheckedInBuildValues() throws {
        let configuration = try NativeAppConfiguration.resolve(
            environment: [:],
            apiOriginBundleValue: "https://snaplist.dev",
            clerkPublishableKeyBundleValue: "pk_test_checked_in_public_key",
            allowsLocalDevelopment: false
        )

        XCTAssertEqual(
            configuration.apiOrigin,
            URL(string: "https://snaplist.dev")
        )
        XCTAssertEqual(
            configuration.clerkPublishableKey,
            "pk_test_checked_in_public_key"
        )
    }

    func testZeroNetworkClientProvidesProofFixtures() async throws {
        let client = ZeroNetworkMobileAPIClient()

        let health = try await client.getHealth()
        let session = try await client.getSession()
        let configuration = try await client.getRevenueCatConfiguration()
        let entitlement = try await client.getAiItemEntitlement()

        XCTAssertEqual(health.data.apiVersion, "v1")
        XCTAssertEqual(health.data.status, "ok")
        XCTAssertEqual(session.data.userId, "fixture-clerk-user")
        XCTAssertFalse(configuration.data.configured)
        XCTAssertEqual(entitlement.data.billingSource, .included)
        XCTAssertEqual(entitlement.data.remainingItems, 1)
    }

    func testEveryContractOnlyFixtureNamesItsExistingOwnerAndNoBehavior() {
        let provider = ZeroNetworkMobileAPIClient()

        for operation in ContractOnlyOperation.allCases {
            let fixture = provider.fixture(for: operation)
            XCTAssertEqual(fixture.ownerIssue, operation.ownerIssue)
            XCTAssertEqual(
                fixture.note,
                "Schema fixture only. No server behavior or network request is executed."
            )
        }
    }

    func testMobileItemSubmissionReceiptFixtureDecodesTheExactRun() throws {
        let root = try contractResourceRoot(for: .baseV1)
        let data = try Data(contentsOf: root.appendingPathComponent(
            "mobile-item-submission-response.json"
        ))
        let envelope = try JSONDecoder().decode(
            MobileItemSubmissionEnvelope.self,
            from: data
        )

        XCTAssertEqual(
            envelope.data.runId.uuidString.lowercased(),
            "33450000-0000-4000-8000-000000000003"
        )
        XCTAssertEqual(envelope.data.status, "queued")
        XCTAssertEqual(envelope.data.photoIdentity.kind, "content_sha256_set_v1")
        XCTAssertEqual(envelope.data.photos.map(\.ordinal), [0, 1, 2, 3, 4])
    }

    func testServerEntitlementParsesPostgresDatesWithAndWithoutFractions() {
        let payload = AiItemEntitlementEnvelope.DataPayload(
            billingSource: .storeKit,
            status: .grace,
            remainingItems: 3,
            periodStart: "2026-07-01T00:00:00Z",
            periodEnd: "2026-08-01T00:00:00.000Z",
            gracePeriodEnd: "2026-08-08T00:00:00+00:00",
            transitionState: .notRequired,
            legacyStripeStatus: nil
        )

        let verified = payload.serverVerifiedSubscription

        XCTAssertNotNil(verified.periodStart)
        XCTAssertNotNil(verified.periodEnd)
        XCTAssertNotNil(verified.gracePeriodEnd)
    }

    func testSwiftOperationInventoryMatchesOpenAPIContractOnlyOperations() throws {
        let contract = try loadJSON(named: "mobile-api-v1.openapi", at: .baseV1)
        let paths = try XCTUnwrap(contract["paths"] as? [String: Any])
        var contractOnlyOperationIDs = Set<String>()

        for pathItem in paths.values {
            guard let methods = pathItem as? [String: Any] else { continue }
            for method in methods.values {
                guard let operation = method as? [String: Any],
                      operation["x-implementation-status"] as? String == "contract-only",
                      let operationID = operation["operationId"] as? String else {
                    continue
                }
                contractOnlyOperationIDs.insert(operationID)
            }
        }

        XCTAssertEqual(
            contractOnlyOperationIDs,
            Set(ContractOnlyOperation.allCases.map(\.rawValue))
        )
    }

    private static func makeSession(
        handler: @escaping @Sendable (URLRequest) throws -> (HTTPURLResponse, Data)
    ) -> URLSession {
        MobileAPIURLProtocolStub.handler = handler
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MobileAPIURLProtocolStub.self]
        return URLSession(configuration: configuration)
    }
}

private struct StubClerkSessionToken: ClerkSessionTokenProviding {
    let token: String?
    var scopeProof: ItemRunSubmissionPrincipalScopeProof? = nil

    func sessionToken() async throws -> String? { token }

    func sessionAuthentication() async throws
        -> ClerkSessionAuthentication {
        ClerkSessionAuthentication(
            token: token,
            scopeProof: scopeProof
        )
    }
}

private struct StubBearerTokenProvider: BearerTokenProviding {
    let token: String?

    func bearerToken() async throws -> String {
        guard let token else {
            throw BearerTokenProviderError.sessionAbsent
        }
        return token
    }
}

private final class MobileAPIRequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var storedRequest: URLRequest?

    var request: URLRequest? {
        lock.withLock { storedRequest }
    }

    func record(_ request: URLRequest) {
        lock.withLock {
            storedRequest = request
        }
    }
}

private final class MobileAPIURLProtocolStub: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler:
        (@Sendable (URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(
                self,
                didFailWithError: MobileAPIClientError.invalidResponse
            )
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
