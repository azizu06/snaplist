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
    private var photosSavedForContentRevision: UUID?

    init(
        pack: AssistedExportPack,
        service: any AssistedExportServing
    ) {
        domain = AssistedExportDomain(pack: pack)
        self.service = service
    }

    func load() async {
        let requestedPack = domain.pack
        phase = .loading
        actionMessage = nil
        completedAction = nil
        do {
            let receipts = try await service.load(pack: requestedPack)
            guard domain.pack == requestedPack else { return }
            domain.synchronize(with: receipts)
            phase = .ready
        } catch {
            guard domain.pack == requestedPack else { return }
            phase = .failed
        }
    }

    func toggle(_ destination: AssistedExportDestination) {
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
            let receipts = try await service.perform(
                .handoff,
                destination: destination,
                pack: requestedPack
            )
            guard domain.pack == requestedPack, !domain.isPackOutOfDate else {
                return
            }
            domain.synchronize(with: receipts)
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
            let receipts = try await service.perform(
                .handoff,
                destination: destination,
                pack: requestedPack
            )
            guard domain.pack == requestedPack, !domain.isPackOutOfDate else {
                return
            }
            domain.synchronize(with: receipts)
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
            let receipts = try await service.perform(
                .shared,
                destination: destination,
                pack: requestedPack
            )
            guard domain.pack == requestedPack,
                  domain.confirmSheet == destination,
                  !domain.isPackOutOfDate else { return }
            guard let sharedAt = receipts.first(where: {
                $0.destination == destination
            })?.sharedAt else {
                throw AssistedExportClientError.invalidResponse
            }
            _ = domain.confirmShared(at: sharedAt)
            domain.synchronize(with: receipts)
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
            let receipts = try await service.perform(
                .undo,
                destination: destination,
                pack: requestedPack
            )
            guard domain.pack == requestedPack, !domain.isPackOutOfDate else {
                return
            }
            domain.synchronize(with: receipts)
            domain.closeUndoWindow()
        } catch {
            actionMessage = AssistedExportCopy.actionFailed
        }
    }
}
