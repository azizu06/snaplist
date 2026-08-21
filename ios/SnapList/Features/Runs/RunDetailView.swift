import SwiftUI

@MainActor
struct RunDetailView: View {
    let runID: UUID
    @Bindable var store: RunDetailStore
    @Bindable var listingReviewStore: ListingReviewStore
    let correctionAvailable: Bool
    let forceReducedMotion: Bool
    let goToTrophyWall: () -> Void
    let startNewItem: () -> Void
    var activationProcessingOpened: () -> Void = {}
    var activationListingReviewOpened: () -> Void = {}
    var activationListingReviewDismissed: () -> Void = {}
    var activationListingReviewInteraction: () -> Void = {}
    @State private var listingReviewPresentation =
        ListingReviewPresentationHost()
    @AccessibilityFocusState private var reviewOpenerFocused: Bool

    var body: some View {
        @Bindable var listingReviewPresentation = listingReviewPresentation
        ScrollView {
            VStack(alignment: .leading, spacing: SnapListMetrics.screenGutter) {
                switch store.state {
                case .idle, .loading:
                    ProgressView("Checking your run…")
                case .unavailable:
                    ContentUnavailableView(
                        "Run unavailable",
                        systemImage: "exclamationmark.circle",
                        description: Text("We couldn’t load this run.")
                    )
                case .loaded(let run):
                    loadedContent(run)
                }

                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .padding(SnapListMetrics.screenGutter)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("run.detail")
        }
        .accessibilityIdentifier("run.detail.scroll")
        .navigationTitle("Run status")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await store.refresh() }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.plain)
                .frame(
                    width: SnapListMetrics.minimumTouchTarget,
                    height: SnapListMetrics.minimumTouchTarget
                )
                .fixedSize()
                .contentShape(Rectangle())
                .accessibilityLabel("Refresh")
                .accessibilityIdentifier("run.refresh")
                .disabled(isLoading)
            }
        }
        .task(id: runID) {
            await store.load(runID: runID)
        }
        .onAppear {
            activationProcessingOpened()
        }
        .onChange(of: listingReviewPresentation.isPresented) { _, isPresented in
            if !isPresented {
                activationListingReviewDismissed()
            }
        }
        .navigationDestination(isPresented: $listingReviewPresentation.isPresented) {
            ListingReviewView(
                store: listingReviewStore,
                correctionAvailable: correctionAvailable,
                forceReducedMotion: forceReducedMotion,
                dismissReview: dismissListingReview,
                goToTrophyWall: goToTrophyWall,
                startNewItem: startNewItem,
                activationInteraction: activationListingReviewInteraction
            )
        }
    }

    @ViewBuilder
    private func loadedContent(_ run: DurableRun) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(run.sellerFacingHeading)
                .snapListTypography(.metadata)
                .foregroundStyle(SnapListColorToken.textSecondary.color)

            if let item = run.item {
                Text(item.title)
                    .snapListTypography(.sectionHeader)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
            }

            Label(run.status.sellerFacingLabel, systemImage: run.status.systemImage)
                .snapListTypography(.status)
                .foregroundStyle(SnapListColorToken.action.color)

            Text(run.sellerFacingDetail)
                .snapListTypography(.body)
                .foregroundStyle(SnapListColorToken.inkPrimary.color)

            if run.legalActions.canOpenReview,
               let review = run.review {
                Button {
                    Task { await openListingReview(review) }
                } label: {
                    HStack(spacing: 8) {
                        if listingReviewPresentation.isOpening {
                            ProgressView()
                                .accessibilityHidden(true)
                        }
                        Text(listingReviewPresentation.isOpening ? "Opening…" : "Review")
                            .snapListTypography(.rowTitle)
                    }
                    .frame(minHeight: SnapListMetrics.minimumTouchTarget)
                    .padding(.horizontal, 16)
                    .background(
                        SnapListColorToken.action.color.opacity(0.1),
                        in: RoundedRectangle(cornerRadius: 12)
                    )
                }
                .buttonStyle(.plain)
                .foregroundStyle(SnapListColorToken.action.color)
                .disabled(listingReviewPresentation.isOpening)
                .accessibilityLabel("Review \(run.item?.title ?? "listing")")
                .accessibilityFocused($reviewOpenerFocused)
                .accessibilityIdentifier("run.review.open")
            }

            if listingReviewPresentation.openFailed {
                Text(ListingReviewCopy.openFailed)
                    .snapListTypography(.body)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .accessibilityIdentifier("run.review.open-failed")
            }

            if run.legalActions.canRetry {
                Button {
                    Task { await store.retry() }
                } label: {
                    Text(store.isRetrying ? "Retrying" : "Retry")
                        .snapListTypography(.rowTitle)
                        .frame(minHeight: SnapListMetrics.minimumTouchTarget)
                        .padding(.horizontal, 16)
                        .background(
                            SnapListColorToken.action.color.opacity(0.1),
                            in: RoundedRectangle(cornerRadius: 12)
                        )
                }
                .buttonStyle(.plain)
                .foregroundStyle(SnapListColorToken.action.color)
                .disabled(store.isRetrying)
                .accessibilityIdentifier("run.retry")
            } else if run.legalActions.canStartNewCapture {
                Button("Scan", action: startNewItem)
                    .buttonStyle(.borderedProminent)
                    .tint(SnapListColorToken.action.color)
                    .frame(minHeight: SnapListMetrics.minimumTouchTarget)
                    .accessibilityIdentifier("run.scan")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(SnapListMetrics.screenGutter)
        .background(SnapListColorToken.groupingFill.color, in: RoundedRectangle(cornerRadius: 18))
    }

    private var isLoading: Bool {
        store.state == .loading
    }

    private func openListingReview(
        _ review: ListingReviewResult
    ) async {
        let opened = await listingReviewPresentation.open(
            review,
            expecting: review.binding,
            using: listingReviewStore
        )
        if opened {
            activationListingReviewOpened()
        }
    }

    private func dismissListingReview() {
        // Autosave can have advanced the review's server-side revision while
        // the screen was open. `store.state` still holds whatever revision
        // was current when this run last loaded, and the reopen guard in
        // `ListingReviewPresentationHost.open` refuses to open a review
        // whose binding no longer matches -- so leaving that stale until the
        // seller taps Review again would make every reopen fail.
        Task {
            await store.refresh()
            listingReviewPresentation.dismiss()
            reviewOpenerFocused = true
        }
    }
}

