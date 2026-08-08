import ClerkKit
import Foundation

actor KeychainGuestClaimHandoffStore: GuestClaimHandoffStoring {
    private let service = "dev.snaplist.ios.guest-claim-handoff"
    private let account = "retained-handoffs-v1"

    func handoff(recoveryID: UUID) throws -> GuestClaimHandoff? {
        try load()[recoveryID]
    }

    func save(_ handoff: GuestClaimHandoff) throws {
        var handoffs = try load()
        handoffs[handoff.recoveryID] = handoff
        try write(handoffs)
    }

    func purge(recoveryID: UUID) throws {
        var handoffs = try load()
        handoffs[recoveryID] = nil
        try write(handoffs)
    }

    private func load() throws -> [UUID: GuestClaimHandoff] {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return [:] }
        guard status == errSecSuccess, let data = result as? Data else {
            throw KeychainGuestClaimHandoffError(status: status)
        }
        return try JSONDecoder().decode(
            [UUID: GuestClaimHandoff].self,
            from: data
        )
    }

    private func write(_ handoffs: [UUID: GuestClaimHandoff]) throws {
        if handoffs.isEmpty {
            let status = SecItemDelete(baseQuery as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else {
                throw KeychainGuestClaimHandoffError(status: status)
            }
            return
        }
        let data = try JSONEncoder().encode(handoffs)
        let attributes = [kSecValueData as String: data]
        let updateStatus = SecItemUpdate(
            baseQuery as CFDictionary,
            attributes as CFDictionary
        )
        if updateStatus == errSecSuccess { return }
        guard updateStatus == errSecItemNotFound else {
            throw KeychainGuestClaimHandoffError(status: updateStatus)
        }
        var insert = baseQuery
        insert[kSecValueData as String] = data
        insert[kSecAttrAccessible as String] =
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let insertStatus = SecItemAdd(insert as CFDictionary, nil)
        guard insertStatus == errSecSuccess else {
            throw KeychainGuestClaimHandoffError(status: insertStatus)
        }
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}

private struct KeychainGuestClaimHandoffError: Error {
    let status: OSStatus
}

struct UnavailableGuestClaimService: GuestClaimServing {
    func prepareHandoff(authority: GuestClaimAuthority) async throws {
        throw GuestClaimServiceError.unavailable
    }

    func claim(
        authority: GuestClaimAuthority,
        idempotencyKey: UUID
    ) async throws -> GuestClaimOutcome {
        throw GuestClaimServiceError.unavailable
    }

    func claim(
        authority: GuestClaimAuthority,
        idempotencyKey: UUID,
        authenticatedBy bearer: PrincipalBoundBearer
    ) async throws -> GuestClaimOutcome {
        throw GuestClaimServiceError.unavailable
    }
}

struct UnavailableGuestAccountAuthenticator: GuestAccountAuthenticating {
    func sendCode(to email: String) async throws {
        throw GuestClaimServiceError.unavailable
    }
    func verify(code: String) async throws {
        throw GuestClaimServiceError.unavailable
    }
}

struct ClerkAccountEntrySessionSource: AccountEntrySessionSourcing {
    private let tokenProvider: any BearerTokenProviding

    init(tokenProvider: any BearerTokenProviding) {
        self.tokenProvider = tokenProvider
    }

    func snapshot() async -> AccountEntrySessionSnapshot {
        await MainActor.run {
            AccountEntrySessionSnapshot(
                isActive: Clerk.shared.session?.status == .active,
                userID: Clerk.shared.user?.id
            )
        }
    }

    func principalBoundBearer() async throws -> PrincipalBoundBearer {
        try await tokenProvider.principalBoundBearer()
    }
}

struct UnavailableAccountEntrySessionSource: AccountEntrySessionSourcing {
    func snapshot() async -> AccountEntrySessionSnapshot {
        AccountEntrySessionSnapshot(isActive: false, userID: nil)
    }

    func principalBoundBearer() async throws -> PrincipalBoundBearer {
        throw BearerTokenProviderError.sessionAbsent
    }
}

enum GuestClaimCanonicalRequest {
    private struct ClientData: Encodable {
        let photoIdentity: GuestPhotoIdentity
        let purpose = "guest-claim-handoff"
        let recoveryId: String
        let recoveryToken: String
        let version = 1
    }

    static func data(for authority: GuestClaimAuthority) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(
            ClientData(
                photoIdentity: authority.photoIdentity,
                recoveryId: authority.recoveryID.uuidString.lowercased(),
                recoveryToken: authority.recoveryToken
            )
        )
    }
}

