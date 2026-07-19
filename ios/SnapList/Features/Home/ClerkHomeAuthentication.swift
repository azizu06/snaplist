import ClerkKit
import Foundation

protocol ClerkSessionTokenProviding: Sendable {
    /// Clerk owns session refresh and secure persistence. Home receives only
    /// the current short-lived bearer and never stores or decodes it.
    func sessionToken() async throws -> String?
}

struct ClerkHomeAuthentication: HomeAuthenticationProviding {
    let session: any ClerkSessionTokenProviding

    func bearerToken() async throws -> String {
        let token = try await session.sessionToken()?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let token, !token.isEmpty else {
            throw HomeRepositoryError.operationUnavailable
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

private struct UnavailableClerkHomeAuthentication: HomeAuthenticationProviding {
    func bearerToken() async throws -> String {
        throw HomeRepositoryError.operationUnavailable
    }
}

enum HomeAuthenticationComposition {
    private static let bundleKey = "SnapListClerkPublishableKey"

    /// Configures ClerkKit once from a public build value and binds Home to the
    /// real current Clerk session. Missing configuration fails closed without
    /// manufacturing a user or token.
    @MainActor
    static func make(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        bundle: Bundle = .main
    ) -> any HomeAuthenticationProviding {
        let publishableKey = (
            environment["SNAPLIST_CLERK_PUBLISHABLE_KEY"]
                ?? bundle.object(forInfoDictionaryKey: bundleKey) as? String
        )?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let publishableKey,
              publishableKey.hasPrefix("pk_test_") || publishableKey.hasPrefix("pk_live_") else {
            return UnavailableClerkHomeAuthentication()
        }

        Clerk.configure(publishableKey: publishableKey)
        return ClerkHomeAuthentication(session: LiveClerkSessionTokenProvider())
    }
}
