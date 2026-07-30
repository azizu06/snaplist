import Foundation
#if DEBUG
import UIKit
#endif

protocol MobileAPIClient {
    func getHealth() async throws -> HealthEnvelope
    func getSession() async throws -> SessionEnvelope
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

    static func make(
        configuration: LaunchConfiguration,
        apiOrigin: URL? = HomeRepositoryFactory.defaultAPIOrigin,
        tokenProvider: any BearerTokenProviding = UnavailableBearerTokenProvider(),
        nativeIntakeIdentitySource: NativeIntake.IdentitySource = .processPrivate,
        nativeIntakeApplicationSupportDirectory: URL? = nil
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
                analyticsClient: NoOpAnalyticsClient()
            )
        }

        let origin = apiOrigin ?? URL(string: "http://127.0.0.1:3001")!

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
            analyticsClient: NoOpAnalyticsClient()
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
