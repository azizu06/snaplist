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
            clientData: Data(#"{"operation":"proof-client-data"}"#.utf8),
            keyID: "native-fixed-key-id",
            assertionObject: Data("fixed-assertion".utf8),
            requestBody: Data(#"{"operation":"proof"}"#.utf8)
        )

        XCTAssertEqual(truth, .invalid(.serverRejected))
    }

    func testAssertionRequestCarriesTheExactClientDataBytesSignedByAppAttest() async throws {
        AppAttestURLProtocolStub.lastRequestBody = nil
        AppAttestURLProtocolStub.responses = [
            .init(
                body: #"{"data":{"code":"invalid_evidence","kind":"assertion","status":"invalid"}}"#,
                status: 401
            ),
        ]
        let clientData = Data(#"{"exact":"signature-bound bytes"}"#.utf8)

        _ = try await makeURLSessionServerClient().verifyAssertion(
            challengeID: UUID(uuidString: "00000000-0000-4000-8000-000000000331")!,
            clientData: clientData,
            keyID: "native-fixed-key-id",
            assertionObject: Data("fixed-assertion".utf8),
            requestBody: Data(#"{"operation":"proof"}"#.utf8)
        )

        let body = try XCTUnwrap(AppAttestURLProtocolStub.lastRequestBody)
        let payload = try XCTUnwrap(
            JSONSerialization.jsonObject(with: body) as? [String: Any]
        )
        XCTAssertEqual(payload["clientData"] as? String, clientData.base64EncodedString())
    }

    // MARK: Issue #733 — launch enrollment earns the guest capability

    func testFirstLaunchAttestsThenAssertsToEarnGuestCapability() async {
        let bearer = GuestCapabilityBearer(
            expiresAt: Date(timeIntervalSince1970: 1_785_252_600),
            token: "guestcap_\(String(repeating: "A", count: 43))"
        )
        let fixture = makeEnrollmentFixture(bearer: bearer)

        let outcome = await fixture.enrollment.enrollIfNeeded()

        XCTAssertEqual(outcome, .ready)
        XCTAssertEqual(fixture.service.generateKeyCallCount, 1)
        assertSavedGuestCapability(
            fixture.bearerStore.saved,
            bearer: bearer,
            verifiedKeyID: "native-fixed-key-id"
        )
        let assertionVerificationCallCount =
            await fixture.server.assertionVerificationCallCount
        XCTAssertEqual(assertionVerificationCallCount, 1)
    }

    func testLaunchAndSubmissionShareOneInFlightEnrollmentAttempt() async {
        let bearer = GuestCapabilityBearer(
            expiresAt: Date(timeIntervalSince1970: 1_785_252_600),
            token: "guestcap_\(String(repeating: "B", count: 43))"
        )
        let challengeGate = AppAttestChallengeGate()
        let fixture = makeEnrollmentFixture(
            bearer: bearer,
            challengeGate: challengeGate
        )

        let launch = Task { await fixture.enrollment.enrollIfNeeded() }
        await challengeGate.waitUntilStarted()
        let submission = Task { await fixture.enrollment.enrollIfNeeded() }
        for _ in 0..<100 { await Task.yield() }
        await challengeGate.open()
        let outcomes = await (launch.value, submission.value)

        XCTAssertEqual(outcomes.0, .ready)
        XCTAssertEqual(outcomes.1, .ready)
        let challengeCallCount = await fixture.server.challengeCallCount
        let assertionVerificationCallCount =
            await fixture.server.assertionVerificationCallCount
        XCTAssertEqual(challengeCallCount, 2)
        XCTAssertEqual(assertionVerificationCallCount, 1)
    }

    func testFailedEnrollmentClearsInFlightSoALaterLaunchRetriesFreshWork() async {
        let bearer = GuestCapabilityBearer(
            expiresAt: Date(timeIntervalSince1970: 1_785_252_600),
            token: "guestcap_\(String(repeating: "C", count: 43))"
        )
        let fixture = makeEnrollmentFixture(bearer: bearer)
        fixture.bearerStore.saveError =
            GuestCapabilityBearerStoreStubError.saveFailed

        let failed = await fixture.enrollment.enrollIfNeeded()
        fixture.bearerStore.saveError = nil
        let retried = await fixture.enrollment.enrollIfNeeded()

        XCTAssertEqual(failed, .invalid(.keyPersistenceFailed))
        XCTAssertEqual(retried, .ready)
        assertSavedGuestCapability(
            fixture.bearerStore.saved,
            bearer: bearer,
            verifiedKeyID: "native-fixed-key-id"
        )
        let challengeCallCount = await fixture.server.challengeCallCount
        let assertionVerificationCallCount =
            await fixture.server.assertionVerificationCallCount
        XCTAssertEqual(challengeCallCount, 3)
        XCTAssertEqual(assertionVerificationCallCount, 2)
    }

    private func makeEnrollmentFixture(
        bearer: GuestCapabilityBearer,
        challengeGate: AppAttestChallengeGate? = nil
    ) -> (
        enrollment: AppAttestGuestCapabilityEnrollment,
        server: AppAttestServerStub,
        bearerStore: GuestCapabilityBearerStoreStub,
        service: AppAttestServiceStub
    ) {
        let bearerStore = GuestCapabilityBearerStoreStub()
        let server = AppAttestServerStub(
            assertionTruth: .verified(.init(
                counter: 1,
                environment: .production,
                guestCapability: bearer,
                keyID: "native-fixed-key-id",
                kind: .assertion
            )),
            challengeGate: challengeGate
        )
        let service = AppAttestServiceStub(isSupported: true)
        return (
            AppAttestGuestCapabilityEnrollment(
                client: AppAttestClient(
                    appID: "TEAMID1234.dev.snaplist.ios",
                    environment: .production,
                    guestCapabilityStore: bearerStore,
                    keyStore: AppAttestKeyStoreStub(),
                    server: server,
                    service: service
                )
            ),
            server,
            bearerStore,
            service
        )
    }

    // MARK: Issue #727 — the guest capability issued with a verified assertion

    func testVerifiedAssertionRetainsTheServerIssuedGuestCapability() async throws {
        let token = "guestcap_\(String(repeating: "A", count: 43))"
        AppAttestURLProtocolStub.responses = [
            .init(
                body: #"{"data":{"counter":7,"environment":"production","guestCapability":{"bearerToken":"\#(token)","expiresAt":"2026-07-28T15:30:00.000Z","refreshAfter":"2026-07-28T15:25:00.000Z"},"keyId":"native-fixed-key-id","kind":"assertion","status":"verified"}}"#,
                status: 200
            ),
        ]

        let truth = try await makeURLSessionServerClient().verifyAssertion(
            challengeID: UUID(uuidString: "00000000-0000-4000-8000-000000000331")!,
            clientData: Data(#"{"operation":"proof-client-data"}"#.utf8),
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
                    token: token
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
            #"{"data":{"counter":7,"environment":"production","guestCapability":{"bearerToken":"guestcap_opaque","expiresAt":"2026-07-28T15:30:00.000Z"},"keyId":"native-fixed-key-id","kind":"assertion","status":"verified"}}"#,
        ]

        for body in bodies {
            AppAttestURLProtocolStub.responses = [.init(body: body, status: 200)]
            do {
                _ = try await makeURLSessionServerClient().verifyAssertion(
                    challengeID: UUID(uuidString: "00000000-0000-4000-8000-000000000331")!,
                    clientData: Data(#"{"operation":"proof-client-data"}"#.utf8),
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

        assertSavedGuestCapability(
            bearerStore.saved,
            bearer: bearer,
            verifiedKeyID: "native-fixed-key-id"
        )
    }

    private func assertSavedGuestCapability(
        _ saved: [GuestCapabilityBearer],
        bearer: GuestCapabilityBearer,
        verifiedKeyID: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        guard let scope = ItemRunSubmissionPrincipalScopeProof(
            verifiedAppAttestKeyID: verifiedKeyID
        ) else {
            XCTFail(
                "Expected a valid App Attest principal scope",
                file: file,
                line: line
            )
            return
        }
        XCTAssertEqual(
            saved,
            [bearer.bound(to: scope)],
            file: file,
            line: line
        )
    }

    func testVerifiedAssertionReportsGuestCapabilityPersistenceFailure() async {
        let bearer = GuestCapabilityBearer(
            expiresAt: Date(timeIntervalSince1970: 1_785_252_600),
            token: "guestcap_opaque"
        )
        let bearerStore = GuestCapabilityBearerStoreStub()
        bearerStore.saveError = GuestCapabilityBearerStoreStubError.saveFailed
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

        let truth = await client.assert(
            requestBody: Data(#"{"operation":"proof"}"#.utf8)
        )

        XCTAssertEqual(truth, .invalid(.keyPersistenceFailed))
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

    func testGuestCapabilityBearerPatternAcceptsATokenMintedUnderTheShippedPrefix() {
        let pattern = GuestCapabilityToken.bearerTokenPattern(for: GuestCapabilityToken.prefix)
        let token = "\(GuestCapabilityToken.prefix)\(String(repeating: "A", count: 43))"

        XCTAssertNotNil(token.range(of: pattern, options: .regularExpression))
    }

    // Issue #816. #810 made the prefix shared so that editing it propagates to
    // the server by itself. A prefix carrying a regex metacharacter would then
    // propagate as *pattern* rather than as text and quietly widen what this
    // client accepts as a guest bearer; the sibling `guesthandoff_v1.` prefix
    // shows a dotted prefix is a real shape here. The server escapes the same
    // way in `guest-capability/token-prefix.ts`, so both sides stay in step.
    func testGuestCapabilityBearerPatternMatchesAPrefixMetacharacterLiterally() {
        let pattern = GuestCapabilityToken.bearerTokenPattern(for: "guestcap.v2_")
        let body = String(repeating: "A", count: 43)

        XCTAssertNotNil("guestcap.v2_\(body)".range(of: pattern, options: .regularExpression))
        XCTAssertNil("guestcapXv2_\(body)".range(of: pattern, options: .regularExpression))
    }

    // Issue #810, widened by #816. `GuestCapabilityToken.prefix` is the one
    // place production Swift may spell the literal; a hand-written prefix
    // anywhere else silently re-forks the value the cross-language test cannot
    // see, because that test compares only the constant, not every call site.
    //
    // #816 widened this two ways. The round-1 defect on #810 was literals in
    // `RunStore.swift` and `ItemRunSubmissionCoordinator.swift`, which scanning
    // `AppAttestClient.swift` alone could never have caught; all three consumers
    // are scanned now. And occurrences are counted rather than lines, so a
    // second literal sharing a physical line with the declaration cannot hide
    // behind the first.
    func testGuestCapabilityTokenPrefixLiteralAppearsOnlyInItsDeclaration() throws {
        let sources = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("SnapList")
        let scanned = [
            "AppAttest/AppAttestClient.swift",
            "Features/Runs/RunStore.swift",
            "Features/Submission/ItemRunSubmissionCoordinator.swift",
        ]

        var occurrences: [String] = []
        for relativePath in scanned {
            let source = try String(
                contentsOf: sources.appendingPathComponent(relativePath),
                encoding: .utf8
            )
            for line in source.components(separatedBy: .newlines) {
                let perLine = line.components(separatedBy: GuestCapabilityToken.prefix).count - 1
                occurrences.append(
                    contentsOf: Array(repeating: "\(relativePath): \(line)", count: perLine)
                )
            }
        }

        XCTAssertEqual(
            occurrences.count, 1,
            "Expected exactly one \(GuestCapabilityToken.prefix) occurrence across \(scanned) (the shared constant); found \(occurrences)"
        )
        XCTAssertTrue(
            occurrences.first?.contains("static let prefix") ?? false,
            "The one occurrence must be the GuestCapabilityToken.prefix declaration, got \(String(describing: occurrences.first))"
        )
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
    nonisolated(unsafe) static var lastRequestBody: Data?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lastRequestBody = Self.bodyData(of: request)
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

    private static func bodyData(of request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4_096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            guard read > 0 else { break }
            data.append(buffer, count: read)
        }
        return data
    }
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
    var saveError: Error?

    func load() throws -> GuestCapabilityBearer? { bearer }

    func save(_ bearer: GuestCapabilityBearer) throws {
        if let saveError { throw saveError }
        self.bearer = bearer
        saved.append(bearer)
    }

}

private enum GuestCapabilityBearerStoreStubError: Error {
    case saveFailed
}

private actor AppAttestServerStub: AppAttestServerClient {
    private(set) var assertionRequestBody: Data?
    private(set) var assertionVerificationCallCount = 0
    private(set) var challengeCallCount = 0
    private let assertionChallenge: Data
    private let assertionTruth: AppAttestTruth
    private let attestationChallenge: Data
    private let challengeGate: AppAttestChallengeGate?

    init(
        assertionChallenge: Data = Data("assertion-challenge".utf8),
        assertionTruth: AppAttestTruth = .verified(.init(
            counter: 1,
            environment: .production,
            keyID: "native-fixed-key-id",
            kind: .assertion
        )),
        attestationChallenge: Data = Data("attestation-challenge".utf8),
        challengeGate: AppAttestChallengeGate? = nil
    ) {
        self.assertionChallenge = assertionChallenge
        self.assertionTruth = assertionTruth
        self.attestationChallenge = attestationChallenge
        self.challengeGate = challengeGate
    }

    func issueChallenge(kind: AppAttestChallenge.Kind, keyID: String?) async throws -> AppAttestChallenge {
        challengeCallCount += 1
        await challengeGate?.waitIfClosed()
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
        clientData: Data,
        keyID: String,
        assertionObject: Data,
        requestBody: Data
    ) async throws -> AppAttestTruth {
        assertionVerificationCallCount += 1
        assertionRequestBody = requestBody
        return assertionTruth
    }
}

private actor AppAttestChallengeGate {
    private var isOpen = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func waitIfClosed() async {
        guard !isOpen else { return }
        let startWaiters = startWaiters
        self.startWaiters.removeAll()
        startWaiters.forEach { $0.resume() }
        await withCheckedContinuation { continuation in
            waiters.append(continuation)
        }
    }

    func waitUntilStarted() async {
        guard waiters.isEmpty else { return }
        await withCheckedContinuation { continuation in
            startWaiters.append(continuation)
        }
    }

    func open() {
        isOpen = true
        let waiters = waiters
        self.waiters.removeAll()
        waiters.forEach { $0.resume() }
    }
}
