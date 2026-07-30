import Foundation
import Observation

enum ListingReviewPhase: Equatable, Sendable {
    case idle
    case ready
    case saving
    case offline
    case failed
    case conflict
    case reloadConfirmation
    case reloadFailed
}

enum ListingReviewDoneOutcome: Equatable, Sendable {
    case stayed
    case dismissedWithoutWrite
    case saved(ListingReviewSaveReceipt)
}

@MainActor
@Observable
final class ListingReviewStore {
    private(set) var phase: ListingReviewPhase = .idle
    private(set) var snapshot: ListingReviewResult?
    private(set) var draft: ListingReviewDraft?
    private(set) var correctionAvailable = true
    private(set) var isStale = false
    private(set) var announcement = ""

    private let service: any ListingReviewServing
    private let persistence: any ListingReviewDraftPersisting
    private let tokenProvider: any BearerTokenProviding
    private let now: @Sendable () -> Date
    private let makeID: @Sendable () -> UUID
    private let retention: TimeInterval

    private var activeScope: ItemRunSubmissionPrincipalScopeProof?
    private var pendingSave: ListingReviewPendingSave?
    private var expiresAt: Date?

    init(
        service: any ListingReviewServing,
        persistence: any ListingReviewDraftPersisting,
        tokenProvider: any BearerTokenProviding,
        now: @escaping @Sendable () -> Date = Date.init,
        makeID: @escaping @Sendable () -> UUID = UUID.init,
        retention: TimeInterval = 24 * 60 * 60
    ) {
        self.service = service
        self.persistence = persistence
        self.tokenProvider = tokenProvider
        self.now = now
        self.makeID = makeID
        self.retention = retention
    }

    var isDirty: Bool {
        guard let snapshot, let draft else { return false }
        return draft != ListingReviewDraft(snapshot: snapshot)
    }

    var canSave: Bool {
        draft?.hasRequiredCopy == true
            && draft?.hasValidPrice == true
            && phase != .saving
    }

    var effectivePrice: Decimal? {
        guard let snapshot, let draft else { return nil }
        return draft.sellerPriceOverride ?? snapshot.pricing.suggestedPrice
    }

    @discardableResult
    func open(_ canonical: ListingReviewResult) async -> Bool {
        phase = .idle
        isStale = false
        announcement = ""

        do {
            let bearer = try await tokenProvider.principalBoundBearer()
            activeScope = bearer.scopeProof
            let persisted = try await persistence.load(
                runID: canonical.binding.runID
            )
            if let persisted,
               persisted.expiresAt > now(),
               persisted.snapshot.binding.runID == canonical.binding.runID,
               persisted.snapshot.binding.itemID == canonical.binding.itemID,
               persisted.snapshot.binding.listingID == canonical.binding.listingID {
                let persistedWasDirty =
                    persisted.draft
                        != ListingReviewDraft(snapshot: persisted.snapshot)
                if persisted.snapshot.binding.reviewRevision
                    == canonical.binding.reviewRevision {
                    adopt(persisted)
                } else if persistedWasDirty {
                    adopt(persisted)
                    isStale = true
                    phase = .conflict
                    announcement = ListingReviewCopy.staleReview
                    return true
                } else {
                    try await persistence.remove(runID: canonical.binding.runID)
                    adoptFresh(canonical)
                }
            } else {
                if persisted != nil {
                    try? await persistence.remove(runID: canonical.binding.runID)
                }
                adoptFresh(canonical)
            }
            phase = .ready
            await persistCurrent()
            return true
        } catch {
            // The canonical RLS response is still safe to display. Saving and
            // durable staging stay unavailable until a principal-bound bearer
            // can be acquired; no cross-principal fallback store is invented.
            activeScope = nil
            adoptFresh(canonical)
            phase = .ready
            return true
        }
    }

    func setTitle(_ value: String) async {
        guard var draft else { return }
        draft.title = value
        await stage(draft, announcement: "Title updated. Unsaved changes.")
    }

    func setDescription(_ value: String) async {
        guard var draft else { return }
        draft.description = value
        await stage(draft, announcement: "Description updated. Unsaved changes.")
    }

