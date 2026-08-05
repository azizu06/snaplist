import AVFoundation
import ImageIO
import Observation
import SwiftUI
import UIKit
import XCTest
@testable import SnapList

@MainActor
final class CaptureFlowTests: XCTestCase {
    func testCaptureOffersNeitherAHaulNorABarcodeEntryPoint() {
        XCTAssertEqual(
            CaptureEntryPoint.allCases.map(\.title),
            ["Take one item", "Choose from library"]
        )

        let retired = ["Photograph a haul", "Scan barcode or ISBN"]
        for title in retired {
            XCTAssertFalse(CaptureEntryPoint.allCases.map(\.title).contains(title))
        }
    }

    func testPhotoReviewV14AdaptiveMatrixMatchesApprovedNativeLayout() async throws {
        let proofs = [
            PhotoReviewV14LayoutProof(
                name: "REV-01-390x844",
                state: .onePhoto,
                size: CGSize(width: 390, height: 844),
                heroHeight: 406.8125
            ),
            PhotoReviewV14LayoutProof(
                name: "REV-02-375x667",
                size: CGSize(width: 375, height: 667),
                heroHeight: 228.359375
            ),
            PhotoReviewV14LayoutProof(
                name: "REV-02-375x812",
                size: CGSize(width: 375, height: 812),
                heroHeight: 374.8125
            ),
            PhotoReviewV14LayoutProof(
                name: "REV-02-390x844",
                size: CGSize(width: 390, height: 844),
                heroHeight: 406.8125
            ),
            PhotoReviewV14LayoutProof(
                name: "REV-04-390x844",
                state: .actionsOpen,
                size: CGSize(width: 390, height: 844),
                heroHeight: 351.171875
            ),
            PhotoReviewV14LayoutProof(
                name: "REV-03-390x844",
                state: .fivePhotos,
                size: CGSize(width: 390, height: 844),
                heroHeight: 406.8125
            ),
            PhotoReviewV14LayoutProof(
                name: "REV-02-393x852",
                size: CGSize(width: 393, height: 852),
                heroHeight: 414.8125
            ),
            PhotoReviewV14LayoutProof(
                name: "REV-02-402x874",
                size: CGSize(width: 402, height: 874),
                heroHeight: 420
            ),
            PhotoReviewV14LayoutProof(
                name: "REV-02-414x896",
                size: CGSize(width: 414, height: 896),
                heroHeight: 420
            ),
            PhotoReviewV14LayoutProof(
                name: "REV-02-430x932",
                size: CGSize(width: 430, height: 932),
                heroHeight: 420
            ),
            PhotoReviewV14LayoutProof(
                name: "REV-02-440x956",
                size: CGSize(width: 440, height: 956),
                heroHeight: 420
            ),
            // The source proof doubles its 16px root to a literal 32px. Native text
            // uses the closest semantic Dynamic Type category; geometry is still
            // compared to the package's declared 2.0x landmarks, not raw HTML pixels.
            PhotoReviewV14LayoutProof(
                name: "REV-02-375x667-dynamic-type-2x",
                size: CGSize(width: 375, height: 667),
                heroHeight: 196,
                headerHeight: 103,
                dynamicTypeSize: .accessibility2,
                renderedGeometryContract: .semanticDynamicType
            ),
            PhotoReviewV14LayoutProof(
                name: "REV-02-393x852-dynamic-type-2x",
                size: CGSize(width: 393, height: 852),
                heroHeight: 314.609375,
                headerHeight: 103,
                dynamicTypeSize: .accessibility2,
                renderedGeometryContract: .semanticDynamicType
            )
        ]

        let calibrationProbeHeroHeight: CGFloat = 250
        for calibration in PhotoReviewV14NativeCalibration.table {
            XCTAssertEqual(
                PhotoReviewV14AdaptiveLayout.heroHeight(
                    availableMiddleHeight:
                        calibration.fixedContentShare
                        + calibrationProbeHeroHeight,
                    dynamicTypeSize: calibration.dynamicTypeSize
                ),
                calibrationProbeHeroHeight,
                accuracy: 0.001,
                "\(calibration.name): fixed native share calibration"
            )
        }
        XCTAssertEqual(
            PhotoReviewV14AdaptiveLayout.heroHeight(
                availableMiddleHeight:
                    PhotoReviewV14NativeCalibration
                        .exactDeviceRestingAvailableMiddleHeight,
                dynamicTypeSize: .large
            ),
            PhotoReviewV14VisualContract.heroMaximumHeight,
            accuracy: 1,
            "The exact 402x874 resting viewport must enter the 420pt cap."
        )

        XCTAssertEqual(PhotoReviewV14VisualContract.heroMinimumHeight, 196)
        XCTAssertEqual(PhotoReviewV14VisualContract.heroMaximumHeight, 420)
        XCTAssertEqual(PhotoReviewV14VisualContract.headerMinimumHeight, 56)
        XCTAssertEqual(PhotoReviewV14VisualContract.backTargetSize, 44)
        XCTAssertEqual(PhotoReviewV14VisualContract.countFillHex, "#F3F4F6")
        XCTAssertEqual(PhotoReviewV14VisualContract.countRadius, 8)
        XCTAssertEqual(PhotoReviewV14VisualContract.coverFillHex, "#F3F4F6")
        XCTAssertEqual(PhotoReviewV14VisualContract.coverColumnGap, 6)
        XCTAssertEqual(PhotoReviewV14VisualContract.coverRadius, 5)
        XCTAssertEqual(PhotoReviewV14VisualContract.coverVerticalPadding, 1)
        XCTAssertEqual(PhotoReviewV14VisualContract.coverHorizontalPadding, 7)
        XCTAssertFalse(PhotoReviewV14VisualContract.coverHasOutline)

        let renderHost = PhotoReviewV14RenderHost()
        let renderWindowIdentity = renderHost.windowIdentity
        defer { renderHost.tearDown() }

        for proof in proofs {
            let approvedGolden =
                PhotoReviewV14ApprovedGolden.comparable[proof.name]
            switch proof.renderedGeometryContract {
            case .packageCanvasTarget:
                let golden = try XCTUnwrap(
                    approvedGolden,
                    "\(proof.name): missing approved package-golden contract."
                )
                XCTAssertEqual(
                    golden.heroHeight,
                    proof.heroHeight,
                    accuracy: 0.001,
                    "\(proof.name): package-golden hero lineage"
                )
                XCTAssertEqual(golden.tolerancePoints, 1)
                XCTAssertTrue(golden.file.hasSuffix(".png"))
                XCTAssertEqual(golden.sha256.count, 64)
            case .semanticDynamicType:
                XCTAssertNil(
                    approvedGolden,
                    "\(proof.name): semantic native Dynamic Type must not use "
                        + "the literal HTML raster as an exact pixel oracle."
                )
                XCTAssertTrue(
                    PhotoReviewV14ApprovedGolden.evidenceOnlyInteractionIDs
                        .contains(proof.name),
                    "\(proof.name): semantic native proof must stay evidence-only."
                )
            }

            XCTAssertEqual(
                PhotoReviewV14AdaptiveLayout.heroHeight(
                    availableMiddleHeight: proof.availableMiddleHeight,
                    dynamicTypeSize: proof.dynamicTypeSize,
                    presentsActions: proof.state.presentsActions
                ),
                proof.heroHeight,
                accuracy: 1,
                "\(proof.name): public adaptive formula"
            )

            let result = await renderHost.capture(proof: proof)
            let observation = try XCTUnwrap(
                result.observation,
                "Missing native layout observation for \(proof.name)."
            )

            XCTAssertEqual(
                result.windowIdentity,
                renderWindowIdentity,
                "\(proof.name): every proof must reuse the isolated window."
            )
            XCTAssertFalse(
                result.windowWasKey,
                "\(proof.name): the proof window must never become key."
            )
            XCTAssertEqual(
                result.packageCanvasPadding,
                proof.packageCanvas.renderPadding,
                "\(proof.name): report the package-canvas render padding."
            )
            XCTAssertEqual(proof.packageCanvas.statusHeight, 54)
            XCTAssertEqual(proof.packageCanvas.footerHeight, 99)

            let attachment = XCTAttachment(image: result.image)
            attachment.name = "\(proof.name)-native.png"
            attachment.lifetime = .keepAlways
            add(attachment)

            let renderedHeaderHeight =
                observation.frame(for: .header).height
            let renderedHeroHeight = observation.frame(for: .hero).height
            switch proof.renderedGeometryContract {
            case .packageCanvasTarget:
                let tolerance = try XCTUnwrap(
                    approvedGolden?.tolerancePoints
                )
                XCTAssertEqual(
                    renderedHeaderHeight,
                    proof.headerHeight,
                    accuracy: tolerance,
                    proof.name
                )
                XCTAssertEqual(
                    renderedHeroHeight,
                    proof.heroHeight,
                    accuracy: tolerance,
                    proof.name
                )
            case .semanticDynamicType:
                XCTAssertGreaterThanOrEqual(
                    renderedHeroHeight,
                    PhotoReviewV14VisualContract.heroMinimumHeight,
                    "\(proof.name): semantic Dynamic Type hero minimum"
                )
                XCTAssertLessThanOrEqual(
                    renderedHeroHeight,
                    PhotoReviewV14VisualContract.heroMaximumHeight,
                    "\(proof.name): semantic Dynamic Type hero maximum"
                )
            }
            if proof.dynamicTypeSize == .large {
                XCTAssertEqual(
                    observation.frame(for: .title).midX,
                    result.windowBounds.midX,
                    accuracy: 1,
                    "\(proof.name): centered title"
                )
            } else {
                XCTAssertGreaterThanOrEqual(
                    observation.frame(for: .title).minY,
                    observation.frame(for: .back).maxY,
                    "\(proof.name): two-row Dynamic Type header"
                )
            }

            for landmark in [
                PhotoReviewLayoutLandmark.back,
                .hero,
                .thumbnailStrip,
                .voiceNote,
                .startListing
            ] {
                let frame = observation.frame(for: landmark)
                XCTAssertFalse(frame.isEmpty, "\(proof.name): \(landmark)")
                XCTAssertTrue(
                    result.windowBounds.intersects(frame),
                    "\(proof.name): \(landmark) must remain reachable."
                )
            }

            let addFrame = observation.frame(for: .addPhoto)
            let thumbnailStripFrame =
                observation.frame(for: .thumbnailStrip)
            XCTAssertFalse(addFrame.isEmpty, "\(proof.name): addPhoto")
            XCTAssertGreaterThanOrEqual(
                addFrame.minY,
                thumbnailStripFrame.minY,
                "\(proof.name): Add remains in the horizontal strip."
            )
            XCTAssertLessThanOrEqual(
                addFrame.maxY,
                thumbnailStripFrame.maxY,
                "\(proof.name): Add remains in the horizontal strip."
            )
            switch proof.addViewportContract {
            case .initialViewport:
                XCTAssertTrue(
                    result.windowBounds.intersects(addFrame),
                    "\(proof.name): Add must begin in the visible strip."
                )
            case .horizontalStripContinuation:
                XCTAssertFalse(
                    result.windowBounds.intersects(addFrame),
                    "\(proof.name): the approved five-thumbnail golden keeps "
                        + "Add in the horizontal continuation."
                )
                XCTAssertGreaterThanOrEqual(
                    addFrame.minX,
                    thumbnailStripFrame.maxX,
                    "\(proof.name): Add follows the visible five thumbnails."
                )
            }

            for landmark in [
                PhotoReviewLayoutLandmark.back,
                .addPhoto,
                .voiceNote,
                .startListing
            ] {
                let frame = observation.frame(for: landmark)
                XCTAssertGreaterThanOrEqual(
                    frame.width,
                    44,
                    "\(proof.name): \(landmark) width"
                )
                XCTAssertGreaterThanOrEqual(
                    frame.height,
                    44,
                    "\(proof.name): \(landmark) height"
                )
            }

            XCTAssertLessThanOrEqual(
                observation.frame(for: .header).maxY,
                observation.frame(for: .hero).minY,
                "\(proof.name): header/hero overlap"
            )
            XCTAssertLessThanOrEqual(
                observation.frame(for: .hero).maxY,
                observation.frame(for: .thumbnailStrip).minY,
                "\(proof.name): hero/strip overlap"
            )
            XCTAssertLessThanOrEqual(
                observation.frame(for: .thumbnailStrip).maxY,
                proof.state.presentsActions
                    ? observation.frame(for: .actionRow).minY
                    : observation.frame(for: .voiceNote).minY,
                "\(proof.name): strip/next in-flow content overlap"
            )
            if proof.state.presentsActions {
                XCTAssertGreaterThanOrEqual(
                    observation.frame(for: .actionRow).height,
                    44,
                    "\(proof.name): action row touch floor"
                )
                XCTAssertLessThanOrEqual(
                    observation.frame(for: .actionRow).maxY,
                    observation.frame(for: .voiceNote).minY,
                    "\(proof.name): action row/Voice note overlap"
                )
            }
            let scrollViewportBounds = CGRect(
                x: result.windowBounds.minX,
                y: observation.frame(for: .header).maxY,
                width: result.windowBounds.width,
                height: max(
                    0,
                    observation.frame(for: .footer).minY
                        - observation.frame(for: .header).maxY
                )
            )
            XCTAssertGreaterThan(
                scrollViewportBounds.height,
                0,
                "\(proof.name): scroll viewport height"
            )
            XCTAssertLessThanOrEqual(
                scrollViewportBounds.maxY,
                observation.frame(for: .footer).minY,
                "\(proof.name): scroll viewport/sticky footer overlap"
            )
            XCTAssertGreaterThanOrEqual(
                observation.frame(for: .voiceNote).minY,
                scrollViewportBounds.minY,
                "\(proof.name): Voice note remains a scroll descendant"
            )

            let packageCanvasContentBottom =
                result.windowBounds.maxY
                    - result.packageCanvasPadding.bottom
            XCTAssertLessThanOrEqual(
                observation.frame(for: .footer).maxY,
                packageCanvasContentBottom,
                "\(proof.name): footer must remain inside the package canvas."
            )

            XCTAssertEqual(
                result.image.hexColor(
                    insideLeadingEdgeOf: observation.frame(for: .countPill)
                ),
                "#F3F4F6",
                "\(proof.name): count pill quiet fill"
            )
            XCTAssertEqual(
                result.image.hexColor(
                    insideLeadingEdgeOf:
                        observation.frame(for: .coverPill),
                    inset: 1
                ),
                "#F3F4F6",
                "\(proof.name): Cover pill quiet fill"
            )
        }
    }

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
        let router = AppRouter(
            initialTab: .trophyWall,
            initialFullScreen: .guidedCamera
        )

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
        XCTAssertEqual(router.selectedTab, .scan)
    }

    func testAcceptedSubmissionEventConsumerAnnouncesAndAcknowledgesBeforeExactClearAndReturnsToReadyScan() async throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory.appendingPathComponent(
            "snaplist-accepted-submission-transition-\(UUID().uuidString)",
            isDirectory: true
        )
        defer { try? fileManager.removeItem(at: root) }

        let localStore = LocalCaptureDraftStore(rootDirectory: root)
        let staged = try await localStore.append(
            imageData: makeLandscapeImageData(
                leftColor: .systemRed,
                rightColor: .systemOrange
            ),
            libraryTransferReceipt: nil
        ).appendedPhoto
        let events = AcceptedSubmissionCompositionRecorder()
        let draftStore = AcceptedSubmissionRecordingDraftStore(
            base: localStore,
            events: events
        )
        let camera = AcceptedSubmissionRecordingCamera(events: events)
        let captureFlow = CaptureFlowModel(
            camera: camera,
            evaluator: TestFramingEvaluator(observations: []),
            store: draftStore
        )
        let restoration = await captureFlow.restore()
        XCTAssertEqual(restoration, .stagedPhoto)
        let router = AppRouter(initialFullScreen: .guidedCamera)
        router.openCaptureBoundary(
            destination: .photoReview,
            photos: captureFlow.stagedPhotos,
            opener: .reviewButton
        )
        let photoReviewHost = PhotoReviewLiveHost()
        XCTAssertTrue(photoReviewHost.consume(router.captureBoundaryRequest))
        let session = try XCTUnwrap(photoReviewHost.session)

        let intake = SubmissionIntakeFixture(stagedPhotos: [staged])
        let receipt = intake.receipt
        let attemptStore = AcceptedSubmissionRecordingAttemptStore(events: events)
        let submitter = RecordingItemRunSubmitter(
            outcomes: [.created(receipt)],
            beforeResponse: {
                events.record(.canonicalReceiptReturned)
            }
        )
        let submissionHost = ItemRunSubmissionHost(
            coordinator: ItemRunSubmissionCoordinator(
                submitter: submitter,
                attemptStore: attemptStore,
                draftStore: draftStore,
                tokenProvider: CaptureFlowBearerTokenProvider(),
                readData: intake.read,
                newIdempotencyKey: {
                    UUID(
                        uuidString: "50300000-0000-4000-8000-0000000000b1"
                    )!
                }
            )
        )

        let savedStateObserved = expectation(
            description: "Typed item-saved state observed"
        )
        withObservationTracking {
            _ = submissionHost.pendingPresentationEvent
        } onChange: {
            events.record(.pendingSavedStateObserved)
            savedStateObserved.fulfill()
        }

        let inMemoryDropObserved = expectation(
            description: "In-memory intake drop observed"
        )
        withObservationTracking {
            _ = captureFlow.stagedPhotos
        } onChange: {
            events.record(.inMemoryIntakeDropped)
            inMemoryDropObserved.fulfill()
        }

        let zeroPhotoRouteObserved = expectation(
            description: "Zero-photo Scan route commit observed"
        )
        withObservationTracking {
            _ = router.photoReviewScanReturn
        } onChange: {
            events.record(.zeroPhotoScanRouteCommitted)
            zeroPhotoRouteObserved.fulfill()
        }

        var pendingScanFocus: PhotoReviewScanFocus?
        let transaction = Task {
            await AppShellPhotoReviewSubmissionTransaction.perform(
                session: session,
                captureFlow: captureFlow,
                host: photoReviewHost,
                router: router,
                submissionHost: submissionHost,
                setReturnFocus: { focus in
                    pendingScanFocus = focus
                    events.record(.pendingFocusInstalled(focus))
                }
            )
        }
        defer { transaction.cancel() }

        await fulfillment(of: [savedStateObserved], timeout: 3)
        guard case .itemSaved(let eventID, let handoff)? =
            submissionHost.pendingPresentationEvent else {
            return XCTFail("Expected one typed pending item-saved event.")
        }
        let expectedRun = AcceptedItemRun(
            runID: receipt.runId,
            itemID: receipt.itemId,
            status: receipt.status,
            stage: receipt.stage
        )
        let savedPresentation = PhotoReviewSubmissionPresentation(
            host: submissionHost
        )

        XCTAssertEqual(handoff.acceptedRun, expectedRun)
        XCTAssertEqual(submissionHost.acceptedRun, expectedRun)
        XCTAssertEqual(savedPresentation.primaryActionLabel, "Item saved")
        XCTAssertEqual(
            savedPresentation.announcementEvent,
            .itemSaved(eventID: eventID)
        )
        XCTAssertEqual(
            savedPresentation.accessibilityAnnouncement,
            "Item saved."
        )
        XCTAssertFalse(savedPresentation.rendersSubmittedMedia)
        XCTAssertTrue(photoReviewHost.isCommitting)
        XCTAssertTrue(photoReviewHost.session === session)
        XCTAssertEqual(session.store.photos, [staged])
        let durablePhotosBeforeAcknowledgment = try await draftStore.loadPhotos()
        let attemptBeforeAcknowledgment = await attemptStore.attempt
        XCTAssertEqual(durablePhotosBeforeAcknowledgment, [staged])
        XCTAssertNotNil(attemptBeforeAcknowledgment)
        XCTAssertTrue(fileManager.fileExists(atPath: staged.photoURL.path))
        XCTAssertTrue(fileManager.fileExists(atPath: staged.thumbnailURL.path))

        let lockReleaseObserved = expectation(
            description: "Submission transaction lock release observed"
        )
        withObservationTracking {
            _ = photoReviewHost.isCommitting
        } onChange: {
            events.record(.transactionLockReleased)
            lockReleaseObserved.fulfill()
        }

        var effectConsumer = PhotoReviewSubmissionEffectConsumer()
        effectConsumer.consume(
            savedPresentation,
            postAnnouncement: { announcement in
                events.record(.announcementPosted(announcement))
            },
            acknowledgePresentation: { acknowledgedEventID in
                events.record(
                    .matchingAcknowledgment(acknowledgedEventID)
                )
                submissionHost.acknowledgePresentation(
                    eventID: acknowledgedEventID
                )
            }
        )
        effectConsumer.consume(
            PhotoReviewSubmissionPresentation(host: submissionHost),
            postAnnouncement: { announcement in
                events.record(.announcementPosted(announcement))
            },
            acknowledgePresentation: { acknowledgedEventID in
                events.record(
                    .matchingAcknowledgment(acknowledgedEventID)
                )
                submissionHost.acknowledgePresentation(
                    eventID: acknowledgedEventID
                )
            }
        )

        await transaction.value
        await fulfillment(
            of: [
                inMemoryDropObserved,
                zeroPhotoRouteObserved,
                lockReleaseObserved,
            ],
            timeout: 3
        )

        XCTAssertEqual(
            events.events,
            [
                .canonicalReceiptReturned,
                .pendingSavedStateObserved,
                .announcementPosted("Item saved."),
                .matchingAcknowledgment(eventID),
                .durableExactClearCompleted,
                .matchingAttemptRetired,
                .inMemoryIntakeDropped,
                .cameraPreparationStarted,
                .cameraStarted,
                .pendingFocusInstalled(.addPhotoButton),
                .zeroPhotoScanRouteCommitted,
                .transactionLockReleased,
            ]
        )
        let durablePhotosAfterRoute = try await draftStore.loadPhotos()
        let attemptAfterRoute = await attemptStore.attempt
        XCTAssertTrue(durablePhotosAfterRoute.isEmpty)
        XCTAssertNil(attemptAfterRoute)
        XCTAssertTrue(captureFlow.stagedPhotos.isEmpty)
        XCTAssertFalse(fileManager.fileExists(atPath: staged.photoURL.path))
        XCTAssertFalse(fileManager.fileExists(atPath: staged.thumbnailURL.path))
        XCTAssertNil(photoReviewHost.session)
        XCTAssertEqual(captureFlow.phase, .camera)
        XCTAssertEqual(camera.startCount, 1)
        XCTAssertEqual(camera.captureCount, 0)
        XCTAssertEqual(
            router.photoReviewScanReturn,
            PhotoReviewScanReturn(photos: [], focus: .addPhotoButton)
        )
        XCTAssertEqual(router.presentedFullScreen, .guidedCamera)
        XCTAssertNil(router.captureBoundaryRequest)
        XCTAssertEqual(router.selectedTab, .scan)
        XCTAssertTrue(router.pathBinding(for: .scan).wrappedValue.isEmpty)
        XCTAssertEqual(pendingScanFocus, .addPhotoButton)
        XCTAssertNil(submissionHost.pendingPresentationEvent)
        XCTAssertFalse(photoReviewHost.isCommitting)
    }

    func testCanonicalPhotoAcceptanceWithUnmatchedVoiceReturnsToEmptyUsableScanAndRetainsVoiceForExpiry() async throws {
        let voiceReceipts: [(
            name: String,
            value: MobileItemSubmissionEnvelope.VoiceReceipt?
        )] = [
            ("null receipt", nil),
            (
                "nonmatching receipt",
                MobileItemSubmissionEnvelope.VoiceReceipt(
                    version: 1,
                    contentSha256: String(repeating: "f", count: 64),
                    byteLength: 1,
                    durationMs: 1,
                    mediaType: ItemRunSubmissionVoice.mediaType
                )
            ),
        ]
        let acceptances: [(
            name: String,
            outcome: (MobileItemSubmissionEnvelope.DataPayload)
                -> ItemRunSubmissionTransportOutcome
        )] = [
            ("created", { .created($0) }),
            ("replayed", { .replayed($0) }),
        ]
        let cases = voiceReceipts.flatMap { receipt in
            acceptances.map { acceptance in
                (
                    name: "\(receipt.name)/\(acceptance.name)",
                    voiceReceipt: receipt.value,
                    outcome: acceptance.outcome
                )
            }
        }

        for testCase in cases {
            let fileManager = FileManager.default
            let root = fileManager.temporaryDirectory.appendingPathComponent(
                "snaplist-photo-only-acceptance-\(UUID().uuidString)",
                isDirectory: true
            )
            defer { try? fileManager.removeItem(at: root) }
            let startedAt = Date(timeIntervalSince1970: 2_100_000_000)
            let subject = "user_photo_only_\(testCase.name)"
            let photoData = try makeLandscapeImageData(
                leftColor: .systemIndigo,
                rightColor: .systemMint
            )
            let voiceData = photoOnlyAcceptanceVoiceWAV()
            let nativeIntake = NativeIntake(
                applicationSupportDirectory: root,
                identitySource: NativeIntake.IdentitySource(
                    current: {
                        NativeIntake.Identity(
                            verifiedClerkSubject: subject,
                            persistedAppAttestKeyID: nil
                        )
                    },
                    changes: { AsyncStream { _ in } }
                ),
                now: { startedAt }
            )
            let nativeEvents = await nativeIntake.events()
            var nativeIterator = nativeEvents.makeAsyncIterator()
            _ = await nativeIterator.next()
            let addPhotoOutcome = await nativeIntake.perform(
                .addPhotos([
                    NativeIntake.PhotoInput { photoData },
                ])
            )
            XCTAssertEqual(addPhotoOutcome, .committed, testCase.name)
            let setVoiceOutcome = await nativeIntake.perform(
                .setVoice(
                    NativeIntake.VoiceInput(
                        duration: 0.001,
                        loadData: { voiceData }
                    )
                )
            )
            XCTAssertEqual(setVoiceOutcome, .committed, testCase.name)
            var submittedSnapshot: NativeIntake.Snapshot?
            while let event = await nativeIterator.next() {
                guard case .snapshot(let snapshot) = event else { continue }
                if snapshot.photos.count == 1, snapshot.voice != nil {
                    submittedSnapshot = snapshot
                    break
                }
            }
            let snapshot = try XCTUnwrap(submittedSnapshot, testCase.name)
            let submittedPhoto = try XCTUnwrap(snapshot.photos.first)
            let submittedVoice = try XCTUnwrap(snapshot.voice)
            let principalRoot = submittedPhoto.photoURL
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .deletingLastPathComponent()
            let originalManifest = principalRoot
                .appendingPathComponent("Current", isDirectory: true)
                .appendingPathComponent("bundle.json")
            let originalExpiry = try JSONDecoder().decode(
                PhotoOnlyAcceptanceExpiry.self,
                from: Data(contentsOf: originalManifest)
            ).expiresAt
            XCTAssertEqual(
                originalExpiry,
                startedAt.addingTimeInterval(NativeIntake.recoveryWindow),
                testCase.name
            )
            let scopeProof = try XCTUnwrap(
                ItemRunSubmissionPrincipalScopeProof(
                    filesystemRoot: principalRoot
                ),
                testCase.name
            )
            let photoReceipt = try XCTUnwrap(
                SubmissionIntakeFixture(
                    stagedPhotos: snapshot.photos
                ).expectedReceiptPhotos.first
            )
            let receipt = MobileItemSubmissionEnvelope.DataPayload(
                itemId: UUID(),
                runId: UUID(),
                status: "queued",
                stage: "queued",
                photoIdentity: .init(
                    kind: "content_sha256_set_v1",
                    fingerprint: String(repeating: "a", count: 64)
                ),
                photos: [photoReceipt],
                voiceContext: testCase.voiceReceipt
            )
            let acceptance = testCase.outcome(receipt)
            let captureStore = RecordingCaptureDraftStore(
                photos: snapshot.photos
            )
            let camera = TestCaptureCamera(
                isAvailable: true,
                authorization: .authorized
            )
            let captureFlow = CaptureFlowModel(
                camera: camera,
                evaluator: TestFramingEvaluator(observations: []),
                store: captureStore
            )
            let restoration = await captureFlow.restore()
            XCTAssertEqual(restoration, .stagedPhoto)
            let router = AppRouter(initialFullScreen: .guidedCamera)
            router.openCaptureBoundary(
                destination: .photoReview,
                photos: captureFlow.stagedPhotos,
                opener: .reviewButton
            )
            let photoReviewHost = PhotoReviewLiveHost()
            XCTAssertTrue(
                photoReviewHost.consume(router.captureBoundaryRequest),
                testCase.name
            )
            let session = try XCTUnwrap(
                photoReviewHost.session,
                testCase.name
            )
            let submitter = RecordingItemRunSubmitter(
                outcomes: [acceptance]
            )
            let submissionHost = ItemRunSubmissionHost(
                coordinator: ItemRunSubmissionCoordinator(
                    submitter: submitter,
                    attemptStore: InMemoryItemRunSubmissionAttemptStore(),
                    draftStore: captureStore,
                    tokenProvider: PhotoOnlyAcceptanceBearerTokenProvider(
                        scopeProof: scopeProof
                    ),
                    newIdempotencyKey: { UUID() }
                )
            )
            submissionHost.synchronizePrincipal(
                snapshot: snapshot,
                intake: nativeIntake
            )
            let savedStateObserved = expectation(
                description: "\(testCase.name) accepted handoff observed"
            )
            withObservationTracking {
                _ = submissionHost.pendingPresentationEvent
            } onChange: {
                savedStateObserved.fulfill()
            }
            var pendingScanFocus: PhotoReviewScanFocus?
            let transaction = Task {
                await AppShellPhotoReviewSubmissionTransaction.perform(
                    session: session,
                    captureFlow: captureFlow,
                    host: photoReviewHost,
                    router: router,
                    submissionHost: submissionHost,
                    setReturnFocus: { pendingScanFocus = $0 }
                )
            }
            await fulfillment(of: [savedStateObserved], timeout: 3)
            guard case .itemSaved(let eventID, let handoff)? =
                submissionHost.pendingPresentationEvent else {
                transaction.cancel()
                return XCTFail(
                    "Expected one accepted handoff for \(testCase.name)."
                )
            }
            XCTAssertEqual(handoff.acceptedRun.runID, receipt.runId)
            var effectConsumer = PhotoReviewSubmissionEffectConsumer()
            var announcements: [String] = []
            effectConsumer.consume(
                PhotoReviewSubmissionPresentation(host: submissionHost),
                postAnnouncement: { announcements.append($0) },
                acknowledgePresentation: {
                    submissionHost.acknowledgePresentation(eventID: $0)
                }
            )
            await transaction.value

            XCTAssertEqual(announcements, ["Item saved."], testCase.name)
            XCTAssertEqual(submissionHost.acceptedRun?.runID, receipt.runId)
            XCTAssertTrue(submissionHost.clearedIntake, testCase.name)
            XCTAssertNil(submissionHost.pendingPresentationEvent)
            XCTAssertNil(photoReviewHost.session, testCase.name)
            XCTAssertTrue(captureFlow.stagedPhotos.isEmpty, testCase.name)
            XCTAssertEqual(captureFlow.phase, .camera, testCase.name)
            XCTAssertEqual(pendingScanFocus, .addPhotoButton, testCase.name)
            XCTAssertEqual(
                router.photoReviewScanReturn,
                PhotoReviewScanReturn(photos: [], focus: .addPhotoButton),
                testCase.name
            )
            XCTAssertEqual(
                router.presentedFullScreen,
                .guidedCamera,
                testCase.name
            )
            XCTAssertFalse(
                fileManager.fileExists(atPath: submittedPhoto.photoURL.path),
                testCase.name
            )
            XCTAssertFalse(
                fileManager.fileExists(atPath: submittedVoice.mediaURL.path),
                testCase.name
            )
            let storedAttempt = try await LocalItemRunSubmissionAttemptStore(
                principalRootDirectory: principalRoot
            ).loadAttempt()
            XCTAssertNil(storedAttempt, testCase.name)
            let acceptedSnapshot = try await currentSnapshot(of: nativeIntake)
            XCTAssertTrue(acceptedSnapshot.photos.isEmpty, testCase.name)
            XCTAssertNil(acceptedSnapshot.voice, testCase.name)

            let deferredMetadataURL = try XCTUnwrap(
                fileManager.enumerator(
                    at: principalRoot,
                    includingPropertiesForKeys: nil
                )?.compactMap { $0 as? URL }
                    .first { $0.lastPathComponent == "entry.json" },
                testCase.name
            )
            let deferred = try JSONDecoder().decode(
                PhotoOnlyAcceptanceDeferredVoice.self,
                from: Data(contentsOf: deferredMetadataURL)
            )
            XCTAssertEqual(deferred.expiresAt, originalExpiry, testCase.name)
            XCTAssertEqual(deferred.voice.id, submittedVoice.id, testCase.name)
            XCTAssertEqual(deferred.voice.duration, submittedVoice.duration)
            XCTAssertTrue(
                deferred.voice.mediaURL.path.hasPrefix(principalRoot.path + "/"),
                testCase.name
            )
            XCTAssertEqual(
                try Data(contentsOf: deferred.voice.mediaURL),
                voiceData,
                testCase.name
            )

            let nextPhotoData = try makeLandscapeImageData(
                leftColor: .systemOrange,
                rightColor: .systemBlue
            )
            let nextPhoto = await nativeIntake.performReturningSnapshot(
                .addPhotos([
                    NativeIntake.PhotoInput { nextPhotoData },
                ]),
                expectedActivationID: acceptedSnapshot.version.activationID
            )
            XCTAssertEqual(nextPhoto.outcome, .committed, testCase.name)
            XCTAssertEqual(nextPhoto.snapshot?.photos.count, 1, testCase.name)
            XCTAssertNil(nextPhoto.snapshot?.voice, testCase.name)
            XCTAssertTrue(
                fileManager.fileExists(atPath: deferred.voice.mediaURL.path),
                testCase.name
            )
            XCTAssertEqual(
                try JSONDecoder().decode(
                    PhotoOnlyAcceptanceDeferredVoice.self,
                    from: Data(contentsOf: deferredMetadataURL)
                ).expiresAt,
                originalExpiry,
                testCase.name
            )
            let payloads = await submitter.payloads
            XCTAssertEqual(payloads.count, 1, testCase.name)
        }
    }

    func testAcceptedSubmissionWithChangedDurableIntakeKeepsPhotoReviewAndAttempt() async throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory.appendingPathComponent(
            "snaplist-changed-intake-submission-\(UUID().uuidString)",
            isDirectory: true
        )
        defer { try? fileManager.removeItem(at: root) }

        let localStore = LocalCaptureDraftStore(rootDirectory: root)
        let submitted = try await localStore.append(
            imageData: makeLandscapeImageData(
                leftColor: .systemIndigo,
                rightColor: .systemMint
            ),
            libraryTransferReceipt: nil
        ).appendedPhoto
        let events = AcceptedSubmissionCompositionRecorder()
        let draftStore = AcceptedSubmissionRecordingDraftStore(
            base: localStore,
            events: events
        )
        let camera = AcceptedSubmissionRecordingCamera(events: events)
        let captureFlow = CaptureFlowModel(
            camera: camera,
            evaluator: TestFramingEvaluator(observations: []),
            store: draftStore
        )
        let restoration = await captureFlow.restore()
        XCTAssertEqual(restoration, .stagedPhoto)
        let router = AppRouter(initialFullScreen: .guidedCamera)
        router.openCaptureBoundary(
            destination: .photoReview,
            photos: captureFlow.stagedPhotos,
            opener: .reviewButton
        )
        let routeBeforeSubmission = router.captureBoundaryRequest
        let fullScreenBeforeSubmission = router.presentedFullScreen
        let scanReturnBeforeSubmission = router.photoReviewScanReturn
        let selectedTabBeforeSubmission = router.selectedTab
        let scanPathBeforeSubmission =
            router.pathBinding(for: .scan).wrappedValue
        let trophyWallPathBeforeSubmission =
            router.pathBinding(for: .trophyWall).wrappedValue

        let photoReviewHost = PhotoReviewLiveHost()
        XCTAssertTrue(photoReviewHost.consume(routeBeforeSubmission))
        let session = try XCTUnwrap(photoReviewHost.session)
        let sessionPhotosBeforeSubmission = session.store.photos
        let selectedPhotoBeforeSubmission = session.store.selectedPhotoID
        let stagedPhotosBeforeSubmission = captureFlow.stagedPhotos
        let capturePhaseBeforeSubmission = captureFlow.phase

        let intake = SubmissionIntakeFixture(stagedPhotos: [submitted])
        let receipt = intake.receipt
        let attemptStore = AcceptedSubmissionRecordingAttemptStore(
            events: events
        )
        let submitter = RecordingItemRunSubmitter(
            outcomes: [.created(receipt)],
            beforeResponse: {
                events.record(.canonicalReceiptReturned)
            }
        )
        let submissionHost = ItemRunSubmissionHost(
            coordinator: ItemRunSubmissionCoordinator(
                submitter: submitter,
                attemptStore: attemptStore,
                draftStore: draftStore,
                tokenProvider: CaptureFlowBearerTokenProvider(),
                readData: intake.read,
                newIdempotencyKey: {
                    UUID(
                        uuidString: "50300000-0000-4000-8000-0000000000c1"
                    )!
                }
            )
        )

        let savedStateObserved = expectation(
            description: "Changed-intake run presents its saved state"
        )
        withObservationTracking {
            _ = submissionHost.pendingPresentationEvent
        } onChange: {
            events.record(.pendingSavedStateObserved)
            savedStateObserved.fulfill()
        }
        withObservationTracking {
            _ = captureFlow.stagedPhotos
        } onChange: {
            events.record(.inMemoryIntakeDropped)
        }
        withObservationTracking {
            _ = router.photoReviewScanReturn
        } onChange: {
            events.record(.zeroPhotoScanRouteCommitted)
        }

        var pendingScanFocus: PhotoReviewScanFocus?
        let transaction = Task {
            await AppShellPhotoReviewSubmissionTransaction.perform(
                session: session,
                captureFlow: captureFlow,
                host: photoReviewHost,
                router: router,
                submissionHost: submissionHost,
                setReturnFocus: { focus in
                    pendingScanFocus = focus
                    events.record(.pendingFocusInstalled(focus))
                }
            )
        }
        defer { transaction.cancel() }

        await fulfillment(of: [savedStateObserved], timeout: 3)
        guard case .itemSaved(let eventID, let handoff)? =
            submissionHost.pendingPresentationEvent else {
            return XCTFail("Expected the canonical item-saved presentation.")
        }
        let expectedRun = AcceptedItemRun(
            runID: receipt.runId,
            itemID: receipt.itemId,
            status: receipt.status,
            stage: receipt.stage
        )
        let savedPresentation = PhotoReviewSubmissionPresentation(
            host: submissionHost
        )
        let persistedAttemptBeforeAcknowledgment = await attemptStore.attempt
        let attemptBeforeAcknowledgment = try XCTUnwrap(
            persistedAttemptBeforeAcknowledgment
        )

        XCTAssertEqual(handoff.acceptedRun, expectedRun)
        XCTAssertEqual(submissionHost.acceptedRun, expectedRun)
        XCTAssertEqual(savedPresentation.primaryActionLabel, "Item saved")
        XCTAssertEqual(
            savedPresentation.announcementEvent,
            .itemSaved(eventID: eventID)
        )
        XCTAssertEqual(
            savedPresentation.accessibilityAnnouncement,
            "Item saved."
        )
        XCTAssertFalse(savedPresentation.rendersSubmittedMedia)
        XCTAssertTrue(photoReviewHost.isCommitting)
        XCTAssertTrue(photoReviewHost.session === session)
        XCTAssertEqual(session.store.photos, sessionPhotosBeforeSubmission)
        XCTAssertEqual(
            session.store.selectedPhotoID,
            selectedPhotoBeforeSubmission
        )

        let changed = try await draftStore.append(
            imageData: makeLandscapeImageData(
                leftColor: .systemYellow,
                rightColor: .systemPurple
            ),
            libraryTransferReceipt: nil
        ).appendedPhoto
        let changedDurablePhotos = try await draftStore.loadPhotos()
        XCTAssertEqual(changedDurablePhotos, [submitted, changed])
        XCTAssertTrue(fileManager.fileExists(atPath: submitted.photoURL.path))
        XCTAssertTrue(fileManager.fileExists(atPath: changed.photoURL.path))
        XCTAssertTrue(photoReviewHost.isCommitting)
        XCTAssertTrue(photoReviewHost.session === session)

        let lockReleaseObserved = expectation(
            description: "Changed-intake transaction lock released"
        )
        withObservationTracking {
            _ = photoReviewHost.isCommitting
        } onChange: {
            events.record(.transactionLockReleased)
            lockReleaseObserved.fulfill()
        }

        var effectConsumer = PhotoReviewSubmissionEffectConsumer()
        effectConsumer.consume(
            savedPresentation,
            postAnnouncement: { announcement in
                events.record(.announcementPosted(announcement))
            },
            acknowledgePresentation: { acknowledgedEventID in
                events.record(
                    .matchingAcknowledgment(acknowledgedEventID)
                )
                submissionHost.acknowledgePresentation(
                    eventID: acknowledgedEventID
                )
            }
        )

        await fulfillment(of: [lockReleaseObserved], timeout: 3)
        await transaction.value

        XCTAssertEqual(
            events.events,
            [
                .canonicalReceiptReturned,
                .pendingSavedStateObserved,
                .durableIntakeChanged,
                .announcementPosted("Item saved."),
                .matchingAcknowledgment(eventID),
                .durableExactClearRefused,
                .transactionLockReleased,
            ]
        )
        XCTAssertFalse(submissionHost.clearedIntake)
        XCTAssertEqual(submissionHost.acceptedRun, expectedRun)
        XCTAssertNil(submissionHost.pendingPresentationEvent)
        let attemptAfterRefusal = await attemptStore.attempt
        let durablePhotosAfterRefusal = try await draftStore.loadPhotos()
        XCTAssertEqual(attemptAfterRefusal, attemptBeforeAcknowledgment)
        XCTAssertEqual(durablePhotosAfterRefusal, changedDurablePhotos)
        XCTAssertEqual(captureFlow.stagedPhotos, stagedPhotosBeforeSubmission)
        XCTAssertEqual(captureFlow.phase, capturePhaseBeforeSubmission)
        XCTAssertTrue(photoReviewHost.session === session)
        XCTAssertEqual(session.store.photos, sessionPhotosBeforeSubmission)
        XCTAssertEqual(
            session.store.selectedPhotoID,
            selectedPhotoBeforeSubmission
        )
        XCTAssertEqual(router.captureBoundaryRequest, routeBeforeSubmission)
        XCTAssertEqual(
            router.presentedFullScreen,
            fullScreenBeforeSubmission
        )
        XCTAssertEqual(
            router.photoReviewScanReturn,
            scanReturnBeforeSubmission
        )
        XCTAssertEqual(router.selectedTab, selectedTabBeforeSubmission)
        XCTAssertEqual(
            router.pathBinding(for: .scan).wrappedValue,
            scanPathBeforeSubmission
        )
        XCTAssertEqual(
            router.pathBinding(for: .trophyWall).wrappedValue,
            trophyWallPathBeforeSubmission
        )
        XCTAssertEqual(
            router.captureBoundaryRequest?.destination,
            .photoReview
        )
        XCTAssertNil(pendingScanFocus)
        XCTAssertEqual(camera.startCount, 0)
        XCTAssertEqual(camera.captureCount, 0)
        XCTAssertFalse(photoReviewHost.isCommitting)
        XCTAssertTrue(fileManager.fileExists(atPath: submitted.photoURL.path))
        XCTAssertTrue(fileManager.fileExists(atPath: changed.photoURL.path))

        let restoredPresentation = PhotoReviewSubmissionPresentation(
            host: submissionHost
        )
        XCTAssertEqual(restoredPresentation.primaryActionLabel, "Start listing")
        XCTAssertTrue(restoredPresentation.rendersSubmittedMedia)
        XCTAssertFalse(restoredPresentation.mutationControlsLocked)
        XCTAssertNil(restoredPresentation.announcementEvent)
    }

    func testAmbiguousSubmissionPresentsTryAgainAndRetriesExactAttemptOnlyForMatchingEvent() async throws {
        let scenario = try await RetainedSubmissionPhotoReviewScenario.standard(
            name: "snaplist-ambiguous-submission",
            photoData: [
                makeLandscapeImageData(
                    leftColor: .systemIndigo,
                    rightColor: .systemYellow
                ),
                makeLandscapeImageData(
                    leftColor: .systemMint,
                    rightColor: .systemPurple
                ),
            ]
        )
        defer { scenario.cleanUp() }
        let submittedPhotos = scenario.displayedPhotos
        let intake = SubmissionIntakeFixture(stagedPhotos: submittedPhotos)
        let events = AttemptPersistenceRecoveryEventRecorder()
        let attemptStore = RecoveringItemRunSubmissionAttemptStore(
            base: LocalItemRunSubmissionAttemptStore(
                rootDirectory: scenario.attemptRoot
            ),
            events: events
        )
        await attemptStore.recover()
        let tokenProvider = AttemptPersistenceRecordingTokenProvider(
            attemptStore: attemptStore,
            events: events
        )
        let responseGate = SubmissionResponseGate()
        let submitter = RecordingItemRunSubmitter(
            outcomes: [
                .ambiguous,
                .ambiguous,
                .replayed(intake.receipt),
            ],
            beforeResponse: {
                await responseGate.hold(onCall: 2)
            }
        )
        let persistedKey = UUID(
            uuidString: "50300000-0000-4000-8000-000000000072"
        )!
        let unusedFreshKey = UUID(
            uuidString: "50300000-0000-4000-8000-000000000073"
        )!
        let keySequence = KeySequence(
            keys: [persistedKey, unusedFreshKey]
        )
        let submissionHost = ItemRunSubmissionHost(
            coordinator: ItemRunSubmissionCoordinator(
                submitter: submitter,
                attemptStore: attemptStore,
                draftStore: scenario.draftStore,
                tokenProvider: tokenProvider,
                readData: intake.read,
                newIdempotencyKey: { keySequence.next() }
            )
        )

        await scenario.perform(submissionHost: submissionHost)

        XCTAssertEqual(submissionHost.retention, .ambiguous)
        XCTAssertNil(submissionHost.acceptedRun)
        XCTAssertFalse(submissionHost.clearedIntake)
        XCTAssertFalse(submissionHost.isSubmitting)
        XCTAssertFalse(scenario.photoReviewHost.isCommitting)
        let exactMessage =
            "We couldn't confirm this went through. Your item is still saved on this phone."
        var presentationProbe = RetainedSubmissionPresentationProbe()
        let firstEvent = try presentationProbe.assertNewEvent(
            host: submissionHost,
            retention: .ambiguous,
            primaryActionLabel: "Try again",
            primaryActionEvent: {
                .retryAmbiguousSubmission(eventID: $0)
            },
            message: exactMessage
        )
        let firstEventID = firstEvent.eventID

        var payloads = await submitter.payloads
        XCTAssertEqual(payloads.count, 1)
        let firstPayload = try XCTUnwrap(payloads.first)
        let storedAttempt = try await attemptStore.loadAttempt()
        let retainedAttempt = try XCTUnwrap(storedAttempt)
        XCTAssertEqual(retainedAttempt.idempotencyKey, persistedKey)
        XCTAssertEqual(
            retainedAttempt.photos.map(\.photoID),
            submittedPhotos.map(\.id)
        )
        XCTAssertEqual(firstPayload.attempt, retainedAttempt)
        XCTAssertEqual(firstPayload.photoData, intake.expectedBytes)
        let initialTokenCallCount = await tokenProvider.callCount
        let initialAttemptSaveCount =
            await attemptStore.successfulSaveCount
        let initialAttemptClearCount = await attemptStore.clearCount
        XCTAssertEqual(initialTokenCallCount, 1)
        XCTAssertEqual(initialAttemptSaveCount, 1)
        XCTAssertEqual(initialAttemptClearCount, 0)
        XCTAssertEqual(
            events.events,
            [
                .tokenRequested(nil),
                .attemptPersisted(persistedKey),
            ]
        )
        XCTAssertEqual(presentationProbe.announcements, [exactMessage])
        XCTAssertTrue(presentationProbe.acknowledgedEventIDs.isEmpty)
        try await scenario.assertPreserved()

        var wrongUUID = firstEventID.uuid
        wrongUUID.0 ^= 1
        await scenario.perform(
            primaryAction:
                .retryAmbiguousSubmission(eventID: UUID(uuid: wrongUUID)),
            submissionHost: submissionHost
        )
        let payloadsAfterWrongAction = await submitter.payloads
        let tokenCallsAfterWrongAction = await tokenProvider.callCount
        XCTAssertEqual(payloadsAfterWrongAction.count, 1)
        XCTAssertEqual(tokenCallsAfterWrongAction, 1)
        XCTAssertEqual(
            submissionHost.pendingPresentationEvent,
            .submissionRejected(
                eventID: firstEventID,
                retention: .ambiguous
            )
        )

        XCTAssertTrue(
            scenario.session.store.movePhoto(
                id: submittedPhotos[1].id,
                to: 0
            )
        )
        let editedPhotos = scenario.session.store.photos
        let selectedPhotoAfterEdit =
            scenario.session.store.selectedPhotoID
        let actionsPhotoAfterEdit =
            scenario.session.store.actionsPhotoID
        let routeAfterEdit = scenario.router.captureBoundaryRequest
        let fullScreenAfterEdit = scenario.router.presentedFullScreen
        let scanReturnAfterEdit = scenario.router.photoReviewScanReturn

        let retryEnteredSubmission = expectation(
            description: "Matching ambiguous retry enters SUB-01"
        )
        withObservationTracking {
            _ = submissionHost.isSubmitting
        } onChange: {
            retryEnteredSubmission.fulfill()
        }
        let retryTask = Task {
            await scenario.perform(
                primaryAction: firstEvent.presentation.primaryActionEvent,
                submissionHost: submissionHost
            )
        }
        await fulfillment(of: [retryEnteredSubmission], timeout: 3)
        XCTAssertTrue(submissionHost.isSubmitting)
        XCTAssertTrue(scenario.photoReviewHost.isCommitting)
        XCTAssertNil(submissionHost.pendingPresentationEvent)
        await responseGate.release()
        await retryTask.value

        let secondEvent = try presentationProbe.assertNewEvent(
            host: submissionHost,
            retention: .ambiguous,
            primaryActionLabel: "Try again",
            primaryActionEvent: {
                .retryAmbiguousSubmission(eventID: $0)
            },
            message: exactMessage
        )
        XCTAssertNotEqual(secondEvent.eventID, firstEventID)
        XCTAssertEqual(
            presentationProbe.announcements,
            [exactMessage, exactMessage]
        )
        payloads = await submitter.payloads
        XCTAssertEqual(payloads.count, 2)
        XCTAssertEqual(
            payloads.map(\.attempt.idempotencyKey),
            [persistedKey, persistedKey]
        )
        XCTAssertEqual(payloads[0].attempt.photos, payloads[1].attempt.photos)
        XCTAssertEqual(payloads[0].photoData, payloads[1].photoData)
        XCTAssertEqual(payloads[1].photoData, intake.expectedBytes)
        let retryBearerTokenLengths =
            await submitter.bearerTokenLengths
        XCTAssertEqual(retryBearerTokenLengths.count, 2)
        let retryTokenCallCount = await tokenProvider.callCount
        let retryAttemptSaveCount =
            await attemptStore.successfulSaveCount
        let retryAttemptClearCount = await attemptStore.clearCount
        let attemptAfterRetry = try await attemptStore.loadAttempt()
        XCTAssertEqual(retryTokenCallCount, 2)
        XCTAssertEqual(retryAttemptSaveCount, 1)
        XCTAssertEqual(retryAttemptClearCount, 0)
        XCTAssertEqual(attemptAfterRetry, retainedAttempt)

        await scenario.perform(
            primaryAction: firstEvent.presentation.primaryActionEvent,
            submissionHost: submissionHost
        )
        let payloadsAfterDuplicateAction = await submitter.payloads
        let tokenCallsAfterDuplicateAction =
            await tokenProvider.callCount
        XCTAssertEqual(payloadsAfterDuplicateAction.count, 2)
        XCTAssertEqual(tokenCallsAfterDuplicateAction, 2)
        XCTAssertEqual(
            events.events,
            [
                .tokenRequested(nil),
                .attemptPersisted(persistedKey),
                .tokenRequested(persistedKey),
            ]
        )
        let durablePhotosAfterRetry =
            try await scenario.draftStore.loadPhotos()
        XCTAssertEqual(durablePhotosAfterRetry, submittedPhotos)
        XCTAssertEqual(scenario.session.store.photos, editedPhotos)
        XCTAssertEqual(
            scenario.session.store.selectedPhotoID,
            selectedPhotoAfterEdit
        )
        XCTAssertEqual(
            scenario.session.store.actionsPhotoID,
            actionsPhotoAfterEdit
        )
        XCTAssertTrue(
            scenario.photoReviewHost.session === scenario.session
        )
        XCTAssertEqual(
            scenario.router.captureBoundaryRequest,
            routeAfterEdit
        )
        XCTAssertEqual(
            scenario.router.presentedFullScreen,
            fullScreenAfterEdit
        )
        XCTAssertEqual(
            scenario.router.photoReviewScanReturn,
            scanReturnAfterEdit
        )
        XCTAssertNil(scenario.pendingScanFocus)
        XCTAssertEqual(scenario.camera.startCount, 0)
        XCTAssertEqual(scenario.camera.captureCount, 0)
        XCTAssertFalse(scenario.photoReviewHost.isCommitting)

        let acceptedRetryObserved = expectation(
            description: "Exact retry resolves without dropping edited intake"
        )
        withObservationTracking {
            _ = submissionHost.acceptedRun
        } onChange: {
            acceptedRetryObserved.fulfill()
        }
        let acceptedRetry = Task {
            await scenario.perform(
                primaryAction: secondEvent.presentation.primaryActionEvent,
                submissionHost: submissionHost
            )
        }
        defer { acceptedRetry.cancel() }

        await fulfillment(of: [acceptedRetryObserved], timeout: 3)
        guard case .itemSaved(_, _)? =
            submissionHost.pendingPresentationEvent else {
            return XCTFail(
                "Expected the accepted exact retry to present Item saved."
            )
        }
        var savedEffectConsumer = PhotoReviewSubmissionEffectConsumer()
        savedEffectConsumer.consume(
            PhotoReviewSubmissionPresentation(host: submissionHost),
            postAnnouncement: { _ in },
            acknowledgePresentation: {
                submissionHost.acknowledgePresentation(eventID: $0)
            }
        )
        await acceptedRetry.value

        payloads = await submitter.payloads
        XCTAssertEqual(payloads.count, 3)
        XCTAssertEqual(
            payloads.map(\.attempt.idempotencyKey),
            [persistedKey, persistedKey, persistedKey]
        )
        XCTAssertEqual(payloads[2].attempt, retainedAttempt)
        XCTAssertEqual(payloads[2].photoData, intake.expectedBytes)
        let acceptedRetryTokenCallCount = await tokenProvider.callCount
        let acceptedRetryAttemptSaveCount =
            await attemptStore.successfulSaveCount
        let acceptedRetryAttemptClearCount = await attemptStore.clearCount
        let acceptedRetryStoredAttempt =
            try await attemptStore.loadAttempt()
        XCTAssertEqual(acceptedRetryTokenCallCount, 3)
        XCTAssertEqual(acceptedRetryAttemptSaveCount, 1)
        XCTAssertEqual(acceptedRetryAttemptClearCount, 0)
        XCTAssertEqual(acceptedRetryStoredAttempt, retainedAttempt)
        XCTAssertFalse(submissionHost.clearedIntake)
        XCTAssertNil(submissionHost.pendingPresentationEvent)
        let durablePhotosAfterAcceptedRetry =
            try await scenario.draftStore.loadPhotos()
        XCTAssertEqual(
            durablePhotosAfterAcceptedRetry,
            submittedPhotos
        )
        XCTAssertEqual(scenario.session.store.photos, editedPhotos)
        XCTAssertTrue(
            scenario.photoReviewHost.session === scenario.session
        )
        XCTAssertEqual(
            scenario.router.captureBoundaryRequest,
            routeAfterEdit
        )
        XCTAssertEqual(
            scenario.router.presentedFullScreen,
            fullScreenAfterEdit
        )
        XCTAssertEqual(
            scenario.router.photoReviewScanReturn,
            scanReturnAfterEdit
        )
        XCTAssertNil(scenario.pendingScanFocus)
        XCTAssertEqual(scenario.camera.startCount, 0)
        XCTAssertEqual(scenario.camera.captureCount, 0)
        XCTAssertFalse(scenario.photoReviewHost.isCommitting)
    }

    func testConflictSubmissionPresentsReviewAndReviewOnlyRetiresMatchingAdvisory() async throws {
        let scenario = try await RetainedSubmissionPhotoReviewScenario.standard(
            name: "snaplist-conflict-submission-review",
            photoData: [
                makeLandscapeImageData(
                    leftColor: .systemRed,
                    rightColor: .systemBlue
                ),
                makeLandscapeImageData(
                    leftColor: .systemYellow,
                    rightColor: .systemPurple
                ),
            ]
        )
        defer { scenario.cleanUp() }
        let submittedPhotos = scenario.displayedPhotos
        let intake = SubmissionIntakeFixture(stagedPhotos: submittedPhotos)
        let submitter = RecordingItemRunSubmitter(outcomes: [.conflict])
        let attemptStore = LocalItemRunSubmissionAttemptStore(
            rootDirectory: scenario.attemptRoot
        )
        let persistedKey = UUID(
            uuidString: "50300000-0000-4000-8000-000000000082"
        )!
        let unusedFreshKey = UUID(
            uuidString: "50300000-0000-4000-8000-000000000083"
        )!
        let keySequence = KeySequence(
            keys: [persistedKey, unusedFreshKey]
        )
        let submissionHost = ItemRunSubmissionHost(
            coordinator: ItemRunSubmissionCoordinator(
                submitter: submitter,
                attemptStore: attemptStore,
                draftStore: scenario.draftStore,
                tokenProvider: CaptureFlowBearerTokenProvider(),
                readData: intake.read,
                newIdempotencyKey: { keySequence.next() }
            )
        )

        await scenario.perform(submissionHost: submissionHost)

        XCTAssertEqual(submissionHost.retention, .conflict)
        XCTAssertNil(submissionHost.acceptedRun)
        XCTAssertFalse(submissionHost.clearedIntake)
        XCTAssertFalse(submissionHost.isSubmitting)
        XCTAssertFalse(scenario.photoReviewHost.isCommitting)
        let payloadsAfterConflict = await submitter.payloads
        XCTAssertEqual(payloadsAfterConflict.count, 1)
        let conflictedPayload = try XCTUnwrap(payloadsAfterConflict.first)
        XCTAssertEqual(conflictedPayload.attempt.idempotencyKey, persistedKey)
        XCTAssertEqual(conflictedPayload.photoData, intake.expectedBytes)
        let attemptBeforePresentation = try await attemptStore.loadAttempt()
        XCTAssertNil(
            attemptBeforePresentation,
            "The exact wedged attempt retires before SUB-04 is published."
        )

        let visibleMessage =
            "Something changed since your last try. Review your item, then start again."
        let announcement = "Something changed since your last try."
        var presentationProbe = RetainedSubmissionPresentationProbe()
        let conflict = try presentationProbe.assertNewEvent(
            host: submissionHost,
            retention: .conflict,
            primaryActionLabel: "Review",
            primaryActionEvent: {
                .reviewConflictedSubmission(eventID: $0)
            },
            message: visibleMessage,
            announcement: announcement
        )
        let eventID = conflict.eventID
        XCTAssertEqual(
            presentationProbe.announcements,
            [announcement]
        )
        XCTAssertTrue(presentationProbe.acknowledgedEventIDs.isEmpty)
        try await scenario.assertPreserved()

        var staleUUID = eventID.uuid
        staleUUID.0 ^= 1
        await scenario.perform(
            primaryAction: .reviewConflictedSubmission(
                eventID: UUID(uuid: staleUUID)
            ),
            submissionHost: submissionHost
        )
        XCTAssertEqual(
            submissionHost.pendingPresentationEvent,
            .submissionRejected(
                eventID: eventID,
                retention: .conflict
            )
        )
        var payloadsAfterReview = await submitter.payloads
        XCTAssertEqual(payloadsAfterReview.count, 1)

        await scenario.perform(
            primaryAction: conflict.presentation.primaryActionEvent,
            submissionHost: submissionHost
        )
        XCTAssertNil(submissionHost.pendingPresentationEvent)
        let returnedPresentation = PhotoReviewSubmissionPresentation(
            host: submissionHost
        )
        XCTAssertEqual(returnedPresentation.primaryActionLabel, "Start listing")
        XCTAssertNil(returnedPresentation.visibleMessage)
        XCTAssertEqual(
            returnedPresentation.primaryActionEvent,
            .startListing
        )

        await scenario.perform(
            primaryAction: conflict.presentation.primaryActionEvent,
            submissionHost: submissionHost
        )
        payloadsAfterReview = await submitter.payloads
        let attemptAfterDuplicateReview = try await attemptStore.loadAttempt()
        XCTAssertEqual(payloadsAfterReview.count, 1)
        XCTAssertNil(attemptAfterDuplicateReview)
        XCTAssertEqual(submissionHost.retention, .conflict)
        presentationProbe.consumeIdle(host: submissionHost)
        XCTAssertEqual(
            presentationProbe.announcements,
            [announcement]
        )
        XCTAssertTrue(presentationProbe.acknowledgedEventIDs.isEmpty)
        try await scenario.assertPreserved()
    }

    func testRateLimitedSubmissionPresentsTryAgainOnceAndPreservesPhotoReviewForExplicitRetry() async throws {
        let scenario = try await RetainedSubmissionPhotoReviewScenario.standard(
            name: "snaplist-rate-limited-submission",
            photoData: [
                makeLandscapeImageData(
                    leftColor: .systemIndigo,
                    rightColor: .systemMint
                ),
                makeLandscapeImageData(
                    leftColor: .systemOrange,
                    rightColor: .systemBlue
                ),
            ]
        )
        defer { scenario.cleanUp() }
        let submittedPhotos = scenario.displayedPhotos
        let intake = SubmissionIntakeFixture(stagedPhotos: submittedPhotos)
        let rateLimitReason = "opaque-server-diagnostic"
        let submitter = RecordingItemRunSubmitter(
            outcomes: [
                .rateLimited(reason: rateLimitReason),
                .rateLimited(reason: rateLimitReason),
            ]
        )
        let attemptStore = LocalItemRunSubmissionAttemptStore(
            rootDirectory: scenario.attemptRoot
        )
        let persistedKey = UUID(
            uuidString: "50300000-0000-4000-8000-000000000061"
        )!
        let unusedFreshKey = UUID(
            uuidString: "50300000-0000-4000-8000-000000000062"
        )!
        let keySequence = KeySequence(
            keys: [persistedKey, unusedFreshKey]
        )
        let submissionHost = ItemRunSubmissionHost(
            coordinator: ItemRunSubmissionCoordinator(
                submitter: submitter,
                attemptStore: attemptStore,
                draftStore: scenario.draftStore,
                tokenProvider: CaptureFlowBearerTokenProvider(),
                readData: intake.read,
                newIdempotencyKey: { keySequence.next() }
            )
        )
        await scenario.perform(submissionHost: submissionHost)

        XCTAssertEqual(
            submissionHost.retention,
            .rateLimited(reason: rateLimitReason)
        )
        XCTAssertNil(submissionHost.acceptedRun)
        XCTAssertFalse(submissionHost.clearedIntake)
        XCTAssertFalse(submissionHost.isSubmitting)
        XCTAssertFalse(scenario.photoReviewHost.isCommitting)
        var presentationProbe = RetainedSubmissionPresentationProbe()
        let firstEvent = try presentationProbe.assertNewEvent(
            host: submissionHost,
            retention: .rateLimited(reason: rateLimitReason),
            family: .tryAgain
        )
        let firstEventID = firstEvent.eventID

        var payloads = await submitter.payloads
        XCTAssertEqual(payloads.count, 1)
        let firstPayload = try XCTUnwrap(payloads.first)
        let persistedAttemptAfterFirst =
            try await attemptStore.loadAttempt()
        let firstAttempt = try XCTUnwrap(
            persistedAttemptAfterFirst
        )
        XCTAssertEqual(firstAttempt.idempotencyKey, persistedKey)
        XCTAssertEqual(firstPayload.attempt, firstAttempt)
        XCTAssertEqual(firstPayload.photoData, intake.expectedBytes)

        try await scenario.assertPreserved()

        // Nothing after the retained response schedules payload two. Only the seller's
        // explicit second Start listing transaction below is the retry.
        let payloadsBeforeExplicitRetry = await submitter.payloads
        XCTAssertEqual(payloadsBeforeExplicitRetry.count, 1)

        await scenario.perform(submissionHost: submissionHost)

        let secondEvent = try presentationProbe.assertNewEvent(
            host: submissionHost,
            retention: .rateLimited(reason: rateLimitReason),
            family: .tryAgain
        )
        let secondEventID = secondEvent.eventID
        XCTAssertNotEqual(secondEventID, firstEventID)
        XCTAssertEqual(
            presentationProbe.announcements,
            [
                "This didn't go through. Your item is still saved on this phone.",
                "This didn't go through. Your item is still saved on this phone.",
            ]
        )
        XCTAssertTrue(presentationProbe.acknowledgedEventIDs.isEmpty)

        payloads = await submitter.payloads
        XCTAssertEqual(payloads.count, 2)
        XCTAssertEqual(
            payloads.map(\.attempt.idempotencyKey),
            [persistedKey, persistedKey]
        )
        XCTAssertEqual(payloads[0].attempt.photos, payloads[1].attempt.photos)
        XCTAssertEqual(payloads[0].photoData, payloads[1].photoData)
        XCTAssertEqual(payloads[1].photoData, intake.expectedBytes)
        let persistedAttemptAfterRetry =
            try await attemptStore.loadAttempt()
        XCTAssertEqual(persistedAttemptAfterRetry, firstAttempt)

        try await scenario.assertPreserved()
    }

    func testSubmissionUnavailablePersistsIdentityBeforeTryAgainAndNeverStartsTransport() async throws {
        let scenario = try await RetainedSubmissionPhotoReviewScenario.standard(
            name: "snaplist-submission-unavailable",
            photoData: [
                makeLandscapeImageData(
                    leftColor: .systemPurple,
                    rightColor: .systemYellow
                ),
                makeLandscapeImageData(
                    leftColor: .systemTeal,
                    rightColor: .systemPink
                ),
            ]
        )
        defer { scenario.cleanUp() }
        let submittedPhotos = scenario.displayedPhotos
        let intake = SubmissionIntakeFixture(stagedPhotos: submittedPhotos)
        let attemptStore = SubmissionUnavailableRecordingAttemptStore(
            base: LocalItemRunSubmissionAttemptStore(
                rootDirectory: scenario.attemptRoot
            )
        )
        let tokenProvider = SubmissionUnavailableBearerTokenProvider()
        let persistedKey = UUID(
            uuidString: "50300000-0000-4000-8000-000000000063"
        )!
        let unusedFreshKey = UUID(
            uuidString: "50300000-0000-4000-8000-000000000064"
        )!
        let keySequence = KeySequence(
            keys: [persistedKey, unusedFreshKey]
        )
        let submissionHost = ItemRunSubmissionHost(
            coordinator: ItemRunSubmissionCoordinator(
                submitter: nil,
                attemptStore: attemptStore,
                draftStore: scenario.draftStore,
                tokenProvider: tokenProvider,
                readData: intake.read,
                newIdempotencyKey: { keySequence.next() }
            )
        )
        await scenario.perform(submissionHost: submissionHost)

        XCTAssertEqual(
            submissionHost.retention,
            .submissionUnavailable
        )
        XCTAssertNil(submissionHost.acceptedRun)
        XCTAssertFalse(submissionHost.clearedIntake)
        XCTAssertFalse(submissionHost.isSubmitting)
        XCTAssertFalse(scenario.photoReviewHost.isCommitting)
        var presentationProbe = RetainedSubmissionPresentationProbe()
        let firstEvent = try presentationProbe.assertNewEvent(
            host: submissionHost,
            retention: .submissionUnavailable,
            family: .tryAgain
        )
        let firstEventID = firstEvent.eventID

        let persistedAttemptAfterFirst =
            try await attemptStore.loadAttempt()
        let firstAttempt = try XCTUnwrap(
            persistedAttemptAfterFirst
        )
        let firstSaveCount = await attemptStore.saveCount
        let firstClearCount = await attemptStore.clearCount
        let firstTokenCallCount = await tokenProvider.callCount
        XCTAssertEqual(firstSaveCount, 1)
        XCTAssertEqual(firstClearCount, 0)
        XCTAssertEqual(firstTokenCallCount, 1)
        XCTAssertEqual(firstAttempt.idempotencyKey, persistedKey)
        XCTAssertEqual(firstAttempt.photos.map(\.ordinal), [0, 1])
        XCTAssertEqual(
            firstAttempt.photos.map(\.photoID),
            submittedPhotos.map(\.id)
        )
        XCTAssertEqual(
            firstAttempt.photos.map(\.contentSha256),
            intake.expectedDigests
        )
        XCTAssertEqual(
            firstAttempt.photos.map(\.byteLength),
            intake.expectedByteLengths
        )
        XCTAssertEqual(
            firstAttempt.photos.map(\.mediaType),
            [.jpeg, .jpeg]
        )
        let exactDurableBytesBeforeExplicitRetry = try submittedPhotos.map {
            try Data(contentsOf: $0.photoURL)
        }
        XCTAssertEqual(
            exactDurableBytesBeforeExplicitRetry,
            intake.expectedBytes
        )

        try await scenario.assertPreserved()

        // The first unavailable response stays put. It neither creates another event
        // nor touches the persisted identity until the seller explicitly tries again.
        if case .submissionRejected(
            eventID: let stillPendingEventID,
            retention: let stillPendingRetention
        )? = submissionHost.pendingPresentationEvent {
            XCTAssertEqual(stillPendingEventID, firstEventID)
            XCTAssertEqual(
                stillPendingRetention,
                .submissionUnavailable
            )
        } else {
            XCTFail("The unavailable event changed without a seller action.")
        }
        let saveCountBeforeExplicitRetry = await attemptStore.saveCount
        let tokenCallCountBeforeExplicitRetry =
            await tokenProvider.callCount
        XCTAssertEqual(saveCountBeforeExplicitRetry, 1)
        XCTAssertEqual(tokenCallCountBeforeExplicitRetry, 1)

        await scenario.perform(submissionHost: submissionHost)

        let secondEvent = try presentationProbe.assertNewEvent(
            host: submissionHost,
            retention: .submissionUnavailable,
            family: .tryAgain
        )
        let secondEventID = secondEvent.eventID
        XCTAssertNotEqual(secondEventID, firstEventID)
        XCTAssertEqual(
            presentationProbe.announcements,
            [
                "This didn't go through. Your item is still saved on this phone.",
                "This didn't go through. Your item is still saved on this phone.",
            ]
        )
        XCTAssertTrue(presentationProbe.acknowledgedEventIDs.isEmpty)

        let persistedAttemptAfterSecond =
            try await attemptStore.loadAttempt()
        let finalSaveCount = await attemptStore.saveCount
        let finalClearCount = await attemptStore.clearCount
        let finalTokenCallCount = await tokenProvider.callCount
        XCTAssertEqual(persistedAttemptAfterSecond, firstAttempt)
        XCTAssertEqual(finalSaveCount, 1)
        XCTAssertEqual(finalClearCount, 0)
        XCTAssertEqual(finalTokenCallCount, 2)

        try await scenario.assertPreserved()
    }

    func testAttemptPersistenceFailurePresentsTryAgainAndOnlyExplicitRetryCanSendPersistedIdentity() async throws {
        let scenario = try await RetainedSubmissionPhotoReviewScenario.standard(
            name: "snaplist-attempt-persistence-recovery",
            photoData: [
                makeLandscapeImageData(
                    leftColor: .systemGreen,
                    rightColor: .systemPurple
                ),
                makeLandscapeImageData(
                    leftColor: .systemYellow,
                    rightColor: .systemCyan
                ),
            ]
        )
        defer { scenario.cleanUp() }
        let submittedPhotos = scenario.displayedPhotos
        let intake = SubmissionIntakeFixture(stagedPhotos: submittedPhotos)
        let events = AttemptPersistenceRecoveryEventRecorder()
        let attemptStore = RecoveringItemRunSubmissionAttemptStore(
            base: LocalItemRunSubmissionAttemptStore(
                rootDirectory: scenario.attemptRoot
            ),
            events: events
        )
        let tokenProvider = AttemptPersistenceRecordingTokenProvider(
            attemptStore: attemptStore,
            events: events
        )
        let rateLimitReason = "opaque-second-action-diagnostic"
        let submitter = AttemptPersistenceRecordingSubmitter(
            outcome: .rateLimited(reason: rateLimitReason),
            events: events
        )
        let failedKey = UUID(
            uuidString: "50300000-0000-4000-8000-000000000065"
        )!
        let persistedKey = UUID(
            uuidString: "50300000-0000-4000-8000-000000000066"
        )!
        let unusedFreshKey = UUID(
            uuidString: "50300000-0000-4000-8000-000000000067"
        )!
        let keySequence = KeySequence(
            keys: [failedKey, persistedKey, unusedFreshKey]
        )
        let submissionHost = ItemRunSubmissionHost(
            coordinator: ItemRunSubmissionCoordinator(
                submitter: submitter,
                attemptStore: attemptStore,
                draftStore: scenario.draftStore,
                tokenProvider: tokenProvider,
                readData: intake.read,
                newIdempotencyKey: { keySequence.next() }
            )
        )
        await scenario.perform(submissionHost: submissionHost)

        XCTAssertEqual(
            submissionHost.retention,
            .attemptNotPersisted
        )
        XCTAssertNil(submissionHost.acceptedRun)
        XCTAssertFalse(submissionHost.clearedIntake)
        XCTAssertFalse(submissionHost.isSubmitting)
        XCTAssertFalse(scenario.photoReviewHost.isCommitting)
        var presentationProbe = RetainedSubmissionPresentationProbe()
        let firstEvent = try presentationProbe.assertNewEvent(
            host: submissionHost,
            retention: .attemptNotPersisted,
            family: .tryAgain
        )
        let firstEventID = firstEvent.eventID

        let attemptAfterFailedSave = try await attemptStore.loadAttempt()
        let firstSaveAttempts = await attemptStore.saveAttempts
        let firstSuccessfulSaveCount =
            await attemptStore.successfulSaveCount
        let firstClearCount = await attemptStore.clearCount
        let firstTokenCallCount = await tokenProvider.callCount
        let firstPayloads = await submitter.payloads
        XCTAssertNil(attemptAfterFailedSave)
        XCTAssertEqual(
            firstSaveAttempts.map(\.idempotencyKey),
            [failedKey]
        )
        XCTAssertEqual(firstSuccessfulSaveCount, 0)
        XCTAssertEqual(firstClearCount, 0)
        XCTAssertEqual(firstTokenCallCount, 1)
        XCTAssertTrue(firstPayloads.isEmpty)
        XCTAssertEqual(
            events.events,
            [
                .tokenRequested(nil),
                .attemptSaveFailed(failedKey),
            ]
        )
        try await scenario.assertPreserved()

        // A retained presentation is not a retry scheduler. The failed key was never
        // durable, and no second identity, token, or payload exists before the seller
        // explicitly chooses Try again below.
        if case .submissionRejected(
            eventID: let stillPendingEventID,
            retention: let stillPendingRetention
        )? = submissionHost.pendingPresentationEvent {
            XCTAssertEqual(stillPendingEventID, firstEventID)
            XCTAssertEqual(
                stillPendingRetention,
                .attemptNotPersisted
            )
        } else {
            XCTFail(
                "The persistence-failure event changed without a seller action."
            )
        }
        let saveAttemptsBeforeExplicitRetry =
            await attemptStore.saveAttempts
        let tokenCallsBeforeExplicitRetry = await tokenProvider.callCount
        let payloadsBeforeExplicitRetry = await submitter.payloads
        XCTAssertEqual(saveAttemptsBeforeExplicitRetry.count, 1)
        XCTAssertEqual(tokenCallsBeforeExplicitRetry, 1)
        XCTAssertTrue(payloadsBeforeExplicitRetry.isEmpty)

        await attemptStore.recover()
        await scenario.perform(submissionHost: submissionHost)

        let secondEvent = try presentationProbe.assertNewEvent(
            host: submissionHost,
            retention: .rateLimited(reason: rateLimitReason),
            family: .tryAgain
        )
        let secondEventID = secondEvent.eventID
        XCTAssertNotEqual(secondEventID, firstEventID)
        XCTAssertEqual(
            presentationProbe.announcements,
            [
                "This didn't go through. Your item is still saved on this phone.",
                "This didn't go through. Your item is still saved on this phone.",
            ]
        )
        XCTAssertTrue(presentationProbe.acknowledgedEventIDs.isEmpty)

        let loadedPersistedAttempt = try await attemptStore.loadAttempt()
        let persistedAttempt = try XCTUnwrap(loadedPersistedAttempt)
        let finalSaveAttempts = await attemptStore.saveAttempts
        let finalSuccessfulSaveCount =
            await attemptStore.successfulSaveCount
        let finalClearCount = await attemptStore.clearCount
        let finalTokenCallCount = await tokenProvider.callCount
        let finalPayloads = await submitter.payloads
        let finalBearerTokens = await submitter.bearerTokens
        XCTAssertEqual(
            finalSaveAttempts.map(\.idempotencyKey),
            [failedKey, persistedKey]
        )
        XCTAssertEqual(finalSuccessfulSaveCount, 1)
        XCTAssertEqual(finalClearCount, 0)
        XCTAssertEqual(finalTokenCallCount, 2)
        XCTAssertEqual(persistedAttempt.idempotencyKey, persistedKey)
        XCTAssertEqual(persistedAttempt.photos.map(\.ordinal), [0, 1])
        XCTAssertEqual(
            persistedAttempt.photos.map(\.photoID),
            submittedPhotos.map(\.id)
        )
        XCTAssertEqual(
            persistedAttempt.photos.map(\.contentSha256),
            intake.expectedDigests
        )
        XCTAssertEqual(
            persistedAttempt.photos.map(\.byteLength),
            intake.expectedByteLengths
        )
        XCTAssertEqual(
            persistedAttempt.photos.map(\.mediaType),
            [.jpeg, .jpeg]
        )
        XCTAssertEqual(finalPayloads.count, 1)
        let explicitRetryPayload = try XCTUnwrap(finalPayloads.first)
        XCTAssertEqual(explicitRetryPayload.attempt, persistedAttempt)
        XCTAssertEqual(explicitRetryPayload.photoData, intake.expectedBytes)
        XCTAssertEqual(finalBearerTokens, ["clerk-session-token"])
        XCTAssertEqual(
            events.events,
            [
                .tokenRequested(nil),
                .attemptSaveFailed(failedKey),
                .tokenRequested(nil),
                .attemptPersisted(persistedKey),
                .transportStarted(persistedKey),
            ]
        )
        try await scenario.assertPreserved()
    }

    func testRejectedSubmissionPresentsReviewAndReviewDoesNotResubmitUnchangedIntake() async throws {
        let scenario = try await RetainedSubmissionPhotoReviewScenario.standard(
            name: "snaplist-rejected-submission-review",
            photoData: [
                makeLandscapeImageData(
                    leftColor: .systemBrown,
                    rightColor: .systemTeal
                ),
                makeLandscapeImageData(
                    leftColor: .systemPink,
                    rightColor: .systemIndigo
                ),
            ]
        )
        defer { scenario.cleanUp() }
        let submittedPhotos = scenario.displayedPhotos
        let intake = SubmissionIntakeFixture(stagedPhotos: submittedPhotos)
        let submitter = RecordingItemRunSubmitter(
            outcomes: [.rejected]
        )
        let attemptStore = LocalItemRunSubmissionAttemptStore(
            rootDirectory: scenario.attemptRoot
        )
        let persistedKey = UUID(
            uuidString: "50300000-0000-4000-8000-000000000068"
        )!
        let unusedFreshKey = UUID(
            uuidString: "50300000-0000-4000-8000-000000000069"
        )!
        let keySequence = KeySequence(
            keys: [persistedKey, unusedFreshKey]
        )
        let submissionHost = ItemRunSubmissionHost(
            coordinator: ItemRunSubmissionCoordinator(
                submitter: submitter,
                attemptStore: attemptStore,
                draftStore: scenario.draftStore,
                tokenProvider: CaptureFlowBearerTokenProvider(),
                readData: intake.read,
                newIdempotencyKey: { keySequence.next() }
            )
        )
        await scenario.perform(submissionHost: submissionHost)

        XCTAssertEqual(submissionHost.retention, .rejected)
        XCTAssertNil(submissionHost.acceptedRun)
        XCTAssertFalse(submissionHost.clearedIntake)
        XCTAssertFalse(submissionHost.isSubmitting)
        XCTAssertFalse(scenario.photoReviewHost.isCommitting)
        var presentationProbe = RetainedSubmissionPresentationProbe()
        let rejection = try presentationProbe.assertNewEvent(
            host: submissionHost,
            retention: .rejected,
            family: .review
        )
        let rejectionEventID = rejection.eventID
        let rejectionPresentation = rejection.presentation
        XCTAssertNotEqual(rejectionPresentation.primaryActionLabel, "Try again")
        XCTAssertNotEqual(
            rejectionPresentation.visibleMessage,
            "This didn't go through. Your item is still saved on this phone."
        )
        XCTAssertEqual(
            presentationProbe.announcements,
            ["This item can't be sent as it is."]
        )
        XCTAssertTrue(presentationProbe.acknowledgedEventIDs.isEmpty)

        let payloadsAfterRejection = await submitter.payloads
        XCTAssertEqual(payloadsAfterRejection.count, 1)
        let rejectedPayload = try XCTUnwrap(payloadsAfterRejection.first)
        let persistedAttemptAfterRejection =
            try await attemptStore.loadAttempt()
        let persistedAttempt = try XCTUnwrap(
            persistedAttemptAfterRejection
        )
        XCTAssertEqual(persistedAttempt.idempotencyKey, persistedKey)
        XCTAssertEqual(rejectedPayload.attempt, persistedAttempt)
        XCTAssertEqual(rejectedPayload.photoData, intake.expectedBytes)
        XCTAssertEqual(persistedAttempt.photos.map(\.ordinal), [0, 1])
        XCTAssertEqual(
            persistedAttempt.photos.map(\.photoID),
            submittedPhotos.map(\.id)
        )
        XCTAssertEqual(
            persistedAttempt.photos.map(\.contentSha256),
            intake.expectedDigests
        )
        XCTAssertEqual(
            persistedAttempt.photos.map(\.byteLength),
            intake.expectedByteLengths
        )
        XCTAssertEqual(
            persistedAttempt.photos.map(\.mediaType),
            [.jpeg, .jpeg]
        )
        try await scenario.assertPreserved()

        // Re-reading the rejected state is not a retry scheduler, and Review is a
        // distinct typed action rather than Start listing under a different label.
        if case .submissionRejected(
            eventID: let stillPendingEventID,
            retention: let stillPendingRetention
        )? = submissionHost.pendingPresentationEvent {
            XCTAssertEqual(stillPendingEventID, rejectionEventID)
            XCTAssertEqual(stillPendingRetention, .rejected)
        } else {
            XCTFail("The rejected event changed without a seller action.")
        }
        let payloadsBeforeReview = await submitter.payloads
        XCTAssertEqual(payloadsBeforeReview.count, 1)

        var staleUUID = rejectionEventID.uuid
        staleUUID.0 ^= 1
        XCTAssertFalse(
            PhotoReviewSubmissionPrimaryActionConsumer.consume(
                .reviewSubmission(eventID: UUID(uuid: staleUUID)),
                submissionHost: submissionHost
            )
        )
        XCTAssertEqual(
            submissionHost.pendingPresentationEvent,
            .submissionRejected(
                eventID: rejectionEventID,
                retention: .rejected
            )
        )
        let payloadsAfterStaleReview = await submitter.payloads
        XCTAssertEqual(payloadsAfterStaleReview.count, 1)

        XCTAssertTrue(
            PhotoReviewSubmissionPrimaryActionConsumer.consume(
                rejectionPresentation.primaryActionEvent,
                submissionHost: submissionHost
            )
        )
        XCTAssertFalse(
            PhotoReviewSubmissionPrimaryActionConsumer.consume(
                rejectionPresentation.primaryActionEvent,
                submissionHost: submissionHost
            )
        )

        let payloadsAfterReview = await submitter.payloads
        let attemptAfterReview = try await attemptStore.loadAttempt()
        XCTAssertEqual(payloadsAfterReview.count, 1)
        XCTAssertEqual(attemptAfterReview, persistedAttempt)
        XCTAssertEqual(submissionHost.retention, .rejected)
        XCTAssertNil(submissionHost.pendingPresentationEvent)
        let returnedPresentation = PhotoReviewSubmissionPresentation(
            host: submissionHost
        )
        XCTAssertEqual(returnedPresentation.primaryActionLabel, "Start listing")
        XCTAssertNil(returnedPresentation.visibleMessage)
        XCTAssertEqual(
            returnedPresentation.primaryActionEvent,
            .startListing
        )
        presentationProbe.consumeIdle(host: submissionHost)
        XCTAssertEqual(
            presentationProbe.announcements,
            ["This item can't be sent as it is."]
        )
        XCTAssertTrue(presentationProbe.acknowledgedEventIDs.isEmpty)
        try await scenario.assertPreserved()
    }

    func testIntakeUnavailableSubmissionPresentsReviewWithoutStartingTransport() async throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory.appendingPathComponent(
            "snaplist-intake-unavailable-review-\(UUID().uuidString)",
            isDirectory: true
        )
        let draftRoot = root.appendingPathComponent(
            "draft",
            isDirectory: true
        )
        let extraPhotoRoot = root.appendingPathComponent(
            "extra-photo",
            isDirectory: true
        )
        defer { try? fileManager.removeItem(at: root) }

        let durableBase = LocalCaptureDraftStore(rootDirectory: draftRoot)
        let durablePhoto = try await durableBase.append(
            imageData: makeLandscapeImageData(
                leftColor: .systemOrange,
                rightColor: .systemBlue
            ),
            libraryTransferReceipt: nil
        ).appendedPhoto
        let extraPhotoStore = LocalCaptureDraftStore(
            rootDirectory: extraPhotoRoot
        )
        let displayedOnlyPhoto = try await extraPhotoStore.append(
            imageData: makeLandscapeImageData(
                leftColor: .systemGreen,
                rightColor: .systemPurple
            ),
            libraryTransferReceipt: nil
        ).appendedPhoto
        let displayedPhotos = [durablePhoto, displayedOnlyPhoto]
        let draftStore = IntakeUnavailableRecordingDraftStore(
            base: durableBase
        )
        let scenario = try await RetainedSubmissionPhotoReviewScenario(
            fileManager: fileManager,
            root: root,
            draftStore: draftStore,
            displayedPhotos: displayedPhotos,
            expectedDurablePhotos: [durablePhoto]
        )

        let intake = SubmissionIntakeFixture(
            stagedPhotos: displayedPhotos
        )
        let submitter = RecordingItemRunSubmitter(
            outcomes: [.rejected]
        )
        let attemptStore = SubmissionUnavailableRecordingAttemptStore(
            base: LocalItemRunSubmissionAttemptStore(
                rootDirectory: scenario.attemptRoot
            )
        )
        let tokenProvider = SubmissionUnavailableBearerTokenProvider()
        let submissionHost = ItemRunSubmissionHost(
            coordinator: ItemRunSubmissionCoordinator(
                submitter: submitter,
                attemptStore: attemptStore,
                draftStore: scenario.draftStore,
                tokenProvider: tokenProvider,
                readData: intake.read,
                newIdempotencyKey: {
                    UUID(
                        uuidString:
                            "50300000-0000-4000-8000-000000000070"
                    )!
                }
            )
        )
        await scenario.perform(submissionHost: submissionHost)

        XCTAssertEqual(submissionHost.retention, .intakeUnavailable)
        XCTAssertNil(submissionHost.acceptedRun)
        XCTAssertFalse(submissionHost.clearedIntake)
        XCTAssertFalse(submissionHost.isSubmitting)
        XCTAssertFalse(scenario.photoReviewHost.isCommitting)
        let replaceCount = await draftStore.replacePhotosCount
        let discardCount = await draftStore.discardCount
        let discardExactlyCount = await draftStore.discardExactlyCount
        let storedAttempt = try await attemptStore.loadAttempt()
        let attemptSaveCount = await attemptStore.saveCount
        let attemptClearCount = await attemptStore.clearCount
        let tokenCallCount = await tokenProvider.callCount
        let payloadsAfterRefusal = await submitter.payloads
        XCTAssertEqual(replaceCount, 1)
        XCTAssertEqual(discardCount, 0)
        XCTAssertEqual(discardExactlyCount, 0)
        XCTAssertNil(storedAttempt)
        XCTAssertEqual(attemptSaveCount, 0)
        XCTAssertEqual(attemptClearCount, 0)
        XCTAssertEqual(tokenCallCount, 1)
        XCTAssertTrue(payloadsAfterRefusal.isEmpty)
        try await scenario.assertPreserved()

        var presentationProbe = RetainedSubmissionPresentationProbe()
        let rejection = try presentationProbe.assertNewEvent(
            host: submissionHost,
            retention: .intakeUnavailable,
            family: .review
        )
        let rejectionEventID = rejection.eventID
        let rejectionPresentation = rejection.presentation
        XCTAssertNotEqual(
            rejectionPresentation.primaryActionLabel,
            "Try again"
        )
        XCTAssertNotEqual(
            rejectionPresentation.visibleMessage,
            "This didn't go through. Your item is still saved on this phone."
        )
        XCTAssertEqual(
            presentationProbe.announcements,
            ["This item can't be sent as it is."]
        )
        XCTAssertTrue(presentationProbe.acknowledgedEventIDs.isEmpty)

        if case .submissionRejected(
            eventID: let stillPendingEventID,
            retention: let stillPendingRetention
        )? = submissionHost.pendingPresentationEvent {
            XCTAssertEqual(stillPendingEventID, rejectionEventID)
            XCTAssertEqual(stillPendingRetention, .intakeUnavailable)
        } else {
            XCTFail("The intake-unavailable event changed without an action.")
        }
        let payloadsBeforeReview = await submitter.payloads
        XCTAssertTrue(payloadsBeforeReview.isEmpty)

        var staleUUID = rejectionEventID.uuid
        staleUUID.0 ^= 1
        XCTAssertFalse(
            PhotoReviewSubmissionPrimaryActionConsumer.consume(
                .reviewSubmission(eventID: UUID(uuid: staleUUID)),
                submissionHost: submissionHost
            )
        )
        XCTAssertEqual(
            submissionHost.pendingPresentationEvent,
            .submissionRejected(
                eventID: rejectionEventID,
                retention: .intakeUnavailable
            )
        )
        let payloadsAfterStaleReview = await submitter.payloads
        XCTAssertTrue(payloadsAfterStaleReview.isEmpty)

        XCTAssertTrue(
            PhotoReviewSubmissionPrimaryActionConsumer.consume(
                rejectionPresentation.primaryActionEvent,
                submissionHost: submissionHost
            )
        )
        XCTAssertFalse(
            PhotoReviewSubmissionPrimaryActionConsumer.consume(
                rejectionPresentation.primaryActionEvent,
                submissionHost: submissionHost
            )
        )

        let payloadsAfterReview = await submitter.payloads
        let attemptAfterReview = try await attemptStore.loadAttempt()
        let finalTokenCallCount = await tokenProvider.callCount
        let finalDiscardExactlyCount =
            await draftStore.discardExactlyCount
        XCTAssertTrue(payloadsAfterReview.isEmpty)
        XCTAssertNil(attemptAfterReview)
        XCTAssertEqual(finalTokenCallCount, 1)
        XCTAssertEqual(finalDiscardExactlyCount, 0)
        XCTAssertEqual(submissionHost.retention, .intakeUnavailable)
        XCTAssertNil(submissionHost.pendingPresentationEvent)
        let returnedPresentation = PhotoReviewSubmissionPresentation(
            host: submissionHost
        )
        XCTAssertEqual(returnedPresentation.primaryActionLabel, "Start listing")
        XCTAssertNil(returnedPresentation.visibleMessage)
        XCTAssertEqual(
            returnedPresentation.primaryActionEvent,
            .startListing
        )
        presentationProbe.consumeIdle(host: submissionHost)
        XCTAssertEqual(
            presentationProbe.announcements,
            ["This item can't be sent as it is."]
        )
        XCTAssertTrue(presentationProbe.acknowledgedEventIDs.isEmpty)
        try await scenario.assertPreserved()
    }

    func testAcceptedSubmissionClearsTheDraftAndLeavesPhotoReviewForScan() async throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory.appendingPathComponent(
            "snaplist-submission-exit-\(UUID().uuidString)",
            isDirectory: true
        )
        defer { try? fileManager.removeItem(at: root) }

        let store = LocalCaptureDraftStore(rootDirectory: root)
        let staged = try await store.append(
            imageData: makeLandscapeImageData(
                leftColor: .systemRed,
                rightColor: .systemOrange
            ),
            libraryTransferReceipt: nil
        ).appendedPhoto
        let captureFlow = CaptureFlowModel(
            camera: TestCaptureCamera(isAvailable: true, authorization: .authorized),
            evaluator: TestFramingEvaluator(observations: []),
            store: store
        )
        _ = await captureFlow.restore()

        let router = AppRouter(initialFullScreen: .guidedCamera)
        router.openCaptureBoundary(
            destination: .photoReview,
            photos: captureFlow.stagedPhotos,
            opener: .reviewButton
        )
        let host = PhotoReviewLiveHost()
        XCTAssertTrue(host.consume(router.captureBoundaryRequest))
        let session = try XCTUnwrap(host.session)

        var lockedDuringFlight = false
        let intake = SubmissionIntakeFixture(stagedPhotos: [staged])
        let submissionHost = ItemRunSubmissionHost(
            coordinator: ItemRunSubmissionCoordinator(
                submitter: RecordingItemRunSubmitter(
                    outcomes: [.created(intake.receipt)],
                    beforeResponse: { @MainActor in
                        lockedDuringFlight = host.isCommitting
                    }
                ),
                attemptStore: InMemoryItemRunSubmissionAttemptStore(),
                draftStore: store,
                tokenProvider: CaptureFlowBearerTokenProvider(),
                readData: intake.read,
                newIdempotencyKey: { UUID() }
            )
        )

        let savedStateObserved = expectation(
            description: "Accepted submission presents its saved state"
        )
        withObservationTracking {
            _ = submissionHost.pendingPresentationEvent
        } onChange: {
            savedStateObserved.fulfill()
        }

        var pendingScanFocus: PhotoReviewScanFocus?
        let transaction = Task {
            await AppShellPhotoReviewSubmissionTransaction.perform(
                session: session,
                captureFlow: captureFlow,
                host: host,
                router: router,
                submissionHost: submissionHost,
                setReturnFocus: { pendingScanFocus = $0 }
            )
        }
        defer { transaction.cancel() }

        await fulfillment(of: [savedStateObserved], timeout: 3)
        let savedPresentation = PhotoReviewSubmissionPresentation(
            host: submissionHost
        )
        var effectConsumer = PhotoReviewSubmissionEffectConsumer()
        var announcements: [String] = []
        effectConsumer.consume(
            savedPresentation,
            postAnnouncement: { announcements.append($0) },
            acknowledgePresentation: { eventID in
                submissionHost.acknowledgePresentation(eventID: eventID)
            }
        )
        await transaction.value

        // Photo Review stays mounted across the request, so the seller must not be able
        // to edit an intake the clear is about to remove.
        XCTAssertTrue(lockedDuringFlight)
        XCTAssertEqual(announcements, ["Item saved."])
        XCTAssertFalse(host.isCommitting)
        XCTAssertNotNil(submissionHost.acceptedRun)
        XCTAssertTrue(submissionHost.clearedIntake)
        // A cleared draft leaves nothing to review, so Photo Review must not stay up
        // rendering files that no longer exist.
        XCTAssertNil(host.session)
        let remaining = try await store.loadPhotos()
        XCTAssertTrue(remaining.isEmpty)
        XCTAssertTrue(captureFlow.stagedPhotos.isEmpty)
        XCTAssertFalse(fileManager.fileExists(atPath: staged.photoURL.path))
        XCTAssertEqual(pendingScanFocus, .addPhotoButton)
    }

    func testVerifiedProRestoreReplaysTheBlockedLiveSubmissionExactlyOnce() async throws {
        let scenario = try await RetainedSubmissionPhotoReviewScenario.standard(
            name: "snaplist-pro-gate-live-replay",
            photoData: [
                makeLandscapeImageData(
                    leftColor: .systemIndigo,
                    rightColor: .systemMint
                ),
            ]
        )
        defer { try? scenario.fileManager.removeItem(at: scenario.root) }

        let intake = SubmissionIntakeFixture(
            stagedPhotos: scenario.displayedPhotos
        )
        let acceptedReceipt = intake.receipt
        let intendedKey = UUID()
        let attemptStore = InMemoryItemRunSubmissionAttemptStore()
        let submitter = RecordingItemRunSubmitter(
            outcomes: [
                .creditDenied(reason: "snaplist-pro-required"),
                .created(acceptedReceipt),
            ],
            attemptStore: attemptStore
        )
        let submissionHost = ItemRunSubmissionHost(
            coordinator: ItemRunSubmissionCoordinator(
                submitter: submitter,
                attemptStore: attemptStore,
                draftStore: scenario.draftStore,
                tokenProvider: CaptureFlowBearerTokenProvider(),
                readData: intake.read,
                newIdempotencyKey: { intendedKey }
            )
        )

        await scenario.perform(submissionHost: submissionHost)

        guard case .destinationHandoff(
            eventID: let eventID,
            handoff: .pay01
        )? = submissionHost.pendingPresentationEvent else {
            return XCTFail("Expected the canonical readable Pro denial.")
        }

        let product = SubscriptionProductMetadata(
            id: "fixture-monthly",
            localizedTitle: "SnapList Pro",
            localizedDescription: "Fixture metadata",
            localizedPrice: "$9.99",
            billingPeriod: .init(value: 1, unit: .month)
        )
        let entitlementAPI = ProGateReplayMobileAPIStub()
        let proGateStore = ProGateStore(
            mobileAPIClient: entitlementAPI,
            subscriptionClient: FixtureSubscriptionClient(products: [product]),
            verificationAttempts: 1,
            sleep: { _ in }
        )

        await AppShellProGateTransaction.present(
            eventID: eventID,
            store: proGateStore,
            submissionHost: submissionHost
        )
        XCTAssertEqual(
            proGateStore.state,
            .offer(product: product, advisory: nil, isRestoring: false)
        )
        XCTAssertNil(submissionHost.pendingPresentationEvent)

        _ = await proGateStore.restore()
        XCTAssertEqual(
            proGateStore.state,
            .ready(source: .restoredPurchase)
        )

        let savedStateObserved = expectation(
            description: "Verified replay reaches one accepted run"
        )
        withObservationTracking {
            _ = submissionHost.pendingPresentationEvent
        } onChange: {
            savedStateObserved.fulfill()
        }
        let replay = Task {
            await AppShellProGateTransaction.resume(store: proGateStore) {
                await scenario.perform(submissionHost: submissionHost)
            }
        }
        defer { replay.cancel() }

        await fulfillment(of: [savedStateObserved], timeout: 3)
        guard case .itemSaved(let savedEventID, _)? =
            submissionHost.pendingPresentationEvent else {
            return XCTFail("Expected one accepted replay.")
        }
        submissionHost.acknowledgePresentation(eventID: savedEventID)
        await replay.value

        await AppShellProGateTransaction.resume(store: proGateStore) {
            await scenario.perform(submissionHost: submissionHost)
        }

        let payloads = await submitter.payloads
        XCTAssertEqual(payloads.count, 2)
        XCTAssertEqual(
            payloads.map(\.attempt.idempotencyKey),
            [intendedKey, intendedKey]
        )
        let attemptSaveCount = await attemptStore.saveCount
        XCTAssertEqual(attemptSaveCount, 1)
        XCTAssertEqual(submissionHost.acceptedRun?.runID, acceptedReceipt.runId)
        XCTAssertTrue(submissionHost.clearedIntake)
    }

    func testProGatePreparationIgnoresASecondLiveStartListing() async throws {
        let scenario = try await RetainedSubmissionPhotoReviewScenario.standard(
            name: "snaplist-pro-gate-overlapping-denial",
            photoData: [
                makeLandscapeImageData(
                    leftColor: .systemPurple,
                    rightColor: .systemOrange
                ),
            ]
        )
        defer { try? scenario.fileManager.removeItem(at: scenario.root) }

        let intake = SubmissionIntakeFixture(
            stagedPhotos: scenario.displayedPhotos
        )
        let attemptStore = InMemoryItemRunSubmissionAttemptStore()
        let submitter = RecordingItemRunSubmitter(
            outcomes: [
                .creditDenied(reason: "snaplist-pro-required"),
                .creditDenied(reason: "snaplist-pro-required"),
            ],
            attemptStore: attemptStore
        )
        let submissionHost = ItemRunSubmissionHost(
            coordinator: ItemRunSubmissionCoordinator(
                submitter: submitter,
                attemptStore: attemptStore,
                draftStore: scenario.draftStore,
                tokenProvider: CaptureFlowBearerTokenProvider(),
                readData: intake.read,
                newIdempotencyKey: { UUID() }
            )
        )
        await scenario.perform(submissionHost: submissionHost)
        guard case .destinationHandoff(
            eventID: let eventID,
            handoff: .pay01
        )? = submissionHost.pendingPresentationEvent else {
            return XCTFail("Expected the first readable Pro denial.")
        }

        let product = SubscriptionProductMetadata(
            id: "fixture-monthly",
            localizedTitle: "SnapList Pro",
            localizedDescription: "Fixture metadata",
            localizedPrice: "$9.99",
            billingPeriod: .init(value: 1, unit: .month)
        )
        let entitlementAPI = SuspendedProGateMobileAPIStub()
        let proGateStore = ProGateStore(
            mobileAPIClient: entitlementAPI,
            subscriptionClient: FixtureSubscriptionClient(products: [product]),
            verificationAttempts: 1,
            sleep: { _ in }
        )
        let preparation = Task {
            await AppShellProGateTransaction.present(
                eventID: eventID,
                store: proGateStore,
                submissionHost: submissionHost
            )
        }
        defer { preparation.cancel() }
        await entitlementAPI.waitUntilEntitlementStarts()

        await scenario.perform(submissionHost: submissionHost)

        let payloadsDuringPreparation = await submitter.payloads
        XCTAssertEqual(payloadsDuringPreparation.count, 1)
        XCTAssertEqual(
            submissionHost.pendingPresentationEvent,
            .destinationHandoff(eventID: eventID, handoff: .pay01)
        )

        await entitlementAPI.finishEntitlement()
        await preparation.value

        XCTAssertEqual(
            proGateStore.state,
            .offer(product: product, advisory: nil, isRestoring: false)
        )
        XCTAssertNil(submissionHost.pendingPresentationEvent)
    }

    /// The lock, not the submitter: this proves the transaction returns early when a
    /// commit is already held and does not release a lock it never took. The genuine
    /// double-submit case is `ItemRunSubmissionTests.testStartListingTappedTwiceSubmitsOnce`.
    func testStartListingKeepsTheHeldLockAndDoesNothingWhileACommitIsOpen() async throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory.appendingPathComponent(
            "snaplist-submission-lock-\(UUID().uuidString)",
            isDirectory: true
        )
        defer { try? fileManager.removeItem(at: root) }

        let store = LocalCaptureDraftStore(rootDirectory: root)
        _ = try await store.append(
            imageData: makeLandscapeImageData(
                leftColor: .systemGreen,
                rightColor: .systemBlue
            ),
            libraryTransferReceipt: nil
        ).appendedPhoto
        let captureFlow = CaptureFlowModel(
            camera: TestCaptureCamera(isAvailable: true, authorization: .authorized),
            evaluator: TestFramingEvaluator(observations: []),
            store: store
        )
        _ = await captureFlow.restore()

        let router = AppRouter(initialFullScreen: .guidedCamera)
        router.openCaptureBoundary(
            destination: .photoReview,
            photos: captureFlow.stagedPhotos,
            opener: .reviewButton
        )
        let host = PhotoReviewLiveHost()
        XCTAssertTrue(host.consume(router.captureBoundaryRequest))
        let session = try XCTUnwrap(host.session)
        let submissionHost = ItemRunSubmissionHost(coordinator: nil, isInert: true)
        XCTAssertTrue(host.beginCommit())

        await AppShellPhotoReviewSubmissionTransaction.perform(
            session: session,
            captureFlow: captureFlow,
            host: host,
            router: router,
            submissionHost: submissionHost,
            setReturnFocus: { _ in }
        )

        // The lock was already held, so this tap does nothing and must not release it.
        XCTAssertTrue(host.isCommitting)
        XCTAssertNotNil(host.session)
    }

    func testLivePhotoReviewBackCommitsTheReorderedSetThroughTheProductionExit() async throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory.appendingPathComponent(
            "snaplist-photo-review-back-\(UUID().uuidString)",
            isDirectory: true
        )
        defer { try? fileManager.removeItem(at: root) }

        let store = LocalCaptureDraftStore(rootDirectory: root)
        let originalCover = try await store.append(
            imageData: makeLandscapeImageData(
                leftColor: .systemRed,
                rightColor: .systemOrange
            ),
            libraryTransferReceipt: nil
        ).appendedPhoto
        let second = try await store.append(
            imageData: makeLandscapeImageData(
                leftColor: .systemGreen,
                rightColor: .systemBlue
            ),
            libraryTransferReceipt: nil
        ).appendedPhoto
        let third = try await store.append(
            imageData: makeLandscapeImageData(
                leftColor: .systemPurple,
                rightColor: .systemYellow
            ),
            libraryTransferReceipt: nil
        ).appendedPhoto

        let captureFlow = CaptureFlowModel(
            camera: TestCaptureCamera(
                isAvailable: true,
                authorization: .authorized
            ),
            evaluator: TestFramingEvaluator(observations: []),
            store: store
        )
        let restoration = await captureFlow.restore()
        XCTAssertEqual(restoration, .stagedPhoto)
        XCTAssertEqual(captureFlow.stagedPhotos, [originalCover, second, third])

        let router = AppRouter(initialFullScreen: .guidedCamera)
        router.openCaptureBoundary(
            destination: .photoReview,
            photos: captureFlow.stagedPhotos,
            opener: .reviewButton
        )
        let host = PhotoReviewLiveHost()
        XCTAssertTrue(host.consume(router.captureBoundaryRequest))
        guard let session = host.session else {
            XCTFail("A live Photo Review request must create one editing session.")
            return
        }

        XCTAssertEqual(session.store.photos, [originalCover, second, third])
        XCTAssertEqual(session.store.selectedPhotoID, originalCover.id)
        XCTAssertTrue(session.store.movePhoto(id: third.id, to: 0))

        var returnFocus: [PhotoReviewScanFocus] = []
        let outcome = await AppShellPhotoReviewBackTransaction.perform(
            session: session,
            captureFlow: captureFlow,
            host: host,
            router: router,
            setReturnFocus: { returnFocus.append($0) }
        )

        let expected = PhotoReviewScanReturn(
            photos: [third, originalCover, second],
            focus: .reviewButton
        )
        XCTAssertEqual(outcome, .completed(expected))
        XCTAssertEqual(router.photoReviewScanReturn, expected)
        XCTAssertEqual(returnFocus, [.reviewButton])
        XCTAssertNil(host.session)
        XCTAssertNil(router.captureBoundaryRequest)
        XCTAssertEqual(router.presentedFullScreen, .guidedCamera)
        XCTAssertEqual(captureFlow.stagedPhotos, [third, originalCover, second])
        XCTAssertFalse(
            host.isCommitting,
            "The commit gate must reopen once the exit resolves."
        )

        // The reorder has to survive as durable truth, not only in memory.
        let reloaded = try await LocalCaptureDraftStore(
            rootDirectory: root
        ).loadPhotos()
        XCTAssertEqual(reloaded, [third, originalCover, second])
    }

    func testRestoredCaptureFixtureRefusesReplaceRatherThanReportingItApplied() async throws {
        let dependencies = AppDependencies.make(
            configuration: LaunchConfiguration.parse(
                arguments: ["--restored-capture-fixture"]
            )
        )
        let store = dependencies.captureDraftStore
        let before = try await store.loadPhotos()
        let target = try XCTUnwrap(before.first)

        do {
            let result = try await store.replace(
                photoID: target.id,
                imageData: Data([0x01]),
                libraryTransferReceipt: nil
            )
            XCTFail(
                """
                The fixture has no image pipeline, so replace must refuse rather than \
                hand back \(result.replacementPhoto.id) as an applied replacement.
                """
            )
            return
        } catch CaptureDraftStoreError.stagingUnsupported {
            // The refusal Photo Review turns into its replacement failure recovery.
        } catch {
            XCTFail("Replace must refuse with stagingUnsupported, not \(error).")
            return
        }

        let after = try await store.loadPhotos()
        XCTAssertEqual(
            after,
            before,
            "A refused replacement must leave the draft exactly as it was."
        )
    }

    func testRestoredCaptureFixtureRefusesToStageAndNamesTheRefusalForWhatItIs() async throws {
        let dependencies = AppDependencies.make(
            configuration: LaunchConfiguration.parse(
                arguments: ["--restored-capture-fixture"]
            )
        )
        let store = dependencies.captureDraftStore
        let before = try await store.loadPhotos()

        do {
            let result = try await store.append(
                imageData: Data([0x01]),
                libraryTransferReceipt: nil
            )
            XCTFail(
                """
                The fixture has no image pipeline, so an addition must refuse rather \
                than report \(result.appendedPhoto.id) as staged.
                """
            )
            return
        } catch CaptureDraftStoreError.stagingUnsupported {
            // Nothing about the draft manifest is wrong. This store simply cannot stage.
        } catch {
            XCTFail("Staging must refuse with stagingUnsupported, not \(error).")
            return
        }

        let after = try await store.loadPhotos()
        XCTAssertEqual(
            after,
            before,
            "A refused addition must leave the draft exactly as it was."
        )
    }

    func testRestoredCaptureFixtureAddReportsFailureRatherThanDuplicatingItsPhoto() async throws {
        let dependencies = AppDependencies.make(
            configuration: LaunchConfiguration.parse(
                arguments: ["--restored-capture-fixture"]
            )
        )
        let draftStore = dependencies.captureDraftStore
        let restored = try await draftStore.loadPhotos()
        XCTAssertEqual(restored.count, 1)
        let reviewStore = PhotoReviewStore(photos: restored)
        let intake = PhotoReviewIntake(draftStore: draftStore)

        reviewStore.beginPickerRequest(.add)
        let outcome = await intake.apply(
            [TestLibraryPhotoLoader { Data([0x01]) }],
            to: reviewStore
        )

        XCTAssertEqual(
            outcome,
            .inert,
            "The fixture cannot stage the seller's photo, so nothing may be reported as added."
        )
        XCTAssertEqual(
            reviewStore.photos,
            restored,
            "A fixture Add must not put a second copy of the held photo on screen."
        )
        let durablePhotos = try await draftStore.loadPhotos()
        XCTAssertEqual(durablePhotos, restored)
        XCTAssertEqual(
            intake.recovery,
            PhotoReviewIntakeRecovery(
                message: "Photo could not be added. Nothing else changed.",
                focus: .addButton
            )
        )
        XCTAssertNil(reviewStore.activePickerRequest)
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

    func testPhotoReviewSaveFailureUsesApprovedCopyAndWithdrawsRetryAfterSecondRejection() {
        var failure = PhotoReviewSaveFailure(action: .backToCamera)

        XCTAssertEqual(failure.state, .firstRejection)
        XCTAssertEqual(
            failure.heading,
            "These photos cannot be saved."
        )
        XCTAssertEqual(
            failure.body,
            "SnapList could not save the photos on this screen. This is a problem on this device, not something you did. No credit was used."
        )
        XCTAssertEqual(failure.primaryActionTitle, "Try saving again")
        XCTAssertEqual(failure.secondaryActionTitle, "Discard these photos")
        XCTAssertEqual(failure.discardButtonStyle, .outlined)
        XCTAssertEqual(
            failure.liveRegionAnnouncement,
            "These photos cannot be saved. No credit was used. Actions: Try saving again, Discard these photos."
        )

        failure.recordAnotherRejection()

        XCTAssertEqual(failure.state, .rejectedAgain)
        XCTAssertEqual(
            failure.heading,
            "Saving failed again. These photos cannot be kept."
        )
        XCTAssertEqual(
            failure.body,
            "Nothing more will recover them. Discard them to continue."
        )
        XCTAssertNil(failure.primaryActionTitle)
        XCTAssertEqual(failure.secondaryActionTitle, "Discard these photos")
        XCTAssertEqual(failure.discardButtonStyle, .filled)
        XCTAssertEqual(
            failure.liveRegionAnnouncement,
            "Saving failed again. These photos cannot be kept. Actions: Discard these photos."
        )
    }

    func testPhotoReviewV15FailureFixturesExposeBothFrozenStates() {
        let first = try! XCTUnwrap(PhotoReviewVisualStateID.saveRejected.saveFailure)
        let second = try! XCTUnwrap(
            PhotoReviewVisualStateID.saveRejectedAgain.saveFailure
        )

        XCTAssertEqual(PhotoReviewVisualStateID.saveRejected.rawValue, "REV-05")
        XCTAssertEqual(
            PhotoReviewVisualStateID.saveRejectedAgain.rawValue,
            "REV-06"
        )
        XCTAssertEqual(first.state, .firstRejection)
        XCTAssertEqual(second.state, .rejectedAgain)
    }

    func testPhotoReviewSaveFailureAnnouncesEachFrozenReadingOnce() {
        var consumer = PhotoReviewSaveFailureAnnouncementConsumer()
        var failure = PhotoReviewSaveFailure(action: .backToCamera)

        XCTAssertEqual(
            consumer.consume(failure),
            "These photos cannot be saved. No credit was used. Actions: Try saving again, Discard these photos."
        )
        XCTAssertNil(consumer.consume(failure))

        failure.recordAnotherRejection()

        XCTAssertEqual(
            consumer.consume(failure),
            "Saving failed again. These photos cannot be kept. Actions: Discard these photos."
        )
        XCTAssertNil(consumer.consume(failure))

        XCTAssertNil(consumer.consume(nil))
        let laterDeleteFailure = PhotoReviewSaveFailure(
            action: .delete(UUID())
        )
        XCTAssertEqual(
            consumer.consume(laterDeleteFailure),
            "These photos cannot be saved. No credit was used. Actions: Try saving again, Discard these photos."
        )
    }

    func testPhotoReviewSaveFailureEvidenceUsesCenteredFloorAndAdaptiveColumns() {
        let onePhoto = PhotoReviewSaveFailureEvidenceLayout(
            photoCount: 1,
            isAccessibilitySize: false
        )
        let oneColumn = onePhoto.columnCount(for: 339)
        XCTAssertEqual(oneColumn, 1)
        XCTAssertEqual(onePhoto.minimumHeight(for: oneColumn), 166)
        XCTAssertEqual(
            onePhoto.tileWidth(
                in: CGSize(width: 339, height: onePhoto.minimumHeight(for: oneColumn)),
                columns: oneColumn
            ),
            104
        )

        let accessibilityThreePhotos = PhotoReviewSaveFailureEvidenceLayout(
            photoCount: 3,
            isAccessibilitySize: true
        )
        XCTAssertEqual(accessibilityThreePhotos.columnCount(for: 339), 3)

        let accessibilityFivePhotos = PhotoReviewSaveFailureEvidenceLayout(
            photoCount: 5,
            isAccessibilitySize: true
        )
        XCTAssertEqual(accessibilityFivePhotos.columnCount(for: 339), 3)
        XCTAssertEqual(accessibilityFivePhotos.minimumColumnCount, 3)
        XCTAssertEqual(
            accessibilityFivePhotos.minimumHeight(
                for: accessibilityFivePhotos.minimumColumnCount
            ),
            306
        )
    }

    func testRejectedPhotoReviewDeleteKeepsPhotosAndSignalsTheFailure() async {
        let photo = makeStagedPhoto(
            id: "48700000-0000-4000-8000-000000000006"
        )
        let draftStore = TestCaptureStore(
            staged: photo,
            replacePhotosError: CaptureDraftStoreError.invalidManifest
        )
        let captureFlow = CaptureFlowModel(
            camera: TestCaptureCamera(
                isAvailable: true,
                authorization: .authorized
            ),
            evaluator: TestFramingEvaluator(observations: []),
            store: draftStore
        )
        let restoration = await captureFlow.restore()
        XCTAssertEqual(restoration, .stagedPhoto)

        let router = AppRouter(initialFullScreen: .guidedCamera)
        router.openCaptureBoundary(
            destination: .photoReview,
            photos: captureFlow.stagedPhotos,
            opener: .reviewButton
        )
        let host = PhotoReviewLiveHost()
        XCTAssertTrue(host.consume(router.captureBoundaryRequest))
        let session = try! XCTUnwrap(host.session)
        XCTAssertTrue(session.store.selectPhotoForActions(id: photo.id))
        let expectedPhotoID = try! XCTUnwrap(session.store.actionsPhotoID)
        var rejectedPhotoIDs: [StagedCapturePhoto.ID] = []

        let deletion = await AppShellPhotoReviewDeleteTransaction.perform(
            session: session,
            captureFlow: captureFlow,
            host: host,
            router: router,
            setReturnFocus: { _ in },
            expectedPhotoID: expectedPhotoID,
            onPersistenceRejected: { rejectedPhotoIDs.append($0) }
        )

        XCTAssertNil(deletion)
        XCTAssertEqual(rejectedPhotoIDs, [expectedPhotoID])
        XCTAssertEqual(session.store.photos, [photo])
        XCTAssertTrue(host.session === session)
        XCTAssertEqual(captureFlow.stagedPhotos, [photo])
    }

    func testRejectedPhotoReviewBackKeepsPhotosAndOffersTheDurableDiscardExit() async {
        let photo = makeStagedPhoto(
            id: "48700000-0000-4000-8000-000000000001"
        )
        let draftStore = TestCaptureStore(
            staged: photo,
            replacePhotosError: CaptureDraftStoreError.invalidManifest
        )
        let captureFlow = CaptureFlowModel(
            camera: TestCaptureCamera(
                isAvailable: true,
                authorization: .authorized
            ),
            evaluator: TestFramingEvaluator(observations: []),
            store: draftStore
        )
        let restoration = await captureFlow.restore()
        XCTAssertEqual(restoration, .stagedPhoto)

        let router = AppRouter(initialFullScreen: .guidedCamera)
        router.openCaptureBoundary(
            destination: .photoReview,
            photos: captureFlow.stagedPhotos,
            opener: .reviewButton
        )
        let host = PhotoReviewLiveHost()
        XCTAssertTrue(host.consume(router.captureBoundaryRequest))
        let session = try! XCTUnwrap(host.session)

        var rejectedBackCount = 0
        let backOutcome = await AppShellPhotoReviewBackTransaction.perform(
            session: session,
            captureFlow: captureFlow,
            host: host,
            router: router,
            setReturnFocus: { _ in },
            onPersistenceRejected: { rejectedBackCount += 1 }
        )

        XCTAssertEqual(backOutcome, .persistenceRejected)
        XCTAssertEqual(rejectedBackCount, 1)
        XCTAssertEqual(session.store.photos, [photo])
        XCTAssertTrue(host.session === session)

        let discarded = await AppShellPhotoReviewFailureDiscardTransaction.perform(
            session: session,
            captureFlow: captureFlow,
            host: host,
            router: router,
            setReturnFocus: { _ in }
        )

        XCTAssertTrue(discarded)
        XCTAssertEqual(draftStore.discardCount, 1)
        XCTAssertNil(host.session)
        XCTAssertTrue(captureFlow.stagedPhotos.isEmpty)
        XCTAssertEqual(
            router.photoReviewScanReturn,
            PhotoReviewScanReturn(photos: [], focus: .addPhotoButton)
        )
    }

    func testPhotoReviewFailureDiscardLeavesAReplacementSessionUntouched() async {
        let stalePhoto = makeStagedPhoto(
            id: "48700000-0000-4000-8000-000000000003"
        )
        let replacementPhoto = makeStagedPhoto(
            id: "48700000-0000-4000-8000-000000000004"
        )
        let captureFlow = CaptureFlowModel(
            camera: TestCaptureCamera(
                isAvailable: true,
                authorization: .authorized
            ),
            evaluator: TestFramingEvaluator(observations: []),
            store: TestCaptureStore(staged: stalePhoto)
        )
        let router = AppRouter(initialFullScreen: .guidedCamera)
        router.openCaptureBoundary(
            destination: .photoReview,
            photos: [stalePhoto],
            opener: .reviewButton
        )
        let host = PhotoReviewLiveHost()
        XCTAssertTrue(host.consume(router.captureBoundaryRequest))
        let staleSession = try! XCTUnwrap(host.session)

        XCTAssertTrue(host.leaveForDepartedIntake(from: staleSession, using: router))
        router.openCaptureBoundary(
            destination: .photoReview,
            photos: [replacementPhoto],
            opener: .reviewButton
        )
        XCTAssertTrue(host.consume(router.captureBoundaryRequest))
        let replacementSession = try! XCTUnwrap(host.session)

        let discarded = await AppShellPhotoReviewFailureDiscardTransaction.perform(
            session: staleSession,
            captureFlow: captureFlow,
            host: host,
            router: router,
            setReturnFocus: { _ in }
        )

        XCTAssertFalse(discarded)
        XCTAssertFalse(host.isCommitting)
        XCTAssertTrue(host.session === replacementSession)
        XCTAssertEqual(replacementSession.store.photos, [replacementPhoto])
    }

    func testDepartedPhotoReviewRestartsCameraForTheGuidedScanReturn() async {
        let photo = makeStagedPhoto(id: "45800000-0000-4000-8000-000000000053")
        let camera = TestCaptureCamera(
            isAvailable: true,
            authorization: .authorized
        )
        let captureFlow = CaptureFlowModel(
            camera: camera,
            evaluator: TestFramingEvaluator(observations: []),
            store: TestCaptureStore()
        )
        let router = AppRouter(initialFullScreen: .guidedCamera)
        router.openCaptureBoundary(
            destination: .photoReview,
            photos: [photo],
            opener: .reviewButton
        )
        let host = PhotoReviewLiveHost()
        XCTAssertTrue(host.consume(router.captureBoundaryRequest))

        var receivedFocuses: [PhotoReviewScanFocus] = []
        let didReturn = await AppShellDepartedPhotoReviewTransaction.perform(
            captureFlow: captureFlow,
            host: host,
            router: router,
            setReturnFocus: { receivedFocuses.append($0) }
        )

        XCTAssertTrue(didReturn)
        XCTAssertEqual(camera.startCount, 1)
        XCTAssertEqual(captureFlow.phase, .camera)
        XCTAssertNil(host.session)
        XCTAssertNil(router.captureBoundaryRequest)
        XCTAssertEqual(router.presentedFullScreen, .guidedCamera)
        XCTAssertEqual(receivedFocuses, [.addPhotoButton])
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
            writeData: { data, url, options in
                try failingWriter.write(
                    data: data,
                    url: url,
                    options: options
                )
            }
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
                announcement: "Photo removed. 2 of 5."
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
                "Photo removed. 2 of 5."
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
                announcement: "Photo removed. 2 of 5."
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
                "Photo removed. 2 of 5."
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
                announcement: "Photo removed. No photos remain."
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
                "Photo removed. No photos remain."
            )
            XCTAssertNil(host.consumeFinalDeleteAnnouncement())

            XCTAssertNil(host.deleteFinalPhoto(id: onlyPhoto.id, using: router))
            XCTAssertNil(host.session)
            XCTAssertEqual(router.photoReviewScanReturn, expectedReturn)
            XCTAssertNil(host.consumeFinalDeleteAnnouncement())
        }
    }

    func testLivePhotoReviewDeleteRoutesTheOpenActionsPhotoToTheSurvivingNeighbour()
        async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let captureFlow = makeIntakeCaptureFlow(root: root)
        let restoration = await captureFlow.restore()
        XCTAssertEqual(restoration, .noDraft)
        let staged = await captureFlow.stageLibraryPhotos(
            (1...3).map { makeIntakeJPEG(seed: $0) }
        )
        XCTAssertEqual(staged, 3)
        let durableIntake = captureFlow.stagedPhotos
        guard durableIntake.count == 3 else {
            XCTFail("Photo Review needs exactly three durable photos.")
            return
        }
        let originalCover = durableIntake[0]
        let second = durableIntake[1]
        let third = durableIntake[2]

        let router = AppRouter(initialFullScreen: .guidedCamera)
        router.openCaptureBoundary(
            destination: .photoReview,
            photos: durableIntake,
            opener: .reviewButton
        )
        let host = PhotoReviewLiveHost()
        XCTAssertTrue(
            host.consume(router.captureBoundaryRequest, captureFlow: captureFlow)
        )
        guard let session = host.session else {
            XCTFail("The exact three-photo request must expose one live session.")
            return
        }

        var returnFocus: [PhotoReviewScanFocus] = []
        let withoutOpenActions = await AppShellPhotoReviewDeleteTransaction.perform(
            session: session,
            captureFlow: captureFlow,
            host: host,
            router: router,
            setReturnFocus: { returnFocus.append($0) }
        )
        XCTAssertNil(
            withoutOpenActions,
            "Delete is inert until the seller opens actions on an exact photo."
        )

        session.store.selectPhotoForActions(id: second.id)
        let application = await AppShellPhotoReviewDeleteTransaction.perform(
            session: session,
            captureFlow: captureFlow,
            host: host,
            router: router,
            setReturnFocus: { returnFocus.append($0) }
        )

        XCTAssertEqual(
            application,
            PhotoReviewDeleteApplication(
                focus: .photo(third.id),
                announcement: "Photo removed. 2 of 5."
            )
        )
        XCTAssertEqual(session.store.photos, [originalCover, third])
        XCTAssertTrue(
            host.session === session,
            "A surviving photo keeps the seller inside Photo Review."
        )
        XCTAssertEqual(router.photoReviewScanReturn, nil)
        XCTAssertEqual(returnFocus, [])
        // Photo Review commits write through to the durable intake, so the survivor set
        // reaches Scan directly rather than waiting to be carried back.
        await waitUntilTrue { captureFlow.stagedPhotos == [originalCover, third] }
        XCTAssertEqual(captureFlow.stagedPhotos, [originalCover, third])
    }

    func testLivePhotoReviewDeletingTheFinalPhotoLeavesForGuidedScanWithNoPhotos()
        async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let captureFlow = makeIntakeCaptureFlow(root: root)
        let restoration = await captureFlow.restore()
        XCTAssertEqual(restoration, .noDraft)
        let staged = await captureFlow.stageLibraryPhotos([makeIntakeJPEG(seed: 1)])
        XCTAssertEqual(staged, 1)
        let restoredPhotos = captureFlow.stagedPhotos
        guard let onlyPhoto = restoredPhotos.first, restoredPhotos.count == 1 else {
            XCTFail("Photo Review needs exactly one durable photo.")
            return
        }

        let router = AppRouter(initialFullScreen: .guidedCamera)
        router.openCaptureBoundary(
            destination: .photoReview,
            photos: restoredPhotos,
            opener: .reviewButton
        )
        let host = PhotoReviewLiveHost()
        XCTAssertTrue(
            host.consume(router.captureBoundaryRequest, captureFlow: captureFlow)
        )
        guard let session = host.session else {
            XCTFail("The exact one-photo request must expose one live session.")
            return
        }
        session.store.selectPhotoForActions(id: onlyPhoto.id)

        var returnFocus: [PhotoReviewScanFocus] = []
        let application = await AppShellPhotoReviewDeleteTransaction.perform(
            session: session,
            captureFlow: captureFlow,
            host: host,
            router: router,
            setReturnFocus: { returnFocus.append($0) }
        )

        XCTAssertEqual(
            application,
            PhotoReviewDeleteApplication(
                focus: .addButton,
                announcement: "Photo removed. No photos remain."
            )
        )
        XCTAssertNil(host.session, "The final delete clears the Photo Review boundary.")
        XCTAssertNil(router.captureBoundaryRequest)
        XCTAssertEqual(
            router.photoReviewScanReturn,
            PhotoReviewScanReturn(photos: [], focus: .addPhotoButton)
        )
        XCTAssertEqual(router.presentedFullScreen, .guidedCamera)
        XCTAssertEqual(returnFocus, [.addPhotoButton])
        XCTAssertTrue(
            captureFlow.stagedPhotos.isEmpty,
            "The deleted photo must leave Scan's durable intake, not only the session."
        )
        XCTAssertEqual(
            captureFlow.phase,
            .camera,
            "Zero-photo Scan is the live guided camera, not a stalled boundary."
        )

        let repeated = await AppShellPhotoReviewDeleteTransaction.perform(
            session: session,
            captureFlow: captureFlow,
            host: host,
            router: router,
            setReturnFocus: { returnFocus.append($0) }
        )
        XCTAssertNil(
            repeated,
            "Repeating the final delete is inert and never announces twice."
        )
        XCTAssertEqual(returnFocus, [.addPhotoButton])
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

    func testPhotoReviewNativeDragContractCarriesOneStableIdentityType() {
        let photoID = UUID(
            uuidString: "46000000-0000-4000-8000-000000000003"
        )!
        let provider = PhotoReviewNativeDragContract.itemProvider(
            photoID: photoID
        )

        XCTAssertEqual(
            provider.registeredTypeIdentifiers,
            [PhotoReviewNativeDragContract.contentType.identifier]
        )
        XCTAssertEqual(
            PhotoReviewNativeDragContract.photoID(from: provider),
            photoID
        )
        XCTAssertNil(
            PhotoReviewNativeDragContract.photoID(
                from: NSItemProvider(
                    object: photoID.uuidString as NSString
                )
            )
        )
    }

    func testPhotoReviewNativeSourceDefersPresentationUntilSessionWillBegin() throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory.appendingPathComponent(
            "snaplist-photo-review-native-session-\(UUID().uuidString)",
            isDirectory: true
        )
        defer { try? fileManager.removeItem(at: root) }

        let fixturePhotos = PhotoReviewFixtureView.photos(
            for: .resting,
            rootDirectory: root
        )
        let photos = zip(makeDragPhotos(), fixturePhotos).map { pair in
            let (photo, fixturePhoto) = pair
            return StagedCapturePhoto(
                id: photo.id,
                photoURL: fixturePhoto.photoURL,
                thumbnailURL: fixturePhoto.thumbnailURL,
                createdAt: photo.createdAt,
                libraryTransferReceipt: photo.libraryTransferReceipt
            )
        }
        let store = PhotoReviewStore(photos: photos)
        let presentation = PhotoReviewDragPresentation()
        let sourceFrame = CGRect(x: 176, y: 0, width: 76, height: 98)
        let source = PhotoReviewNativeDragSourceDelegate(
            store: store,
            presentation: presentation,
            reduceMotion: true,
            isEnabled: true,
            sourceAtLocation: { _ in
                PhotoReviewNativeDragSource(
                    photoID: photos[2].id,
                    thumbnailURL: photos[2].thumbnailURL,
                    frame: sourceFrame
                )
            }
        )
        let host = makeNativeInteractionHost()
        let sourceView = host.innerHorizontalStrip
        defer { host.cleanUp() }
        sourceView.bounds = CGRect(
            x: 44,
            y: 0,
            width: 320,
            height: 98
        )
        source.attach(to: sourceView)
        let interaction = try XCTUnwrap(
            sourceView.interactions
                .compactMap { $0 as? UIDragInteraction }
                .first
        )
        let session = PhotoReviewDragSessionStub()
        session.currentLocation = CGPoint(x: 258, y: 49)

        let items = source.dragInteraction(
            interaction,
            itemsForBeginning: session
        )
        let item = try XCTUnwrap(items.first)

        XCTAssertEqual(
            PhotoReviewNativeDragContract.photoID(
                from: item.itemProvider
            ),
            photos[2].id
        )
        XCTAssertNil(presentation.draggedPhotoID)
        XCTAssertNil(presentation.insertionIndex)

        let preview = try XCTUnwrap(
            source.dragInteraction(
                interaction,
                previewForLifting: item,
                session: session
            )
        )
        XCTAssertNotNil((preview.view as? UIImageView)?.image)
        XCTAssertTrue(preview.target.container === sourceView)
        XCTAssertEqual(
            preview.target.center.x,
            sourceFrame.midX + sourceView.bounds.minX,
            accuracy: 0.001
        )

        source.dragInteraction(
            interaction,
            sessionWillBegin: session
        )

        XCTAssertEqual(presentation.draggedPhotoID, photos[2].id)
        XCTAssertEqual(presentation.insertionIndex, 2)

        source.dragInteraction(
            interaction,
            session: session,
            didEndWith: .cancel
        )
        XCTAssertEqual(presentation.consumeFocusPhotoID(), photos[2].id)

        let invalidatedSession = PhotoReviewDragSessionStub()
        invalidatedSession.currentLocation = session.currentLocation
        let invalidatedItem = try XCTUnwrap(
            source.dragInteraction(
                interaction,
                itemsForBeginning: invalidatedSession
            ).first
        )
        XCTAssertTrue(store.deletePhoto(id: photos[2].id))

        source.dragInteraction(
            interaction,
            sessionWillBegin: invalidatedSession
        )

        XCTAssertNil(presentation.draggedPhotoID)
        XCTAssertNil(presentation.insertionIndex)
        XCTAssertNil(
            source.dragInteraction(
                interaction,
                previewForLifting: invalidatedItem,
                session: invalidatedSession
            )
        )
    }

    func testPhotoReviewNativeSourceMapsFivePhotoTouchToExactIdentity() throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory.appendingPathComponent(
            "snaplist-photo-review-native-source-\(UUID().uuidString)",
            isDirectory: true
        )
        defer { try? fileManager.removeItem(at: root) }

        let photos = PhotoReviewFixtureView.photos(
            for: .fivePhotos,
            rootDirectory: root
        )
        let frames = Dictionary(
            uniqueKeysWithValues: photos.enumerated().map { index, photo in
                (
                    photo.id,
                    CGRect(
                        x: CGFloat(index) * 88,
                        y: 0,
                        width: 76,
                        height: 98
                    )
                )
            }
        )

        let store = PhotoReviewStore(photos: photos)
        let presentation = PhotoReviewDragPresentation()
        let source = PhotoReviewNativeDragSourceDelegate(
            store: store,
            presentation: presentation,
            reduceMotion: true,
            isEnabled: true,
            sourceAtLocation: { location in
                PhotoReviewNativeDragSourceGeometry.source(
                    at: location,
                    photos: photos,
                    frames: frames
                )
            }
        )
        let sourceView = UIScrollView(
            frame: CGRect(x: 0, y: 0, width: 320, height: 98)
        )
        let hostController = UIViewController()
        let window = UIWindow(
            frame: CGRect(x: 0, y: 0, width: 390, height: 844)
        )
        window.rootViewController = hostController
        window.makeKeyAndVisible()
        hostController.view.addSubview(sourceView)
        hostController.view.layoutIfNeeded()
        defer {
            window.isHidden = true
            withExtendedLifetime(window) {}
        }

        sourceView.contentSize = CGSize(width: 440, height: 122)
        sourceView.bounds = CGRect(
            x: 88,
            y: 24,
            width: 320,
            height: 98
        )
        source.attach(to: sourceView)
        source.attach(to: sourceView)

        XCTAssertEqual(
            sourceView.interactions.compactMap { $0 as? UIDragInteraction }.count,
            1
        )
        let interaction = try XCTUnwrap(
            sourceView.interactions.compactMap { $0 as? UIDragInteraction }.first
        )
        XCTAssertTrue(interaction.view === sourceView)

        for photo in photos {
            let frame = try XCTUnwrap(frames[photo.id])
            let session = PhotoReviewDragSessionStub()
            session.currentLocation = CGPoint(
                x: frame.midX + sourceView.bounds.minX,
                y: frame.midY + sourceView.bounds.minY
            )

            let items = source.dragInteraction(
                interaction,
                itemsForBeginning: session
            )
            let item = try XCTUnwrap(items.first)

            XCTAssertEqual(
                PhotoReviewNativeDragContract.photoID(
                    from: item.itemProvider
                ),
                photo.id
            )

            let preview = try XCTUnwrap(
                source.dragInteraction(
                    interaction,
                    previewForLifting: item,
                    session: session
                )
            )
            XCTAssertNotNil((preview.view as? UIImageView)?.image)
            XCTAssertTrue(preview.target.container === sourceView)
            XCTAssertEqual(
                preview.target.center.x,
                frame.midX + sourceView.bounds.minX,
                accuracy: 0.001
            )
            XCTAssertEqual(
                preview.target.center.y,
                frame.midY + sourceView.bounds.minY,
                accuracy: 0.001
            )
            XCTAssertEqual(
                preview.target.center.x - sourceView.bounds.minX,
                frame.midX,
                accuracy: 0.001
            )
            XCTAssertEqual(
                preview.target.center.y - sourceView.bounds.minY,
                frame.midY,
                accuracy: 0.001
            )

            source.dragInteraction(
                interaction,
                sessionWillBegin: session
            )
            XCTAssertEqual(presentation.draggedPhotoID, photo.id)

            source.dragInteraction(
                interaction,
                session: session,
                didEndWith: .cancel
            )
            XCTAssertNil(presentation.draggedPhotoID)
            XCTAssertEqual(presentation.consumeFocusPhotoID(), photo.id)
            XCTAssertNil(presentation.consumeAnnouncement())
        }
    }

    func testPhotoReviewNativeSourceObservationClassifiesEveryPreLiftGuard() throws {
        let photos = makeDragPhotos()
        let store = PhotoReviewStore(photos: photos)
        let presentation = PhotoReviewDragPresentation()
        var observation = PhotoReviewNativeDragSourceObservation()
        let observe: (PhotoReviewNativeDragSourceEvent) -> Void = {
            observation.observe($0)
        }
        let sourceView = UIScrollView(
            frame: CGRect(x: 0, y: 0, width: 320, height: 98)
        )
        sourceView.contentSize = CGSize(width: 440, height: 98)
        sourceView.bounds.origin.x = 44

        let source = PhotoReviewNativeDragSourceDelegate(
            store: store,
            presentation: presentation,
            reduceMotion: true,
            isEnabled: false,
            sourceAtLocation: { _ in
                XCTFail("A disabled source must not resolve thumbnail frames.")
                return nil
            },
            observeSource: observe
        )
        XCTAssertTrue(
            source.dragInteraction(
                UIDragInteraction(delegate: source),
                itemsForBeginning: PhotoReviewDragSessionStub()
            ).isEmpty
        )
        XCTAssertEqual(
            observation.beginOutcome,
            "rejected-missing-view"
        )
        source.attach(to: sourceView)
        let interaction = try XCTUnwrap(
            sourceView.interactions
                .compactMap { $0 as? UIDragInteraction }
                .first
        )
        let session = PhotoReviewDragSessionStub()
        session.currentLocation = CGPoint(x: 82, y: 49)

        XCTAssertTrue(
            source.dragInteraction(
                interaction,
                itemsForBeginning: session
            ).isEmpty
        )
        XCTAssertEqual(observation.beginOutcome, "rejected-disabled")
        XCTAssertTrue(observation.isAttached)
        XCTAssertFalse(observation.isEnabled)

        source.update(
            store: store,
            presentation: presentation,
            reduceMotion: true,
            isEnabled: true,
            sourceAtLocation: { _ in
                observe(.resolving(frameCount: photos.count))
                return nil
            },
            observeSource: observe
        )
        XCTAssertTrue(
            source.dragInteraction(
                interaction,
                itemsForBeginning: session
            ).isEmpty
        )
        XCTAssertEqual(observation.frameCount, photos.count)
        XCTAssertEqual(observation.beginOutcome, "rejected-no-source")
        XCTAssertTrue(observation.isEnabled)

        let missingPhoto = PhotoReviewNativeDragSource(
            photoID: UUID(),
            thumbnailURL: photos[0].thumbnailURL,
            frame: CGRect(x: 0, y: 0, width: 76, height: 98)
        )
        source.update(
            store: store,
            presentation: presentation,
            reduceMotion: true,
            isEnabled: true,
            sourceAtLocation: { _ in
                observe(.resolving(frameCount: photos.count))
                return missingPhoto
            },
            observeSource: observe
        )
        XCTAssertTrue(
            source.dragInteraction(
                interaction,
                itemsForBeginning: session
            ).isEmpty
        )
        XCTAssertEqual(
            observation.beginOutcome,
            "rejected-presentation"
        )

        let thirdPhoto = PhotoReviewNativeDragSource(
            photoID: photos[2].id,
            thumbnailURL: photos[2].thumbnailURL,
            frame: CGRect(x: 176, y: 0, width: 76, height: 98)
        )
        source.update(
            store: store,
            presentation: presentation,
            reduceMotion: true,
            isEnabled: true,
            sourceAtLocation: { _ in
                observe(.resolving(frameCount: photos.count))
                return thirdPhoto
            },
            observeSource: observe
        )
        let items = source.dragInteraction(
            interaction,
            itemsForBeginning: session
        )

        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(observation.beginOutcome, "provided")
        XCTAssertEqual(observation.photoID, photos[2].id)
        XCTAssertEqual(observation.hostBounds, sourceView.bounds)
        XCTAssertEqual(observation.hostContentSize, sourceView.contentSize)
    }

    func testPhotoReviewNativeSourceObservationClassifiesFullLiftMovementAndEndLocation() throws {
        let photos = makeDragPhotos()
        let frames = Dictionary(
            uniqueKeysWithValues: photos.enumerated().map { index, photo in
                (
                    photo.id,
                    CGRect(
                        x: CGFloat(index) * 88,
                        y: 0,
                        width: 76,
                        height: 98
                    )
                )
            }
        )
        let store = PhotoReviewStore(photos: photos)
        let presentation = PhotoReviewDragPresentation()
        var observation = PhotoReviewNativeDragSourceObservation()
        let sourceView = UIScrollView(
            frame: CGRect(x: 0, y: 0, width: 320, height: 98)
        )
        sourceView.contentSize = CGSize(width: 440, height: 98)
        sourceView.bounds.origin.x = 44
        let source = PhotoReviewNativeDragSourceDelegate(
            store: store,
            presentation: presentation,
            reduceMotion: true,
            isEnabled: true,
            sourceAtLocation: { location in
                PhotoReviewNativeDragSourceGeometry.source(
                    at: location,
                    photos: photos,
                    frames: frames
                )
            },
            observeSource: { observation.observe($0) }
        )
        source.attach(to: sourceView)
        let interaction = try XCTUnwrap(
            sourceView.interactions
                .compactMap { $0 as? UIDragInteraction }
                .first
        )
        let session = PhotoReviewDragSessionStub()
        session.currentLocation = CGPoint(
            x: try XCTUnwrap(frames[photos[2].id]).midX
                + sourceView.bounds.minX,
            y: 49
        )
        session.items = source.dragInteraction(
            interaction,
            itemsForBeginning: session
        )
        XCTAssertEqual(
            PhotoReviewNativeDragContract.photoID(
                from: try XCTUnwrap(session.items.first).itemProvider
            ),
            photos[2].id
        )

        source.dragInteraction(
            interaction,
            sessionWillBegin: session
        )
        session.currentLocation = CGPoint(
            x: try XCTUnwrap(frames[photos[1].id]).midX
                + sourceView.bounds.minX,
            y: 49
        )
        source.dragInteraction(
            interaction,
            sessionDidMove: session
        )
        session.currentLocation = CGPoint(
            x: try XCTUnwrap(frames[photos[0].id]).midX
                + sourceView.bounds.minX,
            y: 49
        )
        source.dragInteraction(
            interaction,
            sessionDidMove: session
        )
        XCTAssertEqual(observation.sessionDidMoveCount, 0)
        XCTAssertNil(observation.lastSessionDidMoveLocation)
        source.dragInteraction(
            interaction,
            session: session,
            willEndWith: .cancel
        )
        source.dragInteraction(
            interaction,
            session: session,
            didEndWith: .cancel
        )

        XCTAssertTrue(observation.didSessionWillBegin)
        XCTAssertEqual(
            observation.sessionWillBeginLocation,
            CGPoint(x: 214, y: 49)
        )
        XCTAssertEqual(
            observation.sessionWillBeginPanState,
            .possible
        )
        XCTAssertEqual(observation.sessionDidMoveCount, 2)
        XCTAssertEqual(
            observation.lastSessionDidMoveLocation,
            CGPoint(x: 38, y: 49)
        )
        XCTAssertEqual(observation.willEndOperation, .cancel)
        XCTAssertEqual(
            observation.willEndLocation,
            CGPoint(x: 38, y: 49)
        )
        XCTAssertTrue(observation.didEnd)
        XCTAssertEqual(observation.didEndOperation, .cancel)
        XCTAssertEqual(
            observation.didEndLocation,
            CGPoint(x: 38, y: 49)
        )
        XCTAssertTrue(
            observation.label.contains(
                "willBegin:true,willBeginLocation:214,49,"
                    + "willBeginPan:possible,moves:2,lastMove:38,49,"
                    + "willEnd:cancel,willEndLocation:38,49,"
                    + "ended:true,endOperation:cancel,"
                    + "endLocation:38,49"
            ),
            observation.label
        )
    }

    func testPhotoReviewNativeSourceObservationClassifiesLiftAnimationAndScrollPanBoundary() throws {
        let photos = makeDragPhotos()
        let store = PhotoReviewStore(photos: photos)
        let presentation = PhotoReviewDragPresentation()
        var observation = PhotoReviewNativeDragSourceObservation()
        let sourceView = UIScrollView(
            frame: CGRect(x: 0, y: 0, width: 320, height: 98)
        )
        sourceView.contentSize = CGSize(width: 440, height: 98)
        sourceView.bounds.origin.x = 44
        let source = PhotoReviewNativeDragSourceDelegate(
            store: store,
            presentation: presentation,
            reduceMotion: true,
            isEnabled: true,
            sourceAtLocation: { _ in
                PhotoReviewNativeDragSource(
                    photoID: photos[2].id,
                    thumbnailURL: photos[2].thumbnailURL,
                    frame: CGRect(x: 176, y: 0, width: 76, height: 98)
                )
            },
            observeSource: { observation.observe($0) }
        )
        source.attach(to: sourceView)
        let interaction = try XCTUnwrap(
            sourceView.interactions
                .compactMap { $0 as? UIDragInteraction }
                .first
        )
        let session = PhotoReviewDragSessionStub()
        session.currentLocation = CGPoint(x: 258, y: 49)
        session.items = source.dragInteraction(
            interaction,
            itemsForBeginning: session
        )
        XCTAssertEqual(session.items.count, 1)

        let animator = PhotoReviewDragAnimatorStub()
        source.dragInteraction(
            interaction,
            willAnimateLiftWith: animator,
            session: session
        )

        XCTAssertTrue(observation.didWillAnimateLift)
        XCTAssertEqual(
            observation.willAnimateLiftLocation,
            CGPoint(x: 214, y: 49)
        )
        XCTAssertEqual(
            observation.willAnimateLiftPanState,
            .possible
        )
        XCTAssertNil(observation.liftAnimationCompletionPosition)
        XCTAssertNil(observation.liftAnimationCompletionPanState)

        animator.complete(at: .end)

        XCTAssertEqual(
            observation.liftAnimationCompletionPosition,
            .end
        )
        XCTAssertEqual(
            observation.liftAnimationCompletionPanState,
            .possible
        )

        source.dragInteraction(
            interaction,
            sessionWillBegin: session
        )

        XCTAssertTrue(observation.didSessionWillBegin)
        XCTAssertEqual(
            observation.sessionWillBeginPanState,
            .possible
        )
        XCTAssertTrue(
            observation.label.contains(
                "willAnimateLift:true,willAnimateLiftLocation:214,49,"
                    + "willAnimateLiftPan:possible,liftCompletion:end,"
                    + "liftCompletionPan:possible,willBegin:true,"
                    + "willBeginLocation:214,49,willBeginPan:possible"
            ),
            observation.label
        )
    }

    func testPhotoReviewNativeAttachmentsResolveNestedHorizontalStripHostInsteadOfOuterScreenScroll() {
        let photos = makeDragPhotos()
        let store = PhotoReviewStore(photos: photos)
        let presentation = PhotoReviewDragPresentation()
        let source = PhotoReviewNativeDragSourceDelegate(
            store: store,
            presentation: presentation,
            reduceMotion: true,
            isEnabled: true,
            sourceAtLocation: { _ in nil }
        )
        let destination = PhotoReviewNativeDropAttachment.Coordinator(
            store: store,
            presentation: presentation,
            reduceMotion: true,
            isEnabled: true,
            destinationIndex: { _ in 0 },
            autoScroll: { _ in }
        )

        let host = makeNativeInteractionHost()

        let sourceAttachment =
            PhotoReviewNativeStripInteractionAttachmentView()
        let destinationAttachment =
            PhotoReviewNativeStripInteractionAttachmentView()
        host.stripContent.addSubview(sourceAttachment)
        host.stripContent.addSubview(destinationAttachment)
        defer {
            sourceAttachment.dismantle()
            destinationAttachment.dismantle()
            host.cleanUp()
        }

        sourceAttachment.update(
            shouldAttach: true,
            attach: source.attach(to:),
            detach: source.detach
        )
        destinationAttachment.update(
            shouldAttach: true,
            attach: destination.attach(to:),
            detach: destination.detach
        )
        sourceAttachment.resolveHostAndAttach()
        destinationAttachment.resolveHostAndAttach()

        XCTAssertEqual(
            host.innerHorizontalStrip.interactions
                .compactMap { $0 as? UIDragInteraction }
                .count,
            1
        )
        XCTAssertEqual(
            host.innerHorizontalStrip.interactions
                .compactMap { $0 as? UIDropInteraction }
                .count,
            1
        )
        XCTAssertTrue(
            host.innerHorizontalStrip.interactions
                .compactMap { $0 as? UIDragInteraction }
                .first?
                .view === host.innerHorizontalStrip
        )
        XCTAssertTrue(
            host.innerHorizontalStrip.interactions
                .compactMap { $0 as? UIDropInteraction }
                .first?
                .view === host.innerHorizontalStrip
        )
        XCTAssertTrue(
            host.outerScreenScroll.interactions
                .compactMap { $0 as? UIDragInteraction }
                .isEmpty
        )
        XCTAssertTrue(
            host.outerScreenScroll.interactions
                .compactMap { $0 as? UIDropInteraction }
                .isEmpty
        )
    }

    func testPhotoReviewStripDropGeometryMapsKnownThirdIdentityToCover() {
        let photos = makeDragPhotos()
        let restingFrames = [
            photos[0].id: CGRect(x: 0, y: 0, width: 76, height: 98),
            photos[1].id: CGRect(x: 88, y: 0, width: 76, height: 98),
            photos[2].id: CGRect(x: 176, y: 0, width: 76, height: 98)
        ]
        let coverGapFrames = [
            photos[0].id: CGRect(x: 62, y: 0, width: 76, height: 98),
            photos[1].id: CGRect(x: 150, y: 0, width: 76, height: 98),
            photos[2].id: CGRect(x: 238, y: 0, width: 76, height: 98)
        ]
        let leadingPaddedContainerFrames = [
            photos[0].id: CGRect(x: 0, y: 0, width: 138, height: 98),
            photos[1].id: CGRect(x: 88, y: 0, width: 76, height: 98),
            photos[2].id: CGRect(x: 176, y: 0, width: 76, height: 98)
        ]

        XCTAssertEqual(
            PhotoReviewStripDropGeometry.destinationIndex(
                at: CGPoint(x: 214, y: 38),
                photos: photos,
                frames: restingFrames
            ),
            2
        )
        XCTAssertEqual(
            PhotoReviewStripDropGeometry.destinationIndex(
                at: CGPoint(x: 38, y: 38),
                photos: photos,
                frames: restingFrames
            ),
            0
        )
        XCTAssertEqual(
            PhotoReviewStripDropGeometry.maximumPositiveWidthGrowth(
                from: restingFrames,
                to: coverGapFrames
            ),
            0
        )
        XCTAssertEqual(
            PhotoReviewStripDropGeometry.maximumPositiveWidthGrowth(
                from: restingFrames,
                to: leadingPaddedContainerFrames
            ),
            PhotoReviewDragLayout.insertionGap
        )
        XCTAssertEqual(
            PhotoReviewStripDropGeometry.destinationIndex(
                at: CGPoint(x: 38, y: 38),
                photos: photos,
                frames: coverGapFrames
            ),
            0
        )
    }

    func testPhotoReviewRenderedGapObservationLatchesDeferredWidthGrowthWithoutTreatingReorderAsGap() {
        let photos = makeDragPhotos()
        let restingFrames = [
            photos[0].id: CGRect(x: 0, y: 0, width: 76, height: 98),
            photos[1].id: CGRect(x: 88, y: 0, width: 76, height: 98),
            photos[2].id: CGRect(x: 176, y: 0, width: 76, height: 98)
        ]
        let deferredCoverGapFrames = [
            photos[0].id: CGRect(x: 0, y: 0, width: 138, height: 98),
            photos[1].id: CGRect(x: 150, y: 0, width: 76, height: 98),
            photos[2].id: CGRect(x: 238, y: 0, width: 76, height: 98)
        ]
        let postDropReorderedFrames = [
            photos[0].id: CGRect(x: 88, y: 0, width: 76, height: 98),
            photos[1].id: CGRect(x: 176, y: 0, width: 76, height: 98),
            photos[2].id: CGRect(x: 0, y: 0, width: 76, height: 98)
        ]

        var deferredGapObservation =
            PhotoReviewRenderedInsertionGapObservation()
        deferredGapObservation.observe(
            frames: restingFrames,
            isDragActive: false
        )
        deferredGapObservation.observe(
            frames: deferredCoverGapFrames,
            isDragActive: false
        )

        XCTAssertEqual(
            deferredGapObservation.maximumRenderedInsertionGap,
            PhotoReviewDragLayout.insertionGap
        )

        var reorderOnlyObservation =
            PhotoReviewRenderedInsertionGapObservation()
        reorderOnlyObservation.observe(
            frames: restingFrames,
            isDragActive: false
        )
        reorderOnlyObservation.observe(
            frames: postDropReorderedFrames,
            isDragActive: false
        )

        XCTAssertEqual(
            reorderOnlyObservation.maximumRenderedInsertionGap,
            0
        )
    }

    func testPhotoReviewNativeSessionEndWithoutDropExitClearsOnceAndRestoresExactFocus() {
        let photos = makeDragPhotos()
        let store = PhotoReviewStore(photos: photos)
        let presentation = PhotoReviewDragPresentation()

        XCTAssertTrue(
            presentation.begin(photoID: photos[2].id, store: store)
        )
        presentation.updateInsertion(
            to: 0,
            store: store,
            reduceMotion: true
        )
        presentation.endNativeDragSession(reduceMotion: true)

        XCTAssertEqual(store.photos, photos)
        XCTAssertNil(presentation.draggedPhotoID)
        XCTAssertNil(presentation.insertionIndex)
        XCTAssertEqual(
            presentation.lastTransitionDecision,
            .suppressed
        )
        XCTAssertEqual(presentation.consumeFocusPhotoID(), photos[2].id)
        XCTAssertNil(presentation.consumeFocusPhotoID())
        XCTAssertNil(presentation.consumeAnnouncement())

        presentation.endNativeDragSession(reduceMotion: true)

        XCTAssertNil(presentation.consumeFocusPhotoID())
        XCTAssertNil(presentation.consumeAnnouncement())

        let committedStore = PhotoReviewStore(photos: photos)
        let committed = PhotoReviewDragPresentation()
        XCTAssertTrue(
            committed.begin(photoID: photos[2].id, store: committedStore)
        )
        committed.updateInsertion(
            to: 0,
            store: committedStore,
            reduceMotion: true
        )
        XCTAssertNotNil(
            committed.commit(
                to: 0,
                store: committedStore,
                reduceMotion: true
            )
        )

        committed.endNativeDragSession(reduceMotion: true)

        XCTAssertEqual(
            committedStore.photos,
            [photos[2], photos[0], photos[1]]
        )
        XCTAssertEqual(committed.consumeFocusPhotoID(), photos[2].id)
        XCTAssertNil(committed.consumeFocusPhotoID())
        XCTAssertEqual(
            committed.consumeAnnouncement(),
            "Moved to photo 1 of 3. Cover."
        )
        XCTAssertNil(committed.consumeAnnouncement())
    }

    func testPhotoReviewNativeSourceDelegateEndsAcceptedAndOutsideSessionsExactlyOnce() throws {
        let photos = makeDragPhotos()
        let outsideStore = PhotoReviewStore(photos: photos)
        let outside = PhotoReviewDragPresentation()
        let outsideResolvedSource = PhotoReviewNativeDragSource(
            photoID: photos[2].id,
            thumbnailURL: photos[2].thumbnailURL,
            frame: .zero
        )
        let outsideSource = PhotoReviewNativeDragSourceDelegate(
            store: outsideStore,
            presentation: outside,
            reduceMotion: true,
            isEnabled: true,
            sourceAtLocation: { _ in outsideResolvedSource }
        )
        let outsideSourceView = UIScrollView(
            frame: CGRect(x: 0, y: 0, width: 320, height: 98)
        )
        outsideSourceView.bounds = CGRect(
            x: 88,
            y: 24,
            width: 320,
            height: 98
        )
        outsideSource.attach(to: outsideSourceView)
        let outsideInteraction = try XCTUnwrap(
            outsideSourceView.interactions
                .compactMap { $0 as? UIDragInteraction }
                .first
        )
        XCTAssertTrue(outsideInteraction.view === outsideSourceView)
        let outsideSession = PhotoReviewDragSessionStub()

        let outsideItems = outsideSource.dragInteraction(
            outsideInteraction,
            itemsForBeginning: outsideSession
        )
        outsideSession.items = outsideItems

        XCTAssertEqual(outsideItems.count, 1)
        XCTAssertEqual(
            outsideItems.first.flatMap {
                PhotoReviewNativeDragContract.photoID(
                    from: $0.itemProvider
                )
            },
            photos[2].id
        )
        outsideSource.dragInteraction(
            outsideInteraction,
            sessionWillBegin: outsideSession
        )
        outside.updateInsertion(
            to: 0,
            store: outsideStore,
            reduceMotion: true
        )
        outsideSource.dragInteraction(
            outsideInteraction,
            session: outsideSession,
            didEndWith: .cancel
        )

        XCTAssertEqual(outsideStore.photos, photos)
        XCTAssertNil(outside.draggedPhotoID)
        XCTAssertNil(outside.insertionIndex)
        XCTAssertEqual(outside.consumeFocusPhotoID(), photos[2].id)
        XCTAssertNil(outside.consumeAnnouncement())

        outsideSource.dragInteraction(
            outsideInteraction,
            session: outsideSession,
            didEndWith: .cancel
        )

        XCTAssertNil(outside.consumeFocusPhotoID())
        XCTAssertNil(outside.consumeAnnouncement())

        let committedStore = PhotoReviewStore(photos: photos)
        let committed = PhotoReviewDragPresentation()
        let committedResolvedSource = PhotoReviewNativeDragSource(
            photoID: photos[2].id,
            thumbnailURL: photos[2].thumbnailURL,
            frame: .zero
        )
        let committedSource = PhotoReviewNativeDragSourceDelegate(
            store: committedStore,
            presentation: committed,
            reduceMotion: true,
            isEnabled: true,
            sourceAtLocation: { _ in committedResolvedSource }
        )
        let committedSourceView = UIScrollView(
            frame: CGRect(x: 0, y: 0, width: 320, height: 98)
        )
        committedSourceView.bounds = CGRect(
            x: 88,
            y: 24,
            width: 320,
            height: 98
        )
        committedSource.attach(to: committedSourceView)
        let committedInteraction = try XCTUnwrap(
            committedSourceView.interactions
                .compactMap { $0 as? UIDragInteraction }
                .first
        )
        XCTAssertTrue(committedInteraction.view === committedSourceView)
        let committedSession = PhotoReviewDragSessionStub()

        let committedItems = committedSource.dragInteraction(
            committedInteraction,
            itemsForBeginning: committedSession
        )
        committedSession.items = committedItems

        XCTAssertEqual(committedItems.count, 1)
        XCTAssertEqual(
            committedItems.first.flatMap {
                PhotoReviewNativeDragContract.photoID(
                    from: $0.itemProvider
                )
            },
            photos[2].id
        )
        committedSource.dragInteraction(
            committedInteraction,
            sessionWillBegin: committedSession
        )
        committed.updateInsertion(
            to: 0,
            store: committedStore,
            reduceMotion: true
        )
        XCTAssertNotNil(
            committed.commit(
                to: 0,
                store: committedStore,
                reduceMotion: true
            )
        )
        committedSource.dragInteraction(
            committedInteraction,
            session: committedSession,
            didEndWith: .move
        )

        XCTAssertEqual(
            committedStore.photos,
            [photos[2], photos[0], photos[1]]
        )
        XCTAssertEqual(committed.consumeFocusPhotoID(), photos[2].id)
        XCTAssertEqual(
            committed.consumeAnnouncement(),
            "Moved to photo 1 of 3. Cover."
        )
        XCTAssertNil(committed.consumeFocusPhotoID())
        XCTAssertNil(committed.consumeAnnouncement())
    }

    func testPhotoReviewNativeDropObservationDistinguishesMissingCallbackFromGuardRejectionAndCommit() throws {
        let photos = makeDragPhotos()
        let store = PhotoReviewStore(photos: photos)
        let presentation = PhotoReviewDragPresentation()
        var observation = PhotoReviewNativeDropObservation()
        let destination = PhotoReviewNativeDropAttachment.Coordinator(
            store: store,
            presentation: presentation,
            reduceMotion: true,
            isEnabled: true,
            destinationIndex: { _ in 0 },
            autoScroll: { _ in },
            observeDrop: { observation.observe($0) }
        )
        let destinationView = UIScrollView(
            frame: CGRect(x: 0, y: 0, width: 320, height: 98)
        )
        destinationView.bounds = CGRect(
            x: 88,
            y: 24,
            width: 320,
            height: 98
        )
        destination.attach(to: destinationView)
        let interaction = try XCTUnwrap(
            destinationView.interactions
                .compactMap { $0 as? UIDropInteraction }
                .first
        )
        let session = PhotoReviewDragSessionStub()
        session.currentLocation = CGPoint(x: 20, y: 49)
        session.items = [
            UIDragItem(
                itemProvider: PhotoReviewNativeDragContract.itemProvider(
                    photoID: photos[2].id
                )
            )
        ]
        func expectedLabel(perform outcome: String) -> String {
            [
                "attached:true",
                "epoch:1",
                "detached:0",
                "detachedEpoch:0",
                "host:88,24,320,98",
                "content:0,0",
                "dragInteractions:0",
                "dropInteractions:1",
                "canHandle:not-called",
                "canHandleCalls:0",
                "photo:none",
                "entered:true",
                "updated:true",
                "perform:\(outcome)"
            ].joined(separator: ",")
        }

        destination.dropInteraction(
            interaction,
            sessionDidEnter: session
        )
        XCTAssertEqual(
            destination.dropInteraction(
                interaction,
                sessionDidUpdate: session
            ).operation,
            .move
        )
        XCTAssertEqual(
            observation.label,
            expectedLabel(perform: "not-called")
        )
        XCTAssertEqual(store.photos, photos)

        destination.dropInteraction(
            interaction,
            performDrop: session
        )
        XCTAssertEqual(
            observation.label,
            expectedLabel(perform: "committed")
        )
        XCTAssertEqual(store.photos, [photos[2], photos[0], photos[1]])

        let rejectedSession = PhotoReviewDragSessionStub()
        rejectedSession.items = [
            UIDragItem(
                itemProvider: PhotoReviewNativeDragContract.itemProvider(
                    photoID: UUID(
                        uuidString: "46000000-0000-4000-8000-000000000099"
                    )!
                )
            )
        ]

        destination.dropInteraction(
            interaction,
            performDrop: rejectedSession
        )
        XCTAssertEqual(
            observation.label,
            expectedLabel(perform: "rejected-admission")
        )
        XCTAssertEqual(store.photos, [photos[2], photos[0], photos[1]])
        XCTAssertNil(presentation.draggedPhotoID)
    }

    func testPhotoReviewNativeDropObservationClassifiesAttachmentAdmissionAndEnterBoundary() throws {
        let photos = makeDragPhotos()
        let store = PhotoReviewStore(photos: photos)
        let presentation = PhotoReviewDragPresentation()
        let frames = [
            photos[0].id: CGRect(x: 0, y: 0, width: 76, height: 98),
            photos[1].id: CGRect(x: 88, y: 0, width: 76, height: 98),
            photos[2].id: CGRect(x: 176, y: 0, width: 76, height: 98)
        ]
        var observation = PhotoReviewNativeDropObservation()
        let source = PhotoReviewNativeDragSourceDelegate(
            store: store,
            presentation: presentation,
            reduceMotion: true,
            isEnabled: true,
            sourceAtLocation: { location in
                PhotoReviewNativeDragSourceGeometry.source(
                    at: location,
                    photos: photos,
                    frames: frames
                )
            }
        )
        let destination = PhotoReviewNativeDropAttachment.Coordinator(
            store: store,
            presentation: presentation,
            reduceMotion: true,
            isEnabled: true,
            destinationIndex: { _ in 0 },
            autoScroll: { _ in },
            observeDrop: { observation.observe($0) }
        )
        let host = makeNativeInteractionHost()
        let sourceAttachment =
            PhotoReviewNativeStripInteractionAttachmentView()
        let destinationAttachment =
            PhotoReviewNativeStripInteractionAttachmentView()
        host.stripContent.addSubview(sourceAttachment)
        host.stripContent.addSubview(destinationAttachment)
        defer {
            sourceAttachment.dismantle()
            destinationAttachment.dismantle()
            host.cleanUp()
        }

        sourceAttachment.update(
            shouldAttach: true,
            attach: source.attach(to:),
            detach: source.detach
        )
        destinationAttachment.update(
            shouldAttach: true,
            attach: destination.attach(to:),
            detach: destination.detach
        )

        XCTAssertTrue(observation.isAttached)
        XCTAssertEqual(observation.attachmentEpoch, 1)
        XCTAssertEqual(observation.detachCount, 0)
        XCTAssertEqual(observation.lastDetachedEpoch, 0)
        XCTAssertEqual(
            observation.hostBounds,
            host.innerHorizontalStrip.bounds
        )
        XCTAssertEqual(
            observation.hostContentSize,
            host.innerHorizontalStrip.contentSize
        )
        XCTAssertEqual(observation.dragInteractionCount, 1)
        XCTAssertEqual(observation.dropInteractionCount, 1)
        XCTAssertEqual(observation.canHandleCallCount, 0)
        XCTAssertEqual(observation.canHandleOutcome, "not-called")
        XCTAssertNil(observation.canHandlePhotoID)

        let sourceInteraction = try XCTUnwrap(
            host.innerHorizontalStrip.interactions
                .compactMap { $0 as? UIDragInteraction }
                .first
        )
        let destinationInteraction = try XCTUnwrap(
            host.innerHorizontalStrip.interactions
                .compactMap { $0 as? UIDropInteraction }
                .first
        )
        let session = PhotoReviewDragSessionStub()
        session.currentLocation = CGPoint(x: 214, y: 49)
        session.items = source.dragInteraction(
            sourceInteraction,
            itemsForBeginning: session
        )

        XCTAssertEqual(
            session.items.first.flatMap {
                PhotoReviewNativeDragContract.photoID(
                    from: $0.itemProvider
                )
            },
            photos[2].id
        )

        let rejectedSession = PhotoReviewDragSessionStub()
        rejectedSession.items = [
            UIDragItem(
                itemProvider: PhotoReviewNativeDragContract.itemProvider(
                    photoID: UUID(
                        uuidString: "46000000-0000-4000-8000-000000000099"
                    )!
                )
            )
        ]
        XCTAssertFalse(
            destination.dropInteraction(
                destinationInteraction,
                canHandle: rejectedSession
            )
        )
        XCTAssertEqual(observation.canHandleCallCount, 1)
        XCTAssertEqual(observation.canHandleOutcome, "rejected")
        XCTAssertNil(observation.canHandlePhotoID)

        XCTAssertTrue(
            destination.dropInteraction(
                destinationInteraction,
                canHandle: session
            )
        )
        XCTAssertEqual(observation.canHandleCallCount, 2)
        XCTAssertEqual(observation.canHandleOutcome, "accepted")
        XCTAssertEqual(observation.canHandlePhotoID, photos[2].id)

        session.currentLocation = CGPoint(x: 38, y: 49)
        destination.dropInteraction(
            destinationInteraction,
            sessionDidEnter: session
        )
        XCTAssertEqual(
            destination.dropInteraction(
                destinationInteraction,
                sessionDidUpdate: session
            ).operation,
            .move
        )
        destination.dropInteraction(
            destinationInteraction,
            performDrop: session
        )

        XCTAssertTrue(observation.didEnter)
        XCTAssertTrue(observation.didUpdate)
        XCTAssertEqual(observation.performDropOutcome, "committed")
        XCTAssertEqual(store.photos, [photos[2], photos[0], photos[1]])

        destinationAttachment.dismantle()

        XCTAssertFalse(observation.isAttached)
        XCTAssertEqual(observation.attachmentEpoch, 1)
        XCTAssertEqual(observation.detachCount, 1)
        XCTAssertEqual(observation.lastDetachedEpoch, 1)

        destinationAttachment.update(
            shouldAttach: true,
            attach: destination.attach(to:),
            detach: destination.detach
        )

        XCTAssertTrue(observation.isAttached)
        XCTAssertEqual(observation.attachmentEpoch, 2)
        XCTAssertEqual(observation.detachCount, 1)
        XCTAssertEqual(observation.lastDetachedEpoch, 1)
        XCTAssertEqual(observation.dragInteractionCount, 1)
        XCTAssertEqual(observation.dropInteractionCount, 1)

        destinationAttachment.dismantle()

        XCTAssertFalse(observation.isAttached)
        XCTAssertEqual(observation.attachmentEpoch, 2)
        XCTAssertEqual(observation.detachCount, 2)
        XCTAssertEqual(observation.lastDetachedEpoch, 2)
    }

    func testPhotoReviewNativeDropAutoScrollRequiresOverflowBeforeInsertionGap() throws {
        let photos = makeDragPhotos()
        func exerciseDrop(
            entryContentWidth: CGFloat,
            updateContentWidth: CGFloat
        ) throws -> (autoScrollCount: Int, order: [StagedCapturePhoto]) {
            let store = PhotoReviewStore(photos: photos)
            let presentation = PhotoReviewDragPresentation()
            var autoScrollCount = 0
            let destination = PhotoReviewNativeDropAttachment.Coordinator(
                store: store,
                presentation: presentation,
                reduceMotion: true,
                isEnabled: true,
                destinationIndex: { _ in 0 },
                autoScroll: { _ in autoScrollCount += 1 }
            )
            let view = UIScrollView(
                frame: CGRect(x: 0, y: 0, width: 400, height: 102)
            )
            view.contentSize = CGSize(width: entryContentWidth, height: 102)
            destination.attach(to: view)
            let interaction = try XCTUnwrap(
                view.interactions
                    .compactMap { $0 as? UIDropInteraction }
                    .first
            )
            let session = PhotoReviewDragSessionStub()
            session.currentLocation = CGPoint(x: 372, y: 51)
            session.items = [
                UIDragItem(
                    itemProvider: PhotoReviewNativeDragContract.itemProvider(
                        photoID: photos[2].id
                    )
                )
            ]

            destination.dropInteraction(interaction, sessionDidEnter: session)
            view.contentSize = CGSize(width: updateContentWidth, height: 102)
            XCTAssertEqual(
                destination.dropInteraction(
                    interaction,
                    sessionDidUpdate: session
                ).operation,
                .move
            )
            destination.dropInteraction(interaction, sessionDidExit: session)
            destination.dropInteraction(interaction, sessionDidEnter: session)
            XCTAssertEqual(
                destination.dropInteraction(
                    interaction,
                    sessionDidUpdate: session
                ).operation,
                .move
            )
            destination.dropInteraction(interaction, performDrop: session)
            return (autoScrollCount, store.photos)
        }

        // The approved 62pt insertion gap turns 340pt into 402pt, but it must
        // not create a scroll session for a strip that fit when the drag entered.
        let fitting = try exerciseDrop(
            entryContentWidth: 340,
            updateContentWidth: 402
        )
        XCTAssertEqual(fitting.autoScrollCount, 0)
        XCTAssertEqual(fitting.order, [photos[2], photos[0], photos[1]])

        let overflowing = try exerciseDrop(
            entryContentWidth: 520,
            updateContentWidth: 582
        )
        XCTAssertEqual(overflowing.autoScrollCount, 2)
        XCTAssertEqual(overflowing.order, [photos[2], photos[0], photos[1]])
    }

    func testPhotoReviewNativeInteractionsFenceTransactionLocksAndResumeWithoutMutation() throws {
        let photos = makeDragPhotos()
        let store = PhotoReviewStore(photos: photos)
        let presentation = PhotoReviewDragPresentation()

        XCTAssertFalse(
            PhotoReviewNativeInteractionPolicy.isEnabled(
                isCommitting: true,
                mutationControlsLocked: false
            )
        )
        XCTAssertFalse(
            PhotoReviewNativeInteractionPolicy.isEnabled(
                isCommitting: false,
                mutationControlsLocked: true
            )
        )
        XCTAssertTrue(
            PhotoReviewNativeInteractionPolicy.isEnabled(
                isCommitting: false,
                mutationControlsLocked: false
            )
        )

        let resolvedSource = PhotoReviewNativeDragSource(
            photoID: photos[2].id,
            thumbnailURL: photos[2].thumbnailURL,
            frame: .zero
        )
        let sourceAtLocation: (CGPoint) -> PhotoReviewNativeDragSource? = {
            _ in resolvedSource
        }
        let source = PhotoReviewNativeDragSourceDelegate(
            store: store,
            presentation: presentation,
            reduceMotion: true,
            isEnabled: false,
            sourceAtLocation: sourceAtLocation
        )
        let host = makeNativeInteractionHost()
        let sourceAttachment =
            PhotoReviewNativeStripInteractionAttachmentView()
        host.stripContent.addSubview(sourceAttachment)
        sourceAttachment.update(
            shouldAttach: true,
            attach: source.attach(to:),
            detach: source.detach
        )
        defer {
            sourceAttachment.dismantle()
            host.cleanUp()
        }
        let sourceInteraction = try XCTUnwrap(
            host.innerHorizontalStrip.interactions
                .compactMap { $0 as? UIDragInteraction }
                .first
        )
        let session = PhotoReviewDragSessionStub()

        XCTAssertTrue(
            source.dragInteraction(
                sourceInteraction,
                itemsForBeginning: session
            ).isEmpty
        )
        XCTAssertEqual(store.photos, photos)
        XCTAssertNil(presentation.draggedPhotoID)

        source.update(
            store: store,
            presentation: presentation,
            reduceMotion: true,
            isEnabled: true,
            sourceAtLocation: sourceAtLocation
        )
        session.items = source.dragInteraction(
            sourceInteraction,
            itemsForBeginning: session
        )
        XCTAssertEqual(session.items.count, 1)
        source.dragInteraction(
            sourceInteraction,
            sessionWillBegin: session
        )
        presentation.updateInsertion(
            to: 0,
            store: store,
            reduceMotion: true
        )

        source.update(
            store: store,
            presentation: presentation,
            reduceMotion: true,
            isEnabled: false,
            sourceAtLocation: sourceAtLocation
        )

        XCTAssertEqual(store.photos, photos)
        XCTAssertNil(presentation.draggedPhotoID)
        XCTAssertNil(presentation.insertionIndex)
        XCTAssertNil(presentation.consumeFocusPhotoID())
        XCTAssertNil(presentation.consumeAnnouncement())

        source.dragInteraction(
            sourceInteraction,
            session: session,
            didEndWith: .cancel
        )
        XCTAssertNil(presentation.consumeFocusPhotoID())
        XCTAssertNil(presentation.consumeAnnouncement())

        let destination = PhotoReviewNativeDropAttachment.Coordinator(
            store: store,
            presentation: presentation,
            reduceMotion: true,
            isEnabled: false,
            destinationIndex: { _ in 0 },
            autoScroll: { _ in }
        )
        let destinationAttachment =
            PhotoReviewNativeStripInteractionAttachmentView()
        host.stripContent.addSubview(destinationAttachment)
        destinationAttachment.update(
            shouldAttach: false,
            attach: destination.attach(to:),
            detach: destination.detach
        )
        defer {
            destinationAttachment.dismantle()
        }
        XCTAssertFalse(destination.isInteractionAttached)

        XCTAssertTrue(
            presentation.begin(photoID: photos[2].id, store: store)
        )
        let lockedInteraction = UIDropInteraction(delegate: destination)
        XCTAssertFalse(
            destination.dropInteraction(
                lockedInteraction,
                canHandle: session
            )
        )
        XCTAssertEqual(
            destination.dropInteraction(
                lockedInteraction,
                sessionDidUpdate: session
            ).operation,
            .cancel
        )
        destination.dropInteraction(
            lockedInteraction,
            performDrop: session
        )
        XCTAssertEqual(store.photos, photos)
        XCTAssertNil(presentation.consumeFocusPhotoID())
        XCTAssertNil(presentation.consumeAnnouncement())

        destination.update(
            store: store,
            presentation: presentation,
            reduceMotion: true,
            isEnabled: false,
            destinationIndex: { _ in 0 },
            autoScroll: { _ in }
        )
        XCTAssertNil(presentation.draggedPhotoID)
        XCTAssertNil(presentation.insertionIndex)
        XCTAssertNil(presentation.consumeFocusPhotoID())
        XCTAssertNil(presentation.consumeAnnouncement())

        source.update(
            store: store,
            presentation: presentation,
            reduceMotion: true,
            isEnabled: true,
            sourceAtLocation: sourceAtLocation
        )
        session.items = source.dragInteraction(
            sourceInteraction,
            itemsForBeginning: session
        )
        source.dragInteraction(
            sourceInteraction,
            sessionWillBegin: session
        )
        destination.update(
            store: store,
            presentation: presentation,
            reduceMotion: true,
            isEnabled: true,
            destinationIndex: { _ in 0 },
            autoScroll: { _ in }
        )
        destinationAttachment.update(
            shouldAttach: true,
            attach: destination.attach(to:),
            detach: destination.detach
        )

        XCTAssertTrue(destination.isInteractionAttached)
        let activeInteraction = try XCTUnwrap(
            host.innerHorizontalStrip.interactions
                .compactMap { $0 as? UIDropInteraction }
                .first
        )
        XCTAssertTrue(
            destination.dropInteraction(
                activeInteraction,
                canHandle: session
            )
        )
        XCTAssertEqual(
            destination.dropInteraction(
                activeInteraction,
                sessionDidUpdate: session
            ).operation,
            .move
        )
        destination.dropInteraction(
            activeInteraction,
            performDrop: session
        )

        XCTAssertEqual(store.photos, [photos[2], photos[0], photos[1]])
        XCTAssertEqual(presentation.consumeFocusPhotoID(), photos[2].id)
        XCTAssertEqual(
            presentation.consumeAnnouncement(),
            "Moved to photo 1 of 3. Cover."
        )
        XCTAssertNil(presentation.consumeFocusPhotoID())
        XCTAssertNil(presentation.consumeAnnouncement())
    }

    func testPhotoReviewDragMovesKnownIdentityFromThirdToCoverWithoutChangingItsValues() {
        let photos = makeDragPhotos()
        let store = PhotoReviewStore(photos: photos)

        XCTAssertEqual(
            store.performDragReorder(photoID: photos[2].id, to: 0),
            PhotoReviewReorderResult(
                photoID: photos[2].id,
                index: 1,
                count: 3,
                announcement: "Moved to photo 1 of 3. Cover."
            )
        )
        XCTAssertEqual(store.photos, [photos[2], photos[0], photos[1]])
        XCTAssertEqual(store.selectedPhotoID, photos[2].id)
        XCTAssertEqual(store.photos.first, photos[2])
    }

    func testPhotoReviewDragCancelAndSamePositionRestoreFocusWithoutMutationOrAnnouncement() {
        let fingerprints = [
            "drag-cancel-a-digest",
            "drag-cancel-b-digest",
            "drag-cancel-c-digest"
        ]
        let photos = [
            makePickerPhoto(
                id: "46000000-0000-4000-8000-000000000011",
                ordinal: 0,
                fingerprints: fingerprints
            ),
            makePickerPhoto(
                id: "46000000-0000-4000-8000-000000000012",
                ordinal: 1,
                fingerprints: fingerprints
            ),
            makePickerPhoto(
                id: "46000000-0000-4000-8000-000000000013",
                ordinal: 2,
                fingerprints: fingerprints
            )
        ]

        let cancelledStore = PhotoReviewStore(photos: photos)
        XCTAssertTrue(cancelledStore.selectPhotoForActions(id: photos[1].id))
        let cancelled = PhotoReviewDragPresentation()

        XCTAssertTrue(
            cancelled.begin(photoID: photos[2].id, store: cancelledStore)
        )
        cancelled.updateInsertion(
            to: 0,
            store: cancelledStore,
            reduceMotion: true
        )
        cancelled.cancel(reduceMotion: true)

        XCTAssertEqual(cancelledStore.photos, photos)
        XCTAssertEqual(cancelledStore.selectedPhotoID, photos[1].id)
        XCTAssertEqual(cancelledStore.actionsPhotoID, photos[1].id)
        XCTAssertEqual(cancelled.consumeFocusPhotoID(), photos[2].id)
        XCTAssertNil(cancelled.consumeFocusPhotoID())
        XCTAssertNil(cancelled.consumeAnnouncement())
        XCTAssertNil(cancelled.draggedPhotoID)
        XCTAssertNil(cancelled.insertionIndex)

        let unchangedStore = PhotoReviewStore(photos: photos)
        let unchanged = PhotoReviewDragPresentation()
        XCTAssertTrue(
            unchanged.begin(photoID: photos[2].id, store: unchangedStore)
        )

        XCTAssertNil(
            unchanged.commit(
                to: 2,
                store: unchangedStore,
                reduceMotion: false
            )
        )
        XCTAssertEqual(unchangedStore.photos, photos)
        XCTAssertEqual(unchangedStore.selectedPhotoID, photos[0].id)
        XCTAssertNil(unchangedStore.actionsPhotoID)
        XCTAssertEqual(unchanged.consumeFocusPhotoID(), photos[2].id)
        XCTAssertNil(unchanged.consumeFocusPhotoID())
        XCTAssertNil(unchanged.consumeAnnouncement())
        XCTAssertNil(unchanged.draggedPhotoID)
        XCTAssertNil(unchanged.insertionIndex)
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
                for: photos[0].id,
                in: availabilityStore
            ).map(\.accessibilityLabel),
            ["Move later"]
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
                for: photos[1].id,
                in: availabilityStore
            ).map(\.accessibilityLabel),
            ["Move earlier", "Move later", "Make cover"]
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
                for: photos[2].id,
                in: availabilityStore
            ).map(\.accessibilityLabel),
            ["Move earlier", "Make cover"]
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

    func testStartingScanRecordsOnceBeforeAnyPhotoIsCaptured() async {
        let camera = TestCaptureCamera(isAvailable: true, authorization: .authorized)
        let funnelAnalytics = FunnelAnalyticsEventSinkSpy()
        let model = CaptureFlowModel(
            camera: camera,
            evaluator: TestFramingEvaluator(observations: []),
            store: TestCaptureStore(),
            funnelAnalytics: funnelAnalytics
        )

        await model.startCamera()
        await model.startCamera()

        XCTAssertEqual(funnelAnalytics.events, [.scanStarted])
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

    /// Builds a capture flow over the durable NativeIntake, the way `AppShellView` does.
    ///
    /// Photo Review commits are gated on the session's intake activation, so a flow built
    /// over the legacy draft store alone exposes no activation and rejects every commit.
    private func waitUntilTrue(
        _ condition: @escaping @MainActor () -> Bool
    ) async {
        for _ in 0..<1_000 where !condition() {
            await Task.yield()
        }
    }

    private func makeIntakeCaptureFlow(root: URL) -> CaptureFlowModel {
        let dependencies = AppDependencies.make(
            // The fixture supplies the stub camera these tests assert `phase` against.
            // Its staged draft is ignored: `restore()` prefers the intake once one exists.
            configuration: LaunchConfiguration.parse(
                arguments: ["--restored-capture-fixture"]
            ),
            nativeIntakeApplicationSupportDirectory: root
        )
        return CaptureFlowModel(
            camera: dependencies.captureCamera,
            evaluator: dependencies.framingEvaluator,
            intake: dependencies.nativeIntake
        )
    }

    private func makeIntakeJPEG(seed: Int) -> Data {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8))
        return renderer.jpegData(withCompressionQuality: 0.9) { context in
            UIColor(
                red: CGFloat(seed % 3) / 2,
                green: CGFloat(seed % 5) / 4,
                blue: CGFloat(seed % 7) / 6,
                alpha: 1
            ).setFill()
            context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
        }
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

    private func makeDragPhotos() -> [StagedCapturePhoto] {
        let fingerprints = [
            "drag-a-digest",
            "drag-b-digest",
            "drag-c-digest"
        ]
        return [
            makePickerPhoto(
                id: "46000000-0000-4000-8000-000000000001",
                ordinal: 0,
                fingerprints: fingerprints
            ),
            makePickerPhoto(
                id: "46000000-0000-4000-8000-000000000002",
                ordinal: 1,
                fingerprints: fingerprints
            ),
            makePickerPhoto(
                id: "46000000-0000-4000-8000-000000000003",
                ordinal: 2,
                fingerprints: fingerprints
            )
        ]
    }

    private struct NativeInteractionHost {
        let window: UIWindow
        let outerScreenScroll: UIScrollView
        let innerHorizontalStrip: UIScrollView
        let stripContent: UIView

        func cleanUp() {
            window.isHidden = true
            withExtendedLifetime(window) {}
        }
    }

    private func makeNativeInteractionHost() -> NativeInteractionHost {
        let window = UIWindow(
            frame: CGRect(x: 0, y: 0, width: 440, height: 956)
        )
        let controller = UIViewController()
        window.rootViewController = controller

        let outerScreenScroll = UIScrollView(frame: window.bounds)
        outerScreenScroll.alwaysBounceVertical = true
        outerScreenScroll.contentSize = CGSize(width: 440, height: 1_200)
        controller.view.addSubview(outerScreenScroll)

        let innerHorizontalStrip = UIScrollView(
            frame: CGRect(x: 16, y: 360, width: 408, height: 104)
        )
        innerHorizontalStrip.alwaysBounceHorizontal = true
        innerHorizontalStrip.contentSize = CGSize(width: 520, height: 104)
        outerScreenScroll.addSubview(innerHorizontalStrip)

        let stripContent = UIView(
            frame: CGRect(x: 0, y: 0, width: 520, height: 104)
        )
        innerHorizontalStrip.addSubview(stripContent)
        window.makeKeyAndVisible()

        return NativeInteractionHost(
            window: window,
            outerScreenScroll: outerScreenScroll,
            innerHorizontalStrip: innerHorizontalStrip,
            stripContent: stripContent
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

    func testBothLibraryIntakeEntryPointsShareEquivalentStagingSemantics() async {
        for entryPoint in LibraryIntakeEntryPoint.all {
            let capacityStore = TestCaptureStore()
            let capacityModel = makeModel(store: capacityStore)

            let capacityAdded = await entryPoint.stage(
                capacityModel,
                (1...7).map { Data([UInt8($0)]) }
            )

            XCTAssertEqual(capacityAdded, 5, entryPoint.name)
            XCTAssertEqual(
                capacityStore.stagedImageData.compactMap(\.first),
                [1, 2, 3, 4, 5],
                entryPoint.name
            )
            XCTAssertEqual(capacityModel.stagedPhotos.count, 5, entryPoint.name)
            XCTAssertFalse(capacityModel.canTakePhoto, entryPoint.name)

            let failureStore = AppendFailingCaptureStore(failingAppendIndex: 1)
            let failureModel = CaptureFlowModel(
                camera: TestCaptureCamera(isAvailable: true, authorization: .authorized),
                evaluator: TestFramingEvaluator(observations: []),
                store: failureStore
            )

            let failureAdded = await entryPoint.stage(
                failureModel,
                [Data([0x01]), Data([0x02]), Data([0x03])]
            )

            XCTAssertEqual(failureAdded, 1, entryPoint.name)
            XCTAssertEqual(failureStore.stagedBytes, [0x01], entryPoint.name)
            XCTAssertEqual(failureStore.attemptedBytes, [0x01, 0x02], entryPoint.name)
            XCTAssertEqual(failureModel.stagedPhotos.count, 1, entryPoint.name)
            XCTAssertEqual(failureModel.phase, .failed, entryPoint.name)

            let sequentialStore = TestCaptureStore()
            let sequentialModel = makeModel(store: sequentialStore)

            let firstAdded = await entryPoint.stage(sequentialModel, [Data([0x01])])
            let secondAdded = await entryPoint.stage(sequentialModel, [Data([0x02])])

            XCTAssertEqual([firstAdded, secondAdded], [1, 1], entryPoint.name)
            XCTAssertEqual(
                sequentialStore.stagedImageData.compactMap(\.first),
                [0x01, 0x02],
                entryPoint.name
            )

            let cancelledStore = TestCaptureStore()
            let cancelledModel = makeModel(store: cancelledStore)
            guard let reservation = cancelledModel.reserveLibraryIntake() else {
                XCTFail("Library intake must reserve before staging. \(entryPoint.name)")
                return
            }
            cancelledModel.cancelLibraryIntake(reservation: reservation)

            let cancelledAdded = await entryPoint.stage(
                cancelledModel,
                [Data([0x01])],
                reservation
            )

            XCTAssertEqual(cancelledAdded, 0, entryPoint.name)
            XCTAssertTrue(cancelledStore.stagedImageData.isEmpty, entryPoint.name)
            XCTAssertTrue(cancelledModel.stagedPhotos.isEmpty, entryPoint.name)
        }
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
                name: "no durable photos",
                accessibility: ScanShutterAccessibility(durablePhotoCount: 0),
                expectedLabel: "Take photo"
            ),
            (
                name: "below the five-photo cap",
                accessibility: ScanShutterAccessibility(durablePhotoCount: 2),
                expectedLabel: "Take photo"
            ),
            (
                name: "at cap",
                accessibility: ScanShutterAccessibility(durablePhotoCount: 5),
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
        let router = AppRouter(initialTab: .trophyWall)

        await AppCaptureHandoffCoordinator.presentCaptureLauncher(
            onboardingModel: onboarding,
            captureFlow: capture,
            router: router
        )

        XCTAssertEqual(router.selectedTab, .scan)
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
                discardRoot: { url in
                    try discardController.discard(url)
                },
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

    func testPhotoReviewAddStagesConfirmedPickerItemsSequentiallyInExactReturnOrder() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let draftStore = LocalCaptureDraftStore(rootDirectory: root)

        let photoA = try await draftStore.append(
            imageData: makeLandscapeImageData(leftColor: .systemRed),
            libraryTransferReceipt: nil
        ).appendedPhoto
        let photoB = try await draftStore.append(
            imageData: makeLandscapeImageData(leftColor: .systemGreen),
            libraryTransferReceipt: nil
        ).appendedPhoto
        let photoC = try await draftStore.append(
            imageData: makeLandscapeImageData(leftColor: .systemTeal),
            libraryTransferReceipt: nil
        ).appendedPhoto

        let reviewStore = PhotoReviewStore(photos: [photoA, photoB, photoC])
        XCTAssertTrue(reviewStore.selectPhotoForActions(id: photoB.id))
        reviewStore.beginPickerRequest(.add)

        let dataD = try makeLandscapeImageData(leftColor: .systemPink)
        let dataE = try makeLandscapeImageData(leftColor: .systemIndigo)
        let durableCountsWhenLoadBegan = DurableCountRecorder()
        let items = [dataD, dataE].map { data in
            TestLibraryPhotoLoader {
                durableCountsWhenLoadBegan.record(
                    try await draftStore.loadPhotos().count
                )
                return data
            }
        }

        let intake = PhotoReviewIntake(draftStore: draftStore)
        let outcome = await intake.apply(items, to: reviewStore)

        // E is only read after D is durable. Loading the whole selection into memory
        // first would put every chosen photo at risk of one late staging failure.
        XCTAssertEqual(durableCountsWhenLoadBegan.counts, [3, 4])

        guard case .applied(let appliedPhotos) = outcome else {
            return XCTFail("Expected the confirmed Add to apply, got \(outcome).")
        }
        XCTAssertEqual(appliedPhotos.count, 2)
        XCTAssertEqual(reviewStore.photos, [photoA, photoB, photoC] + appliedPhotos)
        // Byte-for-byte, not merely same identity: A, B, and C keep their exact URLs,
        // creation dates, and receipts through someone else's transaction.
        XCTAssertEqual(Array(reviewStore.photos.prefix(3)), [photoA, photoB, photoC])
        let durablePhotos = try await draftStore.loadPhotos()
        XCTAssertEqual(durablePhotos, reviewStore.photos)
        XCTAssertNil(reviewStore.activePickerRequest)
        XCTAssertEqual(reviewStore.selectedPhotoID, photoB.id)
        XCTAssertEqual(reviewStore.actionsPhotoID, photoB.id)
    }

    func testPhotoReviewReplaceChangesOnlyItsOrdinalAndLeavesStaleDeliveriesInert() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let draftStore = LocalCaptureDraftStore(rootDirectory: root)

        let photoA = try await draftStore.append(
            imageData: makeLandscapeImageData(leftColor: .systemRed),
            libraryTransferReceipt: nil
        ).appendedPhoto
        let photoB = try await draftStore.append(
            imageData: makeLandscapeImageData(leftColor: .systemGreen),
            libraryTransferReceipt: nil
        ).appendedPhoto
        let photoC = try await draftStore.append(
            imageData: makeLandscapeImageData(leftColor: .systemTeal),
            libraryTransferReceipt: nil
        ).appendedPhoto

        let reviewStore = PhotoReviewStore(photos: [photoA, photoB, photoC])
        XCTAssertTrue(reviewStore.selectPhotoForActions(id: photoB.id))
        let intake = PhotoReviewIntake(draftStore: draftStore)
        let dataF = try makeLandscapeImageData(leftColor: .systemPink)
        let items = [TestLibraryPhotoLoader { dataF }]

        reviewStore.beginPickerRequest(.replace(photoID: photoB.id))
        let outcome = await intake.apply(items, to: reviewStore)

        guard case .applied(let appliedPhotos) = outcome,
              let photoF = appliedPhotos.first else {
            return XCTFail("Expected the confirmed Replace to apply, got \(outcome).")
        }
        XCTAssertEqual(appliedPhotos.count, 1)
        XCTAssertNotEqual(photoF.id, photoB.id)
        XCTAssertEqual(reviewStore.photos, [photoA, photoF, photoC])
        // Ordinals one and three are the seller's other work. A replace is allowed to
        // change exactly the photo the seller opened it on.
        XCTAssertEqual(reviewStore.photos[0], photoA)
        XCTAssertEqual(reviewStore.photos[2], photoC)
        let durablePhotosAfterReplace = try await draftStore.loadPhotos()
        XCTAssertEqual(durablePhotosAfterReplace, [photoA, photoF, photoC])
        XCTAssertNil(reviewStore.activePickerRequest)
        XCTAssertEqual(reviewStore.selectedPhotoID, photoF.id)
        XCTAssertEqual(reviewStore.actionsPhotoID, photoF.id)

        let settledPhotos = reviewStore.photos
        let settledDurablePhotos = durablePhotosAfterReplace

        // A picker that delivers the same confirmed result twice must not stage a second
        // copy: the request it belonged to is already spent.
        let replayOutcome = await intake.apply(items, to: reviewStore)
        let durablePhotosAfterReplay = try await draftStore.loadPhotos()
        XCTAssertEqual(replayOutcome, .inert)
        XCTAssertEqual(reviewStore.photos, settledPhotos)
        XCTAssertEqual(durablePhotosAfterReplay, settledDurablePhotos)

        // Cancelled, so the delivery that arrives afterwards belongs to nothing.
        reviewStore.beginPickerRequest(.replace(photoID: photoF.id))
        XCTAssertEqual(
            reviewStore.cancelPickerRequest(),
            PhotoReviewPickerOpener.replaceButton(photoID: photoF.id)
        )
        let cancelledOutcome = await intake.apply(items, to: reviewStore)
        let durablePhotosAfterCancel = try await draftStore.loadPhotos()
        XCTAssertEqual(cancelledOutcome, .inert)
        XCTAssertEqual(reviewStore.photos, settledPhotos)
        XCTAssertEqual(durablePhotosAfterCancel, settledDurablePhotos)

        // The target left the set while the picker was open, so there is no ordinal to
        // write into and nothing may be staged for it.
        reviewStore.beginPickerRequest(.replace(photoID: photoB.id))
        let mismatchedOutcome = await intake.apply(items, to: reviewStore)
        let durablePhotosAfterMismatch = try await draftStore.loadPhotos()
        XCTAssertEqual(mismatchedOutcome, .inert)
        XCTAssertEqual(reviewStore.photos, settledPhotos)
        XCTAssertEqual(durablePhotosAfterMismatch, settledDurablePhotos)
        XCTAssertNil(reviewStore.activePickerRequest)
    }

    func testPhotoReviewFivePhotoCapacityMakesAddInertAndAnnouncesTheLimitOnce() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let draftStore = LocalCaptureDraftStore(rootDirectory: root)

        var priorPhotos: [StagedCapturePhoto] = []
        for color in [UIColor.systemRed, .systemGreen, .systemTeal, .systemBrown] {
            priorPhotos.append(
                try await draftStore.append(
                    imageData: makeLandscapeImageData(leftColor: color),
                    libraryTransferReceipt: nil
                ).appendedPhoto
            )
        }

        let reviewStore = PhotoReviewStore(photos: priorPhotos)
        let announcer = PhotoReviewCapacityAnnouncer()
        let presentation = PhotoReviewPickerPresentation()

        XCTAssertEqual(PhotoReviewCapacityPolicy.remainingCapacity(photoCount: 4), 1)
        XCTAssertTrue(PhotoReviewCapacityPolicy.isAddEnabled(photoCount: 4))
        XCTAssertEqual(
            PhotoReviewCapacityPolicy.addAccessibilityLabel(photoCount: 4),
            "Add photos"
        )
        XCTAssertNil(announcer.consumeAnnouncement(photoCount: 4))

        XCTAssertTrue(presentation.present(.add, store: reviewStore))
        // The confirmed sheet dismisses first and leaves its request standing, exactly as
        // the live screen does, so the intake still has a transaction to apply.
        XCTAssertNil(
            presentation.dismiss(hasConfirmedSelection: true, store: reviewStore)
        )
        let intake = PhotoReviewIntake(draftStore: draftStore)
        let dataE = try makeLandscapeImageData(leftColor: .systemIndigo)
        let outcome = await intake.apply(
            [TestLibraryPhotoLoader { dataE }],
            to: reviewStore
        )
        guard case .applied = outcome else {
            return XCTFail("Expected the fifth photo to apply, got \(outcome).")
        }
        XCTAssertEqual(reviewStore.photos.count, 5)

        XCTAssertEqual(PhotoReviewCapacityPolicy.remainingCapacity(photoCount: 5), 0)
        XCTAssertFalse(PhotoReviewCapacityPolicy.isAddEnabled(photoCount: 5))
        XCTAssertEqual(
            PhotoReviewCapacityPolicy.addAccessibilityLabel(photoCount: 5),
            "Add photos, unavailable at five photo limit"
        )
        XCTAssertEqual(
            announcer.consumeAnnouncement(photoCount: 5),
            "Five photos added. Five photo limit reached."
        )

        // Rerender and focus movement both re-read the same count. Neither is a new
        // arrival at the limit, so neither may speak again.
        XCTAssertNil(announcer.consumeAnnouncement(photoCount: 5))
        XCTAssertNil(announcer.consumeAnnouncement(photoCount: 5))

        // Repeated activation of the inert Add opens no picker and says nothing.
        for _ in 0..<3 {
            XCTAssertFalse(presentation.present(.add, store: reviewStore))
            XCTAssertNil(reviewStore.activePickerRequest)
            XCTAssertFalse(presentation.isPresented)
            XCTAssertNil(announcer.consumeAnnouncement(photoCount: 5))
        }

        // Replace is not capacity work, so the cap never blocks it.
        let fifthPhotoID = try XCTUnwrap(reviewStore.photos.last?.id)
        XCTAssertTrue(
            presentation.present(.replace(photoID: fifthPhotoID), store: reviewStore)
        )
        XCTAssertEqual(
            presentation.dismiss(hasConfirmedSelection: false, store: reviewStore),
            PhotoReviewPickerOpener.replaceButton(photoID: fifthPhotoID)
        )
        XCTAssertNil(announcer.consumeAnnouncement(photoCount: 5))

        // Leaving capacity re-arms the limit, so the next arrival is a real transition.
        XCTAssertNil(announcer.consumeAnnouncement(photoCount: 4))
        XCTAssertEqual(
            announcer.consumeAnnouncement(photoCount: 5),
            "Five photos added. Five photo limit reached."
        )
        XCTAssertNil(announcer.consumeAnnouncement(photoCount: 5))
    }

    func testPhotoReviewIntakeFailurePreservesDurableValuesAndExposesTypedRecovery() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let draftStore = LocalCaptureDraftStore(rootDirectory: root)

        func ownedArtifactCount() throws -> Int {
            try FileManager.default.contentsOfDirectory(
                at: root,
                includingPropertiesForKeys: nil
            ).filter { $0.pathExtension == "jpg" }.count
        }

        let photoA = try await draftStore.append(
            imageData: makeLandscapeImageData(leftColor: .systemRed),
            libraryTransferReceipt: nil
        ).appendedPhoto
        let photoB = try await draftStore.append(
            imageData: makeLandscapeImageData(leftColor: .systemGreen),
            libraryTransferReceipt: nil
        ).appendedPhoto
        let photoC = try await draftStore.append(
            imageData: makeLandscapeImageData(leftColor: .systemTeal),
            libraryTransferReceipt: nil
        ).appendedPhoto

        let reviewStore = PhotoReviewStore(photos: [photoA, photoB, photoC])
        let intake = PhotoReviewIntake(draftStore: draftStore)
        XCTAssertNil(intake.recovery)

        let dataD = try makeLandscapeImageData(leftColor: .systemPink)
        let dataF = try makeLandscapeImageData(leftColor: .systemYellow)
        reviewStore.beginPickerRequest(.add)
        let partialOutcome = await intake.apply(
            [
                TestLibraryPhotoLoader { dataD },
                TestLibraryPhotoLoader { throw TestCaptureError.failed },
                TestLibraryPhotoLoader { dataF }
            ],
            to: reviewStore
        )

        guard case .applied(let appliedPhotos) = partialOutcome,
              let photoD = appliedPhotos.first else {
            return XCTFail("Expected the durable photo to apply, got \(partialOutcome).")
        }
        XCTAssertEqual(appliedPhotos.count, 1)
        XCTAssertEqual(reviewStore.photos, [photoA, photoB, photoC, photoD])
        let durablePhotosAfterPartial = try await draftStore.loadPhotos()
        XCTAssertEqual(durablePhotosAfterPartial, reviewStore.photos)
        // Nothing half-written survives the failure: four photos, one image and one
        // thumbnail each, and no orphan from the item that could not be read.
        XCTAssertEqual(try ownedArtifactCount(), 8)
        XCTAssertEqual(
            intake.recovery,
            PhotoReviewIntakeRecovery(
                message: "Photo could not be added. Nothing else changed.",
                focus: .addButton
            )
        )
        XCTAssertNil(reviewStore.activePickerRequest)

        let settledPhotos = reviewStore.photos

        // A replace that cannot be read leaves its target exactly where it was, still
        // pointing at bytes that are still on disk.
        reviewStore.beginPickerRequest(.replace(photoID: photoB.id))
        let failedReplaceOutcome = await intake.apply(
            [TestLibraryPhotoLoader { nil }],
            to: reviewStore
        )
        let durablePhotosAfterFailedReplace = try await draftStore.loadPhotos()
        XCTAssertEqual(failedReplaceOutcome, .inert)
        XCTAssertEqual(reviewStore.photos, settledPhotos)
        XCTAssertEqual(durablePhotosAfterFailedReplace, settledPhotos)
        XCTAssertEqual(try ownedArtifactCount(), 8)
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: photoB.photoURL.path)
        )
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: photoB.thumbnailURL.path)
        )
        XCTAssertEqual(
            intake.recovery,
            PhotoReviewIntakeRecovery(
                message: "Photo could not be replaced. Nothing else changed.",
                focus: .replaceButton(photoID: photoB.id)
            )
        )
        XCTAssertNil(reviewStore.activePickerRequest)

        // An Add whose very first item fails changes nothing at all, and its recovery
        // replaces the replace-shaped one still standing rather than accumulating.
        reviewStore.beginPickerRequest(.add)
        let failedAddOutcome = await intake.apply(
            [TestLibraryPhotoLoader { throw TestCaptureError.failed }],
            to: reviewStore
        )
        let durablePhotosAfterFailedAdd = try await draftStore.loadPhotos()
        XCTAssertEqual(failedAddOutcome, .inert)
        XCTAssertEqual(reviewStore.photos, settledPhotos)
        XCTAssertEqual(durablePhotosAfterFailedAdd, settledPhotos)
        XCTAssertEqual(try ownedArtifactCount(), 8)
        XCTAssertEqual(intake.recovery?.focus, PhotoReviewPickerOpener.addButton)
        XCTAssertNil(reviewStore.activePickerRequest)

        // A successful transaction clears a recovery the seller has already seen.
        let dataG = try makeLandscapeImageData(leftColor: .systemPurple)
        reviewStore.beginPickerRequest(.add)
        let recoveredOutcome = await intake.apply(
            [TestLibraryPhotoLoader { dataG }],
            to: reviewStore
        )
        guard case .applied = recoveredOutcome else {
            return XCTFail("Expected the retry to apply, got \(recoveredOutcome).")
        }
        XCTAssertNil(intake.recovery)
        XCTAssertEqual(reviewStore.photos.count, 5)
    }

    func testPhotoReviewIntakeCancelledWhileLoadingLeavesNothingStagedDurably() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let draftStore = LocalCaptureDraftStore(rootDirectory: root)

        func ownedArtifactCount() throws -> Int {
            try FileManager.default.contentsOfDirectory(
                at: root,
                includingPropertiesForKeys: nil
            ).filter { $0.pathExtension == "jpg" }.count
        }

        let photoA = try await draftStore.append(
            imageData: makeLandscapeImageData(leftColor: .systemRed),
            libraryTransferReceipt: nil
        ).appendedPhoto
        let photoB = try await draftStore.append(
            imageData: makeLandscapeImageData(leftColor: .systemGreen),
            libraryTransferReceipt: nil
        ).appendedPhoto

        let reviewStore = PhotoReviewStore(photos: [photoA, photoB])
        let intake = PhotoReviewIntake(draftStore: draftStore)
        let dataD = try makeLandscapeImageData(leftColor: .systemPink)
        let dataE = try makeLandscapeImageData(leftColor: .systemIndigo)

        // The seller cancels while the second chosen photo is still being read. The
        // first one already reached disk, so an inert result has to take it back.
        reviewStore.beginPickerRequest(.add)
        let cancelledAddOutcome = await intake.apply(
            [
                TestLibraryPhotoLoader { dataD },
                TestLibraryPhotoLoader {
                    reviewStore.cancelPickerRequest()
                    return dataE
                }
            ],
            to: reviewStore
        )
        let durablePhotosAfterCancelledAdd = try await draftStore.loadPhotos()
        XCTAssertEqual(cancelledAddOutcome, .inert)
        XCTAssertEqual(reviewStore.photos, [photoA, photoB])
        XCTAssertEqual(durablePhotosAfterCancelledAdd, [photoA, photoB])
        XCTAssertEqual(try ownedArtifactCount(), 4)
        // Cancelling is the seller's own choice, so it is not a failure to report.
        XCTAssertNil(intake.recovery)
        XCTAssertNil(reviewStore.activePickerRequest)

        reviewStore.beginPickerRequest(.replace(photoID: photoB.id))
        let cancelledReplaceOutcome = await intake.apply(
            [
                TestLibraryPhotoLoader {
                    reviewStore.cancelPickerRequest()
                    return dataE
                }
            ],
            to: reviewStore
        )
        let durablePhotosAfterCancelledReplace = try await draftStore.loadPhotos()
        XCTAssertEqual(cancelledReplaceOutcome, .inert)
        XCTAssertEqual(reviewStore.photos, [photoA, photoB])
        XCTAssertEqual(durablePhotosAfterCancelledReplace, [photoA, photoB])
        XCTAssertEqual(try ownedArtifactCount(), 4)
        XCTAssertTrue(FileManager.default.fileExists(atPath: photoB.photoURL.path))
        XCTAssertNil(intake.recovery)
        XCTAssertNil(reviewStore.activePickerRequest)
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

