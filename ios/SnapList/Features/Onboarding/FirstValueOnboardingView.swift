import SwiftUI
import AVFoundation

enum FirstValueOnboardingHeaderMetrics {
    static let controlSlotWidth: CGFloat = 44

    static func trailingSlotWidth(
        for _: FirstValueOnboardingScreen
    ) -> CGFloat {
        controlSlotWidth
    }
}

enum FirstValueOnboardingLayoutMetrics {
    static let draftScoutTopPadding: CGFloat = 8

    /// ONB-02 puts two stacked photos beside one tall photo. Each photo carries a caption
    /// under it, so the tall one has to absorb the caption row the stacked column spends
    /// between its two photos, or the bottom caption on each side sits at a different
    /// height. The tall height is computed rather than written down: the previous literal
    /// assumed a 24 point caption block against a real one nearer 26, and the two drifted
    /// apart silently.
    static let contextShortPhotoHeight: CGFloat = 174
    static let contextColumnSpacing: CGFloat = 10
    /// One caption row plus the gap between it and the photo it labels.
    static let contextCaptionBlockHeight: CGFloat = 26
    static let contextCaptionSpacing: CGFloat = 6

    static var contextTallPhotoHeight: CGFloat {
        contextShortPhotoHeight * 2 + contextColumnSpacing + contextCaptionBlockHeight
    }

    /// Both columns plus the caption under the last photo in each.
    static var contextGridHeight: CGFloat {
        contextTallPhotoHeight + contextCaptionBlockHeight
    }

    /// ONB-06's hero card sat its price row 12 points below the title and roughly 7 above
    /// the card's own edge, so the band read as bottom-cropped. The band takes its height
    /// from these two paddings now instead of a fixed 67, which means a title that wraps
    /// grows the card rather than being clipped by it.
    static let includedCardTextTopPadding: CGFloat = 12
    static let includedCardTextBottomPadding: CGFloat = 12
}

