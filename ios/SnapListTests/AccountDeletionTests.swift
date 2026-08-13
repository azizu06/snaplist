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
        // It is waiting on a person, not on work. A "Try again" here would be a
        // control whose only possible effect is another identical answer.
        XCTAssertFalse(phase.offersRetry)
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

    func testDeletionKnowsEveryKeychainItemTheAppWrites() {
        // Adding a Keychain item without adding it here leaves a credential
        // behind after an account deletion, which is the failure Guideline
        // 5.1.1(v) is about. This list is meant to be updated deliberately.
        XCTAssertEqual(
            Set(AccountDeletionKeychainItem.everythingSnapListStores.map(\.service)),
            [
                "dev.snaplist.ios.guest-recovery-credential",
                "dev.snaplist.ios.guest-claim-authority",
                "dev.snaplist.ios.guest-claim-handoff",
                "dev.snaplist.ios.app-attest",
                "dev.snaplist.ios.guest-capability",
            ]
        )
        XCTAssertEqual(
            AccountDeletionKeychainItem.everythingSnapListStores.map(\.account).sorted(),
            [
                "guest-capability-bearer",
                "listing-authorities-v1",
                "recovery-credentials-v1",
                "retained-handoffs-v1",
                "verified-app-attest-key-id",
            ]
        )
    }
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