private struct PhotoReviewV14NativeCalibration {
    let name: String
    let dynamicTypeSize: DynamicTypeSize
    let fixedContentShare: CGFloat
    let stickyFooterShare: CGFloat

    static let table = [
        PhotoReviewV14NativeCalibration(
            name: "normal",
            dynamicTypeSize: .large,
            fixedContentShare: 224,
            stickyFooterShare: 82
        ),
        PhotoReviewV14NativeCalibration(
            name: "accessibility",
            dynamicTypeSize: .accessibility2,
            fixedContentShare: 274,
            stickyFooterShare: 85
        )
    ]
    static let exactDeviceRestingAvailableMiddleHeight: CGFloat = 640

    static func value(
        for dynamicTypeSize: DynamicTypeSize
    ) -> PhotoReviewV14NativeCalibration {
        table[dynamicTypeSize.isAccessibilitySize ? 1 : 0]
    }
}

private enum PhotoReviewV14RenderedGeometryContract {
    case packageCanvasTarget
    case semanticDynamicType
}

private enum PhotoReviewV14AddViewportContract {
    case initialViewport
    case horizontalStripContinuation
}

/// Exact package identities for the normal-scale state/adaptive goldens whose
/// declared ±1 point landmark tolerance is meaningful for the native render.
/// The source PNGs include prototype phone chrome (400 x 855 raster for a
/// 390 x 844 canvas) and declare no pixel-error threshold, so their pixels are
/// review evidence rather than an invented cross-medium pass/fail oracle.
private struct PhotoReviewV14ApprovedGolden {
    let file: String
    let sha256: String
    let heroHeight: CGFloat
    let tolerancePoints: CGFloat

