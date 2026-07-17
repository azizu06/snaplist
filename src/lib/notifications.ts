import type { SupabaseClient } from "@supabase/supabase-js";
import { reportServerError } from "@/lib/sentry";

/**
 * In-app notifications (top-bar bell). Thin data layer over the
 * RLS-scoped `notifications` table — every function takes the caller's
 * Supabase client so reads/writes run AS the signed-in user (RLS enforces
 * tenancy; we never pass user_id into a read filter — the policy does it).
 *
 * `createNotification` is fire-and-forget: emitting a notification must never
 * break the primary action that triggered it (publishing a listing, a buyer
 * message landing), so it swallows + logs its own failures.
 */

export type NotificationKind =
  | "listing_ready"
  | "pipeline_failed"
  | "listing_published"
  | "listing_failed"
  | "buyer_message"
  | "system";

/** Serializable shape handed to the client bell. */
export interface NotificationView {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  href: string | null;
  read: boolean;
  /** ISO 8601 — formatted on the client with a stable UTC label. */
  createdAt: string;
}

export interface NewNotification {
  userId: string;
  kind: NotificationKind;
  title: string;
  body?: string | null;
  href?: string | null;
  itemId?: string | null;
  listingId?: string | null;
}

interface NotificationRow {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  href: string | null;
  read_at: string | null;
  created_at: string;
}

const KINDS: ReadonlySet<string> = new Set<NotificationKind>([
  "listing_ready",
  "pipeline_failed",
  "listing_published",
  "listing_failed",
  "buyer_message",
  "system",
]);

function toView(row: NotificationRow): NotificationView {
  return {
    id: row.id,
    kind: (KINDS.has(row.kind) ? row.kind : "system") as NotificationKind,
    title: row.title,
    body: row.body,
    href: row.href,
    read: row.read_at != null,
    createdAt: row.created_at,
  };
}

const SELECT = "id, kind, title, body, href, read_at, created_at" as const;

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

/** The user's most recent notifications, newest first (RLS scopes to them). */
export async function listRecentNotifications(
  supabase: SupabaseClient,
  limit = 20,
): Promise<NotificationView[]> {
  const { data, error } = await supabase
    .from("notifications")
    .select(SELECT)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return (data as NotificationRow[]).map(toView);
}

/** Count of the user's unread notifications (for the bell badge). */
export async function countUnreadNotifications(
  supabase: SupabaseClient,
): Promise<number> {
  const { count, error } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .is("read_at", null);
  if (error || count == null) return 0;
  return count;
}
