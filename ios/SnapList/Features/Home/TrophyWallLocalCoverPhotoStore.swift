import Foundation

/// Which principal a directory of staged Trophy Wall photos belongs to.
///
/// It is the intake's own scope component — the tagged SHA-256 digest of the
/// verified Clerk subject, or of the App Attest key id when there is no signed-in
/// seller. Taking it from the intake rather than deriving a second digest here
/// means there is exactly one definition of who the device is currently working
/// for, and no identity value is written to disk either way.
///
/// A scope that is not principal-bound has no durable home at all: the
/// installation-scoped and ephemeral roots belong to whoever is holding the
/// phone, and a photo filed under one could never be claimed.
struct TrophyWallLocalCoverPhotoPrincipal: Hashable, Sendable {
    private static let prefix = "v1-"
    private static let digestHexLength = 64

    /// `v1-<64 lowercase hex>`.
    let directoryComponent: String

    init?(scopeDirectoryComponent component: String) {
        guard Self.describesAPrincipal(component) else {
            return nil
        }
        directoryComponent = component
    }

    /// Whether a directory name is one this store could have written. Anything
    /// else under the covers root was not put there by this feature and is left
    /// alone rather than swept.
    fileprivate static func describesAPrincipal(_ component: String) -> Bool {
        let digest = component.dropFirst(prefix.count)
        return component.hasPrefix(prefix)
            && digest.count == digestHexLength
            && digest.allSatisfy { $0.isHexDigit && !$0.isUppercase }
    }
}

/// Where the seller's own processing photo lives between launches.
///
/// Bytes rather than a path, for the same reason the card carries bytes (#855):
/// the staged intake is deleted the moment the server accepts the run, so by
/// the time this is read there is nothing left to point at.
///
/// Deliberately synchronous. Every call site is one small JPEG on the main
/// actor inside a wall mutation that is already ordered, and an async seam here
/// would let a restore land after the ingest that was supposed to supersede it.
protocol TrophyWallLocalCoverPhotoStoring {
    /// Every unexpired photo this principal has, keyed by run. Also the sweep:
    /// expired records are deleted here rather than on a timer, because the wall
    /// is the only thing that ever reads them.
    func loadAll() -> [UUID: Data]
    func save(_ photoData: Data, forRun runID: UUID)
    func remove(forRun runID: UUID)
}

/// What the wall holds before a principal is resolved, and what it reverts to
/// on a principal transition. It reads nothing and writes nothing, so a wall
/// that has not yet proved who it belongs to cannot persist for the wrong
/// seller or restore from the previous one.
struct UnavailableTrophyWallLocalCoverPhotoStore: TrophyWallLocalCoverPhotoStoring {
    func loadAll() -> [UUID: Data] { [:] }
    func save(_ photoData: Data, forRun runID: UUID) {}
    func remove(forRun runID: UUID) {}
}

/// `<Application Support>/SnapList/TrophyWallCovers/v1-<digest>/run-<uuid>.json`.
///
/// An independently owned root rather than a subdirectory of the intake's, so
/// sign-out removes it in the same transaction as the other cached roots
/// instead of waiting out the intake's recovery window.
struct FileTrophyWallLocalCoverPhotoStore: TrophyWallLocalCoverPhotoStoring {
    /// The longest a staged photo may outlive its last write. It matches
    /// `NativeIntake.recoveryWindow` on purpose: a guest's claim on this device
    /// expires on that schedule, and a photo that outlived the claim would be a
    /// copy nobody can claim.
    static let retentionWindow: TimeInterval = NativeIntake.recoveryWindow
    static let fileProtection = FileProtectionType.complete
    static let writingOptions: Data.WritingOptions = [.atomic, .completeFileProtection]
    static let rootDirectoryName = "TrophyWallCovers"

    private struct StoredCoverPhoto: Codable {
        static let currentSchemaVersion = 1

        let schemaVersion: Int
        let runID: UUID
        let expiresAt: Date
        let photo: Data
    }

