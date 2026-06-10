import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Resolve private Storage object paths to short-lived signed URLs the vision call
 * can fetch (issue #6). Photos live in the private `photos` bucket with user-scoped
 * paths and RLS/storage policies — they are NOT publicly readable, so the model is
 * handed a signed URL (mirrors the review page's `createSignedUrl` usage).
 *
 * Thin and unit-testable: it depends only on the storage `from().createSignedUrl`
 * surface, so a fake client exercises it offline.
 */

/** The private bucket photos are stored under (paths scoped by `user_id`). */
export const PHOTOS_BUCKET = "photos";

/** Default signed-URL lifetime: 10 minutes — long enough for one extraction call. */
export const DEFAULT_SIGNED_URL_TTL_SECONDS = 60 * 10;

/** The narrow storage surface this module needs — keeps fakes trivial in tests. */
export interface SignedUrlClient {
  storage: {
    from(bucket: string): {
      createSignedUrl(
        path: string,
        expiresIn: number,
      ): Promise<{ data: { signedUrl: string } | null; error: { message: string } | null }>;
    };
  };
}

/**
 * Map each storage path to a signed URL, IN ORDER (the first photo stays first so
 * the model's "primary" image is stable). Throws on the first failure — a missing
 * or unauthorized object is a real error, not something to silently drop, since it
 * would otherwise feed the model a short/empty image set.
 */
export async function resolvePhotoImages(
  supabase: SupabaseClient | SignedUrlClient,
  paths: string[],
  options: { expiresIn?: number; bucket?: string } = {},
): Promise<string[]> {
  const expiresIn = options.expiresIn ?? DEFAULT_SIGNED_URL_TTL_SECONDS;
  const bucket = options.bucket ?? PHOTOS_BUCKET;
  const store = (supabase as SignedUrlClient).storage.from(bucket);

  const urls: string[] = [];
  for (const path of paths) {
    const { data, error } = await store.createSignedUrl(path, expiresIn);
    if (error || !data?.signedUrl) {
      throw new Error(
        `Failed to sign photo "${path}": ${error?.message ?? "no signed URL returned"}`,
      );
    }
    urls.push(data.signedUrl);
  }
  return urls;
}
