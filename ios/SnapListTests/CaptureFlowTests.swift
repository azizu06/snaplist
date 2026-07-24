import AVFoundation
import ImageIO
import SwiftUI
import UIKit
import XCTest
@testable import SnapList

@MainActor
final class CaptureFlowTests: XCTestCase {
    func testPhotoReviewFixtureMaterializesDecodableImagesBeforeConstruction() throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory.appendingPathComponent(
            "snaplist-photo-review-fixture-\(UUID().uuidString)",
            isDirectory: true
        )
        defer { try? fileManager.removeItem(at: root) }

        let photos = PhotoReviewFixtureView.photos(
            for: .resting,
            rootDirectory: root
        )

        XCTAssertEqual(
            photos.map(\.id.uuidString),
            [
                "45500000-0000-4000-8000-000000000001",
                "45500000-0000-4000-8000-000000000002",
                "45500000-0000-4000-8000-000000000003"
            ]
        )

        for (offset, photo) in photos.enumerated() {
            let ordinal = offset + 1
            let expectedPhotoURL = root.appendingPathComponent(
                "photo-review-\(ordinal).jpg"
            )
            let expectedThumbnailURL = root.appendingPathComponent(
                "photo-review-thumb-\(ordinal).jpg"
            )

            XCTAssertEqual(photo.photoURL, expectedPhotoURL)
            XCTAssertEqual(photo.thumbnailURL, expectedThumbnailURL)
            XCTAssertTrue(fileManager.fileExists(atPath: photo.photoURL.path))
            XCTAssertTrue(fileManager.fileExists(atPath: photo.thumbnailURL.path))
            XCTAssertNotNil(CGImageSourceCreateWithURL(photo.photoURL as CFURL, nil))
            XCTAssertNotNil(
                CGImageSourceCreateWithURL(photo.thumbnailURL as CFURL, nil)
            )
        }
    }

    func testPhotoReviewFixtureMaterializesAllImagesBeforeFirstPhotoConstruction() {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory.appendingPathComponent(
            "snaplist-photo-review-sequencing-\(UUID().uuidString)",
            isDirectory: true
        )
        defer { try? fileManager.removeItem(at: root) }

        let expectedURLs = (1...3).flatMap { ordinal in
            [
                root.appendingPathComponent("photo-review-\(ordinal).jpg"),
                root.appendingPathComponent("photo-review-thumb-\(ordinal).jpg")
            ]
        }
        var constructionCount = 0
        var firstConstructionDecodeResults: [URL: Bool] = [:]

        let photos = PhotoReviewFixtureView.photos(
            for: .resting,
            rootDirectory: root
        ) {
            constructionCount += 1
            guard constructionCount == 1 else {
                return
            }
            firstConstructionDecodeResults = Dictionary(
                uniqueKeysWithValues: expectedURLs.map { url in
                    guard
                        fileManager.fileExists(atPath: url.path),
                        let source = CGImageSourceCreateWithURL(url as CFURL, nil)
                    else {
                        return (url, false)
                    }
                    let image = CGImageSourceCreateThumbnailAtIndex(
                        source,
                        0,
                        [
                            kCGImageSourceCreateThumbnailFromImageAlways: true,
                            kCGImageSourceCreateThumbnailWithTransform: true,
                            kCGImageSourceThumbnailMaxPixelSize: 1_200
                        ] as CFDictionary
                    )
                    return (url, image != nil)
                }
            )
        }

        XCTAssertEqual(constructionCount, 3)
        XCTAssertEqual(
            photos.map(\.id.uuidString),
            [
                "45500000-0000-4000-8000-000000000001",
                "45500000-0000-4000-8000-000000000002",
                "45500000-0000-4000-8000-000000000003"
            ]
        )
        for url in expectedURLs {
            XCTAssertEqual(
                firstConstructionDecodeResults[url],
                true,
                "\(url.lastPathComponent) must decode before the first fixture photo is constructed."
            )
        }
    }

    func testPhotoReviewFixtureReplacesRecognizedButUndecodableImages() throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory.appendingPathComponent(
            "snaplist-photo-review-corrupt-fixture-\(UUID().uuidString)",
            isDirectory: true
        )
        defer { try? fileManager.removeItem(at: root) }
        try fileManager.createDirectory(
            at: root,
            withIntermediateDirectories: true
        )

        func decodedThumbnail(from data: Data) -> CGImage? {
            guard let source = CGImageSourceCreateWithData(data as CFData, nil) else {
                return nil
            }
            return CGImageSourceCreateThumbnailAtIndex(
                source,
                0,
                [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceThumbnailMaxPixelSize: 180
                ] as CFDictionary
            )
        }

        func decodedThumbnail(at url: URL) -> CGImage? {
            guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
                return nil
            }
            return CGImageSourceCreateThumbnailAtIndex(
                source,
                0,
                [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceThumbnailMaxPixelSize: 180
                ] as CFDictionary
            )
        }

        let validJPEG = try makeLandscapeImageData()
        let corruptLength = try XCTUnwrap(
            stride(from: validJPEG.count - 1, through: 1, by: -1).first { length in
                let candidate = Data(validJPEG.prefix(length))
                guard let source = CGImageSourceCreateWithData(
                    candidate as CFData,
                    nil
                ) else {
                    return false
                }
                return CGImageSourceGetCount(source) > 0
                    && decodedThumbnail(from: candidate) == nil
            }
        )
        let corruptPhotoURL = root.appendingPathComponent("photo-review-1.jpg")
        try Data(validJPEG.prefix(corruptLength)).write(
            to: corruptPhotoURL,
            options: .atomic
        )

        let photos = PhotoReviewFixtureView.photos(
            for: .resting,
            rootDirectory: root
        )

        XCTAssertEqual(photos.map(\.id.uuidString), [
            "45500000-0000-4000-8000-000000000001",
            "45500000-0000-4000-8000-000000000002",
            "45500000-0000-4000-8000-000000000003"
        ])
        for photo in photos {
            XCTAssertNotNil(decodedThumbnail(at: photo.photoURL))
            XCTAssertNotNil(decodedThumbnail(at: photo.thumbnailURL))
        }
    }

    func testPhotoReviewFixtureUsesDeterministicOnePixelRendererScale() throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory.appendingPathComponent(
            "snaplist-photo-review-pixel-scale-\(UUID().uuidString)",
            isDirectory: true
        )
        defer { try? fileManager.removeItem(at: root) }

        let photos = PhotoReviewFixtureView.photos(
            for: .resting,
            rootDirectory: root
        )
        let urls = photos.flatMap { [$0.photoURL, $0.thumbnailURL] }

        XCTAssertEqual(urls.count, 6)
        for url in urls {
            let source = try XCTUnwrap(
                CGImageSourceCreateWithURL(url as CFURL, nil)
            )
            XCTAssertEqual(
                CGImageSourceGetType(source) as String?,
                "public.jpeg",
                "\(url.lastPathComponent) must remain a JPEG."
            )
            let properties = try XCTUnwrap(
                CGImageSourceCopyPropertiesAtIndex(source, 0, nil)
                    as? [CFString: Any]
            )
            let width = properties[kCGImagePropertyPixelWidth] as? NSNumber
            let height = properties[kCGImagePropertyPixelHeight] as? NSNumber

            XCTAssertEqual(
                width?.intValue,
                1_200,
                "\(url.lastPathComponent) must be exactly 1200 pixels wide."
            )
            XCTAssertEqual(
                height?.intValue,
                900,
                "\(url.lastPathComponent) must be exactly 900 pixels tall."
            )
        }
    }

    func testPhotoReviewFixtureReplacesDecodableFilesThatViolateJPEGPixelContract() throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory.appendingPathComponent(
            "snaplist-photo-review-retained-invalid-\(UUID().uuidString)",
            isDirectory: true
        )
        defer { try? fileManager.removeItem(at: root) }
        try fileManager.createDirectory(
            at: root,
            withIntermediateDirectories: true
        )

        let urls = (1...3).flatMap { ordinal in
            [
                root.appendingPathComponent("photo-review-\(ordinal).jpg"),
                root.appendingPathComponent("photo-review-thumb-\(ordinal).jpg")
            ]
        }
        let retainedValidURL = urls[5]
        let invalidSize = CGSize(width: 640, height: 480)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.preferredRange = .standard
        let renderer = UIGraphicsImageRenderer(
            size: invalidSize,
            format: format
        )
        let invalidJPEG = renderer.jpegData(withCompressionQuality: 0.9) {
            context in
            UIColor.systemOrange.setFill()
            context.fill(CGRect(origin: .zero, size: invalidSize))
        }
        let invalidPNG = renderer.pngData { context in
            UIColor.systemBlue.setFill()
            context.fill(CGRect(origin: .zero, size: invalidSize))
        }
        let fixtureSize = CGSize(width: 1_200, height: 900)
        let retainedValidJPEG = UIGraphicsImageRenderer(
            size: fixtureSize,
            format: format
        ).jpegData(withCompressionQuality: 0.75) { context in
            UIColor.systemPink.setFill()
            context.fill(CGRect(origin: .zero, size: fixtureSize))
        }

        func source(at url: URL) -> CGImageSource? {
            CGImageSourceCreateWithURL(url as CFURL, nil)
        }

        func isLoaderDecodable(at url: URL) -> Bool {
            guard let source = source(at: url) else {
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

        func satisfiesFixtureInvariant(at url: URL) -> Bool {
            guard
                let source = source(at: url),
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
            return isLoaderDecodable(at: url)
        }

        for (offset, url) in urls.enumerated() {
            let data: Data
            if url == retainedValidURL {
                data = retainedValidJPEG
            } else if offset == 0 {
                data = invalidPNG
            } else {
                data = invalidJPEG
            }
            try data.write(
                to: url,
                options: .atomic
            )
            XCTAssertTrue(isLoaderDecodable(at: url))
        }
        XCTAssertEqual(
            CGImageSourceGetType(try XCTUnwrap(source(at: urls[0])))
                as String?,
            "public.png"
        )
        XCTAssertTrue(satisfiesFixtureInvariant(at: retainedValidURL))
        for url in urls where url != retainedValidURL {
            XCTAssertFalse(satisfiesFixtureInvariant(at: url))
        }
        let retainedValidBytes = try Data(contentsOf: retainedValidURL)

        var constructionCount = 0
        var allFilesValidBeforeFirstConstruction = false
        let photos = PhotoReviewFixtureView.photos(
            for: .resting,
            rootDirectory: root
        ) {
            constructionCount += 1
            guard constructionCount == 1 else {
                return
            }
            allFilesValidBeforeFirstConstruction = urls.allSatisfy(
                satisfiesFixtureInvariant
            )
        }

        XCTAssertEqual(
            photos.map(\.id.uuidString),
            [
                "45500000-0000-4000-8000-000000000001",
                "45500000-0000-4000-8000-000000000002",
                "45500000-0000-4000-8000-000000000003"
            ]
        )
        XCTAssertEqual(
            photos.flatMap { [$0.photoURL, $0.thumbnailURL] },
            urls
        )
        XCTAssertEqual(constructionCount, 3)
        XCTAssertTrue(
            allFilesValidBeforeFirstConstruction,
            "All retained fixture files must be repaired before the first photo is constructed."
        )
        XCTAssertEqual(
            try Data(contentsOf: retainedValidURL),
            retainedValidBytes,
            "An already-valid retained fixture must not be rewritten."
        )
        for url in urls {
            let source = try XCTUnwrap(source(at: url))
            XCTAssertEqual(
                CGImageSourceGetType(source) as String?,
                "public.jpeg",
                "\(url.lastPathComponent) must be JPEG."
            )
            let properties = try XCTUnwrap(
                CGImageSourceCopyPropertiesAtIndex(source, 0, nil)
                    as? [CFString: Any]
            )
            XCTAssertEqual(
                (properties[kCGImagePropertyPixelWidth] as? NSNumber)?
                    .intValue,
                1_200,
                "\(url.lastPathComponent) must be 1200 pixels wide."
            )
            XCTAssertEqual(
                (properties[kCGImagePropertyPixelHeight] as? NSNumber)?
                    .intValue,
                900,
                "\(url.lastPathComponent) must be 900 pixels tall."
            )
            XCTAssertTrue(isLoaderDecodable(at: url))
        }
    }

    func testPhotoReviewEditsPreserveIdentityOrderAndReturnTheExactScanPayload() {
        let originalCover = makeStagedPhoto(id: "45500000-0000-4000-8000-000000000001")
        let second = makeStagedPhoto(id: "45500000-0000-4000-8000-000000000002")
        let third = makeStagedPhoto(id: "45500000-0000-4000-8000-000000000003")
        let replacement = makeStagedPhoto(id: "45500000-0000-4000-8000-000000000004")
        let store = PhotoReviewStore(photos: [originalCover, second, third])
        let router = AppRouter(initialFullScreen: .guidedCamera)

        XCTAssertTrue(store.movePhoto(id: third.id, to: 0))
        XCTAssertTrue(store.replacePhoto(id: second.id, with: replacement))
        XCTAssertTrue(store.deletePhoto(id: originalCover.id))

        let returned = PhotoReviewScanReturn(
            photos: store.photos,
            focus: .reviewButton
        )
        router.returnFromPhotoReview(returned)

        XCTAssertEqual(store.photos.map(\.id), [third.id, replacement.id])
        XCTAssertEqual(store.selectedPhotoID, third.id)
        XCTAssertEqual(router.photoReviewScanReturn, returned)
    }

    func testLivePhotoReviewBackReturnsExactScanValuesOrderAndReviewFocus() {
        let originalCover = makeStagedPhoto(id: "45800000-0000-4000-8000-000000000001")
        let second = makeStagedPhoto(id: "45800000-0000-4000-8000-000000000002")
        let third = makeStagedPhoto(id: "45800000-0000-4000-8000-000000000003")
        let router = AppRouter(initialFullScreen: .guidedCamera)
        router.openCaptureBoundary(
            destination: .photoReview,
            photos: [originalCover, second, third],
            opener: .reviewButton
        )

        guard let session = PhotoReviewLiveSession.start(
            from: router.captureBoundaryRequest
        ) else {
            XCTFail(
                "A live Photo Review request must create one feature-local editing session."
            )
            return
        }

        XCTAssertEqual(session.store.photos, [originalCover, second, third])
        XCTAssertEqual(session.store.selectedPhotoID, originalCover.id)
        XCTAssertTrue(session.store.movePhoto(id: third.id, to: 0))

        let returned = session.returnToScan(using: router)
        let expected = PhotoReviewScanReturn(
            photos: [third, originalCover, second],
            focus: .reviewButton
        )

        XCTAssertEqual(returned, expected)
        XCTAssertEqual(router.photoReviewScanReturn, expected)
        XCTAssertNil(router.captureBoundaryRequest)
        XCTAssertEqual(router.presentedFullScreen, .guidedCamera)
    }

    func testPhotoReviewBackCoordinatorCompletesWithRestoredCaptureFixture() async {
        let configuration = LaunchConfiguration.parse(
            arguments: ["--restored-capture-fixture"]
        )
        let dependencies = AppDependencies.make(configuration: configuration)
        let captureFlow = CaptureFlowModel(
            camera: dependencies.captureCamera,
            evaluator: dependencies.framingEvaluator,
            store: dependencies.captureDraftStore
        )
        let router = AppRouter(initialFullScreen: .guidedCamera)
        let host = PhotoReviewLiveHost()

        let restoration = await captureFlow.restore()
        XCTAssertEqual(restoration, .stagedPhoto)
        let restoredPhotos = captureFlow.stagedPhotos
        XCTAssertEqual(restoredPhotos.count, 1)

        router.openCaptureBoundary(
            destination: .photoReview,
            photos: restoredPhotos,
            opener: .reviewButton
        )
        XCTAssertTrue(host.consume(router.captureBoundaryRequest))
        guard let session = host.session else {
            XCTFail("The restored Photo Review request must create a live session.")
            return
        }

        let outcome = await PhotoReviewBackCoordinator.perform(
            session: session,
            captureFlow: captureFlow,
            host: host
        )
        let expectedReturn = PhotoReviewScanReturn(
            photos: restoredPhotos,
            focus: .reviewButton
        )

        XCTAssertEqual(outcome, .completed(expectedReturn))
        XCTAssertEqual(captureFlow.phase, .camera)
        XCTAssertEqual(captureFlow.stagedPhotos, restoredPhotos)
        XCTAssertNil(host.session)
        if case .completed(let returnedRequest) = outcome {
            XCTAssertEqual(returnedRequest, expectedReturn)
            XCTAssertEqual(returnedRequest.focus, .reviewButton)
        } else {
            XCTFail("The coordinator must return the exact restored Scan request.")
        }
    }

    func testAppShellPhotoReviewBackTransactionAppliesCompletedRestoredCaptureReturn() async {
        let configuration = LaunchConfiguration.parse(
            arguments: ["--restored-capture-fixture"]
        )
        let dependencies = AppDependencies.make(configuration: configuration)
        let captureFlow = CaptureFlowModel(
            camera: dependencies.captureCamera,
            evaluator: dependencies.framingEvaluator,
            store: dependencies.captureDraftStore
        )
        let router = AppRouter(initialFullScreen: .guidedCamera)
        let host = PhotoReviewLiveHost()

        let restoration = await captureFlow.restore()
        XCTAssertEqual(restoration, .stagedPhoto)
        let restoredPhotos = captureFlow.stagedPhotos
        XCTAssertEqual(restoredPhotos.count, 1)

        router.openCaptureBoundary(
            destination: .photoReview,
            photos: restoredPhotos,
            opener: .reviewButton
        )
        XCTAssertTrue(host.consume(router.captureBoundaryRequest))
        guard let session = host.session else {
            XCTFail("The restored Photo Review request must create a live session.")
            return
        }

        var receivedFocuses: [PhotoReviewScanFocus] = []
        let outcome = await AppShellPhotoReviewBackTransaction.perform(
            session: session,
            captureFlow: captureFlow,
            host: host,
            router: router,
            setReturnFocus: { receivedFocuses.append($0) }
        )
        let expectedReturn = PhotoReviewScanReturn(
            photos: restoredPhotos,
            focus: .reviewButton
        )

        XCTAssertEqual(outcome, .completed(expectedReturn))
        XCTAssertEqual(captureFlow.phase, .camera)
        XCTAssertEqual(captureFlow.stagedPhotos, restoredPhotos)
        XCTAssertNil(host.session)
        XCTAssertEqual(receivedFocuses, [.reviewButton])
        XCTAssertEqual(router.photoReviewScanReturn, expectedReturn)
        XCTAssertNil(router.captureBoundaryRequest)
        XCTAssertEqual(router.presentedFullScreen, .guidedCamera)
    }

    func testPhotoReviewConditionalShellRemountPresentsPrepopulatedGuidedCamera() async {
        let photo = makeStagedPhoto(id: "45800000-0000-4000-8000-000000000051")
        let router = AppRouter(initialFullScreen: .guidedCamera)
        let host = PhotoReviewLiveHost()
        router.openCaptureBoundary(
            destination: .photoReview,
            photos: [photo],
            opener: .reviewButton
        )
        XCTAssertTrue(host.consume(router.captureBoundaryRequest))
        guard let session = host.session else {
            XCTFail("The presentation contract requires an active Photo Review session.")
            return
        }

        let coverPresented = expectation(
            description: "The prepopulated guided-camera cover appears after shell remount."
        )
        let hostingController = UIHostingController(
            rootView: PhotoReviewConditionalPresentationHarness(
                router: router,
                host: host,
                coverPresented: coverPresented.fulfill
            )
        )
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = hostingController
        window.makeKeyAndVisible()
        await Task.yield()
        XCTAssertNil(hostingController.presentedViewController)

        XCTAssertTrue(host.completeReturnToScan(from: session))
        router.presentedFullScreen = .guidedCamera

        await fulfillment(of: [coverPresented], timeout: 3)
        XCTAssertNotNil(hostingController.presentedViewController)
        window.isHidden = true
        withExtendedLifetime(window) {}
    }

    func testPhotoReviewOutgoingCameraDismissalAllowsDistinctReturnPresentation() async throws {
        let photo = makeStagedPhoto(id: "45800000-0000-4000-8000-000000000052")
        let router = AppRouter(initialFullScreen: .guidedCamera)
        let host = PhotoReviewLiveHost()
        let firstCoverPresented = expectation(
            description: "The outgoing guided-camera cover presents."
        )
        let reviewPresented = expectation(
            description: "Photo Review replaces the dismissed camera shell."
        )
        let secondCoverPresented = expectation(
            description: "A distinct guided-camera cover presents after Back."
        )
        var coverPresentationCount = 0
        let hostingController = UIHostingController(
            rootView: PhotoReviewConditionalPresentationHarness(
                router: router,
                host: host,
                coverPresented: {
                    coverPresentationCount += 1
                    if coverPresentationCount == 1 {
                        firstCoverPresented.fulfill()
                    } else if coverPresentationCount == 2 {
                        secondCoverPresented.fulfill()
                    }
                },
                reviewPresented: reviewPresented.fulfill
            )
        )
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = hostingController
        window.makeKeyAndVisible()

        await fulfillment(of: [firstCoverPresented], timeout: 3)
        let firstPresentedController = try XCTUnwrap(
            hostingController.presentedViewController
        )

        router.openCaptureBoundary(
            destination: .photoReview,
            photos: [photo],
            opener: .reviewButton
        )
        XCTAssertTrue(host.consume(router.captureBoundaryRequest))
        guard let session = host.session else {
            XCTFail("The outgoing-cover contract requires an exact live session.")
            return
        }

        await fulfillment(of: [reviewPresented], timeout: 3)
        let firstControllerDismissed = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in
                hostingController.presentedViewController == nil
                    && firstPresentedController.presentingViewController == nil
            },
            object: hostingController
        )
        await fulfillment(of: [firstControllerDismissed], timeout: 3)
        XCTAssertNil(hostingController.presentedViewController)
        XCTAssertNil(firstPresentedController.presentingViewController)

        XCTAssertTrue(host.completeReturnToScan(from: session))
        router.presentedFullScreen = .guidedCamera

        await fulfillment(of: [secondCoverPresented], timeout: 3)
        let secondPresentedController = try XCTUnwrap(
            hostingController.presentedViewController
        )
        XCTAssertFalse(firstPresentedController === secondPresentedController)
        XCTAssertEqual(coverPresentationCount, 2)
        window.isHidden = true
        withExtendedLifetime(window) {}
    }

    func testLivePhotoReviewScanReturnPersistsExactValuesOrderBeforeGuidedScan() async throws {
        let fileManager = FileManager.default
        let parent = fileManager.temporaryDirectory.appendingPathComponent(
            "snaplist-photo-review-return-\(UUID().uuidString)",
            isDirectory: true
        )
        defer { try? fileManager.removeItem(at: parent) }

        let nonemptyRoot = parent.appendingPathComponent(
            "nonempty",
            isDirectory: true
        )
        let nonemptyStore = LocalCaptureDraftStore(rootDirectory: nonemptyRoot)
        let originalCover = try await nonemptyStore.append(
            imageData: makeLandscapeImageData(
                leftColor: .systemRed,
                rightColor: .systemOrange
            ),
            libraryTransferReceipt: nil
        ).appendedPhoto
        let second = try await nonemptyStore.append(
            imageData: makeLandscapeImageData(
                leftColor: .systemGreen,
                rightColor: .systemBlue
            ),
            libraryTransferReceipt: nil
        ).appendedPhoto
        let third = try await nonemptyStore.append(
            imageData: makeLandscapeImageData(
                leftColor: .systemPurple,
                rightColor: .systemYellow
            ),
            libraryTransferReceipt: nil
        ).appendedPhoto
        let nonemptyModel = CaptureFlowModel(
            camera: TestCaptureCamera(
                isAvailable: true,
                authorization: .authorized
            ),
            evaluator: TestFramingEvaluator(observations: []),
            store: nonemptyStore
        )
        let nonemptyRestoration = await nonemptyModel.restore()
        XCTAssertEqual(nonemptyRestoration, .stagedPhoto)

        let nonemptyFocus = await nonemptyModel.applyPhotoReviewScanReturn(
            PhotoReviewScanReturn(
                photos: [third, originalCover],
                focus: .reviewButton
            )
        )

        XCTAssertEqual(nonemptyFocus, .reviewButton)
        XCTAssertEqual(nonemptyModel.stagedPhotos, [third, originalCover])
        let persistedNonemptyPhotos = try await nonemptyStore.loadPhotos()
        XCTAssertEqual(persistedNonemptyPhotos, [third, originalCover])
        XCTAssertEqual(nonemptyModel.phase, .captured)
        for removedURL in [second.photoURL, second.thumbnailURL] {
            XCTAssertFalse(
                fileManager.fileExists(atPath: removedURL.path),
                "Superseded artifacts must be removed only after the ordered manifest commits."
            )
        }

        let emptyRoot = parent.appendingPathComponent("empty", isDirectory: true)
        let emptyStore = LocalCaptureDraftStore(rootDirectory: emptyRoot)
        let solePhoto = try await emptyStore.append(
            imageData: makeLandscapeImageData(),
            libraryTransferReceipt: nil
        ).appendedPhoto
        let emptyModel = CaptureFlowModel(
            camera: TestCaptureCamera(
                isAvailable: true,
                authorization: .authorized
            ),
            evaluator: TestFramingEvaluator(observations: []),
            store: emptyStore
        )
        let emptyRestoration = await emptyModel.restore()
        XCTAssertEqual(emptyRestoration, .stagedPhoto)

        let emptyFocus = await emptyModel.applyPhotoReviewScanReturn(
            PhotoReviewScanReturn(photos: [], focus: .addPhotoButton)
        )

        XCTAssertEqual(emptyFocus, .addPhotoButton)
        XCTAssertEqual(emptyModel.stagedPhotos, [])
        let persistedEmptyPhotos = try await emptyStore.loadPhotos()
        XCTAssertEqual(persistedEmptyPhotos, [])
        XCTAssertEqual(emptyModel.phase, .idle)
        for removedURL in [solePhoto.photoURL, solePhoto.thumbnailURL] {
            XCTAssertFalse(
                fileManager.fileExists(atPath: removedURL.path),
                "Final-delete artifacts must be removed after the empty manifest commits."
            )
        }

        let failingRoot = parent.appendingPathComponent(
            "failing",
            isDirectory: true
        )
        let originalFailingStore = LocalCaptureDraftStore(rootDirectory: failingRoot)
        let failingImageData = try [
            makeLandscapeImageData(leftColor: .systemRed, rightColor: .systemOrange),
            makeLandscapeImageData(leftColor: .systemGreen, rightColor: .systemBlue),
            makeLandscapeImageData(leftColor: .systemPurple, rightColor: .systemYellow)
        ]
        var failingPhotos: [StagedCapturePhoto] = []
        for imageData in failingImageData {
            let photo = try await originalFailingStore.append(
                imageData: imageData,
                libraryTransferReceipt: nil
            ).appendedPhoto
            failingPhotos.append(photo)
        }
        let failingWriter = PhotoReviewManifestWriteFailer()
        let failingStore = LocalCaptureDraftStore(
            rootDirectory: failingRoot,
            writeData: failingWriter.write
        )
        let failingModel = CaptureFlowModel(
            camera: TestCaptureCamera(
                isAvailable: true,
                authorization: .authorized
            ),
            evaluator: TestFramingEvaluator(observations: []),
            store: failingStore
        )
        let failingRestoration = await failingModel.restore()
        XCTAssertEqual(failingRestoration, .stagedPhoto)
        let originalArtifacts = failingPhotos.flatMap {
            [$0.photoURL, $0.thumbnailURL]
        }

        let failingFocus = await failingModel.applyPhotoReviewScanReturn(
            PhotoReviewScanReturn(
                photos: [failingPhotos[2], failingPhotos[0]],
                focus: .reviewButton
            )
        )

        XCTAssertNil(failingFocus)
        XCTAssertEqual(failingWriter.writeCount, 1)
        XCTAssertEqual(failingModel.stagedPhotos, failingPhotos)
        let persistedFailingPhotos = try await failingStore.loadPhotos()
        XCTAssertEqual(persistedFailingPhotos, failingPhotos)
        XCTAssertEqual(failingModel.phase, .captured)
        XCTAssertTrue(
            originalArtifacts.allSatisfy {
                fileManager.fileExists(atPath: $0.path)
            },
            "A failed ordered-manifest write must preserve every prior artifact."
        )

        let foreignPhoto = makeStagedPhoto(
            id: "45800000-0000-4000-8000-000000000099"
        )
        let modifiedPhoto = StagedCapturePhoto(
            id: failingPhotos[0].id,
            photoURL: failingPhotos[0].photoURL,
            thumbnailURL: failingPhotos[0].thumbnailURL,
            createdAt: failingPhotos[0].createdAt.addingTimeInterval(1),
            libraryTransferReceipt: failingPhotos[0].libraryTransferReceipt
        )
        let invalidReturns = [
            PhotoReviewScanReturn(
                photos: [failingPhotos[0], foreignPhoto],
                focus: .reviewButton
            ),
            PhotoReviewScanReturn(
                photos: [modifiedPhoto, failingPhotos[1]],
                focus: .reviewButton
            ),
            PhotoReviewScanReturn(
                photos: [failingPhotos[0], failingPhotos[0]],
                focus: .reviewButton
            ),
            PhotoReviewScanReturn(
                photos: [
                    failingPhotos[0],
                    failingPhotos[1],
                    failingPhotos[2],
                    foreignPhoto,
                    modifiedPhoto,
                    failingPhotos[0]
                ],
                focus: .reviewButton
            )
        ]
        for invalidReturn in invalidReturns {
            let invalidFocus = await failingModel.applyPhotoReviewScanReturn(
                invalidReturn
            )
            XCTAssertNil(invalidFocus)
            XCTAssertEqual(failingWriter.writeCount, 1)
            XCTAssertEqual(failingModel.stagedPhotos, failingPhotos)
            let persistedPhotos = try await failingStore.loadPhotos()
            XCTAssertEqual(persistedPhotos, failingPhotos)
            XCTAssertEqual(failingModel.phase, .captured)
        }
    }

    func testLivePhotoReviewHostConsumesExactRequestOnceAndPreservesEditingSession() {
        let originalCover = makeStagedPhoto(id: "45800000-0000-4000-8000-000000000011")
        let second = makeStagedPhoto(id: "45800000-0000-4000-8000-000000000012")
        let third = makeStagedPhoto(id: "45800000-0000-4000-8000-000000000013")
        let router = AppRouter(initialFullScreen: .guidedCamera)
        router.openCaptureBoundary(
            destination: .photoReview,
            photos: [originalCover, second, third],
            opener: .reviewButton
        )
        let host = PhotoReviewLiveHost()

        XCTAssertTrue(
            host.consume(router.captureBoundaryRequest),
            "The live AppShell host must consume the exact Photo Review request."
        )
        guard let session = host.session else {
            XCTFail("The consumed request must expose one renderable live session.")
            return
        }

        XCTAssertEqual(session.store.photos, [originalCover, second, third])
        XCTAssertTrue(session.store.movePhoto(id: third.id, to: 0))

        XCTAssertFalse(
            host.consume(router.captureBoundaryRequest),
            "A view update with the same request must not recreate the editing session."
        )
        XCTAssertTrue(host.session === session)
        XCTAssertEqual(host.session?.store.photos, [third, originalCover, second])
    }

    func testLivePhotoReviewNonFinalDeletePreservesExactSurvivorsRestoresFocusAndAnnouncesCountOnce() {
        let originalCover = makeStagedPhoto(id: "45800000-0000-4000-8000-000000000021")
        let second = makeStagedPhoto(id: "45800000-0000-4000-8000-000000000022")
        let third = makeStagedPhoto(id: "45800000-0000-4000-8000-000000000023")
        let request = CaptureBoundaryRequest(
            destination: .photoReview,
            photos: [originalCover, second, third],
            opener: .reviewButton
        )

        guard let middleSession = PhotoReviewLiveSession.start(from: request),
              let trailingSession = PhotoReviewLiveSession.start(from: request) else {
            XCTFail("Known live Photo Review requests must create isolated sessions.")
            return
        }

        middleSession.store.selectPhotoForActions(id: second.id)
        let middleResult = middleSession.deleteNonFinalPhoto(id: second.id)
        XCTAssertEqual(
            middleResult,
            PhotoReviewLiveDeleteResult(
                focus: .photo(third.id),
                announcement: "2 photos remaining."
            )
        )
        if middleResult == nil {
            XCTAssertEqual(
                middleSession.store.photos,
                [originalCover, second, third]
            )
            XCTAssertEqual(middleSession.store.selectedPhotoID, second.id)
            XCTAssertEqual(middleSession.store.actionsPhotoID, second.id)
            XCTAssertNil(middleSession.focusedPhotoID)
            XCTAssertNil(middleSession.consumeDeleteAnnouncement())
        } else {
            XCTAssertEqual(middleSession.store.photos, [originalCover, third])
            XCTAssertEqual(middleSession.store.selectedPhotoID, third.id)
            XCTAssertNil(middleSession.store.actionsPhotoID)
            XCTAssertEqual(middleSession.focusedPhotoID, third.id)
            XCTAssertEqual(
                middleSession.consumeDeleteAnnouncement(),
                "2 photos remaining."
            )
            XCTAssertNil(middleSession.consumeDeleteAnnouncement())

            let stateAfterDelete = middleSession.store.photos
            XCTAssertNil(middleSession.deleteNonFinalPhoto(id: second.id))
            XCTAssertEqual(middleSession.store.photos, stateAfterDelete)
            XCTAssertEqual(middleSession.focusedPhotoID, third.id)
            XCTAssertNil(middleSession.consumeDeleteAnnouncement())
        }

        trailingSession.store.selectPhotoForActions(id: third.id)
        let trailingResult = trailingSession.deleteNonFinalPhoto(id: third.id)
        XCTAssertEqual(
            trailingResult,
            PhotoReviewLiveDeleteResult(
                focus: .photo(second.id),
                announcement: "2 photos remaining."
            )
        )
        if trailingResult == nil {
            XCTAssertEqual(
                trailingSession.store.photos,
                [originalCover, second, third]
            )
            XCTAssertEqual(trailingSession.store.selectedPhotoID, third.id)
            XCTAssertEqual(trailingSession.store.actionsPhotoID, third.id)
            XCTAssertNil(trailingSession.focusedPhotoID)
            XCTAssertNil(trailingSession.consumeDeleteAnnouncement())
        } else {
            XCTAssertEqual(trailingSession.store.photos, [originalCover, second])
            XCTAssertEqual(trailingSession.store.selectedPhotoID, second.id)
            XCTAssertNil(trailingSession.store.actionsPhotoID)
            XCTAssertEqual(trailingSession.focusedPhotoID, second.id)
            XCTAssertEqual(
                trailingSession.consumeDeleteAnnouncement(),
                "2 photos remaining."
            )
            XCTAssertNil(trailingSession.consumeDeleteAnnouncement())
        }
    }

    func testLivePhotoReviewFinalDeleteReturnsExactEmptyScanStateAndClearsSessionOnce() {
        let onlyPhoto = makeStagedPhoto(id: "45800000-0000-4000-8000-000000000031")
        let router = AppRouter(initialFullScreen: .guidedCamera)
        router.openCaptureBoundary(
            destination: .photoReview,
            photos: [onlyPhoto],
            opener: .reviewButton
        )
        let request = router.captureBoundaryRequest
        let host = PhotoReviewLiveHost()

        XCTAssertTrue(host.consume(request))
        guard let session = host.session else {
            XCTFail("The exact one-photo request must expose one live session.")
            return
        }
        XCTAssertTrue(session.store.selectPhotoForActions(id: onlyPhoto.id))

        let result = host.deleteFinalPhoto(id: onlyPhoto.id, using: router)
        let expectedReturn = PhotoReviewScanReturn(
            photos: [],
            focus: .addPhotoButton
        )
        XCTAssertEqual(
            result,
            PhotoReviewLiveFinalDeleteResult(
                scanReturn: expectedReturn,
                announcement: "0 photos remaining. Returning to Scan."
            )
        )

        if result == nil {
            XCTAssertEqual(session.store.photos, [onlyPhoto])
            XCTAssertEqual(session.store.selectedPhotoID, onlyPhoto.id)
            XCTAssertEqual(session.store.actionsPhotoID, onlyPhoto.id)
            XCTAssertTrue(host.session === session)
            XCTAssertEqual(router.captureBoundaryRequest, request)
            XCTAssertNil(router.photoReviewScanReturn)
            XCTAssertNil(host.consumeFinalDeleteAnnouncement())
        } else {
            XCTAssertTrue(session.store.photos.isEmpty)
            XCTAssertNil(session.store.selectedPhotoID)
            XCTAssertNil(session.store.actionsPhotoID)
            XCTAssertNil(host.session)
            XCTAssertNil(router.captureBoundaryRequest)
            XCTAssertEqual(router.photoReviewScanReturn, expectedReturn)
            XCTAssertEqual(router.presentedFullScreen, .guidedCamera)
            XCTAssertEqual(
                host.consumeFinalDeleteAnnouncement(),
                "0 photos remaining. Returning to Scan."
            )
            XCTAssertNil(host.consumeFinalDeleteAnnouncement())

            XCTAssertNil(host.deleteFinalPhoto(id: onlyPhoto.id, using: router))
            XCTAssertNil(host.session)
            XCTAssertEqual(router.photoReviewScanReturn, expectedReturn)
            XCTAssertNil(host.consumeFinalDeleteAnnouncement())
        }
    }

    func testPhotoReviewDirectReplacementRetargetsOnlyMatchingStableIdentities() {
        let fingerprints = [
            "direct-replace-photo-a-digest",
            "direct-replace-photo-b-digest",
            "direct-replace-photo-c-digest",
            "direct-replace-photo-f-digest"
        ]
        let photos = [
            makePickerPhoto(
                id: "45500000-0000-4000-8000-000000000071",
                ordinal: 0,
                fingerprints: fingerprints
            ),
            makePickerPhoto(
                id: "45500000-0000-4000-8000-000000000072",
                ordinal: 1,
                fingerprints: fingerprints
            ),
            makePickerPhoto(
                id: "45500000-0000-4000-8000-000000000073",
                ordinal: 2,
                fingerprints: fingerprints
            )
        ]
        let replacement = makePickerPhoto(
            id: "45500000-0000-4000-8000-000000000076",
            ordinal: 5,
            fingerprints: fingerprints
        )

        let referencedStore = PhotoReviewStore(photos: photos)
        XCTAssertTrue(referencedStore.selectPhotoForActions(id: photos[1].id))

        XCTAssertTrue(
            referencedStore.replacePhoto(id: photos[1].id, with: replacement)
        )
        XCTAssertEqual(referencedStore.photos, [photos[0], replacement, photos[2]])
        XCTAssertEqual(referencedStore.photos[0], photos[0])
        XCTAssertEqual(referencedStore.photos[2], photos[2])
        XCTAssertEqual(referencedStore.selectedPhotoID, replacement.id)
        XCTAssertEqual(referencedStore.actionsPhotoID, replacement.id)

        let referencedState = referencedStore.photos
        XCTAssertFalse(
            referencedStore.replacePhoto(id: photos[1].id, with: replacement)
        )
        XCTAssertEqual(referencedStore.photos, referencedState)
        XCTAssertEqual(referencedStore.selectedPhotoID, replacement.id)
        XCTAssertEqual(referencedStore.actionsPhotoID, replacement.id)

        let unrelatedStore = PhotoReviewStore(photos: photos)
        XCTAssertTrue(unrelatedStore.selectPhotoForActions(id: photos[0].id))

        XCTAssertTrue(
            unrelatedStore.replacePhoto(id: photos[1].id, with: replacement)
        )
        XCTAssertEqual(unrelatedStore.photos, [photos[0], replacement, photos[2]])
        XCTAssertEqual(unrelatedStore.photos[0], photos[0])
        XCTAssertEqual(unrelatedStore.photos[2], photos[2])
        XCTAssertEqual(unrelatedStore.selectedPhotoID, photos[0].id)
        XCTAssertEqual(unrelatedStore.actionsPhotoID, photos[0].id)

        let unrelatedState = unrelatedStore.photos
        let unknownID = UUID(uuidString: "45500000-0000-4000-8000-000000000079")!
        XCTAssertFalse(unrelatedStore.replacePhoto(id: unknownID, with: replacement))
        XCTAssertEqual(unrelatedStore.photos, unrelatedState)
        XCTAssertEqual(unrelatedStore.selectedPhotoID, photos[0].id)
        XCTAssertEqual(unrelatedStore.actionsPhotoID, photos[0].id)
    }

    func testDeletingFinalPhotoReturnsToZeroPhotoScanWithoutPhotoReviewShell() {
        let onlyPhoto = makeStagedPhoto(id: "45500000-0000-4000-8000-000000000005")
        let store = PhotoReviewStore(photos: [onlyPhoto])
        let router = AppRouter(initialFullScreen: .guidedCamera)
        router.openCaptureBoundary(
            destination: .photoReview,
            photos: store.photos,
            opener: .reviewButton
        )

        XCTAssertTrue(store.deletePhoto(id: onlyPhoto.id))

        let returned = PhotoReviewScanReturn(
            photos: store.photos,
            focus: .reviewButton
        )
        router.returnFromPhotoReview(returned)

        XCTAssertEqual(router.photoReviewScanReturn, returned)
        XCTAssertTrue(returned.photos.isEmpty)
        XCTAssertNil(router.captureBoundaryRequest)
        XCTAssertEqual(router.presentedFullScreen, .guidedCamera)
    }

    func testPhotoReviewPickerCancellationPreservesExactStateAndRestoresTheTypedOpener() {
        let fingerprints = [
            "picker-photo-a-digest",
            "picker-photo-b-digest",
            "picker-photo-c-digest"
        ]
        let photos = [
            makePickerPhoto(
                id: "45500000-0000-4000-8000-000000000011",
                ordinal: 0,
                fingerprints: fingerprints
            ),
            makePickerPhoto(
                id: "45500000-0000-4000-8000-000000000012",
                ordinal: 1,
                fingerprints: fingerprints
            ),
            makePickerPhoto(
                id: "45500000-0000-4000-8000-000000000013",
                ordinal: 2,
                fingerprints: fingerprints
            )
        ]
        let store = PhotoReviewStore(photos: photos)
        XCTAssertTrue(store.selectPhotoForActions(id: photos[1].id))

        let expectedPhotos = store.photos
        let expectedIDs = expectedPhotos.map(\.id)
        let expectedPhotoURLs = expectedPhotos.map(\.photoURL)
        let expectedThumbnailURLs = expectedPhotos.map(\.thumbnailURL)
        let expectedCreatedAt = expectedPhotos.map(\.createdAt)
        let expectedReceipts = expectedPhotos.map(\.libraryTransferReceipt)
        let expectedSelectedID = store.selectedPhotoID
        let expectedActionsID = store.actionsPhotoID

        func assertExactValueState() {
            XCTAssertEqual(store.photos, expectedPhotos)
            XCTAssertEqual(store.photos.map(\.id), expectedIDs)
            XCTAssertEqual(store.photos.map(\.photoURL), expectedPhotoURLs)
            XCTAssertEqual(store.photos.map(\.thumbnailURL), expectedThumbnailURLs)
            XCTAssertEqual(store.photos.map(\.createdAt), expectedCreatedAt)
            XCTAssertEqual(store.photos.map(\.libraryTransferReceipt), expectedReceipts)
            XCTAssertEqual(store.selectedPhotoID, expectedSelectedID)
            XCTAssertEqual(store.actionsPhotoID, expectedActionsID)
        }

        store.beginPickerRequest(.add)
        XCTAssertEqual(store.activePickerRequest, PhotoReviewPickerRequest.add)
        XCTAssertEqual(store.cancelPickerRequest(), PhotoReviewPickerOpener.addButton)
        XCTAssertNil(store.activePickerRequest)
        assertExactValueState()

        let replaceRequest = PhotoReviewPickerRequest.replace(photoID: photos[1].id)
        store.beginPickerRequest(replaceRequest)
        XCTAssertEqual(store.activePickerRequest, replaceRequest)
        XCTAssertEqual(
            store.cancelPickerRequest(),
            PhotoReviewPickerOpener.replaceButton(photoID: photos[1].id)
        )
        XCTAssertNil(store.activePickerRequest)
        assertExactValueState()
    }

    func testPhotoReviewSystemPickerCancellationPreservesExactStateAndRestoresTypedOpener() {
        let fingerprints = [
            "picker-presentation-a-digest",
            "picker-presentation-b-digest",
            "picker-presentation-c-digest"
        ]
        let photos = [
            makePickerPhoto(
                id: "45500000-0000-4000-8000-000000000031",
                ordinal: 0,
                fingerprints: fingerprints
            ),
            makePickerPhoto(
                id: "45500000-0000-4000-8000-000000000032",
                ordinal: 1,
                fingerprints: fingerprints
            ),
            makePickerPhoto(
                id: "45500000-0000-4000-8000-000000000033",
                ordinal: 2,
                fingerprints: fingerprints
            )
        ]

        func assertExactState(
            _ store: PhotoReviewStore,
            selectedPhotoID: StagedCapturePhoto.ID,
            actionsPhotoID: StagedCapturePhoto.ID
        ) {
            XCTAssertEqual(store.photos, photos)
            XCTAssertEqual(store.photos.map(\.id), photos.map(\.id))
            XCTAssertEqual(store.photos.map(\.photoURL), photos.map(\.photoURL))
            XCTAssertEqual(
                store.photos.map(\.thumbnailURL),
                photos.map(\.thumbnailURL)
            )
            XCTAssertEqual(store.photos.map(\.createdAt), photos.map(\.createdAt))
            XCTAssertEqual(
                store.photos.map(\.libraryTransferReceipt),
                photos.map(\.libraryTransferReceipt)
            )
            XCTAssertEqual(store.selectedPhotoID, selectedPhotoID)
            XCTAssertEqual(store.actionsPhotoID, actionsPhotoID)
        }

        let addStore = PhotoReviewStore(photos: photos)
        XCTAssertTrue(addStore.selectPhotoForActions(id: photos[1].id))
        let addPresentation = PhotoReviewPickerPresentation()

        addPresentation.present(.add, store: addStore)

        XCTAssertTrue(addPresentation.isPresented)
        XCTAssertEqual(addStore.activePickerRequest, PhotoReviewPickerRequest.add)
        XCTAssertNil(addPresentation.cancellationFocus)
        XCTAssertEqual(
            addPresentation.dismiss(
                hasConfirmedSelection: false,
                store: addStore
            ),
            PhotoReviewPickerOpener.addButton
        )
        XCTAssertFalse(addPresentation.isPresented)
        XCTAssertEqual(
            addPresentation.cancellationFocus,
            PhotoReviewPickerOpener.addButton
        )
        XCTAssertNil(addStore.activePickerRequest)
        assertExactState(
            addStore,
            selectedPhotoID: photos[1].id,
            actionsPhotoID: photos[1].id
        )

        let addFocusAfterCancellation = addPresentation.cancellationFocus
        XCTAssertNil(
            addPresentation.dismiss(
                hasConfirmedSelection: false,
                store: addStore
            )
        )
        XCTAssertEqual(addPresentation.cancellationFocus, addFocusAfterCancellation)
        assertExactState(
            addStore,
            selectedPhotoID: photos[1].id,
            actionsPhotoID: photos[1].id
        )

        let replaceStore = PhotoReviewStore(photos: photos)
        XCTAssertTrue(replaceStore.selectPhotoForActions(id: photos[1].id))
        let replacePresentation = PhotoReviewPickerPresentation()
        let replaceRequest = PhotoReviewPickerRequest.replace(photoID: photos[1].id)

        replacePresentation.present(replaceRequest, store: replaceStore)

        XCTAssertTrue(replacePresentation.isPresented)
        XCTAssertEqual(replaceStore.activePickerRequest, replaceRequest)
        XCTAssertNil(replacePresentation.cancellationFocus)
        XCTAssertEqual(
            replacePresentation.dismiss(
                hasConfirmedSelection: false,
                store: replaceStore
            ),
            PhotoReviewPickerOpener.replaceButton(photoID: photos[1].id)
        )
        XCTAssertFalse(replacePresentation.isPresented)
        XCTAssertEqual(
            replacePresentation.cancellationFocus,
            PhotoReviewPickerOpener.replaceButton(photoID: photos[1].id)
        )
        XCTAssertNil(replaceStore.activePickerRequest)
        assertExactState(
            replaceStore,
            selectedPhotoID: photos[1].id,
            actionsPhotoID: photos[1].id
        )

        let replaceFocusAfterCancellation = replacePresentation.cancellationFocus
        XCTAssertNil(
            replacePresentation.dismiss(
                hasConfirmedSelection: false,
                store: replaceStore
            )
        )
        XCTAssertEqual(
            replacePresentation.cancellationFocus,
            replaceFocusAfterCancellation
        )
        assertExactState(
            replaceStore,
            selectedPhotoID: photos[1].id,
            actionsPhotoID: photos[1].id
        )

        let confirmedStore = PhotoReviewStore(photos: photos)
        XCTAssertTrue(confirmedStore.selectPhotoForActions(id: photos[1].id))
        let confirmedPresentation = PhotoReviewPickerPresentation()

        confirmedPresentation.present(.add, store: confirmedStore)
        XCTAssertTrue(confirmedPresentation.isPresented)
        XCTAssertEqual(
            confirmedStore.activePickerRequest,
            PhotoReviewPickerRequest.add
        )
        XCTAssertNil(
            confirmedPresentation.dismiss(
                hasConfirmedSelection: true,
                store: confirmedStore
            )
        )
        XCTAssertFalse(confirmedPresentation.isPresented)
        XCTAssertNil(confirmedPresentation.cancellationFocus)
        XCTAssertEqual(
            confirmedStore.activePickerRequest,
            PhotoReviewPickerRequest.add
        )
        assertExactState(
            confirmedStore,
            selectedPhotoID: photos[1].id,
            actionsPhotoID: photos[1].id
        )
    }

    func testPhotoReviewOutsideDismissalPreservesExactStateAndRestoresSelectedThumbnailFocus() {
        let fingerprints = [
            "outside-dismiss-a-digest",
            "outside-dismiss-b-digest",
            "outside-dismiss-c-digest"
        ]
        let photos = [
            makePickerPhoto(
                id: "45500000-0000-4000-8000-000000000041",
                ordinal: 0,
                fingerprints: fingerprints
            ),
            makePickerPhoto(
                id: "45500000-0000-4000-8000-000000000042",
                ordinal: 1,
                fingerprints: fingerprints
            ),
            makePickerPhoto(
                id: "45500000-0000-4000-8000-000000000043",
                ordinal: 2,
                fingerprints: fingerprints
            )
        ]
        let store = PhotoReviewStore(photos: photos)
        XCTAssertTrue(store.selectPhotoForActions(id: photos[1].id))
        let presentation = PhotoReviewActionPresentation()

        let expectedPhotos = store.photos
        let expectedIDs = expectedPhotos.map(\.id)
        let expectedPhotoURLs = expectedPhotos.map(\.photoURL)
        let expectedThumbnailURLs = expectedPhotos.map(\.thumbnailURL)
        let expectedCreatedAt = expectedPhotos.map(\.createdAt)
        let expectedReceipts = expectedPhotos.map(\.libraryTransferReceipt)
        let expectedSelectedID = store.selectedPhotoID
        let expectedPickerRequest = store.activePickerRequest

        func assertUnrelatedStateIsExact() {
            XCTAssertEqual(store.photos, expectedPhotos)
            XCTAssertEqual(store.photos.map(\.id), expectedIDs)
            XCTAssertEqual(store.photos.map(\.photoURL), expectedPhotoURLs)
            XCTAssertEqual(store.photos.map(\.thumbnailURL), expectedThumbnailURLs)
            XCTAssertEqual(store.photos.map(\.createdAt), expectedCreatedAt)
            XCTAssertEqual(store.photos.map(\.libraryTransferReceipt), expectedReceipts)
            XCTAssertEqual(store.selectedPhotoID, expectedSelectedID)
            XCTAssertEqual(store.activePickerRequest, expectedPickerRequest)
        }

        let focusedPhotoID = presentation.dismissOutside(store: store)

        XCTAssertNil(store.actionsPhotoID)
        XCTAssertEqual(focusedPhotoID, photos[1].id)
        XCTAssertEqual(presentation.focusedPhotoID, photos[1].id)
        assertUnrelatedStateIsExact()

        let focusAfterDismissal = presentation.focusedPhotoID
        XCTAssertNil(presentation.dismissOutside(store: store))
        XCTAssertEqual(presentation.focusedPhotoID, focusAfterDismissal)
        assertUnrelatedStateIsExact()
    }

    func testPhotoReviewDeletePreservesExactSurvivorsAndReturnsNextPreviousThenAddFocus() {
        let fingerprints = [
            "delete-focus-a-digest",
            "delete-focus-b-digest",
            "delete-focus-c-digest"
        ]
        let photos = [
            makePickerPhoto(
                id: "45500000-0000-4000-8000-000000000051",
                ordinal: 0,
                fingerprints: fingerprints
            ),
            makePickerPhoto(
                id: "45500000-0000-4000-8000-000000000052",
                ordinal: 1,
                fingerprints: fingerprints
            ),
            makePickerPhoto(
                id: "45500000-0000-4000-8000-000000000053",
                ordinal: 2,
                fingerprints: fingerprints
            )
        ]

        func assertExactSurvivors(
            _ store: PhotoReviewStore,
            _ expected: [StagedCapturePhoto]
        ) {
            XCTAssertEqual(store.photos, expected)
            XCTAssertEqual(store.photos.map(\.id), expected.map(\.id))
            XCTAssertEqual(store.photos.map(\.photoURL), expected.map(\.photoURL))
            XCTAssertEqual(
                store.photos.map(\.thumbnailURL),
                expected.map(\.thumbnailURL)
            )
            XCTAssertEqual(store.photos.map(\.createdAt), expected.map(\.createdAt))
            XCTAssertEqual(
                store.photos.map(\.libraryTransferReceipt),
                expected.map(\.libraryTransferReceipt)
            )
        }

        let middleStore = PhotoReviewStore(photos: photos)
        XCTAssertTrue(middleStore.selectPhotoForActions(id: photos[1].id))
        middleStore.beginPickerRequest(.add)

        XCTAssertEqual(
            middleStore.deletePhotoForReview(id: photos[1].id),
            PhotoReviewDeleteFocus.photo(photos[2].id)
        )
        assertExactSurvivors(middleStore, [photos[0], photos[2]])
        XCTAssertEqual(middleStore.selectedPhotoID, photos[2].id)
        XCTAssertNil(middleStore.actionsPhotoID)
        XCTAssertEqual(middleStore.activePickerRequest, PhotoReviewPickerRequest.add)

        let middleStateAfterDeletion = middleStore.photos
        XCTAssertNil(middleStore.deletePhotoForReview(id: photos[1].id))
        assertExactSurvivors(middleStore, middleStateAfterDeletion)
        XCTAssertEqual(middleStore.selectedPhotoID, photos[2].id)
        XCTAssertNil(middleStore.actionsPhotoID)
        XCTAssertEqual(middleStore.activePickerRequest, PhotoReviewPickerRequest.add)

        let trailingStore = PhotoReviewStore(photos: photos)
        XCTAssertTrue(trailingStore.selectPhotoForActions(id: photos[2].id))
        let pickerRequest = PhotoReviewPickerRequest.replace(photoID: photos[0].id)
        trailingStore.beginPickerRequest(pickerRequest)

        XCTAssertEqual(
            trailingStore.deletePhotoForReview(id: photos[2].id),
            PhotoReviewDeleteFocus.photo(photos[1].id)
        )
        assertExactSurvivors(trailingStore, [photos[0], photos[1]])
        XCTAssertEqual(trailingStore.selectedPhotoID, photos[1].id)
        XCTAssertNil(trailingStore.actionsPhotoID)
        XCTAssertEqual(trailingStore.activePickerRequest, pickerRequest)

        let trailingStateAfterDeletion = trailingStore.photos
        XCTAssertNil(
            trailingStore.deletePhotoForReview(
                id: UUID(uuidString: "45500000-0000-4000-8000-000000000099")!
            )
        )
        assertExactSurvivors(trailingStore, trailingStateAfterDeletion)
        XCTAssertEqual(trailingStore.selectedPhotoID, photos[1].id)
        XCTAssertNil(trailingStore.actionsPhotoID)
        XCTAssertEqual(trailingStore.activePickerRequest, pickerRequest)

        let soleStore = PhotoReviewStore(photos: [photos[0]])
        XCTAssertTrue(soleStore.selectPhotoForActions(id: photos[0].id))
        soleStore.beginPickerRequest(.add)

        XCTAssertEqual(
            soleStore.deletePhotoForReview(id: photos[0].id),
            PhotoReviewDeleteFocus.addButton
        )
        assertExactSurvivors(soleStore, [])
        XCTAssertNil(soleStore.selectedPhotoID)
        XCTAssertNil(soleStore.actionsPhotoID)
        XCTAssertEqual(soleStore.activePickerRequest, PhotoReviewPickerRequest.add)

        XCTAssertNil(soleStore.deletePhotoForReview(id: photos[0].id))
        assertExactSurvivors(soleStore, [])
        XCTAssertNil(soleStore.selectedPhotoID)
        XCTAssertNil(soleStore.actionsPhotoID)
        XCTAssertEqual(soleStore.activePickerRequest, PhotoReviewPickerRequest.add)
    }

    func testPhotoReviewAccessibilityReorderPreservesExactValuesAndReturnsOneAnnouncement() {
        let fingerprints = [
            "reorder-a-digest",
            "reorder-b-digest",
            "reorder-c-digest"
        ]
        let photos = [
            makePickerPhoto(
                id: "45500000-0000-4000-8000-000000000061",
                ordinal: 0,
                fingerprints: fingerprints
            ),
            makePickerPhoto(
                id: "45500000-0000-4000-8000-000000000062",
                ordinal: 1,
                fingerprints: fingerprints
            ),
            makePickerPhoto(
                id: "45500000-0000-4000-8000-000000000063",
                ordinal: 2,
                fingerprints: fingerprints
            )
        ]

        func assertExactPhotoValues(_ store: PhotoReviewStore) {
            XCTAssertEqual(store.photos.count, photos.count)
            for photo in photos {
                XCTAssertEqual(
                    store.photos.first(where: { $0.id == photo.id }),
                    photo
                )
            }
        }

        let moveEarlierStore = PhotoReviewStore(photos: photos)
        XCTAssertTrue(moveEarlierStore.selectPhotoForActions(id: photos[2].id))
        let earlierPickerRequest = PhotoReviewPickerRequest.replace(
            photoID: photos[0].id
        )
        moveEarlierStore.beginPickerRequest(earlierPickerRequest)

        XCTAssertEqual(
            moveEarlierStore.performAccessibilityReorder(
                photoID: photos[1].id,
                action: .moveEarlier
            ),
            PhotoReviewReorderResult(
                photoID: photos[1].id,
                index: 1,
                count: 3,
                announcement: "Moved to photo 1 of 3. Cover."
            )
        )
        XCTAssertEqual(moveEarlierStore.photos.map(\.id), [
            photos[1].id,
            photos[0].id,
            photos[2].id
        ])
        XCTAssertEqual(moveEarlierStore.selectedPhotoID, photos[1].id)
        XCTAssertNil(moveEarlierStore.actionsPhotoID)
        XCTAssertEqual(moveEarlierStore.activePickerRequest, earlierPickerRequest)
        assertExactPhotoValues(moveEarlierStore)

        let moveLaterStore = PhotoReviewStore(photos: photos)
        XCTAssertTrue(moveLaterStore.selectPhotoForActions(id: photos[0].id))
        moveLaterStore.beginPickerRequest(.add)

        XCTAssertEqual(
            moveLaterStore.performAccessibilityReorder(
                photoID: photos[1].id,
                action: .moveLater
            ),
            PhotoReviewReorderResult(
                photoID: photos[1].id,
                index: 3,
                count: 3,
                announcement: "Moved to photo 3 of 3."
            )
        )
        XCTAssertEqual(moveLaterStore.photos.map(\.id), [
            photos[0].id,
            photos[2].id,
            photos[1].id
        ])
        XCTAssertEqual(moveLaterStore.selectedPhotoID, photos[1].id)
        XCTAssertNil(moveLaterStore.actionsPhotoID)
        XCTAssertEqual(
            moveLaterStore.activePickerRequest,
            PhotoReviewPickerRequest.add
        )
        assertExactPhotoValues(moveLaterStore)

        let makeCoverStore = PhotoReviewStore(photos: photos)
        XCTAssertTrue(makeCoverStore.selectPhotoForActions(id: photos[2].id))
        let coverPickerRequest = PhotoReviewPickerRequest.replace(
            photoID: photos[1].id
        )
        makeCoverStore.beginPickerRequest(coverPickerRequest)

        XCTAssertEqual(
            makeCoverStore.performAccessibilityReorder(
                photoID: photos[2].id,
                action: .makeCover
            ),
            PhotoReviewReorderResult(
                photoID: photos[2].id,
                index: 1,
                count: 3,
                announcement: "Moved to photo 1 of 3. Cover."
            )
        )
        XCTAssertEqual(makeCoverStore.photos.map(\.id), [
            photos[2].id,
            photos[0].id,
            photos[1].id
        ])
        XCTAssertEqual(makeCoverStore.selectedPhotoID, photos[2].id)
        XCTAssertEqual(makeCoverStore.actionsPhotoID, photos[2].id)
        XCTAssertEqual(makeCoverStore.activePickerRequest, coverPickerRequest)
        assertExactPhotoValues(makeCoverStore)

        let invalidStore = PhotoReviewStore(photos: photos)
        XCTAssertTrue(invalidStore.selectPhotoForActions(id: photos[1].id))
        invalidStore.beginPickerRequest(.add)
        let invalidExpectedPhotos = invalidStore.photos

        XCTAssertNil(
            invalidStore.performAccessibilityReorder(
                photoID: photos[0].id,
                action: .moveEarlier
            )
        )
        XCTAssertNil(
            invalidStore.performAccessibilityReorder(
                photoID: photos[2].id,
                action: .moveLater
            )
        )
        XCTAssertNil(
            invalidStore.performAccessibilityReorder(
                photoID: photos[0].id,
                action: .makeCover
            )
        )
        XCTAssertNil(
            invalidStore.performAccessibilityReorder(
                photoID: UUID(
                    uuidString: "45500000-0000-4000-8000-000000000099"
                )!,
                action: .makeCover
            )
        )
        XCTAssertEqual(invalidStore.photos, invalidExpectedPhotos)
        XCTAssertEqual(invalidStore.selectedPhotoID, photos[1].id)
        XCTAssertEqual(invalidStore.actionsPhotoID, photos[1].id)
        XCTAssertEqual(
            invalidStore.activePickerRequest,
            PhotoReviewPickerRequest.add
        )
        assertExactPhotoValues(invalidStore)
    }

    func testPhotoReviewAccessibilityActionPresentationRestoresStableFocusAndConsumesOneAnnouncement() {
        let fingerprints = [
            "action-presentation-a-digest",
            "action-presentation-b-digest",
            "action-presentation-c-digest"
        ]
        let photos = [
            makePickerPhoto(
                id: "45500000-0000-4000-8000-000000000071",
                ordinal: 0,
                fingerprints: fingerprints
            ),
            makePickerPhoto(
                id: "45500000-0000-4000-8000-000000000072",
                ordinal: 1,
                fingerprints: fingerprints
            ),
            makePickerPhoto(
                id: "45500000-0000-4000-8000-000000000073",
                ordinal: 2,
                fingerprints: fingerprints
            )
        ]

        func assertExactPhotoValues(_ store: PhotoReviewStore) {
            XCTAssertEqual(store.photos.count, photos.count)
            for photo in photos {
                XCTAssertEqual(
                    store.photos.first(where: { $0.id == photo.id }),
                    photo
                )
            }
        }

        let availabilityStore = PhotoReviewStore(photos: photos)
        let availability = PhotoReviewAccessibilityActionPresentation()
        XCTAssertEqual(
            availability.availableActions(
                for: photos[0].id,
                in: availabilityStore
            ),
            [.moveLater]
        )
        XCTAssertEqual(
            availability.availableActions(
                for: photos[1].id,
                in: availabilityStore
            ),
            [.moveEarlier, .moveLater, .makeCover]
        )
        XCTAssertEqual(
            availability.availableActions(
                for: photos[2].id,
                in: availabilityStore
            ),
            [.moveEarlier, .makeCover]
        )
        XCTAssertEqual(
            availability.availableActions(
                for: photos[0].id,
                in: PhotoReviewStore(photos: [photos[0]])
            ),
            []
        )

        let moveEarlierStore = PhotoReviewStore(photos: photos)
        XCTAssertTrue(moveEarlierStore.selectPhotoForActions(id: photos[2].id))
        let earlierPickerRequest = PhotoReviewPickerRequest.replace(
            photoID: photos[0].id
        )
        moveEarlierStore.beginPickerRequest(earlierPickerRequest)
        let moveEarlier = PhotoReviewAccessibilityActionPresentation()

        XCTAssertEqual(
            moveEarlier.perform(
                .moveEarlier,
                photoID: photos[1].id,
                store: moveEarlierStore
            ),
            PhotoReviewReorderResult(
                photoID: photos[1].id,
                index: 1,
                count: 3,
                announcement: "Moved to photo 1 of 3. Cover."
            )
        )
        XCTAssertEqual(moveEarlierStore.photos.map(\.id), [
            photos[1].id,
            photos[0].id,
            photos[2].id
        ])
        XCTAssertEqual(moveEarlierStore.selectedPhotoID, photos[1].id)
        XCTAssertNil(moveEarlierStore.actionsPhotoID)
        XCTAssertEqual(moveEarlierStore.activePickerRequest, earlierPickerRequest)
        assertExactPhotoValues(moveEarlierStore)
        XCTAssertEqual(moveEarlier.focusedPhotoID, photos[1].id)
        XCTAssertEqual(
            moveEarlier.consumeAnnouncement(),
            "Moved to photo 1 of 3. Cover."
        )
        let earlierStateAfterConsumption = moveEarlierStore.photos
        XCTAssertNil(moveEarlier.consumeAnnouncement())
        XCTAssertEqual(moveEarlier.focusedPhotoID, photos[1].id)
        XCTAssertEqual(moveEarlierStore.photos, earlierStateAfterConsumption)

        let moveLaterStore = PhotoReviewStore(photos: photos)
        XCTAssertTrue(moveLaterStore.selectPhotoForActions(id: photos[0].id))
        moveLaterStore.beginPickerRequest(.add)
        let moveLater = PhotoReviewAccessibilityActionPresentation()

        XCTAssertEqual(
            moveLater.perform(
                .moveLater,
                photoID: photos[1].id,
                store: moveLaterStore
            ),
            PhotoReviewReorderResult(
                photoID: photos[1].id,
                index: 3,
                count: 3,
                announcement: "Moved to photo 3 of 3."
            )
        )
        XCTAssertEqual(moveLaterStore.photos.map(\.id), [
            photos[0].id,
            photos[2].id,
            photos[1].id
        ])
        XCTAssertEqual(moveLaterStore.selectedPhotoID, photos[1].id)
        XCTAssertNil(moveLaterStore.actionsPhotoID)
        XCTAssertEqual(
            moveLaterStore.activePickerRequest,
            PhotoReviewPickerRequest.add
        )
        assertExactPhotoValues(moveLaterStore)
        XCTAssertEqual(moveLater.focusedPhotoID, photos[1].id)
        XCTAssertEqual(
            moveLater.consumeAnnouncement(),
            "Moved to photo 3 of 3."
        )
        let laterStateAfterConsumption = moveLaterStore.photos
        XCTAssertNil(moveLater.consumeAnnouncement())
        XCTAssertEqual(moveLater.focusedPhotoID, photos[1].id)
        XCTAssertEqual(moveLaterStore.photos, laterStateAfterConsumption)

        let makeCoverStore = PhotoReviewStore(photos: photos)
        XCTAssertTrue(makeCoverStore.selectPhotoForActions(id: photos[2].id))
        let coverPickerRequest = PhotoReviewPickerRequest.replace(
            photoID: photos[1].id
        )
        makeCoverStore.beginPickerRequest(coverPickerRequest)
        let makeCover = PhotoReviewAccessibilityActionPresentation()

        XCTAssertEqual(
            makeCover.perform(
                .makeCover,
                photoID: photos[2].id,
                store: makeCoverStore
            ),
            PhotoReviewReorderResult(
                photoID: photos[2].id,
                index: 1,
                count: 3,
                announcement: "Moved to photo 1 of 3. Cover."
            )
        )
        XCTAssertEqual(makeCoverStore.photos.map(\.id), [
            photos[2].id,
            photos[0].id,
            photos[1].id
        ])
        XCTAssertEqual(makeCoverStore.selectedPhotoID, photos[2].id)
        XCTAssertEqual(makeCoverStore.actionsPhotoID, photos[2].id)
        XCTAssertEqual(makeCoverStore.activePickerRequest, coverPickerRequest)
        assertExactPhotoValues(makeCoverStore)
        XCTAssertEqual(makeCover.focusedPhotoID, photos[2].id)
        XCTAssertEqual(
            makeCover.consumeAnnouncement(),
            "Moved to photo 1 of 3. Cover."
        )
        let coverStateAfterConsumption = makeCoverStore.photos
        XCTAssertNil(makeCover.consumeAnnouncement())
        XCTAssertEqual(makeCover.focusedPhotoID, photos[2].id)
        XCTAssertEqual(makeCoverStore.photos, coverStateAfterConsumption)

        let invalidStore = PhotoReviewStore(photos: photos)
        XCTAssertTrue(invalidStore.selectPhotoForActions(id: photos[1].id))
        invalidStore.beginPickerRequest(.add)
        let invalidExpectedPhotos = invalidStore.photos
        let invalid = PhotoReviewAccessibilityActionPresentation()

        XCTAssertNil(
            invalid.perform(
                .moveEarlier,
                photoID: photos[0].id,
                store: invalidStore
            )
        )
        XCTAssertNil(
            invalid.perform(
                .moveLater,
                photoID: photos[2].id,
                store: invalidStore
            )
        )
        XCTAssertNil(
            invalid.perform(
                .makeCover,
                photoID: photos[0].id,
                store: invalidStore
            )
        )
        XCTAssertNil(
            invalid.perform(
                .makeCover,
                photoID: UUID(
                    uuidString: "45500000-0000-4000-8000-000000000099"
                )!,
                store: invalidStore
            )
        )
        XCTAssertNil(invalid.focusedPhotoID)
        XCTAssertNil(invalid.pendingAnnouncement)
        XCTAssertNil(invalid.consumeAnnouncement())
        XCTAssertEqual(invalidStore.photos, invalidExpectedPhotos)
        XCTAssertEqual(invalidStore.selectedPhotoID, photos[1].id)
        XCTAssertEqual(invalidStore.actionsPhotoID, photos[1].id)
        XCTAssertEqual(
            invalidStore.activePickerRequest,
            PhotoReviewPickerRequest.add
        )
        assertExactPhotoValues(invalidStore)
    }

    func testPhotoReviewConfirmedPickerResultsPreserveExactValuesOrderAndRequestConsumption() {
        let fingerprints = [
            "picker-photo-a-digest",
            "picker-photo-b-digest",
            "picker-photo-c-digest",
            "picker-photo-d-digest",
            "picker-photo-e-digest",
            "picker-photo-f-digest"
        ]
        let originalPhotos = [
            makePickerPhoto(
                id: "45500000-0000-4000-8000-000000000021",
                ordinal: 0,
                fingerprints: fingerprints
            ),
            makePickerPhoto(
                id: "45500000-0000-4000-8000-000000000022",
                ordinal: 1,
                fingerprints: fingerprints
            ),
            makePickerPhoto(
                id: "45500000-0000-4000-8000-000000000023",
                ordinal: 2,
                fingerprints: fingerprints
            )
        ]
        let additions = [
            makePickerPhoto(
                id: "45500000-0000-4000-8000-000000000024",
                ordinal: 3,
                fingerprints: fingerprints
            ),
            makePickerPhoto(
                id: "45500000-0000-4000-8000-000000000025",
                ordinal: 4,
                fingerprints: fingerprints
            )
        ]
        let replacement = makePickerPhoto(
            id: "45500000-0000-4000-8000-000000000026",
            ordinal: 5,
            fingerprints: fingerprints
        )

        let addStore = PhotoReviewStore(photos: originalPhotos)
        XCTAssertTrue(addStore.selectPhotoForActions(id: originalPhotos[1].id))
        addStore.beginPickerRequest(.add)

        XCTAssertEqual(
            addStore.confirmPickerResult(.additions(additions)),
            additions[1].id
        )
        XCTAssertEqual(addStore.photos, originalPhotos + additions)
        XCTAssertEqual(Array(addStore.photos.prefix(3)), originalPhotos)
        XCTAssertEqual(addStore.selectedPhotoID, originalPhotos[1].id)
        XCTAssertEqual(addStore.actionsPhotoID, originalPhotos[1].id)
        XCTAssertNil(addStore.activePickerRequest)

        let addStateAfterConfirmation = addStore.photos
        XCTAssertNil(addStore.confirmPickerResult(.additions(additions)))
        XCTAssertEqual(addStore.photos, addStateAfterConfirmation)
        XCTAssertEqual(addStore.selectedPhotoID, originalPhotos[1].id)
        XCTAssertEqual(addStore.actionsPhotoID, originalPhotos[1].id)
        XCTAssertNil(addStore.activePickerRequest)

        let referencedReplaceStore = PhotoReviewStore(photos: originalPhotos)
        XCTAssertTrue(
            referencedReplaceStore.selectPhotoForActions(id: originalPhotos[1].id)
        )
        let replaceRequest = PhotoReviewPickerRequest.replace(
            photoID: originalPhotos[1].id
        )
        referencedReplaceStore.beginPickerRequest(replaceRequest)

        XCTAssertEqual(
            referencedReplaceStore.confirmPickerResult(.replacement(replacement)),
            replacement.id
        )
        XCTAssertEqual(
            referencedReplaceStore.photos,
            [originalPhotos[0], replacement, originalPhotos[2]]
        )
        XCTAssertEqual(referencedReplaceStore.photos[0], originalPhotos[0])
        XCTAssertEqual(referencedReplaceStore.photos[2], originalPhotos[2])
        XCTAssertEqual(referencedReplaceStore.selectedPhotoID, replacement.id)
        XCTAssertEqual(referencedReplaceStore.actionsPhotoID, replacement.id)
        XCTAssertNil(referencedReplaceStore.activePickerRequest)

        let replaceStateAfterConfirmation = referencedReplaceStore.photos
        XCTAssertNil(
            referencedReplaceStore.confirmPickerResult(.replacement(replacement))
        )
        XCTAssertEqual(referencedReplaceStore.photos, replaceStateAfterConfirmation)
        XCTAssertEqual(referencedReplaceStore.selectedPhotoID, replacement.id)
        XCTAssertEqual(referencedReplaceStore.actionsPhotoID, replacement.id)
        XCTAssertNil(referencedReplaceStore.activePickerRequest)

        let unrelatedReplaceStore = PhotoReviewStore(photos: originalPhotos)
        XCTAssertTrue(
            unrelatedReplaceStore.selectPhotoForActions(id: originalPhotos[0].id)
        )
        unrelatedReplaceStore.beginPickerRequest(replaceRequest)

        XCTAssertEqual(
            unrelatedReplaceStore.confirmPickerResult(.replacement(replacement)),
            replacement.id
        )
        XCTAssertEqual(
            unrelatedReplaceStore.photos,
            [originalPhotos[0], replacement, originalPhotos[2]]
        )
        XCTAssertEqual(unrelatedReplaceStore.photos[0], originalPhotos[0])
        XCTAssertEqual(unrelatedReplaceStore.photos[2], originalPhotos[2])
        XCTAssertEqual(unrelatedReplaceStore.selectedPhotoID, originalPhotos[0].id)
        XCTAssertEqual(unrelatedReplaceStore.actionsPhotoID, originalPhotos[0].id)
        XCTAssertNil(unrelatedReplaceStore.activePickerRequest)
    }

    func testManualShutterStaysAvailableAfterFirstCaptureWithoutAVisionVerdict() async {
        let camera = TestCaptureCamera(isAvailable: true, authorization: .authorized)
        let store = TestCaptureStore()
        let model = makeModel(camera: camera, store: store)

        await model.startCamera()

        XCTAssertTrue(model.canTakePhoto)
        await model.takePhoto()
        XCTAssertEqual(model.phase, .camera)
        XCTAssertNotNil(model.stagedPhoto)
        XCTAssertEqual(camera.stopCount, 0)
        XCTAssertTrue(model.canTakePhoto)
    }

    func testManualCaptureAppendsFivePhotosInOrderAndMakesTheSixthAttemptInert() async {
        let camera = TestCaptureCamera(isAvailable: true, authorization: .authorized)
        let store = TestCaptureStore()
        let model = makeModel(camera: camera, store: store)

        await model.startCamera()
        for _ in 0..<5 {
            XCTAssertTrue(model.canTakePhoto)
            await model.takePhoto()
        }

        XCTAssertEqual(model.stagedPhotos.map(\.id), store.stagedPhotos.map(\.id))
        XCTAssertEqual(model.stagedPhotos.count, 5)
        XCTAssertFalse(model.canTakePhoto)

        await model.takePhoto()

        XCTAssertEqual(camera.captureCount, 5)
        XCTAssertEqual(model.stagedPhotos.count, 5)
    }

    private func makeStagedPhoto(id: String) -> StagedCapturePhoto {
        let photoID = UUID(uuidString: id)!
        return StagedCapturePhoto(
            id: photoID,
            photoURL: URL(fileURLWithPath: "/tmp/photo-\(photoID).jpg"),
            thumbnailURL: URL(fileURLWithPath: "/tmp/thumbnail-\(photoID).jpg"),
            createdAt: Date(timeIntervalSinceReferenceDate: 455)
        )
    }

    private func makePickerPhoto(
        id: String,
        ordinal: Int,
        fingerprints: [String]
    ) -> StagedCapturePhoto {
        let photoID = UUID(uuidString: id)!
        return StagedCapturePhoto(
            id: photoID,
            photoURL: URL(fileURLWithPath: "/tmp/picker-photo-\(ordinal).jpg"),
            thumbnailURL: URL(fileURLWithPath: "/tmp/picker-thumbnail-\(ordinal).jpg"),
            createdAt: Date(timeIntervalSinceReferenceDate: 455 + Double(ordinal)),
            libraryTransferReceipt: LibraryPhotoTransferReceipt(
                sourcePhotoFingerprints: fingerprints,
                sourceIndex: ordinal
            )
        )
    }

    func testLibrarySelectionAppendsInOrderOnlyThroughRemainingCapacity() async {
        let camera = TestCaptureCamera(isAvailable: true, authorization: .authorized)
        let store = TestCaptureStore()
        let model = makeModel(camera: camera, store: store)
        let libraryPhotos = (1...5).map { Data([$0]) }

        await model.startCamera()
        await model.takePhoto()
        let addedCount = await model.stageLibraryPhotos(libraryPhotos)

        XCTAssertEqual(addedCount, 4)
        XCTAssertEqual(Array(store.stagedImageData.dropFirst()), Array(libraryPhotos.prefix(4)))
        XCTAssertEqual(model.stagedPhotos.count, 5)
        XCTAssertFalse(model.canTakePhoto)
    }

    func testLibraryPickerStagesEachPayloadBeforeLoadingTheNextAndKeepsPartialProgress() async {
        let tracker = LibraryPayloadLifetimeTracker()
        let store = LifetimeTrackingCaptureStore(tracker: tracker)
        let model = CaptureFlowModel(
            camera: TestCaptureCamera(isAvailable: true, authorization: .authorized),
            evaluator: TestFramingEvaluator(observations: []),
            store: store
        )
        var didReachLaterFailure = false
        let selections = [
            TestLibraryPhotoLoader { tracker.makePayload(byte: 0x01) },
            TestLibraryPhotoLoader { tracker.makePayload(byte: 0x02) },
            TestLibraryPhotoLoader {
                didReachLaterFailure = true
                XCTAssertEqual(store.stagedBytes, [0x01, 0x02])
                throw TestCaptureError.failed
            }
        ]

        let addedCount = await model.stageLibraryPhotos(selections)

        XCTAssertEqual(addedCount, 2)
        XCTAssertTrue(didReachLaterFailure)
        XCTAssertEqual(store.stagedBytes, [0x01, 0x02])
        XCTAssertEqual(model.stagedPhotos.count, 2)
        XCTAssertEqual(tracker.maximumResidentPayloads, 1)
        XCTAssertEqual(tracker.residentPayloads, 0)
        XCTAssertEqual(
            tracker.events,
            [.loaded(0x01), .staged(0x01), .released(0x01),
             .loaded(0x02), .staged(0x02), .released(0x02)]
        )
    }

    func testFifthSuccessfulAdditionPublishesTheExactLimitAnnouncementOnce() async {
        let camera = TestCaptureCamera(isAvailable: true, authorization: .authorized)
        let model = makeModel(camera: camera)

        await model.startCamera()
        for _ in 0..<5 {
            await model.takePhoto()
        }

        XCTAssertEqual(
            model.consumePhotoLimitAnnouncement(),
            "Five photo limit reached. Review your photos."
        )
        XCTAssertNil(model.consumePhotoLimitAnnouncement())

        await model.takePhoto()

        XCTAssertNil(model.consumePhotoLimitAnnouncement())
    }

    func testShutterAccessibleNameOnlyAnnouncesTheLimitAtFiveDurablePhotos() {
        let states = [
            (
                name: "below-cap idle",
                accessibility: ScanShutterAccessibility(
                    isEnabled: true,
                    durablePhotoCount: 0
                ),
                expectedLabel: "Take photo"
            ),
            (
                name: "below-cap pending intake",
                accessibility: ScanShutterAccessibility(
                    isEnabled: false,
                    durablePhotoCount: 2
                ),
                expectedLabel: "Take photo"
            ),
            (
                name: "at cap",
                accessibility: ScanShutterAccessibility(
                    isEnabled: false,
                    durablePhotoCount: 5
                ),
                expectedLabel: "Take photo, unavailable at five photo limit"
            )
        ]

        for state in states {
            XCTAssertEqual(
                state.accessibility.label,
                state.expectedLabel,
                state.name
            )
        }
    }

    func testFlashControlOnlyTogglesWhenTheCaptureDeviceSupportsIt() async {
        let supportedCamera = TestCaptureCamera(
            isAvailable: true,
            authorization: .authorized,
            isFlashAvailable: true
        )
        let supported = makeModel(camera: supportedCamera)
        await supported.startCamera()

        XCTAssertTrue(supported.isFlashAvailable)
        XCTAssertEqual(supported.flashMode, .off)
        supported.toggleFlash()
        XCTAssertEqual(supported.flashMode, .on)
        XCTAssertEqual(supportedCamera.requestedFlashModes, [.on])

        let unsupported = makeModel()
        await unsupported.startCamera()
        unsupported.toggleFlash()
        XCTAssertEqual(unsupported.flashMode, .off)
    }

    func testUnavailableAndDeniedCameraStatesOfferHonestRecovery() async {
        let unavailableCamera = TestCaptureCamera(isAvailable: false, authorization: .authorized)
        let unavailable = makeModel(camera: unavailableCamera)

        await unavailable.startCamera()
        XCTAssertEqual(unavailable.phase, .unavailable)
        XCTAssertEqual(unavailableCamera.startCount, 0)

        let deniedCamera = TestCaptureCamera(isAvailable: true, authorization: .denied)
        let denied = makeModel(camera: deniedCamera)

        await denied.startCamera()
        XCTAssertEqual(denied.phase, .denied)
        XCTAssertEqual(deniedCamera.startCount, 0)

        let restrictedCamera = TestCaptureCamera(isAvailable: true, authorization: .restricted)
        let restricted = makeModel(camera: restrictedCamera)

        await restricted.startCamera()
        XCTAssertEqual(restricted.phase, .unavailable)
        XCTAssertEqual(restrictedCamera.startCount, 0)
    }

    func testPendingCaptureRejectsConcurrentLibraryIntakeAndBoundarySnapshot() async {
        let camera = TestCaptureCamera(
            isAvailable: true,
            authorization: .authorized,
            suspendsCapture: true
        )
        let store = TestCaptureStore()
        let model = makeModel(camera: camera, store: store)

        await model.startCamera()
        for _ in 0..<4 {
            let capture = Task { await model.takePhoto() }
            let isCapturePending = await camera.waitUntilCaptureIsPending()
            XCTAssertTrue(
                isCapturePending,
                "Capture completion requires a registered pending continuation."
            )
            guard isCapturePending else { return }
            camera.completePendingCaptures()
            await capture.value
        }

        let fifthCapture = Task { await model.takePhoto() }
        let isFifthCapturePending = await camera.waitUntilCaptureIsPending()
        XCTAssertTrue(
            isFifthCapturePending,
            "Fifth-photo completion requires a registered pending continuation."
        )
        guard isFifthCapturePending else { return }

        XCTAssertTrue(model.isAddingPhotos)
        XCTAssertFalse(model.canOpenBoundary)
        let concurrentLibraryCount = await model.stageLibraryPhotos([Data([0x01])])
        XCTAssertEqual(concurrentLibraryCount, 0)

        camera.completePendingCaptures()
        await fifthCapture.value

        XCTAssertEqual(model.stagedPhotos.count, 5)
        XCTAssertEqual(store.stageCount, 5)
        XCTAssertTrue(model.canOpenBoundary)
    }

    func testPendingCaptureReadinessTimesOutWithoutRegisteredContinuation() async {
        let camera = TestCaptureCamera(
            isAvailable: true,
            authorization: .authorized,
            suspendsCapture: true
        )

        let isCapturePending = await camera.waitUntilCaptureIsPending(
            timeoutNanoseconds: 1_000_000
        )

        XCTAssertFalse(
            isCapturePending,
            "Readiness must fail within its bound when no capture continuation registers."
        )
    }

    func testCommittedAppendUsesAtomicAuthoritativeSetWithoutASecondReload() async {
        let camera = TestCaptureCamera(isAvailable: true, authorization: .authorized)
        let store = TestCaptureStore(loadPhotosError: TestCaptureError.failed)
        let model = makeModel(camera: camera, store: store)

        await model.startCamera()
        await model.takePhoto()

        XCTAssertEqual(model.stagedPhotos, store.stagedPhotos)
        XCTAssertEqual(model.stagedPhotos.count, 1)
        XCTAssertTrue(model.canOpenBoundary)
        XCTAssertEqual(store.loadPhotosCount, 0)
    }

    func testMixedFivePhotoSetCapsOnceRejectsSixthAndRoutesExactOrderThroughAppRouter() async {
        let camera = TestCaptureCamera(isAvailable: true, authorization: .authorized)
        let model = makeModel(camera: camera)
        let router = AppRouter(initialFullScreen: .guidedCamera)

        await model.startCamera()
        await model.takePhoto()
        await model.takePhoto()
        let libraryCount = await model.stageLibraryPhotos([
            Data([0x01]), Data([0x02]), Data([0x03])
        ])
        XCTAssertEqual(libraryCount, 3)
        XCTAssertEqual(
            model.consumePhotoLimitAnnouncement(),
            "Five photo limit reached. Review your photos."
        )
        XCTAssertNil(model.consumePhotoLimitAnnouncement())

        await model.takePhoto()

        XCTAssertEqual(camera.captureCount, 2)
        XCTAssertEqual(model.stagedPhotos.count, 5)
        XCTAssertNil(model.consumePhotoLimitAnnouncement())

        XCTAssertTrue(model.canOpenBoundary)
        router.openCaptureBoundary(
            destination: .photoReview,
            photos: model.stagedPhotos,
            opener: .reviewButton
        )

        XCTAssertEqual(router.captureBoundaryRequest?.photos, model.stagedPhotos)
        XCTAssertEqual(router.captureBoundaryRequest?.photos.count, 5)
        XCTAssertEqual(
            router.captureBoundaryRequest?.photos.map(\.id),
            model.stagedPhotos.map(\.id)
        )
    }

    func testRealEvaluatorOutputNeverGatesTheManualShutterAndOnePhotoStaysInCamera() async throws {
        let camera = TestCaptureCamera(isAvailable: true, authorization: .authorized)
        let evaluator = TestFramingEvaluator(
            observations: [
                FramingObservation(subjectBounds: CGRect(x: 0.42, y: 0.38, width: 0.16, height: 0.22)),
                FramingObservation(subjectBounds: CGRect(x: 0.42, y: 0.38, width: 0.16, height: 0.22)),
                FramingObservation(subjectBounds: CGRect(x: 0.18, y: 0.14, width: 0.64, height: 0.70)),
                FramingObservation(subjectBounds: CGRect(x: 0.18, y: 0.14, width: 0.64, height: 0.70))
            ]
        )
        let store = TestCaptureStore()
        let model = makeModel(camera: camera, evaluator: evaluator, store: store)

        await model.startCamera()
        XCTAssertEqual(model.phase, .camera)
        XCTAssertTrue(model.canTakePhoto)

        for _ in 0..<2 { await model.process(frame: try makeFrame()) }
        XCTAssertEqual(model.guidance, .moveCloser)
        XCTAssertTrue(model.canTakePhoto)

        for _ in 0..<2 { await model.process(frame: try makeFrame()) }
        XCTAssertEqual(model.guidance, .accepted)
        XCTAssertTrue(model.canTakePhoto)

        await model.takePhoto()
        XCTAssertEqual(model.phase, .camera)
        XCTAssertEqual(store.stageCount, 1)
        XCTAssertNotNil(model.stagedPhoto)
        XCTAssertEqual(camera.stopCount, 0)
    }

    func testRapidSecondShutterTapCannotStartAnotherCapture() async throws {
        let camera = TestCaptureCamera(
            isAvailable: true,
            authorization: .authorized,
            suspendsCapture: true
        )
        let accepted = FramingObservation(
            subjectBounds: CGRect(x: 0.18, y: 0.14, width: 0.64, height: 0.70)
        )
        let evaluator = TestFramingEvaluator(observations: [accepted, accepted])
        let store = TestCaptureStore()
        let model = makeModel(camera: camera, evaluator: evaluator, store: store)
        await model.startCamera()
        for _ in 0..<2 { await model.process(frame: try makeFrame()) }
        XCTAssertTrue(model.canTakePhoto)

        let firstCapture = Task { await model.takePhoto() }
        let isFirstCapturePending = await camera.waitUntilCaptureIsPending()
        XCTAssertTrue(isFirstCapturePending)
        guard isFirstCapturePending else { return }
        let secondCapture = Task { await model.takePhoto() }
        await secondCapture.value

        XCTAssertEqual(camera.captureCount, 1)
        XCTAssertFalse(model.canTakePhoto)
        XCTAssertTrue(model.isCapturingPhoto)
        camera.completePendingCaptures()
        await firstCapture.value
        XCTAssertEqual(store.stageCount, 1)
        XCTAssertEqual(model.phase, .camera)
        XCTAssertFalse(model.isCapturingPhoto)
        XCTAssertTrue(model.canTakePhoto)
    }

    func testCaptureLockResetsAfterAnErrorAndAllowsARealRetry() async throws {
        let camera = TestCaptureCamera(
            isAvailable: true,
            authorization: .authorized,
            captureError: TestCaptureError.failed
        )
        let accepted = FramingObservation(
            subjectBounds: CGRect(x: 0.18, y: 0.14, width: 0.64, height: 0.70)
        )
        let evaluator = TestFramingEvaluator(
            observations: [accepted, accepted, accepted, accepted]
        )
        let store = TestCaptureStore()
        let model = makeModel(camera: camera, evaluator: evaluator, store: store)

        await model.startCamera()
        for _ in 0..<2 { await model.process(frame: try makeFrame()) }
        await model.takePhoto()
        XCTAssertEqual(model.phase, .camera)
        XCTAssertFalse(model.isCapturingPhoto)
        XCTAssertEqual(store.stageCount, 0)
        XCTAssertTrue(camera.isSessionActive)
        for _ in 0..<2 { await model.process(frame: try makeFrame()) }
        XCTAssertTrue(model.canTakePhoto)
        await model.takePhoto()
        XCTAssertEqual(model.phase, .camera)
        XCTAssertFalse(model.isCapturingPhoto)
        XCTAssertEqual(camera.captureCount, 2)
        XCTAssertEqual(store.stageCount, 1)
        XCTAssertEqual(camera.stopCount, 0)
        XCTAssertTrue(camera.isSessionActive)
    }

    func testLocalStageFailureStopsCameraAndAllowsARealRetry() async throws {
        let camera = TestCaptureCamera(isAvailable: true, authorization: .authorized)
        let accepted = FramingObservation(
            subjectBounds: CGRect(x: 0.18, y: 0.14, width: 0.64, height: 0.70)
        )
        let evaluator = TestFramingEvaluator(
            observations: [accepted, accepted, accepted, accepted]
        )
        let store = TestCaptureStore(stageError: TestCaptureError.failed)
        let model = makeModel(camera: camera, evaluator: evaluator, store: store)

        await model.startCamera()
        for _ in 0..<2 { await model.process(frame: try makeFrame()) }
        await model.takePhoto()

        XCTAssertEqual(model.phase, .camera)
        XCTAssertFalse(model.isCapturingPhoto)
        XCTAssertEqual(camera.captureCount, 1)
        XCTAssertEqual(store.stageCount, 1)
        XCTAssertTrue(camera.isSessionActive)
        for _ in 0..<2 { await model.process(frame: try makeFrame()) }
        await model.takePhoto()

        XCTAssertEqual(model.phase, .camera)
        XCTAssertFalse(model.isCapturingPhoto)
        XCTAssertEqual(camera.captureCount, 2)
        XCTAssertEqual(store.stageCount, 2)
        XCTAssertEqual(camera.stopCount, 0)
        XCTAssertTrue(camera.isSessionActive)
    }

    func testCancelInvalidatesAPendingCaptureAndReleasesTheShutterLock() async throws {
        let camera = TestCaptureCamera(
            isAvailable: true,
            authorization: .authorized,
            suspendsCapture: true
        )
        let accepted = FramingObservation(
            subjectBounds: CGRect(x: 0.18, y: 0.14, width: 0.64, height: 0.70)
        )
        let evaluator = TestFramingEvaluator(
            observations: [accepted, accepted, accepted, accepted]
        )
        let store = TestCaptureStore()
        let model = makeModel(camera: camera, evaluator: evaluator, store: store)

        await model.startCamera()
        for _ in 0..<2 { await model.process(frame: try makeFrame()) }
        let pendingCapture = Task { await model.takePhoto() }
        let isCapturePending = await camera.waitUntilCaptureIsPending()
        XCTAssertTrue(isCapturePending)
        guard isCapturePending else { return }
        XCTAssertTrue(model.isCapturingPhoto)

        model.cancelCamera()
        XCTAssertEqual(model.phase, .idle)
        XCTAssertFalse(model.isCapturingPhoto)
        camera.completePendingCaptures()
        await pendingCapture.value
        XCTAssertEqual(model.phase, .idle)
        XCTAssertEqual(store.stageCount, 0)

        await model.startCamera()
        for _ in 0..<2 { await model.process(frame: try makeFrame()) }
        XCTAssertTrue(model.canTakePhoto)
    }

    func testLibraryEscapeStagesAndStopsAtReviewHandoff() async {
        let camera = TestCaptureCamera(isAvailable: false, authorization: .denied)
        let store = TestCaptureStore()
        let model = makeModel(camera: camera, store: store)

        let didStage = await model.stageLibraryPhoto(Data([0x01, 0x02]))
        XCTAssertTrue(didStage)
        XCTAssertEqual(model.phase, .captured)
        XCTAssertEqual(store.stageCount, 1)

        model.continueToReviewHandoff()
        XCTAssertEqual(model.phase, .reviewHandoff)
        XCTAssertEqual(model.handoffTitle, "Photos ready to review")
    }

    func testReviewHandoffReturnsToLiveCameraWithoutDiscardingTheStagedPhoto() async throws {
        let staged = StagedCapturePhoto(
            id: UUID(),
            photoURL: URL(fileURLWithPath: "/tmp/photo.jpg"),
            thumbnailURL: URL(fileURLWithPath: "/tmp/thumb.jpg"),
            createdAt: Date()
        )
        let camera = TestCaptureCamera(isAvailable: true, authorization: .authorized)
        let accepted = FramingObservation(
            subjectBounds: CGRect(x: 0.18, y: 0.14, width: 0.64, height: 0.70)
        )
        let store = TestCaptureStore(staged: staged)
        let model = makeModel(
            camera: camera,
            evaluator: TestFramingEvaluator(observations: [accepted, accepted]),
            store: store
        )
        let restoration = await model.restore()
        XCTAssertEqual(restoration, .stagedPhoto)
        model.continueToReviewHandoff()
        XCTAssertEqual(model.phase, .reviewHandoff)

        await model.reopenCameraFromReviewHandoff()

        XCTAssertEqual(model.phase, .camera)
        XCTAssertEqual(model.stagedPhoto, staged)
        XCTAssertEqual(camera.startCount, 1)
        XCTAssertTrue(camera.isSessionActive)

        for _ in 0..<2 { await model.process(frame: try makeFrame()) }
        XCTAssertEqual(model.guidance, .accepted)
        XCTAssertTrue(model.canTakePhoto)
        await model.takePhoto()
        let didStageLibraryAppend = await model.stageLibraryPhoto(Data([0x01, 0x02]))
        XCTAssertEqual(camera.captureCount, 1)
        XCTAssertTrue(didStageLibraryAppend)
        XCTAssertEqual(store.stageCount, 2)
        XCTAssertEqual(store.discardCount, 0)
        XCTAssertEqual(model.stagedPhoto, staged)
        XCTAssertEqual(model.stagedPhotos.count, 3)
    }

    func testBackgroundStopsAndForegroundRestartsAnActiveCamera() async {
        let camera = TestCaptureCamera(isAvailable: true, authorization: .authorized)
        let model = makeModel(camera: camera)

        await model.startCamera()
        model.handleScenePhase(.background)
        XCTAssertEqual(camera.stopCount, 1)

        await model.handleSceneBecameActive()
        XCTAssertEqual(camera.startCount, 2)
        XCTAssertEqual(model.phase, .camera)
    }

    func testForegroundRechecksDeniedCameraAfterSettingsAuthorization() async {
        let camera = TestCaptureCamera(isAvailable: true, authorization: .denied)
        let model = makeModel(camera: camera)

        await model.startCamera()
        XCTAssertEqual(model.phase, .denied)

        camera.authorization = .authorized
        await model.handleSceneBecameActive()

        XCTAssertEqual(model.phase, .camera)
        XCTAssertEqual(camera.startCount, 1)
    }

    func testForegroundKeepsDeniedCameraBlockedWithoutAuthorization() async {
        let camera = TestCaptureCamera(isAvailable: true, authorization: .denied)
        let model = makeModel(camera: camera)

        await model.startCamera()
        await model.handleSceneBecameActive()

        XCTAssertEqual(model.phase, .denied)
        XCTAssertEqual(camera.startCount, 0)
    }

    func testCancelStopsAnActiveCameraAndReturnsToTheLauncherBoundary() async {
        let camera = TestCaptureCamera(isAvailable: true, authorization: .authorized)
        let model = makeModel(camera: camera)

        await model.startCamera()
        model.cancelCamera()

        XCTAssertEqual(camera.stopCount, 1)
        XCTAssertEqual(model.phase, .idle)
    }

    func testRestoreReopensTheSingleLocallyStagedPhoto() async throws {
        let staged = StagedCapturePhoto(
            id: UUID(),
            photoURL: URL(fileURLWithPath: "/tmp/photo.jpg"),
            thumbnailURL: URL(fileURLWithPath: "/tmp/thumb.jpg"),
            createdAt: Date()
        )
        let store = TestCaptureStore(staged: staged)
        let model = makeModel(store: store)

        let restoration = await model.restore()

        XCTAssertEqual(model.phase, .captured)
        XCTAssertEqual(model.stagedPhoto, staged)
        XCTAssertEqual(restoration, .stagedPhoto)

        let router = AppRouter(initialSheet: .capture)
        router.handleCaptureRestoration(restoration)
        XCTAssertEqual(router.presentedSheet, .capture)
        XCTAssertNil(router.presentedFullScreen)
    }

    func testSuccessfulLibraryHandoffConsumesOnlyTransferredPhotoAfterCaptureStages() async throws {
        let firstPhoto = Data([0x01, 0x02])
        let secondPhoto = Data([0x03])
        let stagedLibraryPhotos = InMemoryStagedLibraryPhotoStore()
        try stagedLibraryPhotos.replace(with: [firstPhoto, secondPhoto])
        let onboarding = OnboardingFlowModel(
            state: .init(screen: .libraryHandoff, stagedPhotoCount: 2),
            cameraAuthorization: FixtureCameraAuthorizationClient(status: .denied),
            progressStore: InMemoryOnboardingProgressStore(),
            stagedLibraryPhotos: stagedLibraryPhotos,
            guestAllowance: DeferredGuestAllowanceCapability()
        )
        onboarding.continueToCaptureBoundary()

        let store = TestCaptureStore()
        let capture = makeModel(store: store)
        let restoration = await capture.restore()
        XCTAssertEqual(restoration, .noDraft)
        let router = AppRouter(initialTab: .listings)

        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: onboarding,
            captureFlow: capture,
            router: router
        )

        XCTAssertEqual(router.selectedTab, .home)
        XCTAssertEqual(router.presentedSheet, .capture)
        XCTAssertNil(router.presentedFullScreen)
        XCTAssertEqual(store.stageCount, 1)
        XCTAssertEqual(store.lastStagedImageData, firstPhoto)
        XCTAssertEqual(capture.phase, .captured)
        let stagedPhoto = try XCTUnwrap(capture.stagedPhoto)
        XCTAssertEqual(
            stagedPhoto.libraryTransferReceipt,
            LibraryPhotoTransferReceipt(
                sourcePhotoFingerprints: [firstPhoto, secondPhoto].map(
                    LocalPhotoFingerprint.digest
                ),
                sourceIndex: 0
            )
        )
        XCTAssertEqual(try stagedLibraryPhotos.load(), [secondPhoto])
        XCTAssertEqual(onboarding.state.stagedPhotoCount, 1)
        XCTAssertEqual(onboarding.captureEntryContext, .library(stagedPhotoCount: 1))
    }

    func testFailedLibraryHandoffKeepsOnboardingCopiesRecoverable() async throws {
        let photos = [Data([0x01]), Data([0x02]), Data([0x03])]
        let stagedLibraryPhotos = InMemoryStagedLibraryPhotoStore()
        try stagedLibraryPhotos.replace(with: photos)
        let onboarding = OnboardingFlowModel(
            state: .init(screen: .libraryHandoff, stagedPhotoCount: photos.count),
            cameraAuthorization: FixtureCameraAuthorizationClient(status: .denied),
            progressStore: InMemoryOnboardingProgressStore(),
            stagedLibraryPhotos: stagedLibraryPhotos,
            guestAllowance: DeferredGuestAllowanceCapability()
        )
        onboarding.continueToCaptureBoundary()

        let store = TestCaptureStore(stageError: TestCaptureError.failed)
        let capture = makeModel(store: store)
        _ = await capture.restore()
        let router = AppRouter()

        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: onboarding,
            captureFlow: capture,
            router: router
        )

        XCTAssertEqual(capture.phase, .failed)
        XCTAssertNil(capture.stagedPhoto)
        XCTAssertEqual(try stagedLibraryPhotos.load(), photos)
        XCTAssertEqual(onboarding.state.stagedPhotoCount, photos.count)
        XCTAssertEqual(router.presentedSheet, .capture)
    }

    func testSourceConsumeFailureRollsBackCaptureAndKeepsADeterministicRetry() async throws {
        let fileManager = FileManager.default
        let parent = fileManager.temporaryDirectory.appendingPathComponent(
            "snaplist-library-consume-failure-\(UUID().uuidString)",
            isDirectory: true
        )
        let onboardingRoot = parent.appendingPathComponent("Onboarding", isDirectory: true)
        let photos = [Data([0x01]), Data([0x02]), Data([0x03])]
        let initialStore = FileSystemStagedLibraryPhotoStore(
            fileManager: fileManager,
            directoryURL: onboardingRoot
        )
        let replaceController = ConsumeReplaceController(fileManager: fileManager)
        let stagedLibraryPhotos = FileSystemStagedLibraryPhotoStore(
            fileManager: fileManager,
            directoryURL: onboardingRoot,
            consumeReplaceItem: replaceController.replace
        )
        defer { try? fileManager.removeItem(at: parent) }

        try initialStore.replace(with: photos)
        let onboarding = OnboardingFlowModel(
            state: .init(screen: .libraryHandoff, stagedPhotoCount: photos.count),
            cameraAuthorization: FixtureCameraAuthorizationClient(status: .denied),
            progressStore: InMemoryOnboardingProgressStore(),
            stagedLibraryPhotos: stagedLibraryPhotos,
            guestAllowance: DeferredGuestAllowanceCapability()
        )
        onboarding.continueToCaptureBoundary()
        let captureStore = TestCaptureStore()
        let capture = makeModel(store: captureStore)
        _ = await capture.restore()
        let router = AppRouter()

        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: onboarding,
            captureFlow: capture,
            router: router
        )

        XCTAssertEqual(captureStore.stageCount, 1)
        XCTAssertEqual(captureStore.discardCount, 1)
        XCTAssertNil(capture.stagedPhoto)
        XCTAssertEqual(capture.phase, .failed)
        XCTAssertEqual(try stagedLibraryPhotos.load(), photos)
        XCTAssertEqual(onboarding.state.stagedPhotoCount, photos.count)
        XCTAssertEqual(onboarding.captureEntryContext, .library(stagedPhotoCount: photos.count))
        XCTAssertEqual(router.presentedSheet, .capture)

        replaceController.shouldFail = false
        router.presentedSheet = nil
        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: onboarding,
            captureFlow: capture,
            router: router
        )

        XCTAssertEqual(captureStore.stageCount, 2)
        XCTAssertEqual(captureStore.discardCount, 1)
        XCTAssertNotNil(capture.stagedPhoto)
        XCTAssertEqual(capture.phase, .captured)
        XCTAssertEqual(try stagedLibraryPhotos.load(), Array(photos.dropFirst()))
        XCTAssertEqual(onboarding.state.stagedPhotoCount, 2)
        XCTAssertEqual(onboarding.captureEntryContext, .library(stagedPhotoCount: 2))
        XCTAssertEqual(router.presentedSheet, .capture)
    }

    func testSinglePhotoConsumeMoveFailureSurvivesRelaunchRetryAndExactExpiry() async throws {
        let fileManager = FileManager.default
        let parent = fileManager.temporaryDirectory.appendingPathComponent(
            "snaplist-library-single-consume-failure-\(UUID().uuidString)",
            isDirectory: true
        )
        let onboardingRoot = parent.appendingPathComponent("Onboarding", isDirectory: true)
        let captureRoot = parent.appendingPathComponent("Capture", isDirectory: true)
        let createdAt = Date(timeIntervalSinceReferenceDate: 1_000_000)
        let progressStore = InMemoryOnboardingProgressStore()
        let consumeController = ConsumeMoveController(fileManager: fileManager)
        let stagedLibraryPhotos = FileSystemStagedLibraryPhotoStore(
            fileManager: fileManager,
            directoryURL: onboardingRoot,
            consumeMoveItem: consumeController.move
        )
        defer { try? fileManager.removeItem(at: parent) }

        let sourcePhoto = try makeLandscapeImageData()
        try stagedLibraryPhotos.replace(with: [sourcePhoto])
        let onboarding = OnboardingFlowModel(
            state: .init(screen: .libraryHandoff, stagedPhotoCount: 1),
            cameraAuthorization: FixtureCameraAuthorizationClient(status: .authorized),
            progressStore: progressStore,
            stagedLibraryPhotos: stagedLibraryPhotos,
            guestAllowance: DeferredGuestAllowanceCapability()
        )
        onboarding.continueToCaptureBoundary()
        let capture = CaptureFlowModel(
            camera: TestCaptureCamera(isAvailable: true, authorization: .authorized),
            evaluator: TestFramingEvaluator(observations: []),
            store: LocalCaptureDraftStore(rootDirectory: captureRoot, now: { createdAt })
        )
        _ = await capture.restore()

        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: onboarding,
            captureFlow: capture,
            router: AppRouter()
        )

        XCTAssertEqual(capture.phase, .failed)
        XCTAssertNil(capture.stagedPhoto)
        XCTAssertEqual(try stagedLibraryPhotos.load(), [sourcePhoto])
        XCTAssertEqual(onboarding.state.stagedPhotoCount, 1)
        XCTAssertEqual(onboarding.captureEntryContext, .library(stagedPhotoCount: 1))

        consumeController.shouldFail = false
        let relaunchedOnboarding = OnboardingFlowModel(
            cameraAuthorization: FixtureCameraAuthorizationClient(status: .authorized),
            progressStore: progressStore,
            stagedLibraryPhotos: stagedLibraryPhotos,
            guestAllowance: DeferredGuestAllowanceCapability()
        )
        relaunchedOnboarding.restorePersistedProgress()
        let relaunchedCapture = CaptureFlowModel(
            camera: TestCaptureCamera(isAvailable: true, authorization: .authorized),
            evaluator: TestFramingEvaluator(observations: []),
            store: LocalCaptureDraftStore(rootDirectory: captureRoot, now: { createdAt })
        )
        let relaunchedRestoration = await relaunchedCapture.restore()
        XCTAssertEqual(relaunchedRestoration, .noDraft)

        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: relaunchedOnboarding,
            captureFlow: relaunchedCapture,
            router: AppRouter()
        )

        let durablyStaged = try XCTUnwrap(relaunchedCapture.stagedPhoto)
        XCTAssertEqual(
            durablyStaged.libraryTransferReceipt?.fingerprint,
            LocalPhotoFingerprint.digest(of: sourcePhoto)
        )
        XCTAssertEqual(try stagedLibraryPhotos.load(), [])
        XCTAssertEqual(relaunchedOnboarding.state.stagedPhotoCount, 0)
        XCTAssertEqual(relaunchedOnboarding.captureEntryContext, .camera)

        let expiredCapture = CaptureFlowModel(
            camera: TestCaptureCamera(isAvailable: true, authorization: .authorized),
            evaluator: TestFramingEvaluator(observations: []),
            store: LocalCaptureDraftStore(
                rootDirectory: captureRoot,
                now: { createdAt.addingTimeInterval(LocalCaptureDraftStore.recoveryWindow) }
            )
        )
        let expiredRestoration = await expiredCapture.restore()
        XCTAssertEqual(expiredRestoration, .noDraft)
        let expiredOnboarding = OnboardingFlowModel(
            cameraAuthorization: FixtureCameraAuthorizationClient(status: .authorized),
            progressStore: progressStore,
            stagedLibraryPhotos: stagedLibraryPhotos,
            guestAllowance: DeferredGuestAllowanceCapability()
        )
        expiredOnboarding.restorePersistedProgress()

        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: expiredOnboarding,
            captureFlow: expiredCapture,
            router: AppRouter()
        )

        XCTAssertNil(expiredCapture.stagedPhoto)
        XCTAssertEqual(expiredCapture.phase, .idle)
        XCTAssertEqual(try stagedLibraryPhotos.load(), [])
        XCTAssertEqual(expiredOnboarding.state.stagedPhotoCount, 0)
        XCTAssertEqual(expiredOnboarding.captureEntryContext, .camera)
    }

    func testLibraryStageRejectsMismatchedBytesAndMutatedReceiptIndexBeforeWriting() async throws {
        let fileManager = FileManager.default
        let parent = fileManager.temporaryDirectory.appendingPathComponent(
            "snaplist-library-receipt-binding-\(UUID().uuidString)",
            isDirectory: true
        )
        let onboardingRoot = parent.appendingPathComponent("Onboarding", isDirectory: true)
        let captureRoot = parent.appendingPathComponent("Capture", isDirectory: true)
        defer { try? fileManager.removeItem(at: parent) }

        let photos = try [
            makeLandscapeImageData(leftColor: .systemBlue, rightColor: .systemOrange),
            makeLandscapeImageData(leftColor: .systemGreen, rightColor: .systemPurple)
        ]
        let sourceStore = FileSystemStagedLibraryPhotoStore(
            fileManager: fileManager,
            directoryURL: onboardingRoot
        )
        try sourceStore.replace(with: photos)
        let fingerprints = photos.map(LocalPhotoFingerprint.digest)
        let receipt = LibraryPhotoTransferReceipt(
            sourcePhotoFingerprints: fingerprints,
            sourceIndex: 0
        )
        let captureStore = LocalCaptureDraftStore(
            rootDirectory: captureRoot,
            fileManager: fileManager
        )
        let modelStore = TestCaptureStore()
        let captureModel = makeModel(store: modelStore)

        let didStageMismatchedPhoto = await captureModel.stageLibraryPhoto(
            photos[1],
            transferReceipt: receipt
        )
        XCTAssertFalse(didStageMismatchedPhoto)
        XCTAssertEqual(modelStore.stageCount, 0)
        XCTAssertEqual(captureModel.phase, .failed)

        do {
            _ = try await captureStore.stage(
                imageData: photos[1],
                libraryTransferReceipt: receipt
            )
            XCTFail("Mismatched bytes must not stage")
        } catch CaptureDraftStoreError.transferReceiptMismatch {
            // Expected: validation happens before any capture artifact is written.
        }

        let mutatedIndexReceipt = LibraryPhotoTransferReceipt(
            sourcePhotoFingerprints: fingerprints,
            sourceIndex: 1,
            transferredDigest: fingerprints[0]
        )
        do {
            _ = try await captureStore.stage(
                imageData: photos[0],
                libraryTransferReceipt: mutatedIndexReceipt
            )
            XCTFail("A digest bound to a different source index must not stage")
        } catch CaptureDraftStoreError.transferReceiptMismatch {
            // Expected.
        }

        XCTAssertFalse(fileManager.fileExists(atPath: captureRoot.path))
        XCTAssertEqual(try sourceStore.load(), photos)
    }

    func testPersistedMismatchTombstoneBlocksTransferredPhotoAcrossRelaunchAndExpiry() async throws {
        let fileManager = FileManager.default
        let parent = fileManager.temporaryDirectory.appendingPathComponent(
            "snaplist-library-mismatch-recovery-\(UUID().uuidString)",
            isDirectory: true
        )
        let onboardingRoot = parent.appendingPathComponent("Onboarding", isDirectory: true)
        let captureRoot = parent.appendingPathComponent("Capture", isDirectory: true)
        let createdAt = Date(timeIntervalSinceReferenceDate: 1_000_000)
        let progressStore = InMemoryOnboardingProgressStore()
        let replaceController = ConsumeReplaceController(fileManager: fileManager)
        let initialSourceStore = FileSystemStagedLibraryPhotoStore(
            fileManager: fileManager,
            directoryURL: onboardingRoot
        )
        let stagedLibraryPhotos = FileSystemStagedLibraryPhotoStore(
            fileManager: fileManager,
            directoryURL: onboardingRoot,
            consumeReplaceItem: replaceController.replace
        )
        defer { try? fileManager.removeItem(at: parent) }

        let photos = try [
            makeLandscapeImageData(leftColor: .systemBlue, rightColor: .systemOrange),
            makeLandscapeImageData(leftColor: .systemGreen, rightColor: .systemPurple),
            makeLandscapeImageData(leftColor: .systemRed, rightColor: .systemYellow)
        ]
        // B disappears after the transfer was authorized but before source cleanup.
        try initialSourceStore.replace(with: [photos[0], photos[2]])
        let originalReceipt = LibraryPhotoTransferReceipt(
            sourcePhotoFingerprints: photos.map(LocalPhotoFingerprint.digest),
            sourceIndex: 0
        )
        let initialState = OnboardingFlowState(screen: .captureBoundary, stagedPhotoCount: 2)
        progressStore.save(initialState)
        let onboarding = OnboardingFlowModel(
            state: initialState,
            cameraAuthorization: FixtureCameraAuthorizationClient(status: .authorized),
            progressStore: progressStore,
            stagedLibraryPhotos: stagedLibraryPhotos,
            guestAllowance: DeferredGuestAllowanceCapability()
        )
        let captureStore = LocalCaptureDraftStore(
            rootDirectory: captureRoot,
            fileManager: fileManager,
            now: { createdAt }
        )
        _ = try await captureStore.stage(
            imageData: photos[0],
            libraryTransferReceipt: originalReceipt
        )
        let capture = CaptureFlowModel(
            camera: TestCaptureCamera(isAvailable: true, authorization: .authorized),
            evaluator: TestFramingEvaluator(observations: []),
            store: captureStore
        )
        let initialRestoration = await capture.restore()
        XCTAssertEqual(initialRestoration, .stagedPhoto)

        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: onboarding,
            captureFlow: capture,
            router: AppRouter()
        )

        XCTAssertEqual(capture.phase, .captured)
        XCTAssertEqual(capture.stagedPhoto?.libraryTransferReceipt, originalReceipt)
        XCTAssertEqual(onboarding.state.stagedPhotoCount, 2)
        XCTAssertTrue(
            fileManager.fileExists(
                atPath: onboardingRoot.appendingPathComponent(".cleanup-needed.json").path
            )
        )

        let relaunchedOnboarding = OnboardingFlowModel(
            cameraAuthorization: FixtureCameraAuthorizationClient(status: .authorized),
            progressStore: progressStore,
            stagedLibraryPhotos: stagedLibraryPhotos,
            guestAllowance: DeferredGuestAllowanceCapability()
        )
        relaunchedOnboarding.restorePersistedProgress()
        XCTAssertEqual(relaunchedOnboarding.state, initialState)
        let relaunchedCapture = CaptureFlowModel(
            camera: TestCaptureCamera(isAvailable: true, authorization: .authorized),
            evaluator: TestFramingEvaluator(observations: []),
            store: LocalCaptureDraftStore(
                rootDirectory: captureRoot,
                fileManager: fileManager,
                now: { createdAt }
            )
        )
        let relaunchedRestoration = await relaunchedCapture.restore()
        XCTAssertEqual(relaunchedRestoration, .stagedPhoto)
        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: relaunchedOnboarding,
            captureFlow: relaunchedCapture,
            router: AppRouter()
        )
        XCTAssertEqual(relaunchedCapture.stagedPhoto?.libraryTransferReceipt, originalReceipt)

        let expiredCapture = CaptureFlowModel(
            camera: TestCaptureCamera(isAvailable: true, authorization: .authorized),
            evaluator: TestFramingEvaluator(observations: []),
            store: LocalCaptureDraftStore(
                rootDirectory: captureRoot,
                fileManager: fileManager,
                now: { createdAt.addingTimeInterval(LocalCaptureDraftStore.recoveryWindow) }
            )
        )
        let expiredRestoration = await expiredCapture.restore()
        XCTAssertEqual(expiredRestoration, .noDraft)
        let stillBlockedOnboarding = OnboardingFlowModel(
            cameraAuthorization: FixtureCameraAuthorizationClient(status: .authorized),
            progressStore: progressStore,
            stagedLibraryPhotos: stagedLibraryPhotos,
            guestAllowance: DeferredGuestAllowanceCapability()
        )
        stillBlockedOnboarding.restorePersistedProgress()
        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: stillBlockedOnboarding,
            captureFlow: expiredCapture,
            router: AppRouter()
        )
        XCTAssertNil(expiredCapture.stagedPhoto)
        XCTAssertEqual(stillBlockedOnboarding.state, initialState)

        replaceController.shouldFail = false
        let recoveredOnboarding = OnboardingFlowModel(
            cameraAuthorization: FixtureCameraAuthorizationClient(status: .authorized),
            progressStore: progressStore,
            stagedLibraryPhotos: stagedLibraryPhotos,
            guestAllowance: DeferredGuestAllowanceCapability()
        )
        recoveredOnboarding.restorePersistedProgress()
        XCTAssertEqual(try stagedLibraryPhotos.load(), [photos[2]])
        XCTAssertEqual(recoveredOnboarding.state.stagedPhotoCount, 1)
        XCTAssertFalse(
            fileManager.fileExists(
                atPath: onboardingRoot.appendingPathComponent(".cleanup-needed.json").path
            )
        )

        let recoveredCapture = CaptureFlowModel(
            camera: TestCaptureCamera(isAvailable: true, authorization: .authorized),
            evaluator: TestFramingEvaluator(observations: []),
            store: LocalCaptureDraftStore(
                rootDirectory: captureRoot,
                fileManager: fileManager,
                now: { createdAt.addingTimeInterval(LocalCaptureDraftStore.recoveryWindow) }
            )
        )
        _ = await recoveredCapture.restore()
        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: recoveredOnboarding,
            captureFlow: recoveredCapture,
            router: AppRouter()
        )
        XCTAssertEqual(
            recoveredCapture.stagedPhoto?.libraryTransferReceipt?.transferredDigest,
            LocalPhotoFingerprint.digest(of: photos[2])
        )
        XCTAssertNotEqual(
            recoveredCapture.stagedPhoto?.libraryTransferReceipt?.transferredDigest,
            LocalPhotoFingerprint.digest(of: photos[0])
        )
        XCTAssertEqual(try stagedLibraryPhotos.load(), [])
        XCTAssertEqual(recoveredOnboarding.state.stagedPhotoCount, 0)
    }

    func testDiscardFailureReconcilesTheRestoredCaptureBeforeExpiry() async throws {
        let fileManager = FileManager.default
        let parent = fileManager.temporaryDirectory.appendingPathComponent(
            "snaplist-library-discard-failure-\(UUID().uuidString)",
            isDirectory: true
        )
        let onboardingRoot = parent.appendingPathComponent("Onboarding", isDirectory: true)
        let captureRoot = parent.appendingPathComponent("Capture", isDirectory: true)
        let createdAt = Date(timeIntervalSinceReferenceDate: 1_000_000)
        let progressStore = InMemoryOnboardingProgressStore()
        let consumeController = ConsumeReplaceController(fileManager: fileManager)
        let discardController = DiscardRootController()
        let initialLibraryStore = FileSystemStagedLibraryPhotoStore(
            fileManager: fileManager,
            directoryURL: onboardingRoot
        )
        let stagedLibraryPhotos = FileSystemStagedLibraryPhotoStore(
            fileManager: fileManager,
            directoryURL: onboardingRoot,
            consumeReplaceItem: consumeController.replace
        )
        defer { try? fileManager.removeItem(at: parent) }

        let photos = try [
            makeLandscapeImageData(leftColor: .systemBlue, rightColor: .systemOrange),
            makeLandscapeImageData(leftColor: .systemGreen, rightColor: .systemPurple),
            makeLandscapeImageData(leftColor: .systemRed, rightColor: .systemYellow),
            makeLandscapeImageData(leftColor: .systemTeal, rightColor: .systemPink)
        ]
        try initialLibraryStore.replace(with: photos)
        let onboarding = OnboardingFlowModel(
            state: .init(screen: .libraryHandoff, stagedPhotoCount: photos.count),
            cameraAuthorization: FixtureCameraAuthorizationClient(status: .denied),
            progressStore: progressStore,
            stagedLibraryPhotos: stagedLibraryPhotos,
            guestAllowance: DeferredGuestAllowanceCapability()
        )
        onboarding.continueToCaptureBoundary()
        let capture = CaptureFlowModel(
            camera: TestCaptureCamera(isAvailable: true, authorization: .authorized),
            evaluator: TestFramingEvaluator(observations: []),
            store: LocalCaptureDraftStore(
                rootDirectory: captureRoot,
                discardRoot: discardController.discard,
                now: { createdAt }
            )
        )
        _ = await capture.restore()
        let router = AppRouter()

        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: onboarding,
            captureFlow: capture,
            router: router
        )

        let durablyStaged = try XCTUnwrap(capture.stagedPhoto)
        XCTAssertEqual(
            durablyStaged.libraryTransferReceipt?.fingerprint,
            LocalPhotoFingerprint.digest(of: photos[0])
        )
        XCTAssertEqual(discardController.discardCount, 1)
        XCTAssertEqual(capture.phase, .captured)
        XCTAssertEqual(try stagedLibraryPhotos.load(), photos)
        XCTAssertEqual(onboarding.state.stagedPhotoCount, 4)
        XCTAssertEqual(onboarding.captureEntryContext, .library(stagedPhotoCount: 4))
        XCTAssertEqual(router.presentedSheet, .capture)

        consumeController.shouldFail = false
        let relaunchedCapture = CaptureFlowModel(
            camera: TestCaptureCamera(isAvailable: true, authorization: .authorized),
            evaluator: TestFramingEvaluator(observations: []),
            store: LocalCaptureDraftStore(rootDirectory: captureRoot, now: { createdAt })
        )
        let restoration = await relaunchedCapture.restore()
        XCTAssertEqual(restoration, .stagedPhoto)
        XCTAssertEqual(relaunchedCapture.stagedPhoto, durablyStaged)
        let relaunchedRouter = AppRouter()
        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: onboarding,
            captureFlow: relaunchedCapture,
            router: relaunchedRouter
        )

        XCTAssertEqual(relaunchedCapture.stagedPhoto, durablyStaged)
        XCTAssertEqual(try stagedLibraryPhotos.load(), Array(photos.dropFirst()))
        XCTAssertEqual(onboarding.state.stagedPhotoCount, 3)
        XCTAssertEqual(onboarding.captureEntryContext, .library(stagedPhotoCount: 3))
        XCTAssertEqual(relaunchedRouter.presentedSheet, .capture)

        relaunchedRouter.presentedSheet = nil
        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: onboarding,
            captureFlow: relaunchedCapture,
            router: relaunchedRouter
        )

        XCTAssertEqual(relaunchedCapture.stagedPhoto, durablyStaged)
        XCTAssertEqual(try stagedLibraryPhotos.load(), Array(photos.dropFirst()))
        XCTAssertEqual(onboarding.state.stagedPhotoCount, 3)

        let expiredCapture = CaptureFlowModel(
            camera: TestCaptureCamera(isAvailable: true, authorization: .authorized),
            evaluator: TestFramingEvaluator(observations: []),
            store: LocalCaptureDraftStore(
                rootDirectory: captureRoot,
                now: { createdAt.addingTimeInterval(LocalCaptureDraftStore.recoveryWindow) }
            )
        )
        let expiredRestoration = await expiredCapture.restore()
        XCTAssertEqual(expiredRestoration, .noDraft)
        let restoredOnboarding = OnboardingFlowModel(
            cameraAuthorization: FixtureCameraAuthorizationClient(status: .authorized),
            progressStore: progressStore,
            stagedLibraryPhotos: stagedLibraryPhotos,
            guestAllowance: DeferredGuestAllowanceCapability()
        )
        restoredOnboarding.restorePersistedProgress()
        let expiredRouter = AppRouter()
        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: restoredOnboarding,
            captureFlow: expiredCapture,
            router: expiredRouter
        )

        let nextStagedPhoto = try XCTUnwrap(expiredCapture.stagedPhoto)
        XCTAssertEqual(
            nextStagedPhoto.libraryTransferReceipt?.fingerprint,
            LocalPhotoFingerprint.digest(of: photos[1])
        )
        XCTAssertNotEqual(
            nextStagedPhoto.libraryTransferReceipt?.fingerprint,
            LocalPhotoFingerprint.digest(of: photos[0])
        )
        XCTAssertEqual(restoredOnboarding.state.stagedPhotoCount, 2)
        XCTAssertEqual(restoredOnboarding.captureEntryContext, .library(stagedPhotoCount: 2))
        XCTAssertEqual(try stagedLibraryPhotos.load(), Array(photos.dropFirst(2)))
        XCTAssertEqual(expiredRouter.presentedSheet, .capture)
    }

    func testExpiredTransferredLibraryPhotoCannotRestageAfterRelaunch() async throws {
        let fileManager = FileManager.default
        let parent = fileManager.temporaryDirectory.appendingPathComponent(
            "snaplist-library-transfer-\(UUID().uuidString)",
            isDirectory: true
        )
        let onboardingRoot = parent.appendingPathComponent("Onboarding", isDirectory: true)
        let captureRoot = parent.appendingPathComponent("Capture", isDirectory: true)
        let createdAt = Date(timeIntervalSinceReferenceDate: 1_000_000)
        let progressStore = InMemoryOnboardingProgressStore()
        let stagedLibraryPhotos = FileSystemStagedLibraryPhotoStore(
            fileManager: fileManager,
            directoryURL: onboardingRoot
        )
        defer { try? fileManager.removeItem(at: parent) }

        let photos = try [
            makeLandscapeImageData(leftColor: .systemBlue, rightColor: .systemOrange),
            makeLandscapeImageData(leftColor: .systemGreen, rightColor: .systemPurple),
            makeLandscapeImageData(leftColor: .systemRed, rightColor: .systemYellow),
            makeLandscapeImageData(leftColor: .systemTeal, rightColor: .systemPink)
        ]
        try stagedLibraryPhotos.replace(with: photos)
        let onboarding = OnboardingFlowModel(
            state: .init(screen: .libraryHandoff, stagedPhotoCount: photos.count),
            cameraAuthorization: FixtureCameraAuthorizationClient(status: .authorized),
            progressStore: progressStore,
            stagedLibraryPhotos: stagedLibraryPhotos,
            guestAllowance: DeferredGuestAllowanceCapability()
        )
        onboarding.continueToCaptureBoundary()
        let initialCapture = CaptureFlowModel(
            camera: TestCaptureCamera(isAvailable: true, authorization: .authorized),
            evaluator: TestFramingEvaluator(observations: []),
            store: LocalCaptureDraftStore(rootDirectory: captureRoot, now: { createdAt })
        )
        _ = await initialCapture.restore()

        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: onboarding,
            captureFlow: initialCapture,
            router: AppRouter()
        )

        let initialStagedPhoto = try XCTUnwrap(initialCapture.stagedPhoto)
        XCTAssertEqual(
            initialStagedPhoto.libraryTransferReceipt?.fingerprint,
            LocalPhotoFingerprint.digest(of: photos[0])
        )
        XCTAssertEqual(try stagedLibraryPhotos.load(), Array(photos.dropFirst()))
        XCTAssertEqual(onboarding.state.stagedPhotoCount, 3)
        XCTAssertEqual(onboarding.captureEntryContext, .library(stagedPhotoCount: 3))

        let relaunchedOnboarding = OnboardingFlowModel(
            cameraAuthorization: FixtureCameraAuthorizationClient(status: .authorized),
            progressStore: progressStore,
            stagedLibraryPhotos: stagedLibraryPhotos,
            guestAllowance: DeferredGuestAllowanceCapability()
        )
        relaunchedOnboarding.restorePersistedProgress()
        XCTAssertEqual(relaunchedOnboarding.state.screen, .captureBoundary)
        XCTAssertEqual(relaunchedOnboarding.state.stagedPhotoCount, 3)
        XCTAssertEqual(
            relaunchedOnboarding.captureEntryContext,
            .library(stagedPhotoCount: 3)
        )

        let restoredCapture = CaptureFlowModel(
            camera: TestCaptureCamera(isAvailable: true, authorization: .authorized),
            evaluator: TestFramingEvaluator(observations: []),
            store: LocalCaptureDraftStore(rootDirectory: captureRoot, now: { createdAt })
        )
        let restoredCaptureResult = await restoredCapture.restore()
        XCTAssertEqual(restoredCaptureResult, .stagedPhoto)
        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: relaunchedOnboarding,
            captureFlow: restoredCapture,
            router: AppRouter()
        )
        XCTAssertEqual(restoredCapture.stagedPhoto, initialStagedPhoto)
        XCTAssertEqual(try stagedLibraryPhotos.load(), Array(photos.dropFirst()))
        XCTAssertEqual(relaunchedOnboarding.state.stagedPhotoCount, 3)

        let expiredCapture = CaptureFlowModel(
            camera: TestCaptureCamera(isAvailable: true, authorization: .authorized),
            evaluator: TestFramingEvaluator(observations: []),
            store: LocalCaptureDraftStore(
                rootDirectory: captureRoot,
                now: { createdAt.addingTimeInterval(LocalCaptureDraftStore.recoveryWindow) }
            )
        )
        let restoration = await expiredCapture.restore()
        XCTAssertEqual(restoration, .noDraft)
        let relaunchedRouter = AppRouter()

        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: relaunchedOnboarding,
            captureFlow: expiredCapture,
            router: relaunchedRouter
        )

        let nextStagedPhoto = try XCTUnwrap(expiredCapture.stagedPhoto)
        XCTAssertEqual(expiredCapture.phase, .captured)
        XCTAssertEqual(
            nextStagedPhoto.libraryTransferReceipt?.fingerprint,
            LocalPhotoFingerprint.digest(of: photos[1])
        )
        XCTAssertNotEqual(
            nextStagedPhoto.libraryTransferReceipt?.fingerprint,
            LocalPhotoFingerprint.digest(of: photos[0])
        )
        XCTAssertEqual(relaunchedRouter.presentedSheet, .capture)
        XCTAssertEqual(try stagedLibraryPhotos.load(), Array(photos.dropFirst(2)))
        XCTAssertEqual(relaunchedOnboarding.state.stagedPhotoCount, 2)
    }

    func testDuplicatePhotoBytesAreConsumedExactlyOnceByTheSameReceipt() throws {
        let duplicate = Data([0x01, 0x02])
        let finalPhoto = Data([0x03])
        let store = InMemoryStagedLibraryPhotoStore()
        try store.replace(with: [duplicate, duplicate, finalPhoto])
        let receipt = LibraryPhotoTransferReceipt(
            sourcePhotoFingerprints: [duplicate, duplicate, finalPhoto].map(
                LocalPhotoFingerprint.digest
            ),
            sourceIndex: 0
        )

        XCTAssertEqual(
            try store.consume(transferReceipt: receipt),
            .consumed(remainingCount: 2)
        )
        XCTAssertEqual(try store.load(), [duplicate, finalPhoto])

        XCTAssertEqual(
            try store.consume(transferReceipt: receipt),
            .consumed(remainingCount: 2)
        )
        XCTAssertEqual(try store.load(), [duplicate, finalPhoto])
    }

    func testReceiptMismatchRecordsCleanupAndRemovesOnlyTheTransferredPhoto() throws {
        let photos = [Data([0x01]), Data([0x02]), Data([0x03])]
        let receipt = LibraryPhotoTransferReceipt(
            sourcePhotoFingerprints: photos.map(LocalPhotoFingerprint.digest),
            sourceIndex: 0
        )
        let store = InMemoryStagedLibraryPhotoStore()
        try store.replace(with: [photos[0], photos[2]])

        XCTAssertEqual(try store.consume(transferReceipt: receipt), .cleanupNeeded)
        XCTAssertEqual(try store.load(), [photos[2]])
        XCTAssertEqual(
            try store.consume(transferReceipt: receipt),
            .consumed(remainingCount: 1)
        )
        XCTAssertEqual(try store.load(), [photos[2]])
    }

    func testRestoredCaptureDraftWinsOverOnboardingLibraryHandoff() async throws {
        let stagedLibraryPhotos = InMemoryStagedLibraryPhotoStore()
        try stagedLibraryPhotos.replace(with: [Data([0x01]), Data([0x02])])
        let onboarding = OnboardingFlowModel(
            state: .init(screen: .libraryHandoff, stagedPhotoCount: 2),
            cameraAuthorization: FixtureCameraAuthorizationClient(status: .denied),
            progressStore: InMemoryOnboardingProgressStore(),
            stagedLibraryPhotos: stagedLibraryPhotos,
            guestAllowance: DeferredGuestAllowanceCapability()
        )
        onboarding.continueToCaptureBoundary()

        let restoredPhoto = StagedCapturePhoto(
            id: UUID(),
            photoURL: URL(fileURLWithPath: "/tmp/restored-photo.jpg"),
            thumbnailURL: URL(fileURLWithPath: "/tmp/restored-thumb.jpg"),
            createdAt: Date()
        )
        let store = TestCaptureStore(staged: restoredPhoto)
        let capture = makeModel(store: store)
        let restoration = await capture.restore()
        XCTAssertEqual(restoration, .stagedPhoto)
        let router = AppRouter()

        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: onboarding,
            captureFlow: capture,
            router: router
        )

        XCTAssertEqual(router.presentedSheet, .capture)
        XCTAssertEqual(store.stageCount, 0)
        XCTAssertNil(store.lastStagedImageData)
        XCTAssertEqual(capture.stagedPhoto, restoredPhoto)
        XCTAssertEqual(try stagedLibraryPhotos.load(), [Data([0x01]), Data([0x02])])
        XCTAssertEqual(onboarding.state.stagedPhotoCount, 2)
    }

    private func makeModel(
        camera: TestCaptureCamera = TestCaptureCamera(
            isAvailable: true,
            authorization: .authorized
        ),
        evaluator: TestFramingEvaluator = TestFramingEvaluator(observations: []),
        store: TestCaptureStore = TestCaptureStore()
    ) -> CaptureFlowModel {
        CaptureFlowModel(camera: camera, evaluator: evaluator, store: store)
    }

    private func makeFrame() throws -> CaptureFrame {
        var buffer: CVPixelBuffer?
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            2,
            2,
            kCVPixelFormatType_32BGRA,
            nil,
            &buffer
        )
        XCTAssertEqual(status, kCVReturnSuccess)
        return CaptureFrame(pixelBuffer: try XCTUnwrap(buffer), orientation: .up)
    }

    private func makeLandscapeImageData(
        leftColor: UIColor = .systemBlue,
        rightColor: UIColor = .systemOrange
    ) throws -> Data {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 400, height: 200))
        return try XCTUnwrap(renderer.jpegData(withCompressionQuality: 0.95) { context in
            leftColor.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 200, height: 200))
            rightColor.setFill()
            context.fill(CGRect(x: 200, y: 0, width: 200, height: 200))
        })
    }
}

