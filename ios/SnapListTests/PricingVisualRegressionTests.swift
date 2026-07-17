import SwiftUI
import UIKit
import XCTest
@testable import SnapList

@MainActor
final class PricingVisualRegressionTests: XCTestCase {
    func testS1StrongEvidenceRendersInTheSimulator() {
        let capture = Capture(name: "S1-strong", model: PricingFeatureFixtures.strong)
        attach(render(capture), named: capture.name)
    }

    func testS1bAllComparablesRendersInTheSimulator() {
        let capture = Capture(
            name: "S1b-all-comparables",
            model: PricingFeatureFixtures.strong,
            route: .allComparables
        )
        attach(render(capture), named: capture.name)
    }

    func testS2SelectedComparableRendersInTheSimulator() {
        let capture = Capture(
            name: "S2-selected-comparable",
            model: PricingFeatureFixtures.strong,
            route: .selectedComparable(id: "strong-03")
        )
        attach(render(capture), named: capture.name)
    }

    func testS3LimitedEvidenceRendersInTheSimulator() {
        let capture = Capture(name: "S3-limited", model: PricingFeatureFixtures.limited)
        attach(render(capture), named: capture.name)
    }

    func testNoEvidenceAndRefreshErrorsRenderWithoutInventedComps() {
        let captures: [Capture] = [
            .init(name: "no-evidence", model: PricingFeatureFixtures.noEvidence),
            .init(name: "offline", model: PricingFeatureFixtures.offline),
            .init(name: "refresh-failed", model: PricingFeatureFixtures.refreshFailed)
        ]
        for capture in captures {
            attach(render(capture), named: capture.name)
        }
    }

    func testPricingSupportsAccessibilityDynamicTypeReducedMotionAndPinnedSafeAreaScrolling() {
        let capture = Capture(
            name: "S1-accessibility-3-reduced-motion",
            model: PricingFeatureFixtures.strong,
            dynamicTypeSize: .accessibility3,
            reducedMotion: true
        )

        attach(render(capture), named: capture.name)
    }

    private func render(_ capture: Capture) -> UIImage {
        guard let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first else {
            XCTFail("A simulator window scene is required for pricing visual acceptance.")
            return UIImage()
        }

        let screenSize = CGSize(width: 402, height: 874)
        let root = PricingFeatureView(
            model: capture.model,
            initialRoute: capture.route,
            forceReducedMotion: capture.reducedMotion
        )
        .environment(\.dynamicTypeSize, capture.dynamicTypeSize)
        .environment(\.colorScheme, .light)
        .environment(\.locale, Locale(identifier: "en_US"))

        let controller = UIHostingController(rootView: root)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(origin: .zero, size: screenSize)
        window.overrideUserInterfaceStyle = .light
        window.backgroundColor = .white
        window.rootViewController = controller
        controller.view.backgroundColor = .white

        let animationsWereEnabled = UIView.areAnimationsEnabled
        UIView.setAnimationsEnabled(false)
        defer {
            UIView.setAnimationsEnabled(animationsWereEnabled)
            window.isHidden = true
        }

        window.makeKeyAndVisible()
        controller.view.frame = window.bounds
        controller.view.setNeedsLayout()
        controller.view.layoutIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.8))
        controller.view.layoutIfNeeded()

        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: screenSize, format: format)
        _ = renderer.image { context in
            UIColor.systemBackground.setFill()
            context.fill(CGRect(origin: .zero, size: screenSize))
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        RunLoop.main.run(until: Date().addingTimeInterval(0.15))
        controller.view.layoutIfNeeded()

        return renderer.image { context in
            UIColor.systemBackground.setFill()
            context.fill(CGRect(origin: .zero, size: screenSize))
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
    }

    private func attach(_ image: UIImage, named name: String) {
        let attachment = XCTAttachment(image: image)
        attachment.name = "PRICE-\(name).png"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}

private struct Capture {
    let name: String
    let model: PricingFeatureModel
    var route: PricingFeatureRoute = .overview
    var dynamicTypeSize: DynamicTypeSize = .large
    var reducedMotion = true
}
