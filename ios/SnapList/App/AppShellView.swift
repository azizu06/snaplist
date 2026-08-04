import SwiftUI
import UIKit

@MainActor
struct AppShellView: View {
    @Bindable var router: AppRouter
    @Bindable var onboardingModel: OnboardingFlowModel
    @Bindable var captureFlow: CaptureFlowModel
    @Bindable var homeStore: HomeStore
    @Bindable var runStore: RunDetailStore
    @Bindable var listingReviewStore: ListingReviewStore
    @Bindable var submissionHost: ItemRunSubmissionHost
    let configuration: LaunchConfiguration

    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @Environment(\.appDependencies) private var dependencies
    @Environment(\.scenePhase) private var scenePhase
    @State private var isKeyboardVisible = false
    @State private var keyboardProbeText = ""
    @State private var pendingCapturePresentation: PendingCapturePresentation?
    @State private var pendingScanReturnFocus: PhotoReviewScanFocus?
    @State private var photoReviewHost = PhotoReviewLiveHost()
    @State private var photoReviewIntake: PhotoReviewIntake?
    @State private var awaitsPrincipalReviewDismissal = false
    @State private var awaitsCommittedEmptyDismissal = false

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
                        host: submissionHost
                    ),
                    acknowledgeSubmissionPresentation: { eventID in
                        submissionHost.acknowledgePresentation(eventID: eventID)
                    },
                    backToCamera: {
                        returnFromPhotoReview(session)
                    },
                    delete: {
                        await AppShellPhotoReviewDeleteTransaction.perform(
                            session: session,
                            captureFlow: captureFlow,
                            host: photoReviewHost,
                            router: router,
                            setReturnFocus: { pendingScanReturnFocus = $0 }
                        )
                    },
                    commitReorder: { photoID, destinationIndex in
                        await session.commitReorder(
                            photoID: photoID,
                            destinationIndex: destinationIndex,
                            captureFlow: captureFlow
                        )
                    },
                    // Photo Review consumes #469's Voice note event locally. Start
                    // listing submits the committed NativeIntake snapshot: displayed
                    // photo order plus #541's optional recovered WAV under one key.
                    openBoundary: { event in
                        if PhotoReviewSubmissionPrimaryActionConsumer.consume(
                            event,
                            submissionHost: submissionHost
                        ) {
                            return
                        }
                        switch event {
                        case .startListing, .retryAmbiguousSubmission:
                            break
                        case .openVoiceNote,
                             .reviewSubmission,
                             .reviewConflictedSubmission:
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
        }
        // Home's update loop is suspended from the outermost view. Photo Review replaces
        // the shell while it is open, so anything attached to the shell stops observing
        // scene changes exactly when the seller is most likely to background the app.
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
        } else {
            sellerHomeFeature
        }
#else
        sellerHomeFeature
#endif
    }

    private var sellerHomeFeature: some View {
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
                RunDetailView(
                    runID: runID,
                    store: runStore,
                    listingReviewStore: listingReviewStore,
                    correctionAvailable:
                        configuration.listingReviewCorrectionAvailable,
                    forceReducedMotion: configuration.forceReducedMotion
                )
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
            // A seller standing in the guided camera has already started. Emptying the
            // intake there, by deleting the last photo in Photo Review, must leave them
            // in zero-photo Scan rather than restart onboarding behind the camera.
            && router.presentedFullScreen != .guidedCamera
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
            _ = await AppShellPhotoReviewBackTransaction.perform(
                session: session,
                captureFlow: captureFlow,
                host: photoReviewHost,
                router: router,
                setReturnFocus: { pendingScanReturnFocus = $0 }
            )
        }
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
        setReturnFocus: (PhotoReviewScanFocus) -> Void
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
        case .persistenceRejected, .sessionChanged:
            break
        case .completed(let request):
            setReturnFocus(request.focus)
            router.returnFromPhotoReview(request)
        }

        return outcome
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
enum AppShellPhotoReviewDeleteTransaction {
    static func perform(
        session: PhotoReviewLiveSession,
        captureFlow: CaptureFlowModel,
        host: PhotoReviewLiveHost,
        router: AppRouter,
        setReturnFocus: (PhotoReviewScanFocus) -> Void
    ) async -> PhotoReviewDeleteApplication? {
        guard let photoID = session.store.actionsPhotoID, host.beginCommit() else {
            return nil
        }
        defer { host.endCommit() }

        let priorIDs = session.store.photos.map(\.id)
        guard let removedIndex = priorIDs.firstIndex(of: photoID) else {
            return nil
        }
        guard let activationID = session.intakeActivationID,
              let snapshot = await captureFlow.removePhotoReviewPhoto(
                  id: photoID,
                  expectedActivationID: activationID
              ),
              host.session === session,
              [priorIDs, snapshot.photos.map(\.id)]
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
            intake: dependencies.nativeIntake
        ),
        homeStore: HomeStore(repository: HomeFixtureRepository(model: HomeFixtures.active)),
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
        configuration: .preview
    )
}

private struct PreviewBearerTokenProvider: BearerTokenProviding {
    func bearerToken() async throws -> String {
        "preview-bearer"
    }
}
#endif
