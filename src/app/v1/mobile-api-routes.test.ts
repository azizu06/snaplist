import { existsSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createGuestAttestationHandler,
  createGuestClaimHandoffService,
  InMemoryGuestClaimHandoffStore,
} from "@/lib/app-attest/guest-handoff";
import { createMobileApiHandler } from "@/lib/mobile-api";

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

const APP_ID = "TEAMID1234.dev.snaplist.ios";
const APP_ATTEST_KEY_ID = Buffer.alloc(32, 0x61).toString("base64");
const RECOVERY_ID = "11111111-1111-4111-8111-111111111111";
const RECOVERY_TOKEN = "recovery_v1_abcdefghijklmnopqrstuvwxyz0123456789";
const PHOTO_SET_FINGERPRINT = "b".repeat(64);
const GUEST_USER_ID = `guest_${createHash("sha256")
  .update(APP_ID)
  .update("\0")
  .update(APP_ATTEST_KEY_ID)
  .digest("hex")
  .slice(0, 48)}`;

function handoffClientData(photoSetFingerprint = PHOTO_SET_FINGERPRINT): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      purpose: "guest-claim-handoff",
      recoveryId: RECOVERY_ID,
      recoveryToken: RECOVERY_TOKEN,
      photoIdentity: {
        kind: "content_sha256_set_v1",
        fingerprint: photoSetFingerprint,
      },
    }),
  ).toString("base64");
}

function appAttestAssertion() {
  return {
    appId: APP_ID,
    bundleVersion: "1",
    counter: 1,
    environment: "production" as const,
    keyId: APP_ATTEST_KEY_ID,
    kind: "assertion" as const,
    requestHash: "c".repeat(43),
    status: "verified" as const,
    validationCategory: 2,
  };
}

