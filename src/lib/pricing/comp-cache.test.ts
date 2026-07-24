import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInMemoryTtlCache,
  createUpstashTtlCache,
  getTtlCache,
  upstashConfigured,
  __resetTtlCaches,
} from "./comp-cache";

beforeEach(() => __resetTtlCaches());

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

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

  it("atomically claims one process-local identity for the TTL", async () => {
    let t = 0;
    const cache = createInMemoryTtlCache<string>(100, () => t);

    expect(cache.scope).toBe("process");
    await expect(cache.claim?.("identity", undefined, "owner-a")).resolves.toBe(true);
    await expect(cache.getClaimOwner?.("identity")).resolves.toBe("owner-a");
    await expect(cache.claim?.("identity", undefined, "owner-b")).resolves.toBe(false);
    t = 101;
    await expect(cache.getClaimOwner?.("identity")).resolves.toBeNull();
    await expect(cache.claim?.("identity", undefined, "owner-b")).resolves.toBe(true);
    await expect(cache.getClaimOwner?.("identity")).resolves.toBe("owner-b");
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

  it("uses a shared SET-NX claim so only one worker runtime wins", async () => {
    const claimed = new Map<string, string>();
    const calls: Array<{ key: string; opts: { ex: number; nx?: true } }> = [];
    const fake = {
      async set(
        key: string,
        _value: string,
        opts: { ex: number; nx?: true },
      ) {
        calls.push({ key, opts });
        if (opts.nx && claimed.has(key)) return null;
        claimed.set(key, _value);
        return "OK";
      },
      async get(key: string) {
        return claimed.get(key) ?? null;
      },
    };
    const cache = createUpstashTtlCache<string>("apify-sold", 60_000, fake);

    expect(cache.scope).toBe("shared");
    await expect(cache.claim?.("identity", undefined, "owner-a")).resolves.toBe(true);
    await expect(cache.getClaimOwner?.("identity")).resolves.toBe("owner-a");
    await expect(cache.claim?.("identity", undefined, "owner-b")).resolves.toBe(false);
    expect(calls[0]).toMatchObject({
      key: expect.stringContaining("apify-sold:identity:paid-claim"),
      opts: { ex: 60, nx: true },
    });
  });

  it("round-trips exact-owner authority when Redis auto-deserializes JSON", async () => {
    const store = new Map<string, string>();
    const fake = {
      async set(
        key: string,
        value: string,
        opts: { ex: number; nx?: true },
      ) {
        if (opts.nx && store.has(key)) return null;
        store.set(key, value);
        return "OK";
      },
      async get(key: string) {
        const value = store.get(key);
        return value == null ? null : JSON.parse(value);
      },
      async eval(
        _script: string,
        keys: string[],
        args: Array<string | number>,
      ) {
        const [claimKey, authorityKey] = keys;
        const [ownerToken, nextState, nextRaw] = args;
        const claim = JSON.parse(store.get(claimKey!)!) as {
          ownerToken: string;
        };
        const current = JSON.parse(
          store.get(authorityKey!) ?? store.get(claimKey!)!,
        ) as { ownerToken: string; state: "live" | "terminal" };
        if (
          claim.ownerToken !== ownerToken ||
          current.ownerToken !== ownerToken ||
          (nextState === "live" && current.state !== "live") ||
          (nextState !== "live" && nextState !== "terminal")
        ) {
          return 0;
        }
        store.set(authorityKey!, String(nextRaw));
        return 1;
      },
    };
    const cache = createUpstashTtlCache<string>("apify-sold", 60_000, fake);

    await expect(
      cache.claim?.("identity", undefined, "owner-a"),
    ).resolves.toBe(true);
    await expect(cache.getClaimOwner?.("identity")).resolves.toBe("owner-a");
    await expect(cache.getClaimAuthority?.("identity")).resolves.toMatchObject({
      ownerToken: "owner-a",
      state: "live",
      updatedAt: expect.any(Number),
    });
    await expect(
      cache.refreshClaimAuthority?.("identity", "owner-b"),
    ).resolves.toBe(false);
    await expect(
      cache.terminateClaimAuthority?.("identity", "owner-a"),
    ).resolves.toBe(true);
    await expect(cache.getClaimAuthority?.("identity")).resolves.toMatchObject({
      ownerToken: "owner-a",
      state: "terminal",
    });
  });

  it("cannot overwrite current authority when ownership changes during a transition", async () => {
    const store = new Map<string, string>();
    let replacementOwner: string | null = null;
    const authority = (ownerToken: string, state: "live" | "terminal") =>
      JSON.stringify({ ownerToken, state, updatedAt: Date.now() });
    const fake = {
      async set(
        key: string,
        value: string,
        opts: { ex: number; nx?: true },
      ) {
        if (opts.nx && store.has(key)) return null;
        if (!opts.nx && replacementOwner != null) {
          const claimKey = [...store.keys()].find((candidate) =>
            candidate.endsWith(":paid-claim"),
          );
          if (claimKey) {
            store.set(claimKey, authority(replacementOwner, "live"));
          }
          replacementOwner = null;
        }
        store.set(key, value);
        return "OK";
      },
      async get(key: string) {
        const value = store.get(key);
        return value == null ? null : JSON.parse(value);
      },
      async eval(
        _script: string,
        keys: string[],
        args: Array<string | number>,
      ) {
        const [claimKey, authorityKey] = keys;
        const [ownerToken, nextState, nextRaw] = args;
        if (replacementOwner != null) {
          store.set(
            claimKey!,
            authority(replacementOwner, "live"),
          );
          replacementOwner = null;
        }
        const claim = JSON.parse(store.get(claimKey!)!) as {
          ownerToken: string;
        };
        const current = JSON.parse(
          store.get(authorityKey!) ?? store.get(claimKey!)!,
        ) as { ownerToken: string; state: "live" | "terminal" };
        if (
          claim.ownerToken !== ownerToken ||
          current.ownerToken !== ownerToken ||
          (nextState === "live" && current.state !== "live") ||
          (nextState !== "live" && nextState !== "terminal")
        ) {
          return 0;
        }
        store.set(authorityKey!, String(nextRaw));
        return 1;
      },
    };
    const cache = createUpstashTtlCache<string>("apify-sold", 60_000, fake);

    await cache.claim?.("identity", undefined, "owner-a");
    replacementOwner = "owner-b";
    await expect(
      cache.refreshClaimAuthority?.("identity", "owner-a"),
    ).resolves.toBe(false);
    await expect(cache.getClaimOwner?.("identity")).resolves.toBe("owner-b");
    await expect(cache.getClaimAuthority?.("identity")).resolves.toMatchObject({
      ownerToken: "owner-b",
      state: "live",
    });

    replacementOwner = "owner-c";
    await expect(
      cache.terminateClaimAuthority?.("identity", "owner-b"),
    ).resolves.toBe(false);
    await expect(cache.getClaimOwner?.("identity")).resolves.toBe("owner-c");
    await expect(cache.getClaimAuthority?.("identity")).resolves.toMatchObject({
      ownerToken: "owner-c",
      state: "live",
    });
  });

  it("keeps terminal authority irreversible when an issued same-owner refresh lands later", async () => {
    const store = new Map<string, string>();
    let reportRefreshIssued!: () => void;
    const refreshIssued = new Promise<void>((resolve) => {
      reportRefreshIssued = resolve;
    });
    let releaseRefresh!: () => void;
    const refreshRelease = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let delayedLiveTransition = false;
    const authority = (raw: string | undefined) =>
      raw == null
        ? null
        : (JSON.parse(raw) as {
            ownerToken: string;
            state: "live" | "terminal";
          });
    const delayIssuedLiveTransition = async (state: string) => {
      if (state !== "live" || delayedLiveTransition) return;
      delayedLiveTransition = true;
      reportRefreshIssued();
      await refreshRelease;
    };
    const fake = {
      async set(
        key: string,
        value: string,
        opts: { ex: number; nx?: true },
      ) {
        if (opts.nx && store.has(key)) return null;
        const next = authority(value);
        if (!opts.nx && next != null) {
          await delayIssuedLiveTransition(next.state);
        }
        store.set(key, value);
        return "OK";
      },
      async get(key: string) {
        const value = store.get(key);
        return value == null ? null : JSON.parse(value);
      },
      async eval(
        _script: string,
        keys: string[],
        args: Array<string | number>,
      ) {
        const [claimKey, authorityKey] = keys;
        const [ownerToken, nextState, nextRaw] = args;
        await delayIssuedLiveTransition(String(nextState));
        const claim = authority(store.get(claimKey!));
        const current = authority(
          store.get(authorityKey!) ?? store.get(claimKey!),
        );
        if (
          claim?.ownerToken !== ownerToken ||
          current?.ownerToken !== ownerToken ||
          (nextState === "live" && current.state !== "live") ||
          (nextState !== "live" && nextState !== "terminal")
        ) {
          return 0;
        }
        store.set(authorityKey!, String(nextRaw));
        return 1;
      },
    };
    const cache = createUpstashTtlCache<string>("apify-sold", 60_000, fake);

    await cache.claim?.("identity", undefined, "owner-a");
    const refresh = cache.refreshClaimAuthority?.("identity", "owner-a");
    await refreshIssued;

    let terminalized = false;
    try {
      terminalized =
        (await cache.terminateClaimAuthority?.("identity", "owner-a")) === true;
      await expect(cache.getClaimAuthority?.("identity")).resolves.toMatchObject(
        {
          ownerToken: "owner-a",
          state: "terminal",
        },
      );
    } finally {
      releaseRefresh();
    }

    expect(terminalized).toBe(true);
    await expect(refresh).resolves.toBe(false);
    await expect(cache.getClaimAuthority?.("identity")).resolves.toMatchObject({
      ownerToken: "owner-a",
      state: "terminal",
    });
  });
});

