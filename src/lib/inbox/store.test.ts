import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  approveAndSendReply,
  attachDraftReply,
  createBuyerMessage,
  stubDeliverReply,
} from "./store";
import type { MessageRow } from "./types";

/**
 * Offline unit tests for the inbox persistence seam (issue #13). NO database and
 * NO Realtime: a chainable fake stands in for the Supabase client, asserting the
 * exact row payloads (the same payloads Realtime streams to the live inbox) and
 * that delivery stays a stubbed, logged no-op behind the injectable seam.
 */

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";
const LISTING_ID = "33333333-3333-4333-8333-333333333333";
const MESSAGE_ID = "44444444-4444-4444-8444-444444444444";
const OUTBOUND_ID = "55555555-5555-4555-8555-555555555555";

function row(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: MESSAGE_ID,
    user_id: USER_ID,
    item_id: ITEM_ID,
    listing_id: LISTING_ID,
    direction: "inbound",
    body: "Is this still available?",
    draft_reply: null,
    status: "new",
    sent_at: null,
    reply_to: null,
    draft_model: null,
    created_at: "2026-06-10T19:00:00.000Z",
    updated_at: "2026-06-10T19:00:00.000Z",
    ...overrides,
  };
}

type PlannedResult = { data: unknown; error: { message: string } | null };

interface RecordedInsert {
  table: string;
  payload: Record<string, unknown>;
}
interface RecordedUpdate {
  table: string;
  payload: Record<string, unknown>;
  eq?: [string, unknown];
}

/**
 * Minimal chainable fake for the query shapes the store uses:
 *   from().insert().select().single()
 *   from().update().eq().select().single()
 *   from().update().eq()              (awaited directly — thenable)
 */
function fakeSupabase(plan: { inserts?: PlannedResult[]; updates?: PlannedResult[] }) {
  const inserts: RecordedInsert[] = [];
  const updates: RecordedUpdate[] = [];
  const plannedInserts = [...(plan.inserts ?? [])];
  const plannedUpdates = [...(plan.updates ?? [])];

  const client = {
    from(table: string) {
      return {
        insert(payload: Record<string, unknown>) {
          inserts.push({ table, payload });
          const res =
            plannedInserts.shift() ??
            ({ data: null, error: { message: "unplanned insert" } } as PlannedResult);
          return { select: () => ({ single: async () => res }) };
        },
        update(payload: Record<string, unknown>) {
          const entry: RecordedUpdate = { table, payload };
          updates.push(entry);
          const res =
            plannedUpdates.shift() ?? ({ data: null, error: null } as PlannedResult);
          return {
            eq(column: string, value: unknown) {
              entry.eq = [column, value];
              return {
                select: () => ({ single: async () => res }),
                // The builder is awaited directly for the inbound status update.
                then(
                  onFulfilled: (v: PlannedResult) => unknown,
                  onRejected?: (reason: unknown) => unknown,
                ) {
                  return Promise.resolve(res).then(onFulfilled, onRejected);
                },
              };
            },
          };
        },
      };
    },
  };

  return { client: client as unknown as SupabaseClient, inserts, updates };
}

