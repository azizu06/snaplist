import XCTest

final class SnapListUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testPrimaryShellNavigationAndTypedDestinations() {
        let app = launch()

        XCTAssertTrue(app.staticTexts["Home"].exists)
        XCTAssertTrue(app.buttons["dock.home"].isSelected)

        app.buttons["dock.listings"].tap()
        XCTAssertTrue(app.staticTexts["Listings"].waitForExistence(timeout: 2))

        app.buttons["dock.inbox"].tap()
        XCTAssertTrue(app.staticTexts["Inbox"].waitForExistence(timeout: 2))

        app.buttons["dock.insights"].tap()
        XCTAssertTrue(app.staticTexts["Insights"].waitForExistence(timeout: 2))

        XCTAssertFalse(app.buttons["Runs"].exists)
        XCTAssertFalse(app.buttons["You"].exists)
    }

    func testCapturePresentsAndDismissesAnItemDrivenSheet() {
        let app = launch()

        app.buttons["dock.capture"].tap()
        XCTAssertTrue(app.staticTexts["sheet.capture.title"].waitForExistence(timeout: 2))
        app.buttons["capture.close"].tap()
        XCTAssertFalse(app.staticTexts["sheet.capture.title"].waitForExistence(timeout: 1))
        XCTAssertTrue(app.staticTexts["Home"].exists)
    }

    func testHeaderRoutesHaveVoiceOverLabelsAndFortyFourPointTargets() {
        let app = launch()
        let activity = app.buttons["header.activity"]
        let account = app.buttons["header.account"]
        let capture = app.buttons["dock.capture"]

        for control in [activity, account, capture] {
            XCTAssertTrue(control.exists)
            XCTAssertGreaterThanOrEqual(control.frame.width, 44)
            XCTAssertGreaterThanOrEqual(control.frame.height, 44)
        }

        XCTAssertEqual(activity.label, "Open activity")
        XCTAssertEqual(account.label, "Open account and settings")
        XCTAssertEqual(capture.label, "Capture a new item")

        activity.tap()
        XCTAssertTrue(app.staticTexts["route.activity.title"].waitForExistence(timeout: 2))
    }

    func testKeyboardHidesTheFloatingDock() {
        let app = launch(extraArguments: ["--keyboard-probe"])
        let probe = app.textFields["fixture.keyboard-probe"]

        probe.tap()

        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 2))
        XCTAssertFalse(app.buttons["dock.home"].exists)
    }

    func testAccessibilityDynamicTypeKeepsFoundationControlsReachable() {
        let app = launch(extraArguments: ["--dynamic-type=accessibility3"])

        XCTAssertTrue(app.staticTexts["Home"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.buttons["header.activity"].exists)
        XCTAssertTrue(app.buttons["header.account"].exists)
        XCTAssertTrue(app.buttons["dock.capture"].exists)
    }

    func testFloatingDockRespectsTheBottomSafeArea() {
        let app = launch()
        let window = app.windows.firstMatch
        let capture = app.buttons["dock.capture"]

        XCTAssertTrue(window.exists)
        XCTAssertTrue(capture.exists)
        XCTAssertGreaterThan(window.frame.maxY - capture.frame.maxY, 8)
    }

    func testApprovedVisualStateLaunchArgumentUsesTypedBoundary() {
        let app = launch(extraArguments: ["--visual-state=RUN-01"])

        XCTAssertTrue(app.otherElements["visual-state.RUN-01"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.staticTexts["RUN-01"].exists)
        XCTAssertTrue(app.staticTexts["Rendering boundary reserved for issue #211."].exists)
    }

    func testAccountlessFirstValueJourneyEndsAtCAP01Boundary() {
        let app = launchOnboarding(
            state: "ONB-01",
            cameraStatus: "authorized"
        )

        app.buttons["onboarding.sign-in"].tap()
        XCTAssertTrue(app.staticTexts["Welcome back"].waitForExistence(timeout: 2))
        app.buttons["onboarding.sheet.close"].tap()
        XCTAssertTrue(app.buttons["onboarding.sign-in"].waitForExistence(timeout: 2))

        app.buttons["button.primary.start-with-one-item"].tap()
        XCTAssertTrue(app.staticTexts["Your first item is on us"].waitForExistence(timeout: 2))

        app.buttons["onboarding.marketplaces"].tap()
        XCTAssertTrue(app.staticTexts["Where can I list?"].waitForExistence(timeout: 2))
        app.buttons["button.primary.got-it"].tap()

        app.buttons["button.primary.continue"].tap()
        XCTAssertTrue(app.staticTexts["Let's photograph your item"].waitForExistence(timeout: 2))
        app.buttons["button.primary.use-camera"].tap()
        XCTAssertTrue(app.staticTexts["Ready to capture"].waitForExistence(timeout: 2))

        app.buttons["button.primary.continue-to-capture"].tap()
        XCTAssertTrue(app.staticTexts["CAP-01"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.staticTexts["Capture entry boundary"].exists)
        XCTAssertFalse(app.staticTexts["Photo Review"].exists)
        XCTAssertFalse(app.staticTexts["Create account"].exists)
        XCTAssertFalse(app.staticTexts["SnapList Pro"].exists)
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

    func testStagedLibraryPhotosSurviveInterruptionAndReachCAP01() {
        let app = XCUIApplication()
        defer {
            app.terminate()
            let cleanup = XCUIApplication()
            cleanup.launchArguments = [
                "--fixture=onboarding",
                "--reset-onboarding-progress"
            ]
            cleanup.launch()
            cleanup.terminate()
        }

        app.launchArguments = [
            "--fixture=onboarding",
            "--camera-status=denied",
            "--reset-onboarding-progress",
            "--fixture-staged-library-photos=2"
        ]
        app.launch()
        XCTAssertTrue(app.staticTexts["Photos ready"].waitForExistence(timeout: 3))

        app.terminate()
        app.launchArguments = [
            "--fixture=onboarding",
            "--camera-status=denied"
        ]
        app.launch()

        XCTAssertTrue(app.staticTexts["Photos ready"].waitForExistence(timeout: 3))
        app.buttons["button.primary.continue-to-capture"].tap()
        XCTAssertTrue(app.staticTexts["CAP-01"].waitForExistence(timeout: 2))
        XCTAssertTrue(
            app.staticTexts["2 library photo selection(s) staged for issue #207."].exists
        )
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

    func testAllElevenIssue206GoldenStatesRenderAtCanonicalViewport() {
        let requiresCanonicalViewport = ProcessInfo.processInfo.environment[
            "SNAPLIST_REQUIRE_CANONICAL_VIEWPORT"
        ] == "1"
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
                let settings = XCUIApplication(bundleIdentifier: "com.apple.Preferences")
                XCTAssertTrue(
                    settings.wait(for: .runningForeground, timeout: 3),
                    "Settings handoff did not foreground the system Settings app"
                )
                if requiresCanonicalViewport {
                    XCTAssertEqual(settings.windows.firstMatch.frame.size.width, 393)
                    XCTAssertEqual(settings.windows.firstMatch.frame.size.height, 852)
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
                XCUIApplication(bundleIdentifier: "com.apple.Preferences").terminate()
            }
            app.terminate()
        }
    }

    private func launch(extraArguments: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--fixture=home", "--zero-network-fixtures"] + extraArguments
        app.launch()
        return app
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
        app.launch()
        return app
    }
}
