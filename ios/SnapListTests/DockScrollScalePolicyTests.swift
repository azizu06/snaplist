import XCTest
@testable import SnapList

final class DockScrollScalePolicyTests: XCTestCase {
    func testScrollingDownShrinksTheDockProportionally() {
        let midway = DockScrollScalePolicy.scale(
            forDownwardOffset: DockScrollScalePolicy.travelPoints / 2,
            reduceMotion: false
        )
        XCTAssertEqual(
            midway,
            (DockScrollScalePolicy.fullScale + DockScrollScalePolicy.floorScale) / 2,
            accuracy: 0.0001
        )
        XCTAssertLessThan(midway, DockScrollScalePolicy.fullScale)
        XCTAssertGreaterThan(midway, DockScrollScalePolicy.floorScale)
    }

    func testScrollingBackUpRestoresTheDock() {
        let scrolledDown = DockScrollScalePolicy.scale(forDownwardOffset: 90, reduceMotion: false)
        let scrolledPartlyBackUp = DockScrollScalePolicy.scale(forDownwardOffset: 30, reduceMotion: false)
        XCTAssertGreaterThan(scrolledPartlyBackUp, scrolledDown)

        let backAtTop = DockScrollScalePolicy.scale(forDownwardOffset: 0, reduceMotion: false)
        XCTAssertEqual(backAtTop, DockScrollScalePolicy.fullScale)
    }

    func testFloorClampsAtTheConfiguredMinimum() {
        let pastTravel = DockScrollScalePolicy.scale(
            forDownwardOffset: DockScrollScalePolicy.travelPoints + 400,
            reduceMotion: false
        )
        XCTAssertEqual(pastTravel, DockScrollScalePolicy.floorScale)

        let wayPastTravel = DockScrollScalePolicy.scale(
            forDownwardOffset: DockScrollScalePolicy.travelPoints * 10,
            reduceMotion: false
        )
        XCTAssertEqual(wayPastTravel, DockScrollScalePolicy.floorScale)
    }

    func testCeilingClampsAtFullScaleDuringTopOverscroll() {
        let bounceAboveTop = DockScrollScalePolicy.scale(forDownwardOffset: -60, reduceMotion: false)
        XCTAssertEqual(bounceAboveTop, DockScrollScalePolicy.fullScale)
    }

    func testScrollToTopAlwaysEndsAtFullScale() {
        let atTop = DockScrollScalePolicy.scale(forDownwardOffset: 0, reduceMotion: false)
        XCTAssertEqual(atTop, DockScrollScalePolicy.fullScale)
    }

    func testReducedMotionSnapsInsteadOfInterpolating() {
        let atRest = DockScrollScalePolicy.scale(forDownwardOffset: 0, reduceMotion: true)
        XCTAssertEqual(atRest, DockScrollScalePolicy.fullScale)

        let barelyScrolled = DockScrollScalePolicy.scale(forDownwardOffset: 1, reduceMotion: true)
        XCTAssertEqual(
            barelyScrolled,
            DockScrollScalePolicy.floorScale,
            "Reduced Motion must snap straight to the floor, never an interpolated value."
        )

        let nearTravelEnd = DockScrollScalePolicy.scale(
            forDownwardOffset: DockScrollScalePolicy.travelPoints - 1,
            reduceMotion: true
        )
        XCTAssertEqual(nearTravelEnd, DockScrollScalePolicy.floorScale)
    }

    func testFloorKeepsBothDestinationDimensionsAtLeastFortyFourPoints() {
        let compactDimension = FloatingDockMetrics.destinationWidth * DockScrollScalePolicy.floorScale
        XCTAssertGreaterThanOrEqual(compactDimension, 44)

        let compactHeight = FloatingDockMetrics.destinationHeight(for: .trophyWall)
            * DockScrollScalePolicy.floorScale
        XCTAssertGreaterThanOrEqual(compactHeight, 44)
    }
}

/// #1057: the fallback decision `SnapListShape` makes is a pure function of
/// availability, not a live `#available` check, so both branches are
/// assertable on every OS the suite happens to run on — including the iOS 17
/// fallback the acceptance criteria calls out by name.
final class SnapListShapePolicyTests: XCTestCase {
    func testConcentricAvailableChoosesTheConcentricKind() {
        XCTAssertEqual(
            SnapListShapePolicy.kind(minimumRadius: 22, isConcentricAvailable: true),
            .concentric(minimum: 22)
        )
    }

    func testConcentricUnavailableFallsBackToTheFixedRoundedRect() {
        XCTAssertEqual(
            SnapListShapePolicy.kind(minimumRadius: 22, isConcentricAvailable: false),
            .roundedRect(cornerRadius: 22)
        )
    }
}

final class ScrollEdgeEffectPolicyTests: XCTestCase {
    /// Locks the two approved surfaces to `.soft`, named per #1057's PR
    /// rather than inline at each call site, so a future scroll surface
    /// cannot silently disagree with the ones already reviewed.
    func testApprovedSurfacesRequestTheSoftStyle() {
        XCTAssertEqual(ScrollEdgeEffectPolicy.trophyWallBottomStyle, .soft)
        XCTAssertEqual(ScrollEdgeEffectPolicy.settingsBottomStyle, .soft)
    }
}

/// #1059: the policy seam Reduced Motion tests against, since the live
/// selection-change animation only exists on the iOS 26 render tree (no
/// unit-testable surface of its own).
final class DockGlassMotionPolicyTests: XCTestCase {
    func testAnimatesTheSelectionMorphWhenMotionIsNotReduced() {
        XCTAssertTrue(DockGlassMotionPolicy.shouldAnimateSelectionMorph(reduceMotion: false))
    }

    func testSkipsTheSelectionMorphAnimationWhenMotionIsReduced() {
        XCTAssertFalse(DockGlassMotionPolicy.shouldAnimateSelectionMorph(reduceMotion: true))
    }
}
