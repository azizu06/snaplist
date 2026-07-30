import { describe, expect, it, vi } from "vitest";
import {
  MAX_MOBILE_ITEM_PHOTO_BYTES,
  type MobileItemSubmissionOperations,
  type MobileItemSubmissionReceipt,
} from "./contract";
import { MAX_MOBILE_ITEM_MULTIPART_BYTES } from "./bounded-multipart";
import { createMobileItemSubmissionHandler } from "./http";

function rawMultipart(
  boundary: string,
  parts: Array<{ headers: string[]; body: Uint8Array }>,
): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    chunks.push(
      encoder.encode(
        `--${boundary}\r\n${part.headers.join("\r\n")}\r\n\r\n`,
      ),
      part.body,
      encoder.encode("\r\n"),
    );
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`));
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

describe("POST /v1/items/runs", () => {
  it("rejects a multipart media-type lookalike before persistence", async () => {
    const submit = vi.fn();
    const handler = createMobileItemSubmissionHandler({
      requestId: () => "req_exact_multipart_type",
      itemSubmission: {
        async resolvePrincipal(bearerToken) {
          return { kind: "clerk", userId: "user_native", bearerToken };
        },
        submit,
      },
    });
    const boundary = "snaplist-541-exact-media-type";
    const body = rawMultipart(boundary, [{
      headers: [
        'Content-Disposition: form-data; name="photo"; filename="front.jpg"',
        "Content-Type: image/jpeg",
      ],
      body: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    }]);

    const response = await handler(new Request(
      "http://localhost/v1/items/runs",
      {
        method: "POST",
        headers: {
          authorization: "Bearer signed-jwt",
          "content-type": `multipart/form-dataevil; boundary=${boundary}`,
          "idempotency-key": "54100000-0000-4000-8000-000000000020",
        },
        body: body.buffer as ArrayBuffer,
      },
    ));

    expect(response.status).toBe(400);
    expect(submit).not.toHaveBeenCalled();
  });

  it("rejects an oversized attachment and missing or invalid disposition before persistence", async () => {
    const submit = vi.fn();
    const handler = createMobileItemSubmissionHandler({
      requestId: () => "req_hidden_multipart_part",
      itemSubmission: {
        async resolvePrincipal(bearerToken) {
          return { kind: "clerk", userId: "user_native", bearerToken };
        },
        submit,
      },
    });
    const boundary = "snaplist-541-hidden-parts";
    const photoPart = {
      headers: [
        'Content-Disposition: form-data; name="photo"; filename="front.jpg"',
        "Content-Type: image/jpeg",
      ],
      body: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    };
    const hiddenParts = [
      {
        headers: ['Content-Disposition: attachment; name="sellerCommand"'],
        body: new Uint8Array(512 * 1024 + 1),
      },
      {
        headers: ["Content-Type: text/plain"],
        body: new TextEncoder().encode("missing"),
      },
      {
        headers: ["Content-Disposition: invalid"],
        body: new TextEncoder().encode("invalid"),
      },
    ];

    for (const [index, hiddenPart] of hiddenParts.entries()) {
      const body = rawMultipart(boundary, [photoPart, hiddenPart]);
      const response = await handler(new Request(
        "http://localhost/v1/items/runs",
        {
          method: "POST",
          headers: {
            authorization: "Bearer signed-jwt",
            "content-type": `multipart/form-data; boundary=${boundary}`,
            "idempotency-key": `54100000-0000-4000-8000-00000000003${index}`,
          },
          body: body.buffer as ArrayBuffer,
        },
      ));
      expect(response.status).toBe(400);
    }
    expect(submit).not.toHaveBeenCalled();
  });

  it("rejects empty, overlong, non-ASCII, and trailing-space multipart boundaries before persistence", async () => {
    const submit = vi.fn();
    const handler = createMobileItemSubmissionHandler({
      requestId: () => "req_invalid_boundary",
      itemSubmission: {
        async resolvePrincipal(bearerToken) {
          return { kind: "clerk", userId: "user_native", bearerToken };
        },
        submit,
      },
    });
    const contentTypes = [
      'multipart/form-data; boundary=""',
      `multipart/form-data; boundary=${"a".repeat(71)}`,
      'multipart/form-data; boundary="é"',
      'multipart/form-data; boundary="trailing "',
    ];

    for (const [index, contentType] of contentTypes.entries()) {
      const response = await handler(new Request(
        "http://localhost/v1/items/runs",
        {
          method: "POST",
          headers: {
            authorization: "Bearer signed-jwt",
            "content-type": contentType,
            "idempotency-key": `54100000-0000-4000-8000-00000000004${index}`,
          },
          body: new Uint8Array([1]).buffer,
        },
      ));
      expect(response.status).toBe(400);
    }
    expect(submit).not.toHaveBeenCalled();
  });

  it("stops a raw multipart body at the hard total byte ceiling before persistence", async () => {
    const submit = vi.fn();
    const handler = createMobileItemSubmissionHandler({
      requestId: () => "req_total_multipart_limit",
      itemSubmission: {
        async resolvePrincipal(bearerToken) {
          return { kind: "clerk", userId: "user_native", bearerToken };
        },
        submit,
      },
    });
    const boundary = "snaplist-541-total-limit";
    const opening = new TextEncoder().encode(
      `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="photo"; filename="front.jpg"\r\n' +
        "Content-Type: image/jpeg\r\n\r\n",
    );
    const chunk = new Uint8Array(4 * 1024 * 1024);
    let emittedBytes = 0;
    let emittedOpening = false;
    let canceled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (!emittedOpening) {
            emittedOpening = true;
            emittedBytes += opening.byteLength;
            controller.enqueue(opening);
            return;
          }
          emittedBytes += chunk.byteLength;
          controller.enqueue(chunk);
        },
        cancel() {
          canceled = true;
        }
      },
      { highWaterMark: 0 },
    );
    const request = new Request(
      "http://localhost/v1/items/runs",
      {
        method: "POST",
        headers: {
          authorization: "Bearer signed-jwt",
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "idempotency-key": "54100000-0000-4000-8000-000000000050",
        },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" },
    );

    const response = await handler(request);

    expect(response.status).toBe(400);
    expect(submit).not.toHaveBeenCalled();
    expect(canceled).toBe(true);
    expect(emittedBytes).toBeGreaterThan(MAX_MOBILE_ITEM_MULTIPART_BYTES);
    expect(emittedBytes).toBeLessThanOrEqual(
      MAX_MOBILE_ITEM_MULTIPART_BYTES + chunk.byteLength,
    );
  }, 10_000);

  it("streams and drains voice overflow without buffering through Request.formData", async () => {
    const submit = vi.fn(async (
      input: Parameters<MobileItemSubmissionOperations["submit"]>[0],
    ) => ({
      outcome: "created" as const,
      receipt: {
        itemId: "54100000-0000-4000-8000-000000000001",
        runId: "54100000-0000-4000-8000-000000000002",
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
        voiceContext: null,
      },
    }));
    const handler = createMobileItemSubmissionHandler({
      acceptVoiceContext: () => true,
      requestId: () => "req_voice_overflow",
      itemSubmission: {
        async resolvePrincipal(bearerToken) {
          return { kind: "clerk", userId: "user_native", bearerToken };
        },
        submit,
      },
    });
    const body = new FormData();
    body.append(
      "voiceContext",
      new File(
        [new Uint8Array(512 * 1024 + 1).buffer],
        "overflow.wav",
        { type: "audio/wav" },
      ),
    );
    body.append(
      "photo",
      new File(
        [new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer],
        "front.jpg",
        { type: "image/jpeg" },
      ),
    );
    const request = new Request("http://localhost/v1/items/runs", {
      method: "POST",
      headers: {
        authorization: "Bearer signed-jwt",
        "idempotency-key": "54100000-0000-4000-8000-000000000003",
      },
      body,
    });
    const formData = vi
      .spyOn(request, "formData")
      .mockRejectedValue(new Error("Request.formData must stay unused"));

    const response = await handler(request);

    expect(response.status).toBe(202);
    expect(formData).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0]![0].voice).toBeNull();
  });

  it("drains voice above the former parser cap and submits valid photos only", async () => {
    const submit = vi.fn(async (
      input: Parameters<MobileItemSubmissionOperations["submit"]>[0],
    ) => ({
      outcome: "created" as const,
      receipt: {
        itemId: "54100000-0000-4000-8000-000000000061",
        runId: "54100000-0000-4000-8000-000000000062",
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
        voiceContext: null,
      },
    }));
    const handler = createMobileItemSubmissionHandler({
      acceptVoiceContext: () => true,
      requestId: () => "req_voice_above_former_parser_cap",
      itemSubmission: {
        async resolvePrincipal(bearerToken) {
          return { kind: "clerk", userId: "user_native", bearerToken };
        },
        submit,
      },
    });
    const boundary = "snaplist-541-voice-above-former-cap";
    const encoder = new TextEncoder();
    const voiceOpening = encoder.encode(
      `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="voiceContext"; filename="overflow.wav"\r\n' +
        "Content-Type: audio/wav\r\n\r\n",
    );
    const photoAndClosing = encoder.encode(
      `\r\n--${boundary}\r\n` +
        'Content-Disposition: form-data; name="photo"; filename="front.jpg"\r\n' +
        "Content-Type: image/jpeg\r\n\r\n",
    );
    const closing = encoder.encode(`\r\n--${boundary}--\r\n`);
    const voiceChunk = new Uint8Array(1024 * 1024);
    const formerParserCap =
      MAX_MOBILE_ITEM_PHOTO_BYTES + 256 * 1024;
    const voiceBodyBytes = formerParserCap + voiceChunk.byteLength;
    let phase = 0;
    let emittedVoiceBytes = 0;
    let largestChunkBytes = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (phase === 0) {
            phase = 1;
            largestChunkBytes = Math.max(
              largestChunkBytes,
              voiceOpening.byteLength,
            );
            controller.enqueue(voiceOpening);
            return;
          }
          if (phase === 1 && emittedVoiceBytes < voiceBodyBytes) {
            const remaining = voiceBodyBytes - emittedVoiceBytes;
            const chunk =
              remaining >= voiceChunk.byteLength
                ? voiceChunk
                : voiceChunk.subarray(0, remaining);
            emittedVoiceBytes += chunk.byteLength;
            largestChunkBytes = Math.max(largestChunkBytes, chunk.byteLength);
            controller.enqueue(chunk);
            return;
          }
          if (phase === 1) {
            phase = 2;
            largestChunkBytes = Math.max(
              largestChunkBytes,
              photoAndClosing.byteLength,
            );
            controller.enqueue(photoAndClosing);
            return;
          }
          if (phase === 2) {
            phase = 3;
            controller.enqueue(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
            return;
          }
          if (phase === 3) {
            phase = 4;
            largestChunkBytes = Math.max(
              largestChunkBytes,
              closing.byteLength,
            );
            controller.enqueue(closing);
            return;
          }
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const request = new Request(
      "http://localhost/v1/items/runs",
      {
        method: "POST",
        headers: {
          authorization: "Bearer signed-jwt",
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "idempotency-key": "54100000-0000-4000-8000-000000000063",
        },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" },
    );

    const response = await handler(request);

    expect(response.status).toBe(202);
    expect(emittedVoiceBytes).toBe(voiceBodyBytes);
    expect(emittedVoiceBytes).toBeGreaterThan(formerParserCap);
    expect(largestChunkBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0]![0]).toMatchObject({
      photos: [{ ordinal: 0, mediaType: "image/jpeg" }],
      voice: null,
    });
    await expect(response.json()).resolves.toMatchObject({
      data: { voiceContext: null },
    });
  }, 10_000);

  it("rejects oversized photos, duplicate singleton parts, and unsupported parts before persistence", async () => {
    const submit = vi.fn();
    const handler = createMobileItemSubmissionHandler({
      requestId: () => "req_bounded_multipart",
      itemSubmission: {
        async resolvePrincipal(bearerToken) {
          return { kind: "clerk", userId: "user_native", bearerToken };
        },
        submit,
      },
    });
    const request = (body: FormData, suffix: number) =>
      new Request("http://localhost/v1/items/runs", {
        method: "POST",
        headers: {
          authorization: "Bearer signed-jwt",
          "idempotency-key": `54100000-0000-4000-8000-00000000001${suffix}`,
        },
        body,
      });
    const appendPhoto = (body: FormData) => {
      body.append(
        "photo",
        new File(
          [new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer],
          "front.jpg",
          { type: "image/jpeg" },
        ),
      );
    };

    const oversizedPhoto = new FormData();
    oversizedPhoto.append(
      "photo",
      new File(
        [new Uint8Array(MAX_MOBILE_ITEM_PHOTO_BYTES + 1).buffer],
        "too-large.jpg",
        { type: "image/jpeg" },
      ),
    );

    const duplicateVoice = new FormData();
    appendPhoto(duplicateVoice);
    duplicateVoice.append(
      "voiceContext",
      new File([new Uint8Array([1]).buffer], "first.wav", {
        type: "audio/wav",
      }),
    );
    duplicateVoice.append(
      "voiceContext",
      new File([new Uint8Array([2]).buffer], "second.wav", {
        type: "audio/wav",
      }),
    );

    const duplicateLocale = new FormData();
    appendPhoto(duplicateLocale);
    duplicateLocale.append("voiceContextLocale", "en-US");
    duplicateLocale.append("voiceContextLocale", "fr-FR");

    const duplicateCostBasis = new FormData();
    appendPhoto(duplicateCostBasis);
    duplicateCostBasis.append("costBasis", "1.00");
    duplicateCostBasis.append("costBasis", "2.00");

    const unsupported = new FormData();
    appendPhoto(unsupported);
    unsupported.append("sellerCommand", "publish");

    for (const [index, body] of [
      oversizedPhoto,
      duplicateVoice,
      duplicateLocale,
      duplicateCostBasis,
      unsupported,
    ].entries()) {
      expect((await handler(request(body, index))).status).toBe(400);
    }
    expect(submit).not.toHaveBeenCalled();
  });

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
        voiceContext: null,
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
          voiceContext: null,
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
