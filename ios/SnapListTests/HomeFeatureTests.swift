import Foundation
import Observation
import SwiftUI
import UIKit
import XCTest
@testable import SnapList

/// The app's API origin still resolves through `HomeRepositoryFactory`, which
/// outlived the seller-operations Home it was named for. `ClerkAuthentication`,
/// `MobileAPIClient`, and `SnapListApp` all resolve their origin through it, so
/// the fail-closed rules stay covered here.
final class HomeAPIOriginTests: XCTestCase {
    func testReleaseAPIOriginUsesHTTPSInfoValueAndFailsClosedWithoutOne() {
        XCTAssertNil(
            HomeRepositoryFactory.resolveAPIOrigin(
                environment: [:],
                bundleValue: nil,
                allowsLocalDevelopment: false
            )
        )
        XCTAssertNil(
            HomeRepositoryFactory.resolveAPIOrigin(
                environment: ["SNAPLIST_API_ORIGIN": "http://127.0.0.1:3001"],
                bundleValue: nil,
                allowsLocalDevelopment: false
            )
        )
        XCTAssertEqual(
            HomeRepositoryFactory.resolveAPIOrigin(
                environment: [:],
                bundleValue: "https://api.snaplist.example",
                allowsLocalDevelopment: false
            ),
            URL(string: "https://api.snaplist.example")
        )
    }

    func testLocalhostAPIOriginRequiresExplicitLocalDevelopmentConfiguration() {
        XCTAssertNil(
            HomeRepositoryFactory.resolveAPIOrigin(
                environment: [:],
                bundleValue: nil,
                allowsLocalDevelopment: true
            )
        )
        XCTAssertEqual(
            HomeRepositoryFactory.resolveAPIOrigin(
                environment: ["SNAPLIST_API_ORIGIN": "http://127.0.0.1:3001"],
                bundleValue: nil,
                allowsLocalDevelopment: true
            ),
            URL(string: "http://127.0.0.1:3001")
        )
        XCTAssertNil(
            HomeRepositoryFactory.resolveAPIOrigin(
                environment: ["SNAPLIST_API_ORIGIN": "http://api.snaplist.example"],
                bundleValue: nil,
                allowsLocalDevelopment: true
            )
        )
    }
}

@MainActor
final class TrophyWallDomainTests: XCTestCase {
    /// The approved wall is a two-column 4:5 photo grid at a 12-point gutter and
    /// a 12-point corner radius. Asserting the numbers where they are declared,
    /// and asserting the rendered columns are derived from them, keeps the spec
    /// checkable without measuring pixels through XCUITest.
    func testApprovedWallGridMetricsDriveTheRenderedColumns() {
        XCTAssertEqual(TrophyWallGridMetrics.columnCount, 2)
        XCTAssertEqual(TrophyWallGridMetrics.tileAspectRatio, 4.0 / 5.0)
        XCTAssertEqual(TrophyWallGridMetrics.gutterPoints, 12)
        XCTAssertEqual(TrophyWallGridMetrics.tileCornerRadiusPoints, 12)

        let columns = TrophyWallView.gridColumns
        XCTAssertEqual(columns.count, TrophyWallGridMetrics.columnCount)
        XCTAssertEqual(
            columns.map(\.spacing),
            Array(
                repeating: CGFloat?.some(TrophyWallGridMetrics.gutterPoints),
                count: TrophyWallGridMetrics.columnCount
            )
        )
    }

    func testStoreConvergesOnlyExactPrincipalScopedLogicalIdentity() {
        let fixture = TrophyWallTestFixture()
        let cases = [
            TrophyWallConvergenceCase(
                name: "exact principal and logical identity",
                acceptedRun: TrophyWallCanonicalAcceptedRun(
                    principalScope: fixture.principal,
                    runID: fixture.runID,
                    linkedLogicalIdentity: fixture.logicalID,
                    lastMeaningfulUpdateAt: fixture.acceptedUpdate
                ),
                expectedCards: [
                    .accepted(
                        principalScope: fixture.principal,
                        runID: fixture.runID,
                        itemName: fixture.matchedItemName,
                        lastMeaningfulUpdateAt: fixture.acceptedUpdate
                    ),
                    .pending(
                        principalScope: fixture.principal,
                        logicalIdentity: fixture.unrelatedLogicalID,
                        itemName: fixture.unrelatedItemName,
                        lastMeaningfulUpdateAt: fixture.unrelatedUpdate
                    ),
                ]
            ),
            TrophyWallConvergenceCase(
                name: "wrong principal",
                acceptedRun: TrophyWallCanonicalAcceptedRun(
                    principalScope: fixture.otherPrincipal,
                    runID: fixture.runID,
                    linkedLogicalIdentity: fixture.logicalID,
                    lastMeaningfulUpdateAt: fixture.acceptedUpdate
                ),
                expectedCards: fixture.initialCards
            ),
            TrophyWallConvergenceCase(
                name: "missing logical link",
                acceptedRun: TrophyWallCanonicalAcceptedRun(
                    principalScope: fixture.principal,
                    runID: fixture.runID,
                    linkedLogicalIdentity: nil,
                    lastMeaningfulUpdateAt: fixture.acceptedUpdate
                ),
                expectedCards: [
                    .accepted(
                        principalScope: fixture.principal,
                        runID: fixture.runID,
                        lastMeaningfulUpdateAt: fixture.acceptedUpdate
                    ),
                    fixture.initialCards[0],
                    fixture.initialCards[1],
                ]
            ),
        ]

        for testCase in cases {
            let store = fixture.makeStore()

            store.ingest(testCase.acceptedRun)

            XCTAssertEqual(store.principalScope, fixture.principal, testCase.name)
            XCTAssertEqual(store.cards, testCase.expectedCards, testCase.name)
        }
    }

    func testStoreConvergesAcceptedHandoffOnlyWithExactPrincipalScopedRunDetail() throws {
        let fixture = TrophyWallTestFixture()
        let acceptedCard = TrophyWallCard.accepted(
            principalScope: fixture.principal,
            runID: fixture.runID,
            itemName: fixture.matchedItemName,
            lastMeaningfulUpdateAt: fixture.runDetailUpdate
        )
        let exactCards = [
            fixture.initialCards[1],
            acceptedCard,
        ]
        let cases = [
            TrophyWallRunDetailConvergenceCase(
                name: "exact principal, run, and item",
                principalScope: fixture.principal,
                runDetail: try fixture.decodedRunDetail(
                    runID: fixture.runID,
                    itemID: fixture.itemID
                ),
                expectedCards: exactCards,
                expectedDestinations: [.localRecovery(fixture.unrelatedLogicalID), .run(fixture.runID)]
            ),
            TrophyWallRunDetailConvergenceCase(
                name: "wrong principal",
                principalScope: fixture.otherPrincipal,
                runDetail: try fixture.decodedRunDetail(
                    runID: fixture.runID,
                    itemID: fixture.itemID
                ),
                expectedCards: fixture.initialCards,
                expectedDestinations: [.localRecovery(fixture.logicalID), .localRecovery(fixture.unrelatedLogicalID)]
            ),
            TrophyWallRunDetailConvergenceCase(
                name: "wrong run",
                principalScope: fixture.principal,
                runDetail: try fixture.decodedRunDetail(
                    runID: fixture.thirdRunID,
                    itemID: fixture.itemID
                ),
                expectedCards: fixture.initialCards,
                expectedDestinations: [.localRecovery(fixture.logicalID), .localRecovery(fixture.unrelatedLogicalID)]
            ),
            TrophyWallRunDetailConvergenceCase(
                name: "wrong item",
                principalScope: fixture.principal,
                runDetail: try fixture.decodedRunDetail(
                    runID: fixture.runID,
                    itemID: fixture.otherItemID
                ),
                expectedCards: fixture.initialCards,
                expectedDestinations: [.localRecovery(fixture.logicalID), .localRecovery(fixture.unrelatedLogicalID)]
            ),
        ]

        for testCase in cases {
            let store = fixture.makeStore()

            store.ingest(
                acceptedHandoff: fixture.acceptedHandoff,
                runDetail: testCase.runDetail,
                principalScope: testCase.principalScope
            )

            XCTAssertEqual(store.principalScope, fixture.principal, testCase.name)
            XCTAssertEqual(store.cards, testCase.expectedCards, testCase.name)
            XCTAssertEqual(store.cards.count, 2, testCase.name)
            XCTAssertEqual(
                store.processingRows.map(\.destination),
                testCase.expectedDestinations,
                testCase.name
            )
        }
    }

    func testStoreProjectsLaterCanonicalWorkingStageFromAcceptedHandoffRunDetail() throws {
        let fixture = TrophyWallTestFixture()
        let laterRunDetail = try fixture.decodedRunDetail(
            runID: fixture.runID,
            itemID: fixture.itemID,
            status: .running,
            stage: .pricing
        )
        let store = fixture.makeStore()

        for _ in 0..<2 {
            store.ingest(
                acceptedHandoff: fixture.acceptedHandoff,
                runDetail: laterRunDetail,
                principalScope: fixture.principal
            )
        }

        XCTAssertEqual(store.cards.count, 2)
        XCTAssertEqual(store.cards.first, fixture.initialCards[1])
        XCTAssertEqual(
            store.processingRows.map(\.id),
            [.local(fixture.unrelatedLogicalID), .run(fixture.runID)]
        )
        XCTAssertEqual(
            store.processingRows.map(\.itemName),
            [fixture.unrelatedItemName, fixture.matchedItemName]
        )
        XCTAssertEqual(
            store.processingRows.map(\.stateLabel),
            ["Pending upload", "Pricing"]
        )
        XCTAssertEqual(
            store.processingRows.map(\.accessibilityLabel),
            [
                "\(fixture.unrelatedItemName), pending upload. Local item, not sent yet.",
                "\(fixture.matchedItemName), working, pricing.",
            ]
        )
        XCTAssertEqual(
            store.processingRows.map(\.destination),
            [.localRecovery(fixture.unrelatedLogicalID), .run(fixture.runID)]
        )
    }

    func testStoreProjectsRemainingCanonicalWorkingStagesFromAcceptedHandoffRunDetail() throws {
        let fixture = TrophyWallTestFixture()
        let cases = fixture.workingStageCases.filter { $0.stage != .pricing }

        for testCase in cases {
            let store = fixture.makeStore()
            let laterRunDetail = try fixture.decodedRunDetail(
                runID: fixture.runID,
                itemID: fixture.itemID,
                status: .running,
                stage: testCase.stage
            )

            for _ in 0..<2 {
                store.ingest(
                    acceptedHandoff: fixture.acceptedHandoff,
                    runDetail: laterRunDetail,
                    principalScope: fixture.principal
                )
            }

            XCTAssertEqual(store.cards.count, 2, testCase.name)
            XCTAssertEqual(store.cards.first, fixture.initialCards[1], testCase.name)
            XCTAssertEqual(
                store.cards.map(\.identity),
                [.local(fixture.unrelatedLogicalID), .run(fixture.runID)],
                testCase.name
            )
            XCTAssertEqual(
                store.cards.last?.orderKey.lastMeaningfulUpdateAt,
                fixture.runDetailUpdate,
                testCase.name
            )
            XCTAssertEqual(
                store.processingRows.map(\.itemName),
                [fixture.unrelatedItemName, fixture.matchedItemName],
                testCase.name
            )
            XCTAssertEqual(
                store.processingRows.map(\.stateLabel),
                ["Pending upload", testCase.stateLabel],
                testCase.name
            )
            XCTAssertEqual(
                store.processingRows.map(\.accessibilityLabel),
                [
                    "\(fixture.unrelatedItemName), pending upload. Local item, not sent yet.",
                    "\(fixture.matchedItemName), working, \(testCase.accessibilityFact).",
                ],
                testCase.name
            )
            XCTAssertEqual(
                store.processingRows.map(\.destination),
                [.localRecovery(fixture.unrelatedLogicalID), .run(fixture.runID)],
                testCase.name
            )
        }
    }

