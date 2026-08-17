import Foundation
import XCTest
@testable import SnapList

/// Behavior of the push permission state machine (issue #890).
///
/// The product rule this file exists to hold is a promise to the seller: the
/// app asks for notifications once, after their first item is submitted, and if
/// they say no it never asks again from inside the app. Everything here runs
/// against the pure domain — no real notification centre, no real APNs — so the
/// promise is provable without a device and without a prompt anyone has to
/// dismiss by hand.
final class PushRegistrationTests: XCTestCase {
    func testAsksOnceAfterTheFirstItemIsSubmitted() {
        var progress = PushRegistrationProgress()

        XCTAssertEqual(progress.advance(for: .itemSubmitted), .askOnce)
        XCTAssertEqual(progress.decision, .notYetAsked)
    }

    func testNothingAsksBeforeAnItemIsSubmitted() {
        var progress = PushRegistrationProgress()

        // Launch, sign-in, browsing: none of it is a moment that earned the
        // prompt, and the domain has no event that could produce one.
        XCTAssertEqual(progress.decision, .notYetAsked)
        XCTAssertEqual(progress.advance(for: .sellerAnswered(granted: false)), .doNothing)
    }

    func testAllowingRegistersTheDeviceAndRecordsTheDecision() {
        var progress = PushRegistrationProgress()
        _ = progress.advance(for: .itemSubmitted)

        XCTAssertEqual(
            progress.advance(for: .sellerAnswered(granted: true)),
            .registerWithAPNs
        )
        XCTAssertEqual(progress.decision, .allowed)
    }

    func testRefusingIsRecordedAndNeverAsksAgain() {
        var progress = PushRegistrationProgress()
        _ = progress.advance(for: .itemSubmitted)

        XCTAssertEqual(
            progress.advance(for: .sellerAnswered(granted: false)),
            .doNothing
        )
        XCTAssertEqual(progress.decision, .refused)

        // Every later submission, for the life of the install. The Settings row
        // is the only way back, and this app never asks again.
        for _ in 0..<3 {
            XCTAssertEqual(progress.advance(for: .itemSubmitted), .doNothing)
            XCTAssertEqual(progress.decision, .refused)
        }
    }

    func testLaterSubmissionsReRegisterWithoutAskingAgain() {
        var progress = PushRegistrationProgress()
        _ = progress.advance(for: .itemSubmitted)
        _ = progress.advance(for: .sellerAnswered(granted: true))

        // APNs reissues a token whenever it likes, so a seller who already said
        // yes re-registers on later submissions. That is a silent write, never
        // a second prompt.
        XCTAssertEqual(progress.advance(for: .itemSubmitted), .registerWithAPNs)
        XCTAssertEqual(progress.decision, .allowed)
    }

    func testAnAnswerThatArrivesTwiceDoesNotReopenTheQuestion() {
        var progress = PushRegistrationProgress()
        _ = progress.advance(for: .itemSubmitted)
        _ = progress.advance(for: .sellerAnswered(granted: false))

        // A duplicate callback must not turn a refusal into a fresh ask.
        XCTAssertEqual(
            progress.advance(for: .sellerAnswered(granted: false)),
            .doNothing
        )
        XCTAssertEqual(progress.decision, .refused)
    }

    func testTheDecisionSurvivesRelaunch() throws {
        let suiteName = "snaplist.push-registration-tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let store = UserDefaultsPushRegistrationStore(defaults: defaults)
        XCTAssertEqual(store.load().decision, .notYetAsked)

        var progress = store.load()
        _ = progress.advance(for: .itemSubmitted)
        _ = progress.advance(for: .sellerAnswered(granted: false))
        store.save(progress)

        // A refusal that did not survive relaunch would be a promise broken on
        // the seller's next submission.
        let reloaded = UserDefaultsPushRegistrationStore(defaults: defaults)
        var restored = reloaded.load()
        XCTAssertEqual(restored.decision, .refused)
        XCTAssertEqual(restored.advance(for: .itemSubmitted), .doNothing)
    }
}

/// The coordinator around that state machine: what the app actually does with
/// a submission, an answer, and a device token.
@MainActor
final class PushRegistrationCoordinatorTests: XCTestCase {
    private final class RecordingStore: PushRegistrationPersisting {
        var progress = PushRegistrationProgress()
        private(set) var saveCount = 0

        func load() -> PushRegistrationProgress { progress }
        func save(_ progress: PushRegistrationProgress) {
            self.progress = progress
            saveCount += 1
        }
    }

