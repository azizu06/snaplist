import XCTest
@testable import SnapList

/// Issue #1133. The activation tour is the Scout strip's brain: which of the
/// six steps the seller is on, what the segmented rail looks like, and when the
/// strip has nothing left to say. Everything here is a pure function over
/// persisted progress and the surface on screen, so the strip itself never has
/// to decide anything.
final class ActivationTourPolicyTests: XCTestCase {
    // MARK: - The spine

    /// The tour is six steps in one order, and the current step is the first
    /// one the seller has not performed yet. Nothing advances it but a real
    /// action, so this is the only way forward.
    func testTheTourWalksItsSixStepsInOrderAndEndsWhenEveryOneIsDone() {
        XCTAssertEqual(
            ActivationTourStep.allCases,
            [
                .openScan,
                .takePhoto,
                .startListing,
                .openReadyItem,
                .reviewPriceAndDetails,
                .publishOrShare
            ],
            "the owner's flow: camera, photos, start, ready, review, publish"
        )

        var progress = ActivationTourProgress()
        for step in ActivationTourStep.allCases {
            XCTAssertEqual(
                ActivationTourPolicy.currentStep(progress),
                step,
                "\(step) is next until it has been done"
            )
            XCTAssertFalse(ActivationTourPolicy.isFinished(progress))
            XCTAssertTrue(
                progress.complete(step),
                "completing a step the first time is a real change"
            )
            XCTAssertFalse(
                progress.complete(step),
                "and completing it again changes nothing"
            )
        }

        XCTAssertNil(ActivationTourPolicy.currentStep(progress))
        XCTAssertTrue(ActivationTourPolicy.isFinished(progress))
    }

    /// A seller who reaches a later step first — a restored draft that lands
    /// straight in Listing Review, say — has genuinely done that step. The tour
    /// records it and keeps pointing at the earliest one still outstanding
    /// rather than pretending the later one did not happen.
    func testAStepDoneOutOfOrderIsRecordedAndTheTourFallsBackToTheEarliestOutstandingOne() {
        var progress = ActivationTourProgress()
        XCTAssertTrue(progress.complete(.reviewPriceAndDetails))

        XCTAssertEqual(ActivationTourPolicy.currentStep(progress), .openScan)
        XCTAssertFalse(ActivationTourPolicy.isFinished(progress))

        for step in ActivationTourStep.allCases
        where step != .reviewPriceAndDetails {
            _ = progress.complete(step)
        }
        XCTAssertTrue(
            ActivationTourPolicy.isFinished(progress),
            "the out-of-order step still counts towards the end of the tour"
        )
    }
}

// MARK: - What a step says and shows

extension ActivationTourPolicyTests {
    /// Option E gives each step one short line, one Scout pose, the surface it
    /// belongs to, and the one control it points at. The rail is the only
    /// progress indicator, so the line never carries a count.
    func testEveryStepNamesItsLineSurfacePoseAndSpotlightTarget() {
        let expected: [ActivationTourStep: (String, ActivationGuidanceSurface, ActivationSpotlightTarget)] = [
            .openScan: (
                "Tap the camera to start a listing.",
                .trophyWall,
                .scanEntry
            ),
            .takePhoto: ("Snap up to five photos.", .scan, .scanShutter),
            .startListing: (
                "Add a voice note, then start.",
                .photoReview,
                .photoReviewStartListing
            ),
            .openReadyItem: (
                "Tap Review when it's ready.",
                .trophyWall,
                .trophyWallReadyItem
            ),
            .reviewPriceAndDetails: (
                "Check the price and details.",
                .listingReview,
                .listingReviewPrice
            ),
            .publishOrShare: (
                "Publish to eBay, or share it.",
                .listingReview,
                .listingReviewPublish
            )
        ]

        for step in ActivationTourStep.allCases {
            let (line, surface, target) = expected[step]!
            XCTAssertEqual(step.instruction, line)
            XCTAssertEqual(step.surface, surface)
            XCTAssertEqual(step.spotlightTarget, target)
            XCTAssertLessThanOrEqual(
                step.instruction.split(separator: " ").count,
                8,
                "\(step) has to stay one short sentence"
            )
            XCTAssertFalse(
                step.instruction.contains(" of 6"),
                "the rail carries progress; the line never repeats it"
            )
        }

        XCTAssertEqual(
            Set(ActivationTourStep.allCases.map(\.scoutPose)).count,
            5,
            "five distinct poses across six steps, as the prototype draws them"
        )
    }

