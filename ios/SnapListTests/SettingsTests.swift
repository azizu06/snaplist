import SwiftUI
import UserNotifications
import XCTest
@testable import SnapList

final class SettingsTests: XCTestCase {
    func testShareUsageAnalyticsPreferenceDefaultsOnAndPersistsAcrossRelaunch() throws {
        let suiteName = "SettingsTests-analytics-consent-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let first = UserDefaultsAnalyticsConsentStore(defaults: defaults)
        XCTAssertEqual(first.consent, .granted)

        first.setConsent(.denied)
        XCTAssertEqual(
            UserDefaultsAnalyticsConsentStore(defaults: defaults).consent,
            .denied
        )

        first.setConsent(.granted)
        XCTAssertEqual(
            UserDefaultsAnalyticsConsentStore(defaults: defaults).consent,
            .granted
        )
    }

    func testNoOpAnalyticsClientPersistsTheSettingsToggle() throws {
        let suiteName = "SettingsTests-noop-analytics-consent-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = UserDefaultsAnalyticsConsentStore(defaults: defaults)
        let client = NoOpAnalyticsClient(consentStore: store)

        try client.setConsent(.denied)
        XCTAssertEqual(store.consent, .denied)

        try client.setConsent(.granted)
        XCTAssertEqual(store.consent, .granted)
    }

    func testAnalyticsToggleRetainsActualConsentAndReportsFailure() {
        let client = FailingSettingsAnalyticsClient()
        var state = SettingsAnalyticsConsentState(consent: .denied)

        state.request(true, using: client)

        XCTAssertFalse(state.isEnabled)
        XCTAssertTrue(state.showsError)
        XCTAssertEqual(client.requestedConsents, [.granted])
    }

    @MainActor
    func testSettingsEntryUsesTheTrophyWallProfileRoute() {
        let router = AppRouter(initialTab: .trophyWall)

        router.navigate(to: .settings)

        XCTAssertEqual(router.selectedTab, .trophyWall)
        XCTAssertEqual(
            router.pathBinding(for: .trophyWall).wrappedValue,
            [.settings]
        )
        XCTAssertEqual(FoundationFixture.account.initialTab, .trophyWall)
        XCTAssertEqual(FoundationFixture.account.initialRoute, .settings)
    }

    func testMemberAccountEntryDestinationDefaultsToNil() {
        let destination = SettingsAccountEntryPolicy.destination(
            for: .member(method: .apple, email: "seller@example.com")
        )

        XCTAssertNil(destination)
    }

    func testGuestAccountEntryUsesTypedAccountRoute() {
        XCTAssertEqual(
            SettingsAccountEntryPolicy.destination(for: .guest),
            .future(.account)
        )
    }

    /// #844. The ACCOUNT card holds exactly one control, and which one it is
    /// follows from the identity: a guest is offered the account they do not
    /// have, a member is offered the way out of the one they do. Before this
    /// the member branch was a static `valueRow`, so the only way to stop being
    /// signed in was to delete the account.
    func testSignOutIsOfferedToAMemberAndNeverToAGuest() {
        XCTAssertTrue(
            SettingsSignOutPolicy.isAvailable(
                for: .member(method: .apple, email: "seller@example.com")
            )
        )
        XCTAssertTrue(
            SettingsSignOutPolicy.isAvailable(
                for: .member(method: .emailCode, email: "seller@example.com")
            )
        )
        XCTAssertFalse(SettingsSignOutPolicy.isAvailable(for: .guest))
    }

    /// #844, acceptance criterion 1, the guest half.
    ///
    /// The ACCOUNT card branches on `SettingsAccountEntryPolicy` for the
    /// account row and on `SettingsSignOutPolicy` for the sign-out row, and
    /// nothing else. Proving the two are exact complements is therefore proof
    /// that the card offers exactly one of them per identity — a guest can no
    /// more reach a sign-out than a member can reach `Create an account`.
    ///
    /// Asserted here rather than in a UI test because `--fixture=account` is
    /// the only launch fixture that opens Settings, and it is a member by
    /// construction; adding a guest fixture means editing
    /// `LaunchConfiguration`, which this issue does not own.
    func testTheAccountCardOffersExactlyOneControlPerIdentity() {
        let identities: [SettingsIdentity] = [
            .guest,
            .member(method: .apple, email: "seller@example.com"),
            .member(method: .emailCode, email: "seller@example.com"),
        ]

        for identity in identities {
            let offersAccountEntry =
                SettingsAccountEntryPolicy.destination(for: identity) != nil
            let offersSignOut = SettingsSignOutPolicy.isAvailable(for: identity)

            XCTAssertNotEqual(
                offersAccountEntry,
                offersSignOut,
                "\(identity) is offered both controls or neither"
            )
        }
    }

    /// #844, acceptance criterion 8. The wording must not read as account
    /// deletion.
    ///
    /// Two halves, because either alone is cheap to satisfy. The screen has to
    /// say the account survives — in words, not by omission — and no string on
    /// it may be a deletion claim. The second half scans every string the
    /// screen shows rather than a list restated here, so copy added later is
    /// covered without anyone remembering to extend this.
    func testSignOutCopyStatesTheAccountSurvivesAndNeverClaimsDeletion() {
        XCTAssertTrue(
            SettingsSignOutCopy.unchanged.contains {
                $0.contains("This is not account deletion")
            },
            "the screen has to deny deletion outright, not merely omit it"
        )
        XCTAssertTrue(
            SettingsSignOutCopy.unchanged.contains {
                $0.localizedCaseInsensitiveContains("signing back in")
            },
            "criterion 6 is a promise the copy has to make, not just a behaviour"
        )
        XCTAssertEqual(SettingsSignOutCopy.cancel, "Stay signed in")

        // The only sentence allowed to mention deleting is the one that points
        // deletion somewhere else.
        // "delet" catches delete, deleted, deletion and deleting alike;
        // spelling out "delete" alone missed "Deleting your account".
        let deletionWords = ["delet", "eras", "permanent", "remove your account"]
        let deletionClaims = SettingsSignOutCopy.everyString.filter { line in
            deletionWords.contains { line.localizedCaseInsensitiveContains($0) }
        }
        XCTAssertEqual(
            Set(deletionClaims),
            [
                SettingsSignOutCopy.deletionIsElsewhere,
                "Your account stays. This is not account deletion.",
            ],
            "a sign-out screen may point at deletion, never announce one"
        )
        // Positive control: the filter above finds deletion words when they are
        // there, so an empty-but-for-the-two result is a real absence.
        XCTAssertFalse(
            SettingsSignOutCopy.everyString.filter {
                $0.localizedCaseInsensitiveContains("delet")
            }.isEmpty
        )
    }

    func testSettingsProofStateDefaultsOff() {
        XCTAssertNil(LaunchConfiguration.standard.settingsProofState)
        XCTAssertNil(
            LaunchConfiguration.parse(arguments: []).settingsProofState
        )
    }

    func testSettingsProofFixturesAreExactAndDefaultDeny() {
        let approvedFixtureIDs = [
            "SET-01",
            "DEL-01",
            "DEL-02",
            "DEL-03",
        ]

        for fixtureID in approvedFixtureIDs {
            let configuration = LaunchConfiguration.parse(
                arguments: ["--settings-proof=\(fixtureID)"]
            )

            XCTAssertEqual(configuration.settingsProofState?.rawValue, fixtureID)
            XCTAssertEqual(configuration.fixture, .account)
            XCTAssertTrue(configuration.usesZeroNetworkFixtures)
        }

        for unrecognizedArgument in [
            "--settings-proof",
            "--settings-proof=SET-00",
            "--settings-proof=DEL-02f",
            "--settings-proof=DEL-04",
            "--settings-proof=SET-01-extra",
            "--settings-proof=production",
        ] {
            let configuration = LaunchConfiguration.parse(
                arguments: [unrecognizedArgument]
            )

            XCTAssertNil(configuration.settingsProofState)
            XCTAssertEqual(configuration, .standard)
        }
    }