    private func makeCoordinator(
        store: RecordingStore,
        grants: Bool = true,
        authorizationError: Error? = nil,
        register: @escaping @MainActor () -> Void = {},
        submit: @escaping (String) async throws -> Void = { _ in }
    ) -> PushRegistrationCoordinator {
        PushRegistrationCoordinator(
            store: store,
            requestAuthorization: {
                if let authorizationError { throw authorizationError }
                return grants
            },
            registerForRemoteNotifications: register,
            submitDeviceToken: submit
        )
    }

    func testFirstSubmissionAsksAndAnAllowedAnswerRegisters() async {
        let store = RecordingStore()
        var registered = 0
        let coordinator = makeCoordinator(
            store: store,
            register: { registered += 1 }
        )

        await coordinator.itemSubmitted()

        XCTAssertEqual(registered, 1)
        XCTAssertEqual(store.progress.decision, .allowed)
    }

    func testARefusalIsRecordedAndTheSecondSubmissionNeverPrompts() async {
        let store = RecordingStore()
        var asked = 0
        let coordinator = PushRegistrationCoordinator(
            store: store,
            requestAuthorization: {
                asked += 1
                return false
            },
            registerForRemoteNotifications: {},
            submitDeviceToken: { _ in }
        )

        await coordinator.itemSubmitted()
        await coordinator.itemSubmitted()

        XCTAssertEqual(asked, 1)
        XCTAssertEqual(store.progress.decision, .refused)
    }

    func testTheSettingsRequestRecordsTheAnswerOverAStaleStoredRefusal() async {
        // The row only reaches this while iOS reports the question
        // undetermined, and iOS is the authority. A stored answer that
        // disagrees survived something that cleared the system's own, so it
        // must not be allowed to discard the answer the seller gives now.
        let store = RecordingStore()
        store.progress.decision = .refused
        var registered = 0
        let coordinator = makeCoordinator(
            store: store,
            register: { registered += 1 }
        )

        await coordinator.notificationsRequestedFromSettings()

        XCTAssertEqual(store.progress.decision, .allowed)
        XCTAssertEqual(registered, 1)
    }

    func testASubmissionStillNeverRepromptsAfterARefusal() async {
        // The other half of the rule above: only the deliberate Settings tap
        // reopens a settled question. A submission must not.
        let store = RecordingStore()
        store.progress.decision = .refused
        var asked = 0
        let coordinator = PushRegistrationCoordinator(
            store: store,
            requestAuthorization: {
                asked += 1
                return true
            },
            registerForRemoteNotifications: {},
            submitDeviceToken: { _ in }
        )

        await coordinator.itemSubmitted()

        XCTAssertEqual(asked, 0)
        XCTAssertEqual(store.progress.decision, .refused)
    }

    func testAFailedAuthorizationRequestLeavesTheQuestionOpen() async {
        let store = RecordingStore()
        let coordinator = makeCoordinator(
            store: store,
            authorizationError: PushRegistrationTestError.failed
        )

        await coordinator.itemSubmitted()

        // Not a refusal: the seller never answered. Recording one would silence
        // the app forever over a transient failure.
        XCTAssertEqual(store.progress.decision, .notYetAsked)
    }

    func testAFailedTokenSubmissionNeverChangesWhatTheSellerDecided() async {
        let store = RecordingStore()
        let coordinator = makeCoordinator(store: store) { _ in
            throw PushRegistrationTestError.failed
        }

        await coordinator.itemSubmitted()
        await coordinator.deviceTokenReceived(Data([0xab, 0xcd]))

        // Registration is best-effort by design: nothing about submitting an
        // item may depend on it, and a failed post must not undo the grant.
        XCTAssertEqual(store.progress.decision, .allowed)
    }

    func testTheDeviceTokenIsSentAsLowercaseHex() async {
        let store = RecordingStore()
        var sent: [String] = []
        let coordinator = makeCoordinator(store: store) { token in
            sent.append(token)
        }

        await coordinator.itemSubmitted()
        await coordinator.deviceTokenReceived(Data([0x00, 0x0f, 0xab, 0xff]))

        // APNs hands the app bytes; the contract carries lowercase hex, and the
        // column's own check constraint refuses anything else.
        XCTAssertEqual(sent, ["000fabff"])
    }

    func testATokenThatArrivesAfterARefusalIsNotSent() async {
        let store = RecordingStore()
        var sent: [String] = []
        let coordinator = PushRegistrationCoordinator(
            store: store,
            requestAuthorization: { false },
            registerForRemoteNotifications: {},
            submitDeviceToken: { sent.append($0) }
        )

        await coordinator.itemSubmitted()
        await coordinator.deviceTokenReceived(Data([0x01]))

        XCTAssertTrue(sent.isEmpty)
    }
}

