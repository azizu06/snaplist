import SwiftUI
import UIKit

@MainActor
struct AppShellView: View {
    @Bindable var router: AppRouter
    @Bindable var onboardingModel: OnboardingFlowModel
    @Bindable var firstValueOnboardingModel: FirstValueOnboardingModel
    @Bindable var captureFlow: CaptureFlowModel
    @Bindable var homeStore: HomeStore
    @Bindable var trophyWallStore: TrophyWallStore
    @Bindable var runStore: RunDetailStore
    @Bindable var listingReviewStore: ListingReviewStore
    @Bindable var submissionHost: ItemRunSubmissionHost
    let trophyWallHistoryRepository: any TrophyWallRunHistoryRepository
    let configuration: LaunchConfiguration

    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @Environment(\.appDependencies) private var dependencies
    @Environment(\.scenePhase) private var scenePhase
    @State private var isKeyboardVisible = false
    @State private var keyboardProbeText = ""
    @State private var pendingCapturePresentation: PendingCapturePresentation?
    @State private var pendingScanReturnFocus: PhotoReviewScanFocus?
    @State private var photoReviewHost = PhotoReviewLiveHost()
    @State private var photoReviewSaveFailure: PhotoReviewSaveFailure?
    @State private var photoReviewIntake: PhotoReviewIntake?
    @State private var awaitsPrincipalReviewDismissal = false
    @State private var awaitsCommittedEmptyDismissal = false
    @State private var proGateStore: ProGateStore?
    @State private var proGateFocusRequest: UUID?
    @State private var handlingProGateEventID: UUID?
    @State private var recoverableLocalPendingIdentity: TrophyWallLogicalIdentity?
    @State private var trophyWallCollectionRefreshState =
        TrophyWallCollectionRefreshState()
    @State private var activationCompletionChecked = false
    @State private var hasCompletedActivation = false
    @State private var activationAuthentication = ActivationAuthenticationState.unknown
    @State private var isCompletingActivation = false
    @State private var activationProgress = ActivationGuidanceProgress()
    @State private var activationListingReviewPresented = false
    private let activationProgressStore = UserDefaultsActivationGuidanceProgressStore()
    private let activationGuestCompletionStore =
        UserDefaultsActivationGuidanceGuestCompletionStore()

