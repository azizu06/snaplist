import SwiftUI

@MainActor
struct FirstValueOnboardingView: View {
    @Bindable var model: FirstValueOnboardingModel
    let forceReducedMotion: Bool
    let usesStaticScoutRendering: Bool
    /// Receives the completion contract #566 consumes, never a bare "done".
    let didFinish: (FirstValueOnboardingOutcome) -> Void

    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @State private var presentsSignIn = false
    @AccessibilityFocusState private var headingIsFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollView {
                VStack(spacing: 18) {
                    title
                        .accessibilityFocused($headingIsFocused)
                    screenContent
                }
                .frame(maxWidth: 420)
                .padding(.horizontal, 24)
                .padding(.top, 8)
                .padding(.bottom, 24)
            }
            .scrollIndicators(.hidden)
            footer
        }
        .background(SnapListColorToken.canvas.color.ignoresSafeArea())
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("first-value-onboarding.state.\(model.screen.identifier)")
        .sheet(isPresented: $presentsSignIn) {
            ReturningSignInSheet { presentsSignIn = false }
        }
        .onAppear { headingIsFocused = true }
        .onChange(of: model.screen) { _, _ in headingIsFocused = true }
    }

    private var reduceMotion: Bool {
        systemReduceMotion || forceReducedMotion
    }

    private var header: some View {
        HStack(spacing: 12) {
            if model.screen != .onb01 && model.screen != .onb06 {
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
                Button("Skip") { finish(using: model.skip) }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .frame(minWidth: 44, minHeight: 44)
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
        .font(.system(.largeTitle, design: .rounded, weight: .bold))
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
        VStack(spacing: 12) {
            HStack(spacing: 9) {
                itemImage("FirstValueSneaker", label: "A worn sneaker photographed on a plain surface")
                itemImage("FirstValueJacket", label: "A folded medium wash denim jacket")
                itemImage("FirstValueLamp", label: "A desk lamp photographed on a plain surface")
            }
            .frame(height: 190)
            card {
                HStack(spacing: 12) {
                    itemImage("FirstValueJacket", label: "")
                        .frame(width: 64, height: 64).accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 5) {
                        Text("Denim trucker jacket, size M").font(.body.weight(.semibold))
                        HStack(spacing: 7) {
                            Text("$58").font(.title2.bold())
                            Text("Good").font(.caption.weight(.semibold))
                                .padding(.horizontal, 7).padding(.vertical, 3)
                                .background(SnapListColorToken.quietFill.color, in: RoundedRectangle(cornerRadius: 6))
                        }
                    }
                    Spacer()
                }
                .accessibilityElement(children: .combine)
            }
            FirstValueScoutView(
                screen: .onb01,
                reduceMotion: reduceMotion,
                usesStaticRendering: usesStaticScoutRendering
            )
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, FirstValueOnboardingScreen.onb01.scout.leadingPull)
        }
    }

    private var contextScreen: some View {
        VStack(spacing: 16) {
            HStack(alignment: .top, spacing: 10) {
                VStack(spacing: 10) {
                    contextPhoto(crop: .whole, caption: "The whole thing", height: 92)
                        .accessibilitySortPriority(3)
                    contextPhoto(crop: .flaw, caption: "Any flaws", height: 92)
                        .accessibilitySortPriority(2)
                }
                contextPhoto(crop: .details, caption: "The details", height: 226)
                    .accessibilitySortPriority(1)
            }
            HStack(spacing: 10) {
                FirstValueScoutView(
                    screen: .onb02,
                    reduceMotion: reduceMotion,
                    usesStaticRendering: usesStaticScoutRendering
                )
                    .padding(.leading, FirstValueOnboardingScreen.onb02.scout.leadingPull)
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 8) {
                        Image(systemName: "play.fill")
                            .foregroundStyle(.white)
                            .frame(width: 38, height: 38)
                            .background(SnapListColorToken.action.color, in: Circle())
                        Image(systemName: "waveform")
                            .foregroundStyle(SnapListColorToken.action.color)
                        Spacer(minLength: 0)
                        Text("0:09 / 0:15")
                            .font(.caption.monospacedDigit().weight(.semibold))
                            .foregroundStyle(SnapListColorToken.textSecondary.color)
                    }
                    Text("“Small mark on the left cuff. Bought it in Tokyo in 2019.”")
                        .font(.subheadline.weight(.medium))
                }
                .padding(14)
                .background(Color(hex: "#F5F7FB"), in: RoundedRectangle(cornerRadius: 16))
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Optional. Voice note, 9 seconds of a possible 15. Play. Small mark on the left cuff. Bought it in Tokyo in 2019.")
        }
    }

    private var pricingScreen: some View {
        VStack(spacing: 12) {
            VStack(spacing: 0) {
                HStack(alignment: .lastTextBaseline, spacing: 12) {
                    Text("$49 to $66").font(.title.bold())
                    Spacer(minLength: 0)
                    Text("Based on sold listings.")
                        .font(.caption)
                        .foregroundStyle(SnapListColorToken.textSecondary.color)
                        .multilineTextAlignment(.trailing)
                }
                .padding(.bottom, 10)
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
                .frame(height: 116)
                .padding(.top, 10)
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
                VStack(spacing: 0) {
                    soldRow("Excellent, barely worn", "4 days ago", "$66", scale: 1.5, offset: CGSize(width: 2, height: -2))
                    soldRow("Good, light wear", "6 days ago", "$62", scale: 1.6, offset: CGSize(width: -2, height: -3))
                    soldRow("Very good", "2 weeks ago", "$55", scale: 1.9, offset: CGSize(width: 3, height: 2))
                    soldRow("Good, small marks", "3 weeks ago", "$49", scale: 1.4, offset: CGSize(width: -3, height: 3))
                }
            }
            ScoutLine(
                screen: .onb03,
                reduceMotion: reduceMotion,
                usesStaticRendering: usesStaticScoutRendering
            ) {
                Text("You can change the price later.")
            }
        }
    }

    private var draftScreen: some View {
        VStack(spacing: 12) {
            HStack(spacing: 12) {
                itemImage("FirstValueJacket", label: "The jacket in its finished listing")
                    .frame(width: 72, height: 72)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Your draft is ready").font(.title3.weight(.semibold))
                    Text("Four fields, written from your photos")
                        .font(.subheadline).foregroundStyle(SnapListColorToken.textSecondary.color)
                }
                Spacer()
            }
            .padding(12)
            .background(Color(hex: "#F8FAFF"), in: RoundedRectangle(cornerRadius: 16))
            card {
                VStack(alignment: .leading, spacing: 12) {
                    draftRow("Title", "Medium wash denim trucker jacket, size M")
                    draftRow("Condition", "Good, small mark on left cuff")
                    VStack(alignment: .leading, spacing: 3) {
                        Text("PRICE").font(.caption2.bold()).foregroundStyle(Color(hex: "#777A80"))
                        HStack(spacing: 7) {
                            Text("$58").strikethrough()
                            Text("$64").fontWeight(.semibold)
                            Text("You set this").foregroundStyle(SnapListColorToken.textSecondary.color)
                        }
                        .font(.subheadline)
                    }
                    .accessibilityElement(children: .combine)
                    draftRow("Description", "Four paragraphs")
                }
            }
            ScoutLine(
                screen: .onb04,
                reduceMotion: reduceMotion,
                usesStaticRendering: usesStaticScoutRendering
            ) {
                Text("Not right? One redo on the same photos is included.")
            }
        }
    }

    private var backgroundScreen: some View {
        VStack(spacing: 12) {
            card {
                VStack(alignment: .leading, spacing: 12) {
                    // ONB-05 illustrates the Trophy Wall; no item exists yet, so the
                    // screen says so and shows no spinner or other live-work claim.
                    Text(FirstValueOnboardingCopy.backgroundExampleCaption)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(SnapListColorToken.textSecondary.color)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    ForEach(
                        Array(FirstValueOnboardingCopy.backgroundExampleRows.enumerated()),
                        id: \.offset
                    ) { index, row in
                        workRow(backgroundExampleImages[index], row.item, row.state)
                    }
                }
            }
            HStack(spacing: 10) {
                tile("camera.fill", "Scan the next one", "No waiting")
                tile("trophy.fill", "Trophy Wall", "Finished listings")
            }
            ScoutLine(
                screen: .onb05,
                reduceMotion: reduceMotion,
                usesStaticRendering: usesStaticScoutRendering
            ) {
                Text("Scout keeps working in the background.")
            }
        }
    }

    private var includedScreen: some View {
        VStack(spacing: 12) {
            card {
                VStack(spacing: 10) {
                    ZStack(alignment: .topLeading) {
                        itemImage("FirstValueJacket", label: "The finished listing for the denim jacket")
                            .frame(maxWidth: .infinity).frame(height: 178).clipped()
                        Text("Included").font(.caption.weight(.bold)).foregroundStyle(.white)
                            .padding(.horizontal, 11).padding(.vertical, 6)
                            .background(SnapListColorToken.action.color, in: Capsule())
                            .padding(10)
                    }
                    Text("Medium wash denim trucker jacket, size M")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity, alignment: .leading)
                    HStack {
                        Text("Ready to review").font(.caption)
                            .foregroundStyle(SnapListColorToken.textSecondary.color)
                        Spacer()
                        Text("$58").font(.body.bold())
                    }
                }
            }
            ScoutLine(
                screen: .onb06,
                reduceMotion: reduceMotion,
                usesStaticRendering: usesStaticScoutRendering
            ) {
                Text("No account needed, and you edit every field before anything leaves the app.")
            }
        }
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
                Button("I already have an account") { presentsSignIn = true }
                    .font(.body.weight(.semibold))
                    .foregroundStyle(SnapListColorToken.action.color)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .accessibilityIdentifier("first-value-onboarding.sign-in")
            }
        }
        .padding(.horizontal, 24)
        .padding(.top, 12)
        .padding(.bottom, 8)
        .background(.white)
        .overlay(alignment: .top) { Divider() }
    }

    private func finish(using action: () -> Void) {
        action()
        if let outcome = model.outcome { didFinish(outcome) }
    }

    private enum JacketCrop: Equatable { case whole, flaw, details }

    private func contextPhoto(crop: JacketCrop, caption: String, height: CGFloat) -> some View {
        VStack(spacing: 6) {
            jacketImage(crop)
                .frame(height: height)
                .clipped()
                .clipShape(RoundedRectangle(cornerRadius: 14))
            HStack(spacing: 5) {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(SnapListColorToken.action.color)
                Text(caption).font(.caption.weight(.semibold))
            }
        }
        .frame(maxWidth: .infinity)
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
        .padding(.vertical, 8)
        .overlay(alignment: .top) { Divider() }
        .accessibilityElement(children: .combine)
    }

    private func draftRow(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label.uppercased()).font(.caption2.bold())
                .foregroundStyle(Color(hex: "#777A80"))
            Text(value).font(.subheadline.weight(.medium))
        }
        .accessibilityElement(children: .combine)
    }

    private var backgroundExampleImages: [String] {
        ["FirstValueJacket", "FirstValueLamp", "FirstValueSneaker"]
    }

    /// An illustrative Trophy Wall row. It carries no `ProgressView`, percentage, or any
    /// other progress affordance: nothing is running while onboarding is on screen, and
    /// SnapList never fabricates progress.
    private func workRow(_ image: String, _ title: String, _ status: String) -> some View {
        HStack(spacing: 10) {
            itemImage(image, label: title).frame(width: 44, height: 44)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.semibold))
                Text(status).font(.caption).foregroundStyle(SnapListColorToken.textSecondary.color)
            }
            Spacer()
        }
        .accessibilityElement(children: .combine)
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
            case .acceptedWebM(let url):
                AcceptedScoutWebMView(
                    url: url,
                    fallbackAsset: screen.scout.fallback
                )
            case .staticFallbackPNG(let asset):
                Image(asset).resizable().scaledToFit()
            }
        }
        .frame(width: max(56, screen.scout.size), height: max(56, screen.scout.size))
        .accessibilityHidden(true)
        .allowsHitTesting(false)
    }
}

