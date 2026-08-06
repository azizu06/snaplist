import Foundation
#if DEBUG
import UIKit
#endif

protocol MobileAPIClient {
    func getHealth() async throws -> HealthEnvelope
    func getSession() async throws -> SessionEnvelope
    func getActivationGuidance() async throws -> ActivationGuidanceEnvelope
    func completeActivationGuidance() async throws -> ActivationGuidanceEnvelope
    func getRevenueCatConfiguration() async throws -> RevenueCatConfigurationEnvelope
    func getAiItemEntitlement() async throws -> AiItemEntitlementEnvelope
}

protocol ContractOnlyFixtureProviding {
    func fixture(for operation: ContractOnlyOperation) -> ContractOnlyFixture
}

enum MobileAPIClientError: Error, Equatable {
    case invalidResponse
    case httpStatus(Int)
}

struct URLSessionMobileAPIClient: MobileAPIClient {
    private let baseURL: URL
    private let tokenProvider: any BearerTokenProviding
    private let session: URLSession
    private let decoder: JSONDecoder

    init(
        baseURL: URL,
        tokenProvider: any BearerTokenProviding,
        session: URLSession = .shared
    ) {
        self.baseURL = baseURL
        self.tokenProvider = tokenProvider
        self.session = session
        self.decoder = JSONDecoder()
    }

    func getHealth() async throws -> HealthEnvelope {
        try await send(path: "/v1/health", method: "GET", bearerToken: nil)
    }

    func getSession() async throws -> SessionEnvelope {
        try await sendAuthenticated(path: "/v1/session", method: "GET")
    }

    func getActivationGuidance() async throws -> ActivationGuidanceEnvelope {
        try await sendAuthenticated(path: "/v1/activation-guidance", method: "GET")
    }

    func completeActivationGuidance() async throws -> ActivationGuidanceEnvelope {
        try await sendAuthenticated(path: "/v1/activation-guidance", method: "POST")
    }

    func getRevenueCatConfiguration() async throws -> RevenueCatConfigurationEnvelope {
        try await sendAuthenticated(
            path: "/v1/billing/revenuecat/identity",
            method: "POST"
        )
    }

    func getAiItemEntitlement() async throws -> AiItemEntitlementEnvelope {
        try await sendAuthenticated(
            path: "/v1/entitlements/ai-items",
            method: "GET"
        )
    }

    private func sendAuthenticated<Response: Decodable>(
        path: String,
        method: String
    ) async throws -> Response {
        let bearerToken = try await tokenProvider.bearerToken()
        return try await send(
            path: path,
            method: method,
            bearerToken: bearerToken
        )
    }

    private func send<Response: Decodable>(
        path: String,
        method: String,
        bearerToken: String?
    ) async throws -> Response {
        let url = baseURL.appending(path: path)
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let bearerToken {
            request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        }

        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw MobileAPIClientError.invalidResponse
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            throw MobileAPIClientError.httpStatus(httpResponse.statusCode)
        }
        return try decoder.decode(Response.self, from: data)
    }
}

/**
 Issue #524. The three included-offer redemption calls, kept off `MobileAPIClient`
 so a surface that has no business minting the promotion cannot reach them.
 */
protocol IncludedOfferRedeeming: Sendable {
    func redeemIncludedOffer(
        idempotencyKey: String,
        proof: AppAttestProofPayload
    ) async throws -> IncludedOfferOutcome
    func readIncludedOfferClaim(claimID: String) async throws -> IncludedOfferOutcome
    func submitIncludedOfferDeviceToken(
        claimID: String,
        deviceToken: String,
        proof: AppAttestProofPayload
    ) async throws -> IncludedOfferOutcome
}

/**
 The exact bytes an App Attest assertion signs for a redemption request.

 This must reproduce `canonicalRedemptionRequest` in
 `src/lib/included-offer-fence/contract.ts` byte for byte: the server hashes its
 own reconstruction and compares, so one differing character fails verification
 rather than degrading. `.sortedKeys` supplies the alphabetical key order that
 file fixes by construction, and `userId` is the verified Clerk subject — signing
 a different identity produces a hash the server will not reproduce.
 */
enum IncludedOfferCanonicalRequest {
    static let schemaVersion = 1

    private struct RedeemPayload: Encodable {
        let action = "included-offer.redeem"
        let idempotencyKey: String
        let schemaVersion = IncludedOfferCanonicalRequest.schemaVersion
        let userId: String
    }

