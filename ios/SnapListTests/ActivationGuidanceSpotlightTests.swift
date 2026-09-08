import CoreGraphics
import XCTest
@testable import SnapList

/// Issue #1056. Two contracts live here: which surface a coach mark is allowed
/// to belong to once a route is pushed, and the spotlight that blocks the rest
/// of the surface while one is showing.
@MainActor
final class ActivationGuidanceSpotlightTests: XCTestCase {
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

    // MARK: - Spotlight mode and presentation

    /// A blanket blocking scrim would contradict two of the approved lines.
    /// ACT-03 states something rather than naming a control, and ACT-04's line
    /// is about the whole form, so dimming it would block the very edit it
    /// invites.
    func testOnlyMarksThatNameOneControlCutAHole() {
        XCTAssertEqual(
            ActivationSpotlightTargetPolicy.mode(for: .act01),
            .spotlight(.scanShutter)
        )
        XCTAssertEqual(
            ActivationSpotlightTargetPolicy.mode(for: .act06),
            .spotlight(.scanShutter)
        )
        XCTAssertEqual(
            ActivationSpotlightTargetPolicy.mode(for: .act02),
            .spotlight(.photoReviewThumbnailStrip)
        )
        XCTAssertEqual(
            ActivationSpotlightTargetPolicy.mode(for: .act02B),
            .spotlight(.photoReviewVoiceNote)
        )
        XCTAssertEqual(ActivationSpotlightTargetPolicy.mode(for: .act03), .dim)
        XCTAssertEqual(
            ActivationSpotlightTargetPolicy.mode(for: .act04),
            .unblocked
        )
        XCTAssertEqual(
            ActivationSpotlightTargetPolicy.mode(for: .act08),
            .spotlight(.trophyWallProcessing)
        )
        XCTAssertEqual(
            ActivationSpotlightTargetPolicy.mode(for: .act09),
            .spotlight(.settingsMarketplaces)
        )

        XCTAssertNil(ActivationSpotlightTargetPolicy.target(for: .act03))
        XCTAssertNil(ActivationSpotlightTargetPolicy.target(for: .act04))
    }

    func testTheCutoutPadsTheControlAndStaysInsideTheSurface() {
        let bounds = CGRect(x: 0, y: 0, width: 393, height: 852)
        XCTAssertEqual(
            ActivationSpotlightGeometry.cutout(
                around: CGRect(x: 160, y: 700, width: 72, height: 72),
                in: bounds
            ),
            CGRect(x: 152, y: 692, width: 88, height: 88)
        )
        // A control flush against the top edge cannot pad past it.
        XCTAssertEqual(
            ActivationSpotlightGeometry.cutout(
                around: CGRect(x: 0, y: 0, width: 44, height: 44),
                in: bounds
            ),
            CGRect(x: 0, y: 0, width: 52, height: 52)
        )
        XCTAssertNil(
            ActivationSpotlightGeometry.cutout(around: .zero, in: bounds)
        )
        // Scrolled fully off screen: no hole rather than a hole in the corner.
        XCTAssertNil(
            ActivationSpotlightGeometry.cutout(
                around: CGRect(x: 0, y: 2_000, width: 44, height: 44),
                in: bounds
            )
        )
    }

    func testTheCornerRadiusNeverExceedsHalfTheShortestSide() {
        XCTAssertEqual(
            ActivationSpotlightGeometry.cornerRadius(
                for: CGRect(x: 0, y: 0, width: 88, height: 88)
            ),
            14
        )
        XCTAssertEqual(
            ActivationSpotlightGeometry.cornerRadius(
                for: CGRect(x: 0, y: 0, width: 200, height: 20)
            ),
            10
        )
    }

