import { describe, expect, it } from "vitest";
import type { MessageAttachmentRow } from "@/lib/inbox";
import { reconcileAttachments } from "./reconcile";

function attachment(updatedAt: string, status: MessageAttachmentRow["delivery_status"]): MessageAttachmentRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    user_id: "user_a",
    conversation_root_id: "22222222-2222-4222-8222-222222222222",
    message_id: null,
    delivery_request_id: "33333333-3333-4333-8333-333333333333",
    position: 0,
    direction: "outbound",
    media_type: "image/jpeg",
    byte_size: 4,
    original_name: "condition.jpg",
    content_sha256: "a".repeat(64),
    storage_path: "user_a/root/photo.jpg",
    provider_media_id: null,
    provider_url: null,
    provider_expires_at: null,
    upload_expires_at: null,
    delivery_status: status,
    delivery_error: null,
    created_at: "2026-07-14T12:00:00.000Z",
    updated_at: updatedAt,
  };
}

describe("attachment state reconciliation", () => {
  it("does not let an older refetch overwrite a newer Realtime completion", () => {
    const completed = attachment("2026-07-14T12:02:00.000Z", "delivered");
    const staleSnapshot = attachment("2026-07-14T12:01:00.000Z", "staged");

    expect(reconcileAttachments([completed], [staleSnapshot])).toEqual([completed]);
  });
});
