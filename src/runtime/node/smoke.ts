import type { AddressInfo } from "node:net";
import { createMobileApiHandler } from "@/lib/mobile-api";
import {
  createPipelineWorker,
  createSupabasePgmqPipelineQueue,
  type PipelineQueueRpcClient,
  type PipelineWorkerStore,
} from "@/lib/pipeline-queue";
import type { VisionPipelineStages } from "@/lib/vision";
import { startNodeMobileRuntime } from "./server";

interface PgmqRpcCall {
  functionName: string;
  args: Record<string, unknown>;
}

export interface MobileRuntimeSmokeResult {
  ok: true;
  healthStatus: number;
  sessionStatus: number;
  workerStatus: number;
  claimed: number;
  elapsedMs: number;
  rssBeforeBytes: number;
  rssAfterBytes: number;
  rssDeltaBytes: number;
  pgmqRpcCalls: PgmqRpcCall[];
}

function unusedStages(): VisionPipelineStages {
  return new Proxy(
    {},
    {
      get() {
        return async () => {
          throw new Error("pipeline stages are not called by the empty-queue smoke");
        };
      },
    },
  ) as VisionPipelineStages;
}

/**
 * Zero-credential proof: starts the standalone Node adapter and drives one
 * empty, bounded claim through the real Supabase PGMQ adapter. The fake RPC
 * capability records the exact call and cannot access a database or provider.
 */
export async function runMobileRuntimeSmoke(): Promise<MobileRuntimeSmokeResult> {
  const startedAt = performance.now();
  const rssBeforeBytes = process.memoryUsage().rss;
  const pgmqRpcCalls: PgmqRpcCall[] = [];
  const queueRpc: PipelineQueueRpcClient = {
    async rpc(functionName, args) {
      pgmqRpcCalls.push({ functionName, args });
      return { data: [], error: null };
    },
  };
  const worker = createPipelineWorker({
    capabilities: {
      queue: createSupabasePgmqPipelineQueue(queueRpc),
      runs: {} as PipelineWorkerStore,
      photos: {} as never,
    },
    createStages: () => unusedStages(),
    consumerOptions: { batchSize: 1, visibilityTimeoutSeconds: 30 },
  });
  const handler = createMobileApiHandler({
    authenticate: async (token) => {
      if (token !== "smoke-jwt") throw new Error("invalid smoke token");
      return { userId: "user_smoke" };
    },
    worker,
    workerSecret: "smoke-worker-secret",
    requestId: () => "req_smoke",
  });
  const server = await startNodeMobileRuntime({
    handler,
    host: "127.0.0.1",
    port: 0,
  });

  try {
    const { port } = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${port}`;
    const health = await fetch(`${origin}/v1/health`);
    const session = await fetch(`${origin}/v1/session`, {
      headers: { authorization: "Bearer smoke-jwt" },
    });
    const consume = await fetch(`${origin}/internal/v1/pipeline/consume`, {
      method: "POST",
      headers: { authorization: "Bearer smoke-worker-secret" },
    });
    const workerBody = (await consume.json()) as {
      data: { claimed: number };
    };
    if (
      health.status !== 200 ||
      session.status !== 200 ||
      consume.status !== 200 ||
      workerBody.data.claimed !== 0 ||
      pgmqRpcCalls.length !== 1 ||
      pgmqRpcCalls[0]?.functionName !== "claim_pipeline_messages"
    ) {
      throw new Error("provider-neutral mobile runtime smoke failed");
    }
    const rssAfterBytes = process.memoryUsage().rss;

    return {
      ok: true,
      healthStatus: health.status,
      sessionStatus: session.status,
      workerStatus: consume.status,
      claimed: workerBody.data.claimed,
      elapsedMs: Number((performance.now() - startedAt).toFixed(2)),
      rssBeforeBytes,
      rssAfterBytes,
      rssDeltaBytes: Math.max(0, rssAfterBytes - rssBeforeBytes),
      pgmqRpcCalls,
    };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
