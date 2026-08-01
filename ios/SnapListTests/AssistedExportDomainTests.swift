import Foundation
import XCTest
@testable import SnapList

/// Behavior of the pure assisted-export state machine (issue #581).
///
/// Every assertion here is about what the seller is told, never about how the
/// domain stores it. The one invariant the whole family exists to protect is
/// that `Shared` is the seller's own claim: SnapList cannot see Facebook
/// Marketplace, Mercari, or Depop, so nothing short of the explicit confirm
/// sheet may write it.
final class AssistedExportDomainTests: XCTestCase {
    // MARK: - XPORT-01, the prepared pack

    func testPreparedPackListsThreeDestinationsAndNoneIsShared() {
        let domain = AssistedExportDomain(pack: .fixture())

        XCTAssertEqual(domain.state, .destinationList)
        XCTAssertEqual(
            domain.destinations,
            [.facebookMarketplace, .mercari, .depop]
        )
        for destination in domain.destinations {
            XCTAssertEqual(domain.handoff(for: destination), .prepared)
            XCTAssertEqual(domain.statusText(for: destination), "Not shared")
        }
        XCTAssertNil(domain.confirmSheet)
    }

    // MARK: - XPORT-02, a workspace open before any action

    func testOpeningAWorkspaceOffersTheHandoffButNotTheSharedClaim() {
        var domain = AssistedExportDomain(pack: .fixture())

        domain.toggle(.mercari)

        XCTAssertEqual(domain.state, .workspaceOpen(.mercari))
        XCTAssertEqual(domain.openDestination, .mercari)
        XCTAssertEqual(domain.primaryActionLabel(for: .mercari), "Open Mercari")
        XCTAssertFalse(
            domain.offersMarkAsShared(for: .mercari),
            "Mark as shared may not appear before the seller has done anything."
        )
        XCTAssertEqual(domain.handoff(for: .mercari), .prepared)
    }

    func testOnlyOneWorkspaceIsOpenAtATimeAndClosingWritesNothing() {
        var domain = AssistedExportDomain(pack: .fixture())

        domain.toggle(.mercari)
        domain.toggle(.depop)
        XCTAssertEqual(domain.openDestination, .depop)
        XCTAssertEqual(domain.state, .workspaceOpen(.depop))

        domain.toggle(.depop)
        XCTAssertNil(domain.openDestination)
        XCTAssertEqual(domain.state, .destinationList)
        for destination in domain.destinations {
            XCTAssertEqual(
                domain.handoff(for: destination),
                .prepared,
                "Opening and closing a workspace is not a handoff."
            )
        }
    }

    // MARK: - XPORT-03, the seller handed the pack over

    func testAHandoffActionRevealsTheClaimControlWithoutMakingTheClaim() {
        var domain = AssistedExportDomain(pack: .fixture())
        domain.toggle(.depop)

        domain.recordHandoff(.copiedListingText, for: .depop)

        XCTAssertEqual(domain.state, .handedOff(.depop))
        XCTAssertTrue(domain.offersMarkAsShared(for: .depop))
        XCTAssertEqual(
            domain.handoff(for: .depop),
            .prepared,
            "Copying the text is a device action. It says nothing about Depop."
        )
        XCTAssertEqual(domain.statusText(for: .depop), "Not shared")
    }

    func testNoHandoffActionEverWritesTheSharedClaim() {
        let actions: [AssistedExportHandoffAction] = [
            .openedDestination,
            .copiedListingText,
            .savedPhotos,
            .sharedAnotherWay,
        ]

        for action in actions {
            var domain = AssistedExportDomain(pack: .fixture())
            domain.toggle(.facebookMarketplace)

            domain.recordHandoff(action, for: .facebookMarketplace)

            XCTAssertEqual(
                domain.handoff(for: .facebookMarketplace),
                .prepared,
                "\(action) must not write Shared. Only the confirm sheet does."
            )
            XCTAssertNil(domain.confirmSheet)
        }
    }

