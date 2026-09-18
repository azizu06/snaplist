import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEMO_PRODUCTS,
  DEMO_PRODUCTS_BY_SLUG,
  DEMO_SURFACE_ASSIGNMENTS,
} from "./demo-products";

describe("demo product catalog integrity", () => {
  it("keeps every slug unique so indexed products cannot overwrite each other", () => {
    const slugs = DEMO_PRODUCTS.map((product) => product.slug);

    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("resolves every surface assignment to a catalog product", () => {
    for (const [surface, slugs] of Object.entries(DEMO_SURFACE_ASSIGNMENTS)) {
      for (const slug of slugs) {
        expect(DEMO_PRODUCTS_BY_SLUG[slug], `${surface}: ${slug}`).toBeDefined();
      }
    }
  });

  it("keeps every catalog image backed by a public asset", () => {
    for (const product of DEMO_PRODUCTS) {
      const imagePath = resolve(process.cwd(), "public", product.image.slice(1));

      expect(existsSync(imagePath), `${product.slug}: ${product.image}`).toBe(true);
    }
  });
});
