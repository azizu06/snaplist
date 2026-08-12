import ClerkKit
import Foundation

enum NativeAppConfigurationError: Error, Equatable {
    case missingAPIOrigin
    case invalidAPIOrigin
    case missingClerkPublishableKey
    case invalidClerkPublishableKey
}

struct NativeAppConfiguration: Equatable {
    let apiOrigin: URL
    let clerkPublishableKey: String

    static func resolve(
        environment: [String: String],
        apiOriginBundleValue: String?,
        clerkPublishableKeyBundleValue: String?,
        allowsLocalDevelopment: Bool
    ) throws -> NativeAppConfiguration {
        let rawAPIOrigin = (
            environment["SNAPLIST_API_ORIGIN"] ?? apiOriginBundleValue
        )?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let rawAPIOrigin, !rawAPIOrigin.isEmpty else {
            throw NativeAppConfigurationError.missingAPIOrigin
        }
        guard let apiOrigin = HomeRepositoryFactory.resolveAPIOrigin(
            environment: ["SNAPLIST_API_ORIGIN": rawAPIOrigin],
            bundleValue: nil,
            allowsLocalDevelopment: allowsLocalDevelopment
        ) else {
            throw NativeAppConfigurationError.invalidAPIOrigin
        }

        let publishableKey = (
            environment["SNAPLIST_CLERK_PUBLISHABLE_KEY"]
                ?? clerkPublishableKeyBundleValue
        )?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let publishableKey, !publishableKey.isEmpty else {
            throw NativeAppConfigurationError.missingClerkPublishableKey
        }
        guard publishableKey.hasPrefix("pk_live_")
                || (
                    allowsLocalDevelopment
                    && publishableKey.hasPrefix("pk_test_")
                ) else {
            throw NativeAppConfigurationError.invalidClerkPublishableKey
        }

        return NativeAppConfiguration(
            apiOrigin: apiOrigin,
            clerkPublishableKey: publishableKey
        )
    }
}

protocol ClerkSessionTokenProviding: Sendable {
    /// Clerk owns session refresh and secure persistence. Callers receive only
    /// the current short-lived bearer and never store or decode it.
    func sessionToken() async throws -> String?

    /// Captures both values from one Clerk Session instance. The subject stays
    /// inside the authentication boundary and is consumed only to derive #540's
    /// opaque scope proof.
    func sessionAuthentication() async throws -> ClerkSessionAuthentication
}

struct ClerkSessionAuthentication: Sendable {
    let token: String?
    let scopeProof: ItemRunSubmissionPrincipalScopeProof?
}

extension ClerkSessionTokenProviding {
    func sessionAuthentication() async throws -> ClerkSessionAuthentication {
        ClerkSessionAuthentication(
            token: try await sessionToken(),
            scopeProof: nil
        )
    }
}

enum BearerTokenProviderError: Error, Equatable {
    case sessionAbsent
    case principalBindingUnavailable
}

/// Which credential a request actually carried.
///
/// A `401` alone cannot say, and the two answers mean opposite things. A
/// guest-capability bearer proves an installation and never a subject, so a
/// bearer route refusing it is that route working correctly: the caller is a
/// guest. The same status answered to a Clerk bearer means a token minted for a
/// verified subject was refused — a missing `CLERK_SECRET_KEY`, a wrong
/// audience, a rotated signing key — and reading that as `.guest` puts a
/// signed-in seller back in front of the activation coach marks.
enum BearerCredential: Equatable, Sendable {
    case clerkSubject
    case guestCapability
}

struct ClassifiedBearerToken: Sendable {
    let token: String
    let credential: BearerCredential
}

struct PrincipalBoundBearer: Sendable {
    let bearerToken: String
    let scopeProof: ItemRunSubmissionPrincipalScopeProof
}

struct ItemRunSubmissionScopedBearer: Sendable {
    let bearerToken: String
    let scopeProof: ItemRunSubmissionPrincipalScopeProof
}

protocol BearerTokenProviding: Sendable {
    /// Returns a fresh opaque Clerk bearer without exposing ClerkKit to callers.
    func bearerToken() async throws -> String

    /// Returns the same bearer plus which credential it turned out to be, so a
    /// caller that gets refused can tell an unauthenticated answer apart from a
    /// rejected one.
    func classifiedBearerToken() async throws -> ClassifiedBearerToken

    /// Returns a bearer and opaque scope proof captured from the same verified
    /// session. Callers compare the proof but cannot recover the Clerk subject.
    func principalBoundBearer() async throws -> PrincipalBoundBearer

