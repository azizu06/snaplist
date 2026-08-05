/**
 * Public surface of the eBay marketplace adapter (issue #14).
 *
 * Callers import from here. Listing writes depend on `EbayAdapter`. Buyer
 * messaging was retired with the inbox (issue #599); this adapter now only
 * publishes and revises listings.
 */
export type {
  EbayAdapter,
  EbayPublishRequest,
  EbayPublishResult,
  EbayReviseRequest,
  EbayReviseResult,
  EbayDispatchContext,
  EbayPublishCompletion,
  EbayReviseCompletion,
  EbayTokenProvider,
  EbayCondition,
} from "./types";
export { EbayApiError, EbayWriteAmbiguousError } from "./types";
export { HttpEbayAdapter } from "./http";
export { MockEbayAdapter } from "./mock";
export { EnvTokenProvider, OperatorSandboxTokenProvider } from "./auth";
export {
  toEbayPublishRequest,
  toEbayCondition,
  toEbayAspects,
  toEbayPrice,
  type ListingForPublish,
} from "./map";
export {
  publishListingToEbay,
  publishListingToEbayAndNotify,
  PublishedReplayConflictError,
  PublishReviewRevisionConflictError,
  type PublishOutcome,
} from "./publish";
export {
  createMobileEbayPublishService,
  MobileEbayListingNotFoundError,
  type MobileEbayPublishGateway,
  type MobileEbayPublishPreflight,
  type MobileEbayPublishStatus,
} from "./mobile-publish";
export {
  PublishValidationError,
  isEbayAuthError,
  EBAY_RECONNECT_MESSAGE,
} from "./errors";
export { UserTokenProvider } from "./user-token-provider";
export {
  getEbayConnectionStatus,
  saveEbayConnection,
  deleteEbayConnection,
  eraseEbayUserData,
  listScheduledEbayConnectionUserIds,
  type EbayConnectionStatus,
} from "./connections";
export {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  fetchEbayIdentity,
  ebayApiBaseUrl,
  ebayAuthorizeBaseUrl,
  EBAY_OAUTH_SCOPES,
} from "./oauth";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { EbayAdapter, EbayTokenProvider } from "./types";
import { HttpEbayAdapter } from "./http";
import { UserTokenProvider } from "./user-token-provider";
import { getEbayConnectionStatus } from "./connections";
import { OperatorSandboxTokenProvider } from "./auth";

/**
 * The real adapter, wired for the current environment. Sandbox by default
 * (`EBAY_BASE_URL`); production is a credential/URL flip (docs/ebay-production.md).
 * Env is read lazily inside the adapter, so calling this is always safe.
 */
export function createEbayAdapter(
  tokenProvider: EbayTokenProvider,
): EbayAdapter {
  if (!tokenProvider) {
    throw new Error("An account-bound eBay token provider is required.");
  }
  return new HttpEbayAdapter({ tokenProvider });
}

/**
 * The adapter for a signed-in seller (issue #17): their own OAuth tokens when
 * an eBay account is connected. Env credentials are accepted only for the
 * explicitly configured operator user/seller on the exact Sandbox origin.
 *
 * Normal sellers publish only with the verified marketplace policy/location
 * binding stored on their current connection generation. Process-wide policy
 * and location values are reserved for the exact configured operator tenant
 * and seller on `https://api.sandbox.ebay.com`; production never uses them.
 */
export async function createEbayAdapterForUser(
  supabase: SupabaseClient,
  userId?: string,
  options: {
    credentialClient?: SupabaseClient | (() => Promise<SupabaseClient>);
    env?: () => Record<string, string | undefined>;
    scheduled?: boolean;
  } = {},
): Promise<EbayAdapter> {
  const readEnv = options.env ?? (() => process.env);
  const { connected } = await getEbayConnectionStatus(
    supabase,
    userId,
    options.scheduled,
  );
  if (connected) {
    const credentialClient = await resolveCredentialClient(
      supabase,
      options.credentialClient,
    );
    return new HttpEbayAdapter({
      tokenProvider: new UserTokenProvider(credentialClient, {
        env: readEnv,
        userId,
        scheduled: options.scheduled,
      }),
      env: readEnv,
    });
  }
  const env = readEnv();
  assertOperatorSandboxFallback(userId, env);
  const credentialClient = await resolveCredentialClient(
    supabase,
    options.credentialClient,
  );
  return new HttpEbayAdapter({
    tokenProvider: operatorSandboxTokenProvider(
      credentialClient,
      userId,
      options.scheduled ?? false,
      env,
    ),
    env: readEnv,
    publishFallbackBinding: options.scheduled
      ? undefined
      : operatorSandboxPublishBinding(env),
  });
}