@MainActor
private struct PhotoReviewConditionalPresentationHarness: View {
    @Bindable var router: AppRouter
    @Bindable var host: PhotoReviewLiveHost
    let coverPresented: () -> Void
    let coverDismissed: () -> Void
    let reviewPresented: () -> Void

    init(
        router: AppRouter,
        host: PhotoReviewLiveHost,
        coverPresented: @escaping () -> Void,
        coverDismissed: @escaping () -> Void = {},
        reviewPresented: @escaping () -> Void = {}
    ) {
        self.router = router
        self.host = host
        self.coverPresented = coverPresented
        self.coverDismissed = coverDismissed
        self.reviewPresented = reviewPresented
    }

    var body: some View {
        if host.session != nil {
            Color.clear
                .accessibilityIdentifier("photo-review.contract")
                .onAppear(perform: reviewPresented)
        } else {
            Color.clear
                .accessibilityIdentifier("scan-shell.contract")
                .fullScreenCover(
                    item: $router.presentedFullScreen,
                    onDismiss: coverDismissed
                ) { destination in
                    switch destination {
                    case .guidedCamera:
                        Color.clear
                            .accessibilityIdentifier("guided-camera.contract")
                            .onAppear(perform: coverPresented)
                    }
                }
        }
    }
}

private final class TestCaptureCamera: CaptureCamera {
    let session = AVCaptureSession()
    let isAvailable: Bool
    let isFlashAvailable: Bool
    var authorization: CaptureCameraAuthorization
    var startCount = 0
    var stopCount = 0
    var captureCount = 0
    var requestedFlashModes: [CaptureFlashMode] = []
    private(set) var isSessionActive = false
    var frameHandler: ((CaptureFrame) -> Void)?
    private let suspendsCapture: Bool
    private var captureError: Error?
    private let pendingCaptureLock = NSLock()
    private var pendingCaptures: [CheckedContinuation<Data, Error>] = []
    private var pendingCaptureWaiters: [UUID: CheckedContinuation<Bool, Never>] = [:]

