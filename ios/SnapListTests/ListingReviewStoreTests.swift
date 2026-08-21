import Foundation
import XCTest
@testable import SnapList

@MainActor
final class ListingReviewStoreTests: XCTestCase {
    func testCleanDoneDoesNotWriteAndDirtyRetryReusesOneLogicalSave() async throws {
        let snapshot = try Self.makeSnapshot()
        let service = ListingReviewRecordingService(
            saves: [
                .failure(ListingReviewClientError.unavailable),
                .success(Self.receipt(for: snapshot)),
            ],
            reloads: [.success(snapshot)]
        )
        let store = makeStore(service: service)

        let opened = await store.open(snapshot)
        let cleanOutcome = await store.done()
        let cleanRequests = await service.recordedSaveRequests()

        XCTAssertTrue(opened)
        XCTAssertEqual(cleanOutcome, .dismissedWithoutWrite)
        XCTAssertEqual(cleanRequests.count, 0)
        await store.setSpecific(name: "Condition", value: "poor")
        XCTAssertEqual(
            store.draft?.specifics.first(where: {
                $0.name == "Condition"
            })?.value,
            "very-good"
        )

        await store.setTitle("Sony WH-1000XM4 headphones with case")
        let failedOutcome = await store.done()
        XCTAssertEqual(failedOutcome, .stayed)
        XCTAssertEqual(store.phase, .failed)

        let result = await store.retrySave()

        XCTAssertEqual(result, .saved(Self.receipt(for: snapshot)))
        let requests = await service.recordedSaveRequests()
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[0].idempotencyKey, requests[1].idempotencyKey)
        XCTAssertEqual(requests[0].expectedRevision, snapshot.binding.reviewRevision)

        var invalidDraft = ListingReviewDraft(snapshot: snapshot)
        invalidDraft.specifics = []
        XCTAssertFalse(invalidDraft.hasRequiredCopy)
        invalidDraft.specifics = (0...50).map {
            ListingReviewSpecific(name: "Field \($0)", value: "Value")
        }
        XCTAssertFalse(invalidDraft.hasRequiredCopy)
        invalidDraft.specifics = [
            ListingReviewSpecific(
                name: String(repeating: "N", count: 66),
                value: "Value"
            ),
        ]
        XCTAssertFalse(invalidDraft.hasRequiredCopy)
        invalidDraft.specifics = [
            ListingReviewSpecific(
                name: "Field",
                value: String(repeating: "V", count: 501)
            ),
        ]
        XCTAssertFalse(invalidDraft.hasRequiredCopy)
        invalidDraft.specifics = [
            ListingReviewSpecific(name: "Type", value: "Headphones"),
            ListingReviewSpecific(name: "Category", value: "Audio"),
        ]
        XCTAssertFalse(invalidDraft.hasRequiredCopy)

        let failingPersistence = ListingReviewTogglePersistence()
        let durabilityService = ListingReviewRecordingService(
            saves: [.success(Self.receipt(for: snapshot))],
            reloads: [.success(snapshot)]
        )
        let durabilityStore = makeStore(
            service: durabilityService,
            persistence: failingPersistence
        )
        let durabilityOpened = await durabilityStore.open(snapshot)
        XCTAssertTrue(durabilityOpened)
        await durabilityStore.setTitle("Durably staged title")
        await failingPersistence.failSaves()

        let durabilityOutcome = await durabilityStore.done()
        let durabilityRequests =
            await durabilityService.recordedSaveRequests()

        XCTAssertEqual(durabilityOutcome, .stayed)
        XCTAssertEqual(durabilityStore.phase, .failed)
        XCTAssertEqual(durabilityRequests.count, 0)

        let overlapPersistence = ListingReviewCommitGatePersistence(
            gate: .save(title: "Older edit")
        )
        let overlapService = ListingReviewRecordingService(
            saves: [],
            reloads: [.success(snapshot)]
        )
        let overlapStore = makeStore(
            service: overlapService,
            persistence: overlapPersistence
        )
        let overlapOpened = await overlapStore.open(snapshot)
        XCTAssertTrue(overlapOpened)
        let olderEdit = Task { @MainActor in
            await overlapStore.setTitle("Older edit")
        }
        await overlapPersistence.waitUntilBlocked()
        let newerOverlapService = ListingReviewRecordingService(
            saves: [],
            reloads: [.success(snapshot)]
        )
        let newerOverlapStore = makeStore(
            service: newerOverlapService,
            persistence: overlapPersistence
        )
        let newerOverlapOpened = await newerOverlapStore.open(snapshot)
        XCTAssertTrue(newerOverlapOpened)
        await newerOverlapStore.setTitle("Newest edit")
        await overlapPersistence.release()
        await olderEdit.value
        let overlapRecord = try await overlapPersistence.loadCurrent(
            runID: snapshot.binding.runID
        )
        XCTAssertEqual(newerOverlapStore.draft?.title, "Newest edit")
        XCTAssertEqual(overlapRecord?.draft.title, "Newest edit")

        let savingProvider = ListingReviewGateBearerProvider(
            blockedCall: 4
        )
        let savingService = ListingReviewRecordingService(
            saves: [.success(Self.receipt(for: snapshot))],
            reloads: [.success(snapshot)]
        )
        let savingStore = makeStore(
            service: savingService,
            persistence: MemoryListingReviewDraftPersistence(),
            tokenProvider: savingProvider
        )
        let savingOpened = await savingStore.open(snapshot)
        XCTAssertTrue(savingOpened)
        await savingStore.setTitle("Frozen save")
        let saveTask = Task { @MainActor in
            await savingStore.done()
        }
        await savingProvider.waitUntilBlocked()
        await savingStore.setDescription("Must not enter the active save")
        await savingProvider.release()
        let frozenOutcome = await saveTask.value
        let frozenRequests = await savingService.recordedSaveRequests()
        XCTAssertEqual(
            frozenOutcome,
            .saved(Self.receipt(for: snapshot))
        )
        XCTAssertEqual(
            frozenRequests.first?.draft.description,
            snapshot.listing.description
        )

        let staleClient = ListingReviewAPIClient(
            baseURL: URL(string: "https://api.snaplist.dev")!,
            session: makeConflictSession(
                message: ListingReviewCopy.staleReview
            )
        )
        do {
            _ = try await staleClient.save(
                runID: snapshot.binding.runID,
                draft: ListingReviewDraft(snapshot: snapshot),
                expectedReviewRevision: snapshot.binding.reviewRevision,
                idempotencyKey: UUID(),
                bearerToken: "listing-review-test-bearer"
            )
            XCTFail("Accepted a stale save conflict")
        } catch {
            XCTAssertEqual(error as? ListingReviewClientError, .conflict)
        }

        let inProgressClient = ListingReviewAPIClient(
            baseURL: URL(string: "https://api.snaplist.dev")!,
            session: makeConflictSession(
                message: "This save is already in progress. Try again."
            )
        )
        do {
            _ = try await inProgressClient.save(
                runID: snapshot.binding.runID,
                draft: ListingReviewDraft(snapshot: snapshot),
                expectedReviewRevision: snapshot.binding.reviewRevision,
                idempotencyKey: UUID(),
                bearerToken: "listing-review-test-bearer"
            )
            XCTFail("Accepted an in-progress save response")
        } catch {
            XCTAssertEqual(error as? ListingReviewClientError, .unavailable)
        }