    func testStoreProjectsRetryingCanonicalWorkingStagesFromRunHistoryPage() throws {
        let fixture = TrophyWallTestFixture()

        for testCase in fixture.workingStageCases {
            let store = fixture.makeStore()
            let page = TrophyWallRunHistoryPage(
                entries: [
                    TrophyWallRunHistoryEntry(
                        logicalIdentity: fixture.logicalID,
                        orderKey: TrophyWallOrderKey(
                            lastMeaningfulUpdateAt: fixture.runDetailUpdate,
                            stableIdentity: fixture.runID.uuidString.lowercased()
                        ),
                        run: try fixture.decodedRunDetail(
                            runID: fixture.runID,
                            itemID: fixture.itemID,
                            status: .retrying,
                            stage: testCase.stage
                        )
                    ),
                ],
                nextCursor: nil
            )

            for _ in 0..<2 {
                store.ingest(
                    historyPage: page,
                    principalScope: fixture.principal
                )
            }

            XCTAssertEqual(store.cards.count, 2, testCase.name)
            XCTAssertEqual(store.cards.first, fixture.initialCards[1], testCase.name)
            XCTAssertEqual(store.processingRows.count, 2, testCase.name)
            let canonicalRow = store.processingRows.last
            XCTAssertEqual(canonicalRow?.id, .run(fixture.runID), testCase.name)
            XCTAssertEqual(canonicalRow?.itemName, fixture.matchedItemName, testCase.name)
            XCTAssertEqual(canonicalRow?.stateLabel, testCase.stateLabel, testCase.name)
            XCTAssertEqual(canonicalRow?.accessibilityLabel,
                           "\(fixture.matchedItemName), working, \(testCase.accessibilityFact).",
                           testCase.name)
            XCTAssertEqual(canonicalRow?.destination, .run(fixture.runID), testCase.name)
        }
    }

    func testStoreProjectsSucceededRunWithoutReviewActionAsLockedReadyCard() throws {
        try assertLockedCanonicalProjection(.readyToReview)
    }

    func testStoreProjectsFailedRunWithoutRetryClientAsLockedNeedsRetryCard() throws {
        try assertLockedCanonicalProjection(.needsRetry)
    }

    func testStoreTombstonesNewerRetryCleanupAgainstOlderRetryableReplay() throws {
        let fixture = TrophyWallTestFixture()
        let store = fixture.makeStore()
        let retryablePage = try fixture.historyPage(
            status: .failed,
            stage: .pricing,
            terminalOutcome: .failed,
            retryTruth: (canRetry: true, workPreserved: true),
            historyOrderAt: Date(timeIntervalSince1970: 5),
            lastMeaningfulUpdateAt: "1970-01-01T00:00:05.000Z"
        )
        let retentionCleanedPage = try fixture.historyPage(
            status: .failed,
            stage: .pricing,
            terminalOutcome: .failed,
            retryTruth: (canRetry: false, workPreserved: false),
            canStartNewCapture: true,
            historyOrderAt: Date(timeIntervalSince1970: 6),
            lastMeaningfulUpdateAt: "1970-01-01T00:00:06.000Z",
            retentionCleanedAt: "1970-01-01T00:00:06.000Z"
        )

        store.ingest(historyPage: retryablePage, principalScope: fixture.principal)
        XCTAssertEqual(
            store.processingRows.map(\.stateLabel),
            ["Pending upload", "Needs retry · Upload didn't finish."]
        )

        store.ingest(historyPage: retentionCleanedPage, principalScope: fixture.principal)
        store.ingest(historyPage: retryablePage, principalScope: fixture.principal)
        store.ingest(
            acceptedHandoff: fixture.acceptedHandoff,
            runDetail: try fixture.decodedRunDetail(
                runID: fixture.runID,
                itemID: fixture.itemID
            ),
            principalScope: fixture.principal
        )

        XCTAssertEqual(store.cards, [fixture.initialCards[1]])
        XCTAssertEqual(
            store.processingRows.map(\.id),
            [.local(fixture.unrelatedLogicalID)]
        )
        XCTAssertEqual(store.processingRows.map(\.stateLabel), ["Pending upload"])
        XCTAssertEqual(store.processingRows.map(\.destination), [.localRecovery(fixture.unrelatedLogicalID)])
    }

    func testStoreKeepsValidNeedsRetryCardForMalformedNewerCanonicalTruth() throws {
        let fixture = TrophyWallTestFixture()
        let store = fixture.makeStore()
        let initialOrderKey = TrophyWallOrderKey(
            lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 5),
            stableIdentity: fixture.runID.uuidString.lowercased()
        )
        let olderRetryablePage = try fixture.historyPage(
            status: .failed,
            stage: .pricing,
            terminalOutcome: .failed,
            retryTruth: (canRetry: true, workPreserved: true),
            historyOrderAt: Date(timeIntervalSince1970: 4),
            lastMeaningfulUpdateAt: "1970-01-01T00:00:04.000Z"
        )
        let malformedPage = try fixture.historyPage(
            status: .failed,
            stage: .pricing,
            terminalOutcome: .canceled,
            retryTruth: (canRetry: true, workPreserved: true),
            historyOrderAt: Date(timeIntervalSince1970: 6),
            lastMeaningfulUpdateAt: "1970-01-01T00:00:06.000Z"
        )