struct GuestClaimAPIClient: GuestClaimServing {
    private let baseURL: URL
    private let proofProvider: any AppAttestProofProviding
    private let tokenProvider: any BearerTokenProviding
    private let handoffStore: any GuestClaimHandoffStoring
    private let session: URLSession
    private let encoder: JSONEncoder
    private let decoder = JSONDecoder()

    init(
        baseURL: URL,
        proofProvider: any AppAttestProofProviding,
        tokenProvider: any BearerTokenProviding,
        handoffStore: any GuestClaimHandoffStoring,
        session: URLSession = .shared
    ) {
        self.baseURL = baseURL
        self.proofProvider = proofProvider
        self.tokenProvider = tokenProvider
        self.handoffStore = handoffStore
        self.session = session
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        self.encoder = encoder
    }

    func claim(
        authority: GuestClaimAuthority,
        idempotencyKey: UUID
    ) async throws -> GuestClaimOutcome {
        try await claim(
            authority: authority,
            idempotencyKey: idempotencyKey,
            authenticatedBy: try await tokenProvider.principalBoundBearer()
        )
    }

    func claim(
        authority: GuestClaimAuthority,
        idempotencyKey: UUID,
        authenticatedBy bearer: PrincipalBoundBearer
    ) async throws -> GuestClaimOutcome {
        guard let handoff = try await handoffStore.handoff(
            recoveryID: authority.recoveryID
        ), handoff.isUsable(for: authority) else {
            throw GuestClaimServiceError.proofUnavailable
        }
        var request = URLRequest(
            url: baseURL.appending(path: "/v1/guest/claims")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(
            "Bearer \(bearer.bearerToken)",
            forHTTPHeaderField: "Authorization"
        )
        request.setValue(
            idempotencyKey.uuidString.lowercased(),
            forHTTPHeaderField: "Idempotency-Key"
        )
        request.setValue(
            handoff.token,
            forHTTPHeaderField: "X-SnapList-Guest-Handoff"
        )

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            do {
                if let resolved = try await resolveClaim(
                    authority: authority,
                    authenticatedBy: bearer
                ) {
                    return resolved
                }
            } catch GuestClaimServiceError.proofUnavailable {
                throw GuestClaimServiceError.proofUnavailable
            } catch {
                // The authenticated read is only a reconciliation witness. A
                // failed read cannot prove the mutation did or did not commit.
            }
            do {
                try await handoffStore.purge(recoveryID: authority.recoveryID)
            } catch {
                throw GuestClaimServiceError.proofUnavailable
            }
            throw GuestClaimServiceError.unavailable
        }
        // The server consumes one-use handoffs before running the idempotent
        // claim. Any HTTP response therefore retires this local copy too.
        do {
            try await handoffStore.purge(recoveryID: authority.recoveryID)
        } catch {
            throw GuestClaimServiceError.proofUnavailable
        }
        guard let http = response as? HTTPURLResponse else {
            throw GuestClaimServiceError.unavailable
        }
        if http.statusCode == 409 {
            throw Self.conflict(in: data)
        }
        guard (200..<300).contains(http.statusCode),
              let payload = try? decoder.decode(
                Envelope<ClaimPayload>.self,
                from: data
              ).data else {
            throw GuestClaimServiceError.unavailable
        }
        let listing = ClaimedGuestListing(
            itemID: payload.itemID,
            runID: payload.runID,
            draftID: payload.draftID
        )
        guard listing.itemID == authority.itemID,
              listing.runID == authority.runID,
              listing.draftID == authority.draftID else {
            throw GuestClaimServiceError.unavailable
        }
        switch payload.outcome {
        case .claimed: return .claimed(listing)
        case .expired: return .expired(listing)
        }
    }

