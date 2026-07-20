import Combine
import Foundation

protocol PricingRepository {
    func fetchPricing(itemID: UUID) async throws -> PricingFeatureModel
}

enum PricingRepositoryError: Error, Equatable {
    case operationUnavailable
    case invalidResponse
    case httpStatus(Int)
}

struct AuthenticatedServerPricingRepository: PricingRepository {
    let apiOrigin: URL
    let authentication: any HomeAuthenticationProviding
    let session: URLSession

    func fetchPricing(itemID: UUID) async throws -> PricingFeatureModel {
        let token = try await authentication.bearerToken()
        let path = "/v1/items/\(itemID.uuidString)/pricing"
        var request = URLRequest(url: apiOrigin.appending(path: path))
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else {
            throw PricingRepositoryError.invalidResponse
        }
        guard (200..<300).contains(response.statusCode) else {
            if response.statusCode == 404 || response.statusCode == 503 {
                throw PricingRepositoryError.operationUnavailable
            }
            throw PricingRepositoryError.httpStatus(response.statusCode)
        }

        do {
            let projection = try JSONDecoder()
                .decode(PricingEvidenceEnvelope.self, from: data)
                .data
            guard projection.item.id.caseInsensitiveCompare(itemID.uuidString) == .orderedSame else {
                throw PricingRepositoryError.invalidResponse
            }
            return try projection.model
        } catch let error as PricingRepositoryError {
            throw error
        } catch {
            throw PricingRepositoryError.invalidResponse
        }
    }
}

struct PricingFixtureRepository: PricingRepository {
    let model: PricingFeatureModel

    func fetchPricing(itemID: UUID) async throws -> PricingFeatureModel {
        model
    }
}

struct UnavailablePricingRepository: PricingRepository {
    func fetchPricing(itemID: UUID) async throws -> PricingFeatureModel {
        throw PricingRepositoryError.operationUnavailable
    }
}

enum PricingRepositoryFactory {
    static func make(
        configuration: LaunchConfiguration,
        apiOrigin: URL? = HomeRepositoryFactory.defaultAPIOrigin,
        authentication: any HomeAuthenticationProviding,
        session: URLSession = .shared
    ) -> any PricingRepository {
#if DEBUG
        if configuration.usesZeroNetworkFixtures {
            return PricingFixtureRepository(model: PricingFeatureFixtures.limited)
        }
#endif
        guard let apiOrigin else { return UnavailablePricingRepository() }
        return AuthenticatedServerPricingRepository(
            apiOrigin: apiOrigin,
            authentication: authentication,
            session: session
        )
    }
}

private struct PricingEvidenceEnvelope: Decodable {
    let data: PricingEvidenceProjection
}

private struct PricingEvidenceProjection: Decodable {
    struct Item: Decodable {
        let id: String
        let title: String
        let condition: String
    }

    struct Comparable: Decodable {
        let id: String
        let sourceURL: String
        let title: String
        let price: Decimal
        let currency: String
        let condition: String
        let soldAt: Double
        let kind: String
        let priceDisclosure: PricingPriceDisclosure
        let evidenceAsOf: String

        enum CodingKeys: String, CodingKey {
            case id
            case sourceURL = "sourceUrl"
            case title
            case price
            case currency
            case condition
            case soldAt
            case kind
            case priceDisclosure
            case evidenceAsOf
        }

        func domain() throws -> PricingSoldComparable {
            guard kind == "sold-comparable",
                  currency == "USD",
                  let sourceURL = URL(string: sourceURL),
                  ["http", "https"].contains(sourceURL.scheme?.lowercased()),
                  sourceURL.host != nil else {
                throw PricingRepositoryError.invalidResponse
            }
            return PricingSoldComparable(
                id: id,
                sourceURL: sourceURL,
                title: title,
                price: price,
                condition: condition,
                soldAt: Date(timeIntervalSince1970: soldAt / 1_000),
                priceDisclosure: priceDisclosure
            )
        }
    }

    let item: Item
    let priceResult: PricingPriceResultDTO
    let evidenceLevel: PricingEvidenceLevel
    let evidenceAsOf: String
    let evidenceAgeDays: Double
    let isStale: Bool
    let defaultWindow: PricingEvidenceWindow
    let comparables: [Comparable]
    let estimatedFees: Decimal
    let estimatedPayout: Decimal
    let chartBounds: PricingPriceRange?

