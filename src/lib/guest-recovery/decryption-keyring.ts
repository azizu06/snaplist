import { z } from "zod";

const keyIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const encodedKeySchema = z.string().min(1);
const retiredKeysSchema = z.record(keyIdSchema, encodedKeySchema);

export interface GuestRecoveryDecryptionKeyring {
  keyFor(keyId: string): Uint8Array;
}

function decodeKey(encodedKey: string): Uint8Array {
  const key = Buffer.from(encodedKey, "base64");
  if (key.byteLength !== 32 || key.toString("base64") !== encodedKey) {
    throw new Error("Guest recovery decryption keyring is invalid.");
  }
  return Uint8Array.from(key);
}

export function parseGuestRecoveryDecryptionKeyringConfig(input: {
  activeEncodedKey: string | undefined;
  activeKeyId: string | undefined;
  encodedRetiredKeys?: string | undefined;
}): GuestRecoveryDecryptionKeyring {
  const activeKeyId = keyIdSchema.safeParse(input.activeKeyId?.trim());
  const activeEncodedKey = input.activeEncodedKey?.trim();
  if (!activeKeyId.success || !activeEncodedKey) {
    throw new Error("Guest recovery decryption keyring is not configured.");
  }

  let retiredKeys: z.infer<typeof retiredKeysSchema> = {};
  if (input.encodedRetiredKeys?.trim()) {
    try {
      retiredKeys = retiredKeysSchema.parse(
        JSON.parse(input.encodedRetiredKeys),
      );
    } catch {
      throw new Error("Guest recovery decryption keyring is invalid.");
    }
  }
  if (Object.hasOwn(retiredKeys, activeKeyId.data)) {
    throw new Error("Guest recovery decryption keyring is invalid.");
  }

  const keys = new Map<string, Uint8Array>([
    [activeKeyId.data, decodeKey(activeEncodedKey)],
    ...Object.entries(retiredKeys).map(
      ([keyId, encodedKey]) => [keyId, decodeKey(encodedKey)] as const,
    ),
  ]);

  return {
    keyFor(rawKeyId) {
      const keyId = keyIdSchema.parse(rawKeyId);
      const key = keys.get(keyId);
      if (!key) {
        throw new Error("Guest recovery decryption key is unavailable.");
      }
      return Uint8Array.from(key);
    },
  };
}