    /// VoiceOver still hears the count the rail shows visually, and it is read
    /// with the line as one announcement rather than as a separate element.
    func testTheStripAnnouncesTheStepNumberEvenThoughNoCountIsDrawn() {
        XCTAssertEqual(
            ActivationTourStep.takePhoto.announcement,
            "Step 2 of 6. Snap up to five photos."
        )
        XCTAssertEqual(
            ActivationTourStep.publishOrShare.announcement,
            "Step 6 of 6. Publish to eBay, or share it."
        )
    }

    // MARK: - The segmented rail

    /// The owner's rail: one segment per step, the current one an elongated
    /// pill, everything done filled, everything left muted. It is the single
    /// progress signal, so it always has exactly six segments.
    func testTheRailMarksDoneStepsFilledTheCurrentOneAndTheRestMuted() {
        var progress = ActivationTourProgress()
        XCTAssertEqual(
            ActivationTourPolicy.rail(progress),
            [.current, .remaining, .remaining, .remaining, .remaining, .remaining]
        )

        progress.complete(.openScan)
        progress.complete(.takePhoto)
        XCTAssertEqual(
            ActivationTourPolicy.rail(progress),
            [.completed, .completed, .current, .remaining, .remaining, .remaining]
        )

        /// A step done out of order reads as done where it sits; the rail never
        /// invents a second current segment.
        progress.complete(.publishOrShare)
        XCTAssertEqual(
            ActivationTourPolicy.rail(progress),
            [.completed, .completed, .current, .remaining, .remaining, .completed]
        )

        for step in ActivationTourStep.allCases { progress.complete(step) }
        XCTAssertEqual(
            ActivationTourPolicy.rail(progress),
            Array(repeating: .completed, count: 6),
            "a finished tour has no current segment left"
        )
    }
}

// MARK: - When the strip is on screen, and in which shape

extension ActivationTourPolicyTests {
    private func strip(
        _ presentation: ActivationTourPresentation
    ) -> ActivationTourStripModel? {
        guard case .strip(let model) = presentation else { return nil }
        return model
    }

    /// A step speaks only where its control lives. Standing anywhere else
    /// during a step shows nothing at all rather than pointing off screen.
    func testTheStripOnlyAppearsOnTheSurfaceThatHoldsTheCurrentStepsControl() {
        let progress = ActivationTourProgress()

        XCTAssertEqual(
            strip(
                ActivationTourPresentationPolicy.presentation(
                    progress: progress,
                    surface: .trophyWall,
                    isEligible: true
                )
            )?.step,
            .openScan
        )

        for elsewhere in [ActivationGuidanceSurface.scan, .photoReview,
                          .listingReview, .settings] {
            XCTAssertEqual(
                ActivationTourPresentationPolicy.presentation(
                    progress: progress,
                    surface: elsewhere,
                    isEligible: true
                ),
                .hidden,
                "step one points at the camera entry, which only Trophy Wall has"
            )
        }

        XCTAssertEqual(
            ActivationTourPresentationPolicy.presentation(
                progress: progress,
                surface: nil,
                isEligible: true
            ),
            .hidden,
            "a surface the tour does not know about shows nothing"
        )
    }

    /// Skip is the step-one bargain: quit now or stop being asked. From step
    /// two the chevron collapses the strip to a Scout bubble instead.
    func testSkipIsOfferedOnlyOnStepOneAndTheChevronTakesOverAfterwards() {
        var progress = ActivationTourProgress()
        let first = strip(
            ActivationTourPresentationPolicy.presentation(
                progress: progress,
                surface: .trophyWall,
                isEligible: true
            )
        )
        XCTAssertEqual(first?.showsSkip, true)
        XCTAssertEqual(first?.showsCollapseChevron, false)

        progress.complete(.openScan)
        let second = strip(
            ActivationTourPresentationPolicy.presentation(
                progress: progress,
                surface: .scan,
                isEligible: true
            )
        )
        XCTAssertEqual(second?.step, .takePhoto)
        XCTAssertEqual(second?.showsSkip, false)
        XCTAssertEqual(second?.showsCollapseChevron, true)
        XCTAssertEqual(second?.rail, ActivationTourPolicy.rail(progress))
    }

