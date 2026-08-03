import Foundation

struct ResponseMeta: Codable, Equatable {
    let requestId: String
}

struct HealthEnvelope: Codable, Equatable {
    struct DataPayload: Codable, Equatable {
        let apiVersion: String
        let status: String
    }

    let data: DataPayload
    let meta: ResponseMeta
}

struct SessionEnvelope: Codable, Equatable {
    struct DataPayload: Codable, Equatable {
        let userId: String
    }

    let data: DataPayload
    let meta: ResponseMeta
}

struct MobileItemSubmissionEnvelope: Codable, Equatable {
    struct PhotoIdentity: Codable, Equatable {
        let kind: String
        let fingerprint: String
    }

    struct PhotoReceipt: Codable, Equatable {
        let ordinal: Int
        let contentSha256: String
        let byteLength: Int
        let mediaType: String
    }

    struct VoiceReceipt: Codable, Equatable {
        let version: Int
        let contentSha256: String
        let byteLength: Int
        let durationMs: Int
        let mediaType: String
    }

    struct DataPayload: Codable, Equatable {
        let itemId: UUID
        let runId: UUID
        let status: String
        let stage: String
        let photoIdentity: PhotoIdentity
        let photos: [PhotoReceipt]
        let voiceContext: VoiceReceipt?

        init(
            itemId: UUID,
            runId: UUID,
            status: String,
            stage: String,
            photoIdentity: PhotoIdentity,
            photos: [PhotoReceipt],
            voiceContext: VoiceReceipt? = nil
        ) {
            self.itemId = itemId
            self.runId = runId
            self.status = status
            self.stage = stage
            self.photoIdentity = photoIdentity
            self.photos = photos
            self.voiceContext = voiceContext
        }
    }

    let data: DataPayload
    let meta: ResponseMeta
}

struct RevenueCatConfigurationEnvelope: Codable, Equatable {
    struct DataPayload: Codable, Equatable {
        let configured: Bool
        let appUserId: String
        let publicSdkKey: String?
        let entitlementId: String?
        let monthlyProductId: String?
        let offeringId: String?
        let transitionState: BillingSourceTransitionState?
        let legacyStripeStatus: String?

        var subscriptionConfiguration: NativeSubscriptionConfiguration {
            .init(
                configured: configured,
                appUserID: appUserId,
                publicSDKKey: publicSdkKey,
                entitlementID: entitlementId,
                monthlyProductID: monthlyProductId,
                offeringID: offeringId,
                transitionState: transitionState,
                legacyStripeStatus: legacyStripeStatus
            )
        }
    }

    let data: DataPayload
    let meta: ResponseMeta
}

struct AiItemEntitlementEnvelope: Codable, Equatable {
    struct DataPayload: Codable, Equatable {
        let billingSource: VerifiedSubscriptionSource
        let status: VerifiedSubscriptionStatus
        let remainingItems: Int
        let periodStart: String?
        let periodEnd: String?
        let gracePeriodEnd: String?
        let transitionState: BillingSourceTransitionState?
        let legacyStripeStatus: String?

        var serverVerifiedSubscription: ServerVerifiedSubscription {
            return .init(
                source: billingSource,
                status: status,
                remainingItems: remainingItems,
                periodStart: periodStart.flatMap(Self.parseServerDate),
                periodEnd: periodEnd.flatMap(Self.parseServerDate),
                gracePeriodEnd: gracePeriodEnd.flatMap(Self.parseServerDate),
                transitionState: transitionState,
                legacyStripeStatus: legacyStripeStatus
            )
        }

        private static func parseServerDate(_ value: String) -> Date? {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = formatter.date(from: value) { return date }
            formatter.formatOptions = [.withInternetDateTime]
            return formatter.date(from: value)
        }
    }

    let data: DataPayload
    let meta: ResponseMeta
}

/**
 Issue #524. The server's answer for one included-offer redemption claim.

 Every case is a typed answer, including the refusals. `401`, `404`, and `409`
 all carry a body the seller-facing flow must read, so this path cannot treat a
 non-2xx status as a transport failure the way the rest of the client does.
 */
