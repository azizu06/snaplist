import Foundation
import UIKit
import XCTest
@testable import SnapList

final class OnboardingFlowTests: XCTestCase {
    func testPrimaryDockKeepsOneGeometryAcrossDestinations() {
        let scanHeight = FloatingDockMetrics.destinationHeight(for: .scan)
        let trophyHeight = FloatingDockMetrics.destinationHeight(for: .trophyWall)
        let scanInset = FloatingDockMetrics.bottomInset(for: .scan)
        let trophyInset = FloatingDockMetrics.bottomInset(for: .trophyWall)

        XCTAssertEqual(scanHeight, 52)
        XCTAssertEqual(trophyHeight, scanHeight)
        XCTAssertEqual(trophyInset, scanInset)
    }

    func testVoiceExampleWaveformMovesOverOneCycle() {
        let resting = FirstValueVoiceWaveform.restingBarHeights
        XCTAssertFalse(resting.isEmpty)

        let quarter = (0..<resting.count).map { index in
            FirstValueVoiceWaveform.barHeight(
                resting: resting[index],
                index: index,
                phase: 0.25
            )
        }
        let threeQuarters = (0..<resting.count).map { index in
            FirstValueVoiceWaveform.barHeight(
                resting: resting[index],
                index: index,
                phase: 0.75
            )
        }

        XCTAssertNotEqual(
            quarter,
            threeQuarters,
            "the bars are identical half a cycle apart, so the waveform reads as paused"
        )
    }

    func testVoiceExampleWaveformLoopsSeamlessly() {
        let resting = FirstValueVoiceWaveform.restingBarHeights
        for index in resting.indices {
            let start = FirstValueVoiceWaveform.barHeight(
                resting: resting[index],
                index: index,
                phase: 0
            )
            let end = FirstValueVoiceWaveform.barHeight(
                resting: resting[index],
                index: index,
                phase: 1
            )
            XCTAssertEqual(
                start,
                end,
                accuracy: 0.001,
                "bar \(index) jumps at the loop seam"
            )
        }
    }

    func testVoiceExampleWaveformKeepsEveryBarVisible() {
        let resting = FirstValueVoiceWaveform.restingBarHeights
        for step in 0..<24 {
            let phase = Double(step) / 24
            for index in resting.indices {
                let height = FirstValueVoiceWaveform.barHeight(
                    resting: resting[index],
                    index: index,
                    phase: phase
                )
                XCTAssertGreaterThanOrEqual(
                    height,
                    4,
                    "bar \(index) collapses at phase \(phase)"
                )
                XCTAssertLessThanOrEqual(
                    height,
                    resting[index],
                    "bar \(index) grows past its resting height at phase \(phase)"
                )
            }
        }
    }

    func testVoiceExampleWaveformRestsWhenReduceMotionIsOn() {
        let resting = FirstValueVoiceWaveform.restingBarHeights
        for index in resting.indices {
            XCTAssertEqual(
                FirstValueVoiceWaveform.barHeight(
                    resting: resting[index],
                    index: index,
                    phase: nil
                ),
                resting[index]
            )
        }
    }

    func testFinalOnboardingStepReservesTheSkipControlSlot() {
        XCTAssertEqual(
            FirstValueOnboardingHeaderMetrics.trailingSlotWidth(for: .onb05),
            44
        )
        XCTAssertEqual(
            FirstValueOnboardingHeaderMetrics.trailingSlotWidth(for: .onb06),
            44
        )
    }

    func testDraftScoutUsesCenteredHairlineSpacing() {
        XCTAssertEqual(
            FirstValueOnboardingLayoutMetrics.draftScoutTopPadding,
            8
        )
    }

    func testActivationPresentsForAnOnboardedSellerUntilCompletion() {
        XCTAssertTrue(
            ActivationPresentationPolicy.shouldPresent(
                hasOnboarded: true,
                hasCompletedActivation: false
            )
        )
    }

    func testActivationNeverPresentsBeforeOnboardingOrAfterCompletion() {
        XCTAssertFalse(
            ActivationPresentationPolicy.shouldPresent(
                hasOnboarded: false,
                hasCompletedActivation: false
            )
        )
        XCTAssertFalse(
            ActivationPresentationPolicy.shouldPresent(
                hasOnboarded: true,
                hasCompletedActivation: true
            )
        )
        XCTAssertFalse(
            ActivationPresentationPolicy.shouldPresent(
                hasOnboarded: false,
                hasCompletedActivation: true
            )
        )
    }

    func testFirstValueActivationEligibilityKeepsDirectAndHistoricalScanSeparateFromTypedWork() {
        func isEligible(
            activeScreen: OnboardingScreen = .launch,
            consumedDirectScan: Bool = false,
            outcome: FirstValueOnboardingOutcome? = nil,
            isNormalScanShell: Bool = false,
            hasRestoredCapture: Bool = false,
            stagedPhotoCount: Int = 0,
            hasPhotoReviewSession: Bool = false
        ) -> Bool {
            FirstValueActivationEligibilityPolicy.shouldBootstrapActivation(
                activeScreen: activeScreen,
                hasConsumedMountedDirectScanCommand: consumedDirectScan,
                recordedOutcome: outcome,
                isNormalScanShell: isNormalScanShell,
                hasRestoredCapture: hasRestoredCapture,
                stagedPhotoCount: stagedPhotoCount,
                hasPhotoReviewSession: hasPhotoReviewSession
            )
        }

        XCTAssertTrue(isEligible(activeScreen: .captureBoundary))
        XCTAssertTrue(isEligible(consumedDirectScan: true, isNormalScanShell: true))
        XCTAssertTrue(isEligible(outcome: .completed, isNormalScanShell: true))
        XCTAssertTrue(isEligible(outcome: .skipped, isNormalScanShell: true))
        XCTAssertFalse(isEligible(
            outcome: .supersededByExistingProgress,
            isNormalScanShell: true
        ))
        XCTAssertFalse(isEligible(
            consumedDirectScan: true,
            isNormalScanShell: true,
            hasRestoredCapture: true
        ))
        XCTAssertFalse(isEligible(
            activeScreen: .denied,
            outcome: .completed,
            isNormalScanShell: true
        ))
    }

    func testActivationGuidanceDeclaresTheFullApprovedEightStateSet() {
        XCTAssertEqual(
            ActivationGuidanceState.allCases.map(\.rawValue),
            [
                "ACT-01",
                "ACT-02",
                "ACT-02B",
                "ACT-03",
                "ACT-04",
                "ACT-05",
                "ACT-06",
                "ACT-07",
            ]
        )
    }

    func testActivationGuidanceAdvancesOnlyAtItsMatchingSurface() {
        var progress = ActivationGuidanceProgress()

        XCTAssertEqual(
            ActivationCoachMark(
                state: progress.state,
                surface: .scan
            ),
            .act01
        )
        XCTAssertEqual(progress.advance(for: .gotIt), .advanced)
        XCTAssertNil(
            ActivationCoachMark(
                state: progress.state,
                surface: .scan
            )
        )
        XCTAssertEqual(
            ActivationCoachMark(
                state: progress.state,
                surface: .photoReview
            ),
            .act02
        )
    }

    func testActivationGuidanceTraversesEveryApprovedStateAndRecordsCompletion() {
        var progress = ActivationGuidanceProgress()

        XCTAssertEqual(progress.state, .act01)
        XCTAssertEqual(progress.recordInterruption(), .advanced)
        XCTAssertEqual(progress.state, .act06)
        XCTAssertEqual(progress.advance(for: .gotIt), .advanced)
        XCTAssertEqual(progress.state, .act02)
        XCTAssertEqual(progress.advance(for: .gotIt), .advanced)
        XCTAssertEqual(progress.state, .act02B)
        XCTAssertEqual(progress.advance(for: .gotIt), .advanced)
        XCTAssertTrue(progress.hasAcknowledgedCurrentState)
        XCTAssertEqual(progress.advance(for: .acceptedRunHandoff), .advanced)
        XCTAssertEqual(progress.state, .act03)
        XCTAssertEqual(progress.advance(for: .gotIt), .advanced)
        XCTAssertEqual(progress.state, .act04)
        XCTAssertEqual(progress.advance(for: .gotIt), .completionRequested)
        XCTAssertEqual(progress.state, .act04)
        XCTAssertTrue(progress.hasAcknowledgedCurrentState)
        XCTAssertTrue(progress.isCompletionPending)
        XCTAssertEqual(progress.advance(for: .completionRecorded), .completionRecorded)
        XCTAssertEqual(progress.state, .act05)
        XCTAssertEqual(progress.advance(for: .recordedInstallLoaded), .completionRecorded)
        XCTAssertEqual(progress.state, .act07)
    }