        let removePersistence = ListingReviewCommitGatePersistence(
            gate: .remove
        )
        let removeService = ListingReviewRecordingService(
            saves: [.success(Self.receipt(for: snapshot))],
            reloads: [.success(snapshot)]
        )
        let removeStore = makeStore(
            service: removeService,
            persistence: removePersistence
        )
        let removeOpened = await removeStore.open(snapshot)
        XCTAssertTrue(removeOpened)
        await removeStore.setTitle("Old saved draft")
        let removeTask = Task { @MainActor in
            await removeStore.done()
        }
        await removePersistence.waitUntilBlocked()
        let newerRemoveService = ListingReviewRecordingService(
            saves: [],
            reloads: [.success(snapshot)]
        )
        let newerRemoveStore = makeStore(
            service: newerRemoveService,
            persistence: removePersistence
        )
        let removeReopened = await newerRemoveStore.open(snapshot)
        XCTAssertTrue(removeReopened)
        await newerRemoveStore.setTitle("Newest draft after reopen")
        await removePersistence.release()
        let staleRemoveOutcome = await removeTask.value
        let newestRecord = try await removePersistence.loadCurrent(
            runID: snapshot.binding.runID
        )
        XCTAssertEqual(staleRemoveOutcome, .stayed)
        XCTAssertEqual(newerRemoveStore.phase, .ready)
        XCTAssertEqual(
            newerRemoveStore.draft?.title,
            "Newest draft after reopen"
        )
        XCTAssertEqual(
            newestRecord?.draft.title,
            "Newest draft after reopen"
        )
    }

    func testASavedReviewStopsCallingItselfUnsaved() async throws {
        let snapshot = try Self.makeSnapshot()
        let receipt = Self.receipt(for: snapshot)
        let service = ListingReviewRecordingService(
            saves: [.success(receipt)],
            reloads: [.success(snapshot)]
        )
        let store = makeStore(service: service)

        let opened = await store.open(snapshot)
        XCTAssertTrue(opened)
        await store.setDescription("Seller edit that reaches the server")
        let outcome = await store.done()

        XCTAssertEqual(outcome, .saved(receipt))
        // The server now holds this draft, so the pending strip has no business
        // still saying otherwise while the review dismisses.
        XCTAssertFalse(store.isDirty)

        // And a second Done cannot buy a second write: the first one cleared
        // the pending save, so a repeat would mint a fresh idempotency key.
        let repeated = await store.done()
        let saveRequests = await service.recordedSaveRequests()
        XCTAssertEqual(repeated, .dismissedWithoutWrite)
        XCTAssertEqual(saveRequests.count, 1)
    }

    func testAReviewSurvivesItsOwnEncoderWithEveryFactPopulated() throws {
        // Hand-written encoders drop a field the day someone adds one to the
        // read contract and forgets the other half. Re-reading the app's own
        // output through the same strict contract is what notices — but only
        // if the fixture actually carries the field. A snapshot whose optional
        // facts are all absent compares nil to nil and passes over a dropped
        // key, so every fact this contract allows is populated here.
        let populated = try Self.makeSnapshot(
            sellerPriceOverride: 172.50,
            soldMatches: 2
        )
        let restored = try JSONDecoder().decode(
            ListingReviewResult.self,
            from: JSONEncoder().encode(populated)
        )

        XCTAssertEqual(restored, populated)
        XCTAssertNil(restored.soldEvidenceCopy)
        XCTAssertEqual(restored.pricing.sellerPriceOverride, 172.50)
        let fullMatch = try XCTUnwrap(restored.verifiedSoldMatches.last)
        XCTAssertEqual(fullMatch.title, "Sony WH-1000XM4")
        XCTAssertEqual(fullMatch.condition, "used")
        XCTAssertEqual(fullMatch.soldAt, 1_750_000_000)
        XCTAssertEqual(
            fullMatch.photoURL,
            URL(string: "https://media.snaplist.dev/sold/2.jpg")
        )
        XCTAssertEqual(fullMatch.size, "One size")
        XCTAssertEqual(fullMatch.format, .buyItNow)
        XCTAssertEqual(fullMatch.shipping, .paid(price: 8.75, currency: "USD"))

        // The other half of the same contract: an explicit null and an omitted
        // optional key each have to survive as themselves, not as each other.
        let sparse = try Self.makeSnapshot(soldMatches: 1)
        let restoredSparse = try JSONDecoder().decode(
            ListingReviewResult.self,
            from: JSONEncoder().encode(sparse)
        )

        XCTAssertEqual(restoredSparse, sparse)
        let bareMatch = try XCTUnwrap(restoredSparse.verifiedSoldMatches.first)
        XCTAssertNil(bareMatch.title)
        XCTAssertNil(bareMatch.condition)
        XCTAssertNil(bareMatch.soldAt)
        XCTAssertNil(bareMatch.photoURL)
        XCTAssertNil(bareMatch.size)
        XCTAssertNil(bareMatch.format)
        XCTAssertNil(bareMatch.shipping)
        XCTAssertNil(restoredSparse.pricing.sellerPriceOverride)
    }

    func testRelaunchRestoresADraftThroughTheOnDiskRecord() async throws {
        // Two comps, one bare and one carrying every fact, so the record that
        // actually reaches the filesystem has evidence to lose.
        let snapshot = try Self.makeSnapshot(soldMatches: 2)
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let service = ListingReviewRecordingService(
            saves: [],
            reloads: [.success(snapshot), .success(snapshot)]
        )

        let first = makeStore(
            service: service,
            persistence: LocalListingReviewDraftPersistence(rootDirectory: root)
        )
        let firstOpened = await first.open(snapshot)
        XCTAssertTrue(firstOpened)
        await first.setDescription("Locally staged description")
        XCTAssertTrue(first.isDirty)

        // A relaunch keeps the file and nothing else, so the record has to
        // survive a round trip through the app's own encoder. The fixture
        // carries no seller price override, which is the ordinary shape of a
        // review the seller has not repriced yet.
        let relaunched = makeStore(
            service: service,
            persistence: LocalListingReviewDraftPersistence(rootDirectory: root)
        )
        let relaunchedOpened = await relaunched.open(snapshot)
        XCTAssertTrue(relaunchedOpened)
        XCTAssertEqual(
            relaunched.draft?.description,
            "Locally staged description"
        )
        XCTAssertTrue(relaunched.isDirty)

        // The store rebuilds its snapshot from the canonical response on every
        // open, which hides whatever the file lost. Read the record straight
        // off disk so the evidence the seller would be served offline is the
        // thing under assertion.
        let reader = LocalListingReviewDraftPersistence(rootDirectory: root)
        let token = ListingReviewDraftPersistenceToken(
            sessionID: UUID(),
            generation: 0
        )
        let activated = await reader.activate(
            token,
            runID: snapshot.binding.runID
        )
        XCTAssertTrue(activated)
        let record = try await reader.load(
            runID: snapshot.binding.runID,
            token: token
        )
        XCTAssertEqual(record?.snapshot, snapshot)
    }

    func testSemanticRevertBecomesCleanAndRelaunchRestoresDirtyDraft() async throws {
        let snapshot = try Self.makeSnapshot(
            photoURL: "https://media.snaplist.dev/items/expired-550-cover.jpg"
        )
        let refreshed = try Self.makeSnapshot(
            photoURL: "https://media.snaplist.dev/items/fresh-550-cover.jpg"
        )
        let persistence = MemoryListingReviewDraftPersistence()
        let service = ListingReviewRecordingService(
            saves: [],
            reloads: [.success(snapshot), .success(refreshed)]
        )
        let first = makeStore(service: service, persistence: persistence)

        let firstOpened = await first.open(snapshot)
        XCTAssertTrue(firstOpened)
        await first.setDescription("Locally staged description")
        XCTAssertTrue(first.isDirty)

        let relaunched = makeStore(service: service, persistence: persistence)
        let relaunchedOpened = await relaunched.open(snapshot)
        XCTAssertTrue(relaunchedOpened)
        XCTAssertEqual(relaunched.draft?.description, "Locally staged description")
        XCTAssertTrue(relaunched.isDirty)
        XCTAssertEqual(
            relaunched.snapshot?.photos.first?.url,
            refreshed.photos.first?.url
        )

        await relaunched.setDescription(snapshot.listing.description)
        let revertedOutcome = await relaunched.done()
        let saveRequests = await service.recordedSaveRequests()
        XCTAssertFalse(relaunched.isDirty)
        XCTAssertEqual(revertedOutcome, .dismissedWithoutWrite)
        XCTAssertEqual(saveRequests.count, 0)

        XCTAssertTrue(
            LocalListingReviewDraftPersistence.writingOptions
                .contains(.atomic)
        )
        XCTAssertTrue(
            LocalListingReviewDraftPersistence.writingOptions
                .contains(.completeFileProtection)
        )
        let localRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: localRoot) }
        let local = LocalListingReviewDraftPersistence(
            rootDirectory: localRoot
        )
        let localToken = ListingReviewDraftPersistenceToken(
            sessionID: UUID(),
            generation: 1
        )
        let localActivated = await local.activate(
            localToken,
            runID: snapshot.binding.runID
        )
        XCTAssertTrue(localActivated)
        let missingRecord = try await local.load(
            runID: snapshot.binding.runID,
            token: localToken
        )
        XCTAssertNil(missingRecord)
        let record = PersistedListingReviewDraft(
            snapshot: snapshot,
            draft: ListingReviewDraft(snapshot: snapshot),
            pendingSave: nil,
            expiresAt: Date(timeIntervalSince1970: 1_800_086_400)
        )
        let localSaved = try await local.save(
            record,
            runID: snapshot.binding.runID,
            token: localToken
        )
        XCTAssertTrue(localSaved)
        let recordURL = localRoot.appendingPathComponent(
            snapshot.binding.runID.uuidString.lowercased() + ".json"
        )
        try Data("{".utf8).write(to: recordURL, options: .atomic)

        let corruptRecord = try await local.load(
            runID: snapshot.binding.runID,
            token: localToken
        )
        XCTAssertNil(corruptRecord)
        XCTAssertFalse(FileManager.default.fileExists(atPath: recordURL.path))

        let principalProvider = ListingReviewTestBearerProvider(
            subject: "listing-review-principal-a"
        )
        let principalPersistence = MemoryListingReviewDraftPersistence()
        let principalService = ListingReviewRecordingService(
            saves: [],
            reloads: [
                .success(snapshot),
                .failure(ListingReviewClientError.unavailable),
            ]
        )
        let principalStore = makeStore(
            service: principalService,
            persistence: principalPersistence,
            tokenProvider: principalProvider
        )
        let principalOpened = await principalStore.open(snapshot)
        XCTAssertTrue(principalOpened)
        await principalStore.setTitle("Principal A draft")
        await principalProvider.setSubject("listing-review-principal-b")
        let switchedStore = makeStore(
            service: principalService,
            persistence: principalPersistence,
            tokenProvider: principalProvider
        )

        let switchedOpened = await switchedStore.open(snapshot)
        XCTAssertFalse(switchedOpened)
        XCTAssertNil(switchedStore.snapshot)
        XCTAssertNil(switchedStore.draft)

        let newer = try Self.makeSnapshot(
            revision: "55000000-0000-4000-8000-000000000088",
            title: "Newer concurrent open"
        )
        let openService = ListingReviewOpenGateService(
            first: snapshot,
            second: newer
        )
        let openStore = makeStore(service: openService)
        let olderOpen = Task { @MainActor in
            await openStore.open(snapshot)
        }
        await openService.waitUntilFirstFetchBlocked()
        let newerOpened = await openStore.open(newer)
        await openService.releaseFirstFetch()
        let olderOpened = await olderOpen.value

        XCTAssertTrue(newerOpened)
        XCTAssertFalse(olderOpened)
        XCTAssertEqual(openStore.snapshot?.listing.title, newer.listing.title)
    }

    func testConflictKeepsDraftUntilExplicitDiscardReloadSucceeds() async throws {
        let snapshot = try Self.makeSnapshot()
        let current = try Self.makeSnapshot(
            revision: "55000000-0000-4000-8000-000000000099",
            title: "Current server title"
        )
        let service = ListingReviewRecordingService(
            saves: [.failure(ListingReviewClientError.conflict)],
            reloads: [.success(snapshot), .success(current)]
        )
        let store = makeStore(service: service)

        let opened = await store.open(snapshot)
        XCTAssertTrue(opened)
        await store.setTitle("My local title")
        let saveOutcome = await store.done()
        XCTAssertEqual(saveOutcome, .stayed)
        XCTAssertEqual(store.phase, .conflict)

        await store.requestReload()
        XCTAssertEqual(store.phase, .reloadConfirmation)
        store.keepEditing()
        XCTAssertEqual(store.draft?.title, "My local title")
        XCTAssertTrue(store.isDirty)
        let requestsBeforeStaleDone =
            await service.recordedSaveRequests()
        let staleOutcome = await store.done()
        let requestsAfterStaleDone =
            await service.recordedSaveRequests()
        XCTAssertEqual(staleOutcome, .stayed)
        XCTAssertEqual(
            requestsAfterStaleDone.count,
            requestsBeforeStaleDone.count
        )

        await store.requestReload()
        await store.discardChangesAndReload()

        XCTAssertEqual(store.phase, .ready)
        XCTAssertEqual(store.draft?.title, "Current server title")
        XCTAssertFalse(store.isDirty)
    }

    func testTheIdentityDrawerRouteLeavesNothingToSaveOnAnIdentitySpecific() async throws {
        let snapshot = try Self.makeSnapshot()
        // `open` re-fetches canonically rather than trusting what it was
        // handed, so the reload has to be stocked even though this test never
        // means to reload.
        let service = ListingReviewRecordingService(
            saves: [],
            reloads: [.success(snapshot)]
        )
        let store = makeStore(service: service)
        let opened = await store.open(snapshot)
        XCTAssertTrue(opened)

        // Every identity specific on the review resolves to the drawer, and
        // the drawer's only commit is the guided correction route. Nothing on
        // that route can reach the draft, so the screen stays clean and Done
        // has nothing to write. A direct write here would ship a brand the
        // pricing router and the generator never saw.
        let identityNames = try XCTUnwrap(store.draft?.specifics)
            .map(\.name)
            .filter(store.isIdentitySpecific)
        XCTAssertEqual(identityNames, ["Brand", "Model", "Condition"])

        for name in identityNames {
            XCTAssertEqual(
                ListingReviewSpecificEditing.mode(
                    forSpecificNamed: name,
                    correctionAvailable: true
                ),
                .guidedCorrection,
                name
            )
            await store.setSpecific(name: name, value: "Typed by hand")
        }

        XCTAssertEqual(
            store.draft?.specifics.map(\.value),
            ["Sony", "WH-1000XM4", "very-good", "Black"]
        )
        XCTAssertFalse(store.isDirty)
        let outcome = await store.done()
        XCTAssertEqual(outcome, .dismissedWithoutWrite)
        let requests = await service.recordedSaveRequests()
        XCTAssertEqual(requests.count, 0)
    }

    func testFlushingPendingEditsReachesTheDraftBeforeDoneReadsIt() async throws {
        // An inline field holds what was typed until something flushes it.
        // Done and Back both await this, so a seller who types and leaves
        // without dismissing the keyboard does not lose the edit.
        let snapshot = try Self.makeSnapshot()
        let service = ListingReviewRecordingService(
            saves: [],
            reloads: [.success(snapshot)]
        )
        let store = makeStore(service: service)
        let opened = await store.open(snapshot)
        XCTAssertTrue(opened)

        let edits = ListingReviewInlineEdits()
        edits.typed[.title] = "Sony WH-1000XM4 over-ear headphones"
        edits.typed[.description] = "Worn a handful of times."
        edits.typed[.specific("Color")] = "Midnight"
        // An identity key never gets a typed field, so nothing should ever put
        // one here. If something does, the store's own guard is what refuses
        // it, and the flush must not become a second way in.
        edits.typed[.specific("Brand")] = "Typed by hand"

        await edits.flush(into: store)

        XCTAssertTrue(edits.typed.isEmpty)
        XCTAssertEqual(
            store.draft?.title,
            "Sony WH-1000XM4 over-ear headphones"
        )
        XCTAssertEqual(store.draft?.description, "Worn a handful of times.")
        XCTAssertEqual(
            store.draft?.specifics.map(\.value),
            ["Sony", "WH-1000XM4", "very-good", "Midnight"]
        )
        XCTAssertTrue(store.isDirty)
    }

    /// #951. Every 409 except the stale-review sentence used to reach the
    /// seller as `ListingReviewCopy.saveFailed` — "Please try again." — so
    /// #943's permanent refusals told the seller to repeat the one request
    /// that can never succeed, and the remedy the server sent never rendered.
    func testPermanentSaveRefusalRendersTheServerRemedyNotTheRetryCopy() async throws {
        let snapshot = try Self.makeSnapshot()
        // Verbatim from `CONDITION_ALLOWANCE_REFUSAL` in
        // `src/lib/listing-review/save.ts`, which repeats the sentence the
        // migration raises.
        let capRefusal =
            "A condition change alone cannot reprice this item again."
            + " Add, replace, or remove a photo to price it again."
        let cappedStore = makeStore(
            service: makeSaveThroughAPIClient(
                snapshot: snapshot,
                code: "conflict_permanent",
                message: capRefusal
            )
        )

        let cappedOpened = await cappedStore.open(snapshot)
        XCTAssertTrue(cappedOpened)
        await cappedStore.setTitle("Sony WH-1000XM4 with the carry case")
        let cappedOutcome = await cappedStore.done()

        XCTAssertEqual(cappedOutcome, .stayed)
        XCTAssertEqual(cappedStore.announcement, capRefusal)
        // The sentence exists nowhere in the app, so holding it is itself
        // proof the 409 body reached the seller through the live client.
        XCTAssertEqual(cappedStore.phase, .refused)
        // `.failed` is the only phase the review hangs a retry button on, and
        // retrying this save reaches the same refusal every time.
        XCTAssertNotEqual(cappedStore.phase, .failed)
        // Nothing about the review went stale, so the reload alert must not
        // take over the screen either.
        XCTAssertNotEqual(cappedStore.phase, .conflict)
        XCTAssertFalse(cappedStore.isStale)

        // The cap is on repricing from a condition change alone. A draft the
        // seller has since changed is a different question, so the refusal
        // must not outlive the edit that provoked it.
        await cappedStore.setTitle("Sony WH-1000XM4 headphones")
        XCTAssertEqual(cappedStore.phase, .ready)

        // A published listing never becomes editable again, so it gets the
        // same treatment: its own sentence, and no retry.
        let publishedRefusal = "A published listing cannot be changed from review."
        let publishedStore = makeStore(
            service: makeSaveThroughAPIClient(
                snapshot: snapshot,
                code: "conflict_permanent",
                message: publishedRefusal
            )
        )
        let publishedOpened = await publishedStore.open(snapshot)
        XCTAssertTrue(publishedOpened)
        await publishedStore.setTitle("Sony WH-1000XM4 sealed")
        let publishedOutcome = await publishedStore.done()
        XCTAssertEqual(publishedOutcome, .stayed)
        XCTAssertEqual(publishedStore.announcement, publishedRefusal)
        XCTAssertEqual(publishedStore.phase, .refused)

        // Controls. A 409 that is not a permanent refusal keeps the behaviour
        // it had: stale reloads, and everything else stays the generic save
        // failure rather than echoing an internal sentence at the seller.
        let staleStore = makeStore(
            service: makeSaveThroughAPIClient(
                snapshot: snapshot,
                message: ListingReviewCopy.staleReview
            )
        )
        let staleOpened = await staleStore.open(snapshot)
        XCTAssertTrue(staleOpened)
        await staleStore.setTitle("Sony WH-1000XM4 stale edit")
        let staleOutcome = await staleStore.done()
        XCTAssertEqual(staleOutcome, .stayed)
        XCTAssertEqual(staleStore.phase, .conflict)
        XCTAssertEqual(staleStore.announcement, ListingReviewCopy.staleReview)

        let inProgressStore = makeStore(
            service: makeSaveThroughAPIClient(
                snapshot: snapshot,
                message: "This save is already in progress. Try again."
            )
        )
        let inProgressOpened = await inProgressStore.open(snapshot)
        XCTAssertTrue(inProgressOpened)
        await inProgressStore.setTitle("Sony WH-1000XM4 in-flight edit")
        let inProgressOutcome = await inProgressStore.done()
        XCTAssertEqual(inProgressOutcome, .stayed)
        XCTAssertEqual(inProgressStore.phase, .failed)
        XCTAssertEqual(
            inProgressStore.announcement,
            ListingReviewCopy.saveFailed
        )
    }

    // #962 hazard 1: before this issue, price never traveled the
    // View-layer flush mechanism (`ListingReviewInlineEdits.flush(into:)`
    // has no case for price at all), so nothing durably persisted a price
    // edit except an explicit Done tap. This proves the store's own
    // autosave -- not that mechanism -- carries a price edit to the
    // server on its own.
    func testEditingSellerPriceOverrideAloneAutosavesWithoutAnExplicitDone() async throws {
        let snapshot = try Self.makeSnapshot()
        let receipt = Self.receipt(for: snapshot)
        let service = ListingReviewRecordingService(
            saves: [.success(receipt)],
            reloads: [.success(snapshot)]
        )
        let store = makeStore(service: service)

        let opened = await store.open(snapshot)
        XCTAssertTrue(opened)

        await store.setSellerPriceOverride(Decimal(string: "129.99")!)
        let outcome = await store.flushPendingAutosave()

        XCTAssertEqual(outcome, .saved(receipt))
        let requests = await service.recordedSaveRequests()
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(
            requests[0].draft.sellerPriceOverride,
            Decimal(string: "129.99")!
        )
        XCTAssertFalse(store.isDirty)
    }

    // #989: the sibling of the autosave proof above, for the other of the
    // review's two commit paths. `ListingReviewView.finish(retry:)` calls
    // `commitPrice()` before `store.done()` on every Done tap, so a seller
    // price override must reach the same save request an explicit Done
    // produces, not just the one autosave produces on its own.
    func testEditingSellerPriceOverrideThenExplicitDoneCommitsIt() async throws {
        let snapshot = try Self.makeSnapshot()
        let receipt = Self.receipt(for: snapshot)
        let service = ListingReviewRecordingService(
            saves: [.success(receipt)],
            reloads: [.success(snapshot)]
        )
        let store = makeStore(service: service)

        let opened = await store.open(snapshot)
        XCTAssertTrue(opened)

        await store.setSellerPriceOverride(Decimal(string: "129.99")!)
        let outcome = await store.done()

        XCTAssertEqual(outcome, .saved(receipt))
        let requests = await service.recordedSaveRequests()
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(
            requests[0].draft.sellerPriceOverride,
            Decimal(string: "129.99")!
        )
        XCTAssertFalse(store.isDirty)
    }

    // #962 hazard 2: autosave keeps the same store open across many saves
    // in one sitting, unlike `done()`, which always dismissed after its
    // one save. The store must advance its own idea of the review
    // revision after each save, or the second save's
    // `expectedReviewRevision` goes stale and a save that should succeed
    // 409s instead.
    func testSequentialAutosavesAdvanceTheExpectedReviewRevision() async throws {
        let snapshot = try Self.makeSnapshot()
        let firstRevision = UUID(
            uuidString: "55000000-0000-4000-8000-000000000061"
        )!
        let secondRevision = UUID(
            uuidString: "55000000-0000-4000-8000-000000000062"
        )!
        let firstReceipt = ListingReviewSaveReceipt(
            schemaVersion: 1,
            runID: snapshot.binding.runID,
            itemID: snapshot.binding.itemID,
            listingID: snapshot.binding.listingID,
            reviewRevision: firstRevision
        )
        let secondReceipt = ListingReviewSaveReceipt(
            schemaVersion: 1,
            runID: snapshot.binding.runID,
            itemID: snapshot.binding.itemID,
            listingID: snapshot.binding.listingID,
            reviewRevision: secondRevision
        )
        let service = ListingReviewRecordingService(
            saves: [.success(firstReceipt), .success(secondReceipt)],
            reloads: [.success(snapshot)]
        )
        let store = makeStore(service: service)

        let opened = await store.open(snapshot)
        XCTAssertTrue(opened)

        await store.setSellerPriceOverride(Decimal(99))
        let firstOutcome = await store.flushPendingAutosave()
        XCTAssertEqual(firstOutcome, .saved(firstReceipt))

        await store.setTitle("Sony WH-1000XM4 headphones, mint condition")
        let secondOutcome = await store.flushPendingAutosave()
        XCTAssertEqual(secondOutcome, .saved(secondReceipt))

        let requests = await service.recordedSaveRequests()
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(
            requests[0].expectedRevision,
            snapshot.binding.reviewRevision
        )
        XCTAssertEqual(requests[1].expectedRevision, firstRevision)
    }

    // #962 hazard 5: a silent autosave attempt that genuinely fails must
    // surface the same truthful, retryable state an explicit Done would --
    // and must not drop the edit that failed to save.
    func testFlushPendingAutosaveSurfacesAnHonestFailureAndKeepsTheDraft() async throws {
        let snapshot = try Self.makeSnapshot()
        let service = ListingReviewRecordingService(
            saves: [.failure(ListingReviewClientError.offline)],
            reloads: [.success(snapshot)]
        )
        let store = makeStore(service: service)

        let opened = await store.open(snapshot)
        XCTAssertTrue(opened)

        await store.setTitle("Sony WH-1000XM4 headphones, boxed")
        let outcome = await store.flushPendingAutosave()

        XCTAssertEqual(outcome, .stayed)
        XCTAssertEqual(store.phase, .offline)
        XCTAssertEqual(
            store.announcement,
            "You're offline. Your changes are saved on this phone."
        )
        XCTAssertTrue(store.isDirty)
        XCTAssertEqual(
            store.draft?.title,
            "Sony WH-1000XM4 headphones, boxed"
        )
    }

    // #974 round-1 fix (Standards BLOCK): every mutator early-returned
    // without touching `draft` whenever `phase == .saving`, while no field
    // was disabled during a save -- so a field switch during any ordinary
    // network round trip silently vanished (not in `draft`, not on disk,
    // not in the caller's local buffer). This is the RED reproduction: a
    // mutator call lands mid-flight, on a slow/suspended mock transport,
    // and must survive -- staged, dirty, and durably persisted by a
    // follow-up save once the in-flight one completes.
    func testMutatorDuringAnInFlightSaveStagesTheEditAndAFollowUpSavePersistsIt() async throws {
        let snapshot = try Self.makeSnapshot()
        let firstReceipt = Self.receipt(for: snapshot)
        let secondReceipt = ListingReviewSaveReceipt(
            schemaVersion: 1,
            runID: snapshot.binding.runID,
            itemID: snapshot.binding.itemID,
            listingID: snapshot.binding.listingID,
            reviewRevision: UUID(
                uuidString: "55000000-0000-4000-8000-000000000080"
            )!
        )
        let service = ListingReviewSaveGateService(
            saves: [.success(firstReceipt), .success(secondReceipt)],
            reload: snapshot
        )
        let store = makeStore(service: service)

        let opened = await store.open(snapshot)
        XCTAssertTrue(opened)

        await store.setTitle("Sony WH-1000XM4 headphones with case")
        let saveTask = Task { @MainActor in await store.done() }
        await service.waitUntilSaveBlocked()

        // Lands entirely inside the network round trip, while
        // phase == .saving and no field is disabled.
        await store.setDescription(
            "Mid-flight edit during the network round trip"
        )
        XCTAssertEqual(store.phase, .saving)
        XCTAssertEqual(
            store.draft?.description,
            "Mid-flight edit during the network round trip"
        )
        XCTAssertTrue(store.isDirty)

        await service.releaseSave()
        let firstOutcome = await saveTask.value
        XCTAssertEqual(firstOutcome, .saved(firstReceipt))

        // The mid-flight edit must reach the server on its own, without
        // another explicit Done, threading the revision the completing
        // save just returned.
        let followUpOutcome = await store.flushPendingAutosave()
        XCTAssertEqual(followUpOutcome, .saved(secondReceipt))

        let requests = await service.recordedSaveRequests()
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(
            requests[0].draft.title,
            "Sony WH-1000XM4 headphones with case"
        )
        XCTAssertEqual(
            requests[0].draft.description,
            snapshot.listing.description
        )
        XCTAssertEqual(
            requests[0].expectedRevision,
            snapshot.binding.reviewRevision
        )
        XCTAssertEqual(
            requests[1].draft.description,
            "Mid-flight edit during the network round trip"
        )
        XCTAssertEqual(
            requests[1].expectedRevision,
            firstReceipt.reviewRevision
        )
        XCTAssertFalse(store.isDirty)
    }

    // #974 round-1 fix: a flush requested while a save is already in
    // flight (the debounce firing mid-network-round-trip) must not race
    // the in-flight request. It has to be remembered and resaved,
    // serialized, once the in-flight save completes -- never two requests
    // interleaved, and the follow-up must use the revision the completing
    // save just returned.
    func testAFlushRequestedWhileASaveIsInFlightResavesSerializedAfterItCompletes() async throws {
        let snapshot = try Self.makeSnapshot()
        let firstReceipt = Self.receipt(for: snapshot)
        let secondReceipt = ListingReviewSaveReceipt(
            schemaVersion: 1,
            runID: snapshot.binding.runID,
            itemID: snapshot.binding.itemID,
            listingID: snapshot.binding.listingID,
            reviewRevision: UUID(
                uuidString: "55000000-0000-4000-8000-000000000081"
            )!
        )
        let service = ListingReviewSaveGateService(
            saves: [.success(firstReceipt), .success(secondReceipt)],
            reload: snapshot
        )
        let store = makeStore(service: service)

        let opened = await store.open(snapshot)
        XCTAssertTrue(opened)

        await store.setTitle("Blocked save title")
        let saveTask = Task { @MainActor in await store.done() }
        await service.waitUntilSaveBlocked()

        await store.setDescription("Second edit while blocked")
        let earlyOutcome = await store.flushPendingAutosave()
        XCTAssertEqual(earlyOutcome, .stayed)
        let inFlightRequests = await service.recordedSaveRequests()
        XCTAssertEqual(inFlightRequests.count, 0)

        await service.releaseSave()
        let outcome = await saveTask.value
        // The in-flight save's own wrapper discharges the resave flag and
        // returns the follow-up's outcome, not the original save's.
        XCTAssertEqual(outcome, .saved(secondReceipt))

        let requests = await service.recordedSaveRequests()
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[0].draft.title, "Blocked save title")
        XCTAssertEqual(
            requests[0].draft.description,
            snapshot.listing.description
        )
        XCTAssertEqual(
            requests[0].expectedRevision,
            snapshot.binding.reviewRevision
        )
        XCTAssertEqual(
            requests[1].draft.description,
            "Second edit while blocked"
        )
        XCTAssertEqual(
            requests[1].expectedRevision,
            firstReceipt.reviewRevision
        )
        XCTAssertFalse(store.isDirty)
    }

    // #974 round-2 fix (Standards BLOCK, finding 1): the round-1 relaxed
    // staleness guard inferred "own newer edit, safe to report success"
    // purely from whether *this* attempt's own captured generation still
    // matched the current one. That inference is wrong when a second local
    // edit AND a foreign session's takeover both land in the same blocked
    // window -- both make the generation check true, but only one of them
    // is safe. This is the RED reproduction: a foreign token takes over the
    // persisted draft while a local edit is also in flight, and the save
    // must never claim success once that happens.
    func testForeignTakeoverDuringAMidFlightEditIsNeverMaskedAsASuccessfulSave() async throws {
        let snapshot = try Self.makeSnapshot()
        let firstReceipt = Self.receipt(for: snapshot)
        let persistence = MemoryListingReviewDraftPersistence()
        let service = ListingReviewSaveGateService(
            saves: [.success(firstReceipt)],
            reload: snapshot
        )
        let store = makeStore(service: service, persistence: persistence)

        let opened = await store.open(snapshot)
        XCTAssertTrue(opened)

        await store.setTitle("Sony WH-1000XM4 headphones with case")
        let saveTask = Task { @MainActor in await store.done() }
        await service.waitUntilSaveBlocked()

        // A second local edit lands mid-flight, exactly like the round-1
        // fix's own scenario -- but this time a different session also
        // takes over the persisted draft in the same window (e.g. the
        // seller reopened review on another device).
        await store.setDescription("Second local edit during the same save")
        let foreignToken = ListingReviewDraftPersistenceToken(
            sessionID: UUID(),
            generation: 0
        )
        let tookOver = await persistence.activate(
            foreignToken,
            runID: snapshot.binding.runID
        )
        XCTAssertTrue(tookOver)

        await service.releaseSave()
        let outcome = await saveTask.value

        // The save must not claim success while a foreign session now owns
        // the persisted draft -- that would be a silent last-write-wins.
        XCTAssertEqual(outcome, .stayed)
        XCTAssertEqual(store.phase, .conflict)
        XCTAssertTrue(store.isStale)
        XCTAssertEqual(
            store.snapshot?.binding.reviewRevision,
            snapshot.binding.reviewRevision
        )
        XCTAssertTrue(store.isDirty)
    }

    // #974 round-2 fix (Standards BLOCK, finding 2): `stage()`'s
    // `persisted == false` branch used to write `phase = .failed`
    // unconditionally, even while a save was already in flight --
    // clobbering `executeSave`'s own `guard phase == .saving` checks and
    // abandoning that attempt with no recovery. This is the RED
    // reproduction: a mid-save `stage()` persistence failure must defer to
    // the in-flight save's own honest outcome instead of stomping its
    // phase.
    func testAMidSaveStagingFailureDefersToTheInFlightSavesOwnOutcome() async throws {
        let snapshot = try Self.makeSnapshot()
        let firstReceipt = Self.receipt(for: snapshot)
        let persistence = ListingReviewTogglePersistence()
        let service = ListingReviewSaveGateService(
            saves: [.success(firstReceipt)],
            reload: snapshot
        )
        let store = makeStore(service: service, persistence: persistence)

        let opened = await store.open(snapshot)
        XCTAssertTrue(opened)

        await store.setTitle("Sony WH-1000XM4 headphones with case")
        let saveTask = Task { @MainActor in await store.done() }
        await service.waitUntilSaveBlocked()

        await persistence.failSaves()
        await store.setDescription(
            "Mid-flight edit while local persistence is failing"
        )

        // The in-flight save still owns `phase` -- a failed *local* disk
        // write for this edit must not report it as a dropped save.
        XCTAssertEqual(store.phase, .saving)
        XCTAssertEqual(
            store.draft?.description,
            "Mid-flight edit while local persistence is failing"
        )
        XCTAssertTrue(store.isDirty)

        await service.releaseSave()
        let outcome = await saveTask.value

        // The in-flight save's own network round trip still succeeded, but
        // the edit it owed a resave for could never durably land while
        // local persistence keeps failing -- so the deferred resave
        // surfaces as an honest failure, not a second silent drop and not
        // stuck in `.saving`.
        XCTAssertEqual(outcome, .stayed)
        XCTAssertEqual(store.phase, .failed)
        XCTAssertEqual(
            store.announcement,
            ListingReviewCopy.draftPersistenceFailed
        )
        XCTAssertTrue(store.isDirty)
        XCTAssertEqual(
            store.draft?.description,
            "Mid-flight edit while local persistence is failing"
        )
    }

    private func makeStore(
        service: any ListingReviewServing,
        persistence: any ListingReviewDraftPersisting =
            MemoryListingReviewDraftPersistence(),
        tokenProvider: any BearerTokenProviding =
            ListingReviewTestBearerProvider()
    ) -> ListingReviewStore {
        ListingReviewStore(
            service: service,
            persistence: persistence,
            tokenProvider: tokenProvider,
            now: { Date(timeIntervalSince1970: 1_800_000_000) },
            makeID: {
                UUID(uuidString: "55000000-0000-4000-8000-000000000050")!
            }
        )
    }

    /// The refusal has to travel through the real `ListingReviewAPIClient`,
    /// but opening the review is a run read the same stubbed session would
    /// answer with the same 409. So only the save path is the live client;
    /// the read replays the snapshot the review opened with.
    private func makeSaveThroughAPIClient(
        snapshot: ListingReviewResult,
        code: String = "conflict",
        message: String
    ) -> any ListingReviewServing {
        ListingReviewSaveThroughAPIClient(
            client: ListingReviewAPIClient(
                baseURL: URL(string: "https://api.snaplist.dev")!,
                session: makeConflictSession(code: code, message: message)
            ),
            snapshot: snapshot
        )
    }

    private func makeConflictSession(
        code: String = "conflict",
        message: String
    ) -> URLSession {
        ListingReviewURLProtocolStub.handler = { request in
            (
                HTTPURLResponse(
                    url: try XCTUnwrap(request.url),
                    statusCode: 409,
                    httpVersion: nil,
                    headerFields: ["Content-Type": "application/json"]
                )!,
                Data(
                    """
                    {
                      "error": {
                        "code": "\(code)",
                        "message": "\(message)",
                        "requestId": "listing-review-request"
                      }
                    }
                    """.utf8
                )
            )
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ListingReviewURLProtocolStub.self]
        return URLSession(configuration: configuration)
    }

    private static func receipt(
        for snapshot: ListingReviewResult
    ) -> ListingReviewSaveReceipt {
        ListingReviewSaveReceipt(
            schemaVersion: 1,
            runID: snapshot.binding.runID,
            itemID: snapshot.binding.itemID,
            listingID: snapshot.binding.listingID,
            reviewRevision: UUID(
                uuidString: "55000000-0000-4000-8000-000000000051"
            )!
        )
    }

    private static func makeSnapshot(
        revision: String = "55000000-0000-4000-8000-000000000004",
        title: String = "Sony WH-1000XM4 Noise-Canceling Headphones",
        photoURL: String =
            "https://media.snaplist.dev/items/550-cover.jpg",
        sellerPriceOverride: Decimal? = nil,
        soldMatches: Int = 0
    ) throws -> ListingReviewResult {
        // One match carries every fact and one carries none, so a payload with
        // comps behind it exercises both shapes the read contract allows: the
        // nullable keys the server always sends, and the optional keys it
        // omits outright.
        let matches: [[String: Any]] = (0..<soldMatches).map { index in
            let bare = index == 0
            var match: [String: Any] = [
                "id": "sold-\(index + 1)",
                "sourceURL": "https://example.com/sold/\(index + 1)",
                "title": bare ? NSNull() as Any : "Sony WH-1000XM4" as Any,
                "soldPrice": 140 + index,
                "currency": "USD",
                "condition": bare ? NSNull() as Any : "used" as Any,
                "soldAt": bare ? NSNull() as Any : 1_750_000_000 as Any,
            ]
            guard !bare else { return match }
            match["photoURL"] =
                "https://media.snaplist.dev/sold/\(index + 1).jpg"
            match["size"] = "One size"
            match["format"] = "buy-it-now"
            match["shipping"] = [
                "type": "paid",
                // 8.75 is binary-exact, so a `Double` literal survives here by
                // luck. 8.95 would not. Carry the decimal exactly so the
                // fixture never depends on that.
                "price": NSDecimalNumber(string: "8.75"),
                "currency": "USD",
            ]
            return match
        }
        let object: [String: Any] = [
            "schemaVersion": 1,
            "binding": [
                "runId": "55000000-0000-4000-8000-000000000001",
                "itemId": "55000000-0000-4000-8000-000000000002",
                "listingId": "55000000-0000-4000-8000-000000000003",
                "reviewContentRevision": revision,
                "reviewRevision": revision,
            ],
            "photos": [[
                "ordinal": 0,
                "url": photoURL,
            ]],
            "identity": [
                "label": "Sony WH-1000XM4",
                "confident": true,
            ],
            "listing": [
                "title": title,
                "description": "Clean, fully working headphones with case and charging cable.",
                "condition": "very-good",
                "specifics": [
                    ["name": "Brand", "value": "Sony"],
                    ["name": "Model", "value": "WH-1000XM4"],
                    ["name": "Condition", "value": "very-good"],
                    ["name": "Color", "value": "Black"],
                ],
            ],
            "pricing": [
                "suggestedPrice": 145,
                "range": ["minimum": 130, "maximum": 160],
                "confidence": 0.72,
                "sellerPriceOverride": sellerPriceOverride.map {
                    NSDecimalNumber(decimal: $0) as Any
                } ?? (NSNull() as Any),
                "effectivePrice": NSDecimalNumber(
                    decimal: sellerPriceOverride ?? 145
                ),
            ],
            "evidenceAsOf": "2026-07-29T12:03:00.000Z",
            "verifiedSoldMatches": matches,
            "startingPriceCopy": "Starting price estimate",
            "soldEvidenceCopy": matches.isEmpty
                ? "No verified sold matches found." as Any
                : NSNull() as Any,
        ]
        return try JSONDecoder().decode(
            ListingReviewResult.self,
            from: JSONSerialization.data(withJSONObject: object)
        )
    }
}

