import Foundation
import Observation
import SwiftUI

/// #865. A seller not mid-publish had no route to the connected eBay account
/// or its disconnect control — both existed only inside `EbayPublishView`,
/// reachable exclusively from the per-item publish journey. This file is the
/// Settings-scoped, listing-independent entry point: a small store built on
/// the same `connection()`/`disconnect()`/`createOAuthSession()` seams
/// `EbayPublishFlowStore` already uses for its own connect, and a connect
/// screen that returns to Settings once connected. The connected account and
/// its Disconnect control live inline in Settings' Selling section.
///
/// `EbayPublishFlowStore` itself stays untouched: its OAuth success path
/// requires a real `listingID` (`service.preflight(listingID:)`), which does
/// not exist here, so this store only ever calls the listing-independent
/// methods on `EbayPublishFeatureServing`.
enum EbayConnectionSettingsState: Equatable {
    case checking
    case notConnected
    case connecting
    case connected(username: String?)
    /// The connection could not be checked (or a disconnect attempt itself
    /// failed). Deliberately distinct from `notConnected`: it claims neither
    /// that a connection exists nor that it does not.
    case notAvailable
}

@MainActor
@Observable
final class EbayConnectionSettingsStore {
    private(set) var state: EbayConnectionSettingsState = .checking

    private let service: any EbayPublishFeatureServing
    private let oauth: any EbayOAuthRunning
    private var oauthIdempotencyKey = UUID()

    init(service: any EbayPublishFeatureServing, oauth: any EbayOAuthRunning) {
        self.service = service
        self.oauth = oauth
    }

    func load() async {
        state = .checking
        do {
            let status = try await service.connection()
            state = status.connected
                ? .connected(username: status.ebayUsername)
                : .notConnected
        } catch {
            state = .notAvailable
        }
    }

    func connect() async {
        state = .connecting
        do {
            let session = try await service.createOAuthSession(
                idempotencyKey: oauthIdempotencyKey
            )
            let result = await oauth.authenticate(session)
            await handle(result)
        } catch {
            state = .notConnected
        }
    }

    func cancelConnection() {
        oauth.cancel()
        oauthIdempotencyKey = UUID()
        state = .notConnected
    }

    func disconnect() async {
        do {
            _ = try await service.disconnect()
            state = .notConnected
        } catch {
            state = .notAvailable
        }
    }

    private func handle(_ result: EbayOAuthResult) async {
        if result != .inProgress {
            oauthIdempotencyKey = UUID()
        }
        switch result {
        case .connected:
            await load()
        case .declined, .cancelled, .expired, .wrongTenant, .invalidState, .failed:
            state = .notConnected
        case .inProgress:
            state = .connecting
        }
    }
}

@MainActor
struct EbayConnectionSettingsView: View {
    // `makeStore` is a factory, not a value: `SettingsView` builds this view
    // inside a `navigationDestination` closure, which SwiftUI can
    // re-invoke on every render pass the row is on screen for. Taking the
    // store as a plain parameter re-created it on every one of those passes,
    // which reset `state` to `.checking` before `.task` ever finished loading
    // it (#865). `@State`'s initializer runs the factory exactly once, the
    // first time this view's identity is installed, and keeps the same
    // store across every subsequent re-render.
    let forceReducedMotion: Bool
    /// Settings shows the connected account inline, so a confirmed
    /// connection hands control back to it rather than rendering here.
    let onConnected: () -> Void

    @State private var store: EbayConnectionSettingsStore
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion

    private var reduceMotion: Bool { systemReduceMotion || forceReducedMotion }

    init(
        makeStore: @escaping () -> EbayConnectionSettingsStore,
        forceReducedMotion: Bool,
        onConnected: @escaping () -> Void
    ) {
        self.forceReducedMotion = forceReducedMotion
        self.onConnected = onConnected
        _store = State(initialValue: makeStore())
    }