    private struct DeviceTokenPayload: Encodable {
        let action = "included-offer.device-token"
        let claimId: String
        let schemaVersion = IncludedOfferCanonicalRequest.schemaVersion
        let userId: String
    }

    static func redeem(idempotencyKey: String, userID: String) throws -> Data {
        try encoder.encode(
            RedeemPayload(idempotencyKey: idempotencyKey, userId: userID)
        )
    }

    static func deviceToken(claimID: String, userID: String) throws -> Data {
        try encoder.encode(
            DeviceTokenPayload(claimId: claimID, userId: userID)
        )
    }

    private static var encoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }
}

extension URLSessionMobileAPIClient: IncludedOfferRedeeming {
    func redeemIncludedOffer(
        idempotencyKey: String,
        proof: AppAttestProofPayload
    ) async throws -> IncludedOfferOutcome {
        try await sendIncludedOffer(
            path: "/v1/included-offer/redemptions",
            method: "POST",
            idempotencyKey: idempotencyKey,
            body: IncludedOfferRedeemBody(appAttest: proof)
        )
    }

    func readIncludedOfferClaim(claimID: String) async throws -> IncludedOfferOutcome {
        try await sendIncludedOffer(
            path: "/v1/included-offer/redemptions/\(claimID)",
            method: "GET",
            idempotencyKey: nil,
            body: Optional<IncludedOfferRedeemBody>.none
        )
    }

    func submitIncludedOfferDeviceToken(
        claimID: String,
        deviceToken: String,
        proof: AppAttestProofPayload
    ) async throws -> IncludedOfferOutcome {
        try await sendIncludedOffer(
            path: "/v1/included-offer/redemptions/\(claimID)/device-token",
            method: "POST",
            idempotencyKey: nil,
            body: IncludedOfferDeviceTokenBody(
                appAttest: proof,
                deviceToken: deviceToken
            )
        )
    }

    private func sendIncludedOffer<Body: Encodable>(
        path: String,
        method: String,
        idempotencyKey: String?,
        body: Body?
    ) async throws -> IncludedOfferOutcome {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(
            "Bearer \(try await tokenProvider.bearerToken())",
            forHTTPHeaderField: "Authorization"
        )
        if let idempotencyKey {
            request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        }
        if let body {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
            request.httpBody = try encoder.encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw MobileAPIClientError.invalidResponse
        }
        // A refusal here is the fence answering, so its body is decoded like any
        // other outcome. Only a status carrying no outcome at all — an auth
        // failure, a 5xx — stays a transport error.
        do {
            return try decoder.decode(IncludedOfferEnvelope.self, from: data).data
        } catch {
            guard (200..<300).contains(httpResponse.statusCode) else {
                throw MobileAPIClientError.httpStatus(httpResponse.statusCode)
            }
            throw MobileAPIClientError.invalidResponse
        }
    }
}

/**
 Composes the redemption: Apple's two device primitives plus the three calls.

 Nothing here decides whether the promotion is owed. The client produces
 evidence and the server decides, which is what keeps a jailbroken or patched
 build from granting itself an included run.
 */
struct IncludedOfferRedemption: Sendable {
    enum Result: Equatable, Sendable {
        case outcome(IncludedOfferOutcome)
        /// `DCDevice.isSupported` is false — Simulator, or hardware without it.
        case deviceUnsupported
        /// Apple could not mint a token right now; the claim stays retryable.
        case deviceTokenUnavailable
        case proofUnavailable(AppAttestUnavailableReason)
        case proofInvalid(AppAttestInvalidReason)
        case transportUnavailable
    }

    private let attest: any AppAttestProofProviding
    private let client: any IncludedOfferRedeeming
    private let deviceCheck: any DeviceCheckTokenProviding
    private let userID: String

    init(
        attest: any AppAttestProofProviding,
        client: any IncludedOfferRedeeming,
        deviceCheck: any DeviceCheckTokenProviding = AppleDeviceCheckTokenProvider(),
        userID: String
    ) {
        self.attest = attest
        self.client = client
        self.deviceCheck = deviceCheck
        self.userID = userID
    }