    static let comparable = [
        "REV-01-390x844": PhotoReviewV14ApprovedGolden(
            file: "references/goldens/REV-01-390x844.png",
            sha256: "e5838616e6855b3ba7abce84daea4a96abb1cc84f6f427717e933eee928ebef9",
            heroHeight: 406.8125,
            tolerancePoints: 1
        ),
        "REV-02-375x667": PhotoReviewV14ApprovedGolden(
            file: "references/goldens/REV-02-375x667.png",
            sha256: "d745f5d8a32eb3709992a8f3b41693f4909618426d9dc515bdd168fd87732e56",
            heroHeight: 228.359375,
            tolerancePoints: 1
        ),
        "REV-02-375x812": PhotoReviewV14ApprovedGolden(
            file: "references/goldens/REV-02-375x812.png",
            sha256: "d4d9b9723d7fbac5b0f0b5a71099c35dec30402a2c60ffe231ad4c27740d0cfc",
            heroHeight: 374.8125,
            tolerancePoints: 1
        ),
        "REV-02-390x844": PhotoReviewV14ApprovedGolden(
            file: "references/goldens/REV-02-390x844.png",
            sha256: "c9d15282d22c0841ca4468496aeb4ae05f5ffdf0b5fae824c17ebd2f7970ac9c",
            heroHeight: 406.8125,
            tolerancePoints: 1
        ),
        "REV-04-390x844": PhotoReviewV14ApprovedGolden(
            file: "references/goldens/REV-04-390x844.png",
            sha256: "8e0138d3765a1c703282674fcf5caf2013344803a71b6e2e31c6e8d99cde7289",
            heroHeight: 351.171875,
            tolerancePoints: 1
        ),
        "REV-03-390x844": PhotoReviewV14ApprovedGolden(
            file: "references/goldens/REV-03-390x844.png",
            sha256: "2cedcf26c1fe63bbc59eeeeeb0bf529b5aef138f17f6d8124aa89fec97d16b9b",
            heroHeight: 406.8125,
            tolerancePoints: 1
        ),
        "REV-02-393x852": PhotoReviewV14ApprovedGolden(
            file: "references/goldens/REV-02-393x852.png",
            sha256: "6b1b0667175ef1c0c3489bb654799d0d661ce2721aa723767142db2b9dc0b5ce",
            heroHeight: 414.8125,
            tolerancePoints: 1
        ),
        "REV-02-402x874": PhotoReviewV14ApprovedGolden(
            file: "references/goldens/REV-02-402x874.png",
            sha256: "b8cca7cdb374943d78ecbe73024da7b6828e8bdc51198fb7d12ffd1cb6efd5eb",
            heroHeight: 420,
            tolerancePoints: 1
        ),
        "REV-02-414x896": PhotoReviewV14ApprovedGolden(
            file: "references/goldens/REV-02-414x896.png",
            sha256: "f53e6ffcb7c81de1095db9d2c62662ebba2f7dfb2878a87e614a914bc8422591",
            heroHeight: 420,
            tolerancePoints: 1
        ),
        "REV-02-430x932": PhotoReviewV14ApprovedGolden(
            file: "references/goldens/REV-02-430x932.png",
            sha256: "188736f884bb0bc3711a2ae58f5d0f70affa996fc2a915a77b48ecdbb557ba72",
            heroHeight: 420,
            tolerancePoints: 1
        ),
        "REV-02-440x956": PhotoReviewV14ApprovedGolden(
            file: "references/goldens/REV-02-440x956.png",
            sha256: "377f1865ce303dfc37959f363531de7130ad8cf03de516af52a853e2e987f97e",
            heroHeight: 420,
            tolerancePoints: 1
        )
    ]

