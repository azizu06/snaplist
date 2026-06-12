import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserEmail, getUserId } from "@/lib/auth";
import { getAutopilotEnabled } from "@/lib/settings/user-settings";
import { getEbayConnectionStatus } from "@/lib/marketplace/ebay";
import { setAutopilotSetting } from "@/app/(app)/upload/actions";
import { disconnectEbay } from "./actions";
import { Banner } from "@/components/ui/banner";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PendingButton } from "@/components/ui/button";
import { buttonClasses } from "@/components/ui/button-styles";
import { AppSignOutButton } from "@/components/sign-out-button";
import { StatusBadge } from "@/components/ui/badge";

/**
 * Settings (audit X-11): the autopilot master switch, moved out of the upload
 * footer so its consequence — listings can publish without per-item approval —
 * is explained where the seller decides it. Uses the existing server action.
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

  const autopilotEnabled = await getAutopilotEnabled(supabase, userId);
  const ebayConnection = await getEbayConnectionStatus(supabase);
  const email = await getUserEmail();

  return (
    <main className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-4 px-4 py-6 sm:px-6">
      <header>
        <h1 className="text-lg font-bold tracking-tight text-fg-strong">
          Settings
        </h1>
        <p className="mt-0.5 text-[13px] text-muted">
          Signed in as {email ?? "your account"}
        </p>
      </header>

      {error ? (
        <Banner variant="error" title="Couldn’t save that">
          {error}
        </Banner>
      ) : null}

      {ebay === "connected" ? (
        <Banner variant="success" title="eBay connected">
          Listings now publish under your own eBay account.
        </Banner>
      ) : null}

      <Card>
        <CardHeader
          title="Autopilot"
          aside={
            <StatusBadge
              label={autopilotEnabled ? "On" : "Off"}
              tone={autopilotEnabled ? "success" : "neutral"}
            />
          }
        />
        <CardBody className="flex flex-col gap-4">
          <p className="text-sm leading-relaxed text-muted">
            When autopilot is on, items we identify and price with{" "}
            <strong className="font-medium text-fg">high confidence</strong> are
            queued to publish <strong className="font-medium text-fg">without
            your per-item approval</strong>. Anything below that bar always waits
            for your review. Turn it off and every listing waits for you, no
            exceptions.
          </p>
          <form action={setAutopilotSetting}>
            <input
              type="hidden"
              name="enabled"
              value={autopilotEnabled ? "false" : "true"}
            />
            <PendingButton
              pendingLabel="Saving…"
              variant={autopilotEnabled ? "secondary" : "primary"}
            >
              {autopilotEnabled ? "Turn autopilot off" : "Turn autopilot on"}
            </PendingButton>
          </form>
          <p className="text-xs text-faint">
            Changing this affects new uploads — it never rewrites why a past
            listing was queued or held.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="eBay account"
          aside={
            <StatusBadge
              label={ebayConnection.connected ? "Connected" : "Not connected"}
              tone={ebayConnection.connected ? "success" : "neutral"}
            />
          }
        />
        <CardBody className="flex flex-col gap-4">
          {ebayConnection.connected ? (
            <>
              <p className="text-sm leading-relaxed text-muted">
                Connected as{" "}
                <strong className="font-medium text-fg">
                  {ebayConnection.ebayUsername ?? "your eBay account"}
                </strong>
                . Listings publish under this account. Your tokens are stored
                encrypted and you can disconnect at any time.
              </p>
              <form action={disconnectEbay}>
                <PendingButton pendingLabel="Disconnecting…" variant="secondary">
                  Disconnect eBay
                </PendingButton>
              </form>
            </>
          ) : (
            <>
              <p className="text-sm leading-relaxed text-muted">
                Connect your eBay account to publish listings under your own
                identity. You approve access on eBay’s consent screen — SnapList
                never sees your eBay password.
              </p>
              <a
                href="/api/ebay/connect"
                className={buttonClasses("primary", "md")}
              >
                Connect eBay
              </a>
            </>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Account" />
        <CardBody>
          {/* Clerk sign-out (issue #41) — the /auth/signout route is gone. */}
          <AppSignOutButton className="inline-flex items-center justify-center gap-2 rounded-md border border-border-strong bg-surface px-4 py-2 text-sm font-medium text-fg shadow-xs transition-colors hover:bg-surface-2" />
        </CardBody>
      </Card>
    </main>
  );
}