    private let fileManager: FileManager
    private let anchor: URL
    private let coversRoot: URL
    private let principalRoot: URL
    private let now: () -> Date
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(
        principal: TrophyWallLocalCoverPhotoPrincipal,
        applicationSupportDirectory: URL? = nil,
        fileManager: FileManager = .default,
        now: @escaping () -> Date = Date.init
    ) {
        self.fileManager = fileManager
        self.now = now
        anchor = (applicationSupportDirectory ?? fileManager.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        )[0]).standardizedFileURL
        coversRoot = anchor
            .appendingPathComponent("SnapList", isDirectory: true)
            .appendingPathComponent(Self.rootDirectoryName, isDirectory: true)
            .standardizedFileURL
        principalRoot = coversRoot
            .appendingPathComponent(
                principal.directoryComponent,
                isDirectory: true
            )
            .standardizedFileURL
    }

    func loadAll() -> [UUID: Data] {
        removeExpiredRecords()
        guard let names = try? contentsOfPrincipalRoot() else {
            return [:]
        }
        var photos: [UUID: Data] = [:]
        for name in names {
            guard let runID = Self.runID(forFileNamed: name),
                  let stored = record(forRun: runID),
                  stored.runID == runID else {
                continue
            }
            photos[runID] = stored.photo
        }
        return photos
    }

    func save(_ photoData: Data, forRun runID: UUID) {
        let url = fileURL(forRun: runID)
        do {
            try fileManager.createDirectory(
                at: principalRoot,
                withIntermediateDirectories: true,
                attributes: [.protectionKey: Self.fileProtection]
            )
            try validate(url)
            var excludedFromBackup = URLResourceValues()
            excludedFromBackup.isExcludedFromBackup = true
            var protectedRoot = principalRoot
            try protectedRoot.setResourceValues(excludedFromBackup)
            let stored = StoredCoverPhoto(
                schemaVersion: StoredCoverPhoto.currentSchemaVersion,
                runID: runID,
                expiresAt: now().addingTimeInterval(Self.retentionWindow),
                photo: photoData
            )
            try encoder.encode(stored).write(to: url, options: Self.writingOptions)
        } catch {
            // A photo that cannot be written is decoration the wall does without.
            // The in-memory card still carries it for this launch, and the next
            // relaunch renders today's slot rather than claiming a photo.
        }
    }

    func remove(forRun runID: UUID) {
        removeRecord(at: fileURL(forRun: runID))
    }

    /// Deletes every record whose retention has run out, in every principal's
    /// directory rather than only this one.
    ///
    /// Sweeping foreign directories is safe precisely because it is keyed on
    /// expiry and not on identity: an expired record belongs to nobody. Sweeping
    /// on foreignness instead would delete the signed-in seller's photos during
    /// the window at launch where Clerk has not answered yet and the device
    /// still looks like a guest.
    private func removeExpiredRecords() {
        let currentTime = now()
        guard let principalNames = try? fileManager.contentsOfDirectory(
            atPath: coversRoot.path
        ) else {
            return
        }
        for principalName in principalNames
        where TrophyWallLocalCoverPhotoPrincipal.describesAPrincipal(principalName) {
            let root = coversRoot
                .appendingPathComponent(principalName, isDirectory: true)
                .standardizedFileURL
            guard let names = try? fileManager.contentsOfDirectory(
                atPath: root.path
            ) else {
                continue
            }
            for name in names {
                let url = root.appendingPathComponent(name).standardizedFileURL
                if let stored = record(at: url) {
                    if stored.expiresAt <= currentTime {
                        removeRecord(at: url)
                    }
                    continue
                }
                // A record that would not decode is either junk or a file this
                // build was not allowed to read — a launch behind the lock
                // screen reads nothing at all. Deleting on that would throw away
                // a live photo, so the fallback is the one fact the filesystem
                // still answers while locked: how old the file is.
                guard let writtenAt = modificationDate(of: url),
                      writtenAt.addingTimeInterval(Self.retentionWindow)
                        <= currentTime else {
                    continue
                }
                removeRecord(at: url)
            }
            if (try? fileManager.contentsOfDirectory(atPath: root.path))?.isEmpty
                == true {
                try? fileManager.removeItem(at: root)
            }
        }
    }

    private func contentsOfPrincipalRoot() throws -> [String] {
        try validate(principalRoot)
        return try fileManager.contentsOfDirectory(atPath: principalRoot.path)
    }

    private func record(forRun runID: UUID) -> StoredCoverPhoto? {
        record(at: fileURL(forRun: runID))
    }

    private func record(at url: URL) -> StoredCoverPhoto? {
        guard (try? validate(url)) != nil,
              let data = try? Data(contentsOf: url),
              let stored = try? decoder.decode(StoredCoverPhoto.self, from: data),
              stored.schemaVersion == StoredCoverPhoto.currentSchemaVersion else {
            return nil
        }
        return stored
    }

    private func modificationDate(of url: URL) -> Date? {
        guard let attributes = try? fileManager.attributesOfItem(
            atPath: url.path
        ) else {
            return nil
        }
        return attributes[.modificationDate] as? Date
    }

    private func removeRecord(at url: URL) {
        guard (try? validate(url)) != nil else {
            return
        }
        try? fileManager.removeItem(at: url)
    }

    private func fileURL(forRun runID: UUID) -> URL {
        principalRoot
            .appendingPathComponent("run-\(runID.uuidString.lowercased()).json")
            .standardizedFileURL
    }

    private static func runID(forFileNamed name: String) -> UUID? {
        guard name.hasPrefix("run-"), name.hasSuffix(".json") else {
            return nil
        }
        return UUID(uuidString: String(name.dropFirst(4).dropLast(5)))
    }

    /// The same rule the intake's attempt store applies: lexical containment is
    /// not enough, because a symlinked ancestor redirects an ordinary-looking
    /// path into another principal's directory.
    private func validate(_ candidate: URL) throws {
        let candidate = candidate.standardizedFileURL
        guard Self.isContained(candidate, under: coversRoot) else {
            throw CocoaError(.fileReadInvalidFileName)
        }
        var current = anchor
        try rejectSymlinkIfPresent(current)
        for component in candidate.pathComponents.dropFirst(
            anchor.pathComponents.count
        ) {
            current.appendPathComponent(component)
            try rejectSymlinkIfPresent(current)
        }
        guard Self.isContained(
            candidate.resolvingSymlinksInPath(),
            under: coversRoot.resolvingSymlinksInPath()
        ) else {
            throw CocoaError(.fileReadInvalidFileName)
        }
    }

    private func rejectSymlinkIfPresent(_ url: URL) throws {
        do {
            let attributes = try fileManager.attributesOfItem(atPath: url.path)
            guard attributes[.type] as? FileAttributeType
                    != .typeSymbolicLink else {
                throw CocoaError(.fileReadInvalidFileName)
            }
        } catch {
            guard Self.describesAnAbsentPath(error) else {
                throw error
            }
        }
    }

    private static func isContained(_ candidate: URL, under anchor: URL) -> Bool {
        candidate == anchor || candidate.path.hasPrefix(anchor.path + "/")
    }

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
}

/// Resolves the durable home for the intake's current scope. A scope that names
/// no principal gets the unavailable store, which is what keeps an unproved
/// launch from writing a photo into a directory nobody owns.
enum TrophyWallLocalCoverPhotoStoreFactory {
    static func make(
        scopeDirectoryComponent: String?,
        applicationSupportDirectory: URL? = nil,
        fileManager: FileManager = .default,
        now: @escaping () -> Date = Date.init
    ) -> any TrophyWallLocalCoverPhotoStoring {
        guard let scopeDirectoryComponent,
              let principal = TrophyWallLocalCoverPhotoPrincipal(
                  scopeDirectoryComponent: scopeDirectoryComponent
              ) else {
            return UnavailableTrophyWallLocalCoverPhotoStore()
        }
        return FileTrophyWallLocalCoverPhotoStore(
            principal: principal,
            applicationSupportDirectory: applicationSupportDirectory,
            fileManager: fileManager,
            now: now
        )
    }
}
