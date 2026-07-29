import CoreFoundation
import XCTest
import UIKit

final class SnapListUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
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

        XCTAssertTrue(app.staticTexts["Home"].exists)
        app.buttons["dock.capture"].tap()
        XCTAssertTrue(app.staticTexts["sheet.capture.title"].waitForExistence(timeout: 2))

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
        XCTAssertTrue(app.staticTexts["Home"].exists)
    }

    func testTakeOneItemUsesTheNativeCameraRecoveryAndKeepsLibraryEscapeReachable() {
        let app = launch()

        app.buttons["dock.capture"].tap()
        XCTAssertTrue(app.buttons["capture.take-one-item"].waitForExistence(timeout: 2))
        app.buttons["capture.take-one-item"].tap()

        XCTAssertTrue(app.staticTexts["Camera is not available"].waitForExistence(timeout: 3))
        addScreenshot(named: "CAPTURE-CAMERA-UNAVAILABLE.png")
        let library = app.buttons["scan.choose-library"]
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
        app.launch()

        let resume = app.buttons["button.primary.resume-captured-photo"]
        XCTAssertTrue(resume.waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["capture.take-one-item"].exists)
        XCTAssertFalse(app.buttons["capture.choose-library"].exists)
        XCTAssertGreaterThanOrEqual(resume.frame.width, 44)
        XCTAssertGreaterThanOrEqual(resume.frame.height, 44)
        resume.tap()

        let photoCount = app.staticTexts["scan.photo-count"]
        XCTAssertTrue(photoCount.waitForExistence(timeout: 3))
        XCTAssertEqual(photoCount.label, "1 of 5")
        XCTAssertFalse(app.staticTexts["sheet.capture.title"].exists)
        addScreenshot(named: "CAPTURE-RESTORED-DRAFT.png")

        let reviewButton = app.buttons["scan.review"]
        let window = app.windows.firstMatch.frame
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
        app.launch()

        let resume = app.buttons["button.primary.resume-captured-photo"]
        XCTAssertTrue(resume.waitForExistence(timeout: 3))
        resume.tap()

        let scanCount = app.staticTexts["scan.photo-count"]
        XCTAssertTrue(scanCount.waitForExistence(timeout: 3))
        XCTAssertEqual(scanCount.label, "1 of 5")

        let review = app.buttons["scan.review"]
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
        XCTAssertFalse(app.staticTexts["Home"].exists)
    }

    func testLivePhotoReviewBackReturnsExactRestoredPhotoAndFocusesScanReview() {
        let app = XCUIApplication()
        app.launchArguments = ["--restored-capture-fixture"]
        app.launch()

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
        // Review-opener focus restoration is an accessibility-cursor contract, which
        // XCUITest cannot observe without an assistive technology running. It is proved
        // directly by ScanReturnFocusPolicy and by the router-seam return assertions.
    }

    func testLivePhotoReviewVoiceAndStartListingStayTypedBoundariesOverIntake() {
        let app = XCUIApplication()
        app.launchArguments = ["--restored-capture-fixture"]
        app.launch()

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
        // The exact live-source Voice Note v2.1 package controls the visible helper
        // and the optional collapsed semantics.
        XCTAssertEqual(voice.label, "Voice note, optional, collapsed")
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

    func testVoiceNoteRecordingAccessibilityOrderIsCancelElapsedSave() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--restored-capture-fixture",
            "--voice-note-take-ready-fixture"
        ]
        app.launch()

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
        XCTAssertEqual(emptyRow.label, "Voice note, optional, collapsed")
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
        app.launch()

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
        app.launch()

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
        XCTAssertEqual(
            XCTWaiter.wait(for: [rejectionPresented], timeout: 3),
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
        XCTAssertFalse(app.buttons["trophy-wall.tab"].exists)
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
        app.launch()

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
        XCTAssertFalse(app.staticTexts["photo-review.cover"].exists)
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

        XCTAssertTrue(app.buttons["scan.tab"].isSelected)
        XCTAssertFalse(app.buttons["trophy-wall.tab"].isSelected)
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
        app.launch()

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

        let window = app.windows.firstMatch.frame
        XCTAssertLessThanOrEqual(startListing.frame.maxY, window.maxY)
        XCTAssertGreaterThanOrEqual(startListing.frame.height, 44)
    }

    func testLivePhotoReviewDeletingTheOnlyPhotoReturnsToGuidedScanWithNoPhotos() {
        let app = XCUIApplication()
        app.launchArguments = ["--restored-capture-fixture"]
        app.launch()

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
            app.launch()

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
            XCTAssertLessThanOrEqual(back.maxX, count.minX, "order at \(typeSize)")
            XCTAssertLessThanOrEqual(
                count.maxY,
                hero.maxY,
                "top bar must stay above the hero at \(typeSize)"
            )

            XCTAssertTrue(
                UIProcessTerminationBoundary().terminate(app),
                "SnapList did not terminate after \(typeSize)"
            )
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
            "scan.flash", "scan.library", "scan.shutter", "scan.tab", "trophy-wall.tab"
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
        XCTAssertTrue(capped.buttons["scan.library"].isEnabled)
    }

    func testApprovedScanCameraRecoveryStatesUseExactCopyAndHonestActions() {
        let unavailable = launch(extraArguments: ["--visual-state=CAM-V1"])
        XCTAssertTrue(unavailable.staticTexts["Camera is not available"].waitForExistence(timeout: 2))
        XCTAssertTrue(unavailable.staticTexts["Add photos from your library instead."].exists)
        XCTAssertTrue(unavailable.buttons["scan.choose-library"].exists)
        XCTAssertFalse(unavailable.buttons["scan.open-settings"].exists)
        XCTAssertFalse(unavailable.buttons["scan.flash"].exists)
        XCTAssertTrue(unavailable.buttons["scan.tab"].exists)
        XCTAssertTrue(unavailable.buttons["trophy-wall.tab"].exists)
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

        let firstPhoto = app.buttons["photo-review.thumbnail.1"]
        let secondPhoto = app.buttons["photo-review.thumbnail.2"]
        let thirdPhoto = app.buttons["photo-review.thumbnail.3"]
        for thumbnail in [firstPhoto, secondPhoto, thirdPhoto] {
            XCTAssertTrue(thumbnail.exists)
        }

        XCTAssertTrue(firstPhoto.label.contains("Photo 1 of 3"))
        XCTAssertTrue(firstPhoto.label.contains("Cover"))
        XCTAssertTrue(firstPhoto.isSelected)
        XCTAssertTrue(secondPhoto.label.contains("Photo 2 of 3"))
        XCTAssertFalse(secondPhoto.label.contains("Cover"))
        XCTAssertFalse(secondPhoto.isSelected)
        XCTAssertTrue(thirdPhoto.label.contains("Photo 3 of 3"))

        let cover = app.staticTexts["photo-review.cover"]
        XCTAssertEqual(app.staticTexts.matching(identifier: "photo-review.cover").count, 1)
        XCTAssertGreaterThanOrEqual(cover.frame.minY, firstPhoto.frame.maxY)

        XCTAssertFalse(app.buttons["photo-review.replace"].exists)
        XCTAssertFalse(app.buttons["photo-review.delete"].exists)

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
        let app = launch(extraArguments: [
            "--photo-review-state=REV-02",
            "--reduced-motion"
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
            forDuration: 0.8,
            thenDragTo: firstPhoto.coordinate(
                withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)
            ),
            withVelocity: 500,
            // Keep the native session over Cover long enough for SwiftUI to
            // render the transient production gap before performDrop clears it.
            thenHoldForDuration: 0.6
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
            "--reduced-motion"
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

        let add = app.buttons["photo-review.add"]
        // REV-03 keeps Add visible so the strip does not reflow at the limit. It stops
        // being an action instead of disappearing.
        XCTAssertTrue(add.exists)
        XCTAssertFalse(add.isEnabled)
        XCTAssertEqual(
            add.label,
            "Add photos, unavailable at five photo limit"
        )

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
        let firstPhoto = app.buttons["photo-review.thumbnail.1"]
        let secondPhoto = app.buttons["photo-review.thumbnail.2"]
        let thirdPhoto = app.buttons["photo-review.thumbnail.3"]

        XCTAssertEqual(count.label, "3 of 5")
        XCTAssertTrue(firstPhoto.label.contains("Photo 1 of 3"))
        XCTAssertTrue(firstPhoto.label.contains("Cover"))
        XCTAssertTrue(firstPhoto.isSelected)
        XCTAssertTrue(secondPhoto.label.contains("Photo 2 of 3"))
        XCTAssertFalse(secondPhoto.label.contains("Cover"))
        XCTAssertFalse(secondPhoto.isSelected)
        XCTAssertTrue(thirdPhoto.label.contains("Photo 3 of 3"))
        XCTAssertFalse(thirdPhoto.label.contains("Cover"))
        XCTAssertFalse(thirdPhoto.isSelected)
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
        XCTAssertTrue(firstPhoto.label.contains("Photo 1 of 3"))
        XCTAssertTrue(firstPhoto.label.contains("Cover"))
        XCTAssertTrue(firstPhoto.isSelected)
        XCTAssertTrue(secondPhoto.label.contains("Photo 2 of 3"))
        XCTAssertFalse(secondPhoto.label.contains("Cover"))
        XCTAssertFalse(secondPhoto.isSelected)
        XCTAssertTrue(thirdPhoto.label.contains("Photo 3 of 3"))
        XCTAssertFalse(thirdPhoto.label.contains("Cover"))
        XCTAssertFalse(thirdPhoto.isSelected)
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
            app.buttons["scan.tab"],
            app.buttons["trophy-wall.tab"]
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

    func testFreshAccountlessJourneyEntersTheRealCaptureFlow() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--fixture=onboarding",
            "--zero-network-fixtures",
            "--reset-onboarding-progress",
            "--camera-status=authorized"
        ]
        app.launch()

        XCTAssertTrue(
            app.buttons["button.primary.start-with-one-item"].waitForExistence(timeout: 3)
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
        XCTAssertTrue(app.staticTexts["sheet.capture.title"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Home"].exists)
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
                    settingsApp.wait(for: .runningForeground, timeout: 3),
                    "Settings handoff did not foreground the system Settings app"
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
                if let settings {
                    XCTAssertTrue(
                        processTermination.terminate(settings),
                        "Settings did not terminate after settings-handoff"
                    )
                } else {
                    XCTFail("Settings lifecycle proxy was not retained")
                }
            }
            XCTAssertTrue(
                processTermination.terminate(app),
                "SnapList did not terminate after \(state)"
            )
        }
    }

    private func launch(
        extraArguments: [String] = [],
        orientation: UIDeviceOrientation = .portrait
    ) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--fixture=home", "--zero-network-fixtures"] + extraArguments
        app.launch()
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

    private func launchVoiceNoteFixture(
        _ fixtureArgument: String
    ) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "--restored-capture-fixture",
            fixtureArgument
        ]
        app.launch()

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
