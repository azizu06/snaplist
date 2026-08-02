import Sentry
import XCTest
@testable import SnapList

/// Drives the hook the SDK actually calls. Every test here builds a real
/// `Sentry.Event`, hands it to the `beforeSend` closure that
/// `CrashReporting.configure` installed on a real `Options`, and asserts on what
/// comes back — so nothing is proven about a stand-in that could drift from the
/// shipped path.
final class CrashReportScrubbingTests: XCTestCase {
    private static let photoPath = "/var/mobile/Containers/Data/Application/"
        + "6C1B9F0E-1D53-4E2A-9B44-1F0B2C7D8E90/Documents/captures/"
        + "item-42/photo-1.heic"
    private static let listingTitle =
        "Nintendo Switch OLED with Zelda bundle, boxed"
    private static let listingDescription =
        "Barely used, original box and inserts, one small scuff on the dock."
    private static let voiceTranscript =
        "It is my son's console, the joycons drift a little on the left stick."
    private static let ebayToken =
        "v^1.1#i^1#f^0#r^0#I^3#p^3#t^H4sIAAAAAAAAAOVYa2wURRzv9UWLQCJI"
    private static let sellerEmail = "seller@example.com"
    /// Structurally valid and deliberately not a real project's DSN.
    private static let dsn = "https://examplepublickey@o0.ingest.us.sentry.io/0"

    /// The seam under test: the closure the SDK will invoke, taken from the
    /// options object `configure` populated, not from a helper called directly.
    private func installedBeforeSend() throws -> (Event) -> Event? {
        let options = Options()
        CrashReporting.configure(
            options,
            with: CrashReportingLaunchDecision(
                dsn: Self.dsn,
                environment: .testFlight
            )
        )
        return try XCTUnwrap(options.beforeSend)
    }

    /// Assembles one event carrying seller content in every channel the issue
    /// names, in the shapes the SDK really produces: a `SentryRequest`, a
    /// `SentryUser`, breadcrumb `data`, an `NSError`-style exception with a
    /// populated `mechanism`, and a context section whose values are not all
    /// strings.
    private func sellerContentEvent() -> Event {
        let event = Event(level: .fatal)

        event.message = SentryMessage(
            formatted: "Pricing failed for \(Self.listingTitle)"
        )

        let exception = Exception(
            value: "Fatal error: could not read \(Self.photoPath)",
            type: "SnapListPipelineError"
        )
        let mechanism = Mechanism(type: "NSError")
        mechanism.desc = "The operation could not be completed. "
            + "url=https://api.snaplist.dev/runs?token=\(Self.ebayToken)"
        mechanism.data = [
            "NSErrorFailingURLKey":
                "https://api.snaplist.dev/runs?token=\(Self.ebayToken)",
            "listing_title": Self.listingTitle,
        ]
        exception.mechanism = mechanism
        event.exceptions = [exception]

        let breadcrumb = Breadcrumb(level: .info, category: "http")
        breadcrumb.message = "POST /api/mobile/runs "
            + "Authorization=Bearer \(Self.ebayToken)"
        breadcrumb.data = [
            "url": "https://api.ebay.com?token=\(Self.ebayToken)",
            "transcript": Self.voiceTranscript,
        ]
        event.breadcrumbs = [breadcrumb]

        event.tags = [
            "listing_title": Self.listingTitle,
            "environment": "testflight",
        ]
        event.extra = [
            "listing_description": Self.listingDescription,
            "photo_path": Self.photoPath,
        ]

        let user = User()
        user.userId = "user_2abc"
        user.email = Self.sellerEmail
        user.username = "aziz"
        user.ipAddress = "203.0.113.7"
        user.data = ["voice_transcript": Self.voiceTranscript]
        event.user = user

        let request = SentryRequest()
        request.url = "https://api.snaplist.dev/runs?token=\(Self.ebayToken)"
        request.headers = ["Authorization": "Bearer \(Self.ebayToken)"]
        event.request = request

        event.context = [
            "app": [
                "app_identifier": "dev.snaplist.ios",
                // An array of strings, the shape the SDK's own `view_names`
                // arrives in. Nothing here is secret, so it must come back
                // whole.
                "view_names": ["ListingReview", "PhotoReview"],
            ],
            "response": [
                "status_code": 502,
                // A nested dictionary and an array: neither is a string at the
                // top level, which is how a token rode out of a rewrite that
                // only looked one level down.
                "headers": ["Authorization": "Bearer \(Self.ebayToken)"],
                "cookies": ["session=\(Self.ebayToken)"],
            ],
            "listing": ["title": Self.listingTitle],
        ]

        return event
    }

