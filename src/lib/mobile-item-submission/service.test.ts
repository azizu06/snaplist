import { describe, expect, it, vi } from "vitest";
import { createMobileItemSubmissionHandler } from "./http";
import {
  MobileItemSubmissionConflictError,
  MobileItemSubmissionDeniedError,
  prepareMobileItemSubmission,
  type MobileItemSubmissionReceipt,
} from "./contract";
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

function fixedWavBytes(sampleSeed = 0): Uint8Array {
  const samples = 160;
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      bytes[offset + index] = value.charCodeAt(index);
    }
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  writeAscii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, samples * 2, true);
  view.setInt16(44, sampleSeed, true);
  return bytes;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("mobile item submission HTTP composition", () => {
  it("replays a pre-existing photo-only v1 binding through the current v2 handler", async () => {
    const prepared = await prepareMobileItemSubmission(
      await multipartRequest().formData(),
    );
    const legacyFingerprint = prepared.legacyRequestFingerprint!;
    const receipt: MobileItemSubmissionReceipt = {
      itemId: "54130000-0000-4000-8000-000000000001",
      runId: "54130000-0000-4000-8000-000000000002",
      status: "queued",
      stage: "queued",
      photoIdentity: {
        kind: "content_sha256_set_v1",
        fingerprint: "d".repeat(64),
      },
      photos: prepared.photos.map(
        ({ ordinal, contentSha256, byteLength, mediaType }) => ({
          ordinal,
          contentSha256,
          byteLength,
          mediaType,
        }),
      ),
      voiceContext: null,
    };
    const beginSubmission = vi.fn();
    const commitSubmission = vi.fn();
    const storageFor = vi.fn();
    const operations = createMobileItemSubmissionOperations({
      resolvePrincipal: async (bearerToken) => ({
        kind: "clerk",
        userId: "user_photo_v1_replay",
        bearerToken,
      }),
      limits: { dailyLimit: 15, perMinuteLimit: 20 },
      storageFor,
      staging: {
        async findSubmission(input) {
          const compatibility = input as typeof input & {
            legacyRequestFingerprint?: string | null;
          };
          expect(input.requestFingerprint).not.toBe(legacyFingerprint);
          return compatibility.legacyRequestFingerprint === legacyFingerprint
            ? receipt
            : null;
        },
        beginSubmission,
        commitSubmission,
        async resolveCleanupIntent() {
          return true;
        },
      },
    });
    const handler = createMobileItemSubmissionHandler({
      itemSubmission: operations,
      requestId: () => "req_photo_v1_replay",
    });

    const response = await handler(multipartRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        itemId: receipt.itemId,
        runId: receipt.runId,
        voiceContext: null,
      },
    });
    expect(beginSubmission).not.toHaveBeenCalled();
    expect(commitSubmission).not.toHaveBeenCalled();
    expect(storageFor).not.toHaveBeenCalled();
  });

  it("returns one canonical run and matching voice receipt after ambiguous v2 replay", async () => {
    const objects = new Map<string, { bytes: Uint8Array; mediaType: string }>();
    let committed:
      | {
          fingerprint: string;
          receipt: MobileItemSubmissionReceipt;
        }
      | undefined;
    let queueMessages = 0;
    const staging: MobileItemSubmissionStaging = {
      async findSubmission(input) {
        if (!committed) return null;
        if (committed.fingerprint !== input.requestFingerprint) {
          throw new MobileItemSubmissionConflictError();
        }
        return committed.receipt;
      },
      async beginSubmission() {
        return true;
      },
      async resolveCleanupIntent() {
        return true;
      },
      async commitSubmission(input) {
        if (committed) {
          if (committed.fingerprint !== input.requestFingerprint) {
            throw new MobileItemSubmissionConflictError();
          }
          return { outcome: "replayed", receipt: committed.receipt };
        }
        const voice = (
          input as typeof input & {
            voiceReceipt: null | {
              byteLength: number;
              contentSha256: string;
              durationMs: number;
              mediaType: "audio/wav";
              version: 1;
            };
          }
        ).voiceReceipt;
        committed = {
          fingerprint: input.requestFingerprint,
          receipt: {
            itemId: "54100000-0000-4000-8000-000000000001",
            runId: "54100000-0000-4000-8000-000000000002",
            status: "queued",
            stage: "queued",
            photoIdentity: input.photoIdentity,
            photos: input.photoReceipts.map(
              ({ ordinal, contentSha256, byteLength, mediaType }) => ({
                ordinal,
                contentSha256,
                byteLength,
                mediaType,
              }),
            ),
            voiceContext:
              voice === null
                ? null
                : {
                    version: voice.version,
                    contentSha256: voice.contentSha256,
                    byteLength: voice.byteLength,
                    durationMs: voice.durationMs,
                    mediaType: voice.mediaType,
                  },
          } as MobileItemSubmissionReceipt,
        };
        queueMessages += 1;
        return { outcome: "created", receipt: committed.receipt };
      },
    };
    const base = createMobileItemSubmissionOperations({
      resolvePrincipal: vi.fn(async (bearerToken) => ({
        kind: "clerk" as const,
        userId: "user_voice_replay",
        bearerToken,
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
      })),
      staging,
    });
    let loseFirstResponse = true;
    const handler = createMobileItemSubmissionHandler({
      requestId: () => "req_voice_replay",
      itemSubmission: {
        resolvePrincipal: base.resolvePrincipal,
        async submit(input) {
          const result = await base.submit(input);
          if (loseFirstResponse) {
            loseFirstResponse = false;
            throw new Error("response lost after commit");
          }
          return result;
        },
      },
    });
    const wav = fixedWavBytes();
    const request = () => {
      const body = new FormData();
      for (let ordinal = 0; ordinal < 5; ordinal += 1) {
        body.append(
          "photo",
          new File([
            new Uint8Array([...JPEG, ordinal]).buffer,
          ], `photo-${ordinal}.jpg`, { type: "image/jpeg" }),
        );
      }
      body.append(
        "voiceContext",
        new File(
          [Uint8Array.from(wav).buffer],
          "seller-context.wav",
          { type: "audio/wav" },
        ),
      );
      body.append("voiceContextLocale", "EN-us");
      return new Request("http://localhost/v1/items/runs", {
        method: "POST",
        headers: {
          authorization: "Bearer signed-clerk-jwt",
          "idempotency-key": "54100000-0000-4000-8000-000000000003",
        },
        body,
      });
    };

    expect((await handler(request())).status).toBe(503);
    const replay = await handler(request());
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      data: {
        itemId: "54100000-0000-4000-8000-000000000001",
        runId: "54100000-0000-4000-8000-000000000002",
        photos: [
          { ordinal: 0 },
          { ordinal: 1 },
          { ordinal: 2 },
          { ordinal: 3 },
          { ordinal: 4 },
        ],
        voiceContext: {
          version: 1,
          byteLength: wav.byteLength,
          durationMs: 10,
          mediaType: "audio/wav",
          contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      },
    });
    expect(queueMessages).toBe(1);
    expect(objects.size).toBe(6);
  });

  it("continues bounded-invalid voice as photo-only with a null receipt", async () => {
    const submit = vi.fn(async (
      input: Parameters<ReturnType<
        typeof createMobileItemSubmissionOperations
      >["submit"]>[0],
    ) => ({
      outcome: "created" as const,
      receipt: {
        itemId: "54110000-0000-4000-8000-000000000001",
        runId: "54110000-0000-4000-8000-000000000002",
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
      requestId: () => "req_invalid_voice",
      itemSubmission: {
        async resolvePrincipal(bearerToken) {
          return { kind: "clerk", userId: "user_541", bearerToken };
        },
        submit,
      },
    });
    const request = (duplicate: "none" | "voice" | "locale" = "none") => {
      const body = new FormData();
      body.append(
        "photo",
        new File([JPEG], "front.jpg", { type: "image/jpeg" }),
      );
      body.append(
        "voiceContext",
        new File(
          [new Uint8Array([0x52, 0x49, 0x46, 0x46]).buffer],
          "invalid.wav",
          { type: "audio/wav" },
        ),
      );
      body.append("voiceContextLocale", "en-US");
      if (duplicate === "voice") {
        body.append(
          "voiceContext",
          new File(
            [Uint8Array.from(fixedWavBytes()).buffer],
            "second.wav",
            { type: "audio/wav" },
          ),
        );
      }
      if (duplicate === "locale") {
        body.append("voiceContextLocale", "fr-FR");
      }
      return new Request("http://localhost/v1/items/runs", {
        method: "POST",
        headers: {
          authorization: "Bearer signed-clerk-jwt",
          "idempotency-key": crypto.randomUUID(),
        },
        body,
      });
    };

    const response = await handler(request());
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      data: { voiceContext: null },
    });
    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0][0].voice).toBeNull();
    expect((await handler(request("voice"))).status).toBe(400);
    expect((await handler(request("locale"))).status).toBe(400);
    expect(submit).toHaveBeenCalledOnce();
  });

  it("conflicts when accepted voice bytes or canonical locale change under one key", async () => {
    let committed:
      | { fingerprint: string; receipt: MobileItemSubmissionReceipt }
      | undefined;
    let queueMessages = 0;
    const handler = createMobileItemSubmissionHandler({
      requestId: () => "req_changed_voice",
      itemSubmission: {
        async resolvePrincipal(bearerToken) {
          return { kind: "clerk", userId: "user_541", bearerToken };
        },
        async submit(input) {
          if (committed) {
            if (committed.fingerprint !== input.requestFingerprint) {
              throw new MobileItemSubmissionConflictError();
            }
            return { outcome: "replayed", receipt: committed.receipt };
          }
          const voice = input.voice;
          committed = {
            fingerprint: input.requestFingerprint,
            receipt: {
              itemId: "54120000-0000-4000-8000-000000000001",
              runId: "54120000-0000-4000-8000-000000000002",
              status: "queued",
              stage: "queued",
              photoIdentity: {
                kind: "content_sha256_set_v1",
                fingerprint: "b".repeat(64),
              },
              photos: input.photos.map(
                ({ ordinal, contentSha256, byteLength, mediaType }) => ({
                  ordinal,
                  contentSha256,
                  byteLength,
                  mediaType,
                }),
              ),
              voiceContext:
                voice === null
                  ? null
                  : {
                      version: voice.version,
                      contentSha256: voice.contentSha256,
                      byteLength: voice.byteLength,
                      durationMs: voice.durationMs,
                      mediaType: voice.mediaType,
                    },
            },
          };
          queueMessages += 1;
          return { outcome: "created", receipt: committed.receipt };
        },
      },
    });
    const key = "54120000-0000-4000-8000-000000000003";
    const request = (sampleSeed: number, locale: string) => {
      const body = new FormData();
      body.append(
        "photo",
        new File([JPEG], "front.jpg", { type: "image/jpeg" }),
      );
      body.append(
        "voiceContext",
        new File(
          [Uint8Array.from(fixedWavBytes(sampleSeed)).buffer],
          "seller-context.wav",
          { type: "audio/wav" },
        ),
      );
      body.append("voiceContextLocale", locale);
      return new Request("http://localhost/v1/items/runs", {
        method: "POST",
        headers: {
          authorization: "Bearer signed-clerk-jwt",
          "idempotency-key": key,
        },
        body,
      });
    };

    expect((await handler(request(1, "EN-us"))).status).toBe(202);
    expect((await handler(request(1, "en-US"))).status).toBe(200);
    expect((await handler(request(2, "en-US"))).status).toBe(409);
    expect((await handler(request(1, "fr-FR"))).status).toBe(409);
    expect(queueMessages).toBe(1);
  });

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
          voiceContext: null,
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
    body.append("recoveryId", "33210000-0000-4000-8000-000000000002");
    body.append("recoveryTokenHash", "f".repeat(64));
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
              voiceContext: null,
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
      body.append("recoveryId", "33200000-0000-4000-8000-000000000021");
      body.append("recoveryTokenHash", "f".repeat(64));
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