        store.ingest(
            TrophyWallCanonicalAcceptedRun(
                principalScope: fixture.principal,
                runID: fixture.runID,
                linkedLogicalIdentity: fixture.logicalID,
                state: .needsRetryLocked(detail: "Upload didn't finish."),
                lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 5),
                historyOrderKey: initialOrderKey,
                itemName: nil
            )
        )
        let validCards = store.cards
        let validRows = store.processingRows

        store.ingest(historyPage: malformedPage, principalScope: fixture.principal)
        store.ingest(historyPage: malformedPage, principalScope: fixture.principal)
        store.ingest(historyPage: olderRetryablePage, principalScope: fixture.principal)

        XCTAssertEqual(store.cards, validCards)
        XCTAssertEqual(store.processingRows, validRows)
        XCTAssertEqual(
            store.cards.map(\.identity),
            [.local(fixture.unrelatedLogicalID), .run(fixture.runID)]
        )
        XCTAssertEqual(
            store.cards.map(\.orderKey.lastMeaningfulUpdateAt),
            [fixture.unrelatedUpdate, Date(timeIntervalSince1970: 5)]
        )
    }

    func testStoreConvergesRelaunchedPendingFromFrozenRunHistoryPageWithoutMutableReordering()
        throws {
        let fixture = TrophyWallTestFixture()
        let mutableRun = try fixture.decodedRunDetail(
            runID: fixture.runID,
            itemID: fixture.itemID,
            status: .running,
            stage: .pricing,
            lastMeaningfulUpdateAt: "1970-01-01T00:00:50.000Z"
        )
        let page = TrophyWallRunHistoryPage(
            entries: [
                TrophyWallRunHistoryEntry(
                    logicalIdentity: fixture.logicalID,
                    orderKey: TrophyWallOrderKey(
                        lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 5),
                        stableIdentity: fixture.runID.uuidString.lowercased()
                    ),
                    run: mutableRun
                ),
            ],
            nextCursor: nil
        )
        let store = fixture.makeStore()

        for _ in 0..<2 {
            store.ingest(
                historyPage: page,
                principalScope: fixture.principal
            )
        }

        XCTAssertEqual(store.cards.count, 2)
        XCTAssertEqual(
            store.cards.map(\.identity),
            [.local(fixture.unrelatedLogicalID), .run(fixture.runID)]
        )
        XCTAssertEqual(
            store.cards.map(\.orderKey.lastMeaningfulUpdateAt),
            [fixture.unrelatedUpdate, Date(timeIntervalSince1970: 5)]
        )
        XCTAssertEqual(
            store.processingRows.map(\.itemName),
            [fixture.unrelatedItemName, fixture.matchedItemName]
        )
        XCTAssertEqual(
            store.processingRows.map(\.stateLabel),
            ["Pending upload", "Pricing"]
        )
        XCTAssertEqual(
            store.processingRows.map(\.destination),
            [.localRecovery(fixture.unrelatedLogicalID), .run(fixture.runID)]
        )
        XCTAssertEqual(
            page.entries.first?.run.lastMeaningfulUpdateAt,
            "1970-01-01T00:00:50.000Z"
        )
    }

    func testProcessingProjectionPreservesExactMergeTruthAndRunDestination() {
        let fixture = TrophyWallTestFixture()
        let acceptedRun = TrophyWallCanonicalAcceptedRun(
            principalScope: fixture.principal,
            runID: fixture.runID,
            linkedLogicalIdentity: fixture.logicalID,
            lastMeaningfulUpdateAt: fixture.acceptedUpdate
        )
        let store = fixture.makeStore()

        store.ingest(acceptedRun)

        XCTAssertEqual(
            store.processingRows.map(\.id),
            [.run(fixture.runID), .local(fixture.unrelatedLogicalID)]
        )
        XCTAssertEqual(
            store.processingRows.map(\.itemName),
            [fixture.matchedItemName, fixture.unrelatedItemName]
        )
        XCTAssertEqual(
            store.processingRows.map(\.stateLabel),
            ["Accepted", "Pending upload"]
        )
        XCTAssertEqual(
            store.processingRows.map(\.destination),
            [.run(fixture.runID), .localRecovery(fixture.unrelatedLogicalID)]
        )
        XCTAssertEqual(
            store.processingRows.map(\.accessibilityLabel),
            [
                "\(fixture.matchedItemName), accepted.",
                "\(fixture.unrelatedItemName), pending upload. Local item, not sent yet.",
            ]
        )
        XCTAssertEqual(
            store.processingRows.map(\.accessibilityIdentifier),
            [
                "trophy.processing.row.run.\(fixture.runID.uuidString.lowercased())",
                "trophy.processing.row.local."
                    + "37500000-0000-4000-8000-000000000002",
            ]
        )

        let firstProjection = store.processingRows
        store.ingest(acceptedRun)
        XCTAssertEqual(store.processingRows, firstProjection)
    }

    func testStoreProjectsConfirmedLegacyEbayPublicationIntoTheSettledTrophyWall() throws {
        let fixture = TrophyWallTestFixture()
        let store = fixture.makeStore()
        let historyPage = try fixture.historyPage(
            listingID: fixture.listingID,
            status: .succeeded,
            stage: .completed,
            terminalOutcome: .succeeded
        )
        let legacyStatus = try JSONDecoder().decode(
            EbayPublishStatus.self,
            from: Data(
                """
                {"listingId":"\(fixture.listingID.uuidString.lowercased())","outcome":"published","ebayListingId":"123456789012","ebayOfferId":"offer-375","alreadyPublished":true}
                """.utf8
            )
        )

        XCTAssertNil(legacyStatus.publishedListing)

        store.ingest(historyPage: historyPage, principalScope: fixture.principal)
        store.applyEbayPublishStatus(legacyStatus)

        XCTAssertEqual(store.processingRows.map(\.id), [.local(fixture.unrelatedLogicalID)])
        XCTAssertEqual(
            store.settledTiles,
            [
                TrophyWallSettledTile(
                    id: .run(fixture.runID),
                    itemName: fixture.matchedItemName,
                    stateLabel: "Published to eBay",
                    historyOrderAt: fixture.runDetailUpdate
                ),
            ]
        )
    }

    func testStoreProjectsPersistedExportPackTruthIntoTheSettledTrophyWall() throws {
        let fixture = TrophyWallTestFixture()
        let store = fixture.makeStore()
        let historyPage = try fixture.historyPage(
            listingID: fixture.listingID,
            status: .succeeded,
            stage: .completed,
            terminalOutcome: .succeeded,
            deliveryState: "export_prepared"
        )

        store.ingest(historyPage: historyPage, principalScope: fixture.principal)

        XCTAssertEqual(store.processingRows.map(\.id), [.local(fixture.unrelatedLogicalID)])
        XCTAssertEqual(
            store.settledTiles,
            [
                TrophyWallSettledTile(
                    id: .run(fixture.runID),
                    itemName: fixture.matchedItemName,
                    stateLabel: "Export prepared",
                    historyOrderAt: fixture.runDetailUpdate
                ),
            ]
        )
    }

    func testSettledTileAccessibilityNamesTruthDateAndStaticResult() {
        let historyOrderAt = Date(timeIntervalSince1970: 1_753_015_200)
        let tile = TrophyWallSettledTile(
            id: .run(UUID()),
            itemName: "Vintage denim jacket",
            stateLabel: "Export prepared",
            historyOrderAt: historyOrderAt
        )
        let relevantDate = historyOrderAt.formatted(
            .dateTime.month(.wide).day()
        )

        XCTAssertEqual(
            tile.accessibilityLabel,
            "Vintage denim jacket, photo unavailable, Export prepared, "
                + "\(relevantDate). Completed item in your collection."
        )
    }

    func testStoreWithdrawsInvalidatedExportTruthWithoutReorderingTheRun() throws {
        let fixture = TrophyWallTestFixture()
        let store = fixture.makeStore()
        let prepared = try fixture.historyPage(
            listingID: fixture.listingID,
            status: .succeeded,
            stage: .completed,
            terminalOutcome: .succeeded,
            deliveryState: "export_prepared"
        )
        let invalidated = try fixture.historyPage(
            listingID: fixture.listingID,
            status: .succeeded,
            stage: .completed,
            terminalOutcome: .succeeded
        )

        store.ingest(historyPage: prepared, principalScope: fixture.principal)
        store.ingest(historyPage: invalidated, principalScope: fixture.principal)

        XCTAssertTrue(store.settledTiles.isEmpty)
        XCTAssertEqual(store.processingRows.map(\.stateLabel), [
            "Pending upload",
            "Ready to review",
        ])
        XCTAssertEqual(
            store.cards.last?.orderKey.lastMeaningfulUpdateAt,
            fixture.runDetailUpdate
        )
    }

    func testStoreRehydratesListingCorrelationFromAnEqualHistoryPage() throws {
        let fixture = TrophyWallTestFixture()
        let savedCard = TrophyWallCard.accepted(
            principalScope: fixture.principal,
            runID: fixture.runID,
            state: .readyToReviewLocked,
            itemName: fixture.matchedItemName,
            lastMeaningfulUpdateAt: fixture.runDetailUpdate
        )
        let store = fixture.makeStore(cards: [savedCard])
        let historyPage = try fixture.historyPage(
            listingID: fixture.listingID,
            status: .succeeded,
            stage: .completed,
            terminalOutcome: .succeeded
        )

        store.ingest(historyPage: historyPage, principalScope: fixture.principal)
        store.applyEbayPublishStatus(
            EbayPublishStatus(
                listingID: fixture.listingID,
                outcome: .published,
                ebayListingID: "123456789012",
                ebayOfferID: "offer-375",
                alreadyPublished: true
            )
        )

        XCTAssertEqual(
            store.settledTiles.map(\.id),
            [.run(fixture.runID)]
        )
    }

    func testStoreKeepsConfirmedPublicationAcrossTheFirstHistoryRefresh() throws {
        let fixture = TrophyWallTestFixture()
        let store = fixture.makeStore()
        let runDetail = try fixture.decodedRunDetail(
            runID: fixture.runID,
            itemID: fixture.itemID,
            listingID: fixture.listingID,
            status: .succeeded,
            stage: .completed,
            terminalOutcome: .succeeded
        )
        let historyPage = try fixture.historyPage(
            listingID: fixture.listingID,
            status: .succeeded,
            stage: .completed,
            terminalOutcome: .succeeded
        )

        store.ingest(
            acceptedHandoff: fixture.acceptedHandoff,
            runDetail: runDetail,
            principalScope: fixture.principal
        )
        store.applyEbayPublishStatus(
            EbayPublishStatus(
                listingID: fixture.listingID,
                outcome: .published,
                ebayListingID: "123456789012",
                ebayOfferID: "offer-375",
                alreadyPublished: true
            )
        )
        store.ingest(historyPage: historyPage, principalScope: fixture.principal)

        XCTAssertEqual(
            store.settledTiles.map(\.id),
            [.run(fixture.runID)]
        )
    }

    func testProcessingViewDisclosesClampedRowsWithoutRouting() {
        let fixture = TrophyWallTestFixture()
        let store = fixture.makeStore(cards: fixture.processingInitialCards)
        store.ingest(
            TrophyWallCanonicalAcceptedRun(
                principalScope: fixture.principal,
                runID: fixture.runID,
                linkedLogicalIdentity: fixture.logicalID,
                lastMeaningfulUpdateAt: fixture.acceptedUpdate
            )
        )
        let allRowIdentifiers = store.processingRows.map(\.accessibilityIdentifier)
        let scenarios = [
            (
                name: "standard",
                size: CGSize(width: 390, height: 844),
                collapsedVisualLabel: "Show 2 more",
                collapsedLabel: "Show 2 more items",
                collapsedRowIdentifiers: Array(allRowIdentifiers.prefix(3))
            ),
            (
                name: "smallest",
                size: CGSize(width: 375, height: 667),
                collapsedVisualLabel: "Show more",
                collapsedLabel: "Show more items",
                collapsedRowIdentifiers: Array(allRowIdentifiers.prefix(2))
            ),
        ]

        for scenario in scenarios {
            let collapsed = TrophyWallProcessingView.presentation(
                from: store.processingRows,
                refreshRecovery: .idle,
                availableHeight: scenario.size.height,
                isExpanded: false
            )
            XCTAssertEqual(collapsed.disclosureLabel, scenario.collapsedVisualLabel)
            XCTAssertEqual(
                collapsed.disclosureAccessibilityLabel,
                scenario.collapsedLabel
            )
            XCTAssertEqual(
                collapsed.visibleRows.map(\.accessibilityIdentifier),
                scenario.collapsedRowIdentifiers
            )

            let expansion = TrophyWallProcessingView.disclosureTransition(
                from: false
            )
            XCTAssertTrue(expansion.isExpanded)
            XCTAssertEqual(expansion.announcement, "Expanded")
            let expanded = TrophyWallProcessingView.presentation(
                from: store.processingRows,
                refreshRecovery: .idle,
                availableHeight: scenario.size.height,
                isExpanded: expansion.isExpanded
            )
            XCTAssertEqual(expanded.disclosureLabel, "Show less")
            XCTAssertEqual(
                expanded.disclosureAccessibilityLabel,
                "Show fewer items"
            )
            XCTAssertEqual(
                expanded.visibleRows.map(\.accessibilityIdentifier),
                allRowIdentifiers
            )

            let collapse = TrophyWallProcessingView.disclosureTransition(
                from: expansion.isExpanded
            )
            XCTAssertFalse(collapse.isExpanded)
            XCTAssertEqual(collapse.announcement, "Collapsed")
            let recollapsed = TrophyWallProcessingView.presentation(
                from: store.processingRows,
                refreshRecovery: .idle,
                availableHeight: scenario.size.height,
                isExpanded: collapse.isExpanded
            )
            XCTAssertEqual(
                recollapsed.visibleRows.map(\.accessibilityIdentifier),
                scenario.collapsedRowIdentifiers
            )
        }
    }

    func testProcessingViewRendersApprovedMergedRowsAtPhoneWidth() async {
        let fixture = TrophyWallTestFixture()
        let store = fixture.makeStore(cards: fixture.processingInitialCards)
        store.ingest(
            TrophyWallCanonicalAcceptedRun(
                principalScope: fixture.principal,
                runID: fixture.runID,
                linkedLogicalIdentity: fixture.logicalID,
                lastMeaningfulUpdateAt: fixture.acceptedUpdate
            )
        )
        var openedRoutes: [HomeRoute] = []
        XCTAssertEqual(store.processingRows.count, 5)
        let standardRows = TrophyWallProcessingView.visibleRows(
            from: store.processingRows,
            availableHeight: 844
        )
        let smallestHeightRows = TrophyWallProcessingView.visibleRows(
            from: store.processingRows,
            availableHeight: 667
        )
        XCTAssertEqual(
            standardRows.map(\.id),
            [
                .run(fixture.runID),
                .local(fixture.unrelatedLogicalID),
                .run(fixture.thirdRunID),
            ]
        )
        XCTAssertEqual(
            standardRows.map(\.destination),
            [.run(fixture.runID), .localRecovery(fixture.unrelatedLogicalID), .run(fixture.thirdRunID)]
        )
        XCTAssertEqual(
            smallestHeightRows.map(\.id),
            [
                .run(fixture.runID),
                .local(fixture.unrelatedLogicalID),
            ]
        )
        XCTAssertEqual(
            smallestHeightRows.map(\.destination),
            [.run(fixture.runID), .localRecovery(fixture.unrelatedLogicalID)]
        )
        let standardImage = await captureHostedTrophyWallProcessingView(
            rows: store.processingRows,
            size: CGSize(width: 390, height: 844),
            dynamicTypeSize: .large,
            openRoute: { openedRoutes.append($0) }
        )
        let accessibilityImage = await captureHostedTrophyWallProcessingView(
            rows: store.processingRows,
            size: CGSize(width: 375, height: 667),
            dynamicTypeSize: .accessibility2,
            openRoute: { openedRoutes.append($0) }
        )

        XCTAssertEqual(standardImage.size, CGSize(width: 390, height: 844))
        XCTAssertEqual(accessibilityImage.size, CGSize(width: 375, height: 667))
        for image in [standardImage, accessibilityImage] {
            XCTAssertGreaterThan(
                image.opaqueDarkPixelCount(
                    in: CGRect(x: 0, y: 80, width: image.size.width, height: 160)
                ),
                100,
                "A header-only blank render must not satisfy MERGE-01 visual proof."
            )
        }
        XCTAssertTrue(openedRoutes.isEmpty)
        for (name, image) in [
            ("MERGE-01 Processing exact K-to-R convergence", standardImage),
            ("MERGE-01 Processing accessibility type", accessibilityImage),
        ] {
            let attachment = XCTAttachment(image: image)
            attachment.name = name
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }

    func testProcessingViewWithholdsEmptySuccessWithoutCollectionTruth() async {
        var openedRoutes: [HomeRoute] = []
        let image = await captureHostedTrophyWallProcessingView(
            rows: [],
            size: CGSize(width: 390, height: 844),
            dynamicTypeSize: .large,
            openRoute: { openedRoutes.append($0) }
        )

        XCTAssertEqual(image.size, CGSize(width: 390, height: 844))
        XCTAssertEqual(
            image.opaqueDarkPixelCount(
                in: CGRect(x: 0, y: 160, width: image.size.width, height: 500)
            ),
            0,
            "Unproven collection state must not render empty-success copy or actions."
        )
        XCTAssertTrue(openedRoutes.isEmpty)
    }

    func testOfflineRefreshKeepsOwnerScopedSavedTrophyCardsWithoutInventingServerTruth() async {
        let fixture = TrophyWallTestFixture()
        let store = fixture.makeStore(cards: fixture.processingInitialCards)
        let savedCards = store.cards
        let savedRows = store.processingRows
        let repository = ScriptedTrophyWallRunHistoryRepository(
            results: [.failure(URLError(.notConnectedToInternet))]
        )

        await store.refreshCollection(using: repository)

        XCTAssertEqual(store.collectionOutcome, .offline)
        XCTAssertEqual(store.cards, savedCards)
        XCTAssertEqual(store.processingRows, savedRows)
        XCTAssertEqual(repository.requestedPages.map(\.limit), [20])
        XCTAssertEqual(repository.requestedPages.map(\.cursor), [nil])

        let presentation = TrophyWallProcessingView.presentation(
            from: store.processingRows,
            collectionOutcome: store.collectionOutcome,
            refreshRecovery: store.collectionRefreshRecovery,
            availableHeight: 844,
            isExpanded: false
        )

        XCTAssertEqual(
            presentation.offlineNotice,
            "You're offline. Showing saved items."
        )
        XCTAssertNil(presentation.collectionMessage)
        XCTAssertEqual(
            presentation.visibleRows.map(\.accessibilityIdentifier),
            savedRows.prefix(3).map(\.accessibilityIdentifier)
        )
        XCTAssertEqual(
            presentation.visibleRows.map(\.stateLabel),
            ["Pending upload", "Pending upload", "Accepted"]
        )
    }

    func testRefusedCollectionRefreshRecoversAutomaticallyBeforeTellingTheSeller() async {
        let fixture = TrophyWallTestFixture()
        let store = fixture.makeStore(cards: fixture.processingInitialCards)
        let savedCards = store.cards
        let repository = ScriptedTrophyWallRunHistoryRepository(
            results: [.failure(URLError(.badServerResponse))]
        )
        var observedWaits: [Duration] = []

        await store.recoverCollection(using: repository) { duration in
            observedWaits.append(duration)
        }

        XCTAssertEqual(store.collectionOutcome, .unavailable)
        XCTAssertEqual(store.collectionRefreshRecovery, .exhausted)
        XCTAssertEqual(store.cards, savedCards)
        XCTAssertEqual(
            repository.requestedPages.count,
            TrophyWallCollectionRecoveryPolicy.maximumAutomaticAttempts,
            "A refused collection must be retried on the client's own initiative."
        )
        XCTAssertEqual(
            observedWaits,
            [.milliseconds(500), .milliseconds(1000)],
            "Automatic attempts must back off rather than hammer the boundary."
        )
    }

    func testSingleRefusedCollectionRefreshStaysSilentWhileRecoveryRemains() async {
        let fixture = TrophyWallTestFixture()
        let store = fixture.makeStore(cards: fixture.processingInitialCards)
        let repository = ScriptedTrophyWallRunHistoryRepository(
            results: [.failure(URLError(.badServerResponse))]
        )

        await store.refreshCollection(using: repository)

        XCTAssertEqual(store.collectionOutcome, .unavailable)
        XCTAssertEqual(store.collectionRefreshRecovery, .recovering)

        let presentation = TrophyWallProcessingView.presentation(
            from: store.processingRows,
            collectionOutcome: store.collectionOutcome,
            refreshRecovery: store.collectionRefreshRecovery,
            availableHeight: 844,
            isExpanded: false
        )

        XCTAssertNil(
            presentation.refreshUnavailableNotice,
            "One bad answer is not yet a seller-facing failure."
        )
    }

    /// The Try again path cancels and restarts the refresh task, so a recovery
    /// run can begin while an earlier refresh still holds the boundary. That
    /// overlap is dropped rather than queued, so it issues no request — and a
    /// run that never reached the boundary may not report the bounded attempts
    /// as spent, nor tell the seller SnapList gave up.
    func testDroppedOverlappingRefreshNeverSpendsARecoveryAttempt() async {
        let fixture = TrophyWallTestFixture()
        let store = fixture.makeStore(cards: fixture.processingInitialCards)
        let refusing = ScriptedTrophyWallRunHistoryRepository(
            results: [.failure(RunAPIError.unavailable)]
        )

        await store.refreshCollection(using: refusing)
        XCTAssertEqual(store.collectionOutcome, .unavailable)
        XCTAssertEqual(store.collectionRefreshRecovery, .recovering)

        let holding = GatedTrophyWallRunHistoryRepository()
        async let heldRefresh = store.refreshCollection(using: holding)
        await holding.entered.wait()

        var observedWaits: [Duration] = []
        let overlapped = ScriptedTrophyWallRunHistoryRepository(
            results: [.failure(RunAPIError.unavailable)]
        )
        await store.recoverCollection(using: overlapped) { duration in
            observedWaits.append(duration)
        }

        XCTAssertTrue(
            overlapped.requestedPages.isEmpty,
            "A dropped overlap reaches no boundary, so it spends no attempt."
        )
        XCTAssertTrue(
            observedWaits.isEmpty,
            "A dropped overlap must not back off between attempts it never made."
        )
        XCTAssertEqual(
            store.collectionRefreshRecovery,
            .recovering,
            "Exhaustion may only be claimed once real attempts have been spent."
        )

        await holding.release.open()
        _ = await heldRefresh
    }

    func testRecoveredCollectionClearsTheRefreshUnavailableNoticeWithoutSellerAction() async {
        let fixture = TrophyWallTestFixture()
        let store = fixture.makeStore(cards: fixture.processingInitialCards)
        let repository = ScriptedTrophyWallRunHistoryRepository(
            results: [.failure(URLError(.badServerResponse))]
        )

        await store.recoverCollection(using: repository) { _ in }
        XCTAssertEqual(store.collectionRefreshRecovery, .exhausted)

        let recovering = ScriptedTrophyWallRunHistoryRepository(
            results: [.page(TrophyWallRunHistoryPage(entries: [], nextCursor: nil))]
        )
        await store.refreshCollection(using: recovering)

        XCTAssertEqual(store.collectionOutcome, .loaded)
        XCTAssertEqual(store.collectionRefreshRecovery, .idle)
        XCTAssertNil(
            TrophyWallProcessingView.presentation(
                from: store.processingRows,
                collectionOutcome: store.collectionOutcome,
                refreshRecovery: store.collectionRefreshRecovery,
                availableHeight: 844,
                isExpanded: false
            ).refreshUnavailableNotice
        )
    }

    func testEveryCollectionOutcomeMapsToExactlyOneTrophyWallPresentation() {
        let fixture = TrophyWallTestFixture()
        let rows = fixture.makeStore(cards: fixture.processingInitialCards).processingRows
        XCTAssertFalse(rows.isEmpty)

        struct Expectation {
            let outcome: TrophyWallCollectionOutcome
            let recovery: TrophyWallCollectionRefreshRecovery
            let offlineNotice: String?
            let refreshUnavailableNotice: String?
            let collectionMessageHeading: String?
        }

        let expectations: [Expectation] = [
            .init(
                outcome: .unknown,
                recovery: .idle,
                offlineNotice: nil,
                refreshUnavailableNotice: nil,
                collectionMessageHeading: nil
            ),
            .init(
                outcome: .loaded,
                recovery: .idle,
                offlineNotice: nil,
                refreshUnavailableNotice: nil,
                collectionMessageHeading: nil
            ),
            .init(
                outcome: .offline,
                recovery: .idle,
                offlineNotice: "You're offline. Showing saved items.",
                refreshUnavailableNotice: nil,
                collectionMessageHeading: nil
            ),
            .init(
                outcome: .unavailable,
                recovery: .exhausted,
                offlineNotice: nil,
                refreshUnavailableNotice: "Can't refresh. Showing saved items.",
                collectionMessageHeading: nil
            ),
        ]

        for expectation in expectations {
            let rowsMode = TrophyWallProcessingView.presentation(
                from: rows,
                collectionOutcome: expectation.outcome,
                refreshRecovery: expectation.recovery,
                availableHeight: 844,
                isExpanded: false
            )
            XCTAssertEqual(
                rowsMode.offlineNotice,
                expectation.offlineNotice,
                "\(expectation.outcome) offline strip"
            )
            XCTAssertEqual(
                rowsMode.refreshUnavailableNotice,
                expectation.refreshUnavailableNotice,
                "\(expectation.outcome) refresh-unavailable strip"
            )
            XCTAssertNil(
                rowsMode.collectionMessage,
                "\(expectation.outcome) must never replace a populated rows region."
            )
            XCTAssertFalse(rowsMode.visibleRows.isEmpty)

            let wall = TrophyWallView.presentation(
                hasSettledTiles: true,
                collectionOutcome: expectation.outcome,
                refreshRecovery: expectation.recovery
            )
            XCTAssertEqual(wall.offlineNotice, expectation.offlineNotice)
            XCTAssertEqual(
                wall.refreshUnavailableNotice,
                expectation.refreshUnavailableNotice
            )
            XCTAssertTrue(wall.showsGrid)

            let emptyRowsMode = TrophyWallProcessingView.presentation(
                from: [],
                collectionOutcome: expectation.outcome,
                refreshRecovery: expectation.recovery,
                availableHeight: 844,
                isExpanded: false
            )
            XCTAssertNil(emptyRowsMode.offlineNotice)
            XCTAssertNil(emptyRowsMode.refreshUnavailableNotice)
            XCTAssertEqual(
                emptyRowsMode.collectionMessage?.heading,
                expectation.collectionMessageHeading
                    ?? Self.emptyRowsCollectionHeading(for: expectation.outcome)
            )
        }
    }

    private static func emptyRowsCollectionHeading(
        for outcome: TrophyWallCollectionOutcome
    ) -> String? {
        switch outcome {
        case .unknown: nil
        case .loaded: "Nothing is processing."
        case .offline, .unavailable: "Processing unavailable"
        }
    }

    func testEmptyProcessingStateAppearsOnlyAfterSuccessfulCollectionTruth() async {
        let fixture = TrophyWallTestFixture()
        let store = fixture.makeStore(cards: [])

        XCTAssertEqual(store.collectionOutcome, .unknown)
        let withheld = TrophyWallProcessingView.presentation(
            from: store.processingRows,
            collectionOutcome: store.collectionOutcome,
            refreshRecovery: store.collectionRefreshRecovery,
            availableHeight: 844,
            isExpanded: false
        )
        XCTAssertNil(withheld.collectionMessage)
        XCTAssertNil(withheld.offlineNotice)

        let repository = ScriptedTrophyWallRunHistoryRepository(
            results: [
                .page(TrophyWallRunHistoryPage(entries: [], nextCursor: nil)),
            ]
        )
        await store.refreshCollection(using: repository)

        XCTAssertEqual(store.collectionOutcome, .loaded)
        XCTAssertTrue(store.cards.isEmpty)

        let loaded = TrophyWallProcessingView.presentation(
            from: store.processingRows,
            collectionOutcome: store.collectionOutcome,
            refreshRecovery: store.collectionRefreshRecovery,
            availableHeight: 844,
            isExpanded: false
        )
        XCTAssertEqual(
            loaded.collectionMessage,
            TrophyWallProcessingView.CollectionMessage(
                heading: "Nothing is processing.",
                action: .scan(label: "Scan an item"),
                scoutImageName: "ScoutUncertain",
                scoutAccessibilityLabel: "Scout, the SnapList camera helper"
            )
        )
        XCTAssertNil(loaded.offlineNotice)
        XCTAssertTrue(loaded.visibleRows.isEmpty)
        XCTAssertNil(loaded.disclosureLabel)
    }

    func testCollectionRefreshConsumesEveryStableHistoryPageWithoutRepeatOrSkip() async throws {
        let fixture = TrophyWallTestFixture()
        let store = fixture.makeStore(cards: [])
        let newer = try fixture.historyPage(
            status: .queued,
            stage: .queued,
            terminalOutcome: nil
        )
        let olderRunID = fixture.thirdRunID
        let olderRun = try fixture.decodedRunDetail(
            runID: olderRunID,
            itemID: fixture.otherItemID,
            status: .running,
            stage: .pricing,
            lastMeaningfulUpdateAt: "1970-01-01T00:00:04.000Z"
        )
        let older = TrophyWallRunHistoryPage(
            entries: [
                TrophyWallRunHistoryEntry(
                    logicalIdentity: fixture.unrelatedLogicalID,
                    orderKey: TrophyWallOrderKey(
                        lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 4),
                        stableIdentity: olderRunID.uuidString.lowercased()
                    ),
                    run: olderRun
                ),
            ],
            nextCursor: nil
        )
        let repository = ScriptedTrophyWallRunHistoryRepository(
            results: [
                .page(
                    TrophyWallRunHistoryPage(
                        entries: newer.entries,
                        nextCursor: "stable-page-2"
                    )
                ),
                .page(older),
            ]
        )

        await store.refreshCollection(using: repository)

        XCTAssertEqual(store.collectionOutcome, .loaded)
        XCTAssertEqual(store.cards.map(\.identity), [
            .run(fixture.runID),
            .run(olderRunID),
        ])
        XCTAssertEqual(repository.requestedPages.map(\.cursor), [nil, "stable-page-2"])
    }

    func testUnavailableCollectionOffersTryAgainAndNeverClaimsEmptyOrSavedTruth() async throws {
        let fixture = TrophyWallTestFixture()
        let store = fixture.makeStore(cards: [])
        let repository = ScriptedTrophyWallRunHistoryRepository(
            results: [
                .failure(RunAPIError.unavailable),
                .failure(URLError(.notConnectedToInternet)),
                .page(
                    try fixture.historyPage(
                        status: .queued,
                        stage: .queued,
                        terminalOutcome: nil
                    )
                ),
            ]
        )
        let expectedMessage = TrophyWallProcessingView.CollectionMessage(
            heading: "Processing unavailable",
            action: .tryAgain(label: "Try again"),
            scoutImageName: "ScoutRetryReview",
            scoutAccessibilityLabel: "Scout, the SnapList camera helper"
        )

        await store.refreshCollection(using: repository)

        XCTAssertEqual(store.collectionOutcome, .unavailable)
        let unavailable = TrophyWallProcessingView.presentation(
            from: store.processingRows,
            collectionOutcome: store.collectionOutcome,
            refreshRecovery: store.collectionRefreshRecovery,
            availableHeight: 844,
            isExpanded: false
        )
        XCTAssertEqual(unavailable.collectionMessage, expectedMessage)
        XCTAssertNil(unavailable.offlineNotice)

        await store.refreshCollection(using: repository)

        XCTAssertEqual(store.collectionOutcome, .offline)
        let offlineWithoutCache = TrophyWallProcessingView.presentation(
            from: store.processingRows,
            collectionOutcome: store.collectionOutcome,
            refreshRecovery: store.collectionRefreshRecovery,
            availableHeight: 844,
            isExpanded: false
        )
        XCTAssertEqual(offlineWithoutCache.collectionMessage, expectedMessage)
        XCTAssertNil(
            offlineWithoutCache.offlineNotice,
            "Offline without saved items must not claim it is showing saved items."
        )

        await store.refreshCollection(using: repository)

        XCTAssertEqual(store.collectionOutcome, .loaded)
        XCTAssertEqual(store.cards.map(\.identity), [.run(fixture.runID)])
        let recovered = TrophyWallProcessingView.presentation(
            from: store.processingRows,
            collectionOutcome: store.collectionOutcome,
            refreshRecovery: store.collectionRefreshRecovery,
            availableHeight: 844,
            isExpanded: false
        )
        XCTAssertNil(recovered.collectionMessage)
        XCTAssertNil(recovered.offlineNotice)
        XCTAssertEqual(recovered.visibleRows.map(\.stateLabel), ["Accepted"])
        XCTAssertEqual(repository.requestedPages.count, 3)
    }

    func testOnlyGenuineReachabilityFailuresMayClaimTheSellerIsOffline() async {
        let fixture = TrophyWallTestFixture()
        let cases: [(code: URLError.Code, outcome: TrophyWallCollectionOutcome)] = [
            (.notConnectedToInternet, .offline),
            (.networkConnectionLost, .offline),
            (.dataNotAllowed, .offline),
            (.timedOut, .unavailable),
            (.badServerResponse, .unavailable),
            (.secureConnectionFailed, .unavailable),
            (.cannotFindHost, .unavailable),
        ]

        for testCase in cases {
            let store = fixture.makeStore(cards: fixture.processingInitialCards)
            let repository = ScriptedTrophyWallRunHistoryRepository(
                results: [.failure(URLError(testCase.code))]
            )

            await store.refreshCollection(using: repository)

            XCTAssertEqual(
                store.collectionOutcome,
                testCase.outcome,
                "URLError.\(testCase.code) must not be described as \(store.collectionOutcome)."
            )
        }
    }

    func testOverlappingCollectionRefreshCannotDowngradeNewerServerTruth() async {
        let fixture = TrophyWallTestFixture()
        let store = fixture.makeStore(cards: [])
        let repository = GatedTrophyWallRunHistoryRepository()

        async let inFlight = store.refreshCollection(using: repository)
        await repository.entered.wait()
        await store.refreshCollection(using: repository)

        XCTAssertEqual(repository.requestCount, 1)
        XCTAssertEqual(store.collectionOutcome, .unknown)

        await repository.release.open()
        _ = await inFlight

        XCTAssertEqual(store.collectionOutcome, .loaded)
        XCTAssertEqual(repository.requestCount, 1)
    }

    func testPrincipalTransitionClearsSavedCardsAndFencesAnOlderRefresh() async {
        let fixture = TrophyWallTestFixture()
        let store = fixture.makeStore(cards: fixture.processingInitialCards)
        let repository = GatedTrophyWallRunHistoryRepository()

        async let departingRefresh = store.refreshCollection(using: repository)
        await repository.entered.wait()
        store.resetForPrincipalTransition()
        await repository.release.open()
        _ = await departingRefresh

        XCTAssertTrue(store.cards.isEmpty)
        XCTAssertEqual(store.collectionOutcome, .unknown)
        XCTAssertTrue(store.processingRows.isEmpty)
        XCTAssertTrue(store.settledTiles.isEmpty)
    }

    func testPendingCardRecoveryDropsAResultFromADepartedPrincipal() async {
        let fixture = TrophyWallTestFixture()
        let entered = RefreshGate()
        let release = RefreshGate()
        var currentScope = fixture.principal

        let recovery = Task { @MainActor in
            await TrophyWallPendingCardRecovery.resolve(
                scopedTo: fixture.principal,
                currentScope: { currentScope }
            ) {
                await entered.open()
                await release.wait()
                return fixture.initialCards[0]
            }
        }

        await entered.wait()
        currentScope = fixture.otherPrincipal
        await release.open()

        let result = await recovery.value
        XCTAssertEqual(result, .stalePrincipal)
    }

    func testCollectionRefreshTaskRerunsForPrincipalTransitionAndWallTryAgain()
        async throws {
        let fixture = TrophyWallTestFixture()
        let store = fixture.makeStore(cards: [])
        let repository = ScriptedTrophyWallRunHistoryRepository(
            results: [.failure(RunAPIError.unavailable)]
        )
        let driver = TrophyWallRefreshTestDriver()
        let root = TrophyWallFeatureTestRoot(
            driver: driver,
            router: AppRouter(initialTab: .trophyWall),
            store: store,
            repository: repository
        )
        let host = HostedTrophyWallTestWindow(
            rootView: root,
            size: CGSize(width: 390, height: 844)
        )
        defer { host.close() }

        await host.settle()
        await waitForTrophyWallCondition {
            repository.requestedPages.count == 1
                && store.collectionOutcome == .unavailable
        }
        let initialTaskID = driver.refreshState.taskID(tab: .trophyWall)

        XCTAssertFalse(driver.refreshState.observePrincipal(nil))
        let signedIn = try XCTUnwrap(
            ItemRunSubmissionPrincipalScopeProof(
                verifiedClerkSubject: "new-principal"
            )
        )
        XCTAssertTrue(driver.refreshState.observePrincipal(signedIn))
        let principalTaskID = driver.refreshState.taskID(tab: .trophyWall)
        XCTAssertNotEqual(principalTaskID, initialTaskID)

        await host.settle()
        await waitForTrophyWallCondition {
            repository.requestedPages.count == 2
        }

        let renderedWall = try XCTUnwrap(
            Mirror(reflecting: root.feature.body).children
                .first(where: { $0.label == "content" })?.value
                as? TrophyWallView
        )
        renderedWall.onTryAgain()
        let retryTaskID = driver.refreshState.taskID(tab: .trophyWall)
        XCTAssertNotEqual(retryTaskID, principalTaskID)

        await host.settle()
        await waitForTrophyWallCondition {
            repository.requestedPages.count == 3
        }
    }

    /// A local pending card only means something while the intake that produced it
    /// is still staged. Nothing used to withdraw one, so a discarded or replaced
    /// intake left a card on the wall that routed to the wrong item, or to nothing.
    @MainActor
    func testWithdrawingLocalPendingCardsKeepsOnlyTheStillRecoverableIntake() {
        let fixture = TrophyWallTestFixture()
        let cases: [(name: String, kept: TrophyWallLogicalIdentity?, expected: [TrophyWallCardIdentity])] = [
            (
                "one intake is still recoverable",
                fixture.unrelatedLogicalID,
                [
                    .local(fixture.unrelatedLogicalID),
                    .run(fixture.thirdRunID),
                    .run(fixture.hiddenRunID),
                ]
            ),
            (
                "no intake is recoverable any more",
                nil,
                [.run(fixture.thirdRunID), .run(fixture.hiddenRunID)]
            ),
        ]

        for testCase in cases {
            let store = fixture.makeStore(cards: fixture.processingInitialCards)

            store.withdrawLocalPendingCards(keeping: testCase.kept)

            XCTAssertEqual(
                Set(store.cards.map(\.identity)),
                Set(testCase.expected),
                testCase.name
            )
            XCTAssertEqual(
                store.cards.count,
                testCase.expected.count,
                testCase.name
            )
        }
    }

    /// Trophy Wall is the seller's one return destination, so a failed collection
    /// refresh may not leave it a blank canvas. It reuses the same offline notice
    /// and recovery group the pushed Processing screen already ships.
    func testWallRendersItsOwnOfflineAndUnavailableGroupInsteadOfABlankCanvas()
        async {
        let unavailable = TrophyWallProcessingView.unavailableCollectionMessage
        let offlineNotice = TrophyWallProcessingView.offlineNoticeText
        let cases: [(
            name: String,
            hasSettledTiles: Bool,
            outcome: TrophyWallCollectionOutcome,
            expected: TrophyWallView.Presentation
        )] = [
            (
                "nothing proved yet claims nothing",
                false,
                .unknown,
                .init(
                    showsGrid: false,
                    showsEmptyView: false,
                    offlineNotice: nil,
                    refreshUnavailableNotice: nil,
                    collectionMessage: nil
                )
            ),
            (
                "proved empty earns the empty screen",
                false,
                .loaded,
                .init(
                    showsGrid: false,
                    showsEmptyView: true,
                    offlineNotice: nil,
                    refreshUnavailableNotice: nil,
                    collectionMessage: nil
                )
            ),
            (
                "offline without saved tiles offers recovery",
                false,
                .offline,
                .init(
                    showsGrid: false,
                    showsEmptyView: false,
                    offlineNotice: nil,
                    refreshUnavailableNotice: nil,
                    collectionMessage: unavailable
                )
            ),
            (
                "unavailable without saved tiles offers recovery",
                false,
                .unavailable,
                .init(
                    showsGrid: false,
                    showsEmptyView: false,
                    offlineNotice: nil,
                    refreshUnavailableNotice: nil,
                    collectionMessage: unavailable
                )
            ),
            (
                "offline with saved tiles keeps them and says so",
                true,
                .offline,
                .init(
                    showsGrid: true,
                    showsEmptyView: false,
                    offlineNotice: offlineNotice,
                    refreshUnavailableNotice: nil,
                    collectionMessage: nil
                )
            ),
            (
                "unavailable with saved tiles keeps them without a false claim",
                true,
                .unavailable,
                .init(
                    showsGrid: true,
                    showsEmptyView: false,
                    offlineNotice: nil,
                    refreshUnavailableNotice: nil,
                    collectionMessage: nil
                )
            ),
            (
                "loaded with saved tiles is the plain grid",
                true,
                .loaded,
                .init(
                    showsGrid: true,
                    showsEmptyView: false,
                    offlineNotice: nil,
                    refreshUnavailableNotice: nil,
                    collectionMessage: nil
                )
            ),
        ]

        for testCase in cases {
            XCTAssertEqual(
                TrophyWallView.presentation(
                    hasSettledTiles: testCase.hasSettledTiles,
                    collectionOutcome: testCase.outcome,
                    refreshRecovery: .idle
                ),
                testCase.expected,
                testCase.name
            )
        }

        let renderCases: [(name: String, error: any Error)] = [
            ("offline", URLError(.notConnectedToInternet)),
            ("unavailable", RunAPIError.unavailable),
        ]
        for renderCase in renderCases {
            let store = TrophyWallTestFixture().makeStore(cards: [])
            let repository = ScriptedTrophyWallRunHistoryRepository(
                results: [.failure(renderCase.error)]
            )
            await store.refreshCollection(using: repository)
            let host = HostedTrophyWallTestWindow(
                rootView: TrophyWallView(
                    store: store,
                    openProcessing: {},
                    openAccount: {},
                    onScan: {},
                    onTryAgain: {}
                ),
                size: CGSize(width: 390, height: 844)
            )
            await host.settle()
            let image = host.captureImage()
            host.close()

            XCTAssertGreaterThan(
                image.opaqueDarkPixelCount(
                    in: CGRect(x: 0, y: 100, width: 390, height: 640)
                ),
                100,
                "The actual Wall must render its \(renderCase.name) recovery group."
            )
        }

        // The static seam above is satisfied by any caller that supplies the
        // recovery argument, including a Wall body that never reads it from the
        // store. Only the rendered Wall proves the notice actually ships.
        let fixture = TrophyWallTestFixture()
        let settledStore = fixture.makeStore(
            cards: [
                .accepted(
                    principalScope: fixture.principal,
                    runID: fixture.runID,
                    state: .publishedToEbay,
                    itemName: fixture.matchedItemName,
                    lastMeaningfulUpdateAt: fixture.acceptedUpdate
                )
            ]
        )
        let exhausting = ScriptedTrophyWallRunHistoryRepository(
            results: [.failure(RunAPIError.unavailable)]
        )
        await settledStore.recoverCollection(using: exhausting) { _ in }
        XCTAssertEqual(settledStore.collectionRefreshRecovery, .exhausted)
        XCTAssertFalse(settledStore.settledTiles.isEmpty)

        let exhaustedWall = TrophyWallView(
            store: settledStore,
            openProcessing: {},
            openAccount: {},
            onScan: {},
            onTryAgain: {}
        )
        let exhaustedHost = HostedTrophyWallTestWindow(
            rootView: exhaustedWall,
            size: CGSize(width: 390, height: 844)
        )
        await exhaustedHost.settle()
        let exhaustedImage = exhaustedHost.captureImage()
        exhaustedHost.close()

        XCTAssertGreaterThan(
            exhaustedImage.opaqueDarkPixelCount(
                in: CGRect(x: 0, y: 100, width: 390, height: 640)
            ),
            100,
            "The actual Wall must still render its saved tiles under the notice."
        )

        // The rendered tree is what the Wall's own body produced from the store,
        // so an omitted `refreshRecovery` argument leaves the strip out of it
        // entirely — which is exactly the defect the static seam could not see.
        var renderedWall = ""
        dump(exhaustedWall.body, to: &renderedWall)
        XCTAssertTrue(
            renderedWall.contains(
                TrophyWallProcessingView.refreshUnavailableNoticeIdentifier
            ),
            """
            The Wall must render its refresh-unavailable strip once the store \
            reports recovery exhausted.
            """
        )
    }

    func testCollectionMessageContainsItsActionAccessibilityElements() {
        let cases: [(
            name: String,
            message: TrophyWallProcessingView.CollectionMessage,
            actionIdentifier: String
        )] = [
            (
                "proved empty",
                .init(
                    heading: "Nothing is processing.",
                    action: .scan(label: "Scan an item"),
                    scoutImageName: "ScoutUncertain",
                    scoutAccessibilityLabel: "Scout"
                ),
                "trophy.processing.collection.scan"
            ),
            (
                "failed collection",
                TrophyWallProcessingView.unavailableCollectionMessage,
                "trophy.processing.collection.try-again"
            ),
        ]

        for testCase in cases {
            let view = TrophyWallCollectionMessageView(
                message: testCase.message,
                onScan: {},
                onTryAgain: {}
            )
            var renderedStructure = ""
            dump(view.body, to: &renderedStructure)

            XCTAssertTrue(
                renderedStructure.contains(
                    "AccessibilityChildBehavior.Contain"
                ),
                "The collection must contain descendants: \(testCase.name)"
            )
            XCTAssertTrue(
                renderedStructure.contains(testCase.actionIdentifier),
                "The contained action must keep its identifier: \(testCase.name)"
            )
        }
    }

    func testCollectionStatesRenderTheirApprovedGroupAtBothDynamicTypeRoots() async {
        let fixture = TrophyWallTestFixture()
        let savedRows = fixture.makeStore(cards: fixture.processingInitialCards)
            .processingRows
        let cases: [(name: String, rows: [TrophyWallProcessingRow], outcome: TrophyWallCollectionOutcome)] = [
            ("PROC offline with saved items", savedRows, .offline),
            ("PROC empty after proved collection", [], .loaded),
            ("PROC unavailable without cached truth", [], .unavailable),
        ]
        let roots: [(label: String, size: CGSize, dynamicTypeSize: DynamicTypeSize)] = [
            ("standard", CGSize(width: 390, height: 844), .large),
            ("accessibility", CGSize(width: 375, height: 667), .accessibility2),
        ]

        for testCase in cases {
            for root in roots {
                var openedRoutes: [HomeRoute] = []
                let image = await captureHostedTrophyWallProcessingView(
                    rows: testCase.rows,
                    collectionOutcome: testCase.outcome,
                    size: root.size,
                    dynamicTypeSize: root.dynamicTypeSize,
                    openRoute: { openedRoutes.append($0) }
                )

                XCTAssertEqual(image.size, root.size)
                XCTAssertTrue(openedRoutes.isEmpty, "\(testCase.name) must not route on render.")
                XCTAssertGreaterThan(
                    image.opaqueDarkPixelCount(
                        in: CGRect(
                            x: 0,
                            y: 80,
                            width: image.size.width,
                            height: root.size.height - 80
                        )
                    ),
                    100,
                    "\(testCase.name) at \(root.label) type must draw its approved group."
                )

                let attachment = XCTAttachment(image: image)
                attachment.name = "\(testCase.name) · \(root.label)"
                attachment.lifetime = .keepAlways
                add(attachment)
            }
        }
    }

    private func assertLockedCanonicalProjection(
        _ scenario: TrophyWallLockedProjectionScenario
    ) throws {
        let fixture = TrophyWallTestFixture()
        let page: TrophyWallRunHistoryPage
        let expectedStateLabel: String
        let expectedAccessibilityLabel: String
        let inconsistentCases: [(name: String, page: TrophyWallRunHistoryPage)]

        switch scenario {
        case .readyToReview:
            page = try fixture.historyPage(
                listingID: fixture.listingID,
                status: .succeeded,
                stage: .completed,
                terminalOutcome: .succeeded
            )
            expectedStateLabel = "Ready to review"
            expectedAccessibilityLabel =
                "\(fixture.matchedItemName), ready to review. Review is not available yet."
            let outcomes: [(String, RunTerminalOutcome?)] = [
                ("missing terminal outcome", nil),
                ("failed terminal outcome", .failed),
                ("canceled terminal outcome", .canceled),
            ]
            inconsistentCases = try outcomes.map { name, outcome in
                (
                    name,
                    try fixture.historyPage(
                        listingID: fixture.listingID,
                        status: .succeeded,
                        stage: .completed,
                        terminalOutcome: outcome
                    )
                )
            }
        case .needsRetry:
            page = try fixture.historyPage(
                status: .failed,
                stage: .pricing,
                terminalOutcome: .failed,
                retryTruth: (canRetry: true, workPreserved: true),
                canStartNewCapture: true
            )
            expectedStateLabel = "Needs retry · Upload didn't finish."
            expectedAccessibilityLabel =
                "\(fixture.matchedItemName), needs retry. Upload didn't finish."
            inconsistentCases = [
                (
                    "nonretryable failure",
                    try fixture.historyPage(
                        status: .failed,
                        stage: .pricing,
                        terminalOutcome: .failed,
                        retryTruth: (canRetry: false, workPreserved: true)
                    )
                ),
                (
                    "work not preserved",
                    try fixture.historyPage(
                        status: .failed,
                        stage: .pricing,
                        terminalOutcome: .failed,
                        retryTruth: (canRetry: true, workPreserved: false)
                    )
                ),
                (
                    "inconsistent terminal outcome",
                    try fixture.historyPage(
                        status: .failed,
                        stage: .pricing,
                        terminalOutcome: .canceled,
                        retryTruth: (canRetry: true, workPreserved: true)
                    )
                ),
            ]
        }

        let store = fixture.makeStore()
        store.ingest(historyPage: page, principalScope: fixture.principal)
        let firstCards = store.cards
        let firstRows = store.processingRows
        store.ingest(historyPage: page, principalScope: fixture.principal)

        XCTAssertEqual(
            store.cards.map(\.identity),
            [.local(fixture.unrelatedLogicalID), .run(fixture.runID)]
        )
        XCTAssertEqual(
            store.cards.map(\.orderKey.lastMeaningfulUpdateAt),
            [fixture.unrelatedUpdate, fixture.runDetailUpdate]
        )
        XCTAssertEqual(
            store.processingRows.map(\.stateLabel),
            ["Pending upload", expectedStateLabel]
        )
        XCTAssertEqual(
            store.processingRows.map(\.accessibilityLabel),
            [
                "\(fixture.unrelatedItemName), pending upload. Local item, not sent yet.",
                expectedAccessibilityLabel,
            ]
        )
        XCTAssertEqual(
            store.processingRows.map(\.destination),
            [.localRecovery(fixture.unrelatedLogicalID), .run(fixture.runID)]
        )
        XCTAssertEqual(store.cards, firstCards)
        XCTAssertEqual(store.processingRows, firstRows)

        for testCase in inconsistentCases {
            let inconsistentStore = fixture.makeStore()
            let initialCards = inconsistentStore.cards
            inconsistentStore.ingest(
                historyPage: testCase.page,
                principalScope: fixture.principal
            )
            XCTAssertEqual(inconsistentStore.cards, initialCards, testCase.name)
        }
    }

    private func waitForTrophyWallCondition(
        _ predicate: @escaping @MainActor () -> Bool,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        for _ in 0..<200 where !predicate() {
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        XCTAssertTrue(predicate(), file: file, line: line)
    }
}

