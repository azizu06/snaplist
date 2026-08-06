import Foundation

enum DurableRunStatus: String, Decodable, Equatable, Sendable {
    case queued
    case running
    case retrying
    case succeeded
    case failed
    case canceled
}

enum DurableRunStage: String, Decodable, Equatable, Sendable {
    case queued
    case identifying
    case pricing
    case generating
    case persisting
    case completed
}

struct RunTimestamps: Decodable, Equatable, Sendable {
    let createdAt: String
    let updatedAt: String
    let enqueuedAt: String?
    let startedAt: String?
    let lastAttemptedAt: String?
    let nextAttemptAt: String?
    let completedAt: String?
    let retentionCleanedAt: String?

    init(
        createdAt: String,
        updatedAt: String,
        enqueuedAt: String?,
        startedAt: String?,
        lastAttemptedAt: String?,
        nextAttemptAt: String?,
        completedAt: String?,
        retentionCleanedAt: String?
    ) {
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.enqueuedAt = enqueuedAt
        self.startedAt = startedAt
        self.lastAttemptedAt = lastAttemptedAt
        self.nextAttemptAt = nextAttemptAt
        self.completedAt = completedAt
        self.retentionCleanedAt = retentionCleanedAt
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case createdAt
        case updatedAt
        case enqueuedAt
        case startedAt
        case lastAttemptedAt
        case nextAttemptAt
        case completedAt
        case retentionCleanedAt
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.runContractContainer(keyedBy: CodingKeys.self)
        createdAt = try values.decode(String.self, forKey: .createdAt)
        updatedAt = try values.decode(String.self, forKey: .updatedAt)
        enqueuedAt = try values.decodeRequiredIfPresent(String.self, forKey: .enqueuedAt)
        startedAt = try values.decodeRequiredIfPresent(String.self, forKey: .startedAt)
        lastAttemptedAt = try values.decodeRequiredIfPresent(String.self, forKey: .lastAttemptedAt)
        nextAttemptAt = try values.decodeRequiredIfPresent(String.self, forKey: .nextAttemptAt)
        completedAt = try values.decodeRequiredIfPresent(String.self, forKey: .completedAt)
        retentionCleanedAt = try values.decodeRequiredIfPresent(
            String.self,
            forKey: .retentionCleanedAt
        )

        try values.validateDateTime(createdAt, forKey: .createdAt)
        try values.validateDateTime(updatedAt, forKey: .updatedAt)
        try values.validateDateTime(enqueuedAt, forKey: .enqueuedAt)
        try values.validateDateTime(startedAt, forKey: .startedAt)
        try values.validateDateTime(lastAttemptedAt, forKey: .lastAttemptedAt)
        try values.validateDateTime(nextAttemptAt, forKey: .nextAttemptAt)
        try values.validateDateTime(completedAt, forKey: .completedAt)
        try values.validateDateTime(retentionCleanedAt, forKey: .retentionCleanedAt)
    }
}

struct RunItemTruth: Decodable, Equatable, Sendable {
    let title: String
    let photoCount: Int

    init(title: String, photoCount: Int) {
        self.title = title
        self.photoCount = photoCount
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case title
        case photoCount
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.runContractContainer(keyedBy: CodingKeys.self)
        title = try values.decode(String.self, forKey: .title)
        photoCount = try values.decode(Int.self, forKey: .photoCount)
        try values.require(!title.isEmpty, forKey: .title)
        try values.require(photoCount >= 0, forKey: .photoCount)
    }
}

enum RunRequiredInputDestination: String, Decodable, Equatable, Sendable {
    case identity
    case photos
    case listing
}

struct RunRequiredInput: Decodable, Equatable, Sendable {
    let reason: String
    let destination: RunRequiredInputDestination

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case reason
        case destination
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.runContractContainer(keyedBy: CodingKeys.self)
        reason = try values.decode(String.self, forKey: .reason)
        destination = try values.decode(RunRequiredInputDestination.self, forKey: .destination)
        try values.require(!reason.isEmpty, forKey: .reason)
    }
}

enum RunTerminalOutcome: String, Decodable, Equatable, Sendable {
    case succeeded
    case failed
    case canceled
}

struct RunSafeFailure: Decodable, Equatable, Sendable {
    let reason: String
    let detail: String
    let retryable: Bool
    let workPreserved: Bool

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case reason
        case detail
        case retryable
        case workPreserved
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.runContractContainer(keyedBy: CodingKeys.self)
        reason = try values.decode(String.self, forKey: .reason)
        detail = try values.decode(String.self, forKey: .detail)
        retryable = try values.decode(Bool.self, forKey: .retryable)
        workPreserved = try values.decode(Bool.self, forKey: .workPreserved)
        try values.require(!reason.isEmpty, forKey: .reason)
        try values.require(!detail.isEmpty, forKey: .detail)
    }
}

