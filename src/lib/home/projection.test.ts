import { describe, expect, it } from "vitest";
import {
  assembleHomeProjection,
  createSupabaseHomeProjectionReader,
} from "./projection";

describe("native Seller Home projection", () => {
  it("exposes an actionable buyer question to Home search with its exact conversation destination", () => {
    const updatedAt = "2026-07-20T05:00:00.000Z";
    const itemID = "29600000-0000-4000-8000-000000000001";
    const listingID = "29600000-0000-4000-8000-000000000002";
    const conversationID = "29600000-0000-4000-8000-000000000003";

    const projection = assembleHomeProjection({
      notifications: [
        {
          id: "29600000-0000-4000-8000-000000000004",
          user_id: "user_native",
          kind: "buyer_message",
          title: "New question on Keychron K4 Mechanical Keyboard",
          body: "Does it work on Mac?",
          item_id: itemID,
          listing_id: listingID,
          source_message_id: conversationID,
          read_at: null,
          created_at: updatedAt,
        },
      ],
      unreadNotificationCount: 1,
      activeListingCount: 1,
      draftListingCount: 0,
      runs: [],
      listings: [
        {
          id: listingID,
          user_id: "user_native",
          item_id: itemID,
          title: "Keychron K4 Mechanical Keyboard",
          status: "published",
          created_at: updatedAt,
          updated_at: updatedAt,
          listed_price: 96,
        },
      ],
      items: [
        {
          id: itemID,
          user_id: "user_native",
          attributes: { brand: "Keychron", model: "K4 Mechanical Keyboard" },
          photos: [],
          price_override: null,
          cost_basis: null,
          created_at: updatedAt,
          updated_at: updatedAt,
        },
      ],
      predictions: [],
      messageRoots: [
        {
          id: conversationID,
          user_id: "user_native",
          item_id: itemID,
          listing_id: listingID,
          direction: "inbound",
          marketplace: "ebay",
          body: "Does it work on Mac?",
          status: "drafted",
          created_at: updatedAt,
          updated_at: updatedAt,
        },
      ],
      messageReplies: [],
      now: new Date("2026-07-20T06:00:00.000Z"),
    } as Parameters<typeof assembleHomeProjection>[0]);

    expect(projection.listings).toContainEqual({
      id: conversationID,
      title: "Keychron K4 Mechanical Keyboard",
      lifecycle: "needsAttention",
      statusLabel: "Buyer question",
      detail: "eBay · “Does it work on Mac?”",
      price: "$96",
      destination: { kind: "conversation", id: conversationID },
    });
  });

  it("moves a delivered buyer conversation out of attention and keeps it in All as Replied", () => {
    const updatedAt = "2026-07-20T05:00:00.000Z";
    const itemID = "29600000-0000-4000-8000-000000000011";
    const listingID = "29600000-0000-4000-8000-000000000012";
    const conversationID = "29600000-0000-4000-8000-000000000013";

    const projection = assembleHomeProjection({
      notifications: [
        {
          id: "29600000-0000-4000-8000-000000000014",
          user_id: "user_native",
          kind: "buyer_message",
          title: "New question on Keychron K4 Mechanical Keyboard",
          body: "Does it work on Mac?",
          item_id: itemID,
          listing_id: listingID,
          source_message_id: conversationID,
          read_at: null,
          created_at: updatedAt,
        },
      ],
      unreadNotificationCount: 0,
      activeListingCount: 1,
      draftListingCount: 0,
      runs: [],
      listings: [
        {
          id: listingID,
          user_id: "user_native",
          item_id: itemID,
          title: "Keychron K4 Mechanical Keyboard",
          status: "published",
          created_at: updatedAt,
          updated_at: updatedAt,
          listed_price: 96,
        },
      ],
      items: [
        {
          id: itemID,
          user_id: "user_native",
          attributes: { brand: "Keychron", model: "K4 Mechanical Keyboard" },
          photos: [],
          price_override: null,
          cost_basis: null,
          created_at: updatedAt,
          updated_at: updatedAt,
        },
      ],
      predictions: [],
      messageRoots: [
        {
          id: conversationID,
          user_id: "user_native",
          item_id: itemID,
          listing_id: listingID,
          direction: "inbound",
          marketplace: "ebay",
          body: "Does it work on Mac?",
          status: "sent",
          created_at: updatedAt,
          updated_at: updatedAt,
        },
      ],
      messageReplies: [
        {
          id: "29600000-0000-4000-8000-000000000017",
          user_id: "user_native",
          reply_to: conversationID,
          direction: "outbound",
          reply_kind: "reply",
          marketplace: "ebay",
          delivery_status: "pending",
          external_delivery_id: null,
          sent_at: "2026-07-20T05:30:00.000Z",
          created_at: "2026-07-20T05:30:00.000Z",
          updated_at: "2026-07-20T05:30:00.000Z",
        },
        {
          id: "29600000-0000-4000-8000-000000000018",
          user_id: "user_native",
          reply_to: conversationID,
          direction: "outbound",
          reply_kind: "reply",
          marketplace: "ebay",
          delivery_status: "sending",
          external_delivery_id: null,
          sent_at: "2026-07-20T05:40:00.000Z",
          created_at: "2026-07-20T05:40:00.000Z",
          updated_at: "2026-07-20T05:40:00.000Z",
        },
        {
          id: "29600000-0000-4000-8000-000000000019",
          user_id: "user_native",
          reply_to: conversationID,
          direction: "outbound",
          reply_kind: "reply",
          marketplace: "ebay",
          delivery_status: "failed",
          external_delivery_id: null,
          sent_at: "2026-07-20T05:50:00.000Z",
          created_at: "2026-07-20T05:50:00.000Z",
          updated_at: "2026-07-20T05:50:00.000Z",
        },
        {
          id: "29600000-0000-4000-8000-000000000020",
          user_id: "user_native",
          reply_to: conversationID,
          direction: "outbound",
          reply_kind: "reply",
          marketplace: "ebay",
          delivery_status: "delivered",
          external_delivery_id: null,
          sent_at: "2026-07-20T05:30:00.000Z",
          created_at: "2026-07-20T05:30:00.000Z",
          updated_at: "2026-07-20T05:30:00.000Z",
        },
        {
          id: "29600000-0000-4000-8000-000000000015",
          user_id: "user_native",
          reply_to: conversationID,
          direction: "outbound",
          reply_kind: null,
          marketplace: "ebay",
          delivery_status: "delivered",
          external_delivery_id: "ebay-reply-older",
          sent_at: "2026-07-20T03:00:00.000Z",
          created_at: "2026-07-20T03:00:00.000Z",
          updated_at: "2026-07-20T03:00:00.000Z",
        },
        {
          id: "29600000-0000-4000-8000-000000000016",
          user_id: "user_native",
          reply_to: conversationID,
          direction: "outbound",
          reply_kind: "reply",
          marketplace: "ebay",
          delivery_status: "delivered",
          external_delivery_id: "ebay-reply-latest",
          sent_at: "2026-07-20T05:00:00.000Z",
          created_at: "2026-07-20T05:00:00.000Z",
          updated_at: "2026-07-20T05:00:00.000Z",
        },
      ],
      now: new Date("2026-07-20T06:00:00.000Z"),
    } as Parameters<typeof assembleHomeProjection>[0]);

    expect(projection.attention).toEqual([]);
    expect(projection.listings).toContainEqual({
      id: conversationID,
      title: "Keychron K4 Mechanical Keyboard",
      lifecycle: "resolvedConversation",
      statusLabel: "Replied",
      detail: "eBay · You replied 1h ago",
      price: "$96",
      destination: { kind: "conversation", id: conversationID },
    });
  });

  it("omits a buyer notification when its tenant-owned conversation root is unavailable", () => {
    const projection = assembleHomeProjection({
      notifications: [
        {
          id: "29600000-0000-4000-8000-000000000024",
          user_id: "user_native",
          kind: "buyer_message",
          title: "New buyer question",
          body: "Is this still available?",
          item_id: "29600000-0000-4000-8000-000000000021",
          listing_id: "29600000-0000-4000-8000-000000000022",
          source_message_id: "29600000-0000-4000-8000-000000000023",
          read_at: null,
          created_at: "2026-07-20T05:00:00.000Z",
        },
      ],
      unreadNotificationCount: 1,
      activeListingCount: 0,
      draftListingCount: 0,
      runs: [],
      listings: [],
      items: [],
      predictions: [],
      messageRoots: [],
      messageReplies: [],
    });

    expect(projection.attention).toEqual([]);
    expect(projection.listings).toEqual([]);
  });

  it("maps durable RLS rows into one truthful typed Home model", () => {
    const updatedAt = "2026-07-17T13:00:00.000Z";
    const itemID = "20800000-0000-4000-8000-000000000040";
    const listingID = "20800000-0000-4000-8000-000000000041";
    const projection = assembleHomeProjection({
      notifications: [
        {
          id: "20800000-0000-4000-8000-000000000042",
          user_id: "user_native",
          kind: "listing_failed",
          title: "Canon AE-1 needs review",
          body: "eBay needs one more category detail.",
          item_id: itemID,
          listing_id: listingID,
          source_message_id: null,
          read_at: null,
          created_at: updatedAt,
        },
        {
          id: "20800000-0000-4000-8000-000000000044",
          user_id: "user_native",
          kind: "buyer_message",
          title: "Buyer asked about the Canon AE-1",
          body: "Does the light meter work?",
          item_id: itemID,
          listing_id: listingID,
          source_message_id: "20800000-0000-4000-8000-000000000045",
          read_at: null,
          created_at: updatedAt,
        },
      ],
      unreadNotificationCount: 2,
      activeListingCount: 1,
      draftListingCount: 0,
      runs: [
        {
          id: "20800000-0000-4000-8000-000000000043",
          user_id: "user_native",
          item_id: itemID,
          listing_id: listingID,
          status: "running",
          stage: "pricing",
          attempt_count: 1,
          max_attempts: 3,
          safe_failure_message: null,
          retention_cleaned_at: null,
          updated_at: updatedAt,
        },
      ],
      listings: [
        {
          id: listingID,
          user_id: "user_native",
          item_id: itemID,
          title: "Canon AE-1 film camera",
          status: "published",
          created_at: updatedAt,
          updated_at: updatedAt,
          listed_price: 210,
        },
      ],
      items: [
        {
          id: itemID,
          user_id: "user_native",
          attributes: { brand: "Canon", model: "AE-1" },
          photos: [],
          price_override: null,
          cost_basis: null,
          created_at: updatedAt,
          updated_at: updatedAt,
        },
      ],
      predictions: [
        {
          id: "20800000-0000-4000-8000-000000000046",
          user_id: "user_native",
          item_id: itemID,
          price: 205,
          created_at: updatedAt,
        },
      ],
      messageRoots: [
        {
          id: "20800000-0000-4000-8000-000000000045",
          user_id: "user_native",
          item_id: itemID,
          listing_id: listingID,
          direction: "inbound",
          marketplace: "ebay",
          body: "Does the light meter work?",
          status: "drafted",
          created_at: updatedAt,
          updated_at: updatedAt,
        },
      ],
      messageReplies: [],
    });

    expect(projection).toMatchObject({
      sellerState: "active",
      unreadNotificationCount: 2,
      summary: { active: 1, drafts: 0, orders: null },
      currentRun: {
        id: "20800000-0000-4000-8000-000000000043",
        itemTitle: "Canon AE-1",
        stageLabel: "Finding recent sold comps",
        reassurance: "You can leave. We’ll notify you when it’s ready.",
        progress: null,
      },
      attention: [
        {
          kind: "warning",
          destination: { kind: "publishIssue", id: listingID },
        },
        {
          kind: "message",
          status: "Buyer asked a question",
          actionLabel: "Reply",
          destination: {
            kind: "conversation",
            id: "20800000-0000-4000-8000-000000000045",
          },
        },
      ],
      listings: [
        {
          id: itemID,
          title: "Canon AE-1",
          lifecycle: "active",
          statusLabel: "Live",
          price: "$210",
        },
        {
          id: "20800000-0000-4000-8000-000000000045",
          lifecycle: "needsAttention",
          statusLabel: "Buyer question",
          destination: {
            kind: "conversation",
            id: "20800000-0000-4000-8000-000000000045",
          },
        },
      ],
    });
    expect(projection.currentRun?.reassurance).not.toMatch(/[—–]/u);
  });

  it("filters active durable runs before applying the recent-run limit", async () => {
    const calls: string[] = [];
    const activeRun = {
      id: "20800000-0000-4000-8000-000000000043",
      user_id: "user_native",
      item_id: "20800000-0000-4000-8000-000000000040",
      listing_id: null,
      status: "running",
      stage: "pricing",
      attempt_count: 1,
      max_attempts: 3,
      safe_failure_message: null,
      retention_cleaned_at: null,
      updated_at: "2026-07-17T12:00:00.000Z",
    };
    const newerTerminalRuns = Array.from({ length: 8 }, (_, index) => ({
      ...activeRun,
      id: `20800000-0000-4000-8000-${String(index + 50).padStart(12, "0")}`,
      status: "succeeded",
      stage: "completed",
      updated_at: `2026-07-17T13:0${index}:00.000Z`,
    }));
    let activeFilterApplied = false;

    const client = makeProjectionClient({
      pipelineRuns() {
        const query = makeQuery({ data: newerTerminalRuns, error: null });
        query.in = (column: string, values: unknown[]) => {
          calls.push(`in:${column}:${values.join(",")}`);
          activeFilterApplied = true;
          return query;
        };
        query.order = () => {
          calls.push("order");
          return query;
        };
        query.limit = async () => {
          calls.push("limit");
          return {
            data: activeFilterApplied ? [activeRun] : newerTerminalRuns,
            error: null,
          };
        };
        return query;
      },
    });
    const reader = createSupabaseHomeProjectionReader(() => client as never);

    const projection = await reader.forSeller({
      userId: "user_native",
      bearerToken: "signed-jwt",
    });

    expect(projection.currentRun?.id).toBe(activeRun.id);
    expect(calls).toEqual([
      "in:status:queued,running,retrying",
      "order",
      "limit",
    ]);
  });

  it("reads only the deduplicated notification conversation roots and their canonical replies", async () => {
    const updatedAt = "2026-07-20T05:00:00.000Z";
    const itemID = "29600000-0000-4000-8000-000000000031";
    const listingID = "29600000-0000-4000-8000-000000000032";
    const conversationID = "29600000-0000-4000-8000-000000000033";
    const messageQueryCalls: string[] = [];
    const notification = {
      id: "29600000-0000-4000-8000-000000000034",
      user_id: "user_native",
      kind: "buyer_message",
      title: "New question on Keychron K4 Mechanical Keyboard",
      body: "Does it work on Mac?",
      item_id: itemID,
      listing_id: listingID,
      source_message_id: conversationID,
      read_at: null,
      created_at: updatedAt,
    };
    const client = makeProjectionClient({
      notifications: [notification, { ...notification, id: "29600000-0000-4000-8000-000000000035" }],
      listings: [
        {
          id: listingID,
          user_id: "user_native",
          item_id: itemID,
          title: "Keychron K4 Mechanical Keyboard",
          status: "published",
          created_at: updatedAt,
          updated_at: updatedAt,
          listed_price: 96,
        },
      ],
      items: [
        {
          id: itemID,
          user_id: "user_native",
          attributes: { brand: "Keychron", model: "K4 Mechanical Keyboard" },
          photos: [],
          price_override: null,
          cost_basis: null,
          created_at: updatedAt,
          updated_at: updatedAt,
        },
      ],
      messageRoots: [
        {
          id: conversationID,
          user_id: "user_native",
          item_id: itemID,
          listing_id: listingID,
          direction: "inbound",
          marketplace: "ebay",
          body: "Does it work on Mac?",
          status: "drafted",
          created_at: updatedAt,
          updated_at: updatedAt,
        },
      ],
      deliveredReplies: [
        {
          id: "29600000-0000-4000-8000-000000000036",
          user_id: "user_native",
          reply_to: conversationID,
          direction: "outbound",
          reply_kind: "reply",
          marketplace: "ebay",
          delivery_status: "failed",
          external_delivery_id: null,
          sent_at: "2026-07-20T05:50:00.000Z",
          created_at: "2026-07-20T05:50:00.000Z",
          updated_at: "2026-07-20T05:50:00.000Z",
        },
        {
          id: "29600000-0000-4000-8000-000000000037",
          user_id: "user_native",
          reply_to: conversationID,
          direction: "outbound",
          reply_kind: "followup",
          marketplace: "ebay",
          delivery_status: "delivered",
          external_delivery_id: "ebay-followup",
          sent_at: "2026-07-20T05:40:00.000Z",
          created_at: "2026-07-20T05:40:00.000Z",
          updated_at: "2026-07-20T05:40:00.000Z",
        },
        {
          id: "29600000-0000-4000-8000-000000000038",
          user_id: "user_native",
          reply_to: conversationID,
          direction: "outbound",
          reply_kind: "reply",
          marketplace: "ebay",
          delivery_status: "delivered",
          external_delivery_id: "ebay-canonical",
          sent_at: "2026-07-20T05:00:00.000Z",
          created_at: "2026-07-20T05:00:00.000Z",
          updated_at: "2026-07-20T05:00:00.000Z",
        },
      ],
      messageQueryCalls,
    });
    const reader = createSupabaseHomeProjectionReader(() => client as never);

    const projection = await reader.forSeller({
      userId: "user_native",
      bearerToken: "signed-jwt",
    });

    expect(projection.listings.filter((listing) => listing.destination)).toEqual([
      expect.objectContaining({
        id: conversationID,
        lifecycle: "resolvedConversation",
        statusLabel: "Replied",
      }),
    ]);
    expect(messageQueryCalls).toEqual([
      "messages:select:id,user_id,item_id,listing_id,direction,marketplace,body,status,created_at,updated_at",
      `messages:in:id:${conversationID}`,
      "messages:eq:direction:inbound",
      "messages:limit:1",
      "messages:select:id,user_id,reply_to,direction,reply_kind,marketplace,delivery_status,external_delivery_id,sent_at,created_at,updated_at",
      `messages:in:reply_to:${conversationID}`,
      "messages:eq:direction:outbound",
      "messages:eq:delivery_status:delivered",
      "messages:or:reply_kind.is.null,reply_kind.eq.reply",
      "messages:order:sent_at:descending",
      "messages:limit:1",
    ]);
  });

  it("fails the Home reader closed if a conversation row crosses the verified tenant boundary", async () => {
    const conversationID = "29600000-0000-4000-8000-000000000043";
    const client = makeProjectionClient({
      notifications: [
        {
          id: "29600000-0000-4000-8000-000000000044",
          user_id: "user_native",
          kind: "buyer_message",
          title: "New buyer question",
          body: "Is this still available?",
          item_id: null,
          listing_id: null,
          source_message_id: conversationID,
          read_at: null,
          created_at: "2026-07-20T05:00:00.000Z",
        },
      ],
      messageRoots: [
        {
          id: conversationID,
          user_id: "user_foreign",
          item_id: null,
          listing_id: null,
          direction: "inbound",
          marketplace: "ebay",
          body: "Is this still available?",
          status: "drafted",
          created_at: "2026-07-20T05:00:00.000Z",
          updated_at: "2026-07-20T05:00:00.000Z",
        },
      ],
    });
    const reader = createSupabaseHomeProjectionReader(() => client as never);

    await expect(
      reader.forSeller({ userId: "user_native", bearerToken: "signed-jwt" }),
    ).rejects.toThrow("Home projection crossed the verified tenant boundary.");
  });

  it("returns the exact unread count even when the presentation slice exceeds twenty", async () => {
    const notifications = Array.from({ length: 20 }, (_, index) => ({
      id: `20800000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
      user_id: "user_native",
      kind: "pipeline_completed",
      title: `Ready ${index}`,
      body: null,
      item_id: null,
      listing_id: null,
      read_at: null,
      created_at: `2026-07-17T13:${String(index).padStart(2, "0")}:00.000Z`,
    }));
    const client = makeProjectionClient({ notifications, unreadCount: 27 });
    const reader = createSupabaseHomeProjectionReader(() => client as never);

    const projection = await reader.forSeller({
      userId: "user_native",
      bearerToken: "signed-jwt",
    });

    expect(projection.unreadNotificationCount).toBe(27);
  });

  it("uses exact global counts and the complete current corpus from one bounded projection", async () => {
    const timestamp = "2026-07-17T13:00:00.000Z";
    const queryCalls: string[] = [];
    const rpcCalls: Array<{ name: string; arguments_: unknown }> = [];
    const items = Array.from({ length: 103 }, (_, index) => ({
      id: `20800000-0000-4000-8001-${String(index + 1).padStart(12, "0")}`,
      user_id: "user_native",
      attributes:
        index === 102
          ? { brand: "Globally searchable", model: "vintage lens" }
          : { brand: "Seller item", model: String(index + 1) },
      photos: [],
      price_override: null,
      cost_basis: null,
      created_at: timestamp,
      updated_at: timestamp,
    }));
    const listings = items.map((item, index) => ({
      id: `20800000-0000-4000-8002-${String(index + 1).padStart(12, "0")}`,
      user_id: "user_native",
      item_id: item.id,
      title: `Listing ${index + 1}`,
      status: index < 101 ? "published" : "draft",
      created_at: timestamp,
      updated_at: timestamp,
      listed_price: index < 101 ? 25 : null,
    }));
    const client = makeProjectionClient({
      listings,
      items,
      activeCount: 101,
      draftCount: 2,
      queryCalls,
      rpcCalls,
    });
    const reader = createSupabaseHomeProjectionReader(() => client as never);

    const projection = await reader.forSeller({
      userId: "user_native",
      bearerToken: "signed-jwt",
    });

    expect(projection.summary).toEqual({ active: 101, drafts: 2, orders: null });
    expect(projection.listings).toHaveLength(103);
    expect(
      projection.listings.some((listing) =>
        listing.title.toLowerCase().includes("globally searchable vintage lens"),
      ),
    ).toBe(true);
    expect(queryCalls).toEqual([
      "listings:count:published",
      "listings:count:draft,queued",
    ]);
    expect(rpcCalls).toEqual([
      { name: "get_home_current_item_projection", arguments_: undefined },
    ]);
  });

  it("uses the bounded projection's deterministic latest prediction", async () => {
    const targetItemID = "20800000-0000-4000-8004-999999999999";
    const timestamp = "2026-07-17T13:00:00.000Z";
    const rpcCalls: Array<{ name: string; arguments_: unknown }> = [];
    const client = makeProjectionClient({
      items: [
        {
          id: targetItemID,
          user_id: "user_native",
          attributes: { brand: "Boundary", model: "price" },
          photos: [],
          price_override: null,
          cost_basis: null,
          created_at: timestamp,
          updated_at: timestamp,
        },
      ],
      listings: [
        {
          id: "20800000-0000-4000-8005-999999999999",
          user_id: "user_native",
          item_id: targetItemID,
          title: "Boundary price",
          status: "published",
          created_at: timestamp,
          updated_at: timestamp,
          listed_price: null,
        },
      ],
      activeCount: 1,
      rpcCalls,
      currentItemProjection: {
        history_revision_at: timestamp,
        items: [
          {
            id: targetItemID,
            user_id: "user_native",
            attributes: { brand: "Boundary", model: "price" },
            photos: [],
            price_override: null,
            cost_basis: null,
            created_at: timestamp,
            updated_at: timestamp,
          },
        ],
        listings: [
          {
            id: "20800000-0000-4000-8005-999999999999",
            user_id: "user_native",
            item_id: targetItemID,
            title: "Boundary price",
            status: "published",
            created_at: timestamp,
            updated_at: timestamp,
            listed_price: null,
          },
        ],
        predictions: [
          {
            id: "20800000-0000-4000-8003-999999999999",
            user_id: "user_native",
            item_id: targetItemID,
            price: 200,
            created_at: timestamp,
          },
        ],
      },
    });
    const reader = createSupabaseHomeProjectionReader(() => client as never);

    const projection = await reader.forSeller({
      userId: "user_native",
      bearerToken: "signed-jwt",
    });

    expect(projection.listings.find((listing) => listing.id === targetItemID)?.price).toBe(
      "$200",
    );
    expect(rpcCalls).toEqual([
      { name: "get_home_current_item_projection", arguments_: undefined },
    ]);
  });

  it("reads the current Home item set without paging retained history", async () => {
    const timestamp = "2026-07-17T13:00:00.000Z";
    const itemID = "20800000-0000-4000-8006-000000000001";
    const rpcCalls: Array<{ name: string; arguments_: unknown }> = [];
    const client = makeProjectionClient({
      activeCount: 0,
      draftCount: 1,
      forbidHistoricalProjectionReads: true,
      rpcCalls,
      currentItemProjection: {
        history_revision_at: timestamp,
        items: [
          {
            id: itemID,
            user_id: "user_native",
            attributes: { brand: "Canon", model: "AE-1" },
            photos: [],
            price_override: null,
            cost_basis: null,
            created_at: timestamp,
            updated_at: timestamp,
          },
        ],
        listings: [
          {
            id: "20800000-0000-4000-8006-000000000002",
            user_id: "user_native",
            item_id: itemID,
            title: "Canon AE-1 film camera",
            status: "draft",
            created_at: timestamp,
            updated_at: timestamp,
            listed_price: null,
          },
        ],
        predictions: [
          {
            id: "20800000-0000-4000-8006-000000000003",
            user_id: "user_native",
            item_id: itemID,
            price: 205,
            created_at: timestamp,
          },
        ],
      },
    });
    const reader = createSupabaseHomeProjectionReader(() => client as never);

    const projection = await reader.forSeller({
      userId: "user_native",
      bearerToken: "signed-jwt",
    });

    expect(projection).toMatchObject({
      sellerState: "active",
      summary: { active: 0, drafts: 1, orders: null },
      listings: [
        {
          id: itemID,
          title: "Canon AE-1",
          lifecycle: "draft",
          statusLabel: "Draft",
          price: "$205",
        },
      ],
    });
    expect(rpcCalls).toEqual([
      { name: "get_home_current_item_projection", arguments_: undefined },
    ]);
  });
});

type QueryResult = { data: unknown[] | null; error: null; count?: number | null };
type FakeQuery = {
  select: (columns?: string, options?: { count?: string; head?: boolean }) => FakeQuery;
  eq: (column: string, value: unknown) => FakeQuery;
  in: (column: string, values: unknown[]) => FakeQuery;
  order: (column: string, options?: unknown) => FakeQuery;
  or: (filters: string) => FakeQuery;
  limit: (count: number) => Promise<QueryResult>;
  is: (column: string, value: unknown) => Promise<QueryResult>;
};

function makeQuery(result: QueryResult): FakeQuery {
  const query = {} as FakeQuery;
  query.select = () => query;
  query.eq = () => query;
  query.in = () => query;
  query.order = () => query;
  query.or = () => query;
  query.limit = async () => result;
  query.is = async () => result;
  return query;
}

function makeProjectionClient(input: {
  notifications?: unknown[];
  unreadCount?: number;
  pipelineRuns?: () => FakeQuery;
  listings?: unknown[];
  items?: unknown[];
  predictions?: unknown[];
  activeCount?: number;
  draftCount?: number;
  queryCalls?: string[];
  forbidHistoricalProjectionReads?: boolean;
  currentItemProjection?: unknown;
  rpcCalls?: Array<{ name: string; arguments_: unknown }>;
  messageRoots?: unknown[];
  deliveredReplies?: unknown[];
  messageQueryCalls?: string[];
}) {
  return {
    async rpc(name: string, arguments_?: unknown) {
      input.rpcCalls?.push({ name, arguments_ });
      return {
        data: input.currentItemProjection ?? {
          history_revision_at: null,
          listings: input.listings ?? [],
          items: input.items ?? [],
          predictions: input.predictions ?? [],
        },
        error: null,
      };
    },
    from(table: string) {
      if (
        input.forbidHistoricalProjectionReads &&
        ["items", "prediction_logs"].includes(table)
      ) {
        throw new Error(`Home attempted an unbounded ${table} history read.`);
      }
      if (table === "pipeline_runs" && input.pipelineRuns) return input.pipelineRuns();
      if (table === "notifications") {
        let isExactCount = false;
        const query = makeQuery({ data: input.notifications ?? [], error: null });
        query.select = (_columns, options) => {
          isExactCount = options?.head === true && options.count === "exact";
          return query;
        };
        query.is = async () => ({
          data: null,
          error: null,
          count: isExactCount ? (input.unreadCount ?? 0) : null,
        });
        return query;
      }
      if (table === "listings") {
        let exactCount = false;
        let status: unknown = null;
        let statuses: unknown[] = [];
        const query = makeQuery({ data: input.listings ?? [], error: null });
        query.select = (_columns, options) => {
          exactCount = options?.head === true && options.count === "exact";
          if (input.forbidHistoricalProjectionReads && !exactCount) {
            throw new Error("Home attempted an unbounded listings history read.");
          }
          return query;
        };
        query.eq = (column, value) => {
          if (column === "status") status = value;
          return query;
        };
        query.in = (column, values) => {
          if (column === "status") statuses = values;
          return query;
        };
        query.limit = async (count) => {
          if (exactCount) {
            input.queryCalls?.push(
              `listings:count:${
                status === "published" ? "published" : statuses.join(",")
              }`,
            );
            return {
              data: null,
              error: null,
              count:
                status === "published" || statuses.includes("published")
                  ? (input.activeCount ?? 0)
                  : (input.draftCount ?? 0),
            };
          }
          return { data: (input.listings ?? []).slice(0, count), error: null };
        };
        return query;
      }
      if (table === "messages") {
        let inColumn = "";
        let inValues: unknown[] = [];
        const equalityFilters = new Map<string, unknown>();
        let orFilter = "";
        let orderColumn = "";
        let orderAscending = true;
        const query = makeQuery({ data: [], error: null });
        query.select = (columns = "") => {
          input.messageQueryCalls?.push(`messages:select:${columns}`);
          return query;
        };
        query.in = (column, values) => {
          inColumn = column;
          inValues = values;
          input.messageQueryCalls?.push(`messages:in:${column}:${values.join(",")}`);
          return query;
        };
        query.eq = (column, value) => {
          equalityFilters.set(column, value);
          input.messageQueryCalls?.push(`messages:eq:${column}:${String(value)}`);
          return query;
        };
        query.or = (filters) => {
          orFilter = filters;
          input.messageQueryCalls?.push(`messages:or:${filters}`);
          return query;
        };
        query.order = (column, options) => {
          orderColumn = column;
          orderAscending = !(
            options &&
            typeof options === "object" &&
            "ascending" in options &&
            options.ascending === false
          );
          input.messageQueryCalls?.push(
            `messages:order:${column}:${orderAscending ? "ascending" : "descending"}`,
          );
          return query;
        };
        query.limit = async (count) => {
          input.messageQueryCalls?.push(`messages:limit:${count}`);
          const source = inColumn === "id" ? (input.messageRoots ?? []) : (input.deliveredReplies ?? []);
          const rows = source
            .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
            .filter((row) => inValues.includes(row[inColumn]))
            .filter((row) =>
              [...equalityFilters].every(([column, value]) => row[column] === value),
            )
            .filter((row) =>
              orFilter === "reply_kind.is.null,reply_kind.eq.reply"
                ? row.reply_kind == null || row.reply_kind === "reply"
                : true,
            )
            .sort((left, right) => {
              if (!orderColumn) return 0;
              const comparison = String(left[orderColumn] ?? "").localeCompare(
                String(right[orderColumn] ?? ""),
              );
              return orderAscending ? comparison : -comparison;
            });
          return {
            data: rows.slice(0, count),
            error: null,
          };
        };
        return query;
      }
      return makeQuery({ data: [], error: null });
    },
  };
}
