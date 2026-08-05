import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const revenueCatEventSchema = z
  .object({
    id: z.string().min(1).max(255),
    type: z.string().min(1),
    event_timestamp_ms: z.number().int().nonnegative(),
    app_id: z.string().min(1),
    app_user_id: z.string().min(1).optional(),
    original_app_user_id: z.string().min(1).optional(),
    aliases: z.array(z.string().min(1)).default([]),
    product_id: z.string().min(1).optional(),
    entitlement_ids: z.array(z.string().min(1)).default([]),
    period_type: z.string().min(1).optional(),
    purchased_at_ms: z.number().int().nonnegative().optional(),
    expiration_at_ms: z.number().int().nonnegative().nullable().optional(),
    grace_period_expiration_at_ms: z.number().int().nonnegative().nullable().optional(),
    environment: z.enum(["PRODUCTION", "SANDBOX"]),
    transaction_id: z.string().min(1).optional(),
    original_transaction_id: z.string().min(1).optional(),
    store: z.string().min(1).optional(),
    cancel_reason: z.string().min(1).nullable().optional(),
    expiration_reason: z.string().min(1).nullable().optional(),
  })
  .passthrough();

const revenueCatEnvelopeSchema = z
  .object({
    api_version: z.string().min(1),
    event: revenueCatEventSchema,
  })
  .passthrough();

export type RevenueCatWebhook = z.infer<typeof revenueCatEnvelopeSchema>;
export type RevenueCatEnvironment = RevenueCatWebhook["event"]["environment"];

export interface RevenueCatWebhookConfig {
  signingSecret: string;
  authorization: string;
  appId: string;
  entitlementId: string;
  monthlyProductId: string;
  monthlyAllowance: number;
  allowedEnvironment: RevenueCatEnvironment;
}

