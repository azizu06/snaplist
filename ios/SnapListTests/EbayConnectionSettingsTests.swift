import Foundation
import XCTest
@testable import SnapList

/// #865. `EbayConnectionSettingsStore` is the listing-independent seam behind
/// the Settings entry point into the eBay account/disconnect screen. These
/// tests cover exactly the methods it calls on `EbayPublishFeatureServing`
/// (`connection`, `disconnect`, `createOAuthSession`) and never touch the
/// listing-bound ones (`preflight`, `status`, `publish`), which the doubles
/// below throw on rather than fabricate listing data they have no listing
/// to describe.
@MainActor
final class EbayConnectionSettingsTests: XCTestCase {
    func testLoadReflectsAConfirmedConnection() async {
        let service = StubEbayConnectionService(
            connectionResult: .success(
                EbayConnectionStatus(connected: true, ebayUsername: "sandbox-seller")
            )
        )
        let store = EbayConnectionSettingsStore(
            service: service,
            oauth: StubEbayOAuthRunner(result: .failed)
        )

        await store.load()

        XCTAssertEqual(store.state, .connected(username: "sandbox-seller"))
    }

    func testLoadReflectsNoConnection() async {
        let service = StubEbayConnectionService(
            connectionResult: .success(
                EbayConnectionStatus(connected: false, ebayUsername: nil)
            )
        )
        let store = EbayConnectionSettingsStore(
            service: service,
            oauth: StubEbayOAuthRunner(result: .failed)
        )

        await store.load()

        XCTAssertEqual(store.state, .notConnected)
    }

    /// A read failure must not be reported as "Not connected": that would
    /// claim something SnapList does not actually know.
    func testLoadFailureIsNotAvailableRatherThanNotConnected() async {
        let service = StubEbayConnectionService(connectionResult: .failure(StubError.expected))
        let store = EbayConnectionSettingsStore(
            service: service,
            oauth: StubEbayOAuthRunner(result: .failed)
        )

        await store.load()

        XCTAssertEqual(store.state, .notAvailable)
    }

    func testConnectSuccessReachesTheConnectedState() async {
        let service = StubEbayConnectionService(
            connectionResult: .success(
                EbayConnectionStatus(connected: true, ebayUsername: "sandbox-seller")
            )
        )
        let store = EbayConnectionSettingsStore(
            service: service,
            oauth: StubEbayOAuthRunner(result: .connected)
        )

        await store.connect()

        XCTAssertEqual(store.state, .connected(username: "sandbox-seller"))
    }

    func testConnectDeclinedStaysNotConnected() async {
        let service = StubEbayConnectionService(
            connectionResult: .success(EbayConnectionStatus(connected: false, ebayUsername: nil))
        )
        let store = EbayConnectionSettingsStore(
            service: service,
            oauth: StubEbayOAuthRunner(result: .declined)
        )

        await store.connect()

        XCTAssertEqual(store.state, .notConnected)
    }

    func testCancelConnectionReturnsToNotConnected() async {
        let oauth = StubEbayOAuthRunner(result: .failed)
        let store = EbayConnectionSettingsStore(
            service: StubEbayConnectionService(connectionResult: .failure(StubError.expected)),
            oauth: oauth
        )

        store.cancelConnection()

        XCTAssertEqual(store.state, .notConnected)
        XCTAssertTrue(oauth.cancelled)
    }

    /// The core disconnect-then-reconnect round trip #865 exists to prove:
    /// disconnecting from Settings must not strand the seller without a way
    /// back in.
    func testDisconnectThenReconnectRoundTrips() async {
        let service = StatefulEbayConnectionService(initialUsername: "sandbox-seller")
        let store = EbayConnectionSettingsStore(
            service: service,
            oauth: ReconnectingStubOAuthRunner(service: service, username: "sandbox-seller")
        )

        await store.load()
        XCTAssertEqual(store.state, .connected(username: "sandbox-seller"))

        await store.disconnect()
        XCTAssertEqual(store.state, .notConnected)

        await store.connect()
        XCTAssertEqual(store.state, .connected(username: "sandbox-seller"))
    }

