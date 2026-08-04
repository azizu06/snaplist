import Foundation
import XCTest
@testable import SnapList

@MainActor
final class GuestClaimTests: XCTestCase {
    override func tearDown() {
        GuestClaimURLProtocolStub.handler = nil
        super.tearDown()
    }

    func testInterruptedAuthenticationReturnsToSavedDraftWithoutStartingClaim() async {
        let authorityStore = GuestClaimAuthorityRecorder()
        let credentialStore = GuestRecoveryCredentialRecorder()
        let service = GuestClaimRecordingService(outcome: .claimed(Self.handoff))
        let store = GuestClaimStore(
            authority: Self.authority,
            authenticator: GuestClaimRecordingAuthenticator(),
            service: service,
            attemptStore: MemoryGuestClaimAttemptStore(),
            authorityStore: authorityStore,
            credentialStore: credentialStore
        )

        await store.showEmailEntry()
        await store.sendCode(to: "seller@example.com")
        store.cancelAuthentication()

        let prepareCount = await service.prepareCount
        let claimCount = await service.claimCount
        let purgeCount = await authorityStore.purgeCount
        let credentialPurgeCount = await credentialStore.purgeCount
        XCTAssertEqual(store.state, .gate)
        XCTAssertEqual(prepareCount, 1)
        XCTAssertEqual(claimCount, 0)
        XCTAssertEqual(purgeCount, 0)
        XCTAssertEqual(credentialPurgeCount, 0)
    }

    func testSuccessfulAuthenticationClaimsSameRunAndPurgesOnlyAfterTerminalTruth() async {
        let authorityStore = GuestClaimAuthorityRecorder()
        let credentialStore = GuestRecoveryCredentialRecorder()
        let service = GuestClaimRecordingService(outcome: .claimed(Self.handoff))
        let store = GuestClaimStore(
            authority: Self.authority,
            authenticator: GuestClaimRecordingAuthenticator(),
            service: service,
            attemptStore: MemoryGuestClaimAttemptStore(),
            authorityStore: authorityStore,
            credentialStore: credentialStore
        )

        await store.showEmailEntry()
        await store.sendCode(to: "seller@example.com")
        await store.verifyAndClaim(code: "123456")

        XCTAssertEqual(store.state, .claimed(Self.handoff))
        let claims = await service.claims
        let purgeCount = await authorityStore.purgeCount
        let credentialPurgeCount = await credentialStore.purgeCount
        XCTAssertEqual(claims.count, 1)
        XCTAssertEqual(claims.first?.authority.recoveryID, Self.authority.recoveryID)
        XCTAssertEqual(claims.first?.authority.itemID, Self.authority.itemID)
        XCTAssertEqual(claims.first?.authority.runID, Self.authority.runID)
        XCTAssertEqual(claims.first?.authority.draftID, Self.authority.draftID)
        XCTAssertEqual(
            claims.first?.authority.reviewRevision,
            Self.authority.reviewRevision
        )
        XCTAssertEqual(claims.first?.authority.photoIdentity, Self.authority.photoIdentity)
        XCTAssertEqual(purgeCount, 1)
        XCTAssertEqual(credentialPurgeCount, 1)
    }

    func testTerminalClaimWaitsForDurableCredentialCleanupAndRetriesIt() async {
        let authorityStore = GuestClaimAuthorityRecorder()
        let credentialStore = GuestRecoveryCredentialRecorder(purgeFailures: 1)
        let service = GuestClaimRecordingService(outcome: .claimed(Self.handoff))
        let store = GuestClaimStore(
            authority: Self.authority,
            authenticator: GuestClaimRecordingAuthenticator(),
            service: service,
            attemptStore: MemoryGuestClaimAttemptStore(),
            authorityStore: authorityStore,
            credentialStore: credentialStore
        )

        await store.showEmailEntry()
        await store.sendCode(to: "seller@example.com")
        await store.verifyAndClaim(code: "123456")

        let firstCredentialPurges = await credentialStore.purgeCount
        let firstAuthorityPurges = await authorityStore.purgeCount
        XCTAssertEqual(store.state, .copyFailed)
        XCTAssertEqual(firstCredentialPurges, 1)
        XCTAssertEqual(firstAuthorityPurges, 0)

        await store.retryClaim()

        let finalCredentialPurges = await credentialStore.purgeCount
        let finalAuthorityPurges = await authorityStore.purgeCount
        XCTAssertEqual(store.state, .claimed(Self.handoff))
        XCTAssertEqual(finalCredentialPurges, 2)
        XCTAssertEqual(finalAuthorityPurges, 1)
    }

