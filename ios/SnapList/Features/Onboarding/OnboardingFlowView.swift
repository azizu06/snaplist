import PhotosUI
import SwiftUI
import UIKit

@MainActor
struct OnboardingFlowView: View {
    @Bindable var model: OnboardingFlowModel
    let configuration: LaunchConfiguration
    let continueToCapture: () -> Void

    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var expandedAllowance = 0
    @State private var libraryItems: [PhotosPickerItem] = []
    @State private var isPhotoPickerPresented = false
    @State private var libraryLoadTask: Task<Void, Never>?
    @State private var openedSettings = false
    @AccessibilityFocusState private var focusedControl: FocusTarget?

    private enum FocusTarget: Hashable {
        case signIn
        case marketplaces
        case library
        case settings
    }

    var body: some View {
        ZStack {
            SnapListColorToken.canvas.color.ignoresSafeArea()
            screen
                .id(model.state.screen)
                .transition(screenTransition)
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.24), value: model.state.screen)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("onboarding.state.\(stateIdentifier)")
        .sheet(item: overlayBinding, onDismiss: restoreOverlayFocus) { overlay in
            switch overlay {
            case .marketplace:
                MarketplaceExplanationSheet(dismiss: model.dismissOverlay)
            case .returningSignIn:
                ReturningSignInSheet(dismiss: model.dismissOverlay)
            }
        }
        .photosPicker(
            isPresented: $isPhotoPickerPresented,
            selection: $libraryItems,
            maxSelectionCount: 4,
            matching: .images
        )
        .onChange(of: libraryItems) { _, items in
            guard !items.isEmpty else { return }
            libraryLoadTask?.cancel()
            libraryLoadTask = Task { await stageLibraryItems(items) }
        }
        .onChange(of: isPhotoPickerPresented) { _, isPresented in
            guard !isPresented else { return }
            focusedControl = .library
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active, openedSettings else { return }
            openedSettings = false
            model.refreshCameraAuthorization()
            focusedControl = model.state.screen == .cameraHandoff ? nil : .settings
        }
        .task {
            await performInitialTransitionIfNeeded()
        }
    }

    @ViewBuilder
    private var screen: some View {
        switch model.state.screen {
        case .launch:
            launchScreen
        case .promise:
            promiseScreen
        case .allowance:
            allowanceScreen
        case .photoPrimer:
            photoPrimerScreen
        case .denied, .settingsHandoff:
            deniedScreen
        case .cameraHandoff:
            handoffScreen(source: .camera)
        case .libraryHandoff:
            handoffScreen(source: .library(stagedPhotoCount: model.state.stagedPhotoCount))
        case .captureBoundary:
            EmptyView()
        }
    }

    private var launchScreen: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 30)

            VStack(spacing: 20) {
                Image("ScoutCoaching")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 104, height: 104)
                    .padding(10)
                    .background(SnapListColorToken.primerBubbleFill.color.opacity(0.72))
                    .clipShape(.rect(cornerRadius: 24))
                    .accessibilityLabel("SnapList app icon — Scout, the camera guide")

                Text("SnapList")
                    .font(.system(size: 30, weight: .bold))
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .accessibilityAddTraits(.isHeader)
            }

            Spacer()

            Text(OnboardingCopy.launchTagline)
                .snapListTypography(.status)
                .foregroundStyle(SnapListColorToken.textTertiary.color)
                .padding(.bottom, 24)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var promiseScreen: some View {
        ScrollView {
            VStack(spacing: 0) {
                HStack {
                    Spacer()
                    Button("Sign in") {
                        model.presentReturningSignIn()
                    }
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(SnapListColorToken.action.color)
                    .frame(minWidth: 56, minHeight: SnapListMetrics.minimumTouchTarget)
                    .accessibilityLabel("Sign in — returning users")
                    .accessibilityIdentifier("onboarding.sign-in")
                    .accessibilityFocused($focusedControl, equals: .signIn)
                }

                Spacer(minLength: 88)

                Image("ScoutCoaching")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 184, height: 184)
                    .accessibilityLabel("Scout, the SnapList camera guide, holding a photo")

                Text(OnboardingCopy.promiseHeadline)
                    .snapListTypography(.onboardingHeadline)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 22)
                    .accessibilityAddTraits(.isHeader)

                Text(OnboardingCopy.promiseSupport)
                    .snapListTypography(.body)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 12)

                Spacer(minLength: 76)

                SnapListPrimaryButton(
                    title: "Start with one item",
                    forceReducedMotion: reduceMotion,
                    action: model.startFirstItem
                )

                Text("Free · no account · photos stay on your device")
                    .snapListTypography(.metadata)
                    .foregroundStyle(SnapListColorToken.textTertiary.color)
                    .padding(.top, 10)
                    .padding(.bottom, 14)
            }
            .frame(minHeight: availableHeight, alignment: .top)
            .padding(.horizontal, SnapListMetrics.screenGutter)
        }
        .scrollIndicators(.hidden)
    }

    private var allowanceScreen: some View {
        VStack(spacing: 0) {
            OnboardingBackButton(action: model.goBack)
                .padding(.horizontal, 10)

            GeometryReader { geometry in
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(OnboardingCopy.allowanceTitle)
                            .snapListTypography(.displayTitle)
                            .foregroundStyle(SnapListColorToken.inkPrimary.color)
                            .frame(maxWidth: .infinity)
                            .multilineTextAlignment(.center)
                            .accessibilityAddTraits(.isHeader)

                        Text(OnboardingCopy.allowanceSupport)
                            .snapListTypography(.body)
                            .foregroundStyle(SnapListColorToken.textSecondary.color)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, 10)

                        VStack(spacing: 0) {
                            AllowanceDisclosureRow(
                                index: 0,
                                title: "One complete AI run",
                                detail: OnboardingCopy.completeRunBody,
                                expandedIndex: $expandedAllowance
                            )
                            Divider().foregroundStyle(SnapListColorToken.divider.color)
                            AllowanceDisclosureRow(
                                index: 1,
                                title: "One guided fix included",
                                detail: OnboardingCopy.guidedFixBody,
                                expandedIndex: $expandedAllowance
                            )
                            Divider().foregroundStyle(SnapListColorToken.divider.color)
                            AllowanceDisclosureRow(
                                index: 2,
                                title: "Yours for 24 hours",
                                detail: OnboardingCopy.recoveryBody,
                                expandedIndex: $expandedAllowance
                            )
                        }
                        .background(SnapListColorToken.canvas.color)
                        .clipShape(.rect(cornerRadius: 16))
                        .overlay {
                            RoundedRectangle(cornerRadius: 16)
                                .stroke(SnapListColorToken.hairline.color, lineWidth: 1)
                        }
                        .padding(.top, 24)

                        Button {
                            model.presentMarketplaceExplanation()
                        } label: {
                            Label("Where can I list?", systemImage: "info.circle")
                                .font(.system(size: 15, weight: .medium))
                                .frame(minHeight: SnapListMetrics.minimumTouchTarget)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(SnapListColorToken.action.color)
                        .accessibilityIdentifier("onboarding.marketplaces")
                        .accessibilityFocused($focusedControl, equals: .marketplaces)
                        .padding(.top, 10)
                    }
                    .padding(.horizontal, SnapListMetrics.screenGutter)
                    .padding(.vertical, 16)
                    .frame(minHeight: geometry.size.height, alignment: .center)
                }
                .scrollIndicators(.hidden)
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            OnboardingBottomTray {
                SnapListPrimaryButton(
                    title: "Continue",
                    forceReducedMotion: reduceMotion,
                    action: model.continueFromAllowance
                )
            }
        }
    }

    private var photoPrimerScreen: some View {
        VStack(spacing: 0) {
            OnboardingBackButton(action: model.goBack)
                .padding(.horizontal, 10)

            ScrollView {
                VStack(spacing: 0) {
                    HStack(alignment: .center, spacing: 10) {
                        Image("ScoutCoaching")
                            .resizable()
                            .scaledToFit()
                            .frame(width: 82, height: 82)
                            .accessibilityLabel("Scout, the SnapList camera guide")

                        Text(OnboardingCopy.primerBubble)
                            .snapListTypography(.status)
                            .fontWeight(.semibold)
                            .foregroundStyle(SnapListColorToken.inkPrimary.color)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 12)
                            .background(SnapListColorToken.primerBubbleFill.color)
                            .clipShape(.rect(cornerRadius: 16))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 6)

                    Text(OnboardingCopy.primerTitle)
                        .snapListTypography(.displayTitle)
                        .foregroundStyle(SnapListColorToken.inkPrimary.color)
                        .multilineTextAlignment(.center)
                        .padding(.top, 24)
                        .accessibilityAddTraits(.isHeader)

                    Text(OnboardingCopy.primerSupport)
                        .snapListTypography(.body)
                        .foregroundStyle(SnapListColorToken.textSecondary.color)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 12)

                    VStack(spacing: 12) {
                        PrimerCapabilityRow(
                            systemImage: "camera",
                            title: "Camera",
                            detail: "take photos from different angles right here."
                        )
                        PrimerCapabilityRow(
                            systemImage: "photo.on.rectangle",
                            title: "Photo library",
                            detail: "or pick photos you already took."
                        )
                    }
                    .padding(.top, 22)
                }
                .padding(.horizontal, SnapListMetrics.screenGutter)
                .padding(.bottom, 184)
            }
            .scrollIndicators(.hidden)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            OnboardingBottomTray(spacing: 8) {
                OnboardingPrimaryAction(
                    title: "Use camera",
                    systemImage: "camera",
                    reduceMotion: reduceMotion
                ) {
                    Task { await model.requestCameraAccess() }
                }

                OnboardingSecondaryAction(title: "Choose from library") {
                    openLibraryPickerOrResume()
                }
                .accessibilityIdentifier("onboarding.choose-library")
                .accessibilityFocused($focusedControl, equals: .library)

                Label("Nothing is uploaded until you choose to run it", systemImage: "lock")
                    .snapListTypography(.metadata)
                    .foregroundStyle(SnapListColorToken.textTertiary.color)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 2)
            }
        }
    }

    private var deniedScreen: some View {
        VStack(spacing: 0) {
            OnboardingBackButton(action: model.goBack)
                .padding(.horizontal, 10)

            ScrollView {
                VStack(spacing: 0) {
                    Spacer(minLength: 36)

                    Image("ScoutUncertain")
                        .resizable()
                        .scaledToFit()
                        .frame(width: 152, height: 152)
                        .accessibilityLabel("Scout, unsure about camera access")

                    Label("Camera access is off", systemImage: "camera.fill.badge.xmark")
                        .snapListTypography(.status)
                        .fontWeight(.semibold)
                        .foregroundStyle(SnapListColorToken.textSecondary.color)
                        .padding(.top, 20)

                    Text("Turn on the camera to snap a photo")
                        .snapListTypography(.displayTitle)
                        .foregroundStyle(SnapListColorToken.inkPrimary.color)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 12)
                        .accessibilityAddTraits(.isHeader)

                    Text(OnboardingCopy.deniedSupport)
                        .snapListTypography(.body)
                        .foregroundStyle(SnapListColorToken.textSecondary.color)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 12)

                    Spacer(minLength: 132)
                }
                .frame(minHeight: availableHeight - 190)
                .padding(.horizontal, SnapListMetrics.screenGutter)
            }
            .scrollIndicators(.hidden)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            OnboardingBottomTray(spacing: 8) {
                OnboardingPrimaryAction(
                    title: "Open Settings",
                    systemImage: "gearshape",
                    reduceMotion: reduceMotion,
                    action: openSettings
                )
                .accessibilityIdentifier("onboarding.open-settings")
                .accessibilityFocused($focusedControl, equals: .settings)

                OnboardingSecondaryAction(title: "Choose from library instead") {
                    openLibraryPickerOrResume()
                }
                .accessibilityIdentifier("onboarding.choose-library")
                .accessibilityFocused($focusedControl, equals: .library)
            }
        }
    }

    private func handoffScreen(source: CaptureEntryContext) -> some View {
        ScrollView {
            VStack(spacing: 0) {
                OnboardingBackButton(action: model.goBack)

                Text("HANDOFF · ONB-09")
                    .snapListTypography(.metadata)
                    .fontWeight(.bold)
                    .foregroundStyle(SnapListColorToken.action.color)
                    .tracking(0.6)
                    .padding(.top, 22)

                Image("ScoutCoaching")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 140, height: 140)
                    .accessibilityLabel("Scout, ready with a photo")
                    .padding(.top, 30)

                Text(handoffTitle(source))
                    .snapListTypography(.displayTitle)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .multilineTextAlignment(.center)
                    .padding(.top, 20)
                    .accessibilityAddTraits(.isHeader)

                Text(handoffSupport(source))
                    .snapListTypography(.body)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 12)

                OnboardingPrimaryAction(
                    title: "Continue to capture",
                    systemImage: "chevron.right",
                    reduceMotion: reduceMotion,
                    action: continueToCapture
                )
                .frame(maxWidth: 240)
                .padding(.top, 30)

                Label(
                    "Opens the Capture + Guided Camera screen. No account, price, comps, or analysis happens yet.",
                    systemImage: "info.circle"
                )
                .snapListTypography(.metadata)
                .foregroundStyle(SnapListColorToken.textTertiary.color)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 24)

                Spacer(minLength: 120)
            }
            .padding(.horizontal, SnapListMetrics.screenGutter)
            .frame(minHeight: availableHeight, alignment: .top)
        }
        .scrollIndicators(.hidden)
    }

    private var overlayBinding: Binding<OnboardingOverlay?> {
        Binding(
            get: { model.state.overlay },
            set: { value in
                if value == nil { model.dismissOverlay() }
            }
        )
    }

    private var reduceMotion: Bool {
        systemReduceMotion || configuration.forceReducedMotion
    }

    private var screenTransition: AnyTransition {
        reduceMotion
            ? .opacity
            : .asymmetric(
                insertion: .move(edge: .trailing).combined(with: .opacity),
                removal: .move(edge: .leading).combined(with: .opacity)
            )
    }

    private var availableHeight: CGFloat {
        852 - 54 - 34
    }

    private var stateIdentifier: String {
        if let visualState = configuration.visualState, visualState.ownerIssue == 206 {
            return visualState.rawValue
        }
        switch model.state.screen {
        case .launch: return "ONB-00"
        case .promise: return "ONB-01"
        case .allowance: return model.state.overlay == .marketplace ? "ONB-05" : "ONB-06"
        case .photoPrimer: return "ONB-07"
        case .denied: return "ONB-08"
        case .settingsHandoff: return "settings-handoff"
        case .cameraHandoff: return "ONB-09-camera"
        case .libraryHandoff: return "ONB-09-library"
        case .captureBoundary: return "CAP-01"
        }
    }

    private func openLibraryPickerOrResume() {
        if !model.resumeStagedLibraryPhotosIfAvailable() {
            libraryItems = []
            isPhotoPickerPresented = true
        }
    }

    private func stageLibraryItems(_ items: [PhotosPickerItem]) async {
        var photos: [Data] = []
        for item in items.prefix(4) {
            if let data = try? await item.loadTransferable(type: Data.self) {
                photos.append(data)
            }
        }

        guard !Task.isCancelled else { return }
        _ = model.didStageLibraryPhotos(photos)
    }

    private func restoreOverlayFocus() {
        switch model.state.screen {
        case .promise:
            focusedControl = .signIn
        case .allowance:
            focusedControl = .marketplaces
        default:
            break
        }
    }

    private func performInitialTransitionIfNeeded() async {
        if configuration.shouldRequestCameraOnLaunch {
            await model.requestCameraAccess()
            return
        }
        if configuration.shouldOpenSettingsOnLaunch {
            openSettings()
            return
        }
        guard configuration.visualState == nil, model.state.screen == .launch else { return }
        try? await Task.sleep(for: reduceMotion ? .milliseconds(550) : .milliseconds(1_400))
        guard !Task.isCancelled else { return }
        model.settleLaunch()
    }

    private func openSettings() {
        model.openSettingsHandoff()
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        openedSettings = true
        UIApplication.shared.open(url)
    }

    private func handoffTitle(_ source: CaptureEntryContext) -> String {
        switch source {
        case .camera: "Ready to capture"
        case .library: "Photos ready"
        }
    }

    private func handoffSupport(_ source: CaptureEntryContext) -> String {
        switch source {
        case .camera: OnboardingCopy.cameraHandoffSupport
        case .library: OnboardingCopy.libraryHandoffSupport
        }
    }
}

