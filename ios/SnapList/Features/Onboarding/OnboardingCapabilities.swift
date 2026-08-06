import AVFoundation
import Foundation

enum CameraAuthorizationStatus: String, Codable, Equatable {
    case notDetermined
    case authorized
    case denied
    case restricted
}

protocol CameraAuthorizationProviding: AnyObject {
    func authorizationStatus() -> CameraAuthorizationStatus
    func requestAccess() async -> Bool
}

final class AVCameraAuthorizationClient: CameraAuthorizationProviding {
    func authorizationStatus() -> CameraAuthorizationStatus {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .notDetermined:
            .notDetermined
        case .authorized:
            .authorized
        case .denied:
            .denied
        case .restricted:
            .restricted
        @unknown default:
            .restricted
        }
    }

    func requestAccess() async -> Bool {
        await AVCaptureDevice.requestAccess(for: .video)
    }
}

final class FixtureCameraAuthorizationClient: CameraAuthorizationProviding {
    var status: CameraAuthorizationStatus
    var requestResult: Bool

    init(status: CameraAuthorizationStatus, requestResult: Bool? = nil) {
        self.status = status
        self.requestResult = requestResult ?? (status == .authorized)
    }

    func authorizationStatus() -> CameraAuthorizationStatus {
        status
    }

    func requestAccess() async -> Bool {
        status = requestResult ? .authorized : .denied
        return requestResult
    }
}

protocol StagedLibraryPhotoPersisting: AnyObject {
    @discardableResult
    func replace(with photos: [Data]) throws -> Int
    func load() throws -> [Data]
    @discardableResult
    func consume(
        transferReceipt: LibraryPhotoTransferReceipt
    ) throws -> StagedLibraryPhotoConsumeOutcome
    func clear()
}

enum StagedLibraryPhotoStoreError: Error {
    case transferReceiptMismatch
}

enum StagedLibraryPhotoConsumeOutcome: Equatable {
    case consumed(remainingCount: Int)
    case cleanupNeeded
    case retryNeeded
}

final class FileSystemStagedLibraryPhotoStore: StagedLibraryPhotoPersisting {
    static let fileProtection = FileProtectionType.complete
    static let writingOptions: Data.WritingOptions = [.atomic, .completeFileProtection]
    private static let pendingPrefix = ".OnboardingStagedPhotos-"
    private static let cleanupNeededFilename = ".cleanup-needed.json"

    private let fileManager: FileManager
    private let directoryURL: URL
    private let consumeMoveItem: (URL, URL) throws -> Void
    private let consumeReplaceItem: (URL, URL) throws -> Void

    init(
        fileManager: FileManager = .default,
        directoryURL: URL? = nil,
        consumeMoveItem: ((URL, URL) throws -> Void)? = nil,
        consumeReplaceItem: ((URL, URL) throws -> Void)? = nil
    ) {
        self.fileManager = fileManager
        self.directoryURL = directoryURL
            ?? fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("SnapList/OnboardingStagedPhotos", isDirectory: true)
        self.consumeMoveItem = consumeMoveItem ?? { sourceURL, destinationURL in
            try fileManager.moveItem(at: sourceURL, to: destinationURL)
        }
        self.consumeReplaceItem = consumeReplaceItem ?? { originalURL, replacementURL in
            _ = try fileManager.replaceItemAt(originalURL, withItemAt: replacementURL)
        }
    }

    @discardableResult
    func replace(with photos: [Data]) throws -> Int {
        removePendingDirectories()
        let photos = Array(photos.prefix(4))
        guard !photos.isEmpty else {
            clear()
            return 0
        }

        let parentURL = directoryURL.deletingLastPathComponent()
        let pendingURL = parentURL.appendingPathComponent(
            "\(Self.pendingPrefix)\(UUID().uuidString)",
            isDirectory: true
        )

        try fileManager.createDirectory(
            at: pendingURL,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: Self.fileProtection]
        )