    /// Every string the event would put on the wire. Reading the serialized
    /// form rather than a hand-picked field list is what makes the absence
    /// assertion total: a channel nobody thought to check cannot hide from it.
    private func transmittedText(of event: Event) -> String {
        func strings(in value: Any) -> [String] {
            switch value {
            case let text as String:
                return [text]
            case let nested as [String: Any]:
                return nested.flatMap { [$0.key] + strings(in: $0.value) }
            case let list as [Any]:
                return list.flatMap(strings(in:))
            default:
                return [String(describing: value)]
            }
        }
        return strings(in: event.serialize()).joined(separator: "\n")
    }

    func testInstalledHookRemovesSellerContentFromEveryChannel() throws {
        let beforeSend = try installedBeforeSend()

        let scrubbed = try XCTUnwrap(beforeSend(sellerContentEvent()))

        let survivingText = transmittedText(of: scrubbed)
        for secret in [
            Self.photoPath,
            Self.listingTitle,
            Self.listingDescription,
            Self.voiceTranscript,
            Self.ebayToken,
            Self.sellerEmail,
        ] {
            XCTAssertFalse(
                survivingText.contains(secret),
                "scrubbed event still transmits \(secret)"
            )
        }
    }

    func testInstalledHookRedactsBreadcrumbMessagesAndDropsTheirData() throws {
        let beforeSend = try installedBeforeSend()

        let scrubbed = try XCTUnwrap(beforeSend(sellerContentEvent()))

        let breadcrumb = try XCTUnwrap(scrubbed.breadcrumbs?.first)
        XCTAssertNil(breadcrumb.data)
        XCTAssertEqual(
            breadcrumb.message,
            "POST \(CrashReportScrubber.redactionPlaceholder) "
                + "Authorization=\(CrashReportScrubber.redactionPlaceholder)"
        )
        // The breadcrumb itself survives: dropping it would take the trail the
        // report exists to show.
        XCTAssertEqual(breadcrumb.category, "http")
    }

    func testInstalledHookDropsTheHTTPRequestAndUserContext() throws {
        let beforeSend = try installedBeforeSend()

        let scrubbed = try XCTUnwrap(beforeSend(sellerContentEvent()))

        XCTAssertNil(scrubbed.request)
        XCTAssertNil(scrubbed.user)
        XCTAssertNil(scrubbed.extra)
    }

    func testInstalledHookRedactsExceptionMessagesWithoutDroppingThem() throws {
        let beforeSend = try installedBeforeSend()

        let scrubbed = try XCTUnwrap(beforeSend(sellerContentEvent()))

        let exception = try XCTUnwrap(scrubbed.exceptions?.first)
        XCTAssertEqual(
            exception.value,
            "Fatal error: could not read "
                + CrashReportScrubber.redactionPlaceholder
        )
        XCTAssertEqual(exception.type, "SnapListPipelineError")
    }

    /// `SentryClient.exceptionForError` fills `mechanism.data` with the raw
    /// `NSError.userInfo` and `mechanism.desc` with the error's description, so
    /// a failing request URL and its token reach both.
    func testInstalledHookDropsMechanismDataAndRedactsItsDescription() throws {
        let beforeSend = try installedBeforeSend()

        let scrubbed = try XCTUnwrap(beforeSend(sellerContentEvent()))

        let mechanism = try XCTUnwrap(scrubbed.exceptions?.first?.mechanism)
        XCTAssertNil(mechanism.data)
        XCTAssertEqual(
            mechanism.desc,
            "The operation could not be completed. url="
                + CrashReportScrubber.redactionPlaceholder
        )
        // The grouping identity the mechanism exists for is untouched.
        XCTAssertEqual(mechanism.type, "NSError")
    }

