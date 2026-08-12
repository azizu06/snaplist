import { describe, expect, it, vi } from "vitest";
import type {
  CanonicalLanguageTag,
  SellerContextTranscriber,
} from "@/lib/llm/seller-context";
import type { PriceResult } from "@/lib/pricing";
import type { VisionPipelineStages } from "@/lib/vision";
import {
  createDurableVisionPipelineProcessor,
  type DurableVisionPipelineProcessorOptions,
  type PipelineWorkerCheckpoint,
  type PipelineVoiceStorage,
} from "./durable-processor";
import type { PipelineWorkerCheckpointWrite } from "./checkpoint";
import type { SellerVoiceTranscriptionAttempt } from "./checkpoint";
import { createDatabaseCheckpointClock } from "./checkpoint-clock.testing";
import type { PipelineWorkerContext } from "./worker-store";
import { createVerifiedVoiceFixture } from "./voice-context.test-fixture";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";
const IDENTIFIED = {
  attributes: { brand: "Sony", model: "WH-1000XM4", condition: "good" },
  identification: { label: "Sony WH-1000XM4", confident: true, evidence: 1 },
  model: "vision-model",
};
const PRICE: PriceResult = {
  suggested: 149,
  range: { min: 130, max: 170 },
  confidence: 0.8,
  sources: [],
  tier: "llm-only",
};
const GENERATED = {
  copy: {
    platform: "ebay",
    title: "Sony WH-1000XM4 Headphones",
    description: "Used headphones in good condition.",
    fields: {},
  },
  model: "listing-model",
};
const EVIDENCE_AS_OF = "2026-07-20T08:00:00.000Z";
const AHEAD_WORKER_CLOCK = "2099-07-20T08:00:00.000Z";
const PRICED = { result: PRICE, evidenceAsOf: EVIDENCE_AS_OF };

function workerContext(checkpoint: PipelineWorkerCheckpoint): PipelineWorkerContext {
  return {
    run: {
      id: RUN_ID,
      user_id: "user_a",
      item_id: ITEM_ID,
      listing_id: null,
      status: "running",
      stage: "pricing",
      schema_version: 1,
      attempt_count: 2,
      max_attempts: 3,
      autopilot_enabled: false,
      checkpoint,
      lease_token: "33333333-3333-4333-8333-333333333333",
      lease_expires_at: "2026-07-15T04:10:00.000Z",
      next_attempt_at: null,
      recovery_id: null,
      recovery_token_hash: null,
    },
    item: {
      id: ITEM_ID,
      user_id: "user_a",
      photos: ["user_a/photo.jpg"],
      photo_identity_kind: "content_sha256_set_v1",
      photo_identity_fingerprint: "a".repeat(64),
      attributes: {},
      condition: null,
      cost_basis: null,
      review_revision: "44444444-4444-4444-8444-444444444444",
      review_content_revision: "55555555-5555-4555-8555-555555555555",
    },
  };
}

type TestStages = VisionPipelineStages & Record<string, ReturnType<typeof vi.fn>>;
type VoiceReceipt = NonNullable<PipelineWorkerContext["voice"]>["receipt"];

function stages(): TestStages {
  return {
    identify: vi.fn(async () => IDENTIFIED),
    price: vi.fn(async () => PRICE),
    generate: vi.fn(async () => GENERATED),
    assemble: vi.fn(({ identified, price, generated, autopilotEnabled }) => ({
      attributes: identified.attributes,
      identification: identified.identification,
      price,
      confidence: {
        score: 0.8,
        band: "high" as const,
        autopilotEligible: autopilotEnabled,
      },
      listing: generated.copy,
      model: identified.model,
      listingModel: generated.model,
    })),
  } as unknown as TestStages;
}

const databaseClock = createDatabaseCheckpointClock(() => EVIDENCE_AS_OF);

async function persistTestCheckpoint(
  _stage: string,
  checkpoint: PipelineWorkerCheckpointWrite,
): Promise<PipelineWorkerCheckpoint> {
  return databaseClock.stamp(checkpoint);
}

