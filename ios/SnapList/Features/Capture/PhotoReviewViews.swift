import PhotosUI
import SwiftUI
import UIKit
#if DEBUG
import ImageIO
#endif

@MainActor
@Observable
final class PhotoReviewActionPresentation {
    private(set) var focusedPhotoID: StagedCapturePhoto.ID?

    @discardableResult
    func dismissOutside(
        store: PhotoReviewStore
    ) -> StagedCapturePhoto.ID? {
        guard let photoID = store.dismissActions() else {
            return nil
        }
        focusedPhotoID = photoID
        return photoID
    }
}

@MainActor
@Observable
final class PhotoReviewAccessibilityActionPresentation {
    private(set) var focusedPhotoID: StagedCapturePhoto.ID?
    private(set) var pendingAnnouncement: String?

    func availableActions(
        for photoID: StagedCapturePhoto.ID,
        in store: PhotoReviewStore
    ) -> [PhotoReviewReorderAction] {
        guard let index = store.photos.firstIndex(where: { $0.id == photoID }),
              store.photos.count > 1 else {
            return []
        }

        var actions: [PhotoReviewReorderAction] = []
        if index > 0 {
            actions.append(.moveEarlier)
        }
        if index < store.photos.index(before: store.photos.endIndex) {
            actions.append(.moveLater)
        }
        if index > 0 {
            actions.append(.makeCover)
        }
        return actions
    }

    @discardableResult
    func perform(
        _ action: PhotoReviewReorderAction,
        photoID: StagedCapturePhoto.ID,
        store: PhotoReviewStore
    ) -> PhotoReviewReorderResult? {
        guard availableActions(for: photoID, in: store).contains(action),
              let result = store.performAccessibilityReorder(
                photoID: photoID,
                action: action
              ) else {
            return nil
        }
        focusedPhotoID = result.photoID
        pendingAnnouncement = result.announcement
        return result
    }

    func consumeAnnouncement() -> String? {
        defer { pendingAnnouncement = nil }
        return pendingAnnouncement
    }
}

@MainActor
@Observable
final class PhotoReviewPickerPresentation {
    private(set) var isPresented = false
    private(set) var cancellationFocus: PhotoReviewPickerOpener?

    func present(
        _ request: PhotoReviewPickerRequest,
        store: PhotoReviewStore
    ) {
        cancellationFocus = nil
        store.beginPickerRequest(request)
        isPresented = true
    }

    @discardableResult
    func dismiss(
        hasConfirmedSelection: Bool,
        store: PhotoReviewStore
    ) -> PhotoReviewPickerOpener? {
        guard isPresented else {
            return nil
        }

        isPresented = false
        guard !hasConfirmedSelection else {
            cancellationFocus = nil
            return nil
        }

        guard let opener = store.cancelPickerRequest() else {
            return nil
        }
        cancellationFocus = opener
        return opener
    }
}

