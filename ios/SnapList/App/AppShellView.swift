import SwiftUI
import UIKit

@MainActor
struct AppShellView: View {
    @Bindable var router: AppRouter
    @Bindable var onboardingModel: OnboardingFlowModel
    @Bindable var captureFlow: CaptureFlowModel
    @Bindable var homeStore: HomeStore
    @Bindable var runStore: RunDetailStore
    let configuration: LaunchConfiguration

    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var isKeyboardVisible = false
    @State private var pendingCapturePresentation: PendingCapturePresentation?
    @State private var pendingScanReturnFocus: PhotoReviewScanFocus?
    @State private var photoReviewHost = PhotoReviewLiveHost()

    var body: some View {
        Group {
            if shouldShowOnboarding {
                OnboardingFlowView(
                    model: onboardingModel,
                    configuration: configuration,
                    continueToCapture: onboardingModel.continueToCaptureBoundary
                )
            } else if let photoReviewState = configuration.photoReviewState {
#if DEBUG
                PhotoReviewFixtureView(state: photoReviewState)
#else
                shell
#endif
            } else if let visualState = configuration.visualState {
#if DEBUG
                if visualState.ownerIssue == 207 {
                    CaptureVisualStateView(state: visualState)
                } else if visualState.ownerIssue == 424 {
                    ScanCameraVisualStateView(
                        state: visualState,
                        forceReducedMotion: configuration.forceReducedMotion
                    )
                } else if visualState.ownerIssue == 208 || visualState == .runDetail {
                    shell
                } else {
                    VisualStateBoundaryPlaceholder(state: visualState)
                }
#else
                VisualStateBoundaryPlaceholder(state: visualState)
#endif
            } else if let session = photoReviewHost.session {
                PhotoReviewView(
                    store: session.store,
                    backToCamera: {
                        returnFromPhotoReview(session)
                    },
                    delete: {}
                )
            } else {
                shell
            }
        }
        .modifier(OptionalDynamicTypeModifier(size: configuration.dynamicTypeSize))
        .onOpenURL { url in
            router.open(url)
        }
        .onChange(
            of: router.captureBoundaryRequest,
            initial: true
        ) { _, request in
            photoReviewHost.consume(request)
        }
        .task(id: onboardingCaptureRouteID) {
            guard configuration.usesOnboarding,
                  captureFlow.hasCompletedRestoration else { return }
            await AppCaptureHandoffCoordinator.presentCaptureLauncher(
                onboardingModel: onboardingModel,
                captureFlow: captureFlow,
                router: router
            )
        }
    }

    private var shell: some View {
        TabView(selection: $router.selectedTab) {
            ForEach(PrimaryTab.allCases) { tab in
                NavigationStack(path: router.pathBinding(for: tab)) {
                    Group {
                        if tab == .home {
#if DEBUG
                            if configuration.keyboardProbe {
                                FoundationPlaceholderView(
                                    tab: tab,
                                    configuration: configuration,
                                    openActivity: { router.navigate(to: .activity) },
                                    openAccount: { router.navigate(to: .account) }
                                )
                            } else {
                                homeFeature
                            }
#else
                            homeFeature
#endif
                        } else {
                            FoundationPlaceholderView(
                                tab: tab,
                                configuration: configuration,
                                openActivity: { router.navigate(to: .activity) },
                                openAccount: { router.navigate(to: .account) }
                            )
                        }
                    }
                    .navigationDestination(for: AppRoute.self) { route in
                        destination(for: route)
                    }
                }
                .tag(tab)
            }
        }
        .toolbar(.hidden, for: .tabBar)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if DockVisibilityPolicy.shouldShow(isKeyboardVisible: isKeyboardVisible) {
                FloatingDock(
                    selectedTab: router.selectedTab,
                    select: router.select
                )
                .padding(.horizontal, SnapListMetrics.dockSideInset)
                .padding(.bottom, SnapListMetrics.dockBottomInset)
                .transition(.opacity)
            }
        }
        .animation(
            reduceMotion ? nil : .easeInOut(duration: 0.16),
            value: isKeyboardVisible
        )
        .sheet(
            item: $router.presentedSheet,
            onDismiss: presentPendingCaptureIfNeeded
        ) { sheet in
            switch sheet {
            case .capture:
                CaptureLauncherSheet(
                    flow: captureFlow,
                    takeOneItem: {
                        pendingCapturePresentation = .camera
                        router.presentedSheet = nil
                    },
                    showCapturedPhoto: {
                        pendingCapturePresentation = .stagedPhoto
                    }
                )
            }
        }
        .fullScreenCover(item: $router.presentedFullScreen) { destination in
            switch destination {
            case .guidedCamera:
                ScanCameraView(
                    flow: captureFlow,
                    returnFocus: $pendingScanReturnFocus
                ) { destination, photos, opener in
                    router.openCaptureBoundary(
                        destination: destination,
                        photos: photos,
                        opener: opener
                    )
                }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            isKeyboardVisible = true
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            isKeyboardVisible = false
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                homeStore.resumeUpdates()
            case .background:
                homeStore.suspendUpdates()
            case .inactive:
                break
            @unknown default:
                break
            }
        }
    }

    private var homeFeature: some View {
        HomeFeatureView(
            store: homeStore,
            visualState: configuration.visualState,
            openActivity: { router.navigate(to: .activity) },
            openAccount: { router.navigate(to: .account) },
            openCapture: { router.select(.capture) },
            openRoute: { router.navigate(to: .home($0)) }
        )
    }

    @ViewBuilder
    private func destination(for route: AppRoute) -> some View {
        switch route {
        case .account:
            FoundationDestinationView(destination: .account)
        case .activity:
            FoundationDestinationView(destination: .activity)
        case .home(let route):
            switch route {
            case .run(let runID):
                RunDetailView(runID: runID, store: runStore)
            default:
                HomeRouteBoundaryView(route: route)
            }
        case .future(let boundary):
            FoundationDestinationView(destination: boundary)
        }
    }

    private var reduceMotion: Bool {
        systemReduceMotion || configuration.forceReducedMotion
    }

    private var shouldShowOnboarding: Bool {
        configuration.usesOnboarding
            && onboardingModel.state.screen != .captureBoundary
            && captureFlow.stagedPhoto == nil
    }

    private var onboardingCaptureRouteID: OnboardingCaptureRouteID {
        OnboardingCaptureRouteID(
            screen: onboardingModel.state.screen,
            hasCompletedRestoration: captureFlow.hasCompletedRestoration
        )
    }

    private func presentPendingCaptureIfNeeded() {
        guard pendingCapturePresentation != nil else { return }
        self.pendingCapturePresentation = nil
        router.presentedFullScreen = .guidedCamera
        Task { await captureFlow.startCamera() }
    }

    private func returnFromPhotoReview(
        _ session: PhotoReviewLiveSession
    ) {
        Task {
            switch await PhotoReviewBackCoordinator.perform(
                session: session,
                captureFlow: captureFlow,
                host: photoReviewHost
            ) {
            case .persistenceRejected, .sessionChanged:
                return
            case .completed(let request):
                pendingScanReturnFocus = request.focus
                router.returnFromPhotoReview(request)
            }
        }
    }
}

