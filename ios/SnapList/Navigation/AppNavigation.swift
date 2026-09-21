import Observation
import SwiftUI

enum PrimaryTab: String, CaseIterable, Identifiable {
    case scan
    case trophyWall = "trophy-wall"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .scan: "Scan"
        case .trophyWall: "Trophy Wall"
        }
    }

    func systemImage(isSelected: Bool) -> String {
        switch (self, isSelected) {
        case (.scan, _): "camera"
        case (.trophyWall, false): "trophy"
        case (.trophyWall, true): "trophy.fill"
        }
    }
}

enum FutureBoundary: String, Hashable {
    case account
    case run
    case draft
}

/// The Trophy Wall stack's destinations. Order, conversation, publish-issue,
/// draft, listing, listings, and orders were removed with the seller-operations
/// surface: a destination that no longer exists as a case cannot be constructed
/// by any view, which is a stronger guarantee than hiding the entry points.
/// `run`, the run-status intermediate card, was removed the same way (#963):
/// every tap that used to land on it now opens its listing surface directly or
/// acts inline, so nothing constructs it any more.
enum HomeRoute: Hashable {
    case processing
    case localRecovery(TrophyWallLogicalIdentity)
}

enum AppRoute: Hashable {
    case settings
    case home(HomeRoute)
    case future(FutureBoundary)
}

/// How a typed route reaches the seller. Almost every route is a push onto the
/// tab's stack, but the account boundary renders ClerkKit's `AuthView`, whose body
/// is its own `NavigationStack`. SwiftUI will not render a pushed destination that
/// owns a second stack — the outer path keeps the route while the stack draws its
/// root — so that boundary is presented modally instead of pushed.
enum AppRoutePresentation: Equatable {
    case push(AppRoute)
    case accountEntryModal

    static func resolve(_ route: AppRoute) -> Self {
        switch route {
        case .future(.account): .accountEntryModal
        case .settings, .home, .future: .push(route)
        }
    }
}

enum AppFullScreen: String, Identifiable {
    case guidedCamera

    var id: String { rawValue }
}

enum CaptureBoundaryDestination: Equatable {
    case photoReview
}

enum CaptureBoundaryOpener: Equatable {
    case reviewButton
    case trophyWallTab
}

struct CaptureBoundaryRequest: Equatable {
    let destination: CaptureBoundaryDestination
    let photos: [StagedCapturePhoto]
    let opener: CaptureBoundaryOpener
}

enum PhotoReviewScanFocus: Equatable {
    case reviewButton
    case addPhotoButton
}

struct PhotoReviewScanReturn: Equatable {
    let photos: [StagedCapturePhoto]
    let focus: PhotoReviewScanFocus
}

enum RunDeepLink: Equatable, Sendable {
    case run(UUID)

    init?(url: URL) {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.user == nil,
              components.password == nil,
              components.port == nil,
              components.query == nil,
              components.fragment == nil else {
            return nil
        }
        let path = url.pathComponents.filter { $0 != "/" }
        let rawID: String?
        switch (components.scheme?.lowercased(), components.host?.lowercased()) {
        case ("snaplist", "runs") where path.count == 1:
            rawID = path.first
        default:
            return nil
        }
        guard let rawID, let id = UUID(uuidString: rawID) else { return nil }
        self = .run(id)
    }
}

@MainActor
@Observable
final class AppRouter {
    /// #1129: Scan is no longer a second root. Trophy Wall is the app's home
    /// surface and Scan rises over it as a drawer, so the only presentation
    /// question left is whether that drawer is up — answered by
    /// `ScanDrawerPolicy`, never by assigning to this directly.
    private(set) var scanDrawer = ScanDrawerState()
    /// Whether the launch fixture asked to start in Scan. The shell replays it
    /// as a drawer event on first appear rather than seeding the state here,
    /// so a launch straight into Scan takes exactly the same path — and starts
    /// the camera exactly the same way — as tapping the entry control.
    let launchesIntoScan: Bool
    var presentedFullScreen: AppFullScreen?
    var presentedAccountEntry = false
    private(set) var captureBoundaryRequest: CaptureBoundaryRequest?
    private(set) var photoReviewScanReturn: PhotoReviewScanReturn?

    /// One stack. Scan used to own a second one; a drawer over the wall has
    /// nothing to push, so the wall's is the only path there is.
    private var wallPath: [AppRoute] = []

    init(
        initialTab: PrimaryTab = .scan,
        initialRoute: AppRoute? = nil,
        initialFullScreen: AppFullScreen? = nil
    ) {
        launchesIntoScan = initialTab == .scan
        presentedFullScreen = initialFullScreen
        if let initialRoute {
            wallPath = [initialRoute]
        }
    }

    var isScanPresented: Bool { scanDrawer.isPresented }

