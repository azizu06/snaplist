import Foundation
import XCTest
@testable import SnapList

@MainActor
final class GuestClaimTests: XCTestCase {
    func testAccountEntryDismissalOnlyContinuesAfterARealSessionTransition() {
        let inactive = AccountEntrySessionSnapshot(
            isActive: false,
            userID: nil
        )
        let active = AccountEntrySessionSnapshot(
            isActive: true,
            userID: "user_account_entry"
        )

        XCTAssertEqual(
            AccountEntryPresentationTransition.signal(
                baseline: active,
                current: active
            ),
            .dismissed
        )
        XCTAssertEqual(
            AccountEntryPresentationTransition.signal(
                baseline: inactive,
                current: active
            ),
            .authenticationChanged
        )
    }

    func testAccountEntrySessionResolverFailsClosedUntilSameSessionPrincipalIsQualified() async throws {
        let userID = "user_account_entry"
        let matchingProof = try XCTUnwrap(
            ItemRunSubmissionPrincipalScopeProof(
                verifiedClerkSubject: userID
            )
        )
        let mismatchedProof = try XCTUnwrap(
            ItemRunSubmissionPrincipalScopeProof(
                verifiedClerkSubject: "user_other"
            )
        )
        let cases: [(AccountEntrySessionSignal, GuestClaimAccountSessionSource)] = [
            (
                .dismissed,
                GuestClaimAccountSessionSource(
                    snapshot: .init(isActive: true, userID: userID),
                    result: .success(
                        PrincipalBoundBearer(
                            bearerToken: "clerk_live",
                            scopeProof: matchingProof
                        )
                    )
                )
            ),
            (
                .authenticationChanged,
                GuestClaimAccountSessionSource(
                    snapshot: .init(isActive: false, userID: userID),
                    result: .success(
                        PrincipalBoundBearer(
                            bearerToken: "clerk_live",
                            scopeProof: matchingProof
                        )
                    )
                )
            ),
            (
                .authenticationChanged,
                GuestClaimAccountSessionSource(
                    snapshot: .init(isActive: true, userID: nil),
                    result: .success(
                        PrincipalBoundBearer(
                            bearerToken: "clerk_live",
                            scopeProof: matchingProof
                        )
                    )
                )
            ),
            (
                .authenticationChanged,
                GuestClaimAccountSessionSource(
                    snapshot: .init(isActive: true, userID: userID),
                    result: .failure(.principalBindingUnavailable)
                )
            ),
            (
                .authenticationChanged,
                GuestClaimAccountSessionSource(
                    snapshot: .init(isActive: true, userID: userID),
                    result: .success(
                        PrincipalBoundBearer(
                            bearerToken: "clerk_other",
                            scopeProof: mismatchedProof
                        )
                    )
                )
            ),
        ]

        for (signal, source) in cases {
            let handler = GuestClaimQualifiedSessionRecorder()
            let resolver = AccountEntrySessionResolver(
                source: source,
                handler: handler
            )

            let resolution = await resolver.resolve(signal)
            let count = await handler.count
            XCTAssertEqual(resolution, .preserved)
            XCTAssertEqual(count, 0)
        }
    }

    func testAccountEntrySessionResolverContinuesOneQualifiedSameSessionPrincipalOnce() async throws {
        let userID = "user_account_entry"
        let proof = try XCTUnwrap(
            ItemRunSubmissionPrincipalScopeProof(
                verifiedClerkSubject: userID
            )
        )
        let source = GuestClaimAccountSessionSource(
            snapshot: .init(isActive: true, userID: userID),
            result: .success(
                PrincipalBoundBearer(
                    bearerToken: "clerk_live",
                    scopeProof: proof
                )
            )
        )
        let handler = GuestClaimQualifiedSessionRecorder()
        let resolver = AccountEntrySessionResolver(
            source: source,
            handler: handler
        )

        let first = await resolver.resolve(.authenticationChanged)
        let second = await resolver.resolve(.authenticationChanged)
        XCTAssertEqual(first, .continued)
        XCTAssertEqual(second, .alreadyContinued)
        let sessions = await handler.sessions
        XCTAssertEqual(sessions.map(\.userID), [userID])
        XCTAssertEqual(sessions.map(\.bearer.bearerToken), ["clerk_live"])
    }

