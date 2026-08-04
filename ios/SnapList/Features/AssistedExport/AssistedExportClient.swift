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
    private var receipts: [AssistedExportDestination: AssistedExportReceipt]
    private let didPerform: (@Sendable (AssistedExportServerAction) async -> Void)?
    private let effectivePrice: Decimal?
    private let reviewRevision: UUID?

    init(
        receipts: [AssistedExportReceipt] = [],
        effectivePrice: Decimal? = nil,
        reviewRevision: UUID? = nil,
        didPerform: (@Sendable (AssistedExportServerAction) async -> Void)? = nil
    ) {
        self.receipts = Dictionary(uniqueKeysWithValues: receipts.map {
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
        let existing = receipts[destination]
        switch action {
        case .handoff:
            receipts[destination] = AssistedExportReceipt(
                destination: destination,
                handedOffAt: existing?.handedOffAt ?? Date(),
                sharedAt: existing?.sharedAt
            )
        case .shared:
            guard let handedOffAt = existing?.handedOffAt else {
                throw AssistedExportClientError.invalidResponse
            }
            receipts[destination] = AssistedExportReceipt(
                destination: destination,
                handedOffAt: handedOffAt,
                sharedAt: existing?.sharedAt ?? Date()
            )
        case .undo:
            guard let handedOffAt = existing?.handedOffAt else {
                throw AssistedExportClientError.invalidResponse
            }
            receipts[destination] = AssistedExportReceipt(
                destination: destination,
                handedOffAt: handedOffAt,
                sharedAt: nil
            )
        }
        return response(for: pack)
    }

    private var current: [AssistedExportReceipt] {
        AssistedExportDestination.allCases.map { destination in
            receipts[destination] ?? AssistedExportReceipt(
                destination: destination,
                handedOffAt: nil,
                sharedAt: nil
            )
        }
    }

    private func response(for pack: AssistedExportPack) -> AssistedExportServerPack {
        AssistedExportServerPack(
            receipts: current,
            effectivePrice: effectivePrice ?? pack.effectivePrice,
            reviewRevision: reviewRevision ?? pack.reviewRevision
        )
    }
}
