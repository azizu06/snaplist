import AVFoundation
import CoreMedia
import Foundation
import ImageIO
import SwiftUI
import UIKit
import Vision

enum AVFoundationCaptureError: Error {
    case cameraUnavailable
    case configurationFailed
    case captureFailed
}

/// Whether Scan's capture session has to be pushed back into running, and the
/// standing intent that answer depends on.
///
/// The intent lives beside the session rather than inside one camera object
/// because the preview attach and teardown that have to consult it are reached
/// statically from `CameraPreviewView`, which SwiftUI calls with no camera in
/// hand.
///
/// Every entry point runs on `AVFoundationCaptureCamera.sessionQueue`, the one
/// queue every session mutation in the app already runs on, so the intent and
/// the session state it describes can never be read a step apart.
enum CaptureSessionResumption {
    /// What has to happen to a session to put it back in the state the app
    /// asked for.
    enum Action: Equatable {
        /// The session is already where the app wants it, or the app does not
        /// want it running, or the system still holds the camera, or a preview
        /// is being bound and nothing may touch the session until it is done.
        case none
        /// Start a session that is not running.
        case start
        /// Stop and start a session that reports itself running but has not
        /// been proven to have survived an interruption.
        case restart
    }

    private final class Intent {
        var wantsToRun = false
        var hasUnrecoveredInterruption = false
        /// Preview bindings in flight. Leaving and re-entering the live
        /// surface overlaps a detach and an attach, so the claim has to nest:
        /// a single flag would let the detach's release hand the session back
        /// to `resume` while the attach's `setSession:` is still queued for the
        /// main thread, which is the running-session graph rebuild the binding
        /// exists to prevent.
        var previewBindings = 0
        var isBindingPreview: Bool { previewBindings > 0 }
        var lastAction: Action = .none
        var onResume: (() -> Void)?
    }

    /// Keys are weak, so an intent dies with the session it describes.
    ///
    /// Every read and write of this table, and of the `Intent` it hands back,
    /// is confined to `AVFoundationCaptureCamera.sessionQueue` — the same
    /// serial queue every session mutation runs on. `NSMapTable` is not
    /// synchronised, so a caller reaching this state from anywhere else is a
    /// data race, not merely a stale read.
    private static let intents =
        NSMapTable<AVCaptureSession, Intent>.weakToStrongObjects()

    private static func intent(for session: AVCaptureSession) -> Intent {
        if let existing = intents.object(forKey: session) {
            return existing
        }
        let created = Intent()
        intents.setObject(created, forKey: session)
        return created
    }

    static func setWantsToRun(_ wantsToRun: Bool, for session: AVCaptureSession) {
        let intent = intent(for: session)
        intent.wantsToRun = wantsToRun
        if !wantsToRun {
            // A session the app has deliberately stopped has nothing left to
            // recover from.
            intent.hasUnrecoveredInterruption = false
        }
    }

    static func recordInterruption(for session: AVCaptureSession) {
        intent(for: session).hasUnrecoveredInterruption = true
    }

    static func hasUnrecoveredInterruption(_ session: AVCaptureSession) -> Bool {
        intent(for: session).hasUnrecoveredInterruption
    }

    /// Work the session's owner needs done after any resumption, wherever that
    /// resumption was triggered from. A preview attach and a preview teardown
    /// both resume without a camera in hand, so this is what keeps the hardware
    /// the camera cares about pointed the same way on every path.
    static func setResumeHandler(
        _ handler: @escaping () -> Void,
        for session: AVCaptureSession
    ) {
        intent(for: session).onResume = handler
    }

    /// The last action `resume` took on `session`. It is the only receipt of a
    /// resumption a simulator can show, where no camera device exists and a
    /// session never reports itself running whatever it is told to do.
    static func lastAction(for session: AVCaptureSession) -> Action {
        intent(for: session).lastAction
    }

    /// Claims the session for a preview binding, stopping it first, and reports
    /// whether the binding may proceed.
    ///
    /// Assigning `AVCaptureVideoPreviewLayer.session` runs its own
    /// `beginConfiguration`/`commitConfiguration` pair. Against a running
    /// session that commit rebuilds and restarts the capture graph
    /// synchronously on the assigning thread, which is why four main-thread
    /// hangs on the owner's phone came in through `makeUIView` →
    /// `setSession:` → `_buildAndRunGraph` (Sentry SNAPLIST-K). Worse, a stop
    /// arriving on the session queue while that configuration is in flight is
    /// exactly the illegal call AVFoundation refuses, which is the fatal
    /// `NSGenericException` out of `stopRunning` inside the preview detach
    /// (Sentry SNAPLIST-M).
    ///
    /// So a binding stops the session first and holds every other start and
    /// stop off until `endPreviewBinding`.
    static func beginPreviewBinding(for session: AVCaptureSession) {
        let intent = intent(for: session)
        if session.isRunning {
            session.stopRunning()
        }
        intent.previewBindings += 1
    }

