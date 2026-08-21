import Foundation
import XCTest
@testable import SnapList

/// Issue #385. The seam under test is the account deletion coordinator: the
/// only thing that may decide a deletion finished, and the only thing that may
/// order device clearing and sign-out behind that decision.
///
/// Every assertion here is an outcome, never a screen. The shipped path already
/// renders every screen in this family and deletes nothing, so a test that
/// asserted a screen appeared would have passed against the defect.
final class AccountDeletionTests: XCTestCase {
    func testServerFailureClearsNothingSignsOutOfNothingAndKeepsRetry() async {
        let recorder = AccountDeletionRecorder()
        let coordinator = await AccountDeletionCoordinator(
            dependencies: recorder.dependencies(
                outcomes: [.notConfirmed(.serverUnavailable)]
            )
        )

        await coordinator.deleteAccount()

        let phase = await coordinator.phase
        XCTAssertEqual(phase, .failed)
        XCTAssertTrue(phase.offersRetry)
        XCTAssertFalse(phase.reportsDeletion)
        XCTAssertEqual(recorder.events, [.requestedErasure])
    }

    func testDeletionIsReportedOnlyAfterTheDeviceWasActuallyCleared() async {
        let recorder = AccountDeletionRecorder()
        let coordinator = await AccountDeletionCoordinator(
            dependencies: recorder.dependencies(
                outcomes: [.completed(retainedRecords: [.ebayLiveListing])]
            )
        )

        await coordinator.deleteAccount()

        // The order is the acceptance criterion. Signing out first would strand
        // a seller whose account the server did delete; clearing first would
        // strand one whose account it did not.
        XCTAssertEqual(
            recorder.events,
            [.requestedErasure, .clearedDeviceState, .signedOut]
        )
        let phase = await coordinator.phase
        XCTAssertEqual(phase, .deleted(retainedRecords: [.ebayLiveListing]))
    }

    func testADeviceThatWillNotClearIsNotSignedOutAndIsNotCalledFinished() async {
        let recorder = AccountDeletionRecorder()
        let coordinator = await AccountDeletionCoordinator(
            dependencies: recorder.dependencies(
                outcomes: [.completed(retainedRecords: [])],
                deviceClearingSucceeds: false
            )
        )

        await coordinator.deleteAccount()

        // Signing out here would take away the only credential that can reach
        // the retry, leaving SnapList data on a device with no route to remove
        // it. The server truth is not restated as a finished deletion either,
        // because this iPhone is still holding SnapList's copies.
        XCTAssertEqual(recorder.events, [.requestedErasure, .clearedDeviceState])
        let phase = await coordinator.phase
        XCTAssertEqual(phase, .deviceNotCleared)
        XCTAssertFalse(phase.reportsDeletion)
        XCTAssertTrue(phase.offersRetry)
    }

    func testAStatusThatNeedsAPersonIsNeverReadAsADeletion() async {
        let recorder = AccountDeletionRecorder()
        let coordinator = await AccountDeletionCoordinator(
            dependencies: recorder.dependencies(outcomes: [.needsAttention])
        )

        await coordinator.deleteAccount()

        // `deletion_needs_attention` rides the same 202 as `deletion_in_progress`
        // (src/lib/account-erasure/http.ts:80), so anything keyed on the HTTP
        // status alone would call this a success.
        XCTAssertEqual(recorder.events, [.requestedErasure])
        let phase = await coordinator.phase
        XCTAssertFalse(phase.reportsDeletion)
        XCTAssertEqual(phase, .stalled(.needsAttention))
        // Not a deletion, and not a dead end either. This status is absent from
        // the handler's `TERMINAL_STATUSES` (src/lib/account-erasure/service.ts,
        // the two `deletion_completed` members), so a request carrying the same
        // key re-walks storage and re-runs the identity delete instead of
        // replaying the stored answer. Taking the control away would strand a
        // seller whose data is gone and whose sign-in survived.
        XCTAssertTrue(phase.offersRetry)
    }

    func testAKeyTheServerBoundElsewhereIsNotOfferedAsSomethingToRetry() async {
        let recorder = AccountDeletionRecorder()
        let coordinator = await AccountDeletionCoordinator(
            dependencies: recorder.dependencies(
                outcomes: [.notConfirmed(.idempotencyKeyConflict)]
            )
        )

        await coordinator.deleteAccount()

        // 409 means this account's erasure is bound to a different key
        // (supabase/migrations/20260801120000_durable_account_erasure.sql, the
        // 23505 raise). Re-sending the key that was just rejected cannot become
        // the key the server already has.
        let phase = await coordinator.phase
        XCTAssertEqual(phase, .stalled(.keyConflict))
        XCTAssertFalse(phase.offersRetry)
        XCTAssertFalse(phase.reportsDeletion)
        XCTAssertEqual(recorder.events, [.requestedErasure])
    }