@MainActor
enum AppCaptureHandoffCoordinator {
    static func presentCaptureLauncher(
        onboardingModel: OnboardingFlowModel,
        captureFlow: CaptureFlowModel,
        router: AppRouter
    ) async {
        guard onboardingModel.state.screen == .captureBoundary,
              let context = onboardingModel.captureEntryContext,
              router.presentedSheet == nil,
              router.presentedFullScreen == nil else { return }

        if case .library = context,
           let transferReceipt = captureFlow.stagedPhoto?.libraryTransferReceipt {
            // A prior source-cleanup failure keeps the durable capture authoritative.
            // Retry only the exact, idempotent source consume; never stage the photo again.
            switch onboardingModel.consumeStagedLibraryPhotoAfterSuccessfulCapture(
                transferReceipt: transferReceipt
            ) {
            case .consumed, .cleanupNeeded, .retryNeeded:
                break
            }
        }

        if case .library = context,
           captureFlow.stagedPhoto == nil,
           let transfer = onboardingModel.firstStagedLibraryPhotoForCapture() {
            let didStageCapture = await captureFlow.stageLibraryPhoto(
                transfer.imageData,
                transferReceipt: transfer.receipt
            )
            if didStageCapture {
                let sourceConsumeOutcome = onboardingModel
                    .consumeStagedLibraryPhotoAfterSuccessfulCapture(
                        transferReceipt: transfer.receipt
                    )
                if sourceConsumeOutcome == .retryNeeded {
                    let didRollBackCapture = await captureFlow
                        .rollBackLibraryTransferAfterSourceConsumptionFailure()
                    if !didRollBackCapture {
                        router.selectedTab = .home
                        router.presentedSheet = .capture
                        return
                    }
                }
            }
            guard onboardingModel.state.screen == .captureBoundary else { return }
        }

        router.selectedTab = .home
        router.presentedSheet = .capture
    }
}

private struct OnboardingCaptureRouteID: Hashable {
    let screen: OnboardingScreen
    let hasCompletedRestoration: Bool
}

private enum PendingCapturePresentation {
    case camera
    case stagedPhoto
}

private struct OptionalDynamicTypeModifier: ViewModifier {
    let size: DynamicTypeSize?

    @ViewBuilder
    func body(content: Content) -> some View {
        if let size {
            content.dynamicTypeSize(size)
        } else {
            content
        }
    }
}

#if DEBUG
#Preview("Foundation shell") {
    let dependencies = AppDependencies.make(configuration: .preview)
    AppShellView(
        router: AppRouter(),
        onboardingModel: OnboardingFlowModel(
            cameraAuthorization: FixtureCameraAuthorizationClient(status: .authorized),
            progressStore: InMemoryOnboardingProgressStore(),
            stagedLibraryPhotos: InMemoryStagedLibraryPhotoStore(),
            guestAllowance: DeferredGuestAllowanceCapability()
        ),
        captureFlow: CaptureFlowModel(
            camera: dependencies.captureCamera,
            evaluator: dependencies.framingEvaluator,
            store: dependencies.captureDraftStore
        ),
        homeStore: HomeStore(repository: HomeFixtureRepository(model: HomeFixtures.active)),
        runStore: RunDetailStore(
            service: UnavailableRunService(),
            bearerToken: { "preview-bearer" }
        ),
        configuration: .preview
    )
}
#endif
