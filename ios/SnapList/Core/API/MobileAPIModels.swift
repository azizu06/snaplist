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

enum ContractOnlyOperation: String, CaseIterable, Codable {
    case verifyGuestAttestation
    case createItemRun
    case getRun
    case retryRun
    case cancelRun
    case getAiItemEntitlement
    case createEbayOauthSession
    case completeEbayOauthCallback
    case receiveStoreKitNotification

    var ownerIssue: Int {
        switch self {
        case .verifyGuestAttestation: 174
        case .createItemRun, .getRun: 159
        case .retryRun, .cancelRun: 161
        case .getAiItemEntitlement: 168
        case .createEbayOauthSession, .completeEbayOauthCallback: 17
        case .receiveStoreKitNotification: 173
        }
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
