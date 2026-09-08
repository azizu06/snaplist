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
