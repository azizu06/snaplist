import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runRepriceSweep, REPRICE_SWEEP_MODEL } from "./sweep";
import { MockEbayAdapter } from "../marketplace/ebay";
import type { PriceResult } from "../pricing";

/**
 * Offline sweep choreography tests (issue #102): a FAKE Supabase client (no
 * network), an injected pricer (no live comps fetch), and the MockEbayAdapter
 * (no live eBay call — the acceptance criterion's "mockable, tested offline").
 * The pure decisions themselves are covered in policy.test.ts; these tests pin
 * what the sweep DOES with them: what gets logged, persisted, revised, and
 * notified, that applied prices advance the review revision, and that tenancy
 * rides every write.
 */

// ---------------------------------------------------------------------------
// Fake Supabase: records every operation; responses routed by table + action.
// ---------------------------------------------------------------------------

interface RecordedOp {
  table: string;
  action: "select" | "update" | "insert";
  payload?: unknown;
  eq: Record<string, unknown>;
  in: Record<string, unknown[]>;
  or?: string;
  limit?: number;
}

type Responder = (op: RecordedOp) => { data?: unknown; error?: { message: string } | null };

class FakeBuilder {
  constructor(
    private readonly op: RecordedOp,
    private readonly respond: Responder,
  ) {}
  select() {
    return this;
  }
  update(payload: unknown) {
    this.op.action = "update";
    this.op.payload = payload;
    return this;
  }
  insert(payload: unknown) {
    this.op.action = "insert";
    this.op.payload = payload;
    return this;
  }
  eq(key: string, value: unknown) {
    this.op.eq[key] = value;
    return this;
  }
  in(key: string, values: unknown[]) {
    this.op.in[key] = values;
    return this;
  }
  or(expr: string) {
    this.op.or = expr;
    return this;
  }
  order() {
    return this;
  }
  limit(n: number) {
    this.op.limit = n;
    return this;
  }
  then<T>(
    onFulfilled: (value: { data: unknown; error: unknown }) => T,
    onRejected?: (reason: unknown) => T,
  ): Promise<T> {
    try {
      const res = this.respond(this.op);
      return Promise.resolve(
        onFulfilled({ data: res.data ?? null, error: res.error ?? null }),
      );
    } catch (err) {
      return onRejected
        ? Promise.resolve(onRejected(err))
        : Promise.reject(err);
    }
  }
}