    var body: some View {
        Group {
            if let proGateFixture = configuration.proGateFixture {
#if DEBUG
                ProGateFixtureHostView(fixture: proGateFixture)
#else
                shell
#endif
            } else if awaitsCaptureRestorationBeforeOnboarding {
                // Neutral hold: a durable capture may still be restoring, and onboarding
                // must not flash in front of a returning seller's own work.
                SnapListColorToken.canvas.color
                    .ignoresSafeArea()
                    .accessibilityHidden(true)
            } else if shouldShowFirstValueOnboarding {
                FirstValueOnboardingView(
                    model: firstValueOnboardingModel,
                    forceReducedMotion: configuration.forceReducedMotion,
                    usesStaticScoutRendering: configuration.usesStaticScoutRendering,
                    didFinish: handleFirstValueOnboardingCompletion
                )
            } else if shouldBypassRetiredLegacyIntro {
                Color.clear
                    .accessibilityHidden(true)
                    .task(id: onboardingModel.state.screen) {
                        onboardingModel.beginPhotoPermissionAfterFirstValueOnboarding()
                    }
            } else if shouldShowOnboarding {
                OnboardingFlowView(
                    model: onboardingModel,
                    configuration: configuration,
                    continueToCapture: onboardingModel.continueToCaptureBoundary
                )
            } else if let photoReviewState = configuration.photoReviewState {
#if DEBUG
                PhotoReviewFixtureView(
                    state: photoReviewState,
                    forceReducedMotion: configuration.forceReducedMotion
                )
#else
                shell
#endif
            } else if let assistedExportFixture = configuration.assistedExportFixture {
#if DEBUG
                AssistedExportFixtureView(fixture: assistedExportFixture)
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
                    isCommitting: photoReviewHost.isCommitting,
                    submissionPresentation: PhotoReviewSubmissionPresentation(
                        host: submissionHost,
                        proGateIntakeAdvisory: proGateStore?.intakeAdvisory
                    ),
                    focusStartListingRequest: proGateFocusRequest,
                    acknowledgeSubmissionPresentation: { eventID in
                        submissionHost.acknowledgePresentation(eventID: eventID)
                    },
                    backToCamera: {
                        returnFromPhotoReview(session)
                    },
                    delete: {
                        await deleteFromPhotoReview(session)
                    },
                    saveFailure: photoReviewSaveFailure?.sessionID == session.id
                        ? photoReviewSaveFailure
                        : nil,
                    retrySave: {
                        retryPhotoReviewSaveFailure(session)
                    },
                    discardPhotos: {
                        discardPhotoReviewSaveFailure(session)
                    },
                    commitReorder: { photoID, destinationIndex in
                        let reordered = await session.commitReorder(
                            photoID: photoID,
                            destinationIndex: destinationIndex,
                            captureFlow: captureFlow
                        )
                        if reordered != nil {
                            advanceActivationGuidance(for: .reorderedPhotos)
                        }
                        return reordered
                    },
                    // Photo Review consumes #469's Voice note event locally. Start
                    // listing submits the committed NativeIntake snapshot: displayed
                    // photo order plus #541's optional recovered WAV under one key.
                    openBoundary: { event in
                        if event == .openVoiceNote {
                            advanceActivationGuidance(for: .openedVoiceNote)
                        }
                        if PhotoReviewSubmissionPrimaryActionConsumer.consume(
                            event,
                            submissionHost: submissionHost
                        ) {
                            return
                        }
                        switch event {
                        case .startListing,
                             .createAccount,
                             .retryAmbiguousSubmission:
                            break
                        case .openVoiceNote,
                             .reviewSubmission,
                             .reviewConflictedSubmission:
                            return
                        }
                        if event == .startListing,
                           proGateStore?.intakeAdvisory != nil {
                            Task { await reopenProGate() }
                            return
                        }
                        Task {
                            await AppShellPhotoReviewSubmissionTransaction.perform(
                                primaryAction: event,
                                session: session,
                                captureFlow: captureFlow,
                                host: photoReviewHost,
                                router: router,
                                submissionHost: submissionHost,
                                setReturnFocus: { pendingScanReturnFocus = $0 }
                            )
                        }
                    },
                    voiceNoteStore: session.voiceNoteStore,
                    intake: photoReviewIntake
                )
            } else {
                shell
            }
        }
        .modifier(OptionalDynamicTypeModifier(size: configuration.dynamicTypeSize))
        .overlay(alignment: .bottom) {
            if router.presentedSheet == nil {
                activationGuidanceOverlay
            }
        }
        .sheet(
            isPresented: proGatePresentationBinding,
            onDismiss: restoreProGateStartListingFocus
        ) {
            if let proGateStore {
                ProGateSheet(
                    store: proGateStore,
                    listingSummary: nil,
                    startListing: resumeProGatedListing,
                    fallbackToPhotoReview: fallbackFromPresentedProGate
                )
                .modifier(
                    OptionalDynamicTypeModifier(
                        size: configuration.dynamicTypeSize
                    )
                )
            }
        }
        .onOpenURL { url in
            router.open(url)
        }
        .onChange(
            of: router.captureBoundaryRequest,
            initial: true
        ) { _, request in
            guard photoReviewHost.consume(
                request,
                captureFlow: captureFlow
            ) else { return }
            // A new session gets a new intake, so a recovery the seller already resolved
            // cannot reappear on the next item they review.
            photoReviewSaveFailure = nil
            let activationID = photoReviewHost.session?.intakeActivationID
            if let activationID {
                photoReviewIntake = PhotoReviewIntake(
                    captureFlow: captureFlow,
                    expectedActivationID: activationID
                )
            } else {
                photoReviewIntake = nil
            }
            Task {
                guard let activationID else { return }
                _ = await captureFlow.markPhotoReviewEntered(
                    activationID: activationID
                )
            }
            advanceActivationGuidance(for: .capturedFirstPhoto)
        }
        // Home's update loop is suspended from the outermost view. Photo Review replaces
        // the shell while it is open, so anything attached to the shell stops observing
        // scene changes exactly when the seller is most likely to background the app.
        .onChange(of: scenePhase) { _, phase in
#if DEBUG
            guard configuration.visualState?.ownerIssue == 208 else { return }
            switch phase {
            case .active:
                homeStore.resumeUpdates()
                Task { await proGateStore?.refreshPendingVerification() }
            case .background:
                homeStore.suspendUpdates()
                recordActivationInterruptionIfNeeded()
            case .inactive:
                break
            @unknown default:
                break
            }
#endif
        }
        .onChange(
            of: submissionHost.pendingPresentationEvent,
            initial: true
        ) { _, event in
            if let action = ActivationGuidanceSubmissionEventPolicy.action(
                for: event
            ) {
                advanceActivationGuidance(for: action)
            }
            switch event {
            case .destinationHandoff(
                eventID: let eventID,
                handoff: let handoff
            )?:
                switch AppShellSubmissionHandoffRoute(
                    handoff: handoff,
                    eventID: eventID
                ) {
                case .presentProGate(let eventID):
                    Task { await presentProGate(eventID: eventID) }
                case .showInPhotoReview:
                    // Photo Review renders these, and it can only do that while the
                    // event is still pending, so the shell must not consume it here.
                    break
                }
            case .itemSaved(_, let handoff)?:
                trophyWallStore.ingest(
                    TrophyWallCanonicalAcceptedRun(
                        principalScope: trophyWallStore.principalScope,
                        runID: handoff.acceptedRun.runID,
                        linkedLogicalIdentity: TrophyWallLogicalIdentity(
                            idempotencyKey: handoff.idempotencyKey
                        ),
                        state: .accepted,
                        lastMeaningfulUpdateAt: Date()
                    )
                )
            case nil, .submissionRejected?:
                break
            }
        }
        .task(id: activationPresentationInputs) {
            guard !hasCompletedActivation,
                  ActivationPresentationPolicy.shouldPresent(
                    hasOnboarded: onboardingModel.state.screen == .captureBoundary,
                    hasCompletedActivation: hasCompletedActivation
                  ),
                  !activationCompletionChecked else { return }
            await bootstrapActivationCompletion()
        }
        .task(id: hasCompletedActivation) {
            guard hasCompletedActivation,
                  activationAuthentication == .guest,
                  activationGuestCompletionStore.isCompleted else { return }
            await promoteCompletedGuestMarkerWhenAuthenticated()
        }
        .onChange(of: photoReviewHost.isCommitting) { _, isCommitting in
            guard !isCommitting, awaitsCommittedEmptyDismissal else {
                return
            }
            awaitsCommittedEmptyDismissal = false
            guard captureFlow.stagedPhotos.isEmpty else { return }
            Task {
                _ = await dismissActivePhotoReviewForDepartedIntake()
            }
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
        .task {
            guard let events = await captureFlow.nativeIntakeEvents() else {
                return
            }
            for await event in events {
                switch event {
                case .snapshot(let snapshot):
                    await captureFlow.awaitPublishedSnapshot(snapshot)
#if DEBUG
                    if !configuration.usesRestoredCaptureFixture {
                        submissionHost.synchronizePrincipal(
                            snapshot: snapshot,
                            intake: dependencies.nativeIntake
                        )
                    }
#else
                    submissionHost.synchronizePrincipal(
                        snapshot: snapshot,
                        intake: dependencies.nativeIntake
                    )
#endif
                    if trophyWallCollectionRefreshState.observePrincipal(
                        submissionHost.trophyWallPrincipalScopeProof
                    ) {
                        trophyWallStore.resetForPrincipalTransition()
                        // The reset drops the collection back to `unknown`, and the
                        // tab-keyed refresh below does not re-run on its own, so a
                        // seller already sitting on the wall would watch it stay
                        // blank until they navigated away and back.
                    }
                    let recoveryScope = trophyWallStore.principalScope
                    let localCardRecovery = await TrophyWallPendingCardRecovery
                        .resolve(
                            scopedTo: recoveryScope,
                            currentScope: { trophyWallStore.principalScope }
                        ) {
                            await submissionHost
                                .recoverableTrophyWallPendingCard(
                                    principalScope: recoveryScope
                                )
                        }
                    if case .current(let localCard) = localCardRecovery {
                        recoverableLocalPendingIdentity =
                            localCard?.identity.logicalIdentity
                        trophyWallStore.withdrawLocalPendingCards(
                            keeping: recoverableLocalPendingIdentity
                        )
                        if let localCard {
                            trophyWallStore.ingest(localCard)
                        }
                    }
                    let activeReviewDeparted =
                        photoReviewHost.session?.intakeActivationID
                        .map { $0 != snapshot.version.activationID }
                        ?? false
                    if awaitsPrincipalReviewDismissal
                        || activeReviewDeparted {
                        awaitsPrincipalReviewDismissal = false
                        _ = await dismissActivePhotoReviewForDepartedIntake()
                    } else if snapshot.photos.isEmpty,
                              photoReviewHost.session != nil {
                        photoReviewHost.session?
                            .publishCommittedSnapshot(snapshot)
                        if photoReviewHost.isCommitting {
                            awaitsCommittedEmptyDismissal = true
                        } else {
                            _ = await dismissActivePhotoReviewForDepartedIntake()
                        }
                    } else {
                        photoReviewHost.session?.publishCommittedSnapshot(snapshot)
                    }
                case .dismissActivePhotoReview:
                    awaitsPrincipalReviewDismissal =
                        photoReviewHost.session != nil
                }
            }
        }
    }

