import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { publishToEbay } from "./actions";

/**
 * Listing publish status page (issue #14) — the minimal, conflict-free
 * "shown in SnapList" surface for the eBay leg. Deliberately separate from the
 * review page (owned by another slice this wave): it reads the SAME persisted
 * columns (`ebay_listing_id`, `ebay_status`) through the user-scoped client, so
 * the review page can later render them without coordination.
 *
 * Shows the listing copy summary, the persisted eBay state, and a
 * "Publish to eBay" action (sandbox by default; production is an env flip).
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

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-6 py-12">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Listing</h1>
        <Link
          href={`/review/${listing.item_id}`}
          className="text-sm text-zinc-500 underline hover:text-zinc-800"
        >
          Back to review
        </Link>
      </header>

      {error ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-400">
          {listing.platform} draft
        </h2>
        <p className="text-lg font-semibold">{listing.title}</p>
        <p className="whitespace-pre-wrap text-sm text-zinc-600">
          {listing.description}
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-400">
          eBay
        </h2>

        {published ? (
          <div className="flex items-center gap-3">
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700">
              published
            </span>
            <span className="font-mono text-sm text-zinc-700">
              eBay listing id: {listing.ebay_listing_id}
            </span>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {failed ? (
              <span className="self-start rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700">
                last publish failed — retry below
              </span>
            ) : (
              <span className="self-start rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600">
                not published
              </span>
            )}
            <form action={publishToEbay}>
              <input type="hidden" name="listingId" value={listing.id} />
              <button
                type="submit"
                className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
              >
                Publish to eBay
              </button>
            </form>
          </div>
        )}
      </section>
    </main>
  );
}
