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
    let tailHorizontalOffset: CGFloat
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
            return .init(
                tailEdge: .bottom,
                bottomInset: 112,
                tailHorizontalOffset: 0
            )
        case .act02, .act03:
            return .init(
                tailEdge: .bottom,
                bottomInset: 24,
                tailHorizontalOffset: 0
            )
        case .act02B:
            // The bubble body keeps the band it already occupied: the tail no
            // longer consumes its 12 points below the bubble, so the inset
            // absorbs them. The shell pads inside the safe area, so the
            // package's screen-bottom measurements port as this relative
            // correction rather than as their absolute 110.
            return .init(
                tailEdge: .top,
                bottomInset: 108,
                tailHorizontalOffset: 0
            )
        case .act04:
            return .init(
                tailEdge: .bottom,
                bottomInset: 84,
                tailHorizontalOffset: 91
            )
        }
    }
}

enum ActivationGuidanceAssetSelection: Equatable {
    case none
    case staticImage(name: String)
    case motion(resourceName: String)
}

enum ActivationGuidanceScoutRendering: Equatable {
    case none
    case staticFallbackPNG(asset: String)
    case acceptedWebM(url: URL)
}

enum ActivationGuidanceAssetPolicy {
    static func selection(
        for state: ActivationGuidanceState,
        reduceMotion: Bool,
        usesStaticRendering: Bool = false
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
        guard !reduceMotion, !usesStaticRendering, let motionName else {
            return .staticImage(name: staticName)
        }
        return .motion(resourceName: motionName)
    }

    /// Resolves normal motion before the view constructs WebKit, so a missing
    /// bundle resource degrades to the approved static Scout instead of blank
    /// reserved space. UI tests pass `usesStaticRendering` to avoid WebKit's
    /// iOS 26.5 accessibility-bundle collision.
    static func rendering(
        for state: ActivationGuidanceState,
        reduceMotion: Bool,
        usesStaticRendering: Bool,
        bundle: Bundle = .main
    ) -> ActivationGuidanceScoutRendering {
        switch selection(
            for: state,
            reduceMotion: reduceMotion,
            usesStaticRendering: usesStaticRendering
        ) {
        case .none:
            return .none
        case .staticImage(let asset):
            return .staticFallbackPNG(asset: asset)
        case .motion(let resourceName):
            guard let url = bundle.url(
                forResource: resourceName,
                withExtension: resourceExtension,
                subdirectory: resourceSubdirectory
            ) else {
                guard case .staticImage(let asset) = selection(
                    for: state,
                    reduceMotion: true
                ) else {
                    return .none
                }
                return .staticFallbackPNG(asset: asset)
            }
            return .acceptedWebM(url: url)
        }
    }

    static let resourceSubdirectory = "ActivationGuidance"
    static let resourceExtension = "webm"
}

enum ActivationAuthenticationState: Equatable {
    case guest
    case authenticated(userID: String)
    case unknown
}

enum ActivationAuthenticationPolicy {
    /// The status a bearer-authenticated route answers when the caller carries
    /// no Clerk subject.
    static let unauthenticatedStatusCode = 401

    /// A guest reaches a bearer-authenticated route two ways, and both prove the
    /// same fact. Either the provider has no session to mint a token from
    /// (`sessionAbsent`), or it falls back to the App Attest capability bearer,
    /// which is a real token the route then rejects with a 401. A capability
    /// proves an installation, never a subject, so neither outcome improves by
    /// asking again — both are terminal and both mean `.guest`.
    ///
    /// `.unknown` stays reserved for failures a retry can actually clear:
    /// transport errors and 5xx. Classifying a 401 as `.unknown` is what left
    /// every guest polling `/v1/session` forever (#784).
    static func state(forSessionError error: Error) -> ActivationAuthenticationState {
        if let bearerError = error as? BearerTokenProviderError,
           bearerError == .sessionAbsent {
            return .guest
        }
        guard let apiError = error as? MobileAPIClientError else {
            return .unknown
        }
        switch apiError {
        case .unauthenticated(.guestCapability):
            return .guest
        case .unauthenticated(.clerkSubject):
            // The route refused a token minted for a verified subject. That is
            // a broken credential — a missing `CLERK_SECRET_KEY`, a rotated
            // signing key — not an absent one, and it is exactly the class
            // `.unknown` exists for. Calling it `.guest` would put the coach
            // marks back in front of a signed-in seller (#789 item 2).
            return .unknown
        case .httpStatus(let status) where status == unauthenticatedStatusCode:
            // A `401` no credential was classified for still means guest: it
            // reached here from a caller that did not go through the
            // authenticated seam, and the only credential that gets to a bearer
            // route without a Clerk subject is the capability bearer.
            return .guest
        case .httpStatus, .invalidResponse:
            return .unknown
        }
    }
}

/// The bound on every activation loop that talks to the network. A `.retry` now
/// only ever means "this might clear on its own" — a transport failure or a 5xx
/// — so the loop backs off and then gives up, instead of spinning at a fixed
/// interval for the whole app session (#784).
struct ActivationRetryPolicy: Equatable, Sendable {
    /// The cap, stated once and shared by all three activation loops. Five
    /// attempts spend 2 + 4 + 8 + 16 = 30 seconds of backoff and then stop.
    /// A loop that has failed for half a minute is not going to be rescued by
    /// a thousand more requests; the next launch or navigation retries it.
    let maxAttempts: Int
    let baseDelay: Duration

