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
enum HomeRoute: Hashable {
    case processing
    case localRecovery(TrophyWallLogicalIdentity)
    case run(UUID)
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
    var selectedTab: PrimaryTab
    var presentedFullScreen: AppFullScreen?
    var presentedAccountEntry = false
    private(set) var captureBoundaryRequest: CaptureBoundaryRequest?
    private(set) var photoReviewScanReturn: PhotoReviewScanReturn?

    private var scanPath: [AppRoute] = []
    private var trophyWallPath: [AppRoute] = []

    init(
        initialTab: PrimaryTab = .scan,
        initialRoute: AppRoute? = nil,
        initialFullScreen: AppFullScreen? = nil
    ) {
        selectedTab = initialTab
        presentedFullScreen = initialFullScreen
        if let initialRoute {
            setPath([initialRoute], for: initialTab)
        }
    }

    func pathBinding(for tab: PrimaryTab) -> Binding<[AppRoute]> {
        Binding(
            get: { [weak self] in self?.path(for: tab) ?? [] },
            set: { [weak self] in self?.setPath($0, for: tab) }
        )
    }

    func select(_ tab: PrimaryTab) {
        selectedTab = tab
    }

    func navigate(to route: AppRoute) {
        switch AppRoutePresentation.resolve(route) {
        case .push(let pushed):
            var current = path(for: selectedTab)
            current.append(pushed)
            setPath(current, for: selectedTab)
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
    func openLocalRecovery(
        _ logicalIdentity: TrophyWallLogicalIdentity,
        matching recoverableIdentity: TrophyWallLogicalIdentity?,
        photos: [StagedCapturePhoto]
    ) {
        guard logicalIdentity == recoverableIdentity,
              (1...5).contains(photos.count) else {
            return
        }
        reset(tab: .trophyWall)
        selectedTab = .scan
        openCaptureBoundary(
            destination: .photoReview,
            photos: photos,
            opener: .trophyWallTab
        )
    }

    func returnFromPhotoReview(_ request: PhotoReviewScanReturn) {
        selectedTab = .scan
        photoReviewScanReturn = request
        captureBoundaryRequest = nil
        presentedFullScreen = .guidedCamera
    }

    @discardableResult
    func open(_ url: URL) -> Bool {
        guard let deepLink = RunDeepLink(url: url) else { return false }
        switch deepLink {
        case .run(let runID):
            selectedTab = .trophyWall
            presentedFullScreen = nil
            // The account boundary lives beside the typed path rather than on it
            // (#799), so `setPath` no longer clears it. Left presented, the sheet
            // covers the run the deep link just brought forward.
            presentedAccountEntry = false
            setPath([.home(.run(runID))], for: .trophyWall)
        }
        return true
    }

    func handleCaptureRestoration(_ restoration: CaptureRestoration) {
        guard restoration == .stagedPhoto else { return }
        selectedTab = .scan
        presentedFullScreen = .guidedCamera
    }

    func reset(tab: PrimaryTab) {
        setPath([], for: tab)
    }

    private func path(for tab: PrimaryTab) -> [AppRoute] {
        switch tab {
        case .scan: scanPath
        case .trophyWall: trophyWallPath
        }
    }

    private func setPath(_ path: [AppRoute], for tab: PrimaryTab) {
        switch tab {
        case .scan: scanPath = path
        case .trophyWall: trophyWallPath = path
        }
    }
}

enum DockVisibilityPolicy {
    static func shouldShow(isKeyboardVisible: Bool, isLiveCameraPreviewActive: Bool) -> Bool {
        !isKeyboardVisible && !isLiveCameraPreviewActive
    }
}
