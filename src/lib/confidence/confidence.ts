import { z } from "zod";

/**
 * Composite confidence — the signature feature behind confidence-gated autopilot
 * (see PRD "Confidence" and CONTEXT.md "Confidence (composite)").
 *
 * This is a SIGNAL-BASED composite, NEVER raw LLM self-report. It blends three
 * deterministic signals into a single 0–1 score, a band, and the autopilot gate
 * decision. The function is pure: no I/O, no Date.now(), no Math.random() — so it
 * is unit-testable directly with crafted signal sets (the most important
 * pure-logic test target per the PRD) and reproducible in the eval harness.
 *
 * Signals (PRD):
 *  1. which pricing **tier** fired (ISBN > tight web comps > wide web comps >
 *     depreciation > LLM-only),
 *  2. **comp agreement** — how tightly the found comps cluster,
 *  3. **identification completeness** — was the item resolved unambiguously?
 */

/**
 * The pricing tier that produced the recommendation, ordered by trust. Mirrors
 * the PricingProvider routing pipeline; "which tier fired" is a logged,
 * confidence-bearing fact (CONTEXT.md "Tier").
 *
 * - `isbn`         — true structured ISBN lookup (Open Library / Google Books). Highest.
 * - `web_tight`    — web-search agent found a tight, agreeing comp cluster.
 * - `web_wide`     — web-search agent found comps, but scattered / asking-only.
 * - `depreciation` — retail × condition-based depreciation factor. Low-confidence estimate.
 * - `llm_only`     — ultimate LLM-only fallback. Lowest.
 *
 * Note `web_tight`/`web_wide` are a hint the router supplies about its own comp
 * cluster; `compAgreement` below carries the continuous version of the same idea.
 * Keeping both lets the tier set a floor while agreement fine-tunes within it.
 */
export const PRICING_TIERS = [
  "isbn",
  "web_tight",
  "web_wide",
  "depreciation",
  "llm_only",
] as const;

export type PricingTier = (typeof PRICING_TIERS)[number];

/**
 * Per-tier base trust in [0,1]. These are the dominant term in the composite:
 * an ISBN lookup is structurally reliable, an LLM-only guess is not, regardless
 * of how the other signals land. Spacing is intentionally non-uniform — the gap
 * from a real lookup/comp (isbn, web_tight) down to an estimate (depreciation,
 * llm_only) is the meaningful cliff, so estimates can never reach the high band.
 */
const TIER_BASE: Record<PricingTier, number> = {
  isbn: 0.95,
  web_tight: 0.8,
  web_wide: 0.6,
  depreciation: 0.4,
  llm_only: 0.2,
};

/**
 * Identification completeness. Each fact is a boolean the vision/extraction step
 * resolves: brand + model resolved, barcode decoded cleanly, category
 * unambiguous (PRD). Booleans (not a pre-baked 0–1 score) keep the input shape
 * honest about what the pipeline actually knows and let the weighting live here.
 */
export const identificationSchema = z.object({
  brandResolved: z.boolean(),
  modelResolved: z.boolean(),
  barcodeDecoded: z.boolean(),
  categoryUnambiguous: z.boolean(),
});

export type IdentificationSignals = z.infer<typeof identificationSchema>;

/**
 * The full input the pipeline populates. `compAgreement` is a normalized 0–1
 * **agreement score** (1 = comps in lockstep, 0 = wildly scattered), NOT a raw
 * coefficient of variation — a bounded, direction-stable score composes cleanly
 * and means the same thing across tiers. The caller is responsible for the
 * raw-dispersion → agreement mapping (e.g. `agreement = 1 - clamp(cv)`), since
 * that depends on the comp set; this function stays pure over the normalized form.
 * For tiers with no comp set (isbn / depreciation / llm_only) pass a sensible
 * constant — comp agreement is weighted lightly, so it does not distort them.
 */
export const confidenceSignalsSchema = z.object({
  tier: z.enum(PRICING_TIERS),
  compAgreement: z.number().min(0).max(1),
  identification: identificationSchema,
});

export type ConfidenceSignals = z.infer<typeof confidenceSignalsSchema>;

/** Confidence band. Drives the UI treatment and the human-readable "why". */
export type ConfidenceBand = "high" | "medium" | "low";

