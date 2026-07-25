import Observation
import SwiftUI

enum PrimaryTab: String, CaseIterable, Identifiable {
    case home
    case listings
    case inbox
    case insights

    var id: String { rawValue }

    var title: String {
        rawValue.capitalized
    }

    var systemImage: String {
        switch self {
        case .home: "house"
        case .listings: "list.bullet.rectangle"
        case .inbox: "envelope"
        case .insights: "chart.line.uptrend.xyaxis"
        }
    }
}

enum DockDestination: String, CaseIterable, Identifiable {
    case home
    case listings
    case capture
    case inbox
    case insights

    var id: String { rawValue }

    var title: String { rawValue.capitalized }

    var systemImage: String {
        switch self {
        case .home: "house"
        case .listings: "list.bullet.rectangle"
        case .capture: "camera"
        case .inbox: "envelope"
        case .insights: "chart.line.uptrend.xyaxis"
        }
    }

    var tab: PrimaryTab? {
        switch self {
        case .home: .home
        case .listings: .listings
        case .capture: nil
        case .inbox: .inbox
        case .insights: .insights
        }
    }
}

enum FutureBoundary: String, Hashable {
    case account
    case activity
    case run
    case draft
}

enum HomeRoute: Hashable {
    case run(UUID)
    case order(UUID)
    case conversation(UUID)
    case publishIssue(UUID)
    case draft(UUID)
    case listing(UUID)
    case listings(HomeFilter)
    case orders
}

enum AppRoute: Hashable {
    case account
    case activity
    case home(HomeRoute)
    case future(FutureBoundary)
}

extension HomeAttentionDestination {
    var route: HomeRoute {
        switch self {
        case .order(let id): .order(id)
        case .conversation(let id): .conversation(id)
        case .publishIssue(let id): .publishIssue(id)
        case .draft(let id): .draft(id)
        }
    }
}

enum AppSheet: String, Identifiable {
    case capture

    var id: String { rawValue }
}

enum AppFullScreen: String, Identifiable {
    case guidedCamera

    var id: String { rawValue }
}

enum CaptureBoundaryDestination: Equatable {
    case photoReview
    case trophyWall
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
        case ("https", let host)
            where ["snaplist.dev", "www.snaplist.dev"].contains(host) && path.count == 2:
            guard path.first == "runs" else { return nil }
            rawID = path.last
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
    var presentedSheet: AppSheet?
    var presentedFullScreen: AppFullScreen?
    private(set) var captureBoundaryRequest: CaptureBoundaryRequest?
    private(set) var photoReviewScanReturn: PhotoReviewScanReturn?

    private var homePath: [AppRoute] = []
    private var listingsPath: [AppRoute] = []
    private var inboxPath: [AppRoute] = []
    private var insightsPath: [AppRoute] = []

    init(
        initialTab: PrimaryTab = .home,
        initialRoute: AppRoute? = nil,
        initialSheet: AppSheet? = nil,
        initialFullScreen: AppFullScreen? = nil
    ) {
        selectedTab = initialTab
        presentedSheet = initialSheet
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

    func select(_ destination: DockDestination) {
        if destination == .capture {
            presentedSheet = .capture
        } else if let tab = destination.tab {
            selectedTab = tab
        }
    }

    func navigate(to route: AppRoute) {
        var current = path(for: selectedTab)
        current.append(route)
        setPath(current, for: selectedTab)
    }

    func openCaptureBoundary(
        destination: CaptureBoundaryDestination,
        photos: [StagedCapturePhoto],
        opener: CaptureBoundaryOpener
    ) {
        let hasValidPhotoCount = switch destination {
        case .photoReview: (1...5).contains(photos.count)
        case .trophyWall: (0...5).contains(photos.count)
        }
        guard hasValidPhotoCount else { return }
        captureBoundaryRequest = CaptureBoundaryRequest(
            destination: destination,
            photos: photos,
            opener: opener
        )
        presentedFullScreen = nil
    }

    func returnFromPhotoReview(_ request: PhotoReviewScanReturn) {
        photoReviewScanReturn = request
        captureBoundaryRequest = nil
        presentedFullScreen = .guidedCamera
    }

    @discardableResult
    func open(_ url: URL) -> Bool {
        guard let deepLink = RunDeepLink(url: url) else { return false }
        switch deepLink {
        case .run(let runID):
            selectedTab = .home
            presentedSheet = nil
            presentedFullScreen = nil
            setPath([.home(.run(runID))], for: .home)
        }
        return true
    }

    func handleCaptureRestoration(_ restoration: CaptureRestoration) {
        guard restoration == .stagedPhoto else { return }
        presentedFullScreen = nil
        presentedSheet = .capture
    }

    func reset(tab: PrimaryTab) {
        setPath([], for: tab)
    }

    private func path(for tab: PrimaryTab) -> [AppRoute] {
        switch tab {
        case .home: homePath
        case .listings: listingsPath
        case .inbox: inboxPath
        case .insights: insightsPath
        }
    }

    private func setPath(_ path: [AppRoute], for tab: PrimaryTab) {
        switch tab {
        case .home: homePath = path
        case .listings: listingsPath = path
        case .inbox: inboxPath = path
        case .insights: insightsPath = path
        }
    }
}

enum DockVisibilityPolicy {
    static func shouldShow(isKeyboardVisible: Bool) -> Bool {
        !isKeyboardVisible
    }
}
