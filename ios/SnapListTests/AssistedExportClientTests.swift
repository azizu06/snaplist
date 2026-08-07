import Foundation
import XCTest
@testable import SnapList

@MainActor
final class AssistedExportClientTests: XCTestCase {
    func testServerEffectivePriceReplacesLocalPriceBeforeAnyHandoffTextIsAvailable() async {
        let store = AssistedExportStore(
            pack: .fixture(effectivePrice: 145),
            service: AssistedExportFixtureService(effectivePrice: 177.77)
        )

        await store.load()

        XCTAssertEqual(store.phase, .ready)
        XCTAssertTrue(
            store.domain.pack.listingText(for: .mercari).hasSuffix("Price: $177.77")
        )
    }

    func testNewerServerRevisionLeavesTheMountedPackStaleAndDoesNotEnableActions() async {
        let newerRevision = UUID(
            uuidString: "58100000-0000-4000-8000-0000000000f3"
        )!
        let store = AssistedExportStore(
            pack: .fixture(),
            service: AssistedExportFixtureService(reviewRevision: newerRevision)
        )

        await store.load()
        store.toggle(.mercari)
        await store.recordHandoff(.copiedListingText, for: .mercari)

        XCTAssertEqual(store.phase, .ready)
        XCTAssertEqual(store.domain.state, .packOutOfDate)
        XCTAssertFalse(store.domain.hasHandedOff(to: .mercari))
    }

    func testTransportUsesTheGuardedPackRevisionsAndRestoresReceipts() async throws {
        let pack = AssistedExportPack.fixture()
        let session = makeSession { request in
            XCTAssertEqual(
                request.value(forHTTPHeaderField: "Authorization"),
                "Bearer assisted-export-token"
            )
            if request.httpMethod == "GET" {
                XCTAssertEqual(
                    URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
                        .queryItems?.first?.value,
                    pack.contentRevision.uuidString.lowercased()
                )
            } else {
                let body = try JSONSerialization.jsonObject(
                    with: Self.bodyData(request)
                ) as! [String: String]
                XCTAssertEqual(body["platform"], "mercari")
                XCTAssertEqual(body["action"], "handoff")
                XCTAssertEqual(
                    UUID(uuidString: body["reviewContentRevision"]!),
                    pack.contentRevision
                )
                XCTAssertEqual(
                    UUID(uuidString: body["reviewRevision"]!),
                    pack.reviewRevision
                )
            }
            return Self.response(for: request, handedOff: request.httpMethod == "POST")
        }
        let client = AssistedExportAPIClient(
            baseURL: URL(string: "https://api.snaplist.dev")!,
            tokenProvider: AssistedExportTestBearer(),
            session: session
        )

        let loaded = try await client.load(pack: pack)
        let handedOff = try await client.perform(
            .handoff,
            destination: .mercari,
            pack: pack
        )

        XCTAssertEqual(loaded.receipts.count, 3)
        XCTAssertEqual(loaded.effectivePrice, 145)
        XCTAssertEqual(loaded.reviewRevision, pack.reviewRevision)
        XCTAssertNil(loaded.receipts[1].handedOffAt)
        XCTAssertNotNil(handedOff.receipts[1].handedOffAt)
        XCTAssertNil(handedOff.receipts[1].sharedAt)
    }

    func testARefusedConfirmNeverPaintsSharedOptimistically() async {
        let store = AssistedExportStore(
            pack: .fixture(),
            service: AssistedExportFailingSharedService()
        )
        await store.load()
        store.toggle(.mercari)
        await store.recordHandoff(.copiedListingText, for: .mercari)
        XCTAssertEqual(
            store.completedAction,
            AssistedExportCompletedAction(
                action: .copiedListingText,
                destination: .mercari
            )
        )
        store.presentConfirmSheet(for: .mercari)

        await store.confirmShared()

        XCTAssertEqual(store.domain.handoff(for: .mercari), .prepared)
        XCTAssertEqual(store.domain.confirmSheet, .mercari)
        XCTAssertEqual(store.actionMessage, AssistedExportCopy.actionFailed)
    }

