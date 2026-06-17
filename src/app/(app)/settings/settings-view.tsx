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
import { BillingCta } from "./billing-cta";

/**
 * Settings — presentational surface, modelled on Shopify's grouped settings
 * pattern (Shopify web Jan 2024 #730/#720/#740): a vertical stack of section
 * cards under labelled groups (Account · Selling · Preferences), each card a
 * bold title + a muted descriptor line + its control + a quiet footnote, with
 * sign-out held out as a separate destructive card at the bottom.
 *
 * Pure presentation over serializable props + server actions, so the page and
 * the dev preview harness render the identical screen. Tokens only — no raw hex.
 */

export interface SettingsData {
  user: ProfileUser;
  autopilotEnabled: boolean;
  ebay: { connected: boolean; ebayUsername: string | null };
  /**
   * Plan & billing surface (#64). `tier` is the REAL entitlement from
   * `getEntitlement` (the Supabase mirror the Stripe webhook writes), so a Pro
   * subscriber actually shows Pro. `itemsPerDay` is the current tier's real
   * enforced daily allowance; `proItemsPerDay` is the paid tier's, for the
   * free→Pro teaser. Limits come straight from `tierLimits`, so the number shown
   * is the number actually enforced. `billingEnabled` (Stripe configured) decides
   * whether the free CTA starts a live checkout or links to marketing `/pricing`.
   */
  billing: {
    tier: "free" | "paid";
    itemsPerDay: number;
    proItemsPerDay: number;
    /** Whether direct-Stripe billing is configured (#64). When false, the free
     *  CTA points at marketing `/pricing` instead of starting a live checkout. */
    billingEnabled: boolean;
  };
  error: string | null;
  ebayBanner: "connected" | "disconnected" | null;
}

/** Green-soft leading square for section-card headers (Shopify section icon). */
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
      className={`flex size-7 shrink-0 items-center justify-center rounded-md ${
        tone === "danger"
          ? "bg-danger-soft text-danger-soft-fg"
          : "bg-accent-soft text-accent-soft-fg"
      }`}
    >
      {children}
    </span>
  );
}

/**
 * Shopify's group caption — a small, quiet label that splits the long settings
 * stack into scannable groups (Account · Selling · Preferences) the way
 * Shopify's left settings nav is grouped.
 */
function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="px-1 pt-3 text-[12px] font-semibold uppercase tracking-[0.06em] text-faint">
      {children}
    </h2>
  );
}

/** Muted descriptor line beneath a card title (Shopify settings-card pattern). */
function SectionDescription({ children }: { children: React.ReactNode }) {
  return <p className="text-[14px] leading-relaxed text-muted">{children}</p>;
}

/** Quiet closing footnote on a card — Shopify's small explanatory line. */
function CardNote({ children }: { children: React.ReactNode }) {
  return <p className="text-[13px] leading-relaxed text-faint">{children}</p>;
}

const ICON_SVG_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  className: "size-3.5",
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

