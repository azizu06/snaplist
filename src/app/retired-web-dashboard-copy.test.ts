import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Retiring the `(app)` dashboard route group (#598) left the native SwiftUI
 * app as the only place a seller's items and listings live — the web surface
 * is marketing + auth only (see route-integrity.test.ts's own route list).
 * `error.tsx` and `not-found.tsx` predate that retirement: they used to
 * reassure a signed-in dashboard visitor that "your items and listings are
 * safe in your shop" and offered a "Go to your listings" link. That link
 * still resolves (to "/"), so route-integrity's link-target check passes —
 * but the promise itself is now false: there is no web listings/shop to
 * check, so this would mislead a visitor who lands here from a stale link.
 */
const APP = resolve("src/app");

function read(file: string): string {
  return readFileSync(resolve(APP, file), "utf8");
}

const RETIRED_DASHBOARD_LANGUAGE = /\blistings?\b|\bshop\b/i;

describe("error/not-found copy no longer promises a retired web dashboard", () => {
  it.each(["error.tsx", "not-found.tsx"])(
    "%s doesn't tell a visitor to check a web listings page or shop",
    (file) => {
      expect(read(file)).not.toMatch(RETIRED_DASHBOARD_LANGUAGE);
    },
  );
});