    /// Collapsing keeps Scout on screen in the current pose and survives a
    /// relaunch, because it is part of the persisted record.
    func testCollapsingLeavesAScoutBubbleAndIsRemembered() {
        var progress = ActivationTourProgress()
        progress.complete(.openScan)
        progress.isCollapsed = true

        XCTAssertEqual(
            ActivationTourPresentationPolicy.presentation(
                progress: progress,
                surface: .scan,
                isEligible: true
            ),
            .collapsedBubble(step: .takePhoto)
        )

        let store = UserDefaultsActivationTourProgressStore(
            defaults: UserDefaults(suiteName: #function)!
        )
        store.save(progress, for: "guest")
        XCTAssertEqual(store.load(for: "guest"), progress)
    }

    /// Skipping ends the tour there and then: nothing draws again, not even
    /// the closing line, and no step is invented as done.
    func testSkippingTheTourSilencesItWithoutClaimingTheStepsWereDone() {
        var progress = ActivationTourProgress()
        progress.isSkipped = true

        XCTAssertEqual(
            ActivationTourPresentationPolicy.presentation(
                progress: progress,
                surface: .trophyWall,
                isEligible: true
            ),
            .hidden
        )
        XCTAssertTrue(
            ActivationTourPolicy.isRetired(progress),
            "a skipped tour is finished as far as the shell is concerned"
        )
        XCTAssertFalse(
            ActivationTourPolicy.isFinished(progress),
            "but it never pretends the steps happened"
        )
    }

    /// The end of the tour is one line, once, on whichever surface the seller
    /// is standing on — then silence for good.
    func testTheClosingLineShowsOnceAfterEveryStepAndNeverReturns() {
        var progress = ActivationTourProgress()
        for step in ActivationTourStep.allCases { progress.complete(step) }

        XCTAssertEqual(
            ActivationTourPresentationPolicy.presentation(
                progress: progress,
                surface: .listingReview,
                isEligible: true
            ),
            .closingLine(ActivationTourCopy.closingLine)
        )

        progress.hasSeenClosingLine = true
        for surface in ActivationGuidanceSurface.allCases {
            XCTAssertEqual(
                ActivationTourPresentationPolicy.presentation(
                    progress: progress,
                    surface: surface,
                    isEligible: true
                ),
                .hidden
            )
        }
        XCTAssertTrue(ActivationTourPolicy.isRetired(progress))
    }

    /// The shell owns eligibility — onboarding, the completion marker, the
    /// authentication check. When it says no, the tour draws nothing whatever
    /// its own record says.
    func testAnIneligibleShellSilencesTheTourEntirely() {
        XCTAssertEqual(
            ActivationTourPresentationPolicy.presentation(
                progress: ActivationTourProgress(),
                surface: .trophyWall,
                isEligible: false
            ),
            .hidden
        )
    }

    /// Replay the tour, from Settings. Everything goes back to the start —
    /// including a collapse and a skip the seller may have chosen last time.
    func testReplayingTheTourClearsEveryRecordedChoice() {
        var progress = ActivationTourProgress()
        for step in ActivationTourStep.allCases { progress.complete(step) }
        progress.isCollapsed = true
        progress.isSkipped = true
        progress.hasSeenClosingLine = true

        progress.replay()

        XCTAssertEqual(progress, ActivationTourProgress())
        XCTAssertEqual(ActivationTourPolicy.currentStep(progress), .openScan)
        XCTAssertFalse(ActivationTourPolicy.isRetired(progress))
    }
}

// MARK: - The spotlight

extension ActivationTourPolicyTests {
    private static let screen = CGRect(x: 0, y: 0, width: 393, height: 852)

