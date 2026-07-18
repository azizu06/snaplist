import { describe, expect, it } from "vitest";
import { formatUploadProgressSummary } from "./resolve";

describe("Scout upload progress copy", () => {
  it("does not invent a denominator when the planned total is unknown", () => {
    expect(
      formatUploadProgressSummary({
        uploadedPhotoCount: 0,
        plannedPhotoCount: null,
      }),
    ).toBe("No photos uploaded. Try again.");
    expect(
      formatUploadProgressSummary({
        uploadedPhotoCount: 2,
        plannedPhotoCount: null,
      }),
    ).toBe("2 photos uploaded. Try again.");
  });
});
