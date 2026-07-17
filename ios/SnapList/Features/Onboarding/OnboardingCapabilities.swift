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
    func clear()
}

final class FileSystemStagedLibraryPhotoStore: StagedLibraryPhotoPersisting {
    static let fileProtection = FileProtectionType.complete
    static let writingOptions: Data.WritingOptions = [.atomic, .completeFileProtection]
    private static let pendingPrefix = ".OnboardingStagedPhotos-"

    private let fileManager: FileManager
    private let directoryURL: URL

    init(
        fileManager: FileManager = .default,
        directoryURL: URL? = nil
    ) {
        self.fileManager = fileManager
        self.directoryURL = directoryURL
            ?? fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("SnapList/OnboardingStagedPhotos", isDirectory: true)
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
                _ = try fileManager.replaceItemAt(
                    directoryURL,
                    withItemAt: pendingURL
                )
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
        return try fileManager.contentsOfDirectory(
            at: directoryURL,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )
        .filter { $0.pathExtension == "photo" }
        .sorted { $0.lastPathComponent < $1.lastPathComponent }
        .prefix(4)
        .map { try Data(contentsOf: $0) }
    }

    func clear() {
        try? fileManager.removeItem(at: directoryURL)
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

    @discardableResult
    func replace(with photos: [Data]) throws -> Int {
        self.photos = Array(photos.prefix(4))
        return self.photos.count
    }

    func load() throws -> [Data] {
        photos
    }

    func clear() {
        photos = []
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
