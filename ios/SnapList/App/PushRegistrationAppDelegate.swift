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
 a notification lands with the app already open. The decision itself is in
 `ForegroundPushPolicy`, and it is a report from the surface that drew the
 replacement rather than a choice made here.
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
    /// Suppressing Apple's banner and drawing the replacement are two things in
    /// two places. Only the second one reporting success may suppress the
    /// first, so a seller whose in-app surface is not mounted still sees the
    /// system banner rather than nothing at all.
    @MainActor
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        ForegroundPushPolicy.presentationOptions(
            for: notification.request.content.userInfo,
            showInApp: { PushRegistrationComposition.foregroundPresenter.show($0) }
        )
    }
}
