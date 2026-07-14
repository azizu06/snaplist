import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getUserId } from "@/lib/auth";
import {
  MessageDeliveryAttemptError,
  MessageDeliveryConflictError,
  sendCanonicalReply,
} from "@/lib/inbox/transport";
import { createMessagingTransportForConversation } from "@/lib/inbox/adapters";
import { serverErrorJson } from "@/lib/api/errors";
import { enforceRateLimit } from "@/lib/abuse";

/**
 * POST /api/inbox/[messageId]/retry-delivery — recover the send flow's crash
 * gap (issue #13, PR #35 review). The inbound question won the CAS claim
 * (status `sent`) but delivery failed / crashed before the outbound row was
 * inserted, so the inbox shows "not delivered" and the seller explicitly
 * retries.
 *
 * The transport claims only a failed/rejected/ambiguous (or stale in-flight)
 * attempt. The canonical reply uniqueness constraint and durable delivery
 * state collapse browser replays before another external side effect.
 */

const paramsSchema = z.object({ messageId: z.uuid() });
const bodySchema = z.object({ confirmDuplicateRisk: z.boolean() }).strict();

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
      { error: "confirmDuplicateRisk (boolean) is required" },
      { status: 400 },
    );
  }

  // RLS-scoped read: only the owner's own INBOUND question is retryable.
  const { data: message } = await supabase
    .from("messages")
    .select("id, marketplace")
    .eq("id", params.data.messageId)
    .eq("direction", "inbound")
    .maybeSingle();
  if (!message) {
    return NextResponse.json({ error: "Message not found" }, { status: 404 });
  }
  try {
    const transport = await createMessagingTransportForConversation(
      supabase,
      userId,
      message.marketplace,
    );
    const outbound = await sendCanonicalReply({
      ...transport,
      messageId: message.id,
      retry: true,
      confirmDuplicateRisk: parsed.data.confirmDuplicateRisk,
    });
    return NextResponse.json({ outboundId: outbound.id, status: "sent" });
  } catch (err) {
    // Already delivered (existing outbound row / lost the insert race) →
    // idempotent conflict, not a 500.
    if (err instanceof MessageDeliveryConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof MessageDeliveryAttemptError) {
      return NextResponse.json(
        {
          error: "Reply is still not confirmed delivered.",
          deliveryStatus: err.kind,
        },
        { status: 502 },
      );
    }
    // Never leak the raw Supabase/delivery error to the client (CWE-209, #57).
    return serverErrorJson("inbox.retry-delivery", err, "Failed to retry delivery.");
  }
}
