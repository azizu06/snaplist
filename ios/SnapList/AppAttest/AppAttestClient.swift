import CryptoKit
import DeviceCheck
import Foundation
import Security

enum AppAttestEnvironment: String, Codable, Sendable {
    case development
    case production
}

enum AppAttestUnavailableReason: Equatable, Sendable {
    case unsupportedDevice
    case appleServiceUnavailable
    case serverUnavailable
}

enum AppAttestInvalidReason: Equatable, Sendable {
    case appleRejected
    case keyPersistenceFailed
    case missingVerifiedKey
    case serverRejected
}

struct VerifiedAppAttestTruth: Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        case attestation
        case assertion
    }

    let counter: UInt32
    let environment: AppAttestEnvironment
    let keyID: String
    let kind: Kind
}

enum AppAttestTruth: Equatable, Sendable {
    case verified(VerifiedAppAttestTruth)
    case unavailable(AppAttestUnavailableReason)
    case invalid(AppAttestInvalidReason)
}

struct AppAttestChallenge: Equatable, Sendable {
    enum Kind: String, Codable, Sendable {
        case attestation
        case assertion
    }

    let bytes: Data
    let expiresAt: Date
    let id: UUID
    let kind: Kind
}

protocol AppAttestServicing: Sendable {
    var isSupported: Bool { get }
    func generateKey() async throws -> String
    func attestKey(_ keyID: String, clientDataHash: Data) async throws -> Data
    func generateAssertion(_ keyID: String, clientDataHash: Data) async throws -> Data
}

final class DeviceCheckAppAttestService: AppAttestServicing, @unchecked Sendable {
    private let service = DCAppAttestService.shared

    var isSupported: Bool { service.isSupported }

    func generateKey() async throws -> String {
        try await service.generateKey()
    }

    func attestKey(_ keyID: String, clientDataHash: Data) async throws -> Data {
        try await service.attestKey(keyID, clientDataHash: clientDataHash)
    }

    func generateAssertion(_ keyID: String, clientDataHash: Data) async throws -> Data {
        try await service.generateAssertion(keyID, clientDataHash: clientDataHash)
    }
}

protocol AppAttestKeyIDStoring: Sendable {
    func load() throws -> String?
    func save(_ keyID: String) throws
    func remove() throws
}

struct KeychainAppAttestKeyIDStore: AppAttestKeyIDStoring {
    private let account = "verified-app-attest-key-id"
    private let service = "dev.snaplist.ios.app-attest"

    func load() throws -> String? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess,
              let data = result as? Data,
              let keyID = String(data: data, encoding: .utf8),
              !keyID.isEmpty else {
            throw KeychainError(status: status)
        }
        return keyID
    }

    func save(_ keyID: String) throws {
        guard !keyID.isEmpty, let data = keyID.data(using: .utf8) else {
            throw KeychainError(status: errSecParam)
        }
        let attributes = [kSecValueData as String: data]
        let updateStatus = SecItemUpdate(baseQuery as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess { return }
        guard updateStatus == errSecItemNotFound else {
            throw KeychainError(status: updateStatus)
        }
        var insert = baseQuery
        insert[kSecValueData as String] = data
        let insertStatus = SecItemAdd(insert as CFDictionary, nil)
        guard insertStatus == errSecSuccess else {
            throw KeychainError(status: insertStatus)
        }
    }

    func remove() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError(status: status)
        }
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecAttrService as String: service,
        ]
    }

    private struct KeychainError: Error {
        let status: OSStatus
    }
}

protocol AppAttestServerClient: Sendable {
    func issueChallenge(kind: AppAttestChallenge.Kind, keyID: String?) async throws -> AppAttestChallenge
    func verifyAttestation(
        challengeID: UUID,
        keyID: String,
        attestationObject: Data
    ) async throws -> AppAttestTruth
    func verifyAssertion(
        challengeID: UUID,
        keyID: String,
        assertionObject: Data,
        requestBody: Data
    ) async throws -> AppAttestTruth
}

