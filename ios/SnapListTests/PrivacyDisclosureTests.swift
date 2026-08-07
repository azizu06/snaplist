import XCTest
@testable import SnapList

/// Pins the two files App Review reads as SnapList's privacy promise: the
/// permission strings in `Info.plist` and the collected-data declarations in
/// `PrivacyInfo.xcprivacy`.
///
/// The assertions deliberately read `Bundle.main` rather than the source files.
/// This target is app-hosted, so `Bundle.main` is the built `SnapList.app` —
/// the compiled `Info.plist` and the copied manifest that actually ship. A
/// source-file assertion would still pass if the build stopped shipping them.
final class PrivacyDisclosureTests: XCTestCase {
    /// Phrasings that assert the seller's media never leaves the phone. Every
    /// one of them is false for SnapList: photos and voice are uploaded to
    /// private per-tenant storage on `POST /v1/items/runs`, and the voice note
    /// is additionally sent to a hosted transcription service. A permission
    /// alert is the moment consent is granted, so a claim of on-device-only
    /// handling there is the most expensive place to be wrong.
    private static let onDeviceOnlyClaims = [
        "stay on this device",
        "stays on this device",
        "stay on your device",
        "stays on your device",
        "stay on this phone",
        "stays on this phone",
        "stored on this phone",
        "stored on your phone",
        "stored on this device",
        "stored on your device",
        "remain on this device",
        "remains on this device",
        "only on this device",
        "only on your device",
        "on-device only",
        "never leaves",
        "does not leave",
        "doesn't leave",
    ]

    private func usageDescription(_ key: String) throws -> String {
        let value = try XCTUnwrap(
            Bundle.main.object(forInfoDictionaryKey: key) as? String,
            "\(key) is missing from the built app's Info.plist."
        )
        XCTAssertFalse(
            value.isEmpty,
            "\(key) must explain the purpose of the access, not be blank."
        )
        return value
    }

    private func assertMakesNoOnDeviceOnlyClaim(
        _ value: String,
        key: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let lowercased = value.lowercased()
        for claim in Self.onDeviceOnlyClaims where lowercased.contains(claim) {
            XCTFail(
                "\(key) claims \"\(claim)\", but the media it describes is uploaded.",
                file: file,
                line: line
            )
        }
    }

    // MARK: - Permission strings

    func testMicrophoneUsageDescriptionAdmitsTheVoiceNoteLeavesThePhone() throws {
        let value = try usageDescription("NSMicrophoneUsageDescription")
        let lowercased = value.lowercased()

        assertMakesNoOnDeviceOnlyClaim(value, key: "NSMicrophoneUsageDescription")
        XCTAssertTrue(
            lowercased.contains("upload") || lowercased.contains("send"),
            "NSMicrophoneUsageDescription must say the recording is sent off the phone."
        )
        XCTAssertTrue(
            lowercased.contains("delete"),
            "NSMicrophoneUsageDescription must say the recording is deleted afterward."
        )
    }

    func testCameraUsageDescriptionStatesWhyTheCameraIsNeeded() throws {
        let value = try usageDescription("NSCameraUsageDescription")
        let lowercased = value.lowercased()

        assertMakesNoOnDeviceOnlyClaim(value, key: "NSCameraUsageDescription")
        XCTAssertTrue(
            lowercased.contains("photo"),
            "NSCameraUsageDescription must name what the camera captures."
        )
        XCTAssertTrue(
            lowercased.contains("listing"),
            "NSCameraUsageDescription must state the purpose the photos serve."
        )
    }

    func testPhotoLibraryAddUsageDescriptionDescribesWriteOnlyAccess() throws {
        let value = try usageDescription("NSPhotoLibraryAddUsageDescription")
        let lowercased = value.lowercased()

        XCTAssertTrue(
            lowercased.contains("save") || lowercased.contains("add"),
            "NSPhotoLibraryAddUsageDescription must describe adding photos."
        )
        // The app requests `.addOnly` authorization and only ever issues
        // `PHAssetChangeRequest.creationRequestForAsset`. Overstating this as
        // library access would be a wrong disclosure in the other direction.
        XCTAssertTrue(
            lowercased.contains("never reads") || lowercased.contains("only adds"),
            "NSPhotoLibraryAddUsageDescription must not imply SnapList reads the library."
        )
    }

    // MARK: - Privacy manifest

    private func privacyManifest() throws -> [String: Any] {
        let url = try XCTUnwrap(
            Bundle.main.url(forResource: "PrivacyInfo", withExtension: "xcprivacy"),
            "PrivacyInfo.xcprivacy is not copied into the built app."
        )
        let parsed = try PropertyListSerialization.propertyList(
            from: try Data(contentsOf: url),
            format: nil
        )
        return try XCTUnwrap(parsed as? [String: Any], "PrivacyInfo.xcprivacy is not a dictionary.")
    }

