import AuthenticationServices
import Foundation
import Observation
import UIKit

enum EbayConnectionViewState: Equatable, Sendable {
    case notConnected
    case connecting
    case connected
    case reconnectNeeded
    case declined
    case cancelled
    case timedOut
    case failed
}

enum EbayConfirmationViewState: Equatable, Sendable {
    case ready
    case listingChanged
    case refreshFailed
    case missingFields
    case connectionLost
    case accountChanged
}

enum EbayResultViewState: Equatable, Sendable {
    case publishing
    case published
    case unavailable
    case outcomeNotYetKnown
    case ebaySideChanged
}

enum EbayPublishScreen: Equatable, Sendable {
    case connection(EbayConnectionViewState)
    case confirmation(EbayConfirmationViewState)
    case result(EbayResultViewState)
    case account
}

enum EbayOAuthResult: String, Equatable, Sendable {
    case connected
    case declined
    case cancelled
    case expired
    case wrongTenant = "wrong_tenant"
    case invalidState = "invalid_state"
    case inProgress = "in_progress"
    case failed
}

@MainActor
protocol EbayOAuthRunning: Sendable {
    func authenticate(_ session: EbayOAuthSession) async -> EbayOAuthResult
    func cancel()
}

enum EbayOAuthCallbackTarget: Equatable, Sendable {
    case https(host: String, path: String, expectedURL: URL)
    case customScheme(scheme: String, expectedURL: URL)

    static func resolve(
        httpsCallbackURL: URL,
        supportsHTTPSCallback: Bool
    ) -> EbayOAuthCallbackTarget? {
        guard httpsCallbackURL.scheme == "https",
              let host = httpsCallbackURL.host,
              httpsCallbackURL.user == nil,
              httpsCallbackURL.password == nil,
              httpsCallbackURL.query == nil,
              httpsCallbackURL.fragment == nil else {
            return nil
        }
        if supportsHTTPSCallback {
            return .https(
                host: host,
                path: httpsCallbackURL.path,
                expectedURL: httpsCallbackURL
            )
        }
        return .customScheme(
            scheme: "snaplist",
            expectedURL: URL(string: "snaplist://ebay/oauth")!
        )
    }

    var expectedURL: URL {
        switch self {
        case .https(_, _, let expectedURL),
             .customScheme(_, let expectedURL):
            expectedURL
        }
    }
}

/**
 Apple's supported hosted-auth primitive for the eBay consent page.

 The HTTPS callback matcher is available from iOS 17.4 and is bound to the
 associated `snaplist.dev` web-credentials domain. iOS 17.0-17.3 uses Apple's
 callback-scheme initializer and the server's allowlisted HTTPS return bridge.
 The app never falls back to an embedded web view or treats a browser dismissal
 as a connection.
 */
@MainActor
final class AppleEbayOAuthRunner:
    NSObject,
    EbayOAuthRunning,
    ASWebAuthenticationPresentationContextProviding,
    @unchecked Sendable {
    private let callbackURL: URL
    private var webSession: ASWebAuthenticationSession?
    private var continuation: CheckedContinuation<EbayOAuthResult, Never>?

    init(callbackURL: URL) {
        self.callbackURL = callbackURL
    }

    func authenticate(_ oauth: EbayOAuthSession) async -> EbayOAuthResult {
        let supportsHTTPSCallback: Bool
        if #available(iOS 17.4, *) {
            supportsHTTPSCallback = true
        } else {
            supportsHTTPSCallback = false
        }
        guard let target = EbayOAuthCallbackTarget.resolve(
            httpsCallbackURL: callbackURL,
            supportsHTTPSCallback: supportsHTTPSCallback
        ) else {
            return .failed
        }
        cancel()
        return await withCheckedContinuation { continuation in
            self.continuation = continuation
            let completion: (URL?, Error?) -> Void = { [weak self] url, error in
                Task { @MainActor in
                    guard let self else { return }
                    let result = Self.result(
                        callbackURL: url,
                        expected: target.expectedURL,
                        error: error
                    )
                    self.finish(result)
                }
            }
            let session: ASWebAuthenticationSession
            if #available(iOS 17.4, *),
               case .https(let host, let path, _) = target {
                session = ASWebAuthenticationSession(
                    url: oauth.authorizationURL,
                    callback: .https(host: host, path: path),
                    completionHandler: completion
                )
            } else if case .customScheme(let scheme, _) = target {
                session = ASWebAuthenticationSession(
                    url: oauth.authorizationURL,
                    callbackURLScheme: scheme,
                    completionHandler: completion
                )
            } else {
                finish(.failed)
                return
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            webSession = session
            if !session.start() {
                finish(.failed)
            }
        }
    }

    func cancel() {
        webSession?.cancel()
        finish(.cancelled)
    }

    func presentationAnchor(
        for session: ASWebAuthenticationSession
    ) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)
            ?? ASPresentationAnchor()
    }

    private func finish(_ result: EbayOAuthResult) {
        webSession = nil
        let pending = continuation
        continuation = nil
        pending?.resume(returning: result)
    }

    private static func result(
        callbackURL: URL?,
        expected: URL,
        error: Error?
    ) -> EbayOAuthResult {
        if let error,
           case ASWebAuthenticationSessionError.canceledLogin = error {
            return .cancelled
        }
        guard let callbackURL,
              callbackURL.scheme == expected.scheme,
              callbackURL.host == expected.host,
              callbackURL.path == expected.path,
              let raw = URLComponents(
                url: callbackURL,
                resolvingAgainstBaseURL: false
              )?.queryItems?.first(where: { $0.name == "result" })?.value,
              let result = EbayOAuthResult(rawValue: raw) else {
            return .failed
        }
        return result
    }
}

