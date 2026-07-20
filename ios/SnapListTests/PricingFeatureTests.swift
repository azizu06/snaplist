import XCTest
@testable import SnapList

final class PricingFeatureTests: XCTestCase {
    @MainActor
    func testHomePricingAttentionReachesAuthenticatedProductionPricingRoute() async throws {
        let itemID = UUID(uuidString: "22222222-2222-4222-8222-222222222222")!
        let session = makePricingURLSession { request in
            XCTAssertEqual(request.url?.path, "/v1/items/\(itemID.uuidString)/pricing")
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer signed-jwt")
            return (
                HTTPURLResponse(
                    url: try XCTUnwrap(request.url),
                    statusCode: 200,
                    httpVersion: nil,
                    headerFields: ["Content-Type": "application/json"]
                )!,
                try Self.pricingEvidenceFixture()
            )
        }
        let repository = AuthenticatedServerPricingRepository(
            apiOrigin: URL(string: "http://127.0.0.1:3001")!,
            authentication: PricingTestAuthentication(token: "signed-jwt"),
            session: session
        )
        let task = HomeAttentionTask(
            id: UUID(uuidString: "20900000-0000-4000-8000-000000000002")!,
            itemTitle: "Sony WH-1000XM4",
            kind: .pricing,
            status: "Weak price evidence",
            detail: "Only one disclosed sold comp found",
            actionLabel: "Review price",
            destination: .draft(itemID)
        )

        XCTAssertEqual(task.route, .pricing(itemID))

        let model = try await repository.fetchPricing(itemID: itemID)

        XCTAssertEqual(model.item.id, itemID.uuidString.lowercased())
        XCTAssertEqual(model.priceResult.suggested, 130)
        XCTAssertEqual(model.snapshot(for: .ninetyDays).comparables.map(\.id), ["sale-1"])
    }

    func testCanonicalPriceResultDTOMapsWithoutChangingProviderTruth() throws {
        let json = """
        {
          "suggested": 58,
          "range": { "min": 49, "max": 66 },
          "confidence": 0.91,
          "sources": [
            {
              "url": "https://www.ebay.com/itm/1001",
              "title": "Patagonia Better Sweater Quarter Zip",
              "kind": "ebay-sold"
            }
          ],
          "tier": "ebay-sold",
          "compAgreement": 0.84
        }
        """

        let dto = try JSONDecoder().decode(
            PricingPriceResultDTO.self,
            from: Data(json.utf8)
        )
        let result = try dto.validated()

        XCTAssertEqual(result.suggested, Decimal(58))
        XCTAssertEqual(result.range, PricingPriceRange(min: 49, max: 66))
        XCTAssertEqual(result.confidence, 0.91, accuracy: 0.001)
        XCTAssertEqual(result.tier, .ebaySold)
        XCTAssertEqual(result.sources.map(\.url.absoluteString), [
            "https://www.ebay.com/itm/1001"
        ])
        XCTAssertEqual(try XCTUnwrap(result.compAgreement), 0.84, accuracy: 0.001)
    }

