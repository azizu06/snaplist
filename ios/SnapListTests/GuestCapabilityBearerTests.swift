import CryptoKit
import Foundation
import Security
import XCTest
@testable import SnapList

/// Issue #727. A signed-out seller has no Clerk session, so the only credential
/// they can present is the capability a verified App Attest assertion earned.
/// These cover how that bearer is chosen, kept, and carried to the network.
final class GuestCapabilityBearerTests: XCTestCase {
    private static let guestToken =
        "guestcap_\(String(repeating: "A", count: 43))"
    private static let instant = Date(timeIntervalSince1970: 1_785_000_000)

    private static func bearer(
        expiringIn seconds: TimeInterval
    ) -> GuestCapabilityBearer {
        GuestCapabilityBearer(
            expiresAt: instant.addingTimeInterval(seconds),
            token: guestToken
        )
    }

    // MARK: The order a bearer is resolved in

    func testALiveClerkSessionWinsOverAStoredGuestCapability() async throws {
        let store = GuestCapabilityStoreDouble(bearer: Self.bearer(expiringIn: 3_600))
        let provider = GuestCapableBearerTokenProvider(
            clerk: ClerkProviderDouble(token: "fresh-opaque-clerk-token"),
            guestCapabilities: store,
            now: { Self.instant }
        )

        let token = try await provider.bearerToken()

        XCTAssertEqual(token, "fresh-opaque-clerk-token")
        // An account holder's request must never be able to carry a guest
        // identity, so the guest custody is not even consulted.
        XCTAssertEqual(store.loadCount, 0)
    }

    func testASignedOutSellerPresentsTheStoredGuestCapability() async throws {
        let provider = GuestCapableBearerTokenProvider(
            clerk: ClerkProviderDouble(error: BearerTokenProviderError.sessionAbsent),
            guestCapabilities: GuestCapabilityStoreDouble(
                bearer: Self.bearer(expiringIn: 3_600)
            ),
            now: { Self.instant }
        )

        let token = try await provider.bearerToken()

        XCTAssertEqual(token, Self.guestToken)
    }

    func testAnExpiredGuestCapabilityIsNotOffered() async {
        let provider = GuestCapableBearerTokenProvider(
            clerk: ClerkProviderDouble(error: BearerTokenProviderError.sessionAbsent),
            guestCapabilities: GuestCapabilityStoreDouble(
                bearer: Self.bearer(expiringIn: -1)
            ),
            now: { Self.instant }
        )

        await assertSessionAbsent(from: provider)
    }

    func testNoSessionAndNoGuestCapabilityStillFailsAsSessionAbsent() async {
        let provider = GuestCapableBearerTokenProvider(
            clerk: ClerkProviderDouble(error: BearerTokenProviderError.sessionAbsent),
            guestCapabilities: GuestCapabilityStoreDouble(bearer: nil),
            now: { Self.instant }
        )

        await assertSessionAbsent(from: provider)
    }

    func testAClerkFailureThatIsNotAnAbsentSessionIsNotDowngradedToAGuest() async {
        // Falling back on any Clerk error would hand an account holder's request a
        // guest identity whenever Clerk merely stumbled. That is a tenancy defect,
        // not a graceful degradation.
        struct ClerkOutage: Error {}
        let store = GuestCapabilityStoreDouble(bearer: Self.bearer(expiringIn: 3_600))
        let provider = GuestCapableBearerTokenProvider(
            clerk: ClerkProviderDouble(error: ClerkOutage()),
            guestCapabilities: store,
            now: { Self.instant }
        )

        do {
            let token = try await provider.bearerToken()
            XCTFail("Expected the Clerk failure to surface, got \(token)")
        } catch is ClerkOutage {
            XCTAssertEqual(store.loadCount, 0)
        } catch {
            XCTFail("Expected the Clerk failure to surface, got \(error)")
        }
    }

