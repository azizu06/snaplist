import AVFoundation
import XCTest
@testable import SnapList

final class CaptureDeviceFocusConfigurationTests: XCTestCase {
    func testRestrictsPrimaryConstituentSwitchingToSellerZoomChangesWhenSupported() {
        let settings = CaptureDeviceFocusConfiguration.apply(
            supported: CaptureDeviceFocusConfiguration.Support(
                isContinuousAutoFocusSupported: true,
                isContinuousAutoExposureSupported: true,
                isSmoothAutoFocusSupported: true,
                isAutoFocusRangeRestrictionSupported: true,
                isPrimaryConstituentDeviceSwitchingSupported: true
            )
        )

        XCTAssertEqual(
            settings.primaryConstituentDeviceSwitching,
            CaptureDeviceFocusConfiguration.PrimaryConstituentDeviceSwitching(
                behavior: .restricted,
                restrictedSwitchingBehaviorConditions: [.videoZoomChanged]
            )
        )
    }

    func testAsksForContinuousFocusAndExposureWithoutTheSmoothVideoRamp() {
        let settings = CaptureDeviceFocusConfiguration.apply(
            supported: CaptureDeviceFocusConfiguration.Support(
                isContinuousAutoFocusSupported: true,
                isContinuousAutoExposureSupported: true,
                isSmoothAutoFocusSupported: true,
                isAutoFocusRangeRestrictionSupported: true,
                isPrimaryConstituentDeviceSwitchingSupported: true
            )
        )

        XCTAssertEqual(settings.focusMode, .continuousAutoFocus)
        XCTAssertEqual(settings.exposureMode, .continuousAutoExposure)
        XCTAssertEqual(settings.isSmoothAutoFocusEnabled, false)
        XCTAssertEqual(settings.autoFocusRangeRestriction, AVCaptureDevice.AutoFocusRangeRestriction.none)
    }

    func testMonitorsSubjectAreaChangesOnEveryDevice() {
        let full = CaptureDeviceFocusConfiguration.apply(
            supported: CaptureDeviceFocusConfiguration.Support(
                isContinuousAutoFocusSupported: true,
                isContinuousAutoExposureSupported: true,
                isSmoothAutoFocusSupported: true,
                isAutoFocusRangeRestrictionSupported: true,
                isPrimaryConstituentDeviceSwitchingSupported: true
            )
        )
        let bare = CaptureDeviceFocusConfiguration.apply(
            supported: CaptureDeviceFocusConfiguration.Support(
                isContinuousAutoFocusSupported: false,
                isContinuousAutoExposureSupported: false,
                isSmoothAutoFocusSupported: false,
                isAutoFocusRangeRestrictionSupported: false,
                isPrimaryConstituentDeviceSwitchingSupported: false
            )
        )

        XCTAssertTrue(full.isSubjectAreaChangeMonitoringEnabled)
        XCTAssertTrue(bare.isSubjectAreaChangeMonitoringEnabled)
    }

    func testLeavesEveryUnsupportedKnobToTheDeviceItself() {
        let settings = CaptureDeviceFocusConfiguration.apply(
            supported: CaptureDeviceFocusConfiguration.Support(
                isContinuousAutoFocusSupported: false,
                isContinuousAutoExposureSupported: false,
                isSmoothAutoFocusSupported: false,
                isAutoFocusRangeRestrictionSupported: false,
                isPrimaryConstituentDeviceSwitchingSupported: false
            )
        )

        XCTAssertNil(settings.focusMode)
        XCTAssertNil(settings.exposureMode)
        XCTAssertNil(settings.isSmoothAutoFocusEnabled)
        XCTAssertNil(settings.autoFocusRangeRestriction)
        XCTAssertNil(settings.primaryConstituentDeviceSwitching)
    }

    func testDecidesEachKnobFromItsOwnSupportInput() {
        let focusOnly = CaptureDeviceFocusConfiguration.apply(
            supported: CaptureDeviceFocusConfiguration.Support(
                isContinuousAutoFocusSupported: true,
                isContinuousAutoExposureSupported: false,
                isSmoothAutoFocusSupported: false,
                isAutoFocusRangeRestrictionSupported: false,
                isPrimaryConstituentDeviceSwitchingSupported: false
            )
        )
        XCTAssertEqual(focusOnly.focusMode, .continuousAutoFocus)
        XCTAssertNil(focusOnly.exposureMode)
        XCTAssertNil(focusOnly.isSmoothAutoFocusEnabled)
        XCTAssertNil(focusOnly.primaryConstituentDeviceSwitching)

        let switchingOnly = CaptureDeviceFocusConfiguration.apply(
            supported: CaptureDeviceFocusConfiguration.Support(
                isContinuousAutoFocusSupported: false,
                isContinuousAutoExposureSupported: false,
                isSmoothAutoFocusSupported: false,
                isAutoFocusRangeRestrictionSupported: false,
                isPrimaryConstituentDeviceSwitchingSupported: true
            )
        )
        XCTAssertNil(switchingOnly.focusMode)
        XCTAssertEqual(
            switchingOnly.primaryConstituentDeviceSwitching?.behavior,
            .restricted
        )
    }
}