private struct OnboardingBackButton: View {
    let action: () -> Void

    var body: some View {
        HStack {
            Button(action: action) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 17, weight: .semibold))
                    .frame(width: SnapListMetrics.minimumTouchTarget, height: SnapListMetrics.minimumTouchTarget)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .foregroundStyle(SnapListColorToken.inkPrimary.color)
            .accessibilityLabel("Back")
            .accessibilityIdentifier("onboarding.back")
            Spacer()
        }
        .frame(height: 44)
    }
}

private struct AllowanceDisclosureRow: View {
    let index: Int
    let title: String
    let detail: String
    @Binding var expandedIndex: Int

    private var isExpanded: Bool { expandedIndex == index }

    var bodyContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                expandedIndex = isExpanded ? -1 : index
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: icon)
                        .foregroundStyle(SnapListColorToken.action.color)
                        .frame(width: 24)
                    Text(title)
                        .snapListTypography(.rowTitle)
                        .foregroundStyle(SnapListColorToken.inkPrimary.color)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(SnapListColorToken.textTertiary.color)
                        .rotationEffect(.degrees(isExpanded ? 180 : 0))
                }
                .frame(minHeight: 54)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(title) — show details")
            .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")

            if isExpanded {
                Text(detail)
                    .snapListTypography(.status)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 36)
                    .padding(.trailing, 8)
                    .padding(.bottom, 14)
            }
        }
        .padding(.horizontal, 14)
    }

    var body: some View { bodyContent }

    private var icon: String {
        switch index {
        case 0: "sparkles"
        case 1: "arrow.triangle.2.circlepath"
        default: "clock"
        }
    }
}

