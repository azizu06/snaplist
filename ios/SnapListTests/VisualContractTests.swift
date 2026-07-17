import CryptoKit
import XCTest
@testable import SnapList

final class VisualContractTests: XCTestCase {
    func testResolvedManifestContainsAllFortyTwoApprovedStates() throws {
        let visualManifest = try loadJSON(
            named: "snaplist-visual-regression-manifest",
            at: .resolvedContracts
        )
        let approved = try XCTUnwrap(visualManifest["approved"] as? [[String: Any]])
        let candidates = try XCTUnwrap(visualManifest["candidates"] as? [[String: Any]])
        let withheld = try XCTUnwrap(visualManifest["withheld"] as? [[String: Any]])

        XCTAssertEqual(approved.count, 42)
        XCTAssertEqual(candidates.count, 6)
        XCTAssertEqual(withheld.compactMap { $0["id"] as? String }, ["CAP-05"])
        XCTAssertEqual(
            Set(approved.compactMap { $0["id"] as? String }),
            Set(ApprovedVisualStateID.allCases.map(\.rawValue))
        )
        XCTAssertTrue(candidates.allSatisfy {
            $0["status"] as? String == "not_implementation_frozen"
        })
    }

    func testLockedActionBlueAndPricingGoldenExceptionAreRecorded() throws {
        let tokens = try loadJSON(named: "snaplist-design-tokens", at: .resolvedContracts)
        let colors = try XCTUnwrap(tokens["colors"] as? [String: Any])

        XCTAssertEqual(colors["action"] as? String, "#3665F3")
        XCTAssertEqual(colors["price_source_deviation"] as? String, "#0031E9")
        XCTAssertTrue(colors.keys.contains("destructive"))
        XCTAssertTrue(colors["destructive"] is NSNull)
        XCTAssertEqual(SnapListColorToken.action.rawValue, "#3665F3")
    }

    func testTemporaryProductPhotographyIsReviewOnlyAndNotVendored() throws {
        let assetManifest = try loadJSON(
            named: "snaplist-asset-manifest",
            at: .resolvedContracts
        )
        let photography = try XCTUnwrap(
            assetManifest["temporary_product_photography"] as? [String: Any]
        )
        XCTAssertEqual(photography["status"] as? String, "review-only")

        let resourceRoot = try contractResourceRoot(for: .designContracts)
        let resourceFiles = try FileManager.default.subpathsOfDirectory(atPath: resourceRoot.path)
        let pngNames = Set(
            resourceFiles
                .filter { $0.hasSuffix(".png") }
                .map { URL(fileURLWithPath: $0).lastPathComponent }
        )
        XCTAssertEqual(
            pngNames,
            Set([
                "pose-01-analyzing.png",
                "pose-01-coaching-photo.png",
                "pose-01-uncertain.png",
                "pose-03-retry-review.png",
                "pose-03-review-photo.png"
            ])
        )
    }

    func testResolvedSourceManifestPinsBothPackagesAndFamilyBoundaries() throws {
        let sourceManifest = try loadJSON(named: "SOURCE-MANIFEST", at: .resolvedRoot)
        let source = try XCTUnwrap(sourceManifest["source"] as? [String: Any])
        let scope = try XCTUnwrap(sourceManifest["scope"] as? [String: Any])

        XCTAssertEqual(
            source["basePackageSHA256"] as? String,
            "13ea5cfc237a98d188452b66abde94fb24b44e2e539ee63f42eb232120672415"
        )
        XCTAssertEqual(
            source["deltaPackageSHA256"] as? String,
            "93bb1571b2926c4c79744a8fe28905f972a7fda506a81765376b704dbb964884"
        )
        XCTAssertEqual(scope["approvedStateCount"] as? Int, 42)
        XCTAssertEqual((scope["candidateOnlyStateIDs"] as? [String])?.count, 6)
        XCTAssertEqual(scope["withheldStateIDs"] as? [String], ["CAP-05"])
    }

    func testResolvedAllowanceCopyUsesCanonicalPlanName() throws {
        let root = try contractResourceRoot(for: .resolvedContracts)
        let data = try Data(contentsOf: root.appendingPathComponent("snaplist-copy-catalog.json"))
        let copy = try XCTUnwrap(String(data: data, encoding: .utf8))

        XCTAssertTrue(copy.contains("SnapList Pro"))
        XCTAssertFalse(copy.contains("Seller Pro"))
    }

    func testEveryVendoredDeltaFileMatchesTheCanonicalV11Checksum() throws {
        let root = try contractResourceRoot(for: .resolvedRoot)
        let checksums = try parseChecksums(
            at: root.appendingPathComponent("checksums-sha256.txt")
        )
        let relativeFiles = try FileManager.default.subpathsOfDirectory(atPath: root.path)
            .filter { !URL(fileURLWithPath: $0).pathExtension.isEmpty }
            .filter { $0 != "SOURCE-MANIFEST.json" && $0 != "checksums-sha256.txt" }

        for relativePath in relativeFiles {
            let expected = try XCTUnwrap(checksums[relativePath], relativePath)
            let data = try Data(contentsOf: root.appendingPathComponent(relativePath))
            XCTAssertEqual(sha256(data), expected, relativePath)
        }
    }

    func testRunAndReviewStatesRemainOwnedByTheirChildIssues() {
        let runs = ApprovedVisualStateID.allCases.filter { $0.rawValue.hasPrefix("RUN-") }
        let reviews = ApprovedVisualStateID.allCases.filter { $0.rawValue.hasPrefix("REV-") }

        XCTAssertEqual(runs.count, 8)
        XCTAssertTrue(runs.allSatisfy { $0.ownerIssue == 211 })
        XCTAssertEqual(reviews.count, 9)
        XCTAssertTrue(reviews.allSatisfy { $0.ownerIssue == 212 })
    }
}

private func parseChecksums(at url: URL) throws -> [String: String] {
    let contents = try String(contentsOf: url, encoding: .utf8)
    var result: [String: String] = [:]

    for line in contents.split(whereSeparator: \.isNewline) {
        let parts = line.split(maxSplits: 1, whereSeparator: \.isWhitespace)
        guard parts.count == 2 else { continue }
        let path = parts[1].trimmingCharacters(in: .whitespaces)
            .replacingOccurrences(of: "./", with: "")
        result[path] = String(parts[0])
    }
    return result
}

private func sha256(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

enum ContractResourceLocation {
    case designContracts
    case baseV1
    case resolvedRoot
    case resolvedContracts

    var relativeComponents: [String] {
        switch self {
        case .designContracts:
            ["DesignContracts"]
        case .baseV1:
            ["DesignContracts", "V1"]
        case .resolvedRoot:
            ["DesignContracts", "Resolved", "V1PlusRunRev"]
        case .resolvedContracts:
            ["DesignContracts", "Resolved", "V1PlusRunRev", "resolved"]
        }
    }
}

func loadJSON(
    named name: String,
    at location: ContractResourceLocation
) throws -> [String: Any] {
    let root = try contractResourceRoot(for: location)
    let url = root.appendingPathComponent(name).appendingPathExtension("json")
    let data = try Data(contentsOf: url)
    return try XCTUnwrap(
        JSONSerialization.jsonObject(with: data) as? [String: Any]
    )
}

func contractResourceRoot(for location: ContractResourceLocation) throws -> URL {
    let bundle = Bundle(for: VisualContractTests.self)
    var root = try XCTUnwrap(bundle.resourceURL)
    for component in location.relativeComponents {
        root.appendPathComponent(component, isDirectory: true)
    }
    return root
}
