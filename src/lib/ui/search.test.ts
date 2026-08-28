import { describe, expect, it } from "vitest";
import { firstSearchToken, searchRows } from "./search";

/**
 * Contract tests for the listing search matcher (dashboard v2) powering the
 * ⌘K palette (via /api/search).
 */

const row = (title: string, createdAt: string, itemId = title) => ({
  itemId,
  title,
  createdAt,
});

const ROWS = [
  row("Sony WH-1000XM4 Wireless Headphones", "2026-06-11T15:00:00Z"),
  row("LEGO Star Wars Millennium Falcon", "2026-06-11T13:30:00Z"),
  row("Patagonia Better Sweater Fleece Jacket", "2026-06-10T19:12:00Z"),
  row("KitchenAid Artisan Stand Mixer", "2026-06-10T16:40:00Z"),
  row("Wireless charger for Sony phones", "2026-06-09T11:05:00Z"),
];

describe("searchRows (⌘K palette results)", () => {
  it("returns nothing for an empty query (palette shows quick actions instead)", () => {
    expect(searchRows(ROWS, "")).toEqual([]);
    expect(searchRows(ROWS, "  ")).toEqual([]);
  });

  it("applies the same AND semantics as the inline filter", () => {
    const hits = searchRows(ROWS, "sony wireless");
    expect(hits.map((r) => r.title)).toEqual([
      "Sony WH-1000XM4 Wireless Headphones",
      "Wireless charger for Sony phones",
    ]);
  });

  it("ranks title-prefix matches above mid-title matches", () => {
    // "Wireless charger…" STARTS with the query; the Sony row only contains
    // it mid-title — prefix wins even though the Sony row is newer.
    const hits = searchRows(ROWS, "wireless");
    expect(hits[0]!.title).toBe("Wireless charger for Sony phones");
    expect(hits[1]!.title).toBe("Sony WH-1000XM4 Wireless Headphones");
  });

  it("breaks rank ties by recency (newest first)", () => {
    // "oo" sits mid-word in all three titles — identical rank, so order
    // must come from createdAt alone.
    const tied = [
      row("Bamboo cutting board", "2026-06-08T10:00:00Z"),
      row("Wooden spoon set", "2026-06-10T10:00:00Z"),
      row("Igloo cooler 28qt", "2026-06-09T10:00:00Z"),
    ];
    expect(searchRows(tied, "oo").map((r) => r.createdAt)).toEqual([
      "2026-06-10T10:00:00Z",
      "2026-06-09T10:00:00Z",
      "2026-06-08T10:00:00Z",
    ]);
  });

  it("caps results at the limit", () => {
    expect(searchRows(ROWS, "a", 2)).toHaveLength(2);
  });
});

describe("firstSearchToken (the token pushed down to the DB filter)", () => {
  it("returns the first whitespace token, lowercased", () => {
    expect(firstSearchToken("Sony headphones")).toBe("sony");
    expect(firstSearchToken("  LEGO  ")).toBe("lego");
  });

  it("strips characters that would break PostgREST filter syntax or act as wildcards", () => {
    expect(firstSearchToken('so%n_y*("),')).toBe("sony");
    expect(firstSearchToken("100%wool")).toBe("100wool");
  });

  it("returns empty when nothing safe remains (caller skips the DB filter)", () => {
    expect(firstSearchToken("")).toBe("");
    expect(firstSearchToken("%*()")).toBe("");
  });

  it("strips periods, which delimit column.operator.value in the pushed-down .or() filter", () => {
    // A literal "." in the token collides with the column.operator.value
    // delimiter the route's `.or()` string uses (see route.ts) — left in,
    // it would corrupt the filter instead of matching the brand literally.
    expect(firstSearchToken("L.L.Bean jacket")).toBe("llbean");
    expect(firstSearchToken("...")).toBe("");
  });
});