    var body: some View {
        Group {
            switch store.state {
            case .checking:
                checking
            case .notConnected, .connecting:
                notConnected
            case .connected:
                checking
            case .notAvailable:
                notAvailable
            }
        }
        .background(SnapListColorToken.canvas.color)
        .navigationTitle("Connect eBay")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await store.load()
            returnToSettingsIfConnected()
        }
    }

    /// Hand off after the server confirms the connection. A view-state
    /// observer can miss this transition while navigation updates its child.
    private func returnToSettingsIfConnected() {
        guard case .connected = store.state else { return }
        onConnected()
    }

    private var checking: some View {
        VStack(spacing: 16) {
            ProgressView()
                .controlSize(.large)
                .tint(SnapListColorToken.ebayAccent.color)
                .frame(width: 96, height: 96)
                .background(SnapListColorToken.ebayAccent.color.opacity(0.12))
                .clipShape(Circle())
            Text("Checking your eBay connection")
                .snapListTypography(.body)
                .foregroundStyle(SnapListColorToken.textSecondary.color)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("ebay-connection-settings.checking")
    }

    private func statusBadge(_ symbol: String) -> some View {
        Image(systemName: symbol)
            .font(.system(size: 40, weight: .semibold))
            .foregroundStyle(SnapListColorToken.ebayAccent.color)
            .frame(width: 96, height: 96)
            .background(SnapListColorToken.ebayAccent.color.opacity(0.12))
            .clipShape(Circle())
            .accessibilityHidden(true)
    }

    private func reassurance(_ symbol: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol)
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(SnapListColorToken.ebayAccent.color)
                .frame(width: 24)
                .accessibilityHidden(true)
            Text(text)
                .snapListTypography(.body)
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var notConnected: some View {
        ScrollView {
            VStack(spacing: 18) {
                // #1116: the eBay wordmark, as the marketplace rows use theirs.
                Image("MarketplaceMarkEbay")
                    .resizable()
                    .scaledToFit()
                    .frame(height: 36)
                    .padding(.top, 24)
                    .accessibilityHidden(true)
                Text("Connect your eBay account")
                    .snapListTypography(.displayTitle)
                    .multilineTextAlignment(.center)
                    .accessibilityAddTraits(.isHeader)
                VStack(alignment: .leading, spacing: 14) {
                    reassurance(
                        "lock.shield",
                        "You sign in on eBay's own page. SnapList never sees your eBay password."
                    )
                    Divider()
                    reassurance(
                        "hand.raised",
                        "Nothing posts until you review it and tap Post."
                    )
                    Divider()
                    reassurance(
                        "xmark.circle",
                        "You can remove this connection at any time."
                    )
                }
                .ebayCard()
                if store.state == .connecting {
                    SnapListPrimaryButton(
                        title: "Connecting…",
                        forceReducedMotion: reduceMotion,
                        action: { store.cancelConnection() }
                    )
                    .accessibilityIdentifier("ebay-connection-settings.connecting")
                } else {
                    SnapListPrimaryButton(
                        title: "Connect eBay",
                        forceReducedMotion: reduceMotion,
                        action: {
                            Task {
                                await store.connect()
                                returnToSettingsIfConnected()
                            }
                        }
                    )
                    .accessibilityIdentifier("ebay-connection-settings.connect")
                }
            }
            .padding(SnapListMetrics.screenGutter)
        }
        .accessibilityIdentifier("ebay-connection-settings.not-connected")
    }

    private var notAvailable: some View {
        VStack(spacing: 18) {
            Spacer(minLength: 0)
            statusBadge("wifi.exclamationmark")
            Text("eBay connection")
                .snapListTypography(.displayTitle)
                .accessibilityAddTraits(.isHeader)
            Text("SnapList could not check your eBay connection. Try again in a moment.")
                .snapListTypography(.body)
                .foregroundStyle(SnapListColorToken.textSecondary.color)
                .multilineTextAlignment(.center)
            SnapListSecondaryButton(
                title: "Try again",
                action: {
                    Task {
                        await store.load()
                        returnToSettingsIfConnected()
                    }
                }
            )
            .accessibilityIdentifier("ebay-connection-settings.retry")
            Spacer(minLength: 0)
        }
        .padding(SnapListMetrics.screenGutter)
        .frame(maxWidth: .infinity)
        .accessibilityIdentifier("ebay-connection-settings.not-available")
    }
}

#if DEBUG
/// Deterministic, zero-network, disconnect/reconnect-capable stand-in for
/// `EbayPublishAPIClient` used only by the `--settings-proof=SET-01` fixture
/// (`isSettingsHubProof`). Unlike `EbayPublishFixtureAdapter` (which powers
/// the item publish journey's four fixed connection states as a pure
/// function of an immutable enum), this type is a stateful actor: the
/// Settings entry point's own acceptance criterion is a disconnect-then-
/// reconnect round trip, which a stateless fixture cannot model, since its
/// `connection()` read would never reflect a prior `disconnect()`.
///
/// The listing-bound methods (`preflight`, `status`, `publish`) are
/// unreachable from `EbayConnectionSettingsStore`, which never calls them;
/// they throw rather than fabricate listing data this fixture has no
/// listing to describe.
actor EbaySettingsFixtureAdapter: EbayPublishFeatureServing {
    private(set) var connectedUsername: String?

    init(connectedUsername: String? = "Jordan Hale") {
        self.connectedUsername = connectedUsername
    }

    func reconnect(as username: String) {
        connectedUsername = username
    }

    func createOAuthSession(idempotencyKey: UUID) async throws -> EbayOAuthSession {
        EbayOAuthSession(
            sessionID: idempotencyKey,
            authorizationURL: URL(string: "https://ebay.example/oauth")!,
            expiresAt: Date().addingTimeInterval(300)
        )
    }

    func connection() async throws -> EbayConnectionStatus {
        EbayConnectionStatus(connected: connectedUsername != nil, ebayUsername: connectedUsername)
    }

    func disconnect() async throws -> EbayConnectionStatus {
        connectedUsername = nil
        return EbayConnectionStatus(connected: false, ebayUsername: nil)
    }

    func preflight(listingID: UUID) async throws -> EbayPublishPreflight {
        throw EbayPublishClientError.invalidResponse
    }

    func status(listingID: UUID) async throws -> EbayPublishStatus {
        throw EbayPublishClientError.invalidResponse
    }

    func publish(
        listingID: UUID,
        expectedReviewRevision: UUID,
        idempotencyKey: UUID
    ) async throws -> EbayPublishTransportOutcome {
        .failed
    }
}

/// Pairs with `EbaySettingsFixtureAdapter`: a tap on "Connect eBay" resolves
/// immediately as a successful sign-in for the same fixed username the SET-01
/// proof already displays, closing the round trip without a real
/// `ASWebAuthenticationSession`.
@MainActor
final class EbaySettingsFixtureOAuthRunner: EbayOAuthRunning {
    private let adapter: EbaySettingsFixtureAdapter
    private let username: String

    init(adapter: EbaySettingsFixtureAdapter, username: String = "Jordan Hale") {
        self.adapter = adapter
        self.username = username
    }

    func authenticate(_ session: EbayOAuthSession) async -> EbayOAuthResult {
        await adapter.reconnect(as: username)
        return .connected
    }

    func cancel() {}
}
#endif
