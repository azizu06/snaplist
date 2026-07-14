import type { SupabaseClient } from "@supabase/supabase-js";
import { MESSAGE_PHOTO_BUCKET } from "./attachments";

const STORAGE_DELETE_BATCH_SIZE = 1000;

export async function drainMessagePhotoDeletionQueue(
  serviceClient: SupabaseClient,
): Promise<void> {
  return drainDeletionQueue(
    serviceClient,
    serviceClient,
    "list_message_photo_object_deletions",
    "complete_message_photo_object_deletions",
  );
}

export async function drainOwnMessagePhotoDeletionQueue(
  tenantServerClient: SupabaseClient,
  storageAdminClient: SupabaseClient,
): Promise<void> {
  return drainDeletionQueue(
    tenantServerClient,
    storageAdminClient,
    "list_own_message_photo_object_deletions",
    "complete_own_message_photo_object_deletions",
  );
}

async function drainDeletionQueue(
  queueClient: SupabaseClient,
  storageClient: SupabaseClient,
  listRpc: string,
  completeRpc: string,
): Promise<void> {
  while (true) {
    const { data, error } = await queueClient.rpc(
      listRpc,
      { p_limit: STORAGE_DELETE_BATCH_SIZE },
    );
    if (error) throw new Error(`Deletion photo queue failed: ${error.message}`);
    const paths = Array.isArray(data)
      ? data.filter((path): path is string => typeof path === "string")
      : [];
    if (!paths.length) return;
    const removed = await storageClient.storage.from(MESSAGE_PHOTO_BUCKET).remove(paths);
    if (removed.error) {
      throw new Error(`Deletion photo erase failed: ${removed.error.message}`);
    }
    const completed = await queueClient.rpc(
      completeRpc,
      { p_storage_paths: paths },
    );
    if (completed.error) {
      throw new Error(`Deletion photo queue completion failed: ${completed.error.message}`);
    }
  }
}

export async function cleanupExpiredMessagePhotoUploads(
  serviceClient: SupabaseClient,
): Promise<number> {
  let deleted = 0;
  while (true) {
    const { data, error } = await serviceClient.rpc(
      "delete_expired_message_photo_upload_intents",
      { p_limit: STORAGE_DELETE_BATCH_SIZE },
    );
    if (error) throw new Error(`Expired photo cleanup failed: ${error.message}`);
    if (typeof data !== "number") {
      throw new Error("Expired photo cleanup failed: database returned an invalid result");
    }
    deleted += data;
    if (data < STORAGE_DELETE_BATCH_SIZE) break;
  }
  await drainMessagePhotoDeletionQueue(serviceClient);
  return deleted;
}

export async function cleanupOwnExpiredMessagePhotoUploads(
  tenantServerClient: SupabaseClient,
  storageAdminClient: SupabaseClient,
): Promise<number> {
  let deleted = 0;
  while (true) {
    const { data, error } = await tenantServerClient.rpc(
      "delete_own_expired_message_photo_upload_intents",
      { p_limit: STORAGE_DELETE_BATCH_SIZE },
    );
    if (error) throw new Error(`Expired photo cleanup failed: ${error.message}`);
    if (typeof data !== "number") {
      throw new Error("Expired photo cleanup failed: database returned an invalid result");
    }
    deleted += data;
    if (data < STORAGE_DELETE_BATCH_SIZE) break;
  }
  await drainOwnMessagePhotoDeletionQueue(
    tenantServerClient,
    storageAdminClient,
  );
  return deleted;
}