    func testAccountEntrySessionResolverQualifiesAnAlreadyActiveCurrentSession() async throws {
        let userID = "user_already_active"
        let proof = try XCTUnwrap(
            ItemRunSubmissionPrincipalScopeProof(
                verifiedClerkSubject: userID
            )
        )
        let source = GuestClaimAccountSessionSource(
            snapshot: .init(isActive: true, userID: userID),
            result: .success(
                PrincipalBoundBearer(
                    bearerToken: "clerk_already_active",
                    scopeProof: proof
                )
            )
        )
        let handler = GuestClaimQualifiedSessionRecorder()
        let resolver = AccountEntrySessionResolver(
            source: source,
            handler: handler
        )

        let resolution = await resolver.resolveCurrentSession()

        XCTAssertEqual(resolution, .continued)
        let sessions = await handler.sessions
        XCTAssertEqual(sessions.map(\.userID), [userID])
        XCTAssertEqual(
            sessions.map(\.bearer.bearerToken),
            ["clerk_already_active"]
        )
    }

    func testGuestClaimListingProjectionFailsClosedForEveryAuthorityAndDraftMismatch() throws {
        let fixture = GuestClaimProjectionFixture()
        let invalidInputs: [(GuestClaimAuthority, GuestRecoveryCredential, ListingReviewDraft, Bool, Date)] = [
            (fixture.authority(itemID: UUID()), fixture.credential(), fixture.draft(), false, fixture.now),
            (fixture.authority(runID: UUID()), fixture.credential(), fixture.draft(), false, fixture.now),
            (fixture.authority(draftID: UUID()), fixture.credential(), fixture.draft(), false, fixture.now),
            (fixture.authority(reviewRevision: UUID()), fixture.credential(), fixture.draft(), false, fixture.now),
            (fixture.authority(photoIdentity: .init(kind: "sha256", fingerprint: "other")), fixture.credential(), fixture.draft(), false, fixture.now),
            (fixture.authority(), fixture.credential(recoveryID: UUID()), fixture.draft(), false, fixture.now),
            (fixture.authority(), fixture.credential(recoveryToken: "recovery_v1.other"), fixture.draft(), false, fixture.now),
            (fixture.authority(), fixture.credential(omitsExpiry: true), fixture.draft(), false, fixture.now),
            (fixture.authority(), fixture.credential(expiresAt: fixture.now), fixture.draft(), false, fixture.now),
            (fixture.authority(), fixture.credential(), fixture.draft(), true, fixture.now),
            (fixture.authority(), fixture.credential(), fixture.draft(title: "  "), false, fixture.now),
            (fixture.authority(), fixture.credential(), fixture.draft(price: Decimal(string: "0")!), false, fixture.now),
        ]

        for (authority, credential, draft, isDirty, now) in invalidInputs {
            XCTAssertNil(
                GuestClaimListingProjection.project(
                    snapshot: fixture.snapshot,
                    draft: draft,
                    isDirty: isDirty,
                    authority: authority,
                    credential: credential,
                    now: now
                )
            )
        }
    }

    func testGuestClaimListingProjectionUsesSavedTitleSellerPriceFirstPhotoAndExactExpiry() throws {
        let fixture = GuestClaimProjectionFixture()
        let expiry = fixture.now.addingTimeInterval(3_600)

        let projection = try XCTUnwrap(
            GuestClaimListingProjection.project(
                snapshot: fixture.snapshot,
                draft: fixture.draft(
                    title: "Saved seller title",
                    price: Decimal(string: "63.25")!
                ),
                isDirty: false,
                authority: fixture.authority(),
                credential: fixture.credential(expiresAt: expiry),
                now: fixture.now
            )
        )

        XCTAssertEqual(projection.title, "Saved seller title")
        XCTAssertEqual(projection.effectivePrice, Decimal(string: "63.25"))
        XCTAssertEqual(
            projection.thumbnail,
            .authoritative(URL(string: "https://example.com/photos/1.jpg")!)
        )
        XCTAssertEqual(projection.expiresAt, expiry)
    }

