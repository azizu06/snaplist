import { z } from "zod";
import type { PipelineResult } from "@/lib/pipeline/types";
import {
  priceResultSchema,
  pricingEvidenceRecordSchema,
} from "@/lib/pricing/types";

export const PRICING_EVIDENCE_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const PRICING_EVIDENCE_MAX_ROWS = 5;

export const persistedPriceResultSchema = priceResultSchema.refine(
  (result) => result.evidence === undefined,
  {
    message: "Persisted price results must use the snapshot evidence array.",
    path: ["evidence"],
  },
);

export const acceptedPricingEvidenceRecordSchema = pricingEvidenceRecordSchema
  .extend({
    priceDisclosure: z.literal("displayed-sold-price"),
  })
  .strict();

export const pricingEvidenceSnapshotInputSchema = z
  .object({
    schema_version: z.literal(PRICING_EVIDENCE_SNAPSHOT_SCHEMA_VERSION),
    item: z
      .object({
        title: z.string().min(1).max(500),
        condition: z.string().min(1).max(120).optional(),
      })
      .strict(),
    price_result: persistedPriceResultSchema,
    evidence: z
      .array(acceptedPricingEvidenceRecordSchema)
      .max(PRICING_EVIDENCE_MAX_ROWS),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const sourceUrls = new Set(snapshot.price_result.sources.map((source) => source.url));
    snapshot.evidence.forEach((record, index) => {
      if (!sourceUrls.has(record.sourceUrl)) {
        context.addIssue({
          code: "custom",
          message: "Accepted pricing evidence must match a cited source URL.",
          path: ["evidence", index, "sourceUrl"],
        });
      }
    });
  });

export type PricingEvidenceSnapshotInput = z.infer<
  typeof pricingEvidenceSnapshotInputSchema
>;

/**
 * Build the identity-free payload that the lease-fenced completion RPC binds to
 * its trusted run, item, and tenant. Asking-price rows are explicit provider
 * disclosures but never accepted as sold evidence.
 */
export function buildPricingEvidenceSnapshotInput(
  result: PipelineResult,
): PricingEvidenceSnapshotInput {
  const evidence = result.price.evidence ?? [];
  const acceptedEvidence = evidence.filter(
    (record) => record.priceDisclosure === "displayed-sold-price",
  );
  const priceResult = {
    ...result.price,
    confidence: result.confidence.score,
  };
  delete priceResult.evidence;
  const title =
    result.identification?.label.trim() ||
    result.attributes.title?.trim() ||
    result.listing.title.trim();
  const condition = result.attributes.condition?.trim();

  return pricingEvidenceSnapshotInputSchema.parse({
    schema_version: PRICING_EVIDENCE_SNAPSHOT_SCHEMA_VERSION,
    item: {
      title,
      ...(condition ? { condition } : {}),
    },
    price_result: priceResult,
    evidence: acceptedEvidence,
  });
}