    func testConfirmSheetCannotDismissWhileSharedReceiptIsInFlight() async {
        let service = AssistedExportSuspendedSharedService()
        let funnelAnalytics = FunnelAnalyticsEventSinkSpy()
        let store = AssistedExportStore(
            pack: .fixture(),
            service: service,
            funnelAnalytics: funnelAnalytics
        )
        await store.load()
        store.toggle(.mercari)
        await store.recordHandoff(.copiedListingText, for: .mercari)
        store.presentConfirmSheet(for: .mercari)

        let confirmation = Task { @MainActor in
            await store.confirmShared()
        }
        await service.waitUntilSharedStarts()

        XCTAssertTrue(store.isWriting)
        store.dismissConfirmSheet()
        XCTAssertEqual(
            store.domain.confirmSheet,
            .mercari,
            "A server-confirmed Shared receipt must not be orphaned by dismissal."
        )

        await service.releaseShared()
        await confirmation.value

        XCTAssertEqual(
            store.domain.handoff(for: .mercari),
            .shared(at: AssistedExportSuspendedSharedService.sharedAt)
        )
        XCTAssertNil(store.domain.confirmSheet)
        XCTAssertEqual(funnelAnalytics.events, [.exportPackShared])
    }

    func testConcurrentSaveRequestsWritePhotosAndReceiptOnce() async {
        let recorder = AssistedExportSaveRecorder()
        let store = AssistedExportStore(
            pack: .fixture(),
            service: AssistedExportFixtureService(didPerform: { action in
                await recorder.recordServerAction(action)
            })
        )
        await store.load()
        store.toggle(.facebookMarketplace)

        let first = Task { @MainActor in
            await store.savePhotos(for: .facebookMarketplace) {
                try await recorder.writePhotos()
            }
        }
        let second = Task { @MainActor in
            await store.savePhotos(for: .facebookMarketplace) {
                try await recorder.writePhotos()
            }
        }
        await first.value
        await second.value

        let counts = await recorder.counts
        XCTAssertEqual(counts.photoWrites, 1)
        XCTAssertEqual(counts.handoffWrites, 1)
        XCTAssertTrue(store.domain.hasHandedOff(to: .facebookMarketplace))
    }

    func testRepeatedSuccessfulSaveDoesNotWriteAnotherReceipt() async {
        let recorder = AssistedExportSaveRecorder()
        let store = AssistedExportStore(
            pack: .fixture(),
            service: AssistedExportFixtureService(didPerform: { action in
                await recorder.recordServerAction(action)
            })
        )
        await store.load()
        store.toggle(.facebookMarketplace)

        await store.savePhotos(for: .facebookMarketplace) {
            try await recorder.writePhotos()
        }
        await store.savePhotos(for: .facebookMarketplace) {
            try await recorder.writePhotos()
        }

        let counts = await recorder.counts
        XCTAssertEqual(counts.photoWrites, 1)
        XCTAssertEqual(counts.handoffWrites, 1)
        XCTAssertTrue(store.domain.hasHandedOff(to: .facebookMarketplace))
    }

    func testRetryAfterReceiptFailureDoesNotWritePhotosAgain() async {
        let recorder = AssistedExportSaveRecorder()
        let service = AssistedExportFlakyHandoffService()
        let store = AssistedExportStore(
            pack: .fixture(),
            service: service
        )
        await store.load()
        store.toggle(.facebookMarketplace)

        await store.savePhotos(for: .facebookMarketplace) {
            try await recorder.writePhotos()
        }
        XCTAssertEqual(store.actionMessage, AssistedExportCopy.actionFailed)

        await store.savePhotos(for: .facebookMarketplace) {
            try await recorder.writePhotos()
        }

        let counts = await recorder.counts
        let attempts = await service.handoffAttempts
        XCTAssertEqual(counts.photoWrites, 1)
        XCTAssertEqual(attempts, 2)
        XCTAssertTrue(store.domain.hasHandedOff(to: .facebookMarketplace))
    }

    func testDelayedHandoffCannotAttachToAReplacementPack() async {
        let recorder = AssistedExportSaveRecorder()
        let original = AssistedExportPack.fixture()
        let replacement = AssistedExportPack.fixture(
            contentRevision: UUID(
                uuidString: "58100000-0000-4000-8000-0000000000f1"
            )!,
            reviewRevision: UUID(
                uuidString: "58100000-0000-4000-8000-0000000000f2"
            )!
        )
        let store = AssistedExportStore(
            pack: original,
            service: AssistedExportFixtureService(didPerform: { action in
                await recorder.recordServerAction(action)
            })
        )
        await store.load()
        await store.updatePack(to: replacement)

        await store.recordHandoff(
            .sharedAnotherWay,
            for: .facebookMarketplace,
            pack: original
        )

        let counts = await recorder.counts
        XCTAssertEqual(counts.handoffWrites, 0)
        XCTAssertFalse(store.domain.hasHandedOff(to: .facebookMarketplace))
    }

