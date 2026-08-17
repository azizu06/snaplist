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

    /// The one in-app notification surface (#891). The app delegate asks it
    /// whether it can draw, and the shell tells it when it can. Neither can
    /// hold a reference to the other, which is the same reason the coordinator
    /// lives here.
    static let foregroundPresenter = ForegroundPushPresenter()

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
                // Resolved once, from this build's own signing profile (#891).
                // It cannot change while the process is alive, and it is read
                // here rather than in the domain because the state machine has
                // no use for a value it cannot act on.
                try await client.submitPushDeviceToken(
                    token,
                    environment: apnsEnvironmentForRunningApp()
                )
            }
        )
    }

    /// The seller submitted an item and the server accepted it — the one moment
    /// that may produce the prompt. A launch with no composed coordinator (a
    /// fixture run) does nothing, which is the same thing a refusal does.
    static func itemSubmitted() {
        Task { await coordinator?.itemSubmitted() }
    }

    /// The seller turned the Settings switch on (#891). A launch with no
    /// composed coordinator leaves the switch where it was, which is the truth:
    /// nothing asked, so nothing changed.
    static func notificationsRequestedFromSettings() async {
        await coordinator?.notificationsRequestedFromSettings()
    }

    static func deviceTokenReceived(_ token: Data) {
        Task { await coordinator?.deviceTokenReceived(token) }
    }
}
