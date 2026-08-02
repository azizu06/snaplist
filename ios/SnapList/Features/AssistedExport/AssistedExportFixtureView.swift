#if DEBUG
import SwiftUI
import UIKit

/// DEBUG-only host for the assisted-export screen (issue #581).
///
/// It exists for one behavior a unit test cannot observe: the confirm sheet
/// coming down when the listing moves under it. That requires a real presented
/// sheet and a real SwiftUI dismissal, so it requires a running app.
///
/// The pack replacement is driven by the sheet's own appearance rather than by a
/// wall clock, so the sequence is deterministic. The sheet is provably on
/// screen before the listing moves, and a test that never saw the sheet cannot
/// pass by finding it absent.
///
/// The scenarios themselves live on `AssistedExportFixture` in
/// `LaunchConfiguration.swift`, so parsing a launch argument does not depend on
/// a DEBUG-only type.
struct AssistedExportFixtureView: View {
    let fixture: AssistedExportFixture

    private static let itemID = UUID(
        uuidString: "58100000-0000-4000-8000-000000000001"
    )!
    private static let contentRevision = UUID(
        uuidString: "58100000-0000-4000-8000-0000000000c0"
    )!
    private static let reviewRevision = UUID(
        uuidString: "58100000-0000-4000-8000-0000000000a0"
    )!
    static let editedReviewRevision = UUID(
        uuidString: "58100000-0000-4000-8000-0000000000a1"
    )!
    private static let rebuiltContentRevision = UUID(
        uuidString: "58100000-0000-4000-8000-0000000000c1"
    )!

    /// The listing revision the screen observes. It belongs to the host rather
    /// than to the screen because in the product it belongs to the item.
    @State private var listingRevision: UUID
    /// Set once the confirm sheet has actually been on screen, and never
    /// cleared. A test cannot poll for a sheet that is dismissed in the same
    /// breath it appears, so the proof that it was presented has to outlive it.
    @State private var sheetWasPresented = false
    @State private var store: AssistedExportStore
    @State private var recorder: AssistedExportFixtureRecorder

    init(fixture: AssistedExportFixture) {
        self.fixture = fixture
        let pack = Self.makePack(
            contentRevision: Self.contentRevision,
            reviewRevision: Self.reviewRevision
        )
        let recorder = AssistedExportFixtureRecorder()
        let receipts: [AssistedExportReceipt]
        if fixture == .honestWording {
            let handoff = Date(timeIntervalSince1970: 1_753_464_600)
            receipts = [
                AssistedExportReceipt(
                    destination: .facebookMarketplace,
                    handedOffAt: handoff,
                    sharedAt: handoff
                ),
                AssistedExportReceipt(
                    destination: .mercari,
                    handedOffAt: handoff,
                    sharedAt: nil
                ),
            ]
        } else {
            receipts = []
        }
        _recorder = State(initialValue: recorder)
        _store = State(
            initialValue: AssistedExportStore(
                pack: pack,
                service: AssistedExportFixtureService(
                    receipts: receipts,
                    didPerform: { action in
                        await recorder.record(action)
                    }
                )
            )
        )
        _listingRevision = State(
            initialValue: fixture == .packOutOfDate
                ? Self.editedReviewRevision
                : Self.reviewRevision
        )
    }

    var body: some View {
        NavigationStack {
            AssistedExportView(
                store: store,
                summary: AssistedExportItemSummary(
                    title: "Denim jacket, relaxed fit, size L",
                    priceText: "$58",
                    preparedAtText: "2:41 PM"
                ),
                listingRevision: listingRevision,
                deviceActions: fixtureDeviceActions,
                onUpdatePack: preparePackForCurrentListing,
                onConfirmSheetPresented: confirmSheetPresented
            )
        }
        .overlay(alignment: .topLeading) {
            if sheetWasPresented {
                Color.clear
                    .frame(width: 2, height: 2)
                    .accessibilityElement()
                    .accessibilityLabel("Confirm sheet was presented")
                    .accessibilityIdentifier(
                        "assisted-export.fixture.sheet-was-presented"
                    )
            }
            fixtureCounter(
                recorder.photoWriteCount,
                identifier: "assisted-export.fixture.photo-write-count"
            )
            fixtureCounter(
                recorder.handoffWriteCount,
                identifier: "assisted-export.fixture.handoff-write-count"
            )
        }
    }

    /// Records the presentation always, and replaces the pack only for the one
    /// fixture that needs it, so the others cannot move by accident.
    /// Stands in for the host fetching a pack built at the current listing. The
    /// pack text is rebuilt, so this carries a new content revision too.
    private func preparePackForCurrentListing() {
        let replacement = AssistedExportPack(
            itemID: Self.itemID,
            contentRevision: Self.rebuiltContentRevision,
            reviewRevision: listingRevision,
            title: "Denim jacket, relaxed fit, size L",
            description: "A clean seller description.",
            photoReferences: Self.photoReferences
        )
        // This is deliberately the public replacement seam under test. Merely
        // changing an observed listing revision would dismiss the sheet too,
        // but would not prove the mandated `updatePack(to:)` behavior.
        Task { await store.updatePack(to: replacement) }
    }

    private func confirmSheetPresented() {
        sheetWasPresented = true
        guard fixture == .packUpdateWhileConfirming else { return }
        preparePackForCurrentListing()
    }

    private static func makePack(
        contentRevision: UUID,
        reviewRevision: UUID
    ) -> AssistedExportPack {
        AssistedExportPack(
            itemID: Self.itemID,
            contentRevision: contentRevision,
            reviewRevision: reviewRevision,
            title: "Denim jacket, relaxed fit, size L",
            description: "A clean seller description.",
            photoReferences: photoReferences
        )
    }

    private static let photoReferences = (1...8).map {
        URL(string: "https://cdn.example/fixture-\($0).jpg")!
    }

    private var fixtureDeviceActions: AssistedExportDeviceActions {
        AssistedExportDeviceActions(
            open: { _ in fixture != .destinationOpenFailure },
            copy: { _ in },
            loadPhotos: { references in references.map { _ in UIImage() } },
            savePhotos: { _ in
                recorder.photoWriteCount += 1
                if fixture == .saveDeduplication {
                    try await Task.sleep(for: .milliseconds(500))
                }
            }
        )
    }

    private func fixtureCounter(
        _ count: Int,
        identifier: String
    ) -> some View {
        Color.clear
            .frame(width: 2, height: 2)
            .accessibilityElement()
            .accessibilityLabel(String(count))
            .accessibilityIdentifier(identifier)
    }
}

@MainActor
@Observable
private final class AssistedExportFixtureRecorder {
    var photoWriteCount = 0
    private(set) var handoffWriteCount = 0

    func record(_ action: AssistedExportServerAction) {
        if action == .handoff { handoffWriteCount += 1 }
    }
}
#endif
