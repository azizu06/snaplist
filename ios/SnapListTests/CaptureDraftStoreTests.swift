import ImageIO
import UIKit
import XCTest
@testable import SnapList

final class CaptureDraftStoreTests: XCTestCase {
    func testStagePersistsOnePhotoAndCompositionMatchingThumbnail() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let store = LocalCaptureDraftStore(rootDirectory: root)
        let imageData = try makeLandscapeImageData()

        let staged = try await store.stage(imageData: imageData)
        let restored = try await store.load()

        XCTAssertEqual(restored, staged)
        XCTAssertTrue(FileManager.default.fileExists(atPath: staged.photoURL.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: staged.thumbnailURL.path))

        let originalSize = try imageSize(at: staged.photoURL)
        let thumbnailSize = try imageSize(at: staged.thumbnailURL)
        XCTAssertEqual(originalSize.width / originalSize.height, 2, accuracy: 0.01)
        XCTAssertEqual(thumbnailSize.width / thumbnailSize.height, 2, accuracy: 0.01)
        XCTAssertLessThanOrEqual(thumbnailSize.width, 240)

        try? FileManager.default.removeItem(at: root)
    }

    func testStageProtectsOwnedArtifactsAndExcludesOnlyOwnedDirectoryFromBackup() async throws {
        let fileManager = FileManager.default
        let parent = fileManager.temporaryDirectory.appendingPathComponent(
            "snaplist-capture-store-\(UUID().uuidString)",
            isDirectory: true
        )
        let root = parent.appendingPathComponent("CaptureDraft", isDirectory: true)
        let outsideURL = parent.appendingPathComponent("outside.txt")
        let writeRecorder = ProtectedWriteRecorder()
        defer { try? fileManager.removeItem(at: parent) }

        try fileManager.createDirectory(at: parent, withIntermediateDirectories: true)
        try Data([0x01]).write(to: outsideURL, options: .atomic)
        let parentBackupBefore = try parent.resourceValues(
            forKeys: [.isExcludedFromBackupKey]
        ).isExcludedFromBackup
        let outsideBackupBefore = try outsideURL.resourceValues(
            forKeys: [.isExcludedFromBackupKey]
        ).isExcludedFromBackup
        let outsideProtectionBefore = try fileProtection(at: outsideURL)

        let store = LocalCaptureDraftStore(
            rootDirectory: root,
            fileManager: fileManager,
            writeData: { data, url, options in
                try writeRecorder.write(data: data, url: url, options: options)
            }
        )
        let staged = try await store.stage(imageData: makeLandscapeImageData())
        let manifestURL = root.appendingPathComponent("manifest.json")

        XCTAssertEqual(LocalCaptureDraftStore.fileProtection, .complete)
        XCTAssertTrue(
            LocalCaptureDraftStore.writingOptions.contains(.completeFileProtection)
        )
        let protectedWrites = writeRecorder.snapshot
        XCTAssertEqual(protectedWrites.count, 3)
        XCTAssertEqual(
            Set(protectedWrites.map(\.url)),
            Set([staged.photoURL, staged.thumbnailURL, manifestURL])
        )
        XCTAssertTrue(
            protectedWrites.allSatisfy { $0.options.contains(.completeFileProtection) }
        )
        for protectedURL in [staged.photoURL, staged.thumbnailURL, manifestURL] {
            XCTAssertTrue(fileManager.fileExists(atPath: protectedURL.path))
            if let observedProtection = try fileProtection(at: protectedURL) {
                XCTAssertEqual(observedProtection, .complete)
            }
        }
        XCTAssertEqual(
            try root.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup,
            true
        )
        XCTAssertEqual(
            try parent.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup,
            parentBackupBefore
        )
        XCTAssertEqual(
            try outsideURL.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup,
            outsideBackupBefore
        )
        XCTAssertEqual(try fileProtection(at: outsideURL), outsideProtectionBefore)
    }

    func testStagingAgainReplacesTheSingleDraftInsteadOfAppending() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let store = LocalCaptureDraftStore(rootDirectory: root)

        let first = try await store.stage(imageData: makeLandscapeImageData())
        let second = try await store.stage(imageData: makeLandscapeImageData())
        let restored = try await store.load()

        XCTAssertNotEqual(first.id, second.id)
        XCTAssertEqual(restored, second)
        let jpgFiles = try FileManager.default.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: nil
        ).filter { $0.pathExtension == "jpg" }
        XCTAssertEqual(jpgFiles.count, 2)

        try? FileManager.default.removeItem(at: root)
    }

    func testRestoreSurvivesAnApplicationContainerPathChange() async throws {
        let firstRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let relocatedRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let originalStore = LocalCaptureDraftStore(rootDirectory: firstRoot)
        let staged = try await originalStore.stage(imageData: makeLandscapeImageData())

        try FileManager.default.copyItem(at: firstRoot, to: relocatedRoot)
        try FileManager.default.removeItem(at: firstRoot)

        let relocatedStore = LocalCaptureDraftStore(rootDirectory: relocatedRoot)
        let loaded = try await relocatedStore.load()
        let restored = try XCTUnwrap(loaded)
        XCTAssertEqual(restored.id, staged.id)
        XCTAssertEqual(restored.photoURL.deletingLastPathComponent(), relocatedRoot)
        XCTAssertEqual(restored.thumbnailURL.deletingLastPathComponent(), relocatedRoot)

        try? FileManager.default.removeItem(at: relocatedRoot)
    }

    func testRestoreKeepsDraftUntilTheTwentyFourHourBoundary() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let createdAt = Date(timeIntervalSinceReferenceDate: 1_000_000)
        let store = LocalCaptureDraftStore(rootDirectory: root, now: { createdAt })
        let staged = try await store.stage(imageData: makeLandscapeImageData())

        let beforeExpiry = LocalCaptureDraftStore(
            rootDirectory: root,
            now: { createdAt.addingTimeInterval((24 * 60 * 60) - 1) }
        )

        let restored = try await beforeExpiry.load()
        XCTAssertEqual(restored, staged)

        try? FileManager.default.removeItem(at: root)
    }

    func testRestorePurgesDraftAtTheTwentyFourHourBoundary() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let createdAt = Date(timeIntervalSinceReferenceDate: 1_000_000)
        let store = LocalCaptureDraftStore(rootDirectory: root, now: { createdAt })
        let staged = try await store.stage(imageData: makeLandscapeImageData())
        let manifestURL = root.appendingPathComponent("manifest.json")

        let expiredStore = LocalCaptureDraftStore(
            rootDirectory: root,
            now: { createdAt.addingTimeInterval(24 * 60 * 60) }
        )

        let restored = try await expiredStore.load()
        XCTAssertNil(restored)
        XCTAssertFalse(FileManager.default.fileExists(atPath: staged.photoURL.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: staged.thumbnailURL.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: manifestURL.path))

        try? FileManager.default.removeItem(at: root)
    }

    func testExpiredManifestCannotPurgePathsOutsideTheOwnedRoot() async throws {
        let fileManager = FileManager.default
        let parent = fileManager.temporaryDirectory.appendingPathComponent(
            "snaplist-capture-confinement-\(UUID().uuidString)",
            isDirectory: true
        )
        let root = parent.appendingPathComponent("CaptureDraft", isDirectory: true)
        let outsidePhotoURL = parent.appendingPathComponent("outside-photo.jpg")
        let outsideThumbnailURL = parent.appendingPathComponent("outside-thumbnail.jpg")
        let createdAt = Date(timeIntervalSinceReferenceDate: 1_000_000)
        defer { try? fileManager.removeItem(at: parent) }

        try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
        try Data([0x01]).write(to: outsidePhotoURL)
        try Data([0x02]).write(to: outsideThumbnailURL)
        let staged = StagedCapturePhoto(
            id: UUID(),
            photoURL: outsidePhotoURL,
            thumbnailURL: outsideThumbnailURL,
            createdAt: createdAt
        )
        let manifestURL = root.appendingPathComponent("manifest.json")
        try JSONEncoder().encode(staged).write(to: manifestURL)
        let store = LocalCaptureDraftStore(
            rootDirectory: root,
            fileManager: fileManager,
            now: { createdAt.addingTimeInterval(24 * 60 * 60) }
        )

        let restored = try await store.load()
        XCTAssertNil(restored)
        XCTAssertTrue(fileManager.fileExists(atPath: outsidePhotoURL.path))
        XCTAssertTrue(fileManager.fileExists(atPath: outsideThumbnailURL.path))
        XCTAssertFalse(fileManager.fileExists(atPath: manifestURL.path))
    }

    private func makeLandscapeImageData() throws -> Data {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 400, height: 200))
        return try XCTUnwrap(renderer.jpegData(withCompressionQuality: 0.95) { context in
            UIColor.systemBlue.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 200, height: 200))
            UIColor.systemOrange.setFill()
            context.fill(CGRect(x: 200, y: 0, width: 200, height: 200))
        })
    }

    private func imageSize(at url: URL) throws -> CGSize {
        let source = try XCTUnwrap(CGImageSourceCreateWithURL(url as CFURL, nil))
        let properties = try XCTUnwrap(
            CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        )
        let width = try XCTUnwrap(properties[kCGImagePropertyPixelWidth] as? CGFloat)
        let height = try XCTUnwrap(properties[kCGImagePropertyPixelHeight] as? CGFloat)
        return CGSize(width: width, height: height)
    }

    private func fileProtection(at url: URL) throws -> FileProtectionType? {
        try FileManager.default.attributesOfItem(atPath: url.path)[.protectionKey]
            as? FileProtectionType
    }
}

private final class ProtectedWriteRecorder: @unchecked Sendable {
    struct Write {
        let url: URL
        let options: Data.WritingOptions
    }

    private let lock = NSLock()
    private var writes: [Write] = []

    var snapshot: [Write] {
        lock.withLock { writes }
    }

    func write(data: Data, url: URL, options: Data.WritingOptions) throws {
        lock.withLock {
            writes.append(Write(url: url, options: options))
        }
        try data.write(to: url, options: options)
    }
}
