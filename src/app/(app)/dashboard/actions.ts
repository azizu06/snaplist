"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getUserId } from "@/lib/auth";
import { reportServerError } from "@/lib/sentry";
import { bulkStatusDecision, isLiveListingRow } from "@/lib/ui/status";
import { parseCostBasis, parsePriceOverride } from "@/lib/pipeline/autopilot";

/**
 * Dashboard mutations (Shopify products-section mirror): archive / unarchive,
 * delete, and a batched quick-edit. Thin server actions following the
 * /listings/[listingId] pattern — auth guard + RLS-scoped writes, then
 * revalidate the dashboard so the list reflects reality.
 *
 * Tenancy: every write runs under the request-authed Supabase client, so
 * Postgres RLS (`public.clerk_user_id() = user_id`) already constrains which
 * rows the statement can touch — an attacker passing another user's id in the
 * array changes nothing. The `getUserId` guard is defense-in-depth (reject
 * anonymous calls early), matching the existing actions. No bypass path.
 */

/** `status` is free-text in the schema; the app owns the vocabulary. */
const ARCHIVED = "archived";

type DbClient = Awaited<ReturnType<typeof createClient>>;

/**
 * The subset of `listingIds` that are LIVE on eBay (ebay_listing_id set +
 * ebay_status "published"). A live listing's lifecycle is owned by the eBay state,
 * so dashboard mutations must never write a non-live status onto it and mislabel a
 * genuinely live listing (the dashboard derives its chip from listings.status).
 * Shared by archive + bulk-edit so the guard can't drift between them. Fails CLOSED:
 * if the read errors, every id is treated as live (→ the caller skips it) rather
 * than risk a desync. RLS scopes the read to the caller's own rows.
 */
async function liveListingIdSet(
  supabase: DbClient,
  listingIds: string[],
): Promise<Set<string>> {
  const live = new Set<string>();
  if (listingIds.length === 0) return live;
  const { data, error } = await supabase
    .from("listings")
    .select("id, ebay_listing_id, ebay_status")
    .in("id", listingIds);
  if (error) {
    reportServerError("dashboard.liveCheck", error, { count: listingIds.length });
    for (const id of listingIds) live.add(id);
    return live;
  }
  for (const r of data ?? []) {
    if (isLiveListingRow(r)) live.add(r.id as string);
  }
  return live;
}

export async function archiveListings(listingIds: string[]): Promise<void> {
  if (listingIds.length === 0) return;
  const supabase = await createClient();
  const userId = await getUserId();
  if (!userId) return;

  // Never archive a listing that's still LIVE on eBay: archiving hides it and marks
  // it Archived while the eBay listing is up, so the dashboard would show a live
  // listing as archived (Codex). Ending a real listing is the adapter's job, not an
  // archive toggle — skip live rows (report the skip), archive the rest.
  const live = await liveListingIdSet(supabase, listingIds);
  const archivable = listingIds.filter((id) => !live.has(id));
  if (live.size > 0) {
    reportServerError(
      "dashboard.archive",
      new Error(`skipped ${live.size} live eBay listing(s)`),
      { skipped: live.size },
    );
  }
  if (archivable.length > 0) {
    const { error } = await supabase
      .from("listings")
      .update({ status: ARCHIVED })
      .in("id", archivable);
    if (error) {
      reportServerError("dashboard.archive", error, { count: archivable.length });
    }
  }
  revalidatePath("/dashboard");
}

