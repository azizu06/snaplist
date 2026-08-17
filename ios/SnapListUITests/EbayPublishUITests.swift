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
            "Listing photo for Sony DualSense wireless controller, white"
        )
        XCTAssertTrue(
            confirmation.staticTexts[
                "Sony DualSense wireless controller, white"
            ].exists
        )
        XCTAssertTrue(confirmation.staticTexts["Used, good"].exists)
        // #893. A single-line value must keep sitting to the right of its
        // label — proves `ViewThatFits` still picks the trailing candidate
        // when nothing needs to wrap, not just that the wrap fallback works.
        XCTAssertGreaterThan(
            confirmation.staticTexts["Used, good"].frame.minX,
            confirmation.staticTexts["Condition"].frame.maxX,
            confirmation.debugDescription
        )
        XCTAssertTrue(confirmation.staticTexts["4 photos, in this order"].exists)
        XCTAssertTrue(confirmation.staticTexts["$58.00"].exists)
        // #893. `state == .ready` no longer draws the ordinary consent line:
        // the destination card above already says "eBay US, as azizu" once.
        XCTAssertFalse(
            marker("ebay-publish.confirmation.consent", in: confirmation).exists,
            "state == .ready must not draw the ordinary consent line.\n\(confirmation.debugDescription)"
        )
        XCTAssertFalse(confirmation.staticTexts["GOES TO"].exists)
        assertHittableButton(
            "button.primary.post-to-ebay",
            in: confirmation
        )
        // #893. The confirm screen offers one way back — the toolbar arrow —
        // not a second "Back to my listing" button under the primary.
        XCTAssertFalse(
            confirmation.buttons["button.secondary.back-to-my-listing"].exists,
            "The confirm screen must not offer a second way back.\n\(confirmation.debugDescription)"
        )
        assertHittableButton("ebay-publish.back", in: confirmation)
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

    /// #893. Removing the confirm screen's secondary "Back to my listing"
    /// button must not strand a seller: the toolbar back arrow (`ebay-publish
    /// .back`, wired to the same `backToListing` action) must still be there
    /// and hittable, and it must be the only way back offered.
    func testConfirmationScreenHasExactlyOneWayBackAfterSecondaryButtonRemoved() {
        let confirmation = launch(
            fixture: "confirmation",
            extraArguments: ["--reduced-motion"]
        )
        assertScreen("ebay-publish.confirmation", in: confirmation)

        XCTAssertFalse(
            confirmation.buttons["button.secondary.back-to-my-listing"].exists,
            confirmation.debugDescription
        )
        assertHittableButton("ebay-publish.back", in: confirmation)
    }

    /// #893. `EbayValueRow` used `.multilineTextAlignment(.trailing)`, so a
    /// title long enough to wrap read with a ragged left edge, as if it were
    /// cut off. The fixed row instead lets a wrapping value fall back to a
    /// left-aligned block under its own label. "Condition" (`Used, good`)
    /// never wraps and shares the row's typography, so its single-line
    /// height is this screen's true one-line baseline; the title must clear
    /// a multiple of it to prove it wrapped, and its left edge must land on
    /// its label's left edge to prove it did not stay trailing-aligned.
    func testConfirmationLongTitleWrapsLeftAlignedInsteadOfRaggedTrailing() {
        let confirmation = launch(
            fixture: "confirmation",
            extraArguments: ["--reduced-motion", "--dynamic-type=accessibility3"]
        )
        let titleLabel = confirmation.staticTexts["Title"]
        let titleValue = confirmation.staticTexts[
            "Medium wash denim trucker jacket, size M"
        ]
        let conditionValue = confirmation.staticTexts["Used, good"]
        XCTAssertTrue(titleLabel.waitForExistence(timeout: 10))
        XCTAssertTrue(titleValue.waitForExistence(timeout: 5))
        XCTAssertTrue(conditionValue.waitForExistence(timeout: 5))

        let receipt =
            "titleLabel.frame=\(titleLabel.frame), titleValue.frame=\(titleValue.frame), conditionValue.frame=\(conditionValue.frame)"

        XCTAssertGreaterThan(
            titleValue.frame.height,
            conditionValue.frame.height * 1.6,
            receipt
        )
        XCTAssertEqual(
            titleValue.frame.minX,
            titleLabel.frame.minX,
            accuracy: 2,
            receipt
        )
    }

    /// #893. Inside the expanded "Item specifics and description" disclosure,
    /// every item-specifics row sat one uniform gap apart, and DESCRIPTION
    /// used that identical gap before its own label — so it read as just
    /// another row rather than the start of a new block. The fixed row adds
    /// extra top padding to the DESCRIPTION label; this proves the resulting
    /// gap clears a margin over the ordinary row-to-row gap (averaged across
    /// Brand→Color and Color→Size) instead of matching it.
    func testItemSpecificsAndDescriptionReadAsTwoDistinctBlocksWhenExpanded() {
        let confirmation = launch(
            fixture: "confirmation",
            extraArguments: ["--reduced-motion"]
        )
        let disclosure = confirmation.buttons["Item specifics and description"]
        XCTAssertTrue(
            disclosure.waitForExistence(timeout: 10),
            confirmation.debugDescription
        )
        disclosure.tap()

        let brand = confirmation.staticTexts["Brand"]
        let color = confirmation.staticTexts["Color"]
        let size = confirmation.staticTexts["Size"]
        let description = confirmation.staticTexts["DESCRIPTION"]
        for element in [brand, color, size, description] {
            XCTAssertTrue(
                element.waitForExistence(timeout: 5),
                confirmation.debugDescription
            )
        }

        let receipt =
            "brand=\(brand.frame), color=\(color.frame), size=\(size.frame), description=\(description.frame)"
        let rowGap =
            ((color.frame.minY - brand.frame.maxY)
                + (size.frame.minY - color.frame.maxY)) / 2
        let sectionGap = description.frame.minY - size.frame.maxY

        XCTAssertGreaterThan(
            sectionGap,
            rowGap * 1.3,
            "DESCRIPTION must read as a new block, not another item-specifics row.\n\(receipt)"
        )
    }

    /// #865. Before this, the account/disconnect screen was reachable only
    /// from mid-publish (`Publish to eBay → connected → Manage connection`),
    /// so a seller who was not mid-publish had no route to it at all. `SET-01`
    /// reports a confirmed connection on the Settings SELLING row, which is
    /// exactly the condition that must now make the row a real destination.
    func testConnectedMarketplacesRowFromSettingsOpensTheSharedEbayAccountScreen() {
        let app = launchSettings()
        let row = app.buttons["settings.selling.marketplaces"]
        XCTAssertTrue(row.waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertTrue(row.isHittable, app.debugDescription)
        row.tap()

        let account = app.scrollViews["ebay-publish.account"]
        XCTAssertTrue(
            account.waitForExistence(timeout: 5),
            "Settings must reach the same `ebay-publish.account` screen the publish journey uses, not a second one.\n\(app.debugDescription)"
        )
        XCTAssertTrue(app.staticTexts["Connected as Jordan Hale"].exists, app.debugDescription)
        assertHittableButton("ebay-account.disconnect", in: app)
        attachEvidence(for: "settings-account", app: app)
    }

    /// The confirmation dialog must carry forward, unchanged, the disclosure
    /// that disconnecting does not revoke SnapList's grant on eBay's own side.
    /// Cancel must leave the connection untouched; confirming must return the
    /// seller to a state with no disconnect control left to tap twice.
    func testDisconnectFromSettingsShowsTheUnchangedEbayDisclosureThenLeavesNoDisconnectControl() {
        let app = launchSettings()
        app.buttons["settings.selling.marketplaces"].tap()
        let disconnect = app.buttons["ebay-account.disconnect"]
        XCTAssertTrue(disconnect.waitForExistence(timeout: 5), app.debugDescription)

        disconnect.tap()
        XCTAssertTrue(
            app.staticTexts["Disconnect eBay account Jordan Hale?"]
                .waitForExistence(timeout: 5),
            app.debugDescription
        )
        let disclosureText =
            "Listings already on eBay stay there and keep selling, but SnapList will not be able to see or change them.\n\nTo review which apps can use your eBay account, open your eBay account settings."
        XCTAssertEqual(
            app.staticTexts.matching(
                NSPredicate(format: "label == %@", disclosureText)
            ).count,
            1,
            "The eBay-side disclosure must survive verbatim on the Settings entry point.\n\(app.debugDescription)"
        )

        // Cancel must not disconnect. SwiftUI renders this confirmationDialog's
        // cancel action as either an explicit "Cancel" button (compact/
        // actionSheet presentation) or an outside-tap dismiss region (popover
        // presentation, which is what this device/OS combination actually
        // uses); this test asserts the behavior — cancelling leaves the
        // account connected — not which chrome Apple happens to draw it with.
        let cancel = app.buttons["Cancel"]
        if cancel.waitForExistence(timeout: 2) {
            cancel.tap()
        } else {
            let dismissRegion = app.descendants(matching: .any)["PopoverDismissRegion"]
            XCTAssertTrue(dismissRegion.waitForExistence(timeout: 3), app.debugDescription)
            dismissRegion.tap()
        }
        XCTAssertTrue(
            app.staticTexts["Connected as Jordan Hale"].waitForExistence(timeout: 5),
            "Cancelling the dialog must leave the account connected.\n\(app.debugDescription)"
        )

        disconnect.tap()
        app.buttons["Disconnect"].tap()

        let notConnected = app.descendants(matching: .any)["ebay-connection-settings.not-connected"]
        XCTAssertTrue(
            notConnected.waitForExistence(timeout: 5),
            "Disconnecting must land on the not-connected state.\n\(app.debugDescription)"
        )
        XCTAssertFalse(
            app.buttons["ebay-account.disconnect"].exists,
            "A disconnected seller must not be offered disconnect again.\n\(app.debugDescription)"
        )
        attachEvidence(for: "settings-disconnected", app: app)
    }

    /// The core round trip #865 exists to prove: disconnecting from Settings
    /// must not strand the seller without a way back in. Reconnecting must be
    /// reachable from the same Settings screen, with no item to open.
    func testAfterDisconnectingFromSettingsTheSellerCanReconnectWithoutOpeningAnItem() {
        let app = launchSettings()
        app.buttons["settings.selling.marketplaces"].tap()
        app.buttons["ebay-account.disconnect"].tap()
        app.buttons["Disconnect"].tap()

        let connect = app.buttons["ebay-connection-settings.connect"]
        XCTAssertTrue(connect.waitForExistence(timeout: 5), app.debugDescription)
        connect.tap()

        XCTAssertTrue(
            app.staticTexts["Connected as Jordan Hale"].waitForExistence(timeout: 5),
            "Reconnecting from Settings must reach the connected account screen again, without visiting an item.\n\(app.debugDescription)"
        )
        assertHittableButton("ebay-account.disconnect", in: app)
        attachEvidence(for: "settings-reconnected", app: app)
    }

    /// No clipping/overlap at default and at the largest accessibility Dynamic
    /// Type size (`accessibilityExtraExtraExtraLarge` / `.accessibility5`) on
    /// the screen Settings now reaches.
    func testEbayAccountScreenFromSettingsHasNoClippingAtDefaultAndLargestAccessibilityDynamicType() {
        for arguments in [[String](), ["--dynamic-type=accessibility5"]] {
            let app = launchSettings(extraArguments: arguments)
            app.buttons["settings.selling.marketplaces"].tap()

            let disconnect = app.buttons["ebay-account.disconnect"]
            XCTAssertTrue(disconnect.waitForExistence(timeout: 5), app.debugDescription)
            let window = app.windows.firstMatch
            for _ in 0..<8 where disconnect.frame.maxY > window.frame.maxY {
                app.swipeUp()
            }
            let receipt = "arguments=\(arguments), disconnect=\(disconnect.frame), window=\(window.frame)"
            XCTAssertTrue(disconnect.isHittable, receipt)
            XCTAssertGreaterThanOrEqual(disconnect.frame.minX, window.frame.minX, receipt)
            XCTAssertLessThanOrEqual(disconnect.frame.maxX, window.frame.maxX, receipt)
            XCTAssertLessThanOrEqual(disconnect.frame.maxY, window.frame.maxY, receipt)

            let connectedLabel = app.staticTexts["Connected as Jordan Hale"]
            XCTAssertTrue(connectedLabel.exists, receipt)
            XCTAssertGreaterThanOrEqual(connectedLabel.frame.minX, window.frame.minX, receipt)
            XCTAssertLessThanOrEqual(connectedLabel.frame.maxX, window.frame.maxX, receipt)
            attachEvidence(
                for: "settings-account-\(arguments.isEmpty ? "default" : "accessibility5")",
                app: app
            )
            app.terminate()
        }
    }

    private func launchSettings(extraArguments: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--settings-proof=SET-01"] + extraArguments
        app.launchAfterRetiringPriorInstance()
        XCTAssertTrue(
            app.descendants(matching: .any)["settings.screen"].waitForExistence(timeout: 5),
            app.debugDescription
        )
        return app
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
        let title = "Sony DualSense wireless controller, white"
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
