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
}
