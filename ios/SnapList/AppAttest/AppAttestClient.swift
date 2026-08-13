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

/// Issue #810. The single client-side literal recognizing a guest capability
/// bearer by shape. The server mints it in `guest-capability/service.ts`;
/// a cross-language test keeps the two boundaries synchronized.
enum GuestCapabilityToken {
    static let prefix = "guestcap_"
}

/**
 Issue #727. The server-issued capability a verified assertion earns, which is
 the only credential a signed-out seller has.

 The token is opaque here: SnapList carries it and never reads what is inside.
 Only `expiresAt` and its one-way App Attest scope digest are client business,
 so a spent or cross-key bearer is never offered to submission.
 */
struct GuestCapabilityBearer: Codable, Equatable, Sendable {
    private let appAttestScopeDigest: Data?
    let expiresAt: Date
    let token: String

    init(
        expiresAt: Date,
        token: String,
        appAttestScopeProof: ItemRunSubmissionPrincipalScopeProof? = nil
    ) {
        self.appAttestScopeDigest = appAttestScopeProof?.opaqueDigest
        self.expiresAt = expiresAt
        self.token = token
    }

    var appAttestScopeProof: ItemRunSubmissionPrincipalScopeProof? {
        guard let appAttestScopeDigest else { return nil }
        return ItemRunSubmissionPrincipalScopeProof(
            opaqueDigest: appAttestScopeDigest
        )
    }

    func bound(
        to scopeProof: ItemRunSubmissionPrincipalScopeProof
    ) -> Self {
        Self(
            expiresAt: expiresAt,
            token: token,
            appAttestScopeProof: scopeProof
        )
    }

    func isUsable(at instant: Date) -> Bool { instant < expiresAt }
}

