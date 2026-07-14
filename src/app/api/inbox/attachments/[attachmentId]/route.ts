import { NextResponse } from "next/server";
import { z } from "zod";
import { getUserId } from "@/lib/auth";
import { MESSAGE_PHOTO_BUCKET, validateMessagePhoto } from "@/lib/inbox/attachments";
import { messageAttachmentRowSchema } from "@/lib/inbox/types";
import { createClient } from "@/lib/supabase/server";

const paramsSchema = z.object({ attachmentId: z.uuid() });

export async function GET(
  _request: Request,
  context: { params: Promise<{ attachmentId: string }> },
) {
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return NextResponse.json({ error: "Invalid attachment id" }, { status: 400 });
  const supabase = await createClient();
  const { data } = await supabase
    .from("message_attachments")
    .select("*")
    .eq("user_id", userId)
    .eq("id", params.data.attachmentId)
    .maybeSingle();
  const parsed = messageAttachmentRowSchema.safeParse(data);
  if (!parsed.success) return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
  const attachment = parsed.data;

  let blob: Blob;
  if (attachment.storage_path) {
    const result = await supabase.storage
      .from(MESSAGE_PHOTO_BUCKET)
      .download(attachment.storage_path);
    if (result.error || !result.data) {
      return NextResponse.json({ error: "Attachment unavailable" }, { status: 404 });
    }
    blob = result.data;
  } else if (attachment.provider_url && trustedEbayImageUrl(attachment.provider_url)) {
    const response = await fetch(attachment.provider_url, {
      redirect: "error",
      headers: { accept: "image/jpeg,image/png,image/webp" },
    });
    if (!response.ok) return NextResponse.json({ error: "Attachment unavailable" }, { status: 502 });
    blob = await response.blob();
  } else {
    return NextResponse.json({ error: "Attachment unavailable" }, { status: 404 });
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  let photo;
  try {
    photo = validateMessagePhoto({
      name: attachment.original_name,
      type: blob.type,
      size: bytes.byteLength,
      bytes,
    });
  } catch {
    return NextResponse.json({ error: "Attachment is not a supported image" }, { status: 415 });
  }
  return new Response(bytes, {
    headers: {
      "content-type": photo.mediaType,
      "cache-control": "private, no-store",
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff",
    },
  });
}

function trustedEbayImageUrl(value: string): boolean {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  return url.protocol === "https:" &&
    (host.endsWith(".ebayimg.com") || host.endsWith(".ebaystatic.com"));
}