    func testGuestAndMemberLocalRemovalAreSeparateFrozenScreens() {
        var guest = SettingsFlow(identity: .guest, hasLocalData: true)
        var member = SettingsFlow(
            identity: .member(method: .apple, email: "seller@example.com"),
            hasLocalData: true
        )

        XCTAssertEqual(guest.localGroupStateID, "SET-03")
        XCTAssertEqual(member.localGroupStateID, "SET-03")

        guest.openLocalRemoval()
        member.openLocalRemoval()

        XCTAssertEqual(guest.stateID, "SET-05")
        XCTAssertEqual(member.stateID, "SET-06")
        XCTAssertEqual(guest.localRemovalUnchangedFacts.count, 3)
        XCTAssertEqual(member.localRemovalUnchangedFacts.count, 2)

        guest.completeLocalRemoval()
        member.completeLocalRemoval()
        XCTAssertEqual(guest.stateID, "SET-01")
        XCTAssertEqual(member.stateID, "SET-01")
        XCTAssertFalse(guest.hasLocalData)
        XCTAssertFalse(member.hasLocalData)
        XCTAssertEqual(guest.localGroupStateID, "SET-04")
        XCTAssertEqual(member.localGroupStateID, "SET-04")
    }

    func testLocalRemovalClearsEveryOwnedDeviceCacheBeforeReportingEmpty() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(
            "settings-local-removal-\(UUID().uuidString)",
            isDirectory: true
        )
        defer { try? FileManager.default.removeItem(at: root) }
        let listingReview = root
            .appendingPathComponent("SnapList", isDirectory: true)
            .appendingPathComponent("ListingReview", isDirectory: true)
        let captureDraft = root
            .appendingPathComponent("SnapList", isDirectory: true)
            .appendingPathComponent("CaptureDraft", isDirectory: true)
        try FileManager.default.createDirectory(
            at: listingReview,
            withIntermediateDirectories: true
        )
        try FileManager.default.createDirectory(
            at: captureDraft,
            withIntermediateDirectories: true
        )
        let snapshot = ListingReviewLaunchFixture.review()
        let persistence = LocalListingReviewDraftPersistence(
            rootDirectory: listingReview
        )
        let token = ListingReviewDraftPersistenceToken(
            sessionID: UUID(),
            generation: 0
        )
        let activated = await persistence.activate(
            token,
            runID: snapshot.binding.runID
        )
        XCTAssertTrue(activated)
        let saved = try await persistence.save(
            PersistedListingReviewDraft(
                snapshot: snapshot,
                draft: ListingReviewDraft(snapshot: snapshot),
                pendingSave: nil,
                expiresAt: Date().addingTimeInterval(3_600)
            ),
            runID: snapshot.binding.runID,
            token: token
        )
        XCTAssertTrue(saved)
        try Data("unsent capture".utf8).write(
            to: captureDraft.appendingPathComponent("manifest.json")
        )

        let cachedData = SettingsLocalCachedDataStore(
            applicationSupportDirectory: root
        )
        var intakeRemovalCalled = false
        XCTAssertTrue(cachedData.hasData)

        let removed = await SettingsLocalRemovalTransaction.perform(
            removeIntake: {
                intakeRemovalCalled = true
                return true
            },
            removeCachedItems: { cachedData.removeAll() }
        )