    static let evidenceOnlyInteractionIDs = [
        "REV-02-375x667-dynamic-type-2x",
        "REV-02-393x852-dynamic-type-2x",
        "keyboard-move-earlier",
        "drag-lift",
        "drag-insertion-gap",
        "drag-drop-complete",
        "reduced-motion-rev-04",
        "ZERO"
    ]
}

private struct PhotoReviewV14LayoutProof {
    let name: String
    var state: PhotoReviewVisualStateID = .resting
    let size: CGSize
    let heroHeight: CGFloat
    var headerHeight: CGFloat = 56
    var dynamicTypeSize: DynamicTypeSize = .large
    var renderedGeometryContract: PhotoReviewV14RenderedGeometryContract =
        .packageCanvasTarget
    let packageCanvas = PhotoReviewV14PackageCanvas.approved

    var renderIdentity: String {
        name
    }

    var addViewportContract: PhotoReviewV14AddViewportContract {
        state == .fivePhotos
            ? .horizontalStripContinuation
            : .initialViewport
    }

    var requiredLandmarks: Set<PhotoReviewLayoutLandmark> {
        var landmarks: Set<PhotoReviewLayoutLandmark> = [
            .header,
            .back,
            .title,
            .countPill,
            .hero,
            .thumbnailStrip,
            .addPhoto,
            .coverPill,
            .voiceNote,
            .footer,
            .startListing
        ]
        if state.presentsActions {
            landmarks.insert(.actionRow)
        }
        return landmarks
    }