    var model: PricingFeatureModel {
        get throws {
            let evidenceDate = try Self.parseDate(evidenceAsOf)
            let mappedComparables = try comparables.map { comparable in
                _ = try Self.parseDate(comparable.evidenceAsOf)
                return try comparable.domain()
            }
            return try PricingFeatureModel(
                item: PricingItemSummary(
                    id: item.id.lowercased(),
                    title: item.title,
                    condition: item.condition
                ),
                priceResult: try priceResult.validated(),
                evidenceLevel: evidenceLevel,
                evidenceAsOf: evidenceDate,
                defaultWindow: defaultWindow,
                comparables: mappedComparables,
                estimatedPayout: estimatedPayout,
                refreshState: isStale
                    ? .failed(message: "Sold evidence could not be refreshed.")
                    : .current,
                estimatedFees: estimatedFees,
                chartBounds: chartBounds
            )
        }
    }

    private static func parseDate(_ value: String) throws -> Date {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }

        let wholeSeconds = ISO8601DateFormatter()
        wholeSeconds.formatOptions = [.withInternetDateTime]
        guard let date = wholeSeconds.date(from: value) else {
            throw PricingRepositoryError.invalidResponse
        }
        return date
    }
}

enum PricingTier: String, Codable, CaseIterable {
    case isbnLookup = "isbn-lookup"
    case ebaySold = "ebay-sold"
    case upcAidedWeb = "upc-aided-web"
    case brandedWeb = "branded-web"
    case depreciation
    case llmOnly = "llm-only"
}

struct PricingPriceRange: Codable, Equatable {
    let min: Decimal
    let max: Decimal
}

struct PricingPriceSource: Equatable {
    let url: URL
    let title: String?
    let kind: String?
}

struct PricingPriceResult: Equatable {
    let suggested: Decimal
    let range: PricingPriceRange
    let confidence: Double
    let sources: [PricingPriceSource]
    let tier: PricingTier
    let model: String?
    let compAgreement: Double?
}

struct PricingPriceSourceDTO: Codable, Equatable {
    let url: String
    let title: String?
    let kind: String?
}

/// A pricing-local decode boundary that mirrors `src/lib/pricing/types.ts`.
/// It deliberately carries provider-neutral output only; provider selection and
/// confidence policy remain server-owned.
struct PricingPriceResultDTO: Codable, Equatable {
    let suggested: Decimal
    let range: PricingPriceRange
    let confidence: Double
    let sources: [PricingPriceSourceDTO]
    let tier: PricingTier
    let model: String?
    let compAgreement: Double?

    func validated() throws -> PricingPriceResult {
        guard suggested >= 0,
              range.min >= 0,
              range.min <= range.max,
              (range.min...range.max).contains(suggested) else {
            throw PricingContractError.invalidPriceRange
        }
        guard (0...1).contains(confidence) else {
            throw PricingContractError.invalidConfidence
        }
        if let compAgreement, !(0...1).contains(compAgreement) {
            throw PricingContractError.invalidCompAgreement
        }
        guard tier == .llmOnly || !sources.isEmpty else {
            throw PricingContractError.missingEvidenceSources
        }

        let mappedSources = try sources.map { source in
            guard let url = URL(string: source.url),
                  ["http", "https"].contains(url.scheme?.lowercased()),
                  url.host != nil else {
                throw PricingContractError.invalidSourceURL(source.url)
            }
            return PricingPriceSource(url: url, title: source.title, kind: source.kind)
        }

        return PricingPriceResult(
            suggested: suggested,
            range: range,
            confidence: confidence,
            sources: mappedSources,
            tier: tier,
            model: model,
            compAgreement: compAgreement
        )
    }
}

enum PricingContractError: Error, Equatable {
    case invalidPriceRange
    case invalidConfidence
    case invalidCompAgreement
    case missingEvidenceSources
    case invalidSourceURL(String)
    case invalidComparable(String)
    case ungroundedComparable(String)
    case invalidEstimatedPayout
    case invalidPresentationValues
}

struct PricingItemSummary: Equatable, Identifiable {
    let id: String
    let title: String
    let condition: String
}

enum PricingEvidenceLevel: String, Codable, Equatable {
    case strong
    case limited
}

enum PricingEvidenceWindow: String, CaseIterable, Codable, Identifiable {
    case thirtyDays = "30D"
    case sixtyDays = "60D"
    case ninetyDays = "90D"
    case all = "All"

    var id: String { rawValue }

    var dayCount: Int? {
        switch self {
        case .thirtyDays: 30
        case .sixtyDays: 60
        case .ninetyDays: 90
        case .all: nil
        }
    }
}

enum PricingPriceDisclosure: String, Codable, Equatable {
    case displayedSoldPrice = "displayed-sold-price"
    case askingPriceNotAcceptedAmount = "asking-price-not-accepted-amount"
}

struct PricingSoldComparable: Equatable, Identifiable {
    let id: String
    let sourceURL: URL
    let title: String
    let price: Decimal
    let condition: String
    let soldAt: Date
    let priceDisclosure: PricingPriceDisclosure
}

