import XCTest
@testable import SnapList

/// `AccountInitials.from` is the one derivation both the Trophy Wall header
/// avatar and Settings call, so a signed-in seller's initials cannot drift
/// between the two (#1051).
final class AccountInitialsTests: XCTestCase {
    func testFirstAndLastNameUppercasesBothInitials() {
        XCTAssertEqual(
            AccountInitials.from(firstName: "Jordan", lastName: "Hale", isSignedIn: true),
            "JH"
        )
    }

    func testFirstNameOnlyUsesItsSingleInitial() {
        XCTAssertEqual(
            AccountInitials.from(firstName: "Jordan", lastName: nil, isSignedIn: true),
            "J"
        )
    }

    func testSignedInWithNoNameFallsBackToS() {
        XCTAssertEqual(
            AccountInitials.from(firstName: nil, lastName: nil, isSignedIn: true),
            "S"
        )
        XCTAssertEqual(
            AccountInitials.from(firstName: "", lastName: "", isSignedIn: true),
            "S"
        )
    }

    func testGuestFallsBackToGRegardlessOfAnyNameSupplied() {
        XCTAssertEqual(
            AccountInitials.from(firstName: "Jordan", lastName: "Hale", isSignedIn: false),
            "G"
        )
        XCTAssertEqual(
            AccountInitials.from(firstName: nil, lastName: nil, isSignedIn: false),
            "G"
        )
    }

    func testLowercaseInputIsUppercased() {
        XCTAssertEqual(
            AccountInitials.from(firstName: "jordan", lastName: "hale", isSignedIn: true),
            "JH"
        )
    }
}

/// `TrophyWallScout` case-to-clip mapping is the pure seam: every case must
/// resolve to a distinct clip/fallback/legacy asset and never to a duplicate
/// video file already bundled elsewhere (#1051).
final class TrophyWallScoutMappingTests: XCTestCase {
    func testReassuranceMapsToTheBundledFirstValueOnboardingClipWithNoDuplicateFile() {
        let scout = TrophyWallScout.reassurance
        XCTAssertEqual(scout.clipResource, "042-seedance-reassurance")
        XCTAssertEqual(scout.resourceSubdirectory, "FirstValueOnboarding")
        XCTAssertEqual(scout.legacyFallbackAsset, "FirstValueScoutONB06")
        XCTAssertEqual(scout.canvasAspectRatio, 1)
    }

    func testUncertaintyAndRecoveryStillResolveUnderHomeScoutMotion() {
        XCTAssertEqual(TrophyWallScout.uncertainty.resourceSubdirectory, "HomeScoutMotion")
        XCTAssertEqual(TrophyWallScout.recovery.resourceSubdirectory, "HomeScoutMotion")
        XCTAssertEqual(TrophyWallScout.uncertainty.clipResource, "041-seedance-uncertainty-shrug")
        XCTAssertEqual(TrophyWallScout.recovery.clipResource, "040-seedance-recovery-safe-cue")
    }

    func testEveryCaseResolvesToADistinctClipAndLegacyAsset() {
        let cases: [TrophyWallScout] = [.uncertainty, .recovery, .reassurance]
        XCTAssertEqual(Set(cases.map(\.clipResource)).count, cases.count)
        XCTAssertEqual(Set(cases.map(\.legacyFallbackAsset)).count, cases.count)
    }

    /// This target is app-hosted, so `Bundle.main` is the built SnapList.app —
    /// the same lookup `TrophyWallScoutView` performs. Proves the reassurance
    /// clip resolves for real, without duplicating the FirstValueOnboarding
    /// video files into HomeScoutMotion.
    func testNormalMotionResolvesTheReassuranceClipsAcceptedRuntimeDerivative() {
        let rendering = TrophyWallScout.reassurance.rendering(
            reduceMotion: false,
            arguments: [],
            bundle: .main
        )
        guard case .acceptedRuntimeDerivative(let sourceURL, let url) = rendering else {
            XCTFail("Reassurance did not resolve its accepted runtime derivative: \(rendering)")
            return
        }
        XCTAssertEqual(sourceURL.deletingPathExtension().lastPathComponent, "042-seedance-reassurance")
        XCTAssertEqual(url.deletingPathExtension().lastPathComponent, "042-seedance-reassurance")
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
    }