#if DEBUG
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
            delete: {}
        )
    }

    static func photos(
        for state: PhotoReviewVisualStateID,
        rootDirectory: URL = FileManager.default.temporaryDirectory,
        beforePhotoConstruction: () -> Void = {}
    ) -> [StagedCapturePhoto] {
        do {
            try FileManager.default.createDirectory(
                at: rootDirectory,
                withIntermediateDirectories: true
            )
        } catch {
            preconditionFailure(
                "REV-02 fixture directory could not be created at \(rootDirectory.path): \(error)"
            )
        }

        switch state {
        case .resting:
            let descriptors = (1...3).map { index in
                (
                    id: UUID(
                        uuidString: "45500000-0000-4000-8000-\(String(format: "%012d", index))"
                    )!,
                    photoURL: rootDirectory.appendingPathComponent(
                        "photo-review-\(index).jpg"
                    ),
                    thumbnailURL: rootDirectory.appendingPathComponent(
                        "photo-review-thumb-\(index).jpg"
                    ),
                    createdAt: Date(timeIntervalSinceReferenceDate: Double(index))
                )
            }
            for (offset, descriptor) in descriptors.enumerated() {
                materializeImages(
                    at: [descriptor.photoURL, descriptor.thumbnailURL],
                    ordinal: offset + 1
                )
            }
            return descriptors.map { descriptor in
                beforePhotoConstruction()
                return StagedCapturePhoto(
                    id: descriptor.id,
                    photoURL: descriptor.photoURL,
                    thumbnailURL: descriptor.thumbnailURL,
                    createdAt: descriptor.createdAt
                )
            }
        }
    }

    private static func materializeImages(
        at urls: [URL],
        ordinal: Int
    ) {
        guard urls.contains(where: { !isValidFixtureImage(at: $0) }) else {
            return
        }

        let colors = [
            UIColor(red: 0.86, green: 0.72, blue: 0.55, alpha: 1),
            UIColor(red: 0.52, green: 0.68, blue: 0.72, alpha: 1),
            UIColor(red: 0.74, green: 0.66, blue: 0.78, alpha: 1)
        ]
        let size = CGSize(width: 1_200, height: 900)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.preferredRange = .standard
        let data = UIGraphicsImageRenderer(size: size, format: format).jpegData(
            withCompressionQuality: 0.92
        ) { context in
            colors[ordinal - 1].setFill()
            context.fill(CGRect(origin: .zero, size: size))
            UIColor.black.withAlphaComponent(0.55).setFill()
            context.fill(
                CGRect(
                    x: size.width * 0.24,
                    y: size.height * 0.18,
                    width: size.width * 0.52,
                    height: size.height * 0.64
                )
            )
        }

        for url in urls where !isValidFixtureImage(at: url) {
            do {
                try data.write(to: url, options: .atomic)
            } catch {
                preconditionFailure(
                    "REV-02 fixture image could not be written at \(url.path): \(error)"
                )
            }
            precondition(
                isValidFixtureImage(at: url),
                "REV-02 fixture image is invalid at \(url.path)"
            )
        }
    }

    private static func isValidFixtureImage(at url: URL) -> Bool {
        guard
            let source = CGImageSourceCreateWithURL(url as CFURL, nil),
            CGImageSourceGetType(source) as String? == "public.jpeg",
            let properties = CGImageSourceCopyPropertiesAtIndex(
                source,
                0,
                nil
            ) as? [CFString: Any],
            (properties[kCGImagePropertyPixelWidth] as? NSNumber)?
                .intValue == 1_200,
            (properties[kCGImagePropertyPixelHeight] as? NSNumber)?
                .intValue == 900
        else {
            return false
        }
        return CGImageSourceCreateThumbnailAtIndex(
            source,
            0,
            [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 1_200
            ] as CFDictionary
        ) != nil
    }
}
#endif

struct PhotoReviewLiveDeleteResult: Equatable {
    let focus: PhotoReviewDeleteFocus
    let announcement: String
}

@MainActor
final class PhotoReviewLiveSession {
    let store: PhotoReviewStore
    private(set) var focusedPhotoID: StagedCapturePhoto.ID?
    private var pendingDeleteAnnouncement: String?

    private init(store: PhotoReviewStore) {
        self.store = store
    }

    static func start(
        from request: CaptureBoundaryRequest?
    ) -> PhotoReviewLiveSession? {
        guard let request,
              request.destination == .photoReview,
              request.opener == .reviewButton,
              (1...5).contains(request.photos.count) else {
            return nil
        }
        return PhotoReviewLiveSession(
            store: PhotoReviewStore(photos: request.photos)
        )
    }

    @discardableResult
    func returnToScan(
        using router: AppRouter
    ) -> PhotoReviewScanReturn? {
        let request = PhotoReviewScanReturn(
            photos: store.photos,
            focus: .reviewButton
        )
        router.returnFromPhotoReview(request)
        return request
    }

