import Foundation
import Observation

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
    func claim(
        authority: GuestClaimAuthority,
        idempotencyKey: UUID
    ) async throws -> GuestClaimOutcome
}

extension GuestClaimServing {
    func resolveClaim(
        authority: GuestClaimAuthority
    ) async throws -> GuestClaimOutcome? { nil }
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
        await performClaim()
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

    private func performClaim() async {
        do {
            if try await attemptStore.attempt(
                recoveryID: authority.recoveryID
            ) != nil,
               let resolved = try await service.resolveClaim(
                authority: authority
               ) {
                try await applyTerminal(resolved)
                return
            }
            try await service.prepareHandoff(authority: authority)
            let attempt = try await durableAttempt()
            let outcome = try await service.claim(
                authority: authority,
                idempotencyKey: attempt.idempotencyKey
            )
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
