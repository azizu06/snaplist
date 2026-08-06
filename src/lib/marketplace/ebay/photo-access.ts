import { createHash } from "node:crypto";

import { isLocalDevelopment } from "@/lib/llm/registry";
import { isPublicHttpsOrigin } from "@/lib/public-origin";

// eBay copies a listing's pictures onto its own CDN while the publish call
// runs, so the bearer capability only has to outlive that call and its bounded
// retries. Anything longer is an unauthenticated read of a private object that
// nothing needs. The RPC still caps an explicit TTL at seven days.
const DEFAULT_TOKEN_TTL_SECONDS = 60 * 60;
// eBay's documented ceiling is 500 characters per `pictureUrl` — the limit
// Supabase signed URLs blew through, and the reason this route exists at all
// (see the migration header for issue #705). Both bounds below are SnapList's
// own, deliberately stricter, and are not eBay-published figures. A token URL
// is origin + "/m/" + 43 characters, so 200 leaves generous room for a long
// custom domain while still catching a value that has stopped being a token
// URL. The 3975 total is a defensive budget across a five-picture set: no
// per-URL check can catch an aggregate that has grown unreasonable, and
// failing here is cheaper than a rejected publish.
const EBAY_PICTURE_URL_LIMIT = 200;
const EBAY_PICTURE_URLS_TOTAL_LIMIT = 3975;
const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SAFE_MEDIA_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
]);

interface PhotoTokenRow {
  photo_ordinal: number;
  token: string;
}

