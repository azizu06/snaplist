import SwiftUI

@MainActor
@Observable
final class PhotoReviewPickerPresentation {
    private(set) var isPresented = false
    private(set) var cancellationFocus: PhotoReviewPickerOpener?

    func present(
        _ request: PhotoReviewPickerRequest,
        store: PhotoReviewStore
    ) {}

    @discardableResult
    func dismiss(
        hasConfirmedSelection: Bool,
        store: PhotoReviewStore
    ) -> PhotoReviewPickerOpener? {
        nil
    }
}

@MainActor
struct PhotoReviewFixtureView: View {
    @State private var store: PhotoReviewStore

    init(state: PhotoReviewVisualStateID) {
        _store = State(
            initialValue: PhotoReviewStore(
                photos: Self.photos(for: state)
            )
        )
    }

    var body: some View {
        PhotoReviewView(
            store: store,
            replace: {},
            delete: {}
        )
    }

    private static func photos(
        for state: PhotoReviewVisualStateID
    ) -> [StagedCapturePhoto] {
        switch state {
        case .resting:
            return (1...3).map { index in
                let id = UUID(
                    uuidString: "45500000-0000-4000-8000-\(String(format: "%012d", index))"
                )!
                return StagedCapturePhoto(
                    id: id,
                    photoURL: URL(fileURLWithPath: "/tmp/photo-review-\(index).jpg"),
                    thumbnailURL: URL(fileURLWithPath: "/tmp/photo-review-thumb-\(index).jpg"),
                    createdAt: Date(timeIntervalSinceReferenceDate: Double(index))
                )
            }
        }
    }
}

@MainActor
struct PhotoReviewView: View {
    @Bindable var store: PhotoReviewStore
    let replace: () -> Void
    let delete: () -> Void

    private var selectedPhoto: StagedCapturePhoto? {
        store.photos.first(where: { $0.id == store.selectedPhotoID })
            ?? store.photos.first
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                topBar
                hero
                thumbnailStrip

                if store.actionsPhotoID != nil {
                    actionRow
                }
            }
            .padding(.horizontal, SnapListMetrics.screenGutter)
            .padding(.vertical, 16)
        }
        .background(SnapListColorToken.groupingFill.color)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("photo-review.screen")
    }

    private var topBar: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("Review photos")
                .snapListTypography(.sectionHeader)
                .foregroundStyle(SnapListColorToken.inkPrimary.color)

            Spacer(minLength: 12)

            Text("\(store.photos.count) of 5")
                .snapListTypography(.metadata)
                .foregroundStyle(SnapListColorToken.textSecondary.color)
                .accessibilityIdentifier("photo-review.count")
        }
    }

    @ViewBuilder
    private var hero: some View {
        if let selectedPhoto {
            LocalCaptureImage(
                url: selectedPhoto.photoURL,
                maximumPixelSize: 1_200
            )
            .scaledToFill()
            .frame(maxWidth: .infinity)
            .frame(height: 300)
            .clipped()
            .clipShape(.rect(cornerRadius: 18))
            .accessibilityHidden(true)
        }
    }

    private var thumbnailStrip: some View {
        ScrollView(.horizontal) {
            HStack(alignment: .top, spacing: 12) {
                ForEach(Array(store.photos.enumerated()), id: \.element.id) { index, photo in
                    thumbnail(photo, index: index)
                }
            }
            .padding(.vertical, 3)
        }
        .scrollIndicators(.hidden)
    }

    private func thumbnail(
        _ photo: StagedCapturePhoto,
        index: Int
    ) -> some View {
        let isSelected = photo.id == store.selectedPhotoID
        return VStack(spacing: 6) {
            Button {
                store.selectPhotoForActions(id: photo.id)
            } label: {
                LocalCaptureImage(
                    url: photo.thumbnailURL,
                    maximumPixelSize: 180
                )
                .scaledToFill()
                .frame(width: 76, height: 76)
                .clipped()
                .clipShape(.rect(cornerRadius: 12))
                .overlay {
                    RoundedRectangle(cornerRadius: 12)
                        .stroke(
                            isSelected ? SnapListColorToken.action.color : .clear,
                            lineWidth: 3
                        )
                }
                .accessibilityHidden(true)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(
                thumbnailAccessibilityLabel(index: index, isSelected: isSelected)
            )
            .accessibilityAddTraits(isSelected ? .isSelected : [])
            .accessibilityIdentifier("photo-review.thumbnail.\(index + 1)")

            if index == 0 {
                Text("Cover")
                    .snapListTypography(.metadata)
                    .fontWeight(.semibold)
                    .foregroundStyle(SnapListColorToken.inkPrimary.color)
                    .accessibilityIdentifier("photo-review.cover")
            }
        }
    }

    private func thumbnailAccessibilityLabel(
        index: Int,
        isSelected: Bool
    ) -> String {
        var truths = ["Photo \(index + 1) of \(store.photos.count)"]
        if index == 0 {
            truths.append("Cover")
        }
        if isSelected {
            truths.append("selected")
        }
        return truths.joined(separator: ", ")
    }

    private var actionRow: some View {
        HStack(spacing: 12) {
            Button("Replace", action: replace)
                .frame(maxWidth: .infinity, minHeight: SnapListMetrics.minimumTouchTarget)
                .buttonStyle(.bordered)
                .accessibilityLabel("Replace this photo")
                .accessibilityIdentifier("photo-review.replace")

            Button("Delete", role: .destructive, action: delete)
                .frame(maxWidth: .infinity, minHeight: SnapListMetrics.minimumTouchTarget)
                .buttonStyle(.bordered)
                .accessibilityLabel("Delete this photo")
                .accessibilityIdentifier("photo-review.delete")
        }
    }
}
