import CryptoKit
import Foundation
import Observation

struct AccountEntrySessionSnapshot: Equatable, Sendable {
    let isActive: Bool
    let userID: String?
}

protocol AccountEntrySessionSourcing: Sendable {
    func snapshot() async -> AccountEntrySessionSnapshot
    func principalBoundBearer() async throws -> PrincipalBoundBearer
}

struct AccountEntryQualifiedSession: Sendable {
    let userID: String
    let bearer: PrincipalBoundBearer
    let refreshBearer: @Sendable () async throws -> PrincipalBoundBearer
}

protocol AccountEntryQualifiedSessionHandling: Sendable {
    func handle(_ session: AccountEntryQualifiedSession) async
}

enum AccountEntrySessionSignal: Equatable, Sendable {
    case dismissed
    case authenticationChanged
}

enum AccountEntryPresentationTransition {
    static func signal(
        baseline: AccountEntrySessionSnapshot?,
        current: AccountEntrySessionSnapshot
    ) -> AccountEntrySessionSignal {
        let baselineUserID = normalizedUserID(baseline?.userID)
        let currentUserID = normalizedUserID(current.userID)
        guard current.isActive,
              currentUserID != nil,
              baseline?.isActive != true || baselineUserID != currentUserID else {
            return .dismissed
        }
        return .authenticationChanged
    }

    private static func normalizedUserID(_ value: String?) -> String? {
        guard let userID = value?.trimmingCharacters(
            in: .whitespacesAndNewlines
        ), !userID.isEmpty else {
            return nil
        }
        return userID
    }
}

enum AccountEntrySessionResolution: Equatable, Sendable {
    case preserved
    case continued
    case alreadyContinued
}

actor AccountEntrySessionResolver {
    private let source: any AccountEntrySessionSourcing
    private let handler: any AccountEntryQualifiedSessionHandling
    private var hasContinued = false

    init(
        source: any AccountEntrySessionSourcing,
        handler: any AccountEntryQualifiedSessionHandling
    ) {
        self.source = source
        self.handler = handler
    }

    func resolve(
        _ signal: AccountEntrySessionSignal,
        snapshot suppliedSnapshot: AccountEntrySessionSnapshot? = nil
    ) async -> AccountEntrySessionResolution {
        guard case .authenticationChanged = signal else {
            return .preserved
        }
        return await resolveCurrentSession(snapshot: suppliedSnapshot)
    }

    func resolveCurrentSession(
        snapshot suppliedSnapshot: AccountEntrySessionSnapshot? = nil
    ) async -> AccountEntrySessionResolution {
        guard !hasContinued else {
            return .alreadyContinued
        }
        let snapshot: AccountEntrySessionSnapshot
        if let suppliedSnapshot {
            snapshot = suppliedSnapshot
        } else {
            snapshot = await source.snapshot()
        }
        let userID = snapshot.userID?.trimmingCharacters(
            in: .whitespacesAndNewlines
        )
        guard snapshot.isActive,
              let userID,
              !userID.isEmpty,
              let expectedProof = ItemRunSubmissionPrincipalScopeProof(
                verifiedClerkSubject: userID
              ),
              let bearer = try? await source.principalBoundBearer(),
              bearer.scopeProof == expectedProof else {
            return .preserved
        }
        hasContinued = true
        let refreshSource = source
        await handler.handle(
            AccountEntryQualifiedSession(
                userID: userID,
                bearer: bearer,
                refreshBearer: {
                    try await refreshSource.principalBoundBearer()
                }
            )
        )
        return .continued
    }
}

enum GuestClaimListingThumbnail: Equatable, Sendable {
    case authoritative(URL)
    case neutral
}

struct GuestClaimListingProjection: Equatable, Sendable {
    let title: String
    let effectivePrice: Decimal
    let thumbnail: GuestClaimListingThumbnail
    let expiresAt: Date

