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

    init(
        runStore: RunDetailStore,
        listingReviewStore: ListingReviewStore,
        guestClaimPresentation: ProcessingGuestClaimPresentationHost,
        listingReviewPresentation: ListingReviewPresentationHost,
        applyRetryResult: @escaping (DurableRun) -> Bool,
        selectScan: @escaping () -> Void
    ) {
        self.runStore = runStore
        self.listingReviewStore = listingReviewStore
        self.guestClaimPresentation = guestClaimPresentation
        self.listingReviewPresentation = listingReviewPresentation
        self.applyRetryResult = applyRetryResult
        self.selectScan = selectScan
    }

    func execute(_ action: TrophyWallProcessingAction) async -> ProcessingActionOutcome {
        switch action {
        case .scan:
            selectScan()
            return .selectedScan
        case .review(let runID):
            guard let route = await runStore.processingReviewRoute(for: runID)
            else {
                return .rejected
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
}