    func testActivationGuidanceAdvancesForUnderlyingActionsWithoutBlocking() {
        var progress = ActivationGuidanceProgress()

        XCTAssertEqual(progress.advance(for: .capturedFirstPhoto), .advanced)
        XCTAssertEqual(progress.state, .act02)

        XCTAssertEqual(progress.advance(for: .reorderedPhotos), .advanced)
        XCTAssertEqual(progress.state, .act02B)

        XCTAssertEqual(progress.advance(for: .openedVoiceNote), .advanced)
        XCTAssertTrue(progress.hasAcknowledgedCurrentState)

        XCTAssertEqual(progress.advance(for: .acceptedRunHandoff), .advanced)
        XCTAssertEqual(progress.state, .act03)

        XCTAssertEqual(progress.advance(for: .openedProcessing), .advanced)
        XCTAssertEqual(progress.state, .act04)

        XCTAssertEqual(progress.advance(for: .editedListing), .completionRequested)
        XCTAssertEqual(progress.state, .act04)
        XCTAssertTrue(progress.hasAcknowledgedCurrentState)
        XCTAssertTrue(progress.isCompletionPending)
    }

    func testOnlyDurableAcceptedRunHandoffAdvancesProcessingGuidance() {
        let eventID = UUID()
        let handoff = AcceptedItemRunHandoff(
            idempotencyKey: UUID(),
            acceptedRun: AcceptedItemRun(
                runID: UUID(),
                itemID: UUID(),
                status: "queued",
                stage: "accepted"
            )
        )

        XCTAssertNil(
            ActivationGuidanceSubmissionEventPolicy.action(
                for: .submissionRejected(eventID: eventID, retention: .rejected)
            )
        )
        XCTAssertNil(
            ActivationGuidanceSubmissionEventPolicy.action(
                for: .destinationHandoff(eventID: eventID, handoff: .pay01)
            )
        )
        XCTAssertNil(
            ActivationGuidanceSubmissionEventPolicy.action(
                for: .submissionRejected(eventID: eventID, retention: .ambiguous)
            )
        )
        XCTAssertEqual(
            ActivationGuidanceSubmissionEventPolicy.action(
                for: .itemSaved(eventID: eventID, handoff: handoff)
            ),
            .acceptedRunHandoff
        )
    }

    func testActivationGuidanceDoesNotDismissUntilTheSellerTapsGotItOrActsOnTheSurface() {
        var progress = ActivationGuidanceProgress(state: .act01)

        XCTAssertEqual(progress.advance(for: .openedProcessing), .unchanged)
        XCTAssertEqual(progress.state, .act01)
        XCTAssertFalse(progress.hasAcknowledgedCurrentState)
        XCTAssertFalse(progress.isCompletionPending)

        XCTAssertEqual(progress.advance(for: .gotIt), .advanced)
        XCTAssertEqual(progress.state, .act02)
    }

    @MainActor
    func testActivationCompletionBootstrapSurvivesGuestRelaunch() async {
        let suiteName = "activation-guidance-guest-relaunch-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let firstLaunchStore = UserDefaultsActivationGuidanceGuestCompletionStore(
            defaults: defaults
        )
        firstLaunchStore.recordCompletion()
        let relaunchStore = UserDefaultsActivationGuidanceGuestCompletionStore(
            defaults: defaults
        )
        var tenantReads = 0
        var tenantWrites = 0
        let result = await ActivationCompletionBootstrapCoordinator.resolve(
            guestCompleted: relaunchStore.isCompleted,
            loadProgress: { _ in .init() },
            fetchSessionUserID: {
                throw BearerTokenProviderError.sessionAbsent
            },
            fetchTenantCompleted: {
                tenantReads += 1
                return false
            },
            writeTenantCompletion: {
                tenantWrites += 1
                return true
            }
        )

