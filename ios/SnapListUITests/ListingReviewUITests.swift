import XCTest

final class ListingReviewUITests: XCTestCase {
    private let loadedTreeTimeout: TimeInterval = 30

    override func setUpWithError() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
    }

    func testCanonicalRunOpensListingReviewAndCleanDoneRestoresExactOpener() {
        let app = launch(resetDraft: true)
        let reviewOpener = openReview(in: app)
        app.buttons["listing-review.done"].tap()

        XCTAssertTrue(reviewOpener.waitForExistence(timeout: 3))
        XCTAssertTrue(reviewOpener.isHittable)
        XCTAssertFalse(app.otherElements["listing-review"].exists)
    }

    func testDirtyBackAndRelaunchRestoreDraftBeforeOneGuardedDoneSave() {
        var app = launch(resetDraft: true)
        _ = openReview(in: app)
        editTitle(" — seller edit", in: app)

        XCTAssertTrue(
            anyElement("listing-review.unsaved", in: app)
                .waitForExistence(timeout: 3)
        )
        app.buttons["listing-review.back"].tap()
        XCTAssertTrue(app.buttons["run.review.open"].waitForExistence(timeout: 3))

        UIProcessTerminationBoundary()
            .assertRetired(app, "The interruption fixture, before relaunch,")

        app = launch(resetDraft: false)
        _ = openReview(in: app)
        XCTAssertTrue(
            anyElement("listing-review.unsaved", in: app)
                .waitForExistence(timeout: 3)
        )
        XCTAssertTrue(
            String(
                describing:
                    app.buttons["listing-review.title"].value as Any
            ).contains("seller edit")
        )

        app.buttons["listing-review.done"].tap()
        XCTAssertTrue(app.staticTexts["Saving…"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["run.review.open"].waitForExistence(timeout: 6))
        XCTAssertFalse(anyElement("listing-review.unsaved", in: app).exists)
    }

    func testConflictDefaultsToKeepEditingAndOnlyExplicitDiscardReloads() {
        let app = launch(fixture: "conflict", resetDraft: true)
        _ = openReview(in: app)
        editTitle(" — conflict edit", in: app)
        app.buttons["listing-review.done"].tap()

        let changedAlert = app.alerts[
            "This review changed. Reload and try again."
        ]
        XCTAssertTrue(changedAlert.waitForExistence(timeout: 6))
        changedAlert.buttons["Reload"].tap()

        let discardAlert = app.alerts["Discard changes and reload?"]
        XCTAssertTrue(discardAlert.waitForExistence(timeout: 3))
        XCTAssertTrue(discardAlert.buttons["Keep editing"].exists)
        XCTAssertTrue(
            discardAlert.buttons["Discard changes and reload"].exists
        )
        discardAlert.buttons["Keep editing"].tap()

        XCTAssertTrue(
            anyElement("listing-review.unsaved", in: app)
                .waitForExistence(timeout: 3)
        )
        let reload = app.buttons["listing-review.reload"]
        XCTAssertTrue(reload.waitForExistence(timeout: 3))
        reload.tap()
        XCTAssertTrue(discardAlert.waitForExistence(timeout: 3))
        discardAlert.buttons["Discard changes and reload"].tap()

        XCTAssertFalse(discardAlert.waitForExistence(timeout: 2))
        XCTAssertFalse(anyElement("listing-review.unsaved", in: app).exists)
        XCTAssertTrue(app.otherElements["listing-review"].exists)
    }

    func testFailedAndOfflineSavesKeepTheLastUsableDirtyDraft() {
        let expectations = [
            (
                fixture: "save-failure",
                copy: "Failed to save changes. Please try again.",
                offersRetry: true
            ),
            (
                fixture: "offline",
                copy: "You're offline. Your changes are saved on this phone.",
                offersRetry: false
            ),
        ]

        for expectation in expectations {
            let app = launch(
                fixture: expectation.fixture,
                resetDraft: true
            )
            _ = openReview(in: app)
            editTitle(" — retained", in: app)
            app.buttons["listing-review.done"].tap()

            XCTAssertTrue(
                app.staticTexts[expectation.copy]
                    .waitForExistence(timeout: 6)
            )
            XCTAssertTrue(anyElement("listing-review.unsaved", in: app).exists)
            XCTAssertEqual(
                app.buttons["listing-review.retry"].exists,
                expectation.offersRetry
            )
            UIProcessTerminationBoundary()
                .assertRetired(app, "The \(expectation.fixture) fixture")
        }
    }

    func testZeroAndFiveEvidenceStayTruthfulAndSoldDetailReturnsToInvoker() {
        var app = launch(fixture: "zero-evidence", resetDraft: true)
        _ = openReview(in: app)

        // #896 retired this label from the screen: the formatted number under
        // it already read as a price. What the screen asserts is true did not
        // change, so the no-evidence line below is still required here.
        XCTAssertFalse(app.staticTexts["Starting price estimate"].exists)
        XCTAssertTrue(
            app.staticTexts["No verified sold matches found."].exists
        )
        XCTAssertEqual(
            soldMatchButtons(in: app).count,
            0,
            "Zero evidence must not invent a sold card."
        )
        UIProcessTerminationBoundary()
            .assertRetired(app, "The zero-evidence fixture")

        app = launch(fixture: "five-evidence", resetDraft: true)
        _ = openReview(in: app)

        XCTAssertTrue(
            app.staticTexts.matching(
                NSPredicate(format: "label BEGINSWITH %@", "5 sold")
            ).firstMatch.exists
        )
        let price = app.buttons["listing-review.price"]
        XCTAssertTrue(price.exists)
        XCTAssertTrue(String(describing: price.value as Any).contains("$58"))

        let firstMatch = app.buttons["listing-review.sold-match.0"]
        XCTAssertTrue(firstMatch.exists)
        firstMatch.tap()
        XCTAssertTrue(
            anyElement("listing-review.sold-detail", in: app)
                .waitForExistence(timeout: 3)
        )
        // A sold comp explains the price only when the terms of the sale come
        // with it: a free-shipping Buy It Now and a paid auction are not the
        // same $52.
        XCTAssertTrue(
            app.staticTexts["Body only"].exists,
            "The sold detail must carry the comp's size."
        )
        XCTAssertTrue(
            app.staticTexts["Buy It Now"].exists,
            "The sold detail must carry the comp's selling format."
        )
        XCTAssertTrue(
            app.staticTexts["Free shipping"].exists,
            "The sold detail must carry the comp's shipping term."
        )
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(firstMatch.waitForExistence(timeout: 3))
        XCTAssertTrue(firstMatch.isHittable)

        // The third fixture record carries none of the three optional facts.
        // An absent fact drops its row; it never renders a labelled blank.
        let bareMatch = app.buttons["listing-review.sold-match.2"]
        XCTAssertTrue(bareMatch.waitForExistence(timeout: 3))
        bareMatch.tap()
        XCTAssertTrue(
            anyElement("listing-review.sold-detail", in: app)
                .waitForExistence(timeout: 3)
        )
        for absent in ["SIZE", "FORMAT", "SHIPPING"] {
            XCTAssertFalse(
                app.staticTexts[absent].exists,
                "An absent \(absent) fact must not render its row."
            )
        }
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(bareMatch.waitForExistence(timeout: 3))
    }

    func testCorrectionBoundaryAndAdaptiveManualFallbackRemainReachable() {
        var app = launch(resetDraft: true)
        _ = openReview(in: app)
        // Negative control. This launch carries no `--reduced-motion`, and a
        // CI simulator has the system setting off, so the surface must resolve
        // reduced motion as false here. Without it the assertions below would
        // hold whether or not the launch argument reached the view.
        XCTAssertFalse(
            app.otherElements["listing-review.motion-reduced"].exists
        )
        var secondary = app.buttons["listing-review.secondary"]
        XCTAssertEqual(secondary.label, "Fix item")
        secondary.tap()
        XCTAssertTrue(
            anyElement("listing-review.correction-boundary", in: app)
                .waitForExistence(timeout: 3)
        )
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(secondary.waitForExistence(timeout: 3))
        XCTAssertTrue(secondary.isHittable)
        UIProcessTerminationBoundary()
            .assertRetired(app, "The correction-boundary fixture")

        app = launch(
            fixture: "correction-unavailable",
            resetDraft: true,
            extraArguments: [
                "--dynamic-type=accessibility5",
                "--reduced-motion",
            ]
        )
        _ = openReview(in: app)
        secondary = app.buttons["listing-review.secondary"]
        let done = app.buttons["listing-review.done"]

        // The screenshot below is filed as AC6 Reduced Motion evidence, so the
        // surface has to have actually resolved reduced motion. It reads the
        // launch argument rather than the system setting, which on this
        // simulator stays off for the whole run.
        XCTAssertTrue(
            app.otherElements["listing-review.motion-reduced"]
                .waitForExistence(timeout: 3)
        )
        XCTAssertEqual(secondary.label, "Edit details")
        XCTAssertTrue(secondary.isHittable)
        XCTAssertTrue(done.isHittable)
        XCTAssertGreaterThanOrEqual(secondary.frame.height, 44)
        XCTAssertGreaterThanOrEqual(done.frame.height, 44)
        XCTAssertTrue(app.buttons["listing-review.title"].exists)
        secondary.tap()
        XCTAssertTrue(app.buttons["listing-review.title"].exists)
        // XCUITest cannot inspect the VoiceOver cursor without assistive
        // technology running; ListingReviewFocus binds this action to Title.

        let viewport = app.windows.firstMatch.frame
        XCTAssertTrue(viewport.contains(secondary.frame))
        XCTAssertTrue(viewport.contains(done.frame))
        let screenshot = XCTAttachment(
            screenshot: XCUIScreen.main.screenshot()
        )
        screenshot.name =
            "LREV-accessibility5-reduced-motion-correction-unavailable.png"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        UIProcessTerminationBoundary()
            .assertRetired(app, "The manual-fallback fixture")

        app = launch(
            fixture: "long-text",
            resetDraft: true,
            extraArguments: [
                "--dynamic-type=accessibility5",
                "--reduced-motion",
            ]
        )
        _ = openReview(in: app)
        XCTAssertTrue(
            app.otherElements["listing-review.motion-reduced"]
                .waitForExistence(timeout: 3)
        )
        let longTitle = app.buttons["listing-review.title"]
        XCTAssertTrue(longTitle.exists)
        XCTAssertGreaterThan(
            String(describing: longTitle.value as Any).count,
            60
        )
        XCTAssertTrue(app.buttons["listing-review.secondary"].isHittable)
        XCTAssertTrue(app.buttons["listing-review.done"].isHittable)
        let longTextScreenshot = XCTAttachment(
            screenshot: XCUIScreen.main.screenshot()
        )
        longTextScreenshot.name =
            "LREV-long-text-accessibility5-reduced-motion.png"
        longTextScreenshot.lifetime = .keepAlways
        add(longTextScreenshot)
    }

    func testPrimaryActionsReserveTheFloatingDockAtDefaultAndAccessibilitySizes() {
        for extraArguments in [
            [String](),
            ["--dynamic-type=accessibility5", "--reduced-motion"],
        ] {
            let app = launch(
                resetDraft: true,
                extraArguments: extraArguments
            )
            app.open(
                URL(
                    string:
                        "snaplist://runs/20800000-0000-4000-8000-000000000020"
                )!
            )
            let reviewOpener = app.buttons["run.review.open"]
            XCTAssertTrue(
                reviewOpener.waitForExistence(timeout: loadedTreeTimeout)
            )
            reviewOpener.tap()
            XCTAssertTrue(
                app.otherElements["listing-review"]
                    .waitForExistence(timeout: loadedTreeTimeout)
            )

            let secondary = app.buttons["listing-review.secondary"]
            let done = app.buttons["listing-review.done"]
            let scan = app.buttons["dock.scan"]
            let trophyWall = app.buttons["dock.trophy-wall"]
            let window = app.windows.firstMatch

            for element in [secondary, done] {
                XCTAssertTrue(
                    element.waitForExistence(timeout: loadedTreeTimeout),
                    "Missing \(element.identifier) from the loaded tree."
                )
            }
            XCTAssertFalse(scan.exists)
            XCTAssertFalse(trophyWall.exists)
            XCTAssertTrue(window.exists)

            for action in [secondary, done] {
                XCTAssertTrue(action.isHittable, action.identifier)
                XCTAssertGreaterThanOrEqual(action.frame.minX, window.frame.minX)
                XCTAssertGreaterThanOrEqual(action.frame.minY, window.frame.minY)
                XCTAssertLessThanOrEqual(action.frame.maxX, window.frame.maxX)
                XCTAssertLessThanOrEqual(
                    action.frame.maxY,
                    window.frame.maxY,
                    "\(action.identifier) escapes the visible window."
                )
            }

            if extraArguments.isEmpty {
                let attachment = XCTAttachment(
                    screenshot: XCUIScreen.main.screenshot()
                )
                attachment.name = "issue-730-listing-review.png"
                attachment.lifetime = .keepAlways
                add(attachment)
            }

            app.buttons["listing-review.back"].tap()
            XCTAssertTrue(
                scan.waitForExistence(timeout: loadedTreeTimeout),
                "The primary dock must return after Listing Review closes."
            )
            XCTAssertTrue(trophyWall.exists)

            UIProcessTerminationBoundary()
                .assertRetired(app, "The Listing Review dock-reservation fixture")
        }
    }

    func testEditorsStageConditionSpecificAndPriceWithoutLosingInvoker() {
        let app = launch(resetDraft: true)
        _ = openReview(in: app)

        app.buttons["listing-review.description"].tap()
        XCTAssertTrue(
            app.textViews["listing-review.editor.description"]
                .waitForExistence(timeout: 3)
        )
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 2))
        app.buttons["listing-review.editor.back"].tap()
        XCTAssertTrue(
            app.buttons["listing-review.description"]
                .waitForExistence(timeout: 3)
        )

        app.buttons["listing-review.condition"].tap()
        let acceptable = app.buttons["listing-review.condition.acceptable"]
        XCTAssertTrue(acceptable.waitForExistence(timeout: 3))
        acceptable.tap()
        let condition = app.buttons["listing-review.condition"]
        XCTAssertTrue(condition.waitForExistence(timeout: 3))
        XCTAssertTrue(
            String(describing: condition.value as Any)
                .contains("Acceptable")
        )

        app.buttons["listing-review.specifics"].tap()
        let color = app.buttons["listing-review.specific.color"]
        XCTAssertTrue(color.waitForExistence(timeout: 3))
        color.tap()
        let specificField = app.textFields["listing-review.specific.field"]
        XCTAssertTrue(specificField.waitForExistence(timeout: 3))
        specificField.tap()
        specificField.typeText(" Silver")
        app.buttons["listing-review.specific.apply"].tap()
        XCTAssertTrue(color.waitForExistence(timeout: 3))
        XCTAssertTrue(
            String(describing: color.value as Any).contains("Silver")
        )

        let brand = app.buttons["listing-review.specific.brand"]
        brand.tap()
        XCTAssertTrue(
            anyElement("listing-review.correction-boundary", in: app)
                .waitForExistence(timeout: 3)
        )
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(brand.waitForExistence(timeout: 3))
        XCTAssertTrue(brand.isHittable)

        app.navigationBars.buttons.firstMatch.tap()
        let price = app.buttons["listing-review.price"]
        XCTAssertTrue(price.waitForExistence(timeout: 3))
        for _ in 0..<4 where !price.isHittable {
            app.scrollViews.firstMatch.swipeDown()
        }
        XCTAssertTrue(price.isHittable)
        price.tap()
        let priceField = app.textFields["listing-review.price.field"]
        let apply = app.buttons["listing-review.price.apply"]
        XCTAssertEqual(apply.label, "Apply price, keeps it on this phone")
        XCTAssertTrue(
            apply.frame.height >= 44,
            "apply target measured \(apply.frame.height)pt"
        )
        priceField.typeText("0")
        apply.tap()
        XCTAssertTrue(
            app.staticTexts["Must be above $0."].waitForExistence(timeout: 2)
        )
        priceField.typeText("1")
        apply.tap()
        XCTAssertFalse(app.staticTexts["Must be above $0."].exists)
        XCTAssertTrue(
            anyElement("listing-review.unsaved", in: app).exists
        )
    }

    /// The price editor used to be a bare `HStack`, so the title-weight price
    /// field squeezed the Apply button down to an unreadable sliver once
    /// Dynamic Type scaled up to the largest accessibility size (#831). The
    /// fix reuses `footer`'s existing `isAccessibilitySize` idiom to switch
    /// to a `VStack` instead, which this test proves two ways: both controls
    /// stay reachable and on-screen, and the field sits structurally above
    /// the button rather than beside it, which a squeezed `HStack` could
    /// never produce.
    func testPriceEditorStacksInsteadOfSqueezingAtTheLargestAccessibilitySize() {
        let app = launch(
            resetDraft: true,
            extraArguments: ["--dynamic-type=accessibility5"]
        )
        _ = openReview(in: app)

        let price = app.buttons["listing-review.price"]
        let secondary = app.buttons["listing-review.secondary"]
        XCTAssertTrue(price.waitForExistence(timeout: loadedTreeTimeout))
        XCTAssertTrue(secondary.waitForExistence(timeout: loadedTreeTimeout))
        // A full-length `swipeUp()` flick carries enough momentum on this
        // tall accessibility-size layout to blow straight past the price
        // row's resting position and land several sections further down (it
        // was verified directly, via a captured screenshot, to overscroll
        // into the verified-sold-matches list with the price row clipped
        // behind the status bar). `ListingReviewView.swift` reserves the
        // footer's real, dynamically measured height via
        // `.safeAreaInset(edge: .bottom, spacing: 0) { footer }`, so a
        // resting position exists where the price row sits fully above the
        // footer; reaching it needs the same small, deliberate,
        // momentum-free drag `HomeUITests.scrollUntilFullyVisible` already
        // uses for this exact class of problem, not a flick.
        let scrollView = app.scrollViews.firstMatch
        scrollUntilClearOfFooter(price, footerTopEdge: secondary, scrollView: scrollView, in: app)
        let clearanceReceipt = "price.frame=\(price.frame), secondary.frame=\(secondary.frame)"
        XCTAssertTrue(price.isHittable, clearanceReceipt)
        XCTAssertLessThanOrEqual(price.frame.maxY, secondary.frame.minY, clearanceReceipt)
        XCTAssertGreaterThanOrEqual(
            price.frame.minY,
            app.navigationBars.firstMatch.frame.maxY,
            clearanceReceipt
        )
        price.tap()

        let priceField = app.textFields["listing-review.price.field"]
        let apply = app.buttons["listing-review.price.apply"]
        let window = app.windows.firstMatch
        // Accessibility-size layout and the accessibility-tree snapshot it
        // forces are measurably slower than default size (this file already
        // budgets `loadedTreeTimeout` for the same reason elsewhere), so this
        // waits longer than the default-size price test does for the same
        // field.
        XCTAssertTrue(priceField.waitForExistence(timeout: loadedTreeTimeout))
        XCTAssertTrue(apply.waitForExistence(timeout: loadedTreeTimeout))

        let frameReceipt =
            "priceField.frame=\(priceField.frame), apply.frame=\(apply.frame), window.frame=\(window.frame)"
        XCTAssertTrue(priceField.isHittable, frameReceipt)
        XCTAssertTrue(apply.isHittable, frameReceipt)
        XCTAssertGreaterThanOrEqual(apply.frame.height, 44, frameReceipt)
        XCTAssertGreaterThanOrEqual(priceField.frame.height, 44, frameReceipt)
        XCTAssertLessThanOrEqual(priceField.frame.maxX, window.frame.maxX, frameReceipt)
        XCTAssertLessThanOrEqual(apply.frame.maxX, window.frame.maxX, frameReceipt)
        XCTAssertLessThanOrEqual(apply.frame.maxY, window.frame.maxY, frameReceipt)
        // The structural proof: a `VStack` puts the field's bottom edge at or
        // above the button's top edge. A bare `HStack` squeezed to this width
        // would instead place them side by side, sharing a vertical range.
        XCTAssertLessThanOrEqual(priceField.frame.maxY, apply.frame.minY, frameReceipt)
    }

    /// The real OS-level Bold Text accessibility setting cannot be toggled
    /// from a UI test, so `--bold-text` drives the same
    /// `\.legibilityWeight` override the system setting would apply
    /// (`OptionalBoldTextModifier` in `AppShellView.swift`). The acceptance
    /// criterion is that nothing reflows off screen with it on (#831); this
    /// proves the price control and the pinned footer's two buttons — the
    /// exact controls the largest-Dynamic-Type price editor fix above
    /// covers — all stay inside the window at Bold Text's heavier glyph
    /// metrics, at the default (non-accessibility) Dynamic Type size where
    /// this setting most commonly applies on its own.
    func testPriceAndFooterStayOnScreenWithBoldTextOn() {
        let app = launch(resetDraft: true, extraArguments: ["--bold-text"])
        _ = openReview(in: app)

        let price = app.buttons["listing-review.price"]
        let secondary = app.buttons["listing-review.secondary"]
        let done = app.buttons["listing-review.done"]
        let window = app.windows.firstMatch
        XCTAssertTrue(price.waitForExistence(timeout: loadedTreeTimeout))
        XCTAssertTrue(secondary.waitForExistence(timeout: loadedTreeTimeout))
        XCTAssertTrue(done.waitForExistence(timeout: loadedTreeTimeout))

        let frameReceipt =
            "price.frame=\(price.frame), secondary.frame=\(secondary.frame), done.frame=\(done.frame), window.frame=\(window.frame)"
        for control in [price, secondary, done] {
            XCTAssertTrue(control.isHittable, frameReceipt)
            XCTAssertGreaterThanOrEqual(control.frame.minX, window.frame.minX, frameReceipt)
            XCTAssertLessThanOrEqual(control.frame.maxX, window.frame.maxX, frameReceipt)
            XCTAssertLessThanOrEqual(control.frame.maxY, window.frame.maxY, frameReceipt)
            XCTAssertGreaterThanOrEqual(control.frame.height, 44, frameReceipt)
        }
    }

    /// A touch target derived from padding around scaled text, rather than
    /// from the 44pt floor, is thinnest at the smallest Dynamic Type size,
    /// the opposite failure direction from the accessibility-size checks
    /// above (#831). The price button carries an explicit
    /// `.frame(minHeight: SnapListMetrics.minimumTouchTarget)` floor; this
    /// proves that floor actually holds once the text inside it shrinks to
    /// its smallest size, rather than assuming it does.
    func testPriceControlMeetsTouchTargetFloorAtSmallestDynamicTypeSize() {
        let app = launch(resetDraft: true, extraArguments: ["--dynamic-type=xSmall"])
        _ = openReview(in: app)

        let price = app.buttons["listing-review.price"]
        XCTAssertTrue(price.waitForExistence(timeout: loadedTreeTimeout))
        let frameReceipt = "price.frame=\(price.frame)"
        XCTAssertTrue(price.isHittable, frameReceipt)
        XCTAssertGreaterThanOrEqual(price.frame.height, 44, frameReceipt)
    }

    /// Scrolls `element` into the band above `footerTopEdge` using small,
    /// momentum-free drags rather than `swipeUp()`. A full-length swipe
    /// flick carries enough velocity on a tall accessibility-size layout to
    /// overshoot the target by several sections in one gesture; this mirrors
    /// `HomeUITests.scrollUntilFullyVisible`'s `nudge` technique, which
    /// exists for the identical problem.
    private func scrollUntilClearOfFooter(
        _ element: XCUIElement,
        footerTopEdge: XCUIElement,
        scrollView: XCUIElement,
        in app: XCUIApplication,
        maximumNudges: Int = 12,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertTrue(scrollView.waitForExistence(timeout: 3), file: file, line: line)
        let navigationBarBottom = app.navigationBars.firstMatch.frame.maxY

        for _ in 0..<maximumNudges {
            let clearOfFooter = element.frame.maxY <= footerTopEdge.frame.minY
            let clearOfNavigationBar = element.frame.minY >= navigationBarBottom
            if clearOfFooter, clearOfNavigationBar, element.isHittable {
                return
            }
            let upward = !clearOfFooter
            let startY = upward ? 0.62 : 0.4
            let endY = upward ? 0.52 : 0.5
            let start = scrollView.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: startY))
            let end = scrollView.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: endY))
            start.press(forDuration: 0.05, thenDragTo: end)
        }
    }

    private func launch(
        fixture: String = "loaded",
        resetDraft: Bool,
        extraArguments: [String] = []
    ) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "--visual-state=HOME-01",
            "--zero-network-fixtures",
            "--reset-onboarding-progress",
            "--run-detail-fixture=reviewable",
            "--listing-review-fixture=\(fixture)",
        ] + (resetDraft ? ["--reset-listing-review-draft"] : [])
            + extraArguments
        app.launchAfterRetiringPriorInstance()
        return app
    }

    @discardableResult
    private func openReview(
        in app: XCUIApplication,
        file: StaticString = #filePath,
        line: UInt = #line
    ) -> XCUIElement {
        XCTAssertTrue(
            app.otherElements["trophy.wall"].waitForExistence(timeout: 3),
            file: file,
            line: line
        )
        // The seller-Home run row that used to open Run Detail was retired with
        // the rest of that surface, so the route is entered directly.
        app.open(URL(string: "snaplist://runs/20800000-0000-4000-8000-000000000020")!)

        let reviewOpener = app.buttons["run.review.open"]
        XCTAssertTrue(
            reviewOpener.waitForExistence(timeout: 3),
            "A canonical reviewable run must expose the Listing Review opener.",
            file: file,
            line: line
        )
        reviewOpener.tap()

        XCTAssertTrue(
            app.otherElements["listing-review"]
                .waitForExistence(timeout: 3),
            file: file,
            line: line
        )
        return reviewOpener
    }

    private func editTitle(
        _ suffix: String,
        in app: XCUIApplication,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let row = app.buttons["listing-review.title"]
        XCTAssertTrue(
            row.waitForExistence(timeout: 3),
            file: file,
            line: line
        )
        let done = app.buttons["listing-review.done"]
        var remainingSwipes = 2
        while row.frame.maxY > done.frame.minY && remainingSwipes > 0 {
            app.swipeUp()
            remainingSwipes -= 1
        }
        XCTAssertLessThanOrEqual(
            row.frame.maxY,
            done.frame.minY,
            "The title row must be fully above the persistent Done footer.",
            file: file,
            line: line
        )
        XCTAssertTrue(
            row.isHittable,
            "The visible title row must remain hittable before opening its editor.",
            file: file,
            line: line
        )
        row.tap()

        let editor = app.textViews["listing-review.editor.title"]
        XCTAssertTrue(
            editor.waitForExistence(timeout: 3),
            file: file,
            line: line
        )
        editor.tap()
        editor.typeText(suffix)
        app.buttons["listing-review.editor.back"].tap()
        XCTAssertTrue(
            row.waitForExistence(timeout: 3),
            file: file,
            line: line
        )
    }

    private func anyElement(
        _ identifier: String,
        in app: XCUIApplication
    ) -> XCUIElement {
        app.descendants(matching: .any)[identifier]
    }

    private func soldMatchButtons(
        in app: XCUIApplication
    ) -> XCUIElementQuery {
        app.buttons.matching(
            NSPredicate(
                format: "identifier BEGINSWITH %@",
                "listing-review.sold-match."
            )
        )
    }
}
