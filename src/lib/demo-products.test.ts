import { describe, expect, it } from "vitest";
import {
  DEMO_PRODUCTS_BY_SLUG,
  DEMO_SURFACE_ASSIGNMENTS,
} from "./demo-products";

const RETIRED_PRIMARY_SLUGS = new Set([
  "acer-predator",
  "a-macbookair",
  "a-cyberpc",
  "a-xbox360",
  "console",
  "camera",
  "gameboy",
  "gshock",
  "sneakers",
  "book",
  "mixer",
  "espresso",
  "drill",
  "headphones",
  "jacket",
  "vinyl",
  "a-bedframe",
  "a-carseat",
  "a-crib",
  "a-diningchairs",
  "a-dresser",
  "a-fridge",
  "a-mattress",
  "a-patioset",
  "a-stroller",
  "a-wardrobe",
]);

const SELECTED_RESELLER_SLUGS = new Set([
  "reseller-ps5",
  "reseller-iphone-15",
  "reseller-sony-camera",
  "reseller-switch-2",
  "reseller-dualsense",
  "reseller-charizard",
  "reseller-air-jordan-pair",
  "reseller-keychron",
  "reseller-airpods-max",
  "reseller-galaxy-watch",
]);

const PRIMARY_SURFACES = [
  "landing-carousel",
  "landing-storefronts",
  "landing-three-moves",
  "landing-hero-scan",
  "step-snap",
  "step-identify",
  "step-price",
  "step-write",
  "step-publish",
  "buyer-qa",
  "inbox-qa",
  "hiw-waterfall",
  "how-it-works",
] as const;

describe("reseller-facing demo curation", () => {
  it("keeps the landing carousel to 8-10 comp-dense reseller examples", () => {
    const slugs = DEMO_SURFACE_ASSIGNMENTS["landing-carousel"];

    expect(slugs).toHaveLength(10);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(new Set(slugs)).toEqual(SELECTED_RESELLER_SLUGS);
    expect(slugs.every((slug) => DEMO_PRODUCTS_BY_SLUG[slug])).toBe(true);
    expect(
      slugs.every((slug) =>
        DEMO_PRODUCTS_BY_SLUG[slug].image.startsWith("/demo/reseller/"),
      ),
    ).toBe(true);
    expect(slugs.some((slug) => RETIRED_PRIMARY_SLUGS.has(slug))).toBe(false);

    const categories = slugs.map(
      (slug) => DEMO_PRODUCTS_BY_SLUG[slug].category.toLowerCase(),
    );
    expect(categories.some((category) => /electronic|computer|camera/.test(category))).toBe(true);
    expect(categories.some((category) => /game|music|book/.test(category))).toBe(true);
    expect(categories.some((category) => /clothing|shoe|watch/.test(category))).toBe(true);
    expect(categories.some((category) => /computer|game/.test(category))).toBe(true);
  });

  it("retires garage-sale and superseded first-pass assets from every primary assignment", () => {
    const definingSlugs = PRIMARY_SURFACES.flatMap(
      (surface) => DEMO_SURFACE_ASSIGNMENTS[surface],
    );

    expect(definingSlugs.some((slug) => RETIRED_PRIMARY_SLUGS.has(slug))).toBe(false);
  });

  it("uses one truthful PlayStation 5 story through all six guide steps", () => {
    const guideSlugs = [
      ...DEMO_SURFACE_ASSIGNMENTS["step-snap"],
      ...DEMO_SURFACE_ASSIGNMENTS["step-identify"],
      ...DEMO_SURFACE_ASSIGNMENTS["step-price"],
      ...DEMO_SURFACE_ASSIGNMENTS["step-write"],
      ...DEMO_SURFACE_ASSIGNMENTS["step-publish"],
      DEMO_SURFACE_ASSIGNMENTS["buyer-qa"][0],
    ];

    expect(new Set(guideSlugs)).toEqual(new Set(["reseller-ps5"]));
  });
});
