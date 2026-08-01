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