export interface RevenueCatServerConfig extends RevenueCatWebhookConfig {
  iosPublicSdkKey?: string;
  offeringId?: string;
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Returns null for the safe unconfigured state; partial config is rejected. */
export function resolveRevenueCatServerConfig(
  environment: Record<string, string | undefined> = process.env,
): RevenueCatServerConfig | null {
  const signingSecret = nonBlank(environment.REVENUECAT_WEBHOOK_SIGNING_SECRET);
  const authorization = nonBlank(environment.REVENUECAT_WEBHOOK_AUTHORIZATION);
  const appId = nonBlank(environment.REVENUECAT_APP_ID);
  const entitlementId = nonBlank(environment.REVENUECAT_ENTITLEMENT_ID);
  const monthlyProductId = nonBlank(environment.REVENUECAT_MONTHLY_PRODUCT_ID);
  const allowedEnvironment = nonBlank(environment.REVENUECAT_ALLOWED_ENVIRONMENT);
  const allowanceValue = nonBlank(environment.SNAPLIST_PRO_MONTHLY_AI_ITEM_ALLOWANCE);
  const iosPublicSdkKey = nonBlank(environment.REVENUECAT_IOS_PUBLIC_SDK_KEY);
  const offeringId = nonBlank(environment.REVENUECAT_OFFERING_ID);
  const required = [
    signingSecret,
    authorization,
    appId,
    entitlementId,
    monthlyProductId,
    allowedEnvironment,
    allowanceValue,
  ];
  if ([...required, iosPublicSdkKey, offeringId].every((value) => value === undefined)) {
    return null;
  }
  if (required.some((value) => value === undefined)) {
    throw new Error("RevenueCat server configuration is incomplete.");
  }
  const monthlyAllowance = Number(allowanceValue);
  if (!Number.isSafeInteger(monthlyAllowance) || monthlyAllowance < 1 || monthlyAllowance > 10_000) {
    throw new Error("RevenueCat monthly allowance must be an integer from 1 to 10000.");
  }
  if (allowedEnvironment !== "PRODUCTION" && allowedEnvironment !== "SANDBOX") {
    throw new Error("RevenueCat allowed environment must be PRODUCTION or SANDBOX.");
  }
  return {
    signingSecret: signingSecret!,
    authorization: authorization!,
    appId: appId!,
    entitlementId: entitlementId!,
    monthlyProductId: monthlyProductId!,
    monthlyAllowance,
    allowedEnvironment,
    ...(iosPublicSdkKey ? { iosPublicSdkKey } : {}),
    ...(offeringId ? { offeringId } : {}),
  };
}

export interface RevenueCatCustomerIdentity {
  appUserId: string;
  originalAppUserId: string;
  aliases: string[];
  originalTransactionId: string;
}

export type BillingSourceTransitionState = "not_required" | "required" | "reconciled";

export interface RevenueCatCustomerResolution {
  userId: string;
  transitionState: BillingSourceTransitionState;
}

export type StoreKitPeriodState =
  | "active"
  | "grace"
  | "billing_retry"
  | "expired"
  | "revoked"
  | "refunded"
  | "ambiguous";

export interface VerifiedStoreKitPeriod {
  userId: string;
  source: "storekit";
  periodKey: string;
  originalTransactionId: string;
  periodStart: string;
  expiresDate: string;
  state: StoreKitPeriodState;
  graceExpiresDate: string | null;
  allowance: number;
  eventId: string;
  eventCreatedAt: string;
  eventType: string;
  transactionId: string | null;
  environment: RevenueCatEnvironment;
}

export interface RevenueCatEntitlementStore {
  /** Resolve only through a server-owned immutable Clerk/RevenueCat binding. */
  resolveCustomer(identity: RevenueCatCustomerIdentity): Promise<RevenueCatCustomerResolution | null>;
  /** Calls the #168 idempotent period RPC; false means an exact replay/stale event. */
  recordPeriod(period: VerifiedStoreKitPeriod): Promise<boolean>;
  /** Persist a fail-closed operator-reconciliation marker without changing quota. */
  requireReconciliation(input: {
    identity: RevenueCatCustomerIdentity;
    eventId: string;
    eventType: string;
    eventCreatedAt: string;
    environment: RevenueCatEnvironment;
  }): Promise<void>;
}

function equalSecret(actual: string | null, expected: string): boolean {
  if (!actual) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function parseSignature(signature: string | null): { timestamp: number; digests: string[] } {
  const components = (signature ?? "").split(",").map((part) => part.trim());
  const timestampValue = components.find((part) => part.startsWith("t="))?.slice(2);
  const digests = components
    .filter((part) => part.startsWith("v1="))
    .map((part) => part.slice(3));
  const timestamp = Number(timestampValue);
  if (!Number.isSafeInteger(timestamp) || digests.length === 0) {
    throw new Error("Invalid RevenueCat webhook signature.");
  }
  return { timestamp, digests };
}

export function parseAndVerifyRevenueCatWebhook(input: {
  rawBody: string;
  signature: string | null;
  authorization: string | null;
  config: RevenueCatWebhookConfig;
  now?: Date;
  toleranceSeconds?: number;
}): RevenueCatWebhook {
  if (!equalSecret(input.authorization, input.config.authorization)) {
    throw new Error("Invalid RevenueCat webhook authorization.");
  }

  const parsedSignature = parseSignature(input.signature);
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const tolerance = input.toleranceSeconds ?? 300;
  if (Math.abs(nowSeconds - parsedSignature.timestamp) > tolerance) {
    throw new Error("RevenueCat webhook timestamp is outside the replay tolerance.");
  }

  const expected = createHmac("sha256", input.config.signingSecret)
    .update(`${parsedSignature.timestamp}.${input.rawBody}`)
    .digest("hex");
  if (!parsedSignature.digests.some((digest) => equalSecret(digest, expected))) {
    throw new Error("Invalid RevenueCat webhook signature.");
  }

  return revenueCatEnvelopeSchema.parse(JSON.parse(input.rawBody));
}

function iso(milliseconds: number | null | undefined, field: string): string {
  if (milliseconds == null) throw new Error(`RevenueCat ${field} is required.`);
  const value = new Date(milliseconds);
  if (!Number.isFinite(value.getTime())) throw new Error(`RevenueCat ${field} is invalid.`);
  return value.toISOString();
}

function identityFor(event: RevenueCatWebhook["event"]): RevenueCatCustomerIdentity {
  if (!event.app_user_id || !event.original_app_user_id) {
    throw new Error("RevenueCat customer identity is required.");
  }
  if (!event.original_transaction_id) {
    throw new Error("RevenueCat original transaction identity is required.");
  }
  return {
    appUserId: event.app_user_id,
    originalAppUserId: event.original_app_user_id,
    aliases: event.aliases,
    originalTransactionId: event.original_transaction_id,
  };
}

const RECONCILIATION_EVENTS = new Set([
  "SUBSCRIPTION_EXTENDED",
  "PRODUCT_CHANGE",
  "REFUND_REVERSED",
]);

function periodState(event: RevenueCatWebhook["event"]): {
  state: StoreKitPeriodState;
  graceExpiresDate: string | null;
} | null {
  switch (event.type) {
    case "INITIAL_PURCHASE":
    case "RENEWAL":
    case "UNCANCELLATION":
      return { state: "active", graceExpiresDate: null };
    case "CANCELLATION":
      if (event.cancel_reason === "CUSTOMER_SUPPORT") {
        return { state: "refunded", graceExpiresDate: null };
      }
      if (event.cancel_reason === "BILLING_ERROR") {
        // RevenueCat emits BILLING_ISSUE alongside this cancellation and only
        // that event carries the verified grace-period timestamp. Ignoring this
        // companion event prevents delivery order from erasing verified grace.
        return null;
      }
      if (
        event.cancel_reason === "DEVELOPER_INITIATED" ||
        event.cancel_reason === "DEVELOPER"
      ) {
        return { state: "revoked", graceExpiresDate: null };
      }
      if (event.cancel_reason === "UNKNOWN") {
        return { state: "ambiguous", graceExpiresDate: null };
      }
      // Unsubscribe and price-increase cancellation stop renewal but keep the
      // already-verified period usable through its expiration.
      return { state: "active", graceExpiresDate: null };
    case "BILLING_ISSUE":
      return event.grace_period_expiration_at_ms == null
        ? { state: "billing_retry", graceExpiresDate: null }
        : {
            state: "grace",
            graceExpiresDate: iso(
              event.grace_period_expiration_at_ms,
              "grace period expiration",
            ),
          };
    case "EXPIRATION":
      return { state: "expired", graceExpiresDate: null };
    default:
      return null;
  }
}

export type RevenueCatHandleResult =
  | { processed: true }
  | {
      processed: false;
      reason:
        | "duplicate"
        | "environment_mismatch"
        | "ignored"
        | "reconciliation_required";
    };

/**
 * Applies a signature-verified RevenueCat event to the existing #168 StoreKit
 * period ledger. This layer never computes remaining credits and never accepts a
 * client entitlement claim; it only translates verified provider lifecycle.
 */
export async function handleRevenueCatWebhook(
  webhook: RevenueCatWebhook,
  storeOrFactory: RevenueCatEntitlementStore | (() => RevenueCatEntitlementStore),
  config: RevenueCatWebhookConfig,
): Promise<RevenueCatHandleResult> {
  const event = webhook.event;
  if (event.environment !== config.allowedEnvironment) {
    return { processed: false, reason: "environment_mismatch" };
  }

  const store =
    typeof storeOrFactory === "function" ? storeOrFactory() : storeOrFactory;
  if (
    event.app_id !== config.appId ||
    event.store !== "APP_STORE" ||
    !event.entitlement_ids.includes(config.entitlementId)
  ) {
    return { processed: false, reason: "ignored" };
  }

  const identity = identityFor(event);
  const eventCreatedAt = iso(event.event_timestamp_ms, "event timestamp");
  if (RECONCILIATION_EVENTS.has(event.type)) {
    await store.requireReconciliation({
      identity,
      eventId: event.id,
      eventType: event.type,
      eventCreatedAt,
      environment: event.environment,
    });
    return { processed: false, reason: "reconciliation_required" };
  }

  if (event.product_id !== config.monthlyProductId) {
    return { processed: false, reason: "ignored" };
  }

  const state = periodState(event);
  if (!state) return { processed: false, reason: "ignored" };

  const customer = await store.resolveCustomer(identity);
  if (!customer) {
    throw new Error("RevenueCat customer mapping is missing or conflicts with the account.");
  }
  if (customer.transitionState === "required") {
    throw new Error("Explicit server-verified billing-source reconciliation is required.");
  }

  const periodStart = iso(event.purchased_at_ms, "period start");
  const expiresDate = iso(event.expiration_at_ms, "period expiration");
  const applied = await store.recordPeriod({
    userId: customer.userId,
    source: "storekit",
    periodKey: `${identity.originalTransactionId}:${periodStart}`,
    originalTransactionId: identity.originalTransactionId,
    periodStart,
    expiresDate,
    state: state.state,
    graceExpiresDate: state.graceExpiresDate,
    allowance: config.monthlyAllowance,
    eventId: event.id,
    eventCreatedAt,
    eventType: event.type,
    transactionId: event.transaction_id ?? null,
    environment: event.environment,
  });
  return applied
    ? { processed: true }
    : { processed: false, reason: "duplicate" };
}