function verifiedVoiceHarness(options: {
  checkpoint?: PipelineWorkerCheckpoint;
  pipeline?: TestStages;
  receipt?: Partial<VoiceReceipt>;
  transcribe?: SellerContextTranscriber["transcribe"];
  transcriptionAttempt?: SellerVoiceTranscriptionAttempt;
  download?: PipelineVoiceStorage["download"];
  recordTerminalOutcome?: DurableVisionPipelineProcessorOptions["recordTerminalOutcome"];
} = {}) {
  const fixture = createVerifiedVoiceFixture({ receipt: options.receipt });
  const pipeline = options.pipeline ?? stages();
  const download = vi.fn(
    options.download ?? (async () => fixture.bytes),
  );
  const transcribe = vi.fn(
    options.transcribe ??
      (async () => ({
        kind: "transcribed" as const,
        text: "scratch on left hinge",
        language: "en-US" as CanonicalLanguageTag,
        providerContacted: true,
      })),
  );
  const recordTerminalOutcome = vi.fn(
    options.recordTerminalOutcome ?? (async () => true),
  );
  const context = workerContext(options.checkpoint ?? {});
  context.voice = { receipt: fixture.receipt };
  const processor = createDurableVisionPipelineProcessor(pipeline, {
    voiceStorage: { download },
    transcriber: {
      transcribe,
      ...(options.transcriptionAttempt
        ? { transcriptionAttempt: options.transcriptionAttempt }
        : {}),
    } as SellerContextTranscriber,
    recordTerminalOutcome,
  });
  return {
    ...fixture,
    context,
    download,
    pipeline,
    processor,
    recordTerminalOutcome,
    transcribe,
  };
}

