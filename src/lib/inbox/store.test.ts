import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DraftAttachConflictError,
  ReplySendConflictError,
  approveAndSendReply,
  attachDraftReply,
  createBuyerMessage,
  retryReplyDelivery,
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

type PlannedResult = {
  data: unknown;
  error: { message: string; code?: string } | null;
};

interface RecordedInsert {
  table: string;
  payload: Record<string, unknown>;
}
interface RecordedUpdate {
  table: string;
  payload: Record<string, unknown>;
  eqs: [string, unknown][];
  ins: [string, unknown[]][];
}
interface RecordedSelect {
  table: string;
  columns: string;
  eqs: [string, unknown][];
}

/**
 * Minimal chainable fake for the query shapes the store uses:
 *   from().insert().select().single()
 *   from().update().eq().select().single()
 *   from().update().eq().eq().select()   (awaited directly — the CAS claim)
 *   from().select().eq().eq().limit()    (awaited directly — the retry claim)
 * Planned update/insert results may be functions, letting a test compute the
 * result at claim time (e.g. exactly one concurrent CAS winner).
 */
function fakeSupabase(plan: {
  inserts?: (PlannedResult | (() => PlannedResult))[];
  updates?: (PlannedResult | (() => PlannedResult))[];
  selects?: PlannedResult[];
}) {
  const inserts: RecordedInsert[] = [];
  const updates: RecordedUpdate[] = [];
  const selects: RecordedSelect[] = [];
  const plannedInserts = [...(plan.inserts ?? [])];
  const plannedUpdates = [...(plan.updates ?? [])];
  const plannedSelects = [...(plan.selects ?? [])];

  const client = {
    from(table: string) {
      return {
        insert(payload: Record<string, unknown>) {
          inserts.push({ table, payload });
          const planned =
            plannedInserts.shift() ??
            ({ data: null, error: { message: "unplanned insert" } } as PlannedResult);
          const res = typeof planned === "function" ? planned() : planned;
          return { select: () => ({ single: async () => res }) };
        },
        select(columns: string) {
          const entry: RecordedSelect = { table, columns, eqs: [] };
          selects.push(entry);
          const res =
            plannedSelects.shift() ?? ({ data: [], error: null } as PlannedResult);
          const builder = {
            eq(column: string, value: unknown) {
              entry.eqs.push([column, value]);
              return builder;
            },
            limit: () => builder,
            then(
              onFulfilled: (v: PlannedResult) => unknown,
              onRejected?: (reason: unknown) => unknown,
            ) {
              return Promise.resolve(res).then(onFulfilled, onRejected);
            },
          };
          return builder;
        },
        update(payload: Record<string, unknown>) {
          const entry: RecordedUpdate = { table, payload, eqs: [], ins: [] };
          updates.push(entry);
          const planned =
            plannedUpdates.shift() ?? ({ data: null, error: null } as PlannedResult);
          const res = typeof planned === "function" ? planned() : planned;
          const builder = {
            eq(column: string, value: unknown) {
              entry.eqs.push([column, value]);
              return builder;
            },
            in(column: string, values: unknown[]) {
              entry.ins.push([column, values]);
              return builder;
            },
            select: () => ({
              single: async () => res,
              maybeSingle: async () => res,
              // `.select("id")` is awaited directly by the CAS claim.
              then(
                onFulfilled: (v: PlannedResult) => unknown,
                onRejected?: (reason: unknown) => unknown,
              ) {
                return Promise.resolve(res).then(onFulfilled, onRejected);
              },
            }),
            // The builder is awaited directly for plain updates.
            then(
              onFulfilled: (v: PlannedResult) => unknown,
              onRejected?: (reason: unknown) => unknown,
            ) {
              return Promise.resolve(res).then(onFulfilled, onRejected);
            },
          };
          return builder;
        },
      };
    },
  };

  return { client: client as unknown as SupabaseClient, inserts, updates, selects };
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
    expect(updates[0].eqs).toEqual([["id", MESSAGE_ID]]);
    // The attach is a CAS: only a message still AWAITING a draft may take it.
    expect(updates[0].ins).toEqual([["status", ["new", "draft_failed"]]]);
    expect(result.status).toBe("drafted");
  });

  it("throws when the update itself errors", async () => {
    const { client } = fakeSupabase({
      updates: [{ data: null, error: { message: "boom" } }],
    });
    await expect(
      attachDraftReply(client, { messageId: MESSAGE_ID, draft: "d", model: "m" }),
    ).rejects.toThrow(/Failed to attach draft reply/);
  });

  it("throws DraftAttachConflictError when the row already moved on (lost race)", async () => {
    // A slow redraft returning AFTER a concurrent draft was attached — and
    // possibly approved and SENT — must not downgrade the row: the guarded
    // update matches 0 rows and surfaces as an idempotent conflict.
    const { client } = fakeSupabase({
      updates: [{ data: null, error: null }],
    });
    await expect(
      attachDraftReply(client, { messageId: MESSAGE_ID, draft: "d", model: "m" }),
    ).rejects.toThrow(DraftAttachConflictError);
  });
});

