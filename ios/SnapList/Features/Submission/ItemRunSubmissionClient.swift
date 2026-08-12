import Foundation

/// Builds the one `multipart/form-data` mutation `POST /v1/items/runs` accepts.
/// Photos remain in display order; an exact recovered WAV and its locale hint travel
/// under the same persisted idempotency key.
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
        if let voice = payload.attempt.voiceContext,
           let voiceData = payload.voiceData {
            body.append(Data("--\(boundary)\r\n".utf8))
            body.append(
                Data(
                    """
                    Content-Disposition: form-data; name="voiceContext"; \
                    filename="seller-context.wav"\r\n
                    """.utf8
                )
            )
            body.append(
                Data(
                    "Content-Type: \(ItemRunSubmissionVoice.mediaType)\r\n\r\n"
                        .utf8
                )
            )
            body.append(voiceData)
            body.append(Data("\r\n".utf8))
            if let localeHint = voice.localeHint {
                body.append(Data("--\(boundary)\r\n".utf8))
                body.append(
                    Data(
                        "Content-Disposition: form-data; name=\"voiceContextLocale\"\r\n\r\n"
                            .utf8
                    )
                )
                body.append(Data(localeHint.utf8))
                body.append(Data("\r\n".utf8))
            }
        }
        if let recovery = payload.attempt.guestRecoveryIdentity {
            body.append(Data("--\(boundary)\r\n".utf8))
            body.append(
                Data(
                    "Content-Disposition: form-data; name=\"recoveryId\"\r\n\r\n"
                        .utf8
                )
            )
            body.append(Data(recovery.recoveryID.uuidString.lowercased().utf8))
            body.append(Data("\r\n".utf8))
            body.append(Data("--\(boundary)\r\n".utf8))
            body.append(
                Data(
                    "Content-Disposition: form-data; name=\"recoveryTokenHash\"\r\n\r\n"
                        .utf8
                )
            )
            body.append(Data(recovery.recoveryTokenHash.utf8))
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
        let body = ItemRunSubmissionMultipart.body(
            for: payload,
            boundary: boundary
        )
        // The on-device budget bounds each photo, but it is best effort for bytes
        // no encoder can shrink, so an over-ceiling body is still reachable. The
        // platform would answer `413` after the whole thing crossed the network;
        // refusing here costs the seller nothing and reaches the same honest
        // message. This is the only place the assembled body size is known.
        guard body.count <= CapturePhotoBudget.maximumRequestBodyBytes else {
            return .tooLarge
        }
        request.httpBody = body

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError {
            // The request may or may not have committed, so the caller has to retry the
            // same bytes under the same key rather than treat this as a refusal.
            if Task.isCancelled || error.code == .cancelled {
                return .cancelled
            }
            if error.code == .notConnectedToInternet {
                return .offline
            }
            return .ambiguous
        } catch {
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
        case 413:
            // The platform refuses an oversize body above this app, so `data` holds an
            // edge-server page rather than a SnapList envelope. Nothing was committed and
            // the same bytes will be refused again, so this must not fall into `ambiguous`,
            // which offers the seller a retry that can only fail.
            return .tooLarge
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
