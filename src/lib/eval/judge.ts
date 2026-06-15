import { z } from "zod";
import {
  oppositeProvider,
  resolveApiKey,
  resolveLanguageModel,
  resolveModelId,
  resolveProvider,
  type LlmProvider,
} from "../llm";
import type { ExtractedAttributes } from "../pipeline/types";
import { normalizeField } from "./metrics";
import { judgedListingSchema, type JudgedListing } from "./types";

/**
 * Listing-quality LLM judge (issue #16), mirroring the grounded-LLM pattern in
 * `listing/generate.ts`:
 *
 *  - the MODEL call is INJECTED (`JudgeFn`); the real wrapper is a lazy
 *    `generateObject` over the Zod rubric schema, so tests and the default
 *    offline script path never load the SDK or need a key;
 *  - the judge is itself VALIDATED against a small human-labeled subset shipped
 *    as a fixture (`fixtures/judge-human-labels.json`) — `judgeAgreement`
 *    computes the agreement metrics that the eval report carries, so a drifting
 *    judge is visible, not trusted.
 *
 * The default offline judge is an honest deterministic HEURISTIC (length /
 * identity-mention / grounding checks) — a stand-in that keeps `pnpm eval`
 * fully offline; `--real-judge` swaps in the LLM via the same seam.
 */

/** One rubric dimension score: an integer 1 (poor) … 5 (excellent). */
const dimension = z.number().int().min(1).max(5);

/**
 * The judge rubric. Scored dimensions:
 *  - `title`       — keyword-dense, identity-bearing, within platform norms.
 *  - `description` — clear, complete, states condition honestly.
 *  - `grounded`    — uses ONLY the validated attribute facts (no invented
 *                    brand/model/spec) — the no-hallucination axis.
 *  - `overall`     — holistic listing quality.
 */
export const judgeScoresSchema = z.object({
  title: dimension,
  description: dimension,
  grounded: dimension,
  overall: dimension,
});

export type JudgeScores = z.infer<typeof judgeScoresSchema>;

export const JUDGE_DIMENSIONS = ["title", "description", "grounded", "overall"] as const;

export type JudgeDimension = (typeof JUDGE_DIMENSIONS)[number];

/**
 * The injectable judge seam: listing + the attribute core it was generated
 * from → rubric scores. Tests pass a fake; the script picks heuristic or LLM.
 */
export type JudgeFn = (args: {
  listing: JudgedListing;
  attributes: ExtractedAttributes;
}) => Promise<JudgeScores>;

/** Judge model default; overridable via `EVAL_JUDGE_MODEL` (env-configurable everything). */
export const DEFAULT_JUDGE_MODEL = "gpt-5.5";

// ---------------------------------------------------------------------------
// Offline heuristic judge (the default — keeps `pnpm eval` fully offline)
// ---------------------------------------------------------------------------

function clampScore(n: number): number {
  return Math.max(1, Math.min(5, Math.round(n)));
}

function mentions(haystack: string, needle: string | undefined): boolean {
  if (!needle) return false;
  return normalizeField(haystack).includes(normalizeField(needle));
}

/**
 * Deterministic rubric heuristic. Not an LLM — a transparent, testable stand-in
 * scoring the same dimensions:
 *  - title: identity mention (brand/model) + sane keyword-dense length (≤ 80).
 *  - description: enough substance to sell + honest condition mention.
 *  - grounded: structured specifics must not contradict the attribute core.
 *  - overall: rounded mean of the three.
 */