/// Durable custody of the current guest capability. Separate from the App Attest
/// key store because the key proves the installation while this authorizes one
/// signed-out seller's requests, and they expire on entirely different clocks.
protocol GuestCapabilityBearerStoring: Sendable {
    func load() throws -> GuestCapabilityBearer?
    func save(_ bearer: GuestCapabilityBearer) throws
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
        clientData: Data,
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
        clientData: Data,
        keyID: String,
        assertionObject: Data,
        requestBody: Data
    ) async throws -> AppAttestTruth {
        struct Payload: Encodable {
            let assertionObject: String
            let challengeId: UUID
            let clientData: String
            let keyId: String
            let operation = "assertion"
            let requestBody: String
        }
        return try await verify(Payload(
            assertionObject: assertionObject.base64EncodedString(),
            challengeId: challengeID,
            clientData: clientData.base64EncodedString(),
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
        let token = issued.bearerToken
        guard token.range(
            of: #"^guestcap_[A-Za-z0-9_-]{43}$"#,
            options: .regularExpression
        ) != nil else {
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
                clientData: clientData,
                keyID: keyID,
                assertionObject: object,
                requestBody: requestBody
            )
            // Every verified assertion funnels through here, so this is the one
            // place the earned capability can be taken into durable custody. A
            // verified response without durable custody would leave the signed-out
            // seller unable to authorize the later submission.
            if case .verified(let verified) = truth,
               let capability = verified.guestCapability {
                guard verified.kind == .assertion,
                      verified.keyID == keyID,
                      let scopeProof = ItemRunSubmissionPrincipalScopeProof(
                          verifiedAppAttestKeyID: keyID
                      ) else {
                    return .truth(.invalid(.serverRejected))
                }
                do {
                    try guestCapabilityStore.save(
                        capability.bound(to: scopeProof)
                    )
                } catch {
                    return .truth(.invalid(.keyPersistenceFailed))
                }
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

enum AppAttestGuestCapabilityEnrollmentOutcome: Equatable, Sendable {
    case ready
    case unavailable(AppAttestUnavailableReason)
    case invalid(AppAttestInvalidReason)
}

/**
 Closes the App Attest enrollment loop for a signed-out installation.

 `attestInstallation()` verifies a newly generated key, but an attestation does
 not earn a guest capability. The server issues that capability only after a
 fresh verified assertion, so a first launch must perform both steps. A restored
 key already completes its assertion inside `attestInstallation()` and does not
 need a second one here.
 */
actor AppAttestGuestCapabilityEnrollment {
    private static let enrollmentRequestBody =
        Data(#"{"operation":"guest-capability.enroll"}"#.utf8)

    private let client: AppAttestClient
    private var inFlight:
        Task<AppAttestGuestCapabilityEnrollmentOutcome, Never>?

    init(client: AppAttestClient) {
        self.client = client
    }

    func enrollIfNeeded() async -> AppAttestGuestCapabilityEnrollmentOutcome {
        if let inFlight {
            return await inFlight.value
        }
        let client = client
        let enrollment = Task {
            await Self.enroll(client: client)
        }
        inFlight = enrollment
        let outcome = await enrollment.value
        inFlight = nil
        return outcome
    }

    private static func enroll(
        client: AppAttestClient
    ) async -> AppAttestGuestCapabilityEnrollmentOutcome {
        let truth = await client.attestInstallation()
        switch truth {
        case .verified(let verified) where verified.kind == .assertion:
            return Self.outcome(for: verified)
        case .verified(let verified) where verified.kind == .attestation:
            return Self.outcome(
                for: await client.assert(
                    requestBody: Self.enrollmentRequestBody
                )
            )
        case .unavailable(let reason):
            return .unavailable(reason)
        case .invalid(let reason):
            return .invalid(reason)
        case .verified:
            return .invalid(.serverRejected)
        }
    }

    private static func outcome(
        for truth: AppAttestTruth
    ) -> AppAttestGuestCapabilityEnrollmentOutcome {
        switch truth {
        case .verified(let verified):
            return outcome(for: verified)
        case .unavailable(let reason):
            return .unavailable(reason)
        case .invalid(let reason):
            return .invalid(reason)
        }
    }

    private static func outcome(
        for verified: VerifiedAppAttestTruth
    ) -> AppAttestGuestCapabilityEnrollmentOutcome {
        guard verified.kind == .assertion,
              verified.guestCapability != nil else {
            return .invalid(.serverRejected)
        }
        return .ready
    }
}

/**
 Keeps a guest bearer usable for the submission it is about to authorize.

 The wrapped provider resolves Clerk first. A Clerk token returns untouched and
 never consults guest custody. A signed-out installation without a bearer, or a
 resolved guest bearer inside the server's five-minute refresh window, earns a
 fresh verified assertion. If renewal does not produce another submission-safe
 bearer, the request fails closed.
 */
struct GuestCapabilityRenewingBearerTokenProvider: BearerTokenProviding {
    private static let minimumRemainingLifetime: TimeInterval = 5 * 60

    private let base: any BearerTokenProviding
    private let guestCapabilities: any GuestCapabilityBearerStoring
    private let now: @Sendable () -> Date
    private let renewGuestCapability:
        @Sendable () async -> AppAttestGuestCapabilityEnrollmentOutcome

    init(
        base: any BearerTokenProviding,
        guestCapabilities: any GuestCapabilityBearerStoring,
        renewGuestCapability: @escaping @Sendable () async
            -> AppAttestGuestCapabilityEnrollmentOutcome,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.base = base
        self.guestCapabilities = guestCapabilities
        self.renewGuestCapability = renewGuestCapability
        self.now = now
    }

    func bearerToken() async throws -> String {
        do {
            let resolved = try await base.bearerToken()
            guard Self.isGuestCapability(resolved) else {
                return resolved
            }
            if let bearer = storedBearer(matching: resolved),
               bearer.expiresAt.timeIntervalSince(now())
                > Self.minimumRemainingLifetime {
                return resolved
            }
        } catch BearerTokenProviderError.sessionAbsent {
            // The signed-out path gets one chance to earn the missing bearer.
            // Any other Clerk error remains an account error and propagates.
        }

        guard await renewGuestCapability() == .ready else {
            throw BearerTokenProviderError.sessionAbsent
        }

        let renewed = try await base.bearerToken()
        guard Self.isGuestCapability(renewed) else {
            return renewed
        }
        guard let renewedBearer = storedBearer(matching: renewed),
              renewedBearer.expiresAt.timeIntervalSince(now())
                > Self.minimumRemainingLifetime else {
            throw BearerTokenProviderError.sessionAbsent
        }
        return renewed
    }

    func principalBoundBearer() async throws -> PrincipalBoundBearer {
        try await base.principalBoundBearer()
    }

    func itemRunSubmissionScopedBearer() async throws
        -> ItemRunSubmissionScopedBearer {
        do {
            let resolved = try await base.itemRunSubmissionScopedBearer()
            guard Self.isGuestCapability(resolved.bearerToken) else {
                return resolved
            }
            if let bearer = storedBearer(matching: resolved.bearerToken),
               bearer.expiresAt.timeIntervalSince(now())
                > Self.minimumRemainingLifetime {
                return resolved
            }
        } catch BearerTokenProviderError.sessionAbsent {
            // The signed-out path gets one chance to earn the missing bearer.
            // Any other Clerk error remains an account error and propagates.
        }

        guard await renewGuestCapability() == .ready else {
            throw BearerTokenProviderError.sessionAbsent
        }

        let renewed = try await base.itemRunSubmissionScopedBearer()
        guard Self.isGuestCapability(renewed.bearerToken) else {
            return renewed
        }
        guard let renewedBearer = storedBearer(
            matching: renewed.bearerToken
        ), renewedBearer.expiresAt.timeIntervalSince(now())
            > Self.minimumRemainingLifetime else {
            throw BearerTokenProviderError.sessionAbsent
        }
        return renewed
    }

    private func storedBearer(matching token: String) -> GuestCapabilityBearer? {
        guard let bearer = try? guestCapabilities.load(),
              bearer.token == token else {
            return nil
        }
        return bearer
    }

    private static func isGuestCapability(_ token: String) -> Bool {
        token.hasPrefix("guestcap_")
    }
}

/** Launch-owned App Attest work and the bearer provider it refreshes. */
struct AppAttestGuestCapabilityComposition: Sendable {
    private static let appID = "35YFS8XJRQ.dev.snaplist.ios"

    let tokenProvider: any BearerTokenProviding

    private let launchEnrollment: @Sendable () async -> Void

    init(
        baseTokenProvider: any BearerTokenProviding,
        guestCapabilities: any GuestCapabilityBearerStoring,
        enrollGuestCapability: @escaping @Sendable () async
            -> AppAttestGuestCapabilityEnrollmentOutcome,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        launchEnrollment = {
            do {
                _ = try await baseTokenProvider.principalBoundBearer()
                return
            } catch BearerTokenProviderError.sessionAbsent {
                // Only a confirmed signed-out installation may do guest work.
            } catch {
                // Clerk trouble is not evidence of a signed-out installation.
                // Preserve account precedence instead of downgrading to guest.
                return
            }

            do {
                if let bearer = try guestCapabilities.load(),
                   bearer.isUsable(at: now()) {
                    return
                }
            } catch {
                // An unreadable Keychain is not proof that no capability exists.
                // Stay fail-closed instead of rotating unknown live authority.
                return
            }
            _ = await enrollGuestCapability()
        }
        tokenProvider = GuestCapabilityRenewingBearerTokenProvider(
            base: baseTokenProvider,
            guestCapabilities: guestCapabilities,
            renewGuestCapability: enrollGuestCapability,
            now: now
        )
    }

    static func makeLive(
        apiOrigin: URL,
        baseTokenProvider: any BearerTokenProviding,
        session: URLSession = .shared
    ) -> Self {
        let guestCapabilities = KeychainGuestCapabilityBearerStore()
        let enrollment = AppAttestGuestCapabilityEnrollment(
            client: AppAttestClient(
                appID: appID,
                environment: .production,
                guestCapabilityStore: guestCapabilities,
                server: URLSessionAppAttestServerClient(
                    apiOrigin: apiOrigin,
                    session: session
                )
            )
        )
        return Self(
            baseTokenProvider: baseTokenProvider,
            guestCapabilities: guestCapabilities,
            enrollGuestCapability: {
                await enrollment.enrollIfNeeded()
            }
        )
    }

    /// Starts before the seller can submit, without making Apple or network
    /// availability a gate on rendering the existing signed-out experience.
    @discardableResult
    func beginLaunchEnrollment() -> Task<Void, Never> {
        let launchEnrollment = launchEnrollment
        return Task {
            await launchEnrollment()
        }
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
