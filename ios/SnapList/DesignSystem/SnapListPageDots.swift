import SwiftUI

/// The page dots #883 built for the Photo Review hero, extracted so Listing
/// Review's photo pager shows a photo count the same way rather than growing a
/// second one. The geometry is #883's, measured off
/// `facebook-page-dots-reference.png`: a small scrim capsule of dots sitting on
/// the photo just above its bottom edge, centered on its horizontal axis. The
/// dots are deliberately smaller than a `UIPageControl`'s, because the
/// reference reads as a quiet marker on the photo rather than a control
/// competing with it.
///
/// It is a marker, not a control. It never hit-tests, so the host's own tap and
/// swipe pass straight through it, and it never carries the burden of naming
/// the position when the host already does that somewhere a screen reader will
/// reach first.
struct SnapListPageDots: View {
    enum Metrics {
        static let dotSize: CGFloat = 6
        static let dotSpacing: CGFloat = 4
        static let horizontalPadding: CGFloat = 7
        static let verticalPadding: CGFloat = 5
        /// How far the row sits off the bottom edge of the photo it marks.
        /// Placement rather than geometry, but both hosts want the same
        /// distance, so it lives here and neither carries its own number.
        static let bottomInset: CGFloat = 12
        static let scrimOpacity: Double = 0.55
        static let inactiveDotOpacity: Double = 0.45
    }

    let pageCount: Int
    let selectedIndex: Int
    /// What VoiceOver should read for the whole row, or `nil` where the host
    /// already labels each page and a second reading would only repeat it.
    /// Listing Review labels every photo `Photo 1 of 2, cover`, so it passes
    /// `nil`; Photo Review's hero does not, so it passes a label.
    var accessibilityLabel: String?

    /// One dot per page, `true` for the page the host is showing. Pure so the
    /// count and the fill can be asserted without standing a view up.
    static func filledStates(pageCount: Int, selectedIndex: Int) -> [Bool] {
        guard pageCount > 0 else { return [] }
        return (0..<pageCount).map { $0 == selectedIndex }
    }

    /// Dots report which of several pages is up. A lone dot over a single photo
    /// is decoration, so the row withholds itself exactly where the host has
    /// nowhere to go.
    static func isVisible(pageCount: Int) -> Bool {
        pageCount > 1
    }

    var body: some View {
        if Self.isVisible(pageCount: pageCount) {
            HStack(spacing: Metrics.dotSpacing) {
                ForEach(
                    Array(
                        Self.filledStates(
                            pageCount: pageCount,
                            selectedIndex: selectedIndex
                        ).enumerated()
                    ),
                    id: \.offset
                ) { _, filled in
                    Circle()
                        .fill(
                            SnapListColorToken.onDarkSurface.color.opacity(
                                filled ? 1 : Metrics.inactiveDotOpacity
                            )
                        )
                        .frame(
                            width: Metrics.dotSize,
                            height: Metrics.dotSize
                        )
                }
            }
            .padding(.horizontal, Metrics.horizontalPadding)
            .padding(.vertical, Metrics.verticalPadding)
            .background(
                SnapListColorToken.scrimOverlay.color.opacity(
                    Metrics.scrimOpacity
                ),
                in: Capsule()
            )
            .allowsHitTesting(false)
            .accessibilityElement(children: .ignore)
            .modifier(SnapListPageDotsVoice(label: accessibilityLabel))
        }
    }
}

/// A row that names itself reads as one element; a row the host has already
/// named leaves the screen reader alone entirely.
private struct SnapListPageDotsVoice: ViewModifier {
    let label: String?

    func body(content: Content) -> some View {
        if let label {
            content.accessibilityLabel(label)
        } else {
            content.accessibilityHidden(true)
        }
    }
}
