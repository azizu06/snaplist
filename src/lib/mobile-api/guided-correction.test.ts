import { describe, expect, it, vi } from "vitest";
import type { ItemSignal, PriceResult } from "@/lib/pricing";
import type { PipelineWorker } from "@/lib/pipeline-queue/composition";
import { createMobileApiHandler, type MobileApiPrincipal } from "./app";
import {
  createGuidedCorrectionService,
  createSupabaseGuidedCorrectionDataClient,
  GuidedCorrectionIdempotencyConflictError,
  GuidedCorrectionNotFoundError,
  type GuidedCorrectionCommit,
  type GuidedCorrectionDataClient,
  type GuidedCorrectionOperation,
  type GuidedCorrectionReceipt,
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
const IDEMPOTENCY_KEY = "59700000-0000-4000-8000-00000000000a";
const OTHER_IDEMPOTENCY_KEY = "59700000-0000-4000-8000-00000000000b";

/**
 * A guest's capability bearer is NOT a project JWT — PostgREST cannot verify it,
 * so a guest correction only reaches its own rows through the short-lived
 * operation token the principal mints. The fake below therefore recognizes the
 * minted token and not the raw bearer, which is exactly the asymmetry
 * production has.
 */
const GUEST_TOKEN = "guestcap_597";
const GUEST_OPERATION_TOKEN = "guest-operation-jwt-597";

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
    priced: true,
    model: "vision-model",
    listingModel: "listing-model",
    autopilotEnabled: false,
    identification: { ...STORED_IDENTITY, evidence: 0.75 },
    ...overrides,
  };
}

interface Harness {
  handler: (request: Request) => Promise<Response>;
  commits: GuidedCorrectionCommit[];
  priceItem: ReturnType<typeof vi.fn>;
  /**
   * What `get_mobile_listing_review` would project for this item after every
   * commit above — the durable review the native client renders next.
   */
  readBackIdentity: () => { label: string; confident: boolean };
  /** Every token this correction actually presented to Postgres, in order. */
  rlsTokens: string[];
}

/** One row of `private.mobile_guided_corrections`, as the claim RPC keeps it. */
interface StoredClaim {
  runId: string;
  expectedReviewRevision: string;
  /** Serialized so a replayed key can be compared against its bound intent. */
  intent: string;
  state: "pending" | "completed" | "failed";
  receipt?: GuidedCorrectionReceipt;
}

/** The identity the item carried BEFORE any correction in these tests. */
const STORED_IDENTITY: { label: string; confident: boolean } = {
  label: "Dell XPS 15",
  confident: true,
};

/**
 * One tenant owns the run. Every method resolves the token the operation would
 * actually present to Postgres and answers only for the seller that token
 * authenticates as — the fake stands in for the RLS predicate, not for the
 * correction.
 */
