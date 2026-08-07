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

/**
 Issue #727. The server-issued capability a verified assertion earns, which is
 the only credential a signed-out seller has.

 It is opaque here: SnapList carries it and watches its expiry, and never reads
 what is inside it. Only `expiresAt` is client business, because a spent bearer
 must not be offered to a request that would then fail as unauthenticated.
 */
struct GuestCapabilityBearer: Codable, Equatable, Sendable {
    let expiresAt: Date
    let token: String

    func isUsable(at instant: Date) -> Bool { instant < expiresAt }
}

/// Durable custody of the current guest capability. Separate from the App Attest
/// key store because the key proves the installation while this authorizes one
/// signed-out seller's requests, and they expire on entirely different clocks.
protocol GuestCapabilityBearerStoring: Sendable {
    func load() throws -> GuestCapabilityBearer?
    func save(_ bearer: GuestCapabilityBearer) throws
    func remove() throws
}

struct VerifiedAppAttestTruth: Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        case attestation
        case assertion
    }

    let counter: UInt32
    let environment: AppAttestEnvironment
    /// Present exactly for `.assertion`; an attestation never earns one.
    let guestCapability: GuestCapabilityBearer?
    let keyID: String
    let kind: Kind

    init(
        counter: UInt32,
        environment: AppAttestEnvironment,
        guestCapability: GuestCapabilityBearer? = nil,
        keyID: String,
        kind: Kind
    ) {
        self.counter = counter
        self.environment = environment
        self.guestCapability = guestCapability
        self.keyID = keyID
        self.kind = kind
    }
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

enum DeviceCheckTokenError: Error, Equatable {
    case appleServiceUnavailable
    case unsupportedDevice
}

/**
 Apple's per-physical-device state, which is a different primitive from the
 App Attest service above.

 App Attest proves *this installation made this request*; a reinstall mints a
 new key and the old proof means nothing. `DCDevice` addresses the hardware
 itself and survives reinstall, which is the only property that lets issue
 #524 fence one included first AI item to one device. The server, never the
 client, reads and writes `bit0` — the token here is opaque, single-use, and
 carries no verdict.
 */
protocol DeviceCheckTokenProviding: Sendable {
    var isSupported: Bool { get }
    func generateToken() async throws -> Data
}

/**
 The Apple primitive: `DCDevice.current.generateToken`.

 Availability gate: `DCDevice.current.isSupported`, which is false on the
 Simulator and on hardware without the capability. Honest fallback: the caller
 is told the device cannot participate and routes to the paid path rather than
 opening a claim that could never be answered. Server-truth boundary: the token
 only travels; whether the device already consumed the promotion is decided
 server-side by the single-writer redemption queue.
 */
struct AppleDeviceCheckTokenProvider: DeviceCheckTokenProviding {
    var isSupported: Bool { DCDevice.current.isSupported }

    func generateToken() async throws -> Data {
        let device = DCDevice.current
        guard device.isSupported else {
            throw DeviceCheckTokenError.unsupportedDevice
        }
        return try await withCheckedThrowingContinuation { continuation in
            device.generateToken { token, error in
                if let token {
                    continuation.resume(returning: token)
                    return
                }
                continuation.resume(
                    throwing: error ?? DeviceCheckTokenError.appleServiceUnavailable
                )
            }
        }
    }
}

/** One unspent App Attest assertion, addressed to the request it signed. */
struct AppAttestAssertionProof: Equatable, Sendable {
    let assertionObject: Data
    let challengeID: UUID
    let keyID: String
}

enum AppAttestProofOutcome: Equatable, Sendable {
    case proof(AppAttestAssertionProof)
    case unavailable(AppAttestUnavailableReason)
    case invalid(AppAttestInvalidReason)
}

protocol AppAttestProofProviding: Sendable {
    func assertionProof(requestBody: Data) async -> AppAttestProofOutcome
}

protocol AppAttestKeyIDStoring: Sendable {
    func load() throws -> AppAttestStoredKey?
    func save(_ key: AppAttestStoredKey) throws
    func remove() throws
}

struct KeychainAppAttestKeyIDStore: AppAttestKeyIDStoring {
    static let didChange = Notification.Name(
        "dev.snaplist.ios.app-attest-key-id-did-change"
    )

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
        if updateStatus == errSecSuccess {
            NotificationCenter.default.post(name: Self.didChange, object: nil)
            return
        }
        guard updateStatus == errSecItemNotFound else {
            throw KeychainError(status: updateStatus)
        }
        var insert = baseQuery
        insert[kSecValueData as String] = data
        let insertStatus = SecItemAdd(insert as CFDictionary, nil)
        guard insertStatus == errSecSuccess else {
            throw KeychainError(status: insertStatus)
        }
        NotificationCenter.default.post(name: Self.didChange, object: nil)
    }

    func remove() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError(status: status)
        }
        NotificationCenter.default.post(name: Self.didChange, object: nil)
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

