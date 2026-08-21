import Foundation
import Observation

enum ListingReviewPhase: Equatable, Sendable {
    case idle
    case ready
    case saving
    case offline
    case failed
    /// #951. The server refused this save permanently and sent the remedy in
    /// `announcement`. Distinct from `.failed` because `.failed` is the phase
    /// the review offers a retry from, and no retry of this save can succeed.
    case refused
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
    /// The last draft the server acknowledged. The snapshot still holds the
    /// copy this review opened with — rebuilding it from a receipt is not
    /// something the read contract allows — so without this the review keeps
    /// calling itself unsaved after a save it just completed.
    private var savedDraft: ListingReviewDraft?
    private var expiresAt: Date?
    private var draftGeneration: UInt = 0
    private var openGeneration: UInt = 0
    /// Non-cancellation debounce: every edit schedules a sleep-then-flush
    /// task and overwrites this marker with the draft generation it should
    /// fire for. Any earlier scheduled task whose captured generation no
    /// longer matches this marker when it wakes is stale and no-ops, so
    /// multiple in-flight sleeps can coexist safely without ever dropping
    /// the last edit.
    private var pendingAutosaveGeneration: UInt?
    /// Set when a mutator lands (or a debounce fires) while a save is
    /// already in flight. `performSave` is not reentrant -- two saves can
    /// never race the same draft -- so instead of dropping that edit, the
    /// in-flight save's own completion consumes this flag and resaves once
    /// it is free, carrying whatever the server just returned as the next
    /// `expectedReviewRevision`.
    private var resaveRequested = false

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
        guard draft != savedDraft else { return false }
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
                    adopt(persisted, canonical: canonical)
                    phase = .ready
                    return true
                } else if persistedWasDirty {
                    adopt(persisted, canonical: canonical)
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
        guard var draft else { return }
        draft.sellerPriceOverride = value
        await stage(
            draft,
            announcement: value == nil
                ? "Cleared your price. Showing the suggested price."
                : "Your price is updated. Unsaved changes."
        )
    }

    @discardableResult
    func done() async -> ListingReviewDoneOutcome {
        pendingAutosaveGeneration = nil
        return await performSave(silent: false)
    }

    /// Where the debounce in `scheduleAutosave()` settles, and where every
    /// "leaving the screen" call site (back, push a destination, present a
    /// sheet, background the app) flushes a pending edit before it can be
    /// lost. Runs the identical save `done()` runs, but a field mid-edit is
    /// not a failure: an unmet precondition (nothing dirty, stale, invalid)
    /// is a quiet no-op here instead of overwriting whatever announcement
    /// the edit itself just posted. An actual save attempt that fails is
    /// never silenced -- the seller needs to know that edit didn't stick.
    @discardableResult
    func flushPendingAutosave() async -> ListingReviewDoneOutcome {
        pendingAutosaveGeneration = nil
        return await performSave(silent: true)
    }

    /// A mutator can now land mid-save (see the mutators above -- none of
    /// them refuse), so `performSave` must never let two attempts run at
    /// once. A reentrant call while `.saving` cannot join or preempt the one
    /// in flight; it only records that another save is owed, and the
    /// in-flight attempt's own completion (`executeSave`'s return, below)
    /// discharges that debt by resaving once, serialized, threading the
    /// revision the completing save just returned.
    private func performSave(silent: Bool) async -> ListingReviewDoneOutcome {
        guard phase != .saving else {
            resaveRequested = true
            return .stayed
        }
        let outcome = await executeSave(silent: silent)
        if resaveRequested {
            resaveRequested = false
            return await performSave(silent: true)
        }
        return outcome
    }

    private func executeSave(silent: Bool) async -> ListingReviewDoneOutcome {
        guard let snapshot, let draft else {
            return .stayed
        }
        guard !isStale else {
            if !silent { announcement = ListingReviewCopy.staleReview }
            return .stayed
        }
        guard canSave else {
            if !silent { announcement = "Enter a price above $0 to continue." }
            return .stayed
        }
        guard isDirty else {
            if !silent { announcement = "Done. Back to Processing review." }
            return .dismissedWithoutWrite
        }
        guard let scope = activeScope else {
            phase = .failed
            announcement = ListingReviewCopy.saveFailed
            return .stayed
        }

        // Captured once, at the top: this attempt's own identity. A field
        // edit landing after this point advances `draftGeneration`/`draft`
        // out from under these locals -- expected, since the mutators no
        // longer refuse during `.saving` -- but this specific attempt still
        // owes the server exactly the draft it captured here, and must
        // still resolve `phase` out of `.saving` when it completes,
        // regardless of what has since superseded it.
        let generation = draftGeneration
        let token = persistenceToken
        phase = .saving
        if !silent { announcement = "Saving your changes." }
        do {
            let bearer = try await tokenProvider.principalBoundBearer()
            guard phase == .saving, bearer.scopeProof == scope else {
                throw ListingReviewClientError.unavailable
            }
            let operation = pendingSave?.draft == draft
                ? pendingSave!
                : ListingReviewPendingSave(
                    idempotencyKey: makeID(),
                    draft: draft
                )
            pendingSave = operation
            if generation == draftGeneration {
                // Worth durably re-staging the idempotency pairing only
                // while nothing has superseded it -- otherwise this would
                // try to persist a stale draft under a token the
                // persistence layer will (correctly) refuse anyway.
                guard await persistCurrent(
                    generation: generation,
                    token: token,
                    validating: bearer.scopeProof
                ) else {
                    guard phase == .saving else { return .stayed }
                    phase = .failed
                    announcement = ListingReviewCopy.draftPersistenceFailed
                    return .stayed
                }
            }
            guard phase == .saving, activeScope == scope else {
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
                  phase == .saving,
                  activeScope == scope else {
                throw ListingReviewClientError.invalidResponse
            }
            let removed = try await persistence.remove(
                runID: snapshot.binding.runID,
                token: token
            )
            guard phase == .saving, activeScope == scope else {
                return .stayed
            }
            if !removed {
                // A failed removal reads identically as a boolean for two
                // causes that must never collapse into the same branch:
                // this attempt's own later local edit already re-persisted
                // under a newer token of the same session (safe -- still my
                // draft, still my session, still fine to report success),
                // or a different session's token now owns the record
                // entirely (unsafe -- reporting success would be a silent
                // last-write-wins over whatever that other session is
                // doing). Whether *this* attempt's own generation moved is
                // not evidence of which one happened -- both can be true at
                // once -- so ask persistence who currently holds the token.
                let stillOwnedByThisSession: Bool
                if generation == draftGeneration {
                    stillOwnedByThisSession = false
                } else {
                    do {
                        _ = try await persistence.load(
                            runID: snapshot.binding.runID,
                            token: persistenceToken
                        )
                        stillOwnedByThisSession = true
                    } catch {
                        stillOwnedByThisSession = false
                    }
                }
                guard stillOwnedByThisSession else {
                    guard phase == .saving else { return .stayed }
                    isStale = true
                    phase = .conflict
                    announcement = ListingReviewCopy.staleReview
                    return .stayed
                }
            }
            if pendingSave?.idempotencyKey == operation.idempotencyKey {
                pendingSave = nil
            }
            savedDraft = draft
            // Autosave keeps this store open across many saves in one
            // sitting; the next save's `expectedReviewRevision` must track
            // what the server just advanced to, or it 409s as stale. The
            // receipt is server truth regardless of whether a newer local
            // edit has since arrived.
            self.snapshot = snapshot.withBinding(
                snapshot.binding.advancingReviewRevision(to: receipt.reviewRevision)
            )
            phase = .ready
            if !silent { announcement = "Saved. Back to Processing review." }
            return .saved(receipt)
        } catch ListingReviewClientError.refused(let refusal) {
            guard phase == .saving else { return .stayed }
            // The draft stays on the phone. The refusal is about repricing this
            // save asks for, not about the edits, and some of them -- putting
            // the condition back the way it was -- make the next save legal.
            phase = .refused
            announcement = refusal
        } catch ListingReviewClientError.conflict {
            guard phase == .saving else { return .stayed }
            isStale = true
            phase = .conflict
            announcement = ListingReviewCopy.staleReview
        } catch ListingReviewClientError.offline {
            guard phase == .saving else { return .stayed }
            phase = .offline
            announcement = "You're offline. Your changes are saved on this phone."
        } catch {
            guard phase == .saving else { return .stayed }
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
            if phase == .failed || phase == .offline || phase == .refused {
                phase = .ready
            }
            self.announcement = announcement
        }
        let generation = draftGeneration
        let token = persistenceToken
        let persisted = await persistCurrent(generation: generation, token: token)
        guard generation == draftGeneration else { return }
        if persisted {
            if changed { scheduleAutosave() }
        } else if phase == .saving {
            // An in-flight save's own guards read `phase` to decide whether
            // it still owns this attempt (see `executeSave`). Writing
            // `.failed` here -- even though this failure is real -- would
            // trip those guards and abandon that attempt with no recovery,
            // since no field is disabled to have kept this edit from
            // landing mid-save in the first place. Defer instead, through
            // the same flag a reentrant mutator call already uses: the
            // in-flight save's own completion resaves once more and
            // resolves this failure honestly, whether that resave lands or
            // fails again for real.
            resaveRequested = true
        } else {
            phase = .failed
            self.announcement = ListingReviewCopy.draftPersistenceFailed
        }
    }

    /// Schedules a flush after a debounce window. Never cancels a prior
    /// scheduled flush -- see `pendingAutosaveGeneration` -- so a save this
    /// triggers can never be silently dropped by a later edit superseding
    /// it; the later edit just wins the race to actually fire.
    private func scheduleAutosave() {
        let generation = draftGeneration
        pendingAutosaveGeneration = generation
        Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(800))
            await self?.fireAutosaveIfStillPending(generation: generation)
        }
    }

    private func fireAutosaveIfStillPending(generation: UInt) async {
        guard pendingAutosaveGeneration == generation else { return }
        await flushPendingAutosave()
    }

    private func adoptFresh(_ canonical: ListingReviewResult) {
        draftGeneration &+= 1
        pendingAutosaveGeneration = nil
        snapshot = canonical
        draft = ListingReviewDraft(snapshot: canonical)
        pendingSave = nil
        savedDraft = nil
        isStale = false
        expiresAt = now().addingTimeInterval(retention)
    }

    private func adopt(
        _ persisted: PersistedListingReviewDraft,
        canonical: ListingReviewResult
    ) {
        draftGeneration &+= 1
        pendingAutosaveGeneration = nil
        snapshot = canonical
        draft = persisted.draft
        pendingSave = persisted.pendingSave
        savedDraft = nil
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
        pendingAutosaveGeneration = nil
        resaveRequested = false
        phase = .idle
        snapshot = nil
        draft = nil
        activeScope = nil
        pendingSave = nil
        savedDraft = nil
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
