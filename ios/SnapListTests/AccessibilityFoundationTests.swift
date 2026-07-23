import XCTest
@testable import SnapList

final class AccessibilityFoundationTests: XCTestCase {
    func testFoundationTouchTargetsAreAtLeastFortyFourPoints() {
        XCTAssertGreaterThanOrEqual(SnapListMetrics.minimumTouchTarget, 44)
        XCTAssertGreaterThanOrEqual(SnapListMetrics.captureWidth, 44)
        XCTAssertGreaterThanOrEqual(SnapListMetrics.primaryButtonHeight, 44)
    }

    func testEveryTypographyRoleStartsAtTwelvePointsOrLarger() {
        XCTAssertTrue(
            SnapListTypographyToken.allCases.allSatisfy { $0.baseSize >= 12 }
        )
    }

    func testKeyboardVisibilityHidesTheDock() {
        XCTAssertTrue(DockVisibilityPolicy.shouldShow(isKeyboardVisible: false))
        XCTAssertFalse(DockVisibilityPolicy.shouldShow(isKeyboardVisible: true))
    }

    func testReducedMotionLaunchFixtureIsDeterministic() {
        let configuration = LaunchConfiguration.parse(
            arguments: ["--reduced-motion", "--zero-network-fixtures"]
        )
        XCTAssertTrue(configuration.forceReducedMotion)
        XCTAssertTrue(configuration.usesZeroNetworkFixtures)
    }

    func testLiveAndRecoveryReviewControlsShareApprovedAccessibilityPriority() {
        for context in ScanReviewAccessibilityPriority.allCases {
            XCTAssertEqual(
                context.value,
                40,
                "\(context.rawValue) Review priority"
            )
        }
    }
}