private struct PrimerCapabilityRow: View {
    let systemImage: String
    let title: String
    let detail: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: systemImage)
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(SnapListColorToken.action.color)
                .frame(width: 32, height: 32)
                .background(SnapListColorToken.infoChipFill.color)
                .clipShape(.rect(cornerRadius: 9))
                .accessibilityHidden(true)

            (Text(title).bold() + Text(" — \(detail)"))
                .snapListTypography(.status)
                .foregroundStyle(SnapListColorToken.textSecondary.color)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("onboarding.primer.\(title.accessibilitySlug)")
        }
    }
}

private struct OnboardingBottomTray<Content: View>: View {
    let spacing: CGFloat
    let content: Content

    init(spacing: CGFloat = 0, @ViewBuilder content: () -> Content) {
        self.spacing = spacing
        self.content = content()
    }

    var body: some View {
        VStack(spacing: spacing) {
            content
        }
        .padding(.horizontal, SnapListMetrics.screenGutter)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .frame(maxWidth: .infinity)
        .background(SnapListColorToken.canvas.color)
        .overlay(alignment: .top) {
            Divider().foregroundStyle(SnapListColorToken.divider.color)
        }
    }
}

private struct OnboardingPrimaryAction: View {
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion

    let title: String
    let systemImage: String?
    let reduceMotion: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if let systemImage, systemImage != "chevron.right" {
                    Image(systemName: systemImage)
                }
                Text(title)
                if let systemImage, systemImage == "chevron.right" {
                    Image(systemName: systemImage)
                }
            }
            .font(.system(size: 16, weight: .bold))
            .foregroundStyle(SnapListColorToken.onDarkSurface.color)
            .frame(maxWidth: .infinity)
            .frame(minHeight: SnapListMetrics.primaryButtonHeight)
            .contentShape(.rect)
        }
        .buttonStyle(OnboardingPressStyle(reduceMotion: reduceMotion || systemReduceMotion))
        .accessibilityIdentifier("button.primary.\(title.accessibilitySlug)")
    }
}

