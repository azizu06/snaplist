import Foundation
import Observation

protocol ListingReviewPayloadServing: Sendable {
    func fetchListingReviewPayload(itemID: UUID) async throws -> Data
}

enum ListingReviewLoadState: Equatable, Sendable {
    case idle
    case loading
    case loaded
    case unavailable
}

@MainActor
@Observable
final class ListingReviewStore {
    private(set) var state: ListingReviewLoadState = .idle
    private(set) var review: ListingReviewResult?
    private(set) var draft: ListingReviewDraft?

    private let payloads: any ListingReviewPayloadServing
    private let decoder = JSONDecoder()
    private var requestedItemID: UUID?
    private var requestGeneration = 0

    init(payloads: any ListingReviewPayloadServing) {
        self.payloads = payloads
    }

    func load(itemID: UUID) async {
        if let requestedItemID, requestedItemID != itemID {
            review = nil
            draft = nil
        }
        requestedItemID = itemID
        await startFetch(itemID: itemID)
    }

    func refresh() async {
        guard let requestedItemID else { return }
        await startFetch(itemID: requestedItemID)
    }

    func editTitle(_ title: String) {
        draft?.title = title
    }

    func editDescription(_ description: String) {
        draft?.description = description
    }

    func editCondition(_ condition: String) {
        draft?.condition = condition
    }

    func editSpecifics(_ specifics: [ListingReviewSpecific]) {
        draft?.specifics = specifics
    }

    func editSellerPriceOverride(_ sellerPriceOverride: Decimal?) {
        draft?.sellerPriceOverride = sellerPriceOverride
    }

    private func startFetch(itemID: UUID) async {
        requestGeneration += 1
        let generation = requestGeneration
        state = .loading

        do {
            let payload = try await payloads.fetchListingReviewPayload(itemID: itemID)
            let loaded = try decoder.decode(ListingReviewResult.self, from: payload)
            guard generation == requestGeneration, requestedItemID == itemID else { return }
            guard loaded.binding.itemID == itemID else {
                throw ListingReviewStoreError.incoherentBinding
            }
            review = loaded
            draft = ListingReviewDraft(review: loaded)
            state = .loaded
        } catch is CancellationError {
            guard generation == requestGeneration else { return }
            state = review == nil ? .idle : .unavailable
        } catch {
            guard generation == requestGeneration else { return }
            state = .unavailable
        }
    }
}

private enum ListingReviewStoreError: Error {
    case incoherentBinding
}
