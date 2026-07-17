import XCTest
@testable import SnapList

final class MobileAPIContractTests: XCTestCase {
    func testZeroNetworkClientProvidesProofFixtures() async throws {
        let client = ZeroNetworkMobileAPIClient()

        let health = try await client.getHealth()
        let session = try await client.getSession(bearerToken: "fixture-token")

        XCTAssertEqual(health.data.apiVersion, "v1")
        XCTAssertEqual(health.data.status, "ok")
        XCTAssertEqual(session.data.userId, "fixture-clerk-user")
    }

    func testEveryContractOnlyFixtureNamesItsExistingOwnerAndNoBehavior() {
        let provider = ZeroNetworkMobileAPIClient()

        for operation in ContractOnlyOperation.allCases {
            let fixture = provider.fixture(for: operation)
            XCTAssertEqual(fixture.ownerIssue, operation.ownerIssue)
            XCTAssertEqual(
                fixture.note,
                "Schema fixture only. No server behavior or network request is executed."
            )
        }
    }

    func testSwiftOperationInventoryMatchesOpenAPIContractOnlyOperations() throws {
        let contract = try loadJSON(named: "mobile-api-v1.openapi", at: .baseV1)
        let paths = try XCTUnwrap(contract["paths"] as? [String: Any])
        var contractOnlyOperationIDs = Set<String>()

        for pathItem in paths.values {
            guard let methods = pathItem as? [String: Any] else { continue }
            for method in methods.values {
                guard let operation = method as? [String: Any],
                      operation["x-implementation-status"] as? String == "contract-only",
                      let operationID = operation["operationId"] as? String else {
                    continue
                }
                contractOnlyOperationIDs.insert(operationID)
            }
        }

        XCTAssertEqual(
            contractOnlyOperationIDs,
            Set(ContractOnlyOperation.allCases.map(\.rawValue))
        )
    }
}