function harness(
  input: {
    stored?: GuidedCorrectionSnapshot;
    owner?: string;
    price?: PriceResult;
    commitError?: Error;
    settleError?: Error;
  } = {},
): Harness {
  const stored = input.stored ?? snapshot();
  const owner = input.owner ?? OWNER;
  const commits: GuidedCorrectionCommit[] = [];
  const priceItem = vi.fn(
    async (_signal: ItemSignal) => input.price ?? soldPrice(180),
  );

  /**
   * The durable `items.identification` column, modelled exactly as the two RPCs
   * treat it: `sharpen_review_estimate` applies
   * `identification = coalesce(p_identification, identification)`, and
   * `get_mobile_listing_review` projects the column verbatim into the native
   * client's `identity.label` / `identity.confident`.
   *
   * The read-back deliberately does NOT re-derive the identity from the
   * attributes. Re-deriving here would make the assertion pass on a correction
   * that never reached the column, which is exactly the defect being asserted
   * against.
   */
  const durableIdentity = { ...STORED_IDENTITY };

  /**
   * `private.mobile_guided_corrections`, modelled as the claim RPC keeps it:
   * one row per (seller, Idempotency-Key), a pending lease that blocks a
   * competing correction on the same revision, and a stored receipt so a replay
   * is answered rather than re-run.
   */
  const claims = new Map<string, StoredClaim>();
  const rlsTokens: string[] = [];

  /**
   * The token the operation actually presents to Postgres. A guest's raw
   * capability bearer authenticates as nobody here, exactly as PostgREST treats
   * it, so a correction that skips minting simply cannot see its own rows.
   */
  async function rlsToken(
    operation: GuidedCorrectionOperation,
  ): Promise<string> {
    const token = operation.mintOperationToken
      ? await operation.mintOperationToken()
      : operation.bearerToken;
    rlsTokens.push(token);
    return token;
  }

  async function callerFor(
    operation: GuidedCorrectionOperation,
  ): Promise<string | null> {
    const token = await rlsToken(operation);
    if (token === OWNER_TOKEN || token === GUEST_OPERATION_TOKEN) return OWNER;
    if (token === INTRUDER_TOKEN) return INTRUDER;
    return null;
  }

  const dataClient: GuidedCorrectionDataClient = {
    async readRunSnapshot(operation) {
      const caller = await callerFor(operation);
      return caller === owner && operation.runId === RUN_ID ? stored : null;
    },
    async claim(operation) {
      const caller = await callerFor(operation);
      // The claim RPC verifies run ownership itself, so a foreign run is
      // refused there rather than proved absent by a second read.
      if (caller !== owner) throw new GuidedCorrectionNotFoundError();
      const key = `${caller}:${operation.idempotencyKey}`;
      const existing = claims.get(key);
      const intent = JSON.stringify(operation.intent);
      if (existing && existing.intent !== intent) {
        throw new GuidedCorrectionIdempotencyConflictError();
      }
      if (existing?.state === "completed") {
        return { state: "completed", receipt: existing.receipt! };
      }
      if (existing?.state === "pending") return { state: "in_progress" };
      // Nothing between this probe and the insert may yield, or the fake would
      // let both racers through and stop modelling the row lock the RPC holds.
      const competing = [...claims.entries()].some(
        ([storedKey, claim]) =>
          storedKey !== key
          && storedKey.startsWith(`${caller}:`)
          && claim.runId === operation.runId
          && claim.expectedReviewRevision
            === operation.intent.expectedReviewRevision
          && claim.state === "pending",
      );
      if (competing) return { state: "in_progress" };
      claims.set(key, {
        runId: operation.runId,
        expectedReviewRevision: operation.intent.expectedReviewRevision,
        intent,
        state: "pending",
      });
      return { state: "proceed" };
    },
    async settle(operation, receipt) {
      if (input.settleError) throw input.settleError;
      const caller = await callerFor(operation);
      const key = `${caller}:${operation.idempotencyKey}`;
      const existing = claims.get(key);
      if (!existing) throw new Error("No claim to settle.");
      claims.set(key, { ...existing, state: "completed", receipt });
    },
    async release(operation) {
      const caller = await callerFor(operation);
      const key = `${caller}:${operation.idempotencyKey}`;
      const existing = claims.get(key);
      if (existing?.state === "pending") {
        claims.set(key, { ...existing, state: "failed" });
      }
    },
    async commit(operation, commit) {
      const caller = await callerFor(operation);
      if (caller !== owner) throw new Error("RLS refused a foreign write.");
      if (input.commitError) throw input.commitError;
      commits.push(commit);
      const written = commit.identification;
      if (written) {
        durableIdentity.label = written.label;
        durableIdentity.confident = written.confident;
      }
    },
  };

  const handler = createMobileApiHandler({
    async authenticate(token): Promise<MobileApiPrincipal> {
      if (token === OWNER_TOKEN) return { kind: "clerk", userId: OWNER };
      if (token === INTRUDER_TOKEN) return { kind: "clerk", userId: INTRUDER };
      if (token === GUEST_TOKEN) {
        return {
          kind: "verifiedGuest",
          mintOperationToken: async () => GUEST_OPERATION_TOKEN,
          userId: OWNER,
        };
      }
      throw new Error("Unknown bearer.");
    },
    guidedCorrection: createGuidedCorrectionService(dataClient, {
      priceItem,
      newRunId: () => NEXT_RUN_ID,
    }),
    worker: unavailableWorker,
  });

  return {
    handler,
    commits,
    priceItem,
    readBackIdentity: () => ({ ...durableIdentity }),
    rlsTokens,
  };
}

