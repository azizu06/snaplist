import Foundation
import SwiftUI
import XCTest
@testable import SnapList

@MainActor
final class EbayPublishDeliveryTests: XCTestCase {
    override func tearDown() {
        EbayPublishURLProtocolStub.handler = nil
        super.tearDown()
    }

    func testUnknownOutcomeCopyOffersOnlyTheApprovedTrophyWallRecovery() {
        let copy = EbayResultCopy(state: .outcomeNotYetKnown)

        XCTAssertEqual(
            copy.headline,
            "SnapList does not know yet whether eBay accepted this listing."
        )
        XCTAssertEqual(copy.chip, "Checking with eBay")
        XCTAssertEqual(
            copy.body,
            "The connection dropped at the wrong moment. SnapList will find out and update Flips."
        )
        XCTAssertEqual(
            copy.note,
            "There is nothing for you to do, and nothing will be posted twice."
        )
        XCTAssertEqual(copy.primary, "Go to Flips")
        XCTAssertNil(copy.secondary)

        let sellerVisibleCopy = [
            copy.headline,
            copy.chip,
            copy.body,
            copy.note,
            copy.primary,
            copy.secondary,
        ]
            .compactMap { $0 }
            .joined(separator: " ")
            .lowercased()
        XCTAssertFalse(sellerVisibleCopy.contains("published"))
        XCTAssertFalse(sellerVisibleCopy.contains("shared"))
        XCTAssertFalse(sellerVisibleCopy.contains("check again"))
        XCTAssertFalse(sellerVisibleCopy.contains("try again"))
        XCTAssertFalse(sellerVisibleCopy.contains("retry"))
    }

    /// `XCUIElement.hasFocus` is UIKit focus, not VoiceOver focus. Exercise the
    /// rendered SwiftUI seam instead: every approved seller-visible transition
    /// resolves to the real heading identifier, and that heading's body names
    /// the modifier which owns its accessibility-focus binding. Result headings
    /// additionally carry live-update semantics; no announcement text is
    /// synthesized by this contract.
    /// B2+ connect and return: one screen whose three steps tick off as the
    /// seller signs in on eBay and comes back, ending at their account.
    func testConnectPathTicksStepsAsTheSellerSignsInAndComesBack() {
        let first = EbayConnectionCopy(state: .notConnected)
        XCTAssertEqual(first.headline, "Post to eBay")
        XCTAssertEqual(first.steps.map(\.title), [
            "Sign in on eBay", "Let SnapList post", "Review and post",
        ])
        XCTAssertEqual(first.steps.map(\.phase), [.active, .upcoming, .upcoming])
        XCTAssertEqual(first.accountTitle, "Your eBay account")
        XCTAssertEqual(first.primary, "Continue to eBay")
        XCTAssertNil(first.secondary)

        let waiting = EbayConnectionCopy(state: .connecting)
        XCTAssertEqual(waiting.steps.map(\.phase), [.waiting, .upcoming, .upcoming])
        XCTAssertEqual(waiting.steps[0].detail, "Waiting for eBay")
        XCTAssertNil(waiting.primary)
        XCTAssertEqual(waiting.secondary, "Cancel")

        let connected = EbayConnectionCopy(state: .connected, username: " jordanhale ")
        XCTAssertEqual(connected.headline, "Connected as jordanhale")
        XCTAssertEqual(connected.steps.map(\.phase), [.done, .done, .active])
        XCTAssertEqual(connected.accountTitle, "jordanhale")
        XCTAssertEqual(connected.primary, "Review before posting")
        XCTAssertNil(connected.secondary)

        let unnamed = EbayConnectionCopy(state: .connected, username: nil)
        XCTAssertEqual(unnamed.headline, "Connected to eBay")
        XCTAssertEqual(unnamed.accountTitle, "Your eBay account")
    }

    /// Every retry state keeps the same screen, marks the one step that
    /// stopped, says nothing was posted, and offers one way forward.
    func testConnectRetryStatesMarkTheStepThatStoppedAndSayNothingPosted() {
        let expected: [(EbayConnectionViewState, Int, String, String)] = [
            (.cancelled, 0, "Sign in not finished. Nothing posted.", "Continue to eBay"),
            (.declined, 1, "Access not granted. Nothing posted.", "Continue to eBay"),
            (.timedOut, 0, "Sign in timed out. Nothing posted.", "Continue to eBay"),
            (.failed, 0, "eBay didn't connect. Nothing posted.", "Continue to eBay"),
            (.reconnectNeeded, 0, "Connection expired. Nothing posted.", "Reconnect eBay"),
        ]
        for (state, index, detail, primary) in expected {
            let copy = EbayConnectionCopy(state: state, username: "jordanhale")
            XCTAssertEqual(
                copy.steps.filter { $0.phase == .warning }.count, 1, "\(state)"
            )
            XCTAssertEqual(copy.steps[index].phase, .warning, "\(state)")
            XCTAssertEqual(copy.steps[index].detail, detail, "\(state)")
            XCTAssertEqual(copy.primary, primary, "\(state)")
            XCTAssertNil(copy.secondary, "\(state)")
            XCTAssertEqual(copy.accountTitle, "Your eBay account", "\(state)")
        }
    }

