import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  cleanupOwnExpiredMessagePhotoUploads,
  drainMessagePhotoDeletionQueue,
} from "./attachment-cleanup";

describe("message photo deletion queue", () => {
  it("removes and acknowledges no more than 1000 objects per batch", async () => {
    const paths = Array.from({ length: 1001 }, (_, index) => `user/root/${index}.jpg`);
    let offset = 0;
    const rpc = vi.fn(async (name: string, args: { p_storage_paths?: string[] }) => {
      if (name === "list_message_photo_object_deletions") {
        return { data: paths.slice(offset, offset + 1000), error: null };
      }
      offset += args.p_storage_paths?.length ?? 0;
      return { data: args.p_storage_paths?.length ?? 0, error: null };
    });
    const remove = vi.fn(async (_batch: string[]) => ({ error: null }));
    const client = {
      rpc,
      storage: { from: vi.fn(() => ({ remove })) },
    } as unknown as SupabaseClient;

    await drainMessagePhotoDeletionQueue(client);

    expect(remove.mock.calls.map(([batch]) => batch.length)).toEqual([1000, 1]);
    expect(rpc).toHaveBeenCalledWith("list_message_photo_object_deletions", {
      p_limit: 1000,
    });
  });

  it("uses only tenant-derived expiry and deletion queue RPCs in foreground cleanup", async () => {
    const path = "user_a/root/photo.jpg";
    let listed = false;
    const rpc = vi.fn(async (name: string) => {
      if (name === "delete_own_expired_message_photo_upload_intents") {
        return { data: 1, error: null };
      }
      if (name === "list_own_message_photo_object_deletions") {
        if (listed) return { data: [], error: null };
        listed = true;
        return { data: [path], error: null };
      }
      return { data: 1, error: null };
    });
    const remove = vi.fn(async (_paths: string[]) => ({ error: null }));
    const client = {
      rpc,
      storage: { from: vi.fn(() => ({ remove })) },
    } as unknown as SupabaseClient;

    await expect(cleanupOwnExpiredMessagePhotoUploads(client)).resolves.toBe(1);

    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      "delete_own_expired_message_photo_upload_intents",
      "list_own_message_photo_object_deletions",
      "complete_own_message_photo_object_deletions",
      "list_own_message_photo_object_deletions",
    ]);
    expect(remove).toHaveBeenCalledWith([path]);
  });
});