    // The issue's public seam: the mounted pack's effective price no longer
    // matches the server's, then delivery is asked for. What leaves the app has
    // to be the listing as it stands now, not the listing as it stood when the
    // screen was drawn — the seller pastes that text into a marketplace form,
    // and a price SnapList has already replaced is a wrong number in a real
    // listing.
    //
    // This models a stale client projection at an *unchanged* `review_revision`
    // — the branch at `AssistedExportStore.swift:347-351`. A seller's own price
    // override advances `review_revision` and is therefore refused as XPORT-05,
    // never repriced; that path is covered by
    // `testNothingIsDeliveredOnceTheListingItselfHasMovedOn`.

    func testDeliveryHandsOverTheServerPriceWhenTheClientProjectionIsStale() async {
        let service = AssistedExportDeliveryService(price: 145)
        let store = AssistedExportStore(
            pack: .fixture(effectivePrice: 145),
            service: service
        )
        await store.load()
        store.toggle(.mercari)

        // The server's effective price moves under the mounted pack while the
        // review revision stays put, so the screen's number is now a stale
        // projection rather than a rejected one.
        await service.reprice(to: 177.77)

        var delivered: String?
        await store.deliver(
            .copiedListingText,
            for: .mercari,
            pack: store.domain.pack
        ) { pack in
            delivered = pack.listingText(for: .mercari)
        }

        XCTAssertEqual(
            delivered,
            "Denim jacket, relaxed fit, size L\n\nA clean seller description."
                + "\n\nPrice: $177.77",
            "The text handed to the device carries the price the server "
                + "resolved at delivery, not the one the screen was showing."
        )
        XCTAssertEqual(store.domain.pack.effectivePrice, 177.77)
        XCTAssertTrue(store.domain.hasHandedOff(to: .mercari))
    }

    func testNothingIsDeliveredOnceTheListingItselfHasMovedOn() async {
        let service = AssistedExportDeliveryService(price: 145)
        let store = AssistedExportStore(
            pack: .fixture(),
            service: service
        )
        await store.load()
        store.toggle(.mercari)

        await service.advanceReviewRevision(
            to: UUID(uuidString: "58100000-0000-4000-8000-0000000000f7")!
        )

        var delivered = false
        await store.deliver(
            .copiedListingText,
            for: .mercari,
            pack: store.domain.pack
        ) { _ in
            delivered = true
        }

        XCTAssertFalse(
            delivered,
            "A pack that no longer describes the listing is not handed over "
                + "at all; the seller is shown XPORT-05 instead."
        )
        XCTAssertEqual(store.domain.state, .packOutOfDate)
        XCTAssertFalse(store.domain.hasHandedOff(to: .mercari))
        let writes = await service.handoffWrites
        XCTAssertEqual(writes, 0)
    }

    func testPreparingAShareSheetRefreshesThePackWithoutWritingASecondReceipt() async {
        let service = AssistedExportDeliveryService(price: 145)
        let store = AssistedExportStore(
            pack: .fixture(effectivePrice: 145),
            service: service
        )
        await store.load()
        store.toggle(.mercari)
        await service.reprice(to: 177.77)

        var built: AssistedExportPack?
        await store.prepareDelivery(pack: store.domain.pack) { pack in
            built = pack
        }

        XCTAssertEqual(built?.effectivePrice, 177.77)
        let writes = await service.handoffWrites
        XCTAssertEqual(
            writes,
            0,
            "The share sheet writes its own receipt when it is on screen; "
                + "building its payload must not write a second one."
        )
        XCTAssertFalse(store.domain.hasHandedOff(to: .mercari))
    }

    // AC6 names native share-sheet cancellation, which is a different behavior
    // from dismissing the confirm sheet. The activity sheet records its handoff
    // from `onPresented` (`AssistedExportView.swift:172-182`), so a seller who
    // opens it and then backs out has done exactly one thing: handed the pack to
    // another app. Cancelling is simply the absence of the later confirm, so the
    // invariant lives in the post-handoff state — presenting a sheet earns the
    // right to be *asked*, never the Shared badge.
    func testCancellingTheNativeShareSheetOffersMarkAsSharedWithoutClaimingShared() async {
        let service = AssistedExportDeliveryService(price: 145)
        let store = AssistedExportStore(pack: .fixture(), service: service)
        await store.load()
        store.toggle(.mercari)

        // The exact sequence the activity sheet performs: build the payload,
        // present it, record the handoff. Nothing confirms afterwards.
        await store.prepareDelivery(pack: store.domain.pack) { _ in }
        await store.recordHandoff(
            .sharedAnotherWay,
            for: .mercari,
            pack: store.domain.pack
        )

        XCTAssertTrue(
            store.domain.offersMarkAsShared(for: .mercari),
            "A presented share sheet earns the right to be asked."
        )
        XCTAssertEqual(
            store.domain.handoff(for: .mercari),
            .prepared,
            "A cancelled share sheet is never a Shared claim."
        )
        XCTAssertEqual(store.domain.state, .handedOff(.mercari))
        XCTAssertNil(store.completedAction)
    }

