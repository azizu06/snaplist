import { describe, it, expect, beforeEach } from "vitest";
import {
  createInMemoryTtlCache,
  createUpstashTtlCache,
  getTtlCache,
  upstashConfigured,
  __resetTtlCaches,
} from "./comp-cache";

beforeEach(() => __resetTtlCaches());

describe("createInMemoryTtlCache", () => {
  it("returns null on a miss and the stored value on a hit", async () => {
    const cache = createInMemoryTtlCache<number[]>(10_000);
    expect(await cache.get("k")).toBeNull();
    await cache.set("k", [1, 2, 3]);
    expect(await cache.get("k")).toEqual([1, 2, 3]);
  });

  it("expires an entry after the TTL (injected clock)", async () => {
    let t = 1_000_000;
    const cache = createInMemoryTtlCache<string>(5_000, () => t);
    await cache.set("k", "v");
    t += 4_999;
    expect(await cache.get("k")).toBe("v"); // still within TTL
    t += 2; // now past TTL
    expect(await cache.get("k")).toBeNull();
  });

  it("overwrites and refreshes the TTL on re-set", async () => {
    let t = 0;
    const cache = createInMemoryTtlCache<string>(100, () => t);
    await cache.set("k", "a");
    t = 50;
    await cache.set("k", "b"); // refresh; new expiry = 150
    t = 120;
    expect(await cache.get("k")).toBe("b");
  });
});

describe("createUpstashTtlCache (injected fake client)", () => {
  it("namespaces keys, sets with a TTL, and round-trips JSON", async () => {
    const calls: { set: [string, string, { ex: number }][]; get: string[] } = {
      set: [],
      get: [],
    };
    const store = new Map<string, string>();
    const fake = {
      async set(key: string, value: string, opts: { ex: number }) {
        calls.set.push([key, value, opts]);
        store.set(key, value); // store the raw string (upstash round-trips it)
      },
      async get(key: string) {
        calls.get.push(key);
        return store.get(key) ?? null;
      },
    };
    const cache = createUpstashTtlCache<{ a: number }[]>("sold", 72 * 3600 * 1000, fake);

    expect(await cache.get("identity")).toBeNull();
    await cache.set("identity", [{ a: 1 }]);

    expect(calls.set[0][0]).toContain("sold:identity"); // namespaced
    expect(calls.set[0][2].ex).toBe(72 * 3600); // ttl in seconds
    expect(await cache.get("identity")).toEqual([{ a: 1 }]);
  });

  it("passes through an already-deserialized object (upstash auto-parse)", async () => {
    const fake = {
      async set() {},
      async get() {
        return [{ a: 9 }]; // upstash auto-deserializes JSON to the object
      },
    };
    const cache = createUpstashTtlCache<{ a: number }[]>("sold", 1000, fake);
    expect(await cache.get("k")).toEqual([{ a: 9 }]);
  });
});

describe("upstashConfigured + getTtlCache backend selection", () => {
  it("is configured only when BOTH url and token are present", () => {
    expect(upstashConfigured({})).toBe(false);
    expect(upstashConfigured({ UPSTASH_REDIS_REST_URL: "u" })).toBe(false);
    expect(
      upstashConfigured({ UPSTASH_REDIS_REST_URL: "u", UPSTASH_REDIS_REST_TOKEN: "t" }),
    ).toBe(true);
  });

  it("falls back to an in-memory cache when Upstash is unset (offline-safe)", async () => {
    const cache = getTtlCache<string>("sold", 10_000, {});
    await cache.set("k", "v");
    expect(await cache.get("k")).toBe("v"); // works with no Upstash env
  });

  it("returns the same cached instance for identical (name, ttl, backend)", () => {
    const a = getTtlCache<string>("sold", 10_000, {});
    const b = getTtlCache<string>("sold", 10_000, {});
    expect(a).toBe(b);
  });
});
