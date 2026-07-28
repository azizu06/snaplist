import { describe, expect, it, vi } from "vitest";
import type {
  MobileItemSubmissionOperations,
  MobileItemSubmissionReceipt,
} from "./contract";
import { createMobileItemSubmissionHandler } from "./http";

describe("POST /v1/items/runs", () => {
  it("accepts one and five verified photos and rejects zero or six before durable submission", async () => {
    const submit = vi.fn(async (
      input: Parameters<MobileItemSubmissionOperations["submit"]>[0],
    ) => ({
      outcome: "created" as const,
      receipt: {
        itemId: "35200000-0000-4000-8000-000000000001",
        runId: "35200000-0000-4000-8000-000000000002",
        status: "queued" as const,
        stage: "queued" as const,
        photoIdentity: {
          kind: "content_sha256_set_v1" as const,
          fingerprint: "a".repeat(64),
        },
        photos: input.photos.map(
          ({ ordinal, contentSha256, byteLength, mediaType }) => ({
            ordinal,
            contentSha256,
            byteLength,
            mediaType,
          }),
        ),
      },
    }));
    const handler = createMobileItemSubmissionHandler({
      requestId: () => "req_photo_count",
      itemSubmission: {
        async resolvePrincipal(bearerToken) {
          return {
            kind: "verifiedGuest",
            userId: "guest_352",
            capabilityId: "35200000-0000-4000-8000-000000000001",
            mintOperationToken: async () => bearerToken,
          };
        },
        submit,
      },
    });
    const request = (photoCount: number) => {
      const body = new FormData();
      for (let ordinal = 0; ordinal < photoCount; ordinal += 1) {
        body.append("photo", new File([
          new Uint8Array([0xff, 0xd8, 0xff, ordinal]).buffer,
        ], `photo-${ordinal}.jpg`, { type: "image/jpeg" }));
      }
      return new Request("http://localhost/v1/items/runs", {
        method: "POST",
        headers: {
          authorization: "Bearer verified-guest-capability",
          "idempotency-key": `35200000-0000-4000-8000-00000000000${photoCount}`,
        },
        body,
      });
    };

    expect((await handler(request(1))).status).toBe(202);
    expect((await handler(request(5))).status).toBe(202);
    expect((await handler(request(0))).status).toBe(400);
    expect((await handler(request(6))).status).toBe(400);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1][0].photos.map((photo) => photo.ordinal)).toEqual([
      0, 1, 2, 3, 4,
    ]);
  });

  it.each([
    ["allowance_denied", "snaplist-pro-required", 403, "forbidden"],
    ["rate_limited", "per-minute-capacity-reached", 429, "rate_limited"],
  ] as const)(
    "maps the existing %s staging outcome to a truthful typed response",
    async (kind, reason, status, code) => {
      const handler = createMobileItemSubmissionHandler({
        requestId: () => "req_policy",
        itemSubmission: {
          async resolvePrincipal(bearerToken) {
            return { kind: "clerk", userId: "user_native", bearerToken };
          },
          async submit() {
            throw Object.assign(new Error(reason), {
              code: "mobile_item_submission_denied" as const,
              kind,
              reason,
            });
          },
        },
      });
      const body = new FormData();
      body.append("photo", new File([
        new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer,
      ], "item.jpg", { type: "image/jpeg" }));

      const response = await handler(new Request("http://localhost/v1/items/runs", {
        method: "POST",
        headers: {
          authorization: "Bearer signed-jwt",
          "idempotency-key": "33400000-0000-4000-8000-000000000010",
        },
        body,
      }));

      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toMatchObject({
        error: { code, details: { reason }, requestId: "req_policy" },
      });
    },
  );

  it("recovers one ambiguous multipart submission and rejects changed bytes, order, or cost", async () => {
    const idempotencyKey = "33400000-0000-4000-8000-000000000001";
    const runId = "33400000-0000-4000-8000-000000000002";
    const itemId = "33400000-0000-4000-8000-000000000003";
    const committed = new Map<string, { fingerprint: string; receipt: MobileItemSubmissionReceipt }>();
    let reservations = 0;
    let queueMessages = 0;
    let loseFirstResponse = true;
    const itemSubmission = {
      resolvePrincipal: vi.fn().mockResolvedValue({
        kind: "clerk" as const,
        userId: "user_native",
        bearerToken: "signed-jwt",
      }),
      submit: vi.fn(async (input: {
        principal: { userId: string };
        idempotencyKey: string;
        requestFingerprint: string;
      }) => {
        const key = `${input.principal.userId}:${input.idempotencyKey}`;
        const existing = committed.get(key);
        if (existing && existing.fingerprint !== input.requestFingerprint) {
          throw Object.assign(new Error("submission key conflict"), {
            code: "mobile_item_submission_conflict" as const,
          });
        }
        if (existing) return { outcome: "replayed" as const, receipt: existing.receipt };
        const receipt = {
          itemId,
          runId,
          status: "queued" as const,
          stage: "queued" as const,
          photoIdentity: {
            kind: "content_sha256_set_v1" as const,
            fingerprint: "a".repeat(64),
          },
          photos: [
            { ordinal: 0, contentSha256: "b".repeat(64), byteLength: 4, mediaType: "image/jpeg" as const },
            { ordinal: 1, contentSha256: "c".repeat(64), byteLength: 12, mediaType: "image/png" as const },
          ],
        };
        committed.set(key, { fingerprint: input.requestFingerprint, receipt });
        reservations += 1;
        queueMessages += 1;
        if (loseFirstResponse) {
          loseFirstResponse = false;
          throw new Error("response lost after commit");
        }
        return { outcome: "created" as const, receipt };
      }),
    };
    const handler = createMobileItemSubmissionHandler({
      itemSubmission,
      requestId: () => "req_test",
    });
    const front = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const back = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
    ]);
    const request = (photos: Array<{ bytes: Uint8Array; name: string; type: string }>, cost = "7.50") => {
      const body = new FormData();
      for (const photo of photos) {
        body.append("photo", new File([new Uint8Array(photo.bytes).buffer], photo.name, {
          type: photo.type,
        }));
      }
      body.set("costBasis", cost);
      return new Request("http://localhost/v1/items/runs", {
        method: "POST",
        headers: { authorization: "Bearer signed-jwt", "idempotency-key": idempotencyKey },
        body,
      });
    };
    const original = [
      { bytes: front, name: "front.jpg", type: "image/jpeg" },
      { bytes: back, name: "back.png", type: "image/png" },
    ];

    expect((await handler(request(original))).status).toBe(503);
    const replay = await handler(request(original));
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      data: { itemId, runId, status: "queued" },
      meta: { requestId: "req_test" },
    });

    for (const changed of [
      request([{ ...original[0], bytes: new Uint8Array([0xff, 0xd8, 0xff, 0x00]) }, original[1]]),
      request([...original].reverse()),
      request(original, "8.00"),
    ]) {
      const conflict = await handler(changed);
      expect(conflict.status).toBe(409);
      await expect(conflict.json()).resolves.toMatchObject({
        error: { code: "conflict", requestId: "req_test" },
      });
    }
    expect({ reservations, queueMessages }).toEqual({ reservations: 1, queueMessages: 1 });
    expect(itemSubmission.resolvePrincipal).toHaveBeenCalledWith("signed-jwt");
  });
});
