import { redirect } from "next/navigation";
import { currentUser } from "@clerk/nextjs/server";
import { createClient } from "@/lib/supabase/server";
import { getUserId } from "@/lib/auth";
import { getAutopilotEnabled } from "@/lib/settings/user-settings";
import { getEbayConnectionStatus } from "@/lib/marketplace/ebay";
import { tierLimits } from "@/lib/abuse/config";
import { getEntitlement, stripeConfigured } from "@/lib/billing";
import { setAutopilotSetting } from "@/app/(app)/upload/actions";
import { disconnectEbay } from "./actions";
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
  const [autopilotEnabled, ebayConnection, clerkUser, tier] = await Promise.all([
    getAutopilotEnabled(supabase, userId),
    getEbayConnectionStatus(supabase),
    currentUser(),
    getEntitlement(userId, supabase),
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
    ebay: {
      connected: ebayConnection.connected,
      ebayUsername: ebayConnection.connected
        ? (ebayConnection.ebayUsername ?? null)
        : null,
    },
    billing: {
      tier,
      itemsPerDay: tierLimits(tier).itemsPerDay,
      proItemsPerDay: tierLimits("paid").itemsPerDay,
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
      disconnectEbayAction={disconnectEbay}
    />
  );
}