describe("approveAndSendReply", () => {
  const inbound = row({ status: "drafted", draft_reply: "Draft" });
  /** A successful CAS claim returns the claimed row's id. */
  const claimWon: PlannedResult = { data: [{ id: MESSAGE_ID }], error: null };
  /** A lost CAS (already sent / concurrent winner) matches 0 rows. */
  const claimLost: PlannedResult = { data: [], error: null };

  it("claims via CAS, delivers, then persists the threaded outbound row", async () => {
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
      updates: [claimWon],
    });
    const delivered: { messageId: string; reply: string }[] = [];

    const result = await approveAndSendReply(client, {
      userId: USER_ID,
      message: inbound,
      reply: "  Edited reply  ", // seller-edited; trimmed before persisting
      deliver: async (args) => {
        delivered.push(args);
        // Crash-safety ordering: the CAS claim has ALREADY happened (so a retry
        // cannot re-deliver), and the outbound insert has NOT yet.
        expect(updates).toHaveLength(1);
        expect(inserts).toHaveLength(0);
      },
    });

    // The idempotency key is the inbound id — stable across send and retry,
    // so a real adapter can dedupe the external side effect.
    expect(delivered).toEqual([
      { messageId: MESSAGE_ID, reply: "Edited reply", idempotencyKey: MESSAGE_ID },
    ]);

    // The claim is a compare-and-set: id AND status='drafted'.
    expect(updates).toHaveLength(1);
    expect(updates[0].eqs).toEqual([
      ["id", MESSAGE_ID],
      ["status", "drafted"],
    ]);
    const sentAt = updates[0].payload.sent_at;
    // The claim persists the APPROVED text into draft_reply, so a delivery
    // failure after this point can only ever retry the seller-approved copy —
    // never the stale agent draft (#13 review round 4).
    expect(updates[0].payload).toEqual({
      status: "sent",
      sent_at: sentAt,
      draft_reply: "Edited reply",
    });

    // Outbound row: threaded, stamped with the SAME timestamp, seller-owned.
    expect(inserts).toHaveLength(1);
    const payload = inserts[0].payload;
    expect(payload.user_id).toBe(USER_ID);
    expect(payload.item_id).toBe(ITEM_ID);
    expect(payload.listing_id).toBe(LISTING_ID);
    expect(payload.direction).toBe("outbound");
    expect(payload.body).toBe("Edited reply");
    expect(payload.status).toBe("sent");
    expect(payload.reply_to).toBe(MESSAGE_ID);
    expect(payload.sent_at).toBe(sentAt);

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

  it("double-send: a question that is no longer `drafted` is a conflict — delivery never runs", async () => {
    const { client, inserts } = fakeSupabase({ updates: [claimLost] });
    const deliver = vi.fn(async () => {});

    await expect(
      approveAndSendReply(client, { userId: USER_ID, message: inbound, reply: "R", deliver }),
    ).rejects.toThrow(ReplySendConflictError);
    expect(deliver).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });

  it("CAS prevents concurrent double-claim: exactly one of two racing sends delivers", async () => {
    // Model the database's row lock: the first UPDATE to reach the row matches
    // it (status drafted → sent); the second matches 0 rows.
    let claimedOnce = false;
    const casClaim = (): PlannedResult => {
      if (claimedOnce) return claimLost;
      claimedOnce = true;
      return claimWon;
    };
    const outboundRow = row({
      id: OUTBOUND_ID,
      direction: "outbound",
      body: "R",
      status: "sent",
      reply_to: MESSAGE_ID,
      sent_at: "2026-06-10T19:10:00.000Z",
    });
    const { client } = fakeSupabase({
      inserts: [{ data: outboundRow, error: null }],
      updates: [casClaim, casClaim],
    });
    const deliver = vi.fn(async () => {});

    const send = () =>
      approveAndSendReply(client, { userId: USER_ID, message: inbound, reply: "R", deliver });
    const [a, b] = await Promise.allSettled([send(), send()]);

    const outcomes = [a, b];
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ReplySendConflictError);
    // The non-idempotent delivery ran exactly once.
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("treats a reply_to unique violation on the outbound insert as an idempotent conflict", async () => {
    // Backstop for anything that slips past the CAS: the partial unique index
    // on messages(reply_to) (20260611004000) guarantees at most one reply row.
    const { client } = fakeSupabase({
      inserts: [
        {
          data: null,
          error: {
            message: 'duplicate key value violates unique constraint "messages_reply_to_unique"',
            code: "23505",
          },
        },
      ],
      updates: [claimWon],
    });

    await expect(
      approveAndSendReply(client, {
        userId: USER_ID,
        message: inbound,
        reply: "R",
        deliver: async () => {},
      }),
    ).rejects.toThrow(ReplySendConflictError);
  });

  it("crash semantics: a delivery failure AFTER the claim leaves the question `sent` with no outbound row (recoverable only via retryReplyDelivery)", async () => {
    const { client, inserts, updates } = fakeSupabase({ updates: [claimWon] });
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
    // The claim already flipped drafted → sent (chosen semantics: the send path
    // itself can never re-deliver; recovery is the explicit retry path)…
    expect(updates).toHaveLength(1);
    expect(updates[0].payload.status).toBe("sent");
    // …and no outbound row was persisted — exactly the detectable
    // "sent-but-undelivered" state the inbox renders as "not delivered".
    expect(inserts).toHaveLength(0);
  });
});

describe("retryReplyDelivery", () => {
  const inbound = row({ status: "sent", draft_reply: "Draft reply" });
  /** Retry claim passes: no outbound row references the question yet. */
  const noOutbound: PlannedResult = { data: [], error: null };
  /** Retry claim fails: a reply row already exists. */
  const hasOutbound: PlannedResult = { data: [{ id: OUTBOUND_ID }], error: null };
  const uniqueViolation: PlannedResult = {
    data: null,
    error: {
      message: 'duplicate key value violates unique constraint "messages_reply_to_unique"',
      code: "23505",
    },
  };

  function outboundRow() {
    return row({
      id: OUTBOUND_ID,
      direction: "outbound",
      body: "Draft reply",
      status: "sent",
      reply_to: MESSAGE_ID,
      sent_at: "2026-06-11T09:00:00.000Z",
    });
  }

  it("retry on an undelivered sent question: delivers once and inserts exactly one threaded outbound row", async () => {
    const { client, inserts, selects, updates } = fakeSupabase({
      selects: [noOutbound],
      inserts: [{ data: outboundRow(), error: null }],
    });
    const delivered: { messageId: string; reply: string }[] = [];

    const result = await retryReplyDelivery(client, {
      userId: USER_ID,
      message: inbound,
      reply: "Draft reply",
      deliver: async (args) => {
        delivered.push(args);
        // Ordering: the existence check (the claim) has already run, the
        // outbound insert has not.
        expect(selects).toHaveLength(1);
        expect(inserts).toHaveLength(0);
      },
    });

    // SAME idempotency key as the original send — the retry is dedupable.
    expect(delivered).toEqual([
      { messageId: MESSAGE_ID, reply: "Draft reply", idempotencyKey: MESSAGE_ID },
    ]);
    // The claim is "no outbound row references this question".
    expect(selects[0].eqs).toEqual([
      ["reply_to", MESSAGE_ID],
      ["direction", "outbound"],
    ]);
    // No status CAS is re-run — the inbound row is already terminally `sent`.
    expect(updates).toHaveLength(0);
    // Exactly one outbound row, threaded like the send path's.
    expect(inserts).toHaveLength(1);
    const payload = inserts[0].payload;
    expect(payload.user_id).toBe(USER_ID);
    expect(payload.direction).toBe("outbound");
    expect(payload.body).toBe("Draft reply");
    expect(payload.status).toBe("sent");
    expect(payload.reply_to).toBe(MESSAGE_ID);
    expect(result.outbound.id).toBe(OUTBOUND_ID);
  });

  it("retry when an outbound row already exists is an idempotent conflict — NO second delivery, no insert", async () => {
    const { client, inserts } = fakeSupabase({ selects: [hasOutbound] });
    const deliver = vi.fn(async () => {});

    await expect(
      retryReplyDelivery(client, {
        userId: USER_ID,
        message: inbound,
        reply: "Draft reply",
        deliver,
      }),
    ).rejects.toThrow(ReplySendConflictError);
    expect(deliver).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });

  it("concurrent double-retry collapses to ONE outbound row; delivery may at worst double on the true race", async () => {
    // Both retries pass the existence check before either inserts (the worst
    // case: the claim is a plain read, not a CAS). The partial unique index on
    // messages(reply_to) is what the code can actually guarantee: the second
    // insert gets 23505 → idempotent conflict, so exactly one outbound row
    // exists. Delivery itself ran twice — that is the honest, documented
    // semantics of the retry path (mirrors the send path's reasoning: the
    // index dedupes the ROW, not the side effect).
    let insertedOnce = false;
    const racingInsert = (): PlannedResult => {
      if (insertedOnce) return uniqueViolation;
      insertedOnce = true;
      return { data: outboundRow(), error: null };
    };
    const { client, inserts } = fakeSupabase({
      selects: [noOutbound, noOutbound],
      inserts: [racingInsert, racingInsert],
    });
    const deliver = vi.fn(async () => {});

    const retry = () =>
      retryReplyDelivery(client, {
        userId: USER_ID,
        message: inbound,
        reply: "Draft reply",
        deliver,
      });
    const outcomes = await Promise.allSettled([retry(), retry()]);

    // Exactly one retry persisted the reply; the loser saw the unique index.
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ReplySendConflictError);
    // Both raced past the read-claim → both delivered (at-worst-double).
    expect(deliver).toHaveBeenCalledTimes(2);
    // But the unique index collapsed persistence to one row: two attempts,
    // one success + one 23505.
    expect(inserts).toHaveLength(2);
  });

  it("rejects an empty reply without checking, delivering, or inserting", async () => {
    const { client, inserts, selects } = fakeSupabase({});
    const deliver = vi.fn(async () => {});
    await expect(
      retryReplyDelivery(client, { userId: USER_ID, message: inbound, reply: " ", deliver }),
    ).rejects.toThrow(/non-empty reply/);
    expect(deliver).not.toHaveBeenCalled();
    expect(selects).toHaveLength(0);
    expect(inserts).toHaveLength(0);
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
