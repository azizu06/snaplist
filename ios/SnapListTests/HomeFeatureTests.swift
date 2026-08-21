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
        XCTAssertEqual(TrophyWallGridMetrics.bottomPaddingPoints, 132)

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

    func testApprovedEmptyWallKeepsTheLiveV32OpticalSpacing() {
        XCTAssertEqual(TrophyWallEmptyMetrics.contentSpacing, 20)
        XCTAssertEqual(TrophyWallEmptyMetrics.scoutHeight, 143)
        XCTAssertEqual(TrophyWallEmptyMetrics.scoutOpticalBottomInset, -10)
        XCTAssertEqual(TrophyWallEmptyMetrics.horizontalPadding, 34)
        XCTAssertEqual(TrophyWallEmptyMetrics.bottomPadding, 48)
    }

    func testApprovedSettledFixtureUsesSixDistinctClearedPhotoCompositions() {
        let photos = TrophyWallStoreFactory.fixturePhotoCompositions

        XCTAssertEqual(photos.count, 6)
        XCTAssertEqual(
            Set(photos.map { "\($0.assetName):\($0.crop.rawValue)" }).count,
            6
        )
        XCTAssertEqual(
            Set(photos.map(\.assetName)),
            ["FirstValueController", "FirstValueHeadphones", "FirstValueTradingCard"]
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
                expectedDestinations: [.localRecovery(fixture.unrelatedLogicalID), nil]
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
            [.localRecovery(fixture.unrelatedLogicalID), nil]
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
                [.localRecovery(fixture.unrelatedLogicalID), nil],
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
            XCTAssertEqual(
                canonicalRow?.activation,
                TrophyWallProcessingRowActivation.none,
                testCase.name
            )
            XCTAssertNil(canonicalRow?.destination, testCase.name)
        }
    }

    func testStoreProjectsSucceededRunWithoutReviewActionAsLockedReadyCard() throws {
        try assertLockedCanonicalProjection(.readyToReview)
    }

    /// This test used to be named
    /// `testReadyProcessingRowOffersReviewWithoutChangingExactRunDestination`
    /// and asserted the row body kept `.run(runID)`. That was the defect (#897):
    /// the pill reached Listing Review while the rest of the row pushed Run
    /// Detail, so the same ready item took one or two taps depending on where
    /// the seller's thumb landed. The row body now carries the review action
    /// itself, which is the exact route the pill already ran.
    func testReadyProcessingRowActivatesReviewWithoutPushingRunDetail() {
        let fixture = TrophyWallTestFixture()
        let store = fixture.makeStore()

        store.ingest(
            TrophyWallCanonicalAcceptedRun(
                principalScope: fixture.principal,
                runID: fixture.runID,
                linkedLogicalIdentity: fixture.logicalID,
                state: .readyToReview,
                lastMeaningfulUpdateAt: fixture.runDetailUpdate,
                itemName: fixture.matchedItemName
            )
        )

        let row = store.processingRows.last
        XCTAssertEqual(row?.activation, .action(.review(runID: fixture.runID)))
        XCTAssertNil(row?.destination)
        XCTAssertEqual(row?.action, .review(runID: fixture.runID))
    }

    /// #963 removed the run-status intermediate card, so a retryable failure
    /// row now acts inline: the row body retries the run directly rather than
    /// pushing anywhere.
    func testRetryableFailureProcessingRowActivatesRetryWithoutPushingRunDetail() throws {
        let fixture = TrophyWallTestFixture()
        let store = fixture.makeStore()

        store.ingest(
            historyPage: try fixture.historyPage(
                status: .failed,
                stage: .pricing,
                terminalOutcome: .failed,
                retryTruth: (canRetry: true, workPreserved: true)
            ),
            principalScope: fixture.principal
        )

        let row = store.processingRows.last
        XCTAssertEqual(row?.activation, .action(.retry(runID: fixture.runID)))
        XCTAssertNil(row?.destination)
        XCTAssertEqual(row?.action, .retry(runID: fixture.runID))
    }

    func testStoreProjectsFailedRunWithoutRetryClientAsLockedNeedsRetryCard() throws {
        try assertLockedCanonicalProjection(.needsRetry)
    }

    func testRetryingQueuedRunRemainsVisibleWithoutAnotherAction() throws {
        let fixture = TrophyWallTestFixture()
        let store = fixture.makeStore()

        store.ingest(
            historyPage: try fixture.historyPage(
                status: .retrying,
                stage: .queued,
                terminalOutcome: nil
            ),
            principalScope: fixture.principal
        )

        let row = store.processingRows.last
        XCTAssertEqual(row?.stateLabel, "Retrying")
        XCTAssertEqual(row?.accessibilityLabel, "\(fixture.matchedItemName), retrying.")
        XCTAssertEqual(row?.activation, TrophyWallProcessingRowActivation.none)
        XCTAssertNil(row?.destination)
        XCTAssertNil(row?.action)
    }

    func testNonretryableFailureProjectsOnlyServerAuthorizedRecovery() throws {
        let fixture = TrophyWallTestFixture()
        let scanStore = fixture.makeStore()
        scanStore.ingest(
            historyPage: try fixture.historyPage(
                status: .failed,
                stage: .pricing,
                terminalOutcome: .failed,
                retryTruth: (canRetry: false, workPreserved: true),
                canStartNewCapture: true
            ),
            principalScope: fixture.principal
        )

        let scanRow = scanStore.processingRows.last
        XCTAssertEqual(scanRow?.activation, .action(.scan(runID: fixture.runID)))
        XCTAssertNil(scanRow?.destination)
        XCTAssertEqual(scanRow?.action, .scan(runID: fixture.runID))
        XCTAssertEqual(
            scanRow?.accessibilityLabel,
            "\(fixture.matchedItemName), needs retry. Upload didn't finish."
        )

        let staticStore = fixture.makeStore()
        staticStore.ingest(
            historyPage: try fixture.historyPage(
                status: .failed,
                stage: .pricing,
                terminalOutcome: .failed,
                retryTruth: (canRetry: false, workPreserved: true)
            ),
            principalScope: fixture.principal
        )

        let staticRow = staticStore.processingRows.last
        XCTAssertEqual(
            staticRow?.activation,
            TrophyWallProcessingRowActivation.none
        )
        XCTAssertNil(staticRow?.destination)
        XCTAssertNil(staticRow?.action)
        XCTAssertEqual(staticRow?.stateLabel, "Upload didn't finish.")
        XCTAssertEqual(
            staticRow?.accessibilityLabel,
            "\(fixture.matchedItemName), not listed. Upload didn't finish."
        )
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
            [.localRecovery(fixture.unrelatedLogicalID), nil]
        )
        XCTAssertEqual(
            page.entries.first?.run.lastMeaningfulUpdateAt,
            "1970-01-01T00:00:50.000Z"
        )
    }

    func testProcessingProjectionPreservesExactMergeTruth() {
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
            [nil, .localRecovery(fixture.unrelatedLogicalID)]
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

    func testStoreKeepsSettledDeliveryWhenFailedRunIsRetentionCleaned() throws {
        let fixture = TrophyWallTestFixture()
        let store = fixture.makeStore()
        let historyPage = try fixture.historyPage(
            listingID: fixture.listingID,
            status: .failed,
            stage: .pricing,
            terminalOutcome: .failed,
            retryTruth: (canRetry: false, workPreserved: false),
            retentionCleanedAt: "1970-01-01T00:00:06.000Z",
            deliveryState: "published_to_ebay"
        )

        store.ingest(historyPage: historyPage, principalScope: fixture.principal)

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

    func testSettledTileWithBundledFixturePhotoDoesNotClaimPhotoUnavailable() {
        let historyOrderAt = Date(timeIntervalSince1970: 1_753_015_200)
        let tile = TrophyWallSettledTile(
            id: .run(UUID()),
            itemName: "DualSense controller",
            stateLabel: "Published to eBay",
            coverPhotoAssetName: "FirstValueController",
            historyOrderAt: historyOrderAt
        )
        let relevantDate = historyOrderAt.formatted(
            .dateTime.month(.wide).day()
        )

        XCTAssertEqual(
            tile.accessibilityLabel,
            "DualSense controller, Published to eBay, \(relevantDate). "
                + "Completed item in your collection."
        )
    }

    /// The wall's whole purpose is to lead back to the listing the seller's
    /// photos produced, so a settled tile has to name the run it opens. The grid
    /// #729 built passed the tile nothing but data (#866).
    func testSettledTileOpensItsOwnRunAndNamesThatDestination() {
        let runID = UUID(uuidString: "37500000-0000-4000-8000-000000000021")!
        let tile = TrophyWallSettledTile(
            id: .run(runID),
            itemName: "White leather sneaker",
            stateLabel: "Published to eBay",
            historyOrderAt: Date(timeIntervalSince1970: 1_753_015_200)
        )

        XCTAssertEqual(tile.runID, runID)
        XCTAssertEqual(
            tile.accessibilityIdentifier,
            "trophy.wall.tile.run.37500000-0000-4000-8000-000000000021"
        )
    }

    /// A tile with nothing behind it must stay a picture. A control that opens
    /// nothing is a worse lie than an image, and assistive technology would
    /// announce it as an action the seller cannot take.
    func testSettledTileWithoutARunOffersNoDestinationOrControlIdentity() {
        let tile = TrophyWallSettledTile(
            id: .local(
                TrophyWallLogicalIdentity(
                    idempotencyKey: UUID(
                        uuidString: "37500000-0000-4000-8000-000000000022"
                    )!
                )
            ),
            itemName: "White leather sneaker",
            stateLabel: "Published to eBay",
            historyOrderAt: Date(timeIntervalSince1970: 1_753_015_200)
        )

        XCTAssertNil(tile.runID)
        XCTAssertNil(tile.accessibilityIdentifier)
    }

    /// The seller's own photo is the only photo that exists while a run is still
    /// processing: the server hands the client no cover until delivery, which is
    /// terminal. So the bytes the pending intake staged have to survive the swap
    /// from the local card to the canonical accepted one.
    func testAcceptedRowCarriesTheStagedCoverPhotoForwardFromTheLocalCard() throws {
        let fixture = TrophyWallTestFixture()
        let stagedPhoto = TrophyWallTestFixture.stagedCoverPhotoData()
        let store = fixture.makeStore(cards: [
            .pending(
                principalScope: fixture.principal,
                logicalIdentity: fixture.logicalID,
                itemName: fixture.matchedItemName,
                localCoverPhotoData: stagedPhoto,
                lastMeaningfulUpdateAt: fixture.pendingUpdate
            ),
        ])

        store.ingest(
            TrophyWallCanonicalAcceptedRun(
                principalScope: fixture.principal,
                runID: fixture.runID,
                linkedLogicalIdentity: fixture.logicalID,
                state: .accepted,
                lastMeaningfulUpdateAt: fixture.acceptedUpdate
            )
        )

        let row = try XCTUnwrap(
            store.processingRows.first { $0.id == .run(fixture.runID) }
        )
        XCTAssertEqual(row.stateLabel, "Accepted")
        XCTAssertEqual(row.localCoverPhotoData, stagedPhoto)
        // The photo is decoration beside the row's own label, so wiring it may
        // not change one word the seller hears.
        XCTAssertEqual(
            row.accessibilityLabel,
            "\(fixture.matchedItemName), accepted."
        )
    }

    /// Analyzing is the state the seller actually watches, and it is reached by
    /// the same canonical card, so the carried photo has to survive every stage
    /// projection rather than only the first one.
    func testAnalyzingRowKeepsTheStagedCoverPhotoAcrossStageProjections() throws {
        let fixture = TrophyWallTestFixture()
        let stagedPhoto = TrophyWallTestFixture.stagedCoverPhotoData()
        let store = fixture.makeStore(cards: [
            .pending(
                principalScope: fixture.principal,
                logicalIdentity: fixture.logicalID,
                itemName: fixture.matchedItemName,
                localCoverPhotoData: stagedPhoto,
                lastMeaningfulUpdateAt: fixture.pendingUpdate
            ),
        ])

        store.ingest(
            TrophyWallCanonicalAcceptedRun(
                principalScope: fixture.principal,
                runID: fixture.runID,
                linkedLogicalIdentity: fixture.logicalID,
                state: .accepted,
                lastMeaningfulUpdateAt: fixture.acceptedUpdate
            )
        )
        store.ingest(
            TrophyWallCanonicalAcceptedRun(
                principalScope: fixture.principal,
                runID: fixture.runID,
                linkedLogicalIdentity: nil,
                state: .workingIdentifying,
                lastMeaningfulUpdateAt: fixture.acceptedUpdate
            )
        )

        let row = try XCTUnwrap(
            store.processingRows.first { $0.id == .run(fixture.runID) }
        )
        XCTAssertEqual(row.stateLabel, "Identifying")
        XCTAssertEqual(row.localCoverPhotoData, stagedPhoto)
    }

    /// A run the client only learns about from the server — a relaunch, another
    /// device — never had staged bytes on this phone. It has to render today's
    /// slot rather than an empty image well.
    ///
    /// The second half is the point. As written before #867 this test asserted
    /// only the nil, which is also exactly what the owner's failing device
    /// produced, so it was green while the defect shipped. The identical
    /// server-only projection is run twice — once against a store that never saw
    /// this device stage anything, once against a store that did — so a store
    /// that simply never carries a photo cannot pass it.
    func testServerOnlyRunClaimsNoPhotoWhileADeviceStagedRunKeepsIts() throws {
        let fixture = TrophyWallTestFixture()
        let serverOnly = fixture.makeStore(cards: [])
        let projection = TrophyWallCanonicalAcceptedRun(
            principalScope: fixture.principal,
            runID: fixture.runID,
            linkedLogicalIdentity: nil,
            state: .accepted,
            lastMeaningfulUpdateAt: fixture.acceptedUpdate,
            itemName: fixture.matchedItemName
        )

        serverOnly.ingest(projection)

        let serverOnlyRow = try XCTUnwrap(
            serverOnly.processingRows.first { $0.id == .run(fixture.runID) }
        )
        XCTAssertNil(serverOnlyRow.localCoverPhotoData)

        // Same run, same server-sourced projection, but this device staged the
        // photo. The nil above must be the absence of bytes, not the store
        // dropping them.
        let stagedPhoto = TrophyWallTestFixture.stagedCoverPhotoData()
        let staged = fixture.makeStore(cards: [])
        staged.ingest(
            TrophyWallCanonicalAcceptedRun(
                principalScope: fixture.principal,
                runID: fixture.runID,
                linkedLogicalIdentity: nil,
                state: .accepted,
                lastMeaningfulUpdateAt: fixture.acceptedUpdate,
                itemName: fixture.matchedItemName,
                localCoverPhotoData: stagedPhoto
            )
        )
        staged.ingest(projection)

        let stagedRow = try XCTUnwrap(
            staged.processingRows.first { $0.id == .run(fixture.runID) }
        )
        XCTAssertEqual(stagedRow.localCoverPhotoData, stagedPhoto)
    }

    /// Step 8 of #867's proved cause, at the store. Every wall refresh rebuilds
    /// the row from server history, and the server has no pre-delivery photo of
    /// this item to offer — by design, since the seller's capture never left the
    /// device. So the acceptance's bytes have to survive a full history fetch,
    /// not only the first projection after it.
    func testHistoryRefreshDoesNotBlankTheAcceptancesOwnPhoto() async throws {
        let fixture = TrophyWallTestFixture()
        let store = fixture.makeStore(cards: [])
        let stagedPhoto = TrophyWallTestFixture.stagedCoverPhotoData()

        store.ingest(
            TrophyWallCanonicalAcceptedRun(
                principalScope: fixture.principal,
                runID: fixture.runID,
                linkedLogicalIdentity: fixture.logicalID,
                state: .accepted,
                lastMeaningfulUpdateAt: fixture.acceptedUpdate,
                itemName: fixture.matchedItemName,
                localCoverPhotoData: stagedPhoto
            )
        )
        XCTAssertEqual(
            store.processingRows.first?.localCoverPhotoData,
            stagedPhoto
        )

        let repository = ScriptedTrophyWallRunHistoryRepository(
            results: [
                .page(
                    try fixture.historyPage(
                        status: .queued,
                        stage: .queued,
                        terminalOutcome: nil
                    )
                ),
            ]
        )
        await store.refreshCollection(using: repository)

        XCTAssertEqual(store.collectionOutcome, .loaded)
        let row = try XCTUnwrap(
            store.processingRows.first { $0.id == .run(fixture.runID) }
        )
        XCTAssertEqual(row.localCoverPhotoData, stagedPhoto)
    }

    func testProcessingRowSlotDrawsTheSellersOwnStagedPhoto() throws {
        let stagedPhoto = TrophyWallTestFixture.stagedCoverPhotoData()
        let row = try makeAcceptedProcessingRow(localCoverPhotoData: stagedPhoto)

        guard case .staged(let image) = TrophyWallProcessingRowPhoto
            .content(for: row) else {
            return XCTFail("Staged bytes must resolve to a drawable image.")
        }
        // The decoded pixels are the seller's own photo, not a tint or a symbol.
        XCTAssertEqual(image.size, CGSize(width: 12, height: 12))
    }

    /// Two ways the bytes are genuinely absent: a run this device never staged,
    /// and bytes that no longer decode. Both keep the slot the wall already
    /// draws instead of an empty image well.
    func testProcessingRowSlotKeepsTodaysPlaceholderWhenNoPhotoIsAvailable() throws {
        let absent = try makeAcceptedProcessingRow(localCoverPhotoData: nil)
        guard case .placeholder = TrophyWallProcessingRowPhoto
            .content(for: absent) else {
            return XCTFail("Absent bytes must keep the existing slot.")
        }

        let unreadable = try makeAcceptedProcessingRow(
            localCoverPhotoData: Data("not an image".utf8)
        )
        guard case .placeholder = TrophyWallProcessingRowPhoto
            .content(for: unreadable) else {
            return XCTFail("Undecodable bytes must keep the existing slot.")
        }
    }

    /// Everything above this asserts what the slot is told to draw. This asserts
    /// what it actually draws, by rendering the view and reading the pixel in
    /// the middle of the slot: the seller's own photo when there are bytes, and
    /// the same flat fill as before when there are not.
    func testProcessingRowSlotRendersThePhotoIntoItsUnchangedSquare() throws {
        let staged = try renderedSlot(
            localCoverPhotoData: TrophyWallTestFixture.stagedCoverPhotoData()
        )
        let placeholder = try renderedSlot(localCoverPhotoData: nil)

        // The slot the photo draws into is the one the row already laid out.
        for rendered in [staged, placeholder] {
            XCTAssertEqual(
                rendered.size,
                CGSize(
                    width: TrophyWallProcessingPhotoMetrics.sidePoints,
                    height: TrophyWallProcessingPhotoMetrics.sidePoints
                )
            )
        }

        // A 10pt radius on a 44pt square leaves the very corner outside the
        // shape, so a photo that ignored the clip would paint it opaque.
        for rendered in [staged, placeholder] {
            XCTAssertEqual(try pixel(of: rendered, x: 0, y: 0).alpha, 0)
        }

        let stagedCenter = try pixel(of: staged, x: nil, y: nil)
        let placeholderCenter = try pixel(of: placeholder, x: nil, y: nil)
        // The fixture photo is systemTeal, so the drawn pixel is blue-green and
        // clearly not the neutral hairline the empty slot fills with.
        XCTAssertGreaterThan(stagedCenter.blue, stagedCenter.red)
        XCTAssertGreaterThan(stagedCenter.green, stagedCenter.red)
        XCTAssertGreaterThan(
            Int(stagedCenter.blue) - Int(stagedCenter.red),
            40
        )
        XCTAssertLessThanOrEqual(
            Int(placeholderCenter.blue) - Int(placeholderCenter.red),
            40
        )
    }

    @MainActor
    private func renderedSlot(localCoverPhotoData: Data?) throws -> UIImage {
        let row = try makeAcceptedProcessingRow(
            localCoverPhotoData: localCoverPhotoData
        )
        let renderer = ImageRenderer(
            content: TrophyWallProcessingRowPhoto(row: row)
        )
        renderer.scale = 1
        return try XCTUnwrap(renderer.uiImage)
    }

    /// One pixel of a rendered view. `nil` coordinates read the middle.
    private func pixel(
        of image: UIImage,
        x: Int?,
        y: Int?
    ) throws -> (red: UInt8, green: UInt8, blue: UInt8, alpha: UInt8) {
        let source = try XCTUnwrap(image.cgImage)
        let center = try XCTUnwrap(
            source.cropping(
                to: CGRect(
                    x: x ?? source.width / 2,
                    y: y ?? source.height / 2,
                    width: 1,
                    height: 1
                )
            )
        )
        var pixel = [UInt8](repeating: 0, count: 4)
        let context = try XCTUnwrap(
            CGContext(
                data: &pixel,
                width: 1,
                height: 1,
                bitsPerComponent: 8,
                bytesPerRow: 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            )
        )
        context.draw(center, in: CGRect(x: 0, y: 0, width: 1, height: 1))
        return (pixel[0], pixel[1], pixel[2], pixel[3])
    }

    /// No fixture route reached an accepted or analyzing row carrying a photo,
    /// which is why the missing thumbnail survived every existing test.
    func testProcessingLaunchFixtureSeedsAnAcceptedRowTheSuiteCanSee() throws {
        let rows = TrophyWallProcessingLaunchFixture.store.processingRows
        let acceptedIndex = try XCTUnwrap(
            rows.firstIndex { $0.stateLabel == "Accepted" }
        )

        guard case .staged = TrophyWallProcessingRowPhoto
            .content(for: rows[acceptedIndex]) else {
            return XCTFail("The seeded accepted row must carry a photo.")
        }

        // The seeded row is the oldest, so it sits behind the disclosure and
        // leaves the three rows the UI suite reads before expanding untouched.
        XCTAssertEqual(acceptedIndex, rows.count - 1)
        XCTAssertGreaterThan(acceptedIndex, 2)

        // A sixth row moves the collapsed disclosure off its exact-count
        // wording. The UI suite asserts that string on this same fixture, so
        // pin it here where it can be checked without a device.
        let collapsed = TrophyWallProcessingView.presentation(
            from: rows,
            refreshRecovery: .idle,
            availableHeight: 844,
            isExpanded: false
        )
        XCTAssertEqual(collapsed.disclosureAccessibilityLabel, "Show more items")
        XCTAssertEqual(collapsed.visibleRows.count, 3)
    }

    private func makeAcceptedProcessingRow(
        localCoverPhotoData: Data?
    ) throws -> TrophyWallProcessingRow {
        let fixture = TrophyWallTestFixture()
        let store = fixture.makeStore(cards: [
            .pending(
                principalScope: fixture.principal,
                logicalIdentity: fixture.logicalID,
                itemName: fixture.matchedItemName,
                localCoverPhotoData: localCoverPhotoData,
                lastMeaningfulUpdateAt: fixture.pendingUpdate
            ),
        ])
        store.ingest(
            TrophyWallCanonicalAcceptedRun(
                principalScope: fixture.principal,
                runID: fixture.runID,
                linkedLogicalIdentity: fixture.logicalID,
                state: .accepted,
                lastMeaningfulUpdateAt: fixture.acceptedUpdate
            )
        )
        return try XCTUnwrap(
            store.processingRows.first { $0.id == .run(fixture.runID) }
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

    /// A settled tile already carried `historyOrderAt`, but it only ever
    /// reached the accessibility label, so a seller looking at the wall could
    /// not see when anything went up (#897). The visible caption is drawn from
    /// that same date. Nothing new is invented and nothing new is fetched.
    func testSettledTileShowsTheSameDateItsAccessibilityLabelAlreadySpoke() {
        let runID = UUID(uuidString: "5A100000-0000-4000-8000-000000000001")!
        let published = Date(timeIntervalSince1970: 1_755_000_000)
        let tile = TrophyWallSettledTile(
            id: .run(runID),
            itemName: "White leather sneaker",
            stateLabel: "Published to eBay",
            historyOrderAt: published
        )

        let calendar = Calendar.current
        XCTAssertTrue(
            tile.publishedDateLabel.contains(
                "\(calendar.component(.day, from: published))"
            ),
            tile.publishedDateLabel
        )
        // The spoken label has never named a year, so the caption beside the
        // photo does not start naming one either.
        XCTAssertFalse(
            tile.publishedDateLabel.contains(
                "\(calendar.component(.year, from: published))"
            ),
            tile.publishedDateLabel
        )

        let older = TrophyWallSettledTile(
            id: .run(runID),
            itemName: "White leather sneaker",
            stateLabel: "Published to eBay",
            historyOrderAt: published.addingTimeInterval(-60 * 60 * 24 * 40)
        )
        XCTAssertNotEqual(tile.publishedDateLabel, older.publishedDateLabel)
    }

    /// Nothing on Processing re-read the server on its own initiative, so a
    /// seller watching an item finish had no way to ask (#897). The refresh is
    /// something the seller asks for: it reports while it works, and a second
    /// ask during that window does not become a second round trip.
    @MainActor
    func testProcessingRefreshRunsOneRequestPerAskAndReportsWhileItWorks() async {
        let host = TrophyWallProcessingRefreshHost()
        var requestCount = 0
        var stateDuringRequest: TrophyWallProcessingRefreshState?

        XCTAssertEqual(host.state, .idle)

        await host.refresh {
            requestCount += 1
            stateDuringRequest = host.state
            // The seller taps again while the first ask is still in flight.
            await host.refresh { requestCount += 1 }
        }

        XCTAssertEqual(requestCount, 1)
        XCTAssertEqual(stateDuringRequest, .refreshing)
        XCTAssertEqual(host.state, .idle)
    }

    /// The name and the action shared one horizontal line at every type size,
    /// separated only by the row's own trailing padding. At an accessibility
    /// size the pill takes most of the row, so the name column collapsed until
    /// a single word broke across two lines against the pill (#897). Past that
    /// point the action belongs under the name, where the name has the full
    /// row width to wrap into.
    func testProcessingRowMovesItsActionUnderTheNameOnlyAtAccessibilityType() {
        for size in [DynamicTypeSize.xSmall, .large, .xxxLarge] {
            XCTAssertEqual(
                TrophyWallProcessingRowMetrics.layout(for: size),
                .sideBySide,
                "\(size)"
            )
        }

        for size in [DynamicTypeSize.accessibility1, .accessibility5] {
            XCTAssertEqual(
                TrophyWallProcessingRowMetrics.layout(for: size),
                .actionBelowName,
                "\(size)"
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
            [nil, .localRecovery(fixture.unrelatedLogicalID), nil]
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
            [nil, .localRecovery(fixture.unrelatedLogicalID)]
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

    /// #844, acceptance criterion 3, the half that lives in memory rather than
    /// on disk.
    ///
    /// Trophy Wall cards are never written to disk — they come from a live
    /// history fetch or from an in-session `ingest`. So what has to hold after a
    /// sign-out is that the principal the shell fences on actually changes when
    /// the session ends. `TrophyWallPrincipalFence` and
    /// `resetForPrincipalTransition` already existed; what nothing asserted is
    /// that a sign-out is a transition at all. A member's proof is a digest over
    /// their Clerk subject and a guest's is a digest over the App Attest key, so
    /// the two can never collide, and the fence therefore fires.
    func testSignOutIsAPrincipalTransitionSoAMembersCardsCannotSurviveIt() throws {
        let fixture = TrophyWallTestFixture()
        let store = fixture.makeStore(cards: fixture.processingInitialCards)
        // Positive control: the member's wall is genuinely populated first, so
        // the emptiness below cannot be the fixture never having any cards.
        XCTAssertFalse(store.cards.isEmpty)

        // Distinct activations as well as distinct proofs, because that is what
        // `NativeIntake.reconcileIdentity` does when the resolved scope changes
        // — proved end to end in
        // `ItemRunSubmissionTests`.`testSigningOutIsStillAPrincipalTransitionThatClearsTheWall`.
        let member = TrophyWallPrincipalIdentity(
            activationID: UUID(
                uuidString: "84400000-0000-4000-8000-000000000011"
            )!,
            scopeProof: try XCTUnwrap(
                ItemRunSubmissionPrincipalScopeProof(
                    verifiedClerkSubject: "user_2signed_in_member"
                )
            )
        )
        let guestAfterSignOut = TrophyWallPrincipalIdentity(
            activationID: UUID(
                uuidString: "84400000-0000-4000-8000-000000000012"
            )!,
            scopeProof: try XCTUnwrap(
                ItemRunSubmissionPrincipalScopeProof(
                    verifiedAppAttestKeyID: "app-attest-key-id-after-sign-out"
                )
            )
        )
        XCTAssertNotEqual(member.scopeProof, guestAfterSignOut.scopeProof)
        XCTAssertNotEqual(member.activationID, guestAfterSignOut.activationID)

        var refreshState = TrophyWallCollectionRefreshState()
        // A cold launch observing the member for the first time is not a
        // transition, and neither is observing them again. Only the sign-out
        // is, which is what makes the `true` below discriminating rather than
        // just "the second observation".
        XCTAssertFalse(refreshState.observePrincipal(member))
        XCTAssertFalse(refreshState.observePrincipal(member))
        XCTAssertTrue(refreshState.observePrincipal(guestAfterSignOut))

        store.resetForPrincipalTransition()

        XCTAssertTrue(store.cards.isEmpty)
        XCTAssertTrue(store.processingRows.isEmpty)
        XCTAssertTrue(store.settledTiles.isEmpty)
        XCTAssertEqual(store.collectionOutcome, .unknown)
    }

    /// #844, acceptance criterion 6. Sign-out removes this device's copies and
    /// nothing else, so the wall a returning member sees is rebuilt from the
    /// server's own history rather than from anything that had to survive on the
    /// device.
    func testSigningBackInRebuildsTheWallFromServerOwnedHistory() async throws {
        let fixture = TrophyWallTestFixture()
        let store = fixture.makeStore(cards: fixture.processingInitialCards)
        store.resetForPrincipalTransition()
        XCTAssertTrue(store.cards.isEmpty)

        let repository = ScriptedTrophyWallRunHistoryRepository(
            results: [
                .page(
                    try fixture.historyPage(
                        listingID: fixture.listingID,
                        status: .succeeded,
                        stage: .completed,
                        terminalOutcome: .succeeded
                    )
                ),
            ]
        )

        await store.refreshCollection(using: repository)

        XCTAssertEqual(store.collectionOutcome, .loaded)
        XCTAssertFalse(store.cards.isEmpty)
        XCTAssertEqual(repository.requestedPages.count, 1)
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

    /// #963 chained three more modifiers onto `TrophyWallFeatureView.body`
    /// (the two presentation-host `.navigationDestination`s and an
    /// `.onChange`) so settled tiles can open their own listing surface.
    /// The `content` label only reaches the modifier directly beneath the
    /// outermost one, so this walks every nesting level until it finds the
    /// unmodified view.
    private func findModifiedContent<T>(_ value: Any, as type: T.Type) -> T? {
        if let match = value as? T {
            return match
        }
        guard let contentChild = Mirror(reflecting: value).children
            .first(where: { $0.label == "content" }) else {
            return nil
        }
        return findModifiedContent(contentChild.value, as: type)
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
        let signedIn = TrophyWallPrincipalIdentity(
            activationID: UUID(
                uuidString: "84400000-0000-4000-8000-000000000013"
            )!,
            scopeProof: try XCTUnwrap(
                ItemRunSubmissionPrincipalScopeProof(
                    verifiedClerkSubject: "new-principal"
                )
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
            findModifiedContent(root.feature.body, as: TrophyWallView.self)
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
                    openListing: { _ in .presentedReview },
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
            openListing: { _ in .presentedReview },
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
            [.localRecovery(fixture.unrelatedLogicalID), nil]
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

/// This test root never opens a listing, so both services only need to
/// exist, not to answer with anything real.
private struct NoOpTrophyWallListingReviewService: ListingReviewServing {
    func save(
        runID: UUID,
        draft: ListingReviewDraft,
        expectedReviewRevision: UUID,
        idempotencyKey: UUID,
        bearerToken: String
    ) async throws -> ListingReviewSaveReceipt {
        throw ListingReviewClientError.unavailable
    }

    func fetchReview(
        runID: UUID,
        bearerToken: String
    ) async throws -> ListingReviewResult {
        throw ListingReviewClientError.unavailable
    }
}

private struct NoOpTrophyWallListingReviewDraftPersistence:
    ListingReviewDraftPersisting {
    func activate(
        _ token: ListingReviewDraftPersistenceToken,
        runID: UUID
    ) async -> Bool {
        true
    }

    func load(
        runID: UUID,
        token: ListingReviewDraftPersistenceToken
    ) async throws -> PersistedListingReviewDraft? {
        nil
    }

    func save(
        _ record: PersistedListingReviewDraft,
        runID: UUID,
        token: ListingReviewDraftPersistenceToken
    ) async throws -> Bool {
        true
    }

    func remove(
        runID: UUID,
        token: ListingReviewDraftPersistenceToken
    ) async throws -> Bool {
        true
    }
}

@MainActor
private struct TrophyWallFeatureTestRoot: View {
    @Bindable var driver: TrophyWallRefreshTestDriver
    @Bindable var router: AppRouter
    @Bindable var store: TrophyWallStore
    let repository: any TrophyWallRunHistoryRepository
    let runStore = RunDetailStore(
        service: UnavailableRunService(),
        tokenProvider: UnavailableBearerTokenProvider()
    )
    let listingReviewStore = ListingReviewStore(
        service: NoOpTrophyWallListingReviewService(),
        persistence: NoOpTrophyWallListingReviewDraftPersistence(),
        tokenProvider: UnavailableBearerTokenProvider()
    )

    var feature: TrophyWallFeatureView {
        TrophyWallFeatureView(
            router: router,
            store: store,
            repository: repository,
            refreshState: $driver.refreshState,
            runStore: runStore,
            listingReviewStore: listingReviewStore,
            correctionAvailable: false,
            forceReducedMotion: false,
            activationListingReviewOpened: {},
            activationListingReviewDismissed: {},
            activationGuestClaimPresentationChanged: { _ in },
            activationListingReviewInteraction: {}
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
                    onAction: { _ in .rejected },
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

/// #871. Everything here writes to a real directory and reads it back through a
/// second store, because the defect this covers is invisible to any test that
/// reuses one in-memory wall: the bytes were always there for the launch that
/// staged them, and never for the next one.
@MainActor
final class TrophyWallLocalCoverPhotoPersistenceTests: XCTestCase {
    /// Two principals, written the way the intake writes them: `v1-` and 64
    /// lowercase hex digits. Nothing here derives a digest from an identity —
    /// the digest is the intake's, and this asserts what the wall does with it.
    private let sellerScope = "v1-" + String(repeating: "a", count: 64)
    private let otherSellerScope = "v1-" + String(repeating: "b", count: 64)
    private let fileManager = FileManager.default
    private var applicationSupport = URL(fileURLWithPath: "/")

    override func setUpWithError() throws {
        try super.setUpWithError()
        applicationSupport = fileManager.temporaryDirectory
            .appendingPathComponent(
                "trophy-wall-covers-\(UUID().uuidString)",
                isDirectory: true
            )
        try fileManager.createDirectory(
            at: applicationSupport,
            withIntermediateDirectories: true
        )
    }

    override func tearDownWithError() throws {
        try? fileManager.removeItem(at: applicationSupport)
        try super.tearDownWithError()
    }

    /// The issue's seam. A wall that persisted nothing, and a wall that only
    /// remembers within one launch, both fail this: the second store is a
    /// different object over the same directory, seeded with no cards, exactly
    /// as release seeds it.
    func testTheSellersOwnProcessingPhotoSurvivesARelaunch() throws {
        let fixture = TrophyWallTestFixture()
        let stagedPhoto = TrophyWallTestFixture.stagedCoverPhotoData()

        let firstLaunch = persistStagedPhoto(
            stagedPhoto,
            fixture: fixture,
            scope: sellerScope
        )
        XCTAssertEqual(
            firstLaunch.processingRows
                .first { $0.id == .run(fixture.runID) }?
                .localCoverPhotoData,
            stagedPhoto,
            "The launch that staged the photo must still be the #867 behaviour."
        )

        let relaunch = fixture.makeStore(cards: [])
        relaunch.adoptLocalCoverPhotoStore(makeCoverPhotoStore(scope: sellerScope))
        // What a relaunch actually shows: the wall rebuilt from server history,
        // which has no photo of a run that has not been delivered yet.
        relaunch.ingest(serverProjection(fixture: fixture))

        let row = try XCTUnwrap(
            relaunch.processingRows.first { $0.id == .run(fixture.runID) }
        )
        XCTAssertEqual(row.itemName, fixture.matchedItemName)
        XCTAssertEqual(row.localCoverPhotoData, stagedPhoto)
    }

    /// The bytes are filed under the principal that staged them, so another
    /// principal's session finds nothing — while the seller's own session still
    /// finds it. Without the second half, a store that persists nothing at all
    /// would pass.
    func testOnePrincipalsBytesAreUnreadableFromAnotherPrincipalsSession() throws {
        let fixture = TrophyWallTestFixture()
        let stagedPhoto = TrophyWallTestFixture.stagedCoverPhotoData()
        persistStagedPhoto(stagedPhoto, fixture: fixture, scope: sellerScope)

        let otherSeller = fixture.makeStore(cards: [])
        otherSeller.adoptLocalCoverPhotoStore(
            makeCoverPhotoStore(scope: otherSellerScope)
        )
        otherSeller.ingest(serverProjection(fixture: fixture))

        let otherRow = try XCTUnwrap(
            otherSeller.processingRows.first { $0.id == .run(fixture.runID) }
        )
        XCTAssertNil(otherRow.localCoverPhotoData)
        XCTAssertTrue(
            makeCoverPhotoStore(scope: otherSellerScope).loadAll().isEmpty,
            "Reading another principal's directory would show the run here."
        )

        let sameSeller = fixture.makeStore(cards: [])
        sameSeller.adoptLocalCoverPhotoStore(makeCoverPhotoStore(scope: sellerScope))
        sameSeller.ingest(serverProjection(fixture: fixture))
        XCTAssertEqual(
            sameSeller.processingRows.first?.localCoverPhotoData,
            stagedPhoto,
            "The nil above must be the fence, not an empty store."
        )
    }

    /// A delivered run draws the server's cover photo, so the device's copy is
    /// one the wall will never read again. Asserted on disk rather than on the
    /// card, because a card that drops the bytes while the file stays is exactly
    /// the accumulation the issue rules out.
    func testTerminalDeliveryReleasesTheDeviceCopyOfThePhoto() throws {
        let fixture = TrophyWallTestFixture()
        let stagedPhoto = TrophyWallTestFixture.stagedCoverPhotoData()
        let store = persistStagedPhoto(stagedPhoto, fixture: fixture, scope: sellerScope)
        XCTAssertEqual(
            makeCoverPhotoStore(scope: sellerScope).loadAll()[fixture.runID],
            stagedPhoto
        )

        store.ingest(
            TrophyWallCanonicalAcceptedRun(
                principalScope: fixture.principal,
                runID: fixture.runID,
                linkedLogicalIdentity: nil,
                state: .exportPrepared,
                lastMeaningfulUpdateAt: fixture.acceptedUpdate,
                itemName: fixture.matchedItemName,
                coverPhotoURL: URL(string: "https://cdn.example.com/cover.jpg")
            )
        )

        XCTAssertTrue(store.processingRows.isEmpty)
        XCTAssertTrue(
            makeCoverPhotoStore(scope: sellerScope).loadAll().isEmpty,
            "A settled row must leave no copy behind on the device."
        )
    }

    /// The publish path settles a row without a history projection, and it is the
    /// one that already dropped the bytes in memory. The file has to go with them.
    func testConfirmedEbayPublicationReleasesTheDeviceCopyOfThePhoto() throws {
        let fixture = TrophyWallTestFixture()
        let stagedPhoto = TrophyWallTestFixture.stagedCoverPhotoData()
        let store = fixture.makeStore(cards: [])
        store.adoptLocalCoverPhotoStore(makeCoverPhotoStore(scope: sellerScope))
        store.ingest(
            TrophyWallCanonicalAcceptedRun(
                principalScope: fixture.principal,
                runID: fixture.runID,
                linkedLogicalIdentity: nil,
                state: .readyToReview,
                lastMeaningfulUpdateAt: fixture.acceptedUpdate,
                itemName: fixture.matchedItemName,
                listingID: fixture.listingID,
                localCoverPhotoData: stagedPhoto
            )
        )
        XCTAssertEqual(
            makeCoverPhotoStore(scope: sellerScope).loadAll()[fixture.runID],
            stagedPhoto
        )

        store.applyEbayPublishStatus(
            EbayPublishStatus(
                listingID: fixture.listingID,
                outcome: .published,
                ebayListingID: "123456789012",
                ebayOfferID: "offer-871",
                alreadyPublished: true
            )
        )

        XCTAssertTrue(
            makeCoverPhotoStore(scope: sellerScope).loadAll().isEmpty
        )
    }

    /// The item left the seller's collection, so the copy of their photo goes
    /// with it. This is the only per-item deletion the device can observe: the
    /// app has no delete-one-item surface, so the server retiring the run is the
    /// event that means the same thing.
    func testARetiredRunTakesTheDeviceCopyOfThePhotoWithIt() throws {
        let fixture = TrophyWallTestFixture()
        let stagedPhoto = TrophyWallTestFixture.stagedCoverPhotoData()
        let store = persistStagedPhoto(stagedPhoto, fixture: fixture, scope: sellerScope)

        store.ingest(
            historyPage: try fixture.historyPage(
                status: .failed,
                stage: .pricing,
                terminalOutcome: .failed,
                retryTruth: (canRetry: false, workPreserved: false),
                canStartNewCapture: true,
                historyOrderAt: Date(timeIntervalSince1970: 60),
                lastMeaningfulUpdateAt: "1970-01-01T00:01:00.000Z",
                retentionCleanedAt: "1970-01-01T00:01:00.000Z"
            ),
            principalScope: fixture.principal
        )

        XCTAssertTrue(store.processingRows.isEmpty)
        XCTAssertTrue(
            makeCoverPhotoStore(scope: sellerScope).loadAll().isEmpty,
            "A run the seller no longer has must not leave its photo behind."
        )
    }

    /// A guest's claim on this device expires on the intake's recovery window,
    /// and a photo that outlived the claim would be a copy nobody can claim.
    func testAPhotoIsGoneOnceTheRetentionWindowHasPassed() throws {
        let fixture = TrophyWallTestFixture()
        let stagedPhoto = TrophyWallTestFixture.stagedCoverPhotoData()
        let stagedAt = Date(timeIntervalSince1970: 1_000_000)
        let store = fixture.makeStore(cards: [])
        store.adoptLocalCoverPhotoStore(
            makeCoverPhotoStore(scope: sellerScope, now: { stagedAt })
        )
        store.ingestAcceptance(
            AcceptedItemRunHandoff(
                idempotencyKey: fixture.idempotencyKey,
                acceptedRun: fixture.acceptedHandoff.acceptedRun,
                localCoverPhotoData: stagedPhoto
            )
        )

        let window = FileTrophyWallLocalCoverPhotoStore.retentionWindow
        let justInside = makeCoverPhotoStore(
            scope: sellerScope,
            now: { stagedAt.addingTimeInterval(window - 1) }
        )
        XCTAssertEqual(justInside.loadAll()[fixture.runID], stagedPhoto)

        let expired = makeCoverPhotoStore(
            scope: sellerScope,
            now: { stagedAt.addingTimeInterval(window + 1) }
        )
        XCTAssertTrue(expired.loadAll().isEmpty)
        // Swept, not merely hidden. The reader is given a clock from before the
        // record expired, so it would happily return the photo if it were still
        // on disk — a reader past expiry would sweep it itself and pass either
        // way.
        XCTAssertTrue(
            makeCoverPhotoStore(
                scope: sellerScope,
                now: { stagedAt.addingTimeInterval(window - 1) }
            ).loadAll().isEmpty,
            "The expired read must have deleted the record, not just hidden it."
        )
    }

    /// Expiry is swept across every principal's directory, not only the one the
    /// device currently belongs to, so a guest's expired photo is removed even
    /// though the seller signed in afterwards. It is keyed on expiry rather than
    /// on foreignness on purpose: at launch, before Clerk answers, the signed-in
    /// seller's own directory looks foreign.
    func testAnExpiredPhotoIsSweptFromAPrincipalTheDeviceNoLongerBelongsTo() throws {
        let fixture = TrophyWallTestFixture()
        let stagedPhoto = TrophyWallTestFixture.stagedCoverPhotoData()
        let stagedAt = Date(timeIntervalSince1970: 1_000_000)
        let guestStore = fixture.makeStore(cards: [])
        guestStore.adoptLocalCoverPhotoStore(
            makeCoverPhotoStore(scope: otherSellerScope, now: { stagedAt })
        )
        guestStore.ingestAcceptance(
            AcceptedItemRunHandoff(
                idempotencyKey: fixture.idempotencyKey,
                acceptedRun: fixture.acceptedHandoff.acceptedRun,
                localCoverPhotoData: stagedPhoto
            )
        )

        let window = FileTrophyWallLocalCoverPhotoStore.retentionWindow
        _ = makeCoverPhotoStore(
            scope: sellerScope,
            now: { stagedAt.addingTimeInterval(window + 1) }
        ).loadAll()

        XCTAssertTrue(
            makeCoverPhotoStore(scope: otherSellerScope, now: { stagedAt })
                .loadAll()
                .isEmpty,
            "The expired record must be gone from disk, not just from the reader."
        )
    }

    /// A principal transition empties the wall and takes the durable store away
    /// with it, so nothing the departing seller's session does afterwards can be
    /// written into a directory it no longer belongs to.
    func testAPrincipalTransitionStopsTheWallWritingForTheDepartedSeller() throws {
        let fixture = TrophyWallTestFixture()
        let store = persistStagedPhoto(
            TrophyWallTestFixture.stagedCoverPhotoData(),
            fixture: fixture,
            scope: sellerScope
        )

        store.resetForPrincipalTransition()
        store.ingest(
            TrophyWallCanonicalAcceptedRun(
                principalScope: fixture.principal,
                runID: fixture.thirdRunID,
                linkedLogicalIdentity: nil,
                state: .accepted,
                lastMeaningfulUpdateAt: fixture.acceptedUpdate,
                itemName: fixture.unrelatedItemName,
                localCoverPhotoData: TrophyWallTestFixture.stagedCoverPhotoData(
                    sidePixels: 8
                )
            )
        )

        XCTAssertEqual(
            Set(makeCoverPhotoStore(scope: sellerScope).loadAll().keys),
            [fixture.runID],
            "Only what the seller's own session wrote may be in their directory."
        )
    }

    /// The honest empty case. A relaunch with nothing persisted still renders the
    /// slot the wall already draws, and claims no photo it does not have.
    func testARelaunchWithNoPersistedBytesRendersTodaysSlot() throws {
        let fixture = TrophyWallTestFixture()
        let store = fixture.makeStore(cards: [])
        store.adoptLocalCoverPhotoStore(makeCoverPhotoStore(scope: sellerScope))

        store.ingest(serverProjection(fixture: fixture))

        let row = try XCTUnwrap(
            store.processingRows.first { $0.id == .run(fixture.runID) }
        )
        XCTAssertNil(row.localCoverPhotoData)
        guard case .placeholder = TrophyWallProcessingRowPhoto.content(for: row) else {
            return XCTFail("An absent photo must keep the existing slot.")
        }
    }

    /// A launch that cannot name its principal — no signed-in seller and no
    /// device key — has no durable home, so it writes nothing rather than filing
    /// the seller's photo somewhere nobody can claim it.
    func testAnUnprovedPrincipalPersistsNothing() throws {
        let fixture = TrophyWallTestFixture()
        let store = makeWallCarryingTheStagedPhoto(
            TrophyWallTestFixture.stagedCoverPhotoData(),
            fixture: fixture,
            coverPhotos: TrophyWallLocalCoverPhotoStoreFactory.make(
                scopeDirectoryComponent: nil,
                applicationSupportDirectory: applicationSupport
            )
        )

        let coversRoot = applicationSupport
            .appendingPathComponent("SnapList", isDirectory: true)
            .appendingPathComponent(
                FileTrophyWallLocalCoverPhotoStore.rootDirectoryName,
                isDirectory: true
            )
        XCTAssertFalse(fileManager.fileExists(atPath: coversRoot.path))
        // The row itself is unaffected: this launch still shows the photo it is
        // holding, it simply has nowhere to write it down.
        XCTAssertNotNil(store.processingRows.first?.localCoverPhotoData)
    }

    /// An installation-scoped or ephemeral intake is not a principal, so it
    /// resolves to no durable home at all.
    func testOnlyAPrincipalScopedDirectoryComponentResolves() {
        XCTAssertNotNil(
            TrophyWallLocalCoverPhotoPrincipal(scopeDirectoryComponent: sellerScope)
        )
        for rejected in [
            "",
            "v1-",
            "v2-" + String(repeating: "a", count: 64),
            "v1-" + String(repeating: "A", count: 64),
            "v1-" + String(repeating: "a", count: 63),
            "v1-" + String(repeating: "z", count: 64),
            "../" + String(repeating: "a", count: 64),
        ] {
            XCTAssertNil(
                TrophyWallLocalCoverPhotoPrincipal(
                    scopeDirectoryComponent: rejected
                ),
                "\(rejected) is not a principal directory."
            )
        }
    }

    /// A write that did not happen must not be remembered as one. `persist`
    /// short-circuits on unchanged bytes, so a failure recorded as a success is
    /// never retried for the rest of the launch, and the wall believes it has a
    /// durable copy it does not have.
    func testAPhotoThatCouldNotBeWrittenIsRetriedRatherThanRememberedAsSaved() {
        let fixture = TrophyWallTestFixture()
        let stagedPhoto = TrophyWallTestFixture.stagedCoverPhotoData()
        let failing = FailingTrophyWallLocalCoverPhotoStore()

        let store = makeWallCarryingTheStagedPhoto(
            stagedPhoto,
            fixture: fixture,
            coverPhotos: failing
        )
        let attemptsAfterFirstCarry = failing.saveCount
        XCTAssertGreaterThan(attemptsAfterFirstCarry, 0)

        store.ingest(
            TrophyWallCanonicalAcceptedRun(
                principalScope: fixture.principal,
                runID: fixture.runID,
                linkedLogicalIdentity: nil,
                state: .workingIdentifying,
                lastMeaningfulUpdateAt: fixture.acceptedUpdate,
                itemName: fixture.matchedItemName
            )
        )

        XCTAssertGreaterThan(
            failing.saveCount,
            attemptsAfterFirstCarry,
            "A failed write must not be recorded as persisted, or it is never retried."
        )
    }

    // MARK: - Helpers

    private func makeCoverPhotoStore(
        scope: String,
        now: @escaping () -> Date = Date.init
    ) -> any TrophyWallLocalCoverPhotoStoring {
        TrophyWallLocalCoverPhotoStoreFactory.make(
            scopeDirectoryComponent: scope,
            applicationSupportDirectory: applicationSupport,
            now: now
        )
    }

    /// The server's own view of the run: named, ordered, and photoless, which is
    /// what every launch after the accepting one actually receives.
    private func serverProjection(
        fixture: TrophyWallTestFixture
    ) -> TrophyWallCanonicalAcceptedRun {
        TrophyWallCanonicalAcceptedRun(
            principalScope: fixture.principal,
            runID: fixture.runID,
            linkedLogicalIdentity: nil,
            state: .accepted,
            lastMeaningfulUpdateAt: fixture.acceptedUpdate,
            itemName: fixture.matchedItemName
        )
    }

    /// A wall in the state the seller is actually looking at, built the way the
    /// product builds it: their own pending card, then the acceptance that
    /// carries the photo off the device as the intake behind it is deleted.
    @discardableResult
    private func makeWallCarryingTheStagedPhoto(
        _ stagedPhoto: Data,
        fixture: TrophyWallTestFixture,
        coverPhotos: any TrophyWallLocalCoverPhotoStoring
    ) -> TrophyWallStore {
        let store = fixture.makeStore(cards: [
            .pending(
                principalScope: fixture.principal,
                logicalIdentity: fixture.logicalID,
                itemName: fixture.matchedItemName,
                localCoverPhotoData: stagedPhoto,
                lastMeaningfulUpdateAt: fixture.pendingUpdate
            ),
        ])
        store.adoptLocalCoverPhotoStore(coverPhotos)
        store.ingestAcceptance(
            AcceptedItemRunHandoff(
                idempotencyKey: fixture.idempotencyKey,
                acceptedRun: fixture.acceptedHandoff.acceptedRun,
                localCoverPhotoData: stagedPhoto
            )
        )
        return store
    }

    @discardableResult
    private func persistStagedPhoto(
        _ stagedPhoto: Data,
        fixture: TrophyWallTestFixture,
        scope: String
    ) -> TrophyWallStore {
        makeWallCarryingTheStagedPhoto(
            stagedPhoto,
            fixture: fixture,
            coverPhotos: makeCoverPhotoStore(scope: scope)
        )
    }
}

/// A store whose disk is never writable — a full volume, a directory the seller
/// cannot be given, a protected write behind a locked device.
private final class FailingTrophyWallLocalCoverPhotoStore:
    TrophyWallLocalCoverPhotoStoring {
    private(set) var saveCount = 0

    func loadAll() -> [UUID: Data] { [:] }

    func save(_ photoData: Data, forRun runID: UUID) -> Bool {
        saveCount += 1
        return false
    }

    func remove(forRun runID: UUID) {}
}

/// The wiring seam one layer above the store: which durable home the shell hands
/// the wall, and when it hands over a different one.
///
/// The defect this closes was never in the store. The shell read the principal
/// twice — once from the snapshot it was processing, and again from the intake
/// after an `await` — so a wall still holding one seller's cards could be handed
/// the arriving seller's store and write the departing seller's photo into it.
/// The decision now takes the snapshot's own scope and nothing else, so the two
/// reads cannot disagree because there is only one.
@MainActor
final class TrophyWallCoverPhotoAdoptionTests: XCTestCase {
    private let sellerScope = "v1-" + String(repeating: "a", count: 64)
    private let arrivingScope = "v1-" + String(repeating: "b", count: 64)

    func testTheScopeAdoptedIsTheOneTheSnapshotCarries() {
        var adoption = TrophyWallCoverPhotoAdoption()

        XCTAssertEqual(adoption.scopeToAdopt(for: sellerScope), .adopt(sellerScope))
    }

    func testOneScopeIsAdoptedOnceRatherThanOnEverySnapshot() {
        var adoption = TrophyWallCoverPhotoAdoption()
        _ = adoption.scopeToAdopt(for: sellerScope)

        XCTAssertEqual(adoption.scopeToAdopt(for: sellerScope), .keepCurrent)
    }

    func testAnArrivingPrincipalReplacesTheDepartingOne() {
        var adoption = TrophyWallCoverPhotoAdoption()
        _ = adoption.scopeToAdopt(for: sellerScope)

        XCTAssertEqual(
            adoption.scopeToAdopt(for: arrivingScope),
            .adopt(arrivingScope)
        )
    }

    /// The principal fence reverts the wall to the store that writes nothing, so
    /// the same scope has to be handed over again rather than treated as held.
    func testAPrincipalTransitionForcesReadoptionOfTheSameScope() {
        var adoption = TrophyWallCoverPhotoAdoption()
        _ = adoption.scopeToAdopt(for: sellerScope)

        adoption.principalDidTransition()

        XCTAssertEqual(adoption.scopeToAdopt(for: sellerScope), .adopt(sellerScope))
    }

    /// A launch that cannot name its principal is a decision, not the absence of
    /// one: the wall is handed the store that writes nothing, once.
    func testAnUnprovedPrincipalIsAdoptedAsNoDurableHome() {
        var adoption = TrophyWallCoverPhotoAdoption()

        XCTAssertEqual(adoption.scopeToAdopt(for: nil), .adopt(nil))
        XCTAssertEqual(adoption.scopeToAdopt(for: nil), .keepCurrent)
    }
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

    /// Stands in for the JPEG the capture draft store writes beside every staged
    /// photo. Scale is pinned so the decoded size is the pixel size on any host
    /// device, which is what the render assertions compare against.
    static func stagedCoverPhotoData(sidePixels: Int = 12) -> Data {
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let side = CGFloat(sidePixels)
        return UIGraphicsImageRenderer(
            size: CGSize(width: side, height: side),
            format: format
        ).jpegData(withCompressionQuality: 0.84) { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(x: 0, y: 0, width: side, height: side))
        }
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
