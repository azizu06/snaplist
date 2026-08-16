import CryptoKit
import Foundation
import ImageIO

actor NativeIntake {
    struct Identity: Sendable {
        let verifiedClerkSubject: String?
        let persistedAppAttestKeyID: String?
    }

    struct IdentitySource: Sendable {
        enum AnonymousScopePersistence: Sendable {
            case processPrivate
            case installation
        }

        let current: @Sendable () async -> Identity
        let changes: @Sendable () -> AsyncStream<Void>
        let anonymousScopePersistence: AnonymousScopePersistence

        init(
            current: @escaping @Sendable () async -> Identity,
            changes: @escaping @Sendable () -> AsyncStream<Void>,
            anonymousScopePersistence: AnonymousScopePersistence = .processPrivate
        ) {
            self.current = current
            self.changes = changes
            self.anonymousScopePersistence = anonymousScopePersistence
        }

        static let processPrivate = IdentitySource(
            current: { Identity(verifiedClerkSubject: nil, persistedAppAttestKeyID: nil) },
            changes: { AsyncStream { _ in } }
        )
    }

    struct Version: Hashable, Sendable {
        let activationID: UUID
        let revision: UInt64
    }

    typealias Photo = StagedCapturePhoto

    struct Voice: Codable, Equatable, Identifiable, Sendable {
        let id: UUID
        let mediaURL: URL
        let duration: TimeInterval
    }

    enum Recovery: Equatable, Sendable {
        case ready
        case pending
    }

    struct Snapshot: Equatable, Sendable {
        let version: Version
        let photos: [Photo]
        let voice: Voice?
        let recovery: Recovery
    }

    struct PhotoInput: @unchecked Sendable {
        let libraryTransferReceipt: LibraryPhotoTransferReceipt?
        let isActive: @MainActor @Sendable () -> Bool
        let loadData: () async throws -> Data?

        init(
            libraryTransferReceipt: LibraryPhotoTransferReceipt? = nil,
            isActive: @escaping @MainActor @Sendable () -> Bool = { true },
            loadData: @escaping () async throws -> Data?
        ) {
            self.libraryTransferReceipt = libraryTransferReceipt
            self.isActive = isActive
            self.loadData = loadData
        }
    }

    struct VoiceInput: Sendable {
        let duration: TimeInterval
        let isActive: @MainActor @Sendable () -> Bool
        let loadData: @Sendable () async throws -> Data

        init(
            duration: TimeInterval,
            isActive: @escaping @MainActor @Sendable () -> Bool = { true },
            loadData: @escaping @Sendable () async throws -> Data
        ) {
            self.duration = duration
            self.isActive = isActive
            self.loadData = loadData
        }
    }

    enum Operation: Sendable {
        case addPhotos([PhotoInput])
        case replacePhoto(id: Photo.ID, with: PhotoInput)
        case removePhoto(id: Photo.ID)
        case reorderPhotos([Photo.ID])
        case setVoice(VoiceInput)
        case deleteVoice
        case discard(expected: Version)
        case retireAcceptedPhotos(
            expected: Version,
            photoIDs: [Photo.ID],
            preservingUnmatchedVoiceID: Voice.ID
        )
        case photoReviewEntered(activationID: UUID)
        case photoReviewLeft(activationID: UUID)
    }

    enum Rejection: Equatable, Sendable {
        case invalidOperation
        case invalidPhoto
        case invalidVoice
        case photoLimit
        case recoveryPending
        case sourceUnavailable
        case storageFailure
    }

    enum Outcome: Equatable, Sendable {
        case committed
        case unchanged
        case superseded
        case rejected(Rejection)
    }

    struct OperationResult: Equatable, Sendable {
        let outcome: Outcome
        let snapshot: Snapshot?
    }

    enum Event: Equatable, Sendable {
        case snapshot(Snapshot)
        case dismissActivePhotoReview
    }

    static let recoveryWindow: TimeInterval = 24 * 60 * 60
    static let retentionRetryInterval: TimeInterval = 5 * 60
    static let writingOptions: Data.WritingOptions = [.atomic, .completeFileProtection]

    private struct Scope: Equatable { let directoryComponent: String }

    private struct StoredBundle: Codable {
        let schemaVersion: Int
        let revision: UInt64
        let expiresAt: Date
        let photos: [Photo]
        let voice: Voice?
    }

    /// A server-accepted photo run whose optional voice was not accepted leaves only
    /// deletion authority behind. This record never enters an active snapshot or a
    /// later submission; it exists solely so existing scoped discard/expiry cleanup
    /// can remove the protected bytes at their original absolute deadline.
    private struct DeferredUnmatchedVoice: Codable, Equatable {
        let schemaVersion: Int
        let expiresAt: Date
        let voice: Voice
    }

    private struct DeferredUnmatchedVoiceRecord {
        let root: URL
        let value: DeferredUnmatchedVoice
    }

    private struct EphemeralMarker: Codable {
        let schemaVersion: Int
        let createdAt: Date
    }

    private struct AnonymousInstallationIdentity: Codable {
        let schemaVersion: Int
        let id: UUID
    }

    private enum ReadResult<Value> {
        case value(Value)
        case absent
        case malformed
        case transient
    }

    private struct ActiveBundle {
        let scope: Scope?
        let root: URL
        let activationID: UUID
        let revision: UInt64
        let expiresAt: Date?
        let photos: [Photo]
        let voice: Voice?
        let recovery: Recovery

        var version: Version { Version(activationID: activationID, revision: revision) }
        var snapshot: Snapshot {
            Snapshot(version: version, photos: photos, voice: voice, recovery: recovery)
        }
        var assetsRoot: URL { root.appendingPathComponent("Current/Assets", isDirectory: true) }

        func next(photos: [Photo], voice: Voice?, now: Date) -> ActiveBundle {
            ActiveBundle(
                scope: scope, root: root, activationID: activationID,
                revision: revision + 1,
                expiresAt: expiresAt ?? now.addingTimeInterval(NativeIntake.recoveryWindow),
                photos: photos, voice: voice, recovery: .ready
            )
        }
    }

    private let durableAnchor: URL
    private let ephemeralAnchor: URL
    private let applicationSupportRoot: URL
    private let ephemeralRoots: URL
    private let ephemeralRoot: URL
    private let identitySource: IdentitySource
    private let fileManager: FileManager
    private let now: @Sendable () -> Date
    private let sleeper: @Sendable (Date) async throws -> Void
    /// Injected for the same reason as `now` and `sleeper`: the real one costs
    /// about 0.45s per 12 MP capture, and a test that has to observe what runs
    /// alongside it needs to say when it finishes rather than race it.
    private let bound: @Sendable (Data) -> Data
    private var active: ActiveBundle?
    private var observers: [UUID: AsyncStream<Event>.Continuation] = [:]
    private var operationSnapshots: [UUID: Snapshot] = [:]
    private var identityTask: Task<Void, Never>?
    private var retentionTask: Task<Void, Never>?
    private var reviewActivationID: UUID?
    private var anonymousIdentityUnavailable = false
    private var deletionRetryAfter: [URL: Date] = [:]
    private var terminalDeferredVoiceDeletionRoots = Set<URL>()

    init(
        applicationSupportDirectory: URL, identitySource: IdentitySource,
        fileManager: FileManager = .default,
        now: @escaping @Sendable () -> Date = { Date() },
        sleepUntil: @escaping @Sendable (Date) async throws -> Void = NativeIntake.sleepUntil,
        bound: @escaping @Sendable (Data) -> Data = CapturePhotoBudget.bound
    ) {
        durableAnchor = applicationSupportDirectory.standardizedFileURL
        let temporaryAnchor = fileManager.temporaryDirectory.standardizedFileURL
        ephemeralAnchor = temporaryAnchor
        applicationSupportRoot = durableAnchor.appendingPathComponent("SnapList", isDirectory: true)
            .appendingPathComponent("NativeIntake", isDirectory: true)
        ephemeralRoots = temporaryAnchor.appendingPathComponent("SnapList", isDirectory: true)
            .appendingPathComponent("NativeIntakeEphemeral", isDirectory: true)
        ephemeralRoot = ephemeralRoots.appendingPathComponent(
            "v1-\(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased())", isDirectory: true
        )
        self.identitySource = identitySource
        self.fileManager = fileManager
        self.now = now
        sleeper = sleepUntil
        self.bound = bound
    }

    deinit {
        identityTask?.cancel()
        retentionTask?.cancel()
        if (try? Self.validateContainedPath(ephemeralRoot, under: ephemeralAnchor, fileManager: fileManager)) != nil {
            try? fileManager.removeItem(at: ephemeralRoot)
        }
    }

    /// Deletes the actor's entire durable on-disk root. Unlike `discard(expected:)`,
    /// this does not require or update the in-memory `active` bundle, so it is only
    /// safe before any other actor method has observed state for this launch — the
    /// debug-only `--reset-capture-draft` launch flag calls it before
    /// `CaptureFlowModel.restore()` runs, guaranteeing a UI test starts from a clean
    /// draft regardless of what an earlier test in the same shard invocation staged
    /// through this same real, file-backed store and never tore down (#864).
    func discardAllForTesting() {
        guard fileManager.fileExists(atPath: applicationSupportRoot.path) else { return }
        try? fileManager.removeItem(at: applicationSupportRoot)
    }

    static func identitySource(
        verifiedClerkSubject: @escaping @Sendable () async -> String?,
        persistedAppAttestKey: @escaping @Sendable () -> AppAttestStoredKey?,
        changes: @escaping @Sendable () -> AsyncStream<Void>
    ) -> IdentitySource {
        IdentitySource(
            current: {
                Identity(
                    verifiedClerkSubject: await verifiedClerkSubject(),
                    persistedAppAttestKeyID: persistedAppAttestKey()?.id
                )
            },
            changes: changes,
            anonymousScopePersistence: .installation
        )
    }

    nonisolated static func sleepUntil(_ deadline: Date) async throws {
        let seconds = max(0, deadline.timeIntervalSinceNow)
        try await Task.sleep(for: .seconds(seconds))
    }

    func events() -> AsyncStream<Event> {
        let id = UUID()
        let pair = AsyncStream<Event>.makeStream()
        observers[id] = pair.continuation
        pair.continuation.onTermination = { [weak self] _ in
            Task {
                await self?.removeObserver(id)
            }
        }
        startIdentityObservation()
        if let active {
            pair.continuation.yield(.snapshot(active.snapshot))
        }
        return pair.stream
    }

    func perform(
        _ operation: Operation,
        expectedActivationID: UUID? = nil
    ) async -> Outcome {
        await perform(
            operation,
            expectedActivationID: expectedActivationID,
            snapshotKey: nil
        )
    }

    private func perform(
        _ operation: Operation,
        expectedActivationID: UUID?,
        snapshotKey: UUID?
    ) async -> Outcome {
        await activateIfNeeded()
        guard let active else {
            return .rejected(.storageFailure)
        }
        guard expectedActivationID == nil
                || expectedActivationID == active.activationID else {
            return .superseded
        }
        guard active.recovery == .ready else {
            return .rejected(.recoveryPending)
        }
        let expected = active.version

        switch operation {
        case .addPhotos(let inputs):
            guard !inputs.isEmpty else {
                return .unchanged
            }
            guard active.photos.count + inputs.count <= 5 else {
                return .rejected(.photoLimit)
            }
            let data: [(Data, LibraryPhotoTransferReceipt?)]
            do {
                data = try await load(inputs)
            } catch {
                return .rejected(.sourceUnavailable)
            }
            guard data.allSatisfy({ Self.isJPEG($0.0) }) else {
                return .rejected(.invalidPhoto)
            }
            let staged: [Photo]
            let stagingRoot: URL
            do {
                (staged, stagingRoot) = try await stagePhotoData(data, for: active)
            } catch {
                return stagingFailure(expected: expected)
            }
            guard await inputsAreActive(inputs) else {
                removeStagingRoot(stagingRoot)
                return .superseded
            }
            return commitMutation(
                expected: expected,
                stagingRoot: stagingRoot,
                snapshotKey: snapshotKey
            ) {
                ($0.photos + staged, $0.voice)
            }
        case .replacePhoto(let id, let input):
            let data: (Data, LibraryPhotoTransferReceipt?)
            do {
                data = try await load(input)
            } catch {
                return .rejected(.sourceUnavailable)
            }
            guard Self.isJPEG(data.0) else {
                return .rejected(.invalidPhoto)
            }
            let staged: [Photo]
            let stagingRoot: URL
            do {
                (staged, stagingRoot) = try await stagePhotoData([data], for: active)
            } catch {
                return stagingFailure(expected: expected)
            }
            guard await input.isActive() else {
                removeStagingRoot(stagingRoot)
                return .superseded
            }
            return commitMutation(
                expected: expected,
                stagingRoot: stagingRoot,
                snapshotKey: snapshotKey
            ) { current in
                guard let replacement = staged.first,
                      let index = current.photos.firstIndex(where: { $0.id == id }) else {
                    return nil
                }
                var photos = current.photos
                photos[index] = replacement
                return (photos, current.voice)
            }
        case .removePhoto(let id):
            return commitMutation(
                expected: expected,
                snapshotKey: snapshotKey
            ) { current in
                guard current.photos.contains(where: { $0.id == id }) else {
                    return nil
                }
                return (current.photos.filter { $0.id != id }, current.voice)
            }
        case .reorderPhotos(let ids):
            guard ids != active.photos.map(\.id) else {
                recordSnapshot(active.snapshot, for: snapshotKey)
                return .unchanged
            }
            return commitMutation(
                expected: expected,
                snapshotKey: snapshotKey
            ) { current in
                let byID = Dictionary(uniqueKeysWithValues: current.photos.map { ($0.id, $0) })
                guard ids.count == current.photos.count,
                      Set(ids).count == ids.count,
                      ids.allSatisfy({ byID[$0] != nil }) else {
                    return nil
                }
                return (ids.compactMap { byID[$0] }, current.voice)
            }
        case .setVoice(let input):
            guard input.duration > 0,
                  input.duration <= VoiceNotePresentation.maximumDuration else {
                return .rejected(.invalidVoice)
            }
            guard await input.isActive() else {
                return .superseded
            }
            let data: Data
            do {
                data = try await input.loadData()
            } catch {
                return .rejected(.sourceUnavailable)
            }
            guard await input.isActive() else {
                return .superseded
            }
            let staged: Voice
            let stagingRoot: URL
            do {
                (staged, stagingRoot) = try await stageVoiceData(data, duration: input.duration, for: active)
            } catch {
                return stagingFailure(expected: expected)
            }
            guard await input.isActive() else {
                removeStagingRoot(stagingRoot)
                return .superseded
            }
            return commitMutation(
                expected: expected,
                stagingRoot: stagingRoot,
                snapshotKey: snapshotKey
            ) {
                ($0.photos, staged)
            }
        case .deleteVoice:
            guard active.voice != nil else {
                recordSnapshot(active.snapshot, for: snapshotKey)
                return .unchanged
            }
            return commitMutation(
                expected: expected,
                snapshotKey: snapshotKey
            ) {
                ($0.photos, nil)
            }
        case .photoReviewEntered(let activationID):
            guard activationID == active.activationID else {
                return .superseded
            }
            guard reviewActivationID != active.activationID else {
                return .unchanged
            }
            reviewActivationID = active.activationID
            return .committed
        case .photoReviewLeft(let activationID):
            guard activationID == active.activationID else {
                return .superseded
            }
            guard reviewActivationID == active.activationID else {
                return .unchanged
            }
            reviewActivationID = nil
            return .committed
        case .discard(let expected):
            return discard(expected: expected)
        case .retireAcceptedPhotos(
            let expected,
            let photoIDs,
            let preservingUnmatchedVoiceID
        ):
            return retireAcceptedPhotos(
                expected: expected,
                photoIDs: photoIDs,
                preservingUnmatchedVoiceID:
                    preservingUnmatchedVoiceID
            )
        }
    }

    /// Returns the snapshot produced by this exact operation before another actor
    /// transaction can run. Event consumers still project the same committed snapshot;
    /// this result only lets the initiating Photo Review transaction correlate its
    /// focus and announcement with its own durable write.
    func performReturningSnapshot(
        _ operation: Operation,
        expectedActivationID: UUID,
        while requestIsActive: @escaping @MainActor @Sendable () -> Bool = {
            true
        }
    ) async -> OperationResult {
        guard await requestIsActive() else {
            return OperationResult(outcome: .superseded, snapshot: nil)
        }
        let snapshotKey = UUID()
        let outcome = await perform(
            operation,
            expectedActivationID: expectedActivationID,
            snapshotKey: snapshotKey
        )
        return OperationResult(
            outcome: outcome,
            snapshot: operationSnapshots.removeValue(forKey: snapshotKey)
        )
    }

    private func startIdentityObservation() {
        guard identityTask == nil else {
            return
        }
        let changes = identitySource.changes()
        identityTask = Task { [weak self] in
            await self?.reconcileIdentity()
            for await _ in changes {
                guard !Task.isCancelled else {
                    return
                }
                await self?.reconcileIdentity()
            }
        }
    }

    private func activateIfNeeded() async {
        startIdentityObservation()
        if active == nil {
            await reconcileIdentity()
        }
    }

    private func reconcileIdentity() async {
        let identity = await identitySource.current()
        let nextScope: Scope?
        do {
            nextScope = try resolveScope(identity)
        } catch {
            let shouldDismissReview =
                reviewActivationID != nil
                && reviewActivationID == active?.activationID
            reviewActivationID = nil
            anonymousIdentityUnavailable = true
            let unavailable = blankBundle(
                scope: nil,
                root: ephemeralRoot,
                activationID: UUID(),
                recovery: .pending
            )
            active = unavailable
            if shouldDismissReview {
                publish(.dismissActivePhotoReview)
            }
            publish(.snapshot(unavailable.snapshot))
            rescheduleRetention()
            return
        }
        let wasAnonymousIdentityUnavailable = anonymousIdentityUnavailable
        anonymousIdentityUnavailable = false
        if let active,
           active.scope == nextScope,
           !wasAnonymousIdentityUnavailable {
            return
        }
        let shouldDismissReview = reviewActivationID != nil && reviewActivationID == active?.activationID
        reviewActivationID = nil
        let root = nextScope.map {
            applicationSupportRoot.appendingPathComponent($0.directoryComponent, isDirectory: true)
        } ?? ephemeralRoot
        active = loadBundle(scope: nextScope, root: root, activationID: UUID())
        if shouldDismissReview {
            publish(.dismissActivePhotoReview)
        }
        publish(.snapshot(active!.snapshot))
        rescheduleRetention()
    }

    private func resolveScope(_ identity: Identity) throws -> Scope? {
        let authenticated = Self.usable(identity.verifiedClerkSubject)
        let guest = Self.usable(identity.persistedAppAttestKeyID)
        let taggedIdentity = authenticated.map { ("clerk-subject", $0) }
            ?? guest.map { ("app-attest-key-id", $0) }
        if let (tag, value) = taggedIdentity {
            return Self.scope(tag: tag, value: value)
        }
        switch identitySource.anonymousScopePersistence {
        case .processPrivate:
            return nil
        case .installation:
            let identity = try loadOrCreateAnonymousInstallationIdentity()
            return Self.scope(
                tag: "anonymous-installation-id",
                value: identity.id.uuidString.lowercased()
            )
        }
    }

    private static func scope(tag: String, value: String) -> Scope {
        let tagged = ["dev.snaplist.native-intake-principal", "v1", tag, value]
            .joined(separator: "\u{0}")
        let digest = SHA256.hash(data: Data(tagged.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
        return Scope(directoryComponent: "v1-\(digest)")
    }

    private func loadOrCreateAnonymousInstallationIdentity() throws
        -> AnonymousInstallationIdentity {
        try Self.prepareRoot(
            applicationSupportRoot,
            under: durableAnchor,
            fileManager: fileManager
        )
        let url = applicationSupportRoot.appendingPathComponent(
            "anonymous-installation-v1.json"
        )
        if let existing = try readAnonymousInstallationIdentity(at: url) {
            try Self.protect(url, fileManager: fileManager)
            return existing
        }

        let created = AnonymousInstallationIdentity(
            schemaVersion: 1,
            id: UUID()
        )
        let data = try JSONEncoder().encode(created)
        let pendingURL = applicationSupportRoot.appendingPathComponent(
            ".anonymous-installation-\(UUID().uuidString).pending"
        )
        try Self.write(
            data,
            to: pendingURL,
            under: durableAnchor,
            fileManager: fileManager
        )
        defer {
            Self.removeIfContained(
                pendingURL,
                under: durableAnchor,
                fileManager: fileManager
            )
        }
        do {
            try Self.validateContainedPath(
                url,
                under: durableAnchor,
                fileManager: fileManager
            )
            try fileManager.linkItem(at: pendingURL, to: url)
            try Self.protect(url, fileManager: fileManager)
            return created
        } catch {
            guard Self.isFileAlreadyPresent(error),
                  let existing = try readAnonymousInstallationIdentity(
                    at: url
                  ) else {
                throw error
            }
            try Self.protect(url, fileManager: fileManager)
            return existing
        }
    }

    private func readAnonymousInstallationIdentity(
        at url: URL
    ) throws -> AnonymousInstallationIdentity? {
        do {
            try Self.validateContainedPath(
                url,
                under: durableAnchor,
                fileManager: fileManager
            )
            let data = try Data(contentsOf: url)
            let identity = try JSONDecoder().decode(
                AnonymousInstallationIdentity.self,
                from: data
            )
            guard identity.schemaVersion == 1 else {
                throw CocoaError(.fileReadCorruptFile)
            }
            return identity
        } catch {
            guard Self.isMissing(error) else {
                throw error
            }
            return nil
        }
    }

    private static func usable(_ value: String?) -> String? {
        guard let value, !value.isEmpty else {
            return nil
        }
        return value
    }

    private func load(_ inputs: [PhotoInput])
        async throws -> [(Data, LibraryPhotoTransferReceipt?)] {
        var data: [(Data, LibraryPhotoTransferReceipt?)] = []
        data.reserveCapacity(inputs.count)
        for input in inputs {
            data.append(try await load(input))
        }
        return data
    }

    private func load(_ input: PhotoInput) async throws
        -> (Data, LibraryPhotoTransferReceipt?) {
        guard let bytes = try await input.loadData(),
              input.libraryTransferReceipt?.matchesTransferredPhoto(bytes) != false else {
            throw CocoaError(.fileReadCorruptFile)
        }
        return (bytes, input.libraryTransferReceipt)
    }

    private func commitMutation(
        expected: Version,
        stagingRoot: URL? = nil,
        snapshotKey: UUID? = nil,
        change: (ActiveBundle) -> ([Photo], Voice?)?
    ) -> Outcome {
        guard let current = active, current.version == expected else {
            removeStagingRoot(stagingRoot)
            return .superseded
        }
        guard let (photos, voice) = change(current) else {
            removeStagingRoot(stagingRoot)
            return .rejected(.invalidOperation)
        }
        do {
            let next = current.next(photos: photos, voice: voice, now: now())
            try commit(next, stagingRoot: stagingRoot)
            active = next
            recordSnapshot(next.snapshot, for: snapshotKey)
            publish(.snapshot(next.snapshot))
            rescheduleRetention()
            return .committed
        } catch {
            removeStagingRoot(stagingRoot)
            return .rejected(.storageFailure)
        }
    }

    /// Bounds captured bytes to what the upload can carry, before they are
    /// staged rather than after.
    ///
    /// Staging is the right moment for two reasons. The bounded bytes are what
    /// the submission sends and what its fingerprint is computed over, so a
    /// retry re-reads one settled file instead of re-encoding and risking a
    /// different identity. And camera capture, library import, add, and replace
    /// all converge here, so none of them can route around the budget.
    ///
    /// The library transfer receipt already matched the original bytes back in
    /// `load(_:)`, so re-encoding after that point cannot invalidate it.
    ///
    /// This adds no rejection path: `CapturePhotoBudget.bound` returns bytes for
    /// every input, so a photo that reaches here still reaches staging.
    ///
    /// Called from inside `stagePhotoData`'s detached task rather than from the
    /// actor. It costs about 0.45s per 12 MP capture, and the actor is the one
    /// thing every other intake operation has to go through; 2.27s of a
    /// five-photo add spent holding it is 2.27s the seller cannot remove a
    /// photo, read the set back, or start the next capture (#789 item 6). It
    /// joins the write that was already detached instead of taking a hop of its
    /// own, so `perform` keeps exactly the suspension points it had — one
    /// `await` spanning bound-then-stage, with the same `expected` version
    /// re-checked in `commitMutation` on the far side of it.
    ///
    /// Nothing here reads or writes actor state — it is a `map` over its
    /// argument — so leaving the actor costs no invariant, and the order it
    /// returns is the order it was given.
    private nonisolated static func boundToTransportBudget(
        _ data: [(Data, LibraryPhotoTransferReceipt?)],
        bound: @Sendable (Data) -> Data
    ) -> [(Data, LibraryPhotoTransferReceipt?)] {
        data.map { (bound($0.0), $0.1) }
    }

    private func stagingFailure(expected: Version) -> Outcome {
        active?.version == expected ? .rejected(.storageFailure) : .superseded
    }

    private func inputsAreActive(_ inputs: [PhotoInput]) async -> Bool {
        for input in inputs where !(await input.isActive()) {
            return false
        }
        return true
    }

    private func recordSnapshot(_ snapshot: Snapshot, for key: UUID?) {
        guard let key else { return }
        operationSnapshots[key] = snapshot
    }

    private func stagingLocations(for bundle: ActiveBundle)
        throws -> (root: URL, assets: URL, published: URL, anchor: URL) {
        try prepareEphemeralRootIfNeeded(for: bundle)
        let stagingRoot = makeStagingRoot(for: bundle)
        return (
            stagingRoot,
            stagingRoot.appendingPathComponent("Assets", isDirectory: true),
            bundle.assetsRoot,
            storageAnchor(for: bundle)
        )
    }

    private func prepareEphemeralRootIfNeeded(for bundle: ActiveBundle) throws {
        guard bundle.scope == nil else {
            return
        }
        let markerURL = bundle.root.appendingPathComponent(".native-intake-v1")
        if fileManager.fileExists(atPath: markerURL.path) {
            try Self.validateContainedPath(markerURL, under: ephemeralAnchor, fileManager: fileManager)
            return
        }
        try Self.prepareRoot(bundle.root, under: ephemeralAnchor, fileManager: fileManager)
        let marker = EphemeralMarker(schemaVersion: 1, createdAt: now())
        try Self.write(
            JSONEncoder().encode(marker),
            to: markerURL,
            under: ephemeralAnchor,
            fileManager: fileManager
        )
    }

    private func stagePhotoData(_ data: [(Data, LibraryPhotoTransferReceipt?)],
                                for bundle: ActiveBundle) async throws -> ([Photo], URL) {
        let locations = try stagingLocations(for: bundle)
        let createdAt = now()
        let fileManager = fileManager
        let bound = bound
        let photos = try await Task.detached {
            try Self.stagePhotos(
                Self.boundToTransportBudget(data, bound: bound),
                in: locations.assets,
                publishingIn: locations.published,
                under: locations.anchor,
                createdAt: createdAt,
                fileManager: fileManager
            )
        }.value
        return (photos, locations.root)
    }

    private func stageVoiceData(_ data: Data, duration: TimeInterval,
                                for bundle: ActiveBundle) async throws -> (Voice, URL) {
        let locations = try stagingLocations(for: bundle)
        let fileManager = fileManager
        let voice = try await Task.detached {
            try Self.stageVoice(
                data,
                duration: duration,
                in: locations.assets,
                publishingIn: locations.published,
                under: locations.anchor,
                fileManager: fileManager
            )
        }.value
        return (voice, locations.root)
    }

    private nonisolated static func stagePhotos(
        _ data: [(Data, LibraryPhotoTransferReceipt?)],
        in assetsRoot: URL,
        publishingIn publishedAssetsRoot: URL,
        under anchor: URL,
        createdAt: Date,
        fileManager: FileManager
    ) throws -> [Photo] {
        let stagingRoot = assetsRoot.deletingLastPathComponent()
        var succeeded = false
        defer {
            if !succeeded {
                removeIfContained(stagingRoot, under: anchor, fileManager: fileManager)
            }
        }
        try prepareStagingRoot(
            stagingRoot, assetsRoot: assetsRoot, under: anchor, fileManager: fileManager
        )
        var photos: [Photo] = []
        for (bytes, receipt) in data {
            let id = UUID()
            let mediaName = "photo-\(id.uuidString).jpg"
            let thumbnailName = "thumbnail-\(id.uuidString).jpg"
            try write(bytes, to: assetsRoot.appendingPathComponent(mediaName),
                      under: anchor, fileManager: fileManager)
            try write(bytes, to: assetsRoot.appendingPathComponent(thumbnailName),
                      under: anchor, fileManager: fileManager)
            photos.append(
                Photo(
                    id: id,
                    photoURL: publishedAssetsRoot.appendingPathComponent(mediaName),
                    thumbnailURL: publishedAssetsRoot.appendingPathComponent(thumbnailName),
                    createdAt: createdAt,
                    libraryTransferReceipt: receipt
                )
            )
        }
        succeeded = true
        return photos
    }

    private nonisolated static func stageVoice(
        _ data: Data,
        duration: TimeInterval,
        in assetsRoot: URL,
        publishingIn publishedAssetsRoot: URL,
        under anchor: URL,
        fileManager: FileManager
    ) throws -> Voice {
        let stagingRoot = assetsRoot.deletingLastPathComponent()
        var succeeded = false
        defer {
            if !succeeded {
                removeIfContained(stagingRoot, under: anchor, fileManager: fileManager)
            }
        }
        try prepareStagingRoot(
            stagingRoot, assetsRoot: assetsRoot, under: anchor, fileManager: fileManager
        )
        let id = UUID()
        let name = "voice-\(id.uuidString).wav"
        let stagedURL = assetsRoot.appendingPathComponent(name)
        try write(data, to: stagedURL, under: anchor, fileManager: fileManager)
        succeeded = true
        return Voice(id: id, mediaURL: publishedAssetsRoot.appendingPathComponent(name),
                     duration: duration)
    }

    private func commit(_ bundle: ActiveBundle, stagingRoot suppliedStagingRoot: URL?) throws {
        let anchor = storageAnchor(for: bundle)
        let stagingRoot = suppliedStagingRoot ?? makeStagingRoot(for: bundle)
        let stagingAssetsRoot = stagingRoot.appendingPathComponent("Assets", isDirectory: true)
        defer {
            Self.removeIfContained(stagingRoot, under: anchor, fileManager: fileManager)
        }
        try Self.prepareStagingRoot(
            stagingRoot, assetsRoot: stagingAssetsRoot, under: anchor, fileManager: fileManager
        )
        try copyRetainedAssets(for: bundle, to: stagingAssetsRoot, under: anchor)
        let stored = StoredBundle(
            schemaVersion: 1, revision: bundle.revision, expiresAt: bundle.expiresAt!,
            photos: bundle.photos, voice: bundle.voice
        )
        let data = try JSONEncoder().encode(stored)
        let manifestURL = stagingRoot.appendingPathComponent("bundle.json")
        try Self.write(data, to: manifestURL, under: anchor, fileManager: fileManager)
        let currentRoot = bundle.root.appendingPathComponent("Current", isDirectory: true)
        try Self.publish(stagingRoot, as: currentRoot, under: anchor, fileManager: fileManager)
    }

    private func copyRetainedAssets(
        for bundle: ActiveBundle,
        to stagingAssetsRoot: URL,
        under anchor: URL
    ) throws {
        let retained = Self.assetURLs(for: bundle.photos)
            + [bundle.voice?.mediaURL].compactMap { $0 }
        for source in retained {
            let destination = stagingAssetsRoot.appendingPathComponent(source.lastPathComponent)
            try Self.validateContainedPath(destination, under: anchor, fileManager: fileManager)
            if fileManager.fileExists(atPath: destination.path) {
                continue
            }
            try Self.validateContainedPath(source, under: anchor, fileManager: fileManager)
            try fileManager.copyItem(at: source, to: destination)
            try Self.protect(destination, fileManager: fileManager)
        }
    }

    private func makeStagingRoot(for bundle: ActiveBundle) -> URL {
        bundle.root
            .appendingPathComponent("Staging", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
    }

    private func removeStagingRoot(_ root: URL?) {
        guard let root, let anchor = storageAnchor(containing: root) else {
            return
        }
        Self.removeIfContained(root, under: anchor, fileManager: fileManager)
    }

    private func cleanupStaging(at root: URL) -> Bool {
        guard let anchor = storageAnchor(containing: root) else {
            return false
        }
        let stagingRoot = root.appendingPathComponent("Staging", isDirectory: true)
        do {
            try Self.validateContainedPath(stagingRoot, under: anchor, fileManager: fileManager)
            try fileManager.removeItem(at: stagingRoot)
            return true
        } catch {
            return Self.isMissing(error)
        }
    }

    private func discard(expected: Version) -> Outcome {
        guard let current = active, current.version == expected else {
            return .superseded
        }
        guard removeOwnedRoot(current.root) else {
            return .rejected(.storageFailure)
        }
        let next = ActiveBundle(
            scope: current.scope, root: current.root, activationID: current.activationID,
            revision: current.revision + 1, expiresAt: nil, photos: [], voice: nil, recovery: .ready
        )
        active = next
        publish(.snapshot(next.snapshot))
        rescheduleRetention()
        return .committed
    }

    private func retireAcceptedPhotos(
        expected: Version,
        photoIDs: [Photo.ID],
        preservingUnmatchedVoiceID: Voice.ID
    ) -> Outcome {
        guard let current = active,
              current.version == expected else {
            return .superseded
        }
        guard current.photos.map(\.id) == photoIDs,
              let voice = current.voice,
              voice.id == preservingUnmatchedVoiceID,
              let expiresAt = current.expiresAt else {
            return .rejected(.invalidOperation)
        }
        do {
            try persistDeferredUnmatchedVoice(
                voice,
                expiresAt: expiresAt,
                in: current
            )
            let currentRoot = current.root.appendingPathComponent(
                "Current",
                isDirectory: true
            )
            let anchor = storageAnchor(for: current)
            try Self.validateContainedPath(
                currentRoot,
                under: anchor,
                fileManager: fileManager
            )
            try fileManager.removeItem(at: currentRoot)
        } catch {
            return .rejected(.storageFailure)
        }

        let next = ActiveBundle(
            scope: current.scope,
            root: current.root,
            activationID: current.activationID,
            revision: current.revision + 1,
            expiresAt: nil,
            photos: [],
            voice: nil,
            recovery: .ready
        )
        active = next
        publish(.snapshot(next.snapshot))
        rescheduleRetention()
        return .committed
    }

    private func persistDeferredUnmatchedVoice(
        _ voice: Voice,
        expiresAt: Date,
        in bundle: ActiveBundle
    ) throws {
        let entryRoot = deferredUnmatchedVoiceEntryRoot(
            for: voice.id,
            in: bundle.root
        )
        let deferredVoiceURL = entryRoot.appendingPathComponent(
            voice.mediaURL.lastPathComponent
        )
        let expected = DeferredUnmatchedVoice(
            schemaVersion: 1,
            expiresAt: expiresAt,
            voice: Voice(
                id: voice.id,
                mediaURL: deferredVoiceURL,
                duration: voice.duration
            )
        )
        switch readDeferredUnmatchedVoice(at: entryRoot) {
        case .value(let existing):
            guard existing.value == expected else {
                throw CocoaError(.fileWriteFileExists)
            }
            return
        case .transient:
            throw CocoaError(.fileReadUnknown)
        case .malformed:
            throw CocoaError(.fileReadCorruptFile)
        case .absent:
            break
        }

        let anchor = storageAnchor(for: bundle)
        let container = deferredUnmatchedVoicesRoot(in: bundle.root)
        try Self.prepareRoot(
            container,
            under: anchor,
            fileManager: fileManager
        )
        let stagingRoot = makeStagingRoot(for: bundle)
        defer {
            Self.removeIfContained(
                stagingRoot,
                under: anchor,
                fileManager: fileManager
            )
        }
        try Self.prepareRoot(
            stagingRoot,
            under: anchor,
            fileManager: fileManager
        )
        let stagedVoiceURL = stagingRoot.appendingPathComponent(
            voice.mediaURL.lastPathComponent
        )
        try Self.validateContainedPath(
            voice.mediaURL,
            under: anchor,
            fileManager: fileManager
        )
        try fileManager.copyItem(at: voice.mediaURL, to: stagedVoiceURL)
        try Self.protect(stagedVoiceURL, fileManager: fileManager)
        try Self.write(
            JSONEncoder().encode(expected),
            to: stagingRoot.appendingPathComponent("entry.json"),
            under: anchor,
            fileManager: fileManager
        )
        try Self.validateContainedPath(
            entryRoot,
            under: anchor,
            fileManager: fileManager
        )
        try fileManager.moveItem(at: stagingRoot, to: entryRoot)
    }

    private func deferredUnmatchedVoicesRoot(in principalRoot: URL) -> URL {
        principalRoot.appendingPathComponent(
            "DeferredUnmatchedVoices",
            isDirectory: true
        )
    }

    private func deferredUnmatchedVoiceEntryRoot(
        for voiceID: Voice.ID,
        in principalRoot: URL
    ) -> URL {
        deferredUnmatchedVoicesRoot(in: principalRoot)
            .appendingPathComponent(
                voiceID.uuidString.lowercased(),
                isDirectory: true
            )
    }

    private func readDeferredUnmatchedVoice(
        at entryRoot: URL
    ) -> ReadResult<DeferredUnmatchedVoiceRecord> {
        guard let anchor = storageAnchor(containing: entryRoot) else {
            return .malformed
        }
        do {
            try Self.validateContainedPath(
                entryRoot,
                under: anchor,
                fileManager: fileManager
            )
            _ = try fileManager.attributesOfItem(atPath: entryRoot.path)
        } catch {
            return Self.isMissing(error) ? .absent : .transient
        }
        guard let voiceID = UUID(uuidString: entryRoot.lastPathComponent),
              entryRoot.lastPathComponent
                == voiceID.uuidString.lowercased() else {
            return .malformed
        }
        let metadataURL = entryRoot.appendingPathComponent("entry.json")
        do {
            try Self.validateContainedPath(
                metadataURL,
                under: anchor,
                fileManager: fileManager
            )
            let value = try JSONDecoder().decode(
                DeferredUnmatchedVoice.self,
                from: Data(contentsOf: metadataURL)
            )
            let expectedVoiceURL = entryRoot.appendingPathComponent(
                "voice-\(voiceID.uuidString).wav"
            )
            guard value.schemaVersion == 1,
                  value.voice.id == voiceID,
                  value.voice.mediaURL.standardizedFileURL
                    == expectedVoiceURL.standardizedFileURL,
                  value.voice.duration > 0,
                  value.voice.duration
                    <= VoiceNotePresentation.maximumDuration else {
                return .malformed
            }
            try Self.validateContainedPath(
                expectedVoiceURL,
                under: anchor,
                fileManager: fileManager
            )
            _ = try fileManager.attributesOfItem(
                atPath: expectedVoiceURL.path
            )
            return .value(
                DeferredUnmatchedVoiceRecord(
                    root: entryRoot,
                    value: value
                )
            )
        } catch {
            // A missing entry.json or voice file is malformed rather than
            // absent, which is why this cannot agree with the catch above it.
            // That one covers the entry directory itself vanishing, leaving
            // nothing behind to protect. This one covers an entry that still
            // exists but no longer describes a deferred voice, and calling
            // that absent would tell the retention sweep there is nothing
            // here while an orphaned voice file may still sit inside it.
            return Self.isMissing(error) ? .malformed : .transient
        }
    }

    /// One principal's deferred unmatched voices, split by whether they can
    /// still be read. An unreadable entry keeps its own list because it is
    /// storage the sweep must resolve but not a voice any caller can use.
    private struct DeferredUnmatchedVoiceListing {
        var records: [DeferredUnmatchedVoiceRecord] = []
        var unreadableRoots: [URL] = []
    }

    private func deferredUnmatchedVoices(
        in principalRoot: URL,
        excluding terminalDeletionRoots: Set<URL> = []
    ) -> ReadResult<DeferredUnmatchedVoiceListing> {
        let container = deferredUnmatchedVoicesRoot(in: principalRoot)
        guard let anchor = storageAnchor(containing: container) else {
            return .malformed
        }
        let entryRoots: [URL]
        do {
            try Self.validateContainedPath(
                container,
                under: anchor,
                fileManager: fileManager
            )
            entryRoots = try fileManager.contentsOfDirectory(
                at: container,
                includingPropertiesForKeys: nil
            )
        } catch {
            return Self.isMissing(error) ? .absent : .transient
        }
        var listing = DeferredUnmatchedVoiceListing()
        listing.records.reserveCapacity(entryRoots.count)
        for entryRoot in entryRoots {
            guard !terminalDeletionRoots.contains(
                entryRoot.standardizedFileURL
            ) else {
                continue
            }
            switch readDeferredUnmatchedVoice(at: entryRoot) {
            case .value(let record):
                listing.records.append(record)
            case .absent:
                // The entry vanished between the listing and the read, so it
                // holds no protected bytes and must not stall its siblings.
                continue
            case .malformed:
                // The entry is still on disk but cannot be read back, so it
                // must not stall its siblings either. It is reported rather
                // than skipped because it may still hold voice bytes, and
                // only the sweep can decide what becomes of them.
                listing.unreadableRoots.append(entryRoot)
            case .transient:
                // A per-entry I/O failure cannot collapse the whole store.
                // Its metadata may never become readable (for example after
                // bit rot), so retention gives the entry the same terminal
                // cleanup disposition as other unreadable entries instead of
                // re-arming a container-wide retry forever.
                listing.unreadableRoots.append(entryRoot)
            }
        }
        return .value(listing)
    }

    /// Reports whether a principal root still holds deferred unmatched voices.
    /// Only a positive read — an empty listing, or no store at all — settles
    /// the question; `whenUncertain` decides the rest, and callers must pass
    /// whichever answer is safe for what they are about to do. Destroying a
    /// root is safe only when voices can be ruled out, so those callers pass
    /// `true`; presenting a root as a voice-only residual is safe only when
    /// voices are known to be there, so that caller passes `false`.
    private func deferredUnmatchedVoicesPresent(
        in principalRoot: URL,
        whenUncertain: Bool
    ) -> Bool {
        let terminalRoots = terminalDeferredVoiceDeletionRoots.filter {
            Self.isContained($0, under: principalRoot)
        }
        switch deferredUnmatchedVoices(
            in: principalRoot,
            excluding: terminalDeferredVoiceDeletionRoots
        ) {
        case .value(let listing):
            // An unreadable entry counts as present. Its bytes are real even
            // though its metadata is not, so a root holding one has not been
            // ruled clear of voices and must not be destroyed as if it had.
            return !listing.records.isEmpty
                || !listing.unreadableRoots.isEmpty
                || !terminalRoots.isEmpty
        case .absent:
            return !terminalRoots.isEmpty
        case .transient, .malformed:
            return whenUncertain || !terminalRoots.isEmpty
        }
    }

    private func currentBundleIsAbsent(in principalRoot: URL) -> Bool {
        let currentRoot = principalRoot.appendingPathComponent(
            "Current",
            isDirectory: true
        )
        do {
            _ = try fileManager.attributesOfItem(atPath: currentRoot.path)
            return false
        } catch {
            return Self.isMissing(error)
        }
    }

    private func rescheduleRetention() {
        retentionTask?.cancel()
        guard let deadline = nearestRetentionDeadline() else {
            retentionTask = nil
            return
        }
        let sleeper = sleeper
        retentionTask = Task { [weak self] in
            do {
                try await sleeper(deadline)
            } catch {
                return
            }
            guard !Task.isCancelled else {
                return
            }
            await self?.retentionDeadlineReached()
        }
    }

    private func nearestRetentionDeadline() -> Date? {
        var deadlines: [Date] = []
        if let active {
            if active.recovery == .pending {
                deadlines.append(now().addingTimeInterval(Self.retentionRetryInterval))
            } else if let expiresAt = active.expiresAt {
                deadlines.append(deletionRetryAfter[active.root] ?? expiresAt)
            }
        }
        let durableRoots = ownedDurableRoots()
        switch durableRoots {
        case .value(let roots):
            for root in roots where root != active?.root {
                switch readStoredBundle(at: root) {
                case .value(let stored):
                    deadlines.append(deletionRetryAfter[root] ?? stored.expiresAt)
                case .malformed:
                    if !deferredUnmatchedVoicesPresent(
                        in: root,
                        whenUncertain: true
                    ) {
                        deadlines.append(
                            deletionRetryAfter[root] ?? now()
                        )
                    }
                case .transient:
                    deadlines.append(now().addingTimeInterval(Self.retentionRetryInterval))
                case .absent:
                    break
                }
            }
        case .transient:
            deadlines.append(now().addingTimeInterval(Self.retentionRetryInterval))
        case .absent, .malformed:
            break
        }
        let ephemeralRoots = ownedEphemeralRoots()
        switch ephemeralRoots {
        case .value(let roots):
            for root in roots where root != active?.root {
                switch readEphemeralExpiry(at: root) {
                case .value(let expiresAt):
                    deadlines.append(deletionRetryAfter[root] ?? expiresAt)
                case .transient:
                    deadlines.append(now().addingTimeInterval(Self.retentionRetryInterval))
                case .absent, .malformed:
                    deadlines.append(deletionRetryAfter[root] ?? now())
                }
            }
        case .transient:
            deadlines.append(now().addingTimeInterval(Self.retentionRetryInterval))
        case .absent, .malformed:
            break
        }
        appendDeferredUnmatchedVoiceDeadlines(
            in: durableRoots,
            to: &deadlines
        )
        appendDeferredUnmatchedVoiceDeadlines(
            in: ephemeralRoots,
            to: &deadlines
        )
        deadlines.append(
            contentsOf: terminalDeferredVoiceDeletionRoots.map {
                deletionRetryAfter[$0] ?? now()
            }
        )
        return deadlines.min()
    }

    private func appendDeferredUnmatchedVoiceDeadlines(
        in roots: ReadResult<[URL]>,
        to deadlines: inout [Date]
    ) {
        switch roots {
        case .value(let roots):
            for root in roots {
                switch deferredUnmatchedVoices(
                    in: root,
                    excluding: terminalDeferredVoiceDeletionRoots
                ) {
                case .value(let listing):
                    deadlines.append(
                        contentsOf: listing.records.map {
                            deletionRetryAfter[$0.root]
                                ?? $0.value.expiresAt
                        }
                    )
                    // An unreadable entry has no deadline to read, so it is
                    // due immediately and the retry interval bounds it only
                    // once a removal has already failed.
                    deadlines.append(
                        contentsOf: listing.unreadableRoots.map {
                            deletionRetryAfter[$0] ?? now()
                        }
                    )
                case .transient, .malformed:
                    deadlines.append(
                        now().addingTimeInterval(
                            Self.retentionRetryInterval
                        )
                    )
                case .absent:
                    break
                }
            }
        case .transient:
            deadlines.append(
                now().addingTimeInterval(Self.retentionRetryInterval)
            )
        case .absent, .malformed:
            break
        }
    }

    private func retentionDeadlineReached() async {
        if anonymousIdentityUnavailable {
            await reconcileIdentity()
            return
        }
        let currentTime = now()
        if let current = active, current.recovery == .pending {
            let recovered = loadBundle(
                scope: current.scope,
                root: current.root,
                activationID: current.activationID
            )
            if recovered.recovery == .ready {
                active = recovered
                publish(.snapshot(recovered.snapshot))
            }
        } else if let current = active,
                  let expiresAt = current.expiresAt,
                  expiresAt <= currentTime {
            if removeExpiredRoot(current.root, at: currentTime) {
                let expired = ActiveBundle(
                    scope: current.scope, root: current.root, activationID: current.activationID,
                    revision: current.revision + 1, expiresAt: nil, photos: [], voice: nil, recovery: .ready
                )
                active = expired
                publish(.snapshot(expired.snapshot))
            }
        }
        cleanupExpiredDeferredUnmatchedVoices(at: currentTime)
        cleanupInactiveRoots(expiredAt: currentTime)
        rescheduleRetention()
    }

    private func cleanupExpiredDeferredUnmatchedVoices(
        at currentTime: Date
    ) {
        cleanupTerminalDeferredUnmatchedVoiceDeletions(at: currentTime)
        for roots in [ownedDurableRoots(), ownedEphemeralRoots()] {
            guard case .value(let roots) = roots else { continue }
            for root in roots {
                guard case .value(let listing) =
                    deferredUnmatchedVoices(
                        in: root,
                        excluding: terminalDeferredVoiceDeletionRoots
                    ) else {
                    continue
                }
                let expired = listing.records
                    .filter { $0.value.expiresAt <= currentTime }
                    .map(\.root)
                for entryRoot in expired {
                    let removed = removeDeferredUnmatchedVoiceEntry(
                        at: entryRoot
                    )
                    deletionRetryAfter[entryRoot] = removed
                        ? nil
                        : currentTime.addingTimeInterval(
                            Self.retentionRetryInterval
                        )
                }
                for entryRoot in listing.unreadableRoots {
                    terminalDeferredVoiceDeletionRoots.insert(entryRoot)
                    removeTerminalDeferredUnmatchedVoiceEntry(
                        at: entryRoot,
                        currentTime: currentTime
                    )
                }
            }
        }
    }

    private func cleanupTerminalDeferredUnmatchedVoiceDeletions(
        at currentTime: Date
    ) {
        for entryRoot in Array(terminalDeferredVoiceDeletionRoots) {
            guard (deletionRetryAfter[entryRoot] ?? currentTime) <= currentTime
            else {
                continue
            }
            removeTerminalDeferredUnmatchedVoiceEntry(
                at: entryRoot,
                currentTime: currentTime
            )
        }
    }

    private func removeTerminalDeferredUnmatchedVoiceEntry(
        at entryRoot: URL,
        currentTime: Date
    ) {
        let removed = removeDeferredUnmatchedVoiceEntry(at: entryRoot)
        if removed {
            terminalDeferredVoiceDeletionRoots.remove(entryRoot)
            deletionRetryAfter[entryRoot] = nil
        } else {
            deletionRetryAfter[entryRoot] = currentTime.addingTimeInterval(
                Self.retentionRetryInterval
            )
        }
    }

    private func removeDeferredUnmatchedVoiceEntry(at root: URL) -> Bool {
        guard let anchor = storageAnchor(containing: root) else {
            return false
        }
        do {
            try Self.validateContainedPath(
                root,
                under: anchor,
                fileManager: fileManager
            )
            try fileManager.removeItem(at: root)
            return true
        } catch {
            return Self.isMissing(error)
        }
    }

    private func cleanupInactiveRoots(expiredAt currentTime: Date) {
        if case .value(let roots) = ownedDurableRoots() {
            for root in roots where root != active?.root {
                switch readStoredBundle(at: root) {
                case .value(let stored) where stored.expiresAt <= currentTime:
                    _ = removeExpiredRoot(root, at: currentTime)
                case .malformed:
                    if !deferredUnmatchedVoicesPresent(
                        in: root,
                        whenUncertain: true
                    ) {
                        _ = removeExpiredRoot(root, at: currentTime)
                    }
                case .value, .absent, .transient:
                    break
                }
            }
        }
        if case .value(let ephemeral) = ownedEphemeralRoots() {
            for root in ephemeral where root != active?.root {
                switch readEphemeralExpiry(at: root) {
                case .value(let expiresAt) where expiresAt <= currentTime:
                    _ = removeExpiredRoot(root, at: currentTime)
                case .absent, .malformed:
                    _ = removeExpiredRoot(root, at: currentTime)
                case .value, .transient:
                    break
                }
            }
        }
    }

    private func removeExpiredRoot(_ root: URL, at currentTime: Date) -> Bool {
        let removed = removeOwnedRoot(root)
        deletionRetryAfter[root] = removed
            ? nil
            : currentTime.addingTimeInterval(Self.retentionRetryInterval)
        return removed
    }

    private func ownedDurableRoots() -> ReadResult<[URL]> {
        ownedRoots(at: applicationSupportRoot, under: durableAnchor,
                   matching: Self.isOwnedScopeComponent)
    }

    private func ownedEphemeralRoots() -> ReadResult<[URL]> {
        ownedRoots(at: ephemeralRoots, under: ephemeralAnchor,
                   matching: Self.isOwnedEphemeralComponent)
    }

    private func ownedRoots(
        at root: URL,
        under anchor: URL,
        matching predicate: (String) -> Bool
    ) -> ReadResult<[URL]> {
        do {
            try Self.validateContainedPath(root, under: anchor, fileManager: fileManager)
            return .value(
                try fileManager.contentsOfDirectory(
                    at: root, includingPropertiesForKeys: nil
                ).filter {
                    predicate($0.lastPathComponent)
                }
            )
        } catch {
            return Self.isMissing(error) ? .absent : .transient
        }
    }

    private func loadBundle(
        scope: Scope?,
        root: URL,
        activationID: UUID
    ) -> ActiveBundle {
        guard cleanupStaging(at: root) else {
            return blankBundle(scope: scope, root: root, activationID: activationID, recovery: .pending)
        }
        let stored: StoredBundle
        switch readStoredBundle(at: root) {
        case .absent:
            return blankBundle(scope: scope, root: root, activationID: activationID, recovery: .ready)
        case .malformed:
            if currentBundleIsAbsent(in: root),
               deferredUnmatchedVoicesPresent(in: root, whenUncertain: false) {
                return blankBundle(
                    scope: scope,
                    root: root,
                    activationID: activationID,
                    recovery: .ready
                )
            }
            // Falling through here destroys the root, so the uncertainty that
            // cannot promise a usable voice-only residual must not authorise
            // that either. Pending keeps the bytes and retries the read.
            if deferredUnmatchedVoicesPresent(in: root, whenUncertain: true) {
                return blankBundle(
                    scope: scope,
                    root: root,
                    activationID: activationID,
                    recovery: .pending
                )
            }
            return unavailableBundle(scope: scope, root: root, activationID: activationID)
        case .transient:
            return blankBundle(scope: scope, root: root, activationID: activationID, recovery: .pending)
        case .value(let value):
            stored = value
        }
        guard now() < stored.expiresAt else {
            return unavailableBundle(scope: scope, root: root, activationID: activationID)
        }
        let assetsRoot = root
            .appendingPathComponent("Current", isDirectory: true)
            .appendingPathComponent("Assets", isDirectory: true)
        let photos: [Photo]
        switch loadPhotos(stored.photos, assetsRoot: assetsRoot) {
        case .value(let value):
            photos = value
        case .transient:
            return blankBundle(scope: scope, root: root, activationID: activationID, recovery: .pending)
        case .absent, .malformed:
            return unavailableBundle(scope: scope, root: root, activationID: activationID)
        }
        let voice: Voice?
        switch loadVoice(stored.voice, assetsRoot: assetsRoot) {
        case .value(let value):
            voice = value
        case .transient:
            return blankBundle(scope: scope, root: root, activationID: activationID, recovery: .pending)
        case .absent, .malformed:
            return unavailableBundle(scope: scope, root: root, activationID: activationID)
        }
        return ActiveBundle(
            scope: scope,
            root: root,
            activationID: activationID,
            revision: stored.revision,
            expiresAt: stored.expiresAt,
            photos: photos,
            voice: voice,
            recovery: .ready
        )
    }

    private func blankBundle(
        scope: Scope?,
        root: URL,
        activationID: UUID,
        recovery: Recovery
    ) -> ActiveBundle {
        ActiveBundle(
            scope: scope,
            root: root,
            activationID: activationID,
            revision: 0,
            expiresAt: nil,
            photos: [],
            voice: nil,
            recovery: recovery
        )
    }

    private func unavailableBundle(
        scope: Scope?,
        root: URL,
        activationID: UUID
    ) -> ActiveBundle {
        let recovery: Recovery = removeOwnedRoot(root) ? .ready : .pending
        return blankBundle(
            scope: scope,
            root: root,
            activationID: activationID,
            recovery: recovery
        )
    }

    private func readStoredBundle(
        at root: URL
    ) -> ReadResult<StoredBundle> {
        guard let anchor = storageAnchor(containing: root) else {
            return .malformed
        }
        do {
            try Self.validateContainedPath(root, under: anchor, fileManager: fileManager)
            _ = try fileManager.attributesOfItem(atPath: root.path)
        } catch {
            return Self.isMissing(error) ? .absent : .transient
        }
        let manifestURL = root
            .appendingPathComponent("Current", isDirectory: true)
            .appendingPathComponent("bundle.json")
        do {
            try Self.validateContainedPath(manifestURL, under: anchor, fileManager: fileManager)
            _ = try fileManager.attributesOfItem(atPath: manifestURL.path)
            let data = try Data(contentsOf: manifestURL)
            guard let stored = try? JSONDecoder().decode(
                StoredBundle.self,
                from: data
            ), stored.schemaVersion == 1 else {
                return .malformed
            }
            return .value(stored)
        } catch {
            return Self.isMissing(error) ? .malformed : .transient
        }
    }

    private func readEphemeralExpiry(
        at root: URL
    ) -> ReadResult<Date> {
        guard Self.isOwnedEphemeralComponent(root.lastPathComponent) else {
            return .malformed
        }
        let markerURL = root.appendingPathComponent(".native-intake-v1")
        do {
            try Self.validateContainedPath(markerURL, under: ephemeralAnchor, fileManager: fileManager)
            _ = try fileManager.attributesOfItem(atPath: markerURL.path)
            let data = try Data(contentsOf: markerURL)
            guard let marker = try? JSONDecoder().decode(EphemeralMarker.self, from: data),
                  marker.schemaVersion == 1 else {
                return .malformed
            }
            return .value(marker.createdAt.addingTimeInterval(Self.recoveryWindow))
        } catch {
            return Self.isMissing(error) ? .absent : .transient
        }
    }

    private func loadPhotos(
        _ stored: [Photo],
        assetsRoot: URL
    ) -> ReadResult<[Photo]> {
        guard stored.count <= 5 else {
            return .malformed
        }
        var photos: [Photo] = []
        for value in stored {
            let media = readAsset(
                filename: value.photoURL.lastPathComponent,
                expected: "photo-\(value.id.uuidString).jpg",
                assetsRoot: assetsRoot
            )
            let thumbnail = readAsset(
                filename: value.thumbnailURL.lastPathComponent,
                expected: "thumbnail-\(value.id.uuidString).jpg",
                assetsRoot: assetsRoot
            )
            guard case .value(let mediaURL) = media,
                  case .value(let thumbnailURL) = thumbnail else {
                if case .transient = media {
                    return .transient
                }
                if case .transient = thumbnail {
                    return .transient
                }
                return .malformed
            }
            photos.append(
                Photo(
                    id: value.id,
                    photoURL: mediaURL,
                    thumbnailURL: thumbnailURL,
                    createdAt: value.createdAt,
                    libraryTransferReceipt: value.libraryTransferReceipt
                )
            )
        }
        return .value(photos)
    }

    private func loadVoice(
        _ stored: Voice?,
        assetsRoot: URL
    ) -> ReadResult<Voice?> {
        guard let stored else {
            return .value(nil)
        }
        guard stored.duration > 0,
              stored.duration <= VoiceNotePresentation.maximumDuration else {
            return .malformed
        }
        let media = readAsset(
            filename: stored.mediaURL.lastPathComponent,
            expected: "voice-\(stored.id.uuidString).wav",
            assetsRoot: assetsRoot
        )
        guard case .value(let mediaURL) = media else {
            if case .transient = media {
                return .transient
            }
            return .malformed
        }
        return .value(
            Voice(
                id: stored.id,
                mediaURL: mediaURL,
                duration: stored.duration
            )
        )
    }

    private func readAsset(
        filename: String,
        expected: String,
        assetsRoot: URL
    ) -> ReadResult<URL> {
        guard let anchor = storageAnchor(containing: assetsRoot) else {
            return .malformed
        }
        guard let url = ownedAssetURL(
            filename: filename,
            expected: expected,
            assetsRoot: assetsRoot
        ) else {
            return .malformed
        }
        do {
            try Self.validateContainedPath(assetsRoot, under: anchor, fileManager: fileManager)
            try Self.validateContainedPath(url, under: anchor, fileManager: fileManager)
            _ = try fileManager.attributesOfItem(atPath: url.path)
            return .value(url)
        } catch {
            return Self.isMissing(error) ? .malformed : .transient
        }
    }

    private func ownedAssetURL(
        filename: String,
        expected: String,
        assetsRoot: URL
    ) -> URL? {
        guard filename == expected,
              !filename.contains("/"),
              !filename.contains("\\"),
              filename != ".",
              filename != ".." else {
            return nil
        }
        let root = assetsRoot.standardizedFileURL
        let url = root.appendingPathComponent(filename).standardizedFileURL
        guard url.deletingLastPathComponent() == root else {
            return nil
        }
        return url
    }

    private func removeOwnedRoot(_ root: URL) -> Bool {
        guard let anchor = storageAnchor(containing: root) else {
            return false
        }
        do {
            try Self.validateContainedPath(root, under: anchor, fileManager: fileManager)
            try Self.validateContainedPath(
                root.appendingPathComponent("Current/Assets", isDirectory: true),
                under: anchor,
                fileManager: fileManager
            )
            try fileManager.removeItem(at: root)
        } catch {
            guard Self.isMissing(error) else {
                return false
            }
        }
        deletionRetryAfter[root] = nil
        return true
    }

    private static func isOwnedScopeComponent(_ component: String) -> Bool {
        isOwnedComponent(component, hexadecimalCount: 64)
    }

    private static func isOwnedEphemeralComponent(_ component: String) -> Bool {
        isOwnedComponent(component, hexadecimalCount: 32)
    }

    private static func isOwnedComponent(
        _ component: String,
        hexadecimalCount: Int
    ) -> Bool {
        guard component.hasPrefix("v1-"),
              component.count == hexadecimalCount + 3 else {
            return false
        }
        return component.utf8.dropFirst(3).allSatisfy {
            (48...57).contains($0) || (97...102).contains($0)
        }
    }

    private static func isMissing(_ error: Error) -> Bool {
        let cocoa = CocoaError.Code(rawValue: (error as NSError).code)
        return cocoa == .fileNoSuchFile || cocoa == .fileReadNoSuchFile
    }

    private static func isFileAlreadyPresent(_ error: Error) -> Bool {
        CocoaError.Code(rawValue: (error as NSError).code)
            == .fileWriteFileExists
    }

    private func storageAnchor(for bundle: ActiveBundle) -> URL {
        bundle.scope == nil ? ephemeralAnchor : durableAnchor
    }

    private func storageAnchor(containing url: URL) -> URL? {
        let url = url.standardizedFileURL
        if Self.isContained(url, under: durableAnchor) {
            return durableAnchor
        }
        if Self.isContained(url, under: ephemeralAnchor) {
            return ephemeralAnchor
        }
        return nil
    }

    private nonisolated static func prepareRoot(
        _ root: URL,
        under anchor: URL,
        fileManager: FileManager
    ) throws {
        try validateContainedPath(root, under: anchor, fileManager: fileManager)
        try fileManager.createDirectory(
            at: root,
            withIntermediateDirectories: true,
            attributes: [
                .protectionKey: FileProtectionType.complete
            ]
        )
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var protectedRoot = root
        try protectedRoot.setResourceValues(values)
        try validateContainedPath(root, under: anchor, fileManager: fileManager)
    }

    private nonisolated static func prepareStagingRoot(
        _ stagingRoot: URL,
        assetsRoot: URL,
        under anchor: URL,
        fileManager: FileManager
    ) throws {
        var root = anchor.standardizedFileURL
        for component in assetsRoot.standardizedFileURL.pathComponents.dropFirst(
            root.pathComponents.count
        ) {
            root.appendPathComponent(component, isDirectory: true)
            try prepareRoot(root, under: anchor, fileManager: fileManager)
        }
    }

    private nonisolated static func write(
        _ data: Data,
        to url: URL,
        under anchor: URL,
        fileManager: FileManager
    ) throws {
        try validateContainedPath(url, under: anchor, fileManager: fileManager)
        try data.write(to: url, options: Self.writingOptions)
        try protect(url, fileManager: fileManager)
    }

    private nonisolated static func protect(
        _ url: URL,
        fileManager: FileManager
    ) throws {
        try fileManager.setAttributes(
            [.protectionKey: FileProtectionType.complete],
            ofItemAtPath: url.path
        )
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var protectedURL = url
        try protectedURL.setResourceValues(values)
    }

    private nonisolated static func publish(
        _ pendingURL: URL,
        as manifestURL: URL,
        under anchor: URL,
        fileManager: FileManager
    ) throws {
        try validateContainedPath(pendingURL, under: anchor, fileManager: fileManager)
        try validateContainedPath(manifestURL, under: anchor, fileManager: fileManager)
        if fileManager.fileExists(atPath: manifestURL.path) {
            _ = try fileManager.replaceItemAt(
                manifestURL,
                withItemAt: pendingURL,
                backupItemName: nil,
                options: .usingNewMetadataOnly
            )
        } else {
            try fileManager.moveItem(at: pendingURL, to: manifestURL)
        }
    }

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
        let relativeComponents = candidate.pathComponents.dropFirst(
            anchor.pathComponents.count
        )
        for component in relativeComponents {
            current.appendPathComponent(component)
            try rejectSymlinkIfPresent(current, fileManager: fileManager)
        }
        let resolvedAnchor = anchor.resolvingSymlinksInPath()
        let resolvedCandidate = candidate.resolvingSymlinksInPath()
        guard isContained(resolvedCandidate, under: resolvedAnchor) else {
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
            guard isMissing(error) else {
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

    private nonisolated static func removeIfContained(
        _ url: URL,
        under anchor: URL,
        fileManager: FileManager
    ) {
        guard (try? validateContainedPath(url, under: anchor, fileManager: fileManager)) != nil else {
            return
        }
        try? fileManager.removeItem(at: url)
    }

    private static func assetURLs(for photos: [Photo]) -> [URL] {
        photos.flatMap { [$0.photoURL, $0.thumbnailURL] }
    }

    private static func isJPEG(_ data: Data) -> Bool {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else {
            return false
        }
        return CGImageSourceGetCount(source) > 0
    }

    private func publish(_ event: Event) {
        observers.values.forEach { $0.yield(event) }
    }

    private func removeObserver(_ id: UUID) {
        observers[id] = nil
    }
}
