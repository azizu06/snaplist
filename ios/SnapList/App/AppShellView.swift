import SwiftUI
import UIKit

struct AppShellChromeContext: Equatable {
    let isKeyboardVisible: Bool
    let isLiveCameraPreviewActive: Bool
    let isDeleteAccountFlowPresented: Bool
    let isListingReviewPresented: Bool
    let isGuestClaimPresented: Bool
    let fallbackActivationSurface: ActivationGuidanceSurface?
}

struct AppShellChromeProjection: Equatable {
    let showsDock: Bool
    let activationSurface: ActivationGuidanceSurface?
}

enum AppShellChromePolicy {
    static func project(
        _ context: AppShellChromeContext
    ) -> AppShellChromeProjection {
        AppShellChromeProjection(
            showsDock: DockVisibilityPolicy.shouldShow(
                isKeyboardVisible: context.isKeyboardVisible,
                isLiveCameraPreviewActive: context.isLiveCameraPreviewActive
            )
                && !context.isDeleteAccountFlowPresented
                && !context.isListingReviewPresented
                && !context.isGuestClaimPresented,
            activationSurface: context.isListingReviewPresented
                ? .listingReview
                : context.isGuestClaimPresented
                    ? nil
                    : context.fallbackActivationSurface
        )
    }
}

@MainActor
struct AppShellView: View {
    @Bindable var router: AppRouter
    @Bindable var onboardingModel: OnboardingFlowModel
    @Bindable var firstValueOnboardingModel: FirstValueOnboardingModel
    @Bindable var captureFlow: CaptureFlowModel
    @Bindable var trophyWallStore: TrophyWallStore
    @Bindable var runStore: RunDetailStore
    @Bindable var listingReviewStore: ListingReviewStore
    @Bindable var submissionHost: ItemRunSubmissionHost
    let trophyWallHistoryRepository: any TrophyWallRunHistoryRepository
    let configuration: LaunchConfiguration

    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    /// Shared with the app delegate, which is the only thing that receives a
    /// foreground push (#891).
    private let foregroundPush = PushRegistrationComposition.foregroundPresenter
    @Environment(\.appDependencies) private var dependencies
    @Environment(\.scenePhase) private var scenePhase
    @State private var isKeyboardVisible = false
    @State private var keyboardProbeText = ""
    @State private var isDeleteAccountFlowPresented = false
    @State private var hasConsumedMountedFirstValueDirectScanCommand = false
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
    /// Which principal's durable cover-photo store the wall is currently on, and
    /// whether it has adopted one at all. Both are needed: the scope can be nil
    /// for a launch with no signed-in seller, and a transition can arrive
    /// without the scope changing.
    @State private var trophyWallCoverPhotoAdoption = TrophyWallCoverPhotoAdoption()
    @State private var activationCompletionChecked = false
    @State private var hasCompletedActivation = false
    @State private var activationAuthentication = ActivationAuthenticationState.unknown
    @State private var isCompletingActivation = false
    @State private var activationProgress = ActivationGuidanceProgress()
    @State private var activationListingReviewPresented = false
    @State private var activationGuestClaimPresented = false
    private let activationProgressStore = UserDefaultsActivationGuidanceProgressStore()
    private let activationGuestCompletionStore =
        UserDefaultsActivationGuidanceGuestCompletionStore()

