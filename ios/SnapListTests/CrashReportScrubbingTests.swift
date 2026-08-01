import XCTest
@testable import SnapList

final class CrashReportScrubbingTests: XCTestCase {
    private static let photoPath = "/var/mobile/Containers/Data/Application/"
        + "6C1B9F0E-1D53-4E2A-9B44-1F0B2C7D8E90/Documents/captures/"
        + "item-42/photo-1.heic"
    private static let listingTitle =
        "Nintendo Switch OLED with Zelda bundle, boxed"
    private static let listingDescription =
        "Barely used, original box and inserts, one small scuff on the dock."
    private static let ebayToken =
        "v^1.1#i^1#f^0#r^0#I^3#p^3#t^H4sIAAAAAAAAAOVYa2wURRzv9UWLQCJI"
    private static let sellerEmail = "seller@example.com"

    /// The contract's representative payload: a captured-photo path, seller
    /// listing text, and a token-shaped string. None may survive `beforeSend`.
    func testScrubbingRemovesPhotoPathsListingTextAndTokens() {
        let event = CrashReportEvent(
            message: "Pricing failed for \(Self.listingTitle)",
            exceptionValues: [
                "Fatal error: could not read \(Self.photoPath)",
            ],
            breadcrumbs: [
                CrashReportBreadcrumb(
                    category: "http",
                    message: "POST /api/mobile/runs "
                        + "Authorization=Bearer \(Self.ebayToken)",
                    data: ["url": "https://api.ebay.com?token=\(Self.ebayToken)"]
                ),
            ],
            tags: ["listing_title": Self.listingTitle, "environment": "testflight"],
            extra: [
                "listing_description": Self.listingDescription,
                "photo_path": Self.photoPath,
            ],
            contexts: [
                "app": ["app_identifier": "dev.snaplist.ios"],
                "listing": ["title": Self.listingTitle],
            ],
            user: CrashReportUser(
                userID: "user_2abc",
                email: Self.sellerEmail,
                username: "aziz",
                ipAddress: "203.0.113.7"
            ),
            requestURL: "https://api.snaplist.dev/runs?token=\(Self.ebayToken)"
        )

        let scrubbed = CrashReportScrubber().scrub(event)

        let forbidden = [
            Self.photoPath,
            Self.listingTitle,
            Self.listingDescription,
            Self.ebayToken,
            Self.sellerEmail,
        ]
        let survivingText = scrubbed.allText.joined(separator: "\n")
        for secret in forbidden {
            XCTAssertFalse(
                survivingText.contains(secret),
                "scrubbed event still carries \(secret)"
            )
        }
    }

    /// A scrubber that erased everything would pass the absence assertions
    /// above, so the diagnostic skeleton a crash report exists for must
    /// survive alongside the removals.
    func testScrubbingKeepsTheDiagnosticSkeleton() {
        let event = CrashReportEvent(
            exceptionValues: ["Fatal error: index out of range"],
            breadcrumbs: [
                CrashReportBreadcrumb(
                    category: "ui.lifecycle",
                    message: "Scan submitted",
                    data: [:]
                ),
            ],
            tags: ["environment": "testflight"],
            contexts: ["app": ["app_identifier": "dev.snaplist.ios"]]
        )

        let scrubbed = CrashReportScrubber().scrub(event)

        XCTAssertEqual(
            scrubbed.exceptionValues,
            ["Fatal error: index out of range"]
        )
        XCTAssertEqual(scrubbed.breadcrumbs.first?.category, "ui.lifecycle")
        XCTAssertEqual(scrubbed.breadcrumbs.first?.message, "Scan submitted")
        XCTAssertEqual(scrubbed.tags["environment"], "testflight")
        XCTAssertEqual(
            scrubbed.contexts["app"]?["app_identifier"],
            "dev.snaplist.ios"
        )
    }
}

final class CrashReportingLaunchPolicyTests: XCTestCase {
    /// Structurally valid and deliberately not a real project's DSN.
    private static let dsn = "https://examplepublickey@o0.ingest.us.sentry.io/0"

    private func decide(
        dsn: String? = CrashReportingLaunchPolicyTests.dsn,
        isDebugBuild: Bool = false,
        hasSandboxAppStoreReceipt: Bool = false,
        hasLoadedXCTest: Bool = false
    ) -> CrashReportingLaunchDecision? {
        CrashReportingLaunchPolicy.decide(
            dsnBundleValue: dsn,
            isDebugBuild: isDebugBuild,
            hasSandboxAppStoreReceipt: hasSandboxAppStoreReceipt,
            hasLoadedXCTest: hasLoadedXCTest
        )
    }

    func testEnvironmentTagDistinguishesDebugTestFlightAndAppStore() {
        XCTAssertEqual(
            CrashReportingLaunchPolicy.resolveEnvironment(
                isDebugBuild: true,
                hasSandboxAppStoreReceipt: false
            ),
            .local
        )
        XCTAssertEqual(
            CrashReportingLaunchPolicy.resolveEnvironment(
                isDebugBuild: false,
                hasSandboxAppStoreReceipt: true
            ),
            .testFlight
        )
        XCTAssertEqual(
            CrashReportingLaunchPolicy.resolveEnvironment(
                isDebugBuild: false,
                hasSandboxAppStoreReceipt: false
            ),
            .production
        )
        // A debug build resolves to `local` but is not permitted to transmit,
        // so the two channels that do reach Sentry stay distinguishable there.
        XCTAssertEqual(
            decide(hasSandboxAppStoreReceipt: true)?.environment,
            .testFlight
        )
        XCTAssertEqual(
            decide(hasSandboxAppStoreReceipt: false)?.environment,
            .production
        )
    }

    /// A unit test is caught by its own signal. A UI test is caught by the
    /// configuration: XCUITest drives the app out of process and leaves no
    /// marker in it, so Debug is the only honest signal, and the scheme's
    /// TestAction builds Debug.
    func testUnitAndUITestRunsDoNotStartCrashReporting() {
        XCTAssertNil(decide(hasLoadedXCTest: true))
        XCTAssertNil(decide(isDebugBuild: true))
        XCTAssertNil(decide(isDebugBuild: true, hasSandboxAppStoreReceipt: true))
    }

    func testAbsentOrMalformedConfigurationDoesNotStartCrashReporting() {
        XCTAssertNil(decide(dsn: nil))
        XCTAssertNil(decide(dsn: "   "))
        XCTAssertNil(decide(dsn: "$(SNAPLIST_SENTRY_DSN)"))
        XCTAssertNil(decide(dsn: "http://examplepublickey@o0.sentry.io/0"))
        XCTAssertNil(decide(dsn: "https://o0.ingest.us.sentry.io/0"))
        XCTAssertNil(decide(dsn: "https://examplepublickey@o0.ingest.us.sentry.io"))
    }

    func testValidConfigurationCarriesTheDSNThrough() {
        XCTAssertEqual(decide()?.dsn, Self.dsn)
    }
}
