import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PipelineResult } from "@/lib/pipeline";
import type { PipelineWorkerContext } from "@/lib/pipeline-queue/worker-store";
import { createGuestRecoveryRegistrationProducer } from "./producer";

const RUN_ID = "63800000-0000-4000-8000-000000000001";
const ITEM_ID = "63800000-0000-4000-8000-000000000002";
const RECOVERY_ID = "63800000-0000-4000-8000-000000000003";
const RAW_TOKEN = "raw-token-that-must-stay-in-the-native-keychain";

const result = {
  attributes: { brand: "Sony", model: "WH-1000XM5" },
  price: {
    suggested: 180,
    range: { min: 160, max: 205 },
    confidence: 0.7,
    sources: [],
    tier: "llm-only",
    evidence: [],
  },
  confidence: { score: 0.7, band: "high", autopilotEligible: false },
  listing: {
    platform: "ebay",
    title: "Sony WH-1000XM5 Headphones",
    description: "Seller-owned draft.",
    fields: {},
  },
  model: "vision-model",
  listingModel: "listing-model",
} satisfies PipelineResult;

function guestContext(): PipelineWorkerContext {
  return {
    run: {
      id: RUN_ID,
      user_id: "guest_0123456789abcdef0123456789abcdef0123456789abcdef",
      item_id: ITEM_ID,
      listing_id: null,
      status: "running",
      stage: "generating",
      schema_version: 1,
      attempt_count: 1,
      max_attempts: 3,
      autopilot_enabled: false,
      checkpoint: {},
      lease_token: "63800000-0000-4000-8000-000000000004",
      lease_expires_at: "2026-08-04T12:00:00.000Z",
      next_attempt_at: null,
      recovery_id: RECOVERY_ID,
      recovery_token_hash: createHash("sha256").update(RAW_TOKEN).digest("hex"),
    },
    item: {
      id: ITEM_ID,
      user_id: "guest_0123456789abcdef0123456789abcdef0123456789abcdef",
      photos: ["guest/raw/front.jpg", "guest/raw/back.jpg"],
      photo_identity_kind: "content_sha256_set_v1",
      photo_identity_fingerprint: "a".repeat(64),
      attributes: {},
      condition: null,
      cost_basis: null,
      review_revision: "63800000-0000-4000-8000-000000000005",
      review_content_revision: "63800000-0000-4000-8000-000000000006",
    },
  };
}

