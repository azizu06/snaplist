import Foundation

/// Issue #890. What the seller has decided about notifications on this install.
///
/// Three states, because three are all the app is allowed to distinguish. iOS
/// itself owns the real permission; this records only whether SnapList has
/// spent its one chance to ask, and what came back.
enum PushRegistrationDecision: String, Codable, Equatable {
    /// The prompt has not been shown. The only thing that may show it is a
    /// completed item submission.
    case notYetAsked
    case allowed
    /// The seller said no. From here the app never asks again; Settings is the
    /// only way back, and issue #891 owns that row.
    case refused
}

enum PushRegistrationEvent: Equatable {
    /// The seller submitted an item and the server accepted it. This is the one
    /// moment that has earned the prompt: the app has already delivered value,
    /// and "we'll tell you when it's ready" is now a true sentence.
    case itemSubmitted
    case sellerAnswered(granted: Bool)
}

enum PushRegistrationCommand: Equatable {
    case doNothing
    /// Show the system prompt. Produced exactly once per install.
    case askOnce
    /// Ask iOS for a device token. Also produced on later submissions by a
    /// seller who allowed, because APNs reissues tokens and the row's key
    /// makes re-registering the same device an update rather than a duplicate.
    case registerWithAPNs
}

struct PushRegistrationProgress: Codable, Equatable {
    var decision: PushRegistrationDecision = .notYetAsked

    mutating func advance(
        for event: PushRegistrationEvent
    ) -> PushRegistrationCommand {
        switch (decision, event) {
        case (.notYetAsked, .itemSubmitted):
            // The decision deliberately does not move here. Showing the prompt
            // is not an answer, and a crash or a backgrounded app between the
            // two must leave the seller's real answer still askable.
            return .askOnce
        case (.allowed, .itemSubmitted):
            return .registerWithAPNs
        case (.refused, .itemSubmitted):
            return .doNothing
        case (_, .sellerAnswered(let granted)):
            guard decision == .notYetAsked else {
                // A duplicate callback. Re-answering a settled question is how
                // a refusal would silently become a second prompt.
                return .doNothing
            }
            decision = granted ? .allowed : .refused
            return granted ? .registerWithAPNs : .doNothing
        }
    }
}

protocol PushRegistrationPersisting: AnyObject {
    func load() -> PushRegistrationProgress
    func save(_ progress: PushRegistrationProgress)
}

/// One record per install, not per account: the permission it mirrors is
/// granted to the app by iOS, and a seller who refused does not become askable
/// again by signing in.
final class UserDefaultsPushRegistrationStore: PushRegistrationPersisting {
    private let defaults: UserDefaults
    private let key: String
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(
        defaults: UserDefaults = .standard,
        key: String = "snaplist.push-registration-v1"
    ) {
        self.defaults = defaults
        self.key = key
    }

    func load() -> PushRegistrationProgress {
        guard let data = defaults.data(forKey: key),
              let progress = try? decoder.decode(
                  PushRegistrationProgress.self,
                  from: data
              ) else {
            return .init()
        }
        return progress
    }

    func save(_ progress: PushRegistrationProgress) {
        defaults.set(try? encoder.encode(progress), forKey: key)
    }
}

/// Drives the one prompt, the registration that follows it, and the token post.
///
/// Every side effect is injected, so the whole policy is provable without a
/// notification centre, an APNs connection, or a device. Nothing here can fail
/// in a way the seller notices: a submission has already succeeded by the time
/// this runs, and every failure path returns quietly.
@MainActor
final class PushRegistrationCoordinator {
    private let store: any PushRegistrationPersisting
    private let requestAuthorization: () async throws -> Bool
    private let registerForRemoteNotifications: () -> Void
    private let submitDeviceToken: (String) async throws -> Void
    private var progress: PushRegistrationProgress

    init(
        store: any PushRegistrationPersisting,
        requestAuthorization: @escaping () async throws -> Bool,
        registerForRemoteNotifications: @escaping () -> Void,
        submitDeviceToken: @escaping (String) async throws -> Void
    ) {
        self.store = store
        self.requestAuthorization = requestAuthorization
        self.registerForRemoteNotifications = registerForRemoteNotifications
        self.submitDeviceToken = submitDeviceToken
        self.progress = store.load()
    }

    var decision: PushRegistrationDecision { progress.decision }

    func itemSubmitted() async {
        await perform(progress.advance(for: .itemSubmitted))
    }

    /// Called with the bytes APNs handed the app delegate.
    func deviceTokenReceived(_ token: Data) async {
        guard progress.decision == .allowed else { return }
        let hex = token.map { String(format: "%02x", $0) }.joined()
        do {
            try await submitDeviceToken(hex)
        } catch {
            // Best effort by contract. The next submission re-registers, and
            // nothing the seller can see depends on this having landed.
        }
    }

    private func perform(_ command: PushRegistrationCommand) async {
        switch command {
        case .doNothing:
            store.save(progress)
        case .askOnce:
            let granted: Bool
            do {
                granted = try await requestAuthorization()
            } catch {
                // The seller never answered, so nothing is recorded. Writing a
                // refusal here would silence the app permanently over a
                // transient failure.
                return
            }
            await perform(progress.advance(for: .sellerAnswered(granted: granted)))
        case .registerWithAPNs:
            store.save(progress)
            registerForRemoteNotifications()
        }
    }
}
