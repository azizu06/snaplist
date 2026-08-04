import CryptoKit
import Foundation
import Security

struct GuestRecoverySubmissionIdentity: Codable, Equatable, Sendable {
    let recoveryID: UUID
    let recoveryTokenHash: String
}

struct GuestPhotoIdentity: Codable, Equatable, Sendable {
    let kind: String
    let fingerprint: String
}

struct GuestClaimAuthority: Codable, Equatable, Sendable {
    let recoveryID: UUID
    let recoveryToken: String
    let itemID: UUID
    let runID: UUID
    let draftID: UUID
    let reviewRevision: UUID
    let photoIdentity: GuestPhotoIdentity
}

struct GuestRecoveryCredential: Codable, Equatable, Sendable {
    let recoveryID: UUID
    let recoveryToken: String
    let recoveryTokenHash: String
    var itemID: UUID?
    var runID: UUID?
    var photoIdentity: GuestPhotoIdentity?
    var expiresAt: Date? = nil

    var submissionIdentity: GuestRecoverySubmissionIdentity {
        GuestRecoverySubmissionIdentity(
            recoveryID: recoveryID,
            recoveryTokenHash: recoveryTokenHash
        )
    }
}

enum GuestClaimAuthorityAssembler {
    static func assemble(
        credential: GuestRecoveryCredential,
        binding: ListingReviewBinding
    ) -> GuestClaimAuthority? {
        guard credential.itemID == binding.itemID,
              credential.runID == binding.runID,
              let photoIdentity = credential.photoIdentity else {
            return nil
        }
        return GuestClaimAuthority(
            recoveryID: credential.recoveryID,
            recoveryToken: credential.recoveryToken,
            itemID: binding.itemID,
            runID: binding.runID,
            draftID: binding.listingID,
            reviewRevision: binding.reviewRevision,
            photoIdentity: photoIdentity
        )
    }
}

protocol GuestRecoveryCredentialStoring: Sendable {
    /// Mints 32 random bytes, writes the raw token to Keychain, then returns the
    /// hash-only identity that may enter a submission attempt or HTTP request.
    func mintCredential() async throws -> GuestRecoverySubmissionIdentity
    func contains(
        _ identity: GuestRecoverySubmissionIdentity
    ) async throws -> Bool
    func bind(
        _ identity: GuestRecoverySubmissionIdentity,
        itemID: UUID,
        runID: UUID,
        photoIdentity: GuestPhotoIdentity
    ) async throws
    func credential(runID: UUID) async throws -> GuestRecoveryCredential?
    func credential(recoveryID: UUID) async throws -> GuestRecoveryCredential?
    func setExpiry(recoveryID: UUID, expiresAt: Date) async throws
    func purge(recoveryID: UUID) async throws
}

protocol GuestClaimAuthorityStoring: Sendable {
    func authority(listingID: UUID) async throws -> GuestClaimAuthority?
    func save(_ authority: GuestClaimAuthority, listingID: UUID) async throws
    func purge(recoveryID: UUID) async throws
}

struct KeychainGuestRecoveryCredentialStore: GuestRecoveryCredentialStoring {
    private let vault = KeychainGuestRecoveryCredentialVault.shared

    func mintCredential() async throws -> GuestRecoverySubmissionIdentity {
        try await vault.mintCredential()
    }

    func contains(
        _ identity: GuestRecoverySubmissionIdentity
    ) async throws -> Bool {
        try await vault.contains(identity)
    }

    func bind(
        _ identity: GuestRecoverySubmissionIdentity,
        itemID: UUID,
        runID: UUID,
        photoIdentity: GuestPhotoIdentity
    ) async throws {
        try await vault.bind(
            identity,
            itemID: itemID,
            runID: runID,
            photoIdentity: photoIdentity
        )
    }

    func credential(runID: UUID) async throws -> GuestRecoveryCredential? {
        try await vault.credential(runID: runID)
    }

    func credential(
        recoveryID: UUID
    ) async throws -> GuestRecoveryCredential? {
        try await vault.credential(recoveryID: recoveryID)
    }

    func setExpiry(recoveryID: UUID, expiresAt: Date) async throws {
        try await vault.setExpiry(recoveryID: recoveryID, expiresAt: expiresAt)
    }

    func purge(recoveryID: UUID) async throws {
        try await vault.purge(recoveryID: recoveryID)
    }
}

