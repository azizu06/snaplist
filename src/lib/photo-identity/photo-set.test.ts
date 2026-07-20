import { describe, expect, it } from "vitest";

import { canonicalizeVerifiedPhotoSet } from "./photo-set";

const PHOTO_A = "a".repeat(64);
const PHOTO_B = "b".repeat(64);
const PHOTO_C = "c".repeat(64);

describe("canonicalizeVerifiedPhotoSet", () => {
  it("identifies the verified content multiset independently of photo order", () => {
    const original = canonicalizeVerifiedPhotoSet([PHOTO_A.toUpperCase(), PHOTO_B, PHOTO_A]);
    const reordered = canonicalizeVerifiedPhotoSet([PHOTO_B, PHOTO_A, PHOTO_A]);
    const duplicateRemoved = canonicalizeVerifiedPhotoSet([PHOTO_A, PHOTO_B]);
    const contentChanged = canonicalizeVerifiedPhotoSet([PHOTO_A, PHOTO_C, PHOTO_A]);

    expect(original).toEqual({
      kind: "content_sha256_set_v1",
      fingerprint: "2601809a314994324ece98d372ae5f7f546deaa21d430b76331d96dcfd5e75a9",
    });
    expect(reordered).toEqual(original);
    expect(duplicateRemoved.fingerprint).toBe(
      "5e9ae866add9a85d69c3481d059bb9f158a39e5670ba11f95112fc409630894e",
    );
    expect(duplicateRemoved).not.toEqual(original);
    expect(contentChanged.fingerprint).toBe(
      "c0903df6ad33085b6028ad1a4cbdd11990e89d649fcdef05898049e45d70043d",
    );
    expect(contentChanged).not.toEqual(original);
  });

  it("rejects an empty or non-SHA-256 receipt set", () => {
    expect(() => canonicalizeVerifiedPhotoSet([])).toThrow(/verified photo digest/i);
    expect(() => canonicalizeVerifiedPhotoSet(["a".repeat(63)])).toThrow(
      /verified photo digest/i,
    );
    expect(() => canonicalizeVerifiedPhotoSet(["g".repeat(64)])).toThrow(
      /verified photo digest/i,
    );
  });
});
