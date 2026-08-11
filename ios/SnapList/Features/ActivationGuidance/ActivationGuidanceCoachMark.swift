import SwiftUI
import WebKit

struct ActivationGuidanceCoachMark: View {
    let coachMark: ActivationCoachMark
    let dismiss: () -> Void
    let isCompleting: Bool
    let usesStaticScoutRendering: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            if anchor.tailEdge == .top {
                tail
            }

            bubble

            if anchor.tailEdge == .bottom {
                tail
            }
        }
        .fixedSize(horizontal: false, vertical: false)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Guidance. \(coachMark.copy)")
        .accessibilityIdentifier("activation-guidance")
        .accessibilityAddTraits(.isSummaryElement)
    }

    private var bubble: some View {
        HStack(spacing: 12) {
            scout

            Text(coachMark.copy)
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(coachMark.isDarkSurface ? .white : SnapListColorToken.inkPrimary.color)
                .fixedSize(horizontal: false, vertical: true)

            Button(action: dismiss) {
                Text("Got it")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(dismissalColor)
                    // The label owns its target so UIKit exposes the full
                    // 44-point button frame to accessibility clients.
                    .frame(
                        width: SnapListMetrics.minimumTouchTarget,
                        height: SnapListMetrics.minimumTouchTarget
                    )
                    .contentShape(.rect)
            }
                .accessibilityLabel("Got it")
                .accessibilityHint(
                    "Shows the next tip when one remains."
                )
                .accessibilityIdentifier("activation-guidance.got-it")
                .disabled(isCompleting)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(background)
        .clipShape(.rect(cornerRadius: 16))
        .overlay {
            RoundedRectangle(cornerRadius: 16)
                .stroke(borderColor, lineWidth: 1)
        }
    }

    /// The one anchor contract, shared by the normal and Reduced Motion
    /// compositions: Activation v1.1 keeps the tail as the anchor in both.
    var anchor: ActivationCoachMarkAnchor {
        ActivationCoachMarkAnchorPolicy.anchor(
            for: coachMark,
            reduceMotion: reduceMotion
        )
    }

    /// Half of the rotated square overlaps the bubble edge it sits on, so the
    /// visible tail reads as one shape with the bubble rather than a detached
    /// diamond.
    private var tail: some View {
        Rectangle()
            .fill(tailColor)
            .frame(width: 12, height: 12)
            .rotationEffect(.degrees(45))
            .offset(
                x: anchor.tailHorizontalOffset,
                y: anchor.tailEdge == .top ? 6 : -6
            )
            .accessibilityHidden(true)
    }

    private var dismissalColor: Color {
        // ACT-01 and ACT-06 sit on dark frosted camera glass. #7CA0FF is the
        // approved 6.9:1 exception; #3665F3 fails the 4.5:1 text floor there.
        coachMark.isDarkSurface ? Color(hex: "#7CA0FF") : Color(hex: "#3665F3")
    }

    @ViewBuilder
    private var scout: some View {
        switch ActivationGuidanceAssetPolicy.rendering(
            for: coachMark.state,
            reduceMotion: reduceMotion,
            usesStaticRendering: usesStaticScoutRendering
        ) {
        case .none:
            EmptyView()
        case .acceptedWebM(let url):
            ActivationScoutMotionView(url: url)
                .frame(width: 56, height: 56)
                .accessibilityHidden(true)
        case .staticFallbackPNG(let asset):
            Image(asset)
                .resizable()
                .scaledToFit()
                .frame(width: 56, height: 56)
                .accessibilityHidden(true)
        }
    }

    private var background: some ShapeStyle {
        coachMark.isDarkSurface
            ? AnyShapeStyle(Color(hex: "#1A1B20"))
            : AnyShapeStyle(Color.white)
    }

    private var tailColor: Color {
        coachMark.isDarkSurface ? Color(hex: "#24262A").opacity(0.82) : .white
    }

    private var borderColor: Color {
        coachMark.isDarkSurface ? .white.opacity(0.16) : Color.black.opacity(0.08)
    }
}

private struct ActivationScoutMotionView: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        view.scrollView.isScrollEnabled = false
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        guard context.coordinator.loadedResource != url else { return }
        context.coordinator.loadedResource = url
        view.loadHTMLString(
            "<style>html,body,video{margin:0;width:100%;height:100%;background:transparent;object-fit:contain}</style><video autoplay muted loop playsinline src='\(url.lastPathComponent)'></video>",
            baseURL: url.deletingLastPathComponent()
        )
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator {
        var loadedResource: URL?
    }
}
