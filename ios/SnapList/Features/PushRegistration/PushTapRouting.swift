import Foundation
import Observation
import UserNotifications

/// What a tapped SnapList notification asks the app to open (#1137).
///
/// `runID` is the run that produced the item, the same identity a Trophy Wall
/// tile opens by, so a tap and a tile share one path to the same listing and
/// the server's own tenancy check decides whether the seller may see it.
/// A payload with no usable identity is still a SnapList tap: it lands on the
/// wall and opens nothing.
struct SellerPushTap: Equatable, Sendable {
    let moment: ForegroundPushMoment
    let runID: UUID?

    init(moment: ForegroundPushMoment, runID: UUID?) {
        self.moment = moment
        self.runID = runID
    }

    /// Nil for anything that is not one of SnapList's two moments, so a payload
    /// that is not ours can never steer the app.
    init?(userInfo: [AnyHashable: Any]) {
        guard let rawMoment = userInfo["moment"] as? String,
              let moment = ForegroundPushMoment(rawValue: rawMoment)
        else { return nil }
        let runID = (userInfo["runId"] as? String).flatMap(UUID.init(uuidString:))
        self.init(moment: moment, runID: runID)
    }
}

/// Holds the one tap the shell has not opened yet.
///
/// iOS reports every tap through the same delegate callback whether the app was
/// open, in the background, or not running, so foreground and background taps
/// cannot differ: they both end in `receive`. On a cold launch the callback can
/// arrive before any view exists, which is why the tap is held rather than
/// handed to a view directly, and why it expires: a shell that never mounts
/// must not open an item minutes later.
@MainActor
@Observable
final class PushTapRouter {
    /// Long enough for a cold launch to reach the wall, short enough that a
    /// stalled shell cannot resurrect an old tap.
    static let lifetime: TimeInterval = 120

    struct Pending: Equatable {
        let tap: SellerPushTap
        let receivedAt: Date
    }

    private(set) var pending: Pending?
    @ObservationIgnored private let now: () -> Date

    init(now: @escaping () -> Date = Date.init) {
        self.now = now
    }

    /// True when the response is a tap on one of our notifications. Dismissing
    /// a notification, or any payload that is not ours, changes nothing.
    @discardableResult
    func receive(userInfo: [AnyHashable: Any], actionIdentifier: String) -> Bool {
        guard actionIdentifier == UNNotificationDefaultActionIdentifier,
              let tap = SellerPushTap(userInfo: userInfo)
        else { return false }
        pending = Pending(tap: tap, receivedAt: now())
        return true
    }

    /// Hands the tap over exactly once; an expired tap is dropped, not handed.
    func take() -> SellerPushTap? {
        guard let held = pending else { return nil }
        pending = nil
        guard now().timeIntervalSince(held.receivedAt) <= Self.lifetime else {
            return nil
        }
        return held.tap
    }
}

enum PushTapOpenResult: Equatable {
    case nothingPending
    /// A tap with no usable run identity. The wall is already showing.
    case noItem
    case opened
    /// The server would not open that run for this seller: deleted, not theirs,
    /// or not openable yet. The wall is already showing.
    case unavailable
}

/// Turns a held tap into the same open a Trophy Wall tile performs.
@MainActor
enum PushTapOpener {
    static func open(
        from router: PushTapRouter,
        openListing: (UUID) async -> ProcessingActionOutcome
    ) async -> PushTapOpenResult {
        guard let tap = router.take() else { return .nothingPending }
        guard let runID = tap.runID else { return .noItem }
        return await openListing(runID) == .rejected ? .unavailable : .opened
    }
}
