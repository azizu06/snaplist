import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  handleRevenueCatWebhook,
  parseAndVerifyRevenueCatWebhook,
  resolveRevenueCatServerConfig,
  type RevenueCatEntitlementStore,
} from "./revenuecat";
import { createSupabaseRevenueCatEntitlementStore } from "./revenuecat-store";

const secret = "offline-webhook-secret";
const now = new Date("2026-07-17T12:00:00.000Z");

function payload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    api_version: "1.0",
    event: {
      id: "event-initial",
      type: "INITIAL_PURCHASE",
      event_timestamp_ms: now.getTime(),
      app_id: "app_test",
      app_user_id: "user_123",
      original_app_user_id: "user_123",
      aliases: ["user_123"],
      product_id: "snaplist-pro-fixture",
      entitlement_ids: ["pro"],
      period_type: "NORMAL",
      purchased_at_ms: Date.parse("2026-07-01T00:00:00.000Z"),
      expiration_at_ms: Date.parse("2026-08-01T00:00:00.000Z"),
      environment: "SANDBOX",
      transaction_id: "transaction-1",
      original_transaction_id: "original-1",
      store: "APP_STORE",
      ...overrides,
    },
  });
}

function signature(rawBody: string, timestamp = Math.floor(now.getTime() / 1000)) {
  const digest = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

function store(overrides: Partial<RevenueCatEntitlementStore> = {}): RevenueCatEntitlementStore {
  return {
    resolveCustomer: vi.fn().mockResolvedValue({
      userId: "user_123",
      transitionState: "not_required",
    }),
    recordPeriod: vi.fn().mockResolvedValue(true),
    requireReconciliation: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("RevenueCat webhook authentication", () => {
  it("is truthfully unconfigured until every verification input is present", () => {
    expect(resolveRevenueCatServerConfig({})).toBeNull();
    expect(() =>
      resolveRevenueCatServerConfig({
        REVENUECAT_IOS_PUBLIC_SDK_KEY: "appl_public_fixture",
      }),
    ).toThrow("incomplete");
    expect(() =>
      resolveRevenueCatServerConfig({
        REVENUECAT_WEBHOOK_SIGNING_SECRET: "secret",
        REVENUECAT_WEBHOOK_AUTHORIZATION: "Bearer auth",
        REVENUECAT_APP_ID: "app",
        REVENUECAT_ENTITLEMENT_ID: "pro",
        REVENUECAT_MONTHLY_PRODUCT_ID: "snaplist-pro-fixture",
        SNAPLIST_PRO_MONTHLY_AI_ITEM_ALLOWANCE: "0",
      }),
    ).toThrow("allowance");
  });

  it("keeps native public configuration server-provided instead of source-coded", () => {
    expect(
      resolveRevenueCatServerConfig({
        REVENUECAT_WEBHOOK_SIGNING_SECRET: "secret",
        REVENUECAT_WEBHOOK_AUTHORIZATION: "Bearer auth",
        REVENUECAT_APP_ID: "app",
        REVENUECAT_ENTITLEMENT_ID: "pro",
        REVENUECAT_MONTHLY_PRODUCT_ID: "snaplist-pro-fixture",
        REVENUECAT_IOS_PUBLIC_SDK_KEY: "appl_public_fixture",
        REVENUECAT_OFFERING_ID: "current",
        SNAPLIST_PRO_MONTHLY_AI_ITEM_ALLOWANCE: "24",
      }),
    ).toEqual({
      signingSecret: "secret",
      authorization: "Bearer auth",
      appId: "app",
      entitlementId: "pro",
      monthlyProductId: "snaplist-pro-fixture",
      monthlyAllowance: 24,
      iosPublicSdkKey: "appl_public_fixture",
      offeringId: "current",
    });
  });

  it("verifies the raw body HMAC and authorization before parsing", () => {
    const rawBody = payload();
    const event = parseAndVerifyRevenueCatWebhook({
      rawBody,
      signature: signature(rawBody),
      authorization: "Bearer offline",
      config: {
        signingSecret: secret,
        authorization: "Bearer offline",
        appId: "app_test",
        entitlementId: "pro",
        monthlyProductId: "snaplist-pro-fixture",
        monthlyAllowance: 24,
      },
      now,
    });

    expect(event.event.id).toBe("event-initial");
  });

  it.each([
    ["missing signature", null, "Bearer offline"],
    ["forged signature", "t=1784289600,v1=bad", "Bearer offline"],
    ["wrong authorization", "valid", "Bearer wrong"],
  ])("rejects %s", (_label, signatureValue, authorization) => {
    const rawBody = payload();
    expect(() =>
      parseAndVerifyRevenueCatWebhook({
        rawBody,
        signature: signatureValue === "valid" ? signature(rawBody) : signatureValue,
        authorization,
        config: {
          signingSecret: secret,
          authorization: "Bearer offline",
          appId: "app_test",
          entitlementId: "pro",
          monthlyProductId: "snaplist-pro-fixture",
          monthlyAllowance: 24,
        },
        now,
      }),
    ).toThrow();
  });

  it("rejects a correctly signed replay outside the timestamp tolerance", () => {
    const rawBody = payload();
    const oldTimestamp = Math.floor(now.getTime() / 1000) - 301;
    expect(() =>
      parseAndVerifyRevenueCatWebhook({
        rawBody,
        signature: signature(rawBody, oldTimestamp),
        authorization: "Bearer offline",
        config: {
          signingSecret: secret,
          authorization: "Bearer offline",
          appId: "app_test",
          entitlementId: "pro",
          monthlyProductId: "snaplist-pro-fixture",
          monthlyAllowance: 24,
        },
        now,
      }),
    ).toThrow("timestamp");
  });
});

describe("RevenueCat persistence composition", () => {
  it("passes the signed original App User ID into reconciliation", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    const entitlementStore = createSupabaseRevenueCatEntitlementStore({ rpc } as never);

    await entitlementStore.requireReconciliation({
      identity: {
        appUserId: "user_123",
        originalAppUserId: "user_123",
        aliases: ["user_123"],
        originalTransactionId: "original-1",
      },
      eventId: "event-product-change",
      eventType: "PRODUCT_CHANGE",
      eventCreatedAt: now.toISOString(),
    });

    expect(rpc).toHaveBeenCalledWith("require_revenuecat_reconciliation", {
      p_event_created_at: now.toISOString(),
      p_event_id: "event-product-change",
      p_event_type: "PRODUCT_CHANGE",
      p_original_app_user_id: "user_123",
      p_original_transaction_id: "original-1",
      p_revenuecat_app_user_id: "user_123",
    });
  });
});

describe("RevenueCat verified lifecycle bridge", () => {
  const config = {
    signingSecret: secret,
    authorization: "Bearer offline",
    appId: "app_test",
    entitlementId: "pro",
    monthlyProductId: "snaplist-pro-fixture",
    monthlyAllowance: 24,
  };

  async function handle(
    overrides: Record<string, unknown>,
    storeOverrides: Partial<RevenueCatEntitlementStore> = {},
  ) {
    const rawBody = payload(overrides);
    const event = parseAndVerifyRevenueCatWebhook({
      rawBody,
      signature: signature(rawBody),
      authorization: "Bearer offline",
      config,
      now,
    });
    const fake = store(storeOverrides);
    return { result: await handleRevenueCatWebhook(event, fake, config), fake };
  }

  it.each([
    ["INITIAL_PURCHASE", {}, "active", null],
    ["RENEWAL", { id: "renewal" }, "active", null],
    ["UNCANCELLATION", { id: "uncancel" }, "active", null],
    ["CANCELLATION", { id: "cancel", cancel_reason: "UNSUBSCRIBE" }, "active", null],
    [
      "BILLING_ISSUE",
      {
        id: "grace",
        grace_period_expiration_at_ms: Date.parse("2026-08-08T00:00:00.000Z"),
      },
      "grace",
      "2026-08-08T00:00:00.000Z",
    ],
    ["BILLING_ISSUE", { id: "retry", grace_period_expiration_at_ms: null }, "billing_retry", null],
    ["EXPIRATION", { id: "expired", expiration_reason: "BILLING_ERROR" }, "expired", null],
    ["CANCELLATION", { id: "refund", cancel_reason: "CUSTOMER_SUPPORT" }, "refunded", null],
    [
      "CANCELLATION",
      { id: "revoked", cancel_reason: "DEVELOPER_INITIATED" },
      "revoked",
      null,
    ],
  ])("maps %s without creating a second quota source", async (type, extra, state, grace) => {
    const { result, fake } = await handle({ type, ...extra });

    expect(result).toEqual({ processed: true });
    expect(fake.recordPeriod).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_123",
        source: "storekit",
        periodKey: "original-1:2026-07-01T00:00:00.000Z",
        state,
        graceExpiresDate: grace,
        allowance: 24,
      }),
    );
  });

  it("passes duplicate deliveries through the idempotent ledger RPC", async () => {
    const { result } = await handle({}, { recordPeriod: vi.fn().mockResolvedValue(false) });
    expect(result).toEqual({ processed: false, reason: "duplicate" });
  });

  it("ignores the billing-error cancellation companion so it cannot erase verified grace", async () => {
    const { result, fake } = await handle({
      type: "CANCELLATION",
      id: "billing-error-cancellation",
      cancel_reason: "BILLING_ERROR",
    });
    expect(result).toEqual({ processed: false, reason: "ignored" });
    expect(fake.recordPeriod).not.toHaveBeenCalled();
  });

  it("fails closed on an unmapped or cross-account customer", async () => {
    await expect(
      handle({}, { resolveCustomer: vi.fn().mockResolvedValue(null) }),
    ).rejects.toThrow("customer mapping");
  });

  it("prevents Stripe and StoreKit allowance stacking until explicit reconciliation", async () => {
    const recordPeriod = vi.fn();
    await expect(
      handle(
        {},
        {
          resolveCustomer: vi.fn().mockResolvedValue({
            userId: "user_123",
            transitionState: "required",
          }),
          recordPeriod,
        },
      ),
    ).rejects.toThrow("billing-source reconciliation");
    expect(recordPeriod).not.toHaveBeenCalled();
  });

  it.each(["SUBSCRIPTION_EXTENDED", "PRODUCT_CHANGE", "REFUND_REVERSED"])(
    "requires reconciliation for %s instead of minting a period",
    async (type) => {
      const { result, fake } = await handle({ type, id: `event-${type}` });
      expect(result).toEqual({ processed: false, reason: "reconciliation_required" });
      expect(fake.requireReconciliation).toHaveBeenCalledOnce();
      expect(fake.recordPeriod).not.toHaveBeenCalled();
    },
  );

  it("ignores another app, entitlement, or store without selecting a tenant", async () => {
    const { result, fake } = await handle({ app_id: "other-app" });
    expect(result).toEqual({ processed: false, reason: "ignored" });
    expect(fake.resolveCustomer).not.toHaveBeenCalled();
  });

  it("ignores an unapproved product even when it grants the entitlement", async () => {
    const { result, fake } = await handle({ product_id: "unexpected-annual-product" });
    expect(result).toEqual({ processed: false, reason: "ignored" });
    expect(fake.resolveCustomer).not.toHaveBeenCalled();
  });

  it("accepts and safely ignores RevenueCat transfer payloads that contain no subscription identity", async () => {
    const { result, fake } = await handle({
      type: "TRANSFER",
      id: "event-transfer",
      app_user_id: undefined,
      original_app_user_id: undefined,
      aliases: undefined,
      product_id: undefined,
      entitlement_ids: undefined,
      purchased_at_ms: undefined,
      expiration_at_ms: undefined,
      original_transaction_id: undefined,
      transferred_from: ["source-user"],
      transferred_to: ["destination-user"],
    });
    expect(result).toEqual({ processed: false, reason: "ignored" });
    expect(fake.resolveCustomer).not.toHaveBeenCalled();
  });
});