    /// Returns only the bearer whose verified identity owns the current opaque
    /// NativeIntake scope. Unlike `principalBoundBearer`, this narrow seam may
    /// bind a verified App Attest installation for the included guest run.
    func itemRunSubmissionScopedBearer() async throws
        -> ItemRunSubmissionScopedBearer
}

extension BearerTokenProviding {
    /// A provider with no guest fallback only ever mints a Clerk bearer, so the
    /// classification is settled without asking it.
    func classifiedBearerToken() async throws -> ClassifiedBearerToken {
        ClassifiedBearerToken(
            token: try await bearerToken(),
            credential: .clerkSubject
        )
    }

    func principalBoundBearer() async throws -> PrincipalBoundBearer {
        throw BearerTokenProviderError.principalBindingUnavailable
    }

    func itemRunSubmissionScopedBearer() async throws
        -> ItemRunSubmissionScopedBearer {
        let principal = try await principalBoundBearer()
        return ItemRunSubmissionScopedBearer(
            bearerToken: principal.bearerToken,
            scopeProof: principal.scopeProof
        )
    }
}

struct UnavailableBearerTokenProvider: BearerTokenProviding {
    func bearerToken() async throws -> String {
        throw BearerTokenProviderError.sessionAbsent
    }
}

struct ClerkBearerTokenProvider: BearerTokenProviding {
    let session: any ClerkSessionTokenProviding

    func bearerToken() async throws -> String {
        let authentication = try await session.sessionAuthentication()
        guard let token = Self.usable(authentication.token) else {
            if authentication.scopeProof != nil {
                throw BearerTokenProviderError.principalBindingUnavailable
            }
            throw BearerTokenProviderError.sessionAbsent
        }
        return token
    }

    func principalBoundBearer() async throws -> PrincipalBoundBearer {
        let authentication = try await session.sessionAuthentication()
        guard let token = Self.usable(authentication.token) else {
            if authentication.scopeProof != nil {
                throw BearerTokenProviderError.principalBindingUnavailable
            }
            throw BearerTokenProviderError.sessionAbsent
        }
        guard let scopeProof = authentication.scopeProof else {
            throw BearerTokenProviderError.principalBindingUnavailable
        }
        return PrincipalBoundBearer(
            bearerToken: token,
            scopeProof: scopeProof
        )
    }

    private static func usable(_ value: String?) -> String? {
        let value = value?.trimmingCharacters(
            in: .whitespacesAndNewlines
        )
        guard let value, !value.isEmpty else {
            return nil
        }
        return value
    }
}

struct GuestCapableBearerTokenProvider: BearerTokenProviding {
    private let clerk: any BearerTokenProviding
    private let guestCapabilities: any GuestCapabilityBearerStoring
    private let appAttestKeys: any AppAttestKeyIDStoring
    private let now: @Sendable () -> Date

    init(
        clerk: any BearerTokenProviding,
        guestCapabilities: any GuestCapabilityBearerStoring =
            KeychainGuestCapabilityBearerStore(),
        appAttestKeys: any AppAttestKeyIDStoring =
            KeychainAppAttestKeyIDStore(),
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.clerk = clerk
        self.guestCapabilities = guestCapabilities
        self.appAttestKeys = appAttestKeys
        self.now = now
    }

    func bearerToken() async throws -> String {
        try await classifiedBearerToken().token
    }

    /// This is the only place that still knows which of the two credentials a
    /// request went out on. Once the header is built they are both just a
    /// bearer, and a `401` answered to either looks identical.
    func classifiedBearerToken() async throws -> ClassifiedBearerToken {
        do {
            return ClassifiedBearerToken(
                token: try await clerk.bearerToken(),
                credential: .clerkSubject
            )
        } catch BearerTokenProviderError.sessionAbsent {
            // Only an absent session may fall through. Falling back on any other
            // Clerk failure would put an account holder's request on a guest
            // identity whenever Clerk merely stumbled.
            return ClassifiedBearerToken(
                token: try guestBearerToken(),
                credential: .guestCapability
            )
        }
    }

    /// A guest capability proves an installation, never a verified Clerk subject,
    /// so it can never satisfy a principal-bound request. Clerk answers alone.
    func principalBoundBearer() async throws -> PrincipalBoundBearer {
        try await clerk.principalBoundBearer()
    }

