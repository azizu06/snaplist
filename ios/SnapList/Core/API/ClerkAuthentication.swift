import ClerkKit
import Foundation

enum NativeAppConfigurationError: Error, Equatable {
    case missingAPIOrigin
    case invalidAPIOrigin
    case missingClerkPublishableKey
    case invalidClerkPublishableKey
    case clerkInstanceOriginMismatch
}

struct NativeAppConfiguration: Equatable {
    let apiOrigin: URL
    let clerkPublishableKey: String

    static func resolve(
        environment: [String: String],
        apiOriginBundleValue: String?,
        clerkPublishableKeyBundleValue: String?,
        allowsLocalDevelopment: Bool
    ) throws -> NativeAppConfiguration {
        let rawAPIOrigin = (
            environment["SNAPLIST_API_ORIGIN"] ?? apiOriginBundleValue
        )?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let rawAPIOrigin, !rawAPIOrigin.isEmpty else {
            throw NativeAppConfigurationError.missingAPIOrigin
        }
        guard let apiOrigin = HomeRepositoryFactory.resolveAPIOrigin(
            environment: ["SNAPLIST_API_ORIGIN": rawAPIOrigin],
            bundleValue: nil,
            allowsLocalDevelopment: allowsLocalDevelopment
        ) else {
            throw NativeAppConfigurationError.invalidAPIOrigin
        }

        let publishableKey = (
            environment["SNAPLIST_CLERK_PUBLISHABLE_KEY"]
                ?? clerkPublishableKeyBundleValue
        )?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let publishableKey, !publishableKey.isEmpty else {
            throw NativeAppConfigurationError.missingClerkPublishableKey
        }
        guard publishableKey.hasPrefix("pk_live_")
                || (
                    allowsLocalDevelopment
                    && publishableKey.hasPrefix("pk_test_")
                ) else {
            throw NativeAppConfigurationError.invalidClerkPublishableKey
        }
        guard instanceMatchesOrigin(
            publishableKey: publishableKey,
            apiOrigin: apiOrigin
        ) else {
            throw NativeAppConfigurationError.clerkInstanceOriginMismatch
        }

        return NativeAppConfiguration(
            apiOrigin: apiOrigin,
            clerkPublishableKey: publishableKey
        )
    }

    /// A Clerk publishable key names the instance that minted it: `pk_live_`
    /// for production, `pk_test_` for a development instance. The production
    /// API validates sessions against the production instance alone, so a
    /// crossed pair is a build defect rather than a runtime condition — #804
    /// surfaced it as an opaque 401 after the seller had already uploaded
    /// photos. `Scripts/clerk-origin-pairing-lint.sh` enforces the same rule on
    /// the build settings before a build with a crossed pair can finish.
    private static func instanceMatchesOrigin(
        publishableKey: String,
        apiOrigin: URL
    ) -> Bool {
        guard let host = apiOrigin.host?.lowercased() else {
            return false
        }
        let isProductionOrigin = host == "snaplist.dev"
            || host.hasSuffix(".snaplist.dev")
        let isLoopbackOrigin = ["localhost", "127.0.0.1", "::1"].contains(host)

        if publishableKey.hasPrefix("pk_test_") {
            return !isProductionOrigin
        }
        if publishableKey.hasPrefix("pk_live_") {
            return !isLoopbackOrigin
        }
        return false
    }
}

protocol ClerkSessionTokenProviding: Sendable {
    /// Clerk owns session refresh and secure persistence. Callers receive only
    /// the current short-lived bearer and never store or decode it.
    func sessionToken() async throws -> String?

    /// Captures both values from one Clerk Session instance. The subject stays
    /// inside the authentication boundary and is consumed only to derive #540's
    /// opaque scope proof.
    func sessionAuthentication() async throws -> ClerkSessionAuthentication
}

struct ClerkSessionAuthentication: Sendable {
    let token: String?
    let scopeProof: ItemRunSubmissionPrincipalScopeProof?
}

extension ClerkSessionTokenProviding {
    func sessionAuthentication() async throws -> ClerkSessionAuthentication {
        ClerkSessionAuthentication(
            token: try await sessionToken(),
            scopeProof: nil
        )
    }
}