    /**
     Opens one redemption claim.

     The DeviceCheck gate runs before the network on purpose: a device that can
     never mint a token can never answer the rendezvous, so opening a claim
     would leave the seller waiting on a promotion this hardware cannot collect.
     The honest answer is `.deviceUnsupported` and the paid path.
     */
    func redeem(idempotencyKey: String) async -> Result {
        guard deviceCheck.isSupported else { return .deviceUnsupported }
        let requestBody: Data
        do {
            requestBody = try IncludedOfferCanonicalRequest.redeem(
                idempotencyKey: idempotencyKey,
                userID: userID
            )
        } catch {
            return .transportUnavailable
        }
        switch await attest.assertionProof(requestBody: requestBody) {
        case .unavailable(let reason):
            return .proofUnavailable(reason)
        case .invalid(let reason):
            return .proofInvalid(reason)
        case .proof(let proof):
            do {
                return .outcome(try await client.redeemIncludedOffer(
                    idempotencyKey: idempotencyKey,
                    proof: AppAttestProofPayload(proof)
                ))
            } catch {
                return .transportUnavailable
            }
        }
    }

    /**
     Answers a `device_token_required` claim with a fresh token and a fresh proof
     signed over that claim.

     The token is minted before the proof and the submission only happens with
     both in hand: posting without a real Apple token would spend the bounded
     rendezvous window on evidence Apple never issued.
     */
    func answerTokenRendezvous(claimID: String) async -> Result {
        guard deviceCheck.isSupported else { return .deviceUnsupported }
        let deviceToken: Data
        do {
            deviceToken = try await deviceCheck.generateToken()
        } catch {
            return .deviceTokenUnavailable
        }
        let requestBody: Data
        do {
            requestBody = try IncludedOfferCanonicalRequest.deviceToken(
                claimID: claimID,
                userID: userID
            )
        } catch {
            return .transportUnavailable
        }
        switch await attest.assertionProof(requestBody: requestBody) {
        case .unavailable(let reason):
            return .proofUnavailable(reason)
        case .invalid(let reason):
            return .proofInvalid(reason)
        case .proof(let proof):
            do {
                return .outcome(try await client.submitIncludedOfferDeviceToken(
                    claimID: claimID,
                    deviceToken: deviceToken.base64EncodedString(),
                    proof: AppAttestProofPayload(proof)
                ))
            } catch {
                return .transportUnavailable
            }
        }
    }

    /** Reads durable claim state while the seller waits. Carries no proof. */
    func readClaim(claimID: String) async -> Result {
        do {
            return .outcome(try await client.readIncludedOfferClaim(claimID: claimID))
        } catch {
            return .transportUnavailable
        }
    }
}

struct ZeroNetworkMobileAPIClient: MobileAPIClient, ContractOnlyFixtureProviding {
    func getHealth() async throws -> HealthEnvelope {
        HealthEnvelope(
            data: .init(apiVersion: "v1", status: "ok"),
            meta: .init(requestId: "fixture-health")
        )
    }

    func getSession() async throws -> SessionEnvelope {
        SessionEnvelope(
            data: .init(userId: "fixture-clerk-user"),
            meta: .init(requestId: "fixture-session")
        )
    }

    func getActivationGuidance() async throws -> ActivationGuidanceEnvelope {
        .init(
            data: .init(
                completed: UserDefaults.standard.bool(
                    forKey: "snaplist.fixture-activation-guidance-completed"
                )
            ),
            meta: .init(requestId: "fixture-activation-guidance")
        )
    }

    func completeActivationGuidance() async throws -> ActivationGuidanceEnvelope {
        UserDefaults.standard.set(
            true,
            forKey: "snaplist.fixture-activation-guidance-completed"
        )
        .init(data: .init(completed: true), meta: .init(requestId: "fixture-activation-guidance"))
    }

    func getRevenueCatConfiguration() async throws -> RevenueCatConfigurationEnvelope {
        RevenueCatConfigurationEnvelope(
            data: .init(
                configured: false,
                appUserId: "fixture-clerk-user",
                publicSdkKey: nil,
                entitlementId: nil,
                monthlyProductId: nil,
                offeringId: nil,
                transitionState: nil,
                legacyStripeStatus: nil
            ),
            meta: .init(requestId: "fixture-revenuecat-configuration")
        )
    }

