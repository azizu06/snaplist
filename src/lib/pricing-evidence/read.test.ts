import { describe, expect, it } from "vitest";
import {
  buildPricingEvidenceProjection,
  createSupabasePricingEvidenceReader,
} from "./read";

// PostgREST preserves PostgreSQL's explicit UTC offset on timestamptz fields.
const EVIDENCE_AS_OF = "2026-07-18T12:00:00+00:00";

function row() {
  const sold = [
    { id: "sale-1", price: 120, soldAt: Date.parse("2026-07-10T12:00:00.000Z") },
    { id: "sale-2", price: 125, soldAt: Date.parse("2026-07-12T12:00:00.000Z") },
    { id: "sale-3", price: 135 },
    { id: "sale-4", price: 140, soldAt: Date.parse("2026-07-16T12:00:00.000Z") },
  ].map((record) => ({
    ...record,
    sourceUrl: `https://www.ebay.com/itm/${record.id}`,
    title: `Sony headphones ${record.id}`,
    currency: "USD",
    kind: "sold-comparable",
    priceDisclosure: "displayed-sold-price",
    evidenceAsOf: EVIDENCE_AS_OF,
  }));
  const asking = {
    id: "asking-only",
    sourceUrl: "https://www.ebay.com/itm/asking-only",
    title: "Best offer accepted",
    price: 300,
    currency: "USD",
    condition: "Used",
    soldAt: Date.parse("2026-07-17T12:00:00.000Z"),
    kind: "sold-comparable",
    priceDisclosure: "asking-price-not-accepted-amount",
    evidenceAsOf: EVIDENCE_AS_OF,
  };
  return {
    run_id: "11111111-1111-4111-8111-111111111111",
    pipeline_run_id: "11111111-1111-4111-8111-111111111111",
    run_kind: "pipeline" as "pipeline" | "review-correction",
    user_id: "user_a",
    item_id: "22222222-2222-4222-8222-222222222222",
    prediction_id: "33333333-3333-4333-8333-333333333333",
    listing_id: "44444444-4444-4444-8444-444444444444",
    schema_version: 1,
    item: { title: "Sony WH-1000XM4", condition: "Used - Good" },
    price_result: {
      suggested: 130,
      range: { min: 120, max: 140 },
      confidence: 0.88,
      sources: [...sold, asking].map((evidence) => ({
        url: evidence.sourceUrl,
        title: evidence.title,
        kind: evidence.priceDisclosure === "displayed-sold-price" ? "sold-comp" : "asking-comp",
      })),
      tier: "ebay-sold",
      compAgreement: 0.8,
    },
    evidence: sold,
    evidence_as_of: EVIDENCE_AS_OF,
    pipeline_runs: {
      id: "11111111-1111-4111-8111-111111111111",
      status: "succeeded",
      stage: "completed",
      listing_id: "44444444-4444-4444-8444-444444444444",
      completed_at: EVIDENCE_AS_OF,
    },
    listings: {
      id: "44444444-4444-4444-8444-444444444444",
      run_id: "11111111-1111-4111-8111-111111111111",
      item_id: "22222222-2222-4222-8222-222222222222",
      user_id: "user_a",
    },
  };
}