        do {
            var resourceValues = URLResourceValues()
            resourceValues.isExcludedFromBackup = true
            var protectedPendingURL = pendingURL
            try protectedPendingURL.setResourceValues(resourceValues)

            for (index, photo) in photos.enumerated() {
                let photoURL = pendingURL.appendingPathComponent(
                    String(format: "%02d.photo", index),
                    isDirectory: false
                )
                try photo.write(to: photoURL, options: Self.writingOptions)
            }

            if fileManager.fileExists(atPath: directoryURL.path) {
                try consumeReplaceItem(directoryURL, pendingURL)
            } else {
                try fileManager.moveItem(at: pendingURL, to: directoryURL)
            }
            return photos.count
        } catch {
            try? fileManager.removeItem(at: pendingURL)
            throw error
        }
    }

    func load() throws -> [Data] {
        removePendingDirectories()
        guard fileManager.fileExists(atPath: directoryURL.path) else { return [] }
        try reconcilePendingCleanupIfNeeded()
        guard fileManager.fileExists(atPath: directoryURL.path) else { return [] }
        return try loadRawPhotos()
    }

    private func loadRawPhotos() throws -> [Data] {
        try fileManager.contentsOfDirectory(
            at: directoryURL,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )
        .filter { $0.pathExtension == "photo" }
        .sorted { $0.lastPathComponent < $1.lastPathComponent }
        .prefix(4)
        .map { try Data(contentsOf: $0) }
    }

    @discardableResult
    func consume(
        transferReceipt: LibraryPhotoTransferReceipt
    ) throws -> StagedLibraryPhotoConsumeOutcome {
        guard transferReceipt.sourcePhotoFingerprints.indices.contains(
            transferReceipt.sourceIndex
        ), transferReceipt.sourcePhotoFingerprints[transferReceipt.sourceIndex]
            == transferReceipt.transferredDigest
        else {
            throw StagedLibraryPhotoStoreError.transferReceiptMismatch
        }
        let photos = try load()
        let fingerprints = photos.map(LocalPhotoFingerprint.digest)
        if fingerprints == transferReceipt.remainingPhotoFingerprints {
            return .consumed(remainingCount: photos.count)
        }
        if !fingerprints.contains(transferReceipt.transferredDigest) {
            return .consumed(remainingCount: photos.count)
        }
        guard fingerprints == transferReceipt.sourcePhotoFingerprints else {
            try persistCleanupNeeded(transferReceipt)
            return .cleanupNeeded
        }

        var remainingPhotos = photos
        remainingPhotos.remove(at: transferReceipt.sourceIndex)
        guard !remainingPhotos.isEmpty else {
            try consumeAll()
            return .consumed(remainingCount: 0)
        }
        return .consumed(remainingCount: try replace(with: remainingPhotos))
    }

    private var cleanupNeededURL: URL {
        directoryURL.appendingPathComponent(Self.cleanupNeededFilename)
    }

    private func persistCleanupNeeded(_ receipt: LibraryPhotoTransferReceipt) throws {
        guard fileManager.fileExists(atPath: directoryURL.path) else {
            throw StagedLibraryPhotoStoreError.transferReceiptMismatch
        }
        try JSONEncoder().encode(receipt).write(
            to: cleanupNeededURL,
            options: Self.writingOptions
        )
    }

    private func reconcilePendingCleanupIfNeeded() throws {
        guard fileManager.fileExists(atPath: cleanupNeededURL.path) else { return }
        let receipt = try JSONDecoder().decode(
            LibraryPhotoTransferReceipt.self,
            from: Data(contentsOf: cleanupNeededURL)
        )
        guard receipt.sourcePhotoFingerprints.indices.contains(receipt.sourceIndex),
              receipt.sourcePhotoFingerprints[receipt.sourceIndex]
                == receipt.transferredDigest else {
            throw StagedLibraryPhotoStoreError.transferReceiptMismatch
        }

        var photos = try loadRawPhotos()
        let fingerprints = photos.map(LocalPhotoFingerprint.digest)
        if fingerprints == receipt.remainingPhotoFingerprints {
            try fileManager.removeItem(at: cleanupNeededURL)
            return
        }
        if !fingerprints.contains(receipt.transferredDigest) {
            try fileManager.removeItem(at: cleanupNeededURL)
            return
        }
        guard photos.indices.contains(receipt.sourceIndex),
              fingerprints[receipt.sourceIndex] == receipt.transferredDigest else {
            throw StagedLibraryPhotoStoreError.transferReceiptMismatch
        }

        photos.remove(at: receipt.sourceIndex)
        if photos.isEmpty {
            try consumeAll()
        } else {
            _ = try replace(with: photos)
        }
    }

    private func consumeAll() throws {
        removePendingDirectories()
        guard fileManager.fileExists(atPath: directoryURL.path) else { return }

        let consumedURL = directoryURL.deletingLastPathComponent().appendingPathComponent(
            "\(Self.pendingPrefix)consumed-\(UUID().uuidString)",
            isDirectory: true
        )
        try consumeMoveItem(directoryURL, consumedURL)
        try? fileManager.removeItem(at: consumedURL)
    }

    func clear() {
        try? consumeAll()
        removePendingDirectories()
    }

    private func removePendingDirectories() {
        let parentURL = directoryURL.deletingLastPathComponent()
        guard let contents = try? fileManager.contentsOfDirectory(
            at: parentURL,
            includingPropertiesForKeys: nil
        ) else { return }

        for url in contents where url.lastPathComponent.hasPrefix(Self.pendingPrefix) {
            try? fileManager.removeItem(at: url)
        }
    }
}

