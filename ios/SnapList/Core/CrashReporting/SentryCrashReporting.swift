import Foundation
import Sentry

// MARK: - Launch policy

struct CrashReportingLaunchDecision: Equatable, Sendable {
    let dsn: String
    let environment: AnalyticsEnvironment
}

/// Decides whether crash reporting starts at all, and under which environment
/// tag. Every input is injected so the decision is provable without a device,
/// a bundle, or a running SDK.
enum CrashReportingLaunchPolicy {
    /// Which build channel produced this binary. Kept separate from `decide`
    /// because the two answer different questions: this one names the channel,
    /// `decide` says whether the channel may transmit.
    static func resolveEnvironment(
        isDebugBuild: Bool,
        hasSandboxAppStoreReceipt: Bool
    ) -> AnalyticsEnvironment {
        if isDebugBuild {
            return .local
        }
        return hasSandboxAppStoreReceipt ? .testFlight : .production
    }

    /// Returns `nil` when the build must not report. `beforeSend` protects the
    /// payload; this protects against sending anything at all.
    ///
    /// Debug builds never report, and that is what keeps UI test runs silent.
    /// A unit test is caught directly — the host app loads XCTest, so
    /// `hasLoadedXCTest` is true — but the app under a UI test does not: XCUITest
    /// drives it out of process through `testmanagerd` and injects nothing into
    /// it. Dumping the app's own environment under a UI test on Xcode 26.5
    /// confirms there is no marker to read: no `DYLD_INSERT_LIBRARIES`, no
    /// XCTest key, and the `TESTMANAGERD_*` sockets are present on an ordinary
    /// `simctl launch` too. The configuration is therefore the only honest
    /// signal, and the scheme's TestAction builds Debug.
    static func decide(
        dsnBundleValue: String?,
        isDebugBuild: Bool,
        hasSandboxAppStoreReceipt: Bool,
        hasLoadedXCTest: Bool
    ) -> CrashReportingLaunchDecision? {
        guard !isDebugBuild, !hasLoadedXCTest else {
            return nil
        }
        guard let dsn = usableDSN(dsnBundleValue) else {
            return nil
        }
        return CrashReportingLaunchDecision(
            dsn: dsn,
            environment: resolveEnvironment(
                isDebugBuild: isDebugBuild,
                hasSandboxAppStoreReceipt: hasSandboxAppStoreReceipt
            )
        )
    }

    /// An unset build setting reaches the bundle as the literal `$(NAME)`, and
    /// a DSN without a public key or project id would make the SDK send events
    /// nowhere. Both fail closed rather than starting a reporter that cannot
    /// deliver.
    static func usableDSN(_ value: String?) -> String? {
        let dsn = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let dsn, !dsn.isEmpty, !dsn.hasPrefix("$(") else {
            return nil
        }
        guard let components = URLComponents(string: dsn),
              components.scheme == "https",
              let publicKey = components.user, !publicKey.isEmpty,
              components.password == nil,
              let host = components.host, !host.isEmpty,
              components.path.range(
                  of: #"^/[0-9]+$"#,
                  options: .regularExpression
              ) != nil else {
            return nil
        }
        return dsn
    }
}

// MARK: - Scrubbing

/// Removes seller content from a crash report before it leaves the device.
///
/// Free-form values are dropped wholesale because no pattern can recognize a
/// listing title. Exception types and stack frames, breadcrumb metadata, and
/// approved SDK-authored tags and contexts retain the diagnostic skeleton used
/// for symbolication and default grouping.
///
/// This operates on the SDK's own `Event` rather than a provider-neutral copy.
/// A parallel value type would be the thing the tests could reach, and the two
/// would then be free to disagree about the same input — which is exactly the
/// bug this shape removes. `beforeSend` calls `scrub(_:)` and nothing else, so
/// a test that drives `scrub(_:)` is driving what ships.
struct CrashReportScrubber: Sendable {
    static let redactionPlaceholder = "<redacted>"

    /// Tag keys the SDK and SnapList's own metadata own. Anything else is a
    /// caller-supplied value and cannot be trusted to exclude seller content.
    static let approvedTagNames: Set<String> = [
        "environment",
        "app_version",
        "app_build",
        "dist",
        "release",
        "level",
        "handled",
        "mechanism",
        "os.name",
        "device.family",
        "device.model",
    ]

    /// Context sections the Sentry SDK populates from the device and bundle.
    static let approvedContextNames: Set<String> = [
        "app",
        "device",
        "os",
        "culture",
        "trace",
        "response",
    ]

    /// Rewrites `event` in place and returns it, which is the contract
    /// `beforeSend` expects.
    @discardableResult
    func scrub(_ event: Event) -> Event {
        event.message = nil

        for exception in event.exceptions ?? [] {
            exception.value = nil
            // `mechanism.data` is the raw `NSError.userInfo` and `desc` is the
            // error's free-form description. Neither is required when the
            // mechanism type and stack frames remain available.
            exception.mechanism?.data = nil
            exception.mechanism?.desc = nil
        }

        for breadcrumb in event.breadcrumbs ?? [] {
            breadcrumb.message = nil
            breadcrumb.data = nil
        }

        event.fingerprint = nil
        event.transaction = nil
        event.logger = nil
        event.modules = nil
        event.tags = (event.tags ?? [:]).filter {
            Self.approvedTagNames.contains($0.key)
        }
        event.extra = nil
        event.user = nil
        event.request = nil
        event.context = (event.context ?? [:])
            .filter { Self.approvedContextNames.contains($0.key) }
            .mapValues { $0.mapValues(redactAny) }
        return event
    }