    /// Releases one claim `beginPreviewBinding` took and, once the last one is
    /// gone, puts the session back into the state the app asked for. An
    /// outstanding claim still standing means `resume` stands down, so an
    /// overlapping detach cannot start the session under an attach that has
    /// not bound its layer yet.
    @discardableResult
    static func endPreviewBinding(for session: AVCaptureSession) -> Action {
        let intent = intent(for: session)
        intent.previewBindings = max(0, intent.previewBindings - 1)
        return resume(session)
    }

    /// The decision, kept pure so every case is covered where no camera device
    /// exists to produce one.
    ///
    /// `!isRunning` alone is not a sufficient guard, which is what left Scan
    /// dead after a system sheet took the camera: a session that was
    /// interrupted and then released can keep answering `isRunning == true`
    /// while its graph delivers nothing, so the preview freezes and the shutter
    /// throws. An interruption the app has seen and not recovered from is
    /// therefore its own reason to cycle the session, whatever `isRunning`
    /// claims.
    static func action(
        wantsToRun: Bool,
        isRunning: Bool,
        isInterrupted: Bool,
        hasUnrecoveredInterruption: Bool
    ) -> Action {
        // Nothing to restore while the app has asked the camera to be off, and
        // nothing AVFoundation will honour while the system still holds the
        // device. The interruption ending is what wakes that second case.
        guard wantsToRun, !isInterrupted else { return .none }
        guard isRunning else { return .start }
        return hasUnrecoveredInterruption ? .restart : .none
    }

    /// Applies the decision to `session`. Call on
    /// `AVFoundationCaptureCamera.sessionQueue`.
    @discardableResult
    static func resume(_ session: AVCaptureSession) -> Action {
        let intent = intent(for: session)
        // A preview binding owns the session until it says otherwise, and it
        // ends by resuming, so nothing is lost by standing down here.
        let action = intent.isBindingPreview ? .none : action(
            wantsToRun: intent.wantsToRun,
            isRunning: session.isRunning,
            isInterrupted: session.isInterrupted,
            hasUnrecoveredInterruption: intent.hasUnrecoveredInterruption
        )
        intent.lastAction = action
        switch action {
        case .none:
            return action
        case .start:
            session.startRunning()
        case .restart:
            session.stopRunning()
            session.startRunning()
        }
        intent.hasUnrecoveredInterruption = false
        intent.onResume?()
        return action
    }
}

final class AVFoundationCaptureCamera: NSObject, CaptureCamera, @unchecked Sendable {
    let session = AVCaptureSession()
    private(set) var captureDevice: AVCaptureDevice?
    private(set) var zoomControl: ScanZoomControl = .wideOnly

    /// The one serial queue every `AVCaptureSession` mutation in the app runs
    /// on: start, stop, zoom, and preview teardown.
    ///
    /// It is shared rather than per-instance because teardown is reached from
    /// `CameraPreviewView.dismantleUIView`, which SwiftUI calls statically with
    /// no camera in hand. Serializing all four through one queue is also what
    /// keeps a preview detach from interleaving with a zoom write.
    static let sessionQueue = DispatchQueue(label: "dev.snaplist.capture.session")

    private var sessionQueue: DispatchQueue { Self.sessionQueue }
    private let frameQueue = DispatchQueue(label: "dev.snaplist.capture.frames")
    private let photoOutput = AVCapturePhotoOutput()
    private let videoOutput = AVCaptureVideoDataOutput()
    private let frameHandlerLock = NSLock()
    private var configured = false
    private var frameHandler: ((CaptureFrame) -> Void)?
    private var photoDelegates: [Int64: PhotoCaptureDelegate] = [:]
    private var rotationCoordinator: AVCaptureDevice.RotationCoordinator?
    private var rotationObservation: NSKeyValueObservation?
    private var wasInterruptedObserver: NSObjectProtocol?
    private var interruptionEndedObserver: NSObjectProtocol?
    private var runtimeErrorObserver: NSObjectProtocol?
    private var flashMode: CaptureFlashMode = .off
    /// The lens the seller has asked for, held the way `flashMode` is held so
    /// the hardware can be pointed at it again whenever the session comes back.
    ///
    /// A dual wide device opens at the ultra wide's own field of view, which
    /// would rewiden every seller's framing, so this starts at the lens they
    /// already shoot with. Written and read on `sessionQueue` only.
    private var zoomLens: ScanZoomLens = .wide

