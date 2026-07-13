import { describe, expect, it } from "vitest";
import {
  DEMO_PRODUCTS_BY_SLUG,
  DEMO_SURFACE_ASSIGNMENTS,
} from "./demo-products";

const HOUSEHOLD_DEFINING_SLUGS = new Set([
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

describe("reseller-facing demo curation", () => {
  it("keeps the landing carousel to 8-10 comp-dense reseller examples", () => {
    const slugs = DEMO_SURFACE_ASSIGNMENTS["landing-carousel"];

    expect(slugs).toHaveLength(10);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs.every((slug) => DEMO_PRODUCTS_BY_SLUG[slug])).toBe(true);
    expect(slugs.some((slug) => HOUSEHOLD_DEFINING_SLUGS.has(slug))).toBe(false);

    const categories = slugs.map(
      (slug) => DEMO_PRODUCTS_BY_SLUG[slug].category.toLowerCase(),
    );
    expect(categories.some((category) => /electronic|computer|camera/.test(category))).toBe(true);
    expect(categories.some((category) => /game|music|book/.test(category))).toBe(true);
    expect(categories.some((category) => /clothing|shoe|watch/.test(category))).toBe(true);
    expect(categories.some((category) => /home|kitchen/.test(category))).toBe(true);
  });

  it("keeps the hero scan and three-move story out of bulky household inventory", () => {
    const definingSlugs = [
      ...DEMO_SURFACE_ASSIGNMENTS["landing-hero-scan"],
      ...DEMO_SURFACE_ASSIGNMENTS["landing-three-moves"],
    ];

    expect(definingSlugs.some((slug) => HOUSEHOLD_DEFINING_SLUGS.has(slug))).toBe(false);
  });
});
