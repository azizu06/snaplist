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

/** The narrow storage surface for downloading object BYTES — keeps test fakes trivial. */
export interface DownloadClient {
  storage: {
    from(bucket: string): {
      download(
        path: string,
      ): Promise<{ data: Blob | null; error: { message: string } | null }>;
    };
  };
}

/** One inline image for the vision call: raw bytes + their media type. */
export interface PhotoImageData {
  data: Uint8Array;
  mediaType: string;
}

/**
 * Fallback media type from a stored object's extension, used only when the download
 * response carries no Content-Type. Upload restricts to PNG/JPEG/WEBP and stamps the
 * content type, so this is belt-and-suspenders; unknown extensions default to JPEG.
 */
function mediaTypeFromPath(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

/**
 * Download each private photo's BYTES, IN ORDER, for the vision call. We inline bytes
 * into the model request instead of handing the model a signed URL because:
 *   - The dev provider (Gemini) can't fetch arbitrary remote URLs, so the AI SDK
 *     downloads them server-side and REJECTS private/loopback hosts — local Supabase
 *     Storage is `http://127.0.0.1:54321`, so a URL never works in local dev.
 *   - Inlining also drops a production dependency on the provider fetching a short-TTL
 *     signed URL (region/allowlist rules) and never exposes a photo URL to a third party.
 * `.download()` goes through the SAME RLS/storage policies as `createSignedUrl`, so a
 * user-scoped client only ever reads its own objects (tenancy preserved). Throws on the
 * first failure — a missing/unauthorized object is a real error, not something to drop.
 */
export async function resolvePhotoImageData(
  supabase: SupabaseClient | DownloadClient,
  paths: string[],
  options: { bucket?: string } = {},
): Promise<PhotoImageData[]> {
  const bucket = options.bucket ?? PHOTOS_BUCKET;
  const store = (supabase as DownloadClient).storage.from(bucket);

  const images: PhotoImageData[] = [];
  for (const path of paths) {
    const { data, error } = await store.download(path);
    if (error || !data) {
      throw new Error(
        `Failed to download photo "${path}": ${error?.message ?? "no data returned"}`,
      );
    }
    const bytes = new Uint8Array(await data.arrayBuffer());
    const mediaType = data.type?.trim() || mediaTypeFromPath(path);
    images.push({ data: bytes, mediaType });
  }
  return images;
}
