import Foundation
import UIKit
import UserNotifications

/**
 Issue #890. The only reason SnapList has an app delegate.

 APNs hands the device token to `UIApplicationDelegate` and nowhere else, so a
 pure SwiftUI `App` cannot receive one. This adaptor exists to forward that one
 callback and nothing more; every decision about whether to have asked, and what
 to do with the token, stays in the coordinator.

 Issue #891 adds the second callback iOS offers nowhere else: what to draw when
 a notification lands with the app already open. Since #1137 the answer is
 always "let iOS draw it", stated once in `ForegroundPushPolicy`.
 */
final class PushRegistrationAppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions:
            [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
#if DEBUG
        Self.receiveFixtureTap(from: ProcessInfo.processInfo.arguments)
#endif
        return true
    }

#if DEBUG
    /// UI-test stand-in for a notification tapped while the app was not running
    /// (#1137): `--push-tap-fixture=<moment>[:<runId>]`. It goes through the same
    /// `receive` a real delivery does, so the shell is proved against the entry
    /// iOS uses rather than a shortcut around it.
    private static func receiveFixtureTap(from arguments: [String]) {
        let prefix = "--push-tap-fixture="
        guard let argument = arguments.first(where: { $0.hasPrefix(prefix) }) else {
            return
        }
        let parts = argument.dropFirst(prefix.count).split(
            separator: ":",
            maxSplits: 1
        )
        guard let moment = parts.first else { return }
        var userInfo: [AnyHashable: Any] = ["moment": String(moment)]
        if parts.count > 1 { userInfo["runId"] = String(parts[1]) }
        let deliver = {
            MainActor.assumeIsolated {
                PushRegistrationComposition.tapRouter.receive(
                    userInfo: userInfo,
                    actionIdentifier: UNNotificationDefaultActionIdentifier
                )
            }
        }
        // `--push-tap-fixture-delay=<seconds>` delivers after launch, the way a
        // banner tapped while the app is open arrives.
        let delayPrefix = "--push-tap-fixture-delay="
        if let delayArgument = arguments.first(where: { $0.hasPrefix(delayPrefix) }),
           let delay = Double(delayArgument.dropFirst(delayPrefix.count)) {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { _ = deliver() }
        } else {
            _ = deliver()
        }
    }
#endif

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Task { @MainActor in
            PushRegistrationComposition.deviceTokenReceived(deviceToken)
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        // Deliberately silent. Registration is best effort: the seller's item is
        // already submitted, the next submission tries again, and nothing in the
        // app claims a notification was promised.
    }
}

extension PushRegistrationAppDelegate: UNUserNotificationCenterDelegate {
    /// iOS draws the banner, plays the sound, and files the notification, the
    /// same as it does with the app closed.
    @MainActor
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        ForegroundPushPolicy.presentationOptions()
    }

    /// A tap on the notification, from the banner iOS drew over the open app,
    /// from the lock screen, or from Notification Center. iOS routes all of them
    /// here, so foreground and background taps open the item the same way (#1137).
    @MainActor
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        PushRegistrationComposition.tapRouter.receive(
            userInfo: response.notification.request.content.userInfo,
            actionIdentifier: response.actionIdentifier
        )
    }
}
