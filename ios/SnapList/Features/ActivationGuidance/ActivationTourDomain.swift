import Foundation

/// Issue #1133. The activation tour the Scout strip draws: six steps, each
/// completed by a real thing the seller does, never by a Next button.
///
/// The order is the owner's flow — camera, photos, start, ready, review,
/// publish — and `allCases` is that order, so the rail and the policy read it
/// from one place.
enum ActivationTourStep: String, CaseIterable, Codable, Equatable, Hashable,
                         Sendable {
    case openScan
    case takePhoto
    case startListing
    case openReadyItem
    case reviewPriceAndDetails
    case publishOrShare
}

/// The things a seller does that finish a step. There is deliberately no
/// `tappedNext`: the tour only ever moves because the app moved.
enum ActivationTourSignal: String, CaseIterable, Equatable, Hashable, Sendable {
    case arrivedOnScan
    case capturedPhoto
    case submittedItem
    case openedListingReview
    case editedListingDetails
    case deliveredToAMarketplace
}

/// Scout's pose for a step. Five poses cover six steps, exactly as option E
/// draws them: the two "go somewhere" steps share the plain standing pose.
enum ActivationTourScoutPose: String, Equatable, Hashable, Sendable {
    case idle
    case holdingPhoto
    case measuring
    case reading
    case delighted

    /// The bundled composition. #1133 adds no mascot art: every pose here is an
    /// asset the app already ships.
    var assetName: String {
        switch self {
        case .idle: "ActivationScoutACT01"
        case .holdingPhoto: "ActivationScoutACT02"
        case .measuring: "ActivationScoutACT02B"
        case .reading: "ScoutReview"
        case .delighted: "FirstValueScoutONB06"
        }
    }
}

extension ActivationTourStep {
    /// One short sentence. The rail carries progress, so the line never does.
    var instruction: String {
        switch self {
        case .openScan: "Tap the camera to start a listing."
        case .takePhoto: "Snap up to five photos."
        case .startListing: "Add a voice note, then start."
        case .openReadyItem: "Tap Review when it's ready."
        case .reviewPriceAndDetails: "Check the price and details."
        case .publishOrShare: "Publish to eBay, or share it."
        }
    }

    /// Where the strip is allowed to appear. A step speaks only on the surface
    /// that holds the control it points at.
    var surface: ActivationGuidanceSurface {
        switch self {
        case .openScan, .openReadyItem: .trophyWall
        case .takePhoto: .scan
        case .startListing: .photoReview
        case .reviewPriceAndDetails, .publishOrShare: .listingReview
        }
    }

    /// The tap that actually advances the app here — not every control the line
    /// mentions. Step three names the voice note but points at Start listing,
    /// because that is the tap that moves the item on.
    var spotlightTarget: ActivationSpotlightTarget {
        switch self {
        case .openScan: .scanEntryControl
        case .takePhoto: .scanShutter
        case .startListing: .photoReviewStartListing
        case .openReadyItem: .trophyWallReadyItem
        case .reviewPriceAndDetails: .listingReviewPrice
        case .publishOrShare: .listingReviewPublish
        }
    }

    /// The one action that finishes this step.
    var completingSignal: ActivationTourSignal {
        switch self {
        case .openScan: .arrivedOnScan
        case .takePhoto: .capturedPhoto
        case .startListing: .submittedItem
        case .openReadyItem: .openedListingReview
        case .reviewPriceAndDetails: .editedListingDetails
        case .publishOrShare: .deliveredToAMarketplace
        }
    }

    var scoutPose: ActivationTourScoutPose {
        switch self {
        case .openScan, .openReadyItem: .idle
        case .takePhoto: .holdingPhoto
        case .startListing: .measuring
        case .reviewPriceAndDetails: .reading
        case .publishOrShare: .delighted
        }
    }

    /// Nothing on screen counts the steps — that is the rail's whole job — so
    /// the count lives here, where only VoiceOver reads it.
    var announcement: String {
        let position = (Self.allCases.firstIndex(of: self) ?? 0) + 1
        return "Step \(position) of \(Self.allCases.count). \(instruction)"
    }
}

/// One segment of the owner's rail.
enum ActivationTourRailSegment: Equatable, Sendable {
    /// Filled: the seller has done this step.
    case completed
    /// The elongated blue pill.
    case current
    /// A small muted dot.
    case remaining
}

