import SwiftUI
import UIKit

// MARK: - Trophy Wall

struct TrophyWallView: View {
    /// What the wall body may claim, given the tiles it holds and what the client
    /// actually proved about the collection.
    struct Presentation: Equatable {
        let showsGrid: Bool
        let showsEmptyView: Bool
        let offlineNotice: String?
        let refreshUnavailableNotice: String?
        let collectionMessage: TrophyWallProcessingView.CollectionMessage?
    }

    /// Derived from the approved metrics rather than written as literals, so a
    /// column count or gutter that drifts from the contract fails a test instead
    /// of shipping.
    static let gridColumns: [GridItem] = Array(
        repeating: GridItem(
            .flexible(),
            spacing: TrophyWallGridMetrics.gutterPoints
        ),
        count: TrophyWallGridMetrics.columnCount
    )

    @Bindable var store: TrophyWallStore
    let openProcessing: () -> Void
    let openAccount: () -> Void
    let onScan: () -> Void
    let onTryAgain: () -> Void

    @ScaledMetric(relativeTo: .title) private var titleSize = 28

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Text("Trophy Wall")
                    .font(.system(size: titleSize, weight: .bold))
                    .tracking(-0.5)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .accessibilityAddTraits(.isHeader)

                Spacer(minLength: 0)

                Button(action: openProcessing) {
                    Image(systemName: "clock")
                        .font(.system(size: 18, weight: .medium))
                        .frame(
                            width: SnapListMetrics.minimumTouchTarget,
                            height: SnapListMetrics.minimumTouchTarget
                        )
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .accessibilityLabel("Processing")
                .accessibilityIdentifier("trophy.wall.processing")

                Button(action: openAccount) {
                    Text("A")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(SnapListColorToken.textSecondary.color)
                        .frame(width: 36, height: 36)
                        .background(SnapListColorToken.hairline.color)
                        .clipShape(.circle)
                        .frame(
                            width: SnapListMetrics.minimumTouchTarget,
                            height: SnapListMetrics.minimumTouchTarget
                        )
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Account, opens Settings")
                .accessibilityIdentifier("trophy.wall.account")
            }
            .padding(.leading, 19)
            .padding(.trailing, 16)
            .padding(.bottom, 12)

            wallBody
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(SnapListColorToken.canvas.color)
        // On a plain stack the identifier binds to no element of its own and
        // propagates down instead, so the header buttons were all published as
        // `trophy.wall` and `trophy.wall.processing` resolved to nothing.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("trophy.wall")
    }

    /// Trophy Wall is the seller's one return destination, so a collection it
    /// could not load may not render as a blank canvas. The offline notice is a
    /// claim about saved items and stays truthful only while there are saved
    /// items; without them, both reachability failures collapse to the same
    /// recovery group the pushed Processing screen already ships.
    /// `refreshRecovery` carries no default on purpose. A default let the wall
    /// itself omit the argument and silently present `.idle`, which made the
    /// notice unreachable in production while every seam test still passed.
    static func presentation(
        hasSettledTiles: Bool,
        collectionOutcome: TrophyWallCollectionOutcome,
        refreshRecovery: TrophyWallCollectionRefreshRecovery
    ) -> Presentation {
        guard !hasSettledTiles else {
            return Presentation(
                showsGrid: true,
                showsEmptyView: false,
                offlineNotice: collectionOutcome == .offline
                    ? TrophyWallProcessingView.offlineNoticeText
                    : nil,
                refreshUnavailableNotice: TrophyWallProcessingView
                    .refreshUnavailableNotice(
                        for: collectionOutcome,
                        refreshRecovery: refreshRecovery
                    ),
                collectionMessage: nil
            )
        }

        switch collectionOutcome {
        case .unknown:
            // Nothing has been proved, so no empty success may be claimed.
            return Presentation(
                showsGrid: false,
                showsEmptyView: false,
                offlineNotice: nil,
                refreshUnavailableNotice: nil,
                collectionMessage: nil
            )
        case .loaded:
            return Presentation(
                showsGrid: false,
                showsEmptyView: true,
                offlineNotice: nil,
                refreshUnavailableNotice: nil,
                collectionMessage: nil
            )
        case .offline, .unavailable:
            return Presentation(
                showsGrid: false,
                showsEmptyView: false,
                offlineNotice: nil,
                refreshUnavailableNotice: nil,
                collectionMessage: TrophyWallProcessingView
                    .unavailableCollectionMessage
            )
        }
    }

