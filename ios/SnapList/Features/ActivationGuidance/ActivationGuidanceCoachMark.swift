import SwiftUI
import AVFoundation

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
    /// The accepted WebM remains the provenance URL selected by the domain
    /// policy. AVFoundation plays its same-basename HEVC-alpha derivative.
    let url: URL

    func makeUIView(context: Context) -> ActivationScoutPlayerUIView {
        ActivationScoutPlayerUIView()
    }

    func updateUIView(
        _ view: ActivationScoutPlayerUIView,
        context: Context
    ) {
        view.play(
            url: url.deletingPathExtension().appendingPathExtension("mov")
        )
    }
}

private final class ActivationScoutPlayerUIView: UIView {
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
        isUserInteractionEnabled = false
        isAccessibilityElement = false
        accessibilityElementsHidden = true
        playerLayer.backgroundColor = UIColor.clear.cgColor
        playerLayer.videoGravity = .resizeAspect
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func play(url: URL) {
        guard loadedURL != url else {
            player?.play()
            return
        }
        loadedURL = url

        let player = AVQueuePlayer()
        player.isMuted = true
        let looper = AVPlayerLooper(
            player: player,
            templateItem: AVPlayerItem(url: url)
        )
        playerLayer.player = player
        self.player = player
        self.looper = looper
        player.play()
    }

    deinit {
        player?.pause()
    }
}
