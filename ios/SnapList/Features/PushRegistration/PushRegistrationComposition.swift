import Foundation
import UIKit
import UserNotifications

/**
 Issue #890. Builds the live push-registration coordinator and holds the one
 instance both the app delegate and the shell need to reach.

 The delegate receives the APNs token from UIKit and the shell knows when an
 item was accepted; neither can be handed the other's reference through a view
 initializer, so composition lives here — the same shape as the included-offer
 redemption entry point, which is started from the app for the same reason.
 */
@MainActor
enum PushRegistrationComposition {
    private(set) static var coordinator: PushRegistrationCoordinator?

    static func start(
        apiOrigin: URL,
        tokenProvider: any BearerTokenProviding,
        session: URLSession
    ) {
        guard coordinator == nil else { return }
        let client = URLSessionPushDeviceTokenClient(
            baseURL: apiOrigin,
            tokenProvider: tokenProvider,
            session: session
        )
        coordinator = PushRegistrationCoordinator(
            store: UserDefaultsPushRegistrationStore(),
            requestAuthorization: {
                try await UNUserNotificationCenter.current().requestAuthorization(
                    options: [.alert, .sound, .badge]
                )
            },
            registerForRemoteNotifications: {
                UIApplication.shared.registerForRemoteNotifications()
            },
            submitDeviceToken: { token in
                try await client.submitPushDeviceToken(token)
            }
        )
    }

    /// The seller submitted an item and the server accepted it — the one moment
    /// that may produce the prompt. A launch with no composed coordinator (a
    /// fixture run) does nothing, which is the same thing a refusal does.
    static func itemSubmitted() {
        Task { await coordinator?.itemSubmitted() }
    }

    static func deviceTokenReceived(_ token: Data) {
        Task { await coordinator?.deviceTokenReceived(token) }
    }
}
