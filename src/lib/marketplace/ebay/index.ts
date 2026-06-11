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
  EbayTokenProvider,
  EbayCondition,
} from "./types";
export { EbayApiError } from "./types";
export { HttpEbayAdapter } from "./http";
export { MockEbayAdapter } from "./mock";
export { EnvTokenProvider } from "./auth";
export {
  toEbayPublishRequest,
  toEbayCondition,
  toEbayAspects,
  toEbayPrice,
  type ListingForPublish,
} from "./map";
export { publishListingToEbay, type PublishOutcome } from "./publish";
export { UserTokenProvider } from "./user-token-provider";
export {
  getEbayConnectionStatus,
  saveEbayConnection,
  deleteEbayConnection,
  eraseEbayUserData,
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
 */
export async function createEbayAdapterForUser(
  supabase: SupabaseClient,
): Promise<EbayAdapter> {
  const { connected } = await getEbayConnectionStatus(supabase);
  return connected
    ? new HttpEbayAdapter({ tokenProvider: new UserTokenProvider(supabase) })
    : new HttpEbayAdapter();
}
