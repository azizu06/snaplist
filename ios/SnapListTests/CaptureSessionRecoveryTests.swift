import AVFoundation
import XCTest
@testable import SnapList

/// Covers how Scan's capture session comes back after the system takes the
/// camera away (issue #1044).
///
/// No simulator has a camera device, and a bare `AVCaptureSession` there stays
/// `isRunning == false` even after `startRunning()`, so none of this can be
/// asserted against real session state. What these tests assert instead is the
/// decision the app takes about the session, which is the part that was wrong.
final class CaptureSessionRecoveryTests: XCTestCase {
    // MARK: - The decision

    func testAStoppedSessionTheAppWantsRunningIsStarted() {
        XCTAssertEqual(
            CaptureSessionResumption.action(
                wantsToRun: true,
                isRunning: false,
                isInterrupted: false,
                hasUnrecoveredInterruption: false
            ),
            .start
        )
    }

    func testASessionRunningWithNoInterruptionBehindItIsLeftAlone() {
        XCTAssertEqual(
            CaptureSessionResumption.action(
                wantsToRun: true,
                isRunning: true,
                isInterrupted: false,
                hasUnrecoveredInterruption: false
            ),
            .none
        )
    }

    /// The defect the seller hit. `isRunning` is not proof that a session has
    /// survived an interruption, so an interruption that has not been recovered
    /// from is its own reason to cycle the session.
    func testASessionThatStillClaimsToBeRunningAfterAnInterruptionIsRestarted() {
        XCTAssertEqual(
            CaptureSessionResumption.action(
                wantsToRun: true,
                isRunning: true,
                isInterrupted: false,
                hasUnrecoveredInterruption: true
            ),
            .restart
        )
    }

    func testNothingIsResumedWhileTheSystemStillHoldsTheCamera() {
        XCTAssertEqual(
            CaptureSessionResumption.action(
                wantsToRun: true,
                isRunning: false,
                isInterrupted: true,
                hasUnrecoveredInterruption: true
            ),
            .none
        )
    }

    func testNothingIsResumedWhenTheAppHasAskedTheCameraToStop() {
        XCTAssertEqual(
            CaptureSessionResumption.action(
                wantsToRun: false,
                isRunning: false,
                isInterrupted: false,
                hasUnrecoveredInterruption: true
            ),
            .none
        )
    }

    // MARK: - The notifications

    func testTheCameraRecordsACaptureSessionInterruptionItObserves() {
        let camera = AVFoundationCaptureCamera()

        NotificationCenter.default.post(
            name: AVCaptureSession.wasInterruptedNotification,
            object: camera.session
        )
        drainCaptureQueues()

        XCTAssertTrue(
            CaptureSessionResumption.hasUnrecoveredInterruption(camera.session)
        )
    }

    func testInterruptionEndedResumesTheSessionTheAppWantsRunning() {
        let camera = AVFoundationCaptureCamera()
        AVFoundationCaptureCamera.sessionQueue.sync {
            CaptureSessionResumption.setWantsToRun(true, for: camera.session)
        }

        NotificationCenter.default.post(
            name: AVCaptureSession.wasInterruptedNotification,
            object: camera.session
        )
        NotificationCenter.default.post(
            name: AVCaptureSession.interruptionEndedNotification,
            object: camera.session
        )
        drainCaptureQueues()

        XCTAssertEqual(
            CaptureSessionResumption.lastAction(for: camera.session),
            .start
        )
        XCTAssertFalse(
            CaptureSessionResumption.hasUnrecoveredInterruption(camera.session)
        )
    }

    /// The app returning to the foreground has to be enough on its own: a
    /// system sheet that takes the camera does not always post
    /// `interruptionEndedNotification` before the seller is back in Scan.
    func testForegroundingAfterAnInterruptionThatNeverEndsResumesTheSession() {
        let camera = AVFoundationCaptureCamera()

        NotificationCenter.default.post(
            name: AVCaptureSession.wasInterruptedNotification,
            object: camera.session
        )
        drainCaptureQueues()

        let action = AVFoundationCaptureCamera.sessionQueue.sync {
            CaptureSessionResumption.setWantsToRun(true, for: camera.session)
            return CaptureSessionResumption.resume(camera.session)
        }

        XCTAssertEqual(action, .start)
        XCTAssertFalse(
            CaptureSessionResumption.hasUnrecoveredInterruption(camera.session)
        )
    }

    // MARK: - The preview

    /// Scan restarts the camera by leaving and re-entering the live surface,
    /// which dismantles the preview representable. That teardown stops the
    /// session on the same serial queue the restart was enqueued on, so it
    /// lands *after* the restart and undoes it. The session has to be handed
    /// back to the app that still wants it running.
    func testPreviewTeardownHandsTheSessionBackToTheAppThatWantsItRunning() {
        let session = AVCaptureSession()
        let previewLayer = AVCaptureVideoPreviewLayer()
        previewLayer.session = session
        AVFoundationCaptureCamera.sessionQueue.sync {
            CaptureSessionResumption.setWantsToRun(true, for: session)
        }

        CameraPreviewSessionDetachment.detach(previewLayer)
        drainCaptureQueues()

        XCTAssertEqual(CaptureSessionResumption.lastAction(for: session), .start)
    }

    func testPreviewTeardownLeavesASessionTheAppHasStoppedAlone() {
        let session = AVCaptureSession()
        let previewLayer = AVCaptureVideoPreviewLayer()
        previewLayer.session = session

        CameraPreviewSessionDetachment.detach(previewLayer)
        drainCaptureQueues()

        XCTAssertEqual(CaptureSessionResumption.lastAction(for: session), .none)
        XCTAssertNil(previewLayer.session)
    }

    /// The two Sentry signatures on the owner's phone are one race: a preview
    /// layer binding on the main thread while the session queue stops the
    /// session under it. A binding owns the session outright until it is done.
    func testNothingTouchesTheSessionWhileAPreviewIsBeingBound() {
        let session = AVCaptureSession()

        let duringBinding = AVFoundationCaptureCamera.sessionQueue.sync {
            () -> CaptureSessionResumption.Action in
            CaptureSessionResumption.setWantsToRun(true, for: session)
            CaptureSessionResumption.beginPreviewBinding(for: session)
            return CaptureSessionResumption.resume(session)
        }
        XCTAssertEqual(duringBinding, .none)

        let afterBinding = AVFoundationCaptureCamera.sessionQueue.sync {
            CaptureSessionResumption.endPreviewBinding(for: session)
        }
        XCTAssertEqual(afterBinding, .start)
    }

    func testPreviewAttachResumesASessionTheAppWantsRunning() {
        let session = AVCaptureSession()
        let previewLayer = AVCaptureVideoPreviewLayer()
        AVFoundationCaptureCamera.sessionQueue.sync {
            CaptureSessionResumption.setWantsToRun(true, for: session)
        }

        CameraPreviewSessionAttachment.attach(session, to: previewLayer)
        drainCaptureQueues()

        XCTAssertTrue(previewLayer.session === session)
        XCTAssertEqual(CaptureSessionResumption.lastAction(for: session), .start)
    }

    // MARK: - Helpers

    /// A detach hops session queue to main and back, so drain the pair enough
    /// times for the whole round trip to have run.
    private func drainCaptureQueues() {
        for _ in 0..<3 {
            AVFoundationCaptureCamera.sessionQueue.sync {}
            let drained = expectation(description: "main queue drained")
            DispatchQueue.main.async { drained.fulfill() }
            wait(for: [drained], timeout: 5)
        }
    }
}