    @discardableResult
    func deleteNonFinalPhoto(
        id: StagedCapturePhoto.ID
    ) -> PhotoReviewLiveDeleteResult? {
        guard store.photos.count > 1,
              case .photo(let focusedPhotoID)? =
                store.deletePhotoForReview(id: id) else {
            return nil
        }

        let count = store.photos.count
        let announcement = count == 1
            ? "1 photo remaining."
            : "\(count) photos remaining."
        self.focusedPhotoID = focusedPhotoID
        pendingDeleteAnnouncement = announcement
        return PhotoReviewLiveDeleteResult(
            focus: .photo(focusedPhotoID),
            announcement: announcement
        )
    }

    func consumeDeleteAnnouncement() -> String? {
        defer { pendingDeleteAnnouncement = nil }
        return pendingDeleteAnnouncement
    }
}

@MainActor
@Observable
final class PhotoReviewLiveHost {
    private(set) var session: PhotoReviewLiveSession?
    private var activeRequest: CaptureBoundaryRequest?

    @discardableResult
    func consume(
        _ request: CaptureBoundaryRequest?
    ) -> Bool {
        guard let request else {
            return false
        }
        if activeRequest == request, session != nil {
            return false
        }
        guard let session = PhotoReviewLiveSession.start(from: request) else {
            return false
        }
        activeRequest = request
        self.session = session
        return true
    }
}

@MainActor
struct PhotoReviewView: View {
    @Bindable var store: PhotoReviewStore
    let delete: () -> Void

    @State private var actionPresentation = PhotoReviewActionPresentation()
    @State private var accessibilityActionPresentation =
        PhotoReviewAccessibilityActionPresentation()
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var pickerPresentation = PhotoReviewPickerPresentation()
    // Outside dismissal focus stays independent from picker cancellation focus.
    @AccessibilityFocusState private var focusedThumbnailID: StagedCapturePhoto.ID?
    @AccessibilityFocusState private var focusedPickerOpener: PickerFocusTarget?

