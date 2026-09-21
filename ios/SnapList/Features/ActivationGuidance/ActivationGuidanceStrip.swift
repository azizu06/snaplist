import SwiftUI

// MARK: - Metrics

/// Option E's measurements, stated once. The strip floats above the bottom
/// controls; Scout hangs off its leading edge with no box of his own.
enum ActivationTourStripMetrics {
    static let height: CGFloat = 68
    static let horizontalMargin: CGFloat = 12
    static let cornerRadius: CGFloat = 18
    static let scoutSize: CGFloat = 52
    /// How far Scout overlaps the strip's leading edge and its top.
    static let scoutLeadingOverlap: CGFloat = -14
    static let scoutTopOverlap: CGFloat = -10
    static let collapsedDiameter: CGFloat = 58
    static let collapsedScoutSize: CGFloat = 42
    /// The gap the strip keeps above whatever is docked below it, so it never
    /// covers the camera entry, a primary action, or the last Trophy Wall row.
    static let bottomGap: CGFloat = 12

    /// What the surface underneath has to keep clear for the strip. Surfaces
    /// that scroll add this to their bottom content inset.
    static func clearance(isStripVisible: Bool) -> CGFloat {
        isStripVisible ? height + bottomGap : 0
    }
}

/// The owner's rail: separated short segments, the current one an elongated
/// pill, the rest small dots.
enum ActivationTourRailMetrics {
    static let dotDiameter: CGFloat = 6
    static let currentWidth: CGFloat = 16
    static let spacing: CGFloat = 5
}

// MARK: - The rail

struct ActivationTourRail: View {
    let segments: [ActivationTourRailSegment]
    let prefersDark: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: ActivationTourRailMetrics.spacing) {
            ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                Capsule(style: .continuous)
                    .fill(fill(segment))
                    .frame(
                        width: segment == .current
                            ? ActivationTourRailMetrics.currentWidth
                            : ActivationTourRailMetrics.dotDiameter,
                        height: ActivationTourRailMetrics.dotDiameter
                    )
            }
        }
        .animation(
            reduceMotion ? nil : .easeOut(duration: 0.25),
            value: segments
        )
        // The rail is the visual half of a fact the strip already announces as
        // "Step 2 of 6", so it never speaks for itself.
        .accessibilityHidden(true)
    }

    private func fill(_ segment: ActivationTourRailSegment) -> Color {
        switch segment {
        case .current:
            SnapListColorToken.action.color
        case .completed:
            SnapListColorToken.action.color.opacity(prefersDark ? 0.55 : 0.4)
        case .remaining:
            prefersDark
                ? SnapListColorToken.onDarkSurface.color.opacity(0.18)
                : SnapListColorToken.progressTrackInactive.color
        }
    }
}

// MARK: - Scout

/// The real Scout composition for a pose, with option E's gentle bob and the
/// brief happy beat when a step is completed. Both stop under Reduced Motion,
/// which leaves the same pose standing still.
struct ActivationTourScoutImage: View {
    let pose: ActivationTourScoutPose
    let size: CGFloat
    /// Changes whenever the seller finishes a step, which is what triggers the
    /// beat. Kept separate from `pose` because two steps share a pose.
    var beatToken: AnyHashable = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isBobbing = false
    @State private var beatScale: CGFloat = 1

    var body: some View {
        Image(pose.assetName)
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .scaleEffect(beatScale)
            .offset(y: isBobbing ? -3 : 0)
            .shadow(color: .black.opacity(0.28), radius: 8, y: 6)
            .accessibilityHidden(true)
            .onAppear(perform: startBobbing)
            .onChange(of: reduceMotion) { _, _ in startBobbing() }
            .onChange(of: beatToken) { _, _ in playHappyBeat() }
    }

    private func startBobbing() {
        guard !reduceMotion else {
            isBobbing = false
            return
        }
        withAnimation(.easeInOut(duration: 2.6).repeatForever(autoreverses: true)) {
            isBobbing = true
        }
    }