    /// A context field is `Any`, and only some of the shapes it arrives in are
    /// strings: `app.view_names` is an array, an HTTP `response` section nests a
    /// header dictionary, and both would carry text out untouched if only the
    /// top level were redacted. Numbers, booleans, and dates are SDK
    /// measurements and pass through as themselves.
    private func redactAny(_ value: Any) -> Any {
        switch value {
        case let text as String:
            return redact(text)
        case let url as URL:
            return redact(url.absoluteString)
        case let nested as [String: Any]:
            return nested.mapValues(redactAny)
        case let list as [Any]:
            return list.map(redactAny)
        default:
            return value
        }
    }

    /// Applied in order: structured carriers first, so a token embedded in a
    /// URL is not half-consumed by the generic opaque-run rule that follows.
    private static let redactionPatterns: [String] = [
        // Web URLs, including any query string carrying a token.
        #"[a-zA-Z][a-zA-Z0-9+.-]*://[^\s"'<>]+"#,
        // Absolute file paths, which is how a captured photo would appear.
        #"/(?:[A-Za-z0-9_.~%+-]+/)+[A-Za-z0-9_.~%+-]*"#,
        // Email addresses.
        #"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"#,
        // Authorization headers and their value.
        #"(?i)\b(?:bearer|basic)\s+\S+"#,
        // eBay OAuth application/user tokens.
        #"v\^\d+\.\d+#\S+"#,
        // JSON Web Tokens.
        #"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"#,
        // Publishable/secret key shapes used by Clerk, Stripe, and RevenueCat.
        #"\b(?:pk|sk|rk|appl)_[A-Za-z0-9_-]{8,}"#,
        // Any remaining long opaque run, which no legible crash reason needs.
        #"[A-Za-z0-9_+/=-]{32,}"#,
    ]

    private func redact(_ text: String) -> String {
        var redacted = text
        for pattern in Self.redactionPatterns {
            redacted = redacted.replacingOccurrences(
                of: pattern,
                with: Self.redactionPlaceholder,
                options: .regularExpression
            )
        }
        return redacted
    }
}

// MARK: - Sentry composition

/// Starts Sentry once at launch and installs the scrubbing hook. Everything
/// this type decides is delegated to `CrashReportingLaunchPolicy` and
/// `CrashReportScrubber`; the code here only reads real build state and maps
/// between the SDK's event object and the value those two are proven against.
enum CrashReporting {
    private static let scrubber = CrashReportScrubber()

    /// Returns the decision that was acted on, or `nil` when this build must
    /// not report. Safe to call unconditionally at launch.
    @discardableResult
    static func start(bundle: Bundle = .main) -> CrashReportingLaunchDecision? {
        guard let decision = CrashReportingLaunchPolicy.decide(
            dsnBundleValue: bundle.object(
                forInfoDictionaryKey: "SnapListSentryDSN"
            ) as? String,
            isDebugBuild: isDebugBuild,
            hasSandboxAppStoreReceipt:
                bundle.appStoreReceiptURL?.lastPathComponent
                    == "sandboxReceipt",
            hasLoadedXCTest: NSClassFromString("XCTestCase") != nil
        ) else {
            return nil
        }

        SentrySDK.start { options in
            configure(options, with: decision)
        }
        return decision
    }

    static func configure(
        _ options: Options,
        with decision: CrashReportingLaunchDecision
    ) {
        options.dsn = decision.dsn
        options.environment = decision.environment.rawValue

        // Crash and error reporting only. Performance tracing, profiling, and
        // session replay stay off; replay's own sample rates already default
        // to zero and are not re-enabled anywhere.
        options.enableAutoPerformanceTracing = false
        options.tracesSampleRate = 0
        options.enableUserInteractionTracing = false
        options.enableMetricKit = false

        // Nothing that could carry a captured photo or seller text into an
        // event may be collected in the first place. Screenshots and view
        // hierarchies would contain the photos directly; network and file
        // instrumentation would put URLs, tokens, and container paths into
        // breadcrumbs. Swizzling is what feeds all of the latter.
        options.sendDefaultPii = false
        options.attachScreenshot = false
        options.attachViewHierarchy = false
        options.enableSwizzling = false
        options.enableNetworkTracking = false
        options.enableNetworkBreadcrumbs = false
        options.enableCaptureFailedRequests = false
        options.enableFileIOTracing = false
        options.enableCoreDataTracing = false

        // The last gate: whatever the SDK still assembled is rewritten before
        // it is handed to the transport. `scrubber.scrub` is the whole hook, so
        // driving this closure in a test drives the shipped scrubbing.
        options.beforeSend = { event in
            scrubber.scrub(event)
        }
    }

    private static var isDebugBuild: Bool {
#if DEBUG
        true
#else
        false
#endif
    }
}
