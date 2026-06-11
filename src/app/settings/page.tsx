import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserEmail, getUserId } from "@/lib/auth";
import { getAutopilotEnabled } from "@/lib/settings/user-settings";
import { setAutopilotSetting } from "@/app/upload/actions";
import { Banner } from "@/components/ui/banner";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PendingButton } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/badge";

/**
 * Settings (audit X-11): the autopilot master switch, moved out of the upload
 * footer so its consequence — listings can publish without per-item approval —
 * is explained where the seller decides it. Uses the existing server action.
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  const supabase = await createClient();
  const userId = await getUserId();
  if (!userId) redirect("/login?next=/settings");

  const autopilotEnabled = await getAutopilotEnabled(supabase, userId);
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
        <CardHeader title="Account" />
        <CardBody>
          <form action="/auth/signout" method="post">
            <PendingButton pendingLabel="Signing out…" variant="secondary">
              Sign out
            </PendingButton>
          </form>
        </CardBody>
      </Card>
    </main>
  );
}
