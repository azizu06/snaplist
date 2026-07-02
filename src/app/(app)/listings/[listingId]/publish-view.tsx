"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";
import GlareHover from "@/components/bits/GlareHover";
import { StatusBadge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/banner";
import { PendingButton } from "@/components/ui/button";
import { buttonClasses } from "@/components/ui/button-styles";
import { lifecycleLabel } from "@/lib/ui/status";

/**
 * Publish — modelled on Shopify's single-record edit page (reference set
 * "Shopify web Jan 2024" 326 / 329 / 331): a back-chevron + record-name + status
 * top bar, then a two-column split — a wide LEFT main column holding the record
 * preview, and a narrow RIGHT rail of cards (a "Publishing" card carrying the
 * status spine + the publish action, plus a "Listing details" card). On mobile
 * the rail stacks under the preview (mobile-first). The Draft → Queued → Live
 * stepper is the publishing status spine; the live state turns the rail green
 * and surfaces the real eBay listing id. Pure presentation (client only for the
 * motion); the page feeds data and the publish server action passes through.
 */

export interface PublishData {
  listingId: string;
  itemId: string;
  platform: string;
  title: string;
  description: string;
  /** Raw persisted lifecycle status ("draft" | "queued" | ...). */
  status: string | null;
  published: boolean;
  failed: boolean;
  ebayListingId: string | null;
  /** Signed thumbnail URL for the buyer-preview card, or null. */
  photoUrl: string | null;
  actionError: string | null;
}

/** Dash-accented small-caps eyebrow — shared lifecycle-screen section label. */
function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.15em] text-faint">
      <span aria-hidden className="h-[2px] w-6 rounded-full bg-accent" />
      {children}
    </span>
  );
}

/* ---- status stepper: Draft → Queued → Live -------------------------------- */
/* Shopify's "Publishing" card lists where a record stands; here that becomes a
 * vertical lifecycle spine so it reads cleanly inside the narrow right rail. */

const STEPS = [
  { label: "Draft", hint: "Generated from your photos" },
  { label: "Queued", hint: "Ready to go live" },
  { label: "Live", hint: "Visible to buyers on eBay" },
] as const;

/** Map the persisted lifecycle status onto the stepper's active node. */
function activeStepIndex(status: string | null, published: boolean): number {
  if (published || status === "published") return 2;
  if (status === "queued") return 1;
  return 0; // draft / failed / new / unknown — still at the draft stage
}