    @ViewBuilder
    private var wallBody: some View {
        let presentation = Self.presentation(
            hasSettledTiles: !store.settledTiles.isEmpty,
            collectionOutcome: store.collectionOutcome,
            refreshRecovery: store.collectionRefreshRecovery
        )

        if let offlineNotice = presentation.offlineNotice {
            TrophyWallNoticeStripView(
                text: offlineNotice,
                identifier: TrophyWallProcessingView.offlineNoticeIdentifier,
                announcesOnAppear: false
            )
        }

        if let refreshUnavailableNotice = presentation.refreshUnavailableNotice {
            TrophyWallNoticeStripView(
                text: refreshUnavailableNotice,
                identifier: TrophyWallProcessingView
                    .refreshUnavailableNoticeIdentifier,
                announcesOnAppear: true
            )
        }

        if let collectionMessage = presentation.collectionMessage {
            TrophyWallCollectionMessageView(
                message: collectionMessage,
                onScan: onScan,
                onTryAgain: onTryAgain
            )
        }

        if presentation.showsEmptyView {
            TrophyWallEmptyView(onScan: onScan)
        }

        if presentation.showsGrid {
            ScrollView {
                LazyVGrid(
                    columns: Self.gridColumns,
                    spacing: TrophyWallGridMetrics.gutterPoints
                ) {
                    ForEach(store.settledTiles) { tile in
                        TrophyWallSettledTileView(tile: tile)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, TrophyWallGridMetrics.bottomPaddingPoints)
            }
            .scrollIndicators(.hidden)
            .accessibilityIdentifier("trophy.wall.grid")
        }
    }
}

private struct TrophyWallSettledTileView: View {
    let tile: TrophyWallSettledTile

    var body: some View {
        SnapListColorToken.quietFill.color
            .aspectRatio(TrophyWallGridMetrics.tileAspectRatio, contentMode: .fit)
            .overlay {
                photo
            }
        .clipShape(
            .rect(cornerRadius: TrophyWallGridMetrics.tileCornerRadiusPoints)
        )
        .overlay {
            RoundedRectangle(
                cornerRadius: TrophyWallGridMetrics.tileCornerRadiusPoints
            )
            .stroke(SnapListColorToken.hairline.color, lineWidth: 0.5)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(tile.accessibilityLabel)
        .accessibilityAddTraits(.isImage)
    }

    @ViewBuilder
    private var photo: some View {
        GeometryReader { proxy in
            if let coverPhotoAssetName = tile.coverPhotoAssetName {
                Image(coverPhotoAssetName)
                    .resizable()
                    .scaledToFill()
                    .frame(width: proxy.size.width, height: proxy.size.height)
                    .scaleEffect(tile.coverPhotoCrop.scale, anchor: tile.coverPhotoCrop.anchor)
                    .frame(width: proxy.size.width, height: proxy.size.height)
                    .clipped()
            } else if let coverPhotoURL = tile.coverPhotoURL {
                AsyncImage(url: coverPhotoURL) { image in
                    image
                        .resizable()
                        .scaledToFill()
                        .frame(width: proxy.size.width, height: proxy.size.height)
                        .clipped()
                } placeholder: {
                    fallback
                }
            } else {
                fallback
            }
        }
    }

    private var fallback: some View {
        Text(tile.itemName)
            .snapListTypography(.status)
            .fontWeight(.semibold)
            .foregroundStyle(SnapListColorToken.textSecondary.color)
            .multilineTextAlignment(.center)
            .padding(12)
    }
}

private extension TrophyWallPhotoCrop {
    var scale: CGFloat {
        switch self {
        case .full: 1
        case .detailLeading, .detailTrailing, .detailTop: 1.32
        }
    }

