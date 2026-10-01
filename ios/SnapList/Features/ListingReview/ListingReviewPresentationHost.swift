import Observation

@MainActor
@Observable
final class ListingReviewPresentationHost {
    var isPresented = false
    private(set) var isOpening = false
    private(set) var openFailed = false

    @discardableResult
    func open(
        _ requested: ListingReviewResult,
        expecting binding: ListingReviewBinding,
        using store: ListingReviewStore
    ) async -> Bool {
        guard !isOpening, requested.binding == binding else { return false }
        isOpening = true
        openFailed = false
        defer { isOpening = false }

        guard await store.open(requested),
              let snapshot = store.snapshot,
              store.draft != nil,
              snapshot.binding == binding else {
            failClosed()
            return false
        }

        isPresented = true
        return true
    }

    func dismiss() {
        isPresented = false
    }

    /// "Go to Flips" from inside review (eBay publish's result screen, say).
    /// The review is pushed by this flag rather than the shell's path, so
    /// resetting the path alone leaves it on top and the dock hidden.
    func leave(to goToTrophyWall: () -> Void) {
        dismiss()
        goToTrophyWall()
    }

    private func failClosed() {
        openFailed = true
        ListingReviewAnnouncement.post(
            ListingReviewCopy.openFailed,
            assertive: true
        )
    }
}
