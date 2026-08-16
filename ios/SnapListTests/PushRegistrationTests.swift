import Foundation
import XCTest
@testable import SnapList

/// Behavior of the push permission state machine (issue #890).
///
/// The product rule this file exists to hold is a promise to the seller: the
/// app asks for notifications once, after their first item is submitted, and if
/// they say no it never asks again from inside the app. Everything here runs
/// against the pure domain — no real notification centre, no real APNs — so the
/// promise is provable without a device and without a prompt anyone has to
/// dismiss by hand.
final class PushRegistrationTests: XCTestCase {
    func testAsksOnceAfterTheFirstItemIsSubmitted() {
        var progress = PushRegistrationProgress()

        XCTAssertEqual(progress.advance(for: .itemSubmitted), .askOnce)
        XCTAssertEqual(progress.decision, .notYetAsked)
    }

    func testNothingAsksBeforeAnItemIsSubmitted() {
        var progress = PushRegistrationProgress()

        // Launch, sign-in, browsing: none of it is a moment that earned the
        // prompt, and the domain has no event that could produce one.
        XCTAssertEqual(progress.decision, .notYetAsked)
        XCTAssertEqual(progress.advance(for: .sellerAnswered(granted: false)), .doNothing)
    }

    func testAllowingRegistersTheDeviceAndRecordsTheDecision() {
        var progress = PushRegistrationProgress()
        _ = progress.advance(for: .itemSubmitted)

        XCTAssertEqual(
            progress.advance(for: .sellerAnswered(granted: true)),
            .registerWithAPNs
        )
        XCTAssertEqual(progress.decision, .allowed)
    }

    func testRefusingIsRecordedAndNeverAsksAgain() {
        var progress = PushRegistrationProgress()
        _ = progress.advance(for: .itemSubmitted)

        XCTAssertEqual(
            progress.advance(for: .sellerAnswered(granted: false)),
            .doNothing
        )
        XCTAssertEqual(progress.decision, .refused)

        // Every later submission, for the life of the install. The Settings row
        // is the only way back, and this app never asks again.
        for _ in 0..<3 {
            XCTAssertEqual(progress.advance(for: .itemSubmitted), .doNothing)
            XCTAssertEqual(progress.decision, .refused)
        }
    }

    func testLaterSubmissionsReRegisterWithoutAskingAgain() {
        var progress = PushRegistrationProgress()
        _ = progress.advance(for: .itemSubmitted)
        _ = progress.advance(for: .sellerAnswered(granted: true))

        // APNs reissues a token whenever it likes, so a seller who already said
        // yes re-registers on later submissions. That is a silent write, never
        // a second prompt.
        XCTAssertEqual(progress.advance(for: .itemSubmitted), .registerWithAPNs)
        XCTAssertEqual(progress.decision, .allowed)
    }

    func testAnAnswerThatArrivesTwiceDoesNotReopenTheQuestion() {
        var progress = PushRegistrationProgress()
        _ = progress.advance(for: .itemSubmitted)
        _ = progress.advance(for: .sellerAnswered(granted: false))

        // A duplicate callback must not turn a refusal into a fresh ask.
        XCTAssertEqual(
            progress.advance(for: .sellerAnswered(granted: false)),
            .doNothing
        )
        XCTAssertEqual(progress.decision, .refused)
    }

    func testTheDecisionSurvivesRelaunch() throws {
        let suiteName = "snaplist.push-registration-tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let store = UserDefaultsPushRegistrationStore(defaults: defaults)
        XCTAssertEqual(store.load().decision, .notYetAsked)

        var progress = store.load()
        _ = progress.advance(for: .itemSubmitted)
        _ = progress.advance(for: .sellerAnswered(granted: false))
        store.save(progress)

        // A refusal that did not survive relaunch would be a promise broken on
        // the seller's next submission.
        let reloaded = UserDefaultsPushRegistrationStore(defaults: defaults)
        var restored = reloaded.load()
        XCTAssertEqual(restored.decision, .refused)
        XCTAssertEqual(restored.advance(for: .itemSubmitted), .doNothing)
    }
}