    func testSellerVisibleScreenTransitionsBindTheirRealHeadingFocusTargets() async {
        struct Fixture {
            let screen: EbayPublishScreen
            let heading: String
            let identifier: String
            let isLiveRegion: Bool
        }

        let fixtures = [
            Fixture(
                screen: .connection(.notConnected),
                heading: "Post to eBay",
                identifier: "ebay-publish.connection.not-connected",
                isLiveRegion: false
            ),
            Fixture(
                screen: .confirmation(.ready),
                heading: "Post this to eBay?",
                identifier: "ebay-publish.confirmation",
                isLiveRegion: false
            ),
            Fixture(
                screen: .result(.published),
                heading: "Your listing is live on eBay.",
                identifier: "ebay-publish.result.published",
                isLiveRegion: true
            ),
            Fixture(
                screen: .result(.outcomeNotYetKnown),
                heading: "SnapList does not know yet whether eBay accepted this listing.",
                identifier: "ebay-publish.result.outcome-unknown",
                isLiveRegion: true
            ),
        ]
        let liveUpdateTrait = AccessibilityTraits.updatesFrequently

        for fixture in fixtures {
            let target = EbayPublishHeadingFocusTarget(screen: fixture.screen)
            let behavior = EbayPublishHeadingFocusBehavior(target: target)

            XCTAssertEqual(target.identifier, fixture.identifier)
            XCTAssertEqual(target.isLiveRegion, fixture.isLiveRegion)
            XCTAssertEqual(
                behavior.accessibilityTraits.contains(liveUpdateTrait),
                fixture.isLiveRegion
            )
            XCTAssertTrue(
                behavior.accessibilityTraits
                    .subtracting(liveUpdateTrait)
                    .isEmpty
            )

            var focusRequests: [Bool] = []
            await behavior.requestFocus { isFocused in
                focusRequests.append(isFocused)
            }
            XCTAssertEqual(
                focusRequests,
                [true],
                "The transition did not apply true through its focus setter for \(fixture.identifier)"
            )

            let heading = EbayPublishFocusedHeading(
                text: fixture.heading,
                target: target
            )
            let rendered = String(reflecting: type(of: heading.body))

            XCTAssertTrue(
                rendered.contains("EbayPublishHeadingAccessibilityFocus"),
                "The real heading does not own the focus binding for \(fixture.identifier): \(rendered)"
            )
        }
    }

    func testProductionFlowRelaunchReplaysAmbiguousPublishAndConvergesOnce()
        async throws {
        let listingID = UUID(uuidString: "37700000-0000-4000-8000-000000000020")!
        let reviewRevision = UUID(uuidString: "37700000-0000-4000-8000-000000000002")!
        let root = FileManager.default.temporaryDirectory.appending(
            path: "ebay-publish-relaunch-\(UUID().uuidString)",
            directoryHint: .isDirectory
        )
        let attemptURL = root.appending(path: "attempts.json")
        addTeardownBlock {
            try? FileManager.default.removeItem(at: root)
        }
        let preflight = Self.preflight(
            title: "Saved seller draft",
            revision: reviewRevision
        )
        let service = AmbiguousThenReplayEbayPublishService(preflight: preflight)

        let firstFlow = EbayPublishFlowStore(
            listingID: listingID,
            service: service,
            oauth: EbayOAuthFixtureRunner(result: .connected),
            attemptStore: FileEbayPublishAttemptStore(fileURL: attemptURL)
        )
        await firstFlow.load()
        await firstFlow.confirmPublish()

        XCTAssertEqual(firstFlow.screen, .result(.outcomeNotYetKnown))

        let funnelAnalytics = FunnelAnalyticsEventSinkSpy()
        let relaunchedFlow = EbayPublishFlowStore(
            listingID: listingID,
            service: service,
            oauth: EbayOAuthFixtureRunner(result: .connected),
            attemptStore: FileEbayPublishAttemptStore(fileURL: attemptURL),
            funnelAnalytics: funnelAnalytics
        )
        await relaunchedFlow.load()

        let providerTruth = await service.providerTruth
        XCTAssertEqual(providerTruth.mutationCount, 1)
        XCTAssertEqual(providerTruth.idempotencyKeys.count, 2)
        XCTAssertEqual(
            providerTruth.idempotencyKeys.first,
            providerTruth.idempotencyKeys.last
        )
        XCTAssertEqual(
            relaunchedFlow.publishedListing?.ebayListingID,
            providerTruth.canonicalListing.ebayListingID
        )
        XCTAssertEqual(relaunchedFlow.screen, .result(.published))
        await relaunchedFlow.load()
        XCTAssertEqual(funnelAnalytics.events, [.ebayPublishConfirmed])
    }

    func testIOS170UsesTheOwnedCustomSchemeCallbackBridge() throws {
        let target = try XCTUnwrap(
            EbayOAuthCallbackTarget.resolve(
                httpsCallbackURL: URL(
                    string: "https://snaplist.dev/mobile/ebay/oauth"
                )!,
                supportsHTTPSCallback: false
            )
        )

        XCTAssertEqual(
            target,
            .customScheme(
                scheme: "snaplist",
                expectedURL: URL(string: "snaplist://ebay/oauth")!
            )
        )
    }

    func testIOS174UsesTheAssociatedHTTPSCallback() throws {
        let callbackURL = URL(
            string: "https://snaplist.dev/mobile/ebay/oauth"
        )!
        let target = try XCTUnwrap(
            EbayOAuthCallbackTarget.resolve(
                httpsCallbackURL: callbackURL,
                supportsHTTPSCallback: true
            )
        )

        XCTAssertEqual(
            target,
            .https(host: "snaplist.dev", path: "/mobile/ebay/oauth", expectedURL: callbackURL)
        )
    }

    func testPublishClientSendsOneExplicitConfirmationAndMapsCanonicalProviderTruth() async throws {
        let listingID = UUID(uuidString: "37700000-0000-4000-8000-000000000011")!
        let reviewRevision = UUID(uuidString: "37700000-0000-4000-8000-000000000012")!
        let idempotencyKey = UUID(uuidString: "37700000-0000-4000-8000-000000000013")!
        let session = makeSession { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(
                request.value(forHTTPHeaderField: "Authorization"),
                "Bearer account-token"
            )
            XCTAssertEqual(
                request.value(forHTTPHeaderField: "Idempotency-Key"),
                idempotencyKey.uuidString.lowercased()
            )
            let bodyData = try Self.bodyData(from: request)
            let body = try XCTUnwrap(
                JSONSerialization.jsonObject(with: bodyData)
                    as? [String: Any]
            )
            XCTAssertEqual(
                body["confirmation"] as? String,
                "publish_to_ebay"
            )
            XCTAssertEqual(
                body["expectedReviewRevision"] as? String,
                reviewRevision.uuidString.lowercased()
            )
            return Self.response(
                status: 200,
                json: """
                {
                  "data": {
                    "listingId": "\(listingID.uuidString.lowercased())",
                    "outcome": "published",
                    "ebayListingId": "110377000011",
                    "ebayOfferId": "offer-377",
                    "alreadyPublished": false,
                    "listingUrl": "https://www.sandbox.ebay.com/itm/110377000011",
                    "ebayEnvironment": "sandbox"
                  },
                  "meta": { "requestId": "req-377" }
                }
                """
            )
        }
        let client = EbayPublishAPIClient(
            baseURL: URL(string: "https://snaplist.dev")!,
            tokenProvider: EbayPublishTestBearer(),
            session: session
        )

        let result = try await client.publish(
            listingID: listingID,
            expectedReviewRevision: reviewRevision,
            idempotencyKey: idempotencyKey
        )

        XCTAssertEqual(
            result,
            .published(
                EbayPublishedListing(
                    ebayListingID: "110377000011",
                    listingURL: URL(
                        string: "https://www.sandbox.ebay.com/itm/110377000011"
                    )!
                )
            )
        )
    }

