import Foundation

struct ListingReviewSaveReceipt: Decodable, Equatable, Sendable {
    let schemaVersion: Int
    let runID: UUID
    let itemID: UUID
    let listingID: UUID
    let reviewRevision: UUID

    private enum CodingKeys: String, CodingKey {
        case schemaVersion
        case runID = "runId"
        case itemID = "itemId"
        case listingID = "listingId"
        case reviewRevision
    }
}

enum ListingReviewClientError: Error, Equatable {
    case offline
    case conflict
    /// A 409 the same request can never clear. The associated value is the
    /// server's own sentence, which names the remedy the seller has to act on;
    /// #951 exists because every one of these used to reach the seller as
    /// `ListingReviewCopy.saveFailed`, telling them to retry forever.
    case refused(String)
    case unavailable
    case invalidResponse
}

protocol ListingReviewServing: Sendable {
    func save(
        runID: UUID,
        draft: ListingReviewDraft,
        expectedReviewRevision: UUID,
        idempotencyKey: UUID,
        bearerToken: String
    ) async throws -> ListingReviewSaveReceipt

    func fetchReview(
        runID: UUID,
        bearerToken: String
    ) async throws -> ListingReviewResult
}

struct ListingReviewAPIClient: ListingReviewServing {
    private let baseURL: URL
    private let session: URLSession
    private let runService: any RunServing

    init(
        baseURL: URL,
        session: URLSession = .shared
    ) {
        self.baseURL = baseURL
        self.session = session
        runService = RunAPIClient(baseURL: baseURL, session: session)
    }

    func save(
        runID: UUID,
        draft: ListingReviewDraft,
        expectedReviewRevision: UUID,
        idempotencyKey: UUID,
        bearerToken: String
    ) async throws -> ListingReviewSaveReceipt {
        var request = URLRequest(
            url: baseURL
                .appendingPathComponent("v1")
                .appendingPathComponent("runs")
                .appendingPathComponent(runID.uuidString.lowercased())
                .appendingPathComponent("review")
        )
        request.httpMethod = "PUT"
        request.setValue(
            "Bearer \(bearerToken)",
            forHTTPHeaderField: "Authorization"
        )
        request.setValue(
            idempotencyKey.uuidString.lowercased(),
            forHTTPHeaderField: "Idempotency-Key"
        )
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(
            SaveIntent(
                expectedReviewRevision: expectedReviewRevision,
                title: draft.title.trimmingCharacters(in: .whitespacesAndNewlines),
                description: draft.description.trimmingCharacters(in: .whitespacesAndNewlines),
                condition: draft.condition,
                specifics: draft.specifics,
                sellerPriceOverride: draft.sellerPriceOverride
            )
        )

        do {
            let (data, response) = try await session.data(for: request)
            guard let response = response as? HTTPURLResponse else {
                throw ListingReviewClientError.invalidResponse
            }
            if response.statusCode == 409 {
                let envelope = try? JSONDecoder().decode(
                    ErrorEnvelope.self,
                    from: data
                )
                // The permanent refusals are the only 409s that carry copy
                // written for the seller, and the code -- not the sentence --
                // is what says so. Matching the sentence instead would make
                // editing it for tone silently reroute the state (#951).
                if envelope?.error.code == "conflict_permanent",
                   let message = envelope?.error.message,
                   !message.trimmingCharacters(in: .whitespacesAndNewlines)
                       .isEmpty {
                    throw ListingReviewClientError.refused(message)
                }
                if envelope?.error.code == "conflict",
                   envelope?.error.message == ListingReviewCopy.staleReview {
                    throw ListingReviewClientError.conflict
                }
                throw ListingReviewClientError.unavailable
            }
            guard response.statusCode == 200 else {
                throw ListingReviewClientError.unavailable
            }
            let envelope = try JSONDecoder().decode(SaveEnvelope.self, from: data)
            guard envelope.data.schemaVersion == 1,
                  envelope.data.runID == runID else {
                throw ListingReviewClientError.invalidResponse
            }
            return envelope.data
        } catch let error as ListingReviewClientError {
            throw error
        } catch let error as URLError
            where error.code == .notConnectedToInternet
                || error.code == .networkConnectionLost
                || error.code == .timedOut {
            throw ListingReviewClientError.offline
        } catch is DecodingError {
            throw ListingReviewClientError.invalidResponse
        } catch {
            throw ListingReviewClientError.unavailable
        }
    }

    func fetchReview(
        runID: UUID,
        bearerToken: String
    ) async throws -> ListingReviewResult {
        do {
            let run = try await runService.fetchRun(
                id: runID,
                bearerToken: bearerToken
            )
            guard run.id == runID,
                  run.legalActions.canOpenReview,
                  let review = run.review,
                  review.binding.runID == runID else {
                throw ListingReviewClientError.invalidResponse
            }
            return review
        } catch let error as URLError
            where error.code == .notConnectedToInternet
                || error.code == .networkConnectionLost
                || error.code == .timedOut {
            throw ListingReviewClientError.offline
        } catch let error as ListingReviewClientError {
            throw error
        } catch {
            throw ListingReviewClientError.unavailable
        }
    }
}

private extension ListingReviewAPIClient {
    struct SaveIntent: Encodable {
        let expectedReviewRevision: UUID
        let title: String
        let description: String
        let condition: ListingReviewCondition
        let specifics: [ListingReviewSpecific]
        let sellerPriceOverride: Decimal?
    }

    struct SaveEnvelope: Decodable {
        let data: ListingReviewSaveReceipt
    }

    struct ErrorEnvelope: Decodable {
        let error: APIError

        struct APIError: Decodable {
            let code: String
            let message: String
        }
    }
}
