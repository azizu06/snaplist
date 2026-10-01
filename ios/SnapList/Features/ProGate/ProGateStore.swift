import Foundation
import Observation

@MainActor
@Observable
final class ProGateStore {
    enum PrepareOutcome: Equatable {
        case presented
        case fallbackToPhotoReview
        /// The gate cannot open for this seller because they have no account
        /// yet, which is a different answer from "it did not work this time"
        /// and needs a different destination (#846).
        case fallbackToAccountClaim
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
        /// The App Store outcome is advisory; the server has not granted Pro.
        case verificationPending
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
    private let currentAccountID: @MainActor () -> String?
    private let ownerAccountID: String?
    private let confirmationTimeout: Duration
    private var deadlineTask: Task<Void, Never>?
    fileprivate var offerProduct: SubscriptionProductMetadata?
    /// The StoreKit product the offer showed, kept after the offer so the
    /// confirmation states draw the same plan the seller agreed to.
    var offeredProduct: SubscriptionProductMetadata? { offerProduct }
    private var pendingVerification: ReadySource?
    private var pendingVerificationID: UUID?

    init(
        mobileAPIClient: any MobileAPIClient,
        subscriptionClient: any SubscriptionClient,
        verificationAttempts: Int = 6,
        confirmationTimeout: Duration = .seconds(20),
        currentAccountID: @escaping @MainActor () -> String? = {
            ClerkAuthenticationComposition.currentUserID()
        },
        sleep: @escaping Sleep = { duration in
            try? await Task.sleep(for: duration)
        }
    ) {
        self.mobileAPIClient = mobileAPIClient
        subscriptionStore = SubscriptionStore(client: subscriptionClient)
        self.verificationAttempts = max(verificationAttempts, 1)
        self.sleep = sleep
        self.confirmationTimeout = confirmationTimeout
        self.currentAccountID = currentAccountID
        ownerAccountID = currentAccountID()
    }

    var isPresented: Bool {
        state != .hidden
    }

    var isDismissible: Bool {
        state != .confirming
    }

    var belongsToCurrentAccount: Bool {
        currentAccountID() == ownerAccountID
    }

    func accountChanged() {
        if !belongsToCurrentAccount { hide() }
    }

    func prepare() async -> PrepareOutcome {
        guard belongsToCurrentAccount else {
            hide()
            return .fallbackToAccountClaim
        }
        deadlineTask?.cancel()
        pendingVerification = nil
        let preparationID = UUID()
        pendingVerificationID = preparationID
        intakeAdvisory = nil

        let entitlement: ServerVerifiedSubscription
        do {
            entitlement = try await mobileAPIClient
                .getAiItemEntitlement()
                .data
                .serverVerifiedSubscription
        } catch MobileAPIClientError.unauthenticated(
            credential: .guestCapability
        ) {
            guard isCurrent(preparationID) else { return .fallbackToPhotoReview }
            // #846. A capability bearer proves an installation and never a
            // subject, and this route authenticates a Clerk subject, so its
            // refusal is not a failure to report — it is the account demand
            // itself. Everything past this read is Clerk-only too, so there is
            // no offer to fall back to and no reason to keep asking.
            hide()
            return .fallbackToAccountClaim
        } catch {
            guard isCurrent(preparationID) else { return .fallbackToPhotoReview }
            // Every other refusal, including a rejected Clerk session and a
            // phone with no signal, proves nothing about whether an account
            // exists. Those stay on the retry that can still succeed.
            hide()
            return .fallbackToPhotoReview
        }

        guard isCurrent(preparationID) else { return .fallbackToPhotoReview }

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
            guard isCurrent(preparationID) else { return .fallbackToPhotoReview }
            await subscriptionStore.load(configuration: configuration)
            guard isCurrent(preparationID) else { return .fallbackToPhotoReview }
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
            guard isCurrent(preparationID) else { return .fallbackToPhotoReview }
            hide()
            return .fallbackToPhotoReview
        }
    }