@MainActor
@Observable
private final class TrophyWallRefreshTestDriver {
    var refreshState = TrophyWallCollectionRefreshState()
}

@MainActor
private struct TrophyWallFeatureTestRoot: View {
    @Bindable var driver: TrophyWallRefreshTestDriver
    @Bindable var router: AppRouter
    @Bindable var store: TrophyWallStore
    let repository: any TrophyWallRunHistoryRepository

    var feature: TrophyWallFeatureView {
        TrophyWallFeatureView(
            router: router,
            store: store,
            repository: repository,
            refreshState: $driver.refreshState
        )
    }

    var body: some View {
        feature
    }
}

@MainActor
private final class HostedTrophyWallTestWindow {
    private let hostingController: UIHostingController<AnyView>
    private let window: UIWindow
    private let size: CGSize

    init<Content: View>(rootView: Content, size: CGSize) {
        self.size = size
        hostingController = UIHostingController(
            rootView: AnyView(rootView.background(Color.white))
        )
        window = UIWindow(frame: CGRect(origin: .zero, size: size))
        window.backgroundColor = .white
        window.isOpaque = true
        window.rootViewController = hostingController
        hostingController.loadViewIfNeeded()
        hostingController.view.frame = window.bounds
        hostingController.view.backgroundColor = .white
        hostingController.view.isOpaque = true
        window.makeKeyAndVisible()
    }

