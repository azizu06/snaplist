import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { encryptGuestRecoveryPhotoEnvelope } from "./photo-encryption";
import { createSupabaseGuestClaimStorage } from "./storage";

const recoveryId = "64000000-0000-4000-8000-000000000001";
const sourcePath = `guest_${"a".repeat(48)}/guest-recovery/${recoveryId}/0-${"b".repeat(24)}.enc`;
const destinationPath = `user_account/guest-claims/${recoveryId}/${"c".repeat(36)}/1`;
const masterKey = new Uint8Array(32).fill(7);
const plaintext = new TextEncoder().encode("plaintext-photo");
const encrypted = encryptGuestRecoveryPhotoEnvelope({
  bytes: plaintext,
  masterKey,
  mediaType: "image/jpeg",
  nonce: new Uint8Array(12).fill(3),
  path: sourcePath,
});
const object = {
  sourcePath,
  destinationPath,
  sha256: createHash("sha256").update(encrypted.envelope).digest("hex"),
  byteLength: encrypted.envelope.byteLength,
  encryption: {
    algorithm: "aes-256-gcm" as const,
    keyId: "guest-recovery-v1",
    nonce: Buffer.from(encrypted.nonce).toString("base64"),
    tag: Buffer.from(encrypted.tag).toString("base64"),
  },
};

function client(input: {
  source?: Uint8Array;
  destination?: Uint8Array;
  destinationType?: string;
  uploadError?: { message: string } | null;
}) {
  let uploaded: { bytes: Uint8Array; type: string } | undefined;
  const upload = vi.fn(async (
    _path: string,
    bytes: ArrayBuffer,
    options: { contentType: string },
  ) => {
    if (!input.uploadError) {
      uploaded = { bytes: new Uint8Array(bytes), type: options.contentType };
    }
    return { data: input.uploadError ? null : {}, error: input.uploadError ?? null };
  });
  const download = vi.fn(async (path: string) => {
    if (path === sourcePath) {
      return {
        data: new Blob([Buffer.from(input.source ?? encrypted.envelope)], {
          type: "application/octet-stream",
        }),
        error: null,
      };
    }
    const bytes = input.destination ?? uploaded?.bytes;
    return {
      data: bytes
        ? new Blob([Buffer.from(bytes)], {
          type: input.destinationType ?? uploaded?.type ?? "image/jpeg",
        })
        : null,
      error: null,
    };
  });
  const remove = vi.fn().mockResolvedValue({ data: [], error: null });
  return {
    client: { storage: { from: vi.fn(() => ({ download, upload, remove })) } },
    download,
    remove,
    upload,
  };
}

describe("claimed guest recovery Storage verification", () => {
  it("accepts exact plaintext left by an interrupted retry", async () => {
    const fake = client({
      destination: plaintext,
      uploadError: { message: "The resource already exists" },
    });
    const storage = createSupabaseGuestClaimStorage(
      fake.client,
      { keyFor: () => masterKey },
    );

    await expect(storage.copyAndVerify(object)).resolves.toMatchObject({
      destinationPath,
      plaintextByteLength: plaintext.byteLength,
      mediaType: "image/jpeg",
    });
  });

  it("removes mismatched destination plaintext and never returns a receipt", async () => {
    const fake = client({ destination: new TextEncoder().encode("wrong") });
    const storage = createSupabaseGuestClaimStorage(
      fake.client,
      { keyFor: () => masterKey },
    );

    await expect(storage.copyAndVerify(object)).rejects.toThrow(
      /destination verification failed/i,
    );
    expect(fake.remove).toHaveBeenCalledWith([destinationPath]);
  });

  it("rejects altered source ciphertext before writing account Storage", async () => {
    const fake = client({ source: new TextEncoder().encode("wrong") });
    const storage = createSupabaseGuestClaimStorage(
      fake.client,
      { keyFor: () => masterKey },
    );

    await expect(storage.copyAndVerify(object)).rejects.toThrow(
      /source verification failed/i,
    );
    expect(fake.upload).not.toHaveBeenCalled();
  });
});