    func hasCompleteObservation(
        _ observation: PhotoReviewLayoutObservation
    ) -> Bool {
        requiredLandmarks.allSatisfy {
            !observation.frame(for: $0).isEmpty
        }
    }

    var availableMiddleHeight: CGFloat {
        let calibration = PhotoReviewV14NativeCalibration.value(
            for: dynamicTypeSize
        )
        return size.height
            - packageCanvas.renderPadding.top
            - headerHeight
            - calibration.stickyFooterShare
            - packageCanvas.renderPadding.bottom
    }
}

// The v1.4 visual manifest gives every adaptive artboard the same 54-point
// status region and 99-point footer. This render padding calibrates native
// landmarks to those package canvases; it is not device safe-area evidence.
// Actual safe-area authority remains the exact-device 402x874 UI selector
// testLivePhotoReviewKeepsStartListingStickyBelowTheScrollingReviewContent.
private struct PhotoReviewV14PackageCanvas {
    let statusHeight: CGFloat
    let footerHeight: CGFloat
    let renderPadding: UIEdgeInsets

    static let approved = PhotoReviewV14PackageCanvas(
        statusHeight: 54,
        footerHeight: 99,
        renderPadding: UIEdgeInsets(
            top: 54,
            left: 0,
            bottom: 22,
            right: 0
        )
    )
}

