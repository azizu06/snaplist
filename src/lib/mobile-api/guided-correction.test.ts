import { describe, expect, it, vi } from "vitest";
import type { ItemSignal, PriceResult } from "@/lib/pricing";
import type { PipelineWorker } from "@/lib/pipeline-queue/composition";
import { createMobileApiHandler, type MobileApiPrincipal } from "./app";
import {
  createGuidedCorrectionService,
  createSupabaseGuidedCorrectionDataClient,
  type GuidedCorrectionCommit,
  type GuidedCorrectionDataClient,
  type GuidedCorrectionSnapshot,
} from "./guided-correction";

/**
 * Guided identity correction ("Sharpen the estimate") over the native seam.
 *
 * The seam under test is the HTTP route, not the pipeline: a native request is
 * driven through the real `createMobileApiHandler` into the real correction
 * service, and only the RLS-scoped data client is a fake. That fake models what
 * Postgres RLS does — a client built from another seller's bearer simply cannot
 * see the row — so "a non-owner gets no data and no side effect" is asserted
 * where a native request can actually go wrong.
 *
 * `repriceWithSpecs` is NEVER stubbed. Only its injected `priceItem` is, which
 * is the seam `RepriceInput` already exposes for offline tests. Every case below
 * therefore runs the real merge/pricing/confidence path.
 */

const RUN_ID = "59700000-0000-4000-8000-000000000001";
const ITEM_ID = "59700000-0000-4000-8000-000000000002";
const REVIEW_REVISION = "59700000-0000-4000-8000-000000000003";
const NEXT_RUN_ID = "59700000-0000-4000-8000-000000000004";

const OWNER = "user_owner_597";
const INTRUDER = "user_intruder_597";
const OWNER_TOKEN = "owner-bearer-597";
const INTRUDER_TOKEN = "intruder-bearer-597";

const unavailableWorker: PipelineWorker = {
  async consume() {
    throw new Error("This test composes no pipeline-consumer capability.");
  },
};

/**
 * Deliberately uncast: a `as PriceResult` fixture would keep compiling after the
 * real provider contract moved, and every price assertion below would then be
 * measuring a shape production never returns.
 */
function soldPrice(suggested: number): PriceResult {
  return {
    suggested,
    range: { min: suggested - 20, max: suggested + 20 },
    confidence: 0.8,
    sources: [{ url: "https://www.ebay.com/itm/597", title: "Sold comp" }],
    tier: "ebay-sold",
  };
}

function snapshot(
  overrides: Partial<GuidedCorrectionSnapshot> = {},
): GuidedCorrectionSnapshot {
  return {
    itemId: ITEM_ID,
    attributes: {
      brand: "Dell",
      model: "XPS 15",
      category: "electronics",
      condition: "good",
      specs: ["16GB RAM"],
    },
    reviewRevision: REVIEW_REVISION,
    priceOverride: null,
    publishState: "editable",
    model: "vision-model",
    listingModel: "listing-model",
    autopilotEnabled: false,
    ...overrides,
  };
}

interface Harness {
  handler: (request: Request) => Promise<Response>;
  commits: GuidedCorrectionCommit[];
  priceItem: ReturnType<typeof vi.fn>;
}

/**
 * One tenant owns the run. `clientForBearer` hands back a client that can only
 * see rows for the seller that bearer authenticates as — the fake stands in for
 * the RLS predicate, not for the correction.
 */
function harness(
  input: {
    stored?: GuidedCorrectionSnapshot;
    owner?: string;
    price?: PriceResult;
    commitError?: Error;
  } = {},
): Harness {
  const stored = input.stored ?? snapshot();
  const owner = input.owner ?? OWNER;
  const commits: GuidedCorrectionCommit[] = [];
  const priceItem = vi.fn(
    async (_signal: ItemSignal) => input.price ?? soldPrice(180),
  );

  const clientForBearer = (bearerToken: string): GuidedCorrectionDataClient => {
    const caller = bearerToken === OWNER_TOKEN ? OWNER : INTRUDER;
    const visible = caller === owner;
    return {
      async readRunSnapshot(runId) {
        return visible && runId === RUN_ID ? stored : null;
      },
      async commit(commit) {
        if (!visible) throw new Error("RLS refused a foreign write.");
        if (input.commitError) throw input.commitError;
        commits.push(commit);
      },
    };
  };

  const handler = createMobileApiHandler({
    async authenticate(token): Promise<MobileApiPrincipal> {
      if (token === OWNER_TOKEN) return { kind: "clerk", userId: OWNER };
      if (token === INTRUDER_TOKEN) return { kind: "clerk", userId: INTRUDER };
      throw new Error("Unknown bearer.");
    },
    guidedCorrection: createGuidedCorrectionService(clientForBearer, {
      priceItem,
      newRunId: () => NEXT_RUN_ID,
    }),
    worker: unavailableWorker,
  });

  return { handler, commits, priceItem };
}

