import Foundation
import Observation

enum FirstValueOnboardingPresentationPolicy {
    /// Onboarding is a first-launch surface, so it must never win a race with work the
    /// seller already has in flight. A durable capture is restored asynchronously, and
    /// until that resolves the shell cannot tell a genuine first launch from a returning
    /// seller — so presentation waits for the answer instead of guessing from an
    /// as-yet-empty staged photo.
    static func shouldPresent(
        isFirstLaunch: Bool,
        hasCompletedOnboarding: Bool,
        hasResolvedCaptureRestoration: Bool,
        hasRestoredCapture: Bool
    ) -> Bool {
        isFirstLaunch
            && !hasCompletedOnboarding
            && hasResolvedCaptureRestoration
            && !hasRestoredCapture
    }

    /// True while the shell must hold a neutral surface: onboarding would otherwise be
    /// presented before capture restoration proves whether a capture is waiting.
    static func awaitsCaptureRestoration(
        isFirstLaunch: Bool,
        hasCompletedOnboarding: Bool,
        hasResolvedCaptureRestoration: Bool
    ) -> Bool {
        isFirstLaunch && !hasCompletedOnboarding && !hasResolvedCaptureRestoration
    }
}

enum FirstValueOnboardingScreen: Int, CaseIterable, Codable, Equatable {
    case onb01 = 1
    case onb02
    case onb03
    case onb04
    case onb05
    case onb06

    var identifier: String {
        "ONB-0\(rawValue)"
    }

    var next: FirstValueOnboardingScreen? {
        FirstValueOnboardingScreen(rawValue: rawValue + 1)
    }

    var previous: FirstValueOnboardingScreen? {
        FirstValueOnboardingScreen(rawValue: rawValue - 1)
    }

    var scout: FirstValueScoutPresentation {
        switch self {
        case .onb01:
            .init(clip: "048-seedance-welcome-wave-safe-margin", fallback: "FirstValueScoutONB01", size: 116, leadingPull: -10)
        case .onb02:
            .init(clip: "007-seedance-magnifier-inspection", fallback: "FirstValueScoutONB02", size: 126, leadingPull: -14)
        case .onb03:
            .init(clip: "032-seedance-barcode-scan", fallback: "FirstValueScoutONB03", size: 123, leadingPull: -12)
        case .onb04:
            .init(clip: "040-seedance-recovery-safe-cue", fallback: "FirstValueScoutONB04", size: 147, leadingPull: -10)
        case .onb05:
            .init(clip: "030-seedance-box-lower-lift-hflip-candidate", fallback: "FirstValueScoutONB05", size: 122, leadingPull: -4)
        case .onb06:
            .init(clip: "042-seedance-reassurance", fallback: "FirstValueScoutONB06", size: 167, leadingPull: -14)
        }
    }

    func scoutMedia(reduceMotion: Bool) -> FirstValueScoutMedia {
        if reduceMotion {
            return .staticFallbackPNG(asset: scout.fallback)
        }
        return .acceptedWebM(resource: scout.clip)
    }

    /// Resolves what the Scout view actually renders, with the accepted clip already
    /// looked up in the bundle.
    ///
    /// The lookup lives here rather than inside the WebKit-backed view so a test can
    /// prove the normal-motion path selects this screen's accepted clip *and* finds its
    /// resource, without loading WebKit into the process. `usesStaticRendering` is the
    /// UI-test seam: iOS 26.5 automation injects WebCore/WebKit accessibility bundles the
    /// moment a WKWebView is created and crashes later tests in the same shard, so the
    /// runner opts out of WebKit while Debug and Release builds keep the accepted WebM.
    /// A clip that cannot be resolved degrades to its own static fallback rather than
    /// rendering nothing.
    func scoutRendering(
        reduceMotion: Bool,
        usesStaticRendering: Bool = false,
        bundle: Bundle = .main
    ) -> FirstValueScoutRendering {
        guard !usesStaticRendering,
              case .acceptedWebM(let resource) = scoutMedia(reduceMotion: reduceMotion),
              let url = bundle.url(
                forResource: resource,
                withExtension: Self.scoutResourceExtension,
                subdirectory: Self.scoutResourceSubdirectory
              ) else {
            return .staticFallbackPNG(asset: scout.fallback)
        }
        return .acceptedWebM(url: url)
    }

    static let scoutResourceSubdirectory = "FirstValueOnboarding"
    static let scoutResourceExtension = "webm"
}

