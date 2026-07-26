import Foundation

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
        // `saveAttempt` only ever writes a regular file, so anything else standing at this
        // path was never a submission and cannot be one. Removing it keeps the fail-closed
        // rule below from refusing every later submission over something that guards
        // nothing.
        guard (try? attemptURL.resourceValues(forKeys: [.isRegularFileKey]))?
            .isRegularFile == true else {
            return discardUnusableAttempt()
        }
        // A regular record that exists but cannot be read is not the same as no record.
        // Reporting it as absent mints a second key for photos the first submission may
        // already have committed, which is the duplicate run this file exists to prevent.
        // Fail closed and let the caller stop before the network instead.
        let data = try Data(contentsOf: attemptURL)
        // Read the version before the body. Decoding the whole record first cannot tell
        // a renamed or removed field from genuine corruption, so every future schema
        // change would look like a broken file.
        let version = try? decoder.decode(
            ItemRunSubmissionAttempt.StoredVersion.self,
            from: data
        )
        guard version?.schemaVersion == ItemRunSubmissionAttempt.currentSchemaVersion,
              let stored = try? decoder.decode(
                  ItemRunSubmissionAttempt.self,
                  from: data
              ) else {
            return discardUnusableAttempt()
        }
        return stored
    }

    /// A record that was read but cannot be interpreted is removed rather than kept.
    ///
    /// This is only for a file whose bytes are available and whose contents this build
    /// cannot make sense of, either corrupt or written by another schema version. Such a
    /// record guards nothing, so keeping it would leave an unusable file behind on every
    /// later load for no benefit. The next submission overwrites it either way.
    ///
    /// A regular file that could not be read at all is deliberately not routed here. That
    /// case is indistinguishable from a live attempt, and treating it as absent is what
    /// buys the seller a second run.
    ///
    /// The cost of that choice is real and worth naming. Nothing in the app can remove a
    /// regular record it cannot read, so while the read keeps failing every submission
    /// refuses, for any photo set. The remaining causes are a locked device, which clears
    /// itself, and filesystem damage. Corrupt bytes are not among them, because those read
    /// successfully and fail to decode, which lands here instead.
    private func discardUnusableAttempt() -> ItemRunSubmissionAttempt? {
        try? fileManager.removeItem(at: attemptURL)
        return nil
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