    /// The halo is drawn around the control's own frame and follows it. Scroll
    /// the control, rotate the device, grow the type — the frame changes and so
    /// does the halo, because nothing here is a coordinate anyone wrote down.
    func testTheHaloTracksTheControlsRealFrame() {
        let atRest = CGRect(x: 40, y: 600, width: 160, height: 52)
        let scrolled = atRest.offsetBy(dx: 0, dy: -220)

        let first = ActivationSpotlightHaloPolicy.halo(
            for: .photoReviewStartListing,
            targetFrame: atRest,
            bounds: Self.screen
        )
        let second = ActivationSpotlightHaloPolicy.halo(
            for: .photoReviewStartListing,
            targetFrame: scrolled,
            bounds: Self.screen
        )

        XCTAssertEqual(
            first?.frame,
            atRest.insetBy(
                dx: -ActivationSpotlightHaloPolicy.padding,
                dy: -ActivationSpotlightHaloPolicy.padding
            )
        )
        XCTAssertEqual(
            second?.frame.midY,
            first!.frame.midY - 220,
            "the halo moved exactly as far as the control did"
        )
    }

    /// A control that has not laid out, or has scrolled off the screen, gets no
    /// halo at all. Failing open keeps the guarantee that nothing is ever
    /// covered or blocked by a glow with nothing under it.
    func testAnUnanchoredOrOffscreenControlDrawsNoHalo() {
        XCTAssertNil(
            ActivationSpotlightHaloPolicy.halo(
                for: .scanShutter,
                targetFrame: nil,
                bounds: Self.screen
            )
        )
        XCTAssertNil(
            ActivationSpotlightHaloPolicy.halo(
                for: .scanShutter,
                targetFrame: .zero,
                bounds: Self.screen
            )
        )
        XCTAssertNil(
            ActivationSpotlightHaloPolicy.halo(
                for: .scanShutter,
                targetFrame: CGRect(x: 40, y: -400, width: 72, height: 72),
                bounds: Self.screen
            ),
            "scrolled fully out of sight is the same as not being there"
        )
    }

    /// The halo takes the control's own shape, so a round shutter never gets a
    /// rounded-rectangle glow.
    func testTheHaloTakesTheControlsOwnShape() {
        for round in [ActivationSpotlightTarget.scanShutter, .scanEntry] {
            XCTAssertEqual(
                ActivationSpotlightHaloPolicy.halo(
                    for: round,
                    targetFrame: CGRect(x: 160, y: 700, width: 72, height: 72),
                    bounds: Self.screen
                )?.shape,
                .circle
            )
        }

        guard case .roundedRectangle(let radius)? =
                ActivationSpotlightHaloPolicy.halo(
                    for: .listingReviewPublish,
                    targetFrame: CGRect(x: 16, y: 700, width: 360, height: 52),
                    bounds: Self.screen
                )?.shape
        else { return XCTFail("a capsule button is not a circle") }
        XCTAssertGreaterThan(radius, 0)
    }

    // MARK: - Advancing on real actions

    /// Every step is completed by something the seller did in the app. There is
    /// no signal for "tapped Next", because there is no Next.
    func testEachStepIsCompletedByItsOwnRealAction() {
        let expected: [ActivationTourSignal: ActivationTourStep] = [
            .arrivedOnScan: .openScan,
            .capturedPhoto: .takePhoto,
            .submittedItem: .startListing,
            .openedListingReview: .openReadyItem,
            .editedListingDetails: .reviewPriceAndDetails,
            .reachedPublishOrShare: .publishOrShare
        ]

        var progress = ActivationTourProgress()
        for signal in ActivationTourSignal.allCases {
            let step = expected[signal]!
            XCTAssertEqual(step.completingSignal, signal)
            XCTAssertTrue(progress.record(signal))
            XCTAssertTrue(progress.completedSteps.contains(step))
            XCTAssertFalse(
                progress.record(signal),
                "the same action twice is still one completed step"
            )
        }
        XCTAssertTrue(ActivationTourPolicy.isFinished(progress))
    }

