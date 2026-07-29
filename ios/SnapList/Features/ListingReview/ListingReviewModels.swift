import Foundation

private enum ListingReviewCopy {
    static let startingPriceEstimate = "Starting price estimate"
    static let noVerifiedSoldMatches = "No verified sold matches found."
}

struct ListingReviewBinding: Decodable, Equatable, Sendable {
    let runID: UUID
    let itemID: UUID
    let listingID: UUID
    let reviewRevision: UUID

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case runID = "runId"
        case itemID = "itemId"
        case listingID = "listingId"
        case reviewRevision
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.runContractContainer(keyedBy: CodingKeys.self)
        runID = try values.decode(UUID.self, forKey: .runID)
        itemID = try values.decode(UUID.self, forKey: .itemID)
        listingID = try values.decode(UUID.self, forKey: .listingID)
        reviewRevision = try values.decode(UUID.self, forKey: .reviewRevision)
    }
}

struct ListingReviewPhoto: Decodable, Equatable, Sendable {
    let ordinal: Int
    let url: URL

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case ordinal
        case url
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.runContractContainer(keyedBy: CodingKeys.self)
        ordinal = try values.decode(Int.self, forKey: .ordinal)
        url = try values.decode(URL.self, forKey: .url)
        try values.require((0...4).contains(ordinal), forKey: .ordinal)
        try values.require(
            url.scheme?.lowercased() == "https" && url.host != nil,
            forKey: .url
        )
    }
}

struct ListingReviewIdentity: Decodable, Equatable, Sendable {
    let label: String
    let confident: Bool

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case label
        case confident
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.runContractContainer(keyedBy: CodingKeys.self)
        label = try values.decode(String.self, forKey: .label)
        confident = try values.decode(Bool.self, forKey: .confident)
        try values.require(
            !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            forKey: .label
        )
    }
}

struct ListingReviewSpecific: Decodable, Equatable, Sendable {
    let name: String
    let value: String

    init(name: String, value: String) {
        self.name = name
        self.value = value
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case name
        case value
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.runContractContainer(keyedBy: CodingKeys.self)
        name = try values.decode(String.self, forKey: .name)
        value = try values.decode(String.self, forKey: .value)
        try values.require(
            !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            forKey: .name
        )
        try values.require(
            !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            forKey: .value
        )
    }
}

enum ListingReviewCondition: String, Decodable, Equatable, Sendable {
    case new
    case likeNew = "like-new"
    case veryGood = "very-good"
    case good
    case acceptable
    case fair
    case poor
    case forParts = "for-parts"

    var sellerLabel: String {
        switch self {
        case .new: "New"
        case .likeNew: "Like New"
        case .veryGood: "Very Good"
        case .good: "Good"
        case .acceptable: "Acceptable"
        case .fair: "Fair"
        case .poor: "Poor"
        case .forParts: "For Parts"
        }
    }
}

struct ListingReviewListing: Decodable, Equatable, Sendable {
    let title: String
    let description: String
    let condition: ListingReviewCondition
    let specifics: [ListingReviewSpecific]

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case title
        case description
        case condition
        case specifics
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.runContractContainer(keyedBy: CodingKeys.self)
        title = try values.decode(String.self, forKey: .title)
        description = try values.decode(String.self, forKey: .description)
        condition = try values.decode(ListingReviewCondition.self, forKey: .condition)
        specifics = try values.decode([ListingReviewSpecific].self, forKey: .specifics)
        let normalizedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        try values.require(!normalizedTitle.isEmpty && title.utf16.count <= 80, forKey: .title)
        try values.require(
            !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            forKey: .description
        )
        try values.require(
            Set(specifics.map { $0.name.lowercased() }).count == specifics.count,
            forKey: .specifics
        )
    }
}

struct ListingReviewPriceRange: Decodable, Equatable, Sendable {
    let minimum: Decimal
    let maximum: Decimal

    init(minimum: Decimal, maximum: Decimal) {
        self.minimum = minimum
        self.maximum = maximum
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case minimum
        case maximum
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.runContractContainer(keyedBy: CodingKeys.self)
        minimum = try values.decode(Decimal.self, forKey: .minimum)
        maximum = try values.decode(Decimal.self, forKey: .maximum)
        try values.require(
            minimum.isPositiveCurrency && maximum.isPositiveCurrency && minimum <= maximum,
            forKey: .minimum
        )
    }
}

struct ListingReviewPricing: Decodable, Equatable, Sendable {
    let suggestedPrice: Decimal
    let range: ListingReviewPriceRange
    let confidence: Double
    let sellerPriceOverride: Decimal?
    let effectivePrice: Decimal

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case suggestedPrice
        case range
        case confidence
        case sellerPriceOverride
        case effectivePrice
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.runContractContainer(keyedBy: CodingKeys.self)
        suggestedPrice = try values.decode(Decimal.self, forKey: .suggestedPrice)
        range = try values.decode(ListingReviewPriceRange.self, forKey: .range)
        confidence = try values.decode(Double.self, forKey: .confidence)
        sellerPriceOverride = try values.decodeRequiredIfPresent(
            Decimal.self,
            forKey: .sellerPriceOverride
        )
        effectivePrice = try values.decode(Decimal.self, forKey: .effectivePrice)

