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

/// How a push that landed with the app open is presented.
///
/// Always by iOS (#1137). The custom in-app banner (#891) did not look like a
/// notification, so nothing in the app may take a SnapList push from the
/// system: the banner, sound, and Notification Center entry are Apple's, and
/// the payload is not consulted. Being one fixed answer is the point; a
/// conditional here is how a suppressed banner with nothing drawn in its place
/// comes back.
enum ForegroundPushPolicy {
    static let systemPresentation: UNNotificationPresentationOptions =
        [.banner, .sound, .list]

    static func presentationOptions() -> UNNotificationPresentationOptions {
        systemPresentation
    }
}

/// Holds the one notification the app is currently showing itself.
///
/// Dead since #1137: nothing calls `show` any more, so `visible` stays nil and
/// `ForegroundPushBanner` never draws. It survives only because the shell
/// (`AppShellView`) still mounts it; #1134 removes that mount and this type.
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

/// The retired in-app replacement for the system banner. Never drawn since
/// #1137; delete with the `AppShellView` mount (#1134).
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