struct FirstValueScoutPresentation: Equatable {
    let clip: String
    let fallback: String
    let size: CGFloat
    let leadingPull: CGFloat
}

enum FirstValueScoutMedia: Equatable {
    case acceptedWebM(resource: String)
    case staticFallbackPNG(asset: String)
}

enum FirstValueScoutRendering: Equatable {
    case acceptedWebM(url: URL)
    case staticFallbackPNG(asset: String)
}

/// The completion contract issue #566's first-listing activation flow consumes.
///
/// Onboarding deliberately does not hand #566 a bare "done" flag. The activation flow
/// has to treat a seller who read all six screens differently from one who skipped them,
/// and differently again from one who never saw them because a durable capture was
/// already waiting. Every terminal path writes its outcome through
/// `FirstValueOnboardingCompletionPersisting` before the flow is dismissed, so a
/// consumer constructed on a later launch reads exactly what the live
/// `FirstValueOnboardingModel.outcome` published on this one.
///
/// This issue (#685) owns the seam and its persistence; #566 owns the wiring that reads
/// it, in its own PR.
enum FirstValueOnboardingOutcome: String, Codable, Equatable, CaseIterable {
    /// The seller reached ONB-06 and chose `Start scanning`.
    case completed
    /// The seller used `Skip` before ONB-06.
    case skipped
    /// The six screens were never shown because the seller already had progress on
    /// this device — a restored durable capture, or persisted onboarding progress past
    /// the retired intro. #566 must not treat this seller as taught.
    case supersededByExistingProgress = "superseded-by-existing-progress"

    /// Whether this seller actually saw the six-screen flow.
    var hasSeenIntroduction: Bool {
        switch self {
        case .completed, .skipped:
            true
        case .supersededByExistingProgress:
            false
        }
    }
}

@MainActor
@Observable
final class FirstValueOnboardingModel {
    private(set) var screen: FirstValueOnboardingScreen
    private(set) var outcome: FirstValueOnboardingOutcome?

    private let completionStore: any FirstValueOnboardingCompletionPersisting

    init(
        screen: FirstValueOnboardingScreen = .onb01,
        completionStore: any FirstValueOnboardingCompletionPersisting
    ) {
        self.screen = screen
        self.completionStore = completionStore
    }

    var hasCompletedOnboarding: Bool {
        completionStore.hasCompletedOnboarding
    }

    /// The durably recorded outcome, including one written by an earlier launch.
    var recordedOutcome: FirstValueOnboardingOutcome? {
        completionStore.outcome
    }

    func continueForward() {
        guard outcome == nil else { return }
        guard let next = screen.next else {
            complete(with: .completed)
            return
        }
        screen = next
    }

    func goBack() {
        guard outcome == nil, let previous = screen.previous else { return }
        screen = previous
    }

    func skip() {
        guard screen != .onb06, outcome == nil else { return }
        complete(with: .skipped)
    }

    /// Records that onboarding was superseded by work the seller already has on this
    /// device, so the six screens are never presented on top of it.
    func reconcileExistingProgress() {
        guard !hasCompletedOnboarding else { return }
        complete(with: .supersededByExistingProgress)
    }

    private func complete(with outcome: FirstValueOnboardingOutcome) {
        completionStore.record(outcome)
        self.outcome = outcome
    }
}

enum OnboardingScreen: String, Codable, Equatable, Hashable {
    case launch
    case promise
    case allowance
    case photoPrimer
    case denied
    case cameraHandoff
    case libraryHandoff
    case captureBoundary
    case settingsHandoff

    init?(visualState: ApprovedVisualStateID) {
        switch visualState {
        case .onboardingLaunch:
            self = .launch
        case .onboardingPromise, .returningSignIn:
            self = .promise
        case .onboardingMarketplace, .onboardingAllowance:
            self = .allowance
        case .onboardingPhotoPrimer, .nativeCameraPermission:
            self = .photoPrimer
        case .onboardingDenied:
            self = .denied
        case .settingsHandoff:
            self = .settingsHandoff
        case .onboardingCameraHandoff:
            self = .cameraHandoff
        case .onboardingLibraryHandoff:
            self = .libraryHandoff
        default:
            return nil
        }
    }

    var hasCompletedLegacyIntro: Bool {
        switch self {
        case .photoPrimer, .denied, .cameraHandoff, .libraryHandoff,
             .captureBoundary, .settingsHandoff:
            true
        case .launch, .promise, .allowance:
            false
        }
    }
}

enum OnboardingOverlay: String, Codable, Equatable, Identifiable {
    case marketplace
    case returningSignIn

