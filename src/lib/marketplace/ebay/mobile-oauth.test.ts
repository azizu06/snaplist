import { describe, expect, it, vi } from "vitest";
import { createMobileApiHandler } from "@/lib/mobile-api/app";
import {
  createMobileEbayOauthOperations,
  type MobileEbayOauthSessionStore,
} from "./mobile-oauth";

const SESSION_ID = "67400000-0000-4000-8000-000000000001";
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

function activationFixture(
  overrides: Record<string, string | undefined> = {},
) {
  const env: Record<string, string | undefined> = {
    EBAY_BASE_URL: "https://api.sandbox.ebay.com",
    EBAY_CLIENT_ID: "mobile-client-id",
    EBAY_MOBILE_RU_NAME: "mobile-callback-ru-name",
    EBAY_TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
    EBAY_MOBILE_OAUTH_RETURN_URL:
      "https://snaplist.example/mobile/ebay/oauth",
    ...overrides,
  };
  const session = {
    sessionId: SESSION_ID,
    userId: "tenant_a",
    expiresAt: "2026-08-05T18:10:00.000Z",
  };
  const createOrReplaySession = vi.fn().mockResolvedValue(session);
  const finishSession = vi.fn(async (input: {
    outcome: "declined" | "cancelled" | "expired" | "failed";
  }) => ({ kind: "finished" as const, outcome: input.outcome }));
  const beginSession = vi.fn().mockResolvedValue({
    kind: "claimed" as const,
    leaseToken: "67400000-0000-4000-8000-000000000003",
  });
  const completeSession = vi.fn().mockResolvedValue({
    kind: "connected" as const,
  });
  const exchangeCode = vi.fn().mockResolvedValue({
    accessToken: "access-token",
    refreshToken: "refresh-token",
    accessTokenExpiresAt: Date.parse("2026-08-05T20:00:00.000Z"),
    scopes: ["https://api.ebay.com/oauth/api_scope/sell.inventory"],
  });
  const store: MobileEbayOauthSessionStore = {
    createOrReplaySession,
    async getSession(sessionId) {
      return sessionId === session.sessionId
        ? { ...session, status: "pending" as const }
        : null;
    },
    finishSession,
    beginSession,
    completeSession,
    async failSession() {
      return { kind: "finished" as const, outcome: "failed" as const };
    },
  };
  const operations = createMobileEbayOauthOperations({
    store,
    env: () => env,
    exchangeCode,
    fetchIdentity: vi.fn().mockResolvedValue({
      userId: "ebay-user-674",
      username: "seller_674",
    }),
    randomUUID: () => SESSION_ID,
  });
  const createSession = () => operations.createSession({
    userId: session.userId,
    bearerToken: "tenant-a-jwt",
    idempotencyKey: "67400000-0000-4000-8000-000000000002",
  });
  const completeCallback = (state: string, code: string | null = null) =>
    operations.completeCallback({
      state,
      code,
      error: null,
      errorDescription: null,
    });

  return {
    completeCallback,
    completeSession,
    createOrReplaySession,
    createSession,
    env,
    exchangeCode,
    finishSession,
    operations,
  };
}

function stateFrom(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) throw new Error("Expected OAuth state");
  return state;
}