    func testAnExpiredIdentityConfirmationIsNotTreatedAsSomethingToRetry() async {
        let recorder = AccountDeletionRecorder()
        let coordinator = await AccountDeletionCoordinator(
            dependencies: recorder.dependencies(
                outcomes: [.notConfirmed(.reverificationRequired)]
            )
        )

        await coordinator.deleteAccount()

        // The handler gates on the session's factor verification age. A retry
        // mints a fresh token carrying the same stale claim and earns the same
        // 403, so the seller would sit in a loop the design exists to prevent.
        let phase = await coordinator.phase
        XCTAssertEqual(phase, .reverificationExpired)
        XCTAssertFalse(phase.offersRetry)
        XCTAssertFalse(phase.reportsDeletion)
    }

    func testABuildWithNoRouteToTheServerSaysSoInsteadOfBlamingTheServer() async {
        let recorder = AccountDeletionRecorder()
        let coordinator = await AccountDeletionCoordinator(
            dependencies: recorder.dependencies(
                outcomes: [.notConfirmed(.clientNotConfigured)]
            )
        )

        await coordinator.deleteAccount()

        // An unwired build reporting the same state as a real server refusal is
        // how #385 shipped the first time: the screens rendered, nothing was
        // deleted, and nothing said so.
        let phase = await coordinator.phase
        XCTAssertEqual(phase, .stalled(.appNotConfigured))
        XCTAssertNotEqual(phase, .failed)
        XCTAssertFalse(phase.reportsDeletion)
    }

    func testASignOutThatDidNotHappenIsNeverReportedAsAFinishedDeletion() async {
        let recorder = AccountDeletionRecorder()
        let coordinator = await AccountDeletionCoordinator(
            dependencies: recorder.dependencies(
                outcomes: [.completed(retainedRecords: [])],
                signOutSucceeds: false
            )
        )

        await coordinator.deleteAccount()

        // Clerk stores the session in its own Keychain item that nothing else
        // in the clearing list removes, so a swallowed sign-out failure leaves
        // a live credential on a device whose account is gone.
        let phase = await coordinator.phase
        XCTAssertEqual(phase, .deviceNotCleared)
        XCTAssertFalse(phase.reportsDeletion)
        XCTAssertTrue(phase.offersRetry)
    }

    func testAnUnfinishedDeletionIsFollowedWithOneKeyAndStopsWithoutClaiming()
        async {
        let recorder = AccountDeletionRecorder()
        let coordinator = await AccountDeletionCoordinator(
            dependencies: recorder.dependencies(
                outcomes: [.pending, .pending, .pending, .pending],
                maximumStatusFollowUps: 2
            )
        )

        await coordinator.deleteAccount()

        // One key for the whole attempt: `begin_account_erasure` resolves a
        // repeat key to the same generation, and a fresh key would open a second
        // deletion or earn the 409 the handler raises for a rebound key.
        XCTAssertEqual(recorder.idempotencyKeys, ["key-1", "key-1", "key-1"])
        let phase = await coordinator.phase
        XCTAssertEqual(phase, .unfinished)
        XCTAssertFalse(phase.reportsDeletion)
        XCTAssertTrue(phase.offersRetry)
    }

    func testFollowingAnAcceptedRequestReachesTheDeletionTheServerReports()
        async {
        let recorder = AccountDeletionRecorder()
        let coordinator = await AccountDeletionCoordinator(
            dependencies: recorder.dependencies(
                outcomes: [.pending, .completed(retainedRecords: [])],
                maximumStatusFollowUps: 2
            )
        )

        await coordinator.deleteAccount()

        XCTAssertEqual(
            recorder.events,
            [.requestedErasure, .requestedErasure, .clearedDeviceState, .signedOut]
        )
        let phase = await coordinator.phase
        XCTAssertEqual(phase, .deleted(retainedRecords: []))
    }

    func testRetryAsksAgainWithTheKeyTheFirstRequestAlreadyUsed() async {
        let recorder = AccountDeletionRecorder()
        let coordinator = await AccountDeletionCoordinator(
            dependencies: recorder.dependencies(
                outcomes: [
                    .notConfirmed(.serverUnavailable),
                    .completed(retainedRecords: []),
                ]
            )
        )

        await coordinator.deleteAccount()
        await coordinator.retry()

        XCTAssertEqual(recorder.idempotencyKeys, ["key-1", "key-1"])
        let phase = await coordinator.phase
        XCTAssertEqual(phase, .deleted(retainedRecords: []))
    }

