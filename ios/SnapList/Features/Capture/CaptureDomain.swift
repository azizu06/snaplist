import AVFoundation
import CoreGraphics
import CryptoKit
import Foundation
import ImageIO
import Observation
import SwiftUI
import UniformTypeIdentifiers

enum CaptureCameraAuthorization: Equatable {
    case notDetermined
    case authorized
    case denied
    case restricted
}

enum CaptureFlashMode: Equatable {
    case off
    case on
}

enum CapturePhase: Equatable {
    case idle
    case requestingPermission
    case camera
    case denied
    case unavailable
    case captured
    case reviewHandoff
    case failed
}

enum CaptureRestoration: Equatable {
    case noDraft
    case stagedPhoto
    case failed
}

enum FramingGuidance: Equatable {
    case coaching
    case moveCloser
    case accepted

    var cue: String? {
        switch self {
        case .coaching: nil
        case .moveCloser: "Move closer"
        case .accepted: "Whole item is in frame"
        }
    }

    var systemImage: String {
        switch self {
        case .coaching: "viewfinder"
        case .moveCloser: "arrow.up.left.and.arrow.down.right"
        case .accepted: "checkmark"
        }
    }
}

struct FramingObservation: Equatable {
    let subjectBounds: CGRect?

    static let noSubject = FramingObservation(subjectBounds: nil)
}

struct FramingEvaluationPolicy {
    var minimumAcceptedArea: CGFloat = 0.24
    var edgeInset: CGFloat = 0.08

    func guidance(for observation: FramingObservation) -> FramingGuidance {
        guard let bounds = observation.subjectBounds else {
            return .coaching
        }

        let safelyInsideEdges = bounds.minX >= edgeInset
            && bounds.minY >= edgeInset
            && bounds.maxX <= 1 - edgeInset
            && bounds.maxY <= 1 - edgeInset
        guard safelyInsideEdges else {
            return .coaching
        }

        return bounds.width * bounds.height >= minimumAcceptedArea
            ? .accepted
            : .moveCloser
    }
}

struct FramingGuidanceStabilizer {
    private let requiredConsecutiveFrames: Int
    private(set) var current: FramingGuidance = .coaching
    private var candidate: FramingGuidance?
    private var candidateCount = 0

    init(requiredConsecutiveFrames: Int = 2) {
        self.requiredConsecutiveFrames = max(1, requiredConsecutiveFrames)
    }

    mutating func consume(_ next: FramingGuidance) -> FramingGuidance {
        guard next != current else {
            candidate = nil
            candidateCount = 0
            return current
        }

        if candidate == next {
            candidateCount += 1
        } else {
            candidate = next
            candidateCount = 1
        }

        if candidateCount >= requiredConsecutiveFrames {
            current = next
            candidate = nil
            candidateCount = 0
        }
        return current
    }

    mutating func reset() {
        current = .coaching
        candidate = nil
        candidateCount = 0
    }
}

struct CaptureFrame {
    let pixelBuffer: CVPixelBuffer
    let orientation: CGImagePropertyOrientation
}

struct LibraryPhotoTransferReceipt: Codable, Equatable {
    let sourcePhotoFingerprints: [String]
    let sourceIndex: Int
    let transferredDigest: String

    init(
        sourcePhotoFingerprints: [String],
        sourceIndex: Int,
        transferredDigest: String? = nil
    ) {
        self.sourcePhotoFingerprints = sourcePhotoFingerprints
        self.sourceIndex = sourceIndex
        self.transferredDigest = transferredDigest
            ?? sourcePhotoFingerprints[safe: sourceIndex]
            ?? ""
    }

    var fingerprint: String {
        transferredDigest
    }

    var sourcePhotoCount: Int {
        sourcePhotoFingerprints.count
    }

    var remainingPhotoFingerprints: [String] {
        guard sourcePhotoFingerprints.indices.contains(sourceIndex) else {
            return sourcePhotoFingerprints
        }
        var fingerprints = sourcePhotoFingerprints
        fingerprints.remove(at: sourceIndex)
        return fingerprints
    }

    func matchesTransferredPhoto(_ imageData: Data) -> Bool {
        guard sourcePhotoFingerprints.indices.contains(sourceIndex),
              sourcePhotoFingerprints[sourceIndex] == transferredDigest else {
            return false
        }
        return LocalPhotoFingerprint.digest(of: imageData) == transferredDigest
    }

    private enum CodingKeys: String, CodingKey {
        case sourcePhotoFingerprints
        case sourceIndex
        case transferredDigest
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let sourcePhotoFingerprints = try container.decode(
            [String].self,
            forKey: .sourcePhotoFingerprints
        )
        let sourceIndex = try container.decode(Int.self, forKey: .sourceIndex)
        self.init(
            sourcePhotoFingerprints: sourcePhotoFingerprints,
            sourceIndex: sourceIndex,
            transferredDigest: try container.decodeIfPresent(
                String.self,
                forKey: .transferredDigest
            )
        )
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(sourcePhotoFingerprints, forKey: .sourcePhotoFingerprints)
        try container.encode(sourceIndex, forKey: .sourceIndex)
        try container.encode(transferredDigest, forKey: .transferredDigest)
    }
}

private extension Collection {
    subscript(safe index: Index) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}