enum BearerTokenProviderError: Error, Equatable {
    case sessionAbsent
    case principalBindingUnavailable
    /// The credential could not be reached on this attempt — no network, Apple's
    /// attestation service down, a keychain that would not open. A phone with no
    /// signal has told us nothing about whether the seller has an account, so
    /// this may never become the account-claim handoff (#843 item 1).
    case credentialTemporarilyUnavailable
}

/// Which credential a request actually carried.
///
/// A `401` alone cannot say, and the two answers mean opposite things. A
/// guest-capability bearer proves an installation and never a subject, so a
/// bearer route refusing it is that route working correctly: the caller is a
/// guest. The same status answered to a Clerk bearer means a token minted for a
/// verified subject was refused — a missing `CLERK_SECRET_KEY`, a wrong
/// audience, a rotated signing key — and reading that as `.guest` puts a
/// signed-in seller back in front of the activation coach marks.
enum BearerCredential: Equatable, Sendable {
    case clerkSubject
    case guestCapability
}

struct ClassifiedBearerToken: Sendable {
    let token: String
    let credential: BearerCredential
}

struct PrincipalBoundBearer: Sendable {
    let bearerToken: String
    let scopeProof: ItemRunSubmissionPrincipalScopeProof
}

struct ItemRunSubmissionScopedBearer: Sendable {
    let bearerToken: String
    let scopeProof: ItemRunSubmissionPrincipalScopeProof
}

protocol BearerTokenProviding: Sendable {
    /// Returns a fresh opaque Clerk bearer without exposing ClerkKit to callers.
    func bearerToken() async throws -> String

    /// Returns the same bearer plus which credential it turned out to be, so a
    /// caller that gets refused can tell an unauthenticated answer apart from a
    /// rejected one.
    func classifiedBearerToken() async throws -> ClassifiedBearerToken

    /// Returns a bearer and opaque scope proof captured from the same verified
    /// session. Callers compare the proof but cannot recover the Clerk subject.
    func principalBoundBearer() async throws -> PrincipalBoundBearer

    /// Returns only the bearer whose verified identity owns the current opaque
    /// NativeIntake scope. Unlike `principalBoundBearer`, this narrow seam may
    /// bind a verified App Attest installation for the included guest run.
    func itemRunSubmissionScopedBearer() async throws
        -> ItemRunSubmissionScopedBearer
}

extension BearerTokenProviding {
    /// A provider with no guest fallback only ever mints a Clerk bearer, so the
    /// classification is settled without asking it.
    func classifiedBearerToken() async throws -> ClassifiedBearerToken {
        ClassifiedBearerToken(
            token: try await bearerToken(),
            credential: .clerkSubject
        )
    }

    func principalBoundBearer() async throws -> PrincipalBoundBearer {
        throw BearerTokenProviderError.principalBindingUnavailable
    }

    func itemRunSubmissionScopedBearer() async throws
        -> ItemRunSubmissionScopedBearer {
        let principal = try await principalBoundBearer()
        return ItemRunSubmissionScopedBearer(
            bearerToken: principal.bearerToken,
            scopeProof: principal.scopeProof
        )
    }
}

struct UnavailableBearerTokenProvider: BearerTokenProviding {
    func bearerToken() async throws -> String {
        throw BearerTokenProviderError.sessionAbsent
    }
}

struct ClerkBearerTokenProvider: BearerTokenProviding {
    let session: any ClerkSessionTokenProviding

    func bearerToken() async throws -> String {
        let authentication = try await session.sessionAuthentication()
        guard let token = Self.usable(authentication.token) else {
            if authentication.scopeProof != nil {
                throw BearerTokenProviderError.principalBindingUnavailable
            }
            throw BearerTokenProviderError.sessionAbsent
        }
        return token
    }

    func principalBoundBearer() async throws -> PrincipalBoundBearer {
        let authentication = try await session.sessionAuthentication()
        guard let token = Self.usable(authentication.token) else {
            if authentication.scopeProof != nil {
                throw BearerTokenProviderError.principalBindingUnavailable
            }
            throw BearerTokenProviderError.sessionAbsent
        }
        guard let scopeProof = authentication.scopeProof else {
            throw BearerTokenProviderError.principalBindingUnavailable
        }
        return PrincipalBoundBearer(
            bearerToken: token,
            scopeProof: scopeProof
        )
    }

