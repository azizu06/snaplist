/**
 * Public surface of the eBay marketplace adapter (issue #14).
 *
 * Callers import from here; the adapter seam (`EbayAdapter`) is the only thing
 * the rest of SnapList depends on. `createEbayAdapter()` is the production
 * composition root: the real HTTP adapter with the app-level env token
 * provider. Tests construct `MockEbayAdapter` directly.
 */
export type {
  EbayAdapter,
  EbayPublishRequest,
  EbayPublishResult,
  EbayReviseRequest,
  EbayReviseResult,
  EbayTokenProvider,
  EbayCondition,
} from "./types";
export { EbayApiError, EbayWriteAmbiguousError } from "./types";
export { HttpEbayAdapter } from "./http";
export { HttpEbayMessagingAdapter } from "./messaging";
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
  type PublishOutcome,
} from "./publish";
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
import type { EbayAdapter } from "./types";
import { HttpEbayAdapter } from "./http";
import { UserTokenProvider } from "./user-token-provider";
import { getEbayConnectionStatus } from "./connections";
import { HttpEbayMessagingAdapter } from "./messaging";
import type { MarketplaceMessagingAdapter } from "../messaging";
import { OperatorSandboxTokenProvider } from "./auth";

/**
 * The real adapter, wired for the current environment. Sandbox by default
 * (`EBAY_BASE_URL`); production is a credential/URL flip (docs/ebay-production.md).
 * Env is read lazily inside the adapter, so calling this is always safe.
 */
export function createEbayAdapter(): EbayAdapter {
  return new HttpEbayAdapter();
}

/**
 * The adapter for a signed-in seller (issue #17): their own OAuth tokens when
 * an eBay account is connected, the app-level env credentials otherwise (the
 * sandbox loop keeps working with zero per-user setup).
 *
 * SINGLE-SELLER CONSTRAINT (deliberate, documented in docs/ebay-production.md):
 * business policies (EBAY_*_POLICY_ID) and the merchant location stay
 * env-configured, and policies belong to the eBay account that created them —
 * so production publishing is correct for THE seller whose policies are in the
 * env (the #17 go-live story), not for arbitrary additional sellers. True
 * multi-seller needs per-connection policy discovery via the Sell Account API
 * (sell.account scope) — tracked as a follow-up issue, out of scope here.
 */
export async function createEbayAdapterForUser(
  supabase: SupabaseClient,
  userId?: string,
  options: {
    credentialClient?: SupabaseClient | (() => Promise<SupabaseClient>);
  } = {},
): Promise<EbayAdapter> {
  const { connected } = await getEbayConnectionStatus(supabase, userId);
  const credentialClient = connected
    ? await resolveCredentialClient(supabase, options.credentialClient)
    : supabase;
  return connected
    ? new HttpEbayAdapter({
        tokenProvider: new UserTokenProvider(credentialClient, { userId }),
      })
    : new HttpEbayAdapter();
}

/** Messaging composition uses connected seller tokens or one operator fallback. */
export async function createEbayMessagingAdapterForUser(
  supabase: SupabaseClient,
  userId?: string,
  options: { scheduled?: boolean; credentialClient?: SupabaseClient } = {},
): Promise<MarketplaceMessagingAdapter> {
  const { connected } = await getEbayConnectionStatus(
    supabase,
    userId,
    options.scheduled,
  );
  if (connected) {
    return new HttpEbayMessagingAdapter({
      tokenProvider: new UserTokenProvider(options.credentialClient ?? supabase, {
        userId,
        scheduled: options.scheduled,
      }),
    });
  }
  if (!hasEbayMessagingSandboxFallback(userId)) {
    const baseUrl = process.env.EBAY_BASE_URL ?? "https://api.sandbox.ebay.com";
    if (!isExactEbaySandboxApiBase(baseUrl)) {
      throw new Error(
        "Production eBay messaging requires the seller's connected account.",
      );
    }
    throw new Error(
      "App-level eBay Sandbox messaging is restricted to the configured operator tenant.",
    );
  }
  const sellerId = process.env.EBAY_MESSAGING_SANDBOX_OPERATOR_SELLER_ID;
  if (!userId || !sellerId) {
    throw new Error("App-level eBay Sandbox messaging identity is not configured.");
  }
  return new HttpEbayMessagingAdapter({
    tokenProvider: new OperatorSandboxTokenProvider(
      options.credentialClient ?? supabase,
      userId,
      sellerId,
      options.scheduled ?? false,
      {
        scopes: [
          "https://api.ebay.com/oauth/api_scope",
          "https://api.ebay.com/oauth/api_scope/commerce.message",
        ],
      },
    ),
  });
}

/** Whether this tenant may use the app-level Sandbox seller credentials. */
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

export function ebayMessagingSyncUserIds(
  connectedUserIds: Iterable<string>,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const userIds = new Set(connectedUserIds);
  const operatorUserId = env.EBAY_MESSAGING_SANDBOX_OPERATOR_USER_ID;
  if (operatorUserId && hasEbayMessagingSandboxFallback(operatorUserId, env)) {
    userIds.add(operatorUserId);
  }
  return [...userIds];
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
