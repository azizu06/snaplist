import CryptoKit
import Foundation
import XCTest
@testable import SnapList

final class AppAttestClientTests: XCTestCase {
    func testUnsupportedDeviceReturnsUnavailableWithoutGeneratingAKey() async {
        let service = AppAttestServiceStub(isSupported: false)
        let server = AppAttestServerStub()
        let client = AppAttestClient(
            appID: "TEAMID1234.dev.snaplist.ios",
            environment: .production,
            keyStore: AppAttestKeyStoreStub(),
            server: server,
            service: service
        )

        let truth = await client.attestInstallation()

        XCTAssertEqual(truth, .unavailable(.unsupportedDevice))
        XCTAssertEqual(service.generateKeyCallCount, 0)
        let challengeCallCount = await server.challengeCallCount
        XCTAssertEqual(challengeCallCount, 0)
    }

    func testVerifiedAttestationDurablyStoresTheKeyIdentifier() async throws {
        let challenge = Data("native-attestation-challenge-331".utf8)
        let service = AppAttestServiceStub(isSupported: true)
        let keyStore = AppAttestKeyStoreStub()
        let server = AppAttestServerStub(attestationChallenge: challenge)
        let client = AppAttestClient(
            appID: "TEAMID1234.dev.snaplist.ios",
            environment: .production,
            keyStore: keyStore,
            server: server,
            service: service
        )

        let truth = await client.attestInstallation()

        XCTAssertEqual(
            truth,
            .verified(.init(
                counter: 0,
                environment: .production,
                keyID: "native-fixed-key-id",
                kind: .attestation
            ))
        )
        XCTAssertEqual(
            keyStore.key,
            AppAttestStoredKey(id: "native-fixed-key-id", state: .verified)
        )
        XCTAssertEqual(
            keyStore.savedKeys,
            [
                AppAttestStoredKey(id: "native-fixed-key-id", state: .pending),
                AppAttestStoredKey(id: "native-fixed-key-id", state: .verified),
            ]
        )
        XCTAssertEqual(service.attestationHash, Data(SHA256.hash(data: challenge)))
    }

    func testGeneratedKeyIsPersistedPendingBeforeAttestationCompletes() async {
        let keyStore = AppAttestKeyStoreStub()
        let client = AppAttestClient(
            appID: "TEAMID1234.dev.snaplist.ios",
            environment: .production,
            keyStore: keyStore,
            server: AppAttestServerStub(),
            service: AppAttestServiceStub(
                isSupported: true,
                attestationError: AppAttestServiceStubError.appleRejected
            )
        )

        let truth = await client.attestInstallation()

        XCTAssertEqual(truth, .invalid(.appleRejected))
        XCTAssertEqual(
            keyStore.key,
            AppAttestStoredKey(id: "native-fixed-key-id", state: .pending)
        )
        XCTAssertEqual(
            keyStore.savedKeys,
            [AppAttestStoredKey(id: "native-fixed-key-id", state: .pending)]
        )
    }