    var id: String { rawValue }
}

enum CaptureEntryContext: Equatable {
    case camera
    case library(stagedPhotoCount: Int)
}

struct StagedLibraryPhotoTransfer: Equatable {
    let imageData: Data
    let receipt: LibraryPhotoTransferReceipt
}

struct OnboardingFlowState: Codable, Equatable {
    var screen: OnboardingScreen
    var overlay: OnboardingOverlay?
    var stagedPhotoCount: Int

    init(
        screen: OnboardingScreen = .launch,
        overlay: OnboardingOverlay? = nil,
        stagedPhotoCount: Int = 0
    ) {
        self.screen = screen
        self.overlay = overlay
        self.stagedPhotoCount = max(0, stagedPhotoCount)
    }

    var persistable: OnboardingFlowState {
        return OnboardingFlowState(
            screen: screen == .settingsHandoff ? .denied : screen,
            overlay: nil,
            stagedPhotoCount: stagedPhotoCount
        )
    }
}

struct OnboardingMotionPolicy: Equatable {
    enum Transition: Equatable {
        case opacity
        case moveAndFade
    }

    let reduceMotion: Bool

    var transition: Transition {
        reduceMotion ? .opacity : .moveAndFade
    }

    var focusDelay: Duration {
        reduceMotion ? .zero : .milliseconds(180)
    }
}

/// One illustrative Trophy Wall row on ONB-05.
///
/// The asset name travels with the copy it labels. A row and its image were once two
/// arrays joined by subscript, so a fourth copy row without a fourth asset name crashed
/// the screen with an index-out-of-range that no test could reach.
/// `Hashable` so `ForEach` can key on the whole row. Keying on the copy alone would
/// re-introduce a silent desync of its own the first time two rows shared a name.
struct BackgroundExampleRow: Hashable {
    let imageName: String
    let item: String
    let state: String
}

enum FirstValueOnboardingCopy {
    /// ONB-05 shows what the Trophy Wall looks like while items finish. No item exists
    /// during onboarding, so the screen is labelled as an illustration and carries no
    /// spinner, percentage, or other affordance that would claim work is happening now.
    static let backgroundExampleCaption = "An example — nothing is running yet"

    static let backgroundExampleRows: [BackgroundExampleRow] = [
        .init(
            imageName: "FirstValueJacket",
            item: "Denim trucker jacket",
            state: "Writing the listing"
        ),
        .init(
            imageName: "FirstValueLamp",
            item: "Desk lamp",
            state: "Checking sold prices"
        ),
        .init(
            imageName: "FirstValueSneaker",
            item: "White sneakers",
            state: "Reading your voice note"
        ),
    ]
}

enum OnboardingCopy {
    static let launchTagline = "Sell smarter with real sold data"
    static let promiseHeadline = "Photograph an item. Get real comps and a listing you control."
    static let promiseSupport = "See what similar items actually sold for, then publish a listing you approve. No account needed to start."
    static let allowanceTitle = "Your first item is on us"
    static let allowanceSupport = "Run one complete AI listing on this device — free, and without an account."
    static let completeRunBody = "We identify your item, pull recent sold comps, and draft the listing once. Editing that draft yourself is always free."
    static let guidedFixBody = "If the AI reads the item wrong, we'll help you correct it once. A fresh analysis, new photos, or a second item is outside the free allowance."
    static let recoveryBody = "After you get a usable result, your encrypted guest draft and photos stay recoverable for 24 hours. Claim them with an account to keep them; otherwise they're deleted."
    static let primerBubble = "One clear photo is all I need to start."
    static let primerTitle = "Let's photograph your item"
    static let primerSupport = "SnapList uses your camera to take clear photos of your item. Your photos stay on this device until you choose to run them — we never post or share anything without you."
    static let deniedSupport = "Enable it in Settings, or pick a photo from your library instead — either way works."
    static let cameraHandoffSupport = "Camera access is on. Next you'll frame your item with light guidance — nothing is analyzed until you choose to run it."
    static let libraryHandoffSupport = "Pick your item's photos next. You'll add a little guidance before anything is analyzed — nothing runs until you choose."

    static let allVisibleStrings = [
        launchTagline,
        promiseHeadline,
        promiseSupport,
        allowanceTitle,
        allowanceSupport,
        completeRunBody,
        guidedFixBody,
        recoveryBody,
        primerBubble,
        primerTitle,
        primerSupport,
        deniedSupport,
        cameraHandoffSupport,
        libraryHandoffSupport
    ]
}

