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

enum ActivationGuidanceSurface: Equatable, CaseIterable {
    case scan
    case photoReview
    case trophyWall
    case listingReview
    case settings
}

/// Which surface the seller is actually looking at.
///
/// #1056: this used to live inside `AppShellView` as a computed property that
/// read the selected tab and the full-screen presentation only. Settings is
/// *pushed* onto the selected tab's stack, so that resolver kept answering
/// `.trophyWall` while Settings covered the screen and the shell drew the
/// Trophy Wall coach mark on top of it, anchored to chrome that was no longer
/// visible. The stack is now part of the input, and the top of the stack — not
/// the tab beneath it — names the surface.
enum ActivationSurfaceResolutionPolicy {
    static func surface(
        hasPhotoReviewSession: Bool,
        selectedTab: PrimaryTab,
        pushedPath: [AppRoute],
        presentedFullScreen: AppFullScreen?
    ) -> ActivationGuidanceSurface? {
        // Photo Review hosts above both tab stacks, so it answers first.
        if hasPhotoReviewSession { return .photoReview }

        if let top = pushedPath.last {
            switch top {
            case .settings:
                return .settings
            case .home, .future:
                // Processing, local recovery and the future boundaries carry no
                // activation mark of their own. Inheriting the tab's mark is
                // exactly the defect, so they resolve to nothing.
                return nil
            }
        }

        if selectedTab == .trophyWall, presentedFullScreen == nil {
            return .trophyWall
        }
        if selectedTab == .scan,
           presentedFullScreen == nil || presentedFullScreen == .guidedCamera {
            return .scan
        }
        return nil
    }
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
        progress: ActivationTourProgress
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
        loadProgress: (String) -> ActivationTourProgress,
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
        loadProgress: (String) -> ActivationTourProgress,
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
    /// The one submission event that means the seller's Start listing tap
    /// actually landed: the item is durably accepted.
    static func isItemAccepted(
        _ event: ItemRunSubmissionPresentationEvent?
    ) -> Bool {
        if case .itemSaved? = event { return true }
        return false
    }
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