    func testAPrincipalBoundBearerStaysWithTheClerkSession() async {
        // A guest capability carries no verified Clerk subject, so it can never
        // satisfy a principal-bound request. The Clerk answer passes through whole.
        let provider = GuestCapableBearerTokenProvider(
            clerk: ClerkProviderDouble(
                error: BearerTokenProviderError.principalBindingUnavailable
            ),
            guestCapabilities: GuestCapabilityStoreDouble(
                bearer: Self.bearer(expiringIn: 3_600)
            ),
            now: { Self.instant }
        )

        do {
            _ = try await provider.principalBoundBearer()
            XCTFail("Expected the principal binding to stay unavailable")
        } catch BearerTokenProviderError.principalBindingUnavailable {
            return
        } catch {
            XCTFail("Expected principalBindingUnavailable, got \(error)")
        }
    }

    // MARK: Issue #733 — submission-safe renewal

    func testAShortLivedGuestCapabilityIsRenewedBeforeSubmission() async throws {
        let refreshedToken = "guestcap_\(String(repeating: "B", count: 43))"
        let store = GuestCapabilityStoreDouble(
            bearer: Self.bearer(expiringIn: 299)
        )
        let renewal = GuestCapabilityRenewalDouble(outcomes: [.ready]) { _ in
            try? store.save(GuestCapabilityBearer(
                expiresAt: Self.instant.addingTimeInterval(3_600),
                token: refreshedToken
            ))
        }
        let provider = makeSignedOutRenewingProvider(
            store: store,
            renewal: renewal
        )

        let token = try await provider.bearerToken()

        XCTAssertEqual(token, refreshedToken)
        let renewalCallCount = await renewal.callCount
        XCTAssertEqual(renewalCallCount, 1)
    }

    func testUnavailableEnrollmentFailsClosedThenALaterLaunchRetries() async throws {
        let refreshedToken = "guestcap_\(String(repeating: "C", count: 43))"
        let store = GuestCapabilityStoreDouble(bearer: nil)
        let renewal = GuestCapabilityRenewalDouble(
            outcomes: [.unavailable(.serverUnavailable), .ready]
        ) { callIndex in
            guard callIndex == 1 else { return }
            try? store.save(GuestCapabilityBearer(
                expiresAt: Self.instant.addingTimeInterval(3_600),
                token: refreshedToken
            ))
        }
        func makeProvider() -> GuestCapabilityRenewingBearerTokenProvider {
            makeSignedOutRenewingProvider(
                store: store,
                renewal: renewal
            )
        }

        await assertSessionAbsent(from: makeProvider())
        let token = try await makeProvider().bearerToken()

        XCTAssertEqual(token, refreshedToken)
        let renewalCallCount = await renewal.callCount
        XCTAssertEqual(renewalCallCount, 2)
    }

    func testLaunchKeepsAUsableGuestBearerWithoutRenewingIt() async throws {
        let instant = Date()
        let store = GuestCapabilityStoreDouble(
            bearer: GuestCapabilityBearer(
                expiresAt: instant.addingTimeInterval(3_600),
                token: Self.guestToken
            )
        )
        let renewal = GuestCapabilityRenewalDouble(outcomes: [.ready]) { _ in }
        let composition = makeLaunchComposition(
            clerk: ClerkProviderDouble(
                error: BearerTokenProviderError.sessionAbsent
            ),
            enrollment: renewal,
            instant: instant,
            store: store
        )

        await composition.beginLaunchEnrollment().value
        let launchRenewalCount = await renewal.callCount
        XCTAssertEqual(launchRenewalCount, 0)

        let token = try await composition.tokenProvider.bearerToken()
        XCTAssertEqual(token, Self.guestToken)
    }

