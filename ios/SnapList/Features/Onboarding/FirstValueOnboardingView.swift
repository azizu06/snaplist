import SwiftUI
import AVFoundation

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

    /// At Accessibility Dynamic Type, ONB-06's longer listing content must scroll
    /// before its actions rather than share the viewport with a sticky footer.
    private var usesFlowingIncludedFooter: Bool {
        model.screen == .onb06 && dynamicTypeSize.isAccessibilitySize
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
                            : Color(hex: "#E2E4E8"))
                        .frame(height: 4)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Onboarding progress")
            .accessibilityValue("Step \(model.screen.rawValue) of 6")

            if model.screen != .onb06 {
                Button { finish(using: model.skip) } label: {
                    Text("Skip")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(SnapListColorToken.action.color)
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(Rectangle())
                }
                    .accessibilityIdentifier("first-value-onboarding.skip")
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
                highlightedTitle("Priced from jackets that\n", "actually sold.")
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
                        "FirstValueSneaker",
                        label: "A worn sneaker photographed on a plain surface",
                        width: tileWidth
                    )
                    photographTile(
                        "FirstValueJacket",
                        label: "A folded medium wash denim jacket",
                        width: tileWidth
                    )
                    photographTile(
                        "FirstValueLamp",
                        label: "A desk lamp photographed on a plain surface",
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
            Image("FirstValueJacket")
                .resizable()
                .scaledToFill()
                .frame(width: 54, height: 54)
                .clipped()
                .clipShape(RoundedRectangle(cornerRadius: 11))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text("Denim trucker jacket, size M")
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
        .background(.white, in: RoundedRectangle(cornerRadius: 18))
        .overlay {
            RoundedRectangle(cornerRadius: 18)
                .stroke(Color(hex: "#ECEDF0"))
        }
        .shadow(color: .black.opacity(0.08), radius: 14, y: 5)
        .accessibilityElement(children: .combine)
    }

    private var contextScreen: some View {
        VStack(spacing: 0) {
            GeometryReader { proxy in
                let columnWidth = (proxy.size.width - 10) / 2
                HStack(alignment: .top, spacing: 10) {
                    VStack(spacing: 10) {
                        contextPhoto(
                            crop: .whole,
                            caption: "The whole thing",
                            height: 174,
                            width: columnWidth
                        )
                        .accessibilitySortPriority(3)
                        contextPhoto(
                            crop: .flaw,
                            caption: "Any flaws",
                            height: 174,
                            width: columnWidth
                        )
                        .accessibilitySortPriority(2)
                    }
                    contextPhoto(
                        crop: .details,
                        caption: "The details",
                        height: 382,
                        width: columnWidth
                    )
                    .accessibilitySortPriority(1)
                }
            }
            .frame(height: 410)
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
                            .foregroundStyle(.white)
                            .frame(width: 40, height: 40)
                            .background(SnapListColorToken.action.color, in: Circle())
                        FirstValueVoiceWaveform()
                        Spacer(minLength: 0)
                        Text("0:09 / 0:15")
                            .font(.caption.monospacedDigit().weight(.semibold))
                            .foregroundStyle(SnapListColorToken.textSecondary.color)
                            .fixedSize()
                    }
                    Text("“Small mark on the left cuff. Bought it in Tokyo in 2019.”")
                        .font(.subheadline)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Optional. Voice note, 9 seconds of a possible 15. Play. Small mark on the left cuff. Bought it in Tokyo in 2019.")
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
                    soldRow("Excellent, barely worn", "4 days ago", "$66", scale: 1.5, offset: CGSize(width: 2, height: -2))
                    soldRow("Good, light wear", "6 days ago", "$62", scale: 1.6, offset: CGSize(width: -2, height: -3))
                    soldRow("Very good", "2 weeks ago", "$55", scale: 1.9, offset: CGSize(width: 3, height: 2))
                    soldRow("Good, small marks", "3 weeks ago", "$49", scale: 1.4, offset: CGSize(width: -3, height: 3))
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
                itemImage("FirstValueJacket", label: "The jacket in its finished listing")
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
            .background(Color(hex: "#F8FAFF"), in: RoundedRectangle(cornerRadius: 16))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Your draft is ready. Four fields, written from your photos.")

            VStack(spacing: 0) {
                draftEditableRow(
                    "Title",
                    "Medium wash denim trucker jacket, size M",
                    showsTopDivider: false
                )
                draftEditableRow(
                    "Condition",
                    "Good, small mark on left cuff"
                )
                draftPriceRow
                draftEditableRow("Description", "Four paragraphs")
            }
            .background(.white)
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .overlay {
                RoundedRectangle(cornerRadius: 14)
                    .stroke(Color(hex: "#ECEDF0"))
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
            }
            .padding(.top, -16)
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
                .background(Color(hex: "#EEF3FF"), in: RoundedRectangle(cornerRadius: 13))
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
        .background(.white, in: RoundedRectangle(cornerRadius: 14))
        .overlay {
            RoundedRectangle(cornerRadius: 14)
                .stroke(Color(hex: "#ECEDF0"), lineWidth: 1)
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
                Text("No account needed, and you edit every field before anything leaves the app.")
                    .font(.system(size: 13))
                    .foregroundStyle(Color(hex: "#3F4246"))
                    .padding(.leading, 12)
            }
        }
    }

    private var includedListingPreview: some View {
        VStack(spacing: 0) {
            ZStack(alignment: .topLeading) {
                ZStack(alignment: .topLeading) {
                    Image("FirstValueJacket")
                        .resizable()
                        .scaledToFill()
                        .frame(maxWidth: .infinity)
                        .frame(height: 254)
                        .clipped()
                    Text("Included")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.white)
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
                    .accessibilityLabel("The finished listing for the denim jacket")
                    .accessibilityIdentifier("first-value-onboarding.included-photo-preview")
            }
            .frame(maxWidth: .infinity)
            .frame(height: 254)
            .clipped()

            VStack(alignment: .leading, spacing: 6) {
                Text("Medium wash denim trucker jacket, size M")
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
            .padding(.top, 12)
            .padding(.bottom, dynamicTypeSize.isAccessibilitySize ? 14 : 0)
            .frame(maxWidth: .infinity, alignment: .top)
            .frame(height: dynamicTypeSize.isAccessibilitySize ? nil : 67, alignment: .top)
        }
        .background(.white)
        .clipShape(RoundedRectangle(cornerRadius: 18))
        .shadow(color: Color.black.opacity(0.18), radius: 16, y: 10)
    }

    private var footer: some View {
        VStack(spacing: 8) {
            Button(model.screen == .onb06 ? "Start scanning" : "Continue") {
                finish(using: model.continueForward)
            }
            .font(.body.bold())
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, minHeight: 52)
            .background(SnapListColorToken.action.color, in: RoundedRectangle(cornerRadius: 14))
            .accessibilityIdentifier(model.screen == .onb06
                ? "first-value-onboarding.start-scanning"
                : "first-value-onboarding.continue")

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
        .background(.white)
        .overlay(alignment: .top) { Divider() }
    }

    private func finish(using action: () -> Void) {
        action()
        if let outcome = model.outcome { didFinish(outcome) }
    }

    private enum JacketCrop: Equatable { case whole, flaw, details }

    private func contextPhoto(
        crop: JacketCrop,
        caption: String,
        height: CGFloat,
        width: CGFloat
    ) -> some View {
        VStack(spacing: 6) {
            jacketImage(crop)
                .frame(width: width, height: height)
                .clipped()
                .clipShape(RoundedRectangle(cornerRadius: 14))
            HStack(spacing: 5) {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(SnapListColorToken.action.color)
                Text(caption).font(.subheadline.weight(.semibold))
            }
        }
        .frame(width: width)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(caption). \(contextAlt(crop))")
    }

    @ViewBuilder
    private func jacketImage(_ crop: JacketCrop) -> some View {
        if crop == .flaw {
            Image("FirstValueJacket")
                .resizable().scaledToFill()
                .scaleEffect(3, anchor: .bottomLeading)
        } else {
            Image("FirstValueJacket").resizable().scaledToFill()
        }
    }

    private func contextAlt(_ crop: JacketCrop) -> String {
        switch crop {
        case .whole: "The whole jacket, folded and photographed on a plain surface"
        case .flaw: "Close view of the mark on the left cuff"
        case .details: "Close view of the collar, seams and buttons"
        }
    }

    private func itemImage(_ name: String, label: String) -> some View {
        Image(name).resizable().scaledToFit().accessibilityLabel(label)
    }

    private func soldRow(_ title: String, _ subtitle: String, _ price: String, scale: CGFloat, offset: CGSize) -> some View {
        HStack(spacing: 11) {
            ZStack {
                Image("FirstValueJacket").resizable().scaledToFill()
                    .scaleEffect(scale).offset(offset)
            }
            .frame(width: 36, height: 36).clipped()
            .clipShape(RoundedRectangle(cornerRadius: 9))
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.semibold))
                Text("Sold \(subtitle)").font(.caption)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
            }
            Spacer()
            Text(price).font(.body.bold())
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
                    .foregroundStyle(Color(hex: "#55585C"))
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
                    .foregroundStyle(Color(hex: "#55585C"))
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
            .background(.white, in: RoundedRectangle(cornerRadius: 12))
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
        .background(Color(hex: "#F5F7FB"), in: RoundedRectangle(cornerRadius: 15))
        .accessibilityElement(children: .combine)
    }

    private func card<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        content()
            .padding(16)
            .frame(maxWidth: .infinity)
            .background(.white, in: RoundedRectangle(cornerRadius: 18))
            .overlay { RoundedRectangle(cornerRadius: 18).stroke(Color(hex: "#ECEDF0")) }
            .shadow(color: .black.opacity(0.05), radius: 14, y: 5)
    }
}

private struct FirstValueVoiceWaveform: View {
    private let barHeights: [CGFloat] = [
        14, 22, 30, 18, 34, 24, 16, 28, 20, 32, 18, 26, 38, 22, 30, 16,
    ]

    var body: some View {
        HStack(alignment: .center, spacing: 2) {
            ForEach(Array(barHeights.enumerated()), id: \.offset) { _, height in
                Capsule()
                    .fill(SnapListColorToken.action.color)
                    .frame(width: 3, height: height)
            }
        }
        .frame(height: 40)
        .accessibilityHidden(true)
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
                        .fill(Color(hex: "#85A8FF"))
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
        .background(.white, in: RoundedRectangle(cornerRadius: 14))
        .overlay {
            RoundedRectangle(cornerRadius: 14)
                .stroke(Color(hex: "#ECEDF0"), lineWidth: 1)
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
