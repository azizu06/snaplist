import Foundation
import Sentry

// MARK: - Provider-neutral crash report shape

/// The seller-visible identity Sentry can attach to an event. SnapList never
/// sends any of it, so the scrubber drops the whole value; the type exists so
/// the scrubbing contract can be tested without linking the Sentry SDK.
struct CrashReportUser: Equatable, Sendable {
    var userID: String?
    var email: String?
    var username: String?
    var ipAddress: String?
}

struct CrashReportBreadcrumb: Equatable, Sendable {
    var category: String?
    var message: String?
    var data: [String: String]

    init(
        category: String? = nil,
        message: String? = nil,
        data: [String: String] = [:]
    ) {
        self.category = category
        self.message = message
        self.data = data
    }
}

/// Every text-bearing field of a Sentry event that SnapList or the SDK can
/// populate with app-supplied content. Stack frames are deliberately absent:
/// their paths are compile-time source paths, never captured-photo paths, and
/// redacting them would destroy the symbolication the report exists for.
struct CrashReportEvent: Equatable, Sendable {
    var message: String?
    var exceptionValues: [String]
    var breadcrumbs: [CrashReportBreadcrumb]
    var tags: [String: String]
    var extra: [String: String]
    var contexts: [String: [String: String]]
    var user: CrashReportUser?
    var requestURL: String?

    init(
        message: String? = nil,
        exceptionValues: [String] = [],
        breadcrumbs: [CrashReportBreadcrumb] = [],
        tags: [String: String] = [:],
        extra: [String: String] = [:],
        contexts: [String: [String: String]] = [:],
        user: CrashReportUser? = nil,
        requestURL: String? = nil
    ) {
        self.message = message
        self.exceptionValues = exceptionValues
        self.breadcrumbs = breadcrumbs
        self.tags = tags
        self.extra = extra
        self.contexts = contexts
        self.user = user
        self.requestURL = requestURL
    }

    /// Every string the event would transmit, so a test can assert that a
    /// forbidden value survives nowhere rather than field by field.
    var allText: [String] {
        var values: [String] = []
        if let message {
            values.append(message)
        }
        values.append(contentsOf: exceptionValues)
        for breadcrumb in breadcrumbs {
            breadcrumb.category.map { values.append($0) }
            breadcrumb.message.map { values.append($0) }
            values.append(contentsOf: breadcrumb.data.keys)
            values.append(contentsOf: breadcrumb.data.values)
        }
        values.append(contentsOf: tags.keys)
        values.append(contentsOf: tags.values)
        values.append(contentsOf: extra.keys)
        values.append(contentsOf: extra.values)
        for (name, context) in contexts {
            values.append(name)
            values.append(contentsOf: context.keys)
            values.append(contentsOf: context.values)
        }
        if let user {
            values.append(
                contentsOf: [
                    user.userID, user.email, user.username, user.ipAddress,
                ].compactMap { $0 }
            )
        }
        if let requestURL {
            values.append(requestURL)
        }
        return values
    }
}

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
/// Two rules, chosen by who authors the field. Fields SnapList or the network
/// stack populate with arbitrary values — `extra`, `user`, `request`, breadcrumb
/// `data`, and unapproved `tags`/`contexts` — are dropped wholesale, because no
/// pattern can recognise a listing title. Fields that carry the crash reason
/// itself survive with paths, URLs, tokens, and addresses redacted, because
/// dropping them would leave an unusable report.
struct CrashReportScrubber: Sendable {
    static let redactionPlaceholder = "<redacted>"

    /// `SentrySDK.capture(message:)` has no call site in SnapList today. When
    /// one is added, put its exact static identifier here — a message that is
    /// not listed cannot be proven free of seller text, so it is dropped.
    static let approvedMessages: Set<String> = []

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

    func scrub(_ event: CrashReportEvent) -> CrashReportEvent {
        var scrubbed = event
        scrubbed.message = event.message.flatMap {
            Self.approvedMessages.contains($0) ? $0 : nil
        }
        scrubbed.exceptionValues = event.exceptionValues.map(redact)
        scrubbed.breadcrumbs = event.breadcrumbs.map { breadcrumb in
            CrashReportBreadcrumb(
                category: breadcrumb.category,
                message: breadcrumb.message.map(redact),
                data: [:]
            )
        }
        scrubbed.tags = event.tags.filter {
            Self.approvedTagNames.contains($0.key)
        }
        scrubbed.extra = [:]
        scrubbed.contexts = event.contexts
            .filter { Self.approvedContextNames.contains($0.key) }
            .mapValues { $0.mapValues(redact) }
        scrubbed.user = nil
        scrubbed.requestURL = nil
        return scrubbed
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

        options.beforeSend = { event in
            scrub(event)
        }
    }

    private static var isDebugBuild: Bool {
#if DEBUG
        true
#else
        false
#endif
    }

    /// The last gate: whatever the SDK still assembled is rewritten to the
    /// scrubbed value before it is handed to the transport.
    static func scrub(_ event: Event) -> Event {
        apply(scrubber.scrub(reportEvent(from: event)), to: event)
    }

    private static func reportEvent(from event: Event) -> CrashReportEvent {
        CrashReportEvent(
            message: event.message?.formatted,
            exceptionValues: (event.exceptions ?? []).map { $0.value ?? "" },
            breadcrumbs: (event.breadcrumbs ?? []).map { breadcrumb in
                CrashReportBreadcrumb(
                    category: breadcrumb.category,
                    message: breadcrumb.message,
                    data: (breadcrumb.data ?? [:])
                        .mapValues { String(describing: $0) }
                )
            },
            tags: event.tags ?? [:],
            extra: (event.extra ?? [:]).mapValues { String(describing: $0) },
            contexts: (event.context ?? [:])
                .mapValues { $0.mapValues { String(describing: $0) } },
            user: event.user.map {
                CrashReportUser(
                    userID: $0.userId,
                    email: $0.email,
                    username: $0.username,
                    ipAddress: $0.ipAddress
                )
            },
            requestURL: event.request?.url
        )
    }

    private static func apply(
        _ scrubbed: CrashReportEvent,
        to event: Event
    ) -> Event {
        event.message = scrubbed.message.map { SentryMessage(formatted: $0) }

        for (index, exception) in (event.exceptions ?? []).enumerated()
        where exception.value != nil
            && index < scrubbed.exceptionValues.count {
            exception.value = scrubbed.exceptionValues[index]
        }

        for (index, breadcrumb) in (event.breadcrumbs ?? []).enumerated()
        where index < scrubbed.breadcrumbs.count {
            breadcrumb.message = scrubbed.breadcrumbs[index].message
            breadcrumb.data = nil
        }

        event.tags = scrubbed.tags
        event.extra = nil
        event.user = nil
        event.request = nil
        // Non-string context values are SDK-measured numbers and booleans; only
        // the string ones can carry text, so only those take the redacted form.
        event.context = (event.context ?? [:]).reduce(
            into: [String: [String: Any]]()
        ) { result, section in
            guard let redacted = scrubbed.contexts[section.key] else {
                return
            }
            result[section.key] = section.value.reduce(
                into: [String: Any]()
            ) { fields, field in
                guard field.value is String,
                      let replacement = redacted[field.key] else {
                    fields[field.key] = field.value
                    return
                }
                fields[field.key] = replacement
            }
        }
        return event
    }
}