    var anchor: UnitPoint {
        switch self {
        case .full: .center
        case .detailLeading: .leading
        case .detailTrailing: .trailing
        case .detailTop: .top
        }
    }
}

private struct TrophyWallEmptyView: View {
    let onScan: () -> Void

    var body: some View {
        VStack(spacing: TrophyWallEmptyMetrics.contentSpacing) {
            Image("ScoutUncertain")
                .resizable()
                .scaledToFit()
                .frame(height: TrophyWallEmptyMetrics.scoutHeight)
                .padding(.bottom, TrophyWallEmptyMetrics.scoutOpticalBottomInset)
                .accessibilityLabel("Scout, the SnapList camera helper")

            Text("No items yet")
                .snapListTypography(.cardTitle)
                .fontWeight(.bold)
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .multilineTextAlignment(.center)

            Button(action: onScan) {
                Text("Scan an item")
                    .snapListTypography(.rowTitle)
                    .foregroundStyle(SnapListColorToken.canvas.color)
                    .padding(.horizontal, 28)
                    .frame(minHeight: 52)
                    .background(SnapListColorToken.action.color)
                    .clipShape(.rect(cornerRadius: 14))
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("trophy.wall.scan")
        }
        .padding(.horizontal, TrophyWallEmptyMetrics.horizontalPadding)
        .padding(.bottom, TrophyWallEmptyMetrics.bottomPadding)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // Same plain-stack binding as `trophy.wall`: without this the identifier
        // propagates down and overwrites `trophy.wall.scan` on the button above.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("trophy.wall.empty")
    }
}

// MARK: - Trophy Wall Processing

struct TrophyWallProcessingView: View {
    struct Presentation: Equatable {
        let visibleRows: [TrophyWallProcessingRow]
        let disclosureLabel: String?
        let disclosureAccessibilityLabel: String?
        let offlineNotice: String?
        let refreshUnavailableNotice: String?
        let collectionMessage: CollectionMessage?
    }

    /// The centered group shown when there is no row to show at all. It states
    /// only what the client proved and offers exactly one recovery action.
    struct CollectionMessage: Equatable {
        enum Action: Equatable {
            case scan(label: String)
            case tryAgain(label: String)
        }

        let heading: String
        let action: Action
        let scoutImageName: String
        let scoutAccessibilityLabel: String
    }

    struct DisclosureTransition: Equatable {
        let isExpanded: Bool
        let announcement: String
    }

    private static let smallestSupportedHeight: CGFloat = 667
    private static let compactRowLimit = 3
    private static let smallestHeightRowLimit = 2
    private static let scoutAccessibilityLabel = "Scout, the SnapList camera helper"
    // Trophy Wall and the pushed Processing screen describe the same collection
    // failure, so they share one sentence for it rather than drifting into two.
    static let offlineNoticeText = "You're offline. Showing saved items."
    static let offlineNoticeIdentifier = "trophy.processing.offline"
    // A reached-but-broken boundary is not an offline device, so it gets its own
    // sentence. The seller only sees it once SnapList has stopped retrying, and
    // it carries no control: there is nothing left for a tap to add.
    static let refreshUnavailableNoticeText = "Can't refresh. Showing saved items."
    static let refreshUnavailableNoticeIdentifier =
        "trophy.processing.refresh-unavailable"
    private static let emptyCollectionMessage = CollectionMessage(
        heading: "Nothing is processing.",
        action: .scan(label: "Scan an item"),
        scoutImageName: "ScoutUncertain",
        scoutAccessibilityLabel: scoutAccessibilityLabel
    )
    static let unavailableCollectionMessage = CollectionMessage(
        heading: "Processing unavailable",
        action: .tryAgain(label: "Try again"),
        scoutImageName: "ScoutRetryReview",
        scoutAccessibilityLabel: scoutAccessibilityLabel
    )

    @ScaledMetric(relativeTo: .title2) private var titleSize = 24
    @ScaledMetric(relativeTo: .callout) private var disclosureSize = 14
    @AccessibilityFocusState private var isDisclosureFocused: Bool
    @State private var isExpanded = false

