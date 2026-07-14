import { describe, expect, it } from "vitest";
import { MockMarketplaceMessagingAdapter } from "@/lib/marketplace/mock-messaging";
import { MarketplaceDeliveryError } from "@/lib/marketplace/messaging";
import type { MessageRow } from "./types";
import {
  MessageDeliveryAttemptError,
  sendCanonicalReply,
  sendSellerFollowUp,
  retryFollowUpDelivery,
  type DeliveryRepository,
} from "./transport";

const ROOT_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";
const LISTING_ID = "33333333-3333-4333-8333-333333333333";

function message(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: ROOT_ID,
    user_id: "user_a",
    item_id: ITEM_ID,
    listing_id: LISTING_ID,
    direction: "inbound",
    body: "Does it include the charger?",
    draft_reply: "Yes, it includes the original charger.",
    status: "drafted",
    sent_at: null,
    reply_to: null,
    reply_kind: null,
    draft_model: "test",
    created_at: "2026-07-13T12:00:00.000Z",
    updated_at: "2026-07-13T12:00:00.000Z",
    marketplace: "ebay",
    external_message_id: "mail-display-id-never-use",
    external_parent_id: "exact-question-parent-42",
    external_conversation_id: "commerce-conversation-9",
    external_listing_id: "110011001100",
    external_buyer_id: "buyer-public-id",
    external_created_at: "2026-07-13T12:00:00.000Z",
    delivery_request_id: null,
    delivery_status: null,
    external_delivery_id: null,
    delivery_attempted_at: null,
    delivery_error: null,
    ...overrides,
  };
}

class MemoryDeliveryRepository implements DeliveryRepository {
  root = message();
  canonical: MessageRow | null = null;
  followUps = new Map<string, MessageRow>();
  followUpsByRequest = new Map<string, MessageRow>();
  failures: Array<{ id: string; kind: string }> = [];
  sequence = 0;

  async loadConversationRoot(id: string) {
    return id === this.root.id ? this.root : null;
  }
  async canonicalDelivered(id: string) {
    return id === this.root.id ? this.canonical : null;
  }
  async claimCanonical(_root: MessageRow, body: string, at: Date, retry: boolean) {
    if (!retry && this.root.status !== "drafted") return false;
    if (
      retry &&
      !["rejected", "failed", "ambiguous"].includes(
        this.root.delivery_status ?? "",
      )
    ) {
      return false;
    }
    this.root.status = "sent";
    this.root.draft_reply = body;
    this.root.delivery_request_id = this.root.id;
    this.root.delivery_status = "sending";
    this.root.delivery_attempted_at = at.toISOString();
    return true;
  }
  async failCanonical(id: string, kind: "rejected" | "failed" | "ambiguous") {
    this.root.delivery_status = kind;
    this.failures.push({ id, kind });
  }
  async completeCanonical(
    root: MessageRow,
    body: string,
    receipt: { externalDeliveryId: string; deliveredAt: string },
  ) {
    this.root.delivery_status = "delivered";
    this.root.sent_at = receipt.deliveredAt;
    this.canonical = message({
      id: "44444444-4444-4444-8444-444444444444",
      direction: "outbound",
      body,
      reply_to: root.id,
      reply_kind: "reply",
      status: "sent",
      sent_at: receipt.deliveredAt,
      delivery_status: "delivered",
      external_delivery_id: receipt.externalDeliveryId,
    });
    return this.canonical;
  }
  async createFollowUpIntent(
    root: MessageRow,
    body: string,
    requestId: string,
    at: Date,
  ) {
    const existing = this.followUpsByRequest.get(requestId);
    if (existing) return { message: existing, inserted: false };
    const id = `55555555-5555-4555-8555-${String(++this.sequence).padStart(12, "0")}`;
    const row = message({
      id,
      direction: "outbound",
      body,
      status: "approved",
      reply_to: root.id,
      reply_kind: "followup",
      delivery_request_id: requestId,
      delivery_status: "sending",
      delivery_attempted_at: at.toISOString(),
    });
    this.followUps.set(id, row);
    this.followUpsByRequest.set(requestId, row);
    return { message: row, inserted: true };
  }
  async loadFollowUp(id: string) {
    return this.followUps.get(id) ?? null;
  }
  async claimFollowUp(row: MessageRow, at: Date) {
    if (!["rejected", "failed", "ambiguous"].includes(row.delivery_status ?? "")) {
      return false;
    }
    row.delivery_status = "sending";
    row.delivery_attempted_at = at.toISOString();
    return true;
  }
  async failFollowUp(id: string, kind: "rejected" | "failed" | "ambiguous") {
    const row = this.followUps.get(id)!;
    row.delivery_status = kind;
    row.status = "approved";
    this.failures.push({ id, kind });
  }
  async completeFollowUp(
    id: string,
    receipt: { externalDeliveryId: string; deliveredAt: string },
  ) {
    const row = this.followUps.get(id)!;
    row.delivery_status = "delivered";
    row.status = "sent";
    row.sent_at = receipt.deliveredAt;
    row.external_delivery_id = receipt.externalDeliveryId;
    return row;
  }
}

