import SwiftUI
import UIKit

@MainActor
struct AppShellView: View {
    @Bindable var router: AppRouter
    @Bindable var onboardingModel: OnboardingFlowModel
    @Bindable var captureFlow: CaptureFlowModel
    let configuration: LaunchConfiguration

    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @State private var isKeyboardVisible = false
    @State private var pendingCapturePresentation: PendingCapturePresentation?

    var body: some View {
        Group {
            if shouldShowOnboarding {
                OnboardingFlowView(
                    model: onboardingModel,
                    configuration: configuration,
                    continueToCapture: onboardingModel.continueToCaptureBoundary
                )
            } else if let visualState = configuration.visualState {
#if DEBUG
                if visualState.ownerIssue == 207 {
                    CaptureVisualStateView(state: visualState)
                } else {
                    VisualStateBoundaryPlaceholder(state: visualState)
                }
#else
                VisualStateBoundaryPlaceholder(state: visualState)
#endif
            } else {
                shell
            }
        }
        .modifier(OptionalDynamicTypeModifier(size: configuration.dynamicTypeSize))
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
                    FoundationPlaceholderView(
                        tab: tab,
                        configuration: configuration,
                        openActivity: { router.navigate(to: .activity) },
                        openAccount: { router.navigate(to: .account) }
                    )
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
                GuidedCameraView(flow: captureFlow) {
                    router.presentedFullScreen = nil
                }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            isKeyboardVisible = true
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            isKeyboardVisible = false
        }
    }

    @ViewBuilder
    private func destination(for route: AppRoute) -> some View {
        switch route {
        case .account:
            FoundationDestinationView(destination: .account)
        case .activity:
            FoundationDestinationView(destination: .activity)
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
        guard let pendingCapturePresentation else { return }
        self.pendingCapturePresentation = nil
        router.presentedFullScreen = .guidedCamera
        if pendingCapturePresentation == .camera {
            Task { await captureFlow.startCamera() }
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
           captureFlow.stagedPhoto == nil,
           let photoData = onboardingModel.firstStagedLibraryPhotoForCapture() {
            await captureFlow.stageLibraryPhoto(photoData)
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
        configuration: .preview
    )
}
