import CoreGraphics
import Foundation

enum ActivationPresentationPolicy {
    static func shouldPresent(
        hasOnboarded: Bool,
        hasCompletedActivation: Bool
    ) -> Bool {
        hasOnboarded && !hasCompletedActivation
    }
}

enum ActivationGuidanceState: String, Codable, CaseIterable, Equatable, Hashable {
    case act01 = "ACT-01"
    case act02 = "ACT-02"
    case act02B = "ACT-02B"
    case act03 = "ACT-03"
    case act04 = "ACT-04"
    case act05 = "ACT-05"
    case act06 = "ACT-06"
    case act07 = "ACT-07"

    init?(fixtureValue: String) {
        switch fixtureValue {
        case "scan", Self.act01.rawValue: self = .act01
        case "photoReview", Self.act02.rawValue: self = .act02
        case "voiceNote", Self.act02B.rawValue: self = .act02B
        case "trophyWall", Self.act03.rawValue: self = .act03
        case "listingReview", Self.act04.rawValue: self = .act04
        case Self.act05.rawValue: self = .act05
        case Self.act06.rawValue: self = .act06
        case Self.act07.rawValue: self = .act07
        default: return nil
        }
    }

    var coachMark: ActivationCoachMark? {
        switch self {
        case .act01: .act01
        case .act02: .act02
        case .act02B: .act02B
        case .act03: .act03
        case .act04: .act04
        case .act05, .act07: nil
        case .act06: .act06
        }
    }
}

enum ActivationGuidanceAction: Equatable {
    case gotIt
    case skip
    case capturedFirstPhoto
    case reorderedPhotos
    case openedVoiceNote
    case acceptedRunHandoff
    case openedProcessing
    case editedListing
    case completionRecorded
    case recordedInstallLoaded
}

enum ActivationGuidanceTransition: Equatable {
    case unchanged
    case advanced
    case completionRequested
    case completionRecorded
}

enum ActivationGuidanceSurface: Equatable {
    case scan
    case photoReview
    case trophyWall
    case listingReview
}

enum ActivationCoachMark: Equatable, Hashable {
    case act01
    case act02
    case act02B
    case act03
    case act04
    case act06

    init?(state: ActivationGuidanceState, surface: ActivationGuidanceSurface) {
        switch (state, surface) {
        case (.act01, .scan): self = .act01
        case (.act02, .photoReview): self = .act02
        case (.act02B, .photoReview): self = .act02B
        case (.act03, .trophyWall): self = .act03
        case (.act04, .listingReview): self = .act04
        case (.act06, .scan): self = .act06
        default: return nil
        }
    }

