import { describe, expect, it, vi } from "vitest";
import { createSupabaseNativeSubscriptionBridge } from "@/lib/billing/revenuecat-store";
import { createMobileApiHandler } from "./app";

const summary = {
  claimed: 0,
  succeeded: 0,
  retrying: 0,
  failed: 0,
  skipped: 0,
};

function handler(overrides: Record<string, unknown> = {}) {
  return createMobileApiHandler({
    authenticate: vi.fn().mockResolvedValue({ userId: "user_smoke" }),
    worker: { consume: vi.fn().mockResolvedValue(summary) },
    workerSecret: "worker-secret",
    requestId: () => "req_test",
    subscriptionBridge: {
      configurationFor: vi.fn().mockResolvedValue({
        configured: false,
        appUserId: "user_smoke",
      }),
      entitlementFor: vi.fn().mockResolvedValue({
        billingSource: "included",
        status: "included",
        remainingItems: 1,
        periodStart: null,
        periodEnd: null,
        gracePeriodEnd: null,
        transitionState: "not_required",
        legacyStripeStatus: null,
      }),
    },
    ...overrides,
  });
}

describe("mobile API v1 provider-neutral handler", () => {
  it("serves versioned health without Next.js response types", async () => {
    const response = await handler()(new Request("http://localhost/v1/health"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: { apiVersion: "v1", status: "ok" },
      meta: { requestId: "req_test" },
    });
  });

  it("requires a bearer token at the SwiftUI authentication seam", async () => {
    const authenticate = vi.fn();
    const response = await handler({ authenticate })(
      new Request("http://localhost/v1/session"),
    );

    expect(response.status).toBe(401);
    expect(authenticate).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "unauthorized",
        message: "Authentication is required.",
        requestId: "req_test",
      },
    });
  });

  it("passes the opaque Clerk/Supabase bearer token to an injected verifier", async () => {
    const authenticate = vi.fn().mockResolvedValue({ userId: "user_native" });
    const response = await handler({ authenticate })(
      new Request("http://localhost/v1/session", {
        headers: { authorization: "Bearer signed-jwt" },
      }),
    );

    expect(authenticate).toHaveBeenCalledWith("signed-jwt");
    await expect(response.json()).resolves.toEqual({
      data: { userId: "user_native" },
      meta: { requestId: "req_test" },
    });
  });

  it("returns the tenant-scoped Home projection for the verified native seller", async () => {
    const homeProjection = {
      forSeller: vi.fn().mockResolvedValue({
        revision: 12,
        sellerState: "active",
        unreadNotificationCount: 1,
        summary: { active: 1, drafts: 0, orders: 0 },
        attention: [],
        currentRun: null,
        readyToFinish: [],
        listings: [
          {
            id: "20800000-0000-4000-8000-000000000040",
            title: "Canon AE-1 film camera",
            lifecycle: "active",
            statusLabel: "Live",
            detail: "eBay · Listed",
            price: "$210",
          },
        ],
        recentSearches: [],
      }),
    };
    const authenticate = vi.fn().mockResolvedValue({ userId: "user_native" });

    const response = await handler({ authenticate, homeProjection })(
      new Request("http://localhost/v1/home", {
        headers: { authorization: "Bearer signed-jwt" },
      }),
    );

    expect(response.status).toBe(200);
    expect(authenticate).toHaveBeenCalledWith("signed-jwt");
    expect(homeProjection.forSeller).toHaveBeenCalledWith({
      userId: "user_native",
      bearerToken: "signed-jwt",
    });
    await expect(response.json()).resolves.toMatchObject({
      data: {
        revision: 12,
        listings: [{ title: "Canon AE-1 film camera", lifecycle: "active" }],
      },
      meta: { requestId: "req_test" },
    });
  });

  it("fails Home closed without auth or a readable server projection", async () => {
    const homeProjection = { forSeller: vi.fn() };
    const unauthenticated = await handler({ homeProjection })(
      new Request("http://localhost/v1/home"),
    );
    expect(unauthenticated.status).toBe(401);
    expect(homeProjection.forSeller).not.toHaveBeenCalled();

    const unavailable = await handler({
      homeProjection: {
        forSeller: vi.fn().mockRejectedValue(new Error("database unavailable")),
      },
    })(
      new Request("http://localhost/v1/home", {
        headers: { authorization: "Bearer signed-jwt" },
      }),
    );
    expect(unavailable.status).toBe(503);
    expect(JSON.stringify(await unavailable.json())).not.toContain("database unavailable");
  });

  it("binds RevenueCat only to the verified Clerk principal and ignores a body user id", async () => {
    const configurationFor = vi.fn().mockResolvedValue({
      configured: true,
      appUserId: "user_native",
      publicSdkKey: "appl_public_fixture",
      entitlementId: "pro",
      monthlyProductId: "snaplist-pro-fixture",
      transitionState: "not_required",
      legacyStripeStatus: null,
    });
    const response = await handler({
      authenticate: vi.fn().mockResolvedValue({ userId: "user_native" }),
      subscriptionBridge: {
        configurationFor,
        entitlementFor: vi.fn(),
      },
    })(
      new Request("http://localhost/v1/billing/revenuecat/identity", {
        method: "POST",
        headers: {
          authorization: "Bearer signed-jwt",
          "content-type": "application/json",
        },
        body: JSON.stringify({ userId: "attacker" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(configurationFor).toHaveBeenCalledWith("user_native");
    await expect(response.json()).resolves.toEqual({
      data: {
        configured: true,
        appUserId: "user_native",
        publicSdkKey: "appl_public_fixture",
        entitlementId: "pro",
        monthlyProductId: "snaplist-pro-fixture",
        transitionState: "not_required",
        legacyStripeStatus: null,
      },
      meta: { requestId: "req_test" },
    });
  });

  it("returns only the server-verified #168 entitlement and keeps Stripe distinct", async () => {
    const entitlementFor = vi.fn().mockResolvedValue({
      billingSource: "storekit",
      status: "grace",
      remainingItems: 7,
      periodStart: "2026-07-01T00:00:00.000Z",
      periodEnd: "2026-08-01T00:00:00.000Z",
      gracePeriodEnd: "2026-08-08T00:00:00.000Z",
      transitionState: "reconciled",
      legacyStripeStatus: "active",
    });
    const response = await handler({
      authenticate: vi.fn().mockResolvedValue({ userId: "user_native" }),
      subscriptionBridge: {
        configurationFor: vi.fn(),
        entitlementFor,
      },
    })(
      new Request("http://localhost/v1/entitlements/ai-items", {
        headers: { authorization: "Bearer signed-jwt" },
      }),
    );

    expect(response.status).toBe(200);
    expect(entitlementFor).toHaveBeenCalledWith("user_native");
    await expect(response.json()).resolves.toEqual({
      data: {
        billingSource: "storekit",
        status: "grace",
        remainingItems: 7,
        periodStart: "2026-07-01T00:00:00.000Z",
        periodEnd: "2026-08-01T00:00:00.000Z",
        gracePeriodEnd: "2026-08-08T00:00:00.000Z",
        transitionState: "reconciled",
        legacyStripeStatus: "active",
      },
      meta: { requestId: "req_test" },
    });
  });

  it("returns an included allowance without leaking unbounded database timestamps", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          billing_source: "included",
          status: "included",
          remaining_items: 0,
          period_start: "-infinity",
          period_end: "infinity",
          grace_period_end: null,
          transition_state: "not_required",
          legacy_stripe_status: null,
        },
      ],
      error: null,
    });
    const subscriptionBridge = createSupabaseNativeSubscriptionBridge(
      { rpc } as never,
      {
        signingSecret: "offline-webhook-secret",
        authorization: "Bearer offline",
        appId: "app_test",
        entitlementId: "pro",
        monthlyProductId: "snaplist-pro-fixture",
        monthlyAllowance: 24,
      },
    );
    const response = await handler({
      authenticate: vi.fn().mockResolvedValue({ userId: "user_native" }),
      subscriptionBridge,
    })(
      new Request("http://localhost/v1/entitlements/ai-items", {
        headers: { authorization: "Bearer signed-jwt" },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: {
        billingSource: "included",
        status: "included",
        remainingItems: 0,
        periodStart: null,
        periodEnd: null,
        gracePeriodEnd: null,
        transitionState: "not_required",
        legacyStripeStatus: null,
      },
      meta: { requestId: "req_test" },
    });
  });

  it("requires authentication before either native billing seam", async () => {
    for (const [url, method] of [
      ["http://localhost/v1/billing/revenuecat/identity", "POST"],
      ["http://localhost/v1/entitlements/ai-items", "GET"],
    ] as const) {
      const response = await handler()(new Request(url, { method }));
      expect(response.status).toBe(401);
    }
  });

  it("returns 401 rather than a billing error when native bearer verification fails", async () => {
    const response = await handler({
      authenticate: vi.fn().mockRejectedValue(new Error("invalid JWT")),
    })(
      new Request("http://localhost/v1/entitlements/ai-items", {
        headers: { authorization: "Bearer invalid" },
      }),
    );
    expect(response.status).toBe(401);
  });

  it("fails closed before invoking the internal bounded consumer", async () => {
    const consume = vi.fn();
    const response = await handler({ worker: { consume } })(
      new Request("http://localhost/internal/v1/pipeline/consume", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(401);
    expect(consume).not.toHaveBeenCalled();
  });

  it("invokes the existing durable consumer once with the internal secret", async () => {
    const consume = vi.fn().mockResolvedValue(summary);
    const response = await handler({ worker: { consume } })(
      new Request("http://localhost/internal/v1/pipeline/consume", {
        method: "POST",
        headers: { authorization: "Bearer worker-secret" },
      }),
    );

    expect(response.status).toBe(200);
    expect(consume).toHaveBeenCalledOnce();
    await expect(response.json()).resolves.toEqual({
      data: summary,
      meta: { requestId: "req_test" },
    });
  });

  it("never leaks internal worker failures to the client", async () => {
    const response = await handler({
      worker: {
        consume: vi.fn().mockRejectedValue(new Error("service role secret detail")),
      },
      reportError: vi.fn(),
    })(
      new Request("http://localhost/internal/v1/pipeline/consume", {
        method: "POST",
        headers: { authorization: "Bearer worker-secret" },
      }),
    );

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({
      error: {
        code: "internal_error",
        message: "The pipeline worker could not start.",
        requestId: "req_test",
      },
    });
    expect(JSON.stringify(body)).not.toContain("service role");
  });
});
