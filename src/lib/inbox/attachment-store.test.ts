import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createOutboundPhotoUploadIntents,
  MessagePhotoConflictError,
  stageOutboundPhotos,
} from "./attachment-store";
import type { MessageAttachmentRow } from "./types";

const ROOT = "11111111-1111-4111-8111-111111111111";
const REQUEST = "22222222-2222-4222-8222-222222222222";
const PATH = `user_a/${ROOT}/pending/33333333-3333-4333-8333-333333333333.jpg`;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

function row(overrides: Partial<MessageAttachmentRow> = {}): MessageAttachmentRow {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    user_id: "user_a",
    conversation_root_id: ROOT,
    message_id: null,
    delivery_request_id: REQUEST,
    position: 0,
    direction: "outbound",
    media_type: "image/jpeg",
    byte_size: JPEG.length,
    original_name: "condition.jpg",
    content_sha256: createHash("sha256").update(JPEG).digest("hex"),
    storage_path: PATH,
    provider_media_id: null,
    provider_url: null,
    provider_expires_at: null,
    upload_expires_at: null,
    delivery_status: "staged",
    delivery_error: null,
    created_at: "2026-07-14T12:00:00.000Z",
    updated_at: "2026-07-14T12:00:00.000Z",
    ...overrides,
  };
}

function listClient(rows: MessageAttachmentRow[], remove = vi.fn()) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    order: vi.fn(async () => ({ data: rows, error: null })),
  };
  return {
    client: {
      from: vi.fn(() => query),
      storage: { from: vi.fn(() => ({ remove })) },
    } as unknown as SupabaseClient,
    remove,
  };
}