    func testGuestClaimEntryResolverLoadsOnlyTheExactAuthorityBoundProjection() async throws {
        let fixture = GuestClaimProjectionFixture()
        let authority = fixture.authority()
        let credential = fixture.credential(
            expiresAt: fixture.now.addingTimeInterval(3_600)
        )
        let resolver = GuestClaimEntryResolver(
            authorityStore: GuestClaimAuthorityRecorder(
                authority: authority
            ),
            credentialStore: GuestRecoveryCredentialRecorder(
                credential: credential
            ),
            now: { fixture.now }
        )

        let resolution = await resolver.resolve(
            listingID: authority.draftID,
            snapshot: fixture.snapshot,
            draft: fixture.draft(
                title: "Saved seller title",
                price: Decimal(string: "63.25")!
            ),
            isDirty: false
        )

        XCTAssertEqual(
            resolution,
            .claim(
                authority: authority,
                projection: GuestClaimListingProjection(
                    title: "Saved seller title",
                    effectivePrice: Decimal(string: "63.25")!,
                    thumbnail: .authoritative(
                        URL(string: "https://example.com/photos/1.jpg")!
                    ),
                    expiresAt: credential.expiresAt!
                )
            )
        )
    }

    func testSupportedAccountEntryCancelPreservesExactClaimWithoutStartingMutation() async throws {
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

        await store.beginSupportedAuthentication()
        XCTAssertEqual(store.state, .authenticating)
        store.cancelSupportedAuthentication()

        let prepareCount = await service.prepareCount
        let claimCount = await service.claimCount
        let authorityPurgeCount = await authorityStore.purgeCount
        let credentialPurgeCount = await credentialStore.purgeCount
        XCTAssertEqual(store.state, .gate)
        XCTAssertEqual(prepareCount, 1)
        XCTAssertEqual(claimCount, 0)
        XCTAssertEqual(authorityPurgeCount, 0)
        XCTAssertEqual(credentialPurgeCount, 0)
    }

    func testQualifiedSupportedAccountSessionClaimsExactAuthorityOnce() async throws {
        let service = GuestClaimRecordingService(outcome: .claimed(Self.handoff))
        let store = GuestClaimStore(
            authority: Self.authority,
            authenticator: GuestClaimRecordingAuthenticator(),
            service: service,
            attemptStore: MemoryGuestClaimAttemptStore()
        )
        let userID = "user_supported_account"
        let proof = try XCTUnwrap(
            ItemRunSubmissionPrincipalScopeProof(
                verifiedClerkSubject: userID
            )
        )
        let bearer = PrincipalBoundBearer(
            bearerToken: "clerk_supported",
            scopeProof: proof
        )
        let session = AccountEntryQualifiedSession(
            userID: userID,
            bearer: bearer,
            refreshBearer: { bearer }
        )

        await store.beginSupportedAuthentication()
        await store.qualifiedSession(session)
        await store.qualifiedSession(session)

        let claims = await service.claims
        XCTAssertEqual(store.state, .claimed(Self.handoff))
        XCTAssertEqual(claims.count, 1)
        XCTAssertEqual(claims.first?.authority, Self.authority)
        XCTAssertEqual(
            claims.first?.authenticatedBy.bearerToken,
            "clerk_supported"
        )
        XCTAssertEqual(claims.first?.authenticatedBy.scopeProof, proof)
    }