export function createHeuristicJudge(): JudgeFn {
  return async ({ listing, attributes }) => {
    // Title: start neutral; reward identity + platform-normal length.
    let title = 3;
    const identityKnown = Boolean(attributes.brand || attributes.model);
    const titleHasIdentity =
      mentions(listing.title, attributes.brand) ||
      mentions(listing.title, attributes.model);
    if (identityKnown && titleHasIdentity) title += 1;
    if (identityKnown && !titleHasIdentity) title -= 1;
    if (listing.title.length >= 30 && listing.title.length <= 80) title += 1;
    if (listing.title.length < 15 || listing.title.length > 80) title -= 1;

    // Description: substance by length, plus honest condition disclosure.
    const len = listing.description.length;
    let description = len < 40 ? 2 : len < 120 ? 3 : 4;
    if (mentions(listing.description, attributes.condition)) description += 1;

    // Grounded: structured specifics contradicting the core = invented facts.
    let grounded = 5;
    const specifics = listing.itemSpecifics ?? {};
    for (const [key, attr] of [
      ["Brand", attributes.brand],
      ["Model", attributes.model],
    ] as const) {
      const emitted = specifics[key];
      if (emitted === undefined || emitted.trim() === "") continue;
      if (!attr || normalizeField(attr) !== normalizeField(emitted)) {
        grounded = 2;
      }
    }

    const t = clampScore(title);
    const d = clampScore(description);
    const g = clampScore(grounded);
    return {
      title: t,
      description: d,
      grounded: g,
      overall: clampScore((t + d + g) / 3),
    };
  };
}

// ---------------------------------------------------------------------------
// Real LLM judge — lazy, env-gated; same shape as createOpenAIListingGenerate.
// ---------------------------------------------------------------------------

const JUDGE_SYSTEM_PROMPT =
  "You are a strict quality judge for used-item eBay listings. Score the listing " +
  "on a 1-5 integer rubric: `title` (keyword-dense, carries the item identity, " +
  "within 80 characters), `description` (clear, complete, states condition " +
  "honestly), `grounded` (uses ONLY the supplied attribute facts; any invented " +
  "brand, model, or spec caps this at 2), and `overall` (holistic quality). " +
  "Judge only against the supplied attributes; do not reward confident-sounding " +
  "fabrication.";

type EnvLike = Record<string, string | undefined>;

/**
 * The provider the cross-family judge should use: the OPPOSITE family from the
 * active generation provider (#61). If the listings were generated on OpenAI
 * (showcase), the judge runs on Gemini, and vice versa — so the listing-quality
 * metric isn't a model grading its own family's output.
 */
export function judgeProviderFor(env: EnvLike = process.env): LlmProvider {
  return oppositeProvider(resolveProvider(env));
}

/**
 * Can the cross-family LLM judge actually run? Only if the OPPOSITE provider's
 * API key is present. A dev box with a single provider key (the common case)
 * can't run a cross-family judge — callers fall back to the heuristic and say so,
 * keeping the eval offline-safe and honest rather than silently self-grading.
 */
export function crossFamilyJudgeAvailable(env: EnvLike = process.env): boolean {
  return Boolean(resolveApiKey(judgeProviderFor(env), env));
}

export interface CrossFamilyJudgeOptions {
  /** The GENERATION provider to judge against the opposite of (default: active). */
  genProvider?: LlmProvider;
  /** Explicit judge model id (else the opposite provider's `judge` default). */
  modelId?: string;
  /** Explicit API key (else resolved for the opposite provider from env). */
  apiKey?: string;
  env?: EnvLike;
}

/**
 * The real, CROSS-FAMILY LLM judge (#61): a lazy `generateObject` over the rubric
 * schema, run on the OPPOSITE provider family from the generator to remove
 * same-family self-bias. The model is resolved through the registry (issue #55)
 * with an explicit `provider` so it does NOT follow the active `LLM_PROVIDER`; the
 * SDK is lazy-imported so the offline test/script path never loads it.
 */
