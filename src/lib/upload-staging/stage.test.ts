import { describe, expect, it, vi } from "vitest";
import { stageUploadEntries } from "./stage";

const photo = (name: string) =>
  new File([name], name, { type: "image/jpeg" });

describe("durable upload staging", () => {
  it("uploads every photo in order before one transactional stage/enqueue call", async () => {
    const events: string[] = [];
    const stageAndEnqueue = vi.fn(async (input) => {
      events.push("stage");
      return input.entries.map((entry: { idempotencyKey: string }, index: number) => ({
        batch_id: input.batchId,
        idempotency_key: entry.idempotencyKey,
        item_id: `00000000-0000-4000-8000-00000000000${index + 1}`,
        run_id: `10000000-0000-4000-8000-00000000000${index + 1}`,
        queue_message_id: String(index + 1),
      }));
    });
    const upload = vi.fn(async (path: string) => {
      events.push(`upload:${path}`);
    });

    const result = await stageUploadEntries(
      {
        batchId: "11111111-1111-4111-8111-111111111111",
        userId: "user_123",
        dailyLimit: 15,
        perMinuteLimit: 20,
        entries: [
          {
            idempotencyKey: "single-1",
            source: "single",
            autopilotEnabled: false,
            costBasis: 7.5,
            photos: [photo("front.jpg"), photo("back.jpg")],
          },
        ],
      },
      { upload, remove: vi.fn(), stageAndEnqueue },
    );

    expect(events.slice(0, 2).every((event) => event.startsWith("upload:"))).toBe(true);
    expect(events.at(-1)).toBe("stage");
    expect(stageAndEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        entries: [
          expect.objectContaining({
            costBasis: 7.5,
            photoPaths: [
              expect.stringMatching(/^user_123\/pipeline-staging\//),
              expect.stringMatching(/^user_123\/pipeline-staging\//),
            ],
          }),
        ],
      }),
    );
    expect(result).toHaveLength(1);
  });

  it("removes every uploaded private object when transactional staging fails", async () => {
    const remove = vi.fn(async (paths: string[]) => {
      void paths;
    });

    await expect(
      stageUploadEntries(
        {
          batchId: "11111111-1111-4111-8111-111111111111",
          userId: "user_123",
          dailyLimit: 15,
          perMinuteLimit: 20,
          entries: [
            {
              idempotencyKey: "batch-1",
              source: "batch",
              autopilotEnabled: true,
              costBasis: null,
              photos: [photo("front.jpg"), photo("back.jpg")],
            },
          ],
        },
        {
          upload: vi.fn(async () => undefined),
          remove,
          stageAndEnqueue: vi.fn(async () => {
            throw new Error("daily capacity reached");
          }),
        },
      ),
    ).rejects.toThrow("daily capacity reached");

    expect(remove).toHaveBeenCalledOnce();
    expect(remove.mock.calls[0][0]).toHaveLength(2);
  });

  it("never accepts signed URLs or unsupported photos into staging", async () => {
    await expect(
      stageUploadEntries(
        {
          batchId: "11111111-1111-4111-8111-111111111111",
          userId: "user_123",
          dailyLimit: 15,
          perMinuteLimit: 20,
          entries: [
            {
              idempotencyKey: "bad-1",
              source: "single",
              autopilotEnabled: false,
              costBasis: null,
              photos: [new File(["x"], "item.heic", { type: "image/heic" })],
            },
          ],
        },
        { upload: vi.fn(), remove: vi.fn(), stageAndEnqueue: vi.fn() },
      ),
    ).rejects.toThrow(/PNG, JPEG, or WEBP/);
  });
});
