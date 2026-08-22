import SwiftUI
import XCTest
@testable import SnapList

final class AccessibilityFoundationTests: XCTestCase {
    func testFoundationTouchTargetsAreAtLeastFortyFourPoints() {
        XCTAssertGreaterThanOrEqual(SnapListMetrics.minimumTouchTarget, 44)
        XCTAssertGreaterThanOrEqual(SnapListMetrics.primaryButtonHeight, 44)
    }

    /// The fixture override pair was hand-applied at four call sites, and the
    /// fifth — the capture sheet — shipped with neither, which made every Scan
    /// measurement taken through that route a default-size measurement (#836).
    /// `fixtureAccessibilityOverrides` is the single seam that replaced them,
    /// so what has to hold is that it carries both halves: a version that
    /// applied only Dynamic Type would leave `--bold-text` inert everywhere at
    /// once, and would do it silently (#839).
    ///
    /// Asserted on the composed view's type rather than by rendering, because
    /// both modifiers resolve to an environment write that no XCUITest query
    /// can observe. Dropping either `.modifier(...)` from the extension
    /// removes its name from this string and reddens the matching line.
    func testFixtureAccessibilityOverridesCarryBothHalvesOfThePair() {
        let composed = Color.clear.fixtureAccessibilityOverrides(
            LaunchConfiguration.parse(
                arguments: ["--dynamic-type=accessibility5", "--bold-text"]
            )
        )
        let rendered = String(reflecting: type(of: composed))

        XCTAssertTrue(
            rendered.contains("OptionalDynamicTypeModifier"),
            rendered
        )
        XCTAssertTrue(
            rendered.contains("OptionalBoldTextModifier"),
            rendered
        )
    }

    func testEveryTypographyRoleStartsAtTwelvePointsOrLarger() {
        XCTAssertTrue(
            SnapListTypographyToken.allCases.allSatisfy { $0.baseSize >= 12 }
        )
    }

    func testKeyboardVisibilityHidesTheDock() {
        XCTAssertTrue(
            DockVisibilityPolicy.shouldShow(
                isKeyboardVisible: false,
                isLiveCameraPreviewActive: false
            )
        )
        XCTAssertFalse(
            DockVisibilityPolicy.shouldShow(
                isKeyboardVisible: true,
                isLiveCameraPreviewActive: false
            )
        )
    }

    func testLiveCameraPreviewHidesTheDock() {
        XCTAssertTrue(
            DockVisibilityPolicy.shouldShow(
                isKeyboardVisible: false,
                isLiveCameraPreviewActive: false
            )
        )
        XCTAssertFalse(
            DockVisibilityPolicy.shouldShow(
                isKeyboardVisible: false,
                isLiveCameraPreviewActive: true
            )
        )
    }

    func testReducedMotionLaunchFixtureIsDeterministic() {
        let configuration = LaunchConfiguration.parse(
            arguments: ["--reduced-motion", "--zero-network-fixtures"]
        )
        XCTAssertTrue(configuration.forceReducedMotion)
        XCTAssertTrue(configuration.usesZeroNetworkFixtures)
    }

