import Foundation
import Observation

enum AssistedExportLoadPhase: Equatable, Sendable {
    case loading
    case ready
    case failed
}

struct AssistedExportCompletedAction: Equatable, Sendable {
    let action: AssistedExportHandoffAction
    let destination: AssistedExportDestination
}

@MainActor
@Observable
final class AssistedExportStore {
    private(set) var domain: AssistedExportDomain
    private(set) var phase: AssistedExportLoadPhase = .loading
    private(set) var isWriting = false
    private(set) var actionMessage: String?
    private(set) var completedAction: AssistedExportCompletedAction?

    private let service: any AssistedExportServing
    private let funnelAnalytics: any FunnelAnalyticsEventSinking
    private var photosSavedForContentRevision: UUID?

    init(
        pack: AssistedExportPack,
        service: any AssistedExportServing,
        funnelAnalytics: any FunnelAnalyticsEventSinking = NoOpFunnelAnalyticsEventSink()
    ) {
        domain = AssistedExportDomain(pack: pack)
        self.service = service
        self.funnelAnalytics = funnelAnalytics
    }

    func load() async {
        let requestedPack = domain.pack
        phase = .loading
        actionMessage = nil
        completedAction = nil
        do {
            let response = try await service.load(pack: requestedPack)
            guard domain.pack == requestedPack else { return }
            guard synchronize(response, for: requestedPack) else {
                // A newer server revision is XPORT-05, not a loading failure.
                phase = .ready
                return
            }
            phase = .ready
        } catch {
            guard domain.pack == requestedPack else { return }
            phase = .failed
        }
    }

    func toggle(_ destination: AssistedExportDestination) {
        // Opening or closing a row is navigation, not a retry. A failure
        // message left over from a previous row or a previous attempt on this
        // one is not a fact about the row the seller is looking at now.
        actionMessage = nil
        domain.toggle(destination)
    }

    func destinationDidNotOpen(_ destination: AssistedExportDestination) {
        domain.recordDestinationDidNotOpen(destination)
    }

    func reportActionFailure() {
        actionMessage = AssistedExportCopy.actionFailed
    }

    func presentConfirmSheet(for destination: AssistedExportDestination) {
        domain.presentConfirmSheet(for: destination)
    }

    func dismissConfirmSheet() {
        // Once the Shared request crosses the server boundary, the sheet must
        // remain mounted until its receipt resolves. Otherwise a swipe or
        // "Not yet" can discard a successful response and leave the durable
        // server state ahead of what the seller sees.
        guard !isWriting else { return }
        domain.dismissConfirmSheet()
    }

    func listingRevisionChanged(to revision: UUID) {
        domain.listingRevisionChanged(to: revision)
    }

    func updatePack(to replacement: AssistedExportPack) async {
        // This runs before any network read. It is what makes a mounted sheet
        // visibly dismiss as soon as its revision is replaced.
        domain.updatePack(to: replacement)
        await load()
    }

    func recordHandoff(
        _ action: AssistedExportHandoffAction,
        for destination: AssistedExportDestination,
        pack expectedPack: AssistedExportPack? = nil
    ) async {
        let requestedPack = expectedPack ?? domain.pack
        guard phase == .ready,
              domain.pack == requestedPack,
              !domain.isPackOutOfDate,
              !isWriting else { return }
        isWriting = true
        actionMessage = nil
        defer { isWriting = false }
        do {
            let response = try await service.perform(
                .handoff,
                destination: destination,
                pack: requestedPack
            )
            guard synchronize(response, for: requestedPack), !domain.isPackOutOfDate else {
                return
            }
            switch action {
            case .copiedListingText:
                showCompletion(action, for: destination)
            case .savedPhotos:
                showCompletion(action, for: destination)
            case .openedDestination, .sharedAnotherWay:
                break
            }
        } catch {
            actionMessage = AssistedExportCopy.actionFailed
        }
    }

    /// Hand the prepared pack to the device: the clipboard, the share sheet,
    /// another app.
    ///
    /// The pack is resolved against the server BEFORE a word of it leaves
    /// SnapList, and the caller is handed the resolved pack rather than the one
    /// it asked with. That order is the whole point. A seller price edit
    /// changes what the pack says while the screen keeps showing what it said,
    /// and delivering first and reconciling afterwards puts the old number in
    /// the seller's pasteboard and then in a real marketplace listing — the
    /// refusal arriving a moment later cannot take it back out.
    ///
    /// A listing that moved on is not delivered at all: the workspace goes to
    /// XPORT-05 and the seller is asked to update the pack, which is the same
    /// answer `record_export_handoff` would give, arrived at before the handoff
    /// instead of after it.
    func deliver(
        _ action: AssistedExportHandoffAction,
        for destination: AssistedExportDestination,
        pack requestedPack: AssistedExportPack,
        using handOver: (AssistedExportPack) async throws -> Void
    ) async {
        await deliver(
            pack: requestedPack,
            recording: (action: action, destination: destination),
            using: handOver
        )
    }

    /// The same resolve-then-hand-over rule for a delivery whose receipt is
    /// written elsewhere. The share sheet is the case: its handoff is recorded
    /// when the sheet is actually on screen, so building its payload must not
    /// record a second one, but the payload still may not be built from a pack
    /// the server has already moved past.
    func prepareDelivery(
        pack requestedPack: AssistedExportPack,
        using build: (AssistedExportPack) async throws -> Void
    ) async {
        await deliver(pack: requestedPack, recording: nil, using: build)
    }

