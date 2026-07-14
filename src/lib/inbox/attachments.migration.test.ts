import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260714170000_message_photo_attachments.sql"),
  "utf8",
);

describe("message photo attachment migration", () => {
  it("keeps binary objects private and constrained to the supported image subset", () => {
    expect(migration).toMatch(/'message-photos'[\s\S]*false[\s\S]*12582912/i);
    expect(migration).toContain("'image/jpeg', 'image/png', 'image/webp'");
    expect(migration).toMatch(/message_photos_select_own[\s\S]*clerk_user_id\(\)/i);
  });

  it("pins both message relationships to the same tenant and enables RLS plus Realtime", () => {
    expect(migration).toMatch(/foreign key \(conversation_root_id, user_id\)\s*references public\.messages \(id, user_id\)/i);
    expect(migration).toMatch(/foreign key \(message_id, user_id\)\s*references public\.messages \(id, user_id\)/i);
    expect(migration).toMatch(/enable row level security/i);
    expect(migration).toMatch(/message_attachments_select_own[\s\S]*user_id = public\.clerk_user_id\(\)/i);
    expect(migration).toMatch(/message_attachments_insert_own[\s\S]*delivery_status = 'staged'/i);
    expect(migration).toMatch(/direction = 'inbound'[\s\S]*provider_url is not null[\s\S]*sb_secret_%/i);
    expect(migration).toMatch(/message_attachments_update_server_own/i);
    expect(migration).toMatch(/enforce_message_attachment_server_update[\s\S]*sb_secret_%/i);
    expect(migration).toMatch(/supabase_realtime add table public\.message_attachments/i);
  });

  it("makes one position per durable delivery request idempotent", () => {
    expect(migration).toMatch(/unique[\s\S]*\(user_id, delivery_request_id, position\)/i);
  });

  it("completes the exact message lifecycle and attachment visibility atomically", () => {
    expect(migration).toMatch(/function public\.complete_ebay_message_write_with_photos/i);
    expect(migration).toMatch(/private\.apply_authenticated_ebay_message_write/i);
    expect(migration).toMatch(/provider_media_id is null[\s\S]*provider_url is null/i);
    expect(migration).toMatch(/set message_id = v_message_id,[\s\S]*delivery_status = 'delivered'/i);
  });

  it("queues object deletion inside the generation-scoped database erasure", () => {
    expect(migration).toMatch(/message_photo_object_deletion_queue/i);
    expect(migration).toMatch(/after delete on public\.message_attachments/i);
    expect(migration).toMatch(/list_message_photo_object_deletions/i);
    expect(migration).toMatch(/complete_message_photo_object_deletions/i);
    expect(migration).toMatch(/list_message_photo_object_deletions[\s\S]*limit least[\s\S]*1000/i);
    expect(migration).toMatch(/delete_expired_message_photo_upload_intents/i);
  });

  it("persists expiring upload intents before direct storage writes", () => {
    expect(migration).toMatch(/upload_expires_at timestamptz/i);
    expect(migration).toMatch(/delivery_status in \('uploading', 'staged'/i);
    expect(migration).toMatch(/delivery_status = 'uploading'[\s\S]*upload_expires_at is not null/i);
    expect(migration).toMatch(/message_photos_insert_own[\s\S]*storage_path = name[\s\S]*delivery_status = 'uploading'/i);
  });
});