/// What the seller has actually done, and how they have chosen to see the
/// strip. Persisted per identity.
struct ActivationTourProgress: Codable, Equatable {
    var completedSteps: Set<ActivationTourStep> = []
    /// From step two the chevron folds the strip down to Scout alone. The
    /// seller's choice, so it is remembered across launches.
    var isCollapsed = false
    /// `Skip tour`, offered on step one only. It ends the tour without
    /// claiming any step happened.
    var isSkipped = false
    /// The closing line is shown exactly once, and only after every step has
    /// been done. Recording it is what makes "never again" true.
    var hasSeenClosingLine = false

    /// Settings → Replay the tour. Back to step one with no remembered
    /// collapse or skip; a replay the seller asked for is a fresh tour.
    mutating func replay() {
        self = .init()
    }

    /// Records a step the seller performed. Returns whether anything changed,
    /// so the caller only writes to the store on a real transition.
    @discardableResult
    mutating func complete(_ step: ActivationTourStep) -> Bool {
        completedSteps.insert(step).inserted
    }

    /// Records the action behind a step. A skipped tour ignores them all:
    /// otherwise a seller who quit on step one would be handed the closing line
    /// for a tour they never took.
    @discardableResult
    mutating func record(_ signal: ActivationTourSignal) -> Bool {
        guard !isSkipped,
              let step = ActivationTourStep.allCases.first(where: {
                  $0.completingSignal == signal
              }) else { return false }
        return complete(step)
    }
}

enum ActivationTourPolicy {
    /// The earliest step still outstanding. A step the seller reached out of
    /// order still counts, so this falls back rather than skipping ahead.
    static func currentStep(
        _ progress: ActivationTourProgress
    ) -> ActivationTourStep? {
        ActivationTourStep.allCases.first {
            !progress.completedSteps.contains($0)
        }
    }

    static func isFinished(_ progress: ActivationTourProgress) -> Bool {
        currentStep(progress) == nil
    }

    /// Whether the tour has nothing left to draw, ever. A finished tour is
    /// retired once its closing line has been seen; a skipped one is retired
    /// immediately.
    static func isRetired(_ progress: ActivationTourProgress) -> Bool {
        progress.isSkipped
            || (isFinished(progress) && progress.hasSeenClosingLine)
    }

    /// The rail, always one segment per step and at most one `.current`.
    static func rail(
        _ progress: ActivationTourProgress
    ) -> [ActivationTourRailSegment] {
        let current = currentStep(progress)
        return ActivationTourStep.allCases.map { step in
            if progress.completedSteps.contains(step) { return .completed }
            return step == current ? .current : .remaining
        }
    }
}

enum ActivationTourCopy {
    /// The end of the tour, in Scout's voice. It is a farewell, not another
    /// instruction, so it stands on its own rather than inside the strip.
    static let closingLine = "You have got it. I will stay out of your way."
}

/// Everything the strip needs to draw itself for one step. The view decides
/// nothing.
struct ActivationTourStripModel: Equatable {
    let step: ActivationTourStep
    let rail: [ActivationTourRailSegment]
    /// Step one only: quit now, or stop being offered the choice.
    let showsSkip: Bool
    /// Step two onward: fold down to Scout rather than quit.
    let showsCollapseChevron: Bool
}

enum ActivationTourPresentation: Equatable {
    case hidden
    case strip(ActivationTourStripModel)
    case collapsedBubble(pose: ActivationTourScoutPose)
    case closingLine(String)
}

enum ActivationTourPresentationPolicy {
    /// `isEligible` is the shell's answer to a question the tour cannot see:
    /// onboarding, the server completion marker, and whether authentication has
    /// resolved. When it is false nothing draws, whatever the record says.
    static func presentation(
        progress: ActivationTourProgress,
        surface: ActivationGuidanceSurface?,
        isEligible: Bool
    ) -> ActivationTourPresentation {
        guard isEligible, !progress.isSkipped else { return .hidden }

        guard let step = ActivationTourPolicy.currentStep(progress) else {
            // Every step done. One farewell, wherever the seller happens to be,
            // then silence.
            return progress.hasSeenClosingLine
                ? .hidden
                : .closingLine(ActivationTourCopy.closingLine)
        }

        guard surface == step.surface else { return .hidden }
        guard !progress.isCollapsed else {
            return .collapsedBubble(pose: step.scoutPose)
        }
        return .strip(
            .init(
                step: step,
                rail: ActivationTourPolicy.rail(progress),
                showsSkip: step == ActivationTourStep.allCases.first,
                showsCollapseChevron: step != ActivationTourStep.allCases.first
            )
        )
    }
}