function CreditCardIcon() {
  return (
    <svg {...ICON_SVG_PROPS}>
      <rect width="20" height="14" x="2" y="5" rx="2" />
      <path d="M2 10h20" />
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

/** Account-card avatar — Clerk image when present, a calm token-green initial otherwise. */
function ProfileAvatar({ user }: { user: ProfileUser }) {
  const initial = (user.name || user.email || "?").charAt(0).toUpperCase();
  return (
    <span className="relative flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-full ring-1 ring-border">
      {user.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- external Clerk avatar
        <img src={user.imageUrl} alt="" className="size-full object-cover" />
      ) : (
        <span className="flex size-full items-center justify-center bg-accent text-[18px] font-semibold text-accent-fg">
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
  const { user, autopilotEnabled, ebay, billing } = data;
  const isPaid = billing.tier === "paid";

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-2 px-4 py-6 sm:px-6">
      <header className="mb-1">
        <h1 className="font-display text-[22px] font-bold tracking-tight text-fg-strong">
          Settings
        </h1>
        <p className="mt-0.5 text-[14px] text-muted">
          Your account, selling connections, and app preferences.
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

      {/* ============================= Account ============================= */}
      <GroupLabel>Account</GroupLabel>

      {/* Profile — the signed-in human, led with Shopify's account-card treatment. */}
      <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <SectionIcon>
                  <UserIcon />
                </SectionIcon>
                Profile
              </span>
            }
            aside={<StatusBadge label="Signed in" tone="success" />}
          />
          <CardBody className="flex flex-col gap-3">
            <div className="flex items-center gap-3.5">
              <ProfileAvatar user={user} />
              <div className="min-w-0">
                <p className="truncate text-[15px] font-semibold text-fg-strong">
                  {user.name}
                </p>
                <p className="truncate text-[13.5px] text-muted">
                  {user.email || "No email on file"}
                </p>
              </div>
            </div>
            <CardNote>
              Your name and photo come from your sign-in provider. Update them
              there and they follow you here.
            </CardNote>
          </CardBody>
      </Card>

      {/* Plan & billing — real entitlement, daily allowance, upgrade path (#64).
          CTAs POST the billing routes via <BillingCta>: Upgrade → checkout,
          Manage billing → portal — the single billing interface. */}
      <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <SectionIcon>
                  <CreditCardIcon />
                </SectionIcon>
                Plan &amp; billing
              </span>
            }
            aside={
              <StatusBadge
                label={isPaid ? "Seller Pro" : "Free"}
                tone={isPaid ? "success" : "neutral"}
              />
            }
          />
          <CardBody className="flex flex-col gap-3.5">
            {isPaid ? (
              <>
                <SectionDescription>
                  You&apos;re on{" "}
                  <strong className="font-medium text-fg-strong">Seller Pro</strong>.
                  Identify, price, and list up to{" "}
                  <strong className="font-medium text-fg-strong">
                    {billing.itemsPerDay} items a day
                  </strong>
                  , with priority research and bulk uploads.
                </SectionDescription>
                <BillingCta
                  endpoint="/api/billing/portal"
                  label="Manage billing"
                  variant="secondary"
                />
              </>
            ) : (
              <>
                <SectionDescription>
                  You&apos;re on the{" "}
                  <strong className="font-medium text-fg-strong">Free</strong> plan —
                  every core feature, up to{" "}
                  <strong className="font-medium text-fg-strong">
                    {billing.itemsPerDay} items a day
                  </strong>
                  .
                </SectionDescription>
                <CardNote>
                  Seller Pro lifts that to {billing.proItemsPerDay} a day with priority
                  research and bulk uploads.
                  {billing.billingEnabled
                    ? " Beta users keep early-bird pricing."
                    : " It arrives after beta, and beta users keep early-bird pricing."}
                </CardNote>
                {billing.billingEnabled ? (
                  <BillingCta
                    endpoint="/api/billing/checkout"
                    label="Upgrade to Seller Pro"
                    variant="primary"
                  />
                ) : (
                  <a
                    href="/pricing"
                    className={`${buttonClasses("primary", "md")} self-start`}
                  >
                    See plans
                  </a>
                )}
              </>
            )}
          </CardBody>
      </Card>

      {/* ============================= Selling ============================= */}
      <GroupLabel>Selling</GroupLabel>

      {/* Autopilot — the confidence-gated auto-post toggle. */}
      <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
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
          <CardBody className="flex flex-col gap-3.5">
            <SectionDescription>
              When autopilot is on, items we identify and price with{" "}
              <strong className="font-medium text-fg-strong">high confidence</strong>{" "}
              are queued to publish{" "}
              <strong className="font-medium text-fg-strong">
                without your per-item approval
              </strong>
              . Anything below that bar always waits for your review. Turn it off and
              every listing waits for you, no exceptions.
            </SectionDescription>
            <CardNote>
              Changing this affects new uploads; it never rewrites why a past listing
              was queued or held.
            </CardNote>
          </CardBody>
      </Card>

      {/* eBay account — connected (disconnect) vs disconnected (connect) states. */}
      <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
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
          <CardBody className="flex flex-col gap-3.5">
            {ebay.connected ? (
              <>
                <SectionDescription>
                  Connected as{" "}
                  {/* react-bits ShinyText: a slow green shimmer on the live
                      connection — the one celebratory note on this page. */}
                  <ShinyText
                    text={ebay.ebayUsername ?? "your eBay account"}
                    color="var(--color-fg-strong)"
                    shineColor="var(--color-accent)"
                    speed={3.5}
                    className="font-semibold"
                  />
                  . Listings publish under this account. Your tokens are stored
                  encrypted and you can disconnect at any time.
                </SectionDescription>
                <form action={disconnectEbayAction}>
                  <PendingButton pendingLabel="Disconnecting…" variant="secondary">
                    Disconnect eBay
                  </PendingButton>
                </form>
              </>
            ) : (
              <>
                <SectionDescription>
                  Connect your eBay account to publish listings under your own
                  identity. You approve access on eBay’s consent screen, and SnapList
                  never sees your eBay password.
                </SectionDescription>
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

      {/* =========================== Preferences =========================== */}
      <GroupLabel>Preferences</GroupLabel>

      {/* Appearance — light / dark / system, persisted per device. */}
      <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <SectionIcon>
                  <ContrastIcon />
                </SectionIcon>
                Appearance
              </span>
            }
            aside={
              <div className="hidden sm:block">
                <ThemeSegmented />
              </div>
            }
          />
          <CardBody className="flex flex-col gap-3.5">
            <SectionDescription>
              Choose how SnapList looks on this device.{" "}
              <strong className="font-medium text-fg-strong">System</strong> follows
              your OS setting automatically.
            </SectionDescription>
            {/* Mobile: a 3-option segmented control can't fit beside the title
                without clipping "System", so it sits here full-width instead. */}
            <div className="sm:hidden">
              <ThemeSegmented />
            </div>
          </CardBody>
      </Card>

      {/* Sign out — held out as a separate, destructive-toned card, last. */}
      <div className="mt-3 border-t border-border pt-5">
        <Card className="border-danger-border/60">
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <SectionIcon tone="danger">
                  <SignOutIcon />
                </SectionIcon>
                Sign out
              </span>
            }
          />
          <CardBody className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
            <SectionDescription>
              Ends your session on this device. Your items, drafts, and connections
              stay exactly as you left them.
            </SectionDescription>
            {/* Clerk sign-out (issue #41) — the /auth/signout route is gone. */}
            <AppSignOutButton className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-danger-border bg-surface px-4 py-2 text-[14px] font-semibold text-danger-soft-fg shadow-xs transition-colors hover:bg-danger-soft" />
          </CardBody>
        </Card>
      </div>
    </main>
  );
}
