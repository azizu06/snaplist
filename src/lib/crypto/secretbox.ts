import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Authenticated secret encryption for per-user eBay OAuth tokens (issue #17).
 *
 * AES-256-GCM with a random 12-byte IV per encryption. The wire format is
 * `v1.<iv>.<ciphertext>.<tag>` (base64url segments) so the version can rotate
 * the scheme later without a migration scanning ciphertexts.
 *
 * The key comes from `EBAY_TOKEN_ENCRYPTION_KEY` (base64, exactly 32 bytes
 * decoded) and is read lazily per call — importing this module never throws in
 * environments without the key (tests, CI, fresh checkouts), matching the
 * adapter's lazy-credential convention.
 *
 * GCM gives integrity, not just secrecy: a tampered ciphertext or a wrong key
 * fails decryption loudly instead of yielding garbage tokens that would then
 * be sent to eBay.
 */

const VERSION = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;

/** Parse + validate the base64 key material. Exported for the connect route's preflight. */
export function parseEncryptionKey(raw: string | undefined): Buffer {
  if (!raw) {
    throw new Error(
      "EBAY_TOKEN_ENCRYPTION_KEY is not set. Generate one with " +
        "`openssl rand -base64 32` and set it in the environment.",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `EBAY_TOKEN_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes ` +
        `(got ${key.length}). Generate one with \`openssl rand -base64 32\`.`,
    );
  }
  return key;
}

export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    tag.toString("base64url"),
  ].join(".");
}

export function decryptSecret(payload: string, key: Buffer): string {
  const [version, ivB64, ciphertextB64, tagB64, ...rest] = payload.split(".");
  if (version !== VERSION || !ivB64 || !ciphertextB64 || !tagB64 || rest.length > 0) {
    throw new Error(`Unrecognized secret payload format (expected ${VERSION}.iv.ct.tag).`);
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