enum LocalPhotoFingerprint {
    static func digest(of data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

struct StagedCapturePhoto: Codable, Equatable, Identifiable {
    let id: UUID
    let photoURL: URL
    let thumbnailURL: URL
    let createdAt: Date
    let libraryTransferReceipt: LibraryPhotoTransferReceipt?

    init(
        id: UUID,
        photoURL: URL,
        thumbnailURL: URL,
        createdAt: Date,
        libraryTransferReceipt: LibraryPhotoTransferReceipt? = nil
    ) {
        self.id = id
        self.photoURL = photoURL
        self.thumbnailURL = thumbnailURL
        self.createdAt = createdAt
        self.libraryTransferReceipt = libraryTransferReceipt
    }
}

enum PhotoReviewPickerRequest: Equatable {
    case add
    case replace(photoID: StagedCapturePhoto.ID)
}

enum PhotoReviewConfirmedPickerResult: Equatable {
    case additions([StagedCapturePhoto])
    case replacement(StagedCapturePhoto)
}

enum PhotoReviewPickerOpener: Equatable {
    case addButton
    case replaceButton(photoID: StagedCapturePhoto.ID)
}

enum PhotoReviewDeleteFocus: Equatable {
    case photo(StagedCapturePhoto.ID)
    case addButton
}

enum PhotoReviewReorderAction: Equatable {
    case moveEarlier
    case moveLater
    case makeCover
}

struct PhotoReviewReorderResult: Equatable {
    let photoID: StagedCapturePhoto.ID
    let index: Int
    let count: Int
    let announcement: String
}

@MainActor
@Observable
final class PhotoReviewStore {
    private(set) var photos: [StagedCapturePhoto]
    private(set) var selectedPhotoID: StagedCapturePhoto.ID?
    private(set) var actionsPhotoID: StagedCapturePhoto.ID?
    private(set) var activePickerRequest: PhotoReviewPickerRequest?

    init(photos: [StagedCapturePhoto]) {
        self.photos = photos
        selectedPhotoID = photos.first?.id
    }

    @discardableResult
    func selectPhotoForActions(id: StagedCapturePhoto.ID) -> Bool {
        guard photos.contains(where: { $0.id == id }) else {
            return false
        }
        selectedPhotoID = id
        actionsPhotoID = id
        return true
    }

    @discardableResult
    func dismissActions() -> StagedCapturePhoto.ID? {
        guard let photoID = actionsPhotoID else {
            return nil
        }
        actionsPhotoID = nil
        return photoID
    }

    func beginPickerRequest(_ request: PhotoReviewPickerRequest) {
        activePickerRequest = request
    }

    @discardableResult
    func cancelPickerRequest() -> PhotoReviewPickerOpener? {
        guard let request = activePickerRequest else {
            return nil
        }
        activePickerRequest = nil
        switch request {
        case .add:
            return .addButton
        case .replace(let photoID):
            return .replaceButton(photoID: photoID)
        }
    }

    @discardableResult
    func confirmPickerResult(
        _ result: PhotoReviewConfirmedPickerResult
    ) -> StagedCapturePhoto.ID? {
        guard let request = activePickerRequest else {
            return nil
        }

        switch (request, result) {
        case (.add, .additions(let additions)):
            guard let appliedPhotoID = additions.last?.id else {
                return nil
            }
            photos.append(contentsOf: additions)
            activePickerRequest = nil
            return appliedPhotoID

        case (.replace(let photoID), .replacement(let replacement)):
            guard let index = photos.firstIndex(where: { $0.id == photoID }) else {
                return nil
            }
            photos[index] = replacement
            if selectedPhotoID == photoID {
                selectedPhotoID = replacement.id
            }
            if actionsPhotoID == photoID {
                actionsPhotoID = replacement.id
            }
            activePickerRequest = nil
            return replacement.id

        default:
            return nil
        }
    }

    @discardableResult
    func movePhoto(id: StagedCapturePhoto.ID, to destinationIndex: Int) -> Bool {
        guard let sourceIndex = photos.firstIndex(where: { $0.id == id }),
              photos.indices.contains(destinationIndex) else {
            return false
        }

        let photo = photos.remove(at: sourceIndex)
        photos.insert(photo, at: destinationIndex)
        selectedPhotoID = photo.id
        return true
    }

    @discardableResult
    func performAccessibilityReorder(
        photoID: StagedCapturePhoto.ID,
        action: PhotoReviewReorderAction
    ) -> PhotoReviewReorderResult? {
        guard let sourceIndex = photos.firstIndex(where: { $0.id == photoID }) else {
            return nil
        }

        let destinationIndex: Int
        switch action {
        case .moveEarlier:
            guard sourceIndex > 0 else {
                return nil
            }
            destinationIndex = sourceIndex - 1
        case .moveLater:
            guard sourceIndex < photos.index(before: photos.endIndex) else {
                return nil
            }
            destinationIndex = sourceIndex + 1
        case .makeCover:
            guard sourceIndex > 0 else {
                return nil
            }
            destinationIndex = 0
        }

        let count = photos.count
        guard movePhoto(id: photoID, to: destinationIndex) else {
            return nil
        }
        if actionsPhotoID != photoID {
            actionsPhotoID = nil
        }

        let index = destinationIndex + 1
        let announcement = destinationIndex == 0
            ? "Moved to photo 1 of \(count). Cover."
            : "Moved to photo \(index) of \(count)."
        return PhotoReviewReorderResult(
            photoID: photoID,
            index: index,
            count: count,
            announcement: announcement
        )
    }

    @discardableResult
    func replacePhoto(
        id: StagedCapturePhoto.ID,
        with replacement: StagedCapturePhoto
    ) -> Bool {
        guard let index = photos.firstIndex(where: { $0.id == id }),
              !photos.contains(where: { $0.id == replacement.id && $0.id != id }) else {
            return false
        }

        photos[index] = replacement
        if selectedPhotoID == id {
            selectedPhotoID = replacement.id
        }
        if actionsPhotoID == id {
            actionsPhotoID = replacement.id
        }
        return true
    }

    @discardableResult
    func deletePhoto(id: StagedCapturePhoto.ID) -> Bool {
        deletePhotoForReview(id: id) != nil
    }

    @discardableResult
    func deletePhotoForReview(
        id: StagedCapturePhoto.ID
    ) -> PhotoReviewDeleteFocus? {
        guard let index = photos.firstIndex(where: { $0.id == id }) else {
            return nil
        }

        photos.remove(at: index)
        let focusPhotoID = photos[safe: index]?.id ?? photos.last?.id

        if selectedPhotoID == id {
            selectedPhotoID = focusPhotoID
        }
        if actionsPhotoID == id {
            actionsPhotoID = nil
        }

        guard let focusPhotoID else {
            return .addButton
        }
        return .photo(focusPhotoID)
    }
}

struct CaptureDraftAppendResult: Equatable {
    let appendedPhoto: StagedCapturePhoto
    let photos: [StagedCapturePhoto]
}

struct CaptureDraftReplaceResult: Equatable {
    let replacementPhoto: StagedCapturePhoto
    let photos: [StagedCapturePhoto]
}

protocol CaptureCamera: AnyObject {
    var session: AVCaptureSession { get }
    var captureDevice: AVCaptureDevice? { get }
    var isAvailable: Bool { get }
    var isFlashAvailable: Bool { get }

    func authorizationStatus() -> CaptureCameraAuthorization
    func requestAuthorization() async -> CaptureCameraAuthorization
    func start(frameHandler: @escaping (CaptureFrame) -> Void) async throws
    func stop()
    func setFlashMode(_ mode: CaptureFlashMode)
    func capturePhoto() async throws -> Data
}

extension CaptureCamera {
    var captureDevice: AVCaptureDevice? { nil }
    var isFlashAvailable: Bool { false }
    func setFlashMode(_ mode: CaptureFlashMode) {}
}

#if DEBUG
final class RestoredCaptureFixtureCamera: CaptureCamera {
    let session = AVCaptureSession()
    let isAvailable = true

    func authorizationStatus() -> CaptureCameraAuthorization { .authorized }
    func requestAuthorization() async -> CaptureCameraAuthorization { .authorized }
    func start(frameHandler: @escaping (CaptureFrame) -> Void) async throws {}
    func stop() {}
    func capturePhoto() async throws -> Data { Data() }
}
#endif

protocol FramingEvaluating {
    func evaluate(frame: CaptureFrame) async throws -> FramingObservation
}

@MainActor
protocol CaptureLibraryPhotoLoading {
    func loadPhotoData() async throws -> Data?
}

protocol CaptureDraftStoring {
    func load() async throws -> StagedCapturePhoto?
    func loadPhotos() async throws -> [StagedCapturePhoto]
    func stage(
        imageData: Data,
        libraryTransferReceipt: LibraryPhotoTransferReceipt?
    ) async throws -> StagedCapturePhoto
    func append(
        imageData: Data,
        libraryTransferReceipt: LibraryPhotoTransferReceipt?
    ) async throws -> CaptureDraftAppendResult
    /// Stages one new photo into an existing ordinal.
    ///
    /// Distinct from append plus `replacePhotos`, which cannot express this at five
    /// photos: appending first exceeds the cap, and dropping the target first would
    /// delete a photo the seller still has before its replacement is known to exist.
    func replace(
        photoID: StagedCapturePhoto.ID,
        imageData: Data,
        libraryTransferReceipt: LibraryPhotoTransferReceipt?
    ) async throws -> CaptureDraftReplaceResult
    func replacePhotos(with photos: [StagedCapturePhoto]) async throws
    func discard() async throws
    /// Discards the draft only when it still holds exactly `photos`, in that order.
    /// Returns whether the discard happened.
    ///
    /// Submission clears intake the seller can no longer see on screen, so an
    /// unconditional discard would delete photos added or replaced while a request was
    /// in flight. Refusing is always the recoverable answer.
    func discardExactly(_ photos: [StagedCapturePhoto]) async throws -> Bool
}

extension CaptureDraftStoring {
    /// Conformers that isolate their state should override this. The default reads and
    /// discards as two separate calls, so anything landing between them is not seen.
    func discardExactly(_ photos: [StagedCapturePhoto]) async throws -> Bool {
        guard try await loadPhotos() == photos else {
            return false
        }
        try await discard()
        return true
    }

    func loadPhotos() async throws -> [StagedCapturePhoto] {
        if let photo = try await load() {
            [photo]
        } else {
            []
        }
    }

    func stage(imageData: Data) async throws -> StagedCapturePhoto {
        try await stage(imageData: imageData, libraryTransferReceipt: nil)
    }

    func append(
        imageData: Data,
        libraryTransferReceipt: LibraryPhotoTransferReceipt?
    ) async throws -> CaptureDraftAppendResult {
        let photo = try await stage(
            imageData: imageData,
            libraryTransferReceipt: libraryTransferReceipt
        )
        return CaptureDraftAppendResult(appendedPhoto: photo, photos: [photo])
    }
}

enum CaptureDraftStoreError: Error {
    case invalidImage
    case couldNotEncodeImage
    case transferReceiptMismatch
    case invalidManifest
    case partialStageCleanupFailed
    case photoLimitReached
    case photoNotStaged
}

actor LocalCaptureDraftStore: CaptureDraftStoring {
    static let recoveryWindow: TimeInterval = 24 * 60 * 60
    static let fileProtection = FileProtectionType.complete
    static let writingOptions: Data.WritingOptions = [.atomic, .completeFileProtection]

    private let fileManager: FileManager
    private let rootDirectory: URL
    private let manifestURL: URL
    private let orderedManifestURL: URL
    private let writeData: @Sendable (Data, URL, Data.WritingOptions) throws -> Void
    private let discardRoot: @Sendable (URL) throws -> Void
    private let now: @Sendable () -> Date
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(
        rootDirectory: URL? = nil,
        fileManager: FileManager = .default,
        writeData: @escaping @Sendable (Data, URL, Data.WritingOptions) throws -> Void = {
            data, url, options in
            try data.write(to: url, options: options)
        },
        discardRoot: (@Sendable (URL) throws -> Void)? = nil,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        let defaultRoot = fileManager.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first!
            .appendingPathComponent("SnapList", isDirectory: true)
            .appendingPathComponent("CaptureDraft", isDirectory: true)
        self.fileManager = fileManager
        self.rootDirectory = rootDirectory ?? defaultRoot
        manifestURL = self.rootDirectory.appendingPathComponent("manifest.json")
        orderedManifestURL = self.rootDirectory.appendingPathComponent("ordered-manifest.json")
        self.writeData = writeData
        self.discardRoot = discardRoot ?? { url in
            try fileManager.removeItem(at: url)
        }
        self.now = now
    }

    func load() async throws -> StagedCapturePhoto? {
        try await loadPhotos().first
    }

    func loadPhotos() async throws -> [StagedCapturePhoto] {
        guard fileManager.fileExists(atPath: rootDirectory.path) else {
            return []
        }
        let storedPhotos: [StagedCapturePhoto]
        if fileManager.fileExists(atPath: orderedManifestURL.path) {
            storedPhotos = try decoder.decode(
                [StagedCapturePhoto].self,
                from: Data(contentsOf: orderedManifestURL)
            )
        } else if fileManager.fileExists(atPath: manifestURL.path) {
            storedPhotos = [try decoder.decode(
                StagedCapturePhoto.self,
                from: Data(contentsOf: manifestURL)
            )]
        } else {
            try removeSupersededImages(keeping: [])
            return []
        }

        let restored = try storedPhotos.map { staged in
            let currentPhotoURL = try ownedArtifactURL(
                storedURL: staged.photoURL,
                expectedPrefix: "photo",
                draftID: staged.id
            )
            let currentThumbnailURL = try ownedArtifactURL(
                storedURL: staged.thumbnailURL,
                expectedPrefix: "thumbnail",
                draftID: staged.id
            )
            return StagedCapturePhoto(
                id: staged.id,
                photoURL: currentPhotoURL,
                thumbnailURL: currentThumbnailURL,
                createdAt: staged.createdAt,
                libraryTransferReceipt: staged.libraryTransferReceipt
            )
        }
        let currentURLs = Set(restored.flatMap { [$0.photoURL, $0.thumbnailURL] })
        try removeSupersededImages(keeping: currentURLs)
        guard restored.allSatisfy({
            now().timeIntervalSince($0.createdAt) < Self.recoveryWindow
        }) else {
            purgeOwnedDraft(photos: restored)
            return []
        }
        guard restored.allSatisfy({
            fileManager.fileExists(atPath: $0.photoURL.path)
                && fileManager.fileExists(atPath: $0.thumbnailURL.path)
        }) else {
            purgeOwnedDraft(photos: restored)
            return []
        }
        return restored
    }

    func stage(
        imageData: Data,
        libraryTransferReceipt: LibraryPhotoTransferReceipt?
    ) async throws -> StagedCapturePhoto {
        let staged = try persist(
            imageData: imageData,
            libraryTransferReceipt: libraryTransferReceipt,
            existingPhotos: [],
            manifestURL: manifestURL,
            encodeManifest: { try self.encoder.encode($0[0]) }
        )
        try? fileManager.removeItem(at: orderedManifestURL)
        return staged
    }

    func append(
        imageData: Data,
        libraryTransferReceipt: LibraryPhotoTransferReceipt?
    ) async throws -> CaptureDraftAppendResult {
        let existingPhotos = try await loadPhotos()
        guard existingPhotos.count < 5 else {
            throw CaptureDraftStoreError.photoLimitReached
        }
        let staged = try persist(
            imageData: imageData,
            libraryTransferReceipt: libraryTransferReceipt,
            existingPhotos: existingPhotos,
            manifestURL: orderedManifestURL,
            encodeManifest: { try self.encoder.encode($0) }
        )
        try? fileManager.removeItem(at: manifestURL)
        return CaptureDraftAppendResult(
            appendedPhoto: staged,
            photos: existingPhotos + [staged]
        )
    }

    func replace(
        photoID: StagedCapturePhoto.ID,
        imageData: Data,
        libraryTransferReceipt: LibraryPhotoTransferReceipt?
    ) async throws -> CaptureDraftReplaceResult {
        let existingPhotos = try await loadPhotos()
        guard let replacedIndex = existingPhotos.firstIndex(where: { $0.id == photoID }) else {
            throw CaptureDraftStoreError.photoNotStaged
        }
        // The replaced photo's artifacts survive until the new manifest commits, so a
        // failure anywhere above leaves the seller exactly the photos they already had.
        let staged = try persist(
            imageData: imageData,
            libraryTransferReceipt: libraryTransferReceipt,
            existingPhotos: existingPhotos,
            replacedIndex: replacedIndex,
            manifestURL: orderedManifestURL,
            encodeManifest: { try self.encoder.encode($0) }
        )
        try? fileManager.removeItem(at: manifestURL)
        var photos = existingPhotos
        photos[replacedIndex] = staged
        return CaptureDraftReplaceResult(replacementPhoto: staged, photos: photos)
    }

    func replacePhotos(with photos: [StagedCapturePhoto]) async throws {
        let existingPhotos = try await loadPhotos()
        let existingIDs = Set(existingPhotos.map(\.id))
        guard existingIDs.count == existingPhotos.count else {
            throw CaptureDraftStoreError.invalidManifest
        }
        let existingByID = Dictionary(
            uniqueKeysWithValues: existingPhotos.map { ($0.id, $0) }
        )
        let replacementIDs = Set(photos.map(\.id))
        guard photos.count <= 5,
              replacementIDs.count == photos.count,
              photos.allSatisfy({ existingByID[$0.id] == $0 }) else {
            throw CaptureDraftStoreError.invalidManifest
        }

        try writeData(
            try encoder.encode(photos),
            orderedManifestURL,
            Self.writingOptions
        )
        try? fileManager.removeItem(at: manifestURL)
        let retainedURLs = Set(
            photos.flatMap { [$0.photoURL, $0.thumbnailURL] }
        )
        try? removeSupersededImages(keeping: retainedURLs)
    }

    private func persist(
        imageData: Data,
        libraryTransferReceipt: LibraryPhotoTransferReceipt?,
        existingPhotos: [StagedCapturePhoto],
        replacedIndex: Int? = nil,
        manifestURL: URL,
        encodeManifest: ([StagedCapturePhoto]) throws -> Data
    ) throws -> StagedCapturePhoto {
        if let libraryTransferReceipt,
           !libraryTransferReceipt.matchesTransferredPhoto(imageData) {
            throw CaptureDraftStoreError.transferReceiptMismatch
        }
        guard let source = CGImageSourceCreateWithData(imageData as CFData, nil),
              CGImageSourceGetCount(source) > 0 else {
            throw CaptureDraftStoreError.invalidImage
        }

        let fullImage = try makeThumbnail(from: source, maximumPixelSize: 4096)
        let thumbnail = try makeThumbnail(from: source, maximumPixelSize: 240)
        let fullData = try encodeJPEG(fullImage, quality: 0.92)
        let thumbnailData = try encodeJPEG(thumbnail, quality: 0.84)

        try fileManager.createDirectory(
            at: rootDirectory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: Self.fileProtection]
        )
        var resourceValues = URLResourceValues()
        resourceValues.isExcludedFromBackup = true
        var protectedRootDirectory = rootDirectory
        try protectedRootDirectory.setResourceValues(resourceValues)

        let id = UUID()
        let nextPhotoURL = rootDirectory.appendingPathComponent("photo-\(id.uuidString).jpg")
        let nextThumbnailURL = rootDirectory.appendingPathComponent(
            "thumbnail-\(id.uuidString).jpg"
        )
        do {
            try writeData(fullData, nextPhotoURL, Self.writingOptions)
            try writeData(thumbnailData, nextThumbnailURL, Self.writingOptions)

            let staged = StagedCapturePhoto(
                id: id,
                photoURL: nextPhotoURL,
                thumbnailURL: nextThumbnailURL,
                createdAt: now(),
                libraryTransferReceipt: libraryTransferReceipt
            )
            var photos = existingPhotos
            if let replacedIndex {
                photos[replacedIndex] = staged
            } else {
                photos.append(staged)
            }
            try writeData(try encodeManifest(photos), manifestURL, Self.writingOptions)
            let currentURLs = Set(photos.flatMap { [$0.photoURL, $0.thumbnailURL] })
            try? removeSupersededImages(keeping: currentURLs)
            return staged
        } catch {
            let stagingError = error
            do {
                try removePartialStageArtifacts(
                    [nextPhotoURL, nextThumbnailURL]
                )
            } catch {
                throw CaptureDraftStoreError.partialStageCleanupFailed
            }
            throw stagingError
        }
    }

    func discard() async throws {
        guard fileManager.fileExists(atPath: rootDirectory.path) else { return }
        try discardRoot(rootDirectory)
    }

    /// Compares and deletes inside one actor entry, the way every other mutation here
    /// reads before it writes. Going through the protocol default would leave the actor
    /// between the comparison and the deletion, and a photo staged in that window would
    /// be deleted despite never having been submitted.
    func discardExactly(_ photos: [StagedCapturePhoto]) async throws -> Bool {
        guard try await loadPhotos() == photos else { return false }
        try await discard()
        return true
    }

    private func purgeOwnedDraft(photos: [StagedCapturePhoto]) {
        // Callers validate both reconstructed artifact URLs before any deletion begins.
        let artifactURLs = photos.flatMap { [$0.photoURL, $0.thumbnailURL] }
        for url in Set(artifactURLs + [manifestURL, orderedManifestURL]) {
            try? fileManager.removeItem(at: url)
        }
    }

    private func ownedArtifactURL(
        storedURL: URL,
        expectedPrefix: String,
        draftID: UUID
    ) throws -> URL {
        let expectedName = "\(expectedPrefix)-\(draftID.uuidString).jpg"
        let storedComponents = storedURL.pathComponents.dropFirst(
            storedURL.pathComponents.first == "/" ? 1 : 0
        )
        guard storedURL.isFileURL,
              !storedComponents.isEmpty,
              storedComponents.allSatisfy({ component in
                  !component.isEmpty
                      && component != "."
                      && component != ".."
                      && !component.contains("/")
                      && !component.contains("\\")
              }),
              storedURL.lastPathComponent == expectedName else {
            throw CaptureDraftStoreError.invalidManifest
        }

        let standardizedRoot = rootDirectory.standardizedFileURL
        let reconstructedURL = standardizedRoot
            .appendingPathComponent(expectedName, isDirectory: false)
            .standardizedFileURL
        guard reconstructedURL.deletingLastPathComponent().standardizedFileURL == standardizedRoot else {
            throw CaptureDraftStoreError.invalidManifest
        }
        return reconstructedURL
    }

    private func removeSupersededImages(keeping currentURLs: Set<URL>) throws {
        let contents = try fileManager.contentsOfDirectory(
            at: rootDirectory,
            includingPropertiesForKeys: nil
        )
        let standardizedCurrentURLs = Set(currentURLs.map(\.standardizedFileURL))
        for url in contents where isOwnedArtifact(url)
            && !standardizedCurrentURLs.contains(url.standardizedFileURL) {
            try fileManager.removeItem(at: url)
        }
    }

    private func removePartialStageArtifacts(_ urls: Set<URL>) throws {
        var firstCleanupError: Error?
        for url in urls where fileManager.fileExists(atPath: url.path) {
            do {
                try fileManager.removeItem(at: url)
            } catch {
                if firstCleanupError == nil {
                    firstCleanupError = error
                }
            }
        }
        if let firstCleanupError {
            throw firstCleanupError
        }
    }

    private func isOwnedArtifact(_ url: URL) -> Bool {
        let standardizedURL = url.standardizedFileURL
        guard standardizedURL.deletingLastPathComponent() == rootDirectory.standardizedFileURL,
              standardizedURL.pathExtension == "jpg" else {
            return false
        }
        let basename = standardizedURL.deletingPathExtension().lastPathComponent
        for prefix in ["photo-", "thumbnail-"] where basename.hasPrefix(prefix) {
            return UUID(uuidString: String(basename.dropFirst(prefix.count))) != nil
        }
        return false
    }

    private func makeThumbnail(
        from source: CGImageSource,
        maximumPixelSize: Int
    ) throws -> CGImage {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maximumPixelSize
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            throw CaptureDraftStoreError.invalidImage
        }
        return image
    }

