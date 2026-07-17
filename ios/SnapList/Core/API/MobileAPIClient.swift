import Foundation

protocol MobileAPIClient {
    func getHealth() async throws -> HealthEnvelope
    func getSession(bearerToken: String) async throws -> SessionEnvelope
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
    private let session: URLSession
    private let decoder: JSONDecoder

    init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
        self.decoder = JSONDecoder()
    }

    func getHealth() async throws -> HealthEnvelope {
        try await send(path: "/v1/health", bearerToken: nil)
    }

    func getSession(bearerToken: String) async throws -> SessionEnvelope {
        try await send(path: "/v1/session", bearerToken: bearerToken)
    }

    private func send<Response: Decodable>(
        path: String,
        bearerToken: String?
    ) async throws -> Response {
        let url = baseURL.appending(path: path)
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
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

    func getSession(bearerToken: String) async throws -> SessionEnvelope {
        SessionEnvelope(
            data: .init(userId: "fixture-clerk-user"),
            meta: .init(requestId: "fixture-session")
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
    let captureDraftStore: any CaptureDraftStoring

    static func make(configuration: LaunchConfiguration) -> AppDependencies {
        let cameraAuthorization: any CameraAuthorizationProviding
        if let fixtureStatus = configuration.cameraAuthorizationFixture {
            cameraAuthorization = FixtureCameraAuthorizationClient(status: fixtureStatus)
        } else {
            cameraAuthorization = AVCameraAuthorizationClient()
        }
        let captureDraftStore = makeCaptureDraftStore(configuration: configuration)
        let captureCamera = makeCaptureCamera(configuration: configuration)
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
                captureDraftStore: captureDraftStore
            )
        }

        let origin = ProcessInfo.processInfo.environment["SNAPLIST_API_ORIGIN"]
            .flatMap(URL.init(string:))
            ?? URL(string: "http://127.0.0.1:3001")!

        return AppDependencies(
            mobileAPIClient: URLSessionMobileAPIClient(baseURL: origin),
            contractFixtureProvider: ZeroNetworkMobileAPIClient(),
            cameraAuthorization: cameraAuthorization,
            onboardingProgressStore: UserDefaultsOnboardingProgressStore(),
            stagedLibraryPhotos: FileSystemStagedLibraryPhotoStore(),
            guestAllowance: DeferredGuestAllowanceCapability(),
            captureCamera: captureCamera,
            framingEvaluator: VisionObjectFramingEvaluator(),
            captureDraftStore: captureDraftStore
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
private actor RestoredCaptureFixtureStore: CaptureDraftStoring {
    private let staged = StagedCapturePhoto(
        id: UUID(uuidString: "20720720-7207-4207-8207-207207207207")!,
        photoURL: URL(fileURLWithPath: "/fixture/capture-photo.jpg"),
        thumbnailURL: URL(fileURLWithPath: "/fixture/capture-thumbnail.jpg"),
        createdAt: Date()
    )

    func load() async throws -> StagedCapturePhoto? { staged }
    func stage(
        imageData: Data,
        libraryTransferReceipt: LibraryPhotoTransferReceipt?
    ) async throws -> StagedCapturePhoto { staged }
    func discard() async throws {}
}
#endif
