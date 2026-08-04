import { describe, expect, it } from "vitest";
import {
  decryptGuestRecoveryPhotoEnvelope,
  encryptGuestRecoveryPhotoEnvelope,
} from "./photo-encryption";

const RECOVERY_ID = "63800000-0000-4000-8000-000000000003";
const PATH = `guest_${"a".repeat(48)}/guest-recovery/${RECOVERY_ID}/0-${"b".repeat(24)}.enc`;
const MASTER_KEY = new Uint8Array(32).fill(7);

describe("guest recovery photo producer encryption", () => {
  it("matches the path-bound authenticated envelope vector", () => {
    const encrypted = encryptGuestRecoveryPhotoEnvelope({
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0x01]),
      masterKey: MASTER_KEY,
      mediaType: "image/jpeg",
      nonce: new Uint8Array(12).fill(3),
      path: PATH,
    });

    expect(Buffer.from(encrypted.envelope).toString("hex")).toBe(
      "53474c5250484f3101030303030303030303030303"
      + "aa298ee2d78760b0877c6a20d40d3000ed8d892d",
    );
    expect(encrypted.envelope.byteLength).toBe(4 + 37);

    const foreignOrdinal = encryptGuestRecoveryPhotoEnvelope({
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0x01]),
      masterKey: MASTER_KEY,
      mediaType: "image/jpeg",
      nonce: new Uint8Array(12).fill(3),
      path: PATH.replace("/0-", "/1-"),
    });
    expect(foreignOrdinal.tag).not.toEqual(encrypted.tag);
  });

  it("returns the original photo bytes and media type only with the bound key and path", () => {
    const plaintext = new Uint8Array([0xff, 0xd8, 0xff, 0x01]);
    const encrypted = encryptGuestRecoveryPhotoEnvelope({
      bytes: plaintext,
      masterKey: MASTER_KEY,
      mediaType: "image/jpeg",
      nonce: new Uint8Array(12).fill(3),
      path: PATH,
    });

    expect(decryptGuestRecoveryPhotoEnvelope({
      envelope: encrypted.envelope,
      expectedNonce: encrypted.nonce,
      expectedTag: encrypted.tag,
      masterKey: MASTER_KEY,
      path: PATH,
    })).toEqual({ bytes: plaintext, mediaType: "image/jpeg" });
    expect(() => decryptGuestRecoveryPhotoEnvelope({
      envelope: encrypted.envelope,
      expectedNonce: encrypted.nonce,
      expectedTag: encrypted.tag,
      masterKey: MASTER_KEY,
      path: PATH.replace("/0-", "/1-"),
    })).toThrow(/invalid/i);
  });
});
