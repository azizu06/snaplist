import { describe, expect, it } from "vitest";
import { createPipelineQueueEnvelope } from "./envelope";
import { createInMemoryPipelineQueue } from "./memory";

const RUN_A = "11111111-1111-4111-8111-111111111111";
const RUN_B = "22222222-2222-4222-8222-222222222222";

describe("in-memory pipeline queue", () => {
  it("claims FIFO messages and hides them for the visibility window", async () => {
    let now = new Date("2026-07-14T12:00:00.000Z");
    const queue = createInMemoryPipelineQueue({ now: () => now });
    await queue.enqueue(createPipelineQueueEnvelope(RUN_A));
    await queue.enqueue(createPipelineQueueEnvelope(RUN_B));

    const firstClaim = await queue.claim({ limit: 1, visibilityTimeoutSeconds: 30 });
    expect(firstClaim).toHaveLength(1);
    expect(firstClaim[0]).toMatchObject({
      id: "1",
      readCount: 1,
      envelope: createPipelineQueueEnvelope(RUN_A),
    });

    const secondClaim = await queue.claim({ limit: 2, visibilityTimeoutSeconds: 30 });
    expect(secondClaim.map((message) => message.envelope.run_id)).toEqual([RUN_B]);

    now = new Date("2026-07-14T12:00:31.000Z");
    const redelivery = await queue.claim({ limit: 1, visibilityTimeoutSeconds: 30 });
    expect(redelivery[0]).toMatchObject({ id: "1", readCount: 2 });
  });

  it("acknowledges explicitly and never uses destructive pop semantics", async () => {
    const queue = createInMemoryPipelineQueue();
    const messageId = await queue.enqueue(createPipelineQueueEnvelope(RUN_A));
    const [claimed] = await queue.claim({ limit: 1, visibilityTimeoutSeconds: 30 });
    expect(claimed?.id).toBe(messageId);
    expect(await queue.ack(messageId)).toBe(true);
    expect(await queue.ack(messageId)).toBe(false);
    expect(await queue.claim({ limit: 1, visibilityTimeoutSeconds: 30 })).toEqual([]);
  });

  it("validates messages and claim bounds at the adapter seam", async () => {
    const queue = createInMemoryPipelineQueue();
    await expect(
      queue.enqueue({ run_id: RUN_A, schema_version: 2 } as never),
    ).rejects.toThrow();
    await expect(
      queue.claim({ limit: 0, visibilityTimeoutSeconds: 30 }),
    ).rejects.toThrow();
    await expect(
      queue.claim({ limit: 1, visibilityTimeoutSeconds: 0 }),
    ).rejects.toThrow();
  });
});