    let rows: [TrophyWallProcessingRow]
    let collectionOutcome: TrophyWallCollectionOutcome
    let refreshRecovery: TrophyWallCollectionRefreshRecovery
    let onBack: () -> Void
    let openRoute: (HomeRoute) -> Void
    let onAction: (TrophyWallProcessingAction) -> Void
    let onScan: () -> Void
    let onTryAgain: () -> Void

    init(
        rows: [TrophyWallProcessingRow],
        collectionOutcome: TrophyWallCollectionOutcome = .unknown,
        refreshRecovery: TrophyWallCollectionRefreshRecovery = .idle,
        onBack: @escaping () -> Void,
        openRoute: @escaping (HomeRoute) -> Void,
        onAction: @escaping (TrophyWallProcessingAction) -> Void,
        onScan: @escaping () -> Void,
        onTryAgain: @escaping () -> Void
    ) {
        self.rows = rows
        self.collectionOutcome = collectionOutcome
        self.refreshRecovery = refreshRecovery
        self.onBack = onBack
        self.openRoute = openRoute
        self.onAction = onAction
        self.onScan = onScan
        self.onTryAgain = onTryAgain
    }

    var body: some View {
        GeometryReader { proxy in
            let presentation = Self.presentation(
                from: rows,
                collectionOutcome: collectionOutcome,
                refreshRecovery: refreshRecovery,
                availableHeight: proxy.size.height,
                isExpanded: isExpanded
            )

            VStack(spacing: 0) {
                HStack(spacing: 4) {
                    Button(action: onBack) {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 18, weight: .semibold))
                            .frame(
                                width: SnapListMetrics.minimumTouchTarget,
                                height: SnapListMetrics.minimumTouchTarget
                            )
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .accessibilityLabel("Back to Trophy Wall")
                    .accessibilityIdentifier("trophy.processing.back")

                    Text("Processing")
                        .font(.system(size: titleSize, weight: .bold))
                        .tracking(-0.5)
                        .foregroundStyle(SnapListColorToken.inkPrimary.color)

                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 8)
                .padding(.bottom, 10)

                if let offlineNotice = presentation.offlineNotice {
                    TrophyWallNoticeStripView(
                        text: offlineNotice,
                        identifier: Self.offlineNoticeIdentifier,
                        announcesOnAppear: false
                    )
                }

                if let refreshUnavailableNotice =
                    presentation.refreshUnavailableNotice {
                    TrophyWallNoticeStripView(
                        text: refreshUnavailableNotice,
                        identifier: Self.refreshUnavailableNoticeIdentifier,
                        announcesOnAppear: true
                    )
                }

                if let collectionMessage = presentation.collectionMessage {
                    TrophyWallCollectionMessageView(
                        message: collectionMessage,
                        onScan: onScan,
                        onTryAgain: onTryAgain
                    )
                }

                if !presentation.visibleRows.isEmpty {
                    ScrollView {
                        VStack(spacing: 0) {
                            ForEach(presentation.visibleRows) { row in
                                TrophyWallProcessingRowView(
                                    row: row,
                                    openRoute: openRoute,
                                    onAction: onAction
                                )

                                if row.id != presentation.visibleRows.last?.id {
                                    Divider()
                                        .foregroundStyle(SnapListColorToken.hairline.color)
                                        .padding(.leading, 69)
                                }
                            }

                            if let disclosureLabel = presentation.disclosureLabel,
                               let disclosureAccessibilityLabel =
                                   presentation.disclosureAccessibilityLabel {
                                Divider()
                                    .foregroundStyle(SnapListColorToken.divider.color)

                                Button {
                                    let transition = Self.disclosureTransition(
                                        from: isExpanded
                                    )
                                    isExpanded = transition.isExpanded
                                    isDisclosureFocused = true
                                    UIAccessibility.post(
                                        notification: .announcement,
                                        argument: transition.announcement
                                    )
                                } label: {
                                    Text(disclosureLabel)
                                        .font(
                                            .system(
                                                size: disclosureSize,
                                                weight: .semibold
                                            )
                                        )
                                        .foregroundStyle(SnapListColorToken.action.color)
                                        .lineLimit(1)
                                        .frame(
                                            maxWidth: .infinity,
                                            minHeight: SnapListMetrics.minimumTouchTarget
                                        )
                                        .contentShape(.rect)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel(disclosureAccessibilityLabel)
                                .accessibilityValue(
                                    isExpanded ? "Expanded" : "Collapsed"
                                )
                                .accessibilityIdentifier(
                                    "trophy.processing.disclosure"
                                )
                                .accessibilityFocused($isDisclosureFocused)
                            }
                        }
                        .background(SnapListColorToken.canvas.color)
                        .clipShape(.rect(cornerRadius: 14))
                        .overlay {
                            RoundedRectangle(cornerRadius: 14)
                                .stroke(SnapListColorToken.hairline.color, lineWidth: 1)
                        }
                        .padding(.horizontal, 14)
                        .padding(.top, 8)
                    }
                    .scrollIndicators(.hidden)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .background(SnapListColorToken.canvas.color)
        // Same plain-stack binding as `trophy.wall`: without this the identifier
        // publishes no element of its own and propagates onto the descendants.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("trophy.processing")
    }

    static func visibleRows(
        from rows: [TrophyWallProcessingRow],
        availableHeight: CGFloat
    ) -> [TrophyWallProcessingRow] {
        let limit = availableHeight <= smallestSupportedHeight
            ? smallestHeightRowLimit
            : compactRowLimit
        return Array(rows.prefix(limit))
    }

    /// `refreshRecovery` carries no default for the same reason it carries none
    /// on `TrophyWallView.presentation`: an omitted argument must not be able to
    /// masquerade as a deliberate `.idle`.
    static func presentation(
        from rows: [TrophyWallProcessingRow],
        collectionOutcome: TrophyWallCollectionOutcome = .unknown,
        refreshRecovery: TrophyWallCollectionRefreshRecovery,
        availableHeight: CGFloat,
        isExpanded: Bool
    ) -> Presentation {
        guard !rows.isEmpty else {
            return Presentation(
                visibleRows: [],
                disclosureLabel: nil,
                disclosureAccessibilityLabel: nil,
                offlineNotice: nil,
                refreshUnavailableNotice: nil,
                collectionMessage: collectionMessage(for: collectionOutcome)
            )
        }

        // Both notices are claims about saved items, so they are only truthful
        // while there are saved items to show. One collection attempt produces
        // one outcome, so they can never both be non-nil.
        let offlineNotice = collectionOutcome == .offline ? offlineNoticeText : nil
        let refreshUnavailableNotice = refreshUnavailableNotice(
            for: collectionOutcome,
            refreshRecovery: refreshRecovery
        )
        let clampedRows = visibleRows(
            from: rows,
            availableHeight: availableHeight
        )
        let hiddenCount = rows.count - clampedRows.count
        guard hiddenCount > 0 else {
            return Presentation(
                visibleRows: rows,
                disclosureLabel: nil,
                disclosureAccessibilityLabel: nil,
                offlineNotice: offlineNotice,
                refreshUnavailableNotice: refreshUnavailableNotice,
                collectionMessage: nil
            )
        }

        if isExpanded {
            return Presentation(
                visibleRows: rows,
                disclosureLabel: "Show less",
                disclosureAccessibilityLabel: "Show fewer items",
                offlineNotice: offlineNotice,
                refreshUnavailableNotice: refreshUnavailableNotice,
                collectionMessage: nil
            )
        }

        return Presentation(
            visibleRows: clampedRows,
            disclosureLabel: hiddenCount == 2 ? "Show 2 more" : "Show more",
            disclosureAccessibilityLabel: hiddenCount == 2
                ? "Show 2 more items"
                : "Show more items",
            offlineNotice: offlineNotice,
            refreshUnavailableNotice: refreshUnavailableNotice,
            collectionMessage: nil
        )
    }

    /// A refused refresh only earns a sentence once SnapList has spent its own
    /// bounded attempts. Before that the seller would be told about a failure
    /// the client is still fixing, and after a success there is nothing to say.
    static func refreshUnavailableNotice(
        for outcome: TrophyWallCollectionOutcome,
        refreshRecovery: TrophyWallCollectionRefreshRecovery
    ) -> String? {
        guard outcome == .unavailable, refreshRecovery == .exhausted else {
            return nil
        }
        return refreshUnavailableNoticeText
    }

    private static func collectionMessage(
        for outcome: TrophyWallCollectionOutcome
    ) -> CollectionMessage? {
        switch outcome {
        case .unknown:
            // Nothing has been proved, so no empty success may be claimed.
            nil
        case .loaded:
            emptyCollectionMessage
        case .offline, .unavailable:
            // Without a saved row there is no cached truth to keep, so both
            // reachability failures collapse to the same recovery state.
            unavailableCollectionMessage
        }
    }

    static func disclosureTransition(
        from isExpanded: Bool
    ) -> DisclosureTransition {
        let nextExpanded = !isExpanded
        return DisclosureTransition(
            isExpanded: nextExpanded,
            announcement: nextExpanded ? "Expanded" : "Collapsed"
        )
    }
}

/// One passive strip shared by every rows-mode collection notice. It carries no
/// control and cannot be dismissed: it describes what the client knows, and it
/// leaves when a later refresh proves something better.
private struct TrophyWallNoticeStripView: View {
    let text: String
    let identifier: String
    /// Announced once when the condition appears. The offline strip predates
    /// this and stays silent so its approved behavior is unchanged.
    let announcesOnAppear: Bool

    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(SnapListColorToken.textTertiary.color)
                .frame(width: 8, height: 8)
                .accessibilityHidden(true)

            Text(text)
                .snapListTypography(.status)
                .foregroundStyle(SnapListColorToken.textSecondary.color)
                .fixedSize(horizontal: false, vertical: true)

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 13)
        .padding(.vertical, 11)
        .background(SnapListColorToken.groupingFill.color)
        .clipShape(.rect(cornerRadius: 12))
        .overlay {
            RoundedRectangle(cornerRadius: 12)
                .stroke(SnapListColorToken.hairline.color, lineWidth: 1)
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(text)
        .accessibilityIdentifier(identifier)
        .onAppear {
            guard announcesOnAppear else { return }
            // Low priority so the notice waits its turn instead of cutting off
            // whatever VoiceOver is already saying. The seller is looking at
            // saved rows either way; nothing here is worth an interruption.
            UIAccessibility.post(
                notification: .announcement,
                argument: NSAttributedString(
                    string: text,
                    attributes: [
                        .accessibilitySpeechAnnouncementPriority:
                            UIAccessibilityPriority.low
                    ]
                )
            )
        }
    }
}

struct TrophyWallCollectionMessageView: View {
    // Only the approved static Scout artwork ships today. It is the approved
    // Reduced Motion fallback, so it stays honest under any motion setting.
    private static let scoutHeight: CGFloat = 150

    let message: TrophyWallProcessingView.CollectionMessage
    let onScan: () -> Void
    let onTryAgain: () -> Void

    @ScaledMetric(relativeTo: .title3) private var headingSize = 18

    var body: some View {
        VStack(spacing: 20) {
            Image(message.scoutImageName)
                .resizable()
                .scaledToFit()
                .frame(height: Self.scoutHeight)
                .accessibilityLabel(message.scoutAccessibilityLabel)

            Text(message.heading)
                .font(.system(size: headingSize, weight: .bold))
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("trophy.processing.collection.heading")

            action
        }
        .padding(.horizontal, 34)
        .padding(.top, 24)
        .padding(.bottom, 104)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("trophy.processing.collection")
    }

    @ViewBuilder
    private var action: some View {
        switch message.action {
        case .scan(let label):
            Button(action: onScan) {
                Text(label)
                    .snapListTypography(.rowTitle)
                    .foregroundStyle(SnapListColorToken.canvas.color)
                    .padding(.horizontal, 28)
                    .frame(minHeight: 52)
                    .background(SnapListColorToken.action.color)
                    .clipShape(.rect(cornerRadius: 14))
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(label)
            .accessibilityIdentifier("trophy.processing.collection.scan")
        case .tryAgain(let label):
            Button(action: onTryAgain) {
                Text(label)
                    .snapListTypography(.rowTitle)
                    .foregroundStyle(SnapListColorToken.actionDeep.color)
                    .padding(.horizontal, 22)
                    .frame(minHeight: SnapListMetrics.minimumTouchTarget)
                    .background(SnapListColorToken.actionTint.color)
                    .clipShape(.rect(cornerRadius: 12))
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(label)
            .accessibilityIdentifier("trophy.processing.collection.try-again")
        }
    }
}

private struct TrophyWallProcessingRowView: View {
    let row: TrophyWallProcessingRow
    let openRoute: (HomeRoute) -> Void
    let onAction: (TrophyWallProcessingAction) -> Void

    var body: some View {
        HStack(spacing: 0) {
            Group {
                if let destination = row.destination {
                    Button {
                        openRoute(destination)
                    } label: {
                        content
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(row.accessibilityLabel)
                    .accessibilityIdentifier(row.accessibilityIdentifier)
                } else {
                    content
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(row.accessibilityLabel)
                        .accessibilityIdentifier(row.accessibilityIdentifier)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if let action = row.action {
                Button {
                    onAction(action)
                } label: {
                    Text(action.label)
                        .snapListTypography(.status)
                        .foregroundStyle(action.foregroundColor)
                        .frame(minWidth: SnapListMetrics.minimumTouchTarget)
                        .frame(minHeight: SnapListMetrics.minimumTouchTarget)
                        .padding(.horizontal, 10)
                        .background(action.backgroundColor)
                        .clipShape(.rect(cornerRadius: 12))
                        .overlay {
                            if action.showsBorder {
                                RoundedRectangle(cornerRadius: 12)
                                    .stroke(
                                        SnapListColorToken.hairline.color,
                                        lineWidth: 1
                                    )
                            }
                        }
                }
                .buttonStyle(.plain)
                .accessibilityLabel(action.accessibilityLabel(for: row.itemName))
                .accessibilityIdentifier(action.accessibilityIdentifier)
                .padding(.trailing, 14)
            }
        }
    }

    private var content: some View {
        HStack(spacing: 11) {
            RoundedRectangle(cornerRadius: 10)
                .fill(SnapListColorToken.hairline.color)
                .frame(width: 44, height: 44)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text(row.itemName)
                    .snapListTypography(.rowTitle)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)

                if row.action == nil {
                    Text(row.stateLabel)
                        .snapListTypography(.status)
                        .foregroundStyle(
                            row.destination == nil
                                ? SnapListColorToken.textSecondary.color
                                : SnapListColorToken.inkPrimary.color
                        )
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .frame(minHeight: 66)
        .contentShape(.rect)
    }
}

private extension TrophyWallProcessingAction {
    var label: String {
        switch self {
        case .review:
            "Review"
        case .retry:
            "Retry"
        case .scan:
            "Scan"
        }
    }

    var accessibilityIdentifier: String {
        switch self {
        case .review(let runID):
            "trophy.processing.action.review.\(runID.uuidString.lowercased())"
        case .retry(let runID):
            "trophy.processing.action.retry.\(runID.uuidString.lowercased())"
        case .scan(let runID):
            "trophy.processing.action.scan.\(runID.uuidString.lowercased())"
        }
    }

    func accessibilityLabel(for itemName: String) -> String {
        switch self {
        case .review:
            "Review \(itemName)"
        case .retry:
            "Retry \(itemName)"
        case .scan:
            "Scan a new photo for \(itemName)"
        }
    }

    var backgroundColor: Color {
        switch self {
        case .review, .retry:
            SnapListColorToken.actionTint.color
        case .scan:
            SnapListColorToken.canvas.color
        }
    }

    var foregroundColor: Color {
        switch self {
        case .review, .retry:
            SnapListColorToken.actionDeep.color
        case .scan:
            SnapListColorToken.inkPrimary.color
        }
    }

    var showsBorder: Bool {
        if case .scan = self {
            true
        } else {
            false
        }
    }
}
