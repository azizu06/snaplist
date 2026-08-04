import { createHash } from "node:crypto";
import type {
  GuestClaimObject,
  GuestClaimStorage,
  GuestClaimVerifiedObject,
} from "./service";
import type { GuestRecoveryDecryptionKeyring } from "./decryption-keyring";
import { decryptGuestRecoveryPhotoEnvelope } from "./photo-encryption";

interface StorageError {
  message: string;
}

interface GuestStorageBucket {
  download(
    path: string,
  ): Promise<{ data: Blob | null; error: StorageError | null }>;
  upload(
    path: string,
    bytes: ArrayBuffer,
    options: { contentType: string; upsert: false },
  ): Promise<{ data: unknown; error: StorageError | null }>;
  remove(
    paths: string[],
  ): Promise<{ data: unknown; error: StorageError | null }>;
}

export interface GuestStorageClient {
  storage: { from(bucket: "photos"): GuestStorageBucket };
}

function sha256(bytes: ArrayBuffer): string {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

/**
 * Private `photos` bucket capability used only after the database returns an
 * exact source/destination plan. Guest ciphertext is authenticated before one
 * plaintext account object is written and independently read back.
 */
export function createSupabaseGuestClaimStorage(
  client: GuestStorageClient,
  keyring: GuestRecoveryDecryptionKeyring,
): GuestClaimStorage {
  const bucket = client.storage.from("photos");
  return {
    async copyAndVerify(object: GuestClaimObject): Promise<GuestClaimVerifiedObject> {
      const source = await bucket.download(object.sourcePath);
      if (source.error || !source.data) {
        throw new Error("Guest Storage source could not be verified.");
      }
      const sourceBytes = await source.data.arrayBuffer();
      if (
        sourceBytes.byteLength !== object.byteLength
        || sha256(sourceBytes) !== object.sha256
      ) {
        throw new Error("Guest Storage source verification failed.");
      }
      const plaintext = decryptGuestRecoveryPhotoEnvelope({
        envelope: new Uint8Array(sourceBytes),
        expectedNonce: Buffer.from(object.encryption.nonce, "base64"),
        expectedTag: Buffer.from(object.encryption.tag, "base64"),
        masterKey: keyring.keyFor(object.encryption.keyId),
        path: object.sourcePath,
      });
      const plaintextBuffer = plaintext.bytes.buffer.slice(
        plaintext.bytes.byteOffset,
        plaintext.bytes.byteOffset + plaintext.bytes.byteLength,
      ) as ArrayBuffer;
      const plaintextSha256 = sha256(plaintextBuffer);

      // An already-exists error can be an interrupted prior attempt. Read-back
      // verification remains authoritative, so an exact destination is idempotent.
      await bucket.upload(object.destinationPath, plaintextBuffer, {
        contentType: plaintext.mediaType,
        upsert: false,
      });
      const destination = await bucket.download(object.destinationPath);
      if (destination.error || !destination.data) {
        throw new Error("Guest Storage destination could not be verified.");
      }
      const destinationBytes = await destination.data.arrayBuffer();
      if (
        destinationBytes.byteLength !== plaintext.bytes.byteLength
        || sha256(destinationBytes) !== plaintextSha256
        || destination.data.type !== plaintext.mediaType
      ) {
        await bucket.remove([object.destinationPath]).catch(() => undefined);
        throw new Error("Guest Storage destination verification failed.");
      }

      return {
        destinationPath: object.destinationPath,
        sourceSha256: object.sha256,
        sourceByteLength: object.byteLength,
        plaintextSha256,
        plaintextByteLength: destinationBytes.byteLength,
        mediaType: plaintext.mediaType,
      };
    },
  };
}