function correctionRequest(
  token: string,
  body: unknown = {
    expectedReviewRevision: REVIEW_REVISION,
    addedSpecs: ["RTX 3060", "512GB SSD"],
  },
  idempotencyKey: string = IDEMPOTENCY_KEY,
): Request {
  return new Request(`http://localhost/v1/runs/${RUN_ID}/sharpen`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

/** The operation every adapter-level assertion below runs under. */
function operation(
  overrides: Partial<GuidedCorrectionOperation> = {},
): GuidedCorrectionOperation {
  return {
    runId: RUN_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    userId: OWNER,
    bearerToken: OWNER_TOKEN,
    intent: {
      expectedReviewRevision: REVIEW_REVISION,
      addedSpecs: ["RTX 3060"],
    },
    ...overrides,
  };
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
        headers: {
          "content-type": "application/json",
          "idempotency-key": IDEMPOTENCY_KEY,
        },
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

describe("POST /v1/runs/{runId}/sharpen — corrected identity", () => {
  it("shows the seller the identity they confirmed when the review is read back", async () => {
    const { handler, readBackIdentity } = harness();

    const response = await handler(
      correctionRequest(OWNER_TOKEN, {
        expectedReviewRevision: REVIEW_REVISION,
        addedSpecs: ["RTX 3060"],
        confirmedIdentity: { brand: "Sony", model: "WH-1000XM4" },
      }),
    );

    expect(response.status).toBe(200);
    // The receipt is not what the seller reads next — the durable review is.
    // A coherent receipt sitting next to the identity the seller just replaced
    // is not a correction that succeeded, it is one that silently did not
    // happen. "Sony WH-1000XM4" is the confirmed brand and model, which is the
    // whole point of an issue titled guided IDENTITY correction.
    expect(readBackIdentity()).toEqual({
      label: "Sony WH-1000XM4",
      confident: true,
    });
  });

  it("stores the confirmed identity in the attributes the identity was derived from", async () => {
    const { handler, commits } = harness();

    await handler(
      correctionRequest(OWNER_TOKEN, {
        expectedReviewRevision: REVIEW_REVISION,
        addedSpecs: ["RTX 3060"],
        confirmedIdentity: { brand: "Sony", model: "WH-1000XM4" },
      }),
    );

    // The identification and the attributes are read by different consumers —
    // the review projection reads one, eBay publish and the export packs read
    // the other. Storing a corrected identity in only one of them leaves the
    // item claiming to be two different things at once.
    expect(commits[0].attributes).toMatchObject({
      brand: "Sony",
      model: "WH-1000XM4",
      title: "Sony WH-1000XM4",
    });
    expect(commits[0].identification?.label).toBe("Sony WH-1000XM4");
  });

  it("carries a partial confirmation without losing the field left alone", async () => {
    const { handler, readBackIdentity } = harness();

    const response = await handler(
      correctionRequest(OWNER_TOKEN, {
        expectedReviewRevision: REVIEW_REVISION,
        addedSpecs: ["RTX 3060"],
        confirmedIdentity: { model: "XPS 17" },
      }),
    );

    expect(response.status).toBe(200);
    // Only the model was confirmed, so the stored brand still stands. A
    // correction that blanked the untouched field would be a data loss the
    // seller never asked for.
    expect(readBackIdentity().label).toBe("Dell XPS 17");
  });

  it("leaves the identity alone when the seller only added specs", async () => {
    const { handler, readBackIdentity } = harness();

    const response = await handler(correctionRequest(OWNER_TOKEN));

    expect(response.status).toBe(200);
    // A specs-only sharpen narrows the pricing search; it makes no claim about
    // what the item IS, so it must not rewrite the vision step's identification.
    expect(readBackIdentity()).toEqual(STORED_IDENTITY);
  });
});

describe("POST /v1/runs/{runId}/sharpen — failure never bricks the item", () => {
  it("refuses an unusable recommendation without spending the review revision", async () => {
    // A suggestion that rounds below a cent clears the RPC's `p_price > 0`
    // guard and then fails price parsing. If that failure landed AFTER the
    // commit, the item would have advanced its revision while the caller got a
    // 503 — and every retry would then carry the revision the item moved past
    // and 409 forever, leaving the item permanently uncorrectable.
    const { handler, commits } = harness({ price: soldPrice(0.004) });

    const response = await handler(correctionRequest(OWNER_TOKEN));

    expect(response.status).toBe(503);
    expect(commits).toEqual([]);
  });

  it("keeps a landed correction successful when recording the claim fails", async () => {
    const { handler, commits } = harness({
      settleError: new Error("The claim store is unavailable."),
    });

    const response = await handler(correctionRequest(OWNER_TOKEN));

    // The durable write already happened. Reporting 503 here would send the
    // client back with a revision the item has moved past — the same permanent
    // 409 the pre-commit receipt exists to prevent, one step later.
    expect(commits).toHaveLength(1);
    expect(response.status).toBe(200);
  });

  it("keeps a retry after an unusable recommendation on the same revision", async () => {
    const { handler, commits } = harness({ price: soldPrice(0.004) });

    await handler(correctionRequest(OWNER_TOKEN));
    // Nothing was spent, so the seller's revision is still the live one and the
    // retry is a fresh, legal correction rather than a permanent 409.
    const retry = await handler(correctionRequest(OWNER_TOKEN));

    expect(retry.status).toBe(503);
    expect(commits).toEqual([]);
  });
});

describe("POST /v1/runs/{runId}/sharpen — priced items", () => {
  it("corrects a priced item whose historical model provenance is null", async () => {
    const { handler, commits } = harness({
      stored: snapshot({ priced: true, model: null }),
    });

    const response = await handler(correctionRequest(OWNER_TOKEN));

    // `prediction_logs.model` is nullable, so a legacy row loses the model
    // string while keeping a real price. Refusing here would make a genuinely
    // priced item permanently uncorrectable on native.
    expect(response.status).toBe(200);
    expect(commits).toHaveLength(1);
    // The RPC demands model provenance, so the correction rides "unknown"
    // forward rather than inventing one or refusing the price.
    expect(commits[0].prediction.model).toBe("unknown");
  });

  it("refuses an item that carries no usable price at all", async () => {
    const { handler, commits, priceItem } = harness({
      stored: snapshot({ priced: false, model: null }),
    });

    const response = await handler(correctionRequest(OWNER_TOKEN));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "conflict",
        message: "This item hasn't been priced yet — nothing to sharpen.",
      },
    });
    expect(commits).toEqual([]);
    expect(priceItem).not.toHaveBeenCalled();
  });

  it("reads pricedness from the price column, not the model string", async () => {
    const reads: Record<string, unknown> = {
      pipeline_runs: { id: RUN_ID, item_id: ITEM_ID },
      items: {
        attributes: { brand: "Dell" },
        identification: { ...STORED_IDENTITY, evidence: 0.75 },
        price_override: null,
        review_revision: REVIEW_REVISION,
      },
      listings: [],
      prediction_logs: {
        model: null,
        listing_model: null,
        autopilot_enabled: false,
        // `numeric` reaches the client as a string.
        price: "180.00",
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

    const read = await createSupabaseGuidedCorrectionDataClient(
      () => supabase as never,
    ).readRunSnapshot(operation());

    expect(read?.priced).toBe(true);
    expect(read?.model).toBeNull();
  });

  it.each([
    ["no price at all", null],
    ["a zero price", 0],
    ["an unparseable legacy price", "not-a-price"],
  ])("reads %s as not priced", async (_label, price) => {
    // The mirror of the case above. Without this, a `priced` that answered
    // `true` for everything would satisfy every other assertion here, and the
    // gate meant to refuse an unpriced item would silently refuse nothing.
    const reads: Record<string, unknown> = {
      pipeline_runs: { id: RUN_ID, item_id: ITEM_ID },
      items: {
        attributes: { brand: "Dell" },
        identification: { ...STORED_IDENTITY, evidence: 0.75 },
        price_override: null,
        review_revision: REVIEW_REVISION,
      },
      listings: [],
      prediction_logs: {
        model: "vision-model",
        listing_model: "listing-model",
        autopilot_enabled: false,
        price,
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

    const read = await createSupabaseGuidedCorrectionDataClient(
      () => supabase as never,
    ).readRunSnapshot(operation());

    expect(read?.priced).toBe(false);
  });
});

describe("POST /v1/runs/{runId}/sharpen — provider spend", () => {
  it("pays for pricing once when two corrections race the same revision", async () => {
    const { handler, commits, priceItem } = harness();

    // Both hold the revision the seller was looking at, so both clear the
    // cheap pre-check. Exactly one can win the RPC's revision guard — without a
    // claim the loser still runs the PriceRouter first, and that provider spend
    // is billed and then thrown away.
    const [first, second] = await Promise.all([
      handler(correctionRequest(OWNER_TOKEN)),
      handler(
        correctionRequest(
          OWNER_TOKEN,
          {
            expectedReviewRevision: REVIEW_REVISION,
            addedSpecs: ["RTX 3060", "512GB SSD"],
          },
          OTHER_IDEMPOTENCY_KEY,
        ),
      ),
    ]);

    expect(priceItem).toHaveBeenCalledTimes(1);
    expect(commits).toHaveLength(1);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
  });

  it("replays a completed correction from its receipt instead of re-pricing", async () => {
    const { handler, commits, priceItem } = harness();

    const first = await handler(correctionRequest(OWNER_TOKEN));
    // The native client retried a request it never saw the response to. The
    // item has already moved past the revision this intent carries, so re-running
    // would both spend the provider again and then 409 the seller off their own
    // completed work.
    const replay = await handler(correctionRequest(OWNER_TOKEN));

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    const firstBody = (await first.json()) as { data: unknown };
    const replayBody = (await replay.json()) as { data: unknown };
    expect(replayBody.data).toEqual(firstBody.data);
    expect(priceItem).toHaveBeenCalledTimes(1);
    expect(commits).toHaveLength(1);
  });

  it("refuses a key already bound to a different correction", async () => {
    const { handler, priceItem } = harness();

    await handler(correctionRequest(OWNER_TOKEN));
    const reused = await handler(
      correctionRequest(OWNER_TOKEN, {
        expectedReviewRevision: REVIEW_REVISION,
        addedSpecs: ["A completely different spec"],
      }),
    );

    // Answering this with the first correction's receipt would silently discard
    // the second intent, so it is a conflict rather than a replay.
    expect(reused.status).toBe(409);
    expect(priceItem).toHaveBeenCalledTimes(1);
  });

  it("requires an Idempotency-Key before any provider work", async () => {
    const { handler, priceItem, commits } = harness();

    const response = await handler(
      new Request(`http://localhost/v1/runs/${RUN_ID}/sharpen`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${OWNER_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          expectedReviewRevision: REVIEW_REVISION,
          addedSpecs: ["RTX 3060"],
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "invalid_request",
        message: "A valid Idempotency-Key is required.",
      },
    });
    expect(priceItem).not.toHaveBeenCalled();
    expect(commits).toEqual([]);
  });
});

describe("POST /v1/runs/{runId}/sharpen — verified guest", () => {
  it("corrects a guest's own pre-claim result through a minted operation token", async () => {
    const { handler, commits, rlsTokens } = harness();

    const response = await handler(correctionRequest(GUEST_TOKEN));

    // The route already advertises GuestBearer, and the guest-first-value path
    // is where a seller most needs to fix a wrong identity — before they have
    // an account to lose. The raw `guestcap_` bearer is not a project JWT, so
    // this only works if every read and write mints an operation token first.
    expect(response.status).toBe(200);
    expect(commits).toHaveLength(1);
    expect(rlsTokens).not.toContain(GUEST_TOKEN);
    expect(new Set(rlsTokens)).toEqual(new Set([GUEST_OPERATION_TOKEN]));
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
      () => client as never,
    ).commit(operation(), {
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
      createSupabaseGuidedCorrectionDataClient(() => client as never).commit(
        operation(),
        {
        itemId: ITEM_ID,
        expectedReviewRevision: REVIEW_REVISION,
        runId: NEXT_RUN_ID,
          attributes: {},
          prediction: { price: 180, price_range: { low: 1, high: 2 } } as never,
        },
      ),
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
          identification: { ...STORED_IDENTITY, evidence: 0.75 },
          price_override: null,
          review_revision: REVIEW_REVISION,
        },
        listings: [listing],
        prediction_logs: {
          model: "vision-model",
          listing_model: null,
          autopilot_enabled: false,
          price: 180,
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
        () => supabase as never,
      ).readRunSnapshot(operation());

      expect(snapshotRead?.publishState).toBe("authoritative");
    }
  });
});