    // The share sheet's receipt is written after `prepareDelivery` has already
    // returned, and `recordHandoff` refuses outright while `isWriting` is true
    // (`AssistedExportStore.swift:103`). Pin that ordering so a later edit
    // cannot start dropping the receipt silently.
    func testTheShareSheetReceiptIsWrittenOnceThePreparedDeliveryReleasesTheLock() async {
        let service = AssistedExportDeliveryService(price: 145)
        let store = AssistedExportStore(pack: .fixture(), service: service)
        await store.load()
        store.toggle(.mercari)

        await store.prepareDelivery(pack: store.domain.pack) { _ in }

        XCTAssertFalse(store.isWriting)
        let beforeHandoff = await service.handoffWrites
        XCTAssertEqual(beforeHandoff, 0)

        await store.recordHandoff(
            .sharedAnotherWay,
            for: .mercari,
            pack: store.domain.pack
        )

        let writes = await service.handoffWrites
        XCTAssertEqual(
            writes,
            1,
            "A receipt requested the moment the payload is ready must not be "
                + "refused by the delivery lock."
        )
        XCTAssertTrue(store.domain.hasHandedOff(to: .mercari))
    }

    private func makeSession(
        handler: @escaping @Sendable (URLRequest) throws -> (HTTPURLResponse, Data)
    ) -> URLSession {
        AssistedExportURLProtocolStub.handler = handler
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AssistedExportURLProtocolStub.self]
        return URLSession(configuration: configuration)
    }

    nonisolated private static func bodyData(
        _ request: URLRequest
    ) throws -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1_024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        return data
    }

    nonisolated private static func response(
        for request: URLRequest,
        handedOff: Bool
    ) -> (HTTPURLResponse, Data) {
        let handoff = handedOff ? "\"2026-07-25T16:00:00.000Z\"" : "null"
        let json = """
        {"data":{"handoffs":[
          {"platform":"facebook","state":"prepared","handedOffAt":null,"sharedAt":null},
          {"platform":"mercari","state":"prepared","handedOffAt":\(handoff),"sharedAt":null},
          {"platform":"depop","state":"prepared","handedOffAt":null,"sharedAt":null}
        ],"pack":{"effectivePrice":145,"reviewRevision":"58100000-0000-4000-8000-0000000000a0"}},"meta":{"requestId":"test"}}
        """
        return (
            HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!,
            Data(json.utf8)
        )
    }
}

private actor AssistedExportSaveRecorder {
    private var photoWrites = 0
    private var handoffWrites = 0

    var counts: (photoWrites: Int, handoffWrites: Int) {
        (photoWrites, handoffWrites)
    }

    func writePhotos() async throws {
        photoWrites += 1
        try await Task.sleep(for: .milliseconds(100))
    }

    func recordServerAction(_ action: AssistedExportServerAction) {
        if action == .handoff { handoffWrites += 1 }
    }
}

private actor AssistedExportFlakyHandoffService: AssistedExportServing {
    private var attempts = 0
    private var handedOff = false

    var handoffAttempts: Int { attempts }

    func load(pack: AssistedExportPack) async throws -> AssistedExportServerPack {
        response(for: pack)
    }

    func perform(
        _ action: AssistedExportServerAction,
        destination: AssistedExportDestination,
        pack: AssistedExportPack
    ) async throws -> AssistedExportServerPack {
        guard action == .handoff else {
            throw AssistedExportClientError.invalidResponse
        }
        attempts += 1
        if attempts == 1 {
            throw AssistedExportClientError.httpStatus(503)
        }
        handedOff = true
        return response(for: pack)
    }

    private var receipts: [AssistedExportReceipt] {
        AssistedExportDestination.allCases.map {
            AssistedExportReceipt(
                destination: $0,
                handedOffAt: $0 == .facebookMarketplace && handedOff
                    ? Date()
                    : nil,
                sharedAt: nil
            )
        }
    }

    private func response(for pack: AssistedExportPack) -> AssistedExportServerPack {
        AssistedExportServerPack(
            receipts: receipts,
            effectivePrice: pack.effectivePrice,
            reviewRevision: pack.reviewRevision
        )
    }
}

