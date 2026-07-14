import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";
import {
  MESSAGE_PHOTO_BUCKET,
  MAX_MESSAGE_PHOTOS,
  validateMessagePhotoBatch,
  validateStoredMessagePhotoPath,
  type StoredMessagePhoto,
  type ValidatedMessagePhoto,
} from "./attachments";
import {
  messageAttachmentRowSchema,
  type MessageAttachmentRow,
} from "./types";

export class MessagePhotoConflictError extends Error {
  constructor() {
    super("This delivery request id belongs to different photos");
    this.name = "MessagePhotoConflictError";
  }
}

export async function validateFormPhotos(form: FormData): Promise<ValidatedMessagePhoto[]> {
  const files = form.getAll("photos");
  if (files.some((value) => !(value instanceof File))) {
    throw new Error("photos must be image files");
  }
  return validateMessagePhotoBatch(
    await Promise.all(
      (files as File[]).map(async (file) => ({
        name: file.name,
        type: file.type,
        size: file.size,
        bytes: new Uint8Array(await file.arrayBuffer()),
      })),
    ),
  );
}

export async function stageOutboundPhotos(input: {
  supabase: SupabaseClient;
  userId: string;
  conversationRootId: string;
  deliveryRequestId: string;
  photos: Array<ValidatedMessagePhoto & { storagePath?: string }>;
}): Promise<MessageAttachmentRow[]> {
  if (input.photos.length === 0) return [];
  const existing = await listDeliveryPhotos(
    input.supabase,
    input.userId,
    input.deliveryRequestId,
  );
  if (existing.length) {
    const hashes = input.photos.map((photo) => sha256(photo.bytes));
    await removeUnusedUploadedPhotos(
      input.supabase,
      input.photos,
      new Set(existing.flatMap((row) => row.storage_path ? [row.storage_path] : [])),
    );
    if (
      existing.length !== hashes.length ||
      existing.some((row, index) => row.content_sha256 !== hashes[index])
    ) {
      throw new MessagePhotoConflictError();
    }
    return existing;
  }

  const delivered = await findDeliveredMessageForRequest(input);
  if (delivered) {
    await removeUnusedUploadedPhotos(input.supabase, input.photos, new Set());
    throw new MessagePhotoConflictError();
  }

  const uploaded: string[] = [];
  const rows = input.photos.map((photo, position) => {
    const id = randomUUID();
    const extension = extensionFor(photo.mediaType);
    return {
      id,
      user_id: input.userId,
      conversation_root_id: input.conversationRootId,
      message_id: null,
      delivery_request_id: input.deliveryRequestId,
      position,
      direction: "outbound",
      media_type: photo.mediaType,
      byte_size: photo.bytes.byteLength,
      original_name: photo.name.slice(0, 100),
      content_sha256: sha256(photo.bytes),
      storage_path:
        photo.storagePath ??
        `${input.userId}/${input.conversationRootId}/${id}.${extension}`,
      delivery_status: "staged",
    };
  });
  try {
    for (const [position, photo] of input.photos.entries()) {
      const storagePath = rows[position]!.storage_path;
      if (photo.storagePath) {
        uploaded.push(storagePath);
        continue;
      }
      const { error: uploadError } = await input.supabase.storage
        .from(MESSAGE_PHOTO_BUCKET)
        .upload(storagePath, photo.bytes, {
          contentType: photo.mediaType,
          upsert: false,
        });
      if (uploadError) throw new Error(`Failed to stage photo: ${uploadError.message}`);
      uploaded.push(storagePath);
    }
    const { data, error } = await input.supabase
      .from("message_attachments")
      .insert(rows)
      .select("*");
    if (error) {
      if (error.code === "23505") {
        const raced = await listDeliveryPhotos(
          input.supabase,
          input.userId,
          input.deliveryRequestId,
        );
        if (
          raced.length === rows.length &&
          raced.every((row, index) => row.content_sha256 === rows[index]?.content_sha256)
        ) {
          const cleanup = await input.supabase.storage
            .from(MESSAGE_PHOTO_BUCKET)
            .remove(uploaded);
          uploaded.length = 0;
          if (cleanup.error) {
            throw new Error(`Failed to clean up replayed photos: ${cleanup.error.message}`);
          }
          return raced;
        }
        throw new MessagePhotoConflictError();
      }
      throw new Error(`Failed to persist photos: ${error.message}`);
    }
    return (data ?? []).map((row) => messageAttachmentRowSchema.parse(row));
  } catch (error) {
    if (uploaded.length) {
      const cleanup = await input.supabase.storage
        .from(MESSAGE_PHOTO_BUCKET)
        .remove(uploaded);
      if (cleanup.error) {
        throw new Error(`Failed to clean up staged photos: ${cleanup.error.message}`, {
          cause: error,
        });
      }
    }
    throw error;
  }
}

