import Foundation

protocol RunServing: Sendable {
    func fetchRun(id: UUID, bearerToken: String) async throws -> DurableRun
}

enum RunAPIError: Error, Equatable {
    case authenticationRequired
    case unavailable
    case invalidResponse
}

final class RunAPIClient: RunServing, @unchecked Sendable {
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

struct UnavailableRunService: RunServing {
    func fetchRun(id: UUID, bearerToken: String) async throws -> DurableRun {
        throw RunAPIError.unavailable
    }
}