    func testLaunchSkipsEnrollmentForALivePrincipalBoundClerkSession() async throws {
        let instant = Date()
        let enrollment = GuestCapabilityRenewalDouble(outcomes: [.ready]) { _ in }
        let store = GuestCapabilityStoreDouble(bearer: nil)
        let composition = makeLaunchComposition(
            clerk: ClerkProviderDouble(
                token: "fresh-opaque-clerk-token",
                principalSubject: "user_live_clerk"
            ),
            enrollment: enrollment,
            instant: instant,
            store: store
        )

        await composition.beginLaunchEnrollment().value
        let launchEnrollmentCount = await enrollment.callCount
        XCTAssertEqual(launchEnrollmentCount, 0)

        let token = try await composition.tokenProvider.bearerToken()

        XCTAssertEqual(token, "fresh-opaque-clerk-token")
        XCTAssertEqual(store.loadCount, 0)
    }

    func testLaunchDoesNotDowngradeAClerkFailureToGuestEnrollment() async {
        struct ClerkOutage: Error {}
        let instant = Date()
        let enrollment = GuestCapabilityRenewalDouble(outcomes: [.ready]) { _ in }
        let store = GuestCapabilityStoreDouble(bearer: nil)
        let composition = makeLaunchComposition(
            clerk: ClerkProviderDouble(error: ClerkOutage()),
            enrollment: enrollment,
            instant: instant,
            store: store
        )

        await composition.beginLaunchEnrollment().value

        let launchEnrollmentCount = await enrollment.callCount
        XCTAssertEqual(launchEnrollmentCount, 0)
        XCTAssertEqual(store.loadCount, 0)
        do {
            let token = try await composition.tokenProvider.bearerToken()
            XCTFail("Expected Clerk outage, got \(token)")
        } catch is ClerkOutage {
            XCTAssertEqual(store.loadCount, 0)
        } catch {
            XCTFail("Expected Clerk outage, got \(error)")
        }
    }

    // MARK: Durable custody

    func testAStoredGuestCapabilitySurvivesRelaunch() throws {
        let store = KeychainGuestCapabilityBearerStore()
        addTeardownBlock { Self.purgeGuestCapabilityKeychain() }
        let bearer = Self.bearer(expiringIn: 3_600)

        try store.save(bearer)
        // A second instance stands in for the next launch: nothing survives in
        // memory, so a bearer that reappears came back out of the Keychain.
        let reloaded = try KeychainGuestCapabilityBearerStore().load()

        XCTAssertEqual(reloaded, bearer)
    }

    // MARK: The request the signed-out seller actually sends