/// Plays one accepted Scout clip.
///
/// WebKit is resolved dynamically and only when this view is actually constructed, which
/// `FirstValueOnboardingScreen.scoutRendering` decides. That keeps the framework out of
/// processes that must not load it (the UI-test runner, via `--static-scout-rendering`)
/// while leaving the seller-facing WebM path identical in Debug and Release.
private struct AcceptedScoutWebMView: UIViewRepresentable {
    let url: URL
    let fallbackAsset: String

    func makeUIView(context: Context) -> UIView {
        let container = UIView()
        container.backgroundColor = .clear
        guard let webView = WebKitRuntime.makeConfiguredWebView() else {
            installFallback(in: container)
            return container
        }
        webView.frame = container.bounds
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.isUserInteractionEnabled = false
        if let scrollView = (webView as NSObject).value(forKey: "scrollView")
            as? UIScrollView {
            scrollView.backgroundColor = .clear
            scrollView.isScrollEnabled = false
        }
        container.addSubview(webView)
        context.coordinator.webView = webView
        return container
    }

    func updateUIView(_ view: UIView, context: Context) {
        guard context.coordinator.loadedResource != url,
              let webView = context.coordinator.webView else { return }
        context.coordinator.loadedResource = url
        let html = """
        <meta name='viewport' content='width=device-width,initial-scale=1'>
        <style>*{margin:0}html,body,video{width:100%;height:100%;background:transparent}video{object-fit:contain}</style>
        <video autoplay muted loop playsinline src='\(url.lastPathComponent)'></video>
        """
        _ = (webView as NSObject).perform(
            NSSelectorFromString("loadHTMLString:baseURL:"),
            with: html,
            with: url.deletingLastPathComponent()
        )
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    private func installFallback(in container: UIView) {
        let fallback = UIImageView(image: UIImage(named: fallbackAsset))
        fallback.contentMode = .scaleAspectFit
        fallback.frame = container.bounds
        fallback.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        fallback.isAccessibilityElement = false
        container.addSubview(fallback)
    }

    final class Coordinator {
        weak var webView: UIView?
        var loadedResource: URL?
    }
}

private enum WebKitRuntime {
    private static let frameworkPath =
        "/System/Library/Frameworks/WebKit.framework"