    private enum PickerFocusTarget: Hashable {
        case addButton
        case replaceButton(photoID: StagedCapturePhoto.ID)
    }

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
        .background {
            SnapListColorToken.groupingFill.color
                .contentShape(.rect)
                .onTapGesture(perform: dismissActionsOutside)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("photo-review.screen")
        .photosPicker(
            isPresented: pickerIsPresented,
            selection: $pickerItems,
            maxSelectionCount: pickerSelectionLimit,
            matching: .images
        )
        .onChange(of: pickerItems) { _, items in
            guard !items.isEmpty else { return }
            _ = pickerPresentation.dismiss(
                hasConfirmedSelection: true,
                store: store
            )
        }
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
        if let selectedPhoto,
           let selectedIndex = store.photos.firstIndex(where: { $0.id == selectedPhoto.id }) {
            Button {
                store.selectPhotoForActions(id: selectedPhoto.id)
            } label: {
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
            .buttonStyle(.plain)
            .accessibilityLabel(
                thumbnailAccessibilityLabel(index: selectedIndex, isSelected: true)
            )
            .accessibilityIdentifier("photo-review.hero")
        }
    }

    private var thumbnailStrip: some View {
        ScrollView(.horizontal) {
            HStack(alignment: .top, spacing: 12) {
                ForEach(Array(store.photos.enumerated()), id: \.element.id) { index, photo in
                    thumbnail(photo, index: index)
                }
                addButton
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
            .accessibilityFocused(
                $focusedThumbnailID,
                equals: photo.id
            )
            .accessibilityActions {
                let actions = accessibilityActionPresentation.availableActions(
                    for: photo.id,
                    in: store
                )
                if actions.contains(.moveEarlier) {
                    Button("Move earlier") {
                        performAccessibilityAction(.moveEarlier, photoID: photo.id)
                    }
                }
                if actions.contains(.moveLater) {
                    Button("Move later") {
                        performAccessibilityAction(.moveLater, photoID: photo.id)
                    }
                }
                if actions.contains(.makeCover) {
                    Button("Make cover") {
                        performAccessibilityAction(.makeCover, photoID: photo.id)
                    }
                }
            }

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

    private var addButton: some View {
        Button {
            presentPicker(.add)
        } label: {
            VStack(spacing: 2) {
                Image(systemName: "plus")
                    .font(.system(size: 20, weight: .semibold))
                Text("Add")
                    .snapListTypography(.metadata)
                    .fontWeight(.semibold)
            }
            .foregroundStyle(SnapListColorToken.textSecondary.color)
            .frame(
                width: 76,
                height: 76
            )
            .background(SnapListColorToken.canvas.color)
            .clipShape(.rect(cornerRadius: 12))
            .overlay {
                RoundedRectangle(cornerRadius: 12)
                    .stroke(
                        SnapListColorToken.textSecondary.color.opacity(0.55),
                        style: StrokeStyle(lineWidth: 1.5, dash: [5])
                    )
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Add photos")
        .accessibilityIdentifier("photo-review.add")
        .accessibilityFocused(
            $focusedPickerOpener,
            equals: .addButton
        )
    }

    @ViewBuilder
    private var actionRow: some View {
        HStack(spacing: 12) {
            if let photoID = store.actionsPhotoID {
                Button("Replace") {
                    presentPicker(.replace(photoID: photoID))
                }
                .frame(maxWidth: .infinity, minHeight: SnapListMetrics.minimumTouchTarget)
                .buttonStyle(.bordered)
                .accessibilityLabel("Replace this photo")
                .accessibilityIdentifier("photo-review.replace")
                .accessibilityFocused(
                    $focusedPickerOpener,
                    equals: .replaceButton(photoID: photoID)
                )
            }

            Button("Delete", role: .destructive, action: delete)
                .frame(maxWidth: .infinity, minHeight: SnapListMetrics.minimumTouchTarget)
                .buttonStyle(.bordered)
                .accessibilityLabel("Delete this photo")
                .accessibilityIdentifier("photo-review.delete")
        }
    }

    private var pickerIsPresented: Binding<Bool> {
        Binding(
            get: { pickerPresentation.isPresented },
            set: { isPresented in
                guard !isPresented else { return }
                restorePickerCancellationFocus(
                    pickerPresentation.dismiss(
                        hasConfirmedSelection: !pickerItems.isEmpty,
                        store: store
                    )
                )
            }
        )
    }

    private var pickerSelectionLimit: Int? {
        guard case .replace = store.activePickerRequest else {
            return nil
        }
        return 1
    }

    private func presentPicker(_ request: PhotoReviewPickerRequest) {
        pickerItems = []
        focusedPickerOpener = nil
        pickerPresentation.present(request, store: store)
    }

    private func dismissActionsOutside() {
        guard let photoID = actionPresentation.dismissOutside(store: store) else {
            return
        }
        focusedThumbnailID = photoID
    }

    private func performAccessibilityAction(
        _ action: PhotoReviewReorderAction,
        photoID: StagedCapturePhoto.ID
    ) {
        guard let result = accessibilityActionPresentation.perform(
            action,
            photoID: photoID,
            store: store
        ) else {
            return
        }

        focusedThumbnailID = result.photoID
        guard let announcement =
                accessibilityActionPresentation.consumeAnnouncement() else {
            return
        }
        UIAccessibility.post(
            notification: .announcement,
            argument: announcement
        )
    }

    private func restorePickerCancellationFocus(
        _ opener: PhotoReviewPickerOpener?
    ) {
        switch opener {
        case .addButton:
            focusedPickerOpener = .addButton
        case .replaceButton(let photoID):
            focusedPickerOpener = .replaceButton(photoID: photoID)
        case nil:
            break
        }
    }
}
