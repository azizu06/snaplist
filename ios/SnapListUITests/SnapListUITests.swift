import CoreFoundation
import XCTest
import UIKit

final class SnapListUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
    }

    /// The budget a real `openURL` handoff needs on a loaded CI runner, not on
    /// a warm developer Mac. Measured on the GitHub runner (issue #824): the
    /// first handoff of a shard, which cold-launches Safari, exceeded the old
    /// five seconds and failed — `testProGateOfferLegalFooterOpensTermsAndPrivacy`
    /// in run 31668920327 and `testSettingsAboutRowsOpenTheirLiveLegalDestinations`
    /// in run 31660491907, each on its own first iteration. Where it survived,
    /// that first handoff took 4.81s against the 5s ceiling — 0.19s of margin —
    /// and the two behind it took 3.12s and 2.61s. Both tests terminate Safari
    /// before every iteration, so that speedup is simulator and OS warmth, not a
    /// live Safari process, and every handoff here is a cold launch. Size against
    /// 4.81s rather than 2.61s. The same handoff takes 1s–2s locally, which is
    /// why neither test reproduces on a developer Mac. This wait returns the
    /// moment the app leaves the foreground, so the larger budget costs nothing
    /// when the handoff works and only buys an honest verdict when the runner
    /// is slow.
    private static let legalHandoffBudget: TimeInterval = 20

    /// A Safari handoff can settle directly into `.runningBackgroundSuspended`
    /// without ever being observed transiently in `.runningBackground` —
    /// `HomeVisualRegressionTests.swift`'s `isSafeToTerminate` treats both
    /// states (plus `.notRunning`) as equally valid evidence the app left the
    /// foreground, and a wait pinned to `.runningBackground` alone is exactly
    /// the flake that precedent works around.
    private func waitForBackgroundHandoff(_ app: XCUIApplication, timeout: TimeInterval) -> Bool {
        let deadline = ProcessInfo.processInfo.systemUptime + timeout
        let states: [XCUIApplication.State] = [.runningBackground, .runningBackgroundSuspended, .notRunning]
        var index = 0
        while true {
            switch app.state {
            case .runningBackground, .runningBackgroundSuspended, .notRunning:
                return true
            default:
                break
            }
            let remaining = deadline - ProcessInfo.processInfo.systemUptime
            guard remaining > 0 else { return false }
            _ = app.wait(for: states[index], timeout: min(remaining, 0.5))
            index = (index + 1) % states.count
        }
    }

    func testPrimaryShellNavigationAndTypedDestinations() {
        let app = launch(extraArguments: ["--camera-status=unavailable"])

        XCTAssertTrue(app.staticTexts["scan.recovery-title"].waitForExistence(timeout: 2))
        XCTAssertFalse(app.otherElements["trophy.wall"].exists)
        XCTAssertTrue(app.buttons["dock.scan"].isSelected)

        app.buttons["dock.trophy-wall"].tap()
        XCTAssertTrue(app.otherElements["trophy.wall"].waitForExistence(timeout: 2))
        XCTAssertFalse(app.staticTexts["scan.recovery-title"].exists)

        XCTAssertFalse(app.buttons["dock.inbox"].exists)
        XCTAssertFalse(app.buttons["dock.insights"].exists)
        XCTAssertFalse(app.buttons["Runs"].exists)
        XCTAssertFalse(app.buttons["You"].exists)
    }

    func testSettingsProofFixturesRenderApprovedStatesWithoutDeletionCommit() {
        let proofs = [
            (
                "SET-01",
                "settings.screen",
                "",
                ""
            ),
            (
                "DEL-01",
                "settings.state.del-01",
                "Keep my account",
                "settings.delete-account"
            ),
            (
                "DEL-02",
                "settings.state.del-02",
                "Cancel",
                "settings.delete-account"
            ),
            (
                "DEL-03",
                "settings.state.del-03",
                "Keep my account",
                "settings.delete-account"
            ),
        ]

        for (fixtureID, screenIdentifier, safeExitIdentifier, absentControl) in proofs {
            let app = XCUIApplication()
            app.launchArguments = ["--settings-proof=\(fixtureID)"]
            app.launchAfterRetiringPriorInstance()

            XCTAssertTrue(
                app.descendants(matching: .any)[screenIdentifier]
                    .waitForExistence(timeout: 3),
                app.debugDescription
            )
            if fixtureID == "SET-01" {
                XCTAssertTrue(app.staticTexts["Jordan Hale"].exists)
            }

            guard !safeExitIdentifier.isEmpty else {
                app.terminate()
                continue
            }

            let safeExit = app.buttons[safeExitIdentifier]
            let scanDock = app.buttons["dock.scan"]
            let trophyWallDock = app.buttons["dock.trophy-wall"]
            let window = app.windows.firstMatch
            let reservesFloatingDock = fixtureID != "DEL-01"
            XCTAssertTrue(safeExit.exists)
            XCTAssertFalse(app.buttons[absentControl].exists)
            XCTAssertEqual(scanDock.exists, reservesFloatingDock)
            XCTAssertEqual(trophyWallDock.exists, reservesFloatingDock)
            XCTAssertTrue(window.exists)
            let frameReceipt = "safeExit.frame=\(safeExit.frame), window.frame=\(window.frame)"
            XCTAssertGreaterThanOrEqual(safeExit.frame.width, 44, frameReceipt)
            XCTAssertGreaterThanOrEqual(safeExit.frame.height, 44, frameReceipt)
            XCTAssertGreaterThanOrEqual(safeExit.frame.minX, window.frame.minX, frameReceipt)
            XCTAssertGreaterThanOrEqual(safeExit.frame.minY, window.frame.minY, frameReceipt)
            XCTAssertLessThanOrEqual(safeExit.frame.maxX, window.frame.maxX, frameReceipt)
            XCTAssertLessThanOrEqual(safeExit.frame.maxY, window.frame.maxY, frameReceipt)
            if reservesFloatingDock {
                XCTAssertLessThanOrEqual(
                    safeExit.frame.maxY,
                    min(scanDock.frame.minY, trophyWallDock.frame.minY),
                    frameReceipt
                )
            }
            XCTAssertTrue(safeExit.isHittable)
            safeExit.tap()
            let proofScreen = app.descendants(matching: .any)[screenIdentifier]
            let dismissal = expectation(
                for: NSPredicate(format: "exists == false"),
                evaluatedWith: proofScreen
            )
            wait(for: [dismissal], timeout: 3)
            XCTAssertFalse(proofScreen.exists)
            XCTAssertTrue(scanDock.waitForExistence(timeout: 3))
            XCTAssertTrue(trophyWallDock.exists)
            XCTAssertTrue(trophyWallDock.isSelected)
            XCTAssertTrue(
                app.otherElements["trophy.wall"].waitForExistence(timeout: 3),
                app.debugDescription
            )
            XCTAssertFalse(app.buttons[absentControl].exists)
            app.terminate()
        }
    }

    /// `settingsCardRow` used to pin every SELLING-section row to exactly
    /// 52pt no matter how tall its content wanted to be, which clipped
    /// `SettingsSellingHintRow`'s footnote-plus-policy-link content even at
    /// the default type size (#831). The hint row only renders when the
    /// server reports an eBay policy problem, which this fixture does not
    /// simulate, but the fix lives in the shared container every SELLING row
    /// passes through: "Connected marketplaces" is reachable with no extra
    /// fixture plumbing and, once its label plus value stop fitting one line
    /// at the largest accessibility size, exercises the identical
    /// fixed-height defect. A row still reporting 52pt at that size would
    /// mean the fix regressed and the wrapped line is invisible again.
    func testSellingSectionRowGrowsPastTheOldFixedHeightCapAtLargestAccessibilitySize() {
        for arguments in [[String](), ["--dynamic-type=accessibility5"]] {
            let app = XCUIApplication()
            app.launchArguments = ["--settings-proof=SET-01"] + arguments
            app.launchAfterRetiringPriorInstance()

            XCTAssertTrue(
                app.descendants(matching: .any)["settings.screen"].waitForExistence(timeout: 3),
                app.debugDescription
            )

            let marketplacesRow = app.descendants(matching: .any)["settings.selling.marketplaces"]
            let window = app.windows.firstMatch
            XCTAssertTrue(marketplacesRow.waitForExistence(timeout: 3), app.debugDescription)
            // At the largest accessibility size the wrapped row is taller
            // than the screen, so scrolling it into view, the same
            // `app.swipeUp()` pattern this suite already uses to reach
            // `settings.delete-account`, is required before checking it
            // fits the window, exactly as a seller would need to scroll to
            // reach it. `isHittable` alone is not a reliable guard here: it
            // reports true for this row even while its bottom edge sits
            // below the window, so the loop keeps swiping until the row's
            // own frame is fully on screen instead.
            for _ in 0..<6 where marketplacesRow.frame.maxY > window.frame.maxY {
                app.swipeUp()
            }
            let frameReceipt =
                "row.frame=\(marketplacesRow.frame), window.frame=\(window.frame), arguments=\(arguments)"
            XCTAssertTrue(marketplacesRow.isHittable, frameReceipt)
            XCTAssertGreaterThanOrEqual(marketplacesRow.frame.minX, window.frame.minX, frameReceipt)
            XCTAssertLessThanOrEqual(marketplacesRow.frame.maxX, window.frame.maxX, frameReceipt)
            XCTAssertLessThanOrEqual(marketplacesRow.frame.maxY, window.frame.maxY, frameReceipt)

            if arguments.contains("--dynamic-type=accessibility5") {
                XCTAssertGreaterThan(marketplacesRow.frame.height, 52, frameReceipt)
            }

            app.terminate()
        }
    }

    /// The real OS-level Bold Text accessibility setting cannot be toggled
    /// from a UI test, so `--bold-text` drives the same
    /// `\.legibilityWeight` override the system setting would apply
    /// (`OptionalBoldTextModifier` in `AppShellView.swift`). The acceptance
    /// criterion is that nothing reflows off screen with it on (#831). This
    /// checks `settings.about.help`, not a SELLING value row: a value row
    /// (`valueRow`, e.g. `settings.selling.marketplaces`) is a plain
    /// `.accessibilityElement(children: .combine)` display with no button
    /// semantics — `testSettingsSellingValueRowsAreNotButtons` already
    /// proves it is deliberately not a control — so XCUITest reports its
    /// combined accessibility frame as the union of its label/value glyph
    /// bounds, not the padded `settingsCardRow` it sits inside. That is not
    /// a 44pt "control" in the touch-target sense the acceptance criterion
    /// means. `LegalLinkRow` (`settings.about.help`) is an actual `Button`
    /// with the identifier on the button itself, so its accessibility frame
    /// is its real hit-testable bounds, including the same `settingsCardRow`
    /// `minHeight: 52` floor.
    func testAboutRowStaysOnScreenWithBoldTextOn() {
        let app = launch(extraArguments: ["--fixture=account", "--bold-text"])
        let helpRow = app.buttons["settings.about.help"]
        let window = app.windows.firstMatch
        for _ in 0..<4 where !helpRow.exists {
            app.swipeUp()
        }
        XCTAssertTrue(helpRow.waitForExistence(timeout: 3), app.debugDescription)
        for _ in 0..<6 where helpRow.frame.maxY > window.frame.maxY {
            app.swipeUp()
        }
        let frameReceipt = "row.frame=\(helpRow.frame), window.frame=\(window.frame)"
        XCTAssertGreaterThanOrEqual(helpRow.frame.minX, window.frame.minX, frameReceipt)
        XCTAssertLessThanOrEqual(helpRow.frame.maxX, window.frame.maxX, frameReceipt)
        XCTAssertLessThanOrEqual(helpRow.frame.maxY, window.frame.maxY, frameReceipt)
        XCTAssertGreaterThanOrEqual(helpRow.frame.height, 44, frameReceipt)
    }

    /// A touch target derived from padding around scaled text, rather than
    /// from the 44pt floor, is thinnest at the smallest Dynamic Type size —
    /// the opposite failure direction from the largest-accessibility-size
    /// checks elsewhere in this file (#831). `settingsCardRow`'s
    /// `minHeight: 52` is a hard floor independent of type size, so this
    /// proves it actually holds there rather than assuming a fix proved at
    /// one extreme automatically holds at the other. See
    /// `testAboutRowStaysOnScreenWithBoldTextOn` for why this checks
    /// `settings.about.help` (a real `Button`) rather than a SELLING value
    /// row (not a control).
    func testAboutRowMeetsTouchTargetFloorAtSmallestDynamicTypeSize() {
        let app = launch(extraArguments: ["--fixture=account", "--dynamic-type=xSmall"])
        let helpRow = app.buttons["settings.about.help"]
        for _ in 0..<4 where !helpRow.exists {
            app.swipeUp()
        }
        XCTAssertTrue(helpRow.waitForExistence(timeout: 3), app.debugDescription)
        let frameReceipt = "row.frame=\(helpRow.frame)"
        XCTAssertGreaterThanOrEqual(helpRow.frame.height, 44, frameReceipt)
    }

    /// #844, acceptance criteria 1, 2 and 4. A member's ACCOUNT card offers a
    /// sign-out, and it explains itself before it runs.
    ///
    /// The confirmation is the whole point of the test: `Stay signed in` has to
    /// return the seller to a Settings screen that still offers the control,
    /// which is only true if tapping the row did not already end the session.
    func testMemberSettingsOffersSignOutAndConfirmsBeforeItRuns() {
        let app = launch(extraArguments: ["--fixture=account"])
        let settingsScreen = app.descendants(matching: .any)["settings.screen"]
        XCTAssertTrue(settingsScreen.waitForExistence(timeout: 3), app.debugDescription)

        let signOut = app.buttons["settings.sign-out"]
        for _ in 0..<4 where !signOut.isHittable {
            app.swipeUp()
        }
        XCTAssertTrue(signOut.exists, app.debugDescription)
        XCTAssertTrue(signOut.isHittable, app.debugDescription)
        XCTAssertEqual(signOut.label, "Sign out", app.debugDescription)
        signOut.tap()

        let confirmation = app.descendants(matching: .any)["settings.sign-out.confirm"]
        XCTAssertTrue(confirmation.waitForExistence(timeout: 3), app.debugDescription)
        // The seller is told the account survives before they commit, not after.
        XCTAssertTrue(
            app.staticTexts["Your account stays. This is not account deletion."]
                .waitForExistence(timeout: 3),
            app.debugDescription
        )

        let stay = app.buttons["Stay signed in"]
        XCTAssertTrue(stay.exists, app.debugDescription)
        // Asserted as geometry rather than through `isHittable`, which answers
        // true even when the floating dock covers the control's centre (#730) —
        // the state this test found, where the tap silently went to the dock.
        let dock = app.buttons["dock.scan"]
        XCTAssertTrue(dock.exists, app.debugDescription)
        XCTAssertLessThanOrEqual(
            stay.frame.maxY,
            dock.frame.minY,
            "stay=\(stay.frame), dock=\(dock.frame)"
        )
        stay.tap()

        XCTAssertTrue(settingsScreen.waitForExistence(timeout: 3), app.debugDescription)
        for _ in 0..<4 where !signOut.isHittable {
            app.swipeUp()
        }
        XCTAssertTrue(
            signOut.exists,
            "backing out of the confirmation must leave the session alone: "
                + app.debugDescription
        )
    }

    /// #844, acceptance criterion 7, at both ends of the Dynamic Type range.
    ///
    /// `xSmall` is where a target sized from text height rather than the row's
    /// 52pt floor is thinnest, which is the failure `LegalLinkRow` and
    /// `Create an account` both had (#831). `accessibility5` is the size the
    /// criterion names, and the one where a row that grows past its container
    /// stops being fully hittable. The `Button` is measured rather than a
    /// `valueRow` for the reason `testAboutRowMeetsTouchTargetFloorAtSmallest\
    /// DynamicTypeSize` gives: a value row is not a control.
    func testSignOutRowMeetsTheTouchTargetFloorAcrossDynamicTypeSizes() {
        for size in ["xSmall", "accessibility5"] {
            let app = launch(extraArguments: [
                "--fixture=account",
                "--dynamic-type=\(size)",
            ])
            XCTAssertTrue(
                app.descendants(matching: .any)["settings.screen"]
                    .waitForExistence(timeout: 5),
                "\(size): \(app.debugDescription)"
            )

            let signOut = app.buttons["settings.sign-out"]
            for _ in 0..<6 where !signOut.exists {
                app.swipeUp()
            }
            XCTAssertTrue(
                signOut.waitForExistence(timeout: 3),
                "\(size): \(app.debugDescription)"
            )
            let receipt = "\(size): row.frame=\(signOut.frame)"
            XCTAssertGreaterThanOrEqual(signOut.frame.height, 44, receipt)
            XCTAssertGreaterThanOrEqual(signOut.frame.width, 44, receipt)
            app.terminate()
        }
    }

    func testSettingsMemberReauthenticationCancelReturnsToDeletionConsequences() {
        let app = launch(extraArguments: ["--fixture=account"])
        let settingsScreen = app.descendants(matching: .any)["settings.screen"]
        XCTAssertTrue(settingsScreen.waitForExistence(timeout: 3), app.debugDescription)

        let deleteAccount = app.buttons["settings.delete-account"]
        for _ in 0..<4 where !deleteAccount.isHittable {
            app.swipeUp()
        }
        XCTAssertTrue(deleteAccount.exists, app.debugDescription)
        XCTAssertTrue(deleteAccount.isHittable, app.debugDescription)
        deleteAccount.tap()

        let deletionConsequences = app.descendants(matching: .any)["settings.state.del-01"]
        XCTAssertTrue(deletionConsequences.waitForExistence(timeout: 3), app.debugDescription)
        app.buttons["Continue to delete my account"].tap()

        let reauthentication = app.descendants(matching: .any)["settings.state.del-02"]
        XCTAssertTrue(reauthentication.waitForExistence(timeout: 3), app.debugDescription)
        let cancel = app.buttons["Cancel"]
        let scanDock = app.buttons["dock.scan"]
        let trophyWallDock = app.buttons["dock.trophy-wall"]
        let window = app.windows.firstMatch
        XCTAssertTrue(cancel.exists, app.debugDescription)
        XCTAssertFalse(scanDock.exists, app.debugDescription)
        XCTAssertFalse(trophyWallDock.exists, app.debugDescription)
        XCTAssertTrue(window.exists, app.debugDescription)
        let frameReceipt = "cancel.frame=\(cancel.frame), window.frame=\(window.frame)"
        XCTAssertGreaterThanOrEqual(cancel.frame.width, 44, frameReceipt)
        XCTAssertGreaterThanOrEqual(cancel.frame.height, 44, frameReceipt)
        XCTAssertGreaterThanOrEqual(cancel.frame.minX, window.frame.minX, frameReceipt)
        XCTAssertGreaterThanOrEqual(cancel.frame.minY, window.frame.minY, frameReceipt)
        XCTAssertLessThanOrEqual(cancel.frame.maxX, window.frame.maxX, frameReceipt)
        XCTAssertLessThanOrEqual(cancel.frame.maxY, window.frame.maxY, frameReceipt)
        XCTAssertTrue(cancel.isHittable, frameReceipt)
        cancel.tap()

        let returnedToConsequences = deletionConsequences.waitForExistence(timeout: 3)
        XCTAssertTrue(returnedToConsequences, app.debugDescription)
        XCTAssertFalse(reauthentication.exists)
        XCTAssertFalse(app.descendants(matching: .any)["settings.state.del-03"].exists)
        XCTAssertFalse(app.buttons["Verify"].exists)
    }

    /// `settingsSectionHeader` pinned itself to `.frame(height: 18)`, so at
    /// `accessibility5` its glyphs drew outside the 18pt the layout gave it and
    /// the opaque card below covered the bottom third of them (#836). Measured
    /// on `e1e084b1e`: `SELLING` ran to 753.0 while the row beneath it started
    /// at 731.33, and `ACCOUNT` overlapped the same 21.7pt. Frames prove
    /// layout participation and not z-order, but this pair is exactly the
    /// overlap the screenshot showed, in the order the two views are drawn.
    func testSettingsSectionHeadersAreNotCoveredByTheCardBelowAtLargestAccessibilitySize() {
        for arguments in [[String](), ["--dynamic-type=accessibility5"]] {
            let app = XCUIApplication()
            app.launchArguments = ["--settings-proof=SET-01"] + arguments
            app.launchAfterRetiringPriorInstance()
            XCTAssertTrue(
                app.descendants(matching: .any)["settings.screen"].waitForExistence(timeout: 5),
                app.debugDescription
            )

            let header = app.staticTexts["SELLING"]
            let firstRow = app.descendants(matching: .any)["settings.selling.marketplaces"]
            XCTAssertTrue(header.waitForExistence(timeout: 3), app.debugDescription)
            XCTAssertTrue(firstRow.exists, app.debugDescription)
            let receipt =
                "arguments=\(arguments), header=\(header.frame), firstRow=\(firstRow.frame)"
            let label = arguments.isEmpty ? "default" : "accessibility5"
            addScreenshot(named: "AX5-SETTINGS-SECTION-HEADERS-\(label)-402x874.png")
            XCTAssertLessThanOrEqual(header.frame.maxY, firstRow.frame.minY, receipt)
            app.terminate()
        }
    }

    /// `SettingsDeletionHeader` drew the centred title and the leading back
    /// control in one `ZStack` inside `.frame(height: 56)` (#839). The fixed
    /// height is the defect the section headers above were fixed for, but the
    /// axis that fails first on this bar is the other one: at `accessibility5`
    /// neither the title nor the back control shrinks, so the two overprint.
    /// Measured on `520f696ec` at 402x874: `Delete account` reported
    /// `(22.17, 52.67, 357.67, 74.67)` and `Settings` `(20.0, 52.67, 228.33,
    /// 74.67)` — the same 74.67pt band, overlapping across 226pt of a 402pt
    /// screen, which the attached `accessibility5` image shows as one word
    /// drawn through the other. That 74.67pt is also more than the 56pt the
    /// bar proposed, so the fixed height was over-run in the same reading;
    /// it did not reach the page below because that page starts at 148.0.
    ///
    /// Both sizes run: a bar that stacked at every size would pass the overlap
    /// check while destroying the default layout, so the default size asserts
    /// the opposite arrangement — back control and title sharing one row, with
    /// the title still inside the bar and above the page beneath it.
    func testDeletionHeaderTitleAndBackControlDoNotOverprintAtLargestAccessibilitySize() {
        for arguments in [[String](), ["--dynamic-type=accessibility5"]] {
            let app = XCUIApplication()
            app.launchArguments = ["--settings-proof=DEL-01"] + arguments
            app.launchAfterRetiringPriorInstance()
            XCTAssertTrue(
                app.descendants(matching: .any)["settings.state.del-01"]
                    .waitForExistence(timeout: 10),
                app.debugDescription
            )

            let title = app.staticTexts["Delete account"]
            let back = app.buttons["Settings"]
            let pageTitle = app.staticTexts["Delete your SnapList account"]
            XCTAssertTrue(title.waitForExistence(timeout: 3), app.debugDescription)
            XCTAssertTrue(back.exists, app.debugDescription)
            XCTAssertTrue(pageTitle.exists, app.debugDescription)
            let label = arguments.isEmpty ? "default" : "accessibility5"
            let receipt = """
            arguments=\(arguments), title=\(title.frame), back=\(back.frame), \
            pageTitle=\(pageTitle.frame)
            """
            addScreenshot(named: "AX5-SETTINGS-DELETION-HEADER-\(label)-402x874.png")
            XCTAssertFalse(title.frame.intersects(back.frame), receipt)
            // The bar has to have grown around both of them rather than letting
            // either one spill onto the page it sits above.
            XCTAssertLessThanOrEqual(title.frame.maxY, pageTitle.frame.minY, receipt)
            XCTAssertLessThanOrEqual(back.frame.maxY, pageTitle.frame.minY, receipt)
            if arguments.isEmpty {
                XCTAssertLessThanOrEqual(back.frame.maxX, title.frame.minX, receipt)
            }
            app.terminate()
        }
    }

    /// The floating dock is a `safeAreaInset`, so content scrolls behind it on
    /// the way past — what must hold is that a seller can always bring a row
    /// out from under it. Settings reserves the room in its own bottom padding;
    /// `TrophyWallProcessingView` reserved nothing, so its disclosure control
    /// stopped at `(14.0, 792.0, 374.33, 48.0)` under a dock at
    /// `(204.0, 782.0, 52.0, 52.0)` with the scroll already at its end (#836).
    ///
    /// The swipe loop is the assertion's own escape: it stops the moment the
    /// last row clears the dock, and when the screen cannot reserve the room it
    /// runs out and the comparison fails on the frames it actually observed.
    func testFloatingDockDoesNotCoverTheLastRowOfSettingsOrTrophyProcessing() {
        for (arguments, identifier, expandsFirst) in [
            (["--settings-proof=SET-01"], "settings.delete-account", false),
            (
                ["--fixture=trophy-processing", "--zero-network-fixtures"],
                "trophy.processing.disclosure",
                true
            ),
        ] {
            let app = XCUIApplication()
            app.launchArguments = arguments + ["--dynamic-type=accessibility5"]
            app.launchAfterRetiringPriorInstance()

            let dock = app.buttons["dock.trophy-wall"]
            XCTAssertTrue(dock.waitForExistence(timeout: 5), app.debugDescription)
            let last = app.descendants(matching: .any)[identifier]
            // Settings builds its rows lazily, so the last card does not exist
            // until it has been scrolled near. `where` on a `for-in` filters
            // which iterations run the body — it does not stop the loop, so a
            // `for _ in 0..<12 where !last.exists` kept polling `last.exists`
            // over IPC for every remaining iteration once the row was already
            // found (#942), each one a chance for a transient main-run-loop
            // stall on the app under test to surface as this selector's
            // failure. `break` makes the loop actually stop, as the comment
            // below always claimed it did.
            for _ in 0..<12 {
                guard !last.exists else { break }
                app.swipeUp()
            }
            XCTAssertTrue(last.waitForExistence(timeout: 5), app.debugDescription)
            // Collapsed, the processing list is short enough to clear the dock
            // on its own; the row that was covered is the one the expanded list
            // ends with.
            if expandsFirst {
                last.tap()
            }

            for _ in 0..<12 {
                guard last.frame.maxY > dock.frame.minY else { break }
                app.swipeUp()
            }
            let receipt =
                "identifier=\(identifier), last=\(last.frame), dock=\(dock.frame)"
            addScreenshot(named: "AX5-DOCK-CLEARANCE-\(identifier)-402x874.png")
            XCTAssertLessThanOrEqual(last.frame.maxY, dock.frame.minY, receipt)
            app.terminate()
        }
    }

    /// `SettingsSellingHintRow` renders only when the server reports an eBay
    /// policy problem, and no fixture produced that state, so #831 proved its
    /// container through `settings.selling.marketplaces` and left the row
    /// itself unbuilt in every test. `--settings-selling-fixture=policy-problem`
    /// builds it (#836).
    ///
    /// The row combines its children for VoiceOver, which deletes the `Link`
    /// from the accessibility tree, so the link has no element of its own to
    /// measure — `SettingsTests.testPolicyHintOffersTheEbayLinkAsAnActionOnTheCombinedElement`
    /// covers that seam at the rendered body type. What XCUITest can see is
    /// whether the combined row is tall enough to still contain the link's
    /// 44pt hit area under its message, which is precisely what the old
    /// `maxHeight: 52` cap took away, and whether it is on screen and
    /// hit-testable at both extremes of Dynamic Type.
    func testSettingsPolicyHintRowKeepsRoomForItsPolicyLinkAtBothTypeSizes() {
        for arguments in [[String](), ["--dynamic-type=accessibility5"]] {
            let app = XCUIApplication()
            app.launchArguments = [
                "--settings-proof=SET-01",
                "--settings-selling-fixture=policy-problem",
            ] + arguments
            app.launchAfterRetiringPriorInstance()

            let hint = app.descendants(matching: .any)["settings.ebay-policy-hint"]
            XCTAssertTrue(hint.waitForExistence(timeout: 5), app.debugDescription)

            let window = app.windows.firstMatch
            for _ in 0..<8 where hint.frame.maxY > window.frame.maxY {
                app.swipeUp()
            }
            let receipt =
                "arguments=\(arguments), hint=\(hint.frame), window=\(window.frame)"
            XCTAssertTrue(hint.isHittable, receipt)
            XCTAssertGreaterThanOrEqual(hint.frame.minX, window.frame.minX, receipt)
            XCTAssertLessThanOrEqual(hint.frame.maxX, window.frame.maxX, receipt)
            XCTAssertLessThanOrEqual(hint.frame.maxY, window.frame.maxY, receipt)
            // The message occupies at least one footnote line above the link,
            // so a row that still fits the old 52pt cap cannot be showing both.
            XCTAssertGreaterThan(hint.frame.height, 52, receipt)
            app.terminate()
        }
    }

    /// The subscription actions are plain buttons inside `settingsCardRow`, the
    /// same shape `LegalLinkRow` had before #831 gave it the row's full height,
    /// and none of them carried an identifier a test could name (#836). A touch
    /// target that comes from text height rather than the 44pt floor is
    /// thinnest at the smallest Dynamic Type size, which is where this checks —
    /// the opposite direction from the accessibility-size checks above.
    func testSubscriptionActionButtonsMeetTheTouchTargetFloorAtSmallestDynamicTypeSize() {
        let app = XCUIApplication()
        app.launchArguments = ["--settings-proof=SET-01", "--dynamic-type=xSmall"]
        app.launchAfterRetiringPriorInstance()
        XCTAssertTrue(
            app.descendants(matching: .any)["settings.screen"].waitForExistence(timeout: 5),
            app.debugDescription
        )

        for identifier in [
            "settings.subscription.manage",
            "settings.subscription.restore",
        ] {
            let button = app.buttons[identifier]
            for _ in 0..<6 where !button.exists {
                app.swipeUp()
            }
            XCTAssertTrue(button.waitForExistence(timeout: 3), app.debugDescription)
            XCTAssertGreaterThanOrEqual(
                button.frame.height,
                44,
                "identifier=\(identifier), frame=\(button.frame)"
            )
        }
    }

    /// `settings.subscription.retry` came out of #836 with an identifier and no
    /// assertion, because `SET-01` reports a verified subscription and skips
    /// `loadSubscription()` entirely, so nothing reached `SUB-15` and the 44pt
    /// floor the other two actions were given went unproved on this one (#839).
    /// `--settings-subscription-fixture=load-failed` reaches it.
    ///
    /// The assertion is load-bearing rather than satisfied by the identifier
    /// existing: dropping `maxHeight: .infinity` from the `Try again` label
    /// reports `(37.0, 602.0, 328.0, 20.33)` and reddens this line.
    ///
    /// Smallest Dynamic Type for the same reason as the sibling test above: a
    /// target sized from text height rather than the row's is thinnest there.
    /// `manage` rides along because `SUB-15` offers both, and a fixture that
    /// silently produced some other state would still satisfy a retry-only
    /// check by never rendering the button it was asked about.
    func testSubscriptionRetryMeetsTheTouchTargetFloorAtSmallestDynamicTypeSize() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--settings-proof=SET-01",
            "--settings-subscription-fixture=load-failed",
            "--dynamic-type=xSmall",
        ]
        app.launchAfterRetiringPriorInstance()
        XCTAssertTrue(
            app.descendants(matching: .any)["settings.screen"].waitForExistence(timeout: 5),
            app.debugDescription
        )
        XCTAssertTrue(
            app.descendants(matching: .any)["settings.subscription.sub-15"]
                .waitForExistence(timeout: 5),
            app.debugDescription
        )

        // An identifier on a stack with no explicit container reaches every
        // leaf inside it: both header `Text`s answered to
        // `settings.subscription.sub-15`, so the query matched two elements and
        // reading a frame from it was ambiguous. `.accessibilityElement(children:
        // .contain)` collapses that to the one container the identifier names
        // (#839).
        XCTAssertEqual(
            app.descendants(matching: .any)
                .matching(identifier: "settings.subscription.sub-15")
                .count,
            1,
            app.debugDescription
        )

        for identifier in [
            "settings.subscription.retry",
            "settings.subscription.manage",
        ] {
            let button = app.buttons[identifier]
            for _ in 0..<6 where !button.exists {
                app.swipeUp()
            }
            XCTAssertTrue(button.waitForExistence(timeout: 3), app.debugDescription)
            XCTAssertGreaterThanOrEqual(
                button.frame.height,
                44,
                "identifier=\(identifier), frame=\(button.frame)"
            )
        }
    }

    /// The rendered half of `SettingsTests.testValueRowsStackOnlyAtAccessibilitySizes`.
    ///
    /// A drawn hyphen is invisible to XCUITest: `Connected marketplaces` is the
    /// element's label whether the glyphs came out whole or as `Con-nected`, so
    /// the only proof that the word survived is the image (#839). What can be
    /// asserted from here is that the row is on screen, hit-testable and inside
    /// the window at the size where the break happened, so the attachment is of
    /// the row rather than of a row that scrolled somewhere else.
    func testSettingsValueRowsKeepWholeWordsAtLargestAccessibilitySize() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--settings-proof=SET-01",
            "--dynamic-type=accessibility5",
        ]
        app.launchAfterRetiringPriorInstance()
        XCTAssertTrue(
            app.descendants(matching: .any)["settings.screen"].waitForExistence(timeout: 5),
            app.debugDescription
        )

        let row = app.descendants(matching: .any)["settings.selling.marketplaces"]
        XCTAssertTrue(row.waitForExistence(timeout: 5), app.debugDescription)
        let window = app.windows.firstMatch
        for _ in 0..<8 where row.frame.maxY > window.frame.maxY {
            app.swipeUp()
        }
        let receipt = "row=\(row.frame), window=\(window.frame)"
        XCTAssertTrue(row.isHittable, receipt)
        XCTAssertGreaterThanOrEqual(row.frame.minX, window.frame.minX, receipt)
        XCTAssertLessThanOrEqual(row.frame.maxX, window.frame.maxX, receipt)
        addScreenshot(named: "AX5-SETTINGS-VALUE-ROWS-accessibility5-402x874.png")
    }

    /// Issue #812: each ABOUT row used to be a bare `HStack` with a chevron
    /// that promised navigation and delivered nothing. Tapping a real
    /// `openURL` hands the system off to Safari, which backgrounds this app —
    /// an outcome only genuine wiring can produce, so this asserts the
    /// behavior the row exists to perform rather than its appearance.
    ///
    /// One fresh launch per row, matching `testProGateOfferLegalFooterOpensTermsAndPrivacy`:
    /// a second `openURL` fired later in the same continuous foreground/
    /// background/foreground cycle does not reliably re-trigger the Safari
    /// handoff on the Simulator, so reusing one `app` across rows is not a
    /// faithful test of the row's own wiring.
    ///
    /// Taps the row's visible label rather than the full-width button's
    /// frame center: on this fixture the floating Scan/Trophy Wall dock
    /// (not dock-aware on this screen, a pre-existing gap outside #812's
    /// contract) happens to float over the privacy-policy row's horizontal
    /// midpoint, so a center tap lands on the dock instead of the row
    /// underneath. The label itself sits outside that strip and is what a
    /// real finger would actually land on.
    func testSettingsAboutRowsOpenTheirLiveLegalDestinations() {
        for identifier in [
            "settings.about.help",
            "settings.about.privacy-policy",
            "settings.about.terms-of-service",
        ] {
            XCUIApplication(bundleIdentifier: "com.apple.mobilesafari").terminate()

            let app = launch(extraArguments: ["--fixture=account"])
            let settingsScreen = app.descendants(matching: .any)["settings.screen"]
            XCTAssertTrue(settingsScreen.waitForExistence(timeout: 3), app.debugDescription)

            let row = app.buttons[identifier]
            XCTAssertTrue(row.exists, "\(identifier): \(app.debugDescription)")
            // `row.isHittable` is true even when the dock covers only the
            // row's frame center (issue #812's dock-overlap finding) — the
            // element underneath the tap is the label, so that is what must
            // actually be hittable. Swiping on `row.isHittable` was worse
            // than just unreliable: it can report true before the row has
            // been scrolled anywhere near the dock, which stopped the loop
            // at zero swipes and left the label off screen. The loop has to
            // keep going until the element being asserted on agrees.
            let label = row.staticTexts.firstMatch
            for _ in 0..<6 where !label.isHittable {
                app.swipeUp()
            }
            XCTAssertTrue(label.isHittable, "\(identifier): \(app.debugDescription)")

            label.tap()

            XCTAssertTrue(
                waitForBackgroundHandoff(app, timeout: Self.legalHandoffBudget),
                "\(identifier) did not hand off to Safari within "
                    + "\(Self.legalHandoffBudget)s: observed \(app.state.reportedName)"
            )
            app.terminate()
        }
    }

    /// Issue #812's own title: a row with a chevron promising navigation it
    /// never performs. `SettingsView.valueRow` no longer takes a `chevron`
    /// argument at all, so these three SELLING rows cannot render one — this
    /// confirms the rows still exist (not silently dropped) and are exactly
    /// what they claim to be: non-navigating, so not `XCUIElementTypeButton`.
    ///
    /// `--fixture=account` never reaches a confirmed eBay connection (the
    /// real `ebayPublishService` is unavailable under zero-network
    /// fixtures), so `settings.selling.marketplaces` stays this non-button
    /// value row here. Issue #865 makes that same row a real destination
    /// once connected — see `EbayPublishUITests` for that state, proved
    /// through `--settings-proof=SET-01`.
    ///
    /// `settings.selling.notifications` left this list in #891. It is a real
    /// switch over the iOS permission now, so "not a button" stopped being the
    /// thing worth asserting about it; `testSettingsNotificationsIsARealSwitch`
    /// covers what it became.
    func testSettingsSellingValueRowsAreNotButtons() {
        let app = launch(extraArguments: ["--fixture=account"])
        let settingsScreen = app.descendants(matching: .any)["settings.screen"]
        XCTAssertTrue(settingsScreen.waitForExistence(timeout: 3), app.debugDescription)

        for identifier in [
            "settings.selling.marketplaces",
            "settings.selling.photos",
        ] {
            let row = app.descendants(matching: .any)[identifier]
            for _ in 0..<4 where !row.exists {
                app.swipeUp()
            }
            XCTAssertTrue(row.exists, "\(identifier): \(app.debugDescription)")
            XCTAssertFalse(app.buttons[identifier].exists, "\(identifier): \(app.debugDescription)")
        }
    }

    /// Issue #891. The row drew a hardcoded `On` for every seller, including
    /// one who had refused, and it did nothing when tapped.
    ///
    /// A freshly installed simulator has never been asked, so the honest
    /// reading is off. The switch is deliberately not tapped here: on this
    /// state a tap raises the real iOS permission alert, which belongs to the
    /// system and not to the app under test. What the switch does with each
    /// permission state is proved in `SettingsNotificationsRowTests`; what this
    /// adds is that the row on screen is that switch, reading iOS rather than a
    /// literal.
    func testSettingsNotificationsIsARealSwitch() {
        let app = launch(extraArguments: ["--fixture=account"])
        let settingsScreen = app.descendants(matching: .any)["settings.screen"]
        XCTAssertTrue(settingsScreen.waitForExistence(timeout: 3), app.debugDescription)

        let toggle = app.switches["settings.selling.notifications"]
        let dock = app.buttons["dock.trophy-wall"]
        XCTAssertTrue(dock.exists, app.debugDescription)

        // Deliberately not the `where !element.exists` loop the sign-out and
        // delete-account tests in this file still use. `exists` is true for a
        // row that is scrolled off screen or sitting under the floating dock,
        // so that loop stops swiping before the row is reachable and then
        // asserts something it never actually brought into view.
        for _ in 0..<10 where !(toggle.exists && toggle.frame.maxY <= dock.frame.minY) {
            app.swipeUp()
        }
        XCTAssertTrue(toggle.waitForExistence(timeout: 3), app.debugDescription)
        XCTAssertLessThanOrEqual(
            toggle.frame.maxY,
            dock.frame.minY,
            "toggle=\(toggle.frame), dock=\(dock.frame)"
        )
        XCTAssertEqual(toggle.value as? String, "0", app.debugDescription)
    }

    /// Aziz found the subscription ownership note ("Apple bills and
    /// cancels…") resting behind the floating Scan/Trophy Wall dock instead
    /// of above it — the same "not dock-aware on this screen" gap
    /// `testSettingsAboutRowsOpenTheirLiveLegalDestinations` already
    /// documented for the ABOUT rows. `isHittable` reports true even when
    /// the dock visually covers an element's center (#730), so this checks
    /// geometry instead: the note's bottom edge against the dock's top edge.
    func testSettingsSubscriptionOwnershipNoteClearsTheFloatingDock() {
        let app = launch(extraArguments: ["--settings-proof=SET-01"])
        let settingsScreen = app.descendants(matching: .any)["settings.screen"]
        XCTAssertTrue(settingsScreen.waitForExistence(timeout: 3), app.debugDescription)

        let note = app.descendants(matching: .any)["settings.subscription.ownership-note"]
        let dock = app.buttons["dock.trophy-wall"]
        XCTAssertTrue(dock.exists, app.debugDescription)

        // Stopping the swipe as soon as the note merely exists caught it
        // the moment it entered the bottom edge — still well below the
        // dock's top, not yet clear of it. Keep swiping until it has
        // actually cleared, the same fix
        // `testSettingsAboutRowsOpenTheirLiveLegalDestinations` needed for
        // its own swipe loop.
        for _ in 0..<10 where !(note.exists && note.frame.maxY <= dock.frame.minY) {
            app.swipeUp()
        }
        XCTAssertTrue(note.waitForExistence(timeout: 3), app.debugDescription)
        XCTAssertLessThanOrEqual(
            note.frame.maxY,
            dock.frame.minY,
            "note=\(note.frame), dock=\(dock.frame)"
        )
    }

    func testActivationCompletionSuppressesTheCoachMarkAcrossRelaunch() {
        let app = launch(extraArguments: [
            "--activation-onboarded-fixture",
            "--reset-activation-guidance",
            "--visual-state=RUN-02",
            "--run-detail-fixture=reviewable",
            "--activation-guidance-step=listingReview",
            "--listing-review-fixture=loaded"
        ])

        XCTAssertTrue(app.buttons["run.review.open"].waitForExistence(timeout: 3))
        app.buttons["run.review.open"].tap()
        XCTAssertTrue(activationGuidance(in: app).waitForExistence(timeout: 3))
        app.buttons["activation-guidance.got-it"].tap()
        XCTAssertFalse(activationGuidance(in: app).exists)

        app.terminate()
        app.launchArguments = [
            "--zero-network-fixtures",
            "--activation-onboarded-fixture",
            "--visual-state=RUN-02",
            "--run-detail-fixture=reviewable",
            "--listing-review-fixture=loaded"
        ]
        app.launch()

        XCTAssertTrue(app.buttons["run.review.open"].waitForExistence(timeout: 3))
        app.buttons["run.review.open"].tap()
        XCTAssertFalse(activationGuidance(in: app).waitForExistence(timeout: 1))
    }

    func testActivationOnlyPerStepGotItDismissesTheCoachMark() {
        let fixtures: [(name: String, arguments: [String], opensReview: Bool)] = [
            (
                name: "ACT-01-normal",
                arguments: [
                    "--activation-onboarded-fixture",
                    "--reset-activation-guidance"
                ],
                opensReview: false
            ),
            (
                name: "ACT-01-reduced-motion",
                arguments: [
                    "--activation-onboarded-fixture",
                    "--reset-activation-guidance",
                    "--reduced-motion"
                ],
                opensReview: false
            ),
            (
                name: "ACT-04-normal",
                arguments: [
                    "--activation-onboarded-fixture",
                    "--reset-activation-guidance",
                    "--visual-state=RUN-02",
                    "--run-detail-fixture=reviewable",
                    "--activation-guidance-step=listingReview",
                    "--listing-review-fixture=loaded"
                ],
                opensReview: true
            ),
            (
                name: "ACT-04-reduced-motion",
                arguments: [
                    "--activation-onboarded-fixture",
                    "--reset-activation-guidance",
                    "--visual-state=RUN-02",
                    "--run-detail-fixture=reviewable",
                    "--activation-guidance-step=listingReview",
                    "--listing-review-fixture=loaded",
                    "--reduced-motion"
                ],
                opensReview: true
            )
        ]

        for fixture in fixtures {
            let app = launch(extraArguments: fixture.arguments)
            if fixture.opensReview {
                XCTAssertTrue(app.buttons["run.review.open"].waitForExistence(timeout: 3))
                app.buttons["run.review.open"].tap()
            }

            let guidance = activationGuidance(in: app)
            XCTAssertTrue(guidance.waitForExistence(timeout: 3))
            XCTAssertEqual(
                guidance.label,
                fixture.opensReview
                    ? "Guidance. Every field here is yours to change."
                    : "Guidance. One item, up to five photos."
            )
            XCTAssertEqual(guidance.buttons.count, 1)

            let gotIt = app.buttons["activation-guidance.got-it"]
            XCTAssertTrue(gotIt.exists)
            XCTAssertEqual(gotIt.label, "Got it")
            XCTAssertGreaterThanOrEqual(gotIt.frame.width, 44)
            XCTAssertGreaterThanOrEqual(gotIt.frame.height, 44)

            addScreenshot(named: "activation-\(fixture.name).png")

            guidance.swipeDown()
            XCTAssertTrue(guidance.waitForExistence(timeout: 1))

            gotIt.tap()
            if !fixture.opensReview {
                XCTAssertFalse(guidance.waitForExistence(timeout: 2))
            }
            app.terminate()
        }
    }

    /// Scan opens directly into the camera preview (#864): there is no more
    /// launcher sheet standing between the tab and `ScanCameraView`, so its own
    /// camera-unavailable recovery state is reached by launching straight into
    /// Scan rather than by tapping a `capture.take-one-item` control that no
    /// longer exists.
    ///
    /// `--reset-capture-draft` guarantees a clean starting draft: this test's
    /// camera surface uses the real, file-backed `LocalCaptureDraftStore`
    /// (deliberately durable across relaunches so a seller's staged photo
    /// survives one), which without a reset would inherit a stray staged
    /// photo left behind by an earlier test sharing the same shard invocation
    /// and app container.
    func testTakeOneItemUsesTheNativeCameraRecoveryAndKeepsLibraryEscapeReachable() {
        let app = launch(extraArguments: [
            "--camera-status=authorized",
            "--reset-capture-draft"
        ])

        XCTAssertTrue(app.staticTexts["Camera is not available"].waitForExistence(timeout: 3))
        addScreenshot(named: "CAPTURE-CAMERA-UNAVAILABLE.png")
        let library = app.buttons["scan.choose-library"]
        XCTAssertEqual(app.buttons.matching(identifier: "scan.choose-library").count, 1)
        XCTAssertTrue(library.exists)
        XCTAssertEqual(library.label, "Choose from library")
        XCTAssertGreaterThanOrEqual(library.frame.width, 44)
        XCTAssertGreaterThanOrEqual(library.frame.height, 44)

        library.tap()
        XCTAssertTrue(app.buttons["Cancel"].waitForExistence(timeout: 3))
        app.buttons["Cancel"].tap()
        XCTAssertTrue(app.staticTexts["Camera is not available"].waitForExistence(timeout: 2))
    }

    func testRestoredDraftResumesBeforeTheFreshLauncherCanOverwriteIt() {
        let app = XCUIApplication()
        app.launchArguments = ["--restored-capture-fixture"]
        app.launchAfterRetiringPriorInstance()

        // #954 deleted the "N of 5" capsule. The strip and Review's own
        // count-bearing name carry that truth now, so the restored draft is
        // proved by exactly one thumbnail rather than by the capsule's text.
        let firstPhoto = app.descendants(matching: .any)["scan.photo-1"]
        XCTAssertTrue(firstPhoto.waitForExistence(timeout: 3))
        XCTAssertEqual(
            app.descendants(matching: .any).matching(identifier: "scan.photo-1").count,
            1,
            app.debugDescription
        )
        XCTAssertFalse(app.descendants(matching: .any)["scan.photo-2"].exists)
        XCTAssertFalse(app.staticTexts["sheet.capture.title"].exists)
        XCTAssertFalse(app.buttons["capture.take-one-item"].exists)
        XCTAssertFalse(app.buttons["capture.choose-library"].exists)
        addScreenshot(named: "CAPTURE-RESTORED-DRAFT.png")

        let reviewButton = app.buttons["scan.review"]
        let window = app.windows.firstMatch.frame
        XCTAssertEqual(
            app.buttons.matching(identifier: "scan.review").count,
            1,
            app.debugDescription
        )
        XCTAssertTrue(reviewButton.exists)
        XCTAssertGreaterThanOrEqual(reviewButton.frame.minX, window.minX)
        XCTAssertLessThanOrEqual(reviewButton.frame.maxX, window.maxX)
        XCTAssertGreaterThanOrEqual(reviewButton.frame.height, 44)
        reviewButton.tap()
        XCTAssertFalse(app.buttons["scan.review"].waitForExistence(timeout: 1))
        XCTAssertTrue(app.scrollViews["photo-review.screen"].waitForExistence(timeout: 3))
    }

    func testLiveScanReviewOpensApprovedPhotoReviewShellWithExactRestoredPhoto() {
        let app = XCUIApplication()
        app.launchArguments = ["--restored-capture-fixture"]
        app.launchAfterRetiringPriorInstance()

        let firstPhoto = app.descendants(matching: .any)["scan.photo-1"]
        XCTAssertTrue(firstPhoto.waitForExistence(timeout: 3))
        XCTAssertEqual(
            app.descendants(matching: .any).matching(identifier: "scan.photo-1").count,
            1
        )

        let review = app.buttons["scan.review"]
        XCTAssertEqual(app.buttons.matching(identifier: "scan.review").count, 1)
        XCTAssertTrue(review.exists)
        XCTAssertEqual(review.label, "Review 1 photo")
        review.tap()

        let screen = app.scrollViews["photo-review.screen"]
        guard screen.waitForExistence(timeout: 3) else {
            XCTFail(
                "The live Scan request must render the typed Photo Review screen."
            )
            return
        }

        XCTAssertEqual(app.staticTexts["photo-review.count"].label, "1 of 5")

        let hero = app.buttons["photo-review.hero"]
        let thumbnail = app.buttons["photo-review.thumbnail.1"]
        XCTAssertTrue(hero.exists)
        XCTAssertTrue(thumbnail.exists)
        XCTAssertTrue(hero.label.contains("Photo 1 of 1"))
        XCTAssertTrue(hero.label.contains("Cover"))
        XCTAssertTrue(hero.label.contains("selected"))
        XCTAssertTrue(thumbnail.label.contains("Photo 1 of 1"))
        XCTAssertTrue(thumbnail.label.contains("Cover"))
        XCTAssertTrue(thumbnail.isSelected)

        XCTAssertFalse(app.buttons["scan.review"].exists)
        XCTAssertFalse(app.staticTexts["Scan"].exists)
    }

    func testLivePhotoReviewBackReturnsExactRestoredPhotoAndFocusesScanReview() {
        let app = XCUIApplication()
        app.launchArguments = ["--restored-capture-fixture"]
        app.launchAfterRetiringPriorInstance()

        let initialPhoto = app.descendants(matching: .any)["scan.photo-1"]
        XCTAssertTrue(initialPhoto.waitForExistence(timeout: 3))

        let initialReview = app.buttons["scan.review"]
        XCTAssertTrue(initialReview.exists)
        XCTAssertEqual(initialReview.label, "Review 1 photo")
        initialReview.tap()

        let screen = app.scrollViews["photo-review.screen"]
        XCTAssertTrue(screen.waitForExistence(timeout: 3))

        let back = app.buttons["photo-review.back"]
        guard back.waitForExistence(timeout: 2) else {
            XCTFail(
                "Live Photo Review must expose the native Back to camera control."
            )
            return
        }
        XCTAssertEqual(back.label, "Back to camera")
        XCTAssertGreaterThanOrEqual(back.frame.width, 44)
        XCTAssertGreaterThanOrEqual(back.frame.height, 44)
        back.tap()

        let returnedReview = app.buttons["scan.review"]
        let returnedPhoto = app.descendants(matching: .any)["scan.photo-1"]
        XCTAssertTrue(
            returnedReview.waitForExistence(timeout: 3),
            "Back must return the seller to Scan with the Review opener intact."
        )
        XCTAssertFalse(screen.waitForExistence(timeout: 2))

        XCTAssertTrue(returnedPhoto.waitForExistence(timeout: 3))

        XCTAssertEqual(returnedReview.label, "Review 1 photo")
        XCTAssertEqual(
            app.buttons.matching(identifier: "scan.review").count,
            1,
            app.debugDescription
        )
        // Review-opener focus restoration is an accessibility-cursor contract, which
        // XCUITest cannot observe without an assistive technology running. It is proved
        // directly by ScanReturnFocusPolicy and by the router-seam return assertions.
    }

    func testLivePhotoReviewVoiceAndStartListingStayTypedBoundariesOverIntake() {
        let app = XCUIApplication()
        app.launchArguments = ["--restored-capture-fixture"]
        app.launchAfterRetiringPriorInstance()

        let review = app.buttons["scan.review"]
        XCTAssertTrue(review.waitForExistence(timeout: 3))
        review.tap()

        let screen = app.scrollViews["photo-review.screen"]
        XCTAssertTrue(screen.waitForExistence(timeout: 3))

        let voice = app.buttons["photo-review.voice"]
        let startListing = app.buttons["photo-review.start-listing"]
        XCTAssertTrue(voice.waitForExistence(timeout: 2))
        XCTAssertTrue(startListing.exists)
        // Live Photo Review v5 owns the collapsed row; Voice Note v8 starts only
        // after the typed opener resolves to its recorder sheet.
        XCTAssertEqual(
            voice.label,
            "Voice note, Add details the photos might miss, collapsed"
        )
        XCTAssertEqual(startListing.label, "Start listing")
        XCTAssertTrue(startListing.isEnabled)
        XCTAssertGreaterThanOrEqual(voice.frame.height, 44)
        XCTAssertGreaterThanOrEqual(startListing.frame.height, 44)

        let count = app.staticTexts["photo-review.count"]
        let coverLabel = app.buttons["photo-review.thumbnail.1"].label
        XCTAssertEqual(count.label, "1 of 5")

        voice.tap()
        let sheetTitle = app.staticTexts["voice-note.title"]
        let helper = app.staticTexts["voice-note.helper"]
        let record = app.buttons["voice-note.record"]
        let close = app.buttons["voice-note.close"]
        XCTAssertTrue(sheetTitle.waitForExistence(timeout: 2))
        XCTAssertEqual(sheetTitle.label, "Voice note")
        XCTAssertEqual(helper.label, "Add details the photos might miss.")
        XCTAssertTrue(record.exists)
        XCTAssertEqual(record.label, "Start recording")
        XCTAssertGreaterThanOrEqual(record.frame.width, 44)
        XCTAssertGreaterThanOrEqual(record.frame.height, 44)
        XCTAssertTrue(close.exists)
        XCTAssertEqual(close.label, "Close")
        XCTAssertGreaterThanOrEqual(
            close.frame.width,
            44,
            "Voice note Close must expose the approved 44-point target width."
        )
        XCTAssertGreaterThanOrEqual(
            close.frame.height,
            44,
            "Voice note Close must expose the approved 44-point target height."
        )
        addScreenshot(named: "VOICE-NOTE-V8-RECORDER-EXPANDED-402x874.png")
        let accessibilityOrder = app
            .descendants(matching: .any)
            .allElementsBoundByAccessibilityElement
            .map(\.identifier)
            .filter { !$0.isEmpty }
        let accessibilityAttachment = XCTAttachment(
            string: accessibilityOrder.joined(separator: "\n")
        )
        accessibilityAttachment.name = "VOICE-NOTE-V8-RECORDER-EXPANDED-AX-ORDER.txt"
        accessibilityAttachment.lifetime = .keepAlways
        add(accessibilityAttachment)
        close.tap()
        XCTAssertTrue(voice.waitForExistence(timeout: 2))

        startListing.tap()

        XCTAssertTrue(
            screen.exists,
            "Start listing stays in place until its canonical receipt resolves."
        )
        XCTAssertEqual(
            count.label,
            "1 of 5",
            "A typed boundary never clears or mutates photo intake."
        )
        XCTAssertEqual(app.buttons["photo-review.thumbnail.1"].label, coverLabel)

        // Neither control may claim work this shell does not do.
        for claim in [
            "Recording", "Uploaded", "Analyzing", "Queued", "Credit used",
            "Item saved", "Saving your item", "Shared"
        ] {
            XCTAssertEqual(
                app.staticTexts.matching(
                    NSPredicate(format: "label CONTAINS %@", claim)
                ).count,
                0,
                "Photo Review must not claim \(claim)."
            )
        }
    }

    func testPhotoReviewControlsReachTheirExactTypedBoundaryDestinations() {
        let acknowledgmentNotification =
            "dev.snaplist.ios.test.submission-ack.\(UUID().uuidString)"
        let app = XCUIApplication()
        app.launchArguments = [
            "--restored-capture-fixture",
            "--submission-fixture=accepted-presentation-gated",
            "--submission-acknowledgment-notification=\(acknowledgmentNotification)"
        ]
        app.launchAfterRetiringPriorInstance()

        let review = app.buttons["scan.review"]
        XCTAssertTrue(review.waitForExistence(timeout: 3))
        review.tap()

        let voice = app.buttons["photo-review.voice"]
        let startListing = app.buttons["photo-review.start-listing"]
        XCTAssertTrue(voice.waitForExistence(timeout: 3))
        XCTAssertTrue(startListing.exists)
        XCTAssertEqual(startListing.label, "Start listing")

        voice.tap()

        XCTAssertTrue(
            app.staticTexts["voice-note.title"].waitForExistence(timeout: 2),
            "Voice control must reach the Voice boundary."
        )
        let unexpectedSubmission = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in
                startListing.label != "Start listing"
            },
            object: startListing
        )
        unexpectedSubmission.isInverted = true
        XCTAssertEqual(
            XCTWaiter.wait(for: [unexpectedSubmission], timeout: 3),
            .completed,
            "Voice control must not reach the submission boundary."
        )

        app.buttons["voice-note.close"].tap()
        XCTAssertTrue(startListing.waitForExistence(timeout: 2))

        startListing.tap()

        let saved = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in
                startListing.exists && startListing.label == "Done"
            },
            object: startListing
        )
        XCTAssertEqual(
            XCTWaiter.wait(for: [saved], timeout: 3),
            .completed,
            "Start listing control must reach the accepted Done boundary."
        )
        XCTAssertTrue(startListing.isEnabled)
        XCTAssertEqual(
            app.staticTexts["photo-review.submission-message"].label,
            "Item saved"
        )
        XCTAssertFalse(app.buttons["photo-review.add"].isEnabled)
    }

    func testVoiceNoteRecordingAccessibilityOrderIsCancelElapsedSave() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--restored-capture-fixture",
            "--voice-note-take-ready-fixture"
        ]
        app.launchAfterRetiringPriorInstance()

        let review = app.buttons["scan.review"]
        XCTAssertTrue(review.waitForExistence(timeout: 3))
        review.tap()

        let voice = app.buttons["photo-review.voice"]
        XCTAssertTrue(voice.waitForExistence(timeout: 3))
        voice.tap()

        let cancel = app.buttons["voice-note.cancel"]
        let elapsed = app.staticTexts["voice-note.elapsed"]
        let save = app.buttons["voice-note.save"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 2))
        XCTAssertTrue(elapsed.exists)
        XCTAssertTrue(save.exists)

        let orderedIdentifiers = app
            .descendants(matching: .any)
            .allElementsBoundByAccessibilityElement
            .map(\.identifier)
        let cancelIndex = try? XCTUnwrap(
            orderedIdentifiers.firstIndex(of: "voice-note.cancel")
        )
        let elapsedIndex = try? XCTUnwrap(
            orderedIdentifiers.firstIndex(of: "voice-note.elapsed")
        )
        let saveIndex = try? XCTUnwrap(
            orderedIdentifiers.firstIndex(of: "voice-note.save")
        )

        XCTAssertLessThan(cancelIndex ?? .max, elapsedIndex ?? .max)
        XCTAssertLessThan(elapsedIndex ?? .max, saveIndex ?? .max)
    }

    func testVoiceNoteSheetRejectsSwipeAndCloseRestoresStableReopenTruth() {
        let saved = launchVoiceNoteFixture(
            "--voice-note-saved-playing-fixture"
        )
        let savedClose = saved.buttons["voice-note.close"]
        let playback = saved.buttons["voice-note.playback"]
        let rerecord = saved.buttons["voice-note.rerecord"]
        let delete = saved.buttons["voice-note.delete"]
        XCTAssertEqual(playback.label, "Pause voice note")
        XCTAssertTrue(rerecord.exists)
        XCTAssertTrue(delete.exists)

        playback.tap()
        XCTAssertEqual(playback.label, "Play voice note")

        attemptVoiceNoteSwipeDismiss(in: saved)

        XCTAssertTrue(savedClose.exists)
        XCTAssertEqual(playback.label, "Play voice note")

        savedClose.tap()
        let savedRow = saved.buttons["photo-review.voice"]
        XCTAssertTrue(savedRow.waitForExistence(timeout: 2))
        XCTAssertEqual(savedRow.label, "Voice note, 0:12, collapsed")
        savedRow.tap()
        XCTAssertEqual(
            saved.buttons["voice-note.playback"].label,
            "Play voice note"
        )
        saved.buttons["voice-note.close"].tap()
        saved.terminate()

        let interrupted = launchVoiceNoteFixture(
            "--voice-note-interrupted-fixture"
        )
        let interruptedCopy = interrupted.staticTexts[
            "Recording stopped. Nothing was saved."
        ]
        XCTAssertTrue(interruptedCopy.exists)

        attemptVoiceNoteSwipeDismiss(in: interrupted)

        XCTAssertTrue(interrupted.buttons["voice-note.close"].exists)
        XCTAssertTrue(interruptedCopy.exists)

        interrupted.buttons["voice-note.close"].tap()
        let emptyRow = interrupted.buttons["photo-review.voice"]
        XCTAssertTrue(emptyRow.waitForExistence(timeout: 2))
        XCTAssertEqual(
            emptyRow.label,
            "Voice note, Add details the photos might miss, collapsed"
        )
        emptyRow.tap()
        XCTAssertTrue(
            interrupted.buttons["voice-note.record"]
                .waitForExistence(timeout: 2)
        )
        XCTAssertFalse(interruptedCopy.exists)
    }

    func testVoiceNoteRecordingCancelAndSaveBothDismissToExactRowTruth() {
        let canceled = launchVoiceNoteFixture(
            "--voice-note-recording-fixture",
            expectedControl: "voice-note.cancel"
        )
        let cancel = canceled.buttons["voice-note.cancel"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 2))
        cancel.tap()
        let emptyRow = canceled.buttons["photo-review.voice"]
        XCTAssertTrue(emptyRow.waitForExistence(timeout: 2))
        XCTAssertEqual(
            emptyRow.label,
            "Voice note, Add details the photos might miss, collapsed"
        )
        canceled.terminate()

        let saved = launchVoiceNoteFixture(
            "--voice-note-recording-fixture",
            expectedControl: "voice-note.cancel"
        )
        let save = saved.buttons["voice-note.save"]
        XCTAssertTrue(save.waitForExistence(timeout: 2))
        save.tap()
        let savedRow = saved.buttons["photo-review.voice"]
        XCTAssertTrue(savedRow.waitForExistence(timeout: 2))
        XCTAssertEqual(savedRow.label, "Voice note, 0:07, collapsed")
    }

    func testSubmissionVisualFixturesExposeWorkingCancelRetryAndDoneActions() {
        let saving = XCUIApplication()
        saving.launchArguments = [
            "--photo-review-state=REV-02",
            "--submission-visual-state=SUB-01",
            "--zero-network-fixtures",
        ]
        saving.launchAfterRetiringPriorInstance()

        let savingAction = saving.buttons["photo-review.start-listing"]
        XCTAssertTrue(savingAction.waitForExistence(timeout: 3))
        XCTAssertEqual(savingAction.label, "Cancel")
        savingAction.tap()

        let cancelledMessage = saving.staticTexts[
            "photo-review.submission-message"
        ]
        XCTAssertTrue(cancelledMessage.waitForExistence(timeout: 2))
        XCTAssertEqual(
            cancelledMessage.label,
            "Not sent yet. Your item is saved on this phone."
        )
        XCTAssertEqual(savingAction.label, "Start listing")

        savingAction.tap()
        let retrySaving = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in
                savingAction.label == "Cancel"
            },
            object: savingAction
        )
        XCTAssertEqual(
            XCTWaiter.wait(for: [retrySaving], timeout: 2),
            .completed
        )
        saving.terminate()

        let accepted = XCUIApplication()
        accepted.launchArguments = [
            "--photo-review-state=REV-02",
            "--submission-visual-state=SUB-05",
            "--zero-network-fixtures",
        ]
        accepted.launchAfterRetiringPriorInstance()

        let done = accepted.buttons["photo-review.start-listing"]
        XCTAssertTrue(done.waitForExistence(timeout: 3))
        XCTAssertEqual(done.label, "Done")
        done.tap()
        XCTAssertEqual(done.label, "Start listing")
    }

    /// Every other rejection state has a launch route, which is what makes a
    /// simctl launch plus a screenshot a free see-the-screen check. The
    /// `photosTooLarge` banner shipped in #785 without one and sits on the
    /// seller's critical path, so this proves the route by taking it — reading
    /// the switch would prove only that a case was written.
    func testPhotosTooLargeBannerHasALaunchableFixtureRoute() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--photo-review-state=REV-02",
            "--submission-visual-state=SUB-07-photos-too-large",
            "--zero-network-fixtures",
        ]
        app.launchAfterRetiringPriorInstance()

        let message = app.staticTexts["photo-review.submission-message"]
        XCTAssertTrue(UINavigationReturnBoundary().restored(message))
        XCTAssertEqual(
            message.label,
            "These photos are too large to send. Remove or retake one, then try again."
        )

        // The remedy the banner names is reviewing the photos, so the route has
        // to land on that action and not on a retry of the same bytes.
        let action = app.buttons["photo-review.start-listing"]
        XCTAssertTrue(action.exists)
        XCTAssertEqual(action.label, "Review")
    }

    func testLivePhotoReviewShowsBoundedSavingStateDuringZeroNetworkSubmission() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--restored-capture-fixture",
            "--submission-fixture=delayed"
        ]
        app.launchAfterRetiringPriorInstance()

        let review = app.buttons["scan.review"]
        XCTAssertTrue(review.waitForExistence(timeout: 3))
        review.tap()

        let screen = app.scrollViews["photo-review.screen"]
        XCTAssertTrue(screen.waitForExistence(timeout: 3))

        let startListing = app.buttons["photo-review.start-listing"]
        let addPhoto = app.buttons["photo-review.add"]
        XCTAssertTrue(startListing.waitForExistence(timeout: 2))
        XCTAssertTrue(addPhoto.waitForExistence(timeout: 2))
        XCTAssertEqual(startListing.label, "Start listing")
        XCTAssertTrue(startListing.isEnabled)
        XCTAssertTrue(addPhoto.isEnabled)

        startListing.tap()

        let saving = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in
                startListing.label == "Cancel"
                    && startListing.isEnabled
                    && !addPhoto.isEnabled
            },
            object: startListing
        )
        XCTAssertEqual(
            XCTWaiter.wait(for: [saving], timeout: 8),
            .completed,
            "The real Photo Review must expose the bounded saving label and mutation lock."
        )

        startListing.tap()

        let completed = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in
                startListing.label == "Start listing"
                    && startListing.isEnabled
                    && addPhoto.isEnabled
                    && app.staticTexts["photo-review.submission-message"].label
                        == "Not sent yet. Your item is saved on this phone."
            },
            object: startListing
        )
        XCTAssertEqual(
            XCTWaiter.wait(for: [completed], timeout: 12),
            .completed,
            "Only the in-flight interval may keep Photo Review mutations locked."
        )
    }

    func testRateLimitedSubmissionRendersExactRetainedMessageInLivePhotoReview() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--restored-capture-fixture",
            "--submission-fixture=rate-limited"
        ]
        app.launchAfterRetiringPriorInstance()

        let review = app.buttons["scan.review"]
        XCTAssertTrue(review.waitForExistence(timeout: 3))
        review.tap()

        let screen = app.scrollViews["photo-review.screen"]
        XCTAssertTrue(screen.waitForExistence(timeout: 3))

        let hero = app.buttons["photo-review.hero"]
        let thumbnail = app.buttons["photo-review.thumbnail.1"]
        let addPhoto = app.buttons["photo-review.add"]
        let startListing = app.buttons["photo-review.start-listing"]
        XCTAssertTrue(hero.exists)
        XCTAssertTrue(thumbnail.exists)
        XCTAssertTrue(addPhoto.exists)
        XCTAssertTrue(startListing.exists)
        XCTAssertEqual(startListing.label, "Start listing")
        XCTAssertTrue(startListing.isEnabled)
        XCTAssertTrue(addPhoto.isEnabled)

        startListing.tap()

        let retainedMessage =
            app.staticTexts["photo-review.submission-message"]
        let rejectionPresented = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in
                startListing.exists
                    && startListing.label == "Try again"
                    && startListing.isEnabled
                    && addPhoto.isEnabled
                    && hero.exists
                    && thumbnail.exists
                    && retainedMessage.exists
                    && retainedMessage.label
                        == "This didn't go through. Your item is still saved on this phone."
            },
            object: nil
        )
        // This waits out the whole tap-to-terminal-outcome transition in one go,
        // so it needs the budget the bounded-saving test spends reaching the same
        // point in two steps: 8 seconds to observe saving, then 12 more to observe
        // the outcome. Three seconds only bought about three predicate evaluations
        // and went red on a slow runner against an unchanged app.
        XCTAssertEqual(
            XCTWaiter.wait(for: [rejectionPresented], timeout: 20),
            .completed,
            "Typed rate limiting must visibly render the exact retained-item message."
        )

        XCTAssertTrue(screen.exists)
        XCTAssertEqual(
            app.staticTexts.matching(
                identifier: "photo-review.submission-message"
            ).count,
            1,
            "One rejection event must render one stable visible message."
        )
        XCTAssertFalse(app.buttons["scan.library"].exists)
        XCTAssertFalse(app.buttons["scan.choose-library"].exists)
        // Live photo review is not a primary destination, so it carries no dock
        // at all. This stays an existence check: asking whether a missing
        // element is selected raises instead of failing the way it reads.
        XCTAssertFalse(app.buttons["dock.trophy-wall"].exists)
        XCTAssertFalse(app.staticTexts["Listing Review"].exists)
        XCTAssertFalse(app.buttons["Cancel"].exists)
        // Announcement once-per-event remains the direct submission effect-consumer
        // contract. XCUI proves rendered copy only; it cannot observe VoiceOver delivery.
    }

    /// #803, captured on device: a signed-in seller taps Start listing, 425 KB of
    /// photos upload, the route answers `401`, and the seller is shown nothing at
    /// all while the button relabels itself to `Create an account`. This drives the
    /// production Photo Review — the fixture replaces only the network submitter, so
    /// the message node and the button label here are the ones a seller reads.
    func testRejectedSessionRendersRenewalCopyAndKeepsPhotosInLivePhotoReview() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--restored-capture-fixture",
            "--submission-fixture=session-rejected"
        ]
        app.launchAfterRetiringPriorInstance()

        let review = app.buttons["scan.review"]
        XCTAssertTrue(review.waitForExistence(timeout: 3))
        review.tap()

        let screen = app.scrollViews["photo-review.screen"]
        XCTAssertTrue(screen.waitForExistence(timeout: 3))

        let hero = app.buttons["photo-review.hero"]
        let thumbnail = app.buttons["photo-review.thumbnail.1"]
        let addPhoto = app.buttons["photo-review.add"]
        let startListing = app.buttons["photo-review.start-listing"]
        XCTAssertTrue(hero.exists)
        XCTAssertTrue(thumbnail.exists)
        XCTAssertEqual(startListing.label, "Start listing")

        startListing.tap()

        let renewalMessage =
            app.staticTexts["photo-review.submission-message"]
        let renewalPresented = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in
                startListing.exists
                    && startListing.label == "Try again"
                    && startListing.isEnabled
                    && addPhoto.isEnabled
                    && hero.exists
                    && thumbnail.exists
                    && renewalMessage.exists
                    && renewalMessage.label
                        == "Your sign-in needs renewing. Your item is still saved on this phone."
            },
            object: nil
        )
        // Same budget as the rate-limited render for the same reason: this waits
        // out the whole tap-to-terminal-outcome transition in one predicate.
        XCTAssertEqual(
            XCTWaiter.wait(for: [renewalPresented], timeout: 20),
            .completed,
            "A rejected session must render its own message, not silence."
        )

        // The captured defect: the seller already has an account, so offering one
        // is both a lie and a dead end — the route that fixes this is the retry.
        XCTAssertNotEqual(startListing.label, "Create an account")
        // `account-entry` identifies the sheet's container view, not a button, so
        // `app.buttons` would match nothing whether or not it presented and the
        // assertion could never fail. Same query the sign-in sheet is asserted
        // with elsewhere in this file.
        XCTAssertFalse(app.descendants(matching: .any)["account-entry"].exists)
        XCTAssertTrue(screen.exists)
        XCTAssertEqual(
            app.staticTexts.matching(
                identifier: "photo-review.submission-message"
            ).count,
            1,
            "One rejection event must render one stable visible message."
        )
    }

    func testAcceptedSubmissionRendersSavedWithoutSubmittedMediaThenReturnsToReadyScan() {
        let acknowledgmentNotification =
            "dev.snaplist.ios.test.submission-ack.\(UUID().uuidString)"
        let app = XCUIApplication()
        app.launchArguments = [
            "--restored-capture-fixture",
            "--submission-fixture=accepted-presentation-gated",
            "--submission-acknowledgment-notification=\(acknowledgmentNotification)"
        ]
        app.launchAfterRetiringPriorInstance()

        let review = app.buttons["scan.review"]
        XCTAssertTrue(review.waitForExistence(timeout: 3))
        review.tap()

        let screen = app.scrollViews["photo-review.screen"]
        XCTAssertTrue(screen.waitForExistence(timeout: 3))

        let hero = app.buttons["photo-review.hero"]
        let thumbnail = app.buttons["photo-review.thumbnail.1"]
        let addPhoto = app.buttons["photo-review.add"]
        let startListing = app.buttons["photo-review.start-listing"]
        XCTAssertTrue(hero.exists)
        XCTAssertTrue(thumbnail.exists)
        XCTAssertTrue(addPhoto.exists)
        XCTAssertTrue(startListing.exists)
        XCTAssertEqual(startListing.label, "Start listing")

        startListing.tap()

        let saved = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in
                startListing.exists && startListing.label == "Done"
            },
            object: startListing
        )
        XCTAssertEqual(
            XCTWaiter.wait(for: [saved], timeout: 3),
            .completed,
            "The real accepted host must render Done before exact clear."
        )

        XCTAssertTrue(screen.exists)
        XCTAssertTrue(startListing.isEnabled)
        XCTAssertTrue(hero.exists)
        XCTAssertTrue(thumbnail.exists)
        XCTAssertTrue(addPhoto.exists)
        XCTAssertFalse(addPhoto.isEnabled)
        XCTAssertFalse(app.buttons["scan.library"].exists)
        XCTAssertFalse(app.buttons["scan.choose-library"].exists)

        startListing.tap()
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName(
                rawValue: acknowledgmentNotification as CFString
            ),
            nil,
            nil,
            true
        )

        let liveLibrary = app.buttons["scan.library"]
        let recoveryLibrary = app.buttons["scan.choose-library"]
        let readyScan = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in
                liveLibrary.exists || recoveryLibrary.exists
            },
            object: nil
        )
        XCTAssertEqual(
            XCTWaiter.wait(for: [readyScan], timeout: 5),
            .completed,
            "Matching acknowledgment must finish exact clear and return to ready Scan."
        )

        XCTAssertFalse(screen.exists)
        XCTAssertFalse(startListing.exists)
        XCTAssertFalse(hero.exists)
        XCTAssertFalse(thumbnail.exists)
        XCTAssertFalse(addPhoto.exists)
        XCTAssertFalse(app.buttons["scan.review"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["scan.photo-1"].exists)

        // Which ready Scan surface mounts decides whether a dock exists at all.
        // Issue #805 made the live camera preview full-bleed: the dock is absent
        // from the hierarchy there (`if isVisible` in FloatingDock.swift), and
        // `scan.close` is the approved way back out of capture. Recovery
        // surfaces are not the live preview, so they still carry the dock.
        // This assertion previously demanded a selected `dock.scan` on both,
        // which the live preview can no longer satisfy.
        if liveLibrary.exists {
            XCTAssertEqual(liveLibrary.label, "Library")
            XCTAssertTrue(liveLibrary.isEnabled)
            XCTAssertTrue(app.buttons["scan.close"].exists)
            XCTAssertFalse(app.buttons["dock.scan"].exists)
            XCTAssertFalse(app.buttons["dock.trophy-wall"].exists)
        } else {
            XCTAssertEqual(recoveryLibrary.label, "Choose from library")
            XCTAssertTrue(recoveryLibrary.isEnabled)
            XCTAssertTrue(app.buttons["dock.scan"].isSelected)
            XCTAssertFalse(app.buttons["dock.trophy-wall"].isSelected)
        }

        XCTAssertFalse(app.staticTexts["Listing Review"].exists)
        XCTAssertFalse(app.buttons["Cancel"].exists)
        // Announcement delivery remains the direct B1 effect-consumer contract.
        // Accessibility focus remains the direct B2 mounted-Library contract.
    }

    // v1.2 primary_action.position is a sticky bottom action above the home-indicator
    // safe area. At Accessibility 5, the approved content may either fit this simulator
    // viewport or overflow it, but the action remains outside the ScrollView and never
    // covers Voice note or the home indicator in either layout.
    func testLivePhotoReviewKeepsStartListingSeparateFromAdaptiveReviewContent() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--restored-capture-fixture",
            "--dynamic-type=accessibility5"
        ]
        app.launchAfterRetiringPriorInstance()

        let review = app.buttons["scan.review"]
        XCTAssertTrue(review.waitForExistence(timeout: 5))
        review.tap()

        let screen = app.scrollViews["photo-review.screen"]
        XCTAssertTrue(screen.waitForExistence(timeout: 5))

        let startListing = app.buttons["photo-review.start-listing"]
        XCTAssertTrue(startListing.waitForExistence(timeout: 3))

        // Structural truth: Start listing is pinned outside the scrolling content while
        // Voice note stays in flow above it.
        XCTAssertFalse(
            screen.buttons["photo-review.start-listing"].exists,
            "Start listing must be a sticky action, not part of the scrolling content."
        )
        XCTAssertTrue(
            screen.buttons["photo-review.voice"].exists,
            "Voice note stays in flow; only Start listing is sticky."
        )

        // Behavioural truth: a swipe cannot move the sticky action. If content overflows,
        // Voice note moves beneath it; otherwise Voice note remains clear of the action.
        let voiceBefore = screen.buttons["photo-review.voice"].frame
        let stickyBefore = startListing.frame
        screen.swipeUp()

        let voiceAfter = screen.buttons["photo-review.voice"].frame
        XCTAssertEqual(
            startListing.frame.minY,
            stickyBefore.minY,
            accuracy: 0.5,
            "Start listing must stay pinned across adaptive content movement."
        )
        if abs(voiceAfter.minY - voiceBefore.minY) > 0.5 {
            XCTAssertLessThan(voiceAfter.minY, voiceBefore.minY)
        } else {
            XCTAssertLessThanOrEqual(
                voiceAfter.maxY,
                startListing.frame.minY,
                "When the approved content fits, Voice note must not overlap Start listing."
            )
        }

        let window = app.windows.firstMatch
        XCTAssertEqual(window.frame.width, 402, accuracy: 1)
        XCTAssertEqual(window.frame.height, 874, accuracy: 1)
        let homeIndicatorSafeAreaHeight: CGFloat = 34
        let safeAreaTolerance: CGFloat = 1
        XCTAssertLessThanOrEqual(
            startListing.frame.maxY,
            window.frame.maxY
                - homeIndicatorSafeAreaHeight
                + safeAreaTolerance,
            "Start listing must clear the exact-device home-indicator safe area."
        )
        XCTAssertGreaterThanOrEqual(startListing.frame.height, 44)
    }

    func testLivePhotoReviewDeletingTheOnlyPhotoReturnsToGuidedScanWithNoPhotos() {
        let app = XCUIApplication()
        app.launchArguments = ["--restored-capture-fixture"]
        app.launchAfterRetiringPriorInstance()

        let review = app.buttons["scan.review"]
        XCTAssertTrue(review.waitForExistence(timeout: 3))
        review.tap()

        let screen = app.scrollViews["photo-review.screen"]
        XCTAssertTrue(screen.waitForExistence(timeout: 3))
        XCTAssertEqual(app.staticTexts["photo-review.count"].label, "1 of 5")

        let delete = app.buttons["photo-review.delete"]
        XCTAssertFalse(
            delete.exists,
            "Delete stays hidden until the seller opens actions on a photo."
        )
        app.buttons["photo-review.hero"].tap()
        XCTAssertTrue(delete.waitForExistence(timeout: 2))
        delete.tap()

        XCTAssertTrue(
            app.buttons["scan.shutter"].waitForExistence(timeout: 3),
            "Deleting the only photo must return the approved zero-photo guided Scan."
        )
        XCTAssertFalse(
            app.buttons["button.primary.start-with-one-item"].exists,
            "Emptying the intake must not restart onboarding behind the camera."
        )
        XCTAssertFalse(screen.waitForExistence(timeout: 2))
        XCTAssertFalse(
            app.buttons["scan.review"].exists,
            "Zero-photo Scan has nothing to review."
        )
        XCTAssertFalse(
            app.descendants(matching: .any)["scan.photo-1"].exists,
            "The deleted photo must leave the Scan intake, not only Photo Review."
        )
        addScreenshot(named: "ZERO-402x874.png")
    }

    // v1.2 top_bar sets `minimum_target_points: [44, 44]` and its Dynamic Type rule
    // expects this row to grow rather than clip, so the floor has to hold at the
    // smallest supported size, where a target derived from text height is thinnest,
    // as well as at the largest, where the row reflows.
    func testLivePhotoReviewTopBarHoldsTheTouchFloorAcrossDynamicType() {
        for typeSize in ["xSmall", "medium", "accessibility3"] {
            let app = XCUIApplication()
            app.launchArguments = [
                "--restored-capture-fixture",
                "--dynamic-type=\(typeSize)"
            ]
            app.launchAfterRetiringPriorInstance()

            let review = app.buttons["scan.review"]
            XCTAssertTrue(review.waitForExistence(timeout: 5), typeSize)
            review.tap()

            let screen = app.scrollViews["photo-review.screen"]
            XCTAssertTrue(screen.waitForExistence(timeout: 5), typeSize)

            for control in [
                app.buttons["photo-review.back"],
                app.buttons["photo-review.voice"],
                app.buttons["photo-review.start-listing"]
            ] {
                XCTAssertTrue(control.waitForExistence(timeout: 3), typeSize)
                XCTAssertGreaterThanOrEqual(
                    control.frame.width,
                    44,
                    "\(control.identifier) width at \(typeSize)"
                )
                XCTAssertGreaterThanOrEqual(
                    control.frame.height,
                    44,
                    "\(control.identifier) height at \(typeSize)"
                )
            }

            // The approved order survives the reflow, and the row never overlaps the
            // hero it sits above.
            let back = app.buttons["photo-review.back"].frame
            let count = app.staticTexts["photo-review.count"].frame
            let hero = app.buttons["photo-review.hero"].frame
            XCTAssertEqual(
                app.buttons["photo-review.back"].label,
                "Back to camera"
            )
            XCTAssertFalse(
                app.staticTexts["Back to camera"].exists,
                "The approved header renders a chevron-only Back control."
            )
            if typeSize != "accessibility3" {
                XCTAssertEqual(
                    app.staticTexts["Review photos"].frame.midX,
                    app.windows.firstMatch.frame.midX,
                    accuracy: 1,
                    "The baseline title stays centered at \(typeSize)."
                )
            }
            XCTAssertLessThanOrEqual(back.maxX, count.minX, "order at \(typeSize)")
            XCTAssertLessThanOrEqual(
                count.maxY,
                hero.maxY,
                "top bar must stay above the hero at \(typeSize)"
            )

            UIProcessTerminationBoundary()
                .assertRetired(app, "SnapList after \(typeSize)")
        }
    }

    /// CAP-01 previewed the now-deleted `CaptureLauncherSheet` (#864). It stays
    /// in `ApprovedVisualStateID` for manifest safety but its route now falls
    /// through to `VisualStateBoundaryPlaceholder`, same as any other retired
    /// design-catalog state (HOME-03/HOME-04 precedent), so it is no longer
    /// exercised here.
    func testCaptureVisualStatesExposeTheApprovedNonCandidateBoundary() {
        let expectedTextByState = [
            ("CAP-02a", "Start with one clear photo."),
            ("CAP-02b1", "Move closer"),
            ("CAP-02b2", "Whole item is in frame"),
            ("CAP-02c", "1 of 4 photos"),
            ("CAP-03-handoff", "Photos ready to review")
        ]

        for (state, text) in expectedTextByState {
            let app = launch(extraArguments: ["--visual-state=\(state)"])
            XCTAssertTrue(
                app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", text))
                    .firstMatch.waitForExistence(timeout: 2),
                "Missing approved content for \(state)"
            )
            XCTAssertFalse(app.staticTexts["Review photos"].exists)
            app.terminate()
        }
    }

    func testApprovedScanCameraZeroAndFivePhotoStatesExposeTheFrozenControls() {
        let zero = launch(extraArguments: ["--visual-state=CAM-01"])

        for identifier in ["scan.flash", "scan.library", "scan.shutter"] {
            XCTAssertTrue(zero.buttons[identifier].waitForExistence(timeout: 2), identifier)
        }
        // #885: the owner removed the dock from the camera preview, since
        // `scan.close` already returns the seller where they came from. The
        // real shell has always hidden it here; this route now matches.
        XCTAssertFalse(zero.buttons["dock.scan"].exists)
        XCTAssertFalse(zero.buttons["dock.trophy-wall"].exists)
        XCTAssertFalse(zero.buttons["scan.review"].exists)
        XCTAssertFalse(zero.descendants(matching: .any)["scan.photo-1"].exists)
        XCTAssertTrue(zero.buttons["scan.shutter"].isEnabled)
        XCTAssertEqual(zero.buttons["scan.shutter"].label, "Take photo")
        zero.terminate()

        let capped = launch(extraArguments: ["--visual-state=CAM-04"])
        XCTAssertTrue(
            capped.descendants(matching: .any)["scan.photo-5"].waitForExistence(timeout: 2)
        )
        XCTAssertTrue(capped.buttons["scan.review"].exists)
        // #954 deleted the "5 of 5" capsule, which was the only text saying the
        // seller had reached the cap. The shutter carries that now: it is
        // actually disabled, and its accessibility label says why rather than
        // letting a tap do nothing silently.
        XCTAssertEqual(
            capped.buttons["scan.shutter"].label,
            "Take photo, unavailable at five photo limit"
        )
        XCTAssertFalse(capped.buttons["scan.shutter"].isEnabled)
        XCTAssertFalse(capped.buttons["scan.library"].isEnabled)
        XCTAssertEqual(capped.buttons["scan.library"].label, "Library")
    }

    /// #885. The reference arranges the bottom row as flash, shutter, library,
    /// and leaves the top row holding nothing but the close control.
    ///
    /// Review used to own the bottom-right slot the library now takes. It does
    /// not disappear: it moves up beside the staged-photo strip it acts on,
    /// which is the row directly above and still inside thumb reach.
    func testIssue885ScanBottomRowIsFlashShutterLibraryWithReviewMovedAboveIt() {
        let app = launch(extraArguments: ["--visual-state=CAM-03"])
        let close = app.buttons["scan.close"]
        let flash = app.buttons["scan.flash"]
        let shutter = app.buttons["scan.shutter"]
        let library = app.buttons["scan.library"]
        let review = app.buttons["scan.review"]

        for control in [close, flash, shutter, library, review] {
            XCTAssertTrue(control.waitForExistence(timeout: 3), control.identifier)
        }

        let receipt = "close=\(close.frame) flash=\(flash.frame) " +
            "shutter=\(shutter.frame) library=\(library.frame) review=\(review.frame)"

        XCTAssertLessThan(flash.frame.midX, shutter.frame.midX, receipt)
        XCTAssertLessThan(shutter.frame.midX, library.frame.midX, receipt)
        XCTAssertEqual(flash.frame.midY, shutter.frame.midY, accuracy: 24, receipt)
        XCTAssertEqual(library.frame.midY, shutter.frame.midY, accuracy: 24, receipt)

        XCTAssertLessThan(review.frame.maxY, shutter.frame.minY, receipt)
        XCTAssertGreaterThan(flash.frame.minY, close.frame.maxY, receipt)

        for control in [flash, shutter, library] {
            XCTAssertFalse(control.frame.intersects(review.frame), receipt)
        }
    }

    /// #885. Zoom is offered only when the back camera actually pairs an ultra
    /// wide with a wide lens. The simulator has no camera at all, so its honest
    /// result is no control rather than a `.5x` the hardware would refuse.
    /// `--scan-zoom=dual-wide` stands in for a device that does have one.
    func testIssue885ZoomControlIsNotOfferedWithoutAnUltraWideCamera() {
        let withoutUltraWide = launch(extraArguments: ["--visual-state=CAM-01"])
        XCTAssertTrue(withoutUltraWide.buttons["scan.shutter"].waitForExistence(timeout: 3))
        XCTAssertFalse(withoutUltraWide.otherElements["scan.zoom"].exists)
        XCTAssertFalse(withoutUltraWide.buttons["scan.zoom.ultra-wide"].exists)
        XCTAssertFalse(withoutUltraWide.buttons["scan.zoom.wide"].exists)
    }

    /// The other half of the gate, kept in its own test so each launch belongs
    /// to one test rather than the second one being a relaunch inside the first.
    ///
    /// `1x` stays the default. The reference screenshot happens to show `.5x`
    /// selected, but that is the state its user left it in, and defaulting to
    /// the ultra wide would silently rewiden every seller's framing.
    func testIssue885ZoomControlSwitchesToTheUltraWideWhenTheHardwareHasOne() {
        // Park activation guidance on another surface. Left to whatever the
        // preceding tests persisted, the ACT-01 coach mark docks over this band
        // and takes the chip's taps, which is a real collision this issue found
        // and did not fix. Pinning the state keeps this test measuring the zoom
        // control rather than that overlap.
        let app = launch(
            extraArguments: [
                "--visual-state=CAM-01",
                "--scan-zoom=dual-wide",
                "--activation-guidance-step=listingReview",
            ]
        )
        let zoom = app.otherElements["scan.zoom"]
        let ultraWide = app.buttons["scan.zoom.ultra-wide"]
        let wide = app.buttons["scan.zoom.wide"]
        let shutter = app.buttons["scan.shutter"]

        for element in [zoom, ultraWide, wide, shutter] {
            XCTAssertTrue(element.waitForExistence(timeout: 3), element.identifier)
        }

        XCTAssertEqual(ultraWide.label, "0.5x zoom")
        XCTAssertEqual(wide.label, "1x zoom")
        XCTAssertEqual(zoom.value as? String, "1x")
        XCTAssertTrue(wide.isSelected)
        XCTAssertFalse(ultraWide.isSelected)

        let receipt = "zoom=\(zoom.frame) shutter=\(shutter.frame)"
        XCTAssertLessThan(zoom.frame.maxY, shutter.frame.minY, receipt)
        XCTAssertEqual(zoom.frame.midX, shutter.frame.midX, accuracy: 2, receipt)

        // Existence is not reachability, and a tap on an element with no hit
        // point is dropped without error, so it would surface below as the
        // wrong selected lens rather than as the unreachable control it is.
        // Keeping the wait means anything that covers this band in future
        // fails here, by name, instead of somewhere further down.
        let reachable = expectation(
            for: NSPredicate(format: "isHittable == true"),
            evaluatedWith: ultraWide
        )
        XCTAssertEqual(
            XCTWaiter().wait(for: [reachable], timeout: 5),
            .completed,
            "The 0.5x chip must become hittable before it is tapped."
        )

        ultraWide.tap()
        // Frames and hittability, because the way this assertion fails in
        // practice is a tap that never lands rather than a lens that switched
        // to the wrong value.
        let switchReceipt = """
        ultraWide=\(ultraWide.frame) hittable=\(ultraWide.isHittable) \
        wide=\(wide.frame) zoomContainer=\(zoom.frame) appState=\(app.state.rawValue)
        """
        XCTAssertTrue(ultraWide.isSelected, switchReceipt)
        XCTAssertFalse(wide.isSelected, switchReceipt)
        XCTAssertEqual(zoom.value as? String, "0.5x", switchReceipt)
    }

    /// #914. #885 added a zoom row above the shutter row on hardware with an
    /// ultra wide, and the ACT-01 coach mark's approved 112pt inset never
    /// accounted for it, so the bubble docked over the row and took its taps.
    /// `isHittable` has lied on this codebase before, so this asserts the two
    /// frames directly: a bubble that merely abuts the chips without covering
    /// them is fine, one that overlaps them by even a point is the defect.
    ///
    /// `--activation-onboarded-fixture` is what actually makes ACT-01
    /// eligible to bootstrap under a `--visual-state` launch: it plants
    /// onboarding on `.captureBoundary`, the one screen
    /// `FirstValueActivationEligibilityPolicy` treats as already onboarded
    /// regardless of shell routing. Without it the coach mark never
    /// bootstraps on CAM-01, so this cannot reduce to `isHittable` alone.
    func testIssue914ActivationGuidanceBubbleDoesNotCoverTheZoomChips() {
        let app = launch(extraArguments: [
            "--visual-state=CAM-01",
            "--scan-zoom=dual-wide",
            "--activation-onboarded-fixture",
            "--reset-activation-guidance",
        ])

        let guidance = activationGuidance(in: app)
        let ultraWide = app.buttons["scan.zoom.ultra-wide"]
        let wide = app.buttons["scan.zoom.wide"]

        XCTAssertTrue(guidance.waitForExistence(timeout: 3), app.debugDescription)
        for chip in [ultraWide, wide] {
            XCTAssertTrue(chip.waitForExistence(timeout: 3), chip.identifier)
        }

        let receipt = "guidance=\(guidance.frame) ultraWide=\(ultraWide.frame) wide=\(wide.frame)"
        XCTAssertFalse(guidance.frame.intersects(ultraWide.frame), receipt)
        XCTAssertFalse(guidance.frame.intersects(wide.frame), receipt)

        let reachable = expectation(
            for: NSPredicate(format: "isHittable == true"),
            evaluatedWith: ultraWide
        )
        XCTAssertEqual(
            XCTWaiter().wait(for: [reachable], timeout: 5),
            .completed,
            "The 0.5x chip must be hittable while ACT-01 is presented. \(receipt)"
        )
    }

    /// #885. Moving three controls onto one row and adding a fourth above it is
    /// exactly the change that breaks touch targets at large text, so every
    /// control the issue touches is measured at AX5 rather than at the default
    /// size: on screen, at least 44pt on both axes, and not overlapping anything
    /// a seller could be aiming at instead.
    ///
    /// CAM-04 stages photos, so the review row and the thumbnail strip are both
    /// present and competing for the same vertical space.
    ///
    /// Activation guidance is parked on another surface on purpose. Left where
    /// the preceding tests put it, the ACT-01 coach mark docks over this band
    /// and takes the zoom control's taps, which is a real defect this issue
    /// found and did not fix. Pinning it means this test measures reach at AX5,
    /// which #885 owns, rather than that overlap, which belongs to #914. So
    /// this test cannot fail for #914 by construction, and that gap is recorded
    /// in #916.
    func testIssue885EveryMovedScanControlKeepsA44ptTargetAtAX5() {
        let app = launch(extraArguments: [
            "--visual-state=CAM-04",
            "--scan-zoom=dual-wide",
            "--dynamic-type=accessibility5",
            "--activation-guidance-step=listingReview"
        ])
        let window = app.windows.firstMatch
        let flash = app.buttons["scan.flash"]
        let shutter = app.buttons["scan.shutter"]
        let library = app.buttons["scan.library"]
        let review = app.buttons["scan.review"]
        let ultraWide = app.buttons["scan.zoom.ultra-wide"]
        let wide = app.buttons["scan.zoom.wide"]
        let controls = [flash, shutter, library, review, ultraWide, wide]

        XCTAssertTrue(window.waitForExistence(timeout: 3), app.debugDescription)
        for control in controls {
            XCTAssertTrue(control.waitForExistence(timeout: 3), control.identifier)
        }

        let receipt = controls
            .map { "\($0.identifier)=\($0.frame)" }
            .joined(separator: " ") + " window=\(window.frame)"

        for control in controls {
            // A 44pt frame a seller cannot land a finger on is not a 44pt
            // target, and XCUITest drops a tap on an unhittable element without
            // erroring, so measuring only the rectangle would pass either way.
            XCTAssertTrue(control.isHittable, "\(control.identifier) \(receipt)")
            XCTAssertGreaterThanOrEqual(control.frame.width, 44, receipt)
            XCTAssertGreaterThanOrEqual(control.frame.height, 44, receipt)
            XCTAssertGreaterThanOrEqual(control.frame.minX, window.frame.minX, receipt)
            XCTAssertLessThanOrEqual(control.frame.maxX, window.frame.maxX, receipt)
            XCTAssertGreaterThanOrEqual(control.frame.minY, window.frame.minY, receipt)
            XCTAssertLessThanOrEqual(control.frame.maxY, window.frame.maxY, receipt)
        }

        for (index, control) in controls.enumerated() {
            for other in controls.dropFirst(index + 1) {
                XCTAssertFalse(control.frame.intersects(other.frame), receipt)
            }
        }
    }

    /// #954. The bottom control area is three compact rows with photos staged:
    /// the zoom capsule, then the thumbnail strip with Review beside it, then
    /// flash, shutter and library.
    ///
    /// On the parent commit it was four — the strip carrying a "N of 5" capsule,
    /// Review alone, the zoom capsule alone, then the shutter row — and at
    /// accessibility3 the capsule wrapped into a three-line stack that ran into
    /// the framing bracket above it. The owner specified the arrangement: the
    /// count capsule is deleted, and the zoom capsule keeps a line of its own
    /// directly above the strip, anchored near the shutter it changes.
    ///
    /// A row is derived from the rendered frames rather than declared, so this
    /// cannot be satisfied by renesting the same bands: the bottom controls are
    /// sorted by `minY` and grouped by overlapping vertical extent. Giving
    /// Review a line of its own back, or reintroducing the count, produces a
    /// fourth band whatever the view tree looks like.
    ///
    /// Accessibility sizes are allowed the honest degradation the owner named:
    /// Review may wrap beneath the strip, because five thumbnails hold 265pt of
    /// the 372pt gutter at every text size and Review's name does not stop
    /// growing. Overlap and clipping are failures at every size; only the row
    /// count relaxes, and only there.
    ///
    /// Activation guidance is parked on another surface for the same reason
    /// `testIssue885EveryMovedScanControlKeepsA44ptTargetAtAX5` parks it: the
    /// ACT-01 coach mark docks over this band, and letting it fail here would
    /// be failing for #914 rather than for this contract.
    func testIssue954StagedScanControlsFitTwoRowsAtEveryDynamicTypeSize() {
        for typeSize in ["xSmall", "medium", "accessibility3", "accessibility5"] {
            let isAccessibility = typeSize.hasPrefix("accessibility")
            let app = launch(extraArguments: [
                "--visual-state=CAM-04",
                "--scan-zoom=dual-wide",
                "--dynamic-type=\(typeSize)",
                "--activation-guidance-step=listingReview",
            ])
            let window = app.windows.firstMatch
            XCTAssertTrue(window.waitForExistence(timeout: 3), app.debugDescription)

            let firstPhoto = app.descendants(matching: .any)["scan.photo-1"]
            let lastPhoto = app.descendants(matching: .any)["scan.photo-5"]
            let zoom = app.descendants(matching: .any)["scan.zoom"]
            let review = app.buttons["scan.review"]
            let flash = app.buttons["scan.flash"]
            let shutter = app.buttons["scan.shutter"]
            let library = app.buttons["scan.library"]
            let bottom = [zoom, firstPhoto, lastPhoto, review, flash, shutter, library]

            for element in bottom {
                XCTAssertTrue(
                    element.waitForExistence(timeout: 3),
                    "\(element.identifier) is missing at \(typeSize). \(app.debugDescription)"
                )
            }

            let receipt = bottom
                .map { "\($0.identifier)=\($0.frame)" }
                .joined(separator: " ")
                + " window=\(window.frame) dynamicType=\(typeSize)"
            // The rectangles are this test's evidence, not a debugging aid:
            // #954 is a claim about where controls land, and the owner reads
            // the measured frames rather than a screenshot description.
            print("SCAN-954-GEOMETRY \(receipt)")

            // The capsule the owner deleted. Nothing may reintroduce it.
            XCTAssertFalse(
                app.staticTexts["scan.photo-count"].exists,
                "The photo count capsule is back. \(receipt)"
            )

            // The capsule sits on its own line above the strip and stays in the
            // bottom block, next to the shutter rather than up by the close
            // button.
            XCTAssertLessThanOrEqual(
                zoom.frame.maxY,
                firstPhoto.frame.minY,
                "The zoom capsule must sit above the staged strip. \(receipt)"
            )
            XCTAssertGreaterThan(
                zoom.frame.minY,
                window.frame.midY,
                "The zoom capsule must stay in the bottom control block. \(receipt)"
            )
            XCTAssertLessThanOrEqual(
                firstPhoto.frame.maxY,
                shutter.frame.minY,
                "The staged strip must sit above the shutter row. \(receipt)"
            )

            let rows = scanStagedRowCount(of: bottom)
            if isAccessibility {
                // Review wraps beneath the strip here, which is the degradation
                // the owner allowed. Four bands is the ceiling even so.
                XCTAssertLessThanOrEqual(
                    rows,
                    4,
                    "The bottom controls must not exceed four rows. \(receipt)"
                )
            } else {
                XCTAssertEqual(
                    rows,
                    3,
                    "The bottom controls must render in three rows. \(receipt)"
                )
            }

            for (index, element) in bottom.enumerated() {
                for other in bottom.dropFirst(index + 1) {
                    XCTAssertFalse(
                        element.frame.intersects(other.frame),
                        "\(element.identifier) overlaps \(other.identifier). \(receipt)"
                    )
                }

                // Clipping, not just overlap: an element pushed past the window
                // is still a legible frame in the hierarchy.
                XCTAssertGreaterThanOrEqual(element.frame.minX, window.frame.minX, receipt)
                XCTAssertLessThanOrEqual(element.frame.maxX, window.frame.maxX, receipt)
                XCTAssertGreaterThanOrEqual(element.frame.minY, window.frame.minY, receipt)
                XCTAssertLessThanOrEqual(element.frame.maxY, window.frame.maxY, receipt)
            }

            // The cap signal the deleted capsule used to carry. A tap that
            // silently does nothing would satisfy neither half of this.
            XCTAssertFalse(shutter.isEnabled, "The capped shutter must be disabled. \(receipt)")
            XCTAssertEqual(
                shutter.label,
                "Take photo, unavailable at five photo limit",
                "The capped shutter must say why it is unavailable. \(receipt)"
            )

            for control in [review, app.buttons["scan.zoom.ultra-wide"], app.buttons["scan.zoom.wide"]] {
                XCTAssertTrue(control.isHittable, "\(control.identifier) \(receipt)")
                XCTAssertGreaterThanOrEqual(control.frame.width, 44, receipt)
                XCTAssertGreaterThanOrEqual(control.frame.height, 44, receipt)
            }
        }
    }

    /// How many rows a set of on-screen elements actually renders as.
    ///
    /// Sorted by `minY`, an element joins the open band while it still overlaps
    /// that band's vertical extent and opens a new one once it clears it. Two
    /// controls side by side share a band however far apart they are
    /// horizontally; one on a line of its own always earns another.
    private func scanStagedRowCount(of elements: [XCUIElement]) -> Int {
        var rows = 0
        var openBandMaxY = -CGFloat.greatestFiniteMagnitude

        for frame in elements.map(\.frame).sorted(by: { $0.minY < $1.minY }) {
            if frame.minY >= openBandMaxY {
                rows += 1
                openBandMaxY = frame.maxY
            } else {
                openBandMaxY = max(openBandMaxY, frame.maxY)
            }
        }

        return rows
    }

    func testScanCameraCAM04MatchesLiveRenderedGeometryAt402x874() {
        let app = launch(extraArguments: ["--visual-state=CAM-04"])
        let window = app.windows.firstMatch
        let firstPhoto = app.descendants(matching: .any)["scan.photo-1"]
        let secondPhoto = app.descendants(matching: .any)["scan.photo-2"]
        let library = app.buttons["scan.library"]
        let shutter = app.buttons["scan.shutter"]
        let review = app.buttons["scan.review"]

        XCTAssertTrue(window.waitForExistence(timeout: 3))
        XCTAssertEqual(window.frame.size.width, 402, accuracy: 0.5)
        XCTAssertEqual(window.frame.size.height, 874, accuracy: 0.5)

        for element in [firstPhoto, secondPhoto, library, shutter, review] {
            XCTAssertTrue(element.waitForExistence(timeout: 3), element.identifier)
        }

        // #885: the preview no longer floats a dock, and the height that
        // freed went to the two things the owner named. The thumbnails are the
        // larger half of that spend.
        XCTAssertEqual(firstPhoto.frame.size.width, 45, accuracy: 0.5)
        XCTAssertEqual(firstPhoto.frame.size.height, 57, accuracy: 0.5)
        XCTAssertEqual(secondPhoto.frame.minX - firstPhoto.frame.maxX, 10, accuracy: 0.5)
        // #954 put review back beside the strip rather than on a line of its
        // own, so the two now share a band: each one's top sits above the
        // other's bottom, and they are separated horizontally instead.
        XCTAssertLessThan(review.frame.minY, firstPhoto.frame.maxY)
        XCTAssertLessThan(firstPhoto.frame.minY, review.frame.maxY)
        XCTAssertLessThanOrEqual(firstPhoto.frame.maxX, review.frame.minX)
        // The row that used to hold review alone is gone, so the shutter row
        // follows the strip directly. Pinning the gap keeps the reclaimed
        // height from quietly reappearing as padding.
        XCTAssertEqual(library.frame.minY - firstPhoto.frame.maxY, 28, accuracy: 2)
        // #885: no dock on the camera preview, so the shutter row is the last
        // thing above the home indicator rather than the second to last.
        XCTAssertFalse(app.buttons["dock.scan"].exists)
        XCTAssertFalse(app.buttons["dock.trophy-wall"].exists)
        // Absence of the dock buttons is not the same as the space they used to
        // occupy being gone, so pin the gap the shutter row now leaves below
        // itself. Asserting only that the shutter is above the window bottom
        // would hold for any layout, dock or no dock.
        XCTAssertEqual(
            window.frame.maxY - shutter.frame.maxY,
            66.5,
            accuracy: 2,
            "shutter=\(shutter.frame) window=\(window.frame)"
        )
    }

    func testIssue775RealAppShellRemovesDockFromLiveCameraPreviewAt402x874() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--restored-capture-fixture",
            "--voice-note-take-ready-fixture"
        ]
        app.launchAfterRetiringPriorInstance()

        let window = app.windows.firstMatch
        let firstPhoto = app.descendants(matching: .any)["scan.photo-1"]
        let closeButton = app.buttons["scan.close"]
        let library = app.buttons["scan.library"]
        let shutter = app.buttons["scan.shutter"]
        let review = app.buttons["scan.review"]
        let dockScan = app.buttons["dock.scan"]
        let dockTrophy = app.buttons["dock.trophy-wall"]

        XCTAssertTrue(window.waitForExistence(timeout: 3), app.debugDescription)
        XCTAssertEqual(window.frame.size.width, 402, accuracy: 0.5)
        XCTAssertEqual(window.frame.size.height, 874, accuracy: 0.5)

        for element in [
            firstPhoto,
            closeButton,
            library,
            shutter,
            review,
        ] {
            XCTAssertTrue(element.waitForExistence(timeout: 3), element.identifier)
        }

        // Live camera preview is full-bleed: the dock is not just visually
        // hidden, it is absent from the hierarchy (`if isVisible` in
        // FloatingDock.swift), so these must never appear on this route.
        XCTAssertFalse(dockScan.exists)
        XCTAssertFalse(dockTrophy.exists)

        for control in [closeButton, library, shutter, review] {
            XCTAssertGreaterThanOrEqual(control.frame.width, 44, control.identifier)
            XCTAssertGreaterThanOrEqual(control.frame.height, 44, control.identifier)
        }

        XCTAssertLessThanOrEqual(firstPhoto.frame.maxY, library.frame.minY)
        // #954 put Review beside the strip rather than under it, so the two
        // now share a band instead of stacking. What still has to hold is that
        // they do not run into each other.
        XCTAssertFalse(firstPhoto.frame.intersects(review.frame))
        XCTAssertLessThanOrEqual(firstPhoto.frame.maxX, review.frame.minX)

        // The dock's absence is scoped to the live preview, not a permanent
        // side effect of having visited Scan: leaving capture must bring it
        // back on Trophy Wall.
        closeButton.tap()
        XCTAssertTrue(dockTrophy.waitForExistence(timeout: 3))
        XCTAssertTrue(dockScan.exists)
        XCTAssertTrue(dockTrophy.isSelected)
    }

    /// #864: with `CaptureLauncherSheet` deleted, a relaunch that restores a
    /// staged photo lands directly on these live camera controls with nothing
    /// covering them. On the parent commit this same launch left
    /// `scan.close`/`scan.library`/`scan.shutter`/`scan.review` behind
    /// `sheet.capture` until "Resume" was tapped, so this waitForExistence at
    /// the largest accessibility Dynamic Type size would time out there; here
    /// it also proves none of the reflowed controls clip past the window or
    /// overlap one another, mirroring the default-size clipping proof in
    /// `testIssue775RealAppShellRemovesDockFromLiveCameraPreviewAt402x874`.
    func testRestoredCaptureCameraControlsStayOnscreenAtLargestAccessibilitySize() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--restored-capture-fixture",
            "--dynamic-type=accessibility5"
        ]
        app.launchAfterRetiringPriorInstance()

        let window = app.windows.firstMatch
        let closeButton = app.buttons["scan.close"]
        let flash = app.buttons["scan.flash"]
        let library = app.buttons["scan.library"]
        let shutter = app.buttons["scan.shutter"]
        let review = app.buttons["scan.review"]

        XCTAssertTrue(window.waitForExistence(timeout: 3), app.debugDescription)
        for control in [closeButton, flash, library, shutter, review] {
            XCTAssertTrue(control.waitForExistence(timeout: 3), control.identifier)
        }

        let frameReceipt = "window=\(window.frame), close=\(closeButton.frame), " +
            "flash=\(flash.frame), library=\(library.frame), " +
            "shutter=\(shutter.frame), review=\(review.frame)"
        for control in [closeButton, flash, library, shutter, review] {
            XCTAssertGreaterThanOrEqual(control.frame.minX, window.frame.minX, frameReceipt)
            XCTAssertLessThanOrEqual(control.frame.maxX, window.frame.maxX, frameReceipt)
            XCTAssertGreaterThanOrEqual(control.frame.minY, window.frame.minY, frameReceipt)
            XCTAssertLessThanOrEqual(control.frame.maxY, window.frame.maxY, frameReceipt)
        }

        // #885 put flash on this row, so it joins the pairs that must stay apart.
        let bottomStack = [flash, shutter, library, review]
        for (index, control) in bottomStack.enumerated() {
            for other in bottomStack.dropFirst(index + 1) {
                XCTAssertFalse(control.frame.intersects(other.frame), frameReceipt)
            }
        }
    }

    /// Issue #842: each camera-screen thumbnail carries a remove affordance. Removing
    /// one photo must update the strip, the count, and the durable draft, keep the
    /// surviving photo, and removing the last remaining photo must leave the capture
    /// surface in its zero-photo state rather than navigating away from it.
    func testIssue842RemovingAStagedPhotoOnTheCameraScreenKeepsTheSurvivingPhotoAndReachesZeroState() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--restored-capture-fixture",
            "--fixture-staged-library-photos=2"
        ]
        app.launchAfterRetiringPriorInstance()

        let firstPhoto = app.descendants(matching: .any)["scan.photo-1"]
        let secondPhoto = app.descendants(matching: .any)["scan.photo-2"]
        let review = app.buttons["scan.review"]
        let shutter = app.buttons["scan.shutter"]
        let removeSecond = app.buttons["scan.photo-2.remove"]

        XCTAssertTrue(firstPhoto.waitForExistence(timeout: 3), app.debugDescription)
        XCTAssertTrue(secondPhoto.waitForExistence(timeout: 3), app.debugDescription)
        // #954 deleted the "N of 5" capsule; Review's own name is the surviving
        // count-bearing text on this surface.
        XCTAssertEqual(review.label, "Review 2 photos")
        XCTAssertTrue(removeSecond.waitForExistence(timeout: 3), app.debugDescription)
        XCTAssertEqual(removeSecond.label, "Remove photo 2")
        XCTAssertGreaterThanOrEqual(removeSecond.frame.width, 44)
        XCTAssertGreaterThanOrEqual(removeSecond.frame.height, 44)

        removeSecond.tap()

        let oneRemaining = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label == %@", "Review 1 photo"),
            object: review
        )
        XCTAssertEqual(
            XCTWaiter.wait(for: [oneRemaining], timeout: 3),
            .completed,
            "Removing photo 2 must leave one photo in the durable draft."
        )
        XCTAssertTrue(firstPhoto.exists, "The surviving photo must be the one that was kept.")
        XCTAssertFalse(secondPhoto.exists)
        XCTAssertFalse(app.buttons["scan.photo-2.remove"].exists)

        let removeFirst = app.buttons["scan.photo-1.remove"]
        XCTAssertTrue(removeFirst.waitForExistence(timeout: 3), app.debugDescription)
        removeFirst.tap()

        let zeroPhotos = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"),
            object: firstPhoto
        )
        XCTAssertEqual(
            XCTWaiter.wait(for: [zeroPhotos], timeout: 3),
            .completed,
            "Removing the last photo must clear the strip."
        )
        XCTAssertFalse(app.buttons["scan.review"].exists)
        XCTAssertTrue(
            shutter.waitForExistence(timeout: 3),
            "The capture surface must remain, ready for another photo."
        )
    }

    /// Issue #842 AC#5: the remove control's touch target must stay at least 44x44
    /// points at the largest Dynamic Type size, not just the default.
    func testIssue842RemovePhotoTouchTargetStaysAtLeast44PointsAtAccessibility5() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--restored-capture-fixture",
            "--fixture-staged-library-photos=2",
            "--dynamic-type=accessibility5"
        ]
        app.launchAfterRetiringPriorInstance()

        let removeSecond = app.buttons["scan.photo-2.remove"]
        XCTAssertTrue(removeSecond.waitForExistence(timeout: 3), app.debugDescription)
        XCTAssertGreaterThanOrEqual(removeSecond.frame.width, 44)
        XCTAssertGreaterThanOrEqual(removeSecond.frame.height, 44)
    }

    func testApprovedScanCameraFixtureStatesThatItIsNotALiveCameraFeed() {
        let app = launch(extraArguments: ["--visual-state=CAM-01", "--reduced-motion"])
        let fixturePreview = app.otherElements["scan.fixture-preview"]

        XCTAssertTrue(fixturePreview.waitForExistence(timeout: 2))
        XCTAssertEqual(
            fixturePreview.label,
            "Simulator camera fixture. No live camera feed."
        )
    }

    func testApprovedScanCameraRecoveryStatesUseExactCopyAndHonestActions() {
        let unavailable = launch(extraArguments: ["--visual-state=CAM-V1"])
        XCTAssertTrue(unavailable.staticTexts["Camera is not available"].waitForExistence(timeout: 2))
        XCTAssertTrue(unavailable.staticTexts["Add photos from your library instead."].exists)
        XCTAssertTrue(unavailable.buttons["scan.choose-library"].exists)
        XCTAssertFalse(unavailable.buttons["scan.open-settings"].exists)
        XCTAssertFalse(unavailable.buttons["scan.flash"].exists)
        XCTAssertTrue(unavailable.buttons["dock.scan"].exists)
        XCTAssertTrue(unavailable.buttons["dock.trophy-wall"].exists)
        unavailable.terminate()

        let denied = launch(extraArguments: ["--visual-state=CAM-V2"])
        XCTAssertTrue(denied.staticTexts["SnapList cannot use the camera"].waitForExistence(timeout: 2))
        XCTAssertTrue(
            denied.staticTexts[
                "Allow camera access in Settings, or add photos from your library."
            ].exists
        )
        XCTAssertTrue(denied.buttons["scan.choose-library"].exists)
        XCTAssertTrue(denied.buttons["scan.open-settings"].exists)
        XCTAssertFalse(denied.buttons["scan.flash"].exists)
    }

    func testScanLibraryUsesExactLiveAndRecoveryLabels() {
        let live = launch(extraArguments: ["--visual-state=CAM-01"])
        let liveLibrary = live.buttons["scan.library"]

        XCTAssertTrue(liveLibrary.waitForExistence(timeout: 2))
        XCTAssertEqual(liveLibrary.label, "Library")
        live.terminate()

        let recovery = launch(extraArguments: ["--visual-state=CAM-V1"])
        let recoveryLibrary = recovery.buttons["scan.choose-library"]

        XCTAssertTrue(recoveryLibrary.waitForExistence(timeout: 2))
        XCTAssertEqual(recoveryLibrary.label, "Choose from library")
    }

    func testPhotoReviewREV02UsesTallerThreeEightyPointHeroAt402x874() {
        let app = launch(extraArguments: ["--photo-review-state=REV-02"])
        let window = app.windows.firstMatch
        let hero = app.buttons["photo-review.hero"]

        XCTAssertTrue(window.waitForExistence(timeout: 3))
        XCTAssertEqual(window.frame.size.width, 402, accuracy: 0.5)
        XCTAssertEqual(window.frame.size.height, 874, accuracy: 0.5)
        XCTAssertTrue(hero.waitForExistence(timeout: 3))
        XCTAssertEqual(
            hero.frame.height,
            380,
            accuracy: 1,
            "#858: Photo Review v5's hero grew from 300 to 380 points."
        )
    }

    // #883: the swipe is the seller's own path between photos, and the chevrons
    // that used to prove this wiring are gone. REV-03 stages five photos so a
    // move in either direction is available mid-strip. This is the one seam that
    // proves the gesture reaches the store and that the thumbnail strip stays in
    // sync, which cannot be proved below the UI layer.
    func testPhotoReviewHeroSwipeMovesSelectionOnePhotoAtATimeAndStopsAtTheEnds() {
        let app = launch(extraArguments: ["--photo-review-state=REV-03"])
        let hero = app.buttons["photo-review.hero"]
        let firstThumbnail = app.buttons["photo-review.thumbnail.1"]
        let secondThumbnail = app.buttons["photo-review.thumbnail.2"]
        let thirdThumbnail = app.buttons["photo-review.thumbnail.3"]

        XCTAssertTrue(hero.waitForExistence(timeout: 3))
        XCTAssertFalse(
            app.buttons["photo-review.hero.next"].exists,
            "#883 retired the hero chevrons; the swipe is the visible path."
        )
        XCTAssertFalse(app.buttons["photo-review.hero.previous"].exists)
        XCTAssertTrue(firstThumbnail.isSelected)

        dragHorizontally(hero, towardsLeading: false)

        XCTAssertTrue(
            firstThumbnail.isSelected,
            "The first photo has nothing before it."
        )
        XCTAssertTrue(hero.label.hasPrefix("Photo 1 of 5"))

        dragHorizontally(hero, towardsLeading: true)

        waitFor(
            secondThumbnail,
            toSatisfy: "isSelected == true",
            "A leading drag moves selection forward one photo."
        )
        XCTAssertFalse(firstThumbnail.isSelected)
        XCTAssertTrue(hero.label.hasPrefix("Photo 2 of 5"))

        dragHorizontally(hero, towardsLeading: true)

        waitFor(
            thirdThumbnail,
            toSatisfy: "isSelected == true",
            "One drag moves one photo, not several."
        )
        XCTAssertFalse(secondThumbnail.isSelected)
        XCTAssertTrue(hero.label.hasPrefix("Photo 3 of 5"))

        dragHorizontally(hero, towardsLeading: false)

        waitFor(
            secondThumbnail,
            toSatisfy: "isSelected == true",
            "A trailing drag moves selection back one photo."
        )
        XCTAssertFalse(thirdThumbnail.isSelected)
        XCTAssertTrue(hero.label.hasPrefix("Photo 2 of 5"))
    }

    // #883: the indicator is what tells the seller where they are once the
    // chevrons are gone, and its label is what tells VoiceOver the same thing
    // without reading the dots. It has to answer to both ways of moving.
    func testPhotoReviewHeroPageIndicatorTracksTheSelectedPhotoOnSwipeAndOnThumbnailTap() {
        let app = launch(extraArguments: ["--photo-review-state=REV-03"])
        let hero = app.buttons["photo-review.hero"]
        let indicator = app.otherElements["photo-review.hero.page-indicator"]

        XCTAssertTrue(hero.waitForExistence(timeout: 3))
        XCTAssertTrue(indicator.waitForExistence(timeout: 3))
        XCTAssertEqual(indicator.label, "Photo 1 of 5")
        XCTAssertTrue(
            hero.frame.contains(indicator.frame),
            "The indicator sits on the photo: indicator=\(indicator.frame) hero=\(hero.frame)"
        )
        XCTAssertEqual(
            indicator.frame.midX,
            hero.frame.midX,
            accuracy: 1,
            "facebook-page-dots-reference.png centers it on the photo."
        )

        dragHorizontally(hero, towardsLeading: true)

        waitFor(
            indicator,
            toSatisfy: "label == 'Photo 2 of 5'",
            "The indicator must follow the swipe."
        )

        app.buttons["photo-review.thumbnail.4"].tap()

        waitFor(
            indicator,
            toSatisfy: "label == 'Photo 4 of 5'",
            "The indicator must follow a thumbnail tap too."
        )
        addScreenshot(named: "PHOTO-REVIEW-883-REV-03-PAGE-INDICATOR-402x874.png")
    }

    func testPhotoReviewHeroNavigationHidesAtOnePhotoAndDoesNotOpenActionsRow() {
        let app = launch(extraArguments: ["--photo-review-state=REV-01"])
        let hero = app.buttons["photo-review.hero"]

        XCTAssertTrue(hero.waitForExistence(timeout: 3))
        XCTAssertFalse(
            app.buttons["photo-review.hero.next"].exists,
            "#883 retired the hero chevrons."
        )
        XCTAssertFalse(app.buttons["photo-review.hero.previous"].exists)
        XCTAssertFalse(
            app.otherElements["photo-review.hero.page-indicator"].exists,
            "A single staged photo has no pages to indicate."
        )
        XCTAssertFalse(
            app.buttons["photo-review.delete"].exists,
            "Navigation must not open the Replace/Delete actions row by itself."
        )
    }

    func testPhotoReviewREV02OwnsCollapsedVoiceRowAndStartListingShell() {
        let app = launch(extraArguments: ["--photo-review-state=REV-02"])
        let screen = app.scrollViews["photo-review.screen"]
        let collapsedVoiceRow = app.buttons["photo-review.voice"]
        let startListing = app.buttons["photo-review.start-listing"]

        XCTAssertTrue(screen.waitForExistence(timeout: 3))
        XCTAssertTrue(collapsedVoiceRow.exists)
        XCTAssertEqual(
            collapsedVoiceRow.label,
            "Voice note, Add details the photos might miss, collapsed",
            "Photo Review v5 owns the collapsed Voice note row and its live helper."
        )
        XCTAssertTrue(startListing.exists)
        addScreenshot(named: "PHOTO-REVIEW-V5-REV-02-COLLAPSED-402x874.png")
    }

    func testPhotoReviewREV01RendersOneSelectedCoverPhotoWithProgressiveActions() {
        let app = launch(extraArguments: ["--photo-review-state=REV-01"])
        let screen = app.scrollViews["photo-review.screen"]
        let hero = app.buttons["photo-review.hero"]
        let firstPhoto = app.buttons["photo-review.thumbnail.1"]

        XCTAssertTrue(screen.waitForExistence(timeout: 3))
        XCTAssertEqual(app.staticTexts["photo-review.count"].label, "1 of 5")
        XCTAssertTrue(hero.exists)
        assertPhotoReviewThumbnailCatalog(app, state: "REV-01")
        XCTAssertFalse(app.buttons["photo-review.thumbnail.2"].exists)
        XCTAssertFalse(app.buttons["photo-review.replace"].exists)
        XCTAssertFalse(app.buttons["photo-review.delete"].exists)
        addScreenshot(named: "REV-01-402x874.png")

        hero.tap()

        XCTAssertTrue(app.buttons["photo-review.replace"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.buttons["photo-review.delete"].exists)
        XCTAssertTrue(firstPhoto.isSelected)
    }

    func testPhotoReviewREV04RendersSecondPhotoSelectedWithActionsInFlow() {
        let app = launch(extraArguments: ["--photo-review-state=REV-04"])
        let screen = app.scrollViews["photo-review.screen"]
        let secondPhoto = app.buttons["photo-review.thumbnail.2"]
        let replace = app.buttons["photo-review.replace"]
        let delete = app.buttons["photo-review.delete"]

        XCTAssertTrue(screen.waitForExistence(timeout: 3))
        XCTAssertEqual(app.staticTexts["photo-review.count"].label, "3 of 5")
        assertPhotoReviewThumbnailCatalog(app, state: "REV-04")
        XCTAssertTrue(replace.exists)
        XCTAssertTrue(delete.exists)
        XCTAssertGreaterThanOrEqual(replace.frame.minY, secondPhoto.frame.maxY)
        XCTAssertGreaterThanOrEqual(delete.frame.minY, secondPhoto.frame.maxY)
        addScreenshot(named: "REV-04-402x874.png")
    }

    func testPhotoReviewREV05ShowsOnlyTheFirstRejectedSaveExit() {
        let app = launch(extraArguments: ["--photo-review-state=REV-05"])

        XCTAssertTrue(
            app.scrollViews["photo-review.save-failure"].waitForExistence(timeout: 3)
        )
        XCTAssertEqual(
            app.staticTexts["photo-review.save-failure.heading"].label,
            "These photos cannot be saved."
        )
        XCTAssertEqual(
            app.staticTexts["photo-review.save-failure.body"].label,
            "SnapList could not save the photos on this screen. This is a problem on this device, not something you did. No credit was used."
        )
        XCTAssertEqual(
            app.otherElements["photo-review.save-failure.photos"].label,
            "3 photos on this screen"
        )
        XCTAssertLessThan(
            app.staticTexts["photo-review.save-failure.heading"].frame.maxY,
            app.otherElements["photo-review.save-failure.photos"].frame.minY
        )
        XCTAssertLessThanOrEqual(
            app.staticTexts["photo-review.save-failure.body"].frame.maxY,
            app.otherElements["photo-review.save-failure.photos"].frame.minY + 1
        )
        XCTAssertTrue(app.buttons["photo-review.save-failure.retry"].exists)
        XCTAssertTrue(app.buttons["photo-review.save-failure.discard"].exists)
        XCTAssertFalse(app.buttons["photo-review.back"].exists)
        XCTAssertFalse(app.buttons["photo-review.delete"].exists)
        XCTAssertFalse(app.staticTexts["photo-review.count"].exists)
    }

    func testPhotoReviewREV06WithdrawsRetryAndKeepsOnlyDiscard() {
        let app = launch(extraArguments: ["--photo-review-state=REV-06"])

        XCTAssertTrue(
            app.scrollViews["photo-review.save-failure"].waitForExistence(timeout: 3)
        )
        XCTAssertEqual(
            app.staticTexts["photo-review.save-failure.heading"].label,
            "Saving failed again. These photos cannot be kept."
        )
        XCTAssertEqual(
            app.staticTexts["photo-review.save-failure.body"].label,
            "Nothing more will recover them. Discard them to continue."
        )
        XCTAssertFalse(app.buttons["photo-review.save-failure.retry"].exists)
        XCTAssertTrue(app.buttons["photo-review.save-failure.discard"].exists)
        XCTAssertFalse(app.buttons["photo-review.back"].exists)
        XCTAssertFalse(app.buttons["photo-review.delete"].exists)
        XCTAssertFalse(app.staticTexts["photo-review.count"].exists)
    }

    func testPhotoReviewHardwareKeyboardControlLeftMovesSelectedSecondPhotoToCoverWithReducedMotion() {
        let app = launch(extraArguments: [
            "--photo-review-state=REV-04",
            "--reduced-motion",
            "--photo-review-fixture-order-probe"
        ])
        let screen = app.scrollViews["photo-review.screen"]
        let order = app.staticTexts["photo-review.fixture-order"]
        let secondPhoto = app.buttons["photo-review.thumbnail.2"]
        let initialOrder = [
            "45500000-0000-4000-8000-000000000001",
            "45500000-0000-4000-8000-000000000002",
            "45500000-0000-4000-8000-000000000003"
        ].joined(separator: "|")
        let reordered = [
            "45500000-0000-4000-8000-000000000002",
            "45500000-0000-4000-8000-000000000001",
            "45500000-0000-4000-8000-000000000003"
        ].joined(separator: "|")

        XCTAssertTrue(screen.waitForExistence(timeout: 3))
        XCTAssertTrue(order.waitForExistence(timeout: 2))
        XCTAssertEqual(order.label, initialOrder)
        XCTAssertTrue(
            app.otherElements["photo-review.motion-reduced"].exists,
            "The hardware-keyboard proof must use the Reduced Motion path."
        )
        XCTAssertTrue(secondPhoto.exists)

        secondPhoto.tap()

        XCTAssertTrue(secondPhoto.isSelected)
        app.typeKey(.leftArrow, modifierFlags: .control)

        let reorderedExpectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label == %@", reordered),
            object: order
        )
        let result = XCTWaiter.wait(
            for: [reorderedExpectation],
            timeout: 3
        )
        addScreenshot(named: "reduced-motion-REV-04-402x874.png")
        XCTAssertEqual(
            result,
            .completed,
            "One Control+Left must commit exactly one move from A/B/C to B/A/C."
        )
        XCTAssertEqual(order.label, reordered)

        let movedPhoto = app.buttons["photo-review.thumbnail.1"]
        XCTAssertTrue(movedPhoto.exists)
        XCTAssertEqual(
            movedPhoto.label,
            "Photo 1 of 3, Cover, selected. Actions: Replace, Delete, Move later."
        )
        XCTAssertTrue(movedPhoto.isSelected)
    }

    func testPhotoReviewThumbnailsHideVisibleOrdinalsWhileAccessibilityRetainsOrderSelectionCoverAndProgressiveActions() {
        let app = launch(extraArguments: ["--photo-review-state=REV-02"])
        let screen = app.scrollViews["photo-review.screen"]

        XCTAssertTrue(
            screen.waitForExistence(timeout: 3),
            "The approved Photo Review fixture must render the public screen."
        )

        XCTAssertEqual(app.staticTexts["photo-review.count"].label, "3 of 5")
        XCTAssertEqual(
            app.staticTexts.matching(identifier: "photo-review.visible-ordinal").count,
            0
        )
        XCTAssertFalse(
            app.staticTexts["photo-review.fixture-order"].exists,
            "Stable identity diagnostics must not enter ordinary accessibility order."
        )

        let hero = app.buttons["photo-review.hero"]
        let firstPhoto = app.buttons["photo-review.thumbnail.1"]
        let secondPhoto = app.buttons["photo-review.thumbnail.2"]
        XCTAssertEqual(
            hero.label,
            "Photo 2 of 3, selected. Actions: Replace, Delete."
        )
        assertPhotoReviewThumbnailCatalog(app, state: "REV-02")
        let back = app.buttons["photo-review.back"]
        let voice = app.buttons["photo-review.voice"]
        let startListing = app.buttons["photo-review.start-listing"]
        XCTAssertTrue(back.exists)
        XCTAssertGreaterThanOrEqual(back.frame.width, 44)
        XCTAssertGreaterThanOrEqual(back.frame.height, 44)
        XCTAssertTrue(voice.exists)
        XCTAssertEqual(
            voice.label,
            "Voice note, Add details the photos might miss, collapsed"
        )
        XCTAssertTrue(startListing.exists)
        XCTAssertEqual(startListing.label, "Start listing")

        XCTAssertFalse(app.buttons["photo-review.replace"].exists)
        XCTAssertFalse(app.buttons["photo-review.delete"].exists)
        addScreenshot(named: "REV-02-402x874.png")

        secondPhoto.tap()

        XCTAssertTrue(app.buttons["photo-review.replace"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.buttons["photo-review.delete"].exists)
        XCTAssertTrue(secondPhoto.isSelected)
        XCTAssertFalse(firstPhoto.isSelected)
    }

    func testPhotoReviewNativeDragSourcePreservesNonCoverThumbnailTapActions() {
        let app = launch(extraArguments: ["--photo-review-state=REV-02"])
        let screen = app.scrollViews["photo-review.screen"]

        XCTAssertTrue(
            screen.waitForExistence(timeout: 3),
            "The live Photo Review fixture must render the native drag source."
        )

        let secondPhoto = app.buttons["photo-review.thumbnail.2"]
        XCTAssertTrue(secondPhoto.exists)
        XCTAssertFalse(app.buttons["photo-review.replace"].exists)
        XCTAssertFalse(app.buttons["photo-review.delete"].exists)

        secondPhoto.tap()

        XCTAssertTrue(
            app.buttons["photo-review.replace"].waitForExistence(timeout: 2),
            "The native drag attachment must preserve the thumbnail Button tap."
        )
        XCTAssertTrue(app.buttons["photo-review.delete"].exists)
        XCTAssertTrue(secondPhoto.isSelected)
    }

    func testPhotoReviewNativeDragMovesThirdPhotoToCoverAndOutsideDropStaysInertWithReducedMotion() {
        // A native drag replays against whichever process owns the screen, so a
        // surviving prior fixture silently retargets the gesture.
        UIProcessTerminationBoundary().assertRetired(
            XCUIApplication(),
            "The prior fixture process"
        )
        let app = launch(extraArguments: [
            "--photo-review-state=REV-02",
            "--reduced-motion",
            "--photo-review-fixture-order-probe"
        ])
        let screen = app.scrollViews["photo-review.screen"]

        XCTAssertTrue(
            screen.waitForExistence(timeout: 3),
            "The approved Photo Review fixture must render the public drag surface."
        )

        let order = app.staticTexts["photo-review.fixture-order"]
        XCTAssertTrue(
            order.waitForExistence(timeout: 2),
            "The fixture must expose stable identities without changing seller UI."
        )
        let initialOrder = [
            "45500000-0000-4000-8000-000000000001",
            "45500000-0000-4000-8000-000000000002",
            "45500000-0000-4000-8000-000000000003"
        ].joined(separator: "|")
        let reordered = [
            "45500000-0000-4000-8000-000000000003",
            "45500000-0000-4000-8000-000000000001",
            "45500000-0000-4000-8000-000000000002"
        ].joined(separator: "|")
        XCTAssertEqual(order.label, initialOrder)
        XCTAssertTrue(
            app.otherElements["photo-review.motion-reduced"].exists,
            "The fixture must drive Photo Review through its Reduced Motion path."
        )

        let firstPhoto = app.buttons["photo-review.thumbnail.1"]
        let thirdPhoto = app.buttons["photo-review.thumbnail.3"]
        thirdPhoto.coordinate(
            withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)
        ).press(
            // UIKit lifts the drag item on its own animation, and translating before
            // that animation settles makes it run the lift backwards and abort the
            // session. Hold well past the lift so the drag is airborne before travel.
            forDuration: 1.5,
            thenDragTo: firstPhoto.coordinate(
                withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)
            ),
            // A fast synthesized translation reaches Cover in one or two events, which
            // is too coarse for the drop interaction to be consulted at all. Travel
            // slowly enough to deliver a stream of moves.
            withVelocity: 200,
            // Keep the native session over Cover long enough for SwiftUI to
            // render the transient production gap before performDrop clears it.
            thenHoldForDuration: 1.2
        )

        let reorderedExpectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label == %@", reordered),
            object: order
        )
        let dragObservation = app.otherElements[
            "photo-review.drag-observation"
        ]
        XCTAssertEqual(
            XCTWaiter.wait(for: [reorderedExpectation], timeout: 3),
            .completed,
            dragObservation.exists
                ? "Native drop chronology: \(dragObservation.label)"
                : "Native drop chronology was not projected."
        )
        XCTAssertTrue(firstPhoto.label.contains("Photo 1 of 3"))
        XCTAssertTrue(firstPhoto.label.contains("Cover"))
        XCTAssertTrue(firstPhoto.isSelected)

        XCTAssertTrue(
            dragObservation.waitForExistence(timeout: 2),
            "The fixture must project the production drag decisions."
        )
        XCTAssertTrue(
            dragObservation.label.contains("gap=62"),
            "The native destination must render the approved active insertion gap."
        )
        XCTAssertTrue(
            dragObservation.label.contains("transition=suppressed"),
            "Reduced Motion must suppress the production drag transition decision."
        )
        addScreenshot(named: "drag-drop-complete-402x874.png")

        let outside = app.coordinate(
            withNormalizedOffset: CGVector(dx: 0.5, dy: 0.02)
        )
        firstPhoto.coordinate(
            withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)
        ).press(
            forDuration: 0.8,
            thenDragTo: outside
        )

        let dragEndedExpectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"),
            object: app.otherElements["photo-review.drag-active"]
        )
        XCTAssertEqual(
            XCTWaiter.wait(for: [dragEndedExpectation], timeout: 2),
            .completed
        )
        XCTAssertEqual(order.label, reordered)
        XCTAssertTrue(firstPhoto.label.contains("Cover"))
        XCTAssertTrue(firstPhoto.isSelected)

        app.terminate()

        let edgeApp = launch(extraArguments: [
            "--photo-review-state=REV-03",
            "--reduced-motion",
            "--photo-review-fixture-order-probe"
        ])
        XCTAssertTrue(
            edgeApp.scrollViews["photo-review.screen"].waitForExistence(
                timeout: 3
            )
        )
        let edgeSource = edgeApp.buttons["photo-review.thumbnail.1"]
        let fifthPhoto = edgeApp.buttons["photo-review.thumbnail.5"]
        let edgeOrder = edgeApp.staticTexts["photo-review.fixture-order"]
        XCTAssertTrue(edgeSource.exists)
        XCTAssertTrue(fifthPhoto.exists)
        XCTAssertTrue(
            edgeOrder.waitForExistence(timeout: 2),
            "The fixture must expose stable photo identity order."
        )
        let edgeOrderBeforeDrag = edgeOrder.label
        let fifthPhotoMinXBeforeDrag = fifthPhoto.frame.minX

        let appFrame = edgeApp.windows.firstMatch.frame
        let trailingEdge = edgeApp.coordinate(
            withNormalizedOffset: CGVector(
                dx: 0.99,
                dy: edgeSource.frame.midY / appFrame.height
            )
        )
        edgeSource.coordinate(
            withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)
        ).press(
            forDuration: 0.8,
            thenDragTo: trailingEdge
        )

        let edgeObservation = edgeApp.otherElements[
            "photo-review.drag-observation"
        ]
        XCTAssertTrue(edgeObservation.waitForExistence(timeout: 2))
        XCTAssertTrue(
            edgeObservation.label.contains("edge=trailing"),
            "The drag must cross the production 28pt trailing threshold."
        )
        let fifthPhotoDisplacement =
            fifthPhotoMinXBeforeDrag - fifthPhoto.frame.minX
        XCTAssertGreaterThan(
            fifthPhotoDisplacement,
            8,
            "Crossing the edge threshold must visibly move the real strip."
        )
        XCTAssertEqual(
            edgeOrder.label,
            edgeOrderBeforeDrag,
            "Edge autoscroll must not reorder an outside drop."
        )
    }

    func testPhotoReviewAtFivePhotosShowsAddDimmedDisabledAndInert() {
        let app = launch(extraArguments: ["--photo-review-state=REV-03"])
        let screen = app.scrollViews["photo-review.screen"]

        XCTAssertTrue(
            screen.waitForExistence(timeout: 3),
            "The approved REV-03 fixture must render the public screen."
        )
        XCTAssertEqual(app.staticTexts["photo-review.count"].label, "5 of 5")
        assertPhotoReviewThumbnailCatalog(app, state: "REV-03")

        let add = app.buttons["photo-review.add"]
        // REV-03 keeps Add visible so the strip does not reflow at the limit. It stops
        // being an action instead of disappearing.
        XCTAssertTrue(add.exists)
        XCTAssertFalse(add.isEnabled)
        XCTAssertEqual(
            add.label,
            "Add photos, unavailable at five photo limit"
        )
        addScreenshot(named: "REV-03-402x874.png")

        // A disabled control has no activation point at all: XCUITest cannot even
        // evaluate its hittability, and tapping it raises rather than doing nothing. That
        // it opens no picker and repeats no announcement is proved directly against
        // PhotoReviewPickerPresentation and PhotoReviewCapacityAnnouncer.
        let fifthPhoto = app.buttons["photo-review.thumbnail.5"]
        XCTAssertTrue(fifthPhoto.exists)
        XCTAssertTrue(fifthPhoto.label.contains("Photo 5 of 5"))

        // Replace stays available at the limit, because replacing is not capacity work.
        app.buttons["photo-review.thumbnail.1"].tap()
        let replace = app.buttons["photo-review.replace"]
        XCTAssertTrue(replace.waitForExistence(timeout: 2))
        XCTAssertTrue(replace.isEnabled)
        XCTAssertEqual(app.staticTexts["photo-review.count"].label, "5 of 5")
        XCTAssertFalse(add.isEnabled)
    }

    func testPhotoReviewHeroActivationRevealsActionsForExactSelectedIdentity() {
        let app = launch(extraArguments: ["--photo-review-state=REV-02"])
        let screen = app.scrollViews["photo-review.screen"]

        XCTAssertTrue(
            screen.waitForExistence(timeout: 3),
            "The approved Photo Review fixture must render the public screen."
        )

        let count = app.staticTexts["photo-review.count"]

        XCTAssertEqual(count.label, "3 of 5")
        assertPhotoReviewThumbnailCatalog(app, state: "REV-02")
        XCTAssertFalse(app.buttons["photo-review.replace"].exists)
        XCTAssertFalse(app.buttons["photo-review.delete"].exists)

        let hero = app.buttons["photo-review.hero"]
        guard hero.waitForExistence(timeout: 2) else {
            XCTFail(
                "The selected hero must be a native Button that activates its exact photo identity."
            )
            return
        }

        hero.tap()

        XCTAssertTrue(app.buttons["photo-review.replace"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.buttons["photo-review.delete"].exists)
        XCTAssertEqual(count.label, "3 of 5")
        assertPhotoReviewThumbnailCatalog(app, state: "REV-02")
    }

    func testScanCameraKeepsNamedControlsReachableAtAccessibilityTypeAndReducedMotion() {
        let app = launch(extraArguments: [
            "--visual-state=CAM-03",
            "--dynamic-type=accessibility3",
            "--reduced-motion"
        ])
        let window = app.windows.firstMatch.frame

        XCTAssertTrue(app.otherElements["scan.motion-reduced"].waitForExistence(timeout: 2))

        // #885: the live preview carries no dock, so the controls that must
        // stay reachable are the camera's own.
        XCTAssertFalse(app.buttons["dock.scan"].exists)
        XCTAssertFalse(app.buttons["dock.trophy-wall"].exists)

        for control in [
            app.buttons["scan.close"],
            app.buttons["scan.flash"],
            app.buttons["scan.library"],
            app.buttons["scan.shutter"],
            app.buttons["scan.review"]
        ] {
            XCTAssertTrue(control.waitForExistence(timeout: 2))
            XCTAssertGreaterThanOrEqual(
                control.frame.width,
                44,
                "\(control.identifier) width"
            )
            XCTAssertGreaterThanOrEqual(
                control.frame.height,
                44,
                "\(control.identifier) height"
            )
            XCTAssertGreaterThanOrEqual(control.frame.minX, window.minX)
            XCTAssertLessThanOrEqual(control.frame.maxX, window.maxX)
            XCTAssertGreaterThanOrEqual(control.frame.minY, window.minY)
            XCTAssertLessThanOrEqual(control.frame.maxY, window.maxY)
        }
    }

    // The flash's visible chrome is intentionally quieter than the library control, but its
    // interactive frame stays 48x48 so the visual refinement cannot shrink the tap target.
    func testScanCameraFlashRetainsTheFortyEightPointTapTarget() {
        let app = launch(extraArguments: ["--visual-state=CAM-03"])
        let flash = app.buttons["scan.flash"]

        XCTAssertTrue(flash.waitForExistence(timeout: 2))
        XCTAssertEqual(flash.frame.width, 48, accuracy: 0.5)
        XCTAssertEqual(flash.frame.height, 48, accuracy: 0.5)
    }

    func testCaptureGuidanceRespectsLandscapeSafeAreas() {
        let app = launch(
            extraArguments: ["--visual-state=CAP-02b2"],
            orientation: .landscapeLeft
        )

        let guidance = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "Whole item is in frame")
        ).firstMatch
        XCTAssertTrue(guidance.waitForExistence(timeout: 2))
        let window = app.windows.firstMatch.frame
        XCTAssertGreaterThanOrEqual(guidance.frame.minX, window.minX)
        XCTAssertLessThanOrEqual(guidance.frame.maxX, window.maxX)
        XCTAssertGreaterThanOrEqual(guidance.frame.minY, window.minY)
        XCTAssertLessThanOrEqual(guidance.frame.maxY, window.maxY)
        addScreenshot(named: "CAP-02b2-LANDSCAPE.png")
    }

    func testTrophyWallHeaderRoutesHaveVoiceOverLabelsAndFortyFourPointTargets() {
        let app = launch()
        app.buttons["dock.trophy-wall"].tap()
        let processing = app.buttons["trophy.wall.processing"]
        let account = app.buttons["trophy.wall.account"]

        for control in [processing, account] {
            XCTAssertTrue(control.exists)
            XCTAssertGreaterThanOrEqual(control.frame.width, 44)
            XCTAssertGreaterThanOrEqual(control.frame.height, 44)
        }

        XCTAssertEqual(processing.label, "Processing")
        XCTAssertEqual(account.label, "Account, opens Settings")
        XCTAssertFalse(app.buttons["dock.capture"].exists)

        processing.tap()
        XCTAssertTrue(app.otherElements["trophy.processing"].waitForExistence(timeout: 2))
    }

    func testKeyboardHidesTheFloatingDock() {
        let app = launch(extraArguments: ["--keyboard-probe"])
        let probe = app.textFields["fixture.keyboard-probe"]

        probe.tap()

        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 2))
        XCTAssertFalse(app.buttons["dock.scan"].exists)
    }

    func testProGateOfferKeepsTheApprovedLabelAndDecisionControlsReachable() {
        let app = launch(extraArguments: ["--pro-gate-fixture=PAY-01"])

        let title = app.staticTexts["pro-gate.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 3))
        XCTAssertEqual(title.label, "This item needs SnapList Pro")
        XCTAssertEqual(
            app.staticTexts["pro-gate.what-pro-does"].label,
            "What Pro does"
        )
        XCTAssertTrue(
            app.staticTexts["What happens if you don’t subscribe"].exists
        )
        XCTAssertTrue(app.staticTexts["$9.99 per month"].exists)

        for control in [
            app.buttons["pro-gate.primary"],
            app.buttons["pro-gate.restore-purchase"],
            app.buttons["pro-gate.not-now"],
        ] {
            XCTAssertTrue(control.exists, control.identifier)
            XCTAssertTrue(control.isHittable, control.identifier)
            XCTAssertGreaterThanOrEqual(control.frame.height, 44)
        }
        addScreenshot(named: "pro-gate-default")
    }

    /// Issue #812, AC 2: the paywall carried no Terms or Privacy link at all
    /// before this. A real `openURL` hands off to Safari and backgrounds this
    /// app, which a static disclosure line could never do.
    ///
    /// Retires Safari between links for the same reason
    /// `testSettingsAboutRowsOpenTheirLiveLegalDestinations` does: a
    /// background/foreground cycle does not reliably re-trigger the handoff on
    /// the Simulator, so each link has to prove its own wiring against a known
    /// Safari state rather than inherit the previous link's.
    func testProGateOfferLegalFooterOpensTermsAndPrivacy() {
        for identifier in ["pro-gate.terms-of-service", "pro-gate.privacy-policy"] {
            XCUIApplication(bundleIdentifier: "com.apple.mobilesafari").terminate()

            let app = launch(extraArguments: ["--pro-gate-fixture=PAY-01"])
            let title = app.staticTexts["pro-gate.title"]
            XCTAssertTrue(title.waitForExistence(timeout: 3))

            let link = app.buttons[identifier]
            for _ in 0..<4 where !link.isHittable {
                app.swipeUp()
            }
            XCTAssertTrue(link.exists, "\(identifier): \(app.debugDescription)")
            XCTAssertTrue(link.isHittable, "\(identifier): \(app.debugDescription)")
            XCTAssertGreaterThanOrEqual(link.frame.width, 44, identifier)
            XCTAssertGreaterThanOrEqual(link.frame.height, 44, identifier)

            link.tap()

            XCTAssertTrue(
                waitForBackgroundHandoff(app, timeout: Self.legalHandoffBudget),
                "\(identifier) did not hand off to Safari within "
                    + "\(Self.legalHandoffBudget)s: observed \(app.state.reportedName)"
            )
            app.terminate()
        }
    }

    func testProGateAccessibilityTypeScalesAndKeepsActionsInTheSheetScroll() {
        let standardApp = launch(extraArguments: ["--pro-gate-fixture=PAY-01"])
        let standardTitle = standardApp.staticTexts["pro-gate.title"]
        XCTAssertTrue(standardTitle.waitForExistence(timeout: 3))
        let standardTitleHeight = standardTitle.frame.height

        let app = launch(
            extraArguments: [
                "--pro-gate-fixture=PAY-01",
                "--dynamic-type=accessibility3",
            ]
        )
        let title = app.staticTexts["pro-gate.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 3))
        XCTAssertGreaterThan(title.frame.height, standardTitleHeight * 1.5)

        let primary = app.buttons["pro-gate.primary"]
        for _ in 0..<5 where !primary.isHittable {
            app.swipeUp()
        }
        XCTAssertTrue(app.staticTexts["$9.99 per month"].exists)
        for control in [
            primary,
            app.buttons["pro-gate.restore-purchase"],
            app.buttons["pro-gate.not-now"],
        ] {
            XCTAssertTrue(control.isHittable, control.identifier)
            XCTAssertGreaterThanOrEqual(control.frame.height, 44)
        }
        addScreenshot(named: "pro-gate-accessibility3")
    }

    /// #961: the paywall is one of the sheets the owner named directly ("the
    /// paywall and everything"). `pro-gate.primary` sits outside the sheet's
    /// own `ScrollView` (it is pinned below it at this, non-accessibility,
    /// Dynamic Type size), so a drag started there reaches the sheet's
    /// drag-to-dismiss recognizer instead of just scrolling the offer copy.
    func testProGatePaywallSlidesDownToDismissWhenDismissible() {
        let app = launch(extraArguments: ["--pro-gate-fixture=PAY-01"])

        let title = app.staticTexts["pro-gate.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["pro-gate.primary"].waitForExistence(timeout: 3))

        // Drag from the title text, not a button — starting the touch on a
        // Button hands the gesture to its own tap/highlight tracking before
        // the sheet's interactive-dismiss pan ever sees it, the same reason
        // ListingReviewDrawer's dismiss test drags from the drawer container
        // rather than one of its controls.
        let start = title.coordinate(
            withNormalizedOffset: CGVector(dx: 0.5, dy: 0)
        )
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 1))
        start.press(forDuration: 0.05, thenDragTo: end)

        XCTAssertFalse(
            title.waitForExistence(timeout: 3),
            "A swipe-down must dismiss the paywall when it is dismissible."
        )
    }

    func testProGatePurchasePendingHasNoDismissOrRestoreAction() {
        let app = launch(extraArguments: ["--pro-gate-fixture=PAY-03"])

        XCTAssertTrue(
            app.staticTexts["pro-gate.title"].waitForExistence(timeout: 3)
        )
        XCTAssertTrue(
            app.descendants(matching: .any)["pro-gate.confirming"].exists
        )
        XCTAssertFalse(app.buttons["pro-gate.restore-purchase"].exists)
        XCTAssertFalse(app.buttons["pro-gate.not-now"].exists)
    }

    func testAccessibilityDynamicTypeKeepsFoundationControlsReachable() {
        let app = launch(extraArguments: ["--dynamic-type=accessibility3"])
        app.buttons["dock.trophy-wall"].tap()

        XCTAssertTrue(app.otherElements["trophy.wall"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.buttons["trophy.wall.processing"].exists)
        XCTAssertTrue(app.buttons["trophy.wall.account"].exists)
        XCTAssertTrue(app.buttons["dock.scan"].exists)
        XCTAssertTrue(app.buttons["dock.trophy-wall"].exists)
    }

    func testFloatingDockRespectsTheBottomSafeArea() {
        let app = launch()
        let window = app.windows.firstMatch
        let trophyWall = app.buttons["dock.trophy-wall"]

        XCTAssertTrue(window.exists)
        XCTAssertTrue(trophyWall.exists)
        XCTAssertGreaterThan(window.frame.maxY - trophyWall.frame.maxY, 8)
    }

    func testApprovedVisualStateLaunchArgumentUsesTypedBoundary() {
        let app = launch(extraArguments: ["--visual-state=RUN-01"])

        XCTAssertTrue(app.otherElements["visual-state.RUN-01"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.staticTexts["RUN-01"].exists)
        XCTAssertTrue(app.staticTexts["Rendering boundary reserved for issue #211."].exists)
    }

    func testIssue775StartScanningLandsOnCanonicalScanWithoutLegacyLauncher() {
        let app = launchFirstValueOnboarding(resetProgress: true)
        advanceFirstValueOnboarding(to: "ONB-06", in: app)

        let startScanning = app.buttons["first-value-onboarding.start-scanning"]
        XCTAssertTrue(startScanning.waitForExistence(timeout: 3), app.debugDescription)
        startScanning.tap()

        let legacyPrimer = app.otherElements["onboarding.state.ONB-07"]
        let legacyUseCamera = app.buttons["button.primary.use-camera"]
        let legacyContinue = app.buttons["button.primary.continue-to-capture"]
        let legacyLauncherTitle = app.staticTexts["sheet.capture.title"]
        let legacyTakeOneItem = app.buttons["capture.take-one-item"]
        let legacyChooseLibrary = app.buttons["capture.choose-library"]

        for legacyElement in [
            legacyPrimer,
            legacyUseCamera,
            legacyContinue,
            legacyLauncherTitle,
            legacyTakeOneItem,
            legacyChooseLibrary,
        ] {
            XCTAssertFalse(
                legacyElement.waitForExistence(timeout: 1),
                app.debugDescription
            )
        }

        let scanDock = app.buttons["dock.scan"]
        XCTAssertTrue(scanDock.waitForExistence(timeout: 3), app.debugDescription)
        XCTAssertTrue(scanDock.isSelected)
        XCTAssertEqual(scanDock.label, "Scan")

        let liveLibrary = app.buttons["scan.library"]
        let recoveryLibrary = app.buttons["scan.choose-library"]
        let canonicalScanControlExists = liveLibrary.waitForExistence(timeout: 2)
            || recoveryLibrary.waitForExistence(timeout: 2)
        XCTAssertTrue(canonicalScanControlExists, app.debugDescription)
        XCTAssertFalse(app.buttons["first-value-onboarding.start-scanning"].exists)
    }

    func testActualOnboardingCaptureEntryPresentsACT01BeforeCameraOrLibrary() {
        let app = launchFirstValueOnboarding(
            resetProgress: true,
            extraArguments: ["--reset-activation-guidance"]
        )
        advanceFirstValueOnboarding(to: "ONB-06", in: app)

        let startScanning = app.buttons["first-value-onboarding.start-scanning"]
        XCTAssertTrue(startScanning.waitForExistence(timeout: 2))
        startScanning.tap()

        XCTAssertTrue(app.buttons["dock.scan"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.otherElements["onboarding.state.ONB-07"].exists)
        XCTAssertFalse(app.staticTexts["sheet.capture.title"].exists)
        XCTAssertTrue(activationGuidance(in: app).waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["One item, up to five photos."].exists)

        let liveLibrary = app.buttons["scan.library"]
        let recoveryLibrary = app.buttons["scan.choose-library"]
        XCTAssertTrue(
            liveLibrary.waitForExistence(timeout: 2)
                || recoveryLibrary.waitForExistence(timeout: 2),
            app.debugDescription
        )
        XCTAssertTrue(activationGuidance(in: app).exists)
    }

    func testFirstValueOnboardingPresentsOnceInOrder() {
        let app = launchFirstValueOnboarding(resetProgress: true)

        for screen in firstValueOnboardingStates {
            XCTAssertTrue(
                app.descendants(matching: .any)[
                    "first-value-onboarding.state.\(screen)"
                ].waitForExistence(timeout: 3),
                "Missing \(screen)"
            )
            if screen != "ONB-06" {
                app.buttons["first-value-onboarding.continue"].tap()
            }
        }
    }

    func testFirstValueOnboardingSkipReachesIncludedScreenBeforeCompletion() {
        let app = launchFirstValueOnboarding(resetProgress: true)

        XCTAssertTrue(app.buttons["first-value-onboarding.skip"].waitForExistence(timeout: 3))
        app.buttons["first-value-onboarding.skip"].tap()

        XCTAssertTrue(
            app.descendants(matching: .any)["first-value-onboarding.state.ONB-06"]
                .waitForExistence(timeout: 3)
        )
        XCTAssertTrue(app.buttons["first-value-onboarding.back"].exists)
        XCTAssertFalse(app.buttons["first-value-onboarding.skip"].exists)
    }

    func testFirstValueOnboardingRelaunchDoesNotRepresent() {
        let app = launchFirstValueOnboarding(resetProgress: true)
        XCTAssertTrue(app.buttons["first-value-onboarding.skip"].waitForExistence(timeout: 3))
        app.buttons["first-value-onboarding.skip"].tap()
        XCTAssertTrue(
            app.buttons["first-value-onboarding.start-scanning"].waitForExistence(timeout: 3)
        )
        app.buttons["first-value-onboarding.start-scanning"].tap()
        XCTAssertTrue(app.buttons["dock.scan"].waitForExistence(timeout: 3))
        XCTAssertTrue(
            app.buttons["scan.library"].waitForExistence(timeout: 2)
                || app.buttons["scan.choose-library"].waitForExistence(timeout: 2),
            app.debugDescription
        )
        XCTAssertFalse(app.otherElements["onboarding.state.ONB-07"].exists)

        app.terminate()
        app.launchArguments = [
            "--fixture=onboarding",
            "--zero-network-fixtures",
            "--camera-status=authorized"
        ]
        app.launchAfterRetiringPriorInstance()

        XCTAssertTrue(app.buttons["dock.scan"].waitForExistence(timeout: 3))
        XCTAssertTrue(
            app.buttons["scan.library"].waitForExistence(timeout: 2)
                || app.buttons["scan.choose-library"].waitForExistence(timeout: 2),
            app.debugDescription
        )
        XCTAssertFalse(
            app.descendants(matching: .any)["first-value-onboarding.state.ONB-01"].exists
        )
        XCTAssertFalse(app.otherElements["onboarding.state.ONB-07"].exists)
    }

    func testFirstValueOnboardingONB06UsesExistingAccountRouteAndHasBackControls() {
        let app = launchFirstValueOnboarding(resetProgress: true)
        advanceFirstValueOnboarding(to: "ONB-06", in: app)
        let screen = app.descendants(matching: .any)[
            "first-value-onboarding.state.ONB-06"
        ]

        XCTAssertTrue(screen.waitForExistence(timeout: 3))
        XCTAssertEqual(screen.descendants(matching: .button).count, 3, app.debugDescription)
        XCTAssertTrue(app.buttons["first-value-onboarding.start-scanning"].exists)
        XCTAssertTrue(app.buttons["first-value-onboarding.sign-in"].exists)
        XCTAssertFalse(app.buttons["first-value-onboarding.skip"].exists)
        XCTAssertTrue(app.buttons["first-value-onboarding.back"].exists)

        app.buttons["first-value-onboarding.sign-in"].tap()
        XCTAssertTrue(
            app.descendants(matching: .any)["account-entry"].waitForExistence(timeout: 3),
            app.debugDescription
        )

        // The stand-in carries the real screen's presentation shape — its own
        // NavigationStack inside a sheet — so a pushed account boundary fails here
        // exactly as ClerkKit's AuthView does in production (#799).
        XCTAssertTrue(
            app.staticTexts["Account"].waitForExistence(timeout: 3),
            app.debugDescription
        )
        XCTAssertFalse(app.navigationBars.buttons["Back"].exists, app.debugDescription)

        let dismiss = app.buttons["clerk.dismissButton"]
        XCTAssertTrue(dismiss.waitForExistence(timeout: 3), app.debugDescription)
        dismiss.tap()

        // Dismissing returns to ONB-06 with its own controls intact rather than to
        // a reset stack.
        XCTAssertTrue(screen.waitForExistence(timeout: 3), app.debugDescription)
        XCTAssertTrue(app.buttons["first-value-onboarding.sign-in"].exists)
        XCTAssertTrue(app.buttons["first-value-onboarding.back"].exists)
    }

    /// The live ONB-06 approval crop centers a 353-point photo-first listing with a
    /// 254-point photo above a metadata band. The band no longer has a fixed height, so
    /// what is pinned is the spacing inside it: the title sits below the photo and the
    /// price row below the title, both by the paddings #887 evened out. These ranges
    /// inspect the preview container that owns the controller's accessibility semantics.
    func testFirstValueOnboardingONB06UsesApprovedPhotoFirstPreviewMetrics() {
        let app = launchFirstValueOnboarding(resetProgress: true)
        advanceFirstValueOnboarding(to: "ONB-06", in: app)
        let window = app.windows.firstMatch
        let photo = app.otherElements["first-value-onboarding.included-photo-preview"]
        let title = app.staticTexts["Sony DualSense wireless controller, white"]
        let readyToReview = app.staticTexts["Ready to review"]
        let price = app.staticTexts["$58"]

        XCTAssertTrue(photo.waitForExistence(timeout: 3), app.debugDescription)
        XCTAssertTrue(title.exists, app.debugDescription)
        XCTAssertTrue(readyToReview.exists, app.debugDescription)
        XCTAssertTrue(price.exists, app.debugDescription)
        XCTAssertEqual(photo.frame.midX, window.frame.midX, accuracy: 2)
        XCTAssertEqual(photo.frame.width, 353, accuracy: 2)
        XCTAssertEqual(photo.frame.height, 254, accuracy: 4)
        XCTAssertEqual(title.frame.minY, photo.frame.maxY + 15, accuracy: 3)
        XCTAssertEqual(readyToReview.frame.minY, title.frame.maxY + 6, accuracy: 4)
        XCTAssertEqual(price.frame.minY, readyToReview.frame.minY, accuracy: 4)
    }

    /// ONB-05 keeps the approved work rows and Scout line without adding explanatory
    /// caption copy or a progress affordance.
    func testFirstValueOnboardingONB05HasApprovedRowsAndScoutWithoutExtraCaption() {
        let app = launchFirstValueOnboarding(resetProgress: true)
        advanceFirstValueOnboarding(to: "ONB-05", in: app)
        let window = app.windows.firstMatch
        let screen = app.descendants(matching: .any)[
            "first-value-onboarding.state.ONB-05"
        ]
        let controls = [
            app.buttons["first-value-onboarding.back"],
            app.buttons["first-value-onboarding.skip"],
            app.buttons["first-value-onboarding.continue"]
        ]
        let approvedRows = [
            "DualSense controller, Writing the listing",
            "AirPods Max, Checking sold prices",
            "Charizard card, Reading your voice note"
        ]

        XCTAssertTrue(screen.waitForExistence(timeout: 3))
        for control in controls {
            XCTAssertTrue(control.exists, app.debugDescription)
            XCTAssertTrue(control.isHittable, app.debugDescription)
            XCTAssertGreaterThanOrEqual(control.frame.width, 44, app.debugDescription)
            XCTAssertGreaterThanOrEqual(control.frame.height, 44, app.debugDescription)
            XCTAssertGreaterThanOrEqual(control.frame.minX, window.frame.minX, app.debugDescription)
            XCTAssertGreaterThanOrEqual(control.frame.minY, window.frame.minY, app.debugDescription)
            XCTAssertLessThanOrEqual(control.frame.maxX, window.frame.maxX, app.debugDescription)
            XCTAssertLessThanOrEqual(control.frame.maxY, window.frame.maxY, app.debugDescription)
        }
        for row in approvedRows {
            XCTAssertEqual(
                screen.staticTexts
                    .matching(NSPredicate(format: "label == %@", row)).count,
                1,
                app.debugDescription
            )
        }
        let scoutLine = screen.descendants(matching: .any)
            .matching(identifier: "first-value-onboarding.scout-line.ONB-05")
        XCTAssertEqual(scoutLine.count, 1, app.debugDescription)
        XCTAssertEqual(
            scoutLine.firstMatch.label,
            "Scout keeps working in the background."
        )
        XCTAssertFalse(app.staticTexts["An example — nothing is running yet"].exists)
        XCTAssertEqual(app.activityIndicators.count, 0, app.debugDescription)
        XCTAssertEqual(app.progressIndicators.count, 0, app.debugDescription)
    }

    func testIssue775KeepsDraftScoutClearAndFinalProgressFixed() {
        let app = launchFirstValueOnboarding(resetProgress: true)
        advanceFirstValueOnboarding(to: "ONB-04", in: app)

        let draftScout = app.descendants(matching: .any)[
            "first-value-onboarding.scout-line.ONB-04"
        ]
        let draftScoutCopy = app.staticTexts[
            "first-value-onboarding.draft-scout-copy"
        ]
        let lastDraftValue = app.staticTexts["Four paragraphs"]
        let continueButton = app.buttons["first-value-onboarding.continue"]

        for element in [draftScout, draftScoutCopy, lastDraftValue, continueButton] {
            XCTAssertTrue(element.waitForExistence(timeout: 3), app.debugDescription)
        }
        XCTAssertGreaterThanOrEqual(
            draftScout.frame.minY - lastDraftValue.frame.maxY,
            44
        )
        XCTAssertGreaterThanOrEqual(
            continueButton.frame.minY - draftScoutCopy.frame.maxY,
            32
        )

        let draftAttachment = XCTAttachment(
            screenshot: XCUIScreen.main.screenshot()
        )
        draftAttachment.name = "issue-775-ONB-04.png"
        draftAttachment.lifetime = .keepAlways
        add(draftAttachment)

        continueButton.tap()
        let progress = app.descendants(matching: .any)[
            "first-value-onboarding.progress"
        ]
        XCTAssertTrue(progress.waitForExistence(timeout: 3), app.debugDescription)
        let penultimateFrame = progress.frame

        app.buttons["first-value-onboarding.continue"].tap()
        XCTAssertTrue(
            app.descendants(matching: .any)[
                "first-value-onboarding.state.ONB-06"
            ].waitForExistence(timeout: 3),
            app.debugDescription
        )
        XCTAssertEqual(progress.frame.minX, penultimateFrame.minX, accuracy: 1)
        XCTAssertEqual(progress.frame.width, penultimateFrame.width, accuracy: 1)
        XCTAssertFalse(app.buttons["first-value-onboarding.skip"].exists)

        let finalAttachment = XCTAttachment(
            screenshot: XCUIScreen.main.screenshot()
        )
        finalAttachment.name = "issue-775-ONB-06.png"
        finalAttachment.lifetime = .keepAlways
        add(finalAttachment)
    }

    func testIssue775ONB04Accessibility5KeepsDraftHairlineScoutAndActionClear() {
        let app = launchFirstValueOnboarding(
            resetProgress: true,
            extraArguments: [
                "--first-value-onboarding-state=ONB-04",
                "--dynamic-type=accessibility5",
                "--reduced-motion",
            ]
        )
        let window = app.windows.firstMatch
        let scrollView = app.scrollViews["first-value-onboarding.scroll"]
        let draftHeader = app.descendants(matching: .any)[
            "Your draft is ready. Four fields, written from your photos."
        ]
        let titleRow = app.descendants(matching: .any)[
            "Title. Sony DualSense wireless controller, white."
        ]
        let lastDraftValue = app.staticTexts["Four paragraphs"]
        let draftScout = app.descendants(matching: .any)[
            "first-value-onboarding.scout-line.ONB-04"
        ]
        let draftScoutCopy = app.staticTexts[
            "first-value-onboarding.draft-scout-copy"
        ]
        let continueButton = app.buttons["first-value-onboarding.continue"]

        for element in [
            window,
            scrollView,
            draftHeader,
            titleRow,
            lastDraftValue,
            draftScout,
            draftScoutCopy,
            continueButton,
        ] {
            XCTAssertTrue(element.waitForExistence(timeout: 3), app.debugDescription)
            XCTAssertGreaterThan(element.frame.width, 0)
            XCTAssertGreaterThan(element.frame.height, 0)
        }

        XCTAssertLessThanOrEqual(draftHeader.frame.maxY, titleRow.frame.minY)

        var swipeCount = 0
        while swipeCount < 4 &&
            (!draftScout.isHittable || !continueButton.isHittable) {
            scrollView.swipeUp()
            swipeCount += 1
        }

        XCTAssertGreaterThanOrEqual(
            draftScout.frame.minY - lastDraftValue.frame.maxY,
            44
        )
        XCTAssertFalse(draftScout.frame.intersects(continueButton.frame))
        XCTAssertFalse(draftScoutCopy.frame.intersects(continueButton.frame))
        XCTAssertTrue(continueButton.isHittable, app.debugDescription)
        XCTAssertGreaterThanOrEqual(continueButton.frame.height, 44)
        XCTAssertGreaterThanOrEqual(continueButton.frame.minX, window.frame.minX)
        XCTAssertLessThanOrEqual(continueButton.frame.maxX, window.frame.maxX)
        XCTAssertLessThanOrEqual(continueButton.frame.maxY, window.frame.maxY)
    }

    /// At Accessibility 5, the public listing title and review metadata may
    /// reflow, but neither can share visible space with an anchored ONB-06 action.
    func testFirstValueOnboardingAccessibility5KeepsIncludedPreviewClearOfStickyActions() {
        let app = launchFirstValueOnboarding(
            resetProgress: true,
            extraArguments: ["--dynamic-type=accessibility5", "--reduced-motion"]
        )
        advanceFirstValueOnboarding(to: "ONB-06", in: app)
        let title = app.staticTexts["Sony DualSense wireless controller, white"]
        let readyToReview = app.staticTexts["Ready to review"]
        let startScanning = app.buttons["first-value-onboarding.start-scanning"]
        let existingAccount = app.buttons["first-value-onboarding.sign-in"]

        XCTAssertTrue(title.waitForExistence(timeout: 3), app.debugDescription)
        XCTAssertTrue(readyToReview.exists, app.debugDescription)
        XCTAssertTrue(startScanning.exists, app.debugDescription)
        XCTAssertTrue(existingAccount.exists, app.debugDescription)
        XCTAssertFalse(title.frame.intersects(startScanning.frame), app.debugDescription)
        XCTAssertFalse(readyToReview.frame.intersects(existingAccount.frame), app.debugDescription)
    }

    /// A returning seller whose durable capture survives lands on Resume with no
    /// onboarding control anywhere on screen.
    ///
    /// This samples after `resume` exists, which is after restoration resolved and
    /// `reconcileExistingProgress()` already recorded `supersededByExistingProgress`. It
    /// therefore proves the settled outcome, not the transient window before restoration
    /// answers — during that window the shell holds a neutral surface, which
    /// `OnboardingFlowTests.testFirstValueOnboardingNeverPreemptsAnUnresolvedOrRestoredCapture`
    /// proves at the pure policy seam. Naming this test after the transient window claimed
    /// evidence it does not carry.
    func testRestoredCaptureResumesWithNoFirstValueOnboardingControl() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--restored-capture-fixture",
            "--reset-onboarding-progress"
        ]
        app.launchAfterRetiringPriorInstance()

        let firstPhoto = app.descendants(matching: .any)["scan.photo-1"]
        XCTAssertTrue(firstPhoto.waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertFalse(
            app.descendants(matching: .any)["first-value-onboarding.state.ONB-01"].exists,
            app.debugDescription
        )
        XCTAssertFalse(app.buttons["first-value-onboarding.continue"].exists)
        XCTAssertFalse(app.buttons["first-value-onboarding.skip"].exists)
    }

    func testFirstValueOnboardingAccessibilityTypeKeepsEveryPrimaryActionReachable() {
        let app = launchFirstValueOnboarding(
            resetProgress: true,
            extraArguments: ["--dynamic-type=accessibility5", "--reduced-motion"]
        )
        let window = app.windows.firstMatch

        func isFullyReachable(_ action: XCUIElement) -> Bool {
            action.isHittable
                && action.frame.height >= 44
                && action.frame.minX >= window.frame.minX
                && action.frame.maxX <= window.frame.maxX
                && action.frame.maxY <= window.frame.maxY
        }

        for screen in firstValueOnboardingStates {
            XCTAssertTrue(
                app.descendants(matching: .any)[
                    "first-value-onboarding.state.\(screen)"
                ].waitForExistence(timeout: 3)
            )
            let identifier = screen == "ONB-06"
                ? "first-value-onboarding.start-scanning"
                : "first-value-onboarding.continue"
            let primary = app.buttons[identifier]
            XCTAssertTrue(primary.exists)

            if screen == "ONB-04" || screen == "ONB-06" {
                let onboardingScrollView = app.scrollViews["first-value-onboarding.scroll"]
                let existingAccount = app.buttons["first-value-onboarding.sign-in"]
                XCTAssertTrue(onboardingScrollView.exists, app.debugDescription)
                var swipeCount = 0
                let maximumSwipeCount = screen == "ONB-04" ? 4 : 3
                while swipeCount < maximumSwipeCount
                    && (!isFullyReachable(primary)
                        || (screen == "ONB-06" && !isFullyReachable(existingAccount))) {
                    onboardingScrollView.swipeUp()
                    swipeCount += 1
                }
            }

            XCTAssertTrue(primary.isHittable)
            XCTAssertGreaterThanOrEqual(primary.frame.height, 44)
            XCTAssertGreaterThanOrEqual(primary.frame.minX, window.frame.minX)
            XCTAssertLessThanOrEqual(primary.frame.maxX, window.frame.maxX)
            XCTAssertLessThanOrEqual(primary.frame.maxY, window.frame.maxY)

            if screen == "ONB-06" {
                let existingAccount = app.buttons["first-value-onboarding.sign-in"]
                XCTAssertTrue(existingAccount.exists)
                XCTAssertTrue(existingAccount.isHittable)
                XCTAssertGreaterThanOrEqual(existingAccount.frame.height, 44)
                XCTAssertGreaterThanOrEqual(existingAccount.frame.minX, window.frame.minX)
                XCTAssertLessThanOrEqual(existingAccount.frame.maxX, window.frame.maxX)
                XCTAssertLessThanOrEqual(existingAccount.frame.maxY, window.frame.maxY)
            }

            if screen != "ONB-06" { primary.tap() }
        }
    }

    func testCameraDeniedAndRestrictedUseLibraryRecovery() {
        for status in ["denied", "restricted"] {
            let app = launchOnboarding(state: "ONB-07", cameraStatus: status)

            app.buttons["button.primary.use-camera"].tap()

            XCTAssertTrue(app.staticTexts["Camera access is off"].waitForExistence(timeout: 2))
            XCTAssertTrue(app.buttons["onboarding.open-settings"].exists)
            XCTAssertTrue(app.buttons["onboarding.choose-library"].exists)
            XCTAssertEqual(app.buttons["onboarding.choose-library"].label, "Choose from library instead")
            app.terminate()
        }
    }

    func testRealSystemCameraPermissionCanBeDeniedWithoutCounterfeitSuccess() {
        let app = launchOnboarding(
            state: "ONB-07",
            resetCameraAuthorization: true
        )

        app.buttons["button.primary.use-camera"].tap()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let deny = springboard.alerts.firstMatch.buttons["Don’t Allow"]
        XCTAssertTrue(deny.waitForExistence(timeout: 5))
        deny.tap()

        XCTAssertTrue(app.staticTexts["Camera access is off"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.staticTexts["Ready to capture"].exists)
    }

    func testLibraryPickerCancelRestoresThePrimerAndItsOpener() {
        let app = launchOnboarding(state: "ONB-07", cameraStatus: "denied")
        let opener = app.buttons["onboarding.choose-library"]

        opener.tap()
        let cancel = app.buttons["Cancel"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 3))
        cancel.tap()

        XCTAssertTrue(opener.waitForExistence(timeout: 2))
        XCTAssertTrue(app.staticTexts["Let's photograph your item"].exists)
    }

    /// Renamed from `...ReachCAP01` (#864): the staged-library handoff used to
    /// land the seller on the CAP-01 launcher card; it now lands directly on
    /// the camera preview with the staged photos already counted in.
    ///
    /// Unlike the CAP-01 version, this test's "continue to capture" tap
    /// actually reaches the camera and durably stages a photo into
    /// `NativeIntake` — deliberately durable across relaunches so a seller's
    /// staged photo survives one, which means it also survives past this
    /// test's own process unless cleaned up. `--reset-capture-draft` in the
    /// existing cleanup relaunch (previously only resetting onboarding
    /// progress) prevents that leaking into whichever test shares this shard
    /// invocation's app container next (#864).
    func testStagedLibraryPhotosSurviveInterruptionAndReachTheCameraPreview() {
        let app = XCUIApplication()
        defer {
            app.terminate()
            let cleanup = XCUIApplication()
            cleanup.launchArguments = [
                "--fixture=onboarding",
                "--reset-onboarding-progress",
                "--reset-capture-draft"
            ]
            cleanup.launchAfterRetiringPriorInstance()
            cleanup.terminate()
        }

        app.launchArguments = [
            "--fixture=onboarding",
            "--camera-status=denied",
            "--reset-onboarding-progress",
            "--fixture-staged-library-photos=2"
        ]
        app.launchAfterRetiringPriorInstance()
        XCTAssertTrue(app.staticTexts["Photos ready"].waitForExistence(timeout: 3))

        app.terminate()
        app.launchArguments = [
            "--fixture=onboarding",
            "--camera-status=denied"
        ]
        app.launchAfterRetiringPriorInstance()

        XCTAssertTrue(app.staticTexts["Photos ready"].waitForExistence(timeout: 3))
        app.buttons["button.primary.continue-to-capture"].tap()

        // The handoff transfers one staged library photo at a time
        // (`OnboardingFlowModel.firstStagedLibraryPhotoForCapture`); the
        // second staged photo remains available for a later handoff.
        let firstPhoto = app.descendants(matching: .any)["scan.photo-1"]
        XCTAssertTrue(firstPhoto.waitForExistence(timeout: 3))
        XCTAssertFalse(app.descendants(matching: .any)["scan.photo-2"].exists)
        XCTAssertEqual(app.buttons["scan.review"].label, "Review 1 photo")
        XCTAssertFalse(app.staticTexts["sheet.capture.title"].exists)
        XCTAssertFalse(app.buttons["capture.take-one-item"].exists)
        XCTAssertFalse(app.buttons["capture.choose-library"].exists)
        XCTAssertFalse(app.otherElements["visual-state.CAP-01"].exists)
        XCTAssertFalse(app.staticTexts["Photo Review"].exists)
    }

    func testOnboardingAccessibilityAtLargeDynamicTypeKeepsTargetsAndSafeAreas() {
        let app = launchOnboarding(
            state: "ONB-07",
            cameraStatus: "denied",
            extraArguments: ["--dynamic-type=accessibility3", "--reduced-motion"]
        )
        let window = app.windows.firstMatch
        let camera = app.buttons["button.primary.use-camera"]
        let library = app.buttons["onboarding.choose-library"]
        let back = app.buttons["onboarding.back"]

        for control in [camera, library, back] {
            XCTAssertTrue(control.exists)
            XCTAssertGreaterThanOrEqual(control.frame.width, 44)
            XCTAssertGreaterThanOrEqual(control.frame.height, 44)
        }

        XCTAssertGreaterThanOrEqual(camera.frame.minY, window.frame.minY)
        XCTAssertLessThanOrEqual(library.frame.maxY, window.frame.maxY - 8)
        XCTAssertEqual(camera.label, "Use camera")
        XCTAssertEqual(library.label, "Choose from library")
    }

    func testAllowanceUsesAvailableHeightWithoutDeadRegionAndScales() {
        for arguments in [
            ["--reset-onboarding-progress"],
            [
                "--reset-onboarding-progress",
                "--dynamic-type=accessibility3",
                "--reduced-motion",
            ],
        ] {
            let app = launchOnboarding(
                state: "ONB-06",
                cameraStatus: "denied",
                extraArguments: arguments
            )
            let window = app.windows.firstMatch
            let marketplaces = app.buttons["onboarding.marketplaces"]
            let continueButton = app.buttons["button.primary.continue"]

            XCTAssertTrue(
                marketplaces.waitForExistence(timeout: 3),
                app.debugDescription
            )
            XCTAssertTrue(
                continueButton.waitForExistence(timeout: 3),
                app.debugDescription
            )
            XCTAssertTrue(continueButton.isHittable)
            XCTAssertGreaterThanOrEqual(continueButton.frame.height, 44)
            XCTAssertLessThanOrEqual(continueButton.frame.maxY, window.frame.maxY)

            if !arguments.contains("--dynamic-type=accessibility3") {
                XCTAssertTrue(marketplaces.isHittable)
                XCTAssertLessThanOrEqual(
                    continueButton.frame.minY - marketplaces.frame.maxY,
                    window.frame.height * 0.20,
                    "ONB-06 strands a large dead region above Continue."
                )
                let attachment = XCTAttachment(
                    screenshot: XCUIScreen.main.screenshot()
                )
                attachment.name = "issue-730-ONB-06.png"
                attachment.lifetime = .keepAlways
                add(attachment)
            }

            app.terminate()
        }
    }

    func testPhotoPrimerRowsPublishOneAddressableAccessibilityElementEach() {
        let app = launchOnboarding(state: "ONB-07", cameraStatus: "denied")
        let rows = [
            (
                identifier: "onboarding.primer.camera",
                label: "Camera — take photos from different angles right here."
            ),
            (
                identifier: "onboarding.primer.photo-library",
                label: "Photo library — or pick photos you already took."
            )
        ]

        for row in rows {
            let matchingLabels = app.descendants(matching: .any).matching(
                NSPredicate(format: "label == %@", row.label)
            )
            XCTAssertEqual(
                matchingLabels.count,
                1,
                "Expected one accessibility announcement for \(row.label)\n\(app.debugDescription)"
            )

            let addressableRow = app.descendants(matching: .any)[row.identifier]
            XCTAssertTrue(addressableRow.exists, app.debugDescription)
            XCTAssertEqual(addressableRow.label, row.label)
        }

        let attachment = XCTAttachment(
            screenshot: XCUIScreen.main.screenshot()
        )
        attachment.name = "issue-730-ONB-07.png"
        attachment.lifetime = .keepAlways
        add(attachment)
        let axTree = XCTAttachment(string: app.debugDescription)
        axTree.name = "issue-730-ONB-07-accessibility-tree.txt"
        axTree.lifetime = .keepAlways
        add(axTree)
    }

    func testAllElevenIssue206GoldenStatesRenderAtCanonicalViewport() {
        let requiresCanonicalViewport = ProcessInfo.processInfo.environment[
            "SNAPLIST_REQUIRE_CANONICAL_VIEWPORT"
        ] == "1"
        let processTermination = UIProcessTerminationBoundary()
        let states = [
            "ONB-00",
            "ONB-01",
            "ONB-05",
            "ONB-06",
            "ONB-07",
            "native-camera-permission",
            "ONB-08",
            "settings-handoff",
            "ONB-09-camera",
            "ONB-09-library",
            "returning-sign-in"
        ]

        for state in states {
            var settings: XCUIApplication?
            let status: String? = state == "native-camera-permission" ? nil : "denied"
            let app = launchOnboarding(
                state: state,
                cameraStatus: status,
                extraArguments: ["--reduced-motion"],
                resetCameraAuthorization: state == "native-camera-permission"
            )

            if state == "native-camera-permission" {
                let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
                XCTAssertTrue(
                    app.alerts.firstMatch.waitForExistence(timeout: 3)
                        || springboard.alerts.firstMatch.waitForExistence(timeout: 1),
                    "The native camera authorization prompt did not appear"
                )
            }

            if state == "settings-handoff" {
                let settingsApp = XCUIApplication(bundleIdentifier: "com.apple.Preferences")
                settings = settingsApp
                XCTAssertTrue(
                    settingsApp.wait(
                        for: .runningForeground,
                        timeout: UIProcessLifecycleBudget.transition
                    ),
                    """
                    Settings handoff did not foreground the system Settings \
                    app: waited \
                    \(Int(UIProcessLifecycleBudget.transition))s and still \
                    observed \(settingsApp.state.reportedName)
                    """
                )
                if requiresCanonicalViewport {
                    XCTAssertEqual(settingsApp.windows.firstMatch.frame.size.width, 393)
                    XCTAssertEqual(settingsApp.windows.firstMatch.frame.size.height, 852)
                }
            } else {
                XCTAssertTrue(
                    app.descendants(matching: .any)["onboarding.state.\(state)"].waitForExistence(timeout: 3),
                    "Missing approved onboarding state \(state)"
                )
                if requiresCanonicalViewport {
                    XCTAssertEqual(app.windows.firstMatch.frame.size.width, 393)
                    XCTAssertEqual(app.windows.firstMatch.frame.size.height, 852)
                }
            }

            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = "\(state).png"
            attachment.lifetime = .keepAlways
            add(attachment)

            if state == "native-camera-permission" {
                let alert = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.firstMatch
                let deny = alert.buttons["Don’t Allow"]
                XCTAssertTrue(deny.waitForExistence(timeout: 1))
                deny.tap()
            } else if state == "settings-handoff" {
                XCUIDevice.shared.press(.home)
                if let settings {
                    // A single fixed 3s budget on one expected state lost this
                    // handoff whenever two iOS runs shared the simulator fleet
                    // (#702). Poll Settings' own lifecycle state through the
                    // same seam the termination boundary uses: it returns as
                    // soon as Settings is observed out of the foreground, in
                    // any of the states that means, and the failure names both
                    // the states waited for and the one still observed.
                    XCTAssertTrue(
                        settings.waitUntilSafeToTerminate(
                            timeout: UIProcessLifecycleBudget.transition
                        ),
                        """
                        Settings did not leave the foreground after \
                        settings-handoff: waited \
                        \(Int(UIProcessLifecycleBudget.transition))s \
                        for runningBackground, runningBackgroundSuspended, or \
                        notRunning and still observed \(settings.state.reportedName)
                        """
                    )
                } else {
                    XCTFail("Settings lifecycle proxy was not retained")
                }
            }
            processTermination.assertRetired(app, "SnapList after \(state)")
        }
    }

    private func launch(
        extraArguments: [String] = [],
        orientation: UIDeviceOrientation = .portrait
    ) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--fixture=scan", "--zero-network-fixtures"] + extraArguments
        app.launchAfterRetiringPriorInstance()
        guard orientation == .landscapeLeft || orientation == .landscapeRight else {
            return app
        }

        XCUIDevice.shared.orientation = orientation
        let window = app.windows.firstMatch
        XCTAssertTrue(window.waitForExistence(timeout: 2))
        let orientationPredicate = NSPredicate { _, _ in
            let frame = window.frame
            return frame.width > frame.height
        }
        XCTAssertEqual(
            XCTWaiter.wait(
                for: [XCTNSPredicateExpectation(predicate: orientationPredicate, object: nil)],
                timeout: 2
            ),
            .completed
        )
        return app
    }

    private func activationGuidance(in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)["activation-guidance"]
    }

    private func assertPhotoReviewThumbnailCatalog(
        _ app: XCUIApplication,
        state: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let expected: [(label: String, isSelected: Bool)]
        switch state {
        case "REV-01":
            expected = [(
                "Photo 1 of 1, Cover, selected. Actions: Replace, Delete.",
                true
            )]
        case "REV-02", "REV-04":
            expected = [
                (
                    "Photo 1 of 3, Cover. Actions: Replace, Delete, Move later.",
                    false
                ),
                (
                    "Photo 2 of 3, selected. Actions: Replace, Delete, Move earlier, Move later, Make cover.",
                    true
                ),
                (
                    "Photo 3 of 3. Actions: Replace, Delete, Move earlier, Make cover.",
                    false
                )
            ]
        case "REV-03":
            expected = [
                (
                    "Photo 1 of 5, Cover, selected. Actions: Replace, Delete, Move later.",
                    true
                ),
                (
                    "Photo 2 of 5. Actions: Replace, Delete, Move earlier, Move later, Make cover.",
                    false
                ),
                (
                    "Photo 3 of 5. Actions: Replace, Delete, Move earlier, Move later, Make cover.",
                    false
                ),
                (
                    "Photo 4 of 5. Actions: Replace, Delete, Move earlier, Move later, Make cover.",
                    false
                ),
                (
                    "Photo 5 of 5. Actions: Replace, Delete, Move earlier, Make cover.",
                    false
                )
            ]
        default:
            XCTFail("Unknown Photo Review catalog state \(state).", file: file, line: line)
            return
        }

        for (offset, entry) in expected.enumerated() {
            let thumbnail = app.buttons[
                "photo-review.thumbnail.\(offset + 1)"
            ]
            XCTAssertTrue(thumbnail.exists, "\(state) photo \(offset + 1)", file: file, line: line)
            XCTAssertEqual(thumbnail.label, entry.label, file: file, line: line)
            XCTAssertEqual(
                thumbnail.isSelected,
                entry.isSelected,
                file: file,
                line: line
            )
        }
    }

    private func launchOnboarding(
        state: String,
        cameraStatus: String? = nil,
        extraArguments: [String] = [],
        resetCameraAuthorization: Bool = false
    ) -> XCUIApplication {
        let app = XCUIApplication()
        var arguments = [
            "--fixture=onboarding",
            "--zero-network-fixtures",
            "--visual-state=\(state)"
        ] + extraArguments
        if let cameraStatus {
            arguments.append("--camera-status=\(cameraStatus)")
        }
        app.launchArguments = arguments
        if resetCameraAuthorization {
            app.resetAuthorizationStatus(for: .camera)
        }
        app.launchAfterRetiringPriorInstance()
        return app
    }

    private func launchFirstValueOnboarding(
        resetProgress: Bool,
        extraArguments: [String] = []
    ) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "--fixture=onboarding",
            "--zero-network-fixtures",
            "--camera-status=authorized"
        ] + (resetProgress ? ["--reset-onboarding-progress"] : []) + extraArguments
        app.launchAfterRetiringPriorInstance()
        return app
    }

    private func advanceFirstValueOnboarding(
        to destination: String,
        in app: XCUIApplication
    ) {
        for screen in firstValueOnboardingStates {
            XCTAssertTrue(
                app.descendants(matching: .any)[
                    "first-value-onboarding.state.\(screen)"
                ].waitForExistence(timeout: 3)
            )
            if screen == destination { return }
            app.buttons["first-value-onboarding.continue"].tap()
        }
    }

    private var firstValueOnboardingStates: [String] {
        ["ONB-01", "ONB-02", "ONB-03", "ONB-04", "ONB-05", "ONB-06"]
    }

    private func launchVoiceNoteFixture(
        _ fixtureArgument: String,
        expectedControl: String = "voice-note.close"
    ) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "--restored-capture-fixture",
            fixtureArgument
        ]
        app.launchAfterRetiringPriorInstance()

        let review = app.buttons["scan.review"]
        XCTAssertTrue(review.waitForExistence(timeout: 3))
        review.tap()

        let voice = app.buttons["photo-review.voice"]
        XCTAssertTrue(voice.waitForExistence(timeout: 3))
        voice.tap()
        XCTAssertTrue(
            app.buttons[expectedControl].waitForExistence(timeout: 2)
        )
        return app
    }

    private func attemptVoiceNoteSwipeDismiss(
        in app: XCUIApplication
    ) {
        let sheetTitle = app.staticTexts["voice-note.title"]
        XCTAssertTrue(sheetTitle.exists)
        let destination = app.windows.firstMatch.coordinate(
            withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98)
        )
        sheetTitle.coordinate(
            withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)
        ).press(
            forDuration: 0.05,
            thenDragTo: destination,
            withVelocity: 1_000,
            thenHoldForDuration: 0
        )
    }

    /// #883: a momentum-free horizontal drag across `element`. `swipeLeft()`
    /// synthesizes a velocity flick that the hero's `DragGesture` inside the
    /// review's vertical scroll view does not see; a pressed drag does, and it
    /// mirrors `ListingReviewUITests.scrollUntilClearOfFooter`, which exists for
    /// the same class of problem.
    private func dragHorizontally(
        _ element: XCUIElement,
        towardsLeading: Bool
    ) {
        let startX = towardsLeading ? 0.85 : 0.15
        let endX = towardsLeading ? 0.15 : 0.85
        let start = element.coordinate(
            withNormalizedOffset: CGVector(dx: startX, dy: 0.5)
        )
        let end = element.coordinate(
            withNormalizedOffset: CGVector(dx: endX, dy: 0.5)
        )
        // The velocity-and-hold overload is the one that interpolates
        // intermediate touch points. `swipeLeft()` and the two-point
        // `press(forDuration:thenDragTo:)` both deliver a jump the hero's
        // `DragGesture` never sees as movement.
        start.press(
            forDuration: 0.05,
            thenDragTo: end,
            withVelocity: .default,
            thenHoldForDuration: 0.05
        )
    }

    private func waitFor(
        _ element: XCUIElement,
        toSatisfy format: String,
        _ message: String,
        timeout: TimeInterval = 3,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: format),
            object: element
        )
        XCTAssertEqual(
            XCTWaiter().wait(for: [expectation], timeout: timeout),
            .completed,
            message,
            file: file,
            line: line
        )
    }

    private func addScreenshot(named name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