/// The coordinator around that state machine: what the app actually does with
/// a submission, an answer, and a device token.
@MainActor
final class PushRegistrationCoordinatorTests: XCTestCase {
    private final class RecordingStore: PushRegistrationPersisting {
        var progress = PushRegistrationProgress()
        private(set) var saveCount = 0

        func load() -> PushRegistrationProgress { progress }
        func save(_ progress: PushRegistrationProgress) {
            self.progress = progress
            saveCount += 1
        }
    }

    private func makeCoordinator(
        store: RecordingStore,
        grants: Bool = true,
        authorizationError: Error? = nil,
        register: @escaping @MainActor () -> Void = {},
        submit: @escaping (String) async throws -> Void = { _ in }
    ) -> PushRegistrationCoordinator {
        PushRegistrationCoordinator(
            store: store,
            requestAuthorization: {
                if let authorizationError { throw authorizationError }
                return grants
            },
            registerForRemoteNotifications: register,
            submitDeviceToken: submit
        )
    }

    func testFirstSubmissionAsksAndAnAllowedAnswerRegisters() async {
        let store = RecordingStore()
        var registered = 0
        let coordinator = makeCoordinator(
            store: store,
            register: { registered += 1 }
        )

        await coordinator.itemSubmitted()

        XCTAssertEqual(registered, 1)
        XCTAssertEqual(store.progress.decision, .allowed)
    }

    func testARefusalIsRecordedAndTheSecondSubmissionNeverPrompts() async {
        let store = RecordingStore()
        var asked = 0
        let coordinator = PushRegistrationCoordinator(
            store: store,
            requestAuthorization: {
                asked += 1
                return false
            },
            registerForRemoteNotifications: {},
            submitDeviceToken: { _ in }
        )

        await coordinator.itemSubmitted()
        await coordinator.itemSubmitted()

        XCTAssertEqual(asked, 1)
        XCTAssertEqual(store.progress.decision, .refused)
    }

    func testAFailedAuthorizationRequestLeavesTheQuestionOpen() async {
        let store = RecordingStore()
        let coordinator = makeCoordinator(
            store: store,
            authorizationError: PushRegistrationTestError.failed
        )

        await coordinator.itemSubmitted()

        // Not a refusal: the seller never answered. Recording one would silence
        // the app forever over a transient failure.
        XCTAssertEqual(store.progress.decision, .notYetAsked)
    }

    func testAFailedTokenSubmissionNeverChangesWhatTheSellerDecided() async {
        let store = RecordingStore()
        let coordinator = makeCoordinator(store: store) { _ in
            throw PushRegistrationTestError.failed
        }

        await coordinator.itemSubmitted()
        await coordinator.deviceTokenReceived(Data([0xab, 0xcd]))

        // Registration is best-effort by design: nothing about submitting an
        // item may depend on it, and a failed post must not undo the grant.
        XCTAssertEqual(store.progress.decision, .allowed)
    }

    func testTheDeviceTokenIsSentAsLowercaseHex() async {
        let store = RecordingStore()
        var sent: [String] = []
        let coordinator = makeCoordinator(store: store) { token in
            sent.append(token)
        }

        await coordinator.itemSubmitted()
        await coordinator.deviceTokenReceived(Data([0x00, 0x0f, 0xab, 0xff]))

        // APNs hands the app bytes; the contract carries lowercase hex, and the
        // column's own check constraint refuses anything else.
        XCTAssertEqual(sent, ["000fabff"])
    }

    func testATokenThatArrivesAfterARefusalIsNotSent() async {
        let store = RecordingStore()
        var sent: [String] = []
        let coordinator = PushRegistrationCoordinator(
            store: store,
            requestAuthorization: { false },
            registerForRemoteNotifications: {},
            submitDeviceToken: { sent.append($0) }
        )

        await coordinator.itemSubmitted()
        await coordinator.deviceTokenReceived(Data([0x01]))

        XCTAssertTrue(sent.isEmpty)
    }
}

private enum PushRegistrationTestError: Error {
    case failed
}
