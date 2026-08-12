import { describe, expect, it } from "vitest";
import {
  MAX_MOBILE_ITEM_PHOTOS,
  MAX_MOBILE_ITEM_PHOTO_BYTES,
  prepareMobileItemSubmission,
} from "./contract";

/**
 * The platform rejects a request body above roughly 4.5 MB with `413` before the
 * route handler, authentication, or any validation runs. Measured against
 * production on 2026-08-12: a 4 MB body reached auth and answered `401`, a 6 MB
 * body answered `413`. No application-level config raises it, so every
 * server-side photo constant has to describe a limit inside it.
 */
const MEASURED_TRANSPORT_BODY_CEILING_BYTES = 4_500_000;

function jpeg(byteLength: number, seed = 0): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  bytes.set([0xff, 0xd8, 0xff], 0);
  bytes[byteLength - 1] = seed;
  return bytes;
}

function photoPart(bytes: Uint8Array, name = "photo.jpg"): File {
  return new File([Uint8Array.from(bytes).buffer], name, {
    type: "image/jpeg",
  });
}

function submission(photos: Uint8Array[]): FormData {
  const body = new FormData();
  for (const [index, bytes] of photos.entries()) {
    body.append("photo", photoPart(bytes, `photo-${index}.jpg`));
  }
  return body;
}

describe("mobile item submission photo transport budget", () => {
  it("caps a single photo at a size the transport can actually deliver", () => {
    expect(MAX_MOBILE_ITEM_PHOTO_BYTES).toBeLessThanOrEqual(
      MEASURED_TRANSPORT_BODY_CEILING_BYTES,
    );
  });

  it("explains an oversize photo in plain language instead of a bare 413", async () => {
    await expect(
      prepareMobileItemSubmission(
        submission([jpeg(MAX_MOBILE_ITEM_PHOTO_BYTES + 1)]),
      ),
    ).rejects.toThrow(/photo is too large/i);
  });

  it("accepts a photo at the advertised ceiling", async () => {
    const prepared = await prepareMobileItemSubmission(
      submission([jpeg(MAX_MOBILE_ITEM_PHOTO_BYTES)]),
    );

    expect(prepared.photos).toHaveLength(1);
    expect(prepared.photos[0].byteLength).toBe(MAX_MOBILE_ITEM_PHOTO_BYTES);
  });

  it("still accepts the full ordered photo set the PRD promises", async () => {
    const photos = Array.from({ length: MAX_MOBILE_ITEM_PHOTOS }, (_, index) =>
      jpeg(4_096, index + 1),
    );

    const prepared = await prepareMobileItemSubmission(submission(photos));

    expect(prepared.photos.map((photo) => photo.ordinal)).toEqual([
      0, 1, 2, 3, 4,
    ]);
  });
});

/**
 * Bounding photo bytes on-device changes what is sent, and the fingerprint is
 * computed over those bytes and their `byteLength`. It governs guest allowance,
 * guided correction, and AI-item credit settlement, so the two properties that
 * make it safe are asserted here rather than assumed: a retry of one photo set
 * must settle as the same submission, and a set the seller actually edited must
 * not.
 */
describe("photo-set fingerprint under a changed photo transport", () => {
  const staged = [jpeg(2_048, 1), jpeg(2_048, 2), jpeg(2_048, 3)];

  const fingerprintOf = async (photos: Uint8Array[]) =>
    (await prepareMobileItemSubmission(submission(photos))).requestFingerprint;

  it("settles a retry of the same photo set as the same submission", async () => {
    // The bytes a retry sends are re-read from the same staged files, so the
    // second attempt has to reach the identical fingerprint or it buys a
    // second run and spends a second AI-item credit.
    const first = await fingerprintOf(staged);
    const retry = await fingerprintOf(staged.map((bytes) => bytes.slice()));

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(retry).toBe(first);
  });

  it("distinguishes an added photo", async () => {
    await expect(fingerprintOf([...staged, jpeg(2_048, 4)])).resolves.not.toBe(
      await fingerprintOf(staged),
    );
  });

  it("distinguishes a replaced photo", async () => {
    const replaced = [staged[0], jpeg(2_048, 9), staged[2]];

    await expect(fingerprintOf(replaced)).resolves.not.toBe(
      await fingerprintOf(staged),
    );
  });

  it("distinguishes a removed photo", async () => {
    await expect(fingerprintOf(staged.slice(0, 2))).resolves.not.toBe(
      await fingerprintOf(staged),
    );
  });

  it("distinguishes a photo re-encoded to a different size", async () => {
    // Same subject, different budget outcome. The seller did not edit the set,
    // but the bytes are not the ones already settled, so this is deliberately a
    // different submission rather than a silent replay of the original.
    const reEncoded = [jpeg(1_024, 1), staged[1], staged[2]];

    await expect(fingerprintOf(reEncoded)).resolves.not.toBe(
      await fingerprintOf(staged),
    );
  });

  it("distinguishes a reordered set", async () => {
    const reordered = [staged[1], staged[0], staged[2]];

    await expect(fingerprintOf(reordered)).resolves.not.toBe(
      await fingerprintOf(staged),
    );
  });
});
