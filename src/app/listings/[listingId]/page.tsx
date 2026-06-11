import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { StatusBadge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/banner";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PendingButton, buttonClasses } from "@/components/ui/button";
import { lifecycleLabel } from "@/lib/ui/status";
import { publishToEbay } from "./actions";

/**
 * Listing publish page (issue #14; #40 skin). Reads the persisted eBay state
 * (`ebay_listing_id`, `ebay_status`) through the user-scoped client. Adds the
 * X-3/X-8/X-9 states around the unchanged publish action: pending button,
 * plain-language failure + retry, and a real success moment with next steps.
 */
export default async function ListingPage({
  params,
  searchParams,
}: {
  params: Promise<{ listingId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { listingId } = await params;
  const { error } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/listings/${listingId}`);

  // RLS scopes to the owner; a foreign/missing id returns no row → 404.
  const { data: listing } = await supabase
    .from("listings")
    .select(
      "id, item_id, platform, title, description, status, ebay_listing_id, ebay_status",
    )
    .eq("id", listingId)
    .maybeSingle();
  if (!listing) notFound();

  const published = listing.ebay_status === "published" && listing.ebay_listing_id;
  const failed = listing.ebay_status === "failed";
  const statusChip = lifecycleLabel(
    published ? "published" : (listing.status as string | null),
  );

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-5 px-4 py-8 sm:px-6 sm:py-10">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-fg-strong">
            Publish to eBay
          </h1>
          {statusChip ? (
            <StatusBadge label={statusChip.label} tone={statusChip.tone} />
          ) : null}
        </div>
        <Link
          href={`/review/${listing.item_id}`}
          className="text-sm text-muted hover:text-fg"
        >
          ← Back to review
        </Link>
      </header>

      {error ? (
        <Banner variant="error" title="Publishing didn’t go through">
          {error}
        </Banner>
      ) : null}

      {published ? (
        <Banner variant="success" title="Your listing is live on eBay">
          Buyers can see it now. eBay listing ID:{" "}
          <span className="font-mono" data-nums>
            {listing.ebay_listing_id}
          </span>
        </Banner>
      ) : null}

      <Card>
        <CardHeader
          title="Listing preview"
          aside={
            <span className="text-xs uppercase tracking-wide text-faint">
              {listing.platform}
            </span>
          }
        />
        <CardBody>
          <p className="text-lg font-semibold text-fg-strong">{listing.title}</p>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted">
            {listing.description}
          </p>
        </CardBody>
      </Card>

      {published ? (
        <Card>
          <CardHeader title="What’s next" />
          <CardBody className="flex flex-col gap-2.5">
            <Link
              href={`/export/${listing.item_id}`}
              className={buttonClasses("secondary")}
            >
              Cross-post to Facebook &amp; Mercari
            </Link>
            <Link href="/" className={buttonClasses("ghost")}>
              Back to dashboard
            </Link>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardHeader title="Publish" />
          <CardBody className="flex flex-col gap-3">
            {failed ? (
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
            <form action={publishToEbay}>
              <input type="hidden" name="listingId" value={listing.id} />
              <PendingButton
                pendingLabel="Publishing to eBay…"
                variant={failed ? "danger" : "primary"}
              >
                {failed ? "Retry publish" : "Publish to eBay"}
              </PendingButton>
            </form>
          </CardBody>
        </Card>
      )}
    </main>
  );
}