function StatusStepper({ active, failed }: { active: number; failed: boolean }) {
  const reduced = useReducedMotion();

  return (
    <ol aria-label="Listing progress" className="flex flex-col">
      {STEPS.map((step, i) => {
        const done = i < active;
        const current = i === active;
        const danger = current && failed;
        const last = i === STEPS.length - 1;

        return (
          <li key={step.label} className="flex gap-3">
            {/* node + connector rail */}
            <div className="flex flex-col items-center">
              {done ? (
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg">
                  <motion.svg
                    viewBox="0 0 24 24"
                    className="size-3.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                    initial={reduced ? false : { scale: 0, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{
                      type: "spring",
                      stiffness: 480,
                      damping: 26,
                      delay: 0.1 + i * 0.08,
                    }}
                  >
                    <path d="m5 12 5 5 9-9" />
                  </motion.svg>
                </span>
              ) : current ? (
                <span
                  className={`relative flex size-6 shrink-0 items-center justify-center rounded-full border-2 bg-surface ${
                    danger ? "border-danger" : "border-accent"
                  }`}
                >
                  <span
                    aria-hidden
                    className={`absolute inset-0 rounded-full motion-safe:animate-ping ${
                      danger ? "bg-danger/25" : "bg-accent/25"
                    }`}
                  />
                  <span
                    className={`relative size-2 rounded-full ${
                      danger ? "bg-danger" : "bg-accent"
                    }`}
                  />
                </span>
              ) : (
                <span className="flex size-6 shrink-0 rounded-full border-2 border-border bg-surface" />
              )}
              {!last ? (
                <span
                  aria-hidden
                  className="relative my-1 w-0.5 flex-1 overflow-hidden rounded-full bg-border"
                >
                  <motion.span
                    className="absolute inset-0 origin-top rounded-full bg-accent"
                    initial={reduced ? false : { scaleY: 0 }}
                    animate={{ scaleY: i < active ? 1 : 0 }}
                    transition={{
                      duration: 0.45,
                      ease: [0.22, 0.9, 0.3, 1],
                      delay: 0.05 + i * 0.08,
                    }}
                  />
                </span>
              ) : null}
            </div>
            {/* labels */}
            <div className={last ? "pb-0" : "pb-4"}>
              <p
                className={`text-[13.5px] font-semibold leading-6 ${
                  danger
                    ? "text-danger"
                    : current
                      ? "text-fg-strong"
                      : done
                        ? "text-fg"
                        : "text-faint"
                }`}
              >
                {step.label}
              </p>
              <p className="text-[12.5px] leading-snug text-muted">{step.hint}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/* ---- right-rail cards ------------------------------------------------------ */

function RailCard({
  children,
  tone = "default",
}: {
  children: React.ReactNode;
  tone?: "default" | "success";
}) {
  return (
    <section
      className={`rounded-2xl border bg-surface p-4 shadow-xs sm:p-5 ${
        tone === "success" ? "border-success-border" : "border-border"
      }`}
    >
      {children}
    </section>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <dt className="text-[13px] text-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right text-[13.5px] font-medium text-fg-strong">
        {children}
      </dd>
    </div>
  );
}

export function PublishView({
  data,
  publishAction,
}: {
  data: PublishData;
  publishAction: (formData: FormData) => Promise<void>;
}) {
  const statusChip = lifecycleLabel(data.published ? "published" : data.status);
  const failed =
    data.failed || data.status === "failed" || data.status === "draft_failed";
  // Brand casing: naive capitalization would render "Ebay" — special-case it
  // before the generic fallback for any future platform value.
  const platformLabel =
    !data.platform || data.platform === "ebay"
      ? "eBay"
      : data.platform.charAt(0).toUpperCase() + data.platform.slice(1);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8">
      {/* ---- top bar: back + record name + status (Shopify 326/329) ---- */}
      <header className="flex flex-wrap items-center gap-3">
        <Link
          href={`/review/${data.itemId}`}
          aria-label="Back to review"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-muted shadow-xs transition-colors hover:text-fg"
        >
          <svg
            viewBox="0 0 24 24"
            className="size-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m15 18-6-6 6-6" />
          </svg>
        </Link>
        <h1 className="min-w-0 flex-1 truncate font-display text-[22px] font-bold tracking-tight text-fg-strong">
          Publish to eBay
        </h1>
        {data.published ? (
          /* Live chip with a subtle pulse dot — same shell as the
             success-solid StatusBadge, plus the animate-ping inner span. */
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-success-solid bg-success-solid px-2.5 py-0.5 text-[13px] font-medium text-white">
            <span aria-hidden className="relative flex size-1.5 shrink-0">
              <span className="absolute inline-flex h-full w-full rounded-full bg-white/80 motion-safe:animate-ping" />
              <span className="relative inline-flex size-1.5 rounded-full bg-white" />
            </span>
            {statusChip?.label ?? "Live"}
          </span>
        ) : statusChip ? (
          <StatusBadge label={statusChip.label} tone={statusChip.tone} dot={false} />
        ) : null}
      </header>

      {data.actionError ? (
        <Banner variant="error" title="Publishing didn’t go through">
          {data.actionError}
        </Banner>
      ) : null}

      {/* ---- two-column record body: preview (main) + publishing rail ---- */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        {/* main column — buyer-preview card (leads with the item photo) */}
        <GlareHover borderRadius="1rem" className="self-start">
          <figure
            className={`group overflow-hidden rounded-2xl border bg-surface shadow-xs ${
              data.published ? "border-success-border" : "border-border"
            }`}
          >
            {data.photoUrl ? (
              <div className="relative aspect-[16/9] overflow-hidden bg-surface-2">
                {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed Storage URL */}
                <img
                  src={data.photoUrl}
                  alt={data.title}
                  className="size-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.03] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
                />
                {data.published ? (
                  <span className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-success-solid px-2.5 py-1 text-[12px] font-semibold text-white shadow-sm">
                    <span aria-hidden className="relative flex size-1.5">
                      <span className="absolute inline-flex h-full w-full rounded-full bg-white/80 motion-safe:animate-ping" />
                      <span className="relative inline-flex size-1.5 rounded-full bg-white" />
                    </span>
                    Live on eBay
                  </span>
                ) : (
                  <span className="absolute left-3 top-3 rounded-full bg-fg-strong/80 px-2.5 py-1 text-[11.5px] font-semibold text-white backdrop-blur">
                    Buyer preview
                  </span>
                )}
              </div>
            ) : null}
            <figcaption className="p-4 sm:p-5">
              <div className="flex items-center justify-between gap-2">
                <Eyebrow>Listing preview</Eyebrow>
                <span className="text-[12px] uppercase tracking-wide text-faint">
                  {platformLabel}
                </span>
              </div>
              <p className="mt-3 text-[16px] font-semibold leading-snug text-fg-strong break-words">
                {data.title}
              </p>
              <p className="mt-2 whitespace-pre-wrap break-words text-[14.5px] leading-relaxed text-muted">
                {data.description}
              </p>
            </figcaption>
          </figure>
        </GlareHover>

        {/* right rail — Publishing card + Listing details */}
        <aside className="flex flex-col gap-4">
          <RailCard tone={data.published ? "success" : "default"}>
            <Eyebrow>Publishing</Eyebrow>
            <div className="mt-4">
              <StatusStepper
                active={activeStepIndex(data.status, data.published)}
                failed={failed}
              />
            </div>

            {data.published ? (
              <div className="mt-4 border-t border-border pt-4">
                <Banner variant="success" title="Your listing is live on eBay">
                  Buyers can see it now.
                </Banner>
                <div className="mt-3 flex flex-col gap-2.5">
                  <Link
                    href={`/export/${data.itemId}`}
                    className={buttonClasses("secondary")}
                  >
                    Cross-post to Facebook &amp; Mercari
                  </Link>
                  <Link href="/dashboard" className={buttonClasses("ghost")}>
                    Back to dashboard
                  </Link>
                </div>
              </div>
            ) : (
              <div className="mt-4 border-t border-border pt-4">
                {failed ? (
                  <Banner variant="error" title="The last attempt failed">
                    eBay rejected or errored on this listing. The draft is
                    untouched — fix anything on the review page, then retry.
                  </Banner>
                ) : (
                  <p className="text-[13.5px] leading-relaxed text-muted">
                    Publishing creates the live eBay listing from this draft. You
                    can still edit the price on the review page first.
                  </p>
                )}
                <form action={publishAction} className="mt-3">
                  <input type="hidden" name="listingId" value={data.listingId} />
                  <PendingButton
                    pendingLabel="Publishing to eBay…"
                    variant={failed ? "danger" : "primary"}
                    className="w-full"
                  >
                    {failed ? "Retry publish" : "Publish to eBay"}
                  </PendingButton>
                </form>
              </div>
            )}
          </RailCard>

          <RailCard>
            <Eyebrow>Listing details</Eyebrow>
            <dl className="mt-2 divide-y divide-border">
              <DetailRow label="Marketplace">{platformLabel}</DetailRow>
              <DetailRow label="Status">{statusChip?.label ?? "Draft"}</DetailRow>
              {data.published && data.ebayListingId ? (
                <DetailRow label="eBay listing ID">
                  <span className="font-mono" data-nums>
                    {data.ebayListingId}
                  </span>
                </DetailRow>
              ) : null}
            </dl>
          </RailCard>
        </aside>
      </div>
    </main>
  );
}