    func testASecondAttemptAsksAboutTheDeletionTheFirstOneAlreadyStarted() async {
        let recorder = AccountDeletionRecorder()

        // The seller taps Delete, the server does not confirm, and they leave.
        // The host is a `navigationDestination` destination, so the coordinator
        // and everything held in it goes away with the screen.
        let abandoned = await AccountDeletionCoordinator(
            dependencies: recorder.dependencies(
                outcomes: [.notConfirmed(.serverUnavailable)]
            )
        )
        await abandoned.deleteAccount()

        // They come back through DEL-01, DEL-02, DEL-03 and tap Delete again.
        // This is a different coordinator with none of the first one's state.
        let resumed = await AccountDeletionCoordinator(
            dependencies: recorder.dependencies(
                outcomes: [.completed(retainedRecords: [])]
            )
        )
        await resumed.deleteAccount()

        // A fresh key here is a 409 from `begin_account_erasure`, and every
        // later attempt earns the same one: the account becomes impossible to
        // delete from the app, which is the 5.1.1(v) blocker this issue closes.
        XCTAssertEqual(recorder.idempotencyKeys, ["key-1", "key-1"])
        let phase = await resumed.phase
        XCTAssertEqual(phase, .deleted(retainedRecords: []))
    }

    func testTheKeyIsForgottenOnlyOnceTheDeletionIsCompletelyFinished() async {
        let recorder = AccountDeletionRecorder()
        let coordinator = await AccountDeletionCoordinator(
            dependencies: recorder.dependencies(
                outcomes: [.completed(retainedRecords: [])],
                deviceClearingSucceeds: false
            )
        )

        await coordinator.deleteAccount()
        // The device still holds copies, so the key still has work to do: a
        // later instance needs it to be told the deletion is already terminal.
        XCTAssertEqual(recorder.persistedIdempotencyKey, "key-1")

        recorder.allowDeviceClearing()
        await coordinator.retry()

        XCTAssertNil(recorder.persistedIdempotencyKey)
    }

    func testFollowUpsWaitInsteadOfRepostingTheEraseBackToBack() async {
        let recorder = AccountDeletionRecorder()
        let coordinator = await AccountDeletionCoordinator(
            dependencies: recorder.dependencies(
                outcomes: [.pending, .pending, .completed(retainedRecords: [])],
                maximumStatusFollowUps: 3
            )
        )

        await coordinator.deleteAccount()

        // Every POST re-runs the server's whole erase pipeline, provider calls
        // included. Three immediate ones buy nothing the first did not.
        XCTAssertEqual(recorder.waitsBeforeFollowUp, [1, 2])
    }

    func testRetryingADeviceThatWouldNotClearDoesNotOpenASecondErasure() async {
        let recorder = AccountDeletionRecorder()
        let coordinator = await AccountDeletionCoordinator(
            dependencies: recorder.dependencies(
                outcomes: [.completed(retainedRecords: [])],
                deviceClearingSucceeds: false
            )
        )

        await coordinator.deleteAccount()
        recorder.allowDeviceClearing()
        await coordinator.retry()

        // The server already reported the deletion. Asking it again would spend
        // a request to be told the same thing, and the account it authenticated
        // with may no longer exist.
        XCTAssertEqual(
            recorder.events,
            [
                .requestedErasure,
                .clearedDeviceState,
                .clearedDeviceState,
                .signedOut,
            ]
        )
        let phase = await coordinator.phase
        XCTAssertEqual(phase, .deleted(retainedRecords: []))
    }
}

/// Issue #385. What "local state gone" has to actually mean on the device.
final class AccountDeletionDeviceStateTests: XCTestCase {
    func testOneStoreThatWillNotGiveUpItsCopiesDoesNotSpareTheRest() async {
        var attempted: [String] = []
        let steps: [AccountDeletionDeviceState.Step] = [
            .init(name: "intake", remove: { attempted.append("intake"); return true }),
            .init(name: "cache", remove: { attempted.append("cache"); return false }),
            .init(name: "keychain", remove: { attempted.append("keychain"); return true }),
        ]

        let cleared = await AccountDeletionDeviceState.clear(steps: steps)

        // Stopping at the first failure would leave SnapList credentials on a
        // device whose account is already gone, and the seller would have no
        // signed-in route left to try again.
        XCTAssertFalse(cleared)
        XCTAssertEqual(attempted, ["intake", "cache", "keychain"])
    }

