import { describe, expect, it } from "vitest";
import { collectJudgedListings, requireDbCredentials } from "./run";

describe("requireDbCredentials (--db credential gate)", () => {
  it("rejects anon-key-only environments: RLS would silently return zero rows", () => {
    expect(() =>
      requireDbCredentials({
        SUPABASE_URL: "http://localhost:54321",
        SUPABASE_ANON_KEY: "anon",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
      }),
    ).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("rejects a missing url and accepts url + service-role key", () => {
    expect(() =>
      requireDbCredentials({ SUPABASE_SERVICE_ROLE_KEY: "svc" }),
    ).toThrow(/SUPABASE_URL/);
    expect(
      requireDbCredentials({
        SUPABASE_URL: "http://localhost:54321",
        SUPABASE_SERVICE_ROLE_KEY: "svc",
      }),
    ).toEqual({ url: "http://localhost:54321", key: "svc" });
  });
});

describe("collectJudgedListings (newest-eBay-listing association)", () => {
  const row = (itemId: string, title: string) => ({
    item_id: itemId,
    title,
    description: `${title} description`,
    copy: {},
  });

  it("keeps the LAST (newest, given ascending input) listing per item", () => {
    const map = collectJudgedListings([
      row("item-1", "Old eBay listing"),
      row("item-2", "Other item"),
      row("item-1", "Newest eBay listing"),
    ]);
    expect(map.get("item-1")!.title).toBe("Newest eBay listing");
    expect(map.get("item-2")!.title).toBe("Other item");
  });

  it("skips rows with no usable title instead of clobbering a valid one", () => {
    const map = collectJudgedListings([
      row("item-1", "Valid title"),
      { item_id: "item-1", title: "", description: "x", copy: {} },
    ]);
    expect(map.get("item-1")!.title).toBe("Valid title");
  });
});

describe("ensureGoldMatchedRows (--db zero-match guard)", () => {
  it("throws on zero gold-matched rows instead of reporting over nothing", async () => {
    const { ensureGoldMatchedRows } = await import("./run");
    expect(() => ensureGoldMatchedRows(0)).toThrow(/0 prediction logs matched/);
    expect(() => ensureGoldMatchedRows(3)).not.toThrow();
  });
});