        XCTAssertTrue(removed)
        XCTAssertTrue(intakeRemovalCalled)
        XCTAssertFalse(cachedData.hasData)
        XCTAssertFalse(FileManager.default.fileExists(atPath: listingReview.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: captureDraft.path))
        let persisted = try await persistence.load(
            runID: snapshot.binding.runID,
            token: token
        )
        XCTAssertNil(persisted)
    }

    func testLocalRemovalStopsBeforeCachesWhenVersionFencedIntakeRejects() async {
        var cachedRemovalCalled = false

        let removed = await SettingsLocalRemovalTransaction.perform(
            removeIntake: { false },
            removeCachedItems: {
                cachedRemovalCalled = true
                return true
            }
        )

        XCTAssertFalse(removed)
        XCTAssertFalse(cachedRemovalCalled)
    }

    /// #844. Local copies go before the session does, and the order is the
    /// invariant rather than an implementation detail: `CaptureDraft/` and
    /// `ListingReview/` are flat directories with no principal in their paths,
    /// so a guest shell reached before they are gone reads the member's drafts.
    /// Ending the session first would make that window real whenever the
    /// removal then failed.
    func testSignOutRemovesThisDevicesCopiesBeforeItEndsTheSession() async {
        var order: [String] = []

        let outcome = await SettingsSignOutTransaction.perform(
            removeLocalData: {
                order.append("remove-local-data")
                return true
            },
            endSession: { order.append("end-session") }
        )

        XCTAssertEqual(outcome, .signedOut)
        XCTAssertEqual(order, ["remove-local-data", "end-session"])
    }

    /// #844. A removal that did not happen never becomes a sign-out. The seller
    /// keeps the session they still have, and their drafts stay where only they
    /// can reach them, rather than being handed to the guest shell.
    func testSignOutThatCannotClearThisDeviceLeavesTheSessionAlone() async {
        var endSessionCalled = false

        let outcome = await SettingsSignOutTransaction.perform(
            removeLocalData: { false },
            endSession: { endSessionCalled = true }
        )

        XCTAssertEqual(outcome, .localDataNotRemoved)
        XCTAssertFalse(endSessionCalled)
    }

    /// #844. Clerk holds the session in its own Keychain item, so a sign-out
    /// that threw leaves a live credential on the device. Reporting it as a
    /// sign-out would tell the seller the session is over while it is not —
    /// the same failure `AccountDeletionCoordinator` refuses to swallow.
    func testSignOutThatClerkRefusedIsNeverReportedAsAFinishedSignOut() async {
        struct SessionEndFailure: Error {}
        var removed = false

        let outcome = await SettingsSignOutTransaction.perform(
            removeLocalData: {
                removed = true
                return true
            },
            endSession: { throw SessionEndFailure() }
        )

        XCTAssertEqual(outcome, .sessionNotEnded)
        // The removal is not rolled back, and the copy the seller reads has to
        // say so: this device's copies are gone whether or not Clerk answered.
        XCTAssertTrue(removed)
    }

    /// #844, round-1 review finding. `.sessionNotEnded` means the local
    /// removal already committed — it is not rolled back, per the test above.
    /// Reusing `failed`'s "didn't finish" framing for that case tells the
    /// seller their unsent work is still there when it is already gone, so
    /// the two outcomes cannot share a string.
    func testSignOutFailureCopyReflectsWhatAlreadyHappened() {
        XCTAssertEqual(
            SettingsSignOutCopy.failureCopy(for: .localDataNotRemoved),
            SettingsSignOutCopy.failed,
            "nothing happened yet for this outcome, so the generic failure copy is honest"
        )

        let sessionNotEndedCopy = SettingsSignOutCopy.failureCopy(for: .sessionNotEnded)
        XCTAssertNotEqual(
            sessionNotEndedCopy,
            SettingsSignOutCopy.failed,
            "the removal already committed, so this outcome cannot reuse copy that implies nothing happened"
        )
        XCTAssertTrue(
            sessionNotEndedCopy?.localizedCaseInsensitiveContains("already") ?? false,
            "the copy must say the removal already happened, not merely that it will"
        )

        XCTAssertNil(SettingsSignOutCopy.failureCopy(for: .signedOut))
    }

    /// #844, round 2 review finding (P2, two independent reviewers). Round 1's
    /// `effects[0]` named only unsent photos and a voice note, and
    /// `unchanged[1]` promised signing back in "brings them back" — but
    /// `SettingsSignOutTransaction.ownedRoots` also deletes `ListingReview/`,
    /// this device's copy of an item mid-review, which by construction only
    /// exists after submission. `effects[0]` excluded it, so `unchanged[1]`'s
    /// blanket promise was false for it. The sibling local-removal screen
    /// (`SettingsLocalRemovalView`) already names the item copy in its own
    /// "what is removed" bullet; this pins sign-out's copy to the same fact
    /// about the same transaction.
    func testSignOutCopyNamesTheLocalItemCopyItActuallyDeletes() {
        XCTAssertTrue(
            SettingsSignOutCopy.effects[0].contains(
                "this iPhone's copy of anything it is holding for an item"
            ),
            "effects[0] must name the item copy the transaction deletes, not only photos and a voice note"
        )

        let survivorClaim = SettingsSignOutCopy.unchanged[1]
        XCTAssertTrue(
            survivorClaim.localizedCaseInsensitiveContains("stay on your account"),
            "the true half — server-held items come back — still has to be said"
        )
        XCTAssertTrue(
            survivorClaim.contains("does not"),
            "the local item copy this transaction deletes must not be promised back, so the bullet needs its carve-out"
        )

        XCTAssertTrue(
            SettingsSignOutCopy.sessionNotEnded.contains(
                "this iPhone's copy of anything it was holding for an item"
            ),
            "sessionNotEnded understates the same removal effects[0] now names"
        )
    }

    /// #844, acceptance criterion 3, proved against the real stores rather than
    /// inferred from the session being nil.
    ///
    /// `SettingsLocalCachedDataStore.ownedRoots` is `SnapList/CaptureDraft` and
    /// `SnapList/ListingReview` — two flat directories with no principal in
    /// their paths. The intake root is `SnapList/NativeIntake/v1-<sha256 of the
    /// Clerk subject>`, so a guest resolves a different directory and cannot
    /// reach a member's intake; these two have no such fence, so whatever
    /// survives sign-out is readable by the guest shell that sign-out lands in.
    /// The assertion is that a real listing draft, written by the shipped
    /// persistence, cannot be loaded back afterwards.
    ///
    /// The pre-checks are the positive control: they fail if the fixture never
    /// wrote anything, which would make the post-checks pass by vacuum.
    func testSignOutLeavesNoDraftOrListingOnTheDeviceForTheGuestShellToRead() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(
            "settings-sign-out-\(UUID().uuidString)",
            isDirectory: true
        )
        defer { try? FileManager.default.removeItem(at: root) }
        let listingReview = root
            .appendingPathComponent("SnapList", isDirectory: true)
            .appendingPathComponent("ListingReview", isDirectory: true)
        let captureDraft = root
            .appendingPathComponent("SnapList", isDirectory: true)
            .appendingPathComponent("CaptureDraft", isDirectory: true)
        try FileManager.default.createDirectory(
            at: listingReview,
            withIntermediateDirectories: true
        )
        try FileManager.default.createDirectory(
            at: captureDraft,
            withIntermediateDirectories: true
        )

        let snapshot = ListingReviewLaunchFixture.review()
        let persistence = LocalListingReviewDraftPersistence(
            rootDirectory: listingReview
        )
        let token = ListingReviewDraftPersistenceToken(
            sessionID: UUID(),
            generation: 0
        )
        let activated = await persistence.activate(
            token,
            runID: snapshot.binding.runID
        )
        XCTAssertTrue(activated)
        let saved = try await persistence.save(
            PersistedListingReviewDraft(
                snapshot: snapshot,
                draft: ListingReviewDraft(snapshot: snapshot),
                pendingSave: nil,
                expiresAt: Date().addingTimeInterval(3_600)
            ),
            runID: snapshot.binding.runID,
            token: token
        )
        XCTAssertTrue(saved)
        try Data("unsent capture".utf8).write(
            to: captureDraft.appendingPathComponent("manifest.json")
        )

        let cachedData = SettingsLocalCachedDataStore(
            applicationSupportDirectory: root
        )
        // Positive control: the member's work is genuinely on this device, and
        // genuinely readable, before anything signs out.
        XCTAssertTrue(cachedData.hasData)
        let readableBefore = try await persistence.load(
            runID: snapshot.binding.runID,
            token: token
        )
        XCTAssertNotNil(readableBefore)
        XCTAssertEqual(
            readableBefore?.snapshot.binding.runID,
            snapshot.binding.runID
        )

        var intakeDiscarded = false
        let outcome = await SettingsSignOutTransaction.perform(
            removeLocalData: {
                await SettingsLocalRemovalTransaction.perform(
                    removeIntake: {
                        intakeDiscarded = true
                        return true
                    },
                    removeCachedItems: { cachedData.removeAll() }
                )
            },
            endSession: {}
        )

        XCTAssertEqual(outcome, .signedOut)
        XCTAssertTrue(intakeDiscarded)
        XCTAssertFalse(cachedData.hasData)
        XCTAssertFalse(FileManager.default.fileExists(atPath: listingReview.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: captureDraft.path))
        let readableAfter = try await persistence.load(
            runID: snapshot.binding.runID,
            token: token
        )
        XCTAssertNil(readableAfter)
    }

    /// #871. Sign-out and account erasure share this one removal, and it is the
    /// executor for both of those retention triggers, so the Trophy Wall covers
    /// root has to be one of the roots it owns — for every principal that has
    /// filed a photo on this device, not only the one signing out.
    func testSignOutRemovesEveryPrincipalsTrophyWallCoverPhotos() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(
            "settings-covers-\(UUID().uuidString)",
            isDirectory: true
        )
        defer { try? FileManager.default.removeItem(at: root) }
        let covers = root
            .appendingPathComponent("SnapList", isDirectory: true)
            .appendingPathComponent(
                FileTrophyWallLocalCoverPhotoStore.rootDirectoryName,
                isDirectory: true
            )
        let principals = [
            "v1-" + String(repeating: "a", count: 64),
            "v1-" + String(repeating: "b", count: 64),
        ]
        for principal in principals {
            let principalRoot = covers.appendingPathComponent(
                principal,
                isDirectory: true
            )
            try FileManager.default.createDirectory(
                at: principalRoot,
                withIntermediateDirectories: true
            )
            try Data("staged photo".utf8).write(
                to: principalRoot.appendingPathComponent(
                    "run-\(UUID().uuidString.lowercased()).json"
                )
            )
        }

        let cachedData = SettingsLocalCachedDataStore(
            applicationSupportDirectory: root
        )
        // Positive control: the photos are genuinely on this device first.
        XCTAssertTrue(cachedData.hasData)

        let outcome = await SettingsSignOutTransaction.perform(
            removeLocalData: {
                await SettingsLocalRemovalTransaction.perform(
                    removeIntake: { true },
                    removeCachedItems: { cachedData.removeAll() }
                )
            },
            endSession: {}
        )

        XCTAssertEqual(outcome, .signedOut)
        XCTAssertFalse(FileManager.default.fileExists(atPath: covers.path))
        XCTAssertFalse(cachedData.hasData)
    }

    func testGuestSettingsStopsBeforeEntitlementsAndAccountManagement() {
        var flow = SettingsFlow(identity: .guest, hasLocalData: false)

        flow.openDeletion()

        XCTAssertEqual(flow.stateID, "SET-01")
        XCTAssertFalse(flow.isMember)
        XCTAssertEqual(
            SettingsGuestBoundaryCopy.body,
            "Create an account to manage your data and your subscription."
        )
    }

    func testDeletionRouteStopsAtTheApprovedFinalConfirm() {
        var flow = SettingsFlow(
            identity: .member(method: .apple, email: "seller@example.com"),
            hasLocalData: false
        )

        flow.openDeletion()
        XCTAssertEqual(flow.stateID, "DEL-01")
        flow.continueToReauthentication()
        XCTAssertEqual(flow.stateID, "DEL-02")

        flow.resolveReauthentication(.failed)
        XCTAssertEqual(flow.stateID, "DEL-02f")
        flow.resolveReauthentication(.cancelled)
        XCTAssertEqual(flow.stateID, "DEL-02")
        flow.cancelReauthentication()
        XCTAssertEqual(flow.stateID, "DEL-01")
        flow.continueToReauthentication()
        flow.resolveReauthentication(.succeeded)

        XCTAssertEqual(flow.stateID, "DEL-03")

        flow.keepAccount()
        XCTAssertEqual(flow.stateID, "SET-01")

        flow.openDeletion()
        flow.continueToReauthentication()
        flow.resolveReauthentication(.succeeded)
        flow.returnFromDeletionConfirmation()
        XCTAssertEqual(flow.stateID, "DEL-02")
    }

    func testSubscriptionPresentationKeepsEveryFrozenReadingDistinct() {
        let periodEnd = Date(timeIntervalSince1970: 1_786_406_400)
        let graceEnd = Date(timeIntervalSince1970: 1_784_937_600)
        let verified: [(VerifiedSubscriptionStatus, String, String, Bool, SettingsDeletionSubscriptionTruth)] = [
            (.included, "SUB-06", "Included", true, .included),
            (.active, "SUB-07", "Active", true, .billing),
            (.grace, "SUB-08", "Payment problem", true, .billing),
            (.billingRetry, "SUB-09", "Retrying payment", true, .billing),
            (.expired, "SUB-10", "Ended", false, .ended),
            (.revoked, "SUB-11", "Revoked", false, .ended),
            (.refunded, "SUB-12", "Refunded", false, .ended),
            (.ambiguous, "SUB-13", "Details not updated", true, .ambiguous),
            (.unconfigured, "SUB-01", "", false, .unknown)
        ]

        for (status, stateID, statusText, showsRemaining, deletionTruth) in verified {
            let serverValue = ServerVerifiedSubscription(
                source: status == .included ? .included : .storeKit,
                status: status,
                remainingItems: 12,
                periodStart: nil,
                periodEnd: periodEnd,
                gracePeriodEnd: graceEnd,
                transitionState: .reconciled,
                legacyStripeStatus: nil
            )
            let presentation = SettingsSubscriptionPresentation(
                state: .verified(serverValue)
            )

            XCTAssertEqual(
                SettingsDeletionSubscriptionTruth(state: .verified(serverValue)),
                deletionTruth
            )

            XCTAssertEqual(presentation.stateID, stateID)
            XCTAssertEqual(presentation.status, statusText)
            XCTAssertEqual(presentation.remainingItems != nil, showsRemaining)
        }

        XCTAssertEqual(
            SettingsSubscriptionPresentation(state: .loading).stateID,
            "SUB-02"
        )
        XCTAssertEqual(
            SettingsSubscriptionPresentation(state: .available([])).stateID,
            "SUB-03"
        )
        XCTAssertEqual(
            SettingsSubscriptionPresentation(state: .restoring).stateID,
            "SUB-04"
        )
        XCTAssertEqual(
            SettingsSubscriptionPresentation(
                state: .awaitingServerVerification(action: .purchase)
            ).stateID,
            "SUB-05"
        )
        XCTAssertEqual(
            SettingsSubscriptionPresentation(
                state: .awaitingServerVerification(action: .restore)
            ).stateID,
            "SUB-05"
        )
        XCTAssertEqual(
            SettingsSubscriptionPresentation(state: .failed("offline")).stateID,
            "SUB-15"
        )
    }

    func testSubscriptionFirstPaintAndConfigurationFailureAreHonest() {
        let unresolved = SettingsSubscriptionPresentation(
            state: .unconfigured,
            loadPhase: .loading
        )
        let failed = SettingsSubscriptionPresentation(
            state: .unconfigured,
            loadPhase: .failed
        )

        XCTAssertEqual(unresolved.stateID, "SUB-02")
        XCTAssertEqual(unresolved.status, "Checking")
        XCTAssertEqual(failed.stateID, "SUB-15")
        XCTAssertEqual(failed.actions, [.retry, .manage])
    }

    func testPurchaseOnlyTransientsNeverRenderAsNotSubscribedInSettings() {
        let purchasing = SettingsSubscriptionPresentation(
            state: .purchasing(productID: "snaplist.pro.monthly")
        )
        let pending = SettingsSubscriptionPresentation(
            state: .pending(productID: "snaplist.pro.monthly")
        )

        XCTAssertEqual(purchasing.stateID, "SUB-02")
        XCTAssertEqual(pending.stateID, "SUB-02")
        XCTAssertEqual(purchasing.status, "Checking")
        XCTAssertEqual(pending.status, "Checking")
        XCTAssertTrue(purchasing.facts.isEmpty)
        XCTAssertTrue(pending.facts.isEmpty)
    }

    func testDeletionCopyNeverClaimsAStoreKitTransientMeansNoSubscription() {
        XCTAssertEqual(
            SettingsDeletionSubscriptionTruth(
                state: .purchasing(productID: "snaplist.pro.monthly")
            ),
            .unknown
        )
        XCTAssertEqual(
            SettingsDeletionSubscriptionTruth(
                state: .pending(productID: "snaplist.pro.monthly")
            ),
            .unknown
        )
        XCTAssertEqual(
            SettingsDeletionSubscriptionTruth(
                state: .awaitingServerVerification(action: .purchase)
            ),
            .billing
        )
        XCTAssertEqual(
            SettingsDeletionSubscriptionTruth(state: .available([])),
            .none
        )
        XCTAssertEqual(
            SettingsDeletionSubscriptionTruth(
                state: .restoreNotFound,
                loadPhase: .failed
            ),
            .unknown
        )
    }

    /// #823. Two artifacts once disagreed on DEL-03's fact-line order; ADR-0014
    /// records identity-confirmation-first as authoritative. This pins the
    /// order on `SettingsDeletionConfirmationCopy.factLines`, the seam the view
    /// renders from, so a future reorder fails here instead of shipping silent.
    func testDeletionConfirmationFactLineOrderIsPinnedToIdentityFirst() {
        XCTAssertEqual(
            SettingsDeletionConfirmationCopy.factLines(subscriptionTruth: .billing),
            [
                "It’s you, confirmed a moment ago. Nothing is sent until you tap Delete account.",
                "Your eBay listings stay on eBay. End them in eBay if you want them gone.",
                "SnapList Pro keeps billing until you cancel it in the App Store. Deleting this account does not cancel it.",
            ]
        )
    }

    func testEntitlementRefreshPlanPreservesServerTruthAcrossLoadAndRestore() {
        XCTAssertEqual(
            SettingsEntitlementRefreshPlan.afterInitialLoad(.unconfigured),
            .stop
        )
        XCTAssertEqual(
            SettingsEntitlementRefreshPlan.afterInitialLoad(.available([])),
            .requestServerTruth
        )
        XCTAssertEqual(
            SettingsEntitlementRefreshPlan.afterInitialLoad(.failed("offline")),
            .stop
        )
        XCTAssertEqual(
            SettingsEntitlementRefreshPlan.afterRestore(.restoreNotFound),
            .requestServerTruth
        )
        XCTAssertEqual(
            SettingsEntitlementRefreshPlan.afterRestore(
                .awaitingServerVerification(action: .restore)
            ),
            .requestServerTruth
        )
        XCTAssertEqual(
            SettingsEntitlementRefreshPlan.afterRestore(.failed("offline")),
            .stop
        )
        XCTAssertEqual(
            SettingsEntitlementRefreshPlan
                .afterInitialLoad(.available([]))
                .deletionDisclosureLoadPhase,
            .loading
        )
        XCTAssertEqual(
            SettingsEntitlementRefreshPlan
                .afterInitialLoad(.unconfigured)
                .deletionDisclosureLoadPhase,
            .loaded
        )
    }

    @MainActor
    func testEntitlementServerRefreshKeepsDisclosureUnknownUntilApplyCompletes() async {
        var events: [String] = []

        await SettingsEntitlementServerRefresh.perform(
            fetch: {
                events.append("fetch")
                return "server truth"
            },
            apply: { events.append("apply:\($0)") },
            setLoadPhase: { events.append("phase:\($0)") }
        )

        XCTAssertEqual(
            events,
            ["phase:loading", "fetch", "apply:server truth", "phase:loaded"]
        )
    }

    @MainActor
    func testEntitlementServerRefreshKeepsDisclosureUnknownOnFailure() async {
        enum RefreshError: Error { case unavailable }
        var phases: [SettingsSubscriptionPresentation.LoadPhase] = []

        await SettingsEntitlementServerRefresh.perform(
            fetch: { throw RefreshError.unavailable },
            apply: { (_: String) in XCTFail("Failed refresh must not apply") },
            setLoadPhase: { phases.append($0) }
        )

        XCTAssertEqual(phases, [.loading, .failed])
    }

    func testSubscriptionGroupIsAbsentForGuestAndDeletionOutstanding() {
        XCTAssertFalse(
            SettingsSubscriptionVisibility(
                identity: .guest,
                deletionOutstanding: false
            ).isVisible
        )
        XCTAssertFalse(
            SettingsSubscriptionVisibility(
                identity: .member(method: .apple, email: "seller@example.com"),
                deletionOutstanding: true
            ).isVisible
        )
        XCTAssertTrue(
            SettingsSubscriptionVisibility(
                identity: .member(method: .apple, email: "seller@example.com"),
                deletionOutstanding: false
            ).isVisible
        )
    }

    func testSubscriptionAnnouncementUsesTheVisibleSellerReading() {
        let presentation = SettingsSubscriptionPresentation(state: .restoring)

        XCTAssertEqual(
            presentation.accessibilityAnnouncement,
            "SnapList Pro. Checking for a purchase."
        )
    }

    func testEmailCodePresentationUsesSixBoxesAsOneProgressReading() {
        let empty = SettingsEmailCodePresentation(code: "")
        let partial = SettingsEmailCodePresentation(code: "12a34")
        let complete = SettingsEmailCodePresentation(code: "1234567")

        XCTAssertEqual(empty.digits, [])
        XCTAssertEqual(empty.focusedBoxIndex, 0)
        XCTAssertEqual(empty.accessibilityValue, "0 of 6 digits entered")
        XCTAssertEqual(partial.digits, ["1", "2", "3", "4"])
        XCTAssertEqual(partial.focusedBoxIndex, 4)
        XCTAssertEqual(partial.accessibilityValue, "4 of 6 digits entered")
        XCTAssertEqual(complete.digits, ["1", "2", "3", "4", "5", "6"])
        XCTAssertEqual(complete.focusedBoxIndex, 5)
        XCTAssertEqual(complete.accessibilityValue, "6 of 6 digits entered")
    }

    func testAppleReauthenticationRequiresTheSameClerkAccount() {
        XCTAssertTrue(
            SettingsReauthenticationGate.isSameAccount(
                originalUserID: "user_385",
                verifiedUserID: "user_385"
            )
        )
        XCTAssertFalse(
            SettingsReauthenticationGate.isSameAccount(
                originalUserID: "user_385",
                verifiedUserID: "user_other"
            )
        )
        XCTAssertFalse(
            SettingsReauthenticationGate.isSameAccount(
                originalUserID: "user_385",
                verifiedUserID: nil
            )
        )
    }

    func testEmailReauthenticationSendsOnlyToTheDisplayedPrimaryAddress() async {
        var sentAddressID: String?

        let state = await SettingsEmailCodeChallenge.send(
            displayedPrimaryAddressID: "email_primary",
            supportedEmailAddressIDs: ["email_other", "email_primary"],
            sender: { sentAddressID = $0 }
        )

        XCTAssertEqual(state, .sent)
        XCTAssertEqual(sentAddressID, "email_primary")
        XCTAssertEqual(
            state.lead(email: "seller@example.com"),
            "Deleting an account is permanent, so SnapList sent a 6-digit code to seller@example.com. Enter it to confirm it is you."
        )
    }

    func testEmailReauthenticationDoesNotClaimDeliveryWithoutMatchingFactor() async {
        var senderCalled = false

        let state = await SettingsEmailCodeChallenge.send(
            displayedPrimaryAddressID: "email_primary",
            supportedEmailAddressIDs: ["email_other"],
            sender: { _ in senderCalled = true }
        )

        XCTAssertEqual(state, .failed)
        XCTAssertFalse(senderCalled)
        XCTAssertEqual(
            state.failureCopy(email: "seller@example.com"),
            "SnapList could not send a code to seller@example.com. Nothing has been deleted. You can try again."
        )
        XCTAssertFalse(
            state.lead(email: "seller@example.com").contains("SnapList sent")
        )
    }

    /// Left on `.automatic`, iOS paints its own filled capsule behind this row whenever
    /// a seller has Button Shapes on, on top of the affordance `settingsCardRow` already
    /// provides (#856).
    @MainActor
    func testCreateAccountRowCarriesAnExplicitNonAutomaticButtonStyle() {
        let row = SettingsCreateAccountRow(open: {})

        let rendered = String(reflecting: type(of: row.body))

        XCTAssertTrue(
            rendered.contains("PlainButtonStyle"),
            "settings.create-account resolves to .automatic, so Button Shapes doubles its capsule: \(rendered)"
        )
    }

    /// #856 follow-up, found while implementing #865: the original sweep
    /// enumerated `Button`s only, so the three `NavigationLink`-based
    /// Settings rows were still left on `.automatic`. Same technique as
    /// `testCreateAccountRowCarriesAnExplicitNonAutomaticButtonStyle`.
    @MainActor
    func testSignOutRowCarriesAnExplicitNonAutomaticButtonStyle() {
        let row = SettingsSignOutRow(signOut: { .signedOut })

        let rendered = String(reflecting: type(of: row.body))

        XCTAssertTrue(
            rendered.contains("PlainButtonStyle"),
            "settings.sign-out resolves to .automatic, so Button Shapes doubles its capsule: \(rendered)"
        )
    }

    @MainActor
    func testLocalRemovalRowCarriesAnExplicitNonAutomaticButtonStyle() {
        let row = SettingsLocalRemovalRow(isGuest: false, remove: { true })

        let rendered = String(reflecting: type(of: row.body))

        XCTAssertTrue(
            rendered.contains("PlainButtonStyle"),
            "settings.local-removal resolves to .automatic, so Button Shapes doubles its capsule: \(rendered)"
        )
    }

    @MainActor
    func testDeleteAccountRowCarriesAnExplicitNonAutomaticButtonStyle() {
        let row = SettingsDeleteAccountRow(
            profile: SettingsProfile(
                isGuest: false,
                name: "Jordan Hale",
                email: "jordan.hale@icloud.com",
                emailAddressID: "fixture-primary-email",
                initials: "JH",
                method: .apple
            ),
            subscriptionTruth: SettingsDeletionSubscriptionTruth(state: .available([])),
            deletionFlowPresentationChanged: { _ in }
        )

        let rendered = String(reflecting: type(of: row.body))

        XCTAssertTrue(
            rendered.contains("PlainButtonStyle"),
            "settings.delete-account resolves to .automatic, so Button Shapes doubles its capsule: \(rendered)"
        )
    }

    /// Aziz found rows that push to another screen looking identical to rows
    /// that merely display a value — nothing marked the three `NavigationLink`
    /// rows below as disclosure rows the way `LegalLinkRow` already is. Same
    /// reflection technique as `testLegalLinkRowWiresItsRowToAnOpenAction`:
    /// it proves the rendered label actually composes an `Image`, not just
    /// that one was typed into the source.
    @MainActor
    func testSignOutRowCarriesADisclosureChevron() {
        let row = SettingsSignOutRow(signOut: { .signedOut })

        let rendered = String(reflecting: type(of: row.body))

        XCTAssertTrue(
            rendered.contains("Image"),
            "settings.sign-out is missing its disclosure chevron: \(rendered)"
        )
    }

    @MainActor
    func testLocalRemovalRowCarriesADisclosureChevron() {
        let row = SettingsLocalRemovalRow(isGuest: false, remove: { true })

        let rendered = String(reflecting: type(of: row.body))

        XCTAssertTrue(
            rendered.contains("Image"),
            "settings.local-removal is missing its disclosure chevron: \(rendered)"
        )
    }

    @MainActor
    func testDeleteAccountRowCarriesADisclosureChevron() {
        let row = SettingsDeleteAccountRow(
            profile: SettingsProfile(
                isGuest: false,
                name: "Jordan Hale",
                email: "jordan.hale@icloud.com",
                emailAddressID: "fixture-primary-email",
                initials: "JH",
                method: .apple
            ),
            subscriptionTruth: SettingsDeletionSubscriptionTruth(state: .available([])),
            deletionFlowPresentationChanged: { _ in }
        )

        let rendered = String(reflecting: type(of: row.body))

        XCTAssertTrue(
            rendered.contains("Image"),
            "settings.delete-account is missing its disclosure chevron: \(rendered)"
        )
    }

    /// `SettingsCreateAccountRow` opens the account boundary modally rather
    /// than pushing it — a `NavigationLink` there would push it instead
    /// (#799) — so it deliberately stays without a chevron: the chevron
    /// promises a push, and this row does not perform one.
    @MainActor
    func testCreateAccountRowStaysWithoutADisclosureChevron() {
        let row = SettingsCreateAccountRow(open: {})

        let rendered = String(reflecting: type(of: row.body))

        XCTAssertFalse(
            rendered.contains("Image"),
            "settings.create-account opens modally, not by push, and should not promise one: \(rendered)"
        )
    }
}