export async function unarchiveListings(listingIds: string[]): Promise<void> {
  if (listingIds.length === 0) return;
  const supabase = await createClient();
  const userId = await getUserId();
  if (!userId) return;

  // Restore to the lifecycle state the AUTHORITATIVE eBay fields imply, not a
  // blanket "draft": archiving overwrote listings.status, so a listing that is
  // actually live on eBay (ebay_listing_id set + ebay_status "published") must
  // come back as `published`. Restoring it to `draft` would show a live listing
  // as a re-publishable draft — corrupting tracking and inviting a redundant
  // publish (Codex). Anything not live returns to the review queue (`draft`); a
  // pre-archive `queued`/needs-review state collapsing to draft is benign (it
  // just asks for re-approval, no live-state loss).
  const { data: rows, error: readErr } = await supabase
    .from("listings")
    .select("id, ebay_listing_id, ebay_status")
    .in("id", listingIds);
  if (readErr) {
    reportServerError("dashboard.unarchive.read", readErr, { count: listingIds.length });
    return;
  }
  const live: string[] = [];
  const draft: string[] = [];
  for (const r of rows ?? []) {
    // Same `isLiveListingRow` predicate the archive + bulk-edit guards use, so the
    // definition of "live" can't drift; unarchive keeps its own read policy above
    // (a read error bails — restoring nothing — rather than fail-closed-as-live,
    // which here would wrongly re-publish everything).
    if (isLiveListingRow(r)) live.push(r.id as string);
    else draft.push(r.id as string);
  }

  const restore = (ids: string[], status: string) =>
    supabase
      .from("listings")
      .update({ status })
      .in("id", ids)
      .then(({ error }) => {
        if (error) reportServerError("dashboard.unarchive", error, { count: ids.length });
      });

  await Promise.all([
    ...(live.length > 0 ? [restore(live, "published")] : []),
    ...(draft.length > 0 ? [restore(draft, "draft")] : []),
  ]);
  revalidatePath("/dashboard");
}

/**
 * Destructive delete — removes the ITEM, which cascades to its listings,
 * messages, and prediction logs (FK `on delete cascade`). Gated behind a
 * confirm dialog in the UI.
 */
export async function deleteItems(itemIds: string[]): Promise<void> {
  if (itemIds.length === 0) return;
  const supabase = await createClient();
  const userId = await getUserId();
  if (!userId) return;

  // Read the RLS-scoped Storage paths BEFORE deleting the rows: the FK cascade
  // takes listings/messages/logs but NOT the private photo objects in the
  // `photos` bucket, and once the item row is gone we've lost the only reference
  // to them. Without this, deleting an item orphans its private images in Storage
  // even though the UI says it's permanently removed (Codex P2).
  const { data: items, error: readErr } = await supabase
    .from("items")
    .select("photos")
    .in("id", itemIds);
  if (readErr) {
    // Couldn't read the photo paths → deleting the rows now would ORPHAN the
    // private Storage objects (the FK cascade never touches the bucket, and the
    // row we'd remove is the only reference). Fail closed: abort + report so the
    // seller can retry, rather than silently leak their images while the UI says
    // "permanently removed" (Codex P2). Delete is idempotent, so bailing is safe.
    reportServerError("dashboard.delete.read", readErr, { count: itemIds.length });
    return;
  }
  const paths = (items ?? []).flatMap(
    (it) => ((it.photos as string[] | null) ?? []),
  );

  const { error } = await supabase.from("items").delete().in("id", itemIds);
  if (error) {
    // Row delete failed → leave the photos alone (the item still exists).
    reportServerError("dashboard.delete", error, { count: itemIds.length });
    revalidatePath("/dashboard");
    return;
  }

  // Best-effort Storage cleanup AFTER the row delete: the DB is the source of
  // truth for "deleted", and an orphaned object is recoverable by a sweep, whereas
  // a deleted object whose row survived is not. `.remove` runs under the
  // user-scoped client, so Storage RLS still confines it to the seller's own paths
  // (mirrors the upload rollback remove()).
  if (paths.length > 0) {
    const { error: storageErr } = await supabase.storage.from("photos").remove(paths);
    if (storageErr) {
      reportServerError("dashboard.delete.photos", storageErr, { count: paths.length });
    }
  }
  revalidatePath("/dashboard");
}

export interface BulkListingUpdate {
  itemId: string;
  listingId: string | null;
  /** New seller price → persisted as `items.price_override`. null clears it. */
  price?: number | null;
  /** New cost basis (#101) → `items.cost_basis`. null clears it (unknown); $0 is real. */
  costBasis?: number | null;
  /** New listing status (only when the item has a listing). */
  status?: string;
}

/**
 * Batched quick-edit (the repurposed "inventory" grid). Price lives on the item
 * (`price_override`); status lives on the listing. Each row is a small scoped
 * write; RLS constrains every one to the caller's rows.
 */