    var state: ActivationGuidanceState {
        switch self {
        case .act01: .act01
        case .act02: .act02
        case .act02B: .act02B
        case .act03: .act03
        case .act04: .act04
        case .act06: .act06
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

    var isDarkSurface: Bool {
        self == .act01 || self == .act06
    }
}

/// Which side of the bubble carries the tail, and therefore which direction the
/// coach mark points. Activation v1.1 draws the tail below the bubble for every
/// state that docks above the control its line names, and above the bubble for
/// the one state that docks below its anchor.
enum ActivationCoachMarkTailEdge: Equatable {
    /// Tail drawn on the bubble's top edge, so the bubble hangs below its
    /// anchor and points up at it.
    case top
    /// Tail drawn on the bubble's bottom edge, so the bubble sits above its
    /// anchor and points down at it.
    case bottom
}

struct ActivationCoachMarkAnchor: Equatable {
    let tailEdge: ActivationCoachMarkTailEdge
    let bottomInset: CGFloat
}

enum ActivationCoachMarkAnchorPolicy {
    /// Activation v1.1 anchors each coach mark against the one control its line
    /// names. ACT-02B is the single state whose anchor sits above it: the gap
    /// above the Voice note row measures 44 points against an 82 point bubble,
    /// so the bubble takes the clear band below the row and points up at it.
    ///
    /// `reduceMotion` is accepted so the Reduced Motion composition is proved
    /// rather than assumed. The package draws that variant with the same
    /// anchor, because "the tail carries the anchoring on its own", so the
    /// geometry is deliberately motion-invariant and only the Scout asset
    /// changes.
    static func anchor(
        for coachMark: ActivationCoachMark,
        reduceMotion: Bool
    ) -> ActivationCoachMarkAnchor {
        switch coachMark {
        case .act01, .act06:
            return .init(tailEdge: .bottom, bottomInset: 112)
        case .act02, .act03:
            return .init(tailEdge: .bottom, bottomInset: 24)
        case .act02B:
            // The bubble body keeps the band it already occupied: the tail no
            // longer consumes its 12 points below the bubble, so the inset
            // absorbs them. The shell pads inside the safe area, so the
            // package's screen-bottom measurements port as this relative
            // correction rather than as their absolute 110.
            return .init(tailEdge: .top, bottomInset: 108)
        case .act04:
            return .init(tailEdge: .bottom, bottomInset: 84)
        }
    }
}

enum ActivationGuidanceAssetSelection: Equatable {
    case none
    case staticImage(name: String)
    case motion(resourceName: String)
}

enum ActivationGuidanceAssetPolicy {
    static func selection(
        for state: ActivationGuidanceState,
        reduceMotion: Bool
    ) -> ActivationGuidanceAssetSelection {
        let staticName: String?
        let motionName: String?

        switch state {
        case .act01:
            (staticName, motionName) = ("ActivationScoutACT01", "act-01")
        case .act02:
            (staticName, motionName) = ("ActivationScoutACT02", "act-02")
        case .act02B:
            (staticName, motionName) = ("ActivationScoutACT02B", "act-02b")
        case .act03:
            (staticName, motionName) = ("ActivationScoutACT03", "act-03")
        case .act04:
            (staticName, motionName) = ("ActivationScoutACT04", "act-04")
        case .act05, .act07:
            (staticName, motionName) = (nil, nil)
        case .act06:
            // ACT-06 deliberately retains the original v4.0 static composition.
            (staticName, motionName) = ("ActivationScoutACT06", nil)
        }

        guard let staticName else { return .none }
        guard !reduceMotion, let motionName else {
            return .staticImage(name: staticName)
        }
        return .motion(resourceName: motionName)
    }
}

enum ActivationAuthenticationState: Equatable {
    case guest
    case authenticated(userID: String)
    case unknown
}

enum ActivationAuthenticationPolicy {
    static func state(forSessionError error: Error) -> ActivationAuthenticationState {
        if let bearerError = error as? BearerTokenProviderError,
           bearerError == .sessionAbsent {
            return .guest
        }
        return .unknown
    }
}

enum ActivationCompletionBootstrapResult: Equatable {
    case present(
        authentication: ActivationAuthenticationState,
        identity: String,
        progress: ActivationGuidanceProgress
    )
    case completed(
        authentication: ActivationAuthenticationState,
        identity: String
    )
    case retry(authentication: ActivationAuthenticationState)
}

@MainActor
enum ActivationCompletionBootstrapCoordinator {
    static func resolve(
        guestCompleted: Bool,
        loadProgress: (String) -> ActivationGuidanceProgress,
        fetchSessionUserID: () async throws -> String,
        fetchTenantCompleted: () async throws -> Bool,
        writeTenantCompletion: () async throws -> Bool
    ) async -> ActivationCompletionBootstrapResult {
        let authentication: ActivationAuthenticationState
        do {
            authentication = .authenticated(
                userID: try await fetchSessionUserID()
            )
        } catch {
            authentication = ActivationAuthenticationPolicy.state(
                forSessionError: error
            )
        }

        switch authentication {
        case .unknown:
            return .retry(authentication: .unknown)
        case .guest:
            return guestCompleted
                ? .completed(authentication: .guest, identity: "guest")
                : .present(
                    authentication: .guest,
                    identity: "guest",
                    progress: loadProgress("guest")
                )
        case .authenticated(let userID):
            let tenantCompleted: Bool
            do {
                tenantCompleted = try await fetchTenantCompleted()
            } catch {
                return .retry(authentication: authentication)
            }
            if tenantCompleted {
                return .completed(
                    authentication: authentication,
                    identity: userID
                )
            }

            let progress = loadProgress(userID)
            if guestCompleted || progress.isCompletionPending {
                do {
                    guard try await writeTenantCompletion() else {
                        return .retry(authentication: authentication)
                    }
                    return .completed(
                        authentication: authentication,
                        identity: userID
                    )
                } catch {
                    return .retry(authentication: authentication)
                }
            }
            return .present(
                authentication: authentication,
                identity: userID,
                progress: progress
            )
        }
    }
}

enum ActivationGuestCompletionPromotionResult: Equatable {
    case waitingForSession
    case promoted(userID: String)
    case retry
}

@MainActor
enum ActivationGuestCompletionPromotionCoordinator {
    static func attempt(
        fetchSessionUserID: () async throws -> String,
        fetchTenantCompleted: () async throws -> Bool,
        writeTenantCompletion: () async throws -> Bool
    ) async -> ActivationGuestCompletionPromotionResult {
        let userID: String
        do {
            userID = try await fetchSessionUserID()
        } catch {
            return ActivationAuthenticationPolicy.state(forSessionError: error)
                == .guest ? .waitingForSession : .retry
        }

        do {
            if try await fetchTenantCompleted() {
                return .promoted(userID: userID)
            }
            if try await writeTenantCompletion() {
                return .promoted(userID: userID)
            }
        } catch {
            return .retry
        }
        return .retry
    }
}

enum ActivationGuidanceSubmissionEventPolicy {
    static func action(
        for event: ItemRunSubmissionPresentationEvent?
    ) -> ActivationGuidanceAction? {
        guard case .itemSaved? = event else { return nil }
        return .acceptedRunHandoff
    }
}

struct ActivationGuidanceProgress: Codable, Equatable {
    var state: ActivationGuidanceState = .act01
    var hasAcknowledgedCurrentState = false
    var isCompletionPending = false

    static var recordedInstall: Self {
        var progress = Self(state: .act05)
        _ = progress.advance(for: .recordedInstallLoaded)
        return progress
    }

    mutating func advance(
        for action: ActivationGuidanceAction
    ) -> ActivationGuidanceTransition {
        if action == .skip,
           state != .act05,
           state != .act07 {
            hasAcknowledgedCurrentState = true
            isCompletionPending = true
            return .completionRequested
        }

        switch (state, action) {
        case (.act01, .gotIt), (.act01, .capturedFirstPhoto),
             (.act06, .gotIt), (.act06, .capturedFirstPhoto):
            move(to: .act02)
            return .advanced
        case (.act02, .gotIt), (.act02, .reorderedPhotos):
            move(to: .act02B)
            return .advanced
        case (.act02, .openedVoiceNote):
            move(to: .act02B)
            hasAcknowledgedCurrentState = true
            return .advanced
        case (.act02B, .gotIt), (.act02B, .openedVoiceNote):
            guard !hasAcknowledgedCurrentState else { return .unchanged }
            hasAcknowledgedCurrentState = true
            return .advanced
        case (.act02, .acceptedRunHandoff),
             (.act02B, .acceptedRunHandoff):
            move(to: .act03)
            return .advanced
        case (.act03, .gotIt), (.act03, .openedProcessing):
            move(to: .act04)
            return .advanced
        case (.act04, .gotIt), (.act04, .editedListing):
            hasAcknowledgedCurrentState = true
            isCompletionPending = true
            return .completionRequested
        case (.act01, .completionRecorded),
             (.act02, .completionRecorded),
             (.act02B, .completionRecorded),
             (.act03, .completionRecorded),
             (.act04, .completionRecorded),
             (.act06, .completionRecorded):
            move(to: .act05)
            return .completionRecorded
        case (.act05, .recordedInstallLoaded):
            move(to: .act07)
            return .completionRecorded
        default:
            return .unchanged
        }
    }

    mutating func recordInterruption() -> ActivationGuidanceTransition {
        guard state == .act01,
              !hasAcknowledgedCurrentState,
              !isCompletionPending else { return .unchanged }
        move(to: .act06)
        return .advanced
    }

    private mutating func move(to state: ActivationGuidanceState) {
        self.state = state
        hasAcknowledgedCurrentState = false
        isCompletionPending = false
    }
}

protocol ActivationGuidanceProgressPersisting: AnyObject {
    func load(for identity: String) -> ActivationGuidanceProgress
    func save(_ progress: ActivationGuidanceProgress, for identity: String)
    func clear(for identity: String)
}

protocol ActivationGuidanceGuestCompletionPersisting: AnyObject {
    var isCompleted: Bool { get }
    func recordCompletion()
    func clear()
}

final class UserDefaultsActivationGuidanceGuestCompletionStore:
    ActivationGuidanceGuestCompletionPersisting {
    private let defaults: UserDefaults
    private let key: String

    init(
        defaults: UserDefaults = .standard,
        key: String = "snaplist.activation-guidance-completed-v1.guest"
    ) {
        self.defaults = defaults
        self.key = key
    }

    var isCompleted: Bool {
        defaults.bool(forKey: key)
    }

    func recordCompletion() {
        defaults.set(true, forKey: key)
    }

    func clear() {
        defaults.removeObject(forKey: key)
    }
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
