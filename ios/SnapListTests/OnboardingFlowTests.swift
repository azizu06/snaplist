import Foundation
import UIKit
import XCTest
@testable import SnapList

final class OnboardingFlowTests: XCTestCase {
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
                forSessionError: MobileAPIClientError.httpStatus(401)
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

    /// The completion contract #566 consumes: every terminal outcome survives relaunch
    /// as itself, not as a bare "done".
    @MainActor
    func testEveryOnboardingOutcomeReachesTheDurableCompletionSeam() throws {
        let terminalPaths: [(FirstValueOnboardingOutcome, (FirstValueOnboardingModel) -> Void)] = [
            (.completed, { model in
                for _ in FirstValueOnboardingScreen.allCases { model.continueForward() }
            }),
            (.skipped, { model in model.skip() }),
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
    func testFirstValueOnboardingSkipMarksCompleteAndEmitsSkipSignal() {
        let store = InMemoryFirstValueOnboardingCompletionStore()
        let model = FirstValueOnboardingModel(completionStore: store)

        model.skip()

        XCTAssertEqual(store.outcome, .skipped)
        XCTAssertEqual(model.outcome, .skipped)
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

    @MainActor
    func testFirstValueCompletionReplacesOnlyTheLegacyIntroBeforePhotoPermission() {
        let model = makeModel(camera: .notDetermined)

        model.beginPhotoPermissionAfterFirstValueOnboarding()

        XCTAssertEqual(model.state.screen, .photoPrimer)

        model.restore(.init(screen: .denied))
        model.beginPhotoPermissionAfterFirstValueOnboarding()

        XCTAssertEqual(model.state.screen, .denied)
    }

    func testApprovedScoutMediaKeepsPerScreenSizingAndPulls() {
        XCTAssertEqual(
            FirstValueOnboardingScreen.allCases.map(\.scout),
            [
                .init(clip: "048-seedance-welcome-wave-safe-margin", fallback: "FirstValueScoutONB01", size: 116, leadingPull: -10),
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
    /// asserts the accepted clip is both selected *and* present in the bundle, without
    /// constructing the WebKit-backed view.
    func testNormalMotionResolvesEachScreensAcceptedWebMInTheBundle() throws {
        // These tests are hosted by SnapList.app, so `.main` is the app bundle that
        // actually carries the accepted clips — the same lookup the view performs.
        let bundle = Bundle.main
        for screen in FirstValueOnboardingScreen.allCases {
            let rendering = screen.scoutRendering(reduceMotion: false, bundle: bundle)
            guard case .acceptedWebM(let url) = rendering else {
                XCTFail("ONB-0\(screen.rawValue) did not select its accepted WebM: \(rendering)")
                continue
            }
            XCTAssertEqual(
                url.deletingPathExtension().lastPathComponent,
                screen.scout.clip
            )
            XCTAssertEqual(url.pathExtension, FirstValueOnboardingScreen.scoutResourceExtension)
            XCTAssertTrue(
                FileManager.default.fileExists(atPath: url.path),
                "ONB-0\(screen.rawValue) resolved a clip URL that is not in the bundle."
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

    /// ONB-05 shows what the Trophy Wall looks like while items finish, but no item
    /// exists during onboarding. The screen must say so and must not carry a progress
    /// affordance that claims work is happening now.
    func testBackgroundExampleIsLabelledAnIllustrationNotLiveWork() {
        XCTAssertEqual(
            FirstValueOnboardingCopy.backgroundExampleCaption,
            "An example — nothing is running yet"
        )
        XCTAssertEqual(FirstValueOnboardingCopy.backgroundExampleRows.count, 3)
        XCTAssertEqual(
            FirstValueOnboardingCopy.backgroundExampleRows.map(\.item),
            ["Denim trucker jacket", "Desk lamp", "White sneakers"]
        )
        XCTAssertEqual(
            FirstValueOnboardingCopy.backgroundExampleRows.map(\.state),
            ["Writing the listing", "Checking sold prices", "Reading your voice note"]
        )
        XCTAssertEqual(
            FirstValueOnboardingCopy.backgroundExampleRows.map(\.imageName),
            ["FirstValueJacket", "FirstValueLamp", "FirstValueSneaker"],
            "Each row carries its own asset, so a new row cannot outrun the image list."
        )
    }

    /// The XCUI counterpart cannot carry this. Each row ends in
    /// `.accessibilityElement(children: .combine)`, which folds every descendant into a
    /// single element, so a restored `ProgressView` never reaches the accessibility tree
    /// and `app.progressIndicators.count == 0` stays true whether or not the spinner is
    /// there. SwiftUI derives `body`'s concrete type from the subtree written in it, so
    /// read that instead.
    ///
    /// This reaches exactly one revert: a progress affordance written **directly** in the
    /// row's own body, which is where the deleted one lived. One reached through a nested
    /// `View` type or an `AnyView` stays hidden behind that type's name, so this is a
    /// tripwire on the row, not a proof about the whole screen.
    ///
    /// The rendered type does not vary with the row's data — the three rows differ only in
    /// the strings they carry — so one row proves it for all of them.
    @MainActor
    func testBackgroundExampleRowBodyWritesNoProgressAffordance() throws {
        let row = try XCTUnwrap(FirstValueOnboardingCopy.backgroundExampleRows.first)
        let renderedType = String(
            reflecting: type(of: BackgroundExampleRowView(row: row).body)
        )

        // `ProgressViewStyle` is deliberately absent: every type naming it also names
        // `ProgressView`, so asserting it separately could never fail on its own.
        for affordance in ["ProgressView", "Gauge"] {
            XCTAssertFalse(
                renderedType.contains(affordance),
                """
                An ONB-05 example row writes a \(affordance). Nothing is running while \
                onboarding is on screen, so the row must claim no progress: \(renderedType)
                """
            )
        }
    }

    /// The Scout clip allocates its `WKWebView` through the Objective-C runtime, and the
    /// ownership there balances two references that ARC and the `init` family each think
    /// they own. An extra retain would not crash — it would strand one `WKWebView` and its
    /// WebContent process per screen transition, six times over the flow — so assert the
    /// balance directly: the view must deallocate once the last strong reference drops.
    ///
    /// The drop is observed after a bounded run-loop wait rather than synchronously,
    /// because on iOS a `WKWebView`'s last release lands one main-run-loop turn after the
    /// local `autoreleasepool` drains — WebKit autoreleases into the pool `CFRunLoop` keeps
    /// around each iteration, which is the pool *outside* this method. An immediate
    /// `XCTAssertNil` therefore reports "still alive" for a view whose ownership is
    /// provably balanced: a plain `WKWebView(frame:configuration:)` fails it exactly as the
    /// runtime-allocated one does. The wait removes that false failure and nothing else.
    @MainActor
    func testScoutClipWebViewLeavesNoUnbalancedRetain() throws {
        weak var firstObserved: AnyObject?
        weak var secondObserved: AnyObject?

        try autoreleasepool {
            guard let first = WebKitRuntime.makeConfiguredWebView(),
                  let second = WebKitRuntime.makeConfiguredWebView() else {
                throw XCTSkip("WebKit is unavailable in this runner.")
            }
            XCTAssertFalse(first === second)
            firstObserved = first
            secondObserved = second
        }

        assertDeallocates(firstObserved)
        assertDeallocates(secondObserved)
    }

    /// Spins the main run loop until `reference` clears, and fails if it never does.
    ///
    /// The budget bounds the wait; it is not a timing tolerance to widen when this gets
    /// noisy. Deallocation is the thing under test, and the two outcomes are not close
    /// together: a balanced view clears on the first turn, while one held by a single extra
    /// retain never clears — it exhausts any budget and fails. Raising the number cannot
    /// turn that failure green, so a red here is always a real unbalanced retain.
    @MainActor
    private func assertDeallocates(
        _ reference: @autoclosure () -> AnyObject?,
        within budget: TimeInterval = 5,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let deadline = Date().addingTimeInterval(budget)
        while reference() != nil, Date() < deadline {
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.02))
        }

        XCTAssertNil(
            reference(),
            "The Scout clip web view outlived its last strong reference.",
            file: file,
            line: line
        )
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

    func testFileSystemStagingIsRecoverableProtectedAndCappedAtFourPhotos() throws {
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

        XCTAssertEqual(try store.replace(with: photos), 4)
        XCTAssertEqual(try store.load(), Array(photos.prefix(4)))

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