    func testAHandoffOnOneDestinationSaysNothingAboutTheOthers() {
        var domain = AssistedExportDomain(pack: .fixture())
        domain.toggle(.mercari)

        domain.recordHandoff(.openedDestination, for: .mercari)
        domain.toggle(.depop)

        XCTAssertEqual(domain.state, .workspaceOpen(.depop))
        XCTAssertFalse(domain.offersMarkAsShared(for: .depop))
        XCTAssertTrue(
            domain.offersMarkAsShared(for: .mercari),
            "Reopening a row restores it exactly as the seller left it."
        )
    }

    // MARK: - XPORT-04, the only writer of Shared

    func testTheConfirmSheetIsTheOnlyThingThatWritesShared() {
        var domain = AssistedExportDomain(pack: .fixture())
        domain.toggle(.mercari)
        domain.recordHandoff(.openedDestination, for: .mercari)

        domain.presentConfirmSheet(for: .mercari)
        XCTAssertEqual(domain.confirmSheet, .mercari)
        XCTAssertEqual(
            domain.handoff(for: .mercari),
            .prepared,
            "Mounting the sheet is not confirming."
        )

        XCTAssertEqual(domain.confirmShared(at: Self.julyTwentyFifth), .recorded)

        XCTAssertNil(domain.confirmSheet)
        XCTAssertEqual(domain.state, .shared(.mercari))
        XCTAssertEqual(domain.handoff(for: .mercari), .shared(at: Self.julyTwentyFifth))
        XCTAssertEqual(domain.statusText(for: .mercari), "Shared Jul 25")
    }

    func testDismissingTheConfirmSheetIsAFullCancel() {
        var domain = AssistedExportDomain(pack: .fixture())
        domain.toggle(.mercari)
        domain.recordHandoff(.openedDestination, for: .mercari)
        domain.presentConfirmSheet(for: .mercari)

        domain.dismissConfirmSheet()

        XCTAssertNil(domain.confirmSheet)
        XCTAssertEqual(domain.handoff(for: .mercari), .prepared)
        XCTAssertEqual(
            domain.state,
            .handedOff(.mercari),
            "A cancel leaves the workspace exactly as it was."
        )
        XCTAssertTrue(domain.offersMarkAsShared(for: .mercari))
    }

    func testConfirmingRefusesWhenTheRowNeverPerformedAHandoff() {
        var domain = AssistedExportDomain(pack: .fixture())
        domain.toggle(.depop)

        domain.presentConfirmSheet(for: .depop)
        XCTAssertNil(
            domain.confirmSheet,
            "A row that did nothing cannot even be asked."
        )

        XCTAssertEqual(domain.confirmShared(at: Self.julyTwentyFifth), .refused)
        XCTAssertEqual(domain.handoff(for: .depop), .prepared)
    }

    func testConfirmingTwiceKeepsTheFirstReceiptRatherThanMintingASecond() {
        var domain = AssistedExportDomain(pack: .fixture())
        domain.toggle(.depop)
        domain.recordHandoff(.savedPhotos, for: .depop)
        domain.presentConfirmSheet(for: .depop)
        XCTAssertEqual(domain.confirmShared(at: Self.julyTwentyFifth), .recorded)

        domain.presentConfirmSheet(for: .depop)
        XCTAssertNil(domain.confirmSheet)
        XCTAssertEqual(
            domain.confirmShared(at: Self.julyTwentySixth),
            .refused
        )

        XCTAssertEqual(
            domain.handoff(for: .depop),
            .shared(at: Self.julyTwentyFifth),
            "A replay keeps the original receipt, matching mark_export_shared."
        )
    }

    // MARK: - The words this family may never say

