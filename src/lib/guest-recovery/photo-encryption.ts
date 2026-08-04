import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";

const PHOTO_MAGIC = Buffer.from("SGLRPHO1", "ascii");
const PHOTO_NONCE_BYTES = 12;
const PHOTO_TAG_BYTES = 16;

const mediaTypeCodes = {
  "image/jpeg": 1,
  "image/png": 2,
  "image/webp": 3,
} as const;

type GuestRecoveryPhotoMediaType = keyof typeof mediaTypeCodes;
const mediaTypesByCode = new Map<number, GuestRecoveryPhotoMediaType>(
  Object.entries(mediaTypeCodes).map(([mediaType, code]) => [
    code,
    mediaType as GuestRecoveryPhotoMediaType,
  ]),
);

const RECOVERY_PHOTO_PATH =
  /^guest_[0-9a-f]{48}\/guest-recovery\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/([0-4])-[0-9a-f]{24}\.enc$/;
const recoveryPhotoPathSchema = z.string().regex(RECOVERY_PHOTO_PATH);

function pathIdentity(path: string): { ordinal: number; recoveryId: string } {
  const parsed = recoveryPhotoPathSchema.safeParse(path);
  const match = parsed.success ? parsed.data.match(RECOVERY_PHOTO_PATH) : null;
  if (!match) throw new Error("Guest recovery photo path is invalid.");
  return { ordinal: Number(match[2]), recoveryId: match[1]! };
}

function hmac(key: Uint8Array, label: string): Buffer {
  return createHmac("sha256", key).update(label, "utf8").digest();
}

function dataKey(masterKey: Uint8Array, recoveryId: string): Buffer {
  return hmac(
    masterKey,
    `snaplist:guest-recovery:data-key:v1:${recoveryId}`,
  );
}

function photoAAD(recoveryId: string, ordinal: number): Buffer {
  return Buffer.from(
    `snaplist:guest-recovery:photo:v1:${recoveryId}:${ordinal}`,
    "utf8",
  );
}

function requireMasterKey(key: Uint8Array): void {
  if (key.byteLength !== 32) {
    throw new Error("Guest recovery photo key is invalid.");
  }
}

export function parseGuestRecoveryProducerEncryptionConfig(input: {
  encodedKey: string | undefined;
  keyId: string | undefined;
}): { keyId: string; masterKey: Uint8Array } {
  const encodedKey = input.encodedKey?.trim();
  const keyId = input.keyId?.trim();
  const key = encodedKey ? Buffer.from(encodedKey, "base64") : Buffer.alloc(0);
  if (
    !encodedKey
    || key.toString("base64") !== encodedKey
    || key.byteLength !== 32
    || !keyId
    || !/^[A-Za-z0-9_-]{1,128}$/.test(keyId)
  ) {
    throw new Error("Guest recovery encryption is not configured.");
  }
  return { keyId, masterKey: Uint8Array.from(key) };
}

/** Produces the private Storage envelope; plaintext consumption is owned by #640. */
export function encryptGuestRecoveryPhotoEnvelope(input: {
  bytes: Uint8Array;
  masterKey: Uint8Array;
  mediaType: string;
  nonce: Uint8Array;
  path: string;
}): { envelope: Uint8Array; nonce: Uint8Array; tag: Uint8Array } {
  requireMasterKey(input.masterKey);
  const { ordinal, recoveryId } = pathIdentity(input.path);
  const mediaCode = mediaTypeCodes[input.mediaType as GuestRecoveryPhotoMediaType];
  if (!mediaCode || input.nonce.byteLength !== PHOTO_NONCE_BYTES) {
    throw new Error("Guest recovery photo envelope is invalid.");
  }
  const cipher = createCipheriv(
    "aes-256-gcm",
    dataKey(input.masterKey, recoveryId),
    input.nonce,
  );
  cipher.setAAD(photoAAD(recoveryId, ordinal));
  const ciphertext = Buffer.concat([
    cipher.update(input.bytes),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    envelope: Uint8Array.from(Buffer.concat([
      PHOTO_MAGIC,
      Buffer.from([mediaCode]),
      Buffer.from(input.nonce),
      tag,
      ciphertext,
    ])),
    nonce: Uint8Array.from(input.nonce),
    tag: Uint8Array.from(tag.subarray(0, PHOTO_TAG_BYTES)),
  };
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

/** Consumes one producer envelope before account-owned Storage is written. */
export function decryptGuestRecoveryPhotoEnvelope(input: {
  envelope: Uint8Array;
  expectedNonce: Uint8Array;
  expectedTag: Uint8Array;
  masterKey: Uint8Array;
  path: string;
}): { bytes: Uint8Array; mediaType: GuestRecoveryPhotoMediaType } {
  try {
    requireMasterKey(input.masterKey);
    const { ordinal, recoveryId } = pathIdentity(input.path);
    const envelope = Buffer.from(input.envelope);
    const headerLength = PHOTO_MAGIC.byteLength + 1 + PHOTO_NONCE_BYTES
      + PHOTO_TAG_BYTES;
    if (
      envelope.byteLength <= headerLength
      || !equalBytes(envelope.subarray(0, PHOTO_MAGIC.byteLength), PHOTO_MAGIC)
    ) {
      throw new Error();
    }

    const mediaType = mediaTypesByCode.get(envelope[PHOTO_MAGIC.byteLength]!);
    const nonceOffset = PHOTO_MAGIC.byteLength + 1;
    const tagOffset = nonceOffset + PHOTO_NONCE_BYTES;
    const ciphertextOffset = tagOffset + PHOTO_TAG_BYTES;
    const nonce = envelope.subarray(nonceOffset, tagOffset);
    const tag = envelope.subarray(tagOffset, ciphertextOffset);
    if (
      !mediaType
      || !equalBytes(nonce, input.expectedNonce)
      || !equalBytes(tag, input.expectedTag)
    ) {
      throw new Error();
    }

    const decipher = createDecipheriv(
      "aes-256-gcm",
      dataKey(input.masterKey, recoveryId),
      nonce,
    );
    decipher.setAAD(photoAAD(recoveryId, ordinal));
    decipher.setAuthTag(tag);
    return {
      bytes: Uint8Array.from(Buffer.concat([
        decipher.update(envelope.subarray(ciphertextOffset)),
        decipher.final(),
      ])),
      mediaType,
    };
  } catch {
    throw new Error("Guest recovery photo envelope is invalid.");
  }
}
