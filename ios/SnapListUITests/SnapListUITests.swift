import CoreFoundation
import XCTest
import UIKit

final class SnapListUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
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

    func testCapturePresentsAndDismissesAnItemDrivenSheet() {
        let app = launchCaptureLauncherSheet()

        for control in [
            app.buttons["capture.close"],
            app.buttons["capture.take-one-item"],
            app.buttons["capture.choose-library"]
        ] {
            XCTAssertTrue(control.exists)
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
        }

        app.buttons["capture.close"].tap()
        XCTAssertFalse(app.staticTexts["sheet.capture.title"].waitForExistence(timeout: 1))
    }

    func testTakeOneItemUsesTheNativeCameraRecoveryAndKeepsLibraryEscapeReachable() {
        let app = launchCaptureLauncherSheet()

        XCTAssertTrue(app.buttons["capture.take-one-item"].waitForExistence(timeout: 2))
        app.buttons["capture.take-one-item"].tap()

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

        let resume = app.buttons["button.primary.resume-captured-photo"]
        XCTAssertTrue(resume.waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["capture.take-one-item"].exists)
        XCTAssertFalse(app.buttons["capture.choose-library"].exists)
        XCTAssertGreaterThanOrEqual(resume.frame.width, 44)
        XCTAssertGreaterThanOrEqual(resume.frame.height, 44)
        resume.tap()

        let photoCount = app.staticTexts["scan.photo-count"]
        XCTAssertTrue(photoCount.waitForExistence(timeout: 3))
        XCTAssertEqual(
            app.staticTexts.matching(identifier: "scan.photo-count").count,
            1,
            app.debugDescription
        )
        XCTAssertEqual(photoCount.label, "1 of 5")
        XCTAssertFalse(app.staticTexts["sheet.capture.title"].exists)
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

        let resume = app.buttons["button.primary.resume-captured-photo"]
        XCTAssertTrue(resume.waitForExistence(timeout: 3))
        resume.tap()

        let scanCount = app.staticTexts["scan.photo-count"]
        XCTAssertTrue(scanCount.waitForExistence(timeout: 3))
        XCTAssertEqual(app.staticTexts.matching(identifier: "scan.photo-count").count, 1)
        XCTAssertEqual(scanCount.label, "1 of 5")

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

        let resume = app.buttons["button.primary.resume-captured-photo"]
        XCTAssertTrue(resume.waitForExistence(timeout: 3))
        resume.tap()

        let initialCount = app.staticTexts["scan.photo-count"]
        XCTAssertTrue(initialCount.waitForExistence(timeout: 3))
        XCTAssertEqual(initialCount.label, "1 of 5")

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
        let returnedCount = app.staticTexts["scan.photo-count"]
        XCTAssertTrue(
            returnedReview.waitForExistence(timeout: 3),
            "Back must return the seller to Scan with the Review opener intact."
        )
        XCTAssertFalse(screen.waitForExistence(timeout: 2))

        XCTAssertTrue(returnedCount.waitForExistence(timeout: 3))
        XCTAssertEqual(returnedCount.label, "1 of 5")

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

        let resume = app.buttons["button.primary.resume-captured-photo"]
        XCTAssertTrue(resume.waitForExistence(timeout: 3))
        resume.tap()

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

        let resume = app.buttons["button.primary.resume-captured-photo"]
        XCTAssertTrue(resume.waitForExistence(timeout: 3))
        resume.tap()

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
                startListing.exists && startListing.label == "Item saved"
            },
            object: startListing
        )
        XCTAssertEqual(
            XCTWaiter.wait(for: [saved], timeout: 3),
            .completed,
            "Start listing control must reach the submission boundary."
        )
    }

    func testVoiceNoteRecordingAccessibilityOrderIsCancelElapsedSave() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--restored-capture-fixture",
            "--voice-note-take-ready-fixture"
        ]
        app.launchAfterRetiringPriorInstance()

        let resume = app.buttons["button.primary.resume-captured-photo"]
        XCTAssertTrue(resume.waitForExistence(timeout: 3))
        resume.tap()

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
        XCTAssertEqual(playback.label, "Pause voice note")

        attemptVoiceNoteSwipeDismiss(in: saved)

        XCTAssertTrue(savedClose.exists)
        XCTAssertEqual(playback.label, "Pause voice note")

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

    func testLivePhotoReviewShowsBoundedSavingStateDuringZeroNetworkSubmission() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--restored-capture-fixture",
            "--submission-fixture=delayed"
        ]
        app.launchAfterRetiringPriorInstance()

        let resume = app.buttons["button.primary.resume-captured-photo"]
        XCTAssertTrue(resume.waitForExistence(timeout: 3))
        resume.tap()

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
                startListing.label == "Saving your item"
                    && !startListing.isEnabled
                    && !addPhoto.isEnabled
            },
            object: startListing
        )
        XCTAssertEqual(
            XCTWaiter.wait(for: [saving], timeout: 8),
            .completed,
            "The real Photo Review must expose the bounded saving label and mutation lock."
        )

        let completed = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in
                startListing.label == "Start listing"
                    && startListing.isEnabled
                    && addPhoto.isEnabled
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

        let resume = app.buttons["button.primary.resume-captured-photo"]
        XCTAssertTrue(resume.waitForExistence(timeout: 3))
        resume.tap()

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

        let resume = app.buttons["button.primary.resume-captured-photo"]
        XCTAssertTrue(resume.waitForExistence(timeout: 3))
        resume.tap()

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
                startListing.exists && startListing.label == "Item saved"
            },
            object: startListing
        )
        XCTAssertEqual(
            XCTWaiter.wait(for: [saved], timeout: 3),
            .completed,
            "The real accepted host must render Item saved before exact clear."
        )

        XCTAssertTrue(screen.exists)
        XCTAssertFalse(startListing.isEnabled)
        XCTAssertFalse(hero.exists)
        XCTAssertFalse(thumbnail.exists)
        XCTAssertFalse(addPhoto.exists)
        XCTAssertFalse(app.buttons["scan.library"].exists)
        XCTAssertFalse(app.buttons["scan.choose-library"].exists)

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
        XCTAssertFalse(app.staticTexts["scan.photo-count"].exists)

        if liveLibrary.exists {
            XCTAssertEqual(liveLibrary.label, "Library")
            XCTAssertTrue(liveLibrary.isEnabled)
        } else {
            XCTAssertEqual(recoveryLibrary.label, "Choose from library")
            XCTAssertTrue(recoveryLibrary.isEnabled)
        }

        XCTAssertTrue(app.buttons["dock.scan"].isSelected)
        XCTAssertFalse(app.buttons["dock.trophy-wall"].isSelected)
        XCTAssertFalse(app.staticTexts["Listing Review"].exists)
        XCTAssertFalse(app.buttons["Cancel"].exists)
        // Announcement delivery remains the direct B1 effect-consumer contract.
        // Accessibility focus remains the direct B2 mounted-Library contract.
    }

    // v1.2 primary_action.position is a sticky bottom action above the home-indicator
    // safe area, and its adaptive-layout contract says that action never covers the
    // thumbnails, Voice note, or the home indicator. The hero and thumbnail strip are
    // fixed, so text is the only thing that lengthens this page; the largest Dynamic Type
    // is what puts the content decisively past the viewport, which is what makes the
    // scroll below real rather than a rubber-band that settles back to its start.
    func testLivePhotoReviewKeepsStartListingStickyBelowTheScrollingReviewContent() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--restored-capture-fixture",
            "--dynamic-type=accessibility5"
        ]
        app.launchAfterRetiringPriorInstance()

        let resume = app.buttons["button.primary.resume-captured-photo"]
        XCTAssertTrue(resume.waitForExistence(timeout: 5))
        resume.tap()

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

        // Behavioural truth: the content scrolls under it and the action does not move.
        let voiceBefore = screen.buttons["photo-review.voice"].frame
        let stickyBefore = startListing.frame
        screen.swipeUp()

        XCTAssertNotEqual(
            screen.buttons["photo-review.voice"].frame.minY,
            voiceBefore.minY,
            "The review content must actually scroll for this to prove anything."
        )
        XCTAssertEqual(
            startListing.frame.minY,
            stickyBefore.minY,
            accuracy: 0.5,
            "Start listing must stay pinned while the content scrolls."
        )

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

        let resume = app.buttons["button.primary.resume-captured-photo"]
        XCTAssertTrue(resume.waitForExistence(timeout: 3))
        resume.tap()

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
            app.staticTexts["scan.photo-count"].exists,
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

            let resume = app.buttons["button.primary.resume-captured-photo"]
            XCTAssertTrue(resume.waitForExistence(timeout: 5), typeSize)
            resume.tap()

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

    func testCaptureVisualStatesExposeTheApprovedNonCandidateBoundary() {
        let expectedTextByState = [
            ("CAP-01", "Add an item"),
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

        for identifier in [
            "scan.flash", "scan.library", "scan.shutter", "dock.scan", "dock.trophy-wall"
        ] {
            XCTAssertTrue(zero.buttons[identifier].waitForExistence(timeout: 2), identifier)
        }
        XCTAssertFalse(zero.buttons["scan.review"].exists)
        XCTAssertFalse(zero.staticTexts["scan.photo-count"].exists)
        zero.terminate()

        let capped = launch(extraArguments: ["--visual-state=CAM-04"])
        XCTAssertTrue(capped.staticTexts["scan.photo-count"].waitForExistence(timeout: 2))
        XCTAssertEqual(capped.staticTexts["scan.photo-count"].label, "5 of 5")
        XCTAssertTrue(capped.buttons["scan.review"].exists)
        XCTAssertFalse(capped.buttons["scan.shutter"].isEnabled)
        XCTAssertFalse(capped.buttons["scan.library"].isEnabled)
        XCTAssertEqual(capped.buttons["scan.library"].label, "Library")
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

    func testPhotoReviewREV02UsesLive300PointHeroAt402x874() {
        let app = launch(extraArguments: ["--photo-review-state=REV-02"])
        let window = app.windows.firstMatch
        let hero = app.buttons["photo-review.hero"]

        XCTAssertTrue(window.waitForExistence(timeout: 3))
        XCTAssertEqual(window.frame.size.width, 402, accuracy: 0.5)
        XCTAssertEqual(window.frame.size.height, 874, accuracy: 0.5)
        XCTAssertTrue(hero.waitForExistence(timeout: 3))
        XCTAssertEqual(
            hero.frame.height,
            300,
            accuracy: 1,
            "Live Photo Review v5 fixes the hero at 300 points."
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

        for control in [
            app.buttons["scan.flash"],
            app.buttons["scan.library"],
            app.buttons["scan.shutter"],
            app.buttons["scan.review"],
            app.buttons["dock.scan"],
            app.buttons["dock.trophy-wall"]
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

    // Scan Camera v2 (outer SHA-256 62d8f0c97c97ac68fdf0072444429a02ccadea1335bf7436f60b5ffa414bc49c)
    // pairs Flash and Library as matched 48x48 frosted circles. The superseded v1 package
    // stated both 44x44 and 48x48, which is how the smaller value shipped. Pin the size so a
    // later package or refactor cannot quietly take the 44pt accessibility floor again.
    func testScanCameraFlashControlMatchesTheApprovedFortyEightPointCircle() {
        let app = launch(extraArguments: ["--visual-state=CAM-03"])
        let flash = app.buttons["scan.flash"]

        XCTAssertTrue(flash.waitForExistence(timeout: 2))
        XCTAssertEqual(flash.frame.width, 48, accuracy: 0.5)
        XCTAssertEqual(flash.frame.height, 48, accuracy: 0.5)
    }

    func testCaptureLauncherSurvivesAccessibilityTypeAndReducedMotion() {
        let app = launch(extraArguments: [
            "--visual-state=CAP-01",
            "--dynamic-type=accessibility3",
            "--reduce-motion"
        ])

        XCTAssertTrue(app.staticTexts["Add an item"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.staticTexts["Choose from library"].exists)
        XCTAssertGreaterThan(app.staticTexts["Choose from library"].frame.maxY, 0)
        XCTAssertLessThan(app.staticTexts["Choose from library"].frame.maxY, app.windows.firstMatch.frame.maxY)
        addScreenshot(named: "CAP-01-AX3-REDUCED-MOTION.png")
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
        XCTAssertTrue(app.staticTexts["$9.99 / month"].exists)

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
        XCTAssertTrue(app.staticTexts["$9.99 / month"].exists)
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

    func testFreshAccountlessJourneyEntersTheRealCaptureFlow() {
        let app = launchFirstValueOnboarding(resetProgress: true)
        advanceFirstValueOnboarding(to: "ONB-06", in: app)

        app.buttons["first-value-onboarding.sign-in"].tap()
        XCTAssertTrue(app.staticTexts["Welcome back"].waitForExistence(timeout: 2))
        app.buttons["onboarding.sheet.close"].tap()
        XCTAssertTrue(
            app.buttons["first-value-onboarding.start-scanning"]
                .waitForExistence(timeout: 2)
        )

        app.buttons["first-value-onboarding.start-scanning"].tap()
        XCTAssertTrue(app.staticTexts["Let's photograph your item"].waitForExistence(timeout: 2))
        app.buttons["onboarding.back"].tap()
        XCTAssertTrue(app.staticTexts["Let's photograph your item"].waitForExistence(timeout: 2))
        XCTAssertFalse(app.staticTexts["Your first item is on us"].exists)
        app.buttons["button.primary.use-camera"].tap()
        XCTAssertTrue(app.staticTexts["Ready to capture"].waitForExistence(timeout: 2))

        app.buttons["button.primary.continue-to-capture"].tap()
        XCTAssertTrue(app.staticTexts["sheet.capture.title"].waitForExistence(timeout: 3))
        let scanDock = app.buttons["dock.scan"]
        XCTAssertTrue(scanDock.exists)
        XCTAssertTrue(scanDock.isSelected)
        XCTAssertEqual(scanDock.label, "Scan")
        XCTAssertTrue(app.buttons["capture.take-one-item"].exists)
        XCTAssertTrue(app.buttons["capture.choose-library"].exists)
        XCTAssertFalse(app.staticTexts["Capture entry boundary"].exists)
        XCTAssertFalse(app.otherElements["boundary.CAP-01"].exists)
        XCTAssertFalse(app.staticTexts["Photo Review"].exists)
        XCTAssertFalse(app.staticTexts["Create account"].exists)
        XCTAssertFalse(app.staticTexts["SnapList Pro"].exists)

        app.buttons["capture.take-one-item"].tap()
        XCTAssertTrue(app.staticTexts["Camera is not available"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["scan.choose-library"].exists)
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

        let useCamera = app.buttons["button.primary.use-camera"]
        XCTAssertTrue(useCamera.waitForExistence(timeout: 2))
        useCamera.tap()
        let continueToCapture = app.buttons["button.primary.continue-to-capture"]
        XCTAssertTrue(continueToCapture.waitForExistence(timeout: 2))
        continueToCapture.tap()

        XCTAssertTrue(app.staticTexts["sheet.capture.title"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["capture.take-one-item"].exists)
        XCTAssertTrue(app.buttons["capture.choose-library"].exists)
        XCTAssertTrue(activationGuidance(in: app).waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["One item, up to five photos."].exists)

        app.buttons["capture.take-one-item"].tap()
        XCTAssertTrue(app.staticTexts["Camera is not available"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["scan.choose-library"].exists)
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

    func testFirstValueOnboardingSkipMarksComplete() {
        let app = launchFirstValueOnboarding(resetProgress: true)

        XCTAssertTrue(app.buttons["first-value-onboarding.skip"].waitForExistence(timeout: 3))
        app.buttons["first-value-onboarding.skip"].tap()

        XCTAssertTrue(app.staticTexts["Let's photograph your item"].waitForExistence(timeout: 3))
        XCTAssertFalse(
            app.descendants(matching: .any)["first-value-onboarding.state.ONB-01"].exists
        )
    }

    func testFirstValueOnboardingRelaunchDoesNotRepresent() {
        let app = launchFirstValueOnboarding(resetProgress: true)
        XCTAssertTrue(app.buttons["first-value-onboarding.skip"].waitForExistence(timeout: 3))
        app.buttons["first-value-onboarding.skip"].tap()
        XCTAssertTrue(app.staticTexts["Let's photograph your item"].waitForExistence(timeout: 3))

        app.terminate()
        app.launchArguments = [
            "--fixture=onboarding",
            "--zero-network-fixtures",
            "--camera-status=authorized"
        ]
        app.launchAfterRetiringPriorInstance()

        XCTAssertTrue(app.staticTexts["Let's photograph your item"].waitForExistence(timeout: 3))
        XCTAssertFalse(
            app.descendants(matching: .any)["first-value-onboarding.state.ONB-01"].exists
        )
    }

    func testFirstValueOnboardingONB06HasExactlyTwoControls() {
        let app = launchFirstValueOnboarding(resetProgress: true)
        advanceFirstValueOnboarding(to: "ONB-06", in: app)
        let screen = app.descendants(matching: .any)[
            "first-value-onboarding.state.ONB-06"
        ]

        XCTAssertTrue(screen.waitForExistence(timeout: 3))
        XCTAssertEqual(screen.descendants(matching: .button).count, 2, app.debugDescription)
        XCTAssertTrue(app.buttons["first-value-onboarding.start-scanning"].exists)
        XCTAssertTrue(app.buttons["first-value-onboarding.sign-in"].exists)
        XCTAssertFalse(app.buttons["first-value-onboarding.skip"].exists)
        XCTAssertFalse(app.buttons["first-value-onboarding.back"].exists)
    }

    /// ONB-05 illustrates the Trophy Wall. No item exists during onboarding, so the
    /// screen must be labelled an example and must expose no spinner or other affordance
    /// that would claim work is running.
    ///
    /// The indicator counts below only reach affordances that surface as their own
    /// accessibility elements. Each example row ends in
    /// `.accessibilityElement(children: .combine)`, so a spinner inside a row is folded
    /// away and cannot be counted here;
    /// `OnboardingFlowTests.testBackgroundExampleRowBodyWritesNoProgressAffordance` reads the
    /// row's rendered type and carries that half of the guarantee.
    func testFirstValueOnboardingONB05IllustratesWithoutClaimingLiveProgress() {
        let app = launchFirstValueOnboarding(resetProgress: true)
        advanceFirstValueOnboarding(to: "ONB-05", in: app)
        let screen = app.descendants(matching: .any)[
            "first-value-onboarding.state.ONB-05"
        ]

        XCTAssertTrue(screen.waitForExistence(timeout: 3))
        XCTAssertTrue(
            app.staticTexts["An example — nothing is running yet"].exists,
            app.debugDescription
        )
        XCTAssertEqual(app.activityIndicators.count, 0, app.debugDescription)
        XCTAssertEqual(app.progressIndicators.count, 0, app.debugDescription)
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

        let resume = app.buttons["button.primary.resume-captured-photo"]
        XCTAssertTrue(resume.waitForExistence(timeout: 5), app.debugDescription)
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
            extraArguments: ["--dynamic-type=accessibility3", "--reduced-motion"]
        )
        let window = app.windows.firstMatch

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
            XCTAssertTrue(primary.isHittable)
            XCTAssertGreaterThanOrEqual(primary.frame.height, 44)
            XCTAssertGreaterThanOrEqual(primary.frame.minX, window.frame.minX)
            XCTAssertLessThanOrEqual(primary.frame.maxX, window.frame.maxX)
            XCTAssertLessThanOrEqual(primary.frame.maxY, window.frame.maxY)
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

    func testStagedLibraryPhotosSurviveInterruptionAndReachCAP01() {
        let app = XCUIApplication()
        defer {
            app.terminate()
            let cleanup = XCUIApplication()
            cleanup.launchArguments = [
                "--fixture=onboarding",
                "--reset-onboarding-progress"
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
        XCTAssertTrue(app.staticTexts["sheet.capture.title"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["capture.take-one-item"].exists)
        XCTAssertTrue(app.buttons["capture.choose-library"].exists)
        XCTAssertFalse(app.staticTexts["Capture entry boundary"].exists)
        XCTAssertFalse(app.otherElements["boundary.CAP-01"].exists)
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

    /// The dock's third affordance used to open the capture launcher. It was
    /// removed with the retired seller-operations dock, so the launcher is
    /// entered here through the onboarding capture boundary the product ships.
    private func launchCaptureLauncherSheet(
        extraArguments: [String] = []
    ) -> XCUIApplication {
        let app = launchFirstValueOnboarding(
            resetProgress: true,
            extraArguments: extraArguments
        )
        advanceFirstValueOnboarding(to: "ONB-06", in: app)

        app.buttons["first-value-onboarding.start-scanning"].tap()
        XCTAssertTrue(
            app.staticTexts["Let's photograph your item"].waitForExistence(timeout: 3)
        )
        app.buttons["button.primary.use-camera"].tap()
        XCTAssertTrue(app.staticTexts["Ready to capture"].waitForExistence(timeout: 3))
        app.buttons["button.primary.continue-to-capture"].tap()
        XCTAssertTrue(
            app.staticTexts["sheet.capture.title"].waitForExistence(timeout: 3)
        )
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
        _ fixtureArgument: String
    ) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "--restored-capture-fixture",
            fixtureArgument
        ]
        app.launchAfterRetiringPriorInstance()

        let resume = app.buttons["button.primary.resume-captured-photo"]
        XCTAssertTrue(resume.waitForExistence(timeout: 3))
        resume.tap()

        let review = app.buttons["scan.review"]
        XCTAssertTrue(review.waitForExistence(timeout: 3))
        review.tap()

        let voice = app.buttons["photo-review.voice"]
        XCTAssertTrue(voice.waitForExistence(timeout: 3))
        voice.tap()
        XCTAssertTrue(
            app.buttons["voice-note.close"].waitForExistence(timeout: 2)
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

    private func addScreenshot(named name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
