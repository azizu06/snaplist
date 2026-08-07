import Foundation

/// What the server already knows about the seller's own eBay business policies
/// and inventory location (issue #694). This is a projection of the binding the
/// publish path stored, so Settings can warn before publish without the client
/// asking eBay anything.
///
/// `state` and `missing` stay untyped strings on purpose. The server owns the
/// vocabulary and the seller-facing `message`; a raw-value enum here would turn
/// a future server state into a decode failure for the whole connection read on
/// a build that is already in the App Store.
struct EbayPolicySetupHint: Codable, Equatable, Sendable {
    let state: String
    let marketplaceID: String
    let missing: [String]
    let ambiguous: [String]
    let message: String?
    let helpURL: URL?

    private enum CodingKeys: String, CodingKey {
        case state
        case marketplaceID = "marketplaceId"
        case missing
        case ambiguous
        case message
        case helpURL = "helpUrl"
    }
}

struct EbayConnectionStatus: Codable, Equatable, Sendable {
    let connected: Bool
    let ebayUsername: String?
    /// Absent on the publish preflight, which carries connection truth only.
    let policySetup: EbayPolicySetupHint?

    init(
        connected: Bool,
        ebayUsername: String?,
        policySetup: EbayPolicySetupHint? = nil
    ) {
        self.connected = connected
        self.ebayUsername = ebayUsername
        self.policySetup = policySetup
    }
}

struct EbayOAuthSession: Codable, Equatable, Sendable {
    let sessionID: UUID
    let authorizationURL: URL
    let expiresAt: Date

    private enum CodingKeys: String, CodingKey {
        case sessionID = "sessionId"
        case authorizationURL = "authorizationUrl"
        case expiresAt
    }
}

struct EbayPublishPreflight: Codable, Equatable, Sendable {
    struct EffectivePrice: Codable, Equatable, Sendable {
        let amount: Decimal
        let label: String
    }

    struct Eligibility: Codable, Equatable, Sendable {
        let enabled: Bool?
        let eligible: Bool?
    }

    let listingID: UUID
    let title: String
    let description: String
    let effectivePrice: EffectivePrice
    let photoCount: Int
    let marketplace: String
    let ebayCondition: String
    let itemSpecifics: [String: [String]]
    let reviewRevision: UUID
    let connection: EbayConnectionStatus
    let publishEligibility: Eligibility

    private enum CodingKeys: String, CodingKey {
        case listingID = "listingId"
        case title
        case description
        case effectivePrice
        case photoCount
        case marketplace
        case ebayCondition
        case itemSpecifics
        case reviewRevision
        case connection
        case publishEligibility
    }
}

enum EbayListingEnvironment: String, Codable, Sendable {
    case sandbox
    case production
}

enum EbayListingURL {
    static func resolve(
        providerURL: URL?,
        listingID: String,
        environment: EbayListingEnvironment?
    ) -> URL? {
        if let providerURL { return providerURL }

        let host: String
        switch environment {
        case .sandbox:
            host = "www.sandbox.ebay.com"
        case .production:
            host = "www.ebay.com"
        case nil:
            return nil
        }
        return URL(string: "https://\(host)/itm/\(listingID)")
    }
}

struct EbayPublishStatus: Codable, Equatable, Sendable {
    enum Outcome: String, Codable, Sendable {
        case notPublished = "not_published"
        case outcomeNotYetKnown = "outcome_not_yet_known"
        case failed
        case published
    }

    let listingID: UUID
    let outcome: Outcome
    let ebayListingID: String?
    let ebayOfferID: String?
    let alreadyPublished: Bool
    let listingURL: URL?
    let environment: EbayListingEnvironment?

    init(
        listingID: UUID,
        outcome: Outcome,
        ebayListingID: String?,
        ebayOfferID: String?,
        alreadyPublished: Bool,
        listingURL: URL? = nil,
        environment: EbayListingEnvironment? = nil
    ) {
        self.listingID = listingID
        self.outcome = outcome
        self.ebayListingID = ebayListingID
        self.ebayOfferID = ebayOfferID
        self.alreadyPublished = alreadyPublished
        self.listingURL = listingURL
        self.environment = environment
    }

