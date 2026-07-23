import AVFoundation
import UIKit
import XCTest
@testable import SnapList

@MainActor
final class CaptureFlowTests: XCTestCase {
    func testManualShutterStaysAvailableAfterFirstCaptureWithoutAVisionVerdict() async {
        let camera = TestCaptureCamera(isAvailable: true, authorization: .authorized)
        let store = TestCaptureStore()
        let model = makeModel(camera: camera, store: store)

        await model.startCamera()

        XCTAssertTrue(model.canTakePhoto)
        await model.takePhoto()
        XCTAssertEqual(model.phase, .camera)
        XCTAssertNotNil(model.stagedPhoto)
        XCTAssertEqual(camera.stopCount, 0)
        XCTAssertTrue(model.canTakePhoto)
    }

    func testManualCaptureAppendsFivePhotosInOrderAndMakesTheSixthAttemptInert() async {
        let camera = TestCaptureCamera(isAvailable: true, authorization: .authorized)
        let store = TestCaptureStore()
        let model = makeModel(camera: camera, store: store)

        await model.startCamera()
        for _ in 0..<5 {
            XCTAssertTrue(model.canTakePhoto)
            await model.takePhoto()
        }

        XCTAssertEqual(model.stagedPhotos.map(\.id), store.stagedPhotos.map(\.id))
        XCTAssertEqual(model.stagedPhotos.count, 5)
        XCTAssertFalse(model.canTakePhoto)

        await model.takePhoto()

        XCTAssertEqual(camera.captureCount, 5)
        XCTAssertEqual(model.stagedPhotos.count, 5)
    }

    func testLibrarySelectionAppendsInOrderOnlyThroughRemainingCapacity() async {
        let camera = TestCaptureCamera(isAvailable: true, authorization: .authorized)
        let store = TestCaptureStore()
        let model = makeModel(camera: camera, store: store)
        let libraryPhotos = (1...5).map { Data([$0]) }

        await model.startCamera()
        await model.takePhoto()
        let addedCount = await model.stageLibraryPhotos(libraryPhotos)

        XCTAssertEqual(addedCount, 4)
        XCTAssertEqual(Array(store.stagedImageData.dropFirst()), Array(libraryPhotos.prefix(4)))
        XCTAssertEqual(model.stagedPhotos.count, 5)
        XCTAssertFalse(model.canTakePhoto)
    }

    func testLibraryPickerStagesEachPayloadBeforeLoadingTheNextAndKeepsPartialProgress() async {
        let tracker = LibraryPayloadLifetimeTracker()
        let store = LifetimeTrackingCaptureStore(tracker: tracker)
        let model = CaptureFlowModel(
            camera: TestCaptureCamera(isAvailable: true, authorization: .authorized),
            evaluator: TestFramingEvaluator(observations: []),
            store: store
        )
        var didReachLaterFailure = false
        let selections = [
            TestLibraryPhotoLoader { tracker.makePayload(byte: 0x01) },
            TestLibraryPhotoLoader { tracker.makePayload(byte: 0x02) },
            TestLibraryPhotoLoader {
                didReachLaterFailure = true
                XCTAssertEqual(store.stagedBytes, [0x01, 0x02])
                throw TestCaptureError.failed
            }
        ]

        let addedCount = await model.stageLibraryPhotos(selections)

        XCTAssertEqual(addedCount, 2)
        XCTAssertTrue(didReachLaterFailure)
        XCTAssertEqual(store.stagedBytes, [0x01, 0x02])
        XCTAssertEqual(model.stagedPhotos.count, 2)
        XCTAssertEqual(tracker.maximumResidentPayloads, 1)
        XCTAssertEqual(tracker.residentPayloads, 0)
        XCTAssertEqual(
            tracker.events,
            [.loaded(0x01), .staged(0x01), .released(0x01),
             .loaded(0x02), .staged(0x02), .released(0x02)]
        )
    }

    func testFifthSuccessfulAdditionPublishesTheExactLimitAnnouncementOnce() async {
        let camera = TestCaptureCamera(isAvailable: true, authorization: .authorized)
        let model = makeModel(camera: camera)

        await model.startCamera()
        for _ in 0..<5 {
            await model.takePhoto()
        }

        XCTAssertEqual(
            model.consumePhotoLimitAnnouncement(),
            "Five photo limit reached. Review your photos."
        )
        XCTAssertNil(model.consumePhotoLimitAnnouncement())

        await model.takePhoto()

        XCTAssertNil(model.consumePhotoLimitAnnouncement())
    }

    func testShutterAccessibleNameOnlyAnnouncesTheLimitAtFiveDurablePhotos() {
        let states = [
            (
                name: "below-cap idle",
                accessibility: ScanShutterAccessibility(
                    isEnabled: true,
                    durablePhotoCount: 0
                ),
                expectedLabel: "Take photo"
            ),
            (
                name: "below-cap pending intake",
                accessibility: ScanShutterAccessibility(
                    isEnabled: false,
                    durablePhotoCount: 2
                ),
                expectedLabel: "Take photo"
            ),
            (
                name: "at cap",
                accessibility: ScanShutterAccessibility(
                    isEnabled: false,
                    durablePhotoCount: 5
                ),
                expectedLabel: "Take photo, unavailable at five photo limit"
            )
        ]

        for state in states {
            XCTAssertEqual(
                state.accessibility.label,
                state.expectedLabel,
                state.name
            )
        }
    }

    func testFlashControlOnlyTogglesWhenTheCaptureDeviceSupportsIt() async {
        let supportedCamera = TestCaptureCamera(
            isAvailable: true,
            authorization: .authorized,
            isFlashAvailable: true
        )
        let supported = makeModel(camera: supportedCamera)
        await supported.startCamera()

        XCTAssertTrue(supported.isFlashAvailable)
        XCTAssertEqual(supported.flashMode, .off)
        supported.toggleFlash()
        XCTAssertEqual(supported.flashMode, .on)
        XCTAssertEqual(supportedCamera.requestedFlashModes, [.on])

        let unsupported = makeModel()
        await unsupported.startCamera()
        unsupported.toggleFlash()
        XCTAssertEqual(unsupported.flashMode, .off)
    }

    func testUnavailableAndDeniedCameraStatesOfferHonestRecovery() async {
        let unavailableCamera = TestCaptureCamera(isAvailable: false, authorization: .authorized)
        let unavailable = makeModel(camera: unavailableCamera)

        await unavailable.startCamera()
        XCTAssertEqual(unavailable.phase, .unavailable)
        XCTAssertEqual(unavailableCamera.startCount, 0)

        let deniedCamera = TestCaptureCamera(isAvailable: true, authorization: .denied)
        let denied = makeModel(camera: deniedCamera)

        await denied.startCamera()
        XCTAssertEqual(denied.phase, .denied)
        XCTAssertEqual(deniedCamera.startCount, 0)

        let restrictedCamera = TestCaptureCamera(isAvailable: true, authorization: .restricted)
        let restricted = makeModel(camera: restrictedCamera)

        await restricted.startCamera()
        XCTAssertEqual(restricted.phase, .unavailable)
        XCTAssertEqual(restrictedCamera.startCount, 0)
    }

    func testPendingCaptureRejectsConcurrentLibraryIntakeAndBoundarySnapshot() async {
        let camera = TestCaptureCamera(
            isAvailable: true,
            authorization: .authorized,
            suspendsCapture: true
        )
        let store = TestCaptureStore()
        let model = makeModel(camera: camera, store: store)

        await model.startCamera()
        for _ in 0..<4 {
            let capture = Task { await model.takePhoto() }
            let isCapturePending = await camera.waitUntilCaptureIsPending()
            XCTAssertTrue(
                isCapturePending,
                "Capture completion requires a registered pending continuation."
            )
            guard isCapturePending else { return }
            camera.completePendingCaptures()
            await capture.value
        }

        let fifthCapture = Task { await model.takePhoto() }
        let isFifthCapturePending = await camera.waitUntilCaptureIsPending()
        XCTAssertTrue(
            isFifthCapturePending,
            "Fifth-photo completion requires a registered pending continuation."
        )
        guard isFifthCapturePending else { return }

        XCTAssertTrue(model.isAddingPhotos)
        XCTAssertFalse(model.canOpenBoundary)
        let concurrentLibraryCount = await model.stageLibraryPhotos([Data([0x01])])
        XCTAssertEqual(concurrentLibraryCount, 0)

        camera.completePendingCaptures()
        await fifthCapture.value

        XCTAssertEqual(model.stagedPhotos.count, 5)
        XCTAssertEqual(store.stageCount, 5)
        XCTAssertTrue(model.canOpenBoundary)
    }

    func testPendingCaptureReadinessTimesOutWithoutRegisteredContinuation() async {
        let camera = TestCaptureCamera(
            isAvailable: true,
            authorization: .authorized,
            suspendsCapture: true
        )

        let isCapturePending = await camera.waitUntilCaptureIsPending(
            timeoutNanoseconds: 1_000_000
        )

        XCTAssertFalse(
            isCapturePending,
            "Readiness must fail within its bound when no capture continuation registers."
        )
    }