private struct ListingReviewSaveThroughAPIClient: ListingReviewServing {
    let client: ListingReviewAPIClient
    let snapshot: ListingReviewResult

    func save(
        runID: UUID,
        draft: ListingReviewDraft,
        expectedReviewRevision: UUID,
        idempotencyKey: UUID,
        bearerToken: String
    ) async throws -> ListingReviewSaveReceipt {
        try await client.save(
            runID: runID,
            draft: draft,
            expectedReviewRevision: expectedReviewRevision,
            idempotencyKey: idempotencyKey,
            bearerToken: bearerToken
        )
    }

    func fetchReview(
        runID: UUID,
        bearerToken: String
    ) async throws -> ListingReviewResult {
        snapshot
    }
}

private final class ListingReviewURLProtocolStub:
    URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler:
        (@Sendable (URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(
        for request: URLRequest
    ) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(
                self,
                didFailWithError: URLError(.badServerResponse)
            )
            return
        }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(
                self,
                didReceive: response,
                cacheStoragePolicy: .notAllowed
            )
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

private actor ListingReviewTestBearerProvider: BearerTokenProviding {
    private var subject: String

    init(subject: String = "listing-review-test-user") {
        self.subject = subject
    }

    func setSubject(_ value: String) {
        subject = value
    }

    func bearerToken() async throws -> String {
        "listing-review-test-bearer"
    }

    func principalBoundBearer() async throws -> PrincipalBoundBearer {
        PrincipalBoundBearer(
            bearerToken: "listing-review-test-bearer",
            scopeProof: ItemRunSubmissionPrincipalScopeProof(
                verifiedClerkSubject: subject
            )!
        )
    }
}

private actor ListingReviewTogglePersistence:
    ListingReviewDraftPersisting {
    private let base = MemoryListingReviewDraftPersistence()
    private var shouldFailSaves = false

    func failSaves() {
        shouldFailSaves = true
    }

    func activate(
        _ token: ListingReviewDraftPersistenceToken,
        runID: UUID
    ) async -> Bool {
        await base.activate(token, runID: runID)
    }

    func load(
        runID: UUID,
        token: ListingReviewDraftPersistenceToken
    ) async throws -> PersistedListingReviewDraft? {
        try await base.load(runID: runID, token: token)
    }

    func save(
        _ record: PersistedListingReviewDraft,
        runID: UUID,
        token: ListingReviewDraftPersistenceToken
    ) async throws -> Bool {
        if shouldFailSaves {
            throw CocoaError(.fileWriteUnknown)
        }
        return try await base.save(record, runID: runID, token: token)
    }

    func remove(
        runID: UUID,
        token: ListingReviewDraftPersistenceToken
    ) async throws -> Bool {
        try await base.remove(runID: runID, token: token)
    }
}

private actor ListingReviewCommitGatePersistence:
    ListingReviewDraftPersisting {
    enum Gate {
        case save(title: String)
        case remove
    }

    private let gate: Gate
    private let base = MemoryListingReviewDraftPersistence()
    private var didBlock = false
    private var isBlocked = false
    private var blockedWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseContinuation: CheckedContinuation<Void, Never>?

    init(gate: Gate) {
        self.gate = gate
    }

    func activate(
        _ token: ListingReviewDraftPersistenceToken,
        runID: UUID
    ) async -> Bool {
        await base.activate(token, runID: runID)
    }

    func load(
        runID: UUID,
        token: ListingReviewDraftPersistenceToken
    ) async throws -> PersistedListingReviewDraft? {
        try await base.load(runID: runID, token: token)
    }

    func save(
        _ record: PersistedListingReviewDraft,
        runID: UUID,
        token: ListingReviewDraftPersistenceToken
    ) async throws -> Bool {
        if case let .save(title) = gate,
           record.draft.title == title {
            await blockOnce()
        }
        return try await base.save(record, runID: runID, token: token)
    }

    func remove(
        runID: UUID,
        token: ListingReviewDraftPersistenceToken
    ) async throws -> Bool {
        if case .remove = gate {
            await blockOnce()
        }
        return try await base.remove(runID: runID, token: token)
    }

    func waitUntilBlocked() async {
        guard !isBlocked else { return }
        await withCheckedContinuation {
            blockedWaiters.append($0)
        }
    }

    func release() {
        releaseContinuation?.resume()
        releaseContinuation = nil
    }

    func loadCurrent(
        runID: UUID
    ) async throws -> PersistedListingReviewDraft? {
        let token = ListingReviewDraftPersistenceToken(
            sessionID: UUID(),
            generation: 0
        )
        guard await base.activate(token, runID: runID) else { return nil }
        return try await base.load(runID: runID, token: token)
    }

    private func blockOnce() async {
        guard !didBlock else { return }
        didBlock = true
        isBlocked = true
        blockedWaiters.forEach { $0.resume() }
        blockedWaiters.removeAll()
        await withCheckedContinuation {
            releaseContinuation = $0
        }
    }
}

private actor ListingReviewGateBearerProvider: BearerTokenProviding {
    private let blockedCall: Int
    private var callCount = 0
    private var isBlocked = false
    private var blockedWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseContinuation: CheckedContinuation<Void, Never>?

    init(blockedCall: Int) {
        self.blockedCall = blockedCall
    }

    func bearerToken() async throws -> String {
        "listing-review-gate-bearer"
    }

    func principalBoundBearer() async throws -> PrincipalBoundBearer {
        callCount += 1
        if callCount == blockedCall {
            isBlocked = true
            blockedWaiters.forEach { $0.resume() }
            blockedWaiters.removeAll()
            await withCheckedContinuation {
                releaseContinuation = $0
            }
        }
        return PrincipalBoundBearer(
            bearerToken: "listing-review-gate-bearer",
            scopeProof: ItemRunSubmissionPrincipalScopeProof(
                verifiedClerkSubject: "listing-review-gate-user"
            )!
        )
    }

    func waitUntilBlocked() async {
        guard !isBlocked else { return }
        await withCheckedContinuation {
            blockedWaiters.append($0)
        }
    }

    func release() {
        releaseContinuation?.resume()
        releaseContinuation = nil
    }
}

private actor ListingReviewOpenGateService: ListingReviewServing {
    private let first: ListingReviewResult
    private let second: ListingReviewResult
    private var fetchCount = 0
    private var isBlocked = false
    private var blockedWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseContinuation: CheckedContinuation<Void, Never>?

    init(first: ListingReviewResult, second: ListingReviewResult) {
        self.first = first
        self.second = second
    }

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
        fetchCount += 1
        if fetchCount == 1 {
            isBlocked = true
            blockedWaiters.forEach { $0.resume() }
            blockedWaiters.removeAll()
            await withCheckedContinuation {
                releaseContinuation = $0
            }
            return first
        }
        return second
    }

    func waitUntilFirstFetchBlocked() async {
        guard !isBlocked else { return }
        await withCheckedContinuation {
            blockedWaiters.append($0)
        }
    }

    func releaseFirstFetch() {
        releaseContinuation?.resume()
        releaseContinuation = nil
    }
}

