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

protocol CaptureCamera: AnyObject {
    var session: AVCaptureSession { get }
    var captureDevice: AVCaptureDevice? { get }
    var isAvailable: Bool { get }

    func authorizationStatus() -> CaptureCameraAuthorization
    func requestAuthorization() async -> CaptureCameraAuthorization
    func start(frameHandler: @escaping (CaptureFrame) -> Void) async throws
    func stop()
    func capturePhoto() async throws -> Data
}

extension CaptureCamera {
    var captureDevice: AVCaptureDevice? { nil }
}

protocol FramingEvaluating {
    func evaluate(frame: CaptureFrame) async throws -> FramingObservation
}

protocol CaptureDraftStoring {
    func load() async throws -> StagedCapturePhoto?
    func stage(
        imageData: Data,
        libraryTransferReceipt: LibraryPhotoTransferReceipt?
    ) async throws -> StagedCapturePhoto
    func discard() async throws
}

extension CaptureDraftStoring {
    func stage(imageData: Data) async throws -> StagedCapturePhoto {
        try await stage(imageData: imageData, libraryTransferReceipt: nil)
    }
}

enum CaptureDraftStoreError: Error {
    case invalidImage
    case couldNotEncodeImage
    case transferReceiptMismatch
}

actor LocalCaptureDraftStore: CaptureDraftStoring {
    static let recoveryWindow: TimeInterval = 24 * 60 * 60
    static let fileProtection = FileProtectionType.complete
    static let writingOptions: Data.WritingOptions = [.atomic, .completeFileProtection]

    private let fileManager: FileManager
    private let rootDirectory: URL
    private let manifestURL: URL
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
        self.writeData = writeData
        self.discardRoot = discardRoot ?? { url in
            try fileManager.removeItem(at: url)
        }
        self.now = now
    }

    func load() async throws -> StagedCapturePhoto? {
        guard fileManager.fileExists(atPath: manifestURL.path) else {
            return nil
        }
        let staged = try decoder.decode(
            StagedCapturePhoto.self,
            from: Data(contentsOf: manifestURL)
        )
        let currentPhotoURL = rootDirectory.appendingPathComponent(staged.photoURL.lastPathComponent)
        let currentThumbnailURL = rootDirectory.appendingPathComponent(
            staged.thumbnailURL.lastPathComponent
        )
        guard now().timeIntervalSince(staged.createdAt) < Self.recoveryWindow else {
            purgeOwnedDraft(
                photoURL: currentPhotoURL,
                thumbnailURL: currentThumbnailURL
            )
            return nil
        }
        guard fileManager.fileExists(atPath: currentPhotoURL.path),
              fileManager.fileExists(atPath: currentThumbnailURL.path) else {
            purgeOwnedDraft(
                photoURL: currentPhotoURL,
                thumbnailURL: currentThumbnailURL
            )
            return nil
        }
        return StagedCapturePhoto(
            id: staged.id,
            photoURL: currentPhotoURL,
            thumbnailURL: currentThumbnailURL,
            createdAt: staged.createdAt,
            libraryTransferReceipt: staged.libraryTransferReceipt
        )
    }

    func stage(
        imageData: Data,
        libraryTransferReceipt: LibraryPhotoTransferReceipt?
    ) async throws -> StagedCapturePhoto {
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
        try writeData(fullData, nextPhotoURL, Self.writingOptions)
        try writeData(thumbnailData, nextThumbnailURL, Self.writingOptions)

        let staged = StagedCapturePhoto(
            id: id,
            photoURL: nextPhotoURL,
            thumbnailURL: nextThumbnailURL,
            createdAt: now(),
            libraryTransferReceipt: libraryTransferReceipt
        )
        try writeData(encoder.encode(staged), manifestURL, Self.writingOptions)
        try? removeSupersededImages(keeping: [nextPhotoURL, nextThumbnailURL])
        return staged
    }

    func discard() async throws {
        guard fileManager.fileExists(atPath: rootDirectory.path) else { return }
        try discardRoot(rootDirectory)
    }

    private func purgeOwnedDraft(photoURL: URL, thumbnailURL: URL) {
        // Reconstructed URLs remain inside the store-owned root even if a manifest is corrupt.
        for url in Set([photoURL, thumbnailURL, manifestURL]) {
            try? fileManager.removeItem(at: url)
        }
    }

    private func removeSupersededImages(keeping currentURLs: Set<URL>) throws {
        let contents = try fileManager.contentsOfDirectory(
            at: rootDirectory,
            includingPropertiesForKeys: nil
        )
        for url in contents where url.pathExtension == "jpg" && !currentURLs.contains(url) {
            try fileManager.removeItem(at: url)
        }
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
    private var resumeAfterBackground = false

    private(set) var phase: CapturePhase = .idle
    private(set) var guidance: FramingGuidance = .coaching
    private(set) var stagedPhoto: StagedCapturePhoto?
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

    var previewSession: AVCaptureSession { camera.session }
    var captureDevice: AVCaptureDevice? { camera.captureDevice }
    var isCapturingPhoto: Bool { activeCaptureID != nil }
    var canTakePhoto: Bool {
        phase == .camera && guidance == .accepted && !isCapturingPhoto
    }
    var handoffTitle: String { "Photos ready to review" }

    func restore() async -> CaptureRestoration {
        defer { hasCompletedRestoration = true }
        do {
            stagedPhoto = try await store.load()
            if stagedPhoto != nil {
                phase = .captured
                return .stagedPhoto
            }
            return .noDraft
        } catch {
            phase = .failed
            return .failed
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

        guard authorization == .authorized else {
            phase = .denied
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

    func takePhoto() async {
        guard canTakePhoto else { return }
        let captureID = UUID()
        activeCaptureID = captureID
        defer {
            if activeCaptureID == captureID {
                activeCaptureID = nil
            }
        }
        do {
            let imageData = try await camera.capturePhoto()
            guard activeCaptureID == captureID else { return }
            let photo = try await store.stage(imageData: imageData)
            guard activeCaptureID == captureID else { return }
            stagedPhoto = photo
            camera.stop()
            resumeAfterBackground = false
            phase = .captured
        } catch {
            guard activeCaptureID == captureID else { return }
            phase = .failed
        }
    }

    @discardableResult
    func stageLibraryPhoto(
        _ imageData: Data,
        transferReceipt: LibraryPhotoTransferReceipt? = nil
    ) async -> Bool {
        if let transferReceipt,
           !transferReceipt.matchesTransferredPhoto(imageData) {
            phase = .failed
            return false
        }
        do {
            stagedPhoto = try await store.stage(
                imageData: imageData,
                libraryTransferReceipt: transferReceipt
            )
            camera.stop()
            resumeAfterBackground = false
            phase = .captured
            return true
        } catch {
            phase = .failed
            return false
        }
    }

    func rollBackLibraryTransferAfterSourceConsumptionFailure() async -> Bool {
        do {
            try await store.discard()
            stagedPhoto = nil
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
        guard stagedPhoto != nil else { return }
        phase = .reviewHandoff
    }

    func cancelCamera() {
        activeCaptureID = nil
        camera.stop()
        resumeAfterBackground = false
        phase = stagedPhoto == nil ? .idle : .captured
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
}
