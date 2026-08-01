import type { PipelinePhotoCleanupCapability } from "./maintenance";

/**
 * The narrow slice of a Supabase Storage bucket the cleanup capability needs.
 * Keeping it duck-typed lets the integration tests hand in the same admin
 * bucket the worker uses instead of restating the capability inline, so the
 * absence proof under test is the one that runs in production.
 */
export interface StorageCleanupBucket {
  remove(paths: string[]): PromiseLike<{ error: { message: string } | null }>;
  exists(path: string): PromiseLike<{ data: boolean }>;
}

export function createStorageCleanupCapability(
  bucket: StorageCleanupBucket,
): PipelinePhotoCleanupCapability {
  return {
    async remove(paths) {
      const { error } = await bucket.remove(paths);
      if (error) throw new Error("Photo cleanup failed");
    },

    // A removal call that returned without error is not proof of absence: the
    // bucket reports success for a path it never held. The raw seller voice
    // retention row names an absent object as its completion proof, so read
    // each path back. `exists` reports false only for a 400/404 and rethrows
    // every other transport failure, which keeps an unreachable bucket a retry
    // rather than a false receipt.
    async confirmAbsent(paths) {
      for (const path of paths) {
        const { data } = await bucket.exists(path);
        if (data) throw new Error("Raw seller voice object is still present");
      }
    },
  };
}
