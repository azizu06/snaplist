import Foundation

struct ListingReviewDraft: Codable, Equatable, Sendable {
    var title: String
    var description: String
    var condition: ListingReviewCondition
    var specifics: [ListingReviewSpecific]
    var sellerPriceOverride: Decimal?

    init(snapshot: ListingReviewResult) {
        title = snapshot.listing.title
        description = snapshot.listing.description
        condition = snapshot.listing.condition
        specifics = snapshot.listing.specifics
        sellerPriceOverride = snapshot.pricing.sellerPriceOverride
    }

    var hasValidPrice: Bool {
        guard let sellerPriceOverride else { return true }
        return sellerPriceOverride.isPositiveCentAmount
    }

    var hasRequiredCopy: Bool {
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let description = description.trimmingCharacters(
            in: .whitespacesAndNewlines
        )
        guard !title.isEmpty,
              title.utf16.count <= 80,
              !description.isEmpty,
              description.utf16.count <= 20_000,
              (1...50).contains(specifics.count) else {
            return false
        }
        var names = Set<String>()
        return specifics.allSatisfy { specific in
            let name = specific.name.trimmingCharacters(
                in: .whitespacesAndNewlines
            )
            let value = specific.value.trimmingCharacters(
                in: .whitespacesAndNewlines
            )
            let key = Self.saveContractKey(for: name)
            return !name.isEmpty
                && name.utf16.count <= 65
                && !value.isEmpty
                && value.utf16.count <= 500
                && names.insert(key).inserted
        }
    }

    static func isIdentitySpecificName(_ name: String) -> Bool {
        // `hasRequiredCopy` trims before it takes the key and this did not, so
        // a name that arrived as " Brand" read as an ordinary specific. It
        // decides both the edit route and the store's write guard, and a miss
        // here writes an identity value without rerunning the price.
        saveContractKey(
            for: name.trimmingCharacters(in: .whitespacesAndNewlines)
        ).hasPrefix("reserved:")
    }

    private static func saveContractKey(for name: String) -> String {
        switch name.lowercased() {
        case "brand", "model", "condition", "isbn", "upc":
            "reserved:\(name.lowercased())"
        case "category", "type":
            "reserved:category"
        default:
            name.lowercased()
        }
    }
}

struct ListingReviewPendingSave: Codable, Equatable, Sendable {
    let idempotencyKey: UUID
    let draft: ListingReviewDraft
}

struct PersistedListingReviewDraft: Codable, Equatable, Sendable {
    static let schemaVersion = 1

    let schemaVersion: Int
    let snapshot: ListingReviewResult
    let draft: ListingReviewDraft
    let pendingSave: ListingReviewPendingSave?
    let expiresAt: Date

    init(
        snapshot: ListingReviewResult,
        draft: ListingReviewDraft,
        pendingSave: ListingReviewPendingSave?,
        expiresAt: Date
    ) {
        schemaVersion = Self.schemaVersion
        self.snapshot = snapshot
        self.draft = draft
        self.pendingSave = pendingSave
        self.expiresAt = expiresAt
    }
}

struct ListingReviewDraftPersistenceToken: Equatable, Sendable {
    let sessionID: UUID
    let generation: UInt

    fileprivate func canActivate(
        after current: ListingReviewDraftPersistenceToken?
    ) -> Bool {
        current?.sessionID != sessionID
            || (current?.generation ?? 0) <= generation
    }

    fileprivate func canCommit(
        after current: ListingReviewDraftPersistenceToken?
    ) -> Bool {
        current?.sessionID == sessionID
            && (current?.generation ?? .max) <= generation
    }
}

enum ListingReviewDraftPersistenceError: Error {
    case staleToken
}

protocol ListingReviewDraftPersisting: Sendable {
    /// Records are keyed by the server-owned, high-entropy run identity. A
    /// caller may read one only after it has fetched the same canonical run
    /// through RLS for the current principal. The persistence layer never
    /// enumerates records and never accepts a client-selected item/listing.
    func activate(
        _ token: ListingReviewDraftPersistenceToken,
        runID: UUID
    ) async -> Bool

    func load(
        runID: UUID,
        token: ListingReviewDraftPersistenceToken
    ) async throws -> PersistedListingReviewDraft?

    func save(
        _ record: PersistedListingReviewDraft,
        runID: UUID,
        token: ListingReviewDraftPersistenceToken
    ) async throws -> Bool

    func remove(
        runID: UUID,
        token: ListingReviewDraftPersistenceToken
    ) async throws -> Bool
}

protocol ListingReviewDraftTokenAuthorizing:
    Actor, ListingReviewDraftPersisting {
    var tokens: [UUID: ListingReviewDraftPersistenceToken] { get set }
}

