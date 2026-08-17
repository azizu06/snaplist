import Foundation

enum AssistedExportServerAction: String, Encodable, Equatable, Sendable {
    case handoff
    case shared
    case undo
}

enum AssistedExportClientError: Error, Equatable {
    case invalidResponse
    case conflict
    case httpStatus(Int)
}

struct AssistedExportServerPack: Equatable, Sendable {
    let receipts: [AssistedExportReceipt]
    let effectivePrice: Decimal
    let reviewRevision: UUID
}

protocol AssistedExportServing: Sendable {
    func load(pack: AssistedExportPack) async throws -> AssistedExportServerPack
    func perform(
        _ action: AssistedExportServerAction,
        destination: AssistedExportDestination,
        pack: AssistedExportPack
    ) async throws -> AssistedExportServerPack
}

struct AssistedExportAPIClient: AssistedExportServing {
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

    func load(pack: AssistedExportPack) async throws -> AssistedExportServerPack {
        var components = URLComponents(
            url: endpoint(for: pack.itemID),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = [
            URLQueryItem(
                name: "reviewContentRevision",
                value: pack.contentRevision.uuidString.lowercased()
            )
        ]
        var request = URLRequest(url: components.url!)
        request.httpMethod = "GET"
        return try await send(request)
    }

    func perform(
        _ action: AssistedExportServerAction,
        destination: AssistedExportDestination,
        pack: AssistedExportPack
    ) async throws -> AssistedExportServerPack {
        var request = URLRequest(url: endpoint(for: pack.itemID))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(
            ActionBody(
                platform: destination.rawValue,
                action: action,
                reviewContentRevision: pack.contentRevision,
                reviewRevision: pack.reviewRevision
            )
        )
        return try await send(request)
    }

    private func send(_ input: URLRequest) async throws -> AssistedExportServerPack {
        var request = input
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(
            "Bearer \(try await tokenProvider.bearerToken())",
            forHTTPHeaderField: "Authorization"
        )
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw AssistedExportClientError.invalidResponse
        }
        if http.statusCode == 409 {
            throw AssistedExportClientError.conflict
        }
        guard (200..<300).contains(http.statusCode) else {
            throw AssistedExportClientError.httpStatus(http.statusCode)
        }

        let envelope: Envelope
        do {
            envelope = try JSONDecoder().decode(Envelope.self, from: data)
        } catch {
            throw AssistedExportClientError.invalidResponse
        }
        let receipts = try envelope.data.handoffs.map { handoff -> AssistedExportReceipt in
            guard let destination = AssistedExportDestination(rawValue: handoff.platform),
                  (handoff.state == "prepared" || handoff.state == "shared"),
                  (handoff.state == "shared") == (handoff.sharedAt != nil),
                  handoff.sharedAt == nil || handoff.handedOffAt != nil else {
                throw AssistedExportClientError.invalidResponse
            }
            return AssistedExportReceipt(
                destination: destination,
                handedOffAt: try parse(handoff.handedOffAt),
                sharedAt: try parse(handoff.sharedAt)
            )
        }
        guard receipts.count == AssistedExportDestination.allCases.count,
              Set(receipts.map(\.destination)) == Set(AssistedExportDestination.allCases) else {
            throw AssistedExportClientError.invalidResponse
        }
        guard Self.isPositiveCentPrice(envelope.data.pack.effectivePrice) else {
            throw AssistedExportClientError.invalidResponse
        }
        return AssistedExportServerPack(
            receipts: receipts,
            effectivePrice: envelope.data.pack.effectivePrice,
            reviewRevision: envelope.data.pack.reviewRevision
        )
    }

    private func endpoint(for itemID: UUID) -> URL {
        baseURL
            .appending(path: "v1")
            .appending(path: "items")
            .appending(path: itemID.uuidString.lowercased())
            .appending(path: "export-handoffs")
    }

    private func parse(_ value: String?) throws -> Date? {
        guard let value else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        let ordinary = ISO8601DateFormatter()
        ordinary.formatOptions = [.withInternetDateTime]
        guard let date = ordinary.date(from: value) else {
            throw AssistedExportClientError.invalidResponse
        }
        return date
    }

    private static func isPositiveCentPrice(_ price: Decimal) -> Bool {
        guard !price.isNaN, price > 0 else { return false }
        var input = price
        var normalized = Decimal()
        NSDecimalRound(&normalized, &input, 2, .plain)
        return normalized == price
    }

    private struct ActionBody: Encodable {
        let platform: String
        let action: AssistedExportServerAction
        let reviewContentRevision: UUID
        let reviewRevision: UUID
    }

