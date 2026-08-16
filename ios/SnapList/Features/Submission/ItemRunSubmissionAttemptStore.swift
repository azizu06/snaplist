import CryptoKit
import Foundation

/// Comparison value for #540's opaque authenticated scope. It is neither a
/// bearer nor an authorization capability. The App Attest form may be encoded
/// only inside its guest capability so that one assertion's bearer and scope
/// stay atomic; the raw identity value is never retained.
struct ItemRunSubmissionPrincipalScopeProof: Equatable, Sendable {
    private let digest: Data

    init?(opaqueDigest: Data) {
        guard opaqueDigest.count == 32 else {
            return nil
        }
        digest = opaqueDigest
    }

    var opaqueDigest: Data { digest }

    init?(filesystemRoot: URL) {
        let component = filesystemRoot.standardizedFileURL.lastPathComponent
        guard component.hasPrefix("v1-") else {
            return nil
        }
        let hex = component.dropFirst(3)
        guard hex.count == 64,
              hex.allSatisfy({ $0.isHexDigit && !$0.isUppercase })
        else {
            return nil
        }
        var bytes: [UInt8] = []
        bytes.reserveCapacity(32)
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            guard let byte = UInt8(hex[index..<next], radix: 16) else {
                return nil
            }
            bytes.append(byte)
            index = next
        }
        digest = Data(bytes)
    }

    init?(verifiedClerkSubject: String) {
        self.init(
            tag: "clerk-subject",
            verifiedValue: verifiedClerkSubject
        )
    }

    init?(verifiedAppAttestKeyID: String) {
        self.init(
            tag: "app-attest-key-id",
            verifiedValue: verifiedAppAttestKeyID
        )
    }

    private init?(tag: String, verifiedValue: String) {
        guard !verifiedValue.isEmpty else {
            return nil
        }
        let tagged = [
            "dev.snaplist.native-intake-principal",
            "v1",
            tag,
            verifiedValue,
        ].joined(separator: "\u{0}")
        digest = Data(SHA256.hash(data: Data(tagged.utf8)))
    }
}

/// Who Trophy Wall's device-local cards belong to, as the shell can observe it
/// from one committed NativeIntake snapshot.
///
/// The activation id is the authority. NativeIntake mints a new one only in
/// `reconcileIdentity`, which runs only when the resolved principal scope
/// changes — a different signed-in seller, a sign-out, or an identity it cannot
/// resolve at all. Every mutation of one principal's staged intake keeps the
/// activation id and bumps only the revision.
///
/// The scope proof is derived from the staged photos' filesystem root, so it is
/// present only while photos are staged. An ordinary submit deletes them, and
/// the proof goes nil while the seller has not changed at all (#867). It can
/// therefore corroborate a transition but never announce one on its own.
struct TrophyWallPrincipalIdentity: Equatable, Sendable {
    let activationID: UUID
    let scopeProof: ItemRunSubmissionPrincipalScopeProof?

    init(
        activationID: UUID,
        scopeProof: ItemRunSubmissionPrincipalScopeProof?
    ) {
        self.activationID = activationID
        self.scopeProof = scopeProof
    }

    /// Whether moving from `previous` to `self` is a principal transition, and
    /// so whether the departing principal's cards must be cleared.
    func isTransition(from previous: TrophyWallPrincipalIdentity) -> Bool {
        guard activationID == previous.activationID else {
            return true
        }
        // One activation is one principal. Inside it, a proof that appears or
        // disappears is the staged intake being created or consumed. Two proofs
        // that are both present and disagree cannot happen — every photo in a
        // bundle lives under that bundle's one root — but if it ever did, the
        // safe reading is that the wall can no longer be trusted.
        guard let scopeProof, let previousProof = previous.scopeProof else {
            return false
        }
        return scopeProof != previousProof
    }
}

