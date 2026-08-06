import XCTest
@testable import SnapList

final class OnboardingFlowTests: XCTestCase {
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