export async function bulkUpdateListings(updates: BulkListingUpdate[]): Promise<void> {
  if (updates.length === 0) return;
  const supabase = await createClient();
  const userId = await getUserId();
  if (!userId) return;

  // A listing that is live on eBay has its lifecycle owned by the eBay state, so a
  // bulk status write (draft/archived) must not desync it and mislabel a live
  // listing as a draft (Codex). Resolve the live set up front via the shared guard.
  const statusListingIds = updates
    .filter((u) => u.status !== undefined && u.listingId)
    .map((u) => u.listingId as string);
  const liveListingIds = await liveListingIdSet(supabase, statusListingIds);

  await Promise.all(
    updates.flatMap((u) => {
      // Supabase's builder is a thenable (PromiseLike), not a Promise; Promise.all
      // accepts PromiseLike, so type the bucket accordingly.
      const writes: PromiseLike<unknown>[] = [];
      // One merged `items` patch per row (price + cost basis) — a single write
      // instead of two concurrent updates racing on the same row.
      const itemPatch: { price_override?: number | null; cost_basis?: number | null } = {};
      if (u.price !== undefined) {
        // Re-validate at the write boundary with the SAME parser the review form
        // uses: null clears the override, otherwise it must be a positive amount.
        // The grid already blocks an invalid price, but a crafted request (or a
        // future caller) must never persist 0/negative/NaN as a price_override the
        // publish flow can't use (Codex P2). Reject → report, don't write junk.
        try {
          itemPatch.price_override = parsePriceOverride(u.price);
        } catch (err) {
          reportServerError(
            "dashboard.bulkUpdate.price",
            err instanceof Error ? err : new Error(String(err)),
            { itemId: u.itemId },
          );
        }
      }
      // Cost basis (#101): same write-boundary re-validation with the shared,
      // unit-tested parseCostBasis — null clears (unknown), $0 is a real
      // free-find zero, junk (negative/NaN/non-decimal) is rejected + reported
      // so a crafted request can't persist a poisoned margin input.
      if (u.costBasis !== undefined) {
        try {
          itemPatch.cost_basis = parseCostBasis(u.costBasis);
        } catch (err) {
          reportServerError(
            "dashboard.bulkUpdate.costBasis",
            err instanceof Error ? err : new Error(String(err)),
            { itemId: u.itemId },
          );
        }
      }
      if (Object.keys(itemPatch).length > 0) {
        writes.push(
          supabase
            .from("items")
            .update(itemPatch)
            .eq("id", u.itemId)
            .then(({ error }) => {
              if (error) reportServerError("dashboard.bulkUpdate.item", error, { itemId: u.itemId });
            }),
        );
      }
      // Status write boundary (Codex P1): bulk-edit may ONLY set the
      // seller-organizational statuses (draft / archived). `published` is owned by
      // the eBay publish path (it sets ebay_listing_id/ebay_status together) and
      // `queued` by the autopilot gate; writing either here would mark an unposted
      // item Live / queue it past the gate without ever touching the adapter. The
      // grid already hides those options — this rejects an out-of-vocabulary status
      // from a crafted request that bypassed the UI (defense-in-depth). RLS still
      // scopes the row; this scopes the VALUE. Reported, not silently dropped, so a
      // bypass attempt is auditable.
      if (u.status !== undefined && u.listingId) {
        // The pure, unit-tested decision (status/identity/lifecycle/test target):
        // reject an out-of-vocabulary status, skip a live eBay listing, else write.
        const decision = bulkStatusDecision({
          status: u.status,
          hasListing: true,
          isLive: liveListingIds.has(u.listingId),
        });
        if (decision === "reject-vocab") {
          reportServerError(
            "dashboard.bulkUpdate.status",
            new Error(`rejected non-bulk-editable status "${u.status}"`),
            { listingId: u.listingId },
          );
        } else if (decision === "skip-live") {
          // The listing is live on eBay — its status is owned by the eBay state, so
          // a bulk metadata edit must not move it to draft/archived and mislabel a
          // live listing as a draft (Codex). Skip + report.
          reportServerError(
            "dashboard.bulkUpdate.status",
            new Error(`refused to change status of a live eBay listing to "${u.status}"`),
            { listingId: u.listingId },
          );
        } else if (decision === "write") {
          writes.push(
            supabase
              .from("listings")
              .update({ status: u.status })
              .eq("id", u.listingId)
              .then(({ error }) => {
                if (error) reportServerError("dashboard.bulkUpdate.status", error, { listingId: u.listingId });
              }),
          );
        }
      }
      return writes;
    }),
  );
  revalidatePath("/dashboard");
}