    /// A skipped tour stops listening. Otherwise a seller who quit on step one
    /// would silently "finish" it by using the app and get the closing line.
    func testASkippedTourStopsRecordingActions() {
        var progress = ActivationTourProgress()
        progress.isSkipped = true
        XCTAssertFalse(progress.record(.capturedPhoto))
        XCTAssertTrue(progress.completedSteps.isEmpty)
    }
}

// MARK: - Retention

extension ActivationTourPolicyTests {
    /// The tour's record is per-principal local state, so it leaves with the
    /// principal. Sign-out and account erasure both run
    /// `SettingsLocalCachedDataStore.removeAll()`, and that one path has to
    /// take every account's record, not only the departing one.
    /// Retention row: `local-activation-tour-progress`.
    func testSignOutAndErasureTakeEveryAccountsTourProgress() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: #function))
        defer { defaults.removePersistentDomain(forName: #function) }

        let store = UserDefaultsActivationTourProgressStore(defaults: defaults)
        var mine = ActivationTourProgress()
        mine.complete(.openScan)
        store.save(mine, for: "user_1133")
        store.save(mine, for: "guest")
        defaults.set("keep me", forKey: "unrelated.key")

        XCTAssertEqual(store.load(for: "user_1133"), mine, "control")

        XCTAssertTrue(
            SettingsLocalCachedDataStore(
                applicationSupportDirectory: URL(
                    fileURLWithPath: NSTemporaryDirectory()
                ).appendingPathComponent(UUID().uuidString),
                defaults: defaults
            ).removeAll()
        )

        XCTAssertEqual(store.load(for: "user_1133"), ActivationTourProgress())
        XCTAssertEqual(store.load(for: "guest"), ActivationTourProgress())
        XCTAssertEqual(
            defaults.string(forKey: "unrelated.key"),
            "keep me",
            "the sweep is scoped to the tour's own key prefix"
        )
    }
}

// MARK: - Where the strip sits

extension ActivationTourPolicyTests {
    private static let stripHeight = ActivationTourStripMetrics.height

    /// The strip docks above the bottom chrome and stays there when the
    /// control it points at is somewhere else on the screen.
    func testTheStripKeepsItsRestingPlaceWhenTheTargetIsNotUnderIt() {
        XCTAssertEqual(
            ActivationTourStripPlacementPolicy.bottomInset(
                halo: CGRect(x: 16, y: 180, width: 360, height: 120),
                bounds: Self.screen,
                restingInset: 96,
                stripHeight: Self.stripHeight
            ),
            96
        )
        XCTAssertEqual(
            ActivationTourStripPlacementPolicy.bottomInset(
                halo: nil,
                bounds: Self.screen,
                restingInset: 96,
                stripHeight: Self.stripHeight
            ),
            96,
            "a control with no frame yet cannot push the strip anywhere"
        )
    }

    /// The acceptance that matters: the strip never covers the control the
    /// seller is being told to tap. Photo Review's Start listing button sits
    /// exactly where the strip rests, so the strip moves above it.
    func testTheStripMovesAboveTheControlItWouldOtherwiseCover() {
        let startListing = CGRect(x: 16, y: 740, width: 360, height: 54)
        let inset = ActivationTourStripPlacementPolicy.bottomInset(
            halo: startListing,
            bounds: Self.screen,
            restingInset: 96,
            stripHeight: Self.stripHeight
        )

        XCTAssertGreaterThan(inset, 96)
        let stripBottom = Self.screen.maxY - inset
        XCTAssertLessThanOrEqual(
            stripBottom,
            startListing.minY,
            "the strip's lowest edge clears the control's highest edge"
        )
        XCTAssertGreaterThanOrEqual(
            Self.screen.maxY - inset - Self.stripHeight,
            0,
            "and it is still on the screen"
        )
    }

    /// A control taller than the room above it must not push the strip off the
    /// top of the screen. The strip stops at the top instead.
    func testTheStripNeverLeavesTheScreenToAvoidAControl() {
        let enormous = CGRect(x: 0, y: 8, width: 393, height: 820)
        let inset = ActivationTourStripPlacementPolicy.bottomInset(
            halo: enormous,
            bounds: Self.screen,
            restingInset: 96,
            stripHeight: Self.stripHeight
        )
        XCTAssertEqual(inset, Self.screen.height - Self.stripHeight)
    }
}