/// One immutable handoff from #540's committed NativeIntake snapshot into the
/// submission boundary. The generation is process-local fencing authority. The
/// filesystem root is already opaque and principal-scoped; no identity value or
/// bearer is derived, decoded, or persisted here.
struct ItemRunSubmissionPrincipalContext: Sendable {
    let generation: UUID
    let scopeProof: ItemRunSubmissionPrincipalScopeProof
    let photos: [StagedCapturePhoto]
    let voice: NativeIntake.Voice?
    let attemptStore: any ItemRunSubmissionAttemptStoring
    /// #843 item 3. Carried from the snapshot because `scopeProof` is a digest:
    /// an installation-scoped intake is indistinguishable from a seller-scoped
    /// one here, and only the first can never match a bearer.
    let isPrincipalBound: Bool

    private let validateFilesystemContext:
        @Sendable () async throws -> Void
    private let discardCommittedIntake: @Sendable () async -> Bool
    private let retireAcceptedPhotosPreservingVoice:
        @Sendable () async -> Bool

    private init(
        generation: UUID,
        scopeProof: ItemRunSubmissionPrincipalScopeProof,
        photos: [StagedCapturePhoto],
        voice: NativeIntake.Voice?,
        attemptStore: any ItemRunSubmissionAttemptStoring,
        isPrincipalBound: Bool,
        validateFilesystemContext:
            @escaping @Sendable () async throws -> Void,
        discardCommittedIntake: @escaping @Sendable () async -> Bool,
        retireAcceptedPhotosPreservingVoice:
            @escaping @Sendable () async -> Bool
    ) {
        self.generation = generation
        self.scopeProof = scopeProof
        self.photos = photos
        self.voice = voice
        self.attemptStore = attemptStore
        self.isPrincipalBound = isPrincipalBound
        self.validateFilesystemContext = validateFilesystemContext
        self.discardCommittedIntake = discardCommittedIntake
        self.retireAcceptedPhotosPreservingVoice =
            retireAcceptedPhotosPreservingVoice
    }

    init?(
        snapshot: NativeIntake.Snapshot,
        intake: NativeIntake,
        fileManager: FileManager = .default
    ) {
        guard snapshot.recovery == .ready,
              let filesystemRoot = Self.filesystemRoot(
                  for: snapshot.photos,
                  voice: snapshot.voice
              ),
              LocalItemRunSubmissionAttemptStore
                  .trustedApplicationSupportAnchor(
                      forPrincipalRoot: filesystemRoot
                  ) != nil,
              let scopeProof = ItemRunSubmissionPrincipalScopeProof(
                  filesystemRoot: filesystemRoot
              )
        else {
            return nil
        }
        let attemptStore = LocalItemRunSubmissionAttemptStore(
            principalRootDirectory: filesystemRoot,
            fileManager: fileManager
        )
        self.init(
            generation: snapshot.version.activationID,
            scopeProof: scopeProof,
            photos: snapshot.photos,
            voice: snapshot.voice,
            attemptStore: attemptStore,
            isPrincipalBound: snapshot.isPrincipalBound,
            validateFilesystemContext: {
                try await attemptStore.validatePrincipalScope()
            },
            discardCommittedIntake: {
                await intake.perform(.discard(expected: snapshot.version))
                    == .committed
            },
            retireAcceptedPhotosPreservingVoice: {
                guard let voice = snapshot.voice else {
                    return false
                }
                return await intake.perform(
                    .retireAcceptedPhotos(
                        expected: snapshot.version,
                        photoIDs: snapshot.photos.map(\.id),
                        preservingUnmatchedVoiceID: voice.id
                    )
                ) == .committed
            }
        )
    }

    func discardExactly() async -> Bool {
        await discardCommittedIntake()
    }

    func retireAcceptedPhotosPreservingUnmatchedVoice() async -> Bool {
        await retireAcceptedPhotosPreservingVoice()
    }

    func validatesFilesystemContext() async -> Bool {
        do {
            try await validateFilesystemContext()
            return true
        } catch {
            return false
        }
    }

