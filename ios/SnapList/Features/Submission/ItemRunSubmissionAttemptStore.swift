import Foundation

enum ItemRunSubmissionAttemptStoreError: Error, Equatable {
    case unreadableAttempt
}

/// Durable, device-local home for the one in-flight submission attempt.
///
/// The attempt outlives the process on purpose: a seller who force-quits mid-request
/// has to come back to the same key, or their retry buys a second run for one item.
actor LocalItemRunSubmissionAttemptStore: ItemRunSubmissionAttemptStoring {
    static let fileProtection = FileProtectionType.complete
    static let writingOptions: Data.WritingOptions = [.atomic, .completeFileProtection]

    private let fileManager: FileManager
    private let rootDirectory: URL
    private let attemptURL: URL
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(rootDirectory: URL? = nil, fileManager: FileManager = .default) {
        self.fileManager = fileManager
        let resolvedRoot = rootDirectory ?? fileManager.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first!
            .appendingPathComponent("SnapList", isDirectory: true)
            .appendingPathComponent("ItemRunSubmission", isDirectory: true)
        self.rootDirectory = resolvedRoot
        attemptURL = resolvedRoot.appendingPathComponent("attempt.json")
    }

    func loadAttempt() async throws -> ItemRunSubmissionAttempt? {
        guard fileManager.fileExists(atPath: attemptURL.path) else {
            return nil
        }
        let stored: ItemRunSubmissionAttempt
        do {
            stored = try decoder.decode(
                ItemRunSubmissionAttempt.self,
                from: Data(contentsOf: attemptURL)
            )
        } catch {
            // Absence and unreadability are not the same answer. Absence means no key
            // exists, so minting one is correct. Unreadability means a key may exist
            // and is unknown, and minting one there submits photos that may already
            // have a run and charges the seller for them twice.
            throw ItemRunSubmissionAttemptStoreError.unreadableAttempt
        }
        // A record another version wrote is stale rather than unknown. Attempts only
        // live while one submission is unresolved, so an older one no longer guards
        // anything and discarding it cannot duplicate a run.
        guard stored.schemaVersion == ItemRunSubmissionAttempt.currentSchemaVersion else {
            return nil
        }
        return stored
    }

    func saveAttempt(_ attempt: ItemRunSubmissionAttempt) async throws {
        try fileManager.createDirectory(
            at: rootDirectory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: Self.fileProtection]
        )
        var resourceValues = URLResourceValues()
        resourceValues.isExcludedFromBackup = true
        var protectedRootDirectory = rootDirectory
        try protectedRootDirectory.setResourceValues(resourceValues)

        try encoder.encode(attempt).write(to: attemptURL, options: Self.writingOptions)
    }

    func clearAttempt(_ attempt: ItemRunSubmissionAttempt) async throws {
        guard try await loadAttempt() == attempt else {
            return
        }
        try fileManager.removeItem(at: attemptURL)
    }
}
