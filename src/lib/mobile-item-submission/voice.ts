import { createHash } from "node:crypto";
import { canonicalizeScoutGuidanceLocale } from "@/lib/scout-guidance/contract";

export const MAX_MOBILE_ITEM_VOICE_BYTES = 512 * 1024;
export const MAX_MOBILE_ITEM_VOICE_DURATION_MS = 15_000;
export const MOBILE_ITEM_VOICE_MEDIA_TYPE = "audio/wav" as const;

export interface PreparedMobileSubmissionVoice {
  bytes: Uint8Array;
  byteLength: number;
  contentSha256: string;
  durationMs: number;
  locale: string | null;
  mediaType: typeof MOBILE_ITEM_VOICE_MEDIA_TYPE;
  version: 1;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function pcmDurationMs(bytes: Uint8Array): number | null {
  if (
    bytes.byteLength < 44 ||
    ascii(bytes, 0, 4) !== "RIFF" ||
    ascii(bytes, 8, 4) !== "WAVE"
  ) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.byteLength) return null;

  let offset = 12;
  let foundFormat = false;
  let dataByteLength = 0;
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = ascii(bytes, offset, 4);
    const chunkLength = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;
    if (chunkEnd > bytes.byteLength) return null;

    if (chunkId === "fmt " && !foundFormat) {
      if (
        chunkLength < 16 ||
        view.getUint16(chunkStart, true) !== 1 ||
        view.getUint16(chunkStart + 2, true) !== 1 ||
        view.getUint32(chunkStart + 4, true) !== 16_000 ||
        view.getUint32(chunkStart + 8, true) !== 32_000 ||
        view.getUint16(chunkStart + 12, true) !== 2 ||
        view.getUint16(chunkStart + 14, true) !== 16
      ) {
        return null;
      }
      foundFormat = true;
    } else if (chunkId === "data") {
      dataByteLength += chunkLength;
    }

    offset = chunkEnd + (chunkLength % 2);
  }

  if (
    offset !== bytes.byteLength ||
    !foundFormat ||
    dataByteLength < 1 ||
    dataByteLength % 2 !== 0
  ) {
    return null;
  }

  return Math.ceil((dataByteLength / 2 / 16_000) * 1_000);
}

function canonicalLocale(value: FormDataEntryValue | null): string | null {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    Buffer.byteLength(value, "utf8") > 255
  ) {
    return null;
  }
  return canonicalizeScoutGuidanceLocale(value);
}

export async function prepareMobileSubmissionVoice(
  value: FormDataEntryValue | null,
  localeValue: FormDataEntryValue | null,
): Promise<PreparedMobileSubmissionVoice | null> {
  if (
    !(value instanceof File) ||
    value.type !== MOBILE_ITEM_VOICE_MEDIA_TYPE ||
    value.size < 1 ||
    value.size > MAX_MOBILE_ITEM_VOICE_BYTES
  ) {
    return null;
  }

  const bytes = new Uint8Array(await value.arrayBuffer());
  const durationMs = pcmDurationMs(bytes);
  if (
    durationMs === null ||
    durationMs < 1 ||
    durationMs > MAX_MOBILE_ITEM_VOICE_DURATION_MS
  ) {
    return null;
  }

  return {
    bytes,
    byteLength: bytes.byteLength,
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
    durationMs,
    locale: canonicalLocale(localeValue),
    mediaType: MOBILE_ITEM_VOICE_MEDIA_TYPE,
    version: 1,
  };
}
