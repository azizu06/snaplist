import { describe, expect, it } from "vitest";
import { parseBoundedMobileItemSubmissionMultipart } from "./bounded-multipart";

/**
 * Pins the deliberate asymmetry in how an oversized singleton text field is
 * handled: an oversized `voiceContextLocale` (255-byte ceiling) is a
 * non-essential hint and is silently dropped so the rest of the submission
 * still succeeds, while every other singleton field (`costBasis`,
 * `recoveryId`, `recoveryTokenHash`) rejects the whole request. Neither
 * direction was covered anywhere: a refactor that "unified" this handling
 * could start hard-failing real submissions over a too-long locale tag, or
 * start silently dropping a security-relevant field like
 * `recoveryTokenHash` without a single test noticing.
 */

function rawMultipart(
  boundary: string,
  parts: Array<{ headers: string[]; body: Uint8Array }>,
): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    chunks.push(
      encoder.encode(`--${boundary}\r\n${part.headers.join("\r\n")}\r\n\r\n`),
      part.body,
      encoder.encode("\r\n"),
    );
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`));
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

const BOUNDARY = "snaplist-bounded-multipart-test";
const PHOTO_PART = {
  headers: [
    'Content-Disposition: form-data; name="photo"; filename="front.jpg"',
    "Content-Type: image/jpeg",
  ],
  body: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
};

function textPart(name: string, byteLength: number) {
  return {
    headers: [`Content-Disposition: form-data; name="${name}"`],
    body: new Uint8Array(byteLength).fill(0x61),
  };
}

function requestFor(parts: Array<{ headers: string[]; body: Uint8Array }>): Request {
  const body = rawMultipart(BOUNDARY, parts);
  return new Request("http://localhost/v1/items/runs", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    body: body.buffer as ArrayBuffer,
  });
}

describe("parseBoundedMobileItemSubmissionMultipart oversized singleton fields", () => {
  it("silently drops an oversized voiceContextLocale and still returns the rest of the submission", async () => {
    const formData = await parseBoundedMobileItemSubmissionMultipart(
      requestFor([PHOTO_PART, textPart("voiceContextLocale", 256)]),
    );

    expect(formData.getAll("photo")).toHaveLength(1);
    expect(formData.get("voiceContextLocale")).toBeNull();
  });

  it("rejects the whole submission when recoveryTokenHash exceeds its ceiling", async () => {
    await expect(
      parseBoundedMobileItemSubmissionMultipart(
        requestFor([PHOTO_PART, textPart("recoveryTokenHash", 65)]),
      ),
    ).rejects.toThrow(/invalid/i);
  });
});
