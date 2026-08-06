import Foundation

protocol RunServing: Sendable {
    func fetchRun(id: UUID, bearerToken: String) async throws -> DurableRun
    func retryRun(
        id: UUID,
        idempotencyKey: UUID,
        bearerToken: String
    ) async throws -> DurableRun
}

extension RunServing {
    func retryRun(
        id: UUID,
        idempotencyKey: UUID,
        bearerToken: String
    ) async throws -> DurableRun {
        throw RunAPIError.unavailable
    }
}

protocol TrophyWallRunHistoryServing: Sendable {
    func fetchRunHistoryPage(
        limit: Int,
        cursor: String?,
        bearerToken: String
    ) async throws -> TrophyWallRunHistoryPage
}

enum RunAPIError: Error, Equatable {
    case authenticationRequired
    case unavailable
    case invalidResponse
}

final class RunAPIClient: RunServing, TrophyWallRunHistoryServing, @unchecked Sendable {
    private let baseURL: URL
    private let session: URLSession
    private let decoder = JSONDecoder()

    init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    func fetchRun(id: UUID, bearerToken: String) async throws -> DurableRun {
        let url = baseURL
            .appending(path: "/v1/runs")
            .appending(path: id.uuidString.lowercased())
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else {
            throw RunAPIError.invalidResponse
        }
        guard response.statusCode == 200 else {
            throw Self.error(for: response.statusCode)
        }

        do {
            let run = try decoder.decode(RunEnvelope.self, from: data).data
            guard run.id == id, run.schemaVersion == 1 else {
                throw RunAPIError.invalidResponse
            }
            return run
        } catch let error as RunAPIError {
            throw error
        } catch {
            throw RunAPIError.invalidResponse
        }
    }

    func retryRun(
        id: UUID,
        idempotencyKey: UUID,
        bearerToken: String
    ) async throws -> DurableRun {
        let url = baseURL
            .appending(path: "/v1/runs")
            .appending(path: id.uuidString.lowercased())
            .appending(path: "retry")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        request.setValue(
            idempotencyKey.uuidString.lowercased(),
            forHTTPHeaderField: "Idempotency-Key"
        )

        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else {
            throw RunAPIError.invalidResponse
        }
        guard response.statusCode == 202 else {
            throw Self.error(for: response.statusCode)
        }
        do {
            let run = try decoder.decode(RunEnvelope.self, from: data).data
            guard run.id == id, run.schemaVersion == 1 else {
                throw RunAPIError.invalidResponse
            }
            return run
        } catch let error as RunAPIError {
            throw error
        } catch {
            throw RunAPIError.invalidResponse
        }
    }

