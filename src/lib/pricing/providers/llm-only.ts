import { z } from "zod";
import type { ItemSignal, PriceResult, PricingProvider } from "../types";
import { resolvePricingModel } from "./web-search";
import { resolveLanguageModel } from "../../llm";

/**
 * Tier 6 — the LLM-only `PricingProvider` (`llm-only`), issue #11.
 *
 * PRD §"Pricing pipeline": the ultimate fallback — a pure LLM price estimate,
 * lowest confidence. This tier is the routing FLOOR: it fires only when every
 * evidence-bearing tier declined, and it itself NEVER declines — any signal
 * (even an empty one) gets a schema-valid estimate, so `PriceRouter.price`
 * always produces a recommendation. A failing model call THROWS (upstream
 * failure per the router contract): there is no lower tier to fall through to,
 * and a silent decline here would turn a model outage into a misleading
 * "no provider handled the item signal".
 *
 * Honesty properties:
 *  - `sources` is empty — the one tier the schema permits this for. There is
 *    no checkable evidence behind the number and the result never claims any.
 *  - Provisional confidence is the floor (`LLM_ONLY_CONFIDENCE`, 0.2). The
 *    canonical composite's `llm_only` base (0.2) caps the composite at
 *    0.6·0.2 + 0.25·1 + 0.15·1 = 0.52, below the 0.75 publish-eligibility gate BY
 *    CONSTRUCTION (asserted in tests) — an LLM guess can never be marked ready.
 *  - The estimating model is stamped on the result for provenance: this tier
 *    ALWAYS runs a model, but only a KNOWN id is claimed (the default
 *    estimator's resolved id, or an injected estimator's declared
 *    `options.model` — an undeclared injected estimator logs no claim).
 */

// ---------------------------------------------------------------------------
// Injected estimation seam (the LLM call)
// ---------------------------------------------------------------------------

/**
 * The model's estimate shape. Stricter than `priceResultSchema`'s nonnegative
 * numbers: a zero/empty estimate is useless as a floor, so all three values
 * must be positive (and finite), with the suggestion inside the band. An
 * estimate that fails this is a model failure → the provider throws.
 */
export const llmPriceEstimateSchema = z
  .object({
    /** The single suggested USD resale price. */
    suggested: z.number().positive().finite(),
    /** Bottom of the defensible band. */
    min: z.number().positive().finite(),
    /** Top of the defensible band. */
    max: z.number().positive().finite(),
  })
  .refine((e) => e.min <= e.suggested && e.suggested <= e.max, {
    message: "estimate must satisfy min <= suggested <= max",
  });

export type LlmPriceEstimate = z.infer<typeof llmPriceEstimateSchema>;

/**
 * The injectable model call: estimate a resale price from whatever attributes
 * the signal carries (possibly none). Tests pass a fake; the real default
 * drives `generateObject`. Throwing is an upstream failure, never a decline.
 */
export type EstimatePrice = (args: {
  signal: ItemSignal;
}) => Promise<LlmPriceEstimate>;

const ESTIMATE_SYSTEM_PROMPT =
  "You estimate a fair USD resale price for a second-hand item sold by a " +
  "private seller. You receive whatever identifying attributes are known — " +
  "possibly very few. Always answer: give a conservative single suggested " +
  "price plus a min..max band wide enough to be defensible. When the item is " +
  "barely identified, widen the band rather than refusing. All values are " +
  "positive USD amounts with min <= suggested <= max.";

/**
 * Build the real estimator: a lazy wrapper around the AI SDK's
 * `generateObject` (lazy imports keep the SDK off the offline test path, same
 * as the web tiers' extractors).
 */
export function createOpenAIPriceEstimator(
  apiKey: string | undefined = undefined,
  model?: string,
): EstimatePrice {
  return async ({ signal }) => {
    const { generateObject } = await import("ai");
    const llmModel = await resolveLanguageModel("pricingAgent", {
      modelId: model,
      apiKey,
    });

    const attributes = JSON.stringify(
      {
        brand: signal.brand,
        model: signal.model,
        category: signal.category,
        condition: signal.condition,
        resolvedName: signal.resolvedName,
        upc: signal.upc,
        isbn: signal.isbn,
      },
      null,
      2,
    );

    const { object } = await generateObject({
      model: llmModel,
      schema: llmPriceEstimateSchema,
      system: ESTIMATE_SYSTEM_PROMPT,
      prompt: `Known item attributes:\n${attributes}`,
    });
    return object;
  };
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

/**
 * Provisional confidence — the floor. Matches the composite's `llm_only` tier
 * base, so both vocabularies agree this is the least-trusted price source.
 */
export const LLM_ONLY_CONFIDENCE = 0.2;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface LlmOnlyPricingProviderOptions {
  /** Injected estimator (the model call); defaults to the real `generateObject` wrapper. */
  estimatePrice?: EstimatePrice;
  /** Model id override forwarded to the default estimator (else `PRICING_MODEL` env). */
  model?: string;
}

/**
 * Create the tier-5 LLM-only `PricingProvider`. Inject `estimatePrice` in
 * tests to run offline; production defaults to the real estimator over
 * `PRICING_MODEL` / `OPENAI_API_KEY` (read lazily at call time).
 */
export function createLlmOnlyPricingProvider(
  options: LlmOnlyPricingProviderOptions = {},
): PricingProvider {
  const estimatePrice =
    options.estimatePrice ?? createOpenAIPriceEstimator(undefined, options.model);
  const customEstimator = options.estimatePrice != null;

  return {
    tier: "llm-only",

    // Deliberately NO canHandle: this tier is the routing floor and must never
    // pre-decline — any signal gets an estimate.

    async price(signal: ItemSignal): Promise<PriceResult> {
      const raw = await estimatePrice({ signal });
      // Re-validate even the injected estimator's output: an unusable estimate
      // is an UPSTREAM FAILURE (throw, per the router contract) — never a
      // decline, and never silently repaired into a number nobody produced.
      const parsed = llmPriceEstimateSchema.safeParse(raw);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => i.message).join("; ");
        throw new Error(`LLM-only price estimate failed validation: ${issues}`);
      }
      const estimate = parsed.data;

      // Provenance honesty (same rule as the web tiers): only a KNOWN model id
      // is claimed — the default estimator's resolved id, or an injected
      // estimator's explicitly declared options.model.
      const model = customEstimator
        ? options.model?.trim() || undefined
        : resolvePricingModel(options.model);

      return {
        // round2 is monotonic, so rounding preserves min <= suggested <= max.
        suggested: round2(estimate.suggested),
        range: { min: round2(estimate.min), max: round2(estimate.max) },
        confidence: LLM_ONLY_CONFIDENCE,
        sources: [],
        tier: "llm-only",
        ...(model ? { model } : {}),
      };
    },
  };
}
