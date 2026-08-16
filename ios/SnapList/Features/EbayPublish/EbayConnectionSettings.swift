import Foundation
import Observation
import SwiftUI

/// #865. A seller not mid-publish had no route to the connected eBay account
/// or its disconnect control — both existed only inside `EbayPublishView`,
/// reachable exclusively from the per-item publish journey. This file is the
/// Settings-scoped, listing-independent entry point: a small store built on
/// the same `connection()`/`disconnect()`/`createOAuthSession()` seams
/// `EbayPublishFlowStore` already uses for its own connect/disconnect, and a
/// view that renders the identical, reused `EbayAccountScreenView` once
/// connected.
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
    @Bindable var store: EbayConnectionSettingsStore
    let forceReducedMotion: Bool

    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion

    private var reduceMotion: Bool { systemReduceMotion || forceReducedMotion }

    var body: some View {
        Group {
            switch store.state {
            case .checking:
                checking
            case .notConnected, .connecting:
                notConnected
            case .connected(let username):
                EbayAccountScreenView(
                    connectedUsername: username,
                    disconnect: { await store.disconnect() }
                )
            case .notAvailable:
                notAvailable
            }
        }
        .background(SnapListColorToken.canvas.color)
        .navigationTitle("eBay account")
        .navigationBarTitleDisplayMode(.inline)
        .task { await store.load() }
    }

    private var checking: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("Checking your eBay connection")
                .snapListTypography(.body)
                .foregroundStyle(SnapListColorToken.textSecondary.color)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("ebay-connection-settings.checking")
    }

    private var notConnected: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("Connect your eBay account")
                    .snapListTypography(.displayTitle)
                    .accessibilityAddTraits(.isHeader)
                Text(
                    "You sign in on eBay's own page. SnapList never sees your eBay password. You can remove this connection at any time."
                )
                .snapListTypography(.body)
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
                        action: { Task { await store.connect() } }
                    )
                    .accessibilityIdentifier("ebay-connection-settings.connect")
                }
            }
            .padding(SnapListMetrics.screenGutter)
        }
        .accessibilityIdentifier("ebay-connection-settings.not-connected")
    }

    private var notAvailable: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("eBay connection")
                .snapListTypography(.displayTitle)
                .accessibilityAddTraits(.isHeader)
            Text("SnapList could not check your eBay connection. Try again in a moment.")
                .snapListTypography(.body)
                .foregroundStyle(SnapListColorToken.textSecondary.color)
            SnapListSecondaryButton(
                title: "Try again",
                action: { Task { await store.load() } }
            )
            .accessibilityIdentifier("ebay-connection-settings.retry")
        }
        .padding(SnapListMetrics.screenGutter)
        .frame(maxWidth: .infinity, alignment: .leading)
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