struct KeychainGuestCapabilityBearerStore: GuestCapabilityBearerStoring {
    private let account = "guest-capability-bearer"
    private let service = "dev.snaplist.ios.guest-capability"

    func load() throws -> GuestCapabilityBearer? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw KeychainError(status: status)
        }
        guard let bearer = try? JSONDecoder().decode(
            GuestCapabilityBearer.self,
            from: data
        ) else {
            throw KeychainError(status: errSecDecode)
        }
        return bearer
    }

    func save(_ bearer: GuestCapabilityBearer) throws {
        guard !bearer.token.isEmpty,
              let data = try? JSONEncoder().encode(bearer) else {
            throw KeychainError(status: errSecParam)
        }
        let attributes = [kSecValueData as String: data]
        let updateStatus = SecItemUpdate(
            baseQuery as CFDictionary,
            attributes as CFDictionary
        )
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

private struct AppAttestGuestCapabilityData: Decodable {
    let bearerToken: String
    let expiresAt: String
    // `refreshAfter` also travels on the wire. SnapList does not refresh a
    // capability yet, so decoding it would only invite a stale consumer.
}

private struct AppAttestTruthData: Decodable {
    let code: String?
    let counter: UInt32?
    let environment: String?
    let guestCapability: AppAttestGuestCapabilityData?
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
            return .verified(.init(
                counter: counter,
                environment: environment,
                guestCapability: try Self.guestCapability(
                    envelope.data.guestCapability,
                    for: kind
                ),
                keyID: keyID,
                kind: kind
            ))
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

    /// The server issues a capability with every verified assertion. One that is
    /// missing or unreadable is not a seller without a credential; it is a
    /// response this client cannot honour, and accepting it silently would leave
    /// a signed-out seller holding nothing at submission time.
    private static func guestCapability(
        _ issued: AppAttestGuestCapabilityData?,
        for kind: VerifiedAppAttestTruth.Kind
    ) throws -> GuestCapabilityBearer? {
        guard kind == .assertion else { return nil }
        guard let issued,
              let expiresAt = date(issued.expiresAt) else {
            throw AppAttestServerClientError.invalidResponse
        }
        let token = issued.bearerToken.trimmingCharacters(
            in: .whitespacesAndNewlines
        )
        guard !token.isEmpty else {
            throw AppAttestServerClientError.invalidResponse
        }
        return GuestCapabilityBearer(expiresAt: expiresAt, token: token)
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
    private let guestCapabilityStore: any GuestCapabilityBearerStoring
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
        guestCapabilityStore: any GuestCapabilityBearerStoring =
            KeychainGuestCapabilityBearerStore(),
        keyStore: any AppAttestKeyIDStoring = KeychainAppAttestKeyIDStore(),
        server: any AppAttestServerClient,
        service: any AppAttestServicing = DeviceCheckAppAttestService()
    ) {
        self.appID = appID
        self.environment = environment
        self.guestCapabilityStore = guestCapabilityStore
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

    /**
     Issue #524. Produces an assertion and stops, one step short of
     `assert(requestBody:)`.

     The included-offer redemption endpoints verify the assertion themselves
     through #331. Calling `verifyAssertion` here would claim the one-time
     challenge first, so the redemption would arrive holding evidence the server
     had already retired and be refused as `challenge_replayed`.
     */
    func assertionProof(requestBody: Data) async -> AppAttestProofOutcome {
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
            return .proof(AppAttestAssertionProof(
                assertionObject: object,
                challengeID: challenge.id,
                keyID: keyID
            ))
        } catch AppAttestServiceError.staleKey {
            return .invalid(.appleRejected)
        } catch let error as AppAttestServerClientError {
            switch Self.truth(for: error) {
            case .unavailable(let reason):
                return .unavailable(reason)
            case .invalid(let reason):
                return .invalid(reason)
            case .verified:
                return .invalid(.serverRejected)
            }
        } catch let error as DCError where error.code == .serverUnavailable {
            return .unavailable(.appleServiceUnavailable)
        } catch is URLError {
            return .unavailable(.serverUnavailable)
        } catch {
            return .invalid(.appleRejected)
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
            let truth = try await server.verifyAssertion(
                challengeID: challenge.id,
                keyID: keyID,
                assertionObject: object,
                requestBody: requestBody
            )
            // Every verified assertion funnels through here, so this is the one
            // place the earned capability can be taken into durable custody. A
            // failure to persist must not fail the assertion itself: the caller
            // already has its proof, and the next assertion re-earns the bearer.
            if case .verified(let verified) = truth,
               let capability = verified.guestCapability {
                try? guestCapabilityStore.save(capability)
            }
            return .truth(truth)
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

extension AppAttestClient: AppAttestProofProviding {}

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
