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

    func testDebugAppTransportAllowsOnlyValidatedLoopbackHTTPOrigins() throws {
        let transportSecurity = try XCTUnwrap(
            Bundle.main.object(
                forInfoDictionaryKey: "NSAppTransportSecurity"
            ) as? [String: Any]
        )
        XCTAssertEqual(
            transportSecurity["NSAllowsLocalNetworking"] as? Bool,
            true
        )

        let debugConfiguration = try NativeAppConfiguration.resolve(
            environment: ["SNAPLIST_API_ORIGIN": "http://127.0.0.1:3001"],
            apiOriginBundleValue: nil,
            clerkPublishableKeyBundleValue: "pk_test_fixture",
            allowsLocalDevelopment: true
        )
        XCTAssertEqual(
            debugConfiguration.apiOrigin,
            URL(string: "http://127.0.0.1:3001")
        )
        XCTAssertThrowsError(
            try NativeAppConfiguration.resolve(
                environment: [
                    "SNAPLIST_API_ORIGIN": "http://127.0.0.1:3001",
                ],
                apiOriginBundleValue: nil,
                clerkPublishableKeyBundleValue: "pk_test_fixture",
                allowsLocalDevelopment: false
            )
        ) { error in
            XCTAssertEqual(
                error as? NativeAppConfigurationError,
                .invalidAPIOrigin
            )
        }
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
            Set(ContractOnlyOperation.allCases.map(\.operationID))
        )
    }

    // MARK: Issue #524 — included-offer redemption

    func testCanonicalRedeemRequestReproducesTheServerSignedBytes() throws {
        let bytes = try IncludedOfferCanonicalRequest.redeem(
            idempotencyKey: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
            userID: "user_524"
        )

        // Byte-for-byte equality with canonicalRedemptionRequest() in
        // src/lib/included-offer-fence/contract.ts. A divergence of one
        // character changes the request hash and the assertion stops verifying.
        XCTAssertEqual(
            String(decoding: bytes, as: UTF8.self),
            #"{"action":"included-offer.redeem","idempotencyKey":"3f2504e0-4f89-41d3-9a0c-0305e82c3301","schemaVersion":1,"userId":"user_524"}"#
        )
    }

    func testCanonicalDeviceTokenRequestReproducesTheServerSignedBytes() throws {
        let bytes = try IncludedOfferCanonicalRequest.deviceToken(
            claimID: "8c7f0b16-0a4e-4d21-9c2a-6b0f4a1d5e33",
            userID: "user_524"
        )

        XCTAssertEqual(
            String(decoding: bytes, as: UTF8.self),
            #"{"action":"included-offer.device-token","claimId":"8c7f0b16-0a4e-4d21-9c2a-6b0f4a1d5e33","schemaVersion":1,"userId":"user_524"}"#
        )
    }

    func testIncludedOfferRedemptionPostsProofUnderAnIdempotencyKey() async throws {
        let recorder = MobileAPIRequestRecorder()
        let session = Self.makeSession { request in
            recorder.record(request)
            return (
                Self.jsonResponse(for: request, status: 202),
                Data(
                    #"{"data":{"claimId":"8c7f0b16-0a4e-4d21-9c2a-6b0f4a1d5e33","retryAfterMs":1500,"status":"queued"},"meta":{"requestId":"req_524"}}"#.utf8
                )
            )
        }
        let client = URLSessionMobileAPIClient(
            baseURL: URL(string: "https://api.snaplist.dev")!,
            tokenProvider: StubBearerTokenProvider(token: "bearer-524"),
            session: session
        )

        let outcome = try await client.redeemIncludedOffer(
            idempotencyKey: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
            proof: AppAttestProofPayload(
                assertionObject: "YXNzZXJ0aW9u",
                challengeId: "00000000-0000-4000-8000-000000000331",
                keyId: "native-fixed-key-id"
            )
        )

        XCTAssertEqual(
            outcome,
            .queued(
                claimID: "8c7f0b16-0a4e-4d21-9c2a-6b0f4a1d5e33",
                retryAfterMs: 1500
            )
        )
        let request = try XCTUnwrap(recorder.request)
        XCTAssertEqual(request.url?.path, "/v1/included-offer/redemptions")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(
            request.value(forHTTPHeaderField: "Idempotency-Key"),
            "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
        )
        XCTAssertEqual(
            request.value(forHTTPHeaderField: "Authorization"),
            "Bearer bearer-524"
        )
        XCTAssertEqual(
            String(decoding: Self.body(of: request), as: UTF8.self),
            #"{"appAttest":{"assertionObject":"YXNzZXJ0aW9u","challengeId":"00000000-0000-4000-8000-000000000331","keyId":"native-fixed-key-id"}}"#
        )
    }

    func testDeniedDeviceIsATypedOutcomeRatherThanATransportFailure() async throws {
        let session = Self.makeSession { request in
            (
                Self.jsonResponse(for: request, status: 409),
                Data(
                    #"{"data":{"appealPath":"support-override","claimId":"8c7f0b16-0a4e-4d21-9c2a-6b0f4a1d5e33","status":"denied_device_consumed"},"meta":{"requestId":"req_524"}}"#.utf8
                )
            )
        }
        let client = URLSessionMobileAPIClient(
            baseURL: URL(string: "https://api.snaplist.dev")!,
            tokenProvider: StubBearerTokenProvider(token: "bearer-524"),
            session: session
        )

        // 409 is the fence answering, not the network failing. Throwing here
        // would turn "this device already used the promotion, appeal to
        // support" into an unexplained error the seller cannot act on.
        let outcome = try await client.redeemIncludedOffer(
            idempotencyKey: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
            proof: Self.stubProof
        )

        XCTAssertEqual(
            outcome,
            .deniedDeviceConsumed(claimID: "8c7f0b16-0a4e-4d21-9c2a-6b0f4a1d5e33")
        )
    }

    func testUnknownRedemptionStatusFailsClosed() async {
        let session = Self.makeSession { request in
            (
                Self.jsonResponse(for: request, status: 200),
                Data(
                    #"{"data":{"claimId":"8c7f0b16-0a4e-4d21-9c2a-6b0f4a1d5e33","status":"granted"},"meta":{"requestId":"req_524"}}"#.utf8
                )
            )
        }
        let client = URLSessionMobileAPIClient(
            baseURL: URL(string: "https://api.snaplist.dev")!,
            tokenProvider: StubBearerTokenProvider(token: "bearer-524"),
            session: session
        )

        do {
            _ = try await client.redeemIncludedOffer(
                idempotencyKey: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
                proof: Self.stubProof
            )
            XCTFail("An unrecognized redemption status must not be read as a grant.")
        } catch {}
    }

    func testDeviceTokenSubmissionTargetsTheClaimItAnswers() async throws {
        let recorder = MobileAPIRequestRecorder()
        let session = Self.makeSession { request in
            recorder.record(request)
            return (
                Self.jsonResponse(for: request, status: 200),
                Data(
                    #"{"data":{"claimId":"8c7f0b16-0a4e-4d21-9c2a-6b0f4a1d5e33","status":"reserved"},"meta":{"requestId":"req_524"}}"#.utf8
                )
            )
        }
        let client = URLSessionMobileAPIClient(
            baseURL: URL(string: "https://api.snaplist.dev")!,
            tokenProvider: StubBearerTokenProvider(token: "bearer-524"),
            session: session
        )

        let outcome = try await client.submitIncludedOfferDeviceToken(
            claimID: "8c7f0b16-0a4e-4d21-9c2a-6b0f4a1d5e33",
            deviceToken: "ZGV2aWNlLXRva2Vu",
            proof: Self.stubProof
        )

        XCTAssertEqual(
            outcome,
            .reserved(claimID: "8c7f0b16-0a4e-4d21-9c2a-6b0f4a1d5e33")
        )
        let request = try XCTUnwrap(recorder.request)
        XCTAssertEqual(
            request.url?.path,
            "/v1/included-offer/redemptions/8c7f0b16-0a4e-4d21-9c2a-6b0f4a1d5e33/device-token"
        )
        XCTAssertEqual(request.httpMethod, "POST")
        // The claim is addressed by path only; the body carries proof and token.
        XCTAssertEqual(
            String(decoding: Self.body(of: request), as: UTF8.self),
            #"{"appAttest":{"assertionObject":"YXNzZXJ0aW9u","challengeId":"00000000-0000-4000-8000-000000000331","keyId":"native-fixed-key-id"},"deviceToken":"ZGV2aWNlLXRva2Vu"}"#
        )
    }

    func testClaimReadIsAPlainAuthenticatedGET() async throws {
        let recorder = MobileAPIRequestRecorder()
        let session = Self.makeSession { request in
            recorder.record(request)
            return (
                Self.jsonResponse(for: request, status: 202),
                Data(
                    #"{"data":{"claimId":"8c7f0b16-0a4e-4d21-9c2a-6b0f4a1d5e33","status":"device_token_required","tokenDeadlineAt":"2026-08-01T00:00:00.000Z"},"meta":{"requestId":"req_524"}}"#.utf8
                )
            )
        }
        let client = URLSessionMobileAPIClient(
            baseURL: URL(string: "https://api.snaplist.dev")!,
            tokenProvider: StubBearerTokenProvider(token: "bearer-524"),
            session: session
        )

        let outcome = try await client.readIncludedOfferClaim(
            claimID: "8c7f0b16-0a4e-4d21-9c2a-6b0f4a1d5e33"
        )

        XCTAssertEqual(
            outcome,
            .deviceTokenRequired(
                claimID: "8c7f0b16-0a4e-4d21-9c2a-6b0f4a1d5e33",
                tokenDeadlineAt: "2026-08-01T00:00:00.000Z"
            )
        )
        let request = try XCTUnwrap(recorder.request)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(
            request.url?.path,
            "/v1/included-offer/redemptions/8c7f0b16-0a4e-4d21-9c2a-6b0f4a1d5e33"
        )
        XCTAssertEqual(Self.body(of: request), Data())
    }

    func testRedemptionStopsBeforeTheServerWhenTheDeviceHasNoDeviceCheck() async {
        let client = IncludedOfferRedemptionStub()
        let redemption = IncludedOfferRedemption(
            attest: AppAttestProofProviderStub(),
            client: client,
            deviceCheck: DeviceCheckTokenProviderStub(isSupported: false),
            userID: "user_524"
        )

        let result = await redemption.redeem(
            idempotencyKey: "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
        )

        // A device that can never produce a DeviceCheck token can never answer
        // the rendezvous, so opening a claim would strand it. The caller routes
        // to the paid path instead of leaving the seller waiting on a promotion
        // this hardware cannot collect.
        XCTAssertEqual(result, .deviceUnsupported)
        XCTAssertEqual(client.redeemCallCount, 0)
    }

    func testRendezvousSignsTheClaimItIsAnsweringWithAFreshToken() async throws {
        let attest = AppAttestProofProviderStub()
        let client = IncludedOfferRedemptionStub(
            deviceTokenOutcome: .reserved(
                claimID: "8c7f0b16-0a4e-4d21-9c2a-6b0f4a1d5e33"
            )
        )
        let redemption = IncludedOfferRedemption(
            attest: attest,
            client: client,
            deviceCheck: DeviceCheckTokenProviderStub(
                isSupported: true,
                token: Data("device-token".utf8)
            ),
            userID: "user_524"
        )

        let result = await redemption.answerTokenRendezvous(
            claimID: "8c7f0b16-0a4e-4d21-9c2a-6b0f4a1d5e33"
        )

        XCTAssertEqual(
            result,
            .outcome(.reserved(claimID: "8c7f0b16-0a4e-4d21-9c2a-6b0f4a1d5e33"))
        )
        XCTAssertEqual(
            attest.requestBodies.map { String(decoding: $0, as: UTF8.self) },
            [
                #"{"action":"included-offer.device-token","claimId":"8c7f0b16-0a4e-4d21-9c2a-6b0f4a1d5e33","schemaVersion":1,"userId":"user_524"}"#,
            ]
        )
        XCTAssertEqual(
            client.submittedDeviceToken,
            Data("device-token".utf8).base64EncodedString()
        )
    }

    func testRendezvousWithoutAnAppleTokenNeverPostsAnEmptyAnswer() async {
        let client = IncludedOfferRedemptionStub()
        let redemption = IncludedOfferRedemption(
            attest: AppAttestProofProviderStub(),
            client: client,
            deviceCheck: DeviceCheckTokenProviderStub(
                isSupported: true,
                token: nil
            ),
            userID: "user_524"
        )

        let result = await redemption.answerTokenRendezvous(
            claimID: "8c7f0b16-0a4e-4d21-9c2a-6b0f4a1d5e33"
        )

        // The claim keeps its window and stays retryable; posting without a real
        // token would spend the rendezvous on evidence Apple never issued.
        XCTAssertEqual(result, .deviceTokenUnavailable)
        XCTAssertEqual(client.deviceTokenCallCount, 0)
    }

    func testUnprovableInstallationIsReportedRatherThanRetried() async {
        let client = IncludedOfferRedemptionStub()
        let redemption = IncludedOfferRedemption(
            attest: AppAttestProofProviderStub(
                outcome: .invalid(.missingVerifiedKey)
            ),
            client: client,
            deviceCheck: DeviceCheckTokenProviderStub(isSupported: true),
            userID: "user_524"
        )

        let result = await redemption.redeem(
            idempotencyKey: "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
        )

        XCTAssertEqual(result, .proofInvalid(.missingVerifiedKey))
        XCTAssertEqual(client.redeemCallCount, 0)
    }

    private static let stubProof = AppAttestProofPayload(
        assertionObject: "YXNzZXJ0aW9u",
        challengeId: "00000000-0000-4000-8000-000000000331",
        keyId: "native-fixed-key-id"
    )

    private static func jsonResponse(
        for request: URLRequest,
        status: Int
    ) -> HTTPURLResponse {
        HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
    }

    /// `URLProtocol` moves a request body onto `httpBodyStream`, so asserting on
    /// `httpBody` alone silently passes against an empty body.
    private static func body(of request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4_096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
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

private struct DeviceCheckTokenProviderStub: DeviceCheckTokenProviding {
    let isSupported: Bool
    var token: Data?

    func generateToken() async throws -> Data {
        guard isSupported else { throw DeviceCheckTokenError.unsupportedDevice }
        guard let token else { throw DeviceCheckTokenError.appleServiceUnavailable }
        return token
    }
}

private final class AppAttestProofProviderStub: AppAttestProofProviding, @unchecked Sendable {
    private let lock = NSLock()
    private let outcome: AppAttestProofOutcome
    private var recorded: [Data] = []

    var requestBodies: [Data] { lock.withLock { recorded } }

    init(
        outcome: AppAttestProofOutcome = .proof(AppAttestAssertionProof(
            assertionObject: Data("assertion".utf8),
            challengeID: UUID(uuidString: "00000000-0000-4000-8000-000000000331")!,
            keyID: "native-fixed-key-id"
        ))
    ) {
        self.outcome = outcome
    }

    func assertionProof(requestBody: Data) async -> AppAttestProofOutcome {
        lock.withLock { recorded.append(requestBody) }
        return outcome
    }
}

private final class IncludedOfferRedemptionStub: IncludedOfferRedeeming, @unchecked Sendable {
    private let lock = NSLock()
    private let redeemOutcome: IncludedOfferOutcome
    private let deviceTokenOutcome: IncludedOfferOutcome
    private var storedDeviceToken: String?
    private var redeemCalls = 0
    private var deviceTokenCalls = 0

    var redeemCallCount: Int { lock.withLock { redeemCalls } }
    var deviceTokenCallCount: Int { lock.withLock { deviceTokenCalls } }
    var submittedDeviceToken: String? { lock.withLock { storedDeviceToken } }

    init(
        redeemOutcome: IncludedOfferOutcome = .queued(
            claimID: "8c7f0b16-0a4e-4d21-9c2a-6b0f4a1d5e33",
            retryAfterMs: 1500
        ),
        deviceTokenOutcome: IncludedOfferOutcome = .reserved(
            claimID: "8c7f0b16-0a4e-4d21-9c2a-6b0f4a1d5e33"
        )
    ) {
        self.redeemOutcome = redeemOutcome
        self.deviceTokenOutcome = deviceTokenOutcome
    }

    func redeemIncludedOffer(
        idempotencyKey: String,
        proof: AppAttestProofPayload
    ) async throws -> IncludedOfferOutcome {
        lock.withLock { redeemCalls += 1 }
        return redeemOutcome
    }

    func readIncludedOfferClaim(claimID: String) async throws -> IncludedOfferOutcome {
        redeemOutcome
    }

    func submitIncludedOfferDeviceToken(
        claimID: String,
        deviceToken: String,
        proof: AppAttestProofPayload
    ) async throws -> IncludedOfferOutcome {
        lock.withLock {
            deviceTokenCalls += 1
            storedDeviceToken = deviceToken
        }
        return deviceTokenOutcome
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