    override init() {
        let selection = Self.selectBackCamera()
        captureDevice = selection.device
        zoomControl = selection.zoomControl
        super.init()
        Self.sessionQueue.async { [weak self] in
            guard let self else { return }
            CaptureSessionResumption.setResumeHandler({ [weak self] in
                guard let self else { return }
                // Whatever took the camera away can have left the device on
                // another factor, and no resumption path goes back through
                // `start()`, so point it at the lens the seller chose rather
                // than at whatever it came back on.
                self.applyZoomLens(self.zoomLens)
            }, for: self.session)
        }
        // A session that is taken away says so before it says anything else,
        // and until #1044 nothing listened. `interruptionEndedNotification`
        // on its own cannot tell a session that survived from one that has to
        // be cycled, because `isRunning` does not distinguish them.
        wasInterruptedObserver = NotificationCenter.default.addObserver(
            forName: AVCaptureSession.wasInterruptedNotification,
            object: session,
            queue: nil
        ) { [weak self] _ in
            Self.sessionQueue.async { [weak self] in
                guard let self else { return }
                CaptureSessionResumption.recordInterruption(for: self.session)
            }
        }
        interruptionEndedObserver = NotificationCenter.default.addObserver(
            forName: AVCaptureSession.interruptionEndedNotification,
            object: session,
            queue: nil
        ) { [weak self] _ in
            self?.resumeSessionIfNeeded()
        }
        runtimeErrorObserver = NotificationCenter.default.addObserver(
            forName: AVCaptureSession.runtimeErrorNotification,
            object: session,
            queue: nil
        ) { [weak self] _ in
            self?.resumeSessionIfNeeded()
        }
    }

    deinit {
        rotationObservation?.invalidate()
        if let wasInterruptedObserver {
            NotificationCenter.default.removeObserver(wasInterruptedObserver)
        }
        if let interruptionEndedObserver {
            NotificationCenter.default.removeObserver(interruptionEndedObserver)
        }
        if let runtimeErrorObserver {
            NotificationCenter.default.removeObserver(runtimeErrorObserver)
        }
    }

    var isAvailable: Bool { captureDevice != nil }
    var isFlashAvailable: Bool { captureDevice?.hasFlash == true }

    func setFlashMode(_ mode: CaptureFlashMode) {
        sessionQueue.async { [weak self] in
            self?.flashMode = mode
        }
    }

    func selectZoomLens(_ lens: ScanZoomLens) {
        sessionQueue.async { [weak self] in
            guard let self, self.zoomControl.lenses.contains(lens) else { return }
            self.zoomLens = lens
            self.applyZoomLens(lens)
        }
    }

