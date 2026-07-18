import { describe, expect, it } from "vitest";
import { stageUploadEntries, type UploadProgressSnapshot } from "@/lib/upload-staging";
import {
  formatUploadProgressSummary,
  resolveScoutGuidance,
  verifiedUploadProgress,
} from "./resolve";

async function onePhotoSnapshots(): Promise<UploadProgressSnapshot[]> {
  const snapshots: UploadProgressSnapshot[] = [];
  await stageUploadEntries(
    {
      batchId: "11111111-1111-4111-8111-111111111111",
      userId: "user_test",
      dailyLimit: 10,
      perMinuteLimit: 5,
      entries: [{
        idempotencyKey: "one-photo-grammar",
        source: "single",
        autopilotEnabled: false,
        costBasis: null,
        photos: [new File(["front"], "front.jpg", { type: "image/jpeg" })],
      }],
    },
    {
      async upload() {},
      onUploadProgress(snapshot) { snapshots.push(snapshot); },
      async remove() {},
      async recordCleanupIntent() {},
      async resolveCleanupIntent() {},
      async findReplay() { return []; },
      async stageAndEnqueue() { return []; },
    },
  );
  return snapshots;
}

describe("Scout upload progress copy", () => {
  it("uses singular grammar for a one-photo attempt", async () => {
    const snapshots = await onePhotoSnapshots();

    expect(verifiedUploadProgress(snapshots[0]!).value).toEqual({
      uploadedPhotoCount: 0,
      plannedPhotoCount: 1,
    });

    const bodies = snapshots.map((snapshot) =>
      resolveScoutGuidance({
        contractVersion: "scout-guidance-v1",
        state: "recovery.upload-paused",
        locale: "en-US",
        substitutions: { uploadProgressSummary: verifiedUploadProgress(snapshot) },
      }).message.body,
    );

    expect(bodies).toEqual([
      "0 of 1 photo uploaded. Try again.",
      "1 of 1 photo uploaded. Try again.",
    ]);
  });

  it("formats the same semantic progress in the selected non-English locale", async () => {
    const snapshots = await onePhotoSnapshots();
    const guidance = resolveScoutGuidance({
      contractVersion: "scout-guidance-v1",
      state: "recovery.upload-paused",
      locale: "es",
      substitutions: {
        uploadProgressSummary: verifiedUploadProgress(snapshots.at(-1)!),
      },
    });

    expect(guidance.resolvedLocale).toBe("es");
    expect(guidance.message.body).toBe(
      "1 de 1 foto subida. Inténtalo de nuevo.",
    );
    expect(guidance.message.body).not.toMatch(/photo|uploaded|try again/i);
  });

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
