import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret, parseEncryptionKey } from "./secretbox";

describe("secretbox", () => {
  const key = randomBytes(32);

  it("round-trips a token", () => {
    const token = "v^1.1#i^1#p^3#fake-ebay-refresh-token";
    expect(decryptSecret(encryptSecret(token, key), key)).toBe(token);
  });

  it("produces a fresh IV per encryption (no deterministic ciphertexts)", () => {
    expect(encryptSecret("same", key)).not.toBe(encryptSecret("same", key));
  });

  it("rejects tampered ciphertext (GCM integrity)", () => {
    const payload = encryptSecret("secret", key);
    const parts = payload.split(".");
    // flip a character in the ciphertext segment
    parts[2] = parts[2].slice(0, -1) + (parts[2].endsWith("A") ? "B" : "A");
    expect(() => decryptSecret(parts.join("."), key)).toThrow();
  });

  it("rejects the wrong key", () => {
    const payload = encryptSecret("secret", key);
    expect(() => decryptSecret(payload, randomBytes(32))).toThrow();
  });

  it("rejects unknown payload formats loudly", () => {
    expect(() => decryptSecret("v2.a.b.c", key)).toThrow(/format/i);
    expect(() => decryptSecret("not-a-payload", key)).toThrow(/format/i);
  });

  describe("parseEncryptionKey", () => {
    it("accepts a 32-byte base64 key", () => {
      const raw = randomBytes(32).toString("base64");
      expect(parseEncryptionKey(raw)).toHaveLength(32);
    });

    it("explains how to generate a key when missing or wrong-sized", () => {
      expect(() => parseEncryptionKey(undefined)).toThrow(/openssl rand/);
      expect(() => parseEncryptionKey(randomBytes(16).toString("base64"))).toThrow(
        /32 bytes/,
      );
    });
  });
});
