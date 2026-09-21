import CoreGraphics
import XCTest
@testable import SnapList

/// Which surface the seller is actually looking at once a route is pushed.
///
/// Issue #1056 established this alongside a dimming spotlight that blocked the
/// rest of the screen. #1133 retired the blocking half — the activation tour
/// glows the control instead, and its own contracts live in
/// `ActivationTourPolicyTests` — but the surface question survived it
/// unchanged: it is still what decides where guidance is allowed to speak.
@MainActor
final class ActivationGuidanceSurfaceTests: XCTestCase {
    // MARK: - Surface resolution

    /// The reported defect. Settings pushes onto the selected tab's stack, so a
    /// resolver that reads only the tab and the full-screen presentation keeps
    /// answering `.trophyWall` (or `.scan`) and the shell draws that tab's coach
    /// mark on top of Settings, anchored to chrome that is not on screen.
    func testAPushedRouteNeverInheritsItsTabsActivationSurface() {
        XCTAssertEqual(
            ActivationSurfaceResolutionPolicy.surface(
                hasPhotoReviewSession: false,
                selectedTab: .trophyWall,
                pushedPath: [],
                presentedFullScreen: nil
            ),
            .trophyWall,
            "control: an empty stack still resolves to its tab"
        )

        XCTAssertEqual(
            ActivationSurfaceResolutionPolicy.surface(
                hasPhotoReviewSession: false,
                selectedTab: .trophyWall,
                pushedPath: [.settings],
                presentedFullScreen: nil
            ),
            .settings,
            "Settings pushed over Trophy Wall is the Settings surface, not Trophy Wall"
        )

        XCTAssertEqual(
            ActivationSurfaceResolutionPolicy.surface(
                hasPhotoReviewSession: false,
                selectedTab: .scan,
                pushedPath: [.settings],
                presentedFullScreen: nil
            ),
            .settings,
            "and the same holds when Settings is pushed over Scan"
        )

        for pushed in [AppRoute.home(.processing), .future(.draft)] {
            XCTAssertNil(
                ActivationSurfaceResolutionPolicy.surface(
                    hasPhotoReviewSession: false,
                    selectedTab: .trophyWall,
                    pushedPath: [pushed],
                    presentedFullScreen: nil
                ),
                "a pushed route with no activation surface of its own shows no mark"
            )
        }

        XCTAssertEqual(
            ActivationSurfaceResolutionPolicy.surface(
                hasPhotoReviewSession: true,
                selectedTab: .trophyWall,
                pushedPath: [.settings],
                presentedFullScreen: nil
            ),
            .photoReview,
            "Photo Review hosts above the tab stacks, so it still wins"
        )
    }

    func testScanResolvesOnlyOnItsOwnTabAndPresentations() {
        XCTAssertEqual(
            ActivationSurfaceResolutionPolicy.surface(
                hasPhotoReviewSession: false,
                selectedTab: .scan,
                pushedPath: [],
                presentedFullScreen: nil
            ),
            .scan
        )
        XCTAssertEqual(
            ActivationSurfaceResolutionPolicy.surface(
                hasPhotoReviewSession: false,
                selectedTab: .scan,
                pushedPath: [],
                presentedFullScreen: .guidedCamera
            ),
            .scan
        )
        XCTAssertNil(
            ActivationSurfaceResolutionPolicy.surface(
                hasPhotoReviewSession: false,
                selectedTab: .trophyWall,
                pushedPath: [],
                presentedFullScreen: .guidedCamera
            )
        )
    }
}