    private func collectedDataTypes() throws -> [String: [String: Any]] {
        let entries = try XCTUnwrap(
            privacyManifest()["NSPrivacyCollectedDataTypes"] as? [[String: Any]],
            "NSPrivacyCollectedDataTypes is missing."
        )
        return entries.reduce(into: [:]) { types, entry in
            guard let name = entry["NSPrivacyCollectedDataType"] as? String else { return }
            types[name] = entry
        }
    }

    /// The audited set. Each entry is justified by a code path cited in the
    /// pull request for issue #719; a new collection path must extend this list
    /// in the same change that introduces it.
    func testManifestDeclaresExactlyTheDataTypesSnapListCollects() throws {
        XCTAssertEqual(
            Set(try collectedDataTypes().keys),
            [
                "NSPrivacyCollectedDataTypePhotosorVideos",
                "NSPrivacyCollectedDataTypeAudioData",
                "NSPrivacyCollectedDataTypeEmailAddress",
                "NSPrivacyCollectedDataTypeUserID",
                "NSPrivacyCollectedDataTypeDeviceID",
                "NSPrivacyCollectedDataTypePurchaseHistory",
                "NSPrivacyCollectedDataTypeProductInteraction",
                "NSPrivacyCollectedDataTypeCrashData",
            ]
        )
    }

    func testSellerMediaIsDeclaredAsCollectedForAppFunctionality() throws {
        let types = try collectedDataTypes()
        for name in ["NSPrivacyCollectedDataTypePhotosorVideos", "NSPrivacyCollectedDataTypeAudioData"] {
            let entry = try XCTUnwrap(types[name], "\(name) is not declared.")
            XCTAssertEqual(
                entry["NSPrivacyCollectedDataTypePurposes"] as? [String],
                ["NSPrivacyCollectedDataTypePurposeAppFunctionality"],
                "\(name) is uploaded to run the product, not for analytics."
            )
            XCTAssertEqual(entry["NSPrivacyCollectedDataTypeLinked"] as? Bool, true)
        }
    }

    /// The Clerk user id is the `user_id` tenancy key every domain table's RLS
    /// policy compares against. Declaring it for analytics alone understates
    /// what it does.
    func testUserIdentifierIsDeclaredForAppFunctionality() throws {
        let entry = try XCTUnwrap(
            try collectedDataTypes()["NSPrivacyCollectedDataTypeUserID"],
            "NSPrivacyCollectedDataTypeUserID is not declared."
        )
        let purposes = try XCTUnwrap(entry["NSPrivacyCollectedDataTypePurposes"] as? [String])
        XCTAssertTrue(
            purposes.contains("NSPrivacyCollectedDataTypePurposeAppFunctionality"),
            "The Clerk user id enforces tenant isolation, which is App Functionality."
        )
        XCTAssertEqual(entry["NSPrivacyCollectedDataTypeLinked"] as? Bool, true)
    }

    func testNoDeclaredDataTypeIsUsedForTracking() throws {
        for (name, entry) in try collectedDataTypes() {
            XCTAssertEqual(
                entry["NSPrivacyCollectedDataTypeTracking"] as? Bool,
                false,
                "\(name) must declare its tracking flag as false."
            )
        }
    }

    func testManifestDeclaresTheTopLevelTrackingKeys() throws {
        let manifest = try privacyManifest()
        XCTAssertEqual(
            manifest["NSPrivacyTracking"] as? Bool,
            false,
            "NSPrivacyTracking is required and SnapList does no tracking."
        )
        XCTAssertEqual(
            manifest["NSPrivacyTrackingDomains"] as? [String],
            [],
            "NSPrivacyTrackingDomains is required and must be empty when tracking is false."
        )
    }

    /// `VoiceNoteDomain` reads `contentModificationDateKey` off its own
    /// recovery directories, and several stores call
    /// `FileManager.attributesOfItem(atPath:)`. Both are required-reason file
    /// timestamp APIs, and every call site is inside the app container.
    func testManifestDeclaresFirstPartyRequiredReasonAPIs() throws {
        let entries = try XCTUnwrap(
            try privacyManifest()["NSPrivacyAccessedAPITypes"] as? [[String: Any]],
            "NSPrivacyAccessedAPITypes is missing."
        )
        let reasons = entries.reduce(into: [String: [String]]()) { reasons, entry in
            guard let category = entry["NSPrivacyAccessedAPIType"] as? String,
                  let values = entry["NSPrivacyAccessedAPITypeReasons"] as? [String] else { return }
            reasons[category] = values
        }
        XCTAssertEqual(
            reasons["NSPrivacyAccessedAPICategoryUserDefaults"],
            ["CA92.1"]
        )
        XCTAssertEqual(
            reasons["NSPrivacyAccessedAPICategoryFileTimestamp"],
            ["C617.1"]
        )
    }
}
