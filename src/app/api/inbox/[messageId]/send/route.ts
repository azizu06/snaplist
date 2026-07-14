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
import {
  MessagePhotoConflictError,
  stageOutboundPhotos,
  validateFormPhotos,
  validateStoredPhotos,
} from "@/lib/inbox/attachment-store";
import { storedMessagePhotoSchema } from "@/lib/inbox/attachments";

/**
 * POST /api/inbox/[messageId]/send — the seller approved (or edited) the drafted
 * reply for an inbound buyer question (issue #13).
 *
 * The reply text in the body is what the seller actually approved — it may differ
 * from the agent's draft (the "edit before sending" acceptance criterion).
 * The persisted marketplace chooses the simulated or real eBay adapter. The
 * inbound message is loaded through the USER-SCOPED client so RLS proves
 * ownership (another user's messageId 404s).
 */

const bodySchema = z.object({
  reply: z.string().trim().min(1).max(2_000),
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
      payload = { reply: form.get("reply") };
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
      { error: "reply (non-empty string) is required" },
      { status: 400 },
    );
  }

  // RLS-scoped read: only the owner's own INBOUND question is sendable.
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
    await stageOutboundPhotos({
      supabase,
      userId,
      conversationRootId: message.id,
      deliveryRequestId: message.id,
      photos,
    });
    const transport = await createMessagingTransportForConversation(
      supabase,
      userId,
      message.marketplace,
    );
    const outbound = await sendCanonicalReply({
      ...transport,
      messageId: message.id,
      body: parsed.data.reply,
    });
    return NextResponse.json({ outboundId: outbound.id, status: "sent" });
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
          error: "Reply was not confirmed delivered. It remains available to retry.",
          deliveryStatus: err.kind,
        },
        { status: 502 },
      );
    }
    // Never leak the raw Supabase/delivery error to the client (CWE-209, #57).
    return serverErrorJson("inbox.send", err, "Failed to send reply.");
  }
}
