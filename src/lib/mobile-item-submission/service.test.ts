import { describe, expect, it, vi } from "vitest";
import { createMobileItemSubmissionHandler } from "./http";
import { MobileItemSubmissionDeniedError } from "./contract";
import {
  createMobileItemSubmissionOperations,
  type MobileItemSubmissionStaging,
  type TenantPhotoStorage,
} from "./service";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02]);
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03, 0x04,
]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x01, 0x02, 0x03, 0x04, 0x57, 0x45, 0x42, 0x50,
]);

function multipartRequest(): Request {
  const body = new FormData();
  body.append("photo", new File([JPEG], "front.jpg", { type: "image/jpeg" }));
  body.append("photo", new File([PNG], "back.png", { type: "image/png" }));
  body.append("photo", new File([WEBP], "side.webp", { type: "image/webp" }));
  body.append("photo", new File([
    new Uint8Array([...JPEG, 0x03]),
  ], "detail.jpg", { type: "image/jpeg" }));
  body.append("photo", new File([
    new Uint8Array([...PNG, 0x05]),
  ], "label.png", { type: "image/png" }));
  body.set("costBasis", "12.34");
  return new Request("http://localhost/v1/items/runs", {
    method: "POST",
    headers: {
      authorization: "Bearer signed-clerk-jwt",
      "idempotency-key": "33410000-0000-4000-8000-000000000001",
    },
    body,
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("mobile item submission HTTP composition", () => {
  it("persists cleanup before writes and commits only independently verified server-owned objects", async () => {
    const events: string[] = [];
    const objects = new Map<string, { bytes: Uint8Array; mediaType: string }>();
    const commit = vi.fn(async (
      input: Parameters<MobileItemSubmissionStaging["commitSubmission"]>[0],
    ) => {
      events.push("commit");
      return {
        outcome: "created" as const,
        receipt: {
          itemId: "33410000-0000-4000-8000-000000000002",
          runId: "33410000-0000-4000-8000-000000000003",
          status: "queued" as const,
          stage: "queued" as const,
          photoIdentity: input.photoIdentity,
          photos: input.photoReceipts.map(
            ({ ordinal, contentSha256, byteLength, mediaType }) => ({
              ordinal,
              contentSha256,
              byteLength,
              mediaType,
            }),
          ),
        },
      };
    });
    const itemSubmission = createMobileItemSubmissionOperations({
      resolvePrincipal: vi.fn(async (bearerToken) => ({
        kind: "clerk" as const,
        userId: "user_clerk_334",
        bearerToken,
      })),
      limits: { dailyLimit: 15, perMinuteLimit: 20 },
      storageFor: vi.fn((): TenantPhotoStorage => ({
        async upload(path, bytes, mediaType) {
          events.push(`upload:${path}`);
          objects.set(path, { bytes: Uint8Array.from(bytes), mediaType });
        },
        async download(path) {
          events.push(`download:${path}`);
          const stored = objects.get(path);
          if (!stored) throw new Error("missing object");
          return stored;
        },
      })),
      staging: {
        findSubmission: vi.fn(async () => null),
        beginSubmission: vi.fn(async () => {
          events.push("submission-bound");
          return true;
        }),
        resolveCleanupIntent: vi.fn(async () => {
          events.push("cleanup-resolved");
          return true;
        }),
        commitSubmission: commit,
      },
    });
    const handler = createMobileItemSubmissionHandler({
      itemSubmission,
      requestId: () => "req_334",
    });

    const response = await handler(multipartRequest());

    expect(response.status).toBe(202);
    expect(events[0]).toBe("submission-bound");
    expect(events.filter((event) => event.startsWith("upload:"))).toHaveLength(5);
    expect(events.filter((event) => event.startsWith("download:"))).toHaveLength(5);
    expect(events.indexOf("commit")).toBeGreaterThan(
      Math.max(...events.map((event, index) => event.startsWith("download:") ? index : -1)),
    );
    expect(events.at(-1)).toBe("cleanup-resolved");
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user_clerk_334",
      idempotencyKey: "33410000-0000-4000-8000-000000000001",
      batchId: "33410000-0000-4000-8000-000000000001",
      costBasis: 12.34,
      photoIdentity: {
        kind: "content_sha256_set_v1",
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      photoReceipts: [
        expect.objectContaining({
          ordinal: 0,
          storagePath: expect.stringMatching(
            /^user_clerk_334\/pipeline-staging\/33410000-0000-4000-8000-000000000001\/0\//,
          ),
          mediaType: "image/jpeg",
          byteLength: JPEG.byteLength,
          contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
        expect.objectContaining({ ordinal: 1, mediaType: "image/png" }),
        expect.objectContaining({ ordinal: 2, mediaType: "image/webp" }),
        expect.objectContaining({ ordinal: 3, mediaType: "image/jpeg" }),
        expect.objectContaining({ ordinal: 4, mediaType: "image/png" }),
      ],
    }));
    const body = JSON.stringify(await response.json());
    expect(body).toContain("33410000-0000-4000-8000-000000000003");
    expect(body).not.toContain("pipeline-staging");
    expect(body).not.toContain("user_clerk_334");
  });

  it("leaves a verified guest's denied upload under the durable retention fence", async () => {
    const events: string[] = [];
    const objects = new Set<string>();
    const cleanup = vi.fn(async () => {
      events.push("cleanup-resolved");
      return true;
    });
    const itemSubmission = createMobileItemSubmissionOperations({
      resolvePrincipal: vi.fn(async (bearerToken) => ({
        kind: "verifiedGuest" as const,
        userId: "guest_server_verified",
        capabilityId: "33200000-0000-4000-8000-000000000001",
        mintOperationToken: async () => bearerToken,
      })),
      limits: { dailyLimit: 15, perMinuteLimit: 20 },
      storageFor: vi.fn(() => ({
        async upload(path: string) {
          events.push(`upload:${path}`);
          objects.add(path);
        },
        async download(path: string) {
          events.push(`download:${path}`);
          return { bytes: JPEG, mediaType: "image/jpeg" };
        },
        async remove(paths: string[]) {
          events.push("remove");
          for (const path of paths) objects.delete(path);
        },
      })),
      staging: {
        findSubmission: vi.fn(async () => null),
        beginSubmission: vi.fn(async () => true),
        resolveCleanupIntent: cleanup,
        commitSubmission: vi.fn(async () => {
          events.push("commit");
          throw new MobileItemSubmissionDeniedError(
            "allowance_denied",
            "monthly-allowance-reached",
          );
        }),
      },
    });
    const handler = createMobileItemSubmissionHandler({
      itemSubmission,
      requestId: () => "req_332_denied",
    });
    const body = new FormData();
    body.append("photo", new File([JPEG], "front.jpg", { type: "image/jpeg" }));
    const response = await handler(new Request("http://localhost/v1/items/runs", {
      method: "POST",
      headers: {
        authorization: "Bearer guest-capability",
        "idempotency-key": "33210000-0000-4000-8000-000000000001",
      },
      body,
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { details: { reason: "monthly-allowance-reached" } },
    });
    expect(events.at(-1)).toBe("commit");
    expect(events).not.toContain("remove");
    expect(objects.size).toBe(1);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("cannot let an old denial delete a same-path retry after verification", async () => {
    const beforeRemove = deferred();
    const releaseRemove = deferred();
    const retryAtCommit = deferred();
    const releaseRetryCommit = deferred();
    const objects = new Map<string, { bytes: Uint8Array; mediaType: string }>();
    let commits = 0;
    const itemSubmission = createMobileItemSubmissionOperations({
      resolvePrincipal: vi.fn(async (bearerToken) => ({
        capabilityId: "33200000-0000-4000-8000-000000000001",
        kind: "verifiedGuest" as const,
        mintOperationToken: async () => bearerToken,
        userId: "guest_server_verified",
      })),
      limits: { dailyLimit: 15, perMinuteLimit: 20 },
      storageFor: vi.fn(() => ({
        async upload(path: string, bytes: Uint8Array, mediaType: string) {
          if (objects.has(path)) throw new Error("duplicate object");
          objects.set(path, { bytes: Uint8Array.from(bytes), mediaType });
        },
        async download(path: string) {
          const stored = objects.get(path);
          if (!stored) throw new Error("missing object");
          return stored;
        },
        async remove(paths: string[]) {
          beforeRemove.resolve();
          await releaseRemove.promise;
          for (const path of paths) objects.delete(path);
        },
      })),
      staging: {
        findSubmission: vi.fn(async () => null),
        beginSubmission: vi.fn(async () => true),
        resolveCleanupIntent: vi.fn(async () => true),
        commitSubmission: vi.fn(async (
          input: Parameters<MobileItemSubmissionStaging["commitSubmission"]>[0],
        ) => {
          commits += 1;
          if (commits === 1) {
            throw new MobileItemSubmissionDeniedError(
              "allowance_denied",
              "monthly-allowance-reached",
            );
          }
          retryAtCommit.resolve();
          await releaseRetryCommit.promise;
          return {
            outcome: "created" as const,
            receipt: {
              itemId: "33200000-0000-4000-8000-000000000010",
              photoIdentity: input.photoIdentity,
              photos: input.photoReceipts.map(
                ({ byteLength, contentSha256, mediaType, ordinal }) => ({
                  byteLength,
                  contentSha256,
                  mediaType,
                  ordinal,
                }),
              ),
              runId: "33200000-0000-4000-8000-000000000011",
              stage: "queued" as const,
              status: "queued" as const,
            },
          };
        }),
      },
    });
    const handler = createMobileItemSubmissionHandler({
      itemSubmission,
      requestId: () => crypto.randomUUID(),
    });
    const idempotencyKey = "33200000-0000-4000-8000-000000000020";
    const request = () => {
      const body = new FormData();
      body.append("photo", new File([JPEG], "front.jpg", { type: "image/jpeg" }));
      return new Request("http://localhost/v1/items/runs", {
        method: "POST",
        headers: {
          authorization: "Bearer guest-capability",
          "idempotency-key": idempotencyKey,
        },
        body,
      });
    };

    const deniedResponse = handler(request());
    const denialBoundary = await Promise.race([
      deniedResponse.then(() => "denial-returned" as const),
      beforeRemove.promise.then(() => "remove-started" as const),
    ]);
    const retryResponse = handler(request());
    await retryAtCommit.promise;
    releaseRemove.resolve();
    releaseRetryCommit.resolve();

    expect((await deniedResponse).status).toBe(403);
    expect((await retryResponse).status).toBe(202);
    expect(denialBoundary).toBe("denial-returned");
    expect(objects.size).toBe(1);
  });
});