    func testIntakeAndCachedItemsAreSeparateStepsSoOneFailureSparesNothing() async {
        var attempted: [String] = []
        let steps = AccountDeletionDeviceState.steps(
            removeIntake: { attempted.append("intake"); return false },
            removeCachedItems: { attempted.append("cached-items"); return true },
            removeIncludedOfferRedemption: {
                attempted.append("included-offer-redemption")
                return true
            }
        )

        let cleared = await AccountDeletionDeviceState.clear(steps: steps)

        // Composing these two through `SettingsLocalRemovalTransaction` would
        // short-circuit here, and the seller's cached items would survive a
        // deletion because intake removal happened to fail first.
        XCTAssertEqual(
            attempted,
            ["intake", "cached-items", "included-offer-redemption"]
        )
        XCTAssertFalse(cleared)
        // The Keychain half still follows the app's own stores, in that order.
        // #854 item 3: the included-offer redemption record is one of those
        // stores. It is keyed by the Clerk subject and the Keychain half never
        // touched it, so before this a deleted subject's id stayed on the
        // device after erasure reported the device clean.
        XCTAssertEqual(
            steps.map(\.name),
            ["intake", "cached-items", "included-offer-redemption"]
                + AccountDeletionDeviceState.keychainSteps.map(\.name)
        )
    }

    /// #819 item 4. Renamed from `testAStepReadsWhatItRemovesWhenItRuns`, which
    /// named a defect it does not cover.
    ///
    /// What this pins is `steps(removeIntake:removeCachedItems:)` storing the
    /// removal itself rather than its result: the closure runs when `clear`
    /// runs, so it observes whatever the seller left behind at that moment.
    ///
    /// What it does not pin is the call site. The defect the old name described
    /// lives at `AppShellView.swift:746`, where the intake version is read
    /// inside the closure rather than captured when the property is evaluated.
    /// Reverting that line to a render-time capture leaves this test, the whole
    /// unit suite and `AccountDeletionUITests` green, because the UI tests run
    /// `AccountDeletionComposition.fixture`, which never calls `removeIntake`
    /// at all. Pinning it needs the shell's dependency assembly to be reachable
    /// from a test, which is more than a rename.
    ///
    /// Be clear about what is left, too: the assertion below cannot be made to
    /// fail by any edit to `steps`. It is a synchronous factory over
    /// `@escaping () async -> Bool`, so it cannot await, so it has no way to
    /// hold a result rather than the removal. The signature guarantees that,
    /// not this test. Read this as documentation of a type-enforced property,
    /// not as protection for it.
    func testAStepHoldsTheRemovalItselfRatherThanAResultFromConstructionTime()
        async {
        var intakeVersion = 1
        let steps = AccountDeletionDeviceState.steps(
            removeIntake: { intakeVersion == 2 },
            removeCachedItems: { true },
            removeIncludedOfferRedemption: { true }
        )
        // Whatever the seller did between opening the screen and confirming.
        intakeVersion = 2

        let cleared = await AccountDeletionDeviceState.clear(steps: [steps[0]])

        // A step that captured its subject at construction would still be
        // holding version 1 and would discard against a version the app no
        // longer has, which fails and leaves the draft on the device.
        XCTAssertTrue(cleared)
    }