private struct OnboardingSecondaryAction: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 15.5, weight: .semibold))
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .frame(maxWidth: .infinity)
                .frame(minHeight: 50)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .background(SnapListColorToken.canvas.color)
        .clipShape(.rect(cornerRadius: 25))
        .overlay {
            RoundedRectangle(cornerRadius: 25)
                .stroke(SnapListColorToken.inputBorder.color, lineWidth: 1)
        }
    }
}

private struct OnboardingPressStyle: ButtonStyle {
    let reduceMotion: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(SnapListColorToken.action.color)
            .clipShape(.rect(cornerRadius: SnapListMetrics.primaryButtonRadius))
            .shadow(color: SnapListColorToken.action.color.opacity(0.36), radius: 10, y: 8)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.99 : 1)
    }
}

private struct MarketplaceExplanationSheet: View {
    let dismiss: () -> Void

    var body: some View {
        SnapListSheetContainer {
            VStack(alignment: .leading, spacing: 0) {
                SheetHeader(title: "Where can I list?", dismiss: dismiss)

                Text("SnapList publishes to eBay directly. Other marketplaces get an assisted hand-off — you stay in control of the post.")
                    .snapListTypography(.body)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 6)

                MarketplaceRow(
                    systemImage: "shippingbox.fill",
                    title: "eBay",
                    badge: "DIRECT PUBLISH",
                    detail: "Review your listing and publish to eBay right from SnapList — one tap, no copy-paste."
                )
                .padding(.top, 20)

                MarketplaceRow(
                    systemImage: "square.and.arrow.up",
                    title: "Assisted hand-off",
                    badge: "SHARE & PASTE",
                    detail: "We prepare your photos and listing text, then open the app's share sheet. You paste and post."
                )
                .padding(.top, 16)

                HStack(spacing: 8) {
                    ForEach(["Mercari", "Facebook Marketplace", "Depop"], id: \.self) { marketplace in
                        Text(marketplace)
                            .snapListTypography(.metadata)
                            .foregroundStyle(SnapListColorToken.textSecondary.color)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 6)
                            .background(SnapListColorToken.groupingFill.color)
                            .clipShape(.capsule)
                    }
                }
                .padding(.top, 12)

                Text("Nothing is chosen now — you pick where to list when you publish.")
                    .snapListTypography(.metadata)
                    .foregroundStyle(SnapListColorToken.textTertiary.color)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 16)

