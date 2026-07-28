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

enum AppAttestKeyVerificationState: String, Codable, Sendable {
    case pending
    case verified
}

struct AppAttestStoredKey: Codable, Equatable, Sendable {
    let id: String
    let state: AppAttestKeyVerificationState
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

enum AppAttestServiceError: Error {
    case staleKey
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
        do {
            return try await service.generateAssertion(keyID, clientDataHash: clientDataHash)
        } catch let error as DCError where error.code == .invalidKey {
            throw AppAttestServiceError.staleKey
        }
    }
}

protocol AppAttestKeyIDStoring: Sendable {
    func load() throws -> AppAttestStoredKey?
    func save(_ key: AppAttestStoredKey) throws
    func remove() throws
}

struct KeychainAppAttestKeyIDStore: AppAttestKeyIDStoring {
    private let account = "verified-app-attest-key-id"
    private let service = "dev.snaplist.ios.app-attest"

    func load() throws -> AppAttestStoredKey? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw KeychainError(status: status)
        }
        guard let key = try? JSONDecoder().decode(AppAttestStoredKey.self, from: data) else {
            throw KeychainError(status: errSecDecode)
        }
        return key
    }

    func save(_ key: AppAttestStoredKey) throws {
        guard !key.id.isEmpty, let data = try? JSONEncoder().encode(key) else {
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
private struct AppAttestStatusEnvelope: Decodable {
    struct StatusData: Decodable { let status: String }
    let data: StatusData
}

private struct AppAttestTruthData: Decodable {
    let code: String?
    let counter: UInt32?
    let environment: String?
    let keyId: String?
    let kind: String?
    let status: String
}

enum AppAttestServerClientError: Error {
    case invalidResponse
    case keyNotAttested
    case unavailable
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
            throw AppAttestServerClientError.invalidResponse
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
            if envelope.data.code == "key_not_attested" {
                throw AppAttestServerClientError.keyNotAttested
            }
            return .invalid(.serverRejected)
        case "verified":
            guard let counter = envelope.data.counter,
                  let environmentValue = envelope.data.environment,
                  let environment = AppAttestEnvironment(rawValue: environmentValue),
                  let keyID = envelope.data.keyId,
                  let kindValue = envelope.data.kind else {
                throw AppAttestServerClientError.invalidResponse
            }
            let kind: VerifiedAppAttestTruth.Kind
            if kindValue == "attestation" {
                kind = .attestation
            } else if kindValue == "assertion" {
                kind = .assertion
            } else {
                throw AppAttestServerClientError.invalidResponse
            }
            return .verified(.init(counter: counter, environment: environment, keyID: keyID, kind: kind))
        default:
            throw AppAttestServerClientError.invalidResponse
        }
    }

    private func post<Payload: Encodable, Result: Decodable>(_ payload: Payload) async throws -> Result {
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.httpBody = try JSONEncoder().encode(payload)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw AppAttestServerClientError.invalidResponse
        }
        let decoder = JSONDecoder()
        if !(200..<300).contains(httpResponse.statusCode) {
            let status = try? decoder.decode(AppAttestStatusEnvelope.self, from: data).data.status
            if httpResponse.statusCode >= 500 || status == "unavailable" {
                throw AppAttestServerClientError.unavailable
            }
            if let result = try? decoder.decode(Result.self, from: data) {
                return result
            }
            throw AppAttestServerClientError.invalidResponse
        }
        do {
            return try decoder.decode(Result.self, from: data)
        } catch {
            throw AppAttestServerClientError.invalidResponse
        }
    }

    private static func date(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value)
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

    private enum AssertionAttempt {
        case keyNotAttested
        case staleKey
        case truth(AppAttestTruth)
    }

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
            if let storedKey = try keyStore.load() {
                let attempt = await attemptAssertion(
                    keyID: storedKey.id,
                    requestBody: Self.persistedKeyRestorationRequestBody
                )
                switch attempt {
                case .keyNotAttested, .staleKey:
                    try keyStore.remove()
                    return await enrollNewKey()
                case .truth(let truth):
                    if case .verified = truth, storedKey.state == .pending {
                        try keyStore.save(.init(id: storedKey.id, state: .verified))
                    }
                    return truth
                }
            }
            return await enrollNewKey()
        } catch {
            return .invalid(.keyPersistenceFailed)
        }
    }

    private func enrollNewKey() async -> AppAttestTruth {
        do {
            let challenge = try await server.issueChallenge(kind: .attestation, keyID: nil)
            let keyID = try await service.generateKey()
            do {
                try keyStore.save(.init(id: keyID, state: .pending))
            } catch {
                return .invalid(.keyPersistenceFailed)
            }
            let hash = Data(SHA256.hash(data: challenge.bytes))
            let object = try await service.attestKey(keyID, clientDataHash: hash)
            let truth = try await server.verifyAttestation(
                challengeID: challenge.id,
                keyID: keyID,
                attestationObject: object
            )
            guard case .verified = truth else { return truth }
            do {
                try keyStore.save(.init(id: keyID, state: .verified))
            } catch {
                return .invalid(.keyPersistenceFailed)
            }
            return truth
        } catch let error as AppAttestServerClientError {
            return Self.truth(for: error)
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
            guard let storedKey = try keyStore.load(),
                  storedKey.state == .verified else {
                return .invalid(.missingVerifiedKey)
            }
            keyID = storedKey.id
        } catch {
            return .invalid(.keyPersistenceFailed)
        }

        switch await attemptAssertion(keyID: keyID, requestBody: requestBody) {
        case .keyNotAttested:
            return .invalid(.serverRejected)
        case .staleKey:
            return .invalid(.appleRejected)
        case .truth(let truth):
            return truth
        }
    }

    private func attemptAssertion(
        keyID: String,
        requestBody: Data
    ) async -> AssertionAttempt {
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
            return .truth(try await server.verifyAssertion(
                challengeID: challenge.id,
                keyID: keyID,
                assertionObject: object,
                requestBody: requestBody
            ))
        } catch AppAttestServerClientError.keyNotAttested {
            return .keyNotAttested
        } catch AppAttestServiceError.staleKey {
            return .staleKey
        } catch let error as AppAttestServerClientError {
            return .truth(Self.truth(for: error))
        } catch let error as DCError where error.code == .serverUnavailable {
            return .truth(.unavailable(.appleServiceUnavailable))
        } catch is URLError {
            return .truth(.unavailable(.serverUnavailable))
        } catch {
            return .truth(.invalid(.appleRejected))
        }
    }

    private static func truth(for error: AppAttestServerClientError) -> AppAttestTruth {
        switch error {
        case .unavailable:
            return .unavailable(.serverUnavailable)
        case .invalidResponse, .keyNotAttested:
            return .invalid(.serverRejected)
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
