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

    func testRestoredCaptureFixtureIsExplicitAndZeroNetworkOnly() {
        let configuration = LaunchConfiguration.parse(
            arguments: ["--restored-capture-fixture"]
        )

        XCTAssertTrue(configuration.usesRestoredCaptureFixture)
        XCTAssertTrue(configuration.usesZeroNetworkFixtures)
    }

    func testExplicitVisualStateUsesItsOwningFamilyOverTheDefaultOnboardingFixture() {
        let onboarding = LaunchConfiguration.parse(arguments: ["--visual-state=ONB-01"])
        let capture = LaunchConfiguration.parse(arguments: ["--visual-state=CAP-01"])

        XCTAssertTrue(onboarding.usesOnboarding)
        XCTAssertFalse(capture.usesOnboarding)
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

    @MainActor
    func testRunDeepLinkRoutesTheExactUUIDIntoTheHomeStack() {
        let runID = UUID(uuidString: "31700000-0000-4000-8000-000000000030")!
        let router = AppRouter(initialTab: .inbox)

        let didOpen = router.open(
            URL(string: "snaplist://runs/\(runID.uuidString.lowercased())")!
        )

        XCTAssertTrue(didOpen)
        XCTAssertEqual(router.selectedTab, .home)
        XCTAssertEqual(
            router.pathBinding(for: .home).wrappedValue,
            [.home(.run(runID))]
        )
    }

    @MainActor
    func testRunDeepLinksAcceptTrustedWebRoutesAndRejectMalformedOrForeignURLs() {
        let runID = UUID(uuidString: "31700000-0000-4000-8000-000000000031")!
        let router = AppRouter(initialTab: .listings, initialRoute: .account)

        XCTAssertTrue(
            router.open(URL(string: "https://snaplist.dev/runs/\(runID.uuidString)")!)
        )
        XCTAssertEqual(router.pathBinding(for: .home).wrappedValue, [.home(.run(runID))])

        let rejected = [
            "snaplist://runs/not-a-uuid",
            "snaplist://runs/\(runID.uuidString)?item=another",
            "https://evil.example/runs/\(runID.uuidString)",
            "http://snaplist.dev/runs/\(runID.uuidString)",
            "https://snaplist.dev/runs/\(runID.uuidString)/extra"
        ]
        for rawURL in rejected {
            XCTAssertFalse(router.open(URL(string: rawURL)!))
            XCTAssertEqual(router.pathBinding(for: .home).wrappedValue, [.home(.run(runID))])
        }
    }
}
