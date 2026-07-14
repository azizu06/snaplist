import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getUserId } from "@/lib/auth";
import {
  MessageDeliveryAttemptError,
  MessageDeliveryConflictError,
  sendSellerFollowUp,
} from "@/lib/inbox/transport";
import { createMessagingTransportForConversation } from "@/lib/inbox/adapters";
import { serverErrorJson } from "@/lib/api/errors";
import { enforceRateLimit } from "@/lib/abuse";
import {
  MessagePhotoConflictError,
  stageOutboundPhotos,
  validateFormPhotos,
  validateStoredPhotos,
} from "@/lib/inbox/attachment-store";
import { storedMessagePhotoSchema } from "@/lib/inbox/attachments";
import { createTenantServerClient } from "@/lib/supabase/tenant-server";

/**
 * POST /api/inbox/[messageId]/follow-up — the seller sends another message in a
 * conversation they have ALREADY replied to (issue #13, follow-up slice).
 *
 * Unlike /send (which approves the agent's draft for an inbound question), this
 * is plain seller-authored text ("Hold on, let me check…"). eBay's Commerce
 * Message API sends it into the imported conversation. The message is
 * threaded to the conversation root (`reply_to` = this inbound question) and
 * marked `reply_kind = 'followup'`. The question is loaded through the
 * USER-SCOPED client so RLS proves ownership (another user's messageId 404s).
 */

const bodySchema = z.object({
  message: z.string().trim().min(1).max(2_000),
  requestId: z.uuid(),
  photos: z.array(storedMessagePhotoSchema).max(5).default([]),
});
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

  let payload: unknown;
  let photos: Awaited<ReturnType<typeof validateFormPhotos>> = [];
  try {
    if (request.headers.get("content-type")?.includes("multipart/form-data")) {
      const form = await request.formData();
      payload = { message: form.get("message"), requestId: form.get("requestId") };
      photos = await validateFormPhotos(form);
    } else {
      payload = await request.json();
    }
  } catch {
    return NextResponse.json({ error: "Invalid message photos or request body" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "message (non-empty string) is required" },
      { status: 400 },
    );
  }

  // RLS-scoped read: only the owner's own INBOUND question is a conversation root.
  const { data: message } = await supabase
    .from("messages")
    .select("id, marketplace")
    .eq("id", params.data.messageId)
    .eq("direction", "inbound")
    .maybeSingle();
  if (!message) {
    return NextResponse.json({ error: "Message not found" }, { status: 404 });
  }
  if (photos.length && message.marketplace !== "ebay") {
    return NextResponse.json(
      { error: "Photo messages are supported only for imported eBay conversations" },
      { status: 400 },
    );
  }
  if (parsed.data.photos.length && message.marketplace !== "ebay") {
    return NextResponse.json(
      { error: "Photo messages are supported only for imported eBay conversations" },
      { status: 400 },
    );
  }
  if (parsed.data.photos.length) {
    try {
      photos = await validateStoredPhotos({
        supabase,
        userId,
        conversationRootId: message.id,
        photos: parsed.data.photos,
      });
    } catch {
      return NextResponse.json({ error: "Invalid or unavailable message photos" }, { status: 400 });
    }
  }
  try {
    const attachmentClient = await createTenantServerClient();
    const stagedPhotos = await stageOutboundPhotos({
      supabase: attachmentClient,
      userId,
      conversationRootId: message.id,
      deliveryRequestId: parsed.data.requestId,
      photos,
      requireExistingIntent: parsed.data.photos.length > 0,
    });
    const transport = await createMessagingTransportForConversation(
      supabase,
      userId,
      message.marketplace,
    );
    const outbound = await sendSellerFollowUp({
      ...transport,
      conversationId: message.id,
      body: parsed.data.message,
      requestId: parsed.data.requestId,
      expectedPhotoIds: stagedPhotos.map((photo) => photo.id),
    });
    if (outbound.delivery_status !== "delivered") {
      return NextResponse.json(
        {
          error:
            "This follow-up already exists but is not confirmed delivered. Use its retry action.",
          outboundId: outbound.id,
          deliveryStatus: outbound.delivery_status,
        },
        { status: 409 },
      );
    }
    return NextResponse.json({
      outboundId: outbound.id,
      status: outbound.delivery_status,
    });
  } catch (err) {
    if (err instanceof MessagePhotoConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof MessageDeliveryConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof MessageDeliveryAttemptError) {
      return NextResponse.json(
        {
          error: "Follow-up was not confirmed delivered and remains retryable.",
          deliveryStatus: err.kind,
        },
        { status: 502 },
      );
    }
    // Never leak the raw Supabase/delivery error to the client (CWE-209, #57).
    return serverErrorJson("inbox.followUp", err, "Failed to send follow-up.");
  }
}
