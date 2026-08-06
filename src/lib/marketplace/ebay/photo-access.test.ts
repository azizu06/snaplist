import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  issueEbayPhotoUrls,
  resolveEbayPhotoBaseUrl,
  serveEbayPhoto,
} from "./photo-access";

describe("issueEbayPhotoUrls", () => {
  it("returns five short opaque URLs in photo order", async () => {
    const tokens = Array.from(
      { length: 5 },
      (_, index) => `${String(index).repeat(42)}x`,
    );
    const rpc = vi.fn().mockResolvedValue({
      data: tokens.map((token, photoOrdinal) => ({
        photo_ordinal: photoOrdinal,
        token,
      })),
      error: null,
    });

    const urls = await issueEbayPhotoUrls(
      { rpc },
      "11111111-1111-4111-8111-111111111111",
      { baseUrl: "https://snaplist.dev" },
    );

    expect(urls).toEqual(tokens.map((token) => `https://snaplist.dev/m/${token}`));
    expect(urls).toHaveLength(5);
    expect(urls.every((url) => url.length <= 200)).toBe(true);
    expect(urls.reduce((length, url) => length + url.length, 0)).toBeLessThan(3975);
  });

  it("issues a capability that outlives the publish call, not the week", async () => {
    // eBay copies pictures to its own CDN during publish, so the bearer token
    // only has to survive that call and its bounded retries. A week-long
    // capability is a week-long unauthenticated read of a private object.
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });

    await issueEbayPhotoUrls({ rpc }, "11111111-1111-4111-8111-111111111111", {
      baseUrl: "https://snaplist.dev",
    });

    expect(rpc).toHaveBeenCalledWith("issue_ebay_photo_access_tokens", {
      p_item_id: "11111111-1111-4111-8111-111111111111",
      p_ttl_seconds: 3600,
    });
  });

  it("uses 256 cryptographically random bits and stores only the token digest", () => {
    const migration = readFileSync(
      "supabase/migrations/20260806120000_ebay_photo_access_tokens.sql",
      "utf8",
    );
    const table = migration.match(
      /create table public\.ebay_photo_access_tokens \(([\s\S]*?)\n\);/,
    )?.[1];

    expect(table).toContain("token_digest bytea primary key");
    expect(table).not.toMatch(/\btoken\s+text\b/);
    expect(migration).toContain("extensions.gen_random_bytes(32)");
    expect(migration).toContain(
      "extensions.digest(convert_to(v_token, 'UTF8'), 'sha256')",
    );
  });

  it("uses the first configured SnapList origin and fails closed in unconfigured production", () => {
    expect(resolveEbayPhotoBaseUrl({
      CLERK_AUTHORIZED_PARTIES:
        "https://snaplist.dev,https://preview.snaplist.dev",
    })).toBe("https://snaplist.dev");
    expect(() => resolveEbayPhotoBaseUrl({ NODE_ENV: "production" })).toThrow(
      /no public SnapList origin/i,
    );
  });

  it("prefers the dedicated origin over the Clerk authentication list", () => {
    expect(resolveEbayPhotoBaseUrl({
      SNAPLIST_PUBLIC_ORIGIN: "https://snaplist.dev",
      // Reordering this list is a routine Clerk change. It must not decide where
      // eBay fetches a published listing's pictures from.
      CLERK_AUTHORIZED_PARTIES:
        "https://preview.snaplist.dev,https://snaplist.dev",
    })).toBe("https://snaplist.dev");
  });

  it.each([
    ["a relative value", "/m"],
    ["a non-HTTP scheme", "ftp://snaplist.dev"],
    ["plaintext HTTP on a routable host", "http://snaplist.dev"],
    // Startup validation already rejects these for SNAPLIST_PUBLIC_ORIGIN. A
    // second, weaker opinion here is how a value that never reaches eBay's
    // fetcher still reaches a published listing.
    ["an HTTPS loopback host", "https://localhost"],
    ["an HTTPS private-network address", "https://10.0.0.5"],
    ["an HTTPS origin carrying a path", "https://snaplist.dev/media"],
  ])("refuses %s that eBay could not fetch", (_name, origin) => {
    expect(() => resolveEbayPhotoBaseUrl({
      SNAPLIST_PUBLIC_ORIGIN: origin,
      NODE_ENV: "production",
    })).toThrow(/no public SnapList origin/i);
  });

  it("still allows a loopback origin outside production", () => {
    expect(resolveEbayPhotoBaseUrl({
      SNAPLIST_PUBLIC_ORIGIN: "http://localhost:3000",
    })).toBe("http://localhost:3000");
  });

  it("fails closed on a deployed platform even when NODE_ENV is unset", () => {
    // A Render or Docker deploy can start with NODE_ENV unset. Publishing
    // http://localhost:3000 picture URLs to a real eBay listing is worse than
    // refusing, so the guard uses the platform markers, not NODE_ENV alone.
    expect(() => resolveEbayPhotoBaseUrl({ VERCEL: "1" })).toThrow(
      /no public SnapList origin/i,
    );
    expect(() => resolveEbayPhotoBaseUrl({ RENDER: "true" })).toThrow(
      /no public SnapList origin/i,
    );
  });
});

describe("serveEbayPhoto", () => {
  it("surfaces a verified object's Storage failure instead of misreporting it as missing", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{
        storage_bucket: "photos",
        storage_path: "user-1/items/photo.png",
        media_type: "image/png",
      }],
      error: null,
    });
    const download = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "Storage is temporarily unavailable" },
    });

    await expect(serveEbayPhoto(
      { rpc, storage: { from: () => ({ download }) } },
      "A".repeat(43),
    )).rejects.toThrow(/temporarily unavailable/i);
  });

  it.each([
    ["a traversal segment", "user-1/../user-2/photo.png"],
    ["a leading traversal segment", "../user-2/photo.png"],
    ["a control character", "user-1/items/photo\u0001.png"],
    ["a newline", "user-1/items/photo\n.png"],
  ])(
    "refuses a resolved path containing %s without downloading it",
    async (_name, storagePath) => {
      // Defence in depth: the route never builds this path, but if a row ever
      // carries one it must not become a Storage read. The response stays the
      // shared 404 so a prober cannot tell a rejected path from an unknown
      // token.
      const rpc = vi.fn().mockResolvedValue({
        data: [{
          storage_bucket: "photos",
          storage_path: storagePath,
          media_type: "image/png",
        }],
        error: null,
      });
      const download = vi.fn();

      const response = await serveEbayPhoto(
        { rpc, storage: { from: () => ({ download }) } },
        "A".repeat(43),
      );

      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not found.");
      expect(download).not.toHaveBeenCalled();
    },
  );

  it("still serves a path whose segment merely starts with dots", async () => {
    // `..` is a path SEGMENT, not a substring. Rejecting every name that
    // contains two dots would break real Storage objects.
    const rpc = vi.fn().mockResolvedValue({
      data: [{
        storage_bucket: "photos",
        storage_path: "user-1/items/..photo.png",
        media_type: "image/png",
      }],
      error: null,
    });
    const download = vi.fn().mockResolvedValue({
      data: new Blob([Uint8Array.from([137, 80, 78, 71])]),
      error: null,
    });

    const response = await serveEbayPhoto(
      { rpc, storage: { from: () => ({ download }) } },
      "A".repeat(43),
    );

    expect(response.status).toBe(200);
    expect(download).toHaveBeenCalledWith("user-1/items/..photo.png");
  });
});