    private func playHappyBeat() {
        guard !reduceMotion else { return }
        withAnimation(.spring(response: 0.22, dampingFraction: 0.45)) {
            beatScale = 1.14
        }
        withAnimation(.spring(response: 0.34, dampingFraction: 0.6).delay(0.16)) {
            beatScale = 1
        }
    }
}

// MARK: - The strip

struct ActivationTourStrip: View {
    let model: ActivationTourStripModel
    let skip: () -> Void
    let collapse: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var prefersDark: Bool { model.step.prefersDarkSurface }

    var body: some View {
        HStack(spacing: 0) {
            ActivationTourScoutImage(
                pose: model.step.scoutPose,
                size: ActivationTourStripMetrics.scoutSize,
                beatToken: model.step
            )
            .padding(.leading, ActivationTourStripMetrics.scoutLeadingOverlap)
            .padding(.top, ActivationTourStripMetrics.scoutTopOverlap)

            VStack(alignment: .leading, spacing: 6) {
                Text(model.step.instruction)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(textColor)
                    .lineLimit(2)
                    .minimumScaleFactor(0.85)
                    .fixedSize(horizontal: false, vertical: true)

                ActivationTourRail(
                    segments: model.rail,
                    prefersDark: prefersDark
                )
            }
            .padding(.horizontal, 8)
            .frame(maxWidth: .infinity, alignment: .leading)

            trailingControl
        }
        .padding(.trailing, 10)
        .frame(minHeight: ActivationTourStripMetrics.height)
        .background(background)
        .clipShape(
            .rect(cornerRadius: ActivationTourStripMetrics.cornerRadius)
        )
        .overlay {
            RoundedRectangle(
                cornerRadius: ActivationTourStripMetrics.cornerRadius,
                style: .continuous
            )
            .stroke(borderColor, lineWidth: 1)
        }
        .shadow(color: .black.opacity(prefersDark ? 0.4 : 0.14), radius: 18, y: 10)
        // Read as one region, with the count no pixel on screen carries.
        .accessibilityElement(children: .contain)
        .accessibilityLabel(model.step.announcement)
        .accessibilityAddTraits(.isSummaryElement)
        .accessibilityIdentifier("activation-tour.strip")
        .transition(
            reduceMotion
                ? .opacity
                : .opacity.combined(with: .move(edge: .bottom))
        )
    }