private struct AppAttestTruthEnvelope: Decodable { let data: AppAttestTruthData }

private struct AppAttestTruthData: Decodable {
    let counter: UInt32?
    let environment: String?
    let keyId: String?
    let kind: String?
    let status: String
}

struct URLSessionAppAttestServerClient: AppAttestServerClient, @unchecked Sendable {
    private let endpoint: URL
    private let session: URLSession

    init(apiOrigin: URL, session: URLSession = .shared) {
        endpoint = apiOrigin.appending(path: "api/app-attest")
        self.session = session
    }

    func issueChallenge(kind: AppAttestChallenge.Kind, keyID: String?) async throws -> AppAttestChallenge {
        struct Payload: Encodable {
            let keyId: String?
            let kind: String
            let operation = "challenge"
        }
        struct Envelope: Decodable { let data: ChallengeData }
        struct ChallengeData: Decodable {
            let challenge: String
            let challengeId: UUID
            let expiresAt: String
            let kind: String
        }

        let envelope: Envelope = try await post(Payload(keyId: keyID, kind: kind.rawValue))
        guard envelope.data.kind == kind.rawValue,
              let bytes = Data(base64URLEncoded: envelope.data.challenge),
              let expiresAt = Self.date(envelope.data.expiresAt) else {
            throw AppAttestServerError.invalidResponse
        }
        return AppAttestChallenge(
            bytes: bytes,
            expiresAt: expiresAt,
            id: envelope.data.challengeId,
            kind: kind
        )
    }

    func verifyAttestation(
        challengeID: UUID,
        keyID: String,
        attestationObject: Data
    ) async throws -> AppAttestTruth {
        struct Payload: Encodable {
            let attestationObject: String
            let challengeId: UUID
            let keyId: String
            let operation = "attestation"
        }
        return try await verify(Payload(
            attestationObject: attestationObject.base64EncodedString(),
            challengeId: challengeID,
            keyId: keyID
        ))
    }

    func verifyAssertion(
        challengeID: UUID,
        keyID: String,
        assertionObject: Data,
        requestBody: Data
    ) async throws -> AppAttestTruth {
        struct Payload: Encodable {
            let assertionObject: String
            let challengeId: UUID
            let keyId: String
            let operation = "assertion"
            let requestBody: String
        }
        return try await verify(Payload(
            assertionObject: assertionObject.base64EncodedString(),
            challengeId: challengeID,
            keyId: keyID,
            requestBody: requestBody.base64EncodedString()
        ))
    }

    private func verify<Payload: Encodable>(_ payload: Payload) async throws -> AppAttestTruth {
        let envelope: AppAttestTruthEnvelope = try await post(payload)
        switch envelope.data.status {
        case "unavailable":
            return .unavailable(.serverUnavailable)
        case "invalid":
            return .invalid(.serverRejected)
        case "verified":
            guard let counter = envelope.data.counter,
                  let environmentValue = envelope.data.environment,
                  let environment = AppAttestEnvironment(rawValue: environmentValue),
                  let keyID = envelope.data.keyId,
                  let kindValue = envelope.data.kind else {
                throw AppAttestServerError.invalidResponse
            }
            let kind: VerifiedAppAttestTruth.Kind
            if kindValue == "attestation" {
                kind = .attestation
            } else if kindValue == "assertion" {
                kind = .assertion
            } else {
                throw AppAttestServerError.invalidResponse
            }
            return .verified(.init(counter: counter, environment: environment, keyID: keyID, kind: kind))
        default:
            throw AppAttestServerError.invalidResponse
        }
    }

    private func post<Payload: Encodable, Result: Decodable>(_ payload: Payload) async throws -> Result {
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.httpBody = try JSONEncoder().encode(payload)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, response) = try await session.data(for: request)
        guard response is HTTPURLResponse else { throw AppAttestServerError.invalidResponse }
        return try JSONDecoder().decode(Result.self, from: data)
    }

    private static func date(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value)
    }

    private enum AppAttestServerError: Error {
        case invalidResponse
    }
}

