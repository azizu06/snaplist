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
        return true
    }

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
    /// same as it does with the app closed. Tapping it is likewise iOS's: the
    /// app opens, exactly as from the background.
    @MainActor
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        ForegroundPushPolicy.presentationOptions()
    }
}