final class InMemoryStagedLibraryPhotoStore: StagedLibraryPhotoPersisting {
    private var photos: [Data] = []
    private var cleanupNeededReceipt: LibraryPhotoTransferReceipt?

    @discardableResult
    func replace(with photos: [Data]) throws -> Int {
        self.photos = Array(photos.prefix(4))
        cleanupNeededReceipt = nil
        return self.photos.count
    }

    func load() throws -> [Data] {
        try reconcilePendingCleanupIfNeeded()
        return photos
    }

    @discardableResult
    func consume(
        transferReceipt: LibraryPhotoTransferReceipt
    ) throws -> StagedLibraryPhotoConsumeOutcome {
        guard transferReceipt.sourcePhotoFingerprints.indices.contains(
            transferReceipt.sourceIndex
        ), transferReceipt.sourcePhotoFingerprints[transferReceipt.sourceIndex]
            == transferReceipt.transferredDigest
        else {
            throw StagedLibraryPhotoStoreError.transferReceiptMismatch
        }
        try reconcilePendingCleanupIfNeeded()
        let fingerprints = photos.map(LocalPhotoFingerprint.digest)
        if fingerprints == transferReceipt.remainingPhotoFingerprints {
            return .consumed(remainingCount: photos.count)
        }
        if !fingerprints.contains(transferReceipt.transferredDigest) {
            return .consumed(remainingCount: photos.count)
        }
        guard fingerprints == transferReceipt.sourcePhotoFingerprints else {
            cleanupNeededReceipt = transferReceipt
            return .cleanupNeeded
        }
        photos.remove(at: transferReceipt.sourceIndex)
        return .consumed(remainingCount: photos.count)
    }

    func clear() {
        photos = []
        cleanupNeededReceipt = nil
    }

    private func reconcilePendingCleanupIfNeeded() throws {
        guard let receipt = cleanupNeededReceipt else { return }
        let fingerprints = photos.map(LocalPhotoFingerprint.digest)
        if fingerprints == receipt.remainingPhotoFingerprints {
            cleanupNeededReceipt = nil
            return
        }
        if !fingerprints.contains(receipt.transferredDigest) {
            cleanupNeededReceipt = nil
            return
        }
        guard photos.indices.contains(receipt.sourceIndex),
              fingerprints[receipt.sourceIndex] == receipt.transferredDigest else {
            throw StagedLibraryPhotoStoreError.transferReceiptMismatch
        }
        photos.remove(at: receipt.sourceIndex)
        cleanupNeededReceipt = nil
    }
}

struct GuestAllowanceSnapshot: Equatable {
    let isServerEnforced: Bool
    let ownerIssues: [Int]
    let completeAIItems: Int
    let samePhotoSetGuidedCorrections: Int
    let manualEditingIsUnlimited: Bool
    let recoveryHours: Int
}

protocol GuestAllowanceCapability {
    var snapshot: GuestAllowanceSnapshot { get }
}

