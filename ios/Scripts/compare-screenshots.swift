#!/usr/bin/env swift

import AppKit
import Foundation

enum ComparisonError: LocalizedError {
    case invalidArguments
    case unreadableImage(String)
    case dimensionsDoNotMatch(reference: CGSize, actual: CGSize)
    case bitmapCreationFailed
    case pngEncodingFailed(String)

    var errorDescription: String? {
        switch self {
        case .invalidArguments:
            "Usage: compare-screenshots.swift <reference.png> <actual.png> <side-by-side.png> <overlay.png>"
        case .unreadableImage(let path):
            "Could not decode image at \(path)."
        case .dimensionsDoNotMatch(let reference, let actual):
            "Image dimensions differ: reference \(reference), actual \(actual)."
        case .bitmapCreationFailed:
            "Could not allocate a bitmap context."
        case .pngEncodingFailed(let path):
            "Could not encode PNG at \(path)."
        }
    }
}

func makeBitmap(width: Int, height: Int) throws -> NSBitmapImageRep {
    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: width,
        pixelsHigh: height,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ) else {
        throw ComparisonError.bitmapCreationFailed
    }
    return bitmap
}

func normalizedBitmap(at path: String) throws -> NSBitmapImageRep {
    guard let image = NSImage(contentsOfFile: path),
          let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        throw ComparisonError.unreadableImage(path)
    }

    let bitmap = try makeBitmap(width: cgImage.width, height: cgImage.height)
    NSGraphicsContext.saveGraphicsState()
    defer { NSGraphicsContext.restoreGraphicsState() }
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    NSGraphicsContext.current?.cgContext.draw(
        cgImage,
        in: CGRect(x: 0, y: 0, width: cgImage.width, height: cgImage.height)
    )
    return bitmap
}

func render(
    width: Int,
    height: Int,
    draw: (CGContext) -> Void
) throws -> NSBitmapImageRep {
    let bitmap = try makeBitmap(width: width, height: height)
    NSGraphicsContext.saveGraphicsState()
    defer { NSGraphicsContext.restoreGraphicsState() }
    guard let context = NSGraphicsContext(bitmapImageRep: bitmap)?.cgContext else {
        throw ComparisonError.bitmapCreationFailed
    }
    NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
    context.setFillColor(NSColor.white.cgColor)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    draw(context)
    return bitmap
}

func writePNG(_ bitmap: NSBitmapImageRep, to path: String) throws {
    guard let data = bitmap.representation(using: .png, properties: [:]) else {
        throw ComparisonError.pngEncodingFailed(path)
    }
    try data.write(to: URL(fileURLWithPath: path), options: .atomic)
}

func meanAbsoluteError(_ reference: NSBitmapImageRep, _ actual: NSBitmapImageRep) -> Double {
    guard let referenceBytes = reference.bitmapData,
          let actualBytes = actual.bitmapData else {
        return .nan
    }

    var totalDifference = 0.0
    for y in 0..<reference.pixelsHigh {
        let referenceRow = referenceBytes.advanced(by: y * reference.bytesPerRow)
        let actualRow = actualBytes.advanced(by: y * actual.bytesPerRow)
        for x in 0..<reference.pixelsWide {
            for channel in 0..<3 {
                let offset = x * 4 + channel
                totalDifference += Double(abs(Int(referenceRow[offset]) - Int(actualRow[offset])))
            }
        }
    }

    let maximumDifference = Double(reference.pixelsWide * reference.pixelsHigh * 3 * 255)
    return totalDifference / maximumDifference
}

do {
    guard CommandLine.arguments.count == 5 else {
        throw ComparisonError.invalidArguments
    }

    let reference = try normalizedBitmap(at: CommandLine.arguments[1])
    let actual = try normalizedBitmap(at: CommandLine.arguments[2])
    guard reference.size == actual.size else {
        throw ComparisonError.dimensionsDoNotMatch(reference: reference.size, actual: actual.size)
    }

    let width = reference.pixelsWide
    let height = reference.pixelsHigh
    guard let referenceImage = reference.cgImage, let actualImage = actual.cgImage else {
        throw ComparisonError.bitmapCreationFailed
    }

    let sideBySide = try render(width: width * 2, height: height) { context in
        context.draw(referenceImage, in: CGRect(x: 0, y: 0, width: width, height: height))
        context.draw(actualImage, in: CGRect(x: width, y: 0, width: width, height: height))
    }
    try writePNG(sideBySide, to: CommandLine.arguments[3])

    let overlay = try render(width: width, height: height) { context in
        context.draw(referenceImage, in: CGRect(x: 0, y: 0, width: width, height: height))
        context.setAlpha(0.5)
        context.draw(actualImage, in: CGRect(x: 0, y: 0, width: width, height: height))
    }
    try writePNG(overlay, to: CommandLine.arguments[4])

    print(String(format: "Normalized mean absolute pixel error: %.6f", meanAbsoluteError(reference, actual)))
} catch {
    fputs("\(error.localizedDescription)\n", stderr)
    exit(1)
}
