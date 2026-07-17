import { createHash } from "node:crypto";
import type {
  GuestClaimObject,
  GuestClaimStorage,
  GuestClaimVerifiedObject,
} from "./service";

interface StorageError {
  message: string;
}

interface GuestStorageBucket {
  copy(
    sourcePath: string,
    destinationPath: string,
  ): Promise<{ data: unknown; error: StorageError | null }>;
  download(
    path: string,
  ): Promise<{ data: Blob | null; error: StorageError | null }>;
  remove(
    paths: string[],
  ): Promise<{ data: unknown; error: StorageError | null }>;
}

export interface GuestStorageClient {
  storage: { from(bucket: "photos"): GuestStorageBucket };
}

function sha256(bytes: ArrayBuffer): string {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

/**
 * Private `photos` bucket capability used only after the database returns an
 * exact source/destination plan. A server-side copy is never trusted until the
 * destination bytes match both the durable digest and length.
 */
export function createSupabaseGuestClaimStorage(
  client: GuestStorageClient,
): GuestClaimStorage {
  const bucket = client.storage.from("photos");
  return {
    async copyAndVerify(object: GuestClaimObject): Promise<GuestClaimVerifiedObject> {
      // An already-exists error can be an interrupted prior attempt. Verification
      // below is authoritative, so an exact existing destination is idempotent.
      await bucket.copy(object.sourcePath, object.destinationPath);
      const downloaded = await bucket.download(object.destinationPath);
      if (downloaded.error || !downloaded.data) {
        throw new Error("Guest Storage destination could not be verified.");
      }

      const bytes = await downloaded.data.arrayBuffer();
      const digest = sha256(bytes);
      if (bytes.byteLength !== object.byteLength || digest !== object.sha256) {
        await bucket.remove([object.destinationPath]).catch(() => undefined);
        throw new Error("Guest Storage destination verification failed.");
      }

      return {
        destinationPath: object.destinationPath,
        sha256: digest,
        byteLength: bytes.byteLength,
      };
    },

    async remove(destinationPaths) {
      if (destinationPaths.length === 0) return;
      const removed = await bucket.remove(destinationPaths);
      if (removed.error) {
        throw new Error("Guest Storage destination cleanup failed.");
      }
    },
  };
}