    func testPublishedListingURLPrefersProviderTruthThenMapsBothOfficialHosts() {
        let providerURL = URL(string: "https://www.ebay.com/itm/provider-truth")!

        XCTAssertEqual(
            EbayListingURL.resolve(
                providerURL: providerURL,
                listingID: "110377000011",
                environment: .sandbox
            ),
            providerURL
        )
        XCTAssertEqual(
            EbayListingURL.resolve(
                providerURL: nil,
                listingID: "110377000011",
                environment: .sandbox
            ),
            URL(string: "https://www.sandbox.ebay.com/itm/110377000011")
        )
        XCTAssertEqual(
            EbayListingURL.resolve(
                providerURL: nil,
                listingID: "110377000011",
                environment: .production
            ),
            URL(string: "https://www.ebay.com/itm/110377000011")
        )
    }

    func testPublishedListingURLNeverGuessesWithoutProviderURLOrEnvironment() {
        XCTAssertNil(
            EbayListingURL.resolve(
                providerURL: nil,
                listingID: "110377000011",
                environment: nil
            )
        )
    }

    func testPublishValidationErrorDoesNotShowAnAmbiguousOutcome() async {
        let listingID = UUID(
            uuidString: "69900000-0000-4000-8000-000000000001"
        )!
        let revision = UUID(
            uuidString: "69900000-0000-4000-8000-000000000002"
        )!
        let refusalMessage =
            "Your eBay account has no return policy for EBAY_US"
        let requests = EbayPublishRequestRecorder()
        let session = makeSession { request in
            requests.record(request)
            switch (request.httpMethod, request.url?.path) {
            case ("GET", "/v1/listings/\(listingID.uuidString.lowercased())/ebay/publish"):
                return Self.response(
                    status: 200,
                    json: """
                    {
                      "data": {
                        "listingId": "\(listingID.uuidString.lowercased())",
                        "outcome": "not_published",
                        "ebayListingId": null,
                        "ebayOfferId": null,
                        "alreadyPublished": false
                      }
                    }
                    """
                )
            case ("GET", "/v1/listings/\(listingID.uuidString.lowercased())/ebay/preflight"):
                return Self.response(
                    status: 200,
                    json: """
                    {
                      "data": {
                        "listingId": "\(listingID.uuidString.lowercased())",
                        "title": "Policy-sensitive listing",
                        "description": "Seller draft.",
                        "effectivePrice": { "amount": 58.25, "label": "What will be listed" },
                        "photoCount": 1,
                        "marketplace": "EBAY_US",
                        "ebayCondition": "USED_VERY_GOOD",
                        "itemSpecifics": {},
                        "reviewRevision": "\(revision.uuidString.lowercased())",
                        "connection": { "connected": true, "ebayUsername": "seller" },
                        "publishEligibility": { "enabled": false, "eligible": false }
                      }
                    }
                    """
                )
            case ("POST", "/v1/listings/\(listingID.uuidString.lowercased())/ebay/publish"):
                return Self.response(
                    status: 422,
                    json: """
                    {
                      "error": {
                        "message": "\(refusalMessage)"
                      }
                    }
                    """
                )
            default:
                throw URLError(.badURL)
            }
        }
        let service = EbayPublishAPIClient(
            baseURL: URL(string: "https://snaplist.dev")!,
            tokenProvider: EbayPublishTestBearer(),
            session: session
        )
        let flow = EbayPublishFlowStore(
            listingID: listingID,
            service: service,
            oauth: EbayOAuthFixtureRunner(result: .connected),
            attemptStore: MemoryEbayPublishAttemptStore()
        )

        await flow.load()
        await flow.confirmPublish()

        XCTAssertEqual(
            flow.screen,
            .result(.sellerFixableRefusal(message: refusalMessage))
        )
        guard case .result(let resultState) = flow.screen else {
            return XCTFail("Expected the seller-fixable refusal result screen.")
        }
        let copy = EbayResultCopy(state: resultState)
        XCTAssertEqual(copy.headline, "This listing was not posted.")
        XCTAssertEqual(copy.body, refusalMessage)
        XCTAssertEqual(requests.publishStatusRequestCount, 1)
    }

