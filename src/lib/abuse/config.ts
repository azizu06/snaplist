/**
 * Abuse & cost-protection limits (issue #58). Pure + env-configurable: sensible
 * defaults that billing (#64) will gate by tier. Every limit is overridable via
 * env so production can tune without a deploy-code change.
 */

export type Tier = "free" | "paid";

export interface TierLimits {
  /** Sliding-window rate limit on metered AI/API routes (requests per minute). */
  meteredPerMinute: number;
  /** Spend guardrail: max items a user may process per day (each item = vision +
   *  pricing + listing model calls — the real OpenAI cost driver). */
  itemsPerDay: number;
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Resolve a tier's limits from env (with defaults). */
export function tierLimits(
  tier: Tier,
  env: Record<string, string | undefined> = process.env,
): TierLimits {
  if (tier === "paid") {
    return {
      meteredPerMinute: num(env.RATE_LIMIT_PAID_PER_MINUTE, 60),
      itemsPerDay: num(env.QUOTA_PAID_ITEMS_PER_DAY, 200),
    };
  }
  return {
    meteredPerMinute: num(env.RATE_LIMIT_FREE_PER_MINUTE, 20),
    itemsPerDay: num(env.QUOTA_FREE_ITEMS_PER_DAY, 15),
  };
}

/**
 * The caller's tier. Everyone is `free` until billing (#64) lands and flips paid
 * subscribers — this is the single seam that issue will set; nothing else changes.
 */
export function resolveTier(_userId: string): Tier {
  return "free";
}

/**
 * Global daily OpenAI-call budget: when the app-wide count of model-backed pipeline
 * runs crosses this in a day, fire a ONE-TIME alert (it warns; it does not block —
 * the per-user item cap is the hard limiter). Protects the dev/showcase budget.
 */
export function openAiDailyCallBudget(
  env: Record<string, string | undefined> = process.env,
): number {
  return num(env.OPENAI_DAILY_CALL_BUDGET, 1000);
}
