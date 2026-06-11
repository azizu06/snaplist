import type { SupabaseClient } from "@supabase/supabase-js";
import { messageRowSchema, type MessageRow } from "./types";

/**
 * Inbox persistence (issue #13). Every write goes through the caller's
 * USER-SCOPED Supabase client so RLS pins tenancy on each row (AGENTS.md
 * non-negotiable #1) — `user_id` is passed explicitly and WITH CHECK
 * (auth.uid() = user_id) rejects spoofed ownership. The `messages` table is in
 * the `supabase_realtime` publication (20260610191000), so each insert/update
 * here is what the live inbox receives over Realtime.
 *
 * Delivery is an injectable seam (`DeliverReply`). The default is a STUB that
 * logs and does nothing — the PRD keeps messaging simulated until the eBay
 * adapter (issue #14) swaps a real sender in behind the same type.
 */

export interface CreateBuyerMessageInput {
  /** The owning seller (must equal the client's auth.uid()). */
  userId: string;
  /** The item the (simulated) buyer is asking about. */
  itemId: string;
  /** The specific listing, when one exists. */
  listingId?: string | null;
  /** The buyer's question text. */
  body: string;
}

/**
 * Persist a simulated inbound buyer question (status `new`). The insert is the
 * Realtime event the inbox sees "live, no refresh".
 */
export async function createBuyerMessage(
  supabase: SupabaseClient,
  input: CreateBuyerMessageInput,
): Promise<MessageRow> {
  if (input.body.trim() === "") {
    throw new Error("createBuyerMessage requires a non-empty body");
  }
  const { data, error } = await supabase
    .from("messages")
    .insert({
      user_id: input.userId,
      item_id: input.itemId,
      listing_id: input.listingId ?? null,
      direction: "inbound",
      body: input.body,
      status: "new",
    })
    .select("*")
    .single();
  if (error || !data) {
    throw new Error(
      `Failed to create buyer message: ${error?.message ?? "no row returned"}`,
    );
  }
  return messageRowSchema.parse(data);
}

export interface AttachDraftReplyInput {
  messageId: string;
  /** The agent's grounded draft, pending seller approval. */
  draft: string;
  /** Model provenance for the draft (or the fallback marker). */
  model: string;
}

/**
 * Attach the agent's draft to the inbound message (status `new` → `drafted`).
 * The update is pushed over Realtime, so the inbox shows the draft appearing
 * under the question without a refresh.
 */
export async function attachDraftReply(
  supabase: SupabaseClient,
  input: AttachDraftReplyInput,
): Promise<MessageRow> {
  const { data, error } = await supabase
    .from("messages")
    .update({
      draft_reply: input.draft,
      draft_model: input.model,
      status: "drafted",
    })
    .eq("id", input.messageId)
    .select("*")
    .single();
  if (error || !data) {
    throw new Error(
      `Failed to attach draft reply: ${error?.message ?? "message not found"}`,
    );
  }
  return messageRowSchema.parse(data);
}

/**
 * The delivery seam. v1 is sandbox-only: the default implementation LOGS and
 * does nothing. The real eBay send (issue #14) replaces the default without
 * touching `approveAndSendReply` or its callers.
 */
export type DeliverReply = (args: {
  messageId: string;
  reply: string;
}) => Promise<void>;

/** Stubbed delivery: logged no-op (PRD: messaging simulated until the adapter). */
export const stubDeliverReply: DeliverReply = async ({ messageId, reply }) => {
  console.info(
    `[inbox] STUBBED delivery for message ${messageId} (sandbox — real send arrives with the eBay adapter, issue #14): ${JSON.stringify(
      reply,
    )}`,
  );
};

export interface ApproveAndSendReplyInput {
  /** The owning seller (must equal the client's auth.uid()). */
  userId: string;
  /** The inbound message being answered (already loaded under RLS). */
  message: Pick<MessageRow, "id" | "item_id" | "listing_id">;
  /** The seller-approved (possibly edited) reply text. */
  reply: string;
  /** Injectable delivery; defaults to the logged no-op stub. */
  deliver?: DeliverReply;
}

