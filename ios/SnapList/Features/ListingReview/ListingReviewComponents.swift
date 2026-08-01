import SwiftUI

extension ListingReviewCopy {
    static let retry = "Retry"
    static let unsavedChanges = "Unsaved changes"
    static let invalidPrice = "Must be above $0."
    static let done = "Done"
    static let fixItem = "Fix item"
    static let editDetails = "Edit details"
    static let reload = "Reload"
    static let keepEditing = "Keep editing"
    static let discardChangesAndReload = "Discard changes and reload"
}

extension ListingReviewCondition: CaseIterable {
    static let allCases: [ListingReviewCondition] = [
        .new,
        .likeNew,
        .veryGood,
        .good,
        .acceptable,
        .fair,
        .poor,
        .forParts,
    ]
}

extension ListingReviewStore {
    var effectivePrice: Decimal? {
        guard let snapshot, let draft else { return nil }
        return draft.sellerPriceOverride ?? snapshot.pricing.suggestedPrice
    }

    func isIdentitySpecific(_ name: String) -> Bool {
        ListingReviewDraft.isIdentitySpecificName(name)
    }
}

@MainActor
enum ListingReviewStoreFactory {
    static func make(
        configuration: LaunchConfiguration,
        apiOrigin: URL?,
        tokenProvider: any BearerTokenProviding,
        session: URLSession
    ) -> ListingReviewStore {
#if DEBUG
        if configuration.usesZeroNetworkFixtures {
            let root = FileManager.default.urls(
                for: .applicationSupportDirectory,
                in: .userDomainMask
            )[0]
                .appendingPathComponent("SnapList", isDirectory: true)
                .appendingPathComponent(
                    "ListingReviewUITests",
                    isDirectory: true
                )
            if configuration.resetListingReviewDraft {
                try? FileManager.default.removeItem(at: root)
            }
            return ListingReviewStore(
                service: ListingReviewFixtureService(
                    fixture: configuration.listingReviewFixture ?? .loaded
                ),
                persistence: LocalListingReviewDraftPersistence(
                    rootDirectory: root
                ),
                tokenProvider: ListingReviewFixtureBearerTokenProvider()
            )
        }
#endif
        return ListingReviewStore(
            service: ListingReviewAPIClient(
                baseURL: apiOrigin
                    ?? URL(string: "http://127.0.0.1:3001")!,
                session: session
            ),
            persistence: LocalListingReviewDraftPersistence(),
            tokenProvider: tokenProvider
        )
    }
}

extension ListingReviewFixture {
    var correctionAvailable: Bool {
        self != .correctionUnavailable
    }
}

#if DEBUG
extension ListingReviewFixture {
    var review: ListingReviewResult {
        let matchCount: Int
        switch self {
        case .zeroEvidence:
            matchCount = 0
        case .fiveEvidence:
            matchCount = 5
        default:
            matchCount = 3
        }
        return ListingReviewLaunchFixture.review(
            matchCount: matchCount,
            usesLongText: self == .longText
        )
    }
}

private struct ListingReviewFixtureBearerTokenProvider:
    BearerTokenProviding {
    func bearerToken() async throws -> String {
        "fixture-listing-review-bearer"
    }

    func principalBoundBearer() async throws -> PrincipalBoundBearer {
        PrincipalBoundBearer(
            bearerToken: "fixture-listing-review-bearer",
            scopeProof: ItemRunSubmissionPrincipalScopeProof(
                verifiedClerkSubject: "fixture-listing-review-principal"
            )!
        )
    }
}

private actor ListingReviewFixtureService: ListingReviewServing {
    let fixture: ListingReviewFixture

    init(fixture: ListingReviewFixture) {
        self.fixture = fixture
    }

    func fetchReview(
        runID: UUID,
        bearerToken: String
    ) throws -> ListingReviewResult {
        let review = fixture.review
        guard review.binding.runID == runID else {
            throw ListingReviewClientError.invalidResponse
        }
        return review
    }

    func save(
        runID: UUID,
        draft: ListingReviewDraft,
        expectedReviewRevision: UUID,
        idempotencyKey: UUID,
        bearerToken: String
    ) async throws -> ListingReviewSaveReceipt {
        try await Task.sleep(for: .milliseconds(650))
        switch fixture {
        case .saveFailure:
            throw ListingReviewClientError.unavailable
        case .offline:
            throw ListingReviewClientError.offline
        case .conflict:
            throw ListingReviewClientError.conflict
        default:
            let binding = fixture.review.binding
            guard binding.runID == runID,
                  binding.reviewRevision == expectedReviewRevision else {
                throw ListingReviewClientError.invalidResponse
            }
            return ListingReviewLaunchFixture.receipt(binding: binding)
        }
    }
}