private actor ListingReviewRecordingService: ListingReviewServing {
    struct SaveRequest: Equatable {
        let idempotencyKey: UUID
        let expectedRevision: UUID
        let draft: ListingReviewDraft
    }

    private var saves: [Result<ListingReviewSaveReceipt, Error>]
    private var reloads: [Result<ListingReviewResult, Error>]
    private(set) var saveRequests: [SaveRequest] = []

    init(
        saves: [Result<ListingReviewSaveReceipt, Error>],
        reloads: [Result<ListingReviewResult, Error>]
    ) {
        self.saves = saves
        self.reloads = reloads
    }

    func save(
        runID: UUID,
        draft: ListingReviewDraft,
        expectedReviewRevision: UUID,
        idempotencyKey: UUID,
        bearerToken: String
    ) async throws -> ListingReviewSaveReceipt {
        saveRequests.append(
            SaveRequest(
                idempotencyKey: idempotencyKey,
                expectedRevision: expectedReviewRevision,
                draft: draft
            )
        )
        guard !saves.isEmpty else { throw ListingReviewClientError.unavailable }
        return try saves.removeFirst().get()
    }

    func fetchReview(
        runID: UUID,
        bearerToken: String
    ) async throws -> ListingReviewResult {
        guard !reloads.isEmpty else { throw ListingReviewClientError.unavailable }
        return try reloads.removeFirst().get()
    }

    func recordedSaveRequests() -> [SaveRequest] {
        saveRequests
    }
}