    /// SnapList cannot see these three destinations, so it may never imply it
    /// can. This sweeps every seller-facing string the domain can produce, in
    /// every state a seller can reach.
    func testNoReachableStringEverClaimsTheDestinationDidAnything() {
        let forbidden = [
            "publish", "listed", "listing is live", "sold",
            "sync", "received", "verified", "confirmed by",
        ]

        var strings = AssistedExportCopy.allSellerFacingStrings

        for destination in AssistedExportDestination.allCases {
            var domain = AssistedExportDomain(pack: .fixture())
            strings.append(domain.statusText(for: destination))

            domain.toggle(destination)
            strings.append(domain.primaryActionLabel(for: destination))
            strings.append(domain.leadText(for: destination))
            strings.append(domain.whatHappensNextText(for: destination))
            strings.append(domain.confirmQuestion(for: destination))
            strings.append(domain.accessibilityLabel(for: destination))

            domain.recordHandoff(.openedDestination, for: destination)
            domain.recordDestinationDidNotOpen(destination)
            strings.append(domain.advisory(for: destination) ?? "")
            strings.append(domain.accessibilityLabel(for: destination))

            domain.presentConfirmSheet(for: destination)
            domain.confirmShared(at: Self.julyTwentyFifth)
            strings.append(domain.statusText(for: destination))
            strings.append(domain.accessibilityLabel(for: destination))

            domain.listingRevisionChanged(to: Self.editedReviewRevision)
            strings.append(domain.statusText(for: destination))
        }

        for string in strings {
            let lowered = string.lowercased()
            for word in forbidden {
                XCTAssertFalse(
                    lowered.contains(word),
                    "\"\(string)\" contains \"\(word)\". SnapList cannot "
                        + "observe these destinations and must not imply it can."
                )
            }
        }
        XCTAssertGreaterThan(strings.count, 20, "The sweep must actually sweep.")
    }

    func testTheStaleAdvisoryAsksForAnUpdateRatherThanBlamingTheSeller() {
        XCTAssertEqual(
            AssistedExportCopy.packOutOfDateTitle,
            "This pack is out of date"
        )
        XCTAssertEqual(
            AssistedExportCopy.packOutOfDateDetail,
            "You changed the listing after this pack was prepared. Update the "
                + "pack to match before sharing. Updating replaces the old pack."
        )
        XCTAssertEqual(AssistedExportCopy.updatePack, "Update pack")
    }

    // The pack line says what is in the pack and when it was built. It is not a
    // status: a prepared pack is the normal state of this screen, so the line
    // reports and stops rather than telling the seller anything is pending.

    func testThePackLineDescribesThePackWithoutClaimingAnythingAboutIt() {
        XCTAssertEqual(
            AssistedExportCopy.packMeta(photoCount: 8, preparedAt: "2:41 PM"),
            "8 photos · Updated 2:41 PM"
        )
        XCTAssertEqual(
            AssistedExportCopy.packMeta(photoCount: 1, preparedAt: "9:04 AM"),
            "1 photo · Updated 9:04 AM",
            "A one-photo pack is a real pack, and it should not read `1 photos`."
        )
    }

    func testTheSaveControlCountsTheSellersOwnPhotosCorrectly() {
        XCTAssertEqual(AssistedExportCopy.savePhotos(count: 5), "Save 5 photos")
        XCTAssertEqual(AssistedExportCopy.savePhotos(count: 1), "Save 1 photo")
    }

    func testTheConfirmSheetPutsTheClaimOnTheSellerNotOnSnapList() {
        var domain = AssistedExportDomain(pack: .fixture())
        domain.toggle(.mercari)

        XCTAssertEqual(
            domain.confirmQuestion(for: .mercari),
            "Did you post this on Mercari?"
        )
        XCTAssertEqual(AssistedExportCopy.confirmShared, "Yes, mark as shared")
        XCTAssertEqual(AssistedExportCopy.confirmNotYet, "Not yet")
        XCTAssertEqual(
            AssistedExportCopy.markAsSharedSupport,
            "Only you can confirm this. SnapList won't mark it for you."
        )
        XCTAssertEqual(
            domain.whatHappensNextText(for: .mercari),
            "Paste the text and add the photos in Mercari. SnapList can't see "
                + "whether the listing goes up. When you've posted it, mark it "
                + "shared here."
        )
    }

    // MARK: - The destination did not open (XPORT-07B behavior)
    //
    // 07B is the post-tap advisory, and it is the reading the package
    // recommends. 07A's `canOpenURL` pre-flight is not implemented: it needs
    // every scheme declared, it answers false for reasons unrelated to
    // installation, and a true answer still does not mean the app will take the
    // payload. Asserting any of that would be SnapList claiming something about
    // the seller's device it cannot verify.