enum ListingReviewLaunchFixture {
    static let runID = UUID(
        uuidString: "20800000-0000-4000-8000-000000000020"
    )!

    static func review(
        matchCount: Int = 3,
        usesLongText: Bool = false
    ) -> ListingReviewResult {
        let title = usesLongText
            ? "Canon AE-1 Program 35mm film camera with 50mm lens and original strap"
            : "Canon AE-1 Program 35mm film camera"
        let description = usesLongText
            ? String(
                repeating:
                    "Tested camera body with visible handling wear. Controls, meter, and film advance are described without hiding condition details. ",
                count: 12
            )
            : "Tested camera body with normal handling wear. Includes a 50mm lens and strap."
        let matches = (0..<matchCount).map { index in
            [
                "id": "fixture-sold-\(index + 1)",
                "sourceURL":
                    "https://example.com/sold/\(index + 1)",
                "title":
                    "Canon AE-1 Program camera sold listing \(index + 1)",
                "soldPrice": 52 + index,
                "currency": "USD",
                "condition": "Used",
                "soldAt": 1_785_024_000_000 + (index * 86_400_000),
            ] as [String: Any]
        }
        let object: [String: Any] = [
            "schemaVersion": 1,
            "binding": [
                "runId": runID.uuidString.lowercased(),
                "itemId": "20800000-0000-4000-8000-000000000021",
                "listingId": "20800000-0000-4000-8000-000000000022",
                "reviewRevision":
                    "20800000-0000-4000-8000-000000000023",
            ],
            "photos": (0..<3).map { index in
                [
                    "ordinal": index,
                    "url": "https://example.com/photos/\(index + 1).jpg",
                ] as [String: Any]
            },
            "identity": [
                "label": "Canon AE-1 Program · 35mm film camera",
                "confident": true,
            ],
            "listing": [
                "title": title,
                "description": description,
                "condition": "good",
                "specifics": [
                    ["name": "Brand", "value": "Canon"],
                    ["name": "Type", "value": "35mm SLR"],
                    ["name": "Model", "value": "AE-1 Program"],
                    ["name": "Color", "value": "Black"],
                    ["name": "Format", "value": "35 mm"],
                    ["name": "Country of manufacture", "value": "Japan"],
                ],
            ],
            "pricing": [
                "suggestedPrice": 58,
                "range": ["minimum": 49, "maximum": 66],
                "confidence": 0.82,
                "sellerPriceOverride": NSNull(),
                "effectivePrice": 58,
            ],
            "evidenceAsOf": "2026-07-30T16:00:00.000Z",
            "verifiedSoldMatches": matches,
            "startingPriceCopy": ListingReviewCopy.startingPriceEstimate,
            "soldEvidenceCopy": matchCount == 0
                ? ListingReviewCopy.noVerifiedSoldMatches
                : NSNull(),
        ]

        do {
            return try JSONDecoder().decode(
                ListingReviewResult.self,
                from: JSONSerialization.data(withJSONObject: object)
            )
        } catch {
            preconditionFailure(
                "Invalid Listing Review launch fixture: \(error)"
            )
        }
    }

    static func receipt(
        binding: ListingReviewBinding
    ) -> ListingReviewSaveReceipt {
        let object: [String: Any] = [
            "schemaVersion": 1,
            "runId": binding.runID.uuidString.lowercased(),
            "itemId": binding.itemID.uuidString.lowercased(),
            "listingId": binding.listingID.uuidString.lowercased(),
            "reviewRevision":
                "20800000-0000-4000-8000-000000000024",
        ]
        do {
            return try JSONDecoder().decode(
                ListingReviewSaveReceipt.self,
                from: JSONSerialization.data(withJSONObject: object)
            )
        } catch {
            preconditionFailure(
                "Invalid Listing Review save fixture: \(error)"
            )
        }
    }
}
#endif

enum ListingReviewFocus: Hashable {
    case back
    case price
    case title
    case description
    case condition
    case specifics
    case soldMatch(Int)
    case secondary
    case done
}

enum ListingReviewAnnouncement {
    @MainActor
    static func post(_ text: String, assertive: Bool) {
        guard !text.isEmpty else { return }
        var announcement = AttributedString(text)
        announcement.accessibilitySpeechAnnouncementPriority =
            assertive ? .high : .default
        AccessibilityNotification.Announcement(announcement).post()
    }
}