    var body: some View {
        Group {
            if let guestClaimFixture = configuration.guestClaimFixture {
#if DEBUG
                GuestClaimFixtureHostView(
                    fixture: guestClaimFixture,
                    forceReducedMotion: configuration.forceReducedMotion
                )
#else
                shell
#endif
            } else if let ebayPublishFixture = configuration.ebayPublishFixture {
#if DEBUG
                EbayPublishFixtureHostView(
                    fixture: ebayPublishFixture,
                    forceReducedMotion: configuration.forceReducedMotion
                )
#else
                shell
#endif
            } else if let proGateFixture = configuration.proGateFixture {
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
                firstValueOnboardingHost
            } else if shouldRenderNormalShellForHistoricalFirstValueOutcome {
                shell
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
                    forceReducedMotion: configuration.forceReducedMotion,
                    submissionPresentation: configuration.submissionVisualState
                        .map(PhotoReviewSubmissionPresentation.visualState)
                        ?? .idle
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
                        forceReducedMotion: configuration.forceReducedMotion,
                        zoomFixture: configuration.scanZoomFixture
                    )
                } else if visualState.ownerIssue == 729 || visualState == .runDetail {
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
                             .openSubscriptionSettings,
                             .retryReceiptMismatch,
                             .retryAmbiguousSubmission:
                            break
                        case .openVoiceNote,
                             .cancelSubmission,
                             .completeSavedSubmission,
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
                                setReturnFocus: { pendingScanReturnFocus = $0 },
                                onPersistenceRejected: {
                                    recordPhotoReviewSaveFailure(
                                        for: .backToCamera,
                                        session: session
                                    )
                                }
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
        .fixtureAccessibilityOverrides(configuration)
        .overlay(alignment: .bottom) {
            activationGuidanceOverlay
        }
        // Issue #891. Attached here rather than inside the shell so a push that
        // lands during onboarding still has somewhere to draw; the bottom is
        // the dock's, so this takes the top.
        .overlay(alignment: .top) {
            if let notification = foregroundPush.visible {
                ForegroundPushBanner(
                    notification: notification,
                    dismiss: foregroundPush.dismiss
                )
                .padding(.horizontal, SnapListMetrics.screenGutter)
            }
        }
        .animation(
            reduceMotion ? nil : .easeInOut(duration: 0.16),
            value: foregroundPush.visible
        )
        // The delegate reads this to decide whether it may suppress Apple's
        // banner. It is set from the surface that actually draws, because a
        // presenter that claimed to be mounted while nothing was on screen
        // would swallow the notification entirely.
        .onAppear { foregroundPush.mounted = true }
        .onDisappear { foregroundPush.mounted = false }
        // Attached above the shell/onboarding split so both sign-in entry points
        // reach the same surface, whichever host is on screen.
        .sheet(isPresented: $router.presentedAccountEntry) {
            accountEntrySurface
                .fixtureAccessibilityOverrides(configuration)
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
                .fixtureAccessibilityOverrides(configuration)
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
        .onChange(of: scenePhase) { _, phase in
            Task {
                await AppShellProGateTransaction.scenePhaseChanged(
                    phase,
                    store: proGateStore
                )
            }
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
                trophyWallStore.ingestAcceptance(handoff)
                // #890's one prompt moment: the server has accepted an item, so
                // "we'll tell you when it's ready" is now true. Fire-and-forget
                // by design — nothing about the submission may wait on it.
                PushRegistrationComposition.itemSubmitted()
            case nil, .submissionRejected?:
                break
            }
        }
        .task(id: activationPresentationInputs) {
            guard !hasCompletedActivation,
                  ActivationPresentationPolicy.shouldPresent(
                    hasOnboarded: hasOnboardedForActivation,
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
                  captureFlow.hasCompletedRestoration,
                  shouldRouteOnboardingCaptureThroughLauncher else { return }
            await AppCaptureHandoffCoordinator.presentCaptureLauncher(
                onboardingModel: onboardingModel,
                captureFlow: captureFlow,
                router: router
            )
            if router.presentedFullScreen == .guidedCamera, captureFlow.phase != .camera {
                // No more launcher sheet to start the camera on dismiss (#864):
                // arriving here directly must start it itself, or a seller who
                // removes the last staged photo is stuck on "Preparing camera"
                // with no recovery. Guarded on `phase != .camera` because this
                // `.task` can re-run without `presentCaptureLauncher` making a
                // fresh transition (its own top guard then no-ops), and
                // restarting an already-live session is wasted work.
                await captureFlow.startCamera()
            }
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
                        submissionHost.trophyWallPrincipalIdentity
                    ) {
                        trophyWallStore.resetForPrincipalTransition()
                        // The reset drops the collection back to `unknown`, and the
                        // tab-keyed refresh below does not re-run on its own, so a
                        // seller already sitting on the wall would watch it stay
                        // blank until they navigated away and back.
                        //
                        // It also reverts the wall to the unavailable cover
                        // store, so the arriving principal has to adopt again
                        // even when the intake resolves to the same directory.
                        trophyWallCoverPhotoAdoption.principalDidTransition()
                    }
                    // The principal the wall stores under is the one this
                    // snapshot carries — the same value the fence above was
                    // decided from. Asking the intake again here would be a
                    // second read across an await, and the two can disagree:
                    // the fence would not fire, the wall would still hold the
                    // departing seller's cards, and their photos would be
                    // written into the arriving seller's directory.
                    if case .adopt(let coverPhotoScope) =
                        trophyWallCoverPhotoAdoption.scopeToAdopt(
                            for: snapshot.principalScopeComponent
                        ) {
                        trophyWallStore.adoptLocalCoverPhotoStore(
                            TrophyWallLocalCoverPhotoStoreFactory.make(
                                scopeDirectoryComponent: coverPhotoScope
                            )
                        )
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
        switch await store.prepare() {
        case .presented:
            break
        case .fallbackToPhotoReview:
            submissionHost.publishProGatePhotoReviewFallback()
        case .fallbackToAccountClaim:
            submissionHost.publishProGateAccountClaim()
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
        ZStack {
            ForEach(PrimaryTab.allCases) { tab in
                if router.selectedTab == tab {
                    NavigationStack(path: router.pathBinding(for: tab)) {
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
            }
        }
        // #385. Above the stack, not on the settings destination. The deletion
        // tail is pushed by a `navigationDestination` nested two levels inside
        // that destination, and the stack hosts those pushes itself, so a value
        // attached to the destination never reaches them: the tail read the
        // unconfigured default and reported a refusal while every screen looked
        // right. `AccountDeletionUITests` is what catches this.
        .environment(\.accountDeletionDependencies, accountDeletionDependencies)
        .floatingDock(
            selectedTab: router.selectedTab,
            isVisible: shellChromeProjection.showsDock,
            select: router.select
        )
        .animation(
            reduceMotion ? nil : .easeInOut(duration: 0.16),
            value: isKeyboardVisible
        )
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            isKeyboardVisible = true
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            isKeyboardVisible = false
        }
    }

    /// Keeps the typed navigation stack mounted before the seller chooses the
    /// existing-account boundary. That boundary no longer touches this stack: it
    /// sets `router.presentedAccountEntry` and opens as a sheet over the mounted
    /// shell (#799), because ClerkKit's `AuthView` owns its own `NavigationStack`
    /// and refuses to render when pushed onto this one. The stack still has to stay
    /// mounted so the sheet has a live presenter, and so ordinary routes raised from
    /// onboarding — which do push here — keep working without conditional-shell
    /// state or lifecycle scheduling.
    private var firstValueOnboardingHost: some View {
        NavigationStack(path: router.pathBinding(for: router.selectedTab)) {
            FirstValueOnboardingView(
                model: firstValueOnboardingModel,
                forceReducedMotion: configuration.forceReducedMotion,
                usesStaticScoutRendering: configuration.usesStaticScoutRendering,
                didFinish: handleFirstValueOnboardingCompletion,
                openExistingAccount: {
                    router.navigate(to: .future(.account))
                }
            )
            .navigationDestination(for: AppRoute.self) { route in
                destination(for: route)
            }
        }
    }

    @ViewBuilder
    private func primaryFeature(for tab: PrimaryTab) -> some View {
        switch tab {
        case .scan:
            ScanCameraView(
                flow: captureFlow,
                returnFocus: $pendingScanReturnFocus,
                closeCapture: {
                    router.reset(tab: .trophyWall)
                    router.selectedTab = .trophyWall
                }
            ) { destination, photos, opener in
                router.openCaptureBoundary(
                    destination: destination,
                    photos: photos,
                    opener: opener
                )
            }
            .safeAreaPadding(
                .bottom,
                shellChromeProjection.showsDock
                    ? FloatingDockMetrics.containerHeight(for: .scan)
                    : 0
            )
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
            ProcessingListingReviewSurface(
                store: TrophyWallProcessingLaunchFixture.store,
                onBack: {},
                openRoute: { router.navigate(to: .home($0)) },
                onScan: {
                    router.reset(tab: .scan)
                    router.selectedTab = .scan
                },
                goToTrophyWall: {
                    router.reset(tab: .trophyWall)
                    router.selectedTab = .trophyWall
                },
                onTryAgain: {},
                // The fixture has no boundary to re-read, so it stands in for
                // the round trip. Without a duration the refresh state would
                // never be observable on this route.
                onRefresh: {
                    try? await Task.sleep(for: .milliseconds(1200))
                },
                runStore: runStore,
                listingReviewStore: listingReviewStore,
                correctionAvailable: configuration.listingReviewCorrectionAvailable,
                forceReducedMotion: configuration.forceReducedMotion,
                activationListingReviewOpened: {
                    activationListingReviewPresented = true
                },
                activationListingReviewDismissed: {
                    activationListingReviewPresented = false
                },
                activationGuestClaimPresentationChanged: {
                    activationGuestClaimPresented = $0
                },
                activationListingReviewInteraction: {
                    advanceActivationGuidance(for: .editedListing)
                }
            )
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

    /// #385. Built here rather than in the shared dependency factory because
    /// the stores it clears are this view's, and read on the main actor.
    private var accountDeletionDependencies:
        AccountDeletionCoordinator.Dependencies {
        let flow = captureFlow
        let intake = dependencies.nativeIntake
        let cachedData = settingsCachedData
        if let fixture = configuration.accountErasureFixture {
            return AccountDeletionComposition.fixture(fixture)
        }
        // No loopback fallback. `resolveAPIOrigin` rejects 127.0.0.1 outside
        // DEBUG on purpose, and a Release build missing `SnapListAPIOrigin`
        // silently posting an account erasure to a host that is not there is
        // worse than a screen that says this build cannot delete accounts.
        guard let apiOrigin = HomeRepositoryFactory.defaultAPIOrigin else {
            return AccountDeletionComposition.unconfigured()
        }
        return AccountDeletionComposition.make(
            apiOrigin: apiOrigin,
            removeIntake: {
                // Read at removal time, not at render time. A version captured
                // when this property was evaluated goes stale the moment the
                // seller's intake changes, and a discard against a stale
                // version never commits, so every retry for the life of this
                // host would fail the same way.
                guard let version = await MainActor.run(
                    body: { flow.intakeSnapshot?.version }
                ) else { return true }
                return await intake.perform(.discard(expected: version))
                    == .committed
            },
            removeCachedItems: { cachedData.removeAll() }
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
                navigate: { router.navigate(to: $0) },
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
                },
                settingsProofSafeExit: configuration.settingsProofState == nil
                    ? nil
                    : {
                        isDeleteAccountFlowPresented = false
                        router.reset(tab: .trophyWall)
                    },
                deletionFlowPresentationChanged: {
                    isDeleteAccountFlowPresented = $0
                }
            )
        case .home(let route):
            switch route {
            case .processing:
                TrophyWallProcessingDestinationView(
                    store: trophyWallStore,
                    repository: trophyWallHistoryRepository,
                    runStore: runStore,
                    listingReviewStore: listingReviewStore,
                    correctionAvailable:
                        configuration.listingReviewCorrectionAvailable,
                    forceReducedMotion: configuration.forceReducedMotion,
                    activationListingReviewOpened: {
                        activationListingReviewPresented = true
                    },
                    activationListingReviewDismissed: {
                        activationListingReviewPresented = false
                    },
                    activationGuestClaimPresentationChanged: {
                        activationGuestClaimPresented = $0
                    },
                    activationListingReviewInteraction: {
                        advanceActivationGuidance(for: .editedListing)
                    },
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
                    },
                    goToTrophyWall: {
                        router.reset(tab: .trophyWall)
                        router.selectedTab = .trophyWall
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
            }
        case .future(let boundary):
            switch FutureDestinationPresentation.resolve(boundary) {
            case .accountEntry:
                // The account boundary is modal — `AppRoutePresentation` sends it to
                // `presentedAccountEntry`, never onto a stack. Arriving here means
                // something pushed it past the router, which is the #799 failure:
                // the pushed screen owns its own stack and never renders.
                let _ = assertionFailure(
                    "Account entry must be presented modally, not pushed (#799)."
                )
                EmptyView()
            case .placeholder(let destination):
                FoundationDestinationView(destination: destination)
            }
        }
    }

    /// One account surface for every entry point, presented as a sheet because
    /// ClerkKit's `AuthView` owns its own `NavigationStack`.
    @ViewBuilder
    private var accountEntrySurface: some View {
#if DEBUG
        if configuration.usesZeroNetworkFixtures,
           configuration.fixture == .onboarding {
            AccountEntryFixtureView()
        } else {
            AccountEntryView()
                .accessibilityIdentifier("account-entry")
        }
#else
        AccountEntryView()
            .accessibilityIdentifier("account-entry")
#endif
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
            hasOnboarded: hasOnboardedForActivation,
            hasCompletedActivation: hasCompletedActivation
        )
    }

    private var shouldPresentActivation: Bool {
        activationCompletionChecked
            && activationAuthentication != .unknown
            && ActivationPresentationPolicy.shouldPresent(
                hasOnboarded: hasOnboardedForActivation,
                hasCompletedActivation: hasCompletedActivation
            )
    }

    private var hasOnboardedForActivation: Bool {
        FirstValueActivationEligibilityPolicy.shouldBootstrapActivation(
            activeScreen: onboardingModel.state.screen,
            hasConsumedMountedDirectScanCommand:
                hasConsumedMountedFirstValueDirectScanCommand,
            recordedOutcome: firstValueOnboardingModel.recordedOutcome,
            isNormalScanShell: router.selectedTab == .scan
                && router.presentedFullScreen == nil,
            hasRestoredCapture: captureFlow.stagedPhoto != nil,
            stagedPhotoCount: onboardingModel.state.stagedPhotoCount,
            hasPhotoReviewSession: photoReviewHost.session != nil
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

    private var shellChromeProjection: AppShellChromeProjection {
        AppShellChromePolicy.project(
            AppShellChromeContext(
                isKeyboardVisible: isKeyboardVisible,
                isLiveCameraPreviewActive: router.selectedTab == .scan
                    && captureFlow.phase.isLiveCameraPreview,
                isDeleteAccountFlowPresented: isDeleteAccountFlowPresented,
                isListingReviewPresented: activationListingReviewPresented,
                isGuestClaimPresented: activationGuestClaimPresented,
                fallbackActivationSurface: activationFallbackSurface
            )
        )
    }

    private var activationSurface: ActivationGuidanceSurface? {
        shellChromeProjection.activationSurface
    }

    private var activationFallbackSurface: ActivationGuidanceSurface? {
        if photoReviewHost.session != nil {
            return .photoReview
        }
        if router.selectedTab == .trophyWall,
           router.presentedFullScreen == nil {
            return .trophyWall
        }
        if router.selectedTab == .scan,
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
                isCompleting: isCompletingActivation,
                usesStaticScoutRendering: configuration.usesStaticScoutRendering
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
                guard await ActivationCompletionRecordingCoordinator.record(
                    writeTenantCompletion: {
                        try await dependencies.mobileAPIClient
                            .completeActivationGuidance().data.completed
                    }
                ) else { return }
                _ = activationProgress.advance(for: .completionRecorded)
                hasCompletedActivation = true
                activationProgressStore.clear(for: userID)
            }
        case .unknown:
            break
        }
    }

    /// Currently uncalled. Its only caller belonged to the retired seller-Home
    /// fixture. Rewiring activation interruption is owned outside Pro Gate recovery.
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
        let result = await ActivationCompletionBootstrapCoordinator.bootstrap(
            isCancelled: {
                Task.isCancelled
                    || !hasOnboardedForActivation
                    || hasCompletedActivation
            },
            onRetry: { authentication in
                activationAuthentication = authentication
                activationCompletionChecked = false
            },
            guestCompleted: { activationGuestCompletionStore.isCompleted },
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
        case .completed(let authentication, let identity):
            activationAuthentication = authentication
            hasCompletedActivation = true
            activationProgress = .recordedInstall
            activationProgressStore.clear(for: identity)
            activationCompletionChecked = true
        case .retry, .none:
            // The coordinator resolves retries inside its own bound, so a
            // caller only ever sees a terminal result or nothing at all.
            break
        }
    }

    private func promoteCompletedGuestMarkerWhenAuthenticated() async {
        let promotedUserID = await ActivationGuestCompletionPromotionCoordinator
            .promote(
                isCancelled: {
                    Task.isCancelled
                        || activationAuthentication != .guest
                        || !activationGuestCompletionStore.isCompleted
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
        guard let promotedUserID else { return }
        activationAuthentication = .authenticated(userID: promotedUserID)
        activationProgressStore.clear(for: "guest")
        activationProgressStore.clear(for: promotedUserID)
    }

    private var shouldShowFirstValueOnboarding: Bool {
        !hasConsumedMountedFirstValueDirectScanCommand
            && FirstValueOnboardingPresentationPolicy.shouldPresent(
            isFirstLaunch: configuration.usesFirstValueOnboarding,
            hasCompletedOnboarding:
                firstValueOnboardingModel.hasCompletedOnboarding,
            hasResolvedCaptureRestoration: captureFlow.hasCompletedRestoration,
            hasRestoredCapture: captureFlow.stagedPhoto != nil
        )
            && router.presentedFullScreen != .guidedCamera
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
        guard !hasConsumedMountedFirstValueDirectScanCommand,
            FirstValueOnboardingPresentationPolicy
            .shouldRouteMountedCompletionToCanonicalScan(
                isFirstLaunch: configuration.usesFirstValueOnboarding,
                outcome: outcome,
                hasResolvedCaptureRestoration: captureFlow.hasCompletedRestoration,
                hasRestoredCapture: captureFlow.stagedPhoto != nil,
                stagedPhotoCount: onboardingModel.state.stagedPhotoCount
            ) else { return }
        hasConsumedMountedFirstValueDirectScanCommand = true
        router.reset(tab: .scan)
        router.select(.scan)
    }

    /// First-Value completion owns a direct handoff to the canonical Scan root.
    /// Keep the launcher only for the legacy flow and recoverable staged-library work.
    private var shouldRouteOnboardingCaptureThroughLauncher: Bool {
        FirstValueOnboardingPresentationPolicy
            .shouldRouteLegacyCaptureThroughLauncher(
                activeScreen: onboardingModel.state.screen
            )
    }

    private var shouldRenderNormalShellForHistoricalFirstValueOutcome: Bool {
        photoReviewHost.session == nil
            && FirstValueOnboardingPresentationPolicy
            .shouldRenderNormalShellForHistoricalOutcome(
                isFirstLaunch: configuration.usesFirstValueOnboarding,
                recordedOutcome: firstValueOnboardingModel.recordedOutcome,
                activeScreen: onboardingModel.state.screen
            )
    }

    private var onboardingCaptureRouteID: OnboardingCaptureRouteID {
        OnboardingCaptureRouteID(
            screen: onboardingModel.state.screen,
            hasCompletedRestoration: captureFlow.hasCompletedRestoration
        )
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
enum TrophyWallProcessingLaunchFixture {
    private static let principal = TrophyWallPrincipalScope(
        opaqueValue: "trophy-processing-fixture"
    )

    /// Stands in for the thumbnail the capture draft store writes beside a
    /// staged photo. Without it no fixture route reaches a processing row that
    /// carries the seller's own photo, so the suite could not see this state.
    private static let stagedCoverPhoto: Data? = UIImage(
        named: "FirstValueController"
    )?.jpegData(compressionQuality: 0.84)

    static let store = TrophyWallStore(
            principalScope: principal,
            repository: Repository(
                cards: [
                    .accepted(
                        principalScope: principal,
                        runID: UUID(
                            uuidString: "37500000-0000-4000-8000-000000000003"
                        )!,
                        state: .readyToReview,
                        itemName: "Vintage Pyrex bowl set",
                        lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 50)
                    ),
                    .accepted(
                        principalScope: principal,
                        runID: UUID(
                            uuidString: "37500000-0000-4000-8000-000000000004"
                        )!,
                        state: .needsRetryLocked(
                            detail: "The last attempt did not finish."
                        ),
                        itemName: "Canon AE-1 film camera",
                        lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 40)
                    ),
                    .accepted(
                        principalScope: principal,
                        runID: UUID(
                            uuidString: "37500000-0000-4000-8000-000000000005"
                        )!,
                        state: .needsNewCapture(
                            detail: "Add a new photo to try again."
                        ),
                        itemName: "Nintendo Game Boy",
                        lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 30)
                    ),
                    .accepted(
                        principalScope: principal,
                        runID: UUID(
                            uuidString: "37500000-0000-4000-8000-000000000006"
                        )!,
                        state: .retrying,
                        itemName: "Sony Walkman",
                        lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 20)
                    ),
                    .accepted(
                        principalScope: principal,
                        runID: UUID(
                            uuidString: "37500000-0000-4000-8000-000000000007"
                        )!,
                        state: .notListed(
                            detail: "This item could not be processed."
                        ),
                        itemName: "Polaroid camera",
                        lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 10)
                    ),
                    .accepted(
                        principalScope: principal,
                        runID: UUID(
                            uuidString: "37500000-0000-4000-8000-000000000011"
                        )!,
                        state: .accepted,
                        itemName: "DualSense controller",
                        localCoverPhotoData: stagedCoverPhoto,
                        lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 5)
                    ),
                ]
            )
        )

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
        case .pay08, .accountClaim12aThrough12c, .subscriptionSettings:
            // Photo Review carries the message and the seller taps out of it to
            // Settings, exactly the way the account handoff already works.
            self = .showInPhotoReview
        }
    }
}

