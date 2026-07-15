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
        batch_position: index,
        idempotency_key: entry.idempotencyKey,
        item_id: `00000000-0000-4000-8000-00000000000${index + 1}`,
        run_id: `10000000-0000-4000-8000-00000000000${index + 1}`,
        queue_message_id: String(index + 1),
        listing_id: null,
        status: "queued" as const,
        stage: "queued" as const,
        attempt_count: 0,
        max_attempts: 3,
        safe_failure_message: null,
        updated_at: "2026-07-15T12:00:00.000Z",
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
      { upload, remove: vi.fn(), findReplay: vi.fn(), stageAndEnqueue },
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
          findReplay: vi.fn(async () => []),
          stageAndEnqueue: vi.fn(async () => {
            throw new Error("daily capacity reached");
          }),
        },
      ),
    ).rejects.toThrow("daily capacity reached");

    expect(remove).toHaveBeenCalledOnce();
    expect(remove.mock.calls[0][0]).toHaveLength(2);
  });

  it("recovers a committed run instead of deleting photos after a lost RPC response", async () => {
    const committed = [{
      batch_id: "11111111-1111-4111-8111-111111111111",
      batch_position: 0,
      idempotency_key: "batch-1",
      item_id: "22222222-2222-4222-8222-222222222222",
      run_id: "33333333-3333-4333-8333-333333333333",
      queue_message_id: "42",
      listing_id: null,
      status: "queued" as const,
      stage: "queued" as const,
      attempt_count: 0,
      max_attempts: 3,
      safe_failure_message: null,
      updated_at: "2026-07-15T12:00:00.000Z",
    }];
    const remove = vi.fn();

    await expect(stageUploadEntries(
      {
        batchId: committed[0].batch_id,
        userId: "user_123",
        dailyLimit: 15,
        perMinuteLimit: 20,
        entries: [{
          idempotencyKey: "batch-1",
          source: "batch",
          autopilotEnabled: false,
          costBasis: null,
          photos: [photo("front.jpg")],
        }],
      },
      {
        upload: vi.fn(async () => undefined),
        remove,
        stageAndEnqueue: vi.fn(async () => {
          throw new Error("response timed out");
        }),
        findReplay: vi.fn(async () => committed),
      },
    )).resolves.toEqual(committed);
    expect(remove).not.toHaveBeenCalled();
  });

  it("preserves photos when both staging and the replay probe are ambiguous", async () => {
    const remove = vi.fn();
    await expect(stageUploadEntries(
      {
        batchId: "11111111-1111-4111-8111-111111111111",
        userId: "user_123",
        dailyLimit: 15,
        perMinuteLimit: 20,
        entries: [{
          idempotencyKey: "single-ambiguous",
          source: "single",
          autopilotEnabled: false,
          costBasis: null,
          photos: [photo("front.jpg")],
        }],
      },
      {
        upload: vi.fn(async () => undefined),
        remove,
        stageAndEnqueue: vi.fn(async () => {
          throw new Error("response timed out");
        }),
        findReplay: vi.fn(async () => {
          throw new Error("replay probe timed out");
        }),
      },
    )).rejects.toThrow("response timed out");
    expect(remove).not.toHaveBeenCalled();
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
        {
          upload: vi.fn(),
          remove: vi.fn(),
          findReplay: vi.fn(),
          stageAndEnqueue: vi.fn(),
        },
      ),
    ).rejects.toThrow(/PNG, JPEG, or WEBP/);
  });
});