    /// The fail-open rule. A seller told to tap the shutter must never meet a
    /// scrim with no hole in it, so a mark whose control has not reported a
    /// frame draws its bubble and blocks nothing.
    func testAMarkWhoseControlHasNoFrameYetBlocksNothing() {
        let bounds = CGRect(x: 0, y: 0, width: 393, height: 852)
        XCTAssertEqual(
            ActivationSpotlightPolicy.presentation(
                for: .act01,
                targetFrame: nil,
                bounds: bounds
            ),
            .unanchored
        )
        XCTAssertEqual(
            ActivationSpotlightPolicy.presentation(
                for: .act01,
                targetFrame: CGRect(x: 0, y: 2_000, width: 72, height: 72),
                bounds: bounds
            ),
            .unanchored
        )
        XCTAssertEqual(
            ActivationSpotlightPolicy.presentation(
                for: nil,
                targetFrame: nil,
                bounds: bounds
            ),
            .hidden
        )
        XCTAssertEqual(
            ActivationSpotlightPolicy.presentation(
                for: .act03,
                targetFrame: nil,
                bounds: bounds
            ),
            .spotlight(cutout: nil)
        )
        XCTAssertEqual(
            ActivationSpotlightPolicy.presentation(
                for: .act04,
                targetFrame: CGRect(x: 10, y: 10, width: 40, height: 40),
                bounds: bounds
            ),
            .unanchored
        )
        XCTAssertTrue(
            ActivationSpotlightPolicy.presentation(
                for: .act01,
                targetFrame: CGRect(x: 160, y: 700, width: 72, height: 72),
                bounds: bounds
            ).isBlocking
        )
        XCTAssertFalse(
            ActivationSpotlightPolicy.presentation(
                for: .act04,
                targetFrame: nil,
                bounds: bounds
            ).isBlocking
        )
    }

    // MARK: - Hit testing

    /// The blocking contract: the spotlit control and Got it stay live, and
    /// everything else — the tab bar, a card that would push — is swallowed.
    func testOnlyTheCutoutAndTheDismissTargetPassTouchesThrough() {
        let cutout = CGRect(x: 152, y: 692, width: 88, height: 88)
        let dismiss = CGRect(x: 18, y: 560, width: 357, height: 90)

        XCTAssertEqual(
            ActivationSpotlightHitTestPolicy.outcome(
                for: CGPoint(x: 196, y: 736),
                cutout: cutout,
                dismiss: dismiss
            ),
            .passesThrough
        )
        XCTAssertEqual(
            ActivationSpotlightHitTestPolicy.outcome(
                for: CGPoint(x: 340, y: 600),
                cutout: cutout,
                dismiss: dismiss
            ),
            .passesThrough
        )
        // The tab bar, one point outside the cutout, and a Trophy Wall card.
        for point in [
            CGPoint(x: 300, y: 820),
            CGPoint(x: 151, y: 736),
            CGPoint(x: 196, y: 300)
        ] {
            XCTAssertEqual(
                ActivationSpotlightHitTestPolicy.outcome(
                    for: point,
                    cutout: cutout,
                    dismiss: dismiss
                ),
                .swallowed,
                "\(point) must not reach the surface behind the mark"
            )
        }
        // A dimming mark names no control, so only Got it survives.
        XCTAssertEqual(
            ActivationSpotlightHitTestPolicy.outcome(
                for: CGPoint(x: 196, y: 736),
                cutout: nil,
                dismiss: dismiss
            ),
            .swallowed
        )
    }

    // MARK: - Bubble placement

    func testTheBubbleTakesTheClearSideOfItsCutoutAndPointsAtIt() {
        let bounds = CGRect(x: 0, y: 0, width: 393, height: 852)

        // The Trophy Wall clock sits in the header, so the bubble hangs below.
        let underneath = ActivationSpotlightBubblePlacementPolicy.placement(
            cutout: CGRect(x: 333, y: 60, width: 52, height: 52),
            bounds: bounds,
            horizontalPadding: 18
        )
        XCTAssertEqual(underneath.tailEdge, .top)
        XCTAssertEqual(underneath.topInset, 124)
        XCTAssertNil(underneath.bottomInset)

        // The Scan shutter sits low, so the bubble takes the band above it.
        let above = ActivationSpotlightBubblePlacementPolicy.placement(
            cutout: CGRect(x: 152, y: 692, width: 88, height: 88),
            bounds: bounds,
            horizontalPadding: 18
        )
        XCTAssertEqual(above.tailEdge, .bottom)
        XCTAssertNil(above.topInset)
        XCTAssertEqual(above.bottomInset, 172)
    }