    func testCommittedAppendUsesAtomicAuthoritativeSetWithoutASecondReload() async {
        let camera = TestCaptureCamera(isAvailable: true, authorization: .authorized)
        let store = TestCaptureStore(loadPhotosError: TestCaptureError.failed)
        let model = makeModel(camera: camera, store: store)

        await model.startCamera()
        await model.takePhoto()

        XCTAssertEqual(model.stagedPhotos, store.stagedPhotos)
        XCTAssertEqual(model.stagedPhotos.count, 1)
        XCTAssertTrue(model.canOpenBoundary)
        XCTAssertEqual(store.loadPhotosCount, 0)
    }

    func testMixedFivePhotoSetCapsOnceRejectsSixthAndRoutesExactOrderThroughAppRouter() async {
        let camera = TestCaptureCamera(isAvailable: true, authorization: .authorized)
        let model = makeModel(camera: camera)
        let router = AppRouter(initialFullScreen: .guidedCamera)

        await model.startCamera()
        await model.takePhoto()
        await model.takePhoto()
        let libraryCount = await model.stageLibraryPhotos([
            Data([0x01]), Data([0x02]), Data([0x03])
        ])
        XCTAssertEqual(libraryCount, 3)
        XCTAssertEqual(
            model.consumePhotoLimitAnnouncement(),
            "Five photo limit reached. Review your photos."
        )
        XCTAssertNil(model.consumePhotoLimitAnnouncement())

        await model.takePhoto()

        XCTAssertEqual(camera.captureCount, 2)
        XCTAssertEqual(model.stagedPhotos.count, 5)
        XCTAssertNil(model.consumePhotoLimitAnnouncement())

        XCTAssertTrue(model.canOpenBoundary)
        router.openCaptureBoundary(
            destination: .photoReview,
            photos: model.stagedPhotos,
            opener: .reviewButton
        )

        XCTAssertEqual(router.captureBoundaryRequest?.photos, model.stagedPhotos)
        XCTAssertEqual(router.captureBoundaryRequest?.photos.count, 5)
        XCTAssertEqual(
            router.captureBoundaryRequest?.photos.map(\.id),
            model.stagedPhotos.map(\.id)
        )
    }

    func testRealEvaluatorOutputNeverGatesTheManualShutterAndOnePhotoStaysInCamera() async throws {
        let camera = TestCaptureCamera(isAvailable: true, authorization: .authorized)
        let evaluator = TestFramingEvaluator(
            observations: [
                FramingObservation(subjectBounds: CGRect(x: 0.42, y: 0.38, width: 0.16, height: 0.22)),
                FramingObservation(subjectBounds: CGRect(x: 0.42, y: 0.38, width: 0.16, height: 0.22)),
                FramingObservation(subjectBounds: CGRect(x: 0.18, y: 0.14, width: 0.64, height: 0.70)),
                FramingObservation(subjectBounds: CGRect(x: 0.18, y: 0.14, width: 0.64, height: 0.70))
            ]
        )
        let store = TestCaptureStore()
        let model = makeModel(camera: camera, evaluator: evaluator, store: store)

        await model.startCamera()
        XCTAssertEqual(model.phase, .camera)
        XCTAssertTrue(model.canTakePhoto)

        for _ in 0..<2 { await model.process(frame: try makeFrame()) }
        XCTAssertEqual(model.guidance, .moveCloser)
        XCTAssertTrue(model.canTakePhoto)

        for _ in 0..<2 { await model.process(frame: try makeFrame()) }
        XCTAssertEqual(model.guidance, .accepted)
        XCTAssertTrue(model.canTakePhoto)

        await model.takePhoto()
        XCTAssertEqual(model.phase, .camera)
        XCTAssertEqual(store.stageCount, 1)
        XCTAssertNotNil(model.stagedPhoto)
        XCTAssertEqual(camera.stopCount, 0)
    }

    func testRapidSecondShutterTapCannotStartAnotherCapture() async throws {
        let camera = TestCaptureCamera(
            isAvailable: true,
            authorization: .authorized,
            suspendsCapture: true
        )
        let accepted = FramingObservation(
            subjectBounds: CGRect(x: 0.18, y: 0.14, width: 0.64, height: 0.70)
        )
        let evaluator = TestFramingEvaluator(observations: [accepted, accepted])
        let store = TestCaptureStore()
        let model = makeModel(camera: camera, evaluator: evaluator, store: store)
        await model.startCamera()
        for _ in 0..<2 { await model.process(frame: try makeFrame()) }
        XCTAssertTrue(model.canTakePhoto)

        let firstCapture = Task { await model.takePhoto() }
        let isFirstCapturePending = await camera.waitUntilCaptureIsPending()
        XCTAssertTrue(isFirstCapturePending)
        guard isFirstCapturePending else { return }
        let secondCapture = Task { await model.takePhoto() }
        await secondCapture.value

        XCTAssertEqual(camera.captureCount, 1)
        XCTAssertFalse(model.canTakePhoto)
        XCTAssertTrue(model.isCapturingPhoto)
        camera.completePendingCaptures()
        await firstCapture.value
        XCTAssertEqual(store.stageCount, 1)
        XCTAssertEqual(model.phase, .camera)
        XCTAssertFalse(model.isCapturingPhoto)
        XCTAssertTrue(model.canTakePhoto)
    }

    func testCaptureLockResetsAfterAnErrorAndAllowsARealRetry() async throws {
        let camera = TestCaptureCamera(
            isAvailable: true,
            authorization: .authorized,
            captureError: TestCaptureError.failed
        )
        let accepted = FramingObservation(
            subjectBounds: CGRect(x: 0.18, y: 0.14, width: 0.64, height: 0.70)
        )
        let evaluator = TestFramingEvaluator(
            observations: [accepted, accepted, accepted, accepted]
        )
        let store = TestCaptureStore()
        let model = makeModel(camera: camera, evaluator: evaluator, store: store)

        await model.startCamera()
        for _ in 0..<2 { await model.process(frame: try makeFrame()) }
        await model.takePhoto()
        XCTAssertEqual(model.phase, .camera)
        XCTAssertFalse(model.isCapturingPhoto)
        XCTAssertEqual(store.stageCount, 0)
        XCTAssertTrue(camera.isSessionActive)
        for _ in 0..<2 { await model.process(frame: try makeFrame()) }
        XCTAssertTrue(model.canTakePhoto)
        await model.takePhoto()
        XCTAssertEqual(model.phase, .camera)
        XCTAssertFalse(model.isCapturingPhoto)
        XCTAssertEqual(camera.captureCount, 2)
        XCTAssertEqual(store.stageCount, 1)
        XCTAssertEqual(camera.stopCount, 0)
        XCTAssertTrue(camera.isSessionActive)
    }

    func testLocalStageFailureStopsCameraAndAllowsARealRetry() async throws {
        let camera = TestCaptureCamera(isAvailable: true, authorization: .authorized)
        let accepted = FramingObservation(
            subjectBounds: CGRect(x: 0.18, y: 0.14, width: 0.64, height: 0.70)
        )
        let evaluator = TestFramingEvaluator(
            observations: [accepted, accepted, accepted, accepted]
        )
        let store = TestCaptureStore(stageError: TestCaptureError.failed)
        let model = makeModel(camera: camera, evaluator: evaluator, store: store)

        await model.startCamera()
        for _ in 0..<2 { await model.process(frame: try makeFrame()) }
        await model.takePhoto()

        XCTAssertEqual(model.phase, .camera)
        XCTAssertFalse(model.isCapturingPhoto)
        XCTAssertEqual(camera.captureCount, 1)
        XCTAssertEqual(store.stageCount, 1)
        XCTAssertTrue(camera.isSessionActive)
        for _ in 0..<2 { await model.process(frame: try makeFrame()) }
        await model.takePhoto()

        XCTAssertEqual(model.phase, .camera)
        XCTAssertFalse(model.isCapturingPhoto)
        XCTAssertEqual(camera.captureCount, 2)
        XCTAssertEqual(store.stageCount, 2)
        XCTAssertEqual(camera.stopCount, 0)
        XCTAssertTrue(camera.isSessionActive)
    }

    func testCancelInvalidatesAPendingCaptureAndReleasesTheShutterLock() async throws {
        let camera = TestCaptureCamera(
            isAvailable: true,
            authorization: .authorized,
            suspendsCapture: true
        )
        let accepted = FramingObservation(
            subjectBounds: CGRect(x: 0.18, y: 0.14, width: 0.64, height: 0.70)
        )
        let evaluator = TestFramingEvaluator(
            observations: [accepted, accepted, accepted, accepted]
        )
        let store = TestCaptureStore()
        let model = makeModel(camera: camera, evaluator: evaluator, store: store)

        await model.startCamera()
        for _ in 0..<2 { await model.process(frame: try makeFrame()) }
        let pendingCapture = Task { await model.takePhoto() }
        let isCapturePending = await camera.waitUntilCaptureIsPending()
        XCTAssertTrue(isCapturePending)
        guard isCapturePending else { return }
        XCTAssertTrue(model.isCapturingPhoto)

        model.cancelCamera()
        XCTAssertEqual(model.phase, .idle)
        XCTAssertFalse(model.isCapturingPhoto)
        camera.completePendingCaptures()
        await pendingCapture.value
        XCTAssertEqual(model.phase, .idle)
        XCTAssertEqual(store.stageCount, 0)

        await model.startCamera()
        for _ in 0..<2 { await model.process(frame: try makeFrame()) }
        XCTAssertTrue(model.canTakePhoto)
    }

