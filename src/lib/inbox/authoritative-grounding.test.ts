import { describe, expect, it } from "vitest";
import { buildAuthoritativeMessageGrounding } from "./authoritative-grounding";

const listingId = "22222222-2222-4222-8222-222222222222";
const itemId = "11111111-1111-4111-8111-111111111111";

describe("buildAuthoritativeMessageGrounding", () => {
  it("uses only active-listing facts, current listed price, and seller-confirmed measurements", () => {
    const result = buildAuthoritativeMessageGrounding({
      now: new Date("2026-07-14T12:05:00.000Z"),
      marketplace: {
        externalListingId: "ebay-listing-1",
        active: true,
        price: 180,
        currency: "USD",
        condition: "Used - Excellent",
        itemSpecifics: {
          Brand: "Sony",
          Includes: "USB-C charging cable and carrying case",
          "pit to pit": "21 in",
        },
        observedAt: "2026-07-14T12:05:00.000Z",
      },
      listing: {
        id: listingId,
        item_id: itemId,
        status: "published",
        ebay_status: "published",
        ebay_listing_id: "ebay-listing-1",
        copy: {
          itemSpecifics: {
            Brand: "Sony",
            Includes: "USB-C charging cable and carrying case",
          },
        },
        listed_price: 180,
        last_priced_at: "2026-07-14T12:00:00.000Z",
        updated_at: "2026-07-14T12:00:00.000Z",
      },
      item: {
        id: itemId,
        condition: "Used - Excellent",
        attributes: {
          // Raw vision-only guesses must not become automatic authorization.
          specs: ["Bluetooth 6", "48-hour battery"],
          measurements: [
            {
              name: "pit_to_pit",
              value_in: 21,
              tolerance_in: 0.5,
              method: "seller-entered",
              confirmed: true,
            },
            {
              name: "length",
              value_in: 28,
              tolerance_in: 1,
              method: "prior-based",
              confirmed: false,
            },
          ],
        },
        updated_at: "2026-07-14T12:00:00.000Z",
      },
    });

    expect(result).toMatchObject({
      listingId,
      active: true,
      current: true,
      conflicts: [],
    });
    expect(result.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "Brand", value: "Sony" }),
        expect.objectContaining({ key: "Includes", value: expect.stringContaining("carrying case") }),
        expect.objectContaining({ key: "Condition", value: "Used - Excellent" }),
        expect.objectContaining({
          key: "pit to pit",
          value: "21 in",
          source: "seller_confirmed_measurement",
        }),
        expect.objectContaining({
          key: "asking price",
          value: "180.00",
          source: "current_asking_price",
        }),
        expect.objectContaining({ source: "active_listing_state" }),
      ]),
    );
    expect(JSON.stringify(result)).not.toMatch(/Bluetooth 6|48-hour|length|28/);
  });

  it("marks case-insensitive contradictory approved facts as conflicting", () => {
    const result = buildAuthoritativeMessageGrounding({
      now: new Date("2026-07-14T12:05:00.000Z"),
      marketplace: {
        externalListingId: "ebay-listing-1",
        active: true,
        price: 100,
        currency: "USD",
        condition: "Fair",
        itemSpecifics: { Condition: "Fair" },
        observedAt: "2026-07-14T12:05:00.000Z",
      },
      listing: {
        id: listingId,
        item_id: itemId,
        status: "published",
        ebay_status: "published",
        ebay_listing_id: "ebay-listing-1",
        copy: { itemSpecifics: { Condition: "Good", condition: "Fair" } },
        listed_price: 100,
        last_priced_at: "2026-07-14T12:00:00.000Z",
        updated_at: "2026-07-14T12:00:00.000Z",
      },
      item: {
        id: itemId,
        condition: "Good",
        attributes: {},
        updated_at: "2026-07-14T12:00:00.000Z",
      },
    });

    expect(result.conflicts).toContain("condition");
  });

  it("marks inactive or unversioned listing state as non-current", () => {
    const result = buildAuthoritativeMessageGrounding({
      now: new Date("2026-07-14T12:05:00.000Z"),
      marketplace: null,
      listing: {
        id: listingId,
        item_id: itemId,
        status: "published",
        ebay_status: "failed",
        ebay_listing_id: null,
        copy: { itemSpecifics: { Brand: "Sony" } },
        listed_price: null,
        last_priced_at: null,
        updated_at: "2026-07-14T12:00:00.000Z",
      },
      item: {
        id: itemId,
        condition: null,
        attributes: {},
        updated_at: "2026-07-14T12:00:00.000Z",
      },
    });

    expect(result).toMatchObject({ active: false, current: false });
  });

  it.each([
    ["the listing ended outside SnapList", { active: false }],
    ["the asking price changed outside SnapList", { price: 199 }],
  ])("refuses automatic grounding when %s", (_description, override) => {
    const result = buildAuthoritativeMessageGrounding({
      now: new Date("2026-07-14T12:05:00.000Z"),
      listing: {
        id: listingId,
        item_id: itemId,
        status: "published",
        ebay_status: "published",
        ebay_listing_id: "ebay-listing-1",
        copy: { itemSpecifics: { Brand: "Sony" } },
        listed_price: 180,
        last_priced_at: "2026-07-14T12:00:00.000Z",
        updated_at: "2026-07-14T12:00:00.000Z",
      },
      item: {
        id: itemId,
        condition: null,
        attributes: {},
        updated_at: "2026-07-14T12:00:00.000Z",
      },
      marketplace: {
        externalListingId: "ebay-listing-1",
        active: true,
        price: 180,
        currency: "USD",
        condition: null,
        itemSpecifics: { Brand: "Sony" },
        observedAt: "2026-07-14T12:05:00.000Z",
        ...override,
      },
    });

    expect(result.current).toBe(false);
  });
});
