import { z } from "zod";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { estimateFees } from "@/lib/pricing/fees";
import {
  priceResultSchema,
} from "@/lib/pricing/types";
import {
  acceptedPricingEvidenceRecordSchema,
  persistedPriceResultSchema,
} from "./snapshot";

const uuid = z.string().uuid();
const isoDateTime = z.string().datetime({ offset: true });
const evidenceAsOfSchema = acceptedPricingEvidenceRecordSchema.extend({
  evidenceAsOf: isoDateTime,
});

export const PRICING_EVIDENCE_STALE_AFTER_DAYS = 3;
export const PRICING_EVIDENCE_STRONG_MINIMUM = 4;

export const pricingEvidenceSnapshotRowSchema = z
  .object({
    run_id: uuid,
    pipeline_run_id: uuid.nullable(),
    run_kind: z.enum(["pipeline", "review-correction"]),
    user_id: z.string().min(1),
    item_id: uuid,
    prediction_id: uuid,
    listing_id: uuid,
    schema_version: z.literal(1),
    item: z
      .object({
        title: z.string().min(1).max(500),
        condition: z.string().min(1).max(120).optional(),
      })
      .strict(),
    price_result: persistedPriceResultSchema,
    evidence: z.array(evidenceAsOfSchema).max(60),
    evidence_as_of: isoDateTime,
    pipeline_runs: z
      .object({
        id: uuid,
        status: z.literal("succeeded"),
        stage: z.literal("completed"),
        listing_id: uuid,
        completed_at: isoDateTime,
      })
      .strict()
      .nullable(),
    listings: z
      .object({
        id: uuid,
        run_id: uuid,
        item_id: uuid,
        user_id: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export const pricingEvidenceProjectionSchema = z
  .object({
    item: z
      .object({
        id: uuid,
        title: z.string().min(1).max(500),
        condition: z.string().min(1).max(120).optional(),
      })
      .strict(),
    priceResult: priceResultSchema,
    evidenceLevel: z.enum(["strong", "limited"]),
    evidenceAsOf: isoDateTime,
    evidenceAgeDays: z.number().nonnegative(),
    isStale: z.boolean(),
    defaultWindow: z.enum(["60D", "90D"]),
    comparables: z.array(evidenceAsOfSchema).max(60),
    estimatedFees: z.number().nonnegative(),
    estimatedPayout: z.number().nonnegative(),
    chartBounds: z
      .object({ min: z.number().nonnegative(), max: z.number().positive() })
      .strict()
      .nullable(),
  })
  .strict();

export type PricingEvidenceProjection = z.infer<
  typeof pricingEvidenceProjectionSchema
>;

export class PricingEvidenceSnapshotError extends Error {}

export interface PricingEvidenceReader {
  forItem(input: {
    userId: string;
    bearerToken: string;
    itemId: string;
    now?: number;
  }): Promise<PricingEvidenceProjection | null>;
}

function cents(value: number): number {
  return Math.round(value * 100) / 100;
}

export function buildPricingEvidenceProjection(
  rawRow: unknown,
  input: { userId: string; itemId: string; now?: number },
): PricingEvidenceProjection {
  const parsed = pricingEvidenceSnapshotRowSchema.safeParse(rawRow);
  if (!parsed.success) {
    throw new PricingEvidenceSnapshotError("Pricing evidence snapshot is malformed.");
  }
  const row = parsed.data;
  const evidenceAsOfMs = Date.parse(row.evidence_as_of);
  const completedAtMs = row.pipeline_runs
    ? Date.parse(row.pipeline_runs.completed_at)
    : evidenceAsOfMs;
  const pipelineCoherent =
    row.run_kind === "pipeline" &&
    row.pipeline_run_id === row.run_id &&
    row.pipeline_runs?.id === row.run_id &&
    row.pipeline_runs.listing_id === row.listing_id;
  const correctionCoherent =
    row.run_kind === "review-correction" &&
    row.pipeline_run_id == null &&
    row.pipeline_runs == null;
  if (
    row.user_id !== input.userId ||
    row.item_id !== input.itemId ||
    (!pipelineCoherent && !correctionCoherent) ||
    row.listing_id !== row.listings.id ||
    row.run_id !== row.listings.run_id ||
    row.item_id !== row.listings.item_id ||
    row.user_id !== row.listings.user_id ||
    evidenceAsOfMs !== completedAtMs
  ) {
    throw new PricingEvidenceSnapshotError(
      "Pricing evidence snapshot crossed a coherent tenant or run boundary.",
    );
  }

  const sourceUrls = new Set(row.price_result.sources.map((source) => source.url));
  const comparables = row.evidence.filter(
    (record) => record.priceDisclosure === "displayed-sold-price",
  );
  if (
    comparables.some(
      (record) =>
        Date.parse(record.evidenceAsOf) !== evidenceAsOfMs ||
        !sourceUrls.has(record.sourceUrl),
    )
  ) {
    throw new PricingEvidenceSnapshotError(
      "Pricing evidence row timestamp or citation is incoherent.",
    );
  }

  const now = input.now ?? Date.now();
  if (!Number.isFinite(now) || now < evidenceAsOfMs) {
    throw new PricingEvidenceSnapshotError("Pricing evidence age is incoherent.");
  }
  const evidenceAgeDays = Math.round(
    ((now - evidenceAsOfMs) / 86_400_000) * 100,
  ) / 100;
  const estimatedFees = estimateFees(row.price_result.suggested, "ebay");
  if (estimatedFees == null) {
    throw new PricingEvidenceSnapshotError("Pricing evidence has no usable price.");
  }
  const prices = comparables.map((record) => record.price);
  const minimum = prices.length > 0 ? Math.min(...prices) : null;
  const maximum = prices.length > 0 ? Math.max(...prices) : null;
  const strong = comparables.length >= PRICING_EVIDENCE_STRONG_MINIMUM;
  const acceptedPriceResult = priceResultSchema.parse({
    ...row.price_result,
    evidence: comparables.map((record) => {
      const persisted = { ...record };
      delete (persisted as Partial<typeof persisted>).evidenceAsOf;
      return persisted;
    }),
  });

  return pricingEvidenceProjectionSchema.parse({
    item: { id: row.item_id, ...row.item },
    priceResult: acceptedPriceResult,
    evidenceLevel: strong ? "strong" : "limited",
    evidenceAsOf: row.evidence_as_of,
    evidenceAgeDays,
    isStale: evidenceAgeDays > PRICING_EVIDENCE_STALE_AFTER_DAYS,
    defaultWindow: strong ? "60D" : "90D",
    comparables,
    estimatedFees,
    estimatedPayout: cents(row.price_result.suggested - estimatedFees),
    chartBounds:
      minimum != null && maximum != null && minimum < maximum
        ? { min: minimum, max: maximum }
        : null,
  });
}

export function createSupabasePricingEvidenceReader(
  clientForBearer: (
    bearerToken: string,
  ) => SupabaseClient | Promise<SupabaseClient>,
): PricingEvidenceReader {
  return {
    async forItem({ userId, bearerToken, itemId, now }) {
      const client = await clientForBearer(bearerToken);
      const { data, error } = await client
        .from("pricing_evidence_snapshots")
        .select(
          "run_id,pipeline_run_id,run_kind,user_id,item_id,prediction_id,listing_id,schema_version,item,price_result,evidence,evidence_as_of,pipeline_runs(id,status,stage,listing_id,completed_at),listings!inner(id,run_id,item_id,user_id)",
        )
        .eq("item_id", itemId)
        .eq("user_id", userId)
        .order("evidence_as_of", { ascending: false })
        .order("run_id", { ascending: false })
        .limit(1);
      if (error) {
        throw new PricingEvidenceSnapshotError("Pricing evidence read failed.");
      }
      const row = data?.[0];
      return row
        ? buildPricingEvidenceProjection(row, { userId, itemId, now })
        : null;
    },
  };
}

export function createConfiguredSupabasePricingEvidenceReader(input: {
  supabaseURL: string;
  anonKey: string;
}): PricingEvidenceReader {
  return createSupabasePricingEvidenceReader((bearerToken) =>
    createClient(input.supabaseURL, input.anonKey, {
      accessToken: async () => bearerToken,
      auth: { persistSession: false, autoRefreshToken: false },
    }),
  );
}