function correctionRequest(
  token: string,
  body: unknown = {
    expectedReviewRevision: REVIEW_REVISION,
    addedSpecs: ["RTX 3060", "512GB SSD"],
  },
): Request {
  return new Request(`http://localhost/v1/runs/${RUN_ID}/sharpen`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/runs/{runId}/sharpen — ownership", () => {
  it("corrects the run for the seller who owns it", async () => {
    const { handler, commits, priceItem } = harness();

    const response = await handler(correctionRequest(OWNER_TOKEN));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { itemId: string } };
    expect(body.data.itemId).toBe(ITEM_ID);
    expect(commits).toHaveLength(1);
    expect(priceItem).toHaveBeenCalledTimes(1);
  });

  it("gives a non-owner no data and runs no correction", async () => {
    const { handler, commits, priceItem } = harness();

    const response = await handler(correctionRequest(INTRUDER_TOKEN));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "not_found",
        message: "This run is unavailable.",
        requestId: expect.any(String),
      },
    });
    // No persistence and no provider spend on a run the caller does not own.
    expect(commits).toEqual([]);
    expect(priceItem).not.toHaveBeenCalled();
  });

  it("requires a bearer token", async () => {
    const { handler, commits } = harness();

    const response = await handler(
      new Request(`http://localhost/v1/runs/${RUN_ID}/sharpen`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedReviewRevision: REVIEW_REVISION,
          addedSpecs: ["RTX 3060"],
        }),
      }),
    );

    expect(response.status).toBe(401);
    expect(commits).toEqual([]);
  });
});

describe("POST /v1/runs/{runId}/sharpen — effective price", () => {
  it("keeps the seller's saved override as the effective price", async () => {
    const { handler, commits } = harness({
      stored: snapshot({ priceOverride: 149.99 }),
      price: soldPrice(180),
    });

    const response = await handler(correctionRequest(OWNER_TOKEN));

    expect(response.status).toBe(200);
    const { data } = (await response.json()) as {
      data: {
        effectivePrice: number;
        suggestedPrice: number;
        sellerPriceOverride: number | null;
      };
    };
    // The override wins over the fresh recommendation, exactly as it does for
    // eBay publish and every export pack.
    expect(data.effectivePrice).toBe(149.99);
    expect(data.sellerPriceOverride).toBe(149.99);
    expect(data.suggestedPrice).toBe(180);

    // The correction must not write the override at all — the prediction log
    // stays recommendation history, never the seller's chosen price.
    expect(commits[0].prediction.price).toBe(180);
    expect(commits[0].attributes).not.toHaveProperty("price_override");
  });

  it("falls back to the fresh suggestion when no override is saved", async () => {
    const { handler } = harness({
      stored: snapshot({ priceOverride: null }),
      price: soldPrice(180),
    });

    const response = await handler(correctionRequest(OWNER_TOKEN));

    const { data } = (await response.json()) as {
      data: { effectivePrice: number; sellerPriceOverride: number | null };
    };
    expect(data.effectivePrice).toBe(180);
    expect(data.sellerPriceOverride).toBeNull();
  });

  it("ignores an unusable legacy override instead of publishing NaN", async () => {
    const { handler } = harness({
      stored: snapshot({ priceOverride: "not-a-price" }),
      price: soldPrice(180),
    });

    const response = await handler(correctionRequest(OWNER_TOKEN));

    const { data } = (await response.json()) as {
      data: { effectivePrice: number; sellerPriceOverride: number | null };
    };
    expect(data.effectivePrice).toBe(180);
    expect(data.sellerPriceOverride).toBeNull();
  });
});

describe("POST /v1/runs/{runId}/sharpen — revision guard", () => {
  it("advances the review revision to the new prediction run", async () => {
    const { handler, commits } = harness();

    const response = await handler(correctionRequest(OWNER_TOKEN));

    const { data } = (await response.json()) as {
      data: { runId: string; reviewRevision: string };
    };
    // The revision the seller held is spent, and the item now carries the new
    // run — so publish/export work started against the old one fails closed.
    expect(commits[0].expectedReviewRevision).toBe(REVIEW_REVISION);
    expect(commits[0].runId).toBe(NEXT_RUN_ID);
    expect(data.reviewRevision).toBe(NEXT_RUN_ID);
    expect(data.reviewRevision).not.toBe(REVIEW_REVISION);
  });

  it("refuses a correction aimed at a revision the item has moved past", async () => {
    const { handler, commits, priceItem } = harness();

    const response = await handler(
      correctionRequest(OWNER_TOKEN, {
        expectedReviewRevision: "59700000-0000-4000-8000-0000000000ff",
        addedSpecs: ["RTX 3060"],
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "conflict",
        message: "This review changed. Reload and try again.",
      },
    });
    expect(commits).toEqual([]);
    // Stale corrections are refused before any provider spend.
    expect(priceItem).not.toHaveBeenCalled();
  });
});

