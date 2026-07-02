import { describe, expect, it } from "vitest";
import {
  assembleDashboardRows,
  latestPricePerItem,
  type DashboardItemSource,
  type DashboardListingSource,
} from "./rows";

/**
 * Pure-assembly tests for the dashboard intake rows — the "one row per Item,
 * newest eBay listing wins, unlisted → Processing" invariant that previously
 * lived inline in `dashboard/page.tsx` (the post-#52 outage code) with no test
 * surface. Inputs mirror the page's RLS-scoped queries: newest-first ordering.
 */

function listing(over: Partial<DashboardListingSource> = {}): DashboardListingSource {
  return {
    id: "l1",
    item_id: "i1",
    title: "Sony WH-1000XM4 Wireless Noise Cancelling Headphones — Black, Tested",
    status: "draft",
    created_at: "2026-06-02T00:00:00Z",
    listed_price: null,
    ...over,
  };
}

function item(over: Partial<DashboardItemSource> = {}): DashboardItemSource {
  return {
    id: "i1",
    attributes: { brand: "Sony", model: "WH-1000XM4", category: "electronics", condition: "good" },
    photos: ["u1/i1/a.jpg"],
    price_override: null,
    created_at: "2026-06-01T00:00:00Z",
    ...over,
  };
}

const noThumbs = () => null;

describe("latestPricePerItem", () => {
  it("takes the FIRST (newest-first input) priced log per item, skipping null prices", () => {
    const map = latestPricePerItem([
      { item_id: "i1", price: null },
      { item_id: "i1", price: 120 },
      { item_id: "i1", price: 90 },
      { item_id: "i2", price: "45.5" },
    ]);
    expect(map.get("i1")).toBe(120);
    expect(map.get("i2")).toBe(45.5);
  });
});

describe("assembleDashboardRows", () => {
  it("emits ONE row per item with the NEWEST eBay listing winning", () => {
    const rows = assembleDashboardRows({
      listings: [
        listing({ id: "l-new", created_at: "2026-06-03T00:00:00Z", status: "published" }),
        listing({ id: "l-old", created_at: "2026-06-02T00:00:00Z", status: "draft" }),
      ],
      items: [item()],
      latestPrice: new Map(),
      thumbUrlFor: noThumbs,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].listingId).toBe("l-new");
    expect(rows[0].status).toBe("published");
  });

  it("keeps unlisted items visible as Processing (status new, no listingId)", () => {
    const rows = assembleDashboardRows({
      listings: [],
      items: [item({ id: "i9" })],
      latestPrice: new Map(),
      thumbUrlFor: noThumbs,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ itemId: "i9", listingId: null, status: "new" });
  });

  it("prefers the short item label over the listing's SEO title, falling back when unlabeled", () => {
    const rows = assembleDashboardRows({
      listings: [
        listing(),
        listing({ id: "l2", item_id: "ghost", title: "Fallback SEO Title" }),
      ],
      items: [item()],
      latestPrice: new Map(),
      thumbUrlFor: noThumbs,
    });
    const labeled = rows.find((r) => r.itemId === "i1");
    const ghost = rows.find((r) => r.itemId === "ghost");
    expect(labeled?.title).toBe("Sony WH-1000XM4");
    expect(ghost?.title).toBe("Fallback SEO Title");
  });

  it("prices a row: seller override beats the latest suggested; suggested otherwise; bare override without a log", () => {
    const rows = assembleDashboardRows({
      listings: [],
      items: [
        item({ id: "over", price_override: 99 }),
        item({ id: "sugg" }),
        item({ id: "bare", price_override: 55 }),
      ],
      latestPrice: new Map([
        ["over", 120],
        ["sugg", 80],
      ]),
      thumbUrlFor: noThumbs,
    });
    const byId = new Map(rows.map((r) => [r.itemId, r]));
    expect(byId.get("over")?.price).toBe(99);
    expect(byId.get("sugg")?.price).toBe(80);
    expect(byId.get("bare")?.price).toBe(55);
  });

  it("a PUBLISHED row shows listed_price (the live price), not a newer suggest-only log", () => {
    const rows = assembleDashboardRows({
      listings: [listing({ status: "published", listed_price: 100 })],
      items: [item()],
      // A suggest-only reprice sweep logged a fresh 70 that was never applied.
      latestPrice: new Map([["i1", 70]]),
      thumbUrlFor: noThumbs,
    });
    expect(rows[0].price).toBe(100);
  });

  it("a PUBLISHED row still lets a seller override beat listed_price", () => {
    const rows = assembleDashboardRows({
      listings: [listing({ status: "published", listed_price: 100 })],
      items: [item({ price_override: 88 })],
      latestPrice: new Map([["i1", 70]]),
      thumbUrlFor: noThumbs,
    });
    expect(rows[0].price).toBe(88);
  });

  it("a PUBLISHED row with null listed_price (pre-backfill) falls back to the latest log", () => {
    const rows = assembleDashboardRows({
      listings: [listing({ status: "published", listed_price: null })],
      items: [item()],
      latestPrice: new Map([["i1", 70]]),
      thumbUrlFor: noThumbs,
    });
    expect(rows[0].price).toBe(70);
  });

  it("a DRAFT row keeps the latest logged estimate even when listed_price is set", () => {
    const rows = assembleDashboardRows({
      listings: [listing({ status: "draft", listed_price: 100 })],
      items: [item()],
      latestPrice: new Map([["i1", 70]]),
      thumbUrlFor: noThumbs,
    });
    expect(rows[0].price).toBe(70);
  });

  it("sorts listed + unlisted rows together, newest first", () => {
    const rows = assembleDashboardRows({
      listings: [listing({ item_id: "i1", created_at: "2026-06-02T00:00:00Z" })],
      items: [
        item({ id: "i1", created_at: "2026-06-01T00:00:00Z" }),
        item({ id: "i2", created_at: "2026-06-05T00:00:00Z" }),
      ],
      latestPrice: new Map(),
      thumbUrlFor: noThumbs,
    });
    expect(rows.map((r) => r.itemId)).toEqual(["i2", "i1"]);
  });

  it("sentence-cases category/condition and resolves thumbs via the injected signer", () => {
    const rows = assembleDashboardRows({
      listings: [listing()],
      items: [item()],
      latestPrice: new Map(),
      thumbUrlFor: (itemId) => (itemId === "i1" ? "https://signed/a.jpg" : null),
    });
    expect(rows[0]).toMatchObject({
      category: "Electronics",
      condition: "Good",
      thumbUrl: "https://signed/a.jpg",
    });
  });
});
