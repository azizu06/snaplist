import CryptoKit
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

/// The exact recovered WAV asset bound to one durable submission attempt.
///
/// The URL stays inside #540's opaque principal vault. It is a durable bytes
/// reference, not a server path or an authorization capability.
struct ItemRunSubmissionVoice: Codable, Equatable, Sendable {
    static let mediaType = "audio/wav"
    static let maximumByteLength = 512 * 1024
    static let maximumDurationMilliseconds = 15_000

    let assetID: UUID
    let mediaURL: URL
    let contentSha256: String
    let byteLength: Int
    let durationMilliseconds: Int
    let localeHint: String?
}

/// One logical submission: the key the server deduplicates on, bound to the exact
/// ordered photo identity and optional recovered voice it was minted for.
///
/// The key is persisted with its snapshot rather than generated per network attempt.
/// A key regenerated on retry would let the server treat an exact replay as a second
/// submission, creating a second run and spending a second AI-item credit.
struct ItemRunSubmissionAttempt: Codable, Equatable, Sendable {
    /// Bumped when the persisted shape changes. A record written by another version is
    /// recognisably stale rather than corrupt, so it can be discarded instead of
    /// blocking the seller.
    static let currentSchemaVersion = 3

    let idempotencyKey: UUID
    let photos: [ItemRunSubmissionPhoto]
    let voiceContext: ItemRunSubmissionVoice?
    /// Hash-only server identity. The corresponding raw token lives only in
    /// Keychain and is never encoded with the durable submission attempt.
    let guestRecoveryIdentity: GuestRecoverySubmissionIdentity?
    var schemaVersion = ItemRunSubmissionAttempt.currentSchemaVersion

    init(
        idempotencyKey: UUID,
        photos: [ItemRunSubmissionPhoto],
        voiceContext: ItemRunSubmissionVoice? = nil,
        guestRecoveryIdentity: GuestRecoverySubmissionIdentity? = nil,
        schemaVersion: Int = ItemRunSubmissionAttempt.currentSchemaVersion
    ) {
        self.idempotencyKey = idempotencyKey
        self.photos = photos
        self.voiceContext = voiceContext
        self.guestRecoveryIdentity = guestRecoveryIdentity
        self.schemaVersion = schemaVersion
    }

    /// Just enough of a stored record to tell a different shape from a broken one. A
    /// synthesised decode of the whole attempt cannot: a renamed or removed field and
    /// genuine corruption both surface as a decoding error.
    struct StoredVersion: Decodable {
        let schemaVersion: Int?
    }

    /// True when this attempt stands for the same submission the server would see.
    func standsFor(
        _ photos: [ItemRunSubmissionPhoto],
        voiceContext: ItemRunSubmissionVoice? = nil
    ) -> Bool {
        self.photos.map(\.fingerprint) == photos.map(\.fingerprint)
            && sameVoiceAsset(as: voiceContext)
    }

    /// The current locale preference is not request identity after an attempt is
    /// durable. Exact recovered bytes reuse the locale and key captured on that
    /// attempt; a different local asset or different bytes do not.
    private func sameVoiceAsset(as candidate: ItemRunSubmissionVoice?) -> Bool {
        switch (voiceContext, candidate) {
        case (nil, nil):
            return true
        case let (stored?, current?):
            return stored.assetID == current.assetID
                && stored.mediaURL == current.mediaURL
                && stored.contentSha256 == current.contentSha256
                && stored.byteLength == current.byteLength
                && stored.durationMilliseconds == current.durationMilliseconds
        case (nil, _?), (_?, nil):
            return false
        }
    }

    /// Identifies the same committed NativeIntake voice reference without claiming
    /// its bytes are still readable. This is only a fail-closed guard for a durable
    /// voice-bearing attempt; it never makes an unreadable asset submittable.
    func hasSameVoiceReference(as candidate: NativeIntake.Voice?) -> Bool {
        guard let stored = voiceContext, let candidate else {
            return false
        }
        return stored.assetID == candidate.id
            && stored.mediaURL == candidate.mediaURL
    }

    /// True when the receipt accounts for every submitted photo, in order, byte for
    /// byte. Voice acceptance is deliberately separate: a null or mismatched voice
    /// receipt still describes the canonical photo run but cannot authorize local
    /// voice cleanup.
    func matchesPhotos(
        receipt: MobileItemSubmissionEnvelope.DataPayload
    ) -> Bool {
        guard receipt.photos.count == photos.count else {
            return false
        }
        return zip(photos, receipt.photos).allSatisfy {
            submitted, received in
            received.ordinal == submitted.ordinal
                && received.contentSha256 == submitted.contentSha256
                && received.byteLength == submitted.byteLength
                && received.mediaType == submitted.mediaType.rawValue
        }
    }

