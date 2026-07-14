import { NextResponse } from "next/server";
import { z } from "zod";
import { getUserId } from "@/lib/auth";
import {
  MessageDeliveryAttemptError,
  MessageDeliveryConflictError,
  retryFollowUpDelivery,
} from "@/lib/inbox/transport";
import { createClient } from "@/lib/supabase/server";
import { serverErrorJson } from "@/lib/api/errors";
import { enforceRateLimit } from "@/lib/abuse";
import { createMessagingTransportForConversation } from "@/lib/inbox/adapters";

const paramsSchema = z.object({ messageId: z.uuid() });
const bodySchema = z.object({ confirmDuplicateRisk: z.boolean() }).strict();

/**
 * Retry one seller-owned follow-up. Ambiguous attempts require an explicit
 * duplicate-risk confirmation; RLS-scoped ownership checks return 404 for
 * foreign ids and delivery conflicts remain retryable rather than fabricated.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ messageId: string }> },
) {
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
  const supabase = await createClient();
  const { data: ownedMessage } = await supabase
    .from("messages")
    .select("id, reply_to")
    .eq("id", params.data.messageId)
    .eq("direction", "outbound")
    .eq("reply_kind", "followup")
    .maybeSingle();
  if (!ownedMessage?.reply_to) {
    return NextResponse.json({ error: "Message not found" }, { status: 404 });
  }
  const { data: ownedRoot } = await supabase
    .from("messages")
    .select("id, marketplace")
    .eq("id", ownedMessage.reply_to)
    .eq("direction", "inbound")
    .maybeSingle();
  if (!ownedRoot) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }
  const transport = await createMessagingTransportForConversation(
    supabase,
    userId,
    ownedRoot.marketplace,
  );
  const message = await transport.repository.loadFollowUp(params.data.messageId);
  if (!message) {
    return NextResponse.json({ error: "Message not found" }, { status: 404 });
  }
  const root = message.reply_to
    ? await transport.repository.loadConversationRoot(message.reply_to)
    : null;
  if (!root) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }

  try {
    const delivered = await retryFollowUpDelivery({
      ...transport,
      messageId: message.id,
      confirmDuplicateRisk: parsed.data.confirmDuplicateRisk,
    });
    return NextResponse.json({
      outboundId: delivered.id,
      status: delivered.delivery_status,
    });
  } catch (error) {
    if (error instanceof MessageDeliveryConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof MessageDeliveryAttemptError) {
      return NextResponse.json(
        {
          error: "Follow-up is still not confirmed delivered.",
          deliveryStatus: error.kind,
        },
        { status: 502 },
      );
    }
    return serverErrorJson(
      "inbox.follow-up.retry",
      error,
      "Failed to retry follow-up.",
    );
  }
}