@MainActor
struct FirstValueOnboardingView: View {
    @Bindable var model: FirstValueOnboardingModel
    let forceReducedMotion: Bool
    let usesStaticScoutRendering: Bool
    /// Receives the completion contract #566 consumes, never a bare "done".
    let didFinish: (FirstValueOnboardingOutcome) -> Void
    /// Delegates the existing-account handoff to the shell's typed route.
    let openExistingAccount: () -> Void

    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @AccessibilityFocusState private var headingIsFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollView {
                VStack(spacing: 0) {
                    onboardingContent
                    .frame(maxWidth: usesCompactAuthorityLayout ? 353 : 420)
                    .padding(.horizontal, usesCompactAuthorityLayout ? 20 : 24)
                    .padding(.top, usesCompactAuthorityLayout ? 2 : 8)
                    .padding(.bottom, usesCompactAuthorityLayout ? 8 : 24)

                    if usesFlowingIncludedFooter {
                        footer
                    }
                }
            }
            .scrollIndicators(.hidden)
            .accessibilityIdentifier("first-value-onboarding.scroll")
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if !usesFlowingIncludedFooter {
                    footer
                }
            }
        }
        .background(SnapListColorToken.canvas.color.ignoresSafeArea())
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("first-value-onboarding.state.\(model.screen.identifier)")
        .onAppear { headingIsFocused = true }
        .onChange(of: model.screen) { _, _ in headingIsFocused = true }
    }

    private var reduceMotion: Bool {
        systemReduceMotion || forceReducedMotion
    }

    /// At Accessibility Dynamic Type, the two dense preview screens must scroll
    /// before their actions rather than share the viewport with a sticky footer.
    private var usesFlowingIncludedFooter: Bool {
        (model.screen == .onb04 || model.screen == .onb06)
            && dynamicTypeSize.isAccessibilitySize
    }

    private var usesCompactAuthorityLayout: Bool {
        model.screen == .onb01
            || model.screen == .onb02
            || model.screen == .onb03
            || model.screen == .onb04
            || model.screen == .onb05
            || model.screen == .onb06
    }

    @ViewBuilder
    private var onboardingContent: some View {
        if usesCompactAuthorityLayout {
            VStack(spacing: 0) {
                title
                    .accessibilityFocused($headingIsFocused)
                if model.screen == .onb03 {
                    screenContent
                        .padding(.top, 25)
                } else if model.screen == .onb04 {
                    screenContent
                        .padding(.top, 20)
                } else if model.screen == .onb05 {
                    screenContent
                        .padding(.top, 17.25)
                } else if model.screen == .onb06 {
                    screenContent
                        .padding(.top, 14)
                } else {
                    Divider()
                        .padding(.top, model.screen == .onb02 ? 6 : 18)
                        .padding(.bottom, model.screen == .onb02 ? 6 : 14)
                    screenContent
                }
            }
        } else {
            VStack(spacing: 18) {
                title
                    .accessibilityFocused($headingIsFocused)
                screenContent
            }
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            if model.screen != .onb01 {
                Button(action: model.goBack) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 17, weight: .semibold))
                        .frame(width: 44, height: 44)
                }
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .accessibilityLabel("Back")
                .accessibilityIdentifier("first-value-onboarding.back")
            }

            HStack(spacing: 5) {
                ForEach(FirstValueOnboardingScreen.allCases, id: \.self) { screen in
                    Capsule()
                        .fill(screen.rawValue <= model.screen.rawValue
                            ? SnapListColorToken.inkPrimary.color
                            : SnapListColorToken.progressTrackInactive.color)
                        .frame(height: 4)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Onboarding progress")
            .accessibilityValue("Step \(model.screen.rawValue) of 6")
            .accessibilityIdentifier("first-value-onboarding.progress")

            if model.screen != .onb06 {
                Button { finish(using: model.skip) } label: {
                    Text("Skip")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(SnapListColorToken.action.color)
                        // The header slot is the 44pt touch target, so at the
                        // accessibility sizes the word was truncated away and
                        // the control read as an unlabelled row of dots. The
                        // floor is lower than the default because `Skip` at
                        // accessibility5 is close to three times the slot; even
                        // at this floor it still resolves larger than the
                        // default-size label, which is the point.
                        .snapListFitsFixedSlot(minimumScale: 0.35)
                        .frame(
                            width: FirstValueOnboardingHeaderMetrics
                                .trailingSlotWidth(for: model.screen),
                            height: FirstValueOnboardingHeaderMetrics
                                .controlSlotWidth
                        )
                        .contentShape(Rectangle())
                }
                    .accessibilityIdentifier("first-value-onboarding.skip")
            } else {
                Color.clear
                    .frame(
                        width: FirstValueOnboardingHeaderMetrics
                            .trailingSlotWidth(for: model.screen),
                        height: FirstValueOnboardingHeaderMetrics
                            .controlSlotWidth
                    )
                    .accessibilityHidden(true)
                    .allowsHitTesting(false)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 4)
    }

    private var title: some View {
        Group {
            switch model.screen {
            case .onb01:
                highlightedTitle("Photograph anything.\n", "We write the listing.")
            case .onb02:
                highlightedTitle("A few angles,\n", "then say the rest.")
            case .onb03:
                highlightedTitle("Priced from controllers\n", "that actually sold.")
            case .onb04:
                highlightedTitle("Written for you.\n", "Yours to change.")
            case .onb05:
                highlightedTitle("It finishes\n", "while you keep going.")
            case .onb06:
                highlightedTitle("Your first one\n", "is on us.", blue: SnapListColorToken.actionDeep.color)
            }
        }
        .font(usesCompactAuthorityLayout
            ? .system(
                size: model.screen == .onb03 || model.screen == .onb04 || model.screen == .onb05
                    ? 25
                    : 27,
                weight: .bold,
                design: .rounded
            )
            : .system(.largeTitle, design: .rounded, weight: .bold))
        .frame(maxWidth: .infinity, alignment: .leading)
        .multilineTextAlignment(.leading)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityAddTraits(.isHeader)
    }

    private func highlightedTitle(_ ink: String, _ blue: String, blue color: Color = SnapListColorToken.action.color) -> Text {
        Text(ink).foregroundColor(SnapListColorToken.inkPrimary.color)
            + Text(blue).foregroundColor(color)
    }

    @ViewBuilder
    private var screenContent: some View {
        switch model.screen {
        case .onb01: photographScreen
        case .onb02: contextScreen
        case .onb03: pricingScreen
        case .onb04: draftScreen
        case .onb05: backgroundScreen
        case .onb06: includedScreen
        }
    }

    private var photographScreen: some View {
        VStack(spacing: 0) {
            GeometryReader { proxy in
                let tileWidth = (proxy.size.width - 16) / 3
                HStack(spacing: 8) {
                    photographTile(
                        "FirstValueHeadphones",
                        label: "A pair of over-ear headphones on a plain surface",
                        width: tileWidth
                    )
                    photographTile(
                        "FirstValueController",
                        label: "A white game controller on a plain gray surface",
                        width: tileWidth
                    )
                    photographTile(
                        "FirstValueTradingCard",
                        label: "A holographic trading card on gray cloth",
                        width: tileWidth
                    )
                }
            }
            .frame(height: 300)
            Divider()
                .padding(.top, 14)
                .padding(.bottom, 14)
            photographListingProjection
            FirstValueScoutView(
                screen: .onb01,
                reduceMotion: reduceMotion,
                usesStaticRendering: usesStaticScoutRendering
            )
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, FirstValueOnboardingScreen.onb01.scout.leadingPull)
                .padding(.top, 28)
        }
    }

    private func photographTile(
        _ name: String,
        label: String,
        width: CGFloat
    ) -> some View {
        Image(name)
            .resizable()
            .scaledToFill()
            .frame(width: width, height: 300)
            .clipped()
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .accessibilityLabel(label)
    }

    private var photographListingProjection: some View {
        HStack(spacing: 12) {
            Image("FirstValueController")
                .resizable()
                .scaledToFill()
                .frame(width: 54, height: 54)
                .clipped()
                .clipShape(RoundedRectangle(cornerRadius: 11))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(FirstValueOnboardingCopy.shortListingTitle)
                    .font(.system(size: 16, weight: .semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.9)
                HStack(spacing: 7) {
                    Text("$58").font(.system(size: 22, weight: .bold))
                    Text("Good")
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(
                            SnapListColorToken.quietFill.color,
                            in: RoundedRectangle(cornerRadius: 6)
                        )
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity)
        .background(SnapListColorToken.canvas.color, in: RoundedRectangle(cornerRadius: 18))
        .overlay {
            RoundedRectangle(cornerRadius: 18)
                .stroke(SnapListColorToken.cardHairline.color)
        }
        .shadow(color: .black.opacity(0.08), radius: 14, y: 5)
        .accessibilityElement(children: .combine)
    }

    private var contextScreen: some View {
        VStack(spacing: 0) {
            GeometryReader { proxy in
                let metrics = FirstValueOnboardingLayoutMetrics.self
                let columnWidth = (proxy.size.width - metrics.contextColumnSpacing) / 2
                HStack(alignment: .top, spacing: metrics.contextColumnSpacing) {
                    VStack(spacing: metrics.contextColumnSpacing) {
                        contextPhoto(
                            crop: .whole,
                            height: metrics.contextShortPhotoHeight,
                            width: columnWidth
                        )
                        .accessibilitySortPriority(3)
                        contextPhoto(
                            crop: .flaw,
                            height: metrics.contextShortPhotoHeight,
                            width: columnWidth
                        )
                        .accessibilitySortPriority(2)
                    }
                    contextPhoto(
                        crop: .details,
                        height: metrics.contextTallPhotoHeight,
                        width: columnWidth
                    )
                    .accessibilitySortPriority(1)
                }
            }
            .frame(height: FirstValueOnboardingLayoutMetrics.contextGridHeight)
            Divider()
                .padding(.top, 14)
                .padding(.bottom, 16)
            HStack(alignment: .top, spacing: 0) {
                FirstValueScoutView(
                    screen: .onb02,
                    reduceMotion: reduceMotion,
                    usesStaticRendering: usesStaticScoutRendering
                )
                .padding(.leading, FirstValueOnboardingScreen.onb02.scout.leadingPull)
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 10) {
                        Image(systemName: "play.fill")
                            .font(.system(size: 15, weight: .bold))
                            .foregroundStyle(SnapListColorToken.onDarkSurface.color)
                            .frame(width: 40, height: 40)
                            .background(SnapListColorToken.action.color, in: Circle())
                        FirstValueVoiceWaveform()
                        Spacer(minLength: 0)
                        Text("0:09 / 0:15")
                            .font(.caption.monospacedDigit().weight(.semibold))
                            .foregroundStyle(SnapListColorToken.textSecondary.color)
                            .fixedSize()
                    }
                    Text("“\(FirstValueOnboardingCopy.voiceNoteQuote)”")
                        .font(.subheadline)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Optional. Voice note, 9 seconds of a possible 15. Play. \(FirstValueOnboardingCopy.voiceNoteQuote)")
        }
    }

    private var pricingScreen: some View {
        VStack(spacing: 0) {
            VStack(spacing: 0) {
                HStack(alignment: .lastTextBaseline, spacing: 12) {
                    Text("$49 to $66").font(.system(size: 32, weight: .bold))
                    Spacer(minLength: 0)
                    Text("Based on sold listings.")
                        .font(.caption)
                        .foregroundStyle(SnapListColorToken.textSecondary.color)
                        .multilineTextAlignment(.trailing)
                }
                .padding(.bottom, 8)
                Rectangle().fill(SnapListColorToken.inkPrimary.color).frame(height: 1.5)
                HStack(spacing: 8) {
                    VStack {
                        Text("$70")
                        Spacer()
                        Text("$55")
                        Spacer()
                        Text("$40")
                    }
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    SoldBandFixtureChart()
                }
                .frame(height: 92)
                .padding(.top, 22)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Sold prices over the last 90 days, from 40 to 70 dollars. Suggested, 58 dollars. Chart.")
                HStack {
                    Text("90 days ago")
                    Spacer()
                    Text("Today")
                }
                .font(.caption)
                .foregroundStyle(SnapListColorToken.textSecondary.color)
                .padding(.leading, 34)
                .padding(.bottom, 6)
                VStack(spacing: 0) {
                    ForEach(FirstValueOnboardingCopy.soldComparisonRows, id: \.self) { row in
                        soldRow(row)
                    }
                }
            }
            Divider()
                .padding(.top, 20)
                .padding(.bottom, 6)
            ScoutLine(
                screen: .onb03,
                reduceMotion: reduceMotion,
                usesStaticRendering: usesStaticScoutRendering
            ) {
                Text("You can change the price later.")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .padding(.leading, 8)
            }
        }
    }

    private var draftScreen: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                itemImage("FirstValueController", label: "The controller in its finished listing")
                    .frame(width: 96, height: 96)
                    .clipShape(RoundedRectangle(cornerRadius: 16))
                VStack(alignment: .leading, spacing: 4) {
                    Text("Your draft is ready").font(.title3.weight(.semibold))
                    Text("Four fields, written from your photos")
                        .font(.subheadline).foregroundStyle(SnapListColorToken.textSecondary.color)
                }
                Spacer()
            }
            .padding(12)
            .background(SnapListColorToken.onboardingHighlightFill.color, in: RoundedRectangle(cornerRadius: 16))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Your draft is ready. Four fields, written from your photos.")

            VStack(spacing: 0) {
                draftEditableRow(
                    "Title",
                    FirstValueOnboardingCopy.listingTitle,
                    showsTopDivider: false
                )
                draftEditableRow(
                    "Condition",
                    FirstValueOnboardingCopy.listingCondition
                )
                draftPriceRow
                draftEditableRow("Description", "Four paragraphs")
            }
            .background(SnapListColorToken.canvas.color)
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .overlay {
                RoundedRectangle(cornerRadius: 14)
                    .stroke(SnapListColorToken.cardHairline.color)
            }
            .padding(.top, 16)

            Divider()
                .padding(.top, 33)

            ScoutLine(
                screen: .onb04,
                reduceMotion: reduceMotion,
                usesStaticRendering: usesStaticScoutRendering
            ) {
                Text("Not right? One redo on the same photos is included.")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .padding(.leading, -14)
                    .accessibilityIdentifier(
                        "first-value-onboarding.draft-scout-copy"
                    )
            }
            .padding(
                .top,
                FirstValueOnboardingLayoutMetrics.draftScoutTopPadding
            )
        }
    }

    private var backgroundScreen: some View {
        VStack(spacing: 0) {
            VStack(spacing: 10) {
                ForEach(FirstValueOnboardingCopy.backgroundExampleRows, id: \.self) { row in
                    BackgroundExampleRowView(row: row)
                }
            }
            HStack(spacing: 10) {
                backgroundActionTile("camera", "Scan the next one", "No waiting")
                backgroundActionTile("trophy", "Trophy Wall", "Finished listings")
            }
            .padding(.top, 27)
            ScoutLine(
                screen: .onb05,
                reduceMotion: reduceMotion,
                usesStaticRendering: usesStaticScoutRendering
            ) {
                Text("Scout keeps working in the background.")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .padding(.leading, 10)
            }
            .padding(.top, 33.5)
        }
    }

    private func backgroundActionTile(
        _ symbol: String,
        _ title: String,
        _ subtitle: String
    ) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            Image(systemName: symbol)
                .font(.system(size: 22, weight: .medium))
                .foregroundStyle(SnapListColorToken.action.color)
                .frame(width: 42, height: 42)
                .background(SnapListColorToken.actionTint.color, in: RoundedRectangle(cornerRadius: 13))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.subheadline.weight(.semibold))
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 13)
        .padding(.bottom, 11)
        .frame(maxWidth: .infinity, minHeight: 116.5, alignment: .leading)
        .background(SnapListColorToken.canvas.color, in: RoundedRectangle(cornerRadius: 14))
        .overlay {
            RoundedRectangle(cornerRadius: 14)
                .stroke(SnapListColorToken.cardHairline.color, lineWidth: 1)
        }
        .accessibilityElement(children: .combine)
    }

    private var includedScreen: some View {
        VStack(spacing: 26) {
            includedListingPreview
            ScoutLine(
                screen: .onb06,
                reduceMotion: reduceMotion,
                usesStaticRendering: usesStaticScoutRendering
            ) {
                Text(FirstValueOnboardingCopy.includedScoutLine)
                    .font(.system(size: 13))
                    .foregroundStyle(SnapListColorToken.mutedHeadlineText.color)
                    .padding(.leading, 12)
            }
        }
    }

    private var includedListingPreview: some View {
        VStack(spacing: 0) {
            ZStack(alignment: .topLeading) {
                ZStack(alignment: .topLeading) {
                    Image("FirstValueController")
                        .resizable()
                        .scaledToFill()
                        .frame(maxWidth: .infinity)
                        .frame(height: 254)
                        .clipped()
                    Text("Included")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(SnapListColorToken.onDarkSurface.color)
                        .padding(.horizontal, 11)
                        .padding(.vertical, 6)
                        .background(SnapListColorToken.action.color, in: Capsule())
                        .padding(11)
                }
                .accessibilityHidden(true)

                Color.clear
                    .frame(maxWidth: .infinity)
                    .frame(height: 254)
                    .contentShape(Rectangle())
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("The finished listing for the DualSense controller")
                    .accessibilityIdentifier("first-value-onboarding.included-photo-preview")
            }
            .frame(maxWidth: .infinity)
            .frame(height: 254)
            .clipped()

            VStack(alignment: .leading, spacing: 6) {
                Text(FirstValueOnboardingCopy.listingTitle)
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity, alignment: .leading)
                if dynamicTypeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Ready to review")
                            .font(.caption)
                            .foregroundStyle(SnapListColorToken.textSecondary.color)
                        Text("$58").font(.body.bold())
                    }
                } else {
                    HStack {
                        Text("Ready to review")
                            .font(.caption)
                            .foregroundStyle(SnapListColorToken.textSecondary.color)
                        Spacer()
                        Text("$58").font(.body.bold())
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.top, FirstValueOnboardingLayoutMetrics.includedCardTextTopPadding)
            .padding(.bottom, FirstValueOnboardingLayoutMetrics.includedCardTextBottomPadding)
            .frame(maxWidth: .infinity, alignment: .top)
        }
        .background(SnapListColorToken.canvas.color)
        .clipShape(RoundedRectangle(cornerRadius: 18))
        .shadow(color: Color.black.opacity(0.18), radius: 16, y: 10)
    }

    private var footer: some View {
        VStack(spacing: 8) {
            FirstValueOnboardingContinueButton(
                isFinalScreen: model.screen == .onb06,
                action: { finish(using: model.continueForward) }
            )

            if model.screen == .onb06 {
                Button(action: openExistingAccount) {
                    Text("I already have an account")
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .contentShape(.rect)
                }
                    .buttonStyle(.plain)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(SnapListColorToken.action.color)
                    .accessibilityIdentifier("first-value-onboarding.sign-in")
            }
        }
        .padding(.horizontal, model.screen == .onb06 ? 20 : 24)
        .padding(.top, model.screen == .onb06 ? 10 : 12)
        .padding(.bottom, model.screen == .onb06 ? 0 : 8)
        .background(SnapListColorToken.canvas.color)
        .overlay(alignment: .top) { Divider() }
    }

    private func finish(using action: () -> Void) {
        action()
        if let outcome = model.outcome { didFinish(outcome) }
    }

    private enum ItemCrop: Equatable { case whole, flaw, details }

    private func contextCaption(_ crop: ItemCrop) -> String {
        let captions = FirstValueOnboardingCopy.contextCaptions
        switch crop {
        case .whole: return captions.whole
        case .flaw: return captions.flaw
        case .details: return captions.details
        }
    }

    private func contextPhoto(
        crop: ItemCrop,
        height: CGFloat,
        width: CGFloat
    ) -> some View {
        let caption = contextCaption(crop)
        return VStack(spacing: FirstValueOnboardingLayoutMetrics.contextCaptionSpacing) {
            itemCropImage(crop)
                .frame(width: width, height: height)
                .clipped()
                .clipShape(RoundedRectangle(cornerRadius: 14))
            HStack(spacing: 5) {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(SnapListColorToken.action.color)
                Text(caption)
            }
            // Set on the row, not on the label alone. Left to the environment, the
            // checkmark resolved a size larger than the caption beside it.
            .font(.subheadline.weight(.semibold))
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
        }
        .frame(width: width)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(caption). \(contextAlt(crop))")
    }

    /// Three views of the seller's own item, which is one photograph. The scale and anchor
    /// are what make them three different views rather than the same frame three times.
    ///
    /// The anchors belong to this photograph, not to the layout. They were carried over
    /// from the jacket this asset replaced and broke twice: a corner anchor that framed a
    /// jacket landed on empty background once the subject changed, and changed again when
    /// the subject moved from a red field to a gray one. Re-derive them against the actual
    /// file if the asset changes, and check that `contextAlt` still describes what is in
    /// frame.
    @ViewBuilder
    private func itemCropImage(_ crop: ItemCrop) -> some View {
        switch crop {
        case .whole:
            Image("FirstValueController").resizable().scaledToFill()
        case .flaw:
            Image("FirstValueController")
                .resizable().scaledToFill()
                .scaleEffect(2.2, anchor: .bottomLeading)
        case .details:
            Image("FirstValueController")
                .resizable().scaledToFill()
                .scaleEffect(1.6, anchor: UnitPoint(x: 0.5, y: 0.72))
        }
    }

    /// Describes what the crop actually shows. The listing copy says the controller has a
    /// scuff; this photograph does not show one, so the alternative text names the parts in
    /// frame rather than sending a screen reader looking for a mark that is not there.
    private func contextAlt(_ crop: ItemCrop) -> String {
        switch crop {
        case .whole: "The whole controller photographed on a plain surface"
        case .flaw: "Close view of the face buttons and the grip below them"
        case .details: "Close view of the thumbstick, speaker holes and USB-C port"
        }
    }

    private func itemImage(_ name: String, label: String) -> some View {
        Image(name).resizable().scaledToFit().accessibilityLabel(label)
    }

    private func soldRow(_ row: SoldComparisonRow) -> some View {
        HStack(spacing: 11) {
            Image(row.imageName)
                .resizable()
                .scaledToFill()
                .frame(width: 36, height: 36)
                .clipped()
                .clipShape(RoundedRectangle(cornerRadius: 9))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.condition).font(.subheadline.weight(.semibold))
                Text("Sold \(row.soldAgo)").font(.caption)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
            }
            Spacer()
            Text(row.price).font(.body.bold())
        }
        .padding(.vertical, 7)
        .overlay(alignment: .top) { Divider() }
        .accessibilityElement(children: .combine)
    }

    private func draftEditableRow(
        _ label: String,
        _ value: String,
        showsTopDivider: Bool = true
    ) -> some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(label.uppercased()).font(.caption2.bold())
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                Text(value)
                    .font(.subheadline)
                    .lineLimit(1)
                    .minimumScaleFactor(0.9)
            }
            Spacer(minLength: 0)
            Image(systemName: "pencil")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(SnapListColorToken.action.color)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .overlay(alignment: .top) {
            if showsTopDivider { Divider() }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(label). \(value).")
    }

    private var draftPriceRow: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                Text("PRICE")
                    .font(.caption2.bold())
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                Spacer(minLength: 0)
                Text("$58")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .strikethrough()
            }
            HStack(spacing: 4) {
                Text("$64")
                    .font(.title3.bold())
                Rectangle()
                    .fill(SnapListColorToken.action.color)
                    .frame(width: 2, height: 20)
                    .accessibilityHidden(true)
                Spacer(minLength: 0)
                Text("You set this")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(SnapListColorToken.action.color)
            }
            .padding(.horizontal, 12)
            .frame(height: 40)
            .background(SnapListColorToken.canvas.color, in: RoundedRectangle(cornerRadius: 12))
            .overlay {
                RoundedRectangle(cornerRadius: 12)
                    .stroke(SnapListColorToken.action.color, lineWidth: 2)
            }
            .shadow(color: SnapListColorToken.action.color.opacity(0.12), radius: 0, x: 0, y: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .overlay(alignment: .top) { Divider() }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Price. Was 58 dollars. Now 64 dollars. You set this.")
    }

    private func tile(_ symbol: String, _ title: String, _ subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Image(systemName: symbol).foregroundStyle(SnapListColorToken.action.color)
            Text(title).font(.subheadline.weight(.semibold))
            Text(subtitle).font(.caption).foregroundStyle(SnapListColorToken.textSecondary.color)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(SnapListColorToken.summaryCardFill.color, in: RoundedRectangle(cornerRadius: 15))
        .accessibilityElement(children: .combine)
    }

    private func card<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        content()
            .padding(16)
            .frame(maxWidth: .infinity)
            .background(SnapListColorToken.canvas.color, in: RoundedRectangle(cornerRadius: 18))
            .overlay { RoundedRectangle(cornerRadius: 18).stroke(SnapListColorToken.cardHairline.color) }
            .shadow(color: .black.opacity(0.05), radius: 14, y: 5)
    }
}