    func verifiedGuestPhotoIdentity(
        receipt: MobileItemSubmissionEnvelope.DataPayload
    ) -> GuestPhotoIdentity? {
        guard receipt.photoIdentity.kind == "content_sha256_set_v1" else {
            return nil
        }
        let canonical = photos
            .map(\.contentSha256)
            .map { $0.lowercased() }
            .sorted()
            .joined(separator: "\n")
        let fingerprint = SHA256.hash(data: Data(canonical.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
        guard fingerprint == receipt.photoIdentity.fingerprint else {
            return nil
        }
        return GuestPhotoIdentity(
            kind: receipt.photoIdentity.kind,
            fingerprint: fingerprint
        )
    }

    /// Whole-bundle deletion is safe only when the nullable voice receipt accounts
    /// for the exact optional local asset. A rejected voice remains under #545's
    /// explicit discard and recovery-expiry authority.
    func permitsWholeIntakeCleanup(
        receipt: MobileItemSubmissionEnvelope.DataPayload
    ) -> Bool {
        switch (voiceContext, receipt.voiceContext) {
        case (nil, nil):
            return true
        case let (submitted?, received?):
            return received.version == 1
                && received.contentSha256 == submitted.contentSha256
                && received.byteLength == submitted.byteLength
                && received.durationMs == submitted.durationMilliseconds
                && received.mediaType == ItemRunSubmissionVoice.mediaType
        case (nil, _?), (_?, nil):
            return false
        }
    }
}

/// The attempt plus the exact ordered bytes it stands for.
struct ItemRunSubmissionPayload: Equatable, Sendable {
    let attempt: ItemRunSubmissionAttempt
    let photoData: [Data]
    let voiceData: Data?

    init(
        attempt: ItemRunSubmissionAttempt,
        photoData: [Data],
        voiceData: Data? = nil
    ) {
        self.attempt = attempt
        self.photoData = photoData
        self.voiceData = voiceData
    }
}

/// The canonical durable run identity a validated receipt carries. It makes no claim
/// about analysis, pricing, or delivery.
struct AcceptedItemRun: Equatable, Sendable {
    let runID: UUID
    let itemID: UUID
    let status: String
    let stage: String
}

/// The exact logical submission identity and canonical run produced by one
/// validated created or replayed receipt.
struct AcceptedItemRunHandoff: Equatable, Sendable {
    let idempotencyKey: UUID
    let acceptedRun: AcceptedItemRun
}

/// What one transport attempt resolved to. Every case except the two receipts leaves
/// the seller's intake untouched.
enum ItemRunSubmissionAmbiguityReason: Equatable, Sendable {
    case offline
    case cancelled
    case unknown
}

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
    /// `409` — the key is bound to different photos, cost, voice, or locale.
    case conflict
    /// `413` — the request body exceeded the platform limit and was refused
    /// above the app, so it carries no SnapList error envelope. The same bytes
    /// can never fit, which makes this a refusal rather than an ambiguity.
    case tooLarge
    /// `429` — submission capacity was reached.
    case rateLimited(reason: String?)
    /// Offline, cancelled, `503`, or any other unknown outcome. The submission may or
    /// may not have committed, so the exact bytes and key have to be retried as-is.
    case offline
    case cancelled
    case ambiguous
}

/// Why a submission left the seller's intake in place.
enum ItemRunSubmissionRetention: Equatable, Sendable {
    case offline
    case cancelled
    case ambiguous
    case conflict
    case creditDenied(reason: String?)
    case rateLimited(reason: String?)
    case rejected
    /// There is no account behind this submission: no credential at all, or a
    /// guest capability the route refused. Only this asks for an account.
    case authenticationRequired
    /// The route answered `401` to a seller who was signed in. The credential
    /// existed and was rejected — an expired or revoked session, clock skew, or
    /// an origin that will not verify this token (#804). Nothing about it says
    /// the seller lacks an account, and the next attempt mints a fresh token,
    /// so this stays a retry rather than a demand to sign up.
    case sessionRenewalRequired
    /// The request body was refused for size before it reached the app. Retrying the
    /// same photos cannot help, so this is separate from `ambiguous` — the seller has
    /// to change the photo set.
    case photosTooLarge
    /// A `200`/`202` whose receipt did not describe what was submitted.
    case receiptMismatch
    /// The local intake could not be read as one to five valid photos, or the photos on
    /// screen could not be committed to the durable draft before the request.
    case intakeUnavailable
    /// The attempt identity could not be made durable, so no request was sent. Sending
    /// without a persisted key would let a retry mint a second key for the same photos
    /// and buy a second run.
    case attemptNotPersisted
    /// The submission could not proceed for a reason that says nothing about
    /// the seller or their item: no API origin is configured, the bearer stopped
    /// matching the intake's principal, a transient credential failure, or the
    /// generation moved on mid-flight. All of them take the same conservative
    /// retry, and none of them may be read as a verdict on the account.
    case submissionUnavailable
    /// #843 item 3. The intake is filed under this installation rather than
    /// under a seller, so its scope can never match a bearer's principal proof.
    /// Every send from it fails the same way, which makes the generic retry a
    /// loop. A later App Attest enrollment or sign-in binds a real principal and
    /// makes the item sendable, so this stays retryable — it just says which
    /// thing has to change first.
    case deviceIdentityUnavailable
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
        let voiceContext: ItemRunSubmissionVoice?
        let voiceData: Data?
    }