    func testReducedMotionYieldsTheReassuranceStaticFallback() {
        let rendering = TrophyWallScout.reassurance.rendering(
            reduceMotion: true,
            arguments: [],
            bundle: .main
        )
        guard case .staticPNG(let url) = rendering else {
            XCTFail("Reduced Motion did not select the reassurance static fallback: \(rendering)")
            return
        }
        XCTAssertEqual(url.deletingPathExtension().lastPathComponent, "042-reassurance")
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
    }

    func testUnresolvableBundleDegradesToTheLegacyStaticAsset() {
        let emptyBundle = Bundle(for: XCTestCase.self)
        for scout: TrophyWallScout in [.uncertainty, .recovery, .reassurance] {
            XCTAssertEqual(
                scout.rendering(reduceMotion: false, arguments: [], bundle: emptyBundle),
                .legacyStaticAsset(name: scout.legacyFallbackAsset)
            )
        }
    }
}

/// Processing empty (`emptyCollectionMessage`) and Trophy Wall empty use
/// visibly different clips so the seller does not see the same animation
/// twice back to back; unavailable keeps the existing recovery clip (#1051).
final class TrophyWallCollectionMessageScoutTests: XCTestCase {
    func testEmptyCollectionMessageUsesReassurance() {
        let presentation = TrophyWallProcessingView.presentation(
            from: [],
            collectionOutcome: .loaded,
            refreshRecovery: .idle,
            availableHeight: 800,
            isExpanded: false
        )
        XCTAssertEqual(presentation.collectionMessage?.scout, .reassurance)
    }

    /// The Processing dock slot now opens its screen with nothing in flight,
    /// so its loaded-empty state sits one tap from Trophy Wall's genuinely
    /// empty state. They must stay distinct Scout states, and neither may be
    /// claimed before the collection is proved.
    func testLoadedEmptyProcessingAndEmptyTrophyWallAreDistinctScoutStates() {
        let processingEmpty = TrophyWallProcessingView.presentation(
            from: [],
            collectionOutcome: .loaded,
            refreshRecovery: .idle,
            availableHeight: 800,
            isExpanded: false
        )
        let wallEmpty = TrophyWallView.presentation(
            hasSettledTiles: false,
            collectionOutcome: .loaded,
            refreshRecovery: .idle
        )

        XCTAssertTrue(wallEmpty.showsEmptyView)
        XCTAssertEqual(TrophyWallView.emptyWallScout, .uncertainty)
        XCTAssertEqual(processingEmpty.collectionMessage?.heading, "Nothing is processing.")
        XCTAssertNotEqual(processingEmpty.collectionMessage?.scout, TrophyWallView.emptyWallScout)
    }

    func testNeitherScreenClaimsEmptyWhileLoadingOrUnavailable() {
        for outcome in [TrophyWallCollectionOutcome.unknown, .offline, .unavailable] {
            let processing = TrophyWallProcessingView.presentation(
                from: [],
                collectionOutcome: outcome,
                refreshRecovery: .idle,
                availableHeight: 800,
                isExpanded: false
            )
            let wall = TrophyWallView.presentation(
                hasSettledTiles: false,
                collectionOutcome: outcome,
                refreshRecovery: .idle
            )

            XCTAssertFalse(wall.showsEmptyView, "\(outcome)")
            XCTAssertNotEqual(processing.collectionMessage?.heading, "Nothing is processing.", "\(outcome)")
            if outcome == .unknown {
                XCTAssertNil(processing.collectionMessage)
                XCTAssertNil(wall.collectionMessage)
            } else {
                XCTAssertEqual(processing.collectionMessage?.scout, .recovery, "\(outcome)")
                XCTAssertEqual(wall.collectionMessage?.scout, .recovery, "\(outcome)")
            }
        }
    }

    func testUnavailableCollectionMessageKeepsRecovery() {
        XCTAssertEqual(
            TrophyWallProcessingView.unavailableCollectionMessage.scout,
            .recovery
        )
    }
}
