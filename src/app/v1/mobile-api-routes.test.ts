import { existsSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
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
const SWIFT_CLIENT_ROOT = resolve("ios/SnapList");

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

/**
 * Production Swift source is the source for mobile-client route coverage, not
 * its XCTest assertions. Literal `"/v1/..."` calls are collected from every
 * shipped source file; interpolated path segments normalize to App Router
 * parameters. Account erasure is the one explicit public-native transport
 * exception while its Swift UI adapter is not yet present: see
 * `src/lib/account-erasure/http.ts`. It is intentionally kept here so its
 * unlisted but live route cannot disappear behind an OpenAPI omission.
 */
function swiftSourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    return statSync(path).isDirectory()
      ? swiftSourceFiles(path)
      : path.endsWith(".swift")
        ? [path]
        : [];
  });
}

function normalizeSwiftPath(path: string): string {
  return path.replace(/\\\(([^)]*)\)/g, (_, expression: string) => {
    const identifier = expression.match(/^[A-Za-z][A-Za-z0-9_]*/)?.[0] ?? "parameter";
    return `{${identifier.replace(/ID$/, "Id")}}`;
  });
}

function clientCalledPaths(): string[] {
  const literalPaths = swiftSourceFiles(SWIFT_CLIENT_ROOT).flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return [...source.matchAll(/"(\/v1\/[^"]*)"/g)].map((match) =>
      normalizeSwiftPath(match[1]),
    );
  });

  return [...new Set([...literalPaths, "/v1/account/erasure"])].sort();
}

/** Every path whose App Router route must exist. */
function routeGuardPaths(): string[] {
  return [
    ...servedOperations().map(({ path }) => path),
    ...clientCalledPaths(),
  ];
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

function missingRoutePaths(
  paths: readonly string[],
  resolveRouteFile: (path: string) => string = routeFileFor,
): string[] {
  return paths
    .filter((path) => !UNROUTED_BY_DESIGN.has(path))
    .filter((path) => !existsSync(resolveRouteFile(path)));
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
  it("serves every published contract or client-called v1 path", () => {
    const unreachable = missingRoutePaths(routeGuardPaths());

    expect([...new Set(unreachable)]).toEqual([]);
  });

  it("fails when a client-only path has no App Router route file", () => {
    const clientOnlyPaths = clientCalledPaths().filter(
      (path) => !servedOperations().some((operation) => operation.path === path),
    );
    expect(clientOnlyPaths).toEqual([
      "/v1/account/erasure",
      "/v1/included-offer/redemptions",
      "/v1/included-offer/redemptions/{claimId}",
      "/v1/included-offer/redemptions/{claimId}/device-token",
    ]);

    // This client-only route is deliberately absent from the OpenAPI route
    // table. Hide its real route file briefly so this exercises the guard's
    // production population and real filesystem check, not a fake resolver.
    const clientOnlyPath = "/v1/included-offer/redemptions";
    const routeFile = routeFileFor(clientOnlyPath);
    const hiddenRouteFile = `${routeFile}.mobile-api-routes-test-hidden`;

    renameSync(routeFile, hiddenRouteFile);
    try {
      expect(missingRoutePaths(routeGuardPaths())).toEqual([clientOnlyPath]);
    } finally {
      renameSync(hiddenRouteFile, routeFile);
    }
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