export interface ApproveAndSendReplyResult {
  /** The persisted outbound reply row (threaded to the inbound via reply_to). */
  outbound: MessageRow;
}

/**
 * The reply for this question was already claimed/sent (by a retry or a
 * concurrent request). Routes map this to HTTP 409 — it is an idempotent
 * "already done" signal, never a server error.
 */
export class ReplySendConflictError extends Error {
  constructor(message = "A reply was already sent for this message") {
    super(message);
    this.name = "ReplySendConflictError";
  }
}

/** Postgres unique_violation — the messages(reply_to) partial unique index. */
const PG_UNIQUE_VIOLATION = "23505";

/**
 * Seller approved (or edited) the reply → "send" it. Ordering is chosen so that
 * NO crash point leaves the question in a re-deliverable state (the delivery
 * adapter is non-idempotent, so double delivery is the failure we must rule out):
 *
 *   1. CLAIM the inbound question via compare-and-set: UPDATE → `sent` only
 *      WHERE status = 'drafted'. 0 rows → someone already claimed it →
 *      `ReplySendConflictError` (409). Concurrent sends race on this CAS and
 *      exactly one wins; the claim happens BEFORE the non-idempotent delivery.
 *   2. DELIVER via the injectable seam (stub logs; real send is issue #14).
 *   3. PERSIST the outbound reply row (threaded via `reply_to`, `sent_at`
 *      stamped). The partial unique index on messages(reply_to)
 *      (20260611004000) is the backstop: a unique violation means the reply
 *      already exists → treated as an idempotent conflict, not a 500.
 *
 * Crash semantics (deliberate): a crash AFTER the CAS claim but BEFORE delivery
 * (or before the outbound insert) leaves the question marked `sent` with no
 * outbound row — the seller may need to re-send manually, but a retry can never
 * deliver the same reply twice. We prefer "possibly undelivered, visibly stuck"
 * over "silently delivered twice".
 * Both writes ride Realtime to the live inbox.
 */
export async function approveAndSendReply(
  supabase: SupabaseClient,
  input: ApproveAndSendReplyInput,
): Promise<ApproveAndSendReplyResult> {
  const reply = input.reply.trim();
  if (reply === "") {
    throw new Error("approveAndSendReply requires a non-empty reply");
  }
  const deliver = input.deliver ?? stubDeliverReply;
  const sentAt = new Date().toISOString();

  // 1. Compare-and-set claim: only the request that flips drafted → sent may
  //    deliver. RLS still scopes the update to the owner's rows.
  const { data: claimed, error: claimErr } = await supabase
    .from("messages")
    .update({ status: "sent", sent_at: sentAt })
    .eq("id", input.message.id)
    .eq("status", "drafted")
    .select("id");
  if (claimErr) {
    throw new Error(`Failed to claim question for sending: ${claimErr.message}`);
  }
  if (!claimed || claimed.length === 0) {
    throw new ReplySendConflictError();
  }

  // 2. Deliver — only ever reached by the single CAS winner.
  await deliver({ messageId: input.message.id, reply });

  // 3. The outbound reply row. reply_to is uniquely indexed (partial), so a
  //    duplicate insert surfaces as an idempotent conflict.
  const { data: outbound, error: outboundErr } = await supabase
    .from("messages")
    .insert({
      user_id: input.userId,
      item_id: input.message.item_id,
      listing_id: input.message.listing_id,
      direction: "outbound",
      body: reply,
      status: "sent",
      reply_to: input.message.id,
      sent_at: sentAt,
    })
    .select("*")
    .single();
  if (outboundErr || !outbound) {
    if (outboundErr?.code === PG_UNIQUE_VIOLATION) {
      throw new ReplySendConflictError(
        "A reply row already exists for this message",
      );
    }
    throw new Error(
      `Failed to persist outbound reply: ${outboundErr?.message ?? "no row returned"}`,
    );
  }

  return { outbound: messageRowSchema.parse(outbound) };
}
