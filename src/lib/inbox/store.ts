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
 * Seller approved (or edited) the reply → "send" it:
 *   1. deliver via the injectable seam (stub logs; real send is issue #14);
 *   2. persist the outbound reply row (direction `outbound`, status `sent`,
 *      `reply_to` threading it to the question, `sent_at` stamped);
 *   3. mark the inbound question `sent` so the inbox stops offering the draft.
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

  // 1. "Deliver" first: if a real sender ever fails, nothing is persisted as sent.
  await deliver({ messageId: input.message.id, reply });

  // 2. The outbound reply row.
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
    throw new Error(
      `Failed to persist outbound reply: ${outboundErr?.message ?? "no row returned"}`,
    );
  }

  // 3. Close out the inbound question.
  const { error: updateErr } = await supabase
    .from("messages")
    .update({ status: "sent", sent_at: sentAt })
    .eq("id", input.message.id);
  if (updateErr) {
    throw new Error(`Failed to mark question as sent: ${updateErr.message}`);
  }

  return { outbound: messageRowSchema.parse(outbound) };
}