export async function validateStoredPhotos(input: {
  supabase: SupabaseClient;
  userId: string;
  conversationRootId: string;
  photos: StoredMessagePhoto[];
}): Promise<Array<ValidatedMessagePhoto & { storagePath: string }>> {
  if (input.photos.length > MAX_MESSAGE_PHOTOS) {
    throw new Error(`You can attach up to ${MAX_MESSAGE_PHOTOS} photos.`);
  }
  const validated: Array<ValidatedMessagePhoto & { storagePath: string }> = [];
  for (const photo of input.photos) {
    validateStoredMessagePhotoPath({
      userId: input.userId,
      conversationRootId: input.conversationRootId,
      photo,
    });
    const { data, error } = await input.supabase.storage
      .from(MESSAGE_PHOTO_BUCKET)
      .download(photo.storagePath);
    if (error || !data) {
      throw new Error("Uploaded photo is unavailable.");
    }
    const bytes = new Uint8Array(await data.arrayBuffer());
    if (bytes.byteLength !== photo.byteSize) {
      throw new Error("Uploaded photo size changed before approval.");
    }
    const result = validateMessagePhotoBatch([{
      name: photo.name,
      type: photo.mediaType,
      size: photo.byteSize,
      bytes,
    }])[0]!;
    validated.push({ ...result, storagePath: photo.storagePath });
  }
  return validated;
}

export async function listDeliveryPhotos(
  supabase: SupabaseClient,
  userId: string,
  deliveryRequestId: string,
): Promise<MessageAttachmentRow[]> {
  const { data, error } = await supabase
    .from("message_attachments")
    .select("*")
    .eq("user_id", userId)
    .eq("delivery_request_id", deliveryRequestId)
    .order("position");
  if (error) throw new Error(`Failed to load message photos: ${error.message}`);
  return (data ?? []).map((row) => messageAttachmentRowSchema.parse(row));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function extensionFor(mediaType: ValidatedMessagePhoto["mediaType"]): string {
  if (mediaType === "image/jpeg") return "jpg";
  if (mediaType === "image/png") return "png";
  return "webp";
}

async function findDeliveredMessageForRequest(input: {
  supabase: SupabaseClient;
  userId: string;
  conversationRootId: string;
  deliveryRequestId: string;
}): Promise<string | null> {
  let query = input.supabase
    .from("messages")
    .select("id")
    .eq("user_id", input.userId)
    .eq("direction", "outbound")
    .eq("reply_to", input.conversationRootId)
    .eq("delivery_status", "delivered");
  query = input.deliveryRequestId === input.conversationRootId
    ? query.or("reply_kind.is.null,reply_kind.eq.reply")
    : query
        .eq("reply_kind", "followup")
        .eq("delivery_request_id", input.deliveryRequestId);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`Failed to inspect photo delivery: ${error.message}`);
  return typeof data?.id === "string" ? data.id : null;
}

async function removeUnusedUploadedPhotos(
  supabase: SupabaseClient,
  photos: Array<ValidatedMessagePhoto & { storagePath?: string }>,
  retained: Set<string>,
): Promise<void> {
  const paths = photos.flatMap((photo) =>
    photo.storagePath && !retained.has(photo.storagePath) ? [photo.storagePath] : [],
  );
  if (!paths.length) return;
  const { error } = await supabase.storage.from(MESSAGE_PHOTO_BUCKET).remove(paths);
  if (error) throw new Error(`Failed to clean up replayed photos: ${error.message}`);
}