    private func encodeJPEG(_ image: CGImage, quality: CGFloat) throws -> Data {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            data,
            UTType.jpeg.identifier as CFString,
            1,
            nil
        ) else {
            throw CaptureDraftStoreError.couldNotEncodeImage
        }
        CGImageDestinationAddImage(
            destination,
            image,
            [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary
        )
        guard CGImageDestinationFinalize(destination) else {
            throw CaptureDraftStoreError.couldNotEncodeImage
        }
        return data as Data
    }
}

@MainActor
@Observable
final class CaptureFlowModel {
    private let camera: any CaptureCamera
    private let evaluator: any FramingEvaluating
    private let store: any CaptureDraftStoring
    private let policy: FramingEvaluationPolicy
    private var stabilizer: FramingGuidanceStabilizer
    private var evaluationInFlight = false
    private var activeCaptureID: UUID?
    private var activeIntakeID: UUID?
    private var resumeAfterBackground = false
    private var pendingPhotoLimitAnnouncement: String?

    private(set) var phase: CapturePhase = .idle
    private(set) var guidance: FramingGuidance = .coaching
    private(set) var stagedPhotos: [StagedCapturePhoto] = []
    private(set) var flashMode: CaptureFlashMode = .off
    private(set) var hasCompletedRestoration = false