    func settle() async {
        for _ in 0..<3 {
            await Task.yield()
            window.setNeedsLayout()
            window.layoutIfNeeded()
            hostingController.view.setNeedsLayout()
            hostingController.view.layoutIfNeeded()
        }
        hostingController.view.setNeedsDisplay()
        hostingController.view.layer.displayIfNeeded()
    }

    func captureImage() -> UIImage {
        renderOpaqueRGBA8(view: hostingController.view, size: size)
    }

    func close() {
        window.isHidden = true
        withExtendedLifetime(window) {}
    }
}

@MainActor
private func captureHostedTrophyWallProcessingView(
    rows: [TrophyWallProcessingRow],
    collectionOutcome: TrophyWallCollectionOutcome = .unknown,
    size: CGSize,
    dynamicTypeSize: DynamicTypeSize,
    openRoute: @escaping (HomeRoute) -> Void
) async -> UIImage {
    let host = TrophyWallProcessingTestHost(
        rows: rows,
        collectionOutcome: collectionOutcome,
        size: size,
        dynamicTypeSize: dynamicTypeSize,
        openRoute: openRoute
    )
    await host.settle()
    let image = host.captureImage()
    host.close()
    return image
}

@MainActor
private final class TrophyWallProcessingTestHost {
    private let hostingController: UIHostingController<AnyView>
    private let window: UIWindow
    private let size: CGSize

