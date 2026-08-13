import Foundation

/**
 Issue #385. `POST /v1/account/erasure`, kept off `MobileAPIClient` for the same
 reason `IncludedOfferRedeeming` is: a surface with no business deleting an
 account should not be able to reach the call that does.

 Every failure is returned rather than thrown. There is no caller who could
 recover from a thrown error here; the seller is standing in front of a screen
 that has to say something true, and a refusal is one of the true things.
 */
protocol AccountErasureRequesting: Sendable {
    func requestErasure(idempotencyKey: String) async -> AccountErasureOutcome
}

struct URLSessionAccountErasureClient: AccountErasureRequesting {
    private let apiOrigin: URL
    private let reverifiedBearerToken: @Sendable () async throws -> String
    private let session: URLSession

    /// `reverifiedBearerToken` must mint a token that reflects the reverification
    /// the seller just completed. A cached token issued before it carries the
    /// older `fva` claim, and the handler's `has({ reverification: "strict" })`
    /// check reads that claim, so a stale token earns a challenge for a
    /// challenge the seller already answered.
    init(
        apiOrigin: URL,
        reverifiedBearerToken: @escaping @Sendable () async throws -> String,
        session: URLSession = .shared
    ) {
        self.apiOrigin = apiOrigin
        self.reverifiedBearerToken = reverifiedBearerToken
        self.session = session
    }

    func requestErasure(idempotencyKey: String) async -> AccountErasureOutcome {
        var request = URLRequest(
            url: apiOrigin.appending(path: "/v1/account/erasure")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        do {
            request.setValue(
                "Bearer \(try await reverifiedBearerToken())",
                forHTTPHeaderField: "Authorization"
            )
        } catch {
            return .notConfirmed(.transport)
        }

        guard
            let (data, response) = try? await session.data(for: request),
            let httpResponse = response as? HTTPURLResponse
        else {
            return .notConfirmed(.transport)
        }

        // The durable answer is tried first, because it is the only thing that
        // can report a deletion. Only a response that carries no erasure state
        // at all falls through to being classified by its HTTP status.
        if let envelope = try? JSONDecoder().decode(
            AccountErasureEnvelope.self,
            from: data
        ) {
            return envelope.data.outcome
        }

        if AccountErasureChallenge.isReverification(data) {
            return .notConfirmed(.reverificationRequired)
        }

        return switch httpResponse.statusCode {
        case 409: .notConfirmed(.idempotencyKeyConflict)
        // The handler's own 503 message says to retry with the same key. It
        // cannot say whether retrying will ever work: a transient fault and a
        // permanently unconfigured deployment produce this identical body.
        case 503: .notConfirmed(.serverUnavailable)
        default: .notConfirmed(.transport)
        }
    }
}

/// Recognises the Clerk strict-reverification challenge, which arrives as a 403
/// the seller can actually answer. Matching on the `clerk_error` reason rather
/// than the status keeps an ordinary 403 from being offered as one.
private enum AccountErasureChallenge {
    private struct Body: Decodable {
        struct ClerkError: Decodable {
            let type: String
            let reason: String
        }

        let clerk_error: ClerkError
    }

    static func isReverification(_ data: Data) -> Bool {
        guard let body = try? JSONDecoder().decode(Body.self, from: data) else {
            return false
        }
        return body.clerk_error.type == "forbidden"
            && body.clerk_error.reason == "reverification-error"
    }
}

private struct AccountErasureEnvelope: Decodable {
    struct Payload: Decodable {
        let status: String
        let retainedRecords: [String]

        /// Read from the durable status, never from the HTTP status. The handler
        /// answers 202 to `deletion_needs_attention` exactly as it does to
        /// `deletion_in_progress`, so `2xx` means only that the request arrived.
        var outcome: AccountErasureOutcome {
            switch status {
            case "deletion_completed", "deletion_completed_with_retained_records":
                .completed(
                    retainedRecords: retainedRecords.compactMap(
                        AccountErasureRetainedRecord.init(rawValue:)
                    )
                )
            case "deletion_requested", "deletion_in_progress":
                .pending
            case "deletion_needs_attention":
                .needsAttention
            default:
                // A status this build does not know is not a deletion it can
                // report. Saying so is the only safe reading.
                .notConfirmed(.transport)
            }
        }
    }

    let data: Payload
}
