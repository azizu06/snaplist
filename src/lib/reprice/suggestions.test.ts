import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  applyRepriceSuggestion,
  dismissRepriceSuggestion,
  RepriceApplyError,
} from "./suggestions";
import { MockEbayAdapter } from "../marketplace/ebay";

/**
 * One-tap apply / dismiss tests (issue #102), offline: a fake Supabase client
 * and the MockEbayAdapter. Pins the money-path invariants — the floor guard
 * re-runs at apply time, a resolved suggestion can't re-apply, and a live
 * revision that fails to record surfaces loudly.
 */

interface RecordedOp {
  table: string;
  action: "select" | "update";
  payload?: unknown;
  eq: Record<string, unknown>;
}

type Responder = (op: RecordedOp) => { data?: unknown; error?: { message: string } | null };

function fakeSupabase(respond: Responder) {
  const ops: RecordedOp[] = [];
  const client = {
    from(table: string) {
      const op: RecordedOp = { table, action: "select", eq: {} };
      ops.push(op);
      const builder = {
        select: () => builder,
        insert: (payload: unknown) => {
          op.action = "update"; // notifications insert — treated as a write
          op.payload = payload;
          return builder;
        },
        update: (payload: unknown) => {
          op.action = "update";
          op.payload = payload;
          return builder;
        },
        eq: (k: string, v: unknown) => {
          op.eq[k] = v;
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        maybeSingle: () => builder,
        then: <T>(f: (v: { data: unknown; error: unknown }) => T) => {
          const res = respond(op);
          return Promise.resolve(f({ data: res.data ?? null, error: res.error ?? null }));
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { client, ops };
}

const SUGGESTION = {
  id: "sug-1",
  item_id: "item-1",
  listing_id: "listing-1",
  current_price: 100,
  suggested_price: 80,
  target_price: 80,
  price_range: { low: 70, high: 90 },
  drift_pct: -20,
  confidence: 0.8,
  tier_fired: "ebay-sold",
  sources: [],
  floored_to_minimum: false,
  status: "pending",
  created_at: "2026-07-02T06:00:00Z",
  listings: { title: "Sony WH-1000XM4", ebay_offer_id: "offer-1" },
  items: { price_floor: null as number | null },
};

const env = () => ({ EBAY_MARKETPLACE_ID: "EBAY_US" });

describe("applyRepriceSuggestion", () => {
  it("revises through the adapter and records the applied price", async () => {
    const { client, ops } = fakeSupabase((op) =>
      op.table === "reprice_suggestions" && op.action === "select"
        ? { data: SUGGESTION }
        : { data: null, error: null },
    );
    const adapter = new MockEbayAdapter();

    const result = await applyRepriceSuggestion(client, "user-a", "sug-1", adapter, { env });

    expect(result.appliedPrice).toBe(80);
    expect(adapter.reviseRequests).toEqual([
      { sku: "listing-1", offerId: "offer-1", price: { value: "80.00", currency: "USD" } },
    ]);
    const writes = ops.filter((op) => op.action === "update");
    expect(
      writes.find((op) => op.table === "reprice_suggestions")?.payload,
    ).toMatchObject({ status: "applied", applied_price: 80 });
    expect(writes.find((op) => op.table === "items")?.payload).toMatchObject({
      price_override: 80,
    });
    expect(writes.find((op) => op.table === "listings")?.payload).toMatchObject({
      listed_price: 80,
    });
  });

  it("re-runs the floor guard at apply time (floor raised since the sweep)", async () => {
    const row = { ...SUGGESTION, items: { price_floor: 95 } };
    const { client } = fakeSupabase((op) =>
      op.table === "reprice_suggestions" && op.action === "select"
        ? { data: row }
        : { data: null, error: null },
    );
    const adapter = new MockEbayAdapter();

    const result = await applyRepriceSuggestion(client, "user-a", "sug-1", adapter, { env });

    expect(result.appliedPrice).toBe(95);
    expect(adapter.reviseRequests[0].price.value).toBe("95.00");
  });

  it("refuses a suggestion that is no longer pending", async () => {
    const row = { ...SUGGESTION, status: "dismissed" };
    const { client } = fakeSupabase((op) =>
      op.table === "reprice_suggestions" && op.action === "select"
        ? { data: row }
        : { data: null, error: null },
    );
    await expect(
      applyRepriceSuggestion(client, "user-a", "sug-1", new MockEbayAdapter(), { env }),
    ).rejects.toBeInstanceOf(RepriceApplyError);
  });

  it("refuses when the listing has no eBay offer to revise", async () => {
    const row = { ...SUGGESTION, listings: { title: "X", ebay_offer_id: null } };
    const { client } = fakeSupabase((op) =>
      op.table === "reprice_suggestions" && op.action === "select"
        ? { data: row }
        : { data: null, error: null },
    );
    const adapter = new MockEbayAdapter();
    await expect(
      applyRepriceSuggestion(client, "user-a", "sug-1", adapter, { env }),
    ).rejects.toBeInstanceOf(RepriceApplyError);
    expect(adapter.reviseRequests).toHaveLength(0);
  });

  it("a not-found (foreign/unknown) id fails closed without touching eBay", async () => {
    const { client } = fakeSupabase(() => ({ data: null }));
    const adapter = new MockEbayAdapter();
    await expect(
      applyRepriceSuggestion(client, "user-a", "sug-x", adapter, { env }),
    ).rejects.toBeInstanceOf(RepriceApplyError);
    expect(adapter.reviseRequests).toHaveLength(0);
  });

  it("surfaces loudly when the revision is live but recording fails", async () => {
    const { client } = fakeSupabase((op) => {
      if (op.table === "reprice_suggestions" && op.action === "select")
        return { data: SUGGESTION };
      if (op.table === "items" && op.action === "update")
        return { error: { message: "db down" } };
      return { data: null, error: null };
    });
    await expect(
      applyRepriceSuggestion(client, "user-a", "sug-1", new MockEbayAdapter(), { env }),
    ).rejects.toThrow(/revised on eBay but recording it failed/i);
  });
});

describe("dismissRepriceSuggestion", () => {
  it("marks the pending row dismissed", async () => {
    const { client, ops } = fakeSupabase(() => ({ data: null, error: null }));
    await dismissRepriceSuggestion(client, "sug-1");
    const write = ops.find(
      (op) => op.table === "reprice_suggestions" && op.action === "update",
    );
    expect(write?.payload).toMatchObject({ status: "dismissed" });
    expect(write?.eq).toMatchObject({ id: "sug-1", status: "pending" });
  });
});
