import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  cleanupClerkTestUsers,
  mintUserJwt,
  provisionClerkTestUser,
  type ClerkTestUser,
} from "@/lib/supabase/test-users";

const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
let reachable = false;
let admin: SupabaseClient;
let a: ClerkTestUser;
let b: ClerkTestUser;
let aServer: SupabaseClient;
let bServer: SupabaseClient;
let bStoragePath: string | null = null;

beforeAll(async () => {
  if (!ANON || !SERVICE) return;
  try {
    const health = await fetch(`${URL}/auth/v1/health`, { headers: { apikey: ANON }, signal: AbortSignal.timeout(2_000) });
    reachable = health.ok;
  } catch { return; }
  if (!reachable) return;
  admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
  [a, b] = await Promise.all([
    provisionClerkTestUser(URL, ANON, "attachment_a"),
    provisionClerkTestUser(URL, ANON, "attachment_b"),
  ]);
  const [aJwt, bJwt] = await Promise.all([
    mintUserJwt(a.id),
    mintUserJwt(b.id),
  ]);
  aServer = createClient(URL, SERVICE!, {
    accessToken: async () => aJwt,
    auth: { persistSession: false, autoRefreshToken: false },
  });
  bServer = createClient(URL, SERVICE!, {
    accessToken: async () => bJwt,
    auth: { persistSession: false, autoRefreshToken: false },
  });
});

afterAll(async () => {
  if (reachable) {
    if (bStoragePath) await admin.storage.from("message-photos").remove([bStoragePath]);
    await cleanupClerkTestUsers(admin, [a.id, b.id]);
  }
});