export function createCrossFamilyJudge(opts: CrossFamilyJudgeOptions = {}): JudgeFn {
  const env = opts.env ?? process.env;
  const provider = oppositeProvider(opts.genProvider ?? resolveProvider(env));
  const judgeModel = resolveModelId("judge", { provider, modelId: opts.modelId, env });
  return async ({ listing, attributes }) => {
    const { generateObject } = await import("ai");
    const llmModel = await resolveLanguageModel("judge", {
      provider,
      modelId: judgeModel,
      apiKey: opts.apiKey,
    });
    const { object } = await generateObject({
      model: llmModel,
      schema: judgeScoresSchema,
      system: JUDGE_SYSTEM_PROMPT,
      prompt:
        `Validated attributes (the ONLY allowed facts):\n` +
        `${JSON.stringify(attributes, null, 2)}\n\n` +
        `Listing to judge:\n${JSON.stringify(listing, null, 2)}`,
    });
    return judgeScoresSchema.parse(object);
  };
}

// ---------------------------------------------------------------------------
// Judge validation against the human-labeled subset
// ---------------------------------------------------------------------------

/** One human-labeled example: a listing + its attribute core + human rubric scores. */
export const humanLabeledListingSchema = z.object({
  id: z.string().min(1),
  attributes: z.record(z.string(), z.unknown()),
  listing: judgedListingSchema,
  human: judgeScoresSchema,
});

export type HumanLabeledListing = z.infer<typeof humanLabeledListingSchema>;

export const humanLabeledSubsetSchema = z.array(humanLabeledListingSchema);

export interface DimensionAgreement {
  /** Mean |judge − human| over the subset. */
  meanAbsDiff: number;
  /** Fraction of examples where |judge − human| ≤ 1 (the standard ±1 tolerance). */
  within1Rate: number;
  /** Fraction of exact matches. */
  exactRate: number;
}

export interface JudgeAgreement {
  examples: number;
  perDimension: Record<JudgeDimension, DimensionAgreement>;
  /** The headline agreement metric: within-±1 rate on the `overall` dimension. */
  overallWithin1Rate: number;
}

/**
 * PURE agreement math between judge scores and human labels (index-aligned).
 * Reported per dimension: mean absolute difference, within-±1 rate, exact rate.
 */
export function judgeAgreement(
  judgeScores: readonly JudgeScores[],
  humanScores: readonly JudgeScores[],
): JudgeAgreement {
  if (judgeScores.length !== humanScores.length) {
    throw new Error(
      `judgeAgreement requires aligned score lists (judge=${judgeScores.length}, human=${humanScores.length})`,
    );
  }
  if (judgeScores.length === 0) {
    throw new Error("judgeAgreement requires at least one labeled example");
  }
  const perDimension = {} as Record<JudgeDimension, DimensionAgreement>;
  for (const dim of JUDGE_DIMENSIONS) {
    let absDiffSum = 0;
    let within1 = 0;
    let exact = 0;
    for (let i = 0; i < judgeScores.length; i++) {
      const diff = Math.abs(judgeScores[i][dim] - humanScores[i][dim]);
      absDiffSum += diff;
      if (diff <= 1) within1 += 1;
      if (diff === 0) exact += 1;
    }
    perDimension[dim] = {
      meanAbsDiff: absDiffSum / judgeScores.length,
      within1Rate: within1 / judgeScores.length,
      exactRate: exact / judgeScores.length,
    };
  }
  return {
    examples: judgeScores.length,
    perDimension,
    overallWithin1Rate: perDimension.overall.within1Rate,
  };
}

/**
 * Run the (injected) judge over the human-labeled subset and compute agreement.
 * This is the validation step the report carries: the judge's verdicts are only
 * as trustworthy as its measured agreement with humans.
 */
export async function validateJudge(
  judge: JudgeFn,
  subset: readonly HumanLabeledListing[],
): Promise<JudgeAgreement> {
  const judgeScores: JudgeScores[] = [];
  for (const example of subset) {
    judgeScores.push(
      await judge({
        listing: example.listing,
        attributes: example.attributes as ExtractedAttributes,
      }),
    );
  }
  return judgeAgreement(
    judgeScores,
    subset.map((e) => e.human),
  );
}
