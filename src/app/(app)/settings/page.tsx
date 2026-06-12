import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserEmail, getUserId } from "@/lib/auth";
import { getAutopilotEnabled } from "@/lib/settings/user-settings";
import { getEbayConnectionStatus } from "@/lib/marketplace/ebay";
import { setAutopilotSetting } from "@/app/(app)/upload/actions";
import { disconnectEbay } from "./actions";
import GlareHover from "@/components/bits/GlareHover";
import ShinyText from "@/components/bits/ShinyText";
import { Banner } from "@/components/ui/banner";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PendingButton } from "@/components/ui/button";
import { buttonClasses } from "@/components/ui/button-styles";
import { AppSignOutButton } from "@/components/sign-out-button";
import { StatusBadge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";

/** Violet-soft leading square for section-card headers (Stripe treatment). */
function SectionIcon({ children }: { children: React.ReactNode }) {
  return (
    <span
      aria-hidden
      className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-soft-fg"
    >
      {children}
    </span>
  );
}

const ICON_SVG_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  className: "size-4",
} as const;

function SparklesIcon() {
  return (
    <svg {...ICON_SVG_PROPS}>
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
      <path d="M20 3v4" />
      <path d="M22 5h-4" />
      <path d="M4 17v2" />
      <path d="M5 18H3" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg {...ICON_SVG_PROPS}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

function UserIcon() {
  return (
    <svg {...ICON_SVG_PROPS}>
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

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
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 px-4 py-6 sm:px-6">
      <header>
        <h1 className="font-display text-[22px] font-bold tracking-tight text-fg-strong">
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

      {/* react-bits GlareHover (app pass): a quiet violet glare sweep across
          each settings card on hover — chrome polish only, content untouched. */}
      <GlareHover>
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2.5">
              <SectionIcon>
                <SparklesIcon />
              </SectionIcon>
              Autopilot
            </span>
          }
          aside={
            <>
              <StatusBadge
                label={autopilotEnabled ? "On" : "Off"}
                tone={autopilotEnabled ? "success" : "neutral"}
              />
              <form action={setAutopilotSetting} className="flex items-center">
                <Switch
                  checked={autopilotEnabled}
                  name="enabled"
                  aria-label={
                    autopilotEnabled ? "Turn autopilot off" : "Turn autopilot on"
                  }
                />
              </form>
            </>
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
          <p className="text-xs text-faint">
            Changing this affects new uploads — it never rewrites why a past
            listing was queued or held.
          </p>
        </CardBody>
      </Card>
      </GlareHover>

      <GlareHover>
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2.5">
              <SectionIcon>
                <LinkIcon />
              </SectionIcon>
              eBay account
            </span>
          }
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
                {/* react-bits ShinyText: a slow violet shimmer on the live
                    connection — the one celebratory note on this page. */}
                <ShinyText
                  text={ebayConnection.ebayUsername ?? "your eBay account"}
                  color="#3d4a68"
                  shineColor="#6d4aff"
                  speed={3.5}
                  className="font-semibold"
                />
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
      </GlareHover>

      <GlareHover>
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2.5">
              <SectionIcon>
                <UserIcon />
              </SectionIcon>
              Account
            </span>
          }
        />
        <CardBody>
          {/* Clerk sign-out (issue #41) — the /auth/signout route is gone. */}
          <AppSignOutButton className="inline-flex items-center justify-center gap-2 rounded-md border border-border-strong bg-surface px-4 py-2 text-sm font-medium text-fg shadow-xs transition-colors hover:bg-surface-2" />
        </CardBody>
      </Card>
      </GlareHover>
    </main>
  );
}
