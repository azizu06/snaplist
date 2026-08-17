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
    private var wantsToRun = false
    private var frameHandler: ((CaptureFrame) -> Void)?
    private var photoDelegates: [Int64: PhotoCaptureDelegate] = [:]
    private var rotationCoordinator: AVCaptureDevice.RotationCoordinator?
    private var rotationObservation: NSKeyValueObservation?
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
        interruptionEndedObserver = NotificationCenter.default.addObserver(
            forName: AVCaptureSession.interruptionEndedNotification,
            object: session,
            queue: nil
        ) { [weak self] _ in
            self?.restartAfterInterruptionIfNeeded()
        }
        runtimeErrorObserver = NotificationCenter.default.addObserver(
            forName: AVCaptureSession.runtimeErrorNotification,
            object: session,
            queue: nil
        ) { [weak self] _ in
            self?.restartAfterInterruptionIfNeeded()
        }
    }

    deinit {
        rotationObservation?.invalidate()
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
                    self.wantsToRun = true
                    if !self.session.isRunning {
                        self.session.startRunning()
                    }
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
            self.wantsToRun = false
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

    private func restartAfterInterruptionIfNeeded() {
        sessionQueue.async { [weak self] in
            guard let self, self.wantsToRun, !self.session.isRunning else { return }
            self.session.startRunning()
            // Whatever took the camera away can have left the device on another
            // factor, and this path does not go through `start()`, so point it
            // back at the lens the seller chose rather than at whatever it
            // came back on.
            self.applyZoomLens(self.zoomLens)
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
        view.previewLayer.session = session
        view.previewLayer.videoGravity = .resizeAspectFill
        context.coordinator.attach(device: device, previewLayer: view.previewLayer)
        return view
    }

    func updateUIView(_ uiView: CameraPreviewContainer, context: Context) {
        if uiView.previewLayer.session !== session {
            uiView.previewLayer.session = session
        }
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
            if session.isRunning {
                session.stopRunning()
            }
            DispatchQueue.main.async {
                previewLayer.session = nil
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