    init(
        camera: any CaptureCamera,
        evaluator: any FramingEvaluating,
        store: any CaptureDraftStoring,
        policy: FramingEvaluationPolicy = FramingEvaluationPolicy(),
        stabilizer: FramingGuidanceStabilizer = FramingGuidanceStabilizer()
    ) {
        self.camera = camera
        self.evaluator = evaluator
        self.store = store
        self.policy = policy
        self.stabilizer = stabilizer
    }

    /// The durable draft Photo Review's intake writes through, so both surfaces stage
    /// into one manifest instead of keeping two that can disagree.
    var draftStore: any CaptureDraftStoring { store }
    var previewSession: AVCaptureSession { camera.session }
    var captureDevice: AVCaptureDevice? { camera.captureDevice }
    var isFlashAvailable: Bool { camera.isFlashAvailable }
    var stagedPhoto: StagedCapturePhoto? { stagedPhotos.first }
    var isCapturingPhoto: Bool { activeCaptureID != nil }
    var isAddingPhotos: Bool { activeIntakeID != nil }
    var canOpenBoundary: Bool { !isAddingPhotos && (0...5).contains(stagedPhotos.count) }
    var canTakePhoto: Bool {
        phase == .camera
            && stagedPhotos.count < 5
            && !isAddingPhotos
    }
    var handoffTitle: String { "Photos ready to review" }

