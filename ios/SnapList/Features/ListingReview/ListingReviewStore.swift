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
    private(set) var isStale = false
    private(set) var announcement = ""

    private let service: any ListingReviewServing
    private let persistence: any ListingReviewDraftPersisting
    private let tokenProvider: any BearerTokenProviding
    private let now: @Sendable () -> Date
    private let makeID: @Sendable () -> UUID
    private let retention: TimeInterval
    private let persistenceSessionID = UUID()

    private var activeScope: ItemRunSubmissionPrincipalScopeProof?
    private var pendingSave: ListingReviewPendingSave?
    private var expiresAt: Date?
    private var draftGeneration: UInt = 0
    private var openGeneration: UInt = 0

    private var persistenceToken: ListingReviewDraftPersistenceToken {
        ListingReviewDraftPersistenceToken(
            sessionID: persistenceSessionID,
            generation: draftGeneration
        )
    }

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
            && !isStale
            && phase != .saving
    }

    @discardableResult
    func open(_ requested: ListingReviewResult) async -> Bool {
        openGeneration &+= 1
        let generation = openGeneration
        resetForOpen()
        let bearer: PrincipalBoundBearer
        let canonical: ListingReviewResult
        do {
            bearer = try await tokenProvider.principalBoundBearer()
            guard generation == openGeneration else { return false }
            canonical = try await service.fetchReview(
                runID: requested.binding.runID,
                bearerToken: bearer.bearerToken
            )
            guard generation == openGeneration,
                  canonical.binding.runID == requested.binding.runID else {
                throw ListingReviewClientError.invalidResponse
            }
        } catch {
            guard generation == openGeneration else { return false }
            failOpen()
            return false
        }

        do {
            let token = persistenceToken
            guard generation == openGeneration,
                  await persistence.activate(
                      token,
                      runID: canonical.binding.runID
                  ) else {
                return false
            }
            let persisted = try await persistence.load(
                runID: canonical.binding.runID,
                token: token
            )
            guard generation == openGeneration,
                  await confirmOpen(
                      generation: generation,
                      scope: bearer.scopeProof
                  ) else {
                return false
            }
            activeScope = bearer.scopeProof
            var persistedIsUsable = false
            if let persisted {
                persistedIsUsable =
                    persisted.expiresAt > now()
                        && persisted.expiresAt
                            <= now().addingTimeInterval(retention)
                        && persisted.snapshot.binding.runID
                            == canonical.binding.runID
                        && persisted.snapshot.binding.itemID
                            == canonical.binding.itemID
                        && persisted.snapshot.binding.listingID
                            == canonical.binding.listingID
            }
            if let persisted, persistedIsUsable {
                let persistedWasDirty =
                    persisted.draft
                        != ListingReviewDraft(snapshot: persisted.snapshot)
                if persisted.snapshot.binding.reviewRevision
                    == canonical.binding.reviewRevision {
                    adopt(persisted)
                    phase = .ready
                    return true
                } else if persistedWasDirty {
                    adopt(persisted)
                    isStale = true
                    phase = .conflict
                    announcement = ListingReviewCopy.staleReview
                    return true
                }
            }
            if persisted != nil {
                let removed = try await persistence.remove(
                    runID: canonical.binding.runID,
                    token: token
                )
                guard removed,
                      generation == openGeneration,
                      await confirmOpen(
                          generation: generation,
                          scope: bearer.scopeProof
                      ) else {
                    return false
                }
            }
            adoptFresh(canonical)
            phase = .ready
            return true
        } catch {
            guard generation == openGeneration else { return false }
            failOpen()
            return false
        }
    }

    func setTitle(_ value: String) async {
        guard phase != .saving, var draft else { return }
        draft.title = value
        await stage(draft, announcement: "Title updated. Unsaved changes.")
    }

    func setDescription(_ value: String) async {
        guard phase != .saving, var draft else { return }
        draft.description = value
        await stage(draft, announcement: "Description updated. Unsaved changes.")
    }

    func setCondition(_ value: ListingReviewCondition) async {
        guard phase != .saving, var draft else { return }
        draft.condition = value
        await stage(
            draft,
            announcement: "Condition set to \(value.sellerLabel)."
        )
    }

    func setSpecific(name: String, value: String) async {
        guard phase != .saving,
              var draft,
              let index = draft.specifics.firstIndex(where: {
                  $0.name.caseInsensitiveCompare(name) == .orderedSame
              }),
              !ListingReviewDraft.isIdentitySpecificName(
                  draft.specifics[index].name
              ) else {
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
        guard phase != .saving, var draft else { return }
        draft.sellerPriceOverride = value
        await stage(
            draft,
            announcement: value == nil
                ? "Cleared your price. Showing the suggested price."
                : "Your price is updated. Unsaved changes."
        )
    }

    func done() async -> ListingReviewDoneOutcome {
        guard let snapshot, let draft else {
            return .stayed
        }
        guard !isStale else {
            announcement = ListingReviewCopy.staleReview
            return .stayed
        }
        guard canSave else {
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

        let generation = draftGeneration
        let token = persistenceToken
        phase = .saving
        announcement = "Saving your changes."
        do {
            let bearer = try await tokenProvider.principalBoundBearer()
            guard generation == draftGeneration,
                  phase == .saving,
                  bearer.scopeProof == scope else {
                throw ListingReviewClientError.unavailable
            }
            let operation = pendingSave?.draft == draft
                ? pendingSave!
                : ListingReviewPendingSave(
                    idempotencyKey: makeID(),
                    draft: draft
                )
            pendingSave = operation
            guard await persistCurrent(
                generation: generation,
                token: token,
                validating: bearer.scopeProof
            ) else {
                guard generation == draftGeneration,
                      phase == .saving else {
                    return .stayed
                }
                phase = .failed
                announcement = ListingReviewCopy.draftPersistenceFailed
                return .stayed
            }
            guard generation == draftGeneration,
                  phase == .saving,
                  self.draft == draft,
                  activeScope == scope else {
                return .stayed
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
                  receipt.listingID == snapshot.binding.listingID,
                  generation == draftGeneration,
                  phase == .saving,
                  activeScope == scope else {
                throw ListingReviewClientError.invalidResponse
            }
            let removed = try await persistence.remove(
                runID: snapshot.binding.runID,
                token: token
            )
            guard removed,
                  generation == draftGeneration,
                  token == persistenceToken,
                  phase == .saving,
                  activeScope == scope else {
                return .stayed
            }
            pendingSave = nil
            phase = .ready
            announcement = "Saved. Back to Processing review."
            return .saved(receipt)
        } catch ListingReviewClientError.conflict {
            guard generation == draftGeneration,
                  phase == .saving else {
                return .stayed
            }
            isStale = true
            phase = .conflict
            announcement = ListingReviewCopy.staleReview
        } catch ListingReviewClientError.offline {
            guard generation == draftGeneration,
                  phase == .saving else {
                return .stayed
            }
            phase = .offline
            announcement = "You're offline. Your changes are saved on this phone."
        } catch {
            guard generation == draftGeneration,
                  phase == .saving else {
                return .stayed
            }
            phase = .failed
            announcement = ListingReviewCopy.saveFailed
        }
        return .stayed
    }

    func retrySave() async -> ListingReviewDoneOutcome {
        guard phase != .saving else { return .stayed }
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

    private func stage(
        _ changedDraft: ListingReviewDraft,
        announcement: String
    ) async {
        let changed = changedDraft != draft
        draft = changedDraft
        if changed {
            draftGeneration &+= 1
            pendingSave = nil
            if phase == .failed || phase == .offline {
                phase = .ready
            }
            self.announcement = announcement
        }
        let generation = draftGeneration
        let token = persistenceToken
        if !(await persistCurrent(
            generation: generation,
            token: token
        )),
           generation == draftGeneration {
            phase = .failed
            self.announcement = ListingReviewCopy.draftPersistenceFailed
        }
    }

    private func adoptFresh(_ canonical: ListingReviewResult) {
        draftGeneration &+= 1
        snapshot = canonical
        draft = ListingReviewDraft(snapshot: canonical)
        pendingSave = nil
        isStale = false
        expiresAt = now().addingTimeInterval(retention)
    }

    private func adopt(_ persisted: PersistedListingReviewDraft) {
        draftGeneration &+= 1
        snapshot = persisted.snapshot
        draft = persisted.draft
        pendingSave = persisted.pendingSave
        expiresAt = persisted.expiresAt
    }

    private func persistCurrent(
        generation: UInt,
        token: ListingReviewDraftPersistenceToken,
        validating freshScope: ItemRunSubmissionPrincipalScopeProof? = nil
    ) async -> Bool {
        guard generation == draftGeneration,
              token == persistenceToken,
              let activeScope,
              let snapshot,
              let draft else { return false }
        let validatedScope: ItemRunSubmissionPrincipalScopeProof
        do {
            validatedScope = if let freshScope {
                freshScope
            } else {
                try await tokenProvider.principalBoundBearer().scopeProof
            }
        } catch {
            return false
        }
        guard generation == draftGeneration,
              token == persistenceToken,
              validatedScope == activeScope else {
            return false
        }
        let expiry = expiresAt ?? now().addingTimeInterval(retention)
        expiresAt = expiry
        do {
            let committed = try await persistence.save(
                PersistedListingReviewDraft(
                    snapshot: snapshot,
                    draft: draft,
                    pendingSave: pendingSave,
                    expiresAt: expiry
                ),
                runID: snapshot.binding.runID,
                token: token
            )
            return committed
                && generation == draftGeneration
                && token == persistenceToken
        } catch {
            return false
        }
    }

    private func reloadReplacingDraft() async {
        guard let snapshot, let scope = activeScope else {
            phase = .reloadFailed
            announcement = ListingReviewCopy.reloadFailed
            return
        }
        let generation = draftGeneration
        let token = persistenceToken
        do {
            let bearer = try await tokenProvider.principalBoundBearer()
            guard generation == draftGeneration,
                  bearer.scopeProof == scope else {
                throw ListingReviewClientError.unavailable
            }
            let current = try await service.fetchReview(
                runID: snapshot.binding.runID,
                bearerToken: bearer.bearerToken
            )
            guard generation == draftGeneration,
                  current.binding.runID == snapshot.binding.runID,
                  current.binding.itemID == snapshot.binding.itemID,
                  current.binding.listingID == snapshot.binding.listingID else {
                throw ListingReviewClientError.invalidResponse
            }
            let removed = try await persistence.remove(
                runID: snapshot.binding.runID,
                token: token
            )
            let confirmed = try await tokenProvider.principalBoundBearer()
            guard removed,
                  generation == draftGeneration,
                  token == persistenceToken,
                  confirmed.scopeProof == scope else {
                throw ListingReviewClientError.unavailable
            }
            adoptFresh(current)
            phase = .ready
            announcement = "Reloaded the current review."
        } catch {
            guard generation == draftGeneration else { return }
            phase = .reloadFailed
            announcement = ListingReviewCopy.reloadFailed
        }
    }

    private func confirmOpen(
        generation: UInt,
        scope: ItemRunSubmissionPrincipalScopeProof
    ) async -> Bool {
        guard generation == openGeneration else { return false }
        do {
            let current = try await tokenProvider.principalBoundBearer()
            return generation == openGeneration
                && current.scopeProof == scope
        } catch {
            return false
        }
    }

    private func resetForOpen() {
        draftGeneration &+= 1
        phase = .idle
        snapshot = nil
        draft = nil
        activeScope = nil
        pendingSave = nil
        expiresAt = nil
        isStale = false
        announcement = ""
    }

    private func failOpen() {
        resetForOpen()
        phase = .failed
        announcement = ListingReviewCopy.openFailed
    }
}
