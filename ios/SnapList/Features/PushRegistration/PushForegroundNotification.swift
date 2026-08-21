import SwiftUI
import UserNotifications

/// Issue #891. The two moments a seller is told about.
///
/// The server names the moment in the payload because the APNs collapse id,
/// which carries the same fact, rides a header the device never sees.
enum ForegroundPushMoment: String, Equatable {
    case listingReady
    case listingPublished
}

/// A SnapList push that arrived while the app was open, read back out of its
/// own payload so the in-app surface says exactly what Apple would have.
struct ForegroundPushNotification: Equatable {
    let moment: ForegroundPushMoment
    let title: String
    let body: String

    init(moment: ForegroundPushMoment, title: String, body: String) {
        self.moment = moment
        self.title = title
        self.body = body
    }

    init?(userInfo: [AnyHashable: Any]) {
        guard let rawMoment = userInfo["moment"] as? String,
              let moment = ForegroundPushMoment(rawValue: rawMoment),
              let aps = userInfo["aps"] as? [AnyHashable: Any],
              let alert = aps["alert"] as? [AnyHashable: Any],
              let title = alert["title"] as? String,
              let body = alert["body"] as? String,
              !title.isEmpty,
              !body.isEmpty
        else { return nil }
        self.init(moment: moment, title: title, body: body)
    }
}

/// Whether iOS draws its own banner for a push that landed with the app open.
///
/// Suppressing the system banner and drawing the replacement are two things
/// that happen in two places, and the dangerous failure is the first without
/// the second: no banner, no in-app surface, and a seller whose listing just
/// finished is told nothing anywhere. So suppression is not a decision about
/// the payload. It is a report from the surface that actually drew it, and
/// every other path leaves the notification to iOS.
enum ForegroundPushPolicy {
    /// What iOS is asked to do when the app is not showing the notification
    /// itself.
    static let systemBanner: UNNotificationPresentationOptions =
        [.banner, .sound, .list]

    /// What iOS is asked to do when the app drew the notification itself.
    ///
    /// Not the empty set, and this is deliberate. An empty set means show
    /// nothing anywhere, which drops the notification out of Notification
    /// Center as well, and the in-app banner is transient by design. A seller
    /// who glanced away for a few seconds, or had SnapList foregrounded beside
    /// something they were actually reading, would be left with a listing that
    /// finished and no record of it anywhere on the phone. `.list` suppresses
    /// the banner and the sound, which is the entire point of drawing our own,
    /// and still files it where the seller can pull it down and find it.
    static let drawnInApp: UNNotificationPresentationOptions = [.list]

    static func presentationOptions(
        for userInfo: [AnyHashable: Any],
        showInApp: (ForegroundPushNotification) -> Bool
    ) -> UNNotificationPresentationOptions {
        guard let notification = ForegroundPushNotification(userInfo: userInfo),
              showInApp(notification)
        else { return systemBanner }
        return drawnInApp
    }
}

/// Holds the one notification the app is currently showing itself.
///
/// `mounted` is the honest half of the contract: it is set by the surface that
/// can actually draw, and until something does, `show` refuses and the system
/// banner stands.
@MainActor
@Observable
final class ForegroundPushPresenter {
    /// True while a view that draws `visible` is on screen.
    var mounted = false
    private(set) var visible: ForegroundPushNotification?

    /// Returns whether the notification was taken. A `false` here is what keeps
    /// Apple's banner, so it must never be optimistic.
    func show(_ notification: ForegroundPushNotification) -> Bool {
        guard mounted else { return false }
        // Two moments for one item can land close together. One surface showing
        // the newest truth is what a locked phone already gets from the
        // collapse id.
        visible = notification
        return true
    }

    func dismiss() {
        visible = nil
    }
}

/// The in-app replacement for the system banner.
///
/// Candidate visual (#891). No design package covers this family yet, so it
/// borrows entirely from frozen V1 rather than proposing anything: the
/// `infoBannerFill` and `infoBannerDivider` tokens, the 16-point bubble radius
/// and 44-point dismiss target from `ActivationGuidanceCoachMark`, and that
/// coach mark's overlay idiom.
struct ForegroundPushBanner: View {
    let notification: ForegroundPushNotification
    let dismiss: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOverEnabled

    /// Long enough to read two lines, and gone before it becomes furniture.
    private static let visibleSeconds: Duration = .seconds(6)

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(notification.title)
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .fixedSize(horizontal: false, vertical: true)
                Text(notification.body)
                    .font(.footnote)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Button(action: dismiss) {
                Image(systemName: "xmark")
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .frame(
                        width: SnapListMetrics.minimumTouchTarget,
                        height: SnapListMetrics.minimumTouchTarget
                    )
                    .contentShape(.rect)
            }
            .accessibilityLabel("Close")
            .accessibilityIdentifier("push.foreground-banner.close")
        }
        .padding(.leading, 18)
        .padding(.trailing, 4)
        .padding(.vertical, 10)
        .background(SnapListColorToken.infoBannerFill.color)
        .clipShape(.rect(cornerRadius: 16))
        .overlay {
            RoundedRectangle(cornerRadius: 16)
                .stroke(SnapListColorToken.infoBannerDivider.color, lineWidth: 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(notification.title). \(notification.body)")
        .accessibilityIdentifier("push.foreground-banner")
        .accessibilityAddTraits(.isSummaryElement)
        // The banner can appear while VoiceOver focus is somewhere else
        // entirely, and an unannounced one is a notification the seller never
        // receives.
        .onAppear {
            AccessibilityNotification.Announcement(
                "\(notification.title). \(notification.body)"
            ).post()
        }
        .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
        .task(id: notification) {
            // A banner that leaves on a timer is one a VoiceOver seller can be
            // reading when it vanishes. With VoiceOver on it waits to be
            // dismissed.
            guard !voiceOverEnabled else { return }
            try? await Task.sleep(for: Self.visibleSeconds)
            guard !Task.isCancelled else { return }
            dismiss()
        }
    }
}

extension ForegroundPushNotification: Hashable {}