private enum PushRegistrationTestError: Error {
    case failed
}

/// Which APNs host this build's tokens are reachable on (issue #891).
///
/// This is not a preference and it is not a build flag. It is decided by the
/// `aps-environment` entitlement Apple granted the profile the app was signed
/// with, and the only place a running app can read that is the provisioning
/// profile embedded in its own bundle. Getting it wrong is silent: Apple
/// accepts a notification addressed to the wrong host and never delivers it.
///
/// `#if DEBUG` is the obvious shortcut and it is wrong. A Release-configuration
/// build signed with a development profile holds sandbox tokens while reporting
/// production, and TestFlight is the same trap. The entitlement is the truth
/// even when the build configuration disagrees with it, which is exactly the
/// case a compile-time answer cannot see.
final class ApnsEnvironmentProbeTests: XCTestCase {
    func testADevelopmentEntitlementMeansSandbox() {
        XCTAssertEqual(
            apnsEnvironment(fromEmbeddedProvisioningProfile: profile("development")),
            .sandbox
        )
    }

    func testAProductionEntitlementMeansProduction() {
        XCTAssertEqual(
            apnsEnvironment(fromEmbeddedProvisioningProfile: profile("production")),
            .production
        )
    }

    func testNoEmbeddedProfileMeansProduction() {
        // App Store distribution, where the profile may not be present at all.
        // Distribution is production by definition, so there is nothing to
        // infer here and no case in which sandbox would be the better guess.
        XCTAssertEqual(
            apnsEnvironment(fromEmbeddedProvisioningProfile: nil),
            .production
        )
    }

    func testTheProfileIsReadOutOfItsSignedWrapperRatherThanAsText() {
        // A `.mobileprovision` is a CMS envelope: the plist sits between binary
        // signature bytes, and those bytes include NUL and values above 127. A
        // reader that treats the file as a string stops at the first NUL and
        // reports production for a development build.
        var wrapped = Data([0x30, 0x82, 0x00, 0xFF, 0x00])
        wrapped.append(profile("development")!)
        wrapped.append(Data([0x00, 0x80, 0xFE]))

        XCTAssertEqual(
            apnsEnvironment(fromEmbeddedProvisioningProfile: wrapped),
            .sandbox
        )
    }

    func testAProfileWithNoEntitlementsMeansProduction() {
        let plist = Data("""
        <?xml version="1.0" encoding="UTF-8"?>
        <plist version="1.0"><dict><key>Name</key><string>SnapList</string></dict></plist>
        """.utf8)

        XCTAssertEqual(
            apnsEnvironment(fromEmbeddedProvisioningProfile: plist),
            .production
        )
    }

    func testAnUnreadableProfileMeansProduction() {
        // Only a profile that positively says `development` moves this off
        // production. A parse failure that guessed sandbox would silence every
        // shipped seller's push; guessing production can only ever cost a
        // developer their own.
        XCTAssertEqual(
            apnsEnvironment(fromEmbeddedProvisioningProfile: Data([0x01, 0x02, 0x03])),
            .production
        )
    }

    private func profile(_ environment: String) -> Data? {
        Data("""
        <?xml version="1.0" encoding="UTF-8"?>
        <plist version="1.0"><dict>
        <key>Entitlements</key>
        <dict><key>aps-environment</key><string>\(environment)</string></dict>
        </dict></plist>
        """.utf8)
    }
}

/// The registration body the server now requires (issue #891).
///
/// `/v1/device-tokens` validates with a strict schema, so a body missing
/// `apnsEnvironment` is a 400 and this device is never registered at all. The
/// field is also the thing that decides which APNs host the server posts to
/// later, and posting to the wrong one is accepted and silently dropped. Both
/// failures are invisible from the app, which is why they are asserted on the
/// bytes that actually leave rather than on a call being made.
final class PushDeviceTokenClientTests: XCTestCase {
    override func tearDown() {
        PushDeviceTokenURLProtocolStub.reset()
        super.tearDown()
    }

    func testTheBodyNamesThePlatformTheTokenAndTheEnvironment() async throws {
        PushDeviceTokenURLProtocolStub.responses = [.init(status: 200)]

        try await makeClient().submitPushDeviceToken(
            "abc123",
            environment: .sandbox
        )

        let request = PushDeviceTokenURLProtocolStub.lastRequest
        XCTAssertEqual(request?.httpMethod, "POST")
        XCTAssertEqual(request?.url?.path, "/v1/device-tokens")
        XCTAssertEqual(
            PushDeviceTokenURLProtocolStub.lastBodyObject as? [String: String],
            ["platform": "ios", "token": "abc123", "apnsEnvironment": "sandbox"]
        )
    }