    /// #819 item 4. Replaces `testDeletionKnowsEveryKeychainItemTheAppWrites`,
    /// which compared the constant against a literal copy of itself: it went
    /// red when someone edited the list and stayed green when someone added a
    /// Keychain writer somewhere else, the exact inverse of the drift its name
    /// claimed to catch.
    ///
    /// This one reads the app target instead. Adding a generic-password writer
    /// without adding its item here leaves a credential on a device whose
    /// account is gone, which is what Guideline 5.1.1(v) is about.
    ///
    /// A source scan that matches nothing and then agrees with itself is the
    /// same false green in a new costume, so every stage runs its own positive
    /// control before anything is concluded from a count.
    func testEveryKeychainItemTheAppWritesIsOneTheDeletionRemoves() throws {
        let appTarget = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("SnapList")

        // Control 1: the walk reaches the app target's Swift at all. A walk
        // that returned nothing would agree with an empty everything below.
        let swiftSources = try Self.swiftSources(under: appTarget)
        XCTAssertTrue(
            swiftSources.contains { $0.path.hasSuffix("/AppAttest/AppAttestClient.swift") },
            "The source walk missed a file known to be in the app target; it found \(swiftSources.count) Swift files under \(appTarget.path)."
        )

        // Control 2: the needle matches a file known to write one of these.
        let writers = try swiftSources.filter {
            try String(contentsOf: $0, encoding: .utf8)
                .contains("kSecClassGenericPassword")
        }
        XCTAssertTrue(
            writers.contains { $0.path.hasSuffix("/AppAttest/AppAttestClient.swift") },
            "The kSecClassGenericPassword scan matched \(writers.count) files and none of them was AppAttestClient.swift, which writes two."
        )

        // Control 3: the literal pattern extracts a pair from a sample this
        // test owns, so a pattern that stopped matching production spellings
        // cannot pass itself off as production having none.
        let sample = Self.declaredKeychainLiterals(in: """
        private let service = "dev.snaplist.example"
        private let account: String = "example-v1"
        """)
        XCTAssertEqual(sample.services, ["dev.snaplist.example"])
        XCTAssertEqual(sample.accounts, ["example-v1"])

        var services: Set<String> = []
        var accounts: Set<String> = []
        for writer in writers {
            let declared = Self.declaredKeychainLiterals(
                in: try String(contentsOf: writer, encoding: .utf8)
            )
            services.formUnion(declared.services)
            accounts.formUnion(declared.accounts)
        }

        // `AccountDeletion.swift` writes nothing of its own: it declares
        // `service` and `account` as stored properties with no literal, so the
        // list under test never scans itself back into agreement.
        let listed = AccountDeletionKeychainItem.everythingSnapListStores
        XCTAssertEqual(
            services, Set(listed.map(\.service)),
            "A generic-password service the app writes is missing from AccountDeletionKeychainItem.everythingSnapListStores (or listed there and no longer written). Scanned: \(writers.map(\.lastPathComponent).sorted())"
        )
        XCTAssertEqual(
            accounts, Set(listed.map(\.account)),
            "A generic-password account the app writes is missing from AccountDeletionKeychainItem.everythingSnapListStores (or listed there and no longer written). Scanned: \(writers.map(\.lastPathComponent).sorted())"
        )
    }

    private static func swiftSources(under root: URL) throws -> [URL] {
        guard let walk = FileManager.default.enumerator(
            at: root,
            includingPropertiesForKeys: nil
        ) else {
            throw CocoaError(.fileReadNoSuchFile)
        }
        return walk.compactMap { $0 as? URL }
            .filter { $0.pathExtension == "swift" }
    }

    /// Every `service` and `account` a file declares with a string literal.
    ///
    /// A declaration, never a use: `let service: String` with no literal is a
    /// stored property of the deletion list itself, and matching that would
    /// make the scan circular.
    private static func declaredKeychainLiterals(
        in source: String
    ) -> (services: Set<String>, accounts: Set<String>) {
        // Assumes the `let service = "literal"` spelling, which is what all
        // four current writers use. A writer that built its service from an
        // interpolation or a constant would read as zero declarations here.
        let pattern = #"let\s+(service|account)\s*(?::\s*String\s*)?=\s*"([^"]+)""#
        let expression = try! NSRegularExpression(pattern: pattern)
        var services: Set<String> = []
        var accounts: Set<String> = []
        let text = source as NSString
        for match in expression.matches(
            in: source,
            range: NSRange(location: 0, length: text.length)
        ) {
            let name = text.substring(with: match.range(at: 1))
            let literal = text.substring(with: match.range(at: 2))
            if name == "service" { services.insert(literal) } else {
                accounts.insert(literal)
            }
        }
        return (services, accounts)
    }
}

/// Issue #385. The key that makes an interrupted deletion resumable rather than
/// a permanent 409, and who it belongs to.
final class AccountErasureKeyStoreTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "dev.snaplist.tests.account-erasure-key.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        suiteName = nil
        super.tearDown()
    }

    func testOneSellersKeyIsNeverHandedToTheNextSellerOnTheSameDevice() {
        let first = AccountErasureKeyStore(userID: "user_a", defaults: defaults)
        let second = AccountErasureKeyStore(userID: "user_b", defaults: defaults)

        first.remember("key-a")

        // `begin_account_erasure` binds one key per account and raises 23505 for
        // a second one, which the handler returns as 409. A device-wide key
        // would hand user A's key to user B, whose own erasure would then be
        // refused with no way to mint the key the server actually wants.
        XCTAssertNil(second.load())
        XCTAssertEqual(first.load(), "key-a")

        second.remember("key-b")
        XCTAssertEqual(first.load(), "key-a")
        XCTAssertEqual(second.load(), "key-b")

        second.forget()
        // Forgetting one account's key is not permission to lose another's.
        XCTAssertNil(second.load())
        XCTAssertEqual(first.load(), "key-a")
    }

    func testAKeyOutlivesTheStoreThatWroteIt() {
        AccountErasureKeyStore(userID: "user_a", defaults: defaults)
            .remember("key-a")

        // The store is a value built fresh by every host. A seller who taps
        // "Not now" and comes back gets a new one, and it has to find the key
        // the earlier attempt left behind.
        XCTAssertEqual(
            AccountErasureKeyStore(userID: "user_a", defaults: defaults).load(),
            "key-a"
        )
    }
}