    private static func usable(_ value: String?) -> String? {
        let value = value?.trimmingCharacters(
            in: .whitespacesAndNewlines
        )
        guard let value, !value.isEmpty else {
            return nil
        }
        return value
    }
}

struct GuestCapableBearerTokenProvider: BearerTokenProviding {
    private let clerk: any BearerTokenProviding
    private let guestCapabilities: any GuestCapabilityBearerStoring
    private let appAttestKeys: any AppAttestKeyIDStoring
    private let now: @Sendable () -> Date

    init(
        clerk: any BearerTokenProviding,
        guestCapabilities: any GuestCapabilityBearerStoring =
            KeychainGuestCapabilityBearerStore(),
        appAttestKeys: any AppAttestKeyIDStoring =
            KeychainAppAttestKeyIDStore(),
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.clerk = clerk
        self.guestCapabilities = guestCapabilities
        self.appAttestKeys = appAttestKeys
        self.now = now
    }

    func bearerToken() async throws -> String {
        try await classifiedBearerToken().token
    }

    /// This is the only place that still knows which of the two credentials a
    /// request went out on. Once the header is built they are both just a
    /// bearer, and a `401` answered to either looks identical.
    func classifiedBearerToken() async throws -> ClassifiedBearerToken {
        do {
            return ClassifiedBearerToken(
                token: try await clerk.bearerToken(),
                credential: .clerkSubject
            )
        } catch BearerTokenProviderError.sessionAbsent {
            // Only an absent session may fall through. Falling back on any other
            // Clerk failure would put an account holder's request on a guest
            // identity whenever Clerk merely stumbled.
            return ClassifiedBearerToken(
                token: try guestBearerToken(),
                credential: .guestCapability
            )
        }
    }

    /// A guest capability proves an installation, never a verified Clerk subject,
    /// so it can never satisfy a principal-bound request. Clerk answers alone.
    func principalBoundBearer() async throws -> PrincipalBoundBearer {
        try await clerk.principalBoundBearer()
    }

    func itemRunSubmissionScopedBearer() async throws
        -> ItemRunSubmissionScopedBearer {
        do {
            let principal = try await clerk.principalBoundBearer()
            return ItemRunSubmissionScopedBearer(
                bearerToken: principal.bearerToken,
                scopeProof: principal.scopeProof
            )
        } catch BearerTokenProviderError.sessionAbsent {
            let bearer = try guestBearer()
            guard let key = try? appAttestKeys.load(),
                  key.state == .verified,
                  let currentScopeProof = ItemRunSubmissionPrincipalScopeProof(
                      verifiedAppAttestKeyID: key.id
                  ),
                  let storedScopeProof = bearer.appAttestScopeProof,
                  storedScopeProof == currentScopeProof else {
                // An unbound migrated bearer or a bearer earned by a prior key
                // is not absent authority for the current scope. Reporting it as
                // unusable gives the renewing wrapper one assertion to mint the
                // exact current bearer/scope pair without ever synthesizing one.
                throw BearerTokenProviderError.sessionAbsent
            }
            return ItemRunSubmissionScopedBearer(
                bearerToken: bearer.token,
                scopeProof: storedScopeProof
            )
        }
    }

    private func guestBearerToken() throws -> String {
        try guestBearer().token
    }

    private func guestBearer() throws -> GuestCapabilityBearer {
        guard let bearer = try? guestCapabilities.load(),
              bearer.isUsable(at: now()) else {
            throw BearerTokenProviderError.sessionAbsent
        }
        return bearer
    }
}

private struct LiveClerkSessionTokenProvider: ClerkSessionTokenProviding {
    func sessionToken() async throws -> String? {
        let authentication = try await sessionAuthentication()
        return authentication.token
    }

    func sessionAuthentication() async throws
        -> ClerkSessionAuthentication {
        let session = await MainActor.run { Clerk.shared.session }
        let subject: String? = session?.user?.id
        let scopeProof = subject.flatMap {
            ItemRunSubmissionPrincipalScopeProof(
                verifiedClerkSubject: $0
            )
        }
        return ClerkSessionAuthentication(
            token: try await session?.getToken(),
            scopeProof: scopeProof
        )
    }
}

enum ClerkAuthenticationComposition {
    @MainActor
    static func currentUserID() -> String? {
        Clerk.shared.user?.id
    }