                Spacer(minLength: 16)

                SnapListPrimaryButton(title: "Got it", action: dismiss)
            }
            .padding(.horizontal, SnapListMetrics.screenGutter)
            .padding(.bottom, 12)
            .presentationDetents([.height(620)])
        }
    }
}

struct ReturningSignInSheet: View {
    let dismiss: () -> Void

    var body: some View {
        SnapListSheetContainer {
            VStack(alignment: .leading, spacing: 0) {
                SheetHeader(title: "Welcome back", dismiss: dismiss)

                Text("Sign in to pick up listings and drafts you saved on another device.")
                    .snapListTypography(.body)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 6)

                OnboardingSecondaryAction(title: "Continue with Apple", action: {})
                    .allowsHitTesting(false)
                    .padding(.top, 22)
                OnboardingSecondaryAction(title: "Continue with email", action: {})
                    .allowsHitTesting(false)
                    .padding(.top, 10)

                Text("New here?")
                    .snapListTypography(.rowTitle)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .padding(.top, 22)
                Text("Just tap Start with one item — no account needed.")
                    .snapListTypography(.body)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .padding(.top, 4)

                Text("Prototype bridge — full returning-user sign-in is designed in ONB-12.")
                    .snapListTypography(.metadata)
                    .foregroundStyle(SnapListColorToken.textTertiary.color)
                    .padding(.top, 18)

                Spacer(minLength: 12)
            }
            .padding(.horizontal, SnapListMetrics.screenGutter)
            .padding(.bottom, 12)
            .presentationDetents([.height(510)])
        }
    }
}

