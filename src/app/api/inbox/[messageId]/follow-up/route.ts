import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getUserId } from "@/lib/auth";
import { sendFollowUpMessage } from "@/lib/inbox";
import { serverErrorJson } from "@/lib/api/errors";
import { enforceRateLimit } from "@/lib/abuse";

/**
 * POST /api/inbox/[messageId]/follow-up — the seller sends another message in a
 * conversation they have ALREADY replied to (issue #13, follow-up slice).
 *
 * Unlike /send (which approves the agent's draft for an inbound question), this
 * is plain seller-authored text ("Hold on, let me check…") — eBay member
 * messaging allows many seller messages per thread, so the v1 "nothing further
 * to send" block was our own simplification, not an API limit. The message is
 * threaded to the conversation root (`reply_to` = this inbound question) and
 * marked `reply_kind = 'followup'`. Delivery is the STUBBED seam; the real eBay
 * send is issue #14. The question is loaded through the USER-SCOPED client so
 * RLS proves ownership (another user's messageId 404s).
 */

const bodySchema = z.object({ message: z.string().trim().min(1) });
const paramsSchema = z.object({ messageId: z.uuid() });

export async function POST(
  request: Request,
  context: { params: Promise<{ messageId: string }> },
) {
  const supabase = await createClient();
  const userId = await getUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limited = await enforceRateLimit(request, userId);
  if (limited) return limited;

  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) {
    return NextResponse.json({ error: "Invalid message id" }, { status: 400 });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "message (non-empty string) is required" },
      { status: 400 },
    );
  }

  // RLS-scoped read: only the owner's own INBOUND question is a conversation root.
  const { data: message } = await supabase
    .from("messages")
    .select("id, item_id, listing_id, direction, status")
    .eq("id", params.data.messageId)
    .eq("direction", "inbound")
    .maybeSingle();
  if (!message) {
    return NextResponse.json({ error: "Message not found" }, { status: 404 });
  }
  // A follow-up only makes sense once the conversation has a sent reply. The
  // composer is only shown in that state, so this guards a direct/raced call.
  if (message.status !== "sent") {
    return NextResponse.json(
      { error: "Reply to this question before sending a follow-up." },
      { status: 409 },
    );
  }

  try {
    const { outbound } = await sendFollowUpMessage(supabase, {
      userId,
      message: {
        id: message.id,
        item_id: message.item_id,
        listing_id: message.listing_id,
      },
      body: parsed.data.message,
      // deliver defaults to the stub (logged no-op) — issue #14 swaps it.
    });
    return NextResponse.json({ outboundId: outbound.id, status: "sent" });
  } catch (err) {
    // Never leak the raw Supabase/delivery error to the client (CWE-209, #57).
    return serverErrorJson("inbox.followUp", err, "Failed to send follow-up.");
  }
}