enum PricingRefreshState: Equatable {
    case current
    case offline(message: String)
    case failed(message: String)

    var presentation: PricingRefreshPresentation? {
        switch self {
        case .current:
            nil
        case .offline(let message):
            PricingRefreshPresentation(
                title: "Offline",
                message: message,
                systemImage: "wifi.slash"
            )
        case .failed(let message):
            PricingRefreshPresentation(
                title: "Refresh failed",
                message: message,
                systemImage: "exclamationmark.triangle"
            )
        }
    }
}

struct PricingRefreshPresentation: Equatable {
    let title: String
    let message: String
    let systemImage: String
}

struct PricingChartPoint: Equatable, Identifiable {
    let comparableID: String
    let soldAt: Date
    let price: Decimal

    var id: String { comparableID }
}

struct PricingEvidenceSnapshot: Equatable {
    let window: PricingEvidenceWindow
    let comparables: [PricingSoldComparable]
    let chartPoints: [PricingChartPoint]
    let median: Decimal?
    let soldRange: PricingPriceRange?
    let lastSaleAt: Date?

    var soldCount: Int { comparables.count }
}

/// The screen's single typed source of truth. Statistics, chart points, list rows,
/// selection, evidence age and accessibility summaries are all projections of
/// `comparables`; no provider or confidence decision is made here.
struct PricingFeatureModel: Equatable {
    let item: PricingItemSummary
    let priceResult: PricingPriceResult
    let evidenceLevel: PricingEvidenceLevel
    let evidenceAsOf: Date
    let defaultWindow: PricingEvidenceWindow
    let comparables: [PricingSoldComparable]
    let estimatedPayout: Decimal
    let refreshState: PricingRefreshState
    let estimatedFees: Decimal?
    let chartBounds: PricingPriceRange?

    init(
        item: PricingItemSummary,
        priceResult: PricingPriceResult,
        evidenceLevel: PricingEvidenceLevel,
        evidenceAsOf: Date,
        defaultWindow: PricingEvidenceWindow,
        comparables: [PricingSoldComparable],
        estimatedPayout: Decimal,
        refreshState: PricingRefreshState,
        estimatedFees: Decimal? = nil,
        chartBounds: PricingPriceRange? = nil
    ) throws {
        guard estimatedPayout >= 0 else {
            throw PricingContractError.invalidEstimatedPayout
        }
        if let estimatedFees, estimatedFees < 0 {
            throw PricingContractError.invalidPresentationValues
        }
        if let chartBounds,
           (chartBounds.min < 0 || chartBounds.min >= chartBounds.max) {
            throw PricingContractError.invalidPresentationValues
        }

        let sourceURLs = Set(priceResult.sources.map(\.url))
        let disclosedSales = try comparables
            .filter { $0.priceDisclosure == .displayedSoldPrice }
            .map { comparable in
                guard comparable.price >= 0, comparable.soldAt <= evidenceAsOf else {
                    throw PricingContractError.invalidComparable(comparable.id)
                }
                guard sourceURLs.contains(comparable.sourceURL) else {
                    throw PricingContractError.ungroundedComparable(comparable.id)
                }
                return comparable
            }

        self.item = item
        self.priceResult = priceResult
        self.evidenceLevel = evidenceLevel
        self.evidenceAsOf = evidenceAsOf
        self.defaultWindow = defaultWindow
        self.comparables = disclosedSales
        self.estimatedPayout = estimatedPayout
        self.refreshState = refreshState
        self.estimatedFees = estimatedFees
        self.chartBounds = chartBounds
    }

    func snapshot(for window: PricingEvidenceWindow) -> PricingEvidenceSnapshot {
        let visible = comparables
            .filter { comparable in
                guard let days = window.dayCount else { return true }
                let age = evidenceAsOf.timeIntervalSince(comparable.soldAt)
                return age <= Double(days) * 86_400
            }
            .sorted { lhs, rhs in
                if lhs.soldAt == rhs.soldAt { return lhs.id < rhs.id }
                return lhs.soldAt > rhs.soldAt
            }
        let prices = visible.map(\.price).sorted()

        return PricingEvidenceSnapshot(
            window: window,
            comparables: visible,
            chartPoints: visible.map {
                PricingChartPoint(
                    comparableID: $0.id,
                    soldAt: $0.soldAt,
                    price: $0.price
                )
            },
            median: prices.median,
            soldRange: prices.first.flatMap { minimum in
                prices.last.map { maximum in
                    PricingPriceRange(min: minimum, max: maximum)
                }
            },
            lastSaleAt: visible.first?.soldAt
        )
    }

    func comparable(id: String) -> PricingSoldComparable? {
        comparables.first { $0.id == id }
    }
}