describe("outbound photo idempotency", () => {
  it("abandons a failed live upload intent before preparing a changed photo", async () => {
    const abandoned = row({
      delivery_request_id: ROOT,
      delivery_status: "uploading",
      upload_expires_at: "2026-07-14T12:15:00.000Z",
    });
    const replacement = row({
      id: "44444444-4444-4444-8444-444444444444",
      delivery_request_id: ROOT,
      original_name: "replacement.jpg",
      content_sha256: "b".repeat(64),
      storage_path: `user_a/${ROOT}/pending/44444444-4444-4444-8444-444444444444.jpg`,
      delivery_status: "uploading",
      upload_expires_at: "2026-07-14T12:16:00.000Z",
    });
    let listCount = 0;
    const attachmentQuery = {
      select: vi.fn(() => attachmentQuery),
      eq: vi.fn(() => attachmentQuery),
      order: vi.fn(async () => ({
        data: listCount++ === 0 ? [abandoned] : [],
        error: null,
      })),
      insert: vi.fn(() => ({
        select: vi.fn(async () => ({ data: [replacement], error: null })),
      })),
    };
    const messageQuery = {
      select: vi.fn(() => messageQuery),
      eq: vi.fn(() => messageQuery),
      or: vi.fn(() => messageQuery),
      maybeSingle: vi.fn(async () => ({ data: null, error: null })),
    };
    const rpc = vi.fn(async () => ({ data: 1, error: null }));
    const client = {
      from: vi.fn((table: string) => table === "messages" ? messageQuery : attachmentQuery),
      rpc,
    } as unknown as SupabaseClient;

    await expect(createOutboundPhotoUploadIntents({
      supabase: client,
      userId: "user_a",
      conversationRootId: ROOT,
      deliveryRequestId: ROOT,
      photos: [{
        name: "replacement.jpg",
        mediaType: "image/jpeg",
        byteSize: JPEG.length,
        contentSha256: "b".repeat(64),
      }],
      now: () => Date.parse("2026-07-14T12:01:00.000Z"),
    })).resolves.toEqual([replacement]);
    expect(rpc).toHaveBeenCalledWith(
      "delete_own_message_photo_upload_intents_for_request",
      { p_delivery_request_id: ROOT },
    );
    expect(attachmentQuery.insert).toHaveBeenCalledOnce();
  });

  it("abandons a failed live upload intent before a text-only retry", async () => {
    const abandoned = row({
      delivery_request_id: ROOT,
      delivery_status: "uploading",
      upload_expires_at: "2026-07-14T12:15:00.000Z",
    });
    let listCount = 0;
    const attachmentQuery = {
      select: vi.fn(() => attachmentQuery),
      eq: vi.fn(() => attachmentQuery),
      order: vi.fn(async () => ({
        data: listCount++ === 0 ? [abandoned] : [],
        error: null,
      })),
    };
    const rpc = vi.fn(async () => ({ data: 1, error: null }));
    const client = {
      from: vi.fn(() => attachmentQuery),
      rpc,
      storage: { from: vi.fn() },
    } as unknown as SupabaseClient;

    await expect(stageOutboundPhotos({
      supabase: client,
      userId: "user_a",
      conversationRootId: ROOT,
      deliveryRequestId: ROOT,
      photos: [],
    })).resolves.toEqual([]);
    expect(rpc).toHaveBeenCalledWith(
      "delete_own_message_photo_upload_intents_for_request",
      { p_delivery_request_id: ROOT },
    );
  });

  it("rejects a zero-photo replay when the request durably owns photos", async () => {
    const { client, remove } = listClient([row()]);

    await expect(stageOutboundPhotos({
      supabase: client,
      userId: "user_a",
      conversationRootId: ROOT,
      deliveryRequestId: REQUEST,
      photos: [],
    })).rejects.toBeInstanceOf(MessagePhotoConflictError);
    expect(remove).not.toHaveBeenCalled();
  });

  it("compares provider-visible names as part of the complete photo identity", async () => {
    const { client, remove } = listClient([row()]);

    await expect(stageOutboundPhotos({
      supabase: client,
      userId: "user_a",
      conversationRootId: ROOT,
      deliveryRequestId: REQUEST,
      photos: [{
        name: "different.jpg",
        type: "image/jpeg",
        size: JPEG.length,
        bytes: JPEG,
        mediaType: "image/jpeg",
        extension: "jpg",
        storagePath: PATH,
      }],
    })).rejects.toBeInstanceOf(MessagePhotoConflictError);
    expect(remove).not.toHaveBeenCalled();
  });

  it("never deletes a direct-upload object retained by a recovered insert race", async () => {
    let listCount = 0;
    const remove = vi.fn(async () => ({ error: null }));
    const upload = vi.fn();
    const attachmentQuery = {
      select: vi.fn(() => attachmentQuery),
      eq: vi.fn(() => attachmentQuery),
      order: vi.fn(async () => ({
        data: listCount++ === 0 ? [] : [row()],
        error: null,
      })),
      insert: vi.fn(() => ({
        select: vi.fn(async () => ({
          data: null,
          error: { code: "23505", message: "duplicate" },
        })),
      })),
    };
    const messageQuery = {
      select: vi.fn(() => messageQuery),
      eq: vi.fn(() => messageQuery),
      or: vi.fn(() => messageQuery),
      maybeSingle: vi.fn(async () => ({ data: null, error: null })),
    };
    const client = {
      from: vi.fn((table: string) => table === "messages" ? messageQuery : attachmentQuery),
      storage: { from: vi.fn(() => ({ upload, remove })) },
    } as unknown as SupabaseClient;

    await expect(stageOutboundPhotos({
      supabase: client,
      userId: "user_a",
      conversationRootId: ROOT,
      deliveryRequestId: REQUEST,
      photos: [{
        name: "condition.jpg",
        type: "image/jpeg",
        size: JPEG.length,
        bytes: JPEG,
        mediaType: "image/jpeg",
        extension: "jpg",
        storagePath: PATH,
      }],
    })).resolves.toEqual([row()]);
    expect(upload).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("aborts when the database cannot stage the complete reserved photo set", async () => {
    const uploading = row({
      delivery_status: "uploading",
      upload_expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      order: vi.fn(async () => ({ data: [uploading], error: null })),
    };
    const rpc = vi.fn(async () => ({ data: [], error: null }));
    const client = {
      from: vi.fn(() => query),
      rpc,
      storage: { from: vi.fn() },
    } as unknown as SupabaseClient;

    await expect(stageOutboundPhotos({
      supabase: client,
      userId: "user_a",
      conversationRootId: ROOT,
      deliveryRequestId: REQUEST,
      requireExistingIntent: true,
      photos: [{
        name: "condition.jpg",
        type: "image/jpeg",
        size: JPEG.length,
        bytes: JPEG,
        mediaType: "image/jpeg",
        extension: "jpg",
        storagePath: PATH,
      }],
    })).rejects.toThrow("complete photo set");
    expect(rpc).toHaveBeenCalledWith("stage_message_photo_upload_intents", {
      p_delivery_request_id: REQUEST,
      p_attachment_ids: [uploading.id],
    });
  });

  it("keeps a stale canonical upload intent retryable when staging is rejected", async () => {
    const uploading = row({
      delivery_request_id: ROOT,
      delivery_status: "uploading",
      upload_expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      order: vi.fn(async () => ({ data: [uploading], error: null })),
    };
    const rpc = vi.fn(async () => ({
      data: null,
      error: { code: "23514", message: "Canonical reply is no longer draft-sendable" },
    }));
    const client = {
      from: vi.fn(() => query),
      rpc,
      storage: { from: vi.fn() },
    } as unknown as SupabaseClient;

    await expect(stageOutboundPhotos({
      supabase: client,
      userId: "user_a",
      conversationRootId: ROOT,
      deliveryRequestId: ROOT,
      requireExistingIntent: true,
      photos: [{
        name: "condition.jpg",
        type: "image/jpeg",
        size: JPEG.length,
        bytes: JPEG,
        mediaType: "image/jpeg",
        extension: "jpg",
        storagePath: PATH,
      }],
    })).rejects.toBeInstanceOf(MessagePhotoConflictError);
    expect(rpc).toHaveBeenCalledWith("stage_message_photo_upload_intents", {
      p_delivery_request_id: ROOT,
      p_attachment_ids: [uploading.id],
    });
  });

  it("reports a delivery-identity guard rejection as an idempotency conflict", async () => {
    const attachmentQuery = {
      select: vi.fn(() => attachmentQuery),
      eq: vi.fn(() => attachmentQuery),
      order: vi.fn(async () => ({ data: [], error: null })),
      insert: vi.fn(() => ({
        select: vi.fn(async () => ({
          data: null,
          error: { code: "23514", message: "delivery already has an intent" },
        })),
      })),
    };
    const messageQuery = {
      select: vi.fn(() => messageQuery),
      eq: vi.fn(() => messageQuery),
      or: vi.fn(() => messageQuery),
      maybeSingle: vi.fn(async () => ({ data: null, error: null })),
    };
    const client = {
      from: vi.fn((table: string) => table === "messages" ? messageQuery : attachmentQuery),
    } as unknown as SupabaseClient;

    await expect(createOutboundPhotoUploadIntents({
      supabase: client,
      userId: "user_a",
      conversationRootId: ROOT,
      deliveryRequestId: REQUEST,
      photos: [{
        name: "condition.jpg",
        mediaType: "image/jpeg",
        byteSize: JPEG.length,
        contentSha256: createHash("sha256").update(JPEG).digest("hex"),
      }],
    })).rejects.toBeInstanceOf(MessagePhotoConflictError);
  });

  it("does not renew an existing canonical upload reservation", async () => {
    const uploading = row({
      delivery_request_id: ROOT,
      delivery_status: "uploading",
      upload_expires_at: "2026-07-14T12:15:00.000Z",
    });
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      order: vi.fn(async () => ({ data: [uploading], error: null })),
      update: vi.fn(() => query),
    };
    const client = { from: vi.fn(() => query) } as unknown as SupabaseClient;

    await expect(createOutboundPhotoUploadIntents({
      supabase: client,
      userId: "user_a",
      conversationRootId: ROOT,
      deliveryRequestId: ROOT,
      photos: [{
        name: "condition.jpg",
        mediaType: "image/jpeg",
        byteSize: JPEG.length,
        contentSha256: createHash("sha256").update(JPEG).digest("hex"),
      }],
      now: () => Date.parse("2026-07-14T12:14:00.000Z"),
    })).resolves.toEqual([uploading]);
    expect(query.update).not.toHaveBeenCalled();
  });

  it("replaces an expired canonical upload reservation", async () => {
    const expired = row({
      delivery_request_id: ROOT,
      delivery_status: "uploading",
      upload_expires_at: "2026-07-14T12:15:00.000Z",
    });
    const replacement = row({
      id: "44444444-4444-4444-8444-444444444444",
      delivery_request_id: ROOT,
      delivery_status: "uploading",
      storage_path: `user_a/${ROOT}/pending/44444444-4444-4444-8444-444444444444.jpg`,
      upload_expires_at: "2026-07-14T12:31:00.000Z",
    });
    let listCount = 0;
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      order: vi.fn(async () => ({
        data: listCount++ === 0 ? [expired] : [],
        error: null,
      })),
      insert: vi.fn(() => ({
        select: vi.fn(async () => ({ data: [replacement], error: null })),
      })),
    };
    const messageQuery = {
      select: vi.fn(() => messageQuery),
      eq: vi.fn(() => messageQuery),
      or: vi.fn(() => messageQuery),
      maybeSingle: vi.fn(async () => ({ data: null, error: null })),
    };
    const rpc = vi.fn(async () => ({ data: 1, error: null }));
    const client = {
      from: vi.fn((table: string) => table === "messages" ? messageQuery : query),
      rpc,
    } as unknown as SupabaseClient;

    await expect(createOutboundPhotoUploadIntents({
      supabase: client,
      userId: "user_a",
      conversationRootId: ROOT,
      deliveryRequestId: ROOT,
      photos: [{
        name: "condition.jpg",
        mediaType: "image/jpeg",
        byteSize: JPEG.length,
        contentSha256: createHash("sha256").update(JPEG).digest("hex"),
      }],
      now: () => Date.parse("2026-07-14T12:16:00.000Z"),
    })).resolves.toEqual([replacement]);
    expect(rpc).toHaveBeenCalledWith(
      "delete_own_expired_message_photo_upload_intents_for_request",
      { p_delivery_request_id: ROOT },
    );
    expect(query.insert).toHaveBeenCalledOnce();
  });

  it("cleans a multipart upload when its delivery identity was already claimed", async () => {
    const attachmentQuery = {
      select: vi.fn(() => attachmentQuery),
      eq: vi.fn(() => attachmentQuery),
      order: vi.fn(async () => ({ data: [], error: null })),
      insert: vi.fn(() => ({
        select: vi.fn(async () => ({
          data: null,
          error: { code: "23514", message: "delivery already has an intent" },
        })),
      })),
    };
    const messageQuery = {
      select: vi.fn(() => messageQuery),
      eq: vi.fn(() => messageQuery),
      or: vi.fn(() => messageQuery),
      maybeSingle: vi.fn(async () => ({ data: null, error: null })),
    };
    const upload = vi.fn(async () => ({ error: null }));
    const remove = vi.fn(async () => ({ error: null }));
    const client = {
      from: vi.fn((table: string) => table === "messages" ? messageQuery : attachmentQuery),
      storage: { from: vi.fn(() => ({ upload, remove })) },
    } as unknown as SupabaseClient;

    await expect(stageOutboundPhotos({
      supabase: client,
      userId: "user_a",
      conversationRootId: ROOT,
      deliveryRequestId: REQUEST,
      photos: [{
        name: "condition.jpg",
        type: "image/jpeg",
        size: JPEG.length,
        bytes: JPEG,
        mediaType: "image/jpeg",
        extension: "jpg",
      }],
    })).rejects.toBeInstanceOf(MessagePhotoConflictError);
    expect(upload).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith([expect.stringMatching(/\.jpg$/)]);
  });
});
