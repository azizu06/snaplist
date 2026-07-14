import { z } from "zod";

export const MAX_MESSAGE_PHOTOS = 5;
export const MAX_MESSAGE_PHOTO_BYTES = 12 * 1024 * 1024;
export const MESSAGE_PHOTO_BUCKET = "message-photos";

const supportedTypes = ["image/jpeg", "image/png", "image/webp"] as const;
export const messagePhotoMediaTypeSchema = z.enum(supportedTypes);
export type MessagePhotoMediaType = z.infer<typeof messagePhotoMediaTypeSchema>;

export interface MessagePhotoCandidate {
  name: string;
  type: string;
  size: number;
  bytes: Uint8Array;
}

export interface ValidatedMessagePhoto extends MessagePhotoCandidate {
  mediaType: MessagePhotoMediaType;
  extension: "jpg" | "png" | "webp";
}

export function validateMessagePhotoBatch(
  candidates: MessagePhotoCandidate[],
): ValidatedMessagePhoto[] {
  if (candidates.length > MAX_MESSAGE_PHOTOS) {
    throw new Error(`You can attach up to ${MAX_MESSAGE_PHOTOS} photos.`);
  }
  return candidates.map(validateMessagePhoto);
}

export function validateMessagePhoto(
  candidate: MessagePhotoCandidate,
): ValidatedMessagePhoto {
  const mediaType = messagePhotoMediaTypeSchema.safeParse(candidate.type);
  if (!mediaType.success) {
    throw new Error("Photos must be JPEG, PNG, or WebP images.");
  }
  if (!Number.isSafeInteger(candidate.size) || candidate.size <= 0) {
    throw new Error("Photo is empty or has an invalid size.");
  }
  if (candidate.size > MAX_MESSAGE_PHOTO_BYTES) {
    throw new Error("Each photo must be 12 MB or smaller.");
  }
  if (!signatureMatches(mediaType.data, candidate.bytes)) {
    throw new Error("Photo content does not match its declared image type.");
  }
  return {
    ...candidate,
    mediaType: mediaType.data,
    extension:
      mediaType.data === "image/jpeg"
        ? "jpg"
        : mediaType.data === "image/png"
          ? "png"
          : "webp",
  };
}

function signatureMatches(type: MessagePhotoMediaType, bytes: Uint8Array): boolean {
  if (type === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (type === "image/png") {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return signature.every((byte, index) => bytes[index] === byte);
  }
  return (
    bytes.length >= 12 &&
    new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
    new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP"
  );
}

export interface InboundMessagePhotoInput {
  mediaName?: string | null;
  mediaType?: string | null;
  mediaUrl?: string | null;
}

export interface NormalizedInboundMessagePhoto {
  name: string;
  providerUrl: string;
  providerMediaType: "IMAGE";
}

export function normalizeInboundMessagePhoto(
  input: InboundMessagePhotoInput,
): NormalizedInboundMessagePhoto | null {
  if (input.mediaType && input.mediaType !== "IMAGE") return null;
  if (!input.mediaUrl) throw new Error("Inbound photo is missing its media URL.");
  const url = new URL(input.mediaUrl);
  if (url.protocol !== "https:") {
    throw new Error("Inbound photo URL must use HTTPS.");
  }
  const host = url.hostname.toLowerCase();
  if (!host.endsWith(".ebayimg.com") && !host.endsWith(".ebaystatic.com")) {
    throw new Error("Inbound photo URL is not on a trusted eBay image host.");
  }
  const rawName = input.mediaName?.trim() || "Buyer photo";
  return {
    name: rawName.slice(0, 100),
    providerUrl: url.toString(),
    providerMediaType: "IMAGE",
  };
}
