import CoreGraphics
import SwiftUI
import XCTest
@testable import SnapList

final class CaptureFramingTests: XCTestCase {
    // MARK: - Responsive framing corner geometry (#1058)

    /// A taller surface should end up with a taller frame and thicker
    /// styling than a shorter one at the same measured bottom clearance —
    /// the defect #1058 fixes is two very different heights (iPhone 16 and
    /// 16 Pro Max) landing on the identical bucketed values.
    func testTallerSurfaceYieldsATallerFrameAndBolderStylingThanASmallOneAtTheSameBottomInset() {
        let small = ResponsiveFramingGeometry.layout(
            availableSize: CGSize(width: 375, height: 667),
            bottomInset: 230,
            verticalSizeClass: .regular,
            horizontalSizeClass: .compact
        )
        let regular = ResponsiveFramingGeometry.layout(
            availableSize: CGSize(width: 393, height: 852),
            bottomInset: 230,
            verticalSizeClass: .regular,
            horizontalSizeClass: .compact
        )
        let tall = ResponsiveFramingGeometry.layout(
            availableSize: CGSize(width: 430, height: 932),
            bottomInset: 230,
            verticalSizeClass: .regular,
            horizontalSizeClass: .compact
        )

        XCTAssertLessThan(small.size.height, regular.size.height)
        XCTAssertLessThan(regular.size.height, tall.size.height)
        XCTAssertLessThanOrEqual(small.armLength, regular.armLength)
        XCTAssertLessThanOrEqual(regular.armLength, tall.armLength)
        // The old table gave the 393pt-wide and 430pt-wide surfaces the
        // identical bucketed value; the derived one must not.
        XCTAssertNotEqual(regular.size, tall.size)
    }

    /// Every literal from the old table (700/375 thresholds, 112/140,
    /// 264/300, 34/42, 12/15, 2.5/3) is gone; the frame is derived from the
    /// measured surface and clamped to sane bounds instead.
    func testLayoutStaysWithinItsClampedBoundsAtEveryCraftedSize() {
        let sizes: [CGSize] = [
            CGSize(width: 320, height: 480),   // small
            CGSize(width: 393, height: 852),   // regular
            CGSize(width: 500, height: 1200)   // tall / oversized
        ]
        for size in sizes {
            for bottomInset: CGFloat in [0, 120, 400] {
                let layout = ResponsiveFramingGeometry.layout(
                    availableSize: size,
                    bottomInset: bottomInset,
                    verticalSizeClass: .regular,
                    horizontalSizeClass: .compact
                )

                XCTAssertGreaterThanOrEqual(layout.size.width, 180)
                XCTAssertGreaterThanOrEqual(layout.size.height, 140)
                XCTAssertGreaterThanOrEqual(layout.armLength, 28)
                XCTAssertLessThanOrEqual(layout.armLength, 44)
                XCTAssertGreaterThanOrEqual(layout.cornerRadius, 10)
                XCTAssertLessThanOrEqual(layout.cornerRadius, 16)
                XCTAssertGreaterThanOrEqual(layout.lineWidth, 2.25)
                XCTAssertLessThanOrEqual(layout.lineWidth, 3.25)
            }
        }
    }

    /// A control-stack height the caller measured as taller (a bigger
    /// `bottomInset`) must shrink the frame, never move it independently of
    /// what was actually measured.
    func testALargerMeasuredControlStackHeightShrinksTheFrame() {
        let availableSize = CGSize(width: 393, height: 852)
        let shortControls = ResponsiveFramingGeometry.layout(
            availableSize: availableSize,
            bottomInset: 200,
            verticalSizeClass: .regular,
            horizontalSizeClass: .compact
        )
        let tallControls = ResponsiveFramingGeometry.layout(
            availableSize: availableSize,
            bottomInset: 320,
            verticalSizeClass: .regular,
            horizontalSizeClass: .compact
        )

        XCTAssertLessThan(tallControls.size.height, shortControls.size.height)
        XCTAssertEqual(tallControls.size.width, shortControls.size.width)
    }

    /// A compact-width surface (every supported phone in portrait) reserves
    /// a narrower horizontal margin than a regular-width one; the size class
    /// picks the ratio, not a hand-guessed 375pt threshold.
    func testRegularWidthSizeClassReservesMoreHorizontalMarginThanCompact() {
        let availableSize = CGSize(width: 500, height: 900)
        let compactWidth = ResponsiveFramingGeometry.layout(
            availableSize: availableSize,
            bottomInset: 200,
            verticalSizeClass: .regular,
            horizontalSizeClass: .compact
        )
        let regularWidth = ResponsiveFramingGeometry.layout(
            availableSize: availableSize,
            bottomInset: 200,
            verticalSizeClass: .regular,
            horizontalSizeClass: .regular
        )

        XCTAssertLessThan(regularWidth.size.width, compactWidth.size.width)
    }

    /// Before the caller's own measurement lands, the transient fallback
    /// still scales off the surface's own height instead of a fixed guess,
    /// and stays a plausible fraction of it.
    func testFallbackBottomInsetScalesWithMeasuredHeightAndSizeClass() {
        let compactFallback = ResponsiveFramingGeometry.fallbackBottomInset(
            availableHeight: 667,
            verticalSizeClass: .compact
        )
        let regularFallback = ResponsiveFramingGeometry.fallbackBottomInset(
            availableHeight: 667,
            verticalSizeClass: .regular
        )
        let tallerRegularFallback = ResponsiveFramingGeometry.fallbackBottomInset(
            availableHeight: 932,
            verticalSizeClass: .regular
        )

        XCTAssertLessThan(compactFallback, regularFallback)
        XCTAssertLessThan(regularFallback, tallerRegularFallback)
        XCTAssertGreaterThan(regularFallback, 0)
        XCTAssertLessThan(regularFallback, 667)
    }

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