    /// Configures ClerkKit once from the validated public build value and binds
    /// every authenticated native caller to the real current Clerk session. A
    /// seller who has no session yet falls back to the App Attest guest
    /// capability, which is the only credential first value can be earned with.
    @MainActor
    static func make(
        publishableKey: String
    ) -> any BearerTokenProviding {
        Clerk.configure(publishableKey: publishableKey)
        return GuestCapableBearerTokenProvider(
            clerk: ClerkBearerTokenProvider(
                session: LiveClerkSessionTokenProvider()
            )
        )
    }

    /// Starts included-offer redemption for whoever is signed in, and for
    /// whoever signs in later.
    ///
    /// It lives beside the Clerk session rather than on a screen because the
    /// trigger is the verified principal itself; see
    /// `IncludedOfferRedemptionComposition` for the sign-in paths a
    /// screen-shaped trigger silently misses.
    @MainActor
    @discardableResult
    static func beginIncludedOfferRedemption(
        apiOrigin: URL,
        tokenProvider: any BearerTokenProviding,
        session: URLSession = .shared
    ) -> Task<Void, Never> {
        // Its own client, sharing the Keychain-backed attested key with the
        // guest-side one by default. The two cannot race: guest enrollment runs
        // only on a confirmed signed-out installation, and redemption runs only
        // once a Clerk principal exists.
        let attest = AppAttestClient(
            appID: AppAttestGuestCapabilityComposition.appID,
            environment: .production,
            server: URLSessionAppAttestServerClient(
                apiOrigin: apiOrigin,
                session: session
            )
        )
        let api = URLSessionMobileAPIClient(
            baseURL: apiOrigin,
            tokenProvider: tokenProvider,
            session: session
        )
        let principals = liveClerkPrincipals()
        return Task {
            await IncludedOfferRedemptionComposition.drive(
                principals: principals,
                redeem: { userID in
                    _ = await IncludedOfferRedemptionCoordinator(
                        redemption: IncludedOfferRedemption(
                            attest: attest,
                            client: api,
                            userID: userID
                        ),
                        store: IncludedOfferRedemptionStore(userID: userID)
                    ).redeem()
                }
            )
        }
    }