    /// The tail points at the control, but it cannot leave the bubble: past the
    /// bubble's rounded corner it would render as a detached diamond.
    func testTheTailStaysInsideTheBubbleWhenTheControlIsAtTheEdge() {
        let bounds = CGRect(x: 0, y: 0, width: 393, height: 852)
        let limit = bounds.width / 2 - 18 - 28

        let trailing = ActivationSpotlightBubblePlacementPolicy.placement(
            cutout: CGRect(x: 333, y: 60, width: 52, height: 52),
            bounds: bounds,
            horizontalPadding: 18
        )
        XCTAssertEqual(trailing.tailHorizontalOffset, limit)

        let leading = ActivationSpotlightBubblePlacementPolicy.placement(
            cutout: CGRect(x: 8, y: 60, width: 52, height: 52),
            bounds: bounds,
            horizontalPadding: 18
        )
        XCTAssertEqual(leading.tailHorizontalOffset, -limit)

        let centered = ActivationSpotlightBubblePlacementPolicy.placement(
            cutout: CGRect(x: 152, y: 692, width: 88, height: 88),
            bounds: bounds,
            horizontalPadding: 18
        )
        XCTAssertEqual(centered.tailHorizontalOffset, -0.5)
    }

    // MARK: - The two contextual marks

    func testTheTwoNewMarksCarryTheApprovedCopyAndSurfaces() {
        XCTAssertEqual(
            ActivationCoachMark(state: .act08, surface: .trophyWall),
            .act08
        )
        XCTAssertEqual(
            ActivationCoachMark(state: .act09, surface: .settings),
            .act09
        )
        XCTAssertNil(ActivationCoachMark(state: .act08, surface: .settings))
        XCTAssertNil(ActivationCoachMark(state: .act09, surface: .trophyWall))

        XCTAssertEqual(
            ActivationCoachMark.act08.copy,
            "Tap here to see items still processing."
        )
        XCTAssertEqual(
            ActivationCoachMark.act09.copy,
            "Link eBay here when you're ready to publish."
        )
        // Seller-facing copy never names the pipeline that does the work.
        for coachMark in [ActivationCoachMark.act08, .act09] {
            let copy = coachMark.copy.lowercased()
            for term in ["queue", "worker", "provider", "lease", "job"] {
                XCTAssertFalse(
                    copy.contains(term),
                    "\(coachMark.state.rawValue) leaks \"\(term)\""
                )
            }
        }

        XCTAssertTrue(ActivationCoachMark.act08.isContextual)
        XCTAssertTrue(ActivationCoachMark.act09.isContextual)
        for spine in [
            ActivationCoachMark.act01, .act02, .act02B, .act03, .act04, .act06
        ] {
            XCTAssertFalse(spine.isContextual)
        }
    }

    /// The spine keeps its order. ACT-03 and the clock mark share the Trophy
    /// Wall, and the seller sees the spine line first.
    func testASpineMarkOutranksItsSurfacesContextualMark() {
        var progress = ActivationGuidanceProgress(state: .act03)
        XCTAssertEqual(
            ActivationCoachMarkResolutionPolicy.coachMark(
                progress: progress,
                surface: .trophyWall
            ),
            .act03
        )

        XCTAssertEqual(progress.advance(for: .gotIt), .advanced)
        XCTAssertEqual(
            ActivationCoachMarkResolutionPolicy.coachMark(
                progress: progress,
                surface: .trophyWall
            ),
            .act08
        )
    }

    func testAContextualMarkIsAcknowledgedOnceAndNeverReturns() {
        var progress = ActivationGuidanceProgress(state: .act04)
        XCTAssertEqual(
            ActivationCoachMarkResolutionPolicy.coachMark(
                progress: progress,
                surface: .settings
            ),
            .act09
        )

        XCTAssertTrue(progress.acknowledgeContextualMark(.act09))
        XCTAssertFalse(progress.acknowledgeContextualMark(.act09))
        XCTAssertNil(
            ActivationCoachMarkResolutionPolicy.coachMark(
                progress: progress,
                surface: .settings
            )
        )
        // Acknowledging one says nothing about the other.
        XCTAssertEqual(
            ActivationCoachMarkResolutionPolicy.coachMark(
                progress: progress,
                surface: .trophyWall
            ),
            .act08
        )
        // A spine mark is not acknowledged this way.
        XCTAssertFalse(progress.acknowledgeContextualMark(.act03))
        XCTAssertEqual(progress.state, .act04)
    }

