import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  verifyToken,
  createConfiguredMobileEbayOauthOperations,
  createSession,
  completeCallback,
} = vi.hoisted(() => ({
  verifyToken: vi.fn(),
  createConfiguredMobileEbayOauthOperations: vi.fn(),
  createSession: vi.fn(),
  completeCallback: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ verifyToken }));
vi.mock("@/lib/marketplace/ebay/mobile-oauth-store", () => ({
  createConfiguredMobileEbayOauthOperations,
}));

import { POST } from "./sessions/route";
import { GET } from "./callback/route";

const environmentKeys = [
  "CLERK_SECRET_KEY",
  "CLERK_AUTHORIZED_PARTIES",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

beforeEach(() => {
  process.env.CLERK_SECRET_KEY = "sk_test_release";
  process.env.CLERK_AUTHORIZED_PARTIES = "https://snaplist.example";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_release";
  verifyToken.mockResolvedValue({ sub: "tenant_release" });
  createSession.mockResolvedValue({
    sessionId: "38700000-0000-4000-8000-000000000081",
    authorizationUrl:
      "https://auth.sandbox.ebay.com/oauth2/authorize?state=signed-state",
    expiresAt: "2026-07-22T18:10:00.000Z",
  });
  completeCallback.mockResolvedValue({
    redirectUrl: "https://snaplist.example/mobile/ebay/oauth?result=declined",
  });
  createConfiguredMobileEbayOauthOperations.mockReturnValue({
    createSession,
    completeCallback,
  });
});

afterEach(() => {
  for (const key of environmentKeys) delete process.env[key];
  vi.clearAllMocks();
});

describe("production mobile eBay Sandbox OAuth routes", () => {
  it("verifies Clerk and binds the bearer to the configured OAuth session store", async () => {
    const response = await POST(
      new Request("https://snaplist.example/v1/ebay/oauth/sessions", {
        method: "POST",
        headers: {
          authorization: "Bearer signed-release-jwt",
          "idempotency-key": "38700000-0000-4000-8000-000000000082",
        },
      }),
    );

    expect(response.status).toBe(201);
    expect(verifyToken).toHaveBeenCalledWith("signed-release-jwt", {
      secretKey: "sk_test_release",
      authorizedParties: ["https://snaplist.example"],
    });
    expect(createConfiguredMobileEbayOauthOperations).toHaveBeenCalledWith({
      supabaseURL: "https://project.supabase.co",
      secretKey: "sb_secret_release",
    });
    expect(createSession).toHaveBeenCalledWith({
      userId: "tenant_release",
      bearerToken: "signed-release-jwt",
      idempotencyKey: "38700000-0000-4000-8000-000000000082",
    });
  });

  it("exposes the provider callback without requiring a native bearer", async () => {
    const response = await GET(
      new Request(
        "https://snaplist.example/v1/ebay/oauth/callback?state=signed-state&error=access_denied",
      ),
    );

    expect(response.status).toBe(303);
    expect(verifyToken).not.toHaveBeenCalled();
    expect(completeCallback).toHaveBeenCalledWith({
      state: "signed-state",
      code: null,
      error: "access_denied",
      errorDescription: null,
    });
  });
});
