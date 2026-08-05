import Foundation
import Observation

@MainActor
@Observable
final class ProGateStore {
    enum PrepareOutcome: Equatable {
        case presented
        case fallbackToPhotoReview
    }

    enum Advisory: Equatable {
        case purchaseDidNotComplete
        case nothingToRestore
    }

    enum ReadySource: Equatable {
        case purchase
        case restoredPurchase
        case existingSubscription
    }

    enum State: Equatable {
        case hidden
        case offer(
            product: SubscriptionProductMetadata,
            advisory: Advisory?,
            isRestoring: Bool
        )
        case confirming
        case ready(source: ReadySource)
    }

    enum IntakeAdvisory: Equatable {
        case needsPro(eventID: UUID)
    }

    typealias Sleep = @Sendable (Duration) async -> Void

    fileprivate(set) var state: State = .hidden
    private(set) var intakeAdvisory: IntakeAdvisory?

    private let mobileAPIClient: any MobileAPIClient
    private let subscriptionStore: SubscriptionStore
    private let verificationAttempts: Int
    private let sleep: Sleep
    fileprivate var offerProduct: SubscriptionProductMetadata?
    private var pendingVerification: ReadySource?
    private var pendingVerificationID: UUID?

    init(
        mobileAPIClient: any MobileAPIClient,
        subscriptionClient: any SubscriptionClient,
        verificationAttempts: Int = 6,
        sleep: @escaping Sleep = { duration in
            try? await Task.sleep(for: duration)
        }
    ) {
        self.mobileAPIClient = mobileAPIClient
        subscriptionStore = SubscriptionStore(client: subscriptionClient)
        self.verificationAttempts = max(verificationAttempts, 1)
        self.sleep = sleep
    }

    var isPresented: Bool {
        state != .hidden
    }

    var isDismissible: Bool {
        state != .confirming
    }

    func prepare() async -> PrepareOutcome {
        pendingVerification = nil
        pendingVerificationID = nil
        intakeAdvisory = nil

        let entitlement: ServerVerifiedSubscription
        do {
            entitlement = try await mobileAPIClient
                .getAiItemEntitlement()
                .data
                .serverVerifiedSubscription
        } catch {
            hide()
            return .fallbackToPhotoReview
        }

        if Self.serverPermitsResume(entitlement) {
            state = .ready(source: .existingSubscription)
            return .presented
        }

        if Self.requiresPhotoReviewFallback(entitlement) {
            hide()
            return .fallbackToPhotoReview
        }

        do {
            let configuration = try await mobileAPIClient
                .getRevenueCatConfiguration()
                .data
                .subscriptionConfiguration
            await subscriptionStore.load(configuration: configuration)
            guard case .available(let products) = subscriptionStore.state,
                  let productID = configuration.monthlyProductID,
                  let product = products.first(where: { $0.id == productID })
            else {
                hide()
                return .fallbackToPhotoReview
            }
            offerProduct = product
            state = .offer(
                product: product,
                advisory: nil,
                isRestoring: false
            )
            return .presented
        } catch {
            hide()
            return .fallbackToPhotoReview
        }
    }

    func purchase() async {
        guard case .offer(let product, _, _) = state else { return }
        let verificationID = UUID()
        pendingVerification = .purchase
        pendingVerificationID = verificationID
        state = .confirming
        await subscriptionStore.purchase(productID: product.id)
        guard pendingVerificationID == verificationID else { return }

        switch subscriptionStore.state {
        case .available:
            pendingVerification = nil
            pendingVerificationID = nil
            state = .offer(
                product: product,
                advisory: nil,
                isRestoring: false
            )
        case .pending, .awaitingServerVerification:
            await verifyPendingEntitlement(verificationID: verificationID)
        case .failed:
            pendingVerification = nil
            pendingVerificationID = nil
            state = .offer(
                product: product,
                advisory: .purchaseDidNotComplete,
                isRestoring: false
            )
        case .verified(let entitlement):
            if Self.serverPermitsResume(entitlement) {
                pendingVerification = nil
                pendingVerificationID = nil
                state = .ready(source: .purchase)
            }
        case .unconfigured, .loading, .purchasing, .restoring,
             .restoreNotFound:
            break
        }
    }

    func restore() async -> PrepareOutcome {
        guard case .offer(let product, _, _) = state else {
            return .presented
        }
        let verificationID = UUID()
        pendingVerification = .restoredPurchase
        pendingVerificationID = verificationID
        state = .offer(
            product: product,
            advisory: nil,
            isRestoring: true
        )
        await subscriptionStore.restore()
        guard pendingVerificationID == verificationID else {
            return .presented
        }

        switch subscriptionStore.state {
        case .restoreNotFound:
            pendingVerification = nil
            pendingVerificationID = nil
            state = .offer(
                product: product,
                advisory: .nothingToRestore,
                isRestoring: false
            )
        case .awaitingServerVerification:
            await verifyPendingEntitlement(verificationID: verificationID)
        case .failed, .unconfigured:
            hide()
            return .fallbackToPhotoReview
        case .available:
            pendingVerification = nil
            pendingVerificationID = nil
            state = .offer(
                product: product,
                advisory: nil,
                isRestoring: false
            )
        case .verified(let entitlement):
            if Self.serverPermitsResume(entitlement) {
                pendingVerification = nil
                pendingVerificationID = nil
                state = .ready(source: .restoredPurchase)
            }
        case .loading, .purchasing, .pending, .restoring:
            break
        }
        return .presented
    }

