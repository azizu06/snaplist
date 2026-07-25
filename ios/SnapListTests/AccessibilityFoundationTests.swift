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

    func testScanRestoresReviewOpenerFocusOnlyWhenAReviewablePhotoRemains() {
        XCTAssertEqual(
            ScanReturnFocusPolicy.outcome(
                pendingFocus: .reviewButton,
                stagedPhotoCount: 1
            ),
            .focusReviewOpener,
            "Returning from Photo Review must restore the Review opener."
        )
        XCTAssertEqual(
            ScanReturnFocusPolicy.outcome(
                pendingFocus: .reviewButton,
                stagedPhotoCount: 5
            ),
            .focusReviewOpener
        )
        XCTAssertEqual(
            ScanReturnFocusPolicy.outcome(
                pendingFocus: .reviewButton,
                stagedPhotoCount: 0
            ),
            .none,
            "Zero-photo Scan has no Review opener to focus."
        )
        XCTAssertEqual(
            ScanReturnFocusPolicy.outcome(
                pendingFocus: nil,
                stagedPhotoCount: 1
            ),
            .none,
            "Scan must not claim Review focus without a pending return."
        )
        XCTAssertEqual(
            ScanReturnFocusPolicy.outcome(
                pendingFocus: .addPhotoButton,
                stagedPhotoCount: 1
            ),
            .none,
            "An Add-photo return is not the Review opener contract."
        )
    }
}
