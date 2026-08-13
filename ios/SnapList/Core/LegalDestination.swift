import Foundation

/// The documents App Review's 3.1.2 requires wherever SnapList sells or
/// discloses the auto-renewing subscription (issue #812): Settings' ABOUT
/// section and the paywall. Both surfaces read from here so a URL can only
/// drift out of sync with the marketing site in one place, not two.
enum LegalDestination: Equatable {
    case privacyPolicy
    case termsOfService
    case help

    var label: String {
        switch self {
        case .privacyPolicy: "Privacy Policy"
        case .termsOfService: "Terms of Service"
        case .help: "Help"
        }
    }

    /// Routes served by `src/app/(marketing)` at the production host
    /// (`src/app/layout.tsx` sets `metadataBase` to `https://snaplist.dev`).
    /// `/support` is `src/app/(marketing)/support/page.tsx`, the live help
    /// destination issue #191 already shipped.
    var url: URL {
        switch self {
        case .privacyPolicy: URL(string: "https://snaplist.dev/privacy")!
        case .termsOfService: URL(string: "https://snaplist.dev/terms")!
        case .help: URL(string: "https://snaplist.dev/support")!
        }
    }
}