    func testPublishValidationErrorWithUndecodableBodyStillTerminatesAsSellerFixable()
        async {
        let listingID = UUID(
            uuidString: "69900000-0000-4000-8000-000000000003"
        )!
        let revision = UUID(
            uuidString: "69900000-0000-4000-8000-000000000004"
        )!
        let requests = EbayPublishRequestRecorder()
        let session = makeSession { request in
            requests.record(request)
            switch (request.httpMethod, request.url?.path) {
            case ("GET", "/v1/listings/\(listingID.uuidString.lowercased())/ebay/publish"):
                return Self.response(
                    status: 200,
                    json: """
                    {
                      "data": {
                        "listingId": "\(listingID.uuidString.lowercased())",
                        "outcome": "not_published",
                        "ebayListingId": null,
                        "ebayOfferId": null,
                        "alreadyPublished": false
                      }
                    }
                    """
                )
            case ("GET", "/v1/listings/\(listingID.uuidString.lowercased())/ebay/preflight"):
                return Self.response(
                    status: 200,
                    json: """
                    {
                      "data": {
                        "listingId": "\(listingID.uuidString.lowercased())",
                        "title": "Policy-sensitive listing",
                        "description": "Seller draft.",
                        "effectivePrice": { "amount": 58.25, "label": "What will be listed" },
                        "photoCount": 1,
                        "marketplace": "EBAY_US",
                        "ebayCondition": "USED_VERY_GOOD",
                        "itemSpecifics": {},
                        "reviewRevision": "\(revision.uuidString.lowercased())",
                        "connection": { "connected": true, "ebayUsername": "seller" },
                        "publishEligibility": { "enabled": false, "eligible": false }
                      }
                    }
                    """
                )
            case ("POST", "/v1/listings/\(listingID.uuidString.lowercased())/ebay/publish"):
                // A malformed 422 body (proxy/WAF/gateway error page, or a
                // differently-keyed payload) must still terminate as
                // seller-fixable, not fall through to the ambiguous outcome.
                return (
                    HTTPURLResponse(
                        url: URL(string: "https://snaplist.dev")!,
                        statusCode: 422,
                        httpVersion: nil,
                        headerFields: ["Content-Type": "text/html"]
                    )!,
                    Data("<html><body>Bad Gateway</body></html>".utf8)
                )
            default:
                throw URLError(.badURL)
            }
        }
        let service = EbayPublishAPIClient(
            baseURL: URL(string: "https://snaplist.dev")!,
            tokenProvider: EbayPublishTestBearer(),
            session: session
        )
        let flow = EbayPublishFlowStore(
            listingID: listingID,
            service: service,
            oauth: EbayOAuthFixtureRunner(result: .connected),
            attemptStore: MemoryEbayPublishAttemptStore()
        )

        await flow.load()
        await flow.confirmPublish()

        XCTAssertEqual(
            flow.screen,
            .result(
                .sellerFixableRefusal(
                    message: EbayPublishAPIClient.fallbackSellerFixableRefusalMessage
                )
            )
        )
        guard case .result(let resultState) = flow.screen else {
            return XCTFail("Expected the seller-fixable refusal result screen.")
        }
        let copy = EbayResultCopy(state: resultState)
        XCTAssertEqual(copy.headline, "This listing was not posted.")
        XCTAssertEqual(
            copy.body,
            EbayPublishAPIClient.fallbackSellerFixableRefusalMessage
        )
        // The revert guard: routing a non-decodable 422 back through the
        // generic catch would fall into resolveAmbiguousPublish(), which
        // issues a second status GET. Exactly one proves the terminal path.
        XCTAssertEqual(requests.publishStatusRequestCount, 1)
    }

    func testPreflightCarriesTheServerEffectivePriceAndMappedListingTruth() async throws {
        let listingID = UUID(
            uuidString: "37700000-0000-4000-8000-000000000014"
        )!
        let revision = UUID(
            uuidString: "37700000-0000-4000-8000-000000000015"
        )!
        let session = makeSession { request in
            XCTAssertEqual(request.httpMethod, "GET")
            return Self.response(
                status: 200,
                json: """
                {
                  "data": {
                    "listingId": "\(listingID.uuidString.lowercased())",
                    "title": "Seller edited title",
                    "description": "Current server description.",
                    "effectivePrice": {
                      "amount": 58.25,
                      "label": "What will be listed"
                    },
                    "photoCount": 4,
                    "marketplace": "EBAY_US",
                    "ebayCondition": "USED_VERY_GOOD",
                    "itemSpecifics": { "Brand": ["Sony"] },
                    "reviewRevision": "\(revision.uuidString.lowercased())",
                    "connection": {
                      "connected": true,
                      "ebayUsername": "sandbox-seller"
                    },
                    "publishEligibility": {
                      "enabled": false,
                      "eligible": false
                    }
                  },
                  "meta": { "requestId": "req-377" }
                }
                """
            )
        }
        let client = EbayPublishAPIClient(
            baseURL: URL(string: "https://snaplist.dev")!,
            tokenProvider: EbayPublishTestBearer(),
            session: session
        )

        let preflight = try await client.preflight(listingID: listingID)

        XCTAssertEqual(preflight.effectivePrice.amount, Decimal(string: "58.25"))
        XCTAssertEqual(preflight.effectivePrice.label, "What will be listed")
        XCTAssertEqual(preflight.title, "Seller edited title")
        XCTAssertEqual(preflight.description, "Current server description.")
        XCTAssertEqual(preflight.photoCount, 4)
        XCTAssertEqual(preflight.marketplace, "EBAY_US")
        XCTAssertEqual(preflight.ebayCondition, "USED_VERY_GOOD")
        XCTAssertEqual(preflight.itemSpecifics, ["Brand": ["Sony"]])
        XCTAssertEqual(preflight.reviewRevision, revision)
    }

    func testPublishClientMapsRevisionConflictWithoutRetryingTheMutation() async throws {
        let session = makeSession { _ in
            Self.response(
                status: 409,
                json: """
                {
                  "error": {
                    "code": "conflict",
                    "message": "Conflict.",
                    "requestId": "req-377",
                    "details": { "reason": "ebay_review_revision_changed" }
                  }
                }
                """
            )
        }
        let client = EbayPublishAPIClient(
            baseURL: URL(string: "https://snaplist.dev")!,
            tokenProvider: EbayPublishTestBearer(),
            session: session
        )

        let result = try await client.publish(
            listingID: UUID(),
            expectedReviewRevision: UUID(),
            idempotencyKey: UUID()
        )

        XCTAssertEqual(result, .staleRevision)
    }

    func testPublishClientKeepsChangedProviderAuthorityDistinctFromStaleContent() async throws {
        let session = makeSession { _ in
            Self.response(
                status: 409,
                json: """
                {
                  "error": {
                    "code": "conflict",
                    "message": "Conflict.",
                    "requestId": "req-377",
                    "details": { "reason": "ebay_published_authority_changed" }
                  }
                }
                """
            )
        }
        let client = EbayPublishAPIClient(
            baseURL: URL(string: "https://snaplist.dev")!,
            tokenProvider: EbayPublishTestBearer(),
            session: session
        )

        let result = try await client.publish(
            listingID: UUID(),
            expectedReviewRevision: UUID(),
            idempotencyKey: UUID()
        )

        XCTAssertEqual(result, .providerAuthorityChanged)
    }