    func setCondition(_ value: ListingReviewCondition) async {
        guard var draft else { return }
        draft.condition = value
        await stage(
            draft,
            announcement: "Condition set to \(value.sellerLabel)."
        )
    }

    func setSpecific(name: String, value: String) async {
        guard var draft,
              let index = draft.specifics.firstIndex(where: {
                  $0.name.caseInsensitiveCompare(name) == .orderedSame
              }),
              !isIdentitySpecific(draft.specifics[index].name) else {
            return
        }
        let suggested = snapshot?.listing.specifics.first(where: {
            $0.name.caseInsensitiveCompare(name) == .orderedSame
        })?.value
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        draft.specifics[index] = ListingReviewSpecific(
            name: draft.specifics[index].name,
            value: normalized.isEmpty ? (suggested ?? draft.specifics[index].value) : normalized
        )
        await stage(
            draft,
            announcement: "\(name) updated. Unsaved changes."
        )
    }

    func setSellerPriceOverride(_ value: Decimal?) async {
        guard var draft else { return }
        draft.sellerPriceOverride = value
        await stage(
            draft,
            announcement: value == nil
                ? "Cleared your price. Showing the suggested price."
                : "Your price is updated. Unsaved changes."
        )
    }

    func done() async -> ListingReviewDoneOutcome {
        guard let snapshot, let draft, canSave else {
            announcement = "Enter a price above $0 to continue."
            return .stayed
        }
        guard isDirty else {
            announcement = "Done. Back to Processing review."
            return .dismissedWithoutWrite
        }
        guard let scope = activeScope else {
            phase = .failed
            announcement = ListingReviewCopy.saveFailed
            return .stayed
        }

        let operation = pendingSave?.draft == draft
            ? pendingSave!
            : ListingReviewPendingSave(
                idempotencyKey: makeID(),
                draft: draft
            )
        pendingSave = operation
        phase = .saving
        announcement = "Saving your changes."
        await persistCurrent()

        do {
            let bearer = try await tokenProvider.principalBoundBearer()
            guard bearer.scopeProof == scope else {
                throw ListingReviewClientError.unavailable
            }
            let receipt = try await service.save(
                runID: snapshot.binding.runID,
                draft: draft,
                expectedReviewRevision: snapshot.binding.reviewRevision,
                idempotencyKey: operation.idempotencyKey,
                bearerToken: bearer.bearerToken
            )
            guard receipt.runID == snapshot.binding.runID,
                  receipt.itemID == snapshot.binding.itemID,
                  receipt.listingID == snapshot.binding.listingID else {
                throw ListingReviewClientError.invalidResponse
            }
            try await persistence.remove(runID: snapshot.binding.runID)
            pendingSave = nil
            phase = .ready
            announcement = "Saved. Back to Processing review."
            return .saved(receipt)
        } catch ListingReviewClientError.conflict {
            isStale = true
            phase = .conflict
            announcement = ListingReviewCopy.staleReview
        } catch ListingReviewClientError.offline {
            phase = .offline
            announcement = "You're offline. Your changes are saved on this phone."
        } catch {
            phase = .failed
            announcement = ListingReviewCopy.saveFailed
        }
        await persistCurrent()
        return .stayed
    }

    func retrySave() async -> ListingReviewDoneOutcome {
        phase = .ready
        return await done()
    }

    func requestReload() async {
        if isDirty {
            phase = .reloadConfirmation
            announcement =
                "Reloading would discard your unsaved changes. Keep editing is selected."
        } else {
            await reloadReplacingDraft()
        }
    }

    func keepEditing() {
        phase = .ready
        announcement =
            "Kept your edits. Still out of date, so saving will need a reload first."
    }

    func discardChangesAndReload() async {
        await reloadReplacingDraft()
    }

    func retryReload() async {
        await reloadReplacingDraft()
    }

    func openCorrectionBoundary() {
        announcement = "Opened guided correction. Your photos and edits are kept."
    }