        try values.require(
            suggestedPrice.isPositiveCurrency
                && range.minimum <= suggestedPrice
                && suggestedPrice <= range.maximum,
            forKey: .suggestedPrice
        )
        try values.require(
            confidence.isFinite && (0...1).contains(confidence),
            forKey: .confidence
        )
        if let sellerPriceOverride {
            try values.require(
                sellerPriceOverride.isPositiveCurrency,
                forKey: .sellerPriceOverride
            )
        }
        try values.require(
            effectivePrice.isPositiveCurrency
                && effectivePrice == (sellerPriceOverride ?? suggestedPrice),
            forKey: .effectivePrice
        )
    }
}

struct ListingReviewSoldMatch: Decodable, Equatable, Sendable {
    let id: String
    let sourceURL: URL
    let title: String?
    let soldPrice: Decimal
    let currency: String
    let condition: String?
    let soldAt: Int?

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case id
        case sourceURL
        case title
        case soldPrice
        case currency
        case condition
        case soldAt
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.runContractContainer(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        sourceURL = try values.decode(URL.self, forKey: .sourceURL)
        title = try values.decodeRequiredIfPresent(String.self, forKey: .title)
        soldPrice = try values.decode(Decimal.self, forKey: .soldPrice)
        currency = try values.decode(String.self, forKey: .currency)
        condition = try values.decodeRequiredIfPresent(String.self, forKey: .condition)
        soldAt = try values.decodeRequiredIfPresent(Int.self, forKey: .soldAt)
        try values.require(
            !id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && id.utf16.count <= 2_048,
            forKey: .id
        )
        try values.require(soldPrice.isPositiveCurrency, forKey: .soldPrice)
        try values.require(
            currency.range(of: #"^[A-Z]{3}$"#, options: .regularExpression) != nil,
            forKey: .currency
        )
        if let title {
            try values.require(
                !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    && title.utf16.count <= 500,
                forKey: .title
            )
        }
        if let condition {
            try values.require(
                !condition.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    && condition.utf16.count <= 120,
                forKey: .condition
            )
        }
        if let soldAt {
            try values.require(
                (0...9_007_199_254_740_991).contains(soldAt),
                forKey: .soldAt
            )
        }
        try values.require(
            sourceURL.scheme?.lowercased() == "https" && sourceURL.host != nil,
            forKey: .sourceURL
        )
    }
}

struct ListingReviewResult: Decodable, Equatable, Sendable {
    let schemaVersion: Int
    let binding: ListingReviewBinding
    let photos: [ListingReviewPhoto]
    let identity: ListingReviewIdentity
    let listing: ListingReviewListing
    let pricing: ListingReviewPricing
    let evidenceAsOf: String
    let verifiedSoldMatches: [ListingReviewSoldMatch]
    let startingPriceCopy: String
    let soldEvidenceCopy: String?

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case schemaVersion
        case binding
        case photos
        case identity
        case listing
        case pricing
        case evidenceAsOf
        case verifiedSoldMatches
        case startingPriceCopy
        case soldEvidenceCopy
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.runContractContainer(keyedBy: CodingKeys.self)
        schemaVersion = try values.decode(Int.self, forKey: .schemaVersion)
        binding = try values.decode(ListingReviewBinding.self, forKey: .binding)
        photos = try values.decode([ListingReviewPhoto].self, forKey: .photos)
        identity = try values.decode(ListingReviewIdentity.self, forKey: .identity)
        listing = try values.decode(ListingReviewListing.self, forKey: .listing)
        pricing = try values.decode(ListingReviewPricing.self, forKey: .pricing)
        evidenceAsOf = try values.decode(String.self, forKey: .evidenceAsOf)
        verifiedSoldMatches = try values.decode(
            [ListingReviewSoldMatch].self,
            forKey: .verifiedSoldMatches
        )
        startingPriceCopy = try values.decode(String.self, forKey: .startingPriceCopy)
        soldEvidenceCopy = try values.decodeRequiredIfPresent(
            String.self,
            forKey: .soldEvidenceCopy
        )

        try values.require(schemaVersion == 1, forKey: .schemaVersion)
        try values.require((1...5).contains(photos.count), forKey: .photos)
        try values.require(
            photos.map(\.ordinal) == Array(0..<photos.count),
            forKey: .photos
        )
        try values.validateDateTime(evidenceAsOf, forKey: .evidenceAsOf)
        try values.require(
            verifiedSoldMatches.count <= 5
                && Set(verifiedSoldMatches.map(\.id)).count == verifiedSoldMatches.count,
            forKey: .verifiedSoldMatches
        )
        try values.require(
            startingPriceCopy == ListingReviewCopy.startingPriceEstimate,
            forKey: .startingPriceCopy
        )
        try values.require(
            soldEvidenceCopy == (
                verifiedSoldMatches.isEmpty
                    ? ListingReviewCopy.noVerifiedSoldMatches
                    : nil
            ),
            forKey: .soldEvidenceCopy
        )
    }
}

private extension Decimal {
    var isPositiveCurrency: Bool {
        guard !isNaN, self > 0 else { return false }
        var input = self
        var normalized = Decimal()
        NSDecimalRound(&normalized, &input, 2, .plain)
        return normalized == self
    }
}