    init(
        isAvailable: Bool,
        authorization: CaptureCameraAuthorization,
        isFlashAvailable: Bool = false,
        suspendsCapture: Bool = false,
        captureError: Error? = nil
    ) {
        self.isAvailable = isAvailable
        self.isFlashAvailable = isFlashAvailable
        self.authorization = authorization
        self.suspendsCapture = suspendsCapture
        self.captureError = captureError
    }

    func authorizationStatus() -> CaptureCameraAuthorization { authorization }
    func requestAuthorization() async -> CaptureCameraAuthorization { authorization }

    func start(frameHandler: @escaping (CaptureFrame) -> Void) async throws {
        startCount += 1
        isSessionActive = true
        self.frameHandler = frameHandler
    }

    func stop() {
        stopCount += 1
        isSessionActive = false
    }

    func setFlashMode(_ mode: CaptureFlashMode) {
        requestedFlashModes.append(mode)
    }

    func capturePhoto() async throws -> Data {
        captureCount += 1
        if let captureError {
            self.captureError = nil
            throw captureError
        }
        guard suspendsCapture else { return Self.photoData }
        return try await withCheckedThrowingContinuation { continuation in
            pendingCaptureLock.lock()
            pendingCaptures.append(continuation)
            let waiters = Array(pendingCaptureWaiters.values)
            pendingCaptureWaiters.removeAll()
            pendingCaptureLock.unlock()
            for waiter in waiters {
                waiter.resume(returning: true)
            }
        }
    }

