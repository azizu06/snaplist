import { z } from "zod";
import type { ExtractedAttributes } from "../pipeline/types";

/**
 * Buyer-inbox domain types (issue #13). The `messages` table (init schema) is the
 * storage; these types are the app-side contract for the simulated-buyer flow:
 *
 *   simulated buyer question → `messages` row (inbound, status `new`)
 *   → reply agent drafts (status `drafted`, `draft_reply` + `draft_model` set)
 *   → seller approves/edits → outbound row (status `sent`, threaded via `reply_to`)
 *     + inbound row marked `sent` with `sent_at` — delivery itself is STUBBED
 *     (logged no-op) until the eBay adapter lands (issue #14).
 */

/** `messages.direction` — who authored the message. */
export const messageDirectionSchema = z.enum(["inbound", "outbound"]);
export type MessageDirection = z.infer<typeof messageDirectionSchema>;

/**
 * `messages.status` lifecycle (app-validated; the column is free text).
 * Inbound rows walk new → drafted → sent; outbound rows are born `sent`.
 * `draft_failed` is the explicit terminal-until-retried state for an inbound
 * row whose draft generation crashed AFTER the insert (serverless interrupt,
 * model/database error) — without it the row would render "drafting…" forever
 * with no recovery path. `approved` is reserved for a future split of
 * "approve" from "send" — today the seller's approve action sends
 * immediately, so it is never persisted.
 */
export const messageStatusSchema = z.enum([
  "new",
  "drafted",
  "draft_failed",
  "approved",
  "sent",
]);
export type MessageStatus = z.infer<typeof messageStatusSchema>;

/**
 * One `messages` row as read by the inbox (and pushed over Realtime). Matches the
 * table columns (init schema + 20260610191000_messages_realtime).
 */
export const messageRowSchema = z.object({
  id: z.uuid(),
  // Clerk user ids are text ("user_…"), not uuids (issue #41 migration) — a
  // uuid validator here would silently drop every row in the inbox.
  user_id: z.string().min(1),
  item_id: z.uuid().nullable(),
  listing_id: z.uuid().nullable(),
  direction: messageDirectionSchema,
  body: z.string(),
  draft_reply: z.string().nullable(),
  status: z.string(),
  sent_at: z.string().nullable(),
  reply_to: z.uuid().nullable(),
  // Discriminates outbound rows that share a conversation root (20260617120000):
  // the canonical reply is null/'reply' (deduped by messages_canonical_reply_unique),
  // any number of seller FOLLOW-UPs are 'followup'. Optional so pre-migration rows
  // and the many MessageRow fixtures that predate the column still validate.
  reply_kind: z.string().nullable().optional(),
  draft_model: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type MessageRow = z.infer<typeof messageRowSchema>;

/** The listing copy the reply agent may ground a reply in (title + description). */
export interface ReplyListingContext {
  title: string;
  description: string;
}

/**
 * EVERYTHING the reply agent is allowed to know. The Zod-validated attribute core +
 * the generated listing copy — nothing else. The prompt AND the deterministic
 * hallucination guard both derive from exactly this object, so a reply can never
 * assert a fact that does not trace back to it (mirrors listing/generate.ts).
 */
export interface ReplyGrounding {
  attributes: ExtractedAttributes;
  listing: ReplyListingContext | null;
}