    func testRetryRefreshesQualifiedBearerOnlyForTheSamePrincipal() async throws {
        let userID = "user_retry_refresh"
        let proof = try XCTUnwrap(
            ItemRunSubmissionPrincipalScopeProof(
                verifiedClerkSubject: userID
            )
        )
        let otherProof = try XCTUnwrap(
            ItemRunSubmissionPrincipalScopeProof(
                verifiedClerkSubject: "user_switched_account"
            )
        )
        let cases: [(PrincipalBoundBearer, [String])] = [
            (
                PrincipalBoundBearer(
                    bearerToken: "clerk_fresh_same_principal",
                    scopeProof: proof
                ),
                ["clerk_expired", "clerk_fresh_same_principal"]
            ),
            (
                PrincipalBoundBearer(
                    bearerToken: "clerk_other_principal",
                    scopeProof: otherProof
                ),
                ["clerk_expired"]
            ),
        ]

        for (refreshedBearer, expectedTokens) in cases {
            let refresher = GuestClaimBearerRefresher(
                bearer: refreshedBearer
            )
            let service = GuestClaimRefreshRetryService(
                outcome: .claimed(Self.handoff)
            )
            let store = GuestClaimStore(
                authority: Self.authority,
                authenticator: GuestClaimRecordingAuthenticator(),
                service: service,
                attemptStore: MemoryGuestClaimAttemptStore()
            )
            await store.beginSupportedAuthentication()
            await store.qualifiedSession(
                AccountEntryQualifiedSession(
                    userID: userID,
                    bearer: PrincipalBoundBearer(
                        bearerToken: "clerk_expired",
                        scopeProof: proof
                    ),
                    refreshBearer: { try await refresher.refresh() }
                )
            )
            XCTAssertEqual(store.state, .copyFailed)

            await store.retryClaim()

            let tokens = await service.bearerTokens
            let refreshCount = await refresher.callCount
            XCTAssertEqual(tokens, expectedTokens)
            XCTAssertEqual(refreshCount, 1)
            XCTAssertEqual(
                store.state,
                expectedTokens.count == 2
                    ? .claimed(Self.handoff)
                    : .copyFailed
            )
        }
    }

    func testAllowanceDenialCanReopenOnlyTheSupportedAccountEntry() async throws {
        let store = GuestClaimStore(
            authority: Self.authority,
            authenticator: GuestClaimRecordingAuthenticator(),
            service: GuestClaimFailingService(error: .allowanceSpent),
            attemptStore: MemoryGuestClaimAttemptStore()
        )
        let userID = "user_spent_allowance"
        let proof = try XCTUnwrap(
            ItemRunSubmissionPrincipalScopeProof(
                verifiedClerkSubject: userID
            )
        )

        await store.beginSupportedAuthentication()
        let bearer = PrincipalBoundBearer(
            bearerToken: "clerk_spent_allowance",
            scopeProof: proof
        )
        await store.qualifiedSession(
            AccountEntryQualifiedSession(
                userID: userID,
                bearer: bearer,
                refreshBearer: { bearer }
            )
        )
        XCTAssertEqual(store.state, .allowanceSpent)

        await store.beginSupportedAuthentication()

        XCTAssertEqual(store.state, .authenticating)
    }

