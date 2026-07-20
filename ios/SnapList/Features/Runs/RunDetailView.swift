import SwiftUI

@MainActor
struct RunDetailView: View {
    let runID: UUID
    @Bindable var store: RunDetailStore

    var body: some View {
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
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(SnapListMetrics.screenGutter)
        .background(SnapListColorToken.groupingFill.color, in: RoundedRectangle(cornerRadius: 18))
    }

    private var isLoading: Bool {
        store.state == .loading
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

    var sellerFacingDetail: String {
        switch status {
        case .queued, .running, .retrying:
            stage.sellerFacingActiveLabel
        case .succeeded:
            legalActions.canOpenReview ? "Ready to review" : "Review unavailable"
        case .failed:
            "Couldn’t finish"
        case .canceled:
            "Processing stopped"
        }
    }
}

private extension DurableRunStatus {
    var sellerFacingLabel: String {
        switch self {
        case .queued: "Queued"
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
        case .queued: "Waiting to start"
        case .identifying: "Identifying your item"
        case .pricing: "Researching pricing evidence"
        case .generating: "Writing your listing"
        case .persisting: "Saving your listing"
        case .completed: "Checking run status"
        }
    }
}