    init(
        rows: [TrophyWallProcessingRow],
        collectionOutcome: TrophyWallCollectionOutcome,
        size: CGSize,
        dynamicTypeSize: DynamicTypeSize,
        openRoute: @escaping (HomeRoute) -> Void
    ) {
        self.size = size
        hostingController = UIHostingController(
            rootView: AnyView(
                TrophyWallProcessingView(
                    rows: rows,
                    collectionOutcome: collectionOutcome,
                    onBack: {},
                    openRoute: openRoute,
                    onScan: {},
                    onTryAgain: {}
                )
                .dynamicTypeSize(dynamicTypeSize)
                .background(Color.white)
            )
        )
        window = UIWindow(frame: CGRect(origin: .zero, size: size))
        window.backgroundColor = .white
        window.isOpaque = true
        window.rootViewController = hostingController
        hostingController.loadViewIfNeeded()
        hostingController.view.frame = window.bounds
        hostingController.view.backgroundColor = .white
        hostingController.view.isOpaque = true
        window.makeKeyAndVisible()
    }

    func settle() async {
        for _ in 0..<2 {
            await Task.yield()
            window.setNeedsLayout()
            window.layoutIfNeeded()
            hostingController.view.setNeedsLayout()
            hostingController.view.layoutIfNeeded()
        }
        hostingController.view.setNeedsDisplay()
        hostingController.view.layer.displayIfNeeded()
    }

