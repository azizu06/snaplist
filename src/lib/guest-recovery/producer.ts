import {
  createCipheriv,
  createHash,
  createHmac,
} from "node:crypto";
import { z } from "zod";
import type { PipelineResult } from "@/lib/pipeline";
import type { PipelineWorkerContext } from "@/lib/pipeline-queue/worker-store";
import {
  recoveryRegistrationSchema,
  type GuestRecoveryStorageManifest,
} from "./recovery-store";
import { encryptGuestRecoveryPhotoEnvelope } from "./photo-encryption";

const OCTET_STREAM = "application/octet-stream";

export interface GuestRecoveryProducerStorage {
  download(path: string): Promise<{ bytes: Uint8Array; mediaType: string }>;
  upload(path: string, bytes: Uint8Array): Promise<void>;
}

export interface GuestRecoveryRegistrationProducer {
  prepare(input: {
    context: PipelineWorkerContext;
    result: PipelineResult;
    stageUploadCleanup(paths: string[]): Promise<void>;
  }): Promise<z.infer<typeof recoveryRegistrationSchema> | null>;
}

const producerConfigSchema = z.object({
  keyId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  masterKey: z.instanceof(Uint8Array).refine((key) => key.byteLength === 32),
  storage: z.custom<GuestRecoveryProducerStorage>(),
}).strict();

function hmac(key: Uint8Array, label: string, byteLength = 32): Uint8Array {
  return Uint8Array.from(
    createHmac("sha256", key).update(label, "utf8").digest().subarray(0, byteLength),
  );
}

function encrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  additionalData: string,
) {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(additionalData, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
  ]);
  return {
    ciphertext: Uint8Array.from(ciphertext),
    tag: Uint8Array.from(cipher.getAuthTag()),
  };
}

function base64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function exactBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && Buffer.from(left).equals(Buffer.from(right));
}

async function uploadAndVerify(
  storage: GuestRecoveryProducerStorage,
  path: string,
  ciphertext: Uint8Array,
): Promise<void> {
  try {
    await storage.upload(path, ciphertext);
  } catch (uploadError) {
    try {
      const existing = await storage.download(path);
      if (existing.mediaType === OCTET_STREAM && exactBytes(existing.bytes, ciphertext)) {
        return;
      }
    } catch {
      // The original upload error is the useful failure when exact recovery
      // bytes cannot be independently proved.
    }
    throw uploadError;
  }

  const stored = await storage.download(path);
  if (stored.mediaType !== OCTET_STREAM || !exactBytes(stored.bytes, ciphertext)) {
    throw new Error("Guest recovery ciphertext verification failed.");
  }
}

export function createGuestRecoveryRegistrationProducer(
  rawConfig: {
    keyId: string;
    masterKey: Uint8Array;
    storage: GuestRecoveryProducerStorage;
  },
): GuestRecoveryRegistrationProducer {
  const config = producerConfigSchema.parse(rawConfig);

  return {
    async prepare({ context, result, stageUploadCleanup }) {
      const recoveryId = context.run.recovery_id;
      const recoveryTokenHash = context.run.recovery_token_hash;
      if (recoveryId === null && recoveryTokenHash === null) return null;
      if (recoveryId === null || recoveryTokenHash === null) {
        throw new Error("Pipeline run guest recovery identity is incomplete.");
      }
      if (context.item.photo_identity_kind !== "content_sha256_set_v1") {
        throw new Error("Guest recovery requires verified photo identity.");
      }

      const dataKey = hmac(
        config.masterKey,
        `snaplist:guest-recovery:data-key:v1:${recoveryId}`,
      );
      const wrapNonce = hmac(
        config.masterKey,
        `snaplist:guest-recovery:key-envelope:v1:${recoveryId}`,
        12,
      );
      const wrappedKey = encrypt(
        config.masterKey,
        wrapNonce,
        dataKey,
        `snaplist:guest-recovery:key-envelope:v1:${recoveryId}`,
      );
      const keyEnvelope = Uint8Array.from(Buffer.concat([
        Buffer.from(wrapNonce),
        Buffer.from(wrappedKey.tag),
        Buffer.from(wrappedKey.ciphertext),
      ]));

      const plannedPhotos = context.item.photos.map((originalPath, ordinal) => {
        const pathDigest = createHash("sha256")
          .update(originalPath, "utf8")
          .digest("hex")
          .slice(0, 24);
        return {
          ordinal,
          originalPath,
          recoveryPath: [
            context.run.user_id,
            "guest-recovery",
            recoveryId,
            `${ordinal}-${pathDigest}.enc`,
          ].join("/"),
        };
      });
      await stageUploadCleanup(plannedPhotos.map(({ recoveryPath }) => recoveryPath));

      const manifest: GuestRecoveryStorageManifest = [];
      for (const { ordinal, originalPath, recoveryPath } of plannedPhotos) {
        const original = await config.storage.download(originalPath);
        const nonce = hmac(
          dataKey,
          [
            "snaplist:guest-recovery:photo:v1",
            ordinal,
            originalPath,
            createHash("sha256").update(original.bytes).digest("hex"),
          ].join(":"),
          12,
        );
        const encrypted = encryptGuestRecoveryPhotoEnvelope({
          bytes: original.bytes,
          masterKey: config.masterKey,
          mediaType: original.mediaType,
          nonce,
          path: recoveryPath,
        });
        await uploadAndVerify(config.storage, recoveryPath, encrypted.envelope);
        manifest.push({
          sourcePath: recoveryPath,
          sha256: createHash("sha256").update(encrypted.envelope).digest("hex"),
          byteLength: encrypted.envelope.byteLength,
          encryption: {
            algorithm: "aes-256-gcm",
            keyId: config.keyId,
            nonce: base64(nonce),
            tag: base64(encrypted.tag),
          },
        });
      }

      const artifactPlaintext = new TextEncoder().encode(JSON.stringify({
        version: 1,
        recoveryId,
        runId: context.run.id,
        itemId: context.item.id,
        photoIdentity: {
          kind: context.item.photo_identity_kind,
          fingerprint: context.item.photo_identity_fingerprint,
        },
        result,
      }));
      const artifactNonce = hmac(
        dataKey,
        `snaplist:guest-recovery:artifact:v1:${createHash("sha256")
          .update(artifactPlaintext)
          .digest("hex")}`,
        12,
      );
      const artifact = encrypt(
        dataKey,
        artifactNonce,
        artifactPlaintext,
        `snaplist:guest-recovery:artifact:v1:${recoveryId}`,
      );

      return recoveryRegistrationSchema.parse({
        recoveryId,
        guestUserId: context.run.user_id,
        pipelineRunId: context.run.id,
        recoveryTokenHash,
        encryptedArtifact: {
          version: 1,
          algorithm: "aes-256-gcm",
          keyId: config.keyId,
          keyEnvelope: base64(keyEnvelope),
          nonce: base64(artifactNonce),
          tag: base64(artifact.tag),
          ciphertext: base64(artifact.ciphertext),
        },
        storageManifest: manifest,
      });
    },
  };
}