    func testAFailedOpenLeavesAnAdvisoryWithoutBlockingAnything() {
        var domain = AssistedExportDomain(pack: .fixture())
        domain.toggle(.facebookMarketplace)
        domain.recordHandoff(.openedDestination, for: .facebookMarketplace)

        domain.recordDestinationDidNotOpen(.facebookMarketplace)

        XCTAssertEqual(
            domain.advisory(for: .facebookMarketplace),
            "Facebook Marketplace didn't open. It may not be installed. "
                + "Copy the text or share another way."
        )
        XCTAssertTrue(
            domain.offersMarkAsShared(for: .facebookMarketplace),
            "The advisory is quiet. It withholds nothing."
        )
        XCTAssertEqual(
            domain.state,
            .handedOff(.facebookMarketplace),
            "07B is not a live state. A row with an advisory is still XPORT-03."
        )
    }

    func testNothingIsSaidAboutADestinationBeforeTheSellerTapsOpen() {
        var domain = AssistedExportDomain(pack: .fixture())
        domain.toggle(.facebookMarketplace)

        XCTAssertNil(
            domain.advisory(for: .facebookMarketplace),
            "There is no pre-flight. Before an attempt SnapList knows nothing "
                + "about what is installed, and says nothing."
        )
        XCTAssertEqual(
            domain.statusText(for: .facebookMarketplace),
            "Not shared",
            "The row status never reports device or destination availability."
        )
    }

    func testAFailedOpenStillEarnsTheRightToBeAsked() {
        var domain = AssistedExportDomain(pack: .fixture())
        domain.toggle(.facebookMarketplace)
        domain.recordHandoff(.openedDestination, for: .facebookMarketplace)
        domain.recordDestinationDidNotOpen(.facebookMarketplace)

        domain.presentConfirmSheet(for: .facebookMarketplace)
        XCTAssertEqual(
            domain.confirmSheet,
            .facebookMarketplace,
            "SnapList cannot tell a failed open from the seller posting by "
                + "hand, so it must not withhold the question."
        )
    }

    // MARK: - Undo, the only unwrite

    func testUndoReturnsToPreparedWithoutErasingThatAHandoffHappened() {
        var domain = AssistedExportDomain(pack: .fixture())
        domain.toggle(.depop)
        domain.recordHandoff(.copiedListingText, for: .depop)
        domain.presentConfirmSheet(for: .depop)
        domain.confirmShared(at: Self.julyTwentyFifth)
        XCTAssertEqual(domain.undoWindow, .depop)

        domain.undoShared()

        XCTAssertEqual(domain.handoff(for: .depop), .prepared)
        XCTAssertEqual(domain.statusText(for: .depop), "Not shared")
        XCTAssertTrue(
            domain.hasHandedOff(to: .depop),
            "Taking back the claim does not take back the handoff. The seller "
                + "did copy the text, and the receipt for that stands."
        )
        XCTAssertTrue(domain.offersMarkAsShared(for: .depop))
        XCTAssertNil(domain.undoWindow)
    }

    func testTheUndoWindowNeverOutlivesTheControlThatRendersIt() {
        var domain = AssistedExportDomain(pack: .fixture())
        domain.toggle(.depop)
        domain.recordHandoff(.copiedListingText, for: .depop)
        domain.presentConfirmSheet(for: .depop)
        domain.confirmShared(at: Self.julyTwentyFifth)

        domain.toggle(.depop)

        XCTAssertNil(
            domain.undoWindow,
            "Closing the workspace takes the Undo control off screen, so the "
                + "window it belongs to has to close with it."
        )
        XCTAssertEqual(
            domain.handoff(for: .depop),
            .shared(at: Self.julyTwentyFifth),
            "Losing the undo window is not the same as undoing."
        )
    }

    func testUndoIsOutOfScopeOnceItsWindowHasClosed() {
        var domain = AssistedExportDomain(pack: .fixture())
        domain.toggle(.depop)
        domain.recordHandoff(.copiedListingText, for: .depop)
        domain.presentConfirmSheet(for: .depop)
        domain.confirmShared(at: Self.julyTwentyFifth)
        domain.closeUndoWindow()

        domain.undoShared()

        XCTAssertEqual(
            domain.handoff(for: .depop),
            .shared(at: Self.julyTwentyFifth),
            "After the window closes, unmarking is out of scope."
        )
    }

    // MARK: - XPORT-05, the listing moved under the seller
    //
    // Gate 2 on the approved package found a live path where a listing change
    // left the confirm sheet mounted over a stale advisory, so the seller could
    // tap confirm on a pack they were never shown. The server refusing that
    // write is not enough. The sheet has to come down.

