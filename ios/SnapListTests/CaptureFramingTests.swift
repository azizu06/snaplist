import CoreGraphics
import XCTest
@testable import SnapList

final class CaptureFramingTests: XCTestCase {
    func testPolicyKeepsUnknownAndEdgeClippedSubjectsInCoaching() {
        let policy = FramingEvaluationPolicy()

        XCTAssertEqual(policy.guidance(for: .noSubject), .coaching)
        XCTAssertEqual(
            policy.guidance(
                for: FramingObservation(
                    subjectBounds: CGRect(x: 0.01, y: 0.12, width: 0.65, height: 0.68)
                )
            ),
            .coaching
        )
    }

    func testPolicyRequestsMoveCloserForSmallCenteredSubject() {
        let policy = FramingEvaluationPolicy()

        XCTAssertEqual(
            policy.guidance(
                for: FramingObservation(
                    subjectBounds: CGRect(x: 0.40, y: 0.35, width: 0.20, height: 0.28)
                )
            ),
            .moveCloser
        )
    }

    func testPolicyAcceptsACompleteSubjectWithBreathingRoom() {
        let policy = FramingEvaluationPolicy()

        XCTAssertEqual(
            policy.guidance(
                for: FramingObservation(
                    subjectBounds: CGRect(x: 0.18, y: 0.14, width: 0.64, height: 0.70)
                )
            ),
            .accepted
        )
    }

    func testStabilizerRequiresTwoConsistentFramesBeforeChangingGuidance() {
        var stabilizer = FramingGuidanceStabilizer(requiredConsecutiveFrames: 2)

        XCTAssertEqual(stabilizer.consume(.moveCloser), .coaching)
        XCTAssertEqual(stabilizer.consume(.moveCloser), .moveCloser)
        XCTAssertEqual(stabilizer.consume(.accepted), .moveCloser)
        XCTAssertEqual(stabilizer.consume(.accepted), .accepted)
    }

    func testResetPreservesTheInjectedStabilityThreshold() {
        var stabilizer = FramingGuidanceStabilizer(requiredConsecutiveFrames: 3)

        _ = stabilizer.consume(.moveCloser)
        _ = stabilizer.consume(.moveCloser)
        XCTAssertEqual(stabilizer.consume(.moveCloser), .moveCloser)
        stabilizer.reset()

        XCTAssertEqual(stabilizer.consume(.accepted), .coaching)
        XCTAssertEqual(stabilizer.consume(.accepted), .coaching)
        XCTAssertEqual(stabilizer.consume(.accepted), .accepted)
    }

    // MARK: - Scan zoom (#885)

    /// A back camera that pairs an ultra wide with a wide lens reports the
    /// `videoZoomFactor` where it hands the frame from one to the other. That
    /// one number is the whole control: it is the factor `1x` selects, and it
    /// is what divides a raw factor into the number the seller reads.
    func testDualWideDeviceOffersBothLensesAndMapsThemToItsSwitchOverFactor() {
        let control = ScanZoomControl.resolve(
            hasUltraWideCamera: true,
            switchOverVideoZoomFactors: [2]
        )

        XCTAssertTrue(control.isOffered)
        XCTAssertEqual(control.lenses, [.ultraWide, .wide])
        XCTAssertEqual(control.videoZoomFactor(for: .ultraWide), 1)
        XCTAssertEqual(control.videoZoomFactor(for: .wide), 2)
        XCTAssertEqual(control.displayedFactor(for: .ultraWide), 0.5)
        XCTAssertEqual(control.displayedFactor(for: .wide), 1)
    }

    /// The honest degradation. A back camera with no ultra wide constituent
    /// cannot reach `.5x` at all, so the control is not offered rather than
    /// shown with a factor the hardware will refuse. The simulator, which has
    /// no camera whatsoever, resolves here too.
    func testDeviceWithoutAnUltraWideOffersNoZoomControlInsteadOfAnUnreachableFactor() {
        for control in [
            ScanZoomControl.resolve(
                hasUltraWideCamera: false,
                switchOverVideoZoomFactors: []
            ),
            // A virtual device can exist while reporting no switch-over point,
            // which leaves nothing to map `1x` onto.
            ScanZoomControl.resolve(
                hasUltraWideCamera: true,
                switchOverVideoZoomFactors: []
            )
        ] {
            XCTAssertFalse(control.isOffered)
            XCTAssertEqual(control.lenses, [.wide])
            XCTAssertEqual(control.videoZoomFactor(for: .wide), 1)
            XCTAssertEqual(control.displayedFactor(for: .wide), 1)
        }
    }

    /// The reference writes these two options as `.5x` and `1x`, with no
    /// leading zero. VoiceOver gets the leading zero back, because a spoken
    /// "point five x" without it is easy to hear as "five x".
    func testZoomOptionLabelsMatchTheReferenceAndKeepTheLeadingZeroForVoiceOver() {
        let control = ScanZoomControl.resolve(
            hasUltraWideCamera: true,
            switchOverVideoZoomFactors: [2]
        )

        XCTAssertEqual(control.label(for: .ultraWide), ".5x")
        XCTAssertEqual(control.label(for: .wide), "1x")
        XCTAssertEqual(control.spokenFactor(for: .ultraWide), "0.5x")
        XCTAssertEqual(control.spokenFactor(for: .wide), "1x")
        XCTAssertEqual(control.accessibilityLabel(for: .ultraWide), "0.5x zoom")
        XCTAssertEqual(control.accessibilityLabel(for: .wide), "1x zoom")
    }
}
