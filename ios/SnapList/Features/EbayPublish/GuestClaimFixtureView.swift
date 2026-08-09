#if DEBUG
import Foundation
import SwiftUI

private enum GuestClaimFixtureData {
    static let authority = GuestClaimAuthority(
        recoveryID: UUID(
            uuidString: "74300000-0000-4000-8000-000000000001"
        )!,
        recoveryToken: "fixture-token-never-sent",
        itemID: UUID(
            uuidString: "74300000-0000-4000-8000-000000000002"
        )!,
        runID: UUID(
            uuidString: "74300000-0000-4000-8000-000000000003"
        )!,
        draftID: UUID(
            uuidString: "74300000-0000-4000-8000-000000000004"
        )!,
        reviewRevision: UUID(
            uuidString: "74300000-0000-4000-8000-000000000005"
        )!,
        photoIdentity: GuestPhotoIdentity(
            kind: "sha256",
            fingerprint: String(repeating: "a", count: 64)
        )
    )

    static let projection = GuestClaimListingProjection(
        title: "Saved seller title",
        effectivePrice: Decimal(string: "63.25")!,
        thumbnail: .neutral,
        expiresAt: Date(timeIntervalSince1970: 1_900_000_000)
    )
}

private actor GuestClaimFixtureService: GuestClaimServing {
    private var results: [Result<GuestClaimOutcome, GuestClaimServiceError>]

    init(fixture: GuestClaimFixtureState) {
        let listing = ClaimedGuestListing(
            itemID: GuestClaimFixtureData.authority.itemID,
            runID: GuestClaimFixtureData.authority.runID,
            draftID: GuestClaimFixtureData.authority.draftID
        )
        switch fixture {
        case .cancel:
            results = [.failure(.unavailable)]
        case .success:
            results = [.success(.claimed(listing))]
        case .claimFailure:
            results = [.failure(.unavailable)]
        case .retry:
            results = [
                .failure(.unavailable),
                .success(.claimed(listing)),
            ]
        }
    }

    func prepareHandoff(authority: GuestClaimAuthority) async throws {}

    func claim(
        authority: GuestClaimAuthority,
        idempotencyKey: UUID
    ) async throws -> GuestClaimOutcome {
        guard !results.isEmpty else {
            throw GuestClaimServiceError.unavailable
        }
        return try results.removeFirst().get()
    }
}

@MainActor
struct GuestClaimFixtureHostView: View {
    let fixture: GuestClaimFixtureState
    let forceReducedMotion: Bool
    @State private var store: GuestClaimStore

    init(
        fixture: GuestClaimFixtureState,
        forceReducedMotion: Bool
    ) {
        self.fixture = fixture
        self.forceReducedMotion = forceReducedMotion
        _store = State(
            initialValue: GuestClaimStore(
                authority: GuestClaimFixtureData.authority,
                authenticator: UnavailableGuestAccountAuthenticator(),
                service: GuestClaimFixtureService(fixture: fixture),
                attemptStore: MemoryGuestClaimAttemptStore()
            )
        )
    }

    var body: some View {
        NavigationStack {
            GuestClaimView(
                store: store,
                sessionSource: UnavailableAccountEntrySessionSource(),
                listingProjection: GuestClaimFixtureData.projection,
                accountEntryPresentation: .fixture,
                forceReducedMotion: forceReducedMotion,
                backToDraft: {},
                continueToItem: { _ in },
                startNewItem: {}
            )
        }
        .task {
            guard fixture != .cancel else { return }
            let userID = "user_743_supported_fixture"
            guard let scopeProof = ItemRunSubmissionPrincipalScopeProof(
                verifiedClerkSubject: userID
            ) else {
                return
            }
            await store.beginSupportedAuthentication()
            let bearer = PrincipalBoundBearer(
                bearerToken: "fixture-bearer-never-sent",
                scopeProof: scopeProof
            )
            await store.qualifiedSession(
                AccountEntryQualifiedSession(
                    userID: userID,
                    bearer: bearer,
                    refreshBearer: { bearer }
                )
            )
        }
    }
}

@MainActor
struct GuestClaimFixtureAccountEntryView: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Account entry")
                .snapListTypography(.displayTitle)
                .accessibilityAddTraits(.isHeader)
            Text("Secret-free supported account-entry fixture")
                .snapListTypography(.body)
            SnapListSecondaryButton(
                title: "Close",
                action: dismiss.callAsFunction
            )
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(SnapListMetrics.screenGutter)
        .background(SnapListColorToken.canvas.color)
        .accessibilityIdentifier("guest-claim.account-entry-fixture")
    }
}
#endif
