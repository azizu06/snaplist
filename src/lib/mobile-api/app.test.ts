import { createHmac, hkdfSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createSupabaseNativeSubscriptionBridge } from "@/lib/billing/revenuecat-store";
import {
  GuestClaimIdempotencyConflictError,
  GuestClaimInProgressError,
} from "@/lib/guest-recovery/service";
import { buildPipelinePersistencePayload } from "@/lib/pipeline/persist";
import type { PipelineResult } from "@/lib/pipeline/types";
import { buildPricingEvidenceProjection } from "@/lib/pricing-evidence";
import { createMobileEbayOauthOperations } from "@/lib/marketplace/ebay/mobile-oauth";
import { MobileRunConflictError, MobileRunNotFoundError } from "./runs";
import { createMobileApiHandler } from "./app";

const summary = {
  claimed: 0,
  succeeded: 0,
  retrying: 0,
  failed: 0,
  skipped: 0,
};

const EBAY_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
const EBAY_OAUTH_SESSION_EXPIRES_AT = "2026-07-22T18:10:00.000Z";

function handler(overrides: Record<string, unknown> = {}) {
  return createMobileApiHandler({
    authenticate: vi.fn().mockResolvedValue({ userId: "user_smoke" }),
    verifyGuestClaimHandoff: vi.fn().mockResolvedValue({
      recoveryId: "11111111-1111-4111-8111-111111111111",
      guestUserId: "guest_fixture",
      recoveryTokenHash: "a".repeat(64),
    }),
    claimGuestRecovery: vi.fn().mockResolvedValue({
      outcome: "claimed",
      itemId: "22222222-2222-4222-8222-222222222222",
      runId: "33333333-3333-4333-8333-333333333333",
      draftId: "44444444-4444-4444-8444-444444444444",
      purgeLocalRecovery: true,
    }),
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

  it("creates one tenant-bound eBay Sandbox OAuth session through the authenticated mobile seam", async () => {
    const createSession = vi.fn().mockResolvedValue({
      sessionId: "38700000-0000-4000-8000-000000000001",
      authorizationUrl:
        "https://auth.sandbox.ebay.com/oauth2/authorize?state=opaque-state",
      expiresAt: "2026-07-22T18:10:00.000Z",
    });
    const authenticate = vi.fn().mockResolvedValue({ userId: "tenant_a" });

    const response = await handler({
      authenticate,
      ebayOauth: { createSession },
    })(
      new Request("http://localhost/v1/ebay/oauth/sessions", {
        method: "POST",
        headers: {
          authorization: "Bearer tenant-a-jwt",
          "idempotency-key": "38700000-0000-4000-8000-000000000002",
        },
      }),
    );

    expect(response.status).toBe(201);
    expect(authenticate).toHaveBeenCalledWith("tenant-a-jwt");
    expect(createSession).toHaveBeenCalledWith({
      userId: "tenant_a",
      bearerToken: "tenant-a-jwt",
      idempotencyKey: "38700000-0000-4000-8000-000000000002",
    });
    const body = await response.json();
    expect(body).toEqual({
      data: {
        sessionId: "38700000-0000-4000-8000-000000000001",
        authorizationUrl:
          "https://auth.sandbox.ebay.com/oauth2/authorize?state=opaque-state",
        expiresAt: "2026-07-22T18:10:00.000Z",
      },
      meta: { requestId: "req_test" },
    });
    expect(JSON.stringify(body)).not.toMatch(/accessToken|refreshToken|authorizationCode/);
  });

  it("uses the persistence clock for OAuth session expiry when the app clock disagrees", async () => {
    const dbExpiresAt = "2026-07-22T18:10:00.000Z";
    const createOrReplaySession = vi.fn(async (input: {
      proposedSessionId: string;
      userId: string;
      bearerToken: string;
      idempotencyKey: string;
    }) => {
      expect(input).not.toHaveProperty("expiresAt");
      return {
        sessionId: input.proposedSessionId,
        userId: input.userId,
        expiresAt: dbExpiresAt,
      };
    });
    const ebayOauth = createMobileEbayOauthOperations({
      store: {
        createOrReplaySession,
        async getSession() {
          return null;
        },
        async finishSession(input) {
          return { kind: "finished" as const, outcome: input.outcome };
        },
        async beginSession() {
          return { kind: "wrong_tenant" as const };
        },
        async completeSession() {
          return { kind: "wrong_tenant" as const };
        },
        async failSession() {
          return undefined;
        },
      },
      env: () => ({
        EBAY_CLIENT_ID: "sandbox-client-id",
        EBAY_RU_NAME: "sandbox-ru-name",
        EBAY_TOKEN_ENCRYPTION_KEY,
      }),
      now: () => Date.parse("2099-01-01T00:00:00.000Z"),
      randomUUID: () => "38700000-0000-4000-8000-000000000003",
    });

    const response = await handler({
      authenticate: vi.fn().mockResolvedValue({ userId: "tenant_a" }),
      ebayOauth,
    })(
      new Request("http://localhost/v1/ebay/oauth/sessions", {
        method: "POST",
        headers: {
          authorization: "Bearer tenant-a-jwt",
          "idempotency-key": "38700000-0000-4000-8000-000000000004",
        },
      }),
    );

    expect(response.status).toBe(201);
    expect((await response.json()).data.expiresAt).toBe(dbExpiresAt);
  });

  it("replays the original eBay OAuth session for the same tenant idempotency key", async () => {
    const rows = new Map<
      string,
      { sessionId: string; userId: string; expiresAt: string }
    >();
    const createOrReplaySession = vi.fn(async (input: {
      proposedSessionId: string;
      userId: string;
      idempotencyKey: string;
    }) => {
      const key = `${input.userId}:${input.idempotencyKey}`;
      const existing = rows.get(key);
      if (existing) return existing;
      const created = {
        sessionId: input.proposedSessionId,
        userId: input.userId,
        expiresAt: EBAY_OAUTH_SESSION_EXPIRES_AT,
      };
      rows.set(key, created);
      return created;
    });
    const generatedIds = [
      "38700000-0000-4000-8000-000000000011",
      "38700000-0000-4000-8000-000000000012",
    ];
    const ebayOauth = createMobileEbayOauthOperations({
      store: {
        createOrReplaySession,
        async getSession() {
          return null;
        },
        async finishSession(input) {
          return { kind: "finished" as const, outcome: input.outcome };
        },
        async beginSession() {
          return { kind: "wrong_tenant" as const };
        },
        async completeSession() {
          return { kind: "wrong_tenant" as const };
        },
        async failSession() {
          return undefined;
        },
      },
      env: () => ({
        EBAY_CLIENT_ID: "sandbox-client-id",
        EBAY_RU_NAME: "sandbox-ru-name",
        EBAY_TOKEN_ENCRYPTION_KEY,
      }),
      now: () => Date.parse("2026-07-22T18:00:00.000Z"),
      randomUUID: () => generatedIds.shift()!,
    });
    const create = handler({
      authenticate: vi.fn().mockResolvedValue({ userId: "tenant_a" }),
      ebayOauth,
    });
    const request = () =>
      new Request("http://localhost/v1/ebay/oauth/sessions", {
        method: "POST",
        headers: {
          authorization: "Bearer tenant-a-jwt",
          "idempotency-key": "38700000-0000-4000-8000-000000000013",
        },
      });

    const first = await create(request());
    const replay = await create(request());

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(await first.json());
    expect(rows).toHaveLength(1);
    expect(createOrReplaySession).toHaveBeenCalledTimes(2);
  });

  it("replays the durable decline even when a later callback proposes cancellation", async () => {
    const rows = new Map<
      string,
      { sessionId: string; userId: string; expiresAt: string }
    >();
    let durableOutcome: "declined" | "cancelled" | "expired" | "failed" | null = null;
    const finishSession = vi.fn(async (input: {
      sessionId: string;
      userId: string;
      outcome: "declined" | "cancelled" | "expired" | "failed";
    }) => {
      const row = rows.get(input.sessionId);
      if (!row || row.userId !== input.userId) return { kind: "wrong_tenant" as const };
      if (durableOutcome) {
        return { kind: "replayed" as const, outcome: durableOutcome };
      }
      durableOutcome = input.outcome;
      return { kind: "finished" as const, outcome: durableOutcome };
    });
    const ebayOauth = createMobileEbayOauthOperations({
      store: {
        async createOrReplaySession(input) {
          const row = {
            sessionId: input.proposedSessionId,
            userId: input.userId,
            expiresAt: EBAY_OAUTH_SESSION_EXPIRES_AT,
          };
          rows.set(row.sessionId, row);
          return row;
        },
        async getSession(sessionId) {
          return rows.get(sessionId) ?? null;
        },
        finishSession,
        async beginSession() {
          return { kind: "wrong_tenant" as const };
        },
        async completeSession() {
          return { kind: "wrong_tenant" as const };
        },
        async failSession() {
          return undefined;
        },
      },
      env: () => ({
        EBAY_CLIENT_ID: "sandbox-client-id",
        EBAY_RU_NAME: "sandbox-ru-name",
        EBAY_TOKEN_ENCRYPTION_KEY,
        EBAY_MOBILE_OAUTH_RETURN_URL:
          "https://snaplist.example/mobile/ebay/oauth",
      }),
      now: () => Date.parse("2026-07-22T18:00:00.000Z"),
      randomUUID: () => "38700000-0000-4000-8000-000000000021",
    });
    const api = handler({
      authenticate: vi.fn().mockResolvedValue({ userId: "tenant_a" }),
      ebayOauth,
    });
    const sessionResponse = await api(
      new Request("http://localhost/v1/ebay/oauth/sessions", {
        method: "POST",
        headers: {
          authorization: "Bearer tenant-a-jwt",
          "idempotency-key": "38700000-0000-4000-8000-000000000022",
        },
      }),
    );
    const sessionBody = await sessionResponse.json();
    const state = new URL(sessionBody.data.authorizationUrl).searchParams.get(
      "state",
    );

    const response = await api(
      new Request(
        `http://localhost/v1/ebay/oauth/callback?state=${encodeURIComponent(state!)}&error=access_denied`,
      ),
    );
    const conflictingReplay = await api(
      new Request(
        `http://localhost/v1/ebay/oauth/callback?state=${encodeURIComponent(state!)}`,
      ),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://snaplist.example/mobile/ebay/oauth?result=declined",
    );
    expect(conflictingReplay.status).toBe(303);
    expect(conflictingReplay.headers.get("location")).toBe(
      "https://snaplist.example/mobile/ebay/oauth?result=declined",
    );
    expect(finishSession).toHaveBeenCalledWith({
      sessionId: "38700000-0000-4000-8000-000000000021",
      userId: "tenant_a",
      outcome: "declined",
      finishedAt: "2026-07-22T18:00:00.000Z",
    });
    expect(JSON.stringify(response.headers)).not.toMatch(
      /accessToken|refreshToken|authorizationCode|access_denied/,
    );
  });

  it("finishes a cancelled eBay callback explicitly before any token exchange", async () => {
    const rows = new Map<
      string,
      { sessionId: string; userId: string; expiresAt: string }
    >();
    const finishSession = vi.fn(async (input: {
      outcome: "declined" | "cancelled" | "expired" | "failed";
    }) => ({ kind: "finished" as const, outcome: input.outcome }));
    const ebayOauth = createMobileEbayOauthOperations({
      store: {
        async createOrReplaySession(input) {
          const row = {
            sessionId: input.proposedSessionId,
            userId: input.userId,
            expiresAt: EBAY_OAUTH_SESSION_EXPIRES_AT,
          };
          rows.set(row.sessionId, row);
          return row;
        },
        async getSession(sessionId) {
          return rows.get(sessionId) ?? null;
        },
        finishSession,
        async beginSession() {
          return { kind: "wrong_tenant" as const };
        },
        async completeSession() {
          return { kind: "wrong_tenant" as const };
        },
        async failSession() {
          return undefined;
        },
      },
      env: () => ({
        EBAY_CLIENT_ID: "sandbox-client-id",
        EBAY_RU_NAME: "sandbox-ru-name",
        EBAY_TOKEN_ENCRYPTION_KEY,
        EBAY_MOBILE_OAUTH_RETURN_URL:
          "https://snaplist.example/mobile/ebay/oauth",
      }),
      now: () => Date.parse("2026-07-22T18:00:00.000Z"),
      randomUUID: () => "38700000-0000-4000-8000-000000000031",
    });
    const api = handler({
      authenticate: vi.fn().mockResolvedValue({ userId: "tenant_a" }),
      ebayOauth,
    });
    const session = await api(
      new Request("http://localhost/v1/ebay/oauth/sessions", {
        method: "POST",
        headers: {
          authorization: "Bearer tenant-a-jwt",
          "idempotency-key": "38700000-0000-4000-8000-000000000032",
        },
      }),
    );
    const state = new URL(
      (await session.json()).data.authorizationUrl,
    ).searchParams.get("state");

    const response = await api(
      new Request(
        `http://localhost/v1/ebay/oauth/callback?state=${encodeURIComponent(state!)}`,
      ),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://snaplist.example/mobile/ebay/oauth?result=cancelled",
    );
    expect(finishSession).toHaveBeenCalledWith({
      sessionId: "38700000-0000-4000-8000-000000000031",
      userId: "tenant_a",
      outcome: "cancelled",
      finishedAt: "2026-07-22T18:00:00.000Z",
    });
  });

  it("consumes a valid state once when eBay returns a non-decline provider failure", async () => {
    const rows = new Map<
      string,
      { sessionId: string; userId: string; expiresAt: string }
    >();
    const finishSession = vi.fn(async (input: {
      outcome: "declined" | "cancelled" | "expired" | "failed";
    }) => ({ kind: "finished" as const, outcome: input.outcome }));
    const exchangeCode = vi.fn();
    const ebayOauth = createMobileEbayOauthOperations({
      store: {
        async createOrReplaySession(input) {
          const row = {
            sessionId: input.proposedSessionId,
            userId: input.userId,
            expiresAt: EBAY_OAUTH_SESSION_EXPIRES_AT,
          };
          rows.set(row.sessionId, row);
          return row;
        },
        async getSession(sessionId) {
          return rows.get(sessionId) ?? null;
        },
        finishSession,
        async beginSession() {
          return { kind: "wrong_tenant" as const };
        },
        async completeSession() {
          return { kind: "wrong_tenant" as const };
        },
        async failSession() {
          return undefined;
        },
      },
      env: () => ({
        EBAY_CLIENT_ID: "sandbox-client-id",
        EBAY_RU_NAME: "sandbox-ru-name",
        EBAY_TOKEN_ENCRYPTION_KEY,
        EBAY_MOBILE_OAUTH_RETURN_URL:
          "https://snaplist.example/mobile/ebay/oauth",
      }),
      now: () => Date.parse("2026-07-22T18:00:00.000Z"),
      randomUUID: () => "38700000-0000-4000-8000-000000000033",
      exchangeCode,
    });
    const api = handler({
      authenticate: vi.fn().mockResolvedValue({ userId: "tenant_a" }),
      ebayOauth,
    });
    const session = await api(
      new Request("http://localhost/v1/ebay/oauth/sessions", {
        method: "POST",
        headers: {
          authorization: "Bearer tenant-a-jwt",
          "idempotency-key": "38700000-0000-4000-8000-000000000034",
        },
      }),
    );
    const state = new URL(
      (await session.json()).data.authorizationUrl,
    ).searchParams.get("state")!;

    const response = await api(
      new Request(
        `http://localhost/v1/ebay/oauth/callback?state=${encodeURIComponent(state)}&error=temporarily_unavailable`,
      ),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://snaplist.example/mobile/ebay/oauth?result=failed",
    );
    expect(finishSession).toHaveBeenCalledWith({
      sessionId: "38700000-0000-4000-8000-000000000033",
      userId: "tenant_a",
      outcome: "failed",
      finishedAt: "2026-07-22T18:00:00.000Z",
    });
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("rejects an expired eBay OAuth session before trusting the authorization code", async () => {
    const rows = new Map<
      string,
      { sessionId: string; userId: string; expiresAt: string }
    >();
    const finishSession = vi.fn(async (input: {
      outcome: "declined" | "cancelled" | "expired" | "failed";
    }) => ({ kind: "finished" as const, outcome: input.outcome }));
    const beginSession = vi.fn().mockResolvedValue({ kind: "expired" as const });
    const exchangeCode = vi.fn();
    const ebayOauth = createMobileEbayOauthOperations({
      store: {
        async createOrReplaySession(input) {
          const row = {
            sessionId: input.proposedSessionId,
            userId: input.userId,
            expiresAt: EBAY_OAUTH_SESSION_EXPIRES_AT,
          };
          rows.set(row.sessionId, row);
          return row;
        },
        async getSession(sessionId) {
          return rows.get(sessionId) ?? null;
        },
        finishSession,
        beginSession,
        async completeSession() {
          return { kind: "wrong_tenant" as const };
        },
        async failSession() {
          return undefined;
        },
      },
      env: () => ({
        EBAY_CLIENT_ID: "sandbox-client-id",
        EBAY_RU_NAME: "sandbox-ru-name",
        EBAY_TOKEN_ENCRYPTION_KEY,
        EBAY_MOBILE_OAUTH_RETURN_URL:
          "https://snaplist.example/mobile/ebay/oauth",
      }),
      now: () => Date.parse("2026-07-22T18:20:00.000Z"),
      randomUUID: () => "38700000-0000-4000-8000-000000000041",
      exchangeCode,
    });
    const api = handler({
      authenticate: vi.fn().mockResolvedValue({ userId: "tenant_a" }),
      ebayOauth,
    });
    const session = await api(
      new Request("http://localhost/v1/ebay/oauth/sessions", {
        method: "POST",
        headers: {
          authorization: "Bearer tenant-a-jwt",
          "idempotency-key": "38700000-0000-4000-8000-000000000042",
        },
      }),
    );
    const state = new URL(
      (await session.json()).data.authorizationUrl,
    ).searchParams.get("state");
    const response = await api(
      new Request(
        `http://localhost/v1/ebay/oauth/callback?state=${encodeURIComponent(state!)}&code=provider-code`,
      ),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://snaplist.example/mobile/ebay/oauth?result=expired",
    );
    expect(beginSession).toHaveBeenCalledWith({
      sessionId: "38700000-0000-4000-8000-000000000041",
      userId: "tenant_a",
      startedAt: "2026-07-22T18:20:00.000Z",
    });
    expect(finishSession).not.toHaveBeenCalled();
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("verifies state authenticity before reporting a valid cross-tenant binding", async () => {
    const rows = new Map<
      string,
      { sessionId: string; userId: string; expiresAt: string }
    >();
    const byIdempotency = new Map<string, string>();
    const finishSession = vi.fn(async (input: {
      outcome: "declined" | "cancelled" | "expired" | "failed";
    }) => ({ kind: "finished" as const, outcome: input.outcome }));
    const generatedIds = [
      "38700000-0000-4000-8000-000000000051",
      "38700000-0000-4000-8000-000000000052",
    ];
    const getSession = vi.fn(async (sessionId: string) =>
      rows.get(sessionId) ?? null);
    const ebayOauth = createMobileEbayOauthOperations({
      store: {
        async createOrReplaySession(input) {
          const replayId = byIdempotency.get(
            `${input.userId}:${input.idempotencyKey}`,
          );
          if (replayId) return rows.get(replayId)!;
          const row = {
            sessionId: input.proposedSessionId,
            userId: input.userId,
            expiresAt: EBAY_OAUTH_SESSION_EXPIRES_AT,
          };
          rows.set(row.sessionId, row);
          byIdempotency.set(
            `${input.userId}:${input.idempotencyKey}`,
            row.sessionId,
          );
          return row;
        },
        getSession,
        finishSession,
        async beginSession() {
          return { kind: "wrong_tenant" as const };
        },
        async completeSession() {
          return { kind: "wrong_tenant" as const };
        },
        async failSession() {
          return undefined;
        },
      },
      env: () => ({
        EBAY_CLIENT_ID: "sandbox-client-id",
        EBAY_RU_NAME: "sandbox-ru-name",
        EBAY_TOKEN_ENCRYPTION_KEY,
        EBAY_MOBILE_OAUTH_RETURN_URL:
          "https://snaplist.example/mobile/ebay/oauth",
      }),
      now: () => Date.parse("2026-07-22T18:00:00.000Z"),
      randomUUID: () => generatedIds.shift()!,
    });
    const api = handler({
      authenticate: vi.fn(async (token: string) => ({
        userId: token === "tenant-a-jwt" ? "tenant_a" : "tenant_b",
      })),
      ebayOauth,
    });
    const start = async (token: string) => {
      const response = await api(
        new Request("http://localhost/v1/ebay/oauth/sessions", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "idempotency-key": "38700000-0000-4000-8000-000000000053",
          },
        }),
      );
      return new URL(
        (await response.json()).data.authorizationUrl,
      ).searchParams.get("state")!;
    };
    const tenantAState = await start("tenant-a-jwt");
    const tenantBState = await start("tenant-b-jwt");
    const tenantAParts = tenantAState.split(".");
    const tenantBParts = tenantBState.split(".");
    const mixedPayload = [
      tenantAParts[0],
      tenantAParts[1],
      tenantBParts[2],
    ].join(".");
    const stateKey = Buffer.from(hkdfSync(
      "sha256",
      Buffer.from(EBAY_TOKEN_ENCRYPTION_KEY, "base64"),
      Buffer.alloc(0),
      Buffer.from("snaplist:ebay-mobile-oauth-state:v1"),
      32,
    ));
    const mixedState = `${mixedPayload}.${createHmac("sha256", stateKey)
      .update(mixedPayload)
      .digest("base64url")}`;

    const malformed = await api(
      new Request(
        "http://localhost/v1/ebay/oauth/callback?state=v1.not-a-uuid.binding.signature&code=provider-code",
      ),
    );
    const forged = await api(
      new Request(
        `http://localhost/v1/ebay/oauth/callback?state=${encodeURIComponent(`${mixedPayload}.forged-signature`)}&code=provider-code`,
      ),
    );

    expect(malformed.status).toBe(303);
    expect(malformed.headers.get("location")).toBe(
      "https://snaplist.example/mobile/ebay/oauth?result=invalid_state",
    );
    expect(forged.status).toBe(303);
    expect(forged.headers.get("location")).toBe(
      "https://snaplist.example/mobile/ebay/oauth?result=invalid_state",
    );
    expect(getSession).not.toHaveBeenCalled();

    const response = await api(
      new Request(
        `http://localhost/v1/ebay/oauth/callback?state=${encodeURIComponent(mixedState)}&code=provider-code`,
      ),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://snaplist.example/mobile/ebay/oauth?result=wrong_tenant",
    );
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(finishSession).not.toHaveBeenCalled();
  });

  it("lets the DB callback lease own expiry when the app clock is fast", async () => {
    type Row = {
      sessionId: string;
      userId: string;
      expiresAt: string;
      status: "pending" | "completing" | "connected";
    };
    const rows = new Map<string, Row>();
    const connections = new Map<
      string,
      { refreshTokenEnc: string; accessTokenEnc: string }
    >();
    const exchangeCode = vi.fn().mockResolvedValue({
      accessToken: "access-secret-387",
      refreshToken: "refresh-secret-387",
      accessTokenExpiresAt: Date.parse("2026-07-22T20:00:00.000Z"),
      scopes: ["https://api.ebay.com/oauth/api_scope/sell.inventory"],
    });
    const fetchIdentity = vi.fn().mockResolvedValue({
      userId: "ebay-sandbox-user-387",
      username: "sandbox_seller_387",
    });
    const completeSession = vi.fn(async (input: {
      sessionId: string;
      userId: string;
      refreshTokenEnc: string;
      accessTokenEnc: string;
    }) => {
      const row = rows.get(input.sessionId)!;
      row.status = "connected";
      connections.set(input.userId, {
        refreshTokenEnc: input.refreshTokenEnc,
        accessTokenEnc: input.accessTokenEnc,
      });
      return { kind: "connected" as const };
    });
    const ebayOauth = createMobileEbayOauthOperations({
      store: {
        async createOrReplaySession(input) {
          const row: Row = {
            sessionId: input.proposedSessionId,
            userId: input.userId,
            expiresAt: EBAY_OAUTH_SESSION_EXPIRES_AT,
            status: "pending",
          };
          rows.set(row.sessionId, row);
          return row;
        },
        async getSession(sessionId) {
          return rows.get(sessionId) ?? null;
        },
        async finishSession(input) {
          return { kind: "finished" as const, outcome: input.outcome };
        },
        async beginSession(input: { sessionId: string; userId: string }) {
          const row = rows.get(input.sessionId)!;
          if (row.userId !== input.userId) return { kind: "wrong_tenant" as const };
          if (row.status === "connected") {
            return { kind: "replayed" as const, outcome: "connected" as const };
          }
          row.status = "completing";
          return {
            kind: "claimed" as const,
            leaseToken: "38700000-0000-4000-8000-000000000063",
          };
        },
        completeSession,
        async failSession() {
          return undefined;
        },
      },
      env: () => ({
        EBAY_CLIENT_ID: "sandbox-client-id",
        EBAY_CLIENT_SECRET: "sandbox-client-secret",
        EBAY_RU_NAME: "sandbox-ru-name",
        EBAY_TOKEN_ENCRYPTION_KEY,
        EBAY_MOBILE_OAUTH_RETURN_URL:
          "https://snaplist.example/mobile/ebay/oauth",
      }),
      now: () => Date.parse("2026-07-22T18:20:00.000Z"),
      randomUUID: () => "38700000-0000-4000-8000-000000000061",
      exchangeCode,
      fetchIdentity,
    });
    const reportError = vi.fn();
    const api = handler({
      authenticate: vi.fn().mockResolvedValue({ userId: "tenant_a" }),
      ebayOauth,
      reportError,
    });
    const session = await api(
      new Request("http://localhost/v1/ebay/oauth/sessions", {
        method: "POST",
        headers: {
          authorization: "Bearer tenant-a-jwt",
          "idempotency-key": "38700000-0000-4000-8000-000000000062",
        },
      }),
    );
    const state = new URL(
      (await session.json()).data.authorizationUrl,
    ).searchParams.get("state");
    const callback = () =>
      api(
        new Request(
          `http://localhost/v1/ebay/oauth/callback?state=${encodeURIComponent(state!)}&code=sandbox-provider-code`,
        ),
      );

    const first = await callback();
    const replay = await callback();

    expect(first.status).toBe(303);
    expect(replay.status).toBe(303);
    expect(first.headers.get("location")).toBe(
      "https://snaplist.example/mobile/ebay/oauth?result=connected",
    );
    expect(replay.headers.get("location")).toBe(
      "https://snaplist.example/mobile/ebay/oauth?result=connected",
    );
    expect(exchangeCode).toHaveBeenCalledTimes(1);
    expect(exchangeCode).toHaveBeenCalledWith(
      "sandbox-provider-code",
      expect.objectContaining({
        EBAY_CLIENT_ID: "sandbox-client-id",
      }),
    );
    expect(fetchIdentity).toHaveBeenCalledTimes(1);
    expect(completeSession).toHaveBeenCalledTimes(1);
    expect(connections).toHaveLength(1);
    const stored = connections.get("tenant_a")!;
    expect(stored.refreshTokenEnc).toMatch(/^v1\./);
    expect(stored.accessTokenEnc).toMatch(/^v1\./);
    expect(JSON.stringify(stored)).not.toContain("refresh-secret-387");
    expect(JSON.stringify(stored)).not.toContain("access-secret-387");
    expect(JSON.stringify([
      first.headers.get("location"),
      replay.headers.get("location"),
      reportError.mock.calls,
    ])).not.toMatch(/sandbox-provider-code|refresh-secret-387|access-secret-387/);
  });

  it("refuses to create the mobile OAuth session when eBay is configured for production", async () => {
    const createOrReplaySession = vi.fn();
    const ebayOauth = createMobileEbayOauthOperations({
      store: {
        createOrReplaySession,
        async getSession() {
          return null;
        },
        async finishSession(input) {
          return { kind: "finished" as const, outcome: input.outcome };
        },
        async beginSession() {
          return { kind: "wrong_tenant" as const };
        },
        async completeSession() {
          return { kind: "wrong_tenant" as const };
        },
        async failSession() {
          return undefined;
        },
      },
      env: () => ({
        EBAY_BASE_URL: "https://api.ebay.com",
        EBAY_CLIENT_ID: "production-client-id",
        EBAY_RU_NAME: "production-ru-name",
        EBAY_TOKEN_ENCRYPTION_KEY,
        EBAY_MOBILE_OAUTH_RETURN_URL:
          "https://snaplist.example/mobile/ebay/oauth",
      }),
      randomUUID: () => "38700000-0000-4000-8000-000000000071",
    });
    const api = handler({
      authenticate: vi.fn().mockResolvedValue({ userId: "tenant_a" }),
      ebayOauth,
    });

    const response = await api(
      new Request("http://localhost/v1/ebay/oauth/sessions", {
        method: "POST",
        headers: {
          authorization: "Bearer tenant-a-jwt",
          "idempotency-key": "38700000-0000-4000-8000-000000000072",
        },
      }),
    );

    expect(response.status).toBe(503);
    expect(createOrReplaySession).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toMatch(
      /api\.ebay\.com|production-client-id|production-ru-name/,
    );
  });

  it("refuses a callback if the OAuth capability is no longer configured for Sandbox", async () => {
    const rows = new Map<
      string,
      { sessionId: string; userId: string; expiresAt: string }
    >();
    const exchangeCode = vi.fn();
    const completeSession = vi.fn();
    const env = {
      EBAY_BASE_URL: "https://api.sandbox.ebay.com",
      EBAY_CLIENT_ID: "sandbox-client-id",
      EBAY_CLIENT_SECRET: "sandbox-client-secret",
      EBAY_RU_NAME: "sandbox-ru-name",
      EBAY_TOKEN_ENCRYPTION_KEY,
      EBAY_MOBILE_OAUTH_RETURN_URL:
        "https://snaplist.example/mobile/ebay/oauth",
    };
    const ebayOauth = createMobileEbayOauthOperations({
      store: {
        async createOrReplaySession(input) {
          const row = {
            sessionId: input.proposedSessionId,
            userId: input.userId,
            expiresAt: EBAY_OAUTH_SESSION_EXPIRES_AT,
          };
          rows.set(row.sessionId, row);
          return row;
        },
        async getSession(sessionId) {
          return rows.get(sessionId) ?? null;
        },
        async finishSession(input) {
          return { kind: "finished" as const, outcome: input.outcome };
        },
        async beginSession() {
          return {
            kind: "claimed" as const,
            leaseToken: "38700000-0000-4000-8000-000000000073",
          };
        },
        completeSession,
        async failSession() {
          return undefined;
        },
      },
      env: () => env,
      now: () => Date.parse("2026-07-22T18:00:00.000Z"),
      randomUUID: () => "38700000-0000-4000-8000-000000000074",
      exchangeCode,
    });
    const api = handler({
      authenticate: vi.fn().mockResolvedValue({ userId: "tenant_a" }),
      ebayOauth,
    });
    const session = await api(
      new Request("http://localhost/v1/ebay/oauth/sessions", {
        method: "POST",
        headers: {
          authorization: "Bearer tenant-a-jwt",
          "idempotency-key": "38700000-0000-4000-8000-000000000075",
        },
      }),
    );
    const state = new URL(
      (await session.json()).data.authorizationUrl,
    ).searchParams.get("state");
    env.EBAY_BASE_URL = "https://api.ebay.com";

    const response = await api(
      new Request(
        `http://localhost/v1/ebay/oauth/callback?state=${encodeURIComponent(state!)}&code=provider-code`,
      ),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://snaplist.example/mobile/ebay/oauth?result=failed",
    );
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(completeSession).not.toHaveBeenCalled();
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
            destination: null,
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

  it("returns one authenticated tenant-owned durable run through the provider-neutral seam", async () => {
    const get = vi.fn().mockResolvedValue({
      id: "24100000-0000-4000-8000-000000000001",
      itemId: "24100000-0000-4000-8000-000000000002",
      listingId: null,
      status: "running",
      stage: "pricing",
      attemptCount: 1,
      maxAttempts: 3,
      schemaVersion: 1,
      timestamps: {
        createdAt: "2026-07-19T18:00:00.000Z",
        updatedAt: "2026-07-19T18:01:00.000Z",
        enqueuedAt: "2026-07-19T18:00:01.000Z",
        startedAt: "2026-07-19T18:00:10.000Z",
        lastAttemptedAt: "2026-07-19T18:00:10.000Z",
        nextAttemptAt: null,
        completedAt: null,
        retentionCleanedAt: null,
      },
      requiredInput: null,
      terminalOutcome: null,
      safeFailure: null,
      allowance: "reserved",
      legalActions: {
        canRetry: false,
        canCancel: true,
        canOpenReview: false,
        canStartNewCapture: false,
      },
      lastMeaningfulUpdateAt: "2026-07-19T18:01:00.000Z",
      retentionCleanedAt: null,
    });
    const authenticate = vi.fn().mockResolvedValue({ userId: "user_native" });

    const response = await handler({
      authenticate,
      runOperations: { get, retry: vi.fn(), cancel: vi.fn() },
    })(
      new Request(
        "http://localhost/v1/runs/24100000-0000-4000-8000-000000000001",
        { headers: { authorization: "Bearer signed-jwt" } },
      ),
    );

    expect(response.status).toBe(200);
    expect(authenticate).toHaveBeenCalledWith("signed-jwt");
    expect(get).toHaveBeenCalledWith({
      runId: "24100000-0000-4000-8000-000000000001",
      userId: "user_native",
      bearerToken: "signed-jwt",
    });
    await expect(response.json()).resolves.toMatchObject({
      data: { status: "running", stage: "pricing" },
      meta: { requestId: "req_test" },
    });
  });

  it("retries the same logical run with the caller's stable idempotency key", async () => {
    const retry = vi.fn().mockResolvedValue({
      id: "24100000-0000-4000-8000-000000000001",
      itemId: "24100000-0000-4000-8000-000000000002",
      listingId: null,
      status: "queued",
      stage: "queued",
      attemptCount: 3,
      maxAttempts: 6,
      schemaVersion: 1,
      timestamps: {
        createdAt: "2026-07-19T18:00:00.000Z",
        updatedAt: "2026-07-19T18:02:00.000Z",
        enqueuedAt: "2026-07-19T18:02:00.000Z",
        startedAt: "2026-07-19T18:00:10.000Z",
        lastAttemptedAt: "2026-07-19T18:00:10.000Z",
        nextAttemptAt: null,
        completedAt: null,
        retentionCleanedAt: null,
      },
      requiredInput: null,
      terminalOutcome: null,
      safeFailure: null,
      allowance: "reserved",
      legalActions: {
        canRetry: false,
        canCancel: true,
        canOpenReview: false,
        canStartNewCapture: false,
      },
      lastMeaningfulUpdateAt: "2026-07-19T18:02:00.000Z",
      retentionCleanedAt: null,
    });

    const response = await handler({
      authenticate: vi.fn().mockResolvedValue({ userId: "user_native" }),
      runOperations: { get: vi.fn(), retry, cancel: vi.fn() },
    })(
      new Request(
        "http://localhost/v1/runs/24100000-0000-4000-8000-000000000001/retry",
        {
          method: "POST",
          headers: {
            authorization: "Bearer signed-jwt",
            "idempotency-key": "24100000-0000-4000-8000-000000000003",
          },
        },
      ),
    );

    expect(response.status).toBe(202);
    expect(retry).toHaveBeenCalledWith({
      runId: "24100000-0000-4000-8000-000000000001",
      userId: "user_native",
      bearerToken: "signed-jwt",
      idempotencyKey: "24100000-0000-4000-8000-000000000003",
    });
    await expect(response.json()).resolves.toMatchObject({
      data: { id: "24100000-0000-4000-8000-000000000001", status: "queued" },
      meta: { requestId: "req_test" },
    });
  });

  it("cancels the same logical run and returns only the confirmed terminal truth", async () => {
    const cancel = vi.fn().mockResolvedValue({
      id: "24100000-0000-4000-8000-000000000001",
      itemId: "24100000-0000-4000-8000-000000000002",
      listingId: null,
      status: "canceled",
      stage: "pricing",
      attemptCount: 1,
      maxAttempts: 3,
      schemaVersion: 1,
      timestamps: {
        createdAt: "2026-07-19T18:00:00.000Z",
        updatedAt: "2026-07-19T18:03:00.000Z",
        enqueuedAt: null,
        startedAt: "2026-07-19T18:00:10.000Z",
        lastAttemptedAt: "2026-07-19T18:00:10.000Z",
        nextAttemptAt: null,
        completedAt: "2026-07-19T18:03:00.000Z",
        retentionCleanedAt: null,
      },
      requiredInput: null,
      terminalOutcome: "canceled",
      safeFailure: null,
      allowance: "restored",
      legalActions: {
        canRetry: true,
        canCancel: false,
        canOpenReview: false,
        canStartNewCapture: false,
      },
      lastMeaningfulUpdateAt: "2026-07-19T18:03:00.000Z",
      retentionCleanedAt: null,
    });

    const response = await handler({
      authenticate: vi.fn().mockResolvedValue({ userId: "user_native" }),
      runOperations: { get: vi.fn(), retry: vi.fn(), cancel },
    })(
      new Request(
        "http://localhost/v1/runs/24100000-0000-4000-8000-000000000001/cancel",
        {
          method: "POST",
          headers: {
            authorization: "Bearer signed-jwt",
            "idempotency-key": "24100000-0000-4000-8000-000000000004",
          },
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(cancel).toHaveBeenCalledWith({
      runId: "24100000-0000-4000-8000-000000000001",
      userId: "user_native",
      bearerToken: "signed-jwt",
      idempotencyKey: "24100000-0000-4000-8000-000000000004",
    });
    await expect(response.json()).resolves.toMatchObject({
      data: { status: "canceled", terminalOutcome: "canceled", allowance: "restored" },
      meta: { requestId: "req_test" },
    });
  });

  it("hides missing and cross-tenant mutation targets behind the same not-found envelope", async () => {
    const response = await handler({
      runOperations: {
        get: vi.fn(),
        retry: vi.fn().mockRejectedValue(new MobileRunNotFoundError()),
        cancel: vi.fn(),
      },
    })(
      new Request(
        "http://localhost/v1/runs/24100000-0000-4000-8000-000000000001/retry",
        {
          method: "POST",
          headers: {
            authorization: "Bearer signed-jwt",
            "idempotency-key": "24100000-0000-4000-8000-000000000003",
          },
        },
      ),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "not_found",
        message: "This run is unavailable.",
        requestId: "req_test",
      },
    });
  });

  it("maps stale or illegal durable-run transitions to a stable conflict envelope", async () => {
    for (const action of ["retry", "cancel"] as const) {
      const response = await handler({
        runOperations: {
          get: vi.fn(),
          retry: vi.fn().mockRejectedValue(new MobileRunConflictError()),
          cancel: vi.fn().mockRejectedValue(new MobileRunConflictError()),
        },
      })(
        new Request(
          `http://localhost/v1/runs/24100000-0000-4000-8000-000000000001/${action}`,
          {
            method: "POST",
            headers: {
              authorization: "Bearer signed-jwt",
              "idempotency-key": "24100000-0000-4000-8000-000000000003",
            },
          },
        ),
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: "conflict",
          message: "The run changed. Refresh its latest status before trying again.",
          requestId: "req_test",
        },
      });
    }
  });

  it("rejects missing or forged auth, malformed run IDs, and invalid mutation keys before access", async () => {
    const get = vi.fn();
    const retry = vi.fn();
    const cancel = vi.fn();
    const runOperations = { get, retry, cancel };

    const missingAuth = await handler({ runOperations })(
      new Request("http://localhost/v1/runs/24100000-0000-4000-8000-000000000001"),
    );
    expect(missingAuth.status).toBe(401);

    const forgedAuth = await handler({
      authenticate: vi.fn().mockRejectedValue(new Error("forged bearer")),
      runOperations,
    })(
      new Request("http://localhost/v1/runs/24100000-0000-4000-8000-000000000001", {
        headers: { authorization: "Bearer forged" },
      }),
    );
    expect(forgedAuth.status).toBe(401);

    const malformedRun = await handler({ runOperations })(
      new Request("http://localhost/v1/runs/not-a-uuid", {
        headers: { authorization: "Bearer signed-jwt" },
      }),
    );
    expect(malformedRun.status).toBe(400);

    const invalidKey = await handler({ runOperations })(
      new Request(
        "http://localhost/v1/runs/24100000-0000-4000-8000-000000000001/cancel",
        {
          method: "POST",
          headers: {
            authorization: "Bearer signed-jwt",
            "idempotency-key": "not-a-uuid",
          },
        },
      ),
    );
    expect(invalidKey.status).toBe(400);

    expect(get).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("fails run operations closed with stable envelopes and no private error detail", async () => {
    const reportError = vi.fn();
    const response = await handler({
      reportError,
      runOperations: {
        get: vi.fn().mockRejectedValue(new Error("service role database detail")),
        retry: vi.fn(),
        cancel: vi.fn(),
      },
    })(
      new Request("http://localhost/v1/runs/24100000-0000-4000-8000-000000000001", {
        headers: { authorization: "Bearer signed-jwt" },
      }),
    );

    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      error: {
        code: "internal_error",
        message: "Run status is temporarily unavailable.",
        requestId: "req_test",
      },
    });
    expect(body).not.toContain("service role");
    expect(reportError).toHaveBeenCalledWith("mobile-api.run-detail", expect.any(Error));
  });

  it("returns one authenticated run-coherent pricing evidence snapshot", async () => {
    const pricingEvidence = {
      forItem: vi.fn().mockResolvedValue({
        item: {
          id: "22222222-2222-4222-8222-222222222222",
          title: "Sony WH-1000XM4",
          condition: "Used - Good",
        },
        priceResult: {
          suggested: 130,
          range: { min: 120, max: 140 },
          confidence: 0.88,
          sources: [
            {
              url: "https://www.ebay.com/itm/sale-1",
              title: "Sony headphones",
              kind: "sold-comp",
            },
          ],
          evidence: [
            {
              id: "sale-1",
              sourceUrl: "https://www.ebay.com/itm/sale-1",
              title: "Sony headphones",
              price: 130,
              currency: "USD",
              kind: "sold-comparable",
              priceDisclosure: "displayed-sold-price",
            },
          ],
          tier: "ebay-sold",
          compAgreement: 0.8,
        },
        evidenceLevel: "limited",
        evidenceAsOf: "2026-07-18T12:00:00.000Z",
        evidenceAgeDays: 1.5,
        isStale: false,
        defaultWindow: "90D",
        comparables: [
          {
            id: "sale-1",
            sourceUrl: "https://www.ebay.com/itm/sale-1",
            title: "Sony headphones",
            price: 130,
            currency: "USD",
            kind: "sold-comparable",
            priceDisclosure: "displayed-sold-price",
            evidenceAsOf: "2026-07-18T12:00:00.000Z",
          },
        ],
        estimatedFees: 17.53,
        estimatedPayout: 112.47,
        chartBounds: null,
      }),
    };
    const authenticate = vi.fn().mockResolvedValue({ userId: "user_native" });

    const response = await handler({ authenticate, pricingEvidence })(
      new Request(
        "http://localhost/v1/items/22222222-2222-4222-8222-222222222222/pricing",
        { headers: { authorization: "Bearer signed-jwt" } },
      ),
    );

    expect(response.status).toBe(200);
    expect(pricingEvidence.forItem).toHaveBeenCalledWith({
      userId: "user_native",
      bearerToken: "signed-jwt",
      itemId: "22222222-2222-4222-8222-222222222222",
    });
    await expect(response.json()).resolves.toMatchObject({
      data: {
        priceResult: { suggested: 130, tier: "ebay-sold" },
        comparables: [{ id: "sale-1", price: 130 }],
        estimatedPayout: 112.47,
      },
      meta: { requestId: "req_test" },
    });
  });

  it("returns persisted composite confidence when the provider score differs", async () => {
    const result: PipelineResult = {
      attributes: {
        title: "Sony WH-1000XM4",
        condition: "Used - Good",
      },
      price: {
        suggested: 130,
        range: { min: 120, max: 140 },
        confidence: 0.17,
        sources: [],
        tier: "llm-only",
      },
      confidence: {
        score: 0.84,
        band: "high",
        autopilotEligible: false,
      },
      listing: {
        platform: "ebay",
        title: "Sony WH-1000XM4",
        description: "Seller-ready listing",
        fields: {},
      },
      model: "test-identification-model",
    };
    const persisted = buildPipelinePersistencePayload(result).pricing_snapshot;
    const evidenceAsOf = "2026-07-20T12:00:00+00:00";
    const runId = "11111111-1111-4111-8111-111111111111";
    const itemId = "22222222-2222-4222-8222-222222222222";
    const listingId = "33333333-3333-4333-8333-333333333333";
    const projection = buildPricingEvidenceProjection(
      {
        run_id: runId,
        pipeline_run_id: runId,
        run_kind: "pipeline",
        user_id: "user_native",
        item_id: itemId,
        prediction_id: "44444444-4444-4444-8444-444444444444",
        listing_id: listingId,
        ...persisted,
        evidence_as_of: evidenceAsOf,
        pipeline_runs: {
          id: runId,
          status: "succeeded",
          stage: "completed",
          listing_id: listingId,
          completed_at: evidenceAsOf,
        },
        listings: {
          id: listingId,
          run_id: runId,
          item_id: itemId,
          user_id: "user_native",
        },
      },
      {
        userId: "user_native",
        itemId,
        now: Date.parse(evidenceAsOf),
      },
    );

    const response = await handler({
      authenticate: vi.fn().mockResolvedValue({ userId: "user_native" }),
      pricingEvidence: { forItem: vi.fn().mockResolvedValue(projection) },
    })(
      new Request(`http://localhost/v1/items/${itemId}/pricing`, {
        headers: { authorization: "Bearer signed-jwt" },
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.priceResult.confidence).toBe(result.confidence.score);
    expect(body.data.priceResult.confidence).not.toBe(result.price.confidence);
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

  it("consumes #174's verified handoff and derives claim ownership only from the Clerk principal", async () => {
    const accountRecovery = {
      encryptedArtifact: {
        version: 1 as const,
        algorithm: "aes-256-gcm" as const,
        keyId: "guest-recovery-v1",
        keyEnvelope: Buffer.alloc(32, 1).toString("base64"),
        nonce: Buffer.alloc(12, 2).toString("base64"),
        tag: Buffer.alloc(16, 3).toString("base64"),
        ciphertext: Buffer.from("encrypted-draft").toString("base64"),
      },
      storageManifest: [{
        destinationPath: "user_account/items/front.enc",
        sha256: "b".repeat(64),
        byteLength: 128,
        encryption: {
          algorithm: "aes-256-gcm" as const,
          keyId: "guest-recovery-v1",
          nonce: Buffer.alloc(12, 4).toString("base64"),
          tag: Buffer.alloc(16, 5).toString("base64"),
        },
      }],
    };
    const verifyGuestClaimHandoff = vi.fn().mockResolvedValue({
      recoveryId: "11111111-1111-4111-8111-111111111111",
      guestUserId: "guest_fixture",
      recoveryTokenHash: "a".repeat(64),
    });
    const claimGuestRecovery = vi.fn().mockResolvedValue({
      outcome: "claimed",
      itemId: "22222222-2222-4222-8222-222222222222",
      runId: "33333333-3333-4333-8333-333333333333",
      draftId: "44444444-4444-4444-8444-444444444444",
      purgeLocalRecovery: true,
      accountRecovery,
    });
    const response = await handler({
      authenticate: vi.fn().mockResolvedValue({ userId: "user_account" }),
      verifyGuestClaimHandoff,
      claimGuestRecovery,
    })(
      new Request("http://localhost/v1/guest/claims", {
        method: "POST",
        headers: {
          authorization: "Bearer signed-account-jwt",
          "idempotency-key": "55555555-5555-4555-8555-555555555555",
          "x-snaplist-guest-handoff": "opaque-174-handoff",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          targetUserId: "attacker",
          expiresAt: "2099-01-01T00:00:00.000Z",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(verifyGuestClaimHandoff).toHaveBeenCalledWith("opaque-174-handoff");
    expect(claimGuestRecovery).toHaveBeenCalledWith({
      handoff: {
        recoveryId: "11111111-1111-4111-8111-111111111111",
        guestUserId: "guest_fixture",
        recoveryTokenHash: "a".repeat(64),
      },
      idempotencyKey: "55555555-5555-4555-8555-555555555555",
      targetUserId: "user_account",
    });
    await expect(response.json()).resolves.toEqual({
      data: {
        outcome: "claimed",
        itemId: "22222222-2222-4222-8222-222222222222",
        runId: "33333333-3333-4333-8333-333333333333",
        draftId: "44444444-4444-4444-8444-444444444444",
        purgeLocalRecovery: true,
        accountRecovery,
      },
      meta: { requestId: "req_test" },
    });
  });

  it("requires both account authentication and the verified guest handoff", async () => {
    const headerCases: HeadersInit[] = [
      { "x-snaplist-guest-handoff": "opaque-174-handoff" },
      { authorization: "Bearer signed-account-jwt" },
    ];
    for (const headers of headerCases) {
      const response = await handler()(
        new Request("http://localhost/v1/guest/claims", {
          method: "POST",
          headers,
        }),
      );
      expect(response.status).toBe(401);
    }
  });

  it("requires one UUID idempotency key for the logical guest claim mutation", async () => {
    for (const idempotencyKey of [undefined, "not-a-uuid"]) {
      const headers: Record<string, string> = {
        authorization: "Bearer signed-account-jwt",
        "x-snaplist-guest-handoff": "opaque-174-handoff",
      };
      if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;

      const response = await handler()(
        new Request("http://localhost/v1/guest/claims", {
          method: "POST",
          headers,
        }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "invalid_request", requestId: "req_test" },
      });
    }
  });

  it("returns stable retry-safe guest claim errors without leaking internals", async () => {
    for (const [error, status, code] of [
      [new GuestClaimInProgressError(5), 409, "conflict"],
      [new GuestClaimIdempotencyConflictError(), 409, "conflict"],
      [new Error("private storage credential detail"), 503, "internal_error"],
    ] as const) {
      const response = await handler({
        claimGuestRecovery: vi.fn().mockRejectedValue(error),
        reportError: vi.fn(),
      })(
        new Request("http://localhost/v1/guest/claims", {
          method: "POST",
          headers: {
            authorization: "Bearer signed-account-jwt",
            "idempotency-key": "55555555-5555-4555-8555-555555555555",
            "x-snaplist-guest-handoff": "opaque-174-handoff",
          },
        }),
      );
      expect(response.status).toBe(status);
      const body = await response.text();
      expect(JSON.parse(body)).toMatchObject({
        error: { code, requestId: "req_test" },
      });
      expect(body).not.toContain("credential");
    }
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
