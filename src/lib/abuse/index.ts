import { NextResponse } from "next/server";
import {
  openAiDailyCallBudget,
  resolveTier,
  tierLimits,
  type Tier,
} from "./config";
import { decrDaily, getLimiter, incrDaily, type LimitResult } from "./store";
import { logEvent } from "../observability";
import { captureError } from "../sentry";

/**
 * Abuse & cost protection (issue #58): rate limiting + spend guardrail. All paths
 * are offline-safe (in-memory fallback when Upstash env is unset) and tier-aware
 * (everyone `free` until billing #64 flips paid).
 */

export type { Tier } from "./config";
export { tierLimits, resolveTier } from "./config";
export { upstashConfigured } from "./store";

/** Stable identifier for a request: the Clerk user when present, else client IP. */
export function requestIdentifier(request: Request, userId?: string | null): string {
  if (userId) return `user:${userId}`;
  const fwd = request.headers.get("x-forwarded-for");
  const ip = fwd?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
  return `ip:${ip}`;
}

/** Lower-level metered-route check (per-minute sliding window) for a given key. */
export async function checkRateLimit(
  identifier: string,
  tier: Tier = "free",
  env: Record<string, string | undefined> = process.env,
): Promise<LimitResult> {
  const limiter = getLimiter("metered", tierLimits(tier, env).meteredPerMinute, 60, env);
  return limiter.limit(identifier);
}

/**
 * Enforce the metered-route rate limit for an API route. Returns a `429` response
 * (with `Retry-After`) when the caller is over the limit, or `null` to proceed.
 * The message is generic — no internals leak (CWE-209, #57).
 */
export async function enforceRateLimit(
  request: Request,
  userId?: string | null,
): Promise<NextResponse | null> {
  const tier = userId ? resolveTier(userId) : "free";
  const id = requestIdentifier(request, userId);
  let result: LimitResult;
  try {
    result = await checkRateLimit(id, tier);
  } catch (err) {
    // FAIL OPEN: a limiter/store (Upstash) outage must not take down the metered
    // routes — degrade to "no rate limiting" and move on, logging the failure.
    logEvent("ratelimit.error", { id, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
  if (result.success) return null;
  const retrySec = Math.ceil(result.resetMs / 1000);
  logEvent("ratelimit.block", { id, limit: result.limit, retrySec });
  return NextResponse.json(
    { error: "Too many requests. Please slow down and try again shortly." },
    { status: 429, headers: { "Retry-After": String(retrySec) } },
  );
}

/**
 * Server-action equivalent of `enforceRateLimit` — a server action can't return a
 * `429`, so this returns whether the call is ALLOWED (caller redirects on false).
 * Uses the SAME `user:<id>` key + metered limiter as the route, so an operation
 * exposed through both a route and an action shares one per-user bucket. Fails OPEN.
 */
export async function rateLimitAllows(
  userId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  try {
    const result = await checkRateLimit(`user:${userId}`, resolveTier(userId), env);
    if (!result.success) logEvent("ratelimit.block", { id: `user:${userId}`, limit: result.limit });
    return result.success;
  } catch (err) {
    logEvent("ratelimit.error", { id: `user:${userId}`, error: err instanceof Error ? err.message : String(err) });
    return true; // fail open
  }
}

export interface QuotaResult {
  allowed: boolean;
  used: number;
  limit: number;
}

/**
 * Spend guardrail — the per-user/day ITEM cap (the quota billing #64 will gate).
 * Atomically increments today's count and reports whether this item is within the
 * tier's daily limit. Each item is a full vision+pricing+listing run, so this is
 * the real cost lever.
 */
export async function checkDailyItemQuota(
  userId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<QuotaResult> {
  const tier = resolveTier(userId);
  const limit = tierLimits(tier, env).itemsPerDay;
  let used: number;
  try {
    used = await incrDaily(`items:user:${userId}`, env);
  } catch (err) {
    // FAIL OPEN: never block a paying-the-cost-anyway upload because the counter
    // store is down — log and allow (the global budget alert still backstops cost).
    logEvent("quota.error", { userId, error: err instanceof Error ? err.message : String(err) });
    return { allowed: true, used: 0, limit };
  }
  const allowed = used <= limit;
  if (!allowed) logEvent("quota.item.block", { userId, used, limit, tier });
  return { allowed, used, limit };
}

/**
 * Give back a daily item slot consumed by `checkDailyItemQuota` when the gated work
 * (upload/pipeline) FAILED — a transient storage/model error must not permanently
 * burn the user's daily allowance. Best-effort + fail-open (never breaks the
 * already-failing request). The global OpenAI budget counter is intentionally NOT
 * refunded: a failed run can still have cost model calls.
 */
export async function refundDailyItem(
  userId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  try {
    await decrDaily(`items:user:${userId}`, env);
  } catch (err) {
    logEvent("quota.refund.error", { userId, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Spend guardrail — the global OpenAI budget ALERT (distinct from the per-user cap;
 * it warns, it does not block). Counts model-backed pipeline runs app-wide per day
 * and fires a ONE-TIME alert (log + Sentry) on the exact first breach of the budget.
 */
export async function recordPipelineRunAndMaybeAlert(
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const budget = openAiDailyCallBudget(env);
  let count: number;
  try {
    count = await incrDaily("openai:global", env);
  } catch (err) {
    // Best-effort alerting — a counter-store outage must not break the pipeline run.
    logEvent("openai.budget.error", { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (count === budget + 1) {
    logEvent("openai.budget.exceeded", { count, budget });
    captureError(new Error(`OpenAI daily call budget exceeded: ${count}/${budget}`), {
      context: "openai.budget",
      count,
      budget,
    });
  }
}
