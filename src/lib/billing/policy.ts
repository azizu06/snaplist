import type { SupabaseClient } from "@supabase/supabase-js";
import { tierLimits, type Tier, type TierLimits } from "@/lib/abuse/config";
import { getEntitlement } from "./entitlement";

/**
 * The truthful Free-vs-Pro product contract (issue #153).
 *
 * SnapList's paid plan changes capacity, not access to seller workflows. In
 * particular, bulk / haul capture stays core because the PRD defines it as a
 * first-class reseller flow. This data is deliberately framework-free so the
 * marketing page, Settings, and server enforcement use the same vocabulary.
 */
export const SELLER_CAPABILITY_MATRIX = [
  {
    id: "photo-to-listing",
    label: "Photo-to-listing pipeline",
    free: true,
    paid: true,
  },
  {
    id: "bulk-haul-capture",
    label: "Bulk / haul capture",
    free: true,
    paid: true,
  },
  {
    id: "ebay-publish-and-export",
    label: "eBay publish and cross-list export packs",
    free: true,
    paid: true,
  },
  {
    id: "buyer-qa",
    label: "Buyer-Q&A drafts and inbox",
    free: true,
    paid: true,
  },
] as const;

export type SellerCapability = (typeof SELLER_CAPABILITY_MATRIX)[number]["id"];

export type SellerCapabilities = Record<SellerCapability, true>;

export interface SellerPolicy {
  /** Mirrored, server-resolved entitlement. Never supplied by the browser. */
  tier: Tier;
  /** The exact capacity values the enforcement seams use. */
  limits: TierLimits;
  /** Core seller workflows intentionally available to both Free and Seller Pro. */
  capabilities: SellerCapabilities;
}

const CORE_SELLER_CAPABILITIES: SellerCapabilities = {
  "photo-to-listing": true,
  "bulk-haul-capture": true,
  "ebay-publish-and-export": true,
  "buyer-qa": true,
};

/** Build a policy from an already trusted tier; useful for unit tests and pure UI data. */
export function sellerPolicyForTier(
  tier: Tier,
  env: Record<string, string | undefined> = process.env,
): SellerPolicy {
  return {
    tier,
    limits: tierLimits(tier, env),
    capabilities: CORE_SELLER_CAPABILITIES,
  };
}

export interface ResolveSellerPolicyOptions {
  /** A request-scoped Supabase client keeps the entitlement read under RLS. */
  client?: SupabaseClient;
  env?: Record<string, string | undefined>;
}

/**
 * The one async, server-side policy seam for Seller Pro behavior. It converts
 * the RLS-protected entitlement mirror into the tier, limits, and capabilities
 * consumed by every server enforcement surface. A missing, stale, canceled, or
 * cross-tenant row fails closed through `getEntitlement` to the Free policy.
 */
export async function resolveSellerPolicy(
  userId: string,
  { client, env = process.env }: ResolveSellerPolicyOptions = {},
): Promise<SellerPolicy> {
  return sellerPolicyForTier(await getEntitlement(userId, client), env);
}