    func testLibraryEscapeStagesAndStopsAtReviewHandoff() async {
        let camera = TestCaptureCamera(isAvailable: false, authorization: .denied)
        let store = TestCaptureStore()
        let model = makeModel(camera: camera, store: store)

        let didStage = await model.stageLibraryPhoto(Data([0x01, 0x02]))
        XCTAssertTrue(didStage)
        XCTAssertEqual(model.phase, .captured)
        XCTAssertEqual(store.stageCount, 1)

        model.continueToReviewHandoff()
        XCTAssertEqual(model.phase, .reviewHandoff)
        XCTAssertEqual(model.handoffTitle, "Photos ready to review")
    }

    func testReviewHandoffReturnsToLiveCameraWithoutDiscardingTheStagedPhoto() async throws {
        let staged = StagedCapturePhoto(
            id: UUID(),
            photoURL: URL(fileURLWithPath: "/tmp/photo.jpg"),
            thumbnailURL: URL(fileURLWithPath: "/tmp/thumb.jpg"),
            createdAt: Date()
        )
        let camera = TestCaptureCamera(isAvailable: true, authorization: .authorized)
        let accepted = FramingObservation(
            subjectBounds: CGRect(x: 0.18, y: 0.14, width: 0.64, height: 0.70)
        )
        let store = TestCaptureStore(staged: staged)
        let model = makeModel(
            camera: camera,
            evaluator: TestFramingEvaluator(observations: [accepted, accepted]),
            store: store
        )
        let restoration = await model.restore()
        XCTAssertEqual(restoration, .stagedPhoto)
        model.continueToReviewHandoff()
        XCTAssertEqual(model.phase, .reviewHandoff)

        await model.reopenCameraFromReviewHandoff()

        XCTAssertEqual(model.phase, .camera)
        XCTAssertEqual(model.stagedPhoto, staged)
        XCTAssertEqual(camera.startCount, 1)
        XCTAssertTrue(camera.isSessionActive)

        for _ in 0..<2 { await model.process(frame: try makeFrame()) }
        XCTAssertEqual(model.guidance, .accepted)
        XCTAssertTrue(model.canTakePhoto)
        await model.takePhoto()
        let didStageLibraryAppend = await model.stageLibraryPhoto(Data([0x01, 0x02]))
        XCTAssertEqual(camera.captureCount, 1)
        XCTAssertTrue(didStageLibraryAppend)
        XCTAssertEqual(store.stageCount, 2)
        XCTAssertEqual(store.discardCount, 0)
        XCTAssertEqual(model.stagedPhoto, staged)
        XCTAssertEqual(model.stagedPhotos.count, 3)
    }

    func testBackgroundStopsAndForegroundRestartsAnActiveCamera() async {
        let camera = TestCaptureCamera(isAvailable: true, authorization: .authorized)
        let model = makeModel(camera: camera)

        await model.startCamera()
        model.handleScenePhase(.background)
        XCTAssertEqual(camera.stopCount, 1)

        await model.handleSceneBecameActive()
        XCTAssertEqual(camera.startCount, 2)
        XCTAssertEqual(model.phase, .camera)
    }

    func testForegroundRechecksDeniedCameraAfterSettingsAuthorization() async {
        let camera = TestCaptureCamera(isAvailable: true, authorization: .denied)
        let model = makeModel(camera: camera)

        await model.startCamera()
        XCTAssertEqual(model.phase, .denied)

        camera.authorization = .authorized
        await model.handleSceneBecameActive()

        XCTAssertEqual(model.phase, .camera)
        XCTAssertEqual(camera.startCount, 1)
    }

    func testForegroundKeepsDeniedCameraBlockedWithoutAuthorization() async {
        let camera = TestCaptureCamera(isAvailable: true, authorization: .denied)
        let model = makeModel(camera: camera)

        await model.startCamera()
        await model.handleSceneBecameActive()

        XCTAssertEqual(model.phase, .denied)
        XCTAssertEqual(camera.startCount, 0)
    }

    func testCancelStopsAnActiveCameraAndReturnsToTheLauncherBoundary() async {
        let camera = TestCaptureCamera(isAvailable: true, authorization: .authorized)
        let model = makeModel(camera: camera)

        await model.startCamera()
        model.cancelCamera()

        XCTAssertEqual(camera.stopCount, 1)
        XCTAssertEqual(model.phase, .idle)
    }

    func testRestoreReopensTheSingleLocallyStagedPhoto() async throws {
        let staged = StagedCapturePhoto(
            id: UUID(),
            photoURL: URL(fileURLWithPath: "/tmp/photo.jpg"),
            thumbnailURL: URL(fileURLWithPath: "/tmp/thumb.jpg"),
            createdAt: Date()
        )
        let store = TestCaptureStore(staged: staged)
        let model = makeModel(store: store)

        let restoration = await model.restore()

        XCTAssertEqual(model.phase, .captured)
        XCTAssertEqual(model.stagedPhoto, staged)
        XCTAssertEqual(restoration, .stagedPhoto)

        let router = AppRouter(initialSheet: .capture)
        router.handleCaptureRestoration(restoration)
        XCTAssertEqual(router.presentedSheet, .capture)
        XCTAssertNil(router.presentedFullScreen)
    }

    func testSuccessfulLibraryHandoffConsumesOnlyTransferredPhotoAfterCaptureStages() async throws {
        let firstPhoto = Data([0x01, 0x02])
        let secondPhoto = Data([0x03])
        let stagedLibraryPhotos = InMemoryStagedLibraryPhotoStore()
        try stagedLibraryPhotos.replace(with: [firstPhoto, secondPhoto])
        let onboarding = OnboardingFlowModel(
            state: .init(screen: .libraryHandoff, stagedPhotoCount: 2),
            cameraAuthorization: FixtureCameraAuthorizationClient(status: .denied),
            progressStore: InMemoryOnboardingProgressStore(),
            stagedLibraryPhotos: stagedLibraryPhotos,
            guestAllowance: DeferredGuestAllowanceCapability()
        )
        onboarding.continueToCaptureBoundary()

        let store = TestCaptureStore()
        let capture = makeModel(store: store)
        let restoration = await capture.restore()
        XCTAssertEqual(restoration, .noDraft)
        let router = AppRouter(initialTab: .listings)

        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: onboarding,
            captureFlow: capture,
            router: router
        )