/// The footer's forward opener, isolated so a unit test can render it alone and inspect
/// its resolved button style (#856), the same technique `LegalLinkRow` uses.
struct FirstValueOnboardingContinueButton: View {
    let isFinalScreen: Bool
    let action: () -> Void

    var body: some View {
        Button(isFinalScreen ? "Start scanning" : "Continue", action: action)
            .font(.body.bold())
            .foregroundStyle(SnapListColorToken.onDarkSurface.color)
            .frame(maxWidth: .infinity, minHeight: 52)
            .background(SnapListColorToken.action.color, in: RoundedRectangle(cornerRadius: 14))
            // The filled capsule above is this control's whole affordance. Left on
            // `.automatic`, iOS paints a second filled shape behind it for a seller
            // with Button Shapes on, which reads as an overlay sitting on the label (#856).
            .buttonStyle(.plain)
            .accessibilityIdentifier(isFinalScreen
                ? "first-value-onboarding.start-scanning"
                : "first-value-onboarding.continue")
    }
}

/// The ONB-02 voice-note example. The row shows a play control and a running
/// time, so a frozen waveform reads as a clip that stopped rather than one that
/// is playing. The bars ride a travelling wave whose phase comes from the
/// timeline clock, which loops seamlessly because the phase is periodic.
///
/// Reduce Motion gets the resting bar heights and no timeline, so the example
/// still reads as a voice note without any movement.
struct FirstValueVoiceWaveform: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Seconds for one full pass of the wave across the bars.
    static let cycleDuration: Double = 1.5

    static let restingBarHeights: [CGFloat] = [
        14, 22, 30, 18, 34, 24, 16, 28, 20, 32, 18, 26, 38, 22, 30, 16,
    ]

    var body: some View {
        Group {
            if reduceMotion {
                bars(phase: nil)
            } else {
                TimelineView(.animation) { context in
                    bars(phase: Self.phase(at: context.date))
                }
            }
        }
        .frame(height: 40)
        .accessibilityHidden(true)
    }

    private func bars(phase: Double?) -> some View {
        HStack(alignment: .center, spacing: 2) {
            ForEach(Array(Self.restingBarHeights.enumerated()), id: \.offset) { index, resting in
                Capsule()
                    .fill(SnapListColorToken.action.color)
                    .frame(
                        width: 3,
                        height: Self.barHeight(resting: resting, index: index, phase: phase)
                    )
            }
        }
    }

    /// Position within one loop, in `0..<1`.
    static func phase(at date: Date) -> Double {
        let elapsed = date.timeIntervalSinceReferenceDate
        return elapsed.truncatingRemainder(dividingBy: cycleDuration) / cycleDuration
    }

    /// A `nil` phase means Reduce Motion, which returns the resting height
    /// untouched. Otherwise the bar is scaled by a sine offset by its own
    /// position, which is what makes the wave travel instead of pulsing as one
    /// block. The scale never reaches zero, so no bar disappears mid-loop.
    static func barHeight(resting: CGFloat, index: Int, phase: Double?) -> CGFloat {
        guard let phase else {
            return resting
        }
        let offset = Double(index) / Double(restingBarHeights.count)
        let angle = (phase + offset) * 2 * .pi
        let scale = 0.55 + (0.45 * ((sin(angle) + 1) / 2))
        return max(4, resting * CGFloat(scale))
    }
}

