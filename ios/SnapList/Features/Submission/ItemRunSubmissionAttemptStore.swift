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
        // Existence comes from the same metadata read that fails closed. `fileExists`
        // answers false both for a path that is absent and for one it cannot stat, and a
        // pre-check that returns nil for the second mints a fresh key for photos the first
        // submission may already have committed. Only a definite "no such file" is absence.
        //
        // The read goes through the injected `FileManager` rather than `URL.resourceValues`
        // for two reasons. A URL caches the resource values it has already fetched, and this
        // store holds one long-lived `attemptURL`, so a second load would answer from the
        // state before `clearAttempt` deleted the file. It also gives the fail-closed and
        // unknown-type branches a seam a test can actually reach.
        let isRegularFile: Bool?
        do {
            let attributes = try fileManager.attributesOfItem(atPath: attemptURL.path)
            isRegularFile = (attributes[.type] as? FileAttributeType)
                .map { $0 == .typeRegular }
        } catch where Self.describesAnAbsentPath(error) {
            return nil
        }
        // `saveAttempt` only ever writes a regular file, so anything else standing at this
        // path was never a submission and cannot be one. Removing it keeps the fail-closed
        // rule below from refusing every later submission over something that guards
        // nothing.
        //
        // Only a definite answer of "not a regular file" earns that removal. A metadata
        // read that comes back without the value says nothing about what is here, and
        // deleting on that would throw away a key a committed submission may still be
        // using. It falls through to the read and fails closed with everything else that
        // cannot be identified.
        if isRegularFile == false {
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

    /// Whether a failed metadata read proves there is nothing at the path.
    ///
    /// Every other failure leaves the question open, and an open question is treated as a
    /// live attempt rather than as absence.
    private static func describesAnAbsentPath(_ error: Error) -> Bool {
        if let cocoaError = error as? CocoaError {
            return cocoaError.code == .fileReadNoSuchFile
                || cocoaError.code == .fileNoSuchFile
        }
        if let posixError = error as? POSIXError {
            return posixError.code == .ENOENT
        }
        return false
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