    func testStaleRevisionReloadsCurrentPreflightAndRequiresFreshConfirmation() async {
        let original = Self.preflight(
            title: "Original title",
            description: "Original description.",
            revision: UUID(uuidString: "37700000-0000-4000-8000-000000000021")!
        )
        let current = Self.preflight(
            title: "Current title",
            description: "Current description.",
            revision: UUID(uuidString: "37700000-0000-4000-8000-000000000022")!
        )
        let service = StaleRevisionEbayPublishService(
            preflights: [original, current]
        )
        let store = EbayPublishFlowStore(
            listingID: original.listingID,
            service: service,
            oauth: EbayOAuthFixtureRunner(result: .connected),
            attemptStore: MemoryEbayPublishAttemptStore()
        )

        await store.load()
        await store.confirmPublish()

        let publishCount = await service.publishCount
        XCTAssertEqual(store.screen, .confirmation(.listingChanged))
        XCTAssertEqual(store.preflight?.title, "Current title")
        XCTAssertEqual(store.preflight?.description, "Current description.")
        XCTAssertEqual(publishCount, 1)
    }

    func testFailedStaleRevisionRefreshClearsStaleDetailsAndBlocksPost() async {
        let stale = Self.preflight(
            title: "Stale title",
            description: "Stale description.",
            revision: UUID(uuidString: "37700000-0000-4000-8000-000000000026")!
        )
        let service = StaleRevisionEbayPublishService(
            preflights: [stale],
            failAfterPreflights: 1
        )
        let store = EbayPublishFlowStore(
            listingID: stale.listingID,
            service: service,
            oauth: EbayOAuthFixtureRunner(result: .connected),
            attemptStore: MemoryEbayPublishAttemptStore()
        )

        await store.load()
        await store.confirmPublish()

        XCTAssertEqual(store.screen, .confirmation(.refreshFailed))
        XCTAssertNil(store.preflight)

        await store.confirmPublish()

        let publishCount = await service.publishCount
        XCTAssertEqual(publishCount, 1)
        XCTAssertEqual(store.screen, .confirmation(.refreshFailed))
    }

    func testDeclinedConnectionKeepsDraftAndStartsADistinctHostedSessionOnRetry() async {
        let preflight = Self.preflight(
            title: "Saved listing",
            revision: UUID(uuidString: "37700000-0000-4000-8000-000000000023")!
        )
        let service = StaleRevisionEbayPublishService(preflights: [preflight])
        let store = EbayPublishFlowStore(
            listingID: preflight.listingID,
            service: service,
            oauth: EbayOAuthFixtureRunner(result: .declined),
            attemptStore: MemoryEbayPublishAttemptStore()
        )

        await store.connect()
        XCTAssertEqual(store.screen, .connection(.declined))
        await store.connect()

        let keys = await service.oauthIdempotencyKeys
        let publishCount = await service.publishCount
        XCTAssertEqual(keys.count, 2)
        XCTAssertNotEqual(keys.first, keys.last)
        XCTAssertEqual(store.screen, .connection(.declined))
        XCTAssertEqual(publishCount, 0)
    }

    func testDuplicateConfirmationAfterPublishedTruthDoesNotMutateAgain() async {
        let service = CanonicalEbayPublishService()
        let delivery = EbayPublishStore(
            listingID: UUID(),
            expectedReviewRevision: UUID(),
            service: service,
            attemptStore: MemoryEbayPublishAttemptStore()
        )

        await delivery.confirmPublish()
        await delivery.confirmPublish()

        let mutationCount = await service.mutationCount
        XCTAssertEqual(delivery.phase, .published)
        XCTAssertEqual(mutationCount, 1)
    }

    func testFailedPublishKeepsDraftAndRetriesTheSameDurableAttempt() async {
        let preflight = Self.preflight(
            title: "Saved seller draft",
            revision: UUID(uuidString: "37700000-0000-4000-8000-000000000024")!
        )
        let service = FailureThenPublishedEbayService(preflight: preflight)
        let store = EbayPublishFlowStore(
            listingID: preflight.listingID,
            service: service,
            oauth: EbayOAuthFixtureRunner(result: .connected),
            attemptStore: MemoryEbayPublishAttemptStore()
        )

        await store.load()
        let publishCountBeforeConfirmation = await service.publishCount
        XCTAssertEqual(publishCountBeforeConfirmation, 0)
        XCTAssertEqual(store.preflight?.title, "Saved seller draft")

        await store.confirmPublish()
        let listingIDAfterFailure = store.listingID
        let titleAfterFailure = store.preflight?.title

        XCTAssertEqual(store.screen, .result(.unavailable))
        XCTAssertEqual(listingIDAfterFailure, preflight.listingID)
        XCTAssertEqual(titleAfterFailure, "Saved seller draft")

        await store.retryPublish()

        let keys = await service.idempotencyKeys
        XCTAssertEqual(store.screen, .result(.published))
        XCTAssertEqual(keys.count, 2)
        XCTAssertEqual(keys.first, keys.last)
    }

    func testDurableFailedPublishRelaunchReloadsPreflightAndRetriesSameAttempt()
        async throws {
        let preflight = Self.preflight(
            title: "Relaunched seller draft",
            revision: UUID(uuidString: "37700000-0000-4000-8000-000000000025")!
        )
        let root = FileManager.default.temporaryDirectory.appending(
            path: "ebay-publish-failed-relaunch-\(UUID().uuidString)",
            directoryHint: .isDirectory
        )
        let attemptURL = root.appending(path: "attempts.json")
        addTeardownBlock {
            try? FileManager.default.removeItem(at: root)
        }
        let service = FailureThenPublishedEbayService(preflight: preflight)
        let firstFlow = EbayPublishFlowStore(
            listingID: preflight.listingID,
            service: service,
            oauth: EbayOAuthFixtureRunner(result: .connected),
            attemptStore: FileEbayPublishAttemptStore(fileURL: attemptURL)
        )

        await firstFlow.load()
        await firstFlow.confirmPublish()
        XCTAssertEqual(firstFlow.screen, .result(.unavailable))

        let relaunchedFlow = EbayPublishFlowStore(
            listingID: preflight.listingID,
            service: service,
            oauth: EbayOAuthFixtureRunner(result: .connected),
            attemptStore: FileEbayPublishAttemptStore(fileURL: attemptURL)
        )
        await relaunchedFlow.load()

        XCTAssertEqual(relaunchedFlow.screen, .result(.unavailable))
        XCTAssertEqual(relaunchedFlow.preflight?.title, "Relaunched seller draft")

        await relaunchedFlow.retryPublish()

        let keys = await service.idempotencyKeys
        XCTAssertEqual(relaunchedFlow.screen, .result(.published))
        XCTAssertEqual(keys.count, 2)
        XCTAssertEqual(keys.first, keys.last)
    }