    func getAiItemEntitlement() async throws -> AiItemEntitlementEnvelope {
        AiItemEntitlementEnvelope(
            data: .init(
                billingSource: .included,
                status: .included,
                remainingItems: 1,
                periodStart: nil,
                periodEnd: nil,
                gracePeriodEnd: nil,
                transitionState: .notRequired,
                legacyStripeStatus: nil
            ),
            meta: .init(requestId: "fixture-ai-item-entitlement")
        )
    }

    func fixture(for operation: ContractOnlyOperation) -> ContractOnlyFixture {
        .metadata(for: operation)
    }
}

/// The build-supplied facts analytics client selection depends on. Every value
/// is injected so the decision is provable without a bundle, a device, or a
/// running SDK; `current` is the only place that reads the real build.
struct AnalyticsLaunchInputs {
    let projectKeyBundleValue: String?
    let hostBundleValue: String?
    let infoDictionary: [String: Any]
    let isDebugBuild: Bool
    let hasSandboxAppStoreReceipt: Bool
    let hasLoadedXCTest: Bool

    static var current: AnalyticsLaunchInputs {
        let bundle = Bundle.main
        let isDebugBuild: Bool
#if DEBUG
        isDebugBuild = true
#else
        isDebugBuild = false
#endif
        return AnalyticsLaunchInputs(
            projectKeyBundleValue: bundle.object(
                forInfoDictionaryKey: "SnapListPostHogKey"
            ) as? String,
            hostBundleValue: bundle.object(
                forInfoDictionaryKey: "SnapListPostHogHost"
            ) as? String,
            infoDictionary: bundle.infoDictionary ?? [:],
            isDebugBuild: isDebugBuild,
            hasSandboxAppStoreReceipt:
                bundle.appStoreReceiptURL?.lastPathComponent == "sandboxReceipt",
            hasLoadedXCTest: NSClassFromString("XCTestCase") != nil
        )
    }
}

/// Decides whether app composition builds the real PostHog client and under
/// which environment tag, or none at all.
///
/// A unit-test host is caught directly because it loads XCTest. A real app,
/// including Debug and UI-test builds, keeps analytics enabled by default and
/// emits `build_type=debug` so development traffic stays distinct in dashboards.
enum AnalyticsLaunchPolicy {
    /// Which build channel produced this binary. Kept separate from `decide`
    /// because the two answer different questions: this one names the channel,
    /// `decide` says whether the channel may transmit.
    static func resolveEnvironment(
        isDebugBuild: Bool,
        hasSandboxAppStoreReceipt: Bool
    ) -> AnalyticsEnvironment {
        if isDebugBuild {
            return .local
        }
        return hasSandboxAppStoreReceipt ? .testFlight : .production
    }

    static func decide(
        _ inputs: AnalyticsLaunchInputs
    ) -> AnalyticsPostHogConfiguration? {
        guard !inputs.hasLoadedXCTest else {
            return nil
        }
        guard let projectToken = usableBundleValue(inputs.projectKeyBundleValue),
              let hostValue = usableBundleValue(inputs.hostBundleValue),
              let host = URL(string: hostValue) else {
            return nil
        }
        let environment = resolveEnvironment(
            isDebugBuild: inputs.isDebugBuild,
            hasSandboxAppStoreReceipt: inputs.hasSandboxAppStoreReceipt
        )
        guard let metadata = AnalyticsMetadata.resolve(
            environment: environment,
            infoDictionary: inputs.infoDictionary
        ) else {
            return nil
        }
        return AnalyticsPostHogConfiguration(
            metadata: metadata,
            projectToken: projectToken,
            host: host
        )
    }

    /// An unset build setting reaches the bundle as the literal `$(NAME)`, and
    /// an xcconfig value keeps the whitespace around it. Both fail closed here
    /// rather than becoming a project key or host the ingest endpoint rejects.
    /// `AnalyticsPostHogConfiguration` validates the surviving value again.
    static func usableBundleValue(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let trimmed, !trimmed.isEmpty, !trimmed.hasPrefix("$(") else {
            return nil
        }
        return trimmed
    }
}