describe("mobile eBay OAuth operator activation", () => {
  it.each([
    "https://api.sandbox.ebay.com",
    "https://API.SANDBOX.EBAY.COM:443/",
  ])(
    "allows exact Sandbox origin %s with the flag unset",
    async (baseUrl) => {
      const fixture = activationFixture({ EBAY_BASE_URL: baseUrl });

      const session = await fixture.createSession();
      const callback = await fixture.completeCallback(
        stateFrom(session.authorizationUrl),
      );

      expect(new URL(session.authorizationUrl).origin).toBe(
        "https://auth.sandbox.ebay.com",
      );
      expect(callback.redirectUrl).toBe(
        "https://snaplist.example/mobile/ebay/oauth?result=cancelled",
      );
      expect(fixture.finishSession).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["wrong case", "TRUE"],
    ["another value", "1"],
  ])(
    "refuses production session creation and callback completion when the flag is %s",
    async (_label, flag) => {
      const fixture = activationFixture();
      const sandboxSession = await fixture.createSession();
      fixture.env.EBAY_BASE_URL = "https://api.ebay.com";
      fixture.env.EBAY_PRODUCTION_MOBILE_ENABLED = flag;

      await expect(fixture.createSession()).rejects.toThrow(
        /EBAY_PRODUCTION_MOBILE_ENABLED/,
      );
      await expect(
        fixture.completeCallback(stateFrom(sandboxSession.authorizationUrl)),
      ).rejects.toThrow(/EBAY_PRODUCTION_MOBILE_ENABLED/);
      expect(fixture.createOrReplaySession).toHaveBeenCalledOnce();
      expect(fixture.finishSession).not.toHaveBeenCalled();
    },
  );

  it.each([
    "https://api.ebay.com",
    "https://API.EBAY.COM:443/",
  ])(
    "allows exact production origin %s only with the exact true flag",
    async (baseUrl) => {
      const fixture = activationFixture({
        EBAY_BASE_URL: baseUrl,
        EBAY_PRODUCTION_MOBILE_ENABLED: "true",
      });

      const session = await fixture.createSession();
      const callback = await fixture.completeCallback(
        stateFrom(session.authorizationUrl),
        "provider-code",
      );

      expect(new URL(session.authorizationUrl).origin).toBe(
        "https://auth.ebay.com",
      );
      expect(callback.redirectUrl).toBe(
        "https://snaplist.example/mobile/ebay/oauth?result=connected",
      );
      expect(fixture.exchangeCode).toHaveBeenCalledWith(
        "provider-code",
        expect.objectContaining({ EBAY_BASE_URL: "https://api.ebay.com" }),
      );
      expect(fixture.completeSession).toHaveBeenCalledOnce();
    },
  );

  it("returns a production authorization URL through the authenticated mobile HTTP seam", async () => {
    const fixture = activationFixture({
      EBAY_BASE_URL: "https://api.ebay.com",
      EBAY_PRODUCTION_MOBILE_ENABLED: "true",
    });
    const authenticate = vi.fn().mockResolvedValue({ userId: "tenant_a" });
    const api = createMobileApiHandler({
      authenticate,
      ebayOauth: fixture.operations,
      requestId: () => "request-674-production-oauth",
      worker: {
        consume: async () => ({
          acknowledged: 0,
          claimed: 0,
          failed: 0,
          retrying: 0,
          skipped: 0,
          succeeded: 0,
        }),
      },
    });

    const response = await api(
      new Request("http://localhost/v1/ebay/oauth/sessions", {
        method: "POST",
        headers: {
          authorization: "Bearer tenant-a-jwt",
          "idempotency-key": "67400000-0000-4000-8000-000000000004",
        },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(authenticate).toHaveBeenCalledWith("tenant-a-jwt");
    expect(new URL(body.data.authorizationUrl).origin).toBe(
      "https://auth.ebay.com",
    );
  });

  it.each([
    ["other origin", "https://api.sandbox.ebay.com.attacker.example"],
    ["non-root path", "https://api.ebay.com/identity"],
    ["query", "https://api.sandbox.ebay.com?mobile=true"],
    ["hash", "https://api.ebay.com#mobile"],
  ])(
    "refuses %s for session creation and callback completion even with production enabled",
    async (_label, baseUrl) => {
      const fixture = activationFixture();
      const sandboxSession = await fixture.createSession();
      fixture.env.EBAY_BASE_URL = baseUrl;
      fixture.env.EBAY_PRODUCTION_MOBILE_ENABLED = "true";

      await expect(fixture.createSession()).rejects.toThrow();
      await expect(
        fixture.completeCallback(stateFrom(sandboxSession.authorizationUrl)),
      ).resolves.toEqual({
        redirectUrl: "https://snaplist.example/mobile/ebay/oauth?result=failed",
      });
      expect(fixture.createOrReplaySession).toHaveBeenCalledOnce();
      expect(fixture.finishSession).not.toHaveBeenCalled();
    },
  );
});