/// A server whose effective price and review revision can move under the
/// mounted screen, the way a seller's own edit does.
private actor AssistedExportDeliveryService: AssistedExportServing {
    private var price: Decimal
    private var reviewRevision: UUID?
    private var handedOff = false
    private var writes = 0

    init(price: Decimal) {
        self.price = price
    }

    var handoffWrites: Int { writes }

    func reprice(to newPrice: Decimal) {
        price = newPrice
    }

    func advanceReviewRevision(to revision: UUID) {
        reviewRevision = revision
    }

    func load(pack: AssistedExportPack) async throws -> AssistedExportServerPack {
        response(for: pack)
    }

    func perform(
        _ action: AssistedExportServerAction,
        destination: AssistedExportDestination,
        pack: AssistedExportPack
    ) async throws -> AssistedExportServerPack {
        guard action == .handoff else {
            throw AssistedExportClientError.invalidResponse
        }
        writes += 1
        handedOff = true
        return response(for: pack)
    }

    private func response(for pack: AssistedExportPack) -> AssistedExportServerPack {
        AssistedExportServerPack(
            receipts: AssistedExportDestination.allCases.map { destination in
                AssistedExportReceipt(
                    destination: destination,
                    handedOffAt: destination == .mercari && handedOff
                        ? Date()
                        : nil,
                    sharedAt: nil
                )
            },
            effectivePrice: price,
            reviewRevision: reviewRevision ?? pack.reviewRevision
        )
    }
}

private struct AssistedExportTestBearer: BearerTokenProviding {
    func bearerToken() async throws -> String { "assisted-export-token" }
}

private actor AssistedExportFailingSharedService: AssistedExportServing {
    private var handedOff = false

    func load(pack: AssistedExportPack) async throws -> AssistedExportServerPack {
        response(for: pack)
    }

    func perform(
        _ action: AssistedExportServerAction,
        destination: AssistedExportDestination,
        pack: AssistedExportPack
    ) async throws -> AssistedExportServerPack {
        if action == .shared { throw AssistedExportClientError.httpStatus(503) }
        handedOff = true
        return response(for: pack)
    }

    private var receipts: [AssistedExportReceipt] {
        AssistedExportDestination.allCases.map {
            AssistedExportReceipt(
                destination: $0,
                handedOffAt: $0 == .mercari && handedOff ? Date() : nil,
                sharedAt: nil
            )
        }
    }

    private func response(for pack: AssistedExportPack) -> AssistedExportServerPack {
        AssistedExportServerPack(
            receipts: receipts,
            effectivePrice: pack.effectivePrice,
            reviewRevision: pack.reviewRevision
        )
    }
}

private actor AssistedExportSuspendedSharedService: AssistedExportServing {
    static let sharedAt = Date(timeIntervalSince1970: 1_753_464_600)

    private var handedOff = false
    private var shared = false
    private var sharedStarted = false
    private var sharedReleased = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiter: CheckedContinuation<Void, Never>?

    func waitUntilSharedStarts() async {
        guard !sharedStarted else { return }
        await withCheckedContinuation { continuation in
            startWaiters.append(continuation)
        }
    }

    func releaseShared() {
        sharedReleased = true
        releaseWaiter?.resume()
        releaseWaiter = nil
    }

    func load(pack: AssistedExportPack) async throws -> AssistedExportServerPack {
        response(for: pack)
    }

    func perform(
        _ action: AssistedExportServerAction,
        destination: AssistedExportDestination,
        pack: AssistedExportPack
    ) async throws -> AssistedExportServerPack {
        switch action {
        case .handoff:
            handedOff = true
        case .shared:
            sharedStarted = true
            startWaiters.forEach { $0.resume() }
            startWaiters.removeAll()
            if !sharedReleased {
                await withCheckedContinuation { continuation in
                    releaseWaiter = continuation
                }
            }
            shared = true
        case .undo:
            shared = false
        }
        return response(for: pack)
    }

    private var receipts: [AssistedExportReceipt] {
        AssistedExportDestination.allCases.map {
            AssistedExportReceipt(
                destination: $0,
                handedOffAt: $0 == .mercari && handedOff ? Self.sharedAt : nil,
                sharedAt: $0 == .mercari && shared ? Self.sharedAt : nil
            )
        }
    }

    private func response(for pack: AssistedExportPack) -> AssistedExportServerPack {
        AssistedExportServerPack(
            receipts: receipts,
            effectivePrice: pack.effectivePrice,
            reviewRevision: pack.reviewRevision
        )
    }
}

private final class AssistedExportURLProtocolStub:
    URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler:
        (@Sendable (URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }
    override func startLoading() {
        do {
            let (response, data) = try Self.handler!(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }
    override func stopLoading() {}
}