    func waitUntilCaptureIsPending(
        timeoutNanoseconds: UInt64 = 5_000_000_000
    ) async -> Bool {
        let waiterID = UUID()
        return await withCheckedContinuation { continuation in
            pendingCaptureLock.lock()
            guard pendingCaptures.isEmpty else {
                pendingCaptureLock.unlock()
                continuation.resume(returning: true)
                return
            }
            pendingCaptureWaiters[waiterID] = continuation
            pendingCaptureLock.unlock()
            Task<Void, Never> {
                try? await Task.sleep(nanoseconds: timeoutNanoseconds)
                self.pendingCaptureLock.lock()
                let waiter = self.pendingCaptureWaiters.removeValue(forKey: waiterID)
                self.pendingCaptureLock.unlock()
                waiter?.resume(returning: false)
            }
        }
    }

    func completePendingCaptures() {
        pendingCaptureLock.lock()
        let captures = pendingCaptures
        pendingCaptures.removeAll()
        pendingCaptureLock.unlock()
        for capture in captures {
            capture.resume(returning: Self.photoData)
        }
    }

    private static let photoData = Data([0xFF, 0xD8, 0xFF, 0xD9])
}

private enum TestCaptureError: Error {
    case failed
}

private final class ConsumeReplaceController {
    var shouldFail = true
    private let fileManager: FileManager

