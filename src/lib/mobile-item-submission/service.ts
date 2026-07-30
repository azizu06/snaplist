import { createHash } from "node:crypto";
import { canonicalizeVerifiedPhotoSet } from "@/lib/photo-identity/photo-set";
import {
  mobileItemSubmissionReceiptSchema,
  type MobileItemSubmissionOperations,
  type MobileItemSubmissionReceipt,
  type MobileSubmissionMediaType,
  type PreparedMobileSubmissionPhoto,
  type SubmissionPrincipal,
} from "./contract";
import {
  MOBILE_ITEM_VOICE_MEDIA_TYPE,
  type PreparedMobileSubmissionVoice,
} from "./voice";

export interface StoredMobileSubmissionPhotoReceipt {
  ordinal: number;
  storagePath: string;
  contentSha256: string;
  byteLength: number;
  mediaType: MobileSubmissionMediaType;
}

export interface StoredMobileSubmissionVoiceReceipt {
  storagePath: string;
  contentSha256: string;
  byteLength: number;
  durationMs: number;
  locale: string | null;
  mediaType: typeof MOBILE_ITEM_VOICE_MEDIA_TYPE;
  version: 1;
}

export interface MobileItemSubmissionStaging {
  findSubmission(input: {
    userId: string;
    idempotencyKey: string;
    legacyRequestFingerprint: string | null;
    requestFingerprint: string;
  }): Promise<MobileItemSubmissionReceipt | null>;
  beginSubmission(input: {
    cleanupId: string;
    userId: string;
    idempotencyKey: string;
    legacyRequestFingerprint: string | null;
    requestFingerprint: string;
    batchId: string;
    costBasis: number | null;
    photoReceipts: StoredMobileSubmissionPhotoReceipt[];
    voiceReceipt: StoredMobileSubmissionVoiceReceipt | null;
  }): Promise<boolean | void>;
  resolveCleanupIntent(cleanupId: string): Promise<boolean | void>;
  commitSubmission(input: {
    userId: string;
    idempotencyKey: string;
    legacyRequestFingerprint: string | null;
    requestFingerprint: string;
    batchId: string;
    cleanupId: string;
    costBasis: number | null;
    dailyLimit: number;
    perMinuteLimit: number;
    photoIdentity: {
      kind: "content_sha256_set_v1";
      fingerprint: string;
    };
    photoReceipts: StoredMobileSubmissionPhotoReceipt[];
    voiceReceipt: StoredMobileSubmissionVoiceReceipt | null;
  }): Promise<{
    outcome: "created" | "replayed";
    receipt: MobileItemSubmissionReceipt;
  }>;
}

export interface TenantPhotoStorage {
  upload(
    path: string,
    bytes: Uint8Array,
    mediaType: MobileSubmissionMediaType | typeof MOBILE_ITEM_VOICE_MEDIA_TYPE,
  ): Promise<void>;
  download(path: string): Promise<{
    bytes: Uint8Array;
    mediaType: string;
  }>;
  remove?(paths: string[]): Promise<void>;
}

export interface MobileItemSubmissionComposition {
  resolvePrincipal(bearerToken: string): Promise<SubmissionPrincipal>;
  storageFor(principal: SubmissionPrincipal): TenantPhotoStorage;
  staging: MobileItemSubmissionStaging;
  stagingFor?(principal: SubmissionPrincipal): MobileItemSubmissionStaging;
  limits: { dailyLimit: number; perMinuteLimit: number };
}