    static func project(
        snapshot: ListingReviewResult,
        draft: ListingReviewDraft,
        isDirty: Bool,
        authority: GuestClaimAuthority,
        credential: GuestRecoveryCredential,
        now: Date
    ) -> Self? {
        let binding = snapshot.binding
        let title = draft.title.trimmingCharacters(
            in: .whitespacesAndNewlines
        )
        let effectivePrice = draft.sellerPriceOverride
            ?? snapshot.pricing.suggestedPrice
        guard !isDirty,
              binding.itemID == authority.itemID,
              binding.runID == authority.runID,
              binding.listingID == authority.draftID,
              binding.reviewRevision == authority.reviewRevision,
              credential.recoveryID == authority.recoveryID,
              credential.recoveryToken == authority.recoveryToken,
              credential.recoveryTokenHash == tokenHash(
                authority.recoveryToken
              ),
              credential.itemID == authority.itemID,
              credential.runID == authority.runID,
              credential.photoIdentity == authority.photoIdentity,
              let expiresAt = credential.expiresAt,
              expiresAt > now,
              !title.isEmpty,
              isValidPrice(effectivePrice) else {
            return nil
        }
        let thumbnail = snapshot.photos.min(by: {
            $0.ordinal < $1.ordinal
        }).map {
            GuestClaimListingThumbnail.authoritative($0.url)
        } ?? .neutral
        return GuestClaimListingProjection(
            title: title,
            effectivePrice: effectivePrice,
            thumbnail: thumbnail,
            expiresAt: expiresAt
        )
    }