    func testHandoffCanonicalBytesBindRecoveryAndPhotoIdentityWithoutLeakingLocalIDs() throws {
        let data = try GuestClaimCanonicalRequest.data(for: Self.authority)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )

        XCTAssertEqual(Set(object.keys), [
            "photoIdentity",
            "purpose",
            "recoveryId",
            "recoveryToken",
            "version",
        ])
        XCTAssertEqual(object["purpose"] as? String, "guest-claim-handoff")
        XCTAssertEqual(
            object["recoveryId"] as? String,
            Self.authority.recoveryID.uuidString.lowercased()
        )
        XCTAssertEqual(
            (object["photoIdentity"] as? [String: Any])?["fingerprint"] as? String,
            Self.authority.photoIdentity.fingerprint
        )
        XCTAssertNil(object["itemId"])
        XCTAssertNil(object["runId"])
        XCTAssertNil(object["draftId"])
        XCTAssertNil(object["reviewRevision"])
    }

    func testReturnedHandoffIsRetainedBeforeAuthenticationAndPresentedAtClaim() async throws {
        let authority = Self.authority
        let claimedListing = Self.handoff
        let retainedHandoffs = GuestClaimHandoffRecorder()
        let requests = GuestClaimRequestRecorder()
        let session = makeSession { request in
            let path = request.url?.path ?? ""
            requests.record(
                path: path,
                handoff: request.value(
                    forHTTPHeaderField: "X-SnapList-Guest-Handoff"
                )
            )
            switch path {
            case "/v1/guest/attestations":
                return Self.response(
                    status: 201,
                    json: """
                    {
                      "data": {
                        "handoffToken": "guesthandoff_v1.retained-377",
                        "expiresAt": "2099-08-04T12:00:00.000Z",
                        "recoveryId": "\(authority.recoveryID.uuidString.lowercased())",
                        "photoIdentity": {
                          "kind": "content_sha256_set_v1",
                          "fingerprint": "\(authority.photoIdentity.fingerprint)"
                        }
                      },
                      "meta": { "requestId": "req-handoff-377" }
                    }
                    """
                )
            case "/v1/guest/claims":
                XCTAssertTrue(
                    retainedHandoffs.contains(
                        token: "guesthandoff_v1.retained-377",
                        recoveryID: authority.recoveryID
                    ),
                    "The bearer must be durable before the claim request starts."
                )
                return Self.response(
                    status: 200,
                    json: """
                    {
                      "data": {
                        "outcome": "claimed",
                        "itemId": "\(claimedListing.itemID.uuidString.lowercased())",
                        "runId": "\(claimedListing.runID.uuidString.lowercased())",
                        "draftId": "\(claimedListing.draftID.uuidString.lowercased())"
                      },
                      "meta": { "requestId": "req-claim-377" }
                    }
                    """
                )
            default:
                XCTFail("Unexpected request path: \(path)")
                return Self.response(status: 404, json: "{}")
            }
        }
        let client = GuestClaimAPIClient(
            baseURL: URL(string: "https://snaplist.dev")!,
            proofProvider: GuestClaimProofProvider(),
            tokenProvider: GuestClaimBearerProvider(),
            handoffStore: retainedHandoffs,
            session: session
        )

        try await client.prepareHandoff(authority: authority)

        XCTAssertEqual(requests.paths, ["/v1/guest/attestations"])
        XCTAssertTrue(
            retainedHandoffs.contains(
                token: "guesthandoff_v1.retained-377",
                recoveryID: authority.recoveryID
            )
        )

        let outcome = try await client.claim(
            authority: authority,
            idempotencyKey: UUID(
                uuidString: "37700000-0000-4000-8000-000000000106"
            )!
        )

        XCTAssertEqual(outcome, GuestClaimOutcome.claimed(claimedListing))
        XCTAssertEqual(
            requests.paths,
            [
                "/v1/guest/attestations",
                "/v1/guest/claims",
            ]
        )
        XCTAssertEqual(
            requests.claimHandoffs,
            ["guesthandoff_v1.retained-377"]
        )
    }

    func testLostSuccessfulClaimResponseResolvesTheAccountOwnedRun() async throws {
        let authority = Self.authority
        let retainedHandoffs = GuestClaimHandoffRecorder()
        retainedHandoffs.save(
            GuestClaimHandoff(
                token: "guesthandoff_v1.lost-response-377",
                expiresAt: Date(timeIntervalSince1970: 4_089_168_000),
                recoveryID: authority.recoveryID,
                photoIdentity: authority.photoIdentity
            )
        )
        let requests = GuestClaimRequestRecorder()
        let session = makeSession { request in
            let path = request.url?.path ?? ""
            requests.record(
                path: path,
                handoff: request.value(forHTTPHeaderField: "X-SnapList-Guest-Handoff")
            )
            switch path {
            case "/v1/guest/claims":
                throw URLError(.networkConnectionLost)
            case "/v1/runs/\(authority.runID.uuidString.lowercased())":
                return Self.response(
                    status: 200,
                    json: """
                    {
                      "data": {
                        "id": "\(authority.runID.uuidString.lowercased())",
                        "itemId": "\(authority.itemID.uuidString.lowercased())",
                        "listingId": "\(authority.draftID.uuidString.lowercased())"
                      },
                      "meta": { "requestId": "req-resolve-377" }
                    }
                    """
                )
            default:
                XCTFail("Unexpected request path: \(path)")
                return Self.response(status: 404, json: "{}")
            }
        }
        let client = GuestClaimAPIClient(
            baseURL: URL(string: "https://snaplist.dev")!,
            proofProvider: GuestClaimProofProvider(),
            tokenProvider: GuestClaimBearerProvider(),
            handoffStore: retainedHandoffs,
            session: session
        )

        let outcome = try await client.claim(
            authority: authority,
            idempotencyKey: UUID(
                uuidString: "37700000-0000-4000-8000-000000000109"
            )!
        )

        XCTAssertEqual(outcome, .claimed(Self.handoff))
        XCTAssertEqual(
            requests.paths,
            [
                "/v1/guest/claims",
                "/v1/runs/\(authority.runID.uuidString.lowercased())",
            ]
        )
        XCTAssertFalse(
            retainedHandoffs.contains(
                token: "guesthandoff_v1.lost-response-377",
                recoveryID: authority.recoveryID
            )
        )
    }

    func testClaimRelaunchResolvesCommittedTruthBeforeRequestingAnotherHandoff()
        async throws {
        let root = FileManager.default.temporaryDirectory.appending(
            path: "guest-claim-relaunch-\(UUID().uuidString)",
            directoryHint: .isDirectory
        )
        let attemptURL = root.appending(path: "attempts.json")
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let service = LostThenResolvedGuestClaimService(outcome: .claimed(Self.handoff))
        let authorityStore = GuestClaimAuthorityRecorder()
        let credentialStore = GuestRecoveryCredentialRecorder()

        let firstStore = GuestClaimStore(
            authority: Self.authority,
            authenticator: GuestClaimRecordingAuthenticator(),
            service: service,
            attemptStore: FileGuestClaimAttemptStore(fileURL: attemptURL),
            authorityStore: authorityStore,
            credentialStore: credentialStore
        )
        await firstStore.showEmailEntry()
        await firstStore.sendCode(to: "seller@example.com")
        await firstStore.verifyAndClaim(code: "123456")
        XCTAssertEqual(firstStore.state, .copyFailed)

        let relaunchedStore = GuestClaimStore(
            authority: Self.authority,
            authenticator: GuestClaimRecordingAuthenticator(),
            service: service,
            attemptStore: FileGuestClaimAttemptStore(fileURL: attemptURL),
            authorityStore: authorityStore,
            credentialStore: credentialStore
        )
        await relaunchedStore.resumeClaim()

        let calls = await service.calls
        XCTAssertEqual(relaunchedStore.state, .claimed(Self.handoff))
        XCTAssertEqual(calls.claims, 1)
        XCTAssertEqual(calls.resolutions, 1)
        XCTAssertEqual(calls.prepares, 2)
    }

    func testClaimDoesNotReportTerminalTruthUntilHandoffCleanupSucceeds() async throws {
        let authority = Self.authority
        let retainedHandoffs = GuestClaimHandoffRecorder(purgeFailures: 1)
        retainedHandoffs.save(
            GuestClaimHandoff(
                token: "guesthandoff_v1.cleanup-377",
                expiresAt: Date(timeIntervalSince1970: 4_089_168_000),
                recoveryID: authority.recoveryID,
                photoIdentity: authority.photoIdentity
            )
        )
        let session = makeSession { _ in
            Self.response(
                status: 200,
                json: """
                {
                  "data": {
                    "outcome": "claimed",
                    "itemId": "\(authority.itemID.uuidString.lowercased())",
                    "runId": "\(authority.runID.uuidString.lowercased())",
                    "draftId": "\(authority.draftID.uuidString.lowercased())"
                  },
                  "meta": { "requestId": "req-cleanup-377" }
                }
                """
            )
        }
        let client = GuestClaimAPIClient(
            baseURL: URL(string: "https://snaplist.dev")!,
            proofProvider: GuestClaimProofProvider(),
            tokenProvider: GuestClaimBearerProvider(),
            handoffStore: retainedHandoffs,
            session: session
        )

        do {
            _ = try await client.claim(authority: authority, idempotencyKey: UUID())
            XCTFail("Terminal truth must wait for durable handoff cleanup.")
        } catch {
            XCTAssertEqual(error as? GuestClaimServiceError, .proofUnavailable)
        }
        XCTAssertTrue(
            retainedHandoffs.contains(
                token: "guesthandoff_v1.cleanup-377",
                recoveryID: authority.recoveryID
            )
        )
    }

    func testUnknownClaimOutcomeFailsClosedInsteadOfPurgingAsExpired() async throws {
        let authority = Self.authority
        let retainedHandoffs = GuestClaimHandoffRecorder()
        retainedHandoffs.save(
            GuestClaimHandoff(
                token: "guesthandoff_v1.unknown-outcome-377",
                expiresAt: Date(timeIntervalSince1970: 4_089_168_000),
                recoveryID: authority.recoveryID,
                photoIdentity: authority.photoIdentity
            )
        )
        let session = makeSession { request in
            XCTAssertEqual(request.url?.path, "/v1/guest/claims")
            return Self.response(
                status: 200,
                json: """
                {
                  "data": {
                    "outcome": "unknown",
                    "itemId": "\(authority.itemID.uuidString.lowercased())",
                    "runId": "\(authority.runID.uuidString.lowercased())",
                    "draftId": "\(authority.draftID.uuidString.lowercased())"
                  },
                  "meta": { "requestId": "req-unknown-377" }
                }
                """
            )
        }
        let client = GuestClaimAPIClient(
            baseURL: URL(string: "https://snaplist.dev")!,
            proofProvider: GuestClaimProofProvider(),
            tokenProvider: GuestClaimBearerProvider(),
            handoffStore: retainedHandoffs,
            session: session
        )

        do {
            _ = try await client.claim(
                authority: authority,
                idempotencyKey: UUID(
                    uuidString: "37700000-0000-4000-8000-000000000108"
                )!
            )
            XCTFail("Unknown server truth must not be treated as expiry.")
        } catch {
            XCTAssertEqual(error as? GuestClaimServiceError, .unavailable)
        }
    }

    func testGuestClaimConflictsUseStructuredReasonsInsteadOfMessageCopy() async throws {
        for (reason, expected) in [
            ("guest_claim_allowance_spent", GuestClaimServiceError.allowanceSpent),
            ("guest_claim_allowance_in_flight", .allowanceInFlight),
            ("guest_claim_in_progress", .busy),
        ] {
            let authority = Self.authority
            let retainedHandoffs = GuestClaimHandoffRecorder()
            retainedHandoffs.save(
                GuestClaimHandoff(
                    token: "guesthandoff_v1.reason-377",
                    expiresAt: Date(timeIntervalSince1970: 4_089_168_000),
                    recoveryID: authority.recoveryID,
                    photoIdentity: authority.photoIdentity
                )
            )
            let session = makeSession { _ in
                Self.response(
                    status: 409,
                    json: """
                    {
                      "error": {
                        "code": "conflict",
                        "message": "Conflict copy may change.",
                        "requestId": "req-reason-377",
                        "details": { "reason": "\(reason)" }
                      }
                    }
                    """
                )
            }
            let client = GuestClaimAPIClient(
                baseURL: URL(string: "https://snaplist.dev")!,
                proofProvider: GuestClaimProofProvider(),
                tokenProvider: GuestClaimBearerProvider(),
                handoffStore: retainedHandoffs,
                session: session
            )

            do {
                _ = try await client.claim(authority: authority, idempotencyKey: UUID())
                XCTFail("Expected structured conflict \(reason).")
            } catch {
                XCTAssertEqual(error as? GuestClaimServiceError, expected)
            }
        }
    }

    func testPostCopyAllowanceConflictsPreserveTheLateDenialStage() async throws {
        for (reason, expected) in [
            (
                "guest_claim_allowance_spent",
                GuestClaimServiceError.allowanceSpentAfterCopy
            ),
            (
                "guest_claim_allowance_in_flight",
                GuestClaimServiceError.allowanceInFlightAfterCopy
            ),
        ] {
            let authority = Self.authority
            let retainedHandoffs = GuestClaimHandoffRecorder()
            retainedHandoffs.save(
                GuestClaimHandoff(
                    token: "guesthandoff_v1.late-denial-377",
                    expiresAt: Date(timeIntervalSince1970: 4_089_168_000),
                    recoveryID: authority.recoveryID,
                    photoIdentity: authority.photoIdentity
                )
            )
            let session = makeSession { _ in
                Self.response(
                    status: 409,
                    json: """
                    {
                      "error": {
                        "code": "conflict",
                        "message": "Conflict copy may change.",
                        "requestId": "req-late-denial-377",
                        "details": {
                          "reason": "\(reason)",
                          "claimStage": "post_copy"
                        }
                      }
                    }
                    """
                )
            }
            let client = GuestClaimAPIClient(
                baseURL: URL(string: "https://snaplist.dev")!,
                proofProvider: GuestClaimProofProvider(),
                tokenProvider: GuestClaimBearerProvider(),
                handoffStore: retainedHandoffs,
                session: session
            )

            do {
                _ = try await client.claim(
                    authority: authority,
                    idempotencyKey: UUID()
                )
                XCTFail("Expected late structured conflict \(reason).")
            } catch {
                XCTAssertEqual(error as? GuestClaimServiceError, expected)
            }
        }
    }

    func testPostCopyAllowanceDenialsUseCleanupAwareClaimStates() async {
        for (error, expected) in [
            (
                GuestClaimServiceError.allowanceSpentAfterCopy,
                GuestClaimState.allowanceSpentAfterCopy
            ),
            (
                GuestClaimServiceError.allowanceInFlightAfterCopy,
                GuestClaimState.allowanceInFlightAfterCopy
            ),
        ] {
            let store = GuestClaimStore(
                authority: Self.authority,
                authenticator: GuestClaimRecordingAuthenticator(),
                service: GuestClaimFailingService(error: error),
                attemptStore: MemoryGuestClaimAttemptStore()
            )

            await store.showEmailEntry()
            await store.sendCode(to: "seller@example.com")
            await store.verifyAndClaim(code: "123456")

            XCTAssertEqual(store.state, expected)
        }
    }

    func testRetryKeepsPostCopyInFlightDenialBoundToTheSameAccount() async {
        let service = GuestClaimSequencedFailureService(errors: [
            .allowanceInFlightAfterCopy,
            .allowanceInFlight,
        ])
        let store = GuestClaimStore(
            authority: Self.authority,
            authenticator: GuestClaimRecordingAuthenticator(),
            service: service,
            attemptStore: MemoryGuestClaimAttemptStore()
        )

        await store.showEmailEntry()
        await store.sendCode(to: "seller@example.com")
        await store.verifyAndClaim(code: "123456")
        XCTAssertEqual(store.state, .allowanceInFlightAfterCopy)

        await store.retryClaim()

        XCTAssertEqual(store.state, .allowanceInFlightAfterCopy)
    }

    private func makeSession(
        handler: @escaping @Sendable (URLRequest) throws -> (HTTPURLResponse, Data)
    ) -> URLSession {
        GuestClaimURLProtocolStub.handler = handler
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [GuestClaimURLProtocolStub.self]
        return URLSession(configuration: configuration)
    }

    nonisolated private static func response(
        status: Int,
        json: String
    ) -> (HTTPURLResponse, Data) {
        (
            HTTPURLResponse(
                url: URL(string: "https://snaplist.dev")!,
                statusCode: status,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!,
            Data(json.utf8)
        )
    }

    private static let authority = GuestClaimAuthority(
        recoveryID: UUID(uuidString: "37700000-0000-4000-8000-000000000101")!,
        recoveryToken: "guest-recovery-token-377-abcdefghijklmnopqrstuvwxyz",
        itemID: handoff.itemID,
        runID: handoff.runID,
        draftID: handoff.draftID,
        reviewRevision: UUID(
            uuidString: "37700000-0000-4000-8000-000000000105"
        )!,
        photoIdentity: GuestPhotoIdentity(
            kind: "content_sha256_set_v1",
            fingerprint: String(repeating: "a", count: 64)
        )
    )

    private static let handoff = ClaimedGuestListing(
        itemID: UUID(uuidString: "37700000-0000-4000-8000-000000000102")!,
        runID: UUID(uuidString: "37700000-0000-4000-8000-000000000103")!,
        draftID: UUID(uuidString: "37700000-0000-4000-8000-000000000104")!
    )
}