@MainActor
enum AppShellProGateTransaction {
    static func scenePhaseChanged(
        _ phase: ScenePhase,
        store: ProGateStore?
    ) async {
        guard phase == .active else { return }
        await store?.refreshPendingVerification()
    }

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
        case .fallbackToAccountClaim:
            _ = submissionHost
                .replaceProGateHandoffWithAccountClaim(eventID: eventID)
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
    let hasOnboarded: Bool
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
        setReturnFocus: (PhotoReviewScanFocus) -> Void,
        onPersistenceRejected: () -> Void = {}
    ) async {
        let receiptMismatchRetryEventID: UUID?
        let ambiguousRetryEventID: UUID?
        switch primaryAction {
        case .startListing:
            receiptMismatchRetryEventID = nil
            ambiguousRetryEventID = nil
        case .retryReceiptMismatch(let eventID):
            guard case .destinationHandoff(
                eventID: let pendingEventID,
                handoff: .pay08
            )? = submissionHost.pendingPresentationEvent,
                  pendingEventID == eventID else {
                return
            }
            receiptMismatchRetryEventID = eventID
            ambiguousRetryEventID = nil
        case .retryAmbiguousSubmission(let eventID):
            guard submissionHost.canRetryAmbiguousSubmission(
                eventID: eventID
            ) else {
                return
            }
            receiptMismatchRetryEventID = nil
            ambiguousRetryEventID = eventID
        case .createAccount(let eventID):
            guard case .destinationHandoff(
                eventID: let pendingEventID,
                handoff: .accountClaim12aThrough12c
            )? = submissionHost.pendingPresentationEvent,
                  pendingEventID == eventID else {
                return
            }
            guard await AppShellSettingsEntryPointTransaction.perform(
                session: session,
                captureFlow: captureFlow,
                host: host,
                router: router,
                setReturnFocus: setReturnFocus,
                onPersistenceRejected: onPersistenceRejected
            ) else {
                return
            }
            _ = submissionHost.consumeDestinationHandoff(eventID: eventID)
            return
        case .openSubscriptionSettings(let eventID):
            // The same leave-then-open-Settings route the account handoff takes.
            // The guard is what keeps it typed: only the two subscription
            // denials can spend this event, so a stale or unrelated pending
            // event cannot walk the seller out of Photo Review.
            guard case .destinationHandoff(
                eventID: let pendingEventID,
                handoff: .subscriptionSettings
            )? = submissionHost.pendingPresentationEvent,
                  pendingEventID == eventID else {
                return
            }
            guard await AppShellSettingsEntryPointTransaction.perform(
                session: session,
                captureFlow: captureFlow,
                host: host,
                router: router,
                setReturnFocus: setReturnFocus,
                onPersistenceRejected: onPersistenceRejected
            ) else {
                return
            }
            _ = submissionHost.consumeDestinationHandoff(eventID: eventID)
            return
        case .reviewConflictedSubmission:
            _ = PhotoReviewSubmissionPrimaryActionConsumer.consume(
                primaryAction,
                submissionHost: submissionHost
            )
            return
        case .openVoiceNote, .cancelSubmission,
             .completeSavedSubmission, .reviewSubmission:
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

        if let receiptMismatchRetryEventID {
            guard submissionHost.consumeDestinationHandoff(
                eventID: receiptMismatchRetryEventID
            ) == .pay08 else {
                return
            }
        }
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
enum AppShellSettingsEntryPointTransaction {
    /// Photo Review covers the whole shell, so Settings opened from under it would
    /// never be seen. Leave the way Back leaves — the seller's photos stay committed
    /// and Scan takes them back — then open Settings, which owns both the account
    /// entry point and the subscription's real state.
    ///
    /// #868: this used to return `false` whenever that commit was refused, so the
    /// button a denial screen had just handed the seller did nothing at all. A denial
    /// is a stop only Settings can lift, and a refused commit is not a reason to hold
    /// the seller inside the screen telling them to go elsewhere. So the destination
    /// is reached either way, and the refusal travels the Back button's own callback
    /// rather than being swallowed.
    ///
    /// A refusal on this route is a divergence, not lost work. Live intake edits are
    /// already durable when Photo Review makes them, and the commit only re-checks
    /// that the durable intake still matches the screen — which is exactly what
    /// signing in mid-session breaks (#855). Leaving through the departed-intake exit
    /// says that truthfully: Scan is told this session's photos are no longer its
    /// intake instead of being handed a set the commit could not confirm.
    @discardableResult
    static func perform(
        session: PhotoReviewLiveSession,
        captureFlow: CaptureFlowModel,
        host: PhotoReviewLiveHost,
        router: AppRouter,
        setReturnFocus: (PhotoReviewScanFocus) -> Void,
        onPersistenceRejected: () -> Void = {}
    ) async -> Bool {
        let outcome = await AppShellPhotoReviewBackTransaction.perform(
            session: session,
            captureFlow: captureFlow,
            host: host,
            router: router,
            setReturnFocus: setReturnFocus,
            onPersistenceRejected: onPersistenceRejected
        )
        switch outcome {
        case .completed:
            break
        case .persistenceRejected:
            setReturnFocus(.addPhotoButton)
            guard host.leaveForDepartedIntake(
                from: session,
                using: router
            ) else {
                return false
            }
        case .sessionChanged:
            // Either another exit already owns the commit lock or the screen has
            // moved on to a different session. Neither is this tap's to tear down,
            // and the owning transaction will finish its own route.
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
                        router.presentedFullScreen = .guidedCamera
                        return
                    }
                }
            }
            guard onboardingModel.state.screen == .captureBoundary else { return }
        }

        router.selectedTab = .scan
        router.presentedFullScreen = .guidedCamera
    }
}