    func testARevisionChangeDismissesAMountedConfirmSheet() {
        var domain = AssistedExportDomain(pack: .fixture())
        domain.toggle(.mercari)
        domain.recordHandoff(.openedDestination, for: .mercari)
        domain.presentConfirmSheet(for: .mercari)
        XCTAssertEqual(domain.confirmSheet, .mercari)

        domain.listingRevisionChanged(to: Self.editedReviewRevision)

        XCTAssertNil(
            domain.confirmSheet,
            "The seller must never be left holding a sheet describing a pack "
                + "that no longer matches the listing."
        )
        XCTAssertEqual(domain.state, .packOutOfDate)
        XCTAssertTrue(domain.isPackOutOfDate)
    }

    func testConfirmingCannotSucceedOnceTheListingHasMoved() {
        var domain = AssistedExportDomain(pack: .fixture())
        domain.toggle(.mercari)
        domain.recordHandoff(.openedDestination, for: .mercari)
        domain.presentConfirmSheet(for: .mercari)

        domain.listingRevisionChanged(to: Self.editedReviewRevision)

        XCTAssertEqual(domain.confirmShared(at: Self.julyTwentyFifth), .refused)
        XCTAssertEqual(domain.handoff(for: .mercari), .prepared)
    }

    func testAStalePackWithholdsHandoffActionsUntilItIsUpdated() {
        var domain = AssistedExportDomain(pack: .fixture())
        domain.toggle(.depop)
        domain.recordHandoff(.copiedListingText, for: .depop)

        domain.listingRevisionChanged(to: Self.editedReviewRevision)

        XCTAssertEqual(
            domain.state,
            .packOutOfDate,
            "No workspace renders while the pack is stale, whichever one the "
                + "seller had open."
        )
        XCTAssertFalse(domain.offersMarkAsShared(for: .depop))

        domain.recordHandoff(.savedPhotos, for: .depop)
        domain.presentConfirmSheet(for: .depop)
        XCTAssertNil(domain.confirmSheet)
        XCTAssertEqual(domain.confirmShared(at: Self.julyTwentyFifth), .refused)
    }

    func testTheSellersOwnSharedRecordsSurviveTheListingChanging() {
        var domain = AssistedExportDomain(pack: .fixture())
        domain.toggle(.mercari)
        domain.recordHandoff(.openedDestination, for: .mercari)
        domain.presentConfirmSheet(for: .mercari)
        XCTAssertEqual(domain.confirmShared(at: Self.julyTwentyFifth), .recorded)

        domain.listingRevisionChanged(to: Self.editedReviewRevision)

        XCTAssertEqual(
            domain.handoff(for: .mercari),
            .shared(at: Self.julyTwentyFifth),
            "The record belongs to the seller. Editing the listing does not "
                + "unsay what they said."
        )
        XCTAssertEqual(domain.statusText(for: .mercari), "Shared Jul 25")
    }

    func testUpdatingThePackClearsTheStaleStateAndKeepsSharedRecords() {
        var domain = AssistedExportDomain(pack: .fixture())
        domain.toggle(.mercari)
        domain.recordHandoff(.openedDestination, for: .mercari)
        domain.presentConfirmSheet(for: .mercari)
        domain.confirmShared(at: Self.julyTwentyFifth)
        domain.listingRevisionChanged(to: Self.editedReviewRevision)

        domain.updatePack(
            to: .fixture(
                contentRevision: Self.editedContentRevision,
                reviewRevision: Self.editedReviewRevision
            )
        )

        XCTAssertFalse(domain.isPackOutOfDate)
        XCTAssertEqual(
            domain.state,
            .shared(.mercari),
            "The workspace comes back, and it comes back still reading Shared."
        )
        XCTAssertEqual(domain.handoff(for: .mercari), .shared(at: Self.julyTwentyFifth))
    }

    // The approved package is explicit about what updating the pack does:
    // "The destination that was open before is restored, and every Shared
    // record the seller wrote is kept." Landing the seller back on the bare
    // destination list would make them find their place again for an edit they
    // may not have made from this screen at all.