/// Production wiring remains deliberately deferred until #174/#175 land.
/// This exposes the approved capability contract without pretending App Attest,
/// server reservation, claim, or recovery behavior exists today.
struct DeferredGuestAllowanceCapability: GuestAllowanceCapability {
    let snapshot = GuestAllowanceSnapshot(
        isServerEnforced: false,
        ownerIssues: [174, 175],
        completeAIItems: 1,
        samePhotoSetGuidedCorrections: 1,
        manualEditingIsUnlimited: true,
        recoveryHours: 24
    )
}

/// Durable storage for the onboarding completion contract issue #566 consumes.
///
/// The recorded value is the outcome, never a bare flag — see
/// `FirstValueOnboardingOutcome`. An unrecognised stored value reads as `nil` rather
/// than inventing an outcome, so a future package revision cannot make a seller look
/// taught by accident.
protocol FirstValueOnboardingCompletionPersisting: AnyObject {
    /// `nil` until onboarding reaches a terminal outcome.
    var outcome: FirstValueOnboardingOutcome? { get }
    func record(_ outcome: FirstValueOnboardingOutcome)
    func clear()
}

extension FirstValueOnboardingCompletionPersisting {
    var hasCompletedOnboarding: Bool { outcome != nil }
}

final class UserDefaultsFirstValueOnboardingCompletionStore:
    FirstValueOnboardingCompletionPersisting
{
    private let defaults: UserDefaults
    private let key: String

    /// No migration reads the legacy `…v1.completed` Bool, deliberately.
    ///
    /// That key existed only on unmerged #687 branch builds; no merged commit and no
    /// shipped build ever wrote it, so the only installs that can carry it are developer
    /// and CI simulators. On those, reading `nil` shows onboarding once more, which is
    /// what a developer wants anyway.
    ///
    /// Migrating would also have to invent an outcome. A bare Bool cannot say whether the
    /// seller completed, skipped, or was superseded by existing progress, and mapping it
    /// to `.completed` would tell #566 the seller saw the six screens when they may not
    /// have — exactly the "look taught by accident" failure this store's contract exists
    /// to prevent.
    init(
        defaults: UserDefaults = .standard,
        key: String = "snaplist.first-value-onboarding.v1.outcome"
    ) {
        self.defaults = defaults
        self.key = key
    }

    var outcome: FirstValueOnboardingOutcome? {
        guard let rawValue = defaults.string(forKey: key) else { return nil }
        return FirstValueOnboardingOutcome(rawValue: rawValue)
    }

    func record(_ outcome: FirstValueOnboardingOutcome) {
        defaults.set(outcome.rawValue, forKey: key)
    }

    func clear() {
        defaults.removeObject(forKey: key)
    }
}

final class InMemoryFirstValueOnboardingCompletionStore:
    FirstValueOnboardingCompletionPersisting
{
    private(set) var outcome: FirstValueOnboardingOutcome?

    func record(_ outcome: FirstValueOnboardingOutcome) {
        self.outcome = outcome
    }

    func clear() {
        outcome = nil
    }
}

protocol OnboardingProgressPersisting: AnyObject {
    func load() -> OnboardingFlowState?
    func save(_ state: OnboardingFlowState)
    func clear()
}

final class UserDefaultsOnboardingProgressStore: OnboardingProgressPersisting {
    private let defaults: UserDefaults
    private let key: String
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(defaults: UserDefaults = .standard, key: String = "snaplist.onboarding.v1") {
        self.defaults = defaults
        self.key = key
    }

    func load() -> OnboardingFlowState? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? decoder.decode(OnboardingFlowState.self, from: data)
    }

    func save(_ state: OnboardingFlowState) {
        guard let data = try? encoder.encode(state.persistable) else { return }
        defaults.set(data, forKey: key)
    }

    func clear() {
        defaults.removeObject(forKey: key)
    }
}

final class InMemoryOnboardingProgressStore: OnboardingProgressPersisting {
    private var storedState: OnboardingFlowState?

    func load() -> OnboardingFlowState? {
        storedState
    }

    func save(_ state: OnboardingFlowState) {
        storedState = state.persistable
    }

    func clear() {
        storedState = nil
    }
}