/// An approved ONB-05 work-example row. Its static status dot is decorative,
/// never a `ProgressView`, percentage, or claim about a live pipeline run.
struct BackgroundExampleRowView: View {
    let row: BackgroundExampleRow

    var body: some View {
        HStack(spacing: 10) {
            Image(row.imageName)
                .resizable()
                .scaledToFill()
                .accessibilityLabel(row.item)
                .frame(width: 62, height: 62)
                .clipped()
                .clipShape(RoundedRectangle(cornerRadius: 11))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(row.item).font(.subheadline.weight(.semibold))
                HStack(spacing: 7) {
                    Circle()
                        .fill(SnapListColorToken.accentDotLight.color)
                        .frame(width: 7, height: 7)
                        .accessibilityHidden(true)
                    Text(row.state).font(.system(size: 13))
                        .foregroundStyle(SnapListColorToken.textSecondary.color)
                }
            }
            Spacer()
        }
        .padding(.horizontal, 13)
        .padding(.vertical, 10.5)
        .background(SnapListColorToken.canvas.color, in: RoundedRectangle(cornerRadius: 14))
        .overlay {
            RoundedRectangle(cornerRadius: 14)
                .stroke(SnapListColorToken.cardHairline.color, lineWidth: 1)
        }
        .accessibilityElement(children: .combine)
    }
}

