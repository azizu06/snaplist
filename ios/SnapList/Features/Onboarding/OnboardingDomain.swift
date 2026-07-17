import Foundation
import Observation

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

    func firstStagedLibraryPhotoForCapture() -> Data? {
        guard case .library = captureEntryContext else { return nil }
        do {
            return try stagedLibraryPhotos.load().first
        } catch {
            return nil
        }
    }

    @discardableResult
    func consumeStagedLibraryPhotosAfterSuccessfulCapture() -> Bool {
        guard state.screen == .captureBoundary,
              case .library = captureEntryContext else { return false }
        do {
            try stagedLibraryPhotos.consume()
            update(stagedPhotoCount: 0)
            return true
        } catch {
            return false
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

        let photos = (try? stagedLibraryPhotos.load()) ?? []
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
