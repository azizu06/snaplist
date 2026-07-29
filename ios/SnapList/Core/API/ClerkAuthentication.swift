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
}

enum BearerTokenProviderError: Error, Equatable {
    case sessionAbsent
}

protocol BearerTokenProviding: Sendable {
    /// Returns a fresh opaque Clerk bearer without exposing ClerkKit to callers.
    func bearerToken() async throws -> String
}

struct UnavailableBearerTokenProvider: BearerTokenProviding {
    func bearerToken() async throws -> String {
        throw BearerTokenProviderError.sessionAbsent
    }
}

struct ClerkBearerTokenProvider: BearerTokenProviding {
    let session: any ClerkSessionTokenProviding

    func bearerToken() async throws -> String {
        let token = try await session.sessionToken()?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let token, !token.isEmpty else {
            throw BearerTokenProviderError.sessionAbsent
        }
        return token
    }
}

private struct LiveClerkSessionTokenProvider: ClerkSessionTokenProviding {
    func sessionToken() async throws -> String? {
        let session = await MainActor.run { Clerk.shared.session }
        return try await session?.getToken()
    }
}

enum ClerkAuthenticationComposition {
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