    /// Owner refinement 2 to #1009: Review morphs into a capsule at the
    /// five-photo cap. Reduced Motion must drop that morph to an instant
    /// swap, not merely a shorter animation.
    func testScanReviewCapsuleMorphHonorsReducedMotion() {
        XCTAssertNil(ScanReviewMorphAnimation.curve(reduceMotion: true))
        XCTAssertNotNil(ScanReviewMorphAnimation.curve(reduceMotion: false))
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

    func testStartListingIsOfferedOnlyForOneToFivePhotosWithNoPickerInFlight() {
        for photoCount in 1...5 {
            XCTAssertTrue(
                PhotoReviewStartListingPolicy.isEnabled(
                    photoCount: photoCount,
                    isPickerActive: false
                ),
                "\(photoCount) durable photos are a complete intake."
            )
        }

        XCTAssertFalse(
            PhotoReviewStartListingPolicy.isEnabled(
                photoCount: 0,
                isPickerActive: false
            ),
            "There is nothing to list without a photo."
        )
        XCTAssertFalse(
            PhotoReviewStartListingPolicy.isEnabled(
                photoCount: 6,
                isPickerActive: false
            ),
            "Six photos are outside the approved intake."
        )
        XCTAssertFalse(
            PhotoReviewStartListingPolicy.isEnabled(
                photoCount: 3,
                isPickerActive: true
            ),
            "An in-flight picker means the intake is still changing."
        )
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

    func testMountedLibraryConsumesPendingAddPhotoFocusExactlyOnceAcrossLiveAndRecoverySurfaces() {
        enum Effect: Equatable {
            case focused(ScanLibraryFocusConsumer.MountedLibraryControl)
            case consumedPendingFocus
        }

        var consumer = ScanLibraryFocusConsumer()
        var pendingFocus: PhotoReviewScanFocus? = .addPhotoButton
        var effects: [Effect] = []

        func present(
            _ mountedControl: ScanLibraryFocusConsumer.MountedLibraryControl?
        ) {
            consumer.consume(
                pendingFocus: pendingFocus,
                mountedControl: mountedControl,
                applyAccessibilityFocus: { control in
                    effects.append(.focused(control))
                },
                consumePendingFocus: {
                    pendingFocus = nil
                    effects.append(.consumedPendingFocus)
                }
            )
        }

        present(nil)
        present(nil)
        XCTAssertEqual(
            pendingFocus,
            .addPhotoButton,
            "Preparing-camera phases have no matching mounted target."
        )
        XCTAssertTrue(effects.isEmpty)

        present(.liveLibrary)
        XCTAssertNil(pendingFocus)
        XCTAssertEqual(
            effects,
            [
                .focused(.liveLibrary),
                .consumedPendingFocus,
            ],
            "The mounted Library control receives focus before the request is consumed."
        )

        present(.liveLibrary)
        XCTAssertEqual(
            effects.count,
            2,
            "A same-mount rerender cannot focus or consume twice."
        )

        pendingFocus = .addPhotoButton
        present(.recoveryLibrary)
        XCTAssertNil(pendingFocus)
        XCTAssertEqual(
            effects,
            [
                .focused(.liveLibrary),
                .consumedPendingFocus,
                .focused(.recoveryLibrary),
                .consumedPendingFocus,
            ],
            "Choose from library is the recovery mount for the same pending focus."
        )

        present(.recoveryLibrary)
        XCTAssertEqual(effects.count, 4)

        pendingFocus = .reviewButton
        present(.liveLibrary)
        XCTAssertEqual(pendingFocus, .reviewButton)
        XCTAssertEqual(
            effects.count,
            4,
            "The Library mount cannot consume a Review return."
        )

        // Review, shutter, and picker actions are structurally unable to call this
        // Library-only seam: neither their identities nor an action capability is part
        // of MountedLibraryControl or the consumer interface.
    }

    // MARK: - Address wrapping (UI practice audit, 2026-08-21)

    /// At accessibility5 the Settings profile card renders the seller's own
    /// address in a column narrower than the address, and SwiftUI resolves
    /// that by hyphenating: `jordan.hale@icloud.-com`. The hyphen is not in
    /// the address. What has to hold is that the display copy adds only
    /// zero-width break opportunities, so the layout engine has somewhere
    /// legitimate to break and never invents a character of its own.
    func testTheDisplayAddressAddsOnlyInvisibleBreakOpportunities() {
        let address = "jordan.hale@icloud.com"
        let display = address.withAddressLineBreakOpportunities

        XCTAssertEqual(
            display.replacingOccurrences(of: "\u{200B}", with: ""),
            address,
            "Stripping the inserted breaks must return the seller's exact address."
        )
        XCTAssertEqual(display, "jordan.\u{200B}hale@\u{200B}icloud.\u{200B}com")
        XCTAssertFalse(display.contains("-"))
    }

    /// A break opportunity is only useful where a wrap is plausible. A string
    /// with no separator has no place to break, and must come back untouched
    /// rather than gaining a character.
    func testTheDisplayAddressLeavesAStringWithNoSeparatorAlone() {
        XCTAssertEqual(
            "Not signed in".withAddressLineBreakOpportunities,
            "Not signed in"
        )
    }

    /// The guest profile's address slot holds copy, not an address, and the
    /// member path can render the same value twice across a state change.
    /// Applying the transform to its own output must not keep stacking
    /// separators.
    func testTheDisplayAddressIsIdempotent() {
        let once = "jordan.hale@icloud.com".withAddressLineBreakOpportunities
        XCTAssertEqual(once.withAddressLineBreakOpportunities, once)
    }
}