    @ViewBuilder
    private var trailingControl: some View {
        if model.showsSkip {
            Button(action: skip) {
                Text("Skip tour")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(
                        prefersDark
                            ? SnapListColorToken.actionOnDark.color
                            : SnapListColorToken.action.color
                    )
                    .frame(minWidth: SnapListMetrics.minimumTouchTarget)
                    .frame(height: SnapListMetrics.minimumTouchTarget)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Skip tour")
            .accessibilityHint("Ends the guide. It will not come back.")
            .accessibilityIdentifier("activation-tour.skip")
        } else if model.showsCollapseChevron {
            Button(action: collapse) {
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(
                        prefersDark
                            ? SnapListColorToken.onDarkSurface.color.opacity(0.6)
                            : SnapListColorToken.textTertiary.color
                    )
                    .frame(
                        width: SnapListMetrics.minimumTouchTarget,
                        height: SnapListMetrics.minimumTouchTarget
                    )
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Collapse the guide")
            .accessibilityHint("Leaves Scout on screen. Tap Scout to reopen.")
            .accessibilityIdentifier("activation-tour.collapse")
        }
    }

    private var background: some ShapeStyle {
        prefersDark
            ? AnyShapeStyle(SnapListColorToken.coachMarkDarkFill.color)
            : AnyShapeStyle(SnapListColorToken.canvas.color)
    }

    private var textColor: Color {
        prefersDark
            ? SnapListColorToken.onDarkSurface.color
            : SnapListColorToken.inkPrimary.color
    }

    private var borderColor: Color {
        prefersDark
            ? SnapListColorToken.onDarkSurface.color.opacity(0.1)
            : SnapListColorToken.hairline.color
    }
}

// MARK: - Collapsed

/// What the chevron leaves behind: Scout alone, still in the current pose, and
/// still the way back to the strip.
struct ActivationTourCollapsedBubble: View {
    let pose: ActivationTourScoutPose
    let prefersDark: Bool
    let expand: () -> Void

    var body: some View {
        Button(action: expand) {
            ActivationTourScoutImage(
                pose: pose,
                size: ActivationTourStripMetrics.collapsedScoutSize
            )
            .frame(
                width: ActivationTourStripMetrics.collapsedDiameter,
                height: ActivationTourStripMetrics.collapsedDiameter
            )
            .background(
                prefersDark
                    ? SnapListColorToken.coachMarkDarkFill.color
                    : SnapListColorToken.canvas.color,
                in: .circle
            )
            .overlay {
                Circle().stroke(
                    prefersDark
                        ? SnapListColorToken.onDarkSurface.color.opacity(0.12)
                        : SnapListColorToken.hairline.color,
                    lineWidth: 1
                )
            }
            .shadow(color: .black.opacity(prefersDark ? 0.4 : 0.14), radius: 16, y: 8)
            .contentShape(.circle)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Scout")
        .accessibilityHint("Reopens the guide for this step.")
        .accessibilityIdentifier("activation-tour.collapsed")
    }
}

// MARK: - The closing line

/// The end of the tour: one line, once, then nothing ever again.
struct ActivationTourClosingLine: View {
    let line: String
    let prefersDark: Bool

    var body: some View {
        Text(line)
            .font(.system(size: 13, weight: .semibold))
            .multilineTextAlignment(.center)
            .foregroundStyle(
                prefersDark
                    ? SnapListColorToken.onDarkSurface.color
                    : SnapListColorToken.inkPrimary.color
            )
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(
                prefersDark
                    ? SnapListColorToken.coachMarkDarkFill.color
                    : SnapListColorToken.canvas.color,
                in: .rect(cornerRadius: 14)
            )
            .shadow(color: .black.opacity(prefersDark ? 0.4 : 0.14), radius: 16, y: 8)
            .accessibilityElement()
            .accessibilityLabel(line)
            .accessibilityIdentifier("activation-tour.closing-line")
    }
}

// MARK: - The spotlight

/// The glow itself. Nothing is dimmed and nothing is intercepted: this is a
/// non-interactive halo drawn over the control's own frame, so every other
/// control on the screen stays exactly as tappable as it was.
struct ActivationSpotlightHaloView: View {
    let halo: ActivationSpotlightHalo
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isPulsing = false

    var body: some View {
        ZStack {
            shape
                .stroke(
                    SnapListColorToken.action.color.opacity(
                        isPulsing ? 0.12 : 0.26
                    ),
                    lineWidth: isPulsing ? 14 : 9
                )
            shape
                .stroke(
                    SnapListColorToken.action.color.opacity(0.95),
                    lineWidth: isPulsing ? 3.5 : 2.5
                )
        }
        .frame(width: halo.frame.width, height: halo.frame.height)
        .position(x: halo.frame.midX, y: halo.frame.midY)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onAppear(perform: startPulsing)
        .onChange(of: reduceMotion) { _, _ in startPulsing() }
    }

    private var shape: AnyShape {
        switch halo.shape {
        case .circle:
            AnyShape(Circle())
        case .roundedRectangle(let cornerRadius):
            AnyShape(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            )
        }
    }

    /// Reduced Motion keeps the highlight and drops the breathing: the outline
    /// stays at its resting weight rather than freezing mid-pulse.
    private func startPulsing() {
        guard !reduceMotion else {
            isPulsing = false
            return
        }
        withAnimation(.easeInOut(duration: 1.8).repeatForever(autoreverses: true)) {
            isPulsing = true
        }
    }
}

// MARK: - Surface tone

extension ActivationTourStep {
    /// The Scan camera is the one dark surface the tour speaks on.
    var prefersDarkSurface: Bool { surface == .scan }
}