    func testDurableFailedPublishRelaunchRequiresConfirmationForNewRevision()
        async throws {
        let original = Self.preflight(
            title: "Failed original draft",
            revision: UUID(uuidString: "37700000-0000-4000-8000-000000000026")!
        )
        let current = Self.preflight(
            title: "Current revised draft",
            revision: UUID(uuidString: "37700000-0000-4000-8000-000000000027")!
        )
        let root = FileManager.default.temporaryDirectory.appending(
            path: "ebay-publish-failed-revised-\(UUID().uuidString)",
            directoryHint: .isDirectory
        )
        let attemptURL = root.appending(path: "attempts.json")
        addTeardownBlock {
            try? FileManager.default.removeItem(at: root)
        }
        let service = FailureThenPublishedEbayService(
            preflights: [original, current]
        )
        let firstFlow = EbayPublishFlowStore(
            listingID: original.listingID,
            service: service,
            oauth: EbayOAuthFixtureRunner(result: .connected),
            attemptStore: FileEbayPublishAttemptStore(fileURL: attemptURL)
        )

        await firstFlow.load()
        await firstFlow.confirmPublish()
        XCTAssertEqual(firstFlow.screen, .result(.unavailable))

        let relaunchedFlow = EbayPublishFlowStore(
            listingID: original.listingID,
            service: service,
            oauth: EbayOAuthFixtureRunner(result: .connected),
            attemptStore: FileEbayPublishAttemptStore(fileURL: attemptURL)
        )
        await relaunchedFlow.load()

        XCTAssertEqual(relaunchedFlow.preflight?.title, "Current revised draft")
        XCTAssertEqual(relaunchedFlow.screen, .confirmation(.listingChanged))

        await relaunchedFlow.retryPublish()
        let keysBeforeConfirmation = await service.idempotencyKeys
        XCTAssertEqual(keysBeforeConfirmation.count, 1)

        await relaunchedFlow.confirmPublish()

        let keys = await service.idempotencyKeys
        XCTAssertEqual(relaunchedFlow.screen, .result(.published))
        XCTAssertEqual(keys.count, 2)
        XCTAssertNotEqual(keys.first, keys.last)
    }

    private func makeSession(
        handler: @escaping @Sendable (URLRequest) throws -> (HTTPURLResponse, Data)
    ) -> URLSession {
        EbayPublishURLProtocolStub.handler = handler
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [EbayPublishURLProtocolStub.self]
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

    nonisolated private static func bodyData(
        from request: URLRequest
    ) throws -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else {
            throw URLError(.cannotDecodeContentData)
        }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1_024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count < 0 {
                throw stream.streamError ?? URLError(.cannotDecodeContentData)
            }
            if count == 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }

    private static func preflight(
        title: String,
        description: String = "The server-mapped description.",
        revision: UUID
    ) -> EbayPublishPreflight {
        EbayPublishPreflight(
            listingID: UUID(uuidString: "37700000-0000-4000-8000-000000000020")!,
            title: title,
            description: description,
            effectivePrice: .init(amount: 58, label: "What will be listed"),
            photoCount: 3,
            marketplace: "EBAY_US",
            ebayCondition: "USED_VERY_GOOD",
            itemSpecifics: ["Brand": ["Sony"]],
            reviewRevision: revision,
            connection: .init(connected: true, ebayUsername: "sandbox-seller"),
            publishEligibility: .init(enabled: false, eligible: false)
        )
    }

    // MARK: - Sensory feedback (#1060)

    func testEbayPublishSensoryFeedbackFiresSuccessOnPublished() {
        let feedback = EbayPublishSensoryFeedbackPolicy.resultFeedback(
            previousScreen: .result(.publishing),
            currentScreen: .result(.published)
        )
        XCTAssertEqual(feedback, .success)
    }

    func testEbayPublishSensoryFeedbackFiresErrorOnRefusal() {
        let feedback = EbayPublishSensoryFeedbackPolicy.resultFeedback(
            previousScreen: .result(.publishing),
            currentScreen: .result(.sellerFixableRefusal(message: "Missing required item specifics."))
        )
        XCTAssertEqual(feedback, .error)
    }

    func testEbayPublishSensoryFeedbackDoesNotFireOnUnrelatedTransition() {
        let feedback = EbayPublishSensoryFeedbackPolicy.resultFeedback(
            previousScreen: .confirmation(.ready),
            currentScreen: .result(.publishing)
        )
        XCTAssertNil(feedback)
    }

    func testEbayPublishSensoryFeedbackDoesNotFireWhenResultStateUnchanged() {
        let feedback = EbayPublishSensoryFeedbackPolicy.resultFeedback(
            previousScreen: .result(.published),
            currentScreen: .result(.published)
        )
        XCTAssertNil(feedback)
    }

    // MARK: - The seller's own posting, reopened from Trophy Wall

    func testOwnPostingOpensTheConfirmedProductionOrSandboxItemPage() async {
        let listingID = UUID()
        for (environment, expected) in [
            (EbayListingEnvironment.production, "https://www.ebay.com/itm/110377000001"),
            (EbayListingEnvironment.sandbox, "https://www.sandbox.ebay.com/itm/110377000001"),
        ] {
            let service = OwnPostingStatusService(.success(EbayPublishStatus(
                listingID: listingID,
                outcome: .published,
                ebayListingID: "110377000001",
                ebayOfferID: "offer-1",
                alreadyPublished: true,
                listingURL: nil,
                environment: environment
            )))

            let destination = await EbayOwnListingDestination.resolve(
                listingID: listingID,
                service: service
            )

            XCTAssertEqual(destination?.absoluteString, expected)
            let calls = await service.calls
            XCTAssertEqual(calls.statusListingIDs, [listingID])
            XCTAssertEqual(calls.publishCount, 0, "Reading a posting must never publish.")
        }
    }