private struct HostedPhotoReviewV14Result {
    let observation: PhotoReviewLayoutObservation?
    let image: UIImage
    let windowBounds: CGRect
    let packageCanvasPadding: UIEdgeInsets
    let windowIdentity: ObjectIdentifier
    let windowWasKey: Bool
}

// PHOTO_REVIEW_V14_RENDER_HOST_BEGIN
@MainActor
private final class PhotoReviewV14RenderHost {
    private let hostingController: UIHostingController<AnyView>
    private let window: UIWindow
    private var observation: PhotoReviewLayoutObservation?
    private var observationRevision = 0
    private var renderGeneration = 0

    init() {
        hostingController = UIHostingController(
            rootView: AnyView(Color.clear.ignoresSafeArea())
        )
        window = UIWindow(frame: .zero)
        window.backgroundColor = .white
        window.rootViewController = hostingController
        hostingController.loadViewIfNeeded()
        hostingController.view.backgroundColor = .white
    }

    var windowIdentity: ObjectIdentifier {
        ObjectIdentifier(window)
    }

    func capture(
        proof: PhotoReviewV14LayoutProof
    ) async -> HostedPhotoReviewV14Result {
        renderGeneration += 1
        let generation = renderGeneration
        observation = nil
        observationRevision = 0

        window.frame = CGRect(origin: .zero, size: proof.size)
        hostingController.rootView = AnyView(
            PhotoReviewFixtureView(
                state: proof.state,
                onLayoutObservation: { [weak self] observation in
                    guard self?.renderGeneration == generation else {
                        return
                    }
                    guard proof.hasCompleteObservation(observation) else {
                        return
                    }
                    self?.observation = observation
                    self?.observationRevision += 1
                }
            )
            .id(proof.renderIdentity)
            .dynamicTypeSize(proof.dynamicTypeSize)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.top, proof.packageCanvas.renderPadding.top)
            .padding(.bottom, proof.packageCanvas.renderPadding.bottom)
            .background(Color.white)
            .ignoresSafeArea()
        )
        hostingController.view.frame = window.bounds
        window.isHidden = false
        defer { window.isHidden = true }

