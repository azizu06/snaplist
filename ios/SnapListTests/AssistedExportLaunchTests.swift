import XCTest
@testable import SnapList

/// The launch seam for the assisted-export fixture host (issue #581).
///
/// Kept apart from `AssistedExportDomainTests` because the domain is pure
/// Foundation and runs anywhere, while `LaunchConfiguration` reaches into the
/// app's navigation types.
final class AssistedExportLaunchTests: XCTestCase {
    func testTheFixtureArgumentNamesAScenarioAndSuppressesNetworkFixtures() {
        let configuration = LaunchConfiguration.parse(arguments: [
            "--assisted-export-fixture=pack-update-while-confirming"
        ])

        XCTAssertEqual(
            configuration.assistedExportFixture,
            .packUpdateWhileConfirming
        )
        XCTAssertTrue(
            configuration.usesZeroNetworkFixtures,
            "A fixture host must not reach a server."
        )
    }

    /// The default fixture is `.onboarding`, so without this the app shows
    /// onboarding and the assisted-export screen never renders. The failure is
    /// silent — a UI test would report a missing element rather than the real
    /// cause — which is why it is worth a unit test.
    func testLaunchingIntoAssistedExportDoesNotLandOnOnboarding() {
        let configuration = LaunchConfiguration.parse(arguments: [
            "--assisted-export-fixture=prepared"
        ])

        XCTAssertFalse(configuration.usesOnboarding)
    }

    func testAnUnknownScenarioNameSelectsNoFixtureRatherThanAWrongOne() {
        let configuration = LaunchConfiguration.parse(arguments: [
            "--assisted-export-fixture=shared"
        ])

        XCTAssertNil(configuration.assistedExportFixture)
        XCTAssertTrue(configuration.usesOnboarding)
    }
}