private struct OnboardingCaptureRouteID: Hashable {
    let screen: OnboardingScreen
    let hasCompletedRestoration: Bool
}

extension View {
    /// The pair of fixture accessibility overrides, applied as one unit.
    ///
    /// They were hand-applied at four separate call sites, and the fifth one —
    /// the capture sheet — was added without them. A SwiftUI sheet builds its
    /// own environment, so the pair attached to the shell never reached that
    /// content, `--dynamic-type=` did nothing to Scan, and every Scan
    /// measurement taken through that route was of the default size (#836).
    /// One entry point makes the next sheet unable to repeat it: there is no
    /// longer a way to attach one override and forget the other (#839).
    func fixtureAccessibilityOverrides(
        _ configuration: LaunchConfiguration
    ) -> some View {
        modifier(OptionalDynamicTypeModifier(size: configuration.dynamicTypeSize))
            .modifier(
                OptionalBoldTextModifier(isEnabled: configuration.boldTextEnabled)
            )
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

/// Overrides `\.legibilityWeight` to `.bold` when the fixture harness asks
/// for it, since a UI test cannot flip the real OS-level Bold Text setting
/// the way `OptionalDynamicTypeModifier` can flip Dynamic Type (#831).
private struct OptionalBoldTextModifier: ViewModifier {
    let isEnabled: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if isEnabled {
            content.environment(\.legibilityWeight, .bold)
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
///
/// What it compares is `TrophyWallPrincipalIdentity`, not the scope proof alone.
/// The proof exists only while photos are staged, so an ordinary submit — which
/// deletes them — used to read as a sign-out and wiped the seller's own
/// processing photo off their wall seconds after it arrived (#867).
struct TrophyWallPrincipalFence {
    private var hasObservedIdentity = false
    private var identity: TrophyWallPrincipalIdentity?

    /// Returns whether this observation is a principal transition.
    mutating func observe(
        _ nextIdentity: TrophyWallPrincipalIdentity?
    ) -> Bool {
        defer {
            hasObservedIdentity = true
            identity = nextIdentity
        }
        guard hasObservedIdentity else {
            return false
        }
        switch (identity, nextIdentity) {
        case (let previous?, let next?):
            return next.isTransition(from: previous)
        case (nil, nil):
            return false
        // A principal appearing where there was none, or disappearing
        // entirely, is a transition in both directions. The nil side is a
        // shell that has no committed intake at all, which no signed-in
        // seller's cards may survive.
        case (nil, _?), (_?, nil):
            return true
        }
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
        _ identity: TrophyWallPrincipalIdentity?
    ) -> Bool {
        let didTransition = principalFence.observe(identity)
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
            openRun: { router.navigate(to: .home(.run($0))) },
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
    @Bindable var runStore: RunDetailStore
    @Bindable var listingReviewStore: ListingReviewStore
    let correctionAvailable: Bool
    let forceReducedMotion: Bool
    let activationListingReviewOpened: () -> Void
    let activationListingReviewDismissed: () -> Void
    let activationGuestClaimPresentationChanged: (Bool) -> Void
    let activationListingReviewInteraction: () -> Void
    let openRoute: (HomeRoute) -> Void
    let onScan: () -> Void
    let goToTrophyWall: () -> Void

    var body: some View {
        ProcessingListingReviewSurface(
            store: store,
            onBack: { dismiss() },
            openRoute: openRoute,
            onScan: onScan,
            goToTrophyWall: goToTrophyWall,
            onTryAgain: {
                Task { await store.recoverCollection(using: repository) }
            },
            // One ask, one request. `recoverCollection` belongs to the failure
            // path, where the client keeps trying on its own; a seller asking
            // for fresh status gets exactly the request they asked for (#897).
            onRefresh: { await store.refreshCollection(using: repository) },
            runStore: runStore,
            listingReviewStore: listingReviewStore,
            correctionAvailable: correctionAvailable,
            forceReducedMotion: forceReducedMotion,
            activationListingReviewOpened: activationListingReviewOpened,
            activationListingReviewDismissed: activationListingReviewDismissed,
            activationGuestClaimPresentationChanged:
                activationGuestClaimPresentationChanged,
            activationListingReviewInteraction: activationListingReviewInteraction
        )
        .navigationBarBackButtonHidden(true)
    }
}

@MainActor
private struct ProcessingListingReviewSurface: View {
    @Environment(\.appDependencies) private var dependencies

    @Bindable var store: TrophyWallStore
    let onBack: () -> Void
    let openRoute: (HomeRoute) -> Void
    let onScan: () -> Void
    let goToTrophyWall: () -> Void
    let onTryAgain: () -> Void
    let onRefresh: () async -> Void
    @Bindable var runStore: RunDetailStore
    @Bindable var listingReviewStore: ListingReviewStore
    let correctionAvailable: Bool
    let forceReducedMotion: Bool
    let activationListingReviewOpened: () -> Void
    let activationListingReviewDismissed: () -> Void
    let activationGuestClaimPresentationChanged: (Bool) -> Void
    let activationListingReviewInteraction: () -> Void
    @State private var guestClaimPresentation =
        ProcessingGuestClaimPresentationHost()
    @State private var listingReviewPresentation =
        ListingReviewPresentationHost()

    var body: some View {
        @Bindable var listingReviewPresentation = listingReviewPresentation
        TrophyWallProcessingView(
            rows: store.processingRows,
            collectionOutcome: store.collectionOutcome,
            refreshRecovery: store.collectionRefreshRecovery,
            onBack: onBack,
            openRoute: openRoute,
            onAction: { action in
                let executor = ProcessingActionExecutor(
                    runStore: runStore,
                    listingReviewStore: listingReviewStore,
                    guestClaimPresentation: guestClaimPresentation,
                    listingReviewPresentation: listingReviewPresentation,
                    applyRetryResult: { store.applyRetryResult($0) },
                    selectScan: onScan
                )
                Task {
                    switch await executor.execute(action) {
                    case .presentedGuestClaim:
                        activationGuestClaimPresentationChanged(true)
                    case .presentedReview:
                        activationListingReviewOpened()
                    default:
                        break
                    }
                }
            },
            onScan: onScan,
            onTryAgain: onTryAgain,
            onRefresh: onRefresh
        )
        .navigationDestination(
            isPresented: Binding(
                get: { guestClaimPresentation.isPresented },
                set: { isPresented in
                    if !isPresented {
                        guestClaimPresentation.dismiss()
                        activationGuestClaimPresentationChanged(false)
                    }
                }
            )
        ) {
            if let context = guestClaimPresentation.context {
                ProcessingGuestClaimSurface(
                    context: context,
                    dependencies: dependencies,
                    forceReducedMotion: forceReducedMotion,
                    backToProcessing: {
                        guestClaimPresentation.dismiss()
                        activationGuestClaimPresentationChanged(false)
                    },
                    continueToListingReview: { listing in
                        Task { await openClaimedListing(listing) }
                    },
                    startNewItem: {
                        guestClaimPresentation.dismiss()
                        activationGuestClaimPresentationChanged(false)
                        onScan()
                    }
                )
            }
        }
        .navigationDestination(isPresented: $listingReviewPresentation.isPresented) {
            ListingReviewView(
                store: listingReviewStore,
                correctionAvailable: correctionAvailable,
                forceReducedMotion: forceReducedMotion,
                dismissReview: { listingReviewPresentation.dismiss() },
                goToTrophyWall: goToTrophyWall,
                startNewItem: onScan,
                activationInteraction: activationListingReviewInteraction
            )
        }
        .onChange(of: listingReviewPresentation.isPresented) { _, isPresented in
            if !isPresented {
                activationListingReviewDismissed()
            }
        }
    }

    private func openClaimedListing(
        _ listing: ClaimedGuestListing
    ) async {
        guard let context = guestClaimPresentation.takeClaimed(listing) else {
            return
        }
        guard await listingReviewPresentation.open(
                context.review,
                expecting: context.review.binding,
                using: listingReviewStore
              ) else {
            activationGuestClaimPresentationChanged(false)
            return
        }
        activationListingReviewOpened()
        activationGuestClaimPresentationChanged(false)
    }
}

@MainActor
private struct ProcessingGuestClaimSurface: View {
    let context: ProcessingGuestClaimContext
    let dependencies: AppDependencies
    let forceReducedMotion: Bool
    let backToProcessing: () -> Void
    let continueToListingReview: (ClaimedGuestListing) -> Void
    let startNewItem: () -> Void

    @State private var store: GuestClaimStore

    init(
        context: ProcessingGuestClaimContext,
        dependencies: AppDependencies,
        forceReducedMotion: Bool,
        backToProcessing: @escaping () -> Void,
        continueToListingReview: @escaping (ClaimedGuestListing) -> Void,
        startNewItem: @escaping () -> Void
    ) {
        self.context = context
        self.dependencies = dependencies
        self.forceReducedMotion = forceReducedMotion
        self.backToProcessing = backToProcessing
        self.continueToListingReview = continueToListingReview
        self.startNewItem = startNewItem
        _store = State(
            initialValue: GuestClaimStore(
                authority: context.authority,
                authenticator: dependencies.guestAccountAuthenticator,
                service: dependencies.guestClaimService,
                authorityStore: dependencies.guestClaimAuthorityStore,
                credentialStore: KeychainGuestRecoveryCredentialStore(),
                funnelAnalytics: dependencies.funnelAnalytics,
                authenticatedUserID: ClerkAuthenticationComposition.currentUserID
            )
        )
    }

    var body: some View {
        GuestClaimView(
            store: store,
            sessionSource: dependencies.accountEntrySessionSource,
            listingProjection: context.projection,
            accountEntryPresentation: .supported,
            forceReducedMotion: forceReducedMotion,
            backToDraft: backToProcessing,
            continueToItem: continueToListingReview,
            startNewItem: startNewItem
        )
        .task(id: context.authority.recoveryID) {
            await store.resumeClaim()
        }
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