/// Issue #385. The bearer every erasure request carries.
final class AccountDeletionBearerTests: XCTestCase {
    func testTheBearerIsMintedFreshRatherThanReadFromTheTokenCache() async throws {
        var requestedSkipCache: [Bool] = []

        let token = try await AccountDeletionComposition.reverifiedBearerToken(
            mint: { skipCache in
                requestedSkipCache.append(skipCache)
                return "token"
            }
        )

        // The handler reads the session's factor verification age. A token
        // minted before the seller answered the strict reverification carries
        // the older claim, so a cached one earns a challenge for a challenge
        // they already answered and the deletion never starts.
        XCTAssertEqual(requestedSkipCache, [true])
        XCTAssertEqual(token, "token")
    }

    func testNoSessionIsAnErrorRatherThanARequestWithNoBearer() async {
        do {
            _ = try await AccountDeletionComposition.reverifiedBearerToken(
                mint: { _ in nil }
            )
            XCTFail("A missing session must not produce a request.")
        } catch is AccountDeletionComposition.MissingSessionError {
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
    }
}

/**
 Issue #385, closed by #819 item 5.

 `AccountDeletionComposition.make` is where the deletion's live parts are joined:
 the fail-closed identity guard, the per-seller key store, the reverified bearer,
 the device clearing and the sign-out. Until #819 nothing tested it. Every other
 test in this family hands the coordinator dependencies built by hand, and the UI
 tests run `AccountDeletionComposition.fixture`, whose `clearDeviceState` and
 `signOut` return `true` without doing anything — so this wiring was proved only
 by running the app on a device.

 Nothing here reaches ClerkKit. `make` takes its Clerk seams as arguments and the
 shipped entry point supplies them, which is the only reason a signed-in seller
 can be stood up at all: `Clerk.shared.client` has an `internal(set)` setter.
 */
final class AccountDeletionCompositionTests: XCTestCase {
    private let apiOrigin = URL(string: "https://snaplist.dev")!
    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "dev.snaplist.tests.account-deletion-composition.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        AccountDeletionCompositionURLProtocolStub.reset()
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        suiteName = nil
        super.tearDown()
    }

    @MainActor
    func testNoSignedInSellerRefusesBeforeAnythingOnThisDeviceIsTouched() async {
        let device = AccountDeletionCompositionRecorder()
        let dependencies = AccountDeletionComposition.make(
            apiOrigin: apiOrigin,
            session: stubbedSession(),
            signedInUserID: nil,
            mintBearerToken: { _ in "token" },
            endSession: { device.record("signed-out") },
            keyStoreDefaults: defaults,
            removeIntake: { device.record("intake"); return true },
            removeCachedItems: { device.record("cached-items"); return true }
        )

        let outcome = await dependencies.requestErasure("38520000-0000-4000-8000-000000000001")
        let cleared = await dependencies.clearDeviceState()
        let signedOut = await dependencies.signOut()

        // Fail closed. A placeholder id would file every seller with no user
        // under one shared key, and that key is the only thing that makes an
        // interrupted deletion resumable rather than a permanent 409 — the
        // round-1 P0 on #814 in a second costume.
        XCTAssertEqual(outcome, .notConfirmed(.clientNotConfigured))
        XCTAssertNil(
            AccountDeletionCompositionURLProtocolStub.lastRequest,
            "A build that cannot identify the seller must not post an erasure."
        )
        // Not a claim that the device is clean, and not a signed-out session
        // either: a seller left signed out with their copies still here has no
        // route back to remove them.
        XCTAssertFalse(cleared)
        XCTAssertFalse(signedOut)
        XCTAssertEqual(device.events, [])
    }