private extension Array where Element == Decimal {
    var median: Decimal? {
        guard !isEmpty else { return nil }
        let middle = count / 2
        guard count.isMultiple(of: 2) else { return self[middle] }
        return (self[middle - 1] + self[middle]) / 2
    }
}

struct PricingDraftHandoff: Equatable {
    let itemID: String
    let effectivePrice: Decimal
    let costBasis: Decimal?
}

struct PricingFeatureActions {
    let savePriceOverride: (Decimal) -> Void
    let saveCostBasis: (Decimal?) -> Void
    let continueToDraft: (PricingDraftHandoff) -> Void
    let openSource: (URL) -> Void
    let retryRefresh: () -> Void
    let requestGuidedCorrection: () -> Void
    let dismissPricing: () -> Void
    let showPricingHelp: () -> Void

    init(
        savePriceOverride: @escaping (Decimal) -> Void = { _ in },
        saveCostBasis: @escaping (Decimal?) -> Void = { _ in },
        continueToDraft: @escaping (PricingDraftHandoff) -> Void = { _ in },
        openSource: @escaping (URL) -> Void = { _ in },
        retryRefresh: @escaping () -> Void = {},
        requestGuidedCorrection: @escaping () -> Void = {},
        dismissPricing: @escaping () -> Void = {},
        showPricingHelp: @escaping () -> Void = {}
    ) {
        self.savePriceOverride = savePriceOverride
        self.saveCostBasis = saveCostBasis
        self.continueToDraft = continueToDraft
        self.openSource = openSource
        self.retryRefresh = retryRefresh
        self.requestGuidedCorrection = requestGuidedCorrection
        self.dismissPricing = dismissPricing
        self.showPricingHelp = showPricingHelp
    }
}

enum PricingFeatureRoute: Equatable {
    case overview
    case allComparables
    case selectedComparable(id: String)
}

enum PricingFeatureSheet: String, Identifiable {
    case manualPrice
    case costBasis

    var id: String { rawValue }
}

@MainActor
final class PricingFeatureStore: ObservableObject {
    let model: PricingFeatureModel
    let actions: PricingFeatureActions

    @Published var selectedWindow: PricingEvidenceWindow
    @Published var route: PricingFeatureRoute = .overview
    @Published var presentedSheet: PricingFeatureSheet?
    @Published private(set) var effectivePrice: Decimal
    @Published private(set) var costBasis: Decimal?
    @Published private(set) var usesManualPriceOverride = false

    init(model: PricingFeatureModel, actions: PricingFeatureActions = .init()) {
        self.model = model
        self.actions = actions
        selectedWindow = model.defaultWindow
        effectivePrice = model.priceResult.suggested
    }

    var snapshot: PricingEvidenceSnapshot {
        model.snapshot(for: selectedWindow)
    }

    var selectedComparable: PricingSoldComparable? {
        guard case .selectedComparable(let id) = route else { return nil }
        return model.comparable(id: id)
    }

    var estimatedProfit: Decimal? {
        costBasis.map { model.estimatedPayout - $0 }
    }

    func selectWindow(_ window: PricingEvidenceWindow) {
        selectedWindow = window
        if case .selectedComparable(let id) = route,
           !snapshot.comparables.contains(where: { $0.id == id }) {
            route = .overview
        }
    }

    func showAllComparables() {
        route = .allComparables
    }

    func selectComparable(id: String) {
        guard snapshot.comparables.contains(where: { $0.id == id }) else { return }
        route = .selectedComparable(id: id)
    }

    func showOverview() {
        route = .overview
    }

    @discardableResult
    func saveManualPrice(_ value: Decimal) -> Bool {
        guard let normalized = value.normalizedCurrency, normalized > 0 else {
            return false
        }
        effectivePrice = normalized
        usesManualPriceOverride = true
        actions.savePriceOverride(normalized)
        presentedSheet = nil
        return true
    }

    @discardableResult
    func saveCostBasis(_ value: Decimal?) -> Bool {
        guard let value else {
            costBasis = nil
            actions.saveCostBasis(nil)
            presentedSheet = nil
            return true
        }
        guard let normalized = value.normalizedCurrency, normalized >= 0 else {
            return false
        }
        costBasis = normalized
        actions.saveCostBasis(normalized)
        presentedSheet = nil
        return true
    }

    func continueToDraft() {
        actions.continueToDraft(
            PricingDraftHandoff(
                itemID: model.item.id,
                effectivePrice: effectivePrice,
                costBasis: costBasis
            )
        )
    }

    func open(_ comparable: PricingSoldComparable) {
        actions.openSource(comparable.sourceURL)
    }
}

private extension Decimal {
    var normalizedCurrency: Decimal? {
        guard !isNaN else { return nil }
        var input = self
        var output = Decimal()
        NSDecimalRound(&output, &input, 2, .plain)
        return output
    }
}