    func testChartListAndStatisticsShareTheSameDisclosedSoldEvidence() throws {
        let priceResult = try PricingPriceResultDTO(
            suggested: 58,
            range: PricingPriceRange(min: 49, max: 66),
            confidence: 0.91,
            sources: [
                .init(
                    url: "https://www.ebay.com/itm/1001",
                    title: "Better Sweater blue",
                    kind: "ebay-sold"
                ),
                .init(
                    url: "https://www.ebay.com/itm/1002",
                    title: "Better Sweater gray",
                    kind: "ebay-sold"
                ),
                .init(
                    url: "https://www.ebay.com/itm/stale",
                    title: "Old sale",
                    kind: "ebay-sold"
                )
            ],
            tier: .ebaySold,
            model: nil,
            compAgreement: 0.84
        ).validated()
        let asOf = try XCTUnwrap(
            ISO8601DateFormatter().date(from: "2026-01-15T12:00:00Z")
        )
        let model = try PricingFeatureModel(
            item: .init(
                id: "item-1",
                title: "Patagonia Better Sweater ¼-Zip",
                condition: "Used — Excellent"
            ),
            priceResult: priceResult,
            evidenceLevel: .strong,
            evidenceAsOf: asOf,
            defaultWindow: .sixtyDays,
            comparables: [
                .init(
                    id: "1001",
                    sourceURL: try XCTUnwrap(URL(string: "https://www.ebay.com/itm/1001")),
                    title: "Better Sweater blue",
                    price: 56,
                    condition: "Excellent",
                    soldAt: asOf.addingTimeInterval(-7 * 86_400),
                    priceDisclosure: .displayedSoldPrice
                ),
                .init(
                    id: "1002",
                    sourceURL: try XCTUnwrap(URL(string: "https://www.ebay.com/itm/1002")),
                    title: "Better Sweater gray",
                    price: 60,
                    condition: "Good",
                    soldAt: asOf.addingTimeInterval(-20 * 86_400),
                    priceDisclosure: .displayedSoldPrice
                ),
                .init(
                    id: "asking-only",
                    sourceURL: try XCTUnwrap(URL(string: "https://www.ebay.com/itm/asking")),
                    title: "Best offer accepted",
                    price: 99,
                    condition: "Excellent",
                    soldAt: asOf.addingTimeInterval(-3 * 86_400),
                    priceDisclosure: .askingPriceNotAcceptedAmount
                ),
                .init(
                    id: "stale",
                    sourceURL: try XCTUnwrap(URL(string: "https://www.ebay.com/itm/stale")),
                    title: "Old sale",
                    price: 15,
                    condition: "Fair",
                    soldAt: asOf.addingTimeInterval(-120 * 86_400),
                    priceDisclosure: .displayedSoldPrice
                )
            ],
            estimatedPayout: 49.75,
            refreshState: .current
        )

        let snapshot = model.snapshot(for: .sixtyDays)

        XCTAssertEqual(snapshot.comparables.map(\.id), ["1001", "1002"])
        XCTAssertEqual(snapshot.chartPoints.map(\.comparableID), ["1001", "1002"])
        XCTAssertEqual(snapshot.soldCount, 2)
        XCTAssertEqual(snapshot.median, 58)
        XCTAssertEqual(snapshot.soldRange, PricingPriceRange(min: 56, max: 60))
        XCTAssertEqual(snapshot.lastSaleAt, asOf.addingTimeInterval(-7 * 86_400))
    }

    @MainActor
    func testSellerEditsAreCentNormalizedAndCrossOnlyInjectedBoundaries() throws {
        let model = try makeMinimalFeatureModel()
        var savedOverrides: [Decimal] = []
        var savedCosts: [Decimal?] = []
        var handoffs: [PricingDraftHandoff] = []
        let store = PricingFeatureStore(
            model: model,
            actions: PricingFeatureActions(
                savePriceOverride: { savedOverrides.append($0) },
                saveCostBasis: { savedCosts.append($0) },
                continueToDraft: { handoffs.append($0) }
            )
        )

        XCTAssertEqual(store.effectivePrice, 58)
        XCTAssertFalse(store.saveManualPrice(0))
        XCTAssertTrue(store.saveManualPrice(Decimal(string: "61.239")!))
        XCTAssertTrue(store.usesManualPriceOverride)
        XCTAssertEqual(store.effectivePrice, Decimal(string: "61.24"))
        XCTAssertEqual(savedOverrides, [Decimal(string: "61.24")!])

        XCTAssertTrue(store.saveCostBasis(Decimal(string: "20.555")!))
        XCTAssertEqual(store.costBasis, Decimal(string: "20.56"))
        XCTAssertEqual(savedCosts, [Decimal(string: "20.56")!])

        store.continueToDraft()
        XCTAssertEqual(
            handoffs,
            [
                PricingDraftHandoff(
                    itemID: "item-1",
                    effectivePrice: Decimal(string: "61.24")!,
                    costBasis: Decimal(string: "20.56")!
                )
            ]
        )

        XCTAssertTrue(store.saveCostBasis(nil))
        XCTAssertNil(store.costBasis)
        XCTAssertEqual(savedCosts.count, 2)
        XCTAssertNil(savedCosts[1])
    }

    @MainActor
    func testSelectionAlwaysResolvesToTheSameVisibleSoldRecord() {
        let store = PricingFeatureStore(model: PricingFeatureFixtures.strong)

        store.selectComparable(id: "strong-03")
        XCTAssertEqual(store.route, .selectedComparable(id: "strong-03"))
        XCTAssertEqual(store.selectedComparable?.id, "strong-03")
        XCTAssertEqual(store.selectedComparable?.price, 60)
        XCTAssertEqual(
            store.snapshot.chartPoints.first(where: { $0.comparableID == "strong-03" })?.price,
            store.selectedComparable?.price
        )

        store.selectComparable(id: "not-visible")
        XCTAssertEqual(store.selectedComparable?.id, "strong-03")

        store.selectComparable(id: "strong-12")
        store.selectWindow(.thirtyDays)
        XCTAssertEqual(store.route, .overview)
        XCTAssertNil(store.selectedComparable)
    }

