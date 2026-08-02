import Foundation

enum ListingReviewCopy {
    static let startingPriceEstimate = "Starting price estimate"
    static let noVerifiedSoldMatches = "No verified sold matches found."
    static let staleReview = "This review changed. Reload and try again."
    static let saveFailed = "Failed to save changes. Please try again."
    static let draftPersistenceFailed =
        "Couldn’t save changes on this phone. Please try again."
    static let openFailed = "Failed to load this review. Please try again."
    static let reloadFailed =
        "Couldn’t reload. Your changes are still here."
}

struct ListingReviewBinding: Codable, Equatable, Sendable {
    let runID: UUID
    let itemID: UUID
    let listingID: UUID
    let reviewContentRevision: UUID
    let reviewRevision: UUID

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case runID = "runId"
        case itemID = "itemId"
        case listingID = "listingId"
        case reviewContentRevision
        case reviewRevision
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.runContractContainer(keyedBy: CodingKeys.self)
        runID = try values.decode(UUID.self, forKey: .runID)
        itemID = try values.decode(UUID.self, forKey: .itemID)
        listingID = try values.decode(UUID.self, forKey: .listingID)
        reviewContentRevision = try values.decode(
            UUID.self,
            forKey: .reviewContentRevision
        )
        reviewRevision = try values.decode(UUID.self, forKey: .reviewRevision)
    }
}

struct ListingReviewPhoto: Codable, Equatable, Sendable {
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

struct ListingReviewIdentity: Codable, Equatable, Sendable {
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

struct ListingReviewSpecific: Codable, Equatable, Sendable {
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

enum ListingReviewCondition: String, Codable, Equatable, Sendable {
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

struct ListingReviewListing: Codable, Equatable, Sendable {
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

struct ListingReviewPriceRange: Codable, Equatable, Sendable {
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

struct ListingReviewPricing: Codable, Equatable, Sendable {
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

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(suggestedPrice, forKey: .suggestedPrice)
        try values.encode(range, forKey: .range)
        try values.encode(confidence, forKey: .confidence)
        try values.encodeRequired(
            sellerPriceOverride,
            forKey: .sellerPriceOverride
        )
        try values.encode(effectivePrice, forKey: .effectivePrice)
    }
}

enum ListingReviewSoldFormat: String, Codable, Equatable, Sendable {
    case auction
    case buyItNow = "buy-it-now"
    case auctionWithBuyItNow = "auction-with-buy-it-now"
}

enum ListingReviewSoldShipping: Codable, Equatable, Sendable {
    case free
    case paid(price: Decimal, currency: String)
    case pickup

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case type
        case price
        case currency
    }

    private enum Kind: String, Codable {
        case free
        case paid
        case pickup
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.runContractContainer(keyedBy: CodingKeys.self)
        switch try values.decode(Kind.self, forKey: .type) {
        case .free:
            try values.require(
                !values.contains(.price) && !values.contains(.currency),
                forKey: .type
            )
            self = .free
        case .paid:
            let price = try values.decode(Decimal.self, forKey: .price)
            let currency = try values.decode(String.self, forKey: .currency)
            try values.require(price.isPositiveCurrency, forKey: .price)
            try values.require(
                currency.range(of: #"^[A-Z]{3}$"#, options: .regularExpression) != nil,
                forKey: .currency
            )
            self = .paid(price: price, currency: currency)
        case .pickup:
            try values.require(
                !values.contains(.price) && !values.contains(.currency),
                forKey: .type
            )
            self = .pickup
        }
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .free:
            try values.encode(Kind.free, forKey: .type)
        case let .paid(price, currency):
            try values.encode(Kind.paid, forKey: .type)
            try values.encode(price, forKey: .price)
            try values.encode(currency, forKey: .currency)
        case .pickup:
            try values.encode(Kind.pickup, forKey: .type)
        }
    }
}

struct ListingReviewSoldMatch: Codable, Equatable, Sendable {
    let id: String
    let sourceURL: URL
    let title: String?
    let soldPrice: Decimal
    let currency: String
    let condition: String?
    let soldAt: Int?
    let photoURL: URL?
    let size: String?
    let format: ListingReviewSoldFormat?
    let shipping: ListingReviewSoldShipping?

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case id
        case sourceURL
        case title
        case soldPrice
        case currency
        case condition
        case soldAt
        case photoURL
        case size
        case format
        case shipping
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
        photoURL = try values.contains(.photoURL)
            ? values.decode(URL.self, forKey: .photoURL)
            : nil
        size = try values.contains(.size)
            ? values.decode(String.self, forKey: .size)
            : nil
        format = try values.contains(.format)
            ? values.decode(ListingReviewSoldFormat.self, forKey: .format)
            : nil
        shipping = try values.contains(.shipping)
            ? values.decode(ListingReviewSoldShipping.self, forKey: .shipping)
            : nil
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
        if let photoURL {
            try values.require(
                photoURL.scheme?.lowercased() == "https" && photoURL.host != nil
                    && photoURL.absoluteString.utf16.count <= 2_048,
                forKey: .photoURL
            )
        }
        if let size {
            try values.require(
                !size.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    && size.utf16.count <= 120,
                forKey: .size
            )
        }
        try values.require(
            sourceURL.scheme?.lowercased() == "https" && sourceURL.host != nil
                && sourceURL.absoluteString.utf16.count <= 2_048,
            forKey: .sourceURL
        )
    }

    /// Mirrors the read above key for key. `title`, `condition` and `soldAt`
    /// are nullable on the wire, so their keys are always written — the read
    /// treats an absent one as a corrupt record. `photoURL`, `size`, `format`
    /// and `shipping` are omitted rather than null, because that is the shape
    /// the read tolerates and the shape the server sends. Writing seven of
    /// eleven keys, as this did, loses four facts of sold evidence to a record
    /// that then decodes cleanly and reports nothing.
    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(id, forKey: .id)
        try values.encode(sourceURL, forKey: .sourceURL)
        try values.encodeRequired(title, forKey: .title)
        try values.encode(soldPrice, forKey: .soldPrice)
        try values.encode(currency, forKey: .currency)
        try values.encodeRequired(condition, forKey: .condition)
        try values.encodeRequired(soldAt, forKey: .soldAt)
        try values.encodeIfPresent(photoURL, forKey: .photoURL)
        try values.encodeIfPresent(size, forKey: .size)
        try values.encodeIfPresent(format, forKey: .format)
        try values.encodeIfPresent(shipping, forKey: .shipping)
    }
}

struct ListingReviewResult: Codable, Equatable, Sendable {
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

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(schemaVersion, forKey: .schemaVersion)
        try values.encode(binding, forKey: .binding)
        try values.encode(photos, forKey: .photos)
        try values.encode(identity, forKey: .identity)
        try values.encode(listing, forKey: .listing)
        try values.encode(pricing, forKey: .pricing)
        try values.encode(evidenceAsOf, forKey: .evidenceAsOf)
        try values.encode(verifiedSoldMatches, forKey: .verifiedSoldMatches)
        try values.encode(startingPriceCopy, forKey: .startingPriceCopy)
        try values.encodeRequired(soldEvidenceCopy, forKey: .soldEvidenceCopy)
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
