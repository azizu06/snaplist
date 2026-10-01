import SwiftUI
import AVFoundation

/// The clips after `recovery` are reused from the folder their own screen
/// already bundles rather than duplicated into `HomeScoutMotion`, so the wall
/// carries no second copy of any source clip (#1051).
enum TrophyWallScout: Equatable {
    case uncertainty
    case recovery
    /// Empty Flips. Clip 032, bundled for ONB-03: scanning is the one thing
    /// to do on an empty wall.
    case barcodeScan
    /// Empty To list. Clip act-04, bundled for activation guidance: nothing
    /// is waiting on the seller.
    case thumbsUp
    /// To list while anything is still being worked on. Clip 007, bundled
    /// for ONB-02.
    case inspection
    /// To list once everything is ready to review. Clip 030, bundled for
    /// ONB-05.
    case boxLift

    static let staticRenderingArgument = "--static-scout-rendering"

    var resourceSubdirectory: String {
        switch self {
        case .uncertainty, .recovery:
            "HomeScoutMotion"
        case .barcodeScan, .inspection, .boxLift:
            "FirstValueOnboarding"
        case .thumbsUp:
            "ActivationGuidance"
        }
    }

    var clipResource: String {
        switch self {
        case .uncertainty:
            "041-seedance-uncertainty-shrug"
        case .recovery:
            "040-seedance-recovery-safe-cue"
        case .barcodeScan:
            "032-seedance-barcode-scan"
        case .thumbsUp:
            "act-04"
        case .inspection:
            "007-seedance-magnifier-inspection"
        case .boxLift:
            "030-seedance-box-lower-lift-hflip-candidate"
        }
    }

    /// The reused clips ship no loose PNG. Their still is the asset-catalog
    /// image their own screen already shows under Reduced Motion.
    var fallbackResource: String? {
        switch self {
        case .uncertainty:
            "07-uncertain"
        case .recovery:
            "09-retry-review"
        case .barcodeScan, .thumbsUp, .inspection, .boxLift:
            nil
        }
    }

    var legacyFallbackAsset: String {
        switch self {
        case .uncertainty:
            "ScoutUncertain"
        case .recovery:
            "ScoutRetryReview"
        case .barcodeScan:
            "FirstValueScoutONB03"
        case .thumbsUp:
            "ActivationScoutACT04"
        case .inspection:
            "FirstValueScoutONB02"
        case .boxLift:
            "FirstValueScoutONB05"
        }
    }

    /// Clip 041 is the accepted 1112:834 frame and must never be squashed into
    /// a square. Every other clip is the accepted 960:960 frame.
    var canvasAspectRatio: CGFloat {
        switch self {
        case .uncertainty:
            1112.0 / 834.0
        case .recovery, .barcodeScan, .thumbsUp, .inspection, .boxLift:
            1
        }
    }

    func rendering(
        reduceMotion: Bool,
        arguments: [String] = ProcessInfo.processInfo.arguments,
        bundle: Bundle = .main
    ) -> TrophyWallScoutRendering {
        let stillRendering: TrophyWallScoutRendering
        if let fallbackResource {
            guard let fallbackURL = bundle.url(
                forResource: fallbackResource,
                withExtension: "png",
                subdirectory: resourceSubdirectory
            ) else {
                return .legacyStaticAsset(name: legacyFallbackAsset)
            }
            stillRendering = .staticPNG(url: fallbackURL)
        } else {
            stillRendering = .legacyStaticAsset(name: legacyFallbackAsset)
        }

        guard !reduceMotion,
              !arguments.contains(Self.staticRenderingArgument),
              let sourceURL = bundle.url(
                  forResource: clipResource,
                  withExtension: "webm",
                  subdirectory: resourceSubdirectory
              ),
              let runtimeURL = bundle.url(
                  forResource: clipResource,
                  withExtension: "mov",
                  subdirectory: resourceSubdirectory
              ) else {
            return stillRendering
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