    @MainActor
    func testTheLiveWiringPostsTheErasureThenClearsEveryStoreOnThisDevice()
        async {
        AccountDeletionCompositionURLProtocolStub.responses = [
            .init(
                status: 200,
                body: """
                {"data":{"generationId":"38520000-0000-4000-8000-000000000002",\
                "status":"deletion_completed_with_retained_records",\
                "retainedRecords":["ebay-live-listing"],"deferrals":[],\
                "attentionReasons":[]},"meta":{"requestId":"request-819"}}
                """
            ),
        ]
        let device = AccountDeletionCompositionRecorder()
        let dependencies = AccountDeletionComposition.make(
            apiOrigin: apiOrigin,
            session: stubbedSession(),
            signedInUserID: "user_819",
            mintBearerToken: { skipCache in
                device.record("minted(skipCache: \(skipCache))")
                return "reverified-token"
            },
            endSession: { device.record("signed-out") },
            keyStoreDefaults: defaults,
            removeIntake: { device.record("intake"); return true },
            removeCachedItems: { device.record("cached-items"); return true }
        )

        let key = dependencies.newIdempotencyKey()
        let outcome = await dependencies.requestErasure(key)
        let cleared = await dependencies.clearDeviceState()
        let signedOut = await dependencies.signOut()

        XCTAssertEqual(outcome, .completed(retainedRecords: [.ebayLiveListing]))
        let request = AccountDeletionCompositionURLProtocolStub.lastRequest
        XCTAssertEqual(request?.httpMethod, "POST")
        XCTAssertEqual(request?.url?.path, "/v1/account/erasure")
        XCTAssertEqual(
            request?.value(forHTTPHeaderField: "Idempotency-Key"),
            key
        )
        // The handler parses this header against a UUID schema before it
        // authenticates, so an uppercased one is a 400 that never reaches the
        // erasure at all.
        XCTAssertEqual(key, key.lowercased())
        XCTAssertNotNil(UUID(uuidString: key))
        XCTAssertEqual(
            request?.value(forHTTPHeaderField: "Authorization"),
            "Bearer reverified-token"
        )
        // The bearer is minted with the cache skipped. A token issued before
        // the seller answered the strict reverification carries the older
        // factor verification age, and the handler reads that claim.
        XCTAssertEqual(
            device.events.first,
            "minted(skipCache: true)"
        )
        // Intake and cached items are separate steps, and both run even though
        // the seller may have neither. The Keychain half follows, one item at a
        // time, and a device holding none of them is already clean.
        XCTAssertEqual(
            Array(device.events.dropFirst()),
            ["intake", "cached-items", "signed-out"]
        )
        XCTAssertTrue(cleared)
        XCTAssertTrue(signedOut)
    }

    @MainActor
    func testTheKeyIsFiledUnderTheSellerItBelongsToAndNoOneElse() {
        let dependencies = makeDependencies(signedInUserID: "user_a")
        let otherSeller = makeDependencies(signedInUserID: "user_b")

        dependencies.rememberIdempotencyKey("key-a")

        // `begin_account_erasure` binds one key per account and raises 23505 for
        // a second, which the handler returns as 409. A device-wide store would
        // hand seller A's key to seller B, whose own erasure would then be
        // refused with no way to mint the key the server actually wants.
        XCTAssertEqual(dependencies.loadIdempotencyKey(), "key-a")
        XCTAssertNil(otherSeller.loadIdempotencyKey())

        // Durable, not view state: the store outlives the screen that minted
        // it, which is what makes an interrupted deletion resumable.
        XCTAssertEqual(
            makeDependencies(signedInUserID: "user_a").loadIdempotencyKey(),
            "key-a"
        )

        dependencies.forgetIdempotencyKey()
        XCTAssertNil(dependencies.loadIdempotencyKey())
    }

    /// #819 item 5. `waitsBeforeFollowUp == [1, 2]` asserts only that the wait
    /// was called, so replacing the exponent with a constant survived the whole
    /// suite. The gap itself is the thing that matters: every follow-up re-runs
    /// the server's erase pipeline, provider calls included.
    func testFollowUpsBackOffInsteadOfWaitingTheSameGapEveryTime() {
        XCTAssertEqual(
            (1...3).map {
                AccountDeletionComposition.followUpDelaySeconds(attempt: $0)
            },
            [1, 2, 4]
        )
        // A shift by a negative amount traps. An attempt counter below one is a
        // caller bug, not a reason to crash a seller's deletion.
        XCTAssertEqual(
            AccountDeletionComposition.followUpDelaySeconds(attempt: 0),
            1
        )
    }

    @MainActor
    private func makeDependencies(
        signedInUserID: String?
    ) -> AccountDeletionCoordinator.Dependencies {
        AccountDeletionComposition.make(
            apiOrigin: apiOrigin,
            session: stubbedSession(),
            signedInUserID: signedInUserID,
            mintBearerToken: { _ in "reverified-token" },
            endSession: {},
            keyStoreDefaults: defaults,
            removeIntake: { true },
            removeCachedItems: { true }
        )
    }