enum RunAllowanceTruth: String, Decodable, Equatable, Sendable {
    case reserved
    case settled
    case restored
    case unchanged
}

struct RunActionTruth: Decodable, Equatable, Sendable {
    let canRetry: Bool
    let canCancel: Bool
    let canOpenReview: Bool
    let canStartNewCapture: Bool

    init(
        canRetry: Bool,
        canCancel: Bool,
        canOpenReview: Bool,
        canStartNewCapture: Bool
    ) {
        self.canRetry = canRetry
        self.canCancel = canCancel
        self.canOpenReview = canOpenReview
        self.canStartNewCapture = canStartNewCapture
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case canRetry
        case canCancel
        case canOpenReview
        case canStartNewCapture
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.runContractContainer(keyedBy: CodingKeys.self)
        canRetry = try values.decode(Bool.self, forKey: .canRetry)
        canCancel = try values.decode(Bool.self, forKey: .canCancel)
        canOpenReview = try values.decode(Bool.self, forKey: .canOpenReview)
        canStartNewCapture = try values.decode(Bool.self, forKey: .canStartNewCapture)
    }
}

struct DurableRun: Identifiable, Decodable, Equatable, Sendable {
    let id: UUID
    let itemID: UUID
    let listingID: UUID?
    let status: DurableRunStatus
    let stage: DurableRunStage
    let attemptCount: Int
    let maxAttempts: Int
    let schemaVersion: Int
    let timestamps: RunTimestamps
    let item: RunItemTruth?
    let requiredInput: RunRequiredInput?
    let terminalOutcome: RunTerminalOutcome?
    let safeFailure: RunSafeFailure?
    let allowance: RunAllowanceTruth
    let legalActions: RunActionTruth
    let review: ListingReviewResult?
    let delivery: DurableRunDeliveryTruth?
    let lastMeaningfulUpdateAt: String
    let retentionCleanedAt: String?

    init(
        id: UUID,
        itemID: UUID,
        listingID: UUID?,
        status: DurableRunStatus,
        stage: DurableRunStage,
        attemptCount: Int,
        maxAttempts: Int,
        schemaVersion: Int,
        timestamps: RunTimestamps,
        item: RunItemTruth?,
        requiredInput: RunRequiredInput?,
        terminalOutcome: RunTerminalOutcome?,
        safeFailure: RunSafeFailure?,
        allowance: RunAllowanceTruth,
        legalActions: RunActionTruth,
        lastMeaningfulUpdateAt: String,
        retentionCleanedAt: String?,
        review: ListingReviewResult? = nil,
        delivery: DurableRunDeliveryTruth? = nil
    ) {
        self.id = id
        self.itemID = itemID
        self.listingID = listingID
        self.status = status
        self.stage = stage
        self.attemptCount = attemptCount
        self.maxAttempts = maxAttempts
        self.schemaVersion = schemaVersion
        self.timestamps = timestamps
        self.item = item
        self.requiredInput = requiredInput
        self.terminalOutcome = terminalOutcome
        self.safeFailure = safeFailure
        self.allowance = allowance
        self.legalActions = legalActions
        self.review = review
        self.delivery = delivery
        self.lastMeaningfulUpdateAt = lastMeaningfulUpdateAt
        self.retentionCleanedAt = retentionCleanedAt
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case id
        case itemID = "itemId"
        case listingID = "listingId"
        case status
        case stage
        case attemptCount
        case maxAttempts
        case schemaVersion
        case timestamps
        case item
        case requiredInput
        case terminalOutcome
        case safeFailure
        case allowance
        case legalActions
        case review
        case delivery
        case lastMeaningfulUpdateAt
        case retentionCleanedAt
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.runContractContainer(keyedBy: CodingKeys.self)
        id = try values.decode(UUID.self, forKey: .id)
        itemID = try values.decode(UUID.self, forKey: .itemID)
        listingID = try values.decodeRequiredIfPresent(UUID.self, forKey: .listingID)
        status = try values.decode(DurableRunStatus.self, forKey: .status)
        stage = try values.decode(DurableRunStage.self, forKey: .stage)
        attemptCount = try values.decode(Int.self, forKey: .attemptCount)
        maxAttempts = try values.decode(Int.self, forKey: .maxAttempts)
        schemaVersion = try values.decode(Int.self, forKey: .schemaVersion)
        timestamps = try values.decode(RunTimestamps.self, forKey: .timestamps)
        item = try values.decodeIfPresent(RunItemTruth.self, forKey: .item)
        requiredInput = try values.decodeRequiredIfPresent(
            RunRequiredInput.self,
            forKey: .requiredInput
        )
        terminalOutcome = try values.decodeRequiredIfPresent(
            RunTerminalOutcome.self,
            forKey: .terminalOutcome
        )
        safeFailure = try values.decodeRequiredIfPresent(RunSafeFailure.self, forKey: .safeFailure)
        allowance = try values.decode(RunAllowanceTruth.self, forKey: .allowance)
        legalActions = try values.decode(RunActionTruth.self, forKey: .legalActions)
        review = values.contains(.review)
            ? try values.decode(ListingReviewResult.self, forKey: .review)
            : nil
        delivery = try values.decodeIfPresent(
            DurableRunDeliveryTruth.self,
            forKey: .delivery
        )
        lastMeaningfulUpdateAt = try values.decode(String.self, forKey: .lastMeaningfulUpdateAt)
        retentionCleanedAt = try values.decodeRequiredIfPresent(
            String.self,
            forKey: .retentionCleanedAt
        )

        try values.require(attemptCount >= 0, forKey: .attemptCount)
        try values.require(maxAttempts >= 1, forKey: .maxAttempts)
        try values.require(schemaVersion == 1, forKey: .schemaVersion)
        try values.validateDateTime(lastMeaningfulUpdateAt, forKey: .lastMeaningfulUpdateAt)
        try values.validateDateTime(retentionCleanedAt, forKey: .retentionCleanedAt)
        if let review {
            try values.require(
                id == review.binding.runID
                    && itemID == review.binding.itemID
                    && listingID == review.binding.listingID
                    && status == .succeeded
                    && stage == .completed
                    && legalActions.canOpenReview,
                forKey: .review
            )
        } else {
            try values.require(!legalActions.canOpenReview, forKey: .review)
        }
    }
}

