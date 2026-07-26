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
        XCTAssertEqual(keyStore.keyID, "native-fixed-key-id")
        XCTAssertEqual(service.attestationHash, Data(SHA256.hash(data: challenge)))
    }

    func testAssertionUsesTheRequestBoundCanonicalClientDataHash() async throws {
        let keyStore = AppAttestKeyStoreStub(keyID: "native-fixed-key-id")
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
}

private final class AppAttestServiceStub: AppAttestServicing, @unchecked Sendable {
    let isSupported: Bool
    private(set) var assertionHash: Data?
    private(set) var attestationHash: Data?
    private(set) var generateKeyCallCount = 0

    init(isSupported: Bool) {
        self.isSupported = isSupported
    }

    func generateKey() async throws -> String {
        generateKeyCallCount += 1
        return "native-fixed-key-id"
    }

    func attestKey(_ keyID: String, clientDataHash: Data) async throws -> Data {
        attestationHash = clientDataHash
        return Data("fixed-attestation".utf8)
    }

    func generateAssertion(_ keyID: String, clientDataHash: Data) async throws -> Data {
        assertionHash = clientDataHash
        return Data("fixed-assertion".utf8)
    }
}

private final class AppAttestKeyStoreStub: AppAttestKeyIDStoring, @unchecked Sendable {
    var keyID: String?

    init(keyID: String? = nil) {
        self.keyID = keyID
    }

    func load() throws -> String? { keyID }
    func save(_ keyID: String) throws { self.keyID = keyID }
    func remove() throws { keyID = nil }
}

private actor AppAttestServerStub: AppAttestServerClient {
    private(set) var challengeCallCount = 0
    private let assertionChallenge: Data
    private let attestationChallenge: Data

    init(
        assertionChallenge: Data = Data("assertion-challenge".utf8),
        attestationChallenge: Data = Data("attestation-challenge".utf8)
    ) {
        self.assertionChallenge = assertionChallenge
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
        .verified(.init(counter: 1, environment: .production, keyID: keyID, kind: .assertion))
    }
}