    private func stubbedSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [
            AccountDeletionCompositionURLProtocolStub.self,
        ]
        return URLSession(configuration: configuration)
    }
}

/// What the live wiring actually reached, in order.
private final class AccountDeletionCompositionRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [String] = []

    var events: [String] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }

    func record(_ event: String) {
        lock.lock()
        defer { lock.unlock() }
        recorded.append(event)
    }
}

private final class AccountDeletionCompositionURLProtocolStub: URLProtocol,
    @unchecked Sendable {
    struct StubResponse {
        let status: Int
        let body: String
    }

    nonisolated(unsafe) static var responses: [StubResponse] = []
    nonisolated(unsafe) static var lastRequest: URLRequest?

    static func reset() {
        responses = []
        lastRequest = nil
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        Self.lastRequest = request
        guard !Self.responses.isEmpty else {
            client?.urlProtocol(
                self,
                didFailWithError: URLError(.notConnectedToInternet)
            )
            return
        }
        let stub = Self.responses.removeFirst()
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: stub.status,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(
            self,
            didReceive: response,
            cacheStoragePolicy: .notAllowed
        )
        client?.urlProtocol(self, didLoad: Data(stub.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// Records what the coordinator actually did, in the order it did it. Ordering
/// is the whole point: clearing before durable completion leaves a seller with
/// an intact account they can no longer reach.
private final class AccountDeletionRecorder: @unchecked Sendable {
    enum Event: Equatable {
        case requestedErasure
        case clearedDeviceState
        case signedOut
    }

    private(set) var events: [Event] = []
    private(set) var idempotencyKeys: [String] = []
    private(set) var waitsBeforeFollowUp: [Int] = []
    /// Stands in for storage that outlives one screen. Held on the recorder, so
    /// a second coordinator built from the same recorder sees what the first
    /// one wrote, exactly as a second host would.
    private(set) var persistedIdempotencyKey: String?
    private var remainingOutcomes: [AccountErasureOutcome] = []
    private var mintedKeys = 0
    private var deviceClearingSucceeds = true
    private var signOutSucceeds = true
    private let lock = NSLock()

    /// Lets a device that refused to clear start cooperating, so a retry can be
    /// observed doing the only work that is actually left.
    func allowDeviceClearing() {
        lock.lock()
        defer { lock.unlock() }
        deviceClearingSucceeds = true
    }

    func dependencies(
        outcomes: [AccountErasureOutcome],
        deviceClearingSucceeds: Bool = true,
        signOutSucceeds: Bool = true,
        maximumStatusFollowUps: Int = 3
    ) -> AccountDeletionCoordinator.Dependencies {
        remainingOutcomes = outcomes
        self.deviceClearingSucceeds = deviceClearingSucceeds
        self.signOutSucceeds = signOutSucceeds
        return AccountDeletionCoordinator.Dependencies(
            requestErasure: { [self] key in
                lock.lock()
                defer { lock.unlock() }
                events.append(.requestedErasure)
                idempotencyKeys.append(key)
                guard !remainingOutcomes.isEmpty else {
                    return .notConfirmed(.transport)
                }
                return remainingOutcomes.removeFirst()
            },
            clearDeviceState: { [self] in
                lock.lock()
                defer { lock.unlock() }
                events.append(.clearedDeviceState)
                return self.deviceClearingSucceeds
            },
            signOut: { [self] in
                lock.lock()
                defer { lock.unlock() }
                events.append(.signedOut)
                return signOutSucceeds
            },
            newIdempotencyKey: { [self] in
                lock.lock()
                defer { lock.unlock() }
                mintedKeys += 1
                return "key-\(mintedKeys)"
            },
            loadIdempotencyKey: { [self] in
                lock.lock()
                defer { lock.unlock() }
                return persistedIdempotencyKey
            },
            rememberIdempotencyKey: { [self] key in
                lock.lock()
                defer { lock.unlock() }
                persistedIdempotencyKey = key
            },
            forgetIdempotencyKey: { [self] in
                lock.lock()
                defer { lock.unlock() }
                persistedIdempotencyKey = nil
            },
            waitBeforeFollowUp: { [self] attempt in
                lock.lock()
                defer { lock.unlock() }
                waitsBeforeFollowUp.append(attempt)
            },
            maximumStatusFollowUps: maximumStatusFollowUps
        )
    }
}