describe("createBuyerMessage", () => {
  it("inserts an inbound `new` message pinned to the owning user (RLS seam)", async () => {
    const { client, inserts } = fakeSupabase({
      inserts: [{ data: row(), error: null }],
    });

    const created = await createBuyerMessage(client, {
      userId: USER_ID,
      itemId: ITEM_ID,
      listingId: LISTING_ID,
      body: "Is this still available?",
    });

    expect(inserts).toHaveLength(1);
    expect(inserts[0].table).toBe("messages");
    expect(inserts[0].payload).toEqual({
      user_id: USER_ID,
      item_id: ITEM_ID,
      listing_id: LISTING_ID,
      direction: "inbound",
      body: "Is this still available?",
      status: "new",
    });
    expect(created.id).toBe(MESSAGE_ID);
  });

  it("defaults listing_id to null and rejects an empty body", async () => {
    const { client, inserts } = fakeSupabase({
      inserts: [{ data: row({ listing_id: null }), error: null }],
    });

    await createBuyerMessage(client, {
      userId: USER_ID,
      itemId: ITEM_ID,
      body: "Q?",
    });
    expect(inserts[0].payload.listing_id).toBeNull();

    await expect(
      createBuyerMessage(client, { userId: USER_ID, itemId: ITEM_ID, body: "   " }),
    ).rejects.toThrow(/non-empty body/);
  });

  it("throws (never swallows) on a failed insert", async () => {
    const { client } = fakeSupabase({
      inserts: [{ data: null, error: { message: "row-level security" } }],
    });
    await expect(
      createBuyerMessage(client, { userId: USER_ID, itemId: ITEM_ID, body: "Q?" }),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("attachDraftReply", () => {
  it("updates the message to `drafted` with the draft + model provenance", async () => {
    const drafted = row({ draft_reply: "Yes!", draft_model: "gpt-5.5", status: "drafted" });
    const { client, updates } = fakeSupabase({ updates: [{ data: drafted, error: null }] });

    const result = await attachDraftReply(client, {
      messageId: MESSAGE_ID,
      draft: "Yes!",
      model: "gpt-5.5",
    });

    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toEqual({
      draft_reply: "Yes!",
      draft_model: "gpt-5.5",
      status: "drafted",
    });
    expect(updates[0].eq).toEqual(["id", MESSAGE_ID]);
    expect(result.status).toBe("drafted");
  });

  it("throws when the message is missing (RLS-filtered or deleted)", async () => {
    const { client } = fakeSupabase({
      updates: [{ data: null, error: { message: "0 rows" } }],
    });
    await expect(
      attachDraftReply(client, { messageId: MESSAGE_ID, draft: "d", model: "m" }),
    ).rejects.toThrow(/Failed to attach draft reply/);
  });
});

describe("approveAndSendReply", () => {
  const inbound = row({ status: "drafted", draft_reply: "Draft" });

  it("delivers via the seam, persists the threaded outbound row, and closes the question", async () => {
    const outboundRow = row({
      id: OUTBOUND_ID,
      direction: "outbound",
      body: "Edited reply",
      status: "sent",
      reply_to: MESSAGE_ID,
      sent_at: "2026-06-10T19:10:00.000Z",
    });
    const { client, inserts, updates } = fakeSupabase({
      inserts: [{ data: outboundRow, error: null }],
    });
    const delivered: { messageId: string; reply: string }[] = [];

    const result = await approveAndSendReply(client, {
      userId: USER_ID,
      message: inbound,
      reply: "  Edited reply  ", // seller-edited; trimmed before persisting
      deliver: async (args) => {
        delivered.push(args);
        // Delivery happens BEFORE anything is persisted as sent.
        expect(inserts).toHaveLength(0);
      },
    });

    expect(delivered).toEqual([{ messageId: MESSAGE_ID, reply: "Edited reply" }]);

    // Outbound row: threaded, stamped, owned by the seller.
    expect(inserts).toHaveLength(1);
    const payload = inserts[0].payload;
    expect(payload.user_id).toBe(USER_ID);
    expect(payload.item_id).toBe(ITEM_ID);
    expect(payload.listing_id).toBe(LISTING_ID);
    expect(payload.direction).toBe("outbound");
    expect(payload.body).toBe("Edited reply");
    expect(payload.status).toBe("sent");
    expect(payload.reply_to).toBe(MESSAGE_ID);
    expect(typeof payload.sent_at).toBe("string");

    // Inbound question closed out with the SAME timestamp.
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toEqual({ status: "sent", sent_at: payload.sent_at });
    expect(updates[0].eq).toEqual(["id", MESSAGE_ID]);

    expect(result.outbound.id).toBe(OUTBOUND_ID);
  });

  it("rejects an empty reply WITHOUT delivering or persisting anything", async () => {
    const { client, inserts, updates } = fakeSupabase({});
    const deliver = vi.fn(async () => {});

    await expect(
      approveAndSendReply(client, { userId: USER_ID, message: inbound, reply: "  ", deliver }),
    ).rejects.toThrow(/non-empty reply/);
    expect(deliver).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it("persists nothing when delivery fails", async () => {
    const { client, inserts, updates } = fakeSupabase({});
    await expect(
      approveAndSendReply(client, {
        userId: USER_ID,
        message: inbound,
        reply: "Reply",
        deliver: async () => {
          throw new Error("adapter down");
        },
      }),
    ).rejects.toThrow(/adapter down/);
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });
});

describe("stubDeliverReply", () => {
  it("is a logged no-op (sandbox — real send arrives with the eBay adapter, #14)", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await stubDeliverReply({ messageId: MESSAGE_ID, reply: "Hello buyer" });
      expect(info).toHaveBeenCalledTimes(1);
      const logged = String(info.mock.calls[0][0]);
      expect(logged).toContain("STUBBED delivery");
      expect(logged).toContain(MESSAGE_ID);
      expect(logged).toContain("Hello buyer");
    } finally {
      info.mockRestore();
    }
  });
});
