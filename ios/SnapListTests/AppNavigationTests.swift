import XCTest
@testable import SnapList

final class AppNavigationTests: XCTestCase {
    func testDockHasExactlyTheApprovedFiveDestinationsInOrder() {
        XCTAssertEqual(
            DockDestination.allCases.map(\.title),
            ["Home", "Listings", "Capture", "Inbox", "Insights"]
        )
        XCTAssertFalse(DockDestination.allCases.map(\.title).contains("Runs"))
        XCTAssertFalse(DockDestination.allCases.map(\.title).contains("You"))
    }

    @MainActor
    func testEachPrimaryTabKeepsAnIndependentNavigationPath() {
        let router = AppRouter()

        router.navigate(to: .activity)
        router.select(.listings)
        router.navigate(to: .account)

        XCTAssertEqual(router.pathBinding(for: .home).wrappedValue, [.activity])
        XCTAssertEqual(router.pathBinding(for: .listings).wrappedValue, [.account])
    }

    @MainActor
    func testCaptureIsASheetAndDoesNotReplaceTheSelectedTab() {
        let router = AppRouter(initialTab: .inbox)

        router.select(.capture)

        XCTAssertEqual(router.selectedTab, .inbox)
        XCTAssertEqual(router.presentedSheet, .capture)
    }

    func testLaunchArgumentsAcceptApprovedStatesAndRejectCandidateStates() {
        for state in ApprovedVisualStateID.allCases {
            let configuration = LaunchConfiguration.parse(
                arguments: ["--visual-state=\(state.rawValue)"]
            )
            XCTAssertEqual(configuration.visualState, state)
            XCTAssertTrue(configuration.usesZeroNetworkFixtures)
        }

        let candidate = LaunchConfiguration.parse(arguments: ["--visual-state=CAP-03a"])
        let barcode = LaunchConfiguration.parse(arguments: ["--visual-state=CAP-05"])
        XCTAssertNil(candidate.visualState)
        XCTAssertNil(barcode.visualState)
    }

    @MainActor
    func testEveryFoundationFixtureProducesItsTypedInitialState() {
        for fixture in FoundationFixture.allCases {
            let router = AppRouter(
                initialTab: fixture.initialTab,
                initialRoute: fixture.initialRoute,
                initialSheet: fixture.initialSheet
            )

            XCTAssertEqual(router.selectedTab, fixture.initialTab)
            XCTAssertEqual(router.presentedSheet, fixture.initialSheet)
            XCTAssertEqual(
                router.pathBinding(for: fixture.initialTab).wrappedValue,
                fixture.initialRoute.map { [$0] } ?? []
            )
        }
    }
}
