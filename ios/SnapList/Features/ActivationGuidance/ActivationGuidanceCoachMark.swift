import SwiftUI
import WebKit

struct ActivationGuidanceCoachMark: View {
    let coachMark: ActivationCoachMark
    let dismiss: () -> Void
    let skip: () -> Void
    let isCompleting: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                scout

                Text(coachMark.copy)
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(coachMark.isDarkSurface ? .white : SnapListColorToken.inkPrimary.color)
                    .fixedSize(horizontal: false, vertical: true)

                Button("Got it", action: dismiss)
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(dismissalColor)
                    .frame(
                        minWidth: SnapListMetrics.minimumTouchTarget,
                        minHeight: SnapListMetrics.minimumTouchTarget
                    )
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

            Rectangle()
                .fill(tailColor)
                .frame(width: 12, height: 12)
                .rotationEffect(.degrees(45))
                .offset(y: -6)
                .accessibilityHidden(true)
        }
        .fixedSize(horizontal: false, vertical: false)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Guidance. \(coachMark.copy)")
        .accessibilityAction(named: "Skip guidance") {
            skip()
        }
        .accessibilityHint(
            "Swipe down to skip all guidance."
        )
        .accessibilityIdentifier("activation-guidance")
        .accessibilityAddTraits(.isSummaryElement)
        .gesture(
            DragGesture(minimumDistance: 24)
                .onEnded { value in
                    guard value.translation.height >= 24 else { return }
                    skip()
                }
        )
    }

    private var dismissalColor: Color {
        // ACT-01 and ACT-06 sit on dark frosted camera glass. #7CA0FF is the
        // approved 6.9:1 exception; #3665F3 fails the 4.5:1 text floor there.
        coachMark.isDarkSurface ? Color(hex: "#7CA0FF") : Color(hex: "#3665F3")
    }

    @ViewBuilder
    private var scout: some View {
        if !reduceMotion, let resource = coachMark.motionResourceName {
            ActivationScoutMotionView(resourceName: resource)
                .frame(width: 56, height: 56)
                .accessibilityHidden(true)
        } else {
            Image(coachMark.scoutImageName)
                .resizable()
                .scaledToFit()
                .frame(width: 56, height: 56)
                .accessibilityHidden(true)
        }
    }

    private var background: some ShapeStyle {
        coachMark.isDarkSurface ? AnyShapeStyle(.ultraThinMaterial) : AnyShapeStyle(Color.white)
    }

    private var tailColor: Color {
        coachMark.isDarkSurface ? Color(hex: "#24262A").opacity(0.82) : .white
    }

    private var borderColor: Color {
        coachMark.isDarkSurface ? .white.opacity(0.16) : Color.black.opacity(0.08)
    }
}

private struct ActivationScoutMotionView: UIViewRepresentable {
    let resourceName: String

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
        guard context.coordinator.loadedResource != resourceName,
              let url = Bundle.main.url(
                  forResource: resourceName,
                  withExtension: "webm",
                  subdirectory: "ActivationGuidance"
              ) else { return }
        context.coordinator.loadedResource = resourceName
        view.loadHTMLString(
            "<style>html,body,video{margin:0;width:100%;height:100%;background:transparent;object-fit:contain}</style><video autoplay muted loop playsinline src='\(url.lastPathComponent)'></video>",
            baseURL: url.deletingLastPathComponent()
        )
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator {
        var loadedResource: String?
    }
}
