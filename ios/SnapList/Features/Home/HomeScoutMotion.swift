import SwiftUI
import AVFoundation

enum TrophyWallScout: Equatable {
    case uncertainty
    case recovery

    static let resourceSubdirectory = "HomeScoutMotion"
    static let staticRenderingArgument = "--static-scout-rendering"

    var clipResource: String {
        switch self {
        case .uncertainty:
            "041-seedance-uncertainty-shrug"
        case .recovery:
            "040-seedance-recovery-safe-cue"
        }
    }

    var fallbackResource: String {
        switch self {
        case .uncertainty:
            "07-uncertain"
        case .recovery:
            "09-retry-review"
        }
    }

    var legacyFallbackAsset: String {
        switch self {
        case .uncertainty:
            "ScoutUncertain"
        case .recovery:
            "ScoutRetryReview"
        }
    }

    /// Clip 041 is the accepted 1112:834 frame and must never be squashed into
    /// a square. Clip 040 is the accepted 960:960 frame.
    var canvasAspectRatio: CGFloat {
        switch self {
        case .uncertainty:
            1112.0 / 834.0
        case .recovery:
            1
        }
    }

    func rendering(
        reduceMotion: Bool,
        arguments: [String] = ProcessInfo.processInfo.arguments,
        bundle: Bundle = .main
    ) -> TrophyWallScoutRendering {
        guard let fallbackURL = bundle.url(
            forResource: fallbackResource,
            withExtension: "png",
            subdirectory: Self.resourceSubdirectory
        ) else {
            return .legacyStaticAsset(name: legacyFallbackAsset)
        }

        guard !reduceMotion,
              !arguments.contains(Self.staticRenderingArgument),
              let sourceURL = bundle.url(
                  forResource: clipResource,
                  withExtension: "webm",
                  subdirectory: Self.resourceSubdirectory
              ),
              let runtimeURL = bundle.url(
                  forResource: clipResource,
                  withExtension: "mov",
                  subdirectory: Self.resourceSubdirectory
              ) else {
            return .staticPNG(url: fallbackURL)
        }

        return .acceptedRuntimeDerivative(
            sourceURL: sourceURL,
            url: runtimeURL
        )
    }
}

enum TrophyWallScoutRendering: Equatable {
    case acceptedRuntimeDerivative(sourceURL: URL, url: URL)
    case staticPNG(url: URL)
    case legacyStaticAsset(name: String)
}

struct TrophyWallScoutView: View {
    let scout: TrophyWallScout
    let height: CGFloat
    let accessibilityLabel: String

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            switch scout.rendering(reduceMotion: reduceMotion) {
            case .acceptedRuntimeDerivative(_, let url):
                TrophyWallAcceptedScoutPlayerView(url: url)
            case .staticPNG(let url):
                staticImage(at: url)
            case .legacyStaticAsset(let name):
                Image(name)
                    .resizable()
                    .scaledToFit()
            }
        }
        .frame(
            width: height * scout.canvasAspectRatio,
            height: height
        )
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        .allowsHitTesting(false)
    }

    @ViewBuilder
    private func staticImage(at url: URL) -> some View {
        if let image = UIImage(contentsOfFile: url.path) {
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
        } else {
            Image(scout.legacyFallbackAsset)
                .resizable()
                .scaledToFit()
        }
    }
}

/// Plays an alpha-preserving runtime derivative of one accepted Home Scout
/// WebM. The caller resolves Reduced Motion and `--static-scout-rendering`
/// before this representable is constructed, so those paths create no player.
private struct TrophyWallAcceptedScoutPlayerView: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> TrophyWallScoutPlayerUIView {
        TrophyWallScoutPlayerUIView()
    }

    func updateUIView(_ view: TrophyWallScoutPlayerUIView, context: Context) {
        view.playOnce(url: url)
    }
}

private final class TrophyWallScoutPlayerUIView: UIView {
    private var player: AVPlayer?
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

    func playOnce(url: URL) {
        guard loadedURL != url else { return }
        loadedURL = url

        let player = AVPlayer(url: url)
        player.isMuted = true
        player.actionAtItemEnd = .pause
        playerLayer.player = player
        self.player = player
        player.play()
    }

    deinit {
        player?.pause()
    }
}
