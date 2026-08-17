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

    func testTheEditingRouteSendsOnlyNonIdentitySpecificsToAnInPlaceField() {
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

    func testTheSaveContractKeyNormalizesTheNameItself() {
        // The function owns the rule, so it is asked directly. Testing only
        // through the callers would make the guarantee true by inspection
        // again, which is what let the two of them drift apart.
        XCTAssertEqual(
            ListingReviewDraft.saveContractKey(for: " Brand"),
            "reserved:brand"
        )
        XCTAssertEqual(
            ListingReviewDraft.saveContractKey(for: "BRAND "),
            "reserved:brand"
        )
        XCTAssertEqual(
            ListingReviewDraft.saveContractKey(for: "\tType\n"),
            "reserved:category"
        )
        XCTAssertEqual(
            ListingReviewDraft.saveContractKey(for: " Color "),
            "color"
        )
    }

    func testAnIdentityNameWithStrayWhitespaceStillRoutesToGuidedCorrection() {
        // Generated specifics are not guaranteed to arrive tidy, and an
        // untrimmed " Brand" reading as an ordinary specific would put a typed
        // brand straight into the draft with no pricing rerun behind it.
        for padded in [" Brand", "Brand ", "\tISBN", "Type\n"] {
            XCTAssertEqual(
                ListingReviewSpecificEditing.mode(
                    forSpecificNamed: padded,
                    correctionAvailable: true
                ),
                .guidedCorrection,
                padded
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

/// The clamp `ListingReviewInlineTextView` puts in front of caret placement.
///
/// Both halves are here because they pull against each other. It has to move a
/// point that landed in the empty room a 44pt touch floor leaves under a short
/// value, and it has to leave a point that landed on the glyphs exactly where
/// it was — including on a value long enough to scroll, which is the state the
/// first version of the clamp got wrong (#928).
///
/// `UITextView` itself is the oracle for the second half. `caretRect(for:)`
/// answers in the same coordinate space `closestPosition(to:)` reads, so a
/// point taken from a known character is a point known to be on the glyphs.
@MainActor
final class ListingReviewInlineTextViewTests: XCTestCase {
    private func configure(_ view: UITextView, text: String, height: CGFloat) {
        view.frame = CGRect(x: 0, y: 0, width: 342, height: height)
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.font = UIFont.preferredFont(forTextStyle: .body)
        view.isScrollEnabled = true
        view.text = text
        view.layoutIfNeeded()
    }

    private func offset(of position: UITextPosition?, in view: UITextView) -> Int? {
        position.map { view.offset(from: view.beginningOfDocument, to: $0) }
    }

    private var scrollingValue: String {
        (1...150).map { String(format: "aaa%03d", $0) }.joined(separator: " ")
    }

    func testATapOnTheGlyphsOfAScrolledValueResolvesWhereUITextViewResolvesIt() {
        let oracle = UITextView()
        configure(oracle, text: scrollingValue, height: 243)
        let known = oracle.position(from: oracle.beginningOfDocument, offset: 900)!
        let caret = oracle.caretRect(for: known)
        let onTheGlyphs = CGPoint(x: caret.midX, y: caret.midY)
        XCTAssertEqual(
            offset(of: oracle.closestPosition(to: onTheGlyphs), in: oracle),
            900,
            "The oracle has to resolve its own caret rect back to the same "
                + "character, or this test is measuring nothing."
        )

        let subject = ListingReviewInlineTextView()
        configure(subject, text: scrollingValue, height: 243)
        // Far enough down that the offset term the clamp used to carry moved
        // the band above the point being resolved.
        subject.contentOffset = CGPoint(x: 0, y: 200)

        XCTAssertEqual(
            offset(of: subject.closestPosition(to: onTheGlyphs), in: subject),
            900,
            "A point already on the glyphs must come back untouched however "
                + "far the value is scrolled. `bounds.origin` is `contentOffset` "
                + "on a scroll view, so the point already carries the scroll."
        )
    }

    func testATapUnderAShortValueResolvesByXInsteadOfJumpingToTheEnd() {
        let value = "White"
        let oracle = UITextView()
        configure(oracle, text: value, height: 44)
        let underTheGlyphs = CGPoint(x: 2, y: 40)
        XCTAssertEqual(
            offset(of: oracle.closestPosition(to: underTheGlyphs), in: oracle),
            value.count,
            "Plain `UITextView` answers below the last line with the end of "
                + "the document; that is the behaviour being overridden."
        )

        let subject = ListingReviewInlineTextView()
        configure(subject, text: value, height: 44)

        XCTAssertEqual(
            offset(of: subject.closestPosition(to: underTheGlyphs), in: subject),
            0,
            "The tap is at the left edge of the box, so it belongs before the "
                + "first character, not after the last one."
        )
    }
}
