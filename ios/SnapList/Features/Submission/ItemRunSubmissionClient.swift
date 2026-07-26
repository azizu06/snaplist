import Foundation

/// Builds the `multipart/form-data` body `POST /v1/items/runs` accepts: the `photo`
/// field repeated once per photo, in display order, and nothing else. Ordinals are the
/// part order, so the body is the only place display order is expressed.
enum ItemRunSubmissionMultipart {
    static func body(
        for payload: ItemRunSubmissionPayload,
        boundary: String
    ) -> Data {
        var body = Data()
        for (photo, data) in zip(payload.attempt.photos, payload.photoData) {
            let filename = "photo-\(photo.ordinal).\(photo.mediaType.fileExtension)"
            body.append(Data("--\(boundary)\r\n".utf8))
            body.append(
                Data(
                    """
                    Content-Disposition: form-data; name="photo"; \
                    filename="\(filename)"\r\n
                    """.utf8
                )
            )
            body.append(Data("Content-Type: \(photo.mediaType.rawValue)\r\n\r\n".utf8))
            body.append(data)
            body.append(Data("\r\n".utf8))
        }
        body.append(Data("--\(boundary)--\r\n".utf8))
        return body
    }
}

/// The authenticated multipart transport for `POST /v1/items/runs`.
struct ItemRunSubmissionClient: ItemRunSubmitting {
    private let baseURL: URL
    private let session: URLSession
    private let boundary: @Sendable () -> String

    init(
        baseURL: URL,
        session: URLSession = .shared,
        boundary: @escaping @Sendable () -> String = {
            "snaplist-\(UUID().uuidString)"
        }
    ) {
        self.baseURL = baseURL
        self.session = session
        self.boundary = boundary
    }

    func submit(
        _ payload: ItemRunSubmissionPayload,
        bearerToken: String
    ) async -> ItemRunSubmissionTransportOutcome {
        let boundary = boundary()
        var request = URLRequest(url: baseURL.appending(path: "/v1/items/runs"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        request.setValue(
            payload.attempt.idempotencyKey.uuidString.lowercased(),
            forHTTPHeaderField: "Idempotency-Key"
        )
        request.setValue(
            "multipart/form-data; boundary=\(boundary)",
            forHTTPHeaderField: "Content-Type"
        )
        request.httpBody = ItemRunSubmissionMultipart.body(
            for: payload,
            boundary: boundary
        )

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            // The request may or may not have committed, so the caller has to retry the
            // same bytes under the same key rather than treat this as a refusal.
            return .ambiguous
        }
        guard let httpResponse = response as? HTTPURLResponse else {
            return .ambiguous
        }

        switch httpResponse.statusCode {
        case 200, 202:
            guard let receipt = try? JSONDecoder().decode(
                MobileItemSubmissionEnvelope.self,
                from: data
            ).data else {
                // A success this client cannot read is not acceptance it can act on.
                return .ambiguous
            }
            return httpResponse.statusCode == 202
                ? .created(receipt)
                : .replayed(receipt)
        case 400:
            return .rejected
        case 401:
            return .authenticationRequired
        case 403:
            return .creditDenied(reason: Self.reason(in: data))
        case 409:
            return .conflict
        case 429:
            return .rateLimited(reason: Self.reason(in: data))
        default:
            return .ambiguous
        }
    }

    private static func reason(in data: Data) -> String? {
        try? JSONDecoder()
            .decode(SubmissionErrorEnvelope.self, from: data)
            .error
            .details?
            .reason
    }
}

private struct SubmissionErrorEnvelope: Decodable {
    struct Details: Decodable {
        let reason: String?
    }

    struct ErrorPayload: Decodable {
        let code: String
        let details: Details?
    }

    let error: ErrorPayload
}