    func captureImage() -> UIImage {
        renderOpaqueRGBA8(view: hostingController.view, size: size)
    }

    func close() {
        window.isHidden = true
        withExtendedLifetime(window) {}
    }
}

private func renderOpaqueRGBA8(view: UIView, size: CGSize) -> UIImage {
    let width = Int(size.width.rounded(.toNearestOrAwayFromZero))
    let height = Int(size.height.rounded(.toNearestOrAwayFromZero))
    let bytesPerRow = width * 4
    let bitmapInfo = CGBitmapInfo.byteOrder32Big.rawValue
        | CGImageAlphaInfo.premultipliedLast.rawValue
    guard let context = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: bytesPerRow,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: bitmapInfo
    ) else {
        preconditionFailure("Unable to create an RGBA8 Trophy Wall render context.")
    }

    context.setFillColor(UIColor.white.cgColor)
    context.fill(CGRect(origin: .zero, size: size))
    context.translateBy(x: 0, y: CGFloat(height))
    context.scaleBy(x: 1, y: -1)
    view.layer.render(in: context)

    guard let image = context.makeImage() else {
        preconditionFailure("Unable to make the Trophy Wall render image.")
    }
    return UIImage(cgImage: image, scale: 1, orientation: .up)
}

private extension UIImage {
    func opaqueDarkPixelCount(in pointRect: CGRect) -> Int {
        guard let cgImage else {
            return 0
        }

        let bytesPerPixel = 4
        let bytesPerRow = cgImage.width * bytesPerPixel
        let bitmapInfo = CGBitmapInfo.byteOrder32Big.rawValue
            | CGImageAlphaInfo.premultipliedLast.rawValue
        var pixels = [UInt8](repeating: 0, count: bytesPerRow * cgImage.height)
        let minX = max(0, Int(pointRect.minX * scale))
        let maxX = min(cgImage.width, Int(pointRect.maxX * scale))
        let minY = max(0, Int(pointRect.minY * scale))
        let maxY = min(cgImage.height, Int(pointRect.maxY * scale))

        return pixels.withUnsafeMutableBytes { buffer in
            guard let context = CGContext(
                data: buffer.baseAddress,
                width: cgImage.width,
                height: cgImage.height,
                bitsPerComponent: 8,
                bytesPerRow: bytesPerRow,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: bitmapInfo
            ) else {
                return 0
            }
            context.translateBy(x: 0, y: CGFloat(cgImage.height))
            context.scaleBy(x: 1, y: -1)
            context.draw(
                cgImage,
                in: CGRect(
                    x: 0,
                    y: 0,
                    width: CGFloat(cgImage.width),
                    height: CGFloat(cgImage.height)
                )
            )

            var count = 0
            for y in minY..<maxY {
                for x in minX..<maxX {
                    let bufferY = cgImage.height - 1 - y
                    let offset = bufferY * bytesPerRow + x * bytesPerPixel
                    let red = buffer[offset]
                    let green = buffer[offset + 1]
                    let blue = buffer[offset + 2]
                    let alpha = buffer[offset + 3]
                    if alpha > 200, red < 180, green < 180, blue < 180 {
                        count += 1
                    }
                }
            }
            return count
        }
    }
}

private struct TrophyWallConvergenceCase {
    let name: String
    let acceptedRun: TrophyWallCanonicalAcceptedRun
    let expectedCards: [TrophyWallCard]
}

