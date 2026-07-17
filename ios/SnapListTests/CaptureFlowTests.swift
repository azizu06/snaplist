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

    func testSuccessfulLibraryHandoffConsumesOnboardingCopiesAfterCaptureStages() async throws {
        let firstPhoto = Data([0x01, 0x02])
        let stagedLibraryPhotos = InMemoryStagedLibraryPhotoStore()
        try stagedLibraryPhotos.replace(with: [firstPhoto, Data([0x03])])
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
        XCTAssertNotNil(capture.stagedPhoto)
        XCTAssertEqual(try stagedLibraryPhotos.load(), [])
        XCTAssertEqual(onboarding.state.stagedPhotoCount, 0)
    }

    func testFailedLibraryHandoffKeepsOnboardingCopiesRecoverable() async throws {
        let photos = [Data([0x01]), Data([0x02])]
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
        let photos = [Data([0x01]), Data([0x02])]
        let initialStore = FileSystemStagedLibraryPhotoStore(
            fileManager: fileManager,
            directoryURL: onboardingRoot
        )
        let moveController = ConsumeMoveController(fileManager: fileManager)
        let stagedLibraryPhotos = FileSystemStagedLibraryPhotoStore(
            fileManager: fileManager,
            directoryURL: onboardingRoot,
            consumeMoveItem: moveController.move
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

        moveController.shouldFail = false
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
        XCTAssertEqual(try stagedLibraryPhotos.load(), [])
        XCTAssertEqual(onboarding.state.stagedPhotoCount, 0)
        XCTAssertEqual(onboarding.captureEntryContext, .camera)
        XCTAssertEqual(router.presentedSheet, .capture)
    }

    func testDiscardFailurePreservesTheDurableCaptureAndOnboardingSource() async throws {
        let photos = [Data([0x01]), Data([0x02])]
        let stagedLibraryPhotos = FailingConsumeStagedLibraryPhotoStore(photos: photos)
        let onboarding = OnboardingFlowModel(
            state: .init(screen: .libraryHandoff, stagedPhotoCount: photos.count),
            cameraAuthorization: FixtureCameraAuthorizationClient(status: .denied),
            progressStore: InMemoryOnboardingProgressStore(),
            stagedLibraryPhotos: stagedLibraryPhotos,
            guestAllowance: DeferredGuestAllowanceCapability()
        )
        onboarding.continueToCaptureBoundary()
        let captureStore = TestCaptureStore(discardError: TestCaptureError.failed)
        let capture = makeModel(store: captureStore)
        _ = await capture.restore()
        let router = AppRouter()

        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: onboarding,
            captureFlow: capture,
            router: router
        )

        let durablyStaged = try XCTUnwrap(capture.stagedPhoto)
        XCTAssertEqual(captureStore.stageCount, 1)
        XCTAssertEqual(captureStore.discardCount, 1)
        XCTAssertEqual(capture.phase, .captured)
        XCTAssertEqual(try stagedLibraryPhotos.load(), photos)
        XCTAssertEqual(onboarding.state.stagedPhotoCount, photos.count)
        XCTAssertEqual(onboarding.captureEntryContext, .library(stagedPhotoCount: photos.count))
        XCTAssertEqual(router.presentedSheet, .capture)

        let relaunchedCapture = makeModel(store: captureStore)
        let restoration = await relaunchedCapture.restore()
        XCTAssertEqual(restoration, .stagedPhoto)
        XCTAssertEqual(relaunchedCapture.stagedPhoto, durablyStaged)
        let relaunchedRouter = AppRouter()
        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: onboarding,
            captureFlow: relaunchedCapture,
            router: relaunchedRouter
        )

        XCTAssertEqual(captureStore.stageCount, 1)
        XCTAssertEqual(relaunchedCapture.stagedPhoto, durablyStaged)
        XCTAssertEqual(relaunchedRouter.presentedSheet, .capture)
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

        try stagedLibraryPhotos.replace(with: [makeLandscapeImageData()])
        let onboarding = OnboardingFlowModel(
            state: .init(screen: .libraryHandoff, stagedPhotoCount: 1),
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

        XCTAssertNotNil(initialCapture.stagedPhoto)
        XCTAssertEqual(try stagedLibraryPhotos.load(), [])
        XCTAssertFalse(fileManager.fileExists(atPath: onboardingRoot.path))
        XCTAssertEqual(onboarding.state.stagedPhotoCount, 0)
        XCTAssertEqual(onboarding.captureEntryContext, .camera)

        let relaunchedOnboarding = OnboardingFlowModel(
            cameraAuthorization: FixtureCameraAuthorizationClient(status: .authorized),
            progressStore: progressStore,
            stagedLibraryPhotos: stagedLibraryPhotos,
            guestAllowance: DeferredGuestAllowanceCapability()
        )
        relaunchedOnboarding.restorePersistedProgress()
        XCTAssertEqual(relaunchedOnboarding.state.screen, .captureBoundary)
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
        let restoration = await expiredCapture.restore()
        XCTAssertEqual(restoration, .noDraft)
        let relaunchedRouter = AppRouter()

        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: relaunchedOnboarding,
            captureFlow: expiredCapture,
            router: relaunchedRouter
        )

        XCTAssertNil(expiredCapture.stagedPhoto)
        XCTAssertEqual(expiredCapture.phase, .idle)
        XCTAssertEqual(relaunchedRouter.presentedSheet, .capture)
        XCTAssertEqual(try stagedLibraryPhotos.load(), [])
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

    private func makeLandscapeImageData() throws -> Data {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 400, height: 200))
        return try XCTUnwrap(renderer.jpegData(withCompressionQuality: 0.95) { context in
            UIColor.systemBlue.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 200, height: 200))
            UIColor.systemOrange.setFill()
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

private final class ConsumeMoveController {
    var shouldFail = true
    private let fileManager: FileManager

    init(fileManager: FileManager) {
        self.fileManager = fileManager
    }

    func move(from sourceURL: URL, to destinationURL: URL) throws {
        if shouldFail { throw TestCaptureError.failed }
        try fileManager.moveItem(at: sourceURL, to: destinationURL)
    }
}

private final class FailingConsumeStagedLibraryPhotoStore: StagedLibraryPhotoPersisting {
    private var photos: [Data]

    init(photos: [Data]) {
        self.photos = photos
    }

    func replace(with photos: [Data]) throws -> Int {
        self.photos = photos
        return photos.count
    }

    func load() throws -> [Data] { photos }
    func consume() throws { throw TestCaptureError.failed }
    func clear() { photos = [] }
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
    private let discardError: Error?

    init(
        staged: StagedCapturePhoto? = nil,
        stageError: Error? = nil,
        discardError: Error? = nil
    ) {
        self.staged = staged
        self.stageError = stageError
        self.discardError = discardError
    }

    func load() async throws -> StagedCapturePhoto? { staged }

    func stage(imageData: Data) async throws -> StagedCapturePhoto {
        stageCount += 1
        lastStagedImageData = imageData
        if let stageError { throw stageError }
        let photo = StagedCapturePhoto(
            id: UUID(),
            photoURL: URL(fileURLWithPath: "/tmp/photo.jpg"),
            thumbnailURL: URL(fileURLWithPath: "/tmp/thumb.jpg"),
            createdAt: Date()
        )
        staged = photo
        return photo
    }

    func discard() async throws {
        discardCount += 1
        if let discardError { throw discardError }
        staged = nil
    }
}