        let requiredQuietLayoutPasses = 2
        var lastObservationRevision = 0
        var quietLayoutPasses = 0
        for _ in 0..<8 {
            await Task.yield()
            window.setNeedsLayout()
            window.layoutIfNeeded()
            hostingController.view.setNeedsLayout()
            hostingController.view.layoutIfNeeded()
            guard observation != nil else {
                continue
            }
            if observationRevision == lastObservationRevision {
                quietLayoutPasses += 1
            } else {
                lastObservationRevision = observationRevision
                quietLayoutPasses = 0
            }
            if quietLayoutPasses >= requiredQuietLayoutPasses {
                break
            }
        }

        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let image = UIGraphicsImageRenderer(
            size: proof.size,
            format: format
        ).image { context in
            window.layer.render(in: context.cgContext)
        }

        return HostedPhotoReviewV14Result(
            observation: observation,
            image: image,
            windowBounds: window.bounds,
            packageCanvasPadding: proof.packageCanvas.renderPadding,
            windowIdentity: ObjectIdentifier(window),
            windowWasKey: window.isKeyWindow
        )
    }

    func tearDown() {
        observation = nil
        window.isHidden = true
        window.rootViewController = nil
    }
}
// PHOTO_REVIEW_V14_RENDER_HOST_END

private extension UIImage {
    func hexColor(
        insideLeadingEdgeOf frame: CGRect,
        inset: CGFloat = 4
    ) -> String? {
        guard let cgImage else {
            return nil
        }
        let scaleX = CGFloat(cgImage.width) / size.width
        let scaleY = CGFloat(cgImage.height) / size.height
        let point = CGPoint(
            x: frame.minX + min(inset, frame.width / 4),
            y: frame.midY
        )
        let pixelRect = CGRect(
            x: floor(point.x * scaleX),
            y: floor(point.y * scaleY),
            width: 1,
            height: 1
        )
        guard let pixelImage = cgImage.cropping(to: pixelRect) else {
            return nil
        }

        var bytes = [UInt8](repeating: 0, count: 4)
        guard let context = CGContext(
            data: &bytes,
            width: 1,
            height: 1,
            bitsPerComponent: 8,
            bytesPerRow: 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo:
                CGBitmapInfo.byteOrder32Big.rawValue
                    | CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            return nil
        }
        context.draw(pixelImage, in: CGRect(x: 0, y: 0, width: 1, height: 1))
        return String(
            format: "#%02X%02X%02X",
            bytes[0],
            bytes[1],
            bytes[2]
        )
    }
}

@MainActor
private final class PhotoReviewDragSessionStub: NSObject,
    UIDragSession,
    UIDropSession {
    var items: [UIDragItem] = []
    var currentLocation = CGPoint.zero
    var allowsMoveOperation = true
    var isRestrictedToDraggingApplication = true
    var localContext: Any?
    let progress = Progress(totalUnitCount: 1)
    var localDragSession: UIDragSession? { self }
    var progressIndicatorStyle: UIDropSessionProgressIndicatorStyle = .default

    func location(in _: UIView) -> CGPoint {
        currentLocation
    }

    func hasItemsConforming(
        toTypeIdentifiers typeIdentifiers: [String]
    ) -> Bool {
        items.contains { item in
            typeIdentifiers.contains { typeIdentifier in
                item.itemProvider.hasItemConformingToTypeIdentifier(
                    typeIdentifier
                )
            }
        }
    }

    func canLoadObjects(
        ofClass _: NSItemProviderReading.Type
    ) -> Bool {
        false
    }

    func loadObjects(
        ofClass _: NSItemProviderReading.Type,
        completion: @escaping ([NSItemProviderReading]) -> Void
    ) -> Progress {
        completion([])
        return Progress(totalUnitCount: 0)
    }
}

@MainActor
private final class PhotoReviewDragAnimatorStub: NSObject, UIDragAnimating {
    private var completions: [(UIViewAnimatingPosition) -> Void] = []

    func addAnimations(_ animations: @escaping () -> Void) {}

    func addCompletion(
        _ completion: @escaping (UIViewAnimatingPosition) -> Void
    ) {
        completions.append(completion)
    }

    func complete(at position: UIViewAnimatingPosition) {
        completions.forEach { $0(position) }
    }
}

private actor ProGateReplayMobileAPIStub: MobileAPIClient {
    private var entitlementCalls = 0

    func getHealth() async throws -> HealthEnvelope {
        throw MobileAPIClientError.httpStatus(500)
    }

    func getSession() async throws -> SessionEnvelope {
        throw MobileAPIClientError.httpStatus(500)
    }

    func getRevenueCatConfiguration() async throws
        -> RevenueCatConfigurationEnvelope {
        RevenueCatConfigurationEnvelope(
            data: .init(
                configured: true,
                appUserId: "fixture-user",
                publicSdkKey: "appl_fixture",
                entitlementId: "pro",
                monthlyProductId: "fixture-monthly",
                offeringId: "current",
                transitionState: .notRequired,
                legacyStripeStatus: nil
            ),
            meta: .init(requestId: "fixture-configuration")
        )
    }

    func getAiItemEntitlement() async throws -> AiItemEntitlementEnvelope {
        entitlementCalls += 1
        let isVerifiedRestore = entitlementCalls > 1
        return AiItemEntitlementEnvelope(
            data: .init(
                billingSource: isVerifiedRestore ? .storeKit : .included,
                status: isVerifiedRestore ? .active : .included,
                remainingItems: isVerifiedRestore ? 7 : 0,
                periodStart: nil,
                periodEnd: nil,
                gracePeriodEnd: nil,
                transitionState: .notRequired,
                legacyStripeStatus: nil
            ),
            meta: .init(requestId: "fixture-entitlement")
        )
    }
}