    private enum CodingKeys: String, CodingKey {
        case listingID = "listingId"
        case outcome
        case ebayListingID = "ebayListingId"
        case ebayOfferID = "ebayOfferId"
        case alreadyPublished
        case listingURL = "listingUrl"
        case environment = "ebayEnvironment"
    }

    var isConfirmedPublication: Bool {
        outcome == .published && ebayListingID != nil
    }

    var publishedListing: EbayPublishedListing? {
        guard isConfirmedPublication,
              let ebayListingID,
              let resolvedURL = EbayListingURL.resolve(
                providerURL: listingURL,
                listingID: ebayListingID,
                environment: environment
              ) else {
            return nil
        }
        return EbayPublishedListing(
            ebayListingID: ebayListingID,
            listingURL: resolvedURL
        )
    }
}

protocol EbayPublishFeatureServing: EbayPublishServing {
    func createOAuthSession(idempotencyKey: UUID) async throws -> EbayOAuthSession
    func connection() async throws -> EbayConnectionStatus
    func disconnect() async throws -> EbayConnectionStatus
    func preflight(listingID: UUID) async throws -> EbayPublishPreflight
    func status(listingID: UUID) async throws -> EbayPublishStatus
}

enum EbayPublishClientError: Error, Equatable {
    case invalidResponse
    case httpStatus(Int, message: String?, reason: String?)
    case sellerFixableRefusal(message: String)
}

struct UnavailableEbayPublishFeatureService: EbayPublishFeatureServing {
    func createOAuthSession(idempotencyKey: UUID) async throws -> EbayOAuthSession {
        throw EbayPublishClientError.invalidResponse
    }
    func connection() async throws -> EbayConnectionStatus {
        throw EbayPublishClientError.invalidResponse
    }
    func disconnect() async throws -> EbayConnectionStatus {
        throw EbayPublishClientError.invalidResponse
    }
    func preflight(listingID: UUID) async throws -> EbayPublishPreflight {
        throw EbayPublishClientError.invalidResponse
    }
    func status(listingID: UUID) async throws -> EbayPublishStatus {
        throw EbayPublishClientError.invalidResponse
    }
    func publish(
        listingID: UUID,
        expectedReviewRevision: UUID,
        idempotencyKey: UUID
    ) async throws -> EbayPublishTransportOutcome {
        throw EbayPublishClientError.invalidResponse
    }
}

