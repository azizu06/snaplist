import Foundation
import UIKit

/**
 Issue #890. The only reason SnapList has an app delegate.

 APNs hands the device token to `UIApplicationDelegate` and nowhere else, so a
 pure SwiftUI `App` cannot receive one. This adaptor exists to forward that one
 callback and nothing more; every decision about whether to have asked, and what
 to do with the token, stays in the coordinator.
 */
final class PushRegistrationAppDelegate: NSObject, UIApplicationDelegate {
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
