import XCTest
@testable import SnapList

private extension Locale {
    /// Pinned so currency formatting assertions do not depend on the test host's region.
    static let enUS = Locale(identifier: "en_US")
}

final class ListingReviewPresentationTests: XCTestCase {
    func testSoldSummaryRendersOneRangeWhenEveryMatchSharesACurrency() throws {
        let matches = try soldMatches([(40, "USD"), (52, "USD"), (66, "USD")])

        XCTAssertEqual(
            ListingReviewSoldSummary.text(for: matches, locale: .enUS),
            "3 sold · $40–$66"
        )
    }

    func testSoldSummaryOmitsTheRangeWhenMatchesDoNotShareOneCurrency() throws {
        let matches = try soldMatches([(40, "USD"), (900, "SEK")])

        XCTAssertEqual(
            ListingReviewSoldSummary.text(for: matches, locale: .enUS),
            "2 sold"
        )
    }

    func testInvalidPriceMessageUsesInkAndNotAnUnapprovedRed() throws {
        let tokens = try loadJSON(
            named: "snaplist-design-tokens",
            at: .resolvedContracts
        )
        let colors = try XCTUnwrap(tokens["colors"] as? [String: Any])

        // The frozen palette resolves no destructive colour at all, so any red
        // for this message would have to be invented rather than approved.
        XCTAssertTrue(colors["destructive"] is NSNull)
        XCTAssertEqual(
            ListingReviewPriceStyle.invalidMessage.rawValue,
            colors["ink_primary"] as? String
        )
    }

    func testGuidedCorrectionIsWithheldWithoutAFixtureBehindIt() {
        // Fix item pushes a typed boundary card until #212 builds its interior,
        // so a production launch must offer Edit details instead.
        XCTAssertFalse(
            LaunchConfiguration.standard.listingReviewCorrectionAvailable
        )
        XCTAssertTrue(
            LaunchConfiguration.parse(
                arguments: ["--listing-review-fixture=loaded"]
            ).listingReviewCorrectionAvailable
        )
        XCTAssertFalse(
            LaunchConfiguration.parse(
                arguments: ["--listing-review-fixture=correction-unavailable"]
            ).listingReviewCorrectionAvailable
        )
    }

    func testPageDotsDrawOneDotPerPhotoAndFillOnlyTheCurrentOne() {
        XCTAssertEqual(
            SnapListPageDots.filledStates(pageCount: 2, selectedIndex: 0),
            [true, false]
        )
        XCTAssertEqual(
            SnapListPageDots.filledStates(pageCount: 2, selectedIndex: 1),
            [false, true]
        )
        XCTAssertEqual(
            SnapListPageDots.filledStates(pageCount: 5, selectedIndex: 3),
            [false, false, false, true, false]
        )
    }

    func testPageDotsSurviveASelectionThatIsNotOnThePage() {
        // The pager owns the selection and this view only reports it, so an
        // index the page count cannot hold must still draw the right number of
        // dots rather than trapping or filling nothing the seller can see.
        XCTAssertEqual(
            SnapListPageDots.filledStates(pageCount: 3, selectedIndex: 9),
            [false, false, false]
        )
        XCTAssertEqual(
            SnapListPageDots.filledStates(pageCount: 3, selectedIndex: -1),
            [false, false, false]
        )
    }

    func testPageDotsStayHiddenWhenThereIsOnlyOnePlaceToBe() {
        // #883's marker semantics: dots report which of several photos is up.
        // A lone dot over a single photo is decoration, so the row withholds
        // itself exactly where the hero has nowhere to go.
        XCTAssertFalse(SnapListPageDots.isVisible(pageCount: 1))
        XCTAssertFalse(SnapListPageDots.isVisible(pageCount: 0))
        XCTAssertTrue(SnapListPageDots.isVisible(pageCount: 2))
    }

    func testANonIdentitySpecificEditsInPlaceAndAnIdentityOneReachesGuidedCorrection() {
        // The route is the whole contract. A reserved identity key can never
        // resolve to an in-place edit, because a typed value would bypass the
        // pricing rerun, the composite confidence, and the generator.
        XCTAssertEqual(
            ListingReviewSpecificEditing.mode(
                forSpecificNamed: "Color",
                correctionAvailable: true
            ),
            .inPlace
        )
        XCTAssertEqual(
            ListingReviewSpecificEditing.mode(
                forSpecificNamed: "Color",
                correctionAvailable: false
            ),
            .inPlace
        )
        for reserved in ["Brand", "model", "Condition", "ISBN", "upc", "Category", "Type"] {
            XCTAssertEqual(
                ListingReviewSpecificEditing.mode(
                    forSpecificNamed: reserved,
                    correctionAvailable: true
                ),
                .guidedCorrection,
                reserved
            )
            XCTAssertEqual(
                ListingReviewSpecificEditing.mode(
                    forSpecificNamed: reserved,
                    correctionAvailable: false
                ),
                .spent,
                reserved
            )
        }
    }

    private func soldMatches(
        _ facts: [(Int, String)]
    ) throws -> [ListingReviewSoldMatch] {
        try facts.enumerated().map { index, fact in
            // The read contract distinguishes an absent key from an explicit
            // null, so a nullable fact still has to be carried on the wire.
            let object: [String: Any] = [
                "id": "sold-\(index + 1)",
                "sourceURL": "https://example.com/sold/\(index + 1)",
                "soldPrice": fact.0,
                "currency": fact.1,
                "title": NSNull(),
                "condition": NSNull(),
                "soldAt": NSNull(),
            ]
            return try JSONDecoder().decode(
                ListingReviewSoldMatch.self,
                from: JSONSerialization.data(withJSONObject: object)
            )
        }
    }
}
