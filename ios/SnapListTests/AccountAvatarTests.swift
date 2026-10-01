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
    func testThumbsUpMapsToTheBundledActivationGuidanceClipWithNoDuplicateFile() {
        let scout = TrophyWallScout.thumbsUp
        XCTAssertEqual(scout.clipResource, "act-04")
        XCTAssertEqual(scout.resourceSubdirectory, "ActivationGuidance")
        XCTAssertEqual(scout.legacyFallbackAsset, "ActivationScoutACT04")
        XCTAssertEqual(scout.canvasAspectRatio, 1)
    }

    func testBarcodeScanMapsToTheBundledFirstValueOnboardingClipWithNoDuplicateFile() {
        let scout = TrophyWallScout.barcodeScan
        XCTAssertEqual(scout.clipResource, "032-seedance-barcode-scan")
        XCTAssertEqual(scout.resourceSubdirectory, "FirstValueOnboarding")
        XCTAssertEqual(scout.legacyFallbackAsset, "FirstValueScoutONB03")
        XCTAssertEqual(scout.canvasAspectRatio, 1)
    }

    func testInspectionAndBoxLiftMapToTheirBundledFirstValueOnboardingClips() {
        XCTAssertEqual(TrophyWallScout.inspection.clipResource, "007-seedance-magnifier-inspection")
        XCTAssertEqual(TrophyWallScout.inspection.legacyFallbackAsset, "FirstValueScoutONB02")
        XCTAssertEqual(TrophyWallScout.boxLift.clipResource, "030-seedance-box-lower-lift-hflip-candidate")
        XCTAssertEqual(TrophyWallScout.boxLift.legacyFallbackAsset, "FirstValueScoutONB05")
        for scout: TrophyWallScout in [.inspection, .boxLift] {
            XCTAssertEqual(scout.resourceSubdirectory, "FirstValueOnboarding")
            XCTAssertEqual(scout.canvasAspectRatio, 1)
        }
    }

    func testUncertaintyAndRecoveryStillResolveUnderHomeScoutMotion() {
        XCTAssertEqual(TrophyWallScout.uncertainty.resourceSubdirectory, "HomeScoutMotion")
        XCTAssertEqual(TrophyWallScout.recovery.resourceSubdirectory, "HomeScoutMotion")
        XCTAssertEqual(TrophyWallScout.uncertainty.clipResource, "041-seedance-uncertainty-shrug")
        XCTAssertEqual(TrophyWallScout.recovery.clipResource, "040-seedance-recovery-safe-cue")
    }

    func testEveryCaseResolvesToADistinctClipAndLegacyAsset() {
        let cases: [TrophyWallScout] = [
            .uncertainty, .recovery, .barcodeScan, .thumbsUp, .inspection, .boxLift,
        ]
        XCTAssertEqual(Set(cases.map(\.clipResource)).count, cases.count)
        XCTAssertEqual(Set(cases.map(\.legacyFallbackAsset)).count, cases.count)
    }

    /// This target is app-hosted, so `Bundle.main` is the built SnapList.app —
    /// the same lookup `TrophyWallScoutView` performs. Proves each reused clip
    /// resolves for real from the folder its own screen bundles, without a
    /// duplicate video file in HomeScoutMotion.
    func testNormalMotionResolvesEachReusedClipsAcceptedRuntimeDerivative() {
        for scout: TrophyWallScout in [.barcodeScan, .thumbsUp, .inspection, .boxLift] {
            let rendering = scout.rendering(
                reduceMotion: false,
                arguments: [],
                bundle: .main
            )
            guard case .acceptedRuntimeDerivative(let sourceURL, let url) = rendering else {
                XCTFail("\(scout) did not resolve its accepted runtime derivative: \(rendering)")
                continue
            }
            XCTAssertEqual(sourceURL.deletingPathExtension().lastPathComponent, scout.clipResource)
            XCTAssertEqual(url.deletingPathExtension().lastPathComponent, scout.clipResource)
            XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
        }
    }

    /// The reused clips ship no loose PNG, so Reduced Motion shows the static
    /// frame their own screens already use from the asset catalog.
    func testReducedMotionYieldsEachReusedClipsCatalogStill() {
        for scout: TrophyWallScout in [.barcodeScan, .thumbsUp, .inspection, .boxLift] {
            XCTAssertEqual(
                scout.rendering(reduceMotion: true, arguments: [], bundle: .main),
                .legacyStaticAsset(name: scout.legacyFallbackAsset)
            )
            XCTAssertNotNil(UIImage(named: scout.legacyFallbackAsset), "\(scout)")
        }
    }

    func testUnresolvableBundleDegradesToTheLegacyStaticAsset() {
        let emptyBundle = Bundle(for: XCTestCase.self)
        for scout: TrophyWallScout in [
            .uncertainty, .recovery, .barcodeScan, .thumbsUp, .inspection, .boxLift,
        ] {
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
    func testEmptyCollectionMessageGivesAThumbsUp() {
        let presentation = TrophyWallProcessingView.presentation(
            from: [],
            collectionOutcome: .loaded,
            refreshRecovery: .idle,
            availableHeight: 800,
            isExpanded: false
        )
        XCTAssertEqual(presentation.collectionMessage?.scout, .thumbsUp)
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
        XCTAssertEqual(TrophyWallView.emptyWallScout, .barcodeScan)
        XCTAssertEqual(processingEmpty.collectionMessage?.heading, "Nothing to list.")
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
            XCTAssertNotEqual(processing.collectionMessage?.heading, "Nothing to list.", "\(outcome)")
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