private struct ScoutLine<Content: View>: View {
    let screen: FirstValueOnboardingScreen
    let reduceMotion: Bool
    let usesStaticRendering: Bool
    let content: Content

    init(
        screen: FirstValueOnboardingScreen,
        reduceMotion: Bool,
        usesStaticRendering: Bool,
        @ViewBuilder content: () -> Content
    ) {
        self.screen = screen
        self.reduceMotion = reduceMotion
        self.usesStaticRendering = usesStaticRendering
        self.content = content()
    }

    var body: some View {
        HStack(spacing: 0) {
            FirstValueScoutView(
                screen: screen,
                reduceMotion: reduceMotion,
                usesStaticRendering: usesStaticRendering
            )
            .padding(.leading, screen.scout.leadingPull)
            content
                .font(.subheadline.weight(.medium))
                .foregroundStyle(SnapListColorToken.textSecondary.color)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("first-value-onboarding.scout-line.\(screen.identifier)")
    }
}

private struct FirstValueScoutView: View {
    let screen: FirstValueOnboardingScreen
    let reduceMotion: Bool
    let usesStaticRendering: Bool

    var body: some View {
        Group {
            switch screen.scoutRendering(
                reduceMotion: reduceMotion,
                usesStaticRendering: usesStaticRendering
            ) {
            case .acceptedRuntimeDerivative(_, let url):
                AcceptedScoutPlayerView(url: url)
            case .staticFallbackPNG(let asset):
                Image(asset).resizable().scaledToFit()
            }
        }
        .frame(width: max(56, screen.scout.size), height: max(56, screen.scout.size))
        .accessibilityHidden(true)
        .allowsHitTesting(false)
    }
}

/// Plays an alpha-preserving native derivative of one accepted Scout WebM.
///
/// The caller resolves Reduced Motion and `--static-scout-rendering` before this
/// representable is constructed, so those paths create no player.
private struct AcceptedScoutPlayerView: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> FirstValueScoutPlayerUIView {
        FirstValueScoutPlayerUIView()
    }