    private func deliver(
        pack requestedPack: AssistedExportPack,
        recording receipt: (
            action: AssistedExportHandoffAction,
            destination: AssistedExportDestination
        )?,
        using handOver: (AssistedExportPack) async throws -> Void
    ) async {
        guard phase == .ready,
              domain.pack == requestedPack,
              !domain.isPackOutOfDate,
              !isWriting else { return }
        isWriting = true
        actionMessage = nil
        defer { isWriting = false }
        do {
            let refreshed = try await service.load(pack: requestedPack)
            // A stale pack, or one replaced under this request, delivers
            // nothing. `synchronize` has already moved the domain to the state
            // that says so.
            guard synchronize(refreshed, for: requestedPack) else { return }
            let currentPack = domain.pack
            try await handOver(currentPack)
            guard let receipt else { return }
            guard domain.pack == currentPack, !domain.isPackOutOfDate else {
                return
            }
            let response = try await service.perform(
                .handoff,
                destination: receipt.destination,
                pack: currentPack
            )
            guard synchronize(response, for: currentPack),
                  !domain.isPackOutOfDate else { return }
            switch receipt.action {
            case .copiedListingText, .savedPhotos:
                showCompletion(receipt.action, for: receipt.destination)
            case .openedDestination, .sharedAnotherWay:
                break
            }
        } catch {
            actionMessage = AssistedExportCopy.actionFailed
        }
    }

    func savePhotos(
        for destination: AssistedExportDestination,
        pack expectedPack: AssistedExportPack? = nil,
        deviceWrite: () async throws -> Void
    ) async {
        let requestedPack = expectedPack ?? domain.pack
        guard phase == .ready,
              domain.pack == requestedPack,
              !domain.isPackOutOfDate,
              !isWriting else { return }
        isWriting = true
        actionMessage = nil
        defer { isWriting = false }
        do {
            if photosSavedForContentRevision != requestedPack.contentRevision {
                try await deviceWrite()
                // The Photos side effect has committed even if the following
                // receipt request fails or its response is lost. Keep that
                // local fact so Retry only retries the idempotent server seam.
                photosSavedForContentRevision = requestedPack.contentRevision
            }
            guard domain.pack == requestedPack, !domain.isPackOutOfDate else {
                return
            }
            if !domain.hasHandedOff(to: destination) {
                let response = try await service.perform(
                    .handoff,
                    destination: destination,
                    pack: requestedPack
                )
                guard synchronize(response, for: requestedPack), !domain.isPackOutOfDate else {
                    return
                }
            }
            showCompletion(.savedPhotos, for: destination)
        } catch {
            actionMessage = AssistedExportCopy.actionFailed
        }
    }

    private func showCompletion(
        _ action: AssistedExportHandoffAction,
        for destination: AssistedExportDestination
    ) {
        let completion = AssistedExportCompletedAction(
            action: action,
            destination: destination
        )
        completedAction = completion
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard self?.completedAction == completion else { return }
            self?.completedAction = nil
        }
    }

    func confirmShared() async {
        guard let destination = domain.confirmSheet,
              phase == .ready,
              !domain.isPackOutOfDate,
              !isWriting else { return }
        isWriting = true
        actionMessage = nil
        let requestedPack = domain.pack
        defer { isWriting = false }
        do {
            let response = try await service.perform(
                .shared,
                destination: destination,
                pack: requestedPack
            )
            guard response.reviewRevision == requestedPack.reviewRevision else {
                _ = synchronize(response, for: requestedPack)
                return
            }
            guard domain.confirmSheet == destination,
                  !domain.isPackOutOfDate else { return }
            guard let sharedAt = response.receipts.first(where: {
                $0.destination == destination
            })?.sharedAt else {
                throw AssistedExportClientError.invalidResponse
            }
            let confirmOutcome = domain.confirmShared(at: sharedAt)
            guard synchronize(response, for: requestedPack), !domain.isPackOutOfDate else {
                return
            }
            if case .recorded = confirmOutcome {
                funnelAnalytics.record(.exportPackShared, eventID: UUID())
            }
        } catch AssistedExportClientError.conflict {
            domain.dismissConfirmSheet()
            actionMessage = AssistedExportCopy.actionFailed
        } catch {
            actionMessage = AssistedExportCopy.actionFailed
        }
    }

    func undoShared() async {
        guard let destination = domain.undoWindow,
              phase == .ready,
              !domain.isPackOutOfDate,
              !isWriting else { return }
        isWriting = true
        actionMessage = nil
        let requestedPack = domain.pack
        defer { isWriting = false }
        do {
            let response = try await service.perform(
                .undo,
                destination: destination,
                pack: requestedPack
            )
            guard synchronize(response, for: requestedPack), !domain.isPackOutOfDate else {
                return
            }
            domain.closeUndoWindow()
        } catch {
            actionMessage = AssistedExportCopy.actionFailed
        }
    }

    /// The server owns effective-price precedence. A changed full revision is
    /// stale even when the content revision remains reusable, so it only marks
    /// the mounted pack out of date and never relaxes mutation guards.
    private func synchronize(
        _ response: AssistedExportServerPack,
        for requestedPack: AssistedExportPack
    ) -> Bool {
        guard domain.pack == requestedPack else { return false }
        guard response.reviewRevision == requestedPack.reviewRevision else {
            domain.listingRevisionChanged(to: response.reviewRevision)
            return false
        }
        if response.effectivePrice != requestedPack.effectivePrice {
            domain.updatePack(
                to: requestedPack.replacingEffectivePrice(response.effectivePrice)
            )
        }
        domain.synchronize(with: response.receipts)
        return true
    }
}