    func toggleFlash() {
        guard isFlashAvailable else { return }
        flashMode = flashMode == .off ? .on : .off
        camera.setFlashMode(flashMode)
    }

    func restore() async -> CaptureRestoration {
        defer { hasCompletedRestoration = true }
        do {
            stagedPhotos = try await store.loadPhotos()
            if !stagedPhotos.isEmpty {
                phase = .captured
                return .stagedPhoto
            }
            return .noDraft
        } catch {
            phase = .failed
            return .failed
        }
    }

    func applyPhotoReviewScanReturn(
        _ request: PhotoReviewScanReturn
    ) async -> PhotoReviewScanFocus? {
        do {
            try await store.replacePhotos(with: request.photos)
            stagedPhotos = request.photos
            phase = request.photos.isEmpty ? .idle : .captured
            return request.focus
        } catch {
            return nil
        }
    }

    func startCamera() async {
        guard camera.isAvailable else {
            phase = .unavailable
            return
        }

        phase = .requestingPermission
        var authorization = camera.authorizationStatus()
        if authorization == .notDetermined {
            authorization = await camera.requestAuthorization()
        }

        switch authorization {
        case .authorized:
            break
        case .denied:
            phase = .denied
            return
        case .restricted:
            phase = .unavailable
            return
        case .notDetermined:
            phase = .unavailable
            return
        }

        do {
            stabilizer.reset()
            guidance = .coaching
            try await camera.start { [weak self] frame in
                Task { @MainActor [weak self] in
                    await self?.process(frame: frame)
                }
            }
            phase = .camera
            resumeAfterBackground = true
        } catch {
            phase = .unavailable
        }
    }

