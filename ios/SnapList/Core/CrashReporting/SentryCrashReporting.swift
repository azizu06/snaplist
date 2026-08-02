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
    /// Tag keys whose values have a finite, non-seller-controlled shape. A
    /// known key alone is not safe: callers can still put listing text or file
    /// paths in its value.
    static let approvedTagNames: Set<String> = [
        "environment",
        "app_version",
        "app_build",
        "dist",
        "release",
        "level",
        "handled",
        "os.name",
        "device.family",
        "device.model",
    ]

    /// Each context's finite field allowlist. The value validator below is a
    /// second mandatory gate: adding a name here without a matching switch arm
    /// still drops it through `default`.
    static let approvedContextFieldNames: [String: Set<String>] = [
        "app": [
            "app_identifier", "app_version", "app_build", "in_foreground", "is_active",
        ],
        "device": [
            "family", "arch", "model", "simulator", "low_power_mode", "charging",
            "thermal_state", "orientation", "battery_level", "processor_count",
            "free_memory", "usable_memory", "memory_size", "free_storage", "storage_size",
            "screen_height_pixels", "screen_width_pixels",
        ],
        "os": ["name", "version", "build", "rooted"],
    ]

    /// Rewrites `event` in place and returns it, which is the contract
    /// `beforeSend` expects.
    @discardableResult
    func scrub(_ event: Event) -> Event {
        event.message = nil
        event.serverName = nil

        scrub(event.stacktrace)
        for thread in event.threads ?? [] {
            scrub(thread.stacktrace)
        }

        for exception in event.exceptions ?? [] {
            exception.value = nil
            // `mechanism.data` is the raw `NSError.userInfo` and `desc` is the
            // error's free-form description. Neither is required when the
            // mechanism type and stack frames remain available.
            exception.mechanism?.data = nil
            exception.mechanism?.desc = nil
            scrub(exception.stacktrace)
        }

        for breadcrumb in event.breadcrumbs ?? [] {
            breadcrumb.message = nil
            breadcrumb.data = nil
        }

        event.fingerprint = nil
        event.transaction = nil
        event.logger = nil
        event.modules = nil
        event.tags = (event.tags ?? [:]).reduce(into: [:]) { tags, tag in
            guard let value = Self.approvedTagValue(
                tag.value,
                for: tag.key
            ) else {
                return
            }
            tags[tag.key] = value
        }
        event.extra = nil
        event.user = nil
        event.request = nil
        event.context = (event.context ?? [:]).reduce(into: [:]) {
            contexts,
            section
            in
            let approvedFields = section.value.reduce(into: [String: Any]()) { fields, field in
                guard let value = Self.approvedContextValue(
                    field.value,
                    in: section.key,
                    named: field.key
                ) else {
                    return
                }
                fields[field.key] = value
            }
            guard !approvedFields.isEmpty else {
                return
            }
            contexts[section.key] = approvedFields
        }
        return event
    }

    /// `SentryFrame.vars` serializes arbitrary values. Clear every stacktrace
    /// model the pinned SDK serializes rather than attempting to recognize
    /// seller content inside a frame-local dictionary.
    private func scrub(_ stacktrace: SentryStacktrace?) {
        for frame in stacktrace?.frames ?? [] {
            frame.vars = nil
        }
    }

    /// Retains only values from fixed diagnostic domains. Any new tag name or
    /// value shape fails closed until it is explicitly reviewed here.
    private static func approvedTagValue(
        _ value: String,
        for name: String
    ) -> String? {
        guard approvedTagNames.contains(name) else {
            return nil
        }

        let accepted: Bool
        switch name {
        case "environment":
            accepted = ["local", "testflight", "production"].contains(value)
        case "app_version":
            accepted = matches(value, #"^[0-9]+\.[0-9]+\.[0-9]+$"#)
        case "app_build", "dist":
            accepted = matches(value, #"^[0-9]{1,12}$"#)
        case "release":
            accepted = matches(
                value,
                #"^dev\.snaplist\.ios@[0-9]+\.[0-9]+\.[0-9]+(?:\+[0-9]+)?$"#
            )
        case "level":
            accepted = ["fatal", "error", "warning", "info", "debug"].contains(value)
        case "handled":
            accepted = ["true", "false"].contains(value)
        case "os.name", "device.family":
            accepted = value == "iOS"
        case "device.model":
            accepted = matches(value, #"^(?:iPhone|iPad|iPod)[0-9]+,[0-9]+$"#)
        default:
            accepted = false
        }
        return accepted ? value : nil
    }

    private static func matches(_ value: String, _ pattern: String) -> Bool {
        value.range(of: pattern, options: .regularExpression) != nil
    }

    /// Retains a finite diagnostic skeleton from SDK-populated contexts. Each
    /// rule validates both field name and value. `culture` carries localized
    /// device strings, `trace` can carry dynamic transaction names, and
    /// `response` can carry request-derived headers or bodies, so all three
    /// are dropped rather than pattern-redacted.
    private static func approvedContextValue(
        _ value: Any,
        in section: String,
        named field: String
    ) -> Any? {
        guard approvedContextFieldNames[section]?.contains(field) == true else {
            return nil
        }
        switch (section, field) {
        case ("app", "app_identifier"):
            return approvedString(value, matching: #"^dev\.snaplist\.ios$"#)
        case ("app", "app_version"):
            return approvedString(value, matching: #"^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$"#)
        case ("app", "app_build"):
            return approvedString(value, matching: #"^[0-9]{1,12}$"#)
        case ("app", "in_foreground"), ("app", "is_active"):
            return approvedBoolean(value)

        case ("device", "family"):
            return approvedEnum(value, ["iOS"])
        case ("device", "arch"):
            return approvedEnum(
                value,
                ["arm", "arm64", "arm64e", "armv6", "armv7", "armv7s", "armv8", "x86", "x86_64", "x86_64h"]
            )
        case ("device", "model"):
            return approvedString(
                value,
                matching: #"^(?:iPhone|iPad|iPod)[0-9]{1,2},[0-9]{1,2}$"#
            )
        case ("device", "simulator"), ("device", "low_power_mode"),
             ("device", "charging"):
            return approvedBoolean(value)
        case ("device", "thermal_state"):
            return approvedEnum(value, ["nominal", "fair", "serious", "critical"])
        case ("device", "orientation"):
            return approvedEnum(value, ["portrait", "landscape"])
        case ("device", "battery_level"):
            return approvedInteger(value, minimum: 0, maximum: 100)
        case ("device", "processor_count"):
            return approvedInteger(value, minimum: 1, maximum: 1_024)
        case ("device", "free_memory"), ("device", "usable_memory"),
             ("device", "memory_size"), ("device", "free_storage"),
             ("device", "storage_size"):
            return approvedInteger(value, minimum: 0, maximum: 1 << 60)
        case ("device", "screen_height_pixels"), ("device", "screen_width_pixels"):
            return approvedInteger(value, minimum: 1, maximum: 20_000)

        case ("os", "name"):
            return approvedEnum(value, ["iOS"])
        case ("os", "version"):
            return approvedString(value, matching: #"^[0-9]{1,2}(?:\.[0-9]{1,2}){1,2}$"#)
        case ("os", "build"):
            return approvedString(value, matching: #"^[0-9]{2}[A-Z][0-9]{1,5}[a-z]?$"#)
        case ("os", "rooted"):
            return approvedBoolean(value)

        default:
            return nil
        }
    }

    private static func approvedString(_ value: Any, matching pattern: String) -> String? {
        guard let string = value as? String, matches(string, pattern) else {
            return nil
        }
        return string
    }

    private static func approvedEnum(_ value: Any, _ values: Set<String>) -> String? {
        guard let string = value as? String, values.contains(string) else {
            return nil
        }
        return string
    }

    private static func approvedBoolean(_ value: Any) -> Bool? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) == CFBooleanGetTypeID() else {
            return nil
        }
        return number.boolValue
    }

    private static func approvedInteger(
        _ value: Any,
        minimum: Int64,
        maximum: Int64
    ) -> NSNumber? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite,
              number.doubleValue.rounded() == number.doubleValue,
              number.doubleValue >= Double(minimum),
              number.doubleValue <= Double(maximum) else {
            return nil
        }
        return number
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