struct AppDependencies {
    let mobileAPIClient: any MobileAPIClient
    let contractFixtureProvider: any ContractOnlyFixtureProviding
    let cameraAuthorization: any CameraAuthorizationProviding
    let onboardingProgressStore: any OnboardingProgressPersisting
    let stagedLibraryPhotos: any StagedLibraryPhotoPersisting
    let guestAllowance: any GuestAllowanceCapability
    let captureCamera: any CaptureCamera
    let framingEvaluator: any FramingEvaluating
    let nativeIntake: NativeIntake
    // #543 still reads the legacy submission draft until its principal-generation
    // fence lands. Production Scan and Photo Review never receive this store.
    let captureDraftStore: any CaptureDraftStoring
    let subscriptionClient: any SubscriptionClient
    let analyticsClient: any AnalyticsClient
    let funnelAnalytics: any FunnelAnalyticsEventSinking
    let assistedExportService: any AssistedExportServing
    let ebayPublishService: any EbayPublishFeatureServing
    let guestClaimService: any GuestClaimServing
    let guestAccountAuthenticator: any GuestAccountAuthenticating
    let guestClaimAuthorityStore: any GuestClaimAuthorityStoring
    let ebayOAuthCallbackURL: URL

    static func make(
        configuration: LaunchConfiguration,
        apiOrigin: URL? = HomeRepositoryFactory.defaultAPIOrigin,
        tokenProvider: any BearerTokenProviding = UnavailableBearerTokenProvider(),
        nativeIntakeIdentitySource: NativeIntake.IdentitySource = .processPrivate,
        nativeIntakeApplicationSupportDirectory: URL? = nil,
        analyticsLaunchInputs: AnalyticsLaunchInputs = .current,
        analyticsTransportFactory: any PostHogTransportBuilding =
            PostHogSDKTransportFactory(),
        session: URLSession = .shared
    ) -> AppDependencies {
        let cameraAuthorization: any CameraAuthorizationProviding
        if let fixtureStatus = configuration.cameraAuthorizationFixture {
            cameraAuthorization = FixtureCameraAuthorizationClient(status: fixtureStatus)
        } else {
            cameraAuthorization = AVCameraAuthorizationClient()
        }
        let captureDraftStore = makeCaptureDraftStore(configuration: configuration)
        let captureCamera = makeCaptureCamera(configuration: configuration)
        let resolvedNativeIntakeIdentitySource:
            NativeIntake.IdentitySource
#if DEBUG
        if configuration.usesRestoredCaptureFixture {
            resolvedNativeIntakeIdentitySource = .processPrivate
        } else {
            resolvedNativeIntakeIdentitySource =
                nativeIntakeIdentitySource
        }
#else
        resolvedNativeIntakeIdentitySource =
            nativeIntakeIdentitySource
#endif
        let nativeIntake = NativeIntake(
            applicationSupportDirectory:
                nativeIntakeApplicationSupportDirectory
                ?? FileManager.default.urls(
                    for: .applicationSupportDirectory,
                    in: .userDomainMask
                ).first
                ?? FileManager.default.temporaryDirectory,
            identitySource: resolvedNativeIntakeIdentitySource
        )
        if configuration.usesZeroNetworkFixtures {
            let client = ZeroNetworkMobileAPIClient()
            return AppDependencies(
                mobileAPIClient: client,
                contractFixtureProvider: client,
                cameraAuthorization: cameraAuthorization,
                onboardingProgressStore: InMemoryOnboardingProgressStore(),
                stagedLibraryPhotos: InMemoryStagedLibraryPhotoStore(),
                guestAllowance: DeferredGuestAllowanceCapability(),
                captureCamera: captureCamera,
                framingEvaluator: VisionObjectFramingEvaluator(),
                nativeIntake: nativeIntake,
                captureDraftStore: captureDraftStore,
                subscriptionClient: FixtureSubscriptionClient(),
                // A zero-network build must never transmit, whatever the build
                // configured, so the fixture composition stays no-op.
                analyticsClient: NoOpAnalyticsClient(),
                funnelAnalytics: NoOpFunnelAnalyticsEventSink(),
                assistedExportService: AssistedExportFixtureService(),
                ebayPublishService: UnavailableEbayPublishFeatureService(),
                guestClaimService: UnavailableGuestClaimService(),
                guestAccountAuthenticator:
                    UnavailableGuestAccountAuthenticator(),
                guestClaimAuthorityStore: NoopGuestClaimAuthorityStore(),
                ebayOAuthCallbackURL: URL(
                    string: "https://snaplist.dev/mobile/ebay/oauth"
                )!
            )
        }

        let origin = apiOrigin ?? URL(string: "http://127.0.0.1:3001")!

        let appAttest = AppAttestClient(
            appID: "35YFS8XJRQ.dev.snaplist.ios",
            environment: .production,
            server: URLSessionAppAttestServerClient(
                apiOrigin: origin,
                session: session
            )
        )
        let analyticsClient = makeAnalyticsClient(
            launchInputs: analyticsLaunchInputs,
            transportFactory: analyticsTransportFactory
        )
        return AppDependencies(
            mobileAPIClient: URLSessionMobileAPIClient(
                baseURL: origin,
                tokenProvider: tokenProvider
            ),
            contractFixtureProvider: ZeroNetworkMobileAPIClient(),
            cameraAuthorization: cameraAuthorization,
            onboardingProgressStore: UserDefaultsOnboardingProgressStore(),
            stagedLibraryPhotos: FileSystemStagedLibraryPhotoStore(),
            guestAllowance: DeferredGuestAllowanceCapability(),
            captureCamera: captureCamera,
            framingEvaluator: VisionObjectFramingEvaluator(),
            nativeIntake: nativeIntake,
            captureDraftStore: captureDraftStore,
            subscriptionClient: RevenueCatSubscriptionClient(),
            analyticsClient: analyticsClient,
            funnelAnalytics: AnalyticsFunnelEventSink(client: analyticsClient),
            assistedExportService: AssistedExportAPIClient(
                baseURL: origin,
                tokenProvider: tokenProvider,
                session: session
            ),
            ebayPublishService: EbayPublishAPIClient(
                baseURL: origin,
                tokenProvider: tokenProvider,
                session: session
            ),
            guestClaimService: GuestClaimAPIClient(
                baseURL: origin,
                proofProvider: appAttest,
                tokenProvider: tokenProvider,
                handoffStore: KeychainGuestClaimHandoffStore(),
                session: session
            ),
            guestAccountAuthenticator: ClerkGuestAccountAuthenticator(),
            guestClaimAuthorityStore: KeychainGuestClaimAuthorityStore(),
            ebayOAuthCallbackURL: origin.appending(
                path: "/mobile/ebay/oauth"
            )
        )
    }

