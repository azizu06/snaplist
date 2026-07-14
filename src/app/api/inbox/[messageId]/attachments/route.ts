import { NextResponse } from "next/server";
import { z } from "zod";
import { enforceRateLimit } from "@/lib/abuse";
import { getUserId } from "@/lib/auth";
import {
  createOutboundPhotoUploadIntents,
  MessagePhotoConflictError,
} from "@/lib/inbox/attachment-store";
import { messagePhotoUploadMetadataSchema } from "@/lib/inbox/attachments";
import { createClient } from "@/lib/supabase/server";
import { createTenantServerClient } from "@/lib/supabase/tenant-server";

const paramsSchema = z.object({ messageId: z.uuid() });
const bodySchema = z.object({
  deliveryRequestId: z.uuid(),
  photos: z.array(messagePhotoUploadMetadataSchema).min(1).max(5),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ messageId: string }> },
) {
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = await enforceRateLimit(request, userId);
  if (limited) return limited;

  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) {
    return NextResponse.json({ error: "Invalid message id" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid photo upload request" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: message } = await supabase
    .from("messages")
    .select("id, marketplace, status")
    .eq("id", params.data.messageId)
    .eq("direction", "inbound")
    .maybeSingle();
  if (!message) return NextResponse.json({ error: "Message not found" }, { status: 404 });
  if (message.marketplace !== "ebay") {
    return NextResponse.json(
      { error: "Photo messages are supported only for imported eBay conversations" },
      { status: 400 },
    );
  }
  const isCanonical = parsed.data.deliveryRequestId === message.id;
  const canUpload = isCanonical
    ? ["drafted", "sending", "sent"].includes(message.status)
    : message.status === "sent";
  if (!canUpload) {
    return NextResponse.json({ error: "This conversation cannot accept photo uploads" }, { status: 409 });
  }

  try {
    const rows = await createOutboundPhotoUploadIntents({
      supabase: await createTenantServerClient(),
      userId,
      conversationRootId: message.id,
      deliveryRequestId: parsed.data.deliveryRequestId,
      photos: parsed.data.photos,
    });
    return NextResponse.json({
      photos: rows.map((row) => ({
        name: row.original_name,
        mediaType: row.media_type,
        byteSize: row.byte_size,
        contentSha256: row.content_sha256,
        storagePath: row.storage_path,
      })),
    });
  } catch (error) {
    if (error instanceof MessagePhotoConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ error: "Failed to prepare photo upload" }, { status: 500 });
  }
}
