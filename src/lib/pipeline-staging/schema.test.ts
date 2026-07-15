import { describe, expect, it } from "vitest";
import {
  pipelineStageBatchInputSchema,
  pipelineStageBatchResultSchema,
} from "./schema";

const PHOTO = "user_123/staging/batch/item/front.jpg";

describe("pipeline staging contract", () => {
  it("accepts only safe capture-time inputs and preserves photo order", () => {
    const parsed = pipelineStageBatchInputSchema.parse({
      batchId: "11111111-1111-4111-8111-111111111111",
      userId: "user_123",
      dailyLimit: 15,
      perMinuteLimit: 20,
      entries: [
        {
          idempotencyKey: "capture-1",
          source: "single",
          autopilotEnabled: false,
          photoPaths: [PHOTO, "user_123/staging/batch/item/back.jpg"],
          costBasis: 12.5,
        },
      ],
    });

    expect(parsed.entries[0].photoPaths).toEqual([
      PHOTO,
      "user_123/staging/batch/item/back.jpg",
    ]);
    expect(Object.keys(parsed.entries[0]).sort()).toEqual([
      "autopilotEnabled",
      "costBasis",
      "idempotencyKey",
      "photoPaths",
      "source",
    ]);
  });

  it.each([
    { photoPaths: [] },
    { photoPaths: Array.from({ length: 5 }, () => PHOTO) },
    { photoPaths: ["https://signed.example/photo.jpg?token=secret"] },
    { costBasis: -1 },
    { source: "browser-auth" },
  ])("rejects unsafe or invalid staging input %#", (patch) => {
    expect(() =>
      pipelineStageBatchInputSchema.parse({
        batchId: "11111111-1111-4111-8111-111111111111",
        userId: "user_123",
        dailyLimit: 15,
        perMinuteLimit: 20,
        entries: [
          {
            idempotencyKey: "capture-1",
            source: "batch",
            autopilotEnabled: false,
            photoPaths: [PHOTO],
            costBasis: null,
            ...patch,
          },
        ],
      }),
    ).toThrow();
  });

  it("validates identifiers-only staging results", () => {
    expect(
      pipelineStageBatchResultSchema.parse([
        {
          batch_id: "11111111-1111-4111-8111-111111111111",
          batch_position: 0,
          idempotency_key: "capture-1",
          item_id: "22222222-2222-4222-8222-222222222222",
          run_id: "33333333-3333-4333-8333-333333333333",
          queue_message_id: "42",
          listing_id: null,
          status: "queued",
          stage: "queued",
          attempt_count: 0,
          max_attempts: 3,
          safe_failure_message: null,
          updated_at: "2026-07-15T12:00:00.000Z",
        },
      ]),
    ).toHaveLength(1);
  });
});