    private struct Envelope: Decodable {
        struct DataBody: Decodable {
            let handoffs: [Handoff]
            let pack: Pack
        }

        struct Handoff: Decodable {
            let platform: String
            let state: String
            let handedOffAt: String?
            let sharedAt: String?
        }

        struct Pack: Decodable {
            let effectivePrice: Decimal
            let reviewRevision: UUID
        }

        let data: DataBody
    }
}

actor AssistedExportFixtureService: AssistedExportServing {
    /// Receipts belong to the pack text they were written against, keyed the
    /// way the server keys them. `loadExportHandoffs` filters on
    /// `source_review_revision`, so a pack whose text was rebuilt carries a new
    /// content revision and reads back no rows at all.
    ///
    /// One flat table per destination was the same shape as the server's
    /// response and a different shape from its contract: it answered a rebuilt
    /// pack with the handoff that belonged to the retired text, so the row went
    /// on saying `Not shared` and went on offering `Mark as shared` for text
    /// the seller never handed anyone (#928).
    private var receiptsByContentRevision:
        [UUID: [AssistedExportDestination: AssistedExportReceipt]] = [:]
    /// The rows the server already holds, attributed to the first pack this
    /// service is asked about. Nothing here knows a content revision until a
    /// pack arrives, and the caller seeds the state of the pack it is mounting.
    private var seededReceipts: [AssistedExportDestination: AssistedExportReceipt]
    private var seedContentRevision: UUID?
    private let didPerform: (@Sendable (AssistedExportServerAction) async -> Void)?
    private let effectivePrice: Decimal?
    private let reviewRevision: UUID?

    init(
        receipts: [AssistedExportReceipt] = [],
        effectivePrice: Decimal? = nil,
        reviewRevision: UUID? = nil,
        didPerform: (@Sendable (AssistedExportServerAction) async -> Void)? = nil
    ) {
        seededReceipts = Dictionary(uniqueKeysWithValues: receipts.map {
            ($0.destination, $0)
        })
        self.effectivePrice = effectivePrice
        self.reviewRevision = reviewRevision
        self.didPerform = didPerform
    }

    func load(pack: AssistedExportPack) async throws -> AssistedExportServerPack {
        response(for: pack)
    }

    func perform(
        _ action: AssistedExportServerAction,
        destination: AssistedExportDestination,
        pack: AssistedExportPack
    ) async throws -> AssistedExportServerPack {
        await didPerform?(action)
        let revision = bindSeedIfNeeded(to: pack)
        let existing = receiptsByContentRevision[revision]?[destination]
        switch action {
        case .handoff:
            receiptsByContentRevision[revision, default: [:]][destination] =
                AssistedExportReceipt(
                    destination: destination,
                    handedOffAt: existing?.handedOffAt ?? Date(),
                    sharedAt: existing?.sharedAt
                )
        case .shared:
            guard let handedOffAt = existing?.handedOffAt else {
                throw AssistedExportClientError.invalidResponse
            }
            receiptsByContentRevision[revision, default: [:]][destination] =
                AssistedExportReceipt(
                    destination: destination,
                    handedOffAt: handedOffAt,
                    sharedAt: existing?.sharedAt ?? Date()
                )
        case .undo:
            guard let handedOffAt = existing?.handedOffAt else {
                throw AssistedExportClientError.invalidResponse
            }
            receiptsByContentRevision[revision, default: [:]][destination] =
                AssistedExportReceipt(
                    destination: destination,
                    handedOffAt: handedOffAt,
                    sharedAt: nil
                )
        }
        return response(for: pack)
    }

    /// Attributes the seeded rows to the first pack asked about, which is the
    /// pack they describe, and returns the revision this call reads and writes.
    @discardableResult
    private func bindSeedIfNeeded(to pack: AssistedExportPack) -> UUID {
        if seedContentRevision == nil {
            seedContentRevision = pack.contentRevision
            receiptsByContentRevision[pack.contentRevision] = seededReceipts
        }
        return pack.contentRevision
    }

    private func current(for pack: AssistedExportPack) -> [AssistedExportReceipt] {
        let stored = receiptsByContentRevision[bindSeedIfNeeded(to: pack)] ?? [:]
        return AssistedExportDestination.allCases.map { destination in
            stored[destination] ?? AssistedExportReceipt(
                destination: destination,
                handedOffAt: nil,
                sharedAt: nil
            )
        }
    }

    private func response(for pack: AssistedExportPack) -> AssistedExportServerPack {
        AssistedExportServerPack(
            receipts: current(for: pack),
            effectivePrice: effectivePrice ?? pack.effectivePrice,
            reviewRevision: reviewRevision ?? pack.reviewRevision
        )
    }
}