    func fetchRunHistoryPage(
        limit: Int,
        cursor: String?,
        bearerToken: String
    ) async throws -> TrophyWallRunHistoryPage {
        guard (1...50).contains(limit),
              cursor == nil || !(cursor?.isEmpty ?? true) else {
            throw RunAPIError.invalidResponse
        }

        var components = URLComponents(
            url: baseURL.appending(path: "/v1/runs"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [
            URLQueryItem(name: "limit", value: String(limit)),
            cursor.map { URLQueryItem(name: "cursor", value: $0) },
        ].compactMap { $0 }
        guard let url = components?.url else {
            throw RunAPIError.invalidResponse
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else {
            throw RunAPIError.invalidResponse
        }
        guard response.statusCode == 200 else {
            throw Self.error(for: response.statusCode)
        }

        do {
            let payload = try decoder.decode(RunHistoryEnvelope.self, from: data).data
            guard payload.nextCursor == nil || !(payload.nextCursor?.isEmpty ?? true) else {
                throw RunAPIError.invalidResponse
            }

            let entries = try payload.entries.map { entry in
                guard entry.run.schemaVersion == 1,
                      !entry.logicalIdentity.idempotencyKey.isEmpty,
                      entry.logicalIdentity.idempotencyKey.count <= 128,
                      entry.orderKey.runID == entry.run.id,
                      let orderKey = TrophyWallOrderKey(
                          serverTimestamp: entry.orderKey.lastMeaningfulUpdateAt,
                          runID: entry.orderKey.runID
                      ) else {
                    throw RunAPIError.invalidResponse
                }
                return TrophyWallRunHistoryEntry(
                    logicalIdentity: TrophyWallLogicalIdentity(
                        persistedKey: entry.logicalIdentity.idempotencyKey
                    ),
                    orderKey: orderKey,
                    run: entry.run
                )
            }
            guard zip(entries, entries.dropFirst()).allSatisfy({ pair in
                pair.0.orderKey > pair.1.orderKey
            }) else {
                throw RunAPIError.invalidResponse
            }
            return TrophyWallRunHistoryPage(
                entries: entries,
                nextCursor: payload.nextCursor
            )
        } catch let error as RunAPIError {
            throw error
        } catch {
            throw RunAPIError.invalidResponse
        }
    }

    private static func error(for statusCode: Int) -> RunAPIError {
        switch statusCode {
        case 401, 403:
            .authenticationRequired
        case 400:
            .invalidResponse
        default:
            .unavailable
        }
    }
}

private struct RunEnvelope: Decodable {
    let data: DurableRun
    let meta: ResponseMeta

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case data
        case meta
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.runContractContainer(keyedBy: CodingKeys.self)
        data = try values.decode(DurableRun.self, forKey: .data)
        meta = try values.decode(ResponseMeta.self, forKey: .meta)
    }
}

private struct RunHistoryEnvelope: Decodable {
    struct DataPayload: Decodable {
        struct Entry: Decodable {
            struct LogicalIdentity: Decodable {
                let idempotencyKey: String

                private enum CodingKeys: String, CodingKey, CaseIterable {
                    case idempotencyKey
                }

                init(from decoder: Decoder) throws {
                    let values = try decoder.runContractContainer(keyedBy: CodingKeys.self)
                    idempotencyKey = try values.decode(String.self, forKey: .idempotencyKey)
                }
            }

            struct OrderKey: Decodable {
                let lastMeaningfulUpdateAt: String
                let runID: UUID

                private enum CodingKeys: String, CodingKey, CaseIterable {
                    case lastMeaningfulUpdateAt
                    case runID = "runId"
                }

                init(from decoder: Decoder) throws {
                    let values = try decoder.runContractContainer(keyedBy: CodingKeys.self)
                    lastMeaningfulUpdateAt = try values.decode(
                        String.self,
                        forKey: .lastMeaningfulUpdateAt
                    )
                    runID = try values.decode(UUID.self, forKey: .runID)
                }
            }

            let run: DurableRun
            let logicalIdentity: LogicalIdentity
            let orderKey: OrderKey

            private enum CodingKeys: String, CodingKey, CaseIterable {
                case run
                case logicalIdentity
                case orderKey
            }

            init(from decoder: Decoder) throws {
                let values = try decoder.runContractContainer(keyedBy: CodingKeys.self)
                run = try values.decode(DurableRun.self, forKey: .run)
                logicalIdentity = try values.decode(LogicalIdentity.self, forKey: .logicalIdentity)
                orderKey = try values.decode(OrderKey.self, forKey: .orderKey)
            }
        }

        let entries: [Entry]
        let nextCursor: String?

        private enum CodingKeys: String, CodingKey, CaseIterable {
            case entries
            case nextCursor
        }

        init(from decoder: Decoder) throws {
            let values = try decoder.runContractContainer(keyedBy: CodingKeys.self)
            entries = try values.decode([Entry].self, forKey: .entries)
            nextCursor = try values.decodeRequiredIfPresent(String.self, forKey: .nextCursor)
        }
    }

    let data: DataPayload
    let meta: ResponseMeta

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case data
        case meta
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.runContractContainer(keyedBy: CodingKeys.self)
        data = try values.decode(DataPayload.self, forKey: .data)
        meta = try values.decode(ResponseMeta.self, forKey: .meta)
    }
}

struct UnavailableRunService: RunServing {
    func fetchRun(id: UUID, bearerToken: String) async throws -> DurableRun {
        throw RunAPIError.unavailable
    }
}