private struct TrophyWallRunDetailConvergenceCase {
    let name: String
    let principalScope: TrophyWallPrincipalScope
    let runDetail: DurableRun
    let expectedCards: [TrophyWallCard]
    let expectedDestinations: [HomeRoute?]
}

private struct TrophyWallWorkingStageCase {
    let name: String
    let stage: DurableRunStage
    let stateLabel: String
    let accessibilityFact: String
}

private enum TrophyWallLockedProjectionScenario {
    case readyToReview
    case needsRetry
}

private struct TrophyWallTestFixture {
    let principal = TrophyWallPrincipalScope(opaqueValue: "principal-a")
    let otherPrincipal = TrophyWallPrincipalScope(opaqueValue: "principal-b")
    let idempotencyKey = UUID(uuidString: "37500000-0000-4000-8000-000000000001")!
    let unrelatedLogicalID = TrophyWallLogicalIdentity(
        idempotencyKey: UUID(uuidString: "37500000-0000-4000-8000-000000000002")!
    )
    let runID = UUID(uuidString: "37500000-0000-4000-8000-000000000003")!
    let thirdRunID = UUID(uuidString: "37500000-0000-4000-8000-000000000004")!
    let hiddenRunID = UUID(uuidString: "37500000-0000-4000-8000-000000000005")!
    let hiddenLogicalID = TrophyWallLogicalIdentity(
        idempotencyKey: UUID(uuidString: "37500000-0000-4000-8000-000000000006")!
    )
    let matchedItemName = "Vintage Pyrex bowl set"
    let unrelatedItemName = "Nintendo Game Boy"
    let pendingUpdate = Date(timeIntervalSince1970: 20)
    let unrelatedUpdate = Date(timeIntervalSince1970: 10)
    let acceptedUpdate = Date(timeIntervalSince1970: 30)
    let runDetailUpdate = Date(timeIntervalSince1970: 5)
    let itemID = UUID(uuidString: "37500000-0000-4000-8000-000000000007")!
    let otherItemID = UUID(uuidString: "37500000-0000-4000-8000-000000000008")!
    let listingID = UUID(uuidString: "37500000-0000-4000-8000-000000000009")!

    var logicalID: TrophyWallLogicalIdentity {
        TrophyWallLogicalIdentity(idempotencyKey: idempotencyKey)
    }

    var acceptedHandoff: AcceptedItemRunHandoff {
        AcceptedItemRunHandoff(
            idempotencyKey: idempotencyKey,
            acceptedRun: AcceptedItemRun(
                runID: runID,
                itemID: itemID,
                status: "queued",
                stage: "queued"
            )
        )
    }

    var workingStageCases: [TrophyWallWorkingStageCase] {
        [
            .init(name: "identifying", stage: .identifying, stateLabel: "Identifying", accessibilityFact: "identifying"),
            .init(name: "pricing", stage: .pricing, stateLabel: "Pricing", accessibilityFact: "pricing"),
            .init(name: "generating", stage: .generating, stateLabel: "Writing listing",
                  accessibilityFact: "writing listing"),
            .init(name: "persisting", stage: .persisting, stateLabel: "Saving", accessibilityFact: "saving"),
        ]
    }

    var initialCards: [TrophyWallCard] {
        [
            .pending(
                principalScope: principal,
                logicalIdentity: logicalID,
                itemName: matchedItemName,
                lastMeaningfulUpdateAt: pendingUpdate
            ),
            .pending(
                principalScope: principal,
                logicalIdentity: unrelatedLogicalID,
                itemName: unrelatedItemName,
                lastMeaningfulUpdateAt: unrelatedUpdate
            ),
        ]
    }

    var processingInitialCards: [TrophyWallCard] {
        initialCards + [
            .accepted(
                principalScope: principal,
                runID: thirdRunID,
                itemName: "Canon AE-1 film camera",
                lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 9)
            ),
            .accepted(
                principalScope: principal,
                runID: hiddenRunID,
                itemName: "Hidden accepted row",
                lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 8)
            ),
            .pending(
                principalScope: principal,
                logicalIdentity: hiddenLogicalID,
                itemName: "Hidden pending row",
                lastMeaningfulUpdateAt: Date(timeIntervalSince1970: 7)
            ),
        ]
    }

    @MainActor
    func makeStore(cards: [TrophyWallCard]? = nil) -> TrophyWallStore {
        TrophyWallStore(
            principalScope: principal,
            repository: StaticTrophyWallRepository(cards: cards ?? initialCards)
        )
    }

    func historyPage(
        listingID: UUID? = nil,
        status: DurableRunStatus,
        stage: DurableRunStage,
        terminalOutcome: RunTerminalOutcome?,
        retryTruth: (canRetry: Bool, workPreserved: Bool)? = nil,
        canStartNewCapture: Bool = false,
        historyOrderAt: Date? = nil,
        lastMeaningfulUpdateAt: String = "1970-01-01T00:00:05.000Z",
        retentionCleanedAt: String? = nil,
        deliveryState: String? = nil
    ) throws -> TrophyWallRunHistoryPage {
        let run = try decodedRunDetail(
            runID: runID,
            itemID: itemID,
            listingID: listingID,
            status: status,
            stage: stage,
            terminalOutcome: terminalOutcome,
            retryTruth: retryTruth,
            canStartNewCapture: canStartNewCapture,
            lastMeaningfulUpdateAt: lastMeaningfulUpdateAt,
            retentionCleanedAt: retentionCleanedAt,
            deliveryState: deliveryState
        )
        return TrophyWallRunHistoryPage(
            entries: [
                TrophyWallRunHistoryEntry(
                    logicalIdentity: logicalID,
                    orderKey: TrophyWallOrderKey(
                        lastMeaningfulUpdateAt: historyOrderAt ?? runDetailUpdate,
                        stableIdentity: run.id.uuidString.lowercased()
                    ),
                    run: run
                ),
            ],
            nextCursor: nil
        )
    }

    func decodedRunDetail(
        runID: UUID,
        itemID: UUID,
        listingID: UUID? = nil,
        status: DurableRunStatus = .queued,
        stage: DurableRunStage = .queued,
        terminalOutcome: RunTerminalOutcome? = nil,
        retryTruth: (canRetry: Bool, workPreserved: Bool)? = nil,
        canStartNewCapture: Bool = false,
        canOpenReview: Bool = false,
        lastMeaningfulUpdateAt: String = "1970-01-01T00:00:05.000Z",
        retentionCleanedAt: String? = nil,
        deliveryState: String? = nil
    ) throws -> DurableRun {
        let listingIDJSON = listingID.map { "\"\($0.uuidString.lowercased())\"" } ?? "null"
        let terminalOutcomeJSON = terminalOutcome.map { "\"\($0.rawValue)\"" } ?? "null"
        let retentionCleanedAtJSON =
            retentionCleanedAt.map { "\"\($0)\"" } ?? "null"
        let canRetry = retryTruth?.canRetry ?? false
        let safeFailureJSON = retryTruth.map {
            return """
            {"reason":"This run couldn’t finish","detail":"Upload didn't finish.",\
            "retryable":\(canRetry),"workPreserved":\($0.workPreserved)}
            """
        } ?? "null"
        let deliveryJSON = deliveryState.map {
            ",\n          \"delivery\": { \"state\": \"\($0)\" }"
        } ?? ""
        let json = """
        {
          "id": "\(runID.uuidString.lowercased())",
          "itemId": "\(itemID.uuidString.lowercased())",
          "listingId": \(listingIDJSON),
          "status": "\(status.rawValue)",
          "stage": "\(stage.rawValue)",
          "attemptCount": 0,
          "maxAttempts": 3,
          "schemaVersion": 1,
          "timestamps": {
            "createdAt": "1970-01-01T00:00:01.000Z",
            "updatedAt": "1970-01-01T00:00:05.000Z",
            "enqueuedAt": "1970-01-01T00:00:02.000Z",
            "startedAt": null,
            "lastAttemptedAt": null,
            "nextAttemptAt": null,
            "completedAt": null,
            "retentionCleanedAt": \(retentionCleanedAtJSON)
          },
          "item": { "title": "Server canonical title", "photoCount": 3 },
          "requiredInput": null,
          "terminalOutcome": \(terminalOutcomeJSON),
          "safeFailure": \(safeFailureJSON),
          "allowance": "reserved",
          "legalActions": {
            "canRetry": \(canRetry),
            "canCancel": false,
            "canOpenReview": \(canOpenReview),
            "canStartNewCapture": \(canStartNewCapture)
          }\(deliveryJSON),
          "lastMeaningfulUpdateAt": "\(lastMeaningfulUpdateAt)",
          "retentionCleanedAt": \(retentionCleanedAtJSON)
        }
        """
        return try JSONDecoder().decode(DurableRun.self, from: Data(json.utf8))
    }
}

private final class ScriptedTrophyWallRunHistoryRepository:
    TrophyWallRunHistoryRepository, @unchecked Sendable {
    enum Result {
        case page(TrophyWallRunHistoryPage)
        case failure(any Error)
    }

    struct Request: Equatable {
        let limit: Int
        let cursor: String?
    }

    private let lock = NSLock()
    private let results: [Result]
    private var deliveredCount = 0
    private var recordedRequests: [Request] = []

    init(results: [Result]) {
        precondition(!results.isEmpty)
        self.results = results
    }

    var requestedPages: [Request] {
        lock.withLock { recordedRequests }
    }

    func fetchPage(limit: Int, cursor: String?) async throws -> TrophyWallRunHistoryPage {
        let result: Result = lock.withLock {
            recordedRequests.append(Request(limit: limit, cursor: cursor))
            let next = results[min(deliveredCount, results.count - 1)]
            deliveredCount += 1
            return next
        }

        switch result {
        case .page(let page):
            return page
        case .failure(let error):
            throw error
        }
    }
}

/// A one-way latch two tasks can rendezvous on, so an overlapping-refresh test
/// proves ordering instead of racing on `Task.yield()`.
private actor RefreshGate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func open() {
        guard !isOpen else { return }
        isOpen = true
        let resumable = waiters
        waiters.removeAll()
        for waiter in resumable { waiter.resume() }
    }

    func wait() async {
        guard !isOpen else { return }
        await withCheckedContinuation { waiters.append($0) }
    }
}

private final class GatedTrophyWallRunHistoryRepository:
    TrophyWallRunHistoryRepository, @unchecked Sendable {
    let entered = RefreshGate()
    let release = RefreshGate()

    private let lock = NSLock()
    private var count = 0

    var requestCount: Int {
        lock.withLock { count }
    }

    func fetchPage(limit: Int, cursor: String?) async throws -> TrophyWallRunHistoryPage {
        lock.withLock { count += 1 }
        await entered.open()
        await release.wait()
        return TrophyWallRunHistoryPage(entries: [], nextCursor: nil)
    }
}

private struct StaticTrophyWallRepository: TrophyWallRepository {
    let cards: [TrophyWallCard]

    func initialCards(for principalScope: TrophyWallPrincipalScope) -> [TrophyWallCard] {
        cards.filter { $0.principalScope == principalScope }
    }
}
