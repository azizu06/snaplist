import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { encryptGuestRecoveryPhotoEnvelope } from "./photo-encryption";
import { createSupabaseGuestClaimStorage } from "./storage";

const RECOVERY_ID = "64000000-0000-4000-8000-000000000001";
const SOURCE_PATH = `guest_${"a".repeat(48)}/guest-recovery/${RECOVERY_ID}/0-${"b".repeat(24)}.enc`;
const DESTINATION_PATH = `user_account/guest-claims/${RECOVERY_ID}/${"c".repeat(36)}/1`;
const MASTER_KEY = new Uint8Array(32).fill(7);
const PLAINTEXT = new TextEncoder().encode("plaintext-photo");

describe("claimed guest recovery Storage", () => {
  it("decrypts and verifies plaintext before writing the account-owned object", async () => {
    const encrypted = encryptGuestRecoveryPhotoEnvelope({
      bytes: PLAINTEXT,
      masterKey: MASTER_KEY,
      mediaType: "image/jpeg",
      nonce: new Uint8Array(12).fill(3),
      path: SOURCE_PATH,
    });
    let uploaded: { bytes: Uint8Array; mediaType: string } | undefined;
    const upload = vi.fn(async (
      _path: string,
      bytes: ArrayBuffer,
      options: { contentType: string },
    ) => {
      uploaded = {
        bytes: new Uint8Array(bytes),
        mediaType: options.contentType,
      };
      return { data: {}, error: null };
    });
    const download = vi.fn(async (path: string) => ({
      data: path === SOURCE_PATH
        ? new Blob([Buffer.from(encrypted.envelope)], { type: "application/octet-stream" })
        : uploaded
          ? new Blob([Buffer.from(uploaded.bytes)], { type: uploaded.mediaType })
          : null,
      error: null,
    }));
    const storage = createSupabaseGuestClaimStorage(
      {
        storage: {
          from: vi.fn(() => ({
            copy: vi.fn(),
            download,
            upload,
            remove: vi.fn(async () => ({ data: [], error: null })),
          })),
        },
      },
      { keyFor: () => MASTER_KEY },
    );

    await expect(storage.copyAndVerify({
      sourcePath: SOURCE_PATH,
      destinationPath: DESTINATION_PATH,
      sha256: createHash("sha256").update(encrypted.envelope).digest("hex"),
      byteLength: encrypted.envelope.byteLength,
      encryption: {
        algorithm: "aes-256-gcm",
        keyId: "guest-recovery-v1",
        nonce: Buffer.from(encrypted.nonce).toString("base64"),
        tag: Buffer.from(encrypted.tag).toString("base64"),
      },
    })).resolves.toEqual({
      destinationPath: DESTINATION_PATH,
      sourceSha256: createHash("sha256").update(encrypted.envelope).digest("hex"),
      sourceByteLength: encrypted.envelope.byteLength,
      plaintextSha256: "69a9be924a877f98b80d66b350de7e683bedfa8f2c5bb81d69ecb8871b0aabe1",
      plaintextByteLength: PLAINTEXT.byteLength,
      mediaType: "image/jpeg",
    });
    expect(uploaded).toEqual({ bytes: PLAINTEXT, mediaType: "image/jpeg" });
  });
});