private actor KeychainGuestRecoveryCredentialVault {
    static let shared = KeychainGuestRecoveryCredentialVault()

    private let service = "dev.snaplist.ios.guest-recovery-credential"
    private let account = "recovery-credentials-v1"

    func mintCredential() throws -> GuestRecoverySubmissionIdentity {
        var bytes = [UInt8](repeating: 0, count: 32)
        let randomStatus = bytes.withUnsafeMutableBytes { buffer in
            SecRandomCopyBytes(
                kSecRandomDefault,
                buffer.count,
                buffer.baseAddress!
            )
        }
        guard randomStatus == errSecSuccess else {
            throw KeychainGuestRecoveryError(status: randomStatus)
        }
        let token = Data(bytes).base64URLEncodedString()
        let hash = SHA256.hash(data: Data(token.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
        let recoveryID = UUID()
        var credentials = try load()
        credentials[recoveryID] = GuestRecoveryCredential(
            recoveryID: recoveryID,
            recoveryToken: token,
            recoveryTokenHash: hash,
            itemID: nil,
            runID: nil,
            photoIdentity: nil
        )
        try write(credentials)
        return credentials[recoveryID]!.submissionIdentity
    }

    func contains(
        _ identity: GuestRecoverySubmissionIdentity
    ) throws -> Bool {
        var credentials = try load()
        guard let stored = credentials[identity.recoveryID],
              let credential = try retainedCredential(
                  stored,
                  in: &credentials
              ) else {
            return false
        }
        return credential.recoveryTokenHash == identity.recoveryTokenHash
    }

    func bind(
        _ identity: GuestRecoverySubmissionIdentity,
        itemID: UUID,
        runID: UUID,
        photoIdentity: GuestPhotoIdentity
    ) throws {
        var credentials = try load()
        guard var credential = credentials[identity.recoveryID],
              credential.recoveryTokenHash == identity.recoveryTokenHash,
              credential.itemID == nil || credential.itemID == itemID,
              credential.runID == nil || credential.runID == runID,
              credential.photoIdentity == nil
                || credential.photoIdentity == photoIdentity else {
            throw KeychainGuestRecoveryError(status: errSecParam)
        }
        credential.itemID = itemID
        credential.runID = runID
        credential.photoIdentity = photoIdentity
        credentials[identity.recoveryID] = credential
        try write(credentials)
    }

    func credential(runID: UUID) throws -> GuestRecoveryCredential? {
        var credentials = try load()
        guard let credential = credentials.values.first(where: {
            $0.runID == runID
        }) else { return nil }
        return try retainedCredential(credential, in: &credentials)
    }

    func credential(recoveryID: UUID) throws -> GuestRecoveryCredential? {
        var credentials = try load()
        guard let credential = credentials[recoveryID] else { return nil }
        return try retainedCredential(credential, in: &credentials)
    }

    func setExpiry(recoveryID: UUID, expiresAt: Date) throws {
        var credentials = try load()
        guard var credential = credentials[recoveryID],
              credential.runID != nil,
              credential.itemID != nil,
              credential.photoIdentity != nil else {
            throw KeychainGuestRecoveryError(status: errSecParam)
        }
        credential.expiresAt = expiresAt
        credentials[recoveryID] = credential
        try write(credentials)
    }

    func purge(recoveryID: UUID) throws {
        var credentials = try load()
        credentials.removeValue(forKey: recoveryID)
        try write(credentials)
    }

    private func retainedCredential(
        _ credential: GuestRecoveryCredential,
        in credentials: inout [UUID: GuestRecoveryCredential]
    ) throws -> GuestRecoveryCredential? {
        guard let expiresAt = credential.expiresAt,
              expiresAt <= Date() else {
            return credential
        }
        credentials.removeValue(forKey: credential.recoveryID)
        try write(credentials)
        return nil
    }

    private func load() throws -> [UUID: GuestRecoveryCredential] {
        try KeychainGuestRecoveryDictionary.load(
            service: service,
            account: account
        )
    }

    private func write(
        _ credentials: [UUID: GuestRecoveryCredential]
    ) throws {
        try KeychainGuestRecoveryDictionary.write(
            credentials,
            service: service,
            account: account
        )
    }
}

/// This service/account and Codable shape intentionally match #377's claim
/// consumer so a locally assembled authority is immediately usable after that
/// issue rebases onto this producer.
actor KeychainGuestClaimAuthorityStore: GuestClaimAuthorityStoring {
    private let service = "dev.snaplist.ios.guest-claim-authority"
    private let account = "listing-authorities-v1"

    func authority(listingID: UUID) throws -> GuestClaimAuthority? {
        try load()[listingID]
    }

    func save(
        _ authority: GuestClaimAuthority,
        listingID: UUID
    ) throws {
        var authorities = try load()
        authorities[listingID] = authority
        try write(authorities)
    }

    func purge(recoveryID: UUID) throws {
        var authorities = try load()
        authorities = authorities.filter { $0.value.recoveryID != recoveryID }
        try write(authorities)
    }

    private func load() throws -> [UUID: GuestClaimAuthority] {
        try KeychainGuestRecoveryDictionary.load(
            service: service,
            account: account
        )
    }

    private func write(
        _ authorities: [UUID: GuestClaimAuthority]
    ) throws {
        try KeychainGuestRecoveryDictionary.write(
            authorities,
            service: service,
            account: account
        )
    }
}

private enum KeychainGuestRecoveryDictionary {
    static func load<Value: Decodable>(
        service: String,
        account: String
    ) throws -> [UUID: Value] {
        var query = baseQuery(service: service, account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return [:] }
        guard status == errSecSuccess, let data = result as? Data else {
            throw KeychainGuestRecoveryError(status: status)
        }
        do {
            return try JSONDecoder().decode([UUID: Value].self, from: data)
        } catch {
            throw KeychainGuestRecoveryError(status: errSecDecode)
        }
    }

    static func write<Value: Encodable>(
        _ values: [UUID: Value],
        service: String,
        account: String
    ) throws {
        let query = baseQuery(service: service, account: account)
        if values.isEmpty {
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else {
                throw KeychainGuestRecoveryError(status: status)
            }
            return
        }
        let data = try JSONEncoder().encode(values)
        let attributes = [kSecValueData as String: data]
        let update = SecItemUpdate(
            query as CFDictionary,
            attributes as CFDictionary
        )
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else {
            throw KeychainGuestRecoveryError(status: update)
        }
        var insert = query
        insert[kSecValueData as String] = data
        insert[kSecAttrAccessible as String] =
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(insert as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw KeychainGuestRecoveryError(status: status)
        }
    }

    private static func baseQuery(
        service: String,
        account: String
    ) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}

private struct KeychainGuestRecoveryError: Error {
    let status: OSStatus
}

private extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
