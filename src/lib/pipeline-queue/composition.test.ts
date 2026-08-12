import { afterEach, describe, expect, it, vi } from "vitest";
import type { VisionPipelineStages } from "@/lib/vision";
import type { PipelineWorkerStore } from "./worker-store";
import { createDatabaseCheckpointClock } from "./checkpoint-clock.testing";
import { createVerifiedVoiceFixture } from "./voice-context.test-fixture";
import {
  createPipelinePhotoCapability,
  createPipelineVoiceCapability,
  createPipelineWorker,
} from "./composition";
import { PipelineWorkerFailure } from "./worker";

const { transcribe } = vi.hoisted(() => ({ transcribe: vi.fn() }));

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  experimental_transcribe: transcribe,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

function unusedStages(): VisionPipelineStages {
  const unused = async () => {
    throw new Error("stage should not run when the queue is empty");
  };
  return {
    identify: unused,
    price: unused,
    generate: unused,
    assemble: () => {
      throw new Error("assemble should not run when the queue is empty");
    },
  } as unknown as VisionPipelineStages;
}

describe("provider-neutral pipeline worker composition", () => {
  it("rejects enabled seller-audio configuration at worker construction when selected provider has no adapter", () => {
    vi.stubEnv("LLM_PROVIDER", "google");
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "secret-must-not-escape");
    vi.stubEnv("SELLER_CONTEXT_TRANSCRIPTION_ENABLED", "true");
    const claim = vi.fn();

    expect(() =>
      createPipelineWorker({
        capabilities: {
          queue: {
            enqueue: vi.fn(),
            claim,
            ack: vi.fn(),
            defer: vi.fn(),
          },
          runs: {} as PipelineWorkerStore,
          photos: {} as never,
          voice: {} as never,
          guestRecovery: { prepare: vi.fn() },
        },
        createStages: () => unusedStages(),
      }),
    ).toThrowError(
      /SELLER_CONTEXT_TRANSCRIPTION_ENABLED.*LLM_PROVIDER.*google/i,
    );
    expect(claim).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
  });

  const voiceCases = [
    {
      name: "keeps hosted seller-audio transcription off without explicit activation",
      activation: undefined,
      expectedContext: undefined,
      expectedCalls: 0,
      providerRejects: false,
      laterStageFails: false,
      usageWriteFailsOnce: false,
      terminalCheckpointFailsOnce: false,
      nonRetryableLaterStageFailure: false,
    },
    {
      name: "transcribes accepted voice after explicit activation through the production registry",
      activation: "true",
      expectedContext: {
        text: "scratch on left hinge",
        language: "en",
        provenance: "seller_voice",
        verification: "unverified",
      },
      expectedCalls: 1,
      providerRejects: false,
      laterStageFails: false,
      usageWriteFailsOnce: false,
      terminalCheckpointFailsOnce: false,
      nonRetryableLaterStageFailure: false,
    },
    {
      name: "records one activated transcription attempt when the provider rejects",
      activation: "true",
      expectedContext: undefined,
      expectedCalls: 1,
      providerRejects: true,
      laterStageFails: false,
      usageWriteFailsOnce: false,
      terminalCheckpointFailsOnce: false,
      nonRetryableLaterStageFailure: false,
    },
    {
      name: "durably records one transcription when generation fails and replay reuses voice",
      activation: "true",
      expectedContext: {
        text: "scratch on left hinge",
        language: "en",
        provenance: "seller_voice",
        verification: "unverified",
      },
      expectedCalls: 1,
      providerRejects: false,
      laterStageFails: true,
      usageWriteFailsOnce: false,
      terminalCheckpointFailsOnce: false,
      nonRetryableLaterStageFailure: false,
    },
    {
      name: "blocks the adapter when reserved transcription receipt persistence fails and replays conservatively",
      activation: "true",
      expectedContext: undefined,
      expectedCalls: 0,
      providerRejects: false,
      laterStageFails: false,
      usageWriteFailsOnce: true,
      terminalCheckpointFailsOnce: false,
      nonRetryableLaterStageFailure: false,
    },
    {
      name: "preserves one reserved transcription receipt when its terminal checkpoint and fallback write fail",
      activation: "true",
      expectedContext: undefined,
      expectedCalls: 1,
      providerRejects: false,
      laterStageFails: false,
      usageWriteFailsOnce: true,
      terminalCheckpointFailsOnce: true,
      nonRetryableLaterStageFailure: false,
    },
    {
      name: "preserves one reserved transcription receipt when a non-retryable later stage and fallback write fail",
      activation: "true",
      expectedContext: {
        text: "scratch on left hinge",
        language: "en",
        provenance: "seller_voice",
        verification: "unverified",
      },
      expectedCalls: 1,
      providerRejects: false,
      laterStageFails: true,
      usageWriteFailsOnce: true,
      terminalCheckpointFailsOnce: false,
      nonRetryableLaterStageFailure: true,
    },
  ] as const;

  for (const voiceCase of voiceCases) {
    it(voiceCase.name, async () => {
      const {
        activation,
        expectedContext,
        expectedCalls,
        providerRejects,
        laterStageFails,
        usageWriteFailsOnce,
        terminalCheckpointFailsOnce,
        nonRetryableLaterStageFailure,
      } = voiceCase;
    vi.stubEnv("LLM_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    if (activation) {
      vi.stubEnv("SELLER_CONTEXT_TRANSCRIPTION_ENABLED", activation);
    }
    const voice = createVerifiedVoiceFixture();
    const voiceBytes = voice.bytes;
    if (providerRejects) {
      transcribe.mockRejectedValue(new Error("provider rejected request"));
    } else {
      transcribe.mockResolvedValue({
        text: "scratch on left hinge",
        language: "en",
        segments: [],
        warnings: [],
        responses: [],
        providerMetadata: {},
      });
    }
    const generate = vi.fn(async () => ({
      copy: {
        platform: "ebay" as const,
        title: "Sony WH-1000XM4 Headphones",
        description: "Used headphones in good condition.",
        fields: {},
      },
      model: "listing-model",
    }));
    if (laterStageFails) {
      generate.mockRejectedValueOnce(
        nonRetryableLaterStageFailure
          ? new PipelineWorkerFailure({
              code: "listing_generation_rejected",
              safeMessage: "The listing could not be generated from this item.",
              retryable: false,
            })
          : new Error("generation unavailable"),
      );
    }
    const stages = {
      identify: vi.fn(async () => ({
        attributes: { brand: "Sony", model: "WH-1000XM4", condition: "good" },
        identification: {
          label: "Sony WH-1000XM4",
          confident: true,
          evidence: 1,
        },
        model: "vision-model",
      })),
      price: vi.fn(async () => ({
        suggested: 149,
        range: { min: 130, max: 170 },
        confidence: 0.8,
        sources: [],
        tier: "llm-only" as const,
      })),
      generate,
      assemble: vi.fn(({ identified, price, generated }) => ({
        attributes: identified.attributes,
        identification: identified.identification,
        price,
        confidence: { score: 0.8, band: "high" as const, autopilotEligible: false },
        listing: generated.copy,
        model: identified.model,
        listingModel: generated.model,
      })),
    } as unknown as VisionPipelineStages;
    const clock = createDatabaseCheckpointClock(() => "2026-08-11T12:00:00.000Z");
    let persistedCheckpoint: Record<string, unknown> = {};
    const context = {
      run: {
        id: "11111111-1111-4111-8111-111111111111",
        user_id: "user_a",
        item_id: "22222222-2222-4222-8222-222222222222",
        listing_id: null,
        status: "running" as const,
        stage: "identifying" as const,
        schema_version: 1,
        attempt_count: 1,
        max_attempts: 3,
        autopilot_enabled: false,
        checkpoint: persistedCheckpoint,
        lease_token: "33333333-3333-4333-8333-333333333333",
        lease_expires_at: "2026-08-11T12:05:00.000Z",
        next_attempt_at: null,
        recovery_id: null,
        recovery_token_hash: null,
      },
      item: {
        id: "22222222-2222-4222-8222-222222222222",
        user_id: "user_a",
        photos: ["user_a/photo.jpg"],
        photo_identity_kind: "content_sha256_set_v1" as const,
        photo_identity_fingerprint: "a".repeat(64),
        attributes: {},
        condition: null,
        cost_basis: null,
        review_revision: "44444444-4444-4444-8444-444444444444",
        review_content_revision: "55555555-5555-4555-8555-555555555555",
      },
      voice: {
        receipt: voice.receipt,
      },
    };
    const recordedTranscriptionAttempts = new Map<string, number>();
    let usageWriteCall = 0;
    const failedUsageWriteCall = usageWriteFailsOnce
      ? terminalCheckpointFailsOnce || nonRetryableLaterStageFailure
        ? 2
        : 1
      : null;
    const recordProviderUsage = vi.fn(async ({ usage }: Parameters<
      PipelineWorkerStore["recordProviderUsage"]
    >[0]) => {
      usageWriteCall += 1;
      if (usageWriteCall === failedUsageWriteCall) {
        throw new Error(
          "provider echoed transcript scratch on left hinge and raw payload",
        );
      }
      for (const entry of usage.transcriptions) {
        const key = `${entry.role}:${entry.provider}:${entry.model}`;
        if (!recordedTranscriptionAttempts.has(key)) {
          recordedTranscriptionAttempts.set(key, entry.calls);
        }
      }
    });
    let remainingTerminalCheckpointFailures = terminalCheckpointFailsOnce ? 1 : 0;
    const runs = {
      acquire: vi.fn(async () => ({
        kind: "acquired" as const,
        context,
      })),
      checkpoint: vi.fn(async ({ checkpoint }) => {
        if (checkpoint.voice && remainingTerminalCheckpointFailures > 0) {
          remainingTerminalCheckpointFailures -= 1;
          throw new Error("terminal voice checkpoint unavailable");
        }
        persistedCheckpoint = clock.stamp(checkpoint);
        context.run.checkpoint = persistedCheckpoint;
        return persistedCheckpoint;
      }),
      recordVoiceOutcome: vi.fn(async () => true),
      recordProviderUsage,
      stageGuestRecoveryUploadCleanup: vi.fn(async () => undefined),
      complete: vi.fn(async () => ({
        listingId: "66666666-6666-4666-8666-666666666666",
      })),
      failAttempt: vi.fn(async () => ({
        status: "retrying" as const,
        retryAfterSeconds: 1,
      })),
      rejectMessage: vi.fn(),
    } as unknown as PipelineWorkerStore;
    const queueEnvelope = {
      run_id: "11111111-1111-4111-8111-111111111111",
      schema_version: 1,
    };
    const queue = {
      enqueue: vi.fn(),
      claim: vi.fn(async () => [{
        id: "41",
        readCount: 1,
        enqueuedAt: "2026-08-11T12:00:00.000Z",
        visibleAt: "2026-08-11T12:00:00.000Z",
        envelope: queueEnvelope,
      }]),
      ack: vi.fn(async () => true),
      defer: vi.fn(async () => true),
    };

    const worker = createPipelineWorker({
      capabilities: {
        queue,
        runs,
        photos: {} as never,
        voice: { download: vi.fn(async () => voiceBytes) },
        guestRecovery: { prepare: vi.fn(async () => null) },
      },
      createStages: () => stages,
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    if (laterStageFails || usageWriteFailsOnce || terminalCheckpointFailsOnce) {
      await expect(worker.consume()).resolves.toMatchObject({ retrying: 1 });
      await expect(worker.consume()).resolves.toMatchObject({ succeeded: 1 });
    } else {
      await expect(worker.consume()).resolves.toMatchObject({ succeeded: 1 });
    }
    expect(generate).toHaveBeenCalledWith({
      attributes: { brand: "Sony", model: "WH-1000XM4", condition: "good" },
      ...(expectedContext ? { sellerContext: expectedContext } : {}),
    });
    expect(transcribe).toHaveBeenCalledTimes(expectedCalls);
    expect(
      [...recordedTranscriptionAttempts.values()].reduce(
        (total, calls) => total + calls,
        0,
      ),
    ).toBe(activation ? 1 : 0);
    if (usageWriteFailsOnce) {
      expect(persistedCheckpoint).toMatchObject({
        voiceAttempt: {
          transcriptionAttempt: {
            role: "sellerContext",
            provider: "openai",
            model: "gpt-4o-mini-transcribe",
            calls: 1,
            chargedUsd: null,
          },
        },
        voice: {
          outcome:
            providerRejects || expectedCalls === 0 || terminalCheckpointFailsOnce
              ? "failed"
              : "transcribed",
          transcriptionAttempt: {
            role: "sellerContext",
            provider: "openai",
            model: "gpt-4o-mini-transcribe",
            calls: 1,
            chargedUsd: null,
          },
        },
      });
      expect(JSON.stringify(persistedCheckpoint.voice)).not.toContain(
        "provider echoed transcript",
      );
      expect(queueEnvelope).toEqual({
        run_id: "11111111-1111-4111-8111-111111111111",
        schema_version: 1,
      });
      expect(consoleError.mock.calls.flat().join(" ")).not.toContain(
        "scratch on left hinge",
      );
      expect(JSON.stringify(recordProviderUsage.mock.calls)).not.toContain(
        "scratch on left hinge",
      );
      expect(JSON.stringify(recordProviderUsage.mock.calls)).not.toContain(
        "raw payload",
      );
      if (nonRetryableLaterStageFailure) {
        expect(runs.failAttempt).toHaveBeenCalledWith({
          runId: "11111111-1111-4111-8111-111111111111",
          leaseToken: "33333333-3333-4333-8333-333333333333",
          retryable: false,
          retryAfterSeconds: expect.any(Number),
          failureCode: "listing_generation_rejected",
          safeFailureMessage: "The listing could not be generated from this item.",
        });
      } else if (!terminalCheckpointFailsOnce) {
        expect(runs.failAttempt).toHaveBeenCalledWith({
          runId: "11111111-1111-4111-8111-111111111111",
          leaseToken: "33333333-3333-4333-8333-333333333333",
          retryable: true,
          retryAfterSeconds: expect.any(Number),
          failureCode: "provider_usage_temporarily_unavailable",
          safeFailureMessage:
            "SnapList could not finish this listing yet and will retry automatically.",
        });
      }
    }
    expect(runs.recordProviderUsage).toHaveBeenCalledWith({
      runId: "11111111-1111-4111-8111-111111111111",
      leaseToken: "33333333-3333-4333-8333-333333333333",
      usage: expect.objectContaining({
        modelCalls: activation ? 1 : 0,
        transcriptions: activation
          ? [{
              role: "sellerContext",
              provider: "openai",
              model: "gpt-4o-mini-transcribe",
              calls: 1,
              chargedUsd: null,
            }]
          : [],
      }),
    });
      consoleError.mockRestore();
    });
  }

  it("runs the existing bounded consumer through injected capabilities", async () => {
    const claim = vi.fn().mockResolvedValue([]);
    const worker = createPipelineWorker({
      capabilities: {
        queue: {
          enqueue: vi.fn(),
          claim,
          ack: vi.fn(),
          defer: vi.fn(),
        },
        runs: {} as PipelineWorkerStore,
        photos: {} as never,
        voice: {} as never,
        guestRecovery: { prepare: vi.fn() },
      },
      createStages: () => unusedStages(),
      consumerOptions: { batchSize: 2, visibilityTimeoutSeconds: 120 },
    });

    await expect(worker.consume()).resolves.toEqual({
      claimed: 0,
      succeeded: 0,
      retrying: 0,
      failed: 0,
      skipped: 0,
    });
    expect(claim).toHaveBeenCalledWith({
      limit: 2,
      visibilityTimeoutSeconds: 120,
    });
  });

  it("keeps runtime storage authority restricted to the private photos bucket", async () => {
    const download = vi.fn().mockResolvedValue({ data: new Blob(), error: null });
    const from = vi.fn(() => ({ download }));
    const photos = createPipelinePhotoCapability({ from });

    expect(() => photos.storage.from("message-photos")).toThrow(
      /private photos bucket/,
    );
    await expect(photos.storage.from("photos").download("user/item.jpg")).resolves.toEqual({
      data: expect.any(Blob),
      error: null,
    });
    expect(from).toHaveBeenCalledOnce();
    expect(from).toHaveBeenCalledWith("photos");
  });

  it("exposes voice storage as one private path download capability", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const download = vi.fn().mockResolvedValue({
      data: new Blob([bytes], { type: "audio/wav" }),
      error: null,
    });
    const from = vi.fn(() => ({ download }));
    const voice = createPipelineVoiceCapability({ from });

    await expect(voice.download({ path: "user_a/intake/voice.wav" })).resolves.toEqual(
      bytes,
    );
    expect(from).toHaveBeenCalledOnce();
    expect(from).toHaveBeenCalledWith("photos");
    expect(download).toHaveBeenCalledWith("user_a/intake/voice.wav");
  });
});