    func prepareHandoff(
        authority: GuestClaimAuthority
    ) async throws {
        if let handoff = try await handoffStore.handoff(
            recoveryID: authority.recoveryID
        ), handoff.isUsable(for: authority) {
            return
        }
        let handoff = try await issueHandoff(authority: authority)
        do {
            try await handoffStore.save(handoff)
        } catch {
            throw GuestClaimServiceError.proofUnavailable
        }
    }

    func resolveClaim(
        authority: GuestClaimAuthority
    ) async throws -> GuestClaimOutcome? {
        try await resolveClaim(
            authority: authority,
            authenticatedBy: try await tokenProvider.principalBoundBearer()
        )
    }

    func resolveClaim(
        authority: GuestClaimAuthority,
        authenticatedBy bearer: PrincipalBoundBearer
    ) async throws -> GuestClaimOutcome? {
        guard let listing = try await resolveClaimedListing(
            authority: authority,
            authenticatedBy: bearer
        ) else {
            return nil
        }
        do {
            try await handoffStore.purge(recoveryID: authority.recoveryID)
        } catch {
            throw GuestClaimServiceError.proofUnavailable
        }
        return .claimed(listing)
    }

    private func issueHandoff(
        authority: GuestClaimAuthority
    ) async throws -> GuestClaimHandoff {
        let clientData = try GuestClaimCanonicalRequest.data(for: authority)
        let proofOutcome = await proofProvider.assertionProof(
            requestBody: clientData
        )
        guard case .proof(let proof) = proofOutcome else {
            throw GuestClaimServiceError.proofUnavailable
        }
        let body = HandoffBody(
            assertionObject: proof.assertionObject.base64EncodedString(),
            challengeId: proof.challengeID.uuidString.lowercased(),
            clientData: clientData.base64EncodedString(),
            keyId: proof.keyID,
            operation: "handoff"
        )
        var request = URLRequest(
            url: baseURL.appending(path: "/v1/guest/attestations")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(body)

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw GuestClaimServiceError.unavailable
        }
        guard let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode),
              let handoff = try? decoder.decode(
                Envelope<HandoffPayload>.self,
                from: data
              ).data,
              let expiresAt = Self.date(handoff.expiresAt) else {
            throw GuestClaimServiceError.proofUnavailable
        }
        let retained = GuestClaimHandoff(
            token: handoff.handoffToken,
            expiresAt: expiresAt,
            recoveryID: handoff.recoveryID,
            photoIdentity: handoff.photoIdentity
        )
        guard retained.isUsable(for: authority) else {
            throw GuestClaimServiceError.proofUnavailable
        }
        return retained
    }

    private static func date(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        return ISO8601DateFormatter().date(from: value)
    }

    private static func conflict(in data: Data) -> GuestClaimServiceError {
        let details = try? JSONDecoder().decode(
            ErrorEnvelope.self,
            from: data
        ).error.details
        switch (details?.reason, details?.claimStage) {
        case ("guest_claim_allowance_spent", "post_copy"):
            return .allowanceSpentAfterCopy
        case ("guest_claim_allowance_in_flight", "post_copy"):
            return .allowanceInFlightAfterCopy
        case ("guest_claim_allowance_spent", _): return .allowanceSpent
        case ("guest_claim_allowance_in_flight", _): return .allowanceInFlight
        case ("guest_claim_in_progress", _): return .busy
        default: return .conflict
        }
    }

    private func resolveClaimedListing(
        authority: GuestClaimAuthority,
        authenticatedBy bearer: PrincipalBoundBearer
    ) async throws -> ClaimedGuestListing? {
        let runID = authority.runID.uuidString.lowercased()
        var request = URLRequest(
            url: baseURL.appending(
                path: "/v1/runs/\(runID)"
            )
        )
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(
            "Bearer \(bearer.bearerToken)",
            forHTTPHeaderField: "Authorization"
        )
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw GuestClaimServiceError.unavailable
        }
        if http.statusCode == 404 { return nil }
        guard http.statusCode == 200,
              let run = try? decoder.decode(
                Envelope<ResolvedRun>.self,
                from: data
              ).data,
              run.id == authority.runID,
              run.itemID == authority.itemID,
              run.listingID == authority.draftID else {
            throw GuestClaimServiceError.unavailable
        }
        return ClaimedGuestListing(
            itemID: run.itemID,
            runID: run.id,
            draftID: run.listingID
        )
    }

    private struct Envelope<Payload: Decodable>: Decodable {
        let data: Payload
    }

    private struct HandoffBody: Encodable {
        let assertionObject: String
        let challengeId: String
        let clientData: String
        let keyId: String
        let operation: String
    }

    private struct HandoffPayload: Decodable {
        let handoffToken: String
        let expiresAt: String
        let recoveryID: UUID
        let photoIdentity: GuestPhotoIdentity

        private enum CodingKeys: String, CodingKey {
            case handoffToken
            case expiresAt
            case recoveryID = "recoveryId"
            case photoIdentity
        }
    }

    private struct ClaimPayload: Decodable {
        enum Outcome: String, Decodable {
            case claimed
            case expired
        }

        let outcome: Outcome
        let itemID: UUID
        let runID: UUID
        let draftID: UUID

        private enum CodingKeys: String, CodingKey {
            case outcome
            case itemID = "itemId"
            case runID = "runId"
            case draftID = "draftId"
        }
    }

    private struct ResolvedRun: Decodable {
        let id: UUID
        let itemID: UUID
        let listingID: UUID

        private enum CodingKeys: String, CodingKey {
            case id
            case itemID = "itemId"
            case listingID = "listingId"
        }
    }

    private struct ErrorEnvelope: Decodable {
        struct Payload: Decodable {
            struct Details: Decodable {
                let reason: String?
                let claimStage: String?
            }
            let details: Details?
        }
        let error: Payload
    }
}

