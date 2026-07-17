import { z } from "zod";

const rate = z.number().min(0).max(1);
const positiveMoney = z.number().positive();

export const evidenceSourceSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  url: z.string().url(),
  observedAt: z.string().date(),
  kind: z.enum(["measured", "official", "architecture", "assumption"]),
  note: z.string().min(1),
});

export const tokenStageSchema = z.object({
  model: z.enum(["openai-gpt-5.5", "gemini-2.5-flash"]),
  calls: z.number().min(0),
  inputTokensPerCall: z.number().min(0),
  cachedInputRate: rate,
  outputTokensPerCall: z.number().min(0),
});

export const scenarioSchema = z.object({
  id: z.enum(["median", "p90", "stress"]),
  description: z.string().min(1),
  stages: z.object({
    vision: tokenStageSchema,
    garmentMeasurement: tokenStageSchema,
    pricingAgent: tokenStageSchema,
    listing: tokenStageSchema,
  }),
  garmentShare: rate,
  embeddingTokens: z.number().min(0),
  webSearchRequests: z.number().min(0),
  soldComp: z.object({
    attemptRate: rate,
    cacheHitRate: rate,
    historicalCostPerQueryUsd: positiveMoney,
  }),
  infrastructurePerAttemptUsd: z.number().min(0),
  failedRunRate: rate.max(0.95),
  failedAttemptCostShare: rate,
  correctionRate: rate,
  freeActivationsPerPaidSubscriber: z.number().min(0),
  appleCommissionRate: rate,
  refundRate: rate,
  indirectTaxWithheldRate: rate,
  revenueCatMarginalRate: rate,
  fixedCosts: z.array(
    z.object({
      service: z.string().min(1),
      monthlyUsd: z.number().min(0),
      sourceId: z.string().min(1),
      note: z.string().min(1),
    }),
  ).min(1),
});

export const candidateSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    monthlyPriceUsd: positiveMoney,
    annualPriceUsd: positiveMoney,
    monthlyAllowance: z.number().int().positive().max(100),
    annualReset: z.literal("monthly"),
    rollover: z.literal(false),
    unlimited: z.literal(false),
  })
  .refine(
    (candidate) =>
      candidate.annualPriceUsd < candidate.monthlyPriceUsd * 12,
    {
      message: "Annual cadence must be discounted versus twelve monthly periods",
      path: ["annualPriceUsd"],
    },
  )
  .transform((candidate) => ({
    ...candidate,
    annualDiscountRate:
      1 - candidate.annualPriceUsd / (candidate.monthlyPriceUsd * 12),
  }));

export const unitEconomicsModelSchema = z.object({
  schemaVersion: z.literal(1),
  modelId: z.string().min(1),
  asOf: z.string().date(),
  currency: z.literal("USD"),
  status: z.literal("provisional-testflight-required"),
  boundaries: z.object({
    firstSuccessfulListingFree: z.literal(true),
    firstConfirmedEbayPublishFree: z.literal(true),
    includedGuidedCorrection: z.literal(1),
    annualAllowanceReset: z.literal("monthly"),
    rollover: z.literal(false),
    unlimited: z.literal(false),
    productionCommitment: z.literal(false),
  }),
  providerRates: z.object({
    openaiGpt55: z.object({
      inputPerMillionUsd: positiveMoney,
      cachedInputPerMillionUsd: positiveMoney,
      outputPerMillionUsd: positiveMoney,
    }),
    gemini25Flash: z.object({
      inputPerMillionUsd: positiveMoney,
      outputPerMillionUsd: positiveMoney,
    }),
    openaiEmbedding3Small: z.object({ inputPerMillionUsd: positiveMoney }),
    tavilyPerCreditUsd: positiveMoney,
  }),
  usageCases: z.array(
    z.object({
      id: z.enum(["low", "expected", "high"]),
      allowanceUtilizationRate: rate,
    }),
  ).length(3),
  scenarios: z.array(scenarioSchema).length(3),
  candidates: z.array(candidateSchema).min(3),
  planBreakpoints: z.object({
    scrapingBeeMonthlyUsd: positiveMoney,
    scrapingBeeIncludedCredits: z.number().positive(),
    revenueCatFreeMtrUsd: positiveMoney,
    posthogFreeEvents: z.number().positive(),
    assumedPosthogEventsPerListing: z.number().positive(),
    supabaseProMonthlyUsd: positiveMoney,
  }),
  costInventory: z.array(
    z.object({
      service: z.string().min(1),
      classification: z.enum([
        "fixed",
        "step-variable",
        "per-attempt",
        "per-successful-listing",
        "free-activation",
        "included-correction",
        "failure-retry-restoration",
        "cache-sensitive",
        "commission-refund-tax",
      ]),
      treatment: z.enum(["included", "breakpoint-only", "excluded"]),
      sourceIds: z.array(z.string().min(1)).min(1),
      note: z.string().min(1),
    }),
  ).min(12),
  recommendation: z.object({
    candidateId: z.string().min(1),
    confidence: z.enum(["low", "medium-low", "medium", "high"]),
    gateRequired: z.literal(true),
  }),
  testflightGate: z.object({
    minimumSuccessfulListings: z.number().int().positive(),
    minimumDistinctTesters: z.number().int().positive(),
    minimumObservationDays: z.number().int().positive(),
    minimumCorrections: z.number().int().positive(),
    maximumP90CostDriftRate: rate,
    minimumExpectedContributionMarginRate: rate,
    minimumP90HighUseContributionMarginRate: rate,
    stressMustRemainNonNegative: z.literal(true),
  }),
  sources: z.array(evidenceSourceSchema).min(10),
  excludedCosts: z.array(
    z.object({
      service: z.string().min(1),
      reason: z.string().min(1),
    }),
  ),
}).superRefine((model, context) => {
  const unique = (values: readonly string[]) => new Set(values).size === values.length;
  if (!unique(model.sources.map((source) => source.id))) {
    context.addIssue({
      code: "custom",
      message: "Evidence source ids must be unique",
      path: ["sources"],
    });
  }
  if (!unique(model.candidates.map((candidate) => candidate.id))) {
    context.addIssue({
      code: "custom",
      message: "Candidate ids must be unique",
      path: ["candidates"],
    });
  }
  if (
    !model.candidates.some(
      (candidate) => candidate.id === model.recommendation.candidateId,
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "Recommendation must reference an existing candidate",
      path: ["recommendation", "candidateId"],
    });
  }

  const sourceIds = new Set(model.sources.map((source) => source.id));
  model.costInventory.forEach((entry, index) => {
    for (const sourceId of entry.sourceIds) {
      if (!sourceIds.has(sourceId)) {
        context.addIssue({
          code: "custom",
          message: `Unknown evidence source id: ${sourceId}`,
          path: ["costInventory", index, "sourceIds"],
        });
      }
    }
  });
  model.scenarios.forEach((scenario, scenarioIndex) => {
    scenario.fixedCosts.forEach((entry, fixedCostIndex) => {
      if (!sourceIds.has(entry.sourceId)) {
        context.addIssue({
          code: "custom",
          message: `Unknown evidence source id: ${entry.sourceId}`,
          path: [
            "scenarios",
            scenarioIndex,
            "fixedCosts",
            fixedCostIndex,
            "sourceId",
          ],
        });
      }
    });
  });
});

export type UnitEconomicsModel = z.input<typeof unitEconomicsModelSchema>;
export type ParsedUnitEconomicsModel = z.output<typeof unitEconomicsModelSchema>;