@MainActor
@Observable
final class EbayPublishFlowStore {
    private(set) var screen: EbayPublishScreen = .connection(.notConnected)
    private(set) var preflight: EbayPublishPreflight?
    private(set) var publishedListing: EbayPublishedListing?
    private(set) var connectedUsername: String?

    let listingID: UUID

    private let service: any EbayPublishFeatureServing
    private let oauth: any EbayOAuthRunning
    private let attemptStore: any EbayPublishAttemptStoring
    private let funnelAnalytics: any FunnelAnalyticsEventSinking
    private(set) var preparedUsername: String?
    private var oauthIdempotencyKey = UUID()
    private var hasEmittedEbayPublishConfirmed = false

    init(
        listingID: UUID,
        service: any EbayPublishFeatureServing,
        oauth: any EbayOAuthRunning,
        attemptStore: any EbayPublishAttemptStoring = FileEbayPublishAttemptStore(),
        funnelAnalytics: any FunnelAnalyticsEventSinking = NoOpFunnelAnalyticsEventSink()
    ) {
        self.listingID = listingID
        self.service = service
        self.oauth = oauth
        self.attemptStore = attemptStore
        self.funnelAnalytics = funnelAnalytics
    }

    func load() async {
        do {
            let status = try await service.status(listingID: listingID)
            if status.outcome == .outcomeNotYetKnown {
                await replayAmbiguousPublish()
                return
            }
            if status.outcome == .failed {
                let failedAttempt = try await attemptStore.attempt(
                    listingID: listingID
                )
                try await loadPreflight(justConnected: false)
                if case .confirmation(.ready) = screen {
                    if failedAttempt?.expectedReviewRevision
                        == preflight?.reviewRevision {
                        screen = .result(.unavailable)
                    } else {
                        screen = .confirmation(.listingChanged)
                    }
                }
                return
            }
            if apply(status) { return }
            try await loadPreflight(justConnected: false)
        } catch {
            screen = .connection(.failed)
        }
    }

    func connect() async {
        guard case .connection(let state) = screen,
              state != .connecting else { return }
        screen = .connection(.connecting)
        do {
            let session = try await service.createOAuthSession(
                idempotencyKey: oauthIdempotencyKey
            )
            let result = await oauth.authenticate(session)
            await handleOAuth(result)
        } catch {
            screen = .connection(.failed)
        }
    }

    func cancelConnection() {
        oauth.cancel()
        oauthIdempotencyKey = UUID()
        screen = .connection(.cancelled)
    }

    func reviewBeforePosting() {
        guard preflight != nil else { return }
        screen = .confirmation(confirmationState())
    }

    func manageConnection() {
        screen = .account
    }

    func disconnect() async {
        do {
            let status = try await service.disconnect()
            connectedUsername = status.ebayUsername
            preparedUsername = nil
            screen = .connection(.notConnected)
        } catch {
            screen = .connection(.failed)
        }
    }

    func confirmPublish() async {
        guard case .confirmation(let confirmation) = screen,
              confirmation == .ready
                || confirmation == .listingChanged
                || confirmation == .accountChanged,
              let preflight else { return }
        screen = .result(.publishing)
        let delivery = EbayPublishStore(
            listingID: listingID,
            expectedReviewRevision: preflight.reviewRevision,
            service: service,
            attemptStore: attemptStore
        )
        await delivery.confirmPublish()
        await apply(delivery)
    }

    func reconcileAmbiguousPublish() async {
        guard screen == .result(.outcomeNotYetKnown) else { return }
        await replayAmbiguousPublish()
    }

