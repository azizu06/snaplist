import { describe, expect, it, vi } from "vitest";
import { createSupabaseNativeSubscriptionBridge } from "@/lib/billing/revenuecat-store";
import {
  GuestClaimIdempotencyConflictError,
  GuestClaimInProgressError,
} from "@/lib/guest-recovery/service";
import { MobileRunConflictError, MobileRunNotFoundError } from "./runs";
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