describe("durable vision pipeline processor", () => {
  it("passes one accepted seller voice note to listing generation without replacing verified identity or price", async () => {
    const pipeline = stages();
    vi.mocked(pipeline.generate).mockImplementation(async ({ sellerContext }) => ({
      ...GENERATED,
      copy: {
        ...GENERATED.copy,
        description: `${GENERATED.copy.description} Seller note: ${sellerContext!.text}`,
      },
    }));
    const voice = verifiedVoiceHarness({
      pipeline,
      recordTerminalOutcome: async () => false,
    });

    const result = await voice.processor.process({
      context: voice.context,
      onCheckpoint: persistTestCheckpoint,
    });

    expect(pipeline.generate).toHaveBeenCalledWith({
      attributes: IDENTIFIED.attributes,
      sellerContext: {
        text: "scratch on left hinge",
        language: "en-US",
        provenance: "seller_voice",
        verification: "unverified",
      },
    });
    expect(result.identification?.label).toBe("Sony WH-1000XM4");
    expect(result.price.suggested).toBe(149);
    expect(result.listing.description).toContain("scratch on left hinge");
    expect(voice.recordTerminalOutcome).toHaveBeenCalledWith({
      runId: RUN_ID,
      leaseToken: "33333333-3333-4333-8333-333333333333",
      outcome: "transcribed",
      providerContacted: true,
    });
  });

  it("persists the accepted voice attempt before transcription and reuses its terminal result on retry", async () => {
    let persisted: PipelineWorkerCheckpoint = {
      identified: IDENTIFIED,
      priced: PRICED,
    };
    const saved: PipelineWorkerCheckpointWrite[] = [];
    const voice = verifiedVoiceHarness({ checkpoint: persisted });
    voice.transcribe.mockImplementation(async () => {
      expect(saved.at(-1)).toMatchObject({
        voiceAttempt: {
          version: 1,
          contentSha256: voice.receipt.contentSha256,
        },
      });
      return {
        kind: "transcribed" as const,
        text: "scratch on left hinge",
        language: "en-US" as CanonicalLanguageTag,
        providerContacted: true,
      };
    });
    const onCheckpoint = async (
      _stage: string,
      checkpoint: PipelineWorkerCheckpointWrite,
    ) => {
      saved.push(checkpoint);
      persisted = databaseClock.stamp(checkpoint);
      return persisted;
    };

    await voice.processor.process({ context: voice.context, onCheckpoint });
    voice.context.run.checkpoint = persisted;
    await voice.processor.process({ context: voice.context, onCheckpoint });

    expect(voice.transcribe).toHaveBeenCalledOnce();
    expect(persisted).toMatchObject({
      voiceAttempt: {
        version: 1,
        contentSha256: voice.receipt.contentSha256,
      },
      voice: {
        version: 1,
        contentSha256: voice.receipt.contentSha256,
        outcome: "transcribed",
        sellerContext: {
          text: "scratch on left hinge",
          language: "en-US",
          provenance: "seller_voice",
          verification: "unverified",
        },
      },
    });
  });

  it("checkpoints the content-free transcription reservation before the configured adapter can run", async () => {
    const transcriptionAttempt: SellerVoiceTranscriptionAttempt = {
      role: "sellerContext",
      provider: "openai",
      model: "gpt-4o-mini-transcribe",
      calls: 1,
      chargedUsd: null,
    };
    const saved: PipelineWorkerCheckpointWrite[] = [];
    let checkpointAtAdapterEntry: PipelineWorkerCheckpointWrite | undefined;
    const voice = verifiedVoiceHarness({ transcriptionAttempt });
    voice.transcribe.mockImplementation(async () => {
      checkpointAtAdapterEntry = saved.at(-1);
      return { kind: "failed" as const, providerContacted: true };
    });

    await voice.processor.process({
      context: voice.context,
      onCheckpoint: async (_stage, checkpoint) => {
        saved.push(checkpoint);
        return databaseClock.stamp(checkpoint);
      },
    });

    expect(voice.transcribe).toHaveBeenCalledOnce();
    expect(checkpointAtAdapterEntry).toMatchObject({
      voiceAttempt: {
        version: 1,
        contentSha256: voice.receipt.contentSha256,
        transcriptionAttempt,
      },
    });
    expect(JSON.stringify(saved)).not.toContain("scratch on left hinge");
    expect(JSON.stringify(saved)).not.toContain("audio/wav");
  });

  it("regenerates one legacy listing for the exact terminal voice binding and reuses it on replay", async () => {
    let persisted: PipelineWorkerCheckpoint = {
      identified: IDENTIFIED,
      priced: PRICED,
      generated: GENERATED,
    };
    const pipeline = stages();
    const generate = vi.mocked(pipeline.generate);
    generate.mockImplementation(async ({ sellerContext }) => ({
      ...GENERATED,
      copy: {
        ...GENERATED.copy,
        description: `${GENERATED.copy.description} Seller note: ${sellerContext!.text}`,
      },
    }));
    const voice = verifiedVoiceHarness({ checkpoint: persisted, pipeline });
    voice.context.run.stage = "generating";
    const onCheckpoint = async (
      _stage: string,
      checkpoint: PipelineWorkerCheckpointWrite,
    ) => {
      persisted = databaseClock.stamp(checkpoint);
      return persisted;
    };

    const first = await voice.processor.process({
      context: voice.context,
      onCheckpoint,
    });
    voice.context.run.checkpoint = persisted;
    const replay = await voice.processor.process({
      context: voice.context,
      onCheckpoint,
    });

    expect(voice.transcribe).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledOnce();
    expect(first.listing.description).toContain("scratch on left hinge");
    expect(replay.listing.description).toContain("scratch on left hinge");
    expect(persisted).toMatchObject({
      generated: GENERATED,
      voiceGenerations: [
        {
          voice: {
            version: 1,
            contentSha256: voice.receipt.contentSha256,
            outcome: "transcribed",
          },
          generated: {
            copy: {
              description: expect.stringContaining("scratch on left hinge"),
            },
            model: "listing-model",
          },
        },
      ],
    });
  });

  it.each([
    ["pricing", { identified: IDENTIFIED, priced: PRICED }],
    [
      "generating",
      { identified: IDENTIFIED, priced: PRICED, generated: GENERATED },
    ],
  ] as const)(
    "keeps accepted-voice checkpoints monotonic when a claimed run resumes at %s",
    async (runStage, initialCheckpoint) => {
      const voice = verifiedVoiceHarness({ checkpoint: initialCheckpoint });
      voice.context.run.stage = runStage;
      const stageRank = {
        identifying: 1,
        pricing: 2,
        generating: 3,
        persisting: 4,
      } as const;
      const savedStages: Array<keyof typeof stageRank> = [];
      await expect(
        voice.processor.process({
          context: voice.context,
          onCheckpoint: async (stage, checkpoint) => {
            expect(stageRank[stage]).toBeGreaterThanOrEqual(stageRank[runStage]);
            savedStages.push(stage);
            return databaseClock.stamp(checkpoint);
          },
        }),
      ).resolves.toMatchObject({ price: { suggested: 149 } });
      expect(savedStages.length).toBeGreaterThan(0);
    },
  );

  it("fails open to photos when accepted voice bytes fail receipt verification", async () => {
    const voice = verifiedVoiceHarness({
      receipt: { contentSha256: "b".repeat(64) },
    });

    await expect(
      voice.processor.process({
        context: voice.context,
        onCheckpoint: persistTestCheckpoint,
      }),
    ).resolves.toMatchObject({
      identification: { label: "Sony WH-1000XM4" },
      price: { suggested: 149 },
    });
    expect(voice.transcribe).not.toHaveBeenCalled();
    expect(voice.pipeline.generate).toHaveBeenCalledWith({
      attributes: IDENTIFIED.attributes,
    });
    expect(voice.recordTerminalOutcome).toHaveBeenCalledWith({
      runId: RUN_ID,
      leaseToken: "33333333-3333-4333-8333-333333333333",
      outcome: "failed",
      providerContacted: false,
    });
  });

  it("fails open without reading a voice path outside the claimed tenant", async () => {
    const voice = verifiedVoiceHarness({
      receipt: { storagePath: "user_b/forged.wav", locale: null },
      download: async () => {
        throw new Error("forged path must not be read");
      },
    });

    await expect(
      voice.processor.process({
        context: voice.context,
        onCheckpoint: persistTestCheckpoint,
      }),
    ).resolves.toMatchObject({ price: { suggested: 149 } });
    expect(voice.download).not.toHaveBeenCalled();
    expect(voice.transcribe).not.toHaveBeenCalled();
    expect(voice.recordTerminalOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failed" }),
    );
  });

  it.each([
    {
      name: "local receipt rejection",
      receipt: { storagePath: "user_b/forged.wav", locale: null },
      transcribe: async () => ({ kind: "failed" as const, providerContacted: true }),
      outcome: "failed" as const,
      providerContacted: false,
    },
    {
      name: "provider-contacted timeout",
      receipt: { locale: null },
      transcribe: async () => ({ kind: "timed-out" as const, providerContacted: true }),
      outcome: "timed-out" as const,
      providerContacted: true,
    },
  ])(
    "records explicit provider contact provenance for $name",
    async ({ receipt, transcribe, outcome, providerContacted }) => {
      const voice = verifiedVoiceHarness({ receipt, transcribe });

      await voice.processor.process({
        context: voice.context,
        onCheckpoint: persistTestCheckpoint,
      });

      expect(voice.recordTerminalOutcome).toHaveBeenCalledWith({
        runId: RUN_ID,
        leaseToken: "33333333-3333-4333-8333-333333333333",
        outcome,
        providerContacted,
      });
    },
  );

  it.each(["empty", "unsupported", "timed-out", "failed"] as const)(
    "continues photos-only after a terminal %s transcription outcome",
    async (outcome) => {
      const voice = verifiedVoiceHarness({
        receipt: { locale: null },
        transcribe: async () => ({ kind: outcome, providerContacted: true }),
      });

      await expect(
        voice.processor.process({
          context: voice.context,
          onCheckpoint: persistTestCheckpoint,
        }),
      ).resolves.toMatchObject({ price: { suggested: 149 } });
      expect(voice.pipeline.generate).toHaveBeenCalledWith({
        attributes: IDENTIFIED.attributes,
      });
      expect(voice.recordTerminalOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ outcome }),
      );
    },
  );

  it("does not repeat transcription after an attempt marker survives an ambiguous response", async () => {
    const voice = verifiedVoiceHarness({ receipt: { locale: null } });
    voice.context.run.checkpoint = {
      identified: IDENTIFIED,
      voiceAttempt: {
        version: 1,
        contentSha256: voice.receipt.contentSha256,
      },
    };

    await expect(
      voice.processor.process({
        context: voice.context,
        onCheckpoint: persistTestCheckpoint,
      }),
    ).resolves.toMatchObject({ price: { suggested: 149 } });
    expect(voice.download).not.toHaveBeenCalled();
    expect(voice.transcribe).not.toHaveBeenCalled();
    expect(voice.recordTerminalOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failed" }),
    );
  });

  it("resumes after persisted identify and price stages without repeating provider work", async () => {
    const pipeline = stages();
    const saved: Array<[string, PipelineWorkerCheckpointWrite]> = [];
    const processor = createDurableVisionPipelineProcessor(pipeline);

    const result = await processor.process({
      context: workerContext({ identified: IDENTIFIED, priced: PRICED }),
      onCheckpoint: async (stage, checkpoint) => {
        saved.push([stage, checkpoint]);
        return persistTestCheckpoint(stage, checkpoint);
      },
    });

    expect(pipeline.identify).not.toHaveBeenCalled();
    expect(pipeline.price).not.toHaveBeenCalled();
    expect(pipeline.generate).toHaveBeenCalledOnce();
    expect(saved).toEqual([
      ["generating", { identified: IDENTIFIED, priced: PRICED, generated: GENERATED }],
    ]);
    expect(result.listing.title).toMatch(/Sony/);
  });

  it("continues from the database-authoritative priced checkpoint when the worker clock is ahead", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(AHEAD_WORKER_CLOCK);
    try {
      const pipeline = stages();
      const saved: Array<[string, PipelineWorkerCheckpointWrite]> = [];
      const processor = createDurableVisionPipelineProcessor(pipeline);

      await processor.process({
        context: workerContext({ identified: IDENTIFIED }),
        onCheckpoint: async (stage, checkpoint) => {
          saved.push([stage, checkpoint]);
          return persistTestCheckpoint(stage, checkpoint);
        },
      });

      expect(saved[0]).toEqual([
        "pricing",
        { identified: IDENTIFIED, priced: { result: PRICE } },
      ]);
      expect(saved[1]?.[1].priced?.evidenceAsOf).toBe(EVIDENCE_AS_OF);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses only run-derived photo paths and the stored configuration snapshot", async () => {
    const pipeline = stages();
    const processor = createDurableVisionPipelineProcessor(pipeline);
    const ctx = workerContext({});
    ctx.run.autopilot_enabled = true;

    const result = await processor.process({
      context: ctx,
      onCheckpoint: persistTestCheckpoint,
    });

    expect(pipeline.identify).toHaveBeenCalledWith({ photos: ["user_a/photo.jpg"] });
    expect(pipeline.assemble).toHaveBeenCalledWith(
      expect.objectContaining({ autopilotEnabled: true }),
    );
    expect(result.confidence.autopilotEligible).toBe(true);
  });

  it("passes five run-derived tenant photo paths to identification in presentation order", async () => {
    const pipeline = stages();
    const processor = createDurableVisionPipelineProcessor(pipeline);
    const ctx = workerContext({});
    ctx.item.photos = Array.from(
      { length: 5 },
      (_, ordinal) => `user_a/pipeline-staging/batch/0/${ordinal}-photo.jpg`,
    );

    await processor.process({ context: ctx, onCheckpoint: persistTestCheckpoint });

    expect(pipeline.identify).toHaveBeenCalledWith({ photos: ctx.item.photos });
  });

  it("rejects more than five run-derived photo paths", async () => {
    const pipeline = stages();
    const processor = createDurableVisionPipelineProcessor(pipeline);
    const ctx = workerContext({});
    ctx.item.photos = Array.from(
      { length: 6 },
      (_, ordinal) => `user_a/pipeline-staging/batch/0/${ordinal}-photo.jpg`,
    );

    await expect(
      processor.process({ context: ctx, onCheckpoint: persistTestCheckpoint }),
    ).rejects.toMatchObject({ code: "invalid_run_photos", retryable: false });
    expect(pipeline.identify).not.toHaveBeenCalled();
  });

  it("rejects a stored photo path that is not owned by the run tenant", async () => {
    const pipeline = stages();
    const processor = createDurableVisionPipelineProcessor(pipeline);
    const ctx = workerContext({});
    ctx.item.photos = ["user_b/forged.jpg"];

    await expect(
      processor.process({ context: ctx, onCheckpoint: persistTestCheckpoint }),
    ).rejects.toMatchObject({ code: "invalid_run_photos", retryable: false });
    expect(pipeline.identify).not.toHaveBeenCalled();
  });

  it("rejects traversal-like stored paths even when their first bytes match the tenant", async () => {
    const pipeline = stages();
    const processor = createDurableVisionPipelineProcessor(pipeline);
    const ctx = workerContext({});
    ctx.item.photos = ["user_a/../user_b/forged.jpg"];

    await expect(
      processor.process({ context: ctx, onCheckpoint: persistTestCheckpoint }),
    ).rejects.toMatchObject({ code: "invalid_run_photos", retryable: false });
    expect(pipeline.identify).not.toHaveBeenCalled();
  });
});