        XCTAssertEqual(router.selectedTab, .home)
        XCTAssertEqual(router.presentedSheet, .capture)
        XCTAssertNil(router.presentedFullScreen)
        XCTAssertEqual(store.stageCount, 1)
        XCTAssertEqual(store.lastStagedImageData, firstPhoto)
        XCTAssertEqual(capture.phase, .captured)
        let stagedPhoto = try XCTUnwrap(capture.stagedPhoto)
        XCTAssertEqual(
            stagedPhoto.libraryTransferReceipt,
            LibraryPhotoTransferReceipt(
                sourcePhotoFingerprints: [firstPhoto, secondPhoto].map(
                    LocalPhotoFingerprint.digest
                ),
                sourceIndex: 0
            )
        )
        XCTAssertEqual(try stagedLibraryPhotos.load(), [secondPhoto])
        XCTAssertEqual(onboarding.state.stagedPhotoCount, 1)
        XCTAssertEqual(onboarding.captureEntryContext, .library(stagedPhotoCount: 1))
    }

    func testFailedLibraryHandoffKeepsOnboardingCopiesRecoverable() async throws {
        let photos = [Data([0x01]), Data([0x02]), Data([0x03])]
        let stagedLibraryPhotos = InMemoryStagedLibraryPhotoStore()
        try stagedLibraryPhotos.replace(with: photos)
        let onboarding = OnboardingFlowModel(
            state: .init(screen: .libraryHandoff, stagedPhotoCount: photos.count),
            cameraAuthorization: FixtureCameraAuthorizationClient(status: .denied),
            progressStore: InMemoryOnboardingProgressStore(),
            stagedLibraryPhotos: stagedLibraryPhotos,
            guestAllowance: DeferredGuestAllowanceCapability()
        )
        onboarding.continueToCaptureBoundary()

        let store = TestCaptureStore(stageError: TestCaptureError.failed)
        let capture = makeModel(store: store)
        _ = await capture.restore()
        let router = AppRouter()

        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: onboarding,
            captureFlow: capture,
            router: router
        )

        XCTAssertEqual(capture.phase, .failed)
        XCTAssertNil(capture.stagedPhoto)
        XCTAssertEqual(try stagedLibraryPhotos.load(), photos)
        XCTAssertEqual(onboarding.state.stagedPhotoCount, photos.count)
        XCTAssertEqual(router.presentedSheet, .capture)
    }

    func testSourceConsumeFailureRollsBackCaptureAndKeepsADeterministicRetry() async throws {
        let fileManager = FileManager.default
        let parent = fileManager.temporaryDirectory.appendingPathComponent(
            "snaplist-library-consume-failure-\(UUID().uuidString)",
            isDirectory: true
        )
        let onboardingRoot = parent.appendingPathComponent("Onboarding", isDirectory: true)
        let photos = [Data([0x01]), Data([0x02]), Data([0x03])]
        let initialStore = FileSystemStagedLibraryPhotoStore(
            fileManager: fileManager,
            directoryURL: onboardingRoot
        )
        let replaceController = ConsumeReplaceController(fileManager: fileManager)
        let stagedLibraryPhotos = FileSystemStagedLibraryPhotoStore(
            fileManager: fileManager,
            directoryURL: onboardingRoot,
            consumeReplaceItem: replaceController.replace
        )
        defer { try? fileManager.removeItem(at: parent) }

        try initialStore.replace(with: photos)
        let onboarding = OnboardingFlowModel(
            state: .init(screen: .libraryHandoff, stagedPhotoCount: photos.count),
            cameraAuthorization: FixtureCameraAuthorizationClient(status: .denied),
            progressStore: InMemoryOnboardingProgressStore(),
            stagedLibraryPhotos: stagedLibraryPhotos,
            guestAllowance: DeferredGuestAllowanceCapability()
        )
        onboarding.continueToCaptureBoundary()
        let captureStore = TestCaptureStore()
        let capture = makeModel(store: captureStore)
        _ = await capture.restore()
        let router = AppRouter()

        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: onboarding,
            captureFlow: capture,
            router: router
        )

        XCTAssertEqual(captureStore.stageCount, 1)
        XCTAssertEqual(captureStore.discardCount, 1)
        XCTAssertNil(capture.stagedPhoto)
        XCTAssertEqual(capture.phase, .failed)
        XCTAssertEqual(try stagedLibraryPhotos.load(), photos)
        XCTAssertEqual(onboarding.state.stagedPhotoCount, photos.count)
        XCTAssertEqual(onboarding.captureEntryContext, .library(stagedPhotoCount: photos.count))
        XCTAssertEqual(router.presentedSheet, .capture)

        replaceController.shouldFail = false
        router.presentedSheet = nil
        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: onboarding,
            captureFlow: capture,
            router: router
        )

        XCTAssertEqual(captureStore.stageCount, 2)
        XCTAssertEqual(captureStore.discardCount, 1)
        XCTAssertNotNil(capture.stagedPhoto)
        XCTAssertEqual(capture.phase, .captured)
        XCTAssertEqual(try stagedLibraryPhotos.load(), Array(photos.dropFirst()))
        XCTAssertEqual(onboarding.state.stagedPhotoCount, 2)
        XCTAssertEqual(onboarding.captureEntryContext, .library(stagedPhotoCount: 2))
        XCTAssertEqual(router.presentedSheet, .capture)
    }

    func testSinglePhotoConsumeMoveFailureSurvivesRelaunchRetryAndExactExpiry() async throws {
        let fileManager = FileManager.default
        let parent = fileManager.temporaryDirectory.appendingPathComponent(
            "snaplist-library-single-consume-failure-\(UUID().uuidString)",
            isDirectory: true
        )
        let onboardingRoot = parent.appendingPathComponent("Onboarding", isDirectory: true)
        let captureRoot = parent.appendingPathComponent("Capture", isDirectory: true)
        let createdAt = Date(timeIntervalSinceReferenceDate: 1_000_000)
        let progressStore = InMemoryOnboardingProgressStore()
        let consumeController = ConsumeMoveController(fileManager: fileManager)
        let stagedLibraryPhotos = FileSystemStagedLibraryPhotoStore(
            fileManager: fileManager,
            directoryURL: onboardingRoot,
            consumeMoveItem: consumeController.move
        )
        defer { try? fileManager.removeItem(at: parent) }

        let sourcePhoto = try makeLandscapeImageData()
        try stagedLibraryPhotos.replace(with: [sourcePhoto])
        let onboarding = OnboardingFlowModel(
            state: .init(screen: .libraryHandoff, stagedPhotoCount: 1),
            cameraAuthorization: FixtureCameraAuthorizationClient(status: .authorized),
            progressStore: progressStore,
            stagedLibraryPhotos: stagedLibraryPhotos,
            guestAllowance: DeferredGuestAllowanceCapability()
        )
        onboarding.continueToCaptureBoundary()
        let capture = CaptureFlowModel(
            camera: TestCaptureCamera(isAvailable: true, authorization: .authorized),
            evaluator: TestFramingEvaluator(observations: []),
            store: LocalCaptureDraftStore(rootDirectory: captureRoot, now: { createdAt })
        )
        _ = await capture.restore()

        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: onboarding,
            captureFlow: capture,
            router: AppRouter()
        )

        XCTAssertEqual(capture.phase, .failed)
        XCTAssertNil(capture.stagedPhoto)
        XCTAssertEqual(try stagedLibraryPhotos.load(), [sourcePhoto])
        XCTAssertEqual(onboarding.state.stagedPhotoCount, 1)
        XCTAssertEqual(onboarding.captureEntryContext, .library(stagedPhotoCount: 1))

        consumeController.shouldFail = false
        let relaunchedOnboarding = OnboardingFlowModel(
            cameraAuthorization: FixtureCameraAuthorizationClient(status: .authorized),
            progressStore: progressStore,
            stagedLibraryPhotos: stagedLibraryPhotos,
            guestAllowance: DeferredGuestAllowanceCapability()
        )
        relaunchedOnboarding.restorePersistedProgress()
        let relaunchedCapture = CaptureFlowModel(
            camera: TestCaptureCamera(isAvailable: true, authorization: .authorized),
            evaluator: TestFramingEvaluator(observations: []),
            store: LocalCaptureDraftStore(rootDirectory: captureRoot, now: { createdAt })
        )
        let relaunchedRestoration = await relaunchedCapture.restore()
        XCTAssertEqual(relaunchedRestoration, .noDraft)

        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: relaunchedOnboarding,
            captureFlow: relaunchedCapture,
            router: AppRouter()
        )

        let durablyStaged = try XCTUnwrap(relaunchedCapture.stagedPhoto)
        XCTAssertEqual(
            durablyStaged.libraryTransferReceipt?.fingerprint,
            LocalPhotoFingerprint.digest(of: sourcePhoto)
        )
        XCTAssertEqual(try stagedLibraryPhotos.load(), [])
        XCTAssertEqual(relaunchedOnboarding.state.stagedPhotoCount, 0)
        XCTAssertEqual(relaunchedOnboarding.captureEntryContext, .camera)

        let expiredCapture = CaptureFlowModel(
            camera: TestCaptureCamera(isAvailable: true, authorization: .authorized),
            evaluator: TestFramingEvaluator(observations: []),
            store: LocalCaptureDraftStore(
                rootDirectory: captureRoot,
                now: { createdAt.addingTimeInterval(LocalCaptureDraftStore.recoveryWindow) }
            )
        )
        let expiredRestoration = await expiredCapture.restore()
        XCTAssertEqual(expiredRestoration, .noDraft)
        let expiredOnboarding = OnboardingFlowModel(
            cameraAuthorization: FixtureCameraAuthorizationClient(status: .authorized),
            progressStore: progressStore,
            stagedLibraryPhotos: stagedLibraryPhotos,
            guestAllowance: DeferredGuestAllowanceCapability()
        )
        expiredOnboarding.restorePersistedProgress()

        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: expiredOnboarding,
            captureFlow: expiredCapture,
            router: AppRouter()
        )

        XCTAssertNil(expiredCapture.stagedPhoto)
        XCTAssertEqual(expiredCapture.phase, .idle)
        XCTAssertEqual(try stagedLibraryPhotos.load(), [])
        XCTAssertEqual(expiredOnboarding.state.stagedPhotoCount, 0)
        XCTAssertEqual(expiredOnboarding.captureEntryContext, .camera)
    }

    func testLibraryStageRejectsMismatchedBytesAndMutatedReceiptIndexBeforeWriting() async throws {
        let fileManager = FileManager.default
        let parent = fileManager.temporaryDirectory.appendingPathComponent(
            "snaplist-library-receipt-binding-\(UUID().uuidString)",
            isDirectory: true
        )
        let onboardingRoot = parent.appendingPathComponent("Onboarding", isDirectory: true)
        let captureRoot = parent.appendingPathComponent("Capture", isDirectory: true)
        defer { try? fileManager.removeItem(at: parent) }

        let photos = try [
            makeLandscapeImageData(leftColor: .systemBlue, rightColor: .systemOrange),
            makeLandscapeImageData(leftColor: .systemGreen, rightColor: .systemPurple)
        ]
        let sourceStore = FileSystemStagedLibraryPhotoStore(
            fileManager: fileManager,
            directoryURL: onboardingRoot
        )
        try sourceStore.replace(with: photos)
        let fingerprints = photos.map(LocalPhotoFingerprint.digest)
        let receipt = LibraryPhotoTransferReceipt(
            sourcePhotoFingerprints: fingerprints,
            sourceIndex: 0
        )
        let captureStore = LocalCaptureDraftStore(
            rootDirectory: captureRoot,
            fileManager: fileManager
        )
        let modelStore = TestCaptureStore()
        let captureModel = makeModel(store: modelStore)

        let didStageMismatchedPhoto = await captureModel.stageLibraryPhoto(
            photos[1],
            transferReceipt: receipt
        )
        XCTAssertFalse(didStageMismatchedPhoto)
        XCTAssertEqual(modelStore.stageCount, 0)
        XCTAssertEqual(captureModel.phase, .failed)

        do {
            _ = try await captureStore.stage(
                imageData: photos[1],
                libraryTransferReceipt: receipt
            )
            XCTFail("Mismatched bytes must not stage")
        } catch CaptureDraftStoreError.transferReceiptMismatch {
            // Expected: validation happens before any capture artifact is written.
        }

        let mutatedIndexReceipt = LibraryPhotoTransferReceipt(
            sourcePhotoFingerprints: fingerprints,
            sourceIndex: 1,
            transferredDigest: fingerprints[0]
        )
        do {
            _ = try await captureStore.stage(
                imageData: photos[0],
                libraryTransferReceipt: mutatedIndexReceipt
            )
            XCTFail("A digest bound to a different source index must not stage")
        } catch CaptureDraftStoreError.transferReceiptMismatch {
            // Expected.
        }

        XCTAssertFalse(fileManager.fileExists(atPath: captureRoot.path))
        XCTAssertEqual(try sourceStore.load(), photos)
    }

    func testPersistedMismatchTombstoneBlocksTransferredPhotoAcrossRelaunchAndExpiry() async throws {
        let fileManager = FileManager.default
        let parent = fileManager.temporaryDirectory.appendingPathComponent(
            "snaplist-library-mismatch-recovery-\(UUID().uuidString)",
            isDirectory: true
        )
        let onboardingRoot = parent.appendingPathComponent("Onboarding", isDirectory: true)
        let captureRoot = parent.appendingPathComponent("Capture", isDirectory: true)
        let createdAt = Date(timeIntervalSinceReferenceDate: 1_000_000)
        let progressStore = InMemoryOnboardingProgressStore()
        let replaceController = ConsumeReplaceController(fileManager: fileManager)
        let initialSourceStore = FileSystemStagedLibraryPhotoStore(
            fileManager: fileManager,
            directoryURL: onboardingRoot
        )
        let stagedLibraryPhotos = FileSystemStagedLibraryPhotoStore(
            fileManager: fileManager,
            directoryURL: onboardingRoot,
            consumeReplaceItem: replaceController.replace
        )
        defer { try? fileManager.removeItem(at: parent) }

        let photos = try [
            makeLandscapeImageData(leftColor: .systemBlue, rightColor: .systemOrange),
            makeLandscapeImageData(leftColor: .systemGreen, rightColor: .systemPurple),
            makeLandscapeImageData(leftColor: .systemRed, rightColor: .systemYellow)
        ]
        // B disappears after the transfer was authorized but before source cleanup.
        try initialSourceStore.replace(with: [photos[0], photos[2]])
        let originalReceipt = LibraryPhotoTransferReceipt(
            sourcePhotoFingerprints: photos.map(LocalPhotoFingerprint.digest),
            sourceIndex: 0
        )
        let initialState = OnboardingFlowState(screen: .captureBoundary, stagedPhotoCount: 2)
        progressStore.save(initialState)
        let onboarding = OnboardingFlowModel(
            state: initialState,
            cameraAuthorization: FixtureCameraAuthorizationClient(status: .authorized),
            progressStore: progressStore,
            stagedLibraryPhotos: stagedLibraryPhotos,
            guestAllowance: DeferredGuestAllowanceCapability()
        )
        let captureStore = LocalCaptureDraftStore(
            rootDirectory: captureRoot,
            fileManager: fileManager,
            now: { createdAt }
        )
        _ = try await captureStore.stage(
            imageData: photos[0],
            libraryTransferReceipt: originalReceipt
        )
        let capture = CaptureFlowModel(
            camera: TestCaptureCamera(isAvailable: true, authorization: .authorized),
            evaluator: TestFramingEvaluator(observations: []),
            store: captureStore
        )
        let initialRestoration = await capture.restore()
        XCTAssertEqual(initialRestoration, .stagedPhoto)

        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: onboarding,
            captureFlow: capture,
            router: AppRouter()
        )

        XCTAssertEqual(capture.phase, .captured)
        XCTAssertEqual(capture.stagedPhoto?.libraryTransferReceipt, originalReceipt)
        XCTAssertEqual(onboarding.state.stagedPhotoCount, 2)
        XCTAssertTrue(
            fileManager.fileExists(
                atPath: onboardingRoot.appendingPathComponent(".cleanup-needed.json").path
            )
        )

        let relaunchedOnboarding = OnboardingFlowModel(
            cameraAuthorization: FixtureCameraAuthorizationClient(status: .authorized),
            progressStore: progressStore,
            stagedLibraryPhotos: stagedLibraryPhotos,
            guestAllowance: DeferredGuestAllowanceCapability()
        )
        relaunchedOnboarding.restorePersistedProgress()
        XCTAssertEqual(relaunchedOnboarding.state, initialState)
        let relaunchedCapture = CaptureFlowModel(
            camera: TestCaptureCamera(isAvailable: true, authorization: .authorized),
            evaluator: TestFramingEvaluator(observations: []),
            store: LocalCaptureDraftStore(
                rootDirectory: captureRoot,
                fileManager: fileManager,
                now: { createdAt }
            )
        )
        let relaunchedRestoration = await relaunchedCapture.restore()
        XCTAssertEqual(relaunchedRestoration, .stagedPhoto)
        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: relaunchedOnboarding,
            captureFlow: relaunchedCapture,
            router: AppRouter()
        )
        XCTAssertEqual(relaunchedCapture.stagedPhoto?.libraryTransferReceipt, originalReceipt)

        let expiredCapture = CaptureFlowModel(
            camera: TestCaptureCamera(isAvailable: true, authorization: .authorized),
            evaluator: TestFramingEvaluator(observations: []),
            store: LocalCaptureDraftStore(
                rootDirectory: captureRoot,
                fileManager: fileManager,
                now: { createdAt.addingTimeInterval(LocalCaptureDraftStore.recoveryWindow) }
            )
        )
        let expiredRestoration = await expiredCapture.restore()
        XCTAssertEqual(expiredRestoration, .noDraft)
        let stillBlockedOnboarding = OnboardingFlowModel(
            cameraAuthorization: FixtureCameraAuthorizationClient(status: .authorized),
            progressStore: progressStore,
            stagedLibraryPhotos: stagedLibraryPhotos,
            guestAllowance: DeferredGuestAllowanceCapability()
        )
        stillBlockedOnboarding.restorePersistedProgress()
        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: stillBlockedOnboarding,
            captureFlow: expiredCapture,
            router: AppRouter()
        )
        XCTAssertNil(expiredCapture.stagedPhoto)
        XCTAssertEqual(stillBlockedOnboarding.state, initialState)

        replaceController.shouldFail = false
        let recoveredOnboarding = OnboardingFlowModel(
            cameraAuthorization: FixtureCameraAuthorizationClient(status: .authorized),
            progressStore: progressStore,
            stagedLibraryPhotos: stagedLibraryPhotos,
            guestAllowance: DeferredGuestAllowanceCapability()
        )
        recoveredOnboarding.restorePersistedProgress()
        XCTAssertEqual(try stagedLibraryPhotos.load(), [photos[2]])
        XCTAssertEqual(recoveredOnboarding.state.stagedPhotoCount, 1)
        XCTAssertFalse(
            fileManager.fileExists(
                atPath: onboardingRoot.appendingPathComponent(".cleanup-needed.json").path
            )
        )

        let recoveredCapture = CaptureFlowModel(
            camera: TestCaptureCamera(isAvailable: true, authorization: .authorized),
            evaluator: TestFramingEvaluator(observations: []),
            store: LocalCaptureDraftStore(
                rootDirectory: captureRoot,
                fileManager: fileManager,
                now: { createdAt.addingTimeInterval(LocalCaptureDraftStore.recoveryWindow) }
            )
        )
        _ = await recoveredCapture.restore()
        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: recoveredOnboarding,
            captureFlow: recoveredCapture,
            router: AppRouter()
        )
        XCTAssertEqual(
            recoveredCapture.stagedPhoto?.libraryTransferReceipt?.transferredDigest,
            LocalPhotoFingerprint.digest(of: photos[2])
        )
        XCTAssertNotEqual(
            recoveredCapture.stagedPhoto?.libraryTransferReceipt?.transferredDigest,
            LocalPhotoFingerprint.digest(of: photos[0])
        )
        XCTAssertEqual(try stagedLibraryPhotos.load(), [])
        XCTAssertEqual(recoveredOnboarding.state.stagedPhotoCount, 0)
    }

    func testDiscardFailureReconcilesTheRestoredCaptureBeforeExpiry() async throws {
        let fileManager = FileManager.default
        let parent = fileManager.temporaryDirectory.appendingPathComponent(
            "snaplist-library-discard-failure-\(UUID().uuidString)",
            isDirectory: true
        )
        let onboardingRoot = parent.appendingPathComponent("Onboarding", isDirectory: true)
        let captureRoot = parent.appendingPathComponent("Capture", isDirectory: true)
        let createdAt = Date(timeIntervalSinceReferenceDate: 1_000_000)
        let progressStore = InMemoryOnboardingProgressStore()
        let consumeController = ConsumeReplaceController(fileManager: fileManager)
        let discardController = DiscardRootController()
        let initialLibraryStore = FileSystemStagedLibraryPhotoStore(
            fileManager: fileManager,
            directoryURL: onboardingRoot
        )
        let stagedLibraryPhotos = FileSystemStagedLibraryPhotoStore(
            fileManager: fileManager,
            directoryURL: onboardingRoot,
            consumeReplaceItem: consumeController.replace
        )
        defer { try? fileManager.removeItem(at: parent) }

        let photos = try [
            makeLandscapeImageData(leftColor: .systemBlue, rightColor: .systemOrange),
            makeLandscapeImageData(leftColor: .systemGreen, rightColor: .systemPurple),
            makeLandscapeImageData(leftColor: .systemRed, rightColor: .systemYellow),
            makeLandscapeImageData(leftColor: .systemTeal, rightColor: .systemPink)
        ]
        try initialLibraryStore.replace(with: photos)
        let onboarding = OnboardingFlowModel(
            state: .init(screen: .libraryHandoff, stagedPhotoCount: photos.count),
            cameraAuthorization: FixtureCameraAuthorizationClient(status: .denied),
            progressStore: progressStore,
            stagedLibraryPhotos: stagedLibraryPhotos,
            guestAllowance: DeferredGuestAllowanceCapability()
        )
        onboarding.continueToCaptureBoundary()
        let capture = CaptureFlowModel(
            camera: TestCaptureCamera(isAvailable: true, authorization: .authorized),
            evaluator: TestFramingEvaluator(observations: []),
            store: LocalCaptureDraftStore(
                rootDirectory: captureRoot,
                discardRoot: discardController.discard,
                now: { createdAt }
            )
        )
        _ = await capture.restore()
        let router = AppRouter()

        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: onboarding,
            captureFlow: capture,
            router: router
        )

        let durablyStaged = try XCTUnwrap(capture.stagedPhoto)
        XCTAssertEqual(
            durablyStaged.libraryTransferReceipt?.fingerprint,
            LocalPhotoFingerprint.digest(of: photos[0])
        )
        XCTAssertEqual(discardController.discardCount, 1)
        XCTAssertEqual(capture.phase, .captured)
        XCTAssertEqual(try stagedLibraryPhotos.load(), photos)
        XCTAssertEqual(onboarding.state.stagedPhotoCount, 4)
        XCTAssertEqual(onboarding.captureEntryContext, .library(stagedPhotoCount: 4))
        XCTAssertEqual(router.presentedSheet, .capture)

        consumeController.shouldFail = false
        let relaunchedCapture = CaptureFlowModel(
            camera: TestCaptureCamera(isAvailable: true, authorization: .authorized),
            evaluator: TestFramingEvaluator(observations: []),
            store: LocalCaptureDraftStore(rootDirectory: captureRoot, now: { createdAt })
        )
        let restoration = await relaunchedCapture.restore()
        XCTAssertEqual(restoration, .stagedPhoto)
        XCTAssertEqual(relaunchedCapture.stagedPhoto, durablyStaged)
        let relaunchedRouter = AppRouter()
        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: onboarding,
            captureFlow: relaunchedCapture,
            router: relaunchedRouter
        )

        XCTAssertEqual(relaunchedCapture.stagedPhoto, durablyStaged)
        XCTAssertEqual(try stagedLibraryPhotos.load(), Array(photos.dropFirst()))
        XCTAssertEqual(onboarding.state.stagedPhotoCount, 3)
        XCTAssertEqual(onboarding.captureEntryContext, .library(stagedPhotoCount: 3))
        XCTAssertEqual(relaunchedRouter.presentedSheet, .capture)

        relaunchedRouter.presentedSheet = nil
        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: onboarding,
            captureFlow: relaunchedCapture,
            router: relaunchedRouter
        )

        XCTAssertEqual(relaunchedCapture.stagedPhoto, durablyStaged)
        XCTAssertEqual(try stagedLibraryPhotos.load(), Array(photos.dropFirst()))
        XCTAssertEqual(onboarding.state.stagedPhotoCount, 3)

        let expiredCapture = CaptureFlowModel(
            camera: TestCaptureCamera(isAvailable: true, authorization: .authorized),
            evaluator: TestFramingEvaluator(observations: []),
            store: LocalCaptureDraftStore(
                rootDirectory: captureRoot,
                now: { createdAt.addingTimeInterval(LocalCaptureDraftStore.recoveryWindow) }
            )
        )
        let expiredRestoration = await expiredCapture.restore()
        XCTAssertEqual(expiredRestoration, .noDraft)
        let restoredOnboarding = OnboardingFlowModel(
            cameraAuthorization: FixtureCameraAuthorizationClient(status: .authorized),
            progressStore: progressStore,
            stagedLibraryPhotos: stagedLibraryPhotos,
            guestAllowance: DeferredGuestAllowanceCapability()
        )
        restoredOnboarding.restorePersistedProgress()
        let expiredRouter = AppRouter()
        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: restoredOnboarding,
            captureFlow: expiredCapture,
            router: expiredRouter
        )

        let nextStagedPhoto = try XCTUnwrap(expiredCapture.stagedPhoto)
        XCTAssertEqual(
            nextStagedPhoto.libraryTransferReceipt?.fingerprint,
            LocalPhotoFingerprint.digest(of: photos[1])
        )
        XCTAssertNotEqual(
            nextStagedPhoto.libraryTransferReceipt?.fingerprint,
            LocalPhotoFingerprint.digest(of: photos[0])
        )
        XCTAssertEqual(restoredOnboarding.state.stagedPhotoCount, 2)
        XCTAssertEqual(restoredOnboarding.captureEntryContext, .library(stagedPhotoCount: 2))
        XCTAssertEqual(try stagedLibraryPhotos.load(), Array(photos.dropFirst(2)))
        XCTAssertEqual(expiredRouter.presentedSheet, .capture)
    }

    func testExpiredTransferredLibraryPhotoCannotRestageAfterRelaunch() async throws {
        let fileManager = FileManager.default
        let parent = fileManager.temporaryDirectory.appendingPathComponent(
            "snaplist-library-transfer-\(UUID().uuidString)",
            isDirectory: true
        )
        let onboardingRoot = parent.appendingPathComponent("Onboarding", isDirectory: true)
        let captureRoot = parent.appendingPathComponent("Capture", isDirectory: true)
        let createdAt = Date(timeIntervalSinceReferenceDate: 1_000_000)
        let progressStore = InMemoryOnboardingProgressStore()
        let stagedLibraryPhotos = FileSystemStagedLibraryPhotoStore(
            fileManager: fileManager,
            directoryURL: onboardingRoot
        )
        defer { try? fileManager.removeItem(at: parent) }

        let photos = try [
            makeLandscapeImageData(leftColor: .systemBlue, rightColor: .systemOrange),
            makeLandscapeImageData(leftColor: .systemGreen, rightColor: .systemPurple),
            makeLandscapeImageData(leftColor: .systemRed, rightColor: .systemYellow),
            makeLandscapeImageData(leftColor: .systemTeal, rightColor: .systemPink)
        ]
        try stagedLibraryPhotos.replace(with: photos)
        let onboarding = OnboardingFlowModel(
            state: .init(screen: .libraryHandoff, stagedPhotoCount: photos.count),
            cameraAuthorization: FixtureCameraAuthorizationClient(status: .authorized),
            progressStore: progressStore,
            stagedLibraryPhotos: stagedLibraryPhotos,
            guestAllowance: DeferredGuestAllowanceCapability()
        )
        onboarding.continueToCaptureBoundary()
        let initialCapture = CaptureFlowModel(
            camera: TestCaptureCamera(isAvailable: true, authorization: .authorized),
            evaluator: TestFramingEvaluator(observations: []),
            store: LocalCaptureDraftStore(rootDirectory: captureRoot, now: { createdAt })
        )
        _ = await initialCapture.restore()

        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: onboarding,
            captureFlow: initialCapture,
            router: AppRouter()
        )

        let initialStagedPhoto = try XCTUnwrap(initialCapture.stagedPhoto)
        XCTAssertEqual(
            initialStagedPhoto.libraryTransferReceipt?.fingerprint,
            LocalPhotoFingerprint.digest(of: photos[0])
        )
        XCTAssertEqual(try stagedLibraryPhotos.load(), Array(photos.dropFirst()))
        XCTAssertEqual(onboarding.state.stagedPhotoCount, 3)
        XCTAssertEqual(onboarding.captureEntryContext, .library(stagedPhotoCount: 3))

        let relaunchedOnboarding = OnboardingFlowModel(
            cameraAuthorization: FixtureCameraAuthorizationClient(status: .authorized),
            progressStore: progressStore,
            stagedLibraryPhotos: stagedLibraryPhotos,
            guestAllowance: DeferredGuestAllowanceCapability()
        )
        relaunchedOnboarding.restorePersistedProgress()
        XCTAssertEqual(relaunchedOnboarding.state.screen, .captureBoundary)
        XCTAssertEqual(relaunchedOnboarding.state.stagedPhotoCount, 3)
        XCTAssertEqual(
            relaunchedOnboarding.captureEntryContext,
            .library(stagedPhotoCount: 3)
        )

        let restoredCapture = CaptureFlowModel(
            camera: TestCaptureCamera(isAvailable: true, authorization: .authorized),
            evaluator: TestFramingEvaluator(observations: []),
            store: LocalCaptureDraftStore(rootDirectory: captureRoot, now: { createdAt })
        )
        let restoredCaptureResult = await restoredCapture.restore()
        XCTAssertEqual(restoredCaptureResult, .stagedPhoto)
        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: relaunchedOnboarding,
            captureFlow: restoredCapture,
            router: AppRouter()
        )
        XCTAssertEqual(restoredCapture.stagedPhoto, initialStagedPhoto)
        XCTAssertEqual(try stagedLibraryPhotos.load(), Array(photos.dropFirst()))
        XCTAssertEqual(relaunchedOnboarding.state.stagedPhotoCount, 3)

        let expiredCapture = CaptureFlowModel(
            camera: TestCaptureCamera(isAvailable: true, authorization: .authorized),
            evaluator: TestFramingEvaluator(observations: []),
            store: LocalCaptureDraftStore(
                rootDirectory: captureRoot,
                now: { createdAt.addingTimeInterval(LocalCaptureDraftStore.recoveryWindow) }
            )
        )
        let restoration = await expiredCapture.restore()
        XCTAssertEqual(restoration, .noDraft)
        let relaunchedRouter = AppRouter()

        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: relaunchedOnboarding,
            captureFlow: expiredCapture,
            router: relaunchedRouter
        )

        let nextStagedPhoto = try XCTUnwrap(expiredCapture.stagedPhoto)
        XCTAssertEqual(expiredCapture.phase, .captured)
        XCTAssertEqual(
            nextStagedPhoto.libraryTransferReceipt?.fingerprint,
            LocalPhotoFingerprint.digest(of: photos[1])
        )
        XCTAssertNotEqual(
            nextStagedPhoto.libraryTransferReceipt?.fingerprint,
            LocalPhotoFingerprint.digest(of: photos[0])
        )
        XCTAssertEqual(relaunchedRouter.presentedSheet, .capture)
        XCTAssertEqual(try stagedLibraryPhotos.load(), Array(photos.dropFirst(2)))
        XCTAssertEqual(relaunchedOnboarding.state.stagedPhotoCount, 2)
    }

    func testDuplicatePhotoBytesAreConsumedExactlyOnceByTheSameReceipt() throws {
        let duplicate = Data([0x01, 0x02])
        let finalPhoto = Data([0x03])
        let store = InMemoryStagedLibraryPhotoStore()
        try store.replace(with: [duplicate, duplicate, finalPhoto])
        let receipt = LibraryPhotoTransferReceipt(
            sourcePhotoFingerprints: [duplicate, duplicate, finalPhoto].map(
                LocalPhotoFingerprint.digest
            ),
            sourceIndex: 0
        )

        XCTAssertEqual(
            try store.consume(transferReceipt: receipt),
            .consumed(remainingCount: 2)
        )
        XCTAssertEqual(try store.load(), [duplicate, finalPhoto])

        XCTAssertEqual(
            try store.consume(transferReceipt: receipt),
            .consumed(remainingCount: 2)
        )
        XCTAssertEqual(try store.load(), [duplicate, finalPhoto])
    }

    func testReceiptMismatchRecordsCleanupAndRemovesOnlyTheTransferredPhoto() throws {
        let photos = [Data([0x01]), Data([0x02]), Data([0x03])]
        let receipt = LibraryPhotoTransferReceipt(
            sourcePhotoFingerprints: photos.map(LocalPhotoFingerprint.digest),
            sourceIndex: 0
        )
        let store = InMemoryStagedLibraryPhotoStore()
        try store.replace(with: [photos[0], photos[2]])

        XCTAssertEqual(try store.consume(transferReceipt: receipt), .cleanupNeeded)
        XCTAssertEqual(try store.load(), [photos[2]])
        XCTAssertEqual(
            try store.consume(transferReceipt: receipt),
            .consumed(remainingCount: 1)
        )
        XCTAssertEqual(try store.load(), [photos[2]])
    }

    func testRestoredCaptureDraftWinsOverOnboardingLibraryHandoff() async throws {
        let stagedLibraryPhotos = InMemoryStagedLibraryPhotoStore()
        try stagedLibraryPhotos.replace(with: [Data([0x01]), Data([0x02])])
        let onboarding = OnboardingFlowModel(
            state: .init(screen: .libraryHandoff, stagedPhotoCount: 2),
            cameraAuthorization: FixtureCameraAuthorizationClient(status: .denied),
            progressStore: InMemoryOnboardingProgressStore(),
            stagedLibraryPhotos: stagedLibraryPhotos,
            guestAllowance: DeferredGuestAllowanceCapability()
        )
        onboarding.continueToCaptureBoundary()

        let restoredPhoto = StagedCapturePhoto(
            id: UUID(),
            photoURL: URL(fileURLWithPath: "/tmp/restored-photo.jpg"),
            thumbnailURL: URL(fileURLWithPath: "/tmp/restored-thumb.jpg"),
            createdAt: Date()
        )
        let store = TestCaptureStore(staged: restoredPhoto)
        let capture = makeModel(store: store)
        let restoration = await capture.restore()
        XCTAssertEqual(restoration, .stagedPhoto)
        let router = AppRouter()

        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: onboarding,
            captureFlow: capture,
            router: router
        )

        XCTAssertEqual(router.presentedSheet, .capture)
        XCTAssertEqual(store.stageCount, 0)
        XCTAssertNil(store.lastStagedImageData)
        XCTAssertEqual(capture.stagedPhoto, restoredPhoto)
        XCTAssertEqual(try stagedLibraryPhotos.load(), [Data([0x01]), Data([0x02])])
        XCTAssertEqual(onboarding.state.stagedPhotoCount, 2)
    }

    private func makeModel(
        camera: TestCaptureCamera = TestCaptureCamera(
            isAvailable: true,
            authorization: .authorized
        ),
        evaluator: TestFramingEvaluator = TestFramingEvaluator(observations: []),
        store: TestCaptureStore = TestCaptureStore()
    ) -> CaptureFlowModel {
        CaptureFlowModel(camera: camera, evaluator: evaluator, store: store)
    }

    private func makeFrame() throws -> CaptureFrame {
        var buffer: CVPixelBuffer?
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            2,
            2,
            kCVPixelFormatType_32BGRA,
            nil,
            &buffer
        )
        XCTAssertEqual(status, kCVReturnSuccess)
        return CaptureFrame(pixelBuffer: try XCTUnwrap(buffer), orientation: .up)
    }

    private func makeLandscapeImageData(
        leftColor: UIColor = .systemBlue,
        rightColor: UIColor = .systemOrange
    ) throws -> Data {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 400, height: 200))
        return try XCTUnwrap(renderer.jpegData(withCompressionQuality: 0.95) { context in
            leftColor.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 200, height: 200))
            rightColor.setFill()
            context.fill(CGRect(x: 200, y: 0, width: 200, height: 200))
        })
    }
}

