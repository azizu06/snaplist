import Foundation

/**
 Issue #890. The one call that registers this device for push.

 Kept off `MobileAPIClient` for the same reason the included-offer calls are:
 a device token is an address, and a surface that has no business handing one
 out should not be able to reach the method that does.
 */
protocol PushDeviceTokenSubmitting: Sendable {
    /// The environment is a property of the token, not a preference (#891). One
    /// APNs auth key serves both hosts and the token itself does not say which
    /// one it belongs to, so the server can only learn it here. It is required
    /// rather than defaulted for the same reason the column has no default: a
    /// wrong guess is accepted by Apple and then dropped.
    func submitPushDeviceToken(
        _ token: String,
        environment: ApnsEnvironment
    ) async throws
}

struct URLSessionPushDeviceTokenClient: PushDeviceTokenSubmitting {
    private struct Registration: Encodable {
        let platform: String
        let token: String
        let apnsEnvironment: String
    }

    private let baseURL: URL
    private let tokenProvider: any BearerTokenProviding
    private let session: URLSession

    init(
        baseURL: URL,
        tokenProvider: any BearerTokenProviding,
        session: URLSession = .shared
    ) {
        self.baseURL = baseURL
        self.tokenProvider = tokenProvider
        self.session = session
    }

    /// The body carries no account. The server takes the owner from the bearer,
    /// and a client that could name one would be a client that could register
    /// this phone against somebody else's listings.
    func submitPushDeviceToken(
        _ token: String,
        environment: ApnsEnvironment
    ) async throws {
        var request = URLRequest(url: baseURL.appending(path: "/v1/device-tokens"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(
            "Bearer \(try await tokenProvider.bearerToken())",
            forHTTPHeaderField: "Authorization"
        )
        request.httpBody = try JSONEncoder().encode(
            Registration(
                platform: "ios",
                token: token,
                apnsEnvironment: environment.rawValue
            )
        )

        let (_, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw MobileAPIClientError.invalidResponse
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            throw MobileAPIClientError.httpStatus(httpResponse.statusCode)
        }
    }
}