private final class GuestClaimHandoffRecorder:
    GuestClaimHandoffStoring,
    @unchecked Sendable {
    private let lock = NSLock()
    private var handoffs: [UUID: GuestClaimHandoff] = [:]
    private var purgeFailures: Int

    init(purgeFailures: Int = 0) {
        self.purgeFailures = purgeFailures
    }

    func handoff(recoveryID: UUID) -> GuestClaimHandoff? {
        lock.withLock { handoffs[recoveryID] }
    }

    func save(_ handoff: GuestClaimHandoff) {
        lock.withLock { handoffs[handoff.recoveryID] = handoff }
    }

    func purge(recoveryID: UUID) throws {
        try lock.withLock {
            if purgeFailures > 0 {
                purgeFailures -= 1
                throw GuestClaimServiceError.proofUnavailable
            }
            handoffs[recoveryID] = nil
        }
    }

    func contains(token: String, recoveryID: UUID) -> Bool {
        lock.withLock { handoffs[recoveryID]?.token == token }
    }
}

private final class GuestClaimRequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var recordedPaths: [String] = []
    private var recordedClaimHandoffs: [String] = []

    var paths: [String] { lock.withLock { recordedPaths } }
    var claimHandoffs: [String] { lock.withLock { recordedClaimHandoffs } }
    var claimCount: Int { lock.withLock { recordedClaimHandoffs.count } }

    func record(path: String, handoff: String?) {
        lock.withLock {
            recordedPaths.append(path)
            if let handoff { recordedClaimHandoffs.append(handoff) }
        }
    }
}

