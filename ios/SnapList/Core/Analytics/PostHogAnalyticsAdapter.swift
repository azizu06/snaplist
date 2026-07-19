import Foundation
import PostHog

enum PostHogAnalyticsConfiguration {
    static func makeConfig(
        route: AnalyticsProviderRoute,
        metadata: AnalyticsMetadata,
        urlSessionConfiguration: URLSessionConfiguration? = nil
    ) -> PostHogConfig {
        precondition(route.environment == metadata.environment)
        let config = PostHogConfig(
            projectToken: route.projectToken,
            host: route.host.absoluteString
        )

        config.optOut = true
        config.maxQueueSize = 256
        config.flushAt = 20
        config.maxBatchSize = 20
        config.captureApplicationLifecycleEvents = false
        config.captureScreenViews = false
        config.enableSwizzling = false
        config.captureElementInteractions = false
        config.sessionReplay = false
        config.sessionReplayConfig.captureNetworkTelemetry = false
        config.sessionReplayConfig.captureLogs = false
        config.sessionReplayConfig.screenshotMode = false
        config.errorTrackingConfig.autoCapture = false
        config.errorTrackingConfig.exceptionSteps.enabled = false
        config.preloadFeatureFlags = false
        config.sendFeatureFlagEvent = false
        config.setDefaultPersonProperties = false
        config.tracingHeaders = nil
        config.rageClickConfig.enabled = false
        config.surveys = false
        config.debug = false
        let sessionConfiguration = (urlSessionConfiguration?.copy() as? URLSessionConfiguration)
            ?? URLSessionConfiguration.default
        var protocolClasses = sessionConfiguration.protocolClasses ?? []
        protocolClasses.removeAll { $0 == AnalyticsPostHogNetworkFirewallURLProtocol.self }
        protocolClasses.insert(AnalyticsPostHogNetworkFirewallURLProtocol.self, at: 0)
        sessionConfiguration.protocolClasses = protocolClasses
        config.urlSessionConfiguration = sessionConfiguration
        config.reuseAnonymousId = false
        config.personProfiles = .identifiedOnly
        config.logs.setBeforeSend { _ in nil }
        config.setBeforeSend { event in
            guard let sanitized = AnalyticsSanitizer().sanitizeProviderEvent(
                name: event.event,
                distinctID: event.distinctId,
                properties: event.properties,
                metadata: metadata
            ) else {
                return nil
            }
            event.properties = sanitized
            return event
        }
        return config
    }
}

final class PostHogSDKTransport: AnalyticsTransport {
    private let sdk: PostHogSDK
    private let storageURL: URL

    init?(
        route: AnalyticsProviderRoute,
        metadata: AnalyticsMetadata,
        urlSessionConfiguration: URLSessionConfiguration? = nil
    ) {
        guard route.environment == metadata.environment else { return nil }
        storageURL = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(Bundle.main.bundleIdentifier ?? "com.posthog.unknown")
            .appendingPathComponent(route.projectToken)
        sdk = PostHogSDK.with(
            PostHogAnalyticsConfiguration.makeConfig(
                route: route,
                metadata: metadata,
                urlSessionConfiguration: urlSessionConfiguration
            )
        )
    }

    func setConsent(granted: Bool) throws {
        if granted {
            sdk.optIn()
        } else {
            sdk.optOut()
        }
    }

    func revokeConsent() throws {
        sdk.optOut()
        sdk.close()
        if FileManager.default.fileExists(atPath: storageURL.path) {
            try FileManager.default.removeItem(at: storageURL)
        }
    }

    func capture(_ payload: AnalyticsPayload) throws {
        sdk.capture(payload.name, properties: payload.properties)
    }

    func identify(clerkUserID: String) throws {
        sdk.identify(clerkUserID)
    }

    func flush() throws {
        sdk.flush()
    }

    func reset() throws {
        sdk.reset()
    }

    func close() {
        sdk.close()
    }
}

final class DebugAnalyticsTransport: AnalyticsTransport {
    private let log: (String) -> Void

    init(log: @escaping (String) -> Void = { print($0) }) {
        self.log = log
    }

    func setConsent(granted: Bool) throws {
        log("analytics consent \(granted ? "granted" : "disabled")")
    }

    func revokeConsent() throws {
        log("analytics consent revoked")
    }

    func capture(_ payload: AnalyticsPayload) throws {
        log("analytics event \(payload.name) keys=\(payload.properties.keys.sorted())")
    }

    func identify(clerkUserID: String) throws {
        log("analytics identify accepted")
    }

    func flush() throws {
        log("analytics flush")
    }

    func reset() throws {
        log("analytics reset")
    }
}

private final class AnalyticsPostHogNetworkFirewallURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.path.hasSuffix("/batch") == false
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url,
              let response = HTTPURLResponse(
                  url: url,
                  statusCode: 200,
                  httpVersion: nil,
                  headerFields: nil
              ) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class DebugAnalyticsClient: AnalyticsClient {
    private let client: PostHogAnalyticsClient

    init(
        metadata: AnalyticsMetadata,
        consentStore: any AnalyticsConsentStoring,
        dedupeStore: any AnalyticsDedupeStoring,
        log: @escaping (String) -> Void = { print($0) }
    ) {
        client = PostHogAnalyticsClient(
            metadata: metadata,
            consentStore: consentStore,
            dedupeStore: dedupeStore,
            transportFactory: { DebugAnalyticsTransport(log: log) }
        )
    }

    func capture(_ event: AnalyticsEvent) { client.capture(event) }
    func screen(_ screen: AnalyticsScreen) { client.screen(screen) }
    func identify(clerkUserID: String) { client.identify(clerkUserID: clerkUserID) }
    func reset() { client.reset() }
    func setConsent(_ consent: AnalyticsConsent) { client.setConsent(consent) }
    func flush() { client.flush() }

    @discardableResult
    func waitUntilIdleForTesting(timeout: TimeInterval = 2) -> Bool {
        client.waitUntilIdleForTesting(timeout: timeout)
    }
}