enum ListingReviewPriceStyle {
    /// Ink, not an alarm colour. The approved review states the rule once,
    /// under a red-hairlined field, and the frozen palette resolves no
    /// destructive colour — red is confined to borders and surfaces there.
    static let invalidMessage = SnapListColorToken.inkPrimary
}

enum ListingReviewSoldSummary {
    /// The right-hand summary on the sold-match rail heading.
    ///
    /// A low-to-high range is only honest when every match is denominated in the same
    /// currency. The read contract types each match's `currency` independently of the
    /// others, so a mixed set has no single low and high — comparing the raw amounts
    /// would state a range that does not exist. Such a set degrades to the count alone.
    static func text(
        for matches: [ListingReviewSoldMatch],
        locale: Locale = .current
    ) -> String {
        guard !matches.isEmpty else { return "" }
        let count = "\(matches.count) sold"
        let currencies = Set(matches.map(\.currency))
        guard currencies.count == 1,
              let currency = currencies.first,
              let minimum = matches.map(\.soldPrice).min(),
              let maximum = matches.map(\.soldPrice).max() else {
            return count
        }
        let low = ListingReviewCurrency.string(
            minimum,
            currencyCode: currency,
            locale: locale
        )
        guard minimum != maximum else { return "\(count) · \(low)" }
        let high = ListingReviewCurrency.string(
            maximum,
            currencyCode: currency,
            locale: locale
        )
        return "\(count) · \(low)–\(high)"
    }
}

enum ListingReviewCurrency {
    static func string(
        _ amount: Decimal,
        currencyCode: String = "USD",
        locale: Locale = .current
    ) -> String {
        let formatter = NumberFormatter()
        formatter.locale = locale
        formatter.numberStyle = .currency
        formatter.currencyCode = currencyCode
        formatter.minimumFractionDigits = amount.exponent < 0 ? 2 : 0
        formatter.maximumFractionDigits = 2
        return formatter.string(from: amount as NSDecimalNumber)
            ?? "\(amount)"
    }

    static func decimal(
        from input: String,
        locale: Locale = .current
    ) -> Decimal? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let formatter = NumberFormatter()
        formatter.locale = locale
        formatter.numberStyle = .currency
        formatter.generatesDecimalNumbers = true
        if let number = formatter.number(from: trimmed) as? NSDecimalNumber {
            return normalized(number.decimalValue)
        }
        formatter.numberStyle = .decimal
        guard let number = formatter.number(from: trimmed) as? NSDecimalNumber else {
            return nil
        }
        return normalized(number.decimalValue)
    }

    static func isValid(_ amount: Decimal?) -> Bool {
        guard let amount, !amount.isNaN, amount > 0 else { return false }
        return normalized(amount) == amount
    }

    private static func normalized(_ value: Decimal) -> Decimal {
        var input = value
        var result = Decimal()
        NSDecimalRound(&result, &input, 2, .plain)
        return result
    }
}

struct ListingReviewPhotoPager: View {
    let photos: [ListingReviewPhoto]
    @State private var selectedOrdinal = 0

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            TabView(selection: $selectedOrdinal) {
                ForEach(photos, id: \.ordinal) { photo in
                    AsyncImage(url: photo.url) { phase in
                        switch phase {
                        case .success(let image):
                            image.resizable().scaledToFill()
                        case .empty:
                            ProgressView()
                                .frame(maxWidth: .infinity, maxHeight: .infinity)
                        case .failure:
                            unavailablePhoto
                        @unknown default:
                            unavailablePhoto
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .aspectRatio(4 / 3, contentMode: .fit)
                    .clipped()
                    .tag(photo.ordinal)
                    .accessibilityLabel(
                        photo.ordinal == 0
                            ? "Photo 1 of \(photos.count), cover"
                            : "Photo \(photo.ordinal + 1) of \(photos.count)"
                    )
                    .accessibilityValue(
                        photo.ordinal == selectedOrdinal ? "Current page" : ""
                    )
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .frame(maxWidth: .infinity)
            .aspectRatio(4 / 3, contentMode: .fit)

            Text("\(selectedOrdinal + 1) / \(photos.count)")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(.black.opacity(0.64), in: Capsule())
                .padding(12)
                .accessibilityHidden(true)
        }
        .background(SnapListColorToken.quietFill.color)
        .clipShape(RoundedRectangle(cornerRadius: 18))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("listing-review.photos")
    }

    private var unavailablePhoto: some View {
        ZStack {
            SnapListColorToken.quietFill.color
            Image(systemName: "photo")
                .font(.title2)
                .foregroundStyle(SnapListColorToken.textTertiary.color)
        }
    }
}

struct ListingReviewStatusBanner: View {
    let text: String
    let systemImage: String
    var retry: (() -> Void)?
    var retryLabel = ListingReviewCopy.retry
    var retryIdentifier = "listing-review.retry"

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: systemImage)
                .foregroundStyle(SnapListColorToken.textSecondary.color)
                .accessibilityHidden(true)
            Text(text)
                .font(.callout)
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let retry {
                Button(retryLabel, action: retry)
                    .font(.callout.weight(.bold))
                    .foregroundStyle(SnapListColorToken.action.color)
                    .frame(minHeight: SnapListMetrics.minimumTouchTarget)
                    .accessibilityIdentifier(retryIdentifier)
            }
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 48)
        .background(SnapListColorToken.groupingFill.color)
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }
}