    init(fileManager: FileManager) {
        self.fileManager = fileManager
    }

    func replace(originalURL: URL, replacementURL: URL) throws {
        if shouldFail { throw TestCaptureError.failed }
        _ = try fileManager.replaceItemAt(originalURL, withItemAt: replacementURL)
    }
}

private final class ConsumeMoveController {
    var shouldFail = true
    private let fileManager: FileManager

    init(fileManager: FileManager) {
        self.fileManager = fileManager
    }

    func move(sourceURL: URL, destinationURL: URL) throws {
        if shouldFail { throw TestCaptureError.failed }
        try fileManager.moveItem(at: sourceURL, to: destinationURL)
    }
}

private final class DiscardRootController: @unchecked Sendable {
    private(set) var discardCount = 0

    func discard(_ url: URL) throws {
        discardCount += 1
        throw TestCaptureError.failed
    }
}

private actor TestFramingEvaluator: FramingEvaluating {
    private var observations: [FramingObservation]

    init(observations: [FramingObservation]) {
        self.observations = observations
    }

    func evaluate(frame: CaptureFrame) async throws -> FramingObservation {
        observations.isEmpty ? .noSubject : observations.removeFirst()
    }
}

private struct TestLibraryPhotoLoader: CaptureLibraryPhotoLoading {
    let load: @MainActor () async throws -> Data?