    func testNoSurfaceMeansNoMark() {
        XCTAssertNil(
            ActivationCoachMarkResolutionPolicy.coachMark(
                progress: ActivationGuidanceProgress(state: .act03),
                surface: nil
            )
        )
    }

    /// The contextual marks sit outside the spine, so activation still
    /// completes at ACT-04 for a seller who never opens Settings.
    func testTheContextualMarksAreNotSpinePositions() {
        XCTAssertNil(ActivationGuidanceState(fixtureValue: "ACT-08"))
        XCTAssertNil(ActivationGuidanceState(fixtureValue: "ACT-09"))

        var progress = ActivationGuidanceProgress(state: .act04)
        XCTAssertEqual(
            progress.advance(for: .editedListing),
            .completionRequested
        )
        XCTAssertEqual(
            progress.advance(for: .completionRecorded),
            .completionRecorded
        )
        XCTAssertEqual(progress.state, .act05)
    }

    // MARK: - Persistence migration

    /// A seller mid-flow has a record written before this issue existed. A
    /// synthesized decoder throws on the new key and the store's `try?` turns
    /// that into a silent reset back to ACT-01, so the decoder is explicit.
    func testProgressWrittenBeforeTheContextualMarksExistedStillDecodes() throws {
        let legacy = Data(
            """
            {"state":"ACT-03","hasAcknowledgedCurrentState":true,\
            "isCompletionPending":false}
            """.utf8
        )
        let decoded = try JSONDecoder().decode(
            ActivationGuidanceProgress.self,
            from: legacy
        )
        XCTAssertEqual(decoded.state, .act03)
        XCTAssertTrue(decoded.hasAcknowledgedCurrentState)
        XCTAssertFalse(decoded.isCompletionPending)
        XCTAssertEqual(decoded.acknowledgedContextualMarks, [])

        // An empty record is still the fresh install it always was.
        XCTAssertEqual(
            try JSONDecoder().decode(
                ActivationGuidanceProgress.self,
                from: Data("{}".utf8)
            ),
            ActivationGuidanceProgress()
        )
    }

    func testAcknowledgedContextualMarksSurviveARoundTrip() throws {
        var progress = ActivationGuidanceProgress(state: .act04)
        progress.acknowledgeContextualMark(.act08)

        let decoded = try JSONDecoder().decode(
            ActivationGuidanceProgress.self,
            from: JSONEncoder().encode(progress)
        )
        XCTAssertEqual(decoded, progress)
        XCTAssertEqual(decoded.acknowledgedContextualMarks, [.act08])
    }

    // MARK: - Anchors and assets

    /// #1056 adds no Scout clip. Both new marks reuse the accepted ACT-03
    /// asset rather than inventing one.
    func testTheNewMarksReuseAnAcceptedScoutAsset() {
        for state in [ActivationGuidanceState.act08, .act09] {
            XCTAssertEqual(
                ActivationGuidanceAssetPolicy.selection(
                    for: state,
                    reduceMotion: false
                ),
                .motion(resourceName: "act-03")
            )
            // Reduced Motion always has a static fallback.
            XCTAssertEqual(
                ActivationGuidanceAssetPolicy.selection(
                    for: state,
                    reduceMotion: true
                ),
                .staticImage(name: "ActivationScoutACT03")
            )
        }
    }

    func testTheNewMarksDeclareAnAnchorInBothMotionSettings() {
        for coachMark in [ActivationCoachMark.act08, .act09] {
            for reduceMotion in [false, true] {
                let anchor = ActivationCoachMarkAnchorPolicy.anchor(
                    for: coachMark,
                    reduceMotion: reduceMotion
                )
                XCTAssertEqual(anchor.tailEdge, .bottom)
                XCTAssertEqual(anchor.tailHorizontalOffset, 0)
            }
        }
    }
}
