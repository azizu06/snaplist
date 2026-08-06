import Foundation

enum ActivationPresentationPolicy {
    static func shouldPresent(
        hasOnboarded: Bool,
        hasCompletedActivation: Bool
    ) -> Bool {
        hasOnboarded && !hasCompletedActivation
    }
}

enum ActivationGuidanceStep: String, Codable, CaseIterable, Equatable {
    case scan
    case photoReview
    case voiceNote
    case trophyWall
    case listingReview

}

enum ActivationGuidanceAction: Equatable {
    case gotIt
    case skip
    case capturedFirstPhoto
    case reorderedPhotos
    case openedVoiceNote
    case startedListing
    case openedProcessing
    case editedListing
}

enum ActivationGuidanceSurface: Equatable {
    case scan
    case photoReview
    case trophyWall
    case listingReview
}

enum ActivationCoachMark: Equatable {
    case act01
    case act02
    case act02B
    case act03
    case act04
    case act06

    init?(step: ActivationGuidanceStep, surface: ActivationGuidanceSurface, isResumed: Bool) {
        switch (step, surface) {
        case (.scan, .scan): self = isResumed ? .act06 : .act01
        case (.photoReview, .photoReview): self = .act02
        case (.voiceNote, .photoReview): self = .act02B
        case (.trophyWall, .trophyWall): self = .act03
        case (.listingReview, .listingReview): self = .act04
        default: return nil
        }
    }

    var copy: String {
        switch self {
        case .act01, .act06: "One item, up to five photos."
        case .act02: "Drag to reorder. First is the cover."
        case .act02B: "Tap to record, then Save."
        case .act03: "Work continues after you leave."
        case .act04: "Every field here is yours to change."
        }
    }

    var scoutImageName: String {
        switch self {
        case .act01: "ActivationScoutACT01"
        case .act02: "ActivationScoutACT02"
        case .act02B: "ActivationScoutACT02B"
        case .act03: "ActivationScoutACT03"
        case .act04: "ActivationScoutACT04"
        case .act06: "ActivationScoutACT06"
        }
    }

    var motionResourceName: String? {
        switch self {
        case .act01: "act-01"
        case .act02: "act-02"
        case .act02B: "act-02b"
        case .act03: "act-03"
        case .act04: "act-04"
        case .act06: nil
        }
    }

    var isDarkSurface: Bool {
        self == .act01 || self == .act06
    }
}

struct ActivationGuidanceProgress: Codable, Equatable {
    var step: ActivationGuidanceStep = .scan
    var wasInterrupted = false

    mutating func advance(for action: ActivationGuidanceAction) -> Bool {
        if action == .skip {
            return true
        }

        let next: ActivationGuidanceStep?

        switch (step, action) {
        case (.scan, .gotIt), (.scan, .capturedFirstPhoto):
            next = .photoReview
        case (.photoReview, .gotIt), (.photoReview, .reorderedPhotos),
             (.photoReview, .openedVoiceNote):
            next = .voiceNote
        case (.photoReview, .startedListing),
             (.voiceNote, .gotIt), (.voiceNote, .openedVoiceNote),
             (.voiceNote, .startedListing):
            // Voice context is optional. Starting the listing must never leave
            // guidance waiting for an optional row the seller chose not to use.
            next = .trophyWall
        case (.trophyWall, .gotIt), (.trophyWall, .openedProcessing):
            next = .listingReview
        case (.listingReview, .gotIt), (.listingReview, .editedListing):
            next = nil
        default:
            return false
        }

        guard let next else { return true }
        step = next
        wasInterrupted = false
        return false
    }
}

protocol ActivationGuidanceProgressPersisting: AnyObject {
    func load(for identity: String) -> ActivationGuidanceProgress
    func save(_ progress: ActivationGuidanceProgress, for identity: String)
    func clear(for identity: String)
}

final class UserDefaultsActivationGuidanceProgressStore: ActivationGuidanceProgressPersisting {
    private let defaults: UserDefaults
    private let prefix: String
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(
        defaults: UserDefaults = .standard,
        prefix: String = "snaplist.activation-guidance-progress-v1."
    ) {
        self.defaults = defaults
        self.prefix = prefix
    }

    func load(for identity: String) -> ActivationGuidanceProgress {
        guard let data = defaults.data(forKey: key(for: identity)),
              let progress = try? decoder.decode(ActivationGuidanceProgress.self, from: data) else {
            return .init()
        }
        return progress
    }

    func save(_ progress: ActivationGuidanceProgress, for identity: String) {
        defaults.set(try? encoder.encode(progress), forKey: key(for: identity))
    }

    func clear(for identity: String) {
        defaults.removeObject(forKey: key(for: identity))
    }

    private func key(for identity: String) -> String {
        "\(prefix)\(identity)"
    }
}
