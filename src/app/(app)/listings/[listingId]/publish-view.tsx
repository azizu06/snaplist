"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";
import GlareHover from "@/components/bits/GlareHover";
import { StatusBadge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/banner";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PendingButton } from "@/components/ui/button";
import { buttonClasses } from "@/components/ui/button-styles";
import { lifecycleLabel } from "@/lib/ui/status";

/**
 * Publish — Shopify-style detail surface (issue #40 round 2): back-chevron
 * header with the listing title and an inline status chip, an animated
 * Draft → Queued → Live stepper, then white cards on the gray canvas —
 * Listing preview (field-styled blocks like the review page), and the
 * Publish / What's-next card. Pure presentation (client component only for
 * the motion polish) — the page (and the dev preview harness) feed the data,
 * and the publish server action passes through untouched.
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
  actionError: string | null;
}

/* ---- status stepper: Draft → Queued → Live -------------------------------- */

const STEPS = ["Draft", "Queued", "Live"] as const;

/** Map the persisted lifecycle status onto the stepper's active node. */
function activeStepIndex(status: string | null, published: boolean): number {
  if (published || status === "published") return 2;
  if (status === "queued") return 1;
  return 0; // draft / failed / new / unknown — still at the draft stage
}

function StatusStepper({ active, failed }: { active: number; failed: boolean }) {
  const reduced = useReducedMotion();

  return (
    <ol
      aria-label="Listing progress"
      className="flex w-full items-start rounded-xl border border-border bg-surface px-5 py-4 shadow-xs"
    >
      {STEPS.map((label, i) => {
        const done = i < active;
        const current = i === active;
        const danger = current && failed;

        return (
          <li
            key={label}
            aria-current={current ? "step" : undefined}
            className={`flex items-start ${i < STEPS.length - 1 ? "flex-1" : ""}`}
          >
            <div className="flex flex-col items-center gap-1.5">
              {done ? (
                <span className="flex size-7 items-center justify-center rounded-full bg-accent text-white">
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
                  className={`relative flex size-7 items-center justify-center rounded-full border-2 bg-surface ${
                    danger ? "border-danger" : "border-accent"
                  }`}
                >
                  <span
                    aria-hidden
                    className={`absolute inset-0 rounded-full motion-safe:animate-ping ${
                      danger ? "bg-danger/30" : "bg-accent/30"
                    }`}
                  />
                  <span
                    className={`relative size-2 rounded-full ${
                      danger ? "bg-danger" : "bg-accent"
                    }`}
                  />
                </span>
              ) : (
                <span className="flex size-7 rounded-full border-2 border-border bg-surface" />
              )}
              <span
                className={`text-[11px] font-medium ${
                  danger
                    ? "text-danger"
                    : current
                      ? "text-fg-strong"
                      : done
                        ? "text-muted"
                        : "text-faint"
                }`}
              >
                {label}
              </span>
            </div>
            {i < STEPS.length - 1 ? (
              <span
                aria-hidden
                className="relative mx-2 mt-[13px] h-0.5 flex-1 overflow-hidden rounded-full bg-border"
              >
                <motion.span
                  className="absolute inset-0 origin-left rounded-full bg-accent"
                  initial={reduced ? false : { scaleX: 0 }}
                  animate={{ scaleX: i < active ? 1 : 0 }}
                  transition={{
                    duration: 0.45,
                    ease: [0.22, 0.9, 0.3, 1],
                    delay: 0.05 + i * 0.08,
                  }}
                />
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
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

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 px-4 py-6 sm:px-6">
      {/* ---- header: back + title + chip (Shopify) ---- */}
      <header className="flex flex-wrap items-center gap-3">
        <Link
          href={`/review/${data.itemId}`}
          aria-label="Back to review"
          className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-muted shadow-xs transition-colors hover:text-fg"
        >
          <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </Link>
        <h1 className="min-w-0 flex-1 truncate font-display text-[22px] font-bold tracking-tight text-fg-strong">
          Publish to eBay
        </h1>
        {data.published ? (
          /* Live chip with a subtle pulse dot — same shell as the
             success-solid StatusBadge, plus the animate-ping inner span. */
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-success-solid bg-success-solid px-2.5 py-0.5 text-xs font-medium text-white">
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

      <StatusStepper
        active={activeStepIndex(data.status, data.published)}
        failed={failed}
      />

      {data.actionError ? (
        <Banner variant="error" title="Publishing didn’t go through">
          {data.actionError}
        </Banner>
      ) : null}

      {data.published ? (
        <Banner variant="success" title="Your listing is live on eBay">
          Buyers can see it now. eBay listing ID:{" "}
          <span className="font-mono" data-nums>
            {data.ebayListingId}
          </span>
        </Banner>
      ) : null}

      {/* react-bits GlareHover (app pass): violet glare sweep on hover over
          the preview of what buyers will see. */}
      <GlareHover>
        <Card>
          <CardHeader
            title="Listing preview"
            aside={
              <span className="text-xs uppercase tracking-wide text-faint">
                {data.platform}
              </span>
            }
          />
          <CardBody>
            <p className="text-sm font-semibold text-fg-strong">{data.title}</p>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted">
              {data.description}
            </p>
          </CardBody>
        </Card>
      </GlareHover>

      {data.published ? (
        <Card>
          <CardHeader title="What’s next" />
          <CardBody className="flex flex-col gap-2.5">
            <Link
              href={`/export/${data.itemId}`}
              className={buttonClasses("secondary")}
            >
              Cross-post to Facebook &amp; Mercari
            </Link>
            <Link href="/dashboard" className={buttonClasses("ghost")}>
              Back to dashboard
            </Link>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardHeader title="Publish" />
          <CardBody className="flex flex-col gap-3">
            {data.failed ? (
              <Banner variant="error" title="The last attempt failed">
                eBay rejected or errored on this listing. The draft is untouched —
                fix anything that needs it on the review page, then retry.
              </Banner>
            ) : (
              <p className="text-sm text-muted">
                Publishing creates the live eBay listing from this draft. You can
                still edit the price on the review page first.
              </p>
            )}
            <form action={publishAction}>
              <input type="hidden" name="listingId" value={data.listingId} />
              <PendingButton
                pendingLabel="Publishing to eBay…"
                variant={data.failed ? "danger" : "primary"}
              >
                {data.failed ? "Retry publish" : "Publish to eBay"}
              </PendingButton>
            </form>
          </CardBody>
        </Card>
      )}
    </main>
  );
}