private struct SheetHeader: View {
    let title: String
    let dismiss: () -> Void

    var body: some View {
        HStack(alignment: .center) {
            Text(title)
                .snapListTypography(.sectionHeader)
                .foregroundStyle(SnapListColorToken.inkPrimary.color)
                .accessibilityAddTraits(.isHeader)
            Spacer()
            Button(action: dismiss) {
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .semibold))
                    .frame(width: SnapListMetrics.minimumTouchTarget, height: SnapListMetrics.minimumTouchTarget)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close")
            .accessibilityIdentifier("onboarding.sheet.close")
        }
    }
}

private struct MarketplaceRow: View {
    let systemImage: String
    let title: String
    let badge: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: systemImage)
                .font(.system(size: 19, weight: .semibold))
                .foregroundStyle(SnapListColorToken.action.color)
                .frame(width: 40, height: 40)
                .background(SnapListColorToken.infoChipFill.color)
                .clipShape(.rect(cornerRadius: 10))
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 5) {
                HStack {
                    Text(title)
                        .snapListTypography(.rowTitle)
                        .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    Spacer()
                    Text(badge)
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(SnapListColorToken.action.color)
                }
                Text(detail)
                    .snapListTypography(.status)
                    .foregroundStyle(SnapListColorToken.textSecondary.color)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

private extension String {
    var accessibilitySlug: String {
        lowercased()
            .replacingOccurrences(of: " ", with: "-")
            .replacingOccurrences(of: ".", with: "")
    }
}

#Preview("ONB-01 Promise") {
    OnboardingFlowView(
        model: OnboardingFlowModel(
            state: .init(screen: .promise),
            cameraAuthorization: FixtureCameraAuthorizationClient(status: .authorized),
            progressStore: InMemoryOnboardingProgressStore(),
            guestAllowance: DeferredGuestAllowanceCapability()
        ),
        configuration: .preview,
        continueToCapture: {}
    )
}

#Preview("ONB-08 Denied") {
    OnboardingFlowView(
        model: OnboardingFlowModel(
            state: .init(screen: .denied),
            cameraAuthorization: FixtureCameraAuthorizationClient(status: .denied),
            progressStore: InMemoryOnboardingProgressStore(),
            guestAllowance: DeferredGuestAllowanceCapability()
        ),
        configuration: .preview,
        continueToCapture: {}
    )
}