@MainActor
final class ClerkGuestAccountAuthenticator:
    GuestAccountAuthenticating,
    @unchecked Sendable {
    private enum Attempt {
        case signIn(SignIn)
        case signUp(SignUp)
    }

    private var attempt: Attempt?

    nonisolated init() {}

    func sendCode(to email: String) async throws {
        do {
            attempt = .signIn(
                try await Clerk.shared.auth.signInWithEmailCode(
                    emailAddress: email
                )
            )
        } catch let error as ClerkAPIError where [
            "form_identifier_not_found",
            "invitation_account_not_exists",
        ].contains(error.code) {
            let signUp = try await Clerk.shared.auth.signUp(emailAddress: email)
            attempt = .signUp(try await signUp.sendEmailCode())
        }
    }

    func verify(code: String) async throws {
        let sessionID: String?
        switch attempt {
        case .signIn(let signIn):
            let verified = try await signIn.verifyCode(code)
            guard verified.status == .complete else {
                throw GuestClaimServiceError.unavailable
            }
            sessionID = verified.createdSessionId
            attempt = .signIn(verified)
        case .signUp(let signUp):
            let verified = try await signUp.verifyEmailCode(code)
            guard verified.status == .complete else {
                throw GuestClaimServiceError.unavailable
            }
            sessionID = verified.createdSessionId
            attempt = .signUp(verified)
        case nil:
            throw GuestClaimServiceError.unavailable
        }
        guard let sessionID else {
            throw GuestClaimServiceError.unavailable
        }
        try await Clerk.shared.auth.setActive(sessionId: sessionID)
    }

    func activeClerkUserID() async -> String? {
        Clerk.shared.user?.id
    }
}