@MainActor
@Observable
final class OnboardingFlowModel {
    private(set) var state: OnboardingFlowState

    private let cameraAuthorization: any CameraAuthorizationProviding
    private let progressStore: any OnboardingProgressPersisting
    private let stagedLibraryPhotos: any StagedLibraryPhotoPersisting
    let guestAllowance: any GuestAllowanceCapability

    init(
        state: OnboardingFlowState = .init(),
        cameraAuthorization: any CameraAuthorizationProviding,
        progressStore: any OnboardingProgressPersisting,
        stagedLibraryPhotos: any StagedLibraryPhotoPersisting = InMemoryStagedLibraryPhotoStore(),
        guestAllowance: any GuestAllowanceCapability
    ) {
        self.state = state
        self.cameraAuthorization = cameraAuthorization
        self.progressStore = progressStore
        self.stagedLibraryPhotos = stagedLibraryPhotos
        self.guestAllowance = guestAllowance
    }

    var captureEntryContext: CaptureEntryContext? {
        if state.stagedPhotoCount > 0,
           state.screen == .libraryHandoff || state.screen == .captureBoundary {
            return .library(stagedPhotoCount: state.stagedPhotoCount)
        }
        if state.screen == .cameraHandoff || state.screen == .captureBoundary {
            return .camera
        }
        return nil
    }

    func settleLaunch() {
        guard state.screen == .launch else { return }
        update(screen: .promise)
    }

    func startFirstItem() {
        guard state.screen == .promise else { return }
        update(screen: .allowance)
    }

    func beginPhotoPermissionAfterFirstValueOnboarding() {
        switch state.screen {
        case .launch, .promise, .allowance:
            update(screen: .photoPrimer)
        case .photoPrimer, .denied, .cameraHandoff, .libraryHandoff,
             .captureBoundary, .settingsHandoff:
            break
        }
    }

    func presentReturningSignIn() {
        guard state.screen == .promise else { return }
        update(overlay: .returningSignIn)
    }

    func presentMarketplaceExplanation() {
        guard state.screen == .allowance else { return }
        update(overlay: .marketplace)
    }

    func dismissOverlay() {
        state.overlay = nil
        progressStore.save(state)
    }

    func continueFromAllowance() {
        guard state.screen == .allowance else { return }
        update(screen: .photoPrimer)
    }

    func useCamera() {
        routeCameraStatus(cameraAuthorization.authorizationStatus())
    }

    func requestCameraAccess() async {
        let status = cameraAuthorization.authorizationStatus()
        guard status == .notDetermined else {
            routeCameraStatus(status)
            return
        }

        let granted = await cameraAuthorization.requestAccess()
        routeCameraStatus(granted ? .authorized : .denied)
    }

    func refreshCameraAuthorization() {
        if stateRequiresCameraAuthorization {
            _ = reconcileCameraEntryAuthorization()
            return
        }

        let status = cameraAuthorization.authorizationStatus()
        if status == .authorized {
            update(screen: .cameraHandoff)
        } else if state.screen == .settingsHandoff || state.screen == .denied {
            update(screen: .denied)
        }
    }

    func openSettingsHandoff() {
        guard state.screen == .denied else { return }
        update(screen: .settingsHandoff)
    }

    @discardableResult
    func didStageLibraryPhotos(_ photos: [Data]) -> Bool {
        guard !photos.isEmpty else {
            didCancelLibrarySelection()
            return false
        }

        do {
            let count = try stagedLibraryPhotos.replace(with: photos)
            guard count > 0 else { return false }
            update(screen: .libraryHandoff, stagedPhotoCount: count)
            return true
        } catch {
            return false
        }
    }

    func didCancelLibrarySelection() {
        guard state.screen == .photoPrimer || state.screen == .denied else { return }
    }

    @discardableResult
    func resumeStagedLibraryPhotosIfAvailable() -> Bool {
        guard reconcileStagedLibraryPhotos() else { return false }
        guard state.stagedPhotoCount > 0 else { return false }
        update(screen: .libraryHandoff)
        return true
    }

    func continueToCaptureBoundary() {
        guard state.screen == .cameraHandoff || state.screen == .libraryHandoff else { return }
        if state.screen == .cameraHandoff {
            guard reconcileCameraEntryAuthorization() else { return }
        } else {
            guard reconcileStagedLibraryPhotos() else { return }
        }
        update(screen: .captureBoundary)
    }

