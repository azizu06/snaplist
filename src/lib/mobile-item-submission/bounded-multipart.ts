import { MIMEType } from "node:util";
import {
  make as makeMultipartParser,
  type MultipartError,
  type PartInfo,
} from "multipasta";
import {
  MAX_MOBILE_ITEM_PHOTO_BYTES,
  MAX_MOBILE_ITEM_PHOTOS,
} from "./contract";
import { MAX_MOBILE_ITEM_VOICE_BYTES } from "./voice";

const MAX_TEXT_FIELDS = 2;
const MAX_FILE_PARTS = MAX_MOBILE_ITEM_PHOTOS + 1;
const MAX_PARTS = MAX_TEXT_FIELDS + MAX_FILE_PARTS;
const MAX_FIELD_NAME_BYTES = 32;
const MAX_COST_BASIS_BYTES = 64;
const MAX_LOCALE_BYTES = 255;
const MAX_MULTIPART_OVERHEAD_BYTES = 256 * 1024;

export const MAX_MOBILE_ITEM_MULTIPART_BYTES =
  MAX_MOBILE_ITEM_PHOTO_BYTES * MAX_MOBILE_ITEM_PHOTOS +
  MAX_MOBILE_ITEM_VOICE_BYTES +
  MAX_MULTIPART_OVERHEAD_BYTES;

interface OrderedEntry {
  index: number;
  name: "costBasis" | "photo" | "voiceContext" | "voiceContextLocale";
  value: File | string;
}

interface BoundedCollector {
  append(chunk: Uint8Array): void;
  finish(): Uint8Array | null;
}

function invalidMultipart(): Error {
  return new Error("The multipart item submission is invalid.");
}

function parseBoundary(contentType: string): string | null {
  try {
    const parsed = new MIMEType(contentType);
    if (parsed.essence !== "multipart/form-data") return null;
    const boundary = parsed.params.get("boundary");
    if (
      !boundary ||
      boundary.length > 70 ||
      !/^[0-9A-Za-z'()+_,./:=?-](?:[0-9A-Za-z'()+_,./:=? -]{0,68}[0-9A-Za-z'()+_,./:=?-])?$/.test(
        boundary,
      )
    ) {
      return null;
    }
    return boundary;
  } catch {
    return null;
  }
}

function boundedCollector(maximumBytes: number): BoundedCollector {
  const chunks: Uint8Array[] = [];
  let bufferedBytes = 0;
  let overflowed = false;
  return {
    append(chunk) {
      if (overflowed || bufferedBytes + chunk.byteLength > maximumBytes) {
        overflowed = true;
        chunks.length = 0;
        bufferedBytes = 0;
        return;
      }
      chunks.push(Uint8Array.from(chunk));
      bufferedBytes += chunk.byteLength;
    },
    finish() {
      if (overflowed) return null;
      const bytes = new Uint8Array(bufferedBytes);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    },
  };
}

function partName(info: PartInfo): string | null {
  if (
    info.contentDisposition !== "form-data" ||
    typeof info.contentDispositionParameters.name !== "string" ||
    Buffer.byteLength(info.name, "utf8") > MAX_FIELD_NAME_BYTES
  ) {
    return null;
  }
  return info.name;
}

/**
 * Streams the public item-run multipart request into the existing FormData
 * preparation seam. Every part is surfaced by the maintained parser and
 * retained only to its field-specific ceiling; overflow keeps draining.
 */
export async function parseBoundedMobileItemSubmissionMultipart(
  request: Request,
): Promise<FormData> {
  const contentType = request.headers.get("content-type");
  if (!contentType || !request.body || !parseBoundary(contentType)) {
    throw invalidMultipart();
  }

  const entries: OrderedEntry[] = [];
  let nextIndex = 0;
  let photoCount = 0;
  let voiceCount = 0;
  let costBasisCount = 0;
  let localeCount = 0;
  let invalid: Error | null = null;
  let totalExceeded = false;
  const reject = () => {
    invalid ??= invalidMultipart();
  };

  const onPart = (info: PartInfo) => {
    const index = nextIndex;
    nextIndex += 1;
    const name = partName(info);
    if (
      name !== "photo" &&
      name !== "voiceContext" &&
      name !== "costBasis" &&
      name !== "voiceContextLocale"
    ) {
      reject();
      return () => {};
    }

    if (name === "photo") {
      photoCount += 1;
      if (photoCount > MAX_MOBILE_ITEM_PHOTOS) reject();
      const collector = boundedCollector(MAX_MOBILE_ITEM_PHOTO_BYTES);
      return (chunk: Uint8Array | null) => {
        if (chunk) {
          collector.append(chunk);
          return;
        }
        const bytes = collector.finish();
        if (!bytes) {
          reject();
          return;
        }
        entries.push({
          index,
          name,
          value: new File(
            [bytes.buffer as ArrayBuffer],
            info.filename || `photo-${index}`,
            { type: info.contentType },
          ),
        });
      };
    }

    if (name === "voiceContext") {
      voiceCount += 1;
      if (voiceCount > 1) reject();
      const collector = boundedCollector(MAX_MOBILE_ITEM_VOICE_BYTES);
      return (chunk: Uint8Array | null) => {
        if (chunk) {
          collector.append(chunk);
          return;
        }
        const bytes = collector.finish();
        if (!bytes) return;
        entries.push({
          index,
          name,
          value: new File(
            [bytes.buffer as ArrayBuffer],
            info.filename || "voice-context.wav",
            { type: info.contentType },
          ),
        });
      };
    }

    const maximumBytes =
      name === "costBasis" ? MAX_COST_BASIS_BYTES : MAX_LOCALE_BYTES;
    if (name === "costBasis") {
      costBasisCount += 1;
      if (costBasisCount > 1) reject();
    } else {
      localeCount += 1;
      if (localeCount > 1) reject();
    }
    const collector = boundedCollector(maximumBytes);
    return (chunk: Uint8Array | null) => {
      if (chunk) {
        collector.append(chunk);
        return;
      }
      const bytes = collector.finish();
      if (!bytes) {
        if (name === "costBasis") reject();
        return;
      }
      try {
        entries.push({
          index,
          name,
          value: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        });
      } catch {
        if (name === "costBasis") reject();
      }
    };
  };

  const parser = makeMultipartParser({
    headers: { "content-type": contentType },
    isFile: () => true,
    maxParts: MAX_PARTS,
    maxPartSize: MAX_MOBILE_ITEM_MULTIPART_BYTES,
    maxTotalSize: MAX_MOBILE_ITEM_MULTIPART_BYTES,
    maxFieldSize: MAX_LOCALE_BYTES,
    onFile: onPart,
    onField: () => reject(),
    onError: (error: MultipartError) => {
      reject();
      if (error._tag === "ReachedLimit" && error.limit === "MaxTotalSize") {
        totalExceeded = true;
      }
    },
    onDone: () => {},
  });

  const reader = request.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.write(value);
      if (totalExceeded) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (!totalExceeded) parser.end();

  if (photoCount < 1 || invalid) {
    throw invalid ?? invalidMultipart();
  }

  const formData = new FormData();
  for (const entry of entries.sort((left, right) => left.index - right.index)) {
    formData.append(entry.name, entry.value);
  }
  return formData;
}
