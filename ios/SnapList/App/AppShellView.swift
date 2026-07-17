import SwiftUI
import UIKit

@MainActor
struct AppShellView: View {
    @Bindable var router: AppRouter
    @Bindable var onboardingModel: OnboardingFlowModel
    let configuration: LaunchConfiguration

    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @State private var isKeyboardVisible = false

    var body: some View {
        Group {
            if configuration.usesOnboarding {
                OnboardingFlowView(
                    model: onboardingModel,
                    configuration: configuration
                )
            } else if let visualState = configuration.visualState {
                VisualStateBoundaryPlaceholder(state: visualState)
            } else {
                shell
            }
        }
        .modifier(OptionalDynamicTypeModifier(size: configuration.dynamicTypeSize))
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
        .sheet(item: $router.presentedSheet) { sheet in
            switch sheet {
            case .capture:
                CaptureBoundarySheet()
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
    AppShellView(
        router: AppRouter(),
        onboardingModel: OnboardingFlowModel(
            cameraAuthorization: FixtureCameraAuthorizationClient(status: .authorized),
            progressStore: InMemoryOnboardingProgressStore(),
            guestAllowance: DeferredGuestAllowanceCapability()
        ),
        configuration: .preview
    )
}

#Preview("Capture boundary") {
    CaptureBoundarySheet()
}