private struct GuestClaimProofProvider: AppAttestProofProviding {
    func assertionProof(requestBody: Data) async -> AppAttestProofOutcome {
        .proof(
            AppAttestAssertionProof(
                assertionObject: Data("assertion-377".utf8),
                challengeID: UUID(
                    uuidString: "37700000-0000-4000-8000-000000000107"
                )!,
                keyID: "key-377"
            )
        )
    }
}

private struct GuestClaimBearerProvider: BearerTokenProviding {
    func bearerToken() async throws -> String { "account-token-377" }
}

private final class GuestClaimURLProtocolStub: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler:
        (@Sendable (URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }
}

private struct GuestClaimRecordingAuthenticator: GuestAccountAuthenticating {
    func sendCode(to email: String) async throws {}
    func verify(code: String) async throws {}
}

private actor GuestClaimRecordingService: GuestClaimServing {
    struct Claim: Sendable {
        let authority: GuestClaimAuthority
        let idempotencyKey: UUID
    }

    private(set) var claims: [Claim] = []
    private(set) var prepareCount = 0
    let outcome: GuestClaimOutcome

    init(outcome: GuestClaimOutcome) {
        self.outcome = outcome
    }

    var claimCount: Int { claims.count }

    func prepareHandoff(authority: GuestClaimAuthority) async throws {
        prepareCount += 1
    }

    func claim(
        authority: GuestClaimAuthority,
        idempotencyKey: UUID
    ) async throws -> GuestClaimOutcome {
        claims.append(Claim(authority: authority, idempotencyKey: idempotencyKey))
        return outcome
    }
}