export interface ConfidenceResult {
  /** Composite confidence in [0,1]. */
  score: number;
  /** Bucketed band derived from `score`. */
  band: ConfidenceBand;
  /** Autopilot gate: enabled AND score >= threshold. */
  autopilotEligible: boolean;
}

export interface ConfidenceOptions {
  /**
   * Master autopilot switch (User Story 24: "turn autopilot off entirely").
   * When false, `autopilotEligible` is always false regardless of score.
   * Defaults to true.
   */
  autopilotEnabled?: boolean;
  /**
   * Minimum score to be autopilot-eligible. Default 0.75 — it sits at the
   * bottom of the `high` band, so the gate means "high confidence" by default
   * while staying independently tunable. Comparison is `>=` (eligible exactly
   * at the boundary).
   */
  threshold?: number;
}

/**
 * Band cutoffs. `high` begins at the default autopilot threshold so the two
 * concepts line up by default; `medium` is the "review recommended but credible"
 * middle; below `MEDIUM_MIN` is honestly low-confidence (generic / LLM-only).
 */
const HIGH_MIN = 0.75;
const MEDIUM_MIN = 0.5;

/**
 * Default autopilot threshold; see ConfidenceOptions.threshold. Exported so
 * UI surfaces can explain a persisted disposition from the logged confidence
 * (the run-time gate) instead of re-checking the live autopilot setting.
 */
export const DEFAULT_AUTOPILOT_THRESHOLD = HIGH_MIN;

/**
 * Composite weights. Tier dominates (it encodes the structural reliability of
 * the price source), identification is the second-largest term (a confidently
 * identified item is priceable), and comp agreement is a lighter corroborating
 * nudge (and is meaningless for non-comp tiers). Weights sum to 1 so the score
 * stays in [0,1].
 */
const WEIGHT_TIER = 0.6;
const WEIGHT_IDENTIFICATION = 0.25;
const WEIGHT_COMP_AGREEMENT = 0.15;

/**
 * Fraction of the four identification fields that are resolved, in [0,1].
 * Counts booleans directly (no array allocation) to honor the alloc-light
 * intent of `computeConfidence`.
 */
function identificationScore(id: IdentificationSignals): number {
  let resolved = 0;
  if (id.brandResolved) resolved += 1;
  if (id.modelResolved) resolved += 1;
  if (id.barcodeDecoded) resolved += 1;
  if (id.categoryUnambiguous) resolved += 1;
  return resolved / 4;
}

function bandFor(score: number): ConfidenceBand {
  if (score >= HIGH_MIN) return "high";
  if (score >= MEDIUM_MIN) return "medium";
  return "low";
}

/**
 * Validate an untrusted signal object against the schema, throwing a readable
 * error on mismatch. Mirrors `parseEnv` in env.ts: pure, takes its input
 * explicitly, never reads globals. Use this at the pipeline boundary;
 * `computeConfidence` itself assumes already-typed input and stays allocation-light.
 */
export function parseSignals(raw: unknown): ConfidenceSignals {
  const parsed = confidenceSignalsSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid confidence signals:\n${issues}`);
  }
  return parsed.data;
}

/**
 * Compute the composite confidence and the autopilot decision from signals.
 *
 * Pure and synchronous. `score` is a weighted blend of {tier base, comp
 * agreement, identification completeness}; `band` buckets it; `autopilotEligible`
 * is the gate (`autopilotEnabled && score >= threshold`).
 */
export function computeConfidence(
  signals: ConfidenceSignals,
  options: ConfidenceOptions = {},
): ConfidenceResult {
  const { autopilotEnabled = true, threshold = DEFAULT_AUTOPILOT_THRESHOLD } = options;

  // The threshold gates auto-posting, so a malformed value is a safety bug, not a
  // stylistic one: a negative threshold would make every result (even llm_only)
  // eligible, and a non-finite / >1 value silently disables the gate. TypeScript's
  // `number` can't catch these at runtime (config, JSON), so fail loud.
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(
      `Invalid autopilot threshold ${threshold}: must be a finite number in [0, 1].`,
    );
  }

  const score =
    WEIGHT_TIER * TIER_BASE[signals.tier] +
    WEIGHT_COMP_AGREEMENT * signals.compAgreement +
    WEIGHT_IDENTIFICATION * identificationScore(signals.identification);

  const band = bandFor(score);
  const autopilotEligible = autopilotEnabled && score >= threshold;

  return { score, band, autopilotEligible };
}