    /// A disconnect call that itself fails must not silently claim the
    /// seller is still connected, nor claim they are now disconnected — both
    /// would be a guess about server state SnapList never confirmed.
    func testDisconnectFailureIsNotAvailable() async {
        let service = StubEbayConnectionService(
            connectionResult: .success(
                EbayConnectionStatus(connected: true, ebayUsername: "sandbox-seller")
            ),
            disconnectResult: .failure(StubError.expected)
        )
        let store = EbayConnectionSettingsStore(
            service: service,
            oauth: StubEbayOAuthRunner(result: .failed)
        )

        await store.load()
        await store.disconnect()

        XCTAssertEqual(store.state, .notAvailable)
    }
}

private enum StubError: Error { case expected }

@MainActor
private final class StubEbayOAuthRunner: EbayOAuthRunning {
    let result: EbayOAuthResult
    private(set) var cancelled = false

    init(result: EbayOAuthResult) {
        self.result = result
    }

    func authenticate(_ session: EbayOAuthSession) async -> EbayOAuthResult { result }
    func cancel() { cancelled = true }
}

private actor StubEbayConnectionService: EbayPublishFeatureServing {
    private let connectionResult: Result<EbayConnectionStatus, Error>
    private let disconnectResult: Result<EbayConnectionStatus, Error>

    init(
        connectionResult: Result<EbayConnectionStatus, Error>,
        disconnectResult: Result<EbayConnectionStatus, Error> = .success(
            EbayConnectionStatus(connected: false, ebayUsername: nil)
        )
    ) {
        self.connectionResult = connectionResult
        self.disconnectResult = disconnectResult
    }

    func createOAuthSession(idempotencyKey: UUID) async throws -> EbayOAuthSession {
        EbayOAuthSession(
            sessionID: idempotencyKey,
            authorizationURL: URL(string: "https://ebay.example/oauth")!,
            expiresAt: Date().addingTimeInterval(300)
        )
    }
    func connection() async throws -> EbayConnectionStatus { try connectionResult.get() }
    func disconnect() async throws -> EbayConnectionStatus { try disconnectResult.get() }
    func preflight(listingID: UUID) async throws -> EbayPublishPreflight {
        throw StubError.expected
    }
    func status(listingID: UUID) async throws -> EbayPublishStatus {
        throw StubError.expected
    }
    func publish(
        listingID: UUID,
        expectedReviewRevision: UUID,
        idempotencyKey: UUID
    ) async throws -> EbayPublishTransportOutcome {
        throw StubError.expected
    }
}

/// Actually mutates between calls, unlike `StubEbayConnectionService`, so a
/// disconnect-then-reconnect round trip can be proved end to end.
private actor StatefulEbayConnectionService: EbayPublishFeatureServing {
    private var username: String?

    init(initialUsername: String?) {
        username = initialUsername
    }

    func reconnect(as username: String) {
        self.username = username
    }

    func createOAuthSession(idempotencyKey: UUID) async throws -> EbayOAuthSession {
        EbayOAuthSession(
            sessionID: idempotencyKey,
            authorizationURL: URL(string: "https://ebay.example/oauth")!,
            expiresAt: Date().addingTimeInterval(300)
        )
    }
    func connection() async throws -> EbayConnectionStatus {
        EbayConnectionStatus(connected: username != nil, ebayUsername: username)
    }
    func disconnect() async throws -> EbayConnectionStatus {
        username = nil
        return EbayConnectionStatus(connected: false, ebayUsername: nil)
    }
    func preflight(listingID: UUID) async throws -> EbayPublishPreflight {
        throw StubError.expected
    }
    func status(listingID: UUID) async throws -> EbayPublishStatus {
        throw StubError.expected
    }
    func publish(
        listingID: UUID,
        expectedReviewRevision: UUID,
        idempotencyKey: UUID
    ) async throws -> EbayPublishTransportOutcome {
        throw StubError.expected
    }
}

@MainActor
private final class ReconnectingStubOAuthRunner: EbayOAuthRunning {
    private let service: StatefulEbayConnectionService
    private let username: String

    init(service: StatefulEbayConnectionService, username: String) {
        self.service = service
        self.username = username
    }

    func authenticate(_ session: EbayOAuthSession) async -> EbayOAuthResult {
        await service.reconnect(as: username)
        return .connected
    }

    func cancel() {}
}
