import CryptoKit
import Foundation
import XCTest
@testable import SnapList

final class GuestRecoveryAuthorityTests: XCTestCase {
    private let recoveryID = UUID(
        uuidString: "63810000-0000-4000-8000-000000000001"
    )!
    private let rawToken = Data(repeating: 7, count: 32)
        .base64EncodedString()

    func testProductionKeychainMintPersistsExactlyThirtyTwoRandomBytes()
        async throws {
        let firstStore = KeychainGuestRecoveryCredentialStore()
        let identity = try await firstStore.mintCredential()
        addTeardownBlock {
            try? await KeychainGuestRecoveryCredentialStore().purge(
                recoveryID: identity.recoveryID
            )
        }

        let reloaded = try await KeychainGuestRecoveryCredentialStore()
            .credential(recoveryID: identity.recoveryID)
        let token = try XCTUnwrap(reloaded?.recoveryToken)
        var encoded = token
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        encoded += String(repeating: "=", count: (4 - encoded.count % 4) % 4)
        let bytes = try XCTUnwrap(Data(base64Encoded: encoded))

        XCTAssertEqual(bytes.count, 32)
        XCTAssertEqual(reloaded?.recoveryID, identity.recoveryID)
        XCTAssertEqual(
            SHA256.hash(data: Data(token.utf8))
                .map { String(format: "%02x", $0) }
                .joined(),
            identity.recoveryTokenHash
        )
        let contains = try await firstStore.contains(identity)
        XCTAssertTrue(contains)
    }

    func testConcurrentProductionKeychainMintsPreserveEveryCredential()
        async throws {
        let mintCount = 24
        let gate = GuestRecoveryMintStartGate(participantCount: mintCount)
        let tasks = (0..<mintCount).map { _ in
            let store = KeychainGuestRecoveryCredentialStore()
            return Task {
                await gate.wait()
                return try await store.mintCredential()
            }
        }
        await gate.waitUntilReady()
        await gate.release()

        var results: [Result<GuestRecoverySubmissionIdentity, Error>] = []
        for task in tasks {
            results.append(await task.result)
        }
        let identities = results.compactMap { try? $0.get() }
        addTeardownBlock {
            for identity in identities {
                try? await KeychainGuestRecoveryCredentialStore().purge(
                    recoveryID: identity.recoveryID
                )
            }
        }
        for result in results {
            _ = try result.get()
        }

        let reloadedStore = KeychainGuestRecoveryCredentialStore()
        for identity in identities {
            let reloaded = try await reloadedStore.credential(
                recoveryID: identity.recoveryID
            )
            XCTAssertEqual(reloaded?.submissionIdentity, identity)
        }
        XCTAssertEqual(identities.count, mintCount)
    }

    func testProductionKeychainPurgesAnExpiredBoundCredential()
        async throws {
        let store = KeychainGuestRecoveryCredentialStore()
        let identity = try await store.mintCredential()
        addTeardownBlock {
            try? await KeychainGuestRecoveryCredentialStore().purge(
                recoveryID: identity.recoveryID
            )
        }
        try await store.bind(
            identity,
            itemID: UUID(),
            runID: UUID(),
            photoIdentity: GuestPhotoIdentity(
                kind: "content_sha256_set_v1",
                fingerprint: String(repeating: "a", count: 64)
            )
        )
        try await store.setExpiry(
            recoveryID: identity.recoveryID,
            expiresAt: Date(timeIntervalSince1970: 1)
        )

        let contains = try await store.contains(identity)
        let reloaded = try await store.credential(
            recoveryID: identity.recoveryID
        )
        XCTAssertFalse(contains)
        XCTAssertNil(reloaded)
    }

    func testProductionClaimAuthoritySurvivesAnIndependentStoreRelaunch()
        async throws {
        let authority = GuestClaimAuthority(
            recoveryID: UUID(),
            recoveryToken: rawToken,
            itemID: UUID(),
            runID: UUID(),
            draftID: UUID(),
            reviewRevision: UUID(),
            photoIdentity: GuestPhotoIdentity(
                kind: "content_sha256_set_v1",
                fingerprint: String(repeating: "d", count: 64)
            )
        )
        let firstStore = KeychainGuestClaimAuthorityStore()
        try await firstStore.save(authority, listingID: authority.draftID)
        addTeardownBlock {
            try? await KeychainGuestClaimAuthorityStore().purge(
                recoveryID: authority.recoveryID
            )
        }

        let relaunched = try await KeychainGuestClaimAuthorityStore()
            .authority(listingID: authority.draftID)

        XCTAssertEqual(relaunched, authority)
    }

