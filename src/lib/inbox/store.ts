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
 * Attach the agent's draft to the inbound message (status `new`/`draft_failed`
 * → `drafted`). The update is pushed over Realtime, so the inbox shows the
 * draft appearing under the question without a refresh.
 *
 * COMPARE-AND-SET: the update is guarded on the message still AWAITING a
 * draft. A redraft is slow (a model call), so by the time it returns a
 * concurrent draft may have attached — and been approved and SENT. An
 * unguarded write would downgrade that delivered reply back to an editable
 * draft. 0 rows matched → DraftAttachConflictError (the caller treats it as
 * an idempotent 409; the winning draft is already on the row).
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
    .in("status", ["new", "draft_failed"])
    .select("*")
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to attach draft reply: ${error.message}`);
  }
  if (!data) {
    throw new DraftAttachConflictError(
      "Message is not awaiting a draft (already drafted or sent).",
    );
  }
  return messageRowSchema.parse(data);
}

/** Thrown when a draft attach loses the race — the row already moved on. */
export class DraftAttachConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftAttachConflictError";
  }
}

/**
 * Mark an inbound message whose draft generation crashed (status `new` →
 * `draft_failed`) so the inbox renders a retryable failure instead of
 * "drafting…" forever. Guarded on the CURRENT status being `new`: a
 * concurrent draft that already attached (or a sent reply) is never
 * downgraded. Best-effort by contract — callers invoke it from a failure
 * path and must not let it mask the original error.
 */
export async function markDraftFailed(
  supabase: SupabaseClient,
  messageId: string,
): Promise<void> {
  await supabase
    .from("messages")
    .update({ status: "draft_failed" })
    .eq("id", messageId)
    .eq("status", "new")
    .then(undefined, () => undefined);
}

/**
 * The delivery seam. v1 is sandbox-only: the default implementation LOGS and
 * does nothing. The real eBay send (issue #14) replaces the default without
 * touching `approveAndSendReply` or its callers.
 *
 * IDEMPOTENCY CONTRACT: `idempotencyKey` is stable across send + every retry
 * of the same inbound question (it is the inbound message id). A real adapter
 * MUST deduplicate on it (e.g. pass it as the marketplace idempotency token),
 * because recovery can re-invoke delivery after a crash that lost the
 * outbound row — the unique DB index deduplicates the ROW, only this key can
 * deduplicate the external side effect.
 */
export type DeliverReply = (args: {
  messageId: string;
  reply: string;
  /** Stable per-inbound-question key; identical on send and every retry. */
  idempotencyKey: string;
}) => Promise<void>;

/** Stubbed delivery: logged no-op (PRD: messaging simulated until the adapter). */
export const stubDeliverReply: DeliverReply = async ({
  messageId,
  reply,
  idempotencyKey,
}) => {
  console.info(
    `[inbox] STUBBED delivery for message ${messageId} (idempotency key ${idempotencyKey}; sandbox — real send arrives with the eBay adapter, issue #14): ${JSON.stringify(
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
 * outbound row. That state is detectable (inbound `sent` + no outbound row
 * referencing it), the inbox renders it as "not delivered", and it is
 * RECOVERABLE via `retryReplyDelivery` — an intentional, seller-initiated
 * retry, never an automatic re-send of this function. We prefer "possibly
 * undelivered, visibly recoverable" over "silently delivered twice".
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
  //    deliver. RLS still scopes the update to the owner's rows. The claim
  //    also persists the APPROVED (possibly seller-edited) text into
  //    draft_reply: if delivery fails after this point, retryReplyDelivery
  //    re-reads draft_reply, and it must be the text the seller approved —
  //    never the stale agent draft they edited away.
  const { data: claimed, error: claimErr } = await supabase
    .from("messages")
    .update({ status: "sent", sent_at: sentAt, draft_reply: reply })
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
  await deliver({
    messageId: input.message.id,
    reply,
    // Stable across this send AND any later retry of the same question.
    idempotencyKey: input.message.id,
  });

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

export interface SendFollowUpMessageInput {
  /** The owning seller (must equal the client's auth.uid()). */
  userId: string;
  /** The conversation root (the inbound question) this follow-up belongs to. */
  message: Pick<MessageRow, "id" | "item_id" | "listing_id">;
  /** The seller's free-text follow-up ("Hold on, let me check…"). */
  body: string;
  /** Injectable delivery; defaults to the logged no-op stub. */
  deliver?: DeliverReply;
}

/**
 * Send a FOLLOW-UP message in a conversation the seller has already replied to.
 *
 * eBay's member messaging is not one-and-done (AddMemberMessageRTQ / AddMember-
 * MessagesAAQToBidder let a seller send many messages per thread), so after the
 * canonical reply the seller can keep messaging the buyer. A follow-up is an
 * outbound row threaded to the same conversation root (`reply_to` = the inbound
 * question) but marked `reply_kind = 'followup'`, so the
 * messages_canonical_reply_unique index (which only covers the canonical reply)
 * never rejects it. Unlike `approveAndSendReply` there is NO status CAS and NO
 * draft: a follow-up is plain seller-authored text, allowed any number of times.
 *
 * v1 ORDERING (deliberate, simpler than the canonical path): insert the row,
 * THEN deliver keyed by the new row id. While delivery is the stubbed no-op this
 * is equivalent to the canonical path; it also gives a real adapter a stable
 * per-follow-up idempotency key. Parity with the canonical claim/retry rigor
 * (deliver-before-persist, crash recovery) lands with the real eBay adapter (#14).
 */
export async function sendFollowUpMessage(
  supabase: SupabaseClient,
  input: SendFollowUpMessageInput,
): Promise<ApproveAndSendReplyResult> {
  const body = input.body.trim();
  if (body === "") {
    throw new Error("sendFollowUpMessage requires a non-empty message");
  }
  const deliver = input.deliver ?? stubDeliverReply;
  const sentAt = new Date().toISOString();

  // Persist the follow-up first: its id is the delivery idempotency key, and the
  // thread (read over Realtime) is the source of truth for what was sent.
  const { data: outbound, error: outboundErr } = await supabase
    .from("messages")
    .insert({
      user_id: input.userId,
      item_id: input.message.item_id,
      listing_id: input.message.listing_id,
      direction: "outbound",
      body,
      status: "sent",
      reply_to: input.message.id,
      reply_kind: "followup",
      sent_at: sentAt,
    })
    .select("*")
    .single();
  if (outboundErr || !outbound) {
    throw new Error(
      `Failed to persist follow-up message: ${outboundErr?.message ?? "no row returned"}`,
    );
  }

  const row = messageRowSchema.parse(outbound);

  // Deliver via the injectable seam (stub logs; real send is issue #14). Keyed
  // by the persisted row id so a real adapter can dedupe this specific message.
  await deliver({
    messageId: input.message.id,
    reply: body,
    idempotencyKey: row.id,
  });

  return { outbound: row };
}

export interface RetryReplyDeliveryInput {
  /** The owning seller (must equal the client's auth.uid()). */
  userId: string;
  /** The claimed-but-undelivered inbound question (already loaded under RLS). */
  message: Pick<MessageRow, "id" | "item_id" | "listing_id">;
  /** The reply text to (re)deliver — the persisted draft the claim was for. */
  reply: string;
  /** Injectable delivery; defaults to the logged no-op stub. */
  deliver?: DeliverReply;
}

/**
 * Recovery path for the send flow's documented crash gap: the inbound question
 * is `sent` (the CAS claim won) but delivery failed / the process crashed
 * before the outbound row was inserted. The seller sees "not delivered" in the
 * inbox and explicitly retries.
 *
 *   1. VERIFY the claim: no outbound row references this question via
 *      `reply_to`. An existing row means the reply was already delivered →
 *      `ReplySendConflictError` (409, idempotent "already done").
 *   2. RE-DELIVER via the injectable seam.
 *   3. INSERT the outbound row. The partial unique index on messages(reply_to)
 *      (20260611004000) is the authoritative dedupe: a 23505 means a concurrent
 *      retry already persisted the reply → idempotent conflict, not a 500.
 *
 * Honest concurrency semantics: unlike the send path, the existence check in
 * step 1 is a plain read, NOT a compare-and-set — two truly concurrent retries
 * can both pass it and both reach delivery. The unique index then collapses
 * them to exactly ONE outbound row (the loser gets 23505 → conflict), but
 * delivery itself may at worst run twice on that race. This mirrors the send
 * path's reasoning (the index dedupes the row, not the side effect); the
 * window is acceptable here because retry is an explicit human action on an
 * already-failed delivery, never an automated loop.
 *
 * The caller (the retry route) verifies the inbound row is `sent` under RLS
 * before invoking — no status CAS is re-run here.
 */
export async function retryReplyDelivery(
  supabase: SupabaseClient,
  input: RetryReplyDeliveryInput,
): Promise<ApproveAndSendReplyResult> {
  const reply = input.reply.trim();
  if (reply === "") {
    throw new Error("retryReplyDelivery requires a non-empty reply");
  }
  const deliver = input.deliver ?? stubDeliverReply;
  const sentAt = new Date().toISOString();

  // 1. The claim: no outbound row may already reference this question.
  const { data: existing, error: existingErr } = await supabase
    .from("messages")
    .select("id")
    .eq("reply_to", input.message.id)
    .eq("direction", "outbound")
    .limit(1);
  if (existingErr) {
    throw new Error(
      `Failed to check for an existing reply: ${existingErr.message}`,
    );
  }
  if (existing && existing.length > 0) {
    throw new ReplySendConflictError(
      "A reply was already delivered for this message",
    );
  }

  // 2. Re-attempt the delivery that previously failed.
  await deliver({
    messageId: input.message.id,
    reply,
    // SAME key as the original send: the adapter's dedupe is what makes
    // recovery safe when the outbound row was lost after a real delivery.
    idempotencyKey: input.message.id,
  });

  // 3. Persist the outbound row — the unique reply_to index collapses a
  //    concurrent double-retry to one row (23505 → idempotent conflict).
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