private extension DurableRun {
    var sellerFacingHeading: String {
        switch status {
        case .queued, .running, .retrying: "Working on your item"
        case .succeeded: "Run completed"
        case .failed: "Run failed"
        case .canceled: "Run canceled"
        }
    }
}

extension DurableRun {
    var sellerFacingDetail: String {
        switch status {
        case .queued, .running, .retrying:
            stage.sellerFacingActiveLabel
        case .succeeded:
            legalActions.canOpenReview ? "Ready to review" : "Review unavailable"
        case .failed:
            safeFailure?.detail ?? "Couldn’t finish"
        case .canceled:
            "Processing stopped"
        }
    }
}

extension DurableRunStatus {
    var sellerFacingLabel: String {
        switch self {
        case .queued: "Accepted"
        case .running: "Processing"
        case .retrying: "Trying again"
        case .succeeded: "Ready"
        case .failed: "Failed"
        case .canceled: "Canceled"
        }
    }

    var systemImage: String {
        switch self {
        case .queued: "clock"
        case .running, .retrying: "arrow.trianglehead.2.clockwise.rotate.90"
        case .succeeded: "checkmark.circle"
        case .failed: "exclamationmark.circle"
        case .canceled: "xmark.circle"
        }
    }
}

private extension DurableRunStage {
    var sellerFacingActiveLabel: String {
        switch self {
        case .queued: "Accepted"
        case .identifying: "Identifying your item"
        case .pricing: "Researching pricing evidence"
        case .generating: "Writing your listing"
        case .persisting: "Saving your listing"
        case .completed: "Checking run status"
        }
    }
}