enum DurableRunDeliveryState: String, Decodable, Equatable, Sendable {
    case publishedToEbay = "published_to_ebay"
    case exportPrepared = "export_prepared"
}

struct DurableRunDeliveryTruth: Decodable, Equatable, Sendable {
    let state: DurableRunDeliveryState
    let coverPhotoURL: URL?

    private enum CodingKeys: String, CodingKey {
        case state
        case coverPhotoURL = "coverPhotoUrl"
    }
}

private struct RunContractCodingKey: CodingKey {
    let stringValue: String
    let intValue: Int? = nil

    init?(stringValue: String) {
        self.stringValue = stringValue
    }

    init?(intValue: Int) {
        return nil
    }
}

extension Decoder {
    func runContractContainer<Key>(
        keyedBy type: Key.Type
    ) throws -> KeyedDecodingContainer<Key> where Key: CodingKey & CaseIterable {
        let received = try container(keyedBy: RunContractCodingKey.self)
        let allowed = Set(Key.allCases.map(\.stringValue))
        let unknown = received.allKeys.map(\.stringValue).filter { !allowed.contains($0) }
        guard unknown.isEmpty else {
            throw DecodingError.dataCorrupted(
                .init(codingPath: codingPath, debugDescription: "Unknown keys: \(unknown.sorted())")
            )
        }
        return try container(keyedBy: type)
    }
}

extension KeyedEncodingContainer {
    /// The mirror of `decodeRequiredIfPresent`. That read treats an absent key
    /// and an explicit null as different things, so a nullable value has to be
    /// written as null rather than left out. Swift's synthesized encoder uses
    /// `encodeIfPresent` and drops the key, which makes a type that is
    /// perfectly good on the wire fail to survive its own encoder — the way a
    /// locally persisted draft has to.
    mutating func encodeRequired<T>(
        _ value: T?,
        forKey key: Key
    ) throws where T: Encodable {
        try encode(value, forKey: key)
    }
}

extension KeyedDecodingContainer {
    func decodeRequiredIfPresent<T>(
        _ type: T.Type,
        forKey key: Key
    ) throws -> T? where T: Decodable {
        guard contains(key) else {
            throw DecodingError.keyNotFound(
                key,
                .init(codingPath: codingPath, debugDescription: "Missing required key")
            )
        }
        return try decodeIfPresent(type, forKey: key)
    }

    func require(_ condition: Bool, forKey key: Key) throws {
        guard condition else {
            throw DecodingError.dataCorruptedError(
                forKey: key,
                in: self,
                debugDescription: "Value is outside the run contract"
            )
        }
    }

    func validateDateTime(_ value: String?, forKey key: Key) throws {
        guard let value else { return }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let wholeSeconds = ISO8601DateFormatter()
        wholeSeconds.formatOptions = [.withInternetDateTime]
        try require(
            fractional.date(from: value) != nil || wholeSeconds.date(from: value) != nil,
            forKey: key
        )
    }
}
