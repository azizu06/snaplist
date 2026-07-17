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

    private let sessionQueue = DispatchQueue(label: "dev.snaplist.capture.session")
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

    override init() {
        captureDevice = AVCaptureDevice.default(
            .builtInWideAngleCamera,
            for: .video,
            position: .back
        )
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
        uiView.previewLayer.session = nil
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

final class CameraPreviewContainer: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }

    var previewLayer: AVCaptureVideoPreviewLayer {
        layer as! AVCaptureVideoPreviewLayer
    }
}
