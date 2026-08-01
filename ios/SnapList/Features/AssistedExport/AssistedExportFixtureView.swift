#if DEBUG
import SwiftUI

/// DEBUG-only host for the assisted-export screen (issue #581).
///
/// It exists for one behavior a unit test cannot observe: the confirm sheet
/// coming down when the listing moves under it. That requires a real presented
/// sheet and a real SwiftUI dismissal, so it requires a running app.
///
/// The revision change is driven by the sheet's own appearance rather than by a
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

    /// The listing revision the screen observes. It belongs to the host rather
    /// than to the screen because in the product it belongs to the item.
    @State private var listingRevision: UUID
    /// Set once the confirm sheet has actually been on screen, and never
    /// cleared. A test cannot poll for a sheet that is dismissed in the same
    /// breath it appears, so the proof that it was presented has to outlive it.
    @State private var sheetWasPresented = false

    init(fixture: AssistedExportFixture) {
        self.fixture = fixture
        _listingRevision = State(
            initialValue: fixture == .packOutOfDate
                ? Self.editedReviewRevision
                : Self.reviewRevision
        )
    }

    var body: some View {
        NavigationStack {
            AssistedExportView(
                domain: domain,
                summary: AssistedExportItemSummary(
                    title: "Denim jacket, relaxed fit, size L",
                    priceText: "$58",
                    preparedAtText: "2:41 PM"
                ),
                listingRevision: listingRevision,
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
        }
    }

    /// Records the presentation always, and moves the listing only for the one
    /// fixture that needs it, so the other two cannot go stale by accident.
    private func confirmSheetPresented() {
        sheetWasPresented = true
        guard fixture == .revisionChangeWhileConfirming else { return }
        listingRevision = Self.editedReviewRevision
    }

    private var domain: AssistedExportDomain {
        let pack = AssistedExportPack(
            itemID: Self.itemID,
            contentRevision: Self.contentRevision,
            reviewRevision: Self.reviewRevision,
            photoCount: 8
        )
        var domain = AssistedExportDomain(pack: pack)
        if fixture == .packOutOfDate {
            domain.listingRevisionChanged(to: Self.editedReviewRevision)
        }
        return domain
    }
}
#endif