    /// Picks the back camera Scan runs on, taking the virtual dual wide device
    /// only when it can actually hand the seller a second lens.
    ///
    /// `AVCaptureDevice.DiscoverySession` over `.builtInUltraWideCamera` is the
    /// supported way to ask whether this iPhone has an ultra wide at all.
    /// `.builtInDualWideCamera` is then the device that makes switching free:
    /// AVFoundation crosses from the ultra wide to the wide by itself once
    /// `videoZoomFactor` reaches the first entry of
    /// `virtualDeviceSwitchOverVideoZoomFactors`, so setting that one number is
    /// the entire zoom implementation and no frame is ever cropped.
    ///
    /// Anything short of that keeps the plain wide angle device, which is
    /// today's behavior unchanged. `ScanZoomControl.wideOnly` reports a single
    /// lens, so the view offers no control rather than a factor the hardware
    /// cannot reach. The simulator and an iPhone SE both land here.
    private static func selectBackCamera() -> (device: AVCaptureDevice?, zoomControl: ScanZoomControl) {
        let wideAngle = AVCaptureDevice.default(
            .builtInWideAngleCamera,
            for: .video,
            position: .back
        )
        let hasUltraWideCamera = !AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInUltraWideCamera],
            mediaType: .video,
            position: .back
        ).devices.isEmpty
        guard hasUltraWideCamera,
              let dualWide = AVCaptureDevice.default(
                  .builtInDualWideCamera,
                  for: .video,
                  position: .back
              ) else {
            return (wideAngle, .wideOnly)
        }

        let control = ScanZoomControl.resolve(
            hasUltraWideCamera: true,
            switchOverVideoZoomFactors: dualWide.virtualDeviceSwitchOverVideoZoomFactors
                .map { CGFloat(truncating: $0) }
        )
        guard control.isOffered else { return (wideAngle, .wideOnly) }
        return (dualWide, control)
    }

    /// Runs on `sessionQueue` only. `lockForConfiguration` serializes against
    /// AVFoundation's own use of the device, and the queue serializes it against
    /// the preview detach in `CameraPreviewSessionDetachment`.
    private func applyZoomLens(_ lens: ScanZoomLens) {
        guard let captureDevice, zoomControl.lenses.contains(lens) else { return }
        let requested = zoomControl.videoZoomFactor(for: lens)
        let factor = min(
            max(requested, captureDevice.minAvailableVideoZoomFactor),
            captureDevice.maxAvailableVideoZoomFactor
        )
        do {
            try captureDevice.lockForConfiguration()
            defer { captureDevice.unlockForConfiguration() }
            captureDevice.videoZoomFactor = factor
        } catch {
            // Another client holds the device. The preview keeps the factor it
            // already has, which is honest; retrying here would fight whoever
            // took the lock.
        }
    }

    func authorizationStatus() -> CaptureCameraAuthorization {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .notDetermined: .notDetermined
        case .authorized: .authorized
        case .denied: .denied
        case .restricted: .restricted
        @unknown default: .denied
        }
    }

    func requestAuthorization() async -> CaptureCameraAuthorization {
        let granted = await AVCaptureDevice.requestAccess(for: .video)
        return granted ? .authorized : .denied
    }

    func start(frameHandler: @escaping (CaptureFrame) -> Void) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            sessionQueue.async { [weak self] in
                guard let self else {
                    continuation.resume(throwing: AVFoundationCaptureError.cameraUnavailable)
                    return
                }
                do {
                    try self.configureIfNeeded()
                    // Point the hardware at the lens after the configuration has
                    // committed, not inside it. Setting `sessionPreset` hands the
                    // session control of the device's `activeFormat`, and the
                    // header is explicit that the new format is applied in
                    // `commitConfiguration`. `applyZoomLens` clamps against
                    // `min`/`maxAvailableVideoZoomFactor`, which `activeFormat`
                    // determines, so a write before the commit is clamped against
                    // a format that is about to be replaced. Doing it here also
                    // means a stop/start reaches it, which the `configured`
                    // guarded body does not because it runs once.
                    self.applyZoomLens(self.zoomLens)
                    self.setFrameHandler(frameHandler)
                    CaptureSessionResumption.setWantsToRun(true, for: self.session)
                    // Not `startRunning()` behind an `isRunning` guard. Coming
                    // back to the foreground is one of the paths that finds a
                    // session which was interrupted while the app was away, and
                    // such a session can still claim to be running.
                    CaptureSessionResumption.resume(self.session)
                    continuation.resume()
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    func stop() {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            CaptureSessionResumption.setWantsToRun(false, for: self.session)
            self.setFrameHandler(nil)
            if self.session.isRunning {
                self.session.stopRunning()
            }
        }
    }

    func capturePhoto() async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            sessionQueue.async { [weak self] in
                guard let self, self.session.isRunning else {
                    continuation.resume(throwing: AVFoundationCaptureError.captureFailed)
                    return
                }
                let settings = AVCapturePhotoSettings(
                    format: [AVVideoCodecKey: AVVideoCodecType.jpeg]
                )
                settings.photoQualityPrioritization = .balanced
                let requestedFlashMode: AVCaptureDevice.FlashMode = self.flashMode == .on
                    ? .on
                    : .off
                if self.photoOutput.supportedFlashModes.contains(requestedFlashMode) {
                    settings.flashMode = requestedFlashMode
                }
                let delegate = PhotoCaptureDelegate { [weak self] id, result in
                    self?.sessionQueue.async {
                        self?.photoDelegates[id] = nil
                    }
                    continuation.resume(with: result)
                }
                photoDelegates[settings.uniqueID] = delegate
                photoOutput.capturePhoto(with: settings, delegate: delegate)
            }
        }
    }

    private func configureIfNeeded() throws {
        guard !configured else { return }
        guard let captureDevice else {
            throw AVFoundationCaptureError.cameraUnavailable
        }

        session.beginConfiguration()
        defer { session.commitConfiguration() }
        session.sessionPreset = .photo

        let input = try AVCaptureDeviceInput(device: captureDevice)
        guard session.canAddInput(input),
              session.canAddOutput(photoOutput),
              session.canAddOutput(videoOutput) else {
            throw AVFoundationCaptureError.configurationFailed
        }
        session.addInput(input)
        session.addOutput(photoOutput)

        videoOutput.alwaysDiscardsLateVideoFrames = true
        videoOutput.videoSettings = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
        ]
        videoOutput.setSampleBufferDelegate(self, queue: frameQueue)
        session.addOutput(videoOutput)

        rotationCoordinator = AVCaptureDevice.RotationCoordinator(
            device: captureDevice,
            previewLayer: nil
        )
        rotationObservation = rotationCoordinator?.observe(
            \.videoRotationAngleForHorizonLevelCapture,
            options: [.initial, .new]
        ) { [weak self] coordinator, _ in
            self?.applyCaptureRotation(coordinator.videoRotationAngleForHorizonLevelCapture)
        }
        configured = true
    }

    private func applyCaptureRotation(_ angle: CGFloat) {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            for connection in [
                self.photoOutput.connection(with: .video),
                self.videoOutput.connection(with: .video)
            ].compactMap({ $0 }) where connection.isVideoRotationAngleSupported(angle) {
                connection.videoRotationAngle = angle
            }
        }
    }

    private func resumeSessionIfNeeded() {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            CaptureSessionResumption.resume(self.session)
        }
    }

    private func setFrameHandler(_ handler: ((CaptureFrame) -> Void)?) {
        frameHandlerLock.lock()
        frameHandler = handler
        frameHandlerLock.unlock()
    }

    private func currentFrameHandler() -> ((CaptureFrame) -> Void)? {
        frameHandlerLock.lock()
        defer { frameHandlerLock.unlock() }
        return frameHandler
    }
}

