import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { ReplySendConflictError, retryReplyDelivery } from "@/lib/inbox";

/**
 * POST /api/inbox/[messageId]/retry-delivery — recover the send flow's crash
 * gap (issue #13, PR #35 review). The inbound question won the CAS claim
 * (status `sent`) but delivery failed / crashed before the outbound row was
 * inserted, so the inbox shows "not delivered" and the seller explicitly
 * retries.
 *
 * The claim verified here + in the store: the inbound row is `sent` AND no
 * outbound row references it. No new status CAS is needed — `sent` is already
 * terminal for the inbound row; the partial unique index on messages(reply_to)
 * collapses a concurrent double-retry to one outbound row (23505 → 409,
 * idempotent). The re-delivered text is the persisted draft (the seller's
 * in-flight edit, if any, died with the crash and was never stored).
 */

const paramsSchema = z.object({ messageId: z.uuid() });

export async function POST(
  _request: Request,
  context: { params: Promise<{ messageId: string }> },
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) {
    return NextResponse.json({ error: "Invalid message id" }, { status: 400 });
  }

  // RLS-scoped read: only the owner's own INBOUND question is retryable.
  const { data: message } = await supabase
    .from("messages")
    .select("id, item_id, listing_id, direction, status, draft_reply")
    .eq("id", params.data.messageId)
    .eq("direction", "inbound")
    .maybeSingle();
  if (!message) {
    return NextResponse.json({ error: "Message not found" }, { status: 404 });
  }
  // Retry only applies to a CLAIMED question — one the send flow already
  // flipped to `sent`. Anything else still has the normal send path.
  if (message.status !== "sent") {
    return NextResponse.json(
      { error: "Only a sent-but-undelivered reply can be retried" },
      { status: 409 },
    );
  }
  const reply = (message.draft_reply ?? "").trim();
  if (reply === "") {
    return NextResponse.json(
      { error: "No persisted reply text to re-deliver" },
      { status: 409 },
    );
  }

  try {
    const { outbound } = await retryReplyDelivery(supabase, {
      userId: user.id,
      message: {
        id: message.id,
        item_id: message.item_id,
        listing_id: message.listing_id,
      },
      reply,
      // deliver defaults to the stub (logged no-op) — issue #14 swaps it.
    });
    return NextResponse.json({ outboundId: outbound.id, status: "sent" });
  } catch (err) {
    // Already delivered (existing outbound row / lost the insert race) →
    // idempotent conflict, not a 500.
    if (err instanceof ReplySendConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    const msg = err instanceof Error ? err.message : "Retry failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