    func testGuestMultipartCarriesRecoveryIDAndHashButNeverRawToken()
        throws {
        let tokenHash = SHA256.hash(data: Data(rawToken.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
        let attempt = ItemRunSubmissionAttempt(
            idempotencyKey: UUID(
                uuidString: "63810000-0000-4000-8000-000000000002"
            )!,
            photos: [
                ItemRunSubmissionPhoto(
                    photoID: UUID(),
                    ordinal: 0,
                    contentSha256: String(repeating: "a", count: 64),
                    byteLength: 4,
                    mediaType: .jpeg
                ),
            ],
            guestRecoveryIdentity: GuestRecoverySubmissionIdentity(
                recoveryID: recoveryID,
                recoveryTokenHash: tokenHash
            )
        )
        let body = ItemRunSubmissionMultipart.body(
            for: ItemRunSubmissionPayload(
                attempt: attempt,
                photoData: [Data([0xFF, 0xD8, 0xFF, 0xD9])]
            ),
            boundary: "guest-recovery-boundary"
        )
        let text = String(decoding: body, as: UTF8.self)

        XCTAssertTrue(text.contains("name=\"recoveryId\""))
        XCTAssertTrue(text.contains(recoveryID.uuidString.lowercased()))
        XCTAssertTrue(text.contains("name=\"recoveryTokenHash\""))
        XCTAssertTrue(text.contains(tokenHash))
        XCTAssertFalse(text.contains(rawToken))
        XCTAssertFalse(
            String(decoding: try JSONEncoder().encode(attempt), as: UTF8.self)
                .contains(rawToken)
        )
    }

    func testReadyReviewAssemblesClaimAuthorityLocally() throws {
        let binding = try JSONDecoder().decode(
            ListingReviewBinding.self,
            from: Data(
                """
                {
                  "runId":"63810000-0000-4000-8000-000000000003",
                  "itemId":"63810000-0000-4000-8000-000000000004",
                  "listingId":"63810000-0000-4000-8000-000000000005",
                  "reviewContentRevision":"63810000-0000-4000-8000-000000000006",
                  "reviewRevision":"63810000-0000-4000-8000-000000000007"
                }
                """.utf8
            )
        )
        let credential = GuestRecoveryCredential(
            recoveryID: recoveryID,
            recoveryToken: rawToken,
            recoveryTokenHash: String(repeating: "b", count: 64),
            itemID: binding.itemID,
            runID: binding.runID,
            photoIdentity: GuestPhotoIdentity(
                kind: "content_sha256_set_v1",
                fingerprint: String(repeating: "c", count: 64)
            )
        )

        XCTAssertEqual(
            GuestClaimAuthorityAssembler.assemble(
                credential: credential,
                binding: binding
            ),
            GuestClaimAuthority(
                recoveryID: recoveryID,
                recoveryToken: rawToken,
                itemID: binding.itemID,
                runID: binding.runID,
                draftID: binding.listingID,
                reviewRevision: binding.reviewRevision,
                photoIdentity: credential.photoIdentity!
            )
        )
    }
}

private actor GuestRecoveryMintStartGate {
    private let participantCount: Int
    private var readyContinuation: CheckedContinuation<Void, Never>?
    private var waiters: [CheckedContinuation<Void, Never>] = []

    init(participantCount: Int) {
        self.participantCount = participantCount
    }

    func wait() async {
        await withCheckedContinuation { continuation in
            waiters.append(continuation)
            if waiters.count == participantCount {
                readyContinuation?.resume()
                readyContinuation = nil
            }
        }
    }

    func waitUntilReady() async {
        guard waiters.count < participantCount else { return }
        await withCheckedContinuation { readyContinuation = $0 }
    }

    func release() {
        let continuations = waiters
        waiters.removeAll()
        for continuation in continuations {
            continuation.resume()
        }
    }
}