    func testAllowanceDenialRequiresAnotherAccountAndCancelRestoresTheDenial() async throws {
        let store = GuestClaimStore(
            authority: Self.authority,
            authenticator: GuestClaimRecordingAuthenticator(),
            service: GuestClaimFailingService(error: .allowanceSpent),
            attemptStore: MemoryGuestClaimAttemptStore()
        )
        let userID = "user_spent_allowance"
        let proof = try XCTUnwrap(
            ItemRunSubmissionPrincipalScopeProof(
                verifiedClerkSubject: userID
            )
        )
        let bearer = PrincipalBoundBearer(
            bearerToken: "clerk_spent_allowance",
            scopeProof: proof
        )

        await store.beginSupportedAuthentication()
        await store.qualifiedSession(
            AccountEntryQualifiedSession(
                userID: userID,
                bearer: bearer,
                refreshBearer: { bearer }
            )
        )
        XCTAssertEqual(store.state, .allowanceSpent)

        let policy = await store.beginSupportedAuthentication()

        XCTAssertEqual(policy, .requireDifferentPrincipal)
        XCTAssertEqual(store.state, .authenticating)
        store.cancelSupportedAuthentication()
        XCTAssertEqual(store.state, .allowanceSpent)
    }

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
        let funnelAnalytics = FunnelAnalyticsEventSinkSpy()
        let store = GuestClaimStore(
            authority: Self.authority,
            authenticator: GuestClaimRecordingAuthenticator(),
            service: service,
            attemptStore: MemoryGuestClaimAttemptStore(),
            authorityStore: authorityStore,
            credentialStore: credentialStore,
            funnelAnalytics: funnelAnalytics,
            authenticatedUserID: { "user_633" }
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
        XCTAssertEqual(funnelAnalytics.identifiedUserIDs, ["user_633"])
        XCTAssertEqual(funnelAnalytics.events, [.accountClaimed])
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

    func testClaimAndReconciliationRequirePrincipalBoundBearerBeforeRequestConstruction()
        async throws {
        let authority = Self.authority
        let retainedHandoffs = GuestClaimHandoffRecorder()
        retainedHandoffs.save(
            GuestClaimHandoff(
                token: "guesthandoff_v1.principal-required-743",
                expiresAt: Date(timeIntervalSince1970: 4_089_168_000),
                recoveryID: authority.recoveryID,
                photoIdentity: authority.photoIdentity
            )
        )
        let requests = GuestClaimRequestRecorder()
        let session = makeSession { request in
            requests.record(
                path: request.url?.path ?? "",
                handoff: request.value(
                    forHTTPHeaderField: "X-SnapList-Guest-Handoff"
                ),
                authorization: request.value(
                    forHTTPHeaderField: "Authorization"
                )
            )
            return Self.response(
                status: 200,
                json: """
                {
                  "data": {
                    "outcome": "claimed",
                    "itemId": "\(Self.handoff.itemID.uuidString.lowercased())",
                    "runId": "\(Self.handoff.runID.uuidString.lowercased())",
                    "draftId": "\(Self.handoff.draftID.uuidString.lowercased())"
                  },
                  "meta": { "requestId": "req-principal-743" }
                }
                """
            )
        }
        let client = GuestClaimAPIClient(
            baseURL: URL(string: "https://snaplist.dev")!,
            proofProvider: GuestClaimProofProvider(),
            tokenProvider: GuestClaimGuestOnlyBearerProvider(),
            handoffStore: retainedHandoffs,
            session: session
        )

        do {
            _ = try await client.claim(
                authority: authority,
                idempotencyKey: UUID(
                    uuidString: "74300000-0000-4000-8000-000000000001"
                )!
            )
            XCTFail("A guest bearer must not authorize account claim")
        } catch {
            XCTAssertEqual(
                error as? BearerTokenProviderError,
                .principalBindingUnavailable
            )
        }

        let userID = "user_exact_principal_743"
        let scopeProof = try XCTUnwrap(
            ItemRunSubmissionPrincipalScopeProof(
                verifiedClerkSubject: userID
            )
        )
        let outcome = try await client.claim(
            authority: authority,
            idempotencyKey: UUID(
                uuidString: "74300000-0000-4000-8000-000000000002"
            )!,
            authenticatedBy: PrincipalBoundBearer(
                bearerToken: "clerk_exact_principal_743",
                scopeProof: scopeProof
            )
        )
        XCTAssertEqual(outcome, .claimed(Self.handoff))

        do {
            _ = try await client.resolveClaim(authority: authority)
            XCTFail("A guest bearer must not authorize claim reconciliation")
        } catch {
            XCTAssertEqual(
                error as? BearerTokenProviderError,
                .principalBindingUnavailable
            )
        }

        XCTAssertEqual(requests.paths, ["/v1/guest/claims"])
        XCTAssertEqual(
            requests.authorizations,
            ["Bearer clerk_exact_principal_743"]
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
    private var recordedAuthorizations: [String] = []

    var paths: [String] { lock.withLock { recordedPaths } }
    var claimHandoffs: [String] { lock.withLock { recordedClaimHandoffs } }
    var authorizations: [String] { lock.withLock { recordedAuthorizations } }
    var claimCount: Int { lock.withLock { recordedClaimHandoffs.count } }

    func record(
        path: String,
        handoff: String?,
        authorization: String? = nil
    ) {
        lock.withLock {
            recordedPaths.append(path)
            if let handoff { recordedClaimHandoffs.append(handoff) }
            if let authorization { recordedAuthorizations.append(authorization) }
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

    func principalBoundBearer() async throws -> PrincipalBoundBearer {
        let userID = "user_guest_claim_377"
        guard let scopeProof = ItemRunSubmissionPrincipalScopeProof(
            verifiedClerkSubject: userID
        ) else {
            throw BearerTokenProviderError.principalBindingUnavailable
        }
        return PrincipalBoundBearer(
            bearerToken: "account-token-377",
            scopeProof: scopeProof
        )
    }
}

private struct GuestClaimGuestOnlyBearerProvider: BearerTokenProviding {
    func bearerToken() async throws -> String { "guestcap_v1.must-not-authorize" }

    func principalBoundBearer() async throws -> PrincipalBoundBearer {
        throw BearerTokenProviderError.principalBindingUnavailable
    }
}

private struct GuestClaimProjectionFixture {
    let snapshot = ListingReviewLaunchFixture.review()
    let now = Date(timeIntervalSince1970: 1_786_000_000)
    let recoveryID = UUID(
        uuidString: "74300000-0000-4000-8000-000000000001"
    )!
    let recoveryToken = "recovery_v1.fixture"
    let photoIdentity = GuestPhotoIdentity(
        kind: "sha256",
        fingerprint: String(repeating: "a", count: 64)
    )

    func authority(
        itemID: UUID? = nil,
        runID: UUID? = nil,
        draftID: UUID? = nil,
        reviewRevision: UUID? = nil,
        photoIdentity: GuestPhotoIdentity? = nil
    ) -> GuestClaimAuthority {
        GuestClaimAuthority(
            recoveryID: recoveryID,
            recoveryToken: recoveryToken,
            itemID: itemID ?? snapshot.binding.itemID,
            runID: runID ?? snapshot.binding.runID,
            draftID: draftID ?? snapshot.binding.listingID,
            reviewRevision: reviewRevision ?? snapshot.binding.reviewRevision,
            photoIdentity: photoIdentity ?? self.photoIdentity
        )
    }

    func credential(
        recoveryID: UUID? = nil,
        recoveryToken: String? = nil,
        expiresAt: Date? = nil,
        omitsExpiry: Bool = false
    ) -> GuestRecoveryCredential {
        GuestRecoveryCredential(
            recoveryID: recoveryID ?? self.recoveryID,
            recoveryToken: recoveryToken ?? self.recoveryToken,
            recoveryTokenHash: GuestClaimListingProjection.tokenHash(
                recoveryToken ?? self.recoveryToken
            ),
            itemID: snapshot.binding.itemID,
            runID: snapshot.binding.runID,
            photoIdentity: photoIdentity,
            expiresAt: omitsExpiry
                ? nil
                : expiresAt ?? now.addingTimeInterval(3_600)
        )
    }

    func draft(
        title: String? = nil,
        price: Decimal? = nil
    ) -> ListingReviewDraft {
        var draft = ListingReviewDraft(snapshot: snapshot)
        if let title { draft.title = title }
        draft.sellerPriceOverride = price
        return draft
    }
}

private struct GuestClaimAccountSessionSource: AccountEntrySessionSourcing {
    let snapshotValue: AccountEntrySessionSnapshot
    let result: Result<PrincipalBoundBearer, BearerTokenProviderError>

    init(
        snapshot: AccountEntrySessionSnapshot,
        result: Result<PrincipalBoundBearer, BearerTokenProviderError>
    ) {
        snapshotValue = snapshot
        self.result = result
    }

    func snapshot() async -> AccountEntrySessionSnapshot { snapshotValue }

    func principalBoundBearer() async throws -> PrincipalBoundBearer {
        try result.get()
    }
}

private actor GuestClaimQualifiedSessionRecorder:
    AccountEntryQualifiedSessionHandling {
    private(set) var sessions: [AccountEntryQualifiedSession] = []

    var count: Int { sessions.count }

    func handle(_ session: AccountEntryQualifiedSession) {
        sessions.append(session)
    }
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
        let authenticatedBy: PrincipalBoundBearer
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
        let userID = "user_legacy_guest_claim_test"
        guard let scopeProof = ItemRunSubmissionPrincipalScopeProof(
            verifiedClerkSubject: userID
        ) else {
            throw GuestClaimServiceError.unavailable
        }
        return try await claim(
            authority: authority,
            idempotencyKey: idempotencyKey,
            authenticatedBy: PrincipalBoundBearer(
                bearerToken: "legacy-test-bearer",
                scopeProof: scopeProof
            )
        )
    }

    func claim(
        authority: GuestClaimAuthority,
        idempotencyKey: UUID,
        authenticatedBy bearer: PrincipalBoundBearer
    ) async throws -> GuestClaimOutcome {
        claims.append(
            Claim(
                authority: authority,
                idempotencyKey: idempotencyKey,
                authenticatedBy: bearer
            )
        )
        return outcome
    }
}

private actor GuestClaimBearerRefresher {
    private let bearer: PrincipalBoundBearer
    private(set) var callCount = 0

    init(bearer: PrincipalBoundBearer) {
        self.bearer = bearer
    }

    func refresh() -> PrincipalBoundBearer {
        callCount += 1
        return bearer
    }
}

private actor GuestClaimRefreshRetryService: GuestClaimServing {
    private let outcome: GuestClaimOutcome
    private(set) var bearerTokens: [String] = []

    init(outcome: GuestClaimOutcome) {
        self.outcome = outcome
    }

    func prepareHandoff(authority: GuestClaimAuthority) async throws {}

    func claim(
        authority: GuestClaimAuthority,
        idempotencyKey: UUID
    ) async throws -> GuestClaimOutcome {
        throw GuestClaimServiceError.unavailable
    }

    func claim(
        authority: GuestClaimAuthority,
        idempotencyKey: UUID,
        authenticatedBy bearer: PrincipalBoundBearer
    ) async throws -> GuestClaimOutcome {
        bearerTokens.append(bearer.bearerToken)
        guard bearerTokens.count > 1 else {
            throw GuestClaimServiceError.unavailable
        }
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
    private let storedAuthority: GuestClaimAuthority?

    init(authority: GuestClaimAuthority? = nil) {
        storedAuthority = authority
    }

    func authority(listingID: UUID) -> GuestClaimAuthority? {
        guard storedAuthority?.draftID == listingID else { return nil }
        return storedAuthority
    }

    func save(_ authority: GuestClaimAuthority, listingID: UUID) {}

    func purge(recoveryID: UUID) {
        purgeCount += 1
    }
}

private actor GuestRecoveryCredentialRecorder: GuestRecoveryCredentialStoring {
    private(set) var purgeCount = 0
    private var purgeFailures: Int
    private let storedCredential: GuestRecoveryCredential?

    init(
        purgeFailures: Int = 0,
        credential: GuestRecoveryCredential? = nil
    ) {
        self.purgeFailures = purgeFailures
        storedCredential = credential
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

    func credential(runID: UUID) -> GuestRecoveryCredential? {
        guard storedCredential?.runID == runID else { return nil }
        return storedCredential
    }
    func credential(recoveryID: UUID) -> GuestRecoveryCredential? {
        guard storedCredential?.recoveryID == recoveryID else { return nil }
        return storedCredential
    }
    func setExpiry(recoveryID: UUID, expiresAt: Date) {}

    func purge(recoveryID: UUID) throws {
        purgeCount += 1
        if purgeFailures > 0 {
            purgeFailures -= 1
            throw GuestClaimServiceError.proofUnavailable
        }
    }
}