    init(load: @escaping @MainActor () async throws -> Data?) {
        self.load = load
    }

    func loadPhotoData() async throws -> Data? {
        try await load()
    }
}

private enum LibraryPayloadEvent: Equatable {
    case loaded(UInt8)
    case staged(UInt8)
    case released(UInt8)
}

private final class LibraryPayloadLifetimeTracker: @unchecked Sendable {
    private let lock = NSLock()
    private var residentCount = 0
    private var maximumResidentCount = 0
    private var recordedEvents: [LibraryPayloadEvent] = []

    var residentPayloads: Int {
        lock.withLock { residentCount }
    }

    var maximumResidentPayloads: Int {
        lock.withLock { maximumResidentCount }
    }

    var events: [LibraryPayloadEvent] {
        lock.withLock { recordedEvents }
    }

    func makePayload(byte: UInt8, size: Int = 2 * 1_024 * 1_024) -> Data {
        let pointer = UnsafeMutableRawPointer.allocate(
            byteCount: size,
            alignment: MemoryLayout<UInt8>.alignment
        )
        pointer.initializeMemory(as: UInt8.self, repeating: byte, count: size)
        lock.withLock {
            residentCount += 1
            maximumResidentCount = max(maximumResidentCount, residentCount)
            recordedEvents.append(.loaded(byte))
        }
        return Data(
            bytesNoCopy: pointer,
            count: size,
            deallocator: .custom { [self] pointer, _ in
                pointer.deallocate()
                lock.withLock {
                    residentCount -= 1
                    recordedEvents.append(.released(byte))
                }
            }
        )
    }