private final class TestCaptureCamera: CaptureCamera {
    let session = AVCaptureSession()
    let isAvailable: Bool
    let isFlashAvailable: Bool
    var authorization: CaptureCameraAuthorization
    var startCount = 0
    var stopCount = 0
    var captureCount = 0
    var requestedFlashModes: [CaptureFlashMode] = []
    private(set) var isSessionActive = false
    var frameHandler: ((CaptureFrame) -> Void)?
    private let suspendsCapture: Bool
    private var captureError: Error?
    private let pendingCaptureLock = NSLock()
    private var pendingCaptures: [CheckedContinuation<Data, Error>] = []
    private var pendingCaptureWaiters: [CheckedContinuation<Bool, Never>] = []

    init(
        isAvailable: Bool,
        authorization: CaptureCameraAuthorization,
        isFlashAvailable: Bool = false,
        suspendsCapture: Bool = false,
        captureError: Error? = nil
    ) {
        self.isAvailable = isAvailable
        self.isFlashAvailable = isFlashAvailable
        self.authorization = authorization
        self.suspendsCapture = suspendsCapture
        self.captureError = captureError
    }

    func authorizationStatus() -> CaptureCameraAuthorization { authorization }
    func requestAuthorization() async -> CaptureCameraAuthorization { authorization }

