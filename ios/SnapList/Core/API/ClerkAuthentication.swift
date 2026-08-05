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
        guard publishableKey.hasPrefix("pk_test_")
                || publishableKey.hasPrefix("pk_live_") else {
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

struct PrincipalBoundBearer: Sendable {
    let bearerToken: String
    let scopeProof: ItemRunSubmissionPrincipalScopeProof
}

protocol BearerTokenProviding: Sendable {
    /// Returns a fresh opaque Clerk bearer without exposing ClerkKit to callers.
    func bearerToken() async throws -> String

    /// Returns a bearer and opaque scope proof captured from the same verified
    /// session. Callers compare the proof but cannot recover the Clerk subject.
    func principalBoundBearer() async throws -> PrincipalBoundBearer
}

extension BearerTokenProviding {
    func principalBoundBearer() async throws -> PrincipalBoundBearer {
        throw BearerTokenProviderError.principalBindingUnavailable
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
        guard let token = Self.usable(
            try await session.sessionToken()
        ) else {
            throw BearerTokenProviderError.sessionAbsent
        }
        return token
    }

    func principalBoundBearer() async throws -> PrincipalBoundBearer {
        let authentication = try await session.sessionAuthentication()
        guard let token = Self.usable(authentication.token) else {
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
    /// every authenticated native caller to the real current Clerk session.
    @MainActor
    static func make(
        publishableKey: String
    ) -> any BearerTokenProviding {
        Clerk.configure(publishableKey: publishableKey)
        return ClerkBearerTokenProvider(session: LiveClerkSessionTokenProvider())
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
