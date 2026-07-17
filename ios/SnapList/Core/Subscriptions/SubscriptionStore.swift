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

    init(client: any SubscriptionClient) {
        self.client = client
    }

    func load(configuration: NativeSubscriptionConfiguration) async {
        guard configuration.configured else {
            state = .unconfigured
            return
        }
        state = .loading
        do {
            try await client.configure(configuration)
            products = try await client.loadProducts()
            state = .available(products)
        } catch is CancellationError {
            return
        } catch {
            state = .failed(String(describing: error))
        }
    }

    func purchase(productID: String) async {
        state = .purchasing(productID: productID)
        do {
            let result = try await client.purchase(productID: productID)
            switch result {
            case .cancelled:
                state = .available(products)
            case .pending:
                state = .pending(productID: productID)
            case .awaitingServerVerification:
                state = .awaitingServerVerification(action: .purchase)
            }
        } catch is CancellationError {
            state = .available(products)
        } catch {
            state = .failed(String(describing: error))
        }
    }

    func restore() async {
        state = .restoring
        do {
            _ = try await client.restore()
            state = .awaitingServerVerification(action: .restore)
        } catch is CancellationError {
            state = .available(products)
        } catch {
            state = .failed(String(describing: error))
        }
    }

    /// RevenueCat CustomerInfo never calls this. Only the authenticated server
    /// response backed by the #168 ledger may promote advisory state to verified.
    func applyServerVerification(_ entitlement: ServerVerifiedSubscription) {
        state = .verified(entitlement)
    }
}