describe("pricing-evidence read projection", () => {
  it("returns one coherent disclosed-sold snapshot with server fee and payout truth", () => {
    const projection = buildPricingEvidenceProjection(row(), {
      userId: "user_a",
      itemId: "22222222-2222-4222-8222-222222222222",
      now: Date.parse("2026-07-20T00:00:00.000Z"),
    });

    expect(projection.item).toEqual({
      id: "22222222-2222-4222-8222-222222222222",
      title: "Sony WH-1000XM4",
      condition: "Used - Good",
    });
    expect(projection.comparables.map((comparable) => comparable.id)).toEqual([
      "sale-1",
      "sale-2",
      "sale-3",
      "sale-4",
    ]);
    expect(projection.comparables[2]).not.toHaveProperty("soldAt");
    expect(projection.evidenceLevel).toBe("strong");
    expect(projection.defaultWindow).toBe("60D");
    expect(projection.evidenceAgeDays).toBe(1.5);
    expect(projection.isStale).toBe(false);
    expect(projection.estimatedFees).toBe(17.53);
    expect(projection.estimatedPayout).toBe(112.47);
    expect(projection.chartBounds).toEqual({ min: 120, max: 140 });
  });

  it("keeps a USD 0.01 recommendation schema-valid when its estimated fee is larger", () => {
    const subFee = row();
    subFee.price_result.suggested = 0.01;
    subFee.price_result.range = { min: 0.01, max: 0.01 };

    const projection = buildPricingEvidenceProjection(subFee, {
      userId: subFee.user_id,
      itemId: subFee.item_id,
      now: Date.parse("2026-07-20T00:00:00.000Z"),
    });

    expect(projection.priceResult.suggested).toBe(0.01);
    expect(projection.estimatedFees).toBe(0.3);
    expect(projection.estimatedPayout).toBe(0);
    expect(projection.comparables.every(({ currency }) => currency === "USD")).toBe(
      true,
    );
  });

  it("accepts research before completion and rejects evidence from after completion", () => {
    const completedLater = row();
    completedLater.pipeline_runs.completed_at = "2026-07-18T12:30:00+00:00";
    expect(() =>
      buildPricingEvidenceProjection(completedLater, {
        userId: completedLater.user_id,
        itemId: completedLater.item_id,
        now: Date.parse("2026-07-20T00:00:00.000Z"),
      }),
    ).not.toThrow();

    const completedBeforeResearch = row();
    completedBeforeResearch.pipeline_runs.completed_at = "2026-07-18T11:59:59+00:00";
    expect(() =>
      buildPricingEvidenceProjection(completedBeforeResearch, {
        userId: completedBeforeResearch.user_id,
        itemId: completedBeforeResearch.item_id,
        now: Date.parse("2026-07-20T00:00:00.000Z"),
      }),
    ).toThrow(/coherent|timestamp/i);
  });

  it("selects only the latest completed snapshot through the seller bearer client", async () => {
    const calls: unknown[][] = [];
    const older = row();
    older.run_id = "55555555-5555-4555-8555-555555555555";
    older.prediction_id = "66666666-6666-4666-8666-666666666666";
    older.listing_id = "77777777-7777-4777-8777-777777777777";
    older.evidence_as_of = "2026-07-17T12:00:00+00:00";
    older.price_result.suggested = 125;
    older.pipeline_runs.id = older.run_id;
    older.pipeline_runs.listing_id = older.listing_id;
    older.pipeline_runs.completed_at = older.evidence_as_of;
    older.listings.id = older.listing_id;
    older.listings.run_id = older.run_id;
    older.evidence = older.evidence.map((record) => ({
      ...record,
      evidenceAsOf: older.evidence_as_of,
    }));
    const candidates = [older, row()];
    const query = {
      select: (...args: unknown[]) => {
        calls.push(["select", ...args]);
        return query;
      },
      eq: (...args: unknown[]) => {
        calls.push(["eq", ...args]);
        return query;
      },
      order: (...args: unknown[]) => {
        calls.push(["order", ...args]);
        return query;
      },
      limit: async (...args: unknown[]) => {
        calls.push(["limit", ...args]);
        const hasDeterministicLatestOrder = calls.some(
          (call) =>
            call[0] === "order" &&
            call[1] === "evidence_as_of" &&
            (call[2] as { ascending?: boolean })?.ascending === false,
        );
        const selected = hasDeterministicLatestOrder
          ? [...candidates].sort((left, right) =>
              right.evidence_as_of.localeCompare(left.evidence_as_of),
            )[0]
          : candidates[0];
        return { data: [selected], error: null };
      },
    };
    const from = (table: string) => {
      calls.push(["from", table]);
      return query;
    };
    const clientForBearer = async (token: string) => {
      calls.push(["clientForBearer", token]);
      return { from };
    };
    const reader = createSupabasePricingEvidenceReader(clientForBearer as never);

    const result = await reader.forItem({
      userId: "user_a",
      bearerToken: "signed-jwt",
      itemId: "22222222-2222-4222-8222-222222222222",
      now: Date.parse("2026-07-20T00:00:00.000Z"),
    });

    expect(result?.priceResult.suggested).toBe(130);
    expect(calls).toContainEqual(["clientForBearer", "signed-jwt"]);
    expect(calls).toContainEqual(["from", "pricing_evidence_snapshots"]);
    expect(calls).toContainEqual([
      "eq",
      "item_id",
      "22222222-2222-4222-8222-222222222222",
    ]);
    expect(calls).toContainEqual(["eq", "user_id", "user_a"]);
    expect(calls).toContainEqual(["order", "evidence_as_of", { ascending: false }]);
    expect(calls).toContainEqual(["order", "run_id", { ascending: false }]);
    expect(calls).toContainEqual(["limit", 1]);
  });

  it("fails closed when run, item, tenant, or evidence timestamps are incoherent", () => {
    expect(() =>
      buildPricingEvidenceProjection(row(), {
        userId: "user_b",
        itemId: "22222222-2222-4222-8222-222222222222",
        now: Date.parse("2026-07-20T00:00:00.000Z"),
      }),
    ).toThrow(/coherent|tenant/i);

    const malformed = row();
    malformed.evidence[0]!.evidenceAsOf = "2026-07-01T00:00:00.000Z";
    expect(() =>
      buildPricingEvidenceProjection(malformed, {
        userId: "user_a",
        itemId: malformed.item_id,
        now: Date.parse("2026-07-20T00:00:00.000Z"),
      }),
    ).toThrow(/coherent|timestamp/i);

    const rebound = row();
    rebound.listings.run_id = "55555555-5555-4555-8555-555555555555";
    expect(() =>
      buildPricingEvidenceProjection(rebound, {
        userId: rebound.user_id,
        itemId: rebound.item_id,
      }),
    ).toThrow(/coherent|run/i);

    const correction = row();
    correction.run_kind = "review-correction";
    correction.pipeline_run_id = null as never;
    correction.pipeline_runs = null as never;
    expect(() =>
      buildPricingEvidenceProjection(correction, {
        userId: correction.user_id,
        itemId: correction.item_id,
      }),
    ).not.toThrow();

    const duplicated = row();
    (duplicated.price_result as typeof duplicated.price_result & { evidence: unknown[] }).evidence = [
      {
        id: "conflicting-copy",
        sourceUrl: "https://www.ebay.com/itm/sale-1",
        price: 999,
        currency: "USD",
        kind: "sold-comparable",
        priceDisclosure: "displayed-sold-price",
      },
    ];
    expect(() =>
      buildPricingEvidenceProjection(duplicated, {
        userId: duplicated.user_id,
        itemId: duplicated.item_id,
      }),
    ).toThrow(/malformed/i);
  });

  it("labels thin old evidence as limited and stale without inventing optional facts", () => {
    const thin = row();
    delete (thin.item as { condition?: string }).condition;
    thin.evidence = [thin.evidence[2]!];

    const projection = buildPricingEvidenceProjection(thin, {
      userId: thin.user_id,
      itemId: thin.item_id,
      now: Date.parse("2026-07-23T12:00:00.000Z"),
    });

    expect(projection.item).not.toHaveProperty("condition");
    expect(projection.evidenceLevel).toBe("limited");
    expect(projection.defaultWindow).toBe("90D");
    expect(projection.isStale).toBe(true);
    expect(projection.comparables[0]).not.toHaveProperty("condition");
    expect(projection.comparables[0]).not.toHaveProperty("soldAt");
    expect(projection.chartBounds).toBeNull();
  });

  it("returns honest no-evidence truth without reconstructing rows from citations", () => {
    const empty = row();
    empty.evidence = [];

    const projection = buildPricingEvidenceProjection(empty, {
      userId: empty.user_id,
      itemId: empty.item_id,
      now: Date.parse("2026-07-18T12:00:00.000Z"),
    });

    expect(projection.comparables).toEqual([]);
    expect(projection.priceResult.evidence).toEqual([]);
    expect(projection.evidenceLevel).toBe("limited");
    expect(projection.defaultWindow).toBe("90D");
    expect(projection.chartBounds).toBeNull();
  });

  it("fails closed when a persisted page contains a sixth verified sold match", () => {
    const oversized = row();
    oversized.evidence = Array.from({ length: 6 }, (_, index) => ({
      ...oversized.evidence[0]!,
      id: `sale-${index}`,
    }));

    expect(() =>
      buildPricingEvidenceProjection(oversized, {
        userId: oversized.user_id,
        itemId: oversized.item_id,
      }),
    ).toThrow(/malformed/i);
  });
});
