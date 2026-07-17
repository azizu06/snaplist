import XCTest
@testable import SnapList

final class MobileAPIContractTests: XCTestCase {
    func testZeroNetworkClientProvidesProofFixtures() async throws {
        let client = ZeroNetworkMobileAPIClient()

        let health = try await client.getHealth()
        let session = try await client.getSession(bearerToken: "fixture-token")
        let configuration = try await client.getRevenueCatConfiguration(bearerToken: "fixture-token")
        let entitlement = try await client.getAiItemEntitlement(bearerToken: "fixture-token")

        XCTAssertEqual(health.data.apiVersion, "v1")
        XCTAssertEqual(health.data.status, "ok")
        XCTAssertEqual(session.data.userId, "fixture-clerk-user")
        XCTAssertFalse(configuration.data.configured)
        XCTAssertEqual(entitlement.data.billingSource, .included)
        XCTAssertEqual(entitlement.data.remainingItems, 1)
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

    func testServerEntitlementParsesPostgresDatesWithAndWithoutFractions() {
        let payload = AiItemEntitlementEnvelope.DataPayload(
            billingSource: .storeKit,
            status: .grace,
            remainingItems: 3,
            periodStart: "2026-07-01T00:00:00Z",
            periodEnd: "2026-08-01T00:00:00.000Z",
            gracePeriodEnd: "2026-08-08T00:00:00+00:00",
            transitionState: .notRequired,
            legacyStripeStatus: nil
        )

        let verified = payload.serverVerifiedSubscription

        XCTAssertNotNil(verified.periodStart)
        XCTAssertNotNil(verified.periodEnd)
        XCTAssertNotNil(verified.gracePeriodEnd)
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
