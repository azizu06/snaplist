#if DEBUG
import Foundation

actor HomeFixtureRepository: HomeRepository {
    private let model: HomeModel
    private let stream: AsyncThrowingStream<HomeModel, Error>
    private let continuation: AsyncThrowingStream<HomeModel, Error>.Continuation

    init(model: HomeModel) {
        self.model = model
        let pair = AsyncThrowingStream<HomeModel, Error>.makeStream()
        stream = pair.stream
        continuation = pair.continuation
    }

    func fetchHome() async throws -> HomeModel { model }

    func updates() async -> AsyncThrowingStream<HomeModel, Error> { stream }
}

enum HomeFixtures {
    static func model(for state: ApprovedVisualStateID?) -> HomeModel {
        switch state {
        case .homeEmpty:
            empty
        case .homeAttention:
            attention
        case .homeSearch:
            search
        case .homeActive, .none:
            active
        default:
            active
        }
    }

    static let active = HomeModel(
        revision: 101,
        unreadNotificationCount: 1,
        summary: HomeSummary(active: 8, drafts: 2, orders: 1),
        attention: activeAttentionTasks,
        currentRun: HomeCurrentRun(
            id: id(20),
            itemTitle: "Canon film camera · updated just now",
            stageLabel: "Finding recent sold comps",
            reassurance: "You can leave — we’ll notify you when it’s ready.",
            progress: nil
        ),
        readyToFinish: [
            HomeFinishItem(id: id(30), title: "Keychron K4 Keyboard", detail: "Draft · No price yet"),
            HomeFinishItem(id: id(31), title: "Nike Dunk Low", detail: "Draft · Condition not set")
        ],
        listings: listings
    )

    static let empty = HomeModel(
        revision: 102,
        sellerState: .newSeller,
        unreadNotificationCount: 0,
        summary: HomeSummary(active: 0, drafts: 0, orders: 0),
        attention: [],
        currentRun: nil,
        readyToFinish: [],
        listings: []
    )

    static let attention = HomeModel(
        revision: 103,
        unreadNotificationCount: 6,
        summary: HomeSummary(active: 8, drafts: 2, orders: 2),
        attention: attentionTasks,
        currentRun: HomeCurrentRun(
            id: id(21),
            itemTitle: "Sony lens · updated just now",
            stageLabel: "Writing your listing",
            reassurance: "You can leave — we’ll notify you when it’s ready.",
            progress: nil
        ),
        readyToFinish: [],
        listings: []
    )

    static let search = HomeModel(
        revision: 104,
        unreadNotificationCount: 0,
        summary: HomeSummary(active: 2, drafts: 2, orders: 1),
        attention: [],
        currentRun: nil,
        readyToFinish: [],
        listings: listings,
        recentSearches: ["nike sneakers", "film camera"]
    )

    private static let attentionTasks = [
        HomeAttentionTask(
            id: id(1), itemTitle: "Sony WH-1000XM4", kind: .shipping,
            status: "Ship by tomorrow", detail: "eBay · Sold 2h ago",
            actionLabel: "View order", destination: .order(id(101))
        ),
        HomeAttentionTask(
            id: id(2), itemTitle: "Nike Dunk Low", kind: .shipping,
            status: "Ship by Thursday", detail: "eBay · Sold yesterday",
            actionLabel: "View order", destination: .order(id(102))
        ),
        HomeAttentionTask(
            id: id(3), itemTitle: "Keychron K4", kind: .message,
            status: "Buyer asked a question", detail: "eBay · 4h ago",
            actionLabel: "Reply", destination: .conversation(id(103))
        ),
        HomeAttentionTask(
            id: id(4), itemTitle: "Levi’s 501 jeans", kind: .offer,
            status: "Offer expires in 6h", detail: "eBay · Offer $38",
            actionLabel: "Review", destination: .conversation(id(104))
        ),
        HomeAttentionTask(
            id: id(5), itemTitle: "IKEA lamp", kind: .warning,
            status: "Couldn’t publish", detail: "eBay · Missing category",
            actionLabel: "Review", destination: .publishIssue(id(105))
        ),
        HomeAttentionTask(
            id: id(6), itemTitle: "Canon AE-1 camera", kind: .pricing,
            status: "Weak price evidence", detail: "Only 2 sold comps found",
            actionLabel: "Set price", destination: .draft(id(106))
        )
    ]

    private static let activeAttentionTasks = [
        HomeAttentionTask(
            id: id(11), itemTitle: "Sony WH-1000XM4", kind: .shipping,
            status: "Sold · Ship by tomorrow", detail: "eBay · Sold 2h ago",
            actionLabel: "View order", destination: .order(id(101))
        ),
        HomeAttentionTask(
            id: id(12), itemTitle: "Keychron K4", kind: .message,
            status: "Buyer asked a question", detail: "eBay · “Does it work on Mac?” · 4h ago",
            actionLabel: "Reply", destination: .conversation(id(103))
        ),
        HomeAttentionTask(
            id: id(13), itemTitle: "IKEA lamp", kind: .warning,
            status: "Couldn’t publish · Missing category", detail: "eBay · Attempted yesterday",
            actionLabel: "Review", destination: .publishIssue(id(105))
        )
    ]

    private static let listings = [
        HomeListing(
            id: id(40), title: "Sony WH-1000XM4 headphones", lifecycle: .needsAttention,
            statusLabel: "Needs attention", detail: "eBay · Ship by tomorrow", price: "$188"
        ),
        HomeListing(
            id: id(41), title: "Bose QC earbuds headset", lifecycle: .active,
            statusLabel: "Live", detail: "eBay · 8 views", price: "$96"
        ),
        HomeListing(
            id: id(42), title: "Canon AE-1 film camera", lifecycle: .active,
            statusLabel: "Live", detail: "eBay · Listed 2d ago", price: "$210"
        ),
        HomeListing(
            id: id(43), title: "Levi’s 501 jeans", lifecycle: .sold,
            statusLabel: "Sold", detail: "eBay · Sold yesterday", price: "$42"
        ),
        HomeListing(
            id: id(44), title: "Keychron K4 Keyboard", lifecycle: .draft,
            statusLabel: "Draft", detail: "Draft · No price yet", price: nil
        ),
        HomeListing(
            id: id(45), title: "Nike Dunk Low", lifecycle: .draft,
            statusLabel: "Draft", detail: "Draft · Condition not set", price: nil
        )
    ]

    private static func id(_ suffix: Int) -> UUID {
        UUID(uuidString: String(format: "20800000-0000-4000-8000-%012d", suffix))!
    }
}
#endif
