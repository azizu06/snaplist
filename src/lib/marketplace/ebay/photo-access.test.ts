import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  issueEbayPhotoUrls,
  resolveEbayPhotoBaseUrl,
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
});