private actor GuestClaimFailingService: GuestClaimServing {
    let error: GuestClaimServiceError

    init(error: GuestClaimServiceError) {
        self.error = error
    }

    func prepareHandoff(authority: GuestClaimAuthority) async throws {}

    func claim(
        authority: GuestClaimAuthority,
        idempotencyKey: UUID
    ) async throws -> GuestClaimOutcome {
        throw error
    }
}

private actor GuestClaimSequencedFailureService: GuestClaimServing {
    private var errors: [GuestClaimServiceError]

    init(errors: [GuestClaimServiceError]) {
        self.errors = errors
    }

    func prepareHandoff(authority: GuestClaimAuthority) async throws {}

    func claim(
        authority: GuestClaimAuthority,
        idempotencyKey: UUID
    ) async throws -> GuestClaimOutcome {
        throw errors.removeFirst()
    }
}

private actor LostThenResolvedGuestClaimService: GuestClaimServing {
    private let outcome: GuestClaimOutcome
    private var didLoseResponse = false
    private(set) var claimCount = 0
    private(set) var resolutionCount = 0
    private(set) var prepareCount = 0

    init(outcome: GuestClaimOutcome) {
        self.outcome = outcome
    }

    var calls: (claims: Int, resolutions: Int, prepares: Int) {
        (claimCount, resolutionCount, prepareCount)
    }

    func prepareHandoff(authority: GuestClaimAuthority) async throws {
        prepareCount += 1
    }

    func resolveClaim(
        authority: GuestClaimAuthority
    ) async throws -> GuestClaimOutcome? {
        resolutionCount += 1
        return didLoseResponse ? outcome : nil
    }

    func claim(
        authority: GuestClaimAuthority,
        idempotencyKey: UUID
    ) async throws -> GuestClaimOutcome {
        claimCount += 1
        didLoseResponse = true
        throw GuestClaimServiceError.unavailable
    }
}