    func purchase() async {
        guard belongsToCurrentAccount,
              case .offer(let product, _, false) = state else { return }
        let verificationID = UUID()
        pendingVerification = .purchase
        pendingVerificationID = verificationID
        state = .confirming
        startDeadline(verificationID)
        await subscriptionStore.purchase(productID: product.id)
        guard isCurrent(verificationID) else { return }

        switch subscriptionStore.state {
        case .available:
            deadlineTask?.cancel()
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
            deadlineTask?.cancel()
            pendingVerification = nil
            pendingVerificationID = nil
            state = .offer(
                product: product,
                advisory: .purchaseDidNotComplete,
                isRestoring: false
            )
        case .verified(let entitlement):
            if Self.serverPermitsResume(entitlement) {
                deadlineTask?.cancel()
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
        guard belongsToCurrentAccount, let product = offerProduct,
              canRestore else {
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
        startDeadline(verificationID)
        await subscriptionStore.restore()
        guard isCurrent(verificationID) else {
            return .presented
        }

        switch subscriptionStore.state {
        case .restoreNotFound:
            deadlineTask?.cancel()
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
            deadlineTask?.cancel()
            pendingVerification = nil
            pendingVerificationID = nil
            state = .offer(
                product: product,
                advisory: nil,
                isRestoring: false
            )
        case .verified(let entitlement):
            if Self.serverPermitsResume(entitlement) {
                deadlineTask?.cancel()
                pendingVerification = nil
                pendingVerificationID = nil
                state = .ready(source: .restoredPurchase)
            }
        case .loading, .purchasing, .pending, .restoring:
            break
        }
        return .presented
    }

    /// Rechecks server truth without repeating the App Store purchase.
    func refreshPendingVerification() async {
        guard belongsToCurrentAccount, state == .verificationPending,
              pendingVerification != nil else { return }
        let verificationID = UUID()
        pendingVerificationID = verificationID
        state = .confirming
        startDeadline(verificationID)
        await verifyPendingEntitlement(verificationID: verificationID)
    }

    private var canRestore: Bool {
        if case .offer(_, _, false) = state { return true }
        return state == .verificationPending
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
        guard belongsToCurrentAccount, case .ready = state else { return false }
        hide()
        intakeAdvisory = nil
        return true
    }

    func fallbackToPhotoReview() {
        hide()
        intakeAdvisory = nil
    }

    private func verifyPendingEntitlement(verificationID: UUID) async {
        guard isCurrent(verificationID),
              let pendingVerification else { return }
        for attempt in 0..<verificationAttempts {
            if Task.isCancelled { break }
            let entitlement = try? await mobileAPIClient
                .getAiItemEntitlement()
                .data
                .serverVerifiedSubscription
            guard isCurrent(verificationID) else { return }
            if Task.isCancelled { break }
            if let entitlement,
               Self.serverPermitsResume(entitlement) {
                subscriptionStore.applyServerVerification(entitlement)
                state = .ready(source: pendingVerification)
                self.pendingVerification = nil
                pendingVerificationID = nil
                deadlineTask?.cancel()
                return
            }
            if attempt + 1 < verificationAttempts {
                await sleep(.seconds(1))
                guard isCurrent(verificationID) else { return }
            }
        }

        state = .verificationPending
        deadlineTask?.cancel()
    }

    private func isCurrent(_ id: UUID) -> Bool {
        guard belongsToCurrentAccount else {
            hide()
            return false
        }
        return pendingVerificationID == id
    }

    /// A hung SDK or HTTP call cannot hold the seller in a modal forever.
    /// Its result can still arrive, but only the current account/attempt may apply it.
    private func startDeadline(_ id: UUID) {
        deadlineTask?.cancel()
        let timeout = confirmationTimeout
        deadlineTask = Task { [weak self] in
            do { try await Task.sleep(for: timeout) } catch { return }
            guard let self, self.isCurrent(id) else { return }
            self.state = .verificationPending
        }
    }

    private func hide() {
        deadlineTask?.cancel()
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
    static func fixture(_ fixture: ProGateFixtureState, longMetadata: Bool = false) -> ProGateStore {
        let product = SubscriptionProductMetadata(
            id: "fixture-monthly",
            localizedTitle: longMetadata
                ? "SnapList Pro – Abonnement für monatliche KI-Angebote und bearbeitbare Verkaufsentwürfe"
                : "SnapList Pro",
            localizedDescription: "Fixture",
            localizedPrice: "$9.99",
            billingPeriod: .init(value: longMetadata ? 12 : 1, unit: .month)
        )
        if fixture.exercisesPurchase {
            return ProGateStore(
                mobileAPIClient: ProGatePurchaseFixtureAPI(fixture: fixture),
                subscriptionClient: FixtureSubscriptionClient(
                    products: [product],
                    purchaseOutcome: fixture == .purchaseCancelled ? .cancelled : .awaitingServerVerification
                ),
                verificationAttempts: 2,
                confirmationTimeout: .milliseconds(100),
                currentAccountID: { "fixture-purchase-user" },
                sleep: { _ in }
            )
        }
        let store = ProGateStore(
            mobileAPIClient: ZeroNetworkMobileAPIClient(),
            subscriptionClient: FixtureSubscriptionClient(products: [product])
        )
        store.offerProduct = product
        switch fixture {
        case .pay01, .pay01Plans:
            store.state = .offer(
                product: product,
                advisory: nil,
                isRestoring: false
            )
        case .pay03:
            store.state = .confirming
        case .pay04a, .pay04aPlans:
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
        case .purchaseVerified, .purchaseDelayed, .purchaseMissing, .purchaseIgnored,
             .purchaseTimeout, .purchaseCancelled:
            break
        }
        return store
    }
}
extension ProGateFixtureState {
    var exercisesPurchase: Bool {
        switch self {
        case .purchaseVerified, .purchaseDelayed, .purchaseMissing, .purchaseIgnored,
             .purchaseTimeout, .purchaseCancelled: true
        default: false
        }
    }
}

/// Controlled delivery at the public API seam; purchase runs the production store and sheet.
private actor ProGatePurchaseFixtureAPI: MobileAPIClient {
    let fixture: ProGateFixtureState
    var reads = 0
    init(fixture: ProGateFixtureState) { self.fixture = fixture }
    func getHealth() async throws -> HealthEnvelope { throw MobileAPIClientError.httpStatus(500) }
    func getSession() async throws -> SessionEnvelope { throw MobileAPIClientError.httpStatus(500) }
    func getActivationGuidance() async throws -> ActivationGuidanceEnvelope { throw MobileAPIClientError.httpStatus(500) }
    func completeActivationGuidance() async throws -> ActivationGuidanceEnvelope { throw MobileAPIClientError.httpStatus(500) }
    func getRevenueCatConfiguration() async throws -> RevenueCatConfigurationEnvelope {
        .init(data: .init(configured: true, appUserId: "fixture-purchase-user", publicSdkKey: "appl_fixture", entitlementId: "pro", monthlyProductId: "fixture-monthly", offeringId: nil, transitionState: .notRequired, legacyStripeStatus: nil), meta: .init(requestId: "fixture-configuration"))
    }
    func getAiItemEntitlement() async throws -> AiItemEntitlementEnvelope {
        reads += 1
        if reads > 1, fixture == .purchaseMissing { throw MobileAPIClientError.httpStatus(503) }
        // Long enough that the timed-out pending state stays on screen while a
        // UI test waits out the paywall's state animations before reading it.
        if reads > 1, fixture == .purchaseTimeout { try await Task.sleep(for: .seconds(30)) }
        let granted = reads > 1 && (fixture == .purchaseVerified || fixture == .purchaseTimeout)
            || reads > 3 && fixture == .purchaseDelayed
        return .init(data: .init(billingSource: granted ? .storeKit : .included, status: granted ? .active : .included, remainingItems: granted ? 7 : 1, periodStart: nil, periodEnd: nil, gracePeriodEnd: nil, transitionState: .notRequired, legacyStripeStatus: nil), meta: .init(requestId: "fixture-entitlement"))
    }
}
#endif