    static let standard = ActivationRetryPolicy(
        maxAttempts: 5,
        baseDelay: .seconds(2)
    )

    /// Exponential backoff from `baseDelay`, clamped where the loop stops.
    ///
    /// `maxAttempts` is the only cap that can fire. The last attempt returns
    /// instead of backing off, so attempt `maxAttempts - 1` is the last one that
    /// ever produces a delay and its value is the top of the ladder. A separate
    /// `maxDelay` constant above that point cannot be reached, and a retry
    /// envelope stated in a number no run can produce misleads the next reader.
    func delay(afterAttempt attempt: Int) -> Duration {
        let lastSleepingAttempt = max(1, maxAttempts - 1)
        let doublings = max(0, min(attempt, lastSleepingAttempt) - 1)
        return baseDelay * (1 << doublings)
    }
}

enum ActivationRetryOutcome<Value> {
    case finished(Value)
    case retry
}

/// Runs one attempt at a time under `policy` and stops for good when the cap is
/// spent. The three activation loops used to live inside `AppShellView`, where
/// a `while` was unreachable from a test; holding the loop here is what lets a
/// test count the requests a guest actually makes.
@MainActor
enum ActivationBoundedRetry {
    static func run<Value>(
        policy: ActivationRetryPolicy = .standard,
        isCancelled: () -> Bool = { Task.isCancelled },
        sleep: (Duration) async -> Void = { try? await Task.sleep(for: $0) },
        attempt: () async -> ActivationRetryOutcome<Value>
    ) async -> Value? {
        guard policy.maxAttempts > 0 else { return nil }
        for attemptNumber in 1...policy.maxAttempts {
            guard !isCancelled() else { return nil }
            switch await attempt() {
            case .finished(let value):
                return value
            case .retry:
                guard attemptNumber < policy.maxAttempts else { return nil }
                await sleep(policy.delay(afterAttempt: attemptNumber))
            }
        }
        return nil
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

    /// The bootstrap loop itself. Returns the terminal result the caller should
    /// apply, or nil when the caller stopped it or the retry cap ran out.
    /// `onRetry` reports each deferred pass so the caller can record the
    /// in-flight authentication without owning the loop.
    static func bootstrap(
        policy: ActivationRetryPolicy = .standard,
        isCancelled: () -> Bool = { Task.isCancelled },
        sleep: (Duration) async -> Void = { try? await Task.sleep(for: $0) },
        onRetry: (ActivationAuthenticationState) -> Void,
        guestCompleted: () -> Bool,
        loadProgress: (String) -> ActivationGuidanceProgress,
        fetchSessionUserID: () async throws -> String,
        fetchTenantCompleted: () async throws -> Bool,
        writeTenantCompletion: () async throws -> Bool
    ) async -> ActivationCompletionBootstrapResult? {
        await ActivationBoundedRetry.run(
            policy: policy,
            isCancelled: isCancelled,
            sleep: sleep
        ) {
            let result = await resolve(
                guestCompleted: guestCompleted(),
                loadProgress: loadProgress,
                fetchSessionUserID: fetchSessionUserID,
                fetchTenantCompleted: fetchTenantCompleted,
                writeTenantCompletion: writeTenantCompletion
            )
            guard case .retry(let authentication) = result else {
                return .finished(result)
            }
            onRetry(authentication)
            return .retry
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

    /// The promotion loop. Returns the promoted user ID, or nil when the caller
    /// stopped it or the cap ran out. A guest who never signs in during this
    /// session now stops asking after the cap; the marker still promotes on the
    /// next launch, because bootstrap resolves it there.
    static func promote(
        policy: ActivationRetryPolicy = .standard,
        isCancelled: () -> Bool = { Task.isCancelled },
        sleep: (Duration) async -> Void = { try? await Task.sleep(for: $0) },
        fetchSessionUserID: () async throws -> String,
        fetchTenantCompleted: () async throws -> Bool,
        writeTenantCompletion: () async throws -> Bool
    ) async -> String? {
        await ActivationBoundedRetry.run(
            policy: policy,
            isCancelled: isCancelled,
            sleep: sleep
        ) {
            let result = await attempt(
                fetchSessionUserID: fetchSessionUserID,
                fetchTenantCompleted: fetchTenantCompleted,
                writeTenantCompletion: writeTenantCompletion
            )
            guard case .promoted(let userID) = result else { return .retry }
            return .finished(userID)
        }
    }
}

/// The authenticated completion write, bounded by the same policy. Reports
/// whether the tenant marker was recorded, so the caller only advances local
/// state on a write the server actually accepted.
@MainActor
enum ActivationCompletionRecordingCoordinator {
    static func record(
        policy: ActivationRetryPolicy = .standard,
        isCancelled: () -> Bool = { Task.isCancelled },
        sleep: (Duration) async -> Void = { try? await Task.sleep(for: $0) },
        writeTenantCompletion: () async throws -> Bool
    ) async -> Bool {
        await ActivationBoundedRetry.run(
            policy: policy,
            isCancelled: isCancelled,
            sleep: sleep
        ) {
            do {
                guard try await writeTenantCompletion() else { return .retry }
                return .finished(true)
            } catch is CancellationError {
                return .finished(false)
            } catch {
                return .retry
            }
        } ?? false
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
