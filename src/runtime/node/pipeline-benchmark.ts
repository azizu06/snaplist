import type { ExtractItemAttributesResult } from "@/lib/vision/extract";
import {
  createPipelinePhotoCapability,
  createPipelineWorker,
  createSupabasePgmqPipelineQueue,
  createSupabasePipelineWorkerStore,
  type PipelineQueueRpcClient,
  type PipelineWorkerRpcClient,
} from "@/lib/pipeline-queue";
import { createVisionPipelineStages } from "@/lib/vision";
import type { PriceResult } from "@/lib/pricing";
import type { ListingCopy } from "@/lib/pipeline";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";
const LEASE_TOKEN = "33333333-3333-4333-8333-333333333333";
const LISTING_ID = "44444444-4444-4444-8444-444444444444";
const REVIEW_REVISION = "55555555-5555-4555-8555-555555555555";
const CONTENT_REVISION = "66666666-6666-4666-8666-666666666666";

const EXTRACTION: ExtractItemAttributesResult = {
  attributes: {
    brand: "Sony",
    model: "WH-1000XM4",
    category: "electronics",
    condition: "good",
    upc: "027242920866",
    specs: ["wireless", "noise-cancelling"],
    title: "Sony WH-1000XM4 Headphones",
  },
  identification: {
    label: "Sony WH-1000XM4 Headphones",
    confident: true,
    evidence: 1,
  },
  model: "offline-fixture-vision",
};

const PRICE: PriceResult = {
  suggested: 149,
  range: { min: 130, max: 170 },
  confidence: 0.78,
  sources: [],
  tier: "llm-only",
};

const LISTING: ListingCopy = {
  platform: "ebay",
  title: "Sony WH-1000XM4 Wireless Headphones",
  description: "Sony wireless noise-cancelling headphones in good used condition.",
  fields: { itemSpecifics: { Brand: "Sony", Model: "WH-1000XM4" } },
};

export interface OfflinePipelineBenchmarkResult {
  profile: "offline-representative-pipeline";
  providerCalls: 0;
  iterations: number;
  warmupIterations: number;
  photoCount: number;
  photoBytes: number;
  wallMs: { p50: number; p95: number; min: number; max: number };
  cpuMs: { p50: number; p95: number; min: number; max: number };
  rssBeforeBytes: number;
  rssAfterBytes: number;
  peakRssBytes: number;
  peakRssDeltaBytes: number;
  completedRuns: number;
  checkpoints: number;
  queueAcknowledgements: number;
  photoDownloads: number;
}

function rounded(value: number): number {
  return Number(value.toFixed(3));
}

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction: number) =>
    sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
  return {
    p50: rounded(percentile(0.5)),
    p95: rounded(percentile(0.95)),
    min: rounded(sorted[0] ?? 0),
    max: rounded(sorted.at(-1) ?? 0),
  };
}

/**
 * Measures the actual durable consumer, RPC adapters, checkpoint validation,
 * private-photo byte path, confidence assembly, persistence-payload validation,
 * completion-before-ack ordering, and bounded queue pass with deterministic
 * provider substitutes. It is an application-overhead lower bound, not a model,
 * Supabase-network, or marketplace latency measurement.
 */
