import Link from "next/link";
import { StatusBadge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/banner";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PendingButton } from "@/components/ui/button";
import { buttonClasses } from "@/components/ui/button-styles";
import { lifecycleLabel } from "@/lib/ui/status";

/**
 * Publish — Shopify-style detail surface (issue #40 round 2): back-chevron
 * header with the listing title and an inline status chip, then white cards on
 * the gray canvas — Listing preview (field-styled blocks like the review
 * page), and the Publish / What's-next card. Pure presentation — the page
 * (and the dev preview harness) feed the data.
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

export function PublishView({
  data,
  publishAction,
}: {
  data: PublishData;
  publishAction: (formData: FormData) => Promise<void>;
}) {
  const statusChip = lifecycleLabel(data.published ? "published" : data.status);

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
        {statusChip ? (
          <StatusBadge label={statusChip.label} tone={statusChip.tone} dot={false} />
        ) : null}
      </header>

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
