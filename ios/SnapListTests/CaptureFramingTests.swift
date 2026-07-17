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
}
