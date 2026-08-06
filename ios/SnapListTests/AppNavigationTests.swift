import XCTest
@testable import SnapList

final class AppNavigationTests: XCTestCase {
    func testDockCarriesOnlyTheTwoPrimaryDestinationsAndTheCaptureEntry() {
        XCTAssertEqual(
            DockDestination.allCases.map(\.title),
            ["Scan", "Capture", "Trophy Wall"]
        )
        XCTAssertFalse(DockDestination.allCases.map(\.title).contains("Runs"))
        XCTAssertFalse(DockDestination.allCases.map(\.title).contains("You"))
    }

    func testPrimaryNavigationIsExactlyTheTwoApprovedDestinations() {
        XCTAssertEqual(PrimaryTab.allCases.count, 2)
        XCTAssertEqual(
            DockDestination.allCases.compactMap(\.tab),
            PrimaryTab.allCases
        )
    }

    func testRetiredTabsCannotBeRestoredFromAPersistedName() {
        // A tab that stops rendering but still parses from a persisted string stays
        // routable. The enum is the fail-closed boundary, so the retired names must
        // not resolve at all.
        for retired in ["home", "listings", "inbox", "insights"] {
            XCTAssertNil(PrimaryTab(rawValue: retired))
            XCTAssertNil(DockDestination(rawValue: retired))
        }

        // Positive control: the boundary rejects the retired names, not every name.
        XCTAssertEqual(DockDestination(rawValue: "capture"), .capture)
        XCTAssertEqual(PrimaryTab(rawValue: "scan"), .scan)
        XCTAssertEqual(PrimaryTab(rawValue: "trophy-wall"), .trophyWall)
    }

    func testLaunchFixturesNamingARetiredTabResolveToASurvivingDestination() {
        for retired in ["home", "listings", "inbox", "insights"] {
            let configuration = LaunchConfiguration.parse(
                arguments: ["--fixture=\(retired)"]
            )

            XCTAssertNotEqual(configuration.fixture.rawValue, retired)
            XCTAssertEqual(configuration.fixture, .scan)
        }

        // Positive control: a surviving fixture still parses to itself, so the
        // fallback above is a rejection rather than the parser ignoring --fixture.
        XCTAssertEqual(
            LaunchConfiguration.parse(arguments: ["--fixture=trophy-wall"]).fixture,
            .trophyWall
        )
    }

    @MainActor
    func testEachPrimaryTabKeepsAnIndependentNavigationPath() {
        let router = AppRouter()

        router.navigate(to: .activity)
        router.select(.trophyWall)
        router.navigate(to: .settings)

        XCTAssertEqual(router.pathBinding(for: .scan).wrappedValue, [.activity])
        XCTAssertEqual(router.pathBinding(for: .trophyWall).wrappedValue, [.settings])
    }

    @MainActor
    func testCaptureIsASheetAndDoesNotReplaceTheSelectedTab() {
        let router = AppRouter(initialTab: .trophyWall)

        router.select(.capture)

        XCTAssertEqual(router.selectedTab, .trophyWall)
        XCTAssertEqual(router.presentedSheet, .capture)
    }

    @MainActor
    func testReviewBoundaryCarriesTheExactOrderedPhotoSetAndOpenerContext() {
        let photos = (0..<3).map { index in
            StagedCapturePhoto(
                id: UUID(),
                photoURL: URL(fileURLWithPath: "/tmp/photo-\(index).jpg"),
                thumbnailURL: URL(fileURLWithPath: "/tmp/thumb-\(index).jpg"),
                createdAt: Date(timeIntervalSinceReferenceDate: Double(index))
            )
        }
        let router = AppRouter(initialFullScreen: .guidedCamera)

        router.openCaptureBoundary(
            destination: .photoReview,
            photos: photos,
            opener: .reviewButton
        )

        XCTAssertEqual(
            router.captureBoundaryRequest,
            CaptureBoundaryRequest(
                destination: .photoReview,
                photos: photos,
                opener: .reviewButton
            )
        )
        XCTAssertNil(router.presentedFullScreen)
    }

    @MainActor
    func testTrophyWallBoundaryPreservesAnEmptyIntakeAndTabOpenerContext() {
        let router = AppRouter(initialFullScreen: .guidedCamera)

        router.openCaptureBoundary(
            destination: .trophyWall,
            photos: [],
            opener: .trophyWallTab
        )

        XCTAssertEqual(
            router.captureBoundaryRequest,
            CaptureBoundaryRequest(
                destination: .trophyWall,
                photos: [],
                opener: .trophyWallTab
            )
        )
        XCTAssertNil(router.presentedFullScreen)
    }

