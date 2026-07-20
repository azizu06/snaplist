import { createHash } from "node:crypto";
import { z } from "zod";
import { parseCostBasis } from "@/lib/pipeline/autopilot";

export const MAX_MOBILE_ITEM_PHOTO_BYTES = 50 * 1024 * 1024;

export const mobileSubmissionMediaTypeSchema = z.enum([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export type MobileSubmissionMediaType = z.infer<
  typeof mobileSubmissionMediaTypeSchema
>;

export interface SubmissionPrincipal {
  kind: "clerk" | "verifiedGuest";
  /** Server-resolved domain owner. Request fields can never supply this value. */
  userId: string;
  /** Opaque credential used only by the principal's tenant-scoped Storage adapter. */
  bearerToken: string;
}

export interface PreparedMobileSubmissionPhoto {
  ordinal: number;
  bytes: Uint8Array;
  byteLength: number;
  contentSha256: string;
  mediaType: MobileSubmissionMediaType;
}

export interface PreparedMobileItemSubmission {
  costBasis: number | null;
  photos: PreparedMobileSubmissionPhoto[];
  requestFingerprint: string;
}

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
            ordinal: z.number().int().min(0).max(3),
            contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
            byteLength: z.number().int().positive().max(MAX_MOBILE_ITEM_PHOTO_BYTES),
            mediaType: mobileSubmissionMediaTypeSchema,
          })
          .strict(),
      )
      .min(1)
      .max(4),
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
    requestFingerprint: string;
    costBasis: number | null;
    photos: PreparedMobileSubmissionPhoto[];
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
): Promise<PreparedMobileItemSubmission> {
  const allowedFields = new Set(["photo", "costBasis"]);
  for (const key of formData.keys()) {
    if (!allowedFields.has(key)) {
      throw new Error("The multipart request contains an unsupported field.");
    }
  }

  const photoValues = formData.getAll("photo");
  if (photoValues.length < 1 || photoValues.length > 4) {
    throw new Error("Submit between 1 and 4 photos.");
  }
  if (formData.getAll("costBasis").length > 1) {
    throw new Error("Submit cost basis at most once.");
  }

  const costBasis = parseCostBasis(formData.get("costBasis"));
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
    photos,
    requestFingerprint: requestFingerprint(photos, costBasis),
  };
}