    func start(frameHandler: @escaping (CaptureFrame) -> Void) async throws {
        startCount += 1
        isSessionActive = true
        self.frameHandler = frameHandler
    }

    func stop() {
        stopCount += 1
        isSessionActive = false
    }

    func setFlashMode(_ mode: CaptureFlashMode) {
        requestedFlashModes.append(mode)
    }

    func capturePhoto() async throws -> Data {
        captureCount += 1
        if let captureError {
            self.captureError = nil
            throw captureError
        }
        guard suspendsCapture else { return Self.photoData }
        return try await withCheckedThrowingContinuation { continuation in
            pendingCaptureLock.lock()
            pendingCaptures.append(continuation)
            let waiters = pendingCaptureWaiters
            pendingCaptureWaiters.removeAll()
            pendingCaptureLock.unlock()
            for waiter in waiters {
                waiter.resume(returning: true)
            }
        }
    }

    func waitUntilCaptureIsPending(
        timeoutNanoseconds: UInt64 = 5_000_000_000
    ) async -> Bool {
        await withCheckedContinuation { continuation in
            pendingCaptureLock.lock()
            guard pendingCaptures.isEmpty else {
                pendingCaptureLock.unlock()
                continuation.resume(returning: true)
                return
            }
            pendingCaptureLock.unlock()
            Task<Void, Never> {
                try? await Task.sleep(nanoseconds: timeoutNanoseconds)
                continuation.resume(returning: true)
            }
        }
    }