    private func replayAmbiguousPublish() async {
        screen = .result(.outcomeNotYetKnown)
        do {
            guard let attempt = try await attemptStore.attempt(
                listingID: listingID
            ) else {
                return
            }
            let delivery = EbayPublishStore(
                listingID: listingID,
                expectedReviewRevision: attempt.expectedReviewRevision,
                service: service,
                attemptStore: attemptStore
            )
            await delivery.confirmPublish()
            await apply(delivery)
        } catch {
            screen = .result(.outcomeNotYetKnown)
        }
    }

    private func apply(_ delivery: EbayPublishStore) async {
        switch delivery.phase {
        case .published:
            publishedListing = delivery.publishedListing
            screen = .result(.published)
            recordEbayPublishConfirmedIfNeeded()
        case .staleRevision:
            await reloadAfterConflict()
        case .outcomeNotYetKnown:
            await resolveAmbiguousPublish()
        case .failed:
            screen = .result(.unavailable)
        case .providerAuthorityChanged:
            screen = .result(.ebaySideChanged)
        case .ready, .publishing:
            screen = .result(.outcomeNotYetKnown)
        }
    }

    func retryPublish() async {
        guard screen == .result(.unavailable) else { return }
        screen = .confirmation(.ready)
        await confirmPublish()
    }

    func checkConnection() async {
        do {
            try await loadPreflight(justConnected: false)
        } catch {
            screen = .connection(.reconnectNeeded)
        }
    }

    func retryPreflight() async {
        guard screen == .confirmation(.refreshFailed) else { return }
        await reloadAfterConflict()
    }

    private func handleOAuth(_ result: EbayOAuthResult) async {
        if result != .inProgress {
            oauthIdempotencyKey = UUID()
        }
        switch result {
        case .connected:
            do {
                try await loadPreflight(justConnected: true)
            } catch {
                screen = .connection(.failed)
            }
        case .declined: screen = .connection(.declined)
        case .cancelled: screen = .connection(.cancelled)
        case .expired: screen = .connection(.timedOut)
        case .wrongTenant, .invalidState, .failed:
            screen = .connection(.failed)
        case .inProgress:
            screen = .connection(.connecting)
        }
    }

    private func loadPreflight(justConnected: Bool) async throws {
        let loaded = try await service.preflight(listingID: listingID)
        let oldPrepared = preparedUsername
        preflight = loaded
        connectedUsername = loaded.connection.ebayUsername
        guard loaded.connection.connected else {
            screen = .connection(
                oldPrepared == nil ? .notConnected : .reconnectNeeded
            )
            return
        }
        if let oldPrepared,
           oldPrepared != loaded.connection.ebayUsername {
            screen = .confirmation(.accountChanged)
        } else if justConnected {
            screen = .connection(.connected)
        } else {
            screen = .confirmation(confirmationState())
        }
        preparedUsername = loaded.connection.ebayUsername
    }

    private func confirmationState() -> EbayConfirmationViewState {
        guard let preflight else { return .missingFields }
        let hasRequiredFields = !preflight.title
            .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !preflight.description
                .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && preflight.photoCount > 0
        if !hasRequiredFields { return .missingFields }
        if !preflight.connection.connected { return .connectionLost }
        return .ready
    }

    private func reloadAfterConflict() async {
        do {
            try await loadPreflight(justConnected: false)
            if case .confirmation(.ready) = screen {
                screen = .confirmation(.listingChanged)
            }
        } catch {
            preflight = nil
            screen = .confirmation(.refreshFailed)
        }
    }

    private func resolveAmbiguousPublish() async {
        do {
            let status = try await service.status(listingID: listingID)
            if !apply(status) {
                screen = .result(.outcomeNotYetKnown)
            }
        } catch {
            screen = .result(.outcomeNotYetKnown)
        }
    }

    @discardableResult
    private func apply(_ status: EbayPublishStatus) -> Bool {
        if let published = status.publishedListing {
            publishedListing = published
            screen = .result(.published)
            recordEbayPublishConfirmedIfNeeded()
            return true
        }
        switch status.outcome {
        case .outcomeNotYetKnown:
            screen = .result(.outcomeNotYetKnown)
            return true
        case .failed:
            screen = .result(.unavailable)
            return true
        case .notPublished:
            return false
        case .published:
            screen = .result(.outcomeNotYetKnown)
            return true
        }
    }

    private func recordEbayPublishConfirmedIfNeeded() {
        guard !hasEmittedEbayPublishConfirmed else { return }
        hasEmittedEbayPublishConfirmed = true
        funnelAnalytics.record(.ebayPublishConfirmed, eventID: listingID)
    }
}
