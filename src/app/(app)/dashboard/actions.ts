"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getUserId } from "@/lib/auth";
import { reportServerError } from "@/lib/sentry";
import { isBulkEditableStatus } from "@/lib/ui/status";
import { parsePriceOverride } from "@/lib/pipeline/autopilot";

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
/** Unarchiving returns a listing to the seller's review queue. */
const UNARCHIVED = "draft";

export async function archiveListings(listingIds: string[]): Promise<void> {
  if (listingIds.length === 0) return;
  const supabase = await createClient();
  const userId = await getUserId();
  if (!userId) return;

  const { error } = await supabase
    .from("listings")
    .update({ status: ARCHIVED })
    .in("id", listingIds);
  if (error) {
    reportServerError("dashboard.archive", error, { count: listingIds.length });
  }
  revalidatePath("/dashboard");
}

export async function unarchiveListings(listingIds: string[]): Promise<void> {
  if (listingIds.length === 0) return;
  const supabase = await createClient();
  const userId = await getUserId();
  if (!userId) return;

  const { error } = await supabase
    .from("listings")
    .update({ status: UNARCHIVED })
    .in("id", listingIds);
  if (error) {
    reportServerError("dashboard.unarchive", error, { count: listingIds.length });
  }
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
    reportServerError("dashboard.delete.read", readErr, { count: itemIds.length });
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

  await Promise.all(
    updates.flatMap((u) => {
      // Supabase's builder is a thenable (PromiseLike), not a Promise; Promise.all
      // accepts PromiseLike, so type the bucket accordingly.
      const writes: PromiseLike<unknown>[] = [];
      if (u.price !== undefined) {
        // Re-validate at the write boundary with the SAME parser the review form
        // uses: null clears the override, otherwise it must be a positive amount.
        // The grid already blocks an invalid price, but a crafted request (or a
        // future caller) must never persist 0/negative/NaN as a price_override the
        // publish flow can't use (Codex P2). Reject → report, don't write junk.
        let price: number | null = null;
        let priceOk = true;
        try {
          price = parsePriceOverride(u.price);
        } catch (err) {
          priceOk = false;
          reportServerError(
            "dashboard.bulkUpdate.price",
            err instanceof Error ? err : new Error(String(err)),
            { itemId: u.itemId },
          );
        }
        if (priceOk) {
          writes.push(
            supabase
              .from("items")
              .update({ price_override: price })
              .eq("id", u.itemId)
              .then(({ error }) => {
                if (error) reportServerError("dashboard.bulkUpdate.price", error, { itemId: u.itemId });
              }),
          );
        }
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
        if (!isBulkEditableStatus(u.status)) {
          reportServerError(
            "dashboard.bulkUpdate.status",
            new Error(`rejected non-bulk-editable status "${u.status}"`),
            { listingId: u.listingId },
          );
        } else {
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
