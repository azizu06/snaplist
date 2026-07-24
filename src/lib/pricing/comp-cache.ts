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

export interface CacheClaimAuthority {
  ownerToken: string;
  state: "live" | "terminal";
  updatedAt: number;
}

export interface TtlCache<T> {
  /** Whether atomic claims coordinate only this process or every worker runtime. */
  readonly scope?: "process" | "shared";
  /** The cached value, or null on a miss / expiry. */
  get(key: string, signal?: AbortSignal): Promise<T | null>;
  /** Store a value under the cache's TTL. */
  set(key: string, value: T, signal?: AbortSignal): Promise<void>;
  /** Atomically claim one cache identity for the full TTL when supported. */
  claim?(key: string, signal?: AbortSignal, ownerToken?: string): Promise<boolean>;
  /** Observe the durable owner token after an ambiguous claim response. */
  getClaimOwner?(key: string, signal?: AbortSignal): Promise<string | null>;
  /** Observe bounded liveness/terminal truth for the exact paid-claim owner. */
  getClaimAuthority?(
    key: string,
    signal?: AbortSignal,
  ): Promise<CacheClaimAuthority | null>;
  /** Refresh liveness only while this exact owner still holds live authority. */
  refreshClaimAuthority?(
    key: string,
    ownerToken: string,
    signal?: AbortSignal,
  ): Promise<boolean>;
  /** Mark this exact owner's authority terminal without releasing the paid claim. */
  terminateClaimAuthority?(
    key: string,
    ownerToken: string,
    signal?: AbortSignal,
  ): Promise<boolean>;
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
  const claims = new Map<
    string,
    { expires: number; authority: CacheClaimAuthority }
  >();
  const activeClaim = (
    key: string,
  ): { expires: number; authority: CacheClaimAuthority } | null => {
    const claim = claims.get(key);
    if (!claim) return null;
    if (now() >= claim.expires) {
      claims.delete(key);
      return null;
    }
    return claim;
  };
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
    async claim(key, _signal, ownerToken) {
      if (activeClaim(key) != null) return false;
      claims.set(key, {
        expires: now() + ttlMs,
        authority: {
          ownerToken: ownerToken ?? "1",
          state: "live",
          updatedAt: now(),
        },
      });
      return true;
    },
    async getClaimOwner(key) {
      return activeClaim(key)?.authority.ownerToken ?? null;
    },
    async getClaimAuthority(key) {
      const authority = activeClaim(key)?.authority;
      return authority ? { ...authority } : null;
    },
    async refreshClaimAuthority(key, ownerToken) {
      const claim = activeClaim(key);
      if (
        !claim ||
        claim.authority.ownerToken !== ownerToken ||
        claim.authority.state !== "live"
      ) {
        return false;
      }
      claim.authority = { ownerToken, state: "live", updatedAt: now() };
      return true;
    },
    async terminateClaimAuthority(key, ownerToken) {
      const claim = activeClaim(key);
      if (!claim || claim.authority.ownerToken !== ownerToken) return false;
      claim.authority = { ownerToken, state: "terminal", updatedAt: now() };
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
  get(key: string, signal?: AbortSignal): Promise<unknown>;
  set(
    key: string,
    value: string,
    opts: { ex: number; nx?: true },
    signal?: AbortSignal,
  ): Promise<unknown>;
  eval?(
    script: string,
    keys: string[],
    args: Array<string | number>,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

const CLAIM_AUTHORITY_TRANSITION_SCRIPT = `
local claimRaw = redis.call("GET", KEYS[1])
if not claimRaw then
  return 0
end

local claimOwner = claimRaw
local claimOk, claim = pcall(cjson.decode, claimRaw)
if claimOk and type(claim) == "table" and type(claim["ownerToken"]) == "string" then
  claimOwner = claim["ownerToken"]
end
if claimOwner ~= ARGV[1] then
  return 0
end

local authorityRaw = redis.call("GET", KEYS[2])
if not authorityRaw then
  authorityRaw = claimRaw
end
local authorityOk, authority = pcall(cjson.decode, authorityRaw)
if not authorityOk or type(authority) ~= "table" then
  return 0
end
if authority["ownerToken"] ~= ARGV[1] then
  return 0
end
if authority["state"] ~= "live" and authority["state"] ~= "terminal" then
  return 0
end

local nextState = ARGV[2]
if nextState == "live" then
  if authority["state"] ~= "live" then
    return 0
  end
elseif nextState ~= "terminal" then
  return 0
end

redis.call("SET", KEYS[2], ARGV[3], "EX", tonumber(ARGV[4]))
return 1
`;

function parseClaimAuthority(raw: unknown): CacheClaimAuthority | null {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) {
    return null;
  }
  const candidate = parsed as Partial<CacheClaimAuthority>;
  if (
    typeof candidate.ownerToken !== "string" ||
    candidate.ownerToken.length === 0 ||
    (candidate.state !== "live" && candidate.state !== "terminal") ||
    typeof candidate.updatedAt !== "number" ||
    !Number.isFinite(candidate.updatedAt)
  ) {
    return null;
  }
  return {
    ownerToken: candidate.ownerToken,
    state: candidate.state,
    updatedAt: candidate.updatedAt,
  };
}

export function createUpstashTtlCache<T>(
  name: string,
  ttlMs: number,
  injected?: RedisLike,
): TtlCache<T> {
  const ttlSec = Math.max(1, Math.round(ttlMs / 1000));
  let pending: Promise<RedisLike> | null = injected ? Promise.resolve(injected) : null;
  async function client(signal?: AbortSignal): Promise<RedisLike> {
    if (injected) return injected;
    if (signal) {
      const { Redis } = await import("@upstash/redis");
      return Redis.fromEnv({ signal }) as unknown as RedisLike;
    }
    if (!pending) {
      pending = (async () => {
        const { Redis } = await import("@upstash/redis");
        return Redis.fromEnv() as unknown as RedisLike;
      })();
    }
    return pending;
  }
  const namespaced = (key: string) => `${KEY_PREFIX}:${name}:${key}`;
  const claimKey = (key: string) => namespaced(`${key}:paid-claim`);
  const claimAuthorityKey = (key: string, ownerToken: string) =>
    namespaced(`${key}:paid-claim-authority:${ownerToken}`);
  const readRedis = (
    redis: RedisLike,
    key: string,
    signal?: AbortSignal,
  ): Promise<unknown> =>
    injected ? redis.get(key, signal) : redis.get(key);
  const ownerFrom = (raw: unknown): string | null =>
    parseClaimAuthority(raw)?.ownerToken ??
    (typeof raw === "string" && raw.length > 0 ? raw : null);
  const authorityForOwner = async (
    redis: RedisLike,
    key: string,
    ownerToken: string,
    initialRaw: unknown,
    signal?: AbortSignal,
  ): Promise<CacheClaimAuthority | null> => {
    const authorityRaw = await readRedis(
      redis,
      claimAuthorityKey(key, ownerToken),
      signal,
    );
    const authority =
      authorityRaw == null
        ? parseClaimAuthority(initialRaw)
        : parseClaimAuthority(authorityRaw);
    return authority?.ownerToken === ownerToken ? authority : null;
  };
  const transitionClaimAuthority = async (
    redis: RedisLike,
    key: string,
    ownerToken: string,
    state: CacheClaimAuthority["state"],
    signal?: AbortSignal,
  ): Promise<boolean> => {
    if (typeof redis.eval !== "function") return false;
    const nextAuthority: CacheClaimAuthority = {
      ownerToken,
      state,
      updatedAt: Date.now(),
    };
    const keys = [claimKey(key), claimAuthorityKey(key, ownerToken)];
    const args = [
      ownerToken,
      state,
      JSON.stringify(nextAuthority),
      ttlSec,
    ];
    const transitioned = injected
      ? await redis.eval(
          CLAIM_AUTHORITY_TRANSITION_SCRIPT,
          keys,
          args,
          signal,
        )
      : await redis.eval(CLAIM_AUTHORITY_TRANSITION_SCRIPT, keys, args);
    return transitioned === 1 || transitioned === "1" || transitioned === true;
  };
  return {
    scope: "shared",
    async get(key, signal) {
      const redis = await client(signal);
      const raw = injected
        ? await redis.get(namespaced(key), signal)
        : await redis.get(namespaced(key));
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
    async set(key, value, signal) {
      await (await client(signal)).set(
        namespaced(key),
        JSON.stringify(value),
        { ex: ttlSec },
        signal,
      );
    },
    async claim(key, signal, ownerToken) {
      const redis = await client(signal);
      const authority: CacheClaimAuthority = {
        ownerToken: ownerToken ?? "1",
        state: "live",
        updatedAt: Date.now(),
      };
      const claimed = injected
        ? await redis.set(
            claimKey(key),
            JSON.stringify(authority),
            { ex: ttlSec, nx: true },
            signal,
          )
        : await redis.set(claimKey(key), JSON.stringify(authority), {
            ex: ttlSec,
            nx: true,
          });
      return claimed === "OK" || claimed === true;
    },
    async getClaimOwner(key, signal) {
      const redis = await client(signal);
      return ownerFrom(await readRedis(redis, claimKey(key), signal));
    },
    async getClaimAuthority(key, signal) {
      const redis = await client(signal);
      const initialRaw = await readRedis(redis, claimKey(key), signal);
      const ownerToken = ownerFrom(initialRaw);
      if (ownerToken == null) return null;
      const authority = await authorityForOwner(
        redis,
        key,
        ownerToken,
        initialRaw,
        signal,
      );
      const confirmedOwner = ownerFrom(
        await readRedis(redis, claimKey(key), signal),
      );
      return confirmedOwner === ownerToken ? authority : null;
    },
    async refreshClaimAuthority(key, ownerToken, signal) {
      const redis = await client(signal);
      return transitionClaimAuthority(
        redis,
        key,
        ownerToken,
        "live",
        signal,
      );
    },
    async terminateClaimAuthority(key, ownerToken, signal) {
      const redis = await client(signal);
      return transitionClaimAuthority(
        redis,
        key,
        ownerToken,
        "terminal",
        signal,
      );
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