    func testUpdatingThePackReturnsTheSellerToTheWorkspaceTheyWereIn() {
        var domain = AssistedExportDomain(pack: .fixture())
        domain.toggle(.mercari)
        domain.recordHandoff(.openedDestination, for: .mercari)

        domain.listingRevisionChanged(to: Self.editedReviewRevision)
        XCTAssertEqual(domain.state, .packOutOfDate)

        domain.updatePack(
            to: .fixture(
                contentRevision: Self.editedContentRevision,
                reviewRevision: Self.editedReviewRevision
            )
        )

        XCTAssertEqual(
            domain.state,
            .workspaceOpen(.mercari),
            "The seller comes back to the destination they were working in, "
                + "not to the top of the list."
        )
    }

    // A price-only edit advances the review revision without touching the pack
    // text, which is why the server keys handoff receipts on the content
    // revision alone and the confirm guard on the full one. The receipt belongs
    // to the words and photos that were handed over, and those did not move.

    func testAPriceOnlyEditKeepsThePackTextAndTheHandoffThatWentWithIt() {
        var domain = AssistedExportDomain(pack: .fixture())
        domain.toggle(.facebookMarketplace)
        domain.recordHandoff(.copiedListingText, for: .facebookMarketplace)

        domain.listingRevisionChanged(to: Self.editedReviewRevision)
        domain.updatePack(
            to: .fixture(
                contentRevision: AssistedExportPack.fixtureContentRevision,
                reviewRevision: Self.editedReviewRevision
            )
        )

        XCTAssertEqual(domain.state, .handedOff(.facebookMarketplace))
        XCTAssertTrue(
            domain.offersMarkAsShared(for: .facebookMarketplace),
            "The seller already handed over this exact text. A new price does "
                + "not make them do it again before they can say they posted it."
        )
    }

    func testANewPackTextRetiresTheHandoffThatBelongedToTheOldOne() {
        var domain = AssistedExportDomain(pack: .fixture())
        domain.toggle(.facebookMarketplace)
        domain.recordHandoff(.copiedListingText, for: .facebookMarketplace)

        domain.listingRevisionChanged(to: Self.editedReviewRevision)
        domain.updatePack(
            to: .fixture(
                contentRevision: Self.editedContentRevision,
                reviewRevision: Self.editedReviewRevision
            )
        )

        XCTAssertFalse(
            domain.offersMarkAsShared(for: .facebookMarketplace),
            "The pack they copied is gone. Confirming against the new one "
                + "would claim they posted words they never saw."
        )
    }

    private static let editedReviewRevision =
        UUID(uuidString: "58100000-0000-4000-8000-0000000000a1")!
    private static let editedContentRevision =
        UUID(uuidString: "58100000-0000-4000-8000-0000000000c1")!

    /// Built from calendar components rather than an epoch literal on purpose.
    /// The seller's shared date is rendered in their own time zone, which is
    /// the behavior we want, so a fixed UTC instant would name a different day
    /// depending on where the test runs.
    private static func localNoon(month: Int, day: Int) -> Date {
        var components = DateComponents()
        components.year = 2026
        components.month = month
        components.day = day
        components.hour = 12
        return Calendar.current.date(from: components)!
    }

    private static let julyTwentyFifth = localNoon(month: 7, day: 25)
    private static let julyTwentySixth = localNoon(month: 7, day: 26)
}

extension AssistedExportPack {
    static let fixtureItemID =
        UUID(uuidString: "58100000-0000-4000-8000-000000000001")!
    /// The content revision the pack text was built at.
    static let fixtureContentRevision =
        UUID(uuidString: "58100000-0000-4000-8000-0000000000c0")!
    /// The full listing revision the seller was looking at when it was built.
    static let fixtureReviewRevision =
        UUID(uuidString: "58100000-0000-4000-8000-0000000000a0")!

    static func fixture(
        itemID: UUID = fixtureItemID,
        contentRevision: UUID = fixtureContentRevision,
        reviewRevision: UUID = fixtureReviewRevision,
        photoCount: Int = 8
    ) -> AssistedExportPack {
        AssistedExportPack(
            itemID: itemID,
            contentRevision: contentRevision,
            reviewRevision: reviewRevision,
            photoCount: photoCount
        )
    }
}