/**
 * Whether this tenant may use the app-level Sandbox seller credentials.
 *
 * Named for the messaging fallback it was introduced with, but it is the gate
 * for every app-level Sandbox credential use — `assertOperatorSandboxFallback`
 * below calls it on the publish path. It outlives the retired inbox (#599); the
 * name is left alone so the publish path stays untouched by that removal.
 */
export function hasEbayMessagingSandboxFallback(
  userId?: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const baseUrl = env.EBAY_BASE_URL ?? "https://api.sandbox.ebay.com";
  if (!isExactEbaySandboxApiBase(baseUrl)) return false;
  if (
    !userId ||
    !env.EBAY_MESSAGING_SANDBOX_OPERATOR_USER_ID ||
    !env.EBAY_MESSAGING_SANDBOX_OPERATOR_SELLER_ID ||
    userId !== env.EBAY_MESSAGING_SANDBOX_OPERATOR_USER_ID
  ) {
    return false;
  }
  return !!(
    env.EBAY_OAUTH_TOKEN ||
    (env.EBAY_REFRESH_TOKEN && env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET)
  );
}

function isExactEbaySandboxApiBase(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return (
      url.origin === "https://api.sandbox.ebay.com" &&
      (url.pathname === "" || url.pathname === "/") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

async function resolveCredentialClient(
  fallback: SupabaseClient,
  credentialClient?: SupabaseClient | (() => Promise<SupabaseClient>),
): Promise<SupabaseClient> {
  if (!credentialClient) return fallback;
  return typeof credentialClient === "function"
    ? credentialClient()
    : credentialClient;
}

function operatorSandboxTokenProvider(
  supabase: SupabaseClient,
  userId: string | undefined,
  scheduled: boolean,
  env: Record<string, string | undefined>,
): OperatorSandboxTokenProvider {
  const identity = assertOperatorSandboxFallback(userId, env);
  return new OperatorSandboxTokenProvider(
    supabase,
    identity.userId,
    identity.sellerId,
    scheduled,
  );
}

function assertOperatorSandboxFallback(
  userId: string | undefined,
  env: Record<string, string | undefined> = process.env,
): {
  userId: string;
  sellerId: string;
} {
  const baseUrl = env.EBAY_BASE_URL ?? "https://api.sandbox.ebay.com";
  if (!isExactEbaySandboxApiBase(baseUrl)) {
    throw new Error(
      "Production eBay writes require the seller's connected account.",
    );
  }
  if (!hasEbayMessagingSandboxFallback(userId, env)) {
    throw new Error(
      "App-level eBay Sandbox credentials are restricted to the configured operator tenant.",
    );
  }
  const sellerId = env.EBAY_MESSAGING_SANDBOX_OPERATOR_SELLER_ID;
  if (!userId || !sellerId) {
    throw new Error("App-level eBay Sandbox identity is not configured.");
  }
  return { userId, sellerId };
}

function operatorSandboxPublishBinding(
  env: Record<string, string | undefined> = process.env,
) {
  const values = {
    fulfillmentPolicyId: env.EBAY_FULFILLMENT_POLICY_ID,
    paymentPolicyId: env.EBAY_PAYMENT_POLICY_ID,
    returnPolicyId: env.EBAY_RETURN_POLICY_ID,
    merchantLocationKey: env.EBAY_MERCHANT_LOCATION_KEY,
  };
  const missing = Object.entries(values)
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `The eBay Sandbox operator offer binding is incomplete: ${missing.join(", ")}.`,
    );
  }
  return {
    marketplaceId: env.EBAY_MARKETPLACE_ID ?? "EBAY_US",
    connectionGeneration: null,
    fulfillmentPolicyId: values.fulfillmentPolicyId!,
    paymentPolicyId: values.paymentPolicyId!,
    returnPolicyId: values.returnPolicyId!,
    merchantLocationKey: values.merchantLocationKey!,
  } as const;
}