    func testOwnPostingPrefersTheProviderReceiptURLForThatListing() async {
        let listingID = UUID()
        let service = OwnPostingStatusService(.success(EbayPublishStatus(
            listingID: listingID,
            outcome: .published,
            ebayListingID: "110377000001",
            ebayOfferID: nil,
            alreadyPublished: true,
            listingURL: URL(string: "https://www.sandbox.ebay.com/itm/110377000001?ssPageName=x#top"),
            environment: .production
        )))

        let destination = await EbayOwnListingDestination.resolve(
            listingID: listingID,
            service: service
        )

        XCTAssertEqual(
            destination?.absoluteString,
            "https://www.sandbox.ebay.com/itm/110377000001"
        )
    }

    func testOwnPostingHasNoDestinationUntilEbayConfirmedThisListing() async {
        let listingID = UUID()
        let unconfirmed: [EbayPublishStatus] = [
            .init(listingID: listingID, outcome: .notPublished, ebayListingID: nil,
                  ebayOfferID: nil, alreadyPublished: false, environment: .production),
            .init(listingID: listingID, outcome: .outcomeNotYetKnown, ebayListingID: nil,
                  ebayOfferID: nil, alreadyPublished: false, environment: .production),
            .init(listingID: listingID, outcome: .failed, ebayListingID: nil,
                  ebayOfferID: nil, alreadyPublished: false, environment: .production),
            // Published without eBay's listing id is not a posting anyone can open.
            .init(listingID: listingID, outcome: .published, ebayListingID: nil,
                  ebayOfferID: nil, alreadyPublished: true, environment: .production),
            // An id with no environment cannot say which eBay it lives on.
            .init(listingID: listingID, outcome: .published, ebayListingID: "110377000001",
                  ebayOfferID: nil, alreadyPublished: true, environment: nil),
            // Another listing's receipt is never this item's posting.
            .init(listingID: UUID(), outcome: .published, ebayListingID: "110377000001",
                  ebayOfferID: nil, alreadyPublished: true, environment: .production),
        ]
        for status in unconfirmed {
            let destination = await EbayOwnListingDestination.resolve(
                listingID: listingID,
                service: OwnPostingStatusService(.success(status))
            )
            XCTAssertNil(destination, "\(status)")
        }

        let unreadable = await EbayOwnListingDestination.resolve(
            listingID: listingID,
            service: OwnPostingStatusService(.failure(EbayPublishClientError.invalidResponse))
        )
        XCTAssertNil(unreadable, "A failed read must hide the link, not guess one.")
    }

    func testOwnPostingRefusesAProviderURLThatIsNotAnEbayItemPage() async {
        let listingID = UUID()
        for untrusted in [
            "http://www.ebay.com/itm/110377000001",
            "https://ebay.com.example.com/itm/110377000001",
            "https://www.ebay.com/sch/i.html?_nkw=controller",
            "https://www.ebay.com/itm/",
            "https://name:password@www.ebay.com/itm/110377000001",
        ] {
            let destination = await EbayOwnListingDestination.resolve(
                listingID: listingID,
                service: OwnPostingStatusService(.success(EbayPublishStatus(
                    listingID: listingID,
                    outcome: .published,
                    ebayListingID: "110377000001",
                    ebayOfferID: nil,
                    alreadyPublished: true,
                    listingURL: URL(string: untrusted),
                    environment: .production
                )))
            )
            XCTAssertNil(destination, untrusted)
        }
    }
}

/// Answers only the read-only status call; every other method records or
/// refuses, so a test can prove resolving a posting never reaches publish.
private actor OwnPostingStatusService: EbayPublishFeatureServing {
    private let statusResult: Result<EbayPublishStatus, Error>
    private(set) var statusListingIDs: [UUID] = []
    private(set) var publishCount = 0

    init(_ statusResult: Result<EbayPublishStatus, Error>) {
        self.statusResult = statusResult
    }

    var calls: (statusListingIDs: [UUID], publishCount: Int) {
        (statusListingIDs, publishCount)
    }

    func createOAuthSession(idempotencyKey: UUID) async throws -> EbayOAuthSession {
        throw EbayPublishClientError.invalidResponse
    }
    func connection() async throws -> EbayConnectionStatus {
        throw EbayPublishClientError.invalidResponse
    }
    func disconnect() async throws -> EbayConnectionStatus {
        throw EbayPublishClientError.invalidResponse
    }
    func preflight(listingID: UUID) async throws -> EbayPublishPreflight {
        throw EbayPublishClientError.invalidResponse
    }
    func status(listingID: UUID) async throws -> EbayPublishStatus {
        statusListingIDs.append(listingID)
        return try statusResult.get()
    }
    func publish(
        listingID: UUID,
        expectedReviewRevision: UUID,
        idempotencyKey: UUID
    ) async throws -> EbayPublishTransportOutcome {
        publishCount += 1
        throw EbayPublishClientError.invalidResponse
    }
}

private struct EbayPublishTestBearer: BearerTokenProviding {
    func bearerToken() async throws -> String { "account-token" }
}

private final class EbayPublishRequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var statusRequestCount = 0

    var publishStatusRequestCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return statusRequestCount
    }

    func record(_ request: URLRequest) {
        guard request.httpMethod == "GET",
              request.url?.path.hasSuffix("/ebay/publish") == true else {
            return
        }
        lock.lock()
        statusRequestCount += 1
        lock.unlock()
    }
}

