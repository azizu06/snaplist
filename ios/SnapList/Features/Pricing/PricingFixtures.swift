import Foundation

enum PricingFeatureFixtures {
    static let strong: PricingFeatureModel = {
        let records: [(String, String, String, Decimal)] = [
            ("strong-01", "2026-01-12T12:00:00Z", "Very Good", 62),
            ("strong-02", "2026-01-09T12:00:00Z", "Very Good", 59),
            ("strong-03", "2026-01-08T12:00:00Z", "Excellent", 60),
            ("strong-04", "2026-01-03T12:00:00Z", "Very Good", 55),
            ("strong-05", "2025-12-29T12:00:00Z", "Excellent", 66),
            ("strong-06", "2025-12-24T12:00:00Z", "Very Good", 56),
            ("strong-07", "2025-12-18T12:00:00Z", "Good", 49),
            ("strong-08", "2025-12-12T12:00:00Z", "Excellent", 63),
            ("strong-09", "2025-12-06T12:00:00Z", "Good", 54),
            ("strong-10", "2025-11-30T12:00:00Z", "Excellent", 58),
            ("strong-11", "2025-11-22T12:00:00Z", "Good", 46),
            ("strong-12", "2025-11-16T12:00:00Z", "Very Good", 51)
        ]
        return makeModel(
            item: PricingItemSummary(
                id: "fixture-better-sweater",
                title: "Patagonia Better Sweater ¼-Zip",
                condition: "Men’s M · Used — Excellent"
            ),
            suggested: 58,
            band: PricingPriceRange(min: 49, max: 66),
            confidence: 0.91,
            level: .strong,
            defaultWindow: .sixtyDays,
            records: records,
            estimatedPayout: 49.75,
            estimatedFees: 8.25,
            chartBounds: PricingPriceRange(min: 46, max: 66)
        )
    }()

    static let limited: PricingFeatureModel = {
        let records: [(String, String, String, Decimal)] = [
            ("limited-01", "2025-12-18T12:00:00Z", "Good", 24),
            ("limited-02", "2025-11-20T12:00:00Z", "Fair", 15),
            ("limited-03", "2025-10-22T12:00:00Z", "Good", 40)
        ]
        return makeModel(
            item: PricingItemSummary(
                id: "fixture-painted-vase",
                title: "Hand-Painted Ceramic Vase",
                condition: "9 in · Used — Good"
            ),
            suggested: 24,
            band: PricingPriceRange(min: 15, max: 40),
            confidence: 0.43,
            level: .limited,
            defaultWindow: .ninetyDays,
            records: records,
            estimatedPayout: 20,
            estimatedFees: 3.41,
            chartBounds: PricingPriceRange(min: 10, max: 45)
        )
    }()

    static let offline: PricingFeatureModel = replacingRefreshState(
        in: strong,
        with: .offline(message: "Showing the last saved sold evidence.")
    )

    static let refreshFailed: PricingFeatureModel = replacingRefreshState(
        in: strong,
        with: .failed(message: "Sold evidence could not be refreshed.")
    )

    static let noEvidence: PricingFeatureModel = {
        let priceResult = try! PricingPriceResultDTO(
            suggested: 30,
            range: PricingPriceRange(min: 15, max: 45),
            confidence: 0.25,
            sources: [],
            tier: .llmOnly,
            model: nil,
            compAgreement: nil
        ).validated()

        return try! PricingFeatureModel(
            item: PricingItemSummary(
                id: "fixture-no-evidence",
                title: "Vintage Table Lamp",
                condition: "Used — Good"
            ),
            priceResult: priceResult,
            evidenceLevel: .limited,
            evidenceAsOf: evidenceAsOf,
            defaultWindow: .ninetyDays,
            comparables: [],
            estimatedPayout: 24,
            refreshState: .current,
            estimatedFees: 6,
            chartBounds: PricingPriceRange(min: 10, max: 50)
        )
    }()

    private static let evidenceAsOf = ISO8601DateFormatter()
        .date(from: "2026-01-15T12:00:00Z")!

    private static func makeModel(
        item: PricingItemSummary,
        suggested: Decimal,
        band: PricingPriceRange,
        confidence: Double,
        level: PricingEvidenceLevel,
        defaultWindow: PricingEvidenceWindow,
        records: [(String, String, String, Decimal)],
        estimatedPayout: Decimal,
        estimatedFees: Decimal,
        chartBounds: PricingPriceRange
    ) -> PricingFeatureModel {
        let urls = records.map { record in
            URL(string: "https://www.ebay.com/itm/\(record.0)")!
        }
        let sources = zip(records, urls).map { record, url in
            PricingPriceSourceDTO(
                url: url.absoluteString,
                title: "\(item.title) · \(record.2)",
                kind: "ebay-sold"
            )
        }
        let priceResult = try! PricingPriceResultDTO(
            suggested: suggested,
            range: band,
            confidence: confidence,
            sources: sources,
            tier: .ebaySold,
            model: nil,
            compAgreement: level == .strong ? 0.84 : 0.32
        ).validated()
        let comparables = zip(records, urls).map { record, url in
            PricingSoldComparable(
                id: record.0,
                sourceURL: url,
                title: item.title,
                price: record.3,
                condition: record.2,
                soldAt: ISO8601DateFormatter().date(from: record.1)!,
                priceDisclosure: .displayedSoldPrice
            )
        }

        return try! PricingFeatureModel(
            item: item,
            priceResult: priceResult,
            evidenceLevel: level,
            evidenceAsOf: evidenceAsOf,
            defaultWindow: defaultWindow,
            comparables: comparables,
            estimatedPayout: estimatedPayout,
            refreshState: .current,
            estimatedFees: estimatedFees,
            chartBounds: chartBounds
        )
    }

    private static func replacingRefreshState(
        in model: PricingFeatureModel,
        with refreshState: PricingRefreshState
    ) -> PricingFeatureModel {
        try! PricingFeatureModel(
            item: model.item,
            priceResult: model.priceResult,
            evidenceLevel: model.evidenceLevel,
            evidenceAsOf: model.evidenceAsOf,
            defaultWindow: model.defaultWindow,
            comparables: model.comparables,
            estimatedPayout: model.estimatedPayout,
            refreshState: refreshState,
            estimatedFees: model.estimatedFees,
            chartBounds: model.chartBounds
        )
    }
}
