import { redirect } from "next/navigation";
import { currentUser } from "@clerk/nextjs/server";
import { createClient } from "@/lib/supabase/server";
import { getUserId } from "@/lib/auth";
import { getAutopilotEnabled } from "@/lib/settings/user-settings";
import { getEbayConnectionStatus } from "@/lib/marketplace/ebay";
import { resolveTier, tierLimits } from "@/lib/abuse/config";
import { setAutopilotSetting } from "@/app/(app)/upload/actions";
import { disconnectEbay } from "./actions";
import { SettingsView, type SettingsData } from "./settings-view";

/**
 * Settings — data assembly only (UI pass). Resolves the Clerk profile (the
 * same fields the topbar ProfileMenu gets), the autopilot switch state, and
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

  const [autopilotEnabled, ebayConnection, clerkUser] = await Promise.all([
    getAutopilotEnabled(supabase, userId),
    getEbayConnectionStatus(supabase),
    currentUser(),
  ]);

  // #64: resolve the caller's billing tier from the live `resolveTier` seam so
  // the settings UI shows the real plan + the daily allowance actually enforced.
  // Everyone is `free` until the Stripe backend flips paid subscribers.
  const tier = resolveTier(userId);

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