    func applyCoherentCorrection(_ corrected: ListingReviewResult) async {
        guard let snapshot,
              corrected.binding.runID == snapshot.binding.runID,
              corrected.binding.itemID == snapshot.binding.itemID,
              corrected.binding.listingID == snapshot.binding.listingID else {
            return
        }
        let preservedOverride = draft?.sellerPriceOverride
        self.snapshot = corrected
        var correctedDraft = ListingReviewDraft(snapshot: corrected)
        correctedDraft.sellerPriceOverride = preservedOverride
        draft = correctedDraft
        correctionAvailable = false
        pendingSave = nil
        isStale = false
        phase = .ready
        announcement =
            "Applied a coherent correction. Identity and recommendation updated; any set price is preserved."
        await persistCurrent()
    }

    func focusEditDetails() {
        announcement = "Edit any detail below."
    }

    func isIdentitySpecific(_ name: String) -> Bool {
        switch name.trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased() {
        case "brand", "model", "type", "category", "isbn", "upc":
            true
        default:
            false
        }
    }

    private func stage(
        _ changedDraft: ListingReviewDraft,
        announcement: String
    ) async {
        let changed = changedDraft != draft
        draft = changedDraft
        if changed {
            pendingSave = nil
            if phase == .failed || phase == .offline {
                phase = .ready
            }
            self.announcement = announcement
        }
        await persistCurrent()
    }

    private func adoptFresh(_ canonical: ListingReviewResult) {
        snapshot = canonical
        draft = ListingReviewDraft(snapshot: canonical)
        pendingSave = nil
        correctionAvailable = true
        isStale = false
        expiresAt = now().addingTimeInterval(retention)
    }

    private func adopt(_ persisted: PersistedListingReviewDraft) {
        snapshot = persisted.snapshot
        draft = persisted.draft
        pendingSave = persisted.pendingSave
        correctionAvailable = persisted.correctionAvailable
        expiresAt = persisted.expiresAt
    }

    private func persistCurrent() async {
        guard activeScope != nil,
              let snapshot,
              let draft else { return }
        let expiry = expiresAt ?? now().addingTimeInterval(retention)
        expiresAt = expiry
        try? await persistence.save(
            PersistedListingReviewDraft(
                snapshot: snapshot,
                draft: draft,
                pendingSave: pendingSave,
                correctionAvailable: correctionAvailable,
                expiresAt: expiry
            ),
            runID: snapshot.binding.runID
        )
    }

    private func reloadReplacingDraft() async {
        guard let snapshot, let scope = activeScope else {
            phase = .reloadFailed
            announcement = ListingReviewCopy.reloadFailed
            return
        }
        do {
            let bearer = try await tokenProvider.principalBoundBearer()
            guard bearer.scopeProof == scope else {
                throw ListingReviewClientError.unavailable
            }
            let current = try await service.fetchReview(
                runID: snapshot.binding.runID,
                bearerToken: bearer.bearerToken
            )
            guard current.binding.runID == snapshot.binding.runID,
                  current.binding.itemID == snapshot.binding.itemID,
                  current.binding.listingID == snapshot.binding.listingID else {
                throw ListingReviewClientError.invalidResponse
            }
            adoptFresh(current)
            phase = .ready
            announcement = "Reloaded the current review."
            await persistCurrent()
        } catch {
            phase = .reloadFailed
            announcement = ListingReviewCopy.reloadFailed
            await persistCurrent()
        }
    }
}

@MainActor
enum ListingReviewStoreFactory {
    static func make(
        configuration: LaunchConfiguration,
        apiOrigin: URL?,
        tokenProvider: any BearerTokenProviding,
        session: URLSession
    ) -> ListingReviewStore {
        return ListingReviewStore(
            service: apiOrigin.map {
                ListingReviewAPIClient(baseURL: $0, session: session)
            } ?? UnavailableListingReviewService(),
            persistence: configuration.usesZeroNetworkFixtures
                ? MemoryListingReviewDraftPersistence()
                : LocalListingReviewDraftPersistence(),
            tokenProvider: tokenProvider
        )
    }
}

private struct UnavailableListingReviewService: ListingReviewServing {
    func save(
        runID: UUID,
        draft: ListingReviewDraft,
        expectedReviewRevision: UUID,
        idempotencyKey: UUID,
        bearerToken: String
    ) async throws -> ListingReviewSaveReceipt {
        throw ListingReviewClientError.unavailable
    }

    func fetchReview(
        runID: UUID,
        bearerToken: String
    ) async throws -> ListingReviewResult {
        throw ListingReviewClientError.unavailable
    }
}