    @MainActor
    func testASignedOutSellerReachesTheNetworkWithTheGuestCapabilityBearer() async throws {
        let intake = SubmissionIntakeFixture(photoCount: 1)
        // The coordinator refuses a receipt whose photo identity is not the
        // fingerprint of the bytes it actually sent, so the stub has to answer
        // with the real one or the run is retained before the header matters.
        let canonicalDigests = intake.expectedReceiptPhotos
            .map { $0.contentSha256.lowercased() }
            .sorted()
            .joined(separator: "\n")
        let fingerprint = SHA256.hash(data: Data(canonicalDigests.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
        let receipt = try JSONEncoder().encode(
            MobileItemSubmissionEnvelope(
                data: MobileItemSubmissionEnvelope.DataPayload(
                    itemId: UUID(uuidString: "72700000-0000-4000-8000-000000000003")!,
                    runId: UUID(uuidString: "72700000-0000-4000-8000-000000000004")!,
                    status: "queued",
                    stage: "queued",
                    photoIdentity: .init(
                        kind: "content_sha256_set_v1",
                        fingerprint: fingerprint
                    ),
                    photos: intake.expectedReceiptPhotos
                ),
                meta: ResponseMeta(requestId: "req_test")
            )
        )
        let observed = ObservedRequest()
        ItemRunSubmissionURLProtocolStub.handler = { request in
            observed.record(request)
            return (
                HTTPURLResponse(
                    url: request.url!,
                    statusCode: 202,
                    httpVersion: nil,
                    headerFields: ["Content-Type": "application/json"]
                )!,
                receipt
            )
        }
        addTeardownBlock { ItemRunSubmissionURLProtocolStub.handler = nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ItemRunSubmissionURLProtocolStub.self]
        let recoveryStore = GuestRecoveryCredentialStoreDouble()
        let host = ItemRunSubmissionHost(
            coordinator: ItemRunSubmissionCoordinator(
                submitter: ItemRunSubmissionClient(
                    baseURL: URL(string: "https://api.snaplist.dev")!,
                    session: URLSession(configuration: configuration),
                    boundary: { "snaplist-boundary" }
                ),
                attemptStore: InMemoryItemRunSubmissionAttemptStore(),
                draftStore: RecordingCaptureDraftStore(photos: intake.photos),
                tokenProvider: GuestCapableBearerTokenProvider(
                    clerk: ClerkProviderDouble(
                        error: BearerTokenProviderError.sessionAbsent
                    ),
                    guestCapabilities: GuestCapabilityStoreDouble(
                        bearer: Self.bearer(expiringIn: 3_600)
                    ),
                    now: { Self.instant }
                ),
                guestRecoveryCredentials: recoveryStore,
                readData: intake.read,
                newIdempotencyKey: {
                    UUID(uuidString: "72700000-0000-4000-8000-000000000001")!
                }
            )
        )

        let submission = Task { await host.startListing(photos: intake.photos) }
        defer { submission.cancel() }
        guard let eventID = await waitForPendingItemSavedEvent(on: host) else {
            XCTFail(
                """
                Start listing never published an accepted run — \
                retention \(String(describing: host.retention)), \
                reached network: \(observed.request != nil)
                """
            )
            return
        }
        host.acknowledgePresentation(eventID: eventID)
        await submission.value

        let request = try XCTUnwrap(observed.request)
        // The token is a fixture literal, not a credential, so the header is
        // compared whole. A prefix check would pass for any token of that shape.
        XCTAssertEqual(
            request.value(forHTTPHeaderField: "Authorization"),
            "Bearer \(Self.guestToken)"
        )
        // A guest bearer is what makes the run recoverable, so exactly one
        // recovery credential is minted on this path.
        let mintCount = await recoveryStore.mintCount
        XCTAssertEqual(mintCount, 1)
    }

    // MARK: Helpers

    private func makeSignedOutRenewingProvider(
        store: GuestCapabilityStoreDouble,
        renewal: GuestCapabilityRenewalDouble
    ) -> GuestCapabilityRenewingBearerTokenProvider {
        GuestCapabilityRenewingBearerTokenProvider(
            base: GuestCapableBearerTokenProvider(
                clerk: ClerkProviderDouble(
                    error: BearerTokenProviderError.sessionAbsent
                ),
                guestCapabilities: store,
                now: { Self.instant }
            ),
            guestCapabilities: store,
            renewGuestCapability: { await renewal.renew() },
            now: { Self.instant }
        )
    }

    private func makeLaunchComposition(
        clerk: any BearerTokenProviding,
        enrollment: GuestCapabilityRenewalDouble,
        instant: Date,
        store: GuestCapabilityStoreDouble
    ) -> AppAttestGuestCapabilityComposition {
        let base = GuestCapableBearerTokenProvider(
            clerk: clerk,
            guestCapabilities: store,
            now: { instant }
        )
        return AppAttestGuestCapabilityComposition(
            baseTokenProvider: base,
            guestCapabilities: store,
            enrollGuestCapability: { await enrollment.renew() },
            now: { instant }
        )
    }

    private func assertSessionAbsent(
        from provider: any BearerTokenProviding,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        do {
            let token = try await provider.bearerToken()
            XCTFail("Expected sessionAbsent, got \(token)", file: file, line: line)
        } catch BearerTokenProviderError.sessionAbsent {
            return
        } catch {
            XCTFail("Expected sessionAbsent, got \(error)", file: file, line: line)
        }
    }

    private static func purgeGuestCapabilityKeychain() {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: "guest-capability-bearer",
            kSecAttrService as String: "dev.snaplist.ios.guest-capability",
        ] as CFDictionary)
    }