    func recordStage(byte: UInt8) {
        lock.withLock { recordedEvents.append(.staged(byte)) }
    }
}

private final class LifetimeTrackingCaptureStore: CaptureDraftStoring {
    private let tracker: LibraryPayloadLifetimeTracker
    private(set) var stagedPhotos: [StagedCapturePhoto] = []
    private(set) var stagedBytes: [UInt8] = []

    init(tracker: LibraryPayloadLifetimeTracker) {
        self.tracker = tracker
    }

    func load() async throws -> StagedCapturePhoto? { stagedPhotos.first }
    func loadPhotos() async throws -> [StagedCapturePhoto] { stagedPhotos }

    func stage(
        imageData: Data,
        libraryTransferReceipt: LibraryPhotoTransferReceipt?
    ) async throws -> StagedCapturePhoto {
        stagedPhotos = []
        stagedBytes = []
        return try await append(
            imageData: imageData,
            libraryTransferReceipt: libraryTransferReceipt
        ).appendedPhoto
    }

    func append(
        imageData: Data,
        libraryTransferReceipt: LibraryPhotoTransferReceipt?
    ) async throws -> CaptureDraftAppendResult {
        let byte = try XCTUnwrap(imageData.first)
        tracker.recordStage(byte: byte)
        stagedBytes.append(byte)
        let index = stagedPhotos.count
        let photo = StagedCapturePhoto(
            id: UUID(),
            photoURL: URL(fileURLWithPath: "/tmp/lifetime-photo-\(index).jpg"),
            thumbnailURL: URL(fileURLWithPath: "/tmp/lifetime-thumb-\(index).jpg"),
            createdAt: Date(),
            libraryTransferReceipt: libraryTransferReceipt
        )
        stagedPhotos.append(photo)
        return CaptureDraftAppendResult(appendedPhoto: photo, photos: stagedPhotos)
    }

