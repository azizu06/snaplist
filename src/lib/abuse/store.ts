/**
 * The backing store for abuse/cost protection (issue #58). Two primitives:
 *  - `getLimiter` — a sliding-window RATE limiter (`@upstash/ratelimit` when
 *    Upstash env is set; an in-memory fixed-window fallback otherwise).
 *  - `incrDaily`  — a per-day COUNTER for the spend guardrail (Upstash `INCR` +
 *    expiry; in-memory otherwise).
 *
 * Upstash modules are loaded ONLY via dynamic import (never static → never a client
 * bundle, mirroring the Sentry pattern). With no Upstash env the in-memory fallback
 * keeps dev / the offline test suite fully working; it is per-instance (not shared
 * across serverless invocations) — acceptable for dev, and production sets Upstash.
 * All Redis keys use the `snaplist:rl` prefix.
 */

export interface LimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  /** Milliseconds until the window resets. */
  resetMs: number;
}

export interface Limiter {
  limit(key: string): Promise<LimitResult>;
}

const KEY_PREFIX = "snaplist:rl";

export function upstashConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN);
}

// ---------------------------------------------------------------------------
// In-memory fallback (dev / offline / tests) — fixed window per key.
// ---------------------------------------------------------------------------
export function createInMemoryLimiter(max: number, windowMs: number): Limiter {
  const buckets = new Map<string, { count: number; reset: number }>();
  return {
    async limit(key) {
      const now = Date.now();
      let b = buckets.get(key);
      if (!b || now >= b.reset) {
        b = { count: 0, reset: now + windowMs };
        buckets.set(key, b);
      }
      b.count += 1;
      return {
        success: b.count <= max,
        limit: max,
        remaining: Math.max(0, max - b.count),
        resetMs: Math.max(0, b.reset - now),
      };
    },
  };
}

function createUpstashLimiter(name: string, max: number, windowSec: number): Limiter {
  // Lazily build the real Ratelimit on first use; cache the promise.
  let pending: Promise<{ limit: (k: string) => Promise<{ success: boolean; limit: number; remaining: number; reset: number }> }> | null =
    null;
  function get() {
    if (!pending) {
      pending = (async () => {
        const [{ Ratelimit }, { Redis }] = await Promise.all([
          import("@upstash/ratelimit"),
          import("@upstash/redis"),
        ]);
        return new Ratelimit({
          redis: Redis.fromEnv(),
          limiter: Ratelimit.slidingWindow(max, `${windowSec} s` as `${number} s`),
          prefix: `${KEY_PREFIX}:${name}`,
        });
      })();
    }
    return pending;
  }
  return {
    async limit(key) {
      const r = await (await get()).limit(key);
      return {
        success: r.success,
        limit: r.limit,
        remaining: r.remaining,
        resetMs: Math.max(0, r.reset - Date.now()),
      };
    },
  };
}

const limiterCache = new Map<string, Limiter>();

/** A cached rate limiter (Upstash when configured, else in-memory). */
export function getLimiter(
  name: string,
  max: number,
  windowSec: number,
  env: Record<string, string | undefined> = process.env,
): Limiter {
  const cacheKey = `${name}:${max}:${windowSec}:${upstashConfigured(env)}`;
  let l = limiterCache.get(cacheKey);
  if (!l) {
    l = upstashConfigured(env)
      ? createUpstashLimiter(name, max, windowSec)
      : createInMemoryLimiter(max, windowSec * 1000);
    limiterCache.set(cacheKey, l);
  }
  return l;
}

// ---------------------------------------------------------------------------
// Daily counter — per-day INCR for the spend guardrail (quota + budget alert).
// ---------------------------------------------------------------------------
const DAY_TTL_SECONDS = 90_000; // ~25h, comfortably covers a UTC day + retries
const memoryCounters = new Map<string, { count: number; reset: number }>();

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Increment and return today's count for `key` (UTC day). Upstash-backed when
 * configured; in-memory otherwise. Returns the NEW count so callers can detect the
 * exact first breach of a cap/budget.
 */
export async function incrDaily(
  key: string,
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const now = Date.now();
  const dayKey = `${KEY_PREFIX}:daily:${key}:${utcDay(now)}`;
  if (upstashConfigured(env)) {
    const { Redis } = await import("@upstash/redis");
    const redis = Redis.fromEnv();
    const count = await redis.incr(dayKey);
    if (count === 1) await redis.expire(dayKey, DAY_TTL_SECONDS);
    return count;
  }
  // In-memory fallback.
  let c = memoryCounters.get(dayKey);
  if (!c || now >= c.reset) {
    c = { count: 0, reset: now + DAY_TTL_SECONDS * 1000 };
    memoryCounters.set(dayKey, c);
  }
  c.count += 1;
  return c.count;
}

/**
 * Refund one unit from today's count for `key` — used to give back a quota slot
 * when the work it gated (upload/pipeline) failed, so a transient error never
 * permanently burns a user's daily allowance. Best-effort; floors at 0 in memory.
 * (A refund always follows an `incrDaily` within the same request, so the key
 * exists and won't go negative in practice.)
 */
export async function decrDaily(
  key: string,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const dayKey = `${KEY_PREFIX}:daily:${key}:${utcDay(Date.now())}`;
  if (upstashConfigured(env)) {
    const { Redis } = await import("@upstash/redis");
    await Redis.fromEnv().decr(dayKey);
    return;
  }
  const c = memoryCounters.get(dayKey);
  if (c) c.count = Math.max(0, c.count - 1);
}

/** Test-only: reset in-memory state so cases don't bleed into each other. */
export function __resetInMemoryStores(): void {
  limiterCache.clear();
  memoryCounters.clear();
}
