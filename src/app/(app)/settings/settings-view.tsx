import GlareHover from "@/components/bits/GlareHover";
import ShinyText from "@/components/bits/ShinyText";
import { Banner } from "@/components/ui/banner";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PendingButton } from "@/components/ui/button";
import { buttonClasses } from "@/components/ui/button-styles";
import { AppSignOutButton } from "@/components/sign-out-button";
import { StatusBadge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { ThemeSegmented } from "@/components/theme-toggle";
import type { ProfileUser } from "@/components/profile-menu";

/**
 * Settings — presentational surface (UI pass: the page was "Account + Sign
 * out", i.e. super plain). Now a proper stack of section cards in the
 * dashboard's house style: Profile (the signed-in human, same Clerk fields the
 * topbar avatar gets) → Autopilot → eBay connection → and the sign-out as a
 * clearly separated, destructive-ish card at the very bottom.
 *
 * Pure presentation over serializable props + server actions, so the page and
 * the dev preview harness render the identical screen.
 */

export interface SettingsData {
  user: ProfileUser;
  autopilotEnabled: boolean;
  ebay: { connected: boolean; ebayUsername: string | null };
  error: string | null;
  ebayBanner: "connected" | "disconnected" | null;
}

/** Violet-soft leading square for section-card headers (Stripe treatment). */
function SectionIcon({
  children,
  tone = "accent",
}: {
  children: React.ReactNode;
  tone?: "accent" | "danger";
}) {
  return (
    <span
      aria-hidden
      className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${
        tone === "danger"
          ? "bg-danger-soft text-danger-soft-fg"
          : "bg-accent-soft text-accent-soft-fg"
      }`}
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

function ContrastIcon() {
  return (
    <svg {...ICON_SVG_PROPS}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 18a6 6 0 0 0 0-12v12z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function SignOutIcon() {
  return (
    <svg {...ICON_SVG_PROPS}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  );
}

/** Big avatar — Clerk image when present, the topbar's initial gradient otherwise. */
function ProfileAvatar({ user }: { user: ProfileUser }) {
  const initial = (user.name || user.email || "?").charAt(0).toUpperCase();
  return (
    <span className="relative flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-full text-lg font-bold text-white shadow-xs ring-2 ring-border">
      {user.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- external Clerk avatar
        <img src={user.imageUrl} alt="" className="size-full object-cover" />
      ) : (
        <span className="flex size-full items-center justify-center bg-gradient-to-br from-[#7a73ff] to-[#a960ee]">
          {initial}
        </span>
      )}
    </span>
  );
}

export function SettingsView({
  data,
  autopilotAction,
  disconnectEbayAction,
}: {
  data: SettingsData;
  autopilotAction: (formData: FormData) => Promise<void>;
  disconnectEbayAction: (formData: FormData) => Promise<void>;
}) {
  const { user, autopilotEnabled, ebay } = data;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 px-4 py-6 sm:px-6">
      <header>
        <h1 className="font-display text-[22px] font-bold tracking-tight text-fg-strong">
          Settings
        </h1>
        <p className="mt-0.5 text-[13px] text-muted">
          Your account, autopilot, and marketplace connections.
        </p>
      </header>

      {data.error ? (
        <Banner variant="error" title="Couldn’t save that">
          {data.error}
        </Banner>
      ) : null}

      {data.ebayBanner === "connected" ? (
        <Banner variant="success" title="eBay connected">
          Listings now publish under your own eBay account.
        </Banner>
      ) : null}
      {data.ebayBanner === "disconnected" ? (
        <Banner variant="success" title="eBay disconnected">
          Your stored eBay tokens were deleted. Reconnect any time.
        </Banner>
      ) : null}

      {/* ---- Profile: the signed-in human, front and center ---- */}
      <GlareHover>
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2.5">
              <SectionIcon>
                <UserIcon />
              </SectionIcon>
              Profile
            </span>
          }
          aside={<StatusBadge label="Signed in" tone="success" />}
        />
        <CardBody className="flex flex-col gap-4">
          <div className="flex items-center gap-4">
            <ProfileAvatar user={user} />
            <div className="min-w-0">
              <p className="truncate text-[15px] font-semibold text-fg-strong">
                {user.name}
              </p>
              <p className="truncate text-[13px] text-muted">
                {user.email || "No email on file"}
              </p>
            </div>
          </div>
          <p className="text-xs text-faint">
            Your name and photo come from your sign-in provider. Update them
            there and they follow you here.
          </p>
        </CardBody>
      </Card>
      </GlareHover>

      {/* ---- Appearance: light / dark / system, persisted per device ---- */}
      <GlareHover>
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2.5">
              <SectionIcon>
                <ContrastIcon />
              </SectionIcon>
              Appearance
            </span>
          }
          aside={<ThemeSegmented />}
        />
        <CardBody>
          <p className="text-sm leading-relaxed text-muted">
            Choose how SnapList looks on this device.{" "}
            <strong className="font-medium text-fg">System</strong> follows
            your OS setting automatically.
          </p>
        </CardBody>
      </Card>
      </GlareHover>

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
              <form action={autopilotAction} className="flex items-center">
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
            Changing this affects new uploads; it never rewrites why a past
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
              label={ebay.connected ? "Connected" : "Not connected"}
              tone={ebay.connected ? "success" : "neutral"}
            />
          }
        />
        <CardBody className="flex flex-col gap-4">
          {ebay.connected ? (
            <>
              <p className="text-sm leading-relaxed text-muted">
                Connected as{" "}
                {/* react-bits ShinyText: a slow violet shimmer on the live
                    connection — the one celebratory note on this page. */}
                <ShinyText
                  text={ebay.ebayUsername ?? "your eBay account"}
                  color="var(--color-fg)"
                  shineColor="var(--color-iris)"
                  speed={3.5}
                  className="font-semibold"
                />
                . Listings publish under this account. Your tokens are stored
                encrypted and you can disconnect at any time.
              </p>
              <form action={disconnectEbayAction}>
                <PendingButton pendingLabel="Disconnecting…" variant="secondary">
                  Disconnect eBay
                </PendingButton>
              </form>
            </>
          ) : (
            <>
              <p className="text-sm leading-relaxed text-muted">
                Connect your eBay account to publish listings under your own
                identity. You approve access on eBay’s consent screen, and SnapList
                never sees your eBay password.
              </p>
              <a
                href="/api/ebay/connect"
                className={`${buttonClasses("primary", "md")} self-start`}
              >
                Connect eBay
              </a>
            </>
          )}
        </CardBody>
      </Card>
      </GlareHover>

      {/* ---- Sign out: separated, destructive-ish, last ---- */}
      <div className="mt-2 border-t border-border pt-4">
        <Card className="border-danger-border/60">
          <CardHeader
            title={
              <span className="flex items-center gap-2.5">
                <SectionIcon tone="danger">
                  <SignOutIcon />
                </SectionIcon>
                Sign out
              </span>
            }
          />
          <CardBody className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm leading-relaxed text-muted">
              Ends your session on this device. Your items, drafts, and
              connections stay exactly as you left them.
            </p>
            {/* Clerk sign-out (issue #41) — the /auth/signout route is gone. */}
            <AppSignOutButton className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-danger-border bg-surface px-4 py-2 text-sm font-semibold text-danger-soft-fg shadow-xs transition-colors hover:bg-danger-soft" />
          </CardBody>
        </Card>
      </div>
    </main>
  );
}
