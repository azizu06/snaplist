import { describe, expect, it, vi } from "vitest";
import { createMobileItemSubmissionHandler } from "./http";
import {
  createMobileItemSubmissionOperations,
  type MobileItemSubmissionStaging,
  type TenantPhotoStorage,
} from "./service";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02]);
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03, 0x04,
]);

function multipartRequest(): Request {
  const body = new FormData();
  body.append("photo", new File([JPEG], "front.jpg", { type: "image/jpeg" }));
  body.append("photo", new File([PNG], "back.png", { type: "image/png" }));
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
    expect(events.filter((event) => event.startsWith("upload:"))).toHaveLength(2);
    expect(events.filter((event) => event.startsWith("download:"))).toHaveLength(2);
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
      ],
    }));
    const body = JSON.stringify(await response.json());
    expect(body).toContain("33410000-0000-4000-8000-000000000003");
    expect(body).not.toContain("pipeline-staging");
    expect(body).not.toContain("user_clerk_334");
  });
});