function deterministicUuid(input: string): string {
  const bytes = Uint8Array.from(createHash("sha256").update(input).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function extensionFor(mediaType: MobileSubmissionMediaType): string {
  if (mediaType === "image/png") return "png";
  if (mediaType === "image/webp") return "webp";
  return "jpg";
}

function plannedReceipt(
  principal: SubmissionPrincipal,
  batchId: string,
  photo: PreparedMobileSubmissionPhoto,
): StoredMobileSubmissionPhotoReceipt {
  return {
    ordinal: photo.ordinal,
    storagePath: [
      principal.userId,
      "pipeline-staging",
      batchId,
      "0",
      `${photo.ordinal}-${photo.contentSha256}.${extensionFor(photo.mediaType)}`,
    ].join("/"),
    contentSha256: photo.contentSha256,
    byteLength: photo.byteLength,
    mediaType: photo.mediaType,
  };
}

function plannedVoiceReceipt(
  principal: SubmissionPrincipal,
  batchId: string,
  voice: PreparedMobileSubmissionVoice,
): StoredMobileSubmissionVoiceReceipt {
  return {
    storagePath: [
      principal.userId,
      "pipeline-staging",
      batchId,
      "0",
      `voice-${voice.contentSha256}.wav`,
    ].join("/"),
    contentSha256: voice.contentSha256,
    byteLength: voice.byteLength,
    durationMs: voice.durationMs,
    locale: voice.locale,
    mediaType: voice.mediaType,
    version: voice.version,
  };
}

async function writeAndVerify(
  storage: TenantPhotoStorage,
  asset: PreparedMobileSubmissionPhoto | PreparedMobileSubmissionVoice,
  receipt: StoredMobileSubmissionPhotoReceipt | StoredMobileSubmissionVoiceReceipt,
): Promise<void> {
  try {
    await storage.upload(receipt.storagePath, asset.bytes, asset.mediaType);
  } catch (uploadError) {
    // An identical concurrent/recovery attempt uses the same server path. It is
    // safe to continue only when an independent read proves the exact object.
    try {
      const existing = await storage.download(receipt.storagePath);
      const digest = createHash("sha256").update(existing.bytes).digest("hex");
      if (
        existing.bytes.byteLength === receipt.byteLength &&
        existing.mediaType === receipt.mediaType &&
        digest === receipt.contentSha256
      ) {
        return;
      }
    } catch {
      // Preserve the original write failure; its cleanup intent remains durable.
    }
    throw uploadError;
  }

  const stored = await storage.download(receipt.storagePath);
  const storedDigest = createHash("sha256").update(stored.bytes).digest("hex");
  if (
    stored.bytes.byteLength !== receipt.byteLength ||
    stored.mediaType !== receipt.mediaType ||
    storedDigest !== receipt.contentSha256
  ) {
    throw new Error("Stored photo verification failed.");
  }
}

export function createMobileItemSubmissionOperations(
  composition: MobileItemSubmissionComposition,
): MobileItemSubmissionOperations {
  return {
    resolvePrincipal: composition.resolvePrincipal,

    async submit(input) {
      if (!/^[A-Za-z0-9_-]{1,255}$/.test(input.principal.userId)) {
        throw new Error("The resolved submission principal is invalid.");
      }

      const staging = composition.stagingFor?.(input.principal) ?? composition.staging;
      const replay = await staging.findSubmission({
        userId: input.principal.userId,
        idempotencyKey: input.idempotencyKey,
        legacyRequestFingerprint: input.legacyRequestFingerprint,
        requestFingerprint: input.requestFingerprint,
      });
      if (replay) {
        return {
          outcome: "replayed",
          receipt: mobileItemSubmissionReceiptSchema.parse({
            ...replay,
            voiceContext: replay.voiceContext ?? null,
          }),
        };
      }

      const batchId = input.idempotencyKey;
      const cleanupId = deterministicUuid(
        `snaplist-mobile-item-submission-cleanup-v1:${input.principal.userId}:${input.idempotencyKey}`,
      );
      const photoReceipts = input.photos.map((photo) =>
        plannedReceipt(input.principal, batchId, photo),
      );
      const voice = input.voice ?? null;
      const voiceReceipt =
        voice === null
          ? null
          : plannedVoiceReceipt(input.principal, batchId, voice);

      await staging.beginSubmission({
        cleanupId,
        userId: input.principal.userId,
        idempotencyKey: input.idempotencyKey,
        legacyRequestFingerprint: input.legacyRequestFingerprint,
        requestFingerprint: input.requestFingerprint,
        batchId,
        costBasis: input.costBasis,
        photoReceipts,
        voiceReceipt,
      });

      const storage = composition.storageFor(input.principal);
      for (const [index, photo] of input.photos.entries()) {
        await writeAndVerify(storage, photo, photoReceipts[index]);
      }
      if (voice && voiceReceipt) {
        await writeAndVerify(storage, voice, voiceReceipt);
      }

      const photoIdentity = canonicalizeVerifiedPhotoSet(
        photoReceipts.map((receipt) => receipt.contentSha256),
      );
      const result = await staging.commitSubmission({
        userId: input.principal.userId,
        idempotencyKey: input.idempotencyKey,
        legacyRequestFingerprint: input.legacyRequestFingerprint,
        requestFingerprint: input.requestFingerprint,
        batchId,
        cleanupId,
        costBasis: input.costBasis,
        dailyLimit: composition.limits.dailyLimit,
        perMinuteLimit: composition.limits.perMinuteLimit,
        photoIdentity,
        photoReceipts,
        voiceReceipt,
      });

      if (input.principal.kind === "clerk") {
        try {
          await staging.resolveCleanupIntent(cleanupId);
        } catch {
          // Keep the exact durable intent. Retention must prove that no committed
          // item references a path before removing an object.
        }
      }
      return {
        outcome: result.outcome,
        receipt: mobileItemSubmissionReceiptSchema.parse({
          ...result.receipt,
          voiceContext: result.receipt.voiceContext ?? null,
        }),
      };
    },
  };
}
