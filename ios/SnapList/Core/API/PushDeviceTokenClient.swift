import Foundation

/**
 Issue #890. The one call that registers this device for push.

 Kept off `MobileAPIClient` for the same reason the included-offer calls are:
 a device token is an address, and a surface that has no business handing one
 out should not be able to reach the method that does.
 */
protocol PushDeviceTokenSubmitting: Sendable {
    func submitPushDeviceToken(_ token: String) async throws
}

struct URLSessionPushDeviceTokenClient: PushDeviceTokenSubmitting {
    private struct Registration: Encodable {
        let platform: String
        let token: String
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
    func submitPushDeviceToken(_ token: String) async throws {
        var request = URLRequest(url: baseURL.appending(path: "/v1/device-tokens"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(
            "Bearer \(try await tokenProvider.bearerToken())",
            forHTTPHeaderField: "Authorization"
        )
        request.httpBody = try JSONEncoder().encode(
            Registration(platform: "ios", token: token)
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