    /// A context value is `Any`. Redacting only the string-typed ones let an
    /// array element and a nested header dictionary carry text out intact.
    func testInstalledHookRedactsNestedAndNonStringContextValues() throws {
        let beforeSend = try installedBeforeSend()

        let scrubbed = try XCTUnwrap(beforeSend(sellerContentEvent()))

        XCTAssertNil(scrubbed.context?["listing"])
        let app = try XCTUnwrap(scrubbed.context?["app"])
        XCTAssertEqual(app["app_identifier"] as? String, "dev.snaplist.ios")
        XCTAssertEqual(
            app["view_names"] as? [String],
            ["ListingReview", "PhotoReview"]
        )
        let response = try XCTUnwrap(scrubbed.context?["response"])
        XCTAssertEqual(
            (response["headers"] as? [String: Any])?["Authorization"] as? String,
            CrashReportScrubber.redactionPlaceholder
        )
        XCTAssertEqual(
            response["cookies"] as? [String],
            ["session=" + CrashReportScrubber.redactionPlaceholder]
        )
        // A measured number is not text and passes through as itself.
        XCTAssertEqual(response["status_code"] as? Int, 502)
    }

    func testInstalledHookKeepsOnlyApprovedTagsAndDropsTheMessage() throws {
        let beforeSend = try installedBeforeSend()

        let scrubbed = try XCTUnwrap(beforeSend(sellerContentEvent()))

        XCTAssertEqual(scrubbed.tags, ["environment": "testflight"])
        XCTAssertNil(scrubbed.message)
    }

    /// A scrubber that erased everything would pass every absence assertion
    /// above, so the diagnostic skeleton a crash report exists for must survive
    /// alongside the removals.
    func testInstalledHookKeepsTheDiagnosticSkeleton() throws {
        let beforeSend = try installedBeforeSend()
        let event = Event(level: .fatal)
        event.exceptions = [
            Exception(value: "Fatal error: index out of range", type: "EXC_BREAKPOINT"),
        ]
        let breadcrumb = Breadcrumb(level: .info, category: "ui.lifecycle")
        breadcrumb.message = "Scan submitted"
        event.breadcrumbs = [breadcrumb]
        event.tags = ["environment": "testflight"]
        event.context = ["app": ["app_identifier": "dev.snaplist.ios"]]

        let scrubbed = try XCTUnwrap(beforeSend(event))

        XCTAssertEqual(
            scrubbed.exceptions?.first?.value,
            "Fatal error: index out of range"
        )
        XCTAssertEqual(scrubbed.exceptions?.first?.type, "EXC_BREAKPOINT")
        XCTAssertEqual(scrubbed.breadcrumbs?.first?.category, "ui.lifecycle")
        XCTAssertEqual(scrubbed.breadcrumbs?.first?.message, "Scan submitted")
        XCTAssertEqual(scrubbed.tags?["environment"], "testflight")
        XCTAssertEqual(
            scrubbed.context?["app"]?["app_identifier"] as? String,
            "dev.snaplist.ios"
        )
    }

    /// The honest limit of pattern redaction, pinned so it stays a decision
    /// rather than a surprise: an exception value is kept because it is the
    /// crash reason, and free-form prose inside one matches no pattern. Nothing
    /// in SnapList interpolates seller text into a trap message today — every
    /// `preconditionFailure` reachable from the app names a fixture or a path,
    /// and paths are redacted. Closing this would mean dropping exception
    /// values wholesale, which would leave an unusable report.
    func testExceptionProseIsAKnownUnredactableChannel() throws {
        let beforeSend = try installedBeforeSend()
        let event = Event(level: .fatal)
        event.exceptions = [
            Exception(
                value: "Fatal error: price missing for \(Self.listingTitle)",
                type: "EXC_BREAKPOINT"
            ),
        ]

        let scrubbed = try XCTUnwrap(beforeSend(event))

        XCTAssertEqual(
            scrubbed.exceptions?.first?.value,
            "Fatal error: price missing for \(Self.listingTitle)"
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