private final class FailingSettingsAnalyticsClient: AnalyticsClient {
    enum Failure: Error { case expected }

    private(set) var requestedConsents: [AnalyticsConsent] = []

    func capture(_ event: AnalyticsEvent) {}
    func screen(_ screen: AnalyticsScreen) {}
    func identify(clerkUserID: String) {}
    func reset() {}
    func setConsent(_ consent: AnalyticsConsent) throws {
        requestedConsents.append(consent)
        throw Failure.expected
    }
    func flush() {}
}

// MARK: - Selling section eBay policy hint (#694)

extension SettingsTests {
    private func hint(
        state: String,
        message: String?,
        missing: [String] = [],
        helpURL: URL? = URL(string: "https://www.bizpolicy.ebay.com/businesspolicy/manage")
    ) -> EbayPolicySetupHint {
        EbayPolicySetupHint(
            state: state,
            marketplaceID: "EBAY_US",
            missing: missing,
            ambiguous: [],
            message: message,
            helpURL: helpURL
        )
    }

    func testSellingSectionShowsNoHintUntilTheConnectionIsKnown() {
        let loading = SettingsSellingPresentation(connection: nil, loadPhase: .loading)

        XCTAssertEqual(loading.marketplaceValue, "Checking")
        XCTAssertNil(loading.hint)
        XCTAssertFalse(loading.isConnected)

        let failed = SettingsSellingPresentation(connection: nil, loadPhase: .failed)

        XCTAssertEqual(failed.marketplaceValue, "Not available")
        XCTAssertNil(failed.hint)
        XCTAssertFalse(failed.isConnected)
    }

