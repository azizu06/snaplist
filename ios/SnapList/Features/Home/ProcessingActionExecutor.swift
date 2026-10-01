import Foundation
import Observation

struct ProcessingGuestClaimContext: Equatable, Sendable {
    let authority: GuestClaimAuthority
    let projection: GuestClaimListingProjection
    let review: ListingReviewResult
}

enum ProcessingReviewRoute: Equatable, Sendable {
    case guestClaim(ProcessingGuestClaimContext)
    case listingReview(ListingReviewResult)
}

@MainActor
@Observable
final class ProcessingGuestClaimPresentationHost {
    private(set) var context: ProcessingGuestClaimContext?

    var isPresented: Bool { context != nil }

    func present(_ requested: ProcessingGuestClaimContext) -> Bool {
        guard context == nil else { return false }
        context = requested
        return true
    }

    func dismiss() {
        context = nil
    }

    func takeClaimed(
        _ listing: ClaimedGuestListing
    ) -> ProcessingGuestClaimContext? {
        guard let context,
              listing.itemID == context.authority.itemID,
              listing.runID == context.authority.runID,
              listing.draftID == context.authority.draftID else {
            return nil
        }
        self.context = nil
        return context
    }
}

@MainActor
enum ProcessingActionOutcome: Equatable {
    case selectedScan
    case presentedGuestClaim
    case presentedReview
    /// The listing is already posted, so the tap handed its eBay page to the
    /// system instead of opening Listing Review.
    case openedEbayPosting
    case projectedRetry
    case rejected
}

@MainActor
protocol ProcessingActionExecuting {
    func execute(_ action: TrophyWallProcessingAction) async -> ProcessingActionOutcome
}

@MainActor
struct ProcessingActionExecutor: ProcessingActionExecuting {
    let runStore: RunDetailStore
    let listingReviewStore: ListingReviewStore
    let guestClaimPresentation: ProcessingGuestClaimPresentationHost
    let listingReviewPresentation: ListingReviewPresentationHost
    let applyRetryResult: (DurableRun) -> Bool
    let selectScan: () -> Void
    /// Where a posted listing's eBay page goes. Both are absent for surfaces
    /// that only ever open drafts.
    let ebayPublishService: (any EbayPublishFeatureServing)?
    let openExternalURL: ((URL) -> Void)?

    init(
        runStore: RunDetailStore,
        listingReviewStore: ListingReviewStore,
        guestClaimPresentation: ProcessingGuestClaimPresentationHost,
        listingReviewPresentation: ListingReviewPresentationHost,
        applyRetryResult: @escaping (DurableRun) -> Bool,
        selectScan: @escaping () -> Void,
        ebayPublishService: (any EbayPublishFeatureServing)? = nil,
        openExternalURL: ((URL) -> Void)? = nil
    ) {
        self.runStore = runStore
        self.listingReviewStore = listingReviewStore
        self.guestClaimPresentation = guestClaimPresentation
        self.listingReviewPresentation = listingReviewPresentation
        self.applyRetryResult = applyRetryResult
        self.selectScan = selectScan
        self.ebayPublishService = ebayPublishService
        self.openExternalURL = openExternalURL
    }

    func execute(_ action: TrophyWallProcessingAction) async -> ProcessingActionOutcome {
        switch action {
        case .scan:
            selectScan()
            return .selectedScan
        case .review(let runID):
            // The run check and the canonical review fetch both need only the
            // run id, so the review starts now instead of after a whole round
            // trip. `open` adopts it only for this exact run and still runs
            // every binding, revision and principal check; any path that does
            // not open the review abandons it here.
            listingReviewStore.beginCanonicalFetch(runID: runID)
            defer { listingReviewStore.abandonCanonicalFetch(runID: runID) }
            guard let route = await runStore.processingReviewRoute(for: runID)
            else {
                return await openEbayPosting(runID: runID) ?? .rejected
            }
            switch route {
            case .guestClaim(let context):
                guard guestClaimPresentation.present(context) else {
                    return .rejected
                }
                return .presentedGuestClaim
            case .listingReview(let review):
                guard await listingReviewPresentation.open(
                    review,
                    expecting: review.binding,
                    using: listingReviewStore
                ) else {
                    return .rejected
                }
                return .presentedReview
            }
        case .retry(let runID):
            guard let retried = await runStore.processingRetry(for: runID),
                  applyRetryResult(retried) else {
                return .rejected
            }
            return .projectedRetry
        }
    }

    /// A posted listing normally opens Listing Review read-only. Where the
    /// server cannot read it yet, a tile for a listing already live on eBay
    /// lands here. Only eBay's confirmed publication of that
    /// listing yields a destination; anything else stays refused.
    private func openEbayPosting(runID: UUID) async -> ProcessingActionOutcome? {
        guard let ebayPublishService,
              let openExternalURL,
              let listingID = await runStore.finishedListingWithoutReview(for: runID),
              let url = await EbayOwnListingDestination.resolve(
                  listingID: listingID,
                  service: ebayPublishService
              ) else {
            return nil
        }
        openExternalURL(url)
        return .openedEbayPosting
    }
}
