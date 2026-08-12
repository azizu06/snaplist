import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalizeVerifiedPhotoSet } from "./photo-set";

/**
 * Bounding photo bytes on-device changes what the seller submits, and this is the
 * identity that change has to be safe against.
 *
 * `canonicalizeVerifiedPhotoSet` is fed `photoReceipts.map((r) => r.contentSha256)`
 * at `src/lib/mobile-item-submission/service.ts:262-263` and travels to
 * `commitSubmission` as `photoIdentity`. It is what governs guest allowance and
 * AI-item credit settlement — not `requestFingerprint`, which is the idempotency
 * key over the request. The two behave differently and both matter, so this file
 * covers the credit seam specifically.
 *
 * Each receipt digest is a SHA-256 over the bytes actually stored
 * (`contract.ts:397`), which after this change are the bounded bytes.
 *
 * Scope, stated plainly: `canonicalizeVerifiedPhotoSet` itself is untouched here,
 * so these pass with this PR reverted. They are locks on the properties the
 * bounding depends on, not evidence that the bounding works. The evidence that
 * bounding cannot mint a second identity is client-side — one capture must stage
 * to the same bytes every time — and lives in `NativeIntakeTests`
 * (`testStagesOneCaptureToTheSameBytesEveryTime`), which fails if bounding is
 * removed.
 */
const digestOf = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** Stands for one capture's bounded bytes. */
const bounded = (seed: number, byteLength = 2_048) => {
  const bytes = new Uint8Array(byteLength);
  bytes.set([0xff, 0xd8, 0xff], 0);
  bytes[byteLength - 1] = seed;
  return bytes;
};

const identityOf = (photos: Uint8Array[]) =>
  canonicalizeVerifiedPhotoSet(photos.map(digestOf)).fingerprint;

describe("photo-set credit identity under bounded photo bytes", () => {
  const set = [bounded(1), bounded(2), bounded(3)];

  it("settles a retry of the same bounded set as the same photo set", () => {
    // The client bounds once at staging and every retry re-reads that file, so
    // the same capture must reach the same digest or a retry buys a second run
    // and spends a second AI-item credit.
    expect(identityOf(set.map((bytes) => bytes.slice()))).toBe(identityOf(set));
  });

  it("distinguishes an added photo", () => {
    expect(identityOf([...set, bounded(4)])).not.toBe(identityOf(set));
  });

  it("distinguishes a removed photo", () => {
    expect(identityOf(set.slice(0, 2))).not.toBe(identityOf(set));
  });

  it("distinguishes a replaced photo", () => {
    expect(identityOf([set[0], bounded(9), set[2]])).not.toBe(identityOf(set));
  });

  it("distinguishes a photo whose bounded bytes changed", () => {
    // Same subject, different budget outcome — a build that bounds to a different
    // size submits different bytes, and that is deliberately a different set
    // rather than a silent replay of the one already settled.
    expect(identityOf([bounded(1, 1_024), set[1], set[2]])).not.toBe(
      identityOf(set),
    );
  });

  it("treats a reordered set as the same photo set", () => {
    // Deliberate, and the opposite of `requestFingerprint`: `photo-set.ts:20`
    // sorts the digests, so dragging photos into a new order is the same set of
    // photos and must not buy a second run. Locked here because bounding changes
    // the digests being sorted, not the sorting.
    expect(identityOf([set[2], set[0], set[1]])).toBe(identityOf(set));
  });

  it("keeps the identity kind the credit ledger reads", () => {
    expect(canonicalizeVerifiedPhotoSet(set.map(digestOf)).kind).toBe(
      "content_sha256_set_v1",
    );
  });
});
