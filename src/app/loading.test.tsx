import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Retiring the `(app)` dashboard route group (#598) left this root
 * `loading.tsx` — the only Suspense fallback in `src/app`, so it also covers
 * `(auth)/login` and `(auth)/signup` (both async server components) and every
 * `(marketing)` page — as the sole surviving dashboard-shaped skeleton. See
 * retired-web-dashboard-copy.test.ts for the sibling case (error/not-found
 * copy) this same retirement left behind.
 */
const source = readFileSync(resolve("src/app/loading.tsx"), "utf8");

describe("root loading fallback matches the marketing+auth web surface", () => {
  it("doesn't render SkeletonCard's list-item shape, which implies dashboard content that no longer exists here", () => {
    expect(source).not.toMatch(/SkeletonCard/);
  });

  it("doesn't describe itself as a dashboard loading state", () => {
    expect(source).not.toMatch(/dashboard loading state/i);
  });
});