    /// Builds the analytics client app composition uses. The dependencies are
    /// `@autoclosure` so an invalid configuration or unit-test host does not
    /// construct durable stores — `UserDefaultsAnalyticsIdentityStore` mints
    /// and persists an anonymous id in its initializer.
    static func makeAnalyticsClient(
        launchInputs: AnalyticsLaunchInputs = .current,
        transportFactory: any PostHogTransportBuilding = PostHogSDKTransportFactory(),
        consentStore: @autoclosure () -> any AnalyticsConsentStoring =
            UserDefaultsAnalyticsConsentStore(),
        dedupeStore: @autoclosure () -> any AnalyticsDedupeStoring =
            UserDefaultsAnalyticsDedupeStore(),
        identityStore: @autoclosure () -> any AnalyticsIdentityStoring =
            UserDefaultsAnalyticsIdentityStore(),
        lifecycleStore: @autoclosure () -> any AnalyticsTransportLifecycleStoring =
            FileAnalyticsTransportLifecycleStore(),
        dataPurger: @autoclosure () -> (any PostHogDurableDataPurging)? =
            FileSystemPostHogDataPurger()
    ) -> any AnalyticsClient {
        guard let configuration = AnalyticsLaunchPolicy.decide(launchInputs),
              let dataPurger = dataPurger() else {
            return NoOpAnalyticsClient()
        }
        return PostHogAnalyticsClient(
            configuration: configuration,
            consentStore: consentStore(),
            dedupeStore: dedupeStore(),
            identityStore: identityStore(),
            lifecycleStore: lifecycleStore(),
            dataPurger: dataPurger,
            transportFactory: transportFactory
        )
    }

    private static func makeCaptureCamera(
        configuration: LaunchConfiguration
    ) -> any CaptureCamera {
#if DEBUG
        if configuration.usesRestoredCaptureFixture {
            return RestoredCaptureFixtureCamera()
        }
#endif
        return AVFoundationCaptureCamera()
    }

    private static func makeCaptureDraftStore(
        configuration: LaunchConfiguration
    ) -> any CaptureDraftStoring {
#if DEBUG
        if configuration.usesRestoredCaptureFixture {
            return RestoredCaptureFixtureStore()
        }
#endif
        return LocalCaptureDraftStore()
    }
}