interface PhotoTokenIssuer {
  rpc(
    name: string,
    parameters: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

interface PhotoAccessClient extends PhotoTokenIssuer {
  storage: {
    from(bucket: string): {
      download(path: string): PromiseLike<{
        data: Blob | null;
        error: { message: string } | null;
      }>;
    };
  };
}

interface ResolvedPhotoRow {
  storage_bucket: string;
  storage_path: string;
  media_type: string;
}

export async function issueEbayPhotoUrls(
  client: PhotoTokenIssuer,
  itemId: string,
  options: { baseUrl: string; ttlSeconds?: number },
): Promise<string[]> {
  // Validate the origin BEFORE the RPC. Minting tokens first means a bad
  // origin still leaves live bearer capabilities behind for their whole TTL,
  // and an unparseable value threw a bare TypeError from outside this module's
  // error vocabulary.
  const baseUrl = parsedPhotoOrigin(options.baseUrl);

  const { data, error } = await client.rpc("issue_ebay_photo_access_tokens", {
    p_item_id: itemId,
    p_ttl_seconds: options.ttlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS,
  });
  if (error) {
    throw new Error(`Failed to resolve photos for eBay: ${error.message}`);
  }

  const rows = Array.isArray(data) ? data as PhotoTokenRow[] : [];
  const urls = rows
    .sort((left, right) => left.photo_ordinal - right.photo_ordinal)
    .map(({ token }) => {
      if (!OPAQUE_TOKEN_PATTERN.test(token)) {
        throw new Error("Failed to resolve photos for eBay: invalid opaque token.");
      }
      return `${baseUrl.toString().replace(/\/$/, "")}/m/${token}`;
    });

  if (
    urls.some((url) => url.length > EBAY_PICTURE_URL_LIMIT)
    || urls.reduce((length, url) => length + url.length, 0)
      >= EBAY_PICTURE_URLS_TOTAL_LIMIT
  ) {
    throw new Error("Failed to resolve photos for eBay: picture URL limit exceeded.");
  }
  return urls;
}

function parsedPhotoOrigin(baseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("Failed to resolve photos for eBay: invalid public media origin.");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("Failed to resolve photos for eBay: invalid public media origin.");
  }
  return parsed;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The origin eBay fetches published pictures from. `SNAPLIST_PUBLIC_ORIGIN` is the
 * only variable that MEANS this. `CLERK_AUTHORIZED_PARTIES` is an authentication
 * setting whose order carries no meaning for Clerk, so reading its first entry made
 * an unrelated config edit able to redirect every published listing's pictures.
 *
 * That fallback is now unreachable in any deployed process: startup validation
 * requires `SNAPLIST_PUBLIC_ORIGIN` and refuses to boot without it. It survives
 * only for local development, where a Clerk list is often the sole origin a
 * machine has configured.
 */
export function resolveEbayPhotoBaseUrl(
  env: Record<string, string | undefined>,
): string {
  const configured = env.SNAPLIST_PUBLIC_ORIGIN?.trim()
    || env.CLERK_AUTHORIZED_PARTIES
      ?.split(",")
      .map((party) => party.trim())
      .find(Boolean);
  if (configured) return publicOrigin(configured);
  // Deployed detection must prove "local", not "production": a Render or
  // Docker deploy can start with NODE_ENV unset, and publishing localhost
  // picture URLs to a real eBay listing is worse than refusing (#501 shape).
  if (!isLocalDevelopment(env)) {
    throw new Error(
      "Failed to resolve photos for eBay: no public SnapList origin is configured.",
    );
  }
  return "http://localhost:3000";
}

/**
 * eBay fetches these URLs from the public internet, so a relative value, a
 * non-HTTP scheme, or plaintext HTTP on a routable host cannot serve a real
 * listing. Reject them here rather than publishing pictures eBay cannot load.
 *
 * The HTTPS branch defers to the SAME predicate startup validation uses. When
 * this function held its own weaker opinion, a value startup rejects —
 * `https://localhost`, `https://10.0.0.5` — still reached a published listing.
 * Loopback HTTP stays allowed because local development has no other origin.
 */
function publicOrigin(configured: string): string {
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error(
      "Failed to resolve photos for eBay: no public SnapList origin is configured.",
    );
  }
  const loopback = parsed.protocol === "http:"
    && LOOPBACK_HOSTS.has(parsed.hostname);
  if (!loopback && !isPublicHttpsOrigin(configured)) {
    throw new Error(
      "Failed to resolve photos for eBay: no public SnapList origin is configured.",
    );
  }
  return parsed.origin;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Defence in depth between the token row and Storage. The token binds one exact
 * object and nothing in the request reaches this path, but a stored value is
 * still input to a downstream path resolver: a `..` SEGMENT could walk outside
 * the tenant prefix and a control byte could split whatever consumes the path.
 * `..` is matched as a segment, not a substring, so a real object named
 * `..photo.png` still serves.
 */
function isServableStoragePath(path: string): boolean {
  return (
    !CONTROL_CHARACTERS.test(path)
    && !path.split("/").includes("..")
  );
}

const notFound = () => new Response("Not found.", {
  status: 404,
  headers: { "cache-control": "no-store" },
});

export async function serveEbayPhoto(
  client: PhotoAccessClient,
  token: string,
): Promise<Response> {
  if (!OPAQUE_TOKEN_PATTERN.test(token)) return notFound();

  const digest = createHash("sha256").update(token, "utf8").digest("hex");
  const resolved = await client.rpc("resolve_ebay_photo_access_token", {
    p_token_digest: digest,
  });
  if (resolved.error) {
    throw new Error(`Failed to resolve eBay photo token: ${resolved.error.message}`);
  }
  const row = Array.isArray(resolved.data)
    ? resolved.data[0] as ResolvedPhotoRow | undefined
    : undefined;
  if (
    !row
    || row.storage_bucket !== "photos"
    || !row.storage_path
    || !isServableStoragePath(row.storage_path)
    || !SAFE_MEDIA_TYPES.has(row.media_type)
  ) {
    return notFound();
  }

  const photo = await client.storage.from("photos").download(row.storage_path);
  if (photo.error) {
    throw new Error(`Failed to download eBay photo: ${photo.error.message}`);
  }
  if (!photo.data) {
    throw new Error("Failed to download eBay photo: Storage returned no data.");
  }
  return new Response(await photo.data.arrayBuffer(), {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": row.media_type,
      "x-content-type-options": "nosniff",
    },
  });
}
