import { describe, expect, it, vi } from "vitest";
import { createPipelineQueueEnvelope } from "./envelope";
import {
  createSupabasePgmqPipelineQueue,
  type PipelineQueueRpcClient,
} from "./supabase-pgmq";

const RUN_ID = "11111111-1111-4111-8111-111111111111";

function rpcClient(
  responses: Record<string, { data: unknown; error: { message: string } | null }>,
) {
  return {
    rpc: vi.fn(async (name: string) => responses[name]),
  } as unknown as PipelineQueueRpcClient & { rpc: ReturnType<typeof vi.fn> };
}

describe("Supabase PGMQ pipeline queue", () => {
  it("uses only the four narrow queue RPC capabilities", async () => {
    const client = rpcClient({
      enqueue_pipeline_message: { data: 41, error: null },
      claim_pipeline_messages: {
        data: [
          {
            message_id: 41,
            read_count: 1,
            enqueued_at: "2026-07-14T12:00:00.000Z",
            visible_at: "2026-07-14T12:01:00.000Z",
            envelope: createPipelineQueueEnvelope(RUN_ID),
          },
        ],
        error: null,
      },
      ack_pipeline_message: { data: true, error: null },
      defer_pipeline_message: { data: true, error: null },
    });
    const queue = createSupabasePgmqPipelineQueue(client);

    expect(await queue.enqueue(createPipelineQueueEnvelope(RUN_ID))).toBe("41");
    expect(await queue.claim({ limit: 1, visibilityTimeoutSeconds: 60 })).toEqual([
      {
        id: "41",
        readCount: 1,
        enqueuedAt: "2026-07-14T12:00:00.000Z",
        visibleAt: "2026-07-14T12:01:00.000Z",
        envelope: createPipelineQueueEnvelope(RUN_ID),
      },
    ]);
    expect(await queue.ack("41")).toBe(true);
    expect(await queue.defer("41", 90)).toBe(true);

    expect(client.rpc.mock.calls).toEqual([
      ["enqueue_pipeline_message", { p_run_id: RUN_ID, p_schema_version: 1 }],
      ["claim_pipeline_messages", { p_quantity: 1, p_visibility_timeout_seconds: 60 }],
      ["ack_pipeline_message", { p_message_id: "41" }],
      ["defer_pipeline_message", { p_message_id: "41", p_visibility_timeout_seconds: 90 }],
    ]);
  });

  it("preserves a malformed envelope for per-message worker validation", async () => {
    const client = rpcClient({
      claim_pipeline_messages: {
        data: [
          {
            message_id: 9,
            read_count: 1,
            enqueued_at: "2026-07-14T12:00:00.000Z",
            visible_at: "2026-07-14T12:01:00.000Z",
            envelope: { run_id: RUN_ID, schema_version: 99 },
          },
        ],
        error: null,
      },
    });
    const queue = createSupabasePgmqPipelineQueue(client);

    await expect(queue.claim({ limit: 1, visibilityTimeoutSeconds: 60 })).resolves.toEqual([
      expect.objectContaining({ envelope: { run_id: RUN_ID, schema_version: 99 } }),
    ]);
  });

  it("surfaces RPC failures without leaking payload contents", async () => {
    const client = rpcClient({
      enqueue_pipeline_message: {
        data: null,
        error: { message: "permission denied for function" },
      },
    });
    const queue = createSupabasePgmqPipelineQueue(client);

    await expect(queue.enqueue(createPipelineQueueEnvelope(RUN_ID))).rejects.toThrow(
      "Pipeline queue enqueue failed: permission denied for function",
    );
  });
});