struct EbayPublishAPIClient: EbayPublishFeatureServing {
    private let baseURL: URL
    private let tokenProvider: any BearerTokenProviding
    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    init(
        baseURL: URL,
        tokenProvider: any BearerTokenProviding,
        session: URLSession = .shared
    ) {
        self.baseURL = baseURL
        self.tokenProvider = tokenProvider
        self.session = session
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let value = try decoder.singleValueContainer().decode(String.self)
            let fractional = ISO8601DateFormatter()
            fractional.formatOptions = [
                .withInternetDateTime,
                .withFractionalSeconds,
            ]
            if let date = fractional.date(from: value) { return date }
            let ordinary = ISO8601DateFormatter()
            ordinary.formatOptions = [.withInternetDateTime]
            guard let date = ordinary.date(from: value) else {
                throw DecodingError.dataCorruptedError(
                    in: try decoder.singleValueContainer(),
                    debugDescription: "Invalid ISO 8601 date"
                )
            }
            return date
        }
        self.decoder = decoder
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        self.encoder = encoder
    }

    func createOAuthSession(idempotencyKey: UUID) async throws -> EbayOAuthSession {
        try await send(
            path: "/v1/ebay/oauth/sessions",
            method: "POST",
            idempotencyKey: idempotencyKey,
            body: Optional<EmptyBody>.none,
            response: EbayOAuthSession.self
        )
    }

    func connection() async throws -> EbayConnectionStatus {
        try await send(
            path: "/v1/ebay/connection",
            method: "GET",
            response: EbayConnectionStatus.self
        )
    }

    func disconnect() async throws -> EbayConnectionStatus {
        try await send(
            path: "/v1/ebay/connection",
            method: "DELETE",
            response: EbayConnectionStatus.self
        )
    }

    func preflight(listingID: UUID) async throws -> EbayPublishPreflight {
        try await send(
            path: "/v1/listings/\(listingID.uuidString.lowercased())/ebay/preflight",
            method: "GET",
            response: EbayPublishPreflight.self
        )
    }

    func status(listingID: UUID) async throws -> EbayPublishStatus {
        try await send(
            path: "/v1/listings/\(listingID.uuidString.lowercased())/ebay/publish",
            method: "GET",
            response: EbayPublishStatus.self
        )
    }

    func publish(
        listingID: UUID,
        expectedReviewRevision: UUID,
        idempotencyKey: UUID
    ) async throws -> EbayPublishTransportOutcome {
        do {
            let status: EbayPublishStatus = try await send(
                path: "/v1/listings/\(listingID.uuidString.lowercased())/ebay/publish",
                method: "POST",
                idempotencyKey: idempotencyKey,
                body: PublishBody(
                    confirmation: "publish_to_ebay",
                    expectedReviewRevision:
                        expectedReviewRevision.uuidString.lowercased()
                ),
                response: EbayPublishStatus.self
            )
            return Self.outcome(from: status)
        } catch let EbayPublishClientError.httpStatus(status, message, _)
            where status == 422 {
            // Any 422 means eBay refused the mutation; a body that fails to
            // decode (malformed JSON, a proxy/WAF/gateway error page, or a
            // differently-keyed payload) still routes to the terminal
            // seller-fixable screen instead of the ambiguous-outcome path.
            throw EbayPublishClientError.sellerFixableRefusal(
                message: message ?? Self.fallbackSellerFixableRefusalMessage
            )
        } catch let EbayPublishClientError.httpStatus(status, _, reason)
            where status == 409 {
            if reason == "ebay_published_authority_changed" {
                return .providerAuthorityChanged
            }
            return .staleRevision
        }
    }

    private func send<Response: Decodable>(
        path: String,
        method: String,
        response: Response.Type
    ) async throws -> Response {
        try await send(
            path: path,
            method: method,
            idempotencyKey: nil,
            body: Optional<EmptyBody>.none,
            response: response
        )
    }

    private func send<Body: Encodable, Response: Decodable>(
        path: String,
        method: String,
        idempotencyKey: UUID?,
        body: Body?,
        response: Response.Type
    ) async throws -> Response {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(
            "Bearer \(try await tokenProvider.bearerToken())",
            forHTTPHeaderField: "Authorization"
        )
        if let idempotencyKey {
            request.setValue(
                idempotencyKey.uuidString.lowercased(),
                forHTTPHeaderField: "Idempotency-Key"
            )
        }
        if let body {
            request.httpBody = try encoder.encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let (data, urlResponse) = try await session.data(for: request)
        guard let http = urlResponse as? HTTPURLResponse else {
            throw EbayPublishClientError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            let payload = try? decoder.decode(
                ErrorEnvelope.self,
                from: data
            ).error
            throw EbayPublishClientError.httpStatus(
                http.statusCode,
                message: payload?.message,
                reason: payload?.details?.reason
            )
        }
        do {
            return try decoder.decode(Envelope<Response>.self, from: data).data
        } catch {
            throw EbayPublishClientError.invalidResponse
        }
    }

    private static func outcome(
        from status: EbayPublishStatus
    ) -> EbayPublishTransportOutcome {
        if let listing = status.publishedListing {
            return .published(listing)
        }
        switch status.outcome {
        case .outcomeNotYetKnown:
            return .outcomeNotYetKnown
        case .failed, .notPublished:
            return .failed
        case .published:
            return .outcomeNotYetKnown
        }
    }

    /// Shown when eBay returns a 422 whose body doesn't decode into the
    /// expected error envelope, so the seller still gets a truthful,
    /// terminal explanation instead of a fabricated specific.
    static let fallbackSellerFixableRefusalMessage =
        "eBay did not accept this listing. Review the details, then try publishing again."

    private struct Envelope<Payload: Decodable>: Decodable {
        let data: Payload
    }

    private struct ErrorEnvelope: Decodable {
        struct Payload: Decodable {
            struct Details: Decodable { let reason: String? }
            let message: String
            let details: Details?
        }
        let error: Payload
    }

    private struct EmptyBody: Encodable {}

    private struct PublishBody: Encodable {
        let confirmation: String
        let expectedReviewRevision: String
    }
}