    func testAProductionBuildRegistersAgainstTheProductionHost() async throws {
        // The value travels from the signing profile through to the row the
        // sender reads. A client that hardcoded either literal would register
        // every build against one host and lose the other's notifications.
        PushDeviceTokenURLProtocolStub.responses = [.init(status: 200)]

        try await makeClient().submitPushDeviceToken(
            "abc123",
            environment: .production
        )

        XCTAssertEqual(
            (PushDeviceTokenURLProtocolStub.lastBodyObject
                as? [String: String])?["apnsEnvironment"],
            "production"
        )
    }

    func testARefusedRegistrationIsReportedRatherThanSwallowedHere() async {
        // The coordinator is the one place that decides a failed registration is
        // survivable. The client saying "sent" for a 400 would make that
        // decision somewhere it cannot be seen.
        PushDeviceTokenURLProtocolStub.responses = [.init(status: 400)]

        do {
            try await makeClient().submitPushDeviceToken(
                "abc123",
                environment: .sandbox
            )
            XCTFail("expected the client to throw on a refused registration")
        } catch {
            XCTAssertEqual(error as? MobileAPIClientError, .httpStatus(400))
        }
    }

    private func makeClient() -> URLSessionPushDeviceTokenClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PushDeviceTokenURLProtocolStub.self]
        return URLSessionPushDeviceTokenClient(
            baseURL: URL(string: "https://snaplist.dev")!,
            tokenProvider: StubBearerTokenProvider(),
            session: URLSession(configuration: configuration)
        )
    }
}

private struct StubBearerTokenProvider: BearerTokenProviding {
    func bearerToken() async throws -> String { "seller-token" }
}

private final class PushDeviceTokenURLProtocolStub: URLProtocol, @unchecked Sendable {
    struct StubResponse {
        let status: Int
    }

    nonisolated(unsafe) static var responses: [StubResponse] = []
    nonisolated(unsafe) static var lastRequest: URLRequest?
    nonisolated(unsafe) static var lastBodyObject: Any?

    static func reset() {
        responses = []
        lastRequest = nil
        lastBodyObject = nil
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lastRequest = request
        // `URLProtocol` strips `httpBody` once the request is streamed, so the
        // bytes are read back off the stream rather than off the request.
        if let stream = request.httpBodyStream {
            stream.open()
            var body = Data()
            var buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                body.append(contentsOf: buffer[0..<read])
            }
            stream.close()
            Self.lastBodyObject = try? JSONSerialization.jsonObject(with: body)
        } else if let body = request.httpBody {
            Self.lastBodyObject = try? JSONSerialization.jsonObject(with: body)
        }

