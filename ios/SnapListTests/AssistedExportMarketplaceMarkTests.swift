import Foundation
import UIKit
import XCTest
@testable import SnapList

/// The Facebook Marketplace row named only a square "f" glyph, which read as
/// "share to Facebook" instead of "share to Facebook Marketplace" (issue
/// #990). The row now renders a composite lockup — the Facebook icon asset
/// beside a "MarketPlace" wordmark asset — because Meta publishes no
/// standalone Marketplace wordmark that also carries Facebook's identity on
/// its own. This pins the fix at both asset halves: neither can silently
/// disappear or drift back toward the old single-icon shape.
final class AssistedExportMarketplaceMarkTests: XCTestCase {
    private static let markNames = [
        "MarketplaceMarkFacebookIcon",
        "MarketplaceMarkFacebook",
        "MarketplaceMarkMercari",
        "MarketplaceMarkDepop",
    ]

    func testEveryMarketplaceMarkIsBundled() {
        for name in Self.markNames {
            XCTAssertNotNil(UIImage(named: name), "\(name) is not in the asset catalog.")
        }
    }

    func testFacebookWordmarkIsWideNotSquare() throws {
        let image = try XCTUnwrap(UIImage(named: "MarketplaceMarkFacebook"))
        let aspectRatio = image.size.width / image.size.height

        XCTAssertGreaterThan(
            aspectRatio,
            3,
            "MarketplaceMarkFacebook is \(image.size.width)x\(image.size.height), which reads "
                + "as a square icon rather than a Marketplace wordmark."
        )
    }

    func testFacebookIconIsSquareNotStretchedIntoTheWordmarkShape() throws {
        let image = try XCTUnwrap(UIImage(named: "MarketplaceMarkFacebookIcon"))
        let aspectRatio = image.size.width / image.size.height

        XCTAssertEqual(
            aspectRatio,
            1,
            accuracy: 0.05,
            "MarketplaceMarkFacebookIcon is \(image.size.width)x\(image.size.height), which no "
                + "longer reads as the Facebook icon half of the composite lockup."
        )
    }
}
