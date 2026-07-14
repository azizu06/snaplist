import { describe, expect, it } from "vitest";
import type { MessageRow } from "@/lib/inbox";
import { deriveConversationState } from "./conversation-list";

function message(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    user_id: "user_a",
    item_id: "22222222-2222-4222-8222-222222222222",
    listing_id: "33333333-3333-4333-8333-333333333333",
    direction: "inbound",
    body: "Does it include the charger?",
    draft_reply: "Yes, it does.",
    status: "sent",
    sent_at: null,
    reply_to: null,
    reply_kind: null,
    draft_model: "test",
    created_at: "2026-07-13T12:00:00.000Z",
    updated_at: "2026-07-13T12:00:00.000Z",
    marketplace: "ebay",
    external_message_id: "question-1",
    external_parent_id: "question-1",
    external_conversation_id: "conversation-1",
    external_listing_id: "listing-1",
    external_buyer_id: "buyer-1",
    external_created_at: "2026-07-13T12:00:00.000Z",
    delivery_request_id: null,
    delivery_status: "sending",
    external_delivery_id: null,
    delivery_attempted_at: "2026-07-13T12:01:00.000Z",
    delivery_error: null,
    ...overrides,
  };
}

describe("deriveConversationState", () => {
  it("reports delivery only after a durable delivered outbound reply exists", () => {
    const root = message();
    const inFlight = deriveConversationState(
      root,
      new Map(),
      `send:${root.id}`,
    );

    expect(inFlight.delivered).toBe(false);
    expect(inFlight.sending).toBe(true);

    const outbound = message({
      id: "44444444-4444-4444-8444-444444444444",
      direction: "outbound",
      reply_to: root.id,
      reply_kind: "reply",
      delivery_status: "delivered",
    });
    const delivered = deriveConversationState(
      root,
      new Map([[root.id, outbound]]),
      null,
    );

    expect(delivered.delivered).toBe(true);
    expect(delivered.sending).toBe(false);
  });
});
