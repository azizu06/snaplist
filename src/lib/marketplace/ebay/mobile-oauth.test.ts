import { describe, expect, it, vi } from "vitest";
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
  const store: MobileEbayOauthSessionStore = {
    createOrReplaySession,
    async getSession(sessionId) {
      return sessionId === session.sessionId
        ? { ...session, status: "pending" as const }
        : null;
    },
    finishSession,
    async beginSession() {
      return { kind: "wrong_tenant" as const };
    },
    async completeSession() {
      return { kind: "wrong_tenant" as const };
    },
    async failSession() {
      return { kind: "finished" as const, outcome: "failed" as const };
    },
  };
  const operations = createMobileEbayOauthOperations({
    store,
    env: () => env,
    randomUUID: () => SESSION_ID,
  });
  const createSession = () => operations.createSession({
    userId: session.userId,
    bearerToken: "tenant-a-jwt",
    idempotencyKey: "67400000-0000-4000-8000-000000000002",
  });
  const completeCallback = (state: string) => operations.completeCallback({
    state,
    code: null,
    error: null,
    errorDescription: null,
  });

  return {
    completeCallback,
    createOrReplaySession,
    createSession,
    env,
    finishSession,
  };
}

function stateFrom(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) throw new Error("Expected OAuth state");
  return state;
}

describe("mobile eBay OAuth operator activation", () => {
  it("allows Sandbox session creation and callback completion with the flag unset", async () => {
    const fixture = activationFixture();

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
  });

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
      ).resolves.toEqual({
        redirectUrl: "https://snaplist.example/mobile/ebay/oauth?result=failed",
      });
      expect(fixture.createOrReplaySession).toHaveBeenCalledOnce();
      expect(fixture.finishSession).not.toHaveBeenCalled();
    },
  );

  it("allows production session creation and callback completion only with the exact true flag", async () => {
    const fixture = activationFixture({
      EBAY_BASE_URL: "https://api.ebay.com",
      EBAY_PRODUCTION_MOBILE_ENABLED: "true",
    });

    const session = await fixture.createSession();
    const callback = await fixture.completeCallback(
      stateFrom(session.authorizationUrl),
    );

    expect(new URL(session.authorizationUrl).origin).toBe(
      "https://auth.ebay.com",
    );
    expect(callback.redirectUrl).toBe(
      "https://snaplist.example/mobile/ebay/oauth?result=cancelled",
    );
    expect(fixture.finishSession).toHaveBeenCalledOnce();
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