function guestHandoffContractHarness(
  clock: () => Date = () => new Date("2026-08-02T16:00:00.000Z"),
) {
  const store = new InMemoryGuestClaimHandoffStore({
    attestedKeys: [{
      appId: APP_ID,
      environment: "production",
      keyId: APP_ATTEST_KEY_ID,
    }],
    recoveries: [{
      guestUserId: GUEST_USER_ID,
      photoSetFingerprint: PHOTO_SET_FINGERPRINT,
      recoveryId: RECOVERY_ID,
      recoveryTokenHash: createHash("sha256").update(RECOVERY_TOKEN).digest("hex"),
    }],
  });
  const handoffs = createGuestClaimHandoffService({
    appId: APP_ID,
    clock,
    environment: "production",
    handoffId: () => "22222222-2222-4222-8222-222222222222",
    randomBytes: () => Buffer.alloc(32, 0x62),
    signingKey: Buffer.alloc(32, 0x63),
    store,
    ttlMs: 5 * 60 * 1_000,
  });
  const verifyAssertion = vi.fn().mockResolvedValue(appAttestAssertion());
  const attestations = createGuestAttestationHandler({
    appAttest: {
      issueChallenge: vi.fn(),
      verifyAttestation: vi.fn(),
      verifyAssertion,
    },
    handoffs,
    requestId: () => "req_attestation",
  });
  return { attestations, handoffs, store, verifyAssertion };
}

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
  return path.replace(/\\\(((?:[^()]|\([^()]*\))*)\)/g, (_, expression: string) => {
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
  it("publishes guest App Attest handoff issuance as a live POST route", () => {
    expect(contract.paths["/v1/guest/attestations"]?.post).toMatchObject({
      "x-owner-issue": 610,
      "x-implementation-status": "implemented",
    });
    expect(existsSync(routeFileFor("/v1/guest/attestations"))).toBe(true);
    expect(exportedMethods(routeFileFor("/v1/guest/attestations"))).toContain("POST");
  });

  it("documents the exact handoff assertion request, success, and fail-closed statuses", () => {
    expect(contract.paths["/v1/guest/attestations"]?.post).toMatchObject({
      operationId: "issueGuestClaimHandoff",
      requestBody: {
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/GuestClaimHandoffRequest" },
          },
        },
        required: true,
      },
      responses: {
        "201": {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/GuestClaimHandoffEnvelope" },
            },
          },
        },
        "400": { $ref: "#/components/responses/InvalidRequest" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "429": { $ref: "#/components/responses/RateLimited" },
        "503": { $ref: "#/components/responses/Unavailable" },
      },
    });
  });

  it("claims the same recovery under the Clerk principal after a verified App Attest assertion", async () => {
    const { attestations, handoffs, verifyAssertion } = guestHandoffContractHarness();
    const encodedClientData = handoffClientData();
    const issued = await attestations(
      new Request("https://snaplist.test/v1/guest/attestations", {
        body: JSON.stringify({
          assertionObject: Buffer.from("crafted-cbor").toString("base64"),
          challengeId: "33333333-3333-4333-8333-333333333333",
          clientData: encodedClientData,
          keyId: APP_ATTEST_KEY_ID,
          operation: "handoff",
        }),
        method: "POST",
      }),
    );
    expect(issued.status).toBe(201);
    expect(verifyAssertion).toHaveBeenCalledWith({
      assertionObject: Buffer.from("crafted-cbor").toString("base64"),
      challengeId: "33333333-3333-4333-8333-333333333333",
      keyId: APP_ATTEST_KEY_ID,
      requestBody: Buffer.from(encodedClientData, "base64"),
    });
    const issuedBody = await issued.json();

    const claimGuestRecovery = vi.fn().mockResolvedValue({
      draftId: "44444444-4444-4444-8444-444444444444",
      itemId: "55555555-5555-4555-8555-555555555555",
      outcome: "claimed",
      purgeLocalRecovery: true,
      runId: "66666666-6666-4666-8666-666666666666",
    });
    const claim = createMobileApiHandler({
      authenticate: vi.fn().mockResolvedValue({ userId: "user_account" }),
      claimGuestRecovery,
      verifyGuestClaimHandoff: handoffs.verify,
      worker: { consume: vi.fn() },
      requestId: () => "req_claim",
    });
    const claimed = await claim(
      new Request("https://snaplist.test/v1/guest/claims", {
        headers: {
          authorization: "Bearer clerk-jwt",
          "idempotency-key": "77777777-7777-4777-8777-777777777777",
          "x-snaplist-guest-handoff": issuedBody.data.handoffToken,
        },
        method: "POST",
      }),
    );

    expect(claimed.status).toBe(200);
    expect(claimGuestRecovery).toHaveBeenCalledWith(expect.objectContaining({
      handoff: {
        guestUserId: GUEST_USER_ID,
        recoveryId: RECOVERY_ID,
        recoveryTokenHash: createHash("sha256").update(RECOVERY_TOKEN).digest("hex"),
      },
      targetUserId: "user_account",
    }));
  });

  it("rejects a replayed handoff token before a second tenant claim", async () => {
    const { attestations, handoffs } = guestHandoffContractHarness();
    const issued = await attestations(
      new Request("https://snaplist.test/v1/guest/attestations", {
        body: JSON.stringify({
          assertionObject: Buffer.from("crafted-cbor").toString("base64"),
          challengeId: "33333333-3333-4333-8333-333333333333",
          clientData: handoffClientData(),
          keyId: APP_ATTEST_KEY_ID,
          operation: "handoff",
        }),
        method: "POST",
      }),
    );
    const handoffToken = (await issued.json()).data.handoffToken as string;
    const claimGuestRecovery = vi.fn().mockResolvedValue({
      draftId: "44444444-4444-4444-8444-444444444444",
      itemId: "55555555-5555-4555-8555-555555555555",
      outcome: "expired",
      purgeLocalRecovery: true,
      runId: "66666666-6666-4666-8666-666666666666",
    });
    const claim = createMobileApiHandler({
      authenticate: vi.fn().mockResolvedValue({ userId: "user_account" }),
      claimGuestRecovery,
      verifyGuestClaimHandoff: handoffs.verify,
      worker: { consume: vi.fn() },
      requestId: () => "req_claim",
    });
    const request = (idempotencyKey: string) =>
      new Request("https://snaplist.test/v1/guest/claims", {
        headers: {
          authorization: "Bearer clerk-jwt",
          "idempotency-key": idempotencyKey,
          "x-snaplist-guest-handoff": handoffToken,
        },
        method: "POST",
      });

    expect((await claim(request("77777777-7777-4777-8777-777777777777"))).status).toBe(200);
    expect((await claim(request("88888888-8888-4888-8888-888888888888"))).status).toBe(401);
    expect(claimGuestRecovery).toHaveBeenCalledOnce();
  });

  it("rejects an expired handoff token before tenant claim", async () => {
    let now = new Date("2026-08-02T16:00:00.000Z");
    const { attestations, handoffs } = guestHandoffContractHarness(() => now);
    const issued = await attestations(
      new Request("https://snaplist.test/v1/guest/attestations", {
        body: JSON.stringify({
          assertionObject: Buffer.from("crafted-cbor").toString("base64"),
          challengeId: "33333333-3333-4333-8333-333333333333",
          clientData: handoffClientData(),
          keyId: APP_ATTEST_KEY_ID,
          operation: "handoff",
        }),
        method: "POST",
      }),
    );
    const handoffToken = (await issued.json()).data.handoffToken as string;
    now = new Date("2026-08-02T16:05:00.000Z");
    const claimGuestRecovery = vi.fn();
    const claim = createMobileApiHandler({
      authenticate: vi.fn().mockResolvedValue({ userId: "user_account" }),
      claimGuestRecovery,
      verifyGuestClaimHandoff: handoffs.verify,
      worker: { consume: vi.fn() },
      requestId: () => "req_claim",
    });

    const response = await claim(
      new Request("https://snaplist.test/v1/guest/claims", {
        headers: {
          authorization: "Bearer clerk-jwt",
          "idempotency-key": "77777777-7777-4777-8777-777777777777",
          "x-snaplist-guest-handoff": handoffToken,
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(401);
    expect(claimGuestRecovery).not.toHaveBeenCalled();
  });

  it("rejects a handoff when the recovery no longer has the attested photo set", async () => {
    const { attestations, handoffs, store } = guestHandoffContractHarness();
    const issued = await attestations(
      new Request("https://snaplist.test/v1/guest/attestations", {
        body: JSON.stringify({
          assertionObject: Buffer.from("crafted-cbor").toString("base64"),
          challengeId: "33333333-3333-4333-8333-333333333333",
          clientData: handoffClientData(),
          keyId: APP_ATTEST_KEY_ID,
          operation: "handoff",
        }),
        method: "POST",
      }),
    );
    const handoffToken = (await issued.json()).data.handoffToken as string;
    store.setRecoveryPhotoSetFingerprint(RECOVERY_ID, "e".repeat(64));
    const claimGuestRecovery = vi.fn();
    const claim = createMobileApiHandler({
      authenticate: vi.fn().mockResolvedValue({ userId: "user_account" }),
      claimGuestRecovery,
      verifyGuestClaimHandoff: handoffs.verify,
      worker: { consume: vi.fn() },
      requestId: () => "req_claim",
    });

    const response = await claim(
      new Request("https://snaplist.test/v1/guest/claims", {
        headers: {
          authorization: "Bearer clerk-jwt",
          "idempotency-key": "77777777-7777-4777-8777-777777777777",
          "x-snaplist-guest-handoff": handoffToken,
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(401);
    expect(claimGuestRecovery).not.toHaveBeenCalled();
  });

  it("refuses the guest allowance when the assertion key was never attested", async () => {
    const { handoffs } = guestHandoffContractHarness();
    const attestations = createGuestAttestationHandler({
      appAttest: {
        issueChallenge: vi.fn(),
        verifyAttestation: vi.fn(),
        verifyAssertion: vi.fn().mockResolvedValue({
          code: "key_not_attested",
          kind: "assertion",
          status: "invalid",
        }),
      },
      handoffs,
      requestId: () => "req_attestation",
    });

    const response = await attestations(
      new Request("https://snaplist.test/v1/guest/attestations", {
        body: JSON.stringify({
          assertionObject: Buffer.from("crafted-cbor").toString("base64"),
          challengeId: "33333333-3333-4333-8333-333333333333",
          clientData: handoffClientData(),
          keyId: APP_ATTEST_KEY_ID,
          operation: "handoff",
        }),
        method: "POST",
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "forbidden",
        message: "App Attest is required for the guest allowance.",
        requestId: "req_attestation",
      },
    });
  });

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
