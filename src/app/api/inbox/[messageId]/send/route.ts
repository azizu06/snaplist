import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getUserId } from "@/lib/auth";
import { ReplySendConflictError, approveAndSendReply } from "@/lib/inbox";

/**
 * POST /api/inbox/[messageId]/send — the seller approved (or edited) the drafted
 * reply for an inbound buyer question (issue #13).
 *
 * The reply text in the body is what the seller actually approved — it may differ
 * from the agent's draft (the "edit before sending" acceptance criterion).
 * Delivery is the STUBBED seam (logged no-op); the real eBay send is issue #14.
 * The inbound message is loaded through the USER-SCOPED client so RLS proves
 * ownership (another user's messageId 404s).
 */

const bodySchema = z.object({ reply: z.string().trim().min(1) });
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
      { error: "reply (non-empty string) is required" },
      { status: 400 },
    );
  }

  // RLS-scoped read: only the owner's own INBOUND question is sendable.
  const { data: message } = await supabase
    .from("messages")
    .select("id, item_id, listing_id, direction, status")
    .eq("id", params.data.messageId)
    .eq("direction", "inbound")
    .maybeSingle();
  if (!message) {
    return NextResponse.json({ error: "Message not found" }, { status: 404 });
  }
  // Fast-path duplicate check only — the AUTHORITATIVE guard is the
  // compare-and-set claim inside approveAndSendReply (drafted → sent), which
  // concurrent requests cannot both win.
  if (message.status === "sent") {
    return NextResponse.json(
      { error: "A reply was already sent for this message" },
      { status: 409 },
    );
  }

  try {
    const { outbound } = await approveAndSendReply(supabase, {
      userId: userId,
      message: {
        id: message.id,
        item_id: message.item_id,
        listing_id: message.listing_id,
      },
      reply: parsed.data.reply,
      // deliver defaults to the stub (logged no-op) — issue #14 swaps it.
    });
    return NextResponse.json({ outboundId: outbound.id, status: "sent" });
  } catch (err) {
    // Lost the CAS race / duplicate reply row → idempotent conflict, not a 500.
    if (err instanceof ReplySendConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    const msg = err instanceof Error ? err.message : "Send failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
