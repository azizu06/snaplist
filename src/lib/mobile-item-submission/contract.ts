import { createHash } from "node:crypto";
import { z } from "zod";
import { parseCostBasis } from "@/lib/pipeline/autopilot";
import {
  MAX_MOBILE_ITEM_VOICE_BYTES,
  MAX_MOBILE_ITEM_VOICE_DURATION_MS,
  MOBILE_ITEM_VOICE_MEDIA_TYPE,
  prepareMobileSubmissionVoice,
  type PreparedMobileSubmissionVoice,
} from "./voice";

export const MAX_MOBILE_ITEM_PHOTO_BYTES = 50 * 1024 * 1024;
export const MAX_MOBILE_ITEM_PHOTOS = 5;

export const mobileSubmissionMediaTypeSchema = z.enum([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export type MobileSubmissionMediaType = z.infer<
  typeof mobileSubmissionMediaTypeSchema
>;

export type SubmissionPrincipal =
  | {
      kind: "clerk";
      /** Server-resolved domain owner. Request fields can never supply this value. */
      userId: string;
      /** Clerk credential used only by the tenant-scoped Storage adapter. */
      bearerToken: string;
    }
  | {
      kind: "verifiedGuest";
      /** Server-resolved domain owner. Request fields can never supply this value. */
      userId: string;
      /** Durable authority id resolved from the opaque GuestBearer digest. */
      capabilityId: string;
      /** Mints one fresh, bounded project JWT for one protected operation. */
      mintOperationToken(): Promise<string>;
    };

export interface PreparedMobileSubmissionPhoto {
  ordinal: number;
  bytes: Uint8Array;
  byteLength: number;
  contentSha256: string;
  mediaType: MobileSubmissionMediaType;
}

export interface PreparedMobileItemSubmission {
  costBasis: number | null;
  guestRecoveryIdentity: GuestRecoverySubmissionIdentity | null;
  legacyRequestFingerprint: string | null;
  photos: PreparedMobileSubmissionPhoto[];
  requestFingerprint: string;
  voice: PreparedMobileSubmissionVoice | null;
}

export const guestRecoverySubmissionIdentitySchema = z
  .object({
    recoveryId: z.string().uuid(),
    recoveryTokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export type GuestRecoverySubmissionIdentity = z.infer<
  typeof guestRecoverySubmissionIdentitySchema
>;

export const mobileSubmissionVoiceReceiptSchema = z
  .object({
    version: z.literal(1),
    contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
    byteLength: z.number().int().positive().max(MAX_MOBILE_ITEM_VOICE_BYTES),
    durationMs: z
      .number()
      .int()
      .positive()
      .max(MAX_MOBILE_ITEM_VOICE_DURATION_MS),
    mediaType: z.literal(MOBILE_ITEM_VOICE_MEDIA_TYPE),
  })
  .strict();

export const mobileItemSubmissionReceiptSchema = z
  .object({
    itemId: z.string().uuid(),
    runId: z.string().uuid(),
    status: z.literal("queued"),
    stage: z.literal("queued"),
    photoIdentity: z
      .object({
        kind: z.literal("content_sha256_set_v1"),
        fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
    photos: z
      .array(
        z
          .object({
            ordinal: z.number().int().min(0).max(MAX_MOBILE_ITEM_PHOTOS - 1),
            contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
            byteLength: z.number().int().positive().max(MAX_MOBILE_ITEM_PHOTO_BYTES),
            mediaType: mobileSubmissionMediaTypeSchema,
          })
          .strict(),
      )
      .min(1)
      .max(MAX_MOBILE_ITEM_PHOTOS),
    voiceContext: mobileSubmissionVoiceReceiptSchema.nullable(),
  })
  .strict();

export const mobileItemSubmissionEnvelopeSchema = z
  .object({
    data: mobileItemSubmissionReceiptSchema,
    meta: z.object({ requestId: z.string().min(1) }).strict(),
  })
  .strict();

export type MobileItemSubmissionReceipt = z.infer<
  typeof mobileItemSubmissionReceiptSchema
>;

export interface MobileItemSubmissionOperations {
  resolvePrincipal(bearerToken: string): Promise<SubmissionPrincipal>;
  submit(input: {
    principal: SubmissionPrincipal;
    idempotencyKey: string;
    legacyRequestFingerprint: string | null;
    requestFingerprint: string;
    costBasis: number | null;
    guestRecoveryIdentity: GuestRecoverySubmissionIdentity | null;
    photos: PreparedMobileSubmissionPhoto[];
    voice: PreparedMobileSubmissionVoice | null;
  }): Promise<{
    outcome: "created" | "replayed";
    receipt: MobileItemSubmissionReceipt;
  }>;
}

export interface MobileItemSubmissionConflict {
  code: "mobile_item_submission_conflict";
}

export class MobileItemSubmissionConflictError
  extends Error
  implements MobileItemSubmissionConflict
{
  readonly code = "mobile_item_submission_conflict" as const;

  constructor() {
    super("The mobile item submission idempotency key conflicts with another request.");
    this.name = "MobileItemSubmissionConflictError";
  }
}

export function isMobileItemSubmissionConflict(
  error: unknown,
): error is Error & MobileItemSubmissionConflict {
  return (
    error instanceof Error &&
    (error as Partial<MobileItemSubmissionConflict>).code ===
      "mobile_item_submission_conflict"
  );
}

export type MobileItemSubmissionDenialKind =
  | "allowance_denied"
  | "rate_limited";

export type MobileItemSubmissionDenialReason =
  | "snaplist-pro-required"
  | "storekit-entitlement-unavailable"
  | "monthly-allowance-reached"
  /**
   * Issue #524. The account still holds an unspent included first run, but this
   * physical Apple device has already consumed the promotion — or never proved
   * it had not — and the account has no paid period to fall back on. Only this
   * last part makes it a denial: a seller with a live subscription reaches the
   * paid path and hears about that path instead. So three routes clear it, and
   * the seller-facing copy offers all three: a completed device redemption, an
   * audited support override, or starting SnapList Pro.
   */
  | "device-fence-required"
  | "daily-capacity-reached"
  | "per-minute-capacity-reached";

export class MobileItemSubmissionDeniedError extends Error {
  readonly code = "mobile_item_submission_denied" as const;

  constructor(
    readonly kind: MobileItemSubmissionDenialKind,
    readonly reason: MobileItemSubmissionDenialReason,
  ) {
    super(`Mobile item submission denied: ${reason}`);
    this.name = "MobileItemSubmissionDeniedError";
  }
}

export function isMobileItemSubmissionDenied(error: unknown): error is
  Error & {
    code: "mobile_item_submission_denied";
    kind: MobileItemSubmissionDenialKind;
    reason: MobileItemSubmissionDenialReason;
  } {
  return (
    error instanceof Error &&
    (error as Partial<MobileItemSubmissionDeniedError>).code ===
      "mobile_item_submission_denied" &&
    ["allowance_denied", "rate_limited"].includes(
      (error as Partial<MobileItemSubmissionDeniedError>).kind ?? "",
    )
  );
}

function sniffMediaType(bytes: Uint8Array): MobileSubmissionMediaType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (byte, index) => bytes[index] === byte,
    )
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function requestFingerprint(
  photos: readonly PreparedMobileSubmissionPhoto[],
  costBasis: number | null,
  voice: PreparedMobileSubmissionVoice | null,
  guestRecoveryIdentity: GuestRecoverySubmissionIdentity | null,
): string {
  const hash = createHash("sha256");
  hash.update(
    guestRecoveryIdentity === null
      ? "snaplist-mobile-item-submission-v2\0"
      : "snaplist-mobile-item-submission-v3\0",
    "utf8",
  );
  hash.update(
    JSON.stringify({
      costBasisCents: costBasis == null ? null : Math.round(costBasis * 100),
      ...(guestRecoveryIdentity === null ? {} : { guestRecoveryIdentity }),
      photoCount: photos.length,
      voice:
        voice === null
          ? null
          : {
              version: voice.version,
              contentSha256: voice.contentSha256,
              byteLength: voice.byteLength,
              durationMs: voice.durationMs,
              mediaType: voice.mediaType,
              locale: voice.locale,
            },
    }),
    "utf8",
  );
  for (const photo of photos) {
    hash.update(`\0${photo.ordinal}:${photo.byteLength}:`, "utf8");
    hash.update(photo.bytes);
  }
  return hash.digest("hex");
}

function legacyPhotoOnlyRequestFingerprint(
  photos: readonly PreparedMobileSubmissionPhoto[],
  costBasis: number | null,
): string {
  const hash = createHash("sha256");
  hash.update("snaplist-mobile-item-submission-v1\0", "utf8");
  hash.update(
    JSON.stringify({
      costBasisCents: costBasis == null ? null : Math.round(costBasis * 100),
      photoCount: photos.length,
    }),
    "utf8",
  );
  for (const photo of photos) {
    hash.update(`\0${photo.ordinal}:${photo.byteLength}:`, "utf8");
    hash.update(photo.bytes);
  }
  return hash.digest("hex");
}

export async function prepareMobileItemSubmission(
  formData: FormData,
  options: { acceptVoiceContext?: boolean } = {},
): Promise<PreparedMobileItemSubmission> {
  const allowedFields = new Set([
    "photo",
    "costBasis",
    "voiceContext",
    "voiceContextLocale",
    "recoveryId",
    "recoveryTokenHash",
  ]);
  for (const key of formData.keys()) {
    if (!allowedFields.has(key)) {
      throw new Error("The multipart request contains an unsupported field.");
    }
  }

  const photoValues = formData.getAll("photo");
  if (photoValues.length < 1 || photoValues.length > MAX_MOBILE_ITEM_PHOTOS) {
    throw new Error(`Submit between 1 and ${MAX_MOBILE_ITEM_PHOTOS} photos.`);
  }
  if (formData.getAll("costBasis").length > 1) {
    throw new Error("Submit cost basis at most once.");
  }
  if (formData.getAll("voiceContext").length > 1) {
    throw new Error("Submit voice context at most once.");
  }
  if (formData.getAll("voiceContextLocale").length > 1) {
    throw new Error("Submit voice locale at most once.");
  }
  if (
    formData.getAll("recoveryId").length > 1
    || formData.getAll("recoveryTokenHash").length > 1
  ) {
    throw new Error("Submit guest recovery identity at most once.");
  }

  const rawRecoveryId = formData.get("recoveryId");
  const rawRecoveryTokenHash = formData.get("recoveryTokenHash");
  const guestRecoveryIdentity =
    rawRecoveryId === null && rawRecoveryTokenHash === null
      ? null
      : guestRecoverySubmissionIdentitySchema.parse({
          recoveryId: rawRecoveryId,
          recoveryTokenHash: rawRecoveryTokenHash,
        });

  const costBasis = parseCostBasis(formData.get("costBasis"));
  const voice =
    options.acceptVoiceContext === false
      ? null
      : await prepareMobileSubmissionVoice(
          formData.get("voiceContext"),
          formData.get("voiceContextLocale"),
        );
  const photos: PreparedMobileSubmissionPhoto[] = [];
  for (const [ordinal, value] of photoValues.entries()) {
    if (!(value instanceof File) || value.size < 1) {
      throw new Error("Every photo must contain image bytes.");
    }
    if (value.size > MAX_MOBILE_ITEM_PHOTO_BYTES) {
      throw new Error("Each photo must be 50 MiB or smaller.");
    }
    const declaredType = mobileSubmissionMediaTypeSchema.safeParse(value.type);
    if (!declaredType.success) {
      throw new Error("Use JPEG, PNG, or WebP photos.");
    }
    const bytes = new Uint8Array(await value.arrayBuffer());
    const mediaType = sniffMediaType(bytes);
    if (!mediaType || mediaType !== declaredType.data) {
      throw new Error("A photo's bytes do not match its declared media type.");
    }
    photos.push({
      ordinal,
      bytes,
      byteLength: bytes.byteLength,
      contentSha256: createHash("sha256").update(bytes).digest("hex"),
      mediaType,
    });
  }

  return {
    costBasis,
    guestRecoveryIdentity,
    legacyRequestFingerprint:
      voice === null && guestRecoveryIdentity === null
        ? legacyPhotoOnlyRequestFingerprint(photos, costBasis)
        : null,
    photos,
    requestFingerprint: requestFingerprint(
      photos,
      costBasis,
      voice,
      guestRecoveryIdentity,
    ),
    voice,
  };
}
