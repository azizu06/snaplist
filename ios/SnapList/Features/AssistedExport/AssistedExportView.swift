import SwiftUI

/// The assisted-export screen (issue #581, design authority
/// `Assisted Export + Share Handoff v1`, XPORT-01 through XPORT-05).
///
/// Every seller-facing string on this screen comes from `AssistedExportCopy`,
/// never from a literal here. That is what keeps the vocabulary sweep in the
/// domain tests able to see this screen: a word like `Published` added to a view
/// would otherwise be invisible to it.

struct AssistedExportItemSummary: Equatable, Sendable {
    let title: String
    let priceText: String
    let preparedAtText: String
}

struct AssistedExportView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var domain: AssistedExportDomain
    private let summary: AssistedExportItemSummary
    /// The listing's current revision. It originates outside this screen — the
    /// seller can edit the listing from the review surface — so this screen
    /// observes it rather than owning it.
    private let listingRevision: UUID
    /// The pack the host currently holds. Preparing a replacement is the
    /// host's work, so this screen observes the result rather than building it.
    private let pack: AssistedExportPack
    private let now: @Sendable () -> Date
    /// The seller asking for a pack that matches the current listing. No
    /// default: a screen that cannot honour it should not offer the action.
    private let onUpdatePack: () -> Void
    /// Called when the confirm sheet is actually on screen, so a parent can
    /// coordinate around a presented modal.
    private let onConfirmSheetPresented: (() -> Void)?

    init(
        domain: AssistedExportDomain,
        summary: AssistedExportItemSummary,
        listingRevision: UUID,
        pack: AssistedExportPack,
        now: @escaping @Sendable () -> Date = Date.init,
        onUpdatePack: @escaping () -> Void,
        onConfirmSheetPresented: (() -> Void)? = nil
    ) {
        _domain = State(initialValue: domain)
        self.summary = summary
        self.listingRevision = listingRevision
        self.pack = pack
        self.now = now
        self.onUpdatePack = onUpdatePack
        self.onConfirmSheetPresented = onConfirmSheetPresented
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                itemIdentity
                if domain.isPackOutOfDate {
                    packOutOfDate
                } else {
                    packMeta
                }
                destinationRows
                Color.clear.frame(height: 40)
            }
        }
        .background(SnapListColorToken.canvas.color)
        .navigationTitle(AssistedExportCopy.screenTitle)
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("assisted-export.screen")
        .sheet(isPresented: confirmSheetBinding) {
            confirmSheet
        }
        .onChange(of: listingRevision) { _, revision in
            withMotion { domain.listingRevisionChanged(to: revision) }
        }
        .onChange(of: pack) { _, replacement in
            withMotion { domain.updatePack(to: replacement) }
        }
    }

    // MARK: - Identity

    private var itemIdentity: some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 10)
                .fill(SnapListColorToken.quietFill.color)
                .frame(width: 64, height: 64)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(summary.title)
                    .snapListTypography(.cardTitle)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                Text(summary.priceText)
                    .snapListTypography(.body)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .monospacedDigit()
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, SnapListMetrics.screenGutter)
        .padding(.top, 16)
        .padding(.bottom, 14)
    }

    private var packMeta: some View {
        Text(
            AssistedExportCopy.packMeta(
                photoCount: domain.pack.photoCount,
                preparedAt: summary.preparedAtText
            )
        )
        .snapListTypography(.status)
        .foregroundStyle(SnapListColorToken.textSecondary.color)
        .monospacedDigit()
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, SnapListMetrics.screenGutter)
        .padding(.bottom, 14)
        .accessibilityIdentifier("assisted-export.pack-meta")
    }

    // MARK: - XPORT-05

    private var packOutOfDate: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 9) {
                Image(systemName: "exclamationmark.circle")
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 5) {
                    // On the title rather than the banner, so it cannot
                    // overwrite the identifier of the Update pack button
                    // inside it. See the note in `workspace`.
                    Text(AssistedExportCopy.packOutOfDateTitle)
                        .snapListTypography(.rowTitle)
                        .foregroundStyle(SnapListColorToken.inkPrimary.color)
                        .accessibilityIdentifier("assisted-export.pack-out-of-date")
                    Text(AssistedExportCopy.packOutOfDateDetail)
                        .snapListTypography(.status)
                        .foregroundStyle(SnapListColorToken.textSecondary.color)
                }
            }
            // The one primary action of this state. Updating is the seller's
            // call: SnapList will not quietly rebuild a pack underneath them.
            // Addressed as `button.primary.update-pack`.
            SnapListPrimaryButton(title: AssistedExportCopy.updatePack) {
                onUpdatePack()
            }
            .padding(.top, 4)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(SnapListColorToken.groupingFill.color)
        .padding(.horizontal, SnapListMetrics.screenGutter)
        .padding(.bottom, 16)
    }

    // MARK: - Rows

    private var destinationRows: some View {
        VStack(spacing: 0) {
            Divider().overlay(SnapListColorToken.hairline.color)
            ForEach(domain.destinations) { destination in
                destinationRow(destination)
                if domain.isWorkspaceOpen(destination) {
                    workspace(destination)
                }
            }
        }
    }

    private func destinationRow(_ destination: AssistedExportDestination) -> some View {
        Button {
            withMotion { domain.toggle(destination) }
        } label: {
            HStack(spacing: 12) {
                RoundedRectangle(cornerRadius: 8)
                    .fill(SnapListColorToken.quietFill.color)
                    .frame(width: 34, height: 34)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(destination.displayName)
                        .snapListTypography(.cardTitle)
                        .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    statusLine(destination)
                }
                Spacer(minLength: 0)
                Image(systemName: domain.isWorkspaceOpen(destination) ? "chevron.up" : "chevron.down")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, SnapListMetrics.screenGutter)
            .padding(.vertical, 11)
            .frame(minHeight: 60)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .background(SnapListColorToken.canvas.color)
        .overlay(alignment: .bottom) {
            Divider().overlay(SnapListColorToken.hairline.color)
        }
        .accessibilityLabel(domain.accessibilityLabel(for: destination))
        .accessibilityIdentifier("assisted-export.row.\(destination.rawValue)")
    }

    /// A confirmed destination is set apart by a checkmark, the wording, and
    /// text weight. The approved package is explicit that this difference
    /// carries no colour, badge, or banner: the seller's own note about their
    /// own listing is not an achievement SnapList celebrates.
    @ViewBuilder
    private func statusLine(_ destination: AssistedExportDestination) -> some View {
        switch domain.handoff(for: destination) {
        case .prepared:
            Text(domain.statusText(for: destination))
                .snapListTypography(.status)
                .foregroundStyle(SnapListColorToken.textSecondary.color)
        case .shared:
            HStack(spacing: 5) {
                Image(systemName: "checkmark")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .accessibilityHidden(true)
                Text(domain.statusText(for: destination))
                    .snapListTypography(.status)
                    .fontWeight(.semibold)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .monospacedDigit()
            }
        }
    }

    // MARK: - Workspace

    private func workspace(_ destination: AssistedExportDestination) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            // The identifier sits on this line rather than on the enclosing
            // stack. An identifier applied to a container that is not itself an
            // accessibility element propagates down and replaces the identifier
            // of every control inside it, which left `Open`, `Copy listing
            // text`, `Save photos`, `Share another way` and `Mark as shared`
            // all reporting one name. This line exists exactly when the
            // workspace does, so it anchors the same fact without erasing them.
            Text(domain.leadText(for: destination))
                .snapListTypography(.body)
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .accessibilityIdentifier(
                    "assisted-export.workspace.\(destination.rawValue)"
                )

            if let advisory = domain.advisory(for: destination) {
                advisoryRow(advisory)
            }

            // `SnapListPrimaryButton` derives its own accessibility identifier
            // from its title, and an outer one would not reach the button. It
            // is addressed as `button.primary.open-<destination>`.
            SnapListPrimaryButton(title: domain.primaryActionLabel(for: destination)) {
                // Attempt first, then report. A pre-flight availability check
                // would state something about the seller's device that this
                // screen has no business asserting.
                withMotion { domain.recordHandoff(.openedDestination, for: destination) }
            }

            deviceActions(destination)

            shareAnotherWay(destination)

            whatHappensNext(destination)

            if domain.offersMarkAsShared(for: destination) {
                markAsShared(destination)
            }

            if domain.undoWindow == destination {
                undoRow()
            }
        }
        .padding(.horizontal, SnapListMetrics.screenGutter)
        .padding(.top, 16)
        .padding(.bottom, 20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(SnapListColorToken.canvas.color)
        .overlay(alignment: .bottom) {
            Divider().overlay(SnapListColorToken.hairline.color)
        }
    }

    private func advisoryRow(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: "info.circle")
                .foregroundStyle(SnapListColorToken.textSecondary.color)
                .accessibilityHidden(true)
            Text(text)
                .snapListTypography(.status)
                .foregroundStyle(SnapListColorToken.textSecondary.color)
                .accessibilityIdentifier("assisted-export.advisory")
        }
        .padding(.horizontal, 13)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(SnapListColorToken.quietFill.color)
    }

    /// Copy and Save report a device action and nothing more. Neither reveals
    /// anything about the destination, and both are equal-weight secondary
    /// controls so neither reads as the way to finish.
    private func deviceActions(_ destination: AssistedExportDestination) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) {
                copyAction(destination)
                saveAction(destination)
            }
            VStack(spacing: 10) {
                copyAction(destination)
                saveAction(destination)
            }
        }
    }

    private func copyAction(_ destination: AssistedExportDestination) -> some View {
        quietAction(
            title: AssistedExportCopy.copyListingText,
            systemImage: "doc.on.doc",
            identifier: "assisted-export.copy.\(destination.rawValue)"
        ) {
            withMotion { domain.recordHandoff(.copiedListingText, for: destination) }
        }
    }

    private func saveAction(_ destination: AssistedExportDestination) -> some View {
        quietAction(
            title: AssistedExportCopy.savePhotos(count: domain.pack.photoCount),
            systemImage: "square.and.arrow.down",
            identifier: "assisted-export.save.\(destination.rawValue)"
        ) {
            withMotion { domain.recordHandoff(.savedPhotos, for: destination) }
        }
    }

    private func quietAction(
        title: String,
        systemImage: String,
        identifier: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 7) {
                Image(systemName: systemImage)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .accessibilityHidden(true)
                Text(title)
                    .snapListTypography(.rowTitle)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
            }
            .frame(maxWidth: .infinity)
            .frame(minHeight: SnapListMetrics.minimumTouchTarget)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .background(SnapListColorToken.canvas.color)
        .clipShape(.rect(cornerRadius: 12))
        .overlay {
            RoundedRectangle(cornerRadius: 12)
                .stroke(SnapListColorToken.hairline.color, lineWidth: 1)
        }
        .accessibilityIdentifier(identifier)
    }

    private func shareAnotherWay(_ destination: AssistedExportDestination) -> some View {
        Button {
            withMotion { domain.recordHandoff(.sharedAnotherWay, for: destination) }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "square.and.arrow.up")
                    .foregroundStyle(SnapListColorToken.action.color)
                    .accessibilityHidden(true)
                Text(AssistedExportCopy.shareAnotherWay)
                    .snapListTypography(.rowTitle)
                    .foregroundStyle(SnapListColorToken.action.color)
                Spacer(minLength: 0)
            }
            .frame(minHeight: SnapListMetrics.minimumTouchTarget)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("assisted-export.share-another-way.\(destination.rawValue)")
    }

    private func whatHappensNext(_ destination: AssistedExportDestination) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(AssistedExportCopy.whatHappensNextTitle)
                .snapListTypography(.rowTitle)
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
            Text(domain.whatHappensNextText(for: destination))
                .snapListTypography(.status)
                .foregroundStyle(SnapListColorToken.textSecondary.color)
        }
        .padding(.horizontal, 15)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(SnapListColorToken.groupingFill.color)
    }

    /// Withheld until the seller has actually handed the pack over, and never a
    /// primary control. The support line under it says whose claim this is.
    private func markAsShared(_ destination: AssistedExportDestination) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withMotion { domain.presentConfirmSheet(for: destination) }
            } label: {
                Text(AssistedExportCopy.markAsShared)
                    .snapListTypography(.rowTitle)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: SnapListMetrics.minimumTouchTarget)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .background(SnapListColorToken.canvas.color)
            .clipShape(.rect(cornerRadius: 12))
            .overlay {
                RoundedRectangle(cornerRadius: 12)
                    .stroke(SnapListColorToken.hairline.color, lineWidth: 1)
            }
            .accessibilityIdentifier("assisted-export.mark-as-shared.\(destination.rawValue)")

            Text(AssistedExportCopy.markAsSharedSupport)
                .snapListTypography(.metadata)
                .foregroundStyle(SnapListColorToken.textSecondary.color)
        }
        .padding(.top, 2)
    }

    private func undoRow() -> some View {
        HStack(spacing: 8) {
            Text(AssistedExportCopy.markedAsShared)
                .snapListTypography(.status)
                .foregroundStyle(SnapListColorToken.textSecondary.color)
            Button {
                withMotion { domain.undoShared() }
            } label: {
                Text(AssistedExportCopy.undo)
                    .snapListTypography(.status)
                    .fontWeight(.semibold)
                    .foregroundStyle(SnapListColorToken.action.color)
                    .frame(
                        minWidth: SnapListMetrics.minimumTouchTarget,
                        minHeight: SnapListMetrics.minimumTouchTarget
                    )
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("assisted-export.undo")
            Spacer(minLength: 0)
        }
        .frame(minHeight: SnapListMetrics.minimumTouchTarget)
    }

    // MARK: - Confirm sheet

    /// The only writer of `Shared` on this screen.
    ///
    /// The binding's setter is what makes a swipe-down, a scrim tap, and `Not
    /// yet` all the same full cancel, and it is also how the sheet comes down
    /// when the listing moves underneath it — SwiftUI re-evaluates the binding,
    /// finds `confirmSheet` cleared, and dismisses. The server would refuse the
    /// write anyway, but a sheet left mounted still asks the seller to confirm a
    /// pack they were never shown.
    private var confirmSheetBinding: Binding<Bool> {
        Binding(
            get: { domain.confirmSheet != nil },
            set: { presented in
                if !presented { domain.dismissConfirmSheet() }
            }
        )
    }

    @ViewBuilder
    private var confirmSheet: some View {
        if let destination = domain.confirmSheet {
            VStack(alignment: .leading, spacing: 16) {
                // On the question rather than the sheet, so the two confirm
                // controls keep their own identifiers. The question is on
                // screen exactly while the sheet is, so it still marks the
                // sheet's presence. See the note in `workspace`.
                Text(domain.confirmQuestion(for: destination))
                    .snapListTypography(.sectionHeader)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .padding(.top, 4)
                    .accessibilityIdentifier("assisted-export.confirm-sheet")
                // Addressed as `button.primary.yes,-mark-as-shared`; see the
                // note on the open action about the component's own identifier.
                SnapListPrimaryButton(title: AssistedExportCopy.confirmShared) {
                    withMotion { domain.confirmShared(at: now()) }
                }
                SnapListSecondaryButton(title: AssistedExportCopy.confirmNotYet) {
                    withMotion { domain.dismissConfirmSheet() }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, SnapListMetrics.screenGutter)
            .padding(.bottom, 30)
            .frame(maxWidth: .infinity, alignment: .leading)
            .presentationDetents([.height(260)])
            .presentationDragIndicator(.visible)
            .onAppear { onConfirmSheetPresented?() }
        }
    }

    // MARK: - Motion

    /// Every state on this screen is legible without animation, so Reduced
    /// Motion drops the transition rather than substituting one.
    private func withMotion(_ change: () -> Void) {
        if reduceMotion {
            change()
        } else {
            withAnimation(.easeOut(duration: 0.18), change)
        }
    }
}
