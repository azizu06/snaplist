import AVFoundation
import UIKit
import XCTest
@testable import SnapList

@MainActor
final class CaptureFlowTests: XCTestCase {
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
    }

    func testRealEvaluatorOutputControlsShutterAndStagesOnePhoto() async throws {
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
        XCTAssertFalse(model.canTakePhoto)

        for _ in 0..<2 { await model.process(frame: try makeFrame()) }
        XCTAssertEqual(model.guidance, .moveCloser)
        XCTAssertFalse(model.canTakePhoto)

        for _ in 0..<2 { await model.process(frame: try makeFrame()) }
        XCTAssertEqual(model.guidance, .accepted)
        XCTAssertTrue(model.canTakePhoto)

        await model.takePhoto()
        XCTAssertEqual(model.phase, .captured)
        XCTAssertEqual(store.stageCount, 1)
        XCTAssertNotNil(model.stagedPhoto)
        XCTAssertEqual(camera.stopCount, 1)
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
        await Task.yield()
        let secondCapture = Task { await model.takePhoto() }
        for _ in 0..<4 { await Task.yield() }

        XCTAssertEqual(camera.captureCount, 1)
        XCTAssertFalse(model.canTakePhoto)
        XCTAssertTrue(model.isCapturingPhoto)
        camera.completePendingCaptures()
        await firstCapture.value
        await secondCapture.value
        XCTAssertEqual(store.stageCount, 1)
        XCTAssertEqual(model.phase, .captured)
        XCTAssertFalse(model.isCapturingPhoto)
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
        XCTAssertEqual(model.phase, .failed)
        XCTAssertFalse(model.isCapturingPhoto)
        XCTAssertEqual(store.stageCount, 0)

        await model.startCamera()
        for _ in 0..<2 { await model.process(frame: try makeFrame()) }
        XCTAssertTrue(model.canTakePhoto)
        await model.takePhoto()
        XCTAssertEqual(model.phase, .captured)
        XCTAssertFalse(model.isCapturingPhoto)
        XCTAssertEqual(camera.captureCount, 2)
        XCTAssertEqual(store.stageCount, 1)
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
        for _ in 0..<4 { await Task.yield() }
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
    var authorization: CaptureCameraAuthorization
    var startCount = 0
    var stopCount = 0
    var captureCount = 0
    var frameHandler: ((CaptureFrame) -> Void)?
    private let suspendsCapture: Bool
    private var captureError: Error?
    private var pendingCaptures: [CheckedContinuation<Data, Error>] = []

    init(
        isAvailable: Bool,
        authorization: CaptureCameraAuthorization,
        suspendsCapture: Bool = false,
        captureError: Error? = nil
    ) {
        self.isAvailable = isAvailable
        self.authorization = authorization
        self.suspendsCapture = suspendsCapture
        self.captureError = captureError
    }

    func authorizationStatus() -> CaptureCameraAuthorization { authorization }
    func requestAuthorization() async -> CaptureCameraAuthorization { authorization }

    func start(frameHandler: @escaping (CaptureFrame) -> Void) async throws {
        startCount += 1
        self.frameHandler = frameHandler
    }

    func stop() {
        stopCount += 1
    }

    func capturePhoto() async throws -> Data {
        captureCount += 1
        if let captureError {
            self.captureError = nil
            throw captureError
        }
        guard suspendsCapture else { return Self.photoData }
        return try await withCheckedThrowingContinuation { continuation in
            pendingCaptures.append(continuation)
        }
    }

    func completePendingCaptures() {
        let captures = pendingCaptures
        pendingCaptures.removeAll()
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

private final class TestCaptureStore: CaptureDraftStoring {
    var staged: StagedCapturePhoto?
    var stageCount = 0
    var discardCount = 0
    var lastStagedImageData: Data?
    private let stageError: Error?

    init(
        staged: StagedCapturePhoto? = nil,
        stageError: Error? = nil
    ) {
        self.staged = staged
        self.stageError = stageError
    }

    func load() async throws -> StagedCapturePhoto? { staged }

    func stage(
        imageData: Data,
        libraryTransferReceipt: LibraryPhotoTransferReceipt?
    ) async throws -> StagedCapturePhoto {
        stageCount += 1
        lastStagedImageData = imageData
        if let stageError { throw stageError }
        let photo = StagedCapturePhoto(
            id: UUID(),
            photoURL: URL(fileURLWithPath: "/tmp/photo.jpg"),
            thumbnailURL: URL(fileURLWithPath: "/tmp/thumb.jpg"),
            createdAt: Date(),
            libraryTransferReceipt: libraryTransferReceipt
        )
        staged = photo
        return photo
    }

    func discard() async throws {
        discardCount += 1
        staged = nil
    }
}
