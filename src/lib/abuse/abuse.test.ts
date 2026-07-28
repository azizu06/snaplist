import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openAiDailyCallBudget, resolveTier, tierLimits } from "./config";
import * as store from "./store";
import { getLimiter, incrDaily, __resetInMemoryStores } from "./store";
import {
  checkDailyItemQuota,
  checkRateLimit,
  enforceAppAttestRateLimit,
  enforceRateLimit,
  rateLimitAllows,
  recordPipelineRunAndMaybeAlert,
  refundDailyItem,
  __resetAbuseAlerts,
} from "./index";

beforeEach(() => {
  __resetInMemoryStores();
  __resetAbuseAlerts();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("abuse/config", () => {
  it("applies sensible defaults and env overrides per tier", () => {
    expect(tierLimits("free", {})).toEqual({ meteredPerMinute: 20, itemsPerDay: 15 });
    expect(tierLimits("paid", {})).toEqual({ meteredPerMinute: 60, itemsPerDay: 200 });
    expect(
      tierLimits("free", { RATE_LIMIT_FREE_PER_MINUTE: "5", QUOTA_FREE_ITEMS_PER_DAY: "3" }),
    ).toEqual({ meteredPerMinute: 5, itemsPerDay: 3 });
    expect(openAiDailyCallBudget({ OPENAI_DAILY_CALL_BUDGET: "7" })).toBe(7);
    expect(resolveTier("user_x")).toBe("free");
  });
});

describe("abuse/store (in-memory fallback)", () => {
  it("limits after max within the window, reporting remaining", async () => {
    const limiter = getLimiter("test", 2, 60, {}); // no Upstash env -> in-memory
    expect((await limiter.limit("k")).success).toBe(true);
    const second = await limiter.limit("k");
    expect(second.success).toBe(true);
    expect(second.remaining).toBe(0);
    expect((await limiter.limit("k")).success).toBe(false); // 3rd over the cap of 2
    // A different key has its own bucket.
    expect((await limiter.limit("other")).success).toBe(true);
  });

  it("incrDaily returns a monotonically increasing per-key count", async () => {
    expect(await incrDaily("c", {})).toBe(1);
    expect(await incrDaily("c", {})).toBe(2);
    expect(await incrDaily("d", {})).toBe(1);
  });
});

describe("abuse spend guardrail", () => {
  it("checkDailyItemQuota allows up to the cap, then blocks", async () => {
    const env = { QUOTA_FREE_ITEMS_PER_DAY: "2" };
    expect(await checkDailyItemQuota("u1", env)).toMatchObject({ allowed: true, used: 1, limit: 2 });
    expect(await checkDailyItemQuota("u1", env)).toMatchObject({ allowed: true, used: 2 });
    expect(await checkDailyItemQuota("u1", env)).toMatchObject({ allowed: false, used: 3 });
    // Per-user: a different user is unaffected.
    expect(await checkDailyItemQuota("u2", env)).toMatchObject({ allowed: true, used: 1 });
  });

  it("refundDailyItem gives back a slot so a failed upload doesn't burn quota", async () => {
    const env = { QUOTA_FREE_ITEMS_PER_DAY: "2" };
    await checkDailyItemQuota("u1", env); // consume -> used 1
    await refundDailyItem("u1", env); // failed upload -> refunded to 0
    // Both subsequent items are allowed, proving the slot came back.
    expect(await checkDailyItemQuota("u1", env)).toMatchObject({ allowed: true, used: 1 });
    expect(await checkDailyItemQuota("u1", env)).toMatchObject({ allowed: true, used: 2 });
  });

  it("OpenAI budget alert fires exactly once on the first breach", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const env = { OPENAI_DAILY_CALL_BUDGET: "2" };
    await recordPipelineRunAndMaybeAlert(env); // count 1
    await recordPipelineRunAndMaybeAlert(env); // count 2 (== budget, no alert yet)
    await recordPipelineRunAndMaybeAlert(env); // count 3 (== budget+1 -> alert)
    await recordPipelineRunAndMaybeAlert(env); // count 4 (no repeat alert)
    const alerts = log.mock.calls
      .map((c) => c[0] as string)
      .filter((line) => line.includes("openai.budget.exceeded"));
    expect(alerts).toHaveLength(1);
    expect(JSON.parse(alerts[0])).toMatchObject({ count: 3, budget: 2 });
  });
});

describe("abuse in-memory fallback in production (ADR-0004 deployment assumption)", () => {
  it("alerts exactly once when production traffic runs on the per-instance fallback", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const env = { NODE_ENV: "production" }; // no Upstash vars -> in-memory fallback
    await checkRateLimit("id", "free", env);
    await checkRateLimit("id", "free", env); // no repeat alert
    await checkDailyItemQuota("u1", env); // shares the once-per-process flag
    const alerts = log.mock.calls
      .map((c) => c[0] as string)
      .filter((line) => line.includes("abuse.store.fallback-in-production"));
    expect(alerts).toHaveLength(1);
  });

  it("stays silent in development and when Upstash is configured", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await checkRateLimit("id", "free", { NODE_ENV: "development" });
    await checkDailyItemQuota("u1", {
      NODE_ENV: "production",
      UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "tok",
      QUOTA_FREE_ITEMS_PER_DAY: "2",
    }).catch(() => {}); // Upstash client isn't reachable offline; the alert check runs first
    const alerts = log.mock.calls
      .map((c) => c[0] as string)
      .filter((line) => line.includes("abuse.store.fallback-in-production"));
    expect(alerts).toHaveLength(0);
  });
});