    @MainActor
    func testLocalPendingRecoveryOpensTheExactOrderedIntakeInPhotoReview() {
        let photos = Self.recoveryPhotos(count: 2)
        let cardIdentity = Self.logicalIdentity(1)
        let router = Self.processingRouter()

        router.openLocalRecovery(
            cardIdentity,
            matching: cardIdentity,
            photos: photos
        )

        XCTAssertEqual(router.selectedTab, .scan)
        XCTAssertEqual(router.pathBinding(for: .trophyWall).wrappedValue, [])
        XCTAssertEqual(
            router.captureBoundaryRequest,
            CaptureBoundaryRequest(
                destination: .photoReview,
                photos: photos,
                opener: .trophyWallTab
            )
        )
        XCTAssertNil(router.presentedFullScreen)
    }

    /// A pending card names one specific local item. Recovery used to ignore that
    /// name and open whatever happened to be staged, after it had already switched
    /// tabs — so a stale card either opened the wrong intake or opened nothing and
    /// stranded the seller on Scan.
    @MainActor
    func testLocalPendingRecoveryRefusesAnIntakeThatIsNotTheTappedCard() {
        let cardIdentity = Self.logicalIdentity(1)
        let cases: [(name: String, intake: TrophyWallLogicalIdentity?, photos: Int)] = [
            ("a different item is staged now", Self.logicalIdentity(2), 2),
            ("the staged photos were discarded", nil, 0),
            ("the card outlived its own intake", nil, 2),
            ("the intake matches but holds no photo", cardIdentity, 0),
        ]

        for testCase in cases {
            let router = Self.processingRouter()

            router.openLocalRecovery(
                cardIdentity,
                matching: testCase.intake,
                photos: Self.recoveryPhotos(count: testCase.photos)
            )

            XCTAssertEqual(router.selectedTab, .trophyWall, testCase.name)
            XCTAssertEqual(
                router.pathBinding(for: .trophyWall).wrappedValue,
                [.home(.processing)],
                testCase.name
            )
            XCTAssertNil(router.captureBoundaryRequest, testCase.name)
            XCTAssertEqual(
                router.presentedFullScreen,
                .guidedCamera,
                testCase.name
            )
        }
    }

    /// The fence used to read "have we observed a principal yet?" off the stored
    /// proof being nil. A signed-out principal has no proof, so signed-in to
    /// signed-out reset but signed-out to signed-in did not, and one seller's local
    /// pending card survived onto another seller's Trophy Wall.
    func testPrincipalFenceResetsOnEveryObservedScopeChangeIncludingFromSignedOut()
        throws {
        let signedIn = try XCTUnwrap(
            ItemRunSubmissionPrincipalScopeProof(verifiedClerkSubject: "user_a")
        )
        let otherSignedIn = try XCTUnwrap(
            ItemRunSubmissionPrincipalScopeProof(verifiedClerkSubject: "user_b")
        )
        var fence = TrophyWallPrincipalFence()

        XCTAssertFalse(
            fence.observe(nil),
            "the first observation is not a transition"
        )
        XCTAssertTrue(
            fence.observe(signedIn),
            "a guest signing in changes the principal"
        )
        XCTAssertFalse(fence.observe(signedIn), "the same principal is not a change")
        XCTAssertTrue(fence.observe(otherSignedIn))
        XCTAssertTrue(fence.observe(nil), "signing out changes the principal")

        // A cold launch that already carries a proof must stay quiet too, or the
        // DEBUG `--fixture=trophy-wall` seed would be wiped before it renders.
        var coldSignedInFence = TrophyWallPrincipalFence()
        XCTAssertFalse(coldSignedInFence.observe(signedIn))
        XCTAssertTrue(coldSignedInFence.observe(nil))
    }

    @MainActor
    private static func processingRouter() -> AppRouter {
        AppRouter(
            initialTab: .trophyWall,
            initialRoute: .home(.processing),
            initialFullScreen: .guidedCamera
        )
    }

    private static func recoveryPhotos(count: Int) -> [StagedCapturePhoto] {
        (0..<count).map { index in
            StagedCapturePhoto(
                id: UUID(),
                photoURL: URL(fileURLWithPath: "/tmp/recovery-photo-\(index).jpg"),
                thumbnailURL: URL(fileURLWithPath: "/tmp/recovery-thumb-\(index).jpg"),
                createdAt: Date(timeIntervalSinceReferenceDate: Double(index))
            )
        }
    }