    /// PAY-03 and PAY-07 remain truthful while the server bridge catches up.
    /// The excluded pending/unavailable screens are never synthesized here.
    func refreshPendingVerification() async {
        guard let pendingVerificationID else { return }
        await verifyPendingEntitlement(verificationID: pendingVerificationID)
    }

    func dismiss() {
        guard isDismissible else { return }
        let wasOffer: Bool
        if case .offer = state {
            wasOffer = true
        } else {
            wasOffer = false
        }
        hide()
        if wasOffer {
            intakeAdvisory = .needsPro(eventID: UUID())
        }
    }

    func consumeResumeIntent() -> Bool {
        guard case .ready = state else { return false }
        hide()
        intakeAdvisory = nil
        return true
    }

    func fallbackToPhotoReview() {
        hide()
        intakeAdvisory = nil
    }

    private func verifyPendingEntitlement(verificationID: UUID) async {
        guard pendingVerificationID == verificationID,
              let pendingVerification else { return }
        for attempt in 0..<verificationAttempts {
            let entitlement = try? await mobileAPIClient
                .getAiItemEntitlement()
                .data
                .serverVerifiedSubscription
            guard pendingVerificationID == verificationID else { return }
            if let entitlement,
               Self.serverPermitsResume(entitlement) {
                subscriptionStore.applyServerVerification(entitlement)
                state = .ready(source: pendingVerification)
                self.pendingVerification = nil
                pendingVerificationID = nil
                return
            }
            if attempt + 1 < verificationAttempts {
                await sleep(.seconds(1))
                guard pendingVerificationID == verificationID else { return }
            }
        }

        // Purchase pending and delayed bridge delivery remain on PAY-03. A
        // restore with an active local entitlement remains PAY-07. Neither
        // path invents the excluded PAY-05 or PAY-09 states.
        switch pendingVerification {
        case .purchase:
            state = .confirming
        case .restoredPurchase:
            if let offerProduct {
                state = .offer(
                    product: offerProduct,
                    advisory: nil,
                    isRestoring: true
                )
            }
        case .existingSubscription:
            break
        }
    }

    private func hide() {
        state = .hidden
        pendingVerification = nil
        pendingVerificationID = nil
    }

    private static func serverPermitsResume(
        _ entitlement: ServerVerifiedSubscription
    ) -> Bool {
        entitlement.source == .storeKit
            && (entitlement.status == .active
                || entitlement.status == .grace
                || entitlement.status == .billingRetry)
            && entitlement.remainingItems > 0
    }

    private static func requiresPhotoReviewFallback(
        _ entitlement: ServerVerifiedSubscription
    ) -> Bool {
        if entitlement.status == .ambiguous
            || entitlement.status == .unconfigured {
            return true
        }

        return entitlement.source == .storeKit
            && (entitlement.status == .active
                || entitlement.status == .grace
                || entitlement.status == .billingRetry)
            && entitlement.remainingItems <= 0
    }
}

#if DEBUG
extension ProGateStore {
    static func fixture(_ fixture: ProGateFixtureState) -> ProGateStore {
        let product = SubscriptionProductMetadata(
            id: "fixture-monthly",
            localizedTitle: "SnapList Pro",
            localizedDescription: "Fixture",
            localizedPrice: "$9.99",
            billingPeriod: .init(value: 1, unit: .month)
        )
        let store = ProGateStore(
            mobileAPIClient: ZeroNetworkMobileAPIClient(),
            subscriptionClient: FixtureSubscriptionClient(products: [product])
        )
        store.offerProduct = product
        switch fixture {
        case .pay01:
            store.state = .offer(
                product: product,
                advisory: nil,
                isRestoring: false
            )
        case .pay03:
            store.state = .confirming
        case .pay04a:
            store.state = .ready(source: .purchase)
        case .pay04b:
            store.state = .ready(source: .existingSubscription)
        case .pay06:
            store.state = .offer(
                product: product,
                advisory: .purchaseDidNotComplete,
                isRestoring: false
            )
        case .pay07:
            store.state = .offer(
                product: product,
                advisory: nil,
                isRestoring: true
            )
        case .pay08:
            store.state = .offer(
                product: product,
                advisory: .nothingToRestore,
                isRestoring: false
            )
        case .pay10:
            store.state = .hidden
        }
        return store
    }
}
#endif
