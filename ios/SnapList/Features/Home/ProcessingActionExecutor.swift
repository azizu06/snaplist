import Foundation

@MainActor
enum ProcessingActionOutcome: Equatable {
    case selectedScan
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
    let listingReviewPresentation: ListingReviewPresentationHost
    let applyRetryResult: (DurableRun) -> Bool
    let selectScan: () -> Void

    func execute(_ action: TrophyWallProcessingAction) async -> ProcessingActionOutcome {
        switch action {
        case .scan:
            selectScan()
            return .selectedScan
        case .review(let runID):
            guard let review = await runStore.processingReview(for: runID),
                  await listingReviewPresentation.open(
                      review,
                      expecting: review.binding,
                      using: listingReviewStore
                  ) else {
                return .rejected
            }
            return .presentedReview
        case .retry(let runID):
            guard let retried = await runStore.processingRetry(for: runID),
                  applyRetryResult(retried) else {
                return .rejected
            }
            return .projectedRetry
        }
    }
}