    @MainActor
    private func waitForPendingItemSavedEvent(
        on host: ItemRunSubmissionHost
    ) async -> UUID? {
        for _ in 0..<600 {
            if case .itemSaved(let eventID, _)? = host.pendingPresentationEvent {
                return eventID
            }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        return nil
    }
}

private final class ClerkProviderDouble: BearerTokenProviding, @unchecked Sendable {
    private let token: String?
    private let principalSubject: String?
    private let error: Error?

    init(
        token: String? = nil,
        principalSubject: String? = nil,
        error: Error? = nil
    ) {
        self.token = token
        self.principalSubject = principalSubject
        self.error = error
    }

    func bearerToken() async throws -> String {
        if let error { throw error }
        guard let token else {
            throw BearerTokenProviderError.sessionAbsent
        }
        return token
    }

    func principalBoundBearer() async throws -> PrincipalBoundBearer {
        if let error { throw error }
        if let token,
           let principalSubject,
           let scopeProof = ItemRunSubmissionPrincipalScopeProof(
               verifiedClerkSubject: principalSubject
           ) {
            return PrincipalBoundBearer(
                bearerToken: token,
                scopeProof: scopeProof
            )
        }
        throw BearerTokenProviderError.principalBindingUnavailable
    }
}

private final class GuestCapabilityStoreDouble: GuestCapabilityBearerStoring,
    @unchecked Sendable {
    private(set) var loadCount = 0
    private var bearer: GuestCapabilityBearer?

    init(bearer: GuestCapabilityBearer?) {
        self.bearer = bearer
    }

    func load() throws -> GuestCapabilityBearer? {
        loadCount += 1
        return bearer
    }

    func save(_ bearer: GuestCapabilityBearer) throws {
        self.bearer = bearer
    }

}

private actor GuestCapabilityRenewalDouble {
    private(set) var callCount = 0
    private let onRenew: @Sendable (Int) -> Void
    private var outcomes: [AppAttestGuestCapabilityEnrollmentOutcome]

    init(
        outcomes: [AppAttestGuestCapabilityEnrollmentOutcome],
        onRenew: @escaping @Sendable (Int) -> Void
    ) {
        self.onRenew = onRenew
        self.outcomes = outcomes
    }

    func renew() -> AppAttestGuestCapabilityEnrollmentOutcome {
        let callIndex = callCount
        callCount += 1
        onRenew(callIndex)
        guard !outcomes.isEmpty else {
            return .unavailable(.serverUnavailable)
        }
        return outcomes.removeFirst()
    }
}

private final class ObservedRequest: @unchecked Sendable {
    private(set) var request: URLRequest?

    func record(_ request: URLRequest) {
        self.request = request
    }
}

private actor GuestRecoveryCredentialStoreDouble: GuestRecoveryCredentialStoring {
    private(set) var mintCount = 0
    private var minted: GuestRecoverySubmissionIdentity?

    func mintCredential() async throws -> GuestRecoverySubmissionIdentity {
        mintCount += 1
        let identity = GuestRecoverySubmissionIdentity(
            recoveryID: UUID(uuidString: "72700000-0000-4000-8000-000000000002")!,
            recoveryTokenHash: String(repeating: "7", count: 64)
        )
        minted = identity
        return identity
    }

    func contains(_ identity: GuestRecoverySubmissionIdentity) async throws -> Bool {
        minted == identity
    }

    func bind(
        _ identity: GuestRecoverySubmissionIdentity,
        itemID: UUID,
        runID: UUID,
        photoIdentity: GuestPhotoIdentity
    ) async throws {}

    func credential(runID: UUID) async throws -> GuestRecoveryCredential? { nil }

    func credential(recoveryID: UUID) async throws -> GuestRecoveryCredential? { nil }

    func setExpiry(recoveryID: UUID, expiresAt: Date) async throws {}

    func purge(recoveryID: UUID) async throws {
        minted = nil
    }
}