    static func tokenHash(_ token: String) -> String {
        SHA256.hash(data: Data(token.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }

    private static func isValidPrice(_ price: Decimal) -> Bool {
        guard !price.isNaN, price > 0 else { return false }
        var input = price
        var normalized = Decimal()
        NSDecimalRound(&normalized, &input, 2, .plain)
        return normalized == price
    }
}

enum GuestClaimEntryResolution: Equatable, Sendable {
    case noAuthority
    case rejectedAuthority
    case claim(
        authority: GuestClaimAuthority,
        projection: GuestClaimListingProjection
    )
}

struct GuestClaimEntryResolver: Sendable {
    private let authorityStore: any GuestClaimAuthorityStoring
    private let credentialStore: any GuestRecoveryCredentialStoring
    private let now: @Sendable () -> Date

    init(
        authorityStore: any GuestClaimAuthorityStoring,
        credentialStore: any GuestRecoveryCredentialStoring,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.authorityStore = authorityStore
        self.credentialStore = credentialStore
        self.now = now
    }

    func resolve(
        listingID: UUID,
        snapshot: ListingReviewResult,
        draft: ListingReviewDraft,
        isDirty: Bool
    ) async -> GuestClaimEntryResolution {
        do {
            guard let authority = try await authorityStore.authority(
                listingID: listingID
            ) else {
                return .noAuthority
            }
            guard authority.draftID == listingID,
                  let credential = try await credentialStore.credential(
                    recoveryID: authority.recoveryID
                  ),
                  let projection = GuestClaimListingProjection.project(
                    snapshot: snapshot,
                    draft: draft,
                    isDirty: isDirty,
                    authority: authority,
                    credential: credential,
                    now: now()
                  ) else {
                return .rejectedAuthority
            }
            return .claim(
                authority: authority,
                projection: projection
            )
        } catch {
            return .rejectedAuthority
        }
    }
}

struct GuestClaimHandoff: Codable, Equatable, Sendable {
    let token: String
    let expiresAt: Date
    let recoveryID: UUID
    let photoIdentity: GuestPhotoIdentity

    func isUsable(
        for authority: GuestClaimAuthority,
        now: Date = .now
    ) -> Bool {
        token.hasPrefix("guesthandoff_v1.")
            && expiresAt > now
            && recoveryID == authority.recoveryID
            && photoIdentity == authority.photoIdentity
    }
}

struct ClaimedGuestListing: Codable, Equatable, Sendable {
    let itemID: UUID
    let runID: UUID
    let draftID: UUID

    private enum CodingKeys: String, CodingKey {
        case itemID = "itemId"
        case runID = "runId"
        case draftID = "draftId"
    }
}

enum GuestClaimOutcome: Equatable, Sendable {
    case claimed(ClaimedGuestListing)
    case expired(ClaimedGuestListing)
}

enum GuestClaimServiceError: Error, Equatable {
    case allowanceSpent
    case allowanceInFlight
    case allowanceSpentAfterCopy
    case allowanceInFlightAfterCopy
    case busy
    case conflict
    case proofUnavailable
    case unavailable
}

protocol GuestAccountAuthenticating: Sendable {
    func sendCode(to email: String) async throws
    func verify(code: String) async throws
    func activeClerkUserID() async -> String?
}

extension GuestAccountAuthenticating {
    func activeClerkUserID() async -> String? { nil }
}

protocol GuestClaimServing: Sendable {
    func prepareHandoff(authority: GuestClaimAuthority) async throws
    func resolveClaim(
        authority: GuestClaimAuthority
    ) async throws -> GuestClaimOutcome?
    func resolveClaim(
        authority: GuestClaimAuthority,
        authenticatedBy bearer: PrincipalBoundBearer
    ) async throws -> GuestClaimOutcome?
    func claim(
        authority: GuestClaimAuthority,
        idempotencyKey: UUID
    ) async throws -> GuestClaimOutcome
    func claim(
        authority: GuestClaimAuthority,
        idempotencyKey: UUID,
        authenticatedBy bearer: PrincipalBoundBearer
    ) async throws -> GuestClaimOutcome
}

extension GuestClaimServing {
    func resolveClaim(
        authority: GuestClaimAuthority
    ) async throws -> GuestClaimOutcome? { nil }

    func resolveClaim(
        authority: GuestClaimAuthority,
        authenticatedBy bearer: PrincipalBoundBearer
    ) async throws -> GuestClaimOutcome? {
        try await resolveClaim(authority: authority)
    }

    func claim(
        authority: GuestClaimAuthority,
        idempotencyKey: UUID,
        authenticatedBy bearer: PrincipalBoundBearer
    ) async throws -> GuestClaimOutcome {
        try await claim(
            authority: authority,
            idempotencyKey: idempotencyKey
        )
    }
}

protocol GuestClaimHandoffStoring: Sendable {
    func handoff(recoveryID: UUID) async throws -> GuestClaimHandoff?
    func save(_ handoff: GuestClaimHandoff) async throws
    func purge(recoveryID: UUID) async throws
}

struct NoopGuestClaimHandoffStore: GuestClaimHandoffStoring {
    func handoff(recoveryID: UUID) async throws -> GuestClaimHandoff? { nil }
    func save(_ handoff: GuestClaimHandoff) async throws {}
    func purge(recoveryID: UUID) async throws {}
}

struct NoopGuestClaimAuthorityStore: GuestClaimAuthorityStoring {
    func authority(listingID: UUID) async throws -> GuestClaimAuthority? { nil }
    func save(_ authority: GuestClaimAuthority, listingID: UUID) async throws {}
    func purge(recoveryID: UUID) async throws {}
}

struct GuestClaimAttempt: Codable, Equatable, Sendable {
    let recoveryID: UUID
    let idempotencyKey: UUID
    let postCopyDenial: Bool?

    init(
        recoveryID: UUID,
        idempotencyKey: UUID,
        postCopyDenial: Bool? = nil
    ) {
        self.recoveryID = recoveryID
        self.idempotencyKey = idempotencyKey
        self.postCopyDenial = postCopyDenial
    }
}

protocol GuestClaimAttemptStoring: Sendable {
    func attempt(recoveryID: UUID) async throws -> GuestClaimAttempt?
    func save(_ attempt: GuestClaimAttempt) async throws
}

actor MemoryGuestClaimAttemptStore: GuestClaimAttemptStoring {
    private var attempts: [UUID: GuestClaimAttempt] = [:]

    func attempt(recoveryID: UUID) -> GuestClaimAttempt? {
        attempts[recoveryID]
    }

    func save(_ attempt: GuestClaimAttempt) {
        attempts[attempt.recoveryID] = attempt
    }
}

actor FileGuestClaimAttemptStore: GuestClaimAttemptStoring {
    private let fileURL: URL

    init(fileURL: URL? = nil) {
        let root = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? FileManager.default.temporaryDirectory
        self.fileURL = fileURL ?? root
            .appending(path: "SnapList", directoryHint: .isDirectory)
            .appending(path: "guest-claim-attempts.json")
    }

    func attempt(recoveryID: UUID) throws -> GuestClaimAttempt? {
        try load()[recoveryID]
    }

    func save(_ attempt: GuestClaimAttempt) throws {
        var attempts = try load()
        attempts[attempt.recoveryID] = attempt
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try JSONEncoder().encode(attempts).write(
            to: fileURL,
            options: [.atomic, .completeFileProtection]
        )
    }

    private func load() throws -> [UUID: GuestClaimAttempt] {
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            return [:]
        }
        return try JSONDecoder().decode(
            [UUID: GuestClaimAttempt].self,
            from: Data(contentsOf: fileURL)
        )
    }
}

enum GuestClaimState: Equatable, Sendable {
    case gate
    case authenticating
    case email
    case code(email: String)
    case wrongCode(email: String)
    case copying
    case leaseExpired
    case copyFailed
    case busy
    case allowanceSpent
    case allowanceInFlight
    case allowanceSpentAfterCopy
    case allowanceInFlightAfterCopy
    case claimed(ClaimedGuestListing)
    case expired(ClaimedGuestListing)
    case noDraft
}

enum AccountEntryLaunchPolicy: Equatable, Sendable {
    case acceptCurrentPrincipal
    case requireDifferentPrincipal
}

@MainActor
@Observable
final class GuestClaimStore {
    private(set) var state: GuestClaimState = .gate

