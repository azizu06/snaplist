import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Storage-side completion for eBay Marketplace Account Deletion (issue #599).
 *
 * The buyer inbox is retired, so nothing enqueues message photos any more. The
 * `message_photos` tables and their deletion queue still exist until a separate
 * migration drops them (see #599: applied migrations are superseded, never
 * removed), which means rows enqueued before the retirement are still owed a
 * storage delete. `erase_ebay_user_data` only marks database rows; without this
 * drain those objects would outlive the erasure they belong to.
 *
 * This lived in the retired inbox module's `attachment-cleanup`. It moved here
 * rather than being deleted with the inbox because its one surviving caller is
 * the erasure path, not buyer messaging. It retires with the table-drop issue.
 */

const MESSAGE_PHOTO_BUCKET = "message-photos";
const STORAGE_DELETE_BATCH_SIZE = 1000;

export async function drainMessagePhotoDeletionQueue(
  serviceClient: SupabaseClient,
): Promise<void> {
  while (true) {
    const { data, error } = await serviceClient.rpc(
      "list_message_photo_object_deletions",
      { p_limit: STORAGE_DELETE_BATCH_SIZE },
    );
    if (error) throw new Error(`Deletion photo queue failed: ${error.message}`);
    const paths = Array.isArray(data)
      ? data.filter((path): path is string => typeof path === "string")
      : [];
    if (!paths.length) return;
    const removed = await serviceClient.storage
      .from(MESSAGE_PHOTO_BUCKET)
      .remove(paths);
    if (removed.error) {
      throw new Error(`Deletion photo erase failed: ${removed.error.message}`);
    }
    const completed = await serviceClient.rpc(
      "complete_message_photo_object_deletions",
      { p_storage_paths: paths },
    );
    if (completed.error) {
      throw new Error(`Deletion photo queue completion failed: ${completed.error.message}`);
    }
  }
}
