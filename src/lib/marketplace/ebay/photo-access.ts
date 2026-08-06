import { createHash } from "node:crypto";

const DEFAULT_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
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
  const { data, error } = await client.rpc("issue_ebay_photo_access_tokens", {
    p_item_id: itemId,
    p_ttl_seconds: options.ttlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS,
  });
  if (error) {
    throw new Error(`Failed to resolve photos for eBay: ${error.message}`);
  }

  const rows = Array.isArray(data) ? data as PhotoTokenRow[] : [];
  const baseUrl = new URL(options.baseUrl);
  if (
    !["http:", "https:"].includes(baseUrl.protocol)
    || baseUrl.username
    || baseUrl.password
    || baseUrl.pathname !== "/"
    || baseUrl.search
    || baseUrl.hash
  ) {
    throw new Error("Failed to resolve photos for eBay: invalid public media origin.");
  }
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

export function resolveEbayPhotoBaseUrl(
  env: Record<string, string | undefined>,
): string {
  const configured = env.CLERK_AUTHORIZED_PARTIES
    ?.split(",")
    .map((party) => party.trim())
    .find(Boolean);
  if (configured) return new URL(configured).origin;
  if (env.NODE_ENV === "production") {
    throw new Error(
      "Failed to resolve photos for eBay: no public SnapList origin is configured.",
    );
  }
  return "http://localhost:3000";
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