    private let authority: GuestClaimAuthority
    private let authenticator: any GuestAccountAuthenticating
    private let service: any GuestClaimServing
    private let attemptStore: any GuestClaimAttemptStoring
    private let authorityStore: any GuestClaimAuthorityStoring
    private let credentialStore: (any GuestRecoveryCredentialStoring)?
    private let funnelAnalytics: any FunnelAnalyticsEventSinking
    private let authenticatedUserID: @MainActor () -> String?
    private var isWorking = false
    private var hasEmittedAccountClaim = false
    private var authenticationFallbackState: GuestClaimState = .gate
    private var qualifiedScopeProof: ItemRunSubmissionPrincipalScopeProof?
    private var qualifiedBearerRefresh:
        (@Sendable () async throws -> PrincipalBoundBearer)?

    init(
        authority: GuestClaimAuthority,
        authenticator: any GuestAccountAuthenticating,
        service: any GuestClaimServing,
        attemptStore: any GuestClaimAttemptStoring = FileGuestClaimAttemptStore(),
        authorityStore: any GuestClaimAuthorityStoring = NoopGuestClaimAuthorityStore(),
        credentialStore: (any GuestRecoveryCredentialStoring)? = nil,
        funnelAnalytics: any FunnelAnalyticsEventSinking = NoOpFunnelAnalyticsEventSink(),
        authenticatedUserID: @escaping @MainActor () -> String? = { nil }
    ) {
        self.authority = authority
        self.authenticator = authenticator
        self.service = service
        self.attemptStore = attemptStore
        self.authorityStore = authorityStore
        self.credentialStore = credentialStore
        self.funnelAnalytics = funnelAnalytics
        self.authenticatedUserID = authenticatedUserID
    }

