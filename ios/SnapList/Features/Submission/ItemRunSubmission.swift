import Foundation

/// The image types `POST /v1/items/runs` accepts. The server sniffs the bytes and
/// rejects any part whose declared type disagrees with them, so the client declares
/// only what it read off the file itself.
enum ItemRunSubmissionMediaType: String, Codable, Equatable, CaseIterable, Sendable {
    case jpeg = "image/jpeg"
    case png = "image/png"
    case webp = "image/webp"

    static func sniff(_ data: Data) -> ItemRunSubmissionMediaType? {
        let bytes = [UInt8](data.prefix(12))
        if bytes.count >= 3, bytes[0] == 0xFF, bytes[1] == 0xD8, bytes[2] == 0xFF {
            return .jpeg
        }
        if bytes.count >= 8,
           Array(bytes[0..<8]) == [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] {
            return .png
        }
        if bytes.count >= 12,
           Array(bytes[0..<4]) == Array("RIFF".utf8),
           Array(bytes[8..<12]) == Array("WEBP".utf8) {
            return .webp
        }
        return nil
    }

    var fileExtension: String {
        switch self {
        case .jpeg: "jpg"
        case .png: "png"
        case .webp: "webp"
        }
    }
}

/// One photo's place in a submission and the identity the server echoes back for it.
struct ItemRunSubmissionPhoto: Codable, Equatable, Sendable {
    let photoID: UUID
    let ordinal: Int
    let contentSha256: String
    let byteLength: Int
    let mediaType: ItemRunSubmissionMediaType

    /// Everything the server deduplicates on, and nothing else. `photoID` is a local
    /// staging record, so a seller who removes a photo and stages the same image again
    /// has not made a different submission.
    struct Fingerprint: Equatable, Sendable {
        let ordinal: Int
        let contentSha256: String
        let byteLength: Int
        let mediaType: ItemRunSubmissionMediaType
    }

    var fingerprint: Fingerprint {
        Fingerprint(
            ordinal: ordinal,
            contentSha256: contentSha256,
            byteLength: byteLength,
            mediaType: mediaType
        )
    }
}

/// One logical submission: the key the server deduplicates on, bound to the exact
/// ordered photo identity it was minted for.
///
/// The key is persisted with its snapshot rather than generated per network attempt.
/// A key regenerated on retry would let the server treat an exact replay as a second
/// submission, creating a second run and spending a second AI-item credit.
struct ItemRunSubmissionAttempt: Codable, Equatable, Sendable {
    /// Bumped when the persisted shape changes. A record written by another version is
    /// recognisably stale rather than corrupt, so it can be discarded instead of
    /// blocking the seller.
    static let currentSchemaVersion = 1

    let idempotencyKey: UUID
    let photos: [ItemRunSubmissionPhoto]
    var schemaVersion = ItemRunSubmissionAttempt.currentSchemaVersion

    /// True when this attempt stands for the same submission the server would see.
    func standsFor(_ photos: [ItemRunSubmissionPhoto]) -> Bool {
        self.photos.map(\.fingerprint) == photos.map(\.fingerprint)
    }

    /// True when the receipt accounts for every submitted photo, in order, byte for
    /// byte. Anything less means the server is describing a different submission and
    /// the seller's intake must survive.
    func matches(receipt: MobileItemSubmissionEnvelope.DataPayload) -> Bool {
        guard receipt.photos.count == photos.count else {
            return false
        }
        return zip(photos, receipt.photos).allSatisfy { submitted, received in
            received.ordinal == submitted.ordinal
                && received.contentSha256 == submitted.contentSha256
                && received.byteLength == submitted.byteLength
                && received.mediaType == submitted.mediaType.rawValue
        }
    }
}

/// The attempt plus the exact ordered bytes it stands for.
struct ItemRunSubmissionPayload: Equatable, Sendable {
    let attempt: ItemRunSubmissionAttempt
    let photoData: [Data]
}

/// The canonical durable run identity a validated receipt carries. This is the typed
/// hand-off #375 consumes; it makes no claim about analysis, pricing, or delivery.
struct AcceptedItemRun: Equatable, Sendable {
    let runID: UUID
    let itemID: UUID
    let status: String
    let stage: String
}