    func process(frame: CaptureFrame) async {
        guard phase == .camera, !evaluationInFlight else { return }
        evaluationInFlight = true
        defer { evaluationInFlight = false }

        do {
            let observation = try await evaluator.evaluate(frame: frame)
            guidance = stabilizer.consume(policy.guidance(for: observation))
        } catch {
            // A dropped or unreadable frame is transient; preserve the last honest cue.
        }
    }

    func reservePhotoCapture() -> UUID? {
        guard canTakePhoto else { return nil }
        let captureID = UUID()
        activeCaptureID = captureID
        activeIntakeID = captureID
        return captureID
    }

    func takePhoto() async {
        guard let captureID = reservePhotoCapture() else { return }
        await takePhoto(reservation: captureID)
    }

    func takePhoto(reservation captureID: UUID) async {
        guard activeCaptureID == captureID, activeIntakeID == captureID else { return }
        defer {
            if activeCaptureID == captureID {
                activeCaptureID = nil
            }
            if activeIntakeID == captureID {
                activeIntakeID = nil
            }
        }
        do {
            let imageData = try await camera.capturePhoto()
            guard activeIntakeID == captureID else { return }
            let result = try await store.append(
                imageData: imageData,
                libraryTransferReceipt: nil
            )
            guard activeIntakeID == captureID else { return }
            stagedPhotos = result.photos
            queuePhotoLimitAnnouncementIfNeeded()
        } catch {
            guard activeIntakeID == captureID else { return }
            // Capture and persistence failures are retryable on the still-live camera.
        }
    }