/// A slow/suspended mock transport: blocks inside its first `save(...)`
/// call, at the seam a real network round trip would suspend, so a test can
/// land a mutator call while `phase == .saving` and before the request has
/// even been recorded -- not merely before a bearer fetch or a persistence
/// commit, which the other gate doubles already cover.
private actor ListingReviewSaveGateService: ListingReviewServing {
    struct SaveRequest: Equatable {
        let idempotencyKey: UUID
        let expectedRevision: UUID
        let draft: ListingReviewDraft
    }

    private var saves: [Result<ListingReviewSaveReceipt, Error>]
    private let reload: ListingReviewResult
    private(set) var saveRequests: [SaveRequest] = []
    private var isBlocked = false
    private var blockedWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseContinuation: CheckedContinuation<Void, Never>?

    init(
        saves: [Result<ListingReviewSaveReceipt, Error>],
        reload: ListingReviewResult
    ) {
        self.saves = saves
        self.reload = reload
    }

    func save(
        runID: UUID,
        draft: ListingReviewDraft,
        expectedReviewRevision: UUID,
        idempotencyKey: UUID,
        bearerToken: String
    ) async throws -> ListingReviewSaveReceipt {
        if !isBlocked {
            isBlocked = true
            blockedWaiters.forEach { $0.resume() }
            blockedWaiters.removeAll()
            await withCheckedContinuation {
                releaseContinuation = $0
            }
        }
        saveRequests.append(
            SaveRequest(
                idempotencyKey: idempotencyKey,
                expectedRevision: expectedReviewRevision,
                draft: draft
            )
        )
        guard !saves.isEmpty else { throw ListingReviewClientError.unavailable }
        return try saves.removeFirst().get()
    }

    func fetchReview(
        runID: UUID,
        bearerToken: String
    ) async throws -> ListingReviewResult {
        reload
    }

    func waitUntilSaveBlocked() async {
        guard !isBlocked else { return }
        await withCheckedContinuation {
            blockedWaiters.append($0)
        }
    }

    func releaseSave() {
        releaseContinuation?.resume()
        releaseContinuation = nil
    }

    func recordedSaveRequests() -> [SaveRequest] {
        saveRequests
    }
}