describe("createUpstashTtlCache (production client shape)", () => {
  it("keeps the abort signal out of the Redis GET command arguments", async () => {
    const commands: unknown[] = [];
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        commands.push(JSON.parse(String(init?.body)) as unknown);
        return new Response(JSON.stringify([{ result: null }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const cache = createUpstashTtlCache<string>("sold", 60_000);
    const controller = new AbortController();

    await expect(cache.get("identity", controller.signal)).resolves.toBeNull();
    expect(commands).toEqual([[["get", "snaplist:cache:sold:identity"]]]);
  });

  it("keeps the abort signal out of the Redis SET command arguments", async () => {
    const commands: unknown[] = [];
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        commands.push(JSON.parse(String(init?.body)) as unknown);
        return new Response(JSON.stringify([{ result: "OK" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const cache = createUpstashTtlCache<string>("sold", 60_000);
    const controller = new AbortController();

    await expect(cache.set("identity", "evidence", controller.signal)).resolves.toBeUndefined();
    expect(commands).toEqual([
      [
        [
          "set",
          "snaplist:cache:sold:identity",
          JSON.stringify("evidence"),
          "ex",
          60,
        ],
      ],
    ]);
  });

  it("round-trips a claim owner without adding the abort signal to Redis commands", async () => {
    const commands: unknown[] = [];
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const command = JSON.parse(String(init?.body)) as unknown;
        commands.push(command);
        const isGet = JSON.stringify(command).includes('"get"');
        return new Response(
          JSON.stringify([{ result: isGet ? "owner-a" : "OK" }]),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }),
    );

    const cache = createUpstashTtlCache<string>("sold", 60_000);
    const controller = new AbortController();

    await expect(
      cache.claim?.("identity", controller.signal, "owner-a"),
    ).resolves.toBe(true);
    await expect(
      cache.getClaimOwner?.("identity", controller.signal),
    ).resolves.toBe("owner-a");
    expect(commands).toHaveLength(2);
    const setCommand = commands[0] as [[string, string, string, string, string, number]];
    expect(setCommand[0].slice(0, 2)).toEqual([
      "set",
      "snaplist:cache:sold:identity:paid-claim",
    ]);
    expect(JSON.parse(setCommand[0][2])).toMatchObject({
      ownerToken: "owner-a",
      state: "live",
      updatedAt: expect.any(Number),
    });
    expect(setCommand[0].slice(3)).toEqual(["nx", "ex", 60]);
    expect(commands[1]).toEqual([
      ["get", "snaplist:cache:sold:identity:paid-claim"],
    ]);
  });

  it("sends authority transitions as one atomic Redis EVAL command", async () => {
    const commands: unknown[] = [];
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const command = JSON.parse(String(init?.body)) as unknown;
        commands.push(command);
        const operation = (command as [[string]])[0][0];
        return new Response(
          JSON.stringify([{ result: operation === "eval" ? 1 : "OK" }]),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }),
    );

    const cache = createUpstashTtlCache<string>("sold", 60_000);
    const controller = new AbortController();

    await expect(
      cache.claim?.("identity", controller.signal, "owner-a"),
    ).resolves.toBe(true);
    await expect(
      cache.terminateClaimAuthority?.(
        "identity",
        "owner-a",
        controller.signal,
      ),
    ).resolves.toBe(true);

    const transition = commands[1] as [
      [
        string,
        string,
        number,
        string,
        string,
        string,
        string,
        string,
        number,
      ],
    ];
    expect(transition[0][0]).toBe("eval");
    expect(transition[0][2]).toBe(2);
    expect(transition[0].slice(3, 5)).toEqual([
      "snaplist:cache:sold:identity:paid-claim",
      "snaplist:cache:sold:identity:paid-claim-authority:owner-a",
    ]);
    expect(transition[0].slice(5, 7)).toEqual(["owner-a", "terminal"]);
    expect(JSON.parse(transition[0][7])).toMatchObject({
      ownerToken: "owner-a",
      state: "terminal",
      updatedAt: expect.any(Number),
    });
    expect(transition[0][8]).toBe(60);
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
