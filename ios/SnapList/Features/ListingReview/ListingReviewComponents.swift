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
    static let identityRerunWarning =
        "Changing this reruns the price and rewrites the listing."
    static let identityCorrectionCost =
        "It uses the guided correction included with this item."
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

/// How a single item specific may be changed.
///
/// A reserved identity key never resolves to `inPlace`. Typing over brand,
/// model, condition, ISBN, UPC, category, or type would change what the item is
/// without rerunning the pricing router, the composite confidence, and the
/// listing generator, which the coherent-correction contract requires to happen
/// together. Those keys route to guided correction instead, and once the
/// correction is spent they have no route at all.
enum ListingReviewSpecificEditing: Equatable {
    case inPlace
    case guidedCorrection
    case spent

    static func mode(
        forSpecificNamed name: String,
        correctionAvailable: Bool
    ) -> ListingReviewSpecificEditing {
        guard ListingReviewDraft.isIdentitySpecificName(name) else {
            return .inPlace
        }
        return correctionAvailable ? .guidedCorrection : .spent
    }
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
            let fixture = configuration.listingReviewFixture ?? .loaded
            let review = configuration.fixture == .trophyProcessing
                ? ListingReviewLaunchFixture.processingReview()
                : fixture.review
            return ListingReviewStore(
                service: ListingReviewFixtureService(
                    fixture: fixture,
                    review: review
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

extension LaunchConfiguration {
    /// Guided correction has no interior yet — Fix item pushes a typed
    /// boundary card owned by #212. Withholding the entry point unless a
    /// fixture asks for it keeps that placeholder out of a real launch, where
    /// the footer offers Edit details instead.
    var listingReviewCorrectionAvailable: Bool {
        listingReviewFixture?.correctionAvailable ?? false
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
    let review: ListingReviewResult

    init(fixture: ListingReviewFixture, review: ListingReviewResult) {
        self.fixture = fixture
        self.review = review
    }

    func fetchReview(
        runID: UUID,
        bearerToken: String
    ) throws -> ListingReviewResult {
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
        // Long enough that "Saving…" outlives more than one XCUI existence
        // poll. A save that resolves inside a single poll interval is not
        // observable from a UI test at all, which makes an assertion on the
        // in-flight state pass or fail on timing rather than on behaviour.
        try await Task.sleep(for: .milliseconds(1_800))
        switch fixture {
        case .saveFailure:
            throw ListingReviewClientError.unavailable
        case .offline:
            throw ListingReviewClientError.offline
        case .conflict:
            throw ListingReviewClientError.conflict
        default:
            let binding = review.binding
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
        usesLongText: Bool = false,
        runID: UUID = Self.runID,
        itemID: UUID = UUID(
            uuidString: "20800000-0000-4000-8000-000000000021"
        )!,
        listingID: UUID = UUID(
            uuidString: "20800000-0000-4000-8000-000000000022"
        )!
    ) -> ListingReviewResult {
        let title = usesLongText
            ? "Sony DualSense Wireless Controller in white with textured grips and USB-C cable"
            : "Sony DualSense Controller · PlayStation 5"
        let description = usesLongText
            ? String(
                repeating:
                    "White DualSense controller with visible wear consistent with regular use. Review the photos for the exact color, hardware, and condition shown. ",
                count: 12
            )
            : "White DualSense controller in good used condition. Review the photos for the exact wear shown."
        // Sold-comp facts rotate so one fixture proves all three shapes: a
        // free Buy It Now, a paid auction, and a record that simply lacks the
        // optional facts. The third case is the one that matters — an absent
        // fact must drop its row rather than render an empty one.
        let soldPrices = [62, 54, 58, 60, 56]
        let soldDates = [
            1_783_080_000_000,
            1_782_561_600_000,
            1_781_956_800_000,
            1_781_352_000_000,
            1_780_747_200_000,
        ]
        let matches = (0..<matchCount).map { index in
            var match: [String: Any] = [
                "id": "fixture-sold-\(index + 1)",
                "sourceURL":
                    "https://example.com/sold/\(index + 1)",
                "title":
                    "Sony DualSense controller sold listing \(index + 1)",
                "soldPrice": soldPrices[index],
                "currency": "USD",
                "condition": "Used",
                "soldAt": soldDates[index],
                "photoURL":
                    "https://example.com/photos/controller-\(index + 1).jpg",
            ]
            switch index % 3 {
            case 0:
                match["size"] = "Body only"
                match["format"] = "buy-it-now"
                match["shipping"] = ["type": "free"]
            case 1:
                match["size"] = "With 50mm lens"
                match["format"] = "auction"
                match["shipping"] = [
                    "type": "paid",
                    // A bare `8.95` literal is a `Double`, and
                    // `JSONSerialization` writes it as 8.9499999999999993,
                    // which the two-decimal currency guard rejects. Carry the
                    // decimal exactly instead.
                    "price": NSDecimalNumber(string: "8.95"),
                    "currency": "USD",
                ]
            default:
                break
            }
            return match
        }
        let object: [String: Any] = [
            "schemaVersion": 1,
            "binding": [
                "runId": runID.uuidString.lowercased(),
                "itemId": itemID.uuidString.lowercased(),
                "listingId": listingID.uuidString.lowercased(),
                "reviewContentRevision":
                    "20800000-0000-4000-8000-000000000025",
                "reviewRevision":
                    "20800000-0000-4000-8000-000000000023",
            ],
            "photos": (0..<5).map { index in
                [
                    "ordinal": index,
                    "url": "https://example.com/photos/\(index + 1).jpg",
                ] as [String: Any]
            },
            "identity": [
                "label": "Sony DualSense Controller · PlayStation 5",
                "confident": true,
            ],
            "listing": [
                "title": title,
                "description": description,
                "condition": "good",
                "specifics": [
                    ["name": "Brand", "value": "Sony"],
                    ["name": "Type", "value": "Wireless controller"],
                    ["name": "Platform", "value": "PlayStation 5"],
                    ["name": "Color", "value": "White"],
                    ["name": "Connectivity", "value": "Wireless"],
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

    static func processingReview() -> ListingReviewResult {
        review(
            runID: UUID(
                uuidString: "37500000-0000-4000-8000-000000000003"
            )!,
            itemID: UUID(
                uuidString: "37500000-0000-4000-8000-000000000009"
            )!,
            listingID: UUID(
                uuidString: "37500000-0000-4000-8000-000000000008"
            )!
        )
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
    case ebayPublish
    case assistedExport
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
        ZStack(alignment: .bottom) {
            TabView(selection: $selectedOrdinal) {
                ForEach(photos, id: \.ordinal) { photo in
                    ListingReviewImage(
                        url: photo.url,
                        fallbackSystemImage: "photo"
                    )
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

            // #896: a gallery reports its count with dots, not a "1 of 2" pill
            // pinned to a corner. This is #883's Photo Review indicator, now
            // shared, so the two photo surfaces count the same way. The dots
            // stay silent for VoiceOver because every photo above already
            // announces itself as `Photo 1 of 2, cover`.
            SnapListPageDots(
                pageCount: photos.count,
                selectedIndex: selectedOrdinal
            )
            .padding(.bottom, SnapListPageDots.Metrics.bottomInset)
        }
        .background(SnapListColorToken.quietFill.color)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("listing-review.photos")
    }
}

private struct ListingReviewImage: View {
    let url: URL?
    let fallbackSystemImage: String

    var body: some View {
#if DEBUG
        if url?.host == "example.com" {
            Image("FirstValueController")
                .resizable()
                .scaledToFill()
        } else {
            remoteImage
        }
#else
        remoteImage
#endif
    }

    private var remoteImage: some View {
        AsyncImage(url: url) { phase in
            switch phase {
            case .success(let image):
                image.resizable().scaledToFill()
            case .empty:
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failure:
                fallback
            @unknown default:
                fallback
            }
        }
    }

    private var fallback: some View {
        ZStack {
            SnapListColorToken.quietFill.color
            Image(systemName: fallbackSystemImage)
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

/// The bordered box every editable value on the review now sits in.
///
/// The box is the affordance. It carries its own label so the value below it
/// starts at the leading edge, which is what keeps the caret at the start of
/// the text instead of against the right margin.
struct ListingReviewInlineField<Content: View>: View {
    let label: String
    var pending = false
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(label)
                    .font(.caption)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                if pending {
                    Circle()
                        .fill(SnapListColorToken.action.color)
                        .frame(width: 6, height: 6)
                        .accessibilityHidden(true)
                }
            }
            // Every caller gives its own control an accessibility label, so
            // the printed caption would otherwise be read twice.
            .accessibilityHidden(true)
            content()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .frame(
            maxWidth: .infinity,
            minHeight: 62,
            alignment: .leading
        )
        .overlay {
            RoundedRectangle(cornerRadius: 12)
                .stroke(SnapListColorToken.inputBorder.color)
        }
    }
}

/// A free-text value the seller has typed but that has not reached the draft.
enum ListingReviewInlineEdit: Hashable {
    case title
    case description
    case specific(String)

    /// Dictionaries have no order, and a flush that writes in a different
    /// order each time is a flush that cannot be tested.
    fileprivate var sortKey: String {
        switch self {
        case .title: "0"
        case .description: "1"
        case .specific(let name): "2\(name)"
        }
    }
}

/// Everything typed into an inline field and not yet committed.
///
/// This is deliberately not state inside the field. Item specifics is a pushed
/// screen, so a field's own state dies with the pop, and a commit fired from a
/// disappearing view is a commit nobody can wait for. The review screen owns
/// this instead and hands it down, so Back, Done, and losing focus all reach
/// the same pending text and can await the same write.
@MainActor
@Observable
final class ListingReviewInlineEdits {
    var typed: [ListingReviewInlineEdit: String] = [:]

    /// Sends every pending value through the store's own write path.
    ///
    /// Identity specifics never appear here. They have no typed field, and
    /// `setSpecific` refuses them regardless, so the coherent-correction seam
    /// holds even if one ever did.
    func flush(into store: ListingReviewStore) async {
        for (field, text) in typed.sorted(by: { $0.key.sortKey < $1.key.sortKey }) {
            switch field {
            case .title:
                await store.setTitle(text)
            case .description:
                await store.setDescription(text)
            case .specific(let name):
                await store.setSpecific(name: name, value: text)
            }
            // Each write suspends, and the field stays on screen and typable
            // while it does. Clearing unconditionally would throw away
            // whatever the seller typed during the await, and the field
            // would then snap back to the value that was in flight. Clear
            // only the value that was actually sent.
            if typed[field] == text {
                typed[field] = nil
            }
        }
    }
}

/// A free-text value typed where it sits, with no pushed screen behind it.
///
/// The field only records what it holds. It never writes: the screen that owns
/// the pending edits decides when they land, which is what keeps the draft off
/// the keystroke path. Staging per keystroke would persist to disk once per
/// character, and `setSpecific` restores the suggested value for an empty
/// string, so it would also make clearing a field to retype it impossible.
struct ListingReviewInlineTextField<Focus: Hashable>: View {
    let label: String
    let value: String
    let pending: Bool
    let identifier: String
    let field: ListingReviewInlineEdit
    let edits: ListingReviewInlineEdits
    let focusValue: Focus
    let lineLimit: ClosedRange<Int>
    // Not `@FocusState`. The control is a `UITextView` now, and SwiftUI's
    // focus system only moves SwiftUI's own responders: writing a value no
    // `.focused` modifier claims makes SwiftUI resign whatever is editing,
    // which here would be this field. The screen keeps its `@FocusState` for
    // the price, which is still a SwiftUI control, and drives these through
    // ordinary state instead. The two channels stay coherent because UIKit
    // allows one first responder, so each one taking focus makes the other
    // give it up and report that it did.
    @Binding var focus: Focus?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.legibilityWeight) private var legibilityWeight
    @State private var text: String

    init(
        label: String,
        value: String,
        pending: Bool = false,
        identifier: String,
        field: ListingReviewInlineEdit,
        edits: ListingReviewInlineEdits,
        focusValue: Focus,
        focus: Binding<Focus?>,
        lineLimit: ClosedRange<Int> = 1...4
    ) {
        self.label = label
        self.value = value
        self.pending = pending
        self.identifier = identifier
        self.field = field
        self.edits = edits
        self.focusValue = focusValue
        self.lineLimit = lineLimit
        _focus = focus
        _text = State(initialValue: value)
    }

    var body: some View {
        ListingReviewInlineField(label: label, pending: pending) {
            ListingReviewInlineTextEditor(
                text: $text,
                accessibilityLabel: label,
                announcedValue: text
                    + (pending ? ", edited, not saved yet" : ""),
                identifier: identifier,
                font: ListingReviewInlineTextEditor.font(
                    dynamicTypeSize: dynamicTypeSize,
                    legibilityWeight: legibilityWeight
                ),
                lineLimit: lineLimit,
                isFocused: focus == focusValue,
                focusChanged: { editing in
                    if editing {
                        focus = focusValue
                    } else if focus == focusValue {
                        focus = nil
                    }
                }
            )
        }
        // The control fills the box now, so what is left for this to pick up
        // is the label band and the padding around the glyphs.
        //
        // Behind the content rather than over it, which is the whole point. A
        // tap gesture on the box wins the tap before the field sees it, so
        // focus gets set programmatically and the caret goes to the end of
        // the text instead of where the finger landed. Sitting behind, the
        // field keeps its own taps and its own caret, and this only picks up
        // what lands in the label band and the padding.
        .background {
            Color.clear
                .contentShape(Rectangle())
                .onTapGesture { focus = focusValue }
        }
        .onChange(of: text) { _, typed in
            edits.typed[field] = typed == value ? nil : typed
        }
        // The store can refuse or normalize what was committed, so the field
        // takes the settled value back rather than keeping what was typed.
        .onChange(of: value) { _, updated in
            guard focus != focusValue else { return }
            text = updated
            edits.typed[field] = nil
        }
    }
}

/// The text view the inline control publishes, with one behavior added.
///
/// The element is floored to 44pt (#918), so a value shorter than that leaves
/// room inside the element that the glyphs do not occupy. `UITextView` answers
/// a tap in that room by putting the caret at the end of the text, because
/// below the last line is where a document ends. That is right for a document
/// and wrong here: this is one field, the room only exists because of a touch
/// floor the seller cannot see, and the seller who taps the box they were told
/// to tap gets the caret somewhere they did not touch (#928).
///
/// Measured on iPhone 17 Pro / iOS 26.5: the element is 44pt tall and a
/// one-line value at the default Dynamic Type size occupies about 20 of them,
/// so taps land on the glyphs down to roughly 22pt and jump to the end below
/// that. The vertical middle of the element sat within a point of that edge,
/// which is why the same tap placed the caret correctly here and at the end of
/// the value on CI.
///
/// The fix is to answer with the position the finger is over horizontally,
/// which is what the rest of the element already does. The point is clamped
/// into the band the glyphs occupy before it is resolved; a value tall enough
/// to fill the element has no band to clamp into and is untouched.
private final class ListingReviewInlineTextView: UITextView {
    override func closestPosition(to point: CGPoint) -> UITextPosition? {
        super.closestPosition(to: clampedIntoGlyphs(point))
    }

    override func closestPosition(
        to point: CGPoint,
        within range: UITextRange
    ) -> UITextPosition? {
        super.closestPosition(to: clampedIntoGlyphs(point), within: range)
    }

    /// Measured from `sizeThatFits` rather than `contentSize`, which a scroll
    /// view is free to grow to its own bounds. One point inside each edge, so
    /// the clamped point resolves against the line rather than against the
    /// boundary between it and the empty room.
    private func clampedIntoGlyphs(_ point: CGPoint) -> CGPoint {
        guard bounds.width > 0 else { return point }
        let glyphs = sizeThatFits(
            CGSize(width: bounds.width, height: .greatestFiniteMagnitude)
        ).height
        let top = textContainerInset.top + 1 - contentOffset.y
        let bottom = glyphs - textContainerInset.bottom - 1 - contentOffset.y
        guard bottom > top else { return point }
        return CGPoint(x: point.x, y: min(max(point.y, top), bottom))
    }
}

/// The control every inline text field publishes.
///
/// SwiftUI's vertical-axis `TextField` is backed by a text view that hugs its
/// content, so the element it publishes is the glyphs — 23pt at the smallest
/// Dynamic Type size — however large a frame it is given. A `contentShape` on
/// the box widened what a finger reaches, but a finger is the only input that
/// sees a content shape: Switch Control, Voice Control, Full Keyboard Access
/// and VoiceOver direct-touch exploration all drive the accessibility element
/// (#918). A `UITextView` fills the frame it is handed, so wrapping one
/// directly is what makes the element the size the seller already sees.
///
/// Nothing here lays a gesture over the text view. Caret placement, drag
/// select, double-tap select and the long-press magnifier are `UITextView`'s
/// own behavior, and #899 lost caret placement once already by putting a tap
/// gesture in front of the control.
struct ListingReviewInlineTextEditor: UIViewRepresentable {
    @Binding var text: String
    let accessibilityLabel: String
    let announcedValue: String
    let identifier: String
    let font: UIFont
    let lineLimit: ClosedRange<Int>
    let isFocused: Bool
    let focusChanged: (Bool) -> Void

    /// `--dynamic-type=` moves SwiftUI's `\.dynamicTypeSize` and nothing else.
    /// `UIApplication.preferredContentSizeCategory` stays where the device
    /// left it, so a UIKit control that asked for "body" itself would come
    /// back at the wrong size on exactly the runs that measure the smallest
    /// one. The size is resolved from the environment and handed down.
    static func font(
        dynamicTypeSize: DynamicTypeSize,
        legibilityWeight: LegibilityWeight?
    ) -> UIFont {
        let body = UIFont.preferredFont(
            forTextStyle: .body,
            compatibleWith: UITraitCollection(
                preferredContentSizeCategory:
                    dynamicTypeSize.contentSizeCategory
            )
        )
        guard legibilityWeight == .bold else { return body }
        let descriptor = body.fontDescriptor
            .withSymbolicTraits(.traitBold) ?? body.fontDescriptor
        return UIFont(descriptor: descriptor, size: body.pointSize)
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeUIView(context: Context) -> UITextView {
        let view = ListingReviewInlineTextView()
        view.delegate = context.coordinator
        context.coordinator.textView = view
        view.backgroundColor = .clear
        // The box owns the padding, so the text view contributes none of its
        // own; otherwise the glyphs sit inset from the caption above them.
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.textAlignment = .natural
        // Scrolling is what a value longer than `lineLimit`'s upper bound does
        // instead of growing, which is what the vertical-axis field did.
        view.isScrollEnabled = true
        view.alwaysBounceVertical = false
        view.showsVerticalScrollIndicator = false
        view.textColor = UIColor(SnapListColorToken.inkPrimary.color)
        view.font = font
        view.text = text
        view.inputAccessoryView = context.coordinator.keyboardAccessory()
        apply(accessibility: view)
        return view
    }

    func updateUIView(_ uiView: UITextView, context: Context) {
        context.coordinator.owner = self
        // Assigning text unconditionally would move the caret to the end on
        // every keystroke, because the binding this reads is the one the
        // delegate below just wrote.
        if uiView.text != text {
            uiView.text = text
        }
        if uiView.font != font {
            uiView.font = font
        }
        apply(accessibility: uiView)

        if isFocused, !uiView.isFirstResponder {
            uiView.becomeFirstResponder()
        } else if !isFocused, uiView.isFirstResponder {
            uiView.resignFirstResponder()
        }
    }

    /// The identifier, label and value go on the text view rather than on the
    /// representable, so exactly one element carries them and the element an
    /// assistive technology lands on is the one that was measured.
    private func apply(accessibility view: UITextView) {
        view.accessibilityIdentifier = identifier
        view.accessibilityLabel = accessibilityLabel
        view.accessibilityValue = announcedValue
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        uiView: UITextView,
        context: Context
    ) -> CGSize? {
        guard let width = proposal.width, width.isFinite, width > 0 else {
            return nil
        }
        // The floor is applied here, once, because a text view fills what it
        // is given. Asking for it with `.frame(minHeight:)` was the lever that
        // did nothing: the vertical-axis field took the room without taking
        // the height.
        let lineHeight = (uiView.font ?? font).lineHeight
        let lowerBound = max(
            SnapListMetrics.minimumTouchTarget,
            (lineHeight * CGFloat(lineLimit.lowerBound)).rounded(.up)
        )
        let upperBound = max(
            lowerBound,
            (lineHeight * CGFloat(lineLimit.upperBound)).rounded(.up)
        )
        let fitting = uiView
            .sizeThatFits(
                CGSize(width: width, height: .greatestFiniteMagnitude)
            )
            .height
        return CGSize(
            width: width,
            height: min(max(fitting, lowerBound), upperBound)
        )
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var owner: ListingReviewInlineTextEditor
        weak var textView: UITextView?

        init(_ owner: ListingReviewInlineTextEditor) {
            self.owner = owner
        }

        /// SwiftUI's `.toolbar(placement: .keyboard)` reaches SwiftUI's own
        /// responders, and this control is not one, so the same Done is built
        /// here rather than left missing. Only one view is first responder at
        /// a time, so this and the screen's own keyboard toolbar are never on
        /// screen together.
        func keyboardAccessory() -> UIToolbar {
            let done = UIBarButtonItem(
                title: ListingReviewCopy.done,
                style: .done,
                target: self,
                action: #selector(dismissKeyboard)
            )
            done.accessibilityLabel = "Done editing, keeps it on this phone"
            done.accessibilityIdentifier = "listing-review.keyboard-done"
            let toolbar = UIToolbar()
            toolbar.items = [
                UIBarButtonItem(
                    barButtonSystemItem: .flexibleSpace,
                    target: nil,
                    action: nil
                ),
                done,
            ]
            toolbar.sizeToFit()
            return toolbar
        }

        @objc private func dismissKeyboard() {
            // Resigning is the only step. Giving up first responder runs
            // `textViewDidEndEditing`, which is where the screen is told.
            textView?.resignFirstResponder()
        }

        func textViewDidChange(_ textView: UITextView) {
            owner.text = textView.text
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            owner.focusChanged(true)
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            owner.focusChanged(false)
        }
    }
}

private extension DynamicTypeSize {
    var contentSizeCategory: UIContentSizeCategory {
        switch self {
        case .xSmall: .extraSmall
        case .small: .small
        case .medium: .medium
        case .large: .large
        case .xLarge: .extraLarge
        case .xxLarge: .extraExtraLarge
        case .xxxLarge: .extraExtraExtraLarge
        case .accessibility1: .accessibilityMedium
        case .accessibility2: .accessibilityLarge
        case .accessibility3: .accessibilityExtraLarge
        case .accessibility4: .accessibilityExtraExtraLarge
        case .accessibility5: .accessibilityExtraExtraExtraLarge
        @unknown default: .large
        }
    }
}

/// What the trailing glyph on a non-typed field promises.
enum ListingReviewFieldAccessory {
    /// A fixed set of answers, chosen in a bottom drawer.
    case drawer
    /// A reserved identity key. Only guided correction can change it.
    case identity
    /// A group of values that has its own screen.
    case push

    fileprivate var symbol: String {
        switch self {
        case .drawer: "chevron.down"
        case .identity: "sparkles"
        case .push: "chevron.right"
        }
    }
}

/// A value that is not typed in place: a fixed option set, a reserved identity
/// key, or a group with its own screen. It wears the same bordered box as the
/// typed fields so the form reads as one grammar.
struct ListingReviewChoiceField: View {
    let label: String
    let value: String
    let identifier: String
    let hint: String
    var accessory = ListingReviewFieldAccessory.drawer
    var pending = false
    var enabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ListingReviewInlineField(label: label, pending: pending) {
                HStack(spacing: 10) {
                    Text(value)
                        .font(.body)
                        .foregroundStyle(
                            enabled
                                ? SnapListColorToken.inkPrimary.color
                                : SnapListColorToken.textTertiary.color
                        )
                        .multilineTextAlignment(.leading)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Image(systemName: accessory.symbol)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(
                            enabled && accessory == .identity
                                ? SnapListColorToken.action.color
                                : SnapListColorToken.textTertiary.color
                        )
                        .accessibilityHidden(true)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityLabel(label)
        .accessibilityValue(value + (pending ? ", edited, not saved yet" : ""))
        .accessibilityHint(hint)
        .accessibilityIdentifier(identifier)
    }
}

/// Bottom-sheet chrome shared by every drawer on the review: a close control,
/// the field name, an optional reset, and one explicit commit at the bottom.
struct ListingReviewDrawer<Content: View>: View {
    let title: String
    let commitLabel: String
    let commitIdentifier: String
    var commitEnabled = true
    var reset: (() -> Void)?
    let close: () -> Void
    let commit: () -> Void
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Button(action: close) {
                    Image(systemName: "xmark")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(SnapListColorToken.inkPrimary.color)
                        .frame(
                            minWidth: SnapListMetrics.minimumTouchTarget,
                            minHeight: SnapListMetrics.minimumTouchTarget
                        )
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close")
                .accessibilityIdentifier("listing-review.drawer.close")

                Text(title)
                    .font(.headline)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .frame(maxWidth: .infinity)

                if let reset {
                    Button("Reset", action: reset)
                        .font(.body)
                        .foregroundStyle(SnapListColorToken.action.color)
                        .frame(minHeight: SnapListMetrics.minimumTouchTarget)
                        .accessibilityIdentifier("listing-review.drawer.reset")
                } else {
                    Color.clear
                        .frame(
                            width: SnapListMetrics.minimumTouchTarget,
                            height: SnapListMetrics.minimumTouchTarget
                        )
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 6)

            Divider()

            ScrollView {
                content()
                    .padding(.horizontal, 18)
                    .padding(.top, 6)
            }

            Button(action: commit) {
                Text(commitLabel)
                    .font(.headline)
                    .foregroundStyle(SnapListColorToken.onDarkSurface.color)
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: 52)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .background(SnapListColorToken.action.color)
            .clipShape(RoundedRectangle(cornerRadius: 15))
            .opacity(commitEnabled ? 1 : 0.4)
            .disabled(!commitEnabled)
            .padding(.horizontal, 18)
            .padding(.top, 10)
            .padding(.bottom, 12)
            .accessibilityIdentifier(commitIdentifier)
        }
        .background(SnapListColorToken.canvas.color)
        .presentationDragIndicator(.visible)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("listing-review.drawer")
    }
}

/// One selectable answer inside a drawer.
struct ListingReviewDrawerOptionRow: View {
    let label: String
    let selected: Bool
    let identifier: String
    let select: () -> Void

    var body: some View {
        Button(action: select) {
            HStack(spacing: 12) {
                Text(label)
                    .font(.body)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Image(
                    systemName: selected
                        ? "largecircle.fill.circle"
                        : "circle"
                )
                .font(.title3)
                .foregroundStyle(
                    selected
                        ? SnapListColorToken.action.color
                        : SnapListColorToken.textTertiary.color
                )
                .accessibilityHidden(true)
            }
            .frame(minHeight: 56)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
        .accessibilityValue(selected ? "Selected" : "")
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
        .background(SnapListColorToken.infoBannerFill.color)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(SnapListColorToken.infoBannerDivider.color)
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
                ListingReviewImage(
                    url: match.photoURL,
                    fallbackSystemImage: "shippingbox"
                )
                .frame(height: 130)
                .frame(maxWidth: .infinity)
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
            .shadow(color: .black.opacity(0.10), radius: 8, y: 3)
        }
        .buttonStyle(.plain)
        .frame(width: 176)
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

    /// Wording follows the approved v2.2.1 sold-comp records verbatim
    /// (`Buy It Now`, `Auction`, `Free shipping`, `$8.95 shipping`). The
    /// board's `Auction · 9 bids` carries a bid count the read contract does
    /// not supply, so the format stands alone rather than inventing one.
    var formatLabel: String? {
        switch format {
        case .auction: "Auction"
        case .buyItNow: "Buy It Now"
        case .auctionWithBuyItNow: "Auction with Buy It Now"
        case nil: nil
        }
    }

    func shippingLabel(locale: Locale = .current) -> String? {
        switch shipping {
        case .free: "Free shipping"
        case let .paid(price, currency):
            "\(ListingReviewCurrency.string(price, currencyCode: currency, locale: locale)) shipping"
        case .pickup: "Local pickup"
        case nil: nil
        }
    }
}