    func completePendingCaptures() {
        pendingCaptureLock.lock()
        let captures = pendingCaptures
        pendingCaptures.removeAll()
        pendingCaptureLock.unlock()
        for capture in captures {
            capture.resume(returning: Self.photoData)
        }
    }

    private static let photoData = Data([0xFF, 0xD8, 0xFF, 0xD9])
}

private enum TestCaptureError: Error {
    case failed
}

private final class ConsumeReplaceController {
    var shouldFail = true
    private let fileManager: FileManager

    init(fileManager: FileManager) {
        self.fileManager = fileManager
    }

    func replace(originalURL: URL, replacementURL: URL) throws {
        if shouldFail { throw TestCaptureError.failed }
        _ = try fileManager.replaceItemAt(originalURL, withItemAt: replacementURL)
    }
}

private final class ConsumeMoveController {
    var shouldFail = true
    private let fileManager: FileManager

    init(fileManager: FileManager) {
        self.fileManager = fileManager
    }

    func move(sourceURL: URL, destinationURL: URL) throws {
        if shouldFail { throw TestCaptureError.failed }
        try fileManager.moveItem(at: sourceURL, to: destinationURL)
    }
}

private final class DiscardRootController: @unchecked Sendable {
    private(set) var discardCount = 0

    func discard(_ url: URL) throws {
        discardCount += 1
        throw TestCaptureError.failed
    }
}