    @discardableResult
    func stageLibraryPhoto(
        _ imageData: Data,
        transferReceipt: LibraryPhotoTransferReceipt? = nil
    ) async -> Bool {
        guard !isAddingPhotos, stagedPhotos.count < 5 else { return false }
        if let transferReceipt,
           !transferReceipt.matchesTransferredPhoto(imageData) {
            phase = .failed
            return false
        }
        let intakeID = UUID()
        activeIntakeID = intakeID
        defer {
            if activeIntakeID == intakeID {
                activeIntakeID = nil
            }
        }
        let phaseBeforeSelection = phase
        return await persistLibraryPhoto(
            imageData,
            transferReceipt: transferReceipt,
            phaseBeforeSelection: phaseBeforeSelection,
            intakeID: intakeID
        )
    }

    @discardableResult
    func stageLibraryPhotos(_ imageData: [Data]) async -> Int {
        guard let intakeID = reserveLibraryIntake() else { return 0 }
        return await stageLibraryPhotos(imageData, reservation: intakeID)
    }

    @discardableResult
    func stageLibraryPhotos<Photo: CaptureLibraryPhotoLoading>(
        _ photos: [Photo]
    ) async -> Int {
        guard let intakeID = reserveLibraryIntake() else { return 0 }
        return await stageLibraryPhotos(photos, reservation: intakeID)
    }

