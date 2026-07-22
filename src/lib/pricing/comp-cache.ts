/**
 * A small TTL cache for pricing freshness (issue #59): cache a sold-comp scrape
 * keyed by resolved product identity, reuse it for a few days, then re-fetch.
 * This cuts the SCRAPE footprint (live fetch is still the source of truth — the
 * cache "never becomes the authority", per the PRD); price freshness on cached
 * data is preserved separately by the age-decay layer (`freshness.ts`), which is
 * re-applied on every read.
 *
 * Two backends behind one interface:
 *  - In-memory (default) — per-instance, keeps dev / the offline test suite working
 *    with no external service. Per-serverless-instance, so its footprint win is
 *    modest; production sets Upstash for a shared, cross-instance cache.
 *  - Upstash Redis (when `UPSTASH_REDIS_REST_*` is set) — loaded ONLY via dynamic
 *    import so the node-only client never reaches a client bundle (mirrors the
 *    abuse limiter and Sentry patterns). Stored with a native `EX` TTL.
 */

export interface TtlCache<T> {
  /** Whether atomic claims coordinate only this process or every worker runtime. */
  readonly scope?: "process" | "shared";
  /** The cached value, or null on a miss / expiry. */
  get(key: string): Promise<T | null>;
  /** Store a value under the cache's TTL. */
  set(key: string, value: T): Promise<void>;
  /** Atomically claim one cache identity for the full TTL when supported. */
  claim?(key: string): Promise<boolean>;
}

/** Redis keys all share this prefix (mirrors the abuse limiter's `snaplist:rl`). */
const KEY_PREFIX = "snaplist:cache";

export function upstashConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN);
}

// ---------------------------------------------------------------------------
// In-memory backend (dev / offline / tests) — `now` is injectable so TTL expiry
// is deterministically testable without real time.
// ---------------------------------------------------------------------------
export function createInMemoryTtlCache<T>(
  ttlMs: number,
  now: () => number = Date.now,
  scope: "process" | "shared" = "process",
): TtlCache<T> {
  const store = new Map<string, { value: T; expires: number }>();
  const claims = new Map<string, number>();
  return {
    scope,
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (now() >= entry.expires) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value) {
      store.set(key, { value, expires: now() + ttlMs });
    },
    async claim(key) {
      const claimedUntil = claims.get(key);
      if (claimedUntil != null && now() < claimedUntil) return false;
      claims.set(key, now() + ttlMs);
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Upstash backend — dynamic import, native EX TTL. `injected` is a test seam so
// the wrapper's key-namespacing / TTL / (de)serialization are unit-testable
// without a live Redis.
// ---------------------------------------------------------------------------
interface RedisLike {
  get(key: string): Promise<unknown>;
  set(
    key: string,
    value: string,
    opts: { ex: number; nx?: true },
  ): Promise<unknown>;
}

export function createUpstashTtlCache<T>(
  name: string,
  ttlMs: number,
  injected?: RedisLike,
): TtlCache<T> {
  const ttlSec = Math.max(1, Math.round(ttlMs / 1000));
  let pending: Promise<RedisLike> | null = injected ? Promise.resolve(injected) : null;
  function client(): Promise<RedisLike> {
    if (!pending) {
      pending = (async () => {
        const { Redis } = await import("@upstash/redis");
        return Redis.fromEnv() as unknown as RedisLike;
      })();
    }
    return pending;
  }
  const namespaced = (key: string) => `${KEY_PREFIX}:${name}:${key}`;
  return {
    scope: "shared",
    async get(key) {
      const raw = await (await client()).get(namespaced(key));
      if (raw == null) return null;
      // @upstash/redis usually auto-deserializes JSON to the object; tolerate a
      // raw string round-trip too (defensive against client/config differences).
      if (typeof raw === "string") {
        try {
          return JSON.parse(raw) as T;
        } catch {
          return null;
        }
      }
      return raw as T;
    },
    async set(key, value) {
      await (await client()).set(namespaced(key), JSON.stringify(value), { ex: ttlSec });
    },
    async claim(key) {
      const claimed = await (await client()).set(
        namespaced(`${key}:paid-claim`),
        "1",
        { ex: ttlSec, nx: true },
      );
      return claimed === "OK" || claimed === true;
    },
  };
}

// ---------------------------------------------------------------------------
// Cached factory — one instance per (name, ttl, backend), like `getLimiter`.
// ---------------------------------------------------------------------------
const registry = new Map<string, TtlCache<unknown>>();

export function getTtlCache<T>(
  name: string,
  ttlMs: number,
  env: Record<string, string | undefined> = process.env,
): TtlCache<T> {
  const cacheKey = `${name}:${ttlMs}:${upstashConfigured(env)}`;
  let cache = registry.get(cacheKey);
  if (!cache) {
    cache = upstashConfigured(env)
      ? createUpstashTtlCache<unknown>(name, ttlMs)
      : createInMemoryTtlCache<unknown>(ttlMs);
    registry.set(cacheKey, cache);
  }
  return cache as TtlCache<T>;
}

/** Test-only: clear the cached instances so cases don't bleed into each other. */
export function __resetTtlCaches(): void {
  registry.clear();
}
