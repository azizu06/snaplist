import CryptoKit
import Foundation
import PostHog

struct AnalyticsPostHogConfiguration: Equatable, Sendable {
    let metadata: AnalyticsMetadata
    let projectToken: String
    let host: URL
    let maxQueueSize: Int

    init?(
        metadata: AnalyticsMetadata,
        projectToken: String,
        host: URL,
        maxQueueSize: Int = 64
    ) {
        let tokenPattern = #"^[A-Za-z0-9_-]{1,256}$"#
        guard projectToken.range(of: tokenPattern, options: .regularExpression) != nil,
              host.scheme == "https",
              host.host != nil,
              host.path.isEmpty || host.path == "/",
              host.user == nil,
              host.password == nil,
              host.query == nil,
              host.fragment == nil else {
            return nil
        }
        self.metadata = metadata
        self.projectToken = projectToken
        self.host = host
        self.maxQueueSize = min(max(maxQueueSize, 1), 256)
    }

    var lifecycleIdentifier: String {
        let digest = SHA256.hash(data: Data(projectToken.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
        return digest
    }
}

protocol AnalyticsTransportLifecycleStoring: AnyObject {
    func requiresPurge(for configuration: AnalyticsPostHogConfiguration) -> Bool
    func markPurgeRequired(for configuration: AnalyticsPostHogConfiguration) throws
    func markPurged(for configuration: AnalyticsPostHogConfiguration) throws
}

final class InMemoryAnalyticsTransportLifecycleStore: AnalyticsTransportLifecycleStoring {
    private let lock = NSLock()
    private var requiredIdentifiers: Set<String> = []

    func requiresPurge(for configuration: AnalyticsPostHogConfiguration) -> Bool {
        lock.withLock { requiredIdentifiers.contains(configuration.lifecycleIdentifier) }
    }

    func markPurgeRequired(for configuration: AnalyticsPostHogConfiguration) {
        _ = lock.withLock { requiredIdentifiers.insert(configuration.lifecycleIdentifier) }
    }

    func markPurged(for configuration: AnalyticsPostHogConfiguration) {
        _ = lock.withLock { requiredIdentifiers.remove(configuration.lifecycleIdentifier) }
    }
}

final class FileAnalyticsTransportLifecycleStore: AnalyticsTransportLifecycleStoring {
    private struct Record: Codable {
        let purgeRequired: Bool
    }

    private let rootURL: URL
    private let fileManager: FileManager
    private let lock = NSLock()

    init(
        rootURL: URL? = nil,
        fileManager: FileManager = .default,
        bundle: Bundle = .main
    ) {
        let bundleIdentifier = bundle.bundleIdentifier ?? "com.snaplist.app"
        self.rootURL = rootURL
            ?? fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent(bundleIdentifier, isDirectory: true)
                .appendingPathComponent("snaplist.analytics.lifecycle", isDirectory: true)
        self.fileManager = fileManager
    }

    func requiresPurge(for configuration: AnalyticsPostHogConfiguration) -> Bool {
        lock.withLock {
            let url = recordURL(for: configuration)
            guard fileManager.fileExists(atPath: url.path) else { return false }
            guard let data = try? Data(contentsOf: url),
                  let record = try? JSONDecoder().decode(Record.self, from: data) else {
                return true
            }
            return record.purgeRequired
        }
    }

    func markPurgeRequired(for configuration: AnalyticsPostHogConfiguration) throws {
        try write(Record(purgeRequired: true), for: configuration)
    }

    func markPurged(for configuration: AnalyticsPostHogConfiguration) throws {
        try write(Record(purgeRequired: false), for: configuration)
    }

    private func write(
        _ record: Record,
        for configuration: AnalyticsPostHogConfiguration
    ) throws {
        try lock.withLock {
            try fileManager.createDirectory(
                at: rootURL,
                withIntermediateDirectories: true
            )
            let data = try JSONEncoder().encode(record)
            try data.write(to: recordURL(for: configuration), options: .atomic)
        }
    }

    private func recordURL(for configuration: AnalyticsPostHogConfiguration) -> URL {
        rootURL.appendingPathComponent(configuration.lifecycleIdentifier + ".json")
    }
}

protocol PostHogDurableDataPurging: AnyObject {
    func purge(configuration: AnalyticsPostHogConfiguration) throws
}

enum PostHogDurableDataPurgeError: Error {
    case storageRootUnavailable
    case queueStillExists
}

final class FileSystemPostHogDataPurger: PostHogDurableDataPurging {
    private let storageRoot: URL
    private let fileManager: FileManager

    init?(
        storageRoot: URL? = nil,
        fileManager: FileManager = .default,
        bundle: Bundle = .main
    ) {
        let bundleIdentifier = bundle.bundleIdentifier ?? "com.snaplist.app"
        if let storageRoot {
            self.storageRoot = storageRoot.standardizedFileURL
        } else {
            guard let applicationSupport = fileManager.urls(
                for: .applicationSupportDirectory,
                in: .userDomainMask
            ).first else {
                return nil
            }
            self.storageRoot = applicationSupport
                .appendingPathComponent(bundleIdentifier, isDirectory: true)
                .standardizedFileURL
        }
        self.fileManager = fileManager
    }

    func purge(configuration: AnalyticsPostHogConfiguration) throws {
        let tokenRoot = storageRoot
            .appendingPathComponent(configuration.projectToken, isDirectory: true)
            .standardizedFileURL
        guard tokenRoot.deletingLastPathComponent() == storageRoot else {
            throw PostHogDurableDataPurgeError.storageRootUnavailable
        }
        if fileManager.fileExists(atPath: tokenRoot.path) {
            try fileManager.removeItem(at: tokenRoot)
        }
        guard !fileManager.fileExists(atPath: tokenRoot.path) else {
            throw PostHogDurableDataPurgeError.queueStillExists
        }
    }
}

final class PostHogNetworkGate: @unchecked Sendable {
    private let lock = NSLock()
    private let allowedScheme: String
    private let allowedHost: String
    private let allowedPort: Int
    private var granted = false
    private var tasks: [ObjectIdentifier: URLSessionTask] = [:]

    init(allowedOrigin: URL) {
        allowedScheme = allowedOrigin.scheme?.lowercased() ?? ""
        allowedHost = allowedOrigin.host?.lowercased() ?? ""
        allowedPort = Self.normalizedPort(for: allowedOrigin)
    }

    func allowsDestination(_ request: URLRequest) -> Bool {
        guard let url = request.url else { return false }
        return url.scheme?.lowercased() == allowedScheme
            && url.host?.lowercased() == allowedHost
            && Self.normalizedPort(for: url) == allowedPort
    }

    func grant() {
        lock.withLock { granted = true }
    }

    func revoke() {
        let tasksToCancel = lock.withLock { () -> [URLSessionTask] in
            granted = false
            let current = Array(tasks.values)
            tasks.removeAll()
            return current
        }
        tasksToCancel.forEach { $0.cancel() }
    }

    func register(_ task: URLSessionTask) -> Bool {
        lock.withLock {
            guard granted else { return false }
            tasks[ObjectIdentifier(task)] = task
            return true
        }
    }

    func finish(_ task: URLSessionTask) {
        _ = lock.withLock { tasks.removeValue(forKey: ObjectIdentifier(task)) }
    }

    private static func normalizedPort(for url: URL) -> Int {
        if let port = url.port { return port }
        return url.scheme?.lowercased() == "https" ? 443 : 80
    }
}

enum AnalyticsConsentTransitionError: Error {
    case superseded
}

final class AnalyticsConsentTransitionCoordinator: @unchecked Sendable {
    private let lock = NSLock()
    private var latestTicket: UInt64 = 0

    func register() -> UInt64 {
        lock.withLock {
            latestTicket &+= 1
            return latestTicket
        }
    }

    func isCurrent(_ ticket: UInt64) -> Bool {
        lock.withLock { latestTicket == ticket }
    }

    func commitGrant(
        ticket: UInt64,
        operation: () -> Void
    ) -> Bool {
        lock.withLock {
            guard latestTicket == ticket else { return false }
            operation()
            return true
        }
    }
}

protocol PostHogTransport: AnyObject {
    func capture(_ payload: AnalyticsPayload, distinctID: String) throws
    func identify(clerkUserID: String, anonymousID: String) throws
    func resetSession()
    func flush()
    func close()
}

protocol PostHogTransportBuilding: AnyObject {
    func makeTransport(
        configuration: AnalyticsPostHogConfiguration,
        networkGate: PostHogNetworkGate
    ) -> any PostHogTransport
}

final class PostHogSDKTransportFactory: PostHogTransportBuilding {
    static let approvedEventNames = AnalyticsSanitizer.approvedEventNames.union(["$identify"])
    static let approvedPropertyNamesByEvent: [String: Set<String>] = {
        var values = AnalyticsSanitizer.approvedPropertyNamesByEvent
        values["$identify"] = [
            "$anon_distinct_id",
            "environment",
            "app_version",
            "app_build",
        ]
        return values
    }()

    func makeTransport(
        configuration: AnalyticsPostHogConfiguration,
        networkGate: PostHogNetworkGate
    ) -> any PostHogTransport {
        let gateIdentifier = UUID().uuidString.lowercased()
        PostHogNetworkGateRegistry.shared.register(networkGate, identifier: gateIdentifier)

        let sdkConfiguration = makeSDKConfiguration(
            configuration: configuration,
            gateIdentifier: gateIdentifier
        )

        return PostHogSDKTransport(
            sdk: PostHogSDK.with(sdkConfiguration),
            gateIdentifier: gateIdentifier,
            networkGate: networkGate,
            metadata: configuration.metadata
        )
    }

    func makeSDKConfiguration(
        configuration: AnalyticsPostHogConfiguration,
        gateIdentifier: String
    ) -> PostHogConfig {
        let sdkConfiguration = PostHogConfig(
            projectToken: configuration.projectToken,
            host: configuration.host.absoluteString
        )
        sdkConfiguration.flushAt = min(20, configuration.maxQueueSize)
        sdkConfiguration.maxBatchSize = min(20, configuration.maxQueueSize)
        sdkConfiguration.maxQueueSize = configuration.maxQueueSize
        sdkConfiguration.captureApplicationLifecycleEvents = false
        sdkConfiguration.captureScreenViews = false
        sdkConfiguration.enableSwizzling = false
        sdkConfiguration.sendFeatureFlagEvent = false
        sdkConfiguration.preloadFeatureFlags = false
        sdkConfiguration.setDefaultPersonProperties = false
        sdkConfiguration.sessionReplay = false
        sdkConfiguration.sessionReplayConfig.captureNetworkTelemetry = false
        sdkConfiguration.sessionReplayConfig.captureLogs = false
        sdkConfiguration.errorTrackingConfig.autoCapture = false
        sdkConfiguration.errorTrackingConfig.exceptionSteps.enabled = false
        sdkConfiguration.captureElementInteractions = false
        sdkConfiguration.rageClickConfig.enabled = false
        sdkConfiguration.surveys = false
        sdkConfiguration.tracingHeaders = nil
        let sessionConfiguration = URLSessionConfiguration.ephemeral
        sessionConfiguration.httpAdditionalHeaders = [
            PostHogBatchOnlyURLProtocol.gateHeader: gateIdentifier,
        ]
        sessionConfiguration.protocolClasses = [PostHogBatchOnlyURLProtocol.self]
        sdkConfiguration.urlSessionConfiguration = sessionConfiguration

        sdkConfiguration.setBeforeSend { event in
            guard let approvedPropertyNames = Self.approvedPropertyNamesByEvent[event.event] else {
                return nil
            }
            event.properties = event.properties.filter {
                approvedPropertyNames.contains($0.key)
            }
            return event
        }
        return sdkConfiguration
    }
}

private final class PostHogSDKTransport: PostHogTransport {
    private let sdk: PostHogSDK
    private let gateIdentifier: String
    private let networkGate: PostHogNetworkGate
    private let metadata: AnalyticsMetadata

    init(
        sdk: PostHogSDK,
        gateIdentifier: String,
        networkGate: PostHogNetworkGate,
        metadata: AnalyticsMetadata
    ) {
        self.sdk = sdk
        self.gateIdentifier = gateIdentifier
        self.networkGate = networkGate
        self.metadata = metadata
    }

    func capture(_ payload: AnalyticsPayload, distinctID: String) {
        sdk.capture(payload.name, distinctId: distinctID, properties: payload.properties)
    }

    func identify(clerkUserID: String, anonymousID: String) {
        sdk.capture(
            "$identify",
            distinctId: clerkUserID,
            properties: [
                "$anon_distinct_id": anonymousID,
                "environment": metadata.environment.rawValue,
                "app_version": metadata.appVersion,
                "app_build": metadata.build,
            ]
        )
    }

    func resetSession() {
        sdk.endSession()
        sdk.startSession()
    }

    func flush() {
        sdk.flush()
    }

    func close() {
        networkGate.revoke()
        sdk.close()
        PostHogNetworkGateRegistry.shared.unregister(identifier: gateIdentifier)
    }
}

private final class WeakPostHogNetworkGate {
    weak var value: PostHogNetworkGate?

    init(_ value: PostHogNetworkGate) {
        self.value = value
    }
}

private final class PostHogNetworkGateRegistry: @unchecked Sendable {
    static let shared = PostHogNetworkGateRegistry()

    private let lock = NSLock()
    private var gates: [String: WeakPostHogNetworkGate] = [:]

    func register(_ gate: PostHogNetworkGate, identifier: String) {
        lock.withLock { gates[identifier] = WeakPostHogNetworkGate(gate) }
    }

    func gate(identifier: String) -> PostHogNetworkGate? {
        lock.withLock { gates[identifier]?.value }
    }

    func unregister(identifier: String) {
        _ = lock.withLock { gates.removeValue(forKey: identifier) }
    }
}

private final class PostHogNoRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

final class PostHogBatchOnlyURLProtocol: URLProtocol, @unchecked Sendable {
    static let gateHeader = "X-SnapList-Analytics-Gate"
    private var dataTask: URLSessionDataTask?
    private var gate: PostHogNetworkGate?

    override class func canInit(with request: URLRequest) -> Bool {
        request.value(forHTTPHeaderField: gateHeader) != nil
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    static func allowsNetworkRequest(_ request: URLRequest) -> Bool {
        request.url?.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")) == "batch"
    }

    override func startLoading() {
        guard let identifier = request.value(forHTTPHeaderField: Self.gateHeader),
              let gate = PostHogNetworkGateRegistry.shared.gate(identifier: identifier),
              gate.allowsDestination(request),
              Self.allowsNetworkRequest(request) else {
            client?.urlProtocol(self, didFailWithError: URLError(.cancelled))
            return
        }

        var forwardedRequest = request
        forwardedRequest.setValue(nil, forHTTPHeaderField: Self.gateHeader)
        let sessionConfiguration = URLSessionConfiguration.ephemeral
        sessionConfiguration.protocolClasses = []
        let session = URLSession(
            configuration: sessionConfiguration,
            delegate: PostHogNoRedirectDelegate(),
            delegateQueue: nil
        )
        let task = session.dataTask(with: forwardedRequest) { [weak self] data, response, error in
            guard let self else { return }
            if let task = self.dataTask {
                gate.finish(task)
            }
            if let error {
                self.client?.urlProtocol(self, didFailWithError: error)
                return
            }
            if let response {
                self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            }
            if let data {
                self.client?.urlProtocol(self, didLoad: data)
            }
            self.client?.urlProtocolDidFinishLoading(self)
        }
        self.gate = gate
        dataTask = task
        guard gate.register(task) else {
            task.cancel()
            client?.urlProtocol(self, didFailWithError: URLError(.cancelled))
            return
        }
        task.resume()
    }

    override func stopLoading() {
        if let dataTask {
            gate?.finish(dataTask)
            dataTask.cancel()
        }
        dataTask = nil
        gate = nil
    }
}

final class PostHogAnalyticsClient: AnalyticsClient, @unchecked Sendable {
    private let configuration: AnalyticsPostHogConfiguration
    private let consentStore: any AnalyticsConsentStoring
    private let dedupeStore: any AnalyticsDedupeStoring
    private let identityStore: any AnalyticsIdentityStoring
    private let lifecycleStore: any AnalyticsTransportLifecycleStoring
    private let dataPurger: any PostHogDurableDataPurging
    private let transportFactory: any PostHogTransportBuilding
    private let networkGate: PostHogNetworkGate
    private let consentTransitionCoordinator = AnalyticsConsentTransitionCoordinator()
    private let executor: AnalyticsSerialExecutor
    private let sanitizer = AnalyticsSanitizer()
    private var transport: (any PostHogTransport)?
    private var purgeRequiredInProcess = false
    private let consentTransitionDidRegisterBeforeGateMutation: @Sendable (AnalyticsConsent) -> Void

    init(
        configuration: AnalyticsPostHogConfiguration,
        consentStore: any AnalyticsConsentStoring,
        dedupeStore: any AnalyticsDedupeStoring,
        identityStore: any AnalyticsIdentityStoring,
        lifecycleStore: any AnalyticsTransportLifecycleStoring,
        dataPurger: any PostHogDurableDataPurging,
        transportFactory: any PostHogTransportBuilding = PostHogSDKTransportFactory(),
        consentTransitionDidRegisterBeforeGateMutation: @escaping @Sendable (AnalyticsConsent) -> Void = { _ in },
        consentTransitionDidSubmit: @escaping @Sendable (AnalyticsConsent) -> Void = { _ in },
        consentTransitionDidEnterSerializedBoundary: @escaping @Sendable (AnalyticsConsent) -> Void = { _ in }
    ) {
        self.configuration = configuration
        self.consentStore = consentStore
        self.dedupeStore = dedupeStore
        self.identityStore = identityStore
        self.lifecycleStore = lifecycleStore
        self.dataPurger = dataPurger
        self.transportFactory = transportFactory
        self.consentTransitionDidRegisterBeforeGateMutation =
            consentTransitionDidRegisterBeforeGateMutation
        networkGate = PostHogNetworkGate(allowedOrigin: configuration.host)
        executor = AnalyticsSerialExecutor(
            consentTransitionDidSubmit: consentTransitionDidSubmit,
            consentTransitionDidEnterSerializedBoundary: consentTransitionDidEnterSerializedBoundary
        )

        guard consentStore.consent == .granted,
              !lifecycleStore.requiresPurge(for: configuration) else {
            networkGate.revoke()
            return
        }
        networkGate.grant()
        transport = transportFactory.makeTransport(
            configuration: configuration,
            networkGate: networkGate
        )
    }

    func capture(_ event: AnalyticsEvent) {
        executor.async { [self] in
            guard consentStore.consent == .granted,
                  !purgeIsRequired,
                  !dedupeStore.contains(event.eventID),
                  let transport,
                  let payload = sanitizer.sanitize(
                      event: event,
                      metadata: configuration.metadata
                  ) else {
                return
            }
            do {
                try transport.capture(payload, distinctID: currentDistinctID)
                dedupeStore.insert(event.eventID)
            } catch {
                // Provider transport is best-effort and cannot change a domain result.
            }
        }
    }

    func screen(_ screen: AnalyticsScreen) {
        executor.async { [self] in
            guard consentStore.consent == .granted,
                  !purgeIsRequired,
                  let transport,
                  let payload = sanitizer.sanitize(
                      screen: screen,
                      metadata: configuration.metadata
                  ) else {
                return
            }
            try? transport.capture(payload, distinctID: currentDistinctID)
        }
    }

    func identify(clerkUserID: String) {
        executor.async { [self] in
            guard consentStore.consent == .granted,
                  !purgeIsRequired,
                  identityStore.identity.clerkUserID == nil,
                  AnalyticsIdentity.accepts(clerkUserID: clerkUserID),
                  let transport else {
                return
            }
            let anonymousID = identityStore.identity.anonymousID.uuidString.lowercased()
            do {
                try transport.identify(
                    clerkUserID: clerkUserID,
                    anonymousID: anonymousID
                )
                _ = identityStore.identify(clerkUserID: clerkUserID)
            } catch {
                // Provider transport is best-effort and cannot change account claim.
            }
        }
    }

    func reset() {
        executor.async { [self] in
            guard consentStore.consent == .granted,
                  !purgeIsRequired else {
                identityStore.reset()
                return
            }
            transport?.resetSession()
            identityStore.reset()
        }
    }

    func setConsent(_ consent: AnalyticsConsent) throws {
        let transitionTicket = consentTransitionCoordinator.register()
        consentTransitionDidRegisterBeforeGateMutation(consent)
        try executor.serializeConsentTransition(consent) { [self] in
            switch consent {
            case .granted:
                try grantConsent(transitionTicket: transitionTicket)
            case .denied, .notDetermined:
                guard consentTransitionCoordinator.isCurrent(transitionTicket) else {
                    return
                }
                try revokeConsent(as: consent)
            }
        }
    }

    func flush() {
        executor.async { [self] in
            guard consentStore.consent == .granted,
                  !purgeIsRequired else {
                return
            }
            transport?.flush()
        }
    }

    func finishPendingWorkForTesting() {
        executor.finishPendingWork()
    }

    private var purgeIsRequired: Bool {
        purgeRequiredInProcess || lifecycleStore.requiresPurge(for: configuration)
    }

    private var currentDistinctID: String {
        identityStore.identity.clerkUserID
            ?? identityStore.identity.anonymousID.uuidString.lowercased()
    }

    private func revokeConsent(as consent: AnalyticsConsent) throws {
        networkGate.revoke()
        transport?.close()
        transport = nil
        purgeRequiredInProcess = true
        consentStore.setConsent(consent)

        let markerFailure: (any Error)?
        do {
            try lifecycleStore.markPurgeRequired(for: configuration)
            markerFailure = nil
        } catch {
            markerFailure = error
        }

        let purgeFailure: (any Error)?
        do {
            try dataPurger.purge(configuration: configuration)
            purgeFailure = nil
        } catch {
            purgeFailure = error
        }
        identityStore.reset()

        if let markerFailure {
            throw markerFailure
        }
        if let purgeFailure {
            throw purgeFailure
        }
        try lifecycleStore.markPurged(for: configuration)
        purgeRequiredInProcess = false
    }

    private func grantConsent(transitionTicket: UInt64) throws {
        let needsPurge = consentStore.consent != .granted || purgeIsRequired
        if needsPurge {
            networkGate.revoke()
            transport?.close()
            transport = nil
            purgeRequiredInProcess = true
            do {
                try dataPurger.purge(configuration: configuration)
                identityStore.reset()
                try lifecycleStore.markPurged(for: configuration)
                purgeRequiredInProcess = false
            } catch {
                consentStore.setConsent(.denied)
                throw error
            }
        }

        guard consentTransitionCoordinator.isCurrent(transitionTicket) else {
            throw AnalyticsConsentTransitionError.superseded
        }
        let candidateTransport = transport ?? transportFactory.makeTransport(
            configuration: configuration,
            networkGate: networkGate
        )
        let committed = consentTransitionCoordinator.commitGrant(ticket: transitionTicket) {
            consentStore.setConsent(.granted)
            transport = candidateTransport
            networkGate.grant()
        }
        guard committed else {
            if transport == nil {
                candidateTransport.close()
            }
            throw AnalyticsConsentTransitionError.superseded
        }
    }
}