describe("guest recovery registration producer", () => {
  it("encrypts the immutable guest photo set deterministically and exposes hashes only", async () => {
    const objects = new Map<string, { bytes: Uint8Array; mediaType: string }>([
      ["guest/raw/front.jpg", { bytes: new Uint8Array([1, 2, 3]), mediaType: "image/jpeg" }],
      ["guest/raw/back.jpg", { bytes: new Uint8Array([4, 5, 6, 7]), mediaType: "image/jpeg" }],
    ]);
    const upload = vi.fn(async (path: string, bytes: Uint8Array) => {
      if (objects.has(path)) throw new Error("object already exists");
      objects.set(path, { bytes: Uint8Array.from(bytes), mediaType: "application/octet-stream" });
    });
    const stageUploadCleanup = vi.fn(async () => undefined);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const producer = createGuestRecoveryRegistrationProducer({
      keyId: "guest-recovery-key-v1",
      masterKey: new Uint8Array(32).fill(7),
      storage: {
        async download(path) {
          const object = objects.get(path);
          if (!object) throw new Error("missing object");
          return object;
        },
        upload,
      },
    });

    const first = await producer.prepare({
      context: guestContext(),
      result,
      stageUploadCleanup,
    });
    const second = await producer.prepare({
      context: guestContext(),
      result,
      stageUploadCleanup,
    });

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      recoveryId: RECOVERY_ID,
      pipelineRunId: RUN_ID,
      recoveryTokenHash: createHash("sha256").update(RAW_TOKEN).digest("hex"),
      encryptedArtifact: {
        algorithm: "aes-256-gcm",
        keyId: "guest-recovery-key-v1",
        version: 1,
      },
      storageManifest: [
        { byteLength: expect.any(Number), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
        { byteLength: expect.any(Number), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
      ],
    });
    expect(first?.storageManifest.map(({ sourcePath }) => sourcePath)).toEqual([
      expect.stringMatching(new RegExp(`guest-recovery/${RECOVERY_ID}/0-.*\\.enc$`)),
      expect.stringMatching(new RegExp(`guest-recovery/${RECOVERY_ID}/1-.*\\.enc$`)),
    ]);
    for (const [ordinal, object] of first!.storageManifest.entries()) {
      const stored = objects.get(object.sourcePath);
      expect(stored).toBeDefined();
      expect(createHash("sha256").update(stored!.bytes).digest("hex")).toBe(
        object.sha256,
      );
      expect(stored!.bytes.byteLength).toBe(
        objects.get(guestContext().item.photos[ordinal]!)!.bytes.byteLength + 37,
      );
      expect(Buffer.from(stored!.bytes.subarray(0, 8)).toString("ascii"))
        .toBe("SGLRPHO1");
    }
    expect(JSON.stringify(first)).not.toContain(RAW_TOKEN);
    expect(JSON.stringify(consoleLog.mock.calls)).not.toContain(RAW_TOKEN);
    expect(stageUploadCleanup).toHaveBeenCalledTimes(2);
    expect(stageUploadCleanup).toHaveBeenCalledWith(first?.storageManifest.map(
      ({ sourcePath }) => sourcePath,
    ));
    expect(stageUploadCleanup.mock.invocationCallOrder[0]).toBeLessThan(
      upload.mock.invocationCallOrder[0]!,
    );
    expect(upload).toHaveBeenCalledTimes(4);
    consoleLog.mockRestore();
  });

  it("does no recovery work for an authenticated run", async () => {
    const context = guestContext();
    context.run.user_id = "user_clerk_638";
    context.item.user_id = "user_clerk_638";
    context.run.recovery_id = null;
    context.run.recovery_token_hash = null;
    const storage = {
      download: vi.fn(),
      upload: vi.fn(),
    };
    const producer = createGuestRecoveryRegistrationProducer({
      keyId: "guest-recovery-key-v1",
      masterKey: new Uint8Array(32).fill(7),
      storage,
    });

    const stageUploadCleanup = vi.fn();
    await expect(producer.prepare({
      context,
      result,
      stageUploadCleanup,
    })).resolves.toBeNull();
    expect(stageUploadCleanup).not.toHaveBeenCalled();
    expect(storage.download).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it("establishes durable cleanup authority before a partial upload can fail", async () => {
    const context = guestContext();
    const stageUploadCleanup = vi.fn(async () => undefined);
    const uploaded = new Map<string, Uint8Array>();
    const upload = vi.fn(async (path: string, bytes: Uint8Array) => {
      uploaded.set(path, Uint8Array.from(bytes));
    });
    const producer = createGuestRecoveryRegistrationProducer({
      keyId: "guest-recovery-key-v1",
      masterKey: new Uint8Array(32).fill(7),
      storage: {
        async download(path) {
          const ciphertext = uploaded.get(path);
          if (ciphertext) {
            return {
              bytes: ciphertext,
              mediaType: "application/octet-stream",
            };
          }
          if (path === context.item.photos[1]) {
            throw new Error("second source unavailable");
          }
          return {
            bytes: new Uint8Array([1, 2, 3]),
            mediaType: "image/jpeg",
          };
        },
        upload,
      },
    });

    await expect(producer.prepare({
      context,
      result,
      stageUploadCleanup,
    })).rejects.toThrow("second source unavailable");

    expect(stageUploadCleanup).toHaveBeenCalledTimes(1);
    expect(stageUploadCleanup.mock.invocationCallOrder[0]).toBeLessThan(
      upload.mock.invocationCallOrder[0]!,
    );
    expect(upload).toHaveBeenCalledTimes(1);
  });
});