extension ListingReviewDraftTokenAuthorizing {
    func activate(
        _ token: ListingReviewDraftPersistenceToken,
        runID: UUID
    ) -> Bool {
        guard token.canActivate(after: tokens[runID]) else { return false }
        tokens[runID] = token
        return true
    }

    func commit(
        _ token: ListingReviewDraftPersistenceToken,
        runID: UUID
    ) -> Bool {
        guard token.canCommit(after: tokens[runID]) else { return false }
        tokens[runID] = token
        return true
    }
}

actor LocalListingReviewDraftPersistence:
    ListingReviewDraftTokenAuthorizing {
    static let writingOptions: Data.WritingOptions = [
        .atomic,
        .completeFileProtection,
    ]

    private let rootDirectory: URL
    private let fileManager: FileManager
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder
    var tokens: [UUID: ListingReviewDraftPersistenceToken] = [:]

    init(
        rootDirectory: URL? = nil,
        fileManager: FileManager = .default
    ) {
        self.fileManager = fileManager
        self.rootDirectory = rootDirectory ?? fileManager
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("SnapList", isDirectory: true)
            .appendingPathComponent("ListingReview", isDirectory: true)
        encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
    }

    func load(
        runID: UUID,
        token: ListingReviewDraftPersistenceToken
    ) throws -> PersistedListingReviewDraft? {
        guard tokens[runID] == token else {
            throw ListingReviewDraftPersistenceError.staleToken
        }
        let url = recordURL(runID: runID)
        let attributes: [FileAttributeKey: Any]
        do {
            attributes = try fileManager.attributesOfItem(atPath: url.path)
        } catch {
            let nsError = error as NSError
            guard nsError.domain == NSCocoaErrorDomain,
                  nsError.code == NSFileNoSuchFileError
                    || nsError.code == NSFileReadNoSuchFileError else {
                throw error
            }
            return nil
        }
        guard attributes[.type] as? FileAttributeType == .typeRegular else {
            throw CocoaError(.fileReadCorruptFile)
        }
        let record: PersistedListingReviewDraft
        do {
            record = try decoder.decode(
                PersistedListingReviewDraft.self,
                from: Data(contentsOf: url, options: .mappedIfSafe)
            )
        } catch is DecodingError {
            try fileManager.removeItem(at: url)
            return nil
        }
        guard record.schemaVersion == PersistedListingReviewDraft.schemaVersion else {
            try fileManager.removeItem(at: url)
            return nil
        }
        return record
    }

    func save(
        _ record: PersistedListingReviewDraft,
        runID: UUID,
        token: ListingReviewDraftPersistenceToken
    ) throws -> Bool {
        guard commit(token, runID: runID) else { return false }
        try fileManager.createDirectory(
            at: rootDirectory,
            withIntermediateDirectories: true
        )
        let data = try encoder.encode(record)
        let url = recordURL(runID: runID)
        try data.write(to: url, options: Self.writingOptions)
        return true
    }

    func remove(
        runID: UUID,
        token: ListingReviewDraftPersistenceToken
    ) throws -> Bool {
        guard commit(token, runID: runID) else { return false }
        let url = recordURL(runID: runID)
        do {
            try fileManager.removeItem(at: url)
        } catch let error as CocoaError where error.code == .fileNoSuchFile {
            return true
        }
        return true
    }

    private func recordURL(runID: UUID) -> URL {
        rootDirectory.appendingPathComponent(
            runID.uuidString.lowercased() + ".json",
            isDirectory: false
        )
    }
}

actor MemoryListingReviewDraftPersistence:
    ListingReviewDraftTokenAuthorizing {
    private var records: [UUID: PersistedListingReviewDraft] = [:]
    var tokens: [UUID: ListingReviewDraftPersistenceToken] = [:]

    func load(
        runID: UUID,
        token: ListingReviewDraftPersistenceToken
    ) throws -> PersistedListingReviewDraft? {
        guard tokens[runID] == token else {
            throw ListingReviewDraftPersistenceError.staleToken
        }
        return records[runID]
    }

    func save(
        _ record: PersistedListingReviewDraft,
        runID: UUID,
        token: ListingReviewDraftPersistenceToken
    ) -> Bool {
        guard commit(token, runID: runID) else { return false }
        records[runID] = record
        return true
    }

    func remove(
        runID: UUID,
        token: ListingReviewDraftPersistenceToken
    ) -> Bool {
        guard commit(token, runID: runID) else { return false }
        records.removeValue(forKey: runID)
        return true
    }
}

private extension Decimal {
    var isPositiveCentAmount: Bool {
        guard !isNaN, self > 0 else { return false }
        var input = self
        var normalized = Decimal()
        NSDecimalRound(&normalized, &input, 2, .plain)
        return normalized == self
    }
}
