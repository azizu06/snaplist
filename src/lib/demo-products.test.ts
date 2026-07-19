import { describe, expect, it } from "vitest";
import {
  DEMO_PRODUCTS,
  DEMO_PRODUCTS_BY_SLUG,
  DEMO_SURFACE_ASSIGNMENTS,
} from "./demo-products";

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

const DASHBOARD_FOLDER_SLUGS = [
  "kettlebell",
  "binoculars",
  "sewingmachine",
];

describe("runtime demo catalog reachability", () => {
  it("keeps only products reachable from a live application surface", () => {
    const catalogSlugs = new Set(DEMO_PRODUCTS.map((product) => product.slug));
    const assignedSlugs = new Set(Object.values(DEMO_SURFACE_ASSIGNMENTS).flat());

    expect(DEMO_PRODUCTS).toHaveLength(13);
    expect(assignedSlugs).toEqual(catalogSlugs);
    expect(Object.keys(DEMO_PRODUCTS_BY_SLUG).sort()).toEqual(
      [...catalogSlugs].sort(),
    );
  });

  it("keeps assignments limited to real runtime consumers", () => {
    expect(Object.keys(DEMO_SURFACE_ASSIGNMENTS).sort()).toEqual([
      "dashboard-folder",
      "landing-carousel",
      "landing-hero-scan",
      "landing-storefronts",
    ]);
    expect(DEMO_SURFACE_ASSIGNMENTS["dashboard-folder"]).toEqual(
      DASHBOARD_FOLDER_SLUGS,
    );
  });

  it("keeps the landing carousel to the ten comp-dense reseller examples", () => {
    const slugs = DEMO_SURFACE_ASSIGNMENTS["landing-carousel"];

    expect(slugs).toHaveLength(10);
    expect(new Set(slugs)).toEqual(SELECTED_RESELLER_SLUGS);
    expect(
      slugs.every((slug) =>
        DEMO_PRODUCTS_BY_SLUG[slug].image.startsWith("/demo/reseller/"),
      ),
    ).toBe(true);
  });
});