protocol ActivationTourProgressPersisting: AnyObject {
    func load(for identity: String) -> ActivationTourProgress
    func save(_ progress: ActivationTourProgress, for identity: String)
    func clear(for identity: String)
}

final class UserDefaultsActivationTourProgressStore:
    ActivationTourProgressPersisting {
    private let defaults: UserDefaults
    private let prefix: String
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    /// A new key space rather than a migration of the retired coach-mark
    /// record: the two carry different facts, and a half-decoded spine position
    /// would land a seller mid-tour on a step they never saw.
    static let keyPrefix = "snaplist.activation-tour-progress-v1."

    init(
        defaults: UserDefaults = .standard,
        prefix: String = keyPrefix
    ) {
        self.defaults = defaults
        self.prefix = prefix
    }

    /// Takes back every principal's record. Sign-out and account erasure are
    /// the points at which nobody on this device has a claim on a half-finished
    /// tour of someone else's first listing. Retention row
    /// `local-activation-tour-progress`; called from
    /// `SettingsLocalCachedDataStore.removeAll()`, which is the one owner for
    /// wiping local per-account state.
    @discardableResult
    static func removeAll(defaults: UserDefaults = .standard) -> Bool {
        for key in defaults.dictionaryRepresentation().keys
        where key.hasPrefix(keyPrefix) {
            defaults.removeObject(forKey: key)
        }
        return true
    }

    func load(for identity: String) -> ActivationTourProgress {
        guard let data = defaults.data(forKey: key(for: identity)),
              let progress = try? decoder.decode(
                ActivationTourProgress.self,
                from: data
              ) else { return .init() }
        return progress
    }

    func save(_ progress: ActivationTourProgress, for identity: String) {
        defaults.set(try? encoder.encode(progress), forKey: key(for: identity))
    }

    func clear(for identity: String) {
        defaults.removeObject(forKey: key(for: identity))
    }

    private func key(for identity: String) -> String {
        "\(prefix)\(identity)"
    }
}

// MARK: - The spotlight halo

/// The shape the glow takes, which is the control's own.
enum ActivationSpotlightHaloShape: Equatable, Sendable {
    case circle
    case roundedRectangle(cornerRadius: CGFloat)
}

struct ActivationSpotlightHalo: Equatable, Sendable {
    let frame: CGRect
    let shape: ActivationSpotlightHaloShape
}

/// #1133 replaces the dimming cutout with a glow on the control itself. There
/// is no scrim and no hit gate, so this answers one question only: where to
/// draw, given where the control actually is right now. A control with no
/// reported frame — not laid out, scrolled away, behind a sheet — gets nothing,
/// which is also what keeps the promise that the tour never covers anything.
enum ActivationSpotlightHaloPolicy {
    /// How far the glow sits outside the control's own bounds.
    static let padding: CGFloat = 4
    /// The corner radius a rectangular control's halo falls back to. Clamped
    /// to half the short side so a small control reads as a capsule rather
    /// than as a square with clipped corners.
    static let cornerRadius: CGFloat = 16

    static func halo(
        for target: ActivationSpotlightTarget,
        targetFrame: CGRect?,
        bounds: CGRect
    ) -> ActivationSpotlightHalo? {
        guard let targetFrame,
              !targetFrame.isEmpty,
              !bounds.isEmpty,
              targetFrame.intersects(bounds) else { return nil }

        let frame = targetFrame.insetBy(dx: -padding, dy: -padding)
        return .init(frame: frame, shape: shape(for: target, frame: frame))
    }

    private static func shape(
        for target: ActivationSpotlightTarget,
        frame: CGRect
    ) -> ActivationSpotlightHaloShape {
        if target.isRound { return .circle }
        return .roundedRectangle(
            cornerRadius: min(cornerRadius, min(frame.width, frame.height) / 2)
        )
    }
}