    func testNoAndLimitedEvidenceRemainExplicit() {
        let empty = PricingFeatureFixtures.noEvidence.snapshot(for: .all)
        XCTAssertEqual(empty.soldCount, 0)
        XCTAssertTrue(empty.chartPoints.isEmpty)
        XCTAssertNil(empty.median)
        XCTAssertNil(empty.soldRange)
        XCTAssertEqual(
            PricingAccessibility.chartSummary(
                snapshot: empty,
                selectedComparable: nil
            ),
            "No disclosed sold prices in the selected window."
        )

        let limited = PricingFeatureFixtures.limited.snapshot(for: .ninetyDays)
        XCTAssertEqual(limited.soldCount, 3)
        XCTAssertEqual(limited.median, 24)
        XCTAssertEqual(limited.soldRange, PricingPriceRange(min: 15, max: 40))
        XCTAssertEqual(PricingFeatureFixtures.limited.evidenceLevel, .limited)
    }

    func testVoiceOverSummaryNamesTheSameSelectedComparable() throws {
        let snapshot = PricingFeatureFixtures.limited.snapshot(for: .ninetyDays)
        let selected = try XCTUnwrap(
            PricingFeatureFixtures.limited.comparable(id: "limited-01")
        )

        let summary = PricingAccessibility.chartSummary(
            snapshot: snapshot,
            selectedComparable: selected
        )

        XCTAssertTrue(summary.contains("3 disclosed sold prices"))
        XCTAssertTrue(summary.contains("Median $24.00"))
        XCTAssertTrue(summary.contains("Range $15.00 to $40.00"))
        XCTAssertTrue(summary.contains("Selected: sold December 18, 2025, Good, $24.00"))
    }

    func testLargeCurrencyFormattingKeepsFullCentPrecision() {
        XCTAssertEqual(
            PricingMoney.exact(Decimal(string: "1234567.89")!),
            "$1,234,567.89"
        )
        XCTAssertEqual(
            PricingMoney.whole(Decimal(string: "1234567.89")!),
            "$1,234,568"
        )
    }

    func testOfflineAndRefreshFailureHaveDistinctHonestPresentation() {
        XCTAssertEqual(
            PricingFeatureFixtures.offline.refreshState.presentation,
            PricingRefreshPresentation(
                title: "Offline",
                message: "Showing the last saved sold evidence.",
                systemImage: "wifi.slash"
            )
        )
        XCTAssertEqual(
            PricingFeatureFixtures.refreshFailed.refreshState.presentation,
            PricingRefreshPresentation(
                title: "Refresh failed",
                message: "Sold evidence could not be refreshed.",
                systemImage: "exclamationmark.triangle"
            )
        )
    }

    private func makePricingURLSession(
        handler: @escaping @Sendable (URLRequest) throws -> (HTTPURLResponse, Data)
    ) -> URLSession {
        PricingURLProtocolStub.handler = handler
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PricingURLProtocolStub.self]
        return URLSession(configuration: configuration)
    }

    private static func pricingEvidenceFixture() throws -> Data {
        let testFile = URL(fileURLWithPath: #filePath)
        let fixture = testFile
            .deletingLastPathComponent()
            .appending(path: "Fixtures/pricing-evidence-response.json")
        return try Data(contentsOf: fixture)
    }
}

private struct PricingTestAuthentication: HomeAuthenticationProviding {
    let token: String

    func bearerToken() async throws -> String { token }
}

private final class PricingURLProtocolStub: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler:
        (@Sendable (URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: PricingRepositoryError.operationUnavailable)
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

    override func stopLoading() {}
}

private func makeMinimalFeatureModel() throws -> PricingFeatureModel {
    let sourceURL = URL(string: "https://www.ebay.com/itm/1001")!
    let priceResult = try PricingPriceResultDTO(
        suggested: 58,
        range: PricingPriceRange(min: 49, max: 66),
        confidence: 0.91,
        sources: [
            .init(url: sourceURL.absoluteString, title: "Better Sweater", kind: "ebay-sold")
        ],
        tier: .ebaySold,
        model: nil,
        compAgreement: 0.84
    ).validated()
    let asOf = ISO8601DateFormatter().date(from: "2026-01-15T12:00:00Z")!

    return try PricingFeatureModel(
        item: .init(
            id: "item-1",
            title: "Patagonia Better Sweater ¼-Zip",
            condition: "Used — Excellent"
        ),
        priceResult: priceResult,
        evidenceLevel: .strong,
        evidenceAsOf: asOf,
        defaultWindow: .sixtyDays,
        comparables: [
            .init(
                id: "1001",
                sourceURL: sourceURL,
                title: "Better Sweater",
                price: 58,
                condition: "Excellent",
                soldAt: asOf.addingTimeInterval(-7 * 86_400),
                priceDisclosure: .displayedSoldPrice
            )
        ],
        estimatedPayout: 49.75,
        refreshState: .current
    )
}
