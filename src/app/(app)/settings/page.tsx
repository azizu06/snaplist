import { redirect } from "next/navigation";
import { currentUser } from "@clerk/nextjs/server";
import { createClient } from "@/lib/supabase/server";
import { getUserId } from "@/lib/auth";
import { getAutoReplyEnabled, getAutopilotEnabled } from "@/lib/settings/user-settings";
import { getEbayConnectionStatus } from "@/lib/marketplace/ebay";
import { resolveSellerPolicy, sellerPolicyForTier, stripeConfigured } from "@/lib/billing";
import { setAutopilotSetting } from "@/app/(app)/upload/actions";
import { disconnectEbay, setAutoReplySetting } from "./actions";
import { SettingsView, type SettingsData } from "./settings-view";

/**
 * Settings — data assembly only (UI pass). Resolves the Clerk profile (the
 * same fields the topbar ProfileMenu gets), the publish-eligibility switch state, and
 * the eBay connection, then hands plain serializable props to SettingsView so
 * the dev preview harness can render the identical screen from fixtures.
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ebay?: string }>;
}) {
  const { error, ebay } = await searchParams;

  const supabase = await createClient();
  const userId = await getUserId();
  if (!userId) redirect("/login?next=/settings");

  // #64: resolve the caller's REAL billing entitlement from the Supabase mirror
  // (getEntitlement) — not the pure resolveTier default — so a Pro subscriber sees
  // Pro and the 200/day cap. getEntitlement is fail-safe (defaults free), reusing
  // the request's user-scoped client (RLS read-own).
  const [autopilotEnabled, autoReplyEnabled, ebayConnection, clerkUser, policy] = await Promise.all([
    getAutopilotEnabled(supabase, userId),
    getAutoReplyEnabled(supabase, userId),
    getEbayConnectionStatus(supabase),
    currentUser(),
    resolveSellerPolicy(userId, { client: supabase }),
  ]);

  const data: SettingsData = {
    user: {
      name:
        clerkUser?.fullName ??
        clerkUser?.username ??
        clerkUser?.primaryEmailAddress?.emailAddress ??
        "Account",
      email: clerkUser?.primaryEmailAddress?.emailAddress ?? "",
      imageUrl: clerkUser?.imageUrl ?? null,
    },
    autopilotEnabled,
    autoReplyEnabled,
    ebay: {
      connected: ebayConnection.connected,
      ebayUsername: ebayConnection.connected
        ? (ebayConnection.ebayUsername ?? null)
        : null,
    },
    billing: {
      tier: policy.tier,
      itemsPerDay: policy.limits.itemsPerDay,
      proItemsPerDay: sellerPolicyForTier("paid").limits.itemsPerDay,
      capabilities: policy.capabilities,
      billingEnabled: stripeConfigured(),
    },
    error: error ?? null,
    ebayBanner:
      ebay === "connected" ? "connected" : ebay === "disconnected" ? "disconnected" : null,
  };

  return (
    <SettingsView
      data={data}
      autopilotAction={setAutopilotSetting}
      autoReplyAction={setAutoReplySetting}
      disconnectEbayAction={disconnectEbay}
    />
  );
}