    func showEmailEntry() async {
        guard !isWorking else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            try await service.prepareHandoff(authority: authority)
            state = .email
        } catch {
            state = .copyFailed
        }
    }

    @discardableResult
    func beginSupportedAuthentication() async -> AccountEntryLaunchPolicy? {
        guard !isWorking,
              state == .gate || state == .allowanceSpent else {
            return nil
        }
        let startingState = state
        let policy: AccountEntryLaunchPolicy = startingState == .allowanceSpent
            ? .requireDifferentPrincipal
            : .acceptCurrentPrincipal
        isWorking = true
        defer { isWorking = false }
        do {
            try await service.prepareHandoff(authority: authority)
            authenticationFallbackState = startingState
            state = .authenticating
            return policy
        } catch {
            state = .copyFailed
            return nil
        }
    }

    func cancelSupportedAuthentication() {
        guard !isWorking, state == .authenticating else { return }
        state = authenticationFallbackState
        authenticationFallbackState = .gate
    }

    func qualifiedSession(
        _ session: AccountEntryQualifiedSession
    ) async {
        guard !isWorking,
              state == .authenticating,
              session.bearer.scopeProof
                == ItemRunSubmissionPrincipalScopeProof(
                    verifiedClerkSubject: session.userID
                ) else {
            return
        }
        isWorking = true
        qualifiedScopeProof = session.bearer.scopeProof
        qualifiedBearerRefresh = session.refreshBearer
        state = .copying
        await performClaim(authenticatedBy: session.bearer)
        isWorking = false
    }

