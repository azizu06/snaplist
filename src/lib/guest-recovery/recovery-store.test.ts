import { describe, expect, it, vi } from "vitest";
import {
  createSupabaseGuestRecoveryStore,
  guestRecoveryStorageManifestSchema,
} from "./recovery-store";

const encryptedArtifact = {
  version: 1 as const,
  algorithm: "aes-256-gcm" as const,
  keyId: "guest-recovery-v1",
  keyEnvelope: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
  nonce: "AgICAgICAgICAgIC",
  tag: "AwMDAwMDAwMDAwMDAwMDAw==",
  ciphertext: "ZW5jcnlwdGVkLWRyYWZ0",
};
const storageManifest = [{
  sourcePath: "guest_fixture/item/front.enc",
  sha256: "a".repeat(64),
  byteLength: 128,
  encryption: {
    algorithm: "aes-256-gcm" as const,
    keyId: encryptedArtifact.keyId,
    nonce: Buffer.alloc(12, 4).toString("base64"),
    tag: Buffer.alloc(16, 5).toString("base64"),
  },
}];

describe("guest encrypted recovery fixed-RPC store", () => {
  it("accepts five ordered encrypted Storage objects for durable guest recovery", () => {
    const manifest = Array.from({ length: 5 }, (_, ordinal) => ({
      ...storageManifest[0],
      sourcePath: `guest_fixture/item/photo-${ordinal}.enc`,
      sha256: ordinal.toString(16).repeat(64),
      encryption: {
        ...storageManifest[0].encryption,
        nonce: Buffer.alloc(12, ordinal + 10).toString("base64"),
        tag: Buffer.alloc(16, ordinal + 20).toString("base64"),
      },
    }));

    expect(guestRecoveryStorageManifestSchema.parse(manifest)).toEqual(manifest);
  });

  it("accepts a 50 MiB photo plus its 37-byte encryption envelope", () => {
    const boundaryObject = {
      ...storageManifest[0],
      byteLength: 50 * 1_024 * 1_024 + 37,
    };

    expect(guestRecoveryStorageManifestSchema.safeParse([boundaryObject]).success).toBe(true);
    expect(guestRecoveryStorageManifestSchema.safeParse([{
      ...boundaryObject,
      byteLength: boundaryObject.byteLength + 1,
    }]).success).toBe(false);
  });

  it("rejects an unlabeled Storage object as recoverable ciphertext", () => {
    expect(guestRecoveryStorageManifestSchema.safeParse([{
      sourcePath: "guest_fixture/item/front.enc",
      sha256: "a".repeat(64),
      byteLength: 128,
    }]).success).toBe(false);
  });

  it("rejects AES-GCM nonce reuse across public recovery descriptors", async () => {
    expect(guestRecoveryStorageManifestSchema.safeParse([
      storageManifest[0],
      {
        ...storageManifest[0],
        sourcePath: "guest_fixture/item/back.enc",
        sha256: "c".repeat(64),
      },
    ]).success).toBe(false);

    const rpc = vi.fn();
    const store = createSupabaseGuestRecoveryStore({ rpc });
    await expect(store.register({
      recoveryId: "11111111-1111-4111-8111-111111111111",
      guestUserId: "guest_fixture",
      pipelineRunId: "33333333-3333-4333-8333-333333333333",
      recoveryTokenHash: "b".repeat(64),
      encryptedArtifact,
      storageManifest: [{
        ...storageManifest[0],
        encryption: {
          ...storageManifest[0].encryption,
          nonce: encryptedArtifact.nonce,
        },
      }],
    })).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects Storage ciphertext that is not tied to the recovery key envelope", async () => {
    const rpc = vi.fn();
    const store = createSupabaseGuestRecoveryStore({ rpc });

    await expect(store.register({
      recoveryId: "11111111-1111-4111-8111-111111111111",
      guestUserId: "guest_fixture",
      pipelineRunId: "33333333-3333-4333-8333-333333333333",
      recoveryTokenHash: "b".repeat(64),
      encryptedArtifact,
      storageManifest: [{
        ...storageManifest[0],
        encryption: {
          ...storageManifest[0].encryption,
          keyId: "different-key-envelope",
        },
      }],
    })).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("registers against a durable run without accepting a device clock or TTL", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        outcome: "recoverable",
        recoveryId: "11111111-1111-4111-8111-111111111111",
        itemId: "22222222-2222-4222-8222-222222222222",
        runId: "33333333-3333-4333-8333-333333333333",
        draftId: "44444444-4444-4444-8444-444444444444",
        usableDraftAt: "2026-07-17T12:00:00.000Z",
        expiresAt: "2026-07-18T12:00:00.000Z",
        encryptedArtifact,
        purgeLocalRecovery: false,
      },
      error: null,
    });
    const store = createSupabaseGuestRecoveryStore({ rpc });

    await store.register({
      recoveryId: "11111111-1111-4111-8111-111111111111",
      guestUserId: "guest_fixture",
      pipelineRunId: "33333333-3333-4333-8333-333333333333",
      recoveryTokenHash: "b".repeat(64),
      encryptedArtifact,
      storageManifest,
    });

    expect(rpc).toHaveBeenCalledWith("register_guest_draft_recovery", {
      p_encrypted_artifact: encryptedArtifact,
      p_guest_user_id: "guest_fixture",
      p_pipeline_run_id: "33333333-3333-4333-8333-333333333333",
      p_recovery_id: "11111111-1111-4111-8111-111111111111",
      p_recovery_token_hash: "b".repeat(64),
      p_storage_manifest: storageManifest,
    });
    expect(rpc.mock.calls[0]?.[1]).not.toHaveProperty("p_expires_at");
    expect(rpc.mock.calls[0]?.[1]).not.toHaveProperty("p_usable_draft_at");
  });

  it.each([
    ["malformed Base64", { keyEnvelope: "A" }],
    ["an eleven-byte IV", { nonce: "AgICAgICAgICAgI=" }],
    ["a fifteen-byte authentication tag", { tag: "AwMDAwMDAwMDAwMDAwMD" }],
    ["an empty ciphertext", { ciphertext: "" }],
  ])("rejects %s before registering an unrecoverable artifact", async (_label, change) => {
    const rpc = vi.fn();
    const store = createSupabaseGuestRecoveryStore({ rpc });

    await expect(store.register({
      recoveryId: "11111111-1111-4111-8111-111111111111",
      guestUserId: "guest_fixture",
      pipelineRunId: "33333333-3333-4333-8333-333333333333",
      recoveryTokenHash: "b".repeat(64),
      encryptedArtifact: { ...encryptedArtifact, ...change },
      storageManifest,
    })).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });
});
