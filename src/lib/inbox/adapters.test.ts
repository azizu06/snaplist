import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEbayMessagingAdapterForUser } from "@/lib/marketplace/ebay";
import { createTenantServerClient } from "@/lib/supabase/tenant-server";
import { createMessagingTransportForConversation } from "./adapters";
import { SupabaseDeliveryRepository } from "./transport";
import type { MessageRow } from "./types";

vi.mock("@/lib/marketplace/ebay", () => ({
  createEbayMessagingAdapterForUser: vi.fn(async () => ({
    fetchUnansweredQuestions: vi.fn(),
    replyToQuestion: vi.fn(),
    sendFollowUp: vi.fn(),
  })),
}));

vi.mock("@/lib/supabase/tenant-server", () => ({
  createTenantServerClient: vi.fn(),
}));

const root: MessageRow = {
  id: "11111111-1111-4111-8111-111111111111",
  user_id: "user_a",
  item_id: "22222222-2222-4222-8222-222222222222",
  listing_id: "33333333-3333-4333-8333-333333333333",
  direction: "inbound",
  body: "Does it include the charger?",
  draft_reply: "Yes, it does.",
  status: "drafted",
  sent_at: null,
  reply_to: null,
  reply_kind: null,
  draft_model: "test",
  created_at: "2026-07-13T12:00:00.000Z",
  updated_at: "2026-07-13T12:00:00.000Z",
  marketplace: "ebay",
  external_message_id: "message-1",
  external_parent_id: "parent-1",
  external_conversation_id: "conversation-1",
  external_listing_id: "listing-1",
  external_buyer_id: "buyer-1",
  external_created_at: "2026-07-13T12:00:00.000Z",
  delivery_request_id: null,
  delivery_status: null,
  external_delivery_id: null,
  delivery_attempted_at: null,
  delivery_error: null,
};

describe("createMessagingTransportForConversation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps foreground eBay transport on the caller client and tenant write RPC", async () => {
    const generation = "11111111-1111-4111-8111-111111111111";
    const rpc = vi.fn(async (name: string, args?: Record<string, unknown>) => ({
      data:
        name === "begin_ebay_message_write"
          ? generation
          : args?.p_operation === "begin_provider_dispatch"
            ? { account_generation: generation }
            : true,
      error: null,
    }));
    const client = {} as SupabaseClient;
    const serverWriteClient = { rpc } as unknown as SupabaseClient;
    vi.mocked(createTenantServerClient).mockResolvedValue(serverWriteClient);

    const transport = await createMessagingTransportForConversation(
      client,
      "user_a",
      "ebay",
    );
    const claimed = await transport.repository.claimCanonical(
      root,
      "Yes, it does.",
      new Date("2026-07-13T12:01:00.000Z"),
      false,
      [],
    );
    await expect(
      transport.repository.beginProviderDispatch(
        root.id,
        new Date("2026-07-13T12:01:00.000Z"),
      ),
    ).resolves.toEqual({ accountGeneration: generation });
    await transport.repository.failCanonical(
      root.id,
      "ambiguous",
      new Date("2026-07-13T12:01:00.000Z"),
    );

    expect(createEbayMessagingAdapterForUser).toHaveBeenCalledWith(
      client,
      "user_a",
      { credentialClient: serverWriteClient },
    );
    expect(createTenantServerClient).toHaveBeenCalledOnce();
    expect(claimed).toBe(true);
    expect(rpc.mock.calls.filter(([name]) => name === "begin_ebay_message_write"))
      .toHaveLength(1);
    expect(rpc).toHaveBeenCalledWith("claim_ebay_message_write_with_photos", {
      p_operation: "claim_canonical",
      p_payload: {
        message_id: root.id,
        body: "Yes, it does.",
        at: "2026-07-13T12:01:00.000Z",
        retry: false,
        delivery_actor: "seller",
        marketplace_observed_at: undefined,
        question_observed_at: undefined,
      },
      p_generation: generation,
      p_delivery_request_id: root.id,
      p_attachment_ids: [],
    });
    expect(rpc).toHaveBeenCalledWith("apply_ebay_message_write", {
      p_operation: "begin_provider_dispatch",
      p_payload: {
        message_id: root.id,
        attempted_at: "2026-07-13T12:01:00.000Z",
      },
      p_generation: generation,
    });
    expect(rpc).toHaveBeenCalledWith("apply_ebay_message_write", {
      p_operation: "fail_canonical",
      p_payload: {
        message_id: root.id,
        kind: "ambiguous",
        attempted_at: "2026-07-13T12:01:00.000Z",
      },
      p_generation: generation,
    });
  });

  it("claims and completes scheduled automatic replies through scheduler photo RPCs", async () => {
    const generation = "11111111-1111-4111-8111-111111111111";
    const delivered = {
      ...root,
      id: "44444444-4444-4444-8444-444444444444",
      direction: "outbound" as const,
      body: "Yes, it does.",
      status: "sent" as const,
      sent_at: "2026-07-13T12:01:01.000Z",
      reply_to: root.id,
      reply_kind: "reply" as const,
      delivery_status: "delivered" as const,
      external_delivery_id: "provider-message-1",
      delivery_attempted_at: "2026-07-13T12:01:00.000Z",
    };
    const rpc = vi.fn(async (name: string) => ({
      data:
        name === "begin_scheduled_ebay_message_write"
          ? generation
          : name === "complete_scheduled_ebay_message_write_with_photos"
            ? delivered
            : true,
      error: null,
    }));
    const admin = { rpc } as unknown as SupabaseClient;
    const repository = new SupabaseDeliveryRepository(
      admin,
      "user_a",
      true,
      admin,
      true,
    );

    await expect(repository.claimCanonical(
      root,
      "Yes, it does.",
      new Date("2026-07-13T12:01:00.000Z"),
      false,
      [],
      "automatic",
      "2026-07-13T12:00:30.000Z",
      "2026-07-13T12:00:00.000Z",
    )).resolves.toBe(true);
    await expect(repository.completeCanonical(
      root,
      "Yes, it does.",
      {
        externalDeliveryId: "provider-message-1",
        deliveredAt: "2026-07-13T12:01:01.000Z",
      },
      new Date("2026-07-13T12:01:00.000Z"),
    )).resolves.toMatchObject({
      id: delivered.id,
      delivery_status: "delivered",
      external_delivery_id: "provider-message-1",
    });

    expect(rpc).toHaveBeenCalledWith(
      "claim_scheduled_ebay_message_write_with_photos",
      {
        p_user_id: "user_a",
        p_operation: "claim_canonical",
        p_payload: {
          message_id: root.id,
          body: "Yes, it does.",
          at: "2026-07-13T12:01:00.000Z",
          retry: false,
          delivery_actor: "automatic",
          marketplace_observed_at: "2026-07-13T12:00:30.000Z",
          question_observed_at: "2026-07-13T12:00:00.000Z",
        },
        p_generation: generation,
        p_delivery_request_id: root.id,
        p_attachment_ids: [],
      },
    );
    expect(rpc).toHaveBeenCalledWith(
      "complete_scheduled_ebay_message_write_with_photos",
      {
        p_user_id: "user_a",
        p_operation: "complete_canonical",
        p_payload: {
          message_id: root.id,
          body: "Yes, it does.",
          external_delivery_id: "provider-message-1",
          delivered_at: "2026-07-13T12:01:01.000Z",
          attempted_at: "2026-07-13T12:01:00.000Z",
        },
        p_generation: generation,
        p_delivery_request_id: root.id,
      },
    );
  });
});