    func discard() async throws {
        stagedPhotos = []
        stagedBytes = []
    }

    func replacePhotos(with photos: [StagedCapturePhoto]) async throws {
        stagedPhotos = photos
    }
}

private final class TestCaptureStore: CaptureDraftStoring {
    var stagedPhotos: [StagedCapturePhoto]
    var staged: StagedCapturePhoto? { stagedPhotos.first }
    var stageCount = 0
    var discardCount = 0
    var lastStagedImageData: Data?
    var stagedImageData: [Data] = []
    var loadPhotosCount = 0
    private var stageError: Error?
    private let loadPhotosError: Error?

    init(
        staged: StagedCapturePhoto? = nil,
        stageError: Error? = nil,
        loadPhotosError: Error? = nil
    ) {
        stagedPhotos = staged.map { [$0] } ?? []
        self.stageError = stageError
        self.loadPhotosError = loadPhotosError
    }

    func load() async throws -> StagedCapturePhoto? { staged }
    func loadPhotos() async throws -> [StagedCapturePhoto] {
        loadPhotosCount += 1
        if let loadPhotosError { throw loadPhotosError }
        return stagedPhotos
    }

    func stage(
        imageData: Data,
        libraryTransferReceipt: LibraryPhotoTransferReceipt?
    ) async throws -> StagedCapturePhoto {
        stageCount += 1
        lastStagedImageData = imageData
        stagedImageData = [imageData]
        if let stageError {
            self.stageError = nil
            throw stageError
        }
        let photo = StagedCapturePhoto(
            id: UUID(),
            photoURL: URL(fileURLWithPath: "/tmp/photo.jpg"),
            thumbnailURL: URL(fileURLWithPath: "/tmp/thumb.jpg"),
            createdAt: Date(),
            libraryTransferReceipt: libraryTransferReceipt
        )
        stagedPhotos = [photo]
        return photo
    }

    func append(
        imageData: Data,
        libraryTransferReceipt: LibraryPhotoTransferReceipt?
    ) async throws -> CaptureDraftAppendResult {
        stageCount += 1
        lastStagedImageData = imageData
        stagedImageData.append(imageData)
        if let stageError {
            self.stageError = nil
            throw stageError
        }
        let index = stagedPhotos.count
        let photo = StagedCapturePhoto(
            id: UUID(),
            photoURL: URL(fileURLWithPath: "/tmp/photo-\(index).jpg"),
            thumbnailURL: URL(fileURLWithPath: "/tmp/thumb-\(index).jpg"),
            createdAt: Date(),
            libraryTransferReceipt: libraryTransferReceipt
        )
        stagedPhotos.append(photo)
        return CaptureDraftAppendResult(appendedPhoto: photo, photos: stagedPhotos)
    }

    func discard() async throws {
        discardCount += 1
        stagedPhotos = []
    }

    func replacePhotos(with photos: [StagedCapturePhoto]) async throws {
        stagedPhotos = photos
    }
}

private final class PhotoReviewManifestWriteFailer: @unchecked Sendable {
    enum InjectedError: Error {
        case writeFailed
    }

    private let lock = NSLock()
    private var writes = 0

    var writeCount: Int {
        lock.withLock { writes }
    }

    func write(
        data _: Data,
        url _: URL,
        options _: Data.WritingOptions
    ) throws {
        lock.withLock { writes += 1 }
        throw InjectedError.writeFailed
    }
}
