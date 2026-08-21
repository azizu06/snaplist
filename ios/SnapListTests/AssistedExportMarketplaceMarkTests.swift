import Foundation
import UIKit
import XCTest
@testable import SnapList

/// The Facebook Marketplace row named an actual Facebook-brand icon (a square
/// "f" glyph) rather than a Marketplace wordmark, which read as "share to
/// Facebook" instead of "share to Facebook Marketplace" (issue #990). This
/// pins the fix at the asset itself: the Facebook mark must be a wide
/// wordmark shape like Mercari and Depop, not the old square icon aspect
/// ratio, and it must still exist in the catalog under the same name the view
/// references.
final class AssistedExportMarketplaceMarkTests: XCTestCase {
    private static let markNames = [
        "MarketplaceMarkFacebook",
        "MarketplaceMarkMercari",
        "MarketplaceMarkDepop",
    ]

    func testEveryMarketplaceMarkIsBundled() {
        for name in Self.markNames {
            XCTAssertNotNil(UIImage(named: name), "\(name) is not in the asset catalog.")
        }
    }

    func testFacebookMarkIsAWordmarkNotTheSquareBrandIcon() throws {
        let image = try XCTUnwrap(UIImage(named: "MarketplaceMarkFacebook"))
        let aspectRatio = image.size.width / image.size.height

        XCTAssertGreaterThan(
            aspectRatio,
            3,
            "MarketplaceMarkFacebook is \(image.size.width)x\(image.size.height), which reads "
                + "as the old square Facebook icon rather than a Marketplace wordmark."
        )
    }
}
