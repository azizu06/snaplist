import Foundation
import Observation

struct EbayPublishedListing: Codable, Equatable, Sendable {
    let ebayListingID: String
    let listingURL: URL
}

enum EbayPublishTransportOutcome: Equatable, Sendable {
    case published(EbayPublishedListing)
    case outcomeNotYetKnown
    case failed
    case staleRevision
    case providerAuthorityChanged
}

protocol EbayPublishServing: Sendable {
    func publish(
        listingID: UUID,
        expectedReviewRevision: UUID,
        idempotencyKey: UUID
    ) async throws -> EbayPublishTransportOutcome
}

struct EbayPublishAttempt: Codable, Equatable, Sendable {
    let listingID: UUID
    let expectedReviewRevision: UUID
    let idempotencyKey: UUID
}

protocol EbayPublishAttemptStoring: Sendable {
    func attempt(listingID: UUID) async throws -> EbayPublishAttempt?
    func attempt(
        listingID: UUID,
        expectedReviewRevision: UUID
    ) async throws -> EbayPublishAttempt?
    func save(_ attempt: EbayPublishAttempt) async throws
}

actor MemoryEbayPublishAttemptStore: EbayPublishAttemptStoring {
    private var attempts: [UUID: EbayPublishAttempt] = [:]

    func attempt(listingID: UUID) -> EbayPublishAttempt? {
        attempts[listingID]
    }

    func attempt(
        listingID: UUID,
        expectedReviewRevision: UUID
    ) -> EbayPublishAttempt? {
        guard let attempt = attempts[listingID],
              attempt.expectedReviewRevision == expectedReviewRevision else {
            return nil
        }
        return attempt
    }

    func save(_ attempt: EbayPublishAttempt) {
        attempts[attempt.listingID] = attempt
    }
}

actor FileEbayPublishAttemptStore: EbayPublishAttemptStoring {
    private let fileURL: URL
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(fileURL: URL? = nil) {
        self.fileURL = fileURL ?? Self.defaultFileURL()
    }

    func attempt(listingID: UUID) throws -> EbayPublishAttempt? {
        try load()[listingID]
    }

    func attempt(
        listingID: UUID,
        expectedReviewRevision: UUID
    ) throws -> EbayPublishAttempt? {
        let attempts = try load()
        guard let attempt = attempts[listingID],
              attempt.expectedReviewRevision == expectedReviewRevision else {
            return nil
        }
        return attempt
    }

    func save(_ attempt: EbayPublishAttempt) throws {
        var attempts = try load()
        attempts[attempt.listingID] = attempt
        let directory = fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        let data = try encoder.encode(attempts)
        try data.write(to: fileURL, options: [.atomic, .completeFileProtection])
    }

    private func load() throws -> [UUID: EbayPublishAttempt] {
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            return [:]
        }
        return try decoder.decode(
            [UUID: EbayPublishAttempt].self,
            from: Data(contentsOf: fileURL)
        )
    }

    private static func defaultFileURL() -> URL {
        let root = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? FileManager.default.temporaryDirectory
        return root
            .appending(path: "SnapList", directoryHint: .isDirectory)
            .appending(path: "ebay-publish-attempts.json")
    }
}

enum EbayPublishPhase: Equatable, Sendable {
    case ready
    case publishing
    case published
    case outcomeNotYetKnown
    case failed
    case sellerFixableRefusal(message: String)
    case staleRevision
    case providerAuthorityChanged
}

@MainActor
@Observable
final class EbayPublishStore {
    private(set) var phase: EbayPublishPhase = .ready
    private(set) var publishedListing: EbayPublishedListing?

    let listingID: UUID
    let expectedReviewRevision: UUID

    private let service: any EbayPublishServing
    private let attemptStore: any EbayPublishAttemptStoring

    init(
        listingID: UUID,
        expectedReviewRevision: UUID,
        service: any EbayPublishServing,
        attemptStore: any EbayPublishAttemptStoring = FileEbayPublishAttemptStore()
    ) {
        self.listingID = listingID
        self.expectedReviewRevision = expectedReviewRevision
        self.service = service
        self.attemptStore = attemptStore
    }

    func confirmPublish() async {
        guard phase != .publishing, phase != .published else { return }
        phase = .publishing

        do {
            let attempt = try await durableAttempt()
            let outcome = try await service.publish(
                listingID: listingID,
                expectedReviewRevision: expectedReviewRevision,
                idempotencyKey: attempt.idempotencyKey
            )
            apply(outcome)
        } catch let EbayPublishClientError.sellerFixableRefusal(message) {
            phase = .sellerFixableRefusal(message: message)
        } catch {
            // A transport failure cannot say whether eBay accepted the mutation.
            phase = .outcomeNotYetKnown
        }
    }

    private func durableAttempt() async throws -> EbayPublishAttempt {
        if let existing = try await attemptStore.attempt(
            listingID: listingID,
            expectedReviewRevision: expectedReviewRevision
        ) {
            return existing
        }
        let attempt = EbayPublishAttempt(
            listingID: listingID,
            expectedReviewRevision: expectedReviewRevision,
            idempotencyKey: UUID()
        )
        try await attemptStore.save(attempt)
        return attempt
    }

    private func apply(_ outcome: EbayPublishTransportOutcome) {
        switch outcome {
        case .published(let listing):
            publishedListing = listing
            phase = .published
        case .outcomeNotYetKnown:
            phase = .outcomeNotYetKnown
        case .failed:
            phase = .failed
        case .staleRevision:
            phase = .staleRevision
        case .providerAuthorityChanged:
            phase = .providerAuthorityChanged
        }
    }
}