describe("guided correction Supabase adapter", () => {
  /**
   * The durable half of the contract — advancing `review_revision` and deleting
   * the item's cached Facebook/Mercari export packs — belongs to the
   * `sharpen_review_estimate` RPC, which `review-regeneration.rls.test.ts`
   * already proves against a real database. What has to hold HERE is that the
   * native seam commits through that exact RPC with the seller's expected
   * revision, rather than through some private write that would skip both.
   */
  it("commits through sharpen_review_estimate with the revision guard", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const client = {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({ data: null, error: null });
      },
    };

    await createSupabaseGuidedCorrectionDataClient(
      client as never,
    ).commit({
      itemId: ITEM_ID,
      expectedReviewRevision: REVIEW_REVISION,
      runId: NEXT_RUN_ID,
      attributes: { brand: "Dell", specs: ["512GB SSD"] },
      prediction: {
        user_id: OWNER,
        item_id: ITEM_ID,
        run_id: NEXT_RUN_ID,
        extracted_attrs: { brand: "Dell" },
        price: 180,
        price_range: { low: 160, high: 200 },
        confidence: 0.8,
        tier_fired: "ebay-sold",
        model: "vision-model",
        listing_model: "listing-model",
        pricing_model: null,
        sources: [],
        autopilot_enabled: false,
        autopilot_eligible: false,
      } as never,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("sharpen_review_estimate");
    expect(calls[0].args).toMatchObject({
      p_item_id: ITEM_ID,
      p_expected_review_revision: REVIEW_REVISION,
      p_run_id: NEXT_RUN_ID,
      p_price: 180,
    });
  });

  it("reports a lost revision race as a stale review, not a server fault", async () => {
    const client = {
      rpc() {
        return Promise.resolve({
          data: null,
          error: { code: "P0002", message: "Review changed. Reload and try again." },
        });
      },
    };

    await expect(
      createSupabaseGuidedCorrectionDataClient(client as never).commit({
        itemId: ITEM_ID,
        expectedReviewRevision: REVIEW_REVISION,
        runId: NEXT_RUN_ID,
        attributes: {},
        prediction: { price: 180, price_range: { low: 1, high: 2 } } as never,
      }),
    ).rejects.toThrow("This review changed. Reload and try again.");
  });
});

describe("POST /v1/runs/{runId}/sharpen — publish state", () => {
  it.each([
    ["a published listing", { publishState: "authoritative" as const }],
  ])("refuses to correct %s", async (_label, overrides) => {
    const { handler, commits, priceItem } = harness({
      stored: snapshot(overrides),
    });

    const response = await handler(correctionRequest(OWNER_TOKEN));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "conflict",
        message: "A published listing cannot be changed from review.",
      },
    });
    // Rejected, not corrected: nothing is persisted and no provider work runs,
    // so correcting can never become a side-effecting publish.
    expect(commits).toEqual([]);
    expect(priceItem).not.toHaveBeenCalled();
  });

  it("treats every provider-authoritative eBay signal as uncorrectable", async () => {
    const authoritative = [
      { status: "published", ebay_listing_id: null, ebay_status: null },
      { status: "draft", ebay_listing_id: "1100200300", ebay_status: null },
      { status: "draft", ebay_listing_id: null, ebay_status: "publishing" },
      { status: "draft", ebay_listing_id: null, ebay_status: "published" },
    ];

    for (const listing of authoritative) {
      const reads: Record<string, unknown> = {
        pipeline_runs: { id: RUN_ID, item_id: ITEM_ID },
        items: {
          attributes: { brand: "Dell" },
          price_override: null,
          review_revision: REVIEW_REVISION,
        },
        listings: [listing],
        prediction_logs: {
          model: "vision-model",
          listing_model: null,
          autopilot_enabled: false,
        },
      };
      const supabase = {
        from(table: string) {
          const builder: Record<string, unknown> = {};
          for (const method of ["select", "eq", "order", "limit"]) {
            builder[method] = () => builder;
          }
          builder.maybeSingle = () =>
            Promise.resolve({ data: reads[table], error: null });
          builder.then = (resolve: (value: unknown) => unknown) =>
            resolve({ data: reads[table], error: null });
          return builder;
        },
      };

      const snapshotRead = await createSupabaseGuidedCorrectionDataClient(
        supabase as never,
      ).readRunSnapshot(RUN_ID);

      expect(snapshotRead?.publishState).toBe("authoritative");
    }
  });
});