    func firstStagedLibraryPhotoForCapture() -> StagedLibraryPhotoTransfer? {
        guard case .library = captureEntryContext else { return nil }
        do {
            let photos = try stagedLibraryPhotos.load()
            guard let firstPhoto = photos.first else { return nil }
            return StagedLibraryPhotoTransfer(
                imageData: firstPhoto,
                receipt: LibraryPhotoTransferReceipt(
                    sourcePhotoFingerprints: photos.map(LocalPhotoFingerprint.digest),
                    sourceIndex: 0
                )
            )
        } catch {
            return nil
        }
    }

    @discardableResult
    func consumeStagedLibraryPhotoAfterSuccessfulCapture(
        transferReceipt: LibraryPhotoTransferReceipt
    ) -> StagedLibraryPhotoConsumeOutcome {
        guard state.screen == .captureBoundary,
              case .library = captureEntryContext else { return .retryNeeded }
        do {
            let outcome = try stagedLibraryPhotos.consume(
                transferReceipt: transferReceipt
            )
            if case let .consumed(remainingCount) = outcome {
                update(stagedPhotoCount: remainingCount)
            }
            return outcome
        } catch {
            return .retryNeeded
        }
    }

    func goBack() {
        switch state.screen {
        case .allowance:
            update(screen: .promise)
        case .photoPrimer:
            update(screen: .allowance)
        case .denied, .cameraHandoff, .settingsHandoff:
            update(screen: .photoPrimer, stagedPhotoCount: 0)
        case .libraryHandoff:
            update(screen: .photoPrimer)
        case .captureBoundary:
            update(screen: state.stagedPhotoCount > 0 ? .libraryHandoff : .cameraHandoff)
        case .launch, .promise:
            break
        }
    }

    func restore(_ state: OnboardingFlowState) {
        self.state = state.persistable
    }

    func persistForInterruption() {
        progressStore.save(state)
    }

    func restorePersistedProgress() {
        guard let stored = progressStore.load() else { return }
        state = stored.persistable
        _ = reconcileStagedLibraryPhotos()
        _ = reconcileCameraEntryAuthorization()
    }

    @discardableResult
    private func reconcileStagedLibraryPhotos() -> Bool {
        let requiresStagedPhotos = state.screen == .libraryHandoff
            || (state.screen == .captureBoundary && state.stagedPhotoCount > 0)
        let canResumeStagedPhotos = state.screen == .photoPrimer || state.screen == .denied
        guard requiresStagedPhotos || canResumeStagedPhotos || state.stagedPhotoCount > 0 else {
            return true
        }

        let photos: [Data]
        do {
            photos = try stagedLibraryPhotos.load()
        } catch {
            return false
        }
        guard !photos.isEmpty else {
            if requiresStagedPhotos {
                update(screen: .photoPrimer, stagedPhotoCount: 0)
            } else if state.stagedPhotoCount > 0 {
                update(stagedPhotoCount: 0)
            }
            return false
        }

        if state.stagedPhotoCount != photos.count {
            update(stagedPhotoCount: photos.count)
        }
        return true
    }

    private var stateRequiresCameraAuthorization: Bool {
        state.screen == .cameraHandoff
            || (state.screen == .captureBoundary && state.stagedPhotoCount == 0)
    }

    @discardableResult
    private func reconcileCameraEntryAuthorization() -> Bool {
        guard stateRequiresCameraAuthorization else { return true }

        switch cameraAuthorization.authorizationStatus() {
        case .authorized:
            return true
        case .denied, .restricted:
            update(screen: .denied)
            return false
        case .notDetermined:
            update(screen: .photoPrimer, stagedPhotoCount: 0)
            return false
        }
    }

    private func routeCameraStatus(_ status: CameraAuthorizationStatus) {
        switch status {
        case .authorized:
            stagedLibraryPhotos.clear()
            update(screen: .cameraHandoff, stagedPhotoCount: 0)
        case .denied, .restricted:
            update(screen: .denied)
        case .notDetermined:
            break
        }
    }

    private func update(
        screen: OnboardingScreen? = nil,
        overlay: OnboardingOverlay?? = nil,
        stagedPhotoCount: Int? = nil
    ) {
        if let screen {
            state.screen = screen
        }
        if let overlay {
            state.overlay = overlay
        } else if screen != nil {
            state.overlay = nil
        }
        if let stagedPhotoCount {
            state.stagedPhotoCount = max(0, stagedPhotoCount)
        }
        progressStore.save(state)
    }
}
