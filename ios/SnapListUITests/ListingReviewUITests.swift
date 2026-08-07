import XCTest

final class ListingReviewUITests: XCTestCase {
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

        XCTAssertTrue(app.staticTexts["Starting price estimate"].exists)
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