    func resumeClaim() async {
        guard !isWorking else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            guard try await attemptStore.attempt(
                recoveryID: authority.recoveryID
            ) != nil,
                  let outcome = try await service.resolveClaim(
                    authority: authority
                  ) else {
                return
            }
            try await applyTerminal(outcome)
        } catch {
            state = .copyFailed
        }
    }

    func sendCode(to rawEmail: String) async {
        guard !isWorking else { return }
        let email = rawEmail.trimmingCharacters(in: .whitespacesAndNewlines)
        guard email.contains("@"), email.contains(".") else {
            state = .email
            return
        }
        isWorking = true
        defer { isWorking = false }
        do {
            try await authenticator.sendCode(to: email)
            state = .code(email: email)
        } catch {
            state = .email
        }
    }

    func verifyAndClaim(code: String) async {
        guard !isWorking,
              case .code(let email) = state,
              code.count == 6,
              code.allSatisfy(\.isNumber) else {
            return
        }
        isWorking = true
        do {
            try await authenticator.verify(code: code)
        } catch {
            state = .wrongCode(email: email)
            isWorking = false
            return
        }
        state = .copying
        await performClaim()
        isWorking = false
    }

    func retryClaim() async {
        guard !isWorking else { return }
        switch state {
        case .leaseExpired, .copyFailed, .busy,
             .allowanceInFlight, .allowanceInFlightAfterCopy:
            break
        default:
            return
        }
        isWorking = true
        state = .copying
        if let qualifiedScopeProof, let qualifiedBearerRefresh {
            do {
                let bearer = try await qualifiedBearerRefresh()
                guard bearer.scopeProof == qualifiedScopeProof else {
                    state = .copyFailed
                    isWorking = false
                    return
                }
                await performClaim(authenticatedBy: bearer)
            } catch {
                state = .copyFailed
            }
        } else {
            await performClaim()
        }
        isWorking = false
    }

    func retryCode() {
        guard case .wrongCode(let email) = state else { return }
        state = .code(email: email)
    }

    func cancelAuthentication() {
        guard !isWorking else { return }
        switch state {
        case .email, .code, .wrongCode:
            state = .gate
        default:
            break
        }
    }

    private func performClaim(
        authenticatedBy bearer: PrincipalBoundBearer? = nil
    ) async {
        do {
            if try await attemptStore.attempt(
                recoveryID: authority.recoveryID
            ) != nil,
               let resolved = try await resolveClaim(authenticatedBy: bearer) {
                try await applyTerminal(resolved)
                return
            }
            try await service.prepareHandoff(authority: authority)
            let attempt = try await durableAttempt()
            let outcome: GuestClaimOutcome
            if let bearer {
                outcome = try await service.claim(
                    authority: authority,
                    idempotencyKey: attempt.idempotencyKey,
                    authenticatedBy: bearer
                )
            } else {
                outcome = try await service.claim(
                    authority: authority,
                    idempotencyKey: attempt.idempotencyKey
                )
            }
            try await applyTerminal(outcome)
        } catch let error as GuestClaimServiceError {
            switch error {
            case .allowanceSpent:
                do {
                    state = try await hasPostCopyDenial()
                        ? .allowanceSpentAfterCopy
                        : .allowanceSpent
                } catch {
                    state = .copyFailed
                }
            case .allowanceInFlight:
                do {
                    state = try await hasPostCopyDenial()
                        ? .allowanceInFlightAfterCopy
                        : .allowanceInFlight
                } catch {
                    state = .copyFailed
                }
            case .allowanceSpentAfterCopy:
                await recordPostCopyDenial(.allowanceSpentAfterCopy)
            case .allowanceInFlightAfterCopy:
                await recordPostCopyDenial(.allowanceInFlightAfterCopy)
            case .busy: state = .busy
            case .conflict: state = .leaseExpired
            case .proofUnavailable, .unavailable: state = .copyFailed
            }
        } catch {
            state = .copyFailed
        }
    }

    private func resolveClaim(
        authenticatedBy bearer: PrincipalBoundBearer?
    ) async throws -> GuestClaimOutcome? {
        if let bearer {
            return try await service.resolveClaim(
                authority: authority,
                authenticatedBy: bearer
            )
        }
        return try await service.resolveClaim(authority: authority)
    }

    private func hasPostCopyDenial() async throws -> Bool {
        try await attemptStore.attempt(
            recoveryID: authority.recoveryID
        )?.postCopyDenial == true
    }

    private func recordPostCopyDenial(_ denial: GuestClaimState) async {
        do {
            let attempt = try await durableAttempt()
            try await attemptStore.save(
                GuestClaimAttempt(
                    recoveryID: attempt.recoveryID,
                    idempotencyKey: attempt.idempotencyKey,
                    postCopyDenial: true
                )
            )
            state = denial
        } catch {
            state = .copyFailed
        }
    }

    private func purgeTerminalAuthority() async throws {
        try await credentialStore?.purge(recoveryID: authority.recoveryID)
        try await authorityStore.purge(recoveryID: authority.recoveryID)
    }

    private func applyTerminal(_ outcome: GuestClaimOutcome) async throws {
        try await purgeTerminalAuthority()
        switch outcome {
        case .claimed(let listing):
            state = .claimed(listing)
            if !hasEmittedAccountClaim {
                hasEmittedAccountClaim = true
                if let clerkUserID = await authenticator.activeClerkUserID()
                    ?? authenticatedUserID() {
                    funnelAnalytics.alias(clerkUserID: clerkUserID)
                }
                funnelAnalytics.record(.accountClaimed, eventID: listing.runID)
            }
        case .expired(let listing): state = .expired(listing)
        }
    }

    private func durableAttempt() async throws -> GuestClaimAttempt {
        if let attempt = try await attemptStore.attempt(
            recoveryID: authority.recoveryID
        ) {
            return attempt
        }
        let attempt = GuestClaimAttempt(
            recoveryID: authority.recoveryID,
            idempotencyKey: UUID()
        )
        try await attemptStore.save(attempt)
        return attempt
    }
}