    func itemRunSubmissionScopedBearer() async throws
        -> ItemRunSubmissionScopedBearer {
        do {
            let principal = try await clerk.principalBoundBearer()
            return ItemRunSubmissionScopedBearer(
                bearerToken: principal.bearerToken,
                scopeProof: principal.scopeProof
            )
        } catch BearerTokenProviderError.sessionAbsent {
            let bearer = try guestBearer()
            guard let key = try? appAttestKeys.load(),
                  key.state == .verified,
                  let currentScopeProof = ItemRunSubmissionPrincipalScopeProof(
                      verifiedAppAttestKeyID: key.id
                  ),
                  let storedScopeProof = bearer.appAttestScopeProof,
                  storedScopeProof == currentScopeProof else {
                // An unbound migrated bearer or a bearer earned by a prior key
                // is not absent authority for the current scope. Reporting it as
                // unusable gives the renewing wrapper one assertion to mint the
                // exact current bearer/scope pair without ever synthesizing one.
                throw BearerTokenProviderError.sessionAbsent
            }
            return ItemRunSubmissionScopedBearer(
                bearerToken: bearer.token,
                scopeProof: storedScopeProof
            )
        }
    }

    private func guestBearerToken() throws -> String {
        try guestBearer().token
    }

    private func guestBearer() throws -> GuestCapabilityBearer {
        guard let bearer = try? guestCapabilities.load(),
              bearer.isUsable(at: now()) else {
            throw BearerTokenProviderError.sessionAbsent
        }
        return bearer
    }
}

private struct LiveClerkSessionTokenProvider: ClerkSessionTokenProviding {
    func sessionToken() async throws -> String? {
        let authentication = try await sessionAuthentication()
        return authentication.token
    }

    func sessionAuthentication() async throws
        -> ClerkSessionAuthentication {
        let session = await MainActor.run { Clerk.shared.session }
        let subject: String? = session?.user?.id
        let scopeProof = subject.flatMap {
            ItemRunSubmissionPrincipalScopeProof(
                verifiedClerkSubject: $0
            )
        }
        return ClerkSessionAuthentication(
            token: try await session?.getToken(),
            scopeProof: scopeProof
        )
    }
}

enum ClerkAuthenticationComposition {
    @MainActor
    static func currentUserID() -> String? {
        Clerk.shared.user?.id
    }

    /// Configures ClerkKit once from the validated public build value and binds
    /// every authenticated native caller to the real current Clerk session. A
    /// seller who has no session yet falls back to the App Attest guest
    /// capability, which is the only credential first value can be earned with.
    @MainActor
    static func make(
        publishableKey: String
    ) -> any BearerTokenProviding {
        Clerk.configure(publishableKey: publishableKey)
        return GuestCapableBearerTokenProvider(
            clerk: ClerkBearerTokenProvider(
                session: LiveClerkSessionTokenProvider()
            )
        )
    }

    @MainActor
    static func makeNativeIntakeIdentitySource(
        keyStore: any AppAttestKeyIDStoring = KeychainAppAttestKeyIDStore(),
        verifiedClerkSubject: @escaping @Sendable () async -> String? = {
            await MainActor.run { Clerk.shared.user?.id }
        },
        clerkChanges: @escaping @MainActor @Sendable () -> AsyncStream<Void> = {
            liveClerkChanges()
        },
        appAttestChanges: @escaping @MainActor @Sendable () -> AsyncStream<Void> = {
            liveAppAttestChanges()
        }
    ) -> NativeIntake.IdentitySource {
        let streams = [clerkChanges(), appAttestChanges()]
        return NativeIntake.identitySource(
            verifiedClerkSubject: verifiedClerkSubject,
            persistedAppAttestKey: {
                try? keyStore.load()
            },
            changes: {
                AsyncStream { continuation in
                    let tasks = streams.map { stream in
                        Task {
                            for await _ in stream {
                                continuation.yield()
                            }
                        }
                    }
                    continuation.onTermination = { _ in
                        tasks.forEach { $0.cancel() }
                    }
                }
            }
        )
    }

    @MainActor
    private static func liveClerkChanges() -> AsyncStream<Void> {
        let events = Clerk.shared.auth.events
        return AsyncStream { continuation in
            let task = Task {
                for await _ in events {
                    continuation.yield()
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private static func liveAppAttestChanges() -> AsyncStream<Void> {
        let notifications = NotificationCenter.default.notifications(
            named: KeychainAppAttestKeyIDStore.didChange
        )
        return AsyncStream { continuation in
            let task = Task {
                for await _ in notifications {
                    continuation.yield()
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