extension AVFoundationCaptureCamera: AVCaptureVideoDataOutputSampleBufferDelegate {
    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        currentFrameHandler()?(
            CaptureFrame(
                pixelBuffer: pixelBuffer,
                // The output connection already applies the coordinator's
                // horizon-level rotation to the pixel buffer.
                orientation: .up
            )
        )
    }
}

private final class PhotoCaptureDelegate: NSObject, AVCapturePhotoCaptureDelegate {
    private let completion: (Int64, Result<Data, Error>) -> Void

    init(completion: @escaping (Int64, Result<Data, Error>) -> Void) {
        self.completion = completion
    }

    func photoOutput(
        _ output: AVCapturePhotoOutput,
        didFinishProcessingPhoto photo: AVCapturePhoto,
        error: Error?
    ) {
        if let error {
            completion(photo.resolvedSettings.uniqueID, .failure(error))
        } else if let data = photo.fileDataRepresentation() {
            completion(photo.resolvedSettings.uniqueID, .success(data))
        } else {
            completion(
                photo.resolvedSettings.uniqueID,
                .failure(AVFoundationCaptureError.captureFailed)
            )
        }
    }
}

actor VisionObjectFramingEvaluator: FramingEvaluating {
    func evaluate(frame: CaptureFrame) async throws -> FramingObservation {
        let request = VNGenerateObjectnessBasedSaliencyImageRequest()
        let handler = VNImageRequestHandler(
            cvPixelBuffer: frame.pixelBuffer,
            orientation: frame.orientation,
            options: [:]
        )
        try handler.perform([request])

        let objects = request.results?.first?.salientObjects ?? []
        let largest = objects.max { lhs, rhs in
            lhs.boundingBox.width * lhs.boundingBox.height
                < rhs.boundingBox.width * rhs.boundingBox.height
        }
        return FramingObservation(subjectBounds: largest?.boundingBox)
    }
}

struct CameraPreviewView: UIViewRepresentable {
    let session: AVCaptureSession
    let device: AVCaptureDevice?

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> CameraPreviewContainer {
        let view = CameraPreviewContainer()
        view.previewLayer.videoGravity = .resizeAspectFill
        CameraPreviewSessionAttachment.attach(session, to: view.previewLayer)
        context.coordinator.attach(device: device, previewLayer: view.previewLayer)
        return view
    }