    /// NativeIntake publishes photos from `<opaque-root>/Current/Assets`.
    /// Translate that public committed path back to the immutable opaque root and
    /// reject mixed or malformed roots rather than guessing principal ownership.
    private static func filesystemRoot(
        for photos: [StagedCapturePhoto],
        voice: NativeIntake.Voice?
    ) -> URL? {
        guard let first = photos.first,
              let root = filesystemRoot(for: first.photoURL)
        else {
            return nil
        }
        let assetsRoot = root
            .appendingPathComponent("Current", isDirectory: true)
            .appendingPathComponent("Assets", isDirectory: true)
            .standardizedFileURL
        guard photos.allSatisfy({
            $0.photoURL.deletingLastPathComponent().standardizedFileURL
                == assetsRoot
                && $0.thumbnailURL.deletingLastPathComponent()
                    .standardizedFileURL == assetsRoot
        }),
              (
                  voice == nil
                      || voice?.mediaURL.deletingLastPathComponent()
                          .standardizedFileURL == assetsRoot
              )
        else {
            return nil
        }
        return root
    }

    private static func filesystemRoot(for mediaURL: URL) -> URL? {
        guard mediaURL.isFileURL else {
            return nil
        }
        let assetsRoot = mediaURL.deletingLastPathComponent()
            .standardizedFileURL
        guard assetsRoot.lastPathComponent == "Assets" else {
            return nil
        }
        let currentRoot = assetsRoot.deletingLastPathComponent()
            .standardizedFileURL
        guard currentRoot.lastPathComponent == "Current" else {
            return nil
        }
        let root = currentRoot.deletingLastPathComponent().standardizedFileURL
        guard !root.path.isEmpty, root.path != "/" else {
            return nil
        }
        return root
    }
}