describe("message attachment RLS (DB-gated)", () => {
  it("requires the local stack and never fakes a policy pass", () => {
    if (!reachable) console.warn("[attachments.rls.test] Local Supabase unavailable; policy assertions skipped.");
    expect(true).toBe(true);
  });

  it("hides another tenant's metadata and rejects a forged tenant insert", async () => {
    if (!reachable) return;
    const { data: root, error: rootError } = await b.client.from("messages").insert({
      user_id: b.id,
      direction: "inbound",
      body: "Buyer photo",
    }).select("id").single();
    expect(rootError).toBeNull();
    const row = {
      user_id: b.id,
      conversation_root_id: root!.id,
      message_id: root!.id,
      delivery_request_id: "inbound:test",
      position: 0,
      direction: "inbound",
      original_name: "buyer.jpg",
      provider_url: "https://i.ebayimg.com/images/g/test/s-l1600.jpg",
      delivery_status: "delivered",
    };
    expect((await admin.from("message_attachments").insert(row)).error).toBeNull();
    expect((await b.client.from("message_attachments").insert({
      ...row,
      delivery_request_id: "inbound:browser-forgery",
    })).error).not.toBeNull();
    expect((await bServer.from("message_attachments").insert({
      ...row,
      delivery_request_id: "inbound:foreground-sync",
    })).error).toBeNull();
    const { data: leaked } = await a.client.from("message_attachments").select("*");
    expect(leaked).toHaveLength(0);
    expect((await a.client.from("message_attachments").insert({ ...row, user_id: b.id })).error).not.toBeNull();

    bStoragePath = `${b.id}/${root!.id}/buyer.jpg`;
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    expect((await bServer.storage.from("message-photos").upload(bStoragePath, jpeg, {
      contentType: "image/jpeg",
    })).error).toBeNull();
    const { data: staged, error: stagedError } = await b.client
      .from("message_attachments")
      .insert({
        user_id: b.id,
        conversation_root_id: root!.id,
        delivery_request_id: "outbound:test",
        position: 0,
        direction: "outbound",
        media_type: "image/jpeg",
        byte_size: jpeg.byteLength,
        original_name: "seller.jpg",
        content_sha256: "a".repeat(64),
        storage_path: bStoragePath,
        delivery_status: "staged",
      })
      .select("id")
      .single();
    expect(stagedError).toBeNull();
    const forged = await b.client
      .from("message_attachments")
      .update({
        provider_media_id: "forged",
        provider_url: "https://attacker.example/photo.jpg",
        delivery_status: "delivered",
      })
      .eq("id", staged!.id)
      .select("id");
    expect(forged.error).not.toBeNull();
    const serverUpdate = await bServer
      .from("message_attachments")
      .update({
        provider_media_id: "eps-test",
        provider_url: "https://i.ebayimg.com/images/g/test/s-l1600.jpg",
        delivery_status: "uploaded",
      })
      .eq("id", staged!.id)
      .select("id")
      .single();
    expect(serverUpdate.error).toBeNull();
    expect((await b.client.storage.from("message-photos").upload(
      bStoragePath,
      new Uint8Array([0xff, 0xd8, 0xff, 0xe1]),
      { contentType: "image/jpeg", upsert: true },
    )).error).not.toBeNull();
    expect((await a.client.storage.from("message-photos").download(bStoragePath)).error).not.toBeNull();
    expect((await a.client.storage.from("message-photos").upload(bStoragePath, jpeg, {
      contentType: "image/jpeg",
      upsert: true,
    })).error).not.toBeNull();

    const uploadIntent = {
      user_id: b.id,
      conversation_root_id: root!.id,
      delivery_request_id: "outbound:upload-intent",
      position: 0,
      direction: "outbound",
      media_type: "image/jpeg",
      byte_size: jpeg.byteLength,
      original_name: "pending.jpg",
      content_sha256: "b".repeat(64),
      storage_path: `${b.id}/${root!.id}/pending/33333333-3333-4333-8333-333333333333.jpg`,
      delivery_status: "uploading",
      upload_expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
    expect((await b.client.from("message_attachments").insert(uploadIntent)).error).not.toBeNull();
    expect((await bServer.from("message_attachments").insert(uploadIntent)).error).toBeNull();
    expect((await b.client.storage.from("message-photos").upload(uploadIntent.storage_path, jpeg, {
      contentType: "image/jpeg",
    })).error).toBeNull();
    expect((await b.client.storage.from("message-photos").upload(
      `${b.id}/${root!.id}/pending/44444444-4444-4444-8444-444444444444.jpg`,
      jpeg,
      { contentType: "image/jpeg" },
    )).error).not.toBeNull();
    await b.client.storage.from("message-photos").remove([
      uploadIntent.storage_path,
    ]);
    expect((await admin.storage.from("message-photos").download(
      uploadIntent.storage_path,
    )).error).toBeNull();
    expect((await admin.storage.from("message-photos").remove([
      uploadIntent.storage_path,
    ])).error).toBeNull();
  });

  it("isolates tenant upload expiry and object-deletion acknowledgements", async () => {
    if (!reachable) return;
    const [{ data: rootA, error: rootAError }, { data: rootB, error: rootBError }] = await Promise.all([
      a.client.from("messages").insert({
        user_id: a.id,
        direction: "inbound",
        body: "Tenant A cleanup root",
      }).select("id").single(),
      b.client.from("messages").insert({
        user_id: b.id,
        direction: "inbound",
        body: "Tenant B cleanup root",
      }).select("id").single(),
    ]);
    expect(rootAError).toBeNull();
    expect(rootBError).toBeNull();

    const expiredAt = new Date(Date.now() - 60_000).toISOString();
    const pathA = `${a.id}/${rootA!.id}/pending/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg`;
    const pathB = `${b.id}/${rootB!.id}/pending/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg`;
    const intent = (
      user: ClerkTestUser,
      rootId: string,
      requestId: string,
      storagePath: string,
      hash: string,
    ) => ({
      user_id: user.id,
      conversation_root_id: rootId,
      delivery_request_id: requestId,
      position: 0,
      direction: "outbound",
      media_type: "image/jpeg",
      byte_size: 4,
      original_name: "expired.jpg",
      content_sha256: hash.repeat(64),
      storage_path: storagePath,
      delivery_status: "uploading",
      upload_expires_at: expiredAt,
    });

    expect((await bServer.from("message_attachments").insert(
      intent(b, rootB!.id, "cleanup:b", pathB, "b"),
    )).error).toBeNull();
    const aCannotExpireB = await aServer.rpc(
      "delete_own_expired_message_photo_upload_intents_for_request",
      { p_delivery_request_id: "cleanup:b" },
    );
    expect(aCannotExpireB.error).toBeNull();
    expect(aCannotExpireB.data).toBe(0);
    expect((await admin.from("message_attachments").select("id").eq("storage_path", pathB)).data)
      .toHaveLength(1);

    expect((await aServer.from("message_attachments").insert(
      intent(a, rootA!.id, "cleanup:a", pathA, "a"),
    )).error).toBeNull();
    const bExpiry = await bServer.rpc(
      "delete_own_expired_message_photo_upload_intents_for_request",
      { p_delivery_request_id: "cleanup:b" },
    );
    expect(bExpiry.error).toBeNull();
    expect(bExpiry.data).toBe(1);
    expect((await admin.from("message_attachments").select("id").eq("storage_path", pathA)).data)
      .toHaveLength(1);

    const aQueue = await aServer.rpc("list_own_message_photo_object_deletions", {
      p_limit: 1000,
    });
    expect(aQueue.error).toBeNull();
    expect(aQueue.data).not.toContain(pathB);
    const aCannotCompleteB = await aServer.rpc(
      "complete_own_message_photo_object_deletions",
      { p_storage_paths: [pathB] },
    );
    expect(aCannotCompleteB.error).toBeNull();
    expect(aCannotCompleteB.data).toBe(0);
    const bQueue = await bServer.rpc("list_own_message_photo_object_deletions", {
      p_limit: 1000,
    });
    expect(bQueue.error).toBeNull();
    expect(bQueue.data).toContain(pathB);
    expect((await bServer.rpc("complete_own_message_photo_object_deletions", {
      p_storage_paths: [pathB],
    })).data).toBe(1);

    expect((await aServer.rpc("delete_own_expired_message_photo_upload_intents_for_request", {
      p_delivery_request_id: "cleanup:a",
    })).data).toBe(1);
    const bCannotCompleteA = await bServer.rpc(
      "complete_own_message_photo_object_deletions",
      { p_storage_paths: [pathA] },
    );
    expect(bCannotCompleteA.error).toBeNull();
    expect(bCannotCompleteA.data).toBe(0);
    expect((await bServer.rpc("list_own_message_photo_object_deletions", {
      p_limit: 1000,
    })).data).not.toContain(pathA);
    expect((await aServer.rpc("list_own_message_photo_object_deletions", {
      p_limit: 1000,
    })).data).toContain(pathA);
    expect((await aServer.rpc("complete_own_message_photo_object_deletions", {
      p_storage_paths: [pathA],
    })).data).toBe(1);
  });

  it("lets a tenant abandon only its own live upload intents", async () => {
    if (!reachable) return;
    const [{ data: rootA, error: rootAError }, { data: rootB, error: rootBError }] = await Promise.all([
      a.client.from("messages").insert({
        user_id: a.id,
        direction: "inbound",
        body: "Tenant A live upload root",
      }).select("id").single(),
      b.client.from("messages").insert({
        user_id: b.id,
        direction: "inbound",
        body: "Tenant B live upload root",
      }).select("id").single(),
    ]);
    expect(rootAError).toBeNull();
    expect(rootBError).toBeNull();

    const liveUntil = new Date(Date.now() + 15 * 60_000).toISOString();
    const pathA = `${a.id}/${rootA!.id}/pending/dddddddd-dddd-4ddd-8ddd-dddddddddddd.jpg`;
    const pathB = `${b.id}/${rootB!.id}/pending/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.jpg`;
    const intent = (
      user: ClerkTestUser,
      rootId: string,
      requestId: string,
      storagePath: string,
      hash: string,
    ) => ({
      user_id: user.id,
      conversation_root_id: rootId,
      delivery_request_id: requestId,
      position: 0,
      direction: "outbound",
      media_type: "image/jpeg",
      byte_size: 4,
      original_name: "abandoned.jpg",
      content_sha256: hash.repeat(64),
      storage_path: storagePath,
      delivery_status: "uploading",
      upload_expires_at: liveUntil,
    });

    expect((await aServer.from("message_attachments").insert(
      intent(a, rootA!.id, "abandon:a", pathA, "d"),
    )).error).toBeNull();
    expect((await bServer.from("message_attachments").insert(
      intent(b, rootB!.id, "abandon:b", pathB, "e"),
    )).error).toBeNull();

    const aCannotAbandonB = await aServer.rpc(
      "delete_own_message_photo_upload_intents_for_request",
      { p_delivery_request_id: "abandon:b" },
    );
    expect(aCannotAbandonB.error).toBeNull();
    expect(aCannotAbandonB.data).toBe(0);
    expect((await admin.from("message_attachments").select("id").eq("storage_path", pathB)).data)
      .toHaveLength(1);

    const bAbandonsOwn = await bServer.rpc(
      "delete_own_message_photo_upload_intents_for_request",
      { p_delivery_request_id: "abandon:b" },
    );
    expect(bAbandonsOwn.error).toBeNull();
    expect(bAbandonsOwn.data).toBe(1);
    expect((await admin.from("message_attachments").select("id").eq("storage_path", pathA)).data)
      .toHaveLength(1);
    expect((await bServer.rpc("list_own_message_photo_object_deletions", {
      p_limit: 1000,
    })).data).toContain(pathB);
    expect((await aServer.rpc("list_own_message_photo_object_deletions", {
      p_limit: 1000,
    })).data).not.toContain(pathB);

    expect((await aServer.rpc("delete_own_message_photo_upload_intents_for_request", {
      p_delivery_request_id: "abandon:a",
    })).data).toBe(1);
    expect((await bServer.rpc("complete_own_message_photo_object_deletions", {
      p_storage_paths: [pathB],
    })).data).toBe(1);
    expect((await aServer.rpc("complete_own_message_photo_object_deletions", {
      p_storage_paths: [pathA],
    })).data).toBe(1);
  });

  it("keeps a stale canonical photo intent expiring instead of staging it", async () => {
    if (!reachable) return;
    const { data: root, error: rootError } = await admin
      .from("messages")
      .insert({
        user_id: b.id,
        direction: "inbound",
        body: "Stale canonical photo root",
        marketplace: "ebay",
        status: "drafted",
      })
      .select("id")
      .single();
    expect(rootError).toBeNull();

    const attachmentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const uploadExpiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const { error: intentError } = await bServer
      .from("message_attachments")
      .insert({
        id: attachmentId,
        user_id: b.id,
        conversation_root_id: root!.id,
        delivery_request_id: root!.id,
        position: 0,
        direction: "outbound",
        media_type: "image/jpeg",
        byte_size: 4,
        original_name: "stale.jpg",
        content_sha256: "c".repeat(64),
        storage_path: `${b.id}/${root!.id}/pending/${attachmentId}.jpg`,
        delivery_status: "uploading",
        upload_expires_at: uploadExpiresAt,
      });
    expect(intentError).toBeNull();
    expect((await admin
      .from("messages")
      .update({ status: "sent", delivery_status: "ambiguous" })
      .eq("id", root!.id)).error).toBeNull();

    const staged = await bServer.rpc("stage_message_photo_upload_intents", {
      p_delivery_request_id: root!.id,
      p_attachment_ids: [attachmentId],
    });
    expect(staged.error?.code).toBe("23514");
    expect(staged.error?.message).toMatch(/no longer draft-sendable/i);

    const { data: retained, error: retainedError } = await admin
      .from("message_attachments")
      .select("delivery_status, upload_expires_at, message_id")
      .eq("id", attachmentId)
      .single();
    expect(retainedError).toBeNull();
    expect(retained).toMatchObject({
      delivery_status: "uploading",
      message_id: null,
    });
    expect(retained?.upload_expires_at).not.toBeNull();
  });
});
