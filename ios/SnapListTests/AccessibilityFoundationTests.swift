import XCTest
@testable import SnapList

final class AccessibilityFoundationTests: XCTestCase {
    func testFoundationTouchTargetsAreAtLeastFortyFourPoints() {
        XCTAssertGreaterThanOrEqual(SnapListMetrics.minimumTouchTarget, 44)
        XCTAssertGreaterThanOrEqual(SnapListMetrics.primaryButtonHeight, 44)
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
}