    func testPersistedKeyRequiresFreshServerVerifiedAssertion() async {
        let keyStore = AppAttestKeyStoreStub(
            key: .init(id: "native-fixed-key-id", state: .pending)
        )
        let service = AppAttestServiceStub(isSupported: true)
        let server = AppAttestServerStub(
            assertionChallenge: Data("native-restoration-challenge-331".utf8)
        )
        let client = AppAttestClient(
            appID: "TEAMID1234.dev.snaplist.ios",
            environment: .production,
            keyStore: keyStore,
            server: server,
            service: service
        )

        let truth = await client.attestInstallation()

        XCTAssertEqual(
            truth,
            .verified(.init(
                counter: 1,
                environment: .production,
                keyID: "native-fixed-key-id",
                kind: .assertion
            ))
        )
        XCTAssertEqual(service.generateKeyCallCount, 0)
        XCTAssertEqual(
            keyStore.key,
            AppAttestStoredKey(id: "native-fixed-key-id", state: .verified)
        )
        XCTAssertNotNil(service.assertionHash)
        let challengeCallCount = await server.challengeCallCount
        let verificationCallCount = await server.assertionVerificationCallCount
        let requestBody = await server.assertionRequestBody
        XCTAssertEqual(challengeCallCount, 1)
        XCTAssertEqual(verificationCallCount, 1)
        XCTAssertEqual(
            requestBody,
            Data(#"{"operation":"restore-app-attest-key"}"#.utf8)
        )
    }

    func testPersistedKeyRejectedByServerNeverReportsVerified() async {
        let keyStore = AppAttestKeyStoreStub(
            key: .init(id: "server-missing-key-id", state: .pending)
        )
        let service = AppAttestServiceStub(isSupported: true)
        let server = AppAttestServerStub(
            assertionTruth: .invalid(.serverRejected)
        )
        let client = AppAttestClient(
            appID: "TEAMID1234.dev.snaplist.ios",
            environment: .production,
            keyStore: keyStore,
            server: server,
            service: service
        )

        let truth = await client.attestInstallation()

        XCTAssertEqual(truth, .invalid(.serverRejected))
        let verificationCallCount = await server.assertionVerificationCallCount
        XCTAssertEqual(verificationCallCount, 1)
        XCTAssertEqual(service.generateKeyCallCount, 0)
        XCTAssertEqual(keyStore.removeCallCount, 0)
        XCTAssertEqual(
            keyStore.key,
            AppAttestStoredKey(id: "server-missing-key-id", state: .pending)
        )
    }

    func testPersistedKeyNotAttestedReenrollsOnceBeforeReportingVerified() async {
        AppAttestURLProtocolStub.responses = [
            .init(
                body: #"{"data":{"challenge":"cGVuZGluZy1hc3NlcnRpb24tY2hhbGxlbmdlLTMzMQ","challengeId":"00000000-0000-4000-8000-000000000331","expiresAt":"2026-07-20T20:05:00.000Z","kind":"assertion"}}"#,
                status: 200
            ),
            .init(
                body: #"{"data":{"code":"key_not_attested","kind":"assertion","status":"invalid"}}"#,
                status: 401
            ),
            .init(
                body: #"{"data":{"challenge":"ZnJlc2gtYXR0ZXN0YXRpb24tY2hhbGxlbmdlLTMzMQ","challengeId":"00000000-0000-4000-8000-000000000332","expiresAt":"2026-07-20T20:05:00.000Z","kind":"attestation"}}"#,
                status: 200
            ),
            .init(
                body: #"{"data":{"counter":0,"environment":"production","keyId":"native-fixed-key-id","kind":"attestation","status":"verified"}}"#,
                status: 200
            ),
        ]
        let keyStore = AppAttestKeyStoreStub(
            key: .init(id: "server-missing-key-id", state: .pending)
        )
        let service = AppAttestServiceStub(isSupported: true)
        let client = AppAttestClient(
            appID: "TEAMID1234.dev.snaplist.ios",
            environment: .production,
            keyStore: keyStore,
            server: makeURLSessionServerClient(),
            service: service
        )

        let truth = await client.attestInstallation()

        XCTAssertEqual(
            truth,
            .verified(.init(
                counter: 0,
                environment: .production,
                keyID: "native-fixed-key-id",
                kind: .attestation
            ))
        )
        XCTAssertEqual(service.generateKeyCallCount, 1)
        XCTAssertEqual(keyStore.removeCallCount, 1)
        XCTAssertEqual(
            keyStore.key,
            AppAttestStoredKey(id: "native-fixed-key-id", state: .verified)
        )
        XCTAssertTrue(AppAttestURLProtocolStub.responses.isEmpty)
    }

    func testPersistedStaleDeviceKeyReenrollsOnceBeforeReportingVerified() async {
        let server = AppAttestServerStub()
        let keyStore = AppAttestKeyStoreStub(
            key: .init(id: "stale-device-key-id", state: .verified)
        )
        let service = AppAttestServiceStub(
            isSupported: true,
            assertionError: AppAttestServiceError.staleKey
        )
        let client = AppAttestClient(
            appID: "TEAMID1234.dev.snaplist.ios",
            environment: .production,
            keyStore: keyStore,
            server: server,
            service: service
        )

        let truth = await client.attestInstallation()

        XCTAssertEqual(
            truth,
            .verified(.init(
                counter: 0,
                environment: .production,
                keyID: "native-fixed-key-id",
                kind: .attestation
            ))
        )
        XCTAssertEqual(service.generateKeyCallCount, 1)
        XCTAssertEqual(keyStore.removeCallCount, 1)
        let verificationCallCount = await server.assertionVerificationCallCount
        XCTAssertEqual(verificationCallCount, 0)
    }

    func testAssertionUsesTheRequestBoundCanonicalClientDataHash() async throws {
        let keyStore = AppAttestKeyStoreStub(
            key: .init(id: "native-fixed-key-id", state: .verified)
        )
        let service = AppAttestServiceStub(isSupported: true)
        let server = AppAttestServerStub(
            assertionChallenge: Data("native-assertion-challenge-331".utf8)
        )
        let client = AppAttestClient(
            appID: "TEAMID1234.dev.snaplist.ios",
            environment: .production,
            keyStore: keyStore,
            server: server,
            service: service
        )

        let truth = await client.assert(requestBody: Data(#"{"operation":"proof"}"#.utf8))

        XCTAssertEqual(
            truth,
            .verified(.init(
                counter: 1,
                environment: .production,
                keyID: "native-fixed-key-id",
                kind: .assertion
            ))
        )
        XCTAssertEqual(
            service.assertionHash,
            Data(base64Encoded: "+kWTITVHsimAkim9lYKODAtAPDjjYgMOImIGSUAWqFk=")
        )
    }

    func testTypedServerUnavailableResponseDoesNotRotatePersistedKey() async {
        AppAttestURLProtocolStub.responses = [
            .init(
                body: #"{"data":{"code":"service_unavailable","status":"unavailable"}}"#,
                status: 503
            ),
        ]
        let keyStore = AppAttestKeyStoreStub(
            key: .init(id: "native-fixed-key-id", state: .pending)
        )
        let service = AppAttestServiceStub(isSupported: true)
        let client = AppAttestClient(
            appID: "TEAMID1234.dev.snaplist.ios",
            environment: .production,
            keyStore: keyStore,
            server: makeURLSessionServerClient(),
            service: service
        )

        let truth = await client.attestInstallation()

        XCTAssertEqual(truth, .unavailable(.serverUnavailable))
        XCTAssertEqual(service.generateKeyCallCount, 0)
        XCTAssertEqual(keyStore.removeCallCount, 0)
        XCTAssertEqual(
            keyStore.key,
            AppAttestStoredKey(id: "native-fixed-key-id", state: .pending)
        )
    }

    func testGenericServerFailureDoesNotRotatePersistedKey() async {
        AppAttestURLProtocolStub.responses = [
            .init(body: "upstream failure", status: 500),
        ]
        let keyStore = AppAttestKeyStoreStub(
            key: .init(id: "native-fixed-key-id", state: .pending)
        )
        let service = AppAttestServiceStub(isSupported: true)
        let client = AppAttestClient(
            appID: "TEAMID1234.dev.snaplist.ios",
            environment: .production,
            keyStore: keyStore,
            server: makeURLSessionServerClient(),
            service: service
        )

        let truth = await client.attestInstallation()

        XCTAssertEqual(truth, .unavailable(.serverUnavailable))
        XCTAssertEqual(service.generateKeyCallCount, 0)
        XCTAssertEqual(keyStore.removeCallCount, 0)
        XCTAssertEqual(
            keyStore.key,
            AppAttestStoredKey(id: "native-fixed-key-id", state: .pending)
        )
    }

    func testTypedServerInvalidResponseMapsToServerRejected() async throws {
        AppAttestURLProtocolStub.responses = [
            .init(
                body: #"{"data":{"code":"invalid_evidence","kind":"assertion","status":"invalid"}}"#,
                status: 401
            ),
        ]
        let server = makeURLSessionServerClient()

        let truth = try await server.verifyAssertion(
            challengeID: UUID(uuidString: "00000000-0000-4000-8000-000000000331")!,
            keyID: "native-fixed-key-id",
            assertionObject: Data("fixed-assertion".utf8),
            requestBody: Data(#"{"operation":"proof"}"#.utf8)
        )

        XCTAssertEqual(truth, .invalid(.serverRejected))
    }

    // MARK: Issue #727 — the guest capability issued with a verified assertion

    func testVerifiedAssertionRetainsTheServerIssuedGuestCapability() async throws {
        AppAttestURLProtocolStub.responses = [
            .init(
                body: #"{"data":{"counter":7,"environment":"production","guestCapability":{"bearerToken":"guestcap_opaque","expiresAt":"2026-07-28T15:30:00.000Z","refreshAfter":"2026-07-28T15:25:00.000Z"},"keyId":"native-fixed-key-id","kind":"assertion","status":"verified"}}"#,
                status: 200
            ),
        ]

        let truth = try await makeURLSessionServerClient().verifyAssertion(
            challengeID: UUID(uuidString: "00000000-0000-4000-8000-000000000331")!,
            keyID: "native-fixed-key-id",
            assertionObject: Data("fixed-assertion".utf8),
            requestBody: Data(#"{"operation":"proof"}"#.utf8)
        )

        XCTAssertEqual(
            truth,
            .verified(.init(
                counter: 7,
                environment: .production,
                guestCapability: GuestCapabilityBearer(
                    expiresAt: Date(timeIntervalSince1970: 1_785_252_600),
                    token: "guestcap_opaque"
                ),
                keyID: "native-fixed-key-id",
                kind: .assertion
            ))
        )
    }

    func testVerifiedAssertionWithoutAUsableGuestCapabilityFailsTheDecode() async {
        let bodies = [
            // The server issues a capability with every verified assertion. A response
            // missing one is not a seller without a credential; it is a response this
            // client cannot read, and a silent success would strand Start listing.
            #"{"data":{"counter":7,"environment":"production","keyId":"native-fixed-key-id","kind":"assertion","status":"verified"}}"#,
            #"{"data":{"counter":7,"environment":"production","guestCapability":{"bearerToken":"   ","expiresAt":"2026-07-28T15:30:00.000Z"},"keyId":"native-fixed-key-id","kind":"assertion","status":"verified"}}"#,
            #"{"data":{"counter":7,"environment":"production","guestCapability":{"bearerToken":"guestcap_opaque","expiresAt":"the end of the week"},"keyId":"native-fixed-key-id","kind":"assertion","status":"verified"}}"#,
            #"{"data":{"counter":7,"environment":"production","guestCapability":{"bearerToken":7,"expiresAt":"2026-07-28T15:30:00.000Z"},"keyId":"native-fixed-key-id","kind":"assertion","status":"verified"}}"#,
        ]

        for body in bodies {
            AppAttestURLProtocolStub.responses = [.init(body: body, status: 200)]
            do {
                _ = try await makeURLSessionServerClient().verifyAssertion(
                    challengeID: UUID(uuidString: "00000000-0000-4000-8000-000000000331")!,
                    keyID: "native-fixed-key-id",
                    assertionObject: Data("fixed-assertion".utf8),
                    requestBody: Data(#"{"operation":"proof"}"#.utf8)
                )
                XCTFail("Expected an invalid response for \(body)")
            } catch AppAttestServerClientError.invalidResponse {
                continue
            } catch {
                XCTFail("Expected an invalid response for \(body), got \(error)")
            }
        }
    }

    func testVerifiedAttestationDecodesWithoutAGuestCapability() async throws {
        AppAttestURLProtocolStub.responses = [
            .init(
                body: #"{"data":{"counter":0,"environment":"production","keyId":"native-fixed-key-id","kind":"attestation","status":"verified"}}"#,
                status: 200
            ),
        ]

        let truth = try await makeURLSessionServerClient().verifyAttestation(
            challengeID: UUID(uuidString: "00000000-0000-4000-8000-000000000332")!,
            keyID: "native-fixed-key-id",
            attestationObject: Data("fixed-attestation".utf8)
        )

        XCTAssertEqual(
            truth,
            .verified(.init(
                counter: 0,
                environment: .production,
                keyID: "native-fixed-key-id",
                kind: .attestation
            ))
        )
    }

    func testVerifiedAssertionPersistsTheGuestCapabilityForLaterSubmission() async {
        let bearer = GuestCapabilityBearer(
            expiresAt: Date(timeIntervalSince1970: 1_785_252_600),
            token: "guestcap_opaque"
        )
        let bearerStore = GuestCapabilityBearerStoreStub()
        let client = AppAttestClient(
            appID: "TEAMID1234.dev.snaplist.ios",
            environment: .production,
            guestCapabilityStore: bearerStore,
            keyStore: AppAttestKeyStoreStub(
                key: .init(id: "native-fixed-key-id", state: .verified)
            ),
            server: AppAttestServerStub(
                assertionTruth: .verified(.init(
                    counter: 1,
                    environment: .production,
                    guestCapability: bearer,
                    keyID: "native-fixed-key-id",
                    kind: .assertion
                ))
            ),
            service: AppAttestServiceStub(isSupported: true)
        )

        _ = await client.assert(requestBody: Data(#"{"operation":"proof"}"#.utf8))

        XCTAssertEqual(bearerStore.saved, [bearer])
    }

    func testRejectedAssertionPersistsNoGuestCapability() async {
        let bearerStore = GuestCapabilityBearerStoreStub()
        let client = AppAttestClient(
            appID: "TEAMID1234.dev.snaplist.ios",
            environment: .production,
            guestCapabilityStore: bearerStore,
            keyStore: AppAttestKeyStoreStub(
                key: .init(id: "native-fixed-key-id", state: .verified)
            ),
            server: AppAttestServerStub(assertionTruth: .invalid(.serverRejected)),
            service: AppAttestServiceStub(isSupported: true)
        )

        _ = await client.assert(requestBody: Data(#"{"operation":"proof"}"#.utf8))

        XCTAssertEqual(bearerStore.saved, [])
    }

    // MARK: Issue #524 — proof for the included-offer redemption endpoints

    func testRedemptionProofLeavesTheChallengeForTheRedemptionEndpoint() async throws {
        let service = AppAttestServiceStub(isSupported: true)
        let server = AppAttestServerStub()
        let client = AppAttestClient(
            appID: "TEAMID1234.dev.snaplist.ios",
            environment: .production,
            keyStore: AppAttestKeyStoreStub(
                key: .init(id: "native-fixed-key-id", state: .verified)
            ),
            server: server,
            service: service
        )

        let outcome = await client.assertionProof(
            requestBody: Data(#"{"action":"included-offer.redeem"}"#.utf8)
        )

        XCTAssertEqual(
            outcome,
            .proof(AppAttestAssertionProof(
                assertionObject: Data("fixed-assertion".utf8),
                challengeID: UUID(uuidString: "00000000-0000-4000-8000-000000000331")!,
                keyID: "native-fixed-key-id"
            ))
        )
        // The redemption endpoint spends this challenge itself. Verifying here
        // would retire it first and leave the redemption holding dead evidence.
        let verificationCallCount = await server.assertionVerificationCallCount
        XCTAssertEqual(verificationCallCount, 0)
        let challengeCallCount = await server.challengeCallCount
        XCTAssertEqual(challengeCallCount, 1)
    }

    func testRedemptionProofNeedsAVerifiedKeyBeforeReachingApple() async {
        let service = AppAttestServiceStub(isSupported: true)
        let client = AppAttestClient(
            appID: "TEAMID1234.dev.snaplist.ios",
            environment: .production,
            keyStore: AppAttestKeyStoreStub(
                key: .init(id: "native-fixed-key-id", state: .pending)
            ),
            server: AppAttestServerStub(),
            service: service
        )

        let outcome = await client.assertionProof(requestBody: Data("{}".utf8))

        XCTAssertEqual(outcome, .invalid(.missingVerifiedKey))
        XCTAssertNil(service.assertionHash)
    }

    func testRedemptionProofIsUnavailableWhereAppAttestIsUnsupported() async {
        let client = AppAttestClient(
            appID: "TEAMID1234.dev.snaplist.ios",
            environment: .production,
            keyStore: AppAttestKeyStoreStub(
                key: .init(id: "native-fixed-key-id", state: .verified)
            ),
            server: AppAttestServerStub(),
            service: AppAttestServiceStub(isSupported: false)
        )

        let outcome = await client.assertionProof(requestBody: Data("{}".utf8))

        XCTAssertEqual(outcome, .unavailable(.unsupportedDevice))
    }

    private func makeURLSessionServerClient() -> URLSessionAppAttestServerClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AppAttestURLProtocolStub.self]
        return URLSessionAppAttestServerClient(
            apiOrigin: URL(string: "https://snaplist.dev")!,
            session: URLSession(configuration: configuration)
        )
    }
}

private final class AppAttestURLProtocolStub: URLProtocol, @unchecked Sendable {
    struct StubResponse {
        let body: String
        let status: Int
    }

    nonisolated(unsafe) static var responses: [StubResponse] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard !Self.responses.isEmpty else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
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

private final class AppAttestServiceStub: AppAttestServicing, @unchecked Sendable {
    let isSupported: Bool
    private let assertionError: Error?
    private let attestationError: Error?
    private(set) var assertionHash: Data?
    private(set) var attestationHash: Data?
    private(set) var generateKeyCallCount = 0

    init(
        isSupported: Bool,
        assertionError: Error? = nil,
        attestationError: Error? = nil
    ) {
        self.isSupported = isSupported
        self.assertionError = assertionError
        self.attestationError = attestationError
    }

    func generateKey() async throws -> String {
        generateKeyCallCount += 1
        return "native-fixed-key-id"
    }

    func attestKey(_ keyID: String, clientDataHash: Data) async throws -> Data {
        if let attestationError { throw attestationError }
        attestationHash = clientDataHash
        return Data("fixed-attestation".utf8)
    }

    func generateAssertion(_ keyID: String, clientDataHash: Data) async throws -> Data {
        if let assertionError { throw assertionError }
        assertionHash = clientDataHash
        return Data("fixed-assertion".utf8)
    }
}

private enum AppAttestServiceStubError: Error {
    case appleRejected
}

private final class AppAttestKeyStoreStub: AppAttestKeyIDStoring, @unchecked Sendable {
    var key: AppAttestStoredKey?
    private(set) var removeCallCount = 0
    private(set) var savedKeys: [AppAttestStoredKey] = []

    init(key: AppAttestStoredKey? = nil) {
        self.key = key
    }

    func load() throws -> AppAttestStoredKey? { key }
    func save(_ key: AppAttestStoredKey) throws {
        self.key = key
        savedKeys.append(key)
    }
    func remove() throws {
        key = nil
        removeCallCount += 1
    }
}

private final class GuestCapabilityBearerStoreStub: GuestCapabilityBearerStoring,
    @unchecked Sendable {
    private(set) var saved: [GuestCapabilityBearer] = []
    var bearer: GuestCapabilityBearer?

    func load() throws -> GuestCapabilityBearer? { bearer }

    func save(_ bearer: GuestCapabilityBearer) throws {
        self.bearer = bearer
        saved.append(bearer)
    }

    func remove() throws {
        bearer = nil
    }
}

private actor AppAttestServerStub: AppAttestServerClient {
    private(set) var assertionRequestBody: Data?
    private(set) var assertionVerificationCallCount = 0
    private(set) var challengeCallCount = 0
    private let assertionChallenge: Data
    private let assertionTruth: AppAttestTruth
    private let attestationChallenge: Data

    init(
        assertionChallenge: Data = Data("assertion-challenge".utf8),
        assertionTruth: AppAttestTruth = .verified(.init(
            counter: 1,
            environment: .production,
            keyID: "native-fixed-key-id",
            kind: .assertion
        )),
        attestationChallenge: Data = Data("attestation-challenge".utf8)
    ) {
        self.assertionChallenge = assertionChallenge
        self.assertionTruth = assertionTruth
        self.attestationChallenge = attestationChallenge
    }

    func issueChallenge(kind: AppAttestChallenge.Kind, keyID: String?) async throws -> AppAttestChallenge {
        challengeCallCount += 1
        return AppAttestChallenge(
            bytes: kind == .attestation ? attestationChallenge : assertionChallenge,
            expiresAt: Date(timeIntervalSince1970: 1_800_000_300),
            id: UUID(uuidString: "00000000-0000-4000-8000-000000000331")!,
            kind: kind
        )
    }

    func verifyAttestation(
        challengeID: UUID,
        keyID: String,
        attestationObject: Data
    ) async throws -> AppAttestTruth {
        .verified(.init(counter: 0, environment: .production, keyID: keyID, kind: .attestation))
    }

    func verifyAssertion(
        challengeID: UUID,
        keyID: String,
        assertionObject: Data,
        requestBody: Data
    ) async throws -> AppAttestTruth {
        assertionVerificationCallCount += 1
        assertionRequestBody = requestBody
        return assertionTruth
    }
}
