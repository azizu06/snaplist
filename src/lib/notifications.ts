import type { SupabaseClient } from "@supabase/supabase-js";
import { reportServerError } from "@/lib/sentry";

/**
 * In-app notification writes (top-bar bell). Thin data layer over the
 * RLS-scoped `notifications` table — every function takes the caller's
 * Supabase client so writes run AS the signed-in user (RLS enforces
 * tenancy; we never pass user_id into a read filter — the policy does it).
 *
 * `createNotification` is fire-and-forget: emitting a notification must never
 * break the primary action that triggered it (publishing a listing, a buyer
 * message landing), so it swallows + logs its own failures.
 *
 * Reads (recent list, unread count) live in `src/lib/home/projection.ts`,
 * which queries the same table directly as part of the Seller Home
 * projection rather than through this module.
 */

export type NotificationKind =
  | "listing_ready"
  | "pipeline_failed"
  | "listing_published"
  | "listing_failed"
  | "buyer_message"
  | "system";

export interface NewNotification {
  userId: string;
  kind: NotificationKind;
  title: string;
  body?: string | null;
  href?: string | null;
  itemId?: string | null;
  listingId?: string | null;
}

/**
 * Insert one notification for the user. Fire-and-forget: never throws, so a
 * callsite can `await` it without guarding the surrounding flow.
 */
export async function createNotification(
  supabase: SupabaseClient,
  input: NewNotification,
): Promise<void> {
  try {
    const { error } = await supabase.from("notifications").insert({
      user_id: input.userId,
      kind: input.kind,
      title: input.title,
      body: input.body ?? null,
      href: input.href ?? null,
      item_id: input.itemId ?? null,
      listing_id: input.listingId ?? null,
    });
    if (error) {
      reportServerError("notifications.create", new Error(error.message), {
        kind: input.kind,
      });
    }
  } catch (err) {
    reportServerError("notifications.create", err, { kind: input.kind });
  }
}
