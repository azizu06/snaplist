import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { safeNext } from "./(auth)/login/safe-next";

/**
 * Next resolves two namespaces by convention: the module graph and the route
 * graph. `href="/dashboard"` is an edge into a route file with no import
 * statement anywhere, so deleting that file leaves the string behind and every
 * import-graph check — typecheck, lint, `next build`, the unit suite — stays
 * green over a dead link. Retiring `src/app/(app)` (#598) did exactly that: six
 * live strings survived their routes.
 *
 * This suite asserts across that seam. It enumerates the routes `src/app`
 * actually emits, then requires every navigation target in surviving source to
 * land on one.
 *
 * What it CANNOT catch, stated plainly so nobody reads a pass as more coverage
 * than it is:
 *   - Dynamically constructed paths. An interpolated template literal
 *     (`` `/listings/${id}` ``) is skipped: the interpolation may itself contain
 *     slashes, so the static prefix does not determine the resolved path.
 *   - Paths nested inside a query parameter. `/login?next=/settings` is checked
 *     as `/login`; the `next` value is a second path this guard does not follow.
 *   - Navigation through a variable, a prop, or a value read at runtime.
 *   - Whether a route that exists returns a useful response.
 * Only literal, statically written targets are covered — which is the shape of
 * the defect that shipped.
 */

const SRC = resolve("src");
const APP = join(SRC, "app");

/** Segments App Router never emits into a URL. */
function isNonEmittingSegment(name: string): boolean {
  // (group) organises files without a URL segment; _private and @slot are opted
  // out of routing entirely.
  return /^\(.*\)$/.test(name) || name.startsWith("_") || name.startsWith("@");
}

function isRouteFile(name: string): boolean {
  return /^(page|route)\.(ts|tsx|js|jsx)$/.test(name);
}

/**
 * Every URL path `src/app` emits, as a matcher. A literal segment matches
 * itself; `[id]` matches one segment; `[...slug]`/`[[...slug]]` match the rest.
 */
function emittedRoutes(dir = APP, segments: string[] = []): RegExp[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const routes: RegExp[] = [];

  if (entries.some((entry) => entry.isFile() && isRouteFile(entry.name))) {
    routes.push(toMatcher(segments));
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    routes.push(
      ...emittedRoutes(
        join(dir, entry.name),
        isNonEmittingSegment(entry.name) ? segments : [...segments, entry.name],
      ),
    );
  }

  return routes;
}

function toMatcher(segments: string[]): RegExp {
  const pattern = segments
    .map((segment) => {
      if (/^\[\[\.\.\..+\]\]$/.test(segment)) return "(?:/[^/]+)*"; // optional catch-all
      if (/^\[\.\.\..+\]$/.test(segment)) return "(?:/[^/]+)+"; // catch-all
      if (/^\[.+\]$/.test(segment)) return "/[^/]+"; // one dynamic segment
      return `/${escapeRegExp(segment)}`;
    })
    .join("");
  return new RegExp(`^${pattern || "/"}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ROUTES = emittedRoutes();

function resolves(path: string): boolean {
  // A fragment or query string is not part of route resolution.
  const pathname = path.split(/[?#]/)[0];
  if (pathname === "") return true; // a bare "#anchor" or "?q=1" stays on the page
  return ROUTES.some((route) => route.test(pathname));
}

/**
 * Navigation positions: a JSX attribute or object property named `href`, and the
 * argument of `redirect(…)` / `push(…)` / `replace(…)` — including
 * `NextResponse.redirect(new URL("/x", request.url))`. A JSX expression
 * container is captured whole so a ternary yields both of its branches.
 */
const HREF = /\bhref\s*[=:]\s*(\{[^{}]*\}|"[^"]*"|`[^`]*`)/g;
const NAVIGATE = /\b(?:redirect|push|replace)\s*\(\s*(?:new\s+URL\s*\(\s*)?("[^"]*"|`[^`]*`)/g;
/** A path literal, skipping interpolated template literals (see limitations). */
const PATH_LITERAL = /"(\/[^"]*)"|`(\/[^`]*)`/g;

interface NavigationTarget {
  file: string;
  line: number;
  path: string;
}

function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (!/\.(ts|tsx)$/.test(entry.name)) return [];
    if (/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) return [];
    return [full];
  });
}

function navigationTargets(): NavigationTarget[] {
  const targets: NavigationTarget[] = [];

  for (const file of sourceFiles()) {
    const source = readFileSync(file, "utf8");
    for (const position of [HREF, NAVIGATE]) {
      position.lastIndex = 0;
      for (const match of source.matchAll(position)) {
        const expression = match[1];
        for (const literal of expression.matchAll(PATH_LITERAL)) {
          const path = literal[1] ?? literal[2];
          // `${` means the resolved path is decided at runtime.
          if (path.includes("${")) continue;
          targets.push({
            file: relative(process.cwd(), file),
            line: source.slice(0, match.index).split("\n").length,
            path,
          });
        }
      }
    }
  }

  return targets;
}

/**
 * Targets that point at no emitted route on purpose. Each entry states why and
 * who owns it. An entry is not permission to forget: "stays honest" below fails
 * the moment a listed path becomes routable, which forces the entry to be
 * deleted rather than silently outliving its reason.
 */
const UNROUTED_BY_DESIGN = new Map<string, string>([]);

describe("route integrity", () => {
  it("emits the routes the marketing and auth surfaces link to", () => {
    // Guards the guard: an empty or wrong route set would make every assertion
    // below vacuous, or fail everything for the wrong reason.
    expect(resolves("/")).toBe(true);
    expect(resolves("/login")).toBe(true);
    expect(resolves("/v1/runs/some-run-id")).toBe(true);
    expect(resolves("/dashboard")).toBe(false);
  });

  it("points every literal navigation target at an emitted route", () => {
    const dead = navigationTargets()
      .filter((target) => !UNROUTED_BY_DESIGN.has(target.path))
      .filter((target) => !resolves(target.path))
      .map((target) => `${target.file}:${target.line} -> ${target.path}`);

    expect(dead).toEqual([]);
  });

  it("falls back to an emitted route when a next target is unusable", () => {
    // safe-next.ts holds its fallback in a plain constant, which no string scan
    // can recognise as a navigation target. Asserting through the function
    // covers it at the seam that actually decides where a seller lands.
    expect(resolves(safeNext(undefined))).toBe(true);
    expect(resolves(safeNext("https://attacker.example"))).toBe(true);
  });

  it("stays honest about what it excuses", () => {
    const targets = navigationTargets();

    for (const [path, reason] of UNROUTED_BY_DESIGN) {
      expect(
        targets.some((target) => target.path === path),
        `${path} is excused but nothing navigates there any more — delete the entry`,
      ).toBe(true);
      expect(
        resolves(path),
        `${path} now resolves — delete the entry. Recorded reason: ${reason}`,
      ).toBe(false);
    }
  });
});