private actor SuspendedProGateMobileAPIStub: MobileAPIClient {
    private var entitlementStarted = false
    private var entitlementStartWaiters: [CheckedContinuation<Void, Never>] = []
    private var entitlementContinuation:
        CheckedContinuation<AiItemEntitlementEnvelope, Never>?

    func getHealth() async throws -> HealthEnvelope {
        throw MobileAPIClientError.httpStatus(500)
    }

    func getSession() async throws -> SessionEnvelope {
        throw MobileAPIClientError.httpStatus(500)
    }

    func getRevenueCatConfiguration() async throws
        -> RevenueCatConfigurationEnvelope {
        RevenueCatConfigurationEnvelope(
            data: .init(
                configured: true,
                appUserId: "fixture-user",
                publicSdkKey: "appl_fixture",
                entitlementId: "pro",
                monthlyProductId: "fixture-monthly",
                offeringId: "current",
                transitionState: .notRequired,
                legacyStripeStatus: nil
            ),
            meta: .init(requestId: "fixture-configuration")
        )
    }

    func getAiItemEntitlement() async throws -> AiItemEntitlementEnvelope {
        entitlementStarted = true
        entitlementStartWaiters.forEach { $0.resume() }
        entitlementStartWaiters.removeAll()
        return await withCheckedContinuation { continuation in
            entitlementContinuation = continuation
        }
    }

    func waitUntilEntitlementStarts() async {
        guard !entitlementStarted else { return }
        await withCheckedContinuation { continuation in
            entitlementStartWaiters.append(continuation)
        }
    }

    func finishEntitlement() {
        entitlementContinuation?.resume(
            returning: AiItemEntitlementEnvelope(
                data: .init(
                    billingSource: .included,
                    status: .included,
                    remainingItems: 0,
                    periodStart: nil,
                    periodEnd: nil,
                    gracePeriodEnd: nil,
                    transitionState: .notRequired,
                    legacyStripeStatus: nil
                ),
                meta: .init(requestId: "fixture-entitlement")
            )
        )
        entitlementContinuation = nil
    }
}

@MainActor
private final class RetainedSubmissionPhotoReviewScenario {
    let fileManager: FileManager
    let root: URL
    let draftStore: any CaptureDraftStoring
    let displayedPhotos: [StagedCapturePhoto]
    let expectedDurablePhotos: [StagedCapturePhoto]
    let camera: TestCaptureCamera
    let captureFlow: CaptureFlowModel
    let router: AppRouter
    let photoReviewHost: PhotoReviewLiveHost
    let session: PhotoReviewLiveSession
    private(set) var pendingScanFocus: PhotoReviewScanFocus?

    private let routeBeforeSubmission: CaptureBoundaryRequest?
    private let fullScreenBeforeSubmission: AppFullScreen?
    private let scanReturnBeforeSubmission: PhotoReviewScanReturn?
    private let selectedTabBeforeSubmission: PrimaryTab
    private let scanPathBeforeSubmission: [AppRoute]
    private let trophyWallPathBeforeSubmission: [AppRoute]
    private let sessionPhotosBeforeSubmission: [StagedCapturePhoto]
    private let selectedPhotoBeforeSubmission: StagedCapturePhoto.ID?
    private let actionsPhotoBeforeSubmission: StagedCapturePhoto.ID?
    private let pickerRequestBeforeSubmission: PhotoReviewPickerRequest?
    private let stagedPhotosBeforeSubmission: [StagedCapturePhoto]
    private let capturePhaseBeforeSubmission: CapturePhase

    var attemptRoot: URL {
        root.appendingPathComponent("attempt", isDirectory: true)
    }

    static func standard(
        name: String,
        photoData: [Data]
    ) async throws -> RetainedSubmissionPhotoReviewScenario {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory.appendingPathComponent(
            "\(name)-\(UUID().uuidString)",
            isDirectory: true
        )
        let draftStore = LocalCaptureDraftStore(
            rootDirectory: root.appendingPathComponent(
                "draft",
                isDirectory: true
            )
        )
        var photos: [StagedCapturePhoto] = []
        for data in photoData {
            photos.append(
                try await draftStore.append(
                    imageData: data,
                    libraryTransferReceipt: nil
                ).appendedPhoto
            )
        }
        return try await RetainedSubmissionPhotoReviewScenario(
            fileManager: fileManager,
            root: root,
            draftStore: draftStore,
            displayedPhotos: photos,
            expectedDurablePhotos: photos
        )
    }

    init(
        fileManager: FileManager = .default,
        root: URL,
        draftStore: any CaptureDraftStoring,
        displayedPhotos: [StagedCapturePhoto],
        expectedDurablePhotos: [StagedCapturePhoto]
    ) async throws {
        self.fileManager = fileManager
        self.root = root
        self.draftStore = draftStore
        self.displayedPhotos = displayedPhotos
        self.expectedDurablePhotos = expectedDurablePhotos

        let camera = TestCaptureCamera(
            isAvailable: true,
            authorization: .authorized
        )
        self.camera = camera
        let captureFlow = CaptureFlowModel(
            camera: camera,
            evaluator: TestFramingEvaluator(observations: []),
            store: draftStore
        )
        self.captureFlow = captureFlow
        let restoration = await captureFlow.restore()
        XCTAssertEqual(restoration, .stagedPhoto)

        let router = AppRouter(initialFullScreen: .guidedCamera)
        self.router = router
        router.openCaptureBoundary(
            destination: .photoReview,
            photos: displayedPhotos,
            opener: .reviewButton
        )
        routeBeforeSubmission = router.captureBoundaryRequest
        fullScreenBeforeSubmission = router.presentedFullScreen
        scanReturnBeforeSubmission = router.photoReviewScanReturn
        selectedTabBeforeSubmission = router.selectedTab
        scanPathBeforeSubmission =
            router.pathBinding(for: .scan).wrappedValue
        trophyWallPathBeforeSubmission =
            router.pathBinding(for: .trophyWall).wrappedValue

        let photoReviewHost = PhotoReviewLiveHost()
        self.photoReviewHost = photoReviewHost
        XCTAssertTrue(photoReviewHost.consume(routeBeforeSubmission))
        let session = try XCTUnwrap(photoReviewHost.session)
        self.session = session
        let selectedPhoto = try XCTUnwrap(displayedPhotos.last)
        XCTAssertTrue(
            session.store.selectPhotoForActions(id: selectedPhoto.id)
        )
        sessionPhotosBeforeSubmission = session.store.photos
        selectedPhotoBeforeSubmission = session.store.selectedPhotoID
        actionsPhotoBeforeSubmission = session.store.actionsPhotoID
        pickerRequestBeforeSubmission = session.store.activePickerRequest
        stagedPhotosBeforeSubmission = captureFlow.stagedPhotos
        capturePhaseBeforeSubmission = captureFlow.phase
    }

    func perform(submissionHost: ItemRunSubmissionHost) async {
        await AppShellPhotoReviewSubmissionTransaction.perform(
            session: session,
            captureFlow: captureFlow,
            host: photoReviewHost,
            router: router,
            submissionHost: submissionHost,
            setReturnFocus: { self.pendingScanFocus = $0 }
        )
    }

    func perform(
        primaryAction: PhotoReviewBoundaryEvent,
        submissionHost: ItemRunSubmissionHost
    ) async {
        await AppShellPhotoReviewSubmissionTransaction.perform(
            primaryAction: primaryAction,
            session: session,
            captureFlow: captureFlow,
            host: photoReviewHost,
            router: router,
            submissionHost: submissionHost,
            setReturnFocus: { self.pendingScanFocus = $0 }
        )
    }

    func assertPreserved() async throws {
        let durablePhotos = try await draftStore.loadPhotos()
        XCTAssertEqual(
            durablePhotos,
            expectedDurablePhotos
        )
        XCTAssertEqual(captureFlow.stagedPhotos, stagedPhotosBeforeSubmission)
        XCTAssertEqual(captureFlow.phase, capturePhaseBeforeSubmission)
        XCTAssertTrue(photoReviewHost.session === session)
        XCTAssertEqual(session.store.photos, sessionPhotosBeforeSubmission)
        XCTAssertEqual(
            session.store.selectedPhotoID,
            selectedPhotoBeforeSubmission
        )
        XCTAssertEqual(
            session.store.actionsPhotoID,
            actionsPhotoBeforeSubmission
        )
        XCTAssertEqual(
            session.store.activePickerRequest,
            pickerRequestBeforeSubmission
        )
        XCTAssertEqual(router.captureBoundaryRequest, routeBeforeSubmission)
        XCTAssertEqual(
            router.presentedFullScreen,
            fullScreenBeforeSubmission
        )
        XCTAssertEqual(
            router.photoReviewScanReturn,
            scanReturnBeforeSubmission
        )
        XCTAssertEqual(router.selectedTab, selectedTabBeforeSubmission)
        XCTAssertEqual(
            router.pathBinding(for: .scan).wrappedValue,
            scanPathBeforeSubmission
        )
        XCTAssertEqual(
            router.pathBinding(for: .trophyWall).wrappedValue,
            trophyWallPathBeforeSubmission
        )
        XCTAssertNil(pendingScanFocus)
        XCTAssertEqual(camera.startCount, 0)
        XCTAssertEqual(camera.captureCount, 0)
        XCTAssertFalse(photoReviewHost.isCommitting)
        for photo in displayedPhotos {
            XCTAssertTrue(
                fileManager.fileExists(atPath: photo.photoURL.path)
            )
            XCTAssertTrue(
                fileManager.fileExists(atPath: photo.thumbnailURL.path)
            )
        }
    }

    func cleanUp() {
        try? fileManager.removeItem(at: root)
    }
}

@MainActor
private struct RetainedSubmissionPresentationProbe {
    private(set) var announcements: [String] = []
    private(set) var acknowledgedEventIDs: [UUID] = []
    private var effectConsumer = PhotoReviewSubmissionEffectConsumer()

    mutating func assertNewEvent(
        host: ItemRunSubmissionHost,
        retention: ItemRunSubmissionRetention,
        family: PhotoReviewSubmissionRejectionFamily,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws -> (
        eventID: UUID,
        presentation: PhotoReviewSubmissionPresentation
    ) {
        try assertNewEvent(
            host: host,
            retention: retention,
            primaryActionLabel: family.primaryActionLabel,
            primaryActionEvent: {
                family.primaryActionEvent(eventID: $0)
            },
            message: family.message,
            file: file,
            line: line
        )
    }

    mutating func assertNewEvent(
        host: ItemRunSubmissionHost,
        retention: ItemRunSubmissionRetention,
        primaryActionLabel: String,
        primaryActionEvent: (UUID) -> PhotoReviewBoundaryEvent,
        message: String,
        announcement: String? = nil,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws -> (
        eventID: UUID,
        presentation: PhotoReviewSubmissionPresentation
    ) {
        guard case .submissionRejected(
            eventID: let eventID,
            retention: let eventRetention
        )? = host.pendingPresentationEvent else {
            XCTFail(
                "Expected a typed retained-submission presentation event.",
                file: file,
                line: line
            )
            throw RetainedSubmissionProbeError.missingEvent
        }
        XCTAssertEqual(eventRetention, retention, file: file, line: line)

        let presentation = PhotoReviewSubmissionPresentation(host: host)
        XCTAssertEqual(
            presentation.primaryActionLabel,
            primaryActionLabel,
            file: file,
            line: line
        )
        XCTAssertEqual(
            presentation.primaryActionEvent,
            primaryActionEvent(eventID),
            file: file,
            line: line
        )
        XCTAssertEqual(
            presentation.visibleMessage,
            message,
            file: file,
            line: line
        )
        XCTAssertEqual(
            presentation.accessibilityAnnouncement,
            announcement ?? message,
            file: file,
            line: line
        )
        XCTAssertEqual(
            presentation.announcementEvent,
            .submissionRejected(eventID: eventID),
            file: file,
            line: line
        )
        XCTAssertFalse(
            presentation.mutationControlsLocked,
            file: file,
            line: line
        )
        XCTAssertTrue(
            presentation.rendersSubmittedMedia,
            file: file,
            line: line
        )

        let priorAnnouncements = announcements.count
        for _ in 0..<3 {
            effectConsumer.consume(
                PhotoReviewSubmissionPresentation(host: host),
                postAnnouncement: { announcements.append($0) },
                acknowledgePresentation: {
                    acknowledgedEventIDs.append($0)
                }
            )
        }
        XCTAssertEqual(
            announcements.count,
            priorAnnouncements + 1,
            file: file,
            line: line
        )
        XCTAssertEqual(
            announcements.last,
            announcement ?? message,
            file: file,
            line: line
        )
        XCTAssertTrue(
            acknowledgedEventIDs.isEmpty,
            file: file,
            line: line
        )
        return (eventID, presentation)
    }

    mutating func consumeIdle(host: ItemRunSubmissionHost) {
        effectConsumer.consume(
            PhotoReviewSubmissionPresentation(host: host),
            postAnnouncement: { announcements.append($0) },
            acknowledgePresentation: {
                acknowledgedEventIDs.append($0)
            }
        )
    }
}

private enum RetainedSubmissionProbeError: Error {
    case missingEvent
}

private struct CaptureFlowBearerTokenProvider: BearerTokenProviding {
    func bearerToken() async throws -> String {
        "clerk-session-token"
    }
}

private actor SubmissionUnavailableRecordingAttemptStore:
    ItemRunSubmissionAttemptStoring {
    private let base: LocalItemRunSubmissionAttemptStore
    private(set) var saveCount = 0
    private(set) var clearCount = 0

    init(base: LocalItemRunSubmissionAttemptStore) {
        self.base = base
    }

    func loadAttempt() async throws -> ItemRunSubmissionAttempt? {
        try await base.loadAttempt()
    }

    func saveAttempt(_ attempt: ItemRunSubmissionAttempt) async throws {
        try await base.saveAttempt(attempt)
        saveCount += 1
    }

    func clearAttempt(_ attempt: ItemRunSubmissionAttempt) async throws {
        try await base.clearAttempt(attempt)
        clearCount += 1
    }
}

private actor SubmissionUnavailableBearerTokenProvider:
    BearerTokenProviding {
    private(set) var callCount = 0

    func bearerToken() async throws -> String {
        callCount += 1
        return "must-not-be-requested"
    }
}

private actor IntakeUnavailableRecordingDraftStore: CaptureDraftStoring {
    private let base: LocalCaptureDraftStore
    private(set) var replacePhotosCount = 0
    private(set) var discardCount = 0
    private(set) var discardExactlyCount = 0

    init(base: LocalCaptureDraftStore) {
        self.base = base
    }

    func load() async throws -> StagedCapturePhoto? {
        try await base.load()
    }

    func loadPhotos() async throws -> [StagedCapturePhoto] {
        try await base.loadPhotos()
    }

    func stage(
        imageData: Data,
        libraryTransferReceipt: LibraryPhotoTransferReceipt?
    ) async throws -> StagedCapturePhoto {
        try await base.stage(
            imageData: imageData,
            libraryTransferReceipt: libraryTransferReceipt
        )
    }

    func append(
        imageData: Data,
        libraryTransferReceipt: LibraryPhotoTransferReceipt?
    ) async throws -> CaptureDraftAppendResult {
        try await base.append(
            imageData: imageData,
            libraryTransferReceipt: libraryTransferReceipt
        )
    }

    func replace(
        photoID: StagedCapturePhoto.ID,
        imageData: Data,
        libraryTransferReceipt: LibraryPhotoTransferReceipt?
    ) async throws -> CaptureDraftReplaceResult {
        try await base.replace(
            photoID: photoID,
            imageData: imageData,
            libraryTransferReceipt: libraryTransferReceipt
        )
    }

    func replacePhotos(with _: [StagedCapturePhoto]) async throws {
        replacePhotosCount += 1
        throw CaptureDraftStoreError.invalidManifest
    }

    func discard() async throws {
        discardCount += 1
        try await base.discard()
    }

    func discardExactly(_ photos: [StagedCapturePhoto]) async throws -> Bool {
        discardExactlyCount += 1
        return try await base.discardExactly(photos)
    }
}

private final class AttemptPersistenceRecoveryEventRecorder:
    @unchecked Sendable {
    enum Event: Equatable {
        case attemptSaveFailed(UUID)
        case attemptPersisted(UUID)
        case tokenRequested(UUID?)
        case transportStarted(UUID)
    }

    private let lock = NSLock()
    private var recordedEvents: [Event] = []

    var events: [Event] {
        lock.withLock { recordedEvents }
    }

    func record(_ event: Event) {
        lock.withLock { recordedEvents.append(event) }
    }
}

private actor RecoveringItemRunSubmissionAttemptStore:
    ItemRunSubmissionAttemptStoring {
    enum InjectedError: Error {
        case saveFailed
    }

    private let base: LocalItemRunSubmissionAttemptStore
    private let events: AttemptPersistenceRecoveryEventRecorder
    private var failsToSave = true
    private(set) var saveAttempts: [ItemRunSubmissionAttempt] = []
    private(set) var successfulSaveCount = 0
    private(set) var clearCount = 0

    init(
        base: LocalItemRunSubmissionAttemptStore,
        events: AttemptPersistenceRecoveryEventRecorder
    ) {
        self.base = base
        self.events = events
    }

    func recover() {
        failsToSave = false
    }

    func loadAttempt() async throws -> ItemRunSubmissionAttempt? {
        try await base.loadAttempt()
    }

    func saveAttempt(_ attempt: ItemRunSubmissionAttempt) async throws {
        saveAttempts.append(attempt)
        guard !failsToSave else {
            events.record(
                .attemptSaveFailed(attempt.idempotencyKey)
            )
            throw InjectedError.saveFailed
        }
        try await base.saveAttempt(attempt)
        successfulSaveCount += 1
        events.record(.attemptPersisted(attempt.idempotencyKey))
    }

    func clearAttempt(_ attempt: ItemRunSubmissionAttempt) async throws {
        try await base.clearAttempt(attempt)
        clearCount += 1
    }
}

private actor AttemptPersistenceRecordingTokenProvider:
    BearerTokenProviding {
    private let attemptStore: RecoveringItemRunSubmissionAttemptStore
    private let events: AttemptPersistenceRecoveryEventRecorder
    private(set) var callCount = 0

    init(
        attemptStore: RecoveringItemRunSubmissionAttemptStore,
        events: AttemptPersistenceRecoveryEventRecorder
    ) {
        self.attemptStore = attemptStore
        self.events = events
    }

    func bearerToken() async throws -> String {
        callCount += 1
        let attempt = try await attemptStore.loadAttempt()
        events.record(.tokenRequested(attempt?.idempotencyKey))
        return "clerk-session-token"
    }
}

private actor AttemptPersistenceRecordingSubmitter:
    ItemRunSubmitting {
    private let outcome: ItemRunSubmissionTransportOutcome
    private let events: AttemptPersistenceRecoveryEventRecorder
    private(set) var payloads: [ItemRunSubmissionPayload] = []
    private(set) var bearerTokens: [String] = []

    init(
        outcome: ItemRunSubmissionTransportOutcome,
        events: AttemptPersistenceRecoveryEventRecorder
    ) {
        self.outcome = outcome
        self.events = events
    }

    func submit(
        _ payload: ItemRunSubmissionPayload,
        bearerToken: String
    ) async -> ItemRunSubmissionTransportOutcome {
        payloads.append(payload)
        bearerTokens.append(bearerToken)
        events.record(
            .transportStarted(payload.attempt.idempotencyKey)
        )
        return outcome
    }
}

private final class AcceptedSubmissionCompositionRecorder: @unchecked Sendable {
    enum Event: Equatable {
        case canonicalReceiptReturned
        case pendingSavedStateObserved
        case durableIntakeChanged
        case announcementPosted(String)
        case matchingAcknowledgment(UUID)
        case durableExactClearCompleted
        case durableExactClearRefused
        case matchingAttemptRetired
        case inMemoryIntakeDropped
        case cameraPreparationStarted
        case cameraStarted
        case pendingFocusInstalled(PhotoReviewScanFocus)
        case zeroPhotoScanRouteCommitted
        case transactionLockReleased
    }

    private let lock = NSLock()
    private var recordedEvents: [Event] = []

    var events: [Event] {
        lock.lock()
        defer { lock.unlock() }
        return recordedEvents
    }

    func record(_ event: Event) {
        lock.lock()
        recordedEvents.append(event)
        lock.unlock()
    }
}

private actor AcceptedSubmissionRecordingDraftStore: CaptureDraftStoring {
    private let base: LocalCaptureDraftStore
    private let events: AcceptedSubmissionCompositionRecorder

    init(
        base: LocalCaptureDraftStore,
        events: AcceptedSubmissionCompositionRecorder
    ) {
        self.base = base
        self.events = events
    }

    func load() async throws -> StagedCapturePhoto? {
        try await base.load()
    }

    func loadPhotos() async throws -> [StagedCapturePhoto] {
        try await base.loadPhotos()
    }

    func stage(
        imageData: Data,
        libraryTransferReceipt: LibraryPhotoTransferReceipt?
    ) async throws -> StagedCapturePhoto {
        try await base.stage(
            imageData: imageData,
            libraryTransferReceipt: libraryTransferReceipt
        )
    }

    func append(
        imageData: Data,
        libraryTransferReceipt: LibraryPhotoTransferReceipt?
    ) async throws -> CaptureDraftAppendResult {
        let result = try await base.append(
            imageData: imageData,
            libraryTransferReceipt: libraryTransferReceipt
        )
        events.record(.durableIntakeChanged)
        return result
    }

    func replace(
        photoID: StagedCapturePhoto.ID,
        imageData: Data,
        libraryTransferReceipt: LibraryPhotoTransferReceipt?
    ) async throws -> CaptureDraftReplaceResult {
        try await base.replace(
            photoID: photoID,
            imageData: imageData,
            libraryTransferReceipt: libraryTransferReceipt
        )
    }

    func replacePhotos(with photos: [StagedCapturePhoto]) async throws {
        try await base.replacePhotos(with: photos)
    }

    func discard() async throws {
        try await base.discard()
    }

    func discardExactly(_ photos: [StagedCapturePhoto]) async throws -> Bool {
        let didClear = try await base.discardExactly(photos)
        if didClear {
            events.record(.durableExactClearCompleted)
        } else {
            events.record(.durableExactClearRefused)
        }
        return didClear
    }
}

private actor AcceptedSubmissionRecordingAttemptStore:
    ItemRunSubmissionAttemptStoring {
    private(set) var attempt: ItemRunSubmissionAttempt?
    private let events: AcceptedSubmissionCompositionRecorder

    init(events: AcceptedSubmissionCompositionRecorder) {
        self.events = events
    }

    func loadAttempt() async throws -> ItemRunSubmissionAttempt? {
        attempt
    }

    func saveAttempt(_ attempt: ItemRunSubmissionAttempt) async throws {
        self.attempt = attempt
    }

    func clearAttempt(_ attempt: ItemRunSubmissionAttempt) async throws {
        guard self.attempt == attempt else {
            return
        }
        self.attempt = nil
        events.record(.matchingAttemptRetired)
    }
}

private final class AcceptedSubmissionRecordingCamera: CaptureCamera {
    let session = AVCaptureSession()
    let isAvailable = true

    private let events: AcceptedSubmissionCompositionRecorder
    private(set) var startCount = 0
    private(set) var captureCount = 0

    init(events: AcceptedSubmissionCompositionRecorder) {
        self.events = events
    }

    func authorizationStatus() -> CaptureCameraAuthorization {
        events.record(.cameraPreparationStarted)
        return .authorized
    }

    func requestAuthorization() async -> CaptureCameraAuthorization {
        .authorized
    }

    func start(frameHandler: @escaping (CaptureFrame) -> Void) async throws {
        startCount += 1
        events.record(.cameraStarted)
    }

    func stop() {}

    func capturePhoto() async throws -> Data {
        captureCount += 1
        return Data()
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

private struct PhotoOnlyAcceptanceExpiry: Decodable {
    let expiresAt: Date
}

private struct PhotoOnlyAcceptanceDeferredVoice: Decodable {
    let expiresAt: Date
    let voice: NativeIntake.Voice
}

private struct PhotoOnlyAcceptanceBearerTokenProvider:
    BearerTokenProviding {
    let scopeProof: ItemRunSubmissionPrincipalScopeProof

    func bearerToken() async throws -> String {
        "photo-only-acceptance-token"
    }

    func principalBoundBearer() async throws -> PrincipalBoundBearer {
        PrincipalBoundBearer(
            bearerToken: try await bearerToken(),
            scopeProof: scopeProof
        )
    }
}

private func currentSnapshot(
    of intake: NativeIntake
) async throws -> NativeIntake.Snapshot {
    var iterator = await intake.events().makeAsyncIterator()
    while let event = await iterator.next() {
        if case .snapshot(let snapshot) = event {
            return snapshot
        }
    }
    throw CocoaError(.fileReadUnknown)
}

private func photoOnlyAcceptanceVoiceWAV() -> Data {
    Data([
        0x52, 0x49, 0x46, 0x46, 0x26, 0x00, 0x00, 0x00,
        0x57, 0x41, 0x56, 0x45, 0x66, 0x6D, 0x74, 0x20,
        0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
        0x80, 0x3E, 0x00, 0x00, 0x00, 0x7D, 0x00, 0x00,
        0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61,
        0x02, 0x00, 0x00, 0x00, 0x00, 0x00,
    ])
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
            let waiters = pendingCaptureLock.withLock {
                pendingCaptures.append(continuation)
                defer { pendingCaptureWaiters.removeAll() }
                return Array(pendingCaptureWaiters.values)
            }
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
            let isAlreadyPending = pendingCaptureLock.withLock {
                guard pendingCaptures.isEmpty else { return true }
                pendingCaptureWaiters[waiterID] = continuation
                return false
            }
            guard !isAlreadyPending else {
                continuation.resume(returning: true)
                return
            }
            Task<Void, Never> {
                try? await Task.sleep(nanoseconds: timeoutNanoseconds)
                let waiter = self.pendingCaptureLock.withLock {
                    self.pendingCaptureWaiters.removeValue(forKey: waiterID)
                }
                waiter?.resume(returning: false)
            }
        }
    }

    func completePendingCaptures() {
        let captures = pendingCaptureLock.withLock {
            defer { pendingCaptures.removeAll() }
            return pendingCaptures
        }
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

@MainActor
private final class DurableCountRecorder {
    private(set) var counts: [Int] = []

    func record(_ count: Int) {
        counts.append(count)
    }
}

/// The two public library intake entry points, addressed identically so one contract can
/// assert that both share the same staging lifecycle.
private struct LibraryIntakeEntryPoint {
    let name: String
    private let stageSelection: @MainActor ([Data], CaptureFlowModel) async -> Int
    private let stageReservedSelection: @MainActor ([Data], CaptureFlowModel, UUID) async -> Int

    @MainActor
    func stage(_ model: CaptureFlowModel, _ payloads: [Data]) async -> Int {
        await stageSelection(payloads, model)
    }

    @MainActor
    func stage(
        _ model: CaptureFlowModel,
        _ payloads: [Data],
        _ reservation: UUID
    ) async -> Int {
        await stageReservedSelection(payloads, model, reservation)
    }

    static let all: [LibraryIntakeEntryPoint] = [
        LibraryIntakeEntryPoint(
            name: "byte-array intake",
            stageSelection: { payloads, model in
                await model.stageLibraryPhotos(payloads)
            },
            stageReservedSelection: { payloads, model, reservation in
                await model.stageLibraryPhotos(payloads, reservation: reservation)
            }
        ),
        LibraryIntakeEntryPoint(
            name: "sequential loader intake",
            stageSelection: { payloads, model in
                await model.stageLibraryPhotos(payloads.map(makeLoader))
            },
            stageReservedSelection: { payloads, model, reservation in
                await model.stageLibraryPhotos(
                    payloads.map(makeLoader),
                    reservation: reservation
                )
            }
        )
    ]

    @MainActor
    private static func makeLoader(for payload: Data) -> TestLibraryPhotoLoader {
        TestLibraryPhotoLoader { payload }
    }
}

/// Fails the durable append at a chosen position so partial progress and failure handling
/// stay observable through either entry point.
private final class AppendFailingCaptureStore: CaptureDraftStoring {
    private let failingAppendIndex: Int
    private var photos: [StagedCapturePhoto] = []
    private(set) var stagedBytes: [UInt8] = []
    private(set) var attemptedBytes: [UInt8] = []

    init(failingAppendIndex: Int) {
        self.failingAppendIndex = failingAppendIndex
    }

    func load() async throws -> StagedCapturePhoto? { photos.first }
    func loadPhotos() async throws -> [StagedCapturePhoto] { photos }

    func stage(
        imageData: Data,
        libraryTransferReceipt: LibraryPhotoTransferReceipt?
    ) async throws -> StagedCapturePhoto {
        photos = []
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
        attemptedBytes.append(byte)
        guard attemptedBytes.count - 1 != failingAppendIndex else {
            throw TestCaptureError.failed
        }
        stagedBytes.append(byte)
        let index = photos.count
        let photo = StagedCapturePhoto(
            id: UUID(),
            photoURL: URL(fileURLWithPath: "/tmp/append-failing-photo-\(index).jpg"),
            thumbnailURL: URL(fileURLWithPath: "/tmp/append-failing-thumb-\(index).jpg"),
            createdAt: Date(),
            libraryTransferReceipt: libraryTransferReceipt
        )
        photos.append(photo)
        return CaptureDraftAppendResult(appendedPhoto: photo, photos: photos)
    }

    func discard() async throws {
        photos = []
        stagedBytes = []
    }

    func replace(
        photoID: StagedCapturePhoto.ID,
        imageData: Data,
        libraryTransferReceipt: LibraryPhotoTransferReceipt?
    ) async throws -> CaptureDraftReplaceResult {
        throw CaptureDraftStoreError.photoNotStaged
    }

    func replacePhotos(with photos: [StagedCapturePhoto]) async throws {
        self.photos = photos
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

    func replace(
        photoID: StagedCapturePhoto.ID,
        imageData: Data,
        libraryTransferReceipt: LibraryPhotoTransferReceipt?
    ) async throws -> CaptureDraftReplaceResult {
        guard let index = stagedPhotos.firstIndex(where: { $0.id == photoID }) else {
            throw CaptureDraftStoreError.photoNotStaged
        }
        let byte = try XCTUnwrap(imageData.first)
        tracker.recordStage(byte: byte)
        stagedBytes.append(byte)
        let photo = StagedCapturePhoto(
            id: UUID(),
            photoURL: URL(fileURLWithPath: "/tmp/lifetime-photo-replaced-\(index).jpg"),
            thumbnailURL: URL(fileURLWithPath: "/tmp/lifetime-thumb-replaced-\(index).jpg"),
            createdAt: Date(),
            libraryTransferReceipt: libraryTransferReceipt
        )
        stagedPhotos[index] = photo
        return CaptureDraftReplaceResult(replacementPhoto: photo, photos: stagedPhotos)
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
    private let replacePhotosError: Error?

    init(
        staged: StagedCapturePhoto? = nil,
        stageError: Error? = nil,
        loadPhotosError: Error? = nil,
        replacePhotosError: Error? = nil
    ) {
        stagedPhotos = staged.map { [$0] } ?? []
        self.stageError = stageError
        self.loadPhotosError = loadPhotosError
        self.replacePhotosError = replacePhotosError
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

    func replace(
        photoID: StagedCapturePhoto.ID,
        imageData: Data,
        libraryTransferReceipt: LibraryPhotoTransferReceipt?
    ) async throws -> CaptureDraftReplaceResult {
        guard let index = stagedPhotos.firstIndex(where: { $0.id == photoID }) else {
            throw CaptureDraftStoreError.photoNotStaged
        }
        stageCount += 1
        lastStagedImageData = imageData
        stagedImageData.append(imageData)
        if let stageError {
            self.stageError = nil
            throw stageError
        }
        let photo = StagedCapturePhoto(
            id: UUID(),
            photoURL: URL(fileURLWithPath: "/tmp/photo-replaced-\(index).jpg"),
            thumbnailURL: URL(fileURLWithPath: "/tmp/thumb-replaced-\(index).jpg"),
            createdAt: Date(),
            libraryTransferReceipt: libraryTransferReceipt
        )
        stagedPhotos[index] = photo
        return CaptureDraftReplaceResult(replacementPhoto: photo, photos: stagedPhotos)
    }

    func replacePhotos(with photos: [StagedCapturePhoto]) async throws {
        if let replacePhotosError { throw replacePhotosError }
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