    func testSellingSectionShowsNoHintForASellerWhoIsNotConnected() {
        let presentation = SettingsSellingPresentation(
            connection: EbayConnectionStatus(
                connected: false,
                ebayUsername: nil,
                policySetup: nil
            ),
            loadPhase: .loaded
        )

        XCTAssertEqual(presentation.marketplaceValue, "Not connected")
        XCTAssertNil(presentation.hint)
        XCTAssertFalse(presentation.isConnected)
    }

    /// #865: `isConnected` is the seam `SettingsView` reads to decide whether
    /// "Connected marketplaces" becomes a real destination. Only a confirmed
    /// connection may offer one — every other case above stays `false`.
    func testSellingSectionIsConnectedOnlyOnceAConnectionIsConfirmed() {
        let presentation = SettingsSellingPresentation(
            connection: EbayConnectionStatus(
                connected: true,
                ebayUsername: "sandbox-seller",
                policySetup: nil
            ),
            loadPhase: .loaded
        )

        XCTAssertTrue(presentation.isConnected)
    }

    func testSellingSectionShowsNoHintForAConnectedSellerWhoIsReadyToPublish() {
        let presentation = SettingsSellingPresentation(
            connection: EbayConnectionStatus(
                connected: true,
                ebayUsername: "sandbox-seller",
                policySetup: hint(state: "ready", message: nil)
            ),
            loadPhase: .loaded
        )

        XCTAssertEqual(presentation.marketplaceValue, "eBay")
        XCTAssertNil(presentation.hint)
        XCTAssertTrue(presentation.isConnected)
    }