    static func makeConfiguredWebView() -> UIView? {
        guard load(),
              let configurationType =
                NSClassFromString("WKWebViewConfiguration") as? NSObject.Type,
              let webViewType = NSClassFromString("WKWebView") as? NSObject.Type else {
            return nil
        }
        let configuration = configurationType.init()
        configuration.setValue(
            0,
            forKey: "mediaTypesRequiringUserActionForPlayback"
        )
        guard let allocated = class_createInstance(webViewType, 0) as AnyObject? else {
            return nil
        }
        let selector = NSSelectorFromString("initWithFrame:configuration:")
        guard let implementation = class_getMethodImplementation(
            webViewType,
            selector
        ) else {
            return nil
        }
        typealias InitializeWebView = @convention(c) (
            AnyObject,
            Selector,
            CGRect,
            AnyObject
        ) -> Unmanaged<AnyObject>
        let initialize = unsafeBitCast(
            implementation,
            to: InitializeWebView.self
        )
        return initialize(
            allocated,
            selector,
            .zero,
            configuration
        ).takeUnretainedValue() as? UIView
    }

    private static func load() -> Bool {
        if NSClassFromString("WKWebView") != nil {
            return true
        }
        return Bundle(path: frameworkPath)?.load() == true
            && NSClassFromString("WKWebView") != nil
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
