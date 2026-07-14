/**
 * Stale-inventory repricing — the PURE decision logic (issue #102).
 *
 * Inventory that sits doesn't sell. After a live listing has gone N days
 * without a price event, the cron sweep re-runs price research against fresh
 * sold comps and decides, per listing:
 *
 *   stale?  →  drifted materially?  →  auto-apply eligible?  →  floor guard
 *
 * Every decision here is deterministic over its inputs — no I/O, no clock, no
 * randomness — mirroring the confidence-function pattern (AGENTS.md: "the pure
 * confidence function is unit-tested directly with crafted signals"). The
 * sweep (sweep.ts) and the one-tap apply action consume these so the rules
 * exist in exactly one place.
 *
 * Guardrails encoded here:
 *  - AUTO-APPLY fires ONLY when the run passes publish eligibility per the composite
 *    confidence gate AND the seller's per-user auto-reprice toggle (default
 *    OFF) is on. Everything else stays suggest-only.
 *  - NEVER reprice below the seller's price floor: the target price is clamped
 *    to the floor, and a clamp that lands back on the current price downgrades
 *    to a suggestion (the market moved below the floor — the seller decides).
 *  - The batch cap (config) is the scraper rate-limit / spend guardrail: one
 *    sweep run never prices more than `batchSize` items.
 */

/** Env-tunable sweep configuration with PRD-ish defaults. */
export interface RepriceConfig {
  /** A live listing is stale after this many days without a price event. */
  staleDays: number;
  /**
   * Max listings priced per sweep run — the spend/rate-limit guardrail
   * (each candidate live-fetches sold comps through the normal pricing path).
   */
  batchSize: number;
  /** Minimum |drift| (percent, suggested vs current) that counts as material. */
  driftThresholdPct: number;
}

export const REPRICE_DEFAULTS: RepriceConfig = {
  staleDays: 14,
  batchSize: 5,
  driftThresholdPct: 10,
};

/** Parse a positive finite number from env text; fall back to the default. */
function positiveNumber(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Resolve the sweep config from env (`REPRICE_STALE_DAYS`, `REPRICE_BATCH_SIZE`,
 * `REPRICE_DRIFT_THRESHOLD_PCT`). Invalid/absent values fall back to defaults —
 * a typo'd env var must degrade to the safe defaults, never crash the cron or
 * (worse) zero out the drift threshold.
 */
export function resolveRepriceConfig(
  env: Record<string, string | undefined> = process.env,
): RepriceConfig {
  return {
    staleDays: positiveNumber(env.REPRICE_STALE_DAYS, REPRICE_DEFAULTS.staleDays),
    batchSize: Math.floor(
      positiveNumber(env.REPRICE_BATCH_SIZE, REPRICE_DEFAULTS.batchSize),
    ),
    driftThresholdPct: positiveNumber(
      env.REPRICE_DRIFT_THRESHOLD_PCT,
      REPRICE_DEFAULTS.driftThresholdPct,
    ),
  };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Is a listing stale — i.e. has it gone `staleDays` without a price event?
 * `lastPricedAt` null/invalid means "no price event on record", which is
 * treated as STALE (the sweep should look at it) — the sweep stamps
 * `last_priced_at` on every listing it touches, so this converges.
 */
export function isStale(
  lastPricedAt: string | null | undefined,
  now: Date,
  staleDays: number,
): boolean {
  if (!lastPricedAt) return true;
  const t = Date.parse(lastPricedAt);
  if (!Number.isFinite(t)) return true;
  return now.getTime() - t >= staleDays * MS_PER_DAY;
}

/** Signed drift percent of `suggested` vs `current` (+ = market above current). */
export function driftPct(current: number, suggested: number): number {
  return ((suggested - current) / current) * 100;
}

/** Round to cents — marketplace prices don't take sub-cent values. */
function toCents(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface RepriceDecisionInput {
  /** The price the live listing currently carries (override → listed price). */
  currentPrice: number | null | undefined;
  /** The fresh run's suggested price. */
  suggestedPrice: number;
  /** Seller's minimum acceptable price for this item; null = no floor. */
  priceFloor?: number | null;
  /** The fresh run's composite-confidence publish-eligibility decision. */
  autopilotEligible: boolean;
  /** The seller's per-user auto-reprice toggle (default OFF). */
  autoRepriceEnabled: boolean;
  /** Minimum |drift| percent that counts as material. */
  driftThresholdPct: number;
}

export type RepriceDecision =
  | {
      action: "none";
      reason: "no-current-price" | "invalid-suggestion" | "drift-immaterial";
      driftPct: number | null;
    }
  | {
      action: "suggest" | "auto_apply";
      /** Raw market drift (suggested vs current), BEFORE the floor clamp. */
      driftPct: number;
      /** The price an apply would set: the suggestion clamped to the floor. */
      targetPrice: number;
      /** True when the floor raised the target above the raw suggestion. */
      flooredToMinimum: boolean;
    };

/**
 * The core decision: given a fresh suggested price for a stale live listing,
 * do nothing, persist a suggestion, or auto-apply.
 *
 *  - No usable current price (null/NaN/≤0) → none. Drift is undefined; an
 *    unpriced "live" listing is an upstream anomaly, not a reprice target.
 *  - Non-positive/non-finite suggestion → none (a $0 reprice is never valid).
 *  - |drift| below threshold → none (immaterial; don't churn the listing).
 *  - Material drift → suggest, UNLESS the run passes publish eligibility AND the
 *    seller opted into auto-reprice — then auto-apply at the floor-clamped
 *    target. A clamp that lands the target back on the current price (or a
 *    floor above it while the market moved down) cannot auto-apply a no-op:
 *    it downgrades to a suggestion so the seller sees the market moved below
 *    their floor.
 */
export function decideReprice(input: RepriceDecisionInput): RepriceDecision {
  const current =
    typeof input.currentPrice === "number" ? input.currentPrice : NaN;
  if (!Number.isFinite(input.suggestedPrice) || input.suggestedPrice <= 0) {
    return { action: "none", reason: "invalid-suggestion", driftPct: null };
  }
  if (!Number.isFinite(current) || current <= 0) {
    return { action: "none", reason: "no-current-price", driftPct: null };
  }

  const drift = driftPct(current, input.suggestedPrice);
  if (Math.abs(drift) < input.driftThresholdPct) {
    return { action: "none", reason: "drift-immaterial", driftPct: drift };
  }

  const floor =
    typeof input.priceFloor === "number" &&
    Number.isFinite(input.priceFloor) &&
    input.priceFloor > 0
      ? input.priceFloor
      : null;
  const rawTarget = toCents(input.suggestedPrice);
  const targetPrice = floor != null ? Math.max(rawTarget, toCents(floor)) : rawTarget;
  const flooredToMinimum = targetPrice > rawTarget;

  const autoEligible =
    input.autopilotEligible &&
    input.autoRepriceEnabled &&
    // The clamp must never auto-apply a no-op or a floor-forced RAISE against
    // a downward market move — those go to the seller as suggestions.
    targetPrice !== toCents(current) &&
    !(flooredToMinimum && drift < 0);

  return {
    action: autoEligible ? "auto_apply" : "suggest",
    driftPct: drift,
    targetPrice,
    flooredToMinimum,
  };
}