        guard !Self.responses.isEmpty else {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        let stub = Self.responses.removeFirst()
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: stub.status,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// Issue #891. What the seller sees when a push lands with the app already open.
///
/// iOS asks the app whether to draw its banner, and an app that answers "draw
/// nothing" has taken responsibility for showing the seller something itself.
/// Those are two separate things in two places, and the failure that matters is
/// when only the first one happens: the system banner is suppressed, no in-app
/// surface exists to draw the replacement, and a seller whose listing just
/// finished is told nothing at all. That is worse than the plain system banner,
/// and it is silent.
///
/// So suppression is not a decision about the payload. It is a report from the
/// surface that actually drew it.
final class ForegroundPushPresentationTests: XCTestCase {
    private let readyPayload: [AnyHashable: Any] = [
        "aps": [
            "alert": [
                "title": "Sony WH-1000XM4 is ready to review",
                "body": "Open SnapList to check the details before you publish.",
            ],
            "sound": "default",
        ],
        "moment": "listingReady",
    ]

    func testTheSystemBannerIsSuppressedOnlyWhenTheAppDrewTheReplacement() {
        let options = ForegroundPushPolicy.presentationOptions(
            for: readyPayload,
            showInApp: { _ in true }
        )

        XCTAssertFalse(options.contains(.banner))
        XCTAssertFalse(options.contains(.sound))
    }

    func testANotificationTheAppDrewIsStillFiledInNotificationCentre() {
        // `.list` here is not a leftover, and making this the empty set is the
        // obvious cleanup that would break it. Empty means show nothing
        // anywhere, and the in-app banner is transient: a seller who looked
        // away for a few seconds would have a finished listing with no record
        // of it anywhere on the phone and nothing to pull down and check.
        let options = ForegroundPushPolicy.presentationOptions(
            for: readyPayload,
            showInApp: { _ in true }
        )

        XCTAssertTrue(options.contains(.list))
    }

    func testTheSystemBannerStandsWhenNoInAppSurfaceTookIt() {
        // No window scene yet, a shell that is mid-transition, a presenter that
        // is not mounted. The seller sees Apple's banner, which is the correct
        // outcome and not a degraded one.
        let options = ForegroundPushPolicy.presentationOptions(
            for: readyPayload,
            showInApp: { _ in false }
        )

        XCTAssertFalse(options.isEmpty)
        XCTAssertTrue(options.contains(.banner))
    }

    func testAPayloadThatIsNotOursIsNeverOfferedToTheInAppSurface() {
        var offered = 0
        let options = ForegroundPushPolicy.presentationOptions(
            for: ["aps": ["alert": ["title": "Something", "body": "Else"]]],
            showInApp: { _ in
                offered += 1
                return true
            }
        )

        XCTAssertEqual(offered, 0)
        XCTAssertFalse(options.isEmpty)
    }

    func testAPayloadMissingItsCopyIsLeftToTheSystem() {
        // An in-app banner with no words is not a notification. iOS draws
        // whatever it was given rather than the app drawing nothing.
        let options = ForegroundPushPolicy.presentationOptions(
            for: ["aps": ["alert": ["title": "Ready"]], "moment": "listingReady"],
            showInApp: { _ in true }
        )

        XCTAssertFalse(options.isEmpty)
    }

    func testTheInAppSurfaceGetsExactlyWhatAppleWouldHavePrinted() {
        // Same two moments, same truth. The copy is built once on the server and
        // the app repeats it; a foreground seller and a locked-screen seller
        // must not be told two different things about one item.
        var shown: ForegroundPushNotification?

        _ = ForegroundPushPolicy.presentationOptions(
            for: readyPayload,
            showInApp: { notification in
                shown = notification
                return true
            }
        )

        XCTAssertEqual(
            shown,
            ForegroundPushNotification(
                moment: .listingReady,
                title: "Sony WH-1000XM4 is ready to review",
                body: "Open SnapList to check the details before you publish."
            )
        )
    }

    func testBothMomentsAreRecognised() {
        for (raw, moment) in [
            ("listingReady", ForegroundPushMoment.listingReady),
            ("listingPublished", ForegroundPushMoment.listingPublished),
        ] {
            var shown: ForegroundPushNotification?
            _ = ForegroundPushPolicy.presentationOptions(
                for: [
                    "aps": ["alert": ["title": "Title", "body": "Body"]],
                    "moment": raw,
                ],
                showInApp: { notification in
                    shown = notification
                    return true
                }
            )
            XCTAssertEqual(shown?.moment, moment, raw)
        }
    }
}

@MainActor
final class ForegroundPushPresenterTests: XCTestCase {
    func testAPresenterWithNowhereToDrawRefusesTheNotification() {
        // The refusal is the whole point: it is what keeps the system banner.
        let presenter = ForegroundPushPresenter()

        XCTAssertFalse(presenter.show(.init(
            moment: .listingReady,
            title: "Title",
            body: "Body"
        )))
        XCTAssertNil(presenter.visible)
    }

    func testAMountedPresenterShowsTheNotificationAndReportsThatItDid() {
        let presenter = ForegroundPushPresenter()
        presenter.mounted = true

        let notification = ForegroundPushNotification(
            moment: .listingPublished,
            title: "Your listing is live on eBay",
            body: "Open SnapList to view or edit it."
        )

        XCTAssertTrue(presenter.show(notification))
        XCTAssertEqual(presenter.visible, notification)
    }

    func testTheSecondMomentReplacesTheFirstRatherThanStacking() {
        // Two moments for one item can land close together. One surface, showing
        // the newest truth, is what the collapse id already gives a seller whose
        // phone is locked.
        let presenter = ForegroundPushPresenter()
        presenter.mounted = true
        let published = ForegroundPushNotification(
            moment: .listingPublished,
            title: "Your listing is live on eBay",
            body: "Open SnapList to view or edit it."
        )

        _ = presenter.show(.init(
            moment: .listingReady,
            title: "Ready",
            body: "Open SnapList."
        ))
        _ = presenter.show(published)

        XCTAssertEqual(presenter.visible, published)
    }

    func testDismissingClearsIt() {
        let presenter = ForegroundPushPresenter()
        presenter.mounted = true
        _ = presenter.show(.init(moment: .listingReady, title: "T", body: "B"))

        presenter.dismiss()

        XCTAssertNil(presenter.visible)
    }
}
