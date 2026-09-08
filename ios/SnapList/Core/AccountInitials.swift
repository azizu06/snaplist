import Foundation

/// One derivation for the letters shown in an avatar circle, so the header
/// avatar and Settings can never drift into showing two different answers
/// for the same signed-in seller (#1051).
enum AccountInitials {
    static let guestFallback = "G"
    static let signedInFallback = "S"

    static func from(
        firstName: String?,
        lastName: String?,
        isSignedIn: Bool
    ) -> String {
        guard isSignedIn else { return guestFallback }
        let letters = [firstName, lastName]
            .compactMap { $0?.first }
            .map { String($0).uppercased() }
            .joined()
        return letters.isEmpty ? signedInFallback : letters
    }
}