private actor GuestClaimAuthorityRecorder: GuestClaimAuthorityStoring {
    private(set) var purgeCount = 0

    func authority(listingID: UUID) -> GuestClaimAuthority? { nil }

    func save(_ authority: GuestClaimAuthority, listingID: UUID) {}

    func purge(recoveryID: UUID) {
        purgeCount += 1
    }
}

private actor GuestRecoveryCredentialRecorder: GuestRecoveryCredentialStoring {
    private(set) var purgeCount = 0
    private var purgeFailures: Int

    init(purgeFailures: Int = 0) {
        self.purgeFailures = purgeFailures
    }

    func mintCredential() throws -> GuestRecoverySubmissionIdentity {
        throw GuestClaimServiceError.unavailable
    }

    func contains(_ identity: GuestRecoverySubmissionIdentity) -> Bool { false }

    func bind(
        _ identity: GuestRecoverySubmissionIdentity,
        itemID: UUID,
        runID: UUID,
        photoIdentity: GuestPhotoIdentity
    ) {}

    func credential(runID: UUID) -> GuestRecoveryCredential? { nil }
    func credential(recoveryID: UUID) -> GuestRecoveryCredential? { nil }
    func setExpiry(recoveryID: UUID, expiresAt: Date) {}

    func purge(recoveryID: UUID) throws {
        purgeCount += 1
        if purgeFailures > 0 {
            purgeFailures -= 1
            throw GuestClaimServiceError.proofUnavailable
        }
    }
}