#if DEBUG
extension AppDependencies {
    @MainActor
    func seedRestoredCaptureFixtureIfNeeded(
        configuration: LaunchConfiguration
    ) async {
        guard configuration.usesRestoredCaptureFixture else {
            return
        }

        let events = await nativeIntake.events()
        var iterator = events.makeAsyncIterator()
        guard case .snapshot(let initialSnapshot) = await iterator.next()
        else {
            return
        }
        if !initialSnapshot.photos.isEmpty
            || initialSnapshot.voice != nil {
            guard await nativeIntake.perform(
                .discard(expected: initialSnapshot.version)
            ) == .committed else {
                return
            }
        }

        let renderer = UIGraphicsImageRenderer(
            size: CGSize(width: 16, height: 16)
        )
        let photoData = renderer.jpegData(
            withCompressionQuality: 0.9
        ) { context in
            UIColor.systemTeal.setFill()
            context.fill(
                CGRect(x: 0, y: 0, width: 16, height: 16)
            )
        }
        let result = await nativeIntake.performReturningSnapshot(
            .addPhotos([
                NativeIntake.PhotoInput {
                    photoData
                }
            ]),
            expectedActivationID:
                initialSnapshot.version.activationID
        )
        guard result.outcome == .committed,
              let snapshot = result.snapshot,
              let submissionStore =
                captureDraftStore as? RestoredCaptureFixtureStore
        else {
            return
        }
        await submissionStore.retainLegacySubmissionFixture(
            snapshot.photos
        )
    }
}

private actor RestoredCaptureFixtureStore: CaptureDraftStoring {
    private var photos = [
        StagedCapturePhoto(
            id: UUID(uuidString: "20720720-7207-4207-8207-207207207207")!,
            photoURL: URL(fileURLWithPath: "/fixture/capture-photo.jpg"),
            thumbnailURL: URL(fileURLWithPath: "/fixture/capture-thumbnail.jpg"),
            createdAt: Date()
        )
    ]

    func load() async throws -> StagedCapturePhoto? { photos.first }
    func loadPhotos() async throws -> [StagedCapturePhoto] { photos }

    func retainLegacySubmissionFixture(
        _ committedPhotos: [StagedCapturePhoto]
    ) {
        photos = committedPhotos
    }

    // The fixture has no image pipeline, so it cannot turn `imageData` into a staged
    // artifact and will not invent one. Handing back the photo it already holds would
    // report an addition that never happened, and because the protocol-default `append`
    // is built on this call, that photo would land a second time in the strip. It
    // refuses instead, and each caller then handles the refusal exactly as it handles a
    // real staging failure: Photo Review's Add shows its addition failure recovery unless
    // the seller had already abandoned the request, the Scan shutter treats it as a
    // retryable failure on the still-live camera and shows nothing, and library staging
    // fails the phase only when the seller was not already on camera, denied, or
    // unavailable, since those phases are their own recovery surface. So under this
    // fixture the shutter is a no-op, which is the honest report for a store that cannot
    // stage.
    func stage(
        imageData: Data,
        libraryTransferReceipt: LibraryPhotoTransferReceipt?
    ) async throws -> StagedCapturePhoto {
        throw CaptureDraftStoreError.stagingUnsupported
    }

    // Same refusal for the same reason: handing back the held photo would report a
    // replacement that never happened. `PhotoReviewIntake` is this call's only caller, so
    // a still-live replacement transaction shows the replacement failure recovery.
    func replace(
        photoID: StagedCapturePhoto.ID,
        imageData: Data,
        libraryTransferReceipt: LibraryPhotoTransferReceipt?
    ) async throws -> CaptureDraftReplaceResult {
        guard photos.contains(where: { $0.id == photoID }) else {
            throw CaptureDraftStoreError.photoNotStaged
        }
        throw CaptureDraftStoreError.stagingUnsupported
    }

    func replacePhotos(with replacement: [StagedCapturePhoto]) async throws {
        let currentByID = Dictionary(
            uniqueKeysWithValues: photos.map { ($0.id, $0) }
        )
        guard replacement.count <= 5,
              Set(replacement.map(\.id)).count == replacement.count,
              replacement.allSatisfy({ currentByID[$0.id] == $0 }) else {
            throw CaptureDraftStoreError.invalidManifest
        }
        photos = replacement
    }

    func discard() async throws { photos = [] }
}
#endif