    private static func logicalIdentity(_ ordinal: Int) -> TrophyWallLogicalIdentity {
        TrophyWallLogicalIdentity(
            idempotencyKey: UUID(
                uuidString: "37500000-0000-4000-8000-00000000001\(ordinal)"
            )!
        )
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

    func testDelayedSubmissionFixtureIsTypedAndUnknownValuesStayInert() {
        let delayed = LaunchConfiguration.parse(
            arguments: ["--submission-fixture=delayed"]
        )
        let rateLimited = LaunchConfiguration.parse(
            arguments: ["--submission-fixture=rate-limited"]
        )
        let acknowledgmentNotification =
            "dev.snaplist.ios.test.submission-ack.\(UUID().uuidString)"
        let accepted = LaunchConfiguration.parse(
            arguments: [
                "--submission-fixture=accepted-presentation-gated",
                "--submission-acknowledgment-notification=\(acknowledgmentNotification)"
            ]
        )
        let unknown = LaunchConfiguration.parse(
            arguments: ["--submission-fixture=unknown"]
        )
        let invalidNotification = LaunchConfiguration.parse(
            arguments: [
                "--submission-acknowledgment-notification=not-a-snaplist-test-signal"
            ]
        )

        XCTAssertEqual(delayed.submissionFixture, .delayed)
        XCTAssertTrue(delayed.usesZeroNetworkFixtures)
        XCTAssertEqual(rateLimited.submissionFixture, .rateLimited)
        XCTAssertTrue(rateLimited.usesZeroNetworkFixtures)
        XCTAssertEqual(
            accepted.submissionFixture,
            .acceptedPresentationGated
        )
        XCTAssertEqual(
            accepted.submissionAcknowledgmentNotification?.rawValue,
            acknowledgmentNotification
        )
        XCTAssertTrue(accepted.usesZeroNetworkFixtures)
        XCTAssertNil(unknown.submissionFixture)
        XCTAssertFalse(unknown.usesZeroNetworkFixtures)
        XCTAssertNil(invalidNotification.submissionAcknowledgmentNotification)
    }

    func testExplicitVisualStateUsesItsOwningFamilyOverTheDefaultOnboardingFixture() {
        let onboarding = LaunchConfiguration.parse(arguments: ["--visual-state=ONB-01"])
        let capture = LaunchConfiguration.parse(arguments: ["--visual-state=CAP-01"])

        XCTAssertTrue(onboarding.usesOnboarding)
        XCTAssertFalse(capture.usesOnboarding)
    }

    func testRunDetailVisualStateLaunchesItsCanonicalRouteInTheTrophyWallStack() {
        let configuration = LaunchConfiguration.parse(arguments: ["--visual-state=RUN-02"])

        XCTAssertEqual(configuration.initialTab, .trophyWall)
        XCTAssertEqual(
            configuration.initialRoute,
            .home(.run(LaunchConfiguration.runDetailFixtureID))
        )
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
    func testRunDeepLinkRoutesTheExactUUIDIntoTheTrophyWallStack() {
        let runID = UUID(uuidString: "31700000-0000-4000-8000-000000000030")!
        let router = AppRouter(initialTab: .scan)

        let didOpen = router.open(
            URL(string: "snaplist://runs/\(runID.uuidString.lowercased())")!
        )

        XCTAssertTrue(didOpen)
        XCTAssertEqual(router.selectedTab, .trophyWall)
        XCTAssertEqual(
            router.pathBinding(for: .trophyWall).wrappedValue,
            [.home(.run(runID))]
        )
    }

    @MainActor
    func testRunDeepLinksAcceptOnlyTheCustomSchemeAndRejectWebOrMalformedURLs() {
        let runID = UUID(uuidString: "31700000-0000-4000-8000-000000000031")!
        let router = AppRouter(initialTab: .trophyWall, initialRoute: .settings)

        XCTAssertEqual(
            RunDeepLink(
                url: URL(string: "snaplist://runs/\(runID.uuidString.lowercased())")!
            ),
            .run(runID)
        )

        let rejected = [
            "https://snaplist.dev/runs/\(runID.uuidString)",
            "https://www.snaplist.dev/runs/\(runID.uuidString)",
            "snaplist://runs/not-a-uuid",
            "snaplist://runs/\(runID.uuidString)?item=another",
            "https://evil.example/runs/\(runID.uuidString)",
            "http://snaplist.dev/runs/\(runID.uuidString)",
            "https://snaplist.dev/runs/\(runID.uuidString)/extra"
        ]
        for rawURL in rejected {
            XCTAssertNil(RunDeepLink(url: URL(string: rawURL)!))
            XCTAssertFalse(router.open(URL(string: rawURL)!))
            XCTAssertEqual(router.selectedTab, .trophyWall)
            XCTAssertEqual(router.pathBinding(for: .trophyWall).wrappedValue, [.settings])
            XCTAssertTrue(router.pathBinding(for: .scan).wrappedValue.isEmpty)
        }
    }
}