    /// Reads the seller's ordered photos once into both the logical identity the
    /// submission is bound to and the bytes it sends. Ordinals follow display order,
    /// which is the order the server assigns to the repeated multipart parts.
    ///
    /// One read matters: a second pass could see different bytes than the ones already
    /// fingerprinted, and the request would then describe photos it did not send.
    static func make(
        for staged: [StagedCapturePhoto],
        voice: NativeIntake.Voice? = nil,
        localeHint: String? = nil,
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
        let preparedVoice: (ItemRunSubmissionVoice, Data)?
        if let voice {
            if let data = try? readData(voice.mediaURL),
               let durationMilliseconds = voiceDurationMilliseconds(data) {
                preparedVoice = (
                    ItemRunSubmissionVoice(
                        assetID: voice.id,
                        mediaURL: voice.mediaURL,
                        contentSha256: LocalPhotoFingerprint.digest(of: data),
                        byteLength: data.count,
                        durationMilliseconds: durationMilliseconds,
                        localeHint: localeHint
                    ),
                    data
                )
            } else {
                preparedVoice = nil
            }
        } else {
            preparedVoice = nil
        }
        return Result(
            photos: photos,
            photoData: photoData,
            voiceContext: preparedVoice?.0,
            voiceData: preparedVoice?.1
        )
    }

    private static func voiceDurationMilliseconds(_ data: Data) -> Int? {
        guard data.count >= 44,
              data.count <= ItemRunSubmissionVoice.maximumByteLength,
              Data(data.prefix(4)) == Data("RIFF".utf8),
              data.subdata(in: 8..<12) == Data("WAVE".utf8),
              integer(in: data, at: 4, byteCount: 4) == data.count - 8
        else {
            return nil
        }

        var offset = 12
        var foundFormat = false
        var dataByteLength = 0
        while offset + 8 <= data.count {
            let chunkID = data.subdata(in: offset..<(offset + 4))
            guard let chunkLength = integer(
                in: data,
                at: offset + 4,
                byteCount: 4
            ) else {
                return nil
            }
            let chunkStart = offset + 8
            let chunkEnd = chunkStart + chunkLength
            guard chunkEnd <= data.count else {
                return nil
            }
            if chunkID == Data("fmt ".utf8), !foundFormat {
                guard chunkLength >= 16,
                      integer(in: data, at: chunkStart, byteCount: 2) == 1,
                      integer(in: data, at: chunkStart + 2, byteCount: 2) == 1,
                      integer(in: data, at: chunkStart + 4, byteCount: 4) == 16_000,
                      integer(in: data, at: chunkStart + 8, byteCount: 4) == 32_000,
                      integer(in: data, at: chunkStart + 12, byteCount: 2) == 2,
                      integer(in: data, at: chunkStart + 14, byteCount: 2) == 16
                else {
                    return nil
                }
                foundFormat = true
            } else if chunkID == Data("data".utf8) {
                dataByteLength += chunkLength
            }
            offset = chunkEnd + chunkLength % 2
        }

        guard offset == data.count,
              foundFormat,
              dataByteLength > 0,
              dataByteLength.isMultiple(of: 2)
        else {
            return nil
        }
        let duration = Int(
            ceil(Double(dataByteLength / 2) / 16_000 * 1_000)
        )
        guard duration <= ItemRunSubmissionVoice.maximumDurationMilliseconds
        else {
            return nil
        }
        return duration
    }

    private static func integer(
        in data: Data,
        at offset: Int,
        byteCount: Int
    ) -> Int? {
        guard byteCount > 0, byteCount <= 4, offset + byteCount <= data.count
        else {
            return nil
        }
        return data[offset..<(offset + byteCount)]
            .enumerated()
            .reduce(0) { result, pair in
                result | Int(pair.element) << (pair.offset * 8)
            }
    }
}