    /// A binding exists only once publish-time discovery has written one, so
    /// `notChecked` with no message is every seller between finishing eBay
    /// OAuth and their first publish. Showing them a warning triangle would
    /// report a problem SnapList has not found (issue #694).
    func testSellingSectionShowsNoHintForAConnectedSellerWhoHasNeverPublished() {
        let presentation = SettingsSellingPresentation(
            connection: EbayConnectionStatus(
                connected: true,
                ebayUsername: "sandbox-seller",
                policySetup: hint(state: "notChecked", message: nil)
            ),
            loadPhase: .loaded
        )

        XCTAssertEqual(presentation.marketplaceValue, "eBay")
        XCTAssertNil(presentation.hint)
    }

    func testSellingSectionNamesTheMissingFamilyBeforePublishIsAttempted() {
        let message = "Your eBay account has no payment policy. "
            + "Add it in eBay before you publish."
        let presentation = SettingsSellingPresentation(
            connection: EbayConnectionStatus(
                connected: true,
                ebayUsername: "sandbox-seller",
                policySetup: hint(
                    state: "setupRequired",
                    message: message,
                    missing: ["paymentPolicy"]
                )
            ),
            loadPhase: .loaded
        )

        XCTAssertEqual(presentation.marketplaceValue, "eBay")
        XCTAssertEqual(presentation.hint?.message, message)
        XCTAssertEqual(
            presentation.hint?.helpURL,
            URL(string: "https://www.bizpolicy.ebay.com/businesspolicy/manage")
        )
    }

