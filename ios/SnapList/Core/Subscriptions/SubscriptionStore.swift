import Foundation
import Observation

@MainActor
@Observable
final class SubscriptionStore {
    enum State: Equatable {
        case unconfigured
        case loading
        case available([SubscriptionProductMetadata])
        case purchasing(productID: String)
        case pending(productID: String)
        case restoring
        case restoreNotFound
        case awaitingServerVerification(action: VerificationAction)
        case verified(ServerVerifiedSubscription)
        case failed(String)
    }

    enum VerificationAction: Equatable {
        case purchase
        case restore
    }

    private(set) var state: State = .unconfigured
    private let client: any SubscriptionClient
    private var products: [SubscriptionProductMetadata] = []
    private var operationID = UUID()
    private var appUserID: String?

    init(client: any SubscriptionClient) {
        self.client = client
    }

    func load(configuration: NativeSubscriptionConfiguration) async {
        let id = UUID()
        operationID = id
        appUserID = nil
        guard configuration.configured else {
            state = .unconfigured
            return
        }
        state = .loading
        do {
            try await client.configure(configuration)
            guard operationID == id else { return }
            let loaded = try await client.loadProducts()
            guard operationID == id else { return }
            products = loaded
            appUserID = configuration.appUserID
            state = .available(products)
        } catch is CancellationError {
            return
        } catch {
            guard operationID == id else { return }
            state = .failed(String(describing: error))
        }
    }

    func purchase(productID: String) async {
        guard let appUserID else { state = .unconfigured; return }
        let id = UUID()
        operationID = id
        state = .purchasing(productID: productID)
        do {
            let result = try await client.purchase(productID: productID, appUserID: appUserID)
            guard operationID == id else { return }
            switch result {
            case .cancelled:
                state = .available(products)
            case .pending:
                state = .pending(productID: productID)
            case .awaitingServerVerification:
                state = .awaitingServerVerification(action: .purchase)
            case .nothingToRestore:
                state = .available(products)
            }
        } catch is CancellationError {
            guard operationID == id else { return }
            state = .available(products)
        } catch {
            guard operationID == id else { return }
            state = .failed(String(describing: error))
        }
    }

    func restore() async {
        guard let appUserID else { state = .unconfigured; return }
        let id = UUID()
        operationID = id
        state = .restoring
        do {
            let result = try await client.restore(appUserID: appUserID)
            guard operationID == id else { return }
            switch result {
            case .nothingToRestore:
                state = .restoreNotFound
            case .cancelled:
                state = .available(products)
            case .pending, .awaitingServerVerification:
                state = .awaitingServerVerification(action: .restore)
            }
        } catch is CancellationError {
            guard operationID == id else { return }
            state = .available(products)
        } catch {
            guard operationID == id else { return }
            state = .failed(String(describing: error))
        }
    }

    /// RevenueCat CustomerInfo never calls this. Only the authenticated server
    /// response backed by the #168 ledger may promote advisory state to verified.
    func applyServerVerification(_ entitlement: ServerVerifiedSubscription) {
        operationID = UUID()
        state = .verified(entitlement)
    }
}