describe("abuse rate limiting", () => {
  it("checkRateLimit blocks past the per-minute cap", async () => {
    const env = { RATE_LIMIT_FREE_PER_MINUTE: "1" };
    expect((await checkRateLimit("id", "free", env)).success).toBe(true);
    expect((await checkRateLimit("id", "free", env)).success).toBe(false);
  });

  it("rateLimitAllows (server-action seam) blocks over the cap and fails OPEN on error", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("RATE_LIMIT_FREE_PER_MINUTE", "1");
    expect(await rateLimitAllows("user_a")).toBe(true); // 1st allowed
    expect(await rateLimitAllows("user_a")).toBe(false); // 2nd blocked (shares user bucket)
    // Store outage -> allow (availability > strictness).
    vi.spyOn(store, "getLimiter").mockReturnValue({
      limit: async () => {
        throw new Error("redis unreachable");
      },
    });
    expect(await rateLimitAllows("user_b")).toBe(true);
  });

  it("enforceRateLimit returns a 429 with Retry-After once over the limit", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("RATE_LIMIT_FREE_PER_MINUTE", "1");
    const req = new Request("https://snaplist.app/api/inbox/simulate", { method: "POST" });
    expect(await enforceRateLimit(req, "user_a")).toBeNull(); // 1st allowed
    const blocked = await enforceRateLimit(req, "user_a"); // 2nd blocked
    expect(blocked).not.toBeNull();
    expect(blocked!.status).toBe(429);
    expect(blocked!.headers.get("Retry-After")).toBeTruthy();
    const body = await blocked!.json();
    expect(body.error).toMatch(/too many requests/i);
  });

  it("enforceAppAttestRateLimit uses a dedicated IP bucket and typed unavailable truth", async () => {
    const env = { RATE_LIMIT_FREE_PER_MINUTE: "1" };
    const request = new Request("https://snaplist.dev/api/app-attest", {
      headers: { "x-forwarded-for": "198.51.100.31" },
      method: "POST",
    });
    expect(await enforceAppAttestRateLimit(request, env)).toBeNull();

    const blocked = await enforceAppAttestRateLimit(request, env);
    expect(blocked).not.toBeNull();
    expect(blocked!.status).toBe(429);
    expect(blocked!.headers.get("Retry-After")).toBeTruthy();
    await expect(blocked!.json()).resolves.toEqual({
      data: { code: "rate_limited", status: "unavailable" },
    });

    const otherIP = new Request("https://snaplist.dev/api/app-attest", {
      headers: { "x-real-ip": "198.51.100.32" },
      method: "POST",
    });
    expect(await enforceAppAttestRateLimit(otherIP, env)).toBeNull();
  });
});

describe("abuse fails OPEN when the store errors (availability > strictness)", () => {
  it("checkDailyItemQuota allows the request when the counter store throws", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(store, "incrDaily").mockRejectedValue(new Error("redis unreachable"));
    expect(await checkDailyItemQuota("u1", {})).toMatchObject({ allowed: true });
  });

  it("enforceRateLimit returns null (allow) when the limiter throws", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(store, "getLimiter").mockReturnValue({
      limit: async () => {
        throw new Error("redis unreachable");
      },
    });
    const req = new Request("https://snaplist.app/api/inbox/send", { method: "POST" });
    expect(await enforceRateLimit(req, "user_a")).toBeNull();
  });
});
