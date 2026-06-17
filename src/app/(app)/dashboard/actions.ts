"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getUserId } from "@/lib/auth";
import { reportServerError } from "@/lib/sentry";
import { isBulkEditableStatus } from "@/lib/ui/status";

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

  const { error } = await supabase.from("items").delete().in("id", itemIds);
  if (error) {
    reportServerError("dashboard.delete", error, { count: itemIds.length });
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
        writes.push(
          supabase
            .from("items")
            .update({ price_override: u.price })
            .eq("id", u.itemId)
            .then(({ error }) => {
              if (error) reportServerError("dashboard.bulkUpdate.price", error, { itemId: u.itemId });
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