    /// The one way the drawer moves. Returns the reduction so the caller can
    /// carry out the camera session work it names — which is the shell's job,
    /// since only the shell can start or stop a capture session. The one place
    /// that discards it is documented at its call site.
    @discardableResult
    func applyScanDrawer(
        _ event: ScanDrawerEvent,
        context: ScanDrawerContext = ScanDrawerContext()
    ) -> ScanDrawerReduction {
        let reduction = ScanDrawerPolicy.reduce(scanDrawer, event, context: context)
        scanDrawer = reduction.state
        return reduction
    }

    /// The routes pushed onto the wall's stack. Read-only, and observed:
    /// #1056's activation surface resolution has to see a pushed route,
    /// because a coach mark anchored to a screen's chrome must not draw over
    /// a screen pushed on top of it.
    var selectedPath: [AppRoute] { wallPath }

    var pathBinding: Binding<[AppRoute]> {
        Binding(
            get: { [weak self] in self?.wallPath ?? [] },
            set: { [weak self] in self?.wallPath = $0 }
        )
    }

    func navigate(to route: AppRoute) {
        switch AppRoutePresentation.resolve(route) {
        case .push(let pushed):
            wallPath.append(pushed)
        case .accountEntryModal:
            presentedAccountEntry = true
        }
    }

    func openCaptureBoundary(
        destination: CaptureBoundaryDestination,
        photos: [StagedCapturePhoto],
        opener: CaptureBoundaryOpener
    ) {
        guard (1...5).contains(photos.count) else { return }
        captureBoundaryRequest = CaptureBoundaryRequest(
            destination: destination,
            photos: photos,
            opener: opener
        )
        presentedFullScreen = nil
    }

    /// The tapped card names one specific local item. Every refusal is decided
    /// before any navigation state moves, because a stale card that switched tabs
    /// and then failed to open anything left the seller on Scan with no
    /// explanation, and one whose intake had been replaced opened the wrong item.
    /// Reports whether the recovery was accepted, so the shell only raises the
    /// drawer for a card that actually opened something. A refusal that had
    /// already moved navigation state is exactly the defect above.
    @discardableResult
    func openLocalRecovery(
        _ logicalIdentity: TrophyWallLogicalIdentity,
        matching recoverableIdentity: TrophyWallLogicalIdentity?,
        photos: [StagedCapturePhoto]
    ) -> Bool {
        guard logicalIdentity == recoverableIdentity,
              (1...5).contains(photos.count) else {
            return false
        }
        resetWallPath()
        openCaptureBoundary(
            destination: .photoReview,
            photos: photos,
            opener: .trophyWallTab
        )
        return true
    }

    /// Leaving Photo Review lands back on the camera, which is the same
    /// drawer Photo Review was already inside — so this moves the surface
    /// within the drawer and never the drawer itself.
    func returnFromPhotoReview(_ request: PhotoReviewScanReturn) {
        photoReviewScanReturn = request
        captureBoundaryRequest = nil
        presentedFullScreen = .guidedCamera
    }

    /// #963: the deep link still names one run, but there is no longer a
    /// status screen to name it to — opening a specific run is now an async,
    /// server-authorized action (`processingReviewRoute`), not a typed route a
    /// synchronous URL handler can push. Processing is where that run already
    /// lives, so the link surfaces the seller there rather than reviving a
    /// removed destination.
    @discardableResult
    func open(_ url: URL) -> Bool {
        guard let deepLink = RunDeepLink(url: url) else { return false }
        switch deepLink {
        case .run:
            presentedFullScreen = nil
            // The account boundary lives beside the typed path rather than on it
            // (#799), so `setPath` no longer clears it. Left presented, the sheet
            // covers the screen the deep link just brought forward.
            presentedAccountEntry = false
            wallPath = [.home(.processing)]
        }
        return true
    }

    /// A relaunch that recovered a durable draft puts the seller back in the
    /// drawer, on their own staged photos.
    ///
    /// This is the one place a drawer event's camera command is deliberately
    /// discarded: the app root owns this sequence and already starts the
    /// session immediately afterwards, because `restore()` lands a staged photo
    /// on `.captured` rather than a live session (#864). Starting it from here
    /// as well would race that call.
    func handleCaptureRestoration(_ restoration: CaptureRestoration) {
        guard restoration == .stagedPhoto else { return }
        applyScanDrawer(.scanSurfaceRestored)
        presentedFullScreen = .guidedCamera
    }

    func resetWallPath() {
        wallPath = []
    }
}

enum DockVisibilityPolicy {
    static func shouldShow(isKeyboardVisible: Bool, isLiveCameraPreviewActive: Bool) -> Bool {
        !isKeyboardVisible && !isLiveCameraPreviewActive
    }
}