describe("message delivery transport", () => {
  it("delivers an approved reply once using the exact external parent identifier", async () => {
    const adapter = new MockMarketplaceMessagingAdapter();
    const repository = new MemoryDeliveryRepository();

    const first = await sendCanonicalReply({
      repository,
      adapter,
      messageId: ROOT_ID,
      body: "Yes, it includes the charger.",
    });
    const replay = await sendCanonicalReply({
      repository,
      adapter,
      messageId: ROOT_ID,
      body: "Yes, it includes the charger.",
    });

    expect(first.id).toBe(replay.id);
    expect(adapter.replies).toHaveLength(1);
    expect(adapter.replies[0]).toMatchObject({
      externalParentId: "exact-question-parent-42",
      externalListingId: "110011001100",
      externalBuyerId: "buyer-public-id",
      idempotencyKey: ROOT_ID,
    });
    expect(adapter.replies[0]?.externalParentId).not.toBe(
      repository.root.external_message_id,
    );
    expect(repository.root.delivery_status).toBe("delivered");
  });

  it("keeps rejected/ambiguous delivery visible and retryable without claiming success", async () => {
    const adapter = new MockMarketplaceMessagingAdapter();
    const repository = new MemoryDeliveryRepository();
    adapter.replyFailure = new MarketplaceDeliveryError(
      "ambiguous",
      "connection closed",
    );

    const error = await sendCanonicalReply({
      repository,
      adapter,
      messageId: ROOT_ID,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MessageDeliveryAttemptError);
    expect((error as MessageDeliveryAttemptError).kind).toBe("ambiguous");
    expect(repository.canonical).toBeNull();
    expect(repository.root.sent_at).toBeNull();
    expect(repository.root.delivery_status).toBe("ambiguous");
    expect(adapter.replies).toHaveLength(1);

    adapter.replyFailure = undefined;
    const delivered = await sendCanonicalReply({
      repository,
      adapter,
      messageId: ROOT_ID,
      retry: true,
    });
    expect(delivered.delivery_status).toBe("delivered");
    expect(adapter.replies).toHaveLength(2);
  });

  it("deduplicates a seller-authored follow-up request and preserves delivery identity", async () => {
    const adapter = new MockMarketplaceMessagingAdapter();
    const repository = new MemoryDeliveryRepository();
    await sendCanonicalReply({ repository, adapter, messageId: ROOT_ID });

    const first = await sendSellerFollowUp({
      repository,
      adapter,
      conversationId: ROOT_ID,
      body: "I also found the carrying case.",
      requestId: "client-followup-request-7",
    });
    const replay = await sendSellerFollowUp({
      repository,
      adapter,
      conversationId: ROOT_ID,
      body: "I also found the carrying case.",
      requestId: "client-followup-request-7",
    });

    expect(replay.id).toBe(first.id);
    expect(adapter.followUps).toHaveLength(1);
    expect(adapter.followUps[0]).toMatchObject({
      externalConversationId: "commerce-conversation-9",
      externalParentId: "exact-question-parent-42",
      idempotencyKey: "client-followup-request-7",
    });
    expect(first.delivery_request_id).toBe("client-followup-request-7");
    expect(first.external_delivery_id).toBe(
      "mock-followup-client-followup-request-7",
    );
  });

  it("retries a failed follow-up by its persisted local identity", async () => {
    const adapter = new MockMarketplaceMessagingAdapter();
    const repository = new MemoryDeliveryRepository();
    await sendCanonicalReply({ repository, adapter, messageId: ROOT_ID });
    adapter.followUpFailure = new MarketplaceDeliveryError("failed", "system error");
    const failed = await sendSellerFollowUp({
      repository,
      adapter,
      conversationId: ROOT_ID,
      body: "One more detail.",
      requestId: "request-9",
    }).catch(() => repository.followUpsByRequest.get("request-9")!);
    expect(failed.delivery_status).toBe("failed");
    expect(failed.sent_at).toBeNull();

    adapter.followUpFailure = undefined;
    const delivered = await retryFollowUpDelivery({
      repository,
      adapter,
      messageId: failed.id,
    });
    expect(delivered.delivery_status).toBe("delivered");
    expect(adapter.followUps).toHaveLength(2);
  });
});