private final class EbayPublishURLProtocolStub: URLProtocol, @unchecked Sendable {
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

private actor AmbiguousThenReplayEbayPublishService: EbayPublishFeatureServing {
    private let preflightValue: EbayPublishPreflight
    private(set) var mutationCount = 0
    private(set) var idempotencyKeys: [UUID] = []
    private var receipts: [UUID: EbayPublishedListing] = [:]
    private var statusOutcome: EbayPublishStatus.Outcome = .notPublished

    let canonicalListing = EbayPublishedListing(
        ebayListingID: "110377000001",
        listingURL: URL(string: "https://www.sandbox.ebay.com/itm/110377000001")!
    )

    init(preflight: EbayPublishPreflight) {
        preflightValue = preflight
    }

    var providerTruth: (
        mutationCount: Int,
        idempotencyKeys: [UUID],
        canonicalListing: EbayPublishedListing
    ) {
        (mutationCount, idempotencyKeys, canonicalListing)
    }

    func createOAuthSession(idempotencyKey: UUID) async throws -> EbayOAuthSession {
        EbayOAuthSession(
            sessionID: UUID(),
            authorizationURL: URL(string: "https://auth.sandbox.ebay.com")!,
            expiresAt: Date().addingTimeInterval(300)
        )
    }

    func connection() async throws -> EbayConnectionStatus {
        preflightValue.connection
    }

    func disconnect() async throws -> EbayConnectionStatus {
        .init(connected: false, ebayUsername: nil)
    }

    func preflight(listingID: UUID) async throws -> EbayPublishPreflight {
        preflightValue
    }

    func status(listingID: UUID) async throws -> EbayPublishStatus {
        EbayPublishStatus(
            listingID: listingID,
            outcome: statusOutcome,
            ebayListingID: statusOutcome == .published
                ? canonicalListing.ebayListingID
                : nil,
            ebayOfferID: statusOutcome == .published ? "offer-377" : nil,
            alreadyPublished: statusOutcome == .published
        )
    }

    func publish(
        listingID: UUID,
        expectedReviewRevision: UUID,
        idempotencyKey: UUID
    ) async throws -> EbayPublishTransportOutcome {
        idempotencyKeys.append(idempotencyKey)
        if let receipt = receipts[idempotencyKey] {
            statusOutcome = .published
            return .published(receipt)
        }

        mutationCount += 1
        receipts[idempotencyKey] = canonicalListing
        statusOutcome = .outcomeNotYetKnown
        return .outcomeNotYetKnown
    }
}

private struct EbayOAuthFixtureRunner: EbayOAuthRunning {
    let result: EbayOAuthResult

    func authenticate(_ session: EbayOAuthSession) async -> EbayOAuthResult {
        result
    }

    func cancel() {}
}

private actor StaleRevisionEbayPublishService: EbayPublishFeatureServing {
    private var preflights: [EbayPublishPreflight]
    private let failAfterPreflights: Int?
    private var preflightCount = 0
    private(set) var publishCount = 0
    private(set) var oauthIdempotencyKeys: [UUID] = []

    init(
        preflights: [EbayPublishPreflight],
        failAfterPreflights: Int? = nil
    ) {
        self.preflights = preflights
        self.failAfterPreflights = failAfterPreflights
    }

    func createOAuthSession(idempotencyKey: UUID) async throws -> EbayOAuthSession {
        oauthIdempotencyKeys.append(idempotencyKey)
        return EbayOAuthSession(
            sessionID: UUID(),
            authorizationURL: URL(string: "https://signin.ebay.com")!,
            expiresAt: Date().addingTimeInterval(300)
        )
    }

    func connection() async throws -> EbayConnectionStatus {
        preflights.last!.connection
    }

    func disconnect() async throws -> EbayConnectionStatus {
        .init(connected: false, ebayUsername: nil)
    }

    func preflight(listingID: UUID) async throws -> EbayPublishPreflight {
        if let failAfterPreflights,
           preflightCount >= failAfterPreflights {
            throw URLError(.cannotLoadFromNetwork)
        }
        preflightCount += 1
        if preflights.count > 1 { return preflights.removeFirst() }
        return preflights[0]
    }

    func status(listingID: UUID) async throws -> EbayPublishStatus {
        EbayPublishStatus(
            listingID: listingID,
            outcome: .notPublished,
            ebayListingID: nil,
            ebayOfferID: nil,
            alreadyPublished: false
        )
    }

    func publish(
        listingID: UUID,
        expectedReviewRevision: UUID,
        idempotencyKey: UUID
    ) async throws -> EbayPublishTransportOutcome {
        publishCount += 1
        return .staleRevision
    }
}

private actor CanonicalEbayPublishService: EbayPublishServing {
    private(set) var mutationCount = 0

    func publish(
        listingID: UUID,
        expectedReviewRevision: UUID,
        idempotencyKey: UUID
    ) async throws -> EbayPublishTransportOutcome {
        mutationCount += 1
        return .published(
            EbayPublishedListing(
                ebayListingID: "110377000099",
                listingURL: URL(
                    string: "https://www.ebay.com/itm/110377000099"
                )!
            )
        )
    }
}

private actor FailureThenPublishedEbayService: EbayPublishFeatureServing {
    private let preflightValues: [EbayPublishPreflight]
    private var preflightCount = 0
    private(set) var idempotencyKeys: [UUID] = []

    init(preflight: EbayPublishPreflight) {
        preflightValues = [preflight]
    }

    init(preflights: [EbayPublishPreflight]) {
        preflightValues = preflights
    }

    var publishCount: Int { idempotencyKeys.count }

    func createOAuthSession(idempotencyKey: UUID) async throws -> EbayOAuthSession {
        EbayOAuthSession(
            sessionID: UUID(),
            authorizationURL: URL(string: "https://signin.ebay.com")!,
            expiresAt: Date().addingTimeInterval(300)
        )
    }

    func connection() async throws -> EbayConnectionStatus {
        preflightValues[0].connection
    }

    func disconnect() async throws -> EbayConnectionStatus {
        .init(connected: false, ebayUsername: nil)
    }

    func preflight(listingID: UUID) async throws -> EbayPublishPreflight {
        let index = min(preflightCount, preflightValues.count - 1)
        preflightCount += 1
        return preflightValues[index]
    }

    func status(listingID: UUID) async throws -> EbayPublishStatus {
        EbayPublishStatus(
            listingID: listingID,
            outcome: idempotencyKeys.count == 1 ? .failed : .notPublished,
            ebayListingID: nil,
            ebayOfferID: nil,
            alreadyPublished: false
        )
    }

    func publish(
        listingID: UUID,
        expectedReviewRevision: UUID,
        idempotencyKey: UUID
    ) async throws -> EbayPublishTransportOutcome {
        idempotencyKeys.append(idempotencyKey)
        if idempotencyKeys.count == 1 { return .failed }
        return .published(
            EbayPublishedListing(
                ebayListingID: "110377000024",
                listingURL: URL(
                    string: "https://www.ebay.com/itm/110377000024"
                )!
            )
        )
    }
}
