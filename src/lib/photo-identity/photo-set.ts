import { createHash } from "node:crypto";

export const CONTENT_SHA256_SET_V1 = "content_sha256_set_v1" as const;

export interface CanonicalPhotoSetIdentity {
  kind: typeof CONTENT_SHA256_SET_V1;
  fingerprint: string;
}

export function canonicalizeVerifiedPhotoSet(
  perPhotoSha256: readonly string[],
): CanonicalPhotoSetIdentity {
  if (
    perPhotoSha256.length === 0 ||
    perPhotoSha256.some((digest) => !/^[0-9a-f]{64}$/i.test(digest))
  ) {
    throw new Error("At least one verified photo digest is required");
  }

  const canonicalDigests = perPhotoSha256.map((digest) => digest.toLowerCase()).sort();

  return {
    kind: CONTENT_SHA256_SET_V1,
    fingerprint: createHash("sha256").update(canonicalDigests.join("\n"), "utf8").digest("hex"),
  };
}