enum IncludedOfferOutcome: Equatable, Sendable {
    case queued(claimID: String, retryAfterMs: Int)
    case deviceTokenRequired(claimID: String, tokenDeadlineAt: String)
    case reserved(claimID: String)
    case deniedDeviceConsumed(claimID: String)
    case deniedAccountConsumed
    case deniedAppleUnavailable(claimID: String)
    case retryRequired(claimID: String, reason: String, retryAfterMs: Int)
    case invalidProof(code: String)
    case claimNotFound
}

extension IncludedOfferOutcome: Decodable {
    private enum CodingKeys: String, CodingKey {
        case claimId
        case code
        case reason
        case retryAfterMs
        case status
        case tokenDeadlineAt
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let status = try container.decode(String.self, forKey: .status)
        func claimID() throws -> String {
            try container.decode(String.self, forKey: .claimId)
        }
        switch status {
        case "queued":
            self = .queued(
                claimID: try claimID(),
                retryAfterMs: try container.decode(Int.self, forKey: .retryAfterMs)
            )
        case "device_token_required":
            self = .deviceTokenRequired(
                claimID: try claimID(),
                tokenDeadlineAt: try container.decode(
                    String.self,
                    forKey: .tokenDeadlineAt
                )
            )
        case "reserved":
            self = .reserved(claimID: try claimID())
        case "denied_device_consumed":
            self = .deniedDeviceConsumed(claimID: try claimID())
        case "denied_account_consumed":
            self = .deniedAccountConsumed
        case "denied_apple_unavailable":
            self = .deniedAppleUnavailable(claimID: try claimID())
        case "retry_required":
            self = .retryRequired(
                claimID: try claimID(),
                reason: try container.decode(String.self, forKey: .reason),
                retryAfterMs: try container.decode(Int.self, forKey: .retryAfterMs)
            )
        case "invalid_proof":
            self = .invalidProof(
                code: try container.decode(String.self, forKey: .code)
            )
        case "claim_not_found":
            self = .claimNotFound
        default:
            // Fail closed. A status this build does not know is not a grant, and
            // guessing one would spend an included run the fence never released.
            throw DecodingError.dataCorruptedError(
                forKey: .status,
                in: container,
                debugDescription:
                    "Unrecognized included-offer redemption status \(status)."
            )
        }
    }
}

struct IncludedOfferEnvelope: Decodable {
    let data: IncludedOfferOutcome
    let meta: ResponseMeta
}

/** The proof bytes exactly as `appAttestProofSchema` names them. */
struct AppAttestProofPayload: Encodable, Equatable, Sendable {
    let assertionObject: String
    let challengeId: String
    let keyId: String

    init(assertionObject: String, challengeId: String, keyId: String) {
        self.assertionObject = assertionObject
        self.challengeId = challengeId
        self.keyId = keyId
    }

    init(_ proof: AppAttestAssertionProof) {
        self.init(
            assertionObject: proof.assertionObject.base64EncodedString(),
            challengeId: proof.challengeID.uuidString,
            keyId: proof.keyID
        )
    }
}

struct IncludedOfferRedeemBody: Encodable {
    let appAttest: AppAttestProofPayload
}

struct IncludedOfferDeviceTokenBody: Encodable {
    let appAttest: AppAttestProofPayload
    let deviceToken: String
}

enum ContractOnlyOperation: CaseIterable, Equatable {
    static let allCases: [ContractOnlyOperation] = []

    var operationID: String {
        fatalError("No contract-only mobile API operation is currently declared.")
    }

    var ownerIssue: Int {
        fatalError("No contract-only mobile API operation is currently declared.")
    }
}

struct ContractOnlyFixture: Equatable {
    let operation: ContractOnlyOperation
    let ownerIssue: Int
    let note: String

    static func metadata(for operation: ContractOnlyOperation) -> ContractOnlyFixture {
        ContractOnlyFixture(
            operation: operation,
            ownerIssue: operation.ownerIssue,
            note: "Schema fixture only. No server behavior or network request is executed."
        )
    }
}
