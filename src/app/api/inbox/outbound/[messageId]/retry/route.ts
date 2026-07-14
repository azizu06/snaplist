import { NextResponse } from "next/server";
import { z } from "zod";
import { getUserId } from "@/lib/auth";
import { createMessagingAdapterForConversation } from "@/lib/inbox/adapters";
import {
  MessageDeliveryAttemptError,
  MessageDeliveryConflictError,
  SupabaseDeliveryRepository,
  retryFollowUpDelivery,
} from "@/lib/inbox/transport";
import { createClient } from "@/lib/supabase/server";
import { serverErrorJson } from "@/lib/api/errors";
import { enforceRateLimit } from "@/lib/abuse";

const paramsSchema = z.object({ messageId: z.uuid() });

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
  const supabase = await createClient();
  const repository = new SupabaseDeliveryRepository(supabase, userId);
  const message = await repository.loadFollowUp(params.data.messageId);
  if (!message) {
    return NextResponse.json({ error: "Message not found" }, { status: 404 });
  }
  const root = message.reply_to
    ? await repository.loadConversationRoot(message.reply_to)
    : null;
  if (!root) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }

  try {
    const delivered = await retryFollowUpDelivery({
      repository,
      adapter: await createMessagingAdapterForConversation(
        supabase,
        userId,
        root.marketplace,
      ),
      messageId: message.id,
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
