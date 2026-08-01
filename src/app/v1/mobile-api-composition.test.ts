import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  verifyToken,
  createAdminClient,
  createSupabaseNativeSubscriptionBridge,
  resolveRevenueCatServerConfig,
  configurationFor,
  entitlementFor,
  logServerError,
} = vi.hoisted(() => ({
  verifyToken: vi.fn(),
  createAdminClient: vi.fn(),
  createSupabaseNativeSubscriptionBridge: vi.fn(),
  resolveRevenueCatServerConfig: vi.fn(),
  configurationFor: vi.fn(),
  entitlementFor: vi.fn(),
  logServerError: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ verifyToken }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));
vi.mock("@/lib/api/errors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/errors")>()),
  logServerError,
}));
vi.mock("@/lib/billing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing")>()),
  createSupabaseNativeSubscriptionBridge,
  resolveRevenueCatServerConfig,
}));

import { GET as getHealth } from "./health/route";
import { GET as getSession } from "./session/route";
import { GET as getAiItemEntitlement } from "./entitlements/ai-items/route";
import { POST as postRevenueCatIdentity } from "./billing/revenuecat/identity/route";

const environmentKeys = ["CLERK_SECRET_KEY", "CLERK_AUTHORIZED_PARTIES"] as const;

function nativeRequest(path: string, init?: RequestInit): Request {
  return new Request(`https://snaplist.example${path}`, init);
}

function authorized(path: string, method = "GET"): Request {
  return nativeRequest(path, {
    method,
    headers: { authorization: "Bearer signed-release-jwt" },
  });
}

beforeEach(() => {
  process.env.CLERK_SECRET_KEY = "sk_test_release";
  process.env.CLERK_AUTHORIZED_PARTIES = "https://snaplist.example";
  verifyToken.mockResolvedValue({ sub: "user_release" });
  createAdminClient.mockReturnValue({ rpc: vi.fn() });
  resolveRevenueCatServerConfig.mockReturnValue(null);
  createSupabaseNativeSubscriptionBridge.mockReturnValue({
    configurationFor,
    entitlementFor,
  });
  configurationFor.mockResolvedValue({
    configured: false,
    appUserId: "user_release",
  });
  entitlementFor.mockResolvedValue({
    billingSource: "none",
    status: "unconfigured",
    remainingItems: 0,
    periodStart: null,
    periodEnd: null,
    gracePeriodEnd: null,
    transitionState: null,
    legacyStripeStatus: null,
  });
});

afterEach(() => {
  for (const key of environmentKeys) delete process.env[key];
  vi.clearAllMocks();
});

describe("production mobile API route composition", () => {
  it("answers health without any authentication capability", async () => {
    const response = await getHealth(nativeRequest("/v1/health"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { apiVersion: "v1", status: "ok" },
    });
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated session before reaching Clerk", async () => {
    const response = await getSession(nativeRequest("/v1/session"));

    expect(response.status).toBe(401);
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it("returns the Clerk-verified subject as the session identity", async () => {
    const response = await getSession(authorized("/v1/session"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { userId: "user_release" },
    });
    expect(verifyToken).toHaveBeenCalledWith("signed-release-jwt", {
      secretKey: "sk_test_release",
      authorizedParties: ["https://snaplist.example"],
    });
  });

  it("reads the AI-item entitlement for the verified subject, never a body-supplied id", async () => {
    const response = await getAiItemEntitlement(
      authorized("/v1/entitlements/ai-items"),
    );

    expect(response.status).toBe(200);
    expect(entitlementFor).toHaveBeenCalledWith("user_release");
    await expect(response.json()).resolves.toMatchObject({
      data: { status: "unconfigured", remainingItems: 0 },
    });
  });

  it("binds the RevenueCat customer to the verified subject", async () => {
    const response = await postRevenueCatIdentity(
      authorized("/v1/billing/revenuecat/identity", "POST"),
    );

    expect(response.status).toBe(200);
    expect(configurationFor).toHaveBeenCalledWith("user_release");
  });

  it("degrades to unavailable rather than reporting an unverified entitlement", async () => {
    createAdminClient.mockImplementation(() => {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");
    });

    const response = await getAiItemEntitlement(
      authorized("/v1/entitlements/ai-items"),
    );

    expect(response.status).toBe(503);
    expect(entitlementFor).not.toHaveBeenCalled();
    expect(logServerError).toHaveBeenCalledWith(
      "mobile-api.subscription-bridge.compose",
      expect.any(Error),
    );
  });

  it("fails closed when the native Clerk boundary is unconfigured", async () => {
    delete process.env.CLERK_AUTHORIZED_PARTIES;

    const response = await getAiItemEntitlement(
      authorized("/v1/entitlements/ai-items"),
    );

    expect(response.status).toBe(401);
    expect(entitlementFor).not.toHaveBeenCalled();
  });
});
