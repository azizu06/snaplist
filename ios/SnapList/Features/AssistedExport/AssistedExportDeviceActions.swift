import Photos
import SwiftUI
import UIKit

@MainActor
struct AssistedExportDeviceActions {
    var open: (AssistedExportDestination) async -> Bool
    var copy: (String) -> Void
    var loadPhotos: ([URL]) async throws -> [UIImage]
    var savePhotos: ([UIImage]) async throws -> Void

    static let live = AssistedExportDeviceActions(
        open: { destination in
            await UIApplication.shared.open(destination.sellerHandoffURL)
        },
        copy: { text in
            UIPasteboard.general.string = text
        },
        loadPhotos: { references in
            try await withThrowingTaskGroup(of: (Int, UIImage).self) { group in
                for (index, reference) in references.enumerated() {
                    group.addTask {
                        let (data, response) = try await URLSession.shared.data(from: reference)
                        guard let http = response as? HTTPURLResponse,
                              (200..<300).contains(http.statusCode),
                              let image = UIImage(data: data) else {
                            throw AssistedExportDeviceActionError.photoUnavailable
                        }
                        return (index, image)
                    }
                }
                var loaded: [(Int, UIImage)] = []
                for try await result in group { loaded.append(result) }
                guard loaded.count == references.count else {
                    throw AssistedExportDeviceActionError.photoUnavailable
                }
                return loaded.sorted { $0.0 < $1.0 }.map(\.1)
            }
        },
        savePhotos: { images in
            let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
            guard status == .authorized || status == .limited else {
                throw AssistedExportDeviceActionError.photoLibraryDenied
            }
            try await PHPhotoLibrary.shared().performChanges {
                for image in images {
                    PHAssetChangeRequest.creationRequestForAsset(from: image)
                }
            }
        }
    )
}

enum AssistedExportDeviceActionError: Error {
    case photoUnavailable
    case photoLibraryDenied
}

private extension AssistedExportDestination {
    var sellerHandoffURL: URL {
        switch self {
        case .facebookMarketplace:
            return URL(string: "https://www.facebook.com/marketplace/create/item")!
        case .mercari:
            return URL(string: "https://www.mercari.com/us/sell/")!
        case .depop:
            return URL(string: "https://www.depop.com/sell/")!
        }
    }
}

struct AssistedExportSharePayload: Identifiable {
    let id = UUID()
    let destination: AssistedExportDestination
    let pack: AssistedExportPack
    let items: [Any]
}

struct AssistedExportActivitySheet: UIViewControllerRepresentable {
    let items: [Any]
    let onPresented: () -> Void

    func makeUIViewController(context: Context) -> UIActivityViewController {
        PresentedActivityViewController(
            activityItems: items,
            onPresented: onPresented
        )
    }

    func updateUIViewController(
        _ uiViewController: UIActivityViewController,
        context: Context
    ) {}

    private final class PresentedActivityViewController:
        UIActivityViewController {
        private var didPresent = false
        private let onPresented: () -> Void

        init(activityItems: [Any], onPresented: @escaping () -> Void) {
            self.onPresented = onPresented
            super.init(
                activityItems: activityItems,
                applicationActivities: nil
            )
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) {
            fatalError("init(coder:) has not been implemented")
        }

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            guard !didPresent else { return }
            didPresent = true
            onPresented()
        }
    }
}
