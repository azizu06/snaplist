import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";
import {
  MESSAGE_PHOTO_BUCKET,
  MAX_MESSAGE_PHOTOS,
  validateMessagePhotoBatch,
  validateStoredMessagePhotoPath,
  type MessagePhotoUploadMetadata,
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
  requireExistingIntent?: boolean;
}): Promise<MessageAttachmentRow[]> {
  const existing = await listDeliveryPhotos(
    input.supabase,
    input.userId,
    input.deliveryRequestId,
  );
  if (existing.length) {
    if (!deliveryPhotosMatch(existing, input.photos, input.conversationRootId)) {
      throw new MessagePhotoConflictError();
    }
    if (existing.some((row) => row.delivery_status === "uploading")) {
      const { data, error } = await input.supabase.rpc(
        "stage_message_photo_upload_intents",
        {
          p_delivery_request_id: input.deliveryRequestId,
          p_attachment_ids: existing.map((row) => row.id),
        },
      );
      if (error) throw new Error(`Failed to finalize photos: ${error.message}`);
      const staged = (data ?? []).map((row: unknown) => messageAttachmentRowSchema.parse(row));
      if (
        staged.length !== existing.length ||
        staged.some((row) => row.delivery_status !== "staged") ||
        !deliveryPhotosMatch(staged, input.photos, input.conversationRootId)
      ) {
        throw new Error("Failed to finalize the complete photo set");
      }
      return staged;
    }
    return existing;
  }
  if (input.requireExistingIntent && input.photos.length) {
    throw new MessagePhotoConflictError();
  }

  const delivered = await findDeliveredMessageForRequest(input);
  if (delivered && input.photos.length) {
    throw new MessagePhotoConflictError();
  }
  if (input.photos.length === 0) return [];

  const createdPaths: string[] = [];
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
      upload_expires_at: null,
    };
  });
  try {
    for (const [position, photo] of input.photos.entries()) {
      const storagePath = rows[position]!.storage_path;
      if (photo.storagePath) continue;
      const { error: uploadError } = await input.supabase.storage
        .from(MESSAGE_PHOTO_BUCKET)
        .upload(storagePath, photo.bytes, {
          contentType: photo.mediaType,
          upsert: false,
        });
      if (uploadError) throw new Error(`Failed to stage photo: ${uploadError.message}`);
      createdPaths.push(storagePath);
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
        if (deliveryRowsMatch(raced, rows)) {
          const retained = new Set(raced.flatMap((row) => row.storage_path ? [row.storage_path] : []));
          await removeCreatedPaths(
            input.supabase,
            createdPaths.filter((path) => !retained.has(path)),
          );
          createdPaths.length = 0;
          return raced;
        }
        throw new MessagePhotoConflictError();
      }
      throw new Error(`Failed to persist photos: ${error.message}`);
    }
    return (data ?? []).map((row) => messageAttachmentRowSchema.parse(row));
  } catch (error) {
    if (createdPaths.length) {
      try {
        await removeCreatedPaths(input.supabase, createdPaths);
      } catch (cleanupError) {
        throw new Error(cleanupError instanceof Error ? cleanupError.message : "Failed to clean up staged photos", {
          cause: error,
        });
      }
    }
    throw error;
  }
}

