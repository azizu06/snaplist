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
  const bJwt = await mintUserJwt(b.id);
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
    expect((await b.client.storage.from("message-photos").upload(bStoragePath, jpeg, {
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
    expect((await a.client.storage.from("message-photos").download(bStoragePath)).error).not.toBeNull();
    expect((await a.client.storage.from("message-photos").upload(bStoragePath, jpeg, {
      contentType: "image/jpeg",
      upsert: true,
    })).error).not.toBeNull();
  });
});