/// Durable, device-local home for the one in-flight submission attempt.
///
/// The attempt outlives the process on purpose: a seller who force-quits mid-request
/// has to come back to the same key, or their retry buys a second run for one item.
actor LocalItemRunSubmissionAttemptStore: ItemRunSubmissionAttemptStoring {
    static let fileProtection = FileProtectionType.complete
    static let writingOptions: Data.WritingOptions = [.atomic, .completeFileProtection]

    private let fileManager: FileManager
    private let containmentAnchor: URL?
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
        containmentAnchor = resolvedRoot.standardizedFileURL
        self.rootDirectory = resolvedRoot.standardizedFileURL
        attemptURL = resolvedRoot
            .appendingPathComponent("attempt.json")
            .standardizedFileURL
    }

    init(
        principalRootDirectory: URL,
        fileManager: FileManager = .default
    ) {
        self.fileManager = fileManager
        containmentAnchor = Self.trustedApplicationSupportAnchor(
            forPrincipalRoot: principalRootDirectory
        )
        rootDirectory = principalRootDirectory
            .appendingPathComponent("ItemRunSubmission", isDirectory: true)
            .standardizedFileURL
        attemptURL = rootDirectory
            .appendingPathComponent("attempt.json")
            .standardizedFileURL
    }

    func loadAttempt() async throws -> ItemRunSubmissionAttempt? {
        try validateStorePaths()
        // Existence comes from the same metadata read that fails closed. `fileExists`
        // answers false both for a path that is absent and for one it cannot stat, and a
        // pre-check that returns nil for the second mints a fresh key for photos the first
        // submission may already have committed. Only a definite "no such file" is absence.
        //
        // The read goes through the injected `FileManager` rather than `URL.resourceValues`
        // for two reasons. A URL caches the resource values it has already fetched, and this
        // store holds one long-lived `attemptURL`, so a second load answers from the state
        // before `clearAttempt` deleted the file. That is observed, not assumed:
        // `testStoredAttemptSurvivesRelaunchAndClearsOnlyItself` failed exactly that way once the
        // `fileExists` pre-check this replaced stopped short-circuiting the deleted path. It also
        // gives the fail-closed and unknown-type branches a seam a test can actually reach.
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
            return try discardUnusableAttempt()
        }
        // A regular record that exists but cannot be read is not the same as no record.
        // Reporting it as absent mints a second key for photos the first submission may
        // already have committed, which is the duplicate run this file exists to prevent.
        // Fail closed and let the caller stop before the network instead.
        try validateStorePaths()
        let data = try Data(contentsOf: attemptURL)
        // Read the version before the body. Decoding the whole record first cannot tell
        // a renamed or removed field from genuine corruption, so every future schema
        // change would look like a broken file.
        let version = try? decoder.decode(
            ItemRunSubmissionAttempt.StoredVersion.self,
            from: data
        )
        guard let stored = try? decoder.decode(
            ItemRunSubmissionAttempt.self,
            from: data
        ) else {
            return try discardUnusableAttempt()
        }
        let isCurrent =
            version?.schemaVersion
                == ItemRunSubmissionAttempt.currentSchemaVersion
        let isCompatiblePhotoOnlyV1 =
            version?.schemaVersion == 1 && stored.voiceContext == nil
        let isCompatibleAuthenticatedV2 =
            version?.schemaVersion == 2
                && stored.guestRecoveryIdentity == nil
        guard isCurrent || isCompatiblePhotoOnlyV1
                || isCompatibleAuthenticatedV2 else {
            return try discardUnusableAttempt()
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
    private func discardUnusableAttempt() throws
        -> ItemRunSubmissionAttempt? {
        try validateStorePaths()
        try fileManager.removeItem(at: attemptURL)
        return nil
    }

    func saveAttempt(_ attempt: ItemRunSubmissionAttempt) async throws {
        try validateStorePaths()
        try fileManager.createDirectory(
            at: rootDirectory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: Self.fileProtection]
        )
        try validateStorePaths()
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
        try validateStorePaths()
        try fileManager.removeItem(at: attemptURL)
    }

    func validatePrincipalScope() async throws {
        try validateStorePaths()
    }

    private func validateStorePaths() throws {
        guard let containmentAnchor else {
            throw CocoaError(.fileReadInvalidFileName)
        }
        try Self.validateContainedPath(
            attemptURL,
            under: containmentAnchor,
            fileManager: fileManager
        )
    }

    /// #540 owns this fixed durable layout:
    /// `<Application Support>/SnapList/NativeIntake/<opaque principal>`.
    /// Walking back only these named components recovers the same lexical trust
    /// anchor without resolving a path that may already contain a symlink.
    nonisolated static func trustedApplicationSupportAnchor(
        forPrincipalRoot principalRoot: URL
    ) -> URL? {
        let principalRoot = principalRoot.standardizedFileURL
        let nativeIntakeRoot = principalRoot.deletingLastPathComponent()
        guard nativeIntakeRoot.lastPathComponent == "NativeIntake" else {
            return nil
        }
        let snapListRoot = nativeIntakeRoot.deletingLastPathComponent()
        guard snapListRoot.lastPathComponent == "SnapList" else {
            return nil
        }
        let anchor = snapListRoot.deletingLastPathComponent()
            .standardizedFileURL
        guard !anchor.path.isEmpty, anchor.path != "/" else {
            return nil
        }
        return anchor
    }

    /// Match #540's vault rule: lexical containment is insufficient because an
    /// attacker-controlled or corrupt ancestor symlink can redirect an otherwise
    /// ordinary-looking attempt path into another principal's scope.
    private nonisolated static func validateContainedPath(
        _ candidate: URL,
        under anchor: URL,
        fileManager: FileManager
    ) throws {
        let anchor = anchor.standardizedFileURL
        let candidate = candidate.standardizedFileURL
        guard isContained(candidate, under: anchor) else {
            throw CocoaError(.fileReadInvalidFileName)
        }
        var current = anchor
        try rejectSymlinkIfPresent(current, fileManager: fileManager)
        for component in candidate.pathComponents.dropFirst(
            anchor.pathComponents.count
        ) {
            current.appendPathComponent(component)
            try rejectSymlinkIfPresent(current, fileManager: fileManager)
        }
        guard isContained(
            candidate.resolvingSymlinksInPath(),
            under: anchor.resolvingSymlinksInPath()
        ) else {
            throw CocoaError(.fileReadInvalidFileName)
        }
    }

    private nonisolated static func rejectSymlinkIfPresent(
        _ url: URL,
        fileManager: FileManager
    ) throws {
        do {
            let attributes = try fileManager.attributesOfItem(atPath: url.path)
            guard attributes[.type] as? FileAttributeType
                    != .typeSymbolicLink else {
                throw CocoaError(.fileReadInvalidFileName)
            }
        } catch {
            guard describesAnAbsentPath(error) else {
                throw error
            }
        }
    }

    private nonisolated static func isContained(
        _ candidate: URL,
        under anchor: URL
    ) -> Bool {
        candidate == anchor
            || candidate.path.hasPrefix(anchor.path + "/")
    }
}