actor AppAttestClient {
    private static let persistedKeyRestorationRequestBody =
        Data(#"{"operation":"restore-app-attest-key"}"#.utf8)

    private let appID: String
    private let environment: AppAttestEnvironment
    private let keyStore: any AppAttestKeyIDStoring
    private let server: any AppAttestServerClient
    private let service: any AppAttestServicing

    init(
        appID: String,
        environment: AppAttestEnvironment,
        keyStore: any AppAttestKeyIDStoring = KeychainAppAttestKeyIDStore(),
        server: any AppAttestServerClient,
        service: any AppAttestServicing = DeviceCheckAppAttestService()
    ) {
        self.appID = appID
        self.environment = environment
        self.keyStore = keyStore
        self.server = server
        self.service = service
    }

    func attestInstallation() async -> AppAttestTruth {
        guard service.isSupported else { return .unavailable(.unsupportedDevice) }
        do {
            if let keyID = try keyStore.load() {
                return await verifyAssertion(
                    keyID: keyID,
                    requestBody: Self.persistedKeyRestorationRequestBody
                )
            }
            let challenge = try await server.issueChallenge(kind: .attestation, keyID: nil)
            let keyID = try await service.generateKey()
            let hash = Data(SHA256.hash(data: challenge.bytes))
            let object = try await service.attestKey(keyID, clientDataHash: hash)
            let truth = try await server.verifyAttestation(
                challengeID: challenge.id,
                keyID: keyID,
                attestationObject: object
            )
            guard case .verified = truth else { return truth }
            do {
                try keyStore.save(keyID)
            } catch {
                return .invalid(.keyPersistenceFailed)
            }
            return truth
        } catch let error as DCError where error.code == .serverUnavailable {
            return .unavailable(.appleServiceUnavailable)
        } catch is URLError {
            return .unavailable(.serverUnavailable)
        } catch {
            return .invalid(.appleRejected)
        }
    }

    func assert(requestBody: Data) async -> AppAttestTruth {
        guard service.isSupported else { return .unavailable(.unsupportedDevice) }
        let keyID: String
        do {
            guard let storedKeyID = try keyStore.load() else {
                return .invalid(.missingVerifiedKey)
            }
            keyID = storedKeyID
        } catch {
            return .invalid(.keyPersistenceFailed)
        }

        return await verifyAssertion(keyID: keyID, requestBody: requestBody)
    }

    private func verifyAssertion(
        keyID: String,
        requestBody: Data
    ) async -> AppAttestTruth {
        do {
            let challenge = try await server.issueChallenge(kind: .assertion, keyID: keyID)
            let clientData = try assertionClientData(
                challenge: challenge.bytes,
                keyID: keyID,
                requestBody: requestBody
            )
            let object = try await service.generateAssertion(
                keyID,
                clientDataHash: Data(SHA256.hash(data: clientData))
            )
            return try await server.verifyAssertion(
                challengeID: challenge.id,
                keyID: keyID,
                assertionObject: object,
                requestBody: requestBody
            )
        } catch let error as DCError where error.code == .serverUnavailable {
            return .unavailable(.appleServiceUnavailable)
        } catch is URLError {
            return .unavailable(.serverUnavailable)
        } catch {
            return .invalid(.appleRejected)
        }
    }

    private func assertionClientData(
        challenge: Data,
        keyID: String,
        requestBody: Data
    ) throws -> Data {
        struct ClientData: Encodable {
            let appId: String
            let challenge: String
            let environment: String
            let keyId: String
            let requestHash: String
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(ClientData(
            appId: appID,
            challenge: challenge.base64URLEncodedString(),
            environment: environment.rawValue,
            keyId: keyID,
            requestHash: Data(SHA256.hash(data: requestBody)).base64URLEncodedString()
        ))
    }
}

private extension Data {
    init?(base64URLEncoded value: String) {
        var base64 = value.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        self.init(base64Encoded: base64)
    }

    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