    func reserveLibraryIntake() -> UUID? {
        guard !isAddingPhotos else { return nil }
        let intakeID = UUID()
        activeIntakeID = intakeID
        return intakeID
    }

    func stageLibraryPhotos(_ imageData: [Data], reservation intakeID: UUID) async -> Int {
        guard activeIntakeID == intakeID, activeCaptureID == nil else { return 0 }
        defer {
            if activeIntakeID == intakeID {
                activeIntakeID = nil
            }
        }
        let phaseBeforeSelection = phase
        let remainingCapacity = max(0, 5 - stagedPhotos.count)
        var addedCount = 0
        for photoData in imageData.prefix(remainingCapacity) {
            guard await persistLibraryPhoto(
                photoData,
                transferReceipt: nil,
                phaseBeforeSelection: phaseBeforeSelection,
                intakeID: intakeID
            ) else { break }
            addedCount += 1
        }
        return addedCount
    }

    func stageLibraryPhotos<Photo: CaptureLibraryPhotoLoading>(
        _ photos: [Photo],
        reservation intakeID: UUID
    ) async -> Int {
        guard activeIntakeID == intakeID, activeCaptureID == nil else { return 0 }
        defer {
            if activeIntakeID == intakeID {
                activeIntakeID = nil
            }
        }
        let phaseBeforeSelection = phase
        let remainingCapacity = max(0, 5 - stagedPhotos.count)
        var addedCount = 0
        for photo in photos.prefix(remainingCapacity) {
            var imageData: Data?
            do {
                imageData = try await photo.loadPhotoData()
            } catch {
                break
            }
            guard imageData != nil else { break }
            let didPersist = await persistLibraryPhoto(
                imageData!,
                transferReceipt: nil,
                phaseBeforeSelection: phaseBeforeSelection,
                intakeID: intakeID
            )
            imageData = nil
            guard didPersist else { break }
            addedCount += 1
        }
        return addedCount
    }

    func cancelLibraryIntake(reservation intakeID: UUID) {
        guard activeIntakeID == intakeID, activeCaptureID == nil else { return }
        activeIntakeID = nil
    }

    func consumePhotoLimitAnnouncement() -> String? {
        defer { pendingPhotoLimitAnnouncement = nil }
        return pendingPhotoLimitAnnouncement
    }

    func rollBackLibraryTransferAfterSourceConsumptionFailure() async -> Bool {
        do {
            try await store.discard()
            stagedPhotos = []
            camera.stop()
            resumeAfterBackground = false
            phase = .failed
            return true
        } catch {
            // The staged draft remains the durable recovery authority until discard succeeds.
            return false
        }
    }

    func continueToReviewHandoff() {
        guard !stagedPhotos.isEmpty else { return }
        phase = .reviewHandoff
    }

    func reopenCameraFromReviewHandoff() async {
        guard phase == .reviewHandoff, !stagedPhotos.isEmpty else { return }
        await startCamera()
    }

    func cancelCamera() {
        activeIntakeID = nil
        activeCaptureID = nil
        camera.stop()
        resumeAfterBackground = false
        phase = stagedPhotos.isEmpty ? .idle : .captured
    }

    func handleScenePhase(_ scenePhase: ScenePhase) {
        guard scenePhase == .background, phase == .camera else { return }
        resumeAfterBackground = true
        camera.stop()
    }

    func handleSceneBecameActive() async {
        if phase == .denied {
            guard camera.authorizationStatus() == .authorized else { return }
            await startCamera()
            return
        }
        guard resumeAfterBackground, phase == .camera else { return }
        await startCamera()
    }

    private func queuePhotoLimitAnnouncementIfNeeded() {
        guard stagedPhotos.count == 5,
              pendingPhotoLimitAnnouncement == nil else { return }
        pendingPhotoLimitAnnouncement = "Five photo limit reached. Review your photos."
    }

    private func persistLibraryPhoto(
        _ imageData: Data,
        transferReceipt: LibraryPhotoTransferReceipt?,
        phaseBeforeSelection: CapturePhase,
        intakeID: UUID
    ) async -> Bool {
        guard activeIntakeID == intakeID, stagedPhotos.count < 5 else { return false }
        do {
            let result = try await store.append(
                imageData: imageData,
                libraryTransferReceipt: transferReceipt
            )
            guard activeIntakeID == intakeID else { return false }
            stagedPhotos = result.photos
            queuePhotoLimitAnnouncementIfNeeded()
            if ![.camera, .denied, .unavailable].contains(phaseBeforeSelection) {
                camera.stop()
                resumeAfterBackground = false
                phase = .captured
            }
            return true
        } catch {
            if ![.camera, .denied, .unavailable].contains(phaseBeforeSelection) {
                phase = .failed
            }
            // Live and recovery surfaces keep their prior truthful state for retry.
            return false
        }
    }
}