    func updateUIView(
        _ view: FirstValueScoutPlayerUIView,
        context: Context
    ) {
        view.playLoop(url: url)
    }

    static func dismantleUIView(
        _ view: FirstValueScoutPlayerUIView,
        coordinator: ()
    ) {
        view.stop()
    }
}

private final class FirstValueScoutPlayerUIView: UIView {
    private var player: AVQueuePlayer?
    private var looper: AVPlayerLooper?
    private var loadedURL: URL?

    override static var layerClass: AnyClass {
        AVPlayerLayer.self
    }

    private var playerLayer: AVPlayerLayer {
        layer as! AVPlayerLayer
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        isOpaque = false
        isAccessibilityElement = false
        accessibilityElementsHidden = true
        playerLayer.backgroundColor = UIColor.clear.cgColor
        playerLayer.videoGravity = .resizeAspect
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func playLoop(url: URL) {
        guard loadedURL != url else {
            player?.play()
            return
        }

        stop()
        loadedURL = url
        let player = AVQueuePlayer()
        player.isMuted = true
        looper = AVPlayerLooper(
            player: player,
            templateItem: AVPlayerItem(url: url)
        )
        playerLayer.player = player
        self.player = player
        player.play()
    }

    func stop() {
        player?.pause()
        playerLayer.player = nil
        looper = nil
        player = nil
        loadedURL = nil
    }

    deinit {
        player?.pause()
    }
}

private struct SoldBandFixtureChart: View {
    private let samples: [CGFloat] = [85.1, 74.2, 79.6, 66.1, 71.5, 55.3, 63.4, 47.2, 58, 41.8, 49.9, 44.5]

