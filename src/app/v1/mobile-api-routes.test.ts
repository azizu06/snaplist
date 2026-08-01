import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `src/lib/mobile-api/app.ts` is a self-contained web-standard router that
 * dispatches on `pathname`; Next's App Router dispatches on the filesystem.
 * A handler can therefore be fully covered by `app.test.ts` and still 404 in a
 * deployed build, because nothing asserts across that seam. This suite is that
 * assertion: every path the published contract claims to serve must have a
 * matching App Router route file, exporting the contract's own methods.
 */

const contract = JSON.parse(
  readFileSync(resolve("docs/contracts/mobile-api-v1.openapi.json"), "utf8"),
) as {
  paths: Record<string, Record<string, { "x-implementation-status"?: string }>>;
};

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

/**
 * `contract-only` operations publish a shape without claiming to serve it.
 * Everything else asserts a live endpoint, so it needs a route.
 */
const SERVED_STATUSES = new Set(["implemented", "proof"]);

/**
 * Paths the contract claims to serve that deliberately have no `src/app/v1`
 * route file. Each entry states why. An entry is not permission to forget: the
 * "stays honest" case below fails the moment a listed path gains a route, which
 * forces the entry to be deleted rather than silently outliving its reason.
 *
 * Scope note: `/internal/v1/pipeline/consume` needs no entry — it is not under
 * `/v1/`, so it never enters this guard's population.
 */
const UNROUTED_BY_DESIGN = new Map<string, string>([
  [
    "/v1/guest/claims",
    "The handler needs the #174 App Attest handoff verifier, which the contract "
      + "still marks contract-only, so there is no verifier to compose a route from.",
  ],
  [
    "/v1/webhooks/revenuecat",
    "Served by src/app/api/webhooks/revenuecat/route.ts. Moving the provider's "
      + "configured callback URL is a RevenueCat-side change, not an App Router one.",
  ],
]);

interface ContractOperation {
  path: string;
  method: string;
}

function servedOperations(): ContractOperation[] {
  return Object.entries(contract.paths)
    .filter(([path]) => path.startsWith("/v1/"))
    .flatMap(([path, pathItem]) =>
      Object.entries(pathItem)
        .filter(
          ([method, operation]) =>
            HTTP_METHODS.has(method)
            && SERVED_STATUSES.has(operation["x-implementation-status"] ?? ""),
        )
        .map(([method]) => ({ path, method: method.toUpperCase() })),
    );
}

/** `/v1/runs/{runId}/retry` -> `src/app/v1/runs/[runId]/retry/route.ts`. */
function routeFileFor(path: string): string {
  const segments = path
    .split("/")
    .filter(Boolean)
    .slice(1)
    .map((segment) =>
      segment.startsWith("{") && segment.endsWith("}")
        ? `[${segment.slice(1, -1)}]`
        : segment,
    );
  return resolve("src/app/v1", ...segments, "route.ts");
}

function exportedMethods(routeFile: string): string[] {
  const source = readFileSync(routeFile, "utf8");
  return [
    ...source.matchAll(
      /export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g,
    ),
  ].map((match) => match[1]);
}

describe("mobile API contract to App Router routing", () => {
  it("serves every contract path it claims to serve", () => {
    const unreachable = servedOperations()
      .filter(({ path }) => !UNROUTED_BY_DESIGN.has(path))
      .filter(({ path }) => !existsSync(routeFileFor(path)))
      .map(({ path, method }) => `${method} ${path}`);

    expect([...new Set(unreachable)]).toEqual([]);
  });

  it("exports each contract method on the route that serves it", () => {
    const mismatched = servedOperations()
      .filter(({ path }) => !UNROUTED_BY_DESIGN.has(path))
      .filter(({ path }) => existsSync(routeFileFor(path)))
      .filter(({ path, method }) => !exportedMethods(routeFileFor(path)).includes(method))
      .map(({ path, method }) => `${method} ${path}`);

    expect(mismatched).toEqual([]);
  });

  it("keeps the unrouted-by-design list honest", () => {
    const contractPaths = new Set(servedOperations().map(({ path }) => path));

    const stale = [...UNROUTED_BY_DESIGN.keys()].filter(
      (path) => !contractPaths.has(path) || existsSync(routeFileFor(path)),
    );

    expect(stale).toEqual([]);
  });
});