export async function runOfflinePipelineBenchmark(input: {
  fixturePhotos: Uint8Array[];
  iterations?: number;
  warmupIterations?: number;
}): Promise<OfflinePipelineBenchmarkResult> {
  const iterations = input.iterations ?? 25;
  const warmupIterations = input.warmupIterations ?? 3;
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error("Benchmark iterations must be a positive integer");
  }
  if (!Number.isInteger(warmupIterations) || warmupIterations < 0) {
    throw new Error("Benchmark warmup iterations must be a non-negative integer");
  }
  if (input.fixturePhotos.length < 1 || input.fixturePhotos.length > 4) {
    throw new Error("Benchmark requires one to four representative photos");
  }

  let peakRssBytes = process.memoryUsage().rss;
  const sampleRss = () => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  };
  const rssBeforeBytes = peakRssBytes;
  const counters = {
    completedRuns: 0,
    checkpoints: 0,
    queueAcknowledgements: 0,
    photoDownloads: 0,
  };
  const photoPaths = input.fixturePhotos.map(
    (_, index) => `benchmark_user/photo-${index + 1}.jpg`,
  );
  const fixtureByPath = new Map(
    photoPaths.map((path, index) => [path, input.fixturePhotos[index]!] as const),
  );

  const queueRpc: PipelineQueueRpcClient = {
    async rpc(functionName) {
      sampleRss();
      if (functionName === "claim_pipeline_messages") {
        return {
          data: [
            {
              message_id: "41",
              read_count: 1,
              enqueued_at: "2026-07-16T20:00:00.000Z",
              visible_at: "2026-07-16T20:05:00.000Z",
              envelope: { run_id: RUN_ID, schema_version: 1 },
            },
          ],
          error: null,
        };
      }
      if (functionName === "ack_pipeline_message") {
        counters.queueAcknowledgements += 1;
        return { data: true, error: null };
      }
      if (functionName === "defer_pipeline_message") {
        return { data: true, error: null };
      }
      throw new Error(`Offline benchmark did not expect ${functionName}`);
    },
  };

  const workerRpc: PipelineWorkerRpcClient = {
    async rpc(functionName, args) {
      sampleRss();
      if (functionName === "claim_pipeline_run_attempt") {
        return {
          data: {
            kind: "acquired",
            context: {
              run: {
                id: RUN_ID,
                user_id: "benchmark_user",
                item_id: ITEM_ID,
                listing_id: null,
                status: "running",
                stage: "identifying",
                schema_version: 1,
                attempt_count: 1,
                max_attempts: 3,
                autopilot_enabled: false,
                checkpoint: {},
                lease_token: LEASE_TOKEN,
                lease_expires_at: "2026-07-16T20:05:00.000Z",
                next_attempt_at: null,
              },
              item: {
                id: ITEM_ID,
                user_id: "benchmark_user",
                photos: photoPaths,
                attributes: {},
                condition: null,
                cost_basis: null,
                review_revision: REVIEW_REVISION,
                review_content_revision: CONTENT_REVISION,
              },
            },
          },
          error: null,
        };
      }
      if (functionName === "checkpoint_pipeline_run") {
        counters.checkpoints += 1;
        const checkpoint = args.p_checkpoint as Record<string, unknown>;
        const priced = checkpoint.priced as Record<string, unknown> | undefined;
        return {
          data:
            priced && !priced.evidenceAsOf
              ? {
                  ...checkpoint,
                  priced: {
                    ...priced,
                    evidenceAsOf: "2026-07-16T20:00:01.000Z",
                  },
                }
              : checkpoint,
          error: null,
        };
      }
      if (functionName === "complete_pipeline_run") {
        counters.completedRuns += 1;
        return { data: { listingId: LISTING_ID }, error: null };
      }
      throw new Error(`Offline benchmark did not expect ${functionName}`);
    },
  };

  const photos = createPipelinePhotoCapability({
    from: () => ({
      async download(path: string) {
        counters.photoDownloads += 1;
        const bytes = fixtureByPath.get(path);
        if (!bytes) return { data: null, error: { message: "fixture missing" } };
        sampleRss();
        return {
          data: new Blob([Uint8Array.from(bytes)], { type: "image/jpeg" }),
          error: null,
        };
      },
    }),
  });
  const worker = createPipelineWorker({
    capabilities: {
      queue: createSupabasePgmqPipelineQueue(queueRpc),
      runs: createSupabasePipelineWorkerStore(workerRpc),
      photos,
    },
    createStages: ({ supabase }) =>
      createVisionPipelineStages({
        supabase,
        extract: async ({ images }) => {
          if (images.length !== input.fixturePhotos.length) {
            throw new Error("Offline benchmark lost representative photo bytes");
          }
          sampleRss();
          return EXTRACTION;
        },
        priceItem: async () => {
          sampleRss();
          return PRICE;
        },
        generateListing: async () => {
          sampleRss();
          return { copy: LISTING, model: "offline-fixture-listing" };
        },
      }),
    consumerOptions: { batchSize: 1, visibilityTimeoutSeconds: 300 },
  });

  const execute = async () => {
    const summary = await worker.consume();
    if (
      summary.claimed !== 1 ||
      summary.succeeded !== 1 ||
      summary.retrying !== 0 ||
      summary.failed !== 0 ||
      summary.skipped !== 0
    ) {
      throw new Error("Offline representative pipeline did not complete durably");
    }
    sampleRss();
  };

  for (let index = 0; index < warmupIterations; index += 1) await execute();
  const counterBaseline = { ...counters };
  const wallSamples: number[] = [];
  const cpuSamples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const wallStarted = performance.now();
    const cpuStarted = process.cpuUsage();
    await execute();
    const cpu = process.cpuUsage(cpuStarted);
    wallSamples.push(performance.now() - wallStarted);
    cpuSamples.push((cpu.user + cpu.system) / 1_000);
  }
  const rssAfterBytes = process.memoryUsage().rss;

  return {
    profile: "offline-representative-pipeline",
    providerCalls: 0,
    iterations,
    warmupIterations,
    photoCount: input.fixturePhotos.length,
    photoBytes: input.fixturePhotos.reduce((total, bytes) => total + bytes.byteLength, 0),
    wallMs: distribution(wallSamples),
    cpuMs: distribution(cpuSamples),
    rssBeforeBytes,
    rssAfterBytes,
    peakRssBytes,
    peakRssDeltaBytes: Math.max(0, peakRssBytes - rssBeforeBytes),
    completedRuns: counters.completedRuns - counterBaseline.completedRuns,
    checkpoints: counters.checkpoints - counterBaseline.checkpoints,
    queueAcknowledgements:
      counters.queueAcknowledgements - counterBaseline.queueAcknowledgements,
    photoDownloads: counters.photoDownloads - counterBaseline.photoDownloads,
  };
}