    var body: some View {
        GeometryReader { proxy in
            let points = samples.enumerated().map { index, sample in
                CGPoint(
                    x: 6 + (proxy.size.width - 12) * CGFloat(index) / CGFloat(samples.count - 1),
                    y: proxy.size.height * sample / 116
                )
            }
            Path { path in
                guard let first = points.first, let last = points.last else { return }
                path.move(to: CGPoint(x: first.x, y: proxy.size.height))
                path.addLine(to: first)
                for point in points.dropFirst() { path.addLine(to: point) }
                path.addLine(to: CGPoint(x: last.x, y: proxy.size.height))
                path.closeSubpath()
            }
            .fill(LinearGradient(colors: [SnapListColorToken.action.color.opacity(0.2), SnapListColorToken.action.color.opacity(0.02)], startPoint: .top, endPoint: .bottom))
            Path { path in
                guard let first = points.first else { return }
                path.move(to: first)
                for point in points.dropFirst() { path.addLine(to: point) }
            }
            .stroke(SnapListColorToken.action.color, style: StrokeStyle(lineWidth: 2.2, lineCap: .round, lineJoin: .round))
            Path { path in
                let y = proxy.size.height * 55.3 / 116
                path.move(to: CGPoint(x: 0, y: y))
                path.addLine(to: CGPoint(x: proxy.size.width, y: y))
            }
            .stroke(SnapListColorToken.inkPrimary.color, style: StrokeStyle(lineWidth: 1.4, dash: [5, 4]))
            ForEach(Array(points.enumerated()), id: \.offset) { _, point in
                Circle().fill(SnapListColorToken.action.color).frame(width: 5, height: 5).position(point)
            }
            Text("Suggested $58")
                .font(.caption2.bold())
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .position(x: 53, y: proxy.size.height * 55.3 / 116 - 12)
        }
    }
}