    func testSellingSectionKeepsTheHintWhenTheServerOffersNoLink() {
        let message = "SnapList has not read your eBay shipping, payment, and "
            + "return policies yet. Check that your eBay account has one of "
            + "each before you publish."
        let presentation = SettingsSellingPresentation(
            connection: EbayConnectionStatus(
                connected: true,
                ebayUsername: "sandbox-seller",
                policySetup: hint(state: "notChecked", message: message, helpURL: nil)
            ),
            loadPhase: .loaded
        )

        XCTAssertEqual(presentation.hint?.message, message)
        XCTAssertNil(presentation.hint?.helpURL)
    }

    func testSellingSectionStaysSilentWhenTheServerSendsNoWordingToShow() {
        let presentation = SettingsSellingPresentation(
            connection: EbayConnectionStatus(
                connected: true,
                ebayUsername: "sandbox-seller",
                policySetup: hint(state: "setupRequired", message: nil)
            ),
            loadPhase: .loaded
        )

        XCTAssertEqual(presentation.marketplaceValue, "eBay")
        XCTAssertNil(presentation.hint)
    }

    func testSellingSectionStillWarnsOnAStateThisBuildDoesNotKnow() {
        let message = "Your eBay account needs attention before you publish."
        let presentation = SettingsSellingPresentation(
            connection: EbayConnectionStatus(
                connected: true,
                ebayUsername: "sandbox-seller",
                policySetup: hint(
                    state: "somethingNewerThanThisBuild",
                    message: message
                )
            ),
            loadPhase: .loaded
        )

        XCTAssertEqual(presentation.hint?.message, message)
    }

    /// The hint row combines its children so VoiceOver reads the warning and
    /// its link as one sentence. Combining also deletes the `Link` from the
    /// accessibility tree, so a VoiceOver seller can no longer activate it. The
    /// row re-exposes the same destination as an action on the combined
    /// element, which reaches VoiceOver through the actions rotor.
    ///
    /// XCUITest cannot observe this: the combined element has no children to
    /// find, and `XCUIElement.hasFocus` reads UIKit focus rather than VoiceOver
    /// focus. The seam is the rendered body type, which names the whole static
    /// subtree including the modifier that attaches the action. That type does
    /// not vary with the hint's data, so one fixture proves the composition;
    /// whether the action fires for a hint with no link is the modifier's own
    /// `if let`, not something this type can show.
    @MainActor
    func testPolicyHintOffersTheEbayLinkAsAnActionOnTheCombinedElement() {
        let row = SettingsSellingHintRow(
            hint: SettingsSellingPresentation.Hint(
                message: "Your eBay account has no payment policy.",
                helpURL: URL(
                    string: "https://www.bizpolicy.ebay.com/businesspolicy/manage"
                )
            )
        )

        let rendered = String(reflecting: type(of: row.body))

        XCTAssertTrue(
            rendered.contains("SettingsSellingHintPolicyAction"),
            "The combined hint element carries no policy action: \(rendered)"
        )
    }

