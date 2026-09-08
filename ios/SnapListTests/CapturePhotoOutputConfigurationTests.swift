import XCTest
@testable import SnapList

final class CapturePhotoOutputConfigurationTests: XCTestCase {
    func testEnablesResponsiveCaptureAndFastCapturePrioritizationWhenSupported() {
        let flags = CapturePhotoOutputConfiguration.apply(
            supported: CapturePhotoOutputConfiguration.Support(
                isResponsiveCaptureSupported: true,
                isFastCapturePrioritizationSupported: true
            )
        )

        XCTAssertTrue(flags.isResponsiveCaptureEnabled)
        XCTAssertTrue(flags.isFastCapturePrioritizationEnabled)
    }

    func testLeavesFlagsUntouchedWhenUnsupported() {
        let flags = CapturePhotoOutputConfiguration.apply(
            supported: CapturePhotoOutputConfiguration.Support(
                isResponsiveCaptureSupported: false,
                isFastCapturePrioritizationSupported: false
            )
        )

        XCTAssertFalse(flags.isResponsiveCaptureEnabled)
        XCTAssertFalse(flags.isFastCapturePrioritizationEnabled)
    }

    func testNeverEnablesDeferredPhotoDeliveryRegardlessOfSupport() {
        let allSupported = CapturePhotoOutputConfiguration.apply(
            supported: CapturePhotoOutputConfiguration.Support(
                isResponsiveCaptureSupported: true,
                isFastCapturePrioritizationSupported: true
            )
        )
        let noneSupported = CapturePhotoOutputConfiguration.apply(
            supported: CapturePhotoOutputConfiguration.Support(
                isResponsiveCaptureSupported: false,
                isFastCapturePrioritizationSupported: false
            )
        )

        XCTAssertFalse(allSupported.isAutoDeferredPhotoDeliveryEnabled)
        XCTAssertFalse(noneSupported.isAutoDeferredPhotoDeliveryEnabled)
    }

    func testFlagsTrackEachSupportInputIndependently() {
        let responsiveOnly = CapturePhotoOutputConfiguration.apply(
            supported: CapturePhotoOutputConfiguration.Support(
                isResponsiveCaptureSupported: true,
                isFastCapturePrioritizationSupported: false
            )
        )
        XCTAssertTrue(responsiveOnly.isResponsiveCaptureEnabled)
        XCTAssertFalse(responsiveOnly.isFastCapturePrioritizationEnabled)

        let fastCaptureOnly = CapturePhotoOutputConfiguration.apply(
            supported: CapturePhotoOutputConfiguration.Support(
                isResponsiveCaptureSupported: false,
                isFastCapturePrioritizationSupported: true
            )
        )
        XCTAssertFalse(fastCaptureOnly.isResponsiveCaptureEnabled)
        XCTAssertTrue(fastCaptureOnly.isFastCapturePrioritizationEnabled)
    }
}