struct ListingReviewDisclosureRow: View {
    let title: String
    let value: String
    let identifier: String
    var pending = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(title.uppercased())
                        .font(.caption2.weight(.bold))
                        .tracking(0.4)
                        .foregroundStyle(SnapListColorToken.textTertiary.color)
                    HStack(spacing: 7) {
                        if pending {
                            Circle()
                                .fill(SnapListColorToken.action.color)
                                .frame(width: 7, height: 7)
                                .accessibilityHidden(true)
                        }
                        Text(value)
                            .font(.body)
                            .foregroundStyle(SnapListColorToken.inkPrimary.color)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(SnapListColorToken.textTertiary.color)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 60)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityValue(
            value + (pending ? ", edited, not saved yet" : "")
        )
        .accessibilityHint("Edit")
        .accessibilityIdentifier(identifier)
    }
}

struct ListingReviewPendingStrip: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulses = false

    var body: some View {
        HStack(spacing: 9) {
            ZStack {
                Circle()
                    .fill(SnapListColorToken.action.color.opacity(0.2))
                    .frame(width: 16, height: 16)
                    .scaleEffect(pulses && !reduceMotion ? 1.25 : 1)
                    .opacity(pulses && !reduceMotion ? 0 : 1)
                Circle()
                    .fill(SnapListColorToken.action.color)
                    .frame(width: 8, height: 8)
            }
            .accessibilityHidden(true)
            Text(ListingReviewCopy.unsavedChanges)
                .font(.callout.weight(.semibold))
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
            Spacer()
        }
        .padding(.horizontal, 18)
        .frame(minHeight: 44)
        .background(Color(hex: "#F4F7FF"))
        .overlay(alignment: .top) {
            Rectangle()
                .fill(Color(hex: "#E3EAFC"))
                .frame(height: 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("listing-review.unsaved")
        .task {
            guard !reduceMotion else { return }
            withAnimation(
                .easeOut(duration: 1.25).repeatForever(autoreverses: false)
            ) {
                pulses = true
            }
        }
    }
}

struct ListingReviewSoldCard: View {
    let match: ListingReviewSoldMatch
    let index: Int
    let total: Int
    let action: () -> Void

    @Environment(\.locale) private var locale

    private var soldPriceText: String {
        ListingReviewCurrency.string(
            match.soldPrice,
            currencyCode: match.currency,
            locale: locale
        )
    }

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 9) {
                ZStack {
                    SnapListColorToken.quietFill.color
                    Image(systemName: "shippingbox")
                        .foregroundStyle(SnapListColorToken.textTertiary.color)
                }
                .aspectRatio(4 / 3, contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .accessibilityHidden(true)

                Text(soldPriceText)
                    .font(.headline.monospacedDigit())
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)

                Text(match.soldDateLabel)
                    .font(.caption)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .background(SnapListColorToken.canvas.color)
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .overlay {
                RoundedRectangle(cornerRadius: 14)
                    .stroke(SnapListColorToken.hairline.color)
            }
        }
        .buttonStyle(.plain)
        .containerRelativeFrame(
            .horizontal,
            count: 2,
            span: 1,
            spacing: 12
        )
        .accessibilityLabel(
            "Sold \(soldPriceText) on \(match.soldDateLabel)"
        )
        .accessibilityValue(
            [match.title, match.condition]
                .compactMap { $0 }
                .joined(separator: ". ")
        )
        .accessibilityHint("View sold comp details")
        .accessibilityIdentifier("listing-review.sold-match.\(index)")
    }
}

extension ListingReviewSoldMatch {
    var soldDateLabel: String {
        guard let soldAt else { return "Date not provided" }
        return Date(
            timeIntervalSince1970: TimeInterval(soldAt) / 1_000
        ).formatted(date: .abbreviated, time: .omitted)
    }
}