    /// The signed-in principal now, and again on every Clerk auth event.
    ///
    /// The current value is yielded before any event because Clerk restores a
    /// session from its own Keychain at launch without emitting one. A seller
    /// whose first redemption failed while they had no signal is already signed
    /// in on every later launch, with no sign-in left to observe.
    @MainActor
    private static func liveClerkPrincipals() -> AsyncStream<String?> {
        let changes = liveClerkChanges()
        return AsyncStream { continuation in
            let task = Task { @MainActor in
                continuation.yield(Clerk.shared.user?.id)
                for await _ in changes {
                    continuation.yield(Clerk.shared.user?.id)
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    @MainActor
    static func makeNativeIntakeIdentitySource(
        keyStore: any AppAttestKeyIDStoring = KeychainAppAttestKeyIDStore(),
        verifiedClerkSubject: @escaping @Sendable () async -> String? = {
            await MainActor.run { Clerk.shared.user?.id }
        },
        clerkChanges: @escaping @MainActor @Sendable () -> AsyncStream<Void> = {
            liveClerkChanges()
        },
        appAttestChanges: @escaping @MainActor @Sendable () -> AsyncStream<Void> = {
            appAttestChanges()
        }
    ) -> NativeIntake.IdentitySource {
        let streams = [clerkChanges(), appAttestChanges()]
        return NativeIntake.identitySource(
            verifiedClerkSubject: verifiedClerkSubject,
            persistedAppAttestKey: {
                try? keyStore.load()
            },
            changes: {
                AsyncStream { continuation in
                    let tasks = streams.map { stream in
                        Task {
                            for await _ in stream {
                                continuation.yield()
                            }
                        }
                    }
                    continuation.onTermination = { _ in
                        tasks.forEach { $0.cancel() }
                    }
                }
            }
        )
    }

    @MainActor
    private static func liveClerkChanges() -> AsyncStream<Void> {
        let events = Clerk.shared.auth.events
        return AsyncStream { continuation in
            let task = Task {
                for await _ in events {
                    continuation.yield()
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// #843 item 4. The observer registers here, before this function returns,
    /// rather than whenever something first awaits the stream. Enrollment
    /// finishing in that gap is ordinary — it races the same launch that started
    /// it — and a change dropped there leaves the intake on the scope it had at
    /// launch until something else happens to wake it.
    ///
    /// `NotificationCenter.notifications(named:)` happens to register when the
    /// sequence value is made, which is why this was not already broken. That is
    /// a detail of an API this code does not own, so `addObserver` states the
    /// requirement instead of inheriting it.
    static func appAttestChanges(
        center: NotificationCenter = .default
    ) -> AsyncStream<Void> {
        let (stream, continuation) = AsyncStream<Void>.makeStream(
            // Every consumer re-reads the key store when it wakes, so two
            // changes and one change ask for the same work. Coalescing keeps a
            // stream nobody is draining from growing without bound.
            bufferingPolicy: .bufferingNewest(1)
        )
        let observer = center.addObserver(
            forName: KeychainAppAttestKeyIDStore.didChange,
            object: nil,
            queue: nil
        ) { _ in
            continuation.yield()
        }
        continuation.onTermination = { _ in
            center.removeObserver(observer)
        }
        return stream
    }
}

/**
 Issue #385. The live account deletion wiring.

 Split out from `MobileAPIClient` because it needs ClerkKit for two things the
 rest of the API surface does not: a bearer minted after the strict
 reverification, and the sign-out that follows a confirmed deletion.
 */
enum AccountDeletionComposition {
    struct MissingSessionError: Error {}

    /// A build with no API origin. It refuses before it touches the device, and
    /// says which kind of refusal it is so the screen does not blame a server
    /// that was never asked anything.
    static func unconfigured() -> AccountDeletionCoordinator.Dependencies {
        AccountDeletionCoordinator.Dependencies(
            requestErasure: { _ in .notConfirmed(.clientNotConfigured) },
            clearDeviceState: { false },
            signOut: { false },
            newIdempotencyKey: { UUID().uuidString.lowercased() },
            maximumStatusFollowUps: 0
        )
    }

    /// Scripts the server half for the UI test that exercises the real route.
    /// Everything from the environment value down through the tail host and the
    /// coordinator is the shipped code; only the server's answer is supplied.
    static func fixture(
        _ fixture: AccountErasureFixtureState
    ) -> AccountDeletionCoordinator.Dependencies {
        let outcome: AccountErasureOutcome = switch fixture {
        case .completed: .completed(retainedRecords: [.ebayLiveListing])
        case .unavailable: .notConfirmed(.serverUnavailable)
        case .needsAttention: .needsAttention
        case .keyConflict: .notConfirmed(.idempotencyKeyConflict)
        case .reverificationExpired: .notConfirmed(.reverificationRequired)
        }
        return AccountDeletionCoordinator.Dependencies(
            requestErasure: { _ in outcome },
            clearDeviceState: { true },
            signOut: { true },
            newIdempotencyKey: { UUID().uuidString.lowercased() },
            maximumStatusFollowUps: 0
        )
    }

    /// Mints the bearer one erasure request carries.
    ///
    /// Split out from `make` so the one decision in it is reachable without a
    /// Clerk session: the token is always minted with the cache skipped. The
    /// handler reads the session's factor verification age, and a token cached
    /// before the seller answered the strict reverification carries the older
    /// claim, so a cached one earns a challenge for a challenge they already
    /// answered and the erasure never starts.
    ///
    /// No session is an error rather than a request with no bearer, because an
    /// unauthenticated erasure request is one the handler refuses anyway and the
    /// seller would read that refusal as the server failing.
    static func reverifiedBearerToken(
        mint: (_ skipCache: Bool) async throws -> String?
    ) async throws -> String {
        guard let token = try await mint(true) else {
            throw MissingSessionError()
        }
        return token
    }

    /// The gap before follow-up `attempt`: 1s, 2s, then 4s.
    ///
    /// Split out from the closure in `make` so the exponent is reachable
    /// without sleeping through it. Doubling is the point: every follow-up
    /// re-runs the server's whole erase pipeline, provider calls included, so a
    /// flat gap multiplies that work rather than giving the first request time
    /// to finish it. `max(0,)` because a shift by a negative amount traps, and
    /// an attempt counter below one is a caller bug, not a reason to crash a
    /// seller's deletion.
    static func followUpDelaySeconds(attempt: Int) -> UInt64 {
        UInt64(1) << UInt64(max(0, attempt - 1))
    }

    /// The shipped entry point. Reads every ClerkKit seam here and hands them
    /// to the wiring below, which is the same code the app runs.
    @MainActor
    static func make(
        apiOrigin: URL,
        session: URLSession = .shared,
        removeIntake: @escaping @Sendable () async -> Bool,
        removeCachedItems: @escaping @Sendable () async -> Bool
    ) -> AccountDeletionCoordinator.Dependencies {
        make(
            apiOrigin: apiOrigin,
            session: session,
            signedInUserID: Clerk.shared.user?.id,
            mintBearerToken: { skipCache in
                let clerkSession = await MainActor.run { Clerk.shared.session }
                return try await clerkSession?
                    .getToken(.init(skipCache: skipCache))
            },
            endSession: { try await Clerk.shared.auth.signOut() },
            keyStoreDefaults: .standard,
            removeIntake: removeIntake,
            removeCachedItems: removeCachedItems
        )
    }

    /// The wiring, with every ClerkKit seam passed in rather than read here.
    ///
    /// Split from the entry point above so this is reachable from a test.
    /// `Clerk.shared.client` has an `internal(set)` setter, so nothing in this
    /// module can put a signed-in seller behind `Clerk.shared.user`, and while
    /// those reads sat in this body the whole of it — the fail-closed guard,
    /// the per-seller key store, the reverified bearer, the device clearing and
    /// the sign-out — was proved only by running the app on a device.
    ///
    /// Every argument the entry point passes is the expression that used to
    /// stand in its place here, so the shipped path is unchanged.
    @MainActor
    static func make(
        apiOrigin: URL,
        session: URLSession,
        signedInUserID: String?,
        mintBearerToken: @escaping @Sendable (_ skipCache: Bool) async throws
            -> String?,
        endSession: @escaping @Sendable () async throws -> Void,
        keyStoreDefaults: UserDefaults,
        removeIntake: @escaping @Sendable () async -> Bool,
        removeCachedItems: @escaping @Sendable () async -> Bool
    ) -> AccountDeletionCoordinator.Dependencies {
        // Read once, here, while the seller is still signed in. The store has to
        // be reachable from a later coordinator that starts with nothing, and
        // after a completed deletion there is no user left to key it by.
        //
        // Fail closed with no user. A placeholder id would file every such
        // seller's key in one shared bucket, so one seller's deletion would
        // hand its key to the next, and that key is the only thing that makes
        // an interrupted deletion resumable rather than a permanent 409.
        guard let userID = signedInUserID else {
            return unconfigured()
        }
        let keyStore = AccountErasureKeyStore(
            userID: userID,
            defaults: keyStoreDefaults
        )
        let client = URLSessionAccountErasureClient(
            apiOrigin: apiOrigin,
            reverifiedBearerToken: {
                try await reverifiedBearerToken(mint: mintBearerToken)
            },
            session: session
        )

        return AccountDeletionCoordinator.Dependencies(
            requestErasure: { key in
                await client.requestErasure(idempotencyKey: key)
            },
            clearDeviceState: {
                await AccountDeletionDeviceState.clear(
                    steps: AccountDeletionDeviceState.steps(
                        removeIntake: removeIntake,
                        removeCachedItems: removeCachedItems
                    )
                )
            },
            signOut: {
                do {
                    try await endSession()
                    return true
                } catch {
                    // Reported, never swallowed. Clerk holds the session in its
                    // own Keychain item, so a failure here leaves a live
                    // credential on a device whose account is already gone.
                    return false
                }
            },
            // Lowercased because the handler parses this header with a UUID
            // schema before it authenticates, and a rejected key is a 400 that
            // never reaches the erasure at all.
            newIdempotencyKey: { UUID().uuidString.lowercased() },
            loadIdempotencyKey: { keyStore.load() },
            rememberIdempotencyKey: { keyStore.remember($0) },
            forgetIdempotencyKey: { keyStore.forget() },
            waitBeforeFollowUp: { attempt in
                // 1s, 2s, 4s. Each follow-up re-runs the server's whole erase
                // pipeline, so the gap is the difference between resuming work
                // and multiplying it.
                let seconds = followUpDelaySeconds(attempt: attempt)
                try? await Task.sleep(nanoseconds: seconds * 1_000_000_000)
            },
            maximumStatusFollowUps: 3
        )
    }
}