/// What one transport attempt resolved to. Every case except the two receipts leaves
/// the seller's intake untouched.
enum ItemRunSubmissionTransportOutcome: Equatable, Sendable {
    /// `202` — the item, reservation, run, and queue message committed on this attempt.
    case created(MobileItemSubmissionEnvelope.DataPayload)
    /// `200` — an exact idempotent replay of a submission that already committed.
    case replayed(MobileItemSubmissionEnvelope.DataPayload)
    /// `400` — the request itself is not acceptable; the same bytes will not become valid.
    case rejected
    /// `401` — no usable Clerk session.
    case authenticationRequired
    /// `403` — AI-item credit policy denied this submission.
    case creditDenied(reason: String?)
    /// `409` — the key is bound to different bytes, order, or cost basis.
    case conflict
    /// `429` — submission capacity was reached.
    case rateLimited(reason: String?)
    /// Offline, cancelled, `503`, or any other unknown outcome. The submission may or
    /// may not have committed, so the exact bytes and key have to be retried as-is.
    case ambiguous
}

/// Why a submission left the seller's intake in place.
enum ItemRunSubmissionRetention: Equatable, Sendable {
    case ambiguous
    case conflict
    case creditDenied(reason: String?)
    case rateLimited(reason: String?)
    case rejected
    case authenticationRequired
    /// A `200`/`202` whose receipt did not describe what was submitted.
    case receiptMismatch
    /// The local intake could not be read as one to five valid photos.
    case intakeUnavailable
    /// The attempt identity could not be made durable, so no request was sent. Sending
    /// without a persisted key would let a retry mint a second key for the same photos
    /// and buy a second run.
    case attemptNotPersisted
    /// A stored attempt exists but cannot be read, so its key is unknown. Minting a new
    /// one would submit photos that may already have a run and charge for them twice.
    case attemptUnreadable
    /// The app has no API origin configured, so there is nowhere to submit.
    case submissionUnavailable
}

struct ItemRunAcceptance: Equatable, Sendable {
    let run: AcceptedItemRun
    /// False when the intake changed while the submission was in flight. The run is
    /// still canonical; the seller's current photos are not the ones it accepted.
    let clearedIntake: Bool
}

enum ItemRunSubmissionOutcome: Equatable, Sendable {
    case accepted(ItemRunAcceptance)
    case retained(ItemRunSubmissionRetention)
}

/// Durable storage for the in-flight attempt identity.
protocol ItemRunSubmissionAttemptStoring: Sendable {
    func loadAttempt() async throws -> ItemRunSubmissionAttempt?
    func saveAttempt(_ attempt: ItemRunSubmissionAttempt) async throws
    /// Removes `attempt` only when it is still the stored one.
    func clearAttempt(_ attempt: ItemRunSubmissionAttempt) async throws
}

/// The authenticated multipart transport for `POST /v1/items/runs`.
protocol ItemRunSubmitting: Sendable {
    func submit(
        _ payload: ItemRunSubmissionPayload,
        bearerToken: String
    ) async -> ItemRunSubmissionTransportOutcome
}

enum ItemRunSubmissionSnapshotError: Error, Equatable {
    case unsupportedPhotoCount
    case unreadablePhoto
    case unsupportedMediaType
}

enum ItemRunSubmissionSnapshot {
    static let photoCountLimits = 1...5

    struct Result: Equatable {
        let photos: [ItemRunSubmissionPhoto]
        let photoData: [Data]
    }

    /// Reads the seller's ordered photos once into both the logical identity the
    /// submission is bound to and the bytes it sends. Ordinals follow display order,
    /// which is the order the server assigns to the repeated multipart parts.
    ///
    /// One read matters: a second pass could see different bytes than the ones already
    /// fingerprinted, and the request would then describe photos it did not send.
    static func make(
        for staged: [StagedCapturePhoto],
        readData: (URL) throws -> Data
    ) throws -> Result {
        guard photoCountLimits.contains(staged.count) else {
            throw ItemRunSubmissionSnapshotError.unsupportedPhotoCount
        }
        var photos: [ItemRunSubmissionPhoto] = []
        var photoData: [Data] = []
        for (ordinal, photo) in staged.enumerated() {
            let data: Data
            do {
                data = try readData(photo.photoURL)
            } catch {
                throw ItemRunSubmissionSnapshotError.unreadablePhoto
            }
            guard !data.isEmpty else {
                throw ItemRunSubmissionSnapshotError.unreadablePhoto
            }
            guard let mediaType = ItemRunSubmissionMediaType.sniff(data) else {
                throw ItemRunSubmissionSnapshotError.unsupportedMediaType
            }
            photos.append(
                ItemRunSubmissionPhoto(
                    photoID: photo.id,
                    ordinal: ordinal,
                    contentSha256: LocalPhotoFingerprint.digest(of: data),
                    byteLength: data.count,
                    mediaType: mediaType
                )
            )
            photoData.append(data)
        }
        return Result(photos: photos, photoData: photoData)
    }
}
