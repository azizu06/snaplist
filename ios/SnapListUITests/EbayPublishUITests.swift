import XCTest

/// Issue #742, seller-visible eBay Connect + Publish v5 projections.
///
/// The publish domain tests own state transitions and replay safety. This test
/// owns the public DEBUG launch seam and the rendered truth a seller can
/// actually reach. Every fixture is deterministic, signed in, and zero-network;
/// a live eBay adapter must never be needed to capture these states.
final class EbayPublishUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
    }

    func testApprovedV5FixturesProjectAllFourSellerVisibleStates() {
        let notConnected = launch(
            fixture: "not-connected",
            extraArguments: ["--reduced-motion"]
        )
        assertScreen("ebay-publish.connection.not-connected", in: notConnected)
        XCTAssertTrue(notConnected.staticTexts["Connect your eBay account."].exists)
        XCTAssertTrue(
            notConnected.staticTexts[
                "SnapList needs your permission before it can put a listing on eBay for you."
            ].exists
        )
        for scope in [
            "SnapList prepares the listing. You confirm before anything posts.",
            "You sign in on eBay’s own page. SnapList never sees your eBay password.",
            "You can remove this connection at any time.",
        ] {
            XCTAssertTrue(notConnected.staticTexts[scope].exists)
        }
        assertHittableButton(
            "button.primary.continue-to-ebay",
            in: notConnected
        )
        attachEvidence(for: "not-connected", app: notConnected)

        let confirmation = launch(
            fixture: "confirmation",
            extraArguments: ["--reduced-motion"]
        )
        assertScreen("ebay-publish.confirmation", in: confirmation)
        XCTAssertTrue(confirmation.staticTexts["Post this to eBay?"].exists)
        XCTAssertTrue(confirmation.staticTexts["eBay US, as azizu"].exists)
        let listingThumbnail = confirmation.images[
            "ebay-publish.confirmation.listing-thumbnail"
        ]
        XCTAssertTrue(
            listingThumbnail.waitForExistence(timeout: 5),
            "The v5 confirmation card must show the listing thumbnail."
        )
        XCTAssertEqual(
            listingThumbnail.label,
            "Listing photo for Medium wash denim trucker jacket, size M"
        )
        XCTAssertTrue(
            confirmation.staticTexts[
                "Medium wash denim trucker jacket, size M"
            ].exists
        )
        XCTAssertTrue(confirmation.staticTexts["Used, good"].exists)
        XCTAssertTrue(confirmation.staticTexts["4 photos, in this order"].exists)
        XCTAssertTrue(confirmation.staticTexts["$58.00"].exists)
        XCTAssertTrue(
            marker("ebay-publish.confirmation.consent", in: confirmation)
                .label.contains(
                    "This posts a live listing to eBay under your account, azizu."
                )
        )
        assertHittableButton(
            "button.primary.post-to-ebay",
            in: confirmation
        )
        assertHittableButton(
            "button.secondary.back-to-my-listing",
            in: confirmation
        )
        attachEvidence(for: "confirmation", app: confirmation)

        let published = launch(
            fixture: "published",
            extraArguments: ["--reduced-motion"]
        )
        assertScreen("ebay-publish.result.published", in: published)
        XCTAssertTrue(published.staticTexts["Your listing is live on eBay."].exists)
        XCTAssertTrue(published.staticTexts["Live on eBay"].exists)
        XCTAssertTrue(
            published.staticTexts[
                "Buyers can find it now. eBay handles the listing from here."
            ].exists
        )
        XCTAssertTrue(
            published.staticTexts[
                "Changes made on eBay will not come back to SnapList."
            ].exists
        )
        assertHittableButton("button.primary.go-to-trophy-wall", in: published)
        assertHittableButton("button.secondary.view-on-ebay", in: published)
        XCTAssertFalse(published.buttons["ebay-publish.back"].exists)
        attachEvidence(for: "published", app: published)

        let unknown = launch(
            fixture: "outcome-unknown",
            extraArguments: ["--reduced-motion"]
        )
        let unknownScreen = unknown.staticTexts[
            "ebay-publish.result.outcome-unknown"
        ]
        XCTAssertTrue(
            unknownScreen.waitForExistence(timeout: 10),
            "Missing outcome-unknown eBay fixture.\n\(unknown.debugDescription)"
        )
        XCTAssertTrue(
            unknown.staticTexts[
                "SnapList does not know yet whether eBay accepted this listing."
            ].exists
        )
        XCTAssertTrue(unknown.staticTexts["Checking with eBay"].exists)
        XCTAssertTrue(
            unknown.staticTexts[
                "The connection dropped at the wrong moment. SnapList will find out and update your Trophy Wall."
            ].exists
        )
        XCTAssertTrue(
            unknown.staticTexts[
                "There is nothing for you to do, and nothing will be posted twice."
            ].exists
        )
        assertHittableButton("button.primary.go-to-trophy-wall", in: unknown)
        XCTAssertFalse(unknown.buttons["button.secondary.view-on-ebay"].exists)
        XCTAssertFalse(unknown.buttons["ebay-publish.back"].exists)
        XCTAssertFalse(unknown.buttons["button.primary.check-again"].exists)
        XCTAssertEqual(unknown.activityIndicators.count, 0)
        XCTAssertEqual(unknown.progressIndicators.count, 0)

        let unknownCopy = sellerVisibleCopy(in: unknown)
        for forbidden in [
            "published",
            "shared",
            "check again",
            "try again",
            "retry",
        ] {
            XCTAssertFalse(
                unknownCopy.contains(forbidden),
                "An unknown publish outcome must not imply \(forbidden)."
            )
        }
        attachEvidence(for: "outcome-unknown", app: unknown)
    }

    func testApprovedV5ResultStatesKeepTraversalAndActionsReachableAtAccessibility3() {
        let published = launch(
            fixture: "published",
            extraArguments: ["--dynamic-type=accessibility3"]
        )
        assertResultTraversal(
            in: published,
            headingIdentifier: "ebay-publish.result.published",
            heading: "Your listing is live on eBay.",
            status: "Live on eBay",
            body: "Buyers can find it now. eBay handles the listing from here.",
            note: "Changes made on eBay will not come back to SnapList.",
            actionIdentifiers: [
                "button.primary.go-to-trophy-wall",
                "button.secondary.view-on-ebay",
            ],
            actionLabels: ["Go to Trophy Wall", "View on eBay"]
        )
        attachEvidence(for: "published-accessibility3", app: published)

        let unknown = launch(
            fixture: "outcome-unknown",
            extraArguments: ["--dynamic-type=accessibility3"]
        )
        assertResultTraversal(
            in: unknown,
            headingIdentifier: "ebay-publish.result.outcome-unknown",
            heading: "SnapList does not know yet whether eBay accepted this listing.",
            status: "Checking with eBay",
            body: "The connection dropped at the wrong moment. SnapList will find out and update your Trophy Wall.",
            note: "There is nothing for you to do, and nothing will be posted twice.",
            actionIdentifiers: ["button.primary.go-to-trophy-wall"],
            actionLabels: ["Go to Trophy Wall"]
        )
        attachEvidence(for: "outcome-unknown-accessibility3", app: unknown)
    }

    func testAccountClaimCancelPreservesTheExactSavedListingWithoutClaiming() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--guest-claim-fixture=cancel",
            "--zero-network-fixtures",
            "--reset-onboarding-progress",
            "--reduced-motion",
        ]
        app.launchAfterRetiringPriorInstance()

        let listing = marker("guest-claim.listing", in: app)
        XCTAssertTrue(
            listing.waitForExistence(timeout: 10),
            "The exact saved listing must remain visible at account entry.\n\(app.debugDescription)"
        )
        XCTAssertTrue(listing.label.contains("Saved seller title"))
        XCTAssertTrue(listing.label.contains("$63.25"))
        let entry = app.buttons["Sign in or create account"]
        XCTAssertTrue(entry.exists)
        XCTAssertTrue(entry.isHittable)
        XCTAssertGreaterThanOrEqual(entry.frame.height, 44)

        entry.tap()
        let fixtureEntry = marker(
            "guest-claim.account-entry-fixture",
            in: app
        )
        XCTAssertTrue(
            fixtureEntry.waitForExistence(timeout: 5),
            "The secret-free fixture must cross the supported account-entry boundary."
        )
        app.buttons["Close"].tap()

        XCTAssertTrue(listing.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Sign in or create account"].exists)
        XCTAssertFalse(marker("guest-claim.claimed", in: app).exists)
        XCTAssertFalse(app.staticTexts["Copying your photos into your account"].exists)
    }

    func testAccountClaimSuccessFailureAndRetryStayDeterministicAndAccessible() {
        let success = launchGuestClaimFixture("success")
        XCTAssertTrue(
            success.staticTexts["This item is in your account"]
                .waitForExistence(timeout: 10)
        )
        assertHittableButton(
            "button.primary.back-to-my-item",
            in: success
        )

        let failure = launchGuestClaimFixture(
            "claim-failure",
            extraArguments: ["--dynamic-type=accessibility3"]
        )
        XCTAssertTrue(
            failure.staticTexts["SnapList stopped the copy"]
                .waitForExistence(timeout: 10)
        )
        assertHittableButton(
            "button.primary.start-the-copy-again",
            in: failure
        )
        XCTAssertTrue(failure.buttons["Back to my draft"].exists)
        assertHierarchyOrder(
            [
                "label: 'SnapList stopped the copy'",
                "identifier: 'button.primary.start-the-copy-again'",
                "label: 'Back to my draft'",
            ],
            in: failure.debugDescription,
            file: #filePath,
            line: #line
        )

        let retry = launchGuestClaimFixture(
            "retry",
            extraArguments: ["--dynamic-type=accessibility3"]
        )
        let retryButton = retry.buttons[
            "button.primary.start-the-copy-again"
        ]
        XCTAssertTrue(retryButton.waitForExistence(timeout: 10))
        retryButton.tap()
        XCTAssertTrue(
            retry.staticTexts["This item is in your account"]
                .waitForExistence(timeout: 10)
        )
        XCTAssertEqual(
            retry.staticTexts.matching(
                NSPredicate(format: "label == %@", "This item is in your account")
            ).count,
            1
        )
    }

    private func launchGuestClaimFixture(
        _ fixture: String,
        extraArguments: [String] = []
    ) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "--guest-claim-fixture=\(fixture)",
            "--zero-network-fixtures",
            "--reset-onboarding-progress",
        ] + extraArguments
        app.launchAfterRetiringPriorInstance()
        return app
    }

    private func launch(
        fixture: String,
        extraArguments: [String]
    ) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "--ebay-publish-fixture=\(fixture)",
            "--zero-network-fixtures",
            "--reset-onboarding-progress",
        ] + extraArguments
        app.launchAfterRetiringPriorInstance()
        return app
    }

    private func assertScreen(
        _ identifier: String,
        in app: XCUIApplication,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let heading = app.staticTexts[identifier]
        XCTAssertTrue(
            heading.waitForExistence(timeout: 10),
            "Missing eBay v5 screen \(identifier).\n\(app.debugDescription)",
            file: file,
            line: line
        )
        XCTAssertFalse(
            app.descendants(matching: .any).allElementsBoundByIndex
                .map(\.label)
                .contains(where: { $0.hasPrefix("ebay-publish.") }),
            "A stable selector must not become spoken VoiceOver copy.\n\(app.debugDescription)",
            file: file,
            line: line
        )
    }

    private func assertResultTraversal(
        in app: XCUIApplication,
        headingIdentifier: String,
        heading: String,
        status: String,
        body: String,
        note: String,
        actionIdentifiers: [String],
        actionLabels: [String],
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let title = "Medium wash denim trucker jacket, size M"
        let headingElement = app.staticTexts[headingIdentifier]
        let titleElement = app.staticTexts[title]
        XCTAssertTrue(
            headingElement.waitForExistence(timeout: 10),
            app.debugDescription,
            file: file,
            line: line
        )
        XCTAssertEqual(headingElement.label, heading, file: file, line: line)
        XCTAssertTrue(
            titleElement.waitForExistence(timeout: 5),
            app.debugDescription,
            file: file,
            line: line
        )
        XCTAssertLessThan(
            headingElement.frame.maxY,
            titleElement.frame.minY,
            "V5 places its result heading before the listing card.",
            file: file,
            line: line
        )

        XCTAssertTrue(app.staticTexts[status].exists, file: file, line: line)
        XCTAssertTrue(app.staticTexts[body].exists, file: file, line: line)
        let noteElement = app.staticTexts["ebay-publish.result.note"]
        XCTAssertTrue(noteElement.exists, file: file, line: line)
        XCTAssertEqual(noteElement.label, note, file: file, line: line)

        for (identifier, label) in zip(actionIdentifiers, actionLabels) {
            assertHittableButton(identifier, in: app, file: file, line: line)
            XCTAssertEqual(
                app.buttons[identifier].label,
                label,
                file: file,
                line: line
            )
        }

        assertHierarchyOrder(
            [
                "identifier: '\(headingIdentifier)'",
                "label: '\(title)'",
                "label: '\(status)'",
                "label: '\(body)'",
                "identifier: 'ebay-publish.result.note'",
            ] + actionIdentifiers.map { "identifier: '\($0)'" },
            in: app.debugDescription,
            file: file,
            line: line
        )
    }

    private func assertHierarchyOrder(
        _ tokens: [String],
        in hierarchy: String,
        file: StaticString,
        line: UInt
    ) {
        var searchStart = hierarchy.startIndex
        for token in tokens {
            guard let range = hierarchy.range(
                of: token,
                range: searchStart..<hierarchy.endIndex
            ) else {
                XCTFail(
                    "Missing or out-of-order accessibility element: \(token).\n\(hierarchy)",
                    file: file,
                    line: line
                )
                return
            }
            searchStart = range.upperBound
        }
    }

    private func assertHittableButton(
        _ identifier: String,
        in app: XCUIApplication,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let button = app.buttons[identifier]
        XCTAssertTrue(
            button.waitForExistence(timeout: 5),
            "Missing \(identifier).",
            file: file,
            line: line
        )
        XCTAssertTrue(button.isHittable, "\(identifier) is not hittable.", file: file, line: line)
        XCTAssertGreaterThanOrEqual(button.frame.height, 44, file: file, line: line)
    }

    private func marker(
        _ identifier: String,
        in app: XCUIApplication
    ) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier)
            .firstMatch
    }

    private func sellerVisibleCopy(in app: XCUIApplication) -> String {
        let elements = app.staticTexts.allElementsBoundByIndex
            + app.buttons.allElementsBoundByIndex
        return elements
            .map(\.label)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
            .lowercased()
    }

    private func attachEvidence(for state: String, app: XCUIApplication) {
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "EBAY-V5-\(state).png"
        screenshot.lifetime = .keepAlways
        add(screenshot)

        let accessibility = XCTAttachment(string: app.debugDescription)
        accessibility.name = "EBAY-V5-\(state)-AX.txt"
        accessibility.lifetime = .keepAlways
        add(accessibility)
    }
}