    func testConnectionDecodesAServerAnswerThatCarriesNoPolicySetup() throws {
        let json = Data(#"{"connected":true,"ebayUsername":"sandbox-seller"}"#.utf8)

        let status = try JSONDecoder().decode(EbayConnectionStatus.self, from: json)

        XCTAssertTrue(status.connected)
        XCTAssertNil(status.policySetup)
    }

    func testConnectionDecodesTheStoredPolicyHint() throws {
        let json = Data(#"""
        {
          "connected": true,
          "ebayUsername": "sandbox-seller",
          "policySetup": {
            "state": "setupRequired",
            "marketplaceId": "EBAY_US",
            "missing": ["paymentPolicy", "returnPolicy"],
            "ambiguous": [],
            "message": "Your eBay account has no payment policy or return policy. Add them in eBay before you publish.",
            "helpUrl": "https://www.bizpolicy.ebay.com/businesspolicy/manage"
          }
        }
        """#.utf8)

        let status = try JSONDecoder().decode(EbayConnectionStatus.self, from: json)

        XCTAssertEqual(status.policySetup?.state, "setupRequired")
        XCTAssertEqual(status.policySetup?.missing, ["paymentPolicy", "returnPolicy"])
        XCTAssertEqual(status.policySetup?.marketplaceID, "EBAY_US")
        XCTAssertEqual(
            status.policySetup?.helpURL,
            URL(string: "https://www.bizpolicy.ebay.com/businesspolicy/manage")
        )
    }

    // MARK: - Legal links (issue #812)

    func testLegalDestinationsPointAtTheLiveMarketingSiteDocuments() {
        XCTAssertEqual(
            LegalDestination.privacyPolicy.url,
            URL(string: "https://snaplist.dev/privacy")
        )
        XCTAssertEqual(
            LegalDestination.termsOfService.url,
            URL(string: "https://snaplist.dev/terms")
        )
        XCTAssertEqual(
            LegalDestination.help.url,
            URL(string: "https://snaplist.dev/support")
        )
    }

    /// Same reflection technique as the eBay policy hint row above: it proves
    /// the row's rendered body actually carries a `Button`, not the bare
    /// `HStack` issue #812 found shipped inert with a chevron that promised
    /// navigation the row never performed.
    @MainActor
    func testLegalLinkRowWiresItsRowToAnOpenAction() {
        let row = LegalLinkRow(
            destination: .privacyPolicy,
            accessibilityIdentifier: "settings.about.privacy-policy"
        )

        let rendered = String(reflecting: type(of: row.body))

        XCTAssertTrue(
            rendered.contains("Button"),
            "The legal link row is not wrapped in a Button: \(rendered)"
        )
    }
}

// MARK: - Label/value row layout (#839)

extension SettingsTests {
    /// `Connected marketplaces` rendered as `Con-nected` at an accessibility
    /// size: the `HStack` split the row between the label and the value, and a
    /// word wider than its share was broken mid-word rather than wrapped.
    ///
    /// Asserted on the decision rather than the render because a drawn hyphen
    /// is invisible to XCUITest — an element's label is the source string
    /// whether or not the glyphs it produced were broken — so the observable
    /// difference is which layout the row chose. The rendered result is
    /// attached as an image by
    /// `SnapListUITests.testSettingsValueRowsKeepWholeWordsAtLargestAccessibilitySize`.
    ///
    /// Enumerated over every case rather than restating the implementation:
    /// the boundary between `xxxLarge` and `accessibility1` is the claim, and
    /// it survives a rewrite of the expression that produces it.
    func testValueRowsStackOnlyAtAccessibilitySizes() {
        let stacking: [DynamicTypeSize] = [
            .accessibility1, .accessibility2, .accessibility3,
            .accessibility4, .accessibility5,
        ]
        let inline: [DynamicTypeSize] = [
            .xSmall, .small, .medium, .large, .xLarge, .xxLarge, .xxxLarge,
        ]

        for size in stacking {
            XCTAssertTrue(SettingsValueRowLayout.stacks(at: size), "\(size)")
        }
        for size in inline {
            XCTAssertFalse(SettingsValueRowLayout.stacks(at: size), "\(size)")
        }
        XCTAssertEqual(
            stacking.count + inline.count,
            DynamicTypeSize.allCases.count,
            "every supported size has to be classified, not just the ones listed here"
        )
    }

    /// #844, acceptance criterion 5. Sign-out must not reach the erasure
    /// endpoint.
    ///
    /// Both halves run against the *shipped* dependency struct
    /// `AccountDeletionComposition.make` builds, over one `URLSession` that
    /// records every request. The positive control fires `requestErasure` —
    /// the closure sign-out must never touch — and shows the recorder catching
    /// a POST to `/v1/account/erasure`. Then the two closures sign-out is
    /// composed of run against the same recorder and it stays empty. Without
    /// the control, an empty recorder would prove only that the stub was never
    /// installed.
    @MainActor
    func testSignOutNeverReachesTheAccountErasureEndpoint() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SettingsSignOutURLProtocolRecorder.self]
        SettingsSignOutURLProtocolRecorder.reset()
        defer { SettingsSignOutURLProtocolRecorder.reset() }

        let intakeRemoved = SettingsSignOutTestFlag()
        let cachedItemsRemoved = SettingsSignOutTestFlag()
        let dependencies = AccountDeletionComposition.make(
            apiOrigin: URL(string: "https://snaplist.dev")!,
            session: URLSession(configuration: configuration),
            signedInUserID: "user_2signed_in_member",
            mintBearerToken: { _ in "reverified-token" },
            endSession: {},
            keyStoreDefaults: try XCTUnwrap(
                UserDefaults(suiteName: "SettingsTests-sign-out-\(UUID().uuidString)")
            ),
            removeIntake: { intakeRemoved.raise(); return true },
            removeCachedItems: { cachedItemsRemoved.raise(); return true }
        )

        // Positive control. This is the deletion path, not the sign-out path.
        _ = await dependencies.requestErasure(
            "84400000-0000-4000-8000-000000000001"
        )
        XCTAssertEqual(
            SettingsSignOutURLProtocolRecorder.requestedPaths,
            ["/v1/account/erasure"],
            "the recorder has to be able to see an erasure before its silence means anything"
        )

        SettingsSignOutURLProtocolRecorder.reset()

        let outcome = await SettingsSignOutTransaction.perform(
            removeLocalData: { await dependencies.clearDeviceState() },
            endSession: {
                guard await dependencies.signOut() else {
                    throw SettingsSignOutTestSessionEndFailure()
                }
            }
        )

        XCTAssertEqual(outcome, .signedOut)
        XCTAssertTrue(intakeRemoved.isRaised)
        XCTAssertTrue(cachedItemsRemoved.isRaised)
        XCTAssertEqual(SettingsSignOutURLProtocolRecorder.requestedPaths, [])
    }
}

private struct SettingsSignOutTestSessionEndFailure: Error {}

/// A one-way flag a `@Sendable` closure can set, since a local `var` cannot be
/// captured by one.
private final class SettingsSignOutTestFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var raised = false

    var isRaised: Bool { lock.withLock { raised } }

    func raise() { lock.withLock { raised = true } }
}

/// Records every request that reaches the session it is installed on and
/// answers nothing, so a path that calls out is visible whether or not it cares
/// about the reply.
private final class SettingsSignOutURLProtocolRecorder: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) private static let lock = NSLock()
    nonisolated(unsafe) private static var paths: [String] = []

    static var requestedPaths: [String] {
        lock.withLock { paths }
    }

    static func reset() {
        lock.withLock { paths = [] }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        if let path = request.url?.path {
            Self.lock.withLock { Self.paths.append(path) }
        }
        client?.urlProtocol(
            self,
            didFailWithError: URLError(.notConnectedToInternet)
        )
    }

    override func stopLoading() {}
}

/// Issue #891. What the Notifications row is allowed to claim and to do.
///
/// The row it replaces drew a hardcoded `On` for every seller, including one
/// who had refused, and it did nothing when tapped. Both halves of that are the
/// same defect: the row was decoration over a permission the app does not own.
///
/// iOS owns the answer, and the app can only ever do two things about it. It
/// can show the system prompt exactly once, while the status is still
/// undetermined, and after that it can send the seller to system Settings. It
/// cannot grant, and it cannot revoke. A switch that appeared to do either
/// would be the same lie in a more convincing shape.
final class SettingsNotificationsRowTests: XCTestCase {
    func testAnUnaskedSellerSeesTheSwitchOffAndTurningItOnShowsThePrompt() {
        let permission = SettingsNotificationsPermission.notAsked

        XCTAssertFalse(permission.isOn)
        XCTAssertEqual(permission.intent(forRequestedState: true), .ask)
    }

    func testAnAllowedSellerSeesTheSwitchOn() {
        XCTAssertTrue(SettingsNotificationsPermission.allowed.isOn)
    }

    func testTurningItOffSendsTheSellerToSystemSettings() {
        // There is no API for an app to withdraw its own notification
        // permission. A switch that moved and changed nothing would be worse
        // than one that does not move.
        XCTAssertEqual(
            SettingsNotificationsPermission.allowed
                .intent(forRequestedState: false),
            .openSystemSettings
        )
    }

    func testARefusedSellerIsSentToSystemSettingsRatherThanPromptedAgain() {
        // iOS will not show the prompt a second time, so asking again would
        // produce an immediate refusal and a switch that snapped back with no
        // explanation. #890 settles that the app never re-asks; this is the way
        // back it left open.
        let permission = SettingsNotificationsPermission.refused

        XCTAssertFalse(permission.isOn)
        XCTAssertEqual(
            permission.intent(forRequestedState: true),
            .openSystemSettings
        )
    }

    func testAskingForTheStateTheSellerIsAlreadyInDoesNothing() {
        XCTAssertEqual(
            SettingsNotificationsPermission.allowed.intent(forRequestedState: true),
            .doNothing
        )
        XCTAssertEqual(
            SettingsNotificationsPermission.refused.intent(forRequestedState: false),
            .doNothing
        )
        XCTAssertEqual(
            SettingsNotificationsPermission.notAsked.intent(forRequestedState: false),
            .doNothing
        )
    }

    func testTheRowReadsTheSystemStatusRatherThanWhatTheAppRemembers() {
        let expected: [(UNAuthorizationStatus, SettingsNotificationsPermission)] = [
            (.notDetermined, .notAsked),
            (.denied, .refused),
            (.authorized, .allowed),
            // Quiet delivery is still delivery. The seller granted it, and the
            // only thing the app could offer them here is the same trip to
            // system Settings the allowed state already offers.
            (.provisional, .allowed),
            (.ephemeral, .allowed),
        ]

        for (status, permission) in expected {
            XCTAssertEqual(
                SettingsNotificationsPermission(authorizationStatus: status),
                permission,
                "status \(status.rawValue)"
            )
        }
    }
}
