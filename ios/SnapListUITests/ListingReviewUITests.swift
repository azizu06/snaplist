import XCTest

/// A control laid out at exactly the floor comes back from XCUITest as
/// `43.99999999999994`, because the height is the sum of a scaled font
/// metric and two paddings. Rounding to the nearest point keeps the
/// comparison at the scale the floor is written in. A control that is
/// genuinely short still fails: 43.4 rounds to 43. Shared across the UI test
/// target so every touch-target assertion rounds the same way before
/// comparing to 44 — a raw comparison here and a rounded one elsewhere could
/// go red on one path and green on the other for the same control.
enum TouchTargetFloor {
    static func isMet(_ measurement: CGFloat) -> Bool {
        measurement.rounded() >= 44
    }
}

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
                    app.textViews["listing-review.title"].value as Any
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
        let price = app.textFields["listing-review.price"]
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
        XCTAssertTrue(app.textViews["listing-review.title"].exists)
        secondary.tap()
        XCTAssertTrue(app.textViews["listing-review.title"].exists)
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
        let longTitle = app.textViews["listing-review.title"]
        XCTAssertTrue(longTitle.exists)
        XCTAssertGreaterThan(
            stringValue(of: longTitle).count,
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

    func testInlineFieldsAndDrawersStageEveryValueWithoutLosingInvoker() {
        let app = launch(resetDraft: true)
        _ = openReview(in: app)

        // Description is typed where it sits. Nothing is pushed, so the
        // retired one-field editor must not exist to be reached at all.
        let description = app.textViews["listing-review.description"]
        XCTAssertTrue(description.waitForExistence(timeout: 3))
        description.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 2))
        XCTAssertFalse(
            anyElement("listing-review.editor.description", in: app).exists
        )
        description.typeText(" Boxed.")
        app.buttons["listing-review.keyboard-done"].tap()
        XCTAssertTrue(
            String(describing: description.value as Any).contains("Boxed.")
        )

        // Condition has a fixed option set, so it opens the drawer and only
        // commits on the drawer's own save.
        app.buttons["listing-review.condition"].tap()
        let acceptable = app.buttons["listing-review.condition.acceptable"]
        XCTAssertTrue(acceptable.waitForExistence(timeout: 3))
        acceptable.tap()
        app.buttons["listing-review.condition.save"].tap()
        let condition = app.buttons["listing-review.condition"]
        XCTAssertTrue(condition.waitForExistence(timeout: 3))
        XCTAssertTrue(
            String(describing: condition.value as Any)
                .contains("Acceptable")
        )

        openItemSpecifics(in: app)
        let color = app.textViews["listing-review.specific.color"]
        XCTAssertTrue(color.waitForExistence(timeout: 3))
        color.tap()
        color.typeText(" Silver")
        app.buttons["listing-review.keyboard-done"].tap()
        XCTAssertTrue(
            String(describing: color.value as Any).contains("Silver")
        )

        // Brand is a reserved identity key. It gets a drawer that states the
        // consequence and routes to guided correction. It never becomes a
        // field, so the value cannot be typed past the pricing rerun.
        let brand = app.buttons["listing-review.specific.brand"]
        XCTAssertTrue(brand.waitForExistence(timeout: 3))
        XCTAssertFalse(app.textViews["listing-review.specific.brand"].exists)
        brand.tap()
        XCTAssertTrue(
            app.staticTexts[
                "Changing this reruns the price and rewrites the listing."
            ].waitForExistence(timeout: 3)
        )
        XCTAssertTrue(
            app.staticTexts[
                "It uses the guided correction included with this item."
            ].exists
        )
        app.buttons["listing-review.specific.correction"].tap()
        XCTAssertTrue(
            anyElement("listing-review.correction-boundary", in: app)
                .waitForExistence(timeout: 3)
        )
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(brand.waitForExistence(timeout: 3))
        XCTAssertTrue(brand.isHittable)

        app.navigationBars.buttons.firstMatch.tap()
        let price = app.textFields["listing-review.price"]
        XCTAssertTrue(price.waitForExistence(timeout: 3))
        XCTAssertFalse(
            anyElement("listing-review.price.apply", in: app).exists,
            "The two-step price editor is retired; the box is the field."
        )
        for _ in 0..<4 where !price.isHittable {
            app.scrollViews.firstMatch.swipeDown()
        }
        XCTAssertTrue(price.isHittable)
        // The keyboard belongs to whatever had focus last, and Done gave it
        // up two screens ago. Deleting without taking focus first types into
        // nothing, which reads as a product failure and is not one.
        price.tap()
        clear(price, in: app)
        price.typeText("0")
        app.buttons["listing-review.keyboard-done"].tap()
        XCTAssertTrue(
            app.staticTexts["Must be above $0."].waitForExistence(timeout: 2)
        )
        price.tap()
        clear(price, in: app)
        price.typeText("61")
        app.buttons["listing-review.keyboard-done"].tap()
        XCTAssertFalse(app.staticTexts["Must be above $0."].exists)
        XCTAssertTrue(
            anyElement("listing-review.unsaved", in: app).exists
        )
    }

    /// Publishing is the one exit on this screen that reaches a real
    /// marketplace, and the tap that starts it does not resign the field's
    /// first responder. Nothing under `ios/` sets `scrollDismissesKeyboard`
    /// either, so a seller can retitle, scroll down with the keyboard still up,
    /// and tap Publish while the typed title is still sitting in
    /// `ListingReviewInlineEdits`. `isDirty` is derived from the draft alone,
    /// so the guard answered `false` against the pre-edit draft and eBay was
    /// handed the old title as a value copy.
    func testPublishToEbayFlushesTheTypedTitleBeforeItReadsIsDirty() {
        let app = launch(resetDraft: true)
        _ = openReview(in: app)

        let title = app.textViews["listing-review.title"]
        XCTAssertTrue(title.waitForExistence(timeout: loadedTreeTimeout))
        title.tap()
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 3))
        title.typeText(" Zephyr")

        // No keyboard Done, no tap outside the field. Scrolling is how the
        // seller reaches the entry and it leaves the field focused, which is
        // the whole point: the typed text has not reached the draft yet.
        let entry = app.buttons["listing-review.ebay-publish"]
        XCTAssertTrue(entry.waitForExistence(timeout: 3))
        // A dragged scroll rather than `swipeUp()`. The scroll view fills the
        // window, so its centre sits under the footer once the keyboard
        // raises it and a swipe from there scrolls nothing. The drag stays in
        // the band still visible above the keyboard, and away from the left
        // edge, which is the interactive back gesture.
        for _ in 0..<12 where !entryIsClearOfTheFooter(entry, in: app) {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.40))
                .press(
                    forDuration: 0.05,
                    thenDragTo: app.coordinate(
                        withNormalizedOffset: CGVector(dx: 0.5, dy: 0.18)
                    )
                )
        }
        XCTAssertTrue(entryIsClearOfTheFooter(entry, in: app), app.debugDescription)
        XCTAssertTrue(
            keyboard.exists,
            "The scroll must leave the field focused, or this proves nothing."
        )
        entry.tap()

        // The flush lands before the guard reads the draft, so the guard sees
        // a dirty screen and takes the refusal it already takes for any other
        // unsaved edit. Nothing is pushed and the seller stays put.
        //
        // Two assertions carry the claim and neither is redundant, because the
        // fix can fail in two different directions. The `listing-review.unsaved`
        // assertion is the one that actually went red: once the guard passes,
        // the strip is on the screen left behind and the tree shows only the
        // pushed destination, so it is absent. `entry.isHittable` catches the
        // other direction, where the seller ends up off this screen for a
        // reason that has nothing to do with the guard. The remaining two are
        // diagnosis only — the field's own State holds the typed title whether
        // or not it reached the draft, and the `ebay-publish.back` negative
        // races the late blur flush that lands after the push.
        XCTAssertTrue(
            anyElement("listing-review.unsaved", in: app)
                .waitForExistence(timeout: 5),
            app.debugDescription
        )
        XCTAssertFalse(
            anyElement("ebay-publish.back", in: app)
                .waitForExistence(timeout: 3),
            "eBay must not open holding a title the seller has already replaced."
        )
        XCTAssertTrue(entry.isHittable, app.debugDescription)
        XCTAssertTrue(
            stringValue(of: title).contains("Zephyr"),
            "The typed title must survive the refusal."
        )
    }

    /// The price does not live in the inline-edit holder. It sits in the view's
    /// own `priceText` and only reaches the draft through `commitPrice()`, so
    /// flushing the holder settles the title and leaves the price behind. A
    /// seller who types a price, never resigns the field, and taps Publish used
    /// to get one of two wrong outcomes depending on which async step landed
    /// first: eBay built from the old price, or a blank pushed screen once the
    /// blur commit flipped `isDirty` under `destinationView`'s own guard.
    func testPublishToEbayCommitsTheTypedPriceBeforeItReadsIsDirty() {
        let app = launch(resetDraft: true)
        _ = openReview(in: app)

        let price = app.textFields["listing-review.price"]
        XCTAssertTrue(price.waitForExistence(timeout: loadedTreeTimeout))
        let before = stringValue(of: price)
        price.tap()
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 3))
        // Replace rather than append, so the committed amount cannot coincide
        // with the suggested one. `commitPrice` compares against
        // `displayedPrice` and no-ops when they match, so an edit that lands on
        // the same value would prove nothing.
        price.press(forDuration: 1.0)
        if app.menuItems["Select All"].waitForExistence(timeout: 2) {
            app.menuItems["Select All"].tap()
        }
        price.typeText("133.70")
        XCTAssertNotEqual(
            stringValue(of: price), before,
            "The typed price has to differ from the suggested one."
        )

        let entry = app.buttons["listing-review.ebay-publish"]
        XCTAssertTrue(entry.waitForExistence(timeout: 3))
        // The same dragged scroll the title test uses, and for the same two
        // reasons. Do not swap it back to `swipeUp()`: the scroll view fills
        // the window, so its centre sits under the footer once the keyboard
        // raises it and a swipe from there scrolls nothing. And the drag has to
        // stay off the left edge, which arms the interactive back gesture and
        // dismisses the whole screen instead of scrolling it.
        for _ in 0..<12 where !entryIsClearOfTheFooter(entry, in: app) {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.40))
                .press(
                    forDuration: 0.05,
                    thenDragTo: app.coordinate(
                        withNormalizedOffset: CGVector(dx: 0.5, dy: 0.18)
                    )
                )
        }
        XCTAssertTrue(entryIsClearOfTheFooter(entry, in: app), app.debugDescription)
        XCTAssertTrue(
            keyboard.exists,
            "The scroll must leave the price focused, or this proves nothing."
        )
        entry.tap()

        // As above, and in the same two directions. The recorded RED for this
        // selector failed at the `listing-review.unsaved` assertion below, not
        // at `entry.isHittable`: without the commit the guard passes, the push
        // happens, and the strip is no longer in the tree. `entry.isHittable`
        // is the backstop for leaving this screen some other way — a tap that
        // lands on the footer's Done, for instance, which saves and dismisses.
        XCTAssertTrue(
            anyElement("listing-review.unsaved", in: app)
                .waitForExistence(timeout: 5),
            app.debugDescription
        )
        XCTAssertFalse(
            anyElement("ebay-publish.back", in: app)
                .waitForExistence(timeout: 3),
            "eBay must not open holding a price the seller has already replaced."
        )
        XCTAssertTrue(entry.isHittable, app.debugDescription)
    }

    /// The price editor used to be a bare `HStack`, so the title-weight price
    /// field squeezed the Apply button down to an unreadable sliver once
    /// Dynamic Type scaled up to the largest accessibility size (#831). The
    /// fix stacked the two controls. #899 removes the second control entirely:
    /// the price is one bordered field that is typed in place, so the failure
    /// this test guards is now the field itself reflowing off screen or
    /// dropping below the touch-target floor at that size.
    func testThePriceFieldStaysOnScreenAtTheLargestAccessibilitySize() {
        let app = launch(
            resetDraft: true,
            extraArguments: ["--dynamic-type=accessibility5"]
        )
        _ = openReview(in: app)

        let price = app.textFields["listing-review.price"]
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

        let window = app.windows.firstMatch
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 2))
        // The two-step editor is gone, so there is no second control left to
        // squeeze. What has to hold is that the one field is still typable
        // and still inside the window at this size.
        XCTAssertFalse(anyElement("listing-review.price.field", in: app).exists)
        XCTAssertFalse(anyElement("listing-review.price.apply", in: app).exists)

        let frameReceipt =
            "price.frame=\(price.frame), window.frame=\(window.frame)"
        XCTAssertTrue(price.isHittable, frameReceipt)
        assertMeetsTouchTargetFloor(price.frame.height, frameReceipt)
        XCTAssertGreaterThanOrEqual(price.frame.minX, window.frame.minX, frameReceipt)
        XCTAssertLessThanOrEqual(price.frame.maxX, window.frame.maxX, frameReceipt)
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

        let price = app.textFields["listing-review.price"]
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
            assertMeetsTouchTargetFloor(control.frame.height, frameReceipt)
        }
    }

    /// A touch target derived from padding around scaled text, rather than
    /// from the 44pt floor, is thinnest at the smallest Dynamic Type size,
    /// the opposite failure direction from the accessibility-size checks
    /// above (#831). The price is a single-line `TextField` now, not a
    /// button, and it carries an explicit
    /// `.frame(minHeight: SnapListMetrics.minimumTouchTarget)` floor. A
    /// single-line field is backed by a `UITextField` that fills the frame it
    /// is handed, so unlike the vertical-axis fields below, the floor moves
    /// the element itself. This proves that floor actually holds once the
    /// text inside it shrinks to its smallest size, rather than assuming it
    /// does.
    func testPriceControlMeetsTouchTargetFloorAtSmallestDynamicTypeSize() {
        let app = launch(resetDraft: true, extraArguments: ["--dynamic-type=xSmall"])
        _ = openReview(in: app)

        let price = app.textFields["listing-review.price"]
        XCTAssertTrue(price.waitForExistence(timeout: loadedTreeTimeout))
        let frameReceipt = "price.frame=\(price.frame)"
        XCTAssertTrue(price.isHittable, frameReceipt)
        assertMeetsTouchTargetFloor(price.frame.height, frameReceipt)
    }

    /// The toolbar back item, measured in both dimensions.
    ///
    /// #928. It carried `.frame(minWidth:minHeight:)` around the button
    /// together with `.buttonStyle(.plain)` — the arrangement #926 measured at
    /// 22.67pt on the eBay publish screen, because a frame around a
    /// `ToolbarItem`'s button never reaches that button's hit rect and the
    /// plain style takes away the toolbar's own capsule that was propping it
    /// up. Nothing on this screen asserted the size, so it shipped at whatever
    /// the chevron happened to be.
    ///
    /// Width is asserted as well as height. A toolbar chevron is short in the
    /// dimension a height-only floor never looks at, so the assertion that
    /// would have caught this is the one about width.
    func testTheReviewBackButtonMeetsTheTouchTargetFloorInBothDimensions() {
        let app = launch(resetDraft: true)
        _ = openReview(in: app)

        let back = app.buttons["listing-review.back"]
        XCTAssertTrue(back.waitForExistence(timeout: loadedTreeTimeout))
        let frameReceipt = "back.frame=\(back.frame)"
        XCTAssertTrue(back.isHittable, frameReceipt)
        assertMeetsTouchTargetFloor(back.frame.height, frameReceipt)
        assertMeetsTouchTargetFloor(back.frame.width, frameReceipt)
    }

    private func assertMeetsTouchTargetFloor(
        _ measurement: CGFloat,
        _ receipt: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertTrue(
            TouchTargetFloor.isMet(measurement),
            receipt,
            file: file,
            line: line
        )
    }

    /// The exact value a control laid out at the floor comes back as (see
    /// `TouchTargetFloor`'s doc comment). Proves both touch-target helpers —
    /// this one and `EbayPublishUITests.assertHittableButton` — now round the
    /// same way, since before this fix one of them compared the raw value and
    /// would have gone red here while the other stayed green.
    func testTouchTargetFloorRoundsBeforeComparing() {
        XCTAssertTrue(TouchTargetFloor.isMet(43.99999999999994))
        XCTAssertFalse(TouchTargetFloor.isMet(43.4))
    }

    /// `XCUIElement.value` is `Any?`, so `String(describing:)` on it renders
    /// `Optional(White)` rather than `White`. That wrapper is enough to make a
    /// suffix assertion pass forever, which is how the first version of the
    /// caret test below reported green without checking anything. Reading the
    /// value through a cast keeps the assertions operating on the text.
    private func stringValue(of element: XCUIElement) -> String {
        element.value as? String ?? ""
    }

    /// Title, Description and every non-identity specific share
    /// `ListingReviewInlineTextField`. It used to be the one inline control
    /// that could not make the claim the price makes: a vertical-axis text
    /// field hugs its content and reported 23pt at the smallest Dynamic Type
    /// size whatever frame it was given, so a 44pt element assertion on it
    /// would have been asserting something false. Since #918 it wraps a
    /// `UITextView`, which fills its frame, and the element assertions live in
    /// the two tests further down.
    ///
    /// The two tests below are about the box, which is what a finger gets.
    ///
    /// Reach and caret placement pull in opposite directions, and the first
    /// version of the reach fix broke the caret without failing anything. A
    /// tap gesture laid over the box wins the tap before the field sees it,
    /// so focus is set in code and the caret lands at the end of the value
    /// rather than under the finger. Tapping into the middle of a word to fix
    /// it is the most ordinary thing anyone does in a text field, so it is
    /// asserted here: a character typed after a tap near the start of the
    /// value must not arrive at the end of it.
    func testATapOnTheGlyphsPutsTheCaretWhereTheFingerIsAndNotAtTheEnd() {
        let app = launch(resetDraft: true)
        _ = openReview(in: app)
        openItemSpecifics(in: app)

        let color = app.textViews["listing-review.specific.color"]
        XCTAssertTrue(color.waitForExistence(timeout: loadedTreeTimeout))
        let before = stringValue(of: color)
        // Low in the box on purpose. The glyphs occupy roughly the top 20pt of
        // the 44pt element, and everything under them used to resolve to the
        // end of the value (#928). At dy 0.5 the tap lands within a point of
        // that boundary, which is why this read green here and red on CI from
        // the same code. dy 0.85 is unambiguously in the band that was broken.
        color.coordinate(withNormalizedOffset: CGVector(dx: 0.04, dy: 0.85)).tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
        color.typeText("Z")

        // The tap is at the left edge of the value, so a caret that followed
        // the finger puts the character first. Asserted positively, on the
        // prefix. The first version of this asserted `!hasSuffix("Z")` and
        // could not fail: `String(describing: element.value)` renders the
        // optional as `Optional(WhiteZ)`, which never ends in the character
        // typed, so it passed whether the caret followed the finger or not.
        let after = stringValue(of: color)
        let receipt = "before=\(before), after=\(after)"
        XCTAssertTrue(after.hasPrefix("Z"), receipt)
    }

    /// The other half of the same claim: reach. `color`'s own accessibility
    /// frame is the `UITextView` itself, floored to 44pt by #918
    /// (`SnapListMetrics.minimumTouchTarget`) — not the small hugging frame
    /// this comment used to describe. The two probes sit 10pt outside that
    /// frame on each side: outside the element, but still inside the label
    /// band and padding that the field's background `.onTapGesture` picks up
    /// (`ListingReviewComponents.swift`). Both taps are needed. One of them
    /// passing on its own would not distinguish a box that takes taps from a
    /// text view that happens to sit near the point tapped.
    func testTheSharedInlineFieldTakesTapsAboveAndBelowItsGlyphs() {
        let app = launch(resetDraft: true, extraArguments: ["--dynamic-type=xSmall"])
        _ = openReview(in: app)
        openItemSpecifics(in: app)

        let color = app.textViews["listing-review.specific.color"]
        XCTAssertTrue(color.waitForExistence(timeout: loadedTreeTimeout))
        let keyboard = app.keyboards.firstMatch

        // The character has to be absent from the value before the tap or the
        // probe cannot fail. The second one used to be "W", and the fixture
        // value is already "White", so that assertion was true before the tap
        // and stayed true whether the box took it or not.
        for (above, typed) in [(true, "Q"), (false, "Z")] {
            // Read the frame for each tap rather than once up front. The
            // first tap raises the keyboard, and a layout that reflows around
            // it leaves the second tap aimed at where the field used to be.
            let frame = color.frame
            let y = above ? frame.minY - 10 : frame.maxY + 10
            let before = stringValue(of: color)
            let receipt = "color.frame=\(frame), tapped y=\(y), before=\(before)"
            XCTAssertFalse(before.contains(typed), receipt)
            app.coordinate(withNormalizedOffset: .zero)
                .withOffset(CGVector(dx: frame.midX, dy: y))
                .tap()
            XCTAssertTrue(keyboard.waitForExistence(timeout: 3), receipt)

            // A keyboard proves something took focus, not that this field
            // did, and the claim is about this field. Typing settles it: the
            // character has to arrive in this field's value.
            color.typeText(typed)
            let value = stringValue(of: color)
            XCTAssertTrue(value.contains(typed), "\(receipt), value=\(value)")

            app.buttons["listing-review.keyboard-done"].tap()
            XCTAssertTrue(keyboard.waitForNonExistence(timeout: 3), receipt)
        }
    }

    /// `contentShape` is touch only. Switch Control, Voice Control, Full
    /// Keyboard Access and VoiceOver direct-touch exploration all drive the
    /// accessibility element, so the box taking taps is not enough: the
    /// element itself has to clear the floor (#918).
    ///
    /// Both Dynamic Type sizes are asserted. They fail in opposite
    /// directions — the accessibility sizes above catch a target that grew
    /// past its container, and the smallest size catches one derived from
    /// scaled glyphs rather than from the floor.
    func testTheInlineTextFieldsPublishAFloorSizedElementAtDefaultDynamicType() {
        assertInlineTextFieldsPublishFloorSizedElements(extraArguments: [])
    }

    func testTheInlineTextFieldsPublishAFloorSizedElementAtSmallestDynamicType() {
        assertInlineTextFieldsPublishFloorSizedElements(
            extraArguments: ["--dynamic-type=xSmall"]
        )
    }

    /// Title, Description and the shared field every non-identity specific
    /// uses are one component, so they are proved together.
    private func assertInlineTextFieldsPublishFloorSizedElements(
        extraArguments: [String],
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        // Six measurements, and the reason to take them all is that each one
        // is a separate claim. Stopping at the first failure would prove one
        // field and leave the other two unmeasured, which is not what the
        // acceptance asks for.
        continueAfterFailure = true
        let app = launch(resetDraft: true, extraArguments: extraArguments)
        _ = openReview(in: app)

        assertPublishesFloorSizedElement(
            "listing-review.title",
            in: app,
            file: file,
            line: line
        )

        // Description is asserted because the acceptance names it, not
        // because it was ever the thin one. Its `lineLimit` reserves three
        // lines, and three lines clear the floor at every Dynamic Type size,
        // so this one assertion also held on the plain `TextField`. Title and
        // the shared specific field are where the regression lives, and they
        // are the two that move. Every measurement is recorded as an activity
        // either way, so a claim about any of them can be read off the run
        // rather than assumed.
        assertPublishesFloorSizedElement(
            "listing-review.description",
            in: app,
            file: file,
            line: line
        )

        openItemSpecifics(in: app)
        assertPublishesFloorSizedElement(
            "listing-review.specific.color",
            in: app,
            file: file,
            line: line
        )
    }

    /// Measures the element that carries `identifier` and nothing else.
    ///
    /// The count assertion is the point. A container that wraps the control
    /// and republishes its name would let a 62pt box answer for a 23pt
    /// element, and the measurement would be of a view no assistive
    /// technology ever lands on.
    private func assertPublishesFloorSizedElement(
        _ identifier: String,
        in app: XCUIApplication,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let matches = app.descendants(matching: .any)
            .matching(identifier: identifier)
        XCTAssertTrue(
            matches.element(boundBy: 0)
                .waitForExistence(timeout: loadedTreeTimeout),
            identifier,
            file: file,
            line: line
        )
        XCTAssertEqual(
            matches.count,
            1,
            "Exactly one element may carry \(identifier).",
            file: file,
            line: line
        )

        let element = matches.element(boundBy: 0)
        let receipt =
            "\(identifier).frame=\(element.frame), elementType=\(element.elementType.rawValue)"
        // Named as an activity so a measurement that passes is still on the
        // run. A receipt that only appears on failure cannot answer "what did
        // the one that passed actually measure?".
        XCTContext.runActivity(named: receipt) { _ in
            assertMeetsTouchTargetFloor(
                element.frame.height,
                receipt,
                file: file,
                line: line
            )
        }
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

    func testANonIdentitySpecificCommitsInPlaceWithoutAPushedEditor() {
        let app = launch(resetDraft: true)
        _ = openReview(in: app)
        openItemSpecifics(in: app)

        let color = app.textViews["listing-review.specific.color"]
        XCTAssertTrue(color.waitForExistence(timeout: 3))
        color.tap()
        color.typeText(" Silver")

        // Nothing pushed. The seller is still on Item specifics and the
        // retired one-field screen and its helper paragraph are both gone.
        XCTAssertTrue(app.navigationBars["Item specifics"].exists)
        XCTAssertFalse(
            anyElement("listing-review.specific.field", in: app).exists
        )
        XCTAssertFalse(
            app.staticTexts[
                "Saved on this phone when you tap Done. Editing a specific never spends another AI item."
            ].exists
        )

        app.buttons["listing-review.keyboard-done"].tap()
        XCTAssertTrue(
            String(describing: color.value as Any).contains("Silver")
        )

        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(
            anyElement("listing-review.unsaved", in: app)
                .waitForExistence(timeout: 3)
        )
    }

    func testASpentCorrectionLeavesIdentitySpecificsUnavailableAndSaysWhy() {
        let app = launch(fixture: "correction-unavailable", resetDraft: true)
        _ = openReview(in: app)
        openItemSpecifics(in: app)

        let brand = app.buttons["listing-review.specific.brand"]
        XCTAssertTrue(brand.waitForExistence(timeout: 3))
        XCTAssertFalse(
            brand.isEnabled,
            "A spent correction leaves no route into an identity value."
        )
        XCTAssertFalse(app.textViews["listing-review.specific.brand"].exists)
        XCTAssertEqual(
            app.staticTexts["listing-review.specifics.correction-spent"].label,
            "Brand and Type need guided correction, and you have used yours."
        )

        // Nothing about a spent correction stops a manual edit. Those never
        // cost a credit, so they stay typable.
        XCTAssertTrue(app.textViews["listing-review.specific.color"].exists)
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
        let row = app.textViews["listing-review.title"]
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
        row.typeText(suffix)
        app.buttons["listing-review.keyboard-done"].tap()
        XCTAssertTrue(
            String(describing: row.value as Any).contains(suffix),
            "The typed suffix must survive the field giving up focus.",
            file: file,
            line: line
        )
    }

    /// Empties a field the seller would clear with the keyboard's delete key.
    /// The price field is prefilled, so a test that only appends can never
    /// produce the values the invalid-price path needs.
    private func clear(_ field: XCUIElement, in app: XCUIApplication) {
        let existing = stringValue(of: field)
        field.typeText(
            String(
                repeating: XCUIKeyboardKey.delete.rawValue,
                count: max(existing.count, 1)
            )
        )
    }

    private func anyElement(
        _ identifier: String,
        in app: XCUIApplication
    ) -> XCUIElement {
        app.descendants(matching: .any)[identifier]
    }

    /// Taps the Item specifics row, having first put it clear of the footer.
    ///
    /// #918 makes every typed box at least 44pt, which grows the review screen
    /// and can leave this row underneath the persistent Done footer. A tap
    /// there lands on Done, which saves and leaves the screen — and then the
    /// failure surfaces as a missing field twenty lines later, pointing at the
    /// wrong thing. The scroll and the receipt belong next to the gesture.
    private func openItemSpecifics(
        in app: XCUIApplication,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let entry = app.buttons["listing-review.specifics"]
        XCTAssertTrue(
            entry.waitForExistence(timeout: loadedTreeTimeout),
            file: file,
            line: line
        )
        // Short momentum-free drags, for the reason `scrollUntilClearOfFooter`
        // documents: a flick overshoots by whole sections on a tall layout.
        for _ in 0..<12 where !entryIsClearOfTheFooter(entry, in: app) {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.60))
                .press(
                    forDuration: 0.05,
                    thenDragTo: app.coordinate(
                        withNormalizedOffset: CGVector(dx: 0.5, dy: 0.50)
                    )
                )
        }
        XCTAssertTrue(
            entryIsClearOfTheFooter(entry, in: app),
            "Item specifics never cleared the Done footer.\n"
                + app.debugDescription,
            file: file,
            line: line
        )
        entry.tap()
        XCTAssertTrue(
            app.navigationBars["Item specifics"]
                .waitForExistence(timeout: loadedTreeTimeout),
            "The tap has to push Item specifics, not save and leave.",
            file: file,
            line: line
        )
    }

    /// `isHittable` is computed from the element's own frame, so it stays true
    /// for a row that has scrolled underneath the footer. The footer lives in a
    /// `safeAreaInset(edge: .bottom)` and paints over the scroll view, so a tap
    /// synthesized at that row's centre lands on Done instead — which saves and
    /// dismisses the screen, and looks exactly like the bug under test. Scroll
    /// until the row is clear of the footer, not merely hittable.
    private func entryIsClearOfTheFooter(
        _ entry: XCUIElement,
        in app: XCUIApplication
    ) -> Bool {
        guard entry.exists, entry.isHittable else { return false }
        let done = app.buttons["listing-review.done"]
        guard done.exists else { return true }
        return entry.frame.maxY <= done.frame.minY
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