    private var proGatePresentationBinding: Binding<Bool> {
        Binding(
            get: { proGateStore?.isPresented == true },
            set: { presented in
                guard !presented else { return }
                proGateStore?.dismiss()
            }
        )
    }

    private func restoreProGateStartListingFocus() {
        if case .needsPro(let eventID)? = proGateStore?.intakeAdvisory {
            proGateFocusRequest = eventID
        }
    }

    private func makeProGateStoreIfNeeded() -> ProGateStore {
        if let proGateStore { return proGateStore }
        let store = ProGateStore(
            mobileAPIClient: dependencies.mobileAPIClient,
            subscriptionClient: dependencies.subscriptionClient
        )
        proGateStore = store
        return store
    }

    private func presentProGate(eventID: UUID) async {
        guard handlingProGateEventID != eventID else { return }
        handlingProGateEventID = eventID
        defer { handlingProGateEventID = nil }
        let store = makeProGateStoreIfNeeded()
        await AppShellProGateTransaction.present(
            eventID: eventID,
            store: store,
            submissionHost: submissionHost
        )
    }

    private func reopenProGate() async {
        let store = makeProGateStoreIfNeeded()
        if await store.prepare() == .fallbackToPhotoReview {
            submissionHost.publishProGatePhotoReviewFallback()
        }
    }

    private func resumeProGatedListing() {
        guard let store = proGateStore,
              let session = photoReviewHost.session else { return }
        Task {
            await AppShellProGateTransaction.resume(store: store) {
                await AppShellPhotoReviewSubmissionTransaction.perform(
                    primaryAction: .startListing,
                    session: session,
                    captureFlow: captureFlow,
                    host: photoReviewHost,
                    router: router,
                    submissionHost: submissionHost,
                    setReturnFocus: { pendingScanReturnFocus = $0 }
                )
            }
        }
    }

    private func fallbackFromPresentedProGate() {
        proGateStore?.fallbackToPhotoReview()
        submissionHost.publishProGatePhotoReviewFallback()
        proGateFocusRequest = UUID()
    }