private actor TestFramingEvaluator: FramingEvaluating {
    private var observations: [FramingObservation]

    init(observations: [FramingObservation]) {
        self.observations = observations
    }

    func evaluate(frame: CaptureFrame) async throws -> FramingObservation {
        observations.isEmpty ? .noSubject : observations.removeFirst()
    }
}

private struct TestLibraryPhotoLoader: CaptureLibraryPhotoLoading {
    let load: @MainActor () async throws -> Data?

    init(load: @escaping @MainActor () async throws -> Data?) {
        self.load = load
    }

    func loadPhotoData() async throws -> Data? {
        try await load()
    }
}

private enum LibraryPayloadEvent: Equatable {
    case loaded(UInt8)
    case staged(UInt8)
    case released(UInt8)
}

private final class LibraryPayloadLifetimeTracker: @unchecked Sendable {
    private let lock = NSLock()
    private var residentCount = 0
    private var maximumResidentCount = 0
    private var recordedEvents: [LibraryPayloadEvent] = []

    var residentPayloads: Int {
        lock.withLock { residentCount }
    }

    var maximumResidentPayloads: Int {
        lock.withLock { maximumResidentCount }
    }

    var events: [LibraryPayloadEvent] {
        lock.withLock { recordedEvents }
    }

    func makePayload(byte: UInt8, size: Int = 2 * 1_024 * 1_024) -> Data {
        let pointer = UnsafeMutableRawPointer.allocate(
            byteCount: size,
            alignment: MemoryLayout<UInt8>.alignment
        )
        pointer.initializeMemory(as: UInt8.self, repeating: byte, count: size)
        lock.withLock {
            residentCount += 1
            maximumResidentCount = max(maximumResidentCount, residentCount)
            recordedEvents.append(.loaded(byte))
        }
        return Data(
            bytesNoCopy: pointer,
            count: size,
            deallocator: .custom { [self] pointer, _ in
                pointer.deallocate()
                lock.withLock {
                    residentCount -= 1
                    recordedEvents.append(.released(byte))
                }
            }
        )
    }

    func recordStage(byte: UInt8) {
        lock.withLock { recordedEvents.append(.staged(byte)) }
    }
}

private final class LifetimeTrackingCaptureStore: CaptureDraftStoring {
    private let tracker: LibraryPayloadLifetimeTracker
    private(set) var stagedPhotos: [StagedCapturePhoto] = []
    private(set) var stagedBytes: [UInt8] = []

    init(tracker: LibraryPayloadLifetimeTracker) {
        self.tracker = tracker
    }

    func load() async throws -> StagedCapturePhoto? { stagedPhotos.first }
    func loadPhotos() async throws -> [StagedCapturePhoto] { stagedPhotos }

    func stage(
        imageData: Data,
        libraryTransferReceipt: LibraryPhotoTransferReceipt?
    ) async throws -> StagedCapturePhoto {
        stagedPhotos = []
        stagedBytes = []
        return try await append(
            imageData: imageData,
            libraryTransferReceipt: libraryTransferReceipt
        ).appendedPhoto
    }

    func append(
        imageData: Data,
        libraryTransferReceipt: LibraryPhotoTransferReceipt?
    ) async throws -> CaptureDraftAppendResult {
        let byte = try XCTUnwrap(imageData.first)
        tracker.recordStage(byte: byte)
        stagedBytes.append(byte)
        let index = stagedPhotos.count
        let photo = StagedCapturePhoto(
            id: UUID(),
            photoURL: URL(fileURLWithPath: "/tmp/lifetime-photo-\(index).jpg"),
            thumbnailURL: URL(fileURLWithPath: "/tmp/lifetime-thumb-\(index).jpg"),
            createdAt: Date(),
            libraryTransferReceipt: libraryTransferReceipt
        )
        stagedPhotos.append(photo)
        return CaptureDraftAppendResult(appendedPhoto: photo, photos: stagedPhotos)
    }

    func discard() async throws {
        stagedPhotos = []
        stagedBytes = []
    }
}

private final class TestCaptureStore: CaptureDraftStoring {
    var stagedPhotos: [StagedCapturePhoto]
    var staged: StagedCapturePhoto? { stagedPhotos.first }
    var stageCount = 0
    var discardCount = 0
    var lastStagedImageData: Data?
    var stagedImageData: [Data] = []
    var loadPhotosCount = 0
    private var stageError: Error?
    private let loadPhotosError: Error?

    init(
        staged: StagedCapturePhoto? = nil,
        stageError: Error? = nil,
        loadPhotosError: Error? = nil
    ) {
        stagedPhotos = staged.map { [$0] } ?? []
        self.stageError = stageError
        self.loadPhotosError = loadPhotosError
    }

    func load() async throws -> StagedCapturePhoto? { staged }
    func loadPhotos() async throws -> [StagedCapturePhoto] {
        loadPhotosCount += 1
        if let loadPhotosError { throw loadPhotosError }
        return stagedPhotos
    }

    func stage(
        imageData: Data,
        libraryTransferReceipt: LibraryPhotoTransferReceipt?
    ) async throws -> StagedCapturePhoto {
        stageCount += 1
        lastStagedImageData = imageData
        stagedImageData = [imageData]
        if let stageError {
            self.stageError = nil
            throw stageError
        }
        let photo = StagedCapturePhoto(
            id: UUID(),
            photoURL: URL(fileURLWithPath: "/tmp/photo.jpg"),
            thumbnailURL: URL(fileURLWithPath: "/tmp/thumb.jpg"),
            createdAt: Date(),
            libraryTransferReceipt: libraryTransferReceipt
        )
        stagedPhotos = [photo]
        return photo
    }

    func append(
        imageData: Data,
        libraryTransferReceipt: LibraryPhotoTransferReceipt?
    ) async throws -> CaptureDraftAppendResult {
        stageCount += 1
        lastStagedImageData = imageData
        stagedImageData.append(imageData)
        if let stageError {
            self.stageError = nil
            throw stageError
        }
        let index = stagedPhotos.count
        let photo = StagedCapturePhoto(
            id: UUID(),
            photoURL: URL(fileURLWithPath: "/tmp/photo-\(index).jpg"),
            thumbnailURL: URL(fileURLWithPath: "/tmp/thumb-\(index).jpg"),
            createdAt: Date(),
            libraryTransferReceipt: libraryTransferReceipt
        )
        stagedPhotos.append(photo)
        return CaptureDraftAppendResult(appendedPhoto: photo, photos: stagedPhotos)
    }

    func discard() async throws {
        discardCount += 1
        stagedPhotos = []
    }
}