export async function createOutboundPhotoUploadIntents(input: {
  supabase: SupabaseClient;
  userId: string;
  conversationRootId: string;
  deliveryRequestId: string;
  photos: MessagePhotoUploadMetadata[];
  now?: () => number;
}): Promise<MessageAttachmentRow[]> {
  const existing = await listDeliveryPhotos(input.supabase, input.userId, input.deliveryRequestId);
  if (existing.length) {
    if (!uploadIntentsMatch(existing, input.photos, input.conversationRootId)) {
      throw new MessagePhotoConflictError();
    }
    if (existing.some((row) => row.delivery_status === "uploading")) {
      const uploadExpiresAt = new Date((input.now?.() ?? Date.now()) + 15 * 60_000).toISOString();
      const { error } = await input.supabase
        .from("message_attachments")
        .update({ upload_expires_at: uploadExpiresAt })
        .eq("user_id", input.userId)
        .eq("delivery_request_id", input.deliveryRequestId)
        .eq("delivery_status", "uploading");
      if (error) throw new Error(`Failed to renew photo upload: ${error.message}`);
      return listDeliveryPhotos(input.supabase, input.userId, input.deliveryRequestId);
    }
    return existing;
  }
  if (input.photos.length === 0) return [];
  if (await findDeliveredMessageForRequest(input)) throw new MessagePhotoConflictError();

  const uploadExpiresAt = new Date((input.now?.() ?? Date.now()) + 15 * 60_000).toISOString();
  const rows = input.photos.map((photo, position) => {
    const id = randomUUID();
    return {
      id,
      user_id: input.userId,
      conversation_root_id: input.conversationRootId,
      message_id: null,
      delivery_request_id: input.deliveryRequestId,
      position,
      direction: "outbound",
      media_type: photo.mediaType,
      byte_size: photo.byteSize,
      original_name: photo.name,
      content_sha256: photo.contentSha256,
      storage_path: `${input.userId}/${input.conversationRootId}/pending/${id}.${extensionFor(photo.mediaType)}`,
      provider_media_id: null,
      provider_url: null,
      provider_expires_at: null,
      upload_expires_at: uploadExpiresAt,
      delivery_status: "uploading",
      delivery_error: null,
    };
  });
  const { data, error } = await input.supabase
    .from("message_attachments")
    .insert(rows)
    .select("*");
  if (!error) return (data ?? []).map((row) => messageAttachmentRowSchema.parse(row));
  if (error.code === "23514") throw new MessagePhotoConflictError();
  if (error.code !== "23505") throw new Error(`Failed to create photo upload: ${error.message}`);
  const raced = await listDeliveryPhotos(input.supabase, input.userId, input.deliveryRequestId);
  if (!uploadIntentsMatch(raced, input.photos, input.conversationRootId)) {
    throw new MessagePhotoConflictError();
  }
  return raced;
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
    if (sha256(bytes) !== photo.contentSha256) {
      throw new Error("Uploaded photo content changed before approval.");
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

function deliveryPhotosMatch(
  rows: MessageAttachmentRow[],
  photos: Array<ValidatedMessagePhoto & { storagePath?: string }>,
  conversationRootId: string,
): boolean {
  return rows.length === photos.length && rows.every((row, index) => {
    const photo = photos[index];
    return !!photo &&
      row.position === index &&
      row.conversation_root_id === conversationRootId &&
      row.direction === "outbound" &&
      row.media_type === photo.mediaType &&
      row.byte_size === photo.bytes.byteLength &&
      row.original_name === photo.name.slice(0, 100) &&
      row.content_sha256 === sha256(photo.bytes) &&
      (!photo.storagePath || row.storage_path === photo.storagePath);
  });
}

function uploadIntentsMatch(
  rows: MessageAttachmentRow[],
  photos: MessagePhotoUploadMetadata[],
  conversationRootId: string,
): boolean {
  return rows.length === photos.length && rows.every((row, index) => {
    const photo = photos[index];
    return !!photo &&
      row.position === index &&
      row.conversation_root_id === conversationRootId &&
      row.direction === "outbound" &&
      row.media_type === photo.mediaType &&
      row.byte_size === photo.byteSize &&
      row.original_name === photo.name &&
      row.content_sha256 === photo.contentSha256;
  });
}

function deliveryRowsMatch(
  rows: MessageAttachmentRow[],
  expected: Array<{
    position: number;
    conversation_root_id: string;
    media_type: string;
    byte_size: number;
    original_name: string;
    content_sha256: string;
  }>,
): boolean {
  return rows.length === expected.length && rows.every((row, index) => {
    const target = expected[index];
    return !!target &&
      row.position === target.position &&
      row.conversation_root_id === target.conversation_root_id &&
      row.media_type === target.media_type &&
      row.byte_size === target.byte_size &&
      row.original_name === target.original_name &&
      row.content_sha256 === target.content_sha256;
  });
}

async function removeCreatedPaths(
  supabase: SupabaseClient,
  paths: string[],
): Promise<void> {
  if (!paths.length) return;
  const { error } = await supabase.storage.from(MESSAGE_PHOTO_BUCKET).remove(paths);
  if (error) throw new Error(`Failed to clean up staged photos: ${error.message}`);
}