    func updateUIView(_ uiView: CameraPreviewContainer, context: Context) {
        CameraPreviewSessionAttachment.attach(session, to: uiView.previewLayer)
    }

    static func dismantleUIView(_ uiView: CameraPreviewContainer, coordinator: Coordinator) {
        coordinator.detach()
        CameraPreviewSessionDetachment.detach(uiView.previewLayer)
    }

    final class Coordinator {
        private var rotationCoordinator: AVCaptureDevice.RotationCoordinator?
        private var observation: NSKeyValueObservation?

        func attach(device: AVCaptureDevice?, previewLayer: AVCaptureVideoPreviewLayer) {
            guard let device else { return }
            let coordinator = AVCaptureDevice.RotationCoordinator(
                device: device,
                previewLayer: previewLayer
            )
            rotationCoordinator = coordinator
            observation = coordinator.observe(
                \.videoRotationAngleForHorizonLevelPreview,
                options: [.initial, .new]
            ) { coordinator, _ in
                let angle = coordinator.videoRotationAngleForHorizonLevelPreview
                DispatchQueue.main.async {
                    if previewLayer.connection?.isVideoRotationAngleSupported(angle) == true {
                        previewLayer.connection?.videoRotationAngle = angle
                    }
                }
            }
        }

        func detach() {
            observation?.invalidate()
            observation = nil
            rotationCoordinator = nil
        }
    }
}

/// Releases a preview layer's capture session without hanging the main thread.
///
/// Assigning `AVCaptureVideoPreviewLayer.session` implicitly runs a
/// `beginConfiguration`/`commitConfiguration` pair to drop the preview
/// connection. Against a session that is still running, that commit rebuilds
/// and restarts the capture graph synchronously, blocking whichever thread
/// made the assignment. SwiftUI dismantles a `UIViewRepresentable` on the main
/// thread, so doing it inline froze the app as the seller left Scan: Sentry
/// SNAPLIST-J, counted again as SNAPLIST-H and SNAPLIST-G.
///
/// Stopping the session is the expensive half, so it runs on the shared serial
/// session queue. Only the single line that touches the layer hops back to the
/// main thread, and by then the session is stopped, so its commit has no graph
/// left to rebuild and returns immediately.
enum CameraPreviewSessionDetachment {
    static func detach(_ previewLayer: AVCaptureVideoPreviewLayer) {
        guard let session = previewLayer.session else { return }
        AVFoundationCaptureCamera.sessionQueue.async {
            CaptureSessionResumption.beginPreviewBinding(for: session)
            DispatchQueue.main.async {
                previewLayer.session = nil
                AVFoundationCaptureCamera.sessionQueue.async {
                    // Stopping the session was teardown for this layer, not a
                    // decision about the camera. Scan restarts the camera by
                    // leaving and re-entering the live surface, so this detach
                    // lands on the session queue behind the restart that was
                    // enqueued first, and without handing the session back it
                    // is the restart's last word (#1044).
                    CaptureSessionResumption.endPreviewBinding(for: session)
                }
            }
        }
    }
}

/// Binds a preview layer to a capture session without letting the assignment
/// rebuild a running capture graph on the main thread.
///
/// The mirror image of `CameraPreviewSessionDetachment`: assigning
/// `AVCaptureVideoPreviewLayer.session` is a configuration change either way,
/// so it is only ever made against a stopped session, and the session is put
/// back into the state the app asked for once the layer is bound.
enum CameraPreviewSessionAttachment {
    static func attach(
        _ session: AVCaptureSession,
        to previewLayer: AVCaptureVideoPreviewLayer
    ) {
        // SwiftUI updates a representable more than once for one binding, and
        // the binding below only lands a queue hop later, so without this every
        // update would claim the session and cycle it again.
        guard previewLayer.session !== session else { return }
        AVFoundationCaptureCamera.sessionQueue.async {
            CaptureSessionResumption.beginPreviewBinding(for: session)
            DispatchQueue.main.async {
                previewLayer.session = session
                AVFoundationCaptureCamera.sessionQueue.async {
                    CaptureSessionResumption.endPreviewBinding(for: session)
                }
            }
        }
    }
}

final class CameraPreviewContainer: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }

    var previewLayer: AVCaptureVideoPreviewLayer {
        layer as! AVCaptureVideoPreviewLayer
    }
}