    private var shell: some View {
        TabView(selection: $router.selectedTab) {
            ForEach(PrimaryTab.allCases) { tab in
                NavigationStack(path: router.pathBinding(for: tab)) {
                    if router.selectedTab == tab {
                        ZStack(alignment: .top) {
                            primaryFeature(for: tab)
#if DEBUG
                            if configuration.keyboardProbe {
                                TextField("Fixture keyboard probe", text: $keyboardProbeText)
                                    .textFieldStyle(.roundedBorder)
                                    .frame(minHeight: SnapListMetrics.minimumTouchTarget)
                                    .padding(SnapListMetrics.screenGutter)
                                    .accessibilityIdentifier("fixture.keyboard-probe")
                            }
#endif
                        }
                        .navigationDestination(for: AppRoute.self) { route in
                            destination(for: route)
                        }
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
                .overlay(alignment: .bottom) {
                    activationGuidanceOverlay
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
    private func primaryFeature(for tab: PrimaryTab) -> some View {
        switch tab {
        case .scan:
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
            .task(id: router.selectedTab) {
                guard router.selectedTab == .scan else { return }
                await captureFlow.startCamera()
            }
        case .trophyWall:
            homeFeature
        }
    }

    @ViewBuilder
    private var homeFeature: some View {
#if DEBUG
        if configuration.fixture == .trophyProcessing {
            TrophyWallProcessingView(
                rows: TrophyWallProcessingLaunchFixture.rows,
                onBack: {},
                openRoute: { router.navigate(to: .home($0)) },
                onScan: {},
                onTryAgain: {}
            )
        } else if configuration.visualState?.ownerIssue == 208 {
            sellerHomeFeature
        } else {
            trophyWallFeature
        }
#else
        trophyWallFeature
#endif
    }

    private var trophyWallFeature: some View {
        TrophyWallFeatureView(
            router: router,
            store: trophyWallStore,
            repository: trophyWallHistoryRepository,
            refreshState: $trophyWallCollectionRefreshState
        )
    }

    private var sellerHomeFeature: some View {
        HomeFeatureView(
            store: homeStore,
            visualState: configuration.visualState,
            openActivity: { router.navigate(to: .activity) },
            openAccount: { router.navigate(to: .settings) },
            openCapture: { router.select(.capture) },
            openRoute: { router.navigate(to: .home($0)) }
        )
    }

    @ViewBuilder
    private func destination(for route: AppRoute) -> some View {
        switch route {
        case .settings:
            SettingsView(
                configuration: configuration,
                mobileAPIClient: dependencies.mobileAPIClient,
                subscriptionClient: dependencies.subscriptionClient,
                analyticsClient: dependencies.analyticsClient,
                ebayPublishService: dependencies.ebayPublishService,
                hasLocalData: (captureFlow.intakeSnapshot.map {
                    !$0.photos.isEmpty || $0.voice != nil
                } ?? false) || settingsCachedData.hasData,
                removeLocalData: {
                    await SettingsLocalRemovalTransaction.perform(
                        removeIntake: {
                            guard let snapshot = captureFlow.intakeSnapshot else {
                                return true
                            }
                            return await dependencies.nativeIntake.perform(
                                .discard(expected: snapshot.version)
                            ) == .committed
                        },
                        removeCachedItems: { settingsCachedData.removeAll() }
                    )
                }
            )
        case .activity:
            FoundationDestinationView(destination: .activity)
        case .home(let route):
            switch route {
            case .processing:
                TrophyWallProcessingDestinationView(
                    store: trophyWallStore,
                    repository: trophyWallHistoryRepository,
                    openRoute: { destination in
                        if case .localRecovery(let logicalIdentity) = destination {
                            router.openLocalRecovery(
                                logicalIdentity,
                                matching: recoverableLocalPendingIdentity,
                                photos: captureFlow.stagedPhotos
                            )
                        } else {
                            router.navigate(to: .home(destination))
                        }
                    },
                    onScan: {
                        router.reset(tab: .scan)
                        router.selectedTab = .scan
                    }
                )
            case .localRecovery:
                EmptyView()
            case .run(let runID):
                RunDetailView(
                    runID: runID,
                    store: runStore,
                    listingReviewStore: listingReviewStore,
                    correctionAvailable:
                        configuration.listingReviewCorrectionAvailable,
                    forceReducedMotion: configuration.forceReducedMotion,
                    goToTrophyWall: {
                        router.reset(tab: .trophyWall)
                        router.selectedTab = .trophyWall
                    },
                    startNewItem: {
                        router.reset(tab: .scan)
                        router.selectedTab = .scan
                    },
                    activationProcessingOpened: {
                        advanceActivationGuidance(for: .openedProcessing)
                    },
                    activationListingReviewOpened: {
                        activationListingReviewPresented = true
                    },
                    activationListingReviewDismissed: {
                        activationListingReviewPresented = false
                    },
                    activationListingReviewInteraction: {
                        advanceActivationGuidance(for: .editedListing)
                    }
                )
            default:
                HomeRouteBoundaryView(route: route)
            }
        case .future(let boundary):
            FoundationDestinationView(destination: boundary)
        }
    }

    private var settingsCachedData: SettingsLocalCachedDataStore {
        SettingsLocalCachedDataStore()
    }

    private var reduceMotion: Bool {
        systemReduceMotion || configuration.forceReducedMotion
    }

    private var shouldShowOnboarding: Bool {
        configuration.usesOnboarding
            && onboardingModel.state.screen != .captureBoundary
            && captureFlow.stagedPhoto == nil
            // A seller standing in the guided camera has already started. Emptying the
            // intake there, by deleting the last photo in Photo Review, must leave them
            // in zero-photo Scan rather than restart onboarding behind the camera.
            && router.presentedFullScreen != .guidedCamera
    }

    private var activationPresentationInputs: ActivationPresentationInputs {
        .init(
            onboardingScreen: onboardingModel.state.screen,
            hasCompletedActivation: hasCompletedActivation
        )
    }

    private var shouldPresentActivation: Bool {
        activationCompletionChecked
            && activationAuthentication != .unknown
            && ActivationPresentationPolicy.shouldPresent(
                hasOnboarded: onboardingModel.state.screen == .captureBoundary,
                hasCompletedActivation: hasCompletedActivation
            )
    }

    private var activationIdentity: String? {
        switch activationAuthentication {
        case .guest:
            "guest"
        case .authenticated(let userID):
            userID
        case .unknown:
            nil
        }
    }

    private var activationSurface: ActivationGuidanceSurface? {
        if activationListingReviewPresented {
            return .listingReview
        }
        if photoReviewHost.session != nil {
            return .photoReview
        }
        if router.selectedTab == .trophyWall,
           router.presentedSheet == nil,
           router.presentedFullScreen == nil {
            return .trophyWall
        }
        if router.selectedTab == .scan,
           router.presentedSheet == nil || router.presentedSheet == .capture,
           router.presentedFullScreen == nil
                || router.presentedFullScreen == .guidedCamera {
            return .scan
        }
        return nil
    }

    private var activationCoachMark: ActivationCoachMark? {
        guard shouldPresentActivation,
              !activationProgress.hasAcknowledgedCurrentState,
              let surface = activationSurface else { return nil }
        return ActivationCoachMark(
            state: activationProgress.state,
            surface: surface
        )
    }

    @ViewBuilder
    private var activationGuidanceOverlay: some View {
        if let coachMark = activationCoachMark {
            ActivationGuidanceCoachMark(
                coachMark: coachMark,
                dismiss: dismissActivationGuidance,
                skip: skipActivationGuidance,
                isCompleting: isCompletingActivation
            )
            .padding(.horizontal, 18)
            .padding(.bottom, activationBottomInset)
        }
    }

    private var activationBottomInset: CGFloat {
        guard let coachMark = activationCoachMark else { return 24 }
        // One anchor contract, proved at the policy seam, so the shell and the
        // coach mark can never disagree about where a state docks.
        return ActivationCoachMarkAnchorPolicy.anchor(
            for: coachMark,
            reduceMotion: reduceMotion
        ).bottomInset
    }

    private func dismissActivationGuidance() {
        advanceActivationGuidance(for: .gotIt)
    }

    private func skipActivationGuidance() {
        guard shouldPresentActivation else { return }
        advanceActivationGuidance(for: .skip)
    }

    private func advanceActivationGuidance(for action: ActivationGuidanceAction) {
        guard shouldPresentActivation else { return }
        switch activationProgress.advance(for: action) {
        case .completionRequested:
            saveActivationProgress()
            completeActivationGuidance()
        case .advanced, .completionRecorded:
            saveActivationProgress()
        case .unchanged:
            break
        }
    }

    private func completeActivationGuidance() {
        switch activationAuthentication {
        case .guest:
            activationGuestCompletionStore.recordCompletion()
            _ = activationProgress.advance(for: .completionRecorded)
            hasCompletedActivation = true
            activationProgressStore.clear(for: "guest")
        case .authenticated(let userID):
            guard !isCompletingActivation else { return }
            isCompletingActivation = true
            Task {
                defer { isCompletingActivation = false }
                while !Task.isCancelled {
                    do {
                        guard try await dependencies.mobileAPIClient
                            .completeActivationGuidance().data.completed else {
                            try await Task.sleep(for: .seconds(2))
                            continue
                        }
                        _ = activationProgress.advance(for: .completionRecorded)
                        hasCompletedActivation = true
                        activationProgressStore.clear(for: userID)
                        return
                    } catch is CancellationError {
                        return
                    } catch {
                        try? await Task.sleep(for: .seconds(2))
                    }
                }
            }
        case .unknown:
            break
        }
    }

    private func recordActivationInterruptionIfNeeded() {
        guard shouldPresentActivation,
              activationProgress.recordInterruption() == .advanced else { return }
        saveActivationProgress()
    }

    private func saveActivationProgress() {
        guard let activationIdentity else { return }
        activationProgressStore.save(
            activationProgress,
            for: activationIdentity
        )
    }

    private func bootstrapActivationCompletion() async {
        while !Task.isCancelled {
            guard onboardingModel.state.screen == .captureBoundary,
                  !hasCompletedActivation else { return }

            let guestCompleted = activationGuestCompletionStore.isCompleted
            let result = await ActivationCompletionBootstrapCoordinator.resolve(
                guestCompleted: guestCompleted,
                loadProgress: { identity in
                    configuration.activationGuidanceFixtureState
                        .map { ActivationGuidanceProgress(state: $0) }
                        ?? activationProgressStore.load(for: identity)
                },
                fetchSessionUserID: {
                    let session = try await dependencies.mobileAPIClient.getSession()
                    return session.data.userId
                },
                fetchTenantCompleted: {
                    try await dependencies.mobileAPIClient
                        .getActivationGuidance().data.completed
                },
                writeTenantCompletion: {
                    try await dependencies.mobileAPIClient
                        .completeActivationGuidance().data.completed
                }
            )

            switch result {
            case .present(let authentication, _, let progress):
                activationAuthentication = authentication
                hasCompletedActivation = false
                activationProgress = progress
                activationCompletionChecked = true
                return
            case .completed(let authentication, let identity):
                activationAuthentication = authentication
                hasCompletedActivation = true
                activationProgress = .recordedInstall
                activationProgressStore.clear(for: identity)
                activationCompletionChecked = true
                return
            case .retry(let authentication):
                activationAuthentication = authentication
                activationCompletionChecked = false
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    private func promoteCompletedGuestMarkerWhenAuthenticated() async {
        while !Task.isCancelled,
              activationAuthentication == .guest,
              activationGuestCompletionStore.isCompleted {
            let result = await ActivationGuestCompletionPromotionCoordinator
                .attempt(
                    fetchSessionUserID: {
                        let session = try await dependencies.mobileAPIClient.getSession()
                        return session.data.userId
                    },
                    fetchTenantCompleted: {
                        try await dependencies.mobileAPIClient
                            .getActivationGuidance().data.completed
                    },
                    writeTenantCompletion: {
                        try await dependencies.mobileAPIClient
                            .completeActivationGuidance().data.completed
                    }
                )
            switch result {
            case .promoted(let userID):
                activationAuthentication = .authenticated(userID: userID)
                activationProgressStore.clear(for: "guest")
                activationProgressStore.clear(for: userID)
                return
            case .waitingForSession, .retry:
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    private var shouldShowFirstValueOnboarding: Bool {
        FirstValueOnboardingPresentationPolicy.shouldPresent(
            isFirstLaunch: configuration.usesFirstValueOnboarding,
            hasCompletedOnboarding:
                firstValueOnboardingModel.hasCompletedOnboarding,
            hasResolvedCaptureRestoration: captureFlow.hasCompletedRestoration,
            hasRestoredCapture: captureFlow.stagedPhoto != nil
        )
            && router.presentedSheet != .capture
    }

    private var awaitsCaptureRestorationBeforeOnboarding: Bool {
        FirstValueOnboardingPresentationPolicy.awaitsCaptureRestoration(
            isFirstLaunch: configuration.usesFirstValueOnboarding,
            hasCompletedOnboarding:
                firstValueOnboardingModel.hasCompletedOnboarding,
            hasResolvedCaptureRestoration: captureFlow.hasCompletedRestoration
        )
    }

    /// The hand-off point for the completion contract issue #566 consumes. #685 owns
    /// emitting and durably recording the outcome; #566 lands the activation-flow wiring
    /// that reads `FirstValueOnboardingCompletionPersisting.outcome` in its own PR.
    private func handleFirstValueOnboardingCompletion(
        _ outcome: FirstValueOnboardingOutcome
    ) {
        onboardingModel.beginPhotoPermissionAfterFirstValueOnboarding()
    }

    private var shouldBypassRetiredLegacyIntro: Bool {
        configuration.usesFirstValueOnboarding
            && firstValueOnboardingModel.hasCompletedOnboarding
            && !onboardingModel.state.screen.hasCompletedLegacyIntro
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
        router.selectedTab = .scan
        router.presentedFullScreen = .guidedCamera
        Task { await captureFlow.startCamera() }
    }

    private func returnFromPhotoReview(
        _ session: PhotoReviewLiveSession
    ) {
        Task {
            let outcome = await AppShellPhotoReviewBackTransaction.perform(
                session: session,
                captureFlow: captureFlow,
                host: photoReviewHost,
                router: router,
                setReturnFocus: { pendingScanReturnFocus = $0 },
                onPersistenceRejected: {
                    recordPhotoReviewSaveFailure(
                        for: .backToCamera,
                        session: session
                    )
                }
            )
            if case .completed = outcome {
                photoReviewSaveFailure = nil
            }
        }
    }

    private func deleteFromPhotoReview(
        _ session: PhotoReviewLiveSession,
        expectedPhotoID: StagedCapturePhoto.ID? = nil
    ) async -> PhotoReviewDeleteApplication? {
        let application = await AppShellPhotoReviewDeleteTransaction.perform(
            session: session,
            captureFlow: captureFlow,
            host: photoReviewHost,
            router: router,
            setReturnFocus: { pendingScanReturnFocus = $0 },
            expectedPhotoID: expectedPhotoID,
            onPersistenceRejected: { photoID in
                recordPhotoReviewSaveFailure(
                    for: .delete(photoID),
                    session: session
                )
            }
        )
        if application != nil {
            photoReviewSaveFailure = nil
        }
        return application
    }

    private func retryPhotoReviewSaveFailure(
        _ session: PhotoReviewLiveSession
    ) {
        guard let failure = photoReviewSaveFailure,
              failure.sessionID == session.id else { return }
        switch failure.action {
        case .backToCamera:
            returnFromPhotoReview(session)
        case .delete(let photoID):
            Task { _ = await deleteFromPhotoReview(session, expectedPhotoID: photoID) }
        }
    }

    private func discardPhotoReviewSaveFailure(
        _ session: PhotoReviewLiveSession
    ) {
        Task {
            guard await AppShellPhotoReviewFailureDiscardTransaction.perform(
                session: session,
                captureFlow: captureFlow,
                host: photoReviewHost,
                router: router,
                setReturnFocus: { pendingScanReturnFocus = $0 }
            ) else {
                return
            }
            photoReviewSaveFailure = nil
        }
    }

    private func recordPhotoReviewSaveFailure(
        for action: PhotoReviewSaveFailureAction,
        session: PhotoReviewLiveSession
    ) {
        guard var existing = photoReviewSaveFailure,
              existing.sessionID == session.id,
              existing.action == action else {
            photoReviewSaveFailure = PhotoReviewSaveFailure(
                sessionID: session.id,
                action: action
            )
            return
        }
        existing.recordAnotherRejection()
        photoReviewSaveFailure = existing
    }

    @discardableResult
    private func dismissActivePhotoReviewForDepartedIntake() async -> Bool {
        guard await AppShellDepartedPhotoReviewTransaction.perform(
            captureFlow: captureFlow,
            host: photoReviewHost,
            router: router,
            setReturnFocus: { pendingScanReturnFocus = $0 }
        ) else {
            return false
        }
        photoReviewIntake = nil
        photoReviewSaveFailure = nil
        return true
    }
}

#if DEBUG
@MainActor
private enum TrophyWallProcessingLaunchFixture {
    private static let principal = TrophyWallPrincipalScope(
        opaqueValue: "trophy-processing-fixture"
    )

    static var rows: [TrophyWallProcessingRow] {
        TrophyWallStore(
            principalScope: principal,
            repository: Repository(
                cards: [
                    .accepted(
                        principalScope: principal,
                        runID: UUID(
                            uuidString: "37500000-0000-4000-8000-000000000003"
                        )!,
                        itemName: "Vintage Pyrex bowl set",
                        lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 30)
                    ),
                    .pending(
                        principalScope: principal,
                        logicalIdentity: TrophyWallLogicalIdentity(
                            idempotencyKey: UUID(
                                uuidString: "37500000-0000-4000-8000-000000000002"
                            )!
                        ),
                        itemName: "Nintendo Game Boy",
                        lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 10)
                    ),
                    .accepted(
                        principalScope: principal,
                        runID: UUID(
                            uuidString: "37500000-0000-4000-8000-000000000004"
                        )!,
                        itemName: "Canon AE-1 film camera",
                        lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 9)
                    ),
                    .accepted(
                        principalScope: principal,
                        runID: UUID(
                            uuidString: "37500000-0000-4000-8000-000000000005"
                        )!,
                        itemName: "Hidden accepted row",
                        lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 8)
                    ),
                    .pending(
                        principalScope: principal,
                        logicalIdentity: TrophyWallLogicalIdentity(
                            idempotencyKey: UUID(
                                uuidString: "37500000-0000-4000-8000-000000000006"
                            )!
                        ),
                        itemName: "Hidden pending row",
                        lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 7)
                    ),
                ]
            )
        ).processingRows
    }

    private struct Repository: TrophyWallRepository {
        let cards: [TrophyWallCard]

        func initialCards(
            for principalScope: TrophyWallPrincipalScope
        ) -> [TrophyWallCard] {
            cards
        }
    }
}
#endif

@MainActor
enum AppShellPhotoReviewBackTransaction {
    static func perform(
        session: PhotoReviewLiveSession,
        captureFlow: CaptureFlowModel,
        host: PhotoReviewLiveHost,
        router: AppRouter,
        setReturnFocus: (PhotoReviewScanFocus) -> Void,
        onPersistenceRejected: () -> Void = {}
    ) async -> PhotoReviewBackOutcome {
        guard host.beginCommit() else {
            return .sessionChanged
        }
        defer { host.endCommit() }

        let outcome = await PhotoReviewBackCoordinator.perform(
            session: session,
            captureFlow: captureFlow,
            host: host
        )

        switch outcome {
        case .persistenceRejected:
            onPersistenceRejected()
        case .sessionChanged:
            break
        case .completed(let request):
            setReturnFocus(request.focus)
            router.returnFromPhotoReview(request)
        }

        return outcome
    }
}

/// Where the shell sends each handoff the coordinator can decide. The switch is
/// exhaustive with no `default` on purpose: the shell used to match `.pay01` and let
/// every other handoff fall into a `break`, so the seller tapped `Start listing` and
/// nothing happened at all. A fourth case must break the build instead.
enum AppShellSubmissionHandoffRoute: Equatable {
    /// A shell-owned surface the seller cannot reach from inside Photo Review.
    case presentProGate(eventID: UUID)
    /// Photo Review already shows this one, so the shell leaves the event standing.
    case showInPhotoReview

    init(
        handoff: ItemRunSubmissionDestinationDecision.Handoff,
        eventID: UUID
    ) {
        switch handoff {
        case .pay01:
            self = .presentProGate(eventID: eventID)
        case .pay08, .accountClaim12aThrough12c:
            self = .showInPhotoReview
        }
    }
}

@MainActor
enum AppShellProGateTransaction {
    static func present(
        eventID: UUID,
        store: ProGateStore,
        submissionHost: ItemRunSubmissionHost
    ) async {
        switch await store.prepare() {
        case .presented:
            guard submissionHost.consumeDestinationHandoff(eventID: eventID)
                    == .pay01 else {
                store.fallbackToPhotoReview()
                return
            }
        case .fallbackToPhotoReview:
            _ = submissionHost
                .replaceProGateHandoffWithPhotoReviewFallback(
                    eventID: eventID
                )
        }
    }

    static func resume(
        store: ProGateStore,
        perform: () async -> Void
    ) async {
        guard store.consumeResumeIntent() else { return }
        await Task.yield()
        await perform()
    }
}

@MainActor
enum AppShellDepartedPhotoReviewTransaction {
    static func perform(
        captureFlow: CaptureFlowModel,
        host: PhotoReviewLiveHost,
        router: AppRouter,
        setReturnFocus: (PhotoReviewScanFocus) -> Void
    ) async -> Bool {
        guard host.session != nil else { return false }
        setReturnFocus(.addPhotoButton)
        guard host.leaveForDepartedIntake(using: router) else { return false }
        await captureFlow.startCamera()
        return true
    }
}

private struct ActivationPresentationInputs: Equatable {
    let onboardingScreen: OnboardingScreen
    let hasCompletedActivation: Bool
}

@MainActor
enum AppShellPhotoReviewSubmissionTransaction {
    static func perform(
        session: PhotoReviewLiveSession,
        captureFlow: CaptureFlowModel,
        host: PhotoReviewLiveHost,
        router: AppRouter,
        submissionHost: ItemRunSubmissionHost,
        setReturnFocus: (PhotoReviewScanFocus) -> Void
    ) async {
        await perform(
            primaryAction: .startListing,
            session: session,
            captureFlow: captureFlow,
            host: host,
            router: router,
            submissionHost: submissionHost,
            setReturnFocus: setReturnFocus
        )
    }

    static func perform(
        primaryAction: PhotoReviewBoundaryEvent,
        session: PhotoReviewLiveSession,
        captureFlow: CaptureFlowModel,
        host: PhotoReviewLiveHost,
        router: AppRouter,
        submissionHost: ItemRunSubmissionHost,
        setReturnFocus: (PhotoReviewScanFocus) -> Void
    ) async {
        let ambiguousRetryEventID: UUID?
        switch primaryAction {
        case .startListing:
            ambiguousRetryEventID = nil
        case .retryAmbiguousSubmission(let eventID):
            guard submissionHost.canRetryAmbiguousSubmission(
                eventID: eventID
            ) else {
                return
            }
            ambiguousRetryEventID = eventID
        case .createAccount:
            await AppShellAccountEntryPointTransaction.perform(
                session: session,
                captureFlow: captureFlow,
                host: host,
                router: router,
                setReturnFocus: setReturnFocus
            )
            return
        case .reviewConflictedSubmission:
            _ = PhotoReviewSubmissionPrimaryActionConsumer.consume(
                primaryAction,
                submissionHost: submissionHost
            )
            return
        case .openVoiceNote, .reviewSubmission:
            return
        }

        // Photo Review stays mounted across the request and the exact clear, exactly
        // like the two exits. Without the lock the seller could delete or reorder in
        // that gap: neither reaches disk, so the clear would not see the change and
        // would remove photos the receipt never described.
        guard host.beginCommit() else {
            return
        }
        defer { host.endCommit() }

        if let ambiguousRetryEventID {
            guard submissionHost.retryAmbiguousSubmission(
                eventID: ambiguousRetryEventID
            ) else {
                return
            }
        }

        await submissionHost.startListing(photos: session.store.photos)

        // A cleared intake leaves no photos to review, and Photo Review has no empty
        // state: its thumbnails would point at deleted files and Back would refuse,
        // because the durable draft it tries to commit is already gone. Zero photos
        // returns to Scan, the same rule the final delete already follows.
        //
        // The final delete hands Scan the empty set to commit because the photo is still
        // on disk at that point. Here the receipt already took it, so Scan is told the
        // draft is gone rather than asked to remove it again. Start the camera before the
        // router returns, so zero-photo Scan arrives as the approved guided camera rather
        // than transiently as "Preparing camera", matching both existing exits.
        //
        // Where an accepted run should actually take the seller is #503.
        guard submissionHost.acceptedRun != nil, submissionHost.clearedIntake else {
            return
        }
        captureFlow.dropIntakeDiscardedElsewhere()
        await captureFlow.startCamera()
        guard host.session === session else {
            return
        }
        setReturnFocus(.addPhotoButton)
        guard host.leaveForClearedIntake(from: session, using: router) else {
            return
        }
        submissionHost.completeClearedIntakePresentation()
    }
}

@MainActor
enum AppShellAccountEntryPointTransaction {
    /// Photo Review covers the whole shell, so Settings opened from under it would
    /// never be seen. Leave the way Back leaves — the seller's photos stay committed
    /// and Scan takes them back — then open the account entry point Settings already
    /// owns. A rejected commit keeps the seller in Photo Review with the message that
    /// sent them here, rather than routing them away from photos that never reached
    /// disk.
    @discardableResult
    static func perform(
        session: PhotoReviewLiveSession,
        captureFlow: CaptureFlowModel,
        host: PhotoReviewLiveHost,
        router: AppRouter,
        setReturnFocus: (PhotoReviewScanFocus) -> Void
    ) async -> Bool {
        let outcome = await AppShellPhotoReviewBackTransaction.perform(
            session: session,
            captureFlow: captureFlow,
            host: host,
            router: router,
            setReturnFocus: setReturnFocus
        )
        guard case .completed = outcome else {
            return false
        }
        // Back reopens the guided camera. Clear it, or the account entry point lands
        // under a full-screen cover the seller never asked for.
        router.presentedFullScreen = nil
        router.navigate(to: .settings)
        return true
    }
}

@MainActor
enum AppShellPhotoReviewDeleteTransaction {
    static func perform(
        session: PhotoReviewLiveSession,
        captureFlow: CaptureFlowModel,
        host: PhotoReviewLiveHost,
        router: AppRouter,
        setReturnFocus: (PhotoReviewScanFocus) -> Void,
        expectedPhotoID: StagedCapturePhoto.ID? = nil,
        onPersistenceRejected: (StagedCapturePhoto.ID) -> Void = { _ in }
    ) async -> PhotoReviewDeleteApplication? {
        guard let photoID = session.store.actionsPhotoID,
              expectedPhotoID == nil || expectedPhotoID == photoID,
              host.beginCommit() else {
            return nil
        }
        defer { host.endCommit() }

        let priorIDs = session.store.photos.map(\.id)
        guard let removedIndex = priorIDs.firstIndex(of: photoID) else {
            return nil
        }
        guard let activationID = session.intakeActivationID else {
            onPersistenceRejected(photoID)
            return nil
        }
        let snapshot = await captureFlow.removePhotoReviewPhoto(
            id: photoID,
            expectedActivationID: activationID
        )
        guard host.session === session else { return nil }
        guard let snapshot else {
            onPersistenceRejected(photoID)
            return nil
        }
        guard [priorIDs, snapshot.photos.map(\.id)]
            .contains(session.store.photos.map(\.id)) else {
            return nil
        }

        if let result = session.publishCommittedDelete(
            id: photoID,
            removedIndex: removedIndex,
            snapshot: snapshot
        ) {
            // Drain the pending value so one accepted delete cannot be announced twice.
            _ = session.consumeDeleteAnnouncement()
            return PhotoReviewDeleteApplication(
                focus: result.focus,
                announcement: result.announcement
            )
        }

        // The final photo leaves Photo Review with no Back to carry it, so Scan's
        // durable intake has to accept the empty set before the boundary is cleared.
        // A rejected write keeps the photo and the seller exactly where they are.
        // Start the camera before the router returns, so zero-photo Scan arrives as the
        // approved guided camera rather than transiently as "Preparing camera". This
        // matches the ordering the Back exit already uses.
        guard priorIDs == [photoID], snapshot.photos.isEmpty else {
            return nil
        }
        session.publishCommittedSnapshot(snapshot)
        await captureFlow.startCamera()
        _ = await captureFlow.markPhotoReviewLeft(
            activationID: session.intakeActivationID
        )

        guard let finalResult = host.completeCommittedFinalDelete(
            from: session,
            using: router
        ) else {
            return nil
        }
        _ = host.consumeFinalDeleteAnnouncement()

        setReturnFocus(finalResult.scanReturn.focus)
        return PhotoReviewDeleteApplication(
            focus: .addButton,
            announcement: finalResult.announcement
        )
    }
}

@MainActor
enum AppShellPhotoReviewFailureDiscardTransaction {
    static func perform(
        session: PhotoReviewLiveSession,
        captureFlow: CaptureFlowModel,
        host: PhotoReviewLiveHost,
        router: AppRouter,
        setReturnFocus: (PhotoReviewScanFocus) -> Void
    ) async -> Bool {
        guard host.session === session, host.beginCommit() else {
            return false
        }
        defer { host.endCommit() }

        guard await captureFlow.discardPhotoReviewPhotos(
            session.store.photos,
            expectedActivationID: session.intakeActivationID
        ) else {
            return false
        }
        guard host.session === session else {
            return false
        }
        _ = await captureFlow.markPhotoReviewLeft(
            activationID: session.intakeActivationID
        )
        guard host.session === session else {
            return false
        }
        await captureFlow.startCamera()
        guard host.session === session,
              host.leaveForDepartedIntake(from: session, using: router) else {
            return false
        }
        setReturnFocus(.addPhotoButton)
        return true
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
                        router.selectedTab = .scan
                        router.presentedSheet = .capture
                        return
                    }
                }
            }
            guard onboardingModel.state.screen == .captureBoundary else { return }
        }

        router.selectedTab = .scan
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

/// Device-local Trophy Wall state belongs to exactly one principal, so it must be
/// cleared whenever the principal changes. Observation is tracked on its own
/// rather than inferred from the stored proof being nil: a signed-out principal
/// has no proof, so the nil check reset on sign-out but not on sign-in, and one
/// seller's local pending card could surface on the next seller's wall. Cold
/// launch still resets nothing, which keeps the DEBUG fixture seed intact.
struct TrophyWallPrincipalFence {
    private var hasObservedScopeProof = false
    private var scopeProof: ItemRunSubmissionPrincipalScopeProof?

    /// Returns whether this observation is a principal transition.
    mutating func observe(
        _ nextScopeProof: ItemRunSubmissionPrincipalScopeProof?
    ) -> Bool {
        defer {
            hasObservedScopeProof = true
            scopeProof = nextScopeProof
        }
        return hasObservedScopeProof && scopeProof != nextScopeProof
    }
}

/// Trophy Wall refreshes on tab entry, and also whenever the shell proves the
/// saved collection can no longer be trusted — a principal transition, or the
/// seller asking to try again after a failed load.
struct TrophyWallCollectionRefreshKey: Equatable {
    let tab: PrimaryTab
    let generation: Int
}

struct TrophyWallCollectionRefreshState {
    private var principalFence = TrophyWallPrincipalFence()
    private(set) var generation = 0

    mutating func observePrincipal(
        _ scopeProof: ItemRunSubmissionPrincipalScopeProof?
    ) -> Bool {
        let didTransition = principalFence.observe(scopeProof)
        if didTransition {
            generation += 1
        }
        return didTransition
    }

    mutating func tryAgain() {
        generation += 1
    }

    func taskID(tab: PrimaryTab) -> TrophyWallCollectionRefreshKey {
        TrophyWallCollectionRefreshKey(tab: tab, generation: generation)
    }
}

enum TrophyWallPendingCardRecovery: Equatable {
    case current(TrophyWallCard?)
    case stalePrincipal

    @MainActor
    static func resolve(
        scopedTo principalScope: TrophyWallPrincipalScope,
        currentScope: @MainActor () -> TrophyWallPrincipalScope,
        load: @MainActor () async -> TrophyWallCard?
    ) async -> TrophyWallPendingCardRecovery {
        let card = await load()
        guard currentScope() == principalScope else {
            return .stalePrincipal
        }
        return .current(card)
    }
}

@MainActor
struct TrophyWallFeatureView: View {
    @Bindable var router: AppRouter
    @Bindable var store: TrophyWallStore
    let repository: any TrophyWallRunHistoryRepository
    @Binding var refreshState: TrophyWallCollectionRefreshState

    var body: some View {
        TrophyWallView(
            store: store,
            openProcessing: {
                router.navigate(to: .home(.processing))
            },
            openAccount: { router.navigate(to: .settings) },
            onScan: {
                router.reset(tab: .scan)
                router.selectedTab = .scan
            },
            onTryAgain: { refreshState.tryAgain() }
        )
        .task(id: refreshState.taskID(tab: router.selectedTab)) {
            guard router.selectedTab == .trophyWall else { return }
            await store.recoverCollection(using: repository)
        }
    }
}

@MainActor
private struct TrophyWallProcessingDestinationView: View {
    @Environment(\.dismiss) private var dismiss

    @Bindable var store: TrophyWallStore
    let repository: any TrophyWallRunHistoryRepository
    let openRoute: (HomeRoute) -> Void
    let onScan: () -> Void

    var body: some View {
        TrophyWallProcessingView(
            rows: store.processingRows,
            collectionOutcome: store.collectionOutcome,
            refreshRecovery: store.collectionRefreshRecovery,
            onBack: { dismiss() },
            openRoute: openRoute,
            onScan: onScan,
            onTryAgain: {
                Task { await store.recoverCollection(using: repository) }
            }
        )
        .navigationBarBackButtonHidden(true)
    }
}

#if DEBUG
#Preview("Foundation shell") {
    let dependencies = AppDependencies.make(configuration: .preview)
    let trophyWallStore = TrophyWallStoreFactory.make(
        configuration: .preview,
        principalScope: TrophyWallPrincipalScope(opaqueValue: "preview")
    )
    AppShellView(
        router: AppRouter(),
        onboardingModel: OnboardingFlowModel(
            cameraAuthorization: FixtureCameraAuthorizationClient(status: .authorized),
            progressStore: InMemoryOnboardingProgressStore(),
            stagedLibraryPhotos: InMemoryStagedLibraryPhotoStore(),
            guestAllowance: DeferredGuestAllowanceCapability()
        ),
        firstValueOnboardingModel: FirstValueOnboardingModel(
            completionStore: InMemoryFirstValueOnboardingCompletionStore()
        ),
        captureFlow: CaptureFlowModel(
            camera: dependencies.captureCamera,
            evaluator: dependencies.framingEvaluator,
            intake: dependencies.nativeIntake
        ),
        homeStore: HomeStore(repository: HomeFixtureRepository(model: HomeFixtures.active)),
        trophyWallStore: trophyWallStore,
        runStore: RunDetailStore(
            service: UnavailableRunService(),
            tokenProvider: PreviewBearerTokenProvider()
        ),
        listingReviewStore: ListingReviewStoreFactory.make(
            configuration: .preview,
            apiOrigin: nil,
            tokenProvider: PreviewBearerTokenProvider(),
            session: .shared
        ),
        submissionHost: ItemRunSubmissionHost(coordinator: nil),
        trophyWallHistoryRepository: UnavailableTrophyWallRunHistoryRepository(),
        configuration: .preview
    )
}

private struct PreviewBearerTokenProvider: BearerTokenProviding {
    func bearerToken() async throws -> String {
        "preview-bearer"
    }
}
#endif