        XCTAssertEqual(
            result,
            .completed(authentication: .guest, identity: "guest")
        )
        XCTAssertEqual(tenantReads, 0)
        XCTAssertEqual(tenantWrites, 0)
    }

    func testTheSame401MeansGuestOrOutageDependingOnTheCredentialItAnswered() {
        // A capability bearer proves an installation and never a subject, so a
        // route refusing it is that route working: this caller is a guest.
        XCTAssertEqual(
            ActivationAuthenticationPolicy.state(
                forSessionError: MobileAPIClientError.unauthenticated(
                    credential: .guestCapability
                )
            ),
            .guest
        )

        // The identical status answered to a Clerk bearer says the opposite: a
        // token minted for a verified subject was refused. That is a Clerk
        // misconfiguration, it clears on its own, and classifying it as guest
        // would re-show the activation coach marks to a signed-in seller.
        XCTAssertEqual(
            ActivationAuthenticationPolicy.state(
                forSessionError: MobileAPIClientError.unauthenticated(
                    credential: .clerkSubject
                )
            ),
            .unknown
        )
    }

    func testASessionRejectionClassifiesTheCallerAsGuestNotAsAnOutage() {
        // A guest carries the App Attest capability bearer, so /v1/session
        // answers 401 rather than failing to produce a token at all. Both are
        // the same fact — there is no Clerk subject — and both must terminate
        // the bootstrap loop instead of scheduling another request.
        XCTAssertEqual(
            ActivationAuthenticationPolicy.state(
                forSessionError: MobileAPIClientError.httpStatus(401)
            ),
            .guest
        )
        XCTAssertEqual(
            ActivationAuthenticationPolicy.state(
                forSessionError: BearerTokenProviderError.sessionAbsent
            ),
            .guest
        )

        // #843 item 1. A renewal that could not reach Apple or the SnapList
        // server says nothing about whether this caller has an account, so it
        // must not join `.sessionAbsent` in terminating the bootstrap as a
        // guest. It is a transient failure, which is what `.unknown` is for.
        XCTAssertEqual(
            ActivationAuthenticationPolicy.state(
                forSessionError: BearerTokenProviderError
                    .credentialTemporarilyUnavailable
            ),
            .unknown
        )

        // .unknown stays reserved for failures where retrying can succeed.
        XCTAssertEqual(
            ActivationAuthenticationPolicy.state(
                forSessionError: MobileAPIClientError.httpStatus(503)
            ),
            .unknown
        )
        XCTAssertEqual(
            ActivationAuthenticationPolicy.state(
                forSessionError: NSError(
                    domain: NSURLErrorDomain,
                    code: NSURLErrorTimedOut
                )
            ),
            .unknown
        )
    }

    @MainActor
    func testActivationCompletionBootstrapDefersDuringAuthOutage() async {
        XCTAssertEqual(
            ActivationAuthenticationPolicy.state(
                forSessionError: NSError(
                    domain: NSURLErrorDomain,
                    code: NSURLErrorTimedOut
                )
            ),
            .unknown
        )
        XCTAssertEqual(
            ActivationAuthenticationPolicy.state(
                forSessionError: MobileAPIClientError.httpStatus(500)
            ),
            .unknown
        )

        let result = await ActivationCompletionBootstrapCoordinator.resolve(
            guestCompleted: true,
            loadProgress: { _ in .init() },
            fetchSessionUserID: {
                throw NSError(
                    domain: NSURLErrorDomain,
                    code: NSURLErrorTimedOut
                )
            },
            fetchTenantCompleted: { false },
            writeTenantCompletion: { true }
        )
        XCTAssertEqual(
            result,
            .retry(authentication: .unknown)
        )
    }

    @MainActor
    func testActivationCompletionBootstrapPromotesGuestMarkerAfterAccountCreation() async {
        var tenantWrites = 0
        let result = await ActivationCompletionBootstrapCoordinator.resolve(
            guestCompleted: true,
            loadProgress: { _ in .init() },
            fetchSessionUserID: { "user_566" },
            fetchTenantCompleted: { false },
            writeTenantCompletion: {
                tenantWrites += 1
                return true
            }
        )

        XCTAssertEqual(
            result,
            .completed(
                authentication: .authenticated(userID: "user_566"),
                identity: "user_566"
            )
        )
        XCTAssertEqual(tenantWrites, 1)
    }

    @MainActor
    func testActivationCompletionBootstrapUsesTenantMarkerAfterReinstall() async {
        var tenantWrites = 0
        let result = await ActivationCompletionBootstrapCoordinator.resolve(
            guestCompleted: false,
            loadProgress: { _ in .init() },
            fetchSessionUserID: { "user_566" },
            fetchTenantCompleted: { true },
            writeTenantCompletion: {
                tenantWrites += 1
                return true
            }
        )

        XCTAssertEqual(
            result,
            .completed(
                authentication: .authenticated(userID: "user_566"),
                identity: "user_566"
            )
        )
        XCTAssertEqual(tenantWrites, 0)
    }

    @MainActor
    func testActivationCompletionBootstrapResumesInterruptedTenantWriteOnRelaunch() async {
        var pendingProgress = ActivationGuidanceProgress(state: .act04)
        XCTAssertEqual(
            pendingProgress.advance(for: .gotIt),
            .completionRequested
        )
        var tenantWrites = 0

        let result = await ActivationCompletionBootstrapCoordinator.resolve(
            guestCompleted: false,
            loadProgress: { _ in pendingProgress },
            fetchSessionUserID: { "user_566" },
            fetchTenantCompleted: { false },
            writeTenantCompletion: {
                tenantWrites += 1
                return true
            }
        )

        XCTAssertEqual(
            result,
            .completed(
                authentication: .authenticated(userID: "user_566"),
                identity: "user_566"
            )
        )
        XCTAssertEqual(tenantWrites, 1)
    }

    @MainActor
    func testCompletedGuestMarkerPromotesWhenAccountAppearsInSameSession() async {
        var tenantWrites = 0
        let result = await ActivationGuestCompletionPromotionCoordinator.attempt(
            fetchSessionUserID: { "user_566" },
            fetchTenantCompleted: { false },
            writeTenantCompletion: {
                tenantWrites += 1
                return true
            }
        )

        XCTAssertEqual(result, .promoted(userID: "user_566"))
        XCTAssertEqual(tenantWrites, 1)
    }

    func testEveryStepOnTheBackoffLadderIsOneTheLoopCanActuallyReach() {
        let policy = ActivationRetryPolicy.standard

        // The loop sleeps after every attempt except the last, so these four
        // are the whole retry envelope the doc comment states: 2 + 4 + 8 + 16.
        let spent = (1..<policy.maxAttempts).map(policy.delay(afterAttempt:))
        XCTAssertEqual(
            spent,
            [.seconds(2), .seconds(4), .seconds(8), .seconds(16)]
        )

        // A step the ladder can return but the loop can never ask for is not a
        // longer envelope, it is a number that misleads the next reader about
        // how long a failing activation actually retries for.
        XCTAssertEqual(
            Set((1...1_000).map(policy.delay(afterAttempt:))),
            Set(spent)
        )
    }

    func testActivationRetriesBackOffAndStateTheirCap() {
        let policy = ActivationRetryPolicy.standard

        XCTAssertEqual(policy.maxAttempts, 5)
        XCTAssertEqual(policy.delay(afterAttempt: 1), .seconds(2))
        XCTAssertEqual(policy.delay(afterAttempt: 2), .seconds(4))
        XCTAssertEqual(policy.delay(afterAttempt: 3), .seconds(8))
        XCTAssertEqual(policy.delay(afterAttempt: 4), .seconds(16))
        XCTAssertEqual(policy.delay(afterAttempt: 99), .seconds(16))
    }

    @MainActor
    func testAGuestLeavesActivationBootstrapAfterOneSessionRequest() async {
        var sessionRequests = 0
        var sleeps: [Duration] = []

        let result = await ActivationCompletionBootstrapCoordinator.bootstrap(
            isCancelled: { false },
            sleep: { sleeps.append($0) },
            onRetry: { _ in },
            guestCompleted: { false },
            loadProgress: { _ in .init() },
            fetchSessionUserID: {
                sessionRequests += 1
                throw MobileAPIClientError.httpStatus(401)
            },
            fetchTenantCompleted: { false },
            writeTenantCompletion: { true }
        )

        XCTAssertEqual(
            result,
            .present(
                authentication: .guest,
                identity: "guest",
                progress: .init()
            )
        )
        XCTAssertEqual(sessionRequests, 1)
        XCTAssertEqual(sleeps, [])
    }

    @MainActor
    func testAnAuthenticatedTransportFailureIsNeverDowngradedToGuest() async {
        var sessionRequests = 0
        var sleeps: [Duration] = []
        var retryStates: [ActivationAuthenticationState] = []

        let result = await ActivationCompletionBootstrapCoordinator.bootstrap(
            isCancelled: { false },
            sleep: { sleeps.append($0) },
            onRetry: { retryStates.append($0) },
            guestCompleted: { false },
            loadProgress: { _ in .init() },
            fetchSessionUserID: {
                sessionRequests += 1
                throw NSError(
                    domain: NSURLErrorDomain,
                    code: NSURLErrorTimedOut
                )
            },
            fetchTenantCompleted: { false },
            writeTenantCompletion: { true }
        )

        // An outage is not evidence of a missing account. It resolves to
        // nothing at all rather than to a guest.
        XCTAssertNil(result)
        XCTAssertFalse(retryStates.contains(.guest))
        XCTAssertEqual(
            retryStates,
            Array(
                repeating: .unknown,
                count: ActivationRetryPolicy.standard.maxAttempts
            )
        )
        XCTAssertEqual(
            sessionRequests,
            ActivationRetryPolicy.standard.maxAttempts
        )
        XCTAssertEqual(sleeps, [.seconds(2), .seconds(4), .seconds(8), .seconds(16)])
    }

    @MainActor
    func testATransientTransportFailureStillResolvesTheAuthenticatedUser() async {
        var sessionRequests = 0

        let result = await ActivationCompletionBootstrapCoordinator.bootstrap(
            isCancelled: { false },
            sleep: { _ in },
            onRetry: { _ in },
            guestCompleted: { false },
            loadProgress: { _ in .init() },
            fetchSessionUserID: {
                sessionRequests += 1
                guard sessionRequests > 1 else {
                    throw NSError(
                        domain: NSURLErrorDomain,
                        code: NSURLErrorNetworkConnectionLost
                    )
                }
                return "user_566"
            },
            fetchTenantCompleted: { false },
            writeTenantCompletion: { true }
        )

        XCTAssertEqual(
            result,
            .present(
                authentication: .authenticated(userID: "user_566"),
                identity: "user_566",
                progress: .init()
            )
        )
        XCTAssertEqual(sessionRequests, 2)
    }

    @MainActor
    func testACancelledActivationBootstrapIssuesNoSessionRequest() async {
        var sessionRequests = 0

        let result = await ActivationCompletionBootstrapCoordinator.bootstrap(
            isCancelled: { true },
            sleep: { _ in },
            onRetry: { _ in },
            guestCompleted: { false },
            loadProgress: { _ in .init() },
            fetchSessionUserID: {
                sessionRequests += 1
                return "user_566"
            },
            fetchTenantCompleted: { false },
            writeTenantCompletion: { true }
        )

        XCTAssertNil(result)
        XCTAssertEqual(sessionRequests, 0)
    }

    @MainActor
    func testGuestPromotionWaitsForASessionInsteadOfReadingA401AsAnOutage() async {
        let result = await ActivationGuestCompletionPromotionCoordinator.attempt(
            fetchSessionUserID: {
                throw MobileAPIClientError.httpStatus(401)
            },
            fetchTenantCompleted: { false },
            writeTenantCompletion: { true }
        )

        XCTAssertEqual(result, .waitingForSession)
    }

    @MainActor
    func testGuestPromotionPollingIsBoundedWhileNoSessionAppears() async {
        var sessionRequests = 0
        var sleeps: [Duration] = []

        let result = await ActivationGuestCompletionPromotionCoordinator.promote(
            isCancelled: { false },
            sleep: { sleeps.append($0) },
            fetchSessionUserID: {
                sessionRequests += 1
                throw MobileAPIClientError.httpStatus(401)
            },
            fetchTenantCompleted: { false },
            writeTenantCompletion: { true }
        )

        XCTAssertNil(result)
        XCTAssertEqual(
            sessionRequests,
            ActivationRetryPolicy.standard.maxAttempts
        )
        XCTAssertEqual(sleeps, [.seconds(2), .seconds(4), .seconds(8), .seconds(16)])
    }

    @MainActor
    func testGuestPromotionRecordsTheTenantMarkerOnItsFirstAuthenticatedPass() async {
        var sessionRequests = 0
        var tenantWrites = 0
        var sleeps: [Duration] = []

        let result = await ActivationGuestCompletionPromotionCoordinator.promote(
            isCancelled: { false },
            sleep: { sleeps.append($0) },
            fetchSessionUserID: {
                sessionRequests += 1
                return "user_566"
            },
            // No marker is present yet, which is the only setup under which
            // recording one is observable. With it already completed the loop
            // promotes without ever reaching the write, and this test would
            // pass against a coordinator that never wrote at all.
            fetchTenantCompleted: { false },
            writeTenantCompletion: {
                tenantWrites += 1
                return true
            }
        )

        XCTAssertEqual(result, "user_566")
        XCTAssertEqual(tenantWrites, 1)
        XCTAssertEqual(sessionRequests, 1)
        XCTAssertEqual(sleeps, [])
    }

    @MainActor
    func testTheAuthenticatedCompletionWriteStopsInsteadOfRetryingForever() async {
        var writes = 0
        var sleeps: [Duration] = []

        let recorded = await ActivationCompletionRecordingCoordinator.record(
            isCancelled: { false },
            sleep: { sleeps.append($0) },
            writeTenantCompletion: {
                writes += 1
                return false
            }
        )

        XCTAssertFalse(recorded)
        XCTAssertEqual(writes, ActivationRetryPolicy.standard.maxAttempts)
        XCTAssertEqual(sleeps, [.seconds(2), .seconds(4), .seconds(8), .seconds(16)])
    }

    @MainActor
    func testTheAuthenticatedCompletionWriteRecoversFromATransientFailure() async {
        var writes = 0

        let recorded = await ActivationCompletionRecordingCoordinator.record(
            isCancelled: { false },
            sleep: { _ in },
            writeTenantCompletion: {
                writes += 1
                guard writes > 1 else {
                    throw MobileAPIClientError.httpStatus(503)
                }
                return true
            }
        )

        XCTAssertTrue(recorded)
        XCTAssertEqual(writes, 2)
    }

    func testReducedMotionSelectsAnExplicitStaticAssetForEveryACTState() {
        let expected: [ActivationGuidanceState: ActivationGuidanceAssetSelection] = [
            .act01: .staticImage(name: "ActivationScoutACT01"),
            .act02: .staticImage(name: "ActivationScoutACT02"),
            .act02B: .staticImage(name: "ActivationScoutACT02B"),
            .act03: .staticImage(name: "ActivationScoutACT03"),
            .act04: .staticImage(name: "ActivationScoutACT04"),
            .act05: .none,
            .act06: .staticImage(name: "ActivationScoutACT06"),
            .act07: .none,
        ]

        XCTAssertEqual(Set(expected.keys), Set(ActivationGuidanceState.allCases))
        for state in ActivationGuidanceState.allCases {
            XCTAssertEqual(
                ActivationGuidanceAssetPolicy.selection(
                    for: state,
                    reduceMotion: true
                ),
                expected[state]
            )
        }
        XCTAssertNotEqual(expected[.act01], expected[.act03])
        XCTAssertEqual(
            expected[.act06],
            .staticImage(name: "ActivationScoutACT06")
        )
    }

    func testActivationScoutStaticRenderingSelectsApprovedFallbacks() {
        let expected: [ActivationGuidanceState: ActivationGuidanceAssetSelection] = [
            .act01: .staticImage(name: "ActivationScoutACT01"),
            .act04: .staticImage(name: "ActivationScoutACT04"),
        ]

        for (state, selection) in expected {
            XCTAssertEqual(
                ActivationGuidanceAssetPolicy.selection(
                    for: state,
                    reduceMotion: false,
                    usesStaticRendering: true
                ),
                selection
            )
            XCTAssertEqual(
                ActivationGuidanceAssetPolicy.selection(
                    for: state,
                    reduceMotion: true,
                    usesStaticRendering: false
                ),
                selection
            )
        }
    }

    func testActivationScoutNormalMotionResolvesApprovedWebMsInTheBundle() throws {
        let expected: [ActivationGuidanceState: String] = [
            .act01: "act-01",
            .act04: "act-04",
        ]

        for (state, resourceName) in expected {
            let rendering = ActivationGuidanceAssetPolicy.rendering(
                for: state,
                reduceMotion: false,
                usesStaticRendering: false,
                bundle: .main
            )
            guard case .acceptedWebM(let url) = rendering else {
                return XCTFail("\(state.rawValue) did not resolve its approved WebM: \(rendering)")
            }
            XCTAssertEqual(url.deletingPathExtension().lastPathComponent, resourceName)
            XCTAssertEqual(url.pathExtension, "webm")
            XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
        }
    }

    func testActivationScoutMissingWebMFallsBackToApprovedStaticAsset() {
        let testBundle = Bundle(for: OnboardingFlowTests.self)

        for (state, expectedAsset) in [
            (ActivationGuidanceState.act01, "ActivationScoutACT01"),
            (.act04, "ActivationScoutACT04"),
        ] {
            XCTAssertEqual(
                ActivationGuidanceAssetPolicy.rendering(
                    for: state,
                    reduceMotion: false,
                    usesStaticRendering: false,
                    bundle: testBundle
                ),
                .staticFallbackPNG(asset: expectedAsset)
            )
        }
    }

    func testActivationScoutStaticFallbacksResolveAtThreeX() {
        let traitCollection = UITraitCollection(displayScale: 3)

        for state in [ActivationGuidanceState.act01, .act04] {
            guard case .staticImage(let assetName) = ActivationGuidanceAssetPolicy.selection(
                for: state,
                reduceMotion: true,
                usesStaticRendering: false
            ) else {
                return XCTFail("\(state.rawValue) did not select a static Scout fallback.")
            }
            let image = UIImage(
                named: assetName,
                in: .main,
                compatibleWith: traitCollection
            )
            XCTAssertNotNil(image, "\(state.rawValue) needs a delivered 3x Scout fallback.")
            XCTAssertEqual(image?.scale, 3, "\(state.rawValue) must resolve its 3x Scout fallback.")
        }
    }

    // Every approved coach mark docks against the one control its line names.
    // ACT-02B is the only state whose anchor sits above it, so it is the only
    // state with a top tail; its inset is round 1's 96 plus the 12 points the
    // downward tail used to occupy, which keeps the bubble body where the
    // approved composition put it.
    func testActivationCoachMarkAnchorsEveryApprovedState() {
        let expected: [ActivationCoachMark: ActivationCoachMarkAnchor] = [
            .act01: .init(tailEdge: .bottom, bottomInset: 112, tailHorizontalOffset: 0),
            .act02: .init(tailEdge: .bottom, bottomInset: 24, tailHorizontalOffset: 0),
            .act02B: .init(tailEdge: .top, bottomInset: 108, tailHorizontalOffset: 0),
            .act03: .init(tailEdge: .bottom, bottomInset: 24, tailHorizontalOffset: 0),
            .act04: .init(tailEdge: .bottom, bottomInset: 84, tailHorizontalOffset: 91),
            .act06: .init(tailEdge: .bottom, bottomInset: 112, tailHorizontalOffset: 0),
        ]

        for (coachMark, anchor) in expected {
            XCTAssertEqual(
                ActivationCoachMarkAnchorPolicy.anchor(
                    for: coachMark,
                    reduceMotion: false
                ),
                anchor
            )
        }
    }

    // Activation v1.1 draws the Reduced Motion variant as its own composition,
    // but "the tail carries the anchoring on its own": the still replaces the
    // Scout clip and nothing about the anchor moves. Both renderings therefore
    // point ACT-02B up at the Voice note row from the same band.
    func testActivationCoachMarkAnchorSurvivesReducedMotion() {
        for coachMark in [
            ActivationCoachMark.act01,
            .act02,
            .act02B,
            .act03,
            .act04,
            .act06,
        ] {
            XCTAssertEqual(
                ActivationCoachMarkAnchorPolicy.anchor(
                    for: coachMark,
                    reduceMotion: true
                ),
                ActivationCoachMarkAnchorPolicy.anchor(
                    for: coachMark,
                    reduceMotion: false
                ),
                "\(coachMark) must anchor identically under Reduced Motion"
            )
            XCTAssertNotEqual(
                ActivationGuidanceAssetPolicy.selection(
                    for: coachMark.state,
                    reduceMotion: true
                ),
                .none,
                "\(coachMark) must still render a Reduced Motion Scout"
            )
        }

        XCTAssertEqual(
            ActivationCoachMarkAnchorPolicy.anchor(
                for: .act02B,
                reduceMotion: true
            ).tailEdge,
            .top
        )
    }

    func testFirstValueOnboardingPresentsOnlyForAnIncompleteFirstLaunch() {
        XCTAssertTrue(
            FirstValueOnboardingPresentationPolicy.shouldPresent(
                isFirstLaunch: true,
                hasCompletedOnboarding: false,
                hasResolvedCaptureRestoration: true,
                hasRestoredCapture: false
            )
        )
        XCTAssertFalse(
            FirstValueOnboardingPresentationPolicy.shouldPresent(
                isFirstLaunch: false,
                hasCompletedOnboarding: false,
                hasResolvedCaptureRestoration: true,
                hasRestoredCapture: false
            )
        )
        XCTAssertFalse(
            FirstValueOnboardingPresentationPolicy.shouldPresent(
                isFirstLaunch: true,
                hasCompletedOnboarding: true,
                hasResolvedCaptureRestoration: true,
                hasRestoredCapture: false
            )
        )
        XCTAssertFalse(
            FirstValueOnboardingPresentationPolicy.shouldPresent(
                isFirstLaunch: false,
                hasCompletedOnboarding: true,
                hasResolvedCaptureRestoration: true,
                hasRestoredCapture: false
            )
        )
    }

    /// A restored durable capture arrives asynchronously. Deciding presentation from an
    /// as-yet-empty staged photo shows onboarding to a returning seller, so the decision
    /// waits for restoration to resolve and yields to a capture that survived.
    func testFirstValueOnboardingNeverPreemptsAnUnresolvedOrRestoredCapture() {
        XCTAssertFalse(
            FirstValueOnboardingPresentationPolicy.shouldPresent(
                isFirstLaunch: true,
                hasCompletedOnboarding: false,
                hasResolvedCaptureRestoration: false,
                hasRestoredCapture: false
            ),
            "Onboarding must not be presented before restoration resolves."
        )
        XCTAssertFalse(
            FirstValueOnboardingPresentationPolicy.shouldPresent(
                isFirstLaunch: true,
                hasCompletedOnboarding: false,
                hasResolvedCaptureRestoration: true,
                hasRestoredCapture: true
            ),
            "A restored capture routes to recovery, never to onboarding."
        )

        XCTAssertTrue(
            FirstValueOnboardingPresentationPolicy.awaitsCaptureRestoration(
                isFirstLaunch: true,
                hasCompletedOnboarding: false,
                hasResolvedCaptureRestoration: false
            )
        )
        XCTAssertFalse(
            FirstValueOnboardingPresentationPolicy.awaitsCaptureRestoration(
                isFirstLaunch: true,
                hasCompletedOnboarding: false,
                hasResolvedCaptureRestoration: true
            )
        )
        XCTAssertFalse(
            FirstValueOnboardingPresentationPolicy.awaitsCaptureRestoration(
                isFirstLaunch: true,
                hasCompletedOnboarding: true,
                hasResolvedCaptureRestoration: false
            ),
            "An already-onboarded seller never waits on the neutral hold."
        )
        XCTAssertFalse(
            FirstValueOnboardingPresentationPolicy.awaitsCaptureRestoration(
                isFirstLaunch: false,
                hasCompletedOnboarding: false,
                hasResolvedCaptureRestoration: false
            )
        )
    }

    /// Every terminal onboarding outcome survives relaunch as itself, not as a bare
    /// "done". Skip is not terminal: it lands on ONB-06 until the seller chooses
    /// Start scanning.
    @MainActor
    func testEveryOnboardingOutcomeReachesTheDurableCompletionSeam() throws {
        let terminalPaths: [(FirstValueOnboardingOutcome, (FirstValueOnboardingModel) -> Void)] = [
            (.completed, { model in
                for _ in FirstValueOnboardingScreen.allCases { model.continueForward() }
            }),
            (.supersededByExistingProgress, { model in model.reconcileExistingProgress() }),
        ]

        for (expected, drive) in terminalPaths {
            let suiteName = "snaplist.first-value-onboarding.tests.\(UUID().uuidString)"
            let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
            defer { defaults.removePersistentDomain(forName: suiteName) }
            let store = UserDefaultsFirstValueOnboardingCompletionStore(defaults: defaults)
            let model = FirstValueOnboardingModel(completionStore: store)

            XCTAssertNil(store.outcome)
            XCTAssertFalse(store.hasCompletedOnboarding)

            drive(model)

            XCTAssertEqual(model.outcome, expected)
            XCTAssertEqual(model.recordedOutcome, expected)

            let relaunchedStore = UserDefaultsFirstValueOnboardingCompletionStore(
                defaults: defaults
            )
            XCTAssertEqual(relaunchedStore.outcome, expected)
            XCTAssertTrue(relaunchedStore.hasCompletedOnboarding)
            XCTAssertEqual(
                relaunchedStore.outcome?.hasSeenIntroduction,
                expected != .supersededByExistingProgress
            )
        }
    }

    /// A stored value this build does not recognise must not read as an outcome — that
    /// would let a future package revision make an untaught seller look taught.
    func testUnrecognisedStoredOutcomeReadsAsNoCompletion() throws {
        let suiteName = "snaplist.first-value-onboarding.tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let key = "snaplist.first-value-onboarding.v1.outcome"
        defaults.set("completed-in-some-future-package", forKey: key)

        let store = UserDefaultsFirstValueOnboardingCompletionStore(
            defaults: defaults,
            key: key
        )

        XCTAssertNil(store.outcome)
        XCTAssertFalse(store.hasCompletedOnboarding)
    }

    @MainActor
    func testFirstValueOnboardingAdvancesInOrderAndEmitsOneCompletionSignal() {
        let store = InMemoryFirstValueOnboardingCompletionStore()
        let model = FirstValueOnboardingModel(completionStore: store)

        XCTAssertEqual(model.screen, .onb01)
        for expected in [
            FirstValueOnboardingScreen.onb02,
            .onb03,
            .onb04,
            .onb05,
            .onb06,
        ] {
            model.continueForward()
            XCTAssertEqual(model.screen, expected)
            XCTAssertNil(model.outcome)
            XCTAssertNil(store.outcome)
        }

        model.continueForward()

        XCTAssertEqual(store.outcome, .completed)
        XCTAssertEqual(model.outcome, .completed)
    }

    @MainActor
    func testFirstValueOnboardingSkipAdvancesToIncludedScreenWithoutCompleting() {
        let store = InMemoryFirstValueOnboardingCompletionStore()
        let model = FirstValueOnboardingModel(completionStore: store)

        model.skip()

        XCTAssertEqual(model.screen, .onb06)
        XCTAssertNil(store.outcome)
        XCTAssertNil(model.outcome)
    }

    @MainActor
    func testReconciledExistingProgressNeverClaimsTheSellerSawTheSixScreens() {
        let store = InMemoryFirstValueOnboardingCompletionStore()
        let model = FirstValueOnboardingModel(completionStore: store)

        model.reconcileExistingProgress()

        XCTAssertEqual(store.outcome, .supersededByExistingProgress)
        XCTAssertEqual(model.outcome?.hasSeenIntroduction, false)

        model.reconcileExistingProgress()
        XCTAssertEqual(store.outcome, .supersededByExistingProgress)
    }

    func testFirstValueDirectScanCommandRequiresLiveCompletedOnb06WithNoActiveWork() {
        XCTAssertTrue(
            FirstValueOnboardingPresentationPolicy
                .shouldRouteMountedCompletionToCanonicalScan(
                    isFirstLaunch: true,
                    outcome: .completed,
                    hasResolvedCaptureRestoration: true,
                    hasRestoredCapture: false,
                    stagedPhotoCount: 0
                )
        )

        let blockedInputs: [(Bool, FirstValueOnboardingOutcome, Bool, Bool, Int)] = [
            (true, .skipped, true, false, 0),
            (true, .supersededByExistingProgress, true, false, 0),
            (false, .completed, true, false, 0),
            (true, .completed, false, false, 0),
            (true, .completed, true, true, 0),
            (true, .completed, true, false, 1),
        ]

        for (isFirstLaunch, outcome, hasResolvedRestoration, hasRestoredCapture, stagedPhotoCount)
            in blockedInputs
        {
            XCTAssertFalse(
                FirstValueOnboardingPresentationPolicy
                    .shouldRouteMountedCompletionToCanonicalScan(
                        isFirstLaunch: isFirstLaunch,
                        outcome: outcome,
                        hasResolvedCaptureRestoration: hasResolvedRestoration,
                        hasRestoredCapture: hasRestoredCapture,
                        stagedPhotoCount: stagedPhotoCount
                    ),
                "Only a completed mounted ONB-06 with no restored or staged work may command Scan."
            )
        }
    }

    func testFirstValueHistorySuppressesOnlyRetiredIntroAndNeverClaimsActiveLegacyState() {
        let historicalOutcomes: [FirstValueOnboardingOutcome] = [
            .completed,
            .skipped,
            .supersededByExistingProgress,
        ]
        let retiredIntroStates: [OnboardingScreen] = [.launch, .promise, .allowance]
        let activeLegacyStates: [OnboardingScreen] = [
            .photoPrimer,
            .denied,
            .settingsHandoff,
            .cameraHandoff,
            .libraryHandoff,
            .captureBoundary,
        ]

        for outcome in historicalOutcomes {
            for screen in retiredIntroStates {
                XCTAssertTrue(
                    FirstValueOnboardingPresentationPolicy
                        .shouldRenderNormalShellForHistoricalOutcome(
                            isFirstLaunch: true,
                            recordedOutcome: outcome,
                            activeScreen: screen
                        ),
                    "\(outcome) suppresses only the retired intro."
                )
            }
            for screen in activeLegacyStates {
                XCTAssertFalse(
                    FirstValueOnboardingPresentationPolicy
                        .shouldRenderNormalShellForHistoricalOutcome(
                            isFirstLaunch: true,
                            recordedOutcome: outcome,
                            activeScreen: screen
                        ),
                    "\(outcome) must not replace active \(screen) work."
                )
            }
        }

        XCTAssertFalse(
            FirstValueOnboardingPresentationPolicy
                .shouldRenderNormalShellForHistoricalOutcome(
                    isFirstLaunch: true,
                    recordedOutcome: nil,
                    activeScreen: .launch
                )
        )
    }

    func testOnlyAnActiveLegacyCaptureBoundaryMayOpenTheCaptureLauncher() {
        let screens: [OnboardingScreen] = [
            .launch,
            .promise,
            .allowance,
            .photoPrimer,
            .denied,
            .cameraHandoff,
            .libraryHandoff,
            .captureBoundary,
            .settingsHandoff,
        ]

        for screen in screens {
            XCTAssertEqual(
                FirstValueOnboardingPresentationPolicy
                    .shouldRouteLegacyCaptureThroughLauncher(activeScreen: screen),
                screen == .captureBoundary,
                "Launcher ownership follows the active typed handoff, not completion history."
            )
        }
    }

    func testApprovedScoutMediaKeepsPerScreenSizingAndPulls() {
        XCTAssertEqual(
            FirstValueOnboardingScreen.allCases.map(\.scout),
            [
                .init(clip: "048-seedance-welcome-wave-safe-margin", fallback: "FirstValueScoutONB01", size: 104, leadingPull: -3),
                .init(clip: "007-seedance-magnifier-inspection", fallback: "FirstValueScoutONB02", size: 126, leadingPull: -14),
                .init(clip: "032-seedance-barcode-scan", fallback: "FirstValueScoutONB03", size: 123, leadingPull: -12),
                .init(clip: "040-seedance-recovery-safe-cue", fallback: "FirstValueScoutONB04", size: 147, leadingPull: -10),
                .init(clip: "030-seedance-box-lower-lift-hflip-candidate", fallback: "FirstValueScoutONB05", size: 122, leadingPull: -4),
                .init(clip: "042-seedance-reassurance", fallback: "FirstValueScoutONB06", size: 167, leadingPull: -14),
            ]
        )
        XCTAssertTrue(
            FirstValueOnboardingScreen.allCases.allSatisfy {
                $0.scout.size >= 56
            }
        )
    }

    func testReduceMotionSelectsEachClipsOwnStaticFallback() {
        for screen in FirstValueOnboardingScreen.allCases {
            XCTAssertEqual(
                screen.scoutMedia(reduceMotion: false),
                .acceptedWebM(resource: screen.scout.clip)
            )
            XCTAssertEqual(
                screen.scoutMedia(reduceMotion: true),
                .staticFallbackPNG(asset: screen.scout.fallback)
            )
        }
    }

    /// Normal motion is the shipping path, so it needs a seam a test can execute. This
    /// asserts the accepted WebM remains bundled as provenance and the paired native
    /// playback derivative is present, without constructing an AVPlayer.
    func testNormalMotionResolvesEachScreensAcceptedRuntimeDerivative() throws {
        // These tests are hosted by SnapList.app, so `.main` is the app bundle that
        // actually carries the accepted clips — the same lookup the view performs.
        let bundle = Bundle.main
        for screen in FirstValueOnboardingScreen.allCases {
            let rendering = screen.scoutRendering(reduceMotion: false, bundle: bundle)
            guard case .acceptedRuntimeDerivative(let sourceURL, let url) = rendering else {
                XCTFail("ONB-0\(screen.rawValue) did not select its accepted runtime derivative: \(rendering)")
                continue
            }
            XCTAssertEqual(
                sourceURL.deletingPathExtension().lastPathComponent,
                screen.scout.clip
            )
            XCTAssertEqual(
                sourceURL.pathExtension,
                FirstValueOnboardingScreen.scoutSourceResourceExtension
            )
            XCTAssertTrue(
                FileManager.default.fileExists(atPath: sourceURL.path),
                "ONB-0\(screen.rawValue) lost its accepted WebM provenance."
            )
            XCTAssertEqual(
                url.deletingPathExtension().lastPathComponent,
                screen.scout.clip
            )
            XCTAssertEqual(
                url.pathExtension,
                FirstValueOnboardingScreen.scoutRuntimeResourceExtension
            )
            XCTAssertTrue(
                FileManager.default.fileExists(atPath: url.path),
                "ONB-0\(screen.rawValue) resolved a derivative URL that is not in the bundle."
            )
        }
    }

    func testStaticRenderingAndReduceMotionBothYieldTheScreensOwnFallback() {
        let bundle = Bundle.main
        for screen in FirstValueOnboardingScreen.allCases {
            XCTAssertEqual(
                screen.scoutRendering(
                    reduceMotion: false,
                    usesStaticRendering: true,
                    bundle: bundle
                ),
                .staticFallbackPNG(asset: screen.scout.fallback)
            )
            XCTAssertEqual(
                screen.scoutRendering(reduceMotion: true, bundle: bundle),
                .staticFallbackPNG(asset: screen.scout.fallback)
            )
        }
    }

    /// A clip that cannot be resolved must degrade to that screen's own PNG rather than
    /// handing the view a URL it cannot load.
    func testUnresolvableClipDegradesToTheScreensOwnFallback() {
        let emptyBundle = Bundle(for: XCTestCase.self)
        for screen in FirstValueOnboardingScreen.allCases {
            XCTAssertEqual(
                screen.scoutRendering(reduceMotion: false, bundle: emptyBundle),
                .staticFallbackPNG(asset: screen.scout.fallback)
            )
        }
    }

    /// ONB-05 shows the approved three-row work example. The package owns those rows
    /// and does not add explanatory caption copy.
    func testBackgroundExampleKeepsTheApprovedThreeRowsWithoutExtraCaptionCopy() {
        XCTAssertEqual(FirstValueOnboardingCopy.backgroundExampleRows.count, 3)
        XCTAssertEqual(
            FirstValueOnboardingCopy.backgroundExampleRows.map(\.item),
            ["DualSense controller", "AirPods Max", "Charizard card"]
        )
        XCTAssertEqual(
            FirstValueOnboardingCopy.backgroundExampleRows.map(\.state),
            ["Writing the listing", "Checking sold prices", "Reading your voice note"]
        )
        XCTAssertEqual(
            FirstValueOnboardingCopy.backgroundExampleRows.map(\.imageName),
            ["FirstValueController", "FirstValueHeadphones", "FirstValueTradingCard"],
            "Each row carries its own asset, so a new row cannot outrun the image list."
        )
    }

    /// A seller recognizes the item onboarding is selling, or the screens are selling
    /// nothing. The desk lamp, denim jacket, and plain white sneaker went with #887, and
    /// nothing in the flow may name them again.
    func testOnboardingItemCopyNamesTheBrandedItem() {
        let strings = FirstValueOnboardingCopy.backgroundExampleRows.map(\.item)
            + FirstValueOnboardingCopy.soldComparisonRows.map(\.condition)
            + FirstValueOnboardingCopy.contextCaptions.all
            + [FirstValueOnboardingCopy.includedScoutLine,
               FirstValueOnboardingCopy.listingTitle,
               FirstValueOnboardingCopy.shortListingTitle,
               FirstValueOnboardingCopy.listingCondition,
               FirstValueOnboardingCopy.voiceNoteQuote]

        for retired in ["jacket", "lamp", "sneaker", "denim"] {
            for string in strings {
                XCTAssertFalse(
                    string.lowercased().contains(retired),
                    "\(string) still sells a \(retired)."
                )
            }
        }
    }

    /// ONB-06's reassurance ran to one long line and one short one. It also promised
    /// something onboarding cannot promise, so the wording moved with the break.
    func testIncludedScoutLineStatesTheAccountTruthWithoutTheVagueWord() {
        let line = FirstValueOnboardingCopy.includedScoutLine

        XCTAssertEqual(
            line,
            "No account needed yet. You edit before you publish."
        )
        XCTAssertFalse(line.lowercased().contains("anything"))
        XCTAssertLessThanOrEqual(
            line.count,
            52,
            "The Scout row fits about 26 characters a line. Past 52 this breaks three "
                + "ways and orphans the last word, which is what #887 asks to fix."
        )
    }

    /// The item on ONB-04 and ONB-06 is the one the seller just watched get photographed
    /// and priced, so its title and condition have to describe that same controller.
    func testDraftCopyDescribesThePhotographedController() {
        XCTAssertEqual(
            FirstValueOnboardingCopy.listingTitle,
            "Sony DualSense wireless controller, white"
        )
        XCTAssertEqual(
            FirstValueOnboardingCopy.listingCondition,
            "Good, small scuff on the left grip"
        )
    }

    /// ONB-03 used to draw one jacket photograph four times, each row separated only by
    /// its own `.scaleEffect` and `.offset`, so four sold listings were one photograph
    /// zoomed four ways. Each comp now carries the asset it shows (#887).
    func testSoldComparisonRowsShowFourSeparatePhotographs() {
        let rows = FirstValueOnboardingCopy.soldComparisonRows

        XCTAssertEqual(rows.count, 4)
        XCTAssertEqual(
            Set(rows.map(\.imageName)).count,
            4,
            "Two comps share a photograph, so the row reads as one listing repeated."
        )
    }

    /// "The whole thing" and "The details" named nothing a seller could act on, and
    /// "thing" is the word the copy contract keeps out of product strings (#887).
    func testContextCaptionsNameWhatThePhotographShows() {
        let captions = FirstValueOnboardingCopy.contextCaptions

        XCTAssertEqual(captions.whole, "Whole item")
        XCTAssertEqual(captions.flaw, "Any damage")
        XCTAssertEqual(captions.details, "Close details")
        for caption in captions.all {
            XCTAssertFalse(
                caption.lowercased().contains("thing"),
                "\(caption) still leans on \"thing\"."
            )
        }
    }

    /// The tall right-hand photo stands beside two stacked photos and their caption rows.
    /// When its height stops matching that column, the bottom caption on each side lands
    /// on a different baseline, which is what made the row look hand-placed. The heights
    /// are derived, so what this pins is the result: the grid ONB-02 actually draws is
    /// 410 points tall, and changing a photo height or the caption block has to be a
    /// deliberate edit to this number rather than a silent shift on screen.
    func testContextTallPhotoMatchesTheStackedColumnItStandsBeside() {
        let metrics = FirstValueOnboardingLayoutMetrics.self

        XCTAssertEqual(metrics.contextTallPhotoHeight, 384)
        XCTAssertEqual(metrics.contextGridHeight, 410)
        XCTAssertEqual(
            metrics.contextGridHeight,
            metrics.contextShortPhotoHeight * 2
                + metrics.contextColumnSpacing
                + metrics.contextCaptionBlockHeight * 2,
            "The tall photo's column and the stacked column no longer end together."
        )
    }

    /// An onboarding screen naming an asset the catalog does not carry draws an empty
    /// tile, which the copy assertions above cannot see. Every asset #887 introduced is
    /// checked here, not only the comps.
    func testOnboardingScreensNameBundledAssets() {
        let names = FirstValueOnboardingCopy.soldComparisonRows.map(\.imageName)
            + FirstValueOnboardingCopy.backgroundExampleRows.map(\.imageName)

        XCTAssertEqual(Set(names).count, 7)
        for name in names {
            XCTAssertNotNil(
                UIImage(named: name),
                "\(name) is not in the asset catalog."
            )
        }
    }

    @MainActor
    func testAccountlessJourneyRetainsReversibleStateAndStopsAtCaptureBoundary() {
        let model = makeModel(camera: .authorized)

        XCTAssertEqual(model.state.screen, .launch)
        model.settleLaunch()
        XCTAssertEqual(model.state.screen, .promise)

        model.startFirstItem()
        XCTAssertEqual(model.state.screen, .allowance)
        model.presentMarketplaceExplanation()
        XCTAssertEqual(model.state.overlay, .marketplace)
        model.dismissOverlay()
        XCTAssertEqual(model.state.screen, .allowance)

        model.continueFromAllowance()
        XCTAssertEqual(model.state.screen, .photoPrimer)
        model.goBack()
        XCTAssertEqual(model.state.screen, .allowance)
        model.continueFromAllowance()
        model.useCamera()

        XCTAssertEqual(model.state.screen, .cameraHandoff)
        XCTAssertEqual(model.captureEntryContext, .camera)
        model.continueToCaptureBoundary()
        XCTAssertEqual(model.state.screen, .captureBoundary)
    }

    @MainActor
    func testReturningSignInIsVoluntaryDismissibleAndRestoresPromise() {
        let model = makeModel(camera: .notDetermined)
        model.settleLaunch()

        model.presentReturningSignIn()
        XCTAssertEqual(model.state.overlay, .returningSignIn)

        model.dismissOverlay()
        XCTAssertEqual(model.state.screen, .promise)
        XCTAssertNil(model.state.overlay)
    }

    @MainActor
    func testNotDeterminedCameraRequestsTheRealCapabilityAndUsesGrantedResult() async {
        let camera = CameraAuthorizationStub(status: .notDetermined, requestResult: true)
        let model = makeModel(camera: camera)
        model.settleLaunch()
        model.startFirstItem()
        model.continueFromAllowance()

        await model.requestCameraAccess()

        XCTAssertEqual(camera.requestCount, 1)
        XCTAssertEqual(model.state.screen, .cameraHandoff)
    }

    @MainActor
    func testDeniedAndRestrictedCameraStatusesUseHonestRecoveryWithoutRequestingAgain() async {
        for status in [CameraAuthorizationStatus.denied, .restricted] {
            let camera = CameraAuthorizationStub(status: status, requestResult: true)
            let model = makeModel(camera: camera)
            model.settleLaunch()
            model.startFirstItem()
            model.continueFromAllowance()

            await model.requestCameraAccess()

            XCTAssertEqual(model.state.screen, .denied)
            XCTAssertEqual(camera.requestCount, 0)
        }
    }

    @MainActor
    func testSettingsReturnReReadsAuthorityAndNeverCounterfeitsAChange() {
        let camera = CameraAuthorizationStub(status: .denied, requestResult: false)
        let model = makeModel(camera: camera)
        model.restore(.init(screen: .denied))

        model.refreshCameraAuthorization()
        XCTAssertEqual(model.state.screen, .denied)

        camera.status = .authorized
        model.refreshCameraAuthorization()
        XCTAssertEqual(model.state.screen, .cameraHandoff)

        camera.status = .denied
        model.refreshCameraAuthorization()
        XCTAssertEqual(model.state.screen, .denied)
    }

    @MainActor
    func testRestoredCameraEntryReReadsAuthoritativeSystemPermission() {
        let store = InMemoryOnboardingProgressStore()
        let grantedCamera = CameraAuthorizationStub(status: .authorized)
        let grantedModel = makeModel(camera: grantedCamera, store: store)
        grantedModel.restore(.init(screen: .photoPrimer))
        grantedModel.useCamera()
        XCTAssertEqual(grantedModel.state.screen, .cameraHandoff)

        let revokedCamera = CameraAuthorizationStub(status: .denied)
        let deniedModel = makeModel(camera: revokedCamera, store: store)

        deniedModel.restorePersistedProgress()

        XCTAssertEqual(deniedModel.state.screen, .denied)
        XCTAssertNil(deniedModel.captureEntryContext)

        revokedCamera.status = .notDetermined
        store.save(.init(screen: .captureBoundary))
        let notDeterminedModel = makeModel(camera: revokedCamera, store: store)

        notDeterminedModel.restorePersistedProgress()

        XCTAssertEqual(notDeterminedModel.state.screen, .photoPrimer)
        XCTAssertNil(notDeterminedModel.captureEntryContext)
    }

    @MainActor
    func testCameraHandoffRechecksAuthorizationBeforeEnteringCapture() {
        let camera = CameraAuthorizationStub(status: .authorized)
        let model = makeModel(camera: camera)
        model.restore(.init(screen: .photoPrimer))
        model.useCamera()
        XCTAssertEqual(model.state.screen, .cameraHandoff)

        camera.status = .restricted
        model.continueToCaptureBoundary()

        XCTAssertEqual(model.state.screen, .denied)
        XCTAssertNil(model.captureEntryContext)
    }

    @MainActor
    func testLibrarySelectionSuccessAndCancelPreserveTheCorrectState() {
        let photos = InMemoryStagedLibraryPhotoStore()
        let model = makeModel(camera: .denied, stagedPhotos: photos)
        model.restore(.init(screen: .photoPrimer))

        model.didCancelLibrarySelection()
        XCTAssertEqual(model.state.screen, .photoPrimer)

        model.didStageLibraryPhotos([Data([0x01]), Data([0x02])])
        XCTAssertEqual(model.state.screen, .libraryHandoff)
        XCTAssertEqual(model.state.stagedPhotoCount, 2)
        XCTAssertEqual(model.captureEntryContext, .library(stagedPhotoCount: 2))
        XCTAssertEqual(try photos.load(), [Data([0x01]), Data([0x02])])
    }

    @MainActor
    func testInterruptedOnboardingRestoresLocallyStagedLibraryPhotos() {
        let store = InMemoryOnboardingProgressStore()
        let photos = InMemoryStagedLibraryPhotoStore()
        let first = makeModel(camera: .denied, store: store, stagedPhotos: photos)
        first.restore(.init(screen: .photoPrimer))
        first.didStageLibraryPhotos([Data([0x01]), Data([0x02]), Data([0x03])])
        first.persistForInterruption()

        let restored = makeModel(camera: .denied, store: store, stagedPhotos: photos)
        restored.restorePersistedProgress()

        XCTAssertEqual(restored.state.screen, .libraryHandoff)
        XCTAssertEqual(restored.state.stagedPhotoCount, 3)
        XCTAssertEqual(restored.captureEntryContext, .library(stagedPhotoCount: 3))

        restored.continueToCaptureBoundary()

        XCTAssertEqual(restored.state.screen, .captureBoundary)
        XCTAssertEqual(restored.captureEntryContext, .library(stagedPhotoCount: 3))
    }

    @MainActor
    func testMissingStagedLibraryFilesFailBackToThePhotoPrimer() {
        let store = InMemoryOnboardingProgressStore()
        store.save(.init(screen: .libraryHandoff, stagedPhotoCount: 2))
        let restored = makeModel(
            camera: .denied,
            store: store,
            stagedPhotos: InMemoryStagedLibraryPhotoStore()
        )

        restored.restorePersistedProgress()

        XCTAssertEqual(restored.state.screen, .photoPrimer)
        XCTAssertEqual(restored.state.stagedPhotoCount, 0)
        XCTAssertNil(restored.captureEntryContext)
    }

    @MainActor
    func testPhotoPrimerCanResumeFilesAfterAnInterruptedStateWrite() throws {
        let store = InMemoryOnboardingProgressStore()
        store.save(.init(screen: .photoPrimer))
        let photos = InMemoryStagedLibraryPhotoStore()
        try photos.replace(with: [Data([0x01]), Data([0x02])])
        let restored = makeModel(camera: .denied, store: store, stagedPhotos: photos)

        restored.restorePersistedProgress()

        XCTAssertEqual(restored.state.screen, .photoPrimer)
        XCTAssertEqual(restored.state.stagedPhotoCount, 2)
        XCTAssertTrue(restored.resumeStagedLibraryPhotosIfAvailable())
        XCTAssertEqual(restored.state.screen, .libraryHandoff)
        XCTAssertEqual(restored.captureEntryContext, .library(stagedPhotoCount: 2))
    }

    func testGuestAllowanceProductionSeamDoesNotClaimServerEnforcementExists() {
        let snapshot = DeferredGuestAllowanceCapability().snapshot

        XCTAssertFalse(snapshot.isServerEnforced)
        XCTAssertEqual(snapshot.ownerIssues, [174, 175])
        XCTAssertEqual(snapshot.completeAIItems, 1)
        XCTAssertEqual(snapshot.samePhotoSetGuidedCorrections, 1)
        XCTAssertTrue(snapshot.manualEditingIsUnlimited)
        XCTAssertEqual(snapshot.recoveryHours, 24)
    }

    func testFileSystemStagingIsRecoverableProtectedAndCappedAtFivePhotos() throws {
        let fileManager = FileManager.default
        let parent = fileManager.temporaryDirectory.appendingPathComponent(
            "snaplist-onboarding-photo-store-\(UUID().uuidString)",
            isDirectory: true
        )
        let directory = parent.appendingPathComponent("photos", isDirectory: true)
        defer { try? fileManager.removeItem(at: parent) }
        let store = FileSystemStagedLibraryPhotoStore(
            fileManager: fileManager,
            directoryURL: directory
        )
        let photos = (0..<5).map { Data([UInt8($0)]) }

        XCTAssertEqual(try store.replace(with: photos), 5)
        XCTAssertEqual(try store.load(), photos)

        // Even if the picker's own maxSelectionCount were bypassed, the store itself
        // still caps persistence at 5 rather than trusting the caller's input size.
        let sixPhotos = (0..<6).map { Data([UInt8($0)]) }
        XCTAssertEqual(try store.replace(with: sixPhotos), 5)
        XCTAssertEqual(try store.load(), Array(sixPhotos.prefix(5)))

        XCTAssertEqual(FileSystemStagedLibraryPhotoStore.fileProtection, .complete)
        XCTAssertTrue(
            FileSystemStagedLibraryPhotoStore.writingOptions.contains(.completeFileProtection)
        )
        XCTAssertEqual(
            try directory.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup,
            true
        )

        let replacement = [Data([0x09]), Data([0x0A])]
        XCTAssertEqual(try store.replace(with: replacement), 2)
        XCTAssertEqual(try store.load(), replacement)

        let interruptedWrite = parent.appendingPathComponent(
            ".OnboardingStagedPhotos-interrupted",
            isDirectory: true
        )
        try fileManager.createDirectory(at: interruptedWrite, withIntermediateDirectories: true)
        try Data([0xFF]).write(to: interruptedWrite.appendingPathComponent("00.photo"))
        XCTAssertEqual(try store.load(), replacement)
        XCTAssertFalse(fileManager.fileExists(atPath: interruptedWrite.path))

        store.clear()
        XCTAssertEqual(try store.load(), [])
    }

    func testExactApprovedCopyPreservesFirstValueWithoutAQuestionnaire() {
        XCTAssertEqual(
            OnboardingCopy.promiseHeadline,
            "Photograph an item. Get real comps and a listing you control."
        )
        XCTAssertEqual(
            OnboardingCopy.allowanceSupport,
            "Run one complete AI listing on this device — free, and without an account."
        )
        XCTAssertEqual(
            OnboardingCopy.guidedFixBody,
            "If the AI reads the item wrong, we'll help you correct it once. A fresh analysis, new photos, or a second item is outside the free allowance."
        )
        XCTAssertEqual(
            OnboardingCopy.recoveryBody,
            "After you get a usable result, your encrypted guest draft and photos stay recoverable for 24 hours. Claim them with an account to keep them; otherwise they're deleted."
        )
        XCTAssertFalse(OnboardingCopy.allVisibleStrings.contains { $0.localizedCaseInsensitiveContains("questionnaire") })
    }

    func testIssue206VisualStatesMapToAllElevenApprovedScreens() {
        let states = ApprovedVisualStateID.allCases.filter { $0.ownerIssue == 206 }

        XCTAssertEqual(states.count, 11)
        XCTAssertEqual(Set(states.compactMap(OnboardingScreen.init(visualState:))).count, 8)
        XCTAssertEqual(OnboardingScreen(visualState: .onboardingMarketplace), .allowance)
        XCTAssertEqual(OnboardingScreen(visualState: .returningSignIn), .promise)
    }

    func testReducedMotionUsesOpacityOnlyAndImmediateFocusRestoration() {
        XCTAssertEqual(OnboardingMotionPolicy(reduceMotion: true).transition, .opacity)
        XCTAssertEqual(OnboardingMotionPolicy(reduceMotion: false).transition, .moveAndFade)
        XCTAssertEqual(OnboardingMotionPolicy(reduceMotion: true).focusDelay, .zero)
    }

    @MainActor
    private func makeModel(
        camera: CameraAuthorizationStatus,
        store: InMemoryOnboardingProgressStore = .init(),
        stagedPhotos: InMemoryStagedLibraryPhotoStore = .init()
    ) -> OnboardingFlowModel {
        makeModel(
            camera: CameraAuthorizationStub(status: camera),
            store: store,
            stagedPhotos: stagedPhotos
        )
    }

    @MainActor
    private func makeModel(
        camera: CameraAuthorizationStub,
        store: InMemoryOnboardingProgressStore = .init(),
        stagedPhotos: InMemoryStagedLibraryPhotoStore = .init()
    ) -> OnboardingFlowModel {
        OnboardingFlowModel(
            cameraAuthorization: camera,
            progressStore: store,
            stagedLibraryPhotos: stagedPhotos,
            guestAllowance: DeferredGuestAllowanceCapability()
        )
    }

    /// The filled capsule this control draws is its whole affordance. Left on
    /// `.automatic`, iOS paints a second filled shape behind it whenever a seller has
    /// Button Shapes on, which reads as an overlay sitting on the label (#856).
    @MainActor
    func testFirstValueOnboardingContinueButtonCarriesAnExplicitNonAutomaticButtonStyle() {
        let button = FirstValueOnboardingContinueButton(isFinalScreen: false, action: {})

        let rendered = String(reflecting: type(of: button.body))

        XCTAssertTrue(
            rendered.contains("PlainButtonStyle"),
            "first-value-onboarding.continue resolves to .automatic, so Button Shapes doubles its capsule: \(rendered)"
        )
    }
}

private final class CameraAuthorizationStub: CameraAuthorizationProviding {
    var status: CameraAuthorizationStatus
    let requestResult: Bool
    private(set) var requestCount = 0

    init(status: CameraAuthorizationStatus, requestResult: Bool = false) {
        self.status = status
        self.requestResult = requestResult
    }

    func authorizationStatus() -> CameraAuthorizationStatus {
        status
    }

    func requestAccess() async -> Bool {
        requestCount += 1
        status = requestResult ? .authorized : .denied
        return requestResult
    }
}