function fakeSupabase(respond: Responder) {
  const ops: RecordedOp[] = [];
  const client = {
    from(table: string) {
      const op: RecordedOp = { table, action: "select", eq: {}, in: {} };
      ops.push(op);
      return new FakeBuilder(op, respond);
    },
  } as unknown as SupabaseClient;
  return { client, ops };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date("2026-07-02T06:00:00Z");
const USER = "user_clerk_a";
const ITEM = "11111111-1111-4111-8111-111111111111";
const LISTING = "22222222-2222-4222-8222-222222222222";

const candidate = {
  id: LISTING,
  user_id: USER,
  item_id: ITEM,
  title: "Sony WH-1000XM4",
  ebay_offer_id: "offer-1",
  listed_price: 100,
  last_priced_at: "2026-06-01T00:00:00Z",
};

/** Fully-identified attributes so the confidence composite can reach the gate. */
const identifiedItem = {
  id: ITEM,
  user_id: USER,
  attributes: {
    brand: "Sony",
    model: "WH-1000XM4",
    category: "electronics",
    condition: "good",
    upc: "027242920866",
  },
  price_override: null as number | null,
  price_floor: null as number | null,
};

/** A sold-grounded, tight-cluster result — autopilot-ELIGIBLE through the real bridge. */
const soldTightPrice = (suggested: number): PriceResult => ({
  suggested,
  range: { min: suggested * 0.9, max: suggested * 1.1 },
  confidence: 0.9,
  sources: [
    { url: "https://www.ebay.com/itm/1", kind: "sold-comp", title: "sold 1" },
    { url: "https://www.ebay.com/itm/2", kind: "sold-comp", title: "sold 2" },
  ],
  tier: "ebay-sold",
  compAgreement: 0.95,
});

/** An asking-only scattered result — safely BELOW the autopilot gate. */
const askingWidePrice = (suggested: number): PriceResult => ({
  suggested,
  range: { min: suggested * 0.8, max: suggested * 1.2 },
  confidence: 0.5,
  sources: [{ url: "https://example.com/comp", kind: "asking-comp" }],
  tier: "branded-web",
  compAgreement: 0.4,
});

interface Scenario {
  listing?: Partial<typeof candidate>;
  item?: Partial<typeof identifiedItem>;
  settings?: {
    autopilot_enabled?: boolean | null;
    auto_reprice_enabled?: boolean | null;
  } | null;
}

function scenario(s: Scenario = {}) {
  const listing = { ...candidate, ...s.listing };
  const item = { ...identifiedItem, ...s.item };
  const settings =
    s.settings === null
      ? []
      : [{ user_id: USER, autopilot_enabled: true, auto_reprice_enabled: false, ...s.settings }];
  return fakeSupabase((op) => {
    if (op.table === "listings" && op.action === "select") return { data: [listing] };
    if (op.table === "items" && op.action === "select") return { data: [item] };
    if (op.table === "user_settings" && op.action === "select") return { data: settings };
    return { data: null, error: null };
  });
}

const findInsert = (ops: RecordedOp[], table: string) =>
  ops.find((op) => op.table === table && op.action === "insert");
const findUpdates = (ops: RecordedOp[], table: string) =>
  ops.filter((op) => op.table === table && op.action === "update");

// ---------------------------------------------------------------------------

describe("runRepriceSweep — suggest-only (the default posture)", () => {
  it("logs the run, persists a pending suggestion with evidence, and notifies", async () => {
    const { client, ops } = scenario({ settings: null }); // no settings row at all
    const adapter = new MockEbayAdapter();

    const summary = await runRepriceSweep(client, {
      now: () => NOW,
      priceItem: async () => askingWidePrice(80),
      adapter,
    });

    expect(summary).toMatchObject({
      scanned: 1,
      suggested: 1,
      autoApplied: 0,
      failed: 0,
    });

    // Every reprice run is logged to prediction_logs (feeds the eval harness).
    const log = findInsert(ops, "prediction_logs");
    expect(log?.payload).toMatchObject({
      user_id: USER,
      item_id: ITEM,
      price: 80,
      tier_fired: "branded-web",
      model: REPRICE_SWEEP_MODEL,
    });

    // The suggestion row carries the evidence: drift, confidence, fresh comps.
    const suggestion = findInsert(ops, "reprice_suggestions");
    expect(suggestion?.payload).toMatchObject({
      user_id: USER,
      item_id: ITEM,
      listing_id: LISTING,
      current_price: 100,
      suggested_price: 80,
      target_price: 80,
      drift_pct: -20,
      tier_fired: "branded-web",
      status: "pending",
      applied_price: null,
    });
    expect((suggestion?.payload as { run_id?: string }).run_id).toBe(
      (log?.payload as { run_id?: string }).run_id,
    );

    // Surfaced via the notification path (bell) with tenancy pinned.
    const bell = findInsert(ops, "notifications");
    expect(bell?.payload).toMatchObject({ user_id: USER, listing_id: LISTING });

    // Suggest-only NEVER touches eBay.
    expect(adapter.reviseRequests).toHaveLength(0);

    // The staleness cursor advanced so the batch walks on.
    const cursor = findUpdates(ops, "listings").find(
      (op) => (op.payload as { last_priced_at?: string }).last_priced_at,
    );
    expect(cursor?.eq).toMatchObject({ id: LISTING, user_id: USER });
  });

  it("does nothing (beyond the log + cursor) when drift is immaterial", async () => {
    const { client, ops } = scenario();
    const summary = await runRepriceSweep(client, {
      now: () => NOW,
      priceItem: async () => askingWidePrice(97),
      adapter: new MockEbayAdapter(),
    });
    expect(summary).toMatchObject({ scanned: 1, unchanged: 1, suggested: 0 });
    expect(findInsert(ops, "prediction_logs")).toBeTruthy(); // still logged
    expect(findInsert(ops, "reprice_suggestions")).toBeUndefined();
    expect(findInsert(ops, "notifications")).toBeUndefined();
  });

  it("stays suggest-only when the run clears the gate but the toggle is OFF", async () => {
    const { client, ops } = scenario({ settings: { auto_reprice_enabled: false } });
    const adapter = new MockEbayAdapter();
    const summary = await runRepriceSweep(client, {
      now: () => NOW,
      priceItem: async () => soldTightPrice(60),
      adapter,
    });
    expect(summary.suggested).toBe(1);
    expect(summary.autoApplied).toBe(0);
    expect(adapter.reviseRequests).toHaveLength(0);
    expect(
      (findInsert(ops, "reprice_suggestions")?.payload as { autopilot_eligible?: boolean })
        .autopilot_eligible,
    ).toBe(true);
  });
});

describe("runRepriceSweep — auto-apply", () => {
  it("revises through the adapter and invalidates an in-flight export when opted in", async () => {
    const { client, ops } = scenario({ settings: { auto_reprice_enabled: true } });
    const adapter = new MockEbayAdapter();

    const summary = await runRepriceSweep(client, {
      now: () => NOW,
      priceItem: async () => soldTightPrice(60),
      adapter,
    });

    expect(summary).toMatchObject({ autoApplied: 1, suggested: 0, failed: 0 });

    // The eBay revision went through the adapter seam.
    expect(adapter.reviseRequests).toEqual([
      {
        sku: LISTING,
        offerId: "offer-1",
        price: { value: "60.00", currency: "USD" },
      },
    ]);

    // Recorded: audit row + the two price writes, all tenant-pinned.
    const suggestion = findInsert(ops, "reprice_suggestions");
    expect(suggestion?.payload).toMatchObject({
      status: "auto_applied",
      applied_price: 60,
      current_price: 100,
    });
    const itemWrite = findUpdates(ops, "items").find(
      (op) => (op.payload as { price_override?: number }).price_override === 60,
    );
    expect(itemWrite?.eq).toMatchObject({ id: ITEM, user_id: USER });
    expect(itemWrite?.payload).toMatchObject({
      price_override: 60,
      review_revision: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
    });
    const listingWrite = findUpdates(ops, "listings").find(
      (op) => (op.payload as { listed_price?: number }).listed_price === 60,
    );
    expect(listingWrite?.eq).toMatchObject({ id: LISTING, user_id: USER });
    expect(findInsert(ops, "notifications")).toBeTruthy();
  });

  it("resolves the scheduled adapter for the listing tenant before auto-apply", async () => {
    const { client } = scenario({ settings: { auto_reprice_enabled: true } });
    const adapter = new MockEbayAdapter();
    const adapterForUser = vi.fn(async () => adapter);

    const summary = await runRepriceSweep(client, {
      now: () => NOW,
      priceItem: async () => soldTightPrice(60),
      adapterForUser,
    });

    expect(summary.autoApplied).toBe(1);
    expect(adapterForUser).toHaveBeenCalledWith(USER);
    expect(adapter.reviseRequests).toHaveLength(1);
  });

  it("degrades to a suggestion when the seller has no scheduled write credentials", async () => {
    const { client, ops } = scenario({ settings: { auto_reprice_enabled: true } });

    const summary = await runRepriceSweep(client, {
      now: () => NOW,
      priceItem: async () => soldTightPrice(60),
      adapterForUser: async () => {
        throw new Error("seller connection unavailable");
      },
    });

    expect(summary).toMatchObject({ suggested: 1, autoApplied: 0, failed: 0 });
    expect(findInsert(ops, "reprice_suggestions")?.payload).toMatchObject({
      status: "pending",
      applied_price: null,
    });
  });

  it("syncs prices and notifies even when the audit-row insert fails (eBay already revised)", async () => {
    const listing = { ...candidate };
    const item = { ...identifiedItem };
    const { client, ops } = fakeSupabase((op) => {
      if (op.table === "listings" && op.action === "select") return { data: [listing] };
      if (op.table === "items" && op.action === "select") return { data: [item] };
      if (op.table === "user_settings" && op.action === "select")
        return { data: [{ user_id: USER, autopilot_enabled: true, auto_reprice_enabled: true }] };
      if (op.table === "reprice_suggestions" && op.action === "insert")
        return { error: { message: "audit insert boom" } };
      return { data: null, error: null };
    });
    const adapter = new MockEbayAdapter();

    const summary = await runRepriceSweep(client, {
      now: () => NOW,
      priceItem: async () => soldTightPrice(60),
      adapter,
    });

    // The live eBay revision is irreversible, so the run still counts as applied.
    expect(summary).toMatchObject({ autoApplied: 1, suggested: 0, failed: 0 });
    expect(adapter.reviseRequests).toHaveLength(1);

    // The consistency writes and notification are NOT skipped by the audit failure.
    expect(
      findUpdates(ops, "items").some(
        (op) => (op.payload as { price_override?: number }).price_override === 60,
      ),
    ).toBe(true);
    expect(
      findUpdates(ops, "listings").some(
        (op) => (op.payload as { listed_price?: number }).listed_price === 60,
      ),
    ).toBe(true);
    expect(findInsert(ops, "notifications")).toBeTruthy();
  });

  it("never auto-applies below the seller's floor — clamps and downgrades to a suggestion", async () => {
    const { client, ops } = scenario({
      settings: { auto_reprice_enabled: true },
      item: { price_floor: 90 },
    });
    const adapter = new MockEbayAdapter();

    const summary = await runRepriceSweep(client, {
      now: () => NOW,
      priceItem: async () => soldTightPrice(60),
      adapter,
    });

    expect(summary).toMatchObject({ suggested: 1, autoApplied: 0 });
    expect(adapter.reviseRequests).toHaveLength(0);
    expect(findInsert(ops, "reprice_suggestions")?.payload).toMatchObject({
      status: "pending",
      target_price: 90,
      floored_to_minimum: true,
    });
  });

  it("stays suggest-only when the run is below the confidence gate, toggle on or not", async () => {
    const { client } = scenario({ settings: { auto_reprice_enabled: true } });
    const adapter = new MockEbayAdapter();
    const summary = await runRepriceSweep(client, {
      now: () => NOW,
      priceItem: async () => askingWidePrice(60),
      adapter,
    });
    expect(summary).toMatchObject({ suggested: 1, autoApplied: 0 });
    expect(adapter.reviseRequests).toHaveLength(0);
  });

  it("degrades to a pending suggestion when the adapter revision fails", async () => {
    const { client, ops } = scenario({ settings: { auto_reprice_enabled: true } });
    const adapter = new MockEbayAdapter();
    adapter.reviseFailWith = new Error("eBay is down");

    const summary = await runRepriceSweep(client, {
      now: () => NOW,
      priceItem: async () => soldTightPrice(60),
      adapter,
    });

    expect(summary).toMatchObject({ suggested: 1, autoApplied: 0 });
    expect(findInsert(ops, "reprice_suggestions")?.payload).toMatchObject({
      status: "pending",
      applied_price: null,
    });
    // The failed apply must not have written any price.
    expect(
      findUpdates(ops, "items").some(
        (op) => (op.payload as { price_override?: number }).price_override != null,
      ),
    ).toBe(false);
  });

  it("respects the seller's price override as the current price", async () => {
    const { client, ops } = scenario({
      settings: { auto_reprice_enabled: true },
      item: { price_override: 120 },
    });
    await runRepriceSweep(client, {
      now: () => NOW,
      priceItem: async () => soldTightPrice(60),
      adapter: new MockEbayAdapter(),
    });
    expect(findInsert(ops, "reprice_suggestions")?.payload).toMatchObject({
      current_price: 120,
      drift_pct: -50,
    });
  });
});

describe("runRepriceSweep — batch resilience & guardrails", () => {
  it("one failing item doesn't sink the sweep; its cursor still advances", async () => {
    const listingB = { ...candidate, id: LISTING.replace("2222", "3333"), item_id: ITEM.replace("1111", "4444") };
    const itemB = { ...identifiedItem, id: listingB.item_id };
    const { client, ops } = fakeSupabase((op) => {
      if (op.table === "listings" && op.action === "select")
        return { data: [candidate, listingB] };
      if (op.table === "items" && op.action === "select")
        return { data: [identifiedItem, itemB] };
      if (op.table === "user_settings" && op.action === "select") return { data: [] };
      return { data: null, error: null };
    });

    let call = 0;
    const summary = await runRepriceSweep(client, {
      now: () => NOW,
      priceItem: async () => {
        call += 1;
        if (call === 1) throw new Error("scraper blocked");
        return askingWidePrice(80);
      },
      adapter: new MockEbayAdapter(),
    });

    expect(summary).toMatchObject({ scanned: 2, failed: 1, suggested: 1 });
    // BOTH cursors advanced — the poisoned listing can't wedge future batches.
    const cursorTouches = findUpdates(ops, "listings").filter(
      (op) => (op.payload as { last_priced_at?: string }).last_priced_at,
    );
    expect(cursorTouches.length).toBeGreaterThanOrEqual(2);
  });

  it("caps the candidate scan at the configured batch size (spend guardrail)", async () => {
    const { client, ops } = scenario();
    await runRepriceSweep(client, {
      now: () => NOW,
      priceItem: async () => askingWidePrice(97),
      adapter: new MockEbayAdapter(),
      config: { batchSize: 3 },
    });
    const scan = ops.find((op) => op.table === "listings" && op.action === "select");
    expect(scan?.limit).toBe(3);
    expect(scan?.eq).toMatchObject({ platform: "ebay", ebay_status: "published" });
    expect(scan?.or).toContain("last_priced_at.is.null");
  });

  it("skips a tenant-mismatched item without writing anything for it", async () => {
    const { client, ops } = scenario({ item: { user_id: "user_clerk_b" } });
    const summary = await runRepriceSweep(client, {
      now: () => NOW,
      priceItem: async () => soldTightPrice(60),
      adapter: new MockEbayAdapter(),
    });
    expect(summary.failed).toBe(1);
    expect(findInsert(ops, "prediction_logs")).toBeUndefined();
    expect(findInsert(ops, "reprice_suggestions")).toBeUndefined();
  });
});
